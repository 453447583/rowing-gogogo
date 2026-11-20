// 探测 GLB：包围盒 / 贴图字节 / 三角面数 / 主贴图尺寸
import fs from 'node:fs';

const DIR = 'assets_src/boats/fixed';
const TAGS = ['car6', 'flycar', 'jetboat', 'redcar', 'ship', 'speedboat'];

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('utf8', 0, 4) !== 'glTF') throw new Error('not glb ' + file);
  let off = 12; let json = null; let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const typ = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (typ === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (typ === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return { json, bin, size: buf.length };
}

const out = [];
for (const tag of TAGS) {
  const file = `${DIR}/${tag}_fixed.glb`;
  const { json, bin, size } = readGlb(file);
  let min = [1e9, 1e9, 1e9];
  let max = [-1e9, -1e9, -1e9];
  let tris = 0;
  for (const m of json.meshes || []) {
    for (const p of m.primitives) {
      const acc = json.accessors[p.attributes.POSITION];
      tris += (json.accessors[p.indices]?.count ?? 0) / 3;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], acc.min[i]);
        max[i] = Math.max(max[i], acc.max[i]);
      }
    }
  }
  const dim = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  // 贴图实际像素尺寸：读 JPEG 头
  let texW = 0; let texH = 0; let texBytes = 0;
  const img = json.images?.[0];
  if (img?.bufferView != null) {
    const bv = json.bufferViews[img.bufferView];
    texBytes = bv.byteLength;
    const start = (bv.byteOffset || 0) + (bin ? 0 : 0);
    const jpg = bin.subarray(start, start + Math.min(bv.byteLength, 200000));
    for (let i = 0; i < jpg.length - 9; i++) {
      if (jpg[i] === 0xff && (jpg[i + 1] === 0xc0 || jpg[i + 1] === 0xc2)) {
        texH = jpg.readUInt16BE(i + 5);
        texW = jpg.readUInt16BE(i + 7);
        break;
      }
    }
  }
  const axis = dim.indexOf(Math.max(...dim));
  out.push({
    tag,
    sizeMB: +(size / 1048576).toFixed(2),
    tris: Math.round(tris),
    min: min.map((v) => +v.toFixed(2)),
    max: max.map((v) => +v.toFixed(2)),
    dim: dim.map((v) => +v.toFixed(2)),
    longestAxis: 'XYZ'[axis],
    tex: `${texW}x${texH}`,
    texMB: +(texBytes / 1048576).toFixed(2),
    node: json.nodes?.[0]?.name,
  });
}
console.log(JSON.stringify(out, null, 1));
