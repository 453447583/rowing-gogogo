import fs from 'node:fs';
import { buildLoopTrack } from '../canyon-seg-track.mjs';
import { sampleClosed, cumLength } from '../canyon-track-core.mjs';
const HW = 7.5, SAFE = 6.4;
const t = buildLoopTrack({ peak: 5, halfWidth: HW, maxExtent: 820 });
const poly = t.poly;
const cum = cumLength(poly), total = cum[poly.length];
let rocks = t.obstacles.map(r => ({ ...r }));
// 门位置（45m 等距，与导出脚本一致）
const gates = [];
for (let d = 0; d < total; d += 45) {
  let lo = 0; while (lo < cum.length - 1 && cum[lo] < d) lo++;
  gates.push([poly[lo % poly.length][0], poly[lo % poly.length][1]]);
}
const nearGate = (r) => gates.some(g => Math.hypot(r.x - g[0], r.z - g[1]) < 14);
rocks = rocks.filter(r => !nearGate(r));
console.log('剔贴门后', rocks.length);

function locate(r) {
  let best = Infinity, bi = 0, off = 0;
  for (let i = 0; i < poly.length; i++) {
    const d = Math.hypot(poly[i][0] - r.x, poly[i][1] - r.z);
    if (d < best) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      off = (r.x - a[0]) * -tz + (r.z - a[1]) * tx;
      best = d; bi = i;
    }
  }
  return { i: bi, off };
}
function audit(list) {
  const acc = new Map();
  for (const r of list) {
    const { i, off } = locate(r);
    const span = Math.ceil((r.r + 2) / 2);
    for (let k = -span; k <= span; k++) {
      const s = (i + k + poly.length) % poly.length;
      if (!acc.has(s)) acc.set(s, []);
      acc.get(s).push({ lo: off - r.r, hi: off + r.r, r });
    }
  }
  let worst = { gap: Infinity, blockers: [] };
  for (let i = 0; i < poly.length; i += 2) {
    const blocked = (acc.get(i) || []).filter(b => b.hi > -HW && b.lo < HW)
      .map(b => [Math.max(-HW, b.lo), Math.min(HW, b.hi)]).sort((a, b) => a[0] - b[0]);
    let pos = -HW, best = 0;
    for (const [lo, hi] of blocked) { if (lo > pos) best = Math.max(best, lo - pos); pos = Math.max(pos, hi); }
    best = Math.max(best, HW - pos);
    if (best < worst.gap) worst = { gap: best, blockers: (acc.get(i) || []).map(b => b.r) };
  }
  return worst;
}
let w = audit(rocks), guard = 0;
while (w.gap < SAFE && guard++ < 80) {
  const worstR = w.blockers.map(r => ({ r, l: locate(r) }))
    .sort((a, b) => Math.abs(b.l.off) - b.r.r - (Math.abs(a.l.off) - a.r.r))[0];
  if (!worstR) break;
  rocks = rocks.filter(x => x !== worstR.r);
  w = audit(rocks);
}
console.log('最终礁石', rocks.length, '最窄空档', w.gap.toFixed(2));
const data = JSON.parse(fs.readFileSync('canyon-map-data.json', 'utf8'));
data.rocks = rocks.map(r => ({ x: Math.round(r.x), z: Math.round(r.z), r: +(r.r * 0.85).toFixed(2), s: +(r.r / 3).toFixed(2) }));
data.rockAudit = { minGap: +w.gap.toFixed(2), count: rocks.length };
fs.writeFileSync('canyon-map-data.json', JSON.stringify(data, null, 1));
