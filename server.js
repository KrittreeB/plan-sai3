/* ============================================================
   server.js — เซิร์ฟเวอร์ฐานข้อมูลกลางสำหรับ "แผนการทำงาน สาย 3"
   - เก็บข้อมูลทั้งก้อน (snapshot) ไว้บน Turso (SQLite บนคลาวด์) ข้อมูลไม่หาย
   - เสิร์ฟหน้าเว็บ (index.html + support.js + data/seed.js + header.jpg)
   - API:  GET /api/state   → ดึงข้อมูลล่าสุด (JSON)
           POST /api/state  → บันทึกข้อมูลทั้งก้อน (JSON)

   ตั้งค่า Environment Variables 2 ตัวบน Render:
     TURSO_URL         = libsql://xxxx.turso.io
     TURSO_AUTH_TOKEN  = <token จาก turso>
   Start Command บน Render:  node server.js   (หรือ yarn start)
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const HTML_FILE = 'index.html';

if (!process.env.TURSO_URL) {
  console.error('** ยังไม่ได้ตั้งค่า TURSO_URL / TURSO_AUTH_TOKEN **');
  console.error('   ไปที่ Render > Environment แล้วเพิ่มค่าทั้งสอง');
}
const db = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN });

async function initDb() {
  await db.execute("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT, ts INTEGER)");
}
async function getState() {
  const r = await db.execute({ sql: "SELECT v FROM kv WHERE k='state'" });
  return r.rows.length ? String(r.rows[0].v) : null;
}
async function setState(json) {
  await db.execute({
    sql: "INSERT INTO kv(k,v,ts) VALUES('state',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts",
    args: [json, Date.now()],
  });
}

/* ---------- static ---------- */
const CT = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png',
  '.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon' };
function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/' + HTML_FILE : pathname);
  const file = path.normalize(path.join(DIR, rel));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': CT[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}
function readBody(req) { return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); }); }
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const v = await getState();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(v || '{}');
    }
    if (url.pathname === '/api/state' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed; try { parsed = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { ok:false, error:'bad json' }); }
      if (!parsed || !Array.isArray(parsed.entries)) return sendJSON(res, 400, { ok:false, error:'no entries' });
      await setState(JSON.stringify(parsed));
      return sendJSON(res, 200, { ok:true, entries: parsed.entries.length });
    }
    return serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { ok:false, error: String(err && err.message || err) });
  }
});

initDb().then(() => {
  server.listen(PORT, () => console.log('ฐานข้อมูลกลางพร้อม · เปิดที่พอร์ต ' + PORT));
}).catch(e => { console.error('initDb error:', e); server.listen(PORT); });
