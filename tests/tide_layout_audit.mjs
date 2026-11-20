// 冰汐海峡（tide）走线几何自检
//
// 目的：maps.js 里的坐标是手写的，肉眼看不出"两条走廊在拐角处压在一起"、
// "近道中段其实贴着主道跑"这类问题。这个脚本把每条约束都量化出来：
//   ① 单圈长度 / 每段长度（段长要刻意不均）
//   ② 主道自身走廊是否重叠（非相邻段中点距离 vs 2×gateWidth）
//   ③ 近道：长度收益、两端是否落在门附近、中段是否真的离开了主道走廊
//   ④ 暗礁：是否压主道或近道
//   ⑤ 领奖台：是否离所有门足够远、是否在冰区/潮汐区里
//   ⑥ 最远点半径 / 边界余量
//
// 用法：node tests/tide_layout_audit.mjs [--verbose]
import { MAPS } from '../src/data/maps.js';

const map = MAPS.find((m) => m.id === 'tide');
if (!map) throw new Error('tide map missing');
const G = map.gates;
const N = G.length;
const W = map.gateWidth;
const verbose = process.argv.includes('--verbose');

const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const polyLen = (pts) => pts.slice(1).reduce((s, p, i) => s + segLen(pts[i], p), 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function distPointSeg(px, pz, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz || 1;
  const t = clamp(((px - a[0]) * dx + (pz - a[1]) * dz) / l2, 0, 1);
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

function distPointPolyline(px, pz, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distPointSeg(px, pz, pts[i], pts[i + 1]));
  return best;
}

// 主道：所有段（含闭合段）
const mainSegs = G.map((g, i) => [g, G[(i + 1) % N]]);
const distToMain = (x, z) => Math.min(...mainSegs.map(([a, b]) => distPointSeg(x, z, a, b)));
const distToShortcuts = (x, z) => Math.min(
  Infinity,
  ...(map.shortcuts || []).map((sc) => distPointPolyline(x, z, sc.points)),
);

const problems = [];
const warn = (msg) => problems.push(msg);

// ---------- ① 总长 / 段长 ----------
const lap = polyLen([...G, G[0]]);
const lens = G.map((g, i) => segLen(g, G[(i + 1) % N]));
console.log(`lap = ${lap.toFixed(1)} m   gateWidth = ${W}   shortcuts = ${map.shortcuts?.length ?? 0}`);
console.log('seg lengths:', lens.map((v) => v.toFixed(0)).join(' '));
console.log(`seg min/max/avg = ${Math.min(...lens).toFixed(0)} / ${Math.max(...lens).toFixed(0)} / ${(lap / N).toFixed(0)}`);
if (Math.min(...lens) < 30) warn(`段长过短：${Math.min(...lens).toFixed(1)}m`);
if (Math.max(...lens) / Math.min(...lens) < 1.35) warn('段长过于均匀（最长/最短 < 1.35），会显得机械');

// ---------- ② 主道自身走廊重叠 ----------
// 只比较"隔着至少一段"的段对；距离 < 2×gateWidth 就是两条走廊糊在一起。
let minPair = { d: Infinity };
for (let i = 0; i < N; i++) {
  for (let j = i + 1; j < N; j++) {
    if (j === i + 1 || (i === 0 && j === N - 1)) continue;
    // 两条线段的最小距离（端点交叉检查足够：段长 >> 宽度）
    const [a1, a2] = mainSegs[i];
    const [b1, b2] = mainSegs[j];
    let d = Math.min(
      distPointSeg(a1[0], a1[1], b1, b2),
      distPointSeg(a2[0], a2[1], b1, b2),
      distPointSeg(b1[0], b1[1], a1, a2),
      distPointSeg(b2[0], b2[1], a1, a2),
    );
    if (d < minPair.d) minPair = { d, i, j };
    if (d < W * 2) warn(`主道走廊重叠：段 ${i} 与段 ${j} 仅 ${d.toFixed(1)}m（< 2×gateWidth=${W * 2}）`);
  }
}
console.log(`主道最近的非相邻段间距 = ${minPair.d.toFixed(1)}m（段 ${minPair.i} ↔ ${minPair.j}）`);

// ---------- ③ 近道 ----------
for (const sc of map.shortcuts || []) {
  const sk = (sc.to - sc.from + N) % N;
  const mainPts = [];
  for (let k = 0; k <= sk; k++) mainPts.push(G[(sc.from + k) % N]);
  const mainL = polyLen(mainPts);
  const scL = polyLen(sc.points);
  const save = (1 - scL / mainL) * 100;
  const mouthIn = Math.hypot(sc.points[0][0] - G[sc.from][0], sc.points[0][1] - G[sc.from][1]);
  const mouthOut = Math.hypot(sc.points.at(-1)[0] - G[sc.to][0], sc.points.at(-1)[1] - G[sc.to][1]);
  // 中段（去掉首末点）到主道的净空。两端本来就该汇入主道，只查中段。
  let mid = Infinity;
  for (const p of sc.points.slice(1, -1)) mid = Math.min(mid, distToMain(p[0], p[1]));
  console.log(`shortcut #${sc.from}→#${sc.to}: ${mainL.toFixed(0)} → ${scL.toFixed(0)} m  省 ${save.toFixed(1)}%  `
    + `口 ${mouthIn.toFixed(1)}/${mouthOut.toFixed(1)}m  中段净空 ${mid.toFixed(1)}m`);
  if (save < 8) warn(`近道 #${sc.from}→#${sc.to} 收益只有 ${save.toFixed(1)}%`);
  if (save > 45) warn(`近道 #${sc.from}→#${sc.to} 收益 ${save.toFixed(1)}% 过大，等于废掉主道`);
  if (mouthIn > W * 2.2 || mouthOut > W * 2.2) warn(`近道 #${sc.from}→#${sc.to} 端口离门太远`);
  if (mid < W + sc.width) warn(`近道 #${sc.from}→#${sc.to} 中段离主道中线仅 ${mid.toFixed(1)}m（应 ≥ ${(W + sc.width).toFixed(1)}）`);
  // 中段每一点都要满足
  if (verbose) {
    sc.points.forEach((p, i) => console.log(`   p${i} (${p[0]},${p[1]})  →main ${distToMain(p[0], p[1]).toFixed(1)}`));
  }
}

// ---------- ④ 暗礁 ----------
for (const r of map.rocks || []) {
  const dRoute = distToMain(r.x, r.z);
  const dSc = distToShortcuts(r.x, r.z);
  const need = W + r.r + 2;
  if (dRoute < need) warn(`暗礁 (${r.x},${r.z}) 压主道：${dRoute.toFixed(1)} < ${need.toFixed(1)}`);
  if (dSc < r.r + (map.shortcuts?.[0]?.width ?? 3.5) + 2) warn(`暗礁 (${r.x},${r.z}) 压近道：${dSc.toFixed(1)}`);
}
console.log(`rocks checked: ${(map.rocks || []).length}`);

// ---------- ⑤ 领奖台 ----------
const pod = map.podium;
const nearest = Math.min(...G.map(([x, z]) => Math.hypot(pod.x - x, pod.z - z)));
const podR = Math.hypot(pod.x, pod.z);
console.log(`podium 最近门距 ${nearest.toFixed(1)}m（需 > ${W * 3}）  r=${podR.toFixed(1)}`);
if (nearest < W * 3) warn('领奖台离某个门太近');
if (podR > map.boundary.r) warn('领奖台跑到边界外了');
if (map.iceZone) {
  const dIce = Math.hypot(pod.x - map.iceZone.x, pod.z - map.iceZone.z);
  if (dIce < map.iceZone.r) warn(`领奖台落在冰区里（距冰心 ${dIce.toFixed(1)} < ${map.iceZone.r}）`);
}
if (map.current) {
  const dCur = Math.hypot(pod.x - map.current.x, pod.z - map.current.z);
  if (dCur < map.current.r) warn(`领奖台落在潮汐区里（距潮心 ${dCur.toFixed(1)} < ${map.current.r}）`);
}

// ---------- ⑥ 半径 / 边界 ----------
const radii = G.map(([x, z]) => Math.hypot(x, z));
console.log(`gate r: max ${Math.max(...radii).toFixed(1)}  min ${Math.min(...radii).toFixed(1)}  `
  + `boundary ${map.boundary.r} → 余量 ${(map.boundary.r - Math.max(...radii)).toFixed(1)}m`);
if (Math.max(...radii) + W * 1.2 > map.boundary.r) warn('赛道最外缘顶到 boundary，会被硬推回');

// ---------- ⑦ 冰区覆盖 ----------
if (map.iceZone) {
  const ice = map.iceZone;
  const inside = G.map(([x, z], i) => [i, Math.hypot(x - ice.x, z - ice.z) <= ice.r]);
  console.log('iceZone covers gates:', inside.filter(([, v]) => v).map(([i]) => i).join(','));
}

console.log('');
if (problems.length) {
  console.log('FAIL:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log('tide layout audit: PASS');
