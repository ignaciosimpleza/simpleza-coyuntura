import { createClient } from '@libsql/client';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

let db = null;
function getDB() {
  if (!url) throw new Error('TURSO_DATABASE_URL no configurada');
  if (!db) db = createClient({ url, authToken });
  return db;
}

async function ensureSchema(client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(month, version)
    )
  `);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  try {
    const client = getDB();
    await ensureSchema(client);

    const u = new URL(req.url, `http://${req.headers.host}`);
    const id = u.searchParams.get('id');
    const method = req.method;

    // GET /api/reports                → lista todos
    // GET /api/reports?id=123         → trae uno
    // POST /api/reports               → crea (body: { month, data })
    // DELETE /api/reports?id=123      → elimina

    if (method === 'GET' && !id) {
      const r = await client.execute(
        'SELECT id, month, version, created_at, title FROM reports ORDER BY created_at DESC'
      );
      return json(res, 200, { reports: r.rows });
    }

    if (method === 'GET' && id) {
      const r = await client.execute({
        sql: 'SELECT id, month, version, created_at, title, data FROM reports WHERE id = ?',
        args: [Number(id)]
      });
      if (r.rows.length === 0) return json(res, 404, { error: 'No encontrado' });
      const row = r.rows[0];
      return json(res, 200, { ...row, data: JSON.parse(row.data) });
    }

    if (method === 'POST') {
      const body = await readBody(req);
      const { month, data } = body || {};
      if (!month || !data) return json(res, 400, { error: 'month y data son requeridos' });

      const v = await client.execute({
        sql: 'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM reports WHERE month = ?',
        args: [month]
      });
      const version = Number(v.rows[0].next);
      const createdAt = new Date().toISOString();
      const title = `${month} · v${version} · ${createdAt.slice(0, 10)}`;

      const r = await client.execute({
        sql: 'INSERT INTO reports (month, version, created_at, title, data) VALUES (?, ?, ?, ?, ?)',
        args: [month, version, createdAt, title, JSON.stringify(data)]
      });

      return json(res, 201, {
        id: Number(r.lastInsertRowid),
        month, version, title, created_at: createdAt
      });
    }

    if (method === 'DELETE' && id) {
      await client.execute({
        sql: 'DELETE FROM reports WHERE id = ?',
        args: [Number(id)]
      });
      return json(res, 200, { ok: true });
    }

    res.setHeader('allow', 'GET, POST, DELETE');
    return json(res, 405, { error: 'Método no permitido' });
  } catch (e) {
    console.error('api/reports error:', e);
    return json(res, 500, { error: e.message || 'Error interno' });
  }
}
