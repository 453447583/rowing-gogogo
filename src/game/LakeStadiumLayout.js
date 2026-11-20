/**
 * 湖泊环线「赛事化」布点的纯数学部分：不依赖 three / DOM。
 *
 * 为什么要单独一层：看台占地必须和岸边种树 / 摆石头共用同一份数据，
 * 否则树会从看台中间长出来（Environment 的岸带循环与 LakeStadium 各算一套必然错位）。
 * 这里只做中心线采样 + 弧长布点 + 占地矩形判定，两边 import 同一份结果。
 */

/**
 * 看台前沿距中心线（米）。
 * 岸带剖面 18（入水）→ 27（坡顶 1.6m）→ 33（外缘回到水下）。
 * 前沿放在 23：看台前面留出 5m 草坡当护岸，不然整座看台像一堵从水里竖起来的灰墙。
 */
export const STAND_FRONT = 23;
/** 看台进深（米）。后沿 36m，只有最后 3m 悬在岸带外，靠桩基站在水里。 */
export const STAND_DEPTH = 13;
/** 单个看台沿赛道的长度（米）。 */
export const STAND_LENGTH = 44;
/** 相邻看台沿弧长的最小间隙（米）。 */
export const STAND_GAP = 14;

/** 中心线按弧长重采样。用 Catmull-Rom 而不是直线插值：16 个门连成的折线曲率是跳变的。 */
export function sampleCenterline(mapDef, step = 1.5) {
  const g = mapDef.gates || [];
  const n = g.length;
  if (n < 3) return { samples: [], total: 0 };
  const at = (i) => g[((i % n) + n) % n];
  const samples = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const seg = Math.max(1, Math.ceil(chord / step));
    for (let k = 0; k < seg; k++) {
      const t = k / seg;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t
        + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const x = f(p0[0], p1[0], p2[0], p3[0]);
      const z = f(p0[1], p1[1], p2[1], p3[1]);
      const last = samples[samples.length - 1];
      if (last) s += Math.hypot(x - last.x, z - last.z);
      samples.push({ x, z, s });
    }
  }
  // 闭环：把最后一点接回起点，算出真实总长
  const first = samples[0];
  const last = samples[samples.length - 1];
  const total = s + Math.hypot(first.x - last.x, first.z - last.z);
  return { samples, total };
}

/** 弧长 → 采样点（线性扫表；总量只有几百点，够用） */
export function sampleAt(layout, s) {
  const { samples, total } = layout;
  if (!samples.length) return null;
  const target = ((s % total) + total) % total;
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i].s <= target && samples[i + 1].s >= target) return samples[i];
  }
  return samples[samples.length - 1];
}

function distToPolyline(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const L2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
    const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t));
    if (d < best) best = d;
  }
  return best;
}

/** 到中心线的最近距离 */
function distToCenterline(layout, x, z) {
  const { samples } = layout;
  let best = Infinity;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const L2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / L2));
    const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
    if (d < best) best = d;
  }
  return best;
}

/** 看台占地是否能放下：不压近道 / 岛屿 / 暗礁 / 领奖台，也不啃进赛道 */
function footprintClear(layout, mapDef, p, outX, outZ) {
  const half = STAND_LENGTH / 2;
  for (let u = -half; u <= half; u += half / 3) {
    for (const v of [STAND_FRONT, STAND_FRONT + STAND_DEPTH * 0.5, STAND_FRONT + STAND_DEPTH]) {
      const x = p.x + p.tx * u + outX * v;
      const z = p.z + p.tz * u + outZ * v;
      // 前沿 2m 容差：弯道上直段近似会往里啃一点，不能少于半个走廊
      if (distToCenterline(layout, x, z) < STAND_FRONT - 2) return false;
      for (const sc of mapDef.shortcuts || []) {
        if (distToPolyline(sc.points, x, z) < sc.width + 8) return false;
      }
      for (const is of mapDef.islands || []) {
        if (Math.hypot(x - is.x, z - is.z) < is.r + 8) return false;
      }
      for (const r of mapDef.rocks || []) {
        if (Math.hypot(x - r.x, z - r.z) < r.r + 7) return false;
      }
      if (mapDef.podium && Math.hypot(x - mapDef.podium.x, z - mapDef.podium.z) < 34) return false;
    }
  }
  return true;
}

/** URL 一键关闭（?lakeStadium=0 / ?grade=old）。Environment 也要读它：
 *  关掉看台时岸边该照原样种树，不然"关闭"之后只剩一块空地，不是真正的原样。 */
export function lakeStadiumDisabledByUrl() {
  try {
    if (typeof location === 'undefined') return false;
    const q = new URLSearchParams(location.search);
    return q.get('lakeStadium') === '0' || q.get('grade') === 'old';
  } catch { return false; }
}

/**
 * 算出一整套看台布点（确定性，无随机）。
 * 只挑「半径 > 70m 的缓弯或直道」，相邻沿弧长至少 STAND_LENGTH + STAND_GAP。
 * @returns {{ total: number, stands: Array }}
 */
export function lakeStadiumLayout(mapDef) {
  const layout = sampleCenterline(mapDef, 1.5);
  const { samples, total } = layout;
  const stands = [];
  if (!samples.length) return { ...layout, stands };

  const pick = (s) => {
    const p = sampleAt(layout, s);
    const a = sampleAt(layout, s - 9);
    const b = sampleAt(layout, s + 9);
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const L = Math.hypot(tx, tz) || 1;
    tx /= L;
    tz /= L;
    let outX = -tz;
    let outZ = tx;
    // 环外方向 = 远离原点（湖泊是绕 (0,0) 的环线，和立牌用的是同一个判据）
    if (outX * p.x + outZ * p.z < 0) { outX = -outX; outZ = -outZ; }
    // 曲率：±9m 的切线夹角 / 弧长 → 半径
    const a1 = sampleAt(layout, s - 18);
    const b1 = sampleAt(layout, s + 18);
    const t1x = p.x - a1.x, t1z = p.z - a1.z;
    const t2x = b1.x - p.x, t2z = b1.z - p.z;
    const l1 = Math.hypot(t1x, t1z) || 1;
    const l2 = Math.hypot(t2x, t2z) || 1;
    const cos = (t1x * t2x + t1z * t2z) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, cos)));
    const radius = ang < 1e-4 ? Infinity : (l1 + l2) / 2 / ang;
    return { s, x: p.x, z: p.z, tx, tz, outX, outZ, radius };
  };

  const circularGap = (a, b) => {
    const d = Math.abs(a - b) % total;
    return Math.min(d, total - d);
  };

  // 从 s=0 起每 9m 试一个位置；只收半径 ≥70m 的缓弯/直道
  for (let s = 0; s < total; s += 9) {
    const c = pick(s);
    if (c.radius < 70) continue;
    if (stands.some((st) => circularGap(st.s, c.s) < STAND_LENGTH + STAND_GAP)) continue;
    if (!footprintClear(layout, mapDef, c, c.outX, c.outZ)) continue;
    // 中心点：前沿 + 半个进深
    const centerOff = STAND_FRONT + STAND_DEPTH / 2;
    stands.push({
      s: c.s,
      x: c.x + c.outX * centerOff,
      z: c.z + c.outZ * centerOff,
      tx: c.tx,
      tz: c.tz,
      outX: c.outX,
      outZ: c.outZ,
    });
  }
  return { ...layout, stands };
}

/**
 * 点 (x,z) 是否落在某个看台的占地矩形里（Environment 种树前用）。
 * @param {number} pad 额外外扩（米）
 */
export function inStadiumFootprint(layout, x, z, pad = 0) {
  for (const st of layout.stands || []) {
    const dx = x - st.x;
    const dz = z - st.z;
    const u = dx * st.tx + dz * st.tz;          // 沿赛道
    const v = dx * st.outX + dz * st.outZ;      // 朝环外
    if (Math.abs(u) > STAND_LENGTH / 2 + pad) continue;
    if (v < -STAND_DEPTH / 2 - pad || v > STAND_DEPTH / 2 + pad) continue;
    return true;
  }
  return false;
}
