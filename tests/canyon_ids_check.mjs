import { MAPS } from '../src/data/maps.js';
for (const id of ['canyon','lake','ocean']) {
  const m = MAPS.find(x=>x.id===id);
  console.log(id, m.name, 'gates', m.gates.length, 'rocks', m.rocks.length);
}
console.log('总数', MAPS.length);
