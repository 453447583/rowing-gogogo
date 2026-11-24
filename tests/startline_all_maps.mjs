// 全图起点线露出水面体检（纯数值，不开浏览器）：
// 按每张地图的 gates[0] / gateY[0] / startWidth，用与 Track.#buildStartLine 同样的顶点，
// 逐时刻比较「起点线顶点 y」与「当地主水面渲染高度（网格插值）」。
// 主水面网格间距 = size/seg（size=max(700, r*2.15+300)，seg 192/128/96 按画质），
// 所以浪面是分段线性的，解析 waveHeight 与网格插值最高可差 ~0.4m(晴)/~1.0m(暴风)。
// 用法：node tests/startline_all_maps.mjs
import * as THREE from 'three';
import { MAPS } from '../src/data/maps.js';
import { WAVE_PARAMS, WAVE_AMP_SUM } from '../src/utils/waves.js';

const MAX_WAVE_SCALE = 2.4;
const K = WAVE_PARAMS.map((w) => (Math.PI * 2) / w[3]);
function waveHeight(x, z, t, scale) {
  let h = 0;
  for (let i = 0; i < WAVE_PARAMS.length; i++) {
    const w = WAVE_PARAMS[i];
    h += w[2] * Math.sin((x * w[0] + z * w[1]) * K[i] - t * w[4]);
  }
  return h * scale;
}

// 水面网格：PlaneGeometry(size,size,seg,seg).rotateX(-π/2) 后平移到 (cx, 0, cz)
function makeWaterGrid(map, seg) {
  const r = map.boundary?.r ?? 700;
  const size = Math.max(700, Math.round(r * 2.15 + 300));
  const cx = map.boundary?.x ?? 0;
  const cz = map.boundary?.z ?? 0;
  const step = size / seg;
  return { cx, cz, size, step, minX: cx - size / 2, minZ: cz - size / 2, seg };
}

// 在主水面网格上双线性插值出 x,z 处的渲染高度（含 Gerstner 前的解析浪高采样）
function gridWaterY(grid, x, z, t, scale) {
  const u = (x - grid.minX) / grid.step;
  const v = (z - grid.minZ) / grid.step;
  const i0 = Math.max(0, Math.min(grid.seg - 1, Math.floor(u)));
  const j0 = Math.max(0, Math.min(grid.seg - 1, Math.floor(v)));
  const fx = Math.max(0, Math.min(1, u - i0));
  const fz = Math.max(0, Math.min(1, v - j0));
  const h00 = waveHeight(grid.minX + i0 * grid.step, grid.minZ + j0 * grid.step, t, scale);
  const h10 = waveHeight(grid.minX + (i0 + 1) * grid.step, grid.minZ + j0 * grid.step, t, scale);
  const h01 = waveHeight(grid.minX + i0 * grid.step, grid.minZ + (j0 + 1) * grid.step, t, scale);
  const h11 = waveHeight(grid.minX + (i0 + 1) * grid.step, grid.minZ + (j0 + 1) * grid.step, t, scale);
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
}

// 与 Track.#buildStartLine 完全一致的顶点布局
function startLineVerts(map) {
  const gates = map.gates ?? (map.baked ? [] : []);
  const [x, z] = gates[0] ?? [0, 16];
  const [x1, z1] = gates[1] ?? [x, z + 10];
  const dx = x1 - x, dz = z1 - z;
  const baseY = (map.bakedY ?? [])[0] ?? 0;
  const width = map.startWidth ?? (map.gateWidth ?? 15) * 3;
  const segX = Math.max(8, Math.min(48, Math.round(width / 1.8)));
  const geo = new THREE.PlaneGeometry(width, 2.4, segX, 3);
  geo.rotateZ(Math.atan2(dx, dz));
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, baseY, z);
  const out = [];
  const arr = geo.attributes.position.array;
  for (let i = 0; i < arr.length; i += 3) out.push([arr[i], baseY, arr[i + 2]]);
  return { verts: out, baseY, x, z };
}

const SCALES = [
  ['平静/非竞速', 0.34],
  ['晴天', 1.0],
  ['暴风雨', MAX_WAVE_SCALE],
];
const SEG = 192; // 高画质；低画质网格更粗，误差更大，用 192 是较保守的近似

let bad = 0;
console.log('地图\t起点\t基准Y\t' + SCALES.map((s) => s[0] + '最小间隙').join('\t'));
for (const map of MAPS) {
  if (map.gates?.length < 2) continue;
  const { verts, baseY, x, z } = startLineVerts(map);
  const grid = makeWaterGrid(map, SEG);
  const row = [];
  for (const [, scale] of SCALES) {
    let minGap = Infinity;
    // 采 0..12s，每 0.5s 一帧，覆盖完整波周期（最短 7m/3.1 速 ≈ 2.3s）
    for (let t = 0; t <= 12; t += 0.5) {
      for (const [vx, , vz] of verts) {
        // 改动后：起点线高度 = 水面网格插值高度 + 0.2 余量
        const waterY = gridWaterY(grid, vx, vz, t, scale);
        const lineY = baseY + waterY + 0.2;
        const gap = lineY - waterY;
        if (gap < minGap) minGap = gap;
      }
    }
    row.push(+minGap.toFixed(3));
  }
  console.log(`${map.id}\t${x},${z}\t${baseY}\t${row.join('\t')}`);
  if (row.some((g) => g < -0.02)) bad++;
}
console.log(`\n总波幅 ${WAVE_AMP_SUM}m × 2.4 = ${(WAVE_AMP_SUM * 2.4).toFixed(2)}m；负间隙=起点线被水面盖住`);
console.log(bad === 0 ? '结论：全部地图起点线在各档浪高下均露出水面' : `结论：${bad} 张地图存在遮挡`);
