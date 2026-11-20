import { designPoints, designPolyline, designPoint, DESIGN } from '../canyon-track-design.mjs';
import { sampleClosed, polyLength, worstRadius, clearance, minEnclosingCircle } from '../canyon-track-core.mjs';

const HW = 7.5;

function report(name, pts, poly) {
  const info = worstRadius(poly, 10);
  const cl = clearance(poly, HW);
  const r = Math.max(...poly.map((q) => Math.hypot(q[0], q[1])));
  const dense = designPolyline(DESIGN, 2400);
  const dInfo = worstRadius(dense, 12);
  console.log(
    name.padEnd(16),
    '单圈', polyLength(poly).toFixed(0).padEnd(6),
    '控制点R', info.r.toFixed(1).padEnd(7),
    '理论R', dInfo.r.toFixed(1).padEnd(7),
    '净空', cl.gap.toFixed(1).padEnd(6),
    '覆盖R', r.toFixed(0).padEnd(4),
    '最高', Math.max(...poly.map((q) => q[2] ?? 0)).toFixed(2),
  );
}

for (const n of [36, 40, 44, 52]) {
  const pts = designPoints(n);
  const poly = sampleClosed(pts, 24);
  report(`设计 ${n} 点`, pts, poly);
}

const pts = designPoints(44);
const poly = sampleClosed(pts, 24);
for (const key of ['start', 'canyon', 'tunnel1', 'ramp', 'tunnel2', 'reef', 'returnLeg']) {
  const p = designPoint(DESIGN.marks[key]);
  console.log(' ', key.padEnd(10), `u=${DESIGN.marks[key]}`, `(${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
}
console.log('2 圈时长 @26m/s', (polyLength(poly) * 2 / 26 / 60).toFixed(2), '分');
