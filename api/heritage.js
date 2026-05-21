// Scraper del Índice de Libertad Económica de la Heritage Foundation.
//
// El índice es ANUAL (publicación en marzo). Por eso cacheamos 30 días en edge —
// no tiene sentido refrescar más seguido.
//
// Estrategia: pegamos a la página de scores de todos los países y aplicamos
// múltiples heurísticas para extraer:
//   - score de Argentina
//   - ranking (puesto global)
//   - clasificación textual (Mostly Free / Mostly Unfree / etc.)
//   - scores de comparadores regionales (Chile, Uruguay, Brasil, Singapur)
//
// Si la página falla o cambia de estructura, devolvemos el HTML preview para
// debugging y dejamos que el frontend caiga al FALLBACK hardcoded.
//
// Uso:
//   /api/heritage                  → JSON normalizado
//   /api/heritage?debug=1          → incluye preview del HTML para inspección
//
// Fuente oficial:
//   https://economicfreedom.heritage.org/pages/all-country-scores
//   https://economicfreedom.heritage.org/pages/country-pages/argentina

const SCORES_URL = 'https://economicfreedom.heritage.org/pages/all-country-scores';
const ARG_URL    = 'https://economicfreedom.heritage.org/pages/country-pages/argentina';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const COMPARADORES = ['Singapore', 'Chile', 'Uruguay', 'Argentina', 'Brazil'];
const NOMBRES_ES = {
  'Singapore': 'Singapur', 'Chile': 'Chile', 'Uruguay': 'Uruguay',
  'Argentina': 'Argentina', 'Brazil': 'Brasil'
};

function classify(score) {
  if (score == null || isNaN(score)) return null;
  if (score >= 80) return 'Libre';
  if (score >= 70) return 'Mayormente libre';
  if (score >= 60) return 'Moderadamente libre';
  if (score >= 50) return 'Mayormente no libre';
  return 'Reprimido';
}

// Estrategia 1: __NEXT_DATA__ embebido. Las apps Next.js incluyen un script con todo el
// estado inicial; si Heritage es Next, los scores están ahí en JSON.
function tryNextData(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    // Walk recursivo buscando un array de países
    const found = walkForCountries(data);
    return found;
  } catch { return null; }
}
function walkForCountries(obj, depth = 0) {
  if (depth > 8 || !obj) return null;
  if (Array.isArray(obj) && obj.length > 50) {
    // Probable lista de países si hay items con name + score
    const sample = obj[0];
    if (sample && typeof sample === 'object' &&
        (sample.name || sample.country) &&
        (typeof sample.score === 'number' || typeof sample.value === 'number' || typeof sample.overall === 'number')) {
      return obj;
    }
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = walkForCountries(obj[k], depth + 1);
      if (r) return r;
    }
  }
  return null;
}

// Estrategia 2: tabla HTML. Buscamos filas <tr> que contengan nombres de países y números.
function tryTableScrape(html) {
  const rows = [];
  // Captura cualquier <tr> que tenga el nombre de alguno de los comparadores
  for (const country of COMPARADORES) {
    const re = new RegExp(`<tr[^>]*>(?:[\\s\\S](?!</tr>))*?\\b${country}\\b[\\s\\S]*?<\\/tr>`, 'i');
    const m = html.match(re);
    if (!m) continue;
    // Extraer todos los números con decimales (los scores son típicamente como 57.4)
    const nums = [...m[0].matchAll(/>\s*(-?\d{1,3}(?:[\.,]\d{1,2})?)\s*</g)].map(x => parseFloat(x[1].replace(',', '.')));
    // El score Overall suele ser un número entre 0 y 100
    const score = nums.find(n => n > 0 && n <= 100);
    // El ranking suele ser un entero pequeño (1-200)
    const ranking = nums.find(n => Number.isInteger(n) && n > 0 && n < 250);
    if (score != null) rows.push({ name: country, score, ranking });
  }
  return rows.length ? rows : null;
}

// Estrategia 3: regex sobre texto visible. Last resort: busca patrones tipo
// "Argentina ... 57.4 ... ranked 106" en el texto plano.
function tryTextScrape(html) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const rows = [];
  for (const country of COMPARADORES) {
    const re = new RegExp(`\\b${country}\\b[^.]{0,200}?(\\d{1,3}(?:[\\.,]\\d{1,2}))`);
    const m = text.match(re);
    if (m) rows.push({ name: country, score: parseFloat(m[1].replace(',', '.')) });
  }
  return rows.length ? rows : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const u = new URL(req.url, `http://${req.headers.host}`);
  const debug = u.searchParams.get('debug') === '1';

  try {
    const r = await fetch(SCORES_URL, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (!r.ok) {
      return res.status(502).json({ error: `Heritage scores ${r.status}`, url: SCORES_URL });
    }
    const html = await r.text();

    let raw =
      tryNextData(html) ||
      tryTableScrape(html) ||
      tryTextScrape(html);

    if (!raw || raw.length === 0) {
      return res.status(200).json({
        ok: false,
        error: 'No pude extraer datos de la página de Heritage',
        hint: 'La estructura del HTML puede haber cambiado. Probá ?debug=1.',
        htmlPreview: debug ? html.slice(0, 2000) : undefined,
        sourceUrl: SCORES_URL
      });
    }

    // Normalizar: array uniforme [{ name, score, ranking?, classification? }]
    const indexById = (arr, k) => Object.fromEntries(arr.map(x => [String(x[k] || '').toLowerCase(), x]));
    const map = indexById(raw, 'name');
    const out = COMPARADORES.map(c => {
      const item = map[c.toLowerCase()] || null;
      if (!item) return { name: NOMBRES_ES[c] || c, found: false };
      const score = item.score ?? item.value ?? item.overall ?? null;
      return {
        name: NOMBRES_ES[c] || c,
        nameEn: c,
        score: typeof score === 'number' ? +score.toFixed(1) : null,
        ranking: item.ranking ?? item.rank ?? null,
        classification: classify(score)
      };
    });

    res.setHeader('Cache-Control', 'public, max-age=2592000, s-maxage=2592000'); // 30 días
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({
      ok: true,
      year: new Date().getFullYear(),
      sourceUrl: SCORES_URL,
      sourceCountryPage: ARG_URL,
      data: out,
      debug: debug ? { rawCount: raw.length, sample: raw[0] } : undefined
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
