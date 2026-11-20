// 一次性验证脚本：复刻 Track.js 全图链（v7 链式弹道放置）几何，验证弹射模式
import { MAPS } from '../src/data/maps.js';

function nearestOnPolyline(pts, x, z) {
  let best = { d: Infinity, u: 0, seg: 0, t: 0 };
  let total = 0;
  const lens = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    lens.push(len); total += len;
  }
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const sx = b[0] - a[0], sz = b[1] - a[1];
    const len2 = sx * sx + sz * sz || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (z - a[1]) * sz) / len2));
    const d = Math.hypot(x - (a[0] + sx * t), z - (a[1] + sz * t));
    if (d < best.d) best = { d, u: (acc + lens[i] * t) / total, seg: i, t };
    acc += lens[i];
  }
  return best;
}

let allOk = true;

for (const map of MAPS) {
  const gates = map.gates;
  const gateWidth = map.gateWidth;
  const dives = (map.dives || []).map((d) => ({ ...d, points: gates.slice(d.from, d.to + 1) }));
  const shortcuts = map.shortcuts || [];
  const coasterDef = map.coaster ? { ...map.coaster, ...(map.coasterFixed || {}) } : null;

  const N = gates.length;
  const cum = [0];
  for (let i = 0; i < N; i++) {
    const a = gates[i], b = gates[(i + 1) % N];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[N] || 1;
  const cumUpTo = (gi) => { let s = 0; const stop = ((gi % N) + N) % N; for (let i = 0; i < stop; i++) { const a = gates[i], b = gates[(i + 1) % N]; s += Math.hypot(b[0] - a[0], b[1] - a[1]); } return s; };

  function routeAdvance(x, z, dist) {
    let best = { seg: 0, t: 0, d: Infinity };
    for (let i = 0; i < N; i++) {
      const a = gates[i], b = gates[(i + 1) % N];
      const sx = b[0] - a[0], sz = b[1] - a[1];
      const len2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (z - a[1]) * sz) / len2));
      const d = Math.hypot(x - (a[0] + sx * t), z - (a[1] + sz * t));
      if (d < best.d) best = { seg: i, t, d };
    }
    let s = cum[best.seg] + (cum[best.seg + 1] - cum[best.seg]) * best.t + dist;
    s = ((s % total) + total) % total;
    let i = 0;
    while (i < N - 1 && cum[i + 1] < s) i++;
    const a = gates[i], b = gates[(i + 1) % N];
    const segLen = cum[i + 1] - cum[i] || 1;
    const t = (s - cum[i]) / segLen;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, fx: (b[0] - a[0]) / segLen, fz: (b[1] - a[1]) / segLen, s };
  }

  function simLaunchArc(y0, vy0, landingY = 0) {
    let y = y0, vy = vy0, t = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 900; i++) {
      const g = y > 6 ? 7.5 : y > 2.5 ? 14 : 30;
      vy -= g * dt; y += vy * dt; t += dt;
      if (vy < 0 && y <= landingY) return t;
    }
    return t;
  }

  function diveHeightAt(x, z) {
    if (!dives.length) return null;
    let bestDive = null;
    for (const d of dives) {
      const loc = nearestOnPolyline(d.points, x, z);
      if (loc.d > gateWidth * 0.95) continue;
      const ramp = Math.min(1, Math.min(loc.u, 1 - loc.u) / 0.22);
      const sm = ramp * ramp * (3 - 2 * ramp);
      if (!bestDive || loc.d < bestDive.distance) bestDive = { distance: loc.d, y: d.depth * sm, dive: d };
    }
    if (!bestDive) return null;
    for (const sc of shortcuts) {
      const loc = nearestOnPolyline(sc.points, x, z);
      if (loc.d <= bestDive.distance) return null;
    }
    return bestDive.y;
  }

  // ===== 全图链 v7 final：与 Track.js 实现一致 =====
  const cfg = map.marineFeatures.launchChain || {};
  const speed = cfg.speed || 28;
  const vyUnder = cfg.underwaterVy ?? 22;
  const vyAll = cfg.launchVyAll ?? 11;
  const pairGap = cfg.pairGap ?? 2.3;
  const halfAlong = cfg.halfAlong ?? 5.5;
  const halfSide = cfg.halfSide ?? 2.4;
  const depthAt = (x, z) => { const d = diveHeightAt(x, z); return d != null ? d : 0; };

  let from = total * 0.12;
  const to = total * 0.88;
  if (map.palaceGate) from = Math.max(from, cumUpTo(map.palaceGate.gate + 1));
  let skipZone = null;
  if (coasterDef) {
    const a = cumUpTo(coasterDef.from) - 15;
    const b = cumUpTo(coasterDef.to + 1) + 15;
    if (b > a) skipZone = [Math.max(0, a), Math.min(total - 1, b)];
  }
  const groups = [];
  let cur = routeAdvance(gates[0][0], gates[0][1], from);
  for (let i = 0; i < 40; i++) {
    const y = depthAt(cur.x, cur.z);
    // 与 Track.js 一致：水下组 vy 按深度自适应（弹出水面上方 ~2m），浅水段不再用固定 22
    const vy0 = y < -1 ? Math.max(vyAll, Math.sqrt(56 + 60 * (-y))) : vyAll;
    let flight = simLaunchArc(y + 0.65, vy0, y);
    const probe = routeAdvance(cur.x, cur.z, speed * flight);
    const probeY = depthAt(probe.x, probe.z);
    if (Math.abs(probeY - y) > 0.5) flight = simLaunchArc(y + 0.65, vy0, probeY);
    groups.push({ x: cur.x, z: cur.z, y, fx: cur.fx, fz: cur.fz, flight, vy: vy0, s: cur.s });
    const lx = cur.x + cur.fx * (speed * flight);
    const lz = cur.z + cur.fz * (speed * flight);
    let next = routeAdvance(lx, lz, 0);
    if (next.s >= to || next.s < cur.s - 0.5) break;
    if (skipZone && next.s >= skipZone[0] && next.s <= skipZone[1]) {
      next = routeAdvance(gates[0][0], gates[0][1], skipZone[1]);
      if (next.s >= to) break;
    }
    // 与 Track.js 一致：下一组 = 物理落点，纵向对齐，横向 = 弯道外甩 + 交替 ±weaveAll 后 clamp 到走廊
    const weaveAll = Math.min(3.4, Math.max(2.4, gateWidth * 0.3));
    const offX = lx - next.x;
    const offZ = lz - next.z;
    const along = offX * next.fx + offZ * next.fz;
    let sideD = offX * -next.fz + offZ * next.fx + (i % 2 === 0 ? 1 : -1) * weaveAll;
    const maxOff = gateWidth * 0.4;
    sideD = Math.max(-maxOff, Math.min(maxOff, sideD));
    cur = { ...next, x: next.x + next.fx * along - next.fz * sideD, z: next.z + next.fz * along + next.fx * sideD };
  }

  // ===== 解算 + 验证（物理：空中 vel=heading*speed，弹道=切线直线）=====
  console.log(`\n===== ${map.id} (${map.name}) 周长${total.toFixed(0)}m 组数=${groups.length} skipZone=${skipZone ? skipZone.map((v) => (v / total * 100).toFixed(0) + '%').join('-') : '无'} =====`);
  if (groups.length < 6) { console.log('  ⚠️ 组数过少'); allOk = false; }
  let maxMiss = 0, missCount = 0;
  for (let i = 0; i < groups.length - 1; i++) {
    const g = groups[i];
    // 物理落点：从组中心沿切线飞 speed*flight（与 Boat 空中模型一致）
    const landX = g.x + g.fx * speed * g.flight;
    const landZ = g.z + g.fz * speed * g.flight;
    const next = groups[i + 1];
    // 下一组每个弹射器（±pairGap）的最近距离
    const nfx = next.fx, nfz = next.fz;
    let miss = Infinity;
    for (const lat of [-pairGap, pairGap]) {
      const px = next.x - nfz * lat, pz = next.z + nfx * lat;
      miss = Math.min(miss, Math.hypot(landX - px, landZ - pz));
    }
    maxMiss = Math.max(maxMiss, miss);
    const capture = halfAlong + halfSide + 1.2; // 碰撞盒 + 船体半径
    if (miss > capture) missCount++;
    const flag = miss > capture ? ' ⚠️(落水滑行衔接)' : '';
    console.log(`  组${i + 1} s=${(g.s / total * 100).toFixed(0)}% y=${g.y.toFixed(1)} vy=${g.vy} flight=${g.flight.toFixed(2)}s 落点距下一组=${miss.toFixed(1)}m${flag}`);
  }
  const last = groups[groups.length - 1];
  console.log(`  末组 s=${(last.s / total * 100).toFixed(0)}% y=${last.y.toFixed(1)}`);
  console.log(`  汇总: 最大偏差=${maxMiss.toFixed(1)}m（捕获半径≈${(halfAlong + halfSide + 1.2).toFixed(1)}m） 超出捕获=${missCount}/${groups.length - 1} 组`);
  if (groups.length - 1 > 0 && missCount / (groups.length - 1) > 0.5) { console.log('  ⚠️ 过半数组落点超出捕获范围'); allOk = false; }
}

console.log(`\n${allOk ? '✅ 全部通过' : '❌ 存在问题'}`);
