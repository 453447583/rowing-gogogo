// 从每个 GLB 里抽出贴图，并统计 UV 覆盖率（哪些图集区域被 UV 用到）
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

const OUT = 'shots/verify/boats/tex';
fs.mkdirSync(OUT, { recursive: true });

function readGlb(file) {
  const buf = fs.readFileSync(file);
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

for (const [tag, file] of FILES) {
  const { json, bin } = readGlb(file);
  const img = json.images[0];
  const bv = json.bufferViews[img.bufferView];
  const data = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
  const p = path.join(OUT, `${tag}.${ext}`);
  fs.writeFileSync(p, data);

  // UV 覆盖：粗糙统计 UV 落在 32x32 网格上的分布
  const prim = json.meshes[0].primitives[0];
  const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
  const uvBv = json.bufferViews[uvAcc.bufferView];
  const base = (uvBv.byteOffset || 0) + (uvAcc.byteOffset || 0);
  const stride = uvBv.byteStride || 8;
  const N = 48;
  const grid = new Uint32Array(N * N);
  let uMin = 9, uMax = -9, vMin = 9, vMax = -9;
  for (let i = 0; i < uvAcc.count; i++) {
    const u = bin.readFloatLE(base + i * stride);
    const v = bin.readFloatLE(base + i * stride + 4);
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    const gx = Math.min(N - 1, Math.max(0, Math.floor(u * N)));
    const gy = Math.min(N - 1, Math.max(0, Math.floor(v * N)));
    grid[gy * N + gx]++;
  }
  let filled = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] > 0) filled++;
  console.log(`${tag}: tex ${bv.byteLength} B (${ext})  u[${uMin.toFixed(2)},${uMax.toFixed(2)}] v[${vMin.toFixed(2)},${vMax.toFixed(2)}]  UV 覆盖格 ${filled}/${N * N} = ${(filled / (N * N) * 100).toFixed(0)}%`);
}
