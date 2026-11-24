import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { waveHeight } from '../utils/waves.js';
import { faultRects, faultAt as faultAtRect } from '../utils/faults.js';
import { fallbackHullOutline as FALLBACK_HULL } from '../utils/hull.js';
import { tidalFactor } from '../data/maps.js';
import { audio } from '../audio/AudioEngine.js';
import { buildSurfacePalace } from './SurfacePalace.js';

const marineModelCache = new Map();

// 蹭墙助滑的切向速度下限（m/s）。船头斜顶在护栏上、玩家还给着油门时，
// 沿墙那一份速度至少补到这里，读起来是"贴着墙滑过去"而不是"贴死在原地"。
// 6m/s ≈ 巡航极速的 1/5，不会变成"蹭墙更快"。
const WALL_SCRAPE_MIN_ALONG = 6;
// 蹭墙的持续阻尼（1/s）：稳态速度 ≈ 推力平衡点，实测约干净跑法的 7 成。
const WALL_SCRAPE_DRAG = 0.35;

// 弹射模式左右交替的贴边随机序列（-1 靠左 / 1 靠右）：
// 让弹射器组不再排成一条中心线直线，而是左右两边错开、更有节奏。
const LAUNCH_LANE_PATTERN = [
  -1, -1, 1, -1, 1, 1, 1, -1, 1,
  -1, -1, 1, 1, -1, 1, 1, -1, -1,
];
function launchLaneSign(mapId, index) {
  // 用简单字符串哈希让不同地图的相位错开，但同一地图保持确定性
  let h = 0;
  for (let i = 0; i < mapId.length; i++) h = (h * 31 + mapId.charCodeAt(i)) >>> 0;
  return LAUNCH_LANE_PATTERN[(index + (h % LAUNCH_LANE_PATTERN.length)) % LAUNCH_LANE_PATTERN.length];
}

function loadMarineModel(url) {
  if (!marineModelCache.has(url)) {
    const loader = new GLTFLoader();
    marineModelCache.set(url, new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject)));
  }
  return marineModelCache.get(url);
}

// ---------- 近道拱门 / 龙宫闸门（带贴图的 GLB） ----------
// 原来是纯色几何：近道是 Cylinder 立柱 + Box 横梁 + Octahedron 顶标，
// 龙宫是金色 Box/9 根 Cylinder 栏杆。现在换成带贴图模型（CC-BY，见设置页「素材来源」），
// 位置/动画/碰撞窗口全部沿用原逻辑；加载失败回落到程序化几何，保证离线可玩。
// ---------- 熔岩硬核档：Blender 出的岩石障碍原型 ----------
// 几何进 Blender（顶点色低模，public/models/magma/*.glb），
// 碰撞、摆位、节奏全部留 JS —— 见 #buildMagmaObstacles 里的圆形代理。
const MAGMA_OBSTACLE_GLB = {
  pillar: '/models/magma/volcanic_pillar.glb',
  spikes: '/models/magma/lava_spikes.glb',
  shard: '/models/magma/obsidian_shard.glb',
  // 霓虹海峡最后直道的移动障碍：Blender 出的圆石（smart-UV + 内嵌 512 岩石贴图）。
  // 熔岩那三块是黑曜石水晶，摆在青绿海面上像紫色尖塔，所以海峡另备两块。
  boulderA: '/models/props/rock_hazard_a.glb',
  boulderB: '/models/props/rock_hazard_b.glb',
};

// Blender 导出的岩石材质（albedo 平铺图 × 烘焙顶点 AO + 裂纹自发光）统一在这里收口：
// 贴图必须 REPEAT + 各向异性，否则盒式投影 UV 越界就整块拉伸；
// 自发光给到 1.15，夜景里靠 bloom 把裂纹晕开，石头才不是一团黑。
const magmaMatTuned = new WeakSet();
function tuneMagmaMat(mat) {
  if (!mat || !mat.isMeshStandardMaterial || magmaMatTuned.has(mat)) return;
  magmaMatTuned.add(mat);
  mat.envMapIntensity = 0.8;
  mat.metalness = 0;
  mat.emissiveIntensity = 1.15;
  for (const tex of [mat.map, mat.emissiveMap]) {
    if (!tex) continue;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
  }
  mat.needsUpdate = true;
}

const SHORTCUT_ARCH_URL = '/models/props/shortcut_arch.glb';
const PALACE_GATE_URL = '/models/props/palace_gate_leaf.glb';
const PALACE_FRAME_URL = '/models/props/palace_gate_frame.glb';
const FLOW_MARKER_URL = '/models/props/flow_marker.glb';
// 发卡弯口的转向牌立柱（Blender 出的木质指示牌，带木纹/铜件贴图）
const FLOW_SIGN_POST_URL = '/models/props/guide_sign_post.glb';
const propGlbCache = new Map();
function loadPropGlb(url) {
  if (!propGlbCache.has(url)) {
    propGlbCache.set(url, new Promise((resolve, reject) => {
      new GLTFLoader().load(url, resolve, undefined, reject);
    }));
  }
  return propGlbCache.get(url);
}

// 金龙过山车：Blender 出的成套构件（枕木/背鳍/支撑/龙门环/龙首，共用一套龙鳞贴图）
const COASTER_KIT_URL = '/models/props/coaster_dragon_kit.glb';
// 浮标链加载失败时的兜底浮筒（红漆 + 锈迹 + 灯罩），也是 Blender 出的
const BUOY_FALLBACK_URL = '/models/props/buoy_fallback.glb';

// 主脊梁与两条行轨还是程序化扫掠（保证曲线绝对顺滑），
// 但材质换成 Blender 烘焙的可平铺龙鳞贴图 + 法线。
let coasterScaleTexPromise = null;
function getCoasterScaleTextures() {
  if (!coasterScaleTexPromise) {
    const loader = new THREE.TextureLoader();
    const load = (url, srgb) => new Promise((resolve, reject) => {
      loader.load(url, (tex) => {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
        resolve(tex);
      }, undefined, reject);
    });
    coasterScaleTexPromise = Promise.all([
      load('/models/props/coaster_scale_col.png', true),
      load('/models/props/coaster_scale_nrm.png', false),
    ]).catch((err) => {
      console.warn('[track] 龙鳞贴图加载失败，轨道回落到纯色材质', err);
      return [null, null];
    });
  }
  return coasterScaleTexPromise;
}

/**
 * 把带贴图的 GLB 摆进"米制"槽位：等比缩放到目标跨度 / 高度上限，
 * 底边贴 y=0、水平居中，再套一个朝 yaw 方向的父节点。
 * 所有道具模型都走这一条，摆位参数（碰撞、动画）继续留在 JS 里。
 */
function fitPropModel(root, { span, maxH, yaw = 0, lift = 0, center = true }) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) normalizePropMaterial(m);
  });
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const wide = Math.max(size.x, size.z) || 1;
  const k = Math.min(span / wide, maxH / Math.max(0.001, size.y));
  root.scale.setScalar(k);
  root.updateMatrixWorld(true);
  const fitted = new THREE.Box3().setFromObject(root);
  root.position.set(
    center ? -(fitted.min.x + fitted.max.x) / 2 : 0,
    -fitted.min.y + lift,
    center ? -(fitted.min.z + fitted.max.z) / 2 : 0,
  );
  const wrap = new THREE.Group();
  wrap.rotation.y = yaw;
  wrap.add(root);
  return wrap;
}

// ---------- 长赛道石木原型（Blender 导出，public/models/track） ----------
// 原型按"米"建模、原点在底部中心、+Z 朝赛道切线，和 #buildStraitProps 里
// 原来那套 BoxGeometry 摆位共用同一套坐标，所以可以直接按门架姿态落下。
const straitProtoCache = new Map();
function loadStraitProto(name) {
  if (!straitProtoCache.has(name)) {
    straitProtoCache.set(name, new Promise((resolve, reject) => {
      new GLTFLoader().load(`/models/track/${name}.glb`, (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const parts = [];
        gltf.scene.traverse((obj) => {
          if (!obj.isMesh || !obj.geometry) return;
          const geo = obj.geometry.clone();
          // 合批只认 position/normal/color：UV、切线一律丢掉，否则和程序化盒子属性对不上
          for (const key of Object.keys(geo.attributes)) {
            if (key !== 'position' && key !== 'normal') geo.deleteAttribute(key);
          }
          geo.applyMatrix4(obj.matrixWorld);
          const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
          parts.push({ geo, color: mat?.color ? mat.color.getHex() : 0xffffff });
        });
        resolve(parts);
      }, undefined, reject);
    }));
  }
  return straitProtoCache.get(name);
}

// ---------- 赛道道具（GLB 布景 + 机关） ----------
// span: 目标横向直径（米）。这几个模型单位为米、Y 朝上、开口/盘面朝 ±Z，
//       统一缩放到 span 后按赛道切线转 yaw，就等于"正对来船"。
// lift: 贴水高度微调（模型自身底边会被贴到 y=0）
const COURSE_PROP_DEFS = {
  flag: {
    url: '/models/props/flag_gate.glb',
    label: '旗门',
    span: (gw) => gw * 2.1,
    lift: 0.12,
  },
  portal: {
    url: '/models/props/portal.glb',
    label: '加速传送门',
    span: (gw) => gw * 0.66,
    lift: 0.1,
    // 源材质 emissive 是 (0.55,0.18,1)*3，进本作的光照/bloom 会偏成粉白，
    // 这里统一压成确定的紫罗兰，跟龙宫和赛道的冷色系更搭
    emissive: 0x7b5cff,
    emissiveIntensity: 0.85,
  },
  hammer: {
    url: '/models/props/rotating_obstacle.glb',
    label: '旋转锤',
    span: () => 7.6,
    lift: 0.1,
  },
  whirl: {
    url: '/models/props/whirlpool_warning.glb',
    label: '漩涡',
    span: () => 11.5,
    lift: 0.06,
  },
};

// 缺省配置：没写 courseProps 的地图也自动拿到这四件套
// side 是 gateWidth/2 的倍数：锤子/漩涡都要偏到一侧，中线才留得出可过的干净线
const DEFAULT_COURSE_PROPS = [
  { kind: 'flag', at: 0.0 },
  { kind: 'portal', at: 0.28 },
  { kind: 'hammer', at: 0.55, side: 1.3 },
  { kind: 'whirl', at: 0.78, side: -1.15 },
];

// ---------- 道具质感：材质规范 ----------
// GLB 各自带着不同的粗糙度/金属度，直接沿用会出现"同一个世界里有的像铁、有的像塑料"。
// 按材质名归类成四种手感（金属 / 浮筒 / 石座 / 布料），再统一压一遍环境反射。
const PROP_MAT_RULES = [
  { re: /metal|steel|iron|gold|brass|bronze|copper|chrome|weight/i, roughness: 0.32, metalness: 0.88, env: 0.95 },
  { re: /float|buoy|rubber|foam/i, roughness: 0.45, metalness: 0.04, env: 0.7 },
  { re: /rock|stone|granite|concrete|base/i, roughness: 0.92, metalness: 0.02, env: 0.4 },
  { re: /flag|cloth|canvas|fabric/i, roughness: 0.9, metalness: 0, env: 0.3 },
  { re: /frame|trim|rail/i, roughness: 0.35, metalness: 0.55, env: 0.85 },
  { re: /paint|orange|black|white|ribbon|rim|centre/i, roughness: 0.5, metalness: 0.08, env: 0.5 },
];
// 已压过规范的材质做个标记，避免道具每次实例化都重设 needsUpdate
const propMatStyled = new WeakSet();
function normalizePropMaterial(mat) {
  if (!mat || !mat.isMeshStandardMaterial) return;
  if (propMatStyled.has(mat)) return;
  propMatStyled.add(mat);
  const name = (mat.name || '').toLowerCase();
  const rule = PROP_MAT_RULES.find((r) => r.re.test(name));
  const emissive = mat.emissive ? mat.emissive.r + mat.emissive.g + mat.emissive.b : 0;
  if (emissive > 0.05) {
    // 能量面（传送门环/符文、漩涡警示带）：发光本身就是重点，只压粗糙度让高光收得住
    mat.roughness = Math.min(mat.roughness, 0.35);
    mat.envMapIntensity = 0.9;
  } else if (rule) {
    mat.roughness = rule.roughness;
    mat.metalness = rule.metalness;
    mat.envMapIntensity = rule.env;
  } else {
    mat.roughness = Math.max(0.42, Math.min(0.95, mat.roughness));
    mat.metalness = Math.min(0.35, mat.metalness);
    mat.envMapIntensity = 0.6;
  }
  mat.needsUpdate = true;
}

// ---------- 道具质感：顶点 AO ----------
// 每个子网格底部 35% 从 0.5 渐变到 1，相当于给所有结构件补一圈接触暗部。
// 扁平件（盘面、横幅）整块都在"底部"，跳过，否则会被整片压黑。
function bakePropAO(root) {
  const toToggle = new Set();
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.visible || !obj.geometry) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (mats.some((m) => !m || m.transparent || m.alphaTest > 0)) return;
    const geo = obj.geometry;
    if (geo.userData.propAO) return;
    const pos = geo.attributes.position;
    if (!pos || !pos.count) return;
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (!bb) return;
    const h = bb.max.y - bb.min.y;
    const wide = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    if (h < wide * 0.12) return;
    const existing = geo.attributes.color;
    if (existing && !mats.every((m) => m.vertexColors)) {
      // 已经烘过颜色但材质没启用：动了会改变原有配色，直接放过
      return;
    }
    let attr = existing;
    if (!attr) {
      attr = new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3);
      geo.setAttribute('color', attr);
    }
    const lift = Math.max(1e-6, h * 0.35);
    for (let i = 0; i < pos.count; i++) {
      const k = Math.max(0, Math.min(1, (pos.getY(i) - bb.min.y) / lift));
      const f = 0.5 + 0.5 * Math.sqrt(k);
      attr.setX(i, attr.getX(i) * f);
      attr.setY(i, attr.getY(i) * f);
      attr.setZ(i, attr.getZ(i) * f);
    }
    attr.needsUpdate = true;
    geo.userData.propAO = true;
    for (const m of mats) toToggle.add(m);
  });
  for (const m of toToggle) {
    m.vertexColors = true;
    m.needsUpdate = true;
  }
}

// ---------- 道具质感：水面接触细节 ----------
// 脚下的柔和暗部 + 一圈向外扩散的涟漪：道具压在水上，而不是"贴"在水上。
let propContactTex = null;
function getPropContactTexture() {
  if (propContactTex) return propContactTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.36)');
  g.addColorStop(0.75, 'rgba(0,0,0,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  propContactTex = new THREE.CanvasTexture(canvas);
  return propContactTex;
}

let propRippleTex = null;
function getPropRippleTexture() {
  if (propRippleTex) return propRippleTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 26, size / 2, size / 2, 62);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(226,248,255,0.55)');
  g.addColorStop(0.72, 'rgba(200,236,250,0.3)');
  g.addColorStop(1, 'rgba(200,236,250,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  propRippleTex = new THREE.CanvasTexture(canvas);
  return propRippleTex;
}

let propContactMat = null;
function getPropContactMaterial() {
  if (!propContactMat) {
    propContactMat = new THREE.MeshBasicMaterial({
      map: getPropContactTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.7,
    });
  }
  return propContactMat;
}

const frac01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

// 潮汐水流条纹贴图：竖向断续条纹 + 一个 V 形箭头。
// 平面摊平后纹理 V 方向正好是 +Z 方向，再按流向转 yaw 就等于"箭头指着水流"。
let tideTexture = null;
function getTideTexture() {
  if (tideTexture) return tideTexture;
  const w = 128;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  let seed = 0x2f7d31;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 34; i++) {
    const x = rand() * w;
    const y0 = rand() * h;
    const len = 18 + rand() * 64;
    ctx.strokeStyle = `rgba(255,255,255,${0.18 + rand() * 0.45})`;
    ctx.lineWidth = 1 + rand() * 2.4;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x + (rand() - 0.5) * 5, y0 + len);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(w * 0.5 - 18, h * 0.44);
  ctx.lineTo(w * 0.5, h * 0.62);
  ctx.lineTo(w * 0.5 + 18, h * 0.44);
  ctx.stroke();
  tideTexture = new THREE.CanvasTexture(canvas);
  tideTexture.wrapS = THREE.RepeatWrapping;
  tideTexture.wrapT = THREE.RepeatWrapping;
  tideTexture.colorSpace = THREE.SRGBColorSpace;
  tideTexture.repeat.set(1, 3);
  return tideTexture;
}

// 加速带箭头贴图（白色人字箭头，材质染色用）
let padTexture = null;
function getPadTexture() {
  if (padTexture) return padTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 三个朝上的箭头（指向前进方向）
  for (const cy of [104, 64, 24]) {
    ctx.beginPath();
    ctx.moveTo(22, cy + 18);
    ctx.lineTo(64, cy - 18);
    ctx.lineTo(106, cy + 18);
    ctx.stroke();
  }
  padTexture = new THREE.CanvasTexture(canvas);
  padTexture.wrapS = THREE.RepeatWrapping;
  padTexture.wrapT = THREE.RepeatWrapping;
  return padTexture;
}

// ---------- 木栈桥贴图（Blender 侧出的可平铺木纹，512×512） ----------
// 和石砌面同一套思路：栈道是"多段 GLB 合批成一个大网格"，UV 留不住，
// 所以按世界坐标做三平面投影。木纹是各向异性的（顺纹必须沿板长），
// 投影时要把 u 轴强制对到 Z（板长方向），见 #buildStraitProps 里的 woodTri。
let straitWoodMap = null;
function getStraitWoodMap() {
  if (straitWoodMap) return straitWoodMap;
  straitWoodMap = new THREE.TextureLoader().load('/models/props/bridge_wood.png');
  straitWoodMap.wrapS = THREE.RepeatWrapping;
  straitWoodMap.wrapT = THREE.RepeatWrapping;
  straitWoodMap.colorSpace = THREE.SRGBColorSpace;
  // 桥面是长条薄片、又是低角度俯视，各向异性给低了远处直接糊成一片土黄
  straitWoodMap.anisotropy = 8;
  return straitWoodMap;
}

// ---------- 石砌面贴图：颜色 + 高度（两张可平铺的 canvas） ----------
// 为什么不用 UV：石构件是"多份 GLB 合批成一个大网格"的，合批时 UV 一律丢掉
// （见 #buildStraitProps 里的注释），所以纹理只能走**三平面投影**（按世界坐标采样）。
// 颜色图负责砌块本色/灰缝/污渍，高度图负责凹凸（片元里求梯度当法线扰动）。
// 两张图共用同一套砌块布局，所以凹凸和颜色是对得上的 —— 这是"石头"和"贴纸"的区别。
let straitStoneMaps = null;
function getStraitStoneMaps() {
  if (straitStoneMaps) return straitStoneMaps;
  const SIZE = 512;
  const COURSE = 64;               // 8 层，整除 → 纵向无缝；一层 ≈ 0.8m
  const MORTAR = 3;                // 灰缝像素 → 约 3.7cm，和几何缝宽度接近
  const cCol = document.createElement('canvas');
  const cHgt = document.createElement('canvas');
  cCol.width = cCol.height = SIZE;
  cHgt.width = cHgt.height = SIZE;
  const gc = cCol.getContext('2d');
  const gh = cHgt.getContext('2d');
  let seed = 0x51a7c3;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  gc.fillStyle = '#3b3934';        // 灰缝
  gc.fillRect(0, 0, SIZE, SIZE);
  gh.fillStyle = '#0d0d0d';        // 灰缝是最低的
  gh.fillRect(0, 0, SIZE, SIZE);

  for (let row = 0; row < SIZE / COURSE; row++) {
    const y0 = row * COURSE;
    let x = -Math.floor(rand() * 60);
    while (x < SIZE) {
      const w = 52 + Math.floor(rand() * 68);
      const bx = x + MORTAR * 0.5;
      const bw = w - MORTAR;
      const by = y0 + MORTAR * 0.5;
      const bh = COURSE - MORTAR * 1.5;
      const lum = 0.66 + rand() * 0.30;
      const warm = (rand() - 0.5) * 0.14;          // 偏暖/偏冷一点点
      const r = Math.min(255, Math.round(255 * lum * (1.02 + warm)));
      const g = Math.min(255, Math.round(255 * lum * (1.0 + warm * 0.4)));
      const b = Math.min(255, Math.round(255 * lum * (0.99 - warm * 0.7)));
      const drawBlock = (px) => {
        gc.fillStyle = `rgb(${r},${g},${b})`;
        gc.fillRect(px, by, bw, bh);
        // 单块石头自己的体积：上缘受光、下缘压暗、左右轻微
        const gv = gc.createLinearGradient(px, by, px, by + bh);
        gv.addColorStop(0, 'rgba(255,255,255,0.20)');
        gv.addColorStop(0.30, 'rgba(255,255,255,0.06)');
        gv.addColorStop(0.72, 'rgba(0,0,0,0.05)');
        gv.addColorStop(1, 'rgba(0,0,0,0.26)');
        gc.fillStyle = gv;
        gc.fillRect(px, by, bw, bh);
        // 块内纹理：几道随机斜纹 + 麻点，避免整块死平
        gc.save();
        gc.beginPath();
        gc.rect(px, by, bw, bh);
        gc.clip();
        for (let i = 0; i < 9; i++) {
          const yy = by + rand() * bh;
          gc.strokeStyle = `rgba(${rand() < 0.5 ? 20 : 235},${rand() < 0.5 ? 20 : 235},${rand() < 0.5 ? 20 : 235},${0.03 + rand() * 0.05})`;
          gc.lineWidth = 1 + rand() * 2;
          gc.beginPath();
          gc.moveTo(px - 4, yy + rand() * 6 - 3);
          gc.lineTo(px + bw + 4, yy + rand() * 10 - 5);
          gc.stroke();
        }
        for (let i = 0; i < 26; i++) {
          const v = rand() < 0.55 ? 18 : 238;
          gc.fillStyle = `rgba(${v},${v},${v},${0.05 + rand() * 0.10})`;
          gc.fillRect(px + rand() * bw, by + rand() * bh, 1 + rand() * 3, 1 + rand() * 3);
        }
        gc.restore();
        // 高度：块面高一档，四周一圈暗边（倒角），块心略鼓
        const hv = Math.round(150 + lum * 100);
        gh.fillStyle = `rgb(${hv},${hv},${hv})`;
        gh.fillRect(px, by, bw, bh);
        const hg = gh.createRadialGradient(
          px + bw * 0.42, by + bh * 0.38, 1,
          px + bw * 0.5, by + bh * 0.5, Math.max(bw, bh) * 0.72,
        );
        hg.addColorStop(0, 'rgba(255,255,255,0.26)');
        hg.addColorStop(0.55, 'rgba(255,255,255,0.04)');
        hg.addColorStop(1, 'rgba(0,0,0,0.34)');
        gh.fillStyle = hg;
        gh.fillRect(px, by, bw, bh);
      };
      drawBlock(bx);
      if (bx + bw > SIZE) drawBlock(bx - SIZE);   // 横向绕回 → 无缝
      x += w;
    }
  }

  // 细颗粒（两层尺度）
  for (let i = 0; i < 16000; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const s = 1 + rand() * 2.6;
    const v = rand() < 0.5 ? 0 : 255;
    gc.fillStyle = `rgba(${v},${v},${v},${0.025 + rand() * 0.06})`;
    gc.fillRect(x, y, s, s);
    const hv = rand() < 0.5 ? 40 : 210;
    gh.fillStyle = `rgba(${hv},${hv},${hv},${0.05 + rand() * 0.09})`;
    gh.fillRect(x, y, s, s);
  }
  // 竖向水渍/青苔（上浓下淡）
  for (let i = 0; i < 22; i++) {
    const x = rand() * SIZE;
    const w = 5 + rand() * 18;
    const g2 = gc.createLinearGradient(0, 0, 0, SIZE);
    g2.addColorStop(0, 'rgba(26,40,34,0.40)');
    g2.addColorStop(0.55, 'rgba(26,40,34,0.14)');
    g2.addColorStop(1, 'rgba(26,40,34,0)');
    gc.fillStyle = g2;
    gc.fillRect(x, 0, w, SIZE);
  }
  // 崩缺 + 麻坑：颜色更深、高度更低
  for (let i = 0; i < 90; i++) {
    const x = rand() * SIZE;
    const y = rand() * SIZE;
    const rr = 1.5 + rand() * 4.6;
    gc.fillStyle = `rgba(24,22,18,${0.35 + rand() * 0.35})`;
    gc.beginPath();
    gc.arc(x, y, rr, 0, Math.PI * 2);
    gc.fill();
    gh.fillStyle = `rgba(0,0,0,${0.5 + rand() * 0.4})`;
    gh.beginPath();
    gh.arc(x, y, rr, 0, Math.PI * 2);
    gh.fill();
  }

  const color = new THREE.CanvasTexture(cCol);
  color.wrapS = color.wrapT = THREE.RepeatWrapping;
  color.anisotropy = 8;
  color.colorSpace = THREE.SRGBColorSpace;
  const height = new THREE.CanvasTexture(cHgt);
  height.wrapS = height.wrapT = THREE.RepeatWrapping;
  height.anisotropy = 4;
  height.colorSpace = THREE.NoColorSpace;
  straitStoneMaps = { color, height };
  return straitStoneMaps;
}

// 折线最近点：返回 { d, px, pz, seg, u }（u = 沿折线全程比例 0..1）
/**
 * R 键复位：从当前位置沿赛道往回退多少米。
 * 参考大型赛车网游（QQ 飞车 / 跑跑 / 极限竞速）的"退回上一段直道"手感：
 * 太短（<15m）会让玩家卡在原地反复撞墙，太长（>50m）等于白送一段路。
 * 35m ≈ 22m/s 下 1.6 秒，正常复位一次刚好重新起速。
 */
const RESPAWN_BACK = 35;

/** 沿折线按弧长取点：返回 { x, z, heading }，s 越界自动夹到两端 */
function pointAtArc(points, s) {
  const n = points.length;
  if (n < 2) return null;
  let acc = 0;
  for (let i = 0; i < n - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    if (acc + len >= s) {
      const t = Math.max(0, Math.min(1, (s - acc) / len));
      return {
        x: ax + (bx - ax) * t,
        z: az + (bz - az) * t,
        heading: Math.atan2(bx - ax, bz - az),
      };
    }
    acc += len;
  }
  const [ax, az] = points[n - 2];
  const [bx, bz] = points[n - 1];
  return { x: bx, z: bz, heading: Math.atan2(bx - ax, bz - az) };
}

/**
 * @param {number[]} [segs] 只在这些段号里找最近点（不给就全扫）。
 *   叠层赛道（立交桥 / 瀑布上下段）上，2D 最近点可能落在另一条支路上，
 *   复位会把船丢到桥下面那一层；按"本船该在的那几段"限窗就能避开。
 */
function nearestOnPolyline(points, x, z, segs) {
  let best = { d: Infinity, px: 0, pz: 0, seg: 0, t: 0 };
  let total = 0;
  const lens = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const sx = bx - ax;
    const sz = bz - az;
    const len = Math.hypot(sx, sz) || 1;
    lens.push(len);
    total += len;
    if (segs && segs.indexOf(i) < 0) continue;
    let t = ((x - ax) * sx + (z - az) * sz) / (len * len);
    t = Math.max(0, Math.min(1, t));
    const cx = ax + sx * t;
    const cz = az + sz * t;
    const d = Math.hypot(x - cx, z - cz);
    if (d < best.d) best = { d, px: cx, pz: cz, seg: i, t };
  }
  let acc = 0;
  for (let i = 0; i < best.seg; i++) acc += lens[i];
  best.u = total > 0 ? (acc + lens[best.seg] * best.t) / total : 0;
  best.total = total;
  return best;
}

// 赛道：航点门可视化 + 圈速进度判定 + 赛道机关（加速带/伸缩柱/近道/金龙过山车）
// 边缘浮桶配色（按天气）：桶身 / 环带（也用于波纹）/ 浮绳
const BUOY_PALETTES = {
  day: { body: 0xf2f6f8, band: 0x2f7fb8, rope: 0xf0a55a },
  dusk: { body: 0xf2e6cf, band: 0xd85a30, rope: 0xd85a30 },
  // 暴风雨：原来的灰桶身 + 土黄环带在雨雾里直接糊成一片，玩家看不出边界。
  // 改成「亮黄桶身 + 近黑环带」（明暗对比最强）+ 自发光（glow），
  // 再放大 18%，雨雾里就是一条发光的黄线。
  storm: {
    body: 0xffe45c, band: 0x0a0c0e, rope: 0xffd23a,
    // glowK 别拉太高：emissive 是整层叠加，1.3 以上环带也被点亮，
    // 浮桶会糊成一团发光色块、形状反而看不清。0.7 左右还能看出"黄桶 + 黑环"。
    glow: 0xffcf33, glowK: 0.7, scale: 1.18,
  },
  blizzard: { body: 0xf4fbff, band: 0x6fb3d8, rope: 0xa8d8f0 },
  // 璀璨星空：夜色雾很重（fog 0x1d2745），白天那套蓝白桶没有自发光，
  // 在暗水面里直接黑成一片、看不见赛道边界。沿用暴风雨的 glow 机制，
  // 但换成冷冰蓝发光——深蓝夜色里对比最强，又不像暴风雨的亮黄那样跳出星空氛围。
  // 桶身仍是蓝白（延续 day 的辨识语言），只是"点亮"；glowK 0.75 与 storm 同档，
  // 再高环带会被一起点亮、糊成一团光斑。
  starry: {
    // band 要压到近黑蓝（不是中蓝）：emissive 是整层叠加、不看顶点色，
    // 环带越深，被 glow 提亮后和桶身的亮度差才越大，才读得出"亮桶 + 暗环"的桶形。
    body: 0xeaf4ff, band: 0x0a1626, rope: 0x9fd8f5,
    glow: 0x8fd0ff, glowK: 0.75, scale: 1.14,
  },
};

export class Track {
  constructor(scene, mapDef, opts = {}) {
    this.map = mapDef;
    this.gates = mapDef.gates;
    this.gateWidth = mapDef.gateWidth;
    // 起点线完整宽度：旗门两腿 / 水面方格线 / 计圈判定共用同一个值，
    // 避免"柱子只横跨一半，两侧留缝，从缝里过线不计圈"。
    this.startWidth = Number(mapDef.startWidth) || this.gateWidth * 3;
    this.laps = mapDef.laps;
    this.group = new THREE.Group();
    this.scene = scene;
    this.opts = opts;
    this.mechColliders = []; // 当前升起的伸缩柱碰撞体 { x, z, r }
    // 回程码头/礁石的静态碰撞体。不放进 mechColliders —— 那个数组每帧清空重建，
    // 静态物件放进去第二帧就没了。
    this.shoreColliders = [];
    // 回程码头窄口的位置索引（给 AI 用）：{ x, z, nx, nz } ——
    // (nx,nz) 是从中心线指向码头的法线，所以"空侧"就是它的反方向。
    this.dockMarks = [];
    this.dockPassWidth = 7;
    this.courseProps = []; // 赛道道具（旗门/传送门/旋转锤/漩涡），见 #buildCourseProps
    this.shortcuts = (mapDef.shortcuts || []).map((s) => ({ ...s }));
    this.#snapShortcutEnds();
    // 潜行区：{ from, to, depth, points }，points = gates[from..to] 折线
    this.dives = (mapDef.dives || []).map((d) => ({
      ...d,
      points: mapDef.gates.slice(d.from, d.to + 1),
    }));
    // 金龙过山车：{ mode: 'manual'|'auto', from, to, ... }
    this.coasterDef = mapDef.coaster
      ? { apex: 17, entryDepth: -2.5, ...mapDef.coaster, ...(mapDef.coasterFixed || {}) }
      : null;
    // 立交桥（overpass）：{ from, to, height }。这张图的赛线在 gate 22-23 与 26-27
    // 交叉于同一点，只按坐标算高度没法区分"桥上/桥下"，所以高度挂在门索引上，
    // 船用自己已通过的门做插值（见 diveHeightAt(pos, gateHint)）。
    this.overpass = mapDef.overpass || null;
    // 烘焙赛道（Blender 中心线）：门的高度直接来自 bakedY，不走 overpass 曲线
    this.openTrack = !!mapDef.baked;
    // 闭环烘焙赛道：回程接回 0 号门后，"最后一门 = 终点"的开环捷径必须关掉，
    // 护栏/近道投影也要把最后一段连回起点（#probeMain 的 segN）
    this.loopClosed = !!(mapDef.baked && mapDef.baked.closed);
    // 中心线弧长表：圈数/进度/终点线判定都靠它（门序号会被"漏门"带偏，弧长不会）。
    // ⚠ 必须放在 openTrack / loopClosed 之后：开环烘焙赛道要少算最后那段"回卷"。
    this.#buildArcTable();
    // 悬崖边缘（无护栏段）：{ from, to, edge }。见 #edgeRule / constrain。
    this.edgeDrops = (mapDef.baked && mapDef.baked.edgeDrop) || null;
    this.gateMeshes = [];   // 烘焙赛道不建门柱，但要保证数组存在（updateVisual 会读）
    // 烘焙赛道的静态障碍（蘑菇/树）：centerline.json 的 obstacles，i 是中心线索引（每 5 点一个门）
    this.bakedObstacles = this.openTrack
      ? (mapDef.bakedObstacles || []).map((o) => ({
          x: o.x, z: o.z, r: o.r || 1.6, kind: o.kind || 'mushroom',
          y: (mapDef.bakedY && mapDef.bakedY[Math.round((o.i || 0) / 5)] != null)
            ? mapDef.bakedY[Math.round((o.i || 0) / 5)] : 0,
        }))
      : [];
    // 回程堤岸的动态障碍（垃圾桶/机器人/岩石/海草），见 #buildBakedHazards
    this.bakedHazards = [];
    this.pads = this.pads || [];
    this.marine = this.marine || { buoys: [] };
    this.gateMeshes = [];   // 烘焙赛道不建门柱，但要保证数组存在（updateVisual 会读）
    // 逐门高度（波浪栈道等）：单层赛道，按坐标即可唯一确定高度，不需要 gateHint 区分上下层
    this.gateHeights = mapDef.gateHeights && mapDef.gateHeights.length === this.gates.length
      ? mapDef.gateHeights
      : null;
    this.gateY = mapDef.bakedY
      ? mapDef.bakedY.slice()
      : this.gateHeights
        ? Float32Array.from(this.gateHeights)
        : this.#computeGateY();

    if (this.openTrack) {
      // 烘焙赛道：视觉全部来自 Blender 导出的 GLB，这里只加载 + 修材质
      this.#buildBaked(mapDef.baked);
      // GLB 里没有画起点线，但计圈判定/发车位都以 0 号门为准，
      // 补一条贴浪的方格线，玩家才看得出"这就是起跑线"。
      this.#buildStartLine();
    } else {
      this.#buildGates();
      this.#buildStartLine();
      this.#buildBarriers();
      this.#buildOverpass();
      this.#buildEdgeBuoys(this.map.buoyWeather || 'day');
      if (mapDef.style === 'palace') this.#buildGuideMarkers();
      this.#buildBoostPads();
      this.#buildShortcuts();
      this.#buildMarineFeatures();
      // 熔岩主题专属障碍（横向漂移浮桶 / 定时喷发泉）：只有声明的图才会建，
      // 其它地图连这个分支都不进。碰撞登记走 updateMechs → applyMechs 那一套，
      // 所以「主机侧一次结算、各端同一时间轴」的联机规则直接继承。
      if (mapDef.magmaHazards || mapDef.hazards) this.#buildMagmaHazards();
      // 硬核档新增的 Blender 岩石障碍：静态圆形碰撞代理 + GLB 视觉
      if (mapDef.magmaObstacles) this.#buildMagmaObstacles();
      // 断层火山带：该门之后的赛段开一道裂谷（视觉 + faultAt 判定）。
      if (mapDef.faults) this.#buildFaults();
      if (mapDef.tunnel) this.#buildTunnel();
      if (mapDef.palaceGate) this.#buildPalaceGate();
      if (this.coasterDef) this.#buildCoaster();
      if (mapDef.current) this.#buildTideCurrent(mapDef);
      if (mapDef.straitProps) this.#buildStraitProps(mapDef.straitProps);
      // 放在最后构建：需要读 shortcuts / marineFeatures / coaster 的占位来避让
      this.#buildCourseProps();
    }
    scene.add(this.group);
  }

  /** 烘焙赛道：加载 Blender 导出的段 GLB（视觉全在这里，逻辑仍走 gates/gateY） */
  #buildBaked(def) {
    if (!def || !def.models) return;
    const loader = new GLTFLoader();
    for (const m of def.models) {
      loader.load(m.url, (g) => {
        g.scene.name = 'baked_' + m.kind;
        g.scene.traverse((o) => {
          if (!o.isMesh) return;
          // 云端改螺旋塔之后，GLB 里那 4 个 cloud_* 网格是按老走线扫的实体，
          // 留着只会斜插进新坡道（"白板切进河道"就是这个）。整段隐藏，塔另建。
          // stairs_* 同属旧云端爬升段：那条从海面斜升到天上的大台阶（截图里"巨大的
          // 回旋物体横跨云端赛道"）和它旁边的水带，在新塔里已经完全被螺旋坡道取代，
          // 只在塔底/回程方向的低机位露出来，所以一并隐藏。
          if (def.tower && /^(cloud|stairs)_/i.test(o.name || '')) { o.visible = false; return; }
          // 回程岸带同理：GLB 的 return_bank 只有 4m 高，现在用 #buildReturnBank
          // 重新扫成 7m 堤岸 + 支撑柱，两套叠在一起会互相穿插（也挡视线）。
          // 只隐藏岸带，return_water 照留（程序化岸带的内缘是按它来对的）。
          if (def.returnBank && /^return_bank/i.test(o.name || '')) { o.visible = false; return; }
          // 台阶段的岩面是按旧控制点扫出来的，个别面比新 gateY 高 1~2m，
          // 会从航道水面里穿出来（实拍里"白色水道被岩石切开"就是它）。
          // 2026-11-16 用户第 3 条：隧道出口那道"横跨水面、能穿过去"的浅色带，
          // 就是被压平后的 stairs_shell（#trimBakedCorridor 把高于甲板的顶点压到
          // 甲板下 0.45m，整面墙塌成一块平板横在航道上）。
          // 阶梯段的水面和渠沿现在由塔的 approach 断面从门 23 起自己生成，
          // 所以整块 stairs_shell 直接不画。stairs_water 保留（水面对齐要用它）。
          if (/^stairs_shell$/i.test(o.name || '')) { o.visible = false; return; }
          // 山洞岩体/蘑菇：回程最后几个门从洞口外侧擦过，岩体会横跨在回程航道上。
          // 岩体向上抬成"岩檐"，蘑菇这类小件横向推出去；隧道自己的洞壁保持原样。
          if (/^cave_shell/i.test(o.name || '')) {
            // 2026-11-19：撤掉 11-18 那次「把门 7~22 走廊上方的三角面全剔除」——
            // 它连洞顶一起删了，隧道只剩两侧洞壁（用户截图「隧道只剩一半」）。
            // 当时看到的"大黑墙"其实不是几何挡路，而是洞内没有任何光源、纯 PBR
            // 直接黑成一团（场景只有半球光 + 平行光，洞里全在阴影里）。
            // 洞顶保持原样，照明改由 #buildCaveLamps 的洞内暖光灯解决。
            // 回程末段（188~206）从洞口外侧擦过，仍然只切这一段。
            if (def.returnBank) this.#cutBakedFromCorridor(o, 188, 206);
          } else if (def.returnBank && /^cave_mushrooms/i.test(o.name || '')) {
            this.#clearBakedOverCorridor(o, 86, 206, 'push');
          }
          // 水面：直接借用主游戏 Water 的 ShaderMaterial → 波浪/天光/配色与海面完全一致
          const nmLow = (o.name || '').toLowerCase();
          if (/cloud_water|forest_water|stairs_water|cave_water|return_water/.test(nmLow)) {
            if (nmLow === 'return_water' && def.returnBank) {
              // 回程水面收窄到石堤内沿（门 86..最后一门），消掉摊在白堤外的 34m 耳朵
              const from = def.returnBank.from ?? 86;
              const to = Math.min(def.returnBank.to ?? (this.gates.length - 1), this.gates.length - 1);
              this.#narrowBakedWaterToBank(o, from, to);
            }
            if (nmLow === 'forest_water' && def.beach) {
              // 2026-11-19：森林段水面同样按航道内沿收窄（门 64..86）。
              // GLB 的森林水面比白色沙岸/岸带内沿宽出一圈，实拍就是"水面赛道
              // 超出白色边缘"。收窄逻辑与回程水面完全一致。
              this.#narrowBakedWaterToBank(o, def.beach.from ?? 64, def.beach.to ?? 86);
            }
            const wm = this.#findGameWaterMaterial();
            if (wm) {
              o.material = wm;
              // 水面和岸带在 11m 处几乎贴在一起，深度值打到同一位面 →
              // 远处整条沙滩"若隐若现"，看着像显卡坏了。把水面往深度里推一点。
              wm.polygonOffset = true;
              wm.polygonOffsetFactor = -1.5;
              wm.polygonOffsetUnits = -3;
              wm.needsUpdate = true;
              o.castShadow = false;
              o.receiveShadow = false;
              o.frustumCulled = false;
              return;
            }
          }
          if (/fall_water/.test(nmLow)) {
            // 瀑布水条：GLB 那条是按 Blender 里另一套（走向 + 高度）控制点建的，
            // 跟 gateY 对不上 —— 中段既低 10m、又横向偏出去 8~20m，船看着在半空飞。
            // 这里直接弃用它，改用 #buildFallRibbon() 按门中心线现生成，
            // 水面与艇一定同高同线（艇的 y 也来自同一份 gateY）。
            o.visible = false;
            return;
          }
          if (/fall_foam/.test(nmLow)) {
            // 瀑布口那团"泡沫"在 GLB 里其实是一坨 20m×28m、y 6.8~11.3 的多面体云团，
            // 而那一带水面正好在 y=8 —— 它整块压在航道正中，还长着一副云的形状，
            // 玩家看到的就是"瀑布下来的云穿模挡路"。整段删掉：瀑布的落水感已经由
            // 落差本身 + 下方水面承担，不需要这块白布。
            o.visible = false;
            return;
          }
          // 树冠/云/泡沫不投影：上万片叶子投出来的是一片噪点，而且阴影贴图要多渲一遍整棵林
          o.castShadow = !/tree|cloud|foam|water|isles/i.test(nmLow);
          o.receiveShadow = true;
          o.frustumCulled = false;
          // 只有真的带 COLOR_0 的模型才开顶点色；贴图模型（新蘑菇）强制开会变黑
          o.material.vertexColors = !!(o.geometry && o.geometry.attributes && o.geometry.attributes.color);
          o.material.side = THREE.DoubleSide;
          // 岸带顶点色是按线性空间存的，黄昏/夜景光照一低就整片压成纯黑
          // （截图里"码头那里一坨黑色"就是它）。这里整体抬一档。
          if (/_bank$/i.test(o.name || '') && !/cloud/i.test(o.name || '')) {
            o.material.color.multiplyScalar(1.7);
          }
          // 云：任何角度都该是"会发光的白"，不该是背光纯黑。
          // 之前云海底面从下往上看是一整片深灰（截图里"上面那个灰色的一大坨"）。
          if (/^cloud_(bed|bank|isles)$/i.test(o.name || '')) {
            o.material.emissive = new THREE.Color(0xdce8f2);
            o.material.emissiveIntensity = 0.5;
            o.material.color.multiplyScalar(1.25);
          }
          const mn = o.material.name || '';
          if (mn.indexOf('cave_rock') >= 0) {
            o.material.roughness = 0.95; o.material.metalness = 0.0;
            o.material.envMapIntensity = 0.6;
          } else if (mn.indexOf('cave_cap') >= 0 || mn.indexOf('cave_stem') >= 0) {
            // 蘑菇（贴图件）：伞盖/菌柄都是自带贴图的（红底白点）。
            // 洞里太阳光被洞壁挡掉，纯 PBR 只会给出接近黑的暗红 —— 用户看到的就是
            // "蘑菇怎么这么暗，原来是鲜红的"。把贴图同时接成自发光贴图，
            // 颜色由贴图自己给（鲜红 / 米白），亮度不依赖场景光照。
            o.material.emissive = new THREE.Color(0xffffff);
            o.material.emissiveMap = o.material.map || null;
            o.material.emissiveIntensity = mn.indexOf('cave_cap') >= 0 ? 0.86 : 0.55;
            o.material.roughness = mn.indexOf('cave_cap') >= 0 ? 0.5 : 0.74;
            o.material.metalness = 0.0;
            // 贴图件不要再乘 COLOR_0（有些导出会带一层偏暗的顶点色，乘上去整个发黑）
            o.material.vertexColors = false;
            o.material.needsUpdate = true;
          } else if (mn.indexOf('cave_props') >= 0) {
            // 无贴图的顶点色蘑菇：加一点自发光，黑暗洞里才看得见
            o.material.emissive = new THREE.Color(0x2a1206);
            o.material.emissiveIntensity = 0.55;
            o.material.roughness = 0.72;
          } else if (mn.indexOf('cave_water') >= 0 || mn.indexOf('forest_water') >= 0) {
            o.material.roughness = 0.08; o.material.metalness = 0.35;
          } else if (mn.indexOf('cloud') >= 0) {
            o.material.roughness = 1.0; o.material.metalness = 0.0;
          } else if (mn.indexOf('fall') >= 0) {
            o.material.roughness = 0.22; o.material.metalness = 0.15;
          } else if (mn.indexOf('stairs') >= 0 || mn.indexOf('forest_bank') >= 0) {
            o.material.roughness = 0.96; o.material.metalness = 0.0;
          }
          o.material.roughness = o.material.roughness ?? 0.92;
          o.material.metalness = o.material.metalness ?? 0.02;
          if (o.material.map) {
            o.material.map.anisotropy = 8;
            o.material.map.needsUpdate = true;
          }
        });
        this.group.add(g.scene);
      }, undefined, (e) => console.warn('[baked] 加载失败', m.url, e));
    }
    this.#buildCaveGlow();
    this.#buildCaveLamps();
    // 云端段重做成螺旋塔之后，GLB 里那条按老走线铺的 cloud_water / cloud_bank
    // 已经对不上了（老走线是一段贴白板的大弧）—— 直接整段换成程序化生成的塔。
    if (def && def.tower) {
      this.#buildCloudTower(def);
      this.#buildApproachClouds(def);   // 隧道口 → 塔基这段两侧的浮云
    } else {
      this.#buildFallRibbon();   // 瀑布水面：按门中心线现生成（替代 GLB 里那条错位的水条）
    }
    if (def && def.returnBank) this.#buildReturnBank(def);
    // 发卡弯分叉口：入口/出口共用同一片水面，物理上无法立墙（会堵死正常路线），
    // 所以只用不参与碰撞的石墩 + 转向牌做视觉导流。
    this.#buildForkMarkers(def);
    // 洞口石拱：cave_shell 的洞口左半边没有几何（边缘是锯齿断口），
    // 从发车格看就是一个被啃掉半边的黑洞。这里沿中心线现扫一段石拱把洞口补齐。
    if (def && def.startTunnel) this.#buildStartTunnel(def);
    this.#buildForestBeach(def);
    this.#buildFallSplash();
    this.#buildShoreDressing(def);
    this.#buildBakedHazards(def);
  }

  /**
   * 把烘焙水面横向压回石堤内沿（秘境漂流回程段专用）。
   *
   * 2026-11-18：return_water 是按老控制点烘的，中线两侧各有一圈顶点伸到 34m，
   * 而程序化石堤内沿只有 gateWidth-0.4（7.1m）—— 多出来的水面就摊在白色
   * 石堤外面，玩家实拍看到"水面赛道超出白色边缘"。这里把超出内沿的顶点
   * 沿"最近中线点 → 顶点"方向拉回到内沿，保留水面本身的材质/波浪/配色。
   * 只处理石堤覆盖的门号区间，别的地方（瀑布、森林）水面照旧。
   */
  #narrowBakedWaterToBank(mesh, fromGate, toGate) {
    const geo = mesh.geometry;
    const pos = geo && geo.attributes && geo.attributes.position;
    if (!pos) return 0;
    const limit = Math.max(2, this.gateWidth - 0.4);
    mesh.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const v = new THREE.Vector3();
    let n = 0;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
      const loc = nearestOnPolyline(this.gates, v.x, v.z);
      if (loc.seg < fromGate || loc.seg > toGate) continue;
      if (loc.d <= limit) continue;
      const k2 = limit / loc.d;
      v.x = loc.px + (v.x - loc.px) * k2;
      v.z = loc.pz + (v.z - loc.pz) * k2;
      v.applyMatrix4(inv);
      pos.setXYZ(k, v.x, v.y, v.z);
      n++;
    }
    if (!n) return 0;
    pos.needsUpdate = true;
    geo.computeBoundingSphere();
    return n;
  }

  /**
   * 修剪烘焙段里插进航道的岩面顶点：横向在航道内、且高于该处水面的顶点压到水下。
   * 只用于 stairs_shell —— 那段 GLB 是按旧控制点扫的，塔基抬高后岩面比 gateY
   * 高 1~2m，从船上看就是"白色水道被岩石切开"。几何没法重烘，运行时修剪最稳。
   */
  #trimBakedCorridor(mesh) {
    const geo = mesh.geometry;
    const pos = geo && geo.attributes && geo.attributes.position;
    if (!pos) return;
    const N = this.gates.length;
    const HW = this.gateWidth;
    mesh.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const v = new THREE.Vector3();
    let n = 0;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
      const loc = nearestOnPolyline(this.gates, v.x, v.z);
      if (loc.d > HW + 2.2) continue;
      const i = loc.seg;
      const y0 = this.gateY[i] ?? 0;
      const y1 = this.gateY[(i + 1) % N] ?? y0;
      const deck = y0 + (y1 - y0) * loc.t;
      if (v.y <= deck + 0.05) continue;
      v.y = deck - 0.45;
      v.applyMatrix4(inv);
      pos.setXYZ(k, v.x, v.y, v.z);
      n++;
    }
    if (!n) return;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  /**
   * 从烘焙件里**剔除挡在回程走廊上的三角面**（在山上开洞）。
   *
   * 为什么前面几种办法都不行（都在实拍里验过）：
   *   · 横向推到走廊外 → 大岩面上挖出一个方方正正的缺口，岩体照样横在眼前；
   *   · 抬成 6m 岩檐 → 门 196~205 的航道是**从山体内部穿过去**的（最近中线离洞口
   *     轴线差 8~18m），镜头会整个埋进岩体，屏幕一片黑；
   *   · 沉到水下 → 走廊里干净了，但山体上留了一圈垂直断面 + 一个能看穿的天窗。
   * 所以改成动索引：把"三角面中心落在走廊内、且高于水面"的那批面直接从索引里去掉。
   * 岩体保持原形，只在航道上开出一个洞；洞后就是隧道自己的洞壁，读起来正是"进洞"。
   *
   * 只处理 fromGate..toGate 区间，隧道洞身（0..22）的面一个都不碰。
   */
  #cutBakedFromCorridor(mesh, fromGate, toGate) {
    const geo = mesh.geometry;
    const pos = geo && geo.attributes && geo.attributes.position;
    if (!pos) return 0;
    const N = this.gates.length;
    const PAD = this.gateWidth + 1.6;
    const idx = geo.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const at = idx ? (k) => idx.getX(k) : (k) => k;
    mesh.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const keep = [];
    for (let t = 0; t < triCount; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) {
        v.fromBufferAttribute(pos, at(t * 3 + k)).applyMatrix4(mesh.matrixWorld);
        cx += v.x; cy += v.y; cz += v.z;
      }
      cx /= 3; cy /= 3; cz /= 3;
      const loc = nearestOnPolyline(this.gates, cx, cz);
      let drop = false;
      if (loc.seg >= fromGate && loc.seg <= toGate && loc.d < PAD) {
        const y0 = this.gateY[loc.seg] ?? 0;
        const y1 = this.gateY[(loc.seg + 1) % N] ?? y0;
        const deck = y0 + (y1 - y0) * loc.t;
        if (cy > deck - 1.0) drop = true;   // 水下岩体留着，免得整片塌成悬崖
      }
      if (!drop) { keep.push(at(t * 3), at(t * 3 + 1), at(t * 3 + 2)); }
    }
    const removed = triCount - keep.length / 3;
    if (!removed) return 0;
    geo.setIndex(keep.length > 65535 ? new THREE.Uint32BufferAttribute(keep, 1) : new THREE.Uint16BufferAttribute(keep, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return removed;
  }

  /**
   * 把烘焙件从**回程航道**里清出去：只处理"最近中线落在回程门区间"的顶点。
   *
   * 为什么需要：山洞（cave_shell + 蘑菇件）是按门 0..22 那条隧道扫出来的实体，
   * 而回程最后几个门（196..206）正好从洞口外侧擦过去 —— 于是那坨 280m 长、
   * 十几米高的岩体**横跨悬浮在回程航道上方**（用户截图里"不知道是什么很大的物体
   * 横跨在这个赛道上"），蘑菇还挂在半空。
   * 隧道自己的洞壁（最近中线在 0..22）一根手指都不能动，所以按"最近门号"分区。
   *
   * 两种清法，按体量选：
   *   · `sink`（岩体）：侵入走廊的顶点直接压到水面以下 —— 和 stairs_shell 那套
   *     修剪同源。门 196~205 这段航道是**从山体里穿过去**的（最近中线离洞口轴线
   *     差 8~18m），所以抬成岩檐也不行：镜头会整个埋进岩体里，屏幕一片黑。
   *     压到水下后走廊看得到水，被拉出来的三角面沉在水下看不见。
   *   · `push`（蘑菇这类小件）：沿离开中心线的方向推到走廊外，小物件看不出形变。
   */
  #clearBakedOverCorridor(mesh, fromGate, toGate, mode = 'lift') {
    const geo = mesh.geometry;
    const pos = geo && geo.attributes && geo.attributes.position;
    if (!pos) return 0;
    const N = this.gates.length;
    const PAD = this.gateWidth + 2.2;
    const CLEAR = 6.0;
    mesh.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
    const v = new THREE.Vector3();
    let n = 0;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(mesh.matrixWorld);
      const loc = nearestOnPolyline(this.gates, v.x, v.z);
      if (loc.seg < fromGate || loc.seg > toGate) continue;
      if (loc.d >= PAD) continue;
      const a = this.gates[loc.seg];
      const b = this.gates[(loc.seg + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const deck = (this.gateY[loc.seg] ?? 0) + ((this.gateY[(loc.seg + 1) % N] ?? 0) - (this.gateY[loc.seg] ?? 0)) * loc.t;
      if (mode === 'sink') {
        // 已经在水面下的礁石不用管，只处理"露出水面、又压在走廊里"的那部分
        if (v.y <= deck - 0.2) continue;
        v.y = deck - 0.55;
      } else if (mode === 'lift') {
        // 水下的礁石不抬：抬了会把岩体底面撕开一个洞
        if (v.y <= deck + 0.4) continue;
        const want = deck + CLEAR;
        if (v.y >= want) continue;
        v.y = want;
      } else {
        let px = v.x - (a[0] + dx * loc.t);
        let pz = v.z - (a[1] + dz * loc.t);
        let len = Math.hypot(px, pz);
        if (len < 1e-3) {
          const L = Math.hypot(dx, dz) || 1;
          px = -dz / L; pz = dx / L; len = 1;
        }
        const want = PAD - loc.d;
        v.x += (px / len) * want;
        v.z += (pz / len) * want;
      }
      v.applyMatrix4(inv);
      pos.setXYZ(k, v.x, v.y, v.z);
      n++;
    }
    if (!n) return 0;
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return n;
  }

  /**
   * 森林海岸沙滩（程序化薄条）：沿航道两侧铺一条**始终高于海面**的沙岸。
   *
   * 为什么需要：forest_bank 的岸顶只有 -0.5~0.6m，海面波浪（±0.35m）一涨就把
   * 树根下面那条沙岸整片盖住 —— 玩家看到的是"树长在水里、赛道边界没了"。
   * 这里在航道外侧再铺一层 0.3→0.95m 的沙洲，海浪再高也压不下去；
   * 内缘留 0.6m 水缝，不吃掉 15m 航道。
   */
  /**
   * 洞口石拱（程序化）：把被裁坏的洞口补完整。
   *
   * 为什么不在 Blender 里修：cave_shell 是按老控制点烘的，洞口那一段**左半边压根没有面**，
   * 断口是锯齿状三角边 —— 重新烘要么重做整段洞身，要么它又和现在的 gates 错位。
   * 运行时沿门中心线扫一遍断面最稳，以后改 gate 也不会再错位。
   *
   * 断面（每 2m 一行，9 个点）：墙脚 → 直墙 → 肩 → 拱顶。
   * 半宽默认 9.4m（比走廊 7.5m 宽：视觉上把航道包住，物理上不碰船）；
   * 拱顶高 7.6m，起始行从 0 号门往后再延 24m，把发车格一起罩进洞里。
   */
  #buildStartTunnel(def) {
    const cfg = def && def.startTunnel;
    if (!cfg) return;
    const N = this.gates.length;
    const to = Math.min(N - 1, cfg.to ?? 6);
    const HW = cfg.halfWidth ?? 9.4;
    const H = cfg.height ?? 7.6;
    const BASE = cfg.base ?? -2.2;
    const RISE = cfg.rise ?? 2.4;
    const STEP = cfg.step ?? 2.0;

    const rows = [];
    // ① 0 号门之前：沿第一段方向反向延伸（发车格在后面）
    const a0 = this.gates[0];
    const a1 = this.gates[1];
    const dx0 = a1[0] - a0[0];
    const dz0 = a1[1] - a0[1];
    const L0 = Math.hypot(dx0, dz0) || 1;
    const back = cfg.back ?? 24;
    const y0 = this.gateY?.[0] ?? 0;
    for (let d = back; d > 0.001; d -= STEP) {
      rows.push({ x: a0[0] - (dx0 / L0) * d, z: a0[1] - (dz0 / L0) * d, y: y0 });
    }
    // ② 0..to 沿门中心线
    // ⚠️ 只铺到 to-1 → to 这一段（i < to）。如果写成 i <= to，会把 to → to+1 也扫进来，
    // 而后面第 ③ 步又把 to 门追加在末尾 —— 行序在洞口处"往前走一段再退回来"，
    // 倒数第二行的法线取自回退点、方向整个翻面，两个相邻断面之间会连出横跨
    // 整条隧道的三角面（lat 从 -9.4 到 +9.4）。玩家看到的就是"隧道里一堵和洞壁
    // 同色的墙、还能穿过去"（2026-11-23 用户第 1 条，实拍门 6）。
    for (let i = 0; i < to; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const ya = this.gateY?.[i] ?? 0;
      const yb = this.gateY?.[(i + 1) % N] ?? ya;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const n = Math.max(1, Math.ceil(len / STEP));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        rows.push({ x: a[0] + dx * t, z: a[1] + dz * t, y: ya + (yb - ya) * t });
      }
    }
    const last = this.gates[to];
    rows.push({ x: last[0], z: last[1], y: this.gateY?.[to] ?? 0 });
    if (rows.length < 3) return;

    // 每行的横向法线（用前后两行求方向，首尾用相邻行）
    for (let i = 0; i < rows.length; i++) {
      const p = rows[Math.max(0, i - 1)];
      const q = rows[Math.min(rows.length - 1, i + 1)];
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const L = Math.hypot(dx, dz) || 1;
      rows[i].lx = -dz / L;
      rows[i].lz = dx / L;
    }

    // 断面：墙脚 → 直墙 → 肩 → 拱（尖圆顶）→ 镜像
    // 别用半椭圆：洞口宽 18m、只拱起 2.4m 的话会平得像一个方形门框（试过，很出戏）。
    const prof = [
      [-HW, BASE], [-HW, 0], [-HW, H * 0.55],
      [-HW * 0.72, H * 0.86], [-HW * 0.40, H * 1.00], [-HW * 0.18, H + RISE * 0.85],
      [0, H + RISE],
      [HW * 0.18, H + RISE * 0.85], [HW * 0.40, H * 1.00], [HW * 0.72, H * 0.86],
      [HW, H * 0.55], [HW, 0], [HW, BASE],
    ];
    const V = [];
    const C = [];
    const F = [];
    const rock = new THREE.Color(0x463b30);
    const tmp = new THREE.Color();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // 岩石色差：按位置做一点确定性噪声，避免整段一个平色
      const nz = 0.82 + 0.18 * Math.abs(Math.sin(r.x * 0.37 + r.z * 0.61));
      for (let k = 0; k < prof.length; k++) {
        const [u, h] = prof[k];
        V.push(r.x + r.lx * u, r.y + h, r.z + r.lz * u);
        tmp.copy(rock).multiplyScalar(nz);
        // 墙面靠水面的一档压深一点，读得出"墙角"
        if (h < 0.5) tmp.multiplyScalar(0.78);
        C.push(tmp.r, tmp.g, tmp.b);
      }
    }
    const S = prof.length;
    for (let i = 0; i < rows.length - 1; i++) {
      for (let k = 0; k < S - 1; k++) {
        const a = i * S + k;
        const b = i * S + k + 1;
        const c = (i + 1) * S + k + 1;
        const d = (i + 1) * S + k;
        F.push(a, b, c, a, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setIndex(F);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0.0,
      side: THREE.DoubleSide,
      // 洞里没有直射光，纯 PBR 会黑成一团；给一点自发光把洞壁读出来
      emissive: 0x2a2118, emissiveIntensity: 1.0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'start_tunnel';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  #buildForestBeach(def) {
    const cfg = def && def.beach;
    if (!cfg) return;
    const N = this.gates.length;
    const from = Math.max(0, cfg.from ?? 64);
    const to = Math.min(cfg.to ?? N - 1, N - 1);
    const HW = this.gateWidth;
    const C_WET = new THREE.Color(0xd6c39a);
    const C_SAND = new THREE.Color(0xefe0bd);
    const C_DRY = new THREE.Color(0xe6d6b2);

    const V = [], C = [], F = [];
    const pushV = (x, y, z, c) => { V.push(x, y, z); C.push(c.r, c.g, c.b); return V.length / 3 - 1; };
    const rows = [];
    for (let i = from; i < to; i++) {
      const a = this.gates[i], b = this.gates[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const n = Math.max(1, Math.ceil(len / 3.2));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        rows.push({ x: a[0] + dx * t, z: a[1] + dz * t, nx: -dz / len, nz: dx / len, i });
      }
    }
    if (rows.length < 4) return;
    // 两端各 18m 沉进水里，别在海面上切一刀断面
    const FADE = 18;
    let acc = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (i) acc += Math.hypot(r.x - rows[i - 1].x, r.z - rows[i - 1].z);
      r.s = acc;
      r.dist = 0;
    }
    for (let i = rows.length - 1, back = 0; i >= 0; i--) {
      if (i < rows.length - 1) back += Math.hypot(rows[i].x - rows[i + 1].x, rows[i].z - rows[i + 1].z);
      rows[i].dist = back;
    }
    for (const r of rows) {
      const f = Math.min(1, r.s / FADE, r.dist / FADE);
      r.yo = -2.4 * (1 - f);
    }
    // 2026-11-16 用户第 5 条：「白色东西横跨在水面上，夹在水面当中」= 这条沙洲。
    // 原来是 HW+17.5 处直接沉到水下（y=-1.3），沙洲在水面中间生生断掉，
    // 低机位看就是两条白带横在河心、两头不着岸。
    // 现在保持近岸的高度不变（1.15~1.25，还是那条能看出来的沙岸），
    // 但**一路铺到 40m 外的树林脚下**，只有最外沿没入水里 —— 读起来是河岸，不是白条。
    const LATS = [
      [HW + 0.5, 0.30, C_WET],
      [HW + 2.0, 0.78, C_SAND],
      [HW + 6.0, 1.15, C_SAND],
      [HW + 13.0, 1.25, C_DRY],
      [HW + 22.0, 1.18, C_DRY],
      [HW + 32.0, 0.95, C_DRY],
      [HW + 40.0, -1.2, C_WET],
    ];
    for (const r of rows) {
      const side = [];
      for (const s of [-1, 1]) {
        const ox = r.nx * s, oz = r.nz * s;
        // 外缘做 ±1.6m 的起伏，免得沙洲边线是一条死直线
        const sway = Math.sin(r.s * 0.083 + s * 1.7) * 1.6 + Math.sin(r.s * 0.031) * 1.2;
        side.push(LATS.map(([lat, y, col], k) => pushV(
          r.x + ox * (lat + (k >= 2 ? sway : 0)), y + r.yo, r.z + oz * (lat + (k >= 2 ? sway : 0)), col,
        )));
      }
      r.sides = side;
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      if (Math.hypot(a.x - b.x, a.z - b.z) > 12) continue;
      for (let s = 0; s < 2; s++) {
        const A = a.sides[s], B = b.sides[s];
        for (let k = 0; k < LATS.length - 1; k++) {
          F.push(A[k], A[k + 1], B[k + 1], A[k], B[k + 1], B[k]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setIndex(F);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0.0, side: THREE.DoubleSide,
      emissive: 0x4a3f2a, emissiveIntensity: 0.14,
    });
    const beach = new THREE.Mesh(geo, mat);
    beach.name = 'forest_beach';
    beach.castShadow = false;
    beach.receiveShadow = true;
    beach.frustumCulled = false;
    this.group.add(beach);
  }

  /**
   * 回程岸带（程序化）：石砌码头断面 —— 竖直堤身 + 走道 + 女儿墙 + 壁柱。
   *
   * 为什么不用 return_shell.glb：那份是"贴着海面的一条草带"（return_bank 包围盒
   * y 只有 -0.9~3.5），从船上看完全读不出"这是一条走廊"。
   *
   * 断面（单侧，lat 从中心线算起，y 相对该门的水面）：
   *   ① 堤身：HW-0.4 @ -1.2 → HW+0.4 @ H（0.8m 收分，低角度看得出是"墙"不是"纸片"）
   *   ② 走道：HW+0.4 @ H → HW+2.6 @ H（浅色，远看就是一条边线）
   *   ③ 女儿墙：HW+2.6 @ H → HW+2.6 @ H+P → HW+3.3 @ H+P+0.25 → HW+3.3 @ -1.2
   *   ④ 壁柱：每 pierStep 米一根方柱，立在女儿墙外沿、从水下升到墙顶以上
   *
   * ⚠️ 回程有一段自己压在自己身上，必须按"空间距离"而不是"网格去重"处理：
   *   · 门 148~154 与 122~130 是**同一条线**（第三次折返原路返回，重合 0~2m）——
   *     第二遍的行直接丢掉，否则墙画两遍、exact z-fighting；
   *   · 门 147 / 155 是"发卡出口并回主道"的过渡行，离另一段只有 9~11m，
   *     不到一个航道宽（15m）。两边都建墙的话，其中一段的墙会**横切**另一段的
   *     河道 —— 实拍里门 122 那道斜着压在水面上的墙就是这么来的。
   *     这种"分叉口"两侧的行都不建墙，让两条走廊在这里敞口相接。
   *   · 连面时还要按空间距离断带：被丢掉的那几行会让前后两行隔开几十米，
   *     直接连面会拉出一条横跨几百米的破面。
   */
  #buildReturnBank(def) {
    const cfg = def.returnBank;
    const N = this.gates.length;
    const from = cfg.from ?? 86;
    // to 是"开区间终点门号"（209 表示一直铺到最后一门 208），必须夹到 N-1，
    // 否则 i+1 会读到 gates[N] = undefined。
    const to = Math.min(cfg.to ?? (N - 1), N - 1);
    const HW = this.gateWidth;
    const H = cfg.height ?? 3.4;            // 堤顶（走道面）离水面高度
    const P = cfg.parapet ?? 0.95;          // 女儿墙高度
    const CAP = 0.25;                       // 压顶外倾
    const W_WALK = cfg.walk ?? 2.2;         // 走道净宽
    const L_OUT = HW + 0.4 + W_WALK + 0.7;  // 女儿墙外沿 lat
    const C_FACE = new THREE.Color(cfg.color ?? 0xcfc3a2);
    const C_TOP = new THREE.Color(cfg.topColor ?? 0xe8e0c6);
    const C_COL = new THREE.Color(cfg.columnColor ?? 0xbfc7cd);

    const V = [], C = [], F = [];
    const pushV = (x, y, z, c) => { V.push(x, y, z); C.push(c.r, c.g, c.b); return V.length / 3 - 1; };
    const rows = [];
    // 空间网格的格边必须 ≥ 查询半径：3×3 邻格只能覆盖"格号差 1"，
    // 半径 14 配 8m 格会漏掉 9~16m 这一圈 —— 而分叉口恰恰就在 9.7m / 10.6m 上。
    const CELL = 14;
    const grid = new Map();
    const gkey = (x, z) => `${Math.floor(x / CELL)}|${Math.floor(z / CELL)}`;
    const nearRows = (x, z, rad) => {
      const out = [];
      const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const arr = grid.get(`${cx + a}|${cz + b}`);
          if (!arr) continue;
          for (const idx of arr) {
            const r = rows[idx];
            const d = Math.hypot(r.x - x, r.z - z);
            if (d <= rad) out.push({ idx, d });
          }
        }
      }
      return out;
    };
    for (let i = from; i < to; i++) {
      const a = this.gates[i], b = this.gates[i + 1];
      // 回程目前全程 y=0（海面），但仍然读 gateY 而不是写死 0 ——
      // 以后要是把回程某个发卡抬高，岸带会自动跟着走。
      const y0 = this.gateY[i] ?? 0, y1 = this.gateY[i + 1] ?? y0;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const n = Math.max(1, Math.ceil(len / 2.5));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a[0] + dx * t, z = a[1] + dz * t;
        // 只跟"门号差 ≥10"的行比：相邻门本来就是同一条走廊，不能自己跟自己冲突
        const hit = nearRows(x, z, 14).filter((o) => Math.abs(rows[o.idx].i - i) >= 10);
        if (hit.some((o) => o.d <= 3.2)) continue;   // 同一条走廊的第二遍：直接丢
        if (hit.length) {                            // 分叉/并回口：两边都不建墙
          for (const o of hit) rows[o.idx].skip = true;
          continue;
        }
        rows.push({ x, z, nx: -dz / len, nz: dx / len, y: y0 + (y1 - y0) * t, i });
        const gk = gkey(x, z);
        if (!grid.has(gk)) grid.set(gk, []);
        grid.get(gk).push(rows.length - 1);
      }
    }
    if (rows.length < 6) return;
    // 相邻保留行之间的水平距离：>8m 说明中间那段被去重掉了，不连面
    const gapOf = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

    // 收尾渐隐：最后 FADE 米把堤身和女儿墙一起压到水面以下，像顺着坡沉进海里，
    // 而不是在水面上切一刀断面。回程并入点正好在隧道口前面，隧道不能有这道墙。
    const FADE = cfg.fade ?? 30;
    const SINK = cfg.sink ?? 3.6;   // 渐隐区整体下沉的深度（要盖过 H+P+CAP）
    // 出发直道（门 0..HEAD）是"回程最后压上来"的那个方向上的主赛道：
    // 门 204 距门 0 只有 10.0m、门 206 距门 2 只有 1.8m（实测），岸带照铺就会
    // 从隧道里长出来一堵石墙。这里按"到出发直道中心线的距离"再压一次高度。
    //
    // ⚠️ 判据是**墙脚**的距离，不是行中心的距离：断面从 HW-0.4 一直铺到 L_OUT(≈10.8m)，
    // 行中心离出发直线 11.6m 时，靠航道那一侧的墙脚已经压到主航道里面去了
    // （实拍里出发点那块"漂在水上的浅色板"就是这么来的）。
    // 所以用 (最近门距 − L_OUT − 航道半宽)，留 2m 余量后线性过渡到 11m 外恢复满高。
    const HEAD = Math.min(from, 9);
    const headPts = [];
    for (let i = 0; i <= HEAD; i++) if (this.gates[i]) headPts.push(this.gates[i]);
    const HEAD_CLEAR = HW + 2;                     // 墙脚要离开航道中心线这么远才允许满高
    const headClear = (x, z) => {
      let best = Infinity;
      for (const g of headPts) {
        const d = Math.hypot(g[0] - x, g[1] - z);
        if (d < best) best = d;
      }
      return Math.max(0, Math.min(1, (best - L_OUT - HEAD_CLEAR) / 11));
    };
    {
      let acc = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (i < rows.length - 1) acc += gapOf(rows[i], rows[i + 1]);
        const tail = FADE > 0 ? Math.min(1, acc / FADE) : 1;
        const f = Math.min(tail, headClear(rows[i].x, rows[i].z));
        rows[i].fade = f;
        rows[i].h = H * f;
        rows[i].p = P * Math.min(1, f * 1.7);
        // 只压高度是不够的：h→0 时走道面正好落在 y=0 的水面上，跟水面抢深度，
        // 从出发机位看就是一块漂在水上的浅色板。整体往下沉 SINK 米才是真的"沉进海里"。
        rows[i].yo = -SINK * (1 - f);
      }
    }

    for (const r of rows) {
      if (r.skip) { r.sides = null; continue; }
      const rh = r.h, rp = r.p, rc = CAP * r.fade;
      const yb = r.y + r.yo;                        // 渐隐区整段下沉后的基准面
      const side = [];
      for (const s of [-1, 1]) {
        const ox = r.nx * s, oz = r.nz * s;
        const p = (lat, hh, col) => pushV(r.x + ox * lat, yb + hh, r.z + oz * lat, col);
        side.push({
          b0: p(HW - 0.4, -1.2, C_FACE),        // 堤身底（压到水下 1.2m）
          b1: p(HW + 0.4, rh, C_FACE),          // 堤顶内沿（0.8m 收分）
          b2: p(HW + 0.4 + W_WALK, rh, C_TOP),  // 走道外沿 / 女儿墙内脚
          b3: p(HW + 0.4 + W_WALK, rh + rp, C_TOP),  // 女儿墙内侧顶
          b4: p(L_OUT, rh + rp + rc, C_TOP),    // 压顶外沿
          b5: p(L_OUT, -1.2, C_FACE),           // 女儿墙外侧落到水下
        });
      }
      r.sides = side;
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i], b = rows[i + 1];
      if (!a.sides || !b.sides) continue;         // 分叉口被跳过的行
      if (gapOf(a, b) > 8) continue;              // 断带：这一对跨过了被去重的一段
      for (let s = 0; s < 2; s++) {
        const A = a.sides[s], B = b.sides[s];
        F.push(A.b0, A.b1, B.b1, A.b0, B.b1, B.b0);   // 堤身
        F.push(A.b1, A.b2, B.b2, A.b1, B.b2, B.b1);   // 走道
        F.push(A.b2, A.b3, B.b3, A.b2, B.b3, B.b2);   // 女儿墙内侧
        F.push(A.b3, A.b4, B.b4, A.b3, B.b4, B.b3);   // 压顶
        F.push(A.b4, A.b5, B.b5, A.b4, B.b5, B.b4);   // 女儿墙外侧
      }
    }

    // ---------- 墙面装饰锚点（Blender 出的 GLB 原型件）----------
    // 收分堤身的内坡（b0→b1：0.8m / 4.6m ≈ 9.9°）正好当画墙：4.8×2m 的浮雕板
    // 顺着坡度贴上去，板面朝航道，船上抬头就是一幅壁画。
    // 只在 fade ≥ 0.9 且前后 ±5m 都是直墙的位置摆 —— 弯心硬贴会插进石头里。
    const decor = { murals: [], shells: [], gulls: [], lamps: [], reliefs: [], banners: [], crenels: [] };
    const flatAt = (idx) => {
      const c = rows[idx];
      if (!c.sides || c.fade < 0.9) return false;
      for (let k = idx - 2; k <= idx + 2; k++) {
        if (k <= 0 || k >= rows.length) return false;
        const t = rows[k];
        if (!t.sides || t.fade < 0.9) return false;
        if (gapOf(rows[k - 1], t) > 3.6) return false;
        if (t.nx * c.nx + t.nz * c.nz < 0.955) return false;
      }
      return true;
    };
    // 内坡倾角：局部 X 轴旋转，让板面法线朝航道内侧并向上偏
    const SPLAY = Math.atan2(0.8, H + 1.2);
    const at = (r, s, lat, up) => ({
      x: r.x + r.nx * s * lat, y: r.y + r.yo + up, z: r.z + r.nz * s * lat,
    });
    let mAcc = 22, mKind = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      mAcc += gapOf(rows[i - 1], r);
      if (mAcc < 40 || !flatAt(i)) continue;
      const u = 0.62;                       // 沿内坡的位置：面板中心在 y≈1.65m
      const latFace = HW - 0.4 + 0.8 * u;
      for (const s of [-1, 1]) {
        // 内移 0.10m：板背（局部 z=-0.08）刚好离墙面 2cm，既不埋墙也不悬空
        const p = at(r, s, latFace - 0.10, -1.2 + (r.h + 1.2) * u);
        decor.murals.push({
          x: p.x, y: p.y, z: p.z,
          rot: Math.atan2(-r.nx * s, -r.nz * s),
          tilt: -SPLAY,
          kind: mKind,
        });
      }
      mAcc = 0;
      mKind = 1 - mKind;
    }
    // ---------- 浮雕壁板：同样贴内坡，每 24m 一块、左右交替 ----------
    // 比壁画（40m）密一档。两者贴在**同一段坡面**上，撞在一起就是两块板互相插进
    // 对方里，所以按空间距离过滤：壁画半宽 1.6m + 壁板半宽 1.2m = 2.8m，留 3.2m。
    let rAcc = 4, rSide = 1;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      rAcc += gapOf(rows[i - 1], r);
      if (rAcc < 24 || !flatAt(i)) continue;
      rAcc = 0;
      const s = rSide;
      rSide = -rSide;
      // u = 0.5：板心落在内坡正中（相对水面 ≈ +1.1m），2.4×1.6m 的板正好被
      // -1.2~+3.4m 的坡面完整托住，不会有一半探到走道以上。
      const u = 0.5;
      // 内移 0.02m：板背（局部 z=0）埋进墙里，避开与堤身共面闪烁
      const p = at(r, s, HW - 0.4 + 0.8 * u - 0.02, -1.2 + (r.h + 1.2) * u);
      if (decor.murals.some((m) => Math.hypot(m.x - p.x, m.z - p.z) < 3.2)) continue;
      decor.reliefs.push({
        x: p.x, y: p.y, z: p.z,
        // 与壁画相反：浮雕的正面在局部 -Z，让 -Z 朝航道才能被船看到
        rot: Math.atan2(r.nx * s, r.nz * s),
        tilt: -SPLAY,
      });
    }
    let sAcc = 40, sSide = 1;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      sAcc += gapOf(rows[i - 1], r);
      if (sAcc < 68 || !flatAt(i)) continue;
      // 贝壳雕塑立在走道靠航道那一侧（lat HW+1.6），从船上能看到剪影
      const p = at(r, sSide, HW + 0.4 + W_WALK * 0.55, r.h + 0.02);
      decor.shells.push({
        x: p.x, y: p.y, z: p.z,
        rot: Math.atan2(-r.nx * sSide, -r.nz * sSide),
      });
      sAcc = 0;
      sSide = -sSide;
    }
    // ---------- 灯柱：走道靠女儿墙一侧，每 40m 一根、左右交替 ----------
    // 石堤本身是一整片灰白，从船上开过去像一条水泥水渠 —— 加一排带贴图的灯柱，
    // 天际线上立刻有节奏，也让"这是城墙走道"读得出来（用户："城墙整体都很丑，
    // 没有什么装饰物"）。墙体结构件沿用石堤自己的顶点色几何，装饰件才用 GLB。
    let lAcc = 10, lSide = 1;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      lAcc += gapOf(rows[i - 1], r);
      if (lAcc < 40 || !r.sides || r.fade < 0.9) continue;
      lAcc = 0;
      const lat = HW + 0.4 + W_WALK - 0.30;      // 贴着女儿墙内侧的走道边
      const p = at(r, lSide, lat, r.h + 0.02);
      decor.lamps.push({
        x: p.x, y: p.y, z: p.z,
        rot: Math.atan2(-r.nx * lSide, -r.nz * lSide),
      });
      lSide = -lSide;
    }
    // ---------- 旗杆旗帜：走道靠女儿墙一侧，每 ~85m 一根、左右交替 ----------
    // 石堤全长一千多米，光靠灯柱还是"一条水泥渠"；立几根 6m 高的旗杆，
    // 船老远就能看见天际线上一串飘动的红幡，城墙的"城"味才出来。
    // 间距定 85m：左右交替后单侧 170m 一根，转向时的直道上总有一根在视野里；
    // 再稀（120m）就只能碰运气才看得到。
    let bAcc = 60, bSide = 1;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      bAcc += gapOf(rows[i - 1], r);
      if (bAcc < 85 || !r.sides || r.fade < 0.9) continue;
      bAcc = 0;
      const s = bSide;
      bSide = -bSide;
      // 灯柱和贝壳雕塑都站在这条走道上，撞上就跳过一个周期（旗杆底座 0.48m 见方，
      // 但旗面横展 1.36m，留 3m 才不会被灯柱杆身穿过去）
      const p = at(r, s, HW + 0.4 + W_WALK - 0.42, r.h + 0.02);
      const busy = decor.lamps.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3)
        || decor.shells.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3);
      if (busy) continue;
      decor.banners.push({
        x: p.x, y: p.y, z: p.z,
        // 旗面在局部 XY 平面（法线 ±Z）：让 -Z 朝航道，船从侧面看是整幅旗，不是一条线
        rot: Math.atan2(r.nx * s, r.nz * s),
      });
    }
    // ---------- 壁柱：每 pierStep 米一根，立在女儿墙外沿，从水下升到压顶以上 ----------
    // 直接并进同一份顶点色几何，而不是另起一个 InstancedMesh：
    // 实例化柱在不同光照/环境下会跟堤身完全对不上色（实拍里柱身被压成深蓝，
    // 一排看过去像铁栏杆）。同一份几何 = 同一套光照 = 一定是同一块石头。
    const step = cfg.pierStep ?? 16;
    const topY = cfg.pierTop ?? 1.2;               // 柱顶高出压顶的高度（天际线节奏）
    const pushBox = (cx, cz, nx, nz, tx, tz, y0, y1, colSide, colTop) => {
      const hT = 0.58, hN = 0.5;                   // 沿切线 1.16m、沿法线 1.0m
      const at = (a, b, y, c) => pushV(
        cx + tx * a * hT + nx * b * hN, y, cz + tz * a * hT + nz * b * hN, c,
      );
      const v = [
        at(-1, -1, y0, colSide), at(-1, 1, y0, colSide), at(1, -1, y0, colSide), at(1, 1, y0, colSide),
        at(-1, -1, y1, colSide), at(-1, 1, y1, colSide), at(1, -1, y1, colSide), at(1, 1, y1, colSide),
      ];
      const quad = (i, j, k, l) => F.push(v[i], v[j], v[k], v[i], v[k], v[l]);
      quad(0, 1, 3, 2);          // 底面
      quad(4, 6, 7, 5);          // 顶面
      quad(0, 4, 5, 1);          // 切线 −侧
      quad(2, 3, 7, 6);          // 切线 +侧
      quad(0, 2, 6, 4);          // 法线 −侧（朝河道）
      quad(1, 5, 7, 3);          // 法线 +侧（朝海）
    };
    let acc = step * 0.5;                          // 错开半个间距，起点不堆在发车线上
    const pierTops = [];
    const pierHit = [];                            // 垛口避让用：柱身的平面位置
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      const d = gapOf(a, b);
      // 断带 / 分叉口跳过的行：重新起算间距，别把柱子摆进缺口
      if (d > 8 || !b.sides) { acc = 0; continue; }
      acc += d;
      if (acc < step) continue;
      acc = 0;
      // 柱顶必须跟着收尾渐隐一起往下沉，而且渐隐区干脆不摆柱子：
      // 堤身已经沉到水面下、柱顶还剩 2m 的话，隧道口就浮着一排方块。
      if (b.fade < 0.9) continue;
      const top = b.y + b.yo + b.h + b.p + CAP * b.fade + topY * b.fade;
      const tx = -b.nz, tz = b.nx;                 // 切线方向
      for (const s of [-1, 1]) {
        pushBox(
          b.x + b.nx * s * (L_OUT - 0.35),
          b.z + b.nz * s * (L_OUT - 0.35),
          b.nx * s, b.nz * s, tx, tz,
          b.y + b.yo - 1.2, top, C_COL, C_TOP,
        );
        // 壁柱顶给海鸥：整条回程的柱廊天际线就有了活物
        pierTops.push({ x: b.x + b.nx * s * (L_OUT - 0.35), z: b.z + b.nz * s * (L_OUT - 0.35), y: top, ox: b.nx * s, oz: b.nz * s });
        pierHit.push({ x: b.x + b.nx * s * (L_OUT - 0.35), z: b.z + b.nz * s * (L_OUT - 0.35) });
      }
    }
    // 每 2~3 根柱子（单侧约 40m）停一只海鸥，左右错开、朝向偏一点
    // （pierTops 是左右成对入栈的，步长取奇数才能保证左右交替）
    for (let k = 0; k < pierTops.length; k += 5) {
      const t = pierTops[k];
      decor.gulls.push({
        x: t.x - t.ox * 0.06, y: t.y, z: t.z - t.oz * 0.06,
        rot: Math.atan2(-t.ox, -t.oz) + (k % 2 ? 0.5 : -0.5),
      });
    }

    // ---------- 垛口：压顶顶面，沿弧长每 6m 一组、两侧都有 ----------
    // 女儿墙顶现在是一条平的光带（4.6m 高的墙看不出"这是城墙"）。垛口模块
    // 长 6m、宽 0.7m（正好等于压顶宽）、底面包住 0.25m 的外倾斜面，
    // 一压上去整条回程的天际线就是锯齿状的了。
    //
    // 两个坑：
    //   ① 壁柱也立在同一个 lat（L_OUT-0.35）上、比压顶还高 1.2m，6m 的模块
    //      会横穿柱身 —— 离任何壁柱 3.6m（半长 3.0 + 柱半宽 0.58）以内整组跳过，
    //      柱身自己把垛口断开，比把模块切成 4m 的碎块好看；
    //   ② 行距在 0~2.5m 之间浮动，按"行"取整会出现 4m/8m 交替的疏密节奏，
    //      所以按累积弧长插值定位，保证严格 6m 一组。
    {
      const SPACING = 6.0;
      const CLR = 3.6;
      const S = [0];
      for (let i = 1; i < rows.length; i++) S[i] = S[i - 1] + gapOf(rows[i - 1], rows[i]);
      let nextC = 4.0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        const d = S[i] - S[i - 1];
        // 断带（跨过被去重掉的航段）或分叉口：弧长重新起算，别把垛口摆进缺口
        if (d > 8 || !a.sides || !b.sides) { nextC = S[i] + SPACING * 0.5; continue; }
        if (S[i] < nextC) continue;
        const t = d > 1e-6 ? (nextC - S[i - 1]) / d : 0;
        nextC += SPACING;
        if (b.fade < 0.9) continue;
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
        let nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;
        const hh = a.h + (b.h - a.h) * t;
        const pp = a.p + (b.p - a.p) * t;
        const yo = a.yo + (b.yo - a.yo) * t;
        const yy = a.y + (b.y - a.y) * t;
        const f = a.fade + (b.fade - a.fade) * t;
        for (const s of [-1, 1]) {
          const cx2 = px + nx * s * (L_OUT - 0.35);
          const cz2 = pz + nz * s * (L_OUT - 0.35);
          if (pierHit.some((q) => Math.hypot(q.x - cx2, q.z - cz2) < CLR)) continue;
          decor.crenels.push({
            x: cx2, z: cz2,
            // 压顶在中点（lat 10.45）的高度 = 堤顶 + 女儿墙 + 半个外倾
            y: yy + yo + hh + pp + CAP * f * 0.5,
            rot: Math.atan2(-nx * s, -nz * s),
          });
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setIndex(F);
    geo.computeVertexNormals();
    const bankMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.94, metalness: 0.0, side: THREE.DoubleSide,
    });
    const bank = new THREE.Mesh(geo, bankMat);
    bank.name = 'return_bank_proc';
    // 堤身背光面会整片压成黑（实拍里就是一堵黑洞墙）：给它一点自发光兜底
    bankMat.emissive = new THREE.Color(0x3c3a34);
    bankMat.emissiveIntensity = 1.0;
    bank.castShadow = false; bank.receiveShadow = true; bank.frustumCulled = false;
    bank.userData.rowsDebug = rows.map((r) => [+r.x.toFixed(1), +r.z.toFixed(1), +r.fade.toFixed(2), r.i, +r.y.toFixed(2), r.skip ? 1 : 0]);
    this.group.add(bank);

    this.#buildReturnBankDecor(decor);
  }

  /**
   * 回程石堤的 GLB 装饰：壁画（堤身内坡）+ 贝壳雕塑（走道）+ 海鸥（壁柱顶）。
   * 全部是 Blender 建模导出的 .glb（内嵌石材/玉/青铜贴图），这里只做克隆摆放：
   *   · 原型原点不一定在底部，按包围盒把底面贴到锚点高度；
   *   · 壁画按 10° 收分贴合内坡，法线朝航道；
   *   · 异步加载失败只是少几个装饰，不影响赛道本身。
   */
  #buildReturnBankDecor(decor) {
    if (!decor) return;
    const spawn = (url, items, init, tone) => {
      if (!items.length) return;
      new GLTFLoader().load(url, (g) => {
        if (!this.group.parent) return;
        const src = g.scene;
        src.updateMatrixWorld(true);
        // 原型的材质统一收一遍：青铜件在本作没有环境贴图，纯 PBR 金属会渲染成
        // 死黑（实拍里壁画边框是一道黑条）；石材/玉/贝壳补一点自发光，
        // 背光面才不会压成剪影，白海鸥也不会变成深蓝。
        src.traverse((m) => {
          if (!m.isMesh || !m.material) return;
          const mat = m.material;
          const mn = (mat.name || '').toLowerCase();
          if (mn.includes('bronze')) {
            mat.metalness = 0.2;
            mat.roughness = 0.5;
            mat.emissive = new THREE.Color(0x2a2010);
            mat.emissiveIntensity = 0.7;
          } else if (mn.includes('gull')) {
            mat.metalness = 0;
            mat.emissive = mat.color.clone().multiplyScalar(0.24);
            mat.emissiveIntensity = 1;
          } else {
            mat.metalness = Math.min(mat.metalness ?? 0, 0.08);
            // 内坡整面几乎都在阴影里：只靠环境光的话石板会压成一块深蓝补丁，
            // 补一点暖石色自发光，壁画在背光面也读得出来
            mat.emissive = new THREE.Color(tone ? tone.color : 0x5a4f40);
            mat.emissiveIntensity = tone ? tone.intensity : 0.34;
          }
          mat.needsUpdate = true;
        });
        // 原型底面到原点的距离（海鸥腿底 -0.42m、贝壳底座 -0.21m、壁画 -0.08m 各不相同）
        const bottom = new THREE.Box3().setFromObject(src).min.y;
        // 同一件装饰要沿整条回程摆几十个：逐个 clone 会是上百个 draw call，
        // 先按材质把实例几何烘到世界坐标再合批，最后每种材质只剩一个 mesh。
        const byMat = new Map();
        for (const it of items) {
          const o = src.clone(true);
          init(o, it, bottom);
          o.updateMatrixWorld(true);
          o.traverse((m) => {
            if (!m.isMesh || !m.geometry) return;
            const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
            const mat = Array.isArray(m.material) ? m.material[0] : m.material;
            if (!mat) return;
            if (!byMat.has(mat)) byMat.set(mat, []);
            byMat.get(mat).push(geo);
          });
        }
        const grp = new THREE.Group();
        grp.name = 'bank_decor_' + url.split('/').pop().replace(/\.glb.*/i, '');
        for (const [mat, geos] of byMat) {
          const merged = mergeGeometries(geos, false);
          if (!merged) continue;
          const mesh = new THREE.Mesh(merged, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          grp.add(mesh);
        }
        this.group.add(grp);
      }, undefined, (e) => console.warn('[bank-decor] 加载失败', url, e));
    };

    // 壁画：两块交替，避免整条墙重复同一张图
    const koi = decor.murals.filter((m) => m.kind === 0);
    const shellMural = decor.murals.filter((m) => m.kind === 1);
    const placeMural = (o, it, bottom) => {
      o.position.set(it.x, it.y, it.z);
      // YXZ：先按收分绕局部 X 倾斜，再绕 Y 转向航道
      o.rotation.set(it.tilt, it.rot, 0, 'YXZ');
      // 原型是 4.8×2m，贴到只有 4.6m 高的内坡上就是一块"广告牌"（实拍确认：
      // 一眼看过去像两面空白告示板）。收到 3.2×1.3m 才读得出是浮雕壁画。
      o.scale.setScalar(0.66);
    };
    spawn('/models/decor/wall_mural_koi.glb', koi, placeMural);
    spawn('/models/decor/wall_mural_shell.glb', shellMural, placeMural);

    spawn('/models/decor/shell_sculpture.glb', decor.shells, (o, it, bottom) => {
      const k = 1.7;
      o.scale.setScalar(k);
      o.position.set(it.x, it.y - bottom * k, it.z);
      o.rotation.y = it.rot;
    });

    // 灯柱：全项目唯一一件自带贴图的街景件（public/models/low_poly_street_light_pole.glb
    // 里有一张 albedo），立在走道上当"城墙有人的痕迹"的证据。
    spawn('/models/low_poly_street_light_pole.glb', decor.lamps, (o, it, bottom) => {
      // 原型 15.8m 高：原尺寸立在 4.6m 的堤墙上会像一排电线杆，收到 9.5m
      const k = 0.6;
      o.scale.setScalar(k);
      o.position.set(it.x, it.y - bottom * k, it.z);
      o.rotation.y = it.rot;
      o.traverse((m) => {
        if (!m.isMesh || !m.material) return;
        // 贴图件不要再乘顶点色（部分导出会带一层偏暗的 COLOR_0，乘上去整根发黑）
        m.material.vertexColors = false;
        m.material.metalness = 0.05;
        m.material.roughness = 0.7;
        m.material.needsUpdate = true;
      });
    });

    spawn('/models/decor/gull_statue.glb', decor.gulls, (o, it, bottom) => {
      const k = 1.4;
      o.scale.setScalar(k);
      o.position.set(it.x, it.y - bottom * k, it.z);
      o.rotation.y = it.rot;
    });

    // 垛口：6m 一组的模块，压在压顶顶面（局部原点在底面以上 2cm，靠 bottom 归位）
    spawn('/models/decor/wall_crenel.glb', decor.crenels, (o, it, bottom) => {
      o.position.set(it.x, it.y - bottom, it.z);
      o.rotation.y = it.rot;
    });

    // 浮雕壁板：2.4×1.6m，原点就是板心（不做 bottom 补偿，tilt 之后补偿会跑偏）
    spawn('/models/decor/wall_relief.glb', decor.reliefs, (o, it) => {
      o.position.set(it.x, it.y, it.z);
      o.rotation.set(it.tilt, it.rot, 0, 'YXZ');
    });

    // 旗杆旗帜：原型 6.42m 高、底在 z=0。红布配暖石色自发光会发灰，
    // 这里单独给一层更暗更红的兜底（旗面本身占 1.1×2.5m，是整条墙唯一的暖色）
    spawn('/models/decor/wall_banner.glb', decor.banners, (o, it, bottom) => {
      o.position.set(it.x, it.y - bottom, it.z);
      o.rotation.y = it.rot;
    }, { color: 0x4a1712, intensity: 0.85 });
  }

  /**
   * 云端螺旋塔（程序化）：塔柱 + 上升/下降螺旋坡道 + 塔顶平台 + 出口高架水槽。
   *
   * 为什么要在 JS 里现生成，而不是继续用 Blender 的 cloud_shell.glb：
   *   ① 这次是把门 30..65 的中心线和 gateY 整段重排成双螺旋，老 GLB 是按老走线
   *      扫出来的实体，改完就完全对不上（水面在半空、岸带切进坡道）；
   *   ② 坡道内外两侧的净空必须逐行按"到塔心的距离"裁剪 —— 这正是老 GLB 出
   *      "白板斜插进河道"那种穿模的原因（整段照铺，不做净空判断）。
   *
   * 结构（自下而上）：
   *   · 塔柱：半径 pillarR 的圆柱，从海面下 6m 一直到塔顶 63m；
   *   · 坡道：内缘贴着塔柱、外缘 = 航道半宽 + 3.2m 的悬挑板，外缘一圈矮墙；
   *   · 上升段在水面上方 12~14m 处悬挑（塔柱比航道内缘细），
   *     下降段几乎贴着塔柱 —— 两圈在平面上永远不会重叠（半径 88 / 76）。
   */
  #buildCloudTower(def) {
    const cfg = def.tower;
    const N = this.gates.length;
    // 接近段（隧道口 → 塔基）：2026-11-14 用户截图"起点隧道出口河流全没了、悬空漂移"。
    // 根因是上面把 `stairs_*` 整段隐藏时连 `stairs_water` 一起藏了，而塔的走廊从门 29
    // 才开始 —— 门 23~28 那 7 个门（0m 爬到 13m）既没有水面也没有任何岸带。
    // 现在把塔的断面生成往前接到 approach.from（=23），走线仍然完全按 gates/gateY，
    // 所以水面高度和船严丝合缝，不会再出现"悬空漂移"。
    const from = Math.max(1, cfg.approach?.from ?? cfg.from);
    // to = 整段（含出口水槽）的终点门；towerEnd = 塔上坡道的终点门（过了这个门是水槽）
    const to = Math.min(N - 1, cfg.to);
    const cx = cfg.cx, cz = cfg.cz;
    const HW = this.gateWidth;
    const bankH = cfg.bankH ?? 2.2;
    const pillarR = cfg.pillarR ?? 68;
    // 悬崖段（edgeDrop 覆盖的门）把外缘矮墙压成"路缘石"：玩家一眼能看出这一段可以冲出去。
    // 这跟物理无关（护栏放宽在 Track.#edgeRule 里），纯粹是让视觉和规则对上。
    const dropZone = (gate) => {
      const list = def.edgeDrop;
      if (!list) return false;
      for (const z of list) if (gate >= z.from - 1 && gate <= z.to) return true;
      return false;
    };

    // 每个采样行的半径：用来判断"这一行还在塔上"还是"已经出了塔的出口水槽"
    const radiusOf = (x, z) => Math.hypot(x - cx, z - cz);
    const towerEndGate = cfg.towerEnd ?? cfg.to;
    // ---------- 采样行（沿线每 2.2m 一行）----------
    const rows = [];
    for (let i = from; i < to; i++) {
      const a = this.gates[i], b = this.gates[i + 1];
      const y0 = this.gateY[i] ?? 0, y1 = this.gateY[i + 1] ?? y0;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const n = Math.max(1, Math.ceil(len / 2.2));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a[0] + dx * t, z = a[1] + dz * t;
        rows.push({ x, z, y: y0 + (y1 - y0) * t, gate: i, nx: -dz / len, nz: dx / len });
      }
    }
    const lastG = this.gates[to];
    rows.push({ x: lastG[0], z: lastG[1], y: this.gateY[to] ?? 0, gate: to, nx: rows.length ? rows[rows.length - 1].nx : 0, nz: rows.length ? rows[rows.length - 1].nz : 1 });
    if (rows.length < 4) return;

    const pull = (r, out) => {
      const d = radiusOf(r.x, r.z) || 1;
      return { ux: (r.x - cx) / d, uz: (r.z - cz) / d, rad: d, onTower: r.gate <= towerEndGate };
    };

    // ---------- 水面（5 列，与瀑布水条同一套写法，中间略高像水脊）----------
    const LATS = [-1, -0.55, 0, 0.55, 1];
    const WV = [], WC = [], WF = [];
    const wrows = [];
    let prevX = 1e9, prevZ = 1e9;
    for (const r of rows) {
      if (Math.hypot(r.x - prevX, r.z - prevZ) < 0.5) continue;
      prevX = r.x; prevZ = r.z;
      const row = [];
      for (const lat of LATS) {
        const e = Math.abs(lat);
        row.push(WV.length / 3);
        WV.push(r.x + r.nx * lat * HW, r.y + 0.08 + (1 - e) * 0.06, r.z + r.nz * lat * HW);
        // 中间亮一点（水脊反光）、两侧压深。不能给纯白 —— 纯白在这个场景里就是雪。
        WC.push(0.58 + 0.22 * (1 - e), 0.84 + 0.12 * (1 - e), 0.96);
      }
      wrows.push(row);
    }
    for (let i = 0; i < wrows.length - 1; i++) {
      for (let k = 0; k < LATS.length - 1; k++) {
        const a = wrows[i][k], b = wrows[i][k + 1];
        const c = wrows[i + 1][k + 1], d = wrows[i + 1][k];
        WF.push(a, b, c, a, c, d);
      }
    }
    const wgeo = new THREE.BufferGeometry();
    wgeo.setAttribute('position', new THREE.Float32BufferAttribute(WV, 3));
    wgeo.setAttribute('color', new THREE.Float32BufferAttribute(WC, 3));
    wgeo.setIndex(WF);
    wgeo.computeVertexNormals();
    // 水面优先借主游戏 Water 的 shader：和地图其它水面同波同色，读起来才"是水"。
    // 拿不到（加载顺序）才退回自带的蓝白材质 —— 但绝不能用纯白，纯白会被当成雪。
    const gameWater = this.#findGameWaterMaterial();
    const waterMesh = new THREE.Mesh(wgeo, gameWater || new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.18, metalness: 0.1,
      transparent: true, opacity: 0.94, side: THREE.DoubleSide,
      color: 0x9fdfe8, emissive: 0x1d5c74, emissiveIntensity: 0.55,
    }));
    waterMesh.name = 'tower_water';
    waterMesh.castShadow = false; waterMesh.receiveShadow = false; waterMesh.frustumCulled = false;
    this.group.add(waterMesh);

    // ---------- 坡道 / 岸带 / 底面 ----------
    // 顶面白、外壁略暗、底面压深 —— 只有三个色阶，但足够把"这是一条悬空走廊"读出来。
    // 注意别给到 0xf8 以上：云端本来就是高亮度环境，顶面一白就整个糊成雪坡。
    const C_TOP = new THREE.Color(0xd7e6f3);
    const C_WALL = new THREE.Color(0xc2d6e8);
    const C_BOT = new THREE.Color(0x8ea6bc);
    const DV = [], DC = [], DF = [];
    const pushV = (x, y, z, c) => { DV.push(x, y, z); DC.push(c.r, c.g, c.b); return DV.length / 3 - 1; };
    // ---------- 断面高度：走廊内的板面必须**沉到浪谷以下** ----------
    // 这里踩过一个很难看的坑（2026-11-14 用户截图"赛道边上一直有白色反复闪烁"）：
    // 原来坡道顶面只在水面下 0.14m，而主水面着色器是按 uWaves 做顶点位移的，
    // 晴天总振幅就有 0.91m（暴风雨 ×2.4 ≈ 2.18m）——浪谷一沉，白板就从水里翻出来，
    // 于是整条走廊变成"白板上漂着几块蓝斑"，而浪一周期一换就表现为不停闪烁。
    // 所以：航道内的板面压到 −2.30m（低于最大浪谷），水线外另起一条 +0.30m 的
    // 走道面当"渠沿"，两者之间用一道立面接起来 —— 这样无论浪多大，
    // 能看见的只有水面 + 一圈干净的白色渠沿，不会再有白斑翻上来。
    const Y_DECK = -2.30;   // 航道内的坡道顶面（永远在水下）
    const Y_WALK = 0.30;    // 水线外的走道/渠沿面（永远在水上）
    const Y_BOT = -2.95;    // 板底
    const LIP = 0.10;       // 渠沿内缘比水面外扩多少（保证水边不留缝）
    const ring = [];
    for (const r of rows) {
      const info = pull(r);
      // 接近段（隧道口 → 塔基，见 def.tower.approach）：走线还没开始绕塔，
      // 径向和航道法线能差到 45°，这时必须用**法线**偏移，否则坡道会斜插进水面。
      const approach = r.gate < cfg.from;
      // 出口水槽（已出塔、又不再绕塔，门 57..66）必须和接近段一样用**航道法线**：
      // radial 是"塔心 → 当前点"，水槽一路远离塔心时这个方向几乎和赛道平行，
      // 用它偏移会把两侧白边整体拉成前后错位的斜块 —— 航道水面（±HW 法线）就从
      // 白边外侧露出来。2026-11-23 用户实拍「白色边缘外面还有蓝色水体赛道」即是此。
      // 只有真正绕塔的几圈（径向 ⟂ 切线）才继续用 radial。
      const useNormal = approach || !info.onTower;
      const ox = useNormal ? r.nx : info.ux;
      const oz = useNormal ? r.nz : info.uz;
      // 内缘：塔上的坡道**只留 0.9m 内压边**，不再一路铺到塔柱。
      // 第一版让坡道顶面从塔柱（r68）一直铺到航道外缘（r98.7），那条 20m 宽的白色平台
      // 把 15m 的水面撑成了"运河"，螺旋完全读不出来。现在坡道是悬挑的窄板，
      // 靠径向肋条吊在塔柱上 —— 这才是"绕塔盘旋"的形体。
      // 接近段沿用 0.9m 内压边；出了塔的出口水槽两侧对称（7.5 + 3.2）。
      const innerOff = (info.onTower || approach) ? HW + 0.9 : HW + 3.2;
      const innerRad = info.rad - innerOff;
      const inX = useNormal ? r.x - r.nx * innerOff : cx + info.ux * innerRad;
      const inZ = useNormal ? r.z - r.nz * innerOff : cz + info.uz * innerRad;
      const oX = r.x + ox * (HW + 3.2);
      const oZ = r.z + oz * (HW + 3.2);
      // 渠沿内缘（水线外侧一点点）
      const wX = r.x + ox * (HW + LIP);
      const wZ = r.z + oz * (HW + LIP);
      // 外缘矮墙：普通段 2.2m（挡得住视线、读得出"走廊"），悬崖段压到 0.55m
      const wallH = (info.onTower && dropZone(r.gate)) ? 0.55 : bankH;
      // 内顶（水下）/ 内底 / 渠沿外 / 渠沿内（水上）/ 走道外 / 外壁顶 / 内壁顶 / 板底内 / 板底外
      const iTop = pushV(inX, r.y + Y_DECK, inZ, C_TOP);
      const iBot = pushV(inX, r.y + Y_BOT, inZ, C_BOT);
      const wBot = pushV(wX, r.y + Y_DECK, wZ, C_TOP);
      const wMid = pushV(wX, r.y + Y_WALK, wZ, C_TOP);
      const oTop = pushV(oX, r.y + Y_WALK, oZ, C_TOP);
      const oWall = pushV(oX, r.y + wallH, oZ, C_WALL);
      // 内侧也要有一道墙：塔上那几圈靠塔柱挡，出口水槽两侧都是空的 ——
      // 只做外侧墙的话，水槽内侧看过去是一片没有边的水（截图里"右边直接是海"）。
      const iWallH = (info.onTower && !approach) ? 0.55 : wallH;
      const iWall = pushV(inX, r.y + iWallH, inZ, C_WALL);
      const oBot = pushV(oX, r.y + Y_BOT, oZ, C_BOT);
      ring.push({ iTop, oTop, oWall, iWall, iBot, oBot, wBot, wMid, y: r.y, onTower: info.onTower, approach, rad: info.rad, x: r.x, z: r.z, nx: r.nx, nz: r.nz, ux: ox, uz: oz });
    }
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      // 水下板面（内缘 → 渠沿）
      DF.push(a.iTop, a.wBot, b.wBot, a.iTop, b.wBot, b.iTop);
      // 渠沿立面（水下板面抬到走道面）
      DF.push(a.wBot, a.wMid, b.wMid, a.wBot, b.wMid, b.wBot);
      // 走道面（渠沿 → 外缘）
      DF.push(a.wMid, a.oTop, b.oTop, a.wMid, b.oTop, b.wMid);
      // 外壁（朝外）
      DF.push(a.oTop, a.oWall, b.oWall, a.oTop, b.oWall, b.oTop);
      // 内壁（朝内）
      DF.push(a.iTop, b.iWall, a.iWall, a.iTop, b.iTop, b.iWall);
      // 底面
      DF.push(a.iBot, b.oBot, a.oBot, a.iBot, b.iBot, b.oBot);
    }
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.Float32BufferAttribute(DV, 3));
    dgeo.setAttribute('color', new THREE.Float32BufferAttribute(DC, 3));
    // 2026-11-19：接近段（门 23~29）在急弯处相邻两行法线转得很快，扫出来的板面
    // 会自交、斜穿航道 —— 玩家截图里"上坡处一团白色物体拦在赛道内"就是它。
    // 这里只剔除"三角形三个顶点分居中心线两侧"的那批面（真正的横穿面板），
    // 柱子/渠沿/走道都在 HW+0.9 之外、同侧，不会被误删。
    const signLat = (x, z, loc) => {
      const ga = this.gates[loc.seg];
      const gb = this.gates[(loc.seg + 1) % this.gates.length];
      const dx = gb[0] - ga[0];
      const dz = gb[1] - ga[1];
      const L = Math.hypot(dx, dz) || 1;
      return (x - loc.px) * (-dz / L) + (z - loc.pz) * (dx / L);
    };
    const keepDF = [];
    for (let t = 0; t < DF.length; t += 3) {
      let sx = 0, sz = 0;
      for (let k = 0; k < 3; k++) {
        const o = DF[t + k] * 3;
        sx += DV[o]; sz += DV[o + 2];
      }
      sx /= 3; sz /= 3;
      let drop = false;
      const loc = nearestOnPolyline(this.gates, sx, sz);
      if (loc.d < this.gateWidth + 1.2) {
        let lo = Infinity, hi = -Infinity;
        for (let k = 0; k < 3; k++) {
          const o = DF[t + k] * 3;
          const l = signLat(DV[o], DV[o + 2], nearestOnPolyline(this.gates, DV[o], DV[o + 2]));
          if (l < lo) lo = l;
          if (l > hi) hi = l;
        }
        if (lo < -0.6 && hi > 0.6) drop = true;
      }
      if (drop) continue;
      keepDF.push(DF[t], DF[t + 1], DF[t + 2]);
    }
    dgeo.setIndex(keepDF);
    dgeo.computeVertexNormals();
    const deckMesh = new THREE.Mesh(dgeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0.0, side: THREE.DoubleSide,
      emissive: 0x9fb9cf, emissiveIntensity: 0.16,   // 云端材质要"会发光"，但不能过曝成白板
    }));
    deckMesh.name = 'tower_deck';
    deckMesh.castShadow = false; deckMesh.receiveShadow = true; deckMesh.frustumCulled = false;
    this.group.add(deckMesh);

    // 径向肋条已整段删除：它们从塔柱伸到坡道内缘，短的有 0.9m、长的 13m，
    // 从塔下/低角度看上去就是一串悬空、断开的方块横着切过坡道（用户截图里
    // "巨大的回旋物体横跨赛道"）。坡道本身已经靠塔柱和圆环读得出来，
    // 不需要这层结构装饰。

    // ---------- 塔柱 + 塔尖 ----------
    // 塔柱必须明显高出坡道顶：第一版只做到 65.1m（比塔顶高 2m），从船上根本看不出来
    // 是"绕着一根柱子盘旋"，只像一条修在山脊上的水渠。现在柱身到 66m，上面接一段
    // 收尖的塔尖到 104m —— 站在任何一圈都能看见塔身从坡道里穿出去。
    const topY = 63.1;
    const trunkMat = new THREE.MeshStandardMaterial({
      // 塔身要压暗一档：坡道/水面的顶点色是接近白的冰蓝，塔身也白 → 俯瞰时
      // 两圈螺旋直接糊成一个"白色雪堆"（实拍确认过）。深一档才有对比。
      color: 0x8fa3b5, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
      emissive: 0x5c7386, emissiveIntensity: 0.2,
    });
    const trunkH = topY + 3 + 6;                 // 从 −6 到 66
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(pillarR, pillarR * 1.12, trunkH, 40, 6, true),
      trunkMat,
    );
    trunk.position.set(cx, (topY + 3) - trunkH / 2, cz);
    trunk.name = 'tower_pillar';
    trunk.castShadow = false; trunk.receiveShadow = true; trunk.frustumCulled = false;
    this.group.add(trunk);

    // 塔尖别做太高：第一版给到 40m（塔顶 63 上再叠 40），远景直接变成一个白色雪堆，
    // 玩家根本看不出下面盘着两圈坡道。现在收到 22m、收得更细，就是一个尖顶塔。
    const spireH = 22;
    const spire = new THREE.Mesh(
      new THREE.CylinderGeometry(pillarR * 0.26, pillarR * 0.82, spireH, 40, 3, true),
      trunkMat,
    );
    spire.position.set(cx, topY + 3 + spireH / 2, cz);
    spire.name = 'tower_spire';
    spire.castShadow = false; spire.receiveShadow = true; spire.frustumCulled = false;
    this.group.add(spire);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(pillarR * 0.5, pillarR * 0.5, 2.4, 40, 1, false),
      new THREE.MeshStandardMaterial({
        color: 0xe8f2fa, roughness: 0.8, metalness: 0.05,
        emissive: 0xaac8e0, emissiveIntensity: 0.35,
      }),
    );
    cap.position.set(cx, topY + 3 + spireH - 1, cz);
    cap.name = 'tower_cap';
    cap.castShadow = false; cap.receiveShadow = false; cap.frustumCulled = false;
    this.group.add(cap);

    // ---------- 出口水槽的支撑柱（每 26m 一根，落到海面以下）----------
    const legs = [];
    const legGeo = new THREE.CylinderGeometry(1.5, 2.0, 1, 8, 1, true);
    let acc = 0;
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i];
      acc += Math.hypot(b.x - a.x, b.z - a.z);
      // 接近段是悬空的窄坡道，同样每 26m 落一根支撑柱（塔上那几圈有塔柱兜着，跳过）
      if ((a.onTower && !a.approach) || acc < 26) continue;
      acc = 0;
      legs.push({ x: a.x, z: a.z, y: a.y });
    }
    if (legs.length) {
      const inst = new THREE.InstancedMesh(
        legGeo,
        new THREE.MeshStandardMaterial({ color: 0xd8e6f2, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide, emissive: 0x9fb9cf, emissiveIntensity: 0.25 }),
        legs.length,
      );
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      legs.forEach((l, k) => {
        const h = l.y + 6;
        m.compose(new THREE.Vector3(l.x, l.y - 1.6 - h / 2, l.z), q, s.set(1, h, 1));
        inst.setMatrixAt(k, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.name = 'tower_legs';
      inst.frustumCulled = false;
      this.group.add(inst);
    }

    // ---------- 浮云：整段删除 ----------
    // 塔身四周那圈 blob 云团（tower_cloud）已经全部移除。它们虽然摆在 r≥165 / y≥76，
    // 但体量 11~26m、还是实体网格，从塔顶俯冲或沿出口水槽飞出去时总会有一两团挡在
    // 视线上，被读成"云横跨瀑布下来的路"。塔本身已经有塔柱、圆环和塔尖，不需要
    // 靠云团补层次。
  }

  /**
   * 接近段（隧道口 → 塔基）两侧的浮云。
   *
   * 门 23~29 那段坡道从 0m 爬到 13m，整条是悬空的：从隧道冲出来只看到"一条水带飘在
   * 天上"，两侧是空的。这里沿坡道左右各摆几团云把它托住。
   *
   * 为什么不用 cloud_shell.glb 的 `cloud_isles` 原型：它是"浮空孤岛"——底部是一圈
   * 尖锥岩石，clone 出来就是一堆倒挂的漏斗（实拍确认）。云团改成程序化的球簇：
   * 每团 4~7 个压扁的 icosphere 合成一块，一眼就是"软云"，和低模画风也搭。
   *
   * 三条硬约束：
   *   ① 云心到航道边至少 HW+11，横向再抖 ±6m —— 永远不进走廊（不造"云穿模"）；
   *   ② 竖向按包围盒把云底抬到水面以上 0.6m，杜绝云底切进水里；
   *   ③ 位置全部走确定性 LCG，主机/客机/重开都长一样。
   */
  #buildApproachClouds(def) {
    const cfg = def && def.tower && def.tower.approach;
    if (!cfg) return;
    // 2026-11-16 用户要求删掉隧道出口那一片白色卡通云（挡视线 + 出戏）。
    // 数据里写 approach.clouds = false 就整段不生成，其它地图不受影响。
    if (cfg.clouds === false) return;
    const N = this.gates.length;
    const HW = this.gateWidth;
    const from = Math.max(1, cfg.from - 2);
    const to = Math.min(N - 2, cfg.to + 1);

    let seed = 0x7c3a19;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    // 一个"云团"= 若干压扁 icosphere。detail=1（80 面）足够圆，软件光栅也不疼。
    const blob = new THREE.IcosahedronGeometry(1, 1);
    const geos = [];
    const M = new THREE.Matrix4();
    const P = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const S = new THREE.Vector3();
    const E = new THREE.Euler();
    const puff = (cx, cy, cz, R) => {
      const n = 4 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.7;
        const rad = R * (0.18 + rnd() * 0.5);
        const g = blob.clone();
        P.set(cx + Math.cos(a) * rad, cy + (rnd() - 0.45) * R * 0.34, cz + Math.sin(a) * rad);
        E.set(rnd() * 0.6, rnd() * Math.PI * 2, rnd() * 0.6);
        Q.setFromEuler(E);
        const s = R * (0.42 + rnd() * 0.34);
        S.set(s, s * 0.66, s);
        M.compose(P, Q, S);
        g.applyMatrix4(M);
        geos.push(g);
      }
    };
    for (let i = from; i <= to; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      const y = this.gateY[i] ?? 0;
      for (const side of [-1, 1]) {
        if (rnd() < 0.18) continue;                  // 零星留空，排得太整齐反而假
        const off = HW + 11 + rnd() * 15;
        const px = a[0] + nx * side * off + (rnd() - 0.5) * 10;
        const pz = a[1] + nz * side * off + (rnd() - 0.5) * 10;
        const R = 5.5 + rnd() * 6.5;
        // 云团整体抬到水面之上：R*0.66 是压扁后的半高
        puff(px, y + 0.6 + R * 0.66 + rnd() * 5.5, pz, R);
      }
    }
    if (!geos.length) return;
    const merged = mergeGeometries(geos, false);
    if (!merged) { console.warn('[approach-clouds] 合并失败'); return; }
    const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({
      // 云要"自己会亮"：纯 PBR 在这个高亮度天空里会掉成灰蓝色一片
      color: 0xf2f8fd,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true,
      emissive: 0xd6e6f2,
      emissiveIntensity: 0.42,
      side: THREE.DoubleSide,
    }));
    mesh.name = 'approach_clouds';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /**
   * 瀑布水条（程序化）：沿门中心线铺一条半宽 = gateWidth 的水面，高度 = gateY + 8cm。
   *
   * 为什么不用 Blender 那条：艇的 y 全项目只有一个来源 `#bakedHeightAt`（沿门段插值
   * gateY）。fall_shell.glb 里的 fall_water 是另一套 FALL_CTRL/FH 控制点做的，
   * 中段比赛道低 10m 以上、横向还偏出去 8~20m —— 玩家看到的就是"赛艇浮空、
   * 水在最底下的池子里"。现生成的这条与艇同源，改 gateY 也不会再错位。
   */
  #buildFallRibbon(fromGate = null, toGate = null) {
    const N = this.gates.length;
    // 自动找瀑布段：从最高的平顶开始连续下降、落差最大的那一段（不用写死门号）
    if (fromGate == null || toGate == null) {
      const y = this.gateY;
      let bestDrop = 0;
      for (let i = 0; i < N; i++) {
        if ((y[i] ?? 0) < 20) continue;
        let j = i;
        // 一直降到水面高度（y<=9）为止：再往后就是森林平段，那里有 forest_water，
        // 铺上来只会多一条颜色不一样的带子
        while (j + 1 < N && (y[j + 1] ?? 0) < (y[j] ?? 0) - 0.2 && (y[j + 1] ?? 0) > 9) j++;
        const drop = (y[i] ?? 0) - (y[j] ?? 0);
        if (drop > bestDrop) { bestDrop = drop; fromGate = i - 1; toGate = j + 1; }
      }
      if (fromGate == null) return;
      fromGate = Math.max(0, fromGate);
      toGate = Math.min(N - 1, toGate);
    }
    const HW = this.gateWidth;            // 与航道同宽（15m）
    const LATS = [-1, -0.55, 0, 0.55, 1];
    const V = [], C = [], F = [];
    const rows = [];
    let prev = null;
    for (let i = fromGate; i <= toGate; i++) {
      const a = this.gates[i % N];
      const b = this.gates[(i + 1) % N];
      const y0 = this.gateY[i % N] ?? 0;
      const y1 = this.gateY[(i + 1) % N] ?? y0;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const n = Math.max(1, Math.ceil(len / 3));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a[0] + dx * t, z = a[1] + dz * t;
        const y = y0 + (y1 - y0) * t;
        // 相邻两行太近就跳过（门点重复时会生成零面积面片）
        if (prev && Math.hypot(x - prev.x, z - prev.z) < 0.6) continue;
        const row = [];
        for (const lat of LATS) {
          const e = Math.abs(lat);
          row.push(V.length / 3);
          // 中间略高 6cm，读起来像水脊；两侧贴边
          V.push(x + nx * lat * HW, y + 0.08 + (1 - e) * 0.06, z + nz * lat * HW);
          // 中心近白（泡沫），两侧淡青
          const g = 0.92 + 0.08 * (1 - e);
          C.push(0.88 + 0.12 * (1 - e), g, 1.0);
        }
        rows.push(row);
        prev = { x, z };
      }
    }
    for (let i = 0; i < rows.length - 1; i++) {
      for (let k = 0; k < LATS.length - 1; k++) {
        const a = rows[i][k], b = rows[i][k + 1];
        const c = rows[i + 1][k + 1], d = rows[i + 1][k];
        // 必须按"两个三角形 = 6 个索引"压进去。以前这里只压 4 个（四边形写法），
        // 索引流会整体错位一位，渲出来是棋盘状的碎三角。
        F.push(a, b, c, a, c, d);
      }
    }
    if (!V.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(V, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    geo.setIndex(F);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.24, metalness: 0.05,
      transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      emissive: 0x2f7f9c, emissiveIntensity: 0.45,   // 蓝白水，不是纯白（纯白像云）
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'fall_water_ribbon';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /**
   * 回程布景：木栈桥 / 礁石群 / 浮标。
   *
   * 全部是 Blender 出的"原型件"，这里只按回程中心线克隆摆放 ——
   * 既不在 Blender 里摆一整排，也不在 JS 里写死坐标。
   * 两个必须的过滤：
   *   ① 到"非相邻赛段"的净空 < 40m 就不摆（发卡 U 弯对面的平行道只有 64m，
   *      不跳过就会把码头摆到隔壁那条道的岸边）；
   *   ② 礁石/浮标一律摆到堤身**外侧**（offset > 10.8），否则会整块埋进堤身；
   *      码头相反：按玩家要求摆到堤身**内侧**，长边（局部 Z）垂直堤壁伸进航道，
   *      占掉半幅水面形成窄口，剩下的通道按 passWidth 控制在"两艘赛艇并排"。
   */
  #buildShoreDressing(def) {
    const cfg = def && def.shore;
    if (!cfg || !cfg.from) return;
    const gates = this.gates;
    const N = gates.length;
    const from = cfg.from;
    if (from >= N - 4) return;

    // ---- 沿回程中心线建立弧长站点表 ----
    const route = [];
    let acc = 0;
    for (let i = from; i < N; i++) {
      const a = gates[i];
      const b = i + 1 < N ? gates[i + 1] : gates[0];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      route.push({ x: a[0], z: a[1], ux: dx / len, uz: dz / len, s: acc, i });
      acc += len;
    }
    const total = acc;
    if (total < 100) return;
    const spot = (s) => {
      let k = 0;
      while (k < route.length - 2 && route[k + 1].s < s) k++;
      const p = route[k];
      const q = route[k + 1] || route[k];
      const seg = (q.s - p.s) || 1;
      const t = Math.min(1, Math.max(0, (s - p.s) / seg));
      const ux = p.ux + (q.ux - p.ux) * t;
      const uz = p.uz + (q.uz - p.uz) * t;
      const L = Math.hypot(ux, uz) || 1;
      return { x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, ux: ux / L, uz: uz / L, i: p.i };
    };
    const clearance = (x, z, i) => {
      let best = Infinity;
      for (let j = 0; j < N - 1; j++) {
        if (Math.abs(j - i) < 12) continue;
        const a = gates[j];
        const b = gates[j + 1];
        const sx = b[0] - a[0];
        const sz = b[1] - a[1];
        const L2 = sx * sx + sz * sz || 1;
        let t = ((x - a[0]) * sx + (z - a[1]) * sz) / L2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(x - a[0] - sx * t, z - a[1] - sz * t);
        if (d < best) best = d;
      }
      return best;
    };

    // 确定性伪随机：布景位置必须每次进图都一样（联机两端、重开一局都对得上），
    // 用 Math.random 会让码头每次刷新都换地方
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let buoySide = 1;
    // 码头原型尺寸（dock_wood.glb 局部 X 4.68m 宽 / 局部 Z 18.26m 长）。
    // 长边只压 lenScale，宽度不动 —— 等比缩会把 8m 长的码头压成一根细竹签，
    // 船开过去几乎没有"挤"的感觉，也吃不出这是一个能停船的码头。
    const DOCK_HALF_W = 2.34;
    const DOCK_HALF_L = 9.13;
    const collect = (c, mode) => {
      const out = [];
      const step = c.step || 150;
      // 码头摆到堤身**内侧**（航道里），从堤壁垂直伸出来占掉半幅航道。
      // 这里不写死 offset，而是按 passWidth 反推：碰撞沿法线覆盖 ±halfL，
      // 所以内缘 = off − halfL，要求「走廊半宽 − 内缘 == passWidth」。
      // 走廊半宽取 #probeMain 的 limit，保证碰撞边界和护栏是同一条线。
      const halfL = mode === 'dock' ? DOCK_HALF_L * (c.lenScale ?? 1) : 0;
      const off = mode === 'dock'
        ? (this.edgeOffset ?? this.gateWidth - 0.6) - (c.passWidth ?? 7) + halfL
        : (c.offset || 16);
      for (let s = step * 0.5; s < total - 30; s += step) {
        const p = spot(s);
        let side;
        if (mode === 'buoy') {
          buoySide = -buoySide;          // 浮标左右交替，别排成一条直线
          side = buoySide;
        } else {
          side = rnd() < 0.5 ? 1 : -1;
        }
        // 左法线 = (-uz, ux)
        const x = p.x - p.uz * side * off;
        const z = p.z + p.ux * side * off;
        if (clearance(x, z, p.i) < 40) continue;
        out.push({
          x, z,
          rot: mode === 'dock'
            ? Math.atan2(-p.uz * side, p.ux * side)
            : Math.atan2(p.ux, p.uz) + (rnd() - 0.5) * 1.4,
          // 岸带在 11m 处已经抬起来了，礁石必须按 offset 补一点高度，
          // 否则甲板 y=0 会被沙滩直接埋掉
          y: (c.y || 0) + (mode === 'rock' ? -0.15 : 0),
          scale: (c.scale || 1) * (mode === 'rock' ? 0.75 + rnd() * 0.6 : 1),
          lenScale: mode === 'dock' ? (c.lenScale ?? 1) : 1,
          halfL,
        });
      }
      return out;
    };

    const loader = new GLTFLoader();
    const spawn = (c, list, mode) => {
      if (!list.length) return;
      // dock_wood.glb 里只有桩和横杆，**没有甲板**（748 面全是细杆）——直接摆进
      // 航道就是从水面上飘着两根栏杆，读不出"码头"。这里补一块程序化木甲板：
      // 尺寸与三个碰撞圆完全一致（4.68 × 8.31m），所以看到的边就是撞到的边。
      const deckGeo = mode === 'dock'
        ? new THREE.BoxGeometry(DOCK_HALF_W * 2, 0.24, list[0].halfL * 2)
        : null;
      const deckMat = mode === 'dock'
        ? new THREE.MeshStandardMaterial({ color: 0x9a7850, roughness: 0.9, metalness: 0 })
        : null;
      loader.load(c.url, (g) => {
        const src = g.scene;
        const grp = new THREE.Group();
        grp.name = 'shore_' + mode;
        for (const it of list) {
          // 码头：横在航道里的窄口障碍。碰撞圆贴着码头本体铺（半径 = 原型半宽 2.34m，
          // 圆心从 −(半长−r) 排到 +(半长−r)），几何与碰撞因此完全对齐 ——
          // 不会出现"看着能过却被空气墙顶回来"。
          if (mode === 'dock') {
            const sx = Math.sin(it.rot), sz = Math.cos(it.rot);
            const tx = Math.cos(it.rot), tz = -Math.sin(it.rot);   // 切向（沿航道）
            const r = DOCK_HALF_W;
            const span = Math.max(0, it.halfL - r);
            for (const t of [-1, 0, 1]) {
              this.shoreColliders.push({
                x: it.x + sx * span * t, z: it.z + sz * span * t, r, dock: true,
              });
            }
            // 三个大圆排成的是"胶囊"：甲板两端的角会漏出去，船能贴着角切进甲板里。
            // 内缘那两角再补两个小圆（半径 1.3，正好收在甲板边缘内），
            // 碰撞边界因此和甲板矩形基本重合 —— 净宽仍然是 7.0m。
            const inward = it.halfL - 1.3;
            const edge = r - 1.3;
            for (const b of [-1, 1]) {
              this.shoreColliders.push({
                x: it.x - sx * inward + tx * edge * b,
                z: it.z - sz * inward + tz * edge * b,
                r: 1.3, dock: true,
              });
            }
            // 甲板：顶面在锚点上方 0.15m（水面 +0.27），桩头从甲板上方露出来当系缆桩。
            // 注意甲板挂在 grp 上而不是 o 上 —— o 的 scale.z 被压成 0.455，
            // 挂上去会被二次缩放，长度就对不上碰撞圆了。
            const deck = new THREE.Mesh(deckGeo, deckMat);
            deck.position.set(it.x, (it.y || 0) + 0.03, it.z);
            deck.rotation.y = it.rot;
            deck.castShadow = false;
            deck.receiveShadow = false;
            grp.add(deck);
            // 给 AI 的车道提示留坐标（法线方向 = 码头在哪一侧）
            this.dockMarks.push({ x: it.x, z: it.z, nx: sx, nz: sz });
          }
          const o = src.clone(true);
          o.position.set(it.x, it.y || 0, it.z);
          o.rotation.y = it.rot;
          // 码头只压长边（局部 Z），宽度/高度保持原型尺寸
          if (mode === 'dock') o.scale.set(1, 1, it.lenScale);
          else if (it.scale !== 1) o.scale.setScalar(it.scale);
          o.traverse((m) => {
            if (!m.isMesh) return;
            m.castShadow = false;
            m.receiveShadow = false;
            m.frustumCulled = false;
            if (m.material) {
              m.material = m.material.clone();
              m.material.vertexColors = !!(m.geometry && m.geometry.attributes && m.geometry.attributes.color);
              m.material.needsUpdate = true;
            }
          });
          grp.add(o);
        }
        this.group.add(grp);
      }, undefined, (e) => console.warn('[shore] 加载失败', c.url, e));
    };

    if (cfg.dock) {
      this.dockPassWidth = cfg.dock.passWidth ?? 7;
      spawn(cfg.dock, collect(cfg.dock, 'dock'), 'dock');
    }
    if (cfg.rock) spawn(cfg.rock, collect(cfg.rock, 'rock'), 'rock');
    if (cfg.buoy) spawn(cfg.buoy, collect(cfg.buoy, 'buoy'), 'buoy');
  }

  /**
   * 回程堤岸上的动态障碍（全部是 Blender 导出的 .glb 原型件）：
   *   垃圾桶左右横扫、机器人沿赛道前后巡逻、岩石卡在路中间、海草贴边装饰。
   * 运动全部是 elapsed 时间轴的纯函数，主机/客机看到的位置与碰撞窗口一致。
   * 碰撞直接复用 bakedObstacles（每帧回写 x/z），不必另开一套判定。
   */
  #buildBakedHazards(def) {
    const cfg = def && def.hazards;
    if (!cfg || !this.gates.length) return;
    const N = this.gates.length;
    const from = Math.max(1, cfg.from ?? 92);
    const to = Math.min(N - 2, cfg.to ?? N - 2);
    const info = (i) => {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      return {
        x: a[0], z: a[1], y: this.gateY[i] ?? 0,
        ux: dx / L, uz: dz / L,
        yaw: Math.atan2(dx, dz),
      };
    };
    // 三种会动的障碍交错插空，密度控制在"每 60~120m 一个"：
    // 一路全是同一种就没节奏，只有左右错开的组合才需要真的走线。
    const plans = { bin: [], bot: [], rock: [], kelp: [] };
    for (let i = from; i <= to; i++) {
      const d = i - from;
      if (d % 6 === 2) plans.bin.push(i);
      if (d % 13 === 5) plans.bot.push(i);
      if (d % 17 === 9) plans.rock.push(i);
      if (d % 3 === 1) plans.kelp.push(i);
    }
    const urls = {
      bin: '/models/hazards/hazard_bin.glb',
      bot: '/models/hazards/hazard_bot_walk.glb',
      rock: '/models/hazards/hazard_rock.glb',
      kelp: '/models/hazards/hazard_kelp.glb',
    };
    const loader = new GLTFLoader();
    for (const kind of Object.keys(plans)) {
      if (!plans[kind].length) continue;
      loader.load(urls[kind], (g) => {
        g.scene.updateMatrixWorld(true);
        // 机器人是带骨骼动画的蒙皮模型，烘成 InstancedMesh 等于把动作拍死。
        // 这一支每台单独克隆（SkeletonUtils.clone 才不会串骨架）+ 自己的 mixer。
        // 若 GLB 没有骨骼/动画，返回 false 回退到下面的静态烘几何逻辑。
        if (kind === 'bot' && this.#spawnBotWalkers(g, plans.bot, info, N)) return;
        // 带贴图的件必须**按材质分组、保留原贴图**。
        // 老逻辑是把所有网格烘成"单色 + 顶点色"再合成一个 InstancedMesh ——
        // 贴图会被整块烘掉，那正是上一只机器人看起来像"程序化方块"的原因。
        let textured = false;
        g.scene.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const mm = Array.isArray(o.material) ? o.material[0] : o.material;
          if (mm && (mm.map || mm.emissiveMap || mm.normalMap)) textured = true;
        });
        if (textured) {
          const byMat = new Map();
          g.scene.traverse((o) => {
            if (!o.isMesh || !o.geometry) return;
            const mm = Array.isArray(o.material) ? o.material[0] : o.material;
            if (!mm) return;
            const geo = o.geometry.clone();
            geo.applyMatrix4(o.matrixWorld);
            if (!byMat.has(mm.uuid)) byMat.set(mm.uuid, { mat: mm, geos: [] });
            byMat.get(mm.uuid).geos.push(geo);
          });
          const sets = [];
          for (const { mat, geos } of byMat.values()) {
            const merged = mergeGeometries(geos, false);
            if (!merged) continue;
            const m2 = mat.clone();
            m2.vertexColors = false;          // 贴图件不要再乘 COLOR_0（会整只发黑）
            if (m2.map) m2.map.anisotropy = 8;
            m2.needsUpdate = true;
            sets.push({ geo: merged, mat: m2 });
          }
          if (!sets.length) return;
          this.#spawnHazardSet(kind, sets, plans[kind], info, N);
          return;
        }
        const geos = [];
        g.scene.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          const geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          // 把材质底色烘进顶点色：四种件各合成一个 InstancedMesh，全图只多 4 个 draw call
          const col = (o.material && o.material.color)
            ? o.material.color.clone()
            : new THREE.Color(0xb8bfc4);
          const n = geo.attributes.position.count;
          const arr = new Float32Array(n * 3);
          for (let k = 0; k < n; k++) {
            arr[k * 3] = col.r; arr[k * 3 + 1] = col.g; arr[k * 3 + 2] = col.b;
          }
          geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
          geos.push(geo);
        });
        if (!geos.length) return;
        const merged = mergeGeometries(geos, false);
        if (!merged) { console.warn('[hazard] 合并失败', kind); return; }
        this.#spawnHazardSet(kind, merged, plans[kind], info, N);
      }, undefined, (e) => console.warn('[hazard] 加载失败', urls[kind], e));
    }
  }

  /**
   * 带骨骼动画的巡逻机器人：每台克隆一份独立骨架（不能直接复用 gltf.scene，
   * 否则所有机器人共享同一副骨架、动作会同步），各自挂 AnimationMixer 播 Walk。
   * 巡逻路线 / 碰撞窗口与静态版完全一致（见 #spawnHazardSet 的 bot 分支）。
   * @returns {boolean} 是否成功接管；失败时调用方回退到静态烘几何
   */
  #spawnBotWalkers(gltf, list, info, N) {
    if (!gltf.animations || !gltf.animations.length) return false;
    let skinned = 0;
    gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
    if (!skinned) return false;

    const clip = gltf.animations.find((a) => a.name === 'Walk') || gltf.animations[0];
    const meshes = [];
    const walkers = [];
    for (let k = 0; k < list.length; k++) {
      let root;
      try {
        root = cloneSkinned(gltf.scene);          // 深拷贝骨架 + 蒙皮，互不干扰
      } catch (e) {
        console.warn('[hazard] 机器人骨骼克隆失败，回退静态', e);
        this.#removeBotWalkers(meshes);
        return false;
      }
      root.updateMatrixWorld(true);
      root.name = 'baked_hazard_bot_walk_' + k;
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        o.castShadow = false;
        o.receiveShadow = true;
        const mm = Array.isArray(o.material) ? o.material[0] : o.material;
        if (mm && mm.map) mm.map.anisotropy = 4;
      });
      this.group.add(root);
      meshes.push(root);
      const mixer = new THREE.AnimationMixer(root);
      const action = mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      // 每台错开步态相位，一排机器人不会像仪仗队一样齐步走
      action.time = ((k * 0.6180339887) % 1) * clip.duration;
      walkers.push({ mixer, action });
    }

    // items 与静态版 bot 分支一一对应，巡逻路径 / 碰撞照旧
    const items = [];
    list.forEach((i, k) => {
      const p = info(i);
      const it = { i, p, k, phase: (k * 0.6180339887) % 1 };
      const pts = [];
      for (let d = -2; d <= 2; d++) pts.push(this.gates[(i + d + N) % N]);
      const cum = [0];
      let total = 0;
      for (let q = 1; q < pts.length; q++) {
        total += Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
        cum.push(total);
      }
      it.path = pts; it.cum = cum; it.total = total;
      it.lat = (k % 2 ? 1 : -1) * 2.1;
      it.period = 8.5 + (k % 3) * 1.4;
      it.y = p.y;                       // GLB 脚底已在 y=0，直接踩赛道面
      it.coll = { x: p.x, z: p.z, y: p.y, r: 1.15 };
      this.bakedObstacles.push(it.coll);
      items.push(it);
    });
    this.bakedHazards.push({ kind: 'bot', meshes, items, walkers });
    this.#updateBakedHazards(0, 0);
    return true;
  }

  /** 骨骼克隆中途失败时把已挂上的机器人摘掉，避免半个模型留在场景里 */
  #removeBotWalkers(meshes) {
    for (const m of meshes) {
      this.group.remove(m);
      m.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    }
  }

  /**
   * 生成一类动态障碍的实例化网格。
   * @param payload 两种形态：
   *   · 单个已合并的几何 → 走"顶点色扁平材质"（垃圾桶/岩石/海草，无贴图）
   *   · `[{geo, mat}]` 列表 → 带贴图的件按材质各建一个 InstancedMesh（机器人）
   */
  #spawnHazardSet(kind, payload, list, info, N) {
    const sets = Array.isArray(payload)
      ? payload
      : [{
          geo: payload,
          mat: new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.78, metalness: 0.06,
            emissive: 0x0a0f12, emissiveIntensity: 0.6,
          }),
        }];
    const meshes = [];
    sets.forEach((s, si) => {
      const mesh = new THREE.InstancedMesh(s.geo, s.mat, list.length);
      mesh.name = 'baked_hazard_' + kind + (sets.length > 1 ? '_' + si : '');
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      meshes.push(mesh);
    });
    const items = [];
    list.forEach((i, k) => {
      const p = info(i);
      const it = { i, p, k, phase: (k * 0.6180339887) % 1 };
      if (kind === 'bin') {
        it.period = 6.2 + (k % 4) * 0.85;
        it.amp = Math.max(2.5, this.gateWidth - 2.6);
        it.y = p.y + 0.05;
        it.coll = { x: p.x, z: p.z, y: p.y, r: 0.95 };
      } else if (kind === 'bot') {
        const pts = [];
        for (let d = -2; d <= 2; d++) pts.push(this.gates[(i + d + N) % N]);
        const cum = [0];
        let total = 0;
        for (let q = 1; q < pts.length; q++) {
          total += Math.hypot(pts[q][0] - pts[q - 1][0], pts[q][1] - pts[q - 1][1]);
          cum.push(total);
        }
        it.path = pts; it.cum = cum; it.total = total;
        it.lat = (k % 2 ? 1 : -1) * 2.1;
        it.period = 8.5 + (k % 3) * 1.4;
        it.y = p.y + 0.12;
        // 2.6m 高的机器人，脚底宽约 1.6m —— 碰撞半径跟着放到 1.15
        it.coll = { x: p.x, z: p.z, y: p.y, r: 1.15 };
      } else if (kind === 'rock') {
        it.lat = (k % 2 ? 1 : -1) * (1.0 + (k % 3) * 0.55);
        it.scale = 0.85 + (k % 4) * 0.12;
        it.y = p.y + 0.30;
        it.yaw = p.yaw + (k % 5) * 0.7;
        it.coll = { x: p.x, z: p.z, y: p.y, r: 2.0 * it.scale };
      } else {
        it.lat = (k % 2 ? 1 : -1) * (this.gateWidth - 1.5);
        it.scale = 0.8 + (k % 5) * 0.11;
        it.y = p.y - 0.05;
        it.yaw = p.yaw + (k % 3) * 0.5;
      }
      if (it.coll) this.bakedObstacles.push(it.coll);
      items.push(it);
    });
    this.bakedHazards.push({ kind, meshes, items });
    this.#updateBakedHazards(0);
  }

  #updateBakedHazards(t, dt = 0) {
    if (!this.bakedHazards.length) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const S = new THREE.Vector3();
    for (const set of this.bakedHazards) {
      for (const it of set.items) {
        const p = it.p;
        let x = p.x, z = p.z, y = it.y, yaw = it.yaw ?? p.yaw;
        if (set.kind === 'bin') {
          // 三角波：扫到两边各停一下再折返，比正弦更像"障碍在等你犯错"
          const cyc = ((t / it.period + it.phase) % 1 + 1) % 1;
          const tri = 1 - Math.abs(cyc * 2 - 1);
          const off = (tri * 2 - 1) * it.amp;
          x = p.x - p.uz * off;
          z = p.z + p.ux * off;
          yaw = p.yaw + Math.PI / 2;
        } else if (set.kind === 'bot') {
          const u = 0.5 - 0.5 * Math.cos(((t / it.period + it.phase) % 1) * Math.PI * 2);
          const dist = u * it.total;
          let seg = 0;
          while (seg < it.path.length - 2 && it.cum[seg + 1] < dist) seg++;
          const a = it.path[seg];
          const b = it.path[seg + 1];
          const segLen = Math.max(0.001, it.cum[seg + 1] - it.cum[seg]);
          const f = Math.min(1, Math.max(0, (dist - it.cum[seg]) / segLen));
          const dx = b[0] - a[0], dz = b[1] - a[1];
          const L = Math.hypot(dx, dz) || 1;
          x = a[0] + dx * f - (dz / L) * it.lat;
          z = a[1] + dz * f + (dx / L) * it.lat;
          yaw = Math.atan2(dx, dz);
          // 静态版是悬浮机器人，上下浮动一点；骨骼版脚底踩地，不再悬浮
          if (!set.walkers) y = it.y + Math.sin(t * 2.4 + it.phase * 6.283) * 0.10;
        } else {
          x = p.x - p.uz * it.lat;
          z = p.z + p.ux * it.lat;
        }
        if (it.coll) { it.coll.x = x; it.coll.z = z; }
        if (set.walkers) {
          // 骨骼版：位置/朝向写在克隆出来的根物体上，各自推进自己的步态
          const walker = set.walkers[it.k];
          const root = set.meshes[it.k];
          if (walker && root) {
            root.position.set(x, y, z);
            root.rotation.set(0, yaw, 0);
            walker.mixer.update(dt);
          }
          continue;
        }
        e.set(0, yaw, 0);
        q.setFromEuler(e);
        v.set(x, y, z);
        S.setScalar(it.scale || 1);
        m.compose(v, q, S);
        for (const mesh of set.meshes) mesh.setMatrixAt(it.k, m);
      }
      for (const mesh of set.meshes) {
        if (mesh.isInstancedMesh) mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** 主游戏水面材质：从场景里捞出 Water 的 ShaderMaterial（带 uTime + uColorShallow 的那个） */
  #findGameWaterMaterial() {
    if (this._waterMat !== undefined) return this._waterMat;
    this._waterMat = null;
    this.scene.traverse((o) => {
      if (this._waterMat || !o.isMesh || !o.material) return;
      const u = o.material.uniforms;
      if (u && u.uTime && u.uColorShallow) this._waterMat = o.material;
    });
    return this._waterMat;
  }

  /** 瀑布落水爆炸水花：自动找 gateY 最陡的下降段，在落点铺 GPU 粒子做爆溅 */
  #buildFallSplash() {
    if (!this.openTrack || !this.gates.length || !this.gateY) return;
    const N = this.gates.length;
    const steep = [];
    for (let i = 0; i < N - 1; i++) {
      const y0 = this.gateY[i] ?? 0, y1 = this.gateY[i + 1] ?? 0;
      const g0 = this.gates[i], g1 = this.gates[i + 1];
      const d = Math.hypot(g1[0] - g0[0], g1[1] - g0[1]) || 1;
      if ((y1 - y0) / d < -0.26) steep.push(i);
    }
    if (!steep.length) return;
    // 落点 = 最陡段的末端（水打在水面上的地方）
    const endI = Math.min(N - 1, steep[steep.length - 1] + 1);
    const anchors = [];
    for (const k of [0, 1, 2]) {
      const gi = Math.max(0, Math.min(N - 1, endI - k));
      anchors.push({ x: this.gates[gi][0], z: this.gates[gi][1], y: this.gateY[gi] ?? 0 });
    }
    const COUNT = 320;
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    const A = anchors[0], B = anchors[2];
    const dirX = B.x - A.x, dirZ = B.z - A.z;
    const dl = Math.hypot(dirX, dirZ) || 1;
    const nx = -dirZ / dl, nz = dirX / dl;
    for (let i = 0; i < COUNT; i++) {
      const t = Math.random();
      const lat = (Math.random() * 2 - 1) * 9.5;
      pos[i*3] = A.x + dirX * t + nx * lat;
      pos[i*3+1] = A.y + 0.3;
      pos[i*3+2] = A.z + dirZ * t + nz * lat;
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSeed;
        uniform float uTime;
        varying float vA;
        void main() {
          float ph = fract(uTime * (0.55 + aSeed * 0.65) + aSeed * 7.13);
          vec3 p = position;
          float ang = aSeed * 6.28318;
          float rad = (0.7 + aSeed * 2.4) * ph;
          p.x += cos(ang) * rad * 4.2;
          p.z += sin(ang) * rad * 4.2;
          // 抛物线：冲上去再落下
          p.y += (6.0 + aSeed * 10.0) * ph * (1.0 - ph * 1.08) * 2.4;
          vA = smoothstep(0.0, 0.10, ph) * (1.0 - ph);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (150.0 + aSeed * 190.0) * (0.55 + 0.45 * (1.0 - ph)) / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.02, d) * vA;
          gl_FragColor = vec4(vec3(0.86, 0.97, 1.0), a * 0.95);
        }`,
    });
    this.fallSplash = new THREE.Points(geo, mat);
    this.fallSplash.frustumCulled = false;
    this.group.add(this.fallSplash);
  }

  /**
   * 发卡弯分叉口的视觉导流。
   *
   * 这一段门 119~130 与 149~156 压在**同一条水面**上（入口和出口共用航道），
   * 任何实体墙都会把绕完回环的正常路线一起堵死，所以只用不参与碰撞的元素：
   *   · 石墩：rock_hazard_a.glb（Blender 出的带贴图岩石，吃光照、有投影）
   *   · 转向牌：guide_sign_post.glb 立柱 + canvas 画的黄色左折箭头
   * 摆在弯道外侧（北岸）一排，把"直行"的视觉出口收住，箭头指向要拐的方向。
   */
  #buildForkMarkers(def) {
    if (!this.openTrack || !def?.returnBank) return;
    const N = this.gates.length;
    // 位置全部落在发卡弯**外侧的堤顶走道**上：
    //   走道横向范围 = (gateWidth-0.4) ~ (gateWidth+0.4+walk)，堤顶高 = returnBank.height。
    // 之前把石墩摆在中线外 9m、贴水面高度，正好埋进堤身里（堤身占 7.1~10.7m 那一圈），
    // 水上一颗都看不见 —— 这就是"加了提示但截图里啥也没有"的原因。
    const walk = def.returnBank.walk ?? 2.2;
    const LAT = this.gateWidth + 0.4 + walk * 0.5;   // 走道中线 ≈ 9.0m
    const TOP = def.returnBank.height ?? 3.4;        // 走道面离水面
    // 门 131→136 从西行拐向 -z、再折回 +x，所以 -n 一侧就是弯道外侧。
    const at = (f) => {
      const i = Math.floor(f) % N;
      const t = f - Math.floor(f);
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      return {
        x: a[0] + dx * t + (dz / L) * LAT,
        z: a[1] + dz * t - (dx / L) * LAT,
        y: (this.gateY?.[i] ?? 0) + TOP,
        hx: dx / L,
        hz: dz / L,
      };
    };
    // 顺着弯道排一列石墩（每 ~9m 一颗），玩家沿墙就能读出发卡线的走向
    const rocks = [131.2, 131.8, 132.4, 133.0, 133.6, 134.2, 134.8].map(at);
    const signs = [at(131.5), at(133.3)];

    loadPropGlb(MAGMA_OBSTACLE_GLB.boulderA).then((gltf) => {
      if (!this.group.parent) return;
      const src = gltf.scene;
      src.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(src);
      const size = box.getSize(new THREE.Vector3());
      const k = 2.2 / Math.max(0.001, Math.max(size.x, size.z));
      for (let i = 0; i < rocks.length; i++) {
        const r = rocks[i];
        const o = src.clone(true);
        o.name = 'fork_rock';
        o.scale.setScalar(k * (0.9 + (i % 3) * 0.08));
        o.position.set(r.x, r.y - box.min.y * k, r.z);
        o.rotation.y = Math.atan2(r.hx, r.hz) + i * 0.7;
        o.traverse((m) => {
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = true;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mt of mats) {
            if (!mt) continue;
            mt.roughness = 0.92;
            mt.metalness = 0.02;
            mt.envMapIntensity = 0.5;
          }
        });
        this.group.add(o);
      }
    }).catch((e) => console.warn('[fork] 石墩加载失败', e));

    // 箭头贴片：黄色右折 V 形（发卡弯是右转），深蓝底，远看像一块路牌
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#123b57';
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(42, 18);
    ctx.lineTo(96, 64);
    ctx.lineTo(42, 110);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    // 牌面用不受光的基础材质：保证蓝底黄箭头在逆光/阴影下也一眼能读，
    // 也不会被 tonemap 洗成土黄色
    const plateMat = new THREE.MeshBasicMaterial({
      map: tex, side: THREE.DoubleSide, toneMapped: false,
    });

    loadPropGlb(FLOW_SIGN_POST_URL).then((gltf) => {
      if (!this.group.parent) return;
      const src = gltf.scene;
      src.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(src);
      const size = box.getSize(new THREE.Vector3());
      const k = 3.2 / Math.max(0.001, size.y);
      for (const s of signs) {
        const o = src.clone(true);
        o.name = 'fork_sign';
        o.scale.setScalar(k);
        o.position.set(s.x, s.y - box.min.y * k, s.z);
        // 牌面朝向来船（法线 = -heading），贴片 +X 正好指向转弯侧
        o.rotation.y = Math.atan2(-s.hx, -s.hz);
        o.traverse((m) => {
          if (!m.isMesh) return;
          m.castShadow = true;
          m.receiveShadow = true;
        });
        this.group.add(o);
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(1.85, 1.45), plateMat);
        plate.name = 'fork_arrow';
        plate.scale.setScalar(1 / o.scale.x);
        plate.position.set(0, 2.5, 0.31);
        o.add(plate);
      }
    }).catch((e) => console.warn('[fork] 转向牌加载失败', e));
  }

  /**
   * 洞内照明：沿门 2..21 每 ~3 门在航道两侧交替立一盏木柱灯（flow_marker.glb，
   * 自带木纹贴图 + 发光灯罩），并各挂一盏暖色点光。
   *
   * 背景：场景只有半球光 + 平行光，洞顶恢复后洞里整片落在平行光阴影里，纯 PBR
   * 岩壁直接黑成一团 —— 玩家截图里的"大黑墙"就是这么来的（不是几何挡路）。
   * 点光不投阴影，7 盏的量级对帧率没有明显影响；灯柱本身放在走廊外侧 0.7m，
   * 不参与碰撞，也不会挡住船。
   */
  #buildCaveLamps() {
    const N = this.gates.length;
    const last = Math.min(21, N - 2);
    if (last < 3) return;
    const HW = this.gateWidth + 0.7;
    const spots = [];
    let side = 1;
    for (let g = 2; g <= last; g += 3) {
      const a = this.gates[g];
      const b = this.gates[(g + 1) % N];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L;
      const nz = dx / L;
      spots.push({
        x: a[0] + nx * HW * side,
        z: a[1] + nz * HW * side,
        y: this.gateY?.[g] ?? 0,
        rot: Math.atan2(nx * side, nz * side),
      });
      side = -side;
    }
    for (const s of spots) {
      // three.js 现在的点光是坎德拉（平方衰减），洞内测下来 70 几乎看不出光，
      // 1800 / 120m 这一档才能把 7m 高的洞顶和两侧岩壁照出层次（实测 A/B）。
      const light = new THREE.PointLight(0xffb066, 1800, 120, 2);
      light.position.set(s.x, s.y + 2.9, s.z);
      this.group.add(light);
    }
    loadPropGlb(FLOW_MARKER_URL).then((gltf) => {
      if (!this.group.parent) return;
      const src = gltf.scene;
      src.updateMatrixWorld(true);
      // 原型底边可能不在 y=0（灯柱脚在地上），统一按包围盒底边归位
      const bottom = new THREE.Box3().setFromObject(src).min.y;
      const byMat = new Map();
      for (const s of spots) {
        const o = src.clone(true);
        o.position.set(s.x, s.y - bottom, s.z);
        o.rotation.y = s.rot;
        o.updateMatrixWorld(true);
        o.traverse((m) => {
          if (!m.isMesh || !m.geometry) return;
          const geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
          const mat = Array.isArray(m.material) ? m.material[0] : m.material;
          if (!mat) return;
          if (!byMat.has(mat)) byMat.set(mat, []);
          byMat.get(mat).push(geo);
        });
      }
      const grp = new THREE.Group();
      grp.name = 'cave_lamps';
      for (const [mat, geos] of byMat) {
        const merged = mergeGeometries(geos, false);
        if (!merged) continue;
        const mn = (mat.name || '').toLowerCase();
        if (mn.includes('lamp')) {
          // 原型灯罩是冷青自发光，洞里换成暖白，和下面那盏点光同色温
          mat.emissive = new THREE.Color(0xffb066);
          mat.emissiveIntensity = 2.4;
          mat.color = new THREE.Color(0xfff0d0);
          mat.toneMapped = false;
        } else {
          mat.vertexColors = false;
          mat.roughness = 0.86;
          mat.metalness = 0.02;
        }
        mat.needsUpdate = true;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        grp.add(mesh);
      }
      this.group.add(grp);
    }).catch((e) => console.warn('[cave-lamps] 灯柱加载失败', e));
  }

  /** 洞内荧光：160 颗会呼吸的萤火虫（沿洞段中心线随机分布） */
  #buildCaveGlow() {
    // 洞段 = 前 22 个门（约 330m）
    const N = Math.min(22, this.gates.length - 1);
    if (N < 3) return;
    const COUNT = 160;
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    const tint = new Float32Array(COUNT * 3);
    const cA = new THREE.Color(0x66ffcc);   // 荧光青
    const cB = new THREE.Color(0xffd27a);   // 暖萤黄
    for (let i = 0; i < COUNT; i++) {
      const gi = Math.floor(Math.random() * (N - 1));
      const a = this.gates[gi], b = this.gates[gi + 1];
      const t = Math.random();
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      const nx = -dz / L, nz = dx / L;
      const lat = (Math.random() * 2 - 1) * 6.2;
      pos[i*3] = x + nx * lat;
      pos[i*3+1] = 0.8 + Math.random() * 5.2;
      pos[i*3+2] = z + nz * lat;
      seed[i] = Math.random();
      const c = Math.random() < 0.72 ? cA : cB;
      tint[i*3] = c.r; tint[i*3+1] = c.g; tint[i*3+2] = c.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        attribute float aSeed; attribute vec3 aTint;
        uniform float uTime; varying float vGlow; varying vec3 vTint;
        void main() {
          vTint = aTint;
          vGlow = 0.45 + 0.55 * sin(uTime * (0.7 + aSeed * 1.6) + aSeed * 41.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (110.0 + aSeed * 90.0) / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vGlow; varying vec3 vTint;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.05, d) * vGlow;
          gl_FragColor = vec4(vTint * (0.7 + vGlow * 1.2), a);
        }`,
    });
    this.caveGlow = new THREE.Points(geo, mat);
    this.caveGlow.frustumCulled = false;
    this.group.add(this.caveGlow);
  }

  /** 距中心线的横向距离（烘焙赛道：云端镂空检测用） */
  lateralAt(pos, hint = null) {
    const probe = this.#probeMain(pos.x, pos.z, hint);
    const N = this.gates.length;
    const i = Math.max(0, Math.min(N - 1, probe.i));
    const a = this.gates[i], b = this.gates[Math.min(N - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const cx = a[0] + dx * probe.t;
    const cz = a[1] + dz * probe.t;
    const lat = Math.abs((pos.x - cx) * (-dz / L) + (pos.z - cz) * (dx / L));
    return { i, lat };
  }

  /** 烘焙赛道的水面高度：沿最近门段线性插值 */
  #bakedHeightAt(pos, hint = null) {
    const probe = this.#probeMain(pos.x, pos.z, hint);
    const N = this.gates.length;
    const i = Math.max(0, Math.min(N - 1, probe.i));
    const j = Math.min(N - 1, i + 1);
    const y0 = this.gateY[i] ?? 0;
    const y1 = this.gateY[j] ?? y0;
    return y0 + (y1 - y0) * probe.t;
  }

  /**
   * 近道端点吸附到主赛道中线：入口/出口落在主道中心线上，
   * 配合 constrain() 的端部宽度过渡，让进出近道像在主道上行驶一样连续，
   * 消除旧版"端点钳位投影"造成的入口吸入顿挫与出口空气墙。
   */
  #snapShortcutEnds() {
    if (!this.shortcuts.length) return;
    const mainLoop = [...this.gates, this.gates[0]];
    for (const sc of this.shortcuts) {
      const first = nearestOnPolyline(mainLoop, sc.points[0][0], sc.points[0][1]);
      sc.points[0] = [first.px, first.pz];
      const li = sc.points.length - 1;
      const last = nearestOnPolyline(mainLoop, sc.points[li][0], sc.points[li][1]);
      sc.points[li] = [last.px, last.pz];
    }
  }

  /** 中心线弧长表（沿 gates 折线累计；开环非闭合只算 N-1 段） */
  #buildArcTable() {
    const N = this.gates.length;
    const segs = this.openTrack && !this.loopClosed ? N - 1 : N;
    this.arcCum = [0];
    for (let i = 0; i < segs; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      this.arcCum.push(this.arcCum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.arcSegments = Math.max(1, segs);
    this.arcTotal = this.arcCum[segs] || 1;
  }

  /** 门 i 的赛段前向单位向量（公开版，给终点线判定用） */
  gateDir(i) { return this.#gateDir(i); }

  /**
   * 某点投影到中心线上的累计弧长（0..arcTotal）。
   * 圈数判定用它算"这一圈跑了多远"，不依赖门序号：
   * 漏掉几个门也不会让圈数/终点失效。
   * @returns {{s:number, d:number, total:number}}
   */
  arcAt(x, z) {
    const N = this.gates.length;
    const segs = this.arcSegments || N;
    let best = Infinity;
    let s = 0;
    for (let i = 0; i < segs; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L2 = dx * dx + dz * dz;
      if (L2 < 1e-9) continue;
      let u = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
      u = u < 0 ? 0 : (u > 1 ? 1 : u);
      const px = a[0] + dx * u;
      const pz = a[1] + dz * u;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < best) {
        best = d2;
        s = this.arcCum[i] + Math.sqrt(L2) * u;
      }
    }
    return { s, d: Math.sqrt(best), total: this.arcTotal };
  }

  #gateDir(i) {
    const g = this.gates[i];
    const n = this.gates[(i + 1) % this.gates.length];
    const dx = n[0] - g[0];
    const dz = n[1] - g[1];
    const len = Math.hypot(dx, dz) || 1;
    return { dx: dx / len, dz: dz / len };
  }

  /**
   * 每个门的高度剖面。默认 sin 形：两端 0、中间 = height，首尾斜率为 0。
   * overpass.profile 存在时按"门序"逐门给高度（回旋环这种需要连续爬升、
   * 在自交处以明显高差上下错开的形状，sin 给不出可控的高差）。
   * 没有 overpass 的地图整张表都是 0，行为与以前完全一致。
   */
  #computeGateY() {
    const N = this.gates.length;
    const arr = new Float32Array(N);
    const op = this.overpass;
    if (!op) return arr;
    const span = (((op.to - op.from) % N) + N) % N;
    if (span < 2) return arr;
    if (Array.isArray(op.profile) && op.profile.length >= span + 1) {
      for (let k = 0; k <= span; k++) {
        const v = Number(op.profile[k]);
        arr[(op.from + k) % N] = Number.isFinite(v) && v > 0 ? v : 0;
      }
      return arr;
    }
    const H = op.height ?? 5;
    if (H <= 0) return arr;
    for (let k = 0; k <= span; k++) {
      arr[(op.from + k) % N] = H * Math.sin((Math.PI * k) / span);
    }
    return arr;
  }

  /**
   * 某点是否落在立交桥（抬升段）的桥面投影下，返回该处桥面高度。
   * 浮桶只沿水面铺，桥下/桥面上的浮桶必须剔除，否则回旋环会同时出现
   * 一条水面浮桶赛道 + 一条高架桥，两层交织成一团。
   */
  #overpassDeckAt(x, z) {
    const op = this.overpass;
    if (!op) return 0;
    const N = this.gates.length;
    const from = op.from;
    const span = (((op.to - from) % N) + N) % N;
    const reach = this.gateWidth + 3.5;
    let best = 0;
    for (let k = 0; k < span; k++) {
      const i = (from + k) % N;
      const j = (i + 1) % N;
      const y0 = this.gateY[i];
      const y1 = this.gateY[j];
      if (y0 < 0.15 && y1 < 0.15) continue;
      const a = this.gates[i];
      const b = this.gates[j];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L2 = dx * dx + dz * dz || 1;
      let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      if (Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t)) > reach) continue;
      const h = y0 + (y1 - y0) * t;
      if (h > best) best = h;
    }
    return best;
  }

  /**
   * 桥面高度（按门索引插值）。同一片水面被赛线穿过两次，光按坐标分不出上下层，
   * 所以既要用门号，也要记住"上一帧在哪一层"（state.i）。
   *
   * 旧版只查门号前后 2 段、取最高值：螺旋梯拐弯急、两层又在 (813,5) 交叉，
   * 门号差一格或横向偏一点就返回 0 → 船瞬间掉到水面，门号追上又弹回桥上。
   * 现在：窗口放宽到前后各 2 段；候选多个时优先延续上一帧那段；短暂找不到
   * 桥面时先维持上一帧高度（12 帧宽限），不再一帧归零。
   */
  #deckHeightAt(pos, gateHint, state = null) {
    if (!this.overpass) return 0;
    const N = this.gates.length;
    const hint = gateHint != null ? gateHint : state?.i;
    if (hint == null) return 0;
    const gi = ((Math.round(hint) % N) + N) % N;
    const reach = this.gateWidth + 1.1;
    const cands = [];
    for (let d = -2; d <= 2; d++) {
      const i = ((gi + d) % N + N) % N;
      const j = (i + 1) % N;
      const y0 = this.gateY[i];
      const y1 = this.gateY[j];
      if (y0 < 0.02 && y1 < 0.02) continue;
      const a = this.gates[i];
      const b = this.gates[j];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L2 = dx * dx + dz * dz || 1;
      let t = ((pos.x - a[0]) * dx + (pos.z - a[1]) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const cx = a[0] + dx * t;
      const cz = a[1] + dz * t;
      // 点到线段的真距离，不能用垂直分量：平行直道会被误判成在桥面上。
      if (Math.hypot(pos.x - cx, pos.z - cz) > reach) continue;
      cands.push({ i, h: y0 + (y1 - y0) * t });
    }
    if (!cands.length) {
      if (state && state.miss < 12 && state.h > 0.05) {
        state.miss++;
        return state.h;   // 偏出桥面先撑住，避免一帧掉落
      }
      if (state) { state.miss++; state.h = 0; }
      return 0;
    }
    const ring = (a, b) => {
      const d = Math.abs(a - b);
      return Math.min(d, N - d);
    };
    let best = null;
    if (state && state.i >= 0) {
      // 1) 仍在上一帧那段：交叉点上下两层唯一可靠的选层依据
      best = cands.find((c) => c.i === state.i) || null;
      // 2) 高度连续的相邻段（刚过门 / 门号短暂错位）
      if (!best && state.h > 0.05) {
        best = cands
          .filter((c) => Math.abs(c.h - state.h) < 3)
          .sort((a, b) => Math.abs(a.h - state.h) - Math.abs(b.h - state.h))[0] || null;
      }
      // 3) 实在对不上，取离上一帧门号最近的一段
      if (!best) best = cands.slice().sort((a, b) => ring(a.i, state.i) - ring(b.i, state.i))[0];
    } else {
      best = cands.slice().sort((a, b) =>
        ring(a.i, gi) - ring(b.i, gi))[0];
    }
    if (state) {
      state.i = best.i;
      state.h = best.h;
      state.miss = 0;
    }
    return best.h;
  }

  /**
   * 逐门高度图（gateHeights）的按坐标插值：单层赛道，直接沿折线投影取最高一段。
   * 只用于"没有上下层歧义"的图（波浪栈道），立交桥仍走 #deckHeightAt。
   *
   * ⚠️ 走廊判定必须用"点到线段的真距离"，不能只用垂直分量。
   * 旧写法把 t 钳到 [0,1] 之后仍只取垂直分量：当船早已越过该段端点（或在这段
   * 身后的延伸线上）时，沿段方向的那一大截位移被直接丢掉，只要方向凑巧接近平行，
   * 垂距就很小 → 判定"在栈道走廊内"。
   * 霓虹海峡就是这么中招的：波浪栈道 #24-28 在 z≈-570、x≈10，而归程长直道
   * 在 x≈100、z -860→-380；直道的走向（正北）与栈道末段 #26 的走向几乎平行，
   * 于是整条归程直道被算成 2.6~3.0m 高 —— 赛艇凭空抬升、脚下水面在 3m 以下，
   * 顺带把这一段的浮桶全裁掉了（浮桶的过滤条件复用同一个函数）。
   */
  #gateHeightAt(pos) {
    if (!this.gateHeights) return 0;
    const N = this.gates.length;
    const corridor = this.gateWidth + 1.1;
    let best = 0;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      const y0 = this.gateY[i];
      const y1 = this.gateY[j];
      if (y0 < 0.02 && y1 < 0.02) continue;
      const a = this.gates[i];
      const b = this.gates[j];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L2 = dx * dx + dz * dz || 1;
      let t = ((pos.x - a[0]) * dx + (pos.z - a[1]) * dz) / L2;
      t = Math.max(0, Math.min(1, t));
      const cx = a[0] + dx * t;
      const cz = a[1] + dz * t;
      // 真距离（t 被钳过，所以这里天然包含了"落在段外的沿段位移"）
      if (Math.hypot(pos.x - cx, pos.z - cz) > corridor) continue;
      const h = y0 + (y1 - y0) * t;
      if (h > best) best = h;
    }
    return best;
  }

  /** 布景/护栏取高：优先逐门高度图，其次潜行/立交（无 gateHint 时立交返回 0）。 */
  /**
   * 赛道表面高度（道具箱 / 落地布景用）。
   * 抬高段（瀑布、云端、波浪栈道）返回该处的 gateY，平地返回 0。
   * 道具箱以前一律用 waveHeight 贴海面，放在抬高段就会掉到赛道下方几十米。
   */
  surfaceYAt(x, z, hint = null) {
    return this.#visualHeightAt(x, z, hint);
  }

  #visualHeightAt(x, z, hint = null) {
    if (this.gateHeights) return this.#gateHeightAt({ x, z });
    return this.diveHeightAt({ x, z }, hint) || 0;
  }

  /** 给几何体整体刷一个顶点色（合批后仍能一件一色） */
  #paint(geo, hex) {
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  }

  /**
   * 门柱已整体删除（用户反馈：又丑又占地方）。
   * 过门判定只用门中心线与门号，柱体纯属视觉锚点；边界交给浮桶链表达。
   * 数组保留空实现，updateVisual 等调用方无需分支。
   */
  #buildGates() {
    this.gateMeshes = [];
  }

  #buildPalaceGate() {
    const def = this.map.palaceGate;
    const { dx, dz } = this.#gateDir(def.gate);
    const base = this.gates[def.gate];
    const x = base[0] + dx * (def.entryOffset || 0);
    const z = base[1] + dz * (def.entryOffset || 0);
    const nx = -dz;
    const nz = dx;
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x7ae6df, emissive: 0x1b7f83, emissiveIntensity: 0.8,
      roughness: 0.35, metalness: 0.25,
    });
    const barMat = new THREE.MeshStandardMaterial({
      color: 0xf2c85b, emissive: 0x7b4e12, emissiveIntensity: 0.9,
      roughness: 0.3, metalness: 0.45,
    });
    const group = new THREE.Group();
    const frame = new THREE.Group();
    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 10, 10), frameMat);
      pillar.position.set(nx * (this.gateWidth + 1) * side, 5, nz * (this.gateWidth + 1) * side);
      frame.add(pillar);
    }
    group.add(frame);
    const leaf = new THREE.Group();
    const beam = new THREE.Mesh(new THREE.BoxGeometry(this.gateWidth * 1.75, 0.7, 0.7), barMat);
    beam.position.y = 5.5;
    leaf.add(beam);
    for (let i = -4; i <= 4; i++) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 4.6, 8), barMat);
      bar.position.set(i * (this.gateWidth * 1.75 / 8), 2.8, 0);
      leaf.add(bar);
    }
    leaf.position.set(0, -1.6, 0);
    leaf.rotation.y = Math.atan2(dx, dz);
    group.add(leaf);
    group.position.set(x, 0, z);
    group.visible = true;
    this.group.add(group);
    this.palaceGate = { ...def, x, z, nx, nz, leaf, group, open01: 0 };

    // 带贴图的闸门：模型到位后替换金龙栏杆，leaf 的升降动画与碰撞窗口不变
    loadPropGlb(PALACE_GATE_URL).then((gltf) => {
      const wrap = fitPropModel(gltf.scene.clone(true), {
        span: this.gateWidth * 1.75,
        maxH: 5.4,
      });
      for (const child of leaf.children) {
        if (child.isMesh) child.geometry?.dispose();
      }
      leaf.clear();
      leaf.add(wrap);
      leaf.userData.isModel = true;
    }).catch((err) => {
      console.warn('[track] 龙宫闸门模型加载失败，保留程序化栏杆', err);
    });

    // 门框立柱同样换成石质门架（原来两根青绿圆柱）
    loadPropGlb(PALACE_FRAME_URL).then((gltf) => {
      const wrap = fitPropModel(gltf.scene.clone(true), {
        span: (this.gateWidth + 1) * 2 + 2.4,
        maxH: 11.6,
        yaw: Math.atan2(dx, dz),
      });
      for (const child of frame.children) {
        if (child.isMesh) child.geometry?.dispose();
      }
      frame.clear();
      frame.add(wrap);
    }).catch((err) => {
      console.warn('[track] 龙宫门框模型加载失败，保留程序化立柱', err);
    });
  }

  #buildGuideMarkers() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9cf6ef, emissive: 0x278f91, emissiveIntensity: 1.1,
      roughness: 0.4, metalness: 0.15,
    });
    const holders = [];
    for (let i = 0; i < this.gates.length; i += 2) {
      const [x, z] = this.gates[i];
      const { dx, dz } = this.#gateDir(i);
      const nx = -dz;
      const nz = dx;
      const holder = new THREE.Group();
      holder.rotation.y = Math.atan2(dx, dz);
      holder.position.set(
        x + nx * this.gateWidth * 0.72,
        (this.diveHeightAt({ x, z }) || 0) + 0.4,
        z + nz * this.gateWidth * 0.72,
      );
      // 兜底：原来的青绿四棱锥
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.65, 2.8, 4), mat);
      cone.rotation.x = Math.PI / 2;
      cone.position.y = 1.4;
      holder.add(cone);
      this.group.add(holder);
      holders.push(holder);
    }
    // 木浮标 + 前进箭头（带贴图），加载失败就继续用四棱锥
    loadPropGlb(FLOW_MARKER_URL).then((gltf) => {
      for (const holder of holders) {
        for (const child of holder.children) {
          if (child.isMesh) child.geometry?.dispose();
        }
        holder.clear();
        holder.add(fitPropModel(gltf.scene.clone(true), {
          span: 1.9, maxH: 2.8, center: false,
        }));
      }
    }).catch((err) => {
      console.warn('[track] 指示浮标模型加载失败，保留四棱锥', err);
    });
  }

  /**
   * 赛道边缘浮桶链（替代原来的蓝色棒棒糖立柱）。
   *
   * 浮桶必须落在碰撞走廊的边界上：走廊 = 中线折线 + 半径 W，W = gateWidth - 0.6
   * （#probeMain 直接读 this.edgeOffset）。旧实现按“当前门段”的垂直方向逐点偏移，
   * 拐角处相邻两段的偏移点会连成一条切进走廊的弦（139° 折角时弦中点只有 2.6m，
   * 而碰撞半径 7.4m），船贴边时看起来就越过了浮桶；凹角两侧的桶还会互相穿插。
   *
   * 现在沿真正的等距偏移线铺桶：直段用平行线，拐角统一用半径 W 的圆弧收口。
   * 圆弧不会和相邻段交叉，整条链连续；近道口 / 抬高栈道直接断绳，
   * 不会跨水面拉一条穿帮的绳子。
   *
   * 全部 InstancedMesh + 若干动态 Line，整套只占几次绘制。
   * 配色按天气换（day/dusk/storm/blizzard/starry），换天气时整组重建。
   * storm / starry 两套带自发光（恶劣天气与夜色里靠 emissive 才看得见边界）。
   */
  #buildEdgeBuoys(weatherId = 'day') {
    this.#clearEdgeBuoys();
    this.buoyWeather = weatherId;
    const pal = BUOY_PALETTES[weatherId] || BUOY_PALETTES.day;
    const N = this.gates.length;
    const off = Math.max(2, this.gateWidth - 0.6);   // 浮桶中线 = 碰撞走廊半径
    this.edgeOffset = off;
    if (N < 4) return;

    // 每个门的转角：决定这一段的浮桶间距
    const turnAt = [];
    for (let i = 0; i < N; i++) {
      const p = this.gates[(i - 1 + N) % N], c = this.gates[i], n = this.gates[(i + 1) % N];
      const a1 = Math.atan2(c[1] - p[1], c[0] - p[0]);
      const a2 = Math.atan2(n[1] - c[1], n[0] - c[0]);
      let d = a2 - a1;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turnAt.push(d);
    }

    const stations = [];

    // 近道口缺口：只在近道真正伸出的那一侧开，避免把整条浮桶链剪断
    const gapBySide = new Map([[1, []], [-1, []]]);
    const mainLoop = [...this.gates, this.gates[0]];
    for (const sc of this.shortcuts || []) {
      const pts = sc.points;
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const ends = [
        { p: pts[0], out: [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]] },
        {
          p: pts[pts.length - 1],
          // 从主道指向近道内部的方向：末端要取"倒数第二点 - 末点"，
          // 用正向会把缺口开在相反一侧（发卡弯两侧浮桶都会被剪断）
          out: [
            pts[pts.length - 2][0] - pts[pts.length - 1][0],
            pts[pts.length - 2][1] - pts[pts.length - 1][1],
          ],
        },
      ];
      for (const e of ends) {
        const loc = nearestOnPolyline(mainLoop, e.p[0], e.p[1]);
        const seg = Math.min(loc.seg, N - 1);
        const a = this.gates[seg], b = this.gates[(seg + 1) % N];
        const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const ux = (b[0] - a[0]) / segLen, uz = (b[1] - a[1]) / segLen;
        const onLeft = e.out[0] * -uz + e.out[1] * ux;
        let gate = -1, gateD = Infinity;
        for (let i = 0; i < N; i++) {
          const d = Math.hypot(this.gates[i][0] - e.p[0], this.gates[i][1] - e.p[1]);
          if (d < gateD) { gateD = d; gate = i; }
        }
        if (gate < 0 || gateD > 12) continue;
        gapBySide.get(onLeft >= 0 ? 1 : -1).push({ gate, half: sc.width + 2.0 });
      }
    }

    // 等距偏移线：直段平移 halfW，拐角用半径 halfW 的圆弧收口（round join），
    // 圆弧与相邻段天然不相交，凹角也不会互穿。
    const buildDense = (pts, halfW, side, closed, turns, gaps, keepFn) => {
      const M = pts.length;
      const segCount = closed ? M : M - 1;
      const dirs = [], normals = [];
      for (let i = 0; i < segCount; i++) {
        const a = pts[i], b = pts[(i + 1) % M];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        dirs.push([dx / len, dz / len]);
        normals.push([-dz / len, dx / len]);
      }
      const cornerSets = [];
      for (let i = 0; i < M; i++) {
        const v = pts[i], set = [];
        if (!closed && i === 0) {
          const n = normals[0];
          set.push([v[0] + n[0] * side * halfW, v[1] + n[1] * side * halfW]);
        } else if (!closed && i === M - 1) {
          const n = normals[segCount - 1];
          set.push([v[0] + n[0] * side * halfW, v[1] + n[1] * side * halfW]);
        } else {
          const d1 = dirs[(i - 1 + segCount) % segCount];
          const d2 = dirs[i % segCount];
          const turn = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
          const n = normals[(i - 1 + segCount) % segCount];
          const n2 = normals[i % segCount];
          const ux = n[0] * side, uz = n[1] * side;
          if (Math.abs(turn) < 0.004) {
            set.push([v[0] + ux * halfW, v[1] + uz * halfW]);
          } else if (side * turn > 0) {
            // 内角：走廊在这里是一个尖楔，边界是两条偏移线的交点（miter）。
            // 用圆弧会把浮桶压进走廊内部（弦高只有 W·cos(θ/2)，139° 时掉到 2.6m），
            // 船贴边就会越过浮桶 —— 这正是原来"看起来冲出赛道"的根因。
            //
            // ⚠ 但夹角很尖时（海峡 39 号门回头弯 155°），交点会被推到 **34.5m** 外，
            // 浮桶链就被拉成一根细长的针：针两侧各一排桶、中间只隔 2m，
            // 看起来就是"两只桶交叉穿模"。所以给斜接长度设上限（业界 offset 曲线的
            // miterLimit）：超过 MITER_LIMIT × halfW 就沿内角平分线截断，不让它甩出几十米。
            const p1x = v[0] + n[0] * side * halfW, p1z = v[1] + n[1] * side * halfW;
            const p2x = v[0] + n2[0] * side * halfW, p2z = v[1] + n2[1] * side * halfW;
            const den = d1[0] * d2[1] - d1[1] * d2[0];
            const MITER_LIMIT = 2.5;
            const capLen = halfW * MITER_LIMIT;
            if (Math.abs(den) < 1e-6) {
              set.push([p1x, p1z]);
            } else {
              const t = ((p2x - p1x) * d2[1] - (p2z - p1z) * d2[0]) / den;
              const mx = p1x + d1[0] * t;
              const mz = p1z + d1[1] * t;
              if (Math.hypot(mx - v[0], mz - v[1]) <= capLen) {
                set.push([mx, mz]);
              } else {
                // 沿内角平分线截到上限：拐角从"细针"变成"短促的折角"
                const bx = n[0] * side + n2[0] * side;
                const bz = n[1] * side + n2[1] * side;
                const bl = Math.hypot(bx, bz) || 1;
                set.push([v[0] + (bx / bl) * capLen, v[1] + (bz / bl) * capLen]);
              }
            }
          } else {
            // 外角：半径 halfW 的圆弧收口（round join），和相邻段天然不相交
            const steps = Math.max(1, Math.ceil(halfW * Math.abs(turn) / 3));
            for (let k = 0; k <= steps; k++) {
              const ang = turn * (k / steps);
              const c = Math.cos(ang), s = Math.sin(ang);
              set.push([v[0] + (ux * c - uz * s) * halfW, v[1] + (ux * s + uz * c) * halfW]);
            }
          }
        }
        cornerSets.push(set);
      }
      const dense = [];
      const push = (x, z, step) => {
        const last = dense[dense.length - 1];
        if (last && Math.hypot(last.x - x, last.z - z) < 0.02) return;
        dense.push({ x, z, step, keep: true });
      };
      const cornerIdx = [];
      for (let i = 0; i < M; i++) {
        const step = closed ? (Math.abs(turns[i]) > 0.35 ? 8 : 14) : 11;
        const start = dense.length;
        for (const p of cornerSets[i]) push(p[0], p[1], step);
        cornerIdx[i] = { a: start, b: dense.length - 1 };
        if (closed || i < M - 1) {
          const A = cornerSets[i][cornerSets[i].length - 1];
          const B = cornerSets[(i + 1) % M][0];
          const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
          const n = Math.max(1, Math.ceil(L / 3));
          for (let k = 1; k < n; k++) {
            const t = k / n;
            push(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, step);
          }
        }
      }
      let s = 0;
      for (let i = 0; i < dense.length; i++) {
        if (i > 0) s += Math.hypot(dense[i].x - dense[i - 1].x, dense[i].z - dense[i - 1].z);
        dense[i].s = s;
      }
      const totalLen = s;
      for (const g of gaps) {
        const ci = cornerIdx[g.gate];
        if (!ci) continue;
        const center = (dense[ci.a].s + dense[ci.b].s) / 2;
        for (const d of dense) {
          let diff = Math.abs(d.s - center);
          if (closed) diff = Math.min(diff, totalLen - diff);
          if (diff <= g.half) d.keep = false;
        }
      }
      if (keepFn) for (const d of dense) if (d.keep && !keepFn(d.x, d.z)) d.keep = false;
      if (!closed) for (const d of dense) if (d.s < 8 || d.s > totalLen - 8) d.keep = false;
      return dense;
    };

    // 按弧长在偏移线上等距取样：连续段并成一条浮绳，缺口处断绳
    //
    // ⚠ 弧长等距只保证"沿线的先后间距"，管不了"空间距离"。回头弯的内角被 miter limit
    // 截断后仍是一根短尖刺：尖刺的**去程和回程在空间上只隔 1~2m**（夹角 25° 时，
    // 离尖端 2m 处两排桶才隔 0.9m），于是弧长上相隔 12m 的两只桶实际贴到了一起 ——
    // 视觉上就是"两只桶交叉、浮绳打结穿模"。所以这里再按空间距离兜一层：
    // 同一侧新桶离已落位的同侧桶不足 MIN_GAP 就不放（但 next 照常推进，不会死循环）。
    const MIN_GAP = 3.2;
    const sampleSide = (dense, side, startOffset) => {
      let acc = 0, next = startOffset, run = null;
      const placed = [];          // 本次调用已落位的桶坐标（同侧、跨缺口），只用于近距剔除
      const min2 = MIN_GAP * MIN_GAP;
      for (let i = 0; i < dense.length - 1; i++) {
        const p0 = dense[i], p1 = dense[i + 1];
        const L = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        if (L < 1e-4) continue;
        const keep = p0.keep && p1.keep;
        while (next <= acc + L) {
          const t = (next - acc) / L;
          const x = p0.x + (p1.x - p0.x) * t;
          const z = p0.z + (p1.z - p0.z) * t;
          if (keep) {
            let tooNear = false;
            for (let k = 0; k < placed.length; k++) {
              const ax = placed[k][0] - x, az = placed[k][1] - z;
              if (ax * ax + az * az < min2) { tooNear = true; break; }
            }
            if (!tooNear) {
              if (!run) { run = { side, list: [] }; lines.push(run); }
              const st = {
                side, x, z,
                phase: Math.random() * Math.PI * 2,
                scale: (0.9 + Math.random() * 0.22) * (pal.scale || 1),
              };
              stations.push(st);
              run.list.push(st);
              placed.push([x, z]);
            }
            // 被剔除时不重置 run：浮绳保持连续，只是少一只桶，不会在弯里断成两截
          } else run = null;
          next += p1.step || p0.step || 12;
        }
        acc += L;
      }
    };
    // 浮绳按“连续线”分组：主道每条边一条，每条近道每条边各一条。
    // 不能像旧版那样按 side 合并全图浮桶，否则近道浮桶会和主道浮桶跨水连绳。
    const lines = [];
    for (const side of [1, -1]) {
      const dense = buildDense(
        this.gates, off, side, true, turnAt, gapBySide.get(side) || [],
        this.gateHeights
          ? (x, z) => this.#gateHeightAt({ x, z }) <= 0.25
          // 立交回旋环整圈抬成桥面：水面浮桶全部让位给桥面路缘，
          // 否则桥下会再多出一条"水面赛道"，两层交织（用户反馈的浮桶打结）
          : this.overpass
            ? (x, z) => this.#overpassDeckAt(x, z) <= 0.5
            : null,
      );
      sampleSide(dense, side, 7);
    }

    // 近道两侧浮桶：入口/汇入段仍是主道缺口，只有主道走廊之外的中段才铺航向标。
    // 候选点自身离主道中线不足 keepClear 的直接丢弃，避免浮桶压进主道航路。
    const keepClear = this.gateWidth + 1.6;
    for (const sc of this.shortcuts || []) {
      const pts = sc.points;
      if (!Array.isArray(pts) || pts.length < 2) continue;
      for (const side of [1, -1]) {
        const dense = buildDense(
          pts, sc.width + 1.0, side, false, null, [],
          (x, z) => nearestOnPolyline(mainLoop, x, z).d > keepClear,
        );
        sampleSide(dense, side, 6);
      }
    }
    if (!stations.length) return;

    // 桶身：柱体 + 两道环带 + 顶盖（颜色烘进顶点色，一次绘制一个色）
    const bodyGeo = mergeGeometries([
      this.#paint(new THREE.CylinderGeometry(0.52, 0.6, 1.5, 9).translate(0, 0.45, 0), pal.body),
      this.#paint(new THREE.CylinderGeometry(0.58, 0.58, 0.32, 9).translate(0, 0.72, 0), pal.band),
      this.#paint(new THREE.CylinderGeometry(0.56, 0.56, 0.3, 9).translate(0, 1.18, 0), pal.band),
      this.#paint(new THREE.SphereGeometry(0.5, 9, 7).translate(0, 1.24, 0), pal.body),
    ], false);
    bodyGeo.computeBoundingSphere();
    const bodyMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.02,
    });
    // 恶劣天气（暴风雨）给桶身加自发光：雾里没有直射光，靠 emissive 才能"亮起来"。
    // 顶点色已经烘了桶身/环带，emissive 是整体一层，所以只给"整体该发亮"的天气开。
    if (pal.glow) {
      bodyMat.emissive = new THREE.Color(pal.glow);
      bodyMat.emissiveIntensity = pal.glowK ?? 1.0;
    }
    const body = new THREE.InstancedMesh(bodyGeo, bodyMat, stations.length);
    body.frustumCulled = false;
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(body);

    // 桶脚波纹
    const rippleGeo = new THREE.RingGeometry(0.66, 1.02, 18).rotateX(-Math.PI / 2);
    const rippleMat = new THREE.MeshBasicMaterial({
      color: pal.glow || pal.band, transparent: true,
      opacity: pal.glow ? 0.66 : 0.42,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const ripples = new THREE.InstancedMesh(rippleGeo, rippleMat, stations.length);
    ripples.frustumCulled = false;
    ripples.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(ripples);

    // 浮绳：沿相邻浮桶之间做多段采样（每段 4 小段），逐顶点贴当地浪高，
    // 保证绳子随水面起伏、但永远高在水面之上（旧版只取两端 + 中垂点，
    // 大浪时中段直线会被浪峰盖住，赛道边界就断了）。
    const ROPE_SUB = 4;
    const ROPE_LIFT = 0.42;
    const ropes = [];
    for (const routeLine of lines) {
      const list = routeLine.list;
      if (list.length < 2) continue;
      const pts = [];
      const colors = [];
      const c = new THREE.Color(pal.rope);
      const segs = list.length - 1;
      const vertCount = segs * ROPE_SUB + 1;
      for (let v = 0; v < vertCount; v++) {
        const i = Math.min(segs - 1, Math.floor(v / ROPE_SUB));
        const k = v - i * ROPE_SUB;
        const seg = list[i], next = list[i + 1];
        const t = Math.min(1, k / ROPE_SUB);
        pts.push(new THREE.Vector3(
          seg.x + (next.x - seg.x) * t, 0.4, seg.z + (next.z - seg.z) * t,
        ));
        colors.push(c.r, c.g, c.b);
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const rope = new THREE.Line(geo, new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.85,
      }));
      rope.frustumCulled = false;
      this.group.add(rope);
      ropes.push({ line: rope, list, sub: ROPE_SUB, lift: ROPE_LIFT });
    }

    this.edgeBuoys = { body, ripples, ropes, stations, count: stations.length };
    this.#updateEdgeBuoys(0);
  }

  #clearEdgeBuoys() {
    const b = this.edgeBuoys;
    if (!b) return;
    for (const m of [b.body, b.ripples]) {
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
      m.dispose();
    }
    for (const r of b.ropes) {
      this.group.remove(r.line);
      r.line.geometry.dispose();
      r.line.material.dispose();
    }
    this.edgeBuoys = null;
  }

  /** 跟天气换配色（晴朗/黄昏/暴风雨/暴风雪各一套） */
  setBuoyPalette(weatherId) {
    // 烘焙赛道的浮标由段模型自带，天气切换时不能再重建一遍
    // （之前这里漏了守卫：开局换天气就撒出一整排浮绳，洞里/云端都能看到）
    if (this.openTrack) return;
    if (!weatherId || weatherId === this.buoyWeather) return;
    this.#buildEdgeBuoys(weatherId);
  }

  #updateEdgeBuoys(t) {
    const b = this.edgeBuoys;
    if (!b) return;
    const dummy = this._buoyDummy || (this._buoyDummy = new THREE.Object3D());
    // 冰原区域的水面已被隐藏（只留冰壳），浮桶/浮绳必须贴着冰面 y=0.26，
    // 否则浪谷时会整排沉到冰壳下面，赛道边界直接消失。
    const ice = this.map?.iceZone;
    const surfaceY = (x, z) => (ice && Math.hypot(x - ice.x, z - ice.z) <= ice.r)
      ? 0.26
      : waveHeight(x, z, t);
    for (let i = 0; i < b.count; i++) {
      const st = b.stations[i];
      const h = surfaceY(st.x, st.z);
      const sway = Math.sin(t * 1.3 + st.phase) * 0.07;
      dummy.position.set(st.x, h - 0.28, st.z);
      dummy.rotation.set(sway * 0.6, st.phase, sway);
      dummy.scale.setScalar(st.scale);
      dummy.updateMatrix();
      b.body.setMatrixAt(i, dummy.matrix);

      dummy.position.set(st.x, h + 0.04, st.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(st.scale * (1 + Math.sin(t * 2 + st.phase) * 0.05));
      dummy.updateMatrix();
      b.ripples.setMatrixAt(i, dummy.matrix);
    }
    b.body.instanceMatrix.needsUpdate = true;
    b.ripples.instanceMatrix.needsUpdate = true;

    // 浮绳：逐顶点贴当地水面（多段采样），始终高出水面一个固定抬升，
    // 浪峰再高也不会把绳子盖住。
    for (const r of b.ropes) {
      const attr = r.line.geometry.attributes.position;
      const arr = attr.array;
      const segs = r.list.length - 1;
      const total = segs * r.sub + 1;
      let k = 0;
      for (let v = 0; v < total; v++) {
        const i = Math.min(segs - 1, Math.floor(v / r.sub));
        const f = Math.min(1, (v - i * r.sub) / r.sub);
        const p0 = r.list[i], p1 = r.list[i + 1];
        const x = p0.x + (p1.x - p0.x) * f;
        const z = p0.z + (p1.z - p0.z) * f;
        arr[k * 3] = x;
        arr[k * 3 + 1] = surfaceY(x, z) + r.lift;
        arr[k * 3 + 2] = z;
        k++;
      }
      attr.needsUpdate = true;
    }
  }

  #buildStartLine() {
    const [x, z] = this.gates[0];
    const { dx, dz } = this.#gateDir(0);
    // 起点线基准高度：波浪栈道 / 云端 / 回程堤岸这类抬高赛段的水面不在 y=0，
    // 起点线必须贴在"这一段自己的水面"上，否则高架段上的起点线会掉进海里。
    const baseY = this.gateY?.[0] ?? 0;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.88, side: THREE.DoubleSide,
      depthWrite: false,
    });
    // 细分网格：浪峰总幅值可达 1m 以上，一块固定平面会被浪整个埋掉（起点线看不见）。
    // 这里按横向 1.8m 一格的密度细分，逐顶点贴浪（见 #updateStartLine）。
    // 旋转直接烘进几何 → mesh 保持单位变换，顶点坐标即世界坐标，每帧只改 y。
    const segX = Math.max(8, Math.min(48, Math.round(this.startWidth / 1.8)));
    const geo = new THREE.PlaneGeometry(this.startWidth, 2.4, segX, 3);
    geo.rotateZ(Math.atan2(dx, dz));
    geo.rotateX(-Math.PI / 2);
    geo.translate(x, baseY, z);
    const line = new THREE.Mesh(geo, mat);
    line.frustumCulled = false;   // 顶点每帧都在改，包围球不可信
    line.renderOrder = 2;         // 水面之后再画，避免半透明被水面吞掉
    this.group.add(line);

    // 方格图案
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 4; j++) {
        ctx.fillStyle = (i + j) % 2 === 0 ? '#ffffff' : '#222222';
        ctx.fillRect(i * 8, j * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(canvas);
    // 起点线是贴着水面的大平面，几乎总是被斜视 —— 不开各向异性时
    // mipmap 会把黑白格糊成一条灰白带，"起跑线"看起来就是一根白条。
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    mat.map = tex;
    mat.needsUpdate = true;
    this.startLine = line;
    this.startLineBaseY = baseY;
    this.#updateStartLine(0);
  }

  /**
   * 起点线逐顶点贴浪：高度取**水面的实际渲染高度**而非解析波高。
   * 水面是 size/192≈11m 的粗网格（顶点采样 waveHeight 后线性插值），
   * 解析 waveHeight(x,z,t) 在浪谷处比渲染水面低 0.4m(晴)/1m(暴风)，
   * 直接用解析值会让起点线被浪盖住 —— 秘境漂流尤其明显（洞内 GLB 水面
   * 曾因相位多叠一次 uCenter 而错位 350,200，已改 modelMatrix 求世界坐标）。
   * Water.surfaceYAt 复刻 shader 的网格插值，两者严格同源；再抬 0.2m 余量。
   * 几何体的 x/z 是烘好的世界坐标，只需改写 y。
   */
  #updateStartLine(t) {
    const line = this.startLine;
    if (!line) return;
    const attr = line.geometry.attributes.position;
    const arr = attr.array;
    const baseY = this.startLineBaseY ?? 0;
    const water = this.opts?.water;
    for (let i = 0; i < attr.count; i++) {
      const x = arr[i * 3];
      const z = arr[i * 3 + 2];
      const surfaceY = water?.surfaceYAt
        ? water.surfaceYAt(x, z, t)
        : waveHeight(x, z, t); // 理论上都从 Game 传入；兜底保留旧行为
      arr[i * 3 + 1] = baseY + surfaceY + 0.2;
    }
    attr.needsUpdate = true;
  }

  // ---------- 立交桥：坡道 + 桥面 + 桥墩 ----------
  /**
   * 这张图的赛线在 gate 22-23 与 26-27 交叉于同一点，原来两层都在水面高度，
   * 视觉上就是"两条道糊在一起"。这里沿 gateY 剖面拉一条 15m 宽的桥面：
   * 两端 sin 坡道（0 → 5m），中间平顶，桥下留出净空让下层道穿过去。
   * 桥面高度与 diveHeightAt 用的是同一份 gateY，船开上去才对得上。
   */
  #buildOverpass() {
    const op = this.overpass;
    if (!op) return;
    const N = this.gates.length;
    const span = (((op.to - op.from) % N) + N) % N;
    if (span < 2) return;

    const halfW = this.gateWidth + 0.9; // 桥面半宽（航道 7.5 + 0.9 边）
    const thick = 0.85;

    // ---- 采样：沿门段每 ~5m 一点，高度取 gateY 的线性插值 ----
    const pts = [];
    for (let k = 0; k < span; k++) {
      const gi = (op.from + k) % N;
      const gj = (gi + 1) % N;
      const a = this.gates[gi];
      const b = this.gates[gj];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const steps = Math.max(2, Math.ceil(len / 5));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        pts.push({
          x: a[0] + (b[0] - a[0]) * t,
          z: a[1] + (b[1] - a[1]) * t,
          y: this.gateY[gi] + (this.gateY[gj] - this.gateY[gi]) * t,
        });
      }
    }
    const endGi = (op.from + span) % N;
    pts.push({ x: this.gates[endGi][0], z: this.gates[endGi][1], y: this.gateY[endGi] });
    if (pts.length < 3) return;

    // 每个点的左手法线
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[Math.min(pts.length - 1, i + 1)];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const l = Math.hypot(dx, dz) || 1;
      pts[i].nx = -dz / l;
      pts[i].nz = dx / l;
    }

    // ---- 桥面板（顶面 + 底面 + 两侧）----
    // 顶面/侧面/底面用不同的顶点亮度（顶亮、立面中、底最暗），配合混凝土贴图，
    // 让桥从任何角度看都有"体积 + 阴影"的感觉，而不是一块均匀的灰板。
    const deckV = [];
    const deckI = [];
    const deckU = [];
    const deckC = [];
    const quad = (a, b, c, d, ua, ub, uc, ud, shade) => {
      const base = deckV.length / 3;
      for (const [v, uv] of [[a, ua], [b, ub], [c, uc], [d, ud]]) {
        deckV.push(v[0], v[1], v[2]);
        deckU.push(uv[0], uv[1]);
        deckC.push(shade[0], shade[1], shade[2]);
      }
      deckI.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const TOP = [1.0, 1.0, 1.0];
    const SIDE = [0.72, 0.72, 0.74];
    const UNDER = [0.38, 0.38, 0.42];
    let run = 0; // 沿桥面的累计弧长，用来做贴图 U 重复
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const segLen = Math.hypot(q.x - p.x, q.z - p.z);
      const u0 = run / 7.5;
      const u1 = (run + segLen) / 7.5;
      run += segLen;
      const pl = [p.x + p.nx * halfW, p.y, p.z + p.nz * halfW];
      const pr = [p.x - p.nx * halfW, p.y, p.z - p.nz * halfW];
      const ql = [q.x + q.nx * halfW, q.y, q.z + q.nz * halfW];
      const qr = [q.x - q.nx * halfW, q.y, q.z - q.nz * halfW];
      const pb = (v) => [v[0], v[1] - thick, v[2]];
      // 顶面：v 横跨桥面 0..1（贴图两侧画边线）
      quad(pr, qr, ql, pl, [u0, 0], [u1, 0], [u1, 1], [u0, 1], TOP);
      // 底面（最暗，等于自带环境遮蔽）
      quad(pb(pl), pb(ql), pb(qr), pb(pr), [u0, 0], [u1, 0], [u1, 1], [u0, 1], UNDER);
      // 两侧立面：v 用高度方向
      quad(pl, ql, pb(ql), pb(pl), [u0, 1], [u1, 1], [u1, 0.55], [u0, 0.55], SIDE);
      quad(pr, pb(pr), pb(qr), qr, [u0, 1], [u0, 0.55], [u1, 0.55], [u1, 1], SIDE);
    }
    const deckGeo = new THREE.BufferGeometry();
    deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(deckV, 3));
    deckGeo.setAttribute('uv', new THREE.Float32BufferAttribute(deckU, 2));
    deckGeo.setAttribute('color', new THREE.Float32BufferAttribute(deckC, 3));
    deckGeo.setIndex(deckI);
    deckGeo.computeVertexNormals();
    const deckMat = new THREE.MeshStandardMaterial({
      map: this.#deckTexture(),
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    const deck = new THREE.Mesh(deckGeo, deckMat);
    deck.receiveShadow = false;
    deck.frustumCulled = false;
    this.group.add(deck);

    // ---- 桥下投影：贴在水面的一层柔和暗部，让桥"压"在水上而不是浮着 ----
    const shadowTex = this.#deckShadowTexture();
    const shV = [];
    const shI = [];
    const shU = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      if (p.y < 0.4 && q.y < 0.4) continue;
      const spread = 1.55; // 比桥面宽一点，模拟绕射
      const a = [p.x + p.nx * halfW * spread, 0.04, p.z + p.nz * halfW * spread];
      const b = [p.x - p.nx * halfW * spread, 0.04, p.z - p.nz * halfW * spread];
      const c = [q.x - q.nx * halfW * spread, 0.04, q.z - q.nz * halfW * spread];
      const d = [q.x + q.nx * halfW * spread, 0.04, q.z + q.nz * halfW * spread];
      const base = shV.length / 3;
      for (const [v, uv] of [[a, 0], [b, 1], [c, 1], [d, 0]]) {
        shV.push(v[0], v[1], v[2]);
        shU.push(uv, i % 2);
      }
      shI.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    if (shV.length) {
      const shGeo = new THREE.BufferGeometry();
      shGeo.setAttribute('position', new THREE.Float32BufferAttribute(shV, 3));
      shGeo.setAttribute('uv', new THREE.Float32BufferAttribute(shU, 2));
      shGeo.setIndex(shI);
      const shMesh = new THREE.Mesh(shGeo, new THREE.MeshBasicMaterial({
        map: shadowTex, transparent: true, opacity: 0.55,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      shMesh.renderOrder = 2;
      shMesh.frustumCulled = false;
      this.group.add(shMesh);
    }

    // ---- 两侧路缘（白色矮护栏，给桥面一个明确的边界）----
    const curbV = [];
    const curbI = [];
    const quadC = (a, b, c, d) => {
      const base = curbV.length / 3;
      curbV.push(...a, ...b, ...c, ...d);
      curbI.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (const side of [1, -1]) {
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const oIn = side * (halfW - 0.45);
        const oOut = side * halfW;
        const a = [p.x + p.nx * oIn, p.y, p.z + p.nz * oIn];
        const b = [q.x + q.nx * oIn, q.y, q.z + q.nz * oIn];
        const c = [q.x + q.nx * oOut, q.y + 0.62, q.z + q.nz * oOut];
        const d = [p.x + p.nx * oOut, p.y + 0.62, p.z + p.nz * oOut];
        quadC(a, b, c, d);
        quadC(c, d, a, b); // 双面：内外侧都要看得见
      }
    }
    const curbGeo = new THREE.BufferGeometry();
    curbGeo.setAttribute('position', new THREE.Float32BufferAttribute(curbV, 3));
    curbGeo.setIndex(curbI);
    curbGeo.computeVertexNormals();
    this.#paint(curbGeo, 0xdfe6ea);
    const curb = new THREE.Mesh(curbGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide,
    }));
    curb.frustumCulled = false;
    this.group.add(curb);

    // ---- 桥墩：只放在"背向下层道"的一侧，避免柱子戳进下层航道 ----
    let cx0 = 0;
    let cz0 = 0;
    for (let k = 0; k <= span; k++) {
      const g = this.gates[(op.from + k) % N];
      cx0 += g[0];
      cz0 += g[1];
    }
    cx0 /= span + 1;
    cz0 /= span + 1;
    const pierMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.03,
    });
    const pierGeos = [];
    for (let k = 1; k < span; k++) {
      const gi = (op.from + k) % N;
      const [gx, gz] = this.gates[gi];
      const h = this.gateY[gi];
      if (h < 1.2) continue;
      const dir = this.#gateDir(gi);
      const nx = -dir.dz;
      const nz = dir.dx;
      // 选"离开桥环中心"的一侧当桥墩位置
      const sign = (gx - cx0) * nx + (gz - cz0) * nz >= 0 ? 1 : -1;
      const px = gx + nx * sign * (halfW - 1.1);
      const pz = gz + nz * sign * (halfW - 1.1);
      const geo = new THREE.CylinderGeometry(0.62, 0.86, h, 10, 1)
        .translate(px, h * 0.5 - 0.2, pz);
      pierGeos.push(this.#paint(geo, 0x8b939b));
    }
    if (pierGeos.length) {
      const merged = mergeGeometries(pierGeos, false);
      if (merged) {
        const piers = new THREE.Mesh(merged, pierMat);
        piers.frustumCulled = false;
        this.group.add(piers);
      }
    }

    this.overpassInfo = {
      from: op.from,
      to: op.to,
      height: op.height ?? 5,
      halfW,
      deckTopMax: Math.max(...Array.from(this.gateY)),
    };
  }

  // ---------- 赛道边缘护栏（QQ 飞车式：不允许开出赛道）----------
  #buildBarriers() {
    // 霓虹能量护栏：两侧连续半透明光墙 + 斜向箭头流动光纹（青蓝色发光，与金色近道强对比）
    const N = this.gates.length;
    this.neonTex = this.#neonTexture();
    this.edgeWalls = [];
    // 主道边缘光墙在每条近道口/汇入口断开，露出可抄近道的通路（否则一条
    // 连续光墙横在近道口上，视觉上像是在"挡住"近道入口）。
    this.#buildMainWallsWithShortcutGaps();
    return;
    if (!this.neonMat) {
      this.neonMat = new THREE.MeshBasicMaterial({
        map: this.neonTex, color: this.map?.neonColor ?? 0x3fb0ff,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
    }
    const mat = this.neonMat;
    for (const side of [1, -1]) {
      const verts = [], uvs = [], idx = [];
      let dist = 0;
      let prev = null;
      for (let i = 0; i <= N; i++) {
        const gi = i % N;
        const [ax, az] = this.gates[gi];
        const [bx, bz] = this.gates[(gi + 1) % N];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz) || 1;
        // 法线 × 侧向偏移 → 护栏贴在赛道两边缘
        const ox = (-dz / len) * side * this.gateWidth;
        const oz = (dx / len) * side * this.gateWidth;
        const px = ax + ox, pz = az + oz;
        const y = this.#visualHeightAt(px, pz) + 0.12;
        if (prev) dist += Math.hypot(px - prev.x, pz - prev.z);
        const u = dist / 4; // 纹理每 4 米重复一次
        const vi = verts.length / 3;
        verts.push(px, y, pz, px, y + 1.35, pz); // 底/顶两顶点
        uvs.push(u, 0, u, 1);
        if (vi > 1) idx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
        prev = { x: px, z: pz };
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      const wall = new THREE.Mesh(geo, mat);
      wall.frustumCulled = false; // 环形大几何，包围球裁剪会误剔
      this.group.add(wall);
    }
  }

  // Shared continuous lightning wall for the main course and every shortcut.
  #buildNeonPathWalls(points, offset, { closed = false, parent = this.group, edgeType = 'main' } = {}) {
    if (!Array.isArray(points) || points.length < 2) return;
    if (!this.neonMat) {
      this.neonMat = new THREE.MeshBasicMaterial({
        map: this.neonTex, color: this.map?.neonColor ?? 0x3fb0ff,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
    }
    if (edgeType === 'shortcut' && !this.shortcutNeonMat) {
      this.shortcutNeonTex = this.neonTex.clone();
      this.shortcutNeonTex.needsUpdate = true;
      this.shortcutNeonMat = new THREE.MeshBasicMaterial({
        map: this.shortcutNeonTex, color: this.map?.shortcutNeonColor ?? 0x38f0c4,
        transparent: true, opacity: 0.3, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
    }
    const mat = edgeType === 'shortcut' ? this.shortcutNeonMat : this.neonMat;
    const wallHeight = edgeType === 'shortcut' ? 0.92 : 1.35;
    const count = closed ? points.length + 1 : points.length;
    for (const side of [1, -1]) {
      const verts = [], uvs = [], idx = [];
      let dist = 0;
      let prev = null;
      for (let i = 0; i < count; i++) {
        const pi = closed ? i % points.length : i;
        const seg = closed ? pi : Math.min(pi, points.length - 2);
        const [ax, az] = points[seg];
        const [bx, bz] = points[(seg + 1) % points.length];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz) || 1;
        const ox = (-dz / len) * side * offset;
        const oz = (dx / len) * side * offset;
        const [px0, pz0] = points[pi];
        const px = px0 + ox, pz = pz0 + oz;
        const y = this.#visualHeightAt(px, pz) + 0.12;
        if (prev) dist += Math.hypot(px - prev.x, pz - prev.z);
        const vi = verts.length / 3;
        verts.push(px, y, pz, px, y + wallHeight, pz);
        uvs.push(dist / 4, 0, dist / 4, 1);
        if (vi > 1) idx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
        prev = { x: px, z: pz };
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      const wall = new THREE.Mesh(geo, mat);
      wall.frustumCulled = false;
      wall.userData.edgeType = edgeType;
      parent.add(wall);
      if (!this.edgeWalls) this.edgeWalls = [];
      this.edgeWalls.push(wall);
    }
  }

  // 主道霓虹边缘护栏：整圈共用一套"门粒度"偏移折线，只在近道口断开。
  //
  // 为什么不能对密采样中线逐点做斜接(miter)：偏移向量沿角平分线外推
  // gateWidth/cos(θ/2)，峡谷 gate0 是 89° 锐角 → 1.40 倍（14m），而密采样相邻点
  // 只有 3m，尖角顶点直接越过邻居 → 墙线在原地折返自交 + 视觉断裂（用户看到的
  // "空一块"，以及起跑线前横着的那条赛道线）。现改为以门到门的折线为粒度算偏移
  // （段长 30~50m，尖角不可能越过邻居），再沿偏移后的折线线性插值加密 ——
  // 偏移段本身是直线，插值即精确，不会引入新的折角。
  #buildMainWallsWithShortcutGaps() {
    const N = this.gates.length;
    const W = this.gateWidth;
    const MITER_MIN = 0.62; // = 2cos²(θ/2) 下限，更锐的折角改用平角两点

    // 1) 每段的左法线
    const segN = [];
    for (let i = 0; i < N; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      segN.push([-dz / len, dx / len]);
    }

    // 2) 偏移折线站点（左右各一份）：门 i 的斜接点；夹角过锐时退化为平角两点，
    //    把尖角拉回弯角本身，绝不让它越过后续墙线。
    const buildStations = (side) => {
      const st = [];
      for (let i = 0; i < N; i++) {
        const g = this.gates[i];
        const n1 = segN[(i - 1 + N) % N];
        const n2 = segN[i];
        const n1x = n1[0] * side, n1z = n1[1] * side;
        const n2x = n2[0] * side, n2z = n2[1] * side;
        const denom = 1 + (n1x * n2x + n1z * n2z); // 2cos²(θ/2)
        if (denom > MITER_MIN) {
          const k = W / denom;
          st.push({ x: g[0] + (n1x + n2x) * k, z: g[1] + (n1z + n2z) * k, gate: i });
        } else {
          st.push({ x: g[0] + n1x * W, z: g[1] + n1z * W, gate: i });
          st.push({ x: g[0] + n2x * W, z: g[1] + n2z * W, gate: i });
        }
      }
      return st;
    };

    // 3) 近道口在主道闭环上的精确锚点（门号 + 段内比例 → 环上比例），左右两侧共用，
    //    保证缺口精准落在近道与主道的交汇点上，而不是靠弧长模糊搜索。
    const mainLoop = [...this.gates, this.gates[0]];
    const mouths = [];
    for (const sc of this.shortcuts) {
      // 缺口半宽 = 近道宽 + 1.5m 缓冲。比近道本身宽一点让玩家能看出"这里可以流出去"；
      // 同时不要让主道开出"大洞"——大了既挡视线又容易让玩家视觉上误判近道起点。
      // keepDist 把近道墙起点钳到 keepDist（主道墙外 + 半近道宽 + 0.5m），
      // 因此缺口 > 近道宽度 = 视觉上"主道开口 → 留出近道宽度 + 一点空隙 → 近道墙外"。
      const half = sc.width + 1.5;
      const ends = sc.points.length > 1
        ? [sc.points[0], sc.points[sc.points.length - 1]] : [sc.points[0]];
      for (const end of ends) {
        const pr = nearestOnPolyline(mainLoop, end[0], end[1]);
        mouths.push({ frac: (pr.seg + pr.t) / N, half });
      }
    }

    for (const side of [1, -1]) {
      const st = buildStations(side);
      const M = st.length;
      const arc = [0];
      for (let j = 0; j < M; j++) {
        const a = st[j], b = st[(j + 1) % M];
        arc.push(arc[j] + Math.hypot(b.x - a.x, b.z - a.z));
      }
      const totalArc = arc[M] || 1;
      // 环上比例 → 偏移折线弧长（左右两侧各按自己的折线换算，缺口仍然对齐同一段赛道）
      const arcAt = (frac) => {
        for (let j = 0; j < M; j++) {
          const f0 = st[j].gate / N;
          const f1 = j === M - 1 ? 1 : st[j + 1].gate / N;
          if (f1 - f0 < 1e-9) continue; // 平角短边，门号跨度为 0
          if (frac >= f0 - 1e-9 && frac <= f1 + 1e-9) {
            return arc[j] + (arc[j + 1] - arc[j]) * ((frac - f0) / (f1 - f0));
          }
        }
        return 0;
      };
      const gapArc = mouths.map((m) => ({ s: arcAt(m.frac), half: m.half }));
      const inGap = (s) => {
        for (const g of gapArc) {
          let d = s - g.s;
          if (d > totalArc / 2) d -= totalArc;
          else if (d < -totalArc / 2) d += totalArc;
          if (Math.abs(d) <= g.half) return true;
        }
        return false;
      };

      // 4) 沿偏移折线线性插值加密到 ~3m（偏移段是直线，插值即精确偏移，不会自交）
      const pts = [];
      for (let j = 0; j < M; j++) {
        const a = st[j], b = st[(j + 1) % M];
        const L = arc[j + 1] - arc[j];
        const n = Math.max(1, Math.ceil(L / 3));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          pts.push({
            x: a.x + (b.x - a.x) * t,
            z: a.z + (b.z - a.z) * t,
            s: arc[j] + L * t,
          });
        }
      }
      const count = pts.length;

      // 5) 索引空间取补集，首尾相连的保留段合并为一条环绕链
      const keep = new Array(count);
      for (let i = 0; i < count; i++) keep[i] = !inGap(pts[i].s);
      const runs = [];
      let n = 0;
      while (n < count) {
        while (n < count && !keep[n]) n++;
        if (n >= count) break;
        const s0 = n;
        while (n < count && keep[n]) n++;
        runs.push([s0, n - 1]);
      }
      if (runs.length > 1 && keep[0] && keep[count - 1]) {
        const first = runs.shift();
        const last = runs.pop();
        runs.push([last[0], count + first[1]]); // 跨过闭环首点，索引取模即可
      }
      if (!runs.length) continue; // 异常配置：近道口吃掉整圈，宁可缺墙也不画错墙
      // 发光墙面停用：只在需要压边的地图（冰面）保留深色裙边
      if (!this.map.edgeSkirt) continue;
      for (const [a, b] of runs) this.#buildEdgeWallRun(pts, count, a, b);
    }
  }

  // 输出一截光墙：顶点已是最终偏移点，段与段之间零错位
  #buildEdgeWallRun(pts, count, i0, i1) {
    const span = i1 - i0 + 1;
    if (span < 2) return;
    if (!this.neonMat) {
      this.neonMat = new THREE.MeshBasicMaterial({
        map: this.neonTex, color: this.map?.neonColor ?? 0x3fb0ff,
        transparent: true, opacity: 0.42, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      });
    }
    const verts = [], uvs = [], idx = [];
    let dist = 0;
    let prev = null;
    for (let k = 0; k < span; k++) {
      const i = ((i0 + k) % count + count) % count;
      const { x: px, z: pz } = pts[i];
      const y = (this.diveHeightAt({ x: px, z: pz }) || 0) + 0.12;
      if (prev) dist += Math.hypot(px - prev[0], pz - prev[1]);
      const vi = verts.length / 3;
      verts.push(px, y, pz, px, y + 1.35, pz);
      uvs.push(dist / 4, 0, dist / 4, 1);
      if (vi > 1) idx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
      prev = [px, pz];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    // 霓虹光墙本体已停用（只保留下面那条深色压边给冰面用）
    if (!this.edgeWalls) this.edgeWalls = [];
    // 冰面专用压边（tide-redesign-plan 六·3）：纯白冰壳上加法混合的霓虹几乎看不见，
    // 所以在护栏脚下补一条深色带 + 一条贴在冰面的暗影带，把"赛道边缘"这件事实体化。
    if (this.map.edgeSkirt) this.#buildEdgeSkirt(pts, count, i0, i1);
  }

  /**
   * 冰面赛道的深色压边：护栏脚下 0.5m 高的深色带 + 冰面上 2.6m 宽的暗影带。
   * 只用一种纯色材质，两次绘制；不做碰撞——它只是视觉上的"路基"。
   */
  #buildEdgeSkirt(pts, count, i0, i1) {
    const span = i1 - i0 + 1;
    if (span < 2) return;
    if (!this.edgeSkirtMat) {
      this.edgeSkirtMat = new THREE.MeshBasicMaterial({
        color: 0x16242e, side: THREE.DoubleSide,
      });
      this.edgeSkirtRibbonMat = new THREE.MeshBasicMaterial({
        color: 0x1b3648, side: THREE.DoubleSide, transparent: true, opacity: 0.5,
        depthWrite: false,
      });
    }
    const H = 0.5;   // 压边高度
    const W2 = 2.6;  // 冰面暗影带宽
    const get = (k) => pts[(((i0 + k) % count) + count) % count];
    const bandV = [], bandUv = [], bandIdx = [];
    const ribV = [], ribIdx = [];
    let dist = 0;
    let prev = null;
    for (let k = 0; k < span; k++) {
      const p = get(k);
      const a = get(Math.max(0, k - 1));
      const b = get(Math.min(span - 1, k + 1));
      const dx = b.x - a.x, dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const y = this.#visualHeightAt(p.x, p.z) + 0.10;
      if (prev) dist += Math.hypot(p.x - prev[0], p.z - prev[1]);
      let vi = bandV.length / 3;
      bandV.push(p.x, y, p.z, p.x, y + H, p.z);
      bandUv.push(dist / 4, 0, dist / 4, 1);
      if (vi > 1) bandIdx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
      vi = ribV.length / 3;
      ribV.push(
        p.x - nx * W2 * 0.5, y + 0.22, p.z - nz * W2 * 0.5,
        p.x + nx * W2 * 0.5, y + 0.22, p.z + nz * W2 * 0.5,
      );
      if (vi > 1) ribIdx.push(vi - 2, vi - 1, vi, vi - 1, vi + 1, vi);
      prev = [p.x, p.z];
    }
    const band = new THREE.BufferGeometry();
    band.setAttribute('position', new THREE.Float32BufferAttribute(bandV, 3));
    band.setAttribute('uv', new THREE.Float32BufferAttribute(bandUv, 2));
    band.setIndex(bandIdx);
    const bandMesh = new THREE.Mesh(band, this.edgeSkirtMat);
    bandMesh.frustumCulled = false;
    bandMesh.userData.edgeType = 'iceSkirt';
    this.group.add(bandMesh);

    const rib = new THREE.BufferGeometry();
    rib.setAttribute('position', new THREE.Float32BufferAttribute(ribV, 3));
    rib.setIndex(ribIdx);
    const ribMesh = new THREE.Mesh(rib, this.edgeSkirtRibbonMat);
    ribMesh.frustumCulled = false;
    ribMesh.renderOrder = 2;
    ribMesh.userData.edgeType = 'iceSkirt';
    this.group.add(ribMesh);
  }

  /**
   * 桥面混凝土贴图：x 方向 = 沿桥（每 7.5m 一个伸缩缝），y 方向 = 横跨桥面。
   * 两侧有磨损的白色边线，中间是带骨料颗粒和细裂纹的水泥面。
   */
  #deckTexture() {
    if (this._deckTex) return this._deckTex;
    const S = 256;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#6a7178';
    ctx.fillRect(0, 0, S, S);
    // 骨料颗粒
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const v = Math.random();
      ctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.03 + v * 0.045})` : `rgba(20,24,28,${0.04 + (1 - v) * 0.08})`;
      ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    // 细裂纹
    ctx.strokeStyle = 'rgba(28,32,36,0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      let x = Math.random() * S;
      let y = Math.random() * S;
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        x += (Math.random() - 0.5) * 40;
        y += (Math.random() - 0.5) * 26;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 伸缩缝（沿 v 方向贯穿，x=0 处；U 环绕后每 7.5m 一条）
    ctx.fillStyle = 'rgba(40,45,50,0.55)';
    ctx.fillRect(0, 0, 3, S);
    ctx.fillRect(S - 2, 0, 2, S);
    // 两侧边线
    ctx.fillStyle = 'rgba(232,238,242,0.72)';
    ctx.fillRect(0, S * 0.045, S, S * 0.035);
    ctx.fillRect(0, S * 0.92, S, S * 0.035);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    this._deckTex = tex;
    return tex;
  }

  /** 桥下投影：横向"中间深、两边透明"的柔光条 */
  #deckShadowTexture() {
    if (this._deckShadowTex) return this._deckShadowTex;
    const S = 64;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, S, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.22, 'rgba(0,0,0,0.30)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.46)');
    g.addColorStop(0.78, 'rgba(0,0,0,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this._deckShadowTex = tex;
    return tex;
  }

  /** 霓虹光纹贴图：底部亮顶部暗 + 斜向箭头（offset 滚动时指向前进方向） */
  #neonTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 64, 0, 0);
    if (this.map?.lava) {
      // 熔岩主题：纹理本身必须换成暖白，只改 material.color 的话会被原来那层
      // 蓝白渐变的 B 通道乘掉，橙色光墙出来是脏灰紫的。
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.3, 'rgba(255,196,112,0.52)');
      g.addColorStop(1, 'rgba(255,92,28,0.05)');
    } else {
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.3, 'rgba(150,215,255,0.5)');
      g.addColorStop(1, 'rgba(30,110,255,0.05)');
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 64);
    ctx.strokeStyle = this.map?.lava ? 'rgba(255,232,190,0.9)' : 'rgba(210,245,255,0.9)';
    ctx.lineWidth = 5;
    for (let x = -64; x < 160; x += 32) {
      ctx.beginPath();
      ctx.moveTo(x, 64);
      ctx.lineTo(x + 26, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  /**
   * 赛道走廊约束：把艇限制在护栏内（越界推回 + 反弹损速）
   * 走廊 = 主赛道 ∪ 所有近道（并集，不是二选一）
   * 仅对本地权威艇调用（本地艇 + 主机侧 AI）
   *
   * v11 并集走廊：船只要落在任意一条走廊内就合法，判定取"欠界量最小"的那条，
   * 全船 7 个采样点各自独立判定。旧逻辑是"离哪条中线近就用哪条"（nearest-wins）：
   * 近道口处主道中线与近道中线相距仅数米，贴着主道外壁行驶的船常常离近道中线
   * 更近，于是整条船被判定进 2.7m 宽的近道走廊，一帧横向拽回 4m —— 玩家看到
   * 的就是"赛道中间凭空一堵空气墙"以及进近道时的瞬移顿挫。
   */
  #probeMain(x, z, hint = null) {
    const N = this.gates.length;
    let bestD = Infinity;
    let px = 0, pz = 0, dx = 0, dz = 0;
    let bi = 0, bt = 0;
    // 开环赛道（烘焙）最后一点不连回第一点，否则会出现一条横跨地图的假段
    const segN = this.openTrack && !this.loopClosed ? N - 1 : N;
    // 扫描一段：把最近点写进闭包变量（窗口搜索和全局搜索共用同一份判定）
    const scan = (i) => {
      const [ax, az] = this.gates[i];
      const [bx, bz] = this.gates[(i + 1) % N];
      const sx = bx - ax, sz = bz - az;
      const len2 = sx * sx + sz * sz || 1;
      let t = ((x - ax) * sx + (z - az) * sz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + sx * t;
      const cz = az + sz * t;
      const ddx = x - cx;
      const ddz = z - cz;
      const d = Math.hypot(ddx, ddz);
      if (d < bestD) { bestD = d; px = cx; pz = cz; dx = ddx; dz = ddz; bi = i; bt = t; }
    };
    // 碰撞边界直接取浮桶中线（gateWidth - 0.6，见 #buildEdgeBuoys 的 off）：
    // 以前是 0.92×gateWidth，和浮桶差几厘米看不出来；但浮桶一旦按斜接点铺线，
    // 就必须与走廊用同一个半径，船贴边时船体才正好停在浮桶线上而不是穿过去。
    const limit = Number.isFinite(this.edgeOffset) ? this.edgeOffset : this.gateWidth - 0.6;

    // 螺旋塔（同一片 x,z 上下叠着好几圈跑道）：纯 2D 最近点会挑到隔壁那一层，
    // 后果是船被拉向另一圈的中心线（横向空气墙）或高度瞬间跳到另一层。
    // 有门提示时只在 [hint−W, hint+W] 窗口里找；窗口里离得太远说明提示已过期
    // （刚重生 / 刚复位 / 远程艇乱飞），退回全局搜索，绝不把人卡死在窗口里。
    if (hint != null && this.openTrack && segN > 2) {
      const W = this.probeWindow || 7;
      const h = ((Math.round(hint) % N) + N) % N;
      for (let k = -W; k <= W; k++) {
        const i = (((h + k) % N) + N) % N;
        if (i >= segN) continue;
        scan(i);
      }
      if (bestD <= this.gateWidth * 3.5) return { bestD, limit, px, pz, dx, dz, i: bi, t: bt };
      bestD = Infinity;
    }

    for (let i = 0; i < segN; i++) scan(i);
    return { bestD, limit, px, pz, dx, dz, i: bi, t: bt };
  }

  // 近道走廊：投影必须落在折线内部，端部中线/宽度平滑过渡（进出无顿挫）；
  // 起/终点之外返回 null（该近道在此处不参与并集）。
  #probeShortcut(x, z, sc, main) {
    const loc = nearestOnPolyline(sc.points, x, z);
    const beyondStart = loc.seg === 0 && loc.t <= 0.001;
    const beyondEnd = loc.seg === sc.points.length - 2 && loc.t >= 0.999;
    if (beyondStart || beyondEnd) return null;
    // 远端走廊防御：投影落在折线内部 ≠ 船在这条近道附近。船在赛道另一侧时，
    // 投影会钳制在折线端点上，端部 blend 系数 s≈0 会让候选点几乎等于主道投影点。
    // 合法使用近道时船到折线的距离不超过主道半宽+近道宽，远小于此。
    if (loc.d > main.limit + sc.width) return null;
    const total = loc.total || 1;
    // 端部 smoothstep：中线与宽度一并从主道过渡到近道，两条走廊在交汇点处重合，
    // 并集判定因此在入口/出口连续，不会出现走廊骤变。
    const edge = Math.min(loc.u, 1 - loc.u) * total;
    const blendLen = Math.min(14, total * 0.4);
    const k = edge >= blendLen ? 1 : edge / blendLen;
    const s = k * k * (3 - 2 * k);
    const candidateX = THREE.MathUtils.lerp(main.px, loc.px, s);
    const candidateZ = THREE.MathUtils.lerp(main.pz, loc.pz, s);
    const candidateD = Math.hypot(x - candidateX, z - candidateZ);
    return {
      bestD: candidateD,
      // 近道碰撞边界取近道浮桶中线（sc.width + 1.0，见 #buildEdgeBuoys）
      limit: THREE.MathUtils.lerp(main.limit, sc.width + 1.0, s),
      px: candidateX, pz: candidateZ,
      dx: x - candidateX, dz: z - candidateZ,
    };
  }

  // 并集走廊：返回欠界量 over = bestD - (limit - inset) 最小的候选。
  // over ≤ 0 表示该采样点落在走廊内、不受力；只有所有走廊都欠界才需推回，
  // 此时推回量取最小的那条 —— 这正是"并集里最靠近边界的走廊"。
  // 切换走廊时两条候选的 over 相等，推回量连续，因此不会出现 limit 帧间跳变。
  #probeUnion(x, z, inset, main = null, hint = null) {
    const m = main || this.#probeMain(x, z, hint);
    let best = m;
    let bestOver = m.bestD - m.limit + inset;
    for (const sc of this.shortcuts) {
      const p = this.#probeShortcut(x, z, sc, m);
      if (!p) continue;
      const over = p.bestD - p.limit + inset;
      if (over < bestOver) { best = p; bestOver = over; }
    }
    return { c: best, over: bestOver };
  }

  /**
   * 悬崖边缘规则：当前所在主道段是否允许冲出赛道。
   * 只有玩家驱动的船会掉（AI 掉下去整局就废了），所以这里先看 boat.isAi。
   */
  #edgeRule(boat, gateIndex) {
    if (boat.isAi) return null;
    const list = this.edgeDrops;
    if (!list || !list.length) return null;
    for (const z of list) if (gateIndex >= z.from && gateIndex < z.to) return z;
    return null;
  }

  /**
   * 回程码头窄口的车道提示（给 AI 用）。
   * 码头躲不开"看到才躲"：船 26m/s、普通障碍探测 10m 只有 0.4 秒，
   * 而从中线横移 3.5m 到通道中心要 1.5 秒以上（舵量按偏差 ×2.2 取，
   * 小偏差时舵也小，横移率上不去）。所以提前 70m 就把循迹目标点整体
   * 推到空侧，让 AI 用一整段直道慢慢换线。
   * 返回可直接加到目标点上的世界坐标偏移，附近没有窄口时返回 null。
   */
  narrowLaneShift(x, z, fx, fz) {
    const marks = this.dockMarks;
    if (!marks || !marks.length) return null;
    let best = null, bestD = Infinity;
    for (const m of marks) {
      const dx = m.x - x, dz = m.z - z;
      const d = Math.hypot(dx, dz);
      if (d > 70 || d >= bestD) continue;
      if ((dx * fx + dz * fz) / (d || 1) < 0.45) continue;   // 不在船头方向
      bestD = d; best = m;
    }
    if (!best) return null;
    // 恒定位移（不随距离衰减）：衰减版在小偏差区给不出足够舵量，
    // 结果就是 AI 一路贴着码头边蹭。目标点在 26m 外，偏移 3.5m 只有 7.7°，
    // 转向本身是平滑的，不会出现"目标点跳变"的抖动。
    const w = this.dockPassWidth * 0.5;
    return { x: -best.nx * w, z: -best.nz * w };
  }

  constrain(boat, dt = 1 / 60) {
    if (boat.onCoaster) return;
    // 空中船默认不接管：updateLocal 内的 airborne 分支已经按 vel/vy 自由飞行，
    // 弹射器/过山车的弹道是设计好的，护栏钳制会把船从空中强拉到水面走廊。
    // 但**浪尖抛飞必须继续受护栏约束**：海啸浪能把船顶到 3m 以上，若此时完全
    // 豁免，船会以 40~50m/s 直接越过赛道边缘落到场外（峡谷图实测）。这里只放行
    // 非浪尖的腾空，浪尖腾空走下面的全高度护栏 + 反射回弹。
    if (boat.airborne && !boat.waveJump) return;

    // 悬崖边缘：该门段外侧**不立护栏**，横向越过 edge 就把船放出去，由 Game 结算掉落。
    // 顺序上必须在 #constrainTunnel 之前 —— 掉落的船不该再被管道/护栏拉回来。
    if (this.edgeDrops && this.edgeDrops.length) {
      const m = this.#probeMain(boat.pos.x, boat.pos.z, boat.gateHint);
      const rule = this.#edgeRule(boat, m.i);
      if (rule) {
        if (m.bestD > rule.edge) {
          // 已在边缘之外：标记并整段放行（不再推到护栏内）
          boat.overEdge = 0.2;
          return;
        }
        // 边缘内：先按正常宽度拦一次，但把限制放宽到 edge ——
        // 这样"贴着边开"不会突然撞墙，而"主动往外打方向"能顺滑地滑出去。
        boat.edgeLimit = rule.edge;
      } else {
        boat.edgeLimit = 0;
      }
    }
    // 全封闭管道隧道：船进入管道跨度内时由 3D 径向约束接管（含顶棚/侧壁），
    // 窄于主道走廊，是地图差异化的困难段；否则走正常主道护栏。
    if (this.#constrainTunnel(boat)) return;
    // v8: 赛道边缘全高度碰撞——腾空船同样受主赛道/近道走廊约束。
    // v10（2026-11-18）: 碰撞形状改成**船体真实水平轮廓**，不再打折。
    //   旧版（v9）取「纵向 62% 船长、横向 88% 船宽」再额外给 0.35m 容差，
    //   6.6m 长船的船头能比采样点多伸出 1.25m，加上容差能压过浮桶线 1.5m 才被拦 ——
    //   玩家看到的就是"船都出线了还没碰撞"。现在逐点采样轮廓边缘，边缘压线即碰撞。
    const fxx = Math.sin(boat.heading);
    const fzz = Math.cos(boat.heading);
    // 右舷方向（垂直前向量）
    const lxx = fzz;
    const lzz = -fxx;
    // 轮廓：Boat 用模型顶点求的凸包（船体最外缘）；GLB 还没就位时用 hull 参数八边形
    const outline = boat.hullFootprint || FALLBACK_HULL(boat.def?.hull);
    const nHull = outline.length >> 1;

    let worstOver = 0;
    let worstNx = 0, worstNz = 0;
    // 逐点把轮廓变换到世界坐标：右舷分量 lx、船头分量 lz
    // 每个采样点独立在「主道 ∪ 近道」并集里判定（欠界量最小者胜出），
    // 因此贴着主道外壁正常行驶不会被近道走廊误判，进出近道口也无需切换基准。
    for (let i = 0; i < nHull; i++) {
      const lx = outline[i * 2];
      const lz = outline[i * 2 + 1];
      const sx = boat.pos.x + lxx * lx + fxx * lz;
      const sz = boat.pos.z + lzz * lx + fzz * lz;
      // 轮廓点本身就是船体边缘，inset 传 0（不再往里收）
      const { c, over: overRaw } = this.#probeUnion(sx, sz, 0, null, boat.gateHint);
      // 悬崖边缘段：把护栏半径放宽到 edge，贴边行驶不会被硬墙顶回来。
      // 只有真冲出去才由上面那段整段放行 → 交给 Game 结算掉落。
      // （烘焙图没有近道，c 一定是主道，所以这里不用再区分走廊来源。）
      const over = boat.edgeLimit
        ? Math.min(overRaw, c.bestD - boat.edgeLimit)
        : overRaw;
      if (over > worstOver) {
        worstOver = over;
        worstNx = c.dx / (c.bestD || 1);
        worstNz = c.dz / (c.bestD || 1);
      }
    }

    if (worstOver > 0.001) {
      const nx = worstNx;
      const nz = worstNz;
      // 整船沿法向平移回护栏内（最出界的采样点刚好回到护栏内侧半宽处）
      boat.pos.x -= nx * worstOver;
      boat.pos.z -= nz * worstOver;
      // 贴墙滑行窗口：告诉 Boat 刚刚蹭到护栏，让它放宽抓地/滑移上限并能打方向离开
      boat.wallContactTimer = 0.35;
      // 记下这次接触的法线：接触是断续的（位置解算把船推回去之后，
      // 要十几帧才会再次压上墙），助滑与回正按下面"接触时间窗"每帧跑，
      // 不能只在真正穿透这一帧跑 —— 那样回正每 0.2 秒才生效一次，等于没有。
      boat.wallNx = nx;
      boat.wallNz = nz;
      if (boat.airborne) {
        // 空中撞墙：反射航向（掠射=轻微内偏贴墙滑过弯道，正对=弹回）+ 损速
        // n 是"由走廊中线指向船"的外法线，v·n > 0 才是"正在朝墙外冲"。
        const vx = Math.sin(boat.heading);
        const vz = Math.cos(boat.heading);
        const dot = vx * nx + vz * nz;
        if (dot > 0) {
          // 按 80% 把航向往镜像方向掰（旧版 100% 像被弹回来，上一版 60% 偏软）
          const rx = vx - 2 * dot * nx;
          const rz = vz - 2 * dot * nz;
          let dh = Math.atan2(rx, rz) - boat.heading;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          boat.heading += dh * 0.8;
          boat.speed *= 0.88;
        }
        boat.cancelDriftForCollision?.();
      } else {
        // 水面撞墙：标准赛车碰撞模型（法向按恢复系数反射 + 切向保留）
        // 旧逻辑每帧 vel *= 0.72 → 贴墙滑行几十帧速度归零、像空气墙一样卡死。
        // 现在的规则（对齐真实开车手感）：
        //   ① 法向分量按恢复系数反射，恢复系数随法向撞击速度上升：
        //      低速(法向 ≤5m/s) 保留 0.12 的轻微弹回 → 碰到只轻微向后一顿，
        //      绝不"马上调换方向"；高速(法向 ≥16m/s) 达到 0.55 → 明显向反方向回弹。
        //   ② 切向分量保留，只掉一点撞墙摩擦 → 擦墙能继续沿墙滑走，不会卡住。
        //   ③ 船头完全不自动调转：方向永远由玩家控制，撞完自己打方向离开。
        const vx = boat.vel.x;
        const vz = boat.vel.y;
        const vn = vx * nx + vz * nz;      // > 0 = 正在朝墙外冲
        if (vn > 0) {
          const tx = vx - vn * nx;
          const tz = vz - vn * nz;
          // 恢复系数：法向撞击速度 5.5→20 m/s 从 0.10 升到 0.44。
          // 取"旧版太弹(0.14~0.60)、上一版太软(0.05~0.28)"的中间值：
          // 低速蹭墙只轻微一顿，中高速撞墙有明显的回弹但不至于被弹飞。
          const restitution = 0.10 + 0.34 * THREE.MathUtils.clamp((vn - 5.5) / 14.5, 0, 1);
          // 撞墙摩擦：护栏吃掉一点切向能量
          const friction = 1 - Math.min(0.10, vn * 0.006);
          // 撞墙冷却：一次撞击只结算一次回弹，避免位置纠正帧连续触发导致速度反复清零
          const canBounce = (boat.wallHitCooldown || 0) <= 0;
          const bounce = canBounce ? vn * restitution : 0;
          boat.vel.x = tx * friction - bounce * nx;
          boat.vel.y = tz * friction - bounce * nz;
          boat.speed = Math.hypot(boat.vel.x, boat.vel.y);
          if (canBounce) {
            boat.wallHitCooldown = 0.15;
            // 失败归因：法向速度 > 3m/s 才算「撞」，摩擦式蹭墙（贴墙滑）不报
            if (vn > 3) boat.wallHitSpeed = Math.max(boat.wallHitSpeed || 0, vn);
            // 只有真正的高速猛撞才短暂失控，普通蹭墙不影响操控
            if (vn > 19) boat.stunTimer = Math.max(boat.stunTimer, 0.22);
          }
          boat.cancelDriftForCollision?.();
        }
      }
    }
    // ---- 贴墙助滑 + 刮墙回正（按接触时间窗每帧生效）----
    // wallContactTimer 由上面的接触帧刷新 0.35s，法线存在 wallNx/wallNz。
    // 接触本身是断续的（推回去→十几帧后再压上），玩家感觉却是"一直贴着墙"，
    // 所以这两件事必须按时间窗跑，而不是只在穿透的那一帧跑。
    if (!boat.airborne && boat.wallContactTimer > 0 && boat.wallNx != null
      && (boat.throttleInput || 0) > 0) {
      const nx = boat.wallNx;
      const nz = boat.wallNz;
    // ---- 蹭墙助滑（2026-11-17）----
    // 船头斜顶在墙上、玩家还给着油门时，推力里"沿墙"的那一份应该让船继续
    // 顺着墙滑走；旧版这一份被墙的法向投影一格一格吃掉，只剩每秒几十厘米的
    // 蠕动，玩家读作"卡住"，只好复位。
    // 这里把切向速度补到 WALL_SCRAPE_MIN_ALONG（6m/s）为止：
    //   · 只补不超，正常高速擦墙不会被加速（6m/s 只有巡航极速的 1/5）
    //   · 只在踩油门时补，松油门贴墙照样停住
    // 方向取与船头夹角较小的那一侧切向，所以船头朝前就往前滑、朝后就往后滑。
      const fwx = Math.sin(boat.heading);
      const fwz = Math.cos(boat.heading);
      // 切向：取与船头夹角较小的那一侧（船头朝前就往前滑、朝后就往后滑）。
      // 注意这个翻转必须在两个分支外面算：以前写在"补速"的 if 里，
      // 速度一旦够了就不再翻转，切向永远指向船尾，回正力矩变成朝反方向算，
      // 于是"回正"每帧都被自己判成"玩家在反打"而跳过。
      let tx = -nz;
      let tz = nx;
      if (tx * fwx + tz * fwz < 0) { tx = -tx; tz = -tz; }
      // 蹭墙持续掉速：贴墙摩擦会一直啃速度，稳态大约只剩干净跑法的七成
      // （实测干净巡航 28.4m/s，贴墙顶多 ~19m/s）。没有这条的话，
      // 回正 + 助滑会让"贴着墙跑"变成不掉速的高速通道，比走线还快。
      const scrapeK = 1 - Math.exp(-WALL_SCRAPE_DRAG * dt);
      boat.vel.x -= boat.vel.x * scrapeK;
      boat.vel.y -= boat.vel.y * scrapeK;
      boat.speed = Math.hypot(boat.vel.x, boat.vel.y);
      const along = boat.vel.x * tx + boat.vel.y * tz;
      if (along < WALL_SCRAPE_MIN_ALONG) {
        // 18m/s² 补速速率：0.3 秒补满，不会有"被弹一下"的突兀感
        const add = Math.min(WALL_SCRAPE_MIN_ALONG - along, 18 * dt);
        boat.vel.x += tx * add;
        boat.vel.y += tz * add;
        boat.speed = Math.hypot(boat.vel.x, boat.vel.y);
      }

      // ---- 刮墙回正力矩（2026-11-17）----
      // 真实船体被墙顶住时，墙的反作用力作用在船头外侧，会产生一个把船身
      // 掰到与墙平行的力矩；跑跑卡丁车/马车的贴墙手感就是这个——擦着墙跑，
      // 车头自己顺着墙走。旧版明确"船头完全不自动调转"，于是船头 70° 戳在
      // 墙上时，玩家得靠自己把船头转 70°，加上速度被吃掉只剩 2m/s，
      // 看起来就是"卡住慢慢蹭"。
      if (!boat.drifting) {
        const into = fwx * nx + fwz * nz;
        // 门槛 0.08（≈4.6°）：船头已经顺着墙了就停手，不跟玩家继续往弯里打较劲。
        if (into > 0.08) {
          const tHead = Math.atan2(tx, tz);
          let dh = tHead - boat.heading;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          // 角速度：基础 0.9 + 随撞入程度上涨（70° 约 3.2rad/s，封顶 3.4），
          // 有基础值才不会在"快平行"的最后几度上磨很久。
          const rate = Math.min(3.4, 0.9 + 2.4 * into);
          const step = Math.sign(dh) * Math.min(Math.abs(dh), rate * dt);
          boat.heading += step;
        }
      }
    }

  }

  // 全封闭管道隧道：本帧若在管道跨度内且距中轴足够近，用 3D 径向约束把船压回
  // 管壁内（侧壁/顶棚/水底皆覆盖）。返回 true 表示已接管，constrain() 不再走主道护栏。
  #constrainTunnel(boat) {
    const t = this.tunnel;
    if (!t) return false;
    const loc = nearestOnPolyline(t.points, boat.pos.x, boat.pos.z);
    // 投影落在折线端点之外（隧道口之外）不接管：端点在最近点查询中会钳制，
    // 若无此判断会在管口外形成半径约 gateWidth 的圆形"端盖"，把驶离管口的船
    // 拉回头并反射航向，变成过不去的空气墙。口外交由主道护栏接管（护栏宽度
    // 与管口宽度一致，衔接无缝）。
    if (loc.u <= 0 || loc.u >= 1) return false;
    const s = loc.u * loc.total;
    const dx = boat.pos.x - loc.px;
    const dy = boat.pos.y - t.centerY;
    const dz = boat.pos.z - loc.pz;
    const radial = Math.hypot(dx, dy, dz);
    // 远在管道横向包络之外的船（如另一侧赛道）不受影响，交给正常护栏
    if (radial > this.gateWidth * 1.1) return false;
    // 端部漏斗：mouth（主道半宽）→ radius 平滑收敛，进出管道无顿挫
    const edge = Math.min(s, t.len - s);
    const k = edge >= t.blend ? 1 : edge / t.blend;
    const sm = k * k * (3 - 2 * k);
    const bound = THREE.MathUtils.lerp(this.gateWidth * 0.92, t.radius, sm);
    const halfW = (boat.def?.hull?.width || 1.9) * 0.5;
    const lim = Math.max(0.5, bound - halfW);
    if (radial > lim) {
      const over = radial - lim;
      // 单帧内推上限：管腔要在几十米内从主道半宽(≈16.6m)收到内径(6m)，贴边行驶
      // 的船需要横移数米才进得了管。一次性格完就是"凭空一堵空气墙"+瞬移顿挫，
      // 这里每帧最多收 1m，用几帧贴进管壁；只有真的顶到管壁（over 未被截断）
      // 才反射航向并扣速，避免渐进内推把速度惩罚重复施加十几次。
      const stepIn = Math.min(over, 1);
      const inv = (radial - stepIn) / radial;
      boat.pos.x = loc.px + dx * inv;
      boat.pos.y = t.centerY + dy * inv;
      boat.pos.z = loc.pz + dz * inv;
      if (over <= 1) {
        // 撞管壁：与水面护栏同一套赛车碰撞模型（低速只轻微弹回+沿壁滑行，
        // 高速才向反方向回弹约 55%，船头完全不自动调转）
        const hlen = Math.hypot(dx, dz) || 1;
        const nx = dx / hlen;
        const nz = dz / hlen;
        const vx = boat.vel.x;
        const vz = boat.vel.y;
        const vn = vx * nx + vz * nz;   // > 0 = 正在朝管壁外冲
        // 贴墙滑行窗口（与水面护栏一致）：擦着管壁时保留沿壁速度并能打方向离开
        boat.wallContactTimer = 0.35;
        if (vn > 0.4) {
          const tx = vx - vn * nx;
          const tz = vz - vn * nz;
          // 恢复系数随法向撞击速度上升：≤5m/s 只留 0.12 轻微弹回，≥16m/s 达 0.55
          // 半重档：低速几乎不弹（0.14），18m/s 以上回弹系数到 0.60 —— 加速撞墙明显弹回来
          const restitution = 0.14 + 0.46 * THREE.MathUtils.clamp((vn - 5) / 13, 0, 1);
          const friction = 1 - Math.min(0.10, vn * 0.006);
          const canBounce = (boat.wallHitCooldown || 0) <= 0;
          const bounce = canBounce ? vn * restitution : 0;
          boat.vel.x = tx * friction - bounce * nx;
          boat.vel.y = tz * friction - bounce * nz;
          boat.speed = Math.hypot(boat.vel.x, boat.vel.y);
          if (canBounce) {
            boat.wallHitCooldown = 0.15;
            if (vn > 16) boat.stunTimer = Math.max(boat.stunTimer, 0.25);
          }
          boat.cancelDriftForCollision?.();
        }
      }
      boat.cancelDriftForCollision?.();
    }
    return true;
  }

  // 生成管道中心线（主道 from→to 门折线加密到 ~4m）+ 构建全封闭竞技管道视觉：
  // 外壁贴合主赛道边缘（outer = gateWidth，完全架在主道上），内壁用漏斗从主道
  // 半宽收窄到竞技内径；内壁铺海洋艺术壁画，外壁撒蓝色粒子光效。
  #buildTunnel() {
    const def = this.map.tunnel;
    if (!def) return;
    const count = this.gates.length;
    const raw = [];
    let i = def.from;
    for (;;) {
      raw.push(this.gates[i]);
      if (i === def.to) break;
      i = (i + 1) % count;
    }
    const dense = [];
    for (let p = 0; p < raw.length - 1; p++) {
      const a = raw[p];
      const b = raw[p + 1];
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(seg / 4));
      for (let m = 0; m < n; m++) {
        const tt = m / n;
        dense.push([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt]);
      }
    }
    dense.push([...raw[raw.length - 1]]);
    let len = 0;
    for (let p = 0; p < dense.length - 1; p++) {
      len += Math.hypot(dense[p + 1][0] - dense[p][0], dense[p + 1][1] - dense[p][1]);
    }
    const innerR = def.radius ?? 8;              // 内半径：竞技管腔（收窄）
    const outerR = def.outer ?? this.gateWidth;  // 外半径：贴合主赛道边缘
    const centerY = def.centerY ?? 0;
    // 漏斗长度：默认取管长的 45%（上限 34m）。短漏斗（曾用 12m）会把
    // "主道半宽 → 6m 内径"压进十几米，贴边行驶的船在最后几米被一次性横推近 4m，
    // 看上去就是管口凭空一堵空气墙。长漏斗让收窄摊到几十米上，每帧只收十几厘米。
    const blend = Math.min(def.blend ?? 34, len * 0.45);
    this.tunnel = { points: dense, len, radius: innerR, outer: outerR, centerY, blend };

    const curve = new THREE.CatmullRomCurve3(
      dense.map(([x, z]) => new THREE.Vector3(x, centerY, z)),
      false,
      'centripetal',
    );
    const tubularSegments = Math.max(80, Math.round(len / 1.2));

    // 内壁：漏斗状管腔（主道半宽 → 内径），铺海洋艺术壁画。漏斗与 #constrainTunnel
    // 的 bound 使用同一 smoothstep 曲线，视觉管壁与物理约束完全贴合。
    const mouthR = this.gateWidth * 0.92;
    const radiusAt = (s) => {
      const edge = Math.min(s, len - s);
      const k = edge >= blend ? 1 : edge / blend;
      const sm = k * k * (3 - 2 * k);
      return THREE.MathUtils.lerp(mouthR, innerR, sm);
    };
    const innerMat = new THREE.MeshStandardMaterial({
      map: this.#marineArtTexture(), color: 0xffffff,
      emissive: 0x0a2028, emissiveIntensity: 0.5,
      roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide,
    });
    const inner = new THREE.Mesh(this.#funnelTubeGeometry(curve, len, radiusAt), innerMat);
    inner.castShadow = inner.receiveShadow = false;
    this.group.add(inner);

    // 外壁：贴合主赛道的礁石壳（半透明，双层壳让外壁轮廓清晰架在赛道上）
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x2a5670, roughness: 0.55, metalness: 0.2,
      transparent: true, opacity: 0.94, side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(new THREE.TubeGeometry(curve, tubularSegments, outerR, 40, false), shellMat);
    shell.castShadow = shell.receiveShadow = false;
    this.group.add(shell);

    // 外壁蓝色粒子光效（沿管长流动）
    this.#buildTunnelParticles(curve, outerR, len);

    // 两侧入口光环：贴合主赛道边缘，框出管道入口
    for (const end of [0, dense.length - 1]) {
      const p0 = dense[end];
      const p1 = dense[end === 0 ? 1 : end - 1];
      const fx = p1[0] - p0[0];
      const fz = p1[1] - p0[1];
      const dir = Math.atan2(fx, fz);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(outerR, 0.7, 12, 48),
        new THREE.MeshBasicMaterial({ color: 0x4fc8ff, transparent: true, opacity: 0.9 }),
      );
      ring.position.set(p0[0], centerY, p0[1]);
      ring.rotation.y = dir;
      this.group.add(ring);
    }
  }

  // 海洋艺术壁画贴图（Canvas 手绘风：光柱/珊瑚/鱼群/气泡，纵向上深海→海面）
  #marineArtTexture() {
    if (this.tunnelArtTex) return this.tunnelArtTex;
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const ctx = c.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#0a2c3a');
    grad.addColorStop(0.45, '#0f6280');
    grad.addColorStop(0.78, '#1bb5c8');
    grad.addColorStop(1, '#7feaf5');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 512);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(160,240,255,0.10)';
    for (let i = 0; i < 7; i++) {
      const x = 80 + i * 150;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 120, 512);
      ctx.lineTo(x + 40, 512);
      ctx.lineTo(x + 100, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    const coral = (x, h, w, fill) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(x, 512);
      ctx.quadraticCurveTo(x - w, 512 - h * 0.55, x - w * 0.4, 512 - h);
      ctx.quadraticCurveTo(x, 512 - h * 0.85, x + w * 0.4, 512 - h);
      ctx.quadraticCurveTo(x + w, 512 - h * 0.5, x, 512);
      ctx.fill();
    };
    const coralColors = ['#0d3b4a', '#0f4a5a', '#0a2e3f', '#14566a'];
    for (let i = 0; i < 14; i++) {
      coral(60 + i * 72 + ((i * 37) % 20), 120 + ((i * 53) % 140), 26 + (i % 3) * 8, coralColors[i % coralColors.length]);
    }
    for (let i = 0; i < 60; i++) {
      const x = (i * 97) % 1024;
      const y = 60 + ((i * 61) % 320);
      ctx.strokeStyle = i % 2 ? 'rgba(120,230,255,0.8)' : 'rgba(255,220,140,0.8)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 8, y - 6, x + 16, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(220,250,255,0.35)';
    for (let i = 0; i < 40; i++) {
      const x = (i * 131) % 1024;
      const y = 40 + ((i * 89) % 440);
      ctx.beginPath();
      ctx.arc(x, y, 2 + (i % 5), 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(6, 1);
    tex.anisotropy = 4;
    this.tunnelArtTex = tex;
    return tex;
  }

  // 半径沿管长变化的漏斗管几何（径向截面 + 顶点法线），用于内壁竞技收窄管腔
  #funnelTubeGeometry(curve, length, radiusAt) {
    const tubularSegments = Math.max(120, Math.round(length / 1.2));
    const radialSegments = 28;
    const frames = curve.computeFrenetFrames(tubularSegments, false);
    const positions = [];
    const uvs = [];
    const indices = [];
    const p = new THREE.Vector3();
    for (let i = 0; i <= tubularSegments; i++) {
      const t = i / tubularSegments;
      const r = radiusAt(t * length);
      curve.getPointAt(t, p);
      const N = frames.normals[i];
      const B = frames.binormals[i];
      for (let j = 0; j <= radialSegments; j++) {
        const a = (j / radialSegments) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        positions.push(
          p.x + (N.x * ca + B.x * sa) * r,
          p.y + (N.y * ca + B.y * sa) * r,
          p.z + (N.z * ca + B.z * sa) * r,
        );
        uvs.push(i / tubularSegments, j / radialSegments);
      }
    }
    for (let i = 0; i < tubularSegments; i++) {
      for (let j = 0; j < radialSegments; j++) {
        const a = i * (radialSegments + 1) + j;
        const b = a + 1;
        const cc = a + radialSegments + 1;
        const d = cc + 1;
        indices.push(a, cc, b, b, cc, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  // 外壁蓝色粒子：沿管长流动的发光蓝点（additive 混合，无深度写入）
  #buildTunnelParticles(curve, radius, len) {
    const count = Math.max(360, Math.min(1600, Math.round(len * 8)));
    const positions = new Float32Array(count * 3);
    const flow = new Float32Array(count);
    const speed = new Float32Array(count);
    const angle = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      flow[i] = Math.random();
      speed[i] = 0.35 + Math.random() * 1.0;
      angle[i] = Math.random() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x5fd0ff, size: 1.0, map: this.#glowSprite(),
      transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    this.tunnelParticles = {
      curve, radius, len, count, geo, mat, positions, flow, speed, angle,
      tmp: new THREE.Vector3(), tan: new THREE.Vector3(),
      nrm: new THREE.Vector3(), bin: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
    };
    this.#updateTunnelParticles(0);
  }

  #updateTunnelParticles(dt) {
    const tp = this.tunnelParticles;
    if (!tp) return;
    const { curve, radius, len, positions, flow, speed, angle, tmp, tan, nrm, bin, up } = tp;
    const step = dt / (len || 1);
    for (let i = 0; i < tp.count; i++) {
      let f = flow[i] + speed[i] * step;
      if (f >= 1) f -= 1;
      flow[i] = f;
      curve.getPointAt(f, tmp);
      curve.getTangentAt(f, tan).normalize();
      nrm.crossVectors(tan, up);
      if (nrm.lengthSq() < 1e-6) nrm.set(1, 0, 0);
      else nrm.normalize();
      bin.crossVectors(nrm, tan);
      const a = angle[i];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      positions[i * 3] = tmp.x + (nrm.x * ca + bin.x * sa) * radius;
      positions[i * 3 + 1] = tmp.y + (nrm.y * ca + bin.y * sa) * radius;
      positions[i * 3 + 2] = tmp.z + (nrm.z * ca + bin.z * sa) * radius;
    }
    tp.geo.attributes.position.needsUpdate = true;
  }

  // 发光光点精灵贴图（圆形径向渐变）
  #glowSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(230,250,255,1)');
    g.addColorStop(0.4, 'rgba(120,210,255,0.85)');
    g.addColorStop(1, 'rgba(40,120,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  }

  // ---------- 赛道机关 ----------
  // 加速带：直道中部发光箭头带，碾过获得 ~2.6s 加速（先到先得，3s 冷却）
  // （v8 删除 #constrainAirborne：coaster 玩法由 onCoaster 接管位置、从不产生
  //  airborne，该方法只会误拉普通弹射船；腾空船统一由 constrain() 的全高度
  //  主赛道/近道走廊墙约束。）

  #buildBoostPads() {
    const N = this.gates.length;
    // 地图可以指定加速带位置（gate 段 + t + side），霓虹海峡最后直道就是这么摆的；
    // 不写就走原来的"自动挑最长 4 段"。
    const explicit = Array.isArray(this.map.boostPads) ? this.map.boostPads : null;
    if (explicit) {
      this.padTex = getPadTexture();
      this.padTex.repeat.set(1, 3);
      this.padMat = new THREE.MeshBasicMaterial({
        map: this.padTex, color: this.map?.padColor ?? 0x35e8ff, transparent: true, opacity: 0.92,
        depthWrite: false, side: THREE.DoubleSide,
        // 水面很亮，不加 toneMapped:false 会被曝光压成一片淡蓝，几乎看不出是加速带
        toneMapped: false,
      });
      this.pads = [];
      for (const p of explicit) {
        const gi = ((Math.round(p.gate) % N) + N) % N;
        const a = this.gates[gi];
        const b = this.gates[(gi + 1) % N];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        const t = p.t ?? 0.5;
        const side = (p.side ?? 0) * this.gateWidth * 0.5;
        const x = a[0] + dx * t + nx * side;
        const z = a[1] + dz * t + nz * side;
        const dir = Math.atan2(dx, dz);
        const halfW = Math.min(this.gateWidth * 0.42, 5);
        const halfL = 7;
        const geo = new THREE.PlaneGeometry(halfW * 2, halfL * 2);
        geo.rotateZ(Math.PI);
        geo.rotateX(-Math.PI / 2);
        const mesh = new THREE.Mesh(geo, this.padMat);
        mesh.position.set(x, this.#visualHeightAt(x, z) + 0.16, z);
        mesh.rotation.y = dir;
        mesh.renderOrder = 1;
        this.group.add(mesh);
        this.pads.push({ x, z, dir, halfW, halfL });
      }
      return;
    }
    const segs = [];
    for (let i = 2; i < N - 1; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      segs.push({ i, len: Math.hypot(b[0] - a[0], b[1] - a[1]) });
    }
    segs.sort((a, b) => b.len - a.len);
    const chosen = [];
    if (this.map.startBoost) {
      const startSegment = Math.max(0, Math.min(N - 2, this.map.startBoost.segment ?? 1));
      chosen.push({ i: startSegment, len: 0 });
    }
    const maxPads = this.map.startBoost ? 5 : 4;
    for (const s of segs) {
      if (chosen.length >= maxPads) break;
      if (chosen.every((c) => Math.abs(c.i - s.i) > 3)) chosen.push(s);
    }

    const tex = getPadTexture();
    tex.repeat.set(1, 3);
    this.padTex = tex;
    this.padMat = new THREE.MeshBasicMaterial({
      map: tex, color: this.map?.padColor ?? 0x35e8ff, transparent: true, opacity: 0.7,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.pads = [];

    for (const s of chosen) {
      const a = this.gates[s.i];
      const b = this.gates[(s.i + 1) % N];
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      const dir = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const halfW = Math.min(this.gateWidth * 0.42, 5);
      const halfL = 5.5;
      const geo = new THREE.PlaneGeometry(halfW * 2, halfL * 2);
      // 先绕平面法线转 180°，再放平 → 贴图 v+ 指向世界 +Z（配合 rotation.y=dir 即沿赛道方向）
      geo.rotateZ(Math.PI);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, this.padMat);
      mesh.position.set(x, this.#visualHeightAt(x, z) + 0.16, z);
      mesh.rotation.y = dir;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.pads.push({ x, z, dir, halfW, halfL });
    }
  }

  // ---------- 近道 ----------
  // 金色拱门入口 + 水面流动箭头 + 两侧金色浮标（QQ飞车式捷径标记）
  #buildShortcuts() {
    if (!this.shortcuts.length) return;
    // Shortcuts keep the same lightning silhouette but use a restrained teal
    // rhythm, so the branch reads at racing speed without becoming a billboard.
    this.scTex = new THREE.CanvasTexture(getPadTexture().image);
    this.scTex.wrapS = THREE.RepeatWrapping;
    this.scTex.wrapT = THREE.RepeatWrapping;
    this.scTex.repeat.set(1, 2);
    this.scMat = new THREE.MeshBasicMaterial({
      map: this.scTex, color: 0x5effcf, transparent: true, opacity: 0.58,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.scArchMats = [];

    // 可视化裁剪：约束用 sc.points（端点吸附主道中线，保证无空气墙），
    // 但箭头/浮标/拱门只渲染"主道走廊之外"的中段（sc.renderPoints），
    // 蓝绿色近道光墙严格停在主赛道两个交汇点之间，绝不延伸进主道。
    //
    // 关键：必须保留首尾端点，否则近道光墙看起来"悬空"，与主道缺口的视觉衔接
    // 断了。玩家会反馈"近道和主赛道中间有一段空白/有缝"。旧版只保留远端中段
    // 是这个问题的根源。
    const mainLoop = [...this.gates, this.gates[0]];
    for (const sc of this.shortcuts) {
      const dense = [];
      for (let i = 0; i < sc.points.length - 1; i++) {
        const [ax, az] = sc.points[i];
        const [bx, bz] = sc.points[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 3));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          dense.push([ax + (bx - ax) * t, az + (bz - az) * t]);
        }
      }
      dense.push([...sc.points[sc.points.length - 1]]);
      // 把近道端点当成"主道门"的口子。近道墙渲染必须严格不进入主道走廊。
      // 算法：沿 dense 找到第一次跨越 keepDist 的位置，线性插值得到恰好 keepDist 的点；
      // 删掉"靠主道中线 ≤ keepDist"的全部区间；保留远端中段 + 两个精确交点。
      const clipAt = (keepDist) => {
        const findCross = (fromEnd) => {
          const step = fromEnd ? -1 : 1;
          const start = fromEnd ? dense.length - 1 : 0;
          const end = fromEnd ? -1 : dense.length;
          for (let i = start; i !== end - step; i += step) {
            const a = dense[i], b = dense[i + step];
            const da = nearestOnPolyline(mainLoop, a[0], a[1]).d;
            const db = nearestOnPolyline(mainLoop, b[0], b[1]).d;
            const aIn = da < keepDist, bIn = db < keepDist;
            if (aIn !== bIn) {
              const t = (da - keepDist) / (da - db);
              return [
                a[0] + (b[0] - a[0]) * t,
                a[1] + (b[1] - a[1]) * t,
              ];
            }
          }
          return null;
        };
        const startCross = findCross(false);
        const endCross = findCross(true);
        // 整段都在主道外侧（罕见）→ 用整段；整段都在内侧 → 无可见墙
        if (!startCross && !endCross) {
          const allOutside = nearestOnPolyline(mainLoop, dense[0][0], dense[0][1]).d >= keepDist;
          return allOutside ? dense.slice() : null;
        }
        // 远端中段 = 严格 ≥ keepDist 的密集点
        const inner = [];
        for (const p of dense) {
          if (nearestOnPolyline(mainLoop, p[0], p[1]).d >= keepDist) inner.push(p);
        }
        const out = [];
        if (startCross) out.push(startCross);
        for (const p of inner) out.push(p);
        if (endCross) {
          const last = out[out.length - 1];
          if (!last || Math.hypot(last[0] - endCross[0], last[1] - endCross[1]) > 0.05) out.push(endCross);
        }
        return out.length >= 2 ? out : null;
      };
      // keepDist = 主道墙外 + 半近道宽 + 0.5m 缓冲：
      //   起点段 / 末点段 ≤ keepDist 的部分完全删除，只保留远端中段 + 两个精确交点，
      //   避免近道墙起点插入主道墙造成视觉穿插。
      // 半近道宽作为缓冲 = 让玩家有"流出空隙"再进近道墙，视觉上"近道从主道缺口出去"。
      sc.renderPoints = clipAt(this.gateWidth + sc.width * 0.5 + 0.5)
        || clipAt(this.gateWidth);
      if (!sc.renderPoints) sc.renderPoints = [];
    }

    for (const sc of this.shortcuts) {
      if (sc.renderPoints.length < 2) continue;
      const routeGroup = new THREE.Group();
      // Hidden shortcuts keep the risk readable through the edge language without
      // advertising a full arrow trail from a distance.
      if (!sc.hidden) for (let i = 0; i < sc.renderPoints.length - 1; i++) {
        const [ax, az] = sc.renderPoints[i];
        const [bx, bz] = sc.renderPoints[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const dir = Math.atan2(bx - ax, bz - az);
        const n = Math.max(1, Math.round(len / 14));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const x = ax + (bx - ax) * t;
          const z = az + (bz - az) * t;
          const geo = new THREE.PlaneGeometry(Math.min(sc.width * 0.9, 7), 7);
          geo.rotateZ(Math.PI);
          geo.rotateX(-Math.PI / 2);
          const m = new THREE.Mesh(geo, this.scMat);
          m.position.set(x, 0.14, z);
          m.rotation.y = dir;
          m.renderOrder = 1;
          routeGroup.add(m);
        }
      }
      // 2) 两侧金色浮标（每隔 ~7 米）——仅主道之外的中段
      // 近道口的青绿光墙也一并停用（边界统一交给浮桶）
      // this.#buildNeonPathWalls(sc.renderPoints, sc.width, { parent: routeGroup, edgeType: 'shortcut' });
      // 3) 入口拱门 is omitted for hidden routes; the narrow neon edges are the clue.
      if (sc.hidden) {
        routeGroup.visible = true;
        this.group.add(routeGroup);
        continue;
      }
      const [ex, ez] = sc.renderPoints[0];
      const [nx0, nz0] = sc.renderPoints[1];
      const dir = Math.atan2(nx0 - ex, nz0 - ez);
      const fx = Math.sin(dir), fz = Math.cos(dir);
      const segLen = Math.hypot(nx0 - ex, nz0 - ez);
      const arch = this.#buildShortcutArch(sc, dir, fx, fz);
      arch.position.set(ex + fx * segLen * 0.15, 0, ez + fz * segLen * 0.15);
      routeGroup.add(arch);
      routeGroup.visible = true;
      this.group.add(routeGroup);
    }
  }

  /**
   * 近道入口拱门：先摆程序化门架当兜底（离线/模型失败也有门），
   * 带贴图的石拱 GLB 到了就原地换掉。两者占位一致（横跨近道、约 7.6m 高），
   * 保证近道口在任何情况下都能一眼认出来。
   */
  #buildShortcutArch(sc, dir, fx, fz) {
    const arch = new THREE.Group();
    const archMat = new THREE.MeshStandardMaterial({
      color: 0x5effcf, emissive: 0x16a886, emissiveIntensity: 0.95, roughness: 0.35, metalness: 0.25,
    });
    this.scArchMats.push(archMat);
    const fallback = new THREE.Group();
    for (const side of [-1, 1]) {
      const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 7, 8), archMat);
      pylon.position.set(-fz * sc.width * side, 3, fx * sc.width * side);
      fallback.add(pylon);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(sc.width * 2 + 1, 0.7, 0.7), archMat);
    beam.position.y = 6.5;
    beam.rotation.y = dir;
    fallback.add(beam);
    // 拱门顶"捷径"标记球（换成 GLB 后由模型自身承担识别，标记球退场）
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), archMat);
    gem.position.y = 7.6;
    fallback.add(gem);
    sc.gem = gem;
    arch.add(fallback);

    loadPropGlb(SHORTCUT_ARCH_URL).then((gltf) => {
      // 归一化：水平最大跨度撑满近道宽度，最高不超过 8.4m，底边贴水面
      const wrap = fitPropModel(gltf.scene.clone(true), {
        span: sc.width * 2 + 2,
        maxH: 8.4,
        yaw: dir,
        lift: 0.05,
      });
      fallback.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.geometry?.dispose();
      });
      arch.remove(fallback);
      arch.add(wrap);
      sc.gem = null;
    }).catch((err) => {
      console.warn('[track] 近道拱门模型加载失败，保留程序化门架', err);
    });
    return arch;
  }

  // ---------- 金龙过山车 ----------
  // 金色龙脊空中轨道：连接两段水域（出水 → 腾空飞驰 → 俯冲入水）
  // manual = 弹射坡手动腾空（空中可控）；auto = 锁定沿 spline 自动飞驰
  #buildCoaster() {
    const cd = this.coasterDef;
    const N = this.gates.length;

    // 途经门索引（from..to）
    const idxs = [];
    for (let i = cd.from; i !== cd.to; i = (i + 1) % N) idxs.push(i);
    idxs.push(cd.to);

    // 弹射起点：from 门沿前进方向 launchDist 米处
    const g0 = this.gates[cd.from];
    const g1 = this.gates[(cd.from + 1) % N];
    let ldx = g1[0] - g0[0];
    let ldz = g1[1] - g0[1];
    const ll = Math.hypot(ldx, ldz) || 1;
    ldx /= ll; ldz /= ll;
    const startX = g0[0] + ldx * cd.launchDist;
    const startZ = g0[1] + ldz * cd.launchDist;

    // 末端：越过 to 门 10 米（保证越过判定半径后再脱轨/落水）
    const gt = this.gates[cd.to];
    const gp = this.gates[(cd.to - 1 + N) % N];
    let edx = gt[0] - gp[0];
    let edz = gt[1] - gp[1];
    const el = Math.hypot(edx, edz) || 1;
    const endX = gt[0] + (edx / el) * 10;
    const endZ = gt[1] + (edz / el) * 10;

    // 控制点：起点 + 各门 + 末端，y 走"快升-高位巡航-急坠"剖面
    const ctrl2D = [[startX, startZ], ...idxs.map((i) => this.gates[i]), [endX, endZ]];
    // 累计长度 → 各控制点比例 u
    const cum = [0];
    for (let i = 1; i < ctrl2D.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(ctrl2D[i][0] - ctrl2D[i - 1][0], ctrl2D[i][1] - ctrl2D[i - 1][1]));
    }
    const total = cum[cum.length - 1] || 1;
    const yAt = (u) => {
      const rise = THREE.MathUtils.smoothstep(u, 0.0, 0.28);
      const fall = 1 - THREE.MathUtils.smoothstep(u, 0.72, 1.0);
      return Math.min(rise, fall) * cd.apex + (1 - fall) * (cd.entryDepth || 0);
    };
    const ctrl = ctrl2D.map((p, i) => new THREE.Vector3(p[0], yAt(cum[i] / total), p[1]));

    this.coasterCurve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.35);
    this.coasterLen = this.coasterCurve.getLength();
    this.coasterDir = Math.atan2(ldx, ldz); // 弹射方向（航向角）
    this.coasterStart = { x: startX, z: startZ };

    // ---- 视觉：金色龙脊轨道 ----
    // 主脊/行轨保留程序化扫掠（曲线连续性最好），但材质换成 Blender 烘焙的
    // 龙鳞贴图 + 法线；枕木/背鳍/支撑/龙门环/龙首换成 Blender 套件。
    const goldMat = new THREE.MeshStandardMaterial({
      color: 0xffd257, emissive: 0xb87700, emissiveIntensity: 0.8,
      roughness: 0.3, metalness: 0.6,
    });
    const redGoldMat = new THREE.MeshStandardMaterial({
      color: 0xe8542f, emissive: 0x7a1c05, emissiveIntensity: 0.9,
      roughness: 0.4, metalness: 0.3, flatShading: true,
    });
    this.coasterMats = [goldMat, redGoldMat];
    this.coasterGlowMats = [];
    const uvScale = new THREE.Vector2(Math.max(6, Math.round(this.coasterLen / 3)), 2.4);
    getCoasterScaleTextures().then(([col, nrm]) => {
      if (col) {
        col.repeat.copy(uvScale);
        goldMat.map = col;
      }
      if (nrm) {
        nrm.repeat.copy(uvScale);
        goldMat.normalMap = nrm;
      }
      goldMat.needsUpdate = true;
    });

    const SEG = Math.max(90, Math.round(this.coasterLen / 2));

    // 主脊梁（中置粗管）
    const spine = new THREE.Mesh(
      new THREE.TubeGeometry(this.coasterCurve, SEG, 0.75, 16, false),
      goldMat,
    );
    spine.castShadow = true;
    spine.receiveShadow = true;
    this.group.add(spine);

    // 两侧行轨 + 轨枕：沿曲线取切线构架，偏移出左右轨
    const SAMPLES = Math.max(40, Math.round(this.coasterLen / 4));
    const railL = [];
    const railR = [];
    const tiePos = [];
    const finPos = [];
    const supPos = [];
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      const p = this.coasterCurve.getPointAt(u);
      const tan = this.coasterCurve.getTangentAt(u).normalize();
      const side = new THREE.Vector3().crossVectors(up, tan).normalize();
      railL.push(new THREE.Vector3().copy(p).addScaledVector(side, -3.1));
      railR.push(new THREE.Vector3().copy(p).addScaledVector(side, 3.1));
      if (i % 2 === 0) tiePos.push({ p, side });
      // 龙脊背鳍：每 ~7 米一片，起伏成龙鳞节奏
      if (i % Math.max(2, Math.round(SAMPLES / 26)) === 0 && u > 0.04 && u < 0.97) {
        const wave = 0.65 + 0.35 * Math.sin(u * Math.PI * 10);
        finPos.push({ p: new THREE.Vector3().copy(p).addScaledVector(up, 0.6), tan, s: wave });
      }
      // 支撑柱：每 ~18 米一根
      if (i % Math.max(4, Math.round(SAMPLES / 9)) === 0) supPos.push(p);
    }
    const railMat = goldMat;
    for (const rail of [railL, railR]) {
      const railCurve = new THREE.CatmullRomCurve3(rail);
      this.group.add(new THREE.Mesh(new THREE.TubeGeometry(railCurve, SEG, 0.22, 10, false), railMat));
    }

    // 套件加载前的程序化兜底（离线/加载失败时整条轨道仍然完整）
    const fallback = new THREE.Group();
    fallback.name = 'coaster-fallback';
    this.group.add(fallback);

    // 轨枕（连接两轨的横梁）
    const tieGeo = new THREE.BoxGeometry(6.4, 0.18, 0.5);
    for (const { p, side } of tiePos) {
      const tie = new THREE.Mesh(tieGeo, goldMat);
      tie.position.copy(p);
      tie.lookAt(new THREE.Vector3().copy(p).add(side));
      fallback.add(tie);
    }
    // 龙脊背鳍（红色鎏金锥，越接近中段越大）
    const finGeo = new THREE.ConeGeometry(0.55, 2.0, 4);
    for (const f of finPos) {
      const fin = new THREE.Mesh(finGeo, redGoldMat);
      fin.position.copy(f.p);
      fin.scale.set(1, f.s, 1);
      fin.lookAt(new THREE.Vector3().copy(f.p).add(f.tan));
      fin.rotateX(Math.PI / 2); // 锥体轴向对齐切线后立起
      fallback.add(fin);
    }
    // 支撑柱：轨道 → 水面/海床
    const seabedY = this.map.style === 'palace' ? -13.5 : 0;
    const supGeo = new THREE.CylinderGeometry(0.42, 0.55, 1, 8);
    for (const p of supPos) {
      const h = Math.max(1, p.y - seabedY);
      const sup = new THREE.Mesh(supGeo, goldMat);
      sup.scale.y = h;
      sup.position.set(p.x, p.y - h / 2, p.z);
      fallback.add(sup);
      if (seabedY < 0) {
        const base = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 1.2, 8), goldMat);
        base.position.set(p.x, seabedY, p.z);
        fallback.add(base);
      }
    }
    // 末端入水龙门（金色巨环，俯冲穿环入水）
    const endP = this.coasterCurve.getPointAt(0.985);
    const endTan = this.coasterCurve.getTangentAt(0.985);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(this.gateWidth * 0.85, 0.8, 10, 28), goldMat);
    ring.position.copy(endP);
    ring.lookAt(new THREE.Vector3().copy(endP).add(endTan));
    fallback.add(ring);

    // 带贴图的套件到位后接管：枕木/背鳍/支撑/龙门环/龙首，全部实例化或单件
    this.#applyCoasterKit(fallback, { tiePos, finPos, supPos, seabedY });

    // ---- 弹射坡（manual 模式）----
    if (cd.mode === 'manual') {
      const rampLen = 12;
      const rampP = this.coasterCurve.getPointAt(Math.min(0.05, rampLen / this.coasterLen / 2));
      const rampTan = this.coasterCurve.getTangentAt(Math.min(0.05, rampLen / this.coasterLen / 2));
      const slope = Math.atan2(rampTan.y, Math.hypot(rampTan.x, rampTan.z));
      const rampGroup = new THREE.Group();
      const tex = getPadTexture().clone();
      tex.needsUpdate = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(2, 3);
      const rampMat = new THREE.MeshBasicMaterial({
        map: tex, color: 0xffc63a, transparent: true, opacity: 0.85,
        depthWrite: false, side: THREE.DoubleSide,
      });
      this.coasterRampTex = tex;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(this.gateWidth * 1.4, rampLen), rampMat);
      board.rotation.x = -Math.PI / 2;
      const boardWrap = new THREE.Group();
      boardWrap.add(board);
      boardWrap.rotation.x = -slope; // 前端翘起
      rampGroup.add(boardWrap);
      // 两侧金边 + 坡尾挡板
      for (const side of [-1, 1]) {
        const edge = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, rampLen), goldMat);
        edge.position.set(side * this.gateWidth * 0.7, 0, 0);
        edge.rotation.x = -slope;
        rampGroup.add(edge);
      }
      rampGroup.position.copy(rampP);
      rampGroup.position.y = 0.2;
      rampGroup.rotation.y = Math.atan2(rampTan.x, rampTan.z);
      this.group.add(rampGroup);
      this.rampPos = { x: rampP.x, z: rampP.z };
    } else {
      this.rampPos = { x: startX, z: startZ };
    }

    // 触发区数据（applyMechs 用）
    this.coasterTrigger = {
      x: this.rampPos.x,
      z: this.rampPos.z,
      dir: this.coasterDir,
      halfAlong: cd.mode === 'manual' ? 8 : 6,
      halfSide: this.gateWidth * 0.85,
    };
  }

  /**
   * 用 Blender 套件替换程序化枕木/背鳍/支撑/龙门环，并加一颗龙首。
   * 套件是单文件多对象：按名字前缀取几何，相同材质的合并成一个 InstancedMesh，
   * 枕木/背鳍/支撑只多出 5 个 draw call；龙门环与龙首各一个 Group。
   * 加载失败时保留 fallback（程序化几何），轨道照常可玩。
   */
  #applyCoasterKit(fallback, ctx) {
    loadPropGlb(COASTER_KIT_URL).then((gltf) => {
      if (!this.group) return;
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const PREFIXES = [
        'pillar_shaft', 'pillar_base', 'pillar_cap',
        'ring_gold', 'ring_red', 'head_gold', 'head_red', 'head_bronze', 'head_eye',
        'tie', 'fin',
      ];
      const buckets = new Map();
      root.traverse((obj) => {
        if (!obj.isMesh || !obj.geometry) return;
        const key = PREFIXES.find((p) => (obj.name || '').startsWith(p));
        if (!key) return;
        const geo = obj.geometry.clone();
        geo.applyMatrix4(obj.matrixWorld);
        const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ geo, mat });
      });
      if (!buckets.size) return;

      // 套件材质接进呼吸发光，和主脊/行轨同一个节奏
      const seenMats = new Set();
      for (const list of buckets.values()) {
        for (const { mat } of list) {
          if (!mat || seenMats.has(mat)) continue;
          seenMats.add(mat);
          if (/gold/i.test(mat.name) && mat.emissive) {
            mat.emissive.setHex(0xb87700);
            mat.emissiveIntensity = 0.5;
            this.coasterGlowMats.push(mat);
          } else if (/red/i.test(mat.name) && mat.emissive) {
            mat.emissive.setHex(0x7a1c05);
            mat.emissiveIntensity = 0.6;
            this.coasterGlowMats.push(mat);
          }
        }
      }

      const up = new THREE.Vector3(0, 1, 0);
      const tanV = new THREE.Vector3();
      const sideV = new THREE.Vector3();
      const yV = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const scl = new THREE.Vector3(1, 1, 1);
      const m4 = new THREE.Matrix4();
      const addInstances = (key, matrices) => {
        const list = buckets.get(key);
        if (!list || !matrices.length) return;
        const byMat = new Map();
        for (const { geo, mat } of list) {
          if (!byMat.has(mat)) byMat.set(mat, []);
          byMat.get(mat).push(geo);
        }
        for (const [mat, geos] of byMat) {
          const geo = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
          if (geos.length > 1) for (const g of geos) g.dispose();
          if (!geo) continue;
          geo.computeBoundingSphere();
          const mesh = new THREE.InstancedMesh(geo, mat, matrices.length);
          matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
          mesh.instanceMatrix.needsUpdate = true;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          this.group.add(mesh);
        }
      };

      // 轨枕：本地 X 横跨两轨、Z 沿切线
      const tieMats = [];
      for (const { p, side } of ctx.tiePos) {
        tanV.crossVectors(side, up).normalize();
        yV.crossVectors(tanV, side).normalize();
        q.setFromRotationMatrix(m4.makeBasis(side, yV, tanV));
        tieMats.push(new THREE.Matrix4().compose(p.clone(), q, scl));
      }
      addInstances('tie', tieMats);

      // 背鳍：本地 Y 向上、Z 沿切线，中段更高
      const finMats = [];
      for (const f of ctx.finPos) {
        tanV.copy(f.tan);
        sideV.crossVectors(up, tanV).normalize();
        yV.crossVectors(tanV, sideV).normalize();
        q.setFromRotationMatrix(m4.makeBasis(sideV, yV, tanV));
        finMats.push(new THREE.Matrix4().compose(
          f.p.clone(), q, new THREE.Vector3(1, f.s, 1),
        ));
      }
      addInstances('fin', finMats);

      // 支撑：柱础（贴海床）+ 柱身（按高度拉伸）+ 柱帽（贴轨道底）
      const baseMats = [];
      const shaftMats = [];
      const capMats = [];
      ctx.supPos.forEach((p, i) => {
        const yaw = new THREE.Quaternion().setFromAxisAngle(up, i * 0.7);
        const h = Math.max(1, p.y - ctx.seabedY);
        baseMats.push(new THREE.Matrix4().compose(
          new THREE.Vector3(p.x, ctx.seabedY, p.z), yaw, scl,
        ));
        shaftMats.push(new THREE.Matrix4().compose(
          new THREE.Vector3(p.x, ctx.seabedY + 0.2, p.z), new THREE.Quaternion(),
          new THREE.Vector3(1, Math.max(0.4, h - 1.5), 1),
        ));
        capMats.push(new THREE.Matrix4().compose(
          new THREE.Vector3(p.x, p.y - 1.35, p.z), new THREE.Quaternion(), scl,
        ));
      });
      addInstances('pillar_base', baseMats);
      addInstances('pillar_shaft', shaftMats);
      addInstances('pillar_cap', capMats);

      // 龙门环：模型外径 1，单位缩放 → 目标半径 gateWidth*0.85
      const ringGroup = new THREE.Group();
      for (const key of ['ring_gold', 'ring_red']) {
        for (const { geo, mat } of buckets.get(key) || []) {
          const mesh = new THREE.Mesh(geo, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          ringGroup.add(mesh);
        }
      }
      const eP = this.coasterCurve.getPointAt(0.985);
      const eT = this.coasterCurve.getTangentAt(0.985).normalize();
      ringGroup.position.copy(eP);
      ringGroup.lookAt(new THREE.Vector3().copy(eP).add(eT));
      ringGroup.scale.setScalar(this.gateWidth * 0.85);
      this.group.add(ringGroup);

      // 龙首：立在起坡后的第一段轨道上，朝前进方向
      const headGroup = new THREE.Group();
      for (const key of ['head_gold', 'head_red', 'head_bronze', 'head_eye']) {
        for (const { geo, mat } of buckets.get(key) || []) {
          const mesh = new THREE.Mesh(geo, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          headGroup.add(mesh);
        }
      }
      const hP = this.coasterCurve.getPointAt(0.12);
      const hT = this.coasterCurve.getTangentAt(0.12).normalize();
      headGroup.position.copy(hP).addScaledVector(up, 0.55);
      headGroup.lookAt(new THREE.Vector3().copy(hP).add(hT).addScaledVector(up, 0.55));
      headGroup.scale.setScalar(this.gateWidth * 0.115);
      this.group.add(headGroup);

      // 移除程序化兜底
      fallback.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
      fallback.removeFromParent();
    }).catch((err) => {
      console.warn('[track] 金龙过山车套件加载失败，保留程序化轨道', err);
    });
  }

  /**
   * 过山车触发与弹射（仅本地权威艇：本地玩家 + 主机侧 AI）
   * - manual：进入弹射坡 → 腾空（空中物理由 Boat.updateLocal 处理）
   * - auto：进入触发区 → 锁定沿 spline 飞驰（Boat.updateLocal 的 onCoaster 分支处理）
   */
  updateCoaster(boat, dt) {
    if (!this.coasterTrigger) return;
    const cd = this.coasterDef;
    if (boat.onCoaster || boat.airborne) return;
    if (boat.padCooldown != null && boat.padCooldown > 0 && cd.mode === 'auto') return;

    const T = this.coasterTrigger;
    const dx = boat.pos.x - T.x;
    const dz = boat.pos.z - T.z;
    const fx = Math.sin(T.dir);
    const fz = Math.cos(T.dir);
    const along = dx * fx + dz * fz;
    const side = dx * fz - dz * fx;
    if (along < -T.halfAlong || along > T.halfAlong || Math.abs(side) > T.halfSide) return;
    // 朝向检查：必须大致沿赛道方向冲入
    const dot = Math.sin(boat.heading) * fx + Math.cos(boat.heading) * fz;
    if (dot < 0.35 || boat.speed < 5) return;

    if (true) {
      // 就近吸附上轨：在 spline 上找距船最近的参数，沿切向偏移并入 t、侧向偏移
      // 并入 lateral（auto 模式 lateral 以 5/s 衰减归零，船自然滑回中心线），
      // 使上轨首帧位置与当前船位连续。旧版固定 t=0.015 会把触发区前沿的船
      // 硬拽到 spline 起点附近，每圈固定 5m+ 跳变（"经过一段位置就瞬移"）。
      const curve = this.coasterCurve;
      const SAMPLES = 48;
      let bu = 0, bd2 = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const u = i / SAMPLES;
        const p = curve.getPointAt(u);
        const d2 = (p.x - boat.pos.x) ** 2 + (p.z - boat.pos.z) ** 2;
        if (d2 < bd2) { bd2 = d2; bu = u; }
      }
      // 三分细化到厘米级
      let lo = Math.max(0, bu - 1 / SAMPLES);
      let hi = Math.min(1, bu + 1 / SAMPLES);
      for (let it = 0; it < 12; it++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) * 2 / 3;
        const p1 = curve.getPointAt(m1);
        const p2 = curve.getPointAt(m2);
        const d1 = (p1.x - boat.pos.x) ** 2 + (p1.z - boat.pos.z) ** 2;
        const d2 = (p2.x - boat.pos.x) ** 2 + (p2.z - boat.pos.z) ** 2;
        if (d1 <= d2) hi = m2; else lo = m1;
      }
      bu = (lo + hi) / 2;
      const q = curve.getPointAt(bu);
      const qtan = curve.getTangentAt(bu).normalize();
      const qside = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), qtan).normalize();
      const ox = boat.pos.x - q.x;
      const oz = boat.pos.z - q.z;
      const along = ox * qtan.x + oz * qtan.z;
      const lat0 = ox * qside.x + oz * qside.z;
      boat.onCoaster = {
        curve,
        t: THREE.MathUtils.clamp(bu + along / this.coasterLen, 0, 1),
        length: this.coasterLen,
        manual: cd.mode === 'manual',
        lateral: lat0,
        lat0,               // manual 限幅平滑收拢的起始偏移（未钳位）
        latSettle: 0,
        // 侧向基准冻结：spline 折返顶点切线掉头 180°，实时 side 会把入轨偏移
        // 瞬间甩出 2×|lateral| 米（单帧横甩 = 瞬移）。存世界方向供全行轨共用。
        side: { x: qside.x, z: qside.z },
        entryY: boat.pos.y,   // 入轨过渡：从登轨高度平滑升到轨道高度
        // 过渡时长随高度差缩放（0.3s ~ 1.2s）：吸附点已在爬坡段时差距可达 14m，
        // 固定 0.35s 会产生峰值 40m/s 的垂直速度
        boardDur: THREE.MathUtils.clamp(0.3 + Math.abs(q.y + 1.9 - boat.pos.y) * 0.07, 0.3, 1.2),
        boardT: 0,
      };
      boat.padCooldown = 4; // 防止脱轨瞬间二次触发
      this.opts?.onToast?.('🐉 金龙过山车，抓稳了！');
    } else {
      // 弹射：对齐弹射方向 + 强力腾空
      let dh = this.coasterDir - boat.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      boat.heading += dh * 0.8;
      boat.airborne = true;
      boat.vy = 12 + Math.min(boat.speed, 34) * 0.12;
      boat.pos.y = 0.6;
      const s = Math.min(Math.max(boat.speed * 1.5, 24), boat.def.maxSpeed * 2.2);
      boat.speed = s;
      boat.vel.x = Math.sin(boat.heading) * s;
      boat.vel.y = Math.cos(boat.heading) * s;
      boat.padCooldown = 4;
      this.opts?.onToast?.('⚡ 金龙弹射！');
    }
  }

  /** 机关动画（所有客户端按同一时间轴确定性播放，无需网络同步） */
  #routePose(gateIndex, side = 0, forward = 0) {
    const count = this.gates.length;
    const a = this.gates[((gateIndex % count) + count) % count];
    const b = this.gates[(gateIndex + 1) % count];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    return {
      x: (a[0] + b[0]) * 0.5 + fx * forward - fz * side,
      z: (a[1] + b[1]) * 0.5 + fz * forward + fx * side,
      dir: Math.atan2(fx, fz), fx, fz, nx: -fz, nz: fx,
    };
  }

  /**
   * 沿主赛道闭合折线从 (x,z) 最近的点沿行进方向推进 dist 米，
   * 返回 { x, z, fx, fz }（推进后位置 + 该处赛道切线）。弹射链用它跟随弯道排布。
   */
  #routeAdvance(x, z, dist) {
    const N = this.gates.length;
    const cum = [0];
    for (let i = 0; i < N; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[N] || 1;
    let best = { seg: 0, t: 0, d: Infinity };
    for (let i = 0; i < N; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const sx = b[0] - a[0];
      const sz = b[1] - a[1];
      const len2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (z - a[1]) * sz) / len2));
      const d = Math.hypot(x - (a[0] + sx * t), z - (a[1] + sz * t));
      if (d < best.d) best = { seg: i, t, d };
    }
    let s = cum[best.seg] + (cum[best.seg + 1] - cum[best.seg]) * best.t + dist;
    s = ((s % total) + total) % total;
    let i = 0;
    while (i < N - 1 && cum[i + 1] < s) i++;
    const a = this.gates[i];
    const b = this.gates[(i + 1) % N];
    const segLen = cum[i + 1] - cum[i] || 1;
    const t = (s - cum[i]) / segLen;
    return {
      x: a[0] + (b[0] - a[0]) * t,
      z: a[1] + (b[1] - a[1]) * t,
      fx: (b[0] - a[0]) / segLen,
      fz: (b[1] - a[1]) / segLen,
      s, // 推进后的全程弧长坐标（0..total）
    };
  }

  #routeLength() {
    let total = 0;
    for (let i = 0; i < this.gates.length; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % this.gates.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return total || 1;
  }

  #cumUpTo(gateIndex) {
    const N = this.gates.length;
    let s = 0;
    const stop = ((gateIndex % N) + N) % N;
    for (let i = 0; i < stop; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return s;
  }

  /**
   * 沿主赛道推进"直线距离" straight：弯道处弧长自动加长补差，
   * 保证新组与起点的直线距离恒等于 straight。
   * 旧版按弧长推进，急弯处组间直线距离远小于弧长 → launchSpeed 被解算得
   * 极小（15m/s < 船速），碰上弹射器反而急减速+朝向横拽（"逆行"手感来源）。
   */
  #routeAdvanceLinear(x, z, straight) {
    let arc = straight;
    let p = this.#routeAdvance(x, z, arc);
    for (let i = 0; i < 6; i++) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (Math.abs(d - straight) < 0.4) break;
      arc += straight - d;
      p = this.#routeAdvance(x, z, arc);
    }
    return p;
  }

  /**
   * 数值模拟弹射滞空时长：与 Boat.updateLocal 的分段重力完全一致
   * （高空 7.5 / 中空 14 / 低空 30），从 (y0, vy0) 弹到落水（y<=0 且下落中）。
   * 弹射链构建时用它反推组距 → 理想弹道必落在下一组上。
   */
  #simLaunchArc(y0, vy0, landingY = 0) {
    let y = y0;
    let vy = vy0;
    let t = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 900; i++) {
      const g = y > 6 ? 7.5 : y > 2.5 ? 14 : 30;
      vy -= g * dt;
      y += vy * dt;
      t += dt;
      if (vy < 0 && y <= landingY) return t;
    }
    return t;
  }

  #loadMarineVisual(url, pose, scale, rotation, onReady) {
    loadMarineModel(url).then((gltf) => {
      if (!this.group.parent) return;
      const root = gltf.scene.clone(true);
      root.position.set(pose.x, pose.y || 0, pose.z);
      root.rotation.y = rotation;
      root.scale.setScalar(scale);
      root.traverse((obj) => {
        if (obj.isMesh) { obj.castShadow = false; obj.receiveShadow = false; }
      });
      this.group.add(root);
      onReady?.(root);
    }).catch(() => {});
  }

  #buildMarineFeatures() {
    const def = this.map.marineFeatures;
    this.marine = { boosts: [], buoys: [], platforms: [] };
    if (!def) return;
    // 主题地图裁剪：熔岩图里"青绿加速水道 / 黑色弹射器 / 紫环"全是冷色通用资产，
    // 和黑橙场景严重打架。地图可以声明 skip:['boost','launch','buoy'] 逐项关掉，
    // 其它地图不写这个字段 → 行为一字不变。
    const skip = new Set(def.skip || []);
    const sideScale = this.gateWidth * 0.72;
    if (!skip.has('boost')) {
      const boostPose = this.#routePose(def.boostGate, def.boostSide * sideScale);
      const boost = { ...boostPose, halfAlong: 7.2, halfSide: 2.7, visual: null };
      this.marine.boosts.push(boost);
      this.#loadMarineVisual('/models/boost_water_lane.glb', boostPose, 1.7, boostPose.dir - Math.PI / 2, (root) => { boost.visual = root; });
    }

    if (!skip.has('buoy')) {
      const buoyPose = this.#routePose(def.buoyGate, def.buoySide * sideScale);
      const buoy = { ...buoyPose, bobPhase: def.buoyGate * 0.67, fallback: null };
      this.marine.buoys.push(buoy);
      // 旧的 red_buoy_chain.glb 是低模红桶 + 白灯罩，近看就是几块生硬的几何体；
      // 统一换成 Blender 出的精致浮标（红漆 + 锈迹 + 白反光带 + 灯罩），
      // 间距 / 碰撞 / 起伏动效全部沿用原来的三只浮标布局。
      buoy.fallback = this.#buildBuoyFallback(buoyPose);
    }

    // 弹射链：每组两个并排黑色弹射器、左右交替；接触即弹（不看速度/朝向/开合）。
    // 组距 = 弹道直线距离（#routeAdvanceLinear 弯道处按弧长补差，组间直线距恒定，
    // 修复旧版弧长推进在急弯处解算出"越弹越慢"的问题）。
    // launch 模式（弹射模式）：不生成单段链，改为沿主道全程每隔一段距离一组，
    // 覆盖圈程 12%-88%（避开起点/终点区、旋转门与过山车段），潜水区组自动沉到该深度。
    const chain = def.launchChain;
    const launchAll = this.opts?.mode === 'launch';
    if (!skip.has('launch') && (chain || launchAll)) {
      const cfg = chain || {};
      const speed = cfg.speed || 28;            // 链上锁定的水平速度（保证落点）
      const vySurf = cfg.launchVy ?? 13;        // 水面组竖直初速
      const vyUnder = cfg.underwaterVy ?? 22;   // 水下组竖直初速（保证能出水）
      const weave = cfg.weave ?? 2.6;           // 左右交替摆幅
      const pairGap = cfg.pairGap ?? 2.3;       // 并排两个弹射器的中心距
      const halfAlong = cfg.halfAlong ?? 5.5;   // 单个弹射器碰撞盒纵向半长
      const halfSide = cfg.halfSide ?? 2.4;     // 单个弹射器碰撞盒横向半宽
      const depthAt = (x, z) => {
        const d = this.diveHeightAt({ x, z });
        return d != null ? d : 0;
      };
      const groups = [];
      if (launchAll) {
        // 全图链（弹射模式）：链式弹道放置。弹射方向恒为赛道切线、速度恒为
        // speed，下一组直接放在"船从本组弹出的物理落点"在赛道上的投影处。
        // （旧版固定 40m 组距 + 弹向下一组：弯道处弦方向与切线偏差高达
        // 30-40°，船被斜甩出赛道；水下段还会解算出 43m/s 的超速弹射。）
        // coaster 段为禁区（跳过，前后都有链，不再整体截断）；龙宫从旋转门后起链。
        const total = this.#routeLength();
        let from = total * 0.12;
        const to = total * 0.88;
        if (this.map.palaceGate) from = Math.max(from, this.#cumUpTo(this.map.palaceGate.gate + 1));
        let skipZone = null;
        if (this.coasterDef) {
          const a = this.#cumUpTo(this.coasterDef.from) - 15;
          const b = this.#cumUpTo(this.coasterDef.to + 1) + 15;
          if (b > a) skipZone = [Math.max(0, a), Math.min(total - 1, b)];
        }
        // 全图链用较低竖直初速（滞空 ~1.3s）：组距更密、弯道处切线落点偏差更小
        const vyAll = cfg.launchVyAll ?? 11;
        // 左右交替的贴边偏移：弹射器组不再排成中心线直线，而是按序列左右错开
        // （落点推进仍在中心线上，仅弹射器视觉/碰撞位置左右贴边，方向恒切线）。
        const pairEdgeOffset = Math.max(0, this.gateWidth * 0.92 - (pairGap + halfSide + 0.25));
        let cur = this.#routeAdvance(this.gates[0][0], this.gates[0][1], from);
        for (let i = 0; i < 40; i++) {
          const y = depthAt(cur.x, cur.z);
          // 水下组竖直初速按深度自适应：刚好弹出水面上方 ~2m（破水需 sqrt(2*30|y|)，
          // 出水后再爬 2m 需 sqrt(2*14*2)≈7.5）。固定 vyUnder=22 在浅水段（如 -1.6m）
          // 会弹到 17m 高空、滞空 4.5s 飞 127m，落点远超下一组（龙宫"弹飞到
          // 不知名位置"的元凶）；深处（-8m）自适应值≈23 与固定值基本一致。
          const vy0 = y < -1 ? Math.max(vyAll, Math.sqrt(56 + 60 * (-y))) : vyAll;
          // 两步解算滞空：先按本组深度试探，读落点处深度后重解（水面↔水下过渡段精确）
          let flight = this.#simLaunchArc(y + 0.65, vy0, y);
          const probe = this.#routeAdvance(cur.x, cur.z, speed * flight);
          const probeY = depthAt(probe.x, probe.z);
          if (Math.abs(probeY - y) > 0.5) {
            flight = this.#simLaunchArc(y + 0.65, vy0, probeY);
          }
          // 仅推移视觉/碰撞位置到左右边缘（中心线参与落点推进，保证链仍连贯）
          const lane = launchLaneSign(this.map.id, i) * pairEdgeOffset;
          groups.push({
            x: cur.x - cur.fz * lane, z: cur.z + cur.fx * lane, y,
            fx: cur.fx, fz: cur.fz, flight, vy: vy0,
          });
          // 落点 = 本组 + 切线 * (speed*flight)。船在空中每帧 vel=heading*speed（见
          // Boat.updateLocal），弹射方向=切线时弹道是直线；下一组直接放在物理落点
          // 处（纵向零偏差，弯道处切线外甩只影响横向），横向偏移超出门宽走廊时
          // 压回 gateWidth*0.4 内，剩余偏差靠碰撞盒/落水滑行吸收。
          const lx = cur.x + cur.fx * (speed * flight);
          const lz = cur.z + cur.fz * (speed * flight);
          let next = this.#routeAdvance(lx, lz, 0);
          if (next.s >= to || next.s < cur.s - 0.5) break; // -0.5 容差防 % 浮点误差误判
          if (skipZone && next.s >= skipZone[0] && next.s <= skipZone[1]) {
            next = this.#routeAdvance(this.gates[0][0], this.gates[0][1], skipZone[1]);
            if (next.s >= to) break;
          }
          // 下一组直接放在物理落点在赛道上的投影处（保持在中心线）。
          cur = next;
        }
      } else {
        // 单段链（普通竞速）：起点门起 count 组
        const start = this.#routePose(cfg.startGate, (cfg.side ?? 0.2) * sideScale);
        const startDive = depthAt(start.x, start.z);
        const under = startDive < -1;
        const flight0 = this.#simLaunchArc(startDive + 0.65, under ? vyUnder : vySurf, under ? startDive : 0);
        const step = speed * flight0;           // 组中心距 = 弹道水平距离
        // Race and item modes only keep one paired launcher (two platforms).
        // The full chain remains exclusive to launch mode.
        const groupCount = (this.opts?.mode === 'race' || this.opts?.mode === 'item')
          ? Math.min(1, cfg.count || 1)
          : (cfg.count || 4);
        for (let i = 0; i < groupCount; i++) {
          const adv = i === 0
            ? this.#routeAdvance(start.x, start.z, 0)
            : this.#routeAdvanceLinear(start.x, start.z, i * step);
          const wx = -adv.fz, wz = adv.fx; // 赛道法线（左右）
          const sway = (i % 2 === 0 ? -1 : 1) * weave;
          const cx = adv.x + wx * sway;
          const cz = adv.z + wz * sway;
          groups.push({
            x: cx, z: cz, y: depthAt(cx, cz),
            fx: adv.fx, fz: adv.fz,
          });
        }
      }
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        const next = groups[i + 1] || null;
        const vy0 = g.y < -1 ? vyUnder : vySurf;
        let dir, launchSpeed, flight;
        if (g.flight != null) {
          // 全图链（弹射模式）：方向恒为赛道切线、速度恒为 speed，弹射器成对对称
          // 放中心线。旧版用"指向已左右偏移的下一组"重算 dir 与速度，在弯道处
          // 相邻组法线不一致导致反向斜飞 + 速度畸大瞬移，此处移除该覆盖。
          dir = Math.atan2(g.fx, g.fz);
          launchSpeed = speed;
          flight = g.flight;
        } else {
          // 单段链（普通竞速）：逐组解算，滞空按本组起跳高度与下一组落点深度模拟，
          // 斜向距离/滞空 = 落点速度，理想弹道必落在下一组上；末组沿切线前抛。
          flight = this.#simLaunchArc(g.y + 0.65, vy0, next ? next.y : 0);
          dir = Math.atan2(g.fx, g.fz);
          launchSpeed = speed * 1.05;
          if (next) {
            const dx = next.x - g.x;
            const dz = next.z - g.z;
            const len = Math.hypot(dx, dz) || 1;
            dir = Math.atan2(dx, dz);
            launchSpeed = len / flight; // 斜向距离 / 滞空 = 落点速度
          }
        }
        const fx = Math.sin(dir), fz = Math.cos(dir);
        const lx = -fz, lz = fx; // 弹射器朝向的法线（并排展开方向）
        for (const lateral of [-pairGap, pairGap]) {
          this.marine.platforms.push({
            x: g.x + lx * lateral, z: g.z + lz * lateral, y: g.y,
            dir, fx, fz, halfAlong, halfSide,
            launchSpeed, launchVy: g.vy ?? vy0, nextY: next ? next.y : null, visual: null,
          });
        }
        // 视觉：一组两个并排弹射器模型（水下组沉到对应深度）
        for (const lateral of [-pairGap, pairGap]) {
          const pose = {
            x: g.x + lx * lateral, z: g.z + lz * lateral, y: g.y,
            dir,
          };
          this.#loadMarineVisual('/models/launch_platform.glb', pose, 0.92, dir - Math.PI / 2, (root) => {
            const plat = this.marine.platforms.find((q) => q.x === pose.x && q.z === pose.z);
            if (plat) plat.visual = root;
          });
        }
      }
    }
  }

  // ---------- 赛道道具：旗门 / 传送门 / 旋转锤 / 漩涡 ----------

  /**
   * 已被既有机关占用的门索引。只保留"物理上真的会重叠"的那些：
   * 近道/过山车改成几何距离判定（#distToShortcuts / #distToCoaster），
   * 否则像湖泊环线这种 16 门塞了 5 个机关的图会一个空位都不剩。
   */
  #reservedPropGates() {
    const N = this.gates.length;
    const set = new Set();
    const add = (i) => {
      if (!Number.isFinite(i)) return;
      set.add(((i % N) + N) % N);
    };
    const addRange = (a, b) => {
      for (let i = Math.floor(a); i <= Math.ceil(b); i++) add(i);
    };
    add(0); // 起跑/终点区
    for (const d of this.map.dives || []) addRange(d.from, d.to);
    if (this.map.tunnel) addRange(this.map.tunnel.from, this.map.tunnel.to);
    if (this.map.palaceGate) add(this.map.palaceGate.gate);
    const mf = this.map.marineFeatures;
    if (mf) {
      for (const g of [mf.boostGate, mf.buoyGate]) { add(g - 1); add(g); add(g + 1); }
      if (mf.launchChain) addRange(mf.launchChain.startGate - 1, mf.launchChain.startGate + mf.launchChain.count);
    }
    for (const i of this.map.pistonIndices || []) add(i);
    return set;
  }

  /** 点到近道折线的最短距离（道具压在近道上 = 要么堵死要么免费送加速） */
  #distToShortcuts(x, z) {
    let best = Infinity;
    for (const sc of this.shortcuts) {
      const pts = sc.points || [];
      for (let i = 0; i < pts.length - 1; i++) {
        const ax = pts[i][0], az = pts[i][1];
        const bx = pts[i + 1][0], bz = pts[i + 1][1];
        const dx = bx - ax, dz = bz - az;
        const len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** 点到金龙过山车轨道的水平最短距离（道具别糊在金色龙脊上） */
  #distToCoaster(x, z) {
    const curve = this.coasterCurve;
    if (!curve) return Infinity;
    let best = Infinity;
    const p = new THREE.Vector3();
    for (let i = 0; i <= 64; i++) {
      curve.getPointAt(i / 64, p);
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) best = d;
    }
    return best;
  }

  /** 从期望圈程往两侧找最近的"干净"门；找不到返回 null（宁可不放也不乱放） */
  #pickPropGate(want, kind, reserved, chosen) {
    const N = this.gates.length;
    const target = ((Math.round(want) % N) + N) % N;
    const shortcutGap = this.gateWidth * 1.1 + 7;
    const cand = [];
    for (let i = 0; i < N; i++) {
      const raw = Math.abs(i - target);
      cand.push({ i, d: Math.min(raw, N - raw) });
    }
    cand.sort((a, b) => a.d - b.d || a.i - b.i);
    // 沿赛道的弧长间隔：道具之间先要求 70m，地图太挤就退到 45m、30m。
    // "不压近道/不撞礁石/不贴伸缩柱/不糊在过山车轨道上"是硬约束，永远不放开。
    const trackGap = (a, b) => {
      const total = this.#routeLength();
      const raw = Math.abs(this.#cumUpTo(a) - this.#cumUpTo(b));
      return Math.min(raw, total - raw);
    };
    // 出场顺序：旗门 → 传送门 → 旋转锤 → 漩涡，尽量沿赛道顺次出现
    const prev = chosen.length ? chosen[chosen.length - 1].gate : null;
    const aheadOfPrev = (i) => prev == null || this.#cumUpTo(i) > this.#cumUpTo(prev) + 40;
    const scan = (minGap, requireAhead) => {
      for (const { i } of cand) {
        if (i < 1 && kind !== 'flag') continue;
        if (kind !== 'flag' && reserved.has(i)) continue;
        if (requireAhead && !aheadOfPrev(i)) continue;
        if (chosen.some((c) => trackGap(i, c.gate) < minGap)) continue;
        const pose = this.#routePose(i, 0);
        if (this.#distToShortcuts(pose.x, pose.z) < shortcutGap) continue;
        if (this.#distToCoaster(pose.x, pose.z) < 12) continue;
        if ((this.map.rocks || []).some((r) => Math.hypot(r.x - pose.x, r.z - pose.z) < (r.r || 3) + 9)) continue;
        return i;
      }
      return null;
    };
    return scan(70, true) ?? scan(45, true) ?? scan(30, true)
      ?? scan(45, false) ?? scan(30, false) ?? scan(0, false);
  }

  /**
   * 长赛道（strait）的石木布景：城墙隘口 / 连续隧道 / 波浪栈道 / 发卡弯木护墙。
   * 全部按门索引与逐门高度落位，几何合并成两个网格（石木 + 霓虹），
   * 3km 长图也只多两次绘制。
   */
  #buildStraitProps(cfg) {
    // 大构件走 Blender 原型（public/models/track/*.glb），
    // 只有长度每段都不一样的纵向木梁这类小件仍用程序化盒子。
    const solids = [];
    const neons = [];
    const instances = [];
    const addBox = (list, color, w, h, d, x, y, z, yaw = 0) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      if (yaw) geo.rotateY(yaw);
      geo.translate(x, y + h * 0.5, z);
      list.push(list === solids ? this.#paint(geo, color) : geo);
    };
    const addProto = (name, x, y, z, yaw = 0, sx = 1, sy = 1, sz = 1) => {
      instances.push({ name, x, y, z, yaw, sx, sy, sz });
    };
    const frameAt = (i) => {
      const N = this.gates.length;
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      const fx = dx / L;
      const fz = dz / L;
      return {
        gx: a[0], gz: a[1], fx, fz, nx: -fz, nz: fx,
        yaw: Math.atan2(fx, fz), y0: this.gateY[i] || 0,
      };
    };

    // ---------- 1. 城墙隘口：两侧石墙 + 城垛 + 横梁 + 内侧霓虹条 ----------
    for (const gi of cfg.wallGates || []) {
      const f = frameAt(gi);
      const wallHalf = 7.0;
      const inner = this.gateWidth + 1.4;
      for (const side of [-1, 1]) {
        const lat = side * (inner + wallHalf);
        addProto('stone_wall', f.gx + f.nx * lat, f.y0, f.gz + f.nz * lat, f.yaw);
        const latNeon = side * (inner - 0.12);
        addBox(
          neons, 0, 0.2, 0.22, 3.2,
          f.gx + f.nx * latNeon, f.y0 + 2.6, f.gz + f.nz * latNeon, f.yaw,
        );
      }
      // 城门楼：资产自带双墩 + 段落拱（门洞净空 12.6m），所以**直接站在水面上**，
      // 不再像旧版那样把一根 19.5m 的横梁吊在 7.4m 高处 —— 旧版横梁离水面太近，
      // 开过去时整条视野都被它切一刀（用户反馈的主要问题）。
      addProto('gate_lintel', f.gx, f.y0, f.gz, f.yaw);
      // 拱腹下沿的霓虹：贴着拱顶走，抬头能看到一条青光
      addBox(neons, 0, inner * 2 - 0.6, 0.16, 0.16, f.gx, f.y0 + 12.42, f.gz, f.yaw);
    }

    // ---------- 2. 连续隧道：等距石柱 + 顶梁 + 纵向压顶 ----------
    for (const [from, to] of cfg.tunnels || []) {
      const ribs = [];
      for (let i = from; i < to; i++) {
        const a = this.gates[i];
        const b = this.gates[i + 1];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const L = Math.hypot(dx, dz) || 1;
        const fx = dx / L;
        const fz = dz / L;
        const nx = -fz;
        const nz = fx;
        const yaw = Math.atan2(fx, fz);
        const n = Math.max(1, Math.round(L / 3.6));
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          ribs.push({
            x: a[0] + dx * t, z: a[1] + dz * t, y: this.#visualHeightAt(a[0] + dx * t, a[1] + dz * t),
            nx, nz, yaw,
          });
        }
      }
      const pierH = 4.3;
      for (const r of ribs) {
        addProto('tunnel_rib', r.x, r.y, r.z, r.yaw);
        addBox(neons, 0, this.gateWidth * 2 + 2.8, 0.16, 0.16, r.x, r.y + pierH - 0.18, r.z, r.yaw);
      }
      // 纵向压顶：相邻石柱之间连一根木梁，隧道才有"被盖住"的连续感
      for (let k = 1; k < ribs.length; k++) {
        const p = ribs[k - 1];
        const q = ribs[k];
        const dx = q.x - p.x;
        const dz = q.z - p.z;
        const L = Math.hypot(dx, dz) || 1;
        if (L > 12) continue; // 跨门段被折叠/跳段时断开
        const yaw = Math.atan2(dx, dz);
        const nx = -dz / L;
        const nz = dx / L;
        for (const side of [-1, 1]) {
          addBox(solids, 0x77624a, 0.4, 0.3, L + 0.3,
            (p.x + q.x) / 2 + nx * (this.gateWidth + 0.9) * side,
            pierH - 0.2,
            (p.z + q.z) / 2 + nz * (this.gateWidth + 0.9) * side, yaw);
        }
      }
    }

    // ---------- 3. 波浪栈道：连续木桥面（真 UV + 木纹）+ 支撑桩 + 霓虹边条 ----------
    // 为什么桥面不走"掰段摆刚体模型"：栈道是左右来回摆的 S 形，门点处折角能到 40°，
    // 17.8m 宽的矩形段在弯道内侧必然张开一道几米宽的 V 形口子（实测侧面能直接看到水，
    // 底衬也盖不住）。所以桥面改成沿门折线密集采样、法线取前后方向的平分线、
    // 相邻节点共享左右边缘点 —— 拼出来是一条连续条带，弯道天然无缝。
    // 板条/板缝交给 bridge_wood.png（一张 2.4m，3 条板 = 0.8m 一排，与航道板宽一致）。
    if (Array.isArray(cfg.boardwalk) && cfg.boardwalk.length === 2) {
      const [bwFrom, bwTo] = cfg.boardwalk;
      const GN = this.gates.length;
      const NODES_STEP = 1.2;        // 采样步长（米）：越小弯道越顺，1.2 已看不出折线
      const DECK_W = 17.8;           // 桥面全宽（浮桶线在 ±8.95，板面略窄一圈）
      const DECK_T = 0.34;           // 桥面厚度 = 板厚 + 边梁高度，侧面看就是"有厚度的桥"
      const nodes = [];
      const pushNode = (x, z, y) => nodes.push({ x, z, y });
      for (let i = Math.max(0, bwFrom - 1); i < bwTo; i++) {
        const a = this.gates[i];
        const b = this.gates[(i + 1) % GN];
        const ya = this.gateY[i] || 0;
        const yb = this.gateY[(i + 1) % GN] || 0;
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const n = Math.max(1, Math.ceil(L / NODES_STEP));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          pushNode(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, ya + (yb - ya) * t);
        }
      }
      {
        // 收尾点：最后一段的终点（bwTo 号门）
        const i = Math.min(GN - 1, bwTo);
        pushNode(this.gates[i][0], this.gates[i][1], this.gateY[i] || 0);
      }
      // 平滑法线（前后方向平分）+ 沿程累计距离（给 UV 的 v 用）
      let acc = 0;
      for (let i = 0; i < nodes.length; i++) {
        const p = nodes[Math.max(0, i - 1)];
        const q = nodes[Math.min(nodes.length - 1, i + 1)];
        let tx = q.x - p.x;
        let tz = q.z - p.z;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        nodes[i].nx = -tz;
        nodes[i].nz = tx;
        if (i > 0) acc += Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].z - nodes[i - 1].z);
        nodes[i].dist = acc;
      }
      // 每节点 4 个顶点：顶左 / 顶右 / 底左 / 底右；顶面、底面、左右侧壁各成一条带
      const vtx = [];
      const uvs = [];
      const idx = [];
      const UVU = 1 / 2.4;            // 横向：一张贴图 2.4m
      const UVV = 1 / 2.4;            // 沿程：一张贴图 2.4m（内含 3 排板）
      for (const nd of nodes) {
        const hw = DECK_W * 0.5;
        const lx = nd.x + nd.nx * hw;
        const lz = nd.z + nd.nz * hw;
        const rx = nd.x - nd.nx * hw;
        const rz = nd.z - nd.nz * hw;
        vtx.push(lx, nd.y, lz);
        vtx.push(rx, nd.y, rz);
        vtx.push(lx, nd.y - DECK_T, lz);
        vtx.push(rx, nd.y - DECK_T, rz);
        uvs.push(0, nd.dist * UVV);
        uvs.push(DECK_W * UVU, nd.dist * UVV);
        uvs.push(0, nd.dist * UVV);
        uvs.push(DECK_W * UVU, nd.dist * UVV);
      }
      for (let i = 0; i < nodes.length - 1; i++) {
        const a = i * 4;
        const b = (i + 1) * 4;
        // 顶面（+Y）
        idx.push(a + 0, b + 0, a + 1, a + 1, b + 0, b + 1);
        // 底面（-Y）
        idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
        // 左侧壁
        idx.push(a + 0, a + 2, b + 0, a + 2, b + 2, b + 0);
        // 右侧壁
        idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
      }
      const deckGeo = new THREE.BufferGeometry();
      deckGeo.setAttribute('position', new THREE.Float32BufferAttribute(vtx, 3));
      deckGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      deckGeo.setIndex(idx);
      deckGeo.computeVertexNormals();
      const deck = new THREE.Mesh(deckGeo, new THREE.MeshStandardMaterial({
        map: getStraitWoodMap(), roughness: 0.92, metalness: 0.02,
        side: THREE.DoubleSide,
      }));
      deck.name = 'strait_deck';
      deck.receiveShadow = true;
      this.group.add(deck);

      // 霓虹边条 + 支撑桩：按节点摆（这两样是离散件，不需要无缝）
      for (let i = 0; i < nodes.length; i++) {
        const nd = nodes[i];
        const nx2 = nodes[Math.min(nodes.length - 1, i + 1)];
        const yaw = Math.atan2(nx2.x - nd.x, nx2.z - nd.z);
        const segLen = Math.max(0.6, Math.hypot(nx2.x - nd.x, nx2.z - nd.z) * 1.06);
        for (const side of [-1, 1]) {
          addBox(neons, 0, 0.18, 0.12, segLen + 0.05,
            nd.x + nd.nx * (this.gateWidth + 0.95) * side, nd.y + 0.02,
            nd.z + nd.nz * (this.gateWidth + 0.95) * side, yaw);
        }
        if (i % 6 === 0 && nd.y > 0.25) {
          for (const side of [-1, 1]) {
            addProto('boardwalk_post',
              nd.x + nd.nx * (this.gateWidth + 0.7) * side, 0,
              nd.z + nd.nz * (this.gateWidth + 0.7) * side, 0, 1, Math.max(0.2, nd.y - 0.34), 1);
          }
        }
      }
    }

    // ---------- 4. 发卡弯木护墙：外缘一侧的短桩 + 双横杆 ----------
    if (cfg.hairpin && Number.isFinite(cfg.hairpin.from) && Number.isFinite(cfg.hairpin.to)) {
      const hp = cfg.hairpin;
      const side = hp.side || -1;
      const pts = [];
      for (let i = hp.from; i < hp.to; i++) {
        const a = this.gates[i];
        const b = this.gates[(i + 1) % this.gates.length];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const L = Math.hypot(dx, dz) || 1;
        const nx = -dz / L;
        const nz = dx / L;
        const n = Math.max(1, Math.ceil(L / 4.5));
        for (let k = 0; k < n; k++) {
          const t = k / n;
          pts.push({
            x: a[0] + dx * t + nx * (this.gateWidth + 1.3) * side,
            z: a[1] + dz * t + nz * (this.gateWidth + 1.3) * side,
          });
        }
      }
      const last = this.gates[hp.to];
      const prev = this.gates[hp.to - 1];
      const ld = Math.hypot(last[0] - prev[0], last[1] - prev[1]) || 1;
      pts.push({
        x: last[0] + (-(last[1] - prev[1]) / ld) * (this.gateWidth + 1.3) * side,
        z: last[1] + ((last[0] - prev[0]) / ld) * (this.gateWidth + 1.3) * side,
      });
      for (let k = 0; k < pts.length; k++) {
        addProto('rail_post', pts[k].x, 0, pts[k].z);
        if (!k) continue;
        const dx = pts[k].x - pts[k - 1].x;
        const dz = pts[k].z - pts[k - 1].z;
        const L = Math.hypot(dx, dz) || 1;
        if (L > 14) continue;
        const yaw = Math.atan2(dx, dz);
        for (const yy of [0.55, 1.1]) {
          addProto('rail_beam',
            (pts[k].x + pts[k - 1].x) / 2, yy, (pts[k].z + pts[k - 1].z) / 2, yaw, 1, 1, L + 0.1);
        }
      }
    }

    // ---------- 5. 城墙顶松树：给石墙一点生气，也做远景地标 ----------
    for (const gi of cfg.pines?.gates || []) {
      const f = frameAt(gi);
      for (const side of [-1, 1]) {
        for (const off of [-4.5, 0, 4.5]) {
          const lat = side * (this.gateWidth + 8.4 + off);
          addProto('pine_tree',
            f.gx + f.nx * lat, f.y0 + 6.85, f.gz + f.nz * lat);
        }
      }
    }

    if (neons.length) {
      const geo = mergeGeometries(neons, false);
      if (geo) {
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0x38f0c4, toneMapped: false,
        }));
        mesh.name = 'strait_neon';
        this.group.add(mesh);
      }
    }

    if (!instances.length && !solids.length) return;
    const protoNames = [...new Set(instances.map((inst) => inst.name))];
    Promise.all(protoNames.map((name) => loadStraitProto(name).catch(() => null))).then((lists) => {
      if (!this.group.parent) return;
      const partsByProto = new Map();
      protoNames.forEach((name, i) => partsByProto.set(name, lists[i] || []));
      // 石构件与木构件分组：石墙/横梁/隧道柱走三平面石纹（不再是一块块纯色），
      // 木栈道/护墙/松树保留顶点色；两组都开投影，避免"纸片浮在水上"。
      const STONE_PROTOS = new Set(['stone_wall', 'gate_lintel', 'tunnel_rib']);
      // 木纹组：栈桥板面/桥桩/木栏杆走三平面木纹投影（不再是纯顶点色板条）。
      // 松树不进这一组 —— 给树皮上木板纹是灾难。
      const WOOD_PROTOS = new Set(['boardwalk_deck', 'boardwalk_post', 'rail_post', 'rail_beam']);
      const stoneGeos = [];
      const plankGeos = [];
      const woodGeos = [];
      const matrix = new THREE.Matrix4();
      const quat = new THREE.Quaternion();
      const axis = new THREE.Vector3(0, 1, 0);
      const pos = new THREE.Vector3();
      const scl = new THREE.Vector3();
      for (const inst of instances) {
        const parts = partsByProto.get(inst.name);
        if (!parts || !parts.length) continue;
        quat.setFromAxisAngle(axis, inst.yaw || 0);
        matrix.compose(
          pos.set(inst.x, inst.y, inst.z), quat, scl.set(inst.sx, inst.sy, inst.sz),
        );
        const bucket = STONE_PROTOS.has(inst.name) ? stoneGeos
          : WOOD_PROTOS.has(inst.name) ? plankGeos : woodGeos;
        for (const part of parts) {
          bucket.push(this.#paint(part.geo.clone().applyMatrix4(matrix), part.color));
        }
      }
      // 隧道压顶 / 发卡弯横梁这类程序化木盒也进木纹组
      plankGeos.push(...solids);
      // 程序化盒子带 uv，GLB 只有 position/normal：合批前把属性对齐
      for (const geo of [...stoneGeos, ...plankGeos, ...woodGeos]) {
        geo.deleteAttribute('uv');
        geo.deleteAttribute('uv2');
      }

      if (plankGeos.length) {
        const mergedPlank = mergeGeometries(plankGeos, false);
        if (mergedPlank) {
          // vertexColors 关掉：桥面颜色交给木纹贴图，顶点色那层深棕再乘一次会发黑
          const plankMat = new THREE.MeshStandardMaterial({
            roughness: 0.93, metalness: 0.02, flatShading: true,
          });
          const woodMap = getStraitWoodMap();
          plankMat.onBeforeCompile = (shader) => {
            shader.uniforms.woodMap = { value: woodMap };
            // 一张贴图铺 2.4m：bridge_wood.png 里是 3 条板，3×0.8 ≈ 真实板条 0.78 的节距，
            // 所以贴图板缝和几何板缝几乎重合，不会出现"两套板缝"打架
            shader.uniforms.woodScale = { value: 1 / 2.4 };
            // 木纹高度扰动的采样步长 / 起伏量（米）
            shader.uniforms.woodEps = { value: 0.022 };
            shader.uniforms.woodRelief = { value: 0.012 };
            shader.uniforms.woodBump = { value: 0.9 };
            shader.vertexShader = shader.vertexShader
              .replace('#include <common>',
                '#include <common>\nvarying vec3 vWoodPos;\nvarying vec3 vWoodNrm;')
              .replace('#include <begin_vertex>',
                '#include <begin_vertex>\nvWoodPos = position;\nvWoodNrm = normal;');
            shader.fragmentShader = shader.fragmentShader
              .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vWoodPos;',
                'varying vec3 vWoodNrm;',
                'uniform sampler2D woodMap;',
                'uniform float woodScale;',
                'uniform float woodEps;',
                'uniform float woodRelief;',
                'uniform float woodBump;',
                'vec3 woodWt(vec3 n) { vec3 a = abs(normalize(n)); return a / max(1e-4, a.x + a.y + a.z); }',
                'vec3 woodTri(vec3 p, vec3 w, float s) {',
                // 桥面是横铺板（板长沿世界 X、每 0.8m 一排），所以 u 轴跟 X。
                // 早期版本把 u 对到 Z，结果贴图板缝和几何板缝十字交叉，看着像瓷砖。
                '  return texture2D(woodMap, p.zy * s).rgb * w.x',
                '       + texture2D(woodMap, p.xz * s).rgb * w.y',
                '       + texture2D(woodMap, p.xy * s).rgb * w.z;',
                '}',
                'float woodH(vec3 p, vec3 w, float s) {',
                '  return texture2D(woodMap, p.zy * s).r * w.x',
                '       + texture2D(woodMap, p.xz * s).r * w.y',
                '       + texture2D(woodMap, p.xy * s).r * w.z;',
                '}',
              ].join('\n'))
              .replace('#include <map_fragment>', [
                '#include <map_fragment>',
                // 每块板一个伪随机色调：同一段里的 5 块板宽 3.55、排高 0.80，
                // 按这个尺寸切格取 hash，板条之间才有深浅差，不是一整片塑料
                'vec2 woodCell = floor(vec2(vWoodPos.x / 3.55, vWoodPos.z / 0.80));',
                'float woodTone = fract(sin(dot(woodCell, vec2(12.9898, 78.233))) * 43758.5453);',
                'diffuseColor.rgb *= woodTri(vWoodPos, woodWt(vWoodNrm), woodScale)'
                  + ' * (1.62 + 0.30 * woodTone);',
              ].join('\n'))
              // 木纹当高度场求梯度 → 当额外的法线扰动。木头没有这个就是"印了花的纸"
              .replace('#include <normal_fragment_maps>', [
                '#include <normal_fragment_maps>',
                '{',
                '  vec3 nw = woodWt(vWoodNrm);',
                '  vec3 sp = vWoodPos;',
                '  float h0 = woodH(sp, nw, woodScale);',
                '  vec3 gr = vec3(',
                '    woodH(sp + vec3(woodEps, 0.0, 0.0), nw, woodScale) - h0,',
                '    woodH(sp + vec3(0.0, woodEps, 0.0), nw, woodScale) - h0,',
                '    woodH(sp + vec3(0.0, 0.0, woodEps), nw, woodScale) - h0',
                '  ) * (woodRelief / woodEps);',
                '  gr -= normal * dot(gr, normal);',
                '  normal = normalize(normal - (viewMatrix * vec4(gr, 0.0)).xyz * woodBump);',
                '}',
              ].join('\n'));
            /* eslint-disable no-undef */
            if (typeof window !== 'undefined') {
              window.__woodPatch = {
                color: shader.fragmentShader.indexOf('woodTri(vWoodPos') >= 0,
              };
            }
            /* eslint-enable no-undef */
          };
          const plank = new THREE.Mesh(mergedPlank, plankMat);
          plank.name = 'strait_plank';
          plank.castShadow = true;
          plank.receiveShadow = true;
          this.group.add(plank);
        }
      }

      if (stoneGeos.length) {
        const mergedStone = mergeGeometries(stoneGeos, false);
        if (mergedStone) {
          const stoneMat = new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.97, metalness: 0.02,
          });
          // 场景靠天光/环境贴图打亮，全强度会把这批石头照成"上釉的瓷砖"（发青发亮）。
          // 压到 0.6，石头才回到漫反射主导的哑光质感。
          stoneMat.envMapIntensity = 0.6;
          const maps = getStraitStoneMaps();
          stoneMat.onBeforeCompile = (shader) => {
            shader.uniforms.stoneMap = { value: maps.color };
            shader.uniforms.stoneHgt = { value: maps.height };
            // 一张贴图覆盖多少米：0.155 → 约 6.5m 一层砖（8 层），单块 ≈ 1.2m
            shader.uniforms.stoneScale = { value: 0.155 };
            // 求高度梯度时的采样步长（米）
            shader.uniforms.stoneEps = { value: 0.022 };
            // 高度场 0..1 折算成多少米起伏 —— 凹凸强度就是它乘 stoneBump
            shader.uniforms.stoneRelief = { value: 0.055 };
            shader.uniforms.stoneBump = { value: 0.75 };

            shader.vertexShader = shader.vertexShader
              .replace('#include <common>',
                '#include <common>\nvarying vec3 vStonePos;\nvarying vec3 vStoneNrm;')
              .replace('#include <begin_vertex>',
                '#include <begin_vertex>\nvStonePos = position;\nvStoneNrm = normal;');

            const frag = shader.fragmentShader;
            let out = frag
              .replace('#include <common>', [
                '#include <common>',
                'varying vec3 vStonePos;',
                'varying vec3 vStoneNrm;',
                'uniform sampler2D stoneMap;',
                'uniform sampler2D stoneHgt;',
                'uniform float stoneScale;',
                'uniform float stoneEps;',
                'uniform float stoneRelief;',
                'uniform float stoneBump;',
                // 三平面权重：法线越朝哪个轴，那个平面投出来的占比越大
                'vec3 stoneWt(vec3 n) { vec3 a = abs(normalize(n)); return a / max(1e-4, a.x + a.y + a.z); }',
                'vec3 stoneTri(vec3 p, vec3 w) { vec3 s = p * stoneScale;',
                '  return texture2D(stoneMap, s.zy).rgb * w.x',
                '       + texture2D(stoneMap, s.xz).rgb * w.y',
                '       + texture2D(stoneMap, s.xy).rgb * w.z; }',
                'float stoneTriH(vec3 p, vec3 w) { vec3 s = p * stoneScale;',
                '  return texture2D(stoneHgt, s.zy).r * w.x',
                '       + texture2D(stoneHgt, s.xz).r * w.y',
                '       + texture2D(stoneHgt, s.xy).r * w.z; }',
              ].join('\n'))
              .replace('#include <map_fragment>', [
                '#include <map_fragment>',
                // 贴图贴着顶点色乘：保留每块石头自己的基调，再叠砌缝/污渍/颗粒
                'diffuseColor.rgb *= stoneTri(vStonePos, stoneWt(vStoneNrm)) * vec3(1.34, 1.30, 1.22);',
              ].join('\n'))
              // 高度场求梯度 → 当额外的法线扰动（和标准法线贴图叠加，不替换）
              .replace('#include <normal_fragment_maps>', [
                '#include <normal_fragment_maps>',
                '{',
                '  vec3 nw = stoneWt(vStoneNrm);',
                '  vec3 sp = vStonePos;',
                '  float h0 = stoneTriH(sp, nw);',
                '  vec3 gr = vec3(',
                '    stoneTriH(sp + vec3(stoneEps, 0.0, 0.0), nw) - h0,',
                '    stoneTriH(sp + vec3(0.0, stoneEps, 0.0), nw) - h0,',
                '    stoneTriH(sp + vec3(0.0, 0.0, stoneEps), nw) - h0',
                '  ) * (stoneRelief / stoneEps);',
                // 只取切向分量（沿法线方向的梯度是"高度本身"，不构成倾角）
                '  gr -= normal * dot(gr, normal);',
                '  normal = normalize(normal - (viewMatrix * vec4(gr, 0.0)).xyz * stoneBump);',
                '}',
              ].join('\n'));
            shader.fragmentShader = out;
            // 打补丁最怕"字符串没匹配到、悄悄没生效"。留一个可读的命中标记，
            // 探针里直接读 window.__stonePatch 就能判断三平面/凹凸到底上没上。
            /* eslint-disable no-undef */
            if (typeof window !== 'undefined') {
              window.__stonePatch = {
                color: out.indexOf('stoneTri(vStonePos') >= 0,
                normal: out.indexOf('stoneRelief') >= 0 && out !== frag,
              };
            }
            /* eslint-enable no-undef */
          };
          const stone = new THREE.Mesh(mergedStone, stoneMat);
          stone.name = 'strait_stone';
          stone.castShadow = true;
          stone.receiveShadow = true;
          this.group.add(stone);
        }
      }

      if (woodGeos.length) {
        const mergedWood = mergeGeometries(woodGeos, false);
        if (mergedWood) {
          const wood = new THREE.Mesh(mergedWood, new THREE.MeshStandardMaterial({
            vertexColors: true, roughness: 0.92, metalness: 0.03, flatShading: true,
          }));
          wood.name = 'strait_solid';
          wood.castShadow = true;
          wood.receiveShadow = true;
          this.group.add(wood);
        }
      }
    });
  }

  #buildCourseProps() {
    this.courseProps.length = 0;
    const N = this.gates.length;
    if (N < 6) return;
    const specs = this.map.courseProps || DEFAULT_COURSE_PROPS;
    const reserved = this.#reservedPropGates();
    const chosen = [];
    specs.forEach((spec, index) => {
      let def = COURSE_PROP_DEFS[spec.kind];
      if (spec.kind === 'deco') {
        // 任意 GLB 装饰件：{ kind:'deco', glb:'/models/canyon/cliff.glb', at, side, span, lift }
        def = {
          label: spec.label || '装饰',
          url: spec.glb,
          span: () => (spec.span || 24),
          lift: spec.lift || 0,
        };
      }
      if (!def || !def.url) return;
      // deco 是布景，不参与"道具公平分布"那套约束，直接按弧长比例取门，
      // 否则 #pickPropGate 的硬约束会把它整个丢掉（表现就是"资产完全不出现"）
      const gate = spec.kind === 'deco'
        ? ((Math.round(frac01(spec.at) * N) % N) + N) % N
        : Number.isFinite(spec.gate)
          ? ((spec.gate % N) + N) % N
          : this.#pickPropGate(frac01(spec.at) * N, spec.kind, reserved, chosen);
      if (gate == null) return;
      const centered = spec.kind === 'flag' || spec.kind === 'portal';
      const sideFrac = Number.isFinite(spec.side)
        ? spec.side
        : centered ? 0 : spec.kind === 'hammer' ? 1.3 : spec.kind === 'deco' ? 1.75 : 1.15;
      let pose = this.#routePose(gate, sideFrac * this.gateWidth * 0.5);
      // 起点旗门：正对起点线（两腿落在赛道两侧、横梁在门线上方）。
      // #routePose 取的是两门之间的中点，这里改回 0 号门本体，让旗门真正架在起跑线上。
      if (spec.kind === 'flag' && gate === 0) {
        const gd = this.#gateDir(0);
        pose = {
          ...pose,
          x: this.gates[0][0],
          z: this.gates[0][1],
          dir: Math.atan2(gd.dx, gd.dz),
          fx: gd.dx,
          fz: gd.dz,
          nx: -gd.dz,
          nz: gd.dx,
        };
      }
      const y = this.#visualHeightAt(pose.x, pose.z);
      const span = spec.kind === 'flag' && gate === 0
        ? this.startWidth
        : def.span(this.gateWidth);
      const prop = {
        kind: spec.kind,
        label: def.label,
        gate,
        x: pose.x,
        z: pose.z,
        y,
        baseY: y + def.lift,
        dir: pose.dir,
        fx: pose.fx,
        fz: pose.fz,
        span,
        // deco 的模型多半是"长边沿建模 X 轴"，进游戏默认会把长边横在赛道上；
        // 用 yaw 转 90° 让它顺着赛道（Math.PI/2），拱门/隧道要靠这个摆正
        yaw: spec.kind === 'deco' ? (spec.yaw || 0) : 0,
        // 旗门高度＝航标灯柱高度（起点那一对柱子的高度）
        height: spec.kind === 'flag' ? 5.0 : undefined,
        holder: null,
        phase: (gate * 0.37 + index * 0.61) % 1,
      };
      if (spec.kind === 'portal') {
        // 判定圈略小于环口：必须真的从门里穿过去才算数
        prop.triggerR = span * 0.55;
      } else if (spec.kind === 'hammer') {
        prop.armRadius = span * 0.48;   // 抡臂末端（模型里臂长约为半跨度）
        prop.hitRadius = Math.max(1.2, span * 0.12);
        prop.hubRadius = span * 0.235;  // 底座是实心的，也得有碰撞
        prop.spinSpeed = 1.25;
        prop.angle = 0;
      } else if (spec.kind === 'whirl') {
        prop.radius = span * 0.5;
        prop.spinAngle = 0;
      }
      chosen.push(prop);
      this.courseProps.push(prop);
      this.#loadCoursePropVisual(prop, def);
    });
  }

  /**
   * 剔除"附件网格"后的包围盒。
   * 有些 GLB 会把建模场景的水面/地面平面一起导出（比如 700×700、4 顶点、高度≈0）。
   * 直接用 setFromObject 会让"按横向直径归一化"把它当成模型主体，整组被缩到 1/20，
   * 表现为资产进游戏后贴在水面上、几乎看不见。
   * 判据只认"大得离谱且极扁"（>120m 且高 < 横向 5%）：正常部件里没有这么大的，
   * 而山体底盘（48m 宽）这类真的扁而大的东西要保留，所以不能用"中位数倍数"那种相对阈值。
   */
  #fitBoxOf(root) {
    root.updateMatrixWorld(true);
    const entries = [];
    const tmp = new THREE.Box3();
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
      if (!obj.geometry.boundingBox) return;
      tmp.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
      entries.push({
        box: tmp.clone(),
        lateral: Math.max(tmp.max.x - tmp.min.x, tmp.max.z - tmp.min.z),
        height: tmp.max.y - tmp.min.y,
      });
    });
    if (!entries.length) return new THREE.Box3().setFromObject(root);
    const box = new THREE.Box3();
    let used = 0;
    for (const e of entries) {
      if (e.lateral > 120 && e.height < e.lateral * 0.05) continue; // 水面/地面这类附件
      box.union(e.box);
      used++;
    }
    return used ? box : new THREE.Box3().setFromObject(root);
  }

  #loadCoursePropVisual(prop, def) {
    // 海上龙宫是程序化几何（与深海龙宫水下大殿同源），不走 GLB 加载
    const model = def.url === 'procedural:surface-palace'
      ? Promise.resolve({ scene: buildSurfacePalace() })
      : loadMarineModel(def.url);
    model.then((gltf) => {
      if (!this.group.parent) return;
      const root = gltf.scene.clone(true);
      root.traverse((obj) => {
        if (obj.isMesh) {
          obj.castShadow = false;
          obj.receiveShadow = false;
          obj.frustumCulled = true;
          if (Number.isFinite(def.emissive)) {
            for (const mat of (Array.isArray(obj.material) ? obj.material : [obj.material])) {
              if (!mat || !mat.emissive) continue;
              mat.emissive.setHex(def.emissive);
              mat.emissiveIntensity = def.emissiveIntensity ?? 0.85;
            }
          }
        }
      });
      // 统一按"横向直径"归一化，再贴底到 y=0，最后整体抬到水面高度
      // ⚠️ 归一化用的包围盒必须排除"异常网格"：2026-10-30 事故 —— Blender 导出的 6 个峡谷
      // GLB 里混进了建模场景的 700×700 水面平面，lateral 被撑到 700，整组被缩到 1/20
      // （26m 崖壁只剩 1.8m 高），表现就是"资产完全没出现"。
      // 现在按每个 mesh 的横向尺寸取中位数，超过 4 倍中位数的当附件忽略。
      const box = this.#fitBoxOf(root);
      const size = box.getSize(new THREE.Vector3());
      const lateral = Math.max(size.x, size.z) || 1;
      root.scale.setScalar(prop.span / lateral);
      // 旗门宽度对齐起点/赛道线，高度保持模型比例
      if (prop.kind === 'flag') {
        if (prop.gate === 0) {
          // 起点旗门：横跨整条起点线，两腿落在 startWidth 两端，
          // 与方格线、计圈判定同宽 —— 两侧不再留"看着能过、过线不计圈"的缝隙。
          // 只拉横向、高度沿用原来的基准，否则整体等比放大 1.5 倍，
          // 旗门会变成一道又高又瘦的巨拱，比例失真。
          const s0 = (this.gateWidth * 2 + 1.5) / lateral;
          const sw = this.startWidth / lateral;
          const wideOnX = size.x >= size.z;
          root.scale.set(wideOnX ? sw : s0, s0, wideOnX ? s0 : sw);
        } else {
          // 赛段旗门：左腿不动、右腿向右 1.5m：宽度 +1.5 的同时中心右移 0.75
          const w0 = this.gateWidth * 2;
          root.scale.setScalar((w0 + 1.5) / lateral);
          const gd0 = this.#gateDir(prop.gate);
          prop.x += -gd0.dz * 0.75;
          prop.z += gd0.dx * 0.75;
        }
        root.updateMatrixWorld(true);
      }
      root.updateMatrixWorld(true);
      const fitted = this.#fitBoxOf(root);
      root.position.y -= fitted.min.y;
      root.updateMatrixWorld(true);

      const findNode = (re) => {
        let node = null;
        root.traverse((obj) => { if (!node && re.test(obj.name)) node = obj; });
        return node;
      };
      // 材质规范 + 顶点 AO：挂进场景前一次做完（几何/材质都是共享缓存，只算一次）
      root.traverse((obj) => {
        if (!obj.isMesh) return;
        for (const mat of (Array.isArray(obj.material) ? obj.material : [obj.material])) {
          normalizePropMaterial(mat);
        }
      });
      bakePropAO(root);

      const holder = new THREE.Group();
      holder.position.set(prop.x, prop.baseY, prop.z);
      holder.rotation.y = prop.dir + (prop.yaw || 0);
      holder.add(root);
      this.group.add(holder);
      prop.holder = holder;
      this.#buildPropContacts(prop, findNode);

      if (prop.kind === 'portal') {
        prop.runes = findNode(/rune/i);
        prop.runeBase = prop.runes ? prop.runes.rotation.z : 0;
      } else if (prop.kind === 'hammer') {
        prop.rotor = findNode(/rotor/i);
      } else if (prop.kind === 'whirl') {
        prop.spiral = findNode(/spiral/i);
        prop.rim = findNode(/rim/i);
        // 模型中央是一块近黑的圆盘，浮在水面上像一摊墨渍（远看非常出戏）。
        // 只保留白色螺旋与警示外圈，漩涡仍然一眼可辨，但不再有黑色斑块。
        const centre = findNode(/centre/i);
        if (centre) centre.visible = false;
      }
    }).catch((err) => console.warn(`course prop load failed: ${def.url}`, err));
  }

  /**
   * 道具的水面接触细节：脚下柔和暗部 + 循环扩散的涟漪。
   * 两层贴片每帧跟着 waveHeight 走（见 updateMechs），不会在水面起伏时浮空或被水面吃掉。
   */
  #buildPropContacts(prop, findNode) {
    // 水下地图的道具不铺水面贴片，否则会变成水下悬空的一块黑片
    if (prop.y < -0.5) return;
    const spots = [];
    if (prop.kind === 'flag') {
      // 立柱的实际位置直接从模型节点取，缩放后仍然准确
      for (const re of [/gate_post_L/i, /gate_post_R/i]) {
        const node = findNode(re);
        if (!node) continue;
        // 这里取到的已经是世界坐标（holder 已挂进场景），直接用它铺贴片；
        // 不能再套一遍 prop.x/prop.z 的局部→世界换算，否则贴片会跑到两倍坐标的远水面上。
        const wp = new THREE.Vector3();
        node.getWorldPosition(wp);
        const nb = new THREE.Box3().setFromObject(node);
        const footR = Math.max(0.7, Math.max(nb.max.x - nb.min.x, nb.max.z - nb.min.z) * 0.6);
        spots.push({ wx: wp.x, wz: wp.z, r: footR });
      }
    } else if (prop.kind === 'portal') {
      const half = prop.span * 0.42;
      const r = Math.max(1.2, prop.span * 0.07);
      spots.push({ lx: -half, lz: 0, r }, { lx: half, lz: 0, r });
    } else if (prop.kind === 'hammer') {
      // 漩涡盘面本身就是白色螺旋，底下再压暗会重新变成"水面黑斑"，所以不放
      spots.push({ lx: 0, lz: 0, r: Math.max(1.6, prop.span * 0.24) });
    }
    if (!spots.length) return;

    const cos = Math.cos(prop.dir);
    const sin = Math.sin(prop.dir);
    const contactGeo = new THREE.PlaneGeometry(1, 1);
    contactGeo.rotateX(-Math.PI / 2);
    const contacts = [];
    spots.forEach((spot, i) => {
      // 旗门立柱给的是世界坐标；其余机关给的是 holder 局部坐标，需绕 Y 转 prop.dir
      const wx = spot.wx ?? (prop.x + spot.lx * cos + spot.lz * sin);
      const wz = spot.wz ?? (prop.z - spot.lx * sin + spot.lz * cos);
      const shadow = new THREE.Mesh(contactGeo, getPropContactMaterial());
      shadow.scale.set(spot.r * 2.6, 1, spot.r * 2.6);
      shadow.position.set(wx, prop.y + 0.05, wz);
      shadow.renderOrder = 1;
      this.group.add(shadow);

      const ripple = new THREE.Mesh(contactGeo, new THREE.MeshBasicMaterial({
        map: getPropRippleTexture(),
        color: 0xd8f2ff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }));
      ripple.scale.set(spot.r * 2.3, 1, spot.r * 2.3);
      ripple.position.set(wx, prop.y + 0.06, wz);
      ripple.renderOrder = 2;
      this.group.add(ripple);

      contacts.push({
        x: wx,
        z: wz,
        base: spot.r * 2.3,
        phase: (prop.phase + i * 0.45) % 1,
        shadow,
        ripple,
      });
    });
    prop.contacts = contacts;
  }

  // ---------- 熔岩主题专属障碍（横向漂移浮桶 / 定时喷发泉） ----------

  /**
   * 熔岩图的两种"活"障碍：
   *  ① 横向漂移的火山浮桶：沿赛道法线来回扫，固定周期（各端同相位），
   *     逼玩家一边读浪一边选线；扫幅略大于走廊半宽 → 永远留得出一侧空隙。
   *  ② 定时喷发的熔岩泉：预警圈亮起 → 喷柱升起挡路，只有升起段才有碰撞体。
   *
   * 位置 / 相位全部写在 maps.js 里（确定性），不用 Math.random()，
   * 联机两端跑出来的障碍轨迹完全一致；碰撞登记仍走 updateMechs → applyMechs。
   */
  #buildMagmaHazards() {
    // 熔岩图用 magmaHazards，其它图（霓虹海峡）用通用 hazards：同一套漂移/喷发逻辑，
    // 视觉换成带贴图的 GLB 岩石（用户要求"不要几何体"）。
    const def = this.map.hazards || this.map.magmaHazards;
    this.magmaHazards = { drifters: [], geysers: [], rollers: [], impactRocks: [] };
    if (!def) return;
    const N = this.gates.length;
    const core = new THREE.Color(this.map.lava?.core ?? 0xffc24a);

    // ---- ① 横向漂移的火山浮桶 ----
    for (const spec of def.drifters || []) {
      const gi = ((Math.round(spec.gate) % N) + N) % N;
      // side 单位与 courseProps 一致（gateWidth/2）：不写就是压在航道中线上
      const pose = this.#routePose(gi, (spec.side ?? 0) * this.gateWidth * 0.5);
      const r = spec.r ?? 2.2;
      const group = new THREE.Group();
      // rock：用 Blender 出的带贴图岩石（横向直径归一化到 2r），不再堆圆柱几何体
      if (spec.visual === 'rock') {
        const url = MAGMA_OBSTACLE_GLB[spec.kind || 'shard'];
        const neutral = spec.kind === 'boulderA' || spec.kind === 'boulderB';
        if (url) {
          loadMarineModel(url).then((gltf) => {
            if (!this.group?.parent) return;
            const root = gltf.scene.clone(true);
            root.traverse((o) => {
              if (!o.isMesh) return;
              o.castShadow = false;
              o.receiveShadow = false;
              if (neutral) {
                // 中性岩石：贴图照原样用，不叠熔岩的自发光裂纹
                for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
                  if (!m) continue;
                  if (m.map) {
                    m.map.wrapS = THREE.RepeatWrapping;
                    m.map.wrapT = THREE.RepeatWrapping;
                    m.map.anisotropy = 4;
                    m.map.needsUpdate = true;
                  }
                  if (m.isMeshStandardMaterial) {
                    m.metalness = 0;
                    m.roughness = 0.9;
                    m.envMapIntensity = 0.9;
                  }
                }
              } else {
                tuneMagmaMat?.(o.material);
              }
            });
            const box = new THREE.Box3().setFromObject(root);
            const size = box.getSize(new THREE.Vector3());
            const lateral = Math.max(size.x, size.z) || 1;
            root.scale.setScalar((r * 2) / lateral);
            root.updateMatrixWorld(true);
            const fitted = new THREE.Box3().setFromObject(root);
            root.position.y -= fitted.min.y;
            group.add(root);
          }).catch(() => { /* 缺资源时仍有碰撞代理 */ });
        }
      }
      // lamp 提到 if 外面声明：rock 分支不走程序化几何体，但下面 push 时要带上这个字段
      let lamp = null;
      if (spec.visual !== 'rock') {
      const bodyMat = new THREE.MeshStandardMaterial({
        color: 0x241a18, roughness: 0.92, metalness: 0.35, flatShading: true,
        emissive: 0x2a0703, emissiveIntensity: 0.6,
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r, 2.6, 10), bodyMat);
      body.position.y = 1.1;
      group.add(body);
      const rimMat = new THREE.MeshStandardMaterial({
        color: 0x3c2a22, roughness: 0.6, metalness: 0.7, flatShading: true,
      });
      for (const y of [0.35, 2.15]) {
        const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.92, 0.16, 6, 12), rimMat);
        rim.rotation.x = Math.PI / 2;
        rim.position.y = y;
        group.add(rim);
      }
      // 熔岩裂缝：三条发光的竖条（bloom 抓得到，夜里才看得出"这是个活物"）
      const crackMat = new THREE.MeshBasicMaterial({
        color: core.clone().multiplyScalar(2.2), toneMapped: false,
      });
      for (let k = 0; k < 3; k++) {
        const crack = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.9, 0.12), crackMat);
        const a = (k / 3) * Math.PI * 2 + 0.4;
        crack.position.set(Math.cos(a) * r * 0.9, 1.1, Math.sin(a) * r * 0.9);
        crack.rotation.y = -a;
        group.add(crack);
      }
      lamp = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff5a24, toneMapped: false }),
      );
      lamp.position.y = 2.75;
      group.add(lamp);
      }
      group.position.set(pose.x, 0, pose.z);
      this.group.add(group);

      this.magmaHazards.drifters.push({
        gate: gi, x: pose.x, z: pose.z, nx: pose.nx, nz: pose.nz,
        // along：沿赛道方向来回（"前后移动"）；side（默认）：沿法线横扫（"左右移动"）
        axis: spec.axis === 'along' ? 'along' : 'side',
        dx: Math.sin(pose.dir), dz: Math.cos(pose.dir),
        span: (spec.span ?? 1.1) * this.gateWidth,
        period: spec.period ?? 6.5, phase: spec.phase ?? 0,
        r, group, lamp, off: 0,
        // 熔岩浮桶是"活的"会自转；海峡的巨石是块石头，转起来像陀螺（踩过）
        spin: spec.visual === 'rock' ? 0 : 1,
        // 石头坐在水里而不是浮在水面上，往下沉一点
        sink: spec.visual === 'rock' ? -0.3 : 0,
      });
    }

    // ---- ② 定时喷发的熔岩泉 ----
    for (const spec of def.geysers || []) {
      const gi = ((Math.round(spec.gate) % N) + N) % N;
      const side = (spec.side ?? 0) * this.gateWidth;
      const pose = this.#routePose(gi, side);
      const r = spec.r ?? 4.4;
      const group = new THREE.Group();
      const baseMat = new THREE.MeshStandardMaterial({
        color: 0x1d1210, roughness: 0.95, metalness: 0.1, flatShading: true,
        emissive: 0x2a0602, emissiveIntensity: 0.5,
      });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.15, r * 1.35, 0.9, 10), baseMat);
      base.position.y = 0.35;
      group.add(base);
      // 预警圈：喷发前亮起（红 → 白热）
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xff3a10, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.1, 0.28, 6, 20), ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.95;
      group.add(ring);
      // 喷柱：加法混合锥体，随 up01 从 0 长到满高（底边始终贴着泉眼）
      const colMat = new THREE.MeshBasicMaterial({
        color: core.clone().multiplyScalar(1.7), transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      });
      const column = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.55, r * 0.9, 13, 12, 1, true), colMat,
      );
      column.position.y = 6.5;
      column.visible = false;
      group.add(column);
      group.position.set(pose.x, 0, pose.z);
      this.group.add(group);

      this.magmaHazards.geysers.push({
        gate: gi, x: pose.x, z: pose.z, r,
        period: spec.period ?? 5.2, phase: spec.phase ?? 0,
        group, ring, ringMat, column, colMat, up01: 0,
      });
    }

    // ---- ③ 迎面滚来的火山巨岩 ----
    // 沿中心线在 base 上游 ±(speed*period/2) 之间往返滚动。位置只由 elapsed 决定，
    // 各端算出来完全一致（不需要同步消息）。
    const rockMatBase = new THREE.MeshStandardMaterial({
      color: 0x1a1113, roughness: 0.98, metalness: 0.05, flatShading: true,
      emissive: 0x3a0a02, emissiveIntensity: 0.75,
    });
    const rockCrackMat = new THREE.MeshBasicMaterial({
      color: core.clone().multiplyScalar(1.8), toneMapped: false,
    });
    for (const spec of def.rollers || []) {
      const gi = ((Math.round(spec.gate) % N) + N) % N;
      const pose = this.#routePose(gi, 0);
      const r = spec.r ?? 3.2;
      const group = new THREE.Group();
      const body = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), rockMatBase);
      body.position.y = r * 0.92;
      body.castShadow = false;
      group.add(body);
      // 熔岩裂纹：几片薄盒贴在岩面，随滚动一起转
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + 0.7;
        const band = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, 0.16, 0.22), rockCrackMat);
        band.position.set(Math.cos(a) * r * 0.62, r * 0.92 + (k % 2 ? 0.5 : -0.4), Math.sin(a) * r * 0.62);
        band.rotation.y = -a;
        group.add(band);
      }
      this.group.add(group);
      const runLen = Math.min(120, (spec.speed ?? 15) * (spec.period ?? 9) * 0.5);
      this.magmaHazards.rollers.push({
        gate: gi, baseX: pose.x, baseZ: pose.z, r,
        period: spec.period ?? 9, phase: spec.phase ?? 0,
        runLen, group, body, spin: 0,
      });
    }

    // ---- ④ 贴边的可撞碎火成岩 ----
    // 高速撞击 → 崩碎 + 一小段加速（"撞开一条路"的正反馈）；
    // 低速 → 当普通硬障碍。碎片/消失是本地表现，重生用固定 CD，避免长草期无风险。
    const IMPACT_RESPAWN = 6;
    for (const spec of def.impactRocks || []) {
      const gi = ((Math.round(spec.gate) % N) + N) % N;
      const side = (spec.side ?? 0.8) * this.gateWidth;
      const pose = this.#routePose(gi, side);
      const r = spec.r ?? 3.6;
      const group = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({
        color: 0x241a19, roughness: 0.96, metalness: 0.06, flatShading: true,
        emissive: 0x2f0a03, emissiveIntensity: 0.55,
      });
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2;
        const shard = new THREE.Mesh(new THREE.DodecahedronGeometry(r * (0.5 + (k % 2) * 0.18), 0), mat);
        shard.position.set(Math.cos(a) * r * 0.55, r * 0.42, Math.sin(a) * r * 0.55);
        shard.rotation.y = a * 1.7;
        group.add(shard);
      }
      const cap = new THREE.Mesh(new THREE.ConeGeometry(r * 0.5, r * 0.9, 6), rockMatBase);
      cap.position.y = r * 1.05;
      group.add(cap);
      group.position.set(pose.x, 0, pose.z);
      this.group.add(group);

      // 碎片（本地表现）：崩碎时把 6 块小石头弹出去
      const frags = new THREE.Group();
      frags.visible = false;
      const fragList = [];
      for (let k = 0; k < 6; k++) {
        const f = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 0.22, 0), mat);
        const a = (k / 6) * Math.PI * 2 + 0.3;
        fragList.push({ mesh: f, vx: Math.cos(a) * 7, vz: Math.sin(a) * 7, vy: 6 + (k % 3) * 2 });
        frags.add(f);
      }
      frags.position.copy(group.position);
      this.group.add(frags);

      // 撞碎后掉出来的奖励（一个发光道具核）：默认隐藏，撞碎时显形并浮起
      const loot = new THREE.Group();
      const orb = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.05, 0),
        new THREE.MeshBasicMaterial({ color: core.clone().multiplyScalar(1.8), toneMapped: false }),
      );
      orb.position.y = 1.5;
      loot.add(orb);
      const haloMat = new THREE.MeshBasicMaterial({
        color: 0xffe6a0, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      });
      const halo = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.12, 8, 22), haloMat);
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 1.5;
      loot.add(halo);
      loot.position.set(pose.x, 0, pose.z);
      loot.visible = false;
      this.group.add(loot);

      this.magmaHazards.impactRocks.push({
        gate: gi, x: pose.x, z: pose.z, r, group, frags, fragList,
        shatterT: 0, respawn: IMPACT_RESPAWN, hitCd: 0,
        loot, lootT: 0, orb, halo,
      });
    }
  }

  /**
   * 硬核档：Blender 出的静态岩石障碍（几何进 GLB，逻辑留 JS）。
   *
   * 摆位是纯数据（maps.js 的 magmaObstacles），碰撞用 JS 圆形代理写进
   * shoreColliders —— 不用 mesh collider，也不用每帧重建。代理带 bottomY/topY，
   * 所以 Boat 的腾空 3D sweep 一样会把它当实体撞，不会出现"飞过去穿模"。
   * heavy:true 走 Boat 的硬物回弹 + 侧翻分支，撞击手感和滚石一致。
   *
   * 视觉原型按横向直径归一化到 2r，贴底到水面；加载完成后把代理的 topY
   * 回写成模型真实高度，视觉与碰撞永远不会各说各话。
   */
  #buildMagmaObstacles() {
    const specs = this.map.magmaObstacles || [];
    this.magmaObstacles = [];
    if (!specs.length) return;
    const N = this.gates.length;
    for (const spec of specs) {
      const gi = ((Math.round(spec.gate) % N) + N) % N;
      // side 单位与 courseProps 的 deco 一致：gateWidth/2
      const side = (spec.side ?? 0.72) * this.gateWidth * 0.5;
      const pose = this.#routePose(gi, side);
      const r = spec.r ?? 2.4;
      const y = this.#visualHeightAt(pose.x, pose.z);
      const proxy = {
        type: 'magmaObstacle', x: pose.x, z: pose.z, r,
        bottomY: y - 0.5, topY: y + 8, heavy: true,
      };
      this.shoreColliders.push(proxy);
      const item = {
        gate: gi, kind: spec.kind || 'pillar', x: pose.x, z: pose.z,
        y, r, span: r * 2, dir: pose.dir, yaw: spec.yaw || 0,
        holder: null, proxy,
      };
      this.magmaObstacles.push(item);
      const url = MAGMA_OBSTACLE_GLB[item.kind];
      if (!url) continue;
      loadMarineModel(url).then((gltf) => {
        if (!this.group.parent) return;
        const root = gltf.scene.clone(true);
        // 贴图是 3.4m 一张的无缝平铺图，三个原型共用一套材质。
        // 想避免 9 块石头露出同一块花纹，就在实例级平移 UV（几何只有 ~300 顶点，
        // 克隆一份比克隆贴图便宜得多，材质仍然共享 → draw call 不变）。
        const ox = Math.random() * 0.83;
        const oy = Math.random() * 0.61;
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = false;   // 顶棚式投影会把整块岩面压黑
          o.receiveShadow = false;
          o.frustumCulled = true;
          tuneMagmaMat(o.material);
          if (o.geometry?.attributes?.uv) {
            const g = o.geometry.clone();
            const uv = g.attributes.uv;
            for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + ox, uv.getY(i) + oy);
            uv.needsUpdate = true;
            o.geometry = g;
          }
        });
        const box0 = new THREE.Box3().setFromObject(root);
        const size0 = box0.getSize(new THREE.Vector3());
        const lateral = Math.max(size0.x, size0.z) || 1;
        root.scale.setScalar(item.span / lateral);
        root.updateMatrixWorld(true);
        const fitted = new THREE.Box3().setFromObject(root);
        root.position.y -= fitted.min.y;   // 原点落在落地面中心
        item.proxy.topY = item.y + (fitted.max.y - fitted.min.y);
        const holder = new THREE.Group();
        holder.name = 'magma_obstacle_' + item.kind;
        holder.position.set(item.x, item.y, item.z);
        holder.rotation.y = item.dir + item.yaw;
        holder.add(root);
        this.group.add(holder);
        item.holder = holder;
      }).catch(() => { /* 离线/缺资源时仍有碰撞代理，不会变成空气障碍 */ });
    }
  }

  /**
   * 断层火山带：在指定门之后的赛段中间开一道**真实裂谷**。
   *
   * 关键变化（第二轮）：不再往水面上盖一块黑贴片，而是由 Water 用水面遮罩把这块
   * 水面 `discard` 掉（真挖洞），这里再建出岩壁 + 熔岩底 + 熔岩瀑布。
   * 追尾机位能直接看到 14m 的纵深，而不是"贴纸"。
   * 矩形几何与 Water 的遮罩共用 `faultRects()`，不会错位。
   */
  #buildFaults() {
    this.faults = faultRects(this.map);
    this.faultWaterfalls = [];
    if (!this.faults.length) return;
    const core = new THREE.Color(this.map.lava?.core ?? 0xffc24a);
    const DEPTH = 14;
    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x140b0a, roughness: 1, metalness: 0, flatShading: true,
      emissive: 0x240502, emissiveIntensity: 0.45,
      side: THREE.DoubleSide,
    });
    const floorTex = this.#faultTexture();
    floorTex.wrapS = THREE.RepeatWrapping;
    floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(3, 1.4);
    const floorMat = new THREE.MeshBasicMaterial({ map: floorTex, toneMapped: true, side: THREE.DoubleSide });
    const fallTex = this.#lavaFallTexture();

    for (const f of this.faults) {
      const { cx, cz, width, halfAcross: HW } = f;
      const yaw = Math.atan2(f.fx, f.fz);
      const group = new THREE.Group();
      group.position.set(cx, 0, cz);
      group.rotation.y = yaw;

      // ---- 四面岩壁（朝内）----
      const wallGeoW = new THREE.PlaneGeometry(HW * 2, DEPTH);
      const wallGeoD = new THREE.PlaneGeometry(width, DEPTH);
      const up = new THREE.Mesh(wallGeoW, wallMat);
      up.position.set(0, -DEPTH / 2, -width / 2);
      group.add(up);
      const down = new THREE.Mesh(wallGeoW, wallMat);
      down.position.set(0, -DEPTH / 2, width / 2);
      down.rotation.y = Math.PI;
      group.add(down);
      for (const s of [-1, 1]) {
        const side = new THREE.Mesh(wallGeoD, wallMat);
        side.position.set(s * HW, -DEPTH / 2, 0);
        side.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
        group.add(side);
      }

      // ---- 熔岩底 ----
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, width), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -DEPTH + 0.12;
      group.add(floor);

      // ---- 迎面那道熔岩瀑布（挂在远端岩壁内侧，俯冲时正对着看）----
      // 只铺中间一条 + 一个更亮的内芯：铺满整面墙会变成一块橙色幕布，读不出纵深。
      const fallMat = new THREE.MeshBasicMaterial({
        map: fallTex, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      });
      const fall = new THREE.Mesh(new THREE.PlaneGeometry(HW * 0.9, DEPTH * 0.86), fallMat);
      fall.position.set(0, -DEPTH * 0.45, width / 2 - 0.18);
      fall.rotation.y = Math.PI;
      group.add(fall);
      const fallCoreMat = new THREE.MeshBasicMaterial({
        map: fallTex, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      });
      const fallCore = new THREE.Mesh(new THREE.PlaneGeometry(HW * 0.34, DEPTH * 0.8), fallCoreMat);
      fallCore.position.set(0, -DEPTH * 0.42, width / 2 - 0.12);
      fallCore.rotation.y = Math.PI;
      group.add(fallCore);
      this.faultWaterfalls.push(fallMat);
      this.faultWaterfalls.push(fallCoreMat);

      // ---- 谷底熔岩池的亮边：远看至少有一条橙线，才知道底下有多深 ----
      const poolMat = new THREE.MeshBasicMaterial({
        color: core.clone().multiplyScalar(1.1), transparent: true, opacity: 0.7,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        side: THREE.DoubleSide,
      });
      const poolGlow = new THREE.Mesh(new THREE.PlaneGeometry(HW * 1.9, 2.4), poolMat);
      poolGlow.position.set(0, -DEPTH + 1.1, width / 2 - 0.22);
      poolGlow.rotation.y = Math.PI;
      group.add(poolGlow);

      // ---- 断崖岩唇：上游侧一道石台，水面到这里就断 ----
      const lipMat = new THREE.MeshStandardMaterial({
        color: 0x1a1110, roughness: 0.97, metalness: 0.04, flatShading: true,
        emissive: 0x160502, emissiveIntensity: 0.35,
      });
      const lip = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 1.2, 0.9, 1.4), lipMat);
      lip.position.set(0, -0.4, -width / 2 - 0.55);
      group.add(lip);

      // ---- 唇口泡沫：一条加法混合的白亮线，提示"这里断开了" ----
      const foamMat = new THREE.MeshBasicMaterial({
        color: 0x9fe6ff, transparent: true, opacity: 0.65,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      });
      const foam = new THREE.Mesh(new THREE.PlaneGeometry(HW * 1.9, 0.9), foamMat);
      foam.rotation.x = -Math.PI / 2;
      foam.position.set(0, 0.1, -width / 2 - 0.05);
      group.add(foam);

      this.group.add(group);
    }

    // ---- 熔岩喷泉弹跳板（每道裂谷前一块）----
    // 作用：给"速度门槛"之外的第二条过法 —— 慢船也能被喷泉顶起来飞过去。
    // 位置直接由裂谷矩形反推（而非门号），改裂谷宽度时不会错位。
    this.jumpPads = [];
    const jp = this.map.magmaHazards?.jumpPads;
    if (jp && this.faults.length) {
      const cfg = typeof jp === 'object' ? jp : {};
      const before = cfg.before ?? 16;
      const coreC = new THREE.Color(this.map.lava?.core ?? 0xffc24a);
      for (const f of this.faults) {
        const px = f.cx - f.fx * (f.width * 0.5 + before);
        const pz = f.cz - f.fz * (f.width * 0.5 + before);
        const r = cfg.r ?? 5.2;
        const yaw = Math.atan2(f.fx, f.fz);
        const g = new THREE.Group();
        g.position.set(px, 0, pz);
        g.rotation.y = yaw;

        const ringMat = new THREE.MeshBasicMaterial({
          color: coreC.clone().multiplyScalar(1.5), transparent: true, opacity: 0.85,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        });
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.92, 0.3, 8, 26), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.12;
        g.add(ring);
        // 三条向上的箭头（读作"从这里飞出去"）
        const arrowMat = new THREE.MeshBasicMaterial({
          color: 0xffd27a, transparent: true, opacity: 0.9,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
        });
        for (let k = 0; k < 3; k++) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, 0.16, 0.34), arrowMat);
          bar.position.set(0, 0.16 + k * 0.28, -0.4 + k * 0.4);
          bar.rotation.x = -0.45;
          g.add(bar);
        }
        // 池心：暗色水面 + 一圈亮芯
        const pool = new THREE.Mesh(
          new THREE.CircleGeometry(r * 0.8, 20),
          new THREE.MeshBasicMaterial({
            color: coreC.clone().multiplyScalar(0.55), transparent: true, opacity: 0.55,
            blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
          }),
        );
        pool.rotation.x = -Math.PI / 2;
        pool.position.y = 0.06;
        g.add(pool);
        this.group.add(g);

        this.jumpPads.push({
          x: px, z: pz, r, dir: yaw,
          vy: cfg.vy ?? 9, speed: cfg.speed ?? 20,
          ringMat, pulse: 0,
        });
      }
    }
  }

  /** 熔岩瀑布贴图：竖向流线 + 顶部亮、底部散（纵向滚动 UV 做成"往下泻"） */
  #lavaFallTexture() {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 26; i++) {
      const x = (i * 37) % 64;
      const w = 1.5 + (i % 3);
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      const hot = i % 4 === 0 ? '255,220,140' : '255,120,40';
      g.addColorStop(0, `rgba(${hot},0.95)`);
      g.addColorStop(0.55, `rgba(${hot},0.55)`);
      g.addColorStop(1, 'rgba(255,60,10,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, w, 256);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /** 裂谷底贴图：黑岩底 + 熔岩裂纹（floor 用） */
  #faultTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#0b0406');
    g.addColorStop(0.5, '#080305');
    g.addColorStop(1, '#0b0406');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    // 底部熔岩微光（中间一条更亮）
    const glow = ctx.createLinearGradient(0, 128, 0, 40);
    glow.addColorStop(0, 'rgba(255,120,30,0.55)');
    glow.addColorStop(0.5, 'rgba(255,60,10,0.16)');
    glow.addColorStop(1, 'rgba(255,40,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 128, 128);
    // 纵向裂纹
    ctx.strokeStyle = 'rgba(255,150,60,0.5)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 9; i++) {
      const x = 8 + i * 14 + ((i * 37) % 9);
      ctx.beginPath();
      ctx.moveTo(x, 10);
      ctx.lineTo(x + ((i % 3) - 1) * 7, 118);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** 船是否正处在某道裂谷的范围内（由 Game 决定起跳还是坠落） */
  faultAt(pos) {
    return faultAtRect(pos, this.faults);
  }

  // ---------- 潮汐水域：把水流画出来 ----------

  /**
   * 潮汐水域的可视化：水面流动条纹 + 会翻面的潮流标。
   * 物理推流在 Game.#applyCurrent 里，这里只负责"让玩家看懂水往哪边走"，
   * 两边共用 tidalFactor 的同一个相位，所以看到的流向和实际受力永远一致。
   */
  #buildTideCurrent(mapDef) {
    const cur = mapDef.current;
    this.tide = cur;
    this.tideMarkers = [];
    this.tideMarkHolders = [];
    const flowYaw = Math.atan2(cur.dir[0], cur.dir[1]);

    // ① 流动条纹：沿潮流方向铺开的长条带，平潮时几乎静止
    const tex = getTideTexture();
    this.tideTex = tex;
    this.tideMat = new THREE.MeshBasicMaterial({
      map: tex,
      color: 0xd8f2ff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const strips = 9;
    for (let i = 0; i < strips; i++) {
      const ang = (i / strips) * Math.PI * 2 + 0.4;
      const dist = cur.r * (0.34 + 0.46 * (((i * 5) % 7) / 6));
      const geo = new THREE.PlaneGeometry(34, 96);
      geo.rotateX(Math.PI / 2); // 摊平后纹理 +V 指向 +Z
      const strip = new THREE.Mesh(geo, this.tideMat);
      strip.position.set(cur.x + Math.cos(ang) * dist, 0.16, cur.z + Math.sin(ang) * dist);
      strip.rotation.y = flowYaw;
      strip.renderOrder = 2;
      this.group.add(strip);
    }

    // ② 潮流标：浮筒 + 指示箭头，潮流翻面时整体转向
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x22384a, roughness: 0.7, metalness: 0.2, flatShading: true,
    });
    const arrowMat = new THREE.MeshStandardMaterial({
      color: 0x35e8ff, emissive: 0x1a7f96, emissiveIntensity: 0.9, roughness: 0.4, flatShading: true,
    });
    [11, 13, 15].forEach((gi, k) => {
      const pose = this.#routePose(gi, (k % 2 === 0 ? 1 : -1) * this.gateWidth * 0.85);
      const g = new THREE.Group();
      const holder = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 1.2, 10), baseMat);
      base.position.y = 0.1;
      holder.add(base);
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.95, 2.6, 4), arrowMat);
      arrow.rotation.x = Math.PI / 2;
      arrow.position.set(0, 1.05, 1.7);
      holder.add(arrow);
      g.add(holder);
      g.position.set(pose.x, 0, pose.z);
      g.rotation.y = flowYaw;
      g.userData.baseYaw = flowYaw;
      this.group.add(g);
      this.tideMarkers.push(g);
      this.tideMarkHolders.push(holder);
    });
    // 换成带贴图的木质潮流标（浮筒 + 箭头），加载失败继续用程序化浮筒
    loadPropGlb(FLOW_MARKER_URL).then((gltf) => {
      for (const holder of this.tideMarkHolders) {
        for (const child of holder.children) {
          if (child.isMesh) child.geometry?.dispose();
        }
        holder.clear();
        holder.add(fitPropModel(gltf.scene.clone(true), {
          span: 2.6, maxH: 3.4, center: false,
        }));
      }
    }).catch((err) => {
      console.warn('[track] 潮流标模型加载失败，保留程序化浮筒', err);
    });
  }

  #buildBuoyFallback(pose) {
    const group = new THREE.Group();
    // 模型加载前的临时占位：奶白桶身 + 橙色反光带 + 深灰灯罩，
    // 不再用高饱和红色自发光几何体（远处看像一块突兀的红方块）。
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf1eee2, roughness: 0.62, metalness: 0.04 });
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xff9f1a, roughness: 0.45, metalness: 0.06 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x33414a, roughness: 0.4, metalness: 0.35 });
    const holders = [];
    for (const lateral of [-2.95, 0, 2.95]) {
      const marker = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.92, 1.7, 12), bodyMat);
      body.position.y = 0.85;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.78, 0.32, 12), bandMat);
      band.position.y = 1.3;
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.56, 0.34, 12), lampMat);
      neck.position.y = 1.87;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8), lampMat);
      lamp.position.y = 2.14;
      marker.add(body, band, neck, lamp);
      marker.position.set(pose.nx * lateral, 0, pose.nz * lateral);
      group.add(marker);
      holders.push(marker);
    }
    group.position.set(pose.x, 0, pose.z);
    this.group.add(group);
    // Blender 浮标（红漆 + 锈迹 + 白反光带 + 灯罩）。加载成功后替换临时占位；
    // 彻底加载失败时奶白占位仍保留，浮标不会消失。
    loadPropGlb(BUOY_FALLBACK_URL).then((gltf) => {
      for (const holder of holders) {
        for (const child of holder.children) child.geometry?.dispose?.();
        holder.clear();
        holder.add(fitPropModel(gltf.scene.clone(true), {
          span: 1.9, maxH: 3.2, center: false,
        }));
      }
      bodyMat.dispose();
      bandMat.dispose();
      lampMat.dispose();
    }).catch((err) => {
      console.warn('[track] 浮标模型加载失败，保留程序化浮标', err);
    });
    return group;
  }

  #marineHit(boat, collider, speedScale = 0.62) {
    const dx = boat.pos.x - collider.x;
    const dz = boat.pos.z - collider.z;
    const d = Math.hypot(dx, dz);
    const minD = collider.r + 1.25;
    if (d >= minD) return false;
    const nx = d > 0.001 ? dx / d : Math.sin(boat.heading || 1);
    const nz = d > 0.001 ? dz / d : Math.cos(boat.heading || 1);
    boat.pos.x += nx * (minD - d);
    boat.pos.z += nz * (minD - d);
    const dot = boat.vel.x * nx + boat.vel.y * nz;
    if (dot < 0) { boat.vel.x -= 1.35 * dot * nx; boat.vel.y -= 1.35 * dot * nz; }
    boat.vel.multiplyScalar(speedScale);
    boat.stunTimer = Math.max(boat.stunTimer, 0.28);
    boat.cancelDriftForCollision?.();
    return true;
  }

  updateMechs(dt, t) {
    this.mechColliders.length = 0;
    // 回程堤岸的动态障碍：位置是 elapsed 的纯函数，碰撞点与视觉同帧回写
    // dt 用来推进机器人骨骼动画（mixer），位置仍由 t 决定，主机/客机一致
    this.#updateBakedHazards(t, dt);
    for (const buoy of this.marine?.buoys || []) {
      const bob = Math.sin(t * 1.8 + buoy.bobPhase) * 0.16;
      if (buoy.fallback) {
        buoy.fallback.position.y = bob;
        buoy.fallback.rotation.z = Math.sin(t * 1.25 + buoy.bobPhase) * 0.045;
      }
      // The three buoy bodies form a readable, dodgeable diagonal hazard.
      for (const lateral of [-2.95, 0, 2.95]) {
        this.mechColliders.push({
          type: 'buoy', x: buoy.x + buoy.nx * lateral, z: buoy.z + buoy.nz * lateral, r: 0.7,
        });
      }
    }
    // 熔岩障碍：漂移浮桶 + 喷发泉。与其它机关共用同一条 elapsed 时间轴，
    // 因此各端（主机/客机）看到的障碍位置与碰撞窗口完全一致。
    const mh = this.magmaHazards;
    if (mh) {
      for (const d of mh.drifters) {
        const cyc = ((t / d.period + d.phase) % 1 + 1) % 1;
        // 三角波：贴边停一下再扫回来，比纯正弦更有"障碍在等你犯错"的节奏
        const tri = 1 - Math.abs(cyc * 2 - 1);
        const off = (tri * 2 - 1) * d.span;
        d.off = off;
        const px = d.axis === 'along' ? d.x + d.dx * off : d.x + d.nx * off;
        const pz = d.axis === 'along' ? d.z + d.dz * off : d.z + d.nz * off;
        // 上一帧位置：Boat 的扫掠碰撞用「船位移 - 障碍位移」求相对轨迹，
        // 否则高速迎面撞上正在横扫的浮桶会连人带桶一起漏判。
        const lastX = d.lastX ?? px;
        const lastZ = d.lastZ ?? pz;
        d.lastX = px;
        d.lastZ = pz;
        d.group.position.set(
          px,
          (d.sink || 0) + Math.sin(t * 1.7 + d.phase * 6.28) * 0.14,
          pz,
        );
        // 石块不转（转起来像陀螺），熔岩浮桶保持原来的自转
        if (d.spin) d.group.rotation.y = t * 0.6 + d.phase * 6.28;
        // bottomY/topY 是"实体"的高度范围：Boat 的腾空分支只结算带高度范围的
        // collider。缺了这对字段，大浪/裂谷起跳时船会直接从浮桶和滚石里穿过去
        // （用户反馈的"前后移动石头能飞过去穿模"）。写了之后空中 3D sweep 会真正
        // 把船推到障碍外，飞得够高才能合法越过。
        this.mechColliders.push({
          type: 'magmaDrifter', x: px, z: pz, r: d.r,
          bottomY: -0.3, topY: 3.2, px: lastX, pz: lastZ,
        });
      }
      for (const g of mh.geysers) {
        const c = ((t / g.period + g.phase) % 1 + 1) % 1;
        // 0~0.55 静默 → 0.55~0.72 预警 → 0.72~0.86 喷发 → 0.86~1 回落
        let up = 0;
        let warn = 0;
        if (c < 0.55) {
          up = 0; warn = 0;
        } else if (c < 0.72) {
          warn = (c - 0.55) / 0.17; up = 0;
        } else if (c < 0.86) {
          const k = (c - 0.72) / 0.14; up = k; warn = 1 - k;
        } else {
          up = 1 - (c - 0.86) / 0.14; warn = 0;
        }
        g.up01 = up;
        g.column.visible = up > 0.02;
        const grow = Math.max(0.02, up);
        g.column.scale.set(0.6 + up * 0.4, grow, 0.6 + up * 0.4);
        g.column.position.y = 0.9 + 6.5 * grow;
        g.colMat.opacity = 0.72 * Math.min(1, up * 1.6);
        g.ringMat.opacity = 0.12 + warn * 0.78;
        g.ringMat.color.setRGB(1, 0.22 + warn * 0.58, 0.04 + warn * 0.52);
        // 碰撞窗口必须与视觉严格同步：column.visible 是 up > 0.02，旧版却等到
        // up > 0.35 才生成碰撞体 —— 玩家会看到岩浆柱已经窜起来，却直接开过去
        // （"这个移动物体没有碰撞"）。topY 用 grow（柱体真实缩放）而不是 up，
        // 回落段才不会留下一段"看得见但撞不到"的虚高柱。
        if (up > 0.02) {
          this.mechColliders.push({
            type: 'magmaGeyser', x: g.x, z: g.z, r: g.r * 0.8,
            bottomY: 0, topY: 0.9 + 13 * grow,
          });
        }
      }
      // 滚石：沿中心线在基准点上游往返（纯时间函数，各端一致）
      for (const b of mh.rollers) {
        const c = ((t / b.period + b.phase) % 1 + 1) % 1;
        const u = 0.5 - 0.5 * Math.cos(c * Math.PI * 2);   // 0→1→0 平滑往返
        const adv = this.#routeAdvance(b.baseX, b.baseZ, -b.runLen * u);
        // 被撞后的"晃动"：沿撞击法线让开一点再弹回，读作质量感
        if (b.shoveT > 0) b.shoveT -= dt;
        const shoveK = b.shoveT > 0 ? Math.sin((b.shoveT / 0.5) * Math.PI) * 0.9 : 0;
        // b.x/b.z 此刻还是上一帧的落点，先存下来给扫掠碰撞做相对运动用
        const lastX = b.x ?? adv.x;
        const lastZ = b.z ?? adv.z;
        b.x = adv.x + (b.shoveX || 0) * shoveK;
        b.z = adv.z + (b.shoveZ || 0) * shoveK;
        b.group.position.set(b.x, 0, b.z);
        b.spin += dt * 2.4;
        b.body.rotation.x = b.spin;
        b.body.rotation.z = b.spin * 0.6;
        // heavy：由 Boat 走"法向回弹 + 侧翻 + 甩头"的硬物撞击分支
        this.mechColliders.push({ type: 'magmaRoller', x: b.x, z: b.z, r: b.r, heavy: true, ref: b, bottomY: -0.4, topY: b.r * 2.0, px: lastX, pz: lastZ });
      }
      // 可撞碎岩：崩碎期间不产生碰撞；碎片飞散后按 CD 重生
      for (const rock of mh.impactRocks) {
        if (rock.hitCd > 0) rock.hitCd -= dt;
        // 奖励核：浮起来转 + 倒计时
        if (rock.lootT > 0) {
          rock.lootT -= dt;
          if (rock.lootT <= 0) {
            rock.loot.visible = false;
            rock.lootT = 0;
          } else if (rock.loot.visible) {
            rock.orb.rotation.y = t * 2.2;
            rock.orb.position.y = 1.5 + Math.sin(t * 2.4) * 0.22;
            rock.halo.rotation.z = t * 1.4;
            rock.halo.scale.setScalar(1 + Math.sin(t * 3) * 0.06);
          }
        }
        if (rock.shatterT > 0) {
          rock.shatterT -= dt;
          const k = Math.min(1, (rock.respawn - rock.shatterT) / 0.7);
          if (k < 1) {
            for (const f of rock.fragList) {
              const tt = (rock.respawn - rock.shatterT);
              f.mesh.position.set(f.vx * tt, f.vy * tt - 9 * tt * tt, f.vz * tt);
              f.mesh.rotation.x += dt * 6;
              f.mesh.rotation.z += dt * 4;
            }
          }
          if (rock.shatterT <= 0) {
            rock.shatterT = 0;
            rock.group.visible = true;
            rock.frags.visible = false;
          }
        } else {
          this.mechColliders.push({ type: 'magmaImpact', x: rock.x, z: rock.z, r: rock.r, heavy: true, ref: rock, bottomY: -0.4, topY: rock.r * 1.7 });
        }
      }
    }
    // 断层：喷泉弹跳板呼吸 + 熔岩瀑布往下泻
    if (this.jumpPads && this.jumpPads.length) {
      for (const p of this.jumpPads) {
        if (p.pulse > 0) p.pulse = Math.max(0, p.pulse - dt * 2.2);
        p.ringMat.opacity = 0.55 + 0.28 * Math.sin(t * 3.2) + p.pulse * 0.15;
      }
    }
    if (this.faultWaterfalls && this.faultWaterfalls.length) {
      for (const m of this.faultWaterfalls) {
        if (m.map) m.map.offset.y = (m.map.offset.y + dt * 0.55) % 1;
      }
    }
    for (const platform of this.marine?.platforms || []) {
      if (platform.visual) platform.visual.position.y = (platform.y || 0) + 0.05 + 0.05 * Math.sin(t * 2.2 + platform.x * 0.3);
    }
    if (this.palaceGate) {
      const p = this.palaceGate;
      const c = ((t / p.period + p.phase) % 1 + 1) % 1;
      // A smooth lift cycle leaves a readable closed window before the gate rises again.
      const open01 = 0.5 + 0.5 * Math.sin(c * Math.PI * 2 - Math.PI * 0.5);
      p.open01 = open01;
      p.leaf.position.y = -1.6 + open01 * p.travel;
      // 程序化栏杆靠自发光读"闸门在动"；换成贴图模型后不要再改自发光，否则会曝白
      if (!p.leaf.userData.isModel) {
        p.leaf.children.forEach((child) => {
          if (child.isMesh) child.material.emissiveIntensity = 0.55 + open01 * 0.9;
        });
      }
      if (open01 < 0.58) {
        const count = 17;
        for (let i = 0; i < count; i++) {
          const lateral = (i / (count - 1) - 0.5) * this.gateWidth * 2;
          this.mechColliders.push({
            x: p.x + p.nx * lateral,
            z: p.z + p.nz * lateral,
            r: 1.85,
          });
        }
      }
    }
    // 加速带：箭头向前流动 + 呼吸亮度
    if (this.padTex) {
      this.padTex.offset.y = (this.padTex.offset.y - dt * 1.4) % 1;
      this.padMat.opacity = 0.55 + 0.2 * Math.sin(t * 4);
    }
    // 近道：金色箭头流动 + 拱门呼吸 + 顶标旋转
    if (this.scTex) {
      this.scTex.offset.y = (this.scTex.offset.y - dt * 1.8) % 1;
      this.scMat.opacity = 0.55 + 0.25 * Math.sin(t * 5);
      for (const m of this.scArchMats) {
        m.emissiveIntensity = 0.8 + 0.5 * Math.sin(t * 3);
      }
      for (const sc of this.shortcuts) {
        if (sc.gem) {
          sc.gem.rotation.y = t * 2;
          sc.gem.position.y = 7.6 + Math.sin(t * 2.5) * 0.3;
        }
      }
    }
    // 金龙过山车：鎏金呼吸 + 弹射坡箭头流动
    if (this.coasterMats) {
      this.coasterMats[0].emissiveIntensity = 0.7 + 0.4 * Math.sin(t * 2.4);
      this.coasterMats[1].emissiveIntensity = 0.8 + 0.5 * Math.sin(t * 2.4 + 1.2);
    }
    if (this.coasterGlowMats) {
      // 套件材质（金/红）跟着主脊一起呼吸，避免拼贴感
      for (let i = 0; i < this.coasterGlowMats.length; i++) {
        this.coasterGlowMats[i].emissiveIntensity = 0.45 + 0.30 * Math.sin(t * 2.4 + (i % 2) * 1.2);
      }
    }
    if (this.coasterRampTex) {
      this.coasterRampTex.offset.y = (this.coasterRampTex.offset.y - dt * 2.2) % 1;
    }
    // 霓虹能量护栏：光纹沿赛道方向流动
    if (this.neonTex) {
      this.neonTex.offset.x = (this.neonTex.offset.x - dt * 0.6) % 1;
    }
    if (this.shortcutNeonTex) {
      this.shortcutNeonTex.offset.x = (this.shortcutNeonTex.offset.x - dt * 0.34) % 1;
      this.shortcutNeonMat.opacity = 0.25 + 0.08 * Math.sin(t * 3.1);
    }
    // 管道外壁蓝色粒子：沿管长流动 + 呼吸明暗
    if (this.tunnelParticles) {
      this.#updateTunnelParticles(dt);
      this.tunnelParticles.mat.opacity = 0.7 + 0.2 * Math.sin(t * 2.4);
    }
    // 潮汐：条纹沿流向滚动（平潮时几乎静止），潮流标跟着翻面
    if (this.tide && this.tideMat) {
      const f = tidalFactor(t, this.tide.period);
      this.tideTex.offset.y = (this.tideTex.offset.y - dt * 0.5 * f) % 1;
      this.tideMat.opacity = 0.32 + 0.3 * Math.abs(f);
      const flip = f < 0 ? Math.PI : 0;
      for (const m of this.tideMarkers) {
        const target = m.userData.baseYaw + flip;
        m.rotation.y += (target - m.rotation.y) * Math.min(1, dt * 6);
      }
    }
    // 赛道道具：传送门符文自转 + 呼吸、旋转锤抡臂、漩涡盘旋转速、旗门轻微起伏
    for (const prop of this.courseProps) {
      if (!prop.holder) continue;
      if (prop.kind === 'portal') {
        prop.holder.scale.setScalar(1 + Math.sin(t * 2.6 + prop.phase * 6.283) * 0.035);
        if (prop.runes) prop.runes.rotation.z = prop.runeBase + t * 0.7;
      } else if (prop.kind === 'hammer') {
        const ang = t * prop.spinSpeed + prop.phase * 6.283;
        prop.angle = ang;
        if (prop.rotor) prop.rotor.rotation.y = ang;
        // 底座是实心浮筒，必须有碰撞；否则玩家会直接穿过锤子立柱
        this.mechColliders.push({ x: prop.x, z: prop.z, r: prop.hubRadius });
        // 抡臂末端两个横扫碰撞点：位置和视觉同步，慢动作也追得上。
        // px/pz 是上一帧（角速度 × dt 反推）的位置，让扫掠碰撞按相对轨迹算，
        // 抡臂高速扫过慢船时也不会"从船里穿过去"。
        const prevAng = ang - prop.spinSpeed * dt;
        for (const s of [0, Math.PI]) {
          this.mechColliders.push({
            type: 'hammer',
            x: prop.x + Math.sin(ang + s) * prop.armRadius,
            z: prop.z + Math.cos(ang + s) * prop.armRadius,
            px: prop.x + Math.sin(prevAng + s) * prop.armRadius,
            pz: prop.z + Math.cos(prevAng + s) * prop.armRadius,
            r: prop.hitRadius,
          });
        }
      } else if (prop.kind === 'whirl') {
        prop.spinAngle += dt * 1.6;
        if (prop.spiral) prop.spiral.rotation.y = prop.spinAngle;
        if (prop.rim) prop.rim.rotation.y = -prop.spinAngle * 0.45;
        prop.holder.position.y = prop.baseY + Math.sin(t * 1.7 + prop.phase * 6.283) * 0.06;
      } else {
        prop.holder.position.y = prop.baseY + Math.sin(t * 1.3 + prop.phase * 6.283) * 0.05;
      }
      // 水面接触：暗部贴住水面、涟漪一圈圈散开
      if (prop.contacts) {
        for (const c of prop.contacts) {
          const surf = prop.y + waveHeight(c.x, c.z, t) + 0.04;
          c.shadow.position.y = surf;
          const f = ((t * 0.4 + c.phase) % 1 + 1) % 1;
          const s = 0.9 + f * 1.25;
          c.ripple.position.y = surf + 0.01;
          c.ripple.scale.set(c.base * s, 1, c.base * s);
          c.ripple.material.opacity = (1 - f) * (1 - f) * 0.34;
        }
      }
    }

    // 熔岩图：所有实体机关都必须能被腾空船的 3D sweep 撞到。
    // Boat 的 airborne 分支只结算带 bottomY/topY 的 collider，而浮标 / 旋转锤
    // 底座 / 抡臂历来不带这对字段 —— 于是大浪抛飞、裂谷起跳时能从这些
    // "正在移动的物体"里直接穿过去（用户反馈的加速穿模）。这里统一补高度，
    // 其它地图保持原样：它们的机关腾空免疫是刻意设计，见 applyMechs 注释。
    // 3.4m 是"飞得够高就能合法越过"的分界，和浮桶/滚石的高度档一致。
    if (this.map.lava) {
      for (const c of this.mechColliders) {
        if (!Number.isFinite(c.bottomY)) c.bottomY = -0.4;
        if (!Number.isFinite(c.topY)) c.topY = 3.4;
      }
    }
  }

  /** 对本地权威艇应用机关效果（加速带触发 + 伸缩柱碰撞） */
  /**
   * 腾空时撞到熔岩实体障碍：Boat 的 airborne 分支已经按 bottomY/topY 做了
   * 3D sweep 把船推出障碍（真正的"不能再穿模"），这里补一层速度惩罚/硬直，
   * 否则玩家会觉得"明明撞上了却一点反馈都没有"。
   * 只认 magma* 类型，其它地图的机关（浮标/伸缩柱/涡旋）保持原来的腾空免疫。
   */
  #airborneMagmaHit(boat) {
    // 静态岩石代理写在 shoreColliders（每帧不重建），动态机关在 mechColliders；
    // 两边都要结算，否则腾空撞上 Blender 岩石只有位置修正、没有任何减速反馈。
    // 只在熔岩图带上 shoreColliders：其它图的 shoreColliders 有上千个（石堤段），
    // 没必要每帧白扫一遍。
    const mechs = this.mechColliders;
    const shores = this.map.lava ? this.shoreColliders : null;
    const solids = mechs.length + (shores ? shores.length : 0);
    for (let i = 0; i < solids; i++) {
      const c = i < mechs.length ? mechs[i] : shores[i - mechs.length];
      if (typeof c.type !== 'string' || !c.type.startsWith('magma')) continue;
      // Boat 的空中 sweep 把船推到 r+1.3，留 0.3 容差让这一帧仍能吃到反馈
      if (Math.hypot(boat.pos.x - c.x, boat.pos.z - c.z) > c.r + 1.6) continue;
      const scale = c.type === 'magmaGeyser' ? 0.5
        : c.type === 'magmaRoller' ? 0.55 : 0.68;
      boat.vel.multiplyScalar(scale);
      boat.speed *= scale;
      boat.stunTimer = Math.max(boat.stunTimer, c.type === 'magmaGeyser' ? 0.6 : 0.4);
      boat.cancelDriftForCollision?.();
      break;
    }
  }

  applyMechs(boat, dt) {
    // 加速带
    if (boat.padCooldown > 0) {
      boat.padCooldown -= dt;
    } else {
      for (const pad of this.pads) {
        const dx = boat.pos.x - pad.x;
        const dz = boat.pos.z - pad.z;
        const fx = Math.sin(pad.dir);
        const fz = Math.cos(pad.dir);
        const along = dx * fx + dz * fz;
        const side = dx * fz - dz * fx;
        if (Math.abs(along) < pad.halfL && Math.abs(side) < pad.halfW) {
          boat.boostTimer = Math.max(boat.boostTimer, 2.6);
          boat.padCooldown = 3;
          break;
        }
      }
    }
    if (boat.marineBoostCooldown > 0) boat.marineBoostCooldown -= dt;
    else {
      for (const lane of this.marine?.boosts || []) {
        const dx = boat.pos.x - lane.x;
        const dz = boat.pos.z - lane.z;
        const along = dx * lane.fx + dz * lane.fz;
        const side = dx * lane.fz - dz * lane.fx;
        if (Math.abs(along) < lane.halfAlong && Math.abs(side) < lane.halfSide) {
          boat.boostTimer = Math.max(boat.boostTimer, 3.15);
          boat.marineBoostCooldown = 3.2;
          break;
        }
      }
    }
    // 传送门：从门里穿过去就送一段强氮气（和加速带共用 boostTimer，冷却独立）
    if (!Number.isFinite(boat.portalCooldown)) boat.portalCooldown = 0;
    if (boat.portalCooldown > 0) {
      boat.portalCooldown -= dt;
    } else {
      for (const prop of this.courseProps) {
        if (prop.kind !== 'portal') continue;
        if (Math.abs(boat.pos.y - prop.y) > 6) continue;
        if (Math.hypot(boat.pos.x - prop.x, boat.pos.z - prop.z) > prop.triggerR) continue;
        boat.boostTimer = Math.max(boat.boostTimer, 3.2);
        boat.portalCooldown = 4;
        if (boat.isLocal) audio.play('speed_portal');
        break;
      }
    }
    if (boat.launchCooldown > 0) boat.launchCooldown -= dt;
    else if (!boat.airborne && !boat.onCoaster) {
      // 接触即弹：不看速度/朝向/开合动画，船身碰到碰撞盒立刻弹射。
      // 弹射速度/竖直初速用构建时解算的 launchSpeed/launchVy（与 #simLaunchArc
      // 的组距解算一致），保证理想弹道必落在下一组并排弹射器上。
      for (const platform of this.marine?.platforms || []) {
        if (Math.abs(boat.pos.y - (platform.y || 0)) > 2.6) continue; // 高度分层：水下链不误吸水面船
        const dx = boat.pos.x - platform.x;
        const dz = boat.pos.z - platform.z;
        const along = dx * platform.fx + dz * platform.fz;
        const side = dx * platform.fz - dz * platform.fx;
        if (Math.abs(along) < platform.halfAlong && Math.abs(side) < platform.halfSide) {
          boat.airborne = true;
          boat.airTime = 0;
          boat.pos.y = (platform.y || 0) + 0.65;
          boat.vy = platform.launchVy ?? 13;
          // 水下链：落点回下一组的水下深度（出水花后继续下潜）；末组/水面链落水面
          boat.underwaterLandingY = platform.nextY != null && platform.nextY < -1 ? platform.nextY : null;
          boat.surfaceSplashed = false;
          boat.speed = platform.launchSpeed ?? boat.def.maxSpeed * 1.2;
          boat.heading = platform.dir;
          boat.vel.x = platform.fx * boat.speed;
          boat.vel.y = platform.fz * boat.speed;
          boat.boostTimer = Math.max(boat.boostTimer, 1.8);
          boat.launchCooldown = 0.45; // 只防同组重复触发；滞空 1-2s 落到下一组时早已冷却
          if (boat.isLocal) audio.play('launcher_launch');
          break;
        }
      }
    }
    // 漩涡：向心吸力 + 切向带动 + 掉速。空中/过山车不受影响。
    if (!boat.airborne && !boat.onCoaster) {
      for (const prop of this.courseProps) {
        if (prop.kind !== 'whirl') continue;
        const dx = boat.pos.x - prop.x;
        const dz = boat.pos.z - prop.z;
        const dist = Math.hypot(dx, dz);
        if (dist > prop.radius || dist < 0.001) continue;
        const k = 1 - dist / prop.radius; // 0 边缘 → 1 中心
        const ux = dx / dist;
        const uz = dz / dist;
        const pull = 13 * k * dt;
        const swirl = 7 * k * dt;
        // vel.y 是世界 z 方向速度（见 Boat 物理），别和纵向速度搞混
        boat.vel.x += -ux * pull - uz * swirl;
        boat.vel.y += -uz * pull + ux * swirl;
        if (boat.boostTimer <= 0) boat.vel.multiplyScalar(1 - 0.55 * k * dt);
      }
    }
    // 熔岩喷泉弹跳板：裂谷前的"第二条过法"（慢船被顶起来也能飞过去）
    if (this.jumpPads && this.jumpPads.length && !boat.airborne && !boat.onCoaster) {
      if (boat.faultPadCd > 0) boat.faultPadCd -= dt;
      else {
        for (const p of this.jumpPads) {
          if (Math.hypot(boat.pos.x - p.x, boat.pos.z - p.z) > p.r) continue;
          boat.airborne = true;
          boat.waveJump = true;
          boat.airTime = 0;
          boat.vy = Math.max(boat.vy || 0, p.vy);
          boat.speed = Math.max(boat.speed, p.speed);
          boat.vel.x = Math.sin(boat.heading) * boat.speed;
          boat.vel.y = Math.cos(boat.heading) * boat.speed;
          boat.faultGrace = 1.9;      // 起跳后跨过裂谷不再触发坠落
          boat.faultPadCd = 1.4;
          boat.boostTimer = Math.max(boat.boostTimer, 1.0);
          p.pulse = 1;
          if (boat.isLocal) audio.play('wave_launch');
          break;
        }
      }
    }
    // 撞碎岩掉落的奖励：本地艇靠近就收（道具赛由 Game 发一件随机道具）
    if (boat.isLocal && this.magmaHazards?.impactRocks?.length) {
      for (const rock of this.magmaHazards.impactRocks) {
        const loot = rock.loot;
        if (!loot || !loot.visible) continue;
        if (Math.hypot(boat.pos.x - loot.position.x, boat.pos.z - loot.position.z) > 3.4) continue;
        loot.visible = false;
        rock.lootT = 0;
        this.onItemDrop?.(boat.id);
      }
    }
    // 升起中的伸缩柱：硬碰撞（推出 + 大幅损速 + 短暂失控）
    // 过山车整段免疫；普通腾空只对熔岩实体障碍结算（见 #airborneMagmaHit），
    // 加速带/漩涡/传送门/弹射器/撞碎岩仍保持腾空免疫。
    if (boat.onCoaster) return;
    if (boat.airborne) {
      this.#airborneMagmaHit(boat);
      return;
    }
    for (const c of this.mechColliders) {
      if (c.type === 'buoy') {
        this.#marineHit(boat, c, 0.68);
        continue;
      }
      // 漂移浮桶：硬障碍，撞上明显掉速但不至于原地停死
      if (c.type === 'magmaDrifter') {
        this.#marineHit(boat, c, 0.58);
        continue;
      }
      // 喷发泉：最狠的一档，撞上大幅损速 + 更长失控（预警圈给了躲避窗口）
      // ⚠️ 减速/失控必须写在 #marineHit 的返回值里：它内部已经做了距离判定，
      // 无条件 stun 会让全图每一帧都给船挂失控（"按方向键没反应"）。
      if (c.type === 'magmaGeyser') {
        if (this.#marineHit(boat, c, 0.4)) boat.stunTimer = Math.max(boat.stunTimer, 0.6);
        continue;
      }
      // 滚石：质量大，撞上掉速更狠
      if (c.type === 'magmaRoller') {
        if (this.#marineHit(boat, c, 0.45)) boat.stunTimer = Math.max(boat.stunTimer, 0.5);
        continue;
      }
      // 可撞碎岩：高速撞开（碎片炸开 + 一小段加速），低速当普通硬障碍
      if (c.type === 'magmaImpact') {
        const rock = c.ref;
        if (!rock || rock.shatterT > 0 || rock.hitCd > 0) continue;
        const dx = boat.pos.x - c.x;
        const dz = boat.pos.z - c.z;
        if (Math.hypot(dx, dz) >= c.r + 1.6) continue;
        // 用撞击瞬间的法向速度判定"高速撞碎"：回弹之后 boat.speed 已经掉了
        const ramSpeed = Math.max(boat.speed, boat.heavyImpactSpeed || 0);
        if (ramSpeed >= 14) {
          rock.shatterT = rock.respawn;
          rock.hitCd = rock.respawn + 1.5;
          rock.group.visible = false;
          rock.frags.visible = true;
          for (const f of rock.fragList) f.mesh.position.set(0, 0, 0);
          boat.boostTimer = Math.max(boat.boostTimer, 0.9);
          boat.vel.multiplyScalar(0.9);
          boat.stunTimer = Math.max(boat.stunTimer, 0.12);
          boat.cancelDriftForCollision?.();
          // 掉一个奖励核（9s 内可捡；道具赛里由 Game 发随机道具）
          if (rock.loot) {
            rock.loot.visible = true;
            rock.lootT = 9;
          }
        } else {
          this.#marineHit(boat, c, 0.5);
        }
        continue;
      }
      const dx = boat.pos.x - c.x;
      const dz = boat.pos.z - c.z;
      const dist = Math.hypot(dx, dz);
      const minD = c.r + 1.3;
      if (dist < minD) {
        const nx = dist > 0.001 ? dx / dist : Math.sin(boat.heading || 1);
        const nz = dist > 0.001 ? dz / dist : Math.cos(boat.heading || 1);
        boat.pos.x += nx * (minD - dist);
        boat.pos.z += nz * (minD - dist);
        const dot = boat.vel.x * nx + boat.vel.y * nz;
        if (dot < 0) {
          boat.vel.x -= 1.4 * dot * nx;
          boat.vel.y -= 1.4 * dot * nz;
        }
        boat.vel.multiplyScalar(0.55);
        boat.stunTimer = Math.max(boat.stunTimer, 0.45);
        boat.cancelDriftForCollision?.();
      }
    }
    // 烘焙赛道的静态障碍（蘑菇/树）：圆碰撞 + 推出 + 正常反弹
    if (this.bakedObstacles.length) {
      for (const c of this.bakedObstacles) {
        const dx = boat.pos.x - c.x;
        const dz = boat.pos.z - c.z;
        if (Math.abs(dx) > 14 || Math.abs(dz) > 14) continue;
        if (Math.abs((boat.pos.y || 0) - c.y) > 6) continue;   // 不同高度层不算碰
        const dist = Math.hypot(dx, dz);
        // 2026-11-19：原来的 c.r + 1.35 是「模型半径 + 一圈偏大的空气垫」，玩家反馈
        // 还没碰到蘑菇模型就被挡住。余量收到船体半宽量级；树干/树冠体积大，多留一点。
        const minD = c.r + (c.kind === 'tree' ? 0.95 : 0.55);
        if (dist < minD) {
          const nx = dist > 0.001 ? dx / dist : Math.sin(boat.heading || 1);
          const nz = dist > 0.001 ? dz / dist : Math.cos(boat.heading || 1);
          boat.pos.x += nx * (minD - dist);
          boat.pos.z += nz * (minD - dist);
          // 反射拆成法向 + 切向：法向按 0.55 的恢复系数弹开（有明确反弹角），
          // 切向保留 0.92（擦边不会被硬刹停）。原来的 1.5×dot 再整体 ×0.62
          // 等于把反弹吃掉，手感是「撞进泥里」。
          const vn = boat.vel.x * nx + boat.vel.y * nz;
          if (vn < 0) {
            const tx = boat.vel.x - vn * nx;
            const tz = boat.vel.y - vn * nz;
            boat.vel.x = tx * 0.92 - vn * 0.55 * nx;
            boat.vel.y = tz * 0.92 - vn * 0.55 * nz;
          }
          boat.stunTimer = Math.max(boat.stunTimer, 0.25);
          boat.cancelDriftForCollision?.();
        }
      }
    }
  }

  /** 高亮下一个目标门 */
  updateVisual(nextGateIndex, t) {
    // 起点线贴浪放在 openTrack 早退之前：烘焙赛道同样要它的起点线浮在浪面之上，
    // 之前这个更新被早退挡掉，烘焙图的起点线（连同微浮动）根本没跑过。
    this.#updateStartLine(t);
    if (this.openTrack) {
      if (this.caveGlow) this.caveGlow.material.uniforms.uTime.value = t;
      if (this.fallSplash) this.fallSplash.material.uniforms.uTime.value = t;
      return;   // 烘焙赛道没有门柱/浮标，全部门相关更新跳过
    }
    this.#updateEdgeBuoys(t);
  }

  /**
   * 起终点线判定：以 0 号门那条横线为准，而不是一个小圆。
   * 横向范围至少覆盖地图的 startWidth（与旗门两腿、方格线同宽），
   * 柱子外不会再有"看着是赛道、过线却不计圈"的缝隙。
   */
  startLineHalfWidth() {
    // 取"起点线全宽"和"旧判定宽度（gateWidth*2）"中的较大值再留 2m 余量：
    // 格子线/旗门两端之外没有漏判缝隙，同时任何地图都不会比改版前更窄。
    return Math.max(this.startWidth * 0.5, this.gateWidth * 2) + 2;
  }

  onStartLine(pos) {
    const [gx, gz] = this.gates[0];
    const { dx, dz } = this.#gateDir(0);
    const rx = pos.x - gx;
    const rz = pos.z - gz;
    const along = rx * dx + rz * dz;            // 沿赛道方向（压线深度）
    const lateral = Math.abs(rx * -dz + rz * dx); // 横向离中线距离
    return Math.abs(along) <= Math.max(3.6, this.gateWidth * 0.6)
      && lateral <= this.startLineHalfWidth();
  }

  /**
   * 判定是否通过下一个门
   * 支持近道跳门：艇在近道走廊内且当前门处于跳过区间时，到达出口门附近即视为连续通过
   * @returns {boolean} true = 通过
   */
  checkGate(pos, gateIndex) {
    if (this.palaceGate && gateIndex === this.palaceGate.gate && this.palaceGate.open01 < 0.58) {
      return false;
    }
    const N = this.gates.length;
    // 起点/终点线：用整条横线判定；漏过最后一门但确实压过终点线时，
    // 也算完成本圈（终点线本身才是最终判定）。
    if (gateIndex === 0 || gateIndex === N - 1) {
      if (this.onStartLine(pos)) return true;
    }
    const [gx, gz] = this.gates[gateIndex];
    const d = Math.hypot(pos.x - gx, pos.z - gz);
    if (d < this.gateWidth * 1.35) return true;
    for (const sc of this.shortcuts) {
      const skip = (sc.to - sc.from + N) % N;
      const rel = (gateIndex - sc.from + N) % N;
      if (rel < 1 || rel > skip) continue;
      // 当前门在近道跳过区间内：靠近出口门 + 在近道走廊内 → 视为通过
      const [tx, tz] = this.gates[sc.to];
      if (Math.hypot(pos.x - tx, pos.z - tz) < this.gateWidth * 1.35) {
        const loc = nearestOnPolyline(sc.points, pos.x, pos.z);
        if (loc.d < sc.width * 1.6) return true;
      }
    }
    return false;
  }

  /**
   * 艇在该位置应处的高度（y）。水面正常航行时返回 null（贴水面浮沉）。
   * - 立交桥：给出门索引时按桥面插值（同一 x,z 有上下两层，只能靠进度区分）
   * - 潜行区：端部 22% 平滑斜坡下潜/上浮；靠近水面近道走廊时不潜水
   */
  diveHeightAt(pos, gateHint = null, deckState = null) {
    // 烘焙赛道：高度直接由 gateY 沿中心线插值（云端 63m / 瀑布 55m 落差全靠它）
    if (this.openTrack) return this.#bakedHeightAt(pos, gateHint);
    if (this.overpass) {
      // 逐艇状态在 cross 处用来认层；门号暂时缺失时也别立刻归零
      if (gateHint != null || (deckState && deckState.i >= 0)) {
        const deckY = this.#deckHeightAt(pos, gateHint, deckState);
        if (deckY > 0.02) return deckY;
      }
    } else if (gateHint != null && this.gateHeights) {
      const h = this.#gateHeightAt(pos);
      if (h > 0.02) return h;
    }
    if (!this.dives.length) return null;
    let bestDive = null; // { d, y }
    for (const d of this.dives) {
      const loc = nearestOnPolyline(d.points, pos.x, pos.z);
      if (loc.d > this.gateWidth * 0.95) continue;
      const ramp = Math.min(1, Math.min(loc.u, 1 - loc.u) / 0.22);
      const s = ramp * ramp * (3 - 2 * ramp);
      if (!bestDive || loc.d < bestDive.distance) {
        bestDive = { distance: loc.d, y: d.depth * s, dive: d };
      }
    }
    if (!bestDive) return null;
    // 水面近道优先：更靠近近道走廊 → 不潜水
    for (const sc of this.shortcuts) {
      const loc = nearestOnPolyline(sc.points, pos.x, pos.z);
      if (loc.d <= bestDive.distance) return null;
    }
    return bestDive.y;
  }

  /** 近道内是否位于走廊中（供进度换算/判定用） */
  #shortcutLoc(pos, gateIndex) {
    const N = this.gates.length;
    for (const sc of this.shortcuts) {
      const skip = (sc.to - sc.from + N) % N;
      const rel = (gateIndex - sc.from + N) % N;
      if (rel < 1 || rel > skip) continue;
      const loc = nearestOnPolyline(sc.points, pos.x, pos.z);
      // 端点之外不算在近道内（进度换算交回主赛道投影，避免误吸主道艇）
      const beyondStart = loc.seg === 0 && loc.t <= 0.001;
      const beyondEnd = loc.seg === sc.points.length - 2 && loc.t >= 0.999;
      if (beyondStart || beyondEnd) continue;
      if (loc.d < sc.width * 1.5) return { sc, skip, loc };
    }
    return null;
  }

  /**
   * R 复位锚点（近道内）：返回 { x, z, heading }，不在近道走廊里返回 null。
   * 玩家在近道里按 R 时，沿近道中线就地放回、朝近道前进方向；
   * 没有这个的话只能退回"上一个主赛道门" —— 近道白跑，还经常被扔到反向，
   * 正是"明明在近道却复位到主赛道"的原因。
   *
   * @deprecated 现在统一走 respawnPoint()（按地点后退固定距离，近道内同样沿近道退）。
   *   这个"原地放回"的版本会在原地反复撞墙，保留只为兼容外部旧调用，别再新增使用。
   */
  shortcutRespawnAnchor(pos, gateIndex) {
    const inSc = this.#shortcutLoc(pos, gateIndex);
    if (!inSc) return null;
    const { sc, loc } = inSc;
    const pts = sc.points;
    const seg = Math.min(Math.max(0, loc.seg), pts.length - 2);
    const a = pts[seg];
    const b = pts[seg + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (!Number.isFinite(len) || len < 0.001) return null;
    return { x: loc.px, z: loc.pz, heading: Math.atan2(dx, dz) };
  }

  /**
   * 通用复位点（R 键 / 掉出赛道 / 掉断层共用）：**按地点**往回退 back 米。
   *
   * 以前的规则是"回到最后一个已穿过的门"。门间距 50~90m，等于一次 R 白送半条直道，
   * 玩家反馈"复位到之前很远的距离"就是这个原因。
   *
   * 现在改成沿赛道中线后退固定距离：
   * - 主道：沿门折线（首尾闭合）后退 back 米，朝向沿用该段的前进方向；
   * - 近道：沿近道自己的折线后退，**不会**把玩家拽回主道；
   *   近道本身比 back 还短时，退到近道起点为止（不额外罚到主道上）；
   * - 主道：只在本船该在的门段附近找最近点，叠层赛道不会串到另一层。
   *
   * 不返回门的索引：调用方保持 pm.gate 不变，复位既不吞门也不提前送门。
   */
  respawnPoint(pos, gateIndex, back = RESPAWN_BACK) {
    const N = this.gates.length;
    if (N < 2) return null;
    const loop = [...this.gates, this.gates[0]];

    // 1) 近道内：沿近道退
    const inSc = this.#shortcutLoc(pos, gateIndex);
    if (inSc) {
      const { sc, loc } = inSc;
      const s = loc.u * loc.total - back;
      if (s > 0.5) {
        const p = pointAtArc(sc.points, s);
        if (p) return { ...p, onShortcut: true };
      }
      // 近道比 back 还短（霓虹海峡 A 道只有 52m）：就地退到**近道起点**。
      // 以前这里是"回主道再从入口往后退 back"，结果人被打回主道上 35m 外，
      // 明明只在近道里走了 20 多米，却白罚了 50 多米。
      const pStart = pointAtArc(sc.points, 0);
      if (pStart) return { ...pStart, onShortcut: true };
    }

    // 2) 主道：沿门折线退（夹在 0 上，不跨越起点线，否则会被判成"刚完赛"）
    //    只在本船"该在的那几段"里找最近点：立交桥 / 瀑布上下段的 2D 最近点
    //    可能落在另一层，全局搜就会把人穿过桥面丢下去。
    let loc;
    if (Number.isFinite(gateIndex) && N > 4) {
      const gi = ((Math.round(gateIndex) % N) + N) % N;
      const j = (gi - 1 + N) % N;                         // 通向 gateIndex 的那一段
      const win = [(j - 1 + N) % N, j, (j + 1) % N];
      loc = nearestOnPolyline(loop, pos.x, pos.z, win);
      // 限窗内离得离谱（掉出赛道很远 / 门号不可信）：退回全段搜
      if (!Number.isFinite(loc.d) || loc.d > 150) loc = nearestOnPolyline(loop, pos.x, pos.z);
    } else {
      loc = nearestOnPolyline(loop, pos.x, pos.z);
    }
    const s = Math.max(0, loc.u * loc.total - back);
    const p = pointAtArc(loop, s);
    return p ? { ...p, onShortcut: false } : null;
  }

  /**
   * AI 近道决策：返回近道上的前瞻目标点（无则 null 走正常门）
   * 决策结果缓存在 boat.scCommit，直到走出近道区间自动解除
   */
  aiShortcutTarget(gateIndex, pos, boat) {
    if (!this.shortcuts.length) return null;
    const N = this.gates.length;
    // 已承诺走近道：沿折线找前方目标点
    for (const sc of this.shortcuts) {
      if (boat.scCommit !== sc) continue;
      const skip = (sc.to - sc.from + N) % N;
      const rel = (gateIndex - sc.from + N) % N;
      if (rel > skip || rel === 0) { boat.scCommit = null; break; } // 已出近道区间
      const loc = nearestOnPolyline(sc.points, pos.x, pos.z);
      const idx = Math.min(loc.seg + 1, sc.points.length - 1);
      return { x: sc.points[idx][0], z: sc.points[idx][1] };
    }
    // 入口决策：刚过入口门（rel=1）且离入口不远，按概率抄近道
    for (const sc of this.shortcuts) {
      const rel = (gateIndex - sc.from + N) % N;
      if (rel !== 1 || boat.scCommit || (boat.aiScCd || 0) > 0) continue;
      const [ex, ez] = sc.points[1];
      if (Math.hypot(pos.x - ex, pos.z - ez) < 50 && Math.random() < 0.65) {
        boat.scCommit = sc;
        const loc = nearestOnPolyline(sc.points, pos.x, pos.z);
        const idx = Math.min(loc.seg + 1, sc.points.length - 1);
        return { x: sc.points[idx][0], z: sc.points[idx][1] };
      }
    }
    return null;
  }

  /** 连续进度（用于名次/进度条）：0..laps；近道内按折线比例平滑换算 */
  progress(gateIndex, lap, pos) {
    const N = this.gates.length;
    const inSc = this.#shortcutLoc(pos, gateIndex);
    if (inSc) {
      return (lap - 1) * N + inSc.sc.from + inSc.loc.u * inSc.skip;
    }
    const [gx, gz] = this.gates[gateIndex];
    const [px, pz] = this.gates[(gateIndex - 1 + N) % N];
    // 在上一门->当前门线段上的投影比例
    const segX = gx - px;
    const segZ = gz - pz;
    const segLen = Math.hypot(segX, segZ) || 1;
    const proj = ((pos.x - px) * segX + (pos.z - pz) * segZ) / (segLen * segLen);
    const frac = Math.max(0, Math.min(1, proj));
    return (lap - 1) * N + (gateIndex - 1) + frac;
  }

  /**
   * 进度总量的**唯一来源**：`圈数 × 一圈弧长`。
   *
   * ⚠ 分母的圈数必须由调用方传**本局实际圈数**（Game 的 `this.laps`，来自开局消息），
   * 不能回落到地图作者配置的 `this.laps`。两者会不一致：单人设置里圈数下拉可把
   * 霓虹海峡（作者配 1 圈、跑完就完赛）改成 3 圈，而地图配置仍是 1 ——
   * 旧版分母用 1 圈，跑完一圈进度条就 100%（用户实测反馈）。
   *
   * @param {number} [laps] 本局圈数；不传才回落到地图默认值
   */
  totalProgressUnits(laps) {
    const n = Math.max(1, Math.round(Number(laps) || 0) || this.laps || 1);
    return (this.arcTotal || 1) * n;
  }

  /**
   * 进度比例 0..1：**完成圈数 + 本圈弧长比例，再除以总圈数**。
   *
   * 3 圈图：跑完 1 圈 = 33%，1.5 圈 = 50%，最后一圈压线 = 100%。
   * 旧版把"整条赛道一次跑完"（1 圈 = 100%）当分母，是用户反馈的第 1 号 bug。
   *
   * `lapArc` 是**本圈起点的弧长**（发车格 / 上一次压线的位置）。为什么必须有：
   * 发车格在起点线后方 4m，按绝对弧长算等于"上一圈的 99%"，进度条一开局就
   * 显示 99%（3 圈图显示 33%）然后过线瞬间掉回 0；压线那一帧同理。
   * 减去本圈起点弧长后，两个场景都从 0 平滑起算。
   *
   * @param {number} lap 当前圈（从 1 起；过线后 +1）
   * @param {{x:number,z:number}} pos 船位置
   * @param {number} laps 本局总圈数
   * @param {number} [lapArc] 本圈起点弧长（默认 0 = 从起点线算）
   */
  progressRatio(lap, pos, laps, lapArc = 0) {
    const arcTotal = this.arcTotal || 1;
    const n = Math.max(1, Math.round(Number(laps) || 0) || this.laps || 1);
    const done = Math.max(0, (Math.max(1, Math.round(Number(lap) || 1)) - 1));
    const arc = Math.max(0, Math.min(arcTotal, this.arcAt(pos.x, pos.z).s || 0));
    // 本圈已跑弧长 = 当前弧长 - 本圈起点弧长。
    // 差值按"跨越圈首尾取短边"折回 ±半圈：发车格在起点线后方，
    // 只要船往后漂 1cm 就会跨过弧长原点，直接取模会把 -0.01 变成 0.999，
    // 进度条瞬间从 0% 跳到 99%（实测峡谷图开局就踩到这个坑）。
    // 折回之后负数一律夹成 0：还没真正开始跑本圈就是 0%。
    const base = Math.max(0, Math.min(arcTotal, Number(lapArc) || 0));
    // 只往"前进方向"折：差值小于 -半圈 = 这一圈从圈尾跨过弧长原点，补一圈回来；
    // 正的差值不做折叠 —— 跑到本圈 70%、99% 都是正常的，折了就成了 0%。
    let d = arc - base;
    if (d < -arcTotal / 2) d += arcTotal;
    const lapFrac = Math.max(0, Math.min(1, d / arcTotal));
    // 已完成圈数最多算到 n（完赛后不再超过 100%）
    const ratio = (Math.min(done, n) + (done >= n ? 0 : lapFrac)) / n;
    return Math.max(0, Math.min(1, ratio));
  }

  /** 逆行检测 */
  isWrongWay(pos, heading, gateIndex) {
    // 抄近道时船头背离主道下一门，不判逆行
    if (this.#shortcutLoc(pos, gateIndex)) return false;
    const [gx, gz] = this.gates[gateIndex];
    const toGateX = gx - pos.x;
    const toGateZ = gz - pos.z;
    const dist = Math.hypot(toGateX, toGateZ) || 1;
    // 门口附近方向本身没有意义：急 Z 弯 / 发卡弯就是在门边打方向的，
    // 站在门口用"指向门心的向量"判断必然误报。
    if (dist < this.gateWidth * 2.2) return false;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    return (fx * toGateX + fz * toGateZ) / dist < -0.3;
  }

  /** 计算发车位：按实际参赛数均匀落在起点线内分点上 */
  spawnTransform(playerIndex, playerCount = 4) {
    const N = this.gates.length;
    const g0 = this.gates[0];
    // 开环赛道（烘焙）：最后一点在尽头，不能用它当前一点，取起点反向外推
    const prev = this.openTrack
      ? [2 * g0[0] - this.gates[1][0], 2 * g0[1] - this.gates[1][1]]
      : this.gates[N - 1];
    // 起点线后方方向
    let bx = prev[0] - g0[0];
    let bz = prev[1] - g0[1];
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl; bz /= bl;
    const { dx, dz } = this.#gateDir(0);
    const nx = -dz;
    const nz = dx;
    // Use 1/(n+1), 2/(n+1), ... interior points: 3 boats land at quarters,
    // 2 boats at thirds, and every field remains centered on the gate.
    const count = Math.max(1, Math.floor(playerCount) || 1);
    const fraction = (playerIndex + 1) / (count + 1);
    // Use the available gate width so online lobbies do not stack boats on
    // the same two narrow lanes. Positions remain symmetric around center.
    const laneSpan = Math.max(12.6, Math.min(this.gateWidth * 1.7, 40));
    const formationLateral = (fraction - 0.5) * laneSpan;
    const soloLateral = count === 1 ? (this.map.soloStartLateral || 0) : 0;
    const lateral = formationLateral + soloLateral;
    // 出生点紧贴起点线正后方 3m（旧值 12m：canyon 的 gate23→gate0→gate1 急弯下
    // 出生点偏到弯道侧壁、夹在两根门柱之间，玩家开局看不清行进方向）。
    // 开环赛道（烘焙）以前要往前挪 16m：因为洞里没顶、镜头一退就退到洞外看见海。
    // 2026-11-16 洞口石拱补好之后（#buildStartTunnel 从 0 号门往回铺 24m），
    // 发车格可以老老实实摆回**起点线正后方 4m** —— 玩家看着格子线冲出去，
    // 不会再出现"起点线在船屁股后面"。
    if (this.openTrack) {
      const back = 4;
      const spawnX = g0[0] - dx * back + nx * lateral;
      const spawnZ = g0[1] - dz * back + nz * lateral;
      const heading = Math.atan2(dx, dz);
      return { x: spawnX, z: spawnZ, heading, gate: 0, lap: 0 };
    }
    return {
      x: g0[0] + bx * 3 + nx * lateral,
      z: g0[1] + bz * 3 + nz * lateral,
      heading: Math.atan2(dx, dz),
    };
  }

  keepAfterFinishLine(boat) {
    const g = this.gates[0];
    const n = this.gates[1];
    const dx = n[0] - g[0];
    const dz = n[1] - g[1];
    const len = Math.hypot(dx, dz) || 1;
    const along = (boat.pos.x - g[0]) * (dx / len) + (boat.pos.z - g[1]) * (dz / len);
    if (along < 2) {
      boat.pos.x += (2 - along) * (dx / len);
      boat.pos.z += (2 - along) * (dz / len);
      const normalSpeed = boat.vel.x * (dx / len) + boat.vel.y * (dz / len);
      if (normalSpeed < 0) {
        boat.vel.x -= normalSpeed * (dx / len);
        boat.vel.y -= normalSpeed * (dz / len);
      }
    }
  }

  /**
   * 沿主赛道中线从 (x, z) 往前推进 dist 米（弧长），返回落点 { x, z, fx, fz }。
   * 道具投放用：直线投掷在弯道会把道具甩到护栏外，必须沿赛道弧线投。
   * 以船的目标门号为中心做局部投影，回头弯/自交段也不会选到另一段赛道。
   */
  routeAhead(x, z, gateIndex, dist) {
    const N = this.gates.length;
    const seed = gateIndex == null
      ? null
      : (((gateIndex - 1) % N) + N) % N;
    let bi = 0, bt = 0, bd = Infinity;
    const consider = (i) => {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      const sx = b[0] - a[0];
      const sz = b[1] - a[1];
      const len2 = sx * sx + sz * sz || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (z - a[1]) * sz) / len2));
      const d = Math.hypot(x - (a[0] + sx * t), z - (a[1] + sz * t));
      if (d < bd) { bd = d; bi = i; bt = t; }
    };
    if (seed == null) {
      for (let i = 0; i < N; i++) consider(i);
    } else {
      for (let k = -2; k <= 2; k++) consider((((seed + k) % N) + N) % N);
    }
    const cum = [0];
    for (let i = 0; i < N; i++) {
      const a = this.gates[i];
      const b = this.gates[(i + 1) % N];
      cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cum[N] || 1;
    const s = (((cum[bi] + (cum[bi + 1] - cum[bi]) * bt + dist) % total) + total) % total;
    let i = 0;
    while (i < N - 1 && cum[i + 1] < s) i++;
    const a = this.gates[i];
    const b = this.gates[(i + 1) % N];
    const segLen = cum[i + 1] - cum[i] || 1;
    const t = (s - cum[i]) / segLen;
    return {
      x: a[0] + (b[0] - a[0]) * t,
      z: a[1] + (b[1] - a[1]) * t,
      fx: (b[0] - a[0]) / segLen,
      fz: (b[1] - a[1]) / segLen,
    };
  }

  /** 最近航点（R键重生用） */
  nearestGate(pos) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.gates.length; i++) {
      const d = Math.hypot(pos.x - this.gates[i][0], pos.z - this.gates[i][1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  gatePos(i) {
    return this.gates[i];
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        obj.material.dispose();
      }
    });
  }
}
