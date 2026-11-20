// 按 Z 分桶统计某个网格的顶点高度分布（看"水面到底铺在哪一段"）
//   node tests/glb_slice.mjs public/models/cave/fall_shell.glb fall_water
import fs from 'node:fs';

const [file, meshName, axis = 'z', binsArg = '12'] = process.argv.slice(2);
const buf = fs.readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glb');
let off = 12, json = null, bin = null;
while (off < buf.length) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  if (type === 0x004e4942) bin = data;
  off += 8 + len;
}
const node = (json.nodes || []).find((n) => n.name === meshName);
if (!node) throw new Error('node not found: ' + meshName);
const pts = [];
for (const p of json.meshes[node.mesh].primitives) {
  const acc = json.accessors[p.attributes.POSITION];
  const bv = json.bufferViews[acc.bufferView];
  const stride = bv.byteStride || 12;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    pts.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
  }
}
const ax = { x: 0, y: 1, z: 2 }[axis];
const vals = pts.map((p) => p[ax]);
const lo = Math.min(...vals), hi = Math.max(...vals);
const n = Number(binsArg);
const rows = Array.from({ length: n }, () => ({ c: 0, min: Infinity, max: -Infinity, ysum: 0 }));
for (const p of pts) {
  const k = Math.min(n - 1, Math.floor(((p[ax] - lo) / (hi - lo || 1)) * n));
  const r = rows[k];
  r.c++;
  const other = ax === 1 ? 2 : 1; // 另一条轴：取 y 或 z
  r.min = Math.min(r.min, p[other]);
  r.max = Math.max(r.max, p[other]);
}
console.log(`${file} :: ${meshName}  ${axis} ${lo.toFixed(1)}..${hi.toFixed(1)}  points=${pts.length}`);
rows.forEach((r, i) => {
  if (!r.c) return;
  const a = lo + (hi - lo) * (i / n), b = lo + (hi - lo) * ((i + 1) / n);
  const other = ax === 1 ? 'y' : 'z';
  console.log(`  ${axis} ${a.toFixed(0)}..${b.toFixed(0)}  n=${String(r.c).padStart(4)}  `
    + `${other} ${r.min.toFixed(1)}..${r.max.toFixed(1)}`);
});
