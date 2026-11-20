import { RAW_B } from '../canyon-track-b.mjs';
import { sampleClosed, minEnclosingCircle, polyLength, worstRadius, clearance } from '../canyon-track-core.mjs';
import { filletClosed, densify } from '../canyon-fillet.mjs';
import { buildTrack } from '../canyon-track-core.mjs';

const HW = 7.5;
const circ = minEnclosingCircle(RAW_B);

console.log('scale  R    单圈    最急R   净空   覆盖R');
for (const scale of [1.0, 1.15, 1.25]) {
  const placed = RAW_B.map((p) => [(p[0] - circ.cx) * scale, (p[1] - circ.cz) * scale, (p[2] ?? 0) * scale]);
  for (const R of [20, 22, 26]) {
    const poly = densify(filletClosed(placed, R, 8), 5);
    const info = worstRadius(poly, 8);
    const cl = clearance(poly, HW);
    console.log(
      String(scale).padEnd(6), String(R).padEnd(4),
      polyLength(poly).toFixed(0).padEnd(7), info.r.toFixed(1).padEnd(7),
      cl.gap.toFixed(1).padEnd(6), Math.max(...poly.map((q) => Math.hypot(q[0], q[1]))).toFixed(0),
    );
  }
}

// 顺便看看旧思路（放宽）在撑开掐点后的最好成绩，做对照
const t = buildTrack({ scale: 1.15, rMin: 22, halfWidth: HW, maxRadius: 400 });
console.log('\n对照（放宽算法）：', t.total.toFixed(0), 'm  最急R', t.minR.toFixed(1), '净空', t.clearance.gap.toFixed(1));
