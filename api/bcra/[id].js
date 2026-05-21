// Proxy server-side para la API del BCRA. Resuelve dos problemas:
//   1. CORS: api.bcra.gob.ar puede no permitir requests desde el browser.
//   2. Estabilidad: si en algún momento BCRA migra de v3 a v4, lo cambiamos en
//      un solo lugar sin tocar el frontend.
//
// Uso desde el cliente:
//   /api/bcra/1                       → toda la serie de Reservas (ID 1)
//   /api/bcra/5?desde=2026-01-01&hasta=2026-05-21
//
// Vercel mapea api/bcra/[id].js a /api/bcra/{id} y expone el segmento
// dinámico en req.query.id.

const BCRA_BASE = 'https://api.bcra.gob.ar/estadisticas/v3.0/monetarias';

export default async function handler(req, res) {
  // CORS abierto: cualquier origen puede consumir esta función.
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
  const upstream = `${BCRA_BASE}/${id}${qs.toString() ? '?' + qs.toString() : ''}`;

  try {
    const r = await fetch(upstream, {
      headers: { 'User-Agent': 'simpleza-coyuntura/1.0' }
    });
    const body = await r.text();
    // Cache de 5 minutos en el edge: los datos del BCRA son intra-day pero no cambian segundo a segundo.
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json; charset=utf-8');
    res.status(r.status).send(body);
  } catch (e) {
    res.status(502).json({ error: 'upstream BCRA falló', detail: e.message });
  }
}
