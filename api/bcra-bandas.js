// Proxy + parser server-side del XLSX de bandas cambiarias del BCRA.
//
// La página oficial https://www.bcra.gob.ar/regimen-de-bandas-cambiarias/ publica
// un Excel con los valores de banda inferior y banda superior calculados para CADA
// día calendario, incluyendo el mes siguiente (porque las bandas se proyectan al
// salir el IPC T-2 cada 14 del mes).
//
// Esta función lo descarga una vez, lo parsea, y devuelve JSON con la serie diaria.
// Cacheada 24h en edge (las bandas se actualizan una vez por mes).

import * as XLSX from 'xlsx';

const XLSX_URL = 'https://www.bcra.gob.ar/archivos/Pdfs/PublicacionesEstadisticas/serie-completa-bandas-cambiarias.xlsx';

// Heurística: el Excel tiene 3 columnas — fecha, banda inferior, banda superior.
// Los nombres exactos pueden cambiar; detectamos por patrón.
function findColumns(headers) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  let fechaIdx = -1, infIdx = -1, supIdx = -1;
  headers.forEach((h, i) => {
    const n = norm(h);
    if (fechaIdx === -1 && /fecha|dia|periodo/.test(n)) fechaIdx = i;
    if (infIdx === -1 && /inferior|piso|min/.test(n)) infIdx = i;
    if (supIdx === -1 && /superior|techo|max/.test(n)) supIdx = i;
  });
  return { fechaIdx, infIdx, supIdx };
}

function excelDateToISO(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    // Formatos tipo "01/06/2026" o "2026-06-01"
    const m1 = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m1) {
      const y = m1[3].length === 2 ? '20' + m1[3] : m1[3];
      return `${y}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    return null;
  }
  if (typeof v === 'number') {
    // Excel serial date: días desde 1900-01-01 (con bug de Lotus)
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const upstream = await fetch(XLSX_URL, {
      headers: { 'User-Agent': 'simpleza-coyuntura/1.0' }
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `BCRA XLSX ${upstream.status}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    // Buscamos la primera fila que tenga headers reconocibles
    let headerRowIdx = -1, cols = null;
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const c = findColumns(rows[i]);
      if (c.fechaIdx !== -1 && c.infIdx !== -1 && c.supIdx !== -1) {
        headerRowIdx = i; cols = c; break;
      }
    }
    if (headerRowIdx === -1) {
      return res.status(500).json({ error: 'No pude identificar columnas en el XLSX', preview: rows.slice(0, 10) });
    }

    const data = [];
    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const fecha = excelDateToISO(r[cols.fechaIdx]);
      const inferior = Number(r[cols.infIdx]);
      const superior = Number(r[cols.supIdx]);
      if (!fecha || isNaN(inferior) || isNaN(superior)) continue;
      data.push({ fecha, inferior, superior });
    }
    data.sort((a, b) => a.fecha.localeCompare(b.fecha));

    // Cache 24h en edge — las bandas se publican una vez al mes
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ count: data.length, data });
  } catch (e) {
    res.status(502).json({ error: 'Error procesando XLSX BCRA', detail: e.message });
  }
}
