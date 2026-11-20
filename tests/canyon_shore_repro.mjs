// Reproduce the canyon shore-cliff (rock pillar) placement deterministically
// to find which generated "pillar" blocks the shortcut endpoint.
import { MAPS } from '../src/data/maps.js';

const canyon = MAPS.find((m) => m.id === 'canyon');
const gates = canyon.gates;

// mulberry32 (identical to Environment.js)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(canyon.id === 'canyon' ? 20260826 : 13579246);

function pointToSegmentDistance(point, start, end) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSq = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSq));
  return Math.hypot(point[0] - (start[0] + dx * t), point[1] - (start[1] + dz * t));
}

// --- replay rng in Environment constructor order for canyon ---

// #buildClouds (count=14)
for (let i = 0; i < 14; i++) {
  rng(); // a
  rng(); // dist
  const puffs = 3 + Math.floor(rng() * 3);
  rng(); // baseR
  for (let k = 0; k < puffs; k++) {
    rng(); rng(); rng(); rng(); // r, x, y, z
  }
  rng(); // cloud y
  rng(); // vx
  rng(); // vz
}

// #buildMountains (canyon, count=26)
for (let i = 0; i < 26; i++) {
  rng(); // a
  rng(); // dist
  rng(); // h
  rng(); // r
  rng(); // material pick
  rng(); // rotation.y
}

// #buildShores (canyon branch)
const shortcutClearance = (x, z, radius) => {
  for (const shortcut of canyon.shortcuts || []) {
    const points = shortcut.points || [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const sx = bx - ax;
      const sz = bz - az;
      const len2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
      if (Math.hypot(x - (ax + sx * t), z - (az + sz * t)) < shortcut.width + radius + 2.5) return false;
    }
  }
  return true;
};

const cliffs = [];
for (let i = 0; i < gates.length; i++) {
  const g = gates[i];
  const gNext = gates[(i + 1) % gates.length];
  const dx = gNext[0] - g[0];
  const dz = gNext[1] - g[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const offset = canyon.gateWidth + 6 + rng() * 7;
  for (const side of [-1, 1]) {
    let px = g[0] + nx * offset * side + (rng() - 0.5) * 6;
    let pz = g[1] + nz * offset * side + (rng() - 0.5) * 6;
    const h = 14 + rng() * 22;
    const w = 9 + rng() * 8;
    const pushed = [];
    for (let attempt = 0; attempt < 2 && !shortcutClearance(px, pz, w * 0.62); attempt++) {
      px += nx * side * 12;
      pz += nz * side * 12;
      pushed.push(attempt);
    }
    rng(); // material pick
    rng(); rng(); rng(); // rotation.set x,y,z
    cliffs.push({ gate: i, x: px, z: pz, w, h, r: w * 0.62, pushed: pushed.length });
  }
}

const endpoint = canyon.shortcuts[0].points.at(-1);
console.log('shortcut endpoint:', endpoint, '(gate 14 =', gates[14], ')');
console.log('\nCliffs within 40m of the shortcut endpoint:');
const near = cliffs
  .map((c) => ({ ...c, d: Math.hypot(c.x - endpoint[0], c.z - endpoint[1]) }))
  .filter((c) => c.d < 40)
  .sort((a, b) => a.d - b.d);
for (const c of near) {
  console.log(`  gate ${c.gate} (${gates[c.gate]}): pos=(${c.x.toFixed(1)},${c.z.toFixed(1)}) r=${c.r.toFixed(1)} w=${c.w} dist=${c.d.toFixed(1)} pushed=${c.pushed}`);
}

console.log('\nCliff closest to endpoint overall:');
const closest = cliffs.map((c) => ({ ...c, d: Math.hypot(c.x - endpoint[0], c.z - endpoint[1]) })).sort((a, b) => a.d - b.d)[0];
console.log(`  gate ${closest.gate} pos=(${closest.x.toFixed(1)},${closest.z.toFixed(1)}) r=${closest.r.toFixed(1)} dist=${closest.d.toFixed(1)}`);

// Also: distance from endpoint to each shortcut segment vs cliffs
console.log('\nShortcut points:', JSON.stringify(canyon.shortcuts[0].points));
