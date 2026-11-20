// 熔岩硬核档 Step 2：发卡内切近道的纯几何净空审计（Node，不需要浏览器）。
// 用法：node tests/magma_shortcut_audit.mjs
// 检查：长度收益 / 端点吸附 / 非相邻主道净空 / 与静态岩石·机关·裂谷的距离 / 折线转角。
import assert from 'node:assert/strict';
import { MAPS } from '../src/data/maps.js';
import { faultRects } from '../src/utils/faults.js';

const map = MAPS.find((m) => m.id === 'magma');
assert.ok(map, 'magma map exists');
const G = map.gates;
const N = G.length;
const W = map.gateWidth;

const distPointSeg = (p, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz || 1;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
};
const distPointPolyline = (p, pts) => {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distPointSeg(p, pts[i], pts[i + 1]));
  return d;
};
const samples = (pts, step = 2) => {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
};
const routePose = (gi, side) => {
  const a = G[((gi % N) + N) % N], b = G[(gi + 1) % N];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  const fx = dx / len, fz = dz / len;
  return [(a[0] + b[0]) * 0.5 - fz * side, (a[1] + b[1]) * 0.5 + fx * side];
};
const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

// 所有固定门号实体：Blender 岩石代理 / 静态礁石 / 熔岩机关
const solids = [];
for (const o of map.magmaObstacles || []) {
  const [x, z] = routePose(o.gate, o.side * W * 0.5);
  solids.push({ name: `glb@${o.gate}`, x, z, r: o.r });
}
for (const r of map.rocks || []) solids.push({ name: 'rock', x: r.x, z: r.z, r: r.r * (r.s ?? 1) });
for (const d of map.magmaHazards.drifters || []) {
  const [x, z] = routePose(d.gate, 0);
  solids.push({ name: `drifter@${d.gate}`, x, z, r: d.r + d.span * W });
}
for (const g of map.magmaHazards.geysers || []) {
  const [x, z] = routePose(g.gate, g.side * W);
  solids.push({ name: `geyser@${g.gate}`, x, z, r: g.r });
}
for (const b of map.magmaHazards.rollers || []) {
  const [x, z] = routePose(b.gate, 0);
  solids.push({ name: `roller@${b.gate}`, x, z, r: b.r });
}
for (const r of map.magmaHazards.impactRocks || []) {
  const [x, z] = routePose(r.gate, r.side * W);
  solids.push({ name: `impact@${r.gate}`, x, z, r: r.r });
}
const faults = faultRects(map);

assert.ok((map.shortcuts || []).length >= 2, 'magma hardcore ships two hairpin shortcuts');
const report = [];
for (const sc of map.shortcuts) {
  assert.ok(sc.width <= W * 0.42, `shortcut ${sc.from}-${sc.to} stays narrow`);
  assert.ok(sc.from >= 2 && sc.to <= N - 3, `shortcut ${sc.from}-${sc.to} stays mid-course`);
  const mouth = Math.hypot(sc.points[0][0] - G[sc.from][0], sc.points[0][1] - G[sc.from][1]);
  const merge = Math.hypot(sc.points.at(-1)[0] - G[sc.to][0], sc.points.at(-1)[1] - G[sc.to][1]);
  assert.ok(mouth < W * 2.2 && merge < W * 2.2, `shortcut ${sc.from}-${sc.to} mouths sit beside their gates`);
  const mainPts = [];
  for (let g = sc.from; ; g = (g + 1) % N) { mainPts.push(G[g]); if (g === sc.to) break; }
  const mainLen = len(mainPts), scLen = len(sc.points);
  assert.ok(scLen < mainLen, `shortcut ${sc.from}-${sc.to} gives a real route-length reward`);

  // 中段必须真的离开主道走廊，且不能贴到「非相邻」赛段（含回程/对侧）
  const pts = samples(sc.points);
  let minFar = Infinity, farGate = -1;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const nearSpan = i >= sc.from - 1 && i <= sc.to;
    if (nearSpan) continue;
    for (const p of pts) minFar = Math.min(minFar, distPointSeg(p, G[i], G[j]));
  }
  assert.ok(minFar > W + sc.width * 0.5 + 6,
    `shortcut ${sc.from}-${sc.to} keeps ${(W + sc.width * 0.5 + 6).toFixed(1)}m from other segments (got ${minFar.toFixed(1)})`);

  let minSolid = Infinity, solidName = '';
  for (const s of solids) {
    for (const p of pts) {
      const d = Math.hypot(p[0] - s.x, p[1] - s.z) - s.r;
      if (d < minSolid) { minSolid = d; solidName = s.name; }
    }
  }
  assert.ok(minSolid > sc.width + 3,
    `shortcut ${sc.from}-${sc.to} clears solids; closest ${solidName} at ${minSolid.toFixed(1)}m`);

  let minFault = Infinity;
  for (const f of faults) {
    for (const p of pts) {
      const dx = p[0] - f.cx, dz = p[1] - f.cz;
      const along = Math.abs(dx * f.fx + dz * f.fz) - f.width * 0.5;
      const across = Math.abs(dx * f.nx + dz * f.nz) - f.halfAcross;
      minFault = Math.min(minFault, Math.max(along, across));
    }
  }
  assert.ok(minFault > 2,
    `shortcut ${sc.from}-${sc.to} does not cut across a fault rectangle (margin ${minFault.toFixed(1)}m)`);

  // 折线最大转角：>12° 才读作「带弯的近道」，<70° 才不会折出空气墙
  let maxTurn = 0;
  for (let i = 1; i < sc.points.length - 1; i++) {
    const p = sc.points[i - 1], c = sc.points[i], n = sc.points[i + 1];
    const a1 = Math.atan2(c[0] - p[0], c[1] - p[1]);
    const a2 = Math.atan2(n[0] - c[0], n[1] - c[1]);
    let d = Math.abs(a2 - a1);
    while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
    maxTurn = Math.max(maxTurn, d * 180 / Math.PI);
  }
  assert.ok(maxTurn > 12 && maxTurn < 70, `shortcut ${sc.from}-${sc.to} has a readable bend (${maxTurn.toFixed(1)}deg)`);

  report.push({
    span: `${sc.from}-${sc.to}`, width: sc.width,
    shortcutMeters: +scLen.toFixed(1), mainMeters: +mainLen.toFixed(1),
    savedMeters: +(mainLen - scLen).toFixed(1),
    mouth: +mouth.toFixed(1), merge: +merge.toFixed(1),
    minDistOtherSegments: +minFar.toFixed(1),
    minSolidClearance: +minSolid.toFixed(1), closestSolid: solidName,
    minFaultMargin: +minFault.toFixed(1), maxTurnDeg: +maxTurn.toFixed(1),
  });
}
console.log('PASS：熔岩两条发卡内切近道几何全部通过');
console.log(JSON.stringify(report, null, 1));
