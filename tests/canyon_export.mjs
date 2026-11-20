import fs from 'node:fs';
import { buildLoopTrack } from '../canyon-seg-track.mjs';
import { cumLength } from '../canyon-track-core.mjs';

const t = buildLoopTrack({ peak: 5, halfWidth: 7.5, maxExtent: 820 });
const poly = t.poly, cum = cumLength(poly), total = cum[poly.length];

// 门：按 45m 等距撒（弯道自动更密）
const step = 45;
const gates = [];
for (let d = 0; d < total; d += step) {
  let lo = 0;
  while (lo < cum.length - 1 && cum[lo] < d) lo++;
  const p = poly[lo % poly.length];
  gates.push([Math.round(p[0]), Math.round(p[1])]);
}
const out = {
  total: Math.round(total),
  minR: +t.minR.toFixed(1),
  extent: Math.round(t.extent),
  gateCount: gates.length,
  gates,
  rocks: t.obstacles.map(o => ({ x: Math.round(o.x), z: Math.round(o.z), r: +o.r.toFixed(1), s: +(o.r / 3).toFixed(2) })),
  ringHeight: 5,
};
fs.writeFileSync('canyon-map-data.json', JSON.stringify(out, null, 1));
console.log('门', gates.length, '障碍', out.rocks.length, '单圈', out.total, '最急R', out.minR, '覆盖', out.extent);
