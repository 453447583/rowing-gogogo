// 熔岩夜航：生成带 2 个 U 型发卡的环线，并量净空 / 转角 / 半径。
// 输出可直接粘进 maps.js 的 gates 数组。
import { MAPS } from '../src/data/maps.js';

const old = MAPS.find((m) => m.id === 'magma');
const W = old.gateWidth;
const N = Number(process.env.N || 32);
const BOUNDARY = old.boundary.r;

// 手摆航点（闭合环，逆时针）：东 / 西各一个外凸 U 型发卡。
const WP = [
  [0, -158],
  [86, -152],
  [148, -134],
  [188, -100],
  [206, -62],
  [224, -34],   // 东侧发卡：去向
  [246, -16],
  [258, 2],
  [260, 22],    // 发卡顶点（宽 U，转角摊到两三个门）
  [248, 40],    // 回程
  [226, 50],
  [206, 60],
  [196, 84],
  [208, 110],
  [196, 138],
  [156, 156],
  [80, 162],
  [0, 164],
  [-80, 162],
  [-152, 150],
  [-198, 120],
  [-214, 92],
  [-236, 74],   // 西侧发卡：去向
  [-252, 54],
  [-258, 34],
  [-256, 12],   // 发卡顶点（宽 U）
  [-244, -6],   // 回程
  [-222, -16],
  [-202, -24],
  [-196, -48],
  [-178, -88],
  [-146, -128],
  [-76, -152],
];

function resample(points, n) {
  const closed = [...points, points[0]];
  const seg = [];
  let total = 0;
  for (let i = 0; i < closed.length - 1; i++) {
    const l = Math.hypot(closed[i + 1][0] - closed[i][0], closed[i + 1][1] - closed[i][1]);
    seg.push(l); total += l;
  }
  const out = [];
  for (let k = 0; k < n; k++) {
    let s = (k / n) * total;
    let i = 0;
    while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
    const t = seg[i] ? s / seg[i] : 0;
    out.push([
      Math.round((closed[i][0] + (closed[i + 1][0] - closed[i][0]) * t) * 10) / 10,
      Math.round((closed[i][1] + (closed[i + 1][1] - closed[i][1]) * t) * 10) / 10,
    ]);
  }
  return out;
}

function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

const gates = resample(WP, N);
const len = gates.reduce((s, p, i) => {
  const q = gates[(i + 1) % gates.length];
  return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
}, 0);
const maxR = Math.max(...gates.map(([x, z]) => Math.hypot(x, z)));
const segLens = gates.map((p, i) => {
  const q = gates[(i + 1) % gates.length];
  return Math.hypot(q[0] - p[0], q[1] - p[1]);
});

let minClear = Infinity;
let minPair = null;
for (let i = 0; i < N; i++) {
  const a = gates[i], b = gates[(i + 1) % N];
  for (let j = 0; j < N; j++) {
    // 只看"赛段编号离得远"的两段：弯道里相邻/隔一段的两条边天然会靠近，
    // 那不是压线；真正要防的是赛道不同部位贴在一起。
    const di = Math.abs(i - j);
    const circ = Math.min(di, N - di);
    if (circ < Number(process.env.CIRC || 5)) continue;
    const c = gates[j], d = gates[(j + 1) % N];
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const dd = segDist(p, c, d);
      if (dd < minClear) { minClear = dd; minPair = [i, j]; }
    }
  }
}

const turns = gates.map((c, i) => {
  const p = gates[(i - 1 + N) % N], n = gates[(i + 1) % N];
  const a1 = Math.atan2(c[0] - p[0], c[1] - p[1]);
  const a2 = Math.atan2(n[0] - c[0], n[1] - c[1]);
  let d = Math.abs(a2 - a1);
  while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
  return (d * 180) / Math.PI;
});

const oldLen = old.gates.reduce((s, p, i) => {
  const q = old.gates[(i + 1) % old.gates.length];
  return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
}, 0);

console.log('gates:', JSON.stringify(gates));
console.log('N', N, 'lap', len.toFixed(1), '(old', oldLen.toFixed(1), ')');
console.log('max radius', maxR.toFixed(1), '<=', BOUNDARY);
console.log('min segment', Math.min(...segLens).toFixed(1));
console.log('min clearance', minClear.toFixed(1), 'at', minPair, 'need >=', W * 2);
console.log('turns deg:', turns.map((t, i) => `${i}:${t.toFixed(0)}`).join(' '));
console.log('sharp >60:', JSON.stringify(turns.map((t, i) => [i, +t.toFixed(0)]).filter(([, t]) => t > 60)));
console.log('hairpin gate window east:', turns.map((t, i) => [i, +t.toFixed(0)]).filter(([i]) => i > 3 && i < 12));
console.log('hairpin gate window west:', turns.map((t, i) => [i, +t.toFixed(0)]).filter(([i]) => i > 18 && i < 28));
