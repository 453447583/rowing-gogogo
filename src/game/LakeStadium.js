/**
 * 湖泊环线（lake）专属「赛事化」视觉层 —— 只做赛道两侧的道具，不碰水面。
 *
 * 生效条件由 isLakeStadiumEnabled() 统一判定：
 *   mapDef.id === 'lake' && weather.id === 'day' && URL 未带 ?lakeStadium=0
 * 其它地图根本不会创建这个 group，渲染路径与改动前完全一致。
 *
 * 内容（P1）：外侧看台（含顶棚/柱廊/桩基）、观众、大屏、灯塔、广告板，
 *            以及 P0 保留的橙白浮台、黄黑警示柱。
 *            弯道 Chevron 立牌已移到全地图通用的 GuideSigns.js：那边按弯道转向
 *            决定箭头方向，这里不再自建，免得两套牌叠在一起 / 方向互相矛盾。
 * 明确不做：水色、浪花、水面贴片 —— 水面必须保持原样（用户要求）。
 *
 * 设计约束（沿用本项目既有约定）：
 *   - 布点按「沿中心线弧长」，不按门号
 *   - 纯视觉，不写任何 colliders，因此不会造出空气墙
 *   - 确定性：只用固定步长 + 索引哈希，不用 Math.random()
 *   - 每类道具一个 InstancedMesh，整层约 10 个 draw call
 *   - 看台占地与 Environment 的种树共用 LakeStadiumLayout，树不会从看台里长出来
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { waveHeight } from '../utils/waves.js';
import {
  lakeStadiumLayout, sampleAt,
  STAND_FRONT, STAND_DEPTH, STAND_LENGTH,
} from './LakeStadiumLayout.js';

const SIGN_STEP = 16;      // 立牌沿弧长的间距（米）
const EDGE_EXTRA = 6.5;    // 立牌离走廊边界再外挪的距离（米），太近会贴脸
const BOARD_OFF = 18.2;    // 广告板离中心线（米）：比看台前沿再靠里一点

function disabledByUrl() {
  try {
    if (typeof location === 'undefined') return false;
    const q = new URLSearchParams(location.search);
    return q.get('lakeStadium') === '0' || q.get('grade') === 'old';
  } catch { return false; }
}

/**
 * 唯一的生效判定入口，Game / 验收脚本都用它。
 *
 * 注意：**不再看天气**。看台是实景建筑，不是调色预设；
 * 岸边种树用同一份占地数据把看台位置让了出来，如果这里还按「只有晴天」
 * 隐藏看台，切到黄昏就会在岸边留出一排光秃秃的空地。
 * 需要临时关掉整层用 ?lakeStadium=0。
 */
export function isLakeStadiumEnabled(mapDef) {
  return !!mapDef && mapDef.id === 'lake' && !disabledByUrl();
}

/** 确定性哈希：同一个 (a,b,c) 永远得到同一个 0~1，联机两端也一致 */
function hash3(a, b, c) {
  const v = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 橙白警示浮台 */
function makePontoonTexture() {
  const c = makeCanvas(256, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#ef8b1f';
  x.fillRect(0, 0, 256, 128);
  x.fillStyle = '#f7fbff';
  x.fillRect(0, 14, 256, 22);
  x.fillRect(0, 92, 256, 22);
  return new THREE.CanvasTexture(c);
}

/** 黄黑警示柱 */
function makeStripeTexture() {
  const c = makeCanvas(64, 128);
  const x = c.getContext('2d');
  x.fillStyle = '#f2b428';
  x.fillRect(0, 0, 64, 128);
  x.fillStyle = '#20262e';
  for (let i = 0; i < 6; i++) x.fillRect(0, i * 22, 64, 11);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 赛场大屏：深色底 + 橙色强调 + 计分板，别做成纯红蓝广告牌 */
function makeScreenTexture() {
  const c = makeCanvas(512, 256);
  const x = c.getContext('2d');
  x.fillStyle = '#0a1521';
  x.fillRect(0, 0, 512, 256);
  // 顶部标题条
  x.fillStyle = '#0f2c47';
  x.fillRect(0, 0, 512, 54);
  x.fillStyle = '#f0a121';
  x.fillRect(0, 0, 10, 54);
  x.fillStyle = '#eaf3ff';
  x.font = 'bold 30px "Segoe UI",sans-serif';
  x.textBaseline = 'middle';
  x.fillText('湖泊环线 GRAND PRIX', 26, 29);
  // 棋盘格条
  for (let i = 0; i < 32; i++) {
    x.fillStyle = i % 2 ? '#e9eff5' : '#16202b';
    x.fillRect(i * 16, 54, 16, 12);
  }
  // 计分板三行
  const rows = [['P1', '#f0a121'], ['P2', '#dfe8f2'], ['P3', '#dfe8f2']];
  rows.forEach(([tag, col], i) => {
    const y = 92 + i * 52;
    x.fillStyle = 'rgba(255,255,255,0.07)';
    x.fillRect(22, y - 18, 468, 40);
    x.fillStyle = col;
    x.font = 'bold 24px "Segoe UI",sans-serif';
    x.fillText(tag, 34, y);
    x.fillStyle = '#5f7f9c';
    x.fillRect(96, y - 10, 240 - i * 46, 16);
    x.fillStyle = '#8fb6d8';
    x.font = '20px "Segoe UI",sans-serif';
    x.fillText(i === 0 ? '01:12.44' : i === 1 ? '+0.31' : '+1.08', 356, y);
  });
  return new THREE.CanvasTexture(c);
}

/** 三角彩旗（白底，靠 per-instance color 上色）：挂在看台顶棚前沿当"赛事旗串" */
function makePennantTexture() {
  const c = makeCanvas(128, 128);
  const x = c.getContext('2d');
  x.clearRect(0, 0, 128, 128);
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.moveTo(8, 16);
  x.lineTo(120, 16);
  x.lineTo(64, 116);
  x.closePath();
  x.fill();
  return new THREE.CanvasTexture(c);
}

/** 广告板两种配色，交替铺，避免一眼看出是同一张贴图 */
function makeBoardTexture(variant) {
  const c = makeCanvas(512, 128);
  const x = c.getContext('2d');
  if (variant === 0) {
    x.fillStyle = '#f2f6fa';
    x.fillRect(0, 0, 512, 128);
    x.fillStyle = '#1262d2';
    x.fillRect(0, 96, 512, 32);
    x.fillStyle = '#0b2f63';
    x.font = 'bold 62px "Segoe UI",sans-serif';
    x.textBaseline = 'middle';
    x.fillText('HYDRO', 34, 58);
    x.fillStyle = '#ef8b1f';
    x.fillRect(330, 26, 12, 58);
    x.fillStyle = '#3d5673';
    x.font = 'bold 34px "Segoe UI",sans-serif';
    x.fillText('SPORT', 358, 56);
  } else {
    x.fillStyle = '#0e1f33';
    x.fillRect(0, 0, 512, 128);
    x.fillStyle = '#f0b429';
    x.fillRect(0, 0, 512, 10);
    x.fillStyle = '#eaf3ff';
    x.font = 'bold 58px "Segoe UI",sans-serif';
    x.textBaseline = 'middle';
    x.fillText('TIDE', 40, 62);
    x.fillStyle = '#f0a121';
    x.font = 'bold 30px "Segoe UI",sans-serif';
    x.fillText('MARINE', 226, 66);
    x.strokeStyle = 'rgba(255,255,255,0.25)';
    x.lineWidth = 3;
    x.beginPath();
    x.moveTo(410, 74);
    x.bezierCurveTo(440, 40, 470, 96, 496, 58);
    x.stroke();
  }
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// 看台模块几何：整块只建一次，之后靠 InstancedMesh 铺一圈
// 本地坐标：X 沿赛道，Y 向上，Z 朝环外；z = 0 是占地中心
// ---------------------------------------------------------------------------
const STAND_COLORS = {
  plinth: 0x7b8691,   // 基座
  tier: 0xb9c2cb,     // 台阶立面
  seat: 0x1b4f9e,     // 座椅（深蓝，和参考图的看台同色系）
  back: 0x9aa5b0,     // 后墙
  roof: 0xa8b7c6,     // 顶棚上表面（别用纯白：俯瞰就是一排白铁皮箱子）
  roofUnder: 0x59656f, // 顶棚下表面（从低机位抬头看的就是它，不能跟上面同色）
  fascia: 0x2b3744,   // 顶棚前檐
  accent: 0xf0a121,   // 赛事橙
  column: 0x707a84,   // 柱廊
  pile: 0x545d66,     // 桩基
};

// 看台模块尺寸也导出：竞技场环形看台（ArenaStadium.js）复用同一套模块几何，
// 两边看台的台阶高度/排距完全一致，观众坐姿取位公式也共用。
export const ROWS = 6;
export const RISE = 1.4;
export const TREAD = 1.9;
export const SEAT_TOP = 1.4;
export const ROOF_Y = SEAT_TOP + ROWS * RISE + 2.6;

function tinted(geo, hex) {
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

function boxGeo(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tinted(g, hex);
}

function cylGeo(rTop, rBot, h, seg, x, y, z, hex) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  g.translate(x, y, z);
  return tinted(g, hex);
}

/**
 * 看台模块几何（导出给 ArenaStadium 复用：环形看台用同一套台阶/顶棚/桩基）
 *
 * 参数化（2026-11-14）：竞技场要把看台拉高，但湖泊看台的高度是美术定过的，
 * 所以这里全部走可选参数，**不传就是原来的 6 排 1.4m**，湖泊看台零变化。
 * @param {object} [opts]
 * @param {number} [opts.rows]    台阶排数
 * @param {number} [opts.rise]    每排高差
 * @param {number} [opts.tread]   每排进深
 * @param {number} [opts.seatTop] 第一级台阶高度
 */
export function buildStandGeometry(opts = {}) {
  const rows = opts.rows ?? ROWS;
  const rise = opts.rise ?? RISE;
  const tread = opts.tread ?? TREAD;
  const seatTop = opts.seatTop ?? SEAT_TOP;
  const roofY = seatTop + rows * rise + 2.6;

  const parts = [];
  const FRONT = -STAND_DEPTH / 2;
  const BACK = STAND_DEPTH / 2;

  // 基座：从水下 -2.2 一直到看台第一级
  parts.push(boxGeo(STAND_LENGTH, 3.8, STAND_DEPTH, 0, seatTop - 1.9, 0, STAND_COLORS.plinth));

  for (let i = 0; i < rows; i++) {
    const zf = FRONT + 0.5 + i * tread;
    const depth = BACK - zf;
    const y0 = seatTop + i * rise;
    // 台阶实体（后侧一直填到后墙，形成阶梯断面）
    parts.push(boxGeo(STAND_LENGTH, rise, depth, 0, y0 + rise / 2, zf + depth / 2, STAND_COLORS.tier));
    // 座椅面：深蓝薄板，远看就是一条条蓝色看台带
    parts.push(boxGeo(STAND_LENGTH, 0.1, 2.2, 0, y0 + rise + 0.05, zf + 1.1, STAND_COLORS.seat));
  }

  // 后墙
  parts.push(boxGeo(
    STAND_LENGTH, 2.6, 0.7,
    0, seatTop + rows * rise + 1.3, BACK - 0.35, STAND_COLORS.back,
  ));

  // 顶棚：上表面浅灰、下表面深色。只做一层白色薄板从低机位看就是一块惨白铁皮，
  // 深色下表面 + 橙色前檐才读得出"看台雨棚"的体积。
  // 进深只盖到倒数第二排：前排观众要从顶上看得到，否则俯瞰就是一整片屋面板。
  parts.push(boxGeo(STAND_LENGTH + 2, 0.22, 11.0, 0, roofY + 0.38, 1.0, STAND_COLORS.roof));
  parts.push(boxGeo(STAND_LENGTH + 2, 0.18, 10.8, 0, roofY + 0.18, 1.0, STAND_COLORS.roofUnder));
  parts.push(boxGeo(STAND_LENGTH + 2, 1.0, 0.4, 0, roofY - 0.15, -4.5, STAND_COLORS.fascia));
  parts.push(boxGeo(STAND_LENGTH + 2, 0.28, 0.46, 0, roofY - 0.5, -4.48, STAND_COLORS.accent));
  // 柱子放在最后一排后面：放前沿会挡住 1~4 排的视线，真实雨棚也是后支前挑。
  for (const k of [-1, 0, 1]) {
    parts.push(cylGeo(0.22, 0.26, roofY + 1.0, 7, k * 17, (roofY + 1.0) / 2 - 0.5, 5.6, STAND_COLORS.column));
  }
  // 两端封墙：不封的话从侧后方看就是一只敞口集装箱
  for (const sx of [-1, 1]) {
    parts.push(boxGeo(
      0.45, roofY - 1.2, STAND_DEPTH - 0.6,
      sx * (STAND_LENGTH / 2 + 0.2), (roofY + 1.2) / 2, 0, STAND_COLORS.plinth,
    ));
  }

  // 后沿桩基：进深已经越过岸带外缘，后半个看台是站在水面上的
  for (const x of [-15, -5, 5, 15]) {
    parts.push(boxGeo(0.9, 2.8, 0.9, x, -3.2, BACK - 1.2, STAND_COLORS.pile));
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

/** 灯塔模块：杆 + 灯头（合并成一个几何，实例化后仍然只有 1 个 draw call） */
function buildLightRigGeometry() {
  const parts = [
    cylGeo(0.18, 0.26, 15, 8, 0, 6.5, 0, STAND_COLORS.column),
    boxGeo(1.7, 0.55, 1.05, 0, 14.2, 0, 0x2c3742),
    boxGeo(1.4, 0.22, 0.8, 0, 14.55, 0, 0xfff4cf),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

/** 广告板模块：一块板 + 两条腿 */
function buildBoardGeometry() {
  const parts = [
    boxGeo(8.4, 1.5, 0.16, 0, 0.85, 0, 0xffffff),
    boxGeo(0.14, 2.2, 0.14, -3.6, -0.5, 0, 0x4a545e),
    boxGeo(0.14, 2.2, 0.14, 3.6, -0.5, 0, 0x4a545e),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

/**
 * 大屏模块（导出给 ArenaStadium 复用：换一张竞技场计分贴图就是竞技场大屏）
 *
 * 参数化（2026-11-14）：原版屏幕中心固定在 y=14.2，只比顶棚(12.4)高 1.8m，
 * 屏体下沿其实**落在顶棚以下 1.5m**，低机位往上看就被雨棚前檐切掉一截
 * （用户反馈"比分牌有部分被遮挡、位置太靠下"）。这里把"屏幕中心相对顶棚的
 * 偏移"和"支撑柱落点"都开放出来，竞技场传一个更大的 boardLift 把屏幕整块
 * 抬到顶棚之上；不传则完全保持湖泊看台原来的位置与柱高。
 *
 * @param {object} [opts]
 * @param {number} [opts.roofY]      顶棚高度（默认按湖泊看台常量算）
 * @param {number} [opts.boardLift]  屏幕中心相对顶棚的抬高量，默认 1.8
 * @param {number} [opts.postDrop]   支撑柱底端相对顶棚的下沉量，默认 2.3
 */
export function buildScreenGeometry(opts = {}) {
  const roofY = opts.roofY ?? ROOF_Y;
  const boardLift = opts.boardLift ?? 1.8;
  const postDrop = opts.postDrop ?? 2.3;
  const boardY = roofY + boardLift;
  // 屏幕下沿(半高 3.3)再往里 0.6m 就是柱顶：默认刚好复现原 1.4m 柱高
  const postTop = boardY - 3.3 + 0.6;
  const postBottom = roofY - postDrop;
  const postH = Math.max(0.4, postTop - postBottom);
  const postY = (postTop + postBottom) / 2;
  const parts = [
    boxGeo(14.6, 6.6, 0.24, 0, boardY, -0.22, 0x18232e),
    boxGeo(14, 6, 0.3, 0, boardY, 0, 0x121a22),
    boxGeo(0.34, postH, 0.34, -4.6, postY, 0, STAND_COLORS.column),
    boxGeo(0.34, postH, 0.34, 4.6, postY, 0, STAND_COLORS.column),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());
  merged.computeBoundingSphere();
  return merged;
}

function distToPolyline(pts, x, z) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const vx = bx - ax;
    const vz = bz - az;
    const L2 = vx * vx + vz * vz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (z - az) * vz) / L2));
    const d = Math.hypot(x - (ax + vx * t), z - (az + vz * t));
    if (d < best) best = d;
  }
  return best;
}

/** 摆位前的净空检查：装饰绝不能压进近道走廊、岛屿、暗礁或领奖台 */
function clearOf(x, z, mapDef) {
  for (const sc of mapDef.shortcuts || []) {
    if (distToPolyline(sc.points, x, z) < sc.width + 9) return false;
  }
  for (const is of mapDef.islands || []) {
    if (Math.hypot(x - is.x, z - is.z) < is.r + 7) return false;
  }
  for (const r of mapDef.rocks || []) {
    if (Math.hypot(x - r.x, z - r.z) < r.r + 6) return false;
  }
  if (mapDef.podium && Math.hypot(x - mapDef.podium.x, z - mapDef.podium.z) < 28) return false;
  return true;
}

/**
 * 建整套赛事装饰层。返回 { group, setEnabled, update, dispose, stats }。
 * @param {THREE.Scene} scene
 * @param {object} mapDef lake 的地图定义
 */
export function createLakeStadium(scene, mapDef) {
  const group = new THREE.Group();
  group.name = 'lake-stadium';
  scene.add(group);

  const layout = lakeStadiumLayout(mapDef);
  const total = layout.total;
  const stands = layout.stands;

  const frameAt = (s) => {
    const p = sampleAt(layout, s);
    const a = sampleAt(layout, s - 6);
    const b = sampleAt(layout, s + 6);
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const L = Math.hypot(tx, tz) || 1;
    tx /= L;
    tz /= L;
    let outX = -tz;
    let outZ = tx;
    if (outX * p.x + outZ * p.z < 0) { outX = -outX; outZ = -outZ; }
    return { x: p.x, z: p.z, tx, tz, outX, outZ };
  };

  const pontoonTex = makePontoonTexture();
  const stripeTex = makeStripeTexture();
  const screenTex = makeScreenTexture();
  const boardTex = [makeBoardTexture(0), makeBoardTexture(1)];
  const pennantTex = makePennantTexture();

  const pontoons = [], beacons = [];
  const put = (arr, x, y, z, X, Y, Z) => {
    const m = new THREE.Matrix4().makeBasis(X, Y, Z);
    m.setPosition(x, y, z);
    arr.push({ x, y, z, base: m });
  };
  const up = () => new THREE.Vector3(0, 1, 0);

  // ---- 边缘浮台 / 警示柱（弯道导向牌统一由 GuideSigns.js 生成）----
  const off = mapDef.gateWidth / 2 + EDGE_EXTRA;
  for (let s = 10, idx = 0; s < total - 4; s += SIGN_STEP, idx++) {
    const p = frameAt(s);
    const nx = p.outX;
    const nz = p.outZ;
    if (idx % 4 === 0) {
      const x = p.x + nx * (off + 2.4);
      const z = p.z + nz * (off + 2.4);
      if (clearOf(x, z, mapDef)) {
        const X = new THREE.Vector3(nz, 0, -nx);
        const Z = new THREE.Vector3(p.tx, 0, p.tz);
        put(pontoons, x, 0.02, z, X, up(), Z);
      }
    }
    if (idx % 6 === 3) {
      // 警示柱也在外侧：放到内侧会立进航道里，变成凭空多出来的障碍
      const x = p.x + nx * (off + 5.0);
      const z = p.z + nz * (off + 5.0);
      if (clearOf(x, z, mapDef)) {
        const X = new THREE.Vector3(nz, 0, -nx);
        const Z = new THREE.Vector3(p.tx, 0, p.tz);
        put(beacons, x, 1.15, z, X, up(), Z);
      }
    }
  }

  // ---- 看台 / 观众 / 大屏 / 灯塔 / 广告板 ----
  const standBases = [];
  const crowd = [];
  const screens = [];
  const lights = [];
  const boards = [[], []];
  const pennants = [];
  // 观众配色：以浅色为主、蓝系次之、只留少量点缀色。
  // 第一版用了纯红/纯绿/明黄，远看就是一排彩色条码，完全不像人群。
  const CROWD_COLORS = [
    0xe8ecf1, 0xe8ecf1, 0xd7dee6, 0xc2ccd6, 0xeceff3,
    0x8fa6bd, 0x4a6f9e, 0x26578f,
    0xc9534c, 0xd9a25a, 0x2f3b46,
  ];
  // 彩旗只上三种赛事色，别做成彩虹
  const PENNANT_COLORS = [0xf0a121, 0x2f6fbf, 0xf2f6fa, 0x2f6fbf];
  const crowdColor = new THREE.Color();
  const iPos = new THREE.Vector3();
  const iQuat = new THREE.Quaternion();
  const iScale = new THREE.Vector3();

  stands.forEach((st, si) => {
    const X = new THREE.Vector3(st.outZ, 0, -st.outX);   // up × out，保证右手系
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(st.outX, 0, st.outZ);
    const base = new THREE.Matrix4().makeBasis(X, Y, Z);
    base.setPosition(st.x, 0, st.z);
    standBases.push({ base, st });

    // 观众：每级台阶一排，按确定性哈希留出空座
    for (let i = 0; i < ROWS; i++) {
      const zf = -STAND_DEPTH / 2 + 0.5 + i * TREAD;
      const y = SEAT_TOP + (i + 1) * RISE + 0.42;
      let col = 0;
      for (let u = -STAND_LENGTH / 2 + 1.4; u < STAND_LENGTH / 2 - 1.4; u += 0.88, col++) {
        const h = hash3(si + 1, i * 31 + 7, col * 13 + 3);
        if (h > 0.74) continue;                     // 约 26% 空座
        const h2 = hash3(si + 5, i * 17 + 1, col * 7 + 11);
        const m = new THREE.Matrix4();
        iPos.set(u + (h2 - 0.5) * 0.3, y, zf + 0.7 + h2 * 0.6);
        iScale.setScalar(0.88 + h2 * 0.24);
        m.compose(iPos, iQuat, iScale);
        crowd.push({
          base: new THREE.Matrix4().multiplyMatrices(base, m),
          color: CROWD_COLORS[Math.floor(h * 997) % CROWD_COLORS.length],
        });
      }
    }

    // 灯塔：每个看台两根，落在看台后方的水里（放座椅中间会从人群里穿出来）
    for (const u of [-STAND_LENGTH / 2 + 3, STAND_LENGTH / 2 - 3]) {
      const m = new THREE.Matrix4().makeTranslation(u, 0, STAND_DEPTH / 2 + 2.2);
      lights.push({ base: new THREE.Matrix4().multiplyMatrices(base, m) });
    }

    // 顶棚前沿的彩旗串：挂在檐口下方，放屋顶上会变成一排彩色小方块
    for (let u = -STAND_LENGTH / 2 + 1.6, pi = 0; u < STAND_LENGTH / 2 - 1.6; u += 2.4, pi++) {
      const m = new THREE.Matrix4().makeTranslation(u, ROOF_Y - 0.95, -4.72);
      pennants.push({
        base: new THREE.Matrix4().multiplyMatrices(base, m),
        color: PENNANT_COLORS[pi % PENNANT_COLORS.length],
      });
    }

    // 广告板：每个看台三块，立在看台前方的浅滩上（带腿）
    for (let k = -1; k <= 1; k++) {
      const u = k * (STAND_LENGTH / 3);
      const px = st.x + st.tx * u + st.outX * (BOARD_OFF - (STAND_FRONT + STAND_DEPTH / 2));
      const pz = st.z + st.tz * u + st.outZ * (BOARD_OFF - (STAND_FRONT + STAND_DEPTH / 2));
      if (!clearOf(px, pz, mapDef)) continue;
      // 板面朝航道：本地 +Z 取「朝内」
      const XX = new THREE.Vector3(-st.outZ, 0, st.outX);   // up × (-out)
      const ZZ = new THREE.Vector3(-st.outX, 0, -st.outZ);
      const m = new THREE.Matrix4().makeBasis(XX, Y, ZZ);
      m.setPosition(px, 0, pz);
      boards[Math.abs(k + si) % 2].push({ base: m });
    }

    // 大屏：每三个看台放一座，架在顶棚上方
    if (si % 3 === 0) {
      const m = new THREE.Matrix4().makeTranslation(0, 0, 1.5);
      const screenBase = new THREE.Matrix4().multiplyMatrices(base, m);
      // 屏面要和看台朝向一致（正面朝航道）：绕 Y 转 180°
      const flip = new THREE.Matrix4().makeRotationY(Math.PI);
      screens.push({ base: new THREE.Matrix4().multiplyMatrices(screenBase, flip) });
    }
  });

  const standMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const rigMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const boardMat = boardTex.map((t) => new THREE.MeshLambertMaterial({ map: t }));
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, fog: true });
  const pontoonMat = new THREE.MeshLambertMaterial({ map: pontoonTex });
  const beaconMat = new THREE.MeshLambertMaterial({ map: stripeTex });
  const pennantMat = new THREE.MeshLambertMaterial({
    map: pennantTex, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide,
  });

  const batches = [];
  const makeBatch = (geo, mat, list, name, opts = {}) => {
    if (!list.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.name = name;
    mesh.frustumCulled = false;
    if (opts.floating) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((d, i) => mesh.setMatrixAt(i, d.base));
    mesh.instanceMatrix.needsUpdate = true;
    if (opts.colors) {
      list.forEach((d, i) => {
        crowdColor.setHex(d.color ?? 0xffffff);
        mesh.setColorAt(i, crowdColor);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (opts.shadow) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    group.add(mesh);
    batches.push({ mesh, list, floating: !!opts.floating });
    return mesh;
  };

  makeBatch(buildStandGeometry(), standMat, stands.map((st) => {
    const X = new THREE.Vector3(st.outZ, 0, -st.outX);
    const Y = new THREE.Vector3(0, 1, 0);
    const Z = new THREE.Vector3(st.outX, 0, st.outZ);
    const m = new THREE.Matrix4().makeBasis(X, Y, Z);
    m.setPosition(st.x, 0, st.z);
    return { base: m };
  }), 'lake-stands');

  if (crowd.length) {
    makeBatch(new THREE.BoxGeometry(0.3, 0.74, 0.3), new THREE.MeshLambertMaterial(), crowd, 'lake-crowd', { colors: true });
  }
  makeBatch(buildScreenGeometry(), screenMat, screens, 'lake-screens');
  makeBatch(buildLightRigGeometry(), rigMat, lights, 'lake-lights');
  makeBatch(buildBoardGeometry(), boardMat[0], boards[0], 'lake-boards-a');
  makeBatch(buildBoardGeometry(), boardMat[1], boards[1], 'lake-boards-b');
  makeBatch(new THREE.PlaneGeometry(1.15, 0.95), pennantMat, pennants, 'lake-pennants', { colors: true });

  makeBatch(new THREE.BoxGeometry(2.6, 0.34, 1.25), pontoonMat, pontoons, 'lake-pontoons', { floating: true });
  makeBatch(new THREE.CylinderGeometry(0.28, 0.32, 2.3, 8), beaconMat, beacons, 'lake-beacons');

  const tmp = new THREE.Matrix4();
  return {
    group,
    stats: {
      stands: stands.length,
      crowd: crowd.length,
      screens: screens.length,
      lights: lights.length,
      boards: boards[0].length + boards[1].length,
      pennants: pennants.length,
      pontoons: pontoons.length,
      beacons: beacons.length,
      length: Math.round(total),
    },
    setEnabled(on) { group.visible = !!on; },
    /** 贴水面的浮台跟着波高走，否则会被起伏的水面吃掉 */
    update(t) {
      if (!group.visible) return;
      for (const b of batches) {
        if (!b.floating) continue;
        for (let i = 0; i < b.list.length; i++) {
          const d = b.list[i];
          tmp.copy(d.base);
          tmp.setPosition(d.x, d.y + waveHeight(d.x, d.z, t), d.z);
          b.mesh.setMatrixAt(i, tmp);
        }
        b.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      scene.remove(group);
      group.traverse((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      });
      [pontoonTex, stripeTex, screenTex, pennantTex, ...boardTex].forEach((t) => t.dispose());
    },
  };
}
