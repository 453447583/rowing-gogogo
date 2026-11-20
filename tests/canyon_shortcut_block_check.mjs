// Comprehensive check of what blocks the canyon shortcut exit.
import { MAPS } from '../src/data/maps.js';

const canyon = MAPS.find((m) => m.id === 'canyon');
const gates = canyon.gates;
const N = gates.length;
const W = canyon.gateWidth;
const sc = canyon.shortcuts[0];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260826);
for (let i = 0; i < 14; i++) { rng(); rng(); const puffs = 3 + Math.floor(rng() * 3); rng(); for (let k = 0; k < puffs; k++) { rng(); rng(); rng(); rng(); } rng(); rng(); rng(); }
for (let i = 0; i < 26; i++) { rng(); rng(); rng(); rng(); rng(); rng(); }

const shortcutClearance = (x, z, radius) => {
  for (const shortcut of canyon.shortcuts || []) {
    const points = shortcut.points || [];
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const sx = bx - ax, sz = bz - az;
      const len2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
      if (Math.hypot(x - (ax + sx * t), z - (az + sz * t)) < shortcut.width + radius + 2.5) return false;
    }
  }
  return true;
};

function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}
function polylineDist(p, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, segDist(p, pts[i], pts[i + 1]));
  return d;
}

// Cliffs
const cliffs = [];
for (let i = 0; i < N; i++) {
  const g = gates[i], gn = gates[(i + 1) % N];
  const dx = gn[0] - g[0], dz = gn[1] - g[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  const offset = W + 6 + rng() * 7;
  for (const side of [-1, 1]) {
    let px = g[0] + nx * offset * side + (rng() - 0.5) * 6;
    let pz = g[1] + nz * offset * side + (rng() - 0.5) * 6;
    const h = 14 + rng() * 22;
    const w = 9 + rng() * 8;
    for (let a = 0; a < 2 && !shortcutClearance(px, pz, w * 0.62); a++) { px += nx * side * 12; pz += nz * side * 12; }
    rng(); rng(); rng(); rng();
    cliffs.push({ x: px, z: pz, r: w * 0.62, w });
  }
}

console.log('=== Cliffs near the shortcut PATH (within width/2 + r + 2.5) ===');
for (const c of cliffs) {
  const d = polylineDist([c.x, c.z], sc.points);
  if (d < sc.width / 2 + c.r + 2.5) {
    console.log(`cliff (${c.x.toFixed(1)},${c.z.toFixed(1)}) r=${c.r.toFixed(1)} pathDist=${d.toFixed(1)}`);
  }
}
console.log('(none printed above = no cliff overlaps the shortcut path)');

console.log('\n=== Shortcut exit vs main-track direction at gate 14 ===');
const exitA = sc.points[sc.points.length - 2];
const exitB = sc.points[sc.points.length - 1];
const g14 = gates[14];
const g15 = gates[15];
console.log('shortcut exit dir:', [exitB[0] - exitA[0], exitB[1] - exitA[1]]);
console.log('main dir at gate14 (to gate15):', [g15[0] - g14[0], g15[1] - g14[1]]);
const a = [exitB[0] - exitA[0], exitB[1] - exitA[1]];
const b = [g15[0] - g14[0], g15[1] - g14[1]];
const dot = a[0] * b[0] + a[1] * b[1];
const la = Math.hypot(...a), lb = Math.hypot(...b);
console.log('angle between exit dir and main dir:', (Math.acos(dot / (la * lb)) * 180 / Math.PI).toFixed(1), 'deg');

console.log('\n=== Gate 14 pylons (门柱) ===');
{
  const g = gates[14], gn = gates[15];
  const dx = gn[0] - g[0], dz = gn[1] - g[1];
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  for (const side of [-1, 1]) {
    const px = g[0] + nx * W * side, pz = g[1] + nz * W * side;
    const dEnd = Math.hypot(px - exitB[0], pz - exitB[1]);
    const dPath = segDist([px, pz], exitA, exitB);
    console.log(`pylon side ${side > 0 ? 'L' : 'R'} at (${px.toFixed(1)},${pz.toFixed(1)}) distToExitPoint=${dEnd.toFixed(1)} distToExitSeg=${dPath.toFixed(1)}`);
  }
}

console.log('\n=== Rocks near shortcut exit ===');
for (const rock of canyon.rocks) {
  const d = polylineDist([rock.x, rock.z], sc.points);
  console.log(`rock (${rock.x},${rock.z}) r=${rock.r} pathDist=${d.toFixed(1)}`);
}

console.log('\n=== Auto piston gates (canyon) ===');
function turnAt(i) {
  const p = gates[(i - 1 + N) % N], c = gates[i], n = gates[(i + 1) % N];
  const a1 = Math.atan2(c[0] - p[0], c[1] - p[1]);
  const a2 = Math.atan2(n[0] - c[0], n[1] - c[1]);
  let d = Math.abs(a2 - a1); while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
  return d;
}
const scored = [];
for (let i = 2; i < N - 1; i++) scored.push({ i, turn: turnAt(i) });
scored.sort((x, y) => y.turn - x.turn);
const chosen = [];
for (const s of scored) {
  if (chosen.length >= Math.min(5, Math.floor(N / 4))) break;
  if (chosen.every((c) => Math.abs(c.i - s.i) > 2)) chosen.push(s);
}
console.log('piston gates:', chosen.map((c) => c.i).join(', '));
