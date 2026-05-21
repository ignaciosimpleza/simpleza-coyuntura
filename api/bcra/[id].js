// Proxy server-side para la API del BCRA. Resuelve dos problemas:
//   1. CORS: api.bcra.gob.ar puede no permitir requests desde el browser.
//   2. Algunos firewalls del BCRA rechazan user-agents no-browser. Acá usamos
//      uno realista y un timeout chico.
//
// Uso desde el cliente:
//   /api/bcra/1                       → toda la serie de Reservas (ID 1)
//   /api/bcra/5?desde=2026-01-01&hasta=2026-05-21
//
// Si BCRA v3 falla con 4xx, probamos automáticamente v2 como fallback.

const BCRA_HOSTS = [
  'https://api.bcra.gob.ar/estadisticas/v3.0/monetarias',
  // v2 expone el mismo endpoint con nombre distinto. Lo usamos sólo si v3 falla.
  'https://api.bcra.gob.ar/estadisticas/v2.0/principalesvariables'
];

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'application/json',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8'
      },
      signal: ctrl.signal
    });
  } finally {
    clearTimeout(timer);
  }
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
  const id = (u.pathname.split('/').filter(Boolean).pop() || '').trim();
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'id inválido (debe ser numérico)' });
  }
  const desde = u.searchParams.get('desde') || '';
  const hasta = u.searchParams.get('hasta') || '';

  const qs = new URLSearchParams();
  if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) qs.set('desde', desde);
  if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) qs.set('hasta', hasta);

  const errors = [];
  for (const base of BCRA_HOSTS) {
    const upstream = `${base}/${id}${qs.toString() ? '?' + qs.toString() : ''}`;
    try {
      const r = await fetchWithTimeout(upstream);
      const body = await r.text();
      if (r.ok) {
        res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
        res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
        res.setHeader('X-Bcra-Source', base);
        return res.status(200).send(body);
      }
      errors.push({ base, status: r.status, body: body.slice(0, 200) });
    } catch (e) {
      errors.push({ base, error: e.name === 'AbortError' ? 'timeout' : e.message });
    }
  }
  res.status(502).json({ error: 'BCRA: todos los endpoints fallaron', tried: errors });
}
