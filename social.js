// Channel comments and live chat, pushed to browsers over Server-Sent Events.
// Identity is a nickname plus a random secret kept in the browser; the public
// "author" id is a hash of that secret, so people can delete their own posts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TEXT = 500;
const MAX_NAME = 24;
const CHAT_KEEP = 500;
const ROOM_KEEP = 200; // per-channel chat rooms
const COMMENTS_KEEP = 300; // per channel

function createSocial(dataDir, channelById, { isUsername = () => false, guestPosting = false } = {}) {
  const file = path.join(dataDir, 'social.json');
  // rooms: 'global' plus one per channel id
  let db = { comments: {}, rooms: { global: [] } };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  if (Array.isArray(db.chat)) { db.rooms.global = db.chat; delete db.chat; }
  const roomOf = (id) => (id === 'global' || channelById(id) ? id : null);
  let dirty = false;
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    fs.writeFile(file, JSON.stringify(db), () => {});
  }, 2000);

  const clients = new Map(); // res -> { author, name, watching }
  const lastPost = new Map(); // author -> timestamp (rate limit)

  const authorOf = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
  const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME) || 'Guest';
  const cleanText = (s) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, MAX_TEXT);
  const newId = () => crypto.randomBytes(6).toString('hex');

  // Signed-in users post as their account; guests can't borrow a registered name.
  function identity(user, secret, name) {
    if (user) return { author: 'u' + user.id, name: user.username, member: true };
    let n = cleanName(name);
    if (isUsername(n)) n = (n.slice(0, MAX_NAME - 8) + ' (guest)');
    return { author: secret ? authorOf(secret) : null, name: n, member: false };
  }
  function canPost(user, json, res) {
    if (user || guestPosting) return true;
    json(res, { error: 'Sign in to join the conversation.', needAuth: true }, 401);
    return false;
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients.keys()) res.write(msg);
  }

  function presence() {
    const people = new Map();
    for (const c of clients.values()) {
      if (!c.author) continue;
      const ch = c.watching && channelById(c.watching);
      people.set(c.author, { name: c.name, member: !!c.member, watching: ch ? { id: ch.id, name: ch.name, flag: ch.flag || '' } : null });
    }
    return [...people.values()];
  }
  let presenceTimer;
  const pushPresence = () => {
    clearTimeout(presenceTimer);
    presenceTimer = setTimeout(() => broadcast('presence', presence()), 300);
  };

  // Keep idle connections from being dropped by proxies/browsers
  setInterval(() => { for (const res of clients.keys()) res.write(': ping\n\n'); }, 25000);

  function rateLimited(author) {
    const now = Date.now();
    if (now - (lastPost.get(author) || 0) < 1500) return true;
    lastPost.set(author, now);
    return false;
  }

  function watchingInfo(id) {
    const ch = id && channelById(id);
    return ch ? { id: ch.id, name: ch.name, flag: ch.flag || '' } : null;
  }

  // Returns true if the request was handled.
  async function handle(req, res, p, url, { json, readJson, local, user }) {
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const who = identity(user, url.searchParams.get('secret'), url.searchParams.get('name'));
      clients.set(res, { ...who, secret: url.searchParams.get('secret'), watching: url.searchParams.get('watching') || null });
      pushPresence();
      req.on('close', () => { clients.delete(res); pushPresence(); });
      return true;
    }

    if (p === '/api/me' && req.method === 'POST') {
      const { secret, name, watching } = await readJson(req);
      const who = identity(user, secret, name);
      // Update this person's presence on all their open connections (matched by browser secret,
      // so signing in or out on this browser updates its existing connections too)
      for (const c of clients.values()) {
        if (c.author === who.author || (secret && c.secret === secret)) {
          Object.assign(c, who);
          if (watching !== undefined) c.watching = watching || null;
        }
      }
      pushPresence();
      json(res, { author: who.author, name: who.name, member: who.member, host: local, canPost: !!user || guestPosting });
      return true;
    }

    if (p === '/api/chat' && req.method === 'GET') {
      const room = roomOf(url.searchParams.get('room') || 'global');
      if (!room) { json(res, { error: 'Unknown room' }, 404); return true; }
      json(res, { messages: (db.rooms[room] || []).slice(-150), online: presence() });
      return true;
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const { secret, name, text, watching, room: roomId = 'global' } = await readJson(req);
      const room = roomOf(roomId);
      const body = cleanText(text);
      if (!room) { json(res, { error: 'Unknown room' }, 404); return true; }
      if (!canPost(user, json, res)) return true;
      const who = identity(user, secret, name);
      if (!who.author || !body) { json(res, { error: 'Empty message' }, 400); return true; }
      if (rateLimited(who.author)) { json(res, { error: 'Slow down a little.' }, 429); return true; }
      const msg = { id: newId(), room, ...who, text: body, t: Date.now(),
        watching: room === 'global' ? watchingInfo(watching) : null };
      const list = (db.rooms[room] ||= []);
      list.push(msg);
      const keep = room === 'global' ? CHAT_KEEP : ROOM_KEEP;
      if (list.length > keep) db.rooms[room] = list.slice(-keep);
      dirty = true;
      broadcast('chat', msg);
      json(res, msg);
      return true;
    }

    let m;
    if ((m = p.match(/^\/api\/comments\/([a-f0-9]+)$/))) {
      const channelId = m[1];
      if (req.method === 'GET') {
        json(res, db.comments[channelId] || []);
        return true;
      }
      if (req.method === 'POST') {
        if (!channelById(channelId)) { json(res, { error: 'Unknown channel' }, 404); return true; }
        const { secret, name, text } = await readJson(req);
        const body = cleanText(text);
        if (!canPost(user, json, res)) return true;
        const who = identity(user, secret, name);
        if (!who.author || !body) { json(res, { error: 'Empty comment' }, 400); return true; }
        if (rateLimited(who.author)) { json(res, { error: 'Slow down a little.' }, 429); return true; }
        const c = { id: newId(), channel: channelId, ...who, text: body, t: Date.now() };
        const list = (db.comments[channelId] ||= []);
        list.push(c);
        if (list.length > COMMENTS_KEEP) db.comments[channelId] = list.slice(-COMMENTS_KEEP);
        dirty = true;
        broadcast('comment', c);
        json(res, c);
        return true;
      }
    }

    if (p === '/api/comment-counts') {
      json(res, Object.fromEntries(Object.entries(db.comments).map(([k, v]) => [k, v.length]).filter(([, n]) => n)));
      return true;
    }

    // Delete: authors can remove their own posts; the host (this computer) can remove anything.
    if ((m = p.match(/^\/api\/(chat|comments)\/delete$/)) && req.method === 'POST') {
      const { secret, id, channel, room = 'global' } = await readJson(req);
      const { author } = identity(user, secret, '');
      const list = (m[1] === 'chat' ? db.rooms[room] : db.comments[channel]) || [];
      const i = list.findIndex((x) => x.id === id);
      if (i < 0) { json(res, { error: 'Not found' }, 404); return true; }
      if (!local && list[i].author !== author) { json(res, { error: 'You can only delete your own posts.' }, 403); return true; }
      list.splice(i, 1);
      dirty = true;
      broadcast(m[1] === 'chat' ? 'chat-delete' : 'comment-delete', { id, channel, room });
      json(res, { ok: true });
      return true;
    }

    return false;
  }

  return { handle };
}

module.exports = { createSocial };
