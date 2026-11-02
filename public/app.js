// Uni TV front end
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CATEGORY_ORDER = ['News', 'Sports', 'Movies', 'Series', 'Entertainment', 'Music', 'Kids', 'Animation', 'Documentary',
  'Comedy', 'Classic', 'Lifestyle', 'Cooking', 'Travel', 'Outdoor', 'Auto', 'Business', 'Culture', 'Education', 'Science',
  'Religious', 'Legislative', 'Public', 'Shop', 'Weather', 'Relax', 'Family', 'Interactive', 'General'];

// Browser locale region → iptv-org country code (which uses UK, not GB)
const LOCALE_COUNTRY = (() => {
  const r = (navigator.language.split('-')[1] || '').toUpperCase();
  return r === 'GB' ? 'UK' : r;
})();

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('unitv.' + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem('unitv.' + k, JSON.stringify(v)); },
};

const state = {
  channels: [],
  byId: new Map(),
  groups: new Map(),        // key -> [channels], best first
  health: {},
  favs: new Set(store.get('favs', [])),
  recents: store.get('recents', []),
  view: 'curated',
  query: '',
  filters: Object.assign(
    { status: 'any', quality: 'any', favOnly: false, merge: true, hideGeo: false, hidePart: false, hideUnsupported: true, sort: 'name', cats: [], country: '', language: '' },
    store.get('filters', {})
  ),
  region: store.get('region', ''), // curated scope: '' = worldwide, else country code
  countries: new Map(),     // code -> { name, flag, count }
  current: null,
  list: [],                 // the list currently used for prev/next zapping
};

// ---------- helpers ----------
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function initials(name) {
  const words = name.replace(/[^\p{L}\p{N}+ ]/gu, ' ').trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 3)).toUpperCase();
}
function art(c) {
  const h = hue(c.key || c.name);
  return `background: linear-gradient(135deg, hsl(${h} 55% 30%), hsl(${(h + 40) % 360} 60% 16%))`;
}
function resLabel(h) { return h >= 2160 ? '4K' : h >= 1080 ? 'FHD' : h >= 720 ? 'HD' : h ? 'SD' : ''; }
function healthOf(c) { const h = state.health[c.id]; return h ? (h.ok ? 'ok' : 'bad') : 'unknown'; }
function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB'; }
function fmtTime(sec) { const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec % 60); return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function daySeed() { const d = new Date(); return d.getFullYear() * 1000 + d.getMonth() * 40 + d.getDate(); }
function seededShuffle(arr, seed) {
  const a = arr.slice(); let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

// Best-first ordering inside a duplicate group: live > unknown > dead, then resolution.
function rankGroup(list) {
  const score = (c) => ({ ok: 2, unknown: 1, bad: 0 }[healthOf(c)]) * 10000 + c.height - (c.type === 'unsupported' ? 50000 : 0);
  return list.sort((a, b) => score(b) - score(a));
}
function representative(c) { return rankGroup(state.groups.get(c.key) || [c])[0]; }

// ---------- data ----------
async function load() {
  const [channels, health] = await Promise.all([api('/api/channels'), api('/api/health')]);
  state.channels = channels;
  state.health = health;
  const langs = new Map();
  for (const c of channels) {
    // Same name in different countries is a different channel
    c.key = c.key + '|' + (c.country || '');
    state.byId.set(c.id, c);
    if (!state.groups.has(c.key)) state.groups.set(c.key, []);
    state.groups.get(c.key).push(c);
    if (c.country) {
      const e = state.countries.get(c.country) || { name: c.countryName, flag: c.flag, count: 0 };
      e.count++;
      state.countries.set(c.country, e);
    }
    for (const l of c.languages || []) langs.set(l, (langs.get(l) || 0) + 1);
  }
  const byCount = (m) => [...m].sort((a, b) => (b[1].count ?? b[1]) - (a[1].count ?? a[1]));
  $('#countrySel').innerHTML = '<option value="">All countries</option>' +
    byCount(state.countries).map(([k, v]) => `<option value="${k}">${v.flag} ${esc(v.name)} (${v.count})</option>`).join('');
  $('#langSel').innerHTML = '<option value="">All languages</option>' +
    byCount(langs).map(([k, n]) => `<option value="${esc(k)}">${esc(k)} (${n})</option>`).join('');
  renderCatChips();
  syncFilterUI();
  renderCurated();
  refreshRecCount();
}

async function checkIds(ids) {
  if (!ids.length) return;
  const res = await api('/api/check', { ids });
  for (const [id, ok] of Object.entries(res)) state.health[id] = { ok, t: Date.now() };
}

function report(c, ok) {
  state.health[c.id] = { ok, t: Date.now() };
  api('/api/report', { id: c.id, ok }).catch(() => {});
}

// ---------- views ----------
function setView(v) {
  state.view = v;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((el) => el.classList.add('hidden'));
  $('#view-' + v).classList.remove('hidden');
  if (v === 'browse') renderBrowse();
  if (v === 'recordings') renderRecordings();
  if (v === 'chat') { chatUnread = 0; updateChatDot(); ensureName(); scrollChat(true); $('#chatInput').focus(); }
}

// ----- curated -----
function cardHTML(c, sub) {
  const res = resLabel(c.height);
  const h = healthOf(c);
  return `<button class="card${state.current?.id === c.id ? ' playing' : ''}" data-id="${c.id}">
    <div class="thumb" style="${art(c)}">
      ${c.logo ? `<img src="${esc(c.logo)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${esc(initials(c.name))}'))">` : esc(initials(c.name))}
      <div class="badges">${h === 'ok' ? '<span class="badge live">LIVE</span>' : ''}${res ? `<span class="badge">${res}</span>` : ''}</div>
    </div>
    <div class="cbody"><div class="cname">${esc(c.name)}</div><div class="csub">${c.flag ? c.flag + ' ' : ''}${esc(sub ?? c.categories.join(' · '))}</div></div>
  </button>`;
}

function curatedPool(cat, country = state.region) {
  const seen = new Set(), out = [];
  for (const c of state.channels) {
    if (cat && !c.categories.includes(cat)) continue;
    if (country && c.country !== country) continue;
    if (c.type === 'unsupported' || c.partTime || c.geo || c.nsfw) continue;
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const rep = representative(c);
    if (healthOf(rep) !== 'bad') out.push(rep);
  }
  // Known-live first, then prefer HD; shuffle per day for variety.
  const shuffled = seededShuffle(out, daySeed() + hue((cat || '') + (country || '')));
  const rank = (c) => (healthOf(c) === 'ok' ? 2 : 0) + (c.height >= 720 ? 1 : 0);
  return shuffled.sort((a, b) => rank(b) - rank(a));
}

function renderCurated() {
  const root = $('#view-curated');
  const rows = [];
  const recents = state.recents.map((id) => state.byId.get(id)).filter(Boolean);
  const favs = [...state.favs].map((id) => state.byId.get(id)).filter(Boolean);
  if (recents.length) rows.push(`<div class="row"><h3>Continue watching</h3><div class="strip">${recents.map((c) => cardHTML(c)).join('')}</div></div>`);
  if (favs.length) rows.push(`<div class="row"><h3>Your favorites <small>${favs.length}</small></h3><div class="strip">${favs.map((c) => cardHTML(c)).join('')}</div></div>`);
  const region = state.region;
  const rowShell = (cat, title, total, country = region) => `<div class="row" data-cat="${cat}" data-country="${country}">
    <h3>${title} <small>${total.toLocaleString()} channels</small>
      <button class="link" data-browse="${cat}" data-browse-country="${country}">See all</button><button class="link" data-reshuffle>Shuffle</button></h3>
    <div class="strip">${'<div class="skeleton"></div>'.repeat(6)}</div></div>`;
  const inScope = (c, country = region) => !country || c.country === country;

  // When browsing worldwide, offer a row for the viewer's own country first.
  const home = state.countries.get(LOCALE_COUNTRY);
  if (!region && home) {
    const total = new Set(state.channels.filter((c) => c.country === LOCALE_COUNTRY).map((c) => c.key)).size;
    rows.push(rowShell('', `From ${home.flag} ${esc(home.name)}`, total, LOCALE_COUNTRY));
  }
  for (const cat of CATEGORY_ORDER) {
    const total = new Set(state.channels.filter((c) => c.categories.includes(cat) && inScope(c)).map((c) => c.key)).size;
    if (total >= (region ? 3 : 8)) rows.push(rowShell(cat, cat, total));
  }
  const regionOpts = '<option value="">🌍 Worldwide</option>' + [...state.countries]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([k, v]) => `<option value="${k}"${k === region ? ' selected' : ''}>${v.flag} ${esc(v.name)}</option>`).join('');
  root.innerHTML = `<div class="curhead">
      <div>Hand‑picked from ${state.channels.length.toLocaleString()} streams. Only channels that pass a live check, best quality first, full‑time and not geo‑blocked.</div>
      <label>Region <select id="regionSel">${regionOpts}</select></label>
    </div>` + rows.join('');
  $('#regionSel').onchange = (e) => { state.region = e.target.value; store.set('region', state.region); renderCurated(); };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); fillRow(e.target); }
  }, { rootMargin: '400px' });
  $$('.row[data-cat]', root).forEach((r) => io.observe(r));
}

async function fillRow(rowEl, offset = 0) {
  const cat = rowEl.dataset.cat;
  const strip = $('.strip', rowEl);
  const pool = curatedPool(cat, rowEl.dataset.country).slice(offset);
  const WANT = 16;
  const picked = [];
  // Check candidates in batches until we have enough verified-live channels.
  for (let i = 0; i < pool.length && picked.length < WANT && i < 120; i += 24) {
    const batch = pool.slice(i, i + 24);
    await checkIds(batch.filter((c) => healthOf(c) === 'unknown').map((c) => c.id));
    for (const c of batch) if (healthOf(c) === 'ok' && picked.length < WANT) picked.push(c);
  }
  strip.innerHTML = picked.length ? picked.map((c) => cardHTML(c, c.categories.filter((x) => x !== cat).join(' · ') || c.countryName || cat)).join('')
    : '<div class="empty">No live channels found right now.</div>';
  rowEl.dataset.offset = offset + 24;
}

// ----- browse -----
function renderCatChips() {
  const counts = {};
  for (const c of state.channels) for (const cat of c.categories) counts[cat] = (counts[cat] || 0) + 1;
  $('#catChips').innerHTML = CATEGORY_ORDER.filter((c) => counts[c])
    .map((c) => `<button class="chip${state.filters.cats.includes(c) ? ' active' : ''}" data-cat="${c}">${c}<b>${counts[c]}</b></button>`).join('');
}

function syncFilterUI() {
  const f = state.filters;
  $$('.seg').forEach((seg) => $$('button', seg).forEach((b) => b.classList.toggle('active', b.dataset.v === f[seg.dataset.filter])));
  $$('[data-opt]').forEach((i) => (i.checked = !!f[i.dataset.opt]));
  $('#sort').value = f.sort;
  $('#countrySel').value = f.country;
  $('#langSel').value = f.language;
}

function filtered() {
  const f = state.filters;
  const q = state.query.toLowerCase().trim();
  const terms = q ? q.split(/\s+/) : [];
  let list = state.channels;
  if (f.merge) {
    const seen = new Set();
    list = [];
    for (const c of state.channels) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      list.push(representative(c));
    }
  }
  list = list.filter((c) => {
    if (f.hideUnsupported && c.type === 'unsupported') return false;
    if (f.hideGeo && c.geo) return false;
    if (f.hidePart && c.partTime) return false;
    if (f.favOnly && !state.favs.has(c.id)) return false;
    if (c.nsfw) return false;
    if (f.country && c.country !== f.country) return false;
    if (f.language && !(c.languages || []).includes(f.language)) return false;
    if (f.cats.length && !f.cats.some((cat) => c.categories.includes(cat))) return false;
    if (f.quality === 'sd' && !(c.height && c.height < 720)) return false;
    if (f.quality === 'hd' && c.height < 720) return false;
    if (f.quality === 'fhd' && c.height < 1080) return false;
    const h = healthOf(c);
    if (f.status === 'live' && h !== 'ok') return false;
    if (f.status === 'notdead' && h === 'bad') return false;
    if (terms.length) {
      const hay = [c.name, c.categories.join(' '), c.group, c.countryName, (c.languages || []).join(' ')].join(' ').toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    quality: (a, b) => b.height - a.height || a.name.localeCompare(b.name),
    status: (a, b) => ({ ok: 0, unknown: 1, bad: 2 }[healthOf(a)] - { ok: 0, unknown: 1, bad: 2 }[healthOf(b)]) || a.name.localeCompare(b.name),
  }[f.sort];
  return list.slice().sort(by);
}

const ROW_H = 56;
let browseList = [];
function renderBrowse() {
  browseList = filtered();
  state.list = browseList;
  const total = state.filters.merge ? state.groups.size : state.channels.length;
  $('#resultCount').textContent = `${browseList.length.toLocaleString()} of ${total.toLocaleString()} channels` +
    (state.filters.status === 'live' && !Object.keys(state.health).length ? ' — run “Scan streams” to find live channels' : '');
  const el = $('#list');
  $('.vspacer', el).style.height = browseList.length * ROW_H + 'px';
  el.scrollTop = 0;
  drawRows();
}

function rowHTML(c, i) {
  const h = healthOf(c);
  const variants = state.filters.merge ? (state.groups.get(c.key) || []).length : 1;
  const res = resLabel(c.height);
  const badges = [
    res && `<span class="badge muted">${c.height}p</span>`,
    c.type === 'dash' && '<span class="badge muted">DASH</span>',
    c.type === 'unsupported' && '<span class="badge warn">RTMP/MMS</span>',
    c.geo && '<span class="badge warn">GEO</span>',
    c.partTime && '<span class="badge warn">PART‑TIME</span>',
  ].filter(Boolean).join('');
  return `<div class="lrow${state.current?.id === c.id ? ' playing' : ''}" style="top:${i * ROW_H}px" data-id="${c.id}">
    <span class="sdot ${h}" title="${h === 'ok' ? 'Live' : h === 'bad' ? 'Not responding' : 'Not checked'}"></span>
    <div class="avatar" style="${art(c)}">${c.logo ? `<img src="${esc(c.logo)}" loading="lazy" alt="">` : esc(initials(c.name))}</div>
    <div class="lmain"><div class="lname">${esc(c.name)}</div>
      <div class="lsub">${c.flag ? `${c.flag} ${esc(c.countryName)} · ` : ''}${esc(c.categories.join(' · '))}${c.languages?.length ? ' · ' + esc(c.languages.join(', ')) : ''}${variants > 1 ? ` · ${variants} sources` : ''}</div></div>
    <div class="lbadges">${badges}</div>
    <button class="star${state.favs.has(c.id) ? ' on' : ''}" data-fav="${c.id}" title="Favorite">${state.favs.has(c.id) ? '★' : '☆'}</button>
  </div>`;
}

function drawRows() {
  const el = $('#list');
  const start = Math.max(0, Math.floor(el.scrollTop / ROW_H) - 8);
  const end = Math.min(browseList.length, Math.ceil((el.scrollTop + el.clientHeight) / ROW_H) + 8);
  let html = '';
  for (let i = start; i < end; i++) html += rowHTML(browseList[i], i);
  $$('.lrow', el).forEach((r) => r.remove());
  el.insertAdjacentHTML('beforeend', html);
}

// ----- recordings -----
async function refreshRecCount() {
  let recs = await api('/api/recordings');
  if (!Array.isArray(recs)) recs = [];
  const pill = $('#recCount');
  pill.textContent = recs.length;
  pill.classList.toggle('hidden', !recs.length);
  return recs;
}

async function renderRecordings() {
  const recs = await refreshRecCount();
  const root = $('#view-recordings');
  root.innerHTML = `<h2>Recordings</h2><p class="hint">Saved to the <code>recordings</code> folder next to the app.</p>` +
    (recs.length ? recs.map((r) => {
      const audio = /\(audio\)|\.(m4a|weba|ogg)$/.test(r.name);
      return `<div class="recitem" data-name="${esc(r.name)}">
        <div class="ricon">${audio ? '♪' : '▶'}</div>
        <div class="rmain"><div class="rname">${esc(r.name)}</div>
          <div class="rsub">${fmtBytes(r.size)} · ${new Date(r.mtime).toLocaleString()}${r.active ? ' · <b style="color:var(--accent)">recording…</b>' : ''}</div>
          <div class="rplayer"></div></div>
        <div class="ractions">
          <button class="btn" data-act="play">Play</button>
          <a class="btn" href="/recordings/${encodeURIComponent(r.name)}" download>Download</a>
          <button class="btn" data-act="reveal">Show in Finder</button>
          <button class="btn danger" data-act="delete">Delete</button>
        </div></div>`;
    }).join('') : '<div class="empty" style="padding:0">Nothing recorded yet. Start a channel and hit Record.</div>');
}

$('#view-recordings').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const item = btn.closest('.recitem');
  const name = item.dataset.name;
  const url = '/recordings/' + encodeURIComponent(name);
  if (btn.dataset.act === 'play') {
    const slot = $('.rplayer', item);
    const audio = /\(audio\)|\.(m4a|weba|ogg)$/.test(name);
    slot.innerHTML = slot.innerHTML ? '' : audio ? `<audio class="recplayer" controls autoplay src="${url}"></audio>` : `<video class="recplayer" controls autoplay src="${url}"></video>`;
  } else if (btn.dataset.act === 'reveal') {
    fetch('/api/recordings/' + encodeURIComponent(name) + '?action=reveal', { method: 'POST' });
  } else if (btn.dataset.act === 'delete') {
    if (!confirm(`Delete "${name}"?`)) return;
    await fetch('/api/recordings/' + encodeURIComponent(name), { method: 'DELETE' });
    renderRecordings();
  }
});

// ---------- player ----------
const video = $('#video');
let hls = null, dash = null, stallTimer = null;

function overlay(html) {
  const o = $('#overlay');
  if (!html) return o.classList.add('hidden');
  o.innerHTML = html; o.classList.remove('hidden');
}

function teardown() {
  clearTimeout(stallTimer);
  if (hls) { hls.destroy(); hls = null; }
  if (dash) { dash.reset(); dash = null; }
  video.removeAttribute('src');
  video.load();
}

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}

async function play(c, fromList) {
  if (!c) return;
  if (recorder.active && !confirm('A recording is in progress. Stop it and switch channel?')) return;
  if (recorder.active) await recorder.stop();
  if (fromList) state.list = fromList;
  state.current = c;
  teardown();
  $('#player').classList.remove('hidden');
  renderPlayerInfo();
  markPlaying();

  state.recents = [c.id, ...state.recents.filter((x) => x !== c.id)].slice(0, 20);
  store.set('recents', state.recents);
  history.replaceState(null, '', shareUrl(c, location.origin));
  sayHello();
  loadComments(c);
  loadRoom(c);
  if (!$('#sharePanel').classList.contains('hidden')) renderShare();

  if (!c.play) {
    overlay(`<div>This stream uses ${esc(c.url.split(':')[0].toUpperCase())}, which browsers can't play.</div>
      <div style="font-size:12px;color:var(--muted)">Open it in VLC instead:</div>
      <input readonly value="${esc(c.url)}" style="width:90%;background:#111;border:1px solid #333;border-radius:6px;padding:6px" onclick="this.select()">`);
    return;
  }
  overlay('<div class="spinner"></div><div>Tuning in…</div>');
  stallTimer = setTimeout(() => fail(c, 'Timed out waiting for the stream.'), 20000);

  if (c.type === 'dash') {
    if (!window.dashjs) await loadScript('https://cdn.dashjs.org/latest/dash.all.min.js');
    dash = dashjs.MediaPlayer().create();
    dash.initialize(video, c.play, true);
    dash.on(dashjs.MediaPlayer.events.ERROR, () => fail(c, 'This DASH stream failed to load.'));
  } else if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ liveDurationInfinity: true, backBufferLength: 30, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
    let recovered = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => { fillQuality(); video.play().catch(() => {}); });
    hls.on(Hls.Events.LEVEL_SWITCHED, updateQualityLabel);
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
      if (d.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) {
        // Not HLS after all — let the browser try it directly.
        hls.destroy(); hls = null; video.src = c.play; return;
      }
      fail(c, 'The stream stopped responding.');
    });
    hls.loadSource(c.play);
    hls.attachMedia(video);
  } else {
    video.src = c.play;
  }
}

video.addEventListener('playing', () => {
  clearTimeout(stallTimer);
  overlay(null);
  if (state.current && healthOf(state.current) !== 'ok') { report(state.current, true); renderPlayerInfo(); }
});
video.addEventListener('waiting', () => { if (!video.paused) overlay('<div class="spinner"></div>'); });
video.addEventListener('error', () => { if (state.current && video.getAttribute('src')) fail(state.current, 'This stream format isn’t supported.'); });

function fail(c, msg) {
  if (state.current?.id !== c.id) return;
  clearTimeout(stallTimer);
  report(c, false);
  const alts = rankGroup((state.groups.get(c.key) || []).filter((x) => x.id !== c.id && x.play && healthOf(x) !== 'bad'));
  overlay(`<div>${esc(msg)}</div><div style="font-size:12px;color:var(--muted)">Many free streams go offline or are region‑locked.</div>
    <div style="display:flex;gap:8px">
      ${alts.length ? `<button class="btn" id="tryAlt">Try another source (${alts.length})</button>` : ''}
      <button class="btn" id="tryNext">Next channel ⏭</button>
      <button class="btn" id="tryAgain">Retry</button>
    </div>`);
  $('#tryAlt')?.addEventListener('click', () => play(alts[0]));
  $('#tryNext').addEventListener('click', () => zap(1));
  $('#tryAgain').addEventListener('click', () => play(c));
}

function renderPlayerInfo() {
  const c = state.current;
  $('#pName').textContent = c.name;
  const h = healthOf(c);
  $('#pMeta').innerHTML = [
    h === 'ok' && '<span class="badge live">LIVE</span>',
    c.height && `<span class="badge muted">${c.height}p</span>`,
    c.geo && '<span class="badge warn">GEO‑BLOCKED</span>',
    c.partTime && '<span class="badge warn">NOT 24/7</span>',
    c.flag && `<span>${c.flag} ${esc(c.countryName)}</span>`,
    `<span>${esc(c.categories.join(' · '))}</span>`,
    c.languages?.length && `<span>${esc(c.languages.join(', '))}</span>`,
    c.website && `<a href="${esc(c.website)}" target="_blank" rel="noopener" style="color:var(--muted)">website ↗</a>`,
  ].filter(Boolean).join('<span>·</span>');
  const variants = state.groups.get(c.key) || [];
  $('#pVariants').innerHTML = variants.length > 1 ? variants.map((v, i) =>
    `<button class="chip${v.id === c.id ? ' active' : ''}" data-id="${v.id}">Source ${i + 1}${v.height ? ' · ' + v.height + 'p' : ''}${healthOf(v) === 'bad' ? ' ✕' : ''}</button>`).join('') : '';
  const fav = state.favs.has(c.id);
  $('#pFav').textContent = fav ? '★' : '☆';
  $('#pFav').classList.toggle('on', fav);
  $('#pQuality').innerHTML = '';
  $('#pQuality').classList.add('hidden');
}

function fillQuality() {
  const sel = $('#pQuality');
  if (!hls || hls.levels.length < 2) return sel.classList.add('hidden');
  sel.innerHTML = '<option value="-1">Auto</option>' + hls.levels.map((l, i) => `<option value="${i}">${l.height ? l.height + 'p' : Math.round(l.bitrate / 1000) + ' kbps'}</option>`).join('');
  sel.value = '-1';
  sel.classList.remove('hidden');
}
function updateQualityLabel() {
  const sel = $('#pQuality');
  if (!hls || sel.value !== '-1' || !sel.options[0]) return;
  const l = hls.levels[hls.currentLevel];
  sel.options[0].textContent = l?.height ? `Auto (${l.height}p)` : 'Auto';
}

function markPlaying() {
  $$('.card.playing, .lrow.playing').forEach((el) => el.classList.remove('playing'));
  if (state.current) $$(`[data-id="${state.current.id}"]`).forEach((el) => el.matches('.card, .lrow') && el.classList.add('playing'));
}

function zap(dir) {
  const list = state.list.filter((c) => c.play);
  if (!list.length) return;
  const i = list.findIndex((c) => c.id === state.current?.id || c.key === state.current?.key);
  play(list[(i + dir + list.length) % list.length]);
}

function closePlayer() {
  if (recorder.active) { toast('Stop the recording first.'); return; }
  teardown();
  state.current = null;
  $('#player').classList.add('hidden');
  $('#sharePanel').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  markPlaying();
  sayHello();
}

// ---------- people: comments & live chat ----------
const me = {
  secret: store.get('secret', null) || (() => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    const v = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    store.set('secret', v);
    return v;
  })(),
  name: store.get('name', ''),
  author: null,
  host: false,
};
let chatUnread = 0;
let chatLoaded = false;

function ensureName(force) {
  if (me.name && !force) return true;
  const n = (prompt('Pick a name for comments and chat:', me.name || '') || '').trim().slice(0, 24);
  if (!n) return !!me.name;
  me.name = n;
  store.set('name', n);
  $('#myName').textContent = n;
  sayHello();
  return true;
}

async function sayHello() {
  const r = await api('/api/me', { secret: me.secret, name: me.name || 'Guest', watching: state.current?.id || null }).catch(() => null);
  if (r) { me.author = r.author; me.host = r.host; }
}

function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return new Date(t).toLocaleDateString();
}

function msgHTML(m, kind) {
  const mine = m.author === me.author;
  const h = hue(m.author);
  const tag = m.watching ? `<button class="chtag" data-watch="${m.watching.id}">${m.watching.flag ? m.watching.flag + ' ' : ''}${esc(m.watching.name)}</button>` : '';
  return `<div class="msg${mine ? ' mine' : ''}" data-mid="${m.id}">
    <div class="av" style="background:hsl(${h} 45% 28%)">${esc(m.name.slice(0, 1).toUpperCase())}</div>
    <div class="mbody">
      <div class="mhead"><b>${esc(m.name)}</b><span title="${new Date(m.t).toLocaleString()}">${timeAgo(m.t)}</span>${tag}
        ${mine || me.host ? `<button class="del" data-del="${kind}" data-id="${m.id}" data-channel="${m.channel || ''}" data-room="${m.room || 'global'}">delete</button>` : ''}</div>
      <div class="mtext">${esc(m.text)}</div>
    </div></div>`;
}

// ----- comments -----
async function loadComments(c) {
  const list = $('#commentList');
  list.innerHTML = '<div class="empty" style="padding:4px 0">Loading…</div>';
  const comments = await api('/api/comments/' + c.id).catch(() => []);
  if (state.current?.id !== c.id) return;
  renderComments(comments);
}
function renderComments(comments) {
  $('#cCount').textContent = comments.length || '';
  $('#commentList').innerHTML = comments.length
    ? comments.slice().reverse().map((m) => msgHTML(m, 'comments')).join('')
    : '<div class="empty" style="padding:4px 0">No comments yet. Start the conversation.</div>';
}
$('#commentForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#commentInput');
  const text = input.value.trim();
  if (!text || !state.current || !ensureName()) return;
  const r = await api('/api/comments/' + state.current.id, { secret: me.secret, name: me.name, text });
  if (r.error) return toast(r.error);
  input.value = '';
};

// ----- per-channel live chat -----
let lastPresence = [];
async function loadRoom(c) {
  const log = $('#roomLog');
  log.innerHTML = '';
  const { messages = [] } = await api('/api/chat?room=' + c.id).catch(() => ({}));
  if (state.current?.id !== c.id) return;
  log.innerHTML = messages.length ? messages.map((m) => msgHTML(m, 'chat')).join('')
    : `<div class="empty">No one's said anything yet.<br>Start the chat for ${esc(c.name)}.</div>`;
  log.scrollTop = log.scrollHeight;
  updateViewers();
}
function updateViewers() {
  const n = state.current ? lastPresence.filter((p) => p.watching?.id === state.current.id).length : 0;
  $('#viewerCount').textContent = n ? `· ${n} watching` : '';
}
$('#roomForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#roomInput');
  const text = input.value.trim();
  if (!text || !state.current || !ensureName()) return;
  const r = await api('/api/chat', { secret: me.secret, name: me.name, text, room: state.current.id });
  if (r.error) return toast(r.error);
  input.value = '';
};
function setPane(name) {
  $$('.ptabs button').forEach((b) => b.classList.toggle('active', b.dataset.ptab === name));
  $('#pane-room').classList.toggle('hidden', name !== 'room');
  $('#pane-comments').classList.toggle('hidden', name !== 'comments');
  store.set('pane', name);
  if (name === 'room') $('#roomLog').scrollTop = $('#roomLog').scrollHeight;
}
$$('.ptabs button').forEach((b) => (b.onclick = () => setPane(b.dataset.ptab)));
setPane(store.get('pane', 'room'));

// ----- live chat -----
function scrollChat(force) {
  const log = $('#chatLog');
  if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 120) log.scrollTop = log.scrollHeight;
}
function updateChatDot() {
  const dot = $('#chatDot');
  dot.textContent = chatUnread > 99 ? '99+' : chatUnread;
  dot.classList.toggle('hidden', !chatUnread);
}
async function loadChat() {
  const { messages, online } = await api('/api/chat');
  $('#chatLog').innerHTML = messages.length ? messages.map((m) => msgHTML(m, 'chat')).join('')
    : '<div class="empty" id="chatEmpty">No messages yet. Say hi 👋</div>';
  lastPresence = online; renderOnline(online); updateViewers();
  chatLoaded = true;
  scrollChat(true);
}
function renderOnline(people) {
  $('#onlineCount').textContent = people.length;
  $('#onlineList').innerHTML = people.map((p) => `<div class="person">${esc(p.name)}
    ${p.watching ? `<div class="pw">watching <button class="chtag" data-watch="${p.watching.id}">${p.watching.flag ? p.watching.flag + ' ' : ''}${esc(p.watching.name)}</button></div>` : ''}</div>`).join('');
}
$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !ensureName()) return;
  const watching = $('#chatAttach').checked ? state.current?.id : null;
  const r = await api('/api/chat', { secret: me.secret, name: me.name, text, watching });
  if (r.error) return toast(r.error);
  input.value = '';
};
$('#changeName').onclick = () => ensureName(true);

// Tune in from a chat tag; delete own posts.
document.addEventListener('click', async (e) => {
  const tag = e.target.closest('[data-watch]');
  if (tag) { const c = state.byId.get(tag.dataset.watch); if (c) play(c); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('Delete this message?')) return;
    const r = await api(`/api/${del.dataset.del}/delete`, { secret: me.secret, id: del.dataset.id, channel: del.dataset.channel, room: del.dataset.room });
    if (r.error) toast(r.error);
  }
});

// ----- real-time updates -----
function connectEvents() {
  const q = new URLSearchParams({ secret: me.secret, name: me.name || 'Guest', watching: state.current?.id || '' });
  const es = new EventSource('/api/events?' + q);
  es.addEventListener('chat', (e) => {
    const m = JSON.parse(e.data);
    if (m.room && m.room !== 'global') {
      if (state.current?.id !== m.room) return;
      const log = $('#roomLog');
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      $('.empty', log)?.remove();
      log.insertAdjacentHTML('beforeend', msgHTML(m, 'chat'));
      if (atBottom || m.author === me.author) log.scrollTop = log.scrollHeight;
      return;
    }
    if (!chatLoaded) return;
    $('#chatEmpty')?.remove();
    $('#chatLog').insertAdjacentHTML('beforeend', msgHTML(m, 'chat'));
    scrollChat(m.author === me.author);
    if (state.view !== 'chat' && m.author !== me.author) { chatUnread++; updateChatDot(); }
  });
  es.addEventListener('chat-delete', (e) => $$(`#chatLog [data-mid="${JSON.parse(e.data).id}"], #roomLog [data-mid="${JSON.parse(e.data).id}"]`).forEach((el) => el.remove()));
  es.addEventListener('comment', (e) => {
    const m = JSON.parse(e.data);
    if (state.current?.id !== m.channel) return;
    $('#commentList .empty')?.remove();
    $('#commentList').insertAdjacentHTML('afterbegin', msgHTML(m, 'comments'));
    $('#cCount').textContent = $$('#commentList .msg').length;
  });
  es.addEventListener('comment-delete', (e) => {
    $(`#commentList [data-mid="${JSON.parse(e.data).id}"]`)?.remove();
    $('#cCount').textContent = $$('#commentList .msg').length || '';
  });
  es.addEventListener('presence', (e) => { lastPresence = JSON.parse(e.data); renderOnline(lastPresence); updateViewers(); });
  // EventSource reconnects by itself; refresh state when it does.
  es.onopen = () => { sayHello(); if (chatLoaded) loadChat(); if (state.current) loadRoom(state.current); };
}

// ---------- sharing ----------
let serverInfo = { lan: false, lanUrls: [] };

function shareUrl(c, base) {
  return `${base}/?watch=${c.id}&n=${encodeURIComponent(c.name)}${c.country ? '&c=' + c.country : ''}`;
}

function renderShare() {
  const c = state.current;
  if (!c) return;
  const base = serverInfo.lanUrls[0] || location.origin;
  $('#shareLink').value = shareUrl(c, base);
  $('#shareM3u').href = `/share/${c.id}.m3u`;
  $('#copyStream').disabled = false;
  $('#shareHint').innerHTML = serverInfo.lan
    ? 'Friends on the same Wi‑Fi can open this link and watch straight away. For anyone else, send them the VLC file.'
    : 'This link opens the channel for friends who run Uni TV. For everyone else, send the VLC file, which plays in VLC, IINA or most media players. To let friends on your Wi‑Fi use the link, start the app with <code>LAN=1 npm start</code>.';
  $('#nativeShare').classList.toggle('hidden', !navigator.share);
}

async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { $('#shareLink').select(); document.execCommand('copy'); toast(msg); }
}

$('#pShare').onclick = () => {
  const panel = $('#sharePanel');
  panel.classList.toggle('hidden');
  $('#pShare').classList.toggle('on', !panel.classList.contains('hidden'));
  renderShare();
};
$('#copyLink').onclick = () => copy($('#shareLink').value, 'Link copied');
$('#copyStream').onclick = () => state.current && copy(state.current.url, 'Stream URL copied. Paste it into VLC → Open Network.');
$('#shareLink').onclick = (e) => e.target.select();
$('#nativeShare').onclick = async () => {
  const c = state.current;
  const file = await fetch(`/share/${c.id}.m3u`).then((r) => r.blob()).then((b) => new File([b], `${c.name}.m3u`, { type: 'audio/x-mpegurl' })).catch(() => null);
  const data = { title: c.name, text: `Watch ${c.name}${c.flag ? ' ' + c.flag : ''} with me`, url: $('#shareLink').value };
  if (file && navigator.canShare?.({ files: [file] })) data.files = [file];
  navigator.share(data).catch(() => {});
};

// Open a shared link: ?watch=<id>&n=<name>&c=<country>
function openSharedLink() {
  const q = new URLSearchParams(location.search);
  const id = q.get('watch');
  if (!id) return;
  let c = state.byId.get(id);
  if (!c && q.get('n')) {
    // Different playlist: fall back to the best channel with the same name (and country, if given).
    const name = q.get('n').toLowerCase(), country = q.get('c');
    const hits = state.channels.filter((x) => x.name.toLowerCase() === name && x.play && (!country || !x.country || x.country === country));
    c = hits.length ? rankGroup(hits)[0] : null;
  }
  if (c) play(c);
  else toast(`Couldn’t find “${q.get('n') || 'that channel'}” in this playlist.`, 5000);
}

function toggleFav(id) {
  state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
  store.set('favs', [...state.favs]);
  if (state.current?.id === id) renderPlayerInfo();
  if (state.view === 'browse') drawRows();
}

$('#pClose').onclick = closePlayer;
$('#pPrev').onclick = () => zap(-1);
$('#pNext').onclick = () => zap(1);
$('#pFav').onclick = () => state.current && toggleFav(state.current.id);
$('#pFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('.screen').requestFullscreen());
$('#pPip').onclick = () => {
  const p = document.pictureInPictureElement ? document.exitPictureInPicture() : video.requestPictureInPicture?.();
  p?.catch(() => toast('Picture in picture isn’t available here.'));
};
$('#pQuality').onchange = (e) => { if (hls) hls.currentLevel = parseInt(e.target.value, 10); };
$('#pVariants').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) play(state.byId.get(b.dataset.id)); };
video.addEventListener('dblclick', () => $('#pFull').click());

// ---------- recording ----------
const recorder = {
  active: null, // { mr, kind, id, file, started, bytes, queue, limitTimer }

  pickMime(kind) {
    const options = kind === 'audio'
      ? [['audio/mp4;codecs=mp4a.40.2', 'm4a'], ['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'weba'], ['audio/webm', 'weba']]
      : [['video/mp4;codecs=avc1.640028,mp4a.40.2', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm', 'webm']];
    return options.find(([m]) => MediaRecorder.isTypeSupported(m)) || ['', kind === 'audio' ? 'weba' : 'webm'];
  },

  async start(kind) {
    if (this.active) return;
    const c = state.current;
    if (!c || video.readyState < 2) return toast('Wait for the channel to start playing first.');
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture || !window.MediaRecorder) return toast('Recording needs Chrome, Edge, Arc or Firefox — this browser can’t capture video.', 5000);
    const full = capture.call(video);
    const stream = kind === 'audio' ? new MediaStream(full.getAudioTracks()) : full;
    if (kind === 'audio' && !stream.getAudioTracks().length) return toast('This channel has no audio track.');
    if (kind === 'video' && !full.getVideoTracks().length) return toast('No video track to record.');

    const [mime, ext] = this.pickMime(kind);
    const { id, file, error } = await api('/api/rec/start', { channel: c.name, kind, ext });
    if (error) return toast(error);
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6, audioBitsPerSecond: 192e3 } : {});
    const rec = { mr, kind, id, file, started: Date.now(), bytes: 0, queue: Promise.resolve() };
    mr.ondataavailable = (e) => {
      if (!e.data.size) return;
      rec.bytes += e.data.size;
      rec.queue = rec.queue.then(() => fetch(`/api/rec/${id}/chunk`, { method: 'POST', body: e.data })).catch(() => {});
    };
    rec.done = new Promise((resolve) => (mr.onstop = resolve));
    mr.start(2000);
    const mins = parseInt($('#recLimit').value, 10);
    if (mins) rec.limitTimer = setTimeout(() => this.stop(), mins * 60000);
    rec.tick = setInterval(() => this.render(), 500);
    this.active = rec;
    this.render();
    toast(`Recording ${kind === 'audio' ? 'audio' : 'video'}…`);
  },

  async stop() {
    const rec = this.active;
    if (!rec) return;
    clearTimeout(rec.limitTimer);
    clearInterval(rec.tick);
    if (rec.mr.state !== 'inactive') rec.mr.stop();
    await rec.done;
    await rec.queue;
    await api(`/api/rec/${rec.id}/stop`, {});
    this.active = null;
    this.render(rec);
    refreshRecCount();
    if (state.view === 'recordings') renderRecordings();
  },

  toggle(kind) { this.active ? (this.active.kind === kind ? this.stop() : toast('Already recording — stop first.')) : this.start(kind); },

  render(finished) {
    const rec = this.active;
    $('#recVideo').classList.toggle('active', rec?.kind === 'video');
    $('#recAudio').classList.toggle('active', rec?.kind === 'audio');
    $('#recVideo').lastChild.textContent = rec?.kind === 'video' ? 'Stop' : 'Video';
    $('#recAudio').lastChild.textContent = rec?.kind === 'audio' ? 'Stop' : 'Audio only';
    $('#recLimit').disabled = !!rec;
    $('#recBadge').classList.toggle('hidden', !rec);
    if (rec) {
      const t = fmtTime((Date.now() - rec.started) / 1000);
      $('#recText').textContent = `REC ${t}`;
      $('#recStatus').textContent = `${rec.kind === 'audio' ? 'Audio' : 'Video'} · ${t} · ${fmtBytes(rec.bytes)}` +
        (rec.limitTimer ? ` · stops after ${$('#recLimit').selectedOptions[0].text}` : '');
    } else if (finished) {
      $('#recStatus').innerHTML = `Saved <a href="/recordings/${encodeURIComponent(finished.file)}" download>${esc(finished.file)}</a>`;
    }
  },
};
$('#recVideo').onclick = () => recorder.toggle('video');
$('#recAudio').onclick = () => recorder.toggle('audio');
window.addEventListener('beforeunload', (e) => { if (recorder.active) { e.preventDefault(); e.returnValue = ''; } });

// ---------- scanning ----------
let scanPoll = null;
async function pollScan() {
  const s = await api('/api/scan');
  const btn = $('#scanBtn');
  if (s.running) {
    btn.textContent = `Scanning ${s.done.toLocaleString()}/${s.total.toLocaleString()} · ${s.ok.toLocaleString()} live`;
    if (s.done % 400 < 40) state.health = await api('/api/health');
    scanPoll = setTimeout(pollScan, 1500);
  } else {
    scanPoll = null;
    btn.textContent = 'Scan streams';
    if (s.total) {
      state.health = await api('/api/health');
      toast(`Scan finished: ${s.ok.toLocaleString()} of ${s.total.toLocaleString()} streams are live.`, 5000);
      if (state.view === 'browse') renderBrowse();
    }
  }
}
$('#scanBtn').onclick = async () => {
  if (scanPoll) return toast('Already scanning…');
  const fresh = Object.keys(state.health).length > 0 && confirm('Re-check every stream, including ones checked recently?\n\nOK = full re-check, Cancel = only unchecked/stale ones.');
  await api('/api/scan', { force: fresh });
  toast('Checking all streams in the background — this takes a few minutes.');
  pollScan();
};

// ---------- events ----------
$$('.tabs button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    if (state.view !== 'browse') setView('browse'); else renderBrowse();
  }, 150);
});

function saveFilters() { store.set('filters', state.filters); renderBrowse(); }
$$('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  state.filters[seg.dataset.filter] = b.dataset.v; syncFilterUI(); saveFilters();
}));
$$('[data-opt]').forEach((i) => (i.onchange = () => { state.filters[i.dataset.opt] = i.checked; saveFilters(); }));
$('#sort').onchange = (e) => { state.filters.sort = e.target.value; saveFilters(); };
$('#countrySel').onchange = (e) => { state.filters.country = e.target.value; saveFilters(); };
$('#langSel').onchange = (e) => { state.filters.language = e.target.value; saveFilters(); };
$('#catChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]'); if (!b) return;
  const cats = state.filters.cats, cat = b.dataset.cat;
  state.filters.cats = cats.includes(cat) ? cats.filter((x) => x !== cat) : [...cats, cat];
  b.classList.toggle('active'); saveFilters();
});
$('#clearCats').onclick = () => { state.filters.cats = []; renderCatChips(); saveFilters(); };

$('#list').addEventListener('scroll', () => requestAnimationFrame(drawRows));
$('#list').addEventListener('click', (e) => {
  const fav = e.target.closest('[data-fav]');
  if (fav) return toggleFav(fav.dataset.fav);
  const row = e.target.closest('.lrow');
  if (row) play(state.byId.get(row.dataset.id), browseList);
});

$('#view-curated').addEventListener('click', (e) => {
  const seeAll = e.target.closest('[data-browse]');
  if (seeAll) {
    state.filters.cats = seeAll.dataset.browse ? [seeAll.dataset.browse] : [];
    state.filters.country = seeAll.dataset.browseCountry || '';
    state.filters.status = 'notdead';
    renderCatChips(); syncFilterUI(); store.set('filters', state.filters);
    return setView('browse');
  }
  const shuffle = e.target.closest('[data-reshuffle]');
  if (shuffle) {
    const row = shuffle.closest('.row');
    $('.strip', row).innerHTML = '<div class="skeleton"></div>'.repeat(6);
    return fillRow(row, parseInt(row.dataset.offset || '0', 10));
  }
  const card = e.target.closest('.card');
  if (card) {
    const strip = card.closest('.strip');
    const list = $$('.card', strip).map((x) => state.byId.get(x.dataset.id));
    play(state.byId.get(card.dataset.id), list);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('#search').focus(); }
  if (!state.current) return;
  if (k === 'ArrowDown' || k === 'ArrowRight') { e.preventDefault(); zap(1); }
  else if (k === 'ArrowUp' || k === 'ArrowLeft') { e.preventDefault(); zap(-1); }
  else if (k === 'f') $('#pFull').click();
  else if (k === 'm') video.muted = !video.muted;
  else if (k === 't') document.body.classList.toggle('theater');
  else if (k === 's') toggleFav(state.current.id);
  else if (k === 'r') recorder.toggle('video');
  else if (k === 'a') recorder.toggle('audio');
  else if (k === 'Escape' && !document.fullscreenElement) closePlayer();
});

load().then(() => {
  $('#myName').textContent = me.name || 'set a name';
  connectEvents();
  loadChat();
  openSharedLink();
  api('/api/info').then((i) => (serverInfo = i)).catch(() => {});
  api('/api/scan').then((s) => s.running && pollScan());
});
