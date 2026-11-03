'use strict';
const express = require('express');
const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const httpProxy = require('http-proxy');
const { WebSocketServer } = require('ws');

// ───────────── Config (env দিয়ে বদলানো যাবে) ─────────────
const IDE_PORT = parseInt(process.env.IDE_PORT || '6617', 10);
const PASSWORD = process.env.IDE_PASSWORD || 'admin123';
const ROOT = path.resolve(process.env.PROJECTS_DIR || path.join(__dirname, 'projects'));
fs.mkdirSync(ROOT, { recursive: true });

const TOKEN = crypto.createHmac('sha256', 'web-ide-session').update(PASSWORD).digest('hex');
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const exists = (p) => fsp.access(p).then(() => true, () => false);
const cleanEnv = () => { const e = { ...process.env }; delete e.IDE_PASSWORD; delete e.IDE_PORT; delete e.PROJECTS_DIR; return e; };

// ───────────── Auth ─────────────
function parseCookies(h = '') {
  const o = {};
  h.split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function isAuthed(req) {
  const a = Buffer.from(parseCookies(req.headers.cookie).ide_auth || '');
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ───────────── Paths ─────────────
function projDir(name) {
  if (!NAME_RE.test(String(name))) throw new Error('Invalid project name (use letters, numbers, - and _)');
  return path.join(ROOT, name);
}
function safe(name, rel = '') {
  const base = projDir(name);
  const full = path.join(base, String(rel));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('Invalid path');
  return full;
}

// ───────────── Project detect / run ─────────────
async function detect(dir) {
  const pj = path.join(dir, 'package.json');
  if (await exists(pj)) {
    let pkg = {};
    try { pkg = JSON.parse(await fsp.readFile(pj, 'utf8')); } catch {}
    const hasDeps = Object.keys(pkg.dependencies || {}).length > 0;
    const hasNM = await exists(path.join(dir, 'node_modules'));
    const run = pkg.scripts && pkg.scripts.start ? 'npm start' : 'node ' + (pkg.main || 'index.js');
    return { kind: 'node', cmd: (hasDeps && !hasNM ? 'npm install --no-audit --no-fund && ' : '') + run };
  }
  if (await exists(path.join(dir, 'server.js'))) return { kind: 'node', cmd: 'node server.js' };
  return { kind: 'static' };
}

const procs = new Map(); // name -> {child, port, exited}
const logs = new Map();  // name -> {buf, subs}
function getLog(name) {
  if (!logs.has(name)) {
    const L = { buf: '', subs: new Set(), write(d) {
      L.buf += d; if (L.buf.length > 200000) L.buf = L.buf.slice(-150000);
      for (const ws of L.subs) if (ws.readyState === 1) ws.send(d);
    } };
    logs.set(name, L);
  }
  return logs.get(name);
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function startProject(name) {
  if (procs.has(name)) return;
  const dir = projDir(name);
  const t = await detect(dir);
  if (t.kind !== 'node') throw new Error('Static project – run লাগে না, সবসময় live থাকে.');
  const L = getLog(name);
  const port = await freePort();
  L.write(`\r\n\x1b[36m$ ${t.cmd}   (PORT=${port})\x1b[0m\r\n`);
  const child = spawn('bash', ['-c', t.cmd], {
    cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanEnv(), PORT: String(port) },
  });
  const pr = { child, port };
  pr.exited = new Promise((res) => { pr.done = res; });
  procs.set(name, pr);
  for (const s of [child.stdout, child.stderr]) {
    s.setEncoding('utf8');
    s.on('data', (d) => L.write(d.replace(/\r?\n/g, '\r\n')));
  }
  child.on('error', (e) => L.write(`\x1b[31m${e.message}\x1b[0m\r\n`));
  child.on('exit', (code, sig) => {
    if (procs.get(name) === pr) procs.delete(name);
    L.write(`\x1b[33m[process exited: ${sig || code}]\x1b[0m\r\n`);
    pr.done();
  });
}
async function stopProject(name) {
  const pr = procs.get(name);
  if (!pr) return;
  try { process.kill(-pr.child.pid, 'SIGTERM'); } catch {}
  const t = setTimeout(() => { try { process.kill(-pr.child.pid, 'SIGKILL'); } catch {} }, 3000);
  await pr.exited; clearTimeout(t);
}
function killAll() { for (const pr of procs.values()) { try { process.kill(-pr.child.pid, 'SIGKILL'); } catch {} } }
process.on('SIGINT', () => { killAll(); process.exit(0); });
process.on('SIGTERM', () => { killAll(); process.exit(0); });
process.on('exit', killAll);

// ───────────── Proxy ─────────────
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
proxy.on('error', (err, req, res) => {
  if (res && typeof res.writeHead === 'function') {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Project সাড়া দিচ্ছে না', 'Project চালু হচ্ছে বা crash করেছে। IDE-র Console tab দেখো।'));
  } else if (res && res.destroy) res.destroy();
});
proxy.on('proxyRes', (pr, req) => {
  const loc = pr.headers.location;
  if (req._prefix && loc && /^\/(?!\/)/.test(loc)) pr.headers.location = req._prefix + loc;
});
const page = (h, p) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#14161a;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px;padding:24px"><h2>${h}</h2><p style="color:#9aa">${p}</p></div>`;

// ───────────── App ─────────────
const app = express();
app.disable('x-powered-by');

// Public: প্রতি project এর URL  →  /p/<project>/
app.use('/p/:name', async (req, res, next) => {
  try {
    const name = req.params.name;
    if (!NAME_RE.test(name)) return res.status(404).send('Not found');
    const dir = projDir(name);
    if (!(await exists(dir))) return res.status(404).send(page('Project নেই', 'এই নামে কোনো project পাওয়া যায়নি।'));
    const [urlPath, ...qs] = req.originalUrl.split('?');
    if (urlPath === '/p/' + name) return res.redirect(301, '/p/' + name + '/' + (qs.length ? '?' + qs.join('?') : ''));
    const pr = procs.get(name);
    if (pr) {
      req._prefix = '/p/' + name;
      return proxy.web(req, res, { target: 'http://127.0.0.1:' + pr.port });
    }
    const t = await detect(dir);
    if (t.kind === 'node') return res.status(503).send(page('Project চালু নেই', 'IDE থেকে ▶ Run চাপো।'));
    express.static(dir, { dotfiles: 'ignore', index: 'index.html' })(req, res, () => res.status(404).send('404 Not found'));
  } catch (e) { next(e); }
});

// IDE API
const api = express.Router();
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

api.post('/login', express.json(), (req, res) => {
  const a = crypto.createHash('sha256').update(String((req.body || {}).password || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader('Set-Cookie', `ide_auth=${TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`);
  res.json({ ok: true });
});
api.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ide_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});
api.use((req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: 'Unauthorized' })));
api.put('/upload', express.raw({ type: '*/*', limit: '200mb' }), h(async (req, res) => {
  const full = safe(req.query.project, req.query.path);
  if (full === projDir(req.query.project)) throw new Error('Invalid path');
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, req.body);
  res.json({ ok: true });
}));
api.use(express.json({ limit: '20mb' }));

const TEMPLATES = {
  static: {
    'index.html': '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width,initial-scale=1">\n  <title>My Project</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello World 👋</h1>\n  <script src="script.js"></script>\n</body>\n</html>\n',
    'style.css': 'body { font-family: system-ui, sans-serif; padding: 2rem; }\n',
    'script.js': "console.log('Hello from script.js');\n",
  },
  node: {
    'package.json': JSON.stringify({ name: 'my-app', version: '1.0.0', scripts: { start: 'node server.js' }, dependencies: { express: '^4.19.2' } }, null, 2) + '\n',
    'server.js': "const express = require('express');\nconst app = express();\nconst PORT = process.env.PORT || 3000;\n\napp.use(express.static('public'));\napp.get('/api/hello', (req, res) => res.json({ msg: 'Hello from Node!' }));\n\napp.listen(PORT, () => console.log('Server running on port ' + PORT));\n",
    'public/index.html': '<!doctype html>\n<html><head><meta charset="utf-8"><title>Node App</title></head>\n<body>\n  <h1>Node.js app চলছে ✅</h1>\n  <script>fetch("api/hello").then(r => r.json()).then(d => document.body.append(d.msg));</script>\n</body></html>\n',
  },
};

api.get('/projects', h(async (req, res) => {
  const ents = await fsp.readdir(ROOT, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    if (!e.isDirectory() || !NAME_RE.test(e.name)) continue;
    const t = await detect(path.join(ROOT, e.name));
    out.push({ name: e.name, kind: t.kind, running: procs.has(e.name) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out);
}));
api.post('/projects', h(async (req, res) => {
  const { name, type } = req.body;
  const dir = projDir(name);
  if (await exists(dir)) throw new Error('এই নামে project আগে থেকেই আছে');
  await fsp.mkdir(dir, { recursive: true });
  const tpl = TEMPLATES[type] || (type === 'empty' ? {} : TEMPLATES.static);
  for (const [f, c] of Object.entries(tpl)) {
    await fsp.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fsp.writeFile(path.join(dir, f), c);
  }
  res.json({ ok: true });
}));
api.delete('/projects/:name', h(async (req, res) => {
  const dir = projDir(req.params.name);
  await stopProject(req.params.name);
  await fsp.rm(dir, { recursive: true, force: true });
  logs.delete(req.params.name);
  res.json({ ok: true });
}));
api.get('/projects/:name/status', h(async (req, res) => {
  const dir = projDir(req.params.name);
  const t = await detect(dir);
  const pr = procs.get(req.params.name);
  res.json({ kind: t.kind, running: !!pr, port: pr ? pr.port : null });
}));
api.post('/projects/:name/run', h(async (req, res) => {
  await stopProject(req.params.name);
  await startProject(req.params.name);
  res.json({ ok: true });
}));
api.post('/projects/:name/stop', h(async (req, res) => { await stopProject(req.params.name); res.json({ ok: true }); }));

async function walk(base, rel, depth) {
  const ents = await fsp.readdir(path.join(base, rel), { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out.push({ name: e.name, path: p, type: 'dir', children: depth < 8 ? await walk(base, p, depth + 1) : [] });
    else out.push({ name: e.name, path: p, type: 'file' });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}
api.get('/tree', h(async (req, res) => { res.json(await walk(projDir(req.query.project), '', 0)); }));
api.get('/file', h(async (req, res) => {
  const full = safe(req.query.project, req.query.path);
  const st = await fsp.stat(full);
  if (st.size > 5 * 1024 * 1024) return res.json({ binary: true });
  const buf = await fsp.readFile(full);
  if (buf.includes(0)) return res.json({ binary: true });
  res.json({ content: buf.toString('utf8') });
}));
api.put('/file', h(async (req, res) => {
  const full = safe(req.body.project, req.body.path);
  await fsp.writeFile(full, String(req.body.content ?? ''));
  res.json({ ok: true });
}));
api.post('/fs', h(async (req, res) => {
  const { project, path: rel, type } = req.body;
  const full = safe(project, rel);
  if (full === projDir(project)) throw new Error('Invalid path');
  if (type === 'dir') await fsp.mkdir(full, { recursive: true });
  else { await fsp.mkdir(path.dirname(full), { recursive: true }); await fsp.writeFile(full, '', { flag: 'wx' }); }
  res.json({ ok: true });
}));
api.delete('/fs', h(async (req, res) => {
  const full = safe(req.query.project, req.query.path);
  if (full === projDir(req.query.project)) throw new Error('Invalid path');
  await fsp.rm(full, { recursive: true, force: true });
  res.json({ ok: true });
}));
api.post('/rename', h(async (req, res) => {
  const from = safe(req.body.project, req.body.from);
  const to = safe(req.body.project, req.body.to);
  if (from === projDir(req.body.project) || to === projDir(req.body.project)) throw new Error('Invalid path');
  if (await exists(to)) throw new Error('এই নামে আগে থেকেই আছে');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  res.json({ ok: true });
}));
app.use('/_api', api);

// Project page থেকে absolute path (/style.css) আসলে Referer দেখে ঠিক project এ পাঠাও
app.use((req, res, next) => {
  if (req.path.startsWith('/_') || req.path.startsWith('/p/')) return next();
  const m = (req.headers.referer || '').match(/^https?:\/\/[^/]+\/p\/([A-Za-z0-9_-]{1,40})(?:\/|\?|$)/);
  if (m) return res.redirect(307, '/p/' + m[1] + req.originalUrl);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => res.status(500).send('Server error: ' + err.message)); // eslint-disable-line

// ───────────── HTTP server + WebSockets ─────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function shellConn(ws, u) {
  let dir;
  try { dir = projDir(u.searchParams.get('project')); } catch { return ws.close(); }
  const cols = Math.min(Math.max(parseInt(u.searchParams.get('cols')) || 100, 20), 300);
  const rows = Math.min(Math.max(parseInt(u.searchParams.get('rows')) || 24, 5), 100);
  // `script` দিয়ে native module ছাড়াই আসল PTY পাওয়া যায়
  const sh = spawn('script', ['-qfc', `stty cols ${cols} rows ${rows}; exec bash -i`, '/dev/null'], {
    cwd: dir, env: { ...cleanEnv(), TERM: 'xterm-256color', PS1: `\\[\\e[32m\\]${path.basename(dir)}\\[\\e[0m\\]:\\w\\$ ` },
  });
  sh.stdout.on('data', (d) => ws.readyState === 1 && ws.send(d));
  sh.stderr.on('data', (d) => ws.readyState === 1 && ws.send(d));
  sh.on('error', (e) => ws.readyState === 1 && ws.send('\r\n[shell error] ' + e.message + '\r\n'));
  sh.on('exit', () => ws.close());
  ws.on('message', (m) => { try { sh.stdin.write(m); } catch {} });
  ws.on('close', () => {
    try { sh.stdin.end(); sh.kill('SIGHUP'); } catch {}
    setTimeout(() => { try { sh.kill('SIGKILL'); } catch {} }, 2000);
  });
}
function logConn(ws, u) {
  let name;
  try { name = u.searchParams.get('project'); projDir(name); } catch { return ws.close(); }
  const L = getLog(name);
  if (L.buf) ws.send(L.buf);
  L.subs.add(ws);
  ws.on('close', () => L.subs.delete(ws));
}

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/_term' || u.pathname === '/_logs') {
    if (!isAuthed(req)) return socket.destroy();
    return wss.handleUpgrade(req, socket, head, (ws) => (u.pathname === '/_term' ? shellConn(ws, u) : logConn(ws, u)));
  }
  const m = u.pathname.match(/^\/p\/([A-Za-z0-9_-]{1,40})(\/.*)?$/);
  const pr = m && procs.get(m[1]);
  if (!pr) return socket.destroy();
  req.url = (m[2] || '/') + u.search;
  proxy.ws(req, socket, head, { target: 'http://127.0.0.1:' + pr.port });
});

server.listen(IDE_PORT, '0.0.0.0', () => {
  console.log(`Web IDE চালু: http://0.0.0.0:${IDE_PORT}`);
  console.log(`Projects folder: ${ROOT}`);
  if (!process.env.IDE_PASSWORD) console.log('⚠  IDE_PASSWORD সেট করো! এখন default password: admin123');
});
