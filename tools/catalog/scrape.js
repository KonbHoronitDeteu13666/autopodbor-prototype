// Scrapes auto.ru public catalog HTML pages: brands -> models -> generations.
// Polite: sequential requests with a delay, resumable via per-brand JSON cache.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const DIR = __dirname;
const OUT = path.join(DIR, 'brands');
fs.mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DELAY = Number(process.env.DELAY || 900);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
      timeout: 45000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, tries));
      }
      const enc = res.headers['content-encoding'];
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', async err => {
      if (tries > 1) { await sleep(3000); resolve(get(url, tries - 1)); }
      else reject(err);
    });
    req.end();
  });
}

const unescape = s => s
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function parseModels(html, brand) {
  const seen = new Map();
  const re = new RegExp('/catalog/cars/' + brand + '/([a-z0-9_-]+)/"[^>]*>([^<]{1,60})', 'g');
  let m;
  while ((m = re.exec(html))) {
    const [, slug, name] = m;
    if (/^\d+$/.test(slug)) continue;
    if (!seen.has(slug)) seen.set(slug, unescape(name));
  }
  // slugs that appeared without readable anchor text
  const re2 = new RegExp('/catalog/cars/' + brand + '/([a-z0-9_-]+)/', 'g');
  while ((m = re2.exec(html))) {
    if (/^\d+$/.test(m[1])) continue;
    if (!seen.has(m[1])) seen.set(m[1], '');
  }
  return [...seen].map(([slug, name]) => ({ slug, name }));
}

const BODIES = ["Седан","Универсал","Хэтчбек","Лифтбек","Купе","Кабриолет","Родстер","Внедорожник","Кроссовер","Минивэн","Компактвэн","Пикап","Фургон","Микроавтобус","Тарга","Лимузин"];

function parseBody(html) {
  let best = "", bestN = 0;
  for (const b of BODIES) {
    const n = (html.match(new RegExp(b, "g")) || []).length;
    if (n > bestN) { bestN = n; best = b; }
  }
  return bestN ? best.toLowerCase() : "";
}

function parseGenerations(html) {
  const out = [];
  const re = /CatalogGenerationsListItem__title-[\w-]+">([^<]*)<span class="CatalogGenerationsListItem__name-[\w-]+">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const years = unescape(m[1]);
    const name = unescape(m[2].replace(/<[^>]*>/g, ''));
    if (!years && !name) continue;
    out.push({ years, name });
  }
  const uniq = [];
  const seen = new Set();
  for (const g of out) {
    const k = g.years + '|' + g.name;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(g);
  }
  return uniq;
}

async function main() {
  const brands = fs.readFileSync(path.join(DIR, 'brandnames.txt'), 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { const [slug, name] = l.split('\t'); return { slug, name }; });

  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
  const shardN = Number(process.env.SHARD_N || 1);
  const shardI = Number(process.env.SHARD_I || 0);
  let idx = -1;

  for (const b of brands) {
    idx++;
    if (shardN > 1 && idx % shardN !== shardI) continue;
    if (only && !only.has(b.slug)) continue;
    const file = path.join(OUT, b.slug + '.json');
    if (fs.existsSync(file)) continue;

    let rec = { slug: b.slug, name: b.name, models: [] };
    try {
      const r = await get(`https://auto.ru/catalog/cars/${b.slug}/`);
      if (r.status !== 200) {
        console.error(`BRAND ${b.slug} status ${r.status}`);
        if (r.status === 429 || r.status === 403) { console.error('blocked, stopping'); process.exit(2); }
      } else {
        rec.models = parseModels(r.body, b.slug);
      }
    } catch (e) {
      console.error(`BRAND ${b.slug} error ${e.message}`);
    }
    await sleep(DELAY);

    for (const mo of rec.models) {
      try {
        const r = await get(`https://auto.ru/catalog/cars/${b.slug}/${mo.slug}/`);
        if (r.status === 429 || r.status === 403) { console.error('blocked at ' + b.slug + '/' + mo.slug); process.exit(2); }
        mo.generations = r.status === 200 ? parseGenerations(r.body) : [];
        mo.body = r.status === 200 ? parseBody(r.body) : "";
        if (!mo.name) {
          const t = r.body.match(/<title>([^<]*)<\/title>/);
          if (t) mo.name = unescape(t[1]).split(/ [-–—] /)[0];
        }
      } catch (e) {
        mo.generations = [];
        console.error(`MODEL ${b.slug}/${mo.slug} error ${e.message}`);
      }
      await sleep(DELAY);
    }

    fs.writeFileSync(file, JSON.stringify(rec, null, 1));
    const gens = rec.models.reduce((s, m) => s + (m.generations ? m.generations.length : 0), 0);
    console.log(`${b.slug}\t${rec.models.length} models\t${gens} gens`);
  }
  console.log('DONE');
}

main().catch(e => { console.error(e); process.exit(1); });
