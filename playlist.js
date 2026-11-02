// Parses the M3U playlist into clean channel objects and infers categories from names.
const fs = require('fs');
const crypto = require('crypto');

const CATEGORY_RULES = [
  ['News', /\b(news|noticias|nachrichten|notizie|nieuws|novosti|haber|actualit\w*|info|cnn|bbc world|al ?jazeera|euronews|france ?24|dw|sky ?news|cgtn|trt world|nhk world|rt|tg ?24|ndtv|aaj tak|24 ?h|24\/7 news|abc news|cbs news|nbc news|newsmax|telesur|journal|press ?tv|i24|wion)\b/],
  ['Sports', /\b(sports?|espn|bein|golf|tennis|nba|nfl|mlb|nhl|fight\w*|wrestling|racing|motor\w*|f1|futbol|f[uú]tbol|football|soccer|deportes?|cricket|olymp\w*|eurosport|dazn|ufc|boxing|bike|ski|surf|outdoor|fishing|hunting|horse|billiard|poker|esports?)\b/],
  ['Music', /\b(music|musica|música|musik|mtv|hits|radio|fm|vh1|clubbing|jazz|rock|pop|country|classical|concerts?|clips?|vevo|melody|tunes|beats|hip ?hop|rap|reggae|salsa|latino|dance|disco|karaoke|songs?|bollywood hits|afro)\b/],
  ['Kids', /\b(kids?|junior|cartoons?|toons?|disney|nick\w*|baby|babies|children|anime|enfants?|infantil|kinder|boomerang|teletubbies|pbs kids|family|animation)\b/],
  ['Movies', /\b(movies?|cinema|cin[eé]|films?|kino|pel[ií]culas?|hollywood|bollywood|action|thriller|horror|western|filmes?|cinemax|hbo)\b/],
  ['Entertainment', /\b(entertainment|series|comedy|drama|sitcoms?|novelas?|telenovelas?|reality|classic tv|retro|replay|shows?|tv land|game ?show|talk)\b/],
  ['Documentary', /\b(docu\w*|discovery|nature|wild\w*|history|histoire|science|planet|nat ?geo|explore\w*|earth|animals?|space|nasa|smithsonian|curiosity|knowledge)\b/],
  ['Lifestyle', /\b(food|cook\w*|kitchen|fashion|home|garden|lifestyle|travel|auto|cars?|design|health|fitness|yoga|wellness|pets?)\b/],
  ['Religious', /\b(church|christ\w*|gospel|god|jesus|bible|catholic|islam\w*|quran|coran|sunnah|makkah|madinah|iman|hindu|bhakti|sanskar|aastha|shalom|faith|ewtn|tbn|hope|daystar|worship|prayer|prophet|messiah|miracle|angel|torah|dharma|sikh|gurbani|vatican|ministr\w*|evangel\w*|apostolic|holy|spirit)\b/],
  ['Business', /\b(business|finance|financial|markets?|bloomberg|cnbc|money|economy|econom\w*|trade|stocks?|invest\w*)\b/],
  ['Weather', /\b(weather|meteo|wetter|clima|tiempo)\b/],
  ['Shop', /\b(shop\w*|qvc|hsn|teleshopping|deals?|store)\b/],
  ['Education', /\b(edu\w*|university|universidad|school|learn\w*|college|academy|parliament|senate|congress|c-span|government|gov)\b/],
];

const GROUP_MAP = {
  movies: 'Movies', entertainment: 'Entertainment', news: 'News', sports: 'Sports', music: 'Music',
  kids: 'Kids', animation: 'Animation', documentary: 'Documentary', religious: 'Religious', lifestyle: 'Lifestyle',
  business: 'Business', weather: 'Weather', shop: 'Shop', education: 'Education', comedy: 'Comedy',
  series: 'Series', classic: 'Classic', family: 'Family', cooking: 'Cooking', travel: 'Travel',
  outdoor: 'Outdoor', auto: 'Auto', science: 'Science', culture: 'Culture', general: 'General',
};

function categorize(name, group) {
  const cats = new Set();
  if (group) {
    for (const part of group.toLowerCase().split(/[;,/]/)) {
      const mapped = GROUP_MAP[part.trim()];
      if (mapped && mapped !== 'General') cats.add(mapped);
    }
  }
  const n = ' ' + name.toLowerCase() + ' ';
  for (const [cat, re] of CATEGORY_RULES) if (re.test(n)) cats.add(cat);
  if (!cats.size) cats.add('General');
  return [...cats];
}

function streamType(url) {
  if (/^(rtmp|rtsp|mms|mmsh|udp|rtp):/i.test(url)) return 'unsupported';
  if (/\.mpd(\?|$)/i.test(url)) return 'dash';
  return 'hls';
}

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const channels = [];
  const seen = new Set();
  let info = null;
  let opts = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      info = line.slice(line.indexOf(',') + 1);
      opts = {};
      // Some entries carry attributes in the display part
      const attr = (k) => (line.match(new RegExp(k + '="([^"]*)"')) || [])[1];
      opts.logo = attr('tvg-logo');
      opts.groupAttr = attr('group-title');
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const [k, ...v] = line.slice(11).split('=');
      const val = v.join('=');
      if (k === 'http-referrer') opts.referrer = val;
      if (k === 'http-user-agent') opts.userAgent = val;
    } else if (!line.startsWith('#') && info !== null) {
      const url = line;
      let display = info;
      let group = opts.groupAttr;
      const gm = display.match(/group-title="([^"]*)"\s*-\s*(.*)$/);
      if (gm) { group = gm[1]; display = gm[2]; }

      const tags = [...display.matchAll(/\[+([^\]]+)\]/g)].map((m) => m[1].trim());
      const resMatch = display.match(/\((\d{3,4})p\)/i);
      const name = display
        .replace(/\[+[^\]]*\]/g, '')
        .replace(/\(\d{3,4}p\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim() || 'Unnamed';

      const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
      if (!seen.has(id)) {
        seen.add(id);
        channels.push({
          id,
          name,
          url,
          height: resMatch ? parseInt(resMatch[1], 10) : 0,
          geo: tags.some((t) => /geo-blocked/i.test(t)),
          partTime: tags.some((t) => /not 24\/7/i.test(t)),
          tags,
          group: group && group !== 'Undefined' ? group : null,
          categories: categorize(name, group),
          type: streamType(url),
          logo: opts.logo || null,
          referrer: opts.referrer || null,
          userAgent: opts.userAgent || null,
          key: name.toLowerCase().replace(/\b(hd|fhd|uhd|sd|4k)\b/g, '').replace(/[^a-z0-9+]+/g, ' ').trim(),
        });
      }
      info = null;
      opts = {};
    }
  }
  return channels;
}

module.exports = { parse };
