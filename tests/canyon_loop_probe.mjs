// 方案 B：立体交叉发卡。把原来打成结的 7~11 换成一个真 360° 环（半径 34）+ 5m 桥面高差；
// 出入口在平面上重合于 P(-6,-206)，靠高度错开。其余 34 个点不动。
import { RAW_B } from '../canyon-track-b.mjs';
import { filletClosed, densify } from '../canyon-fillet.mjs';
import { minEnclosingCircle, polyLength, worstRadius, clearance, sampleClosed } from '../canyon-track-core.mjs';

const HW = 7.5;
const P = [-6, -206];
const C = [12.7, -233.5];   // 环心按切线对齐重算（入口/出口各只差 ~15°）
const R = 34, PEAK = 3.2;

function loopPts() {
  const out = [];
  const a0 = Math.atan2(P[1] - C[1], P[0] - C[0]);
  const N = 14;
  for (let k = 1; k < N; k++) {
    const a = a0 - (k / N) * Math.PI * 2;
    out.push([C[0] + Math.cos(a) * R, C[1] + Math.sin(a) * R, PEAK * Math.sin((k / N) * Math.PI * 0.5)]);
  }
  out.push([P[0], P[1], PEAK]);                     // 回到 P，在桥面高度
  return out;
}

const RAW_B2 = [...RAW_B.slice(0, 7), ...loopPts(), [-24, -222, 1.6], ...RAW_B.slice(12)];

const circ = minEnclosingCircle(RAW_B2);
const placed = RAW_B2.map((p) => [p[0] - circ.cx, p[1] - circ.cz, p[2] ?? 0]);

function report(tag, poly) {
  const info = worstRadius(poly, 6);
  const cl = clearance(poly, HW);
  const rad = Math.max(...poly.map((q) => Math.hypot(q[0], q[1])));
  console.log(
    tag.padEnd(26),
    '单圈', polyLength(poly).toFixed(0).padEnd(6),
    '最急R', info.r.toFixed(1).padEnd(6),
    '净空', cl.gap.toFixed(1).padEnd(6),
    '覆盖R', rad.toFixed(0).padEnd(5),
    '最高', Math.max(...poly.map((q) => q[2] ?? 0)).toFixed(1),
  );
}

console.log('点表：', RAW_B2.length, '个（原 39 + 环内 12 - 去掉 5）');
report('原始（未圆角）', sampleClosed(placed, 20));
for (const r of [18, 22, 26, 30]) {
  report(`圆角 R=${r}`, densify(filletClosed(placed, r, 8), 5));
}
for (const s of [1.1, 1.2]) {
  const sc = placed.map((p) => [p[0] * s, p[1] * s, (p[2] ?? 0) * s]);
  report(`圆角R22 + 缩放${s}`, densify(filletClosed(sc, 22, 8), 5));
}
