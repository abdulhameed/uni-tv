// Accounts, sessions, bot protection and watch history.
//
// Bot protection layers on sign-up / sign-in:
//  1. Proof-of-work: the browser must find a nonce whose SHA-256 has N leading zero bits
//     (~1s of work for a person, expensive at scale). Difficulty rises for noisy IPs.
//  2. Challenges are HMAC-signed, expire, are single-use, and can't be answered faster
//     than a human could fill the form.
//  3. Hidden honeypot field.
//  4. Per-IP and per-account rate limits, with account lockout after repeated failures.
//  5. Generic login errors + dummy hashing so usernames can't be probed.
//  6. Optional Cloudflare Turnstile (set TURNSTILE_SITE_KEY and TURNSTILE_SECRET).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { promisify } = require('util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

const SESSION_DAYS = 30;
const COOKIE = 'unitv_session';
const POW_BITS = 18;
const CHALLENGE_TTL = 10 * 60 * 1000;
const MIN_FILL_MS = 1500;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123',
  'qwertyuiop', '11111111', '00000000', 'iloveyou', 'letmein1', 'welcome1', 'abc12345', 'football', 'baseball', 'sunshine',
  'princess', 'admin123', 'passw0rd', 'trustno1', 'superman', 'starwars', 'whatever', 'dragon12', 'monkey12', 'q1w2e3r4']);

const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';

function createAuth(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'uni-tv.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login INTEGER,
      failed INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT, ua TEXT
    );
    CREATE TABLE IF NOT EXISTS watch (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      play_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      seconds INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, play_key)
    );
    CREATE INDEX IF NOT EXISTS watch_user ON watch(user_id, last_at);
  `);
  db.exec('PRAGMA foreign_keys = ON');

  // Signing key for challenges, kept across restarts
  const keyFile = path.join(dataDir, 'secret.key');
  let hmacKey;
  try { hmacKey = fs.readFileSync(keyFile); } catch {
    hmacKey = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, hmacKey, { mode: 0o600 });
  }

  const q = {
    userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, created_at FROM users WHERE id = ?'),
    passById: db.prepare('SELECT pass_hash FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?)'),
    loginOk: db.prepare('UPDATE users SET failed = 0, locked_until = 0, last_login = ? WHERE id = ?'),
    loginFail: db.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?'),
    setPass: db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)'),
    session: db.prepare('SELECT s.user_id, s.expires_at, u.username, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    watchRow: db.prepare('SELECT id, last_at FROM watch WHERE user_id = ? AND play_key = ?'),
    watchInsert: db.prepare('INSERT INTO watch (user_id, play_key, channel_id, channel_name, started_at, last_at, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    watchAdd: db.prepare('UPDATE watch SET seconds = seconds + ?, last_at = ? WHERE id = ?'),
    watchTotals: db.prepare('SELECT COALESCE(SUM(seconds), 0) AS seconds, COUNT(DISTINCT channel_id) AS channels, COUNT(*) AS sessions FROM watch WHERE user_id = ? AND seconds >= 10'),
    watchTop: db.prepare(`SELECT channel_id, MAX(channel_name) AS name, SUM(seconds) AS seconds, MAX(last_at) AS last
      FROM watch WHERE user_id = ? AND seconds >= 10 GROUP BY channel_id ORDER BY seconds DESC LIMIT 20`),
    watchRecent: db.prepare(`SELECT channel_id, channel_name AS name, started_at, last_at, seconds
      FROM watch WHERE user_id = ? AND seconds >= 10 ORDER BY last_at DESC LIMIT 100`),
    watchSince: db.prepare('SELECT started_at, seconds FROM watch WHERE user_id = ? AND started_at >= ?'),
    watchClear: db.prepare('DELETE FROM watch WHERE user_id = ?'),
  };
  setInterval(() => q.purgeSessions.run(Date.now()), 60 * 60 * 1000).unref();

  // ---------- helpers ----------
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const ipOf = (req) => req.socket.remoteAddress || 'unknown';

  // Async scrypt so hashing never stalls streams or chat
  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(pw, salt, 64, SCRYPT);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
  }
  async function verifyPassword(pw, stored) {
    const [, salt, hash] = stored.split('$');
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
    return crypto.timingSafeEqual(expected, actual);
  }
  const DUMMY_HASH = `scrypt$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(64).toString('base64')}`;

  function passwordProblem(pw, username) {
    if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
    if (pw.length > 128) return 'Password is too long.';
    if (COMMON_PASSWORDS.has(pw.toLowerCase())) return 'That password is too common. Pick something less guessable.';
    if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Password shouldn’t contain your username.';
    if (new Set(pw).size < 4) return 'Password needs more variety.';
    return null;
  }

  // Sliding-window rate limiter
  const hits = new Map();
  function limited(key, max, windowMs) {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > max;
  }
  function recentCount(key, windowMs) {
    const now = Date.now();
    return (hits.get(key) || []).filter((t) => now - t < windowMs).length;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (!v.some((t) => now - t < 24 * 3600e3)) hits.delete(k);
  }, 10 * 60 * 1000).unref();

  // ---------- proof-of-work challenges ----------
  const usedChallenges = new Map(); // id -> expiry
  setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of usedChallenges) if (exp < now) usedChallenges.delete(k);
  }, 60 * 1000).unref();

  function issueChallenge(ip) {
    // Harder puzzles for IPs that have been failing or hammering the endpoints
    const noise = recentCount('fail:' + ip, 15 * 60e3) + Math.floor(recentCount('chal:' + ip, 10 * 60e3) / 10);
    const bits = POW_BITS + Math.min(noise, 3); // at most ~8x harder, a few seconds for a person
    const body = { id: crypto.randomBytes(12).toString('hex'), bits, iat: Date.now(), ip: sha256(ip).slice(0, 16) };
    const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto.createHmac('sha256', hmacKey).update(payload).digest('base64url');
    return { payload, sig, bits };
  }

  function leadingZeroBits(hex) {
    let bits = 0;
    for (const ch of hex) {
      const n = parseInt(ch, 16);
      if (n === 0) { bits += 4; continue; }
      return bits + Math.clz32(n) - 28;
    }
    return bits;
  }

  function checkChallenge(pow, ip) {
    if (!pow || typeof pow.payload !== 'string' || typeof pow.sig !== 'string' || pow.nonce == null) return 'Missing verification. Please try again.';
    const expected = crypto.createHmac('sha256', hmacKey).update(pow.payload).digest();
    const given = Buffer.from(pow.sig, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return 'Verification failed. Please try again.';
    let body;
    try { body = JSON.parse(Buffer.from(pow.payload, 'base64url').toString()); } catch { return 'Verification failed.'; }
    const age = Date.now() - body.iat;
    if (age > CHALLENGE_TTL) return 'This form expired. Please try again.';
    if (age < MIN_FILL_MS) return 'That was a little too fast. Please try again.';
    if (body.ip !== sha256(ip).slice(0, 16)) return 'Verification failed. Please try again.';
    if (usedChallenges.has(body.id)) return 'This form was already used. Please try again.';
    if (leadingZeroBits(sha256(`${pow.payload}:${pow.nonce}`)) < body.bits) return 'Verification failed. Please try again.';
    usedChallenges.set(body.id, body.iat + CHALLENGE_TTL);
    return null;
  }

  function verifyTurnstile(token, ip) {
    if (!TURNSTILE_SECRET) return Promise.resolve(true);
    if (!token) return Promise.resolve(false);
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token), remoteip: ip }).toString();
    return new Promise((resolve) => {
      const req = https.request('https://challenges.cloudflare.com/turnstile/v0/siteverify',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => { try { resolve(!!JSON.parse(d).success); } catch { resolve(false); } });
        });
      req.on('error', () => resolve(false));
      req.on('timeout', () => req.destroy());
      req.end(form);
    });
  }

  // ---------- sessions ----------
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }
  function cookieHeader(req, value, maxAge) {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
  }
  function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    q.insertSession.run(sha256(token), userId, now, now + SESSION_DAYS * 864e5, ipOf(req), String(req.headers['user-agent'] || '').slice(0, 200));
    res.setHeader('Set-Cookie', cookieHeader(req, token, SESSION_DAYS * 86400));
  }
  function userFrom(req) {
    const token = parseCookies(req)[COOKIE];
    if (!token) return null;
    const row = q.session.get(sha256(token));
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.user_id, username: row.username, createdAt: row.created_at, tokenHash: sha256(token) };
  }
  const isUsername = (name) => !!q.userByName.get(String(name || '').trim());
  const publicUser = (u) => u && { id: u.id, username: u.username, createdAt: u.createdAt ?? u.created_at };

  // ---------- request handling ----------
  async function handle(req, res, p, url, { json, readJson, user }) {
    const ip = ipOf(req);

    if (p === '/api/auth/session') {
      json(res, { user: publicUser(user), turnstileSiteKey: TURNSTILE_SITE_KEY || null });
      return true;
    }

    if (p === '/api/auth/challenge') {
      if (limited('chal:' + ip, 40, 10 * 60e3)) { json(res, { error: 'Too many attempts. Wait a few minutes.' }, 429); return true; }
      json(res, issueChallenge(ip));
      return true;
    }

    if ((p === '/api/auth/signup' || p === '/api/auth/login') && req.method === 'POST') {
      const body = await readJson(req);
      const signup = p.endsWith('signup');
      const username = String(body.username || '').trim();
      const password = body.password;

      // Honeypot: real people never see this field. Pretend it worked, but do nothing.
      if (body.website) { json(res, { ok: true, user: null }); return true; }

      if (signup ? limited('signup:' + ip, 5, 3600e3) : limited('login:' + ip, 15, 15 * 60e3)) {
        json(res, { error: 'Too many attempts from your network. Try again later.' }, 429);
        return true;
      }
      const powErr = checkChallenge(body.pow, ip);
      if (powErr) { json(res, { error: powErr, retry: true }, 400); return true; }
      if (!(await verifyTurnstile(body.turnstile, ip))) { json(res, { error: 'Please complete the human check.', retry: true }, 400); return true; }

      if (signup) {
        if (!USERNAME_RE.test(username)) { json(res, { error: 'Usernames are 3–20 characters: letters, numbers, _ . -' }, 400); return true; }
        const problem = passwordProblem(password, username);
        if (problem) { json(res, { error: problem }, 400); return true; }
        if (q.userByName.get(username)) { json(res, { error: 'That username is taken.' }, 409); return true; }
        let r;
        try { r = q.insertUser.run(username, await hashPassword(password), Date.now()); }
        catch { json(res, { error: 'That username is taken.' }, 409); return true; }
        const id = Number(r.lastInsertRowid);
        q.loginOk.run(Date.now(), id);
        startSession(req, res, id);
        json(res, { ok: true, user: publicUser(q.userById.get(id)) });
        return true;
      }

      // Login
      const generic = 'Wrong username or password.';
      const row = typeof password === 'string' && password.length <= 128 ? q.userByName.get(username) : null;
      if (!row) {
        await verifyPassword(String(password || 'x'), DUMMY_HASH); // equalise timing
        limited('fail:' + ip, 1e9, 15 * 60e3);
        json(res, { error: generic }, 401);
        return true;
      }
      if (row.locked_until > Date.now()) {
        const mins = Math.ceil((row.locked_until - Date.now()) / 60e3);
        json(res, { error: `Too many failed attempts. This account is locked for ${mins} more minute${mins > 1 ? 's' : ''}.` }, 423);
        return true;
      }
      if (!(await verifyPassword(password, row.pass_hash))) {
        const failed = row.failed + 1;
        // Lock after 5 failures: 15 min, doubling each time, up to 24h
        const lock = failed >= 5 ? Date.now() + Math.min(15 * 60e3 * 2 ** (failed - 5), 864e5) : 0;
        q.loginFail.run(failed, lock, row.id);
        limited('fail:' + ip, 1e9, 15 * 60e3);
        json(res, { error: generic }, 401);
        return true;
      }
      q.loginOk.run(Date.now(), row.id);
      startSession(req, res, row.id);
      json(res, { ok: true, user: publicUser(q.userById.get(row.id)) });
      return true;
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      if (user) q.deleteSession.run(user.tokenHash);
      res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
      json(res, { ok: true });
      return true;
    }

    // Everything below needs a signed-in user
    const accountRoute = p === '/api/auth/password' || p === '/api/auth/delete' || p === '/api/auth/logout-others' ||
      p === '/api/watch' || p.startsWith('/api/history');
    if (!accountRoute) return false;
    if (!user) {
      if (p === '/api/watch') { res.writeHead(204); res.end(); return true; } // anonymous viewing isn't tracked
      json(res, { error: 'Please sign in.' }, 401);
      return true;
    }

    if (p === '/api/auth/password' && req.method === 'POST') {
      const { current, next } = await readJson(req);
      if (limited('pw:' + user.id, 5, 15 * 60e3)) { json(res, { error: 'Too many attempts. Try again later.' }, 429); return true; }
      if (typeof current !== 'string' || !(await verifyPassword(current, q.passById.get(user.id).pass_hash))) { json(res, { error: 'Current password is wrong.' }, 401); return true; }
      const problem = passwordProblem(next, user.username);
      if (problem) { json(res, { error: problem }, 400); return true; }
      q.setPass.run(await hashPassword(next), user.id);
      q.deleteOtherSessions.run(user.id, user.tokenHash); // sign out other devices
      json(res, { ok: true });
      return true;
    }

    if (p === '/api/auth/logout-others' && req.method === 'POST') {
      q.deleteOtherSessions.run(user.id, user.tokenHash);
      json(res, { ok: true });
      return true;
    }

    if (p === '/api/auth/delete' && req.method === 'POST') {
      const { password } = await readJson(req);
      if (limited('pw:' + user.id, 5, 15 * 60e3)) { json(res, { error: 'Too many attempts. Try again later.' }, 429); return true; }
      if (typeof password !== 'string' || !(await verifyPassword(password, q.passById.get(user.id).pass_hash))) { json(res, { error: 'Password is wrong.' }, 401); return true; }
      q.watchClear.run(user.id);
      q.deleteUserSessions.run(user.id);
      q.deleteUser.run(user.id);
      res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
      json(res, { ok: true });
      return true;
    }

    // Watch-time heartbeat: { key, channel, name, seconds }
    if (p === '/api/watch' && req.method === 'POST') {
      const { key, channel, name, seconds } = await readJson(req);
      if (typeof key !== 'string' || key.length > 40 || typeof channel !== 'string' || channel.length > 40) { json(res, { error: 'bad request' }, 400); return true; }
      const now = Date.now();
      const reported = Math.max(0, Math.floor(Number(seconds) || 0));
      const row = q.watchRow.get(user.id, key);
      if (row) {
        // Never credit more time than has actually passed since the last beat
        const credit = Math.min(reported, Math.ceil((now - row.last_at) / 1000) + 2);
        q.watchAdd.run(credit, now, row.id);
      } else {
        q.watchInsert.run(user.id, key, channel, String(name || channel).slice(0, 120), now, now, Math.min(reported, 60));
      }
      json(res, { ok: true });
      return true;
    }

    if (p === '/api/history' && req.method === 'GET') {
      const since = Date.now() - 14 * 864e5;
      const daily = {};
      for (const r of q.watchSince.all(user.id, since)) {
        const d = new Date(r.started_at).toISOString().slice(0, 10);
        daily[d] = (daily[d] || 0) + r.seconds;
      }
      json(res, {
        user: publicUser(user),
        totals: q.watchTotals.get(user.id),
        top: q.watchTop.all(user.id),
        recent: q.watchRecent.all(user.id),
        daily,
      });
      return true;
    }

    if (p === '/api/history/clear' && req.method === 'POST') {
      q.watchClear.run(user.id);
      json(res, { ok: true });
      return true;
    }

    return false;
  }

  return { handle, userFrom, isUsername };
}

module.exports = { createAuth };
