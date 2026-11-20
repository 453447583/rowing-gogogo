// B′ 拉长边：保持每个拐角的「转角」不变（形状语言完全照旧），只按需要拉长每条边，
// 再用最小范数修正让闭环重新闭合。之后圆角化成 R 的圆弧。
import { RAW_B } from '../canyon-track-b.mjs';
import { filletClosed, densify } from '../canyon-fillet.mjs';
import { minEnclosingCircle, polyLength, worstRadius, clearance, sampleClosed } from '../canyon-track-core.mjs';

const HW = 7.5;

export function stretchLegs(pts, R, extra = 12) {
  const n = pts.length;
  // 1) 转角（保持）
  const theta = [];
  const dirs0 = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
    const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
    dirs0.push([v2[0] / l2, v2[1] / l2]);
    const c = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
    theta.push(Math.acos(Math.max(-1, Math.min(1, c))));   // i 点处的方向改变
  }
  // 2) 每条边需要的长度：两端圆角切线长 + 余量
  const need = [];
  for (let i = 0; i < n; i++) {
    const d1 = R * Math.tan(Math.min(theta[i], Math.PI * 0.62) / 2);
    const d2 = R * Math.tan(Math.min(theta[(i + 1) % n], Math.PI * 0.62) / 2);
    need.push(d1 + d2 + extra);
  }
  let L = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    L.push(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), need[i]));
  }
  // 3) 从角度重建方向，并按最小范数修正边长，使闭环闭合
  const u = [];
  let ang = Math.atan2(dirs0[0][1], dirs0[0][0]);
  const startAng = ang;
  for (let i = 0; i < n; i++) {
    if (i > 0) ang += theta[i] * sign(pts, i);
    u.push([Math.cos(ang), Math.sin(ang)]);
  }
  const res = [0, 0];
  for (let i = 0; i < n; i++) { res[0] += u[i][0] * L[i]; res[1] += u[i][1] * L[i]; }
  // min ||dL|| s.t. sum(u_i dL_i) = -res  →  dL = U^T (U U^T)^-1 (-res)
  let a11 = 0, a12 = 0, a22 = 0;
  for (let i = 0; i < n; i++) { a11 += u[i][0] ** 2; a12 += u[i][0] * u[i][1]; a22 += u[i][1] ** 2; }
  const det = a11 * a22 - a12 * a12 || 1e-9;
  const b1 = -res[0], b2 = -res[1];
  const y1 = (b1 * a22 - a12 * b2) / det;
  const y2 = (a11 * b2 - a12 * b1) / det;
  L = L.map((v, i) => v + u[i][0] * y1 + u[i][1] * y2);

  // 4) 重建点列（起点固定在 pts[0]，朝向固定）
  const out = [[pts[0][0], pts[0][1], pts[0][2] ?? 0]];
  let x = pts[0][0], y = pts[0][1];
  for (let i = 0; i < n; i++) {
    x += u[i][0] * L[i];
    y += u[i][1] * L[i];
    const t = (i + 1) % n;
    out.push([x, y, pts[t][2] ?? 0]);
  }
  out.pop();  // 最后一个是回到起点
  return out;
}

// 判断转角方向
function sign(pts, i) {
  const n = pts.length;
  const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
  const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
  const v2 = [p2[0] - p1[0], p2[1] - p1[1]];
  return (v1[0] * v2[1] - v1[1] * v2[0]) >= 0 ? 1 : -1;
}

// ---------- 量测 ----------
const circ = minEnclosingCircle(RAW_B);
const base = RAW_B.map((p) => [(p[0] - circ.cx) * 1.0, (p[1] - circ.cz) * 1.0, (p[2] ?? 0)]);

console.log('R     缩放   单圈    最急R   净空    覆盖R');
for (const R of [20, 22, 26]) {
  let st = stretchLegs(base, R, 14);
  for (const s of [1.15, 1.2]) {
    const scaled = st.map((p) => [p[0] * s, p[1] * s, (p[2] ?? 0) * s]);
    const poly = densify(filletClosed(scaled, R, 10), 5);
    const info = worstRadius(poly, 4);
    const cl = clearance(poly, HW);
    const r = Math.max(...poly.map((q) => Math.hypot(q[0], q[1])));
    console.log(String(R).padEnd(6), String(s).padEnd(6),
      polyLength(poly).toFixed(0).padEnd(7), info.r.toFixed(1).padEnd(7),
      cl.gap.toFixed(1).padEnd(7), r.toFixed(0));
  }
}
