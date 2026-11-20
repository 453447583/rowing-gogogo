// 逐个网格列出 GLB 内部结构（名字 / 包围盒 / 材质 / COLOR_0 / 贴图）
// 排查"某一块地形不在应该在的高度"或"材质没颜色"时用这个，比在浏览器里盲找快。
//   node tests/glb_mesh_report.mjs public/models/cave/fall_shell.glb
import fs from 'node:fs';

function parseGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not glb: ' + file);
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    off += 8 + len;
  }
  return json;
}

for (const file of process.argv.slice(2)) {
  const j = parseGLB(file);
  console.log(`\n=== ${file} ===`);
  console.log(`images: ${(j.images || []).length}  textures: ${(j.textures || []).length}  materials: ${(j.materials || []).length}`);
  console.log('mesh nodes:');
  for (const n of j.nodes || []) {
    if (n.mesh == null) continue;
    const mesh = j.meshes[n.mesh];
    if (!n.name) continue; // 只看有名字的节点（导出脚本都按名字分组）
    let mn = [Infinity, Infinity, Infinity];
    let mx = [-Infinity, -Infinity, -Infinity];
    const mats = new Set();
    let color0 = false;
    let verts = 0;
    for (const p of mesh.primitives || []) {
      const acc = j.accessors[p.attributes.POSITION];
      verts += acc.count;
      if (!acc.min) continue;
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], acc.min[k]);
        mx[k] = Math.max(mx[k], acc.max[k]);
      }
      if (p.attributes.COLOR_0 != null) color0 = true;
      if (p.material != null) mats.add(j.materials[p.material]?.name ?? p.material);
    }
    const sz = [0, 1, 2].map((k) => (mx[k] - mn[k]).toFixed(1));
    console.log(
      `  ${n.name.padEnd(22)} v=${String(verts).padStart(6)}  `
      + `y ${mn[1].toFixed(1)}..${mx[1].toFixed(1)}  `
      + `x ${mn[0].toFixed(0)}..${mx[0].toFixed(0)}  z ${mn[2].toFixed(0)}..${mx[2].toFixed(0)}  `
      + `size ${sz.join('x')}  ${color0 ? 'COLOR_0 ' : ''}mat=${[...mats].join(',')}`,
    );
  }
}
