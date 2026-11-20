// 峡谷险道「净空审计」：航道可通行性 + 立交桥坡度/净空 + 布景不压线
// 用法: node tests/canyon_clearance_audit.mjs
// 输出 PASS/FAIL 明细；退出码 1 = 有 FAIL。
import fs from 'node:fs';
import { MAPS } from '../src/data/maps.js';

const ROOT = process.cwd();
const map = MAPS.find((m) => m.id === 'ocean');
if (!map) { console.error('找不到 ocean 地图'); process.exit(1); }

const N = map.gates.length;
const GW = map.gateWidth;        // 7.5 = 航道半宽
const LANE = GW * 2;             // 15 = 航道全宽

let fails = 0;
const rows = [];
const check = (name, ok, detail) => {
  rows.push({ name, ok, detail });
  if (!ok) fails++;
};

// ---------- GLB 尺寸（沿节点树累乘） ----------
function readGLB(file) {
  const buf = fs.readFileSync(file);
  let off = 12; let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
    off += 8 + len;
  }
  return json;
}
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const fromTRS = (n) => {
  if (n.matrix) return n.matrix.slice();
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
};
const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];
const dimCache = new Map();
function dims(url) {
  if (dimCache.has(url)) return dimCache.get(url);
  const file = `${ROOT}/public${url}`;
  if (!fs.existsSync(file)) { dimCache.set(url, null); return null; }
  const json = readGLB(file);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const walk = (idx, parent) => {
    const n = json.nodes[idx];
    const m = mul(parent, fromTRS(n || {}));
    if (n && n.mesh != null) {
      for (const p of json.meshes[n.mesh].primitives || []) {
        const acc = json.accessors[p.attributes.POSITION];
        if (!acc?.min) continue;
        for (let i = 0; i < 8; i++) {
          const v = [i & 1 ? acc.max[0] : acc.min[0], i & 2 ? acc.max[1] : acc.min[1], i & 4 ? acc.max[2] : acc.min[2]];
          const w = apply(m, v);
          for (let k = 0; k < 3; k++) { if (w[k] < min[k]) min[k] = w[k]; if (w[k] > max[k]) max[k] = w[k]; }
        }
      }
    }
    for (const c of n?.children || []) walk(c, m);
  };
  for (const r of json.scenes?.[0]?.nodes || []) walk(r, I());
  const d = { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] };
  dimCache.set(url, d);
  return d;
}

// ---------- 1) 布景：横向内边缘不能压进航道 ----------
console.log('=== 布景横向净空（航道半宽 7.5m） ===');
for (const spec of map.courseProps.filter((p) => p.kind === 'deco')) {
  const d = dims(spec.glb);
  if (!d) { check(`${spec.label} 资源存在`, false, spec.glb); continue; }
  const lateral = Math.max(d.x, d.z);
  const scale = (spec.span || 24) / (lateral || 1);
  // 转 yaw 90° 后横跨航道的尺寸：yaw 用 d.x，不转用 d.z
  // 转了 yaw 90°：模型长边(X)顺着赛道，横跨航道的是 Z；不转则相反
  const across = (spec.yaw ? d.z : d.x) * scale;
  const offset = Math.abs(spec.side || 0) * (GW * 0.5);
  const inner = offset - across * 0.5;
  const centered = Math.abs(spec.side || 0) < 0.01;
  const detail = `cross=${across.toFixed(1)}m offset=${offset.toFixed(1)}m 内缘=${inner.toFixed(1)}m`;
  if (centered) {
    // 跨在航道上的（隧道/拱门）：净宽必须 ≥ 航道
    check(`${spec.label} 跨航道净宽`, across >= LANE + 1.5, `${detail}（要求 ≥ ${(LANE + 1.5).toFixed(1)}）`);
  } else {
    check(`${spec.label} 不压线`, inner >= GW, `${detail}（要求 ≥ ${GW}）`);
  }
}

// ---------- 2) 立交桥：坡度与桥下净空 ----------
console.log('\n=== 立交桥 ===');
const op = map.overpass;
if (op) {
  const span = (((op.to - op.from) % N) + N) % N;
  const H = op.height;
  const gateY = new Array(N).fill(0);
  for (let k = 0; k <= span; k++) gateY[(op.from + k) % N] = H * Math.sin((Math.PI * k) / span);

  // 坡度：相邻门的高度差 / 水平距离
  let maxSlope = 0;
  for (let k = 0; k < span; k++) {
    const i = (op.from + k) % N;
    const j = (i + 1) % N;
    const d = Math.hypot(map.gates[j][0] - map.gates[i][0], map.gates[j][1] - map.gates[i][1]);
    maxSlope = Math.max(maxSlope, Math.abs(gateY[j] - gateY[i]) / d);
  }
  const deg = (Math.atan(maxSlope) * 180) / Math.PI;
  check('桥面最大坡度 ≤ 12°', deg <= 12, `${deg.toFixed(1)}°（${(maxSlope * 100).toFixed(1)}%）`);
  check('坡道首尾高度为 0（无台阶）', gateY[op.from] < 0.01 && gateY[(op.to + N) % N] < 0.01,
    `${gateY[op.from].toFixed(2)} → ${gateY[(op.to + N) % N].toFixed(2)}`);

  // 自交处：两条赛线穿过同一点 → 取高一层的当桥面，低一层必须还是水面
  const cross = findSelfCross(map.gates);
  if (cross) {
    const yA = interpSeg(cross.i, cross.t, gateY, map.gates);
    const yB = interpSeg(cross.j, cross.u, gateY, map.gates);
    const upperY = Math.max(yA, yB);
    const lowerY = Math.min(yA, yB);
    const deckBottom = upperY - 0.85;
    check('交叉处上下层分离 ≥ 3.0m', deckBottom - lowerY >= 3.0,
      `上层 ${upperY.toFixed(2)}m / 下层 ${lowerY.toFixed(2)}m / 桥底 ${deckBottom.toFixed(2)}m`);
    check('下层在交叉处仍是水面', Math.abs(lowerY) < 0.05, `lowerY=${lowerY.toFixed(2)}`);
  } else {
    check('找到赛线自交（立交存在）', false, '未检测到交叉');
  }
} else {
  check('存在 overpass', false, '无');
}

// ---------- 3) 近道净空（预留给 shortcuts） ----------
console.log('\n=== 近道 ===');
const scs = map.shortcuts || [];
if (!scs.length) {
  check('近道数量', true, '0 条（本期未加近道，拱门仅为布景）');
} else {
  for (const sc of scs) {
    for (let i = 0; i < sc.points.length - 1; i++) {
      const a = sc.points[i];
      const b = sc.points[i + 1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d < 8) check(`近道段 ${i} 长度`, false, `${d.toFixed(1)}m < 8m`);
    }
  }
}

// ---------- 输出 ----------
console.log('');
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  —  ${r.detail}`);
console.log(`\n${fails ? `有 ${fails} 项 FAIL` : '全部 PASS'}`);
process.exit(fails ? 1 : 0);

// ---------- 工具 ----------
function findSelfCross(gates) {
  const n = gates.length;
  const segHit = (a, b, c, d) => {
    const r = [b[0] - a[0], b[1] - a[1]];
    const s = [d[0] - c[0], d[1] - c[1]];
    const den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
    const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) return { t, u, x: a[0] + r[0] * t, z: a[1] + r[1] * t };
    return null;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 3; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const hit = segHit(gates[i], gates[(i + 1) % n], gates[j], gates[(j + 1) % n]);
      if (hit) return { i, j, ...hit, lowY: 0 }; // 下层按 gateY 单独算
    }
  }
  return null;
}

/** 交叉点落在 [i, i+1] 段上：按 gateY 线性插值出该层的高度 */
function interpSeg(i, t, gateY, gates) {
  const n = gateY.length;
  const y0 = gateY[((i % n) + n) % n];
  const y1 = gateY[((i + 1) % n + n) % n];
  return y0 + (y1 - y0) * t;
}
