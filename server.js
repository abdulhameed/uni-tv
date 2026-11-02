// Uni TV — local server: serves the UI, proxies streams (CORS + custom headers),
// checks stream health, and writes recordings to ./recordings.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const os = require('os');
const { parse } = require('./playlist');
const { enrich } = require('./enrich');

const PORT = parseInt(process.env.PORT || '4321', 10);
// Set LAN=1 to let other devices on your network open shared links.
const LAN = /^(1|true|yes)$/i.test(process.env.LAN || '');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const ROOT = __dirname;
const PLAYLIST = process.env.PLAYLIST || path.join(ROOT, 'Global TV.m3u');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const REC_DIR = path.join(ROOT, 'recordings');
const HEALTH_FILE = path.join(DATA_DIR, 'health.json');
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HEALTH_TTL = 6 * 60 * 60 * 1000; // re-check after 6 hours

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(REC_DIR, { recursive: true });

// ---------- Channels & health ----------
const channels = parse(PLAYLIST);
const byId = new Map(channels.map((c) => [c.id, c]));
console.log(`Loaded ${channels.length} channels from ${path.basename(PLAYLIST)}`);
const enriched = enrich(channels, path.join(DATA_DIR, 'iptv-org'))
  .then((n) => console.log(`Matched ${n} channels with iptv-org metadata`))
  .catch((e) => console.warn('iptv-org metadata unavailable:', e.message));

let health = {};
try { health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')); } catch {}
let healthDirty = false;
setInterval(() => {
  if (!healthDirty) return;
  healthDirty = false;
  fs.writeFile(HEALTH_FILE, JSON.stringify(health), () => {});
}, 5000);

function setHealth(id, ok) {
  health[id] = { ok, t: Date.now() };
  healthDirty = true;
}

// ---------- Upstream fetching ----------
function encodeOpts(o) {
  if (!o || (!o.r && !o.ua)) return '_';
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
function decodeOpts(s) {
  if (!s || s === '_') return {};
  try { return JSON.parse(Buffer.from(s, 'base64url').toString()); } catch { return {}; }
}
// Path-based proxy URLs so relative URLs inside playlists/manifests resolve naturally.
function proxyPath(absUrl, opts) {
  const u = new URL(absUrl);
  return `/p/${encodeOpts(opts)}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}`;
}

function upstreamRequest(url, opts, extraHeaders = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': opts.ua || DEFAULT_UA,
      Accept: '*/*',
      ...extraHeaders,
    };
    if (opts.r) {
      headers.Referer = /^https?:\/\//i.test(opts.r) ? opts.r : 'https://' + opts.r;
      try { headers.Origin = new URL(headers.Referer).origin; } catch {}
    }
    const req = mod.request(u, { method, headers, rejectUnauthorized: false, timeout: 15000 }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function readBody(res, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) { res.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

function rewriteM3u8(text, baseUrl, opts) {
  const abs = (uri) => {
    try { return proxyPath(new URL(uri, baseUrl).href, opts); } catch { return uri; }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${abs(u)}"`);
      return abs(t);
    })
    .join('\n');
}

function rewriteMpd(text, opts) {
  const fix = (u) => (/^https?:\/\//i.test(u) ? proxyPath(u, opts) : u);
  return text
    .replace(/<BaseURL([^>]*)>([^<]+)<\/BaseURL>/g, (_, a, u) => `<BaseURL${a}>${fix(u.trim())}</BaseURL>`)
    .replace(/\b(media|initialization|sourceURL)="([^"]+)"/g, (_, k, u) => `${k}="${fix(u)}"`);
}

const SEGMENT_EXT = /\.(ts|aac|m4s|mp4|m4a|m4v|mp3|vtt|webm|cmfv|cmfa|key|jpg|png)$/i;

async function handleProxy(req, res, rest) {
  // rest: <opts>/<scheme>/<host>/<path...>?query
  const m = rest.match(/^([^/]+)\/(https?)\/([^/?]+)(.*)$/);
  if (!m) return send(res, 400, 'bad proxy url');
  const opts = decodeOpts(m[1]);
  const target = `${m[2]}://${m[3]}${m[4] || '/'}`;
  const extra = {};
  if (req.headers.range) extra.Range = req.headers.range;

  let up;
  try {
    up = await upstreamRequest(target, opts, extra);
  } catch (e) {
    return send(res, 502, 'upstream error: ' + e.message);
  }

  if (up.statusCode >= 300 && up.statusCode < 400 && up.headers.location) {
    up.resume();
    const next = new URL(up.headers.location, target).href;
    res.writeHead(302, { Location: proxyPath(next, opts), 'Cache-Control': 'no-store' });
    return res.end();
  }

  const ct = (up.headers['content-type'] || '').toLowerCase();
  const pathname = new URL(target).pathname;
  const len = parseInt(up.headers['content-length'] || '0', 10);
  const looksText =
    /mpegurl|text|xml|dash|json/.test(ct) ||
    /\.(m3u8?|mpd)$/i.test(pathname) ||
    (!SEGMENT_EXT.test(pathname) && ct.includes('octet-stream') && len > 0 && len < 1024 * 1024);

  if (looksText && up.statusCode < 400) {
    let body;
    try { body = await readBody(up); } catch (e) { return send(res, 502, e.message); }
    let text = body.toString('utf8');
    let type = ct || 'application/octet-stream';
    if (text.trimStart().startsWith('#EXTM3U')) {
      text = rewriteM3u8(text, target, opts);
      type = 'application/vnd.apple.mpegurl';
    } else if (/<MPD[\s>]/.test(text)) {
      text = rewriteMpd(text, opts);
      type = 'application/dash+xml';
    } else {
      res.writeHead(up.statusCode, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    res.writeHead(up.statusCode, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    return res.end(text);
  }

  const headers = { 'Cache-Control': 'no-store' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    if (up.headers[h]) headers[h] = up.headers[h];
  }
  res.writeHead(up.statusCode, headers);
  up.pipe(res);
  req.on('close', () => up.destroy());
}

// ---------- Health checks ----------
async function probe(url, opts, depth = 0) {
  const res = await upstreamRequest(url, opts);
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 5) {
    res.resume();
    return probe(new URL(res.headers.location, url).href, opts, depth + 1);
  }
  if (res.statusCode >= 400) { res.resume(); return false; }
  const body = (await readBody(res, 512 * 1024).catch(() => Buffer.alloc(0))).toString('utf8');
  if (body.trimStart().startsWith('#EXTM3U')) {
    // Master playlist: make sure the first variant is alive too
    if (/#EXT-X-STREAM-INF/.test(body) && depth < 5) {
      const lines = body.split(/\r?\n/);
      const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      const variant = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
      if (variant) return probe(new URL(variant.trim(), url).href, opts, depth + 1);
    }
    return /#EXTINF|#EXT-X-TARGETDURATION/.test(body);
  }
  if (/<MPD[\s>]/.test(body)) return true;
  return body.length > 0;
}

async function checkChannel(c, force = false) {
  const h = health[c.id];
  if (!force && h && Date.now() - h.t < HEALTH_TTL) return h.ok;
  if (c.type === 'unsupported') { setHealth(c.id, false); return false; }
  let ok = false;
  try {
    ok = await Promise.race([
      probe(c.url, { r: c.referrer, ua: c.userAgent }),
      new Promise((r) => setTimeout(() => r(false), 12000)),
    ]);
  } catch { ok = false; }
  setHealth(c.id, ok);
  return ok;
}

async function runPool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const scan = { running: false, done: 0, total: 0, ok: 0 };
async function startScan(force) {
  if (scan.running) return;
  Object.assign(scan, { running: true, done: 0, total: channels.length, ok: 0 });
  await runPool(channels, 40, async (c) => {
    if (await checkChannel(c, force)) scan.ok++;
    scan.done++;
  });
  scan.running = false;
}

// ---------- Recordings ----------
const activeRecs = new Map(); // id -> { file, stream }

function safeName(s) {
  return s.replace(/[^\w\s.+()-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'recording';
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function listRecordings() {
  return fs.readdirSync(REC_DIR)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(REC_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs, active: [...activeRecs.values()].some((r) => r.file === f) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------- HTTP plumbing ----------
function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}
function json(res, data, status = 200) {
  send(res, status, JSON.stringify(data), 'application/json');
}
async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024);
  return buf.length ? JSON.parse(buf.toString()) : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.weba': 'audio/webm', '.json': 'application/json',
};

function serveFile(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
    if (range && st.size) {
      const start = range[1] ? parseInt(range[1], 10) : 0;
      const end = range[2] ? Math.min(parseInt(range[2], 10), st.size - 1) : st.size - 1;
      res.writeHead(206, {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1,
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
}

function within(dir, file) {
  const p = path.resolve(dir, file);
  return p.startsWith(dir + path.sep) ? p : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    let m;
    // In LAN mode, guests can watch but can't touch recordings or start scans.
    const local = /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '');
    if (!local && (/^\/(api\/rec|api\/recordings|recordings)/.test(p) || (p === '/api/scan' && req.method === 'POST'))) {
      return json(res, { error: 'Only available on the host computer' }, 403);
    }
    if (p.startsWith('/p/')) return await handleProxy(req, res, req.url.slice(3));

    if (p === '/api/channels') {
      await enriched;
      const list = channels.map((c) => ({
        ...c,
        play: c.type === 'unsupported' ? null : proxyPath(c.url, { r: c.referrer, ua: c.userAgent }),
      }));
      return json(res, list);
    }

    if (p === '/api/health') return json(res, health);

    if (p === '/api/info') return json(res, { lan: LAN, lanUrls: LAN ? lanUrls() : [] });

    // One-channel playlist for VLC/IINA etc. — keeps any required headers.
    if ((m = p.match(/^\/share\/([a-f0-9]+)\.m3u$/))) {
      await enriched;
      const c = byId.get(m[1]);
      if (!c) return send(res, 404, 'unknown channel');
      const lines = ['#EXTM3U', `#EXTINF:-1${c.logo ? ` tvg-logo="${c.logo}"` : ''},${c.name}`];
      if (c.referrer) lines.push(`#EXTVLCOPT:http-referrer=${c.referrer}`);
      if (c.userAgent) lines.push(`#EXTVLCOPT:http-user-agent=${c.userAgent}`);
      lines.push(c.url, '');
      res.writeHead(200, {
        'Content-Type': 'audio/x-mpegurl',
        'Content-Disposition': `attachment; filename="${safeName(c.name)}.m3u"`,
      });
      return res.end(lines.join('\n'));
    }

    if (p === '/api/check' && req.method === 'POST') {
      const { ids = [], force = false } = await readJson(req);
      const out = {};
      await runPool(ids.slice(0, 200), 16, async (id) => {
        const c = byId.get(id);
        if (c) out[id] = await checkChannel(c, force);
      });
      return json(res, out);
    }

    if (p === '/api/report' && req.method === 'POST') {
      const { id, ok } = await readJson(req);
      if (byId.has(id)) setHealth(id, !!ok);
      return json(res, { ok: true });
    }

    if (p === '/api/scan') {
      if (req.method === 'POST') {
        const { force = false } = await readJson(req);
        startScan(force);
      }
      return json(res, scan);
    }

    if (p === '/api/recordings') return json(res, listRecordings());

    if (p === '/api/rec/start' && req.method === 'POST') {
      const { channel = 'Channel', kind = 'video', ext = 'webm' } = await readJson(req);
      const id = crypto.randomBytes(6).toString('hex');
      const cleanExt = /^(webm|mp4|m4a|weba|ogg)$/.test(ext) ? ext : 'webm';
      const file = `${safeName(channel)} ${stamp()}${kind === 'audio' ? ' (audio)' : ''}.${cleanExt}`;
      activeRecs.set(id, { file, stream: fs.createWriteStream(path.join(REC_DIR, file)) });
      return json(res, { id, file });
    }

    if ((m = p.match(/^\/api\/rec\/([a-f0-9]+)\/(chunk|stop)$/)) && req.method === 'POST') {
      const rec = activeRecs.get(m[1]);
      if (!rec) return json(res, { error: 'no such recording' }, 404);
      if (m[2] === 'chunk') {
        const buf = await readBody(req, 200 * 1024 * 1024);
        if (!rec.stream.write(buf)) await new Promise((r) => rec.stream.once('drain', r));
        return json(res, { ok: true });
      }
      activeRecs.delete(m[1]);
      await new Promise((r) => rec.stream.end(r));
      return json(res, { ok: true, file: rec.file });
    }

    if ((m = p.match(/^\/api\/recordings\/(.+)$/))) {
      const file = within(REC_DIR, decodeURIComponent(m[1]));
      if (!file) return send(res, 400, 'bad name');
      if (req.method === 'DELETE') {
        fs.unlink(file, () => json(res, { ok: true }));
        return;
      }
      if (req.method === 'POST' && url.searchParams.get('action') === 'reveal') {
        if (process.platform === 'darwin') exec(`open -R ${JSON.stringify(file)}`);
        return json(res, { ok: true });
      }
    }

    if (p.startsWith('/recordings/')) {
      const file = within(REC_DIR, decodeURIComponent(p.slice('/recordings/'.length)));
      return file ? serveFile(req, res, file) : send(res, 400, 'bad name');
    }

    const file = within(PUBLIC_DIR, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)));
    if (file) return serveFile(req, res, file);
    send(res, 404, 'not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, String(e.message || e));
    else res.destroy();
  }
});

function lanUrls() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
}

server.listen(PORT, HOST, () => {
  console.log(`Uni TV running at http://localhost:${PORT}`);
  if (LAN) console.log(`Shared on your network at ${lanUrls().join(', ')}`);
});
