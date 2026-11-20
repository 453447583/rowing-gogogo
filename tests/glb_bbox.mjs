// 直接解析 GLB：统计所有 POSITION 的 min/max（含节点变换），看模型真实比例
import fs from 'node:fs';

function parseGLB(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546C67) throw new Error('not glb');
  let off = 12;
  let json = null; let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(data.toString('utf8'));
    if (type === 0x004E4942) bin = data;
    off += 8 + len + ((4 - (len % 4)) % 4) * 0;
  }
  return { json, bin };
}

const files = process.argv.slice(2);
for (const f of files) {
  const { json } = parseGLB(f);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  let meshes = 0;
  for (const m of json.meshes || []) {
    for (const p of m.primitives || []) {
      const acc = json.accessors[p.attributes.POSITION];
      if (!acc?.min) continue;
      meshes++;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], acc.min[k]);
        max[k] = Math.max(max[k], acc.max[k]);
      }
    }
  }
  const size = [0, 1, 2].map((k) => +(max[k] - min[k]).toFixed(1));
  // 节点变换里有没有旋转 / 缩放
  const rots = (json.nodes || []).filter((n) => n.rotation).length;
  const scales = (json.nodes || []).filter((n) => n.scale).map((n) => n.scale.map((v) => +v.toFixed(2)));
  const scales0 = new Set(scales.map((s) => s.join(',')));
  console.log(`${f.split(/[\\/]/).pop().padEnd(12)} prims=${String(meshes).padEnd(3)} size(x,y,z)=${JSON.stringify(size)} min=${JSON.stringify(min.map((v) => +v.toFixed(1)))} nodesWithRot=${rots} nodeScales=${[...scales0].slice(0, 4).join(' | ') || 'none'}`);
  console.log(`             asset.generator=${json.asset?.generator}  sceneNodes=${(json.scenes?.[0]?.nodes || []).length}`);
}
