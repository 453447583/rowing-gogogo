// Temporary geometry analysis for the canyon map (not part of the test suite).
import { MAPS } from '../src/data/maps.js';

const canyon = MAPS.find((m) => m.id === 'canyon');
const gates = canyon.gates;
const N = gates.length;
const W = canyon.gateWidth;

function turnAt(i) {
  const p = gates[(i - 1 + N) % N];
  const c = gates[i];
  const n = gates[(i + 1) % N];
  const a1 = Math.atan2(c[0] - p[0], c[1] - p[1]);
  const a2 = Math.atan2(n[0] - c[0], n[1] - c[1]);
  let d = Math.abs(a2 - a1);
  while (d > Math.PI) d = Math.abs(d - Math.PI * 2);
  return { deg: (d * 180) / Math.PI, rad: d };
}

console.log('=== Canyon gate turn angles (deg) ===');
let maxTurn = { i: -1, deg: 0 };
for (let i = 0; i < N; i++) {
  const t = turnAt(i);
  if (t.deg > maxTurn.deg) maxTurn = { i, deg: t.deg };
  if (t.deg > 25) console.log(`gate ${i} (${gates[i]}): ${t.deg.toFixed(1)} deg`);
}
console.log('max turn:', maxTurn.i, maxTurn.deg.toFixed(1), 'deg at', gates[maxTurn.i]);

// Offset wall polygon: for each gate, compute left/right offset perpendicular to
// the segment gate[i] -> gate[i+1]. A sharp turn makes consecutive offset points
// flip across, i.e. the "left" wall crosses the "right" wall. Detect by checking
// sign of cross product of consecutive wall edges around the loop.
console.log('\n=== Offset wall self-intersection probe ===');
for (const side of [1, -1]) {
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const gi = i % N;
    const [ax, az] = gates[gi];
    const [bx, bz] = gates[(gi + 1) % N];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const ox = (-dz / len) * side * W;
    const oz = (dx / len) * side * W;
    pts.push([ax + ox, az + oz]);
  }
  // report corners where the wall folds back (consecutive edge dot < 0)
  for (let i = 0; i < pts.length - 2; i++) {
    const e1x = pts[i + 1][0] - pts[i][0];
    const e1z = pts[i + 1][1] - pts[i][1];
    const e2x = pts[i + 2][0] - pts[i + 1][0];
    const e2z = pts[i + 2][1] - pts[i + 1][1];
    const l1 = Math.hypot(e1x, e1z) || 1;
    const l2 = Math.hypot(e2x, e2z) || 1;
    const dot = (e1x / l1) * (e2x / l2) + (e1z / l1) * (e2z / l2);
    if (dot < 0.2) {
      const gi = i % N;
      console.log(`side ${side > 0 ? 'L' : 'R'} wall folds near gate ${gi} (${gates[gi]}): dot=${dot.toFixed(2)}`);
    }
  }
}

// Shortcut endpoint check
console.log('\n=== Shortcut endpoint vs rocks/obstacles ===');
const sc = canyon.shortcuts[0];
const endpoint = sc.points[sc.points.length - 1];
console.log('shortcut endpoint:', endpoint, 'gate to:', sc.to, gates[sc.to]);
for (const rock of canyon.rocks) {
  const d = Math.hypot(rock.x - endpoint[0], rock.z - endpoint[1]);
  if (d < 30) console.log(`rock (${rock.x},${rock.z}) r=${rock.r} dist=${d.toFixed(1)}`);
}

// Distance from shortcut endpoint to the gate pylons at gate to and neighboring gates
for (let i = sc.to - 2; i <= sc.to + 2; i++) {
  const gi = ((i % N) + N) % N;
  const [ax, az] = gates[gi];
  const [bx, bz] = gates[(gi + 1) % N];
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  for (const side of [-1, 1]) {
    const px = ax + nx * W * side;
    const pz = az + nz * W * side;
    const d = Math.hypot(px - endpoint[0], pz - endpoint[1]);
    console.log(`gate ${gi} pylon side ${side > 0 ? 'L' : 'R'} at (${px.toFixed(1)},${pz.toFixed(1)}) dist to shortcut endpoint=${d.toFixed(1)}`);
  }
}
