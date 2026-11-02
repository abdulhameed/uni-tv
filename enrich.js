// Enriches parsed channels with metadata from the iptv-org database
// (https://github.com/iptv-org/api): country, languages, categories and logos.
// Data is cached in data/iptv-org and refreshed weekly.
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://iptv-org.github.io/api/';
const FILES = ['channels', 'streams', 'logos', 'countries', 'categories', 'languages', 'feeds'];
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url}: HTTP ${res.statusCode}`)); }
      const tmp = dest + '.tmp';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => fs.rename(tmp, dest, (e) => (e ? reject(e) : resolve())));
      out.on('error', reject);
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

async function ensureData(dir) {
  fs.mkdirSync(dir, { recursive: true });
  await Promise.all(FILES.map(async (f) => {
    const file = path.join(dir, f + '.json');
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(file).mtimeMs < MAX_AGE; } catch {}
    if (fresh) return;
    try { await download(BASE + f + '.json', file); }
    catch (e) { if (!fs.existsSync(file)) throw e; console.warn('Using cached', f, '-', e.message); }
  }));
  const data = {};
  for (const f of FILES) data[f] = JSON.parse(fs.readFileSync(path.join(dir, f + '.json'), 'utf8'));
  return data;
}

const normUrl = (u) => u.replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
const normName = (s) => s.toLowerCase().replace(/\b(hd|fhd|uhd|sd|4k|tv)\b/g, '').replace(/[^\p{L}\p{N}+]+/gu, '');

// Country-code TLDs that differ from the ISO code, and ccTLDs used generically
const TLD_FIX = { gb: 'UK' }; // iptv-org uses UK for the United Kingdom
const VANITY = new Set(['tv', 'me', 'co', 'io', 'fm', 'ws', 'cc', 'to', 'la', 'st', 'ai', 'ly', 'gg', 'am', 'is', 'nu', 'tk', 'ml', 'ga', 'cf', 'gq', 'su', 'ag', 'sh', 'vc', 'gd', 'eu', 'id']);
function tldCountry(url) {
  try {
    const tld = new URL(url).hostname.split('.').pop().toLowerCase();
    if (tld.length !== 2 || VANITY.has(tld)) return null;
    return TLD_FIX[tld] || tld.toUpperCase();
  } catch { return null; }
}

async function enrich(channels, dir) {
  const d = await ensureData(dir);

  const chanById = new Map(d.channels.map((c) => [c.id, c]));
  const countries = new Map(d.countries.map((c) => [c.code, c]));
  const languages = new Map(d.languages.map((l) => [l.code, l.name]));
  const categories = new Map(d.categories.map((c) => [c.id, c.name]));

  const byUrl = new Map();
  const feedOf = new Map();
  for (const s of d.streams) {
    if (!s.channel) continue;
    byUrl.set(normUrl(s.url), s.channel);
    if (s.feed) feedOf.set(normUrl(s.url), s.feed);
  }

  const byName = new Map();
  for (const c of d.channels) {
    for (const n of [c.name, ...(c.alt_names || [])]) {
      const k = normName(n);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, []);
      if (!byName.get(k).includes(c.id)) byName.get(k).push(c.id);
    }
  }

  const logos = new Map();
  for (const l of d.logos) {
    if (l.feed || !l.url) continue;
    const prev = logos.get(l.channel);
    // Prefer in-use, modest-size raster logos
    const score = (x) => (x.in_use ? 1000 : 0) + (x.format === 'SVG' ? 0 : 500) - Math.abs((x.width || 300) - 300) / 10;
    if (!prev || score(l) > score(prev)) logos.set(l.channel, l);
  }

  const feedLangs = new Map();
  for (const f of d.feeds) {
    if (!f.languages?.length) continue;
    feedLangs.set(f.channel + '/' + f.id, f.languages);
    if (f.is_main) feedLangs.set(f.channel, f.languages);
  }

  let matched = 0;
  for (const c of channels) {
    let id = byUrl.get(normUrl(c.url));
    if (!id) {
      const candidates = byName.get(normName(c.name)) || [];
      if (candidates.length === 1) id = candidates[0];
      else if (candidates.length > 1) {
        const cc = tldCountry(c.url);
        const hit = cc && candidates.filter((x) => chanById.get(x)?.country === cc);
        if (hit && hit.length === 1) id = hit[0];
      }
    }
    // Country is still useful from the TLD even without a match
    let country = null;
    const meta = id && chanById.get(id);
    if (meta) {
      matched++;
      country = meta.country;
      const cats = (meta.categories || []).map((x) => categories.get(x)).filter(Boolean);
      if (cats.length) c.categories = cats.filter((x) => x !== 'XXX');
      c.nsfw = !!meta.is_nsfw || (meta.categories || []).includes('xxx');
      c.closed = !!meta.closed;
      c.website = meta.website || null;
      c.iptvId = id;
      const feed = feedOf.get(normUrl(c.url));
      c.languages = (feedLangs.get(id + '/' + feed) || feedLangs.get(id) || []).map((l) => languages.get(l) || l);
      if (!c.logo && logos.has(id)) c.logo = logos.get(id).url;
    } else {
      const cc = tldCountry(c.url);
      if (cc && countries.has(cc)) country = cc;
    }
    if (country && countries.has(country)) {
      c.country = country;
      c.countryName = countries.get(country).name;
      c.flag = countries.get(country).flag;
      if (!c.languages?.length) c.languages = (countries.get(country).languages || []).slice(0, 1).map((l) => languages.get(l) || l);
    }
  }
  return matched;
}

module.exports = { enrich };
