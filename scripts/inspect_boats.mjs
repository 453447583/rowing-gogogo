// 分析 GLB 结构：找出"没有贴图 / 只剩默认灰色"的材质，以及它们挂在哪些网格上
import fs from 'node:fs';
import path from 'node:path';

const FILES = [
  ['jetboat', 'D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F/1/未来喷气艇3d模型.glb'],
  ['redcar', 'D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F/2/3d模型 红色飞行汽车.glb'],
  ['flycar', 'D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F/3/未来飞行汽车3d模型.glb'],
  ['speedboat', 'D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F/4/3d模型 快速艇.glb'],
  ['ship', 'D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F/5/未来船艇3d模型.glb'],
  ['car6', 'D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F/6/未来汽车3d模型.glb'],
];

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error('not glb');
  let off = 12; let json = null; let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const typ = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (typ === 0x4E4F534A) json = JSON.parse(chunk.toString('utf8'));
    else if (typ === 0x004E4942) bin = chunk;
    off += 8 + len;
  }
  return { json, bin };
}

const out = [];
for (const [tag, file] of FILES) {
  const { json } = readGlb(file);
  const mats = (json.materials || []).map((m, i) => {
    const p = m.pbrMetallicRoughness || {};
    const bc = p.baseColorFactor || [1, 1, 1, 1];
    const hasTex = p.baseColorTexture !== undefined;
    return {
      i,
      name: m.name || `mat${i}`,
      hasTex,
      tex: p.baseColorTexture?.index ?? null,
      bc: bc.map((v) => Math.round(v * 1000) / 1000),
      metal: p.metallicFactor ?? 1,
      rough: p.roughnessFactor ?? 1,
      emissive: m.emissiveFactor,
      alphaMode: m.alphaMode || 'OPAQUE',
      ext: Object.keys(m.extensions || {}),
    };
  });

  // 每个 primitive 的材质 + 顶点数 + 包围盒
  const meshes = (json.meshes || []).map((m, mi) => {
    const prims = m.primitives.map((p) => {
      const acc = json.accessors[p.attributes.POSITION];
      return {
        mat: p.material ?? null,
        tris: (json.accessors[p.indices]?.count ?? 0) / 3,
        verts: acc.count,
        min: acc.min?.map((v) => Math.round(v * 100) / 100),
        max: acc.max?.map((v) => Math.round(v * 100) / 100),
      };
    });
    return { mi, name: m.name || `mesh${mi}`, prims };
  });

  const totalTris = meshes.reduce((s, m) => s + m.prims.reduce((a, p) => a + p.tris, 0), 0);
  out.push({
    tag,
    file: path.basename(file),
    sizeMB: Math.round(fs.statSync(file).size / 1048576 * 10) / 10,
    images: (json.images || []).length,
    imageMime: [...new Set((json.images || []).map((im) => im.mimeType))],
    textures: (json.textures || []).length,
    nodes: (json.nodes || []).length,
    meshes: meshes.length,
    totalTris: Math.round(totalTris),
    mats,
    // 只列出没贴图的材质挂在哪些网格
    noTexUsers: meshes.flatMap((m) => m.prims
      .filter((p) => p.mat !== null && mats[p.mat] && !mats[p.mat].hasTex)
      .map((p) => ({ mesh: m.name, mat: mats[p.mat].name, tris: Math.round(p.tris), min: p.min, max: p.max }))),
  });
}

for (const r of out) {
  console.log(`\n===== ${r.tag}  ${r.file}  ${r.sizeMB}MB  imgs=${r.images} tex=${r.textures} mats=${r.mats.length} meshes=${r.meshes} tris=${r.totalTris} nodes=${r.nodes}`);
  console.log(`  imageMime=${JSON.stringify(r.imageMime)}`);
  const withTex = r.mats.filter((m) => m.hasTex).length;
  console.log(`  材质: 有贴图 ${withTex} / 无贴图 ${r.mats.length - withTex}`);
  for (const m of r.mats) {
    if (!m.hasTex) {
      console.log(`   ✗ [${m.i}] ${m.name}  baseColor=${JSON.stringify(m.bc)} metal=${m.metal} rough=${m.rough}${m.ext.length ? ' ext=' + m.ext.join(',') : ''}`);
    }
  }
  console.log(`  无贴图材质占用的网格:`);
  for (const u of r.noTexUsers.slice(0, 30)) {
    console.log(`     ${u.mesh} ← ${u.mat}  ${u.tris}tris  bbox min=${JSON.stringify(u.min)} max=${JSON.stringify(u.max)}`);
  }
  if (r.noTexUsers.length > 30) console.log(`     … 还有 ${r.noTexUsers.length - 30} 条`);
}
fs.writeFileSync('shots/verify/boats/glb_inspect.json', JSON.stringify(out, null, 1));
