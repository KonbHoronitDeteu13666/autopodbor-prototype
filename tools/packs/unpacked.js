// Какие поколения ещё без пакета данных.
// Запуск: node tools/packs/unpacked.js            — сводка по всем маркам
//         node tools/packs/unpacked.js Toyota Kia — список по конкретным маркам
//
// Пакеты живут в двух местах: packs.js (основная масса) и index.html
// (первые семнадцать, с ранних итераций). Скрипт учитывает оба.

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

const packs = eval(fs.readFileSync(path.join(root, 'packs.js'), 'utf8') + '; EXTRA_CARS');
const STUB_CATALOG = eval(fs.readFileSync(path.join(root, 'catalog.js'), 'utf8') + '; STUB_CATALOG');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const have = new Set();
for (const id of Object.keys(packs)) {
  const c = packs[id];
  have.add(c.brand + '|' + c.model + '|' + c.gen);
}
const re = /CARS\["([a-z0-9-]+)"\] = \{\s*brand:"([^"]+)", model:"([^"]+)", gen:"([^"]+)"/g;
let m;
while ((m = re.exec(html)) !== null) have.add(m[2] + '|' + m[3] + '|' + m[4]);

const want = process.argv.slice(2);
let totalGens = 0, totalLeft = 0;

for (const [brand, models] of STUB_CATALOG) {
  const out = [];
  let gens = 0;
  for (const [model, body, modelGens] of models)
    for (const [gen, years] of modelGens) {
      gens++;
      if (!have.has(brand + '|' + model + '|' + gen)) out.push(model + ' ' + gen + ' (' + years + ')');
    }
  totalGens += gens;
  totalLeft += out.length;
  if (!want.length) continue;
  if (!want.includes(brand)) continue;
  console.log('== ' + brand + ': ' + out.length + ' из ' + gens);
  for (const row of out) console.log('   ' + row);
}

console.log('поколений всего:', totalGens, '| с пакетом:', totalGens - totalLeft, '| осталось:', totalLeft);
