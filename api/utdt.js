// Scraper + parser del ICG e ICC de la UTDT.
//
// La UTDT publica los índices en XLS subidos a /download.php?fname=_<timestamp>.xls.
// El nombre del archivo cambia cada publicación (es un timestamp en ms), pero la página
// que lista los links es estable. Esta función:
//   1. Pide la página índice de UTDT correspondiente al indicador
//   2. Extrae los links `download.php?fname=_<N>.xls`
//   3. Elige el de timestamp más alto (= la publicación más reciente)
//   4. Descarga ese XLS y lo parsea con SheetJS
//   5. Devuelve todas las hojas como JSON, para que el frontend pueda escoger
//      qué consumir (serie general, por zona, sub-índices, etc.)
//
// Uso:
//   /api/utdt?indicator=icg
//   /api/utdt?indicator=icc
//
// Cache 12h en edge (UTDT publica mensualmente).

import * as XLSX from 'xlsx';

const SOURCES = {
  icg: {
    page: 'https://www.utdt.edu/ver_contenido.php?id_contenido=1439&id_item_menu=2964',
    name: 'Índice de Confianza en el Gobierno',
    publisher: 'UTDT · Escuela de Gobierno'
  },
  icc: {
    page: 'https://www.utdt.edu/listado_contenidos.php?id_item_menu=16458',
    name: 'Índice de Confianza del Consumidor',
    publisher: 'UTDT · CIF'
  }
};

const UA = 'Mozilla/5.0 (compatible; simpleza-coyuntura/1.0; +https://simpleza.com.ar)';

// Acepta una variedad de formatos de fecha que aparecen en XLS de UTDT:
// - serial number de Excel (días desde 1900)
// - "01/05/2026" o "5/1/26"
// - "may-26", "mayo 2026"
// - Date object
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  // 01/05/2026 o 1/5/26
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // "may-26" / "mayo 2026"
  const MESES = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,set:9,oct:10,nov:11,dic:12,
                  enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12 };
  m = s.toLowerCase().match(/^([a-zñ]+)[\s\-\.\/]+(\d{2,4})$/);
  if (m && MESES[m[1]]) {
    const y = m[2].length === 2 ? '20' + m[2] : m[2];
    return `${y}-${String(MESES[m[1]]).padStart(2,'0')}-01`;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const u = new URL(req.url, `http://${req.headers.host}`);
  const indicator = (u.searchParams.get('indicator') || '').toLowerCase();
  const src = SOURCES[indicator];
  if (!src) {
    return res.status(400).json({ error: 'indicator inválido', validos: Object.keys(SOURCES) });
  }
  const debug = u.searchParams.get('debug') === '1';

  try {
    // 1. Bajar la página índice
    const pageRes = await fetch(src.page, { headers: { 'User-Agent': UA } });
    if (!pageRes.ok) {
      return res.status(502).json({ error: `UTDT página ${pageRes.status}`, page: src.page });
    }
    const html = await pageRes.text();

    // 2. Extraer todos los links de XLS. El patrón es `download.php?fname=_<digits>.xls`.
    //    Aceptamos también .xlsx por si en algún momento migran de formato.
    const re = /download\.php\?fname=(_(\d+)\.xls[x]?)/gi;
    const matches = [...html.matchAll(re)];
    if (matches.length === 0) {
      return res.status(500).json({
        error: 'No encontré links XLS en la página de UTDT',
        page: src.page,
        hint: 'UTDT puede haber cambiado el formato de la página'
      });
    }

    // 3. El nombre del archivo lleva un timestamp embebido. El más alto es el más nuevo.
    const links = matches.map(m => ({
      filename: m[1],
      ts: BigInt(m[2] || '0')
    }));
    links.sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0));
    const latest = links[0];
    const xlsUrl = `https://www.utdt.edu/download.php?fname=${latest.filename}`;

    // 4. Bajar el XLS
    const xlsRes = await fetch(xlsUrl, {
      headers: { 'User-Agent': UA, 'Referer': src.page }
    });
    if (!xlsRes.ok) {
      return res.status(502).json({ error: `UTDT XLS ${xlsRes.status}`, url: xlsUrl });
    }
    const buf = Buffer.from(await xlsRes.arrayBuffer());

    // 5. Parsear todas las hojas. Devolvemos todo crudo (rows) para que el frontend
    //    pueda elegir qué columnas tomar — la estructura de cada XLS de UTDT varía.
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
    const sheets = wb.SheetNames.map(name => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
      // Intento auxiliar: detectar fila de headers y armar una serie "general" si encuentro
      // una columna de fecha + una columna numérica que parezca el índice (valores entre 0 y 5).
      let series = null;
      for (let h = 0; h < Math.min(rows.length, 20); h++) {
        const row = rows[h] || [];
        const datelike = row.findIndex(c => parseDate(c) != null);
        if (datelike >= 0) {
          // h es probablemente la primera fila de datos. Buscar header en h-1.
          // Tomamos como "valor" la primera columna numérica a la derecha de la fecha.
          const valueCol = row.slice(datelike + 1).findIndex(c => typeof c === 'number' && c > 0 && c < 5);
          if (valueCol >= 0) {
            const valColAbs = datelike + 1 + valueCol;
            series = [];
            for (let i = h; i < rows.length; i++) {
              const r = rows[i] || [];
              const fecha = parseDate(r[datelike]);
              const valor = +r[valColAbs];
              if (fecha && !isNaN(valor) && valor > 0 && valor < 6) {
                series.push({ fecha, valor });
              }
            }
            series.sort((a, b) => a.fecha.localeCompare(b.fecha));
            break;
          }
        }
      }
      return debug
        ? { name, headPreview: rows.slice(0, 8), totalRows: rows.length, series }
        : { name, rows, series };
    });

    // Headers de cache: UTDT publica una vez por mes, 12h de cache es seguro.
    res.setHeader('Cache-Control', 'public, max-age=43200, s-maxage=43200');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({
      indicator,
      name: src.name,
      publisher: src.publisher,
      sourceUrl: xlsUrl,
      sourcePage: src.page,
      sheets
    });
  } catch (e) {
    res.status(502).json({ error: 'Error procesando XLS UTDT', detail: e.message, stack: debug ? e.stack : undefined });
  }
}
