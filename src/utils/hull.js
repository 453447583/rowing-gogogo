// 船体水平轮廓（XZ 平面，+Z = 船头，单位米）—— 赛道护栏的唯一碰撞依据
//
// 为什么要有这个文件：
// 2026-11-18 用户反馈「赛艇已经超出赛道边缘浮桶了还没碰撞」。旧版 Track.constrain
// 用的是「圆角船体矩形」近似：纵向只取 62% 船长、横向只取 88% 船宽，再额外给
// RAIL_GRACE = 0.35m 容差。对 6.6m 长的维京长船，光船头就比采样点多伸出 1.25m，
// 再加上容差 → 船头能整体压过浮桶线 1.5m 以上才被拦，视觉上就是「穿模」。
//
// 现在的口径（用户明确要求）：**船体边缘碰到浮桶线就碰撞**。
// 于是碰撞形状 = 船体真实水平轮廓：
//   - 有 GLB 模型 → 取模型全部顶点投影到 XZ 求凸包（见 Boat.#measureHullFootprint）；
//   - 模型还没加载 / 蒙皮角色 → 用 hull 参数拼一个带尖头的八边形（fallbackHullOutline）。
// 两者都是「船体最外缘」，护栏判定不再打折。

/**
 * 兜底轮廓：用 boats.js 的 hull 参数（length / width / bow）拼一个带尖船头的八边形。
 * 只用于「GLB 还没加载完」或「蒙皮角色船」——形状要跟真模型尽量接近，
 * 否则开局几百毫秒里护栏宽度会从窄突然变宽（玩家读作"抖动"）。
 *
 * @param {{length:number,width:number,bow?:number}} hull
 * @returns {Float32Array} [x0,z0, x1,z1, ...]
 */
export function fallbackHullOutline(hull = {}) {
  const L = Math.max(0.6, Number(hull.length) || 4.4);
  const W = Math.max(0.4, Number(hull.width) || 1.8);
  const halfL = L * 0.5;
  const halfW = W * 0.5;
  // 尖头长度：船头锥的高度（bow），但不能超过全长的 40%，否则宽体船会被削成梭子
  const nose = Math.min(Math.max(0.3, Number(hull.bow) || L * 0.24), L * 0.4);
  const shoulderZ = halfL - nose;
  const sternZ = -halfL + L * 0.04;
  // 顺序无所谓（凸包/采样都不依赖绕向），这里按船头→右舷→船尾→左舷走一圈
  return Float32Array.from([
    0, halfL,                    // 船头尖
    halfW * 0.86, shoulderZ,     // 右前肩
    halfW, shoulderZ * 0.25,     // 右舷最宽处
    halfW * 0.94, sternZ,        // 右后角
    0, -halfL,                   // 船尾中点
    -halfW * 0.94, sternZ,       // 左后角
    -halfW, shoulderZ * 0.25,    // 左舷最宽处
    -halfW * 0.86, shoulderZ,    // 左前肩
  ]);
}

/** 二维凸包（Andrew monotone chain）。输入输出都是扁平数组 [x0,z0, x1,z1, ...] */
export function convexHull2D(flat) {
  const n = (flat?.length || 0) >> 1;
  if (n < 3) return Float32Array.from(flat || []);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = [flat[i * 2], flat[i * 2 + 1]];
  pts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  const out = new Float32Array(hull.length * 2);
  for (let i = 0; i < hull.length; i++) { out[i * 2] = hull[i][0]; out[i * 2 + 1] = hull[i][1]; }
  return out;
}

/**
 * 简化闭合多边形：迭代删除「删掉后形状变化最小」的顶点，直到顶点数 ≤ maxPoints。
 * 容差 tol 是"该点到相邻两点连线的距离"，超过容差的顶点永不删除
 * （船头尖、船尾角这些真正的拐点会被完整保留）。
 *
 * 为什么不用等距重采样：等距会把尖船头切掉一刀，碰撞就比视觉小了一截，
 * 又回到"船头扎进浮桶"的老问题。
 */
export function simplifyOutline(flat, maxPoints = 16, tol = 0.06) {
  const n = (flat?.length || 0) >> 1;
  if (n <= maxPoints) return Float32Array.from(flat || []);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = [flat[i * 2], flat[i * 2 + 1]];
  while (pts.length > maxPoints) {
    let worstIdx = -1;
    let worstD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[(i + 1) % pts.length];
      const c = pts[i];
      const abx = b[0] - a[0];
      const abz = b[1] - a[1];
      const len = Math.hypot(abx, abz) || 1;
      // 点到直线 a→b 的距离（顶点本就凸，垂足必在段内，不必额外钳制）
      const d = Math.abs((c[0] - a[0]) * abz - (c[1] - a[1]) * abx) / len;
      if (d < worstD) { worstD = d; worstIdx = i; }
    }
    // 最"平"的那个顶点都超过容差 = 剩下的全是真拐点，再删就削掉船体了
    if (worstIdx < 0 || worstD > tol) break;
    pts.splice(worstIdx, 1);
  }
  const out = new Float32Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) { out[i * 2] = pts[i][0]; out[i * 2 + 1] = pts[i][1]; }
  return out;
}

/** 轮廓的外接尺寸 {halfW, halfLen}（船体局部坐标，+Z 船头） */
export function outlineExtents(flat) {
  let halfW = 0;
  let halfLen = 0;
  for (let i = 0; i < (flat?.length || 0); i += 2) {
    halfW = Math.max(halfW, Math.abs(flat[i]));
    halfLen = Math.max(halfLen, Math.abs(flat[i + 1]));
  }
  return { halfW, halfLen };
}
