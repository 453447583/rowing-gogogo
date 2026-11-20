// 精确量 GLB：沿节点树累乘变换，算出世界包围盒（米）
// 用法: node tests/glb_dims.mjs <file...>
import fs from 'node:fs';

function readGLB(file) {
  const buf = fs.readFileSync(file);
  let off = 12; let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    off += 8 + len;
  }
  return json;
}

// 4x4 列主序矩阵工具（够用：平移/旋转/缩放）
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};
const fromTRS = (n) => {
  if (n.matrix) return n.matrix.slice();
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
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

function measure(file) {
  const json = readGLB(file);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let prims = 0;
  const walk = (idx, parent) => {
    const n = json.nodes[idx];
    const m = mul(parent, fromTRS(n || {}));
    if (n && n.mesh != null) {
      for (const p of json.meshes[n.mesh].primitives || []) {
        const acc = json.accessors[p.attributes.POSITION];
        if (!acc?.min) continue;
        prims++;
        for (let i = 0; i < 8; i++) {
          const v = [
            i & 1 ? acc.max[0] : acc.min[0],
            i & 2 ? acc.max[1] : acc.min[1],
            i & 4 ? acc.max[2] : acc.min[2],
          ];
          const w = apply(m, v);
          for (let k = 0; k < 3; k++) {
            if (w[k] < min[k]) min[k] = w[k];
            if (w[k] > max[k]) max[k] = w[k];
          }
        }
      }
    }
    for (const c of n?.children || []) walk(c, m);
  };
  for (const root of json.scenes?.[0]?.nodes || []) walk(root, I());
  const size = [0, 1, 2].map((k) => +(max[k] - min[k]).toFixed(2));
  return { size, prims };
}

const files = process.argv.slice(2);
const rows = [];
for (const f of files) {
  try {
    const { size, prims } = measure(f);
    rows.push({ name: f.split(/[\\/]/).pop(), size, prims });
  } catch (e) {
    rows.push({ name: f.split(/[\\/]/).pop(), size: ['ERR', e.message], prims: 0 });
  }
}
rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
for (const r of rows) {
  const s = Array.isArray(r.size) ? `x=${r.size[0]} y=${r.size[1]} z=${r.size[2]}` : r.size;
  console.log(`${String(r.name).padEnd(44)} ${s.padEnd(34)} prims=${r.prims}`);
}
