import { RAW_B } from '../canyon-track-b.mjs';
import { sampleClosed, minEnclosingCircle, polyLength, worstRadius, clearance, relax, cumLength } from '../canyon-track-core.mjs';

const HW = 7.5;
const circ = minEnclosingCircle(RAW_B);
console.log('包围圆 r =', circ.r.toFixed(0));

for (const [scale, rMin] of [[1.0, 22], [1.15, 22], [1.15, 20], [1.3, 22], [1.45, 22]]) {
  const placed = RAW_B.map((p) => [(p[0] - circ.cx) * scale, (p[1] - circ.cz) * scale, (p[2] ?? 0) * scale]);
  const poly0 = sampleClosed(placed, 24);
  const cl0 = clearance(poly0, HW);
  const r0 = Math.max(...poly0.map((q) => Math.hypot(q[0], q[1])));
  let gates = relax(placed, { rMin, halfWidth: HW, iters: 400, spring: 0.04 });
  let poly = sampleClosed(gates, 24);
  let info = worstRadius(poly, 10);
  if (info.r < rMin * 0.9) {
    gates = relax(gates, { rMin: rMin * 1.04, halfWidth: HW, iters: 300, spring: 0.03 });
    poly = sampleClosed(gates, 24);
    info = worstRadius(poly, 10);
  }
  const cl = clearance(poly, HW);
  console.log(
    `scale=${scale} rMin=${rMin}  单圈=${polyLength(poly).toFixed(0)}m`,
    `最急R=${info.r.toFixed(1)}(放宽前${worstRadius(poly0, 10).r.toFixed(1)})`,
    `净空=${cl.gap.toFixed(1)}m(放宽前${cl0.gap.toFixed(1)})`,
    `覆盖=${Math.max(...poly.map((q) => Math.hypot(q[0], q[1]))).toFixed(0)}`,
  );
}
