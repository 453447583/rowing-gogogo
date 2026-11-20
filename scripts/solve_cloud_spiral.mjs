// 秘境漂流「云端螺旋塔」布局求解器（离线，不写文件）
//
// 约束：
//   ① 门 29（楼梯尽头）固定：A=(389.39,10.62) y=13.05，入口方向原本朝东，
//      所以螺旋中心只能放在 A 的正北（dC>0）→ 逆时针切线正好还是朝东，衔接才顺。
//   ② 门 66（森林入口）固定：F=(434,402) y=8。
//   ③ 门号数量不变（30..65 共 36 个槽）→ edgeDrop / jumps / returnFrom 全都不用改号。
//   ④ 上升圈与下降圈同心不同半径，永不自交（这是"穿模"的根）。
//   ⑤ 整段（含出口水槽）长度 520~760m；原来约 530m，整圈 3052m 不至于被拉爆。
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

// 由 A 正北 dC 处作塔心；逆时针（θ 增大）
function buildPath(cfg) {
  const { dC, upTurns, r0, r1, downTurns, r2, exitLen } = cfg;
  const C = [A[0], A[1] + dC];
  const th0 = Math.atan2(A[1] - C[1], A[0] - C[0]);       // = -90°
  const pts = [];
  const upSweep = upTurns * TAU;

  const upSteps = Math.max(30, Math.round(upSweep * (r0 + r1) / 2 / 2));
  for (let i = 0; i <= upSteps; i++) {
    const t = i / upSteps;
    const th = th0 + upSweep * t;
    const r = r0 + (r1 - r0) * t;
    const y = yA + (TOP_Y - yA) * (t * t * (3 - 2 * t));
    pts.push({ x: C[0] + Math.cos(th) * r, z: C[1] + Math.sin(th) * r, y, kind: 'up' });
  }
  // 顶部外扩：把下降螺旋推到外圈，两圈径向至少差 26m
  const thUpEnd = th0 + upSweep;
  const crestSweep = 0.14 * TAU;
  const crestSteps = 14;
  for (let i = 1; i <= crestSteps; i++) {
    const t = i / crestSteps;
    const th = thUpEnd + crestSweep * t;
    const r = r1 + (r2 - r1) * (t * t * (3 - 2 * t));
    pts.push({ x: C[0] + Math.cos(th) * r, z: C[1] + Math.sin(th) * r, y: TOP_Y, kind: 'crest' });
  }
  // 下降螺旋
  const thD0 = thUpEnd + crestSweep;
  const downSweep = downTurns * TAU;
  const downSteps = Math.max(16, Math.round(downSweep * r2 / 2));
  for (let i = 1; i <= downSteps; i++) {
    const t = i / downSteps;
    const th = thD0 + downSweep * t;
    const y = TOP_Y + (yF - TOP_Y) * (t * t);
    pts.push({ x: C[0] + Math.cos(th) * r2, z: C[1] + Math.sin(th) * r2, y, kind: 'down' });
  }
  // 出口水槽：从下降末端平滑接向森林口 F（二次贝塞尔，起点沿螺旋切向）
  const e = pts[pts.length - 1];
  const exitSteps = Math.max(2, Math.round(exitLen / 6));
  const thEnd = thD0 + downSweep;
  const tx = -Math.sin(thEnd), tz = Math.cos(thEnd);
  const ctl = [e.x + tx * exitLen * 0.55, e.z + tz * exitLen * 0.55];
  for (let i = 1; i <= exitSteps; i++) {
    const t = i / exitSteps;
    const mt = 1 - t;
    const x = mt * mt * e.x + 2 * mt * t * ctl[0] + t * t * F[0];
    const z = mt * mt * e.z + 2 * mt * t * ctl[1] + t * t * F[1];
    pts.push({ x, z, y: yF, kind: 'exit' });
  }
  return { pts, C, th0, thUpEnd, thD0, thEnd };
}

function resample(pts, count) {
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

function minRadius(g) {
  let minR = Infinity;
  for (let i = 2; i < g.length - 2; i++) {
    const a = g[i - 2], b = g[i], c = g[i + 2];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (cross < 1e-6) continue;
    minR = Math.min(minR, (ab * bc * ca) / (2 * cross));
  }
  return minR;
}

const segDist = (px, pz, a, b) => {
  const sx = b[0] - a[0], sz = b[1] - a[1];
  const L2 = sx * sx + sz * sz || 1;
  let t = ((px - a[0]) * sx + (pz - a[1]) * sz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - sx * t, pz - a[1] - sz * t);
};

function clearance(g) {
  let d = Infinity, j = -1;
  for (const p of g) {
    for (let k = 0; k < N - 1; k++) {
      if (k >= 26 && k <= 68) continue;
      const v = segDist(p.x, p.z, gates[k], gates[k + 1]);
      if (v < d) { d = v; j = k; }
    }
  }
  return { d, j };
}

// 同段自相交检查：非相邻点太近 = 两条走廊会互相穿
function selfGap(g) {
  let d = Infinity, pair = null;
  for (let i = 0; i < g.length; i++) {
    for (let j = i + 5; j < g.length; j++) {
      const v = Math.hypot(g[i].x - g[j].x, g[i].z - g[j].z);
      if (v < d) { d = v; pair = [i, j]; }
    }
  }
  return { d, pair };
}

const cfgs = [];
for (const dC of [64, 70, 76, 82, 90]) {
  for (const upTurns of [0.55, 0.62, 0.7, 0.78, 0.86]) {
    for (const r0 of [62, 68, 74, 80]) {
      for (const r1 of [56, 62, 68, 74]) {
        for (const downTurns of [0.3, 0.36, 0.42, 0.5]) {
          for (const gap of [26, 34, 42]) {
            cfgs.push({ dC, upTurns, r0, r1, downTurns, r2: r1 + gap, exitLen: 150 });
          }
        }
      }
    }
  }
}

const rows = [];
for (const cfg of cfgs) {
  const { pts, C } = buildPath(cfg);
  const { out, total } = resample(pts, 37);
  const g2 = out.slice(0, 36);                 // 门 30..65
  rows.push({
    ...cfg, total, mr: minRadius(g2),
    clr: clearance(g2).d, clj: clearance(g2).j,
    sg: selfGap(g2).d, sgp: selfGap(g2).pair, C,
  });
}

const ok = rows.filter((r) => r.mr > 30 && r.clr > 36 && r.sg > 34 && r.total > 520 && r.total < 780 && r.clj > 68);
ok.sort((a, b) => Math.abs(a.total - 650) - Math.abs(b.total - 650));
console.log('候选数', ok.length, '/', rows.length);
for (const r of ok.slice(0, 12)) {
  console.log(
    `dC=${r.dC} up=${r.upTurns}T r0=${r.r0}→${r.r1} down=${r.downTurns}T r2=${r.r2}`,
    `| 长度=${r.total.toFixed(0)} 半径=${r.mr.toFixed(0)} 净空=${r.clr.toFixed(0)}(门${r.clj}) 自距=${r.sg.toFixed(0)}(门${r.sgp})`,
  );
}
const stat = (k) => {
  const v = rows.map((r) => r[k]).filter(Number.isFinite).sort((a, b) => a - b);
  return `${k}: ${v[0]?.toFixed(1)}/${v[(v.length / 2) | 0]?.toFixed(1)}/${v[v.length - 1]?.toFixed(1)}`;
};
console.log('[诊断 min/p50/max]', stat('mr'), '|', stat('clr'), '|', stat('sg'), '|', stat('total'));
