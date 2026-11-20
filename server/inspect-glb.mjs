// 临时脚本：解析 GLB 的 JSON chunk，列出场景结构
import { readFileSync } from 'node:fs';

for (const file of process.argv.slice(2)) {
  console.log('=====', file, '=====');
  const buf = readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  console.log('generator:', json.asset?.generator);
  console.log('scenes:', JSON.stringify(json.scenes));
  console.log('meshes:', (json.meshes || []).map((m) => m.name).join(', '));
  console.log('materials:', (json.materials || []).map((m) => m.name).join(', '));
  console.log('animations:', (json.animations || []).map((a) => `${a.name}(${(a.channels || []).length}ch)`).join(', ') || '(none)');
  console.log('nodes:');
  const walk = (idx, depth) => {
    const n = json.nodes[idx];
    const t = n.translation ? ` t=[${n.translation.map((v) => v.toFixed(2))}]` : '';
    const r = n.rotation ? ` r=[${n.rotation.map((v) => v.toFixed(2))}]` : '';
    const s = n.scale ? ` s=[${n.scale.map((v) => v.toFixed(2))}]` : '';
    const m = n.mesh != null ? ` mesh=${json.meshes[n.mesh].name}` : '';
    console.log(`${'  '.repeat(depth)}- ${n.name}${m}${t}${r}${s}`);
    (n.children || []).forEach((c) => walk(c, depth + 1));
  };
  (json.scenes?.[0]?.nodes || []).forEach((n) => walk(n, 0));
  // 网格包围盒（用 accessor min/max）
  if (json.meshes) {
    console.log('mesh bounds:');
    for (const m of json.meshes) {
      const posAcc = m.primitives[0].attributes.POSITION;
      const acc = json.accessors[posAcc];
      console.log(`  ${m.name}: min=[${acc.min.map((v) => v.toFixed(2))}] max=[${acc.max.map((v) => v.toFixed(2))}]`);
    }
  }
}
