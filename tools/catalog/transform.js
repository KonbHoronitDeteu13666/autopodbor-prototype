// Turns the scraped brands/*.json into the prototype's catalog.js format:
// ["Марка", [ ["Модель", "кузов", [["Поколение", "годы"], ...]] ]]
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SRC = path.join(DIR, 'brands');

function parseYears(s) {
  const nums = (s.match(/\d{4}/g) || []).map(Number);
  if (!nums.length) return null;
  const open = /^c\s|по н|наст|^с\s/i.test(s) || nums.length === 1;
  return { from: nums[0], to: open ? null : nums[nums.length - 1] };
}

// "V (W213, S213, C238) Рестайлинг 2" -> {key:"V (W213, S213, C238)", code:"W213"}
function genKey(name) {
  const base = name.replace(/\s*Рестайлинг\s*\d*\s*$/i, '').trim();
  const paren = base.match(/\(([^)]*)\)/);
  let code = '';
  if (paren) {
    code = paren[1].split(',')[0].trim();
  } else {
    code = base;
  }
  return { key: base, code: code || base };
}

function mergeGenerations(gens) {
  const byKey = new Map();
  for (const g of gens) {
    const { key, code } = genKey(g.name);
    const y = parseYears(g.years);
    if (!byKey.has(key)) byKey.set(key, { code, from: null, to: null, open: false });
    const rec = byKey.get(key);
    if (y) {
      rec.from = rec.from === null ? y.from : Math.min(rec.from, y.from);
      if (y.to === null) rec.open = true;
      else rec.to = rec.to === null ? y.to : Math.max(rec.to, y.to);
    }
  }
  // auto.ru sometimes lists one body code twice (market versions of the same
  // generation, e.g. Camry XV80) — those collapse into a single row
  const byCode = new Map();
  for (const rec of byKey.values()) {
    if (rec.from === null) continue;
    const code = rec.code || 'I';
    if (!byCode.has(code)) { byCode.set(code, { code, from: rec.from, to: rec.to, open: rec.open }); continue; }
    const cur = byCode.get(code);
    cur.from = Math.min(cur.from, rec.from);
    if (rec.open) cur.open = true;
    if (rec.to !== null) cur.to = cur.to === null ? rec.to : Math.max(cur.to, rec.to);
  }

  const out = [];
  for (const rec of byCode.values()) {
    // машин, снятых с производства до 1980 года, на вторичном рынке нет:
    // поколение, закончившееся раньше, в каталог не попадает. Поколения,
    // начавшиеся до 1980-го и выпускавшиеся дальше (Нива, «шестёрка»,
    // «буханка»), остаются
    const ended = rec.open ? null : rec.to;
    if (ended !== null && ended < 1980) continue;
    const years = rec.from + '–' + (rec.open || rec.to === null ? '…' : rec.to);
    out.push([rec.code, years]);
  }
  out.sort((a, b) => parseInt(a[1], 10) - parseInt(b[1], 10));
  return out;
}

// slugs that live under a brand page but are not models
const NOT_A_MODEL = new Set(['photo', 'engine', 'video', 'reviews', 'otzyvy', 'specifications',
  'equipment', 'gallery', 'all', 'used', 'new', 'stats', 'compare', 'dealers', 'history',
  'prices', 'body', 'transmission', 'drive', 'safety']);

// auto.ru's own spelling, adjusted to what the app already calls these brands
const BRAND_NAME = { vaz: 'Lada', volga: 'Волга' };

const q = s => '"' + String(s).replace(/"/g, '\\"') + '"';

// auto.ru labels many generations with a roman numeral only, while a data pack
// is keyed by the factory code (XV40, W211, JB). Where a pack covers a
// generation, the catalog row takes the pack's code — otherwise the app would
// show the same car twice: once with data, once as «Готовится».
function packRows() {
  const out = [];
  for (const f of ['packs.js', 'index.html']) {
    const p = path.join(PROTO, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    const re = /brand:"([^"]*)",\s*model:"([^"]*)",\s*gen:"([^"]*)",\s*years:"([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) out.push({ brand: m[1], model: m[2], gen: m[3], years: m[4] });
  }
  return out;
}

const yearSpan = s => {
  const n = (String(s).match(/\d{4}/g) || []).map(Number);
  if (!n.length) return null;
  return { from: n[0], to: n.length > 1 ? n[1] : (/…|\.\.\./.test(s) ? 9999 : n[0]) };
};

function applyPackCodes(brandsOut) {
  const index = new Map();
  for (const [brand, models] of brandsOut) {
    for (const m of models) index.set(norm(brand) + '|' + norm(m[0]), m);
  }
  const unmatched = [];
  const claimed = new Set();
  let renamed = 0, exact = 0, added = 0;
  // packs whose code the catalog already uses take their row first, so a
  // rename cannot steal a row another pack matches exactly
  const rest = [];
  for (const p of packRows()) {
    const m = index.get(norm(p.brand) + '|' + norm(p.model));
    if (!m) { unmatched.push(`${p.brand} / ${p.model} / ${p.gen} — модели нет в каталоге`); continue; }
    const same = m[2].find(g => norm(g[0]) === norm(p.gen));
    if (same) { claimed.add(same); exact++; continue; }
    rest.push({ p, m });
  }

  for (const { p, m } of rest) {
    const py = yearSpan(p.years);
    let best = null, bestScore = 0;
    for (const g of m[2]) {
      if (claimed.has(g)) continue;
      const gy = yearSpan(g[1]);
      if (!py || !gy) continue;
      const overlap = Math.min(py.to, gy.to) - Math.max(py.from, gy.from);
      const score = overlap - Math.abs(py.from - gy.from) / 10;
      if (overlap > 0 && (best === null || score > bestScore)) { best = g; bestScore = score; }
    }
    if (!best) {
      // two packs split what auto.ru keeps as one row (a restyling the app
      // treats as its own generation, a locally built version) — the pack
      // brings its own row rather than overwriting the other pack's
      const row = [p.gen, p.years];
      m[2].push(row);
      m[2].sort((a, b) => parseInt(a[1], 10) - parseInt(b[1], 10));
      claimed.add(row);
      added++;
      continue;
    }
    best[0] = p.gen;
    claimed.add(best);
    renamed++;
  }
  return { renamed, exact, added, unmatched };
}

const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const PROTO = process.env.PROTO || path.join(DIR, '..', '..');

function main() {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.json'));
  const brands = files.map(f => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8')));

  let nModels = 0, nGens = 0, skipped = 0;
  const blocks = [];

  for (const b of brands) if (BRAND_NAME[b.slug]) b.name = BRAND_NAME[b.slug];
  brands.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const built = [];
  for (const b of brands) {
    const models = [];
    for (const m of b.models) {
      if (NOT_A_MODEL.has(m.slug)) continue;
      const gens = mergeGenerations(m.generations || []);
      if (!gens.length) { skipped++; continue; }
      const name = (m.name || m.slug).trim();
      models.push([name, m.body || '', gens]);
      nModels++;
      nGens += gens.length;
    }
    if (!models.length) continue;
    models.sort((x, y) => x[0].localeCompare(y[0], 'ru'));
    built.push([b.name, models]);
  }

  const packs = applyPackCodes(built);

  for (const [brandName, models] of built) {
    const body = models.map(([name, kuzov, gens]) =>
      '  [' + q(name) + ', ' + q(kuzov) + ', [' +
      gens.map(g => '[' + q(g[0]) + ', ' + q(g[1]) + ']').join(', ') + ']]'
    ).join(',\n');
    blocks.push('[' + q(brandName) + ', [\n' + body + '\n]]');
  }

  const header = `/* Каталог вторичного рынка России: марки, модели и поколения.

   Здесь только то, по чему машину находят: марка, модель, поколение с
   заводским кодом и годы выпуска. Пакета данных (неисправности, нормы
   ЛКП, очаги коррозии, коды, инструкции, цены) у этих поколений ещё нет —
   в приложении они видны в каталоге и показывают состояние «данные
   готовятся».

   Статус: черновик, собран автоматически. Рестайлинги сведены в одно
   поколение, годы — объединённый диапазон. Годы, коды поколений и типы
   кузовов редактор проверяет перед публикацией.

   Формат: ["Марка", [ ["Модель", "кузов", [["Поколение", "годы"], ...]] ]] */

const STUB_CATALOG = [

`;

  fs.writeFileSync(path.join(PROTO, 'catalog.js'), header + blocks.join(',\n\n') + '\n\n];\n');
  console.log(`brands ${blocks.length}\tmodels ${nModels}\tgens ${nGens}\tmodels without generations skipped ${skipped}`);
  console.log(`packs: ${packs.exact} matched as is, ${packs.renamed} catalog rows took the pack's code, ${packs.added} rows added, ${packs.unmatched.length} unmatched`);
  if (packs.unmatched.length) console.log(packs.unmatched.join('\n'));
}

main();
