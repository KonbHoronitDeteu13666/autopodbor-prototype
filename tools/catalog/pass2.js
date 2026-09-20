// Second pass. The first pass dropped every model whose slug is a number
// (Peugeot 308, Mazda 6, Tank 300 ...) and silently kept empty results for
// brands whose page failed to load. This refetches each brand page, finds the
// models missing from brands/<slug>.json, fetches only those model pages and
// merges them in.
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const DIR = __dirname;
const OUT = path.join(DIR, 'brands');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const DELAY = Number(process.env.DELAY || 900);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function get(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ru,en;q=0.9', 'Accept-Encoding': 'gzip, deflate' },
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

// a generation id is a long number; a model slug like "308" or "6" is not
const isGenId = slug => /^\d{6,}$/.test(slug);

function parseModels(html, brand) {
  const seen = new Map();
  const re = new RegExp('/catalog/cars/' + brand + '/([a-z0-9_-]+)/"[^>]*>([^<]{1,60})', 'g');
  let m;
  while ((m = re.exec(html))) {
    if (isGenId(m[1])) continue;
    if (!seen.has(m[1])) seen.set(m[1], unescape(m[2]));
  }
  const re2 = new RegExp('/catalog/cars/' + brand + '/([a-z0-9_-]+)/', 'g');
  while ((m = re2.exec(html))) {
    if (isGenId(m[1])) continue;
    if (!seen.has(m[1])) seen.set(m[1], '');
  }
  return [...seen].map(([slug, name]) => ({ slug, name }));
}

const BODIES = ['Седан', 'Универсал', 'Хэтчбек', 'Лифтбек', 'Купе', 'Кабриолет', 'Родстер',
  'Внедорожник', 'Кроссовер', 'Минивэн', 'Компактвэн', 'Пикап', 'Фургон', 'Микроавтобус', 'Тарга', 'Лимузин'];

function parseBody(html) {
  let best = '', bestN = 0;
  for (const b of BODIES) {
    const n = (html.match(new RegExp(b, 'g')) || []).length;
    if (n > bestN) { bestN = n; best = b; }
  }
  return bestN ? best.toLowerCase() : '';
}

function parseGenerations(html) {
  const out = [];
  const seen = new Set();
  const re = /CatalogGenerationsListItem__title-[\w-]+">([^<]*)<span class="CatalogGenerationsListItem__name-[\w-]+">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const years = unescape(m[1]);
    const name = unescape(m[2].replace(/<[^>]*>/g, ''));
    if (!years && !name) continue;
    const k = years + '|' + name;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ years, name });
  }
  return out;
}

async function main() {
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.json')).sort();
  const shardN = Number(process.env.SHARD_N || 1);
  const shardI = Number(process.env.SHARD_I || 0);
  const donePath = path.join(DIR, 'pass2-done-' + shardI + '.txt');
  const done = new Set(fs.existsSync(donePath) ? fs.readFileSync(donePath, 'utf8').split('\n').filter(Boolean) : []);

  let idx = -1;
  for (const f of files) {
    idx++;
    if (shardN > 1 && idx % shardN !== shardI) continue;
    const file = path.join(OUT, f);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (done.has(rec.slug)) continue;

    let brandHtml;
    try {
      const r = await get(`https://auto.ru/catalog/cars/${rec.slug}/`);
      if (r.status === 429 || r.status === 403) { console.error('blocked at ' + rec.slug); process.exit(2); }
      if (r.status !== 200) { console.error(`BRAND ${rec.slug} status ${r.status}`); continue; }
      brandHtml = r.body;
    } catch (e) {
      console.error(`BRAND ${rec.slug} error ${e.message}`);
      continue;
    }
    await sleep(DELAY);

    const have = new Set(rec.models.map(m => m.slug));
    const missing = parseModels(brandHtml, rec.slug).filter(m => !have.has(m.slug));

    for (const mo of missing) {
      try {
        const r = await get(`https://auto.ru/catalog/cars/${rec.slug}/${mo.slug}/`);
        if (r.status === 429 || r.status === 403) { console.error('blocked at ' + rec.slug + '/' + mo.slug); process.exit(2); }
        mo.generations = r.status === 200 ? parseGenerations(r.body) : [];
        mo.body = r.status === 200 ? parseBody(r.body) : '';
        if (!mo.name && r.status === 200) {
          const t = r.body.match(/<title>([^<]*)<\/title>/);
          if (t) mo.name = unescape(t[1]).split(/ [-–—] /)[0];
        }
      } catch (e) {
        mo.generations = [];
        mo.body = '';
        console.error(`MODEL ${rec.slug}/${mo.slug} error ${e.message}`);
      }
      await sleep(DELAY);
    }

    if (missing.length) {
      rec.models = rec.models.concat(missing);
      fs.writeFileSync(file, JSON.stringify(rec, null, 1));
    }
    fs.appendFileSync(donePath, rec.slug + '\n');
    const added = missing.filter(m => m.generations && m.generations.length).length;
    console.log(`${rec.slug}\t+${added} models recovered (${missing.length} checked)`);
  }
  console.log('PASS2 DONE');
}

main().catch(e => { console.error(e); process.exit(1); });
