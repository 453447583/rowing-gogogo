import { MAPS } from '../src/data/maps.js';
const m = MAPS.find(x => x.id === 'ocean');
console.log('name', m.name, 'laps', m.laps, 'gateWidth', m.gateWidth, 'boundary', m.boundary.r);
console.log('gates', m.gates.length, 'rocks', m.rocks.length, 'props', m.courseProps.length, 'ring', m.ringHeight);
const far = Math.max(...m.gates.map(g => Math.hypot(g[0], g[1])));
console.log('门最远半径', far.toFixed(0), '边界够吗', far < m.boundary.r ? 'OK' : '超出');
const outRocks = m.rocks.filter(r => Math.hypot(r.x, r.z) > m.boundary.r).length;
console.log('越界礁石', outRocks);
console.log('地图总数', MAPS.length);
