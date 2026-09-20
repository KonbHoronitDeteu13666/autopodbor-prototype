// Проверка пакетов данных перед коммитом.
// Запуск: node tools/packs/validate.js   (из корня autopodbor-prototype)
//
// Что проверяет:
//   BAD SEQ / ORPHAN  — issueSeq и ключи issues должны совпадать один в один
//   BAD ENG / OPT / GB — ссылки issue.eng, issue.opt, issue.gb на реально
//                        объявленные двигатели, опции и коробки этого пакета
//   NOT IN CATALOG    — brand|model|gen пакета должен существовать в catalog.js
//
// Ноль проблем — можно коммитить. Иначе машина продублируется в каталоге
// или экран упадёт на рендере.

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');

const packs = eval(fs.readFileSync(path.join(root, 'packs.js'), 'utf8') + '; EXTRA_CARS');
const STUB_CATALOG = eval(fs.readFileSync(path.join(root, 'catalog.js'), 'utf8') + '; STUB_CATALOG');

const cat = new Set();
for (const [brand, models] of STUB_CATALOG)
  for (const [model, body, gens] of models)
    for (const [gen] of gens) cat.add(brand + '|' + model + '|' + gen);

let problems = 0;
for (const id of Object.keys(packs)) {
  const c = packs[id];
  const keys = Object.keys(c.issues || {});
  for (const k of c.issueSeq || []) if (!keys.includes(k)) { console.log('BAD SEQ', id, k); problems++; }
  for (const k of keys) if (!(c.issueSeq || []).includes(k)) { console.log('ORPHAN', id, k); problems++; }
  const engKeys = (c.engines || []).map(e => e.key);
  const gbs = new Set();
  for (const e of c.engines || []) for (const g of e.gearboxes || []) gbs.add(g);
  const optIds = (c.options || []).map(o => o.id);
  for (const k of keys) {
    const is = c.issues[k];
    if (is.eng && !engKeys.includes(is.eng)) { console.log('BAD ENG', id, k, is.eng); problems++; }
    if (is.opt && !optIds.includes(is.opt)) { console.log('BAD OPT', id, k, is.opt); problems++; }
    if (is.gb && ![...gbs].some(g => g.indexOf(is.gb) === 0)) { console.log('BAD GB', id, k, is.gb); problems++; }
  }
  if (!cat.has(c.brand + '|' + c.model + '|' + c.gen)) { console.log('NOT IN CATALOG', id, c.brand, c.model, c.gen); problems++; }
}

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const re = /CARS\["([a-z0-9-]+)"\] = \{\s*brand:"([^"]+)", model:"([^"]+)", gen:"([^"]+)"/g;
let m;
while ((m = re.exec(html)) !== null) {
  if (!cat.has(m[2] + '|' + m[3] + '|' + m[4])) { console.log('NOT IN CATALOG (index.html)', m[1], m[2], m[3], m[4]); problems++; }
}

console.log('packs:', Object.keys(packs).length, 'problems:', problems);
process.exit(problems ? 1 : 0);
