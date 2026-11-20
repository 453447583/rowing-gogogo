import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { waveHeight, waveSlope, waveVerticalRate, waveAmpSum } from '../utils/waves.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';
import { boatHandling } from '../data/boats.js';
import { makeContactShadowTexture } from './Textures.js';
import { measureModelBox } from './modelBounds.js';
import { fallbackHullOutline, convexHull2D, simplifyOutline, outlineExtents } from '../utils/hull.js';
import { audio } from '../audio/AudioEngine.js';

// ---------- 船体手感：全局兜底值（逐船在 data/boats.js 的 BOAT_HANDLING 里覆盖）----------
// 这几个数决定"肉"的程度，改这里 = 全船队一起变：
//   HULL_ACCEL_SCALE 推力整体倍率（调大更猛）
//   HULL_SPOOL 起步延迟（秒，调大更肉）
//   HULL_COAST_DRAG 滑行阻尼（调大松油门掉速更快）
//   HULL_YAW_SCALE 转向峰值倍率（调大更灵）
//   HULL_YAW_TAU 转向惯性（秒，调大船头更"甩半拍"）
export const HULL_ACCEL_SCALE = 1.45;
export const HULL_SPOOL = 0.55;
export const HULL_DRIFT_DRAG = 1.7;
export const HULL_YAW_SCALE = 0.82;
export const HULL_YAW_TAU = 0.34;
export const HULL_COAST_DRAG = 0.33;
export const HULL_COAST_QUAD = 1.0;

// ---------- 贴墙脱困（2026-11-17）----------
// 病根：船头顶在护栏上 → 墙把法向速度吃掉 → |vf|≈0 → 转向速度曲线 lowCut≈0
//       → 方向键按了船头也不动，只能"很缓慢地蹭"，最后只能复位。
// 跑跑卡丁车/马车贴墙时车头是能被掰开的，所以贴墙期间给一个最低速度权重。
//   WALL_YAW_MIN_SP              非浮空船：速度权重下限（/极速，0.30 ≈ 8m/s 档）
//   WALL_YAW_MIN_SPEED_FACTOR    浮空船：speedFactor 下限
export const WALL_YAW_MIN_SP = 0.30;
export const WALL_YAW_MIN_SPEED_FACTOR = 0.85;

// ---------- 氮气 / 漂移的硬指标（这两条是玩家口径，别再散在物理里）----------
// 氮气极速 = 本船极速 × boostPower（1.8）。极速更高的船氮气上限也更高，
// 三种船不再共用 220：面板“极速 100”的船，氮气极限确实最快。
// NITRO_TOP_KMH 只作为安全上限（36 m/s × 1.8 ≈ 233 km/h）。
export const NITRO_TOP_KMH = 240;
export const NITRO_TOP_SPEED = NITRO_TOP_KMH / 3.6;

// ---------- 速度档（2026-11-17 用户实机口径）----------
// "比赛模式下加速太快难控"，要求巡航与加速极速各降 20km/h。
// 注意是**绝对量**：两个上限各减 5.556 m/s。
// 如果改成把 maxSpeed 调小（倍率口径），氮气会跟着掉 1.8×20=36km/h，对不上。
export const SPEED_CUT_KMH = 20;
export const SPEED_CUT = SPEED_CUT_KMH / 3.6;
// 想整体加快/减慢时只改 SPEED_CUT_KMH 一个数（单位：km/h，0 = 恢复原速）。
export const cruiseTopOf = (def) => Math.max(8, def.maxSpeed - SPEED_CUT);
export const boostTopOf = (def) => {
  const raw = Math.min(NITRO_TOP_SPEED, def.maxSpeed * (def.boostPower || 1.8)) - SPEED_CUT;
  // 氮气必须明显快过巡航（最低保留 1.35 倍），否则"加速"读不出来
  return Math.max(cruiseTopOf(def) * 1.35, raw);
};
// 漂移（跑跑卡丁车逻辑）：漂移**一定**比直道慢，但慢得很缓。
//   推力留一半 → 踩油门顶得住大部分阻力，速度是被"拖"下去的不是被"砍"下去的；
//   速度被拖向 直道极速 × 0.94（滑移角拉满再压 7%，指数逼近 = 托漂那种拖曳感）；
//   出弯才用单喷/双喷把这部分补回来，但补不回超过直道极速的 1.06 倍。
// 2026-11-16：0.86 / 0.30 的组合会让船在入漂半秒内掉 15%（读起来就是"闷一下"），
// 现在减速完全交给"拖曳"曲线，推力提到 0.55 保证漂移中还能维持速度。
export const DRIFT_SPEED_RATIO = 0.94;
export const DRIFT_THRUST_MUL = 0.55;
// 小喷（托漂/双喷）的极速抬升：只比直道极速高 6%，够读成"托出去一下"
export const MINI_BOOST_TOP_RATIO = 1.06;
// 注意：boats.js 里的 def.drag（0.30~0.40）是给"恒定推力 + 全程水阻"那套老模型调的，
// 在新模型里只作用于松油门/漂移，直接用会让船一松油门就刹停（实测 1.3 秒掉一半）。
// 所以滑行阻尼 = def.drag × handling.coastDrag，各船之间的相对差异保留。

/** 把"一帧内的角度增量"按角速度上限裁掉，是滑移角不阶跃的保险丝。 */
export function limitDriftStep(step, dt, maxRate = 1.8) {
  return THREE.MathUtils.clamp(step, -maxRate * dt, maxRate * dt);
}

/**
 * 出弯能拿几喷。
 * @param {number} driftTime 本次漂移时长（秒）
 * @param {number|null} peakAngle 本次漂移达到过的最大滑移角（rad）。给了就按角度判
 *   （2026-11-16 之后的正式口径：30° 双喷 / 16° 单喷）；不给则回落到按时间估。
 */
export function driftBoostCount(driftTime, peakAngle = null) {
  if (driftTime < DRIFT_TUNING.minHold) return 0;
  if (peakAngle != null) {
    if (peakAngle >= DRIFT_TUNING.doubleAngle) return 2;
    return peakAngle >= DRIFT_TUNING.singleAngle ? 1 : 0;
  }
  if (driftTime < 0.55) return 0;
  const charge = THREE.MathUtils.clamp((driftTime - 0.35) / 1.15, 0, 1);
  return charge > 0.72 ? 2 : 1;
}

export const NITRO_CAPACITY = 2;

// ---------- 漂移手感总参数（调漂移先看这里）----------
// 2026-11-16 彻底重做：滑移角 driftAngle 成为真正的一阶状态，方向键连续控制它。
//
// 旧模型（三处阶跃 → "一顿一顿"）：
//   ① 入漂一帧把速度砍掉 driftCut（8~18%），按下 Shift 那一下"顿"；
//   ② 拉车头倍率在 2.05 / 0.75 / -1.65 三点间切换，反打方向时车头抽搐；
//   ③ 松键即断漂，再按下重新砍速；且速度方向被强行跟着车头转（那是贴地转向，
//      根本不是在漂），滑移角只有 14° 是靠假侧滑装出来的。
//
// 新模型：
//   车头 = 轨迹方向 + 滑移角。轨迹按 pathYaw 自己转，速度永远沿轨迹走。
//   方向键 → 想要多少滑移角（含符号）：一直按住就一直漂那一侧（拖漂）；
//   反打方向 → 滑移角连续穿过 0 翻到另一侧（彩虹漂）；
//   松开方向 → 滑移角按时间常数缓慢回正（不是一帧断漂）；
//   撞到东西 → 只扣掉本次漂移攒下的气（氮气瓶保留），滑移角柔和甩正。
export const DRIFT_TUNING = {
  startSpeed: 5.0,      // 起漂最低速度（m/s）
  exitSpeed: 1.2,       // 掉到此速度以下强制断漂
  steerDead: 0.08,      // 方向输入死区（低于它算"没打方向"）
  chainWindow: 0.85,    // 断漂补气窗口：松键后这段时间内再按住 = 同一次漂移
  relock: 0.28,         // 撞墙后重新起漂的冷却
  breakTime: 0.10,      // 撞墙后强行收角的缓冲时长
  angleBase: 0.22,      // 低速时的滑移角上限（rad ≈ 12.6°）
  angleGain: 0.34,      // 速度比每 +1 增加的滑移角（满速 ≈ 0.56 rad = 32.1°）
  angleCap: 0.66,       // 滑移角绝对上限（rad）
  angleRate: 3.0,       // 滑移角建角角速度（rad/s）：3.0 → 拉满 0.5rad 用 0.17s；
  //                       彩虹漂要能在 0.3s 内把角度从 +30° 甩到 -30°（反打手感的下限）
  straightenSlow: 0.42, // 拖漂：松方向后保角的时间常数（秒）
  straightenFast: 0.13, // 回正：够双喷门槛之后松方向，车头迅速甩正（触发双喷）
  // 漂移转弯半径的唯一调节旋钮 —— 想自己改就只改这一个数：
  //   数字越大 → 转得越急、半径越小；数字越小 → 弯越宽、半径越大。
  //   R ≈ 32m/s（漂移稳态速度）÷ (pathYaw × 约 0.96)
  // pathYaw: 1.48→R≈21.7m / 1.95→R≈16.5m / 2.05→R≈15.6m /
  //          2.70→R≈11.9m / 3.50→R≈9.1m（全部为 drift_arc_probe 实测）
  // 2026-11-17 定稿 1.95：用户反馈 9.1m 太小、不好开，改回 16~17m。
  // 普通转向（不漂）的半径是 43m，漂移仍明显比它弯得急。
  pathYaw: 1.6,
  // 平行的上限必须 ≥ pathYaw，否则会被截掉、光改上面没用；留一点余量。
  pathYawCap: 2.2,
  pathYawTau: 0.06,     // 轨迹偏航的一阶平滑（秒）
  //                       0.10 时起漂第一个 0.5s 半径还有 41m（先被甩出去再收回来），
  //                       收到 0.06 让入漂当场就开始入弯，不再有"往外冲一下"。
  exitTau: 0.16,        // 断漂后滑移角收掉的时长（秒）—— 车头甩正，轨迹不动
  singleAngle: 0.24,    // 单喷门槛（rad ≈ 13.8°）
  doubleAngle: 0.43,    // 双喷门槛（rad ≈ 24.6°）
  //                       滑移角上限从 36.7° 收到约 30°，门槛必须同步下调，
  //                       否则永远够不到双喷；仍要求"漂到接近最大角"才给两喷。
  //                       必须低于最重船的满速峰值（磐石号 27.3°）并留余量，
  //                       否则重船一掉速就永远拿不到双喷。
  minHold: 0.28,        // 最短漂移时长（秒）：点头式一点不给喷
  boostCooldown: 0.32,  // 两次发喷之间的最小间隔（防连点刷喷）
  speedRatio: 0.94,     // 漂移速度上限 = 直道极速 × 这个
  speedAngleLoss: 0.07, // 滑移角拉满时再额外压 7% 的上限
  dragBase: 0.85,       // 把速度拖向漂移上限的基准速率（1/秒）
  dragGain: 1.60,       // × handling.driftDrag（逐船差异）
  dragRamp: 0.55,       // 拖曳系数从 0 爬满的时间（秒）—— 入漂不闷的关键
};

// 「漩涡」巨型水泡把目标吸到空中的悬浮高度（米）
const BUBBLE_LIFT_HEIGHT = 5.5;
// 深海瀑布：水柱冲得比漩涡水泡更高，落差更夸张
const GEYSER_LIFT_HEIGHT = 9;
// 下坠段的重力加速度：比弹射段轻，让"被泡泡托住→缓缓落下"读得出来
const BUBBLE_FALL_G = 20;
// 水泡包裹特效的独立寿命（秒）：悬浮时长 + 下坠缓冲。
// 必须独立于状态机计时——状态机分支前存在提前 return 的路径（过山车），
// 悬浮计时会在那段里跑完却没人把 bubbleFalling 置位，之后再也不会进分支，
// 水泡壳就永久留在船上了。独立计时器保证任何路径到期都会收起特效。
const BUBBLE_WRAP_FALL_GRACE = 1.8;

// 远端快照的延迟回放时长（秒）。服务端 30Hz 广播（33ms/帧），
// 取 2 个快照间隔，保证任何时刻缓冲里都有可插值的相邻两帧。
// 实测（40m/s、60fps、局域网抖动 ±3ms）：指数平滑滞后 117ms/σ=4.1，
// 回放 66ms 为 99ms/σ=2.8 —— 滞后和抖动同时下降。
export const REMOTE_SAMPLE_DELAY = 0.066;

export function collectNitroCharge(charge, bottles, amount) {
  const stock = THREE.MathUtils.clamp(Math.floor(bottles || 0), 0, NITRO_CAPACITY);
  if (stock >= NITRO_CAPACITY) return { charge: 0, bottles: stock };

  const total = Math.max(0, charge) + Math.max(0, amount);
  const earned = Math.min(NITRO_CAPACITY - stock, Math.floor(total + 1e-6));
  return {
    charge: stock + earned >= NITRO_CAPACITY ? 0 : Math.min(1, Math.max(0, total - earned)),
    bottles: stock + earned,
  };
}

// 赛艇：GLB 模型（划桨动画）+ 程序化后备艇体 + 街机物理 + 尾迹浪花
// 约定：艇头朝 +Z，heading=0 时前向量为 (0,0,1)

function makeLabelTexture(name, color) {
  // 2026-11-17：按用户参考图重做名字牌 —— 白字更大更粗、深色描边更实，
  // 画布分辨率翻倍（256×64 → 512×128），远离时不会再糊成一团。
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const text = name.slice(0, 10);
  ctx.font = 'bold 44px "Microsoft YaHei", "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  // 先铺一圈深色描边 + 软阴影，保证在亮水面/白色浪花上仍有清晰轮廓；
  // 不加底板，保持参考图那种"字直接浮在船上"的干净感。
  ctx.shadowColor = 'rgba(0, 8, 18, 0.7)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;
  ctx.strokeStyle = 'rgba(3, 12, 22, 0.92)';
  ctx.lineWidth = 7;
  ctx.strokeText(text, 256, 68);
  // 填字时去掉 shadow，否则阴影会盖在字上发灰
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

let wakeTexture = null;
let contactShadowTexture = null;
// 接触阴影贴图全队共享一份（128 的小图，显存可忽略）
function getContactShadowTexture() {
  if (!contactShadowTexture) contactShadowTexture = makeContactShadowTexture();
  return contactShadowTexture;
}

function getWakeTexture() {
  if (wakeTexture) return wakeTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  // Horizontal, directional wake texture. It is rendered on the water plane,
  // avoiding the old camera-facing circular puffs that read as white fog.
  const g = ctx.createLinearGradient(0, 0, 0, 192);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.42)');
  g.addColorStop(0.56, 'rgba(255,255,255,0.72)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.strokeStyle = g;
  ctx.lineWidth = 13;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(20, 8);
  ctx.quadraticCurveTo(64, 70, 108, 8);
  ctx.stroke();
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(32, 57);
  ctx.quadraticCurveTo(64, 110, 96, 57);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(43, 111);
  ctx.quadraticCurveTo(64, 151, 85, 111);
  ctx.stroke();
  wakeTexture = new THREE.CanvasTexture(canvas);
  wakeTexture.colorSpace = THREE.SRGBColorSpace;
  return wakeTexture;
}

// 漂移水痕贴图：中间亮两端淡的白色长条（横向也向边缘淡出）
let driftMarkTexture = null;
function getDriftMarkTexture() {
  if (driftMarkTexture) return driftMarkTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  // 纵向：两端淡（白色泡沫，颜色由材质 tint 控制）
  const gy = ctx.createLinearGradient(0, 0, 0, 128);
  gy.addColorStop(0, 'rgba(255,255,255,0)');
  gy.addColorStop(0.5, 'rgba(255,255,255,0.72)');
  gy.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gy;
  ctx.fillRect(0, 0, 64, 128);
  // 横向：边缘淡出
  const gx = ctx.createLinearGradient(0, 0, 64, 0);
  gx.addColorStop(0, 'rgba(0,0,0,0)');
  gx.addColorStop(0.5, 'rgba(0,0,0,1)');
  gx.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = gx;
  ctx.fillRect(0, 0, 64, 128);
  driftMarkTexture = new THREE.CanvasTexture(canvas);
  return driftMarkTexture;
}

// Narrow white water-streak texture. It reads as thrown droplets rather than
// a round smoke puff when emitted in a fast, directional spray.
let splashTexture = null;
function getSplashTexture() {
  if (splashTexture) return splashTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 24; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.72, 'rgba(226,246,255,0.8)');
  g.addColorStop(1, 'rgba(200,236,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(12, 2);
  ctx.quadraticCurveTo(18, 24, 15, 58);
  ctx.quadraticCurveTo(12, 64, 9, 58);
  ctx.quadraticCurveTo(6, 24, 12, 2);
  ctx.fill();
  splashTexture = new THREE.CanvasTexture(canvas);
  splashTexture.colorSpace = THREE.SRGBColorSpace;
  return splashTexture;
}

// 水雾：柔边圆点，比水滴更大更淡，用来做浪花最外侧飘散的一层
let mistTexture = null;
function getMistTexture() {
  if (mistTexture) return mistTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  mistTexture = new THREE.CanvasTexture(canvas);
  mistTexture.colorSpace = THREE.SRGBColorSpace;
  return mistTexture;
}

// GLB 模型缓存：同一模型多艘艇共享加载结果（用 clone 实例化）
const modelCache = new Map();
function loadModel(url) {
  if (!modelCache.has(url)) {
    const loader = new GLTFLoader();
    modelCache.set(url, new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    }));
  }
  return modelCache.get(url);
}

export class Boat {
  /**
   * @param {THREE.Scene} scene
   * @param {object} def 赛艇定义（boats.js）
   * @param {string} playerName 显示名
   * @param {boolean} isLocal 是否本地玩家
   * @param {object} waterStyle 水色/浪高
   * @param {object} opts { ghost } —— ghost=true 只保留船体：不建尾迹、接触阴影、名牌，
   *   材质换成半透明青白。幽灵车用（见 GhostBoat.js），普通赛艇不传这个参数。
   */
  constructor(scene, def, playerName, isLocal = false, waterStyle = {}, opts = {}) {
    this.def = def;
    this.isGhost = !!opts.ghost;
    // 逐船手感（起步/滑行/转向/漂移强度），见 data/boats.js 的 BOAT_HANDLING
    this.handling = boatHandling(def);
    this.isLocal = isLocal;
    this.scene = scene;
    const waterBase = new THREE.Color(waterStyle.color ?? 0x2f9fc5);
    const foamWhite = new THREE.Color(0xf2fbff);
    this.wakeColor = {
      ripple: waterBase.clone().lerp(foamWhite, 0.74),   // 外层半透明水带
      crest: waterBase.clone().lerp(foamWhite, 0.90),    // 内层实心白泡沫
      waveScale: waterStyle.waveScale ?? 1,
    };
    // 昼夜亮度：夜里浪花不该亮成白斑（Game 每帧按天光写入）
    this.wakeLight = 1;
    // 低画质关掉水滴/水雾粒子，只保留水面泡沫
    this.detail = waterStyle.detail !== false;

    // 物理状态
    this.pos = new THREE.Vector3(0, 0, 0);
    this.prevPos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector2(0, 0); // XZ 平面速度
    this.heading = 0;
    this.speed = 0;
    // Digital keyboard input is filtered before it reaches the physics model.
    // This keeps full-lock steering from starting on a single frame.
    this.steerInput = 0;
    this.boostTimer = 0;
    this.nitroLoopTimer = 0;   // 氮气持续音剩余时间（只给本地玩家出声）

    // Bottom drift charge and stored bottles have distinct gameplay roles.
    this.nitroCharge = 0;      // 0..1, bottom gauge fill
    this.nitroBottles = 0;     // 0..NITRO_CAPACITY, upper-right inventory
    this.nitroAllowed = true;  // 道具模式禁用（只能靠道具）
    this.prevNitroKey = false;
    this.drifting = false;     // 当前是否处于漂移状态（视觉用）

    // 过山车腾空（金龙弹射）：分段重力 高空悬浮 → 低空重压俯冲
    this.airborne = false;
    this.vy = 0;
    this.airTime = 0;
    // 大浪抛飞：在浪尖被水面顶起的小腾空（竞速/道具水面启用）
    this.waveJump = false;
    this.waveJumpEnabled = false;
    this.waveJumpCooldown = 0;
    // "大浪把船抛离水面"单独一个开关：熔岩图有 4 道硬核裂谷，如果让 waveScale=1.65
    // 的浪尖随便把船顶起来，玩家站着不动也能腾空白嫖过谷（裂谷形同虚设）。
    // 关掉抛飞不影响浪面起伏 / 涌流漂移，也不影响其它地图。
    this.waveLaunchEnabled = true;
    // 自动轨道（锁定沿 spline 飞驰）：{ curve, t, length }
    this.onCoaster = null;
    // 出弯发喷回调：n=1 小喷 / n=2 双喷。只有本地船会被挂上（Game 侧过滤模式），
    // AI 的喷不该弹字。返回值没人用，纯通知。
    this.onDriftBoost = null;
    // "听者"船：远端船的氮气音要按到它的距离算音量/低通。Game 建船后指到本地船。
    this.listener = null;
    // 掉出赛道：坠落计时 / 闪烁计时（Game 写，视觉在 #applyPose 末尾消费）
    this.fallTimer = 0;
    this.blinkTimer = 0;
    // 冲出悬崖边缘的标记（Track.constrain 每帧写，Game 消费）
    this.overEdge = 0;
    // 断层火山带（熔岩图）：坠落计时（>0 = 正在掉进裂谷）
    this.faultFall = 0;
    // 跨过断层后的宽限（避免第一次起跳/重生后立刻二次判定）
    this.faultGrace = 0;
    // 起飞点用：上一次看到的门号，用来判断"刚过崖口"
    this.jumpGate = null;
    // 悬崖段放宽后的护栏半径（0 = 不放宽）
    this.edgeLimit = 0;
    // 腾空时的落地高度（赛道面）。由 Game 每帧写，null = 按海面波高落地
    this.surfaceLandingY = null;
    // 已通过的门号（Game 每帧写）：螺旋塔上下几层叠在同一片 x,z 上，
    // Track 的探测函数靠它只在门窗口里找中心线，否则会挑错层。
    this.gateHint = null;

    // 小喷系统（跑跑卡丁车式单喷/双喷）
    this.miniBoostQueue = 0;     // 待触发的小喷次数（1=单喷 2=双喷）
    this.miniBoostTimer = 0;     // 当前小喷剩余时间
    this.miniBoostGap = 0;       // 双喷两喷之间的间隔计时
    this.driftTime = 0;          // 本次漂移已持续时长（断漂补气窗口内不清零）
    this.driftCollided = false;  // 碰撞中断的漂移不能获得出弯小喷
    this.prevDriftKey = false;   // 上一帧 Shift 是否按下（检测新按键）
    this.driftDir = 0;           // 漂移方向（-1 左 / +1 右，跟着方向键连续更新）
    this.wasDrifting = false;    // 上一帧是否漂移（检测出弯瞬间）
    this.driftPhase = 0;
    this.driftCharge = 0;
    this.sparkLevel = 0;         // 漂移火花等级 0~3（无/蓝/橙/红）
    this.slipAngle = 0;          // 滑移角：车头与速度方向的夹角（甩尾程度）

    // —— 漂移连续量（2026-11-16 重做，见 DRIFT_TUNING 注释）——
    this.driftAngle = 0;         // 滑移角（rad，一阶状态）：>0 = 车头指向左/弯内
    this.driftWant = 0;          // 目标滑移角（由方向键给，含符号）
    this.driftMaxAngle = 0.6;    // 当前速度下的滑移角上限（拖曳减速要用）
    this.driftAnglePeak = 0;     // 本轮喷发周期内达到过的最大 |滑移角|
    this.driftPathYaw = 0;       // 轨迹偏航角速度（平滑量，rad/s）
    this.driftDA = 0;            // 本帧滑移角增量（车头要跟着同步转，轨迹不动）
    this.driftChain = 0;         // 断漂补气窗口剩余时间
    this.driftBreak = 0;         // 撞墙后的收角缓冲剩余时间
    this.driftBoostCd = 0;       // 发喷冷却
    this.driftLockout = 0;       // 撞墙后重新起漂的冷却
    this.driftGaugeStart = 0;    // 本次漂移开始时的集气量（撞墙时回退到此值）

    // 划桨状态
    this.strokePhase = 0;
    this.mixer = null;
    this.rowAction = null;
    this.oars = []; // 程序化桨 { node, baseX, baseY, baseZ, phase }
    // 多动作角色（牛来号）：动画状态机 + 表情形态键
    this.animMap = null;
    this.animCurrent = null;
    this.animKey = null;
    this.animClips = null;
    this.faceTargets = null;
    this.smileMix = 0;
    this.danceTimer = 0;
    this.isLeader = false;
    this.finished = false;

    // 碰撞后临时失控
    this.stunTimer = 0;
    // 船对船撞击后的「水里还在推」窗口：这段时间侧向抓地放松，
    // 否则冲量给的横向速度 1~2 帧就被水吃掉，读作"撞了却推不动"。
    this.impactGripTimer = 0;
    // 限速状态（BOSS 落雷用）：speedCapTimer > 0 时水平速度被硬压到 speedCap
    this.speedCap = 0;
    this.speedCapTimer = 0;
    // 漂浮手感开关（0=原来的跟手手感，1=有惯性/会滑的船上漂浮感）
    // 目前只在怪物模式打开，竞速/道具维持原样，试好了再推广
    this.floatMode = 0;
    this.angVel = 0;
    this.collisionRoll = 0;
    // 受击抖动剩余时长（BossMode 扣血时写入；每帧衰减，叠加在最终位姿上）
    this.hitShake = 0;
    // 撞墙反弹冷却：一次碰撞只在触发瞬间结算一次回弹，避免位置纠正帧
    // 连续触发导致速度被反复清零（这正是以前"撞墙像空气墙、只能倒退"的原因）。
    this.wallHitCooldown = 0;
    // 贴墙滑行窗口：Track.constrain 每帧在撞到护栏时刷新该计时器。
    // 窗口内放宽侧向抓地与滑移上限（像蹭到软胶路肩一样沿墙滑走），
    // 并允许近乎停住时照样打方向离开护栏（否则贴死墙后永远转不动）。
    this.wallContactTimer = 0;
    // 水面材质系数（冰区等特殊地面由 Game 每帧下发）：
    // grip 越小越滑，slip 越大允许的滑移角越大，driftGain 影响漂移攒气速度
    this.surfaceGrip = 1;
    this.surfaceSlip = 1;
    this.surfaceDriftGain = 1;
    // 冰壳区：非空时船贴这个高度走（水面已隐藏，不能再跟浪高浮沉）
    this.iceRideY = null;
    // Smooth short host corrections so local prediction does not jitter.
    this.networkCorrection = null;

    // 道具效果计时器
    this.sinkTimer = 0;    // 沉没（失控+下沉）
    this.spinTimer = 0;    // 漩涡打转
    // Authored model yaw must survive temporary visual effects such as spin.
    // Keep the effect as a separate offset instead of mutating modelRoot.y.
    this.visualRotationY = Number.isFinite(def.visualRotationY) ? def.visualRotationY : 0;
    this.visualSpinYaw = 0;
    this.slowTimer = 0;    // 减速（导弹/闪电）
    this.halfSpeedTimer = 0; // 减速艇：极速 ×0.5
    this.octoGrabTimer = 0;  // 章鱼怪：转向锁死 + 偏航拖拽 + 速度 ×0.7
    this.geyserLiftTimer = 0; // 深海瀑布：水柱冲上天空
    this.voidTimer = 0;      // 泡泡蜻蜓：被关进异世界（赛道消失）
    // 「鱼雷齐射」：被掀翻 —— 船体绕纵轴翻半圈再翻回来，期间失控
    this.capsizeTimer = 0;
    this.capsizeDur = 0;
    this.capsizeDir = 1;
    this.bubbleTimer = 0;  // 泡泡陷阱：限制转向，不直接减速
    this.shieldTimer = 0;  // 护盾免疫
    this.sinkY = 0;        // 沉没下沉量（视觉平滑）
    // 「漩涡」巨型水泡：吸空悬浮 → 计时结束后下坠回水面，落水速度归零重新加速
    this.bubbleLiftTimer = 0;
    this.bubbleFalling = false;
    this.bubbleWrap = null;
    this.bubbleWrapTimer = 0;  // 水泡特效独立寿命，兜底保证到期必收
    // 「方向转换器」：左右操控反转（由施放者之外的所有玩家施加）
    this.reverseControlTimer = 0;
    this.devilMark = null;
    this.shameMark = null;

    // 远程艇插值目标
    this.target = null;
    // 远端快照缓冲：{t, x, z, heading, speed, boosting, vx, vz, roll, y}
    // 原实现用指数平滑直接追最新快照，稳态滞后约 1/rate（12Hz → 83ms，
    // 40m/s 时落后约 3.3m），且平滑会把快照抖动放大成可见的顿挫。
    // 改为"延迟回放"：保留一小段快照历史，按 now - DELAY 取样插值，
    // 既消掉抖动，又把滞后锁定在一个可控的固定值。
    this.remoteSnaps = [];
    this.remoteClock = 0;

    this.group = new THREE.Group();
    // 船体水平轮廓（船体局部 XZ，+Z 船头）：赛道护栏拿它当碰撞线，
    // 船体边缘一碰到浮桶线就被拦（详见 utils/hull.js 顶部说明）。
    // 先用 hull 参数拼的兜底八边形，GLB 就位后再换成模型真实凸包。
    this.hullFootprint = fallbackHullOutline(def.hull);
    const fallbackRadius = Math.hypot(def.hull.width, 1.8, def.hull.length) * 0.5;
    this.effectEnvelope = {
      center: new THREE.Vector3(0, 0.7, 0),
      radius: fallbackRadius * 1.22,
    };
    this.#buildMesh(def);
    // 幽灵车：不建尾迹 / 接触阴影 / 名牌 —— 它只是一段回放，带水花和名字会很吵
    if (!this.isGhost) {
      this.#buildWake();
      this.#buildContactShadow(scene, def);
    }
    scene.add(this.group);

    if (!this.isGhost) {
      this.label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeLabelTexture(playerName, def.color),
        transparent: true, depthTest: false,
      }));
      // 名字牌放大一档：参考图里名字明显比船身小件大，且离船顶留一点空隙
      this.label.scale.set(4.6, 1.45, 1);
      this.label.position.y = 3.7;
      this.group.add(this.label);
    }
    // 护盾视觉由 Effekseer Barrior01 特效负责（Boat.js 不再叠加泡泡，避免双层罩）
  }

  /**
   * 应用道具/闪电效果
   * @param {string} fx nitro|shield|sink|spin|slow|ink
   * @param {number} dur 持续时间（秒）
   */
  applyFx(fx, dur = 0) {
    switch (fx) {
      case 'nitro':
        this.boostTimer = Math.max(this.boostTimer, 2.2);
        this.nitroLoopTimer = Math.max(this.nitroLoopTimer, 2.2);
        this.#playNitroSound();
        break;
      case 'shield': this.shieldTimer = dur || 3; break;
      case 'sink':
        this.sinkTimer = Math.max(this.sinkTimer, dur || 2);
        this.stunTimer = Math.max(this.stunTimer, dur || 2);
        this.vel.multiplyScalar(0.2);
        break;
      case 'spin': this.spinTimer = Math.max(this.spinTimer, dur || 1.5); break;
      case 'slow': this.slowTimer = Math.max(this.slowTimer, dur || 1); break;
      // 追踪导弹命中：减速 + 一记短促顿挫（0.5s）。
      // 之前导弹只给 slow（极速 ×0.4），没有姿态反馈，玩家体感"被擦了一下没炸到"。
      case 'missileHit':
        this.slowTimer = Math.max(this.slowTimer, dur || 1.8);
        this.stunTimer = Math.max(this.stunTimer, 0.5);
        this.vel.multiplyScalar(0.55);
        break;
      // 「鱼雷齐射」：掀翻 —— 船体侧翻半圈再翻回来，期间失控、速度几乎清零
      case 'capsize': {
        const d = dur || 1.2;
        if (this.capsizeTimer <= 0) this.capsizeDir = Math.random() < 0.5 ? -1 : 1;
        this.capsizeDur = Math.max(this.capsizeDur, d);
        this.capsizeTimer = Math.max(this.capsizeTimer, d);
        this.vel.multiplyScalar(0.12);
        this.speed *= 0.12;
        break;
      }
      // 减速艇：极速 ×0.5（区别于导弹的 ×0.4 slow），头顶挂红色汗颜标记
      case 'halfSpeed':
        this.halfSpeedTimer = Math.max(this.halfSpeedTimer, dur || 4);
        this.#ensureShameMark();
        break;
      // 追踪章鱼怪：触手缠身 → 转向锁死 + 拖拽偏航 + 速度 -30%
      case 'octoGrab':
        this.octoGrabTimer = Math.max(this.octoGrabTimer, dur || 2);
        this.stunTimer = Math.max(this.stunTimer, 0.15); // 一记顿挫，读作“被缠住”
        break;
      // 深海瀑布：水柱把艇冲上天空（复用漩涡的升空/下坠状态机，但不套水泡）
      case 'geyserLift':
        this.geyserLiftTimer = Math.max(this.geyserLiftTimer, dur || 3);
        this.bubbleFalling = false;
        this.airborne = true;
        this.onCoaster = null;
        break;
      // 泡泡蜻蜓：关进异世界 3 秒 —— 赛道里消失、位置冻结，3 秒后原地继续
      case 'void':
        this.voidTimer = Math.max(this.voidTimer, dur || 3);
        this.vel.set(0, 0);
        this.speed = 0;
        break;
      // 漩涡巨型水泡：吸到空中悬浮，倒计时结束后自行下坠
      case 'bubbleLift':
        this.bubbleLiftTimer = Math.max(this.bubbleLiftTimer, dur || 5);
        this.bubbleWrapTimer = (dur || 5) + BUBBLE_WRAP_FALL_GRACE;
        this.bubbleFalling = false;
        this.airborne = false;
        this.onCoaster = null;
        this.#ensureBubbleWrap();
        break;
      // 方向转换器：左右操控反转
      case 'reverse':
        this.reverseControlTimer = Math.max(this.reverseControlTimer, dur || 5);
        this.#ensureDevilMark();
        break;
      case 'ink': /* 墨汁仅本地 HUD 呈现，远程无需处理 */ break;
      case 'inkStun': // 墨鱼喷墨直接命中：短暂致盲失控
        this.stunTimer = Math.max(this.stunTimer, dur || 0.9);
        this.vel.multiplyScalar(0.55);
        break;
      case 'angel': // 天使庇佑：3秒无敌 + 清除全部负面 + 小加速
        this.shieldTimer = Math.max(this.shieldTimer, dur || 3);
        this.sinkTimer = 0;
        this.spinTimer = 0;
        this.slowTimer = 0;
        this.bubbleTimer = 0;
        this.magnetTimer = 0;
        this.magnetTarget = null;
        this.stunTimer = 0;
        this.bubbleLiftTimer = 0;
        this.bubbleFalling = false;
        this.bubbleWrapTimer = 0;
        this.reverseControlTimer = 0;   // 方向转换器一并清除
        this.halfSpeedTimer = 0;        // 减速艇
        this.octoGrabTimer = 0;         // 章鱼怪缠绕
        this.geyserLiftTimer = 0;       // 深海瀑布
        this.voidTimer = 0;             // 异世界
        this.capsizeTimer = 0;          // 鱼雷翻船
        this.group.visible = true;
        this.#clearBubbleWrap();
        this.boostTimer = Math.max(this.boostTimer, 1.2);
        break;
    }
  }

  #buildMesh(def) {
    // 程序化后备艇体（GLB 加载完成前显示）
    const fallback = new THREE.Group();
    this.#buildFallbackHull(fallback, def);
    this.group.add(fallback);
    this.fallbackHull = fallback;
    if (this.isGhost) this.#applyGhostLook(fallback);

    if (def.model) {
      loadModel(def.model).then((gltf) => {
        this.#setupGlbModel(gltf, def);
      }).catch((err) => {
        console.warn('GLB 模型加载失败，使用后备艇体', def.model, err);
      });
    }
  }

  #buildFallbackHull(parent, def) {
    const { length: L, width: W, bow: B } = def.hull;
    const hullMat = new THREE.MeshStandardMaterial({
      color: def.color, roughness: 0.35, metalness: 0.15, flatShading: true,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: def.colorAccent, roughness: 0.45, metalness: 0.1, flatShading: true,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x1c2733, roughness: 0.6, metalness: 0.3, flatShading: true,
    });

    const hull = new THREE.Mesh(new THREE.BoxGeometry(W, 0.85, L * 0.62), hullMat);
    hull.position.set(0, 0.1, -L * 0.14);
    parent.add(hull);

    const bow = new THREE.Mesh(new THREE.ConeGeometry(W * 0.48, B, 8), hullMat);
    bow.rotation.x = Math.PI / 2;
    bow.rotation.y = Math.PI;
    bow.position.set(0, 0.1, L * 0.17 + B * 0.5);
    parent.add(bow);

    const deck = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.22, L * 0.58), accentMat);
    deck.position.set(0, 0.58, -L * 0.14);
    parent.add(deck);

    const shield = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, 0.5, 0.14), darkMat);
    shield.position.set(0, 0.95, L * 0.1);
    shield.rotation.x = -0.35;
    parent.add(shield);

    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(W * 0.5, 0.35, 0.9), darkMat);
    cockpit.position.set(0, 0.75, -L * 0.02);
    parent.add(cockpit);

    const cowl = new THREE.Mesh(new THREE.BoxGeometry(W * 0.75, 0.55, L * 0.2), accentMat);
    cowl.position.set(0, 0.82, -L * 0.36);
    parent.add(cowl);

    if (def.id === 'falcon') {
      for (const side of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), hullMat);
        post.position.set(side * W * 0.3, 1.25, -L * 0.38);
        parent.add(post);
      }
      const wing = new THREE.Mesh(new THREE.BoxGeometry(W * 1.05, 0.1, 0.55), hullMat);
      wing.position.set(0, 1.62, -L * 0.38);
      wing.rotation.x = 0.12;
      parent.add(wing);
    }
  }

  /**
   * GLB 模型规整：缩放到艇长、转正朝向（艇头 → +Z）、入水深度微调
   */
  /**
   * 算出船体真实水平轮廓（船体局部 XZ 凸包，+Z = 船头，单位米）。
   *
   * 为什么不直接用 boats.js 的 hull.width/length：那是手填的近似值，
   * 和换装后的 GLB 常常对不上（双体艇、带尾翼的未来载具最明显）。
   * 这里直接读模型顶点 —— 玩家看到的船壳边缘，就是碰撞线本身。
   *
   * 开销：只在 GLB 装配完成时跑一次（130 万面模型也只用均匀抽样的 4000 点），
   * 不进每帧循环。
   *
   * @returns {Float32Array|null} 扁平点列；蒙皮角色 / 坏模型返回 null（用兜底轮廓）
   */
  #measureHullFootprint(root) {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const pts = [];
    let skinned = false;
    root.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      // 蒙皮网格的顶点是绑定姿势（牛来号实测偏小 2.31 倍），不能拿来当船体轮廓
      if (o.isSkinnedMesh) { skinned = true; return; }
      const attr = o.geometry?.attributes?.position;
      if (!attr || attr.count < 3) return;
      m.multiplyMatrices(inv, o.matrixWorld);
      const stride = Math.max(1, Math.floor(attr.count / 4000));
      for (let i = 0; i < attr.count; i += stride) {
        v.fromBufferAttribute(attr, i).applyMatrix4(m);
        pts.push(v.x, v.z);
      }
    });
    if (skinned || pts.length < 6) return null;
    const outline = simplifyOutline(convexHull2D(Float32Array.from(pts)), 16, 0.06);
    const ext = outlineExtents(outline);
    // 兜底校验：轮廓盖不住船体（空网格 / 只有装饰粒子）就退回 hull 参数轮廓
    if (!(ext.halfW > 0.15) || !(ext.halfLen > 0.3)) return null;
    return outline;
  }

  #setupGlbModel(gltf, def) {
    // 带蒙皮的模型（例如牛来号）必须用 SkeletonUtils 克隆，
    // 否则多艘同款船会共享同一副骨骼，动作会互相串。
    const hasSkin = gltf.scene.getObjectByProperty('isSkinnedMesh', true) !== undefined;
    const model = hasSkin ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
    model.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
      }
    });
    // 可选：隐藏挡住追尾视角的部件（例如维京长船的大方帆，会糊满半个屏幕）。
    // 在算包围盒之前隐藏，缩放/水线才会按"剩下的船体"来算。
    if (Array.isArray(def.hideNodes)) {
      for (const pattern of def.hideNodes) {
        const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
        model.traverse((obj) => { if (re.test(obj.name)) obj.visible = false; });
      }
    }

    // 1) 计算包围盒（用于缩放）
    // 蒙皮模型必须用蒙皮感知的包围盒：geometry.boundingBox 是绑定姿势，
    // 牛来号实测偏小 2.31 倍，按它定标会缩出一头 5m 高的巨兽。
    const box = measureModelBox(model);
    const size = box.getSize(new THREE.Vector3());
    const fwdLen = Math.max(size.x, size.z); // 模型前进方向长度
    // 默认按"船长"定标；竖着站的角色（如牛来号）按身高定标，否则会被拉长成怪物。
    const scale = def.fitTo === 'height'
      ? (Number.isFinite(def.fitHeight) ? def.fitHeight : 2.6) / (size.y || 1)
      : def.hull.length / (fwdLen || 1) * (def.modelScale || 1);
    model.scale.setScalar(scale);
    // 2) 找"船头标记节点"，按船头相对模型中心的偏移判断朝向长轴
    //    （X 轴朝前的模型转 ±90°，Z 轴朝前的模型不转/转 180°——修复部分模型横向问题）
    let bowNode = null;
    model.traverse((obj) => {
      if (!bowNode && /bow/i.test(obj.name)) bowNode = obj;
    });
    const center = box.getCenter(new THREE.Vector3()).multiplyScalar(scale);
    if (Number.isFinite(def.modelRotationX) || Number.isFinite(def.modelRotationY)) {
      model.rotation.x = Number.isFinite(def.modelRotationX) ? def.modelRotationX : 0;
      model.rotation.y = Number.isFinite(def.modelRotationY) ? def.modelRotationY : 0;
    } else if (bowNode) {
      model.updateMatrixWorld(true);
      const p = new THREE.Vector3();
      bowNode.getWorldPosition(p); // 此刻 rotation 仍是原始值
      const dx = p.x - center.x;
      const dz = p.z - center.z;
      if (Math.abs(dx) > Math.abs(dz)) {
        // 长轴 X：前进轴 X → +Z
        model.rotation.y = dx > 0 ? -Math.PI / 2 : Math.PI / 2;
      } else {
        // 长轴 Z：直接前进或反向
        model.rotation.y = dz > 0 ? 0 : Math.PI;
      }
    } else {
      // 无船头标记：按包围盒长轴推断
      model.rotation.y = size.x > size.z ? -Math.PI / 2 : 0;
    }
    const wrap = new THREE.Group();
    wrap.add(model);
    // Keep an authored visual rotation outside the animated GLB hierarchy.
    // Animation clips can reset their root node, but cannot overwrite this wrapper.
    wrap.rotation.y = this.visualRotationY;

    // 4) 重新居中（XZ 平面），并让水线位于 y≈0 附近
    model.updateMatrixWorld(true);
    const box2 = measureModelBox(wrap);
    const center2 = box2.getCenter(new THREE.Vector3());
    model.position.x -= center2.x;
    model.position.z -= center2.z;
    // 船底略微入水
    model.position.y -= box2.min.y * 0.35;
    model.position.y += Number.isFinite(def.modelLiftY) ? def.modelLiftY : 0;

    // Defensive effects use the loaded hull's real extents, including raised
    // cabins, masts and modelScale. Keep a margin so animated parts stay inside.
    wrap.updateMatrixWorld(true);
    const fittedBox = measureModelBox(wrap);
    const fittedSize = fittedBox.getSize(new THREE.Vector3());
    this.effectEnvelope = {
      center: fittedBox.getCenter(new THREE.Vector3()),
      radius: fittedSize.length() * 0.5 * 1.22,
    };
    // 真实船体轮廓：模型顶点投影到 XZ 求凸包。护栏（Track.constrain）之后
    // 直接拿这些点当采样点 —— 船体哪里最外，碰撞线就在哪里。
    const footprint = this.#measureHullFootprint(wrap);
    if (footprint) this.hullFootprint = footprint;

    this.group.add(wrap);
    this.modelRoot = wrap;
    // 氮气喷口锚点：tripo 导出的船体被合并成单节点，没有 nozzle/engine 节点可挂，
    // 这里按实际包围盒在船尾取「左 / 中 / 右」三点。锚点挂在 group 上，
    // 所以横滚、俯仰、腾空都会跟着船体走，特效不会漂在船外。
    const halfW = Math.max(0.2, fittedSize.x * 0.5 * 0.42);
    // 稍微探出船尾：喷口特效中心若埋在船体里，会被船壳挡掉大半
    const sternZ = fittedBox.min.z - fittedSize.z * 0.02;
    const nozzleY = fittedBox.min.y + fittedSize.y * 0.4;
    this.nitroNozzles = [0, 1, 2].map((i) => {
      const node = new THREE.Object3D();
      node.position.set((i - 1) * halfW, nozzleY, sternZ);
      this.group.add(node);
      return node;
    });
    // GLB 就位后隐藏后备艇体
    if (this.fallbackHull) this.fallbackHull.visible = false;

    // 5) 划桨 / 角色动画
    // 原始剪辑留着：领奖台要拿它给克隆体单独起一个 mixer（克隆体不能复用本船的 action）
    this.animClips = gltf.animations ? [...gltf.animations] : [];
    if (gltf.animations && gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      const byName = {};
      for (const clip of gltf.animations) byName[clip.name] = clip;
      // def.anim 存在 → 多动作角色（走 / 氮气冲刺 / 领奖台跳舞），按状态切换
      if (def.anim && Object.keys(def.anim).length) {
        this.animMap = {};
        for (const key of Object.keys(def.anim)) {
          const clip = byName[def.anim[key]];
          if (!clip) continue;
          const act = this.mixer.clipAction(clip);
          act.setLoop(THREE.LoopRepeat, Infinity);
          act.enabled = true;
          this.animMap[key] = act;
        }
        this.animCurrent = null;
        this.animKey = null;
        this.#playAnim('walk', 0);
        // 表情形态键（例如牛来号的 smile）：拿到 mesh + 索引，运行时直接插值
        this.faceTargets = [];
        model.traverse((obj) => {
          if (obj.isMesh && obj.morphTargetDictionary && def.smileMorph) {
            const idx = obj.morphTargetDictionary[def.smileMorph];
            if (idx !== undefined) this.faceTargets.push({ mesh: obj, index: idx });
          }
        });
        this.smileMix = 0;
      } else {
        // 模型自带划桨动画：用 AnimationMixer，桨频随速度
        this.rowAction = this.mixer.clipAction(gltf.animations[0]);
        this.rowAction.play();
        this.mixer.timeScale = 0;
      }
    } else {
      // 无动画：程序化摆桨（按名称找桨节点）
      const oarNames = [];
      model.traverse((obj) => {
        if (obj.name && /oar/i.test(obj.name) && obj.children.length > 0) {
          oarNames.push(obj);
        }
      });
      this.oars = oarNames.map((node, i) => ({
        node,
        baseX: node.rotation.x,
        baseY: node.rotation.y,
        baseZ: node.rotation.z,
        // 同步桨（真实赛艇所有桨手同时入水），给微小相位差更自然
        phase: i * 0.12,
      }));
    }
    // GLB 就位后再染一次：模型材质与后备体是两套，只染一套会看到「外壳透明、内胎实心」
    if (this.isGhost) this.#applyGhostLook(this.modelRoot || this.group);
  }

  /**
   * 幽灵外观：半透明青白。
   *
   * 为什么要 clone 材质：GLB 的材质在 `gltf.scene.clone(true)` 里是**共享引用**，
   * 直接改 opacity 会把旁边那艘真船（同模型）一起改透明。
   * depthWrite=false 是必须的：不关深度写入时，半透明船体各网格互相遮挡，
   * 近处的桅杆会切掉远处的船壳，看起来像缺了一块。
   */
  #applyGhostLook(root) {
    if (!root) return;
    const tint = new THREE.Color(0xbfefff);
    root.traverse((obj) => {
      if (!obj.isMesh || obj.userData.__ghostMat) return;
      obj.userData.__ghostMat = true;
      obj.castShadow = false;
      obj.receiveShadow = false;
      const dress = (m) => {
        if (!m) return m;
        const c = m.clone();
        c.transparent = true;
        // 0.45：实测 0.30 在晴天的深蓝水面上只剩一团模糊的亮斑，
        // 玩家读不出"这是我的船"。再往高走（0.6+）就会和真船抢视觉。
        c.opacity = 0.45;
        c.depthWrite = false;
        c.side = THREE.DoubleSide;
        if (c.color) c.color.lerp(tint, 0.62);
        if (c.emissive) {
          c.emissive.copy(tint);
          c.emissiveIntensity = 0.32;
        }
        if ('roughness' in c) c.roughness = 0.55;
        if ('metalness' in c) c.metalness = 0.08;
        return c;
      };
      obj.material = Array.isArray(obj.material)
        ? obj.material.map(dress)
        : dress(obj.material);
    });
  }

  /** World-space center and Effekseer multiplier for hull-enclosing effects. */
  getEffectEnvelope() {
    const localCenter = this.effectEnvelope?.center || new THREE.Vector3(0, 0.7, 0);
    const center = localCenter.clone();
    this.group.updateMatrixWorld(true);
    this.group.localToWorld(center);
    const radius = this.effectEnvelope?.radius || 3;
    const uniformScale = Math.max(1.15, radius / 2.05);
    return { x: center.x, y: center.y, z: center.z, scale: uniformScale };
  }

  /**
   * 划桨 / 角色动画更新：桨频与速度挂钩（物理上：速度越快桨频越高）
   */
  #updateRowing(dt, throttle) {
    const moving = this.speed > 0.8;

    // 多动作角色：按状态在 走路 / 氮气冲刺 / 领奖台跳舞 之间交叉淡化
    if (this.animMap) {
      this.danceTimer = Math.max(0, (this.danceTimer || 0) - dt);
      let key = 'walk';
      if (this.danceTimer > 0) key = 'dance';
      else if (this.isLeader && this.finished) key = 'dance';   // 冲线第一名：领奖台动作
      else if (this.boostTimer > 0) key = 'boost';
      this.#playAnim(key, key === 'boost' ? 0.08 : 0.20);

      let rate = 1;
      if (key === 'walk') {
        // 走路步频跟速度走，站着时慢速踩步（有呼吸感，不会像木桩）
        rate = moving ? 0.9 + (this.speed / this.def.maxSpeed) * 1.1 : 0.35;
      }
      this.mixer.timeScale = THREE.MathUtils.lerp(this.mixer.timeScale, rate, Math.min(1, dt * 6));
      this.mixer.update(dt);
      this.#updateFace(dt);
      return;
    }

    const targetRate = moving ? 0.9 + (this.speed / this.def.maxSpeed) * 2.2 : 0;

    if (this.mixer) {
      // 平滑过渡桨频，避免突变
      const cur = this.mixer.timeScale;
      this.mixer.timeScale = THREE.MathUtils.lerp(cur, targetRate, Math.min(1, dt * 4));
      this.mixer.update(dt);
    } else if (this.oars.length) {
      if (targetRate > 0) {
        this.strokePhase += dt * targetRate * Math.PI * 2 * 0.5;
        const A = Math.min(0.55, 0.25 + this.speed * 0.015);
        for (const oar of this.oars) {
          const s = Math.sin(this.strokePhase + oar.phase);
          const c = Math.cos(this.strokePhase + oar.phase);
          // 水平扫桨（绕 Y）+ 入水/出水倾角（绕 X）
          oar.node.rotation.y = oar.baseY + s * A;
          oar.node.rotation.x = oar.baseX + Math.max(0, c) * A * 0.45;
        }
      }
    }
  }

  /**
   * 切换角色动画（多动作模型专用）：带交叉淡化，切过去不会"跳一格"。
   * 同一个动作重复调用直接返回，避免每帧 reset 把动画卡在第 0 帧。
   */
  #playAnim(key, fade = 0.18) {
    const next = this.animMap?.[key];
    if (!next || next === this.animCurrent) return;
    const prev = this.animCurrent;
    next.reset();
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.play();
    if (prev) {
      if (fade > 0) next.crossFadeFrom(prev, fade, false);
      else prev.stop();
    }
    this.animCurrent = next;
    this.animKey = key;
  }

  /**
   * 表情形态键：领先且还在跑时把 smile 推到 1，其余渐回 0。
   * 只有带 smileMorph 的角色模型才有 faceTargets，其他船是空操作。
   */
  #updateFace(dt) {
    if (!this.faceTargets || !this.faceTargets.length) return;
    const want = (this.isLeader && !this.finished && this.speed > 0.5) ? 1 : 0;
    this.smileMix = THREE.MathUtils.lerp(this.smileMix, want, Math.min(1, dt * 3.5));
    for (const f of this.faceTargets) {
      if (f.mesh.morphTargetInfluences) f.mesh.morphTargetInfluences[f.index] = this.smileMix;
    }
  }

  /** 领奖台动作：让角色模型跳一段舞（对没有 dance 动作的船是空操作） */
  playDance(seconds = 4) {
    if (!this.animMap?.dance) return;
    this.danceTimer = Math.max(this.danceTimer || 0, seconds);
  }

  /**
   * 接触阴影：船底一片贴水的软阴影（程序化圆斑贴图 + 半透明黑平面）。
   * 不开 SSAO 的前提下，这是让船"压在水面"而不是浮在空中的最省做法：
   * 只多一张透明片，1 次 draw call、贴图 128 且全队共享。
   */
  #buildContactShadow(scene, def) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: getContactShadowTexture(),
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      color: 0x0c1014,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.set(def.hull.width * 2.1, 1, def.hull.length * 1.3);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    scene.add(mesh);
    this.contactShadow = mesh;
  }

  #buildWake() {
    const tex = getWakeTexture();
    this.wakePool = [];
    this.wakeIndex = 0;
    this.wakeGeometry = new THREE.PlaneGeometry(1, 1);
    this.wakeGeometry.rotateX(-Math.PI / 2);
    this.wakeCrestGeometry = new THREE.PlaneGeometry(1, 1);
    // A short rolling trail only needs a few dozen live segments. Keeping a
    // compact pool is important because every boat owns its own wake meshes.
    const POOL = 56;
    for (let i = 0; i < POOL; i++) {
      const s = new THREE.Mesh(this.wakeGeometry, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false,
        color: 0x168dca,
      }));
      s.visible = false;
      s.renderOrder = 1;
      this.scene.add(s);
      const crest = new THREE.Mesh(this.wakeCrestGeometry, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0, depthWrite: false,
        side: THREE.DoubleSide,
      }));
      crest.visible = false;
      crest.renderOrder = 2;
      this.scene.add(crest);
      this.wakePool.push({
        sprite: s, crest, life: 0, maxLife: 0.68, width: 1, length: 1,
        crestWidth: 1, crestHeight: 1,
      });
    }
    this.wakeTimer = 0;

    // 漂移水痕（轮胎印式长条）：平铺水面的彩色拖痕，漂移时留在船体两侧
    // 颜色随火花等级变化（白→蓝→橙→红），QQ飞车火花胎印
    const mkTex = getDriftMarkTexture();
    const mkGeo = new THREE.PlaneGeometry(1.0, 3.0);
    mkGeo.rotateX(-Math.PI / 2); // 放平，长边沿船轴
    this.markPool = [];
    this.markIndex = 0;
    this.markTimer = 0;
    const MPOOL = 48;
    for (let i = 0; i < MPOOL; i++) {
      const m = new THREE.Mesh(mkGeo, new THREE.MeshBasicMaterial({
        map: mkTex, transparent: true, opacity: 0, depthWrite: false,
      }));
      m.visible = false;
      m.renderOrder = 1;
      this.scene.add(m);
      this.markPool.push({ mesh: m, life: 0, maxLife: 4.5 });
    }

    // 抛物线水滴：船首/船侧甩出的白色水珠（玩家中高速与漂移时出现）。
    // Pooling avoids allocations in the render loop and makes cleanup deterministic.
    this.splashPool = [];
    this.splashIndex = 0;
    const splashMat = getSplashTexture();
    for (let i = 0; i < 40; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: splashMat, transparent: true, opacity: 0, depthWrite: false,
        color: 0xe8faff,
      }));
      s.visible = false;
      s.renderOrder = 2;
      this.scene.add(s);
      this.splashPool.push({
        sprite: s, life: 0, maxLife: 0.32, vx: 0, vy: 0, vz: 0,
        baseOpacity: 0.7, width: 0.05, height: 0.2,
      });
    }
    this.splashTimer = 0;

    // 水雾：浪花最外层飘散的一层半透明颗粒（比水滴大、比水滴淡）
    this.mistPool = [];
    this.mistIndex = 0;
    const mistMat = getMistTexture();
    for (let i = 0; i < 18; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: mistMat, transparent: true, opacity: 0, depthWrite: false,
        color: 0xf0fbff,
      }));
      s.visible = false;
      s.renderOrder = 1;
      this.scene.add(s);
      this.mistPool.push({
        sprite: s, life: 0, maxLife: 0.8, vx: 0, vy: 0, vz: 0,
        baseOpacity: 0.16, width: 0.6, height: 0.6,
      });
    }
  }

  #spawnDriftSplash() {
    if (!this.splashPool?.length || this.pos.y < -1.5) return;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const sideX = fz;
    const sideZ = -fx;
    const side = this.driftDir || 1;
    const p = this.splashPool[this.splashIndex];
    this.splashIndex = (this.splashIndex + 1) % this.splashPool.length;
    const spread = this.def.hull.width * 0.42 + Math.random() * 0.6;
    const stern = this.def.hull.length * 0.42;
    p.sprite.position.set(
      this.pos.x - fx * stern + sideX * side * spread,
      this.pos.y + 0.16,
      this.pos.z - fz * stern + sideZ * side * spread,
    );
    p.width = 0.09 + Math.random() * 0.06;
    p.height = 0.38 + Math.random() * 0.28;
    p.sprite.scale.set(p.width, p.height, 1);
    p.sprite.material.color.copy(this.wakeColor.crest)
      .multiplyScalar(this.wakeLight * (0.9 + Math.random() * 0.2));
    p.sprite.material.opacity = p.baseOpacity = 0.56 + Math.random() * 0.2;
    p.sprite.visible = true;
    p.life = p.maxLife = 0.22 + Math.random() * 0.14;
    p.vx = sideX * side * (2.2 + Math.random() * 2.2) - fx * (0.9 + Math.random() * 1.1);
    p.vz = sideZ * side * (2.2 + Math.random() * 2.2) - fz * (0.9 + Math.random() * 1.1);
    p.vy = 1.4 + Math.random() * 1.4;
  }

  /** 漂移泡沫尾迹贴片：白色弧形泡沫，漂移时沿轨迹留在船体两侧 */
  #spawnDriftMark(x, z, heading, side, speed = this.speed) {
    const mk = this.markPool[this.markIndex];
    this.markIndex = (this.markIndex + 1) % this.markPool.length;
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const offX = fz * side * this.def.hull.width * 0.30;
    const offZ = -fx * side * this.def.hull.width * 0.30;
    mk.mesh.position.set(x + offX - fx * this.def.hull.length * 0.18, 0.18, z + offZ - fz * this.def.hull.length * 0.18);
    mk.mesh.rotation.y = heading;
    mk.mesh.visible = true;
    mk.life = mk.maxLife;
    // 高速时泡沫更宽更白（火花等级只影响亮度，不再换颜色）
    const v = Math.min(1.2, speed / (this.def.maxSpeed || 30));
    // 两条水痕贴得近、压得宽：叠成一条泡沫带，而不是两条平行白轨
    mk.mesh.scale.set(1.2 + v * 0.9, 1, 0.9 + v * 0.4);
    mk.mesh.material.color.copy(this.wakeColor.crest).multiplyScalar(this.wakeLight);
    mk.baseOpacity = Math.min(0.32, 0.12 + v * 0.16 + this.sparkLevel * 0.03);
    mk.mesh.material.opacity = mk.baseOpacity;
  }

  #updateDriftMarks(dt) {
    for (const mk of this.markPool) {
      if (!mk.mesh.visible) continue;
      mk.life -= dt;
      if (mk.life <= 0) { mk.mesh.visible = false; continue; }
      // 前段保持亮度，尾段随时间淡出（长拖轨迹感）
      mk.mesh.material.opacity = (mk.baseOpacity ?? 0.34) * Math.min(1, mk.life / mk.maxLife * 2.5);
    }
  }

  /**
   * 落水/冲撞的爆发水花：一圈水滴 + 一层水雾。
   * intensity 1 = 普通落水，2~2.5 = 瀑布那种高位砸下来。
   * （这个函数之前是空实现，所以"下瀑布掀水花"从来没生效过）
   */
  #splashBurst(intensity = 1) {
    if (!this.detail || !this.isLocal) return;
    if (!this.splashPool?.length) return;
    const k = Math.max(0.4, Math.min(3, intensity));
    const drops = Math.round(24 * k);
    const mists = Math.round(9 * k);
    const r0 = 0.7 + 0.5 * k;
    for (let i = 0; i < drops; i++) {
      const a = (i / drops) * Math.PI * 2 + Math.random() * 0.4;
      const sp = (2.0 + Math.random() * 3.4) * k;
      this.#emitDrop(
        this.pos.x + Math.cos(a) * r0,
        this.pos.z + Math.sin(a) * r0,
        Math.cos(a) * sp, Math.sin(a) * sp,
        (2.4 + Math.random() * 3.6) * Math.min(1.7, k),
        0.5 + 0.22 * Math.min(1, k),
      );
    }
    for (let i = 0; i < mists; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.9 + Math.random() * 1.9) * k;
      this.#emitMist(
        this.pos.x + Math.cos(a) * (r0 + 0.4),
        this.pos.z + Math.sin(a) * (r0 + 0.4),
        Math.cos(a) * sp, Math.sin(a) * sp,
        (1.1 + Math.random() * 1.8) * Math.min(1.6, k),
        0.26 + 0.18 * Math.min(1, k),
      );
    }
  }

  /** 一颗抛物线水滴：位置、水平速度、竖直初速、尺寸、透明度 */
  #emitDrop(x, z, vx, vz, vy, opacity) {
    const p = this.splashPool[this.splashIndex];
    this.splashIndex = (this.splashIndex + 1) % this.splashPool.length;
    p.sprite.position.set(x, this.pos.y + 0.18, z);
    p.width = 0.05 + Math.random() * 0.04;
    p.height = 0.16 + Math.random() * 0.18;
    p.sprite.scale.set(p.width, p.height, 1);
    p.sprite.material.color.copy(this.wakeColor.crest)
      .multiplyScalar(this.wakeLight * (0.9 + Math.random() * 0.2));
    p.sprite.material.opacity = p.baseOpacity = opacity * (0.6 + Math.random() * 0.4);
    p.sprite.visible = true;
    p.life = p.maxLife = 0.3 + Math.random() * 0.24;
    p.vx = vx;
    p.vz = vz;
    p.vy = vy;
  }

  /** 一团水雾：先飘起再缓缓落下，比水滴大得多也淡得多 */
  #emitMist(x, z, vx, vz, vy, opacity) {
    const p = this.mistPool[this.mistIndex];
    this.mistIndex = (this.mistIndex + 1) % this.mistPool.length;
    p.sprite.position.set(x, this.pos.y + 0.3, z);
    const size = 0.55 + Math.random() * 0.45;
    p.width = size;
    p.height = size * 0.8;
    p.sprite.scale.set(p.width, p.height, 1);
    p.sprite.material.color.copy(this.wakeColor.crest).multiplyScalar(this.wakeLight);
    p.sprite.material.opacity = p.baseOpacity = opacity * (0.7 + Math.random() * 0.5);
    p.sprite.visible = true;
    p.life = p.maxLife = 0.55 + Math.random() * 0.45;
    p.vx = vx;
    p.vz = vz;
    p.vy = vy;
  }

  /**
   * 船首两侧甩出的水滴与水雾：只有玩家才开（AI 简化，避免同屏粒子爆炸）。
   * v 为速度比 0~1.25，决定数量、速度与高度。
   */
  #emitSideSpray(v) {
    if (!this.detail || !this.isLocal) return;
    // 高速下落（瀑布段）：持续撕水花，落地时再来一记大的
    if (this.diveVel < -5) {
      // 每 4 帧撕一次，避免每帧都爆（池子会被打空）
      this._fallSprayN = (this._fallSprayN || 0) + 1;
      if (this._fallSprayN % 4 === 0) this.#splashBurst(0.5);
    } else {
      this._fallSprayN = 0;
    }
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const sideX = fz;
    const sideZ = -fx;
    // 船首/船中：速度越高越靠前，水墙越靠后
    const bowX = this.pos.x + fx * this.def.hull.length * 0.5;
    const bowZ = this.pos.z + fz * this.def.hull.length * 0.5;
    const drops = Math.min(6, Math.round(v * 5));
    for (let i = 0; i < drops; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const spread = this.def.hull.width * (0.35 + Math.random() * 0.4);
      // 船只前进带走了水珠：水珠相对船体是向后飞的
      this.#emitDrop(
        bowX + sideX * side * spread - fx * Math.random() * 0.8,
        bowZ + sideZ * side * spread - fz * Math.random() * 0.8,
        sideX * side * (1.4 + v * 3.2) + fx * this.speed * 0.28,
        sideZ * side * (1.4 + v * 3.2) + fz * this.speed * 0.28,
        (1.2 + v * 2.8) * (0.7 + Math.random() * 0.6),
        0.35 + v * 0.45,
      );
    }
    // 两道半透明水幕：高速时船首两侧各挂一层薄雾
    if (v > 0.5) {
      const puffs = v > 0.85 ? 2 : 1;
      for (let i = 0; i < puffs; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const spread = this.def.hull.width * 0.55;
        this.#emitMist(
          bowX + sideX * side * spread - fx * 0.6,
          bowZ + sideZ * side * spread - fz * 0.6,
          sideX * side * (0.8 + v * 1.4) + fx * this.speed * 0.3,
          sideZ * side * (0.8 + v * 1.4) + fz * this.speed * 0.3,
          0.4 + v * 0.6,
          0.03 + v * 0.08,
        );
      }
    }
  }

  /**
   * 漩涡巨型水泡：被裹住的船体外包一层肥皂泡质感的壳，
   * 外加一圈上下浮沉的小水泡 + 中心辉光，读作「整个人被吹成了一颗泡」。
   * 挂在 group 下，随船体姿态一起动，不需要每帧同步世界坐标。
   */
  #ensureBubbleWrap() {
    if (this.bubbleWrap) {
      this.bubbleWrap.visible = true;
      return;
    }
    const g = new THREE.Group();
    const shellMat = makeBubbleMaterial({ tint: 0x9ae8ff, opacity: 1.0, rim: 1.5 });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(2.7, 40, 28), shellMat);
    shell.position.y = 0.75;
    g.add(shell);

    const innerMat = makeBubbleMaterial({ tint: 0xd4f8ff, opacity: 0.5, rim: 0.9, phase: 2.1 });
    const inner = new THREE.Mesh(new THREE.SphereGeometry(2.25, 28, 20), innerMat);
    inner.position.y = 0.75;
    g.add(inner);

    // 环绕船身上升的小水泡：固定相位，每帧按相位算位置，避免随机抖动
    const spots = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r = 0.24 + (i % 5) * 0.16;
      const mat = makeBubbleMaterial({ tint: 0xbdf2ff, opacity: 0.9, rim: 1.2, phase: i * 0.8 });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat);
      g.add(mesh);
      spots.push({
        mesh, mat, a,
        ring: 1.55 + (i % 3) * 0.42,
        y0: (i / 14) * 3.6 - 0.4,
        speed: 0.35 + (i % 4) * 0.12,
      });
    }

    // 中心辉光：加色软球，给泡内体积感
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x7fe4ff, transparent: true, opacity: 0.18,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.5, 18, 12), glowMat);
    glow.position.y = 0.75;
    g.add(glow);

    g.userData = {
      shell, inner, glow, spots,
      mats: [shellMat, innerMat, glowMat, ...spots.map((s) => s.mat)],
    };
    this.group.add(g);
    this.bubbleWrap = g;
  }

  #updateBubbleWrap(t) {
    const g = this.bubbleWrap;
    if (!g) return;
    const ud = g.userData;
    for (const m of ud.mats) if (m.uniforms) m.uniforms.uTime.value = t;

    // 小水泡绕船螺旋上升，出顶后从底部循环
    for (const s of ud.spots) {
      const y = ((s.y0 + t * s.speed) % 3.6 + 3.6) % 3.6 - 0.4;
      const wob = Math.sin(t * 2.2 + s.a * 2) * 0.16;
      const rad = s.ring + wob;
      s.mesh.position.set(Math.cos(s.a + y * 0.7) * rad, y, Math.sin(s.a + y * 0.7) * rad);
      s.mesh.scale.setScalar(0.8 + (y + 0.4) / 3.6 * 0.5);
    }

    const pulse = 1 + Math.sin(t * 3.6) * 0.035;
    ud.shell.scale.setScalar(pulse);
    ud.inner.scale.setScalar(2 - pulse);     // 内外反向缩放 → 薄膜看起来在呼吸
    ud.glow.material.opacity = 0.16 + Math.sin(t * 3.6) * 0.05;
  }

  #clearBubbleWrap() {
    if (!this.bubbleWrap) return;
    this.bubbleWrap.visible = false;
  }

  /** 方向转换器：被反转操控期间头顶飘一个小恶魔 */
  #ensureDevilMark() {
    if (this.devilMark) {
      this.devilMark.visible = true;
      return;
    }
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xff4a5a, depthTest: false });
    // 一对小犄角
    for (const s of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.62, 6), mat);
      horn.position.set(s * 0.24, 0.24, 0);
      horn.rotation.z = s * -0.5;
      g.add(horn);
    }
    // 恶魔头
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), mat);
    g.add(head);
    const eyes = new THREE.MeshBasicMaterial({ color: 0xfff0a0, depthTest: false });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), eyes);
      e.position.set(s * 0.13, 0.06, 0.3);
      g.add(e);
    }
    g.position.y = 2.6;
    g.renderOrder = 999;
    this.group.add(g);
    this.devilMark = g;
  }

  #updateDevilMark(t) {
    const g = this.devilMark;
    if (!g) return;
    g.visible = this.reverseControlTimer > 0;
    if (!g.visible) return;
    // 悬浮 + 轻微摇晃，读作"被附身"而不是模型的一部分
    g.position.y = 2.6 + Math.sin(t * 3.4) * 0.16;
    g.rotation.z = Math.sin(t * 2.6) * 0.18;
    g.rotation.y = t * 1.6;
  }

  /** 减速艇：被减速期间头顶挂一滴红色汗颜/汗珠，读作“被打到手忙脚乱” */
  #ensureShameMark() {
    if (this.shameMark) {
      this.shameMark.visible = true;
      return;
    }
    const g = new THREE.Group();
    const red = new THREE.MeshBasicMaterial({ color: 0xff3b4a, depthTest: false });
    // 汗滴主体（倒锥 + 球，读作一大滴汗）
    const drop = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 10), red);
    drop.scale.set(0.78, 1.12, 0.78);
    g.add(drop);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.5, 8), red);
    tip.position.y = 0.46;
    g.add(tip);
    // 两侧红色汗线（经典“汗颜”三道）
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const line = new THREE.Mesh(
          new THREE.BoxGeometry(0.07, 0.3 + i * 0.12, 0.07),
          red,
        );
        line.position.set(s * (0.46 + i * 0.16), 0.22 - i * 0.16, 0);
        line.rotation.z = s * (0.5 + i * 0.3);
        g.add(line);
      }
    }
    g.position.y = 2.55;
    g.renderOrder = 999;
    this.group.add(g);
    this.shameMark = g;
  }

  #updateShameMark(t) {
    const g = this.shameMark;
    if (!g) return;
    g.visible = this.halfSpeedTimer > 0;
    if (!g.visible) return;
    // 汗滴上下点动 + 左右摆，像在“滴汗”
    g.position.y = 2.55 + Math.sin(t * 5.2) * 0.12;
    g.rotation.z = Math.sin(t * 4.4) * 0.22;
    g.rotation.y = Math.sin(t * 1.8) * 0.3;
  }

  #clearDriftOverlay() {
    for (const w of this.wakePool) w.sprite.visible = false;
  }

  /**
   * 按本轮漂移的**峰值滑移角**发喷：≥30° 双喷，≥16° 单喷，没到就没喷。
   * 撞过东西（driftCollided）不发喷；发完把峰值清零 → 下一次要重新漂到那个角度，
   * 所以"连喷"必须真的把车头重新甩出去，不能原地连点刷喷。
   */
  #grantDriftBoost() {
    const peak = this.driftAnglePeak;
    const held = this.driftTime;
    this.driftAnglePeak = 0;
    this.driftWant = 0;
    if (this.driftCollided || this.driftBoostCd > 0) return 0;
    const n = driftBoostCount(held, peak);
    if (n === 0) return 0;
    this.miniBoostQueue = Math.max(this.miniBoostQueue, n);
    this.miniBoostGap = 0;
    this.driftBoostCd = DRIFT_TUNING.boostCooldown;
    this.driftPhase = 2;
    if (this.isLocal) audio.play(n > 1 ? 'drift_boost2' : 'drift_boost');
    // 只在"授予"这一刻通知一次：双喷的两次喷是排队连续触发的，
    // 挂到队列里每一喷都报一次会变成"双喷成功 ×2"。
    if (this.onDriftBoost) this.onDriftBoost(n);
    return n;
  }

  /**
   * 氮气冲刺音（2026-11-19 换成玩家提供的 3 秒成品「氮气冲刺.wav」）。
   *
   * 三条硬要求：
   *   ① **只播一次、绝不循环** —— 素材本身是「叮 → 气阀嗤 → 喷射嘶鸣 → 收束」的完整一段，
   *      旧版拿 nitro_loop 循环垫着播，就是"刺耳、像老鼠叫"的来源；
   *   ② **冷却前不重播** —— gap 1200ms，连按两瓶 / 队友同时开氮气不会叠成一团；
   *   ③ **音量按距离衰减** —— 自己满音量；远端真人队友最高 0.45 并挂 1200Hz 低通；
   *      AI 一律不出声（场上 6 条 AI 一起喷会糊成白噪）。
   *
   * listener 由 Game 建船后指到本地船（见 #createBoats）；没指到就按"自己人"处理。
   */
  #playNitroSound() {
    if (this.isLocal) {
      audio.play('nitro_dash', { gap: 1200, vol: 1 });
      return;
    }
    if (this.isAi || !this.listener) return;
    const L = this.listener.pos;
    const d = Math.hypot(this.pos.x - L.x, this.pos.z - L.z);
    if (d > 90) return;
    // 20m 内给满 0.45，之后线性衰减，90m 处约 0.1（再远既听不清又白占音路）
    const k = d <= 20 ? 1 : Math.max(0.22, 1 - (d - 20) / 70);
    audio.play('nitro_dash', { gap: 1200, vol: 0.45 * k, lowpass: 1200 });
  }

  #spawnWake(worldPos, scale, opacity, heading = this.heading) {
    const w = this.wakePool[this.wakeIndex];
    this.wakeIndex = (this.wakeIndex + 1) % this.wakePool.length;
    w.sprite.position.copy(worldPos);
    w.sprite.position.y = 0.12;
    w.sprite.rotation.y = heading;
    const waveMul = this.wakeColor.waveScale;
    w.width = scale * (0.95 + waveMul * 0.12);
    w.length = scale * (1.9 + waveMul * 0.18);
    w.sprite.scale.set(w.width, w.length, 1);
    w.life = w.maxLife;
    w.baseOpacity = opacity;
    w.sprite.material.color.copy(this.wakeColor.ripple).multiplyScalar(this.wakeLight);
    w.sprite.visible = true;
    w.crestWidth = Math.max(0.75, scale * 0.62);
    w.crestHeight = Math.min(1.15, 0.22 + scale * 0.12) * waveMul;
    w.crest.position.copy(worldPos);
    w.crest.position.y = 0.15 + w.crestHeight * 0.38;
    w.crest.rotation.set(0, heading, 0);
    w.crest.scale.set(w.crestWidth, w.crestHeight, 1);
    w.crest.material.color.copy(this.wakeColor.crest).multiplyScalar(this.wakeLight);
    w.crest.material.opacity = Math.min(0.72, opacity * 0.85);
    w.crest.visible = true;
  }

  #updateWake(dt) {
    // 幽灵车没有尾迹池（构造时跳过 #buildWake），这里必须早退
    if (!this.wakePool) return;
    for (const w of this.wakePool) {
      if (!w.sprite.visible) continue;
      w.life -= dt;
      if (w.life <= 0) { w.sprite.visible = false; w.crest.visible = false; continue; }
      const t = 1 - w.life / w.maxLife;
      w.sprite.material.opacity = w.baseOpacity * (1 - t);
      w.sprite.scale.set(
        w.width * (1 + t * 0.28),
        w.length * (1 + t * 0.5),
        1,
      );
      w.crest.position.y = 0.15 + w.crestHeight * (0.38 - t * 0.24);
      w.crest.scale.set(w.crestWidth * (1 + t * 0.18), w.crestHeight * (1 - t * 0.3), 1);
      w.crest.material.opacity = Math.min(0.72, w.baseOpacity * 0.85) * (1 - t);
    }
    // 水滴：抛物线飞行 + 轻微拉伸（读作速度拖尾）
    for (const p of this.splashPool || []) {
      if (!p.sprite.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sprite.visible = false; continue; }
      p.vy -= 4.8 * dt;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const t = 1 - p.life / p.maxLife;
      p.sprite.material.opacity = p.baseOpacity * (1 - t) * (1 - t * 0.35);
      p.sprite.scale.set(
        p.width * (1 + t * 0.2),
        p.height * (1 + t * 0.55),
        1,
      );
    }
    // 水雾：先上飘再缓缓落下，同时快速扩散变淡
    for (const p of this.mistPool || []) {
      if (!p.sprite.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.sprite.visible = false; continue; }
      p.vy -= 1.1 * dt;
      const drag = 1 - Math.min(1, 1.8 * dt);
      p.vx *= drag;
      p.vz *= drag;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const t = 1 - p.life / p.maxLife;
      p.sprite.material.opacity = p.baseOpacity * Math.sin(Math.PI * Math.min(1, t * 1.15));
      const grow = 1 + t * 1.7;
      p.sprite.scale.set(p.width * grow, p.height * grow, 1);
    }
  }

  /**
   * 重置到指定位姿（R键/发车/掉水/掉谷）。
   * @param {object} opts
   * @param {boolean} opts.keepNitro 保留氮气条集气与氮气瓶。
   *   R 键复位 / 掉出赛道 / 掉断层都是"位置惩罚"，不应该顺带把攒的氮气没收：
   *   玩家反馈按一下 R 之前集的气和右上角的瓶子全没了（R 只是脱困，不是重开一局）。
   *   发车摆位仍走默认值（清空），保证新一局从零开始。
   */
  resetTo(x, z, heading, opts = {}) {
    this.pos.set(x, 0, z);
    this.prevPos.set(x, 0, z);
    this.vel.set(0, 0);
    this.heading = heading;
    this.speed = 0;
    this.thrustState = 0;  // 新物理的推力状态，重开时清零（否则一发车就带着上次的推力）
    this.angVel = 0;
    this.steerInput = 0;
    this.stunTimer = 0;
    // 护盾也必须在重生时清掉：以前掉进断层再爬上来，上一时刻的护盾和护罩
    // 会跟着一起复活，后面几件攻击道具全被它无声挡掉。
    this.shieldTimer = 0;
    this.impactGripTimer = 0;
    this.collisionRoll = 0;
    this.wallHitCooldown = 0;
    this.wallContactTimer = 0;
    this.boostTimer = 0;
    this.nitroLoopTimer = 0;
    this.sinkTimer = 0;
    this.spinTimer = 0;
    this.visualSpinYaw = 0;
    this.slowTimer = 0;
    this.halfSpeedTimer = 0;
    this.octoGrabTimer = 0;
    this.geyserLiftTimer = 0;
    this.voidTimer = 0;
    this.capsizeTimer = 0;
    this.capsizeDur = 0;
    this.group.visible = true;
    // 氮气条/瓶子：只有"开新一局"才清空，脱困类复位要留着（见上）
    if (!opts.keepNitro) {
      this.nitroCharge = 0;
      this.nitroBottles = 0;
    }
    this.prevNitroKey = false;
    this.drifting = false;
    this.wasDrifting = false;
    this.driftDir = 0;
    this.driftPhase = 0;
    this.driftCharge = 0;
    this.driftAngle = 0;
    this.driftTime = 0;
    this.driftCollided = false;
    this.miniBoostQueue = 0;
    this.miniBoostTimer = 0;
    this.miniBoostGap = 0;
    this.prevDriftKey = false;
    this.sparkLevel = 0;
    this.driftWant = 0;
    this.driftAnglePeak = 0;
    this.driftPathYaw = 0;
    this.driftDA = 0;
    this.driftChain = 0;
    this.driftBreak = 0;
    this.driftBoostCd = 0;
    this.driftLockout = 0;
    this.driftGaugeStart = 0;
    this.slipAngle = 0;
    // 过山车状态清空（重生/重开不允许带状态）
    this.airborne = false;
    this.onCoaster = null;
    this.vy = 0;
    this.airTime = 0;
    this.waveJump = false;
    this.waveJumpCooldown = 0;
    // 掉落/闪烁也必须清干净：否则一次坠落之后重开还会带着闪烁计时，船一直是半透明的
    this.fallTimer = 0;
    this.blinkTimer = 0;
    this.overEdge = 0;
    this.edgeLimit = 0;
    // 断层坠落状态也要清零，否则重生后还带着"正在坠落"
    this.faultFall = 0;
    this.faultGrace = 0;
    this.surfaceLandingY = null;
    this.gateHint = null;
    this.group.visible = true;
    this.splashTimer = 0;
    this.bubbleLiftTimer = 0;
    this.bubbleFalling = false;
    this.bubbleWrapTimer = 0;
    this.reverseControlTimer = 0;
    this.#clearBubbleWrap();
    this.#updateDevilMark(0);
    // 重生/重开：清空远端快照历史，避免缓冲里的旧位姿把船拽回重生点
    this.remoteSnaps.length = 0;
    this.target = null;
    this.networkCorrection = null;
    // Apply the spawn transform immediately. This prevents every boat from
    // rendering at the group's default origin during the countdown frame.
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, heading, 0);
  }

  get boostState() {
    if (this.boostTimer > 0) return 'active';
    if (!this.nitroAllowed) return 'off';
    if (this.nitroBottles > 0) return 'ready';
    return 'charging';
  }

  /**
   * 撞到东西时打断漂移（Track / Game 的护栏、障碍、机关都走这一个入口）。
   *
   * 玩家口径（2026-11-16）：**只丢这一次漂移攒的气，氮气瓶一个都不掉**。
   * 所以这里不再把 nitroCharge 清零，而是"回退到本次起漂前的量"——
   * 之前攒的、以及这一漂里已经满格入瓶的氮气都留着。
   * 同时不硬切状态：滑移角留着，交给下面的收角过渡（exitTau）柔和甩正，
   * 不然撞一下船会像被掐断一样瞬间立正。
   */
  cancelDriftForCollision() {
    // 没在漂、也没有排队的小喷 → 这次撞击和漂移无关，一个字段都别动。
    // （贴着护栏漂的时候 Track 会逐帧调用这里，旧版的条件太松，一帧抄一次
    //   集气、一帧设一次冷却，读起来就是漂移在墙上"开/关闪切"。）
    if (!this.drifting && this.miniBoostQueue <= 0) return;
    // 只退掉本次漂移新增的那部分集气（不碰 nitroBottles）
    if (this.nitroCharge > this.driftGaugeStart) this.nitroCharge = this.driftGaugeStart;
    this.driftGaugeStart = this.nitroCharge;
    this.driftCollided = true;
    this.drifting = false;
    this.wasDrifting = false;
    this.driftDir = 0;
    this.driftTime = 0;
    this.driftCharge = 0;
    this.sparkLevel = 0;
    this.miniBoostQueue = 0;
    this.miniBoostTimer = 0;
    this.miniBoostGap = 0;
    this.driftChain = 0;
    this.driftAnglePeak = 0;
    this.driftWant = 0;
    this.driftPathYaw = 0;
    // 滑移角不在这里清零：留给收角过渡，船自己甩正
    this.driftBreak = DRIFT_TUNING.breakTime;
    // 贴墙时 Track 会逐帧调用这里；给一小段重入冷却，避免漂移在"开/关"之间高频闪切
    this.driftLockout = Math.max(this.driftLockout, DRIFT_TUNING.relock);
  }

  /** A brief visual capsize towards the side that absorbed an impact. */
  applyCollisionRoll(roll) {
    if (!Number.isFinite(roll) || Math.abs(roll) < 0.001) return;
    if (Math.abs(roll) > Math.abs(this.collisionRoll)) this.collisionRoll = roll;
  }

  /**
   * 船对船冲量（由 Game 的接触结算调用）。
   *
   * 为什么不是简单「把速度加进 vel」就完了
   * --------------------------------------
   * 这里的确只做了一次性的速度改变（动量守恒的正确做法），但光这样在这个引擎里读不出来：
   * updateLocal 每帧把 vel 拆成「前向 vf / 侧向 vl」，侧向分量紧接着被抓地指数衰减，
   * 还被滑移角上限钳（|vl| ≤ 0.30·|vf|）—— 船几乎停着被顶一下时 vf≈0，
   * 上限也≈0，一帧就把横向推力清零了。所以除了改速度，还要开一个
   * impactGripTimer 窗口，让水在 0.16s 内"还没反应过来"，推力才推得动船。
   *
   * 船头偏转直接写 heading（不是 angVel）：stun / 低速时 angVel 根本不参与积分
   * （转向块有 `|vf| > 0.5` 与 controllable 两道门），走 angVel 会整段丢掉。
   *
   * @param {number} dvx 世界 X 速度增量
   * @param {number} dvz 世界 Z 速度增量
   * @param {number} yaw 船头偏转（弧度，正值 = heading 增加）
   * @param {object} opts { roll, stun, shake, gripHold, cancelDrift }
   */
  applyBoatImpact(dvx, dvz, yaw = 0, opts = {}) {
    if (Number.isFinite(dvx) && Number.isFinite(dvz)) {
      this.vel.x += dvx;
      this.vel.y += dvz;
      this.speed = Math.hypot(this.vel.x, this.vel.y);
    }
    if (Number.isFinite(yaw) && Math.abs(yaw) > 1e-4) {
      this.heading += THREE.MathUtils.clamp(yaw, -0.24, 0.24);
    }
    const grip = opts.gripHold ?? 0.16;
    if (Number.isFinite(grip) && grip > 0) {
      this.impactGripTimer = Math.max(this.impactGripTimer, grip);
    }
    if (opts.roll) this.applyCollisionRoll(opts.roll);
    if (opts.shake) this.hitShake = Math.max(this.hitShake, opts.shake);
    if (opts.stun) this.stunTimer = Math.max(this.stunTimer, opts.stun);
    if (opts.cancelDrift) this.cancelDriftForCollision();
  }

  /**
   * 本地物理推进
   * @param {number} dt
   * @param {{throttle:number, steer:number, boost:boolean}} input
   * @param {number} t 全局时间
   * @param {Array} colliders {x,z,r}[] 障碍
   * @param {object|null} boundary {x,z,r} 赛道外边界（软推回）
   */
  updateLocal(dt, input, t, colliders, boundary) {
    this.prevPos.copy(this.pos);
    // 把油门意图留给 Track.constrain 用：贴墙助滑只在"玩家还在给油"时补，
    // 松油门贴墙就该老老实实停住（不然会变成无动力自滑）。
    this.throttleInput = input ? (input.throttle || 0) : 0;
    this.hitShake = Math.max(0, this.hitShake - dt);
    // 每帧清零：本帧硬物撞击的法向速度（applyMechs 的撞碎判定要读它）
    this.heavyImpactSpeed = 0;
    // 泡泡蜻蜓：被关进异世界的 3 秒 —— 赛道里消失、位置冻结，回来时原地继续
    if (this.voidTimer > 0) {
      this.voidTimer -= dt;
      this.group.visible = false;
      this.vel.set(0, 0);
      this.speed = 0;
      // 异世界 3 秒内虽然不动，但其他负面/增益计时照常走（免得护盾被白嫖）
      if (this.sinkTimer > 0) this.sinkTimer -= dt;
      if (this.spinTimer > 0) this.spinTimer -= dt;
      if (this.slowTimer > 0) this.slowTimer -= dt;
      if (this.halfSpeedTimer > 0) this.halfSpeedTimer -= dt;
      if (this.octoGrabTimer > 0) this.octoGrabTimer -= dt;
      if (this.capsizeTimer > 0) this.capsizeTimer -= dt;
      if (this.shieldTimer > 0) this.shieldTimer -= dt;
      if (this.reverseControlTimer > 0) this.reverseControlTimer -= dt;
      if (this.bubbleTimer > 0) this.bubbleTimer -= dt;
      this.#applyPose(t, null);
      if (this.voidTimer <= 0) this.group.visible = true;
      return;
    }
    this.collisionRoll *= Math.exp(-3.6 * dt);
    this.#updateWake(dt);
    const def = this.def;
    // 方向转换器：左右输入整体取反（施放者自己不受影响，由 Items 决定跳过谁）
    const invert = this.reverseControlTimer > 0 ? -1 : 1;
    // 章鱼怪缠身：转向彻底锁死（steer 强制 0），船头被触手持续拖歪
    const grabbed = this.octoGrabTimer > 0;
    const steerTarget = grabbed ? 0
      : THREE.MathUtils.clamp(input?.steer || 0, -1, 1) * invert
        * (this.bubbleTimer > 0 ? 0.28 : 1);
    this.steerInput = THREE.MathUtils.lerp(
      this.steerInput,
      steerTarget,
      1 - Math.exp(-14 * dt),
    );
    const steer = this.steerInput;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);

    // 氮气计时
    if (this.boostTimer > 0) this.boostTimer -= dt;
    // 氮气持续音的旧实现（startLoop/stopLoop 循环播 nitro_loop）已下线：
    // 3 秒素材自带完整起承转合，循环播就是"老鼠叫"。计时字段保留，
    // 它还被"这一发氮气还剩多久"的视觉逻辑读着。
    if (this.nitroLoopTimer > 0) this.nitroLoopTimer -= dt;
    if (this.miniBoostTimer > 0) this.miniBoostTimer -= dt;

    // ---------- 漂移物理（跑跑卡丁车式：滑移角是主状态，方向键连续控制）----------
    // 车头 = 轨迹方向 + 滑移角。轨迹按 pathYaw 自己转，速度永远沿轨迹走。
    //   ① 方向键 → 想要多少滑移角（含符号）：一直按住就一直往那边漂（拖漂）
    //   ② 反打方向 → 滑移角连续穿过 0 翻到另一侧（彩虹漂），轨迹跟着反弯
    //   ③ 松开方向 → 滑移角按时间常数回正（够 30° 之后是"快速甩正"= 双喷起手）
    //   ④ 松漂移键 → 进入断漂补气窗口，窗口内再按住算同一次漂移（气不清零）
    // 全程没有一帧跳变：起漂不掉速、方向不锁死、断漂不清零、收角不硬切。
    const driftHeld = !!input.drift;
    if (this.driftLockout > 0) this.driftLockout = Math.max(0, this.driftLockout - dt);
    if (this.driftBreak > 0) this.driftBreak = Math.max(0, this.driftBreak - dt);
    if (this.driftBoostCd > 0) this.driftBoostCd = Math.max(0, this.driftBoostCd - dt);
    if (!driftHeld && this.driftChain > 0) this.driftChain = Math.max(0, this.driftChain - dt);

    // "玩家到底有没有在打方向"必须用**未平滑**的输入（steerTarget）判断：
    // 平滑后的 steer 在左右反打时会自然穿过 0，拿它判"回正"会把彩虹漂
    // 在换向的那一帧误判成松手 → 漂移被杀掉（实测反打就断漂）。
    const steerActive = Math.abs(steerTarget) > DRIFT_TUNING.steerDead;
    const wasDrift = this.drifting;
    // 贴墙时不给起漂：墙上一蹭就被打断、下一帧又起、再一帧又被打断 —— 那就是
    // 玩家说的"一顿一顿"。wallContactTimer 由 Track 每次蹭墙刷新 0.35s，
    // 离开墙 0.35 秒之后才允许重新起漂。
    const canEngage = driftHeld && this.stunTimer <= 0
      && this.speed > DRIFT_TUNING.startSpeed
      && this.wallContactTimer <= 0
      && this.driftLockout <= 0 && this.driftBreak <= 0;
    if (!this.drifting) {
      // 起漂：按着漂移键 +（有方向输入 或 车身还带着滑移角）。
      // 不再要求 driftDir === 0，所以松一下再按住不会重走启动分支。
      if (canEngage && (steerActive || Math.abs(this.driftAngle) > 0.05)) {
        if (this.driftChain <= 0) {
          // 全新一次漂移：计时/峰值/集气基准都重来
          this.driftTime = 0;
          this.driftAnglePeak = 0;
          this.driftGaugeStart = this.nitroCharge;
        }
        this.driftChain = 0;
        this.driftCollided = false;
        this.drifting = true;
        this.driftPhase = 1;
        this.#clearDriftOverlay();
      }
    } else if (!driftHeld || this.stunTimer > 0
      || this.speed <= DRIFT_TUNING.exitSpeed || this.driftBreak > 0) {
      this.drifting = false;
      this.driftChain = DRIFT_TUNING.chainWindow;   // 断漂补气窗口
    }

    this.driftDA = 0;
    if (this.drifting) {
      this.driftTime += dt;
      const ratio = THREE.MathUtils.clamp(this.speed / Math.max(1, def.maxSpeed), 0, 1);
      const maxAng = Math.min(DRIFT_TUNING.angleCap,
        (DRIFT_TUNING.angleBase + DRIFT_TUNING.angleGain * ratio)
        * (this.handling.driftAngle ?? 1));
      this.driftMaxAngle = maxAng;
      if (steerActive) {
        // 方向键决定漂移方向与角度（含符号）：按住就一直漂那一侧。
        // 目标值可以阶跃（反打时直接翻到另一侧），真正防抽的是下面的一阶限速。
        this.driftDir = Math.sign(steerTarget);
        this.driftWant = this.driftDir * maxAng
          * (0.70 + 0.30 * Math.min(1, Math.abs(steerTarget)));
      } else {
        // 松方向：够 30° 之后迅速甩正（双喷起手），否则慢慢收（拖漂保角）
        const tau = this.driftAnglePeak >= DRIFT_TUNING.doubleAngle
          ? DRIFT_TUNING.straightenFast : DRIFT_TUNING.straightenSlow;
        this.driftWant *= Math.exp(-dt / tau);
      }
      const rate = DRIFT_TUNING.angleRate * (this.handling.driftRate ?? 1)
        * (0.55 + 0.45 * ratio);
      const prevAng = this.driftAngle;
      this.driftAngle = prevAng + limitDriftStep(this.driftWant - prevAng, dt, rate);
      this.driftDA = this.driftAngle - prevAng;
      this.driftAnglePeak = Math.max(this.driftAnglePeak, Math.abs(this.driftAngle));

      // 轨迹偏航：漂移中路径自己弯，和滑移角解耦（这就是"车头指向弯内、轨迹仍贴弯"）
      // 低速几乎没有曲率（原地打方向不转圈），高速收一档避免甩飞。
      const sp = Math.min(1, this.speed / Math.max(1, def.maxSpeed));
      const lowRaw = Math.max(0, Math.min(1, (sp - 0.04) / 0.26));
      const lowCut = lowRaw * lowRaw * (3 - 2 * lowRaw);
      const highCut = 1 - 0.18 * Math.max(0, Math.min(1, (sp - 0.78) / 0.22));
      const yawPeak = def.turnRate * this.handling.yawScale;
      const pathTarget = THREE.MathUtils.clamp(
        steer * yawPeak * (this.handling.driftYaw ?? 1) * DRIFT_TUNING.pathYaw * lowCut * highCut,
        -yawPeak * DRIFT_TUNING.pathYawCap, yawPeak * DRIFT_TUNING.pathYawCap,
      );
      this.driftPathYaw += (pathTarget - this.driftPathYaw)
        * (1 - Math.exp(-dt / DRIFT_TUNING.pathYawTau));
    } else {
      // 收角：车头往轨迹方向甩正，轨迹不动（heading 与 driftAngle 同步反向变化）
      this.driftPathYaw *= Math.exp(-dt / 0.12);
      if (Math.abs(this.driftAngle) > 1e-4) {
        const k = 1 - Math.exp(-dt / (this.driftBreak > 0 ? DRIFT_TUNING.exitTau * 0.5 : DRIFT_TUNING.exitTau));
        this.driftDA = -this.driftAngle * k;
        this.driftAngle += this.driftDA;
        if (Math.abs(this.driftAngle) < 1e-3) this.driftAngle = 0;
      }
    }

    // ---------- 单喷 / 双喷 ----------
    // 门槛从"漂了多久"改成"漂到多深"：角度到过 30° = 双喷，到过 16° = 单喷。
    // 两条触发路径：
    //   · 按住漂移键、把方向盘回正 → 车头甩正的那一下当场发喷（玩家口径）
    //   · 松漂移键 / 掉速断漂 → 按本轮峰值角度给 1 或 2 喷
    // 反打方向穿过 0 时**不算回正**（那是彩虹漂），所以要求方向键真的回中。
    if (this.drifting && !steerActive
      && Math.abs(this.driftAngle) <= 0.10 && this.driftTime > 0.12) {
      // 回正到位：这一漂到此为止，喷在干净气流里
      //（漂移中推力被压着、速度上限也压着，喷了也读不出来）
      this.drifting = false;
      this.driftChain = 0;
      this.driftDir = 0;
      this.driftWant = 0;
      // 不给一个短暂的起漂冷却，残余滑移角（此时还有 0.05~0.10rad）会在下一帧
      // 立刻满足 canEngage 的 |driftAngle|>0.05，刚发完喷又黏回漂移，
      // 读起来就是"喷完顿一下"。cool 期间走收角分支把角收干净。
      this.driftBreak = Math.max(this.driftBreak, DRIFT_TUNING.relock);
      this.#grantDriftBoost();
    } else if (wasDrift && !this.drifting) {
      this.#grantDriftBoost();
    }
    this.wasDrifting = this.drifting;

    // 逐个触发排队的小喷
    if (this.miniBoostQueue > 0 && this.miniBoostTimer <= 0) {
      if (this.miniBoostGap <= 0) {
        this.miniBoostQueue--;
        this.miniBoostTimer = 0.55;
        this.miniBoostGap = 0.75;
        // 瞬时速度脉冲（沿船头）
        const pfx = Math.sin(this.heading);
        const pfz = Math.cos(this.heading);
        let vf0 = this.vel.x * pfx + this.vel.y * pfz;
        const vl0 = this.vel.x * pfz - this.vel.y * pfx;
        vf0 = Math.min(vf0 + 4.5, def.maxSpeed * MINI_BOOST_TOP_RATIO);
        this.vel.x = pfx * vf0 + pfz * vl0;
        this.vel.y = pfz * vf0 - pfx * vl0;
        this.#splashBurst();
      } else {
        this.miniBoostGap -= dt;
      }
    } else if (this.miniBoostGap > 0) {
      this.miniBoostGap -= dt;
    }
    this.prevDriftKey = driftHeld;
    // ---------- 小喷结束 ----------

    // 漂移火花分级——漂得越久火花越强（蓝→橙→红），胎印/水花同步变色（道具模式也有彩色胎印）
    if (this.drifting) {
      this.sparkLevel = this.driftTime > 2.2 ? 3 : this.driftTime > 1.2 ? 2 : this.driftTime > 0.5 ? 1 : 0;
      this.driftCharge = THREE.MathUtils.clamp((this.driftTime - 0.35) / 1.15, 0, 1);
      // 漂移集气（道具模式禁用）
      if (this.nitroAllowed) {
        // 冰面上漂移攒气更快：滑得过瘾也该有回报（surfaceDriftGain 由 Game 下发）
        const chargeRate = [0.16, 0.26, 0.34, 0.44][this.sparkLevel] * this.surfaceDriftGain;
        const collected = collectNitroCharge(this.nitroCharge, this.nitroBottles, dt * chargeRate);
        this.nitroCharge = collected.charge;
        this.nitroBottles = collected.bottles;
      }
    } else {
      this.sparkLevel = 0;
    }

    // Ctrl consumes one full bottle per key press; release and press again to
    // use the second bottle after the current burst ends.
    const nitroJustPressed = !!input.nitro && !this.prevNitroKey;
    if (nitroJustPressed && this.nitroAllowed
      && this.nitroBottles > 0 && this.boostTimer <= 0 && this.stunTimer <= 0) {
      this.boostTimer = 4.2;
      this.nitroLoopTimer = Math.max(this.nitroLoopTimer, 4.2);
      this.nitroBottles--;
      this.#playNitroSound();
    }
    this.prevNitroKey = !!input.nitro;

    const boosting = this.boostTimer > 0;
    const miniBoosting = this.miniBoostTimer > 0;

    // 失控（撞击后短暂打滑 / 道具效果）
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.speedCapTimer > 0) {
      this.speedCapTimer = Math.max(0, this.speedCapTimer - dt);
      if (this.speedCapTimer === 0) this.speedCap = 0;
    }
    if (this.wallHitCooldown > 0) this.wallHitCooldown -= dt;
    if (this.wallContactTimer > 0) this.wallContactTimer -= dt;
    if (this.impactGripTimer > 0) this.impactGripTimer -= dt;
    if (this.sinkTimer > 0) this.sinkTimer -= dt;
    if (this.spinTimer > 0) this.spinTimer -= dt;
    if (this.slowTimer > 0) this.slowTimer -= dt;
    if (this.halfSpeedTimer > 0) this.halfSpeedTimer -= dt;
    if (this.octoGrabTimer > 0) this.octoGrabTimer -= dt;
    if (this.capsizeTimer > 0) this.capsizeTimer -= dt;
    if (this.geyserLiftTimer > 0) this.geyserLiftTimer -= dt;
    if (this.bubbleTimer > 0) this.bubbleTimer -= dt;
    if (this.shieldTimer > 0) this.shieldTimer -= dt;
    if (this.reverseControlTimer > 0) this.reverseControlTimer -= dt;
    if (this.bubbleLiftTimer > 0) this.bubbleLiftTimer -= dt;
    // 水泡特效独立寿命：不管状态机走到哪一步，到期一律收起（防止永久残留）
    if (this.bubbleWrapTimer > 0 && (this.bubbleWrapTimer -= dt) <= 0) {
      this.#clearBubbleWrap();
    }
    this.#updateDevilMark(t);
    this.#updateShameMark(t);
    const controllable = this.stunTimer <= 0 && this.sinkTimer <= 0 && this.spinTimer <= 0
      && this.bubbleLiftTimer <= 0 && this.geyserLiftTimer <= 0 && this.octoGrabTimer <= 0
      && this.capsizeTimer <= 0;

    // ---------- 金龙过山车：自动轨道段（锁定沿 spline 飞驰） ----------
    if (this.onCoaster) {
      const c = this.onCoaster;
      // 沿轨道加速冲刺（弹射带感，至少 26 m/s）
      this.speed = THREE.MathUtils.lerp(this.speed, Math.max(this.speed, 26), 1 - Math.exp(-1.4 * dt));
      c.t = Math.min(1, c.t + (this.speed * dt) / c.length);
      const p = c.curve.getPointAt(c.t);
      const tan = c.curve.getTangentAt(c.t);
      // 轨道偏移：船体横跨在两侧行轨之上（脊梁半径 0.75 + 船底净空）
      const tangent = tan.clone().normalize();
      // 侧向基准冻结为上轨瞬间的世界方向：过山车 spline 起点在 from 门前方、
      // 控制点折回 from 门（折返 U 弯），切线在折返顶点会掉头 180°。若每帧用
      // 实时切线重算 side，入轨偏移 lateral 会被 side 翻转瞬间甩出 2×|lateral|
      // 米（palace 入口实测单帧横甩 3.4m = 瞬移）。冻结后侧向偏移在整个行轨
      // 期间保持同一世界方向，过折返顶点时位置连续。
      const side = (c.side && Number.isFinite(c.side.x) && Number.isFinite(c.side.z))
        ? new THREE.Vector3(c.side.x, 0, c.side.z)
        : new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), tangent).normalize();
      if (c.manual) {
        if (c.lat0 != null) {
          // 入轨偏移平滑收进 ±2.25 操控限幅：触发区半宽达 10m，贴边入轨偏移可超限，
          // 首帧直接钳位会把船瞬移 |lat0-2.25| 米（贴边入轨实测 1.2m 顿挫）。
          // 0.3s 平滑滑入限幅后再接受转向输入。
          c.latSettle = Math.min(1, (c.latSettle || 0) + dt / 0.3);
          const k = c.latSettle * c.latSettle * (3 - 2 * c.latSettle);
          c.lateral = THREE.MathUtils.lerp(c.lat0, THREE.MathUtils.clamp(c.lat0, -2.25, 2.25), k);
          if (c.latSettle >= 1) c.lat0 = null;
        } else {
          c.lateral = THREE.MathUtils.clamp((c.lateral || 0) + steer * 2.4 * dt, -2.25, 2.25);
        }
      } else {
        c.lateral = THREE.MathUtils.lerp(c.lateral || 0, 0, 1 - Math.exp(-5 * dt));
      }
      // 入轨过渡：登轨首帧位置已连续（updateCoaster 就近吸附），但轨道悬在水面上方，
      // 高度从 entryY 平滑升到 p.y+1.9，避免瞬间拔地式瞬移。
      // 时长随高度差缩放：贴边入轨时吸附点可能已在爬坡段（轨道 12m 高），
      // 固定 0.35s 爬 14m = 峰值 40m/s 垂直速度，体感是被拽上去。
      let boardY = p.y + 1.9;
      if (c.entryY != null) {
        const dur = c.boardDur || 0.35;
        c.boardT = Math.min(1, (c.boardT || 0) + dt / dur);
        const bk = 1 - c.boardT;
        boardY = THREE.MathUtils.lerp(p.y + 1.9, c.entryY, bk * bk * (3 - 2 * bk));
        if (c.boardT >= 1) c.entryY = null;
      }
      this.pos.set(p.x + side.x * (c.lateral || 0), boardY, p.z + side.z * (c.lateral || 0));
      this.heading = Math.atan2(tan.x, tan.z);
      this.vy = tan.y * this.speed;
      this.vel.x = Math.sin(this.heading) * this.speed;
      this.vel.y = Math.cos(this.heading) * this.speed;
      if (c.t >= 1) {
        // 脱轨落水：大水花 + 冲刺加速
        this.onCoaster = null;
        this.pos.y = waveHeight(this.pos.x, this.pos.z, t);
        this.vy = 0;
        this.#landingEffects(1.6);
      }
      this.#applyPose(t, input);
      this.#emitWake(dt, this.boostTimer > 0);
      this.#updateRowing(dt, input ? input.throttle : 0);
      return;
    }

    // ---------- 漩涡巨型水泡：吸到空中悬浮 → 计时结束后下坠回水面 ----------
    // 整段独占位置更新（悬停锁 XZ、落水速度归零），放在弹射腾空分支之前：
    // 否则 bubbleLift 期间会走进 airborne 的重力段，1 帧内就被拽回水面。
    if (this.bubbleLiftTimer > 0 || this.geyserLiftTimer > 0 || this.bubbleFalling) {
      // airborne=true 让 #applyPose 走腾空姿态分支，跳过"贴水面浮力"把 y 拉回水面
      this.airborne = true;
      this.diveVel = 0;
      this.vel.set(0, 0);
      this.speed = 0;
      const waterY = waveHeight(this.pos.x, this.pos.z, t);
      if (this.bubbleFalling) {
        this.vy -= BUBBLE_FALL_G * dt;
        this.pos.y += this.vy * dt;
        if (this.bubbleLiftTimer > 0) this.#updateBubbleWrap(t); // 水泡裹着下坠
        if (this.pos.y <= waterY) {
          // 砸回赛道：速度归零，玩家从 0 重新加速（不给弹射段那样的落水加速）
          this.pos.y = waterY;
          this.vy = 0;
          this.airborne = false;
          this.bubbleFalling = false;
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            const r = 1.8 + (i % 3) * 0.9;
            this.#spawnWake(
              new THREE.Vector3(this.pos.x + Math.cos(a) * r, 0, this.pos.z + Math.sin(a) * r),
              2.4 + (i % 3) * 0.7, 0.8,
            );
          }
          this.bubbleWrapTimer = 0;
          this.#clearBubbleWrap();
        }
      } else {
        if (this.bubbleLiftTimer <= 0 && this.geyserLiftTimer <= 0) {
          // 悬浮时间到：切换到下坠（特效留到落地再收）
          this.bubbleFalling = true;
        } else {
          // 被吸上去：指数逼近悬浮高度，起手不瞬移。水柱冲得比水泡更高
          const liftHeight = this.geyserLiftTimer > 0 ? GEYSER_LIFT_HEIGHT : BUBBLE_LIFT_HEIGHT;
          this.pos.y += (waterY + liftHeight - this.pos.y) * (1 - Math.exp(-6 * dt));
          this.vy = 0;
          if (this.bubbleLiftTimer > 0) this.#updateBubbleWrap(t);
        }
      }
      this.#applyPose(t, null);
      this.#emitWake(dt, false);
      this.#updateRowing(dt, 0);
      return;
    }

    // ---------- 金龙弹射：手动腾空段（分段重力过山车手感） ----------
    if (this.airborne) {
      this.airTime += dt;
      // 分段重力：高空低重力悬浮（失重感）→ 低空重压（飞速下坠感）
      // 浪尖抛飞用更轻的重力，形成 1~2 秒的腾空（海啸级浪面下会被顶得更高）
      const g = this.waveJump ? 12 : (this.pos.y > 6 ? 7.5 : this.pos.y > 2.5 ? 14 : 30);
      this.vy -= g * dt;
      // 空中操控：微转向 + 油门喷气维持飞驰
      if (controllable) {
        if (Math.abs(steer) > 0.001) this.heading += steer * def.turnRate * 0.55 * dt;
        if (input.throttle > 0) this.speed += def.accel * 0.6 * input.throttle * dt;
      }
      this.speed *= Math.exp(-0.08 * dt); // 空气阻力（轻微）
      this.vel.x = Math.sin(this.heading) * this.speed;
      this.vel.y = Math.cos(this.heading) * this.speed;
      this.pos.x += this.vel.x * dt;
      this.pos.z += this.vel.y * dt;
      this.pos.y += this.vy * dt;
      // Launch mode moves quickly enough to skip a rock between frames. Static
      // props with vertical bounds get a 3D sweep here, while normal water
      // navigation keeps using the existing surface collision path below.
      const moveX = this.pos.x - this.prevPos.x;
      const moveZ = this.pos.z - this.prevPos.z;
      if (moveX * moveX + moveZ * moveZ > 1e-6) {
        for (const c of colliders) {
          if (!Number.isFinite(c.bottomY) || !Number.isFinite(c.topY)) continue;
          const hullRadius = 1.3;
          const lowY = Math.min(this.prevPos.y, this.pos.y);
          const highY = Math.max(this.prevPos.y, this.pos.y);
          if (highY < c.bottomY - hullRadius || lowY > c.topY + hullRadius) continue;
          const R = c.r + hullRadius;
          // 与水面扫掠同一套：相对轨迹 + 第一个交点法线，避免一帧跨过障碍后
          // 被推到出口侧（腾空高速穿模）。移动机关的 px/pz 由 Track.updateMechs 写入。
          const hasPrev = Number.isFinite(c.px) && Number.isFinite(c.pz);
          const sx = this.prevPos.x - (hasPrev ? c.px : c.x);
          const sz = this.prevPos.z - (hasPrev ? c.pz : c.z);
          const ex = this.pos.x - c.x;
          const ez = this.pos.z - c.z;
          const rx = ex - sx;
          const rz = ez - sz;
          const a = rx * rx + rz * rz;
          if (a <= 1e-6) continue;
          const b = 2 * (sx * rx + sz * rz);
          const cc = sx * sx + sz * sz - R * R;
          let u;
          if (cc > 0) {
            const disc = b * b - 4 * a * cc;
            if (disc < 0) continue;
            u = (-b - Math.sqrt(disc)) / (2 * a);
            if (u < 0 || u > 1) continue;
          } else {
            u = 0;
          }
          // 与水面扫掠同理：深穿才拉回进入侧，浅擦保留最近点法线让船沿切线滑过
          let uq = -(sx * rx + sz * rz) / a;
          uq = THREE.MathUtils.clamp(uq, 0, 1);
          const qx = sx + rx * uq;
          const qz = sz + rz * uq;
          const qDist = Math.hypot(qx, qz);
          const deepTunnel = cc > 0 && Math.hypot(ex, ez) >= R && qDist < R * 0.72;
          let nx;
          let nz;
          if (deepTunnel) {
            const hx = sx + rx * u;
            const hz = sz + rz * u;
            const hLen = Math.hypot(hx, hz);
            nx = hLen > 0.001 ? hx / hLen : -Math.sin(this.heading);
            nz = hLen > 0.001 ? hz / hLen : -Math.cos(this.heading);
          } else {
            nx = qDist > 0.001 ? qx / qDist : -Math.sin(this.heading);
            nz = qDist > 0.001 ? qz / qDist : -Math.cos(this.heading);
          }
          this.pos.x = c.x + nx * R;
          this.pos.z = c.z + nz * R;
          const fx = Math.sin(this.heading);
          const fz = Math.cos(this.heading);
          const dot = fx * nx + fz * nz;
          if (dot < 0) this.heading = Math.atan2(fx - 2 * dot * nx, fz - 2 * dot * nz);
          this.speed *= 0.45;
          this.vel.set(Math.sin(this.heading) * this.speed, Math.cos(this.heading) * this.speed);
          this.vy = Math.min(this.vy, 0);
          this.stunTimer = Math.max(this.stunTimer, 0.5);
          this.cancelDriftForCollision();
          break;
        }
      }
      // 落水：砸出大水花 + 入水冲刺
      // 水下弹射链（underwaterLandingY）落点回水下深度：穿越水面先出水花，继续下潜到链上深度
      const wh = waveHeight(this.pos.x, this.pos.z, t);
      // 烧结赛道有"抬高的水面"（瀑布坡 / 云端 / 回程栈道）：从崖口飞出去时，
      // 落点必须是**当地赛道面**而不是海平面 —— 否则船会在瀑布中段砸到 y=0，
      // 然后被 diveTargetY 一帧拉高 20m（实测瞬移，镜头也跟着掉到船下面）。
      const landingY = this.underwaterLandingY ?? this.surfaceLandingY ?? wh;
      if (this.underwaterLandingY != null && !this.surfaceSplashed && this.pos.y <= wh) {
        this.surfaceSplashed = true;
        // 落差越大砸得越狠：瀑布下来是 2.2 倍，普通落水 1 倍
        this.#splashBurst(2.2);
      }
      if (this.pos.y <= landingY && this.vy < 0) {
        this.pos.y = landingY;
        const wasWaveJump = this.waveJump;
        this.airborne = false;
        this.airTime = 0;
        this.vy = 0;
        this.waveJump = false;
        this.underwaterLandingY = null;
        this.surfaceSplashed = false;
        this.surfaceLandingY = null;
        // 浪尖腾空落地只给小加速：海啸浪面下会频繁抛飞，
        // 沿用弹射器的 1.3s 助推等于全程白嫖氮气
        this.#landingEffects(wasWaveJump ? 0.45 : 1.3);
      }
      this.#applyPose(t, input);
      this.#emitWake(dt, this.boostTimer > 0);
      this.#updateRowing(dt, input ? input.throttle : 0);
      return;
    }

    // 漩涡打转：艇身自旋（本地艇直接旋转航向）
    if (this.spinTimer > 0) this.heading += 9 * dt;
    // 章鱼怪：触手持续把船头往一侧拖拽（转向已锁死，只能被拽着偏航）
    if (this.octoGrabTimer > 0) this.heading += 1.35 * dt;

    // 减速叠加：导弹 0.4 → 减速艇 ×0.5 → 章鱼怪 ×0.7
    const slowMul = (this.slowTimer > 0 ? 0.4 : 1)
      * (this.halfSpeedTimer > 0 ? 0.5 : 1)
      * (this.octoGrabTimer > 0 ? 0.7 : 1);
    // 小喷：短促额外推力（推力放大，但**极速只抬 6%**）
    // 旧版 powerMul 里 miniBoosting×1.35 又乘 maxSpeed×1.18 = 1.59 倍极速，
    // 漂移出弯能刷到 195km/h —— 这就是"漂移比正常行驶还快"的根因。
    const powerMul = (boosting ? def.boostPower : 1) * (miniBoosting ? 1.18 : 1) * slowMul;
    // 极速上限：氮气 = 本船极速 × boostPower（各船不同，极速船氮气最快），
    // 巡航 = 原极速（小喷只 +6%）；减速道具照样压制。
    // 2026-11-17：实机反馈"氮气一开太快控不住"，巡航与氮气极速各降 20km/h
    // （绝对量，不是降倍率 —— 降倍率的话氮气会连带掉 36km/h）。
    const cruiseTop = cruiseTopOf(def) * (miniBoosting ? MINI_BOOST_TOP_RATIO : 1) * slowMul;
    const boostTop = boostTopOf(def);
    const maxSpeed = boosting ? boostTop * slowMul : cruiseTop;
    // 本帧的极速上限（m/s）：HUD/探针都读这个，别再各处自己推算。
    this.topSpeed = maxSpeed;

    // 推进（沿艇头方向）
    // 2026-10-31：卡丁车式「瞬时推力 + 全程水阻」→ 重船式「推力爬升 + 滑行」的**中间档**。
    //   ① 推力先过一阶滞后（油门/桨响应），起步不再瞬间到顶
    //   ② 推力按"剩余推力系数"(1 - v/vmax) 衰减 → 极速是渐近逼近，不靠水阻硬顶
    //   ③ 水阻只在松油门/超速时生效 → 才有"松油门继续滑"的惯性感
    // 老引擎 0→90% 极速约 2.5s，重船档 11s，这里取中间 ~4.5s。
    const thrustTarget = controllable
      ? (input.throttle > 0
        ? def.accel * HULL_ACCEL_SCALE * input.throttle * powerMul
        : input.throttle < 0 ? def.accel * HULL_ACCEL_SCALE * 0.55 * input.throttle : 0)
      : 0;
    this.thrustState = (this.thrustState || 0)
      + (thrustTarget - (this.thrustState || 0)) * (1 - Math.exp(-dt / this.handling.spool));
    const thrust = this.thrustState;

    // 速度分解：前向 / 侧向
    let vf = this.vel.x * fx + this.vel.y * fz; // forward scalar
    let vl = this.vel.x * fz - this.vel.y * fx; // lateral scalar（右为正）

    const vRatio = Math.max(0, Math.min(1, vf / maxSpeed));
    // 氮气用 sqrt 逼近：前 1~2 秒就把速度拉到上限（旧版线性渐近，4.2 秒只爬到 193），
    // 巡航仍保持线性渐近（保留"越接近极速越慢"的那口气）。
    const approach = boosting ? Math.sqrt(Math.max(0, 1 - vRatio)) : (1 - vRatio);
    // 漂移中推力只留三成：踩满油门也顶不住直道速度（跑跑卡丁车的漂移手感）
    const thrustEff = this.drifting ? thrust * DRIFT_THRUST_MUL : thrust;
    vf += thrustEff * approach * dt;
    // 氮气硬顶本船氮气极速：不玩渐近线的尾巴
    if (boosting) vf = Math.min(vf, maxSpeed);
    // 水阻只在「没踩油门」或「超速」时结算。
    // 漂移不再走这条（旧版 driftDrag<1 = 漂移比直行更保速，是"漂移更快"的另一半原因），
    // 漂移的减速交给下面那条"拖向漂移极速"的曲线，读起来才是托漂。
    const coasting = !(controllable && input.throttle > 0) || vf > maxSpeed;
    if (coasting) {
      // 超速（氮气刚结束）时二次项用 min(vf, maxSpeed) 结算，不要拿 61/34 去平方：
      // 那样超速项会翻到 3.2 倍，氮气极速会在 0.5 秒内砸回一半，像撞了堵墙。
      // 现在回落到极速的尾巴约 1.4 秒，读起来是"氮气烧完了，慢慢滑回来"。
      const dragRef = Math.min(Math.abs(vf), maxSpeed);
      const dragF = def.drag
        * (this.handling.coastDrag + (dragRef * dragRef) / (maxSpeed * maxSpeed) * HULL_COAST_QUAD);
      vf -= vf * dragF * dt;
    }
    // 漂移减速（跑跑卡丁车）：上限压到直道的 94%，滑移角拉满再压 7%。
    // **必须是指数"拖"下去的，不是入漂一刀砍**：拖曳速率在 dragRamp（0.55s）里
    // 从 0 线性爬满，所以按下漂移键的前半秒几乎不掉速，之后才慢慢"黏"下来。
    // 注意这里压的是**速度大小 S**，不是前向分量 vf：漂移时 vf 只有 S·cosA，
    // 拿它跟上限比等于"只压了一半却当成全速"，会算出一个假的漂移极速。
    if (this.drifting) {
      const angFrac = Math.min(1, Math.abs(this.driftAngle) / Math.max(0.01, this.driftMaxAngle || 0.6));
      const driftCeil = maxSpeed * DRIFT_SPEED_RATIO * (1 - DRIFT_TUNING.speedAngleLoss * angFrac);
      const ramp = Math.min(1, this.driftTime / DRIFT_TUNING.dragRamp);
      const k = 1 - Math.exp(-(DRIFT_TUNING.dragBase + DRIFT_TUNING.dragGain
        * (this.handling.driftDrag || 0.5)) * ramp * dt);
      const S0 = Math.hypot(vf, vl);
      if (S0 > driftCeil && S0 > 1e-6) {
        const scale = (S0 - (S0 - driftCeil) * k) / S0;
        vf *= scale;
        vl *= scale;
      }
    }
    if (input.throttle < 0) vf = Math.max(vf, -def.reverseSpeed);
    else if (thrust === 0 && vf < 0) vf = Math.min(vf + def.accel * 0.5 * dt, 0);
    // 侧向抓地衰减：刚蹭到护栏时（wallContact）放宽抓地，像蹭到软胶路肩一样沿墙滑走，
    // 而不是被侧向抓地瞬间吃掉速度、贴死墙动不了。
    // 漂移中的侧向速度不能在这里衰减 —— 漂移的滑移角由 driftAngle 直接给定、
    // 下面重组速度时显式拆成分量，这里再按抓地撸一遍等于每帧白吃掉一大截速度
    // （实测 39° 滑移角时 1 秒掉 37%，就是"漂一下就慢成龟"的元凶）。
    const wallContact = this.wallContactTimer > 0;
    // 被别的船撞完的一小段（impactGripTimer）：水还没"抓住"船，
    // 否则冲量给的横向速度会被抓地 + 滑移角上限在一帧内抹平，
    // 读起来就是"明明被侧撞了却推不开、只是掉速"。
    const impactGrip = this.impactGripTimer > 0;
    const slipMode = Math.abs(this.driftAngle) > 1e-4;
    if (!slipMode) {
      const gripMul = (wallContact || impactGrip ? 0.30 : 1) * this.surfaceGrip
        * (this.floatMode ? 0.45 : 1);
      vl *= Math.exp(-def.grip * gripMul * dt);
      // 滑移角上限（卡丁车式可控甩尾）：侧滑最多约 28°
      // 贴墙滑行时放开上限：护栏把船头推歪后，仍允许船身带着大滑移角沿墙继续走。
      const maxSlip = Math.abs(vf) * 0.30 * this.surfaceSlip;
      const slipCap = wallContact ? Math.max(maxSlip, this.speed * 0.90) : maxSlip;
      // 被撞后额外给一个 6 m/s 的绝对下限：船几乎停着被顶时 vf≈0、
      // maxSlip 也≈0，不设下限的话横向冲量一格都留不住。
      const cap = impactGrip ? Math.max(slipCap, 6) : slipCap;
      vl = THREE.MathUtils.clamp(vl, -cap, cap);
    }

    // 转向（速度越低转向越弱，倒车反向）
    // 贴墙时放开门限：撞完贴死护栏也能打方向离开（否则 vf≈0 时完全转不动）
    if (controllable && (Math.abs(vf) > 0.5 || wallContact)) {
      // 贴墙时给一个最低速度权重（WALL_YAW_MIN_SP ≈ 8m/s 那一档的转向）。
      // 这是"顶死后只能复位"的真正病根：船头戳在墙上 → 墙把速度吃掉 → vf≈0
      // → 速度曲线 lowCut≈0 → 转向率≈0，方向键按了船头也不动，只能慢慢蹭。
      // 跑跑卡丁车/马车贴墙时车头是能被掰开的，所以贴墙期间不再按速度压转向。
      const speedFactor = wallContact
        ? Math.max(Math.min(1, Math.abs(vf) / 4), WALL_YAW_MIN_SPEED_FACTOR)
        : Math.min(1, Math.abs(vf) / 4);
      // 只有"主动按 S 倒车且确实在倒着走"才反转转向。
      // 旧写法按 vf 符号取反：撞墙回弹造成瞬时负速时转向会突然反向，
      // 玩家刚想打方向离开反而拐向反方向。
      const dir = (input.throttle < 0 && vf < 0) ? -1 : 1;
      if (this.drifting) {
        // 漂移中的车头变化不在这里算：轨迹偏航（driftPathYaw）和滑移角变化（driftDA）
        // 在漂移状态机里已经算好，下面统一写进 heading。
      } else if (this.floatMode) {
        // 船头不是"打方向立刻到位"：角速度要追赶目标值，急打方向会多滑半拍
        const target = steer * def.turnRate * (0.45 + 0.55 * speedFactor) * dir;
        this.angVel += (target - this.angVel) * Math.min(1, 5.5 * dt);
        this.heading += this.angVel * dt;
      } else {
        // 转向率 = 峰值 × 速度曲线 × 一阶惯性：
        //   · 低速（<8% 极速）几乎转不动 —— 原地打方向船头不动
        //   · 中高速最灵，接近极速时略收（重船高速不敢急打）
        //   · angVel 追目标值要时间，急打方向会"甩半拍"，不是瞬间把船头掰过去
        const spRaw = Math.min(1, Math.abs(vf) / Math.max(1, def.maxSpeed));
        // 贴墙时给速度权重兜底：见上面 speedFactor 的注释。0.30 ≈ 8m/s 的档位，
        // 顶死状态下也能用 1 秒出头把 70° 的船头掰开。
        const sp = wallContact ? Math.max(spRaw, WALL_YAW_MIN_SP) : spRaw;
        const lowRaw = Math.max(0, Math.min(1, (sp - 0.04) / 0.26));
        const lowCut = lowRaw * lowRaw * (3 - 2 * lowRaw);
        const highCut = 1 - 0.25 * Math.max(0, Math.min(1, (sp - 0.75) / 0.25));
        const curve = lowCut * highCut;
        const yawPeak = def.turnRate * this.handling.yawScale;
        const target = steer * yawPeak * curve * dir;
        this.angVel += (target - this.angVel) * (1 - Math.exp(-dt / this.handling.yawTau));
        this.heading += this.angVel * dt;
      }
    }

    // 车头 = 轨迹方向 + 滑移角：driftAngle 变化时车头跟着转，轨迹方向不动；
    // 漂移中再叠加轨迹自身的偏航（driftPathYaw）。这一步必须在重组速度之前，
    // 因为速度是"沿轨迹"给的，不是"沿车头"给的。
    // driftPathYaw 在断漂后按 0.12s 衰减，所以出弯那一刻轨迹仍在弯里收，不会一帧拉直。
    this.heading += this.driftDA + this.driftPathYaw * dt;

    // 重组速度
    // 漂移/收角时：速度大小不变，方向按滑移角从车头反向偏出去。
    //   vf = S·cos(A)，vl = -S·sin(A)  →  速度方向 = heading - A = 轨迹方向
    // 这一步是"漂移"和"贴地转向"的分水岭：旧版直接拿车头重组，
    // 速度被强行拉着跟车头一起转，滑移角只能靠假侧滑凑 14°。
    if (Math.abs(this.driftAngle) > 1e-4) {
      const S = Math.max(0, Math.hypot(vf, vl));
      const A = this.driftAngle;
      vf = S * Math.cos(A);
      vl = -S * Math.sin(A);
    }
    const nfx = Math.sin(this.heading);
    const nfz = Math.cos(this.heading);
    this.vel.x = nfx * vf + nfz * vl;
    this.vel.y = nfz * vf - nfx * vl;

    // 打 BOSS：世界方向驱动。按哪边就以哪个方向输出速度，
    // 不再“先慢慢转船头、再沿船头加速”（那会让船在转身期间朝旧方向漂）。
    if (input.worldX != null && input.worldZ != null) {
      const wl = Math.hypot(input.worldX, input.worldZ) || 1;
      const wx = input.worldX / wl;
      const wz = input.worldZ / wl;
      const mag = THREE.MathUtils.clamp(input.worldMag ?? 1, 0, 1);
      const targetSpeed = def.maxSpeed * powerMul * mag;
      const cur = Math.hypot(this.vel.x, this.vel.y);
      const next = THREE.MathUtils.lerp(cur, targetSpeed, 1 - Math.exp(-9 * dt));
      this.vel.x = wx * next;
      this.vel.y = wz * next;
      // 船头快速对齐移动方向（纯视觉），横向平移时不会出现“船斜着漂”的错觉
      const want = Math.atan2(wx, wz);
      let dh = want - this.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      this.heading += THREE.MathUtils.clamp(dh, -14 * dt, 14 * dt);
    }
    // 滑移角（甩尾程度，视觉/HUD 用）：由速度与车头的实际夹角量出来。
    // 漂移状态下它恒等于 -driftAngle（速度永远落在车头的外侧），
    // 所以这里只做"量测"，绝不再反写 driftAngle —— 那是漂移的主状态。
    this.slipAngle = Math.atan2(vl, Math.abs(vf) + 0.001);

    // 漂浮手感：浪坡把船往低处推 —— 顺浪加速、逆浪顶住、横浪侧滑。
    // 暴风雨里 waveScale=2.4，坡更陡，船会明显更飘（这就是难度来源）。
    if (this.floatMode) {
      const [sxp, szp] = waveSlope(this.pos.x, this.pos.z, t);
      this.vel.x -= sxp * 11 * dt;
      this.vel.y -= szp * 11 * dt;
      // 没打方向时角速度自然衰减，避免一直转圈
      if (!controllable) this.angVel *= Math.max(0, 1 - 3 * dt);
    }

    // 限速：在位移之前裁剪水平速度，读起来是"被拖住了"，
    // 而不是"先冲一段再突然减速"。限速期间仍可转向、可漂移。
    if (this.speedCapTimer > 0) {
      const cur = Math.hypot(this.vel.x, this.vel.y);
      if (cur > this.speedCap && cur > 0.001) {
        const k = this.speedCap / cur;
        this.vel.x *= k;
        this.vel.y *= k;
      }
    }

    // 位置积分
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.y * dt;
    this.speed = Math.hypot(this.vel.x, this.vel.y);

    // Drift uses its original twin water-surface tire marks. It deliberately
    // has no airborne droplet layer, which keeps the sea readable.
    if (this.drifting && this.speed > 4) {
      this.markTimer -= dt;
      if (this.markTimer <= 0) {
        this.markTimer = 0.035;
        const velDir = Math.atan2(this.vel.x, this.vel.y);
        this.#spawnDriftMark(this.pos.x, this.pos.z, velDir, 1);
        this.#spawnDriftMark(this.pos.x, this.pos.z, velDir, -1);
      }
    }
    this.#updateDriftMarks(dt);
    // 扫掠碰撞：高速船一帧内不能从障碍里"跳过去"。
    //  ① collider 带 px/pz 时按相对轨迹算（船位移 - 障碍位移），浮桶/滚石/抡臂
    //     迎面扫过慢船也不会漏判；
    //  ② 取线段与圆的**第一个交点**当接触法线。旧版用「终点相对圆心」的方向，
    //     一帧跨过整个障碍时会把船直接放到出口那一侧 —— 这就是加速穿模；
    //  ③ heavy 障碍只在「整段跨过」时介入且只修位置，回弹 / 撞碎仍走下方圆碰撞。
    const moveX = this.pos.x - this.prevPos.x;
    const moveZ = this.pos.z - this.prevPos.z;
    if (moveX * moveX + moveZ * moveZ > 1e-6) {
      for (const c of colliders) {
        const minD = c.r + 1.3;
        const hasPrev = Number.isFinite(c.px) && Number.isFinite(c.pz);
        const sx = this.prevPos.x - (hasPrev ? c.px : c.x);
        const sz = this.prevPos.z - (hasPrev ? c.pz : c.z);
        const ex = this.pos.x - c.x;
        const ez = this.pos.z - c.z;
        const rx = ex - sx;
        const rz = ez - sz;
        const a = rx * rx + rz * rz;
        if (a <= 1e-6) continue;
        const b = 2 * (sx * rx + sz * rz);
        const cc = sx * sx + sz * sz - minD * minD;
        let u;
        if (cc > 0) {
          const disc = b * b - 4 * a * cc;
          if (disc < 0) continue;
          u = (-b - Math.sqrt(disc)) / (2 * a);
          if (u < 0 || u > 1) continue;
        } else {
          u = 0;   // 起点已在区内：这一帧的圆碰撞会正常推出
        }
        // ⚠ 起点已经在圆内：位置由下面的圆碰撞按法线推出、速度由它按恢复系数反弹，
        // 这里**什么都不能做**。旧版继续往下走，于是每帧 `vel *= 0.55` + 硬直重置回
        // 0.38 —— 船贴着石头按住油门时被无限次削速，表现出来就是"高速撞石头，停住了"。
        if (cc <= 0) continue;
        // 只有「一帧内整段跨过障碍」才拉回进入侧。浅擦（贴着边蹭过去）
        // 必须继续用终点方向法线，否则横向偏移会被抹掉，船被钉在障碍正后方
        // 再也绕不过去 —— 这是 CCD 最容易带出来的手感回归。
        let uq = -(sx * rx + sz * rz) / a;
        uq = THREE.MathUtils.clamp(uq, 0, 1);
        const qDist = Math.hypot(sx + rx * uq, sz + rz * uq);
        const deepTunnel = cc > 0 && Math.hypot(ex, ez) >= minD && qDist < minD * 0.72;
        if (c.heavy && !deepTunnel) continue;
        let nx;
        let nz;
        if (deepTunnel) {
          const hx = sx + rx * u;          // 线段与圆的第一个交点 = 进入侧
          const hz = sz + rz * u;
          const hLen = Math.hypot(hx, hz);
          nx = hLen > 0.001 ? hx / hLen : -Math.sin(this.heading || 0);
          nz = hLen > 0.001 ? hz / hLen : -Math.cos(this.heading || 0);
        } else {
          const endLen = Math.hypot(ex, ez);
          nx = endLen > 0.001 ? ex / endLen : Math.sin(this.heading || 0);
          nz = endLen > 0.001 ? ez / endLen : Math.cos(this.heading || 0);
        }
        // heavy 留 2cm 在区内，让下面的圆碰撞接手回弹 / 撞碎判定
        const rest = c.heavy ? minD - 0.02 : minD;
        this.pos.x = c.x + nx * rest;
        this.pos.z = c.z + nz * rest;
        if (c.heavy) {
          this.heavyImpactSpeed = Math.max(this.heavyImpactSpeed || 0,
            Math.abs(this.vel.x * nx + this.vel.y * nz));
          continue;
        }
        // ⚠ 起点已经在圆内（cc <= 0）的情况上面已经 continue 掉了，
        // 这里只处理"这一帧真的撞进去"的一次性反弹。
        const dotC = this.vel.x * nx + this.vel.y * nz;
        if (dotC < 0) {
          // 与圆碰撞同一套：法向按恢复系数反弹、切向几乎全保留
          const closingC = -dotC;
          const kC = THREE.MathUtils.clamp((closingC - 4) / 20, 0, 1);
          const eC = 0.22 + 0.34 * kC;
          const txC = this.vel.x - dotC * nx;
          const tzC = this.vel.y - dotC * nz;
          this.vel.x = txC * 0.99 - dotC * eC * nx;
          this.vel.y = tzC * 0.99 - dotC * eC * nz;
        }
        this.stunTimer = Math.max(this.stunTimer, 0.12);
        this.cancelDriftForCollision();
      }
    }

    // 障碍碰撞（圆-圆）
    for (const c of colliders) {
      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const dist = Math.hypot(dx, dz);
      const minD = c.r + 1.3;
      if (dist < minD) {
        const push = (minD - dist);
        // Exact center overlap used to skip resolution, leaving a boat trapped
        // inside a collider indefinitely. Push along the current hull axis.
        const nx2 = dist > 0.001 ? dx / dist : Math.sin(this.heading || 1);
        const nz2 = dist > 0.001 ? dz / dist : Math.cos(this.heading || 1);
        this.pos.x += nx2 * push;
        this.pos.z += nz2 * push;
        // ---------------- 撞击响应（赛车 / 赛艇游戏的通用写法）----------------
        //   v' = v_t·μ − e·v_n·n̂
        //   法向 v_n 按恢复系数 e 弹回去（e 随撞击速度升，低速≈不弹 → 顶住不抖）；
        //   切向 v_t 只做轻微摩擦（μ≈1）→ 斜撞会被"抹"向切线、贴着石头滑出去，
        //   而不是像旧版那样把**整条速度**乘一个 keep 一刀砍掉（那才是"撞完就停"）。
        const dot = this.vel.x * nx2 + this.vel.y * nz2;
        const impact = Math.abs(dot);
        const closing = dot < 0 ? -dot : 0;
        const dyn = !!c.ref;                        // 动态硬物（滚石/落石）本来就该弹人
        if (c.heavy) {
          // 记录撞击瞬间的法向速度：applyMechs 的撞碎判定在回弹之后跑，要读这个值
          this.heavyImpactSpeed = Math.max(this.heavyImpactSpeed || 0, impact);
        }
        if (closing > 1.5) {
          // 失败归因：只在「真撞」（>3m/s 法向）时留一条痕迹给 Game 读，
          // 低速顶住石头不算 —— 那读起来是"卡住"，不是"撞了"。
          if (closing > 3) this.lastHardHit = { kind: 'rock', speed: closing };
          // 恢复系数：4m/s 以下压到最低（顶住不弹），24m/s 以上给到最大
          const k = THREE.MathUtils.clamp((closing - 4) / 20, 0, 1);
          const e = (dyn ? 0.32 : 0.20) + (dyn ? 0.26 : 0.28) * k;
          const mu = dyn ? 0.94 : 0.99;             // 切向摩擦：几乎全保留
          this.vel.x = (this.vel.x - dot * nx2) * mu - dot * e * nx2;
          this.vel.y = (this.vel.y - dot * nz2) * mu - dot * e * nz2;
          // 最小分离速度：保证"真的弹开"，而不是贴着石头把速度磨光。
          // 只在 closing > 4 时补，且不超过来速的 55%，不凭空造能量。
          if (closing > 4) {
            const want = Math.min(2.0 + closing * 0.14, closing * 0.55);
            const sep = this.vel.x * nx2 + this.vel.y * nz2;
            if (sep < want) {
              const add = want - sep;
              this.vel.x += nx2 * add;
              this.vel.y += nz2 * add;
            }
          }
          // 刚撞完让水"抓不住"船：否则反弹出来的横向分量会被抓地在一帧内抹平
          this.impactGripTimer = Math.max(this.impactGripTimer || 0, 0.22);
          // 撞击角度 → 侧翻 / 船头被撞歪 / 抖屏
          if (closing > (dyn ? 1.5 : 4)) {
            const lateral = nx2 * Math.cos(this.heading) - nz2 * Math.sin(this.heading);
            const sign = lateral >= 0 ? 1 : -1;
            const k2 = THREE.MathUtils.clamp((closing - 4) / 18, 0.12, 1);
            this.applyCollisionRoll?.(sign * (0.08 + 0.40 * k2));
            this.angVel += sign * (0.25 + 1.5 * k2);      // 船头被撞歪
            this.hitShake = Math.max(this.hitShake, 0.16 + 0.16 * k2);
            // 硬直只做"顿挫"：旧版最长 0.9s，玩家会以为船被撞死了
            this.stunTimer = Math.max(this.stunTimer, 0.08 + 0.24 * k2);
          }
          // 被撞的硬物也"晃一下"（滚石用它做视觉反弹，静态岩无 ref 就跳过）
          if (c.ref) {
            c.ref.shoveT = 0.5;
            c.ref.shoveX = nx2;
            c.ref.shoveZ = nz2;
          }
        } else if (dot < 0) {
          // 低速顶住：只拿掉"往石头里钻"的那一份法向速度，切向全保留。
          // 不反弹 → 不会每帧来回弹（旧版"贴在柱子上抽搐"就是反弹过头造成的）。
          this.vel.x -= dot * nx2;
          this.vel.y -= dot * nz2;
        }
        // 静止硬物"顶死"时的蹭边通道：速度被吃光后转向率也跟着归零，
        // 不补这一下玩家会被真的钉在石头上出不去。按住方向 + 油门才给。
        if (!dyn && closing < 2.5 && Math.hypot(this.vel.x, this.vel.y) < 3) {
          const st = THREE.MathUtils.clamp(input?.steer || 0, -1, 1);
          const th = input?.throttle || 0;
          if (Math.abs(st) > 0.15 && th > 0) {
            // 切线两侧取与「转向 → 船右侧」同向的那一侧
            const rxv = Math.cos(this.heading);
            const rzv = -Math.sin(this.heading);
            let sxv = -nz2;
            let szv = nx2;
            if (sxv * rxv + szv * rzv < 0) { sxv = -sxv; szv = -szv; }
            if (st < 0) { sxv = -sxv; szv = -szv; }
            const slide = Math.min(4.5, 2.4 * Math.abs(st)) * Math.min(1, th);
            this.vel.x += sxv * slide;
            this.vel.y += szv * slide;
            // 船头跟着抹一点，读起来像"贴着石头滑过去"而不是横向平移
            this.heading += st * 0.55 * dt;
          }
        }
        this.speed = Math.hypot(this.vel.x, this.vel.y);
        // 撞击音：只有本地艇出（AI 撞石头不该从玩家音箱里响起来）。
        // 门槛定在 8 m/s —— 贴着石头蹭过去不该一直"咚咚咚"。
        if (this.isLocal && impact > 8) {
          const rocky = c.type === 'rock' || c.type === 'cliff' || c.type === 'island';
          audio.play(rocky ? 'hit_rock' : 'hit_buoy', { gap: 140 });
        }
        this.cancelDriftForCollision();
      }
    }

    // 外海边界：硬性拦回 + 法向回弹（所有地图的最后一道保险）。
    // 旧版只把位置钳回圆内并 vel *= 0.6，船速快时会在边界上反复"贴脸"，
    // 巨浪腾空后甚至能带着速度滑出边界。现在按撞墙处理：法向分量反弹、
    // 切向分量保留（允许沿边界滑走），撞得越狠反弹越明显。
    if (boundary) {
      const dx = this.pos.x - boundary.x;
      const dz = this.pos.z - boundary.z;
      const dist = Math.hypot(dx, dz);
      if (dist > boundary.r) {
        const nx2 = dist > 0.001 ? dx / dist : Math.sin(this.heading);
        const nz2 = dist > 0.001 ? dz / dist : Math.cos(this.heading);
        this.pos.x = boundary.x + nx2 * boundary.r;
        this.pos.z = boundary.z + nz2 * boundary.r;
        const vn = this.vel.x * nx2 + this.vel.y * nz2; // > 0 = 正在向外冲
        if (vn > 0) {
          const tx = this.vel.x - vn * nx2;
          const tz = this.vel.y - vn * nz2;
          // 低速贴边几乎不弹（避免沿着边界抖），高速直接撞上去回弹 50%
          const restitution = 0.12 + 0.38 * THREE.MathUtils.clamp((vn - 4) / 14, 0, 1);
          this.vel.x = tx * 0.92 - vn * restitution * nx2;
          this.vel.y = tz * 0.92 - vn * restitution * nz2;
          this.speed = Math.hypot(this.vel.x, this.vel.y);
          if (this.isLocal && vn > 10) audio.play('hit_buoy', { gap: 160 });
        } else {
          this.vel.multiplyScalar(0.55);
        }
        this.wallContactTimer = 0.35;
        if (vn > 12) this.stunTimer = Math.max(this.stunTimer, 0.3);
        this.cancelDriftForCollision();
      }
    }

    // Reconcile short host corrections after local prediction. This keeps the
    // local client responsive while preventing the snapshot from snapping the
    // boat backwards every 50 ms.
    if (this.networkCorrection) {
      const correction = this.networkCorrection;
      const k = 1 - Math.exp(-9 * dt);
      this.pos.x = THREE.MathUtils.lerp(this.pos.x, correction.x, k);
      this.pos.z = THREE.MathUtils.lerp(this.pos.z, correction.z, k);
      this.pos.y = THREE.MathUtils.lerp(this.pos.y, correction.y, k);
      let dh = correction.heading - this.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      this.heading += dh * k;
      this.vel.x = THREE.MathUtils.lerp(this.vel.x, correction.vx, k);
      this.vel.y = THREE.MathUtils.lerp(this.vel.y, correction.vz, k);
      this.speed = THREE.MathUtils.lerp(this.speed, correction.speed, k);
      if (Math.hypot(correction.x - this.pos.x, correction.z - this.pos.z) < 0.06) this.networkCorrection = null;
    }

    // ---------- 大浪抛飞：冲上陡峭浪尖时短暂腾空 ----------
    // 垂直变化率同时包含"船在波面前进"和"波浪自身抬升"两部分，
    // 因此迎浪高速冲刺时才会被顶起，低速/顺浪滑下不会被误判。
    if (this.waveJumpCooldown > 0) this.waveJumpCooldown -= dt;
    if (
      this.waveJumpEnabled
      && this.waveLaunchEnabled
      && !this.airborne
      && !this.onCoaster
      && this.diveTargetY == null
      && this.iceRideY == null
      && this.speed > 16.5
      && this.waveJumpCooldown <= 0
    ) {
      const rate = waveVerticalRate(this.pos.x, this.pos.z, t, this.vel.x, this.vel.y);
      const ampSum = waveAmpSum();
      const hNow = waveHeight(this.pos.x, this.pos.z, t);
      // 海啸浪面：浪尖抬升速度够快 + 已经在半浪高以上 → 被抛离水面
      // 阈值取"原版太容易起飞(13m/s) / 上一版太保守(20m/s)"的中间值
      if (rate > 1.75 && hNow > ampSum * 0.32) {
        this.airborne = true;
        this.waveJump = true;
        this.airTime = 0;
        // 垂直初速随浪尖抬升速度放大，浪越大飞得越高（最高约 2m+、滞空 1.5s）
        this.vy = THREE.MathUtils.clamp(rate * 0.8 + 1.4, 4.5, 9.5);
        this.waveJumpCooldown = 1.9;
        this.#splashBurst(1.15);
        if (this.isLocal) audio.play('wave_launch');
        if (this.miniBoostTimer > 0) this.miniBoostTimer = 0;
      }
    }

    this.#applyPose(t, input);
    this.#emitWake(dt, boosting);
    this.#updateRowing(dt, input.throttle);
  }

  /** 应用波浪浮沉 + 姿态（潜行区平滑下潜/上浮） */
  #applyPose(t, input = null) {
    const x = this.pos.x;
    const z = this.pos.z;
    const h = waveHeight(x, z, t);
    const [sx, sz] = waveSlope(x, z, t);

    // 沉没动画：平滑下沉/上浮（沉没结束后浮回水面）
    const targetSink = this.sinkTimer > 0 ? -2.6 : 0;
    this.sinkY = THREE.MathUtils.lerp(this.sinkY, targetSink, 0.06);

    // 潜行区：目标深度平滑跟随（快速下潜/上浮）；否则贴水面浮力
    if (this.airborne || this.onCoaster) {
      // 腾空/轨道段：y 由弹射物理/轨道 spline 管理，不吃浮力
      this.diveVel = 0;
    } else if (this.diveTargetY != null) {
      // 上桥/走坡道必须"贴着路面"：0.045 是给下潜调的时间常数，跟不上 30m/s 的爬坡，
      // 会插进桥面里；所以目标在水面以上（或船还在半空）时用快得多的跟随系数。
      const climbing = this.diveTargetY > 0.05 || this.pos.y > 1.2;
      // 单帧修正上限 3m：正常爬坡每帧只差 0.2~0.4m，根本不会碰到这个上限；
      // 但"从瀑布崖口飞出去、落在坡下"这种十几米的落差如果按 0.34 一帧拉满，
      // 就是一次肉眼可见的瞬移（相机也会被甩到船下面）。夹一下变成几帧滑上去。
      const dy = (this.diveTargetY - this.pos.y) * (climbing ? 0.34 : 0.045);
      this.pos.y += THREE.MathUtils.clamp(dy, -3, 3);
      this.diveVel = THREE.MathUtils.clamp(this.diveTargetY - this.pos.y, -3, 3);
    } else {
      // 大浪里船要"贴着浪面"走，但不能被浪挡住船身：
      // 采样船体前后左右一圈的浪高，取最高点作为浮力目标，再留一点吃水余量。
      // 只抬不压 —— 船在波谷时也会被托到附近浪峰高度之上，
      // 而浪越大"抬到浪峰"的权重越高，晴天小浪时仍然贴当地水面，不会有漂浮感。
      const fx = Math.sin(this.heading);
      const fz = Math.cos(this.heading);
      const rx = fz;
      const rz = -fx;
      let crest = h;
      crest = Math.max(crest, waveHeight(x + fx * 4.0, z + fz * 4.0, t));
      crest = Math.max(crest, waveHeight(x - fx * 4.0, z - fz * 4.0, t));
      crest = Math.max(crest, waveHeight(x + rx * 3.0, z + rz * 3.0, t));
      crest = Math.max(crest, waveHeight(x - rx * 3.0, z - rz * 3.0, t));
      const amp = waveAmpSum();
      const big = THREE.MathUtils.smoothstep(amp, 0.85, 1.9); // 0=平静 1=大浪
      const rise = THREE.MathUtils.clamp(amp * 0.18, 0.12, 0.7);
      // 冰壳区：水面已被隐藏，船必须贴着冰面走（否则浪谷时整艘钻进冰里）
      let floatY = this.iceRideY != null
        ? this.iceRideY
        : THREE.MathUtils.lerp(h, crest + rise, 0.25 + 0.75 * big);
      // 赛道水面下限（秘境漂流这类 GLB 水面的图）：洞里的水是平的，
      // 跟着海面浪谷沉下去就会整艘沉进水里，这里垫一个"不许低于它"的地板。
      if (this.floatFloorY != null) floatY = Math.max(floatY, this.floatFloorY);
      this.pos.y = THREE.MathUtils.lerp(this.pos.y, floatY, 0.5);
      this.diveVel = 0;
    }

    this.group.position.copy(this.pos);
    this.group.position.y += this.sinkY;

    // 甩尾视觉：车头朝向（heading）已被漂移物理真实地拉进弯内，
    // 速度方向才是 vel 的方向 → 车头与运动轨迹自然分离，无需额外视觉偏移
    this.group.rotation.y = this.heading;

    // 接触阴影：贴在当地波高上（避免被浪峰切掉一半），腾空/沉没/异世界时隐藏
    if (this.contactShadow) {
      const onWater = !this.airborne && this.sinkY > -0.8 && this.voidTimer <= 0;
      this.contactShadow.visible = onWater;
      if (onWater) {
        // 阴影贴在水面上，而不是跟着船一起抬高（大浪里船被托到浪峰之上时，
        // 跟着船走会让圆盘悬空，看起来像一块浮在空中的黑影）
        this.contactShadow.position.set(
          this.pos.x, (this.iceRideY ?? h) + this.sinkY + 0.08, this.pos.z,
        );
        this.contactShadow.rotation.y = this.heading;
      }
    }

    // 波浪倾斜 + 加减速纵倾（波浪项衰减到 0.45：减少左摇右晃的晕船感，只保留浪感）
    const accelPitch = input ? -input.throttle * 0.06 : 0;
    // 小喷时船头兴奋上抬
    const boostPitch = this.miniBoostTimer > 0 ? -0.09 : 0;
    // 潜水纵倾：下潜低头（+）/ 上浮抬头（-）
    const divePitch = -this.diveVel * 0.12;
    if (this.airborne || this.onCoaster) {
      // 腾空/轨道姿态：机头随垂直速度俯仰（爬升抬头、下坠俯冲），转向压侧倾
      const pitch = THREE.MathUtils.clamp(
        Math.atan2(-this.vy, Math.max(this.speed, 6)), -0.45, 1.05,
      );
      this.group.rotation.x = THREE.MathUtils.lerp(this.group.rotation.x, pitch, 0.12);
      const roll = this.steerInput * -0.24 + this.collisionRoll;
      this.group.rotation.z = THREE.MathUtils.lerp(this.group.rotation.z, roll, 0.10);
    } else {
      // 浪面俯仰：海啸级浪坡下船头明显抬头/低头（系数 0.45 → 0.8，并做角度夹紧）
      const wavePitch = (-sz * Math.cos(this.heading) - sx * Math.sin(this.heading)) * 0.8;
      this.group.rotation.x = THREE.MathUtils.lerp(
        this.group.rotation.x,
        THREE.MathUtils.clamp(wavePitch, -0.6, 0.6) + accelPitch + boostPitch + divePitch + (this.stunTimer > 0 ? 0.15 : 0),
        0.13,
      );
      // 漂移侧倾：整个船体向漂移内侧压过去（QQ 飞车漂移压弯手感）
      // 波浪侧倾同步放大到 0.72，横向大浪能把船明显推歪
      const waveRoll = (-sx * Math.cos(this.heading) + sz * Math.sin(this.heading)) * 0.72;
      this.group.rotation.z = THREE.MathUtils.lerp(
        this.group.rotation.z,
        THREE.MathUtils.clamp(waveRoll, -0.65, 0.65)
          + this.steerInput * -0.05 * Math.min(1, this.speed / 5)
          // 漂移侧倾跟着**真实滑移角**走：浅漂轻轻压、拉满 40° 才压到 -0.34；
          // 断漂收角那 0.16 秒里角度还在，侧倾跟着慢慢回正，不会一帧立起来
          + (Math.abs(this.driftAngle) > 0.02
            ? Math.sign(this.driftAngle) * -0.34
              * Math.min(1, Math.abs(this.driftAngle) / 0.45) * Math.min(1, this.speed / 6)
            : 0)
          + this.collisionRoll,
        0.16,
      );
    }

    // 受击抖动：叠加在最终位姿上（位移 + 姿态），计时衰减到 0 自然收住。
    // 放在最后是因为上面的波浪/漂移姿态每帧都在 lerp，叠在中间会被抹平。
    if (this.hitShake > 0) {
      const k = Math.min(1, this.hitShake / 0.34);
      const amp = k * k;
      this.group.position.x += Math.sin(t * 46) * amp * 0.42;
      this.group.position.z += Math.cos(t * 39) * amp * 0.42;
      this.group.position.y += Math.sin(t * 52) * amp * 0.14;
      this.group.rotation.z += Math.sin(t * 41) * amp * 0.09;
      this.group.rotation.x += Math.cos(t * 47) * amp * 0.06;
    }

    // 鱼雷翻船：整船绕纵轴翻到侧面（±180°）再翻回来，同时抬离水面。
    // 放在最后叠加，和受击抖动同理 —— 前面的姿态每帧都在 lerp，夹在中间会被抹平。
    // 本地艇和远程艇都走 #applyPose，所以这里一处就够两端都看得到。
    if (this.capsizeTimer > 0) {
      const dur = Math.max(0.4, this.capsizeDur || 1.2);
      const k = 1 - Math.min(1, this.capsizeTimer / dur);   // 0→1
      const swing = Math.sin(k * Math.PI);                  // 0→1→0
      this.group.rotation.z += this.capsizeDir * swing * Math.PI;
      this.group.rotation.x += swing * 0.32;
      this.group.position.y += swing * 0.55;
    }

    // 掉出赛道：坠落最后一段整船闪烁（QQ 飞车掉峡谷那种"闪回"）。
    // blinkTimer 由 Game 每帧按剩余的坠落时间写进来，归零后自动恢复可见；
    // 写在这里而不是 Game 里，是因为远程艇也走 #applyPose，一处就够两端同步。
    if (this.blinkTimer > 0) {
      this.group.visible = Math.floor(this.blinkTimer * 14) % 2 === 0;
    } else if (!this.group.visible) {
      this.group.visible = true;
    }
  }

  /** 落水/入水效果：大水花爆发 + 冲刺加速（过山车落水瞬间） */
  #landingEffects(boostDur = 1.3) {
    this.boostTimer = Math.max(this.boostTimer, boostDur);
    // 环形大水花：从落点向外炸开
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r = 2.5 + (i % 3) * 1.4;
      this.#spawnWake(
        new THREE.Vector3(this.pos.x + Math.cos(a) * r, 0, this.pos.z + Math.sin(a) * r),
        3.4 + (i % 4) * 0.9, 0.9,
      );
    }
    this.#spawnWake(new THREE.Vector3(this.pos.x, 0, this.pos.z), 5.2, 0.95);
    this.#spawnWake(new THREE.Vector3(this.pos.x, 0, this.pos.z), 6.8, 0.7);
    // 砸回水面：向外炸开的水滴 + 一圈飘散的水雾
    if (this.detail && this.pos.y > -1.5) {
      const n = this.isLocal ? 14 : 6;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        this.#emitDrop(
          this.pos.x + Math.cos(a) * 1.0,
          this.pos.z + Math.sin(a) * 1.0,
          Math.cos(a) * (2.5 + Math.random() * 3),
          Math.sin(a) * (2.5 + Math.random() * 3),
          2.4 + Math.random() * 2.4,
          0.9,
        );
      }
      for (let i = 0; this.isLocal && i < 5; i++) {
        const a = Math.random() * Math.PI * 2;
        this.#emitMist(
          this.pos.x + Math.cos(a) * 1.6,
          this.pos.z + Math.sin(a) * 1.6,
          Math.cos(a) * 1.3,
          Math.sin(a) * 1.3,
          0.3,
          0.9,
        );
      }
    }
    this.#splashBurst();
  }

  #emitWake(dt, boosting) {
    if (this.speed < 2) return;
    if (this.pos.y < -1.5) return; // 水下潜行段不产生水面尾迹
    this.wakeTimer -= dt;
    // 12-13 emissions/sec are enough for a continuous stern wake while
    // keeping transparent overdraw bounded when several boats are visible.
    const interval = 0.11;
    if (this.wakeTimer > 0) return;
    this.wakeTimer = interval;

    const v = Math.min(1.25, this.speed / (this.def.maxSpeed || 30));
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const sideX = fz;
    const sideZ = -fx;
    const sternX = this.pos.x - fx * this.def.hull.length * 0.5;
    const sternZ = this.pos.z - fz * this.def.hull.length * 0.5;

    // Large wake sprites are reserved for straight-line travel. During drift
    // they would cover the directional droplets and read as a smoke cloud.
    // 这些面片只做泡沫的“体积感”薄层——主体泡沫带由水面着色器绘制，
    // 这里必须压低透明度，否则几十个面片叠起来会读成一条纯白硬条。
    if (!this.drifting) {
      const scale = 0.85 + v * 2.3;
      // 玩家船尾的泡沫带由水面着色器绘制（气泡纹理 + 三层分层 + 随年龄变宽变淡），
      // 这里再叠一排面片只会盖住纹理、读成一条纯白硬条，所以玩家不发射；
      // AI 没有水面泡沫带，仍然靠这排面片撑住体积。
      if (!this.isLocal) {
        const opacity = Math.min(0.46, 0.06 + v * 0.36);
        this.#spawnWake(new THREE.Vector3(sternX, 0, sternZ), scale, opacity);
      }
    }
    if (boosting && !this.drifting) {
      // 氮气：船尾掀起大浪（替代旧火焰特效）。玩家是叠在着色器泡沫带上的，
      // 透明度再压一档；AI 没有水面泡沫带，靠这层撑住体积。
      const bk = this.isLocal ? 0.6 : 1;
      this.#spawnWake(new THREE.Vector3(sternX, 0, sternZ), 3.2, 0.7 * bk);
      this.#spawnWake(new THREE.Vector3(sternX, 0, sternZ), 4.6, 0.42 * bk);
      // 尾侧两道八字浪
      this.#spawnWake(new THREE.Vector3(sternX + sideX * 2.2, 0, sternZ + sideZ * 2.2), 2.6, 0.5 * bk);
      this.#spawnWake(new THREE.Vector3(sternX - sideX * 2.2, 0, sternZ - sideZ * 2.2), 2.6, 0.5 * bk);
    }
    // Bow wake is also disabled while drifting; drift uses only the small
    // ballistic spray above, so its particles remain legible.
    if (!this.drifting) {
      const bowX = this.pos.x + fx * this.def.hull.length * 0.45;
      const bowZ = this.pos.z + fz * this.def.hull.length * 0.45;
      const sprayScale = boosting ? 2.2 : 0.6 + v * 1.3;
      const sprayOpacity = boosting ? 0.7 : Math.min(0.4, v * 0.32);
      const spread = boosting ? 1.6 : 0.8 + v * 0.5;
      this.#spawnWake(
        new THREE.Vector3(bowX + sideX * spread, 0, bowZ + sideZ * spread),
        sprayScale, sprayOpacity,
      );
      this.#spawnWake(
        new THREE.Vector3(bowX - sideX * spread, 0, bowZ - sideZ * spread),
        sprayScale, sprayOpacity,
      );
      // 抛物线水滴 + 两侧水幕（仅玩家；AI 简化）
      this.#emitSideSpray(v);
    }
    // 漂移：外侧甩出扇形水花，内侧掀起水墙（船身倾斜由物理层表现）
    if (this.drifting) this.#emitDriftSpray(v);
  }

  /** 漂移甩尾：外侧扇形飞溅 + 内侧水墙的水雾（只给玩家，AI 简化） */
  #emitDriftSpray(v) {
    if (!this.detail || !this.isLocal || this.speed < 8) return;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const sideX = fz;
    const sideZ = -fx;
    const out = -Math.sign(this.driftDir || 1);   // 外侧：与漂移方向相反
    const sternX = this.pos.x - fx * this.def.hull.length * 0.3;
    const sternZ = this.pos.z - fz * this.def.hull.length * 0.3;
    const spread = this.def.hull.width * 0.6;
    const n = 3 + Math.round(v * 3);
    for (let i = 0; i < n; i++) {
      const j = 0.7 + Math.random() * 0.9;
      this.#emitDrop(
        sternX + sideX * out * spread,
        sternZ + sideZ * out * spread,
        sideX * out * (2.4 + v * 4.2) * j + fx * this.speed * 0.22,
        sideZ * out * (2.4 + v * 4.2) * j + fz * this.speed * 0.22,
        (1.6 + v * 3.2) * (0.7 + Math.random() * 0.6),
        0.45 + v * 0.4,
      );
    }
    // 内侧水墙：贴着船体掀起的一层薄雾
    if (v > 0.4) {
      this.#emitMist(
        sternX - sideX * out * spread * 1.2,
        sternZ - sideZ * out * spread * 1.2,
        -sideX * out * (1.0 + v * 1.2) + fx * this.speed * 0.25,
        -sideZ * out * (1.0 + v * 1.2) + fz * this.speed * 0.25,
        0.7 + v * 0.8,
        0.08 + v * 0.14,
      );
    }
  }

  /** 远程艇：设置网络目标状态 */
  setRemoteState(x, z, heading, speed, boosting, y, vx, vz, roll) {
    // 快照按本地时钟入队（时间戳用收到消息的时刻，客户端间时钟无需对齐，
    // 因为只有各自的 remoteClock 在推进）。
    this.remoteSnaps.push({
      t: this.remoteClock,
      x, z, heading, speed, boosting,
      vx: Number.isFinite(vx) ? vx : null,
      vz: Number.isFinite(vz) ? vz : null,
      roll: Number.isFinite(roll) ? roll : null,
      y,
    });
    // 只保留回放时刻之前的一段历史。长度守卫保证至少留 2 帧供插值，
    // 否则 renderT 会退到 snaps[0] 之后而无法推进。
    while (this.remoteSnaps.length > 3 && this.remoteSnaps[1].t < this.remoteClock - REMOTE_SAMPLE_DELAY) {
      this.remoteSnaps.shift();
    }
    // 硬上限：网络长时间静默时快照仍会持续入队（服务端只在有 state 时广播，
    // 但竞态下仍可能堆积），兜底截断防止内存无限增长。
    if (this.remoteSnaps.length > 16) this.remoteSnaps.splice(0, this.remoteSnaps.length - 16);
    if (!this.target) this.target = {};
    const latest = this.remoteSnaps[this.remoteSnaps.length - 1];
    this.target.x = latest.x;
    this.target.z = latest.z;
    this.target.heading = latest.heading;
    this.target.speed = latest.speed;
    this.target.boosting = latest.boosting;
    if (latest.vx !== null) this.target.vx = latest.vx;
    if (latest.vz !== null) this.target.vz = latest.vz;
    if (latest.roll !== null) this.target.roll = latest.roll;
    this.target.y = y; // 高度（过山车腾空/潜水）；undefined = 由本地姿态逻辑推算
  }

  /**
   * 幽灵车：直接写入位姿，不跑物理、不碰碰撞。
   *
   * 为什么不走 updateRemote：那套是「延迟回放 + 快照缓冲」，固定慢一个
   * REMOTE_SAMPLE_DELAY（80ms）。幽灵的时间轴就是本局 raceTime，
   * 多这 80ms 会让玩家永远「差一点点追不上」，反而更挫败。
   * 这里只做一件事：把位姿塞进去，然后复用 #applyPose 的浪面浮沉/侧倾/桨频。
   *
   * @param {number} dt
   * @param {number} t 全局时间（浪高相位）
   * @param {number} x 世界 X
   * @param {number} z 世界 Z
   * @param {number} heading 船头朝向（弧度）
   * @param {number} speed 记录里算出来的前进速度（只影响姿态与桨频）
   */
  updateGhost(dt, t, x, z, heading, speed = 0) {
    this.prevPos.copy(this.pos);
    this.pos.x = x;
    this.pos.z = z;
    this.heading = heading;
    this.speed = speed;
    this.vel.set(Math.sin(heading) * speed, Math.cos(heading) * speed);
    this.#updateRowing(dt, Math.min(1, speed / 8));
    this.#applyPose(t, null);
  }

  /** 幽灵车：半透明船体整体透明度（0 = 隐藏外观，仍保留位姿计算） */
  setGhostAlpha(k) {
    const a = Math.max(0, Math.min(1, k));
    this.group.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.userData.__ghostMat) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) if (m && m.transparent) m.opacity = 0.45 * a;
      }
    });
  }

  /** Apply a server-broadcast collision correction without fighting prediction. */
  applyNetworkCollisionState(state) {
    if (!state || !Number.isFinite(state.x) || !Number.isFinite(state.z)) return;
    const correction = {
      x: state.x, z: state.z,
      y: Number.isFinite(state.y) ? state.y : this.pos.y,
      heading: Number.isFinite(state.heading) ? state.heading : this.heading,
      speed: Number.isFinite(state.speed) ? state.speed : this.speed,
      vx: Number.isFinite(state.vx) ? state.vx : this.vel.x,
      vz: Number.isFinite(state.vz) ? state.vz : this.vel.y,
      roll: Number.isFinite(state.roll) ? state.roll : this.collisionRoll,
    };
    const distance = Math.hypot(correction.x - this.pos.x, correction.z - this.pos.z);
    const heightDelta = Math.abs(correction.y - this.pos.y);
    if (distance > 5 || heightDelta > 4) {
      this.pos.x = correction.x;
      this.pos.z = correction.z;
      this.pos.y = correction.y;
      this.prevPos.copy(this.pos);
      this.heading = correction.heading;
      this.vel.set(correction.vx, correction.vz);
      this.speed = correction.speed;
      this.airborne = this.pos.y > 1.5;
      this.networkCorrection = null;
    } else {
      this.networkCorrection = correction;
    }
    this.collisionRoll = correction.roll;
  }

  /** 远程艇：平滑插值到目标 */
  updateRemote(dt, t) {
    this.#updateWake(dt);
    this.remoteClock += dt;
    this.hitShake = Math.max(0, this.hitShake - dt);
    this.collisionRoll *= Math.exp(-3.6 * dt);
    // 道具效果计时（本地物理不驱动远程艇）
    if (this.sinkTimer > 0) this.sinkTimer -= dt;
    if (this.spinTimer > 0) this.spinTimer -= dt;
    if (this.slowTimer > 0) this.slowTimer -= dt;
    if (this.halfSpeedTimer > 0) this.halfSpeedTimer -= dt;
    if (this.octoGrabTimer > 0) this.octoGrabTimer -= dt;
    if (this.capsizeTimer > 0) this.capsizeTimer -= dt;
    if (this.geyserLiftTimer > 0) this.geyserLiftTimer -= dt;
    if (this.voidTimer > 0) {
      this.voidTimer -= dt;
      this.group.visible = false;
      if (this.voidTimer <= 0) this.group.visible = true;
    }
    if (this.shieldTimer > 0) this.shieldTimer -= dt;
    // 泡泡与致盲也由远程事件写入（applyFx），漏递减会让远程艇永久卡住抬头/受限姿态
    if (this.bubbleTimer > 0) this.bubbleTimer -= dt;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.wallHitCooldown > 0) this.wallHitCooldown -= dt;
    if (this.wallContactTimer > 0) this.wallContactTimer -= dt;
    // 远程艇的升降本体由施放者自己的客户端模拟并走状态快照同步，
    // 这里只递减计时并维护表现层（水泡包裹 / 头顶小恶魔）。
    // 悬浮计时到此为止，但水泡特效还要罩住下坠过程，交给下面的独立寿命收尾。
    if (this.bubbleLiftTimer > 0) this.bubbleLiftTimer -= dt;
    if (this.bubbleWrapTimer > 0 && (this.bubbleWrapTimer -= dt) <= 0) {
      this.bubbleLiftTimer = Math.min(this.bubbleLiftTimer, 0);
      this.#clearBubbleWrap();
    }
    if (this.reverseControlTimer > 0) this.reverseControlTimer -= dt;
    this.#updateDevilMark(t);
    this.#updateShameMark(t);
    if (this.bubbleWrap?.visible) this.#updateBubbleWrap(t);
    // 漩涡打转：远程艇视觉自旋（模型自转，不干扰航向插值）。
    // Restore the authored yaw after the effect; decaying modelRoot.rotation.y
    // directly would erase Falcon's fixed quarter-turn and make it broadside.
    if (this.spinTimer > 0) this.visualSpinYaw += 9 * dt;
    else this.visualSpinYaw = THREE.MathUtils.lerp(this.visualSpinYaw, 0, Math.min(1, dt * 8));
    if (this.modelRoot) this.modelRoot.rotation.y = this.visualRotationY + this.visualSpinYaw;

    if (this.target) {
      // 延迟回放插值：在快照缓冲里找包住 (remoteClock - DELAY) 的相邻两帧并线性插值。
      // 相比原先的指数平滑追最新点，这消除了稳态滞后（40m/s 时约 3.3m）和抖动顿挫。
      // 仍然保留单帧位移上限，避免网络回放跳变被当成真实位移一帧拉过去。
      const snaps = this.remoteSnaps;
      if (snaps.length) {
        // 回放时刻不得超过最新快照，否则 f 会被钳到 1 而"卡住"一帧，
        // 形成走两步停一步的锯齿。
        const renderT = Math.min(this.remoteClock - REMOTE_SAMPLE_DELAY, snaps[snaps.length - 1].t);
        let a = null;
        let b = null;
        let f = 0;
        for (let i = snaps.length - 1; i >= 0; i--) {
          if (snaps[i].t <= renderT) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
        }
        if (!a) { a = snaps[0]; b = snaps[1] || snaps[0]; }
        if (b !== a && b.t > a.t) {
          f = THREE.MathUtils.clamp((renderT - a.t) / (b.t - a.t), 0, 1);
        }

        let nx = a.x + (b.x - a.x) * f;
        let nz = a.z + (b.z - a.z) * f;
        let nHeading = a.heading;
        let dh = b.heading - a.heading;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        nHeading = a.heading + dh * f;

        let dxx = nx - this.pos.x;
        let dzz = nz - this.pos.z;
        const planar = Math.hypot(dxx, dzz);
        if (planar > 8) {
          dxx *= 8 / planar;
          dzz *= 8 / planar;
        }
        this.pos.x += dxx;
        this.pos.z += dzz;
        // 角度最短路径插值
        let hd = nHeading - this.heading;
        while (hd > Math.PI) hd -= Math.PI * 2;
        while (hd < -Math.PI) hd += Math.PI * 2;
        this.heading += hd;
        this.speed = a.speed + (b.speed - a.speed) * f;
        const pick = (key) => {
          const av = a[key];
          const bv = b[key];
          if (av === null || av === undefined) return bv;
          if (bv === null || bv === undefined) return av;
          return av + (bv - av) * f;
        };
        const nvx = pick('vx');
        if (Number.isFinite(nvx)) this.vel.x = nvx;
        const nvz = pick('vz');
        if (Number.isFinite(nvz)) this.vel.y = nvz;
        const nroll = pick('roll');
        if (Number.isFinite(nroll)) this.collisionRoll = nroll;
      }
      // 远程高度（过山车/弹射）：仅作为视觉提示，绝不据此翻转 airborne。
      // airborne 由本地发射物理决定（弹射器/过山车路径），否则目标 y=0 时
      // airborne 会被反复清除、pos.y 抖动，表现为船在原地"顿一下"。
      // （不再因目标 y 覆盖本地的 airborne / vy）
    }
    if (this.networkCorrection) {
      const correction = this.networkCorrection;
      const k = 1 - Math.exp(-9 * dt);
      this.pos.x = THREE.MathUtils.lerp(this.pos.x, correction.x, k);
      this.pos.z = THREE.MathUtils.lerp(this.pos.z, correction.z, k);
      this.pos.y = THREE.MathUtils.lerp(this.pos.y, correction.y, k);
      let dh = correction.heading - this.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      this.heading += dh * k;
      this.vel.x = THREE.MathUtils.lerp(this.vel.x, correction.vx, k);
      this.vel.y = THREE.MathUtils.lerp(this.vel.y, correction.vz, k);
      this.speed = THREE.MathUtils.lerp(this.speed, correction.speed, k);
      if (Math.hypot(correction.x - this.pos.x, correction.z - this.pos.z) < 0.06) this.networkCorrection = null;
    }
    this.#applyPose(t);
    this.#emitWake(dt, this.boostTimer > 0);
    this.#updateDriftMarks(dt);
    this.#updateRowing(dt, 0);
    if (this.target?.boosting) this.boostTimer = 0.1;
    else if (this.boostTimer > 0) this.boostTimer -= dt;
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry.dispose();
        if (obj.material && !obj.material.__shared) obj.material.dispose();
      }
    });
    // ⚠ 必须带 `|| []`：幽灵船（{ghost:true}）跳过 #buildWake，wakePool 根本不存在。
    // 少了这个守卫，dispose() 会抛 "wakePool is not iterable" —— 症状是
    // 「换幽灵记录 / 退出比赛」时清理中断，而且它发生在析构里，很难从日志看出来。
    for (const w of this.wakePool || []) {
      this.scene.remove(w.sprite);
      w.sprite.material.dispose();
      this.scene.remove(w.crest);
      w.crest.material.dispose();
    }
    this.wakeGeometry?.dispose();
    this.wakeCrestGeometry?.dispose();
    if (this.markPool) {
      for (const mk of this.markPool) {
        this.scene.remove(mk.mesh);
        mk.mesh.material.dispose();
      }
      this.markPool[0]?.mesh.geometry.dispose();
    }
    for (const pool of [this.splashPool, this.mistPool]) {
      for (const p of pool || []) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
      }
    }
  }
}
