// 秘境漂流「云端螺旋塔」：评估几组手挑方案，打印全部量化指标。
//
// 布局逻辑（为什么这么摆）：
//   · 门 29（A）是楼梯尽头，来车方向朝东 → 螺旋中心只能放在 A 正北，
//     逆时针切线才还是朝东，衔接不会有折角。
//   · 半径 r_entry = dC（A 到塔心的距离），所以 dC 直接决定入口半径。
//   · 上升圈在内（r 90→76），下降圈在外（r 110），径向差 = 34m，
//     减掉两条走廊各 7.5m 半宽还剩 19m —— 上下两圈永远不会穿在一起。
//   · 门号一共只占 30..65 共 36 槽，跟原来一样，所以 edgeDrop / jumps / returnFrom
//     全都不用改号。
import { BAKED_TRACK } from '../src/data/baked-track.js';

const gates = BAKED_TRACK.gates.map((p) => [p[0], p[1]]);
const gateY = BAKED_TRACK.gateY.slice();
const N = gates.length;
const A = gates[29];
const F = gates[66];
const yA = gateY[29];
const yF = gateY[66];
const TAU = Math.PI * 2;
const TOP_Y = 63.1;

export function buildPath(cfg) {
  const { dC, upTurns, r0, r1, crestTurns, r2, downTurns } = cfg;
  const C = [A[0], A[1] + dC];
  const th0 = Math.atan2(A[1] - C[1], A[0] - C[0]);
  const pts = [];
  const upSweep = upTurns * TAU;
  const upSteps = Math.max(40, Math.round((upSweep * (r0 + r1)) / 2 / 2));
  for (let i = 0; i <= upSteps; i++) {
    const t = i / upSteps;
    const th = th0 + upSweep * t;
    const r = r0 + (r1 - r0) * t;
    const s = t * t * (3 - 2 * t);
    pts.push({ x: C[0] + Math.cos(th) * r, z: C[1] + Math.sin(th) * r, y: yA + (TOP_Y - yA) * s, kind: 'up' });
  }
  const thUpEnd = th0 + upSweep;
  const crestSweep = crestTurns * TAU;
  const crestSteps = Math.max(10, Math.round((crestSweep * (r1 + r2)) / 2 / 2));
  for (let i = 1; i <= crestSteps; i++) {
    const t = i / crestSteps;
    const th = thUpEnd + crestSweep * t;
    const r = r1 + (r2 - r1) * (t * t * (3 - 2 * t));
    pts.push({ x: C[0] + Math.cos(th) * r, z: C[1] + Math.sin(th) * r, y: TOP_Y, kind: 'crest' });
  }
  const thD0 = thUpEnd + crestSweep;
  const downSweep = downTurns * TAU;
  const downSteps = Math.max(24, Math.round((downSweep * r2) / 2));
  for (let i = 1; i <= downSteps; i++) {
    const t = i / downSteps;
    const th = thD0 + downSweep * t;
    // 顶部 15% 还是水台（y 几乎不变），之后陡起来 —— 读作瀑布而不是平缓滑梯
    const k = Math.max(0, (t - 0.15) / 0.85);
    const y = TOP_Y + (yF - TOP_Y) * (k * k * (3 - 2 * k));
    pts.push({ x: C[0] + Math.cos(th) * r2, z: C[1] + Math.sin(th) * r2, y, kind: 'down' });
  }
  return { pts, C, th0, thUpEnd, thD0, thEnd: thD0 + downSweep };
}

export function resample(pts, count) {
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    seg.push(d); total += d;
  }
  const out = [];
  for (let k = 0; k < count; k++) {
    const s = (total * k) / (count - 1);
    let acc = 0, i = 0;
    while (i < seg.length - 1 && acc + seg[i] < s) { acc += seg[i]; i++; }
    const t = seg[i] ? Math.min(1, (s - acc) / seg[i]) : 0;
    out.push({
      x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
      z: pts[i].z + (pts[i + 1].z - pts[i].z) * t,
      y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
    });
  }
  return { out, total };
}

const segDist = (px, pz, a, b) => {
  const sx = b[0] - a[0], sz = b[1] - a[1];
  const L2 = sx * sx + sz * sz || 1;
  let t = ((px - a[0]) * sx + (pz - a[1]) * sz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - sx * t, pz - a[1] - sz * t);
};

function minRadius(g) {
  let m = Infinity;
  for (let i = 2; i < g.length - 2; i++) {
    const a = g[i - 2], b = g[i], c = g[i + 2];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (cross < 1e-6) continue;
    m = Math.min(m, (ab * bc * ca) / (2 * cross));
  }
  return m;
}

function extent(p, a, b) {
  let best = Infinity, j = -1;
  for (let k = a; k <= b; k++) {
    const d = segDist(p.x, p.z, gates[k], gates[k + 1]);
    if (d < best) { best = d; j = k; }
  }
  return { d: best, j };
}

// 补一段出口水槽（二次贝塞尔，起点沿螺旋切向）到森林口
function withExit(res, cfg, exitLen) {
  const g = res.out;
  const e = g[g.length - 1];
  const thEnd = cfg.thEnd;
  const tx = -Math.sin(thEnd), tz = Math.cos(thEnd);
  const ctl = [e.x + tx * exitLen * 0.5, e.z + tz * exitLen * 0.5];
  const pts = [...g];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8, mt = 1 - t;
    pts.push({
      x: mt * mt * e.x + 2 * mt * t * ctl[0] + t * t * F[0],
      z: mt * mt * e.z + 2 * mt * t * ctl[1] + t * t * F[1],
      y: yF,
    });
  }
  return pts;
}

const CANDIDATES = [
  { name: 'A', dC: 90, upTurns: 0.62, r0: 90, r1: 76, crestTurns: 0.10, r2: 110, downTurns: 0.50 },
  { name: 'B', dC: 86, upTurns: 0.58, r0: 86, r1: 74, crestTurns: 0.10, r2: 108, downTurns: 0.55 },
  { name: 'C', dC: 94, upTurns: 0.66, r0: 94, r1: 78, crestTurns: 0.12, r2: 116, downTurns: 0.45 },
  { name: 'D', dC: 82, upTurns: 0.70, r0: 82, r1: 70, crestTurns: 0.10, r2: 104, downTurns: 0.40 },
  { name: 'E', dC: 100, upTurns: 0.55, r0: 100, r1: 82, crestTurns: 0.12, r2: 122, downTurns: 0.60 },
];

for (const cfg of CANDIDATES) {
  const { pts, C, thEnd } = buildPath(cfg);
  const res = resample(pts, 36);
  const g2 = res.out;                                  // 门 30..65
  const toF = Math.hypot(g2[g2.length - 1].x - F[0], g2[g2.length - 1].z - F[1]);
  const all = withExit(res, { ...cfg, thEnd }, Math.max(60, toF));
  // 与"非云端段"的净空（门 0..25 楼梯/山洞、门 69..208 森林+回程）
  let clrA = { d: Infinity }, clrB = { d: Infinity };
  for (const p of all) {
    const a = extent(p, 0, 25); if (a.d < clrA.d) clrA = { ...a, p };
    const b = extent(p, 69, N - 2); if (b.d < clrB.d) clrB = { ...b, p };
  }
  // 自交：非相邻（索引差 >5）的点最近距离
  let self = Infinity, sp = null;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 5; j < all.length; j++) {
      const d = Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z);
      if (d < self) { self = d; sp = [i, j]; }
    }
  }
  console.log(
    `方案${cfg.name} dC=${cfg.dC} up=${cfg.upTurns}T r${cfg.r0}→${cfg.r1} crest=${cfg.crestTurns}T r2=${cfg.r2} down=${cfg.downTurns}T`,
  );
  console.log(
    `   塔心=(${C[0].toFixed(0)},${C[1].toFixed(0)}) 螺旋长度=${res.total.toFixed(0)}m 到森林口=${toF.toFixed(0)}m`,
    `| 最小转弯半径=${minRadius(all).toFixed(0)}m`,
  );
  console.log(
    `   净空: 楼梯侧=${clrA.d.toFixed(0)}m 森林/回程侧=${clrB.d.toFixed(0)}m(门${clrB.j})`,
    `| 自距=${self.toFixed(0)}m${sp}`,
  );
}
