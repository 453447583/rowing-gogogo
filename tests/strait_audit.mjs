// 霓虹海峡（strait）几何自检：高度剖面 + 边缘浮桶覆盖
//
// 目的：用户报了两个现象——
//   ① 最后直道赛艇 Y 抬升，但下方没有水面（悬空）
//   ② 赛道很多边缘没有浮桶，"漫无边际"
// 这两件事都能量化，不靠看图猜：
//   ① 沿中心线每 5m 采样，复算 Track.#gateHeightAt（逐门高度图的插值），
//      找出所有"应该贴水面却被判成有高度"的区间；
//   ② 复算 Track.#buildEdgeBuoys 的取样逻辑，按弧长统计每条浮绳的覆盖与断口。
//
// 用法：node tests/strait_audit.mjs [mapId]
import { MAPS } from '../src/data/maps.js';

const id = process.argv[2] || 'strait';
const map = MAPS.find((m) => m.id === id);
if (!map) throw new Error(`map ${id} missing`);
const G = map.gates;
const N = G.length;
const W = map.gateWidth;
const H = map.gateHeights && map.gateHeights.length === N ? map.gateHeights : null;

console.log(`== ${map.name} (${id}) ==  gates=${N} gateWidth=${W} heights=${H ? 'yes' : 'no'}`);

// ---------- ① 高度：复算 #gateHeightAt ----------
function gateHeightAt(x, z) {
  if (!H) return 0;
  let best = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const y0 = H[i], y1 = H[j];
    if (y0 < 0.02 && y1 < 0.02) continue;
    const a = G[i], b = G[j];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1;
    const L = Math.sqrt(l2);
    let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const cx = a[0] + dx * t, cz = a[1] + dz * t;
    // 与 Track.#gateHeightAt 保持一致：用点到线段的真距离（2026-11-03 修正）
    if (Math.hypot(x - cx, z - cz) > W + 1.1) continue;
    const h = y0 + (y1 - y0) * t;
    if (h > best) best = h;
  }
  return best;
}

const raised = [];
for (let i = 0; i < N; i++) {
  const a = G[i], b = G[(i + 1) % N];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(2, Math.ceil(len / 5));
  const seg = { i, len, hi: -1, hiAt: 0, samples: [] };
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[1] + (b[1] - a[1]) * t;
    const h = gateHeightAt(x, z);
    seg.samples.push(h);
    if (h > seg.hi) { seg.hi = h; seg.hiAt = t; }
  }
  if (seg.hi > 0.25) raised.push(seg);
}
console.log('\n-- ① 有高度的段（h > 0.25）--');
if (!raised.length) console.log('  （无）');
for (const s of raised) {
  console.log(`  #${s.i} len=${s.len.toFixed(0)}m  maxH=${s.hi.toFixed(2)} @t=${s.hiAt.toFixed(2)}`
    + `  门高 ${H[s.i]}→${H[(s.i + 1) % N]}`);
}
// 声明了高度但实际算不出高度的段（浮桶被误裁的嫌疑）
if (H) {
  const declared = H.map((h, i) => ({ i, h })).filter((x) => x.h > 0.02);
  console.log('  声明有高度的门:', declared.map((d) => `#${d.i}=${d.h}`).join(' '));
}

// ---------- ② 浮桶覆盖：复算取样 ----------
// 只复算"主道两侧"，与 Track.#buildEdgeBuoys 里的 buildDense + sampleSide 等价。
const off = Math.max(2, W - 0.6);
const stations = [];
const gaps = new Map([[1, []], [-1, []]]);
const mainLoop = [...G, G[0]];
function nearestOnPolyline(pts, px, pz) {
  let bd = Infinity, bseg = 0, bt = 0, bpx = 0, bpz = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1;
    let t = ((px - a[0]) * dx + (pz - a[1]) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = a[0] + dx * t, qz = a[1] + dz * t;
    const d = Math.hypot(px - qx, pz - qz);
    if (d < bd) { bd = d; bseg = i; bt = t; bpx = qx; bpz = qz; }
  }
  return { d: bd, seg: bseg, t: bt, px: bpx, pz: bpz };
}
for (const sc of map.shortcuts || []) {
  const pts = sc.points;
  if (!Array.isArray(pts) || pts.length < 2) continue;
  const ends = [
    { p: pts[0], out: [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]] },
    { p: pts.at(-1), out: [pts.at(-2)[0] - pts.at(-1)[0], pts.at(-2)[1] - pts.at(-1)[1]] },
  ];
  for (const e of ends) {
    const loc = nearestOnPolyline(mainLoop, e.p[0], e.p[1]);
    const seg = Math.min(loc.seg, N - 1);
    const a = G[seg], b = G[(seg + 1) % N];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    const onLeft = e.out[0] * -uz + e.out[1] * ux;
    let gate = -1, gd = Infinity;
    for (let i = 0; i < N; i++) {
      const d = Math.hypot(G[i][0] - e.p[0], G[i][1] - e.p[1]);
      if (d < gd) { gd = d; gate = i; }
    }
    if (gate < 0 || gd > 12) continue;
    gaps.get(onLeft >= 0 ? 1 : -1).push({ gate, half: sc.width + 2.0 });
  }
}

const turnAt = [];
for (let i = 0; i < N; i++) {
  const p = G[(i - 1 + N) % N], c = G[i], n = G[(i + 1) % N];
  const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]);
  const a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  turnAt.push(d);
}

function buildDense(pts, halfW, side, closed, turns, gapList, keepFn) {
  const M = pts.length;
  const segCount = closed ? M : M - 1;
  const dirs = [], normals = [];
  for (let i = 0; i < segCount; i++) {
    const a = pts[i], b = pts[(i + 1) % M];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    dirs.push([dx / len, dz / len]);
    normals.push([-dz / len, dx / len]);
  }
  const cornerSets = [];
  for (let i = 0; i < M; i++) {
    const v = pts[i], set = [];
    if (!closed && i === 0) {
      const n = normals[0];
      set.push([v[0] + n[0] * side * halfW, v[1] + n[1] * side * halfW]);
    } else if (!closed && i === M - 1) {
      const n = normals[segCount - 1];
      set.push([v[0] + n[0] * side * halfW, v[1] + n[1] * side * halfW]);
    } else {
      const d1 = dirs[(i - 1 + segCount) % segCount];
      const d2 = dirs[i % segCount];
      const turn = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
      const n = normals[(i - 1 + segCount) % segCount];
      const n2 = normals[i % segCount];
      const ux = n[0] * side, uz = n[1] * side;
      if (Math.abs(turn) < 0.004) {
        set.push([v[0] + ux * halfW, v[1] + uz * halfW]);
      } else if (side * turn > 0) {
        const p1x = v[0] + n[0] * side * halfW, p1z = v[1] + n[1] * side * halfW;
        const p2x = v[0] + n2[0] * side * halfW, p2z = v[1] + n2[1] * side * halfW;
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(den) < 1e-6) set.push([p1x, p1z]);
        else {
          const t = ((p2x - p1x) * d2[1] - (p2z - p1z) * d2[0]) / den;
          set.push([p1x + d1[0] * t, p1z + d1[1] * t]);
        }
      } else {
        const steps = Math.max(1, Math.ceil(halfW * Math.abs(turn) / 3));
        for (let k = 0; k <= steps; k++) {
          const ang = turn * (k / steps);
          const c = Math.cos(ang), s = Math.sin(ang);
          set.push([v[0] + (ux * c - uz * s) * halfW, v[1] + (ux * s + uz * c) * halfW]);
        }
      }
    }
    cornerSets.push(set);
  }
  const dense = [];
  const push = (x, z, step) => {
    const last = dense[dense.length - 1];
    if (last && Math.hypot(last.x - x, last.z - z) < 0.02) return;
    dense.push({ x, z, step, keep: true });
  };
  const cornerIdx = [];
  for (let i = 0; i < M; i++) {
    const step = closed ? (Math.abs(turns[i]) > 0.35 ? 8 : 14) : 11;
    const start = dense.length;
    for (const p of cornerSets[i]) push(p[0], p[1], step);
    cornerIdx[i] = { a: start, b: dense.length - 1 };
    if (closed || i < M - 1) {
      const A = cornerSets[i][cornerSets[i].length - 1];
      const B = cornerSets[(i + 1) % M][0];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
      const n = Math.max(1, Math.ceil(L / 3));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        push(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, step);
      }
    }
  }
  let s = 0;
  for (let i = 0; i < dense.length; i++) {
    if (i > 0) s += Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z);
    dense[i].s = s;
  }
  const totalLen = s;
  for (const g of gapList) {
    const ci = cornerIdx[g.gate];
    if (!ci) continue;
    const center = (dense[ci.a].s + dense[ci.b].s) / 2;
    for (const d of dense) {
      let diff = Math.abs(d.s - center);
      if (closed) diff = Math.min(diff, totalLen - diff);
      if (diff <= g.half) d.keep = false;
    }
  }
  if (keepFn) for (const d of dense) if (d.keep && !keepFn(d.x, d.z)) d.keep = false;
  if (!closed) for (const d of dense) if (d.s < 8 || d.s > totalLen - 8) d.keep = false;
  return dense;
}

// 与 Track 一致：有逐门高度图时，只在水面段（高度 <= 0.25）铺浮桶
const keepFn = H ? (x, z) => gateHeightAt(x, z) <= 0.25 : null;

// 按弧长把每侧浮桶建成"断口列表"
for (const side of [1, -1]) {
  const dense = buildDense(G, off, side, true, turnAt, gaps.get(side) || [], keepFn);
  let acc = 0, next = 7, run = [];
  const runs = [];
  for (let i = 0; i < dense.length - 1; i++) {
    const p0 = dense[i], p1 = dense[i + 1];
    const L = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    if (L < 1e-4) continue;
    const keep = p0.keep && p1.keep;
    while (next <= acc + L) {
      const t = (next - acc) / L;
      const st = { x: p0.x + (p1.x - p0.x) * t, z: p0.z + (p1.z - p0.z) * t, s: next };
      if (keep) {
        if (!run.length) runs.push(run);
        run.push(st);
        stations.push({ ...st, side });
      } else run = [];
      next += p1.step || p0.step || 12;
    }
    acc += L;
  }
  // 断口（弧长 > 30m 的空档）
  const cuts = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const a = runs[i].at(-1), b = runs[i + 1][0];
    if (b.s - a.s > 30) cuts.push({ from: a.s, to: b.s, len: b.s - a.s, x: a.x, z: a.z });
  }
  console.log(`\n-- ② 侧 ${side > 0 ? '+1' : '-1'}：浮桶 ${runs.reduce((s, r) => s + r.length, 0)} 个，`
    + `${runs.length} 段浮绳，断口(>30m) ${cuts.length} 处 --`);
  for (const c of cuts) {
    // 断口对应哪个门段
    const loc = nearestOnPolyline(mainLoop, c.x, c.z);
    console.log(`  断口 ${c.len.toFixed(0)}m  @弧长 ${c.from.toFixed(0)}→${c.to.toFixed(0)}`
      + `  起点附近门 #${Math.min(loc.seg, N - 1)}  位置 (${c.x.toFixed(0)}, ${c.z.toFixed(0)})`);
  }
}

// 覆盖率：沿中心线每 10m，左右各 12m 外是否有浮桶
let miss = 0, total = 0;
const missList = [];
for (let i = 0; i < N; i++) {
  const a = G[i], b = G[(i + 1) % N];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.max(1, Math.ceil(len / 10));
  for (let k = 0; k < n; k++) {
    const t = k / n;
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    if (H && gateHeightAt(x, z) > 0.25) continue;   // 抬高栈道本来就不铺浮桶
    const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
    total++;
    let bad = 0;
    for (const side of [1, -1]) {
      // 该侧 ±10m 横向范围内有没有桶
      const px = x + -dz * side * off, pz = z + dx * side * off;
      const hit = stations.some((s) => Math.hypot(s.x - px, s.z - pz) < 14);
      if (!hit) bad++;
    }
    if (bad === 2) { miss++; missList.push({ i, t, x, z }); }
  }
}
console.log(`\n-- ③ 覆盖率：中心线 ${total} 个采样点，两侧都缺桶 ${miss} 个 `
  + `(${(miss / Math.max(1, total) * 100).toFixed(0)}%) --`);
const byGate = new Map();
for (const m of missList) byGate.set(m.i, (byGate.get(m.i) || 0) + 1);
if (byGate.size) console.log('  缺桶门段:', [...byGate.entries()].map(([i, c]) => `#${i}×${c}`).join(' '));
