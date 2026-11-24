import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SceneDressing } from './SceneDressing.js';
import { RealSky } from './RealSky.js';
import { NightSky } from './NightSky.js';
import { makeRockMaterial, makeWoodTexture } from './Textures.js';
import { buildPalaceUndersea, updatePalaceUndersea } from './PalaceUndersea.js';
import { LavaScenery } from './LavaScenery.js';
import { lakeStadiumLayout, inStadiumFootprint, lakeStadiumDisabledByUrl } from './LakeStadiumLayout.js';

// 静态布景合并：峡谷岩壁 / 湖边树 / 暗礁这类“同材质的小件”如果一件一个 mesh，
// 每帧就是几百次 draw call（纯 CPU 开销，降分辨率也省不下来）。
// 把世界变换烘进顶点后合成单个 mesh，画面完全一致，绘制次数从几百降到个位数。
// 注意：mergeGeometries 要求整桶的索引属性一致（圆柱/圆锥带 index，多面体不带），
// 所以同一材质按“有索引 / 无索引”分两桶，否则混在一起会整体合并失败（树冠直接消失）。
class StaticMerge {
  constructor() {
    this.buckets = new Map();
  }

  add(geometry, material, matrix) {
    if (matrix) geometry.applyMatrix4(matrix);
    let bucket = this.buckets.get(material);
    if (!bucket) {
      bucket = { indexed: [], flat: [] };
      this.buckets.set(material, bucket);
    }
    (geometry.index ? bucket.indexed : bucket.flat).push(geometry);
  }

  flush(parent, name = 'static-merge') {
    const meshes = [];
    for (const [material, bucket] of this.buckets) {
      for (const list of [bucket.indexed, bucket.flat]) {
        if (!list.length) continue;
        const merged = list.length > 1 ? mergeGeometries(list, false) : list[0];
        if (list.length > 1) list.forEach((g) => g.dispose());
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, material);
        mesh.name = name;
        parent.add(mesh);
        meshes.push(mesh);
      }
    }
    this.buckets.clear();
    return meshes;
  }
}

// 复用矩阵工具，避免布景生成时反复分配
const _mv = new THREE.Vector3();
const _mq = new THREE.Quaternion();
const _me = new THREE.Euler();
const _ms = new THREE.Vector3();
const _mm = new THREE.Matrix4();
function trs(x, y, z, rx, ry, rz, sx, sy, sz) {
  _me.set(rx ?? 0, ry ?? 0, rz ?? 0);
  _mq.setFromEuler(_me);
  _mv.set(x, y, z);
  _ms.set(sx ?? 1, sy ?? 1, sz ?? 1);
  return _mm.compose(_mv, _mq, _ms).clone();
}

// Static course props are shared between maps and cloned per instance. This
// keeps the async GLB loading cost bounded when the player changes maps.
const propModelCache = new Map();
function loadPropModel(url) {
  if (!propModelCache.has(url)) {
    const loader = new GLTFLoader();
    propModelCache.set(url, new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    }));
  }
  return propModelCache.get(url);
}

/**
 * GLB 地标合批：两个灯塔模型合计 320 个子网格（螺丝、护栏、灯具各占一次 draw call），
 * 材质只有 ~37 个。在模型自身根节点空间里把变换烘进顶点、按材质合并，
 * 画面完全一致，draw call 从 320 降到材质数量级。
 * 只处理不透明、非蒙皮、单材质的网格；透明件与多材质件保持原样
 * （渲染排序/材质分组不同，硬合会变色或穿插）。
 */
function mergeStaticByMaterial(root) {
  if (!root) return;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map(); // material -> 索引标记 -> { geos, meshes }
  const wanted = new Map(); // material -> 需要保留的通道
  const victims = [];
  const rel = new THREE.Matrix4();
  root.traverse((obj) => {
    if (!obj.isMesh || obj.isSkinnedMesh || !obj.visible || Array.isArray(obj.material)) return;
    const mat = obj.material;
    const geo = obj.geometry;
    if (!mat || !geo || mat.transparent || mat.alphaTest > 0) return;
    if (geo.morphAttributes && Object.keys(geo.morphAttributes).length) return;
    // 顶点布局必须逐项一致，BufferGeometryUtils 才肯合并。
    // 地标里各子网格带的 UV 通道差别很大（uv1/uv2/uv3/texcoord_4/tangent/color），
    // 这里按材质实际用到的贴图裁掉多余通道，同材质的件才归得到一桶里。
    const useUv = !!(mat.map || mat.alphaMap || mat.normalMap || mat.bumpMap || mat.roughnessMap
      || mat.metalnessMap || mat.emissiveMap || mat.displacementMap);
    const useUv1 = !!(mat.aoMap || mat.lightMap);
    const useColor = !!mat.vertexColors;
    const useTangent = !!(mat.normalMap && mat.vertexTangents);
    // 顶点色/切线缺了没法学插值补齐，这类件保持原样
    if ((useColor && !geo.attributes.color) || (useTangent && !geo.attributes.tangent)) return;
    wanted.set(mat, { uv: useUv, uv1: useUv1 });
    const g = geo.clone();
    for (const name of Object.keys(g.attributes)) {
      const keep = name === 'position' || name === 'normal'
        || (name === 'uv' && useUv) || (name === 'uv1' && useUv1)
        || (name === 'color' && useColor) || (name === 'tangent' && useTangent);
      if (!keep) g.deleteAttribute(name);
    }
    g.applyMatrix4(rel.multiplyMatrices(inv, obj.matrixWorld));
    const key = g.index ? 1 : 0;
    let byIndex = buckets.get(mat);
    if (!byIndex) {
      byIndex = new Map();
      buckets.set(mat, byIndex);
    }
    let bucket = byIndex.get(key);
    if (!bucket) {
      bucket = { geos: [], meshes: [] };
      byIndex.set(key, bucket);
    }
    bucket.geos.push(g);
    bucket.meshes.push(obj);
  });
  for (const [material, byIndex] of buckets) {
    const want = wanted.get(material);
    for (const bucket of byIndex.values()) {
      if (bucket.geos.length < 2) {
        bucket.geos.forEach((g) => g.dispose());
        continue;
      }
      // 少量子网格自带缺省法线/UV：补算/补零，保证整桶布局一致
      for (const g of bucket.geos) {
        const n = g.attributes.position.count;
        if (!g.attributes.normal) g.computeVertexNormals();
        if (want.uv && !g.attributes.uv) {
          g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
        }
        if (want.uv1 && !g.attributes.uv1) {
          g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
        }
      }
      const merged = mergeGeometries(bucket.geos, false);
      bucket.geos.forEach((g) => g.dispose());
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = 'glb-static-merge';
      root.add(mesh);
      victims.push(...bucket.meshes);
    }
  }
  for (const obj of victims) obj.parent?.remove(obj);
}

// 确定性伪随机（同一地图每次生成完全一致）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 近景山体贴图：岩石颗粒 + 草地斑块 + 细裂纹，程序化生成（低精度够用）
// 顶点色只负责大关系（向阳/背阴、雾、雪），这张图负责“表面有东西”
let rockGrassTexture = null;
function getRockGrassTexture() {
  if (rockGrassTexture) return rockGrassTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261028);
  // 底色接近白：贴图和顶点色是相乘关系，底色太深会把整座山压黑。
  // 岩层/植被/颜色大关系交给顶点色，这张图只补“表面细节”
  ctx.fillStyle = '#f1efe9';
  ctx.fillRect(0, 0, size, size);
  // 画斑块时按九宫格复制一份：贴图要平铺，边缘的圆必须接得上，
  // 否则每 42 米就是一条硬缝，远看像给山体罩了张网格
  const blob = (x, y, r, style) => {
    ctx.fillStyle = style;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.beginPath();
        ctx.arc(x + ox * size, y + oy * size, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  // 大尺度植被带：成片绿，但要压得很淡——贴图铺得很密，太重就变成迷彩块
  for (let i = 0; i < 34; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 16 + rand() * 30;
    const v = 0.85 + rand() * 0.3;
    blob(x, y, r, `rgba(${Math.round(96 * v)},${Math.round(118 * v)},${Math.round(70 * v)},0.16)`);
  }
  // 中尺度岩石斑块：明暗岩层
  for (let i = 0; i < 420; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 3 + rand() * 9;
    const v = 0.86 + rand() * 0.2;
    blob(x, y, r, `rgba(${Math.round(196 * v)},${Math.round(192 * v)},${Math.round(178 * v)},0.30)`);
  }
  // 细颗粒：岩石的粗糙感
  for (let i = 0; i < 1400; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 3;
    const v = 0.82 + rand() * 0.24;
    blob(x, y, r, `rgba(${Math.round(198 * v)},${Math.round(194 * v)},${Math.round(180 * v)},0.5)`);
  }
  // 草地：稀疏的小绿点（贴图只是细节，颜色主调交给顶点色，绿多了整座山变“苔藓墙”）
  for (let i = 0; i < 70; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 3 + rand() * 8;
    const v = 0.9 + rand() * 0.3;
    blob(x, y, r, `rgba(${Math.round(104 * v)},${Math.round(126 * v)},${Math.round(78 * v)},0.20)`);
  }
  // 岩石裂纹：细短斜线，给近山一点硬质感
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 90; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 8 + rand() * 26;
    const a = rand() * Math.PI;
    ctx.strokeStyle = `rgba(84,80,72,${0.16 + rand() * 0.2})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  rockGrassTexture = new THREE.CanvasTexture(canvas);
  rockGrassTexture.wrapS = THREE.RepeatWrapping;
  rockGrassTexture.wrapT = THREE.RepeatWrapping;
  rockGrassTexture.colorSpace = THREE.SRGBColorSpace;
  rockGrassTexture.anisotropy = 4;
  return rockGrassTexture;
}

/* ---------------------------------------------------------------- 写实岩面贴图
 * 原来是纯程序化画的「白底 + 岩石斑块」，远看就是一层干净的紫灰剪影——用户吐槽
 * 「山体和岩石有点丑」主要来自这里：没有真实的岩层走向、褶皱和碎石。
 * 现在换成 Poly Haven 的 CC0 真实岩面照片：
 *   山体  ← Aerial Rocks 02（带草坡的岩地，正对应用户参考图那种「山体 + 草地」）
 *   岩石  ← Rock Face（纯岩面，给峡谷/礁石那套用）
 *
 * 关键约束：这些材质都是 **顶点色（或 material.color）× 贴图**，顶点色负责
 * 向阳/背阴/雾/雪。照片原样塞进去均值只有 0.3 左右，会把整座山压黑，所以
 * 必须先归一化成「近白底 + 保留结构」。归一化在 canvas 里做一次（图片下载完
 * 的下一帧），下载完成前先用程序化贴图顶着，观感不会闪白。
 */
function makeRockPhotoTexture(url, { size = 1024, target = 232, contrast = 0.55, hueKeep = 0.12, fallback = null } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const fb = fallback?.();
  if (fb?.image) ctx.drawImage(fb.image, 0, 0, size, size);
  else { ctx.fillStyle = '#e9e7e1'; ctx.fillRect(0, 0, size, size); }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const tmp = document.createElement('canvas');
      tmp.width = tmp.height = size;
      const tc = tmp.getContext('2d');
      tc.drawImage(img, 0, 0, size, size);
      const id = tc.getImageData(0, 0, size, size);
      const d = id.data;
      // 按「均值抬到 target」做线性缩放：用固定增益的话，换一张偏亮的图整片就会发灰
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      const mean = sum / (d.length / 4) || 128;
      const gain = target / Math.max(1, mean);
      const keep = Math.min(1, Math.max(0, hueKeep));
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] || 1;
        const v = target + (l * gain - target) * contrast;
        const flat = 1 - keep;
        d[i] = Math.min(255, Math.max(0, v * (flat + keep * (d[i] / l))));
        d[i + 1] = Math.min(255, Math.max(0, v * (flat + keep * (d[i + 1] / l))));
        d[i + 2] = Math.min(255, Math.max(0, v * (flat + keep * (d[i + 2] / l))));
      }
      tc.putImageData(id, 0, 0);
      ctx.drawImage(tmp, 0, 0);
      tex.needsUpdate = true;
    } catch {
      // 跨域污染 / 解码失败都退回程序化那张：不能因为一张贴图让山体直接白掉
    }
  };
  img.src = url;
  return tex;
}

// 山脊表面：**离线烘焙的岩面浮雕贴图**（relief / normal-shaded albedo）。
// 远景山脊用 MeshBasicMaterial（片元零成本，核显才扛得住），所以"阴影 + 拓扑"
// 必须事先烘进贴图：tileable Worley 岩块 → 高度场 → 中心差分求法线 →
// 固定方向光 → 亮面/暗面 + 裂缝 AO + 中频颗粒。
// 全程各向同性（随机站点 + 周期值噪声），再配 UV 的等比弧长铺法，
// 不会重演"从山顶拉到山脚的竖条"。贴图只调明暗不染色，色相仍由顶点色决定。
let mountainRockTexture = null;
function getMountainRockTexture() {
  if (mountainRockTexture) return mountainRockTexture;
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(S, S);
  const px = img.data;

  // 周期性格点值噪声：格点按 n×n wrap，u/v 跨边界时接缝连续
  const noiseGrid = (n, seed) => {
    const rand = mulberry32(seed);
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    return (u, v) => {
      const fx = u * n, fy = v * n;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const x0 = ((ix % n) + n) % n, y0 = ((iy % n) + n) % n;
      const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
      let sx = fx - ix, sy = fy - iy;
      sx = sx * sx * (3 - 2 * sx);
      sy = sy * sy * (3 - 2 * sy);
      const a = g[y0 * n + x0] + (g[y0 * n + x1] - g[y0 * n + x0]) * sx;
      const b = g[y1 * n + x0] + (g[y1 * n + x1] - g[y1 * n + x0]) * sx;
      return a + (b - a) * sy;
    };
  };

  // 多尺度周期噪声 + 域扭曲：把规则格点揉成流动的侵蚀沟壑。
  // 不用 Worley 岩块 —— 那会在每座山上画出一层均匀的"龟裂 / 铺路石"网格，
  // 黑缝硬且规则，远看像贴了瓷砖（第一版实测就是这个问题）。
  const nW1 = noiseGrid(6, 0x5a6b7c);
  const nW2 = noiseGrid(6, 0x6b7c8d);
  const nLow = noiseGrid(4, 0x1a2b3c);
  const nMid = noiseGrid(11, 0x2b3c4d);
  const nHi = noiseGrid(29, 0x3c4d5e);
  const nFine = noiseGrid(74, 0x7c8d9e);
  const nGrain = noiseGrid(128, 0x4d5e6f);

  // ---- 高度场：大尺度坡面 + 侵蚀棱线 + 颗粒，全程各向同性 ----
  const H = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const wu = u + (nW1(u, v) - 0.5) * 0.30;
      const wv = v + (nW2(u, v) - 0.5) * 0.30;
      const fbm = 0.44 * nLow(wu, wv) + 0.29 * nMid(wu, wv)
        + 0.19 * nHi(wu, wv) + 0.08 * nFine(wu, wv);
      // 侵蚀棱线只给很轻一层：够读出岩面起伏，又不形成顺坡的长线条
      const ridge = 1 - Math.abs(2 * nMid(wu + 0.13, wv - 0.07) - 1);
      H[y * S + x] = 0.86 * fbm + 0.08 * ridge + 0.06 * (nGrain(u, v) - 0.5);
    }
  }

  // ---- 由高度场烘方向光：柔和的坡面阴影，不是黑色描边 ----
  const at = (x, y) => H[((y + S) % S) * S + ((x + S) % S)];
  const LX = -0.48, LY = -0.55;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) * 6.0;
      const gy = (at(x, y + 1) - at(x, y - 1)) * 6.0;
      // 光从左上打来：朝光的坡亮、背光的坡暗，尺度只有几像素到几十像素
      const lit = THREE.MathUtils.clamp(1 - (gx * LX + gy * LY) * 1.10, 0.70, 1.16);
      const idx = y * S + x;
      const ao = 0.90 + 0.16 * H[idx];
      const grain = 0.96 + 0.08 * nGrain(x / S, y / S);
      const g = Math.max(90, Math.min(255, 250 * lit * ao * grain));
      px[idx * 4] = g * 0.985;
      px[idx * 4 + 1] = g * 0.995;
      px[idx * 4 + 2] = Math.min(255, g * 1.012);
      px[idx * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  mountainRockTexture = tex;

  // 渐进增强：项目自带的岩面照片提供**真实的岩纹细节**（斑驳、细裂、颗粒），
  // 只借它的相对明暗、不借棕色，叠在烘焙坡面阴影之上。
  // 用的是方向性弱的 rock_face（不是山脊旧版那张带竖向岩柱的航拍岩地图），
  // 而且 UV 等比铺，不会再出现从山顶拖到山脚的竖条；加载失败就保留纯烘焙版。
  const photo = new Image();
  photo.onload = () => {
    try {
      const pc = document.createElement('canvas');
      pc.width = pc.height = S;
      const pctx = pc.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(photo, 0, 0, S, S);
      const pd = pctx.getImageData(0, 0, S, S).data;
      const gray = new Float32Array(S * S);
      let mean = 0;
      for (let i = 0; i < S * S; i++) {
        gray[i] = pd[i * 4] * 0.30 + pd[i * 4 + 1] * 0.59 + pd[i * 4 + 2] * 0.11;
        mean += gray[i];
      }
      mean /= S * S;
      for (let i = 0; i < S * S; i++) {
        // 归一化到"围绕 1 的明暗波动"，贴图整体亮度不变，色相仍由顶点色决定
        const d = THREE.MathUtils.clamp((gray[i] - mean) / 110, -1, 1);
        const k = 1 + 0.56 * d;
        for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.max(0, Math.min(255, px[i * 4 + c] * k));
      }
      ctx.putImageData(img, 0, 0);
      tex.needsUpdate = true;
    } catch { /* 跨域 / 解码失败：保留程序化烘焙版 */ }
  };
  photo.src = '/textures/rock/rock_face_diff_1k.jpg';
  return tex;
}

// 岩石（峡谷岩块 / 湖泊礁石）：纯岩面，保留更多原生色相，因为材质那边
// 还要乘一层灰绿色 color，两头都压色相会变成死灰
let rockPhotoTexture = null;
function getRockPhotoTexture() {
  if (!rockPhotoTexture) {
    rockPhotoTexture = makeRockPhotoTexture('/textures/rock/rock_face_diff_1k.jpg', {
      target: 228, contrast: 0.45, hueKeep: 0.30, fallback: getCanyonRockTexture,
    });
  }
  return rockPhotoTexture;
}

// 暴雪雪山专用贴图：近白底 + 冷灰蓝的雪痕/岩缝细节。
// 原来那套 rock/grass 细节贴图里有成片的绿色植被斑，乘以白色顶点色之后
// 仍会透出一层灰绿霉斑（就是“雪山露灰绿岩石大片裸露”的来源），
// 所以暴雪时整层换成这张只有冷灰蓝起伏的雪面。
let snowRockTexture = null;
function getSnowRockTexture() {
  if (snowRockTexture) return snowRockTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261030);
  ctx.fillStyle = '#fbfdfe';
  ctx.fillRect(0, 0, size, size);
  const blob = (x, y, r, style) => {
    ctx.fillStyle = style;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.beginPath();
        ctx.arc(x + ox * size, y + oy * size, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  // 大尺度雪堆明暗：只是很淡的冷灰蓝，不能压出明显色块
  for (let i = 0; i < 40; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 18 + rand() * 40;
    blob(x, y, r, `rgba(196,212,226,${0.08 + rand() * 0.1})`);
  }
  // 中尺度雪脊/沟壑
  for (let i = 0; i < 160; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 4 + rand() * 12;
    blob(x, y, r, `rgba(178,196,212,${0.06 + rand() * 0.1})`);
  }
  // 细颗粒：雪面的细碎起伏
  for (let i = 0; i < 900; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1 + rand() * 3;
    blob(x, y, r, `rgba(214,228,240,${0.18 + rand() * 0.22})`);
  }
  // 极少量岩缝：近山陡壁处露一点点深冷灰，避免整片死白
  ctx.lineWidth = 1.3;
  for (let i = 0; i < 26; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 6 + rand() * 18;
    const a = rand() * Math.PI;
    ctx.strokeStyle = `rgba(126,148,168,${0.10 + rand() * 0.12})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  snowRockTexture = new THREE.CanvasTexture(canvas);
  snowRockTexture.wrapS = THREE.RepeatWrapping;
  snowRockTexture.wrapT = THREE.RepeatWrapping;
  snowRockTexture.colorSpace = THREE.SRGBColorSpace;
  snowRockTexture.anisotropy = 4;
  return snowRockTexture;
}

// ---------- 峡谷岩石专用：青灰岩 + 青绿草坡 + 浸水岩圈 ----------
// 贴图是近白底，颜色全部交给材质 color（贴图和 color 相乘），
// 这样同一张图能同时服务岩石 / 草坡 / 湿面，只靠 color + roughness 区分。
let canyonRockTexture = null;
function getCanyonRockTexture() {
  if (canyonRockTexture) return canyonRockTexture;
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261029);
  ctx.fillStyle = '#eef0ec';
  ctx.fillRect(0, 0, size, size);
  // 九宫格复制保证平铺无接缝
  const blob = (x, y, r, style) => {
    ctx.fillStyle = style;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.beginPath();
        ctx.arc(x + ox * size, y + oy * size, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  // 大块岩面明暗：青灰色系，不能带暖调
  for (let i = 0; i < 46; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 10 + rand() * 28;
    const v = 0.74 + rand() * 0.34;
    blob(x, y, r, `rgba(${Math.round(146 * v)},${Math.round(162 * v)},${Math.round(158 * v)},0.2)`);
  }
  // 中尺度颗粒
  for (let i = 0; i < 420; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 2.2 + rand() * 6;
    const v = 0.78 + rand() * 0.3;
    blob(x, y, r, `rgba(${Math.round(180 * v)},${Math.round(190 * v)},${Math.round(184 * v)},0.34)`);
  }
  // 细颗粒：近看岩石表面不发塑料
  for (let i = 0; i < 1600; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.8 + rand() * 2.2;
    const v = 0.74 + rand() * 0.34;
    blob(x, y, r, `rgba(${Math.round(170 * v)},${Math.round(180 * v)},${Math.round(174 * v)},0.48)`);
  }
  // 层理短缝：沿岩层方向的细线
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 110; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const len = 6 + rand() * 22;
    const a = rand() * Math.PI;
    ctx.strokeStyle = `rgba(96,110,106,${0.10 + rand() * 0.15})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  canyonRockTexture = new THREE.CanvasTexture(canvas);
  canyonRockTexture.wrapS = THREE.RepeatWrapping;
  canyonRockTexture.wrapT = THREE.RepeatWrapping;
  canyonRockTexture.colorSpace = THREE.SRGBColorSpace;
  canyonRockTexture.anisotropy = 4;
  return canyonRockTexture;
}

// 木纹：树干、路灯这类纯棕色构件共用一张竖向纤维贴图。
// 贴图近白底，颜色交给材质 color；repeat 只把纵向拉长，树干的纤维才不会被压成糊块。
let woodGrainTexture = null;
function getWoodGrainTexture() {
  if (woodGrainTexture) return woodGrainTexture;
  woodGrainTexture = makeWoodTexture();
  woodGrainTexture.repeat.set(1, 2);
  return woodGrainTexture;
}

// 峡谷岩石材质组：色调统一收在青灰绿体系里
let canyonRockMats = null;
function getCanyonRockMaterials() {
  if (canyonRockMats) return canyonRockMats;
  const map = getRockPhotoTexture();
  const common = { map, metalness: 0, flatShading: true };
  canyonRockMats = {
    // 两种岩面：参考图那种浅灰岩，差半个色阶让面片层次更清楚
    rockA: new THREE.MeshStandardMaterial({ ...common, color: 0xa9b5b0, roughness: 0.86, envMapIntensity: 0.5 }),
    rockB: new THREE.MeshStandardMaterial({ ...common, color: 0x94a19d, roughness: 0.9, envMapIntensity: 0.45 }),
    // 草坡：粗糙度 1，不吃高光
    grass: new THREE.MeshStandardMaterial({ ...common, color: 0x5e9b6a, roughness: 1.0, envMapIntensity: 0.35 }),
    // 浸水岩圈：低粗糙度表现湿面反光，颜色压深，水面处有一圈明显深色湿痕
    wet: new THREE.MeshStandardMaterial({
      ...common, color: 0x5b6b70, roughness: 0.45, metalness: 0.04, envMapIntensity: 0.7,
    }),
  };
  return canyonRockMats;
}

const _bA = new THREE.Vector3();
const _bB = new THREE.Vector3();
const _bC = new THREE.Vector3();
const _bN = new THREE.Vector3();
const _bCen = new THREE.Vector3();

// 低模岩块：二十面体细分 1 次 → 顶点径向抖动 → 非均匀拉伸。
// 每个三角面按“朝向 + 高度”塞进 岩石/草坡/湿面 三个桶，
// 色块边界沿面片走，天然就是参考图那种分块着色，不用顶点色也不用贴图遮罩。
function buildCanyonBoulder({ radius, halfHeight, centerY, seed, waterY = 0, grass = true, tile = 2.4 }) {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.attributes.position;
  const cache = new Map();
  const noiseAt = (x, y, z) => {
    const key = `${Math.round(x * 100)}|${Math.round(y * 100)}|${Math.round(z * 100)}`;
    let v = cache.get(key);
    if (v === undefined) {
      const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 13.13) * 43758.5453;
      v = s - Math.floor(s);
      cache.set(key, v);
    }
    return v;
  };
  for (let i = 0; i < pos.count; i++) {
    _bA.fromBufferAttribute(pos, i);
    // 同一位置的重复顶点取同一份噪声，面片不会撕开
    const n = noiseAt(_bA.x, _bA.y, _bA.z);
    // 抖动收小：参考图的石头是干净的大面片，不是尖刺
    const s = 1 + (n - 0.5) * 0.22;
    const capY = _bA.y > 0.55 ? 0.9 : 1; // 顶面略压平，草坡有平台感
    _bA.multiplyScalar(s);
    _bA.x *= radius;
    _bA.z *= radius;
    _bA.y = _bA.y * halfHeight * capY;
    pos.setXYZ(i, _bA.x, _bA.y, _bA.z);
  }
  geo.computeVertexNormals();
  const nor = geo.attributes.normal;

  const B = {
    rockA: { p: [], n: [], uv: [] },
    rockB: { p: [], n: [], uv: [] },
    grass: { p: [], n: [], uv: [] },
    wet: { p: [], n: [], uv: [] },
  };
  const emit = (bucket, a, b, c, n) => {
    // 三向投影：按面主朝向挑投影平面，UV 按米铺，近看颗粒尺度一致
    const uvAt = (x, y, z) => {
      if (Math.abs(n.x) > Math.abs(n.y) + 0.05 && Math.abs(n.x) >= Math.abs(n.z)) return [z / tile, y / tile];
      if (Math.abs(n.z) > Math.abs(n.y) + 0.05) return [x / tile, y / tile];
      return [x / tile, z / tile];
    };
    const [u0, v0] = uvAt(a.x, a.y, a.z);
    const [u1, v1] = uvAt(b.x, b.y, b.z);
    const [u2, v2] = uvAt(c.x, c.y, c.z);
    bucket.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    bucket.n.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    bucket.uv.push(u0, v0, u1, v1, u2, v2);
  };

  for (let i = 0; i < pos.count; i += 3) {
    _bA.fromBufferAttribute(pos, i);
    _bB.fromBufferAttribute(pos, i + 1);
    _bC.fromBufferAttribute(pos, i + 2);
    _bN.fromBufferAttribute(nor, i);
    _bCen.copy(_bA).add(_bB).add(_bC).multiplyScalar(1 / 3);
    const worldY = _bCen.y + centerY;
    const faceNoise = noiseAt(_bCen.x * 0.42, _bCen.y * 0.3, _bCen.z * 0.42);
    // 草坡：主体长在岩顶（朝上的面 + 局部高度超过 30%），
    // 低处再撒几块噪声够大的孤立草斑，接近参考图那种覆草岩岛。
    const isGrass = grass
      && _bN.y > 0.42
      && (_bCen.y > halfHeight * 0.3
        ? faceNoise > 0.3
        : _bCen.y > halfHeight * 0.08 && faceNoise > 0.6);
    const isWet = !isGrass && worldY < waterY + 1.6;
    const bucket = isGrass ? B.grass : isWet ? B.wet : (faceNoise > 0.5 ? B.rockA : B.rockB);
    emit(bucket, _bA, _bB, _bC, _bN);
  }

  const toGeo = (b) => {
    if (!b.p.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    return g;
  };
  geo.dispose();
  return { rockA: toGeo(B.rockA), rockB: toGeo(B.rockB), grass: toGeo(B.grass), wet: toGeo(B.wet) };
}

// 把一块岩块按材质桶送进合批器（同一块石头共享一个世界矩阵）
function addCanyonBoulder(merge, parts, matrix) {
  const mats = getCanyonRockMaterials();
  for (const key of ['rockA', 'rockB', 'grass', 'wet']) {
    if (parts[key]) merge.add(parts[key], mats[key], matrix);
  }
}

// ---------- 湖区 / 海岛岸边布景 ----------
// 不靠贴图和高面数：树是三层锥 + 亮/暗两套绿色，石头沿用峡谷的分面分桶，
// 只是换成暖青灰 + 苔藓绿；所有小件都走 StaticMerge 合批。
let shoreMats = null;
// 冬季雪妆的冷白色（岸边植被/岸带在暴雪时往这个色相褪）
const WINTER_TONE = new THREE.Color(0xc7d9e6);
// 岸边礁石在暴雪下的冰蓝（比峡谷岩块淡一档：岸边更靠近水面、受天光更多）
const SHORE_WINTER = { rockA: 0xbfd6e4, rockB: 0x9dbccd, wet: 0x6a8494 };
// 峡谷岩块在暴雪下的替换色：顶面（grass 桶）盖纯雪白，岩面转冰蓝，
// 湿面更深更冷——对齐参考图那种“白顶 + 冰蓝侧面”的覆雪冰石。
// 两个岩面桶刻意拉开半个色阶：暴雪天是弥散光，脸盆一样的浅色会把面片
// 明暗差全吃掉，岩块看着像一块糊平的蓝白板，靠色差补回分面阴影。
const CANYON_WINTER = {
  rockA: { color: 0xb6d1e2, roughness: 0.66, env: 0.72 },
  rockB: { color: 0x8cb0c7, roughness: 0.6, env: 0.78 },
  grass: { color: 0xf4fbff, roughness: 0.95, env: 0.26 },
  wet: { color: 0x5b7b91, roughness: 0.42, env: 0.85 },
};
// 树冠细节贴图：近白底 + 一簇簇明暗叶团 + 少量深色叶缝。
// 材质色只负责“这棵树是什么颜色”，这张图负责“树冠上有一片片叶子”，
// 所以底色必须接近白，否则会把秋色的饱和度一起吃掉。
let leafTexture = null;
function getLeafTexture() {
  if (leafTexture) return leafTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261101);
  ctx.fillStyle = '#f0f2ec';
  ctx.fillRect(0, 0, size, size);
  // 九宫格复制：贴图要在锥形树冠上平铺，边缘必须接得上
  const blob = (x, y, r, style) => {
    ctx.fillStyle = style;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        ctx.beginPath();
        ctx.ellipse(x + ox * size, y + oy * size, r, r * 0.72, rand() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };
  // 叶团：亮暗交错的小椭圆，远看是“一簇一簇”的体积感
  for (let i = 0; i < 220; i++) {
    const v = 0.86 + rand() * 0.28;
    blob(rand() * size, rand() * size, 3 + rand() * 7,
      `rgba(${Math.round(238 * v)},${Math.round(240 * v)},${Math.round(228 * v)},0.55)`);
  }
  // 叶缝：少量深色细点，否则整棵树远看还是糊成一块
  for (let i = 0; i < 90; i++) {
    blob(rand() * size, rand() * size, 1 + rand() * 2.4,
      `rgba(96,102,84,${0.10 + rand() * 0.14})`);
  }
  leafTexture = new THREE.CanvasTexture(canvas);
  leafTexture.wrapS = THREE.RepeatWrapping;
  leafTexture.wrapT = THREE.RepeatWrapping;
  leafTexture.colorSpace = THREE.SRGBColorSpace;
  leafTexture.anisotropy = 4;
  return leafTexture;
}

function getShoreMats() {
  if (shoreMats) return shoreMats;
  const common = { metalness: 0, flatShading: true };
  // 树叶统一走「材质色 × 顶点色 × 细节贴图」三乘：
  // 材质色 = 这棵树的色相（青绿 / 金 / 锈红 / 淡粉），
  // 顶点色 = 树冠自遮挡 AO（越靠下越暗），
  // 贴图 = 一簇簇叶团的明暗颗粒。
  // 单靠 flatShading 纯色，树永远是一块塑料片。
  const leaf = (color) => new THREE.MeshStandardMaterial({
    color, map: getLeafTexture(), vertexColors: true, roughness: 0.94, flatShading: true,
  });
  shoreMats = {
    // 树干：木纹只补纤维质感，色相仍由 color 定（远近景都一致）
    trunk: new THREE.MeshStandardMaterial({
      color: 0x6b4a33, map: getWoodGrainTexture(), roughness: 0.92, flatShading: true,
    }),
    // 受光面 / 背光面 / 新叶三套绿色：同一棵树上下层交替，远看自带明暗分层
    leafA: leaf(0x4e9e57),
    leafB: leaf(0x2e6b3e),
    leafC: leaf(0x74b45e),
    // 秋色三档：金黄 / 锈红 / 淡粉。和三种绿随机混生，
    // 参考图里那种暖调树林就是靠这几档色相撑起来的
    leafGold: leaf(0xd2a240),
    leafRust: leaf(0xb0512c),
    leafPink: leaf(0xc98ea4),
    bush: leaf(0x5c8f4a),
    // 岩石：复用峡谷那张近白底岩面贴图（岩面颗粒/层理），颜色靠 color 分两档
    rockA: new THREE.MeshStandardMaterial({
      ...common, map: getRockPhotoTexture(), color: 0x8a8d88, roughness: 0.9, envMapIntensity: 0.4,
    }),
    rockB: new THREE.MeshStandardMaterial({
      ...common, map: getRockPhotoTexture(), color: 0x6e716c, roughness: 0.95, envMapIntensity: 0.35,
    }),
    // 草坡：同样只铺细节颗粒，草色由 color 定，避免整块平涂
    grass: new THREE.MeshStandardMaterial({
      ...common, map: getRockGrassTexture(), color: 0x6fa35a, roughness: 1.0,
    }),
    wet: new THREE.MeshStandardMaterial({
      ...common, color: 0x59656a, roughness: 0.5, metalness: 0.04, envMapIntensity: 0.55,
    }),
    bank: new THREE.MeshStandardMaterial({
      // 底色压成浅灰绿：顶点色只负责大关系，贴图补草/石颗粒，
      // 否则一整条岸在直射光下会像一块刷了绿漆的平板（截图里被误认成沙滩）
      color: 0xc8d0bd,
      map: getRockGrassTexture(),
      vertexColors: true,
      roughness: 1.0,
      metalness: 0,
      envMapIntensity: 0.3,
      side: THREE.DoubleSide,
    }),
  };
  return shoreMats;
}

// 顶点抖动：同一套基础几何按树随机推拉一圈，远景也不会看出"复制粘贴"
function jitterVerts(geo, amount, rng) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(
      i,
      p.getX(i) * (1 + (rng() - 0.5) * amount),
      p.getY(i) * (1 + (rng() - 0.5) * amount * 0.6),
      p.getZ(i) * (1 + (rng() - 0.5) * amount),
    );
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// 树冠顶点 AO：越靠下越暗（叶片互相遮挡），顶部接近原色；
// 再给每个顶点一点斑驳，同一棵树的两层不会是一块纯色。
// 材质开了 vertexColors，这里写的是灰度乘子，只压亮度不改色相。
function bakeCrownAO(geo, yLow, yHigh, rng, lo = 0.50, hi = 1.0) {
  const p = geo.attributes.position;
  const span = Math.max(1e-3, yHigh - yLow);
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = THREE.MathUtils.clamp((p.getY(i) - yLow) / span, 0, 1);
    const ao = lo + (hi - lo) * Math.pow(t, 0.65);
    const v = ao * (0.93 + rng() * 0.14);
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v * 0.98; // 背光面略偏冷
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// 秋色混生：整棵树一个色系（不会出现“同一棵树上下金绿乱跳”），
// 绿树靠亮暗两层拉层次，金/锈红/粉整棵统一，靠顶点 AO 出体积。
const AUTUMN_KEYS = ['leafGold', 'leafRust', 'leafPink'];
function pickLeafKey(rng) {
  const r = rng();
  if (r < 0.30) return 'leafA';
  if (r < 0.48) return 'leafB';
  if (r < 0.60) return 'leafC';
  if (r < 0.78) return AUTUMN_KEYS[0];
  if (r < 0.92) return AUTUMN_KEYS[1];
  return AUTUMN_KEYS[2];
}

// 针叶树：树干短粗、底部插进地面，树冠由大到小收尖（三层 + 逐层随机偏移/大小）
function addPineTree(merge, mats, { x, z, y, h, w, rng }) {
  const trunkH = h * 0.3;
  const trunk = new THREE.CylinderGeometry(w * 0.16, w * 0.26, trunkH, 6);
  trunk.translate(x, y + trunkH * 0.5, z);
  merge.add(trunk, mats.trunk);
  const crownBase = y + trunkH * 0.9;
  const layerH = h * 0.46;
  // 整棵树一个色系：金叶树整棵金黄，绿树上下层亮暗交替（远看有体积）
  const hue = pickLeafKey(rng);
  const alt = hue === 'leafA' ? 'leafB' : hue === 'leafB' ? 'leafA' : hue;
  for (let L = 0; L < 3; L++) {
    const layerHt = layerH * (1 - L * 0.1);
    const cone = new THREE.ConeGeometry(w * (1 - L * 0.27) * (0.9 + rng() * 0.22), layerHt, 7);
    const ox = (rng() - 0.5) * w * 0.18;
    const oz = (rng() - 0.5) * w * 0.18;
    cone.rotateY(rng() * Math.PI * 2);
    const cy = crownBase + layerH * 0.5 + L * h * 0.2;
    cone.translate(x + ox, cy, z + oz);
    bakeCrownAO(cone, cy - layerHt * 0.5, cy + layerHt * 0.5, rng);
    merge.add(cone, mats[(L + (rng() > 0.5 ? 1 : 0)) % 2 ? alt : hue]);
  }
}

/* ---------------------------------------------------------------- 写实松树
 * 来源：Poly Haven「Pine Sapling Small」（CC0）。原始是摄影测量模型，每棵
 * 39.8 万三角面，一棵就吃掉整条赛道的预算。用
 *   scripts/blender/build_pine_assets.py
 * 减到「针叶 1300 + 树干 220 = 1520 面」，贴图缩到 512，三个变体一共 865KB。
 *
 * 用 InstancedMesh 铺而不是合批：三个变体 × 150 棵也只有几个 draw call，
 * 而且针叶材质是 alphaTest 贴面片，合批成一个大 mesh 反而更难裁剪。
 */
const PINE_URL = '/models/pine_trees.glb';
let pineVariants = null;    // [{ geo, material, height, radius }] | null = 加载失败
let pinePromise = null;

function loadPineVariants() {
  if (pinePromise) return pinePromise;
  pinePromise = new Promise((resolve) => {
    new GLTFLoader().load(
      PINE_URL,
      (gltf) => {
        // 注意：一棵树在 glTF 里是「树干 + 针叶」两个 primitive，three 的 GLTFLoader
        // 会把它们拆成**两个 Mesh**（各自一棵单材质）。所以必须按父节点分组合并，
        // 否则拿到的是一堆"只有针叶"或"只有树干"的半个模型。
        const byNode = new Map();
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          const geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          // mergeGeometries 要求属性集合完全一致：法线贴图会带 tangent，
          // 树干和针叶不一定都有，先把多余属性删掉只留 position/normal/uv
          for (const name of Object.keys(geo.attributes)) {
            if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
          }
          const key = o.parent?.name || o.name;
          if (!byNode.has(key)) byNode.set(key, []);
          byNode.get(key).push({ geo, mat: o.material });
        });

        const out = [];
        for (const [key, parts] of byNode) {
          const merged = mergeGeometries(parts.map((p) => p.geo), true);
          if (!merged) continue;
          merged.computeBoundingBox();
          const bb = merged.boundingBox;
          out.push({
            name: key,
            geo: merged,
            // useGroups=true 时合并后的几何体按输入顺序分组，材质数组要一一对应
            material: parts.map((p) => p.mat),
            height: Math.max(0.2, bb.max.y - bb.min.y),
            radius: Math.max(0.12, Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z) * 0.5),
          });
        }
        out.sort((a, b) => (a.name < b.name ? -1 : 1));
        for (const v of out) {
          for (const m of v.material) {
            if (!m) continue;
            // 岸边这一圈没有探针反射，环境贴图给太强整棵树会发亮
            m.envMapIntensity = 0.35;
            m.needsUpdate = true;
          }
        }
        resolve(out.length ? out : null);
      },
      undefined,
      () => resolve(null),   // 加载失败 → 上层退回程序化锥形树
    );
  });
  return pinePromise;
}

/* ---------------------------------------------------------------- 写实礁石
 * 来源：Poly Haven「Rock 07」（CC0）。原始 14844 面 → Blender 减到 1499 面，
 * 贴图缩到 512，单个 148KB。
 * 竞速地图里原本的礁石是"标准十二面体 + 纯灰平涂"，一眼假；换成这个模型后
 * 轮廓和表面都是真实岩石。同样是 InstancedMesh：一块几何体铺满全场。
 */
const BOULDER_URL = '/models/rock_boulder.glb';
let boulderVariant = null;
let boulderPromise = null;

/**
 * 礁石贴图的亮度归一化。
 * Poly Haven 的 diff 是真实曝光下的玄武岩，均值只有 0.3~0.4；再乘上模型自带的
 * 顶点色（0.67~0.85，摄影测量烘焙的 AO）就压成一块黑疙瘩 —— 在明亮的卡通水面里
 * 像抠出来的洞。这里把均值抬到 target，系数夹在 [1, 2.2]，暗纹不会翻白。
 */
function normalizeBoulderColor(mat, target = 0.62) {
  const img = mat?.map?.image;
  if (!img?.width) return 1;
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    }
    const mean = sum / (d.length / 4) || 0.35;
    const k = Math.min(2.2, Math.max(1, target / Math.max(0.05, mean)));
    mat.color.setScalar(k);
    return +k.toFixed(2);
  } catch {
    return 1;
  }
}

function loadBoulderVariant() {
  if (boulderPromise) return boulderPromise;
  boulderPromise = new Promise((resolve) => {
    new GLTFLoader().load(
      BOULDER_URL,
      (gltf) => {
        let found = null;
        gltf.scene.updateMatrixWorld(true);
        gltf.scene.traverse((o) => {
          if (found || !o.isMesh || !o.geometry) return;
          const geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          geo.computeBoundingBox();
          const bb = geo.boundingBox;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          found = {
            geo,
            // 必须存**单个**材质，不能存数组：InstancedMesh 拿到数组时会去遍历
            // geometry.groups 逐组下发，而 GLB 单 primitive 的几何体 groups 是空的，
            // 结果一个渲染项都进不了渲染列表 —— 网格在场景里、visible=true、
            // 实例矩阵也对，就是画不出来（礁石隐身一整轮就是栽在这）。
            material: mats[0],
            materials: mats,
            // 真实包围盒高度，**不要**夹到 0.2：这块石头高 0.143、宽 0.321（扁圆石），
            // 夹上去等于虚报 40%，下面按比例算"露出多少"时会连带算错一整截。
            height: Math.max(0.02, bb.max.y - bb.min.y),
            width: Math.max(0.2, Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z)),
          };
          for (const m of mats) {
            if (!m) continue;
            // 顶点色是摄影测量烘的 AO，和 diff 贴图叠在一起等于把石头压暗两遍
            m.vertexColors = false;
            m.envMapIntensity = 0.55;
            // 这块礁石在场景里会被放大 20 倍上下，法线细节跟着放大成一身高频噪点，
            // 远看就是一层"油亮的塑料"。压到 0.55 只留下起伏感。
            if (m.normalScale) m.normalScale.set(0.55, 0.55);
            found.gain = normalizeBoulderColor(m, 0.62);
            // 改 vertexColors 会换 shader 变体，必须让材质重新编译
            m.needsUpdate = true;
          }
          found.geo.deleteAttribute?.('color');
        });
        resolve(found);
      },
      undefined,
      () => resolve(null),
    );
  });
  return boulderPromise;
}

// 阔叶树：树干 + 2～3 团抖过顶点的多面体树冠，剪影和针叶树完全不同
function addBroadTree(merge, mats, { x, z, y, h, w, rng }) {
  const trunkH = h * 0.4;
  const trunk = new THREE.CylinderGeometry(w * 0.13, w * 0.22, trunkH, 6);
  trunk.translate(x, y + trunkH * 0.5, z);
  merge.add(trunk, mats.trunk);
  const crownY = y + trunkH * 0.92;
  const blobs = 2 + (rng() > 0.5 ? 1 : 0);
  const hue = pickLeafKey(rng);
  for (let b = 0; b < blobs; b++) {
    const r = w * (0.62 + rng() * 0.26);
    const blob = jitterVerts(new THREE.IcosahedronGeometry(r, 1), 0.34, rng);
    blob.scale(1, 0.82, 1);
    const bx = x + (b === 0 ? 0 : (rng() - 0.5) * w * 1.05);
    const by = crownY + (b === 0 ? h * 0.2 : h * (0.1 + rng() * 0.2));
    const bz = z + (b === 0 ? 0 : (rng() - 0.5) * w * 1.05);
    blob.translate(bx, by, bz);
    bakeCrownAO(blob, by - r * 0.95, by + r * 0.95, rng);
    merge.add(blob, mats[hue]);
  }
}

// 岸边灌木 / 芦苇丛：贴地小件，专门负责岸边"有东西"的接触细节
function addShoreBush(merge, mats, { x, z, y, s, rng }) {
  const blobs = 2 + (rng() > 0.5 ? 1 : 0);
  for (let b = 0; b < blobs; b++) {
    const r = s * (0.4 + rng() * 0.22);
    const blob = jitterVerts(new THREE.IcosahedronGeometry(r, 0), 0.4, rng);
    blob.scale(1, 0.6, 1);
    const bx = x + (rng() - 0.5) * s * 0.9;
    const by = y + r * 0.42 + rng() * s * 0.1;
    const bz = z + (rng() - 0.5) * s * 0.9;
    blob.translate(bx, by, bz);
    bakeCrownAO(blob, by - r * 0.7, by + r * 0.7, rng);
    merge.add(blob, rng() > 0.5 ? mats.bush : mats.leafB);
  }
}

function addReeds(merge, mats, { x, z, y, s, rng }) {
  const n = 4 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const bladeH = s * (0.7 + rng() * 0.9);
    const blade = new THREE.ConeGeometry(s * 0.11, bladeH, 3);
    blade.rotateZ((rng() - 0.5) * 0.5);
    blade.translate(
      x + (rng() - 0.5) * s * 1.15,
      y + bladeH * 0.5 - 0.06,
      z + (rng() - 0.5) * s * 1.15,
    );
    // 芦苇叶也用同一套叶片材质（开了顶点色），没有 color 属性会整片变黑
    bakeCrownAO(blade, y - 0.06, y + bladeH - 0.06, rng);
    merge.add(blade, rng() > 0.4 ? mats.grass : mats.leafC);
  }
}

// 多面主石 + 苔藓顶 + 周围 2～3 块碎石；底部半沉水面
function addShoreRock(merge, mats, { x, z, size, seed, ry = 0, waterY = 0, baseY = null, colliders = null }) {
  const halfHeight = size * (0.62 + ((seed * 7) % 10) / 25);
  const centerY = (baseY ?? waterY) + size * 0.1;
  const parts = buildCanyonBoulder({ radius: size, halfHeight, centerY, seed, waterY, grass: true });
  if (colliders) {
    colliders.push({ type: 'rock', x, z, r: size * 0.9, bottomY: centerY - halfHeight, topY: centerY + halfHeight });
  }
  for (const key of ['rockA', 'rockB', 'grass', 'wet']) {
    if (parts[key]) merge.add(parts[key], mats[key], trs(x, centerY, z, 0, ry, 0, 1, 1, 1));
  }
  const n = 2 + (seed % 2);
  for (let i = 0; i < n; i++) {
    const a = (seed % 97) * 0.13 + i * 2.2;
    const d = size * (1.05 + ((seed + i * 13) % 7) / 10);
    const s = size * (0.16 + ((seed + i * 29) % 8) / 60);
    const geo = new THREE.DodecahedronGeometry(s, 0);
    merge.add(geo, i % 2 ? mats.rockB : mats.rockA,
      trs(x + Math.cos(a) * d, (baseY ?? waterY) + s * 0.35, z + Math.sin(a) * d, 0, a, 0, 1, 0.72, 1));
  }
}

// 浅滩堤岸：沿赛道中线两侧铺一条带状地形。
// 内缘没入水下 → 湿石水线 → 草坡 → 岸顶 → 外坡再落回水里。
// 整条岸只走青绿/岩灰，不再铺米色沙带——那种平摊的浅色面片远看就像一片沙滩，非常出戏。
// 剖面数据是唯一的：地形网格和树/石落地高度都按它插值，保证没有悬空的树。
function makeShoreProfile({ gateWidth, topY, waterY }) {
  const inner = gateWidth + 2;
  const crown = gateWidth + 11;
  const outer = gateWidth + 17;
  return [
    { off: inner, y: waterY - 1.0, c: 0x55695f },
    { off: inner + 1.4, y: waterY - 0.35, c: 0x5b7263 },
    { off: inner + 3.2, y: waterY + 0.18, c: 0x627b58 },
    { off: inner + 5.6, y: waterY + 0.72, c: 0x5c7a49 },
    { off: crown - 2.4, y: topY - 0.3, c: 0x567741 },
    { off: crown, y: topY, c: 0x4f7139 },
    { off: crown + 4.2, y: topY - 0.3, c: 0x486836 },
    { off: outer, y: waterY - 0.85, c: 0x3f5c31 },
  ];
}

// 岸坡在某个横向偏移处的高度（线性插值相邻剖面环）
function shoreHeightAt(profile, off) {
  if (off <= profile[0].off) return profile[0].y;
  const last = profile[profile.length - 1];
  if (off >= last.off) return last.y;
  for (let i = 0; i < profile.length - 1; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (off >= a.off && off <= b.off) {
      return a.y + (b.y - a.y) * ((off - a.off) / Math.max(1e-6, b.off - a.off));
    }
  }
  return last.y;
}

function buildShoreBankGeometry(gates, { profile, rng, shortcuts = [] }) {
  const curve = new THREE.CatmullRomCurve3(
    gates.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'catmullrom', 0.5,
  );
  // 岸带是沿主道两侧「连续」铺的草坡，原本对近道毫无概念：湖泊近道从
  // gates[8]=(0,88) 往岛内侧切，正好被内侧那一幅草坡盖住，抄近道就会从
  // 草地里穿过去。这里逐格裁掉压进近道走廊的岸带面，入口上方保持干净水面。
  // 只删三角形、不删顶点，也不动 rng 的调用次数（先摇完再判断），
  // 否则后面整片岸边的树会跟着 rng 序列整体挪位。
  const clearOfShortcut = (x, z) => {
    for (const sc of shortcuts) {
      const pts = sc.points || [];
      const limit = sc.width + 2.5;
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        const sx = bx - ax;
        const sz = bz - az;
        const len2 = sx * sx + sz * sz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
        if (Math.hypot(x - (ax + sx * t), z - (az + sz * t)) < limit) return false;
      }
    }
    return true;
  };
  const SEG = 140;
  const length = curve.getLength();
  const pos = [];
  const col = [];
  const uv = [];
  const idx = [];
  const color = new THREE.Color();
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (const side of [-1, 1]) {
    const base = pos.length / 3;
    for (let i = 0; i < SEG; i++) {
      curve.getPointAt(i / SEG, p);
      curve.getTangentAt(i / SEG, t);
      const nx = -t.z;
      const nz = t.x;
      const jitter = (rng() - 0.5) * 0.5;
      for (let ri = 0; ri < profile.length; ri++) {
        const r = profile[ri];
        // 只在草坡段抖外轮廓，水线保持规整
        const off = r.off + jitter * (ri >= 2 && ri <= 6 ? 1.1 : 0.4) * side;
        const y = r.y + (ri >= 2 && ri <= 6 ? Math.abs(jitter) * 0.22 : Math.abs(jitter) * 0.06);
        pos.push(p.x + nx * off * side, y, p.z + nz * off * side);
        // 沿赛道 + 横向各带一点明暗：同一块岸面不再是一条纯色带
        const shade = 0.88 + ((i * 7) % 11) * 0.015 + ri * 0.012;
        color.setHex(r.c).multiplyScalar(shade);
        col.push(color.r, color.g, color.b);
        uv.push((i / SEG) * (length / 7), (ri / (profile.length - 1)) * 3);
      }
    }
    const R = profile.length;
    for (let i = 0; i < SEG; i++) {
      const a = base + i * R;
      const b = base + ((i + 1) % SEG) * R;
      for (let ri = 0; ri < R - 1; ri++) {
        // 四角只要有一角压进近道走廊，这一格草坡就整个不生成
        const corners = [a + ri, b + ri + 1, a + ri + 1, b + ri];
        const blocked = corners.some((k) => !clearOfShortcut(pos[k * 3], pos[k * 3 + 2]));
        if (blocked) continue;
        idx.push(a + ri, b + ri + 1, a + ri + 1, a + ri, b + ri, b + ri + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, getShoreMats().bank);
}

// 岩岛底部的接触阴影：水面没有 receiver，真实方向光阴影照不到水上，
// 这里把“岩岛根部一圈深色”烘到一张俯视遮罩里，交给水面着色器直接压暗水色。
// 比单独一块透明贴片稳：贴片平铺在水面时，低机位的深度测试会被更近的水面整片吃掉，
// 关掉深度测试又会横穿岩体变成一条硬线。烘进水面还能跟着波浪一起起伏。
function buildShoreShadowCanvas(colliders, pad) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let any = false;
  for (const c of colliders) {
    if (c.type !== 'rock' && c.type !== 'cliff' && c.type !== 'island') continue;
    any = true;
    minX = Math.min(minX, c.x - c.r);
    maxX = Math.max(maxX, c.x + c.r);
    minZ = Math.min(minZ, c.z - c.r);
    maxZ = Math.max(maxZ, c.z + c.r);
  }
  if (!any) return null;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // 方形覆盖：边长取包围盒长边 + 余量，遮罩外的水面不采样
  const half = Math.max(maxX - minX, maxZ - minZ) / 2 + pad;
  const toPx = (v) => ((v - cx + half) / (half * 2)) * size;
  const scale = size / (half * 2);
  for (const c of colliders) {
    if (c.type !== 'rock' && c.type !== 'cliff' && c.type !== 'island') continue;
    const px = toPx(c.x);
    const py = toPx(c.z);
    const pr = c.r * 1.2 * scale;
    // 环状渐变：内侧压在岩体水线 footprint 上（岩体自己盖住大半），向外柔和淡出。
    // 水面本身已经很暗，阴影只需贴着岩体轻压一点；压太狠就成一摊黑斑
    const grad = ctx.createRadialGradient(px, py, pr * 0.45, px, py, pr);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.6)');
    grad.addColorStop(0.75, 'rgba(255,255,255,0.22)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // 遮罩按世界坐标(x,z)直接算 UV，canvas 第 0 行就是 minZ 那一侧，
  // 所以关掉默认的 flipY，否则遮罩会在 Z 轴镜像，落影整个错位
  tex.flipY = false;
  // 只当数据用，不做色彩空间转换
  tex.colorSpace = THREE.NoColorSpace;
  return { tex, minX: cx - half, minZ: cz - half, span: half * 2 };
}

// 冰壳贴图：冰纹 + 放射状 alpha 渐隐。
// CircleGeometry 的 UV 就是以圆心 0.5/0.5 展开的方形，所以"中心不透明、边缘透明"的
// 一张贴图就能让冰壳边界自然化开，不用为此写 shader。
let iceTexture = null;
function getIceTexture() {
  if (iceTexture) return iceTexture;
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(770311);
  // 底色近纯白：冰面本身要白，颜色层次交给裂缝与薄冰斑块，
  // 这样霓虹护栏（青蓝）和冰面（白）之间才有明度差。
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  // 大块冰面明暗：厚冰偏白、薄冰偏蓝
  for (let i = 0; i < 70; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 40 + rand() * 150;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const blue = rand() > 0.45;
    g.addColorStop(0, blue ? 'rgba(150,196,220,0.42)' : 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 冰裂纹：先画暗色裂缝，再用 destination-out 沿同一条路径"挖穿"，
  // 让下面的海水透出来——冰面有没有结构，全看这几条缝
  const cracks = [];
  for (let i = 0; i < 54; i++) {
    let x = rand() * size;
    let y = rand() * size;
    let a = rand() * Math.PI * 2;
    const segs = 5 + Math.floor(rand() * 8);
    const pts = [[x, y]];
    for (let s = 0; s < segs; s++) {
      a += (rand() - 0.5) * 0.9;
      x += Math.cos(a) * (16 + rand() * 46);
      y += Math.sin(a) * (16 + rand() * 46);
      pts.push([x, y]);
    }
    cracks.push({ pts, w: 1.4 + rand() * 3.4, alpha: 0.3 + rand() * 0.4 });
  }
  const strokeCracks = (mul, color, alphaMul) => {
    ctx.globalCompositeOperation = 'source-over';
    for (const c of cracks) {
      ctx.beginPath();
      ctx.moveTo(c.pts[0][0], c.pts[0][1]);
      for (let i = 1; i < c.pts.length; i++) ctx.lineTo(c.pts[i][0], c.pts[i][1]);
      ctx.lineWidth = c.w * mul;
      ctx.strokeStyle = `rgba(${color},${c.alpha * alphaMul})`;
      ctx.stroke();
    }
  };
  // 开阔水道（lead）：几道更宽的水道把整片白冰切开，
  // 不然远看就是一整块"雪原"，没有冰原该有的块面关系。
  // 只用浅蓝灰**画**出来，不做 destination-out：挖 alpha 的像素上传到不透明材质后
  // RGB 会被预乘还原成黑色，冰面上直接出现一道道"水沟"，就是玩家说的乱码。
  ctx.globalCompositeOperation = 'source-over';
  ctx.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    let px = rand() * size;
    let py = rand() * size;
    let ang = rand() * Math.PI * 2;
    const len = 180 + rand() * 320;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let s = 0; s < 4; s++) {
      ang += (rand() - 0.5) * 0.5;
      px += Math.cos(ang) * (len / 4);
      py += Math.sin(ang) * (len / 4);
      ctx.lineTo(px, py);
    }
    ctx.lineWidth = 6 + rand() * 9;
    ctx.strokeStyle = `rgba(186,214,232,${0.16 + rand() * 0.12})`;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  // 冰裂纹：全部画在冰壳上（不挖洞）。外圈浅色晕开 + 内核淡蓝灰，
  // 这样近看是一条有厚度的缝，远看是一组结构线；颜色必须压在冰面附近，
  // 一旦画深就成了"冰上流水"。
  strokeCracks(1.7, '176,206,226', 0.55);
  strokeCracks(0.7, '128,166,192', 0.7);
  // 霜点：白底上纯白点看不见，改用冷灰蓝做细颗粒
  for (let i = 0; i < 2200; i++) {
    ctx.fillStyle = `rgba(188,214,232,${0.08 + rand() * 0.26})`;
    ctx.fillRect(rand() * size, rand() * size, 2, 2);
  }
  // 边缘：UV 半径 0.5 处就是圆盘边缘，用一圈浅蓝白色把边界"化"进水里。
  // 只改 RGB 不改 alpha——冰壳是不透明材质，alpha 渐变只会带来预乘黑边。
  const rim = ctx.createRadialGradient(size / 2, size / 2, size * 0.1, size / 2, size / 2, size * 0.5);
  rim.addColorStop(0, 'rgba(255,255,255,0)');
  rim.addColorStop(0.86, 'rgba(228,244,252,0.35)');
  rim.addColorStop(1, 'rgba(206,234,248,0.95)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);
  iceTexture = new THREE.CanvasTexture(canvas);
  iceTexture.colorSpace = THREE.SRGBColorSpace;
  iceTexture.anisotropy = 4;
  return iceTexture;
}

// 远景山脉调色：按海域固定，不随天气变化（天气只动天空/光照/水面）。
// far 淡蓝灰、mid 稍深、near 岩石+植被，配合山脚雾气形成大气透视。
const WHITE_TINT = { r: 1, g: 1, b: 1 };
const MOUNTAIN_PALETTES = {
  canyon: { near: 0xb1a189, veg: 0x7d8560, mid: 0x81909a, far: 0x6a8499, sky: 0xc9b29b },
  lake: { near: 0x989c8b, veg: 0x6b8760, mid: 0x77899c, far: 0x64809a, sky: 0xc4dff0 },
  ocean: { near: 0x8f9184, veg: 0x647f66, mid: 0x637f96, far: 0x5b7891, sky: 0xbfe6f7 },
  arena: { near: 0x8a9280, veg: 0x63805a, mid: 0x748997, far: 0x6d879c, sky: 0xc4dff0 },
  // 怪物模式四关的山体：第一关熔岩火山（深褐岩 + 暗红顶），其余按关卡特色
  volcano: { near: 0x4a3226, veg: 0x6b3a1e, mid: 0x3d2a22, far: 0x2e211d, sky: 0x351a14 },
  tropical: { near: 0x7f9a62, veg: 0x4f7a3a, mid: 0x5b8c8a, far: 0x4c7f96, sky: 0xbfeaf7 },
  harbor: { near: 0x6a6156, veg: 0x5a6a4a, mid: 0x6f7377, far: 0x5f6b74, sky: 0x707a7a },
  ice: { near: 0x8fa8bc, veg: 0xa8c4d8, mid: 0x7693ad, far: 0x5c7793, sky: 0x08131f },
};

// 三层山脊：offset 是相对地图边界的距离，haze 是整体大气透视程度。
// hMin 压低、hMax 抬高是为了让"谷底"和"峰顶"真正拉开：原来 16~96m 的高度区间
// 配上被压平的高度函数，天际线看起来就是一条几乎水平的锯齿墙。
// depth 是山体的**纵深**（外山脚到内山脚的世界距离）——以前只有 h*inset≈30m，
// 整个山是一张朝场内倾斜的纸片；给到百米级才有前后两个坡面和真正的山谷。
const MOUNTAIN_LAYERS = [
  // tileM 是「一张贴图铺多少米」。烘焙岩面贴图里有 8×8 个岩块，一张要落在
  // 屏幕上几十像素才看得见块面明暗：原来 110/230/380m 一张，整座山只有 1~2 个
  // tile，mipmap 一平均就成了一块平滑灰板（用户："贴图几乎没有，太贫瘠了"）。
  // 收到 72/130/210m 后一层山能看到 2~4 个 tile，仍是等比铺、不会拉长。
  { key: 'near', offset: 170, hMin: 6, hMax: 138, depth: 160, haze: 0.03, sharp: 1.0, seed: 11, tileM: 72 },
  { key: 'mid', offset: 380, hMin: 24, hMax: 236, depth: 270, haze: 0.05, sharp: 1.05, seed: 23, tileM: 130 },
  // far 原来 haze 0.62：整层被雾色糊成一块灰蓝剪影（用户反馈"一直模糊"）。
  // 现在只留 0.08 做大气透视，山脊本身仍有起伏、明暗和雪线
  { key: 'far', offset: 640, hMin: 56, hMax: 388, depth: 420, haze: 0.08, sharp: 1.15, seed: 37, tileM: 210 },
];

// 画质 → 每层山脊的横向分段数（低画质三层都保留，只减少分段，层次不会塌）
const MOUNTAIN_SEGMENTS = {
  high: [384, 224, 128],
  medium: [192, 128, 80],
  low: [128, 64, 48],
};
// 纵深分段（外山脚 → 山脊 → 内山脚）。这是"纸片墙"和"真山体"的分水岭：
// 只有一行顶点时，高度只能沿角向变化，纵向是直线插值，永远读不出山坡和谷地。
const MOUNTAIN_BANDS = {
  high: [12, 10, 8],
  medium: [9, 8, 7],
  low: [7, 6, 5],
};

/**
 * 二维平滑值噪声：u 是角向（环形 wrap），v 是纵深（0~1，钳制不 wrap）。
 * 高度场必须同时在两个方向变化，否则山体只是"一条有起伏的线"被纵向拉伸，
 * 山谷不会朝场内开口，也长不出支脉。
 */
function makeMountainNoise2D(seed, nx, ny) {
  const rand = mulberry32(seed);
  const g = Array.from({ length: nx }, () => Array.from({ length: ny }, () => rand()));
  return (u, v) => {
    const x = u * nx;
    const y = Math.min(1, Math.max(0, v)) * (ny - 1);
    const x0 = ((Math.floor(x) % nx) + nx) % nx;
    const x1 = (x0 + 1) % nx;
    const y0 = Math.min(ny - 2, Math.floor(y));
    const y1 = y0 + 1;
    let fx = x - Math.floor(x);
    let fy = y - y0;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = g[x0][y0] + (g[x1][y0] - g[x0][y0]) * fx;
    const b = g[x0][y1] + (g[x1][y1] - g[x0][y1]) * fx;
    return a + (b - a) * fy;
  };
}


// 雨雪粒子用柔边圆点贴图：PointsMaterial 默认画方块，在写实天空下像白色小方片
let softDotTexture = null;
function getSoftDotTexture() {
  if (softDotTexture) return softDotTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.62)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  softDotTexture = new THREE.CanvasTexture(canvas);
  softDotTexture.colorSpace = THREE.SRGBColorSpace;
  return softDotTexture;
}

// 雪片图集：8 种轮廓（实心圆点 / 不规则雪团 / 小雪簇 / 六角星 / 斜拉丝 /
// 五角星 / 双球 / 碎边毛团），每片雪随机抽一格。
//
// 2026-11-18 用户反馈：「不要形状规则都一样的雪花」。旧版只有一张径向渐变圆点，
// 3600 颗全是同一个圆 —— 远看就是一片白噪点，凑近每片一模一样，很假。
// 现在改成图集，加 shader 里逐片 UV 取格 + 逐片旋转，形状/朝向都不同。
//
// 为什么图集不能用 mipmap：相邻格子会被线性采样到，小雪片会带出隔壁星的尖角。
// 直接 LinearFilter + 不生成 mipmap，代价是极小时略闪，但雪本来就是噪点，看不出。
let snowFlakeAtlas = null;
export function getSnowFlakeAtlas() {
  if (snowFlakeAtlas) return snowFlakeAtlas;
  const CELL = 64;
  const COLS = 4;
  const ROWS = 2;
  const canvas = document.createElement('canvas');
  canvas.width = CELL * COLS;
  canvas.height = CELL * ROWS;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(97531);
  const c = CELL / 2;
  const white = (a) => `rgba(255,255,255,${a})`;
  // 柔边实心点：中心实、只有外圈 fade，避免看成"失焦光斑"
  // 核心必须"实"：旧版 0.42→0.76 就开始掉到 0.52，8px 的雪片只有 3px 是亮的，
  // 放到亮天空上就读成一团灰雾。现在 0.62 之前基本满不透明，只有最外圈收边。
  const dot = (x, y, r, a = 1) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, white(a));
    g.addColorStop(0.62, white(a * 0.99));
    g.addColorStop(0.84, white(a * 0.72));
    g.addColorStop(1, white(0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const cell = (idx, fn) => {
    ctx.save();
    ctx.translate((idx % COLS) * CELL, Math.floor(idx / COLS) * CELL);
    fn();
    ctx.restore();
  };

  // 0 圆点（远景小雪的底子，形状最简单）
  cell(0, () => dot(c, c, 20));

  // 1 不规则雪团：半径带噪声的闭合曲线，外层再罩两圈半透明描边当羽化
  cell(1, () => {
    const pts = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = 10 + rand() * 9;
      pts.push([c + Math.cos(a) * rr, c + Math.sin(a) * rr]);
    }
    const path = () => {
      ctx.beginPath();
      const last = pts[pts.length - 1];
      ctx.moveTo((pts[0][0] + last[0]) / 2, (pts[0][1] + last[1]) / 2);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      ctx.closePath();
    };
    ctx.fillStyle = white(0.97);
    path();
    ctx.fill();
    ctx.strokeStyle = white(0.2);
    ctx.lineWidth = 7;
    path();
    ctx.stroke();
    ctx.strokeStyle = white(0.34);
    ctx.lineWidth = 3;
    path();
    ctx.stroke();
  });

  // 2 小雪簇：三颗大小不一的点粘在一起，像几片雪冻成的团
  cell(2, () => {
    dot(c - 5, c - 6, 9.5, 0.92);
    dot(c + 7, c - 2, 7, 0.85);
    dot(c - 1, c + 8, 8, 0.88);
  });

  // 3 六角星（带分叉）：雪片的经典形状，只有大颗时才读得出细节
  cell(3, () => {
    const arm = 19;
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.2;
      const ex = c + Math.cos(a) * arm;
      const ey = c + Math.sin(a) * arm;
      ctx.strokeStyle = white(0.42);
      ctx.lineWidth = 5.5;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.strokeStyle = white(0.97);
      ctx.lineWidth = 2.9;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      for (const sgn of [-1, 1]) {
        const ba = a + sgn * 0.62;
        const bx = c + Math.cos(a) * arm * 0.6;
        const by = c + Math.sin(a) * arm * 0.6;
        ctx.strokeStyle = white(0.85);
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(ba) * 6.5, by + Math.sin(ba) * 6.5);
        ctx.stroke();
      }
    }
    dot(c, c, 5);
  });

  // 4 斜拉丝：高速下落被"拖"出来的一道，暴雪里最像运动模糊
  cell(4, () => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(-0.52);
    ctx.lineCap = 'round';
    ctx.strokeStyle = white(0.3);
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(9, 0);
    ctx.stroke();
    ctx.strokeStyle = white(0.88);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-15, 0);
    ctx.lineTo(15, 0);
    ctx.stroke();
    ctx.restore();
    dot(c, c, 6, 0.95);
  });

  // 5 五角星：臂长不一，读起来就是"不规则"
  cell(5, () => {
    ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.5;
      const len = 10 + rand() * 9;
      ctx.strokeStyle = white(0.38);
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
      ctx.stroke();
      ctx.strokeStyle = white(0.96);
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
      ctx.stroke();
    }
    dot(c, c, 4.5);
  });

  // 6 双球：两颗靠得很近的小雪，连成一颗长条
  cell(6, () => {
    dot(c - 8, c - 3, 9, 0.9);
    dot(c + 8, c + 4, 7.5, 0.82);
  });

  // 7 碎边毛团：先画一团实心，再用 destination-out 挖出碎边
  cell(7, () => {
    dot(c, c, 17, 0.86);
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) {
      const a = rand() * Math.PI * 2;
      const d = 4 + rand() * 13;
      const r = 1.6 + rand() * 3.4;
      const px = c + Math.cos(a) * d;
      const py = c + Math.sin(a) * d;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(0,0,0,0.6)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  snowFlakeAtlas = { texture, cols: COLS, rows: ROWS, cell: CELL };
  return snowFlakeAtlas;
}

// 兼容旧调用（雨/别的模块曾经直接拿这张贴图）
export function getSnowFlakeTexture() {
  return getSnowFlakeAtlas().texture;
}

// 雪片着色器：逐片尺寸 / 图集格 / 自旋。
// PointsMaterial 一个材质只能一张贴图一个尺寸，做不到"片片不同"，
// 所以自己写一个：size 直接用屏幕像素（不做透视衰减，和旧版一致 ——
// 30m 外的雪也得看得见），图集格用 attribute 传，旋转在 shader 里算。
const SNOW_VERT = `
  attribute float aSize;
  attribute float aCell;
  attribute float aRot;
  attribute float aSpin;
  attribute float aAlpha;
  uniform vec2 uAtlas;
  uniform float uTime;
  uniform float uPixelRatio;
  varying vec2 vCell;
  varying float vRot;
  varying float vAlpha;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // aSize 是 CSS 像素：乘设备像素比，跟旧版 PointsMaterial（size × pixelRatio）一致。
    // 漏了这一步在 2x 屏上雪花只有一半大，看起来就是"雪变稀了"。
    gl_PointSize = aSize * uPixelRatio;
    vCell = vec2(mod(aCell, uAtlas.x), floor(aCell / uAtlas.x));
    vRot = aRot + uTime * aSpin;
    vAlpha = aAlpha;
  }
`;

const SNOW_FRAG = `
  uniform sampler2D uMap;
  uniform vec2 uAtlas;
  varying vec2 vCell;
  varying float vRot;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float s = sin(vRot);
    float c = cos(vRot);
    uv = mat2(c, -s, s, c) * uv;
    // 缩小到 0.76 再落进格子：旋转后的四角也不会越界采到隔壁形状
    uv = uv * 0.76 + 0.5;
    float a = texture2D(uMap, (vCell + uv) / uAtlas).a * vAlpha;
    if (a < 0.012) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, a);
  }
`;

// 雪融雪泥贴图：不规则的一团白，边缘被噪声啃碎、内部留一点稀薄，
// 铺在水面上才像“刚落下的雪在化”，而不是一块白色的多边形薄板
let slushTexture = null;
function getSlushTexture() {
  if (slushTexture) return slushTexture;
  const size = 128;
  const half = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(13579);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  // 用几团偏心圆拼外形（先不融合，边缘再交给噪声处理）
  for (let i = 0; i < 7; i++) {
    const a = rand() * Math.PI * 2;
    const d = 6 + rand() * 22;
    const r = 14 + rand() * 20;
    ctx.beginPath();
    ctx.arc(half + Math.cos(a) * d, half + Math.sin(a) * d, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 逐像素磨边：半径 0.6 以内保留，0.6~1.0 渐隐；再叠低频噪声把轮廓打散
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const d = Math.sqrt(dx * dx + dy * dy);
      const edge = Math.max(0, Math.min(1, (1.0 - d) / 0.42));
      // 噪声只做轻微起伏：正弦量太大会在水面上留下规则斜条，看着像脏抹布
      const n1 = Math.sin(x * 2.3 + y * 1.7) * Math.sin(x * 0.9 - y * 2.1);
      const grain = 0.78 + 0.22 * (n1 * 0.5 + 0.5);
      data[i + 3] = Math.min(255, data[i + 3] * edge * grain);
    }
  }
  ctx.putImageData(img, 0, 0);
  slushTexture = new THREE.CanvasTexture(canvas);
  slushTexture.colorSpace = THREE.SRGBColorSpace;
  return slushTexture;
}

// 天空穹顶（渐变着色器）
function createSkyDome(skyTop, skyBottom) {
  const geo = new THREE.SphereGeometry(1600, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(skyTop) },
      uBottom: { value: new THREE.Color(skyBottom) },
    },
    vertexShader: /* glsl */`
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uTop;
      uniform vec3 uBottom;
      varying vec3 vPos;
      void main() {
        float t = clamp(vPos.y / 1600.0 * 1.6 + 0.25, 0.0, 1.0);
        gl_FragColor = vec4(mix(uBottom, uTop, t), 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

// 光照配比：主光（方向光）略提、补光（半球光）略降，把明暗拉开一档。
// 天气表里的数值保持原样，所有写入点统一乘这两个增益，
// 这样切天气、水下切换都不会各自跑偏。
const SUN_GAIN = 1.14;
const HEMI_GAIN = 0.82;

export class Environment {
  constructor(scene, mapDef, opts = {}) {
    this.scene = scene;
    this.map = mapDef;
    this.quality = opts.quality ?? 'high';
    this.renderer = opts.renderer || null;
    // 水面：只在需要把岸边落影烘进水色时用到（峡谷岩岛）
    this.water = opts.water || null;
    this.group = new THREE.Group();
    // 远景地形单独一组：BOSS 主题场景要整组隐藏，换成自己的背景
    this.terrain = new THREE.Group();
    this.group.add(this.terrain);
    this.colliders = []; // { x, z, r } 圆形碰撞体
    this.rng = mulberry32(mapDef.id === 'canyon' ? 20260826 : 13579246);
    this.weather = null;
    // 怪物模式保留原来的渐变穹顶（主题场景有自己的天空）；
    // 其它模式用 RealSky（物理大气 + 写实云层）。
    this.isBossScene = !!opts.isBoss;
    this.realSky = null;
    // 星空天气：三层星星 + 银河 + 流星 + 星尘 + 水面星点，按需惰性创建
    this.nightSky = null;
    this.rain = null;
    this.snow = null;
    this.landmarks = [];
    this.landmarkTimers = [];
    // 天空/水面跟随天气的天光色（晴朗白天固定为通透白天，不再昼夜循环）
    this.dayTint = null;

    scene.background = new THREE.Color(mapDef.fogColor);
    scene.fog = new THREE.FogExp2(mapDef.fogColor, mapDef.fogDensity);
    // 方向光软阴影：峡谷（岩壁自遮挡）和湖泊（岸边树影落在水面/草坡上）。
    // 参考图里最关键的氛围就是“光被树挡住”的那层投影，湖面没有它就像一块平板；
    // 其余地图（开阔海面/烘焙赛道）不开，避免给所有材质编译阴影分支。
    if (this.renderer) {
      // 烘焙赛道以前没开阴影（怕给几十个材质编译阴影分支）。代价是整张图所有东西
      // 都"浮"在地面上 —— 没有投影就没有体积感，这是画面显平的头号原因。
      this.renderer.shadowMap.enabled = mapDef.id === 'canyon'
        || mapDef.id === 'strait' || mapDef.style === 'lake' || mapDef.style === 'baked'
        || !!mapDef.lava;   // 熔岩夜景没有天光，赛艇全靠柱灯投影才不会"浮"在岩浆上
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    // 水下渲染状态（蓝绿浓雾切换）
    this.uwK = 0;
    this.baseFog = { color: new THREE.Color(mapDef.fogColor), density: mapDef.fogDensity };
    // 水下雾：偏蓝的深海色。原来 0x063642 / 0.02 太暗太浓 —— 20 米外就全糊成
    // 一片墨绿，海床远处的边缘会在地平线上拉出一条突兀的深色横带（像一堵墙）。
    // 现在这档是实拍两轮调出来的：
    //   0x0a3d55 / 0.0125 偏亮偏薄，整屏是"均匀中蓝"，远景收成一条硬地平线；
    //   改成更暗的水色 + 稍浓的密度 —— 远处自然沉入暗，近处仍看得清柱廊。
    //   FogExp2 是 exp(-(d·ρ)²)：50m 透 0.57、80m 透 0.24、120m 透 0.04，
    //   "深海"就是靠这条衰减曲线把地平线吃掉，不是靠把海床刷黑。
    this.UW_FOG = new THREE.Color(0x07202f);
    this.UW_DENSITY = 0.015;

    // 烘焙赛道（Blender 段模型）：云/山/海鸥/浮标全部由段模型自带，
    // 主游戏再生成只会跟赛道交叉（用户反馈"浮桶交叉""天上假云挡住航道"）
    const bakedMap = mapDef.style === 'baked';
    this.#buildSky(mapDef);
    // RealSky 的云直接画在天空着色器里，不再需要白球拼的卡通云团
    if (!this.realSky && !bakedMap) this.#buildClouds(mapDef);
    this.#buildLights(mapDef);
    this.#buildSun();
    if (!bakedMap) this.#buildMountains(mapDef);
    this.#buildShores(mapDef);
    if (mapDef.islands) this.#buildIslands(mapDef);
    if (mapDef.rocks) this.#buildRocks(mapDef);
    if (mapDef.iceZone) this.#buildIceField(mapDef);
    // 地形阻挡：峡谷岩壁 + 冰山群（GLB 资产，InstancedMesh 合批）
    if (mapDef.cliffs) this.#buildCliffs(mapDef);
    // 岩岛/岩壁脚下的接触阴影：烘成一张俯视遮罩交给水面着色器压暗，
    // 不额外加透明贴片（低机位时贴片会被水面深度整片吃掉）
    if (mapDef.id === 'canyon' || mapDef.id === 'lake' || mapDef.id === 'ocean') {
      this.#buildShoreShadowMask();
    }
    if (mapDef.icebergs) this.#buildIcebergs(mapDef);
    if (mapDef.navBeacons) this.#buildNavBeacons(mapDef);
    this.#loadCourseLandmarks(mapDef);
    // 深海龙宫：海底神殿场景（海床/玻璃隧道/宫殿/亚特兰蒂斯/光柱/气泡）
    if (mapDef.style === 'palace') {
      this.#buildPalace(mapDef);
      this.#loadPalaceProps(mapDef); // GLB 精模布景：龙柱大门/珊瑚宫殿/沉船/珊瑚礁
    }
    // 远景氛围（开阔水域才有）：跳跃鲸鱼 + 若即若离的帆船。
    // 熔岩海里出现鲸鱼和白帆会一秒破功，主题地图整组跳过。
    if (mapDef.style !== 'canyon' && !mapDef.lava) {
      this.#buildWhales(mapDef);
      this.#buildShips(mapDef);
    }

    // 电影感氛围层：HDR 环境贴图 / 体积丁达尔光 / 海鸥 / 浮标 / 浮冰 / 水下礁石
    if (bakedMap) {
      // 烘焙赛道不要浮标/海鸥/浮冰；这里给个"任何方法都是空操作"的替身，
      // 否则 setWeather/update 之类一调就 TypeError（踩过：r.setWeather is not a function）
      this.dressing = new Proxy({}, { get: () => () => {} });
    } else {
      this.dressing = new SceneDressing(scene, mapDef, null, opts.renderer);
    }
    // 写实天空自带太阳辉光：屏幕对齐的体积光柱会盖在天空上形成硬边亮块
    if (this.realSky) this.dressing.setShaftsEnabled(false);

    // 熔岩主题：前面那批写实岸带/鲸船都跳过了，这里把远景补成火山群 + 光柱 + 火星。
    // 挂独立文件、只在 mapDef.lava 时创建，其余地图连这个 import 的构造路径都走不到。
    if (mapDef.lava) this.lava = new LavaScenery(this.group, mapDef);

    scene.add(this.group);
  }

  /** 远景地形（远山/防护林/远岛）整组显隐；BOSS 主题场景会换成自己的背景 */
  /**
   * 按关卡给远景山体换色（怪物模式四关各有特色）。
   * 山体几何/顶点色是建好的，这里用材质 color 做一次冷暖乘算：
   * 火山＝压暗压红、珊瑚＝压绿、港口＝压灰、冰海＝压蓝。
   */
  /**
   * 怪物模式换关时刷新天空：RealSky 模式由 setWeather 接管（无操作）；
   * 渐变穹顶模式按新主题的 skyTop/skyBottom 重配穹顶颜色。
   */
  refreshBossSky(weather) {
    if (!this.isBossScene || !this.sky || !this.skyUniforms) return;
    if (this.skyUniforms.topColor) this.skyUniforms.topColor.value.set(weather.skyTop ?? 0x0b1730);
    if (this.skyUniforms.bottomColor) this.skyUniforms.bottomColor.value.set(weather.skyBottom ?? 0x1d3350);
  }

  /**
   * 冬季雪妆：暴雪下场边的树/灌木/草/岸带不该还是夏天的绿。
   * 做法是把基色先压成亮度灰（去饱和），再往冷白掺一半——树还是那几棵树，
   * 只是褪了绿、盖了一层雪；换回其它天气时按存下来的原色复原。
   */
  #applyWinterTint(w) {
    const on = w?.id === 'blizzard';
    // 岸边植被：褪成亮度灰再掺冷白（树还是那几棵树，只是盖了一层雪）
    for (const key of Object.keys(getShoreMats())) {
      const m = getShoreMats()[key];
      if (!m.userData.baseColor) m.userData.baseColor = m.color.clone();
      if (!on) {
        m.color.copy(m.userData.baseColor);
        continue;
      }
      if (key === 'bank') {
        // 岸带本体是顶点色主导（绿草坡），材质色只当亮度乘子用，
        // 真正的“盖雪”在下面直接改顶点色
        m.color.set(0xdce9f1);
        continue;
      }
      // 岸边礁石/湿面直接换成冰蓝（和峡谷岩块同一套冬季色），
      // 树/灌木/草还是走“褪绿 + 掺冷白”，才有雪压枝头的层次
      const rockWinter = SHORE_WINTER[key];
      if (rockWinter) {
        m.color.set(rockWinter);
        continue;
      }
      const base = m.userData.baseColor;
      const lum = 0.2126 * base.r + 0.7152 * base.g + 0.0722 * base.b;
      m.color.setRGB(lum, lum, lum).lerp(WINTER_TONE, 0.5).multiplyScalar(1.08);
    }
    // 峡谷岩块是按“岩面 / 草坡 / 湿面”分材质桶上色的（不是顶点色），
    // 草坡那桶是纯绿——暴雪里它必须是雪盖，否则黑蓝天里立着一堵鲜绿岩壁
    for (const key of Object.keys(getCanyonRockMaterials())) {
      const m = getCanyonRockMaterials()[key];
      if (!m.userData.baseColor) {
        m.userData.baseColor = m.color.clone();
        m.userData.baseRough = m.roughness;
        m.userData.baseEnv = m.envMapIntensity;
      }
      if (!on) {
        m.color.copy(m.userData.baseColor);
        m.roughness = m.userData.baseRough;
        m.envMapIntensity = m.userData.baseEnv;
        continue;
      }
      const winter = CANYON_WINTER[key];
      if (winter) {
        m.color.set(winter.color);
        m.roughness = winter.roughness;
        m.envMapIntensity = winter.env;
      } else {
        m.color.copy(m.userData.baseColor);
      }
    }
    // 岸带顶点色：绿草坡直接换成“靠水湿冷灰 → 坡顶积雪白”的冬季剖面
    const bank = this.group?.getObjectByName('shore-bank');
    const attr = bank?.geometry?.attributes?.color;
    if (attr) {
      if (!bank.userData.baseColors) bank.userData.baseColors = attr.array.slice();
      const base = bank.userData.baseColors;
      const arr = attr.array;
      for (let i = 0; i < arr.length; i += 3) {
        if (on) {
          const lum = 0.2126 * base[i] + 0.7152 * base[i + 1] + 0.0722 * base[i + 2];
          arr[i] = lum * 0.5 + WINTER_TONE.r * 0.85;
          arr[i + 1] = lum * 0.5 + WINTER_TONE.g * 0.9;
          arr[i + 2] = lum * 0.5 + WINTER_TONE.b * 1.0;
        } else {
          arr[i] = base[i];
          arr[i + 1] = base[i + 1];
          arr[i + 2] = base[i + 2];
        }
      }
      attr.needsUpdate = true;
    }
  }

  setMountainTint(hex) {
    const c = new THREE.Color(hex);
    this.mountainTint = { r: c.r, g: c.g, b: c.b };
    this.#syncMountainLight();
  }

  setTerrainVisible(v) {
    if (this.terrain) this.terrain.visible = !!v;
  }

  /**
   * 水下渲染切换（k: 0=水面 1=水下）
   * 蓝绿浓雾 + 隐藏天空/云/太阳；水下抬头可见水面（Water 双面渲染）
   */
  setUnderwater(k) {
    if (Math.abs(k - this.uwK) < 0.002) return;
    this.uwK = k;
    const fog = this.scene.fog;
    fog.color.copy(this.baseFog.color).lerp(this.UW_FOG, k);
    fog.density = THREE.MathUtils.lerp(this.baseFog.density, this.UW_DENSITY, k);
    this.scene.background.copy(fog.color);
    // 水面着色器自带一套雾 uniform（不吃 scene.fog）。不喂它，从水下抬头看
    // 头顶就是地表那套明亮天空雾 —— 整屏"蓝天压着沙滩"，怎么调海水都不像水下。
    this.water?.setUnderwater?.(k, this.UW_FOG, this.UW_DENSITY);
    if (this.hemiLight) {
      this.hemiLight.intensity = (this.weather?.hemiIntensity ?? 0.85) * HEMI_GAIN * (1 - k * 0.55);
    }
    // 雾外元素（天空/云/太阳）水下隐藏
    const hideSky = k > 0.5;
    const showSunSprite = !hideSky && !this.realSky && this.weather?.id !== 'storm';
    if (this.sky) this.sky.visible = !hideSky;
    if (this.sunMesh) this.sunMesh.visible = showSunSprite;
    if (this.sunGlow) this.sunGlow.visible = showSunSprite;
    if (this.clouds) {
      for (const c of this.clouds) c.group.visible = !hideSky;
    }
    if (this.bubbles) this.bubbles.visible = k > 0.4;
    if (this.bubblesSmall) this.bubblesSmall.visible = k > 0.4;
    if (this.ventBubbles) this.ventBubbles.visible = k > 0.4;
    if (this.fishGroup) this.fishGroup.visible = k > 0.35;
    this.dressing?.setUnderwater(k);
    if (this.rain && k > 0.5) this.rain.visible = false;
    // 水下不该有飘雪，也不该有贴在水面的雪泥（否则潜水时头顶一片白点）
    const snowVisible = !hideSky && this.weather?.snow > 0;
    if (this.snow) this.snow.visible = snowVisible;
    if (this.snowMelt) this.snowMelt.visible = snowVisible;
  }

  #buildSky(mapDef) {
    // 怪物模式：按关卡主题的 skyMode 决定用 RealSky 还是渐变穹顶。
    // RealSky 是物理大气（比赛模式那套写实天空），雾/太阳由 setWeather 接管；
    // 渐变穹顶是二次元配色，主题美术想保留时用 'dome'。
    if (this.isBossScene) {
      if (mapDef.bossSkyMode === 'real') {
        this.realSky = new RealSky(mapDef);
        this.sky = this.realSky.mesh;
        this.skyUniforms = null;
        this.group.add(this.sky);
        return;
      }
      this.sky = createSkyDome(mapDef.skyTop, mapDef.skyBottom);
      this.skyUniforms = this.sky.material.uniforms;
      this.group.add(this.sky);
      return;
    }
    this.realSky = new RealSky();
    this.sky = this.realSky.mesh;
    this.skyUniforms = null;
    this.group.add(this.sky);
  }

  /**
   * Deterministic roadside dressing shared by every map. Props are placed at
   * different progress fractions and offset from the racing corridor, so the
   * course remains readable while still getting recognizable landmarks.
   */
  #loadCourseLandmarks(mapDef) {
    const gates = mapDef.gates || [];
    if (gates.length < 4) return;
    const groundY = mapDef.style === 'palace' ? -12.2 : -0.85;
    const entries = [
      { file: 'old_lighthouse.glb', fraction: 0.16, side: -1, width: 12, turn: 0 },
      { file: 'lighthouse.glb', fraction: 0.31, side: 1, width: 12, turn: 0 },
      { file: 'road_sign.glb', fraction: 0.45, side: -1, width: 6.5, turn: Math.PI * 0.5 },
      { file: 'british_road_sign.glb', fraction: 0.59, side: 1, width: 6.5, turn: -Math.PI * 0.5 },
      { file: 'low_poly_billboard_sign_-_standard.glb', fraction: 0.73, side: -1, width: 8, turn: Math.PI * 0.5 },
      { file: 'low_poly_street_light_pole.glb', fraction: 0.87, side: 1, width: 4.5, turn: 0 },
    ];
    const trackOffset = (mapDef.gateWidth || 16) + (mapDef.style === 'palace' ? 7 : 11);
    // 大型装饰（灯塔/大牌）自动避让近道走廊：压线时顺延到下一个 gate 再试
    const shortcutPolylines = (mapDef.shortcuts || []).map((s) => s.points || []);
    const distToSeg = (x, z, ax, az, bx, bz) => {
      const sx = bx - ax, sz = bz - az;
      const len2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
      return Math.hypot(x - (ax + sx * t), z - (az + sz * t));
    };
    const clearOfShortcuts = (x, z, margin) => {
      for (const pts of shortcutPolylines) {
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSeg(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) < margin) return false;
        }
      }
      return true;
    };
    // 2026-11-18：旧版只避让"近道"，没检查主赛道本身 —— 霓虹海峡的旧灯塔
    // 摆在 10 号门内侧，离主中线只有 5.4m（航道半径 7.4m），直接站在赛道里，
    // 玩家能开进去穿模。这里按**整条主中线**再筛一遍，Z 弯里侧一定要让开。
    const corridorLimit = (Number(mapDef.edgeOffset) || Number(mapDef.gateWidth) * 0.5 || 8) + 2;
    const clearOfMainTrack = (x, z, margin) => {
      const segN = mapDef.baked && !mapDef.baked.closed ? gates.length - 1 : gates.length;
      for (let i = 0; i < segN; i++) {
        const a = gates[i], b = gates[(i + 1) % gates.length];
        if (distToSeg(x, z, a[0], a[1], b[0], b[1]) < margin) return false;
      }
      return true;
    };
    for (const entry of entries) {
      let i = Math.max(1, Math.min(gates.length - 2, Math.round(entry.fraction * gates.length)));
      if (entry.width >= 8) { // 灯塔/广告牌等大件必须让开近道 + 主道
        const margin = entry.width + 10;
        // 灯塔半径约 entry.width/2，中心离主中线至少要 航道半径 + 半宽 + 2m，
        // 否则像海峡 10 号门那样被 Z 弯的"另一侧"套进来。
        const mainMargin = corridorLimit + entry.width * 0.5 + 2;
        for (let tries = 0; tries < gates.length; tries++) {
          const probe = ((i - 1 + tries) % (gates.length - 2)) + 1;
          const pp = gates[probe];
          const tx0 = gates[probe + 1][0] - gates[probe - 1][0];
          const tz0 = gates[probe + 1][1] - gates[probe - 1][1];
          const l0 = Math.hypot(tx0, tz0) || 1;
          const px = pp[0] + (-tz0 / l0) * entry.side * trackOffset;
          const pz = pp[1] + (tx0 / l0) * entry.side * trackOffset;
          if (clearOfShortcuts(px, pz, margin) && clearOfMainTrack(px, pz, mainMargin)) {
            i = probe; break;
          }
          if (tries === gates.length - 1) break; // 全图都压线（不可能）：保持原位兜底
        }
      }
      const p = gates[i];
      const prev = gates[i - 1];
      const next = gates[i + 1];
      const tx = next[0] - prev[0];
      const tz = next[1] - prev[1];
      const len = Math.hypot(tx, tz) || 1;
      const ux = tx / len;
      const uz = tz / len;
      const sideX = -uz * entry.side;
      const sideZ = ux * entry.side;
      // 圆形竞技场（BOSS 关）：地标统一丢到 landmarkRing 的外圈上，
      // 否则灯塔/广告牌会有一半落在战场中景抢 BOSS 的视线。
      const ring = mapDef.landmarkRing;
      const ang = entry.fraction * Math.PI * 2;
      const x = ring ? Math.cos(ang) * ring : p[0] + sideX * trackOffset;
      const z = ring ? Math.sin(ang) * ring : p[1] + sideZ * trackOffset;
      const heading = ring
        ? Math.atan2(-Math.cos(ang), -Math.sin(ang)) + entry.turn
        : Math.atan2(ux, uz) + entry.turn;
      const url = `/models/${entry.file}`;
      // Large lighthouse assets are decoded progressively after the race has
      // started. This avoids a simultaneous multi-GLB parse hitch.
      const timer = setTimeout(() => loadPropModel(url).then((gltf) => {
        const scene = gltf.scene.clone(true);
        const isLighthouse = entry.file.includes('lighthouse');
        scene.traverse((obj) => {
          if (obj.isMesh) {
            // Landmarks are dressing, never gameplay colliders. Disable the
            // expensive shadow passes and freeze static transforms.
            obj.castShadow = false;
            obj.receiveShadow = false;
            obj.frustumCulled = true;
            // Lighthouse GLBs contain many tiny bolts, glass trims and light
            // fittings. They add draw calls without affecting the silhouette;
            // omit only sub-decimeter details on this static landmark.
            if (isLighthouse) {
              obj.geometry?.computeBoundingSphere?.();
              if (obj.geometry?.boundingSphere && obj.geometry.boundingSphere.radius < 0.12) {
                obj.visible = false;
                return;
              }
            }
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (const mat of mats) {
              if (!mat) continue;
              if (mat.opacity >= 0.999 && !mat.alphaMap) {
                mat.transparent = false;
                mat.depthWrite = true;
              }
              if (mat.map) mat.map.anisotropy = 1;
            }
          }
        });
        // 灯塔动辄 160 个子网格，按材质合批后才不会拖垮 draw call
        mergeStaticByMaterial(scene);
        // 灯塔虽然摆到了航道外，但仍要给一个碰撞体：玩家开到岸上/近道时
        // 不该能穿过塔基。半径取视觉宽度的 0.42（塔基比塔顶细），
        // 且上面的避让规则保证「塔心 - 半径 > 航道半径 + 1m」，不会挤窄赛道。
        const holder = this.#addProp({ scene }, {
          x, z, groundY, width: entry.width, ry: heading,
          colliderRadius: isLighthouse ? entry.width * 0.42 : 0,
        });
        if (holder) {
          holder.visible = false;
          holder.updateMatrixWorld(true);
          holder.traverse((obj) => { if (obj.isMesh) obj.matrixAutoUpdate = false; });
          holder.userData.isLighthouse = isLighthouse;
          this.landmarks.push(holder);
        }
      }).catch((err) => console.warn(`course prop load failed: ${url}`, err)), entries.indexOf(entry) * 700);
      this.landmarkTimers.push(timer);
    }
  }

  /**
   * 应用昼夜/天气预设：更新天空、雾、光照、云、雨
   * @param {object} w WEATHERS 中的预设
   */
  setWeather(w) {
    this.weather = w;
    const map = this.map;
    const skyTop = w.skyTop ?? map.skyTop;
    const skyBottom = w.skyBottom ?? map.skyBottom;
    const fogColor = w.fogColor ?? map.fogColor;
    const fogDensity = w.fogDensity ?? map.fogDensity;

    if (this.realSky) {
      this.realSky.setWeather(w);
    } else {
      this.skyUniforms.uTop.value.set(skyTop);
      this.skyUniforms.uBottom.value.set(skyBottom);
    }
    this.scene.background.set(fogColor);
    // 暴雨：场景雾色跟着天空一起压暗。水面用的是自己的 uFogColor（保持用户认可的观感），
    // 不受这里影响；否则远景小岛/帆船会被亮雾衬成一团团白影挂在黑天幕上。
    // 主题地图可以给 w.fogDarken 自定义压暗比例（熔岩雷暴压 0.34 会把火山群彻底抹掉）
    this.scene.fog.color.set(fogColor);
    if (w.fogDarken) this.scene.fog.color.multiplyScalar(w.fogDarken);
    else if (w.id === 'storm') this.scene.fog.color.multiplyScalar(0.34);
    this.scene.fog.density = fogDensity;
    // 冰原/灯船跟着天气走：雪天多一圈外围碎冰，雾越厚灯船越亮
    if (this.iceBlizzardExtra) this.iceBlizzardExtra.visible = !!w.snow;
    this.#syncBeaconLight();
    // 记录水面基准雾（供水下切换插值），并重置水下状态。
    // 注意必须用上面压暗后的颜色：setUnderwater(0) 会把 fog.color 从 baseFog 恢复回来
    this.baseFog.color.copy(this.scene.fog.color);
    this.baseFog.density = fogDensity;
    this.uwK = -1;

    this.sunLight.color.set(w.sunColor ?? map.sunColor);
    this.sunLight.intensity = (w.sunIntensity ?? 1.6) * SUN_GAIN;
    this.sunLight.position.set(...(w.sunPos || [180, 260, 120]));

    this.hemiLight.intensity = (w.hemiIntensity ?? 0.85) * HEMI_GAIN;
    // 天光冷暖由天气指定：暴雪是“冷白天光 + 冷蓝地面反射”，
    // 这样受光面泛冷白、背光面偏冷蓝，不会退回到原来的灰黄调。
    this.hemiLight.color.set(w.hemiSky ?? map.skyTop);
    this.hemiLight.groundColor.set(w.hemiGround ?? 0x3a4a52);
    this.cloudMat?.color.set(w.cloudColor ?? 0xffffff);
    // 岸边植被/岸带冬季上妆：暴雪时褪绿、盖一层冷白，其它天气恢复原色
    this.#applyWinterTint(w);

    // 太阳/夕阳圆盘：白天高挂亮白，黄昏低垂橙红，暴风雨隐没
    if (this.sunMesh) {
      const sp = w.sunPos || [180, 260, 120];
      const dir = new THREE.Vector3(...sp).normalize();
      this.sunMesh.position.copy(dir).multiplyScalar(1280);
      this.sunGlow.position.copy(this.sunMesh.position);
      const isDusk = w.id === 'dusk';
      const showSun = w.id !== 'storm' && w.id !== 'blizzard';
      // 写实天空自己画太阳盘 + 柔和光晕，这里不再叠加贴图光晕（加法贴图会露出方片边）
      this.sunMesh.visible = showSun && !this.realSky;
      this.sunGlow.visible = showSun && !this.realSky;
      this.sunMesh.material.color.set(isDusk ? 0xff8a3c : 0xfff5d6);
      this.sunMesh.scale.setScalar(isDusk ? 1.7 : 1);
      this.sunGlow.material.color.set(isDusk ? 0xff9a50 : 0xfff2cc);
      this.sunGlow.material.opacity = isDusk ? 0.75 : 0.55;
      this.sunGlow.scale.setScalar(isDusk ? 760 : 460);
    }

    // 雨（暴风雨）
    if (w.rain > 0) {
      this.#buildRain();
    } else if (this.rain) {
      this.rain.visible = false;
    }
    // 星空：星星/银河/流星/星尘按需创建，其它天气直接隐藏（不重复建）
    if (w.stars) {
      if (!this.nightSky) {
        this.nightSky = new NightSky(this.scene, { quality: this.quality, renderer: this.renderer });
      }
      this.nightSky.setVisible(true);
    } else if (this.nightSky) {
      this.nightSky.setVisible(false);
    }
    if (w.snow > 0) {
      this.#buildSnow();
      if (this.snowMelt) this.snowMelt.visible = true;
    } else {
      if (this.snow) this.snow.visible = false;
      if (this.snowMelt) this.snowMelt.visible = false;
    }
    // 氛围层跟随天气：重烘 HDR 环境贴图、调整光柱色温
    this.dressing?.setWeather(w);
    // 写实天空下水面的反射色取自天空本身，保证海天一色。
    // 火山图各天气自带完整调色板（noDayCycle）：它的水色是美术专门配的，
    // 再叠一层动态日 tint 反而发灰发白（实测海面被冲成 #BCC8CF）。
    this.dayTint = (!w.noDayCycle && this.realSky) ? this.realSky.waterTint() : null;
    // 切换天气后立刻同步山体亮度（暴雨要压暗、切回晴天要恢复）
    this.#syncMountainLight();
  }

  // 远山只跟天光明暗走，色相固定不随天气变化
  #syncMountainLight() {
    if (!this.mountains) return;
    const k = 0.46 + 0.54 * (this.dayTint?.light ?? 1);
    // 暴雨：天空被压到近黑，山体必须一起沉下去——否则烘焙好的浅灰山脊
    // 会比天空还亮，在天际线上拉出一条刺眼的亮带。只对暴雨生效，其他天气不动
    // 星空：夜里山体必须是暗蓝色剪影。0.34 在 0.62 的灰底上仍会被看成
    // “打了个月光的白天山”，所以压到 0.12 并往冷蓝偏，把白天烘进去的
    // 暖绿/土黄统一收掉
    const dim = this.weather?.id === 'storm' ? 0.18
      : this.weather?.id === 'starry' ? 0.12 : 1;
    const blizzard = this.weather?.id === 'blizzard';
    // 山体色＝光照强度 × 关卡色调（怪物模式四关各自一套）
    const starry = this.weather?.id === 'starry';
    const tint = starry ? { r: 0.55, g: 0.7, b: 1.15 } : (this.mountainTint || WHITE_TINT);
    for (const m of this.mountains.children) {
      m.material.color.setRGB(k * (blizzard ? 1 : dim) * tint.r, k * (blizzard ? 1 : dim) * tint.g, k * (blizzard ? 1 : dim) * tint.b);
      if (blizzard) {
        // 暴雪里山体要“保住白色”：材质 color 只能乘，压不掉烘焙进顶点色里的
        // 深绿植被和深灰岩层。这里按“顶点高度 + 坡面朝上程度”重烘焙——
        // 坡面朝上就盖雪、越高越白，只有陡壁/沟壑留一点冷灰蓝岩面当阴影，
        // 再用原亮度做明暗（否则整座山摊成一块没有起伏的白板）。
        if (!m.userData.winterBaked) {
          this.#bakeMountainSnow(m);
          // 细节贴图里的绿色植被斑也要换掉：顶点色再白，乘以带绿斑的贴图
          // 仍旧是一片“灰绿岩石裸露”的雪山
          if (m.userData.baseMap === undefined) m.userData.baseMap = m.material.map;
          m.material.map = getSnowRockTexture();
          m.material.needsUpdate = true;
          m.userData.winterBaked = true;
        }
        continue;
      }
      // 非暴雪：顶点色恢复烘焙原色，只改材质乘子
      if (m.userData.winterBaked) {
        m.geometry.attributes.color.array.set(m.userData.baseColors);
        m.geometry.attributes.color.needsUpdate = true;
        m.userData.winterBaked = false;
      }
      if (m.userData.baseMap !== undefined && m.material.map !== m.userData.baseMap) {
        m.material.map = m.userData.baseMap;
        m.material.needsUpdate = true;
      }
    }
  }

  /**
   * 暴雪雪山：顶部与坡面覆一层雪，只留少量冷灰蓝岩面。
   * 重烘焙是一次性的（只在切到暴雪时跑一遍），不进每帧循环。
   */
  #bakeMountainSnow(m) {
    const attr = m.geometry?.attributes?.color;
    const posA = m.geometry?.attributes?.position;
    const nrmA = m.geometry?.attributes?.normal;
    if (!attr || !posA) return;
    if (!m.userData.baseColors) m.userData.baseColors = attr.array.slice();
    if (!m.userData.yRange) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < posA.count; i++) {
        const y = posA.getY(i);
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
      m.userData.yRange = [lo, hi];
    }
    const base = m.userData.baseColors;
    const [lo, hi] = m.userData.yRange;
    const span = Math.max(1e-3, hi - lo);
    const arr = attr.array;
    for (let i = 0, vi = 0; i < arr.length; i += 3, vi++) {
      const lum = 0.2126 * base[i] + 0.7152 * base[i + 1] + 0.0722 * base[i + 2];
      const f = (posA.getY(vi) - lo) / span;             // 0 山脚 → 1 山脊
      const ny = nrmA ? nrmA.getY(vi) : 0.6;             // 坡面朝上程度
      const up = Math.max(0, Math.min(1, (ny + 0.15) / 0.95));
      // 雪量：朝上的坡面几乎全盖，越高越白；陡壁/背阴面留 30% 左右的岩面
      const snow = Math.min(1, (0.5 + 0.5 * up) * (0.72 + 0.38 * f));
      // 岩面：原亮度的冷灰蓝；雪面：冷白，靠原亮度带出细小明暗
      const rock = 0.44 + 0.40 * lum;
      const snowLum = 0.86 + 0.14 * lum;
      arr[i] = rock * 0.82 * (1 - snow) + snowLum * 0.97 * snow;
      arr[i + 1] = rock * 0.88 * (1 - snow) + snowLum * 0.985 * snow;
      arr[i + 2] = rock * 0.96 * (1 - snow) + snowLum * 1.0 * snow;
    }
    attr.needsUpdate = true;
  }

  // 雨：真正的短线段（雨丝）。用 Points 画圆点会被看成满天星，
  // 尤其在暴雨的近黑天空下极其出戏，所以这里用 LineSegments 画有长度的雨丝
  #buildRain() {
    if (this.rain) {
      this.rain.visible = true;
      return;
    }
    const COUNT = 900;
    const LEN = 1.9; // 雨丝长度（米）
    const positions = new Float32Array(COUNT * 2 * 3);
    for (let i = 0; i < COUNT; i++) {
      const x = (Math.random() - 0.5) * 160;
      const y = Math.random() * 60;
      const z = (Math.random() - 0.5) * 160;
      const o = i * 6;
      positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
      positions[o + 3] = x; positions[o + 4] = y - LEN; positions[o + 5] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xa9c6da, transparent: true, opacity: 0.45, fog: false,
    });
    this.rain = new THREE.LineSegments(geo, mat);
    this.rain.frustumCulled = false;
    this.rainLen = LEN;
    this.scene.add(this.rain);
  }

  #updateRain(dt, camera) {
    if (!this.rain || !this.rain.visible) return;
    const pos = this.rain.geometry.attributes.position;
    const arr = pos.array;
    const cy = camera ? camera.position.y : 20;
    const len = this.rainLen ?? 1.9;
    const fall = dt * 38;
    for (let i = 0; i < arr.length; i += 6) {
      arr[i + 1] -= fall;
      arr[i + 4] -= fall;
      if (arr[i + 4] < cy - 25) {
        const x = (Math.random() - 0.5) * 160;
        const y = cy + 35 + Math.random() * 20;
        const z = (Math.random() - 0.5) * 160;
        arr[i] = x; arr[i + 1] = y; arr[i + 2] = z;
        arr[i + 3] = x; arr[i + 4] = y - len; arr[i + 5] = z;
      }
    }
    pos.needsUpdate = true;
    // 雨区跟随相机
    if (camera) {
      this.rain.position.set(
        Math.round(camera.position.x / 40) * 40,
        0,
        Math.round(camera.position.z / 40) * 40,
      );
    }
  }

  #buildSnow() {
    if (this.snow) {
      this.snow.visible = true;
      if (this.snowMelt) this.snowMelt.visible = true;
      return;
    }
    // 三层雪粒：近景清雪片 + 中景 + 远景雪幕。暴雪的“贯穿视野”靠的是
    // 三层同时存在——近层小、动得快，看得出是雪片；远景尺寸放大到不物理的
    // 程度，才能在 300 米外还留一层白噪点，形成整片白茫茫的空气感。
    // 2026-11-17 二次加密：用户要"一直下不停、密度再厚一点"。
    // 三层合计 2140 → 3600 粒；关键是每层高度范围也加高（top 18/28/42 → 26/38/56），
    // 雪片从顶落到底的时间变长，任何时刻空中都有足够多的雪，不会一阵一阵。
    // 近层保留 keepClear 安全圈（镜头 5~10m 内不放雪），远景层 opacity 略降，
    // 雪幕够厚但赛道仍读得出来。
    // size 单位是屏幕像素（不做透视衰减）—— 按距离衰减时 30m 外的雪片不到 2px，
    // 肉眼看不见，看起来就是"一阵一阵零星几片"。
    //
    // 2026-11-18 用户第二轮：「有大有小、不要形状都一样、不要全朝一个方向」。
    // 三处结构性改动，全在这里：
    //   ① 尺寸不再是层常量，改成逐片随机（`size` 是上限、`sizeMin` 是下限），
    //      并且用 pow(rng, 1.8) 压成"小雪粒多、大片少"的分布 —— 参考图里
    //      大大小小混在一起，但没有哪一片大得抢戏；
    //   ② 形状走 8 格图集（getSnowFlakeAtlas），逐片随机取格 + 自旋；
    //   ③ 飘向逐片随机（见 #updateSnow 的 ux/uz），不再有"全队同一个风向"。
    const SPECS = [
      // 近层：看得清雪花，尺寸跨度最大，大颗给到 13px（再大就是糊脸白团了）
      { count: 4800, size: 15.0, sizeMin: 6.5, opacity: 0.98, range: 34,  top: 26, fall: 3.8, wind: 8.0,  keepClear: true, spin: 1.1, cells: 8 },
      // 中层：主力密度，形状细节还看得出来
      { count: 6800, size: 10.5, sizeMin: 4.5, opacity: 0.9,  range: 100, top: 38, fall: 5.6, wind: 10.5, spin: 0.6, cells: 8 },
      // 远景：只做白噪点雪幕，格子收在前 4 个（星形/丝状在这个尺寸看不出来，
      // 反而会闪），不透明度压低避免整屏糊白
      { count: 4400, size: 7.5,  sizeMin: 3.0, opacity: 0.62, range: 265, top: 56, fall: 7.0, wind: 12.5, spin: 0.22, cells: 4 },
    ];
    const atlas = getSnowFlakeAtlas();
    this.snow = new THREE.Group();
    this.snow.name = 'snow-fall';
    this.snowLayers = [];
    for (const s of SPECS) {
      const n = s.count;
      const positions = new Float32Array(n * 3);
      const aSize = new Float32Array(n);
      const aCell = new Float32Array(n);
      const aRot = new Float32Array(n);
      const aSpin = new Float32Array(n);
      const aAlpha = new Float32Array(n);
      // 逐片运动状态：方向单位向量 / 水平速度倍率 / 下落速度 / 湍流缓存
      const ux = new Float32Array(n);
      const uz = new Float32Array(n);
      const spd = new Float32Array(n);
      const fall = new Float32Array(n);
      const turbX = new Float32Array(n);
      const turbZ = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        positions[i * 3] = (this.rng() - 0.5) * s.range;
        // 初始高度要覆盖相机上下（以前只铺在 0..top，相机常年在 y≈3~8，
        // 下方一段是空的，开局会先"没雪"几秒）
        positions[i * 3 + 1] = this.rng() * (s.top + 12) - 12;
        positions[i * 3 + 2] = (this.rng() - 0.5) * s.range;
        // ① 大小：下限起步，越往上越稀有（pow 1.8 把分布压在小的那头）
        aSize[i] = s.sizeMin + (s.size - s.sizeMin) * Math.pow(this.rng(), 1.8);
        // ② 形状 + 朝向：随机格子、随机初始角、慢速自旋
        aCell[i] = Math.floor(this.rng() * s.cells);
        aRot[i] = this.rng() * Math.PI * 2;
        aSpin[i] = (this.rng() - 0.5) * s.spin;
        // 亮度也要有差：全一样亮会像"贴纸"，太暗又会被亮天空吃掉
        aAlpha[i] = s.opacity * (0.82 + 0.18 * this.rng());
        // ③ 飘向：0~2π 全向随机。旧版整层共用一个风向，画面上就是一排斜线，
        // 也是用户说的"太公式化"。
        const dir = this.rng() * Math.PI * 2;
        ux[i] = Math.cos(dir);
        uz[i] = Math.sin(dir);
        spd[i] = 0.3 + this.rng() * 0.8;
        fall[i] = s.fall * (0.6 + this.rng() * 0.85);
        // 少量雪片被上升气流托着走：暴风雪里本来就有往上翻的雪，
        // 全都在往下掉才像"粒子在播动画"
        if (this.rng() < 0.08) fall[i] = -(0.4 + this.rng() * 1.0);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
      geo.setAttribute('aCell', new THREE.BufferAttribute(aCell, 1));
      geo.setAttribute('aRot', new THREE.BufferAttribute(aRot, 1));
      geo.setAttribute('aSpin', new THREE.BufferAttribute(aSpin, 1));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: atlas.texture },
          uAtlas: { value: new THREE.Vector2(atlas.cols, atlas.rows) },
          uTime: { value: 0 },
          uPixelRatio: { value: 1 },
        },
        vertexShader: SNOW_VERT,
        fragmentShader: SNOW_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const points = new THREE.Points(geo, mat);
      points.frustumCulled = false;
      this.snow.add(points);
      this.snowLayers.push({
        ...s, points, half: s.range / 2,
        ux, uz, spd, fall, turbX, turbZ, tick: 0,
      });
    }
    // 首帧拿到相机后按相机高度重新铺一次，保证开局第一秒就满屏下雪
    this.snowFresh = true;
    this.scene.add(this.snow);
    this.#buildSnowMelt();
  }

  #updateSnow(dt, camera) {
    if (!this.snow || !this.snow.visible) return;
    const cy = camera ? camera.position.y : 8;
    // 雪区组固定在世界原点，雪片坐标就是世界坐标 —— 绝不能把整组随相机跳格：
    // 以前每跨 20m 就把全组雪瞬移一次，画面上就是"雪一阵有一阵没"。
    // 改成只有超出相机周围 range 的单颗雪片才绕回另一侧，数量恒定、下雪不断。
    const cx = camera ? camera.position.x : 0;
    const cz = camera ? camera.position.z : 0;
    const t = this.time || 0;
    // 阵风只改"雪被吹得多快"，不改方向：方向是每片雪自己的（见 ux/uz），
    // 所以整体是"风在变强变弱"，而不是"所有雪一起掉头"
    const gust = 0.78 + 0.26 * Math.sin(t * 0.53) + 0.14 * Math.sin(t * 1.71);
    // 画布像素比会随窗口/画质变（PostFx 会改），每帧同步一次
    const pixelRatio = this.renderer?.getPixelRatio?.()
      || (typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    for (const layer of this.snowLayers || []) {
      const attr = layer.points.geometry.attributes.position;
      const arr = attr.array;
      const { ux, uz, spd, fall, turbX, turbZ } = layer;
      const n = layer.count;
      const wind = layer.wind * gust;
      // 湍流场每 3 帧重算一次：位置一帧才挪几十厘米，每帧算 8000×2 次三角函数
      // 纯属浪费；3 帧的差值肉眼完全看不出来。
      const refresh = (layer.tick++ % 3) === 0;
      // 首帧按相机高度重铺，避免开局前几秒下方没雪
      if (this.snowFresh && camera) {
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] = cx + (this.rng() - 0.5) * layer.range;
          arr[i + 1] = cy - 12 + this.rng() * (layer.top + 12);
          arr[i + 2] = cz + (this.rng() - 0.5) * layer.range;
        }
        for (let i = 0; i < n; i++) { turbX[i] = 0; turbZ[i] = 0; }
      }
      for (let i = 0, i3 = 0; i < n; i++, i3 += 3) {
        if (refresh) {
          // 空间涡流：相邻雪片跟着同一股气流走（位置相近 → 速度相近），
          // 才会"四面八方乱飘"而不是每片各自抖成噪点。
          const zz = arr[i3 + 2];
          const xx = arr[i3];
          turbX[i] = Math.sin(zz * 0.17 + t * 0.9) * 0.95 + Math.sin(zz * 0.045 - t * 0.37) * 0.6;
          turbZ[i] = Math.cos(xx * 0.15 + t * 0.82) * 0.95 + Math.cos(xx * 0.06 - t * 0.31) * 0.6;
        }
        arr[i3] += (ux[i] * spd[i] * wind + turbX[i]) * dt;
        arr[i3 + 1] -= fall[i] * dt;
        arr[i3 + 2] += (uz[i] * spd[i] * wind + turbZ[i]) * dt;
        if (arr[i3 + 1] < cy - 12) {
          // 落到底就从相机上方重新落下，落点也围着相机而不是世界原点
          arr[i3 + 1] = cy + layer.top;
          arr[i3] = cx + (this.rng() - 0.5) * layer.range;
          arr[i3 + 2] = cz + (this.rng() - 0.5) * layer.range;
        }
        // 雪区以相机为圆心：吹出边界后从另一侧绕回来，永远铺满视野
        if (arr[i3] > cx + layer.half) arr[i3] -= layer.range;
        else if (arr[i3] < cx - layer.half) arr[i3] += layer.range;
        if (arr[i3 + 2] > cz + layer.half) arr[i3 + 2] -= layer.range;
        else if (arr[i3 + 2] < cz - layer.half) arr[i3 + 2] += layer.range;
        // 离镜头太近的雪片会变成一大团白斑（点大小按透视放大），
        // 近景层专门把它们挪到 5~10 米外，画面里就没有“糊脸”的白块了
        if (layer.keepClear && camera) {
          const ddx = arr[i3] - cx;
          const ddz = arr[i3 + 2] - cz;
          if (ddx * ddx + ddz * ddz < 5.0) {
            const a2 = this.rng() * Math.PI * 2;
            const d2 = 5 + this.rng() * 5;
            arr[i3] = cx + Math.cos(a2) * d2;
            arr[i3 + 2] = cz + Math.sin(a2) * d2;
          }
        }
      }
      attr.needsUpdate = true;
      // 自旋是 shader 里按 uTime 算的（不逐帧写 attribute）
      const u = layer.points.material.uniforms;
      u.uTime.value = t;
      u.uPixelRatio.value = pixelRatio;
    }
    this.snowFresh = false;
    this.#updateSnowMelt(dt, camera);
  }

  /**
   * 雪融在水面：贴水的一层白色雪泥/碎冰片，围着相机漂移、生灭、缩放。
   * 固定高度略高于水面（0.3m），浪头盖上去时会自然被淹没一段，
   * 露出水面的部分就像刚落下的雪正在化开。不参与碰撞、不改水色。
   */
  #buildSnowMelt() {
    if (this.snowMelt) {
      this.snowMelt.visible = true;
      return;
    }
    const COUNT = 520;
    // 平铺的方形面片 + 磨边雪泥贴图：原来的九边形 CircleGeometry 尺寸又大、
    // 边缘又是硬折线，在开阔水面上读成“白色冰板”。贴图自带渐隐和碎边，
    // 小一圈铺在水面才像刚落下的雪正在化开。
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: getSlushTexture(), color: 0xffffff,
      transparent: true, opacity: 0.72, depthWrite: false,
    });
    const inst = new THREE.InstancedMesh(geo, mat, COUNT);
    inst.name = 'snow-melt';
    inst.frustumCulled = false;
    inst.renderOrder = 2;
    this.meltRand = mulberry32(24680);
    this.meltState = [];
    for (let i = 0; i < COUNT; i++) {
      // age = life → 第一帧全部重生到相机周围
      this.meltState.push({ x: 0, z: 0, rx: 2, rz: 1.5, rot: 0, age: 1, life: 1 });
    }
    this.group.add(inst);
    this.snowMelt = inst;
    this.#updateSnowMelt(0, null);
  }

  #updateSnowMelt(dt, camera) {
    const inst = this.snowMelt;
    if (!inst || !inst.visible) return;
    const cx = camera ? camera.position.x : 0;
    const cz = camera ? camera.position.z : 0;
    const dummy = this._meltDummy || (this._meltDummy = new THREE.Object3D());
    const rand = this.meltRand;
    const st = this.meltState;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      s.age += dt;
      const k = s.age / s.life;
      if (k >= 1 || Math.hypot(s.x - cx, s.z - cz) > 130) {
        // 在相机周围 4~92m 的环带里重生，避免全堆在脚下
        const a = rand() * Math.PI * 2;
        const dist = 4 + rand() * 88;
        s.x = cx + Math.cos(a) * dist;
        s.z = cz + Math.sin(a) * dist;
        s.rx = 0.5 + rand() * 1.2;
        s.rz = 0.4 + rand() * 0.9;
        s.rot = rand() * Math.PI * 2;
        s.age = 0;
        s.life = 7 + rand() * 9;
      }
      // 化开的节奏：前 12% 长出来，62% 之后慢慢缩没
      let grow = 1;
      if (k < 0.12) grow = k / 0.12;
      else if (k > 0.62) grow = Math.max(0, 1 - (k - 0.62) / 0.38);
      // 贴着水面缓流漂一点
      s.x += Math.cos(0.42) * 0.25 * dt;
      s.z += Math.sin(0.42) * 0.25 * dt;
      // 抬到 0.6：雪泥要压住浪尖才不被浪切开（贴 0.3 会被波峰切出直边）
      const y = 0.6;
      dummy.position.set(s.x, y, s.z);
      dummy.rotation.set(0, s.rot, 0);
      dummy.scale.set(s.rx * grow, 1, s.rz * grow);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
  }

  // 太阳圆盘 + 光晕（贴在天穹内侧，不受雾影响）
  #buildSun() {
    this.sunMesh = new THREE.Mesh(
      new THREE.SphereGeometry(46, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff5d6, fog: false }),
    );
    this.group.add(this.sunMesh);

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,244,214,0.9)');
    grad.addColorStop(0.35, 'rgba(255,220,160,0.35)');
    grad.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true, opacity: 0.8, depthWrite: false, fog: false,
      blending: THREE.AdditiveBlending,
    }));
    this.sunGlow.scale.setScalar(340);
    this.group.add(this.sunGlow);
  }

  // 远景跳跃鲸鱼：赛道外围随机位置周期性跃出水面
  #buildWhales(mapDef) {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3a5f78, roughness: 0.85, flatShading: true,
    });
    this.whales = [];
    const count = 5;
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      g.rotation.order = 'YXZ';
      const body = new THREE.Mesh(new THREE.SphereGeometry(3, 12, 9), bodyMat);
      body.scale.set(1, 0.85, 2.9);
      const fluke = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.5, 2.2), bodyMat);
      fluke.position.set(0, 0.3, -9.6);
      const dorsal = new THREE.Mesh(new THREE.ConeGeometry(1.1, 2.2, 6), bodyMat);
      dorsal.position.set(0, 2.7, -1.5);
      g.add(body, fluke, dorsal);
      for (const side of [-1, 1]) {
        const pect = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.4, 1.4), bodyMat);
        pect.position.set(side * 2.6, -1.0, 2.2);
        pect.rotation.z = side * 0.5;
        g.add(pect);
      }
      g.visible = false;
      this.group.add(g);
      this.whales.push({
        group: g,
        dist: mapDef.boundary.r + 70 + this.rng() * 130,
        angle: this.rng() * Math.PI * 2,
        drift: (this.rng() - 0.5) * 0.02,
        period: 8 + this.rng() * 8,
        phase: this.rng() * 20,
        t: 0,
      });
    }
  }

  #updateWhales(dt) {
    for (const w of this.whales) {
      w.angle += w.drift * dt;
      w.t += dt;
      const cyc = (w.t + w.phase) % w.period;
      const rest = w.period * 0.78; // 大部分时间潜水
      const g = w.group;
      if (cyc < rest) {
        g.visible = false;
        continue;
      }
      const tau = (cyc - rest) / (w.period - rest); // 0..1 跃出过程
      g.visible = true;
      g.position.set(
        Math.cos(w.angle) * w.dist,
        -6 + Math.sin(tau * Math.PI) * 15,
        Math.sin(w.angle) * w.dist,
      );
      // 出水抬头 → 入水低头
      g.rotation.x = (tau - 0.5) * 1.7;
      // 面朝游动方向
      const s = Math.sign(w.drift || 1);
      g.rotation.y = Math.atan2(-Math.sin(w.angle) * s, Math.cos(w.angle) * s);
    }
  }

  // 远处若即若离的帆船：绕赛道外围极缓慢巡航，被海雾时隐时现
  #buildShips(mapDef) {
    const hullMat = new THREE.MeshStandardMaterial({
      color: 0x33404e, roughness: 0.9, flatShading: true,
    });
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0xd8dde2, roughness: 0.9, flatShading: true, side: THREE.DoubleSide,
    });
    this.ships = [];
    const count = 4;
    for (let i = 0; i < count; i++) {
      const g = new THREE.Group();
      const hull = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.2, 13), hullMat);
      hull.position.y = 0.6;
      const bow = new THREE.Mesh(new THREE.ConeGeometry(1.7, 3.4, 4), hullMat);
      bow.rotation.x = Math.PI / 2;
      bow.position.set(0, 0.6, 8.2);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.8, 4), hullMat);
      cabin.position.set(0, 2.4, -2);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 9, 6), hullMat);
      mast.position.set(0, 6.5, 1);
      const sail = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 6.5), sailMat);
      sail.position.set(0, 6.2, 0.9);
      g.add(hull, bow, cabin, mast, sail);
      g.scale.setScalar(0.8 + this.rng() * 0.8);
      this.group.add(g);
      this.ships.push({
        group: g,
        dist: mapDef.boundary.r + 240 + this.rng() * 260,
        angle: this.rng() * Math.PI * 2,
        speed: (0.005 + this.rng() * 0.007) * (this.rng() > 0.5 ? 1 : -1),
        bobPhase: this.rng() * Math.PI * 2,
      });
    }
  }

  #updateShips(dt) {
    for (const sh of this.ships) {
      sh.angle += sh.speed * dt;
      const g = sh.group;
      g.position.set(
        Math.cos(sh.angle) * sh.dist,
        Math.sin(this.time * 0.6 + sh.bobPhase) * 0.5,
        Math.sin(sh.angle) * sh.dist,
      );
      const s = Math.sign(sh.speed);
      g.rotation.y = Math.atan2(-Math.sin(sh.angle) * s, Math.cos(sh.angle) * s);
      g.rotation.z = Math.sin(this.time * 0.4 + sh.bobPhase) * 0.05;
    }
  }

  // 卡通白云：白球拼云团，缓慢漂移（参考 game_scene.jpg 的扁平风格云）
  #buildClouds(mapDef) {
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    this.cloudMat = cloudMat;
    this.clouds = [];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const cloud = new THREE.Group();
      const a = (i / count) * Math.PI * 2 + this.rng() * 0.5;
      const dist = 420 + this.rng() * 480;
      const puffs = 3 + Math.floor(this.rng() * 3);
      const baseR = 14 + this.rng() * 16;
      for (let k = 0; k < puffs; k++) {
        const r = baseR * (0.55 + this.rng() * 0.5);
        const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat);
        puff.position.set(
          (k - (puffs - 1) / 2) * baseR * 0.9 + (this.rng() - 0.5) * 6,
          (this.rng() - 0.5) * r * 0.5,
          (this.rng() - 0.5) * 8,
        );
        puff.scale.y = 0.55; // 扁平卡通感
        cloud.add(puff);
      }
      cloud.position.set(Math.cos(a) * dist, 110 + this.rng() * 130, Math.sin(a) * dist);
      // 每朵云有自己的漂移速度与方向
      this.clouds.push({ group: cloud, vx: 0.6 + this.rng() * 1.2, vz: (this.rng() - 0.5) * 0.8, dist });
      this.group.add(cloud);
    }
  }

  update(dt, camera = null, speed = 0) {
    this.time = (this.time || 0) + dt;
    // 熔岩主题的光柱 billboard / 火星上飘（其余地图 lava 为 undefined，零开销）
    this.lava?.update(dt, camera);
    // 高速行驶时云层加速掠过，代替全屏运动模糊
    this.realSky?.update(dt, speed);
    if (this.clouds) {
      for (const c of this.clouds) {
        c.group.position.x += c.vx * dt;
        c.group.position.z += c.vz * dt;
        // 漂出范围后绕回另一侧
        const d = Math.hypot(c.group.position.x, c.group.position.z);
        if (d > c.dist + 220) {
          const ang = Math.atan2(c.group.position.z, c.group.position.x);
          c.group.position.x = Math.cos(ang) * (c.dist - 200);
          c.group.position.z = Math.sin(ang) * (c.dist - 200);
        }
      }
    }
    this.#updateRain(dt, camera);
    this.#updateSnow(dt, camera);
    this.nightSky?.update(dt, camera);
    if (this.landmarks?.length && camera && Math.abs(this.time % 0.35) < dt) {
      const maxDist2 = 110 * 110;
      for (const landmark of this.landmarks) {
        const dx = landmark.position.x - camera.position.x;
        const dz = landmark.position.z - camera.position.z;
        landmark.visible = dx * dx + dz * dz < maxDist2;
      }
    }
    // 烘焙赛道：阴影相机跟着摄像机走，只算身边的人和地
    if (this.shadowFollow && this.sunLight) {
      const px = camera.position.x;
      const pz = camera.position.z;
      this.sunLight.position.set(px + 118, 172, pz + 78);
      this.sunLight.target.position.set(px, 0, pz);
      this.sunLight.target.updateMatrixWorld();
    }
    if (this.whales) this.#updateWhales(dt);
    if (this.ships) this.#updateShips(dt);
    if (this.palaceAnims || this.caustics) this.#updatePalace(dt, camera);
    this.dressing?.update(dt, camera);
  }

  #buildLights(mapDef) {
    const hemi = new THREE.HemisphereLight(mapDef.skyTop, 0x3a4a52, 0.85 * HEMI_GAIN);
    this.group.add(hemi);
    this.hemiLight = hemi;

    const sun = new THREE.DirectionalLight(mapDef.sunColor, 1.6 * SUN_GAIN);
    sun.position.set(180, 260, 120);
    this.group.add(sun);
    this.sunLight = sun;

    // 峡谷：方向光软阴影。阴影相机覆盖整张地图（半径约 265m），
    // 1024 贴图 + PCFSoft，软边足够，代价可控。
    // 湖泊：树影要落在水面上，范围按地图边界放大，高画质给 2048 让树影有轮廓。
    const isBaked = mapDef.style === 'baked';
    // 霓虹海峡整圈 3km：和烘焙赛道一样让阴影相机跟着摄像机走，
    // 只覆盖身边约 190m，城墙/隧道柱廊才有投影，不再"浮"在水面上。
    const isStrait = mapDef.id === 'strait';
    if (this.renderer && (mapDef.id === 'canyon' || mapDef.style === 'lake' || isBaked || isStrait)) {
      sun.castShadow = true;
      const isLake = mapDef.style === 'lake';
      const isFollow = isBaked || isStrait;
      // 烘焙赛道整圈 3km，一张固定阴影相机盖不住 —— 改成跟着摄像机走，
      // 只用 190m 的小范围换精度（贴图 2048，1m 约 5 像素）
      const span = isFollow ? 190 : (isLake ? Math.max(300, (mapDef.boundary?.r ?? 245) + 70) : 300);
      const res = isFollow || (isLake && this.quality === 'high') ? 2048 : 1024;
      sun.shadow.mapSize.set(res, res);
      const cam = sun.shadow.camera;
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = isFollow ? 20 : 40;
      cam.far = isFollow ? 620 : 1200;
      // OrthographicCamera 的视锥改了上下左右/远近之后必须手动刷新投影矩阵，
      // 否则三盏阴影灯都还停在默认 ±5m 的小盒子里 —— 阴影贴图只覆盖灯脚下一小块，
      // 整条赛道等于没有影子（城墙看起来就是一块块的"二维码"）。
      cam.updateProjectionMatrix();
      sun.shadow.bias = isFollow ? -0.0008 : -0.0005;
      sun.shadow.normalBias = isFollow ? 0.12 : 0.06;
      sun.shadow.radius = 2.5;
      if (isFollow) {
        this.shadowFollow = true;
        this.group.add(sun.target);   // DirectionalLight 的 target 必须在场景里，否则位置不更新
      }
    }
  }

  // 远景山脉：三层程序化山脊（近/中/远），颜色按海域固定、不随天气变色
  #buildMountains(mapDef) {
    if (mapDef.style === 'palace') return; // 深海龙宫：纯净海平线 + 海底场景
    if (mapDef.noMountains) return;        // 纯水平面赛道：连远岛都不放，只留海平线
    // 远岛已移除（见 #consumeDistantIslesRng）；这里只保留它原本的随机序列消耗
    if (mapDef.style === 'ocean') this.#consumeDistantIslesRng();
    this.mountains = new THREE.Group();
    this.mountains.name = 'mountains';
    this.terrain.add(this.mountains);
    this.#rebuildMountains();
  }

  // 开阔海面远处的小岛（7 个压扁半球：灰褐岩身 + 绿色草帽）已按用户要求删除：
  // 远景里它们被大气雾洗成两块突兀的纯白圆顶，正好压在山脚与水面交界，
  // 和刚修好的岩面山脊打架（2026-11-15）。
  //
  // ⚠ 不能把 #buildMountains 里那行调用直接删掉：原函数每次循环消耗 5 次
  // this.rng()，共 35 次；而 #buildShores / #buildRocks / #buildWhales /
  // #buildShips 都接着同一条确定性 LCG 序列。少消耗 35 次，整张图的树、礁石、
  // 鲸鱼、帆船、浮冰会全部挪位。所以保留调用、照常走完随机序列，只是不建几何体。
  #consumeDistantIslesRng() {
    for (let i = 0; i < 7; i++) {
      for (let k = 0; k < 5; k++) this.rng();
    }
  }

  // 按当前画质重建山脊（低画质只留近/远两层）
  #rebuildMountains() {
    if (!this.mountains) return;
    for (const mesh of [...this.mountains.children]) {
      this.mountains.remove(mesh);
      mesh.geometry?.dispose();
      // map 是全局共享的岩石草地贴图，重建时不能 dispose（会被后续山脊复用）
      mesh.material?.dispose?.();
    }
    const segs = MOUNTAIN_SEGMENTS[this.quality] ?? MOUNTAIN_SEGMENTS.high;
    const bands = MOUNTAIN_BANDS[this.quality] ?? MOUNTAIN_BANDS.high;
    MOUNTAIN_LAYERS.forEach((spec, i) => {
      const segments = segs[i] ?? 0;
      if (!segments) return;
      const mesh = this.#makeRidgeSheet(this.map, spec, segments, bands[i] ?? 7);
      if (mesh) this.mountains.add(mesh);
    });
    this.#syncMountainLight();
  }

  /**
   * 一道环形山脉：角向 × 纵深的**高度场**，顶点色烘焙大气透视 + 真实法线光照
   * + 谷地 AO + 坡度分层（陡壁露岩 / 缓坡长草）+ 雪线。材质不吃场景雾。
   *
   * 旧版是"一条沿角度起伏的线"被纵向直线插值成一面内倾的墙：顶线近乎水平，
   * 没有山谷、支脉、前后坡，远看就是一圈锯齿壁纸。现在每个 (角度, 纵深)
   * 顶点都有独立高度，山才有体积；法线由相邻顶点叉乘求得，明暗不再是解析近似。
   */
  #makeRidgeSheet(mapDef, spec, segments, bands) {
    const palette = MOUNTAIN_PALETTES[mapDef.mountainStyle || mapDef.style] ?? MOUNTAIN_PALETTES.lake;
    const R = (mapDef.boundary?.r ?? 260) + spec.offset;
    const hazeCol = new THREE.Color(palette.sky).lerp(new THREE.Color(0x8ea8bc), 0.55);
    const baseCol = new THREE.Color(palette[spec.key]);
    // 裸露岩层：比基色更亮更冷，和植被形成"岩石 + 草地"的混合
    const rockCol = new THREE.Color(palette[spec.key]).lerp(new THREE.Color(0xc6c4b9), 0.42);
    const vegCol = new THREE.Color(palette.veg);
    const depth = spec.depth ?? 120;
    const hScale = THREE.MathUtils.clamp((mapDef.boundary?.r ?? 260) / 700, 0.60, 1.0);
    const hMin = spec.hMin * hScale;
    const hMax = spec.hMax * hScale;

    const rand = mulberry32(spec.seed * 977 + segments);
    // 主脊不用"噪声 + smoothstep"了：噪声一饱和，顶线就削成平顶台地；
    // 再上幂次又会把整段压矮。改成**显式主峰叠加**——每座峰是钟形尖顶，
    // 峰与峰之间自然落出 V 形垭口，才有"高低起伏的大山"而不是等高锯齿。
    const octaveSpecs = [[0.045, 0.55], [0.130, 0.30], [0.330, 0.15]];
    const octaves = octaveSpecs.map(([frac, amp]) => {
      const count = Math.max(3, Math.round(segments * frac));
      return { count, amp, pts: Array.from({ length: count }, () => rand()) };
    });
    // 每圈峰数：一个方向只能看到约 1/4 圈，8 座峰就成了"海上几座孤岛"。
    // 加密到 20+ 座并收窄峰宽，顶线才是连绵的山脊而不是一排圆锥。
    const peakCount = spec.key === 'far' ? 26 : spec.key === 'mid' ? 22 : 20;
    const peaks = Array.from({ length: peakCount }, (_, k) => ({
      u: (k + 0.18 + 0.64 * rand()) / peakCount,
      w: 0.012 + 0.016 * rand(),
      h: 0.42 + 0.58 * rand(),
      skew: 0.62 + 0.76 * rand(),   // 左右坡不对称：真实山体不是对称钟形
    }));
    const wrapDist = (a0, b0) => {
      const d = Math.abs(a0 - b0);
      return Math.min(d, 1 - d);
    };
    const wrapSigned = (a0, b0) => {
      let d = a0 - b0;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      return d;
    };
    // 三个尺度的二维噪声：谷地/支脉（低频）、山坡起伏、岩面褶皱
    const nValley = makeMountainNoise2D(spec.seed * 101 + 3, 16, 6);
    const nMid = makeMountainNoise2D(spec.seed * 211 + 7, 57, 8);
    const nFine = makeMountainNoise2D(spec.seed * 307 + 11, 113, 9);
    // 着色专用：两个方向格点数接近的**各向同性**噪声。
    // nValley / nMid / nFine 是 nx≫ny 的（16×6、57×8、113×9），拿来给顶点色
    // 上色就会画出沿高度几乎不变的竖向条带 —— 这是"拉丝"的另一半来源。
    // 它们只保留给高度场（拓扑不动），表面着色一律换 nIso。
    const nIso = makeMountainNoise2D(spec.seed * 401 + 13, 22, 18);
    // 低频大色斑：两方向格点数接近（10×9），只做大块斑驳、不产生任何条带。
    // 山体去掉照片贴图后容易变成"纯色多边形"，靠它补回远近层次。
    const nTint = makeMountainNoise2D(spec.seed * 503 + 17, 10, 9);

    const ridge = new Float32Array(segments + 1);
    const peakPos = new Float32Array(segments + 1);
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      // 连绵基脊：谷底也有 30~55% 的山体高度，峰是从脊上"长"出来的。
      // 少了这一层，峰与峰之间直接沉到海平面，读起来就是一排孤岛。
      const chain = 0.34 + 0.24 * nValley(u + 0.31, 0.05);
      let crest = 0;
      for (const pk of peaks) {
        let d = wrapSigned(u, pk.u) / pk.w;
        if (d > 0) d /= pk.skew; else d *= pk.skew;
        crest = Math.max(crest, pk.h * Math.exp(-Math.pow(Math.abs(d), 1.25) * 1.7));
      }
      // 细节：中频 ridged 噪声把光滑钟形峰打出山脊棱线
      let v = 0;
      for (const { count, amp, pts } of octaves) {
        const t = u * count;
        const i0 = Math.floor(t) % count;
        const f = t - Math.floor(t);
        const sm = f * f * (3 - 2 * f);
        v += (pts[i0] + (pts[(i0 + 1) % count] - pts[i0]) * sm) * amp;
      }
      const ridged = 1 - Math.abs(2 * v - 1);
      let r = chain * (0.86 + 0.28 * ridged) + crest * 0.62;
      // 深谷通道：低频噪声挑出几处垭口往下切，但不再把整段切没
      const lane = THREE.MathUtils.smoothstep(nValley(u, 0.12), 0.55, 0.80);
      r *= 1 - 0.40 * lane;
      ridge[i] = Math.pow(THREE.MathUtils.clamp(r, 0.02, 1), spec.sharp);
      // 脊线在纵深上的位置随角度摆动 → 山坡不是一圈同心圆
      peakPos[i] = 0.30 + 0.12 * nValley(u + 0.07, 0.30);
    }
    // 首尾必须严格相等，否则环形山脊有一道接缝
    ridge[segments] = ridge[0];
    peakPos[segments] = peakPos[0];

    const tileM = spec.tileM ?? 42;
    const uRepeat = (Math.PI * 2 * R) / tileM;
    const vertexCount = (segments + 1) * bands;
    const positions = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const heightField = new Float32Array(vertexCount);
    const valleyField = new Float32Array(vertexCount);
    const indices = [];

    // 固定太阳方向：向阳坡/背阴坡的明暗关系不随天气变化
    const lightAz = 0.9;
    const lightEl = 0.55;
    const L = new THREE.Vector3(
      Math.cos(lightEl) * Math.cos(lightAz),
      Math.sin(lightEl),
      Math.cos(lightEl) * Math.sin(lightAz),
    ).normalize();

    // ---- 1. 高度场 → 位置 / UV ----
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const a = u * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const h = hMin + (hMax - hMin) * ridge[i];
      const peak = peakPos[i];
      for (let j = 0; j < bands; j++) {
        const t = j / (bands - 1);
        // 纵向剖面：外坡缓升、近脊变陡；峰位随角度摆动
        const p = t < peak ? t / peak : (1 - t) / (1 - peak);
        const prof = Math.pow(THREE.MathUtils.clamp(p, 0, 1), 1.15);
        // 谷口朝场内张开：越靠内坡，谷地切得越深
        const valley = THREE.MathUtils.smoothstep(nValley(u, 0.50 + 0.45 * t), 0.46, 0.76)
          * (0.30 + 0.70 * t);
        // 支脉：从主脊伸向场内的山梁，和谷地错开半个周期
        const spur = THREE.MathUtils.smoothstep(nValley(u + 0.11, 0.18 + 0.55 * t), 0.61, 0.85)
          * t * (1 - t) * 4;
        const micro = (nMid(u, t) - 0.5) * 2;
        let H = prof * ridge[i] * (1 - 0.72 * valley)
          + 0.20 * spur * ridge[i]
          + 0.055 * micro * prof;
        H = THREE.MathUtils.clamp(H, 0, 1);
        const y = -40 + (h + 40) * H;
        // 外山脚半径大、内山脚半径小；山体纵深百米级，才有前后两个坡面
        const meander = (nMid(u + 0.23, t) - 0.5) * depth * 0.055 * prof;
        const radius = R + depth * (0.5 - t) + meander;
        const vi = i * bands + j;
        positions[vi * 3] = ca * radius;
        positions[vi * 3 + 1] = y;
        positions[vi * 3 + 2] = sa * radius;
        // UV 在下面按「环向弧长 / 坡面弧长」统一算，这里先只存高度场
        heightField[vi] = H;
        valleyField[vi] = valley;
      }
    }

    // ---- 1b. 各向同性 UV：两个方向都按「每 tileM 一张」铺 ----
    // 旧版 v = (y+40)/tileM*1.6 + t*(depth/tileM)*1.6：环向 u 跨 20+ 周期、
    // 纵向 v 只跨 5 个周期，照片里的沟壑被拉成从山顶贯穿到山脚的竖条；
    // 那个 t 项还会让纹理沿坡面斜着走。现在 v 用沿坡面的**累计三维弧长**，
    // 坡再陡贴图也是等比的，不会被拉长。
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      let arc = 0;
      for (let j = 0; j < bands; j++) {
        const vi = i * bands + j;
        if (j > 0) {
          const a = (vi - 1) * 3, b = vi * 3;
          arc += Math.hypot(
            positions[b] - positions[a],
            positions[b + 1] - positions[a + 1],
            positions[b + 2] - positions[a + 2],
          );
        }
        uvs[vi * 2] = u * uRepeat;
        uvs[vi * 2 + 1] = arc / tileM;
      }
    }

    // ---- 2. 由相邻顶点叉乘求真实法线 ----
    const get = (i, j, k) => positions[((i + segments) % segments) * bands * 3 + j * 3 + k];
    for (let i = 0; i <= segments; i++) {
      const iL = (i - 1 + segments) % segments;
      const iR = (i + 1) % segments;
      for (let j = 0; j < bands; j++) {
        const jD = Math.max(0, j - 1);
        const jU = Math.min(bands - 1, j + 1);
        const ax = get(iR, j, 0) - get(iL, j, 0);
        const ay = get(iR, j, 1) - get(iL, j, 1);
        const az = get(iR, j, 2) - get(iL, j, 2);
        const bx = get(i, jU, 0) - get(i, jD, 0);
        const by = get(i, jU, 1) - get(i, jD, 1);
        const bz = get(i, jU, 2) - get(i, jD, 2);
        let nx = by * az - bz * ay;
        let ny = bz * ax - bx * az;
        let nz = bx * ay - by * ax;
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const nl = Math.hypot(nx, ny, nz) || 1;
        const vi = (i * bands + j) * 3;
        normals[vi] = nx / nl;
        normals[vi + 1] = ny / nl;
        normals[vi + 2] = nz / nl;
      }
    }

    // 法线沿环向做 5 点平滑：尖峰处相邻顶点高度差极大，逐点叉乘出来的法线
    // 会在角向剧烈翻跳，方向光把它放大成一条条贯穿整座山的竖直暗带
    //（就是用户说的"阴影被拉长了"）。只糊角向、保留纵深方向的坡面明暗，体积感不丢。
    const smoothN = new Float32Array(normals.length);
    for (let i = 0; i <= segments; i++) {
      for (let j = 0; j < bands; j++) {
        let sx = 0, sy = 0, sz = 0;
        for (let d = -2; d <= 2; d++) {
          const ii = ((i + d) % segments + segments) % segments;
          const k = (ii * bands + j) * 3;
          const w = d === 0 ? 2 : 1;
          sx += normals[k] * w; sy += normals[k + 1] * w; sz += normals[k + 2] * w;
        }
        const l = Math.hypot(sx, sy, sz) || 1;
        const vi = (i * bands + j) * 3;
        smoothN[vi] = sx / l; smoothN[vi + 1] = sy / l; smoothN[vi + 2] = sz / l;
      }
    }
    normals.set(smoothN);

    // ---- 3. 顶点色：真实法线光照 + 谷地 AO + 坡度分层 + 雪线 + 大气透视 ----
    const snowCol = new THREE.Color(0xe9eef2);
    const snowStart = hMax * (spec.key === 'near' ? 0.70 : spec.key === 'mid' ? 0.78 : 2.0);
    const col = new THREE.Color();
    for (let i = 0; i <= segments; i++) {
      const u = i / segments;
      const iL = (i - 2 + segments) % segments;
      const iR = (i + 2) % segments;
      for (let j = 0; j < bands; j++) {
        const vi = i * bands + j;
        const t = j / (bands - 1);
        const H = heightField[vi];
        const y = positions[vi * 3 + 1];
        const nx = normals[vi * 3];
        const ny = normals[vi * 3 + 1];
        const nz = normals[vi * 3 + 2];
        const ndl = Math.max(0, nx * L.x + ny * L.y + nz * L.z);
        const slope = THREE.MathUtils.clamp(1 - ny, 0, 1);
        const groove = nIso(u, t);                            // 各向同性岩面颗粒
        const valley = valleyField[vi];
        // 谷地 AO：四个方向邻域一起看。旧版只看左右、且沿用同一个 j，
        // 结果暗部沿整座山纵向贯穿，成了一条条"拉长的阴影"。
        const jD = Math.max(0, j - 1), jU = Math.min(bands - 1, j + 1);
        const neigh = (heightField[iL * bands + j] + heightField[iR * bands + j]
          + heightField[i * bands + jD] + heightField[i * bands + jU]) * 0.25;
        const ao = THREE.MathUtils.clamp((neigh - H) * 2.2, 0, 1);

        col.copy(baseCol);
        // 各向同性大色斑：柔和的斑驳明暗，替代被删掉的方向性岩纹
        col.multiplyScalar(0.94 + 0.12 * nTint(u, t));
        // 坡度分层：陡壁露岩、缓坡长草；远山少掺岩石（浅灰会把蓝山脊洗成灰板）
        const rockMix = (spec.key === 'far' ? 0.10 : 0.20) + 0.52 * slope + 0.035 * groove;
        col.lerp(rockCol, THREE.MathUtils.clamp(rockMix, 0, 0.85));
        if (spec.key !== 'far') {
          const low = 1 - THREE.MathUtils.smoothstep(H, 0.06, 0.60);
          const grass = low * (1 - slope) * (0.28 + 0.56 * nIso(u + 0.31, 0.10 + 0.80 * t));
          col.lerp(vegCol, THREE.MathUtils.clamp(grass, 0, 0.62));
        }
        // 沉积岩层：纯水平、极淡。旧版用 nMid(u,t) 去扰动相位，把水平层理
        // 扭成了斜向长条，那也是"拉长"的一部分。
        const strata = Math.sin(y * 0.075);
        col.multiplyScalar(0.985 + 0.025 * strata);
        // 山脚沉、山脊亮：900 米外没有法线细节，全靠纵向渐变撑体积
        col.multiplyScalar(spec.key === 'far' ? 0.76 + 0.38 * H : 0.86 + 0.24 * H);
        // 沟壑 + 谷地 AO：只留很轻的一层，不再靠它画"阴影"
        col.multiplyScalar(1 - 0.06 * valley - 0.08 * ao);
        // 方向光 + 天光补光：对比度收窄，背阴坡不能黑成一条竖直剪影
        const lit = 0.46 + 0.54 * Math.pow(ndl, 0.9);
        col.multiplyScalar(lit * (0.88 + 0.18 * (0.5 + 0.5 * ny)));

        // 雪线：只盖最高的峰、且朝上的坡面；三层都给（旧版只给 near）
        const snow = THREE.MathUtils.smoothstep(y, snowStart, snowStart + hMax * 0.24)
          * THREE.MathUtils.smoothstep(ny, 0.42, 0.86)
          * (0.55 + 0.45 * ndl);
        if (snow > 0.001) col.lerp(snowCol, Math.min(0.90, snow * 1.05));

        // 大气透视：山脚薄雾 + 脊顶一丝雾（山天交界不再是硬剪影）
        const lowHazeK = spec.key === 'near' ? 0.52 : spec.key === 'mid' ? 0.34 : 0.16;
        const lowHaze = lowHazeK * (1 - THREE.MathUtils.smoothstep(y, -5, 140));
        const topHaze = 0.06 * THREE.MathUtils.smoothstep(H, 0.80, 1.0);
        // 山脚雾化按**相对高度**：旧版按绝对 y<70m，不同地图/图层缩放后
        // 会在水面交界糊出一块突兀的浅白亮斑（ocean 截图山脚那块白）。
        const footFade = 0.42 * (1 - THREE.MathUtils.smoothstep(H, 0.0, 0.28));
        // 两种山脚雾只能取其一：旧版相加能到 0.96，山脚被雾色整片刷成硬白块
        //（ocean 截图里山水交界那两块白斑），而且会把新烘的岩面贴图一起冲掉。
        col.lerp(hazeCol, Math.min(0.88, spec.haze + topHaze + Math.max(lowHaze, footFade)));
        colors[vi * 3] = col.r;
        colors[vi * 3 + 1] = col.g;
        colors[vi * 3 + 2] = col.b;
      }
    }

    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < bands - 1; j++) {
        const a0 = i * bands + j;
        const a1 = (i + 1) * bands + j;
        indices.push(a0, a0 + 1, a1, a1, a0 + 1, a1 + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);

    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      fog: false,          // 颜色已烘焙大气透视，再叠场景雾会随天气整体变色
      map: getMountainRockTexture(),
    }));
    mesh.frustumCulled = false; // 环形山脊包围球极大，避免被误剔除
    return mesh;
  }

  // 切换画质时重建山脊（高/中/低三档分段数不同）
  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.#rebuildMountains();
    // 星空的星星/流星/星尘数量也按档位重配（只有星空天气下才存在这组对象）
    this.nightSky?.setQuality(q);
  }

  /**
   * 树的统一入口：只登记坐标，等松树 GLB 到位后再生成实例。
   * 原来是「构建时直接往 StaticMerge 里塞锥体」，改成登记是因为模型/贴图是异步的；
   * 万一加载失败，`#spawnPines` 会退回原来那套程序化锥形树，岸边不会变秃。
   */
  #addTree({ x, z, y, h, w, kind }) {
    this.pineSlots ||= [];
    this.pineSlots.push({
      x, z, y, h, w, kind,
      variant: this.pineSlots.length % 3,
      rotY: this.rng() * Math.PI * 2,
      // 针叶树要"细高"：横向允许比纵向小一截，一簇里高矮胖瘦才不齐
      slim: 0.86 + this.rng() * 0.30,
    });
  }

  #spawnPines(mats) {
    const slots = this.pineSlots;
    if (!slots?.length) return;
    this.pineSlots = [];
    this.pineMeshes ||= [];
    loadPineVariants().then((variants) => {
      if (!variants) {
        this.#buildProceduralTrees(slots, mats);
        return;
      }
      const byVariant = new Map();
      for (const s of slots) {
        const vi = s.variant % variants.length;
        if (!byVariant.has(vi)) byVariant.set(vi, []);
        byVariant.get(vi).push(s);
      }
      const dummy = new THREE.Object3D();
      for (const [vi, list] of byVariant) {
        const v = variants[vi];
        const im = new THREE.InstancedMesh(v.geo, v.material, list.length);
        im.name = 'shore-pines-' + vi;
        im.castShadow = true;
        im.receiveShadow = true;
        // 沿岸一整圈加起来包围球极大，交给视锥剔除每帧都在算，反而不划算
        im.frustumCulled = false;
        list.forEach((s, i) => {
          const sy = s.h / v.height;
          dummy.position.set(s.x, s.y, s.z);
          dummy.rotation.set(0, s.rotY, 0);
          dummy.scale.set(sy * s.slim, sy, sy * s.slim);
          dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix);
        });
        im.instanceMatrix.needsUpdate = true;
        im.userData.isPine = true;
        this.group.add(im);
        this.pineMeshes.push(im);
      }
    });
  }

  /**
   * 在任意 group 里铺一批松树（InstancedMesh）。
   * `#spawnPines` 只服务岸边植被（写死了 this.group 和兜底流程），
   * BOSS 主题的远景岛要复用同一份 GLB，所以把实例化这段单独暴露出来。
   * 槽位：{ x, y, z, h, rotY?, slim?, variant? }，y 是"落地面"高度。
   * 几何体/材质来自模块级缓存，必须在 `userData.sharedAsset` 上打标，
   * 否则主题切换时会被 #clear 释放掉，下次进同一关就白模/黑块。
   */
  addPineStand(slots, group = this.group, { name = 'pines', castShadow = true } = {}) {
    if (!slots?.length) return Promise.resolve([]);
    return loadPineVariants().then((variants) => {
      if (!variants) return [];
      const byVariant = new Map();
      for (const s of slots) {
        const vi = (s.variant ?? 0) % variants.length;
        if (!byVariant.has(vi)) byVariant.set(vi, []);
        byVariant.get(vi).push(s);
      }
      const dummy = new THREE.Object3D();
      const out = [];
      for (const [vi, list] of byVariant) {
        const v = variants[vi];
        const im = new THREE.InstancedMesh(v.geo, v.material, list.length);
        im.name = `${name}-${vi}`;
        im.castShadow = castShadow;
        im.receiveShadow = castShadow;
        im.frustumCulled = false;
        im.userData.sharedAsset = true;
        list.forEach((s, i) => {
          const sy = s.h / v.height;
          const slim = s.slim ?? 1;
          dummy.position.set(s.x, s.y, s.z);
          dummy.rotation.set(0, s.rotY ?? 0, 0);
          dummy.scale.set(sy * slim, sy, sy * slim);
          dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix);
        });
        im.instanceMatrix.needsUpdate = true;
        group.add(im);
        out.push(im);
      }
      return out;
    });
  }

  /** GLB 拿不到时的兜底：还是原来那套锥形松树 / 多面体阔叶树 */
  #buildProceduralTrees(slots, mats) {
    const m = mats || getShoreMats();
    const merge = new StaticMerge();
    for (const s of slots) {
      const spec = { x: s.x, z: s.z, y: s.y, h: s.h, w: s.w, rng: this.rng };
      if (s.kind === 'broad') addBroadTree(merge, m, spec);
      else addPineTree(merge, m, spec);
    }
    for (const o of merge.flush(this.group, 'shore-trees-fallback')) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  }

  // 程序化河岸：沿赛道航点两侧自动布置
  #buildShores(mapDef) {
    // 熔岩海没有沙滩/草坡/芦苇：赛道是悬浮在岩浆上的走廊，岸带整组不建。
    if (mapDef.lava) return;
    if (mapDef.style === 'palace') return; // 深海龙宫：由 #buildPalace 负责场景
    if (mapDef.style === 'arena') {
      // 圆形竞技场是封闭战场：树一律种在边界外的远景里（玩家到不了），
      // 既不会出现“船穿过树”的穿模，也不会挡住 BOSS 战视野。
      // 树种走和赛道边同一套真实松树 GLB —— 这里原来是手搓的三层锥体
      // （ConeGeometry + flatShading + 纯绿），远看就是"塑料做的圣诞树"。
      const R = mapDef.boundary?.r ?? 92;
      const N = 46;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2 + (this.rng() - 0.5) * 0.14;
        const r = R + 18 + this.rng() * 26;
        const px = Math.cos(a) * r;
        const pz = Math.sin(a) * r;
        // 比原来的锥体高一档：真松树剪影细，矮了在一片雾里就看不见了
        const h = 7 + this.rng() * 5;
        const w = 2.2 + this.rng() * 1.4;
        this.#addTree({ x: px, z: pz, y: 0, h, w, kind: 'pine' });
      }
      this.#spawnPines(getShoreMats());
      return;
    }
    const gates = mapDef.gates;
    const isCanyon = mapDef.style === 'canyon';
    const shortcutClearance = (x, z, radius) => {
      for (const shortcut of mapDef.shortcuts || []) {
        const points = shortcut.points || [];
        for (let i = 0; i < points.length - 1; i++) {
          const [ax, az] = points[i];
          const [bx, bz] = points[i + 1];
          const sx = bx - ax;
          const sz = bz - az;
          const len2 = sx * sx + sz * sz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
          if (Math.hypot(x - (ax + sx * t), z - (az + sz * t)) < shortcut.width + radius + 2.5) return false;
        }
      }
      return true;
    };
    // 先让开主道时石头可能被推回近道走廊里；这里沿最近近道段的法线把它推到走廊外，
    // 而不是直接删掉，保持近道两侧仍有布景。
    const shortcutPush = (x, z, radius) => {
      for (const shortcut of mapDef.shortcuts || []) {
        const points = shortcut.points || [];
        const limit = shortcut.width + radius + 2.5;
        for (let iter = 0; iter < 6; iter++) {
          let moved = false;
          for (let i = 0; i < points.length - 1; i++) {
            const [ax, az] = points[i];
            const [bx, bz] = points[i + 1];
            const sx = bx - ax;
            const sz = bz - az;
            const len2 = sx * sx + sz * sz || 1;
            const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
            const cx = ax + sx * t;
            const cz = az + sz * t;
            let vx = x - cx;
            let vz = z - cz;
            const d = Math.hypot(vx, vz);
            if (d >= limit) continue;
            if (d < 0.01) {
              const sl = Math.hypot(sx, sz) || 1;
              vx = -sz / sl;
              vz = sx / sl;
            } else {
              vx /= d;
              vz /= d;
            }
            const need = limit - d + 0.8;
            x += vx * need;
            z += vz * need;
            moved = true;
          }
          if (!moved) break;
        }
      }
      return [x, z];
    };

    // 烘焙赛道（Blender GLB）：所有环境装饰都由段模型自带，
    // 这里再撒浮标/岸/树只会和模型错位（用户反馈"浮桶没贴到模型上"）
    if (mapDef.style === 'baked') return;

    // 纯水面赛道：程序化「红白浮标」（红色圆柱 + 白色锥顶的低模几何体）已按用户
    // 要求从全部地图移除。边缘标记交给 Track.#buildEdgeBuoys 的浮桶 / 导航灯船，
    // 这里不再重复摆一排。必须保留 return：后面是峡谷岩壁 / 河岸 / 树林逻辑，
    // 纯水面赛道一旦落下去会凭空长出岸和树。
    if (mapDef.style === 'ocean') return;

    if (isCanyon) {
      // 峡谷：两侧岩壁（硬边界）。材质统一走青灰岩 + 青绿草坡 + 浸水岩圈，
      // 不再用暖棕 #9c7a5c——整张图里近景岩石都属于冷绿体系。
      const segs = [];
      for (let i = 0; i < gates.length; i++) {
        const a = gates[i];
        const b = gates[(i + 1) % gates.length];
        segs.push([a[0], a[1], b[0], b[1]]);
      }
      const distToTrack = (x, z) => {
        let min = Infinity;
        for (const [ax, az, bx, bz] of segs) {
          const sx = bx - ax;
          const sz = bz - az;
          const len2 = sx * sx + sz * sz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
          min = Math.min(min, Math.hypot(x - (ax + sx * t), z - (az + sz * t)));
        }
        return min;
      };
      const cliffMerge = new StaticMerge();
      for (let i = 0; i < gates.length; i++) {
        const g = gates[i];
        const gNext = gates[(i + 1) % gates.length];
        const dx = gNext[0] - g[0];
        const dz = gNext[1] - g[1];
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len; // 法线
        const nz = dx / len;
        const offset = mapDef.gateWidth + 6 + this.rng() * 7;
        for (const side of [-1, 1]) {
          let px = g[0] + nx * offset * side + (this.rng() - 0.5) * 6;
          let pz = g[1] + nz * offset * side + (this.rng() - 0.5) * 6;
          const h = 12 + this.rng() * 16;
          const w = 11 + this.rng() * 8;
          const rockR = w * 0.62;
          // Keep large canyon props outside shortcut corridors. Move the
          // complete prop outward instead of leaving a hidden collision trap.
          if (isCanyon) {
            for (let attempt = 0; attempt < 2 && !shortcutClearance(px, pz, rockR); attempt++) {
              px += nx * side * 12;
              pz += nz * side * 12;
            }
            // 河道净空：石头内缘到任何一段航道中线至少留 gateWidth + 2.5 米，
            // 也就是每个门都有一整条“门宽”可以通过，和之前的留缝版本一致
            const need = mapDef.gateWidth + rockR + 2.5;
            for (let attempt = 0; attempt < 9 && distToTrack(px, pz) < need; attempt++) {
              px += nx * side * 6;
              pz += nz * side * 6;
            }
            // 实在挤不下（例如两条航道夹出的死角）就不要这块石头，
            // 宁可少一块布景，也不能在水面上留一堵看不见的墙
            if (distToTrack(px, pz) < need) continue;
            // 让开主道后可能又被推回近道走廊：沿近道法线再推出去，
            // 推完仍会压住主道或近道就直接放弃这块石头
            const pushed = shortcutPush(px, pz, rockR);
            px = pushed[0];
            pz = pushed[1];
            if (distToTrack(px, pz) < need || !shortcutClearance(px, pz, rockR)) continue;
          }
          // rng 顺序保持不变（材质 → 三个角度），保证同一地图每次生成完全一致
          const useA = this.rng() > 0.5;
          const rx = (this.rng() - 0.5) * 0.25;
          const ry = this.rng() * Math.PI;
          const rz = (this.rng() - 0.5) * 0.25;
          // 主岩体：宽而略扁，像参考图的海中岩岛，不是细高的石柱
          const halfHeight = h * 0.62;
          const centerY = h * 0.3;
          const parts = buildCanyonBoulder({
            radius: rockR,
            halfHeight,
            centerY,
            seed: Math.round(px * 5.3 + pz * 9.1 + h * 2.7) + (useA ? 137 : 0),
          });
          addCanyonBoulder(cliffMerge, parts, trs(px, centerY, pz, rx, ry, rz, 1, 1, 1));
          // 伴生小岩块：贴着主岩体长，轮廓不再是一根柱子；
          // 半径 + 偏移都收在碰撞半径内，不会出现看得见却撞不着的石头
          const compR = rockR * 0.52;
          const compX = px + Math.cos(ry) * rockR * 0.44;
          const compZ = pz - Math.sin(ry) * rockR * 0.44;
          const compParts = buildCanyonBoulder({
            radius: compR,
            halfHeight: h * 0.42,
            centerY: h * 0.22,
            seed: Math.round(compX * 7.1 + compZ * 3.3) + 71,
            grass: true,
          });
          addCanyonBoulder(cliffMerge, compParts, trs(compX, h * 0.22, compZ, 0, ry + 1.1, 0, 1, 1, 1));
          // 碰撞体覆盖主岩体和伴生岩块的整体，防止弹射模式从顶上飞过去
          this.colliders.push({
            type: 'cliff',
            x: px,
            z: pz,
            r: rockR,
            bottomY: -h * 0.4,
            topY: h * 0.95,
          });
        }
      }
      const cliffMeshes = cliffMerge.flush(this.group, 'canyon-cliffs');
      // 岩壁是异步/延后生成的：天气早已设好，这里必须补一次冬季上妆
      this.#applyWinterTint(this.weather);
      // 岩壁自遮挡阴影：只影响岩壁本身，开销是每帧一张 1024 阴影图
      for (const m of cliffMeshes) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    } else {
      // 湖泊：沿赛道两侧铺草坡堤岸，树和石头都按剖面高度落到坡上
      // 看台占地（与 LakeStadium 共用同一份布点）：这一带不种树、不摆岸石，
      // 否则树会从看台阶梯中间长出来、石头会卡在柱廊里。
      // ?lakeStadium=0 关掉看台时这里同样返回 null —— 关闭必须是真正的原样，不能只留空地。
      const stadiumZones = mapDef.id === 'lake' && !lakeStadiumDisabledByUrl()
        ? lakeStadiumLayout(mapDef)
        : null;
      const mats = getShoreMats();
      const profile = makeShoreProfile({ gateWidth: mapDef.gateWidth, topY: 1.6, waterY: 0 });
      const bank = buildShoreBankGeometry(gates, {
        profile, rng: this.rng, shortcuts: mapDef.shortcuts || [],
      });
      bank.name = 'shore-bank';
      bank.receiveShadow = true;
      this.group.add(bank);
      // 岸带晚于天气生成，同样补一次冬季上妆（否则暴雪里仍是绿草坡）
      this.#applyWinterTint(this.weather);
      const heightAt = (off) => shoreHeightAt(profile, off);

      const treeMerge = new StaticMerge();
      const rockMerge = new StaticMerge();
      const clearOfIslands = (x, z, pad) => (mapDef.islands || [])
        .every((isle) => Math.hypot(x - isle.x, z - isle.z) > isle.r + pad);
      for (let i = 0; i < gates.length; i++) {
        const g = gates[i];
        const gNext = gates[(i + 1) % gates.length];
        const dx = gNext[0] - g[0];
        const dz = gNext[1] - g[1];
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        for (const side of [-1, 1]) {
          // 岸边成林：松树剪影比原来的锥形树细得多，同样的簇数看起来会"变秃"，
          // 所以提高出簇概率（0.5→0.74）并加密每簇棵数（3~4 棵）
          if (this.rng() > 0.74) continue;
          const off = mapDef.gateWidth + 8 + this.rng() * 6;
          const cx = g[0] + nx * off * side + (this.rng() - 0.5) * 4;
          const cz = g[1] + nz * off * side + (this.rng() - 0.5) * 4;
          if (!shortcutClearance(cx, cz, 5) || !clearOfIslands(cx, cz, 6)) continue;
          const cluster = 3 + (this.rng() > 0.45 ? 1 : 0);
          for (let k = 0; k < cluster; k++) {
            const tx = cx + (this.rng() - 0.5) * 6.5;
            const tz = cz + (this.rng() - 0.5) * 6.5;
            const h = 6.2 + this.rng() * 4.2;
            const w = 1.6 + this.rng() * 0.8;
            // 树干底部往下埋 0.2 插进坡面，不会悬空
            const ty = heightAt(off + (this.rng() - 0.5) * 3) - 0.2;
            const tree = { x: tx, z: tz, y: ty, h, w, rng: this.rng };
            // 先摇完这一棵的树种，再判断要不要种：顺序不能换，
            // 换了 si 一样的 rng 序列就整体位移，岸边其它树会全部挪位。
            const kind = this.rng() > 0.12 ? 'pine' : 'broad';
            if (stadiumZones && inStadiumFootprint(stadiumZones, tx, tz, 2)) continue;
            // 绝大多数换成真实松树模型（Poly Haven Pine Sapling，Blender 减到 2260 面），
            // 只留约 1/8 的阔叶树给岸边一点色相变化；想全松树把 0.12 改成 0 即可
            this.#addTree({ ...tree, kind });
            this.colliders.push({ x: tx, z: tz, r: 0.95, bottomY: ty, topY: ty + h });
          }
          // 树簇旁点缀一块长苔藓的石头
          if (this.rng() > 0.45) {
            const rx = cx + nx * side * 2 + (this.rng() - 0.5) * 4;
            const rz = cz + nz * side * 2 + (this.rng() - 0.5) * 4;
            const rockSize = 1.0 + this.rng() * 1.1;
            const rockRy = this.rng() * Math.PI;
            if (stadiumZones && inStadiumFootprint(stadiumZones, rx, rz, 1)) continue;
            if (!shortcutClearance(rx, rz, rockSize)) continue;
            addShoreRock(rockMerge, mats, {
              x: rx,
              z: rz,
              size: rockSize,
              seed: Math.round(cx * 3.7 + cz * 5.1) + i * 13,
              ry: rockRy,
              baseY: heightAt(off + 2) - 0.28,
              colliders: this.colliders,
            });
          }
        }
        // 水线接触细节：贴水皮的小灌木与芦苇，隔门散点，岸线不再是一条干净色带
        if (i % 3 === 0) {
          const side = i % 2 === 0 ? 1 : -1;
          const off = mapDef.gateWidth + 2.8 + this.rng() * 2.6;
          const bx = g[0] + nx * off * side;
          const bz = g[1] + nz * off * side;
          if (shortcutClearance(bx, bz, 4) && clearOfIslands(bx, bz, 4)) {
            const by = heightAt(off) - 0.05;
            if (this.rng() > 0.5) {
              addReeds(treeMerge, mats, { x: bx, z: bz, y: by, s: 1.0 + this.rng() * 0.6, rng: this.rng });
            } else {
              addShoreBush(treeMerge, mats, { x: bx, z: bz, y: by, s: 1.4 + this.rng() * 0.8, rng: this.rng });
            }
          }
        }
        // 浅滩上零星半沉水面的石头，让水线不只是一条平整的色带
        if (i % 2 === 0) {
          const off = mapDef.gateWidth + 3 + this.rng() * 2.2;
          const side = i % 4 === 0 ? -1 : 1;
          const sx = g[0] + nx * off * side;
          const sz = g[1] + nz * off * side;
          const size = 1.1 + this.rng() * 1.2;
          const ry = this.rng() * Math.PI;
          // 浅滩石头原本没有近道判断：近道起点上方会凭空多出一块带碰撞的石头。
          // rng 值全部先摇完再判断，岸边其它布景不会跟着挪位。
          if (!shortcutClearance(sx, sz, size)) continue;
          addShoreRock(rockMerge, mats, {
            x: sx,
            z: sz,
            size,
            seed: Math.round(g[0] * 9.1 + g[1] * 2.3) + i,
            ry,
            waterY: 0,
            colliders: this.colliders,
          });
        }
      }
      this.#spawnPines(mats);
      const treeMeshes = treeMerge.flush(this.group, 'shore-trees');
      const rockMeshes = rockMerge.flush(this.group, 'shore-rocks');
      // 树和石头都要投自己的影：树影落在水面/草坡上，石头在浅滩留一块暗斑。
      // 岸带本身已经在接收阴影，光照才有“被树挡住”的层次。
      for (const m of treeMeshes.concat(rockMeshes)) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    }
  }

  #buildIslands(mapDef) {
    const mats = getShoreMats();
    // 岛体走"岩壁 + 草顶"：不再用米色沙堆，也不在水面铺一圈沙色窄面片
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x707a66, roughness: 0.95, flatShading: true });
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x4f9e5e, roughness: 0.9, flatShading: true });
    const isleMerge = new StaticMerge();
    const decorMerge = new StaticMerge();
    // 岛缘礁石也要让开近道：湖泊近道中段贴着 (-62,-18) 那座岛的西北缘走，
    // 不加判断会有一块带碰撞的礁石正好落在走廊里（实测 (-73.5,-3.6)，r=2），
    // 抄近道时就是一次凭空撞墙。
    const clearOfShortcuts = (x, z, radius) => {
      for (const sc of mapDef.shortcuts || []) {
        const pts = sc.points || [];
        const limit = sc.width + radius + 2.5;
        for (let i = 0; i < pts.length - 1; i++) {
          const [ax, az] = pts[i];
          const [bx, bz] = pts[i + 1];
          const sx = bx - ax;
          const sz = bz - az;
          const len2 = sx * sx + sz * sz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * sx + (z - az) * sz) / len2));
          if (Math.hypot(x - (ax + sx * t), z - (az + sz * t)) < limit) return false;
        }
      }
      return true;
    };
    for (const isle of mapDef.islands) {
      const base = new THREE.CylinderGeometry(isle.r, isle.r * 1.15, isle.h, 10);
      base.translate(isle.x, isle.h / 2 - 1.2, isle.z);
      isleMerge.add(base, rockMat);
      const topY = isle.h - 0.6 + isle.h * 0.25;
      const top = new THREE.CylinderGeometry(isle.r * 0.85, isle.r, isle.h * 0.5, 10);
      top.translate(isle.x, isle.h - 0.6, isle.z);
      isleMerge.add(top, grassMat);
      // 岛脚灌木 + 芦苇：水面交接处有贴地小件，岛体不会像一根柱子插在水里
      const shoreN = 4 + Math.floor(isle.r / 5);
      for (let b = 0; b < shoreN; b++) {
        const a = this.rng() * Math.PI * 2;
        const d = isle.r * (0.9 + this.rng() * 0.16);
        const bx = isle.x + Math.cos(a) * d;
        const bz = isle.z + Math.sin(a) * d;
        if (this.rng() > 0.5) {
          addReeds(decorMerge, mats, { x: bx, z: bz, y: 0.02, s: 0.9 + this.rng() * 0.6, rng: this.rng });
        } else {
          addShoreBush(decorMerge, mats, { x: bx, z: bz, y: 0.02, s: 1.3 + this.rng() * 0.8, rng: this.rng });
        }
      }
      // 岛上三层松树：2～3 棵一簇，坡上比岸边密
      const clusters = Math.max(2, Math.floor(isle.r / 4.5));
      for (let c = 0; c < clusters; c++) {
        const a = this.rng() * Math.PI * 2;
        const d = isle.r * (0.2 + this.rng() * 0.42);
        const cx = isle.x + Math.cos(a) * d;
        const cz = isle.z + Math.sin(a) * d;
        const cluster = 2 + (this.rng() > 0.5 ? 1 : 0);
        for (let k = 0; k < cluster; k++) {
          const tx = cx + (this.rng() - 0.5) * 4.5;
          const tz = cz + (this.rng() - 0.5) * 4.5;
          if (Math.hypot(tx - isle.x, tz - isle.z) > isle.r * 0.78) continue;
          const tree = {
            x: tx, z: tz, y: topY, h: 4.2 + this.rng() * 3.2,
            w: 1.4 + this.rng() * 0.7, rng: this.rng,
          };
          this.#addTree({ ...tree, kind: this.rng() > 0.12 ? 'pine' : 'broad' });
        }
      }
      // 岛缘礁石：主石半沉水面 + 苔藓顶 + 碎石
      const rockN = 2 + (isle.r > 18 ? 1 : 0);
      for (let i = 0; i < rockN; i++) {
        const a = this.rng() * Math.PI * 2;
        const d = isle.r * (1.18 + this.rng() * 0.18);
        const size = Math.min(3.0, 1.1 + isle.r * 0.07 + this.rng() * 0.7);
        const x = isle.x + Math.cos(a) * d;
        const z = isle.z + Math.sin(a) * d;
        const ry = this.rng() * Math.PI;
        // rng 全部先摇完再判断，跳过一块礁石不会让后面的布景整体挪位
        if (!clearOfShortcuts(x, z, size)) continue;
        addShoreRock(decorMerge, mats, {
          x, z, size,
          seed: Math.round(isle.x * 5.1 + isle.z * 7.3) + i * 31,
          ry,
          colliders: this.colliders,
        });
      }
      // 岛顶靠边一块长苔藓的石头
      const ra = this.rng() * Math.PI * 2;
      addShoreRock(decorMerge, mats, {
        x: isle.x + Math.cos(ra) * isle.r * 0.55,
        z: isle.z + Math.sin(ra) * isle.r * 0.55,
        size: 1.2 + this.rng() * 0.8,
        seed: Math.round(isle.x * 3.3 + isle.z * 4.7) + 9,
        ry: this.rng() * Math.PI,
        baseY: topY - 0.1,
      });
      this.colliders.push({
        type: 'island',
        x: isle.x,
        z: isle.z,
        r: isle.r * 1.05,
        bottomY: -1.2,
        topY: isle.h,
      });
    }
    this.#spawnPines(mats);
    const isleMeshes = isleMerge.flush(this.group, 'islands');
    for (const m of isleMeshes) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
    const decorMeshes = decorMerge.flush(this.group, 'island-shore');
    // 岛上的树/礁石同样投自己的影（湖面能看见岛影扫过水面）
    for (const m of decorMeshes) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  }

  #buildRocks(mapDef) {
    const isCanyon = mapDef.id === 'canyon';
    // 湖泊 / 碧海：礁石换成暖青灰 + 苔藓顶（与岸边石头同一套材质）
    const isShoreStyle = mapDef.id === 'lake' || mapDef.id === 'ocean';
    const shoreSet = isShoreStyle ? getShoreMats() : null;
    // 怪物模式的圆形竞技场，浮岩由 BossArena 自己按 DEFAULT_ROCK_LAYOUT 建，
    // 不走这里；万一某张 boss 图也声明了 rocks，也不要换 —— 用户明确要求
    // 「怪物模式的山脊和石头不要动」。
    // 峡谷也保留手工岩块：那 9 块是带苔草顶的定制造型（buildCanyonBoulder），
    // 换成单块摄影测量礁石会丢掉草顶、九块还长一模一样；它的写实感靠贴图已经拿到了。
    const useRealBoulder = mapDef.style !== 'arena' && !isCanyon;
    // 别的海域继续用原来的褐灰礁石；峡谷换成青灰色低模岩块
    // 注意：这张材质原来是无贴图的纯灰 flatShading 平涂（近看就是一块塑料），
    // 现在换成写实岩石 PBR（真实反照率 + 法线 + 粗糙度），见 Textures.makeRockMaterial
    let rockMat = null;
    if (!isCanyon && !isShoreStyle) {
      rockMat = makeRockMaterial({ seed: 3, repeat: 1.8 });
      rockMat.color.set(0x9a9184);
    }
    this.rockSlots ||= [];
    const rockMerge = new StaticMerge();
    // 立交回旋环整圈抬成桥面后，原来按水面摆的礁石会从桥板里穿出来
    // （用户截图：上坡桥面正中嵌着一块石头）。桥面投影范围内的水岩直接不摆。
    const overpassHit = (x, z) => {
      const op = mapDef.overpass;
      if (!op || !mapDef.gates) return false;
      const N = mapDef.gates.length;
      const from = op.from;
      const span = (((op.to - from) % N) + N) % N;
      const hAt = (k) => {
        if (Array.isArray(op.profile) && op.profile[k] != null) {
          return Math.max(0, Number(op.profile[k]) || 0);
        }
        return (op.height ?? 5) * Math.sin((Math.PI * k) / span);
      };
      const reach = (mapDef.gateWidth || 8) + 3;
      for (let k = 0; k < span; k++) {
        if (hAt(k) < 0.3 && hAt(k + 1) < 0.3) continue;
        const a = mapDef.gates[(from + k) % N];
        const b = mapDef.gates[(from + k + 1) % N];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const l2 = dx * dx + dz * dz || 1;
        let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
        t = Math.max(0, Math.min(1, t));
        if (Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)) < reach) return true;
      }
      return false;
    };
    for (const rock of mapDef.rocks) {
      if (overpassHit(rock.x, rock.z)) continue;
      const verticalScale = 0.7 + this.rng() * 0.6;
      const ry = this.rng() * Math.PI;
      const radius = rock.r * 0.85;
      // 碰撞体先建好：真实礁石的实际露出高度要等模型加载完才知道（见 #spawnBoulders），
      // 那里会回写 bottomY/topY，所以这里必须持有同一个对象引用
      const collider = {
        type: 'rock',
        x: rock.x,
        z: rock.z,
        // 碰撞半径对齐可见模型：#spawnBoulders 里横向倍率是 (radius*2)/v.width，
        // 所以模型的水平半径就是 radius = rock.r*0.85。旧版写 rock.r 会多出 18% 空气墙。
        r: radius,
        bottomY: 0,
        topY: 0,
      };
      // 峡谷/岸边的手工岩块要「整块立在水面上」。
      // 旧公式 centerY = rock.r * 0.35 只把中心抬到半径的 35%：一块 7.6m 宽的石头
      // 有 1.5m 沉在水下、水面以上只剩 4.6m，再扣掉 1.6m 的暗湿带，开过去看到的
      // 就是一个半沉的石包（用户：岩石太矮、只露一点点、太丑）。
      // 现在改成「底面只吃一点点水」：centerY = halfHeight - sink，
      // 水面以上 = 2 * halfHeight - sink，整块石头都露出来。
      //
      // 竖向比例同时从 0.7~1.3 抬到 1.0~1.4：整块露出以后如果还是 0.7 的扁比，
      // 7.6m 宽只立 6.5m 高，读起来仍是"水里的一个包"。重映射用的还是**同一个**
      // rng 值（不新增 this.rng() 调用），布景保持逐块确定，不会每次进图换位置。
      // 注意：这个新比例只给手工岩块用，怪物竞技场的程序化岩块仍走 verticalScale。
      const handRocks = isCanyon || isShoreStyle;
      const handVS = 1.0 + ((verticalScale - 0.7) / 0.6) * 0.4;
      const halfHeight = radius * (handRocks ? handVS : verticalScale);
      // 吃水 = 8% 高度 + 0.35m 固定。固定那部分是给浪留的余量：
      // 波幅合计 0.28m，暴风雨 waveScale=2.4 时有 0.67m，吃水不足时
      // 浪谷会把岩块底下那条切平的边露出来。
      const sink = halfHeight * 0.08 + 0.35;
      const centerY = handRocks ? halfHeight - sink : rock.r * 0.35;
      if (useRealBoulder) {
        // 只登记，几何体在 #spawnBoulders 里用一份模型批量实例化。
        // y 先按旧的"落底面"占位，实例化时再按模型真实高度重算（见 #spawnBoulders）
        this.rockSlots.push({
          x: rock.x, y: centerY - halfHeight, z: rock.z, ry, verticalScale,
          radius, height: halfHeight * 2, collider,
        });
      } else if (isCanyon || isShoreStyle) {
        const parts = buildCanyonBoulder({
          radius,
          halfHeight,
          centerY,
          seed: Math.round(rock.x * 3.1 + rock.z * 7.7 + rock.r * 11.3),
          // 太小的礁石不长草，和参考图里水里的小石头一致
          grass: radius * verticalScale > 2.1,
        });
        if (isShoreStyle) {
          for (const key of ['rockA', 'rockB', 'grass', 'wet']) {
            if (parts[key]) rockMerge.add(parts[key], shoreSet[key], trs(rock.x, centerY, rock.z, 0, ry, 0, 1, 1, 1));
          }
        } else {
          addCanyonBoulder(rockMerge, parts, trs(rock.x, centerY, rock.z, 0, ry, 0, 1, 1, 1));
        }
      } else {
        // 不规则岩块：位置哈希噪声位移（同一位置的重复顶点取同一个值，面不会撕开）。
        // 原来是 detail=0 的十二面体，轮廓一眼就是标准几何体，配上平涂材质尤其假
        const geo = new THREE.IcosahedronGeometry(radius, 1);
        const p = geo.attributes.position;
        const seedN = rock.x * 3.1 + rock.z * 7.7;
        for (let i = 0; i < p.count; i++) {
          _bA.fromBufferAttribute(p, i);
          const s = Math.sin(_bA.x * 12.9 + _bA.y * 31.7 + _bA.z * 7.3 + seedN) * 43758.5453;
          const k = 1 + ((s - Math.floor(s)) - 0.5) * 0.34;
          p.setXYZ(i, _bA.x * k, _bA.y * k, _bA.z * k);
        }
        geo.computeVertexNormals();
        rockMerge.add(geo, rockMat, trs(rock.x, centerY, rock.z, 0, ry, 0, 1, verticalScale, 1));
      }
      // 程序化分支的视觉与碰撞都按 centerY ± halfHeight 走；
      // 真实礁石会在 #spawnBoulders 里按模型尺寸覆盖这两个值
      collider.bottomY = centerY - halfHeight;
      collider.topY = centerY + halfHeight;
      this.colliders.push(collider);
    }
    const meshes = rockMerge.flush(this.group, 'reef-rocks');
    if (this.rockSlots.length) this.#spawnBoulders();
    if (isCanyon) {
      // 只让峡谷岩块参与方向光阴影，别的海域不付这份开销
      for (const m of meshes) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    }
  }

  /** 真实岩石模型批量实例化（一份几何体铺满全场礁石位） */
  #spawnBoulders() {
    const slots = this.rockSlots;
    this.rockSlots = [];
    loadBoulderVariant().then((v) => {
      if (!v) {
        this.#buildProceduralBoulders(slots);
        return;
      }
      const im = new THREE.InstancedMesh(v.geo, v.material, slots.length);
      im.name = 'reef-boulders';
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false;
      const dummy = new THREE.Object3D();
      slots.forEach((s, i) => {
        // 横向严格贴合碰撞半径：视觉比碰撞小会变成"空气墙"，大则会穿模。
        // 纵向在横向倍率上再抬 1.6 倍：Rock 07 本身是块扁圆石（高 0.143 / 宽 0.321，
        // 高宽比只有 0.445），按同倍率放出来是一张"水里的薄饼"，读不出礁石的体量。
        // 1.6 是实测折中：6m 宽的礁石立起 4.8m，和旧版程序化岩块（2×半径）的观感对得上，
        // 再高贴图会被纵向拉花。
        const sxz = (s.radius * 2) / v.width;
        const sy = sxz * 1.6;
        // 露出水面的高度按**模型真实高度**算（旧代码用夹过 0.2 的虚高再乘 0.58，
        // 实际只露出 41%，配上薄饼体型就是"水底冒出一点点"）。
        // 现在只沉 15% + 0.36m 的固定吃水：这 0.36m 是给浪留的余量——
        // 波幅合计 0.28m，暴风雨 waveScale=2.4 时有 0.67m，
        // 吃水不足时浪谷会把模型底下那条切平的边露出来。
        const boulderH = v.height * sy;
        const baseY = -(boulderH * 0.15 + 0.36);
        dummy.position.set(s.x, baseY, s.z);
        // 碰撞体跟着视觉一起抬：只抬模型不抬碰撞会变成"能从石头中间穿过去"
        if (s.collider) {
          s.collider.bottomY = baseY;
          s.collider.topY = baseY + boulderH;
        }
        dummy.rotation.set(0, s.ry, 0);
        dummy.scale.set(sxz, sy, sxz);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      });
      im.instanceMatrix.needsUpdate = true;
      im.userData.isBoulder = true;
      this.group.add(im);
      this.boulderMeshes = [im];
    });
  }

  /** GLB 拿不到时的兜底：噪声位移的二十面体 + 写实岩石材质 */
  #buildProceduralBoulders(slots) {
    const mat = makeRockMaterial({ seed: 3, repeat: 1.8 });
    mat.color.set(0x9a9184);
    const merge = new StaticMerge();
    for (const s of slots) {
      const geo = new THREE.IcosahedronGeometry(s.radius, 1);
      const p = geo.attributes.position;
      const seedN = s.x * 3.1 + s.z * 7.7;
      for (let i = 0; i < p.count; i++) {
        _bA.fromBufferAttribute(p, i);
        const q = Math.sin(_bA.x * 12.9 + _bA.y * 31.7 + _bA.z * 7.3 + seedN) * 43758.5453;
        const k = 1 + ((q - Math.floor(q)) - 0.5) * 0.34;
        p.setXYZ(i, _bA.x * k, _bA.y * k, _bA.z * k);
      }
      geo.computeVertexNormals();
      merge.add(geo, mat, trs(s.x, s.y + s.height * 0.5, s.z, 0, s.ry, 0, 1, s.verticalScale, 1));
    }
    this.boulderMeshes = merge.flush(this.group, 'reef-rocks-fallback');
  }

  /**
   * 岩岛脚下的接触阴影：落影烘成一张俯视遮罩交给水面着色器（见 buildShoreShadowCanvas），
   * 不额外画透明贴片——水面是不透明网格，低机位下贴片的深度测试会被更近的水面整片吃掉。
   * 只烘一次，运行期代价是水面片元多一次纹理采样。
   */
  #buildShoreShadowMask() {
    const uniforms = this.water?.uniforms;
    if (!uniforms?.uShoreShadow) return;
    // 岛脚不再铺沙环，改由这张遮罩给岩岛/礁石一圈很浅的接触暗部，避免岛体像直接插在水里
    const mask = buildShoreShadowCanvas(this.colliders, 18);
    if (!mask) return;
    uniforms.uShoreShadow.value = mask.tex;
    // (minX, minZ, 1/span, 0)：着色器里 (world - min) * invSpan 得到 0~1 的 UV
    uniforms.uShoreArea.value.set(mask.minX, mask.minZ, 1 / mask.span, 0);
  }

  /**
   * 点到"主道 + 所有近道"中心线的最短距离。
   * 地形布景（岩壁 / 冰山）的净空判断统一走这里：圆心离任何一条可行驶中线
   * 不够远，就会有一半插进走廊——那种错误在截图里很难看出来，只能靠算。
   */
  #routeProbe(mapDef) {
    const gates = mapDef.gates || [];
    const N = gates.length;
    const scs = mapDef.shortcuts || [];
    const segD = (x, z, a, b) => {
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
      return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
    };
    return (x, z) => {
      let best = Infinity;
      for (let i = 0; i < N; i++) {
        const d = segD(x, z, gates[i], gates[(i + 1) % N]);
        if (d < best) best = d;
      }
      for (const sc of scs) {
        const pts = sc.points || [];
        for (let i = 0; i < pts.length - 1; i++) {
          const d = segD(x, z, pts[i], pts[i + 1]);
          if (d < best) best = d;
        }
      }
      return best;
    };
  }

  // ---------- 峡谷岩壁（冰汐海峡） ----------

  /**
   * 沿指定门区间把 cliff_segment.glb 一段段码上去。
   *
   * 三条规则：
   *   ① 同一段只放一侧（另一侧留给开阔水面，避免"隧道感"）；
   *   ② 转角超过 40° 的门额外放"一对"，把两侧岩壁夹成一道门——#5 的直角弯
   *      因此在进弯前就能看见；
   *   ③ 圆心离任何主道/近道中线不足 gateWidth+4 就跳过，绝不让岩壁捅进走廊。
   *
   * 全部走 InstancedMesh：几十段同材质岩壁只有 1 次绘制。
   */
  #buildCliffs(mapDef) {
    const cfg = mapDef.cliffs;
    const gates = mapDef.gates || [];
    const N = gates.length;
    if (!cfg || N < 4) return;
    const segs = cfg.segments || [];
    if (!segs.length) return;
    const W = mapDef.gateWidth;
    const halfThick = (cfg.thickness ?? 18) * 0.5;
    // 岩壁中心到赛道中线 = 护栏(gateWidth) + 半厚度 + 空隙 → 内立面落在护栏外 gap 米
    const lateral = W * (cfg.offset ?? 1) + halfThick + (cfg.gap ?? 3);
    const probe = this.#routeProbe(mapDef);
    const rand = mulberry32(606060);
    const spots = [];
    this.cliffSpots = spots;

    // 每个门的转角（±π，正负号表示左右折）
    const turnAt = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const p = gates[(i - 1 + N) % N], c = gates[i], n = gates[(i + 1) % N];
      const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]);
      const a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
      let d = a2 - a1;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turnAt[i] = d;
    }

    const push = (x, z, ux, uz, paired) => {
      // 60m 长的墙要按"占地"检查，不能只看中心点：两端很容易扫进相邻的走廊。
      // 阈值 W + 半厚度 = 岩壁内立面刚好贴住护栏，再留 1m。
      // 注意用"抖动后的真实走向"去查，否则 ±0.08rad 的偏转会在 26m 外带出 2m 误差。
      const rotY = Math.atan2(-uz, ux) + (rand() - 0.5) * 0.12;
      const ax = Math.cos(rotY);
      const az = -Math.sin(rotY);
      for (const d of [-26, 0, 26]) {
        if (probe(x + ax * d, z + az * d) < W + halfThick + 1) return false;
      }
      spots.push({
        x, z, rotY,
        sx: 0.95 + rand() * 0.25,
        sy: 0.9 + rand() * 0.3,
        sz: 0.92 + rand() * 0.2,
        paired,
      });
      return true;
    };

    // ② 转角：一对岩壁夹成"门"。
    //    长度方向必须取"进弯那一段"的方向——拿角平分线当长度方向的话，
    //    60m 的墙会斜着横穿整个弯道（第一版就是这样，直接堵在赛道上）。
    //    墙中心退到弯心前 30m（正好一段），远端刚好落在弯心，
    //    内侧那条因此不会伸进垂直的另一条腿。
    const cornerGates = [];
    for (const [ia, ib] of segs) {
      for (let i = ia; i <= ib; i++) {
        const gi = ((i % N) + N) % N;
        if (Math.abs(turnAt[gi]) < 0.7) continue; // < 40° 不算转角
        if (cornerGates.includes(gi)) continue;
        cornerGates.push(gi);
      }
    }
    for (const gi of cornerGates) {
      const c = gates[gi];
      const p = gates[(gi - 1 + N) % N];
      const inLen = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1;
      const ux = (c[0] - p[0]) / inLen;
      const uz = (c[1] - p[1]) / inLen;
      for (const side of [1, -1]) {
        push(c[0] - ux * 30 - uz * side * lateral, c[1] - uz * 30 + ux * side * lateral, ux, uz, true);
      }
    }

    // ① 常规：沿折线每 spacing 米一段，**只用外圈那一侧**。
    //    第一版左右交替：60m 长的墙 + 55m 间距必然首尾重叠，左右各自连成一片，
    //    两条 26m 高的岩壁把赛道夹成一条黑缝（正是方案要避免的"隧道感"）。
    //    现在按"离赛道多边形重心更远"定侧——外侧连成山体，内侧留开阔水面，
    //    只有转角处才两侧成门。
    const step = cfg.spacing ?? 55;
    let ccx = 0, ccz = 0;
    for (const g of gates) { ccx += g[0]; ccz += g[1]; }
    ccx /= N;
    ccz /= N;
    const nearCorner = (x, z) => cornerGates.some((gi) => (
      Math.hypot(x - gates[gi][0], z - gates[gi][1]) < step * 0.62
    ));
    for (const [ia, ib] of segs) {
      const pts = [];
      for (let i = ia; i <= ib; i++) pts.push(gates[((i % N) + N) % N]);
      let acc = 0;
      let next = step * 0.5;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
        while (next <= acc + len) {
          const t = (next - acc) / len;
          const x = a[0] + (b[0] - a[0]) * t;
          const z = a[1] + (b[1] - a[1]) * t;
          if (!nearCorner(x, z)) {
            const nx = -uz, nz = ux;
            const outer = ((x - ccx) * nx + (z - ccz) * nz) >= 0 ? 1 : -1;
            push(x + nx * outer * lateral, z + nz * outer * lateral, ux, uz, false);
          }
          next += step;
        }
        acc += len;
      }
    }
    if (!spots.length) return;

    loadPropModel('/models/props/cliff_segment.glb').then((gltf) => {
      if (!this.group.parent) return;
      gltf.scene.updateMatrixWorld(true);
      let geo = null;
      let mat = null;
      gltf.scene.traverse((obj) => {
        if (geo || !obj.isMesh) return;
        geo = obj.geometry.clone();
        geo.applyMatrix4(obj.matrixWorld);
        mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      });
      if (!geo || !mat) return;
      geo.computeBoundingSphere();
      // 顶点色（COLOR_0）已由 GLTFLoader 打开 vertexColors；只补一点粗糙度，
      // 免得 flat shading 的岩壁在低角度阳光下泛塑料反光
      mat.roughness = Math.max(mat.roughness ?? 0.9, 0.9);
      mat.metalness = 0;
      // 表面颗粒：复用岸边岩石那张"近白底 + 岩层/植被斑块"细节图。
      // 顶点色只管大关系（岩层/草顶/水痕），这张图负责近看有东西——
      // 只靠顶点色的话，26m 高的岩面就是一堵平滑的泥墙。
      const detail = getRockGrassTexture().clone();
      detail.wrapS = THREE.RepeatWrapping;
      detail.wrapT = THREE.RepeatWrapping;
      detail.colorSpace = THREE.SRGBColorSpace;
      detail.needsUpdate = true;
      mat.map = detail;
      mat.needsUpdate = true;
      const inst = new THREE.InstancedMesh(geo, mat, spots.length);
      inst.name = 'canyon-cliffs';
      inst.castShadow = false;
      inst.receiveShadow = false;
      inst.frustumCulled = false;
      const dummy = new THREE.Object3D();
      spots.forEach((s, i) => {
        dummy.position.set(s.x, 0, s.z);
        dummy.rotation.set(0, s.rotY, 0);
        dummy.scale.set(s.sx, s.sy, s.sz);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
      });
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
      this.cliffMesh = inst;
    }).catch((err) => console.warn('cliff_segment 加载失败', err));
  }

  // ---------- 冰山群（冰汐海峡冰区） ----------

  /**
   * 冰区内 12 座大冰山 + 26 座碎冰山。
   * 大冰山给圆形碰撞体（r ≈ 0.42×直径），碎冰山只做视觉密度、不给碰撞。
   * 摆位用拒绝采样：离主道/近道中线 ≥ gateWidth + 半径 + 4，彼此不重叠，
   * 且避开岩壁——冰区与峡谷的交界因此自然留出"从峡谷冲进冰原"的开口。
   */
  #buildIcebergs(mapDef) {
    const cfg = mapDef.icebergs;
    const ice = mapDef.iceZone;
    const gates = mapDef.gates || [];
    if (!cfg || !ice || gates.length < 4) return;
    const W = mapDef.gateWidth;
    const probe = this.#routeProbe(mapDef);
    const rand = mulberry32(246810);
    const cliffs = this.cliffSpots || [];
    const placed = [];

    const scatter = (count, baseRadius, scaleLo, scaleHi, sinkLo, sinkHi) => {
      const out = [];
      for (let i = 0; i < count; i++) {
        for (let tries = 0; tries < 300; tries++) {
          const ang = rand() * Math.PI * 2;
          const dist = ice.r * (0.12 + 0.84 * Math.sqrt(rand()));
          const x = ice.x + Math.cos(ang) * dist;
          const z = ice.z + Math.sin(ang) * dist;
          const sc = scaleLo + rand() * (scaleHi - scaleLo);
          const r = baseRadius * sc;
          if (probe(x, z) < W + r + 4) continue;
          if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < (p.r + r) * 0.88)) continue;
          if (cliffs.some((c) => Math.hypot(c.x - x, c.z - z) < r + 26)) continue;
          const spot = {
            x, z, r, sc,
            rotY: rand() * Math.PI * 2,
            y: -(sinkLo + rand() * (sinkHi - sinkLo)),
            tiltZ: (rand() - 0.5) * 0.05,
            tiltX: (rand() - 0.5) * 0.05,
          };
          placed.push(spot);
          out.push(spot);
          break;
        }
      }
      return out;
    };

    // 大冰山：视觉半径 ~17m（直径 34），纵向拉伸后再沉 5~9m，露出 ~16m
    const large = scatter(cfg.large ?? 12, 17, 0.82, 1.12, 5, 9);
    // 碎冰山：视觉半径 ~7m，露出 ~5m
    const small = scatter(cfg.small ?? 26, 7, 0.75, 1.35, 2, 4);

    for (const s of large) {
      this.colliders.push({
        type: 'iceberg',
        x: s.x,
        z: s.z,
        r: 0.42 * 34 * s.sc,
        bottomY: -18,
        topY: 16,
      });
    }

    const make = (url, list, name) => {
      if (!list.length) return;
      loadPropModel(url).then((gltf) => {
        if (!this.group.parent) return;
        gltf.scene.updateMatrixWorld(true);
        let geo = null;
        let mat = null;
        gltf.scene.traverse((obj) => {
          if (geo || !obj.isMesh) return;
          geo = obj.geometry.clone();
          geo.applyMatrix4(obj.matrixWorld);
          mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        });
        if (!geo || !mat) return;
        geo.computeBoundingSphere();
        mat.roughness = Math.min(mat.roughness ?? 0.22, 0.26);
        mat.metalness = 0;
        const inst = new THREE.InstancedMesh(geo, mat, list.length);
        inst.name = name;
        inst.castShadow = false;
        inst.receiveShadow = false;
        inst.frustumCulled = false;
        const dummy = new THREE.Object3D();
        list.forEach((s, i) => {
          dummy.position.set(s.x, s.y, s.z);
          dummy.rotation.set(s.tiltX, s.rotY, s.tiltZ);
          dummy.scale.set(s.sc, s.sc, s.sc);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        this.group.add(inst);
        if (name === 'iceberg-large') this.icebergLarge = inst;
        else this.icebergSmall = inst;
      }).catch((err) => console.warn(name + ' 加载失败', err));
    };
    make('/models/props/iceberg_large.glb', large, 'iceberg-large');
    make('/models/props/iceberg_small.glb', small, 'iceberg-small');
  }

  // ================= 深海龙宫场景 =================
  // 海床 + 潜行玻璃隧道 + 龙宫大殿 + 亚特兰蒂斯遗迹 + 水面龙门 + 光柱/气泡
  // ---------- 冰原（冰汐海峡） ----------

  /**
   * 冰壳（冰汐海峡）。
   * 冰壳是一块不透明的白色圆盘（y=0.26），覆盖区的水面已经在 Water 的
   * shader 里 discard 掉了——只剩冰壳这一层，浪头不会再从冰面上穿出来
   * 形成白/蓝交叉的"乱码"。冰面上重新铺回白色冰块障碍（坐在冰壳顶面，
   * 带碰撞），否则整张图没有任何挑战。真正的物理判定在
   * Game.#applySurface 里按 iceZone 的圆域算，判定与视觉严格同域。
   */
  #buildIceField(mapDef) {
    const ice = mapDef.iceZone;
    if (!ice) return;
    const geo = new THREE.CircleGeometry(ice.r, 96);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      map: getIceTexture(),
      // 近纯白冰壳：霓虹护栏是青蓝色（加法混合），靠明度差把"冰面"和"赛道边缘"
      // 一眼分开。以前冰壳是淡蓝白，和护栏糊成一片（见 tide-redesign-plan）
      color: 0xeff7fc,
      roughness: 0.42,
      metalness: 0,
      // 不透明：水面在冰壳下方已经 discard，半透明会透出雾色/底色，
      // 看起来像冰面破了一块
      transparent: false,
      opacity: 1,
    });
    const sheet = new THREE.Mesh(geo, mat);
    // 贴冰高度 0.26：船体压在上面，水面不会穿过冰壳
    sheet.position.set(ice.x, 0.26, ice.z);
    sheet.renderOrder = 1;
    this.group.add(sheet);
    this.iceSheet = sheet;

    // ① 白色冰块障碍：必须带碰撞，否则冰面没有任何挑战。
    // 主道中心线上不放（避免封死赛道），贴着走廊两侧左右交替摆放。
    const gates = mapDef.gates || [];
    const rand = mulberry32(918273);
    const floes = [];
    const inZone = (x, z, k = 1) => Math.hypot(x - ice.x, z - ice.z) <= ice.r * k;
    const distToRoute = (x, z) => {
      let best = Infinity;
      for (let i = 0; i < gates.length; i++) {
        const a = gates[i];
        const b = gates[(i + 1) % gates.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
        const d = Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
        if (d < best) best = d;
      }
      for (const sc of mapDef.shortcuts || []) {
        const pts = sc.points || [];
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = pts[i][0], az = pts[i][1];
          const bx = pts[i + 1][0], bz = pts[i + 1][1];
          const dx = bx - ax, dz = bz - az;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
          if (d < best) best = d;
        }
      }
      return best;
    };
    if (gates.length) {
      const iceSegments = [];
      for (let i = 0; i < gates.length; i++) {
        const a = gates[i];
        const b = gates[(i + 1) % gates.length];
        if (inZone((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) iceSegments.push(i);
      }
      iceSegments.forEach((gi, k) => {
        const a = gates[gi];
        const b = gates[(gi + 1) % gates.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len, nz = dx / len;
        for (const t of [0.34, 0.72]) {
          const side = (k + (t > 0.5 ? 1 : 0)) % 2 === 0 ? 1 : -1;
          const off = mapDef.gateWidth * 0.33 * side;
          const x = a[0] + dx * t + nx * off;
          const z = a[1] + dz * t + nz * off;
          if (!inZone(x, z, 0.98)) continue;
          floes.push({ x, z, r: 1.6 + rand() * 1.0, solid: true });
        }
      });
      // ② 冰原外围碎冰：离主道/近道 16m 之外，纯障碍感
      for (let i = 0; i < 26; i++) {
        const ang = rand() * Math.PI * 2;
        const dist = ice.r * (0.4 + rand() * 0.52);
        const x = ice.x + Math.cos(ang) * dist;
        const z = ice.z + Math.sin(ang) * dist;
        if (distToRoute(x, z) < 16) continue;
        floes.push({ x, z, r: 1.4 + rand() * 1.6, solid: true });
      }
    }

    // 冰块不能全是纯白：冰壳本身接近白色（0xeff7fc），同色块在平光下完全糊掉
    // （第一版恢复后实拍确认"看不见"）。这里用顶点色做"白顶 + 冰蓝侧壁"，
    // 侧壁在低视角下也有一圈清晰的冷色轮廓，读得出来是实体障碍。
    const floeGeo = new THREE.CylinderGeometry(1, 0.76, 0.52, 7, 1, false).toNonIndexed();
    {
      const pos = floeGeo.attributes.position;
      const nor = floeGeo.attributes.normal;
      const cols = new Float32Array(pos.count * 3);
      const cTop = new THREE.Color(0xf8fdff);
      const cSide = new THREE.Color(0x8ec9e8);
      const cBot = new THREE.Color(0x6fb0d6);
      const c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const ny = nor.getY(i);
        c.copy(ny > 0.7 ? cTop : ny < -0.7 ? cBot : cSide);
        cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
      }
      floeGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    const floeMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.3, metalness: 0.02, flatShading: true,
      // 冰壳是纯白平光，背光面没有投影时侧壁会沉成灰块；补一点冷色自发光
      // 让冰块任何角度都保持"冰"的亮度，不靠阴影也能看清轮廓
      emissive: 0x0d2a3a, emissiveIntensity: 0.55,
    });
    const dummy = new THREE.Object3D();
    if (floes.length) {
      const inst = new THREE.InstancedMesh(floeGeo, floeMat, floes.length);
      inst.castShadow = false;
      inst.receiveShadow = false;
      inst.frustumCulled = false;
      floes.forEach((f, i) => {
        const h = 2.0 + rand() * 1.0;
        // 坐在冰壳顶面（y=0.26）上，而不是悬在水面
        dummy.position.set(f.x, 0.26 + 0.26 * h, f.z);
        // 轻微倾斜让顶面/侧壁明暗分开，避免又一块"平白板"
        dummy.rotation.set((rand() - 0.5) * 0.16, rand() * Math.PI * 2, (rand() - 0.5) * 0.16);
        dummy.scale.set(f.r, h, f.r * (0.82 + rand() * 0.3));
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        if (f.solid) {
          this.colliders.push({ x: f.x, z: f.z, r: f.r * 0.82, bottomY: 0, topY: 1.4 });
        }
      });
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
      this.iceFloes = inst;
    }

    // ③ 暴风雪追加的外围浮冰：只在雪天出现，纯远景氛围，不参与判定
    const extras = [];
    for (let i = 0; i < 12; i++) {
      const ang = rand() * Math.PI * 2;
      const dist = ice.r * (1.02 + rand() * 0.22);
      extras.push({ x: ice.x + Math.cos(ang) * dist, z: ice.z + Math.sin(ang) * dist, r: 1.2 + rand() * 1.2 });
    }
    const extraInst = new THREE.InstancedMesh(floeGeo, floeMat, extras.length);
    extraInst.frustumCulled = false;
    extras.forEach((f, i) => {
      dummy.position.set(f.x, 0.5, f.z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(f.r, 0.9, f.r * 0.9);
      dummy.updateMatrix();
      extraInst.setMatrixAt(i, dummy.matrix);
    });
    extraInst.instanceMatrix.needsUpdate = true;
    extraInst.visible = false;
    this.group.add(extraInst);
    this.iceBlizzardExtra = extraInst;
  }

  // ---------- 导航灯船光带（低能见度下的主要参照物） ----------

  /**
   * 沿赛道外缘等距排布灯船浮标。
   * 16 盏 × 15 个部件如果各自成 mesh 会是 240 次 draw call，所以按材质把
   * GLB 烘成一个几何体，再用 InstancedMesh 一次画完——整套灯带只占 4 次绘制。
   */
  #buildNavBeacons(mapDef) {
    const cfg = mapDef.navBeacons;
    const gates = mapDef.gates || [];
    if (!cfg || gates.length < 4) return;
    const N = gates.length;
    const step = cfg.spacing || 100;
    const offsetMul = cfg.offset ?? 0.72;
    const pts = [];
    let acc = 0;
    let next = step * 0.55;
    for (let i = 0; i < N; i++) {
      const a = gates[i];
      const b = gates[(i + 1) % N];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const ux = (b[0] - a[0]) / len;
      const uz = (b[1] - a[1]) / len;
      const nx = -uz, nz = ux;
      while (next <= acc + len) {
        const t = (next - acc) / len;
        const side = pts.length % 2 === 0 ? 1 : -1;
        const off = mapDef.gateWidth * offsetMul * side;
        pts.push({
          x: a[0] + ux * len * t + nx * off,
          z: a[1] + uz * len * t + nz * off,
        });
        next += step;
      }
      acc += len;
    }
    if (!pts.length) return;

    loadPropModel('/models/props/nav_buoy.glb').then((gltf) => {
      if (!this.group.parent) return;
      gltf.scene.updateMatrixWorld(true);
      const byMat = new Map();
      gltf.scene.traverse((obj) => {
        if (!obj.isMesh) return;
        const geo = obj.geometry.clone();
        geo.applyMatrix4(obj.matrixWorld);
        // 合并要求属性集合一致：这批模型没有贴图，uv 直接丢掉
        for (const key of Object.keys(geo.attributes)) {
          if (key !== 'position' && key !== 'normal') geo.deleteAttribute(key);
        }
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (!mat) return;
        if (!byMat.has(mat)) byMat.set(mat, []);
        byMat.get(mat).push(geo);
      });
      const dummy = new THREE.Object3D();
      this.beaconLampMats = [];
      for (const [mat, geos] of byMat) {
        const merged = mergeGeometries(geos, false);
        if (!merged) continue;
        const inst = new THREE.InstancedMesh(merged, mat, pts.length);
        inst.castShadow = false;
        inst.receiveShadow = false;
        inst.frustumCulled = false;
        pts.forEach((p, i) => {
          dummy.position.set(p.x, 0, p.z);
          dummy.rotation.set(0, (i * 1.37) % (Math.PI * 2), 0);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          inst.setMatrixAt(i, dummy.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        this.group.add(inst);
        if (mat.emissive && mat.emissive.getHex() !== 0x000000) {
          // 灯头不吃雾：雾是给"看得见的景"用的，航标灯恰恰要在雾里穿透出来
          mat.fog = false;
          this.beaconLampMats.push({ mat, base: 3.2 });
        }
      }
      // 灯头光晕：加法混合的小球，任何角度看都是一团光，比 sprite 便宜也不用管朝向。
      // 雾天这串光点就是航线本身。
      const glowGeo = new THREE.SphereGeometry(1.45, 10, 8);
      const glowMat = new THREE.MeshBasicMaterial({
        color: 0xffb45c,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        fog: false,
        blending: THREE.AdditiveBlending,
      });
      const glow = new THREE.InstancedMesh(glowGeo, glowMat, pts.length);
      glow.frustumCulled = false;
      pts.forEach((p, i) => {
        dummy.position.set(p.x, 4.95, p.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        glow.setMatrixAt(i, dummy.matrix);
      });
      glow.instanceMatrix.needsUpdate = true;
      this.group.add(glow);
      this.beaconGlowMat = glowMat;
      if (this.weather) this.setWeather(this.weather); // 天气先到的话补一次亮度
    }).catch((err) => console.warn('nav_buoy 加载失败', err));
    this.beaconPoints = pts;
  }

  /**
   * 灯船亮度跟着能见度走：雾越厚越亮，晴天只当装饰。
   * 用 emissiveIntensity 而不是加真实点光源——16 盏点光会直接把帧率打下来。
   */
  #syncBeaconLight() {
    if (!this.beaconLampMats?.length) return;
    const fog = this.scene.fog?.density ?? 0.003;
    // 0.0022（晴）→ 0.55 倍；0.0066（暴雪）→ 1.35 倍
    const k = THREE.MathUtils.clamp(0.55 + (fog - 0.0022) * 190, 0.5, 1.4);
    for (const { mat, base } of this.beaconLampMats) {
      mat.emissiveIntensity = base * k;
    }
    if (this.beaconGlowMat) this.beaconGlowMat.opacity = 0.3 + 0.42 * k;
  }

  #buildPalace(mapDef) {
    const gates = mapDef.gates;
    const W = mapDef.gateWidth;
    const SEABED = -14;
    const rng = this.rng;
    this.palaceAnims = { beams: [], pearls: [], crystals: [], fish: [], gates: [] };

    // 材质：遗迹统一走灰褐色古旧石材 + 苔藓，不再出现红色立柱
    const goldMat = new THREE.MeshStandardMaterial({ color: 0xffd257, emissive: 0x9a6a00, emissiveIntensity: 0.6, roughness: 0.35, metalness: 0.5, flatShading: true });
    // 水面牌楼的红柱（水下立柱全部换成 stoneMat）
    const woodMat = new THREE.MeshStandardMaterial({ color: 0xa8593f, roughness: 0.8, flatShading: true });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8b8377, roughness: 0.92, flatShading: true });
    const stoneDarkMat = new THREE.MeshStandardMaterial({ color: 0x6c665c, roughness: 0.95, flatShading: true });
    const mossMat = new THREE.MeshStandardMaterial({ color: 0x5f8f52, roughness: 1.0, flatShading: true });
    const ruinMat = new THREE.MeshStandardMaterial({ color: 0x9a9386, roughness: 0.88, flatShading: true });
    const ruinMat2 = new THREE.MeshStandardMaterial({ color: 0x76716a, roughness: 0.9, flatShading: true });
    const seabedMat = new THREE.MeshStandardMaterial({ color: 0xbfa987, roughness: 1.0, flatShading: true, side: THREE.DoubleSide });
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x4d6b67, roughness: 0.95, flatShading: true });
    const coralPinkMat = new THREE.MeshStandardMaterial({ color: 0xe07a63, roughness: 0.75, flatShading: true });
    const coralTealMat = new THREE.MeshStandardMaterial({ color: 0x4fb8a8, roughness: 0.8, flatShading: true });
    const coralPurpleMat = new THREE.MeshStandardMaterial({ color: 0x8f7cc8, roughness: 0.8, flatShading: true });
    const grassMatA = new THREE.MeshStandardMaterial({ color: 0x2f8f6a, roughness: 1.0, flatShading: true, side: THREE.DoubleSide });
    const grassMatB = new THREE.MeshStandardMaterial({ color: 0x57b878, roughness: 1.0, flatShading: true, side: THREE.DoubleSide });
    const shellMat = new THREE.MeshStandardMaterial({ color: 0xf2d6b0, emissive: 0x5f3928, emissiveIntensity: 0.25, roughness: 0.65, flatShading: true });
    const fishMat = new THREE.MeshStandardMaterial({ color: 0xf08b52, emissive: 0x6a2412, emissiveIntensity: 0.35, roughness: 0.7, flatShading: true });
    const fishAltMat = new THREE.MeshStandardMaterial({ color: 0x70d7c5, emissive: 0x164f55, emissiveIntensity: 0.4, roughness: 0.6, flatShading: true });
    const pearlMat = new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xffe9b0, emissiveIntensity: 1.4, roughness: 0.2 });
    const crystalMat = new THREE.MeshStandardMaterial({ color: 0x6ff0ff, emissive: 0x2fd0e8, emissiveIntensity: 1.2, roughness: 0.2, flatShading: true });
    this.crystalMat = crystalMat;
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x66d8e8, transparent: true, opacity: 0.15, roughness: 0.1,
      metalness: 0.2, side: THREE.DoubleSide, depthWrite: false,
    });
    // 光柱贴图：纵向"上亮下暗" + 横向"中间亮两侧归零"。
    //
    // 横向那一维是后加的，但很关键：原贴图只有竖直渐变，整片 5.5m 宽的面
    // 横向是同一种颜色，于是光柱侧着看就是一块**带硬边的半透明玻璃板** ——
    // 水下抬头/远看时一眼就破功（实拍里那块贯穿全屏的青色四边形就是它）。
    // 用 ImageData 直接写二维衰减，比加顶点色省事，也保证和贴图分辨率无关。
    const beamCanvas = document.createElement('canvas');
    beamCanvas.width = 32;
    beamCanvas.height = 64;
    const beamCtx = beamCanvas.getContext('2d');
    {
      const img = beamCtx.createImageData(32, 64);
      for (let y = 0; y < 64; y++) {
        // 纵向：顶端（贴水面）最亮，往海床淡出
        const fy = Math.pow(1 - y / 63, 1.5);
        for (let x = 0; x < 32; x++) {
          // 横向：0 = 中轴、1 = 边缘；指数让两侧迅速消失
          const u = Math.abs(x / 31 - 0.5) * 2;
          const a = Math.round(255 * fy * Math.pow(1 - u, 2.2));
          const i = (y * 32 + x) * 4;
          img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = a;
        }
      }
      beamCtx.putImageData(img, 0, 0);
    }
    const beamTex = new THREE.CanvasTexture(beamCanvas);
    beamTex.colorSpace = THREE.SRGBColorSpace;
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xaee6ff, map: beamTex, transparent: true, opacity: 0.26,
      // fog 打开：远处那几道光柱要跟着水雾一起淡掉，
      // 否则它们像几块悬在蓝雾里的亮板（fog:false 时永远不变暗）
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    const edgeMarkerMat = new THREE.MeshStandardMaterial({
      color: 0x58dfff, emissive: 0x138dff, emissiveIntensity: 1.15,
      roughness: 0.28, metalness: 0.15, transparent: true, opacity: 0.92,
      depthWrite: false,
    });

    // 1) 海床：缓慢起伏的沙坡（只有一个网格，面数预算不变）
    const seabedY = (x, z) => SEABED
      + Math.sin(x * 0.031) * Math.sin(z * 0.037) * 1.1
      + Math.sin((x + z) * 0.012) * 1.5;
    const buildGroundGeo = (radius, rings, segs, lift) => {
      const pos = [0, seabedY(0, 0) + lift, 0];
      for (let ri = 1; ri <= rings; ri++) {
        const r = (ri / rings) * radius;
        for (let s = 0; s < segs; s++) {
          const a = (s / segs) * Math.PI * 2;
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          pos.push(x, seabedY(x, z) + lift, z);
        }
      }
      const idx = [];
      for (let s = 0; s < segs; s++) idx.push(0, 1 + (s + 1) % segs, 1 + s);
      for (let ri = 1; ri < rings; ri++) {
        const a0 = 1 + (ri - 1) * segs;
        const b0 = 1 + ri * segs;
        for (let s = 0; s < segs; s++) {
          const s1 = (s + 1) % segs;
          idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return geo;
    };
    const seabed = new THREE.Mesh(buildGroundGeo(600, 16, 48, 0), seabedMat);
    this.group.add(seabed);

    // 全海底铺沙色基底，贝壳按规则网格铺开，避免只在少数随机斑块出现。
    const shellGeo = new THREE.TorusGeometry(0.58, 0.14, 6, 10, Math.PI * 1.35);
    const shells = new THREE.InstancedMesh(shellGeo, shellMat, 625);
    const shellDummy = new THREE.Object3D();
    let shellIndex = 0;
    for (let gx = -288; gx <= 288; gx += 24) {
      for (let gz = -288; gz <= 288; gz += 24) {
        const d = Math.hypot(gx, gz);
        if (d > 300) continue;
        const jx = (rng() - 0.5) * 8;
        const jz = (rng() - 0.5) * 8;
        shellDummy.position.set(gx + jx, seabedY(gx + jx, gz + jz) + 0.22, gz + jz);
        shellDummy.rotation.set(-Math.PI / 2, 0, rng() * Math.PI);
        shellDummy.scale.setScalar(0.65 + rng() * 0.65);
        shellDummy.updateMatrix();
        shells.setMatrixAt(shellIndex++, shellDummy.matrix);
      }
    }
    shells.count = shellIndex;
    shells.instanceMatrix.needsUpdate = true;
    this.group.add(shells);

    // 小鱼仅参与视觉动画，不加入 Environment.colliders。
    const fishGroup = new THREE.Group();
    const fishBodyGeo = new THREE.ConeGeometry(0.65, 2.4, 6);
    const fishTailGeo = new THREE.ConeGeometry(0.48, 0.9, 5);
    let fishIndex = 0;
    // 单条鱼：沿 x 游动 + 轻微滚转；span 限定巡游区间（鱼群取群心 ±15）
    const addFish = (x, y, z, scale, span = 160) => {
      const fish = new THREE.Group();
      const body = new THREE.Mesh(fishBodyGeo, fishIndex % 3 ? fishMat : fishAltMat);
      fishIndex++;
      body.rotation.z = -Math.PI / 2;
      const tail = new THREE.Mesh(fishTailGeo, body.material);
      tail.rotation.z = Math.PI / 2;
      tail.position.x = -1.25;
      fish.add(body, tail);
      const dir = rng() > 0.5 ? 1 : -1;
      fish.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      fish.position.set(x, y, z);
      fish.scale.setScalar(scale);
      fishGroup.add(fish);
      this.palaceAnims.fish.push({
        mesh: fish, speed: (2.2 + rng() * 2.4) * dir, phase: rng() * 6,
        homeY: y, minX: x - span, maxX: x + span,
      });
    };
    // 远景零散小鱼：撑开水下空间感
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const d = 30 + rng() * 160;
      addFish(Math.cos(a) * d, -8 + rng() * 7, Math.sin(a) * d, 0.65 + rng() * 0.75);
    }
    fishGroup.visible = false;
    this.fishGroup = fishGroup;
    this.group.add(fishGroup);

    // 海床焦散光斑：水下阳光折射的网状亮纹（仅水下可见）
    this.causticsUniforms = {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0x9fe8ff) },
    };
    const caustics = new THREE.Mesh(
      buildGroundGeo(600, 16, 48, 0.2),
      new THREE.ShaderMaterial({
        uniforms: this.causticsUniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
        vertexShader: /* glsl */`
          varying vec3 vW;
          void main() {
            vW = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          uniform float uTime;
          uniform vec3 uColor;
          varying vec3 vW;
          // 经典焦散：多层相位扰动产生游动的网状亮纹
          float causticLayer(vec2 p, float t) {
            vec2 i = p;
            float c = 1.0;
            const float inten = 0.005;
            for (int n = 0; n < 4; n++) {
              float tt = t * (1.0 - (3.5 / float(n + 1)));
              i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
              c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
            }
            c /= 4.0;
            c = 1.17 - pow(c, 1.4);
            return pow(abs(c), 8.0);
          }
          void main() {
            vec2 p = vW.xz * 0.055;
            float v = causticLayer(p, uTime * 0.55);
            gl_FragColor = vec4(uColor * v, v * 0.85);
          }
        `,
      }),
    );
    caustics.renderOrder = 3;
    caustics.visible = false;
    this.caustics = caustics;
    this.group.add(caustics);
    // 海床散石：大块礁石半埋沙中（顶部带苔藓）+ 周围碎石，全部合批
    const seabedRockMerge = new StaticMerge();
    const shoreSet = getShoreMats();
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2;
      const d = 70 + rng() * 190;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const size = 3.2 + rng() * 3.4;
      const gy = seabedY(x, z);
      const cy = gy + size * 0.18;
      const parts = buildCanyonBoulder({
        radius: size, halfHeight: size * 0.8, centerY: cy,
        seed: Math.round(x * 5.3 + z * 8.1) + 400,
        waterY: gy, grass: true,
      });
      for (const key of ['rockA', 'rockB', 'grass', 'wet']) {
        if (parts[key]) {
          seabedRockMerge.add(parts[key], shoreSet[key], trs(x, cy, z, 0, rng() * Math.PI, 0, 1, 1, 1));
        }
      }
    }
    for (let i = 0; i < 22; i++) {
      const a = rng() * Math.PI * 2;
      const d = 80 + rng() * 200;
      const r = 1.2 + rng() * 3;
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      seabedRockMerge.add(
        new THREE.DodecahedronGeometry(r, 0),
        rng() > 0.5 ? ruinMat2 : rockMat,
        trs(x, seabedY(x, z) + r * 0.3, z, 0, rng() * Math.PI, 0, 1, 0.8, 1),
      );
    }
    seabedRockMerge.flush(this.group, 'palace-seabed-rocks');

    // 潜行区折线采样（含端部斜坡深度剖面，与 Track.diveHeightAt 一致）
    const sampleDive = (pts, depth, step = 7) => {
      const lens = [];
      let total = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        lens.push(l); total += l;
      }
      const n = Math.max(8, Math.round(total / step));
      const out = [];
      for (let k = 0; k <= n; k++) {
        const dist = (k / n) * total;
        let acc = 0, si = lens.length - 1, st = 1;
        for (let i = 0; i < lens.length; i++) {
          if (dist <= acc + lens[i]) { si = i; st = (dist - acc) / (lens[i] || 1); break; }
          acc += lens[i];
        }
        const u = k / n;
        const ramp = Math.min(1, Math.min(u, 1 - u) / 0.22);
        const s = ramp * ramp * (3 - 2 * ramp);
        const ax = pts[si][0], az = pts[si][1];
        const bx = pts[si + 1][0], bz = pts[si + 1][1];
        out.push(new THREE.Vector3(ax + (bx - ax) * st, depth * s, az + (bz - az) * st));
      }
      return out;
    };

    // 2) 每段潜行区：玻璃隧道 + 金色环肋 + 柱廊 + 光柱 + 海床水晶 + 入口珊瑚门
    // 入口/出口原来是"裸石柱 + 半圆环 + 八面体宝石"的程序化几何（用户点名的图2红框），
    // 现在只在两侧记录位置，统一换成带贴图的珊瑚礁 GLB（#loadPalaceProps 加载）。
    this.palaceArchSpots = [];
    const diveArch = (p, dirTo, R) => {
      // dirTo 是"沿赛道的两采样点差"，长度约 14m；必须归一化，否则 lateral 偏移
      // 会被乘成一百多米，珊瑚门柱直接飞到赛道外面（原石拱也是这个隐藏 bug）。
      const dl = Math.hypot(dirTo.x, dirTo.z) || 1;
      const ux = dirTo.x / dl;
      const uz = dirTo.z / dl;
      const yaw = Math.atan2(ux, uz);
      const archR = R * 0.52 + 3.2;
      for (const side of [-1, 1]) {
        const px = -uz * archR * side;
        const pz = ux * archR * side;
        this.palaceArchSpots.push({
          x: p.x + px, z: p.z + pz, y: -2.6,
          width: 6.4 + rng() * 1.6,
          ry: yaw + side * 0.5 + rng() * 0.4,
        });
      }
    };

    // 低模珊瑚簇 / 成束海草：沿潜行区两侧摆，气泡从这里冒出来
    const reefMerge = new StaticMerge();
    // 柱廊 / 碎石这类硬质结构单独合批：数量翻倍后不再增加 draw call
    const structMerge = new StaticMerge();
    // mergeGeometries 要求整桶的索引属性一致：圆柱/圆环带 index、多面体不带，
    // 统一转成非索引再进桶，否则整桶合并失败（柱廊直接不显示）
    const addStruct = (geo, mat, matrix) => {
      const g = geo.index ? geo.toNonIndexed() : geo;
      if (g !== geo) geo.dispose();
      structMerge.add(g, mat, matrix);
    };
    const coralMats = [coralPinkMat, coralTealMat, coralPurpleMat];
    const addCoralCluster = (x, z, y, s) => {
      reefMerge.add(
        new THREE.DodecahedronGeometry(0.85 * s, 0), rockMat,
        trs(x, y + 0.18 * s, z, 0, rng() * 3, 0, 1, 0.7, 1),
      );
      const mat = coralMats[Math.floor(rng() * coralMats.length)];
      const branches = 5 + Math.floor(rng() * 3);
      for (let b = 0; b < branches; b++) {
        const len = (0.9 + rng() * 1.3) * s;
        const geo = new THREE.ConeGeometry((0.15 + rng() * 0.1) * s, len, 5);
        geo.translate(0, len / 2, 0);
        geo.rotateZ(0.22 + rng() * 0.55);
        geo.rotateY(rng() * Math.PI * 2);
        geo.translate(x + (rng() - 0.5) * 0.7 * s, y, z + (rng() - 0.5) * 0.7 * s);
        reefMerge.add(geo, mat);
      }
    };
    const addSeagrass = (x, z, y, s) => {
      for (let b = 0; b < 6; b++) {
        const len = (1.3 + rng() * 1.7) * s;
        const geo = new THREE.ConeGeometry(0.09 * s, len, 4);
        geo.translate(0, len / 2, 0);
        geo.rotateZ(0.1 + rng() * 0.34);
        geo.rotateY(rng() * Math.PI * 2);
        geo.translate(x + (rng() - 0.5) * 1.3 * s, y, z + (rng() - 0.5) * 1.3 * s);
        reefMerge.add(geo, rng() > 0.5 ? grassMatA : grassMatB);
      }
    };
    const ventSpots = [];

    for (const d of mapDef.dives) {
      const pts = gates.slice(d.from, d.to + 1);
      const samples = sampleDive(pts, d.depth);

      // 玻璃隧道
      const curve = new THREE.CatmullRomCurve3(samples);
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(48, samples.length * 2), W * 0.76, 12, false),
        glassMat,
      );
      tube.renderOrder = 2;
      this.group.add(tube);

      // 环肋：古旧石环（比金环更贴合遗迹基调），偶发苔藓斑块
      for (let i = 1; i < samples.length; i += 4) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(W * 0.76, 0.32, 8, 20), stoneMat);
        ring.position.copy(samples[i]);
        ring.lookAt(samples[Math.min(i + 1, samples.length - 1)]);
        this.group.add(ring);
        if (i % 8 === 1) {
          const mossRing = new THREE.Mesh(new THREE.TorusGeometry(W * 0.76, 0.36, 8, 20, Math.PI * 0.7), mossMat);
          mossRing.position.copy(ring.position);
          mossRing.quaternion.copy(ring.quaternion);
          this.group.add(mossRing);
        }
      }

      // 两侧柱廊：灰褐色古旧石柱，有的断口、有的倾斜，柱脚长苔藓
      // 柱子间距从 3 个采样点缩到 2 个，柱身加粗，断柱脚下补碎石与倒塌柱段
      for (let i = 2; i < samples.length - 2; i += 2) {
        const p = samples[i];
        const nxt = samples[i + 1];
        const dirX = nxt.x - p.x, dirZ = nxt.z - p.z;
        const len = Math.hypot(dirX, dirZ) || 1;
        const nx = -dirZ / len, nz = dirX / len;
        for (const side of [-1, 1]) {
          const x = p.x + nx * (W + 6) * side;
          const z = p.z + nz * (W + 6) * side;
          const gy = seabedY(x, z);
          // 柱顶必须留在水下：p.y 在潜行区两端抬到 0，原来 +4 会让柱子从水面
          // 直接戳出来（图2里那根光秃秃的棕色圆柱）。压到水面下 1.2m。
          const topY = Math.min(p.y + 4, -1.2);
          const fullH = topY - gy;
          if (fullH < 2) continue;
          const broken = rng() > 0.62;
          const h = broken ? fullH * (0.36 + rng() * 0.34) : fullH;
          const tilt = broken ? (rng() - 0.5) * 0.16 : (rng() - 0.5) * 0.05;
          addStruct(
            new THREE.CylinderGeometry(broken ? 0.8 : 1.15, 1.55, h, 8),
            stoneMat,
            trs(x, gy + h / 2, z, 0, rng() * Math.PI, tilt),
          );
          // 柱脚苔藓圈
          const mossH = Math.min(2.6, h * 0.28);
          addStruct(
            new THREE.CylinderGeometry(1.58, 1.66, mossH, 8),
            mossMat,
            trs(x, gy + mossH / 2 + 0.05, z, 0, rng() * Math.PI, tilt),
          );
          if (broken) {
            // 断柱脚边散落柱段碎块，断口才不像凭空截断
            const n = 1 + (rng() > 0.45 ? 1 : 0);
            for (let rb = 0; rb < n; rb++) {
              const rr = 0.55 + rng() * 0.75;
              addStruct(
                new THREE.DodecahedronGeometry(rr, 0),
                rng() > 0.5 ? stoneDarkMat : stoneMat,
                trs(
                  x + (rng() - 0.5) * 3, gy + rr * 0.55, z + (rng() - 0.5) * 3,
                  0, rng() * Math.PI, 0, 1, 0.72, 1,
                ),
              );
            }
            // 倒下的柱段横躺
            const fallenGeo = new THREE.CylinderGeometry(0.72, 0.8, 2.6 + rng() * 2.6, 8);
            addStruct(
              fallenGeo,
              stoneMat,
              trs(
                x + (rng() - 0.5) * 4.4, gy + 0.7, z + (rng() - 0.5) * 4.4,
                0, rng() * Math.PI, Math.PI / 2,
              ),
            );
          } else {
            const cap = new THREE.TorusGeometry(0.98, 0.14, 6, 14, Math.PI * 1.35);
            addStruct(
              cap,
              edgeMarkerMat,
              trs(
                x, topY + 0.7, z,
                -Math.PI / 2, Math.atan2(dirX, dirZ) + (side < 0 ? Math.PI : 0), 0,
              ),
            );
          }
        }
      }

      // 光柱：交叉双面片，从水面斜射进水里；沿潜行段均布，避免堆在一处
      // 顶端贴水面、下半截沉到海床以下被深度剔除，只在水中留一道淡青蓝光
      const beamGeo = new THREE.PlaneGeometry(5.5, 24);
      for (let k = 0; k < 6; k++) {
        const si = Math.min(samples.length - 1, Math.floor(((k + 0.5) / 6) * samples.length));
        const p = samples[si];
        const a = rng() * Math.PI * 2;
        const off = W + 4 + rng() * 26;
        const bx = p.x + Math.cos(a) * off;
        const bz = p.z + Math.sin(a) * off;
        const tilt = (rng() - 0.5) * 0.3;
        for (let c = 0; c < 2; c++) {
          const beam = new THREE.Mesh(beamGeo, beamMat.clone());
          beam.position.set(bx, -12.2, bz);
          beam.rotation.y = c * Math.PI / 2 + rng() * 0.25;
          beam.rotation.z = tilt;
          beam.renderOrder = 4;
          this.group.add(beam);
          this.palaceAnims.beams.push({ mesh: beam, phase: rng() * 6, baseZ: tilt });
        }
      }

      // 海床发光水晶
      for (let k = 0; k < 6; k++) {
        const p = samples[Math.floor(rng() * samples.length)];
        const a = rng() * Math.PI * 2;
        const off = W + 4 + rng() * 14;
        const sc = 0.8 + rng() * 1.4;
        const x = p.x + Math.cos(a) * off;
        const z = p.z + Math.sin(a) * off;
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(sc), crystalMat);
        crystal.position.set(x, seabedY(x, z) + sc * 0.8, z);
        this.group.add(crystal);
        this.palaceAnims.crystals.push(crystal);
      }

      // 两侧珊瑚簇 + 海草，记录气泡涌出口（离赛道更近、尺度更大，坐艇上能看清）
      // 沿潜行段均分采样点，保证每一段两侧都有珊瑚，不会全挤在一处
      const coralN = 12;
      for (let k = 0; k < coralN; k++) {
        const ci = Math.min(samples.length - 2, 1 + Math.floor((k * (samples.length - 2)) / coralN));
        const p = samples[ci];
        const q = samples[Math.min(ci + 1, samples.length - 1)];
        const dx = q.x - p.x, dz = q.z - p.z;
        const l = Math.hypot(dx, dz) || 1;
        const ox = -dz / l, oz = dx / l;
        const side = k % 2 ? 1 : -1;
        // 珊瑚带压在隧道边缘与柱廊之间（14.5~18.5m），贴着航道才看得见
        const off = W + 2.5 + rng() * 4;
        const x = p.x + ox * off * side;
        const z = p.z + oz * off * side;
        const y = seabedY(x, z);
        const cs = 1.4 + rng() * 1.0;
        addCoralCluster(x, z, y, cs);
        // 两簇里挑一簇当气泡喷口，避免满屏气泡
        if (k % 3 === 1) ventSpots.push([x, y + 0.5, z]);
        if (k % 2 === 0) {
          const gx = x + ox * side * (2.2 + rng() * 1.4);
          const gz = z + oz * side * (2.2 + rng() * 1.4);
          addSeagrass(gx, gz, seabedY(gx, gz), 1.0 + rng() * 0.45);
        }
      }

      // 小鱼群：沿潜行段中部放一小群几何小鱼，围着群心打转
      {
        const mid = samples[Math.floor(samples.length * (0.35 + rng() * 0.3))];
        const schoolY = Math.max(seabedY(mid.x, mid.z) + 3.4, -10);
        for (let k = 0; k < 9; k++) {
          addFish(
            mid.x + (rng() - 0.5) * 14,
            schoolY + (rng() - 0.5) * 2.4,
            mid.z + (rng() - 0.5) * 14,
            0.6 + rng() * 0.5,
            15,
          );
        }
      }

      // 入口/出口石拱门
      const first = samples[0], second = samples[2] || samples[1];
      const last = samples[samples.length - 1], prev = samples[samples.length - 3] || samples[samples.length - 2];
      diveArch(first, { x: second.x - first.x, z: second.z - first.z }, W + 1.5);
      diveArch(last, { x: last.x - prev.x, z: last.z - prev.z }, W + 1.5);
    }
    reefMerge.flush(this.group, 'palace-reef');
    structMerge.flush(this.group, 'palace-colonnade');

    // 3) 右侧积木建筑 → 半塌石遗迹：残墙分段不等高、断柱、横躺柱段、散落石块
    const pagoda = (scale) => {
      const g = new THREE.Group();
      const aisle = Math.min(18, Math.max(12, W * 1.18));
      // 半埋沙中的基座
      const base = new THREE.Mesh(new THREE.BoxGeometry(46, 2.6, 44), stoneDarkMat);
      base.position.y = 1.3;
      g.add(base);
      for (const side of [-1, 1]) {
        // 两侧残墙：中间留缺口，高度参差
        for (let seg = 0; seg < 5; seg++) {
          if (seg === 2) continue; // 缺口
          const segH = 3 + ((seg * 7 + (side > 0 ? 3 : 0)) % 5) * 1.5;
          const wall = new THREE.Mesh(new THREE.BoxGeometry(3.4, segH, 8.4), seg % 3 === 0 ? stoneDarkMat : stoneMat);
          wall.position.set(side * 18, 2.6 + segH / 2, -18 + seg * 9);
          wall.rotation.z = side * ((seg + 1) % 4) * 0.04;
          g.add(wall);
          const moss = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.7, 4.6), mossMat);
          moss.position.set(side * 18, 2.95, -18 + seg * 9);
          g.add(moss);
        }
        // 两排歪斜的断柱
        for (let c = 0; c < 3; c++) {
          const h = 5 + ((c + (side > 0 ? 2 : 0)) % 3) * 3.4;
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.3, h, 8), stoneMat);
          col.position.set(side * (aisle * 0.5 + 5.6), 2.6 + h / 2, -12 + c * 12);
          col.rotation.z = (rng() - 0.5) * 0.2;
          col.rotation.y = rng() * Math.PI;
          g.add(col);
          const moss = new THREE.Mesh(new THREE.CylinderGeometry(1.14, 1.2, Math.min(2.4, h * 0.3), 8), mossMat);
          moss.position.set(side * (aisle * 0.5 + 5.6), 2.6 + Math.min(2.4, h * 0.3) / 2, -12 + c * 12);
          g.add(moss);
        }
      }
      // 中央残殿：只剩一截矮墙 + 祭坛石
      const inner = new THREE.Mesh(new THREE.BoxGeometry(10, 4.5, 12), stoneDarkMat);
      inner.position.y = 4.6;
      g.add(inner);
      const altar = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.4, 2.2, 8), stoneMat);
      altar.position.y = 5.6;
      g.add(altar);
      // 倒塌的柱段横躺在地上
      const fallen = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.15, 9, 8), stoneMat);
      fallen.rotation.z = Math.PI / 2;
      fallen.position.set(20, 3.4, 6);
      g.add(fallen);
      // 散落石块
      for (let i = 0; i < 6; i++) {
        const s = 0.9 + (i % 3) * 0.5;
        const block = new THREE.Mesh(new THREE.BoxGeometry(s * 2, s, s * 1.6), stoneDarkMat);
        block.position.set(-24 + i * 9, 2.6 + s / 2, 22 - (i % 2) * 5);
        block.rotation.y = i * 0.7;
        g.add(block);
      }
      g.scale.setScalar(scale);
      return g;
    };
    const mainPalace = pagoda(0.9);
    mainPalace.position.set(102, SEABED, 150);
    mainPalace.visible = false;
    this.group.add(mainPalace);

    // Open-water palace atrium: an explicit readable structure around the
    // racing lane. It replaces the source GLB's opaque floor/wall silhouette.
    // Place the palace after the descent ramp, where the chase camera is fully
    // underwater and has enough approach distance to read the whole structure.
    const p0 = gates[3], p1 = gates[4];
    const pfx = p1[0] - p0[0], pfz = p1[1] - p0[1];
    const plen = Math.hypot(pfx, pfz) || 1;
    const atrium = new THREE.Group();
    atrium.position.set((p0[0] + p1[0]) * 0.5, SEABED, (p0[1] + p1[1]) * 0.5);
    atrium.rotation.y = Math.atan2(pfx / plen, pfz / plen);
    // The authored coral palace GLB is the authoritative main hall now. The
    // procedural pagoda is a half-collapsed ruin and reads as scattered debris
    // at the centre of the lane, so keep it out of the race view.
    mainPalace.visible = false;
    // Keep the entrance readable: the previous three-beam atrium could fill
    // the viewport and make the corridor look blocked from close range.
    const atriumSide = W + 3.5;
    const palaceAisle = Math.min(18, Math.max(12, W * 1.18));
    const addPortal = (z, side, height, radius) => {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.15, height, 10), stoneMat);
      pillar.position.set(side, height * 0.5, z);
      atrium.add(pillar);
      const cap = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.95, 0.12, 6, 14, Math.PI * 1.35), edgeMarkerMat);
      cap.position.set(side, height + 0.5, z);
      cap.rotation.x = -Math.PI / 2;
      atrium.add(cap);
    };
    addPortal(0, -atriumSide, 10, 0.85);
    addPortal(0, atriumSide, 10, 0.85);
    const entryBeam = new THREE.Mesh(new THREE.BoxGeometry(atriumSide * 2 + 2, 0.8, 0.8), goldMat);
    entryBeam.position.set(0, 10.3, 0);
    atrium.add(entryBeam);

    // The compact hall is deliberately behind the portal so it reads as a
    // landmark without becoming a solid wall in the driving line.
    const hallZ = 18;
    const hallSide = atriumSide - 1.5;
    addPortal(hallZ, -hallSide, 9, 0.7);
    addPortal(hallZ, hallSide, 9, 0.7);
    const hallBeam = new THREE.Mesh(new THREE.BoxGeometry(hallSide * 2 + 1, 0.65, 0.7), goldMat);
    hallBeam.position.set(0, 9.4, hallZ);
    atrium.add(hallBeam);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(hallSide + 2, 3.2, 4), goldMat);
    roof.rotation.y = Math.PI / 4;
    roof.position.set(0, 11.2, hallZ);
    atrium.add(roof);
    this.group.add(atrium);
    this.palaceAtrium = atrium;
    // Deterministic seabed ruins around (never inside) the racing corridor.
    const ruins = new THREE.Group();
    ruins.position.copy(atrium.position);
    ruins.rotation.y = atrium.rotation.y;
    for (let i = 0; i < 10; i++) {
      const side = i % 2 ? 1 : -1;
      const along = -24 + (i * 11) % 54;
      const lateral = atriumSide + 5 + (i % 3) * 2.5;
      const h = 2.2 + (i % 4) * 1.4;
      const piece = i % 3 === 0
        ? new THREE.Mesh(new THREE.BoxGeometry(3.8 + (i % 2), h * 0.55, 1.4), ruinMat2)
        : new THREE.Mesh(new THREE.CylinderGeometry(0.55 + (i % 2) * 0.2, 0.8, h, 7), ruinMat);
      piece.position.set(side * lateral, h * 0.5, along);
      piece.rotation.y = (i * 0.73) % (Math.PI * 2);
      piece.rotation.z = (i % 3 === 0 ? -0.12 : 0.06) * side;
      piece.castShadow = false;
      piece.receiveShadow = false;
      ruins.add(piece);
    }
    this.group.add(ruins);
    this.palaceRuins = ruins;
    // Explicit side volumes keep boats in the central aisle and rebound them
    // gently instead of allowing them to tunnel through palace scenery.
    const sideX = -pfz / plen;
    const sideZ = pfx / plen;
    const wallLateral = atriumSide - 0.35;
    for (let i = 0; i < 11; i++) {
      const along = -24 + i * 6;
      for (const side of [-1, 1]) {
        this.colliders.push({
          // Match the actual portal/hall wall line instead of placing the
          // collider on the outer scenery edge. This removes the inner-side
          // gap that allowed boats to slip through the right wall.
          x: atrium.position.x + sideX * wallLateral + (pfx / plen) * along,
          z: atrium.position.z + sideZ * wallLateral + (pfz / plen) * along,
          r: 3.2,
        });
      }
    }
    // Inner hall wings sit much closer to the aisle than the outer portal
    // pillars. Add a second collision line at the actual red-wall edge; this
    // is especially important when a boat hugs the right wall from inside.
    const innerLateral = palaceAisle * 0.5 + Math.max(1.2, (24 - palaceAisle) * 0.5) * 0.5;
    const innerWallLateral = innerLateral * 0.9;
    const innerWallRadius = 1.35;
    const hallCenterAlong = 7;
    const hallHalfLength = 12 * 0.9;
    const innerStart = hallCenterAlong - hallHalfLength;
    const innerStep = 2.2;
    for (let i = 0; i < 11; i++) {
      const along = innerStart + Math.min(i * innerStep, hallHalfLength * 2);
      for (const side of [-1, 1]) {
        this.colliders.push({
          x: atrium.position.x + sideX * innerWallLateral + (pfx / plen) * along,
          z: atrium.position.z + sideZ * innerWallLateral + (pfz / plen) * along,
          r: innerWallRadius,
        });
      }
    }
    const sidePalace = pagoda(0.75);
    sidePalace.position.set(44, SEABED, 160);
    sidePalace.rotation.y = 0.5;
    sidePalace.visible = false;
    this.group.add(sidePalace);

    // 龙宫宝珠（漂浮发光珠）
    for (let i = 0; i < 5; i++) {
      const a = rng() * Math.PI * 2;
      const r = 26 + rng() * 16;
      const pearl = new THREE.Mesh(new THREE.OctahedronGeometry(1.0 + rng() * 0.5), pearlMat);
      const baseY = -6 + rng() * 8;
      pearl.position.set(atrium.position.x + Math.cos(a) * r, baseY, atrium.position.z + Math.sin(a) * r);
      this.group.add(pearl);
      this.palaceAnims.pearls.push({ mesh: pearl, baseY, phase: rng() * 6 });
    }

    // 4) 亚特兰蒂斯遗迹（环形石柱殿 + 中央水晶祭坛）
    const temple = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(22, 24, 2.5, 12), ruinMat2);
    floor.position.y = 1.25;
    temple.add(floor);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const broken = rng() > 0.65;
      const h = broken ? 4 + rng() * 6 : 13;
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, h, 8), broken ? ruinMat2 : ruinMat);
      col.position.set(Math.cos(a) * 16, 2.5 + h / 2, Math.sin(a) * 16);
      temple.add(col);
      if (!broken) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.1, 3.2), ruinMat);
        cap.position.set(Math.cos(a) * 16, 2.5 + h + 0.55, Math.sin(a) * 16);
        temple.add(cap);
      }
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(16, 0.9, 8, 24), ruinMat);
    ring.position.y = 17;
    ring.rotation.x = Math.PI / 2;
    temple.add(ring);
    const altar = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 4.5, 3, 8), ruinMat);
    altar.position.y = 4;
    temple.add(altar);
    const heart = new THREE.Mesh(new THREE.OctahedronGeometry(3), crystalMat);
    heart.position.y = 9.5;
    temple.add(heart);
    this.palaceAnims.crystals.push(heart);
    temple.position.set(-90, SEABED, -75);
    this.group.add(temple);

    // 守卫巨像（方块基座 + 圆柱身体 + 球头 + 锥顶）就是图2里那个"棋子"造型。
    // 整组换成带贴图的珊瑚巨礁 + 周边碎石堆（#loadPalaceProps 统一加载），
    // 位置不动，仍然守着遗迹外圈。
    this.palaceCoralSpots = this.palaceCoralSpots || [];
    this.palaceBoulderSpots = this.palaceBoulderSpots || [];
    const giantReef = (x, z) => {
      this.palaceCoralSpots.push({
        x, z, y: SEABED, width: 20 + rng() * 4, ry: rng() * Math.PI * 2,
      });
      for (let i = 0; i < 3; i++) {
        const a = rng() * Math.PI * 2;
        const d = 9 + rng() * 8;
        const bx = x + Math.cos(a) * d;
        const bz = z + Math.sin(a) * d;
        this.palaceBoulderSpots.push({
          x: bx, z: bz, y: seabedY(bx, bz) - 0.6,
          width: 7 + rng() * 6, ry: rng() * Math.PI * 2,
        });
      }
    };
    giantReef(-114, -69);
    // 第二个巨像原来立在 (-161,-106)，正好挡在新加的白色欧式宫殿（-178,-110）正前方 ——
    // 从 A→B 走廊看过去，宫殿被它挡掉一大半。挪到遗迹外侧，仍然守着那片遗迹。
    giantReef(-203, -62);

    // 5) 水面龙门（红柱 + 金顶中式牌楼）@ 水面段赛道门
    const dragonArch = (i) => {
      const g = gates[i];
      const n = gates[(i + 1) % gates.length];
      const dx = n[0] - g[0], dz = n[1] - g[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const R = W + 3;
      const arch = new THREE.Group();
      for (const side of [-1, 1]) {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 11, 8), woodMat);
        pillar.position.set(nx * R * side, 5.5, nz * R * side);
        arch.add(pillar);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(R * 2 + 2, 1.3, 1.5), goldMat);
      beam.position.y = 11;
      arch.add(beam);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(R * 0.6, 4, 4), goldMat);
      roof.position.y = 13.5;
      roof.rotation.y = Math.PI / 4;
      arch.add(roof);
      const pearl = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.11, 6, 14, Math.PI * 1.35), edgeMarkerMat);
      pearl.position.y = 16;
      pearl.rotation.x = -Math.PI / 2;
      arch.add(pearl);
      arch.position.set(g[0], 0, g[1]);
      arch.rotation.y = Math.atan2(dx, dz);
      this.group.add(arch);
    };
    dragonArch(7);
    dragonArch(13);
    dragonArch(16);

    // 6) 分层气泡：
    //    大泡（少、升得快、贴着视野随着漂）／小泡（多、升得慢、更散）
    //    再加一组从珊瑚与遗迹缝隙里冒出的定位气泡
    const bcanvas = document.createElement('canvas');
    bcanvas.width = 32; bcanvas.height = 32;
    const bctx = bcanvas.getContext('2d');
    const bgrad = bctx.createRadialGradient(12, 12, 2, 16, 16, 15);
    bgrad.addColorStop(0, 'rgba(235,252,255,0.95)');
    bgrad.addColorStop(0.45, 'rgba(190,235,250,0.55)');
    bgrad.addColorStop(0.82, 'rgba(170,225,245,0.22)');
    bgrad.addColorStop(1, 'rgba(170,225,245,0)');
    bctx.fillStyle = bgrad;
    bctx.fillRect(0, 0, 32, 32);
    const bubbleTex = new THREE.CanvasTexture(bcanvas);

    const makeBubbles = (count, size, opacity, spread, yMin, yMax, riseMin, riseMax) => {
      const pos = new Float32Array(count * 3);
      const rise = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = (rng() - 0.5) * spread;
        pos[i * 3 + 1] = yMin + rng() * (yMax - yMin);
        pos[i * 3 + 2] = (rng() - 0.5) * spread;
        rise[i] = riseMin + rng() * (riseMax - riseMin);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const points = new THREE.Points(geo, new THREE.PointsMaterial({
        map: bubbleTex, size, transparent: true, opacity,
        depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      }));
      points.frustumCulled = false;
      points.visible = false;
      points.userData.rise = rise;
      points.userData.spread = spread;
      this.scene.add(points);
      return points;
    };
    // 大泡：视野跟随，数量少
    this.bubbles = makeBubbles(80, 1.05, 0.8, 80, -18, 8, 3.0, 5.0);
    // 小泡：更多更慢，营造远近层次
    this.bubblesSmall = makeBubbles(220, 0.34, 0.55, 96, -22, 12, 0.9, 1.7);

    // 缝隙气泡：世界坐标固定，从珊瑚/遗迹脚边升起
    const ventPos = [];
    for (const spot of ventSpots) ventPos.push(spot);
    for (const spot of ventSpots) {
      ventPos.push([spot[0] + (rng() - 0.5) * 2.4, spot[1], spot[2] + (rng() - 0.5) * 2.4]);
    }
    const ventGeo = new THREE.BufferGeometry();
    const varr = new Float32Array(ventPos.length * 3);
    ventPos.forEach((p, i) => {
      varr[i * 3] = p[0];
      varr[i * 3 + 1] = p[1];
      varr[i * 3 + 2] = p[2];
    });
    ventGeo.setAttribute('position', new THREE.BufferAttribute(varr, 3));
    this.ventBubbles = new THREE.Points(ventGeo, new THREE.PointsMaterial({
      map: bubbleTex, size: 0.62, transparent: true, opacity: 0.7,
      depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    }));
    this.ventBubbles.frustumCulled = false;
    this.ventBubbles.visible = false;
    this.ventBubbles.userData.base = varr.slice();
    this.scene.add(this.ventBubbles);

    // 水下生态（水母 / 鲸鲨 / 鲨鱼 / 沉船 / 火山 / 石桥 / 发光巨蚌 / 海藻 /
    // 彩色珊瑚 / 热带鱼群）。独立成模块是为了不再往这个 850 行的建场函数里堆代码；
    // 纯装饰，一律不进 colliders（用户：能穿过去也行，当装饰也行）。
    this.palaceLife = buildPalaceUndersea({
      group: this.group,
      rng,
      seabedY,
      gateWidth: W,
    });
  }

  // ================= GLB 精模布景（东海龙宫） =================
  // 龙柱大门 / 珊瑚宫殿 / 沉船残骸 / 珊瑚礁群：运行时测包围盒归一化到目标尺寸
  #loadPalaceProps(mapDef) {
    const loader = new GLTFLoader();
    const gates = mapDef.gates;
    const SEABED = -14;
    const rng = mulberry32(24681357); // 布景专用随机流（与场景其他部分独立）

    // 龙柱大门 @ 第一段潜行区出口 → 弹射坡之间（出水后穿门腾空）
    const g2 = gates[2], g3 = gates[3];
    const dgx = g3[0] - g2[0], dgz = g3[1] - g2[1];
    const dl = Math.hypot(dgx, dgz) || 1;
    const ux = dgx / dl, uz = dgz / dl;
    loader.load('/models/dragon_gate.glb', (g) => {
      const holder = this.#addProp(g, {
        x: g2[0], z: g2[1], groundY: -1.5,
        width: 24, ry: Math.atan2(ux, uz),
      });
      // The source asset contains a solid dark door slab. The track's animated
      // gate below is the authoritative, readable entrance instead.
      if (holder) holder.visible = false;
      if (holder && this.palaceAnims) {
        this.palaceAnims.gates.push({ holder, baseY: holder.position.y, period: mapDef.palaceGate?.period || 7, phase: mapDef.palaceGate?.phase || 0.2, travel: mapDef.palaceGate?.travel || 9 });
      }
    }, undefined, (err) => console.warn('dragon_gate 加载失败', err));

    // 珊瑚宫殿（东海龙宫主殿）@ 第一段稳定深水区。
    // The GLB is a coherent two-storey palace; earlier code hid it because the
    // authored centre is offset and the colonnade crosses the lane. Centre it
    // on the track, scale it to straddle the corridor, then clear the columns
    // that would physically block the racing nave.
    loader.load('/models/coral_palace.glb', (g) => {
      const palaceFrom = gates[3], palaceTo = gates[4];
      const pdx = palaceTo[0] - palaceFrom[0], pdz = palaceTo[1] - palaceFrom[1];
      const plen = Math.hypot(pdx, pdz) || 1;
      const palaceUx = pdx / plen, palaceUz = pdz / plen;
      const palaceCenterX = (palaceFrom[0] + palaceTo[0]) * 0.5;
      const palaceCenterZ = (palaceFrom[1] + palaceTo[1]) * 0.5;
      const palaceYaw = Math.atan2(palaceUx, palaceUz);
      const root = g.scene;
      const authoredBox = new THREE.Box3().setFromObject(root);
      const authoredSize = new THREE.Vector3();
      const authoredCenter = new THREE.Vector3();
      authoredBox.getSize(authoredSize);
      authoredBox.getCenter(authoredCenter);
      // ~27 m across the lane, ~26.7 m tall; ground-floor ceiling sits about
      // 3.6 m above the -8 m racing depth.
      const fit = 27 / Math.max(authoredSize.x, authoredSize.z, 1);
      root.position.set(-authoredCenter.x, -authoredBox.min.y, -authoredCenter.z);
      const holder = new THREE.Group();
      holder.position.set(palaceCenterX, SEABED, palaceCenterZ);
      holder.rotation.y = palaceYaw;
      holder.scale.setScalar(fit);
      holder.add(root);
      this.group.add(holder);
      holder.updateMatrixWorld(true);
      // Carve a readable nave: hide columns that intersect the racing corridor
      // below the first-floor ceiling, keep walls/roofs intact overhead.
      const meshBox = new THREE.Box3();
      let cleared = 0;
      root.traverse((o) => {
        if (!o.isMesh) return;
        meshBox.setFromObject(o);
        const relMinX = meshBox.min.x - palaceCenterX;
        const relMaxX = meshBox.max.x - palaceCenterX;
        const inLane = relMaxX > -7.5 && relMinX < 7.5;
        const atBoatHeight = meshBox.max.y > -10.5 && meshBox.min.y < -4.6;
        if (inLane && atBoatHeight) {
          o.visible = false;
          cleared++;
        }
      });
      if (cleared === 0) console.warn('coral_palace: no nave columns cleared');
      this.palaceProp = holder;
    }, undefined, (err) => console.warn('coral_palace 加载失败', err));

    // 沉船残骸 @ 第二段潜行区（亚特兰蒂斯外围），倾斜沉没更有故事感
    loader.load('/models/shipwreck.glb', (g) => {
      this.#addProp(g, {
        x: -178, z: -42, groundY: SEABED + 2, width: 30, ry: 2.1, tilt: 0.32,
      });
      // 第二艘小沉船 @ 赛道东侧水面段海床
      const g2 = { scene: g.scene.clone() };
      this.#addProp(g2, {
        x: 118, z: -112, groundY: SEABED, width: 18, ry: -0.7, tilt: -0.22,
      });
    }, undefined, (err) => console.warn('shipwreck 加载失败', err));

    // 珊瑚礁群：两段潜行区海床散布（8 处，尺寸/朝向随机但确定性）
    loader.load('/models/coral_reef.glb', (g) => {
      const spots = [
        [128, 122], [70, 162], [8, 114], [-56, 124],     // 第一段（龙宫隧道沿线）
        [-176, -28], [-136, -98], [-82, -150], [-16, -104], // 第二段（亚特兰蒂斯沿线）
      ];
      const authoredSpots = [[138, 112], [116, 160], [54, 178], [0, 155], [-166, -36], [-126, -112], [50, -146], [112, -112]];
      for (const [i, pair] of spots.entries()) {
        const [x, z] = authoredSpots[i] || pair;
        const clone = { scene: g.scene.clone() };
        const holder = this.#addProp(clone, {
          x, z, groundY: SEABED,
          // Keep the authored coral as small seabed dressing. It is visual
          // only (no collider), so boats cannot tunnel into it or get stuck.
          width: 4.5 + rng() * 4.0,
          ry: rng() * Math.PI * 2,
        });
        if (holder) {
          holder.visible = true;
          holder.traverse((obj) => {
            if (obj.isMesh) {
              obj.castShadow = false;
              obj.receiveShadow = false;
              obj.frustumCulled = true;
            }
          });
        }
      }
    }, undefined, (err) => console.warn('coral_reef 加载失败', err));

    // ---------- 程序化几何 → 带贴图 GLB（用户点名的"丑几何体"） ----------
    // 潜行区入口/出口的珊瑚门柱、遗迹外圈替换巨像的珊瑚巨礁，全部用 coral_reef
    // 这张贴图模型；周围再撒一圈 rock_boulder 碎石，避免孤零零一块珊瑚。
    const archSpots = this.palaceArchSpots || [];
    const coralSpots = this.palaceCoralSpots || [];
    const boulderSpots = this.palaceBoulderSpots || [];
    this.palaceArchProps = [];
    if (archSpots.length || coralSpots.length) {
      loader.load('/models/coral_reef.glb', (g) => {
        for (const spot of [...archSpots, ...coralSpots]) {
          const clone = { scene: g.scene.clone() };
          const holder = this.#addProp(clone, {
            x: spot.x, z: spot.z, groundY: spot.y, width: spot.width, ry: spot.ry,
          });
          if (holder) {
            holder.visible = true;
            this.palaceArchProps.push(holder);
          }
        }
      }, undefined, (err) => console.warn('coral_reef 替换件加载失败', err));
    }
    if (boulderSpots.length) {
      loader.load('/models/rock_boulder.glb', (g) => {
        for (const spot of boulderSpots) {
          const clone = { scene: g.scene.clone() };
          this.#addProp(clone, {
            x: spot.x, z: spot.z, groundY: spot.y, width: spot.width, ry: spot.ry,
          });
        }
      }, undefined, (err) => console.warn('rock_boulder 加载失败', err));
    }

  }

  /**
   * 通用布景放置：测包围盒 → 缩放到目标横向尺寸 → 底部贴地 → 挂到场景
   * @param {object} gltf GLTFLoader 结果（或 { scene } 克隆包装）
   * @param {object} opts { x, z, groundY, width, ry, tilt }
   */
  #addProp(gltf, opts) {
    const root = gltf.scene;
    // 归一化尺寸（横向取 x/z 较大者）
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const lateral = Math.max(size.x, size.z) || 1;
    const s = opts.width / lateral;
    root.scale.setScalar(s);

    // 缩放后重测，把底部贴到 holder 原点（holder 落在 groundY）
    root.updateWorldMatrix(false, true);
    const box2 = new THREE.Box3().setFromObject(root);
    if (!opts.preserveAuthoredRoot) {
      root.position.y = -box2.min.y;
    }

    const holder = new THREE.Group();
    holder.position.set(opts.x, opts.groundY, opts.z);
    holder.rotation.y = opts.ry || 0;
    if (opts.tilt) holder.rotation.z = opts.tilt;
    holder.add(root);
    this.group.add(holder);
    if (Number.isFinite(opts.colliderRadius) && opts.colliderRadius > 0) {
      this.colliders.push({ x: opts.x, z: opts.z, r: opts.colliderRadius });
    }
    return holder;
  }

  /** 龙宫场景动画：光柱摇曳 / 宝珠漂浮 / 水晶脉动 / 气泡上升 */
  #updatePalace(dt, camera) {
    const t = this.time;
    const A = this.palaceAnims;
    if (this.causticsUniforms) this.causticsUniforms.uTime.value = t;
    // 水下生态（水母/鱼群/鲨鱼/巨蚌/海藻/火山）：uw 用来决定"看不看得见"
    updatePalaceUndersea(this.palaceLife, t, dt, camera, this.uwK);
    if (A) {
      for (const gate of A.gates || []) {
        const c = ((t / gate.period + gate.phase) % 1 + 1) % 1;
        const open01 = 0.5 + 0.5 * Math.sin(c * Math.PI * 2 - Math.PI * 0.5);
        gate.holder.position.y = gate.baseY + open01 * gate.travel;
      }
      for (const b of A.beams) {
        b.mesh.material.opacity = 0.085 + 0.055 * Math.sin(t * 1.5 + b.phase);
        b.mesh.rotation.z = b.baseZ + 0.05 * Math.sin(t * 0.6 + b.phase);
      }
      for (const p of A.pearls) {
        p.mesh.position.y = p.baseY + Math.sin(t * 1.1 + p.phase) * 0.9;
      }
      for (const c of A.crystals) {
        c.rotation.y += dt * 0.8;
      }
      if (this.crystalMat) {
        this.crystalMat.emissiveIntensity = 1.0 + 0.35 * Math.sin(t * 2.2);
      }
      for (const f of A.fish) {
        f.mesh.position.x += f.speed * dt;
        f.mesh.position.y = f.homeY + Math.sin(t * 1.8 + f.phase) * 0.45;
        f.mesh.rotation.z = Math.sin(t * 2.1 + f.phase) * 0.08;
        if (f.speed > 0 && f.mesh.position.x > f.maxX) f.mesh.position.x = f.minX;
        if (f.speed < 0 && f.mesh.position.x < f.minX) f.mesh.position.x = f.maxX;
      }
    }
    // 气泡：大泡快升、小泡慢飘（都跟随相机），缝隙气泡沿世界坐标原地上升
    const driftBubbles = (points) => {
      if (!points || !points.visible) return;
      const pos = points.geometry.attributes.position;
      const arr = pos.array;
      const rise = points.userData.rise;
      const spread = points.userData.spread;
      const cy = camera ? camera.position.y : 0;
      for (let i = 0, j = 0; i < arr.length; i += 3, j++) {
        arr[i + 1] += dt * rise[j];
        arr[i] += Math.sin(t * 0.7 + j) * dt * 0.2;
        if (arr[i + 1] > cy + 12) {
          arr[i + 1] = cy - 18 - Math.random() * 8;
          arr[i] = (Math.random() - 0.5) * spread;
          arr[i + 2] = (Math.random() - 0.5) * spread;
        }
      }
      pos.needsUpdate = true;
      if (camera) {
        points.position.set(
          Math.round(camera.position.x / 20) * 20,
          0,
          Math.round(camera.position.z / 20) * 20,
        );
      }
    };
    driftBubbles(this.bubbles);
    driftBubbles(this.bubblesSmall);
    if (this.ventBubbles && this.ventBubbles.visible) {
      const pos = this.ventBubbles.geometry.attributes.position;
      const arr = pos.array;
      const base = this.ventBubbles.userData.base;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i + 1] += dt * (1.8 + ((i / 3) % 3) * 0.5);
        arr[i] += Math.sin(t * 0.9 + i) * dt * 0.25;
        if (arr[i + 1] > -2.5) {
          arr[i + 1] = base[i + 1];
          arr[i] = base[i];
          arr[i + 2] = base[i + 2];
        }
      }
      pos.needsUpdate = true;
    }
  }

  dispose() {
    for (const timer of this.landmarkTimers || []) clearTimeout(timer);
    this.dressing?.dispose();
    this.realSky?.dispose();
    this.nightSky?.dispose();
    this.nightSky = null;
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      } else if (obj.isSprite) {
        obj.material.dispose();
      }
    });
    if (this.rain) {
      this.scene.remove(this.rain);
      this.rain.geometry.dispose();
      this.rain.material.dispose();
      this.rain = null;
    }
    if (this.snow) {
      this.scene.remove(this.snow);
      // this.snow 是 Group（多层落雪 Points），本身没有 geometry/material。
      // 以前按单个对象 dispose，极夜冰海（第四关）/ 暴雪天气退出比赛时必抛
      // “Cannot read properties of undefined (reading 'dispose')”，
      // 结果是客机停在半释放状态：BOSS 模型已被移除（空气），HUD 还停在 0 血。
      this.snow.traverse((obj) => {
        obj.geometry?.dispose?.();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose?.();
      });
      this.snow = null;
      this.snowLayers = [];
    }
  }
}
