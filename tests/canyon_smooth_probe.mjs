import { RAW, sampleClosed, minEnclosingCircle, polyLength, worstRadius, clearance, smoothFit } from '../canyon-track-core.mjs';

const HW = 7.5;
const circ0 = minEnclosingCircle(RAW);
const base = RAW.map((p) => [(p[0] - circ0.cx) * 0.88, (p[1] - circ0.cz) * 0.88, (p[2] ?? 0) * 0.88]);

console.log('门数 iters  单圈    最急R   净空    覆盖R  判定');
for (const M of [28, 36, 44]) {
  for (const iters of [4, 8, 14, 22, 32]) {
    const pts = smoothFit(base, iters, 292, 0.99, M);
    const poly = sampleClosed(pts, 24);
    const info = worstRadius(poly, 10);
    const cl = clearance(poly, HW);
    const r = Math.max(...poly.map((q) => Math.hypot(q[0], q[1])));
    const ok = info.r >= 30 && cl.gap >= 4 ? 'OK' : '';
    console.log(
      String(M).padEnd(5), String(iters).padEnd(6),
      polyLength(poly).toFixed(0).padEnd(8),
      info.r.toFixed(1).padEnd(8),
      cl.gap.toFixed(1).padEnd(7),
      r.toFixed(0).padEnd(7), ok,
    );
  }
}
