// Checks the 158 existing data packs against the freshly scraped catalog.
// A pack whose brand/model/generation strings do not match the catalog would
// show up in the app as a separate, duplicate entry, so every one has to match.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PROTO = process.env.PROTO || path.join(DIR, '..', '..');

const norm = s => String(s).toLowerCase().replace(/ё/g, 'е')
  .replace(/[\s\u00a0]+/g, ' ').replace(/[«»"'’]/g, '').trim();

function packKeys() {
  const out = [];
  for (const f of ['packs.js', 'index.html']) {
    const src = fs.readFileSync(path.join(PROTO, f), 'utf8');
    const re = /brand:"([^"]*)",\s*model:"([^"]*)",\s*gen:"([^"]*)"/g;
    let m;
    while ((m = re.exec(src))) out.push({ brand: m[1], model: m[2], gen: m[3], file: f });
  }
  return out;
}

function loadCatalog() {
  const src = fs.readFileSync(path.join(PROTO, 'catalog.js'), 'utf8');
  let STUB_CATALOG;
  eval(src.replace('const STUB_CATALOG', 'STUB_CATALOG'));
  return STUB_CATALOG;
}

function main() {
  const cat = loadCatalog();
  const brands = new Map();
  for (const [brand, models] of cat) {
    const mm = new Map();
    for (const [model, , gens] of models) {
      mm.set(norm(model), { model, gens: new Map(gens.map(g => [norm(g[0]), g[0]])) });
    }
    brands.set(norm(brand), { brand, models: mm });
  }

  const miss = { brand: [], model: [], gen: [] };
  let ok = 0;
  for (const p of packKeys()) {
    const b = brands.get(norm(p.brand));
    if (!b) { miss.brand.push(`${p.brand}`); continue; }
    const m = b.models.get(norm(p.model));
    if (!m) { miss.model.push(`${p.brand} / ${p.model}`); continue; }
    const g = m.gens.get(norm(p.gen));
    if (!g) { miss.gen.push(`${p.brand} / ${p.model} / ${p.gen} — есть: ${[...m.gens.values()].join(', ')}`); continue; }
    ok++;
  }

  const uniq = a => [...new Set(a)].sort();
  console.log(`packs matched: ${ok}`);
  console.log(`\nunknown brands (${uniq(miss.brand).length}):\n` + uniq(miss.brand).join('\n'));
  console.log(`\nunknown models (${uniq(miss.model).length}):\n` + uniq(miss.model).join('\n'));
  console.log(`\nunknown generations (${uniq(miss.gen).length}):\n` + uniq(miss.gen).join('\n'));
}

main();
