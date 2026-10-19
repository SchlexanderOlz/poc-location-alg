'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Pool } = require('pg');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT) || 3000;
const SEED_COUNT = Math.max(1, parseInt(process.env.SEED_COUNT, 10) || 5000);
const AREA_LIMIT = Math.max(1, parseInt(process.env.AREA_LIMIT, 10) || 50000);
const RESEED = process.env.RESEED === 'true';
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const MAX_LAT = 85.0511; // Grenze von Web-Mercator

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// ---------- Queries ----------

// Gleicher Ausdruck wie im Index: point(longitude, latitude)
const IN_BBOX = 'point(longitude, latitude) <@ box(point($1::float8, $2::float8), point($3::float8, $4::float8))';

const SQL_ALL = 'SELECT id, latitude, longitude, capacity, name FROM locations';

const SQL_AREA = `
SELECT id, latitude, longitude, capacity, name
FROM locations
WHERE ${IN_BBOX}
LIMIT $5`;

const SQL_GRID = `
WITH pts AS (
  SELECT id, latitude, longitude, capacity, name,
         floor(longitude / $5)::int                                AS cx,
         floor(ln(tan(pi()/4 + radians(latitude)/2)) / $6)::int    AS cy
  FROM locations
  WHERE ${IN_BBOX}
),
ranked AS (
  SELECT *,
         count(*)     OVER (PARTITION BY cx, cy)                            AS anzahl,
         row_number() OVER (PARTITION BY cx, cy ORDER BY capacity DESC, id) AS rn
  FROM pts
)
SELECT id, latitude, longitude, capacity, name, anzahl::int AS anzahl
FROM ranked
WHERE rn = 1
LIMIT $7`;

// Zellgröße: höchstens n Zellen im Viewport (w x h Pixel, Zoom z),
// angeschnittene Randzellen mitgezählt. Hängt nur von z, w, h, n ab –
// nicht von der Position – damit die Zellen beim Verschieben stabil bleiben.
function cellSize(z, w, h, n) {
  const scale = 256 * 2 ** z;
  let c = Math.sqrt((w * h) / n);
  while ((Math.ceil(w / c) + 1) * (Math.ceil(h / c) + 1) > n) c *= 1.05;
  return { cellPx: c, cellLng: (c * 360) / scale, cellY: (c * 2 * Math.PI) / scale };
}

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const round = (v) => Math.round(v * 100) / 100;

async function timed(sql, params) {
  const t0 = process.hrtime.bigint();
  const res = await pool.query({ text: sql, values: params, rowMode: 'array' });
  return { rows: res.rows, dbMs: round(ms(t0)) };
}

// Zeilenformat in allen Modi gleich: [id, lat, lng, capacity, name, anzahl]
const withCount1 = (rows) => rows.map((r) => (r.push(1), r));

async function queryAll() {
  const { rows, dbMs } = await timed(SQL_ALL, []);
  return { meta: { mode: 'all', dbMs, rows: rows.length, totalInView: rows.length }, rows: withCount1(rows) };
}

async function queryArea(b) {
  const { rows, dbMs } = await timed(SQL_AREA, [b.minx, b.miny, b.maxx, b.maxy, AREA_LIMIT + 1]);
  const truncated = rows.length > AREA_LIMIT;
  if (truncated) rows.length = AREA_LIMIT;
  return {
    meta: { mode: 'area', dbMs, rows: rows.length, totalInView: rows.length, truncated },
    rows: withCount1(rows),
  };
}

// Die Garantie gilt nur, wenn die bbox nicht größer ist als w x h Pixel bei Zoom z.
// Eine (fehlerhafte oder manipulierte) größere bbox wird um ihre Mitte darauf verkleinert.
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
function fitToViewport(b, z, w, h) {
  const scale = 256 * 2 ** z;
  const out = { ...b };
  const maxLng = (w * 360) / scale;
  if (b.maxx - b.minx > maxLng) {
    const c = (b.minx + b.maxx) / 2;
    out.minx = c - maxLng / 2;
    out.maxx = c + maxLng / 2;
  }
  const y0 = mercY(b.miny);
  const y1 = mercY(b.maxy);
  const maxY = (h * 2 * Math.PI) / scale;
  if (y1 - y0 > maxY) {
    const c = (y0 + y1) / 2;
    out.miny = invMercY(c - maxY / 2);
    out.maxy = invMercY(c + maxY / 2);
  }
  return out;
}

async function queryGrid(bbox, z, w, h, n) {
  const b = fitToViewport(bbox, z, w, h);
  const { cellPx, cellLng, cellY } = cellSize(z, w, h, n);
  // n + 1, damit eine Verletzung der Garantie auffällt statt still abgeschnitten zu werden.
  const { rows, dbMs } = await timed(SQL_GRID, [b.minx, b.miny, b.maxx, b.maxy, cellLng, cellY, n + 1]);
  if (rows.length > n) {
    console.error(`ASSERTION FAILED: grid lieferte ${rows.length} Zeilen > n=${n} (z=${z} w=${w} h=${h} bbox=${JSON.stringify(b)})`);
    rows.length = n;
  }
  const totalInView = rows.reduce((s, r) => s + r[5], 0);
  return {
    meta: { mode: 'grid', dbMs, rows: rows.length, totalInView, n, cellLng, cellY, cellPx: round(cellPx) },
    rows,
  };
}

// ---------- Parameter ----------

class BadRequest extends Error {}

function num(q, key, min, max, fallback) {
  const raw = q.get(key);
  if (raw === null || raw === '') {
    if (fallback === undefined) throw new BadRequest(`Parameter ${key} fehlt`);
    return fallback;
  }
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new BadRequest(`Parameter ${key} ist keine Zahl`);
  return Math.min(max, Math.max(min, v));
}

function bbox(q) {
  const b = {
    minx: num(q, 'minx', -180, 180),
    miny: num(q, 'miny', -MAX_LAT, MAX_LAT),
    maxx: num(q, 'maxx', -180, 180),
    maxy: num(q, 'maxy', -MAX_LAT, MAX_LAT),
  };
  if (b.minx > b.maxx || b.miny > b.maxy) {
    throw new BadRequest('bbox ungültig (minx > maxx oder miny > maxy; 180°-Meridian wird nicht unterstützt)');
  }
  return b;
}

// ---------- HTTP ----------

function send(req, res, status, body, contentType, extraHeaders = {}) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? zlib.gzipSync(raw) : raw;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': out.length,
    'X-Raw-Bytes': raw.length,
    // Falls ein Proxy neu komprimiert und Content-Length entfernt:
    'X-Sent-Bytes': out.length,
    'Access-Control-Expose-Headers': 'X-Raw-Bytes, X-Sent-Bytes, Content-Length',
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    ...extraHeaders,
  });
  res.end(req.method === 'HEAD' ? undefined : out);
}

const sendJson = (req, res, status, obj) =>
  send(req, res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(req, res, 405, { error: 'Nur GET' });

  switch (url.pathname) {
    case '/favicon.ico':
      res.writeHead(204, { 'Cache-Control': 'max-age=86400' });
      return res.end();
    case '/health':
      return send(req, res, 200, 'ok', 'text/plain; charset=utf-8', { 'Cache-Control': 'no-store' });
    case '/':
    case '/index.html':
      return send(req, res, 200, await fs.promises.readFile(INDEX_HTML), 'text/html; charset=utf-8', {
        'Cache-Control': 'no-cache',
      });
    case '/api/all':
      return sendJson(req, res, 200, await queryAll());
    case '/api/area':
      return sendJson(req, res, 200, await queryArea(bbox(q)));
    case '/api/grid': {
      const b = bbox(q);
      const z = num(q, 'z', 0, 20);
      const w = Math.round(num(q, 'w', 100, 4000));
      const h = Math.round(num(q, 'h', 100, 4000));
      const n = Math.round(num(q, 'n', 10, 2000, 300));
      return sendJson(req, res, 200, await queryGrid(b, z, w, h, n));
    }
    default:
      return sendJson(req, res, 404, { error: 'Nicht gefunden' });
  }
}

// ---------- Start ----------

async function waitForDb() {
  let delay = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= 12) throw err;
      console.log(`DB noch nicht erreichbar (${err.code || err.message}), neuer Versuch in ${delay} ms`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
    }
  }
}

async function init() {
  await waitForDb();
  const client = await pool.connect();
  try {
    // Advisory-Lock: falls zwei Instanzen gleichzeitig starten, seedet nur eine.
    await client.query('SELECT pg_advisory_lock(7317)');
    await client.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const { rows } = await client.query('SELECT EXISTS (SELECT 1 FROM locations) AS has');
    if (RESEED || !rows[0].has) {
      const t0 = process.hrtime.bigint();
      const inserted = await seed(client, SEED_COUNT);
      console.log(`Seed: ${inserted} Standorte in ${Math.round(ms(t0))} ms${RESEED ? ' (RESEED=true)' : ''}`);
    } else {
      const { rows: c } = await client.query('SELECT count(*)::int AS n FROM locations');
      console.log(`Seed übersprungen: ${c[0].n} Standorte vorhanden (RESEED=true erzwingt Neu-Seed)`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(7317)').catch(() => {});
    client.release();
  }
}

function start() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof BadRequest) return sendJson(req, res, 400, { error: err.message });
      console.error(err);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'Interner Fehler' });
    });
  });
  server.listen(PORT, () => console.log(`Läuft auf Port ${PORT}`));
  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  init().then(start, (err) => {
    console.error('Start fehlgeschlagen:', err);
    process.exit(1);
  });
}

module.exports = { pool, cellSize, queryGrid, queryArea, queryAll, SQL_GRID };
