import * as THREE from 'three';

// 程序化 PBR 贴图：不依赖外部素材，用 canvas 直接生成反照率/法线/粗糙度。
// 用于山体浮岩（层状沉积岩 + 风化 + 苔藓斑点），也可给赛道岩石复用。

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) + ((c + (d - c) * xf) - (a + (b - a) * xf)) * yf;
}

function fbm(x, y, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 97) * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

function heightAt(u, v, seed, size) {
  const x = u * size * 0.06;
  const y = v * size * 0.06;
  // 层状沉积：横向条带 + 高频颗粒
  const strata = Math.sin(v * Math.PI * 9 + fbm(x * 0.7, y * 0.7, seed, 3) * 4.2) * 0.5 + 0.5;
  const grain = fbm(x * 2.4, y * 2.4, seed + 31, 5);
  const cracks = Math.pow(1 - Math.abs(fbm(x * 1.3, y * 1.3, seed + 71, 4) - 0.5) * 2, 6);
  // 层理只做低频暗示，主视觉靠颗粒：条纹权重太高会变成"木纹"
  return strata * 0.18 + grain * 0.6 + cracks * 0.26;
}

/**
 * @returns {{ map, normalMap, roughnessMap }} 全部已设好 wrap / SRGB
 */
export function makeRockTextures(size = 256, seed = 1) {
  const albedo = document.createElement('canvas');
  albedo.width = albedo.height = size;
  const actx = albedo.getContext('2d');
  const aimg = actx.createImageData(size, size);

  const normal = document.createElement('canvas');
  normal.width = normal.height = size;
  const nctx = normal.getContext('2d');
  const nimg = nctx.createImageData(size, size);

  const rough = document.createElement('canvas');
  rough.width = rough.height = size;
  const rctx = rough.getContext('2d');
  const rimg = rctx.createImageData(size, size);

  const hmap = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      hmap[y * size + x] = heightAt(x / size, y / size, seed, size);
    }
  }

  const mossTint = [86, 112, 62];
  const rockTint = [104, 112, 118];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const h = hmap[i];
      const m = fbm((x / size) * 3.1, (y / size) * 3.1, seed + 13, 4);
      // 苔藓：噪声团块 + 高处（v 小，球体 UV 顶部）更容易长
      const moss = smooth(Math.max(0, Math.min(1, (m - 0.52) * 4))) * (1 - y / size) * 0.85;
      const shade = 0.7 + h * 0.5;
      const base = [
        rockTint[0] * shade,
        rockTint[1] * shade,
        rockTint[2] * shade,
      ];
      // 层间夹层：只做轻微压暗，避免硬边条带
      const seam = 1 - Math.max(0, h - 0.62) * 0.3;
      const c = [
        (base[0] * seam) * (1 - moss) + mossTint[0] * moss,
        (base[1] * seam) * (1 - moss) + mossTint[1] * moss,
        (base[2] * seam) * (1 - moss) + mossTint[2] * moss,
      ];
      const dark = 0.35 + h * 0.5;
      const p = i * 4;
      aimg.data[p] = Math.min(255, c[0] * (0.7 + dark * 0.5));
      aimg.data[p + 1] = Math.min(255, c[1] * (0.7 + dark * 0.5));
      aimg.data[p + 2] = Math.min(255, c[2] * (0.7 + dark * 0.5));
      aimg.data[p + 3] = 255;

      // 法线：中心差分（环绕采样，保证平铺无缝）
      const xl = hmap[y * size + ((x - 1 + size) % size)];
      const xr = hmap[y * size + ((x + 1) % size)];
      const yu = hmap[((y - 1 + size) % size) * size + x];
      const yd = hmap[((y + 1) % size) * size + x];
      const strength = 2.6;
      let nx = (xl - xr) * strength;
      let ny = (yu - yd) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len;
      nimg.data[p] = (nx * 0.5 + 0.5) * 255;
      nimg.data[p + 1] = (ny * 0.5 + 0.5) * 255;
      nimg.data[p + 2] = (nz / len * 0.5 + 0.5) * 255;
      nimg.data[p + 3] = 255;

      // 粗糙度：凸起处更粗糙，苔藓略光滑（湿润感）
      const rv = (0.72 + (1 - h) * 0.24 - moss * 0.3) * 255;
      rimg.data[p] = rimg.data[p + 1] = rimg.data[p + 2] = Math.max(24, Math.min(255, rv));
      rimg.data[p + 3] = 255;
    }
  }

  actx.putImageData(aimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  const map = new THREE.CanvasTexture(albedo);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const normalMap = new THREE.CanvasTexture(normal);
  normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
  const roughnessMap = new THREE.CanvasTexture(rough);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  return { map, normalMap, roughnessMap };
}

/** 岩石 PBR 材质（一次生成，多块岩石共享 → 只占一份显存） */
export function makeRockMaterial({ seed = 1, repeat = 2.2 } = {}) {
  const { map, normalMap, roughnessMap } = makeRockTextures(256, seed);
  map.repeat.set(repeat, repeat);
  normalMap.repeat.set(repeat, repeat);
  roughnessMap.repeat.set(repeat, repeat);
  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    roughnessMap,
    roughness: 1.0,
    metalness: 0.04,
    color: 0xcfd8dd,
  });
  upgradeToRealRock(mat, repeat);
  return mat;
}

/* ---------------------------------------------------------------- 写实岩石
 * 来源：Poly Haven「Rock Face」（CC0，1k JPG）。三张图全场景共享一份。
 *
 * 为什么是"异步原地换图"而不是直接等贴图再建材质：
 * 这些材质是在场景构建的同步流程里 new 出来的，改成异步会把整条赛道生成链
 * 变成 async。这里的做法是先挂程序化贴图（旧观感，不会白模），图片到位后
 * 把同一批材质上的 map/normalMap/roughnessMap 换成真实贴图，一帧内完成。
 */
const REAL_ROCK_URLS = {
  map: '/textures/rock/rock_face_diff_1k.jpg',
  normalMap: '/textures/rock/rock_face_nor_gl_1k.jpg',
  // Poly Haven 的 ARM = R:AO / G:Roughness / B:Metalness，
  // three 的 roughnessMap 正好读 G 通道，直接当粗糙度图用
  roughnessMap: '/textures/rock/rock_face_arm_1k.jpg',
};

let realRockSet = null;
let realRockLoading = false;
const realRockWaiters = [];   // [{ mat, repeat }]，图片到齐后一起替换

function upgradeToRealRock(mat, repeat) {
  if (realRockSet) {
    applyRealRock(mat, repeat);
    return;
  }
  realRockWaiters.push({ mat, repeat });
  if (realRockLoading) return;
  realRockLoading = true;

  const loader = new THREE.TextureLoader();
  const keys = Object.keys(REAL_ROCK_URLS);
  const out = {};
  let left = keys.length;
  let failed = false;
  const finish = () => {
    if (failed) return;
    realRockSet = out;
    const rep = realRockWaiters[0]?.repeat ?? 2.2;
    for (const key of keys) out[key]?.repeat.set(rep, rep);
    for (const w of realRockWaiters) applyRealRock(w.mat, w.repeat);
    realRockWaiters.length = 0;
  };
  for (const key of keys) {
    loader.load(
      REAL_ROCK_URLS[key],
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        // 只有反照率是 sRGB；法线/粗糙度必须是线性，否则法线会被 gamma 掰歪
        tex.colorSpace = key === 'map' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = 8;
        out[key] = tex;
        if (--left === 0) finish();
      },
      undefined,
      () => { failed = true; realRockWaiters.length = 0; },
    );
  }
}

function applyRealRock(mat, repeat) {
  const set = realRockSet;
  if (!set || !mat) return;
  // 三张图全场景只有一份：UV 缩放取「第一个申请者」的值。
  // 各岩石的 repeat 本来就只在 2.2~2.4 之间浮动，为这点差别克隆贴图
  // 反而会让 three 多上传一份纹理，得不偿失。
  if (set.map) mat.map = set.map;
  if (set.normalMap) mat.normalMap = set.normalMap;
  if (set.roughnessMap) mat.roughnessMap = set.roughnessMap;
  // 真实法线比程序化生成的那张细腻得多，强度 1.15 会显得"塑料搓板"
  mat.normalScale = new THREE.Vector2(0.85, 0.85);
  mat.needsUpdate = true;
}


/**
 * 接触阴影贴图：中心实、边缘羽化的圆斑（乘在黑色平面上）。
 * 贴地/贴水物件底下垫一张，物体立刻"落地"，这是不开 SSAO 时最省的做法。
 */
export function makeContactShadowTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const half = size * 0.5;
  const g = ctx.createRadialGradient(half, half, size * 0.04, half, half, half);
  g.addColorStop(0.00, 'rgba(0,0,0,1)');
  g.addColorStop(0.38, 'rgba(0,0,0,0.82)');
  g.addColorStop(0.62, 'rgba(0,0,0,0.42)');
  g.addColorStop(0.84, 'rgba(0,0,0,0.12)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 2;
  return tex;
}

/**
 * 木纹贴图：近白底 + 竖向长纹理 + 少量节疤，颜色交给材质 color 相乘。
 * 路灯、码头、船坞这类"还是纯棕色"的木构件用它，比平涂多一层质感。
 */
export function makeWoodTexture(size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(20261101);
  ctx.fillStyle = '#efe9e0';
  ctx.fillRect(0, 0, size, size);
  // 竖向木纤维：长短不一、深浅不一
  for (let i = 0; i < 170; i++) {
    const x = rand() * size;
    const w = 0.6 + rand() * 2.2;
    const y0 = rand() * size;
    const len = size * (0.25 + rand() * 0.75);
    const v = 0.62 + rand() * 0.34;
    ctx.strokeStyle = `rgba(${Math.round(122 * v)},${Math.round(96 * v)},${Math.round(70 * v)},${0.10 + rand() * 0.22})`;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.bezierCurveTo(
      x + (rand() - 0.5) * 6, y0 + len * 0.35,
      x + (rand() - 0.5) * 6, y0 + len * 0.65,
      x, y0 + len,
    );
    ctx.stroke();
  }
  // 节疤：同心椭圆
  for (let i = 0; i < 7; i++) {
    const x = rand() * size;
    const y = rand() * size;
    for (let k = 3; k >= 1; k--) {
      ctx.strokeStyle = `rgba(96,74,52,${0.10 + k * 0.05})`;
      ctx.lineWidth = 1 + rand();
      ctx.beginPath();
      ctx.ellipse(x, y, k * 3.2, k * 5.4, rand() * Math.PI, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * 圆月弯刀贴图：带锯齿电边的新月（纯白，颜色由材质的 color 控制）。
 * 小怪挥砍 / 血魔飞刀都用它——直的圆弧读不出"闪电"，所以内外边缘都做了
 * 高频抖动，再从外缘甩出几道电弧，加色混合下就是一把带电的弯刀。
 */
export function makeSlashArcTexture(size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(0x51a5);
  const cx = size * 0.5;
  const cy = size * 0.98;
  const rOut = size * 0.86;
  const rIn = size * 0.56;
  const a0 = Math.PI * 1.06;
  const a1 = Math.PI * 1.94;
  const STEPS = 30;

  // 月牙轮廓：圆弧上取点，半径加高频锯齿 → 电光刃边的质感
  const outer = [];
  const inner = [];
  for (let i = 0; i <= STEPS; i++) {
    const ang = a0 + (a1 - a0) * (i / STEPS);
    const jitter = ((i % 2) ? 1 : -1) * (size * (0.012 + rand() * 0.028));
    const r = rOut + jitter;
    outer.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
  }
  for (let i = STEPS; i >= 0; i--) {
    const ang = a0 + (a1 - a0) * (i / STEPS);
    const jitter = ((i % 2) ? -1 : 1) * (size * (0.01 + rand() * 0.02));
    const r = rIn + jitter;
    inner.push([cx + Math.cos(ang) * r, cy + Math.sin(ang) * r]);
  }

  // 刀身填充：上端（刀尖）最亮，向下渐隐
  const g = ctx.createLinearGradient(0, size * 0.06, 0, size);
  g.addColorStop(0, 'rgba(255,255,255,0.98)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.72)');
  g.addColorStop(1, 'rgba(255,255,255,0.12)');
  ctx.fillStyle = g;
  ctx.beginPath();
  outer.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  inner.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.closePath();
  ctx.fill();

  // 刀锋亮边
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = size * 0.02;
  ctx.beginPath();
  outer.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();

  // 外缘电弧：沿着径向甩出去的电光尖刺
  ctx.lineWidth = size * 0.012;
  for (let b = 0; b < 7; b++) {
    const t = 0.06 + 0.88 * (b / 6) + (rand() - 0.5) * 0.03;
    const ang = a0 + (a1 - a0) * t;
    const sx = cx + Math.cos(ang) * rOut;
    const sy = cy + Math.sin(ang) * rOut;
    const len = size * (0.05 + rand() * 0.1);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    let px = sx;
    let py = sy;
    for (let seg = 1; seg <= 3; seg++) {
      const dist = len * (seg / 3);
      const side = (seg % 2 ? 1 : -1) * (len * 0.22);
      px = cx + Math.cos(ang) * (rOut + dist) - Math.sin(ang) * side;
      py = cy + Math.sin(ang) * (rOut + dist) + Math.cos(ang) * side;
      ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
