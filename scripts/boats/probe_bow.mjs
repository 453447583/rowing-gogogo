// 判定船头朝向：沿长轴切片统计"横截面宽度"，船头一侧会快速收窄到 0
import fs from 'node:fs';

const DIR = 'assets_src/boats/fixed';
const TAGS = ['car6', 'flycar', 'jetboat', 'redcar', 'ship', 'speedboat'];

function readGlb(file) {
  const buf = fs.readFileSync(file);
  let off = 12; let json = null; let bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const typ = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (typ === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    else if (typ === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return { json, bin };
}

function positions(json, bin) {
  const out = [];
  for (const m of json.meshes || []) {
    for (const p of m.primitives) {
      const acc = json.accessors[p.attributes.POSITION];
      const bv = json.bufferViews[acc.bufferView];
      const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const stride = bv.byteStride || 12;
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride;
        out.push([bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8)]);
      }
    }
  }
  return out;
}

const BINS = 20;
for (const tag of TAGS) {
  const { json, bin } = readGlb(`${DIR}/${tag}_fixed.glb`);
  const P = positions(json, bin);
  let min = [1e9, 1e9, 1e9]; let max = [-1e9, -1e9, -1e9];
  for (const p of P) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }
  const dim = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const ax = dim.indexOf(Math.max(...dim)); // 长轴
  const side = ax === 0 ? 2 : 0; // 横向轴
  const widths = new Array(BINS).fill(0);
  const heights = new Array(BINS).fill(0);
  for (const p of P) {
    const t = (p[ax] - min[ax]) / (dim[ax] || 1);
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(t * BINS)));
    widths[b] = Math.max(widths[b], Math.abs(p[side]));
    heights[b] = Math.max(heights[b], p[1] - min[1]);
  }
  const fmt = (a) => a.map((v) => v.toFixed(3).slice(1)).join(' ');
  // 端部收窄程度：两端 3 格的平均宽度对比
  const head = (widths[0] + widths[1] + widths[2]) / 3;
  const tail = (widths[BINS - 1] + widths[BINS - 2] + widths[BINS - 3]) / 3;
  const verdict = head < tail ? `min 端(轴向 -${'XYZ'[ax]})更窄 → 船头朝 -${'XYZ'[ax]}` : `max 端(+${'XYZ'[ax]})更窄 → 船头朝 +${'XYZ'[ax]}`;
  console.log(`\n### ${tag}  长轴=${'XYZ'[ax]} 宽端比较 ${head.toFixed(3)} vs ${tail.toFixed(3)}  → ${verdict}`);
  console.log('  width ', fmt(widths));
  console.log('  height', fmt(heights));
}
