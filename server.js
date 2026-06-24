/* ============================================================
   server.js — ฐานข้อมูลกลาง "แผนการทำงาน สาย 3" (Turso)
   ซิงก์แบบ "รายช่อง" (per-record) — หลายคนกรอกพร้อมกันไม่ทับกัน
     - แต่ละช่อง (วัน×หัวข้อ×เขตย่อย) เก็บเป็น 1 แถว key = date|no|sz
     - หัวข้องาน/ทีม/หมายเหตุทีม เก็บรวมเป็น meta ก้อนเดียว

   API:
     GET  /api/state   → { entries:[...], acts:[...], roster:[...], team:{...} }
     POST /api/entry   → อัปเดต 1 ช่อง (ถ้า plan/actual/note ว่างหมด = ลบช่องนั้น)
     POST /api/meta    → บันทึก { acts, roster, team }
     POST /api/state   → เขียนทับทั้งหมด (ใช้ตอนตั้งต้น)
     GET  /api/health  → สถานะการเชื่อมฐานข้อมูล

   Env บน Render:  TURSO_URL, TURSO_AUTH_TOKEN
   Start Command:  node server.js
   ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;
const HTML_FILE = 'index.html';

let db = null, dbStatus = 'ยังไม่ได้ตั้งค่า';
function initTurso() {
  if (!process.env.TURSO_URL || !process.env.TURSO_AUTH_TOKEN) {
    dbStatus = 'ยังไม่ได้ตั้งค่า TURSO_URL / TURSO_AUTH_TOKEN (โหมดออฟไลน์)';
    console.error('** ' + dbStatus + ' **'); return;
  }
  try {
    const { createClient } = require('@libsql/client');
    db = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    dbStatus = 'เชื่อม Turso แล้ว';
  } catch (e) { db = null; dbStatus = 'เชื่อม Turso ไม่สำเร็จ: ' + (e && e.message || e); console.error('** ' + dbStatus + ' **'); }
}
async function initDb() {
  if (!db) return;
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS entries(k TEXT PRIMARY KEY, id INTEGER, date TEXT, no INTEGER, z INTEGER, sz INTEGER, plan REAL, actual REAL, note TEXT, ts INTEGER)");
    await db.execute("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT, ts INTEGER)");
  } catch (e) { console.error('สร้างตารางไม่สำเร็จ:', e && e.message || e); }
}
const keyOf = e => String(e.date) + '|' + (+e.no) + '|' + (e.sz == null ? '' : +e.sz);
const num = v => (v == null || v === '' ? null : Number(v));

async function getState() {
  const out = { entries: [], acts: [], roster: [], team: {} };
  if (!db) return out;
  try {
    const er = await db.execute("SELECT id,date,no,z,sz,plan,actual,note FROM entries");
    out.entries = er.rows.map(r => ({
      id: r.id == null ? undefined : Number(r.id), date: String(r.date), no: Number(r.no),
      z: r.z == null ? null : Number(r.z), sz: r.sz == null ? null : Number(r.sz),
      plan: Number(r.plan) || 0, actual: Number(r.actual) || 0, note: r.note || ''
    }));
    const m = await db.execute("SELECT v FROM kv WHERE k='meta'");
    if (m.rows.length) { try { const j = JSON.parse(String(m.rows[0].v)); out.acts = j.acts || []; out.roster = j.roster || []; out.team = j.team || {}; } catch (e) {} }
  } catch (e) { console.error('อ่านข้อมูลไม่สำเร็จ:', e && e.message || e); }
  return out;
}
async function upsertEntry(e) {
  if (!db) return false;
  const k = keyOf(e);
  const empty = (!(+e.plan) && !(+e.actual) && !(e.note && String(e.note).trim()));
  try {
    if (empty) { await db.execute({ sql: "DELETE FROM entries WHERE k=?", args: [k] }); return true; }
    await db.execute({
      sql: "INSERT INTO entries(k,id,date,no,z,sz,plan,actual,note,ts) VALUES(?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(k) DO UPDATE SET id=excluded.id,z=excluded.z,plan=excluded.plan,actual=excluded.actual,note=excluded.note,ts=excluded.ts",
      args: [k, e.id == null ? null : +e.id, String(e.date), +e.no, num(e.z), num(e.sz), +e.plan || 0, +e.actual || 0, e.note || '', Date.now()],
    });
    return true;
  } catch (err) { console.error('upsert ไม่สำเร็จ:', err && err.message || err); return false; }
}
async function setMeta(obj) {
  if (!db) return false;
  try { await db.execute({ sql: "INSERT INTO kv(k,v,ts) VALUES('meta',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts", args: [JSON.stringify(obj), Date.now()] }); return true; }
  catch (e) { console.error('setMeta ไม่สำเร็จ:', e && e.message || e); return false; }
}
async function replaceAll(s) {
  if (!db) return false;
  try {
    await db.execute("DELETE FROM entries");
    for (const e of (s.entries || [])) await upsertEntry(e);
    await setMeta({ acts: s.acts || [], roster: s.roster || [], team: s.team || {} });
    return true;
  } catch (e) { console.error('replaceAll ไม่สำเร็จ:', e && e.message || e); return false; }
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
    const ext = path.extname(file).toLowerCase();
    const h = { 'Content-Type': CT[ext] || 'application/octet-stream' };
    if (ext === '.html' || ext === '.js') h['Cache-Control'] = 'no-cache';
    res.writeHead(200, h); res.end(data);
  });
}
function readBody(req) { return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); }); }
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let url; try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end('bad url'); }
  const p = url.pathname;
  try {
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, db: dbStatus });
    if (p === '/api/state' && req.method === 'GET') { res.writeHead(200, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-cache' }); return res.end(JSON.stringify(await getState())); }
    if (p === '/api/entry' && req.method === 'POST') {
      const e = JSON.parse((await readBody(req)) || '{}');
      if (!e || !e.date || e.no == null) return sendJSON(res, 400, { ok:false, error:'bad entry' });
      const ok = await upsertEntry(e); return sendJSON(res, ok ? 200 : 503, { ok, db: dbStatus });
    }
    if (p === '/api/meta' && req.method === 'POST') {
      const m = JSON.parse((await readBody(req)) || '{}');
      const ok = await setMeta({ acts: m.acts || [], roster: m.roster || [], team: m.team || {} });
      return sendJSON(res, ok ? 200 : 503, { ok, db: dbStatus });
    }
    if (p === '/api/state' && req.method === 'POST') {
      const s = JSON.parse((await readBody(req)) || '{}');
      if (!s || !Array.isArray(s.entries)) return sendJSON(res, 400, { ok:false, error:'no entries' });
      const ok = await replaceAll(s); return sendJSON(res, ok ? 200 : 503, { ok, entries: (s.entries||[]).length, db: dbStatus });
    }
    return serveStatic(res, p);
  } catch (err) { console.error(err); try { sendJSON(res, 500, { ok:false, error:String(err && err.message || err) }); } catch (e) {} }
});

process.on('uncaughtException', e => console.error('uncaughtException:', e && e.message || e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message || e));

initTurso();
server.listen(PORT, () => console.log('เปิดที่พอร์ต ' + PORT + ' · ฐานข้อมูล: ' + dbStatus));
initDb();
