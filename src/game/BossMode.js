import * as THREE from 'three';
import { BOSS_ITEM_DEFS, ItemBoxField } from './Items.js';
import { Boss, loadMonsterModel, instantiateMonsterModel } from './Boss.js';
import { SkillFx } from './SkillFx.js';
import { BoatWeapons } from './BoatWeapons.js';
import { makeSlashArcTexture } from './Textures.js';
import { waveHeight } from '../utils/waves.js';
import { audio, bossSkillSfx, itemSfxName } from '../audio/AudioEngine.js';
import {
  BOSSES, BOSS_LEVELS, BOSS_MINIONS, BOSS_ITEM_BEHAVIOR,
  ARENA_ITEM_SPOTS, BOSS_REVIVES, PLAYER_MAX_HP, PLAYER_RESCUE_WINDOW,
  PLAYER_INVULN_TIME, BOSS_HIT_KNOCKBACK, BOSS_HIT_STUN, BOSS_RAM_BASE,
  BOSS_RAM_NITRO_MULT, MAX_ACTIVE_MINIONS, MINION_WAVE_INTERVAL,
  MINION_DROP_BOX_MIN, getBossDifficulty, gradeStage,
  BOSS_LANE, BOSS_PHASE2_RATIO, BOSS_TRAP_ITEMS, BOSS_THUNDER, BOSS_HEAL_PACK,
  BOSS_VORTEX_CHASE, BOSS_FIRE_CORE, BOSS_FIRE_CORE_SPIKES, BOSS_PACE, BOSS_SKILLS,
  BOSS_SAFE_RING, BOSS_CORE_WAVE, BOSS_PORTAL, BOSS_STAGGER,
  BOSS_CHARGE, BOSS_BLOOD_ALTAR, BOSS_PRESSURE, BOSS_CLOSE_PUNISH } from '../data/bosses.js';
import { getBossTheme } from '../data/bossThemes.js';
import { getWeather } from '../data/maps.js';
import {
  buildRunPlan, mergeMods, combineMods, makeRng, pickWeightedCard,
  HEX_CORES, HEX_RULES, HEX_HAZARDS, HEX_EVENTS, HEX_CARDS,
} from '../data/hexRun.js';

// BOSS 开场运镜整体放慢 1.45 倍：原版 5.6s 里有一段 70m 的俯冲，
// 对晕 3D 的玩家太冲。每段再套 smoothstep，起停不顿挫。
const BOSS_INTRO_TIME_SCALE = 1.45;

const minionModelCache = new Map();
function loadMinionModel(url) {
  if (!minionModelCache.has(url)) {
    minionModelCache.set(url, loadMonsterModel(url));
  }
  return minionModelCache.get(url);
}
// 调试句柄：动画合并是静默的，缺一集只表现为"怪不播攻击/施法"。
// 无头验收里直接拿它把某个 GLB 的 clip 列出来，不用进关等召唤。
if (typeof window !== 'undefined') window.__loadMonsterModel = loadMonsterModel;

const ITEM_IDS = Object.keys(BOSS_ITEM_DEFS);
// 怪物模式的船速倍率：赛道极速（28~36 m/s）在 92m 竞技场里几乎一眨眼就穿过，
// 整体降速才能看清弹道、靠走位躲技能（艇型数值不动，竞速模式不受影响）。
const BOSS_SPEED_SCALE = 0.6;
// 相机水平朝向缓存（每帧算世界方向，避免反复 new）
const CAM_FWD = new THREE.Vector3();
// 召唤小怪头顶血条的画布尺寸；Vec3 用于每帧算相机距离，复用避免 GC
const MINION_BAR_W = 256;
const MINION_BAR_H = 48;
const MINION_BAR_V = new THREE.Vector3();

/** 圆角矩形路径：用 arcTo 手搓，不用较新的 ctx.roundRect，老浏览器也能画出来 */
function roundedRectPath(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 玩家道具的弹道外观：所有攻击/控制类道具都从船头射出，命中 BOSS 才结算，
// 不再“隔着半个场地凭空贴在 BOSS 身上炸”。
// 道具弹道外观：**全部走 effekseer**（飞行体本身就是一段特效，跟着坐标走）。
// 以前每个弹道都是"小球 + 2.1 倍白色光晕球壳 + 手搓拖尾线"，
// 那一层白圈就是玩家说"丑"的东西，已经整段删掉。
const ITEM_SHOTS = {
  bomb: { fx: 'toonWater', speed: 46 },
  mine: { fx: 'mine', speed: 40 },
  missile: { fx: 'missile', speed: 62 },
  fish: { fx: 'ribbonTail', speed: 48 },
  vortex: { fx: 'bubble', speed: 38 },
  ink: { fx: 'ink', speed: 40 },
  decoy: { fx: 'decoy', speed: 42 },
  tide: { fx: 'tide', speed: 40 },
  bubble: { fx: 'pudding', speed: 42 },
  weakspot: { fx: 'itemBeam', speed: 58 },
  // 2026-11-13 新增（rvortex / octopus / magnet 已从 BOSS 池摘除，对应条目一并删掉）
  harpoon: { fx: 'fxHarpoonFly', speed: 72 },
  barrage: { fx: 'toonWater', speed: 44 },
  thunderrod: { fx: 'fxThunderFly', speed: 66 },
};
const DEFAULT_SHOT = { fx: 'itemBeam', speed: 46 };
// 持续判定的节奏：喷火/横扫/冲锋不再是"判定帧那一下"，而是在 0.95 秒的喷射窗口里
// 每 0.15 秒横扫一次，同一个玩家 0.45 秒内最多吃一次（每跳 = 原伤害 × 60%）。
// 这样"火焰明明扫到身上却没掉血"就不会再出现。
const SKILL_DPS_WINDOW = 0.95;
const SKILL_DPS_INTERVAL = 0.15;
const SKILL_DPS_TICK = 0.6;
const SKILL_HIT_CD = 0.45;
// 赛艇不准穿过 BOSS：以 BOSS 为圆心至少留 6m（约等于船头到 BOSS 身前 5~6m）
const BOSS_BODY_KEEP = 6;
// 技能命中船身时的爆点颜色（按元素区分，喷火是橙、冰是浅蓝、雷是冷白、水是青）
const SKILL_HIT_COLOR = {
  fire: 0xff8a3a, ice: 0x9fe8ff, thunder: 0xbfd4ff, water: 0x74d7ff, blood: 0xff3a5c,
};
// 伤害来源标签：阵亡界面 / 结算的承伤排名靠它回答“我到底是被什么打死的”
const SKILL_SRC_ICON = {
  fire: '🔥', ice: '❄', thunder: '⚡', water: '🌊', blood: '🩸',
};
function skillSource(skill) {
  if (!skill) return '未知来源';
  return `${SKILL_SRC_ICON[skill.visual] || '👹'} ${skill.name || skill.id || 'BOSS 技能'}`;
}
// 受击抖动的时长（秒）：和 Boat 里的衰减共用同一个基准
const HIT_SHAKE_TIME = 0.34;
// 场地落区参数（熔岩柱 + 海克斯新增的落石/毒雾/尖刺共用一套更新循环）。
// dot = 秒/跳，有 dot 的落区在存续期间反复伤害；否则只在生效瞬间结算一次。
// 只有熔岩柱保留手搓柱体（原本就有）；新增危险物的预警之外全部走 Effekseer。
const HAZARD_ZONE = {
  lava: { r: 4.4, warn: 1.15, life: 1.05, dmg: 26, source: '🌋 熔岩柱', ring: 0xff5a1e },
  // 落石要等石头砸到水面（0.35s）才算命中，尖刺同理等它出水
  rockfall: { r: 4.2, warn: 1.05, life: 1.1, hitDelay: 0.35, dmg: 24, source: '🪨 落石', ring: 0xff3b2a },
  poison: { r: 6.2, warn: 0.9, life: 5.4, dmg: 9, dot: 0.9, source: '☠ 毒雾', ring: 0xff3b2a },
  spike: { r: 3.4, warn: 0.85, life: 1.5, hitDelay: 0.25, dmg: 30, source: '🔺 尖刺', ring: 0xff3b2a },
  // 第四批：陨石雨 —— 落点更少、圈更大、伤害更高，表现仍用 Effekseer 陨石
  meteor: { r: 5.0, warn: 1.3, life: 1.1, hitDelay: 0.45, dmg: 34, source: '☄ 陨石', ring: 0xff3b2a },
};

/**
 * 赛艇的椭圆支撑半径（与 Game.js 的 boatCollisionRadius 同一套算法）。
 * 技能判定必须算上船体本身，否则"火焰烧到船头、船心还在圈外"就会漏判。
 */
function boatHullRadius(def, heading = 0, nx = 1, nz = 0) {
  const length = Math.max(2.5, def?.hull?.length || 4.5) * 0.46;
  const width = Math.max(1.2, def?.hull?.width || 1.8) * 0.55;
  const forward = nx * Math.sin(heading) + nz * Math.cos(heading);
  const lateral = nx * Math.cos(heading) - nz * Math.sin(heading);
  return Math.hypot(length * forward, width * lateral) + 0.12;
}

/** 船与船之间“物理接触”的判定距离：两艘船支撑半径之和 */
function boatContactDistance(a, b) {
  const dx = a.pos.x - b.pos.x;
  const dz = a.pos.z - b.pos.z;
  const d = Math.hypot(dx, dz);
  const nx = d > 0.001 ? dx / d : 1;
  const nz = d > 0.001 ? dz / d : 0;
  return boatHullRadius(a.def, a.heading, nx, nz) + boatHullRadius(b.def, b.heading, -nx, -nz);
}

// 符文六角阵贴图（取自 M_Magic2Holy）：第二关安全圈和过关传送门共用一份，
// 只解码一次。共享纹理不跟着单个 mesh 销毁。
let runeTexShared = null;
function runeTexture() {
  if (!runeTexShared) {
    runeTexShared = new THREE.TextureLoader().load('/effects/M_Magic2Holy/circle4.png.png');
    runeTexShared.colorSpace = THREE.SRGBColorSpace;
    runeTexShared.anisotropy = 4;
  }
  return runeTexShared;
}

// 传送门门面贴图：紫色旋涡（径向渐变 + 四条旋臂 + 亮环）。
// P2_CosmicMist 单独拿出来在这个机位太淡，读不出“门”，所以门面用程序化贴图，
// 特效只负责门周围的雾气和粒子。
function makePortalSwirlTexture(warm = false) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  const c = size / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  if (warm) {
    // 火门配色：中心亮橙 → 深红 → 透明（第二关召唤门）
    grad.addColorStop(0, 'rgba(255,214,140,1)');
    grad.addColorStop(0.3, 'rgba(255,138,52,0.85)');
    grad.addColorStop(0.68, 'rgba(180,58,18,0.48)');
    grad.addColorStop(0.92, 'rgba(110,26,6,0.2)');
    grad.addColorStop(1, 'rgba(80,14,4,0)');
  } else {
    grad.addColorStop(0, 'rgba(150,90,255,1)');
    grad.addColorStop(0.3, 'rgba(112,60,225,0.82)');
    grad.addColorStop(0.68, 'rgba(74,32,160,0.45)');
    grad.addColorStop(0.92, 'rgba(48,16,105,0.18)');
    grad.addColorStop(1, 'rgba(40,10,80,0)');
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  // 旋臂：一条螺旋线画四份，绕中心错开 90°
  g.strokeStyle = warm ? 'rgba(255,222,168,0.42)' : 'rgba(205,170,255,0.4)';
  g.lineWidth = 16;
  g.lineCap = 'round';
  for (let arm = 0; arm < 4; arm++) {
    g.beginPath();
    for (let t = 0; t <= 1.001; t += 0.02) {
      const ang = (arm * Math.PI) / 2 + t * Math.PI * 2;
      const r = 10 + t * c * 0.9;
      const px = c + Math.cos(ang) * r;
      const py = c + Math.sin(ang) * r;
      if (t === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
  }
  g.beginPath();
  g.arc(c, c, c * 0.93, 0, Math.PI * 2);
  g.strokeStyle = warm ? 'rgba(255,232,190,0.78)' : 'rgba(222,190,255,0.75)';
  g.lineWidth = 12;
  g.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// 召唤门共用一份暖色旋涡贴图，避免每道门都重新画一张 512×512 画布
let gateTexShared = null;
function gateTexture() {
  if (!gateTexShared) gateTexShared = makePortalSwirlTexture(true);
  return gateTexShared;
}

/**
 * 打 BOSS 的方向映射：把键盘输入换算成“屏幕方向”。
 * 屏幕上 = 冲向怪物，下 = 后退，左/右 = 绕怪物横移。
 * (fx, fz) 是 BOSS → 船的 XZ 单位方向（也就是“画面下”的方向）。
 * 屏幕上 = -f，屏幕右 = (fz, -fx)，屏幕左 = (-fz, fx)。
 * 返回世界方向单位向量与推进强度。
 */
export function bossDriveVector(throttle, steer, fx, fz) {
  // throttle>0 冲向 BOSS（-f）；steer>0 是 A 键 = 屏幕左
  const mx = -fx * throttle - fz * steer;
  const mz = -fz * throttle + fx * steer;
  const len = Math.hypot(mx, mz);
  if (len < 1e-4) return { x: 0, z: 0, mag: 0 };
  return { x: mx / len, z: mz / len, mag: Math.min(1, len) };
}

// 怪物模式总控：关卡流程、玩家血量、道具、小怪、结算。
export class BossMode {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {object} opts.fx Effects
   * @param {object} opts.net NetClient
   * @param {Function} opts.onToast
   * @param {Function} opts.onWeather (weatherId) => void
   * @param {Function} opts.onCutscene ({ stage, level, boss }) => void
   * @param {Function} opts.onCutsceneEnd
   * @param {Function} opts.onStageResult (data) => void
   * @param {Function} opts.onVictory (data) => void
   * @param {Function} opts.onDefeat (data) => void
   */
  constructor(opts) {
    this.scene = opts.scene;
    this.fx = opts.fx;
    this.net = opts.net;
    this.myId = opts.myId;
    this.isHost = opts.isHost || opts.solo;
    this.solo = opts.solo;
    this.order = opts.order;
    this.boats = opts.boats;
    this.localBoat = opts.localBoat;
    this.input = opts.input;
    this.arena = opts.arena;
    this.difficulty = getBossDifficulty(opts.difficulty);
    // 怪物模式的两个分支：classic = 现有闯关；hex = 海克斯（随机招式 + 随机计划）。
    this.variant = opts.variant === 'hex' ? 'hex' : 'classic';
    this.opts = opts;

    // ---------- 海克斯：本局随机计划 ----------
    // 房主生成 seed 与计划；客机只等 seed，再用同一个纯函数复现，
    // 两台机器永远得到同一套 BOSS 顺序/规则/危险物。
    this.hexPlan = null;
    this.hexWaiting = this.variant === 'hex' && !this.isHost;
    this.hexWaitT = 0;
    this.hexSyncT = 0;
    this.hexNeedSync = 0;
    this.hexEntry = null;
    this.hexMods = mergeMods([], []);
    this.hexCoreId = null;
    this.hexCore = null;
    this.hexCorePicked = false;
    this.hexCoreTimer = 0;
    this.hexCoreOptions = null;
    this.hexCardOffer = null;
    this.hexCardTimer = 0;
    this.hexCardsPicked = [];
    this.hexBuffs = new Map();
    this.hexEvents = [];
    this.hexEventT = 0;
    this.hexBerserkT = 0;
    this.hexBerserkBase = null;
    this.hexOfferStage = 0;
    // HUD 构筑快照缓存（stage/核心/卡牌/词缀变化时才重建）
    this.hexBuildCache = null;
    // 无尽层数成长倍率（第 5 层起 >1）
    this.endlessHpMul = 1;
    this.endlessDmgMul = 1;
    // 无尽面板正在等通关卡牌选完（避免替玩家选卡）
    this.endlessPending = false;

    this.players = new Map();
    this.myItems = [null, null, null];
    this.minions = [];
    this.itemBoxes = [];
    this.boxField = null;
    this.damageByPlayer = new Map();
    this.stageResults = [];
    this.totalDamage = 0;
    this.phase = 'intro';
    this.stage = 1;
    this.introT = 0;
    this.introLen = 5.6 * BOSS_INTRO_TIME_SCALE;
    this.countdown = 3.999;
    this.clearT = 0;
    this.syncTimer = 0;
    this.lastSummonAt = -999;
    this.stageClearGrade = null;
    this.stageElapsed = 0;
    this.bossStatus = {
      slow: 0, blind: 0, root: 0, confuse: 0,
      silence: 0, reverse: 0, vulnerable: 0, confuseCast: 0, dive: 0,
    };
    this.projectiles = [];
    this.bursts = [];
    // 小怪挥砍光弧（加色贴片，命中的那一瞬在身前立一片新月形爪痕）
    this.arcs = [];
    this.slashTex = null;
    // Effekseer 弹道用的自增键（playAttached 靠 key 停旧的）
    this.projSeq = 0;
    // 本机受击时叠在屏幕边缘的短促红闪（低血常驻由 HUD 自己算）
    this.hurtFlash = 0;
    this.shake = 0;
    // 震屏强度倍率（设置里的「镜头震动」由 Game 写进来）
    this.shakeScale = 1;
    this.hitStop = 0;
    this.camera = null;
    this.dmgLayer = null;
    this.skillFx = new SkillFx(opts.scene);
    this.lane = null;
    this.freeMove = true;
    this.phase2Done = false;
    // 每关个性化玩法（第三十八轮）：棋盘雷 / 旋转激光 / 召唤门 / 裂隙喷发
    this.gridThunder = null;
    this.laserSweep = null;
    this.gateQueue = [];
    this.gateVisuals = [];
    // 难度递增：每 60 秒一层，pressureSteps 记录已叠层数
    this.pressureSteps = 0;
    this.summonIntervalScale = 1;
    // 近身反制：每艘船的独立冷却
    this.closeCd = new Map();
    this.halfDone = false;
    this.traps = [];
    // 第四关专属技能状态
    this.pull = null;          // 吸取：{skill,info,t,duration,hitCd}
    this.geyserWave = null;    // 水柱扩散浪：{skill,x,z,t,radius,hit:Set}
    this.lavaWave = null;      // 熔岩海啸：{skill,x,z,heading,traveled,nextRow,hit:Set}
    this.shadowZone = null;    // 暗影缠触：{skill,x,z,t,duration,nextTick,nextVisual}
    this.geyserFx = null;      // 扩散浪的视觉对象（和判定半径同源）
    this.geyserWarnRings = []; // 裂海泉涌：一圈圈向外亮起的红色地面预警
    this.safePillar = null;    // 全屏大招的「安全柱」
    // 持续伤害窗口（喷吐/横扫/冲锋）
    this.hazards = [];
    // 延迟结算：跳劈落地后的余波（0.5 秒后才扫第二圈），
    // 和 hazards 分开是因为它必须“一次性”触发，不参与逐帧命中冷却
    this.delayedHits = [];
    // 龙鳞骤雨的多落点共享一份「同一招内冷却」：避免一轮骤雨在一个点上瞬间叠满伤害
    this.rainHitCd = new Map();
    // 周期性落雷（第 2 关起）：独立计时器 + 当前预警
    this.thunderT = 0;
    this.thunderWarn = null;
    // 追踪漩涡（第 1 关专属）：host 计时器 + 当前龙卷实体
    this.vortexT = 0;
    this.vortex = null;
    // 随机血包
    this.healPacks = [];
    this.healSpawnT = BOSS_HEAL_PACK.first;   // 距离下一次刷新还有多久（只有主机会走）
    // 火力核心（J 键强化道具）：场上最多一枚，计时刷新；overloadT 是本机的强化剩余时间
    this.fireCores = [];
    this.fireCoreT = 0;
    this.overloadT = 0;
    // 第二关专属：符文安全圈（半径随时间收缩）＋四枚能量核心波次
    this.safeRing = null;      // 有值时表示本关启用收缩火圈
    this.safeRingTick = 0;     // 圈外伤害结算计时
    this.safeRingMesh = null;  // 平铺水面的符文六角阵（贴 M_Magic2Holy 的贴图）
    // 第三关专属：电荷互斥（两船靠太近互相放电）
    this.chargePairs = new Map(); // "a|b" -> { hold: 蓄电秒数, cd: 冷却剩余 }
    this.chargeLine = null;       // 水面上那条折线电弧（纯表现，惰性创建）
    this.chargeToastT = 0;        // 放电提示的限流计时
    // 第四关专属：血祭祭坛
    this.bloodAltar = null;       // { x, z, t, life, prog, done, group, ... }
    this.bloodAltarT = 0;         // 下一座祭坛的刷新倒计时
    this.bloodAltarFxT = 0;       // 引导期间血雾的喷洒间隔
    // 过关传送门（第一~三关）：BOSS 死亡演出后升起，全员进入才切下一关
    this.portal = null;        // { x, z, r, t, doneT, ready:Set, ... }
    this.portalMesh = null;    // 地面符文阵 + 门楣浮字
    this.portalSyncT = 0;      // 主机定期重发门坐标，兜住客机漏消息/切后台
    this.coreWave = null;      // { cores:[{i,x,z,hp,max}], left }
    this.coreWaveT = 0;        // 下一轮核心升起的倒计时
    this.weakT = 0;            // 弱点窗口剩余秒数（>0 时 BOSS 受伤 ×weaknessMul）
    // 第一关的熔岩喷发柱：警告圈 → 喷发伤害
    this.lavaZones = [];
    this.lavaTimer = 0;
    this.lavaHazard = false;
    // 海克斯新增危险物的落区种类（rockfall/poison/spike），与熔岩共用 #updateLavaZones
    this.hexHazardKinds = [];
    // 「熔岩地形」事件期间强制只落熔岩柱，避免和落石/毒雾混着出
    this.hexForceLava = 0;
    this.ramCooldown = new Map();
    // 冲角护符（ramcrest）的限时撞船增益；null = 没生效
    this.ramBuff = null;
    // 主炮 / 仇恨 / 双人协同 / 救援
    this.weapons = this.#makeWeapons(this.myId);
    // AI 陪练各自的主炮（只在本机权威模拟时更新）
    this.aiWeapons = new Map();
    this.aggro = new Map();
    this.comboCharge = 0;
    this.comboReady = false;
    this.comboCd = 0;
    this.comboHeld = false;
    // 真·双人合击：双方要在 1.2s 内都按下 F，联机时用 arm 消息握手
    this.comboArmed = false;   // 自己已经预备（按下 F 等队友）
    this.comboArmT = 0;        // 预备窗口剩余时间
    this.comboPeers = new Map(); // 队友 id -> { charge, t }（联机同步过来的协同进度）
    this.comboMateId = null;   // 当前最近的队友，HUD 用
    this.comboSyncT = 0;       // 自己进度上报的节流计时
    this.comboAiArmT = 0;      // 单人陪练：AI 假装“跟着按”的延迟
    this.comboAiMate = null;
    this.rescues = [];
    this.whirlAcc = 0;
    this.#buildItemBoxes();
    this.#buildHealPacks();
    this.#bindInput();
    // 单人练习可以直接选关进场；联机模式 startMsg 没有 stage，仍从第一关开始
    if (this.variant === 'hex' && this.isHost) {
      // 房主掷 seed：整局只掷这一次，之后所有端按 seed 复现同一套计划
      this.hexPlan = buildRunPlan((Math.random() * 0xffffffff) >>> 0);
      this.hexNeedSync = 6;
    }
    // 客机在拿到房主 seed 之前不起关，否则会先用错误的 BOSS 演一遍过场再被纠正
    if (!this.hexWaiting) this.startStage(opts.stage || 1);
  }

  /**
   * 造一套主炮。玩家和 AI 陪练共用同一套回调，只有“伤害记在谁头上”不同，
   * 否则 AI 打出来的伤害会全算到玩家身上，测试时看不出配合效果。
   */
  #makeWeapons(ownerId) {
    return new BoatWeapons(this.scene, {
      fx: this.fx,
      getBoss: () => this.boss,
      getObstacles: () => this.arena?.rocks || [],
      // 炮弹/激光也能打小怪：弹道和射线都会参与判定
      getMinions: () => this.minions,
      onMinionHit: (m, dmg) => this.#damageMinion(m, dmg),
      onHit: (dmg, x, z, def, extra) => this.#applyWeaponHit(dmg, x, z, def, { ...extra, owner: ownerId }),
      onImpact: (x, y, z) => {
        this.#spawnBurst(x, y, z, 0xffd28a, 0.55);
      },
      onOverheat: ownerId === this.myId
        ? () => this.opts.onToast?.('🔥 炮管过热，冷却中…')
        : null,
      // 炮塔自动修正收窄到 ~35°：以前 ±100° 等于“船往哪开都不影响命中”，
      // 现在是“先摆正船头再开火”，走位和瞄准才有取舍。
      turretYaw: 0.6,
      // BOSS 场地几十米宽，主炮弹丸按原体积在追尾视角里几乎看不见：
      // 放大 + 拖出飞行轨迹（竞技场是人对人、距离近，保持原样）。
      bigShotFx: true,
    });
  }

  // ---------- 关卡流程 ----------
  startStage(stage, { broadcast = false } = {}) {
    audio.play('transition', { gap: 400 });
    // 海克斯无尽：层数超过当前计划长度时，按同一 seed 把计划延长（两端结果一致）
    if (this.variant === 'hex' && this.hexPlan && stage > this.hexPlan.stages.length) {
      this.hexPlan = buildRunPlan(this.hexPlan.seed, stage);
    }
    const maxStage = this.variant === 'hex' && this.hexPlan
      ? this.hexPlan.stages.length
      : BOSS_LEVELS.length;
    this.stage = Math.max(1, Math.min(maxStage, stage));
    // 无尽层数超过 4 后没有对应的关卡配置，按 4 关循环取（只用于名字/兜底 BOSS）
    this.level = BOSS_LEVELS[(this.stage - 1) % BOSS_LEVELS.length];
    // 无尽成长：第 5 层起血量 ×1.35/层、伤害 ×1.18/层（PRD P4）
    const endlessStep = this.variant === 'hex' ? Math.max(0, this.stage - BOSS_LEVELS.length) : 0;
    this.endlessHpMul = Math.pow(1.35, endlessStep);
    this.endlessDmgMul = Math.pow(1.18, endlessStep);
    this.opts.onHexEndless?.(null);
    // 海克斯：BOSS 由本局计划决定，关卡槽位只负责推进顺序与场景天气
    this.hexEntry = (this.variant === 'hex' && this.hexPlan)
      ? this.hexPlan.stages[this.stage - 1]
      : null;
    this.bossDef = BOSSES[this.hexEntry?.bossId] || BOSSES[this.level.boss];
    this.#prepareHexStage();
    // 海克斯：场景主题与天气各自随机（天气独立于主题，允许违和组合）；
    // classic 仍按 BOSS 原本关卡的主题天气。
    this.opts.onWeather?.(this.hexWeather.id, this.hexThemeStage);
    // 海克斯：掩体/浮岩布局按 seed 随机旋转 + 镜像（房主客机同一 seed，无需同步）
    if (this.hexEntry && this.hexPlan) {
      this.arena?.setRockVariant?.(this.hexPlan.seed ^ Math.imul(this.stage, 0x27d4eb2d));
    }
    // 第一关是单挑关：靠熔岩柱制造走位压力，不召唤小怪
    // 海克斯抽到「熔岩雨」时，任何 BOSS 都会追加熔岩柱
    this.lavaHazard = !!this.bossDef.lavaHazard || this.#hexHas('lava');
    // 第三批新增危险物（落石/毒雾/尖刺）复用同一套落区系统，kind 决定外观与节奏
    this.hexHazardKinds = HEX_HAZARDS
      .filter((h) => h.kind && this.#hexHas(h.id))
      .map((h) => h.kind);
    this.lavaTimer = (this.lavaHazard || this.hexHazardKinds.length) ? 3.5 : 0;
    this.#clearLavaZones();
    this.#clearBoss();
    this.#clearMinions();
    this.#resetPlayers();
    this.#resetItemBoxes();
    this.myItems = [null, null, null];
    // 海克斯：核心/规则带来的开局增益（回血、额外复活、开局道具）要在重置之后写
    this.#applyHexStagePlayers();
    this.phase = 'intro';
    this.introT = 0;
    this.countdown = 3.999;
    this.clearT = 0;
    this.stageElapsed = 0;
    this.stageClearGrade = null;
    this.damageByPlayer = new Map();
    this.totalDamage = 0;
    this.#clearProjectiles();
    this.#clearBursts();
    this.#clearArcs();
    this.#clearTraps();
    this.hazards.length = 0;
    this.delayedHits.length = 0;
    this.pull = null;
    this.geyserWave = null;
    this.geyserFx = null;
    this.#clearGeyserWarn();
    this.lavaWave = null;
    this.#endShadowZone();
    this.#clearSafePillar();
    this.#clearThunder();
    this.#clearVortex();
    this.#resetHealPacks();
    this.#resetFireCores();
    this.#resetCoreWave();
    this.#resetChargeLink();
    this.#resetBloodAltar();
    this.#closePortal();
    // 每关个性化玩法 / 难度递增的状态
    this.#clearGridThunder();
    this.#clearLaserSweep();
    this.#clearGateVisuals();
    this.gateQueue.length = 0;
    this.pressureSteps = 0;
    this.summonIntervalScale = 1;
    this.closeCd.clear();
    this.halfDone = false;
    this.ramBuff = null;
    this.thunderT = this.#thunderInterval();
    this.vortexT = BOSS_VORTEX_CHASE.firstDelay;
    this.skillFx.clear();
    this.weapons.clear();
    this.aggro.clear();
    this.comboCharge = 0;
    this.comboReady = false;
    this.comboCd = 0;
    this.comboHeld = false;
    this.comboArmed = false;
    this.comboArmT = 0;
    this.comboPeers.clear();
    this.comboMateId = null;
    this.comboSyncT = 0;
    this.comboAiArmT = 0;
    this.comboAiMate = null;
    this.rescues.length = 0;
    this.lane = null;
    // 开打即全屏自由走位：不再把玩家锁在离 BOSS 14~52m 的环里，
    // 贴脸、撞击、绕背打弱点从第一阶段就可用；血量 1/3 仍触发狂怒与阶段大招。
    this.freeMove = true;
    this.phase2Done = false;
    this.shake = 0;
    this.hitStop = 0;
    // 连招播报：每组连招每关只提示一次，避免同一套重复刷屏
    const comboSeen = new Set();
    this.boss = new Boss(this.scene, this.bossDef, {
      hp: this.bossDef.hp * this.difficulty.hpScale * this.hexMods.bossHpMul * this.endlessHpMul,
      variant: this.variant,
      // 海克斯：本关技能子集（计划里抽好的 5 个，房主客机一致）
      skills: this.hexEntry?.skills,
      // 海克斯：本关 1~2 组连招（同 seed 两端一致）
      combos: this.hexEntry?.combos,
      onCombo: (_combo, a, b) => {
        const key = `${a.id}>${b.id}`;
        if (comboSeen.has(key)) return;
        comboSeen.add(key);
        this.opts.onToast?.(`⚔ BOSS 连招：${a.name} → ${b.name}`);
      },
      fx: this.fx,
      net: this.net,
      isHost: this.isHost,
      arenaRadius: this.arena.radius,
      getPlayers: () => [...this.players.values()].map((p) => ({
        id: p.id, boat: p.boat, alive: p.alive, hp: p.hp,
      })),
      onReady: () => {},
      onDeath: () => this.#onBossDeath(),
      onSkillResolve: (skill, info) => this.#resolveSkill(skill, info),
      onPhaseChange: (skill) => this.#onPhaseChange(skill),
      onSkillVisual: (skill, info, when) => this.#playSkillVisual(skill, info, when),
      getAggroId: () => this.#topAggro(),
    });
    // 血月：纯数值危险物，直接放大 BOSS 伤害（不产生落区）；无尽层数再乘一层成长
    this.boss.damageScale = this.difficulty.dmgScale * this.hexMods.bossDmgMul
      * (this.#hexHas('bloodmoon') ? 1.2 : 1) * this.endlessDmgMul;
    this.bossBaseDamage = this.boss.damageScale;
    // 关卡节奏：第三关整体放慢，第四关红圈预警大幅压缩（Boss 的 telegraph/冷却都按此缩放）
    // 海克斯里 BOSS 可能不在自己原本的槽位，节奏/机制统一按它原本的关卡取
    const pace = BOSS_PACE[this.ruleStage] || {};
    this.boss.pace = pace;
    this.boss.telegraphScale = pace.telegraphScale || 1;
    this.boss.cooldownScale = this.difficulty.cdScale * (pace.cooldownScale || 1) * this.hexMods.bossCdMul;
    // 关卡基础移速单独存一份：减速道具每帧会把 speedScale 改成 0.4/1，
    // 直接用 speedScale 当基准会被每帧覆盖掉（第三关 0.85 会失效）。
    this.bossBaseSpeed = (pace.speedScale || 1) * this.hexMods.bossSpeedMul;
    this.boss.speedScale = this.bossBaseSpeed;
    this.summonWaves = (this.bossDef.summon || []).map((wave, i) => ({
      ...wave, index: i, fired: false,
    }));
    const theme = getBossTheme(this.hexThemeStage);
    const themeWeather = this.hexWeather;
    // 海克斯：主题与天气各自随机，过场标签同时给出两者；classic 只显示主题名
    const weatherLabel = this.hexEntry
      ? `${theme.icon || ''} ${theme.name || ''} · ${themeWeather.icon || ''} ${themeWeather.name || ''}`.trim()
      : `${themeWeather.icon || ''} ${themeWeather.name || ''}`.trim();
    this.opts.onCutscene?.({
      stage: this.stage,
      total: this.variant === 'hex' ? this.runStageCount : BOSS_LEVELS.length,
      // 海克斯按「层」计数：无尽续层后“第 5 关 / 4”会很难看
      layer: this.variant === 'hex',
      level: this.level,
      boss: this.bossDef,
      weatherLabel,
      // 海克斯附加信息：过场卡上展示核心、规则、危险物与 seed
      hex: this.variant === 'hex' && this.hexPlan ? {
        seed: this.hexPlan.seed,
        coreId: this.hexCoreId,
        corePicked: this.hexCorePicked,
        entry: this.hexEntry,
        // 本局随机赛艇：过场卡直接展示，省得玩家进关后忘了自己开的什么船
        boats: (this.order || []).filter((e) => !e.ai).map((e) => ({
          name: e.name, boatId: e.boatId, me: e.id === this.myId,
        })),
      } : null,
    });
    this.opts.onStageResult?.(null);
    // 第一关开场同时弹出「本局核心」三选一（房主选，客机只展示）
    if (this.stage === 1) this.#offerHexCore();
    if (broadcast && this.isHost) {
      this.net?.send({
        t: 'bossStage',
        stage: this.stage,
        // 海克斯：把当前计划层数一起下发，客机续层时按同一长度复现
        ...(this.variant === 'hex' ? { hexSeed: this.hexPlan?.seed, hexStages: this.runStageCount } : {}),
      });
    }
  }

  /** 本局计划的总层数：海克斯会被无尽续层延长；classic 固定 4 关 */
  get runStageCount() {
    return this.variant === 'hex' && this.hexPlan ? this.hexPlan.stages.length : BOSS_LEVELS.length;
  }

  get locked() {
    return this.phase === 'intro' || this.phase === 'countdown' || this.phase === 'clear'
      || this.phase === 'endless' || this.phase === 'victory' || this.phase === 'defeat';
  }

  /** 海克斯里 BOSS 可能换槽位：节奏与专属机制按它原本的关卡算，不计当前槽位 */
  get ruleStage() {
    return this.hexEntry?.originStage || this.stage;
  }

  /** 海克斯随机化的场景主题（1~4 关的美术布景）；classic 用自己的槽位 */
  get hexThemeStage() {
    return this.hexEntry?.themeStage || this.stage;
  }

  /** 本关实际天气：海克斯按计划独立抽取，classic 用主题自带天气 */
  get hexWeather() {
    return this.hexEntry?.weather
      ? getWeather(this.hexEntry.weather)
      : getBossTheme(this.hexThemeStage).weather;
  }

  /** 正式开打：以「BOSS → 玩家」为轴向建立固定通道，第一阶段 BOSS 站在原地 */
  #beginFight() {
    const boat = this.localBoat;
    if (!boat || !this.boss) return;
    const dx = boat.pos.x - this.boss.pos.x;
    const dz = boat.pos.z - this.boss.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    this.lane = { fx: dx / len, fz: dz / len, side: 0, fwd: len };
    this.freeMove = true;
    // 第一、二关第一阶段站桩；第三、四关（pace.move）从开打就整体追击赛艇
    if (this.boss) this.boss.anchor = !this.boss.pace?.move;
    this.weapons.setBoat(boat.def);
    this.constrainBoat(boat);
    audio.play('boss_roar');
    this.opts.onToast?.('💥 J 开火 · F 协同合击（队友靠近攒协同）· 绕背打弱点');
  }

  /** 血量掉到最后 1/3：BOSS 进入狂怒（全程自由走位，这里只做加压） */
  #checkPhase() {
    if (!this.boss || this.boss.dead) return;
    // 半血节点：只做演出升级（金色圣光柱 + 法阵 + 震屏），数值不变，
    // 让每一关都有一次“BOSS 变招了”的重音，而不是只有最后 1/3 才突然变脸
    if (!this.halfDone && this.boss.hpRatio <= 0.5) {
      this.halfDone = true;
      this.#playPhaseShowcase();
    }
    if (this.phase2Done) return;
    if (this.boss.hpRatio > BOSS_PHASE2_RATIO) return;
    this.phase2Done = true;
    this.boss.anchor = false;
    // 第四关按用户指定的终盘强度：移动速度 ×2、攻击伤害 ×1.5；
    // 前三关沿用原来的 1.35 倍移速。
    const enraged = this.ruleStage === 4;
    this.boss.rageMult = enraged ? 2 : 1.35;
    if (enraged) this.boss.damageScale = (this.bossBaseDamage || 1) * 1.5;
    // 第四关终盘也要留出技能间隙：此前统一压到 0.78 再乘 0.9，
    // 第四关几乎变成无缝连招，这里单独放宽上限。
    const cdCap = enraged ? 0.95 : 0.78;
    this.boss.cooldownScale = Math.min(this.boss.cooldownScale, cdCap) * 0.9;
    // 切换演出：BOSS 咆哮 + 一圈冲击波 + 震屏
    audio.play('transition');
    // 骨骼演出：抬身展翼/举斧咆哮，动作锁 1.4 秒，别被下一轮技能立刻盖掉
    this.boss.playOnce?.('enrage', 1.4);
    this.fx.play('tornado', this.boss.pos.x, 2.2, this.boss.pos.z, 1.8);
    this.skillFx.ringBurst(enraged ? 'blood' : 'fire', {
      x: this.boss.pos.x, z: this.boss.pos.z, radius: 24, count: 72,
    });
    this.#shakeCamera(1.0);
    this.hitStop = Math.max(this.hitStop, 0.07);
    this.opts.onToast?.(enraged
      ? '🩸 最后 1/3 血！血魔移速 ×2、伤害 ×1.5，技能全面加压'
      : '🔥 最后 1/3 血！BOSS 狂怒，技能全面加压');
  }

  /** 半血演出：元素光柱 + 一圈冲击环，纯表现、不改数值 */
  #playPhaseShowcase() {
    const b = this.boss;
    if (!b) return;
    const h = Math.max(2.5, (b.def?.height || 7) * 0.55);
    audio.play('transition', { gap: 260 });
    // 半血变招的骨骼重音：三套骨架各自的 enrage（fd/dk/bd_skills.glb）
    b.playOnce?.('enrage', 1.3);
    // 只用游戏里已经在跑的老素材：P1_Herald / P2_GateOfCalve 这类新增包
    // 在部分显卡上贴图上传会偶发 texImage2D 异常，不值得为一次演出冒风险。
    const theme = b.fxTheme === 'ice' ? 'ice' : (this.ruleStage === 4 ? 'blood' : 'fire');
    // 只用实机验证过、不会触发 texImage2D 异常的素材：
    // fxFireBurst / fxIceBloom 在部分显卡上贴图上传会偶发失败并打断整帧。
    const burst = { fire: 'fxEmberSlash', ice: 'fxMagic1Water', blood: 'fxMagicDark' }[theme] || 'fxEmberSlash';
    this.fx.play(burst, b.pos.x, h, b.pos.z, 2.0);
    this.skillFx.pillar(theme, { x: b.pos.x, z: b.pos.z, radius: 8, height: 26, duration: 1.4 });
    this.skillFx.ringBurst(theme, {
      x: b.pos.x, z: b.pos.z, radius: 20, count: 60, up: 9,
    });
    this.#shakeCamera(0.5);
    this.opts.onToast?.('⚡ 半血！BOSS 开始变招');
  }

  canControl() {
    const me = this.players.get(this.myId);
    // 传送门阶段也要能开船：玩家要自己把船开进门里，不能像结算阶段那样锁舵
    const driveOk = this.phase === 'fight' || this.phase === 'portal';
    return driveOk && !!me?.alive;
  }

  /**
   * 打 BOSS 的操控是“屏幕方向驱动”：按哪个方向，船就往画面上那个方向走。
   * 基准必须用**当前相机的水平朝向**，不能用开战时冻结的战场轴向：
   * 镜头会跟着船绕 BOSS 转，冻结轴一旦错位，按左就会往地图左下走。
   */
  driveBoat(dt, rawInput) {
    const boat = this.localBoat;
    const boss = this.boss;
    if (!boat || !rawInput) return rawInput;
    const idle = { ...rawInput, throttle: 0, steer: 0 };
    // 过场演出和结算阶段交回普通操控；
    // 传送门阶段继续沿用打 BOSS 的屏幕方向驱动，否则会退回“先掉头再加速”的
    // 普通船操控，方向键手感和战斗中完全不一样，很难把船开进门里。
    if (this.phase !== 'fight' && this.phase !== 'portal') return rawInput;
    // 被打晕/沉船/漩涡/泡泡上浮时交给 Boat 自己的失控逻辑
    if (boat.stunTimer > 0 || boat.sinkTimer > 0 || boat.spinTimer > 0 || boat.bubbleLiftTimer > 0) {
      return idle;
    }
    const throttle = rawInput.throttle || 0;
    const steer = rawInput.steer || 0;
    if (Math.abs(throttle) < 0.01 && Math.abs(steer) < 0.01) return idle;

    // 屏幕上方 = 相机水平前方 f；屏幕左 = (fz, -fx)，屏幕右 = (-fz, fx)。
    // Input 的 steer：A/← 为 +1（左），D/→ 为 -1（右），所以横向项要用“左向量”。
    let fx = 0;
    let fz = 1;
    if (this.camera) {
      this.camera.getWorldDirection(CAM_FWD);
      CAM_FWD.y = 0;
      const l = Math.hypot(CAM_FWD.x, CAM_FWD.z);
      if (l > 1e-4) { fx = CAM_FWD.x / l; fz = CAM_FWD.z / l; }
    } else {
      // 相机还没初始化时退化：战斗中朝 BOSS，传送门阶段朝门，避免背对目标开车
      const tgt = this.phase === 'portal' && this.portal ? this.portal : boss;
      if (tgt) {
        const ux = boat.pos.x - tgt.x;
        const uz = boat.pos.z - tgt.z;
        const l = Math.hypot(ux, uz) || 1;
        fx = -ux / l;
        fz = -uz / l;
      }
    }
    const mx = fx * throttle + fz * steer;
    const mz = fz * throttle - fx * steer;
    const mag = Math.min(1, Math.hypot(mx, mz));
    if (mag < 0.001) return idle;
    const nx = mx / Math.hypot(mx, mz);
    const nz = mz / Math.hypot(mx, mz);
    // 直接把“屏幕方向”交给 Boat 当世界速度用，不再让船头慢慢掉头
    // （旧做法先转 heading 再沿 heading 加速，转向期间船会朝旧方向漂，手感像被拖走）
    return {
      ...rawInput,
      throttle: mag,
      steer: 0,
      worldX: nx,
      worldZ: nz,
      worldMag: mag * BOSS_SPEED_SCALE,
      drift: false,
    };
  }

  /**
   * 第一阶段：BOSS 站桩，玩家在它以近 14 米、远 44 米的环形战场里走位。
   * 只钳制“到 BOSS 的距离”，不做左右横向墙——镜头追着船走，
   * 横向再设一道看不见的墙就会变成“还没到画面边缘就被卡住”。
   */
  constrainBoat(boat) {
    if (!boat || !this.boss || this.phase !== 'fight') return;
    const dx = boat.pos.x - this.boss.pos.x;
    const dz = boat.pos.z - this.boss.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return;
    let want = d;
    // 老关卡沿 BOSS 前方走廊跑图时远端仍按 BOSS_LANE 钳制；
    // freeMove（现在的常规情况）只保留“身体那一圈”，不做远近墙。
    if (!this.freeMove && this.lane) {
      want = Math.min(BOSS_LANE.far, Math.max(BOSS_LANE.near, d));
    }
    want = Math.max(want, BOSS_BODY_KEEP);
    if (Math.abs(want - d) < 1e-3) return;
    const nx = dx / d;
    const nz = dz / d;
    boat.pos.x = this.boss.pos.x + nx * want;
    boat.pos.z = this.boss.pos.z + nz * want;
    // 只清掉撞到边界那一个方向的径向速度，切向速度保留（仍可沿边滑行）
    const radial = boat.vel.x * nx + boat.vel.y * nz;
    if ((want > d && radial < 0) || (want < d && radial > 0)) {
      boat.vel.x -= nx * radial;
      boat.vel.y -= nz * radial;
      boat.speed = boat.vel.length();
    }
  }

  #resetPlayers() {
    this.players.clear();
    this.rams = 0;
    this.#clearAiWeapons();
    for (const entry of this.order) {
      const boat = this.boats.get(entry.id);
      if (!boat) continue;
      this.players.set(entry.id, {
        id: entry.id, boat, hp: PLAYER_MAX_HP, revives: BOSS_REVIVES,
        alive: true, invuln: 1.5, respawn: 0, ai: !!entry.ai, rescueT: null,
        // 头像：内置 id 或玩家上传压缩后的 dataURL（AI 用机器人头像）
        avatar: entry.avatar || '',
        // 承伤统计：本关被谁打了多少 / 最后一次挨的打，阵亡界面直接读这几项
        taken: 0, takenBy: new Map(), lastHit: null, deathHit: null,
        // 焚风灼膛：> 0 时按 J 打不出炮弹（护盾/无敌不会挂锁）
        weaponLock: 0,
      });
      // 怪物模式先试"船上漂浮感"的手感改造（竞速/道具维持原样）
      boat.floatMode = 1;
      // AI 陪练：每关重建主炮，弹道/特效沿用同一套回调（伤害归属到 AI 自己）
      if (entry.ai) {
        const w = this.#makeWeapons(entry.id);
        w.setBoat(boat.def);
        this.aiWeapons.set(entry.id, w);
      }
    }
  }

  #clearAiWeapons() {
    for (const w of this.aiWeapons.values()) w.clear();
    this.aiWeapons.clear();
  }

  /**
   * 怪物模式 AI 陪练：绕着 BOSS 走位 + 自动开炮，用来配合玩家测试。
   * 每只 AI 按进场顺序分配不同的绕行半径与方向，避免几只船挤在同一条弧线上；
   * 和玩家一样用世界方向输入（worldX/worldZ），不做“先掉头再加速”。
   */
  driveAi(dt, boat, id) {
    const idle = { throttle: 0, steer: 0, drift: false, nitro: false };
    const p = this.players.get(id);
    // AI 陪练也走传送门：朝着门心开，进到内圈就松油门等其他人
    if (this.phase === 'portal' && this.portal && p?.alive && boat) {
      const dx = this.portal.x - boat.pos.x;
      const dz = this.portal.z - boat.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d <= this.portal.r * 0.55) return idle;
      return {
        ...idle,
        throttle: 1,
        worldX: dx / d,
        worldZ: dz / d,
        worldMag: BOSS_SPEED_SCALE * 0.9,
      };
    }
    const boss = this.boss;
    if (!p || !p.alive || !boat || !boss || boss.dead || this.phase !== 'fight') return idle;
    if (!p.aiOrbit) {
      const idx = Math.max(0, this.order.findIndex((e) => e.id === id));
      p.aiOrbit = {
        radius: 18 + (idx % 3) * 5,
        dir: idx % 2 === 0 ? 1 : -1,
        phase: idx * 0.8,
      };
    }
    p.aiOrbit.phase += dt;
    const dx = boat.pos.x - boss.pos.x;
    const dz = boat.pos.z - boss.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = dx / d;
    const nz = dz / d;
    // 径向：离得太远压上去（-1 指向 BOSS），太近拉开（+1 远离 BOSS）
    const radial = d > p.aiOrbit.radius + 3 ? -1 : (d < p.aiOrbit.radius - 3 ? 1 : 0);
    // 切向：绕 BOSS 转圈，速度随相位起伏，走位看起来像真人而不是匀速绕圈
    const swing = 1 + Math.sin(p.aiOrbit.phase * 1.1) * 0.25;
    const mx = nx * radial - nz * p.aiOrbit.dir * swing;
    const mz = nz * radial + nx * p.aiOrbit.dir * swing;
    const len = Math.hypot(mx, mz);
    if (len < 1e-3) return idle;
    return {
      ...idle,
      throttle: 1,
      worldX: mx / len,
      worldZ: mz / len,
      worldMag: BOSS_SPEED_SCALE * 0.9,
    };
  }

  #clearBoss() {
    this.boss?.dispose();
    this.boss = null;
  }

  // ---------- 逐帧 ----------
  update(dt, t) {
    // 海克斯客机：还没收到房主 seed，先不开关（避免用错误 BOSS 演一遍过场）
    if (this.hexWaiting) {
      this.hexWaitT += dt;
      if (this.hexWaitT > 5) {
        this.hexWaiting = false;
        this.startStage(this.opts.stage || 1);
      }
      return;
    }
    // 海克斯房主：开局 6 秒内重发 seed，兜住晚到/重连的客机
    if (this.variant === 'hex' && this.isHost && this.hexNeedSync > 0) {
      this.hexNeedSync -= dt;
      this.hexSyncT -= dt;
      if (this.hexSyncT <= 0) {
        this.hexSyncT = 0.5;
        this.net?.send({
          t: 'bossStage', stage: this.stage,
          hexSeed: this.hexPlan?.seed, hexStages: this.runStageCount,
        });
      }
    }
    if (!this.boss) return;
    // 受击红闪衰减（过场/结算阶段也衰减，否则进关时残留一层红屏）
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.9);
    this.#updateArcs(dt);
    // 海克斯：核心/卡牌倒计时与事件（过场、战斗、结算阶段都要跑）
    this.#updateHex(dt);
    if (this.phase === 'intro') {
      this.introT += dt;
      this.boss.updateIdle(dt);
      if (this.introT >= this.introLen) {
        this.phase = 'countdown';
        this.countdown = 3.999;
        this.opts.onCutsceneEnd?.();
      }
      return;
    }
    if (this.phase === 'countdown') {
      this.boss.updateIdle(dt);
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'fight';
        this.stageElapsed = 0;
        this.#beginFight();
      }
      return;
    }
    if (this.phase === 'fight') {
      this.stageElapsed += dt;
      this.#checkPhase();
      this.boss.update(dt, t);
      this.#updatePlayers(dt);
      this.#updateStatusTimers(dt);
      this.#updateWeapons(dt);
      this.#updateAiWeapons(dt);
      this.#decayAggro(dt);
      this.#updateCombo(dt, this.players.get(this.myId));
      this.#updateRescues(dt);
      this.#updateWhirlpools(dt);
      this.#updateProjectiles(dt);
      this.#updateBursts(dt);
      this.#updateTraps(dt);
      this.#updateHazards(dt);
      this.#updateDelayedHits(dt);
      this.#updateThunder(dt);
      this.#updateVortexChase(dt);
      this.#updateHealPacks(dt);
      this.skillFx.update(dt, this.camera);
      // 第四关：吸取要跟着船的运动逐帧推，水柱浪的半径由 SkillFx 推进，
      // 这里只负责“波前扫到船”的判定；安全柱纯表现
      this.#updatePull(dt);
      this.#updateGeyserWave(dt);
      this.#updateLavaWave(dt);
      this.#updateShadowZone(dt);
      this.#updateSafePillar(dt);
      this.#updateLavaZones(dt);
      this.#updateMinions(dt);
      this.#updateItemBoxes(dt);
      this.#updateFireCores(dt);
      this.#updateSafeRing(dt);
      this.#updateCoreWave(dt);
      // 第三关：两船贴身互斥放电；第四关：血祭祭坛引导
      this.#updateChargeLink(dt);
      this.#updateBloodAltar(dt);
      // 第三十八轮个性化玩法：棋盘雷 / 旋转激光 / 召唤门队列 / 难度递增 / 近身反制
      this.#updateGridThunder(dt);
      this.#updateLaserSweep(dt);
      this.#updateGateQueue(dt);
      this.#updatePressure();
      this.#updateCloseCounter(dt);
      this.#checkStageEvents();
      if (this.isHost) this.#sendSync(dt);
      return;
    }
    if (this.phase === 'clear') {
      this.boss.update(dt, t);
      this.#updateProjectiles(dt);
      this.#updateBursts(dt);
      this.skillFx.update(dt, this.camera);
      this.#updateItemBoxes(dt);
      this.clearT -= dt;
      // clear / portal 阶段也要继续发 bossState：这两个阶段最长能停十几秒，
      // 期间如果客机切到后台再切回来，没有状态流就永远追不上（也拿不到门的坐标）
      if (this.isHost) this.#sendSync(dt);
      if (this.clearT <= 0) {
        // 第四关直接终局；前三关不再自动跳关，而是升起传送门等全员进入
        if (this.stage >= BOSS_LEVELS.length) this.#advanceStage();
        else this.#openPortal();
      }
      return;
    }
    if (this.phase === 'portal') {
      this.boss?.update(dt, t);
      this.#updateProjectiles(dt);
      this.#updateBursts(dt);
      this.skillFx.update(dt, this.camera);
      this.#updateItemBoxes(dt);
      if (this.isHost) this.#sendSync(dt);
      this.#updatePortal(dt);
      return;
    }
    if (this.phase === 'endless') {
      // 无尽选择阶段：BOSS 已倒下，只让残骸演完；房主继续广播状态，客机才知道何时续层
      this.boss?.update(dt, t);
      this.#updateBursts(dt);
      this.skillFx.update(dt, this.camera);
      if (this.isHost) this.#sendSync(dt);
      return;
    }
    if (this.phase === 'victory' || this.phase === 'defeat') {
      this.boss?.update(dt, t);
      this.#updateMinions(dt);
      return;
    }
  }

  hudData() {
    const me = this.players.get(this.myId);
    return {
      mode: 'boss',
      bossPhase: this.phase,
      bossCountdown: this.phase === 'countdown' ? Math.ceil(this.countdown) : 0,
      boss: this.boss ? {
        // ⚠ 必须带 id：UI 靠它查 BOSS_ICON 换图标，缺了就一直回退成 emoji（2026-11-19 修）
        id: this.bossDef.id,
        name: this.bossDef.name,
        icon: this.bossDef.icon,
        title: this.bossDef.title,
        hp: this.boss.hpRatio,
        stage: this.stage,
        stages: this.runStageCount,
        // 海克斯按「层」显示，无尽续层后不会出现“5/4”
        layer: this.variant === 'hex',
        // 破韧槽：只有前三关配置了 staggerMax 才显示；第四关 UI 会自动收起
        staggerEnabled: this.boss.staggerMax > 0,
        stagger: this.boss.staggerMax > 0 ? this.boss.stagger / this.boss.staggerMax : 0,
        staggered: this.boss.staggerTimer > 0,
        staggerLeft: Math.max(0, this.boss.staggerTimer),
        // BOSS 身上的控制/虚弱状态：状态条只显示当前生效的，图标 + 简短中文 + 倒计时
        debuffs: this.#bossDebuffChips(),
      } : null,
      playerHp: me ? Math.max(0, me.hp) : 0,
      playerMaxHp: PLAYER_MAX_HP,
      playerAlive: me?.alive ?? false,
      revives: me?.revives ?? 0,
      respawnLeft: me && !me.alive && me.respawn > 0 ? me.respawn : 0,
      // 左上玩家列表：自己排第一，其余按进场顺序；AI 也列出来并打标
      party: [...this.players.values()]
        .map((p) => ({
          id: p.id,
          name: this.order.find((e) => e.id === p.id)?.name || p.id,
          avatar: p.avatar || '',
          hp: Math.max(0, p.hp),
          maxHp: PLAYER_MAX_HP,
          alive: p.alive,
          revives: p.revives,
          ai: !!p.ai,
          me: p.id === this.myId,
          taken: Math.round(p.taken || 0),
          // 传送门阶段：已在门内的玩家在列表里打勾
          ready: !!this.portal && this.portal.ready.has(p.id),
        }))
        .sort((a, c) => (c.me ? 1 : 0) - (a.me ? 1 : 0)),
      bossStageName: this.level?.name || '',
      // 每关都用实际天气（classic = 主题自带；海克斯 = 计划随机抽取）
      weather: this.hexWeather,
      items: this.myItems.map((it) => (it ? BOSS_ITEM_DEFS[it] : null)),
      shield: this.localBoat ? Math.max(0, this.localBoat.shieldTimer || 0) : 0,
      weapon: this.weapons.def,
      weaponHeat: this.weapons.heatRatio,
      weaponOverheat: this.weapons.overheat > 0,
      weaponCharge: this.weapons.chargeRatio,
      // 底部技能轨道用：氮气瓶数 / 加速剩余 / 集气进度
      nitroBottles: this.localBoat?.nitroBottles || 0,
      nitroBoost: this.localBoat?.boostTimer || 0,
      nitroCharge: this.localBoat?.nitroCharge || 0,
      nitroAllowed: this.localBoat ? this.localBoat.nitroAllowed !== false : true,
      // 焚风灼膛剩余秒数 / 火力核心超载剩余秒数（左上舰炮面板显示倒计时）
      weaponLock: me ? Math.max(0, me.weaponLock || 0) : 0,
      overload: Math.max(0, this.overloadT || 0),
      // 火力核心位置：小地图画金色菱形（场上没有时为 null）
      fireCore: this.fireCores.length
        ? { x: this.fireCores[0].x, z: this.fireCores[0].z }
        : null,
      // 过关传送门位置：小地图画紫色光环 + 引导虚线（门在场地圈内随机，没标记很难找）
      portal: this.portal ? { x: this.portal.x, z: this.portal.z } : null,
      comboCharge: this.comboCharge / 100,
      comboReady: this.comboReady,
      // 真·双人合击：自己是否已预备 / 最近队友是谁、攒到多少（HUD 提示用）
      comboArmed: this.comboArmed,
      comboMateName: this.order?.find((e) => e.id === this.comboMateId)?.name || null,
      comboMateCharge: this.comboPeers.get(this.comboMateId)?.charge ?? null,
      aggroMine: (this.aggro.get(this.myId) || 0) > 6,
      damageDealt: this.totalDamage,
      damageMine: this.damageByPlayer.get(this.myId) || 0,
      bossInvuln: me ? Math.max(0, me.invuln) : 0,
      // ---- 受击反馈 / 承伤统计（HUD 边缘红闪 + 阵亡面板） ----
      hurtFlash: this.hurtFlash,
      lastHit: me?.lastHit || null,
      deathHit: me?.deathHit || null,
      takenMine: me?.taken || 0,
      takenBy: me
        ? [...me.takenBy.entries()]
          .map(([source, dmg]) => ({ source, dmg: Math.round(dmg) }))
          .sort((a, b) => b.dmg - a.dmg)
        : [],
      // 承伤排名：本关挨伤害最多的排第一（和队员 + AI 一起比）
      takenRank: me ? this.#takenRank(this.myId) : 0,
      takenRankTotal: this.players.size,
      // 海克斯常驻词缀条 / 构筑面板（classic 为 null）
      hex: this.hexBuildInfo(),
    };
  }

  /** BOSS 状态条数据：只返回当前生效的状态，避免空槽占画面 */
  #bossDebuffChips() {
    const s = this.bossStatus;
    const defs = [
      ['vulnerable', '💫', '虚弱'],
      ['silence', '🔇', '沉默'],
      ['reverse', '😵', '失控'],
      ['blind', '🌑', '致盲'],
      ['confuse', '🌀', '混乱'],
      ['slow', '🐢', '减速'],
      ['dive', '🌊', '沉水'],
    ];
    return defs
      .filter(([key]) => (s[key] || 0) > 0.05)
      .map(([key, icon, label]) => ({ key, icon, label, left: Number(s[key].toFixed(1)) }));
  }

  /** 承伤排名（按本关累计承伤，含 AI 陪练）：1 = 挨打最多 */
  #takenRank(id) {
    const sorted = [...this.players.values()]
      .sort((a, b) => (b.taken || 0) - (a.taken || 0));
    return sorted.findIndex((p) => p.id === id) + 1;
  }

  // ---------- 玩家状态 ----------
  #updateWeapons(dt) {
    const boat = this.localBoat;
    const me = this.players.get(this.myId);
    if (!boat) return;
    // 上船 / 换艇后自动切换专属主炮
    if (this.weapons.def?.id !== boat.def?.id) this.weapons.setBoat(boat.def);
    const alive = !!me?.alive;
    // 焚风灼膛：炮膛被烧红期间 J 键完全打不出炮弹（蓄力激光也要就地取消，
    // 否则松手那一帧还会补一发“提前松手”的光束）
    const locked = (me?.weaponLock || 0) > 0;
    if (locked) this.weapons.cancelCharge();
    this.weapons.update(dt, boat, {
      firing: alive && !!this.input?.fire && !locked,
      active: alive,
      // 火力核心：本机吃到后 12 秒的齐射强化
      overload: this.overloadT > 0,
    });
    this.weapons.updateChargeOrb(boat);
  }

  // AI 陪练的主炮：活着就朝 BOSS 开火，弹道逻辑与玩家同一套。
  // 只由权威端模拟（联机时客机连 AI 船的位置都不同步，重复开火会双倍伤害）
  #updateAiWeapons(dt) {
    if (!this.isHost || !this.aiWeapons.size) return;
    const boss = this.boss;
    const inRange = boss && !boss.dead;
    for (const [id, w] of this.aiWeapons) {
      const p = this.players.get(id);
      if (!p) continue;
      const dist = inRange
        ? Math.hypot(p.boat.pos.x - boss.pos.x, p.boat.pos.z - boss.pos.z)
        : Infinity;
      w.update(dt, p.boat, {
        firing: p.alive && dist < 56 && !(p.weaponLock > 0),
        active: p.alive,
      });
    }
  }

  /** 漩涡：范围内持续把船往中心拽，躲技能时也要对抗水流 */
  #updateWhirlpools(dt) {
    const boat = this.localBoat;
    const me = this.players.get(this.myId);
    if (!boat || !me?.alive) return;
    for (const w of this.arena?.whirlpools || []) {
      const dx = w.x - boat.pos.x;
      const dz = w.z - boat.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > w.r || d < 0.5) continue;
      const pull = (1 - d / w.r) * 26 * dt;
      boat.vel.x += (dx / d) * pull;
      boat.vel.y += (dz / d) * pull;
      // 视觉反馈：被吸住时镜头轻微摇晃
      this.whirlAcc += dt;
      if (this.whirlAcc > 0.7) {
        this.whirlAcc = 0;
        this.#shakeCamera(0.12);
      }
    }
  }

  #updatePlayers(dt) {
    for (const p of this.players.values()) {
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.weaponLock > 0) p.weaponLock = Math.max(0, p.weaponLock - dt);
      if (p.spikeCd > 0) p.spikeCd = Math.max(0, p.spikeCd - dt);
      if (!p.alive && p.respawn > 0) {
        p.respawn -= dt;
        if (p.respawn <= 0) this.#respawnPlayer(p);
      }
    }
    // 冲角护符的计时：无条件衰减，玩家在无敌帧里也不该被冻住倒计时
    if (this.ramBuff && this.ramBuff.t > 0) this.ramBuff.t = Math.max(0, this.ramBuff.t - dt);
    // BOSS 近身撞击：高速撞上去会削 BOSS 的血，氮气冲刺翻倍
    const me = this.players.get(this.myId);
    if (me?.alive && me.invuln <= 0 && this.boss && !this.boss.dead) {
      const d = Math.hypot(
        this.localBoat.pos.x - this.boss.pos.x,
        this.localBoat.pos.z - this.boss.pos.z,
      );
      const contact = this.boss.def.radius + 3.2;
      const cd = this.ramCooldown.get(this.myId) || 0;
      if (cd > 0) this.ramCooldown.set(this.myId, cd - dt);
      if (!this.boss.airborne && d < contact && cd <= 0 && this.localBoat.speed > 5) {
        const boosting = this.localBoat.boostTimer > 0;
        // 冲角护符：撞船伤害 ×mul、冷却缩短、撞完不弹开（持续顶在 BOSS 身上连撞）
        const crest = (this.ramBuff && this.ramBuff.t > 0) ? this.ramBuff : null;
        const dmg = BOSS_RAM_BASE * (boosting ? BOSS_RAM_NITRO_MULT : 1)
          * (crest ? crest.mul : 1)
          * Math.max(0.6, Math.min(1.8, this.localBoat.speed / 18));
        this.#dealBossDamage(dmg, { stagger: dmg * BOSS_STAGGER.gainOther });
        audio.play(boosting ? 'ram_boss_nitro' : 'ram_boss', { gap: 180 });
        if (boosting) audio.play('boss_nitro', { gap: 300, at: 0.03 });
        this.fx.play('hit', this.localBoat.pos.x, 1.4, this.localBoat.pos.z, 1.2);
        // 带冲角护符的撞击额外补一圈声爆环，和普通擦碰区分开
        if (crest) this.fx.play('fxSonicBoom', this.localBoat.pos.x, 1.6, this.localBoat.pos.z, 0.6);
        if (!crest) {
          // 撞完往相反方向弹开。带了冲角护符就刻意不弹，让玩家能贴着 BOSS 连撞
          const nx = this.localBoat.pos.x - this.boss.pos.x;
          const nz = this.localBoat.pos.z - this.boss.pos.z;
          const len = Math.hypot(nx, nz) || 1;
          this.localBoat.vel.x += (nx / len) * 6;
          this.localBoat.vel.y += (nz / len) * 6;
        }
        this.ramCooldown.set(this.myId, crest ? 0.9 * (crest.cdScale || 0.55) : 0.9);
      }
    }
    // 沉船玩家：镜头由 Game 交给队友
  }

  /**
   * 统一扣血入口。
   * @param {object} [opts.source] 伤害来源标签（如「🔥 喷火吐息」「⚡ 落雷」），
   *   用于阵亡界面与结算里的承伤统计；不传就记成“未知来源”。
   * @param {object} [opts.hp] 第三 / 四关默认只算击退与承伤、不真扣血（那两关靠机制施压，
   *   见 #updateChargeLink 的注释）。实打实的碰撞伤害要传 true 才走血量：
   *   巨鲸鲨泡泡就是这种——玩家要求「碰到就掉血」，不能只是被推一下。
   */
  #damagePlayer(id, amount, {
    awayFrom = null, knockback = true, source = null, hp = false,
  } = {}) {
    const p = this.players.get(id);
    if (!p || !p.alive || p.invuln > 0) return 0;
    if (p.boat.shieldTimer > 0) {
      if (id === this.myId) audio.play('shield_break');
      return 0;
    }
    const dmg = Math.max(0, amount) * this.#hexTakenMul(id);
    const src = source || '未知来源';
    if (hp || (this.ruleStage !== 3 && this.ruleStage !== 4)) p.hp -= dmg;
    // 挨打的声音只给本地玩家：队友掉血不该在这里响
    if (id === this.myId) audio.play('player_hit', { gap: 180 });
    // 承伤统计：本关累计 + 按来源分类 + 最后一次挨的打（死亡时另存一份）
    p.taken += dmg;
    p.takenBy.set(src, (p.takenBy.get(src) || 0) + dmg);
    p.lastHit = { source: src, dmg, hp: Math.max(0, p.hp) };
    if (p.hp <= 0) p.deathHit = p.lastHit;
    p.boat.stunTimer = Math.max(p.boat.stunTimer, BOSS_HIT_STUN);
    if (knockback && awayFrom) {
      const dx = p.boat.pos.x - awayFrom.x;
      const dz = p.boat.pos.z - awayFrom.z;
      const len = Math.hypot(dx, dz) || 1;
      // 击退加强到 1.5 倍：被命中时船会被明显推出原点，不再是“原地掉个血”
      p.boat.vel.x += (dx / len) * BOSS_HIT_KNOCKBACK * 1.5;
      p.boat.vel.y += (dz / len) * BOSS_HIT_KNOCKBACK * 1.5;
    }
    if (id === this.myId) {
      // 本机受击：更重的命中音效 + 船身抖动 + 屏幕边缘红闪
      this.fx.play('hit', p.boat.pos.x, 1.2, p.boat.pos.z, 2.6);
      p.boat.hitShake = Math.max(p.boat.hitShake || 0, HIT_SHAKE_TIME);
      this.hurtFlash = Math.max(this.hurtFlash, 0.55);
    } else {
      // 队友被打：主机端也要看得见那一下，否则多人时只看到血条莫名下降
      this.fx.play('hit', p.boat.pos.x, 1.2, p.boat.pos.z, 1.4);
    }
    if (p.hp <= 0) this.#killPlayer(p);
    return dmg;
  }

  #killPlayer(p) {
    p.hp = 0;
    p.alive = false;
    this.fx.play('explosion', p.boat.pos.x, 1.4, p.boat.pos.z, 2.2);
    p.boat.applyFx('sink', 2.4);
    if (p.revives > 0) {
      // 先给一段“可被队友救起”的窗口；没人来才消耗复活次数自动复活
      p.respawn = PLAYER_RESCUE_WINDOW;
      p.rescueT = PLAYER_RESCUE_WINDOW;
      this.#spawnRescueMarker(p);
      if (p.id === this.myId) {
        this.opts.onToast?.(`💥 船沉了！队友 ${PLAYER_RESCUE_WINDOW} 秒内靠近可救起，否则自动复活（剩 1 次）`);
      }
    } else {
      p.respawn = 0;
      if (p.id === this.myId) this.opts.onToast?.('💀 复活次数用尽，等待队友通关…');
    }
    this.#checkDefeat();
    // 沉船要告诉队友：他们那边才能画出“救生圈”并开过来救援
    if (!p.ai) this.net?.send({ t: 'bossDown', id: p.id, x: p.boat.pos.x, z: p.boat.pos.z });
  }

  #respawnPlayer(p) {
    p.revives -= 1;
    p.alive = true;
    p.hp = PLAYER_MAX_HP;
    p.invuln = PLAYER_INVULN_TIME;
    p.rescueT = null;
    // 复活后清掉“最后一击/死亡来源”，否则阵亡面板会一直挂着上一轮的死因
    p.lastHit = null;
    p.deathHit = null;
    this.#clearRescueMarker(p);
    // 场地边缘的安全点：背对 BOSS
    // 第一阶段只能在通道里活动，复活点也必须落在通道后沿——
    // 否则刚复活就会被 constrainBoat 从场边硬拽回来（像瞬移）。
    if (this.boss && this.lane && !this.freeMove) {
      const { fx, fz } = this.lane;
      const r = BOSS_LANE.far - 2;
      p.boat.resetTo(
        this.boss.pos.x + fx * r,
        this.boss.pos.z + fz * r,
        Math.atan2(-fx, -fz),
      );
    } else {
      const angle = this.boss
        ? Math.atan2(p.boat.pos.z - this.boss.pos.z, p.boat.pos.x - this.boss.pos.x)
        : Math.PI / 2;
      const r = this.arena.radius - 18;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;
      p.boat.resetTo(x, z, Math.atan2(-x, -z));
      this.fx.play('ring', x, 1.2, z);
    }
    p.boat.applyFx('shield', PLAYER_INVULN_TIME);
    if (p.id === this.myId) audio.play('respawn');
  }

  /** R 键：在复活倒计时里立刻复活（消耗一次复活机会） */
  respawnLocal() {
    const me = this.players.get(this.myId);
    if (!me || me.alive || me.revives <= 0 || this.phase !== 'fight') return false;
    me.respawn = 0;
    this.#respawnPlayer(me);
    return true;
  }

  #checkDefeat() {
    if (this.phase !== 'fight') return;
    // 全员阵亡必须看“场上所有人”，AI 陪练也要算：
    // 只要还有任何一艘船活着、或还有复活次数/复活倒计时，就不能判负。
    const members = [...this.players.values()];
    const eliminated = members.length > 0
      && members.every((p) => !p.alive && p.revives <= 0 && p.respawn <= 0);
    if (eliminated) {
      this.phase = 'defeat';
      const data = this.#resultData(false);
      this.opts.onDefeat?.(data);
      if (this.isHost) {
        this.net?.send({
          t: 'bossEnd', victory: false,
          damage: data.damage, taken: data.taken, takenBy: data.takenBy,
        });
      }
    }
  }

  // ---------- 技能命中判定 ----------

  /**
   * 网络延迟补偿用的判定点。
   * 主机判定客机玩家时，手里是 30Hz 快照里"过去"的位置，船速 20m/s 时能差 2~4 米，
   * 于是出现"我明明躲开了还是掉血"。这里按航向和速度把客机的位置往前外推半个 RTT，
   * 用外推后的点做判定。本机自己的船和单机模式不外推（本来就是实时的）。
   * 外推上限 0.15 秒：再大就会反过来变成"看着没打中却掉血"。
   */
  #hitProbe(boat, id) {
    const lag = (this.solo || !this.net || id === this.myId)
      ? 0
      : Math.min(0.15, (Number(this.net.rtt) || 0) / 2000);
    const speed = Number(boat?.speed) || 0;
    if (lag <= 0.001 || speed < 0.5) return { x: boat.pos.x, z: boat.pos.z };
    const h = Number(boat.heading) || 0;
    return {
      x: boat.pos.x + Math.sin(h) * speed * lag,
      z: boat.pos.z + Math.cos(h) * speed * lag,
    };
  }

  /**
   * 单个玩家是否落在技能的命中几何里（不含掩体遮挡）。
   * 抽出来是因为"持续判定"要在一秒内反复调它。
   */
  #skillHits(skill, info, boat, id) {
    // 判定必须带上船体半径：以前只判船心，火焰扫到船头/船尾时船心还在外面，
    // 就会看到"明明烧到了却不掉血"。这里统一扩到船体支撑半径。
    const hull = Math.max(2.5, boat.def?.hull?.length || 4.5) * 0.46 + 0.12;
    const probe = this.#hitProbe(boat, id);
    if (skill.kind === 'cone') {
      // 喷吐从嘴部喷出（BossMode 的特效原点也是 radius*0.78），判定原点必须一致，
      // 否则远端会少判一段、近端角度会收窄。
      const mouth = (this.boss?.def?.radius || 5) * 0.78;
      const ox = info.x + Math.sin(info.heading) * mouth;
      const oz = info.z + Math.cos(info.heading) * mouth;
      const dx = probe.x - ox;
      const dz = probe.z - oz;
      const dist = Math.hypot(dx, dz);
      const facing = Math.atan2(dx, dz);
      let diff = facing - info.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const half = THREE.MathUtils.degToRad(skill.angle || 55) / 2;
      // 船体越近，角宽容差越大（船体宽度总是占一定角度）
      const slack = Math.min(0.34, Math.atan2(hull, Math.max(4, dist)));
      return dist <= (skill.range || 24) + hull && Math.abs(diff) <= half + slack;
    }
    const dx = probe.x - info.x;
    const dz = probe.z - info.z;
    const dist = Math.hypot(dx, dz);
    if (skill.kind === 'blink') {
      // 瞬移后的近战横扫：判定原点就是 BOSS 落点（身体中心），
      // 扇形沿落点朝向，半径覆盖到刀锋末端。
      const facing = Math.atan2(dx, dz);
      let diff = facing - info.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const half = THREE.MathUtils.degToRad(skill.angle || 130) / 2;
      const slack = Math.min(0.4, Math.atan2(hull, Math.max(3, dist)));
      return dist <= (skill.radius || 10) + hull && Math.abs(diff) <= half + slack;
    }
    if (skill.kind === 'ring') return Math.abs(dist - skill.radius) <= 3.4 + hull;
    if (skill.kind === 'path') {
      const fx = Math.sin(info.heading);
      const fz = Math.cos(info.heading);
      const along = dx * fx + dz * fz;
      const lateral = Math.abs(dx * fz - dz * fx);
      return along > -4 && along < 42 + hull
        && lateral <= (skill.width || 8) / 2 + hull;
    }
    return dist <= (skill.radius || 10) + hull;
  }

  /**
   * 一次命中结算。持续技能每 0.15 秒调一次，hitCd 记每个玩家的内部冷却，
   * 避免一秒内被同一招扣六次血。地面技能（落雷/俯冲/大招）只调一次。
   */
  #applySkillTick(skill, info, dmgScale, hitCd) {
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      if (hitCd && (hitCd.get(p.id) || 0) > 0) continue;
      if (!this.#skillHits(skill, info, p.boat, p.id)) continue;
      // 浮岩掩体：扇形吐息和直线冲锋会被岩石挡住，绕掩体是正经的走位解法
      if ((skill.kind === 'cone' || skill.kind === 'path')
        && this.arena?.blocksLine?.(info.x, info.z, p.boat.pos.x, p.boat.pos.z, 0.6)) {
        continue;
      }
      const dealt = this.#damagePlayer(p.id, skill.damage * this.boss.damageScale * dmgScale, {
        awayFrom: { x: info.x, z: info.z },
        source: skillSource(skill),
      });
      if (dealt <= 0) continue;
      // 霜雪吐息：命中挂减速 debuff（和喷火的区分点）
      if (skill.slowSpeed) this.#applySlow(p, skill.slowSpeed, skill.slowTime, skill.slowLabel || '❄ 被霜雪冻住');
      // 焚风灼膛：命中即缴械。前面 dealt<=0 已经 continue，
      // 所以护盾 / 复活无敌挡下来的命中不会挂锁。
      if (skill.lockWeapon) this.#lockWeapon(p, skill.lockWeapon);
      if (hitCd) hitCd.set(p.id, SKILL_HIT_CD);
      hits.push({
        id: p.id, dmg: dealt,
        src: skillSource(skill),
        ...(skill.slowSpeed ? { slow: skill.slowTime, slowSpeed: skill.slowSpeed } : {}),
        ...(skill.lockWeapon ? { lock: skill.lockWeapon } : {}),
      });
      // 命中点爆在"船身上"，玩家才知道这一招真的打到自己了
      this.#spawnBurst(
        p.boat.pos.x, 1.8, p.boat.pos.z,
        SKILL_HIT_COLOR[skill.visual] || 0xff8a5a, 0.95,
      );
    }
    if (hits.length && this.isHost) this.net?.send({ t: 'bossHit', hits });
    return hits;
  }

  /**
   * 技能落地。喷吐/横扫/冲锋改成**持续判定窗口**：
   * 喷射粒子持续 0.95 秒，判定也持续 0.95 秒、每 0.15 秒扫一次。
   * 以前是"预警结束那一瞬间只判一次"，火焰扫到船身上时判定早就结束了，
   * 所以玩家会看到"明明烧到了却不掉血"。
   */
  #resolveSkill(skill, info) {
    // 章鱼生效期间：扇形/冲锋的方向随机偏 ±120°，BOSS 会对着空气喷
    if (this.bossStatus.confuseCast > 0 && (skill.kind === 'cone' || skill.kind === 'path')) {
      info = {
        ...info,
        heading: info.heading + (Math.random() - 0.5) * (Math.PI * 4 / 3),
      };
    }
    if (skill.kind === 'buff') {
      this.boss.rageMult = Math.min(1.35, (this.boss.rageMult || 1) * (skill.moveScale || 1.2));
      this.boss.animScale = Math.min(1.5, (this.boss.animScale || 1) * (skill.attackScale || 1.2));
      this.opts.onToast?.('👹 BOSS 进入狂怒！');
      return;
    }
    // 客机同步：吸取漩涡 / 水柱扩散浪 / 瞬移残影 / 全屏血幕 这些演出
    // 没有“预警红圈”以外的表现，必须让客机在本地也放一遍。
    if (this.isHost) {
      // 所有技能都广播命中演出：以前只发 pull/screen/blink/geyser，
      // 客机看喷火/冲锋时只有一圈红预警、没有火焰和冲锋粒子，完全不知道技能已经放了
      this.net?.send({
        t: 'bossSkill', skill: skill.id, x: info.x, z: info.z,
        h: info.heading, ox: info.ox, oz: info.oz,
      });
    }
    if (skill.kind === 'pull') {
      this.#beginPull(skill, info, this.isHost);
    } else if (skill.kind === 'rift') {
      this.#resolveRift(skill, info);
    } else if (skill.kind === 'gate') {
      this.#beginSummonGate(skill, info);
    } else if (skill.kind === 'grid') {
      this.#beginGridThunder(skill, info);
    } else if (skill.kind === 'laser') {
      this.#beginLaserSweep(skill, info);
    } else if (skill.kind === 'screen') {
      this.#resolveScreenSkill(skill, info);
    } else if (skill.kind === 'blink') {
      this.#resolveBlinkSkill(skill, info);
    } else if (skill.kind === 'slam') {
      // 跳劈已经从 BOSS 的跃起位移里落到 info.x/info.z；
      // 三段伤害（中心 / 外圈 / 延迟余波）都在这里结算
      this.#resolveSlamSkill(skill, info, this.isHost);
    } else if (skill.kind === 'rain') {
      // 龙鳞骤雨：整片区域的落点由确定性螺旋生成，逐片延迟落地
      this.#resolveRainSkill(skill, info, this.isHost);
    } else if (skill.kind === 'geyser') {
      this.#resolveGeyserSkill(skill, info);
      if (this.isHost) this.#applySkillTick(skill, info, 1, null);
    } else if (skill.kind === 'wave') {
      // 熔岩海啸：火墙从 BOSS 脚下往正前方推，判定由 #updateLavaWave 逐帧扫
      this.#resolveLavaWave(skill, info);
      this.#playSkillVisual(skill, info, 'hit');
    } else if (skill.kind === 'zone') {
      // 暗影缠触：落点圈持续 3.4 秒，每 0.6 秒缠一次（掉血 + 减速）
      this.#beginShadowZone(skill, info);
      this.#playSkillVisual(skill, info, 'hit');
    } else if (skill.kind === 'cone' || skill.kind === 'path') {
      // 命中后 0.95 秒的持续判定窗口：判定和粒子流同步持续
      if (this.isHost) this.hazards.push({ skill, info, t: 0, next: 0, hitCd: new Map() });
      this.#playSkillVisual(skill, info, 'hit');
    } else {
      if (this.isHost) this.#applySkillTick(skill, info, 1, null);
      this.#playSkillVisual(skill, info, 'hit');
    }
    if (skill.id === 'phaseBlast') {
      // 大招落地的"重"：震屏 + 顿帧 + 爆点，和普通技能形成明显区分
      this.#shakeCamera(1.1);
      this.hitStop = Math.max(this.hitStop, 0.09);
      this.#spawnBurst(
        info.x, Math.max(2.5, (this.boss?.def.height || 6) * 0.5), info.z,
        0xff7a4a, 2.0,
      );
      // 崩海咆哮的实体层：ef_fire03 是"向上喷射的火柱"。
      // 尺寸踩过三次坑：1.7 一人高看不见、4.2 黄昏底色糊掉、8.0 才够。
      // 半径也踩过两次：18.6m 时第 2/3 关玩家贴身（BOSS 会追人），整圈火柱跑到视野外，
      // 所以收回到 BOSS 身周 10m —— 从远到近都能看见，代价是远处看只有"一团大火"。
      // 基准点做一次兜底：info 里的 x/z 只要有一个不是有限数，
      // 5 个火柱的坐标全会算成 NaN、被 Effekseer 塞到同一个默认点上
      // （第 2/3 关"只有一小团火"、第 1 关"一整面火墙"都是这个症状）
      const bp = this.boss?.pos;
      const cx = Number.isFinite(info?.x) ? info.x : (Number.isFinite(bp?.x) ? bp.x : 0);
      const cz = Number.isFinite(info?.z) ? info.z : (Number.isFinite(bp?.z) ? bp.z : 0);
      const blastR2 = 11;
      const TOWER = 5;
      for (let i = 0; i < TOWER; i++) {
        const a = (i / TOWER) * Math.PI * 2 + 0.3;
        const bx = cx + Math.cos(a) * blastR2;
        const bz = cz + Math.sin(a) * blastR2;
        // ① Effekseer 的 ef_fire03 火柱（有形态、有粒子翻腾）
        this.fx?.play('fxFireBand', bx, 5.0, bz, 9.5);
        // ② 三渲的实体火柱兜底：同一套 SkillFx.pillar 在泉涌水柱上验证过三关都稳定可见，
        //    不依赖 Effekseer 的实例坐标，第 2/3 关也一定看得见
        this.skillFx?.pillar('fire', { x: bx, z: bz, radius: 5.5, height: 15, duration: 1.6 });
      }
      this.opts.onToast?.('💥 崩海咆哮！');
    }
    // BOSS 的 AOE 会引爆落在范围内的陷阱：把水雷丢到自己脚下，引它放技能
    if (!this.isHost) return;
    const blastR = skill.kind === 'cone'
      ? (skill.range || 24) * 0.55
      : (skill.radius || skill.width || 10) + 4;
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const trap = this.traps[i];
      if (Math.hypot(trap.x - info.x, trap.z - info.z) <= blastR) {
        this.#removeTrap(trap, i);
        this.#triggerTrap(trap);
      }
    }
  }

  // ---------- 每关个性化玩法（第三十八轮） ----------

  /**
   * 第一关 · 裂隙喷发：红圈内钻出三根水柱（左 / 中 / 右）。
   * 落点是**确定性**的（只依赖 info.x/z/heading），客机在同一份 info 上算出的位置完全一致，
   * 不需要额外同步。
   */
  #riftSpots(skill, info) {
    const ox = Number.isFinite(info?.x) ? info.x : 0;
    const oz = Number.isFinite(info?.z) ? info.z : 0;
    const h = Number.isFinite(info?.heading) ? info.heading : 0;
    // heading 方向是 (sin h, cos h)，垂直方向是 (cos h, -sin h)
    const px = Math.cos(h);
    const pz = -Math.sin(h);
    const off = skill.spotOffset ?? 10;
    const lim = Math.max(0, (this.arena?.radius || 90) - 8);
    const clamp = (x, z) => {
      const d = Math.hypot(x, z);
      if (d <= lim || d < 0.001) return { x, z };
      return { x: (x / d) * lim, z: (z / d) * lim };
    };
    return [
      clamp(ox - px * off, oz - pz * off),
      clamp(ox, oz),
      clamp(ox + px * off, oz + pz * off),
    ];
  }

  #resolveRift(skill, info) {
    const spots = this.#riftSpots(skill, info);
    const r = skill.spotRadius || 5.2;
    for (const s of spots) {
      // 水下先炸一圈水环，再立水柱：和第一关的喷火在观感上完全分开
      this.fx?.play('fxMagic1Water', s.x, 0.5, s.z, 1.3);
      this.fx?.play('fxUpdraft', s.x, 0.8, s.z, 0.8);
      this.skillFx.pillar('water', {
        x: s.x, z: s.z, radius: r, height: 16, duration: 1.2,
      });
      // 只保留向外扩散的水花，不要水柱外圈那层光环（用户要求）
      this.skillFx.ringBurst('water', {
        x: s.x, z: s.z, radius: r + 2, count: 22, up: 6, ring: false,
      });
    }
    this.#shakeCamera(0.35);
    if (!this.isHost) return;
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      const hull = Math.max(2.5, p.boat.def?.hull?.length || 4.5) * 0.46;
      const near = spots.find((s) => Math.hypot(p.boat.pos.x - s.x, p.boat.pos.z - s.z) <= r + hull);
      if (!near) continue;
      const dealt = this.#damagePlayer(p.id, skill.damage * (this.boss?.damageScale || 1), {
        awayFrom: near, source: skillSource(skill),
      });
      if (dealt <= 0) continue;
      if (skill.slowSpeed) {
        this.#applySlow(p, skill.slowSpeed, skill.slowTime, skill.slowLabel || '🌊 被水柱掀翻');
      }
      this.#spawnBurst(p.boat.pos.x, 1.8, p.boat.pos.z, SKILL_HIT_COLOR.water, 1.0);
      hits.push({
        id: p.id, dmg: dealt, src: skillSource(skill),
        slow: skill.slowTime, slowSpeed: skill.slowSpeed,
      });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  /**
   * 第二关 · 深渊召唤门：BOSS 两侧开火门，延迟 openDelay 秒后从门里钻怪。
   * 门的坐标只依赖 BOSS 位置 + 朝向，客机本地也能算出同一组坐标；
   * 真正刷怪只在主机执行，然后照旧走 bossSummon 广播。
   */
  #beginSummonGate(skill, info) {
    const b = this.boss;
    if (!b) return;
    const count = Math.max(1, skill.gateCount || 2);
    const spread = skill.gateSpread ?? 0.85;
    const R = skill.gateRadius || 32;
    const base = Number.isFinite(info?.heading) ? info.heading : b.heading;
    const lim = Math.max(0, (this.arena?.radius || 90) - 10);
    const entries = [];
    for (let i = 0; i < count; i++) {
      const a = base + (count === 1 ? 0 : ((i / (count - 1)) * 2 - 1) * spread);
      let x = b.pos.x + Math.sin(a) * R;
      let z = b.pos.z + Math.cos(a) * R;
      const d = Math.hypot(x, z);
      if (d > lim && d > 0.001) {
        x = (x / d) * lim;
        z = (z / d) * lim;
      }
      // 门面：程序化暖色旋涡 + 地面火焰法阵 + 一道向上收束的火柱。
      // 原来想用 P2_GateOfCalve，但它在部分显卡上贴图上传会抛 texImage2D 异常，
      // 直接把整帧渲染打断，所以改成自绘门面（观感更可控，也零风险）。
      this.#openGateVisual(x, z, skill);
      this.skillFx.pillar('fire', { x, z, radius: 5.2, height: 15, duration: 1.1 });
      // 只保留门和水花，不要门外那圈地面光环（用户要求）
      this.skillFx.ringBurst('fire', { x, z, radius: 10, count: 40, up: 6, ring: false });
      for (const g of (skill.spawns || [{ type: 'crab', count: 1 }, { type: 'jelly', count: 1 }])) {
        const n = Math.max(1, g.count || 1);
        for (let k = 0; k < n; k++) {
          const aa = a + (k - (n - 1) / 2) * 0.5;
          entries.push({
            type: g.type,
            x: x + Math.sin(aa) * 5,
            z: z + Math.cos(aa) * 5,
          });
        }
      }
    }
    this.#shakeCamera(0.3);
    this.gateQueue.push({ t: skill.openDelay ?? 1.1, entries });
    this.opts.onToast?.('🔥 深渊召唤门！先清门里钻出来的小怪');
  }

  /** 立起一道火门：亮橙色大圆环 + 旋涡门面 + 竖直光幕，始终正对镜头 */
  #openGateVisual(x, z, skill) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5.4, 0.42, 10, 48),
      new THREE.MeshBasicMaterial({
        color: 0xffa03a, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.position.y = 5.2;
    group.add(ring);
    // 内圈白边：远处也能一眼认出这是“门”，不再是一根细红线
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(4.95, 0.14, 8, 48),
      new THREE.MeshBasicMaterial({
        color: 0xfff2d6, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    rim.position.y = 5.2;
    group.add(rim);
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(5.05, 48),
      new THREE.MeshBasicMaterial({
        map: gateTexture(), transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    face.position.y = 5.2;
    group.add(face);
    // 竖直光幕：任何角度都能看到一根立起来的火柱，而不只是贴水的圆环
    const column = new THREE.Mesh(
      new THREE.CylinderGeometry(5.15, 5.15, 13, 32, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff8a3a, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    column.position.y = 6.5;
    group.add(column);
    group.position.set(x, 0, z);
    group.renderOrder = 4;
    this.scene.add(group);
    this.gateVisuals.push({
      group, ring, rim, face, column,
      t: 0,
      // 原来只亮 2.3s，玩家回头看一眼门就没了；延长到约 3.5s，看清位置
      life: (skill.openDelay ?? 1.1) + 2.4,
    });
    // 门面本身是程序化暖色旋涡 + 圆环，这里只补一层上升气流；
    // fxFireBurst / fxFireRune 偶发贴图上传异常，不再使用。
    this.fx?.play('fxUpdraft', x, 0.4, z, 1.4);
  }

  #clearGateVisuals() {
    for (const v of this.gateVisuals) {
      this.scene.remove(v.group);
      v.group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        o.material.dispose();
      });
    }
    this.gateVisuals.length = 0;
  }

  #updateGateQueue(dt) {
    // 门面淡出（主机 / 客机都要跑，纯表现）
    for (let i = this.gateVisuals.length - 1; i >= 0; i--) {
      const v = this.gateVisuals[i];
      v.t += dt;
      const k = Math.min(1, v.t / Math.max(0.001, v.life));
      const fade = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      v.ring.material.opacity = 0.95 * Math.max(0, fade);
      v.rim.material.opacity = 0.9 * Math.max(0, fade);
      v.face.material.opacity = 0.85 * Math.max(0, fade);
      v.column.material.opacity = 0.16 * Math.max(0, fade);
      // 只让门自己“转”，整扇门始终正对镜头：以前绕 Y 轴整圈自转，
      // 转到侧面就成了一条线，玩家才会完全找不到门。
      const cam = this.camera;
      if (cam) {
        v.group.rotation.y = Math.atan2(
          cam.position.x - v.group.position.x,
          cam.position.z - v.group.position.z,
        );
      }
      v.face.rotation.z += dt * 1.1;
      v.ring.rotation.z -= dt * 0.5;
      if (k < 1) continue;
      this.scene.remove(v.group);
      v.group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        o.material.dispose();
      });
      this.gateVisuals.splice(i, 1);
    }
    if (!this.gateQueue.length) return;
    for (let i = this.gateQueue.length - 1; i >= 0; i--) {
      const g = this.gateQueue[i];
      g.t -= dt;
      if (g.t > 0) continue;
      this.gateQueue.splice(i, 1);
      // 客机不自己刷怪：等主机的 bossSummon 广播
      if (!this.isHost) continue;
      this.#spawnMinions(g.entries);
      this.net?.send({ t: 'bossSummon', entries: g.entries });
    }
  }

  // ---------- 第三关 · 雷霆棋盘 ----------

  #gridCycle(skill) {
    return (skill.warnTime ?? 0.9) + (skill.activeTime ?? 0.45);
  }

  #gridDuration(skill) {
    return (skill.waves || 4) * this.#gridCycle(skill);
  }

  /** 棋盘贴图：一块棋盘格一组，两组对角交替点亮 */
  #makeGridBoard(skill, cols, rows, span) {
    const groupCells = skill.groupCells || Math.floor(cols / 2);
    const makeTex = (second) => {
      const cv = document.createElement('canvas');
      cv.width = 512;
      cv.height = 512;
      const g = cv.getContext('2d');
      const cw = 512 / cols;
      const ch = 512 / rows;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const inA = (cx < groupCells && cy < groupCells)
            || (cx >= cols - groupCells && cy >= rows - groupCells);
          if (inA === second) continue;
          g.fillStyle = 'rgba(168,236,255,0.9)';
          g.fillRect(cx * cw + 1.5, cy * ch + 1.5, cw - 3, ch - 3);
        }
      }
      // 格线：两组共用同一张网格，谁亮都能看出“一格一格”
      g.strokeStyle = 'rgba(236,252,255,0.95)';
      g.lineWidth = 4;
      for (let i = 0; i <= cols; i++) {
        g.beginPath();
        g.moveTo(i * cw, 0);
        g.lineTo(i * cw, 512);
        g.stroke();
      }
      for (let i = 0; i <= rows; i++) {
        g.beginPath();
        g.moveTo(0, i * ch);
        g.lineTo(512, i * ch);
        g.stroke();
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    };
    const mk = (second) => {
      const geo = new THREE.PlaneGeometry(span, span);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        map: makeTex(second),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // 棋盘必须浮在浪峰之上：0.18 会被水面波浪盖住大半，预警几乎看不见
      mesh.position.set(0, 0.75, 0);
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      return { mesh, mat };
    };
    return { a: mk(false), b: mk(true) };
  }

  #clearGridThunder() {
    const g = this.gridThunder;
    if (!g) return;
    for (const key of ['a', 'b']) {
      const part = g.board?.[key];
      if (!part) continue;
      this.scene.remove(part.mesh);
      part.mesh.geometry.dispose();
      part.mat.map?.dispose();
      part.mat.dispose();
    }
    this.gridThunder = null;
  }

  #beginGridThunder(skill, info) {
    this.#clearGridThunder();
    audio.play(bossSkillSfx('thunder'));
    const cols = skill.cols || 6;
    const rows = skill.rows || 6;
    // 棋盘铺满整个竞技场（直径 + 一点余量），外侧不留“永远安全”的边角
    const span = skill.span || ((this.arena?.radius || 90) * 2 + 4);
    const total = this.#gridDuration(skill);
    this.gridThunder = {
      skill, t: 0, wave: -1, phase: null,
      cols, rows, span,
      cellX: span / cols,
      cellZ: span / rows,
      groupCells: skill.groupCells || Math.floor(cols / 2),
      board: this.#makeGridBoard(skill, cols, rows, span),
      warnTime: skill.warnTime ?? 0.9,
      activeTime: skill.activeTime ?? 0.45,
      waves: skill.waves || 4,
    };
    const bp = this.boss?.pos || { x: 0, z: 0 };
    this.skillFx.ringBurst('thunder', {
      x: bp.x, z: bp.z, radius: 24, count: 60, up: 10,
    });
    this.#shakeCamera(0.7);
    this.hitStop = Math.max(this.hitStop, 0.06);
    // 整段棋盘期间 BOSS 定身，专心“下棋”
    this.bossStatus.root = Math.max(this.bossStatus.root || 0, total + 0.1);
    this.opts.onToast?.('⚡ 雷霆棋盘！躲到暗色格子，亮格马上落雷');
  }

  #updateGridThunder(dt) {
    const g = this.gridThunder;
    if (!g) return;
    g.t += dt;
    if (g.t >= g.waves * (g.warnTime + g.activeTime)) {
      this.#clearGridThunder();
      return;
    }
    const cycle = g.warnTime + g.activeTime;
    const wave = Math.min(g.waves - 1, Math.floor(g.t / cycle));
    const local = g.t - wave * cycle;
    const phase = local < g.warnTime ? 'warn' : 'active';
    const group = wave % 2; // 0 = 左上 + 右下，1 = 右上 + 左下
    const k = phase === 'warn' ? local / Math.max(0.001, g.warnTime) : 1;
    const on = phase === 'warn' ? 0.35 + 0.6 * k : 1;
    const off = phase === 'warn' ? 0.1 : 0.05;
    g.board.a.mat.opacity = group === 0 ? on : off;
    g.board.b.mat.opacity = group === 1 ? on : off;
    if (g.wave !== wave || g.phase !== phase) {
      g.wave = wave;
      g.phase = phase;
      if (phase === 'active') {
        this.#strikeGridCells(g, group);
        if (this.isHost) this.#damageGridCells(g, group);
      }
    }
  }

  /** 本波亮起的格子逐格落雷：程序化雷柱铺满整片，玩家所在格再补一记 Effekseer 天雷 */
  #strikeGridCells(g, group) {
    const halfX = g.span / 2;
    const halfZ = g.span / 2;
    const players = [...this.players.values()].filter((p) => p.alive);
    for (let cy = 0; cy < g.rows; cy++) {
      for (let cx = 0; cx < g.cols; cx++) {
        const inA = (cx < g.groupCells && cy < g.groupCells)
          || (cx >= g.cols - g.groupCells && cy >= g.rows - g.groupCells);
        if ((group === 0) !== inA) continue;
        const x = -halfX + (cx + 0.5) * g.cellX;
        const z = -halfZ + (cy + 0.5) * g.cellZ;
        this.skillFx.bolt({ x, z, height: 34 });
      }
    }
    // 每名玩家头上补一记「天雷落地」：用已验证的 fxLightningStrike，
    // 一台机器一帧最多 4 个实例，比一格一个光柱稳定得多。
    for (const p of players) {
      this.fx?.play('fxLightningStrike', p.boat.pos.x, 8, p.boat.pos.z, 1.6);
    }
    audio.play(bossSkillSfx('thunder'));
    this.#shakeCamera(0.55);
  }

  #damageGridCells(g, group) {
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      const cx = Math.floor((p.boat.pos.x + g.span / 2) / g.cellX);
      const cy = Math.floor((p.boat.pos.z + g.span / 2) / g.cellZ);
      if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) continue;
      const inA = (cx < g.groupCells && cy < g.groupCells)
        || (cx >= g.cols - g.groupCells && cy >= g.rows - g.groupCells);
      if ((group === 0) !== inA) continue;
      const dealt = this.#damagePlayer(p.id, g.skill.damage * (this.boss?.damageScale || 1), {
        awayFrom: { x: 0, z: 0 }, source: skillSource(g.skill),
      });
      if (dealt <= 0) continue;
      this.#spawnBurst(p.boat.pos.x, 1.8, p.boat.pos.z, SKILL_HIT_COLOR.thunder, 1.2);
      hits.push({ id: p.id, dmg: dealt, src: skillSource(g.skill) });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  // ---------- 第四关 · 血月激光 ----------

  #makeLaserBeam(skill) {
    const reach = skill.reach || 88;
    const w = skill.beamWidth || 5;
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff2b4d, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const core = new THREE.MeshBasicMaterial({
      color: 0xffd0d8, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    // 贴海面的光带：负责让玩家看清“光束现在扫到哪”
    const flat = new THREE.PlaneGeometry(w, reach);
    flat.rotateX(-Math.PI / 2);
    flat.translate(0, 0.3, reach / 2);
    group.add(new THREE.Mesh(flat, mat));
    const flatCore = new THREE.PlaneGeometry(w * 0.32, reach);
    flatCore.rotateX(-Math.PI / 2);
    flatCore.translate(0, 0.34, reach / 2);
    group.add(new THREE.Mesh(flatCore, core));
    // 竖直光墙：远处也能读出光束的角度
    const wall = new THREE.PlaneGeometry(reach, 3.4);
    wall.rotateY(Math.PI / 2);
    wall.translate(0, 1.7, reach / 2);
    group.add(new THREE.Mesh(wall, mat));
    group.renderOrder = 5;
    const b = this.boss;
    group.position.set(b?.pos.x || 0, 0, b?.pos.z || 0);
    this.scene.add(group);
    return { group, mats: [mat, core] };
  }

  #clearLaserSweep() {
    const ls = this.laserSweep;
    if (!ls) return;
    this.fx?.stopAttached('bossLaserSweep');
    const grp = ls.beam?.group;
    if (grp) {
      this.scene.remove(grp);
      for (const m of grp.children) {
        m.geometry.dispose();
      }
      for (const mat of new Set(ls.beam.mats || [])) mat.dispose();
    }
    this.laserSweep = null;
  }

  #beginLaserSweep(skill, info) {
    const b = this.boss;
    if (!b) return;
    this.#clearLaserSweep();
    audio.play(bossSkillSfx('blood'));
    const dur = skill.duration || 2.6;
    const angle = Number.isFinite(info?.heading) ? info.heading : b.heading;
    const ls = {
      skill, t: 0, duration: dur, angle,
      spin: (Math.PI * 2 / dur) * (skill.spinDir || 1),
      beam: this.#makeLaserBeam(skill),
      reach: skill.reach || 88,
      halfW: (skill.beamWidth || 5) * 0.5,
      tick: 0,
    };
    this.laserSweep = ls;
    // 扫射期间 BOSS 定身：光束要贴着它转才读得出“这是它的攻击”
    this.bossStatus.root = Math.max(this.bossStatus.root || 0, dur + 0.2);
    this.#shakeCamera(0.6);
    // Effekseer 余烬刀光挂在 BOSS 身前，跟着激光角度一起转，当“血光源头”的亮部。
    // 不用 P2_BloodLance：那套素材的贴图上传会在部分显卡抛 texImage2D 异常，
    // 一抛就把整帧渲染打断（场上其它技能也跟着停摆）。
    this.fx?.playAttached('bossLaserSweep', 'fxEmberSlash', () => {
      const cur = this.laserSweep;
      const a = cur ? cur.angle : angle;
      return {
        x: b.pos.x + Math.sin(a) * 5,
        y: 2.6,
        z: b.pos.z + Math.cos(a) * 5,
      };
    }, {
      life: dur,
      scale: 3.0,
      loop: true,
      rot: () => ({ x: 0, y: this.laserSweep ? this.laserSweep.angle : angle, z: 0 }),
    });
    this.opts.onToast?.('🩸 血月激光！顺着光束的转向绕圈跑');
  }

  #updateLaserSweep(dt) {
    const ls = this.laserSweep;
    if (!ls) return;
    const b = this.boss;
    if (!b || b.dead) {
      this.#clearLaserSweep();
      return;
    }
    ls.t += dt;
    ls.angle += ls.spin * dt;
    if (ls.beam?.group) {
      ls.beam.group.position.set(b.pos.x, 0, b.pos.z);
      ls.beam.group.rotation.y = ls.angle;
    }
    if (ls.t >= ls.duration) {
      this.#clearLaserSweep();
      return;
    }
    if (!this.isHost) return;
    ls.tick -= dt;
    if (ls.tick > 0) return;
    ls.tick = ls.skill.tickInterval || 0.4;
    const hx = Math.sin(ls.angle);
    const hz = Math.cos(ls.angle);
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      const dx = p.boat.pos.x - b.pos.x;
      const dz = p.boat.pos.z - b.pos.z;
      const along = dx * hx + dz * hz;
      const lateral = Math.abs(dx * hz - dz * hx);
      const hull = Math.max(2.5, p.boat.def?.hull?.length || 4.5) * 0.46;
      if (along <= 2 || along >= ls.reach || lateral > ls.halfW + hull) continue;
      const dealt = this.#damagePlayer(p.id, ls.skill.damage * (this.boss?.damageScale || 1), {
        awayFrom: { x: b.pos.x, z: b.pos.z },
        source: skillSource(ls.skill),
        knockback: false,
      });
      if (dealt <= 0) continue;
      this.#spawnBurst(p.boat.pos.x, 1.6, p.boat.pos.z, SKILL_HIT_COLOR.blood, 1.1);
      this.fx?.play('fxMagicDark', p.boat.pos.x, 1.4, p.boat.pos.z, 0.45);
      hits.push({ id: p.id, dmg: dealt, src: skillSource(ls.skill) });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  // ---------- 难度递增 / 近身反制 ----------

  /** 每熬过 60 秒，技能冷却与小怪波间隔各 -5%（最多 -25%），后期自然变快 */
  #updatePressure() {
    const steps = Math.min(
      BOSS_PRESSURE.maxSteps,
      Math.floor(this.stageElapsed / BOSS_PRESSURE.stepTime),
    );
    if (steps <= this.pressureSteps) return;
    const add = steps - this.pressureSteps;
    this.pressureSteps = steps;
    const mul = Math.pow(BOSS_PRESSURE.stepScale, add);
    if (this.boss) {
      this.boss.cooldownScale = Math.max(BOSS_PRESSURE.minScale, this.boss.cooldownScale * mul);
    }
    this.summonIntervalScale = Math.max(BOSS_PRESSURE.minScale, this.summonIntervalScale * mul);
    this.opts.onToast?.(`⏳ 战况升温：BOSS 与小怪节奏加快（第 ${steps} 层）`);
  }

  /**
   * 近身反制：贴到 12m 以内会被尾流周期性掀开（推开 + 8 伤害 + 减速）。
   * 不是禁止贴脸，而是让“顶着 BOSS 站着不动”有成本，逼玩家绕背 / 拉一段再进。
   */
  #updateCloseCounter(dt) {
    const b = this.boss;
    if (!b || b.dead) return;
    const C = BOSS_CLOSE_PUNISH;
    for (const p of this.players.values()) {
      const prev = (this.closeCd.get(p.id) || 0) - dt;
      this.closeCd.set(p.id, Math.max(0, prev));
      if (!p.alive || p.invuln > 0) continue;
      const d = Math.hypot(p.boat.pos.x - b.pos.x, p.boat.pos.z - b.pos.z);
      if (d > C.range || prev > 0) continue;
      this.closeCd.set(p.id, C.cooldown);
      this.fx?.play('fxWaterImpact', p.boat.pos.x, 1.2, p.boat.pos.z, 1.1);
      this.skillFx.ringBurst('water', {
        x: p.boat.pos.x, z: p.boat.pos.z, radius: 4.5, count: 18, up: 3,
      });
      this.#shakeCamera(0.3);
      if (!this.isHost) continue;
      const dealt = this.#damagePlayer(p.id, C.damage * (this.boss?.damageScale || 1), {
        awayFrom: { x: b.pos.x, z: b.pos.z },
        source: '👹 近身反制',
      });
      this.#applySlow(p, C.slowSpeed, C.slowTime, '👹 被尾流掀开');
      if (dealt > 0) {
        this.net?.send({ t: 'bossHit', hits: [{ id: p.id, dmg: dealt, src: '👹 近身反制' }] });
      }
    }
  }

  // ---------- 第四关专属技能 ----------

  /**
   * 深渊吸取：持续 duration 秒，把范围内的船往 BOSS 嘴边拖。
   * 判定分两层：距离（半径内才被拉）和“驾驶输入”（油门/转向能顶住，氮气免疫）。
   * 伤害只在真被拖到嘴边时跳，不是一进范围就掉血 —— 这样“能反抗”才成立。
   */
  #beginPull(skill, info, authoritative) {
    const b = this.boss;
    if (!b) return;
    const dur = skill.duration || 2.8;
    this.pull = {
      skill, info, t: 0, duration: dur, tick: 0,
      originX: b.pos.x, originZ: b.pos.z,
      hitCd: new Map(),
    };
    // 漩涡粒子：范围外圈向内收，读起来就是“整片海往它嘴里塌”
    this.skillFx.vortex('blood', {
      x: b.pos.x, z: b.pos.z, radius: skill.radius || 64,
      height: Math.max(10, b.def.height || 7), duration: dur, rate: 210,
    });
    this.skillFx.ringBurst('blood', {
      x: b.pos.x, z: b.pos.z, radius: (skill.radius || 64) * 0.35, count: 54,
    });
    this.#shakeCamera(0.6);
    // 吸取期间 BOSS 定身：站桩吸人才吸得回来（root 由 bossStatus 每帧同步给 Boss）
    this.bossStatus.root = Math.max(this.bossStatus.root || 0, dur);
    if (authoritative) {
      this.opts.onToast?.('🩸 深渊吸取！油门顶住 / 开氮气无敌');
    }
  }

  #updatePull(dt) {
    const pull = this.pull;
    if (!pull) return;
    const b = this.boss;
    if (!b || b.dead) { this.pull = null; return; }
    pull.t += dt;
    const skill = pull.skill;
    const radius = skill.radius || 64;
    const power = skill.power || 13;
    // 谁在本地物理模拟：本机玩家的船永远由本机推；AI 船只有主机推
    const targets = [];
    const me = this.players.get(this.myId);
    if (me?.alive && this.localBoat) targets.push({ boat: this.localBoat, local: true });
    if (this.isHost) {
      for (const p of this.players.values()) {
        if (!p.alive || !p.ai || p.id === this.myId) continue;
        targets.push({ boat: p.boat, local: false });
      }
    }
    for (const t of targets) {
      const boat = t.boat;
      const dx = b.pos.x - boat.pos.x;
      const dz = b.pos.z - boat.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.001 || d > radius) continue;
      // 抵抗：踩油门 / 打方向 → 只吸得动 30%；氮气加速 → 完全免疫
      let resist = 1;
      if (boat.boostTimer > 0) resist = 0;
      else if (t.local) {
        const driving = Math.abs(this.input?.throttle || 0) > 0.15
          || Math.abs(this.input?.steer || 0) > 0.15;
        if (driving) resist = 0.3;
      } else {
        resist = 0.55; // AI 半抵抗，不然会被秒卷进嘴里
      }
      if (resist <= 0) continue;
      // 越靠近吸力越强（远端几乎拉不动，近处会被卷进去）
      const falloff = 0.35 + 0.65 * (1 - d / radius);
      const step = power * resist * falloff * dt;
      const nx = dx / d;
      const nz = dz / d;
      boat.pos.x += nx * step;
      boat.pos.z += nz * step;
      // 给一点切向旋转，读起来是“被卷”，不是“被绳子拽”
      const spin = step * 0.45;
      boat.pos.x += -nz * spin;
      boat.pos.z += nx * spin;
    }
    // 伤害：只对真被拖到嘴边的船结算，每 1.1 秒最多一次（主机权威）
    if (this.isHost) {
      for (const [id, left] of pull.hitCd) {
        if (left > 0) pull.hitCd.set(id, left - dt);
      }
      pull.tick += dt;
      if (pull.tick >= 1.1) {
        pull.tick = 0;
        const hits = [];
        for (const p of this.players.values()) {
          if (!p.alive || p.invuln > 0) continue;
          if ((pull.hitCd.get(p.id) || 0) > 0) continue;
          if (Math.hypot(p.boat.pos.x - b.pos.x, p.boat.pos.z - b.pos.z)
            > (b.def.radius || 5) + 6) continue;
          const dealt = this.#damagePlayer(p.id, skill.damage * this.boss.damageScale, {
            awayFrom: { x: b.pos.x, z: b.pos.z },
            source: skillSource(skill),
          });
          if (dealt <= 0) continue;
          pull.hitCd.set(p.id, 1.1);
          hits.push({ id: p.id, dmg: dealt, src: skillSource(skill) });
          this.#spawnBurst(p.boat.pos.x, 1.8, p.boat.pos.z, SKILL_HIT_COLOR.blood, 1.0);
        }
        if (hits.length) this.net?.send({ t: 'bossHit', hits });
      }
    }
    if (pull.t >= pull.duration + 0.1) this.pull = null;
  }

  /**
   * 裂海泉涌：先把玩家脚下的水柱炸起来（一次性伤害），
   * 再从 BOSS 脚下推出一圈扩散浪。浪经过船时，只有礁石挡在中间才安全。
   */
  #resolveGeyserSkill(skill, info) {
    const b = this.boss;
    // 第一段：玩家脚下升起的水柱
    this.skillFx.pillar('water', {
      x: info.x, z: info.z, radius: skill.radius || 7, height: 24, duration: 1.15,
    });
    this.skillFx.ringBurst('water', {
      x: info.x, z: info.z, radius: (skill.radius || 7) + 3, count: 46,
    });
    this.#shakeCamera(0.45);
    // 第二段：BOSS 脚下的扩散浪。判定半径直接读视觉对象的 radius，
    // 保证“看到的浪”和“判定的浪”永远是同一圈。
    const ox = Number.isFinite(info.ox) ? info.ox : b.pos.x;
    const oz = Number.isFinite(info.oz) ? info.oz : b.pos.z;
    this.skillFx.pillar('water', { x: ox, z: oz, radius: 5.5, height: 16, duration: 0.9 });
    // 海面浪墙：亮边 + 后面的半透明水带，读起来是有厚度的浪，而不是一根蓝线
    const fx = this.skillFx.shockwave('water', {
      x: ox, z: oz, speed: skill.waveSpeed || 11,
      maxRadius: this.arena.radius + 4, band: true,
    });
    this.geyserFx = fx;
    // 地面红色预警：由内向外一层层亮起，浪头到达前 1.7 秒开始变红
    this.#spawnGeyserWarn(ox, oz);
    this.geyserWave = { skill, x: ox, z: oz, t: 0, radius: 0, hit: new Set() };
    if (this.isHost) this.opts.onToast?.('🌊 裂海泉涌！躲到礁石后面挡水墙');
  }

  /** 裂海泉涌的地面预警：每 13m 一圈红环，逐圈亮起 */
  #spawnGeyserWarn(x, z) {
    this.#clearGeyserWarn();
    const step = 13;
    const maxR = (this.arena?.radius || 92) + 2;
    for (let r = step; r <= maxR; r += step) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(r - 1.1, r + 1.1, 96),
        new THREE.MeshBasicMaterial({
          color: 0xff3040, transparent: true, opacity: 0,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.62, z);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.geyserWarnRings.push({ mesh, r, passed: false, fade: 0, gone: false });
    }
  }

  #clearGeyserWarn() {
    for (const w of this.geyserWarnRings) {
      if (w.gone) continue;
      w.gone = true;
      this.scene.remove(w.mesh);
      w.mesh.geometry.dispose();
      w.mesh.material.dispose();
    }
    this.geyserWarnRings.length = 0;
  }

  /** 扩散浪逐帧判定：波前扫到船时查一次掩体，之后不再重复命中 */
  #updateGeyserWave(dt) {
    const gw = this.geyserWave;
    if (!gw) return;
    gw.t += dt;
    gw.radius = this.geyserFx?.radius ?? gw.radius;
    if (this.isHost) {
      const hits = [];
      for (const p of this.players.values()) {
        if (!p.alive || p.invuln > 0) continue;
        if (gw.hit.has(p.id)) continue;
        const d = Math.hypot(p.boat.pos.x - gw.x, p.boat.pos.z - gw.z);
        if (d > gw.radius) continue;
        gw.hit.add(p.id);
        // 礁石挡在 BOSS 与船之间 → 水墙被切断，这是“躲石头后面”的唯一解
        if (this.arena?.blocksLine?.(gw.x, gw.z, p.boat.pos.x, p.boat.pos.z, 0.7)) continue;
        const dealt = this.#damagePlayer(p.id, (gw.skill.waveDamage || 24) * this.boss.damageScale, {
          awayFrom: { x: gw.x, z: gw.z },
          source: skillSource(gw.skill),
        });
        if (dealt <= 0) continue;
        hits.push({ id: p.id, dmg: dealt, src: skillSource(gw.skill) });
        this.#spawnBurst(p.boat.pos.x, 1.8, p.boat.pos.z, SKILL_HIT_COLOR.water, 1.1);
      }
      if (hits.length) this.net?.send({ t: 'bossHit', hits });
    }
    // 红色预警逐层亮起：浪头还有 1.7 秒到达的那一层开始变红，浪过去后淡出
    const speed = gw.skill.waveSpeed || 11;
    const lead = speed * 1.7;
    for (const w of this.geyserWarnRings) {
      if (w.gone) continue;
      if (w.passed) {
        w.fade += dt / 0.45;
        w.mesh.material.opacity = Math.max(0, 0.65 * (1 - w.fade));
        if (w.fade >= 1) {
          w.gone = true;
          this.scene.remove(w.mesh);
          w.mesh.geometry.dispose();
          w.mesh.material.dispose();
        }
        continue;
      }
      if (gw.radius > w.r + 2.5) {
        w.passed = true;
        continue;
      }
      if (gw.radius < w.r - lead) continue;
      const k = Math.min(1, (gw.radius - (w.r - lead)) / Math.max(1, lead));
      const pulse = 0.75 + 0.25 * Math.sin(gw.t * 7 + w.r * 0.6);
      w.mesh.material.opacity = (0.18 + 0.5 * k) * pulse;
    }
    if (gw.radius >= this.arena.radius + 2) {
      this.geyserWave = null;
      this.#clearGeyserWarn();
    }
  }

  // ---------- 第二关：熔岩海啸 ----------
  // 一道 30m 宽的火墙贴着海面沿正前方推进。判定是「波前前后 3.5m、左右各半宽」的矩形带，
  // 每人每轮只吃一次；视觉用三渲火柱铺满整面墙、ef_fire03 当浪头、水花当浪脚。
  #resolveLavaWave(skill, info) {
    const b = this.boss;
    const heading = Number.isFinite(info?.heading) ? info.heading : (b?.heading || 0);
    const x = Number.isFinite(info?.x) ? info.x : (b?.pos.x || 0);
    const z = Number.isFinite(info?.z) ? info.z : (b?.pos.z || 0);
    this.lavaWave = {
      skill, x, z, heading,
      traveled: 0, nextRow: 10, hit: new Set(),
    };
    this.#spawnLavaWaveRow(this.lavaWave);
    this.#shakeCamera(0.45);
    if (this.isHost) this.opts.onToast?.('🔥 熔岩海啸！侧向跑出火墙通道');
  }

  /** 铺一排火柱（整面墙的视觉单位）：每前进 10m 补一排 */
  #spawnLavaWaveRow(w) {
    const skill = w.skill;
    const dx = Math.sin(w.heading);
    const dz = Math.cos(w.heading);
    // 墙的横向单位向量
    const px = Math.cos(w.heading);
    const pz = -Math.sin(w.heading);
    const cx = w.x + dx * w.traveled;
    const cz = w.z + dz * w.traveled;
    const half = Math.max(4, (skill.width || 30) * 0.5 - 4);
    // 4 根就够铺满 30m：柱子多了加色混合会糊成一片白
    for (let i = 0; i < 4; i++) {
      const k = (i / 3) * 2 - 1;
      const bx = cx + px * half * k;
      const bz = cz + pz * half * k;
      this.skillFx?.pillar('fire', {
        x: bx, z: bz, radius: 3.8, height: 9, duration: 0.9,
      });
      // 两端补水花：火墙是“从海里掀起来的”，浪脚必须有水
      if (i === 0 || i === 3) this.fx?.play('fxWaterImpact', bx, 1.2, bz, 0.9);
    }
    this.fx?.play('fxFireBand', cx, 2.6, cz, skill.fxScale ?? 1.8);
  }

  #updateLavaWave(dt) {
    const w = this.lavaWave;
    if (!w) return;
    const skill = w.skill;
    w.traveled += (skill.waveSpeed || 19) * dt;
    if (w.traveled >= w.nextRow) {
      w.nextRow = w.traveled + 10;
      this.#spawnLavaWaveRow(w);
    }
    if (this.isHost && this.boss) {
      const dx = Math.sin(w.heading);
      const dz = Math.cos(w.heading);
      const px = Math.cos(w.heading);
      const pz = -Math.sin(w.heading);
      const fx = w.x + dx * w.traveled;
      const fz = w.z + dz * w.traveled;
      const halfW = (skill.width || 30) * 0.5 + 2;
      const halfT = (skill.bandThickness || 7) * 0.5 + 2;
      const hits = [];
      for (const p of this.players.values()) {
        if (!p.alive || p.invuln > 0 || w.hit.has(p.id)) continue;
        const rx = p.boat.pos.x - fx;
        const rz = p.boat.pos.z - fz;
        // 横向（墙宽方向）与纵向（推进方向）分别在带内才算被拍中
        if (Math.abs(rx * px + rz * pz) > halfW) continue;
        if (Math.abs(rx * dx + rz * dz) > halfT) continue;
        w.hit.add(p.id);
        const dealt = this.#damagePlayer(p.id, skill.damage * this.boss.damageScale, {
          awayFrom: { x: fx, z: fz },
          source: skillSource(skill),
        });
        if (dealt <= 0) continue;
        hits.push({ id: p.id, dmg: dealt, src: skillSource(skill) });
        this.#spawnBurst(p.boat.pos.x, 1.8, p.boat.pos.z, SKILL_HIT_COLOR.fire, 1.2);
        this.fx?.play('fxWaterImpact', p.boat.pos.x, 1.5, p.boat.pos.z, 1.1);
      }
      if (hits.length) this.net?.send({ t: 'bossHit', hits });
    }
    // 推到 reach 末端就散掉
    if (w.traveled >= (skill.reach || 54)) this.lavaWave = null;
  }

  // ---------- 第四关：暗影缠触 ----------
  // 血魔点名的触手圈：持续 3.4 秒，每 0.6 秒把圈里的人缠一次（掉血 + 大幅减速）。
  // 视觉是 N_MagicDark 的血色触手，圈里每 0.75 秒另选一处再长一丛。
  #beginShadowZone(skill, info) {
    const x = Number.isFinite(info?.x) ? info.x : 0;
    const z = Number.isFinite(info?.z) ? info.z : 0;
    this.#endShadowZone();
    this.shadowZone = {
      skill, x, z, t: 0,
      duration: skill.duration || 3.4,
      nextTick: skill.tickInterval || 0.6,
      nextVisual: 0,
    };
    // 触手圈边缘留一圈暗红地标：预警结束后判定还在，玩家必须一直看得见范围
    const radius = skill.radius || 13;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(1, radius - 1.4), radius, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff2a4a, transparent: true, opacity: 0.45,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.35, z);
    this.scene.add(ring);
    this.shadowZone.ring = ring;
    this.fx?.play('fxMagicDark', x, 1.4, z, skill.fxScale ?? 0.85);
    this.#shakeCamera(0.35);
    if (this.isHost) this.opts.onToast?.('🩸 暗影缠触！跑出触手圈');
  }

  /** 收掉触手圈（换关/提前结束都要走这里，避免地标环留在场上） */
  #endShadowZone() {
    const zn = this.shadowZone;
    if (zn?.ring) {
      this.scene.remove(zn.ring);
      zn.ring.geometry.dispose();
      zn.ring.material.dispose();
    }
    this.shadowZone = null;
  }

  #updateShadowZone(dt) {
    const zn = this.shadowZone;
    if (!zn) return;
    const skill = zn.skill;
    zn.t += dt;
    if (zn.ring) zn.ring.material.opacity = 0.32 + Math.sin(zn.t * 7) * 0.16;
    if (zn.t >= zn.nextVisual) {
      zn.nextVisual = zn.t + 0.75;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * (skill.radius || 13) * 0.72;
      this.fx?.play(
        skill.fx?.[0] || 'fxMagicDark',
        zn.x + Math.cos(a) * r, 1.1, zn.z + Math.sin(a) * r,
        (skill.fxScale ?? 0.85) * 0.7,
      );
    }
    if (this.isHost && zn.t >= zn.nextTick) {
      zn.nextTick = zn.t + (skill.tickInterval || 0.6);
      this.#applySkillTick(skill, zn, 1, null);
    }
    if (zn.t >= zn.duration) this.#endShadowZone();
  }

  /**
   * 全屏大招「血幕降临」：
   * 多人（≥2 艘活着的赛艇）—— 任意两艘船物理接触，全场安全；
   * 只剩一艘 —— 改躲场地中央/背面的安全柱。
   * 都没做到就全体挨 40 点。
   */
  #resolveScreenSkill(skill, info) {
    const alive = [...this.players.values()].filter((p) => p.alive);
    let safe = false;
    let reason = '';
    if (alive.length >= 2) {
      // 任意两艘活着赛艇物理接触（船体支撑半径之和）→ 全场安全
      for (let i = 0; i < alive.length && !safe; i++) {
        for (let j = i + 1; j < alive.length; j++) {
          const a = alive[i].boat;
          const b = alive[j].boat;
          const need = boatContactDistance(a, b);
          if (Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) <= need) {
            safe = true;
            break;
          }
        }
      }
      reason = safe ? '🛡 赛艇贴靠，血幕被顶开！' : '';
    } else {
      const pillar = this.safePillar;
      if (pillar) {
        safe = alive.every((p) => Math.hypot(p.boat.pos.x - pillar.x, p.boat.pos.z - pillar.z)
          <= pillar.radius + 1.6);
        if (safe) reason = '🛡 安全柱挡住了血幕！';
      } else {
        // 蓄力期间队友阵亡、场上没来得及立柱子：这次算队友替你挡下了
        safe = true;
        reason = '🛡 队友的牺牲替你挡下了血幕';
      }
    }
    // 演出（主机和客机都放）：从 BOSS 向外炸一圈血浪 + 震屏
    const b = this.boss;
    const ox = b?.pos.x ?? 0;
    const oz = b?.pos.z ?? 0;
    this.skillFx.shockwave('blood', {
      x: ox, z: oz, speed: 150, maxRadius: this.arena.radius + 6,
    });
    this.skillFx.ringBurst('blood', {
      x: ox, z: oz, radius: this.arena.radius * 0.8, count: 120, up: 14,
    });
    this.#shakeCamera(1.4);
    this.hitStop = Math.max(this.hitStop, 0.1);
    this.#clearSafePillar();
    if (!this.isHost) return;
    this.opts.onToast?.(safe ? reason : '☠ 血幕吞没了整片海！下次贴住队友 / 站进安全柱');
    if (safe) return;
    const hits = [];
    for (const p of alive) {
      if (p.invuln > 0) continue;
      const dealt = this.#damagePlayer(p.id, skill.damage * this.boss.damageScale, {
        awayFrom: { x: ox, z: oz },
        source: skillSource(skill),
      });
      if (dealt > 0) hits.push({ id: p.id, dmg: dealt, src: skillSource(skill) });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  /** 瞬影突袭：旧位置留残影 → BOSS 瞬移到预警落点 → 面前横扫一刀 */
  #resolveBlinkSkill(skill, info) {
    const b = this.boss;
    if (!b) return;
    const h = Math.max(3, b.def.height || 7);
    // 元素跟着技能走：第四关血魔是血雾，第三关雷霆瞬影斩是雷光
    const v = skill.visual || 'blood';
    const fromX = b.pos.x;
    const fromZ = b.pos.z;
    // 起点残影 + 起跳雾气
    this.skillFx.residue(v, { x: fromX, z: fromZ, height: h * 0.9 });
    this.skillFx.ringBurst(v, { x: fromX, z: fromZ, radius: 7, count: 36 });
    // 瞬移：落到预警圈中心，朝向最近的目标（就是被锁定的那名玩家）
    b.pos.x = info.x;
    b.pos.z = info.z;
    const target = this.players.get(info.targetId);
    if (target?.alive) {
      b.heading = Math.atan2(
        target.boat.pos.x - b.pos.x,
        target.boat.pos.z - b.pos.z,
      );
    }
    this.skillFx.ringBurst(v, {
      x: b.pos.x, z: b.pos.z, radius: 9, count: 52, up: 10,
    });
    this.#shakeCamera(0.55);
    // 近战横扫：判定用 BOSS 落点 + 当前朝向的扇形
    const hitInfo = { x: b.pos.x, z: b.pos.z, heading: b.heading };
    this.#playSkillVisual(skill, { ...info, heading: b.heading }, 'hit');
    if (!this.isHost) return;
    const hits = this.#applySkillTick(skill, hitInfo, 1, null);
    if (hits.length) {
      this.opts.onToast?.(skill.id === 'blinkSlash'
        ? '⚡ 雷霆瞬影斩！被贴脸横扫'
        : '🗡 血魔贴脸横扫！');
    }
  }

  /**
   * 裂地雷锤：BOSS 已经跳到 info 落点，落地瞬间结算两段主伤害，
   * 再排一次 0.5 秒后的余波（逼玩家跑出红圈后继续往外冲）。
   * authoritative = false 时（客机）只放演出，绝不碰 #damagePlayer。
   */
  #resolveSlamSkill(skill, info, authoritative) {
    const b = this.boss;
    if (!b) return;
    const inner = skill.radius || 9;
    const outer = skill.outerRadius || 22;
    const h = Math.max(3, b.def.height || 7);
    // 落地：雷柱 + 两圈地裂粒子（内圈更密，外圈更散）
    this.fx?.play(skill.hitFx || 'fxBoltStorm', info.x, 3.0, info.z, skill.hitFxScale ?? 1.3);
    this.skillFx.bolt({ x: info.x, z: info.z, height: 30 });
    this.skillFx.ringBurst('thunder', { x: info.x, z: info.z, radius: outer, count: 70, up: 9 });
    this.skillFx.ringBurst('thunder', { x: info.x, z: info.z, radius: inner, count: 34, up: 15 });
    this.skillFx.pillar('thunder', {
      x: info.x, z: info.z, radius: inner * 0.55, height: h * 1.6, duration: 0.9,
    });
    this.#shakeCamera(1.15);
    this.hitStop = Math.max(this.hitStop, 0.07);
    if (authoritative) this.opts.onToast?.('⚡ 裂地雷锤！继续往外跑，余波还在扩散');
    // 余波：0.45 秒后扫第二圈，站在外圈边缘不动也会被补一刀
    this.delayedHits.push({
      kind: 'slamWave', skill, x: info.x, z: info.z, t: 0,
      delay: skill.waveDelay ?? 0.45, authoritative,
    });
    if (!authoritative) return;
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      const hull = Math.max(2.5, p.boat.def?.hull?.length || 4.5) * 0.46 + 0.12;
      const d = Math.hypot(p.boat.pos.x - info.x, p.boat.pos.z - info.z);
      let dmg = 0;
      // 中心 42 / 外圈 30：同一帧按距离只取一档，不叠加
      if (d <= inner + hull) dmg = skill.damage;
      else if (d <= outer + hull) dmg = skill.outerDamage ?? skill.damage * 0.7;
      if (dmg <= 0) continue;
      const dealt = this.#damagePlayer(p.id, dmg * this.boss.damageScale, {
        awayFrom: { x: info.x, z: info.z },
        source: skillSource(skill),
      });
      if (dealt > 0) hits.push({ id: p.id, dmg: dealt, src: skillSource(skill) });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  /**
   * 龙鳞骤雨：BOSS 腾空后把鳞片泼向整片区域。
   * 落点用「黄金角螺旋」确定性生成 —— 主机广播只带区域中心，客机用同一套算式
   * 复算出完全一致的散点，所以这套连打不需要额外同步消息。
   * 每片鳞按 spotDelay 依次落地（一次性事件走 delayedHits），而不是瞬间全屏扣血，
   * 这样玩家能看到“雨一片片砸下来”，也留出了反应/脱离的时间。
   */
  #resolveRainSkill(skill, info, authoritative) {
    const count = Math.max(6, skill.spotCount || 12);
    const area = skill.radius || 24;
    const x0 = Number.isFinite(info?.x) ? info.x : (this.boss?.pos.x ?? 0);
    const z0 = Number.isFinite(info?.z) ? info.z : (this.boss?.pos.z ?? 0);
    if (authoritative) this.rainHitCd.clear();
    // 整片区域的“天降火雨”演出 + 一圈外缘涟漪，让人一眼看出整块区域都在下
    this.fx?.play('fxScaleRain', x0, 7, z0, skill.fxScale ?? 2.0);
    this.skillFx.ringBurst('fire', { x: x0, z: z0, radius: area * 0.9, count: 34, up: 2 });
    this.#shakeCamera(0.35);
    const startDelay = skill.startDelay ?? 0.15;
    const spacing = skill.spotDelay ?? 0.085;
    for (let i = 0; i < count; i++) {
      const a = i * 2.399963;                        // 黄金角：散点不重叠也不留大空洞
      const r = area * Math.sqrt((i + 0.5) / count); // sqrt 分布 = 圆内均匀铺满
      this.delayedHits.push({
        kind: 'scaleHit',
        skill,
        x: x0 + Math.cos(a) * r,
        z: z0 + Math.sin(a) * r,
        t: 0,
        delay: startDelay + i * spacing,
        radius: skill.spotRadius || 4.2,
        authoritative,
      });
    }
  }

  /** 单片龙鳞落地：落点火阵 + 爆燃，主机再对半径内的船结算一次伤害 */
  #resolveScaleHit(d) {
    const skill = d.skill;
    const radius = d.radius || 4.2;
    this.fx?.play('fxFireRune', d.x, 0.35, d.z, Math.max(1.4, radius * 0.45));
    this.fx?.play('fxFireBurst', d.x, 1.2, d.z, 1.2);
    if (!d.authoritative) return;
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      // 同一轮骤雨里每个玩家 0.4 秒内只吃一次：落点密集，不然一次连中三四片直接沉船
      if ((this.rainHitCd.get(p.id) || 0) > 0) continue;
      const hull = Math.max(2.5, p.boat.def?.hull?.length || 4.5) * 0.46 + 0.12;
      if (Math.hypot(p.boat.pos.x - d.x, p.boat.pos.z - d.z) > radius + hull) continue;
      const dealt = this.#damagePlayer(
        p.id,
        skill.damage * this.boss.damageScale,
        { awayFrom: { x: d.x, z: d.z }, source: skillSource(skill) },
      );
      if (dealt <= 0) continue;
      this.rainHitCd.set(p.id, SKILL_HIT_CD);
      hits.push({ id: p.id, dmg: dealt, src: skillSource(skill) });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  #updateDelayedHits(dt) {
    // 多落点共享的命中冷却（龙鳞骤雨）
    if (this.rainHitCd.size) {
      for (const [id, t] of this.rainHitCd) {
        if (t - dt <= 0) this.rainHitCd.delete(id);
        else this.rainHitCd.set(id, t - dt);
      }
    }
    for (let i = this.delayedHits.length - 1; i >= 0; i--) {
      const d = this.delayedHits[i];
      d.t += dt;
      if (d.t < d.delay) continue;
      this.delayedHits.splice(i, 1);
      if (d.kind === 'slamWave') this.#resolveSlamWave(d);
      else if (d.kind === 'scaleHit') this.#resolveScaleHit(d);
      else if (d.kind === 'whaleBubble' && d.minion?.alive) this.#spawnBubbles(d.minion, d.targetId);
    }
  }

  /** 跳劈余波：从落点向外扩的一圈雷光，圈内再吃一段伤害 */
  #resolveSlamWave(d) {
    const skill = d.skill;
    const radius = skill.waveRadius || 30;
    this.skillFx.shockwave('thunder', {
      x: d.x, z: d.z, speed: Math.max(24, radius / 0.35), maxRadius: radius + 2,
    });
    this.skillFx.ringBurst('thunder', { x: d.x, z: d.z, radius, count: 44, up: 4 });
    this.fx?.play('fxArcBolt', d.x, 2.4, d.z, 2.2);
    if (!d.authoritative) return;
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      const hull = Math.max(2.5, p.boat.def?.hull?.length || 4.5) * 0.46 + 0.12;
      if (Math.hypot(p.boat.pos.x - d.x, p.boat.pos.z - d.z) > radius + hull) continue;
      const dealt = this.#damagePlayer(
        p.id,
        (skill.waveDamage ?? 18) * this.boss.damageScale,
        { awayFrom: { x: d.x, z: d.z }, source: skillSource(skill) },
      );
      if (dealt > 0) hits.push({ id: p.id, dmg: dealt, src: skillSource(skill) });
    }
    if (!hits.length) return;
    this.net?.send({ t: 'bossHit', hits });
    this.opts.onToast?.('⚡ 余波扫到！下一次记得跑出红圈再继续跑');
  }

  // ---------- 全屏大招的安全柱 ----------

  #spawnSafePillar(x, z, radius) {
    this.#clearSafePillar();
    const h = 46;
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x74e0ff, transparent: true, opacity: 0.4,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const geo = new THREE.CylinderGeometry(radius * 0.42, radius * 0.62, h, 24, 1, true);
    geo.translate(0, h / 2, 0);
    const column = new THREE.Mesh(geo, mat);
    group.add(column);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xbdf6ff, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const ringA = new THREE.Mesh(new THREE.RingGeometry(radius - 0.7, radius, 64), ringMat);
    ringA.rotation.x = -Math.PI / 2;
    ringA.position.y = 0.35;
    group.add(ringA);
    const ringB = new THREE.Mesh(new THREE.RingGeometry(radius * 0.36, radius * 0.46, 48), ringMat.clone());
    ringB.rotation.x = -Math.PI / 2;
    ringB.position.y = 1.1;
    group.add(ringB);
    this.scene.add(group);
    this.safePillar = { x, z, radius, group, mat, ringA, ringB, t: 0 };
  }

  #updateSafePillar(dt) {
    const p = this.safePillar;
    if (!p) return;
    p.t += dt;
    p.mat.opacity = 0.28 + Math.sin(p.t * 6) * 0.12;
    p.ringA.rotation.z += dt * 0.8;
    p.ringB.rotation.z -= dt * 1.6;
    p.group.position.y = Math.sin(p.t * 2.2) * 0.3;
    // 本地船站在柱内：每隔半秒补一圈护盾光，告诉玩家“这里安全”
    p.shieldT = (p.shieldT || 0) + dt;
    if (p.shieldT >= 0.5) {
      p.shieldT = 0;
      const me = this.players.get(this.myId);
      if (me?.alive
        && Math.hypot(me.boat.pos.x - p.x, me.boat.pos.z - p.z) <= p.radius + 1.6) {
        this.skillFx.ringBurst('ice', {
          x: me.boat.pos.x, z: me.boat.pos.z, radius: 4.2, count: 8, up: 2,
        });
      }
    }
  }

  #clearSafePillar() {
    const p = this.safePillar;
    this.safePillar = null;
    if (!p) return;
    this.scene.remove(p.group);
    p.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }


  /** 推进所有持续伤害窗口 */
  #updateHazards(dt) {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const hz = this.hazards[i];
      hz.t += dt;
      for (const [id, left] of hz.hitCd) {
        if (left > 0) hz.hitCd.set(id, left - dt);
      }
      while (hz.next <= hz.t) {
        hz.next += SKILL_DPS_INTERVAL;
        this.#applySkillTick(hz.skill, hz.info, SKILL_DPS_TICK, hz.hitCd);
      }
      if (hz.t >= SKILL_DPS_WINDOW) this.hazards.splice(i, 1);
    }
  }

  // ---------- 周期性落雷（第 2 关起，独立于 BOSS 自己的技能） ----------

  #thunderInterval() {
    // 海克斯抽到「静电场」时，第 1 关也开落雷
    if (this.ruleStage < BOSS_THUNDER.fromStage && !this.#hexHas('thunder')) return Infinity;
    return BOSS_THUNDER.interval[this.ruleStage] ?? 12;
  }

  /** 落点：离 BOSS 最远的活人（逼玩家不能一直挂在外圈）；都躺了就跳过这一发 */
  #farthestPlayer() {
    let best = null;
    let bd = -1;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.boat.pos.x - this.boss.pos.x, p.boat.pos.z - this.boss.pos.z);
      if (d > bd) { bd = d; best = p; }
    }
    return best;
  }

  #updateThunder(dt) {
    if (this.phase !== 'fight') return;
    if ((this.ruleStage >= BOSS_THUNDER.fromStage || this.#hexHas('thunder')) && this.isHost) {
      this.thunderT -= dt;
      if (this.thunderT <= 0) {
        this.thunderT = this.#thunderInterval();
        const target = this.#farthestPlayer();
        if (target) {
          this.#showThunderWarn(target.boat.pos.x, target.boat.pos.z);
          this.net?.send({ t: 'bossThunder', x: target.boat.pos.x, z: target.boat.pos.z });
        }
      }
    }
    const warn = this.thunderWarn;
    if (!warn) return;
    warn.t += dt;
    const k = Math.min(1, warn.t / warn.dur);
    warn.ring.material.opacity = 0.2 + k * 0.7;
    warn.ring.scale.setScalar(0.92 + k * 0.08);
    if (warn.t >= warn.dur) {
      const { x, z } = warn;
      this.#clearThunder();
      this.#strikeThunder(x, z);
    }
  }

  /** 地面红色预警圈：默认 1.6 秒后落雷（第三关拉长、第四关压缩到不足 1 秒） */
  #showThunderWarn(x, z) {
    this.#clearThunder();
    const r = BOSS_THUNDER.radius;
    const dur = Math.max(0.45, BOSS_THUNDER.telegraph * (this.boss?.telegraphScale || 1));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.86, r, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0.3,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.1, z);
    ring.frustumCulled = false;
    this.scene.add(ring);
    this.thunderWarn = { x, z, t: 0, dur, ring };
  }

  #clearThunder() {
    if (!this.thunderWarn) return;
    this.scene.remove(this.thunderWarn.ring);
    this.thunderWarn.ring.geometry.dispose();
    this.thunderWarn.ring.material.dispose();
    this.thunderWarn = null;
  }

  /** 落雷命中：范围伤害 + 限速。演出两端各放一遍，伤害/限速只由主机结算 */
  #strikeThunder(x, z) {
    // 从天而降的那一道（ef_lightning02），程序化 bolt 继续负责贴地的强光
    this.fx?.play('fxArcBolt', x, 6, z, 3.2);
    this.skillFx.bolt({ x, z, height: 30 });
    this.skillFx.ringBurst('thunder', { x, z, radius: BOSS_THUNDER.radius + 2, count: 44 });
    this.#shakeCamera(0.5);
    // 客机的预警圈走完倒计时也会到这里：只播落雷演出，
    // 伤害与限速等主机的 bossHit 下发，否则本机玩家会吃两份伤害。
    if (!this.isHost) return;
    const hits = [];
    for (const p of this.players.values()) {
      if (!p.alive || p.invuln > 0) continue;
      if (Math.hypot(p.boat.pos.x - x, p.boat.pos.z - z) > BOSS_THUNDER.radius) continue;
      const dealt = this.#damagePlayer(p.id, BOSS_THUNDER.damage * this.boss.damageScale, {
        awayFrom: { x, z },
        source: '⚡ 落雷',
      });
      // 护盾/无敌挡下来的命中不挂减速，和喷火/冲锋的判定口径保持一致
      if (dealt <= 0) continue;
      this.#applySlow(p, BOSS_THUNDER.slowSpeed, BOSS_THUNDER.slowTime);
      hits.push({ id: p.id, dmg: dealt, slow: BOSS_THUNDER.slowTime, src: '⚡ 落雷' });
    }
    if (hits.length) this.net?.send({ t: 'bossHit', hits });
  }

  /** 限速：本机直接压；别人的船由对方客户端收到广播后自己压 */
  #applySlow(p, speed, time, label = '⚡ 被雷击', opts = undefined) {
    if (!p || !p.boat) return;
    p.boat.speedCap = speed;
    p.boat.speedCapTimer = Math.max(p.boat.speedCapTimer || 0, time);
    if (p.id === this.myId) {
      this.opts.onToast?.(`${label}！最高速度限制为 ${speed} m/s，持续 ${time} 秒`, opts);
    }
  }

  // ---------- 追踪漩涡（第一关专属） ----------
  // 第一关只有喷火 + 尾扫两个技能，中间空窗太长。这里补一个满场追着人跑的龙卷，
  // 目标挑"对 BOSS 伤害最高"的那艘船：打得越猛越容易被咬，逼玩家边跑边打。
  // 判定由 host 统一做，客机只跟视觉（和落雷同一套口径）。

  #vortexEnabled() {
    return BOSS_VORTEX_CHASE.stages.includes(this.ruleStage) || this.#hexHas('vortex');
  }

  /** 对 BOSS 伤害最高的活人；全员 0 伤害（刚开局）时退化成列表里第一个活人 */
  #topDamagePlayer() {
    let best = null;
    let bestDmg = -1;
    let firstAlive = null;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (!firstAlive) firstAlive = p;
      const d = this.damageByPlayer.get(p.id) || 0;
      if (d > bestDmg) { bestDmg = d; best = p; }
    }
    return best || firstAlive;
  }

  #clearVortex() {
    this.fx?.stopAttached('bossVortex');
    this.fx?.stopAttached('bossVortexGround');
    this.vortex = null;
  }

  /** 起手：在目标船头前方亮一圈预警，随后龙卷从那里长出来 */
  #startVortexWarn() {
    const target = this.#topDamagePlayer();
    if (!target) { this.vortexT = BOSS_VORTEX_CHASE.interval; return; }
    const b = target.boat;
    const x = b.pos.x + Math.sin(b.heading) * BOSS_VORTEX_CHASE.spawnAhead;
    const z = b.pos.z + Math.cos(b.heading) * BOSS_VORTEX_CHASE.spawnAhead;
    const dur = Math.max(0.5, BOSS_VORTEX_CHASE.telegraph * (this.boss?.telegraphScale || 1));
    this.#clearVortex();

    this.vortex = {
      phase: 'warn', t: 0, warnDur: dur, x, z,
      targetId: target.id, dur: BOSS_VORTEX_CHASE.duration, tick: 0,
    };
    this.net?.send({
      t: 'bossVortex', x, z, targetId: target.id,
      dur: BOSS_VORTEX_CHASE.duration, warnDur: dur,
    });
  }

  #updateVortexChase(dt) {
    // 不在战斗阶段（结算/暂停/退出）就别留着龙卷在场上飘
    if (this.phase !== 'fight') {
      if (this.vortex) this.#clearVortex();
      return;
    }
    // host 负责招下一个；客机只跟着画
    if (this.isHost && this.#vortexEnabled() && !this.vortex) {
      this.vortexT -= dt;
      if (this.vortexT <= 0) this.#startVortexWarn();
    }
    const v = this.vortex;
    if (!v) return;
    v.t += dt;

    if (v.phase === 'warn') {
      if (v.t >= v.warnDur) {
        v.phase = 'live';
        v.t = 0;
        v.tick = 0;
        // 只保留龙卷本体：起手不再亮地面光圈，避免水面上多出一圈绿色光带
        const life = v.dur > 0 ? v.dur + 0.5 : 0;
        this.fx?.playAttached('bossVortex', 'fxUpdraft', () => ({
          x: v.x, y: BOSS_VORTEX_CHASE.offsetY ?? -1.5, z: v.z,
        }), {
          life, loop: true, scale: BOSS_VORTEX_CHASE.scale,
        });
        this.fx?.playAttached('bossVortexGround', 'fxBigVortex', () => ({ x: v.x, y: 0.4, z: v.z }), {
          life, loop: true, scale: BOSS_VORTEX_CHASE.groundScale,
        });
      }
      return;
    }

    // live：一路追目标（客机追本地看到的船位置，两边基本同步）
    let tgt = this.players.get(v.targetId);
    if (!tgt || !tgt.alive) {
      // 常驻模式会一直活着，目标阵亡就得转火，否则龙卷会停在原地发呆
      v.retryT = (v.retryT ?? 0) - dt;
      if (v.retryT <= 0) {
        v.retryT = BOSS_VORTEX_CHASE.retarget;
        const next = this.#topDamagePlayer();
        if (next) { v.targetId = next.id; tgt = next; }
      }
    }
    if (tgt && tgt.alive) {
      const dx = tgt.boat.pos.x - v.x;
      const dz = tgt.boat.pos.z - v.z;
      const d = Math.hypot(dx, dz) || 1;
      const step = Math.min(d, BOSS_VORTEX_CHASE.chaseSpeed * dt);
      v.x += (dx / d) * step;
      v.z += (dz / d) * step;
    }

    // 咬人：只由 host 结算，每 tickInterval 一次
    if (this.isHost) {
      v.tick -= dt;
      if (v.tick <= 0) {
        v.tick = BOSS_VORTEX_CHASE.tickInterval;
        const hits = [];
        for (const p of this.players.values()) {
          if (!p.alive || p.invuln > 0) continue;
          if (Math.hypot(p.boat.pos.x - v.x, p.boat.pos.z - v.z) > BOSS_VORTEX_CHASE.radius) continue;
          const dealt = this.#damagePlayer(
            p.id,
            BOSS_VORTEX_CHASE.damage * (this.boss?.damageScale || 1),
            { awayFrom: { x: v.x, z: v.z }, source: '🌀 追踪漩涡' },
          );
          if (dealt <= 0) continue;   // 护盾/无敌挡下时不吃减速，和落雷口径一致
          this.#applySlow(p, BOSS_VORTEX_CHASE.slowSpeed, BOSS_VORTEX_CHASE.slowTime, '🌀 被漩涡卷住', { variant: 'scroll' });
          hits.push({ id: p.id, dmg: dealt, slow: BOSS_VORTEX_CHASE.slowTime, slowSpeed: BOSS_VORTEX_CHASE.slowSpeed, label: '🌀 被漩涡卷住', src: '🌀 追踪漩涡' });
        }
        if (hits.length) this.net?.send({ t: 'bossHit', hits });
      }
    }

    // dur=0 是常驻模式，永远不结束
    if (v.dur > 0 && v.t >= v.dur) {
      this.#clearVortex();
      if (this.isHost) this.vortexT = BOSS_VORTEX_CHASE.interval;
    }
  }

  /**
   * 焚风灼膛：把炮膛烧红，sec 秒内按 J 打不出炮弹。
   * 主机结算技能时同时写本地玩家 + 通过 bossHit 的 lock 字段下发，
   * 客机自己收到后再调用一次，两端倒计时一致。
   */
  #lockWeapon(p, sec) {
    if (!p || sec <= 0) return;
    p.weaponLock = Math.max(p.weaponLock || 0, sec);
    if (p.id !== this.myId) return;
    this.weapons.cancelCharge();
    this.fx.play('explosion', p.boat.pos.x, 1.4, p.boat.pos.z, 0.9);
    this.opts.onToast?.(`🔥 炮膛灼烧！J 键封锁 ${Math.round(sec)} 秒，先走位躲开`);
  }

  // ---------- 随机血包 ----------

  /** 从道具箱散布点里挑，避开 BOSS 正面 20m（不然等于白送） */
  #healSpot() {
    const pool = ARENA_ITEM_SPOTS.filter((s) => Math.hypot(s.x, s.z) > 20);
    return pool[Math.floor(Math.random() * pool.length)] || { x: 30, z: 30 };
  }

  #makeHealPack(x, z) {
    const group = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 1.9, 1.9),
      new THREE.MeshStandardMaterial({
        color: 0x2fa864, roughness: 0.5, metalness: 0.2,
        emissive: 0x1f7a44, emissiveIntensity: 0.7,
      }),
    );
    group.add(box);
    // 白色十字：两片薄板，比贴图省事，任何分辨率都清楚
    const crossMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const bar1 = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.34), crossMat);
    const bar2 = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 1.15), crossMat);
    bar1.position.z = 0.97;
    bar2.position.z = 0.97;
    group.add(bar1, bar2);
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.7, 40),
      new THREE.MeshBasicMaterial({
        color: 0x6bffae, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -1.3;
    group.add(halo);
    group.position.set(x, 1.9, z);
    this.scene.add(group);
    return { x, z, group, halo, active: true, timer: 0, spin: Math.random() * 6 };
  }

  #buildHealPacks() {
    // 2026-11-14：开局不再摆满 3 个，改成由 #updateHealPacks 每 30 秒刷一个
    this.#clearHealPacks();
    this.healSpawnT = BOSS_HEAL_PACK.first;
  }

  #resetHealPacks() {
    this.#clearHealPacks();
    this.healSpawnT = BOSS_HEAL_PACK.first;
  }

  #spawnHealPack(x, z) {
    if (this.healPacks.length >= BOSS_HEAL_PACK.max) return null;
    const pk = this.#makeHealPack(x, z);
    this.healPacks.push(pk);
    this.fx.play('ring', x, 1.2, z, 1.6);
    return pk;
  }

  #removeHealPack(index) {
    const pk = this.healPacks[index];
    if (!pk) return;
    this.healPacks.splice(index, 1);
    this.scene.remove(pk.group);
    pk.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }

  #clearHealPacks() {
    for (const pk of this.healPacks) {
      this.scene.remove(pk.group);
      pk.group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
    }
    this.healPacks = [];
  }

  #updateHealPacks(dt) {
    const me = this.players.get(this.myId);
    // 刷新：只由主机摇点并广播。以前每台机器各自 Math.random() 选点，
    // 联机时两端看到的绿盒子根本不在同一个地方（走过去吃不到）。
    if (this.isHost) {
      this.healSpawnT -= dt;
      if (this.healSpawnT <= 0) {
        // 海克斯：抽到医疗补给 / 规则里的 healRate 会缩短刷新间隔
        const rate = (this.hexMods.healRate || 1) * (this.#hexHas('heal') ? 0.6 : 1);
        this.healSpawnT = BOSS_HEAL_PACK.interval * rate;
        if (this.healPacks.length < BOSS_HEAL_PACK.max) {
          const spot = this.#healSpot();
          if (this.#spawnHealPack(spot.x, spot.z)) {
            this.net?.send({ t: 'healSpawn', x: spot.x, z: spot.z });
            this.opts.onToast?.('💚 医疗包已在场上刷新');
          }
        }
      }
    }
    // 倒序遍历：吃掉一个就把自己从数组里摘掉，场上数量直接反映"还剩几个"
    for (let i = this.healPacks.length - 1; i >= 0; i--) {
      const pk = this.healPacks[i];
      pk.group.rotation.y += dt * 0.9;
      pk.group.position.y = 1.9 + Math.sin(this.stageElapsed * 1.6 + pk.spin) * 0.22;
      pk.halo.material.opacity = 0.35 + Math.sin(this.stageElapsed * 3 + pk.spin) * 0.15;
      if (!me || !me.alive) continue;
      if (Math.hypot(me.boat.pos.x - pk.x, me.boat.pos.z - pk.z) > BOSS_HEAL_PACK.pickupRadius) continue;
      // 自己吃：本地结算 + 广播让别人的场上也消失
      me.hp = Math.min(PLAYER_MAX_HP, me.hp + BOSS_HEAL_PACK.heal);
      this.#removeHealPack(i);
      this.fx.play('ring', pk.x, 1.2, pk.z, 2.4);
      this.opts.onToast?.('💚 拾取医疗包 +' + BOSS_HEAL_PACK.heal + ' HP');
      this.net?.send({ t: 'healPack', x: pk.x, z: pk.z, by: this.myId });
    }
  }

  // ---------- 火力核心（J 键强化道具，四关通用） ----------

  /**
   * 火力核心刷新点：必须落在玩家真正能走到的位置。
   * 第一阶段 constrainBoat 把玩家锁在「离 BOSS 14~52m」的环内，
   * 而 ARENA_ITEM_SPOTS 的 r=74 外环点在环外——玩家能看到光柱却永远吃不到。
   * 所以改成以 BOSS 当前位置为圆心的中环：8 个方向随机，半径 40m（在可活动环内），
   * 再夹一次场地边界，避免 BOSS 靠近边缘时把核心丢到墙外。
   */
  #coreSpot() {
    const r = Math.min(BOSS_LANE.far - 12, BOSS_FIRE_CORE.minRadius);
    const base = this.boss?.pos || { x: 0, z: 0 };
    const a = Math.floor(Math.random() * 8) * (Math.PI / 4);
    let x = base.x + Math.cos(a) * r;
    let z = base.z + Math.sin(a) * r;
    const limit = this.arena.radius - 10;
    const len = Math.hypot(x, z);
    if (len > limit) {
      x = x * limit / len;
      z = z * limit / len;
    }
    return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
  }

  #makeFireCore(x, z) {
    const group = new THREE.Group();
    // 金色八面体炉芯：一眼就能和蓝框问号道具箱区分开
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(1.25, 0),
      new THREE.MeshStandardMaterial({
        color: 0xffb02e, emissive: 0xff6a12, emissiveIntensity: 1.6,
        roughness: 0.32, metalness: 0.45,
      }),
    );
    // 内焰：加色混合的白热球，套在八面体里，看起来像烧红的炉芯
    const hot = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 12, 10),
      new THREE.MeshBasicMaterial({
        color: 0xfff0b8, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    // 水面熔金光环：远处也能看到刷新了什么
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(1.9, 2.9, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffc24a, transparent: true, opacity: 0.5,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -1.9;
    // 金色光柱：从水面直冲半空，隔着一整圈竞技场也能看见核心在哪
    // （之前只在原地转一个八面体，玩家跑到外圈根本找不到）
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 1.5, 34, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffc24a, transparent: true, opacity: 0.2,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.y = 34 * 0.5 - 2.1;
    const beamCore = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.4, 34, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff0b8, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beamCore.position.y = beam.position.y;
    group.add(core, hot, halo, beam, beamCore);
    group.position.set(x, 2.1, z);
    this.scene.add(group);

    // ---- 外圈升降铁钉：想吃核心，必须等铁圈落下去再穿过去 ----
    const S = BOSS_FIRE_CORE_SPIKES;
    const spikes = new THREE.Group();
    // 铁圈底座：一根横着的圆环，把铁钉串成一整圈
    const bar = new THREE.Mesh(
      new THREE.TorusGeometry(S.radius, 0.16, 8, 56),
      new THREE.MeshStandardMaterial({ color: 0x2c333d, roughness: 0.62, metalness: 0.82 }),
    );
    bar.rotation.x = Math.PI / 2;
    bar.position.y = 0.12;
    spikes.add(bar);
    // 钉尖：深铁色 + 一点暗红余温，和金色炉芯区分开
    const spikeMat = new THREE.MeshStandardMaterial({
      color: 0x3d4552, roughness: 0.5, metalness: 0.9,
      emissive: 0x7a2a08, emissiveIntensity: 0.16,
    });
    const coneGeo = new THREE.ConeGeometry(0.27, 1.7, 5);
    for (let i = 0; i < S.count; i++) {
      const a = (i / S.count) * Math.PI * 2;
      const spike = new THREE.Mesh(coneGeo, spikeMat);
      spike.position.set(Math.cos(a) * S.radius, 0.95, Math.sin(a) * S.radius);
      spike.rotation.y = a;
      spikes.add(spike);
    }
    // 危险提示环：升起时亮橙，落下时几乎不可见
    const dangerRim = new THREE.Mesh(
      new THREE.TorusGeometry(S.radius, 0.05, 6, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff5a18, transparent: true, opacity: 0.15,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    dangerRim.rotation.x = Math.PI / 2;
    dangerRim.position.y = 0.04;
    spikes.add(dangerRim);
    spikes.position.set(x, -S.sink, z);
    this.scene.add(spikes);

    return {
      x, z, group, core, halo, beam, beamCore,
      spikes, spikeMat, dangerRim, age: 0,
      life: BOSS_FIRE_CORE.life, spin: Math.random() * 6,
    };
  }

  #resetFireCores() {
    this.#clearFireCores();
    this.overloadT = 0;
    this.fireCoreT = BOSS_FIRE_CORE.first;
  }

  #clearFireCores() {
    for (const c of this.fireCores) {
      this.scene.remove(c.group);
      c.group.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
      if (c.spikes) {
        this.scene.remove(c.spikes);
        c.spikes.traverse((o) => {
          if (!o.isMesh) return;
          o.geometry?.dispose();
          o.material?.dispose?.();
        });
      }
    }
    this.fireCores = [];
  }

  /** 落点由主机决定并广播，避免客机各自刷在不同位置 */
  #spawnFireCore() {
    const spot = this.#coreSpot();
    this.fireCores.push(this.#makeFireCore(spot.x, spot.z));
    this.fireCoreT = 0;
    this.fx.play('ring', spot.x, 1.2, spot.z, 2.2);
    if (this.isHost) {
      this.net?.send({ t: 'fireCoreSpawn', x: spot.x, z: spot.z });
      this.opts.onToast?.('🔥 火力核心出现在中环（离 BOSS 约 40 米）！跟着金色光柱走，谁先吃到谁的 J 键齐射 ×3');
    }
  }

  #updateFireCores(dt) {
    if (this.overloadT > 0) this.overloadT = Math.max(0, this.overloadT - dt);
    // 1) 场上没有核心：倒数到点后由主机生成并广播
    if (!this.fireCores.length) {
      this.fireCoreT = Math.max(0, this.fireCoreT - dt);
      if (this.fireCoreT <= 0 && this.isHost) this.#spawnFireCore();
      return;
    }
    const c = this.fireCores[0];
    c.group.rotation.y += dt * 1.7;
    c.group.position.y = 2.1 + Math.sin(this.stageElapsed * 2.2 + c.spin) * 0.3;
    c.halo.material.opacity = 0.4 + Math.sin(this.stageElapsed * 4 + c.spin) * 0.18;
    // 光柱呼吸：亮度轻微起伏，远看像一根金柱在闪，而不是一根死板的圆柱
    if (c.beam) c.beam.material.opacity = 0.17 + Math.sin(this.stageElapsed * 3.1 + c.spin) * 0.06;
    if (c.beamCore) c.beamCore.material.opacity = 0.42 + Math.sin(this.stageElapsed * 5.2 + c.spin) * 0.16;

    // 外圈铁钉：升 0.4s → 保持 2s → 降 1.5s → 落底空窗 1.2s，每次刷新都从水下开始。
    c.age += dt;
    const S = BOSS_FIRE_CORE_SPIKES;
    const cycle = S.raise + S.hold + S.lower + S.bottom;
    const t = c.age % cycle;
    let k;
    if (t < S.raise) k = t / S.raise;
    else if (t < S.raise + S.hold) k = 1;
    else if (t < S.raise + S.hold + S.lower) k = 1 - (t - S.raise - S.hold) / S.lower;
    else k = 0;
    k = Math.max(0, Math.min(1, k));
    const ease = k * k * (3 - 2 * k);
    if (c.spikes) {
      c.spikes.position.y = -S.sink + ease * S.sink;
      c.spikes.visible = k > 0.01;
      c.spikeMat.emissiveIntensity = 0.16 + k * 0.85;
      c.dangerRim.material.opacity = 0.12 + k * 0.5;
    }
    // 铁钉升到判定高度后，圈上的船会被弹开并掉血（每个玩家 1.5s 冷却）
    if (k >= S.upThreshold) {
      for (const p of this.players.values()) {
        if (!p.alive || (p.spikeCd || 0) > 0) continue;
        const d = Math.hypot(p.boat.pos.x - c.x, p.boat.pos.z - c.z);
        if (Math.abs(d - S.radius) > S.hitBand) continue;
        const dealt = this.#damagePlayer(p.id, S.damage, {
          awayFrom: { x: c.x, z: c.z },
          source: '⛓ 火力核心铁钉圈',
        });
        if (dealt > 0) p.spikeCd = S.cooldown;
      }
    }
    // 2) 没人捡：悬停 20 秒后收回，等下一轮
    c.life -= dt;
    if (c.life <= 0) {
      this.#clearFireCores();
      this.fireCoreT = BOSS_FIRE_CORE.interval;
      return;
    }
    // 3) 本机船吃到：即时生效，不占 Q/E/1 道具槽
    const me = this.players.get(this.myId);
    if (!me?.alive) return;
    if (Math.hypot(me.boat.pos.x - c.x, me.boat.pos.z - c.z) > BOSS_FIRE_CORE.pickupRadius) return;
    this.overloadT = BOSS_FIRE_CORE.duration;
    // 金色圣光球 = “吃到了强化”，比原来的纯光环更像道具
    this.fx.play('fxBenediction', c.x, 1.6, c.z, 1.4);
    this.fx.play('ring', c.x, 1.2, c.z, 3.4);
    this.opts.onToast?.(
      `🔥 火力核心！J 键齐射 ×${BOSS_FIRE_CORE.shotMul}，`
      + `齐射总伤 ×${(BOSS_FIRE_CORE.shotMul * BOSS_FIRE_CORE.shotDamage).toFixed(1)}，`
      + `持续 ${BOSS_FIRE_CORE.duration} 秒`,
    );
    this.net?.send({ t: 'fireCore', x: c.x, z: c.z, by: this.myId });
    this.#clearFireCores();
    this.fireCoreT = BOSS_FIRE_CORE.interval;
  }

  // ---------- 第二关：符文安全圈（收缩火圈） ----------

  /**
   * 符文安全圈：只画“边界”，不铺满整块场地。
   *
   * 之前这里还把 M_Magic2Holy 的符文贴图铺成一张直径 ≈2.28r（开局约 190m）的
   * 平面盖住整个水面。那张贴图本身是带大量烟雾/光晕的粒子图，放大 190 倍后
   * 符文完全糊掉，只剩大片忽明忽暗的白色飘带（玩家反馈的“水面乱码”）。
   * 判定信息靠下面这条细边环 + 带符文的矮光墙已经足够，平面整块删掉。
   */
  #createSafeRingMesh() {
    if (this.safeRingMesh) return;
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x8ee6ff, transparent: true, opacity: 0.85,
      blending: THREE.NormalBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.985, 1.0, 160), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.36, 0);
    ring.frustumCulled = false;
    this.scene.add(ring);
    // 低机位追尾视角下，平铺贴图几乎被压成一条线，光靠它判断“圈在哪”不够。
    // 边界再加一道向上渐隐的青色光墙：墙上直接画一圈符文，圈的大小和收缩一眼可辨，
    // 远看也仍然是“符文阵”，而不是一条普通的水面亮线。
    const wallCanvas = document.createElement('canvas');
    wallCanvas.width = 512; wallCanvas.height = 64;
    const wc = wallCanvas.getContext('2d');
    const grad = wc.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, 'rgba(150,220,255,0)');
    grad.addColorStop(0.55, 'rgba(160,228,255,0.26)');
    grad.addColorStop(1, 'rgba(220,248,255,0.72)');
    wc.fillStyle = grad;
    wc.fillRect(0, 0, 512, 64);
    // 16 个符文一组，贴到圆柱上会沿圆周重复
    const glyphs = [
      [[0, -10, 0, 10], [-7, -3, 7, 3]],
      [[-7, -9, 0, 0], [0, 0, 7, -9], [0, 0, 0, 10]],
      [[0, -9, 0, 9], [-6, -9, 6, -9]],
      [[-7, 0, 0, -9], [0, -9, 7, 0], [-5, 6, 5, 6]],
      [[-6, -6, 6, 6], [6, -6, -6, 6]],
      [[0, -9, 0, 4], [-6, 4, 0, 9], [0, 9, 6, 4]],
    ];
    wc.strokeStyle = 'rgba(215,246,255,0.92)';
    wc.lineWidth = 2;
    wc.lineCap = 'round';
    for (let i = 0; i < 16; i++) {
      const cx = i * 32 + 16;
      const cy = 34;
      const g = glyphs[i % glyphs.length];
      for (const [x1, y1, x2, y2] of g) {
        wc.beginPath();
        wc.moveTo(cx + x1, cy + y1);
        wc.lineTo(cx + x2, cy + y2);
        wc.stroke();
      }
    }
    const wallTex = new THREE.CanvasTexture(wallCanvas);
    wallTex.colorSpace = THREE.SRGBColorSpace;
    wallTex.wrapS = THREE.RepeatWrapping;
    const wallMat = new THREE.MeshBasicMaterial({
      map: wallTex, color: 0x9fe6ff, transparent: true, opacity: 0.9,
      blending: THREE.NormalBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 96, 1, true), wallMat);
    wall.position.set(0, 1.9, 0);
    wall.frustumCulled = false;
    this.scene.add(wall);
    this.safeRingMesh = { ring, wall, ringMat, wallMat, wallTex, t: 0 };
  }

  #removeSafeRingMesh() {
    const m = this.safeRingMesh;
    if (!m) return;
    this.scene.remove(m.ring, m.wall);
    m.ring.geometry.dispose();
    m.wall.geometry.dispose();
    m.ringMat.dispose();
    m.wallMat.dispose();
    m.wallTex.dispose();
    this.safeRingMesh = null;
  }

  #resetCoreWave() {
    this.#clearCoreWave();
    this.#removeSafeRingMesh();
    this.weakT = 0;
    this.safeRing = null;
    this.coreWaveT = 0;
    if (!BOSS_SAFE_RING.stages.includes(this.ruleStage)) return;
    this.safeRing = { r: BOSS_SAFE_RING.startRadius };
    this.safeRingTick = 0;
    this.coreWaveT = BOSS_CORE_WAVE.firstDelay;
    this.#createSafeRingMesh();
  }

  // ---------- 第三关专属：电荷互斥 ----------

  #resetChargeLink() {
    this.chargePairs.clear();
    this.chargeToastT = 0;
    if (this.chargeLine) {
      this.chargeLine.line.visible = false;
      this.chargeLine.mat.opacity = 0;
    }
  }

  /**
   * 两船靠近会互相放电。
   * 只在第三关生效；单人也跑（陪练 AI 也算一方），所以单人练习同样能感到压力。
   * 代价是弹开 + 短暂失控而不是掉血——第三关玩家本身是临时无敌的，
   * 扣血在这里没有任何手感反馈。
   */
  #updateChargeLink(dt) {
    const C = BOSS_CHARGE;
    if (this.ruleStage !== C.stage) {
      if (this.chargePairs.size) this.chargePairs.clear();
      this.#fadeChargeLine(dt);
      return;
    }
    if (this.chargeToastT > 0) this.chargeToastT = Math.max(0, this.chargeToastT - dt);
    const list = [...this.players.values()].filter((p) => p.alive && p.boat);
    const seen = new Set();
    let link = null;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const d = Math.hypot(a.boat.pos.x - b.boat.pos.x, a.boat.pos.z - b.boat.pos.z);
        let st = this.chargePairs.get(key);
        if (d > C.minDist) {
          // 已经拉开了：蓄电清零，冷却继续走
          if (st) {
            st.hold = 0;
            st.cd = Math.max(0, st.cd - dt);
          }
          continue;
        }
        seen.add(key);
        if (!st) {
          st = { hold: 0, cd: 0 };
          this.chargePairs.set(key, st);
        }
        if (st.cd > 0) {
          st.cd = Math.max(0, st.cd - dt);
          continue;
        }
        st.hold += dt;
        // 画最近的那一对；蓄电中的每一对都可能在放电
        if (!link || d < link.d) link = { a, b, d, st };
        if (st.hold >= C.breakTime) {
          st.hold = 0;
          st.cd = C.cooldown;
          this.#zapApart(a, b, C);
        }
      }
    }
    for (const [key, st] of this.chargePairs) {
      if (seen.has(key)) continue;
      st.hold = 0;
      st.cd = Math.max(0, st.cd - dt);
      if (st.cd <= 0) this.chargePairs.delete(key);
    }
    if (link) this.#showChargeLine(link.a, link.b);
    else this.#fadeChargeLine(dt);
  }

  /** 放电：两船沿连线方向各被推开，并短暂失控 */
  #zapApart(a, b, C) {
    const dx = a.boat.pos.x - b.boat.pos.x;
    const dz = a.boat.pos.z - b.boat.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len;
    const nz = dz / len;
    for (const [p, sx, sz] of [[a, nx, nz], [b, -nx, -nz]]) {
      // 只推本地模拟的船：客机上的队友船是网络插值出来的，
      // 在这里加冲量只会和快照打架，下一帧就被覆盖回去。
      const local = p.id === this.myId || (p.ai && (this.isHost || this.solo));
      if (!local) continue;
      p.boat.vel.x += sx * C.push;
      p.boat.vel.y += sz * C.push;
      p.boat.stunTimer = Math.max(p.boat.stunTimer || 0, C.stun);
    }
    const mx = (a.boat.pos.x + b.boat.pos.x) / 2;
    const mz = (a.boat.pos.z + b.boat.pos.z) / 2;
    this.fx.play('fxArcBolt', mx, 2.4, mz, 2.2);
    if (a.id === this.myId || b.id === this.myId) {
      this.shake = Math.max(this.shake, 0.4);
      // 提示限流：贴身缠斗时会反复放电，不能每 1.8 秒糊一次屏
      if (this.chargeToastT <= 0) {
        this.chargeToastT = 12;
        this.opts.onToast?.('⚡ 电荷相斥！两船靠太近会互相放电，拉开距离');
      }
    }
  }

  #ensureChargeLine() {
    if (this.chargeLine) return this.chargeLine;
    const segs = 7;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 6), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xbfe4ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    line.visible = false;
    this.scene.add(line);
    this.chargeLine = { line, geo, mat, segs, fade: 0 };
    return this.chargeLine;
  }

  /** 两船之间那条抖动的折线电弧：每帧重随机，才有"噼啪跳电"的感觉 */
  #showChargeLine(a, b) {
    const L = this.#ensureChargeLine();
    const arr = L.geo.attributes.position.array;
    const n = L.segs + 1;
    const px = a.boat.pos.x;
    const pz = a.boat.pos.z;
    const dx = b.boat.pos.x - px;
    const dz = b.boat.pos.z - pz;
    const len = Math.hypot(dx, dz) || 1;
    // 水平法线：抖动只在这个方向上，电弧才会贴在两船之间而不是散开
    const nx = -dz / len;
    const nz = dx / len;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = i / L.segs;
      const amp = (Math.random() - 0.5) * 2.2 * Math.sin(Math.PI * t);
      pts.push([
        px + dx * t + nx * amp,
        2.0 + Math.random() * 1.6,
        pz + dz * t + nz * amp,
      ]);
    }
    for (let i = 0; i < L.segs; i++) {
      const o = i * 6;
      arr[o] = pts[i][0];
      arr[o + 1] = pts[i][1];
      arr[o + 2] = pts[i][2];
      arr[o + 3] = pts[i + 1][0];
      arr[o + 4] = pts[i + 1][1];
      arr[o + 5] = pts[i + 1][2];
    }
    L.geo.attributes.position.needsUpdate = true;
    L.line.visible = true;
    L.fade = 1;
    L.mat.opacity = 0.9;
  }

  #fadeChargeLine(dt) {
    const L = this.chargeLine;
    if (!L || !L.line.visible) return;
    L.fade = Math.max(0, L.fade - dt * 4);
    L.mat.opacity = L.fade * 0.9;
    if (L.fade <= 0) L.line.visible = false;
  }

  // ---------- 第四关专属：血祭祭坛 ----------

  #resetBloodAltar() {
    this.#clearBloodAltar();
    this.bloodAltarT = this.ruleStage === BOSS_BLOOD_ALTAR.stage ? BOSS_BLOOD_ALTAR.firstDelay : 0;
    this.bloodAltarFxT = 0;
  }

  #clearBloodAltar() {
    const a = this.bloodAltar;
    if (!a) return;
    this.scene.remove(a.group);
    a.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
    this.bloodAltar = null;
  }

  /**
   * 升起一座血祭祭坛。
   * x/z 传了就按给定坐标摆（客机收到主机的 bossAltarSpawn 时用），
   * 不传就由主机自己挑一个中环随机点。
   */
  #spawnBloodAltar(x = null, z = null, life = BOSS_BLOOD_ALTAR.life) {
    if (this.bloodAltar) return;
    const R = BOSS_BLOOD_ALTAR.radius;
    const spot = (x != null && z != null) ? { x, z } : this.#coreSpot();
    const group = new THREE.Group();
    // 血符文盘：复用安全圈那张符文阵贴图，染成暗红、加色混合
    const mat = new THREE.MeshBasicMaterial({
      map: runeTexture(), color: 0xff3246, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.2, R * 2.2), mat);
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.4;
    group.add(plate);
    // 判定边界：亮红细环，和献祭半径严格同尺寸
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff5a6a, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.985, R, 96), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.44;
    group.add(ring);
    // 引导进度环：scale 由 prog 驱动，涨满即献祭完成
    const progMat = new THREE.MeshBasicMaterial({
      color: 0xffd2d8, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const prog = new THREE.Mesh(new THREE.RingGeometry(R * 0.86, R * 0.97, 96), progMat);
    prog.rotation.x = -Math.PI / 2;
    prog.position.y = 0.46;
    prog.visible = false;
    group.add(prog);
    group.position.set(spot.x, 0, spot.z);
    this.scene.add(group);
    this.bloodAltar = {
      x: spot.x, z: spot.z, t: 0, life, prog: 0, done: false,
      group, plate, ring, progMesh: prog, mat, ringMat, progMat,
    };
    this.fx.play('fxMagicDark', spot.x, 1.4, spot.z, 1.6);
    this.opts.onToast?.(
      `🩸 血祭祭坛浮现：站进去引导 ${BOSS_BLOOD_ALTAR.channel.toFixed(1)} 秒，可重创血魔`,
    );
  }

  #updateBloodAltar(dt) {
    const A = BOSS_BLOOD_ALTAR;
    if (this.ruleStage !== A.stage) {
      if (this.bloodAltar) this.#clearBloodAltar();
      return;
    }
    const a = this.bloodAltar;
    // 没有祭坛时，只有主机负责挑点和倒计时；客机等 bossAltarSpawn
    if (!a) {
      if (!this.isHost) return;
      this.bloodAltarT -= dt;
      if (this.bloodAltarT <= 0) {
        this.bloodAltarT = A.interval;
        this.#spawnBloodAltar();
        this.net?.send({ t: 'bossAltarSpawn', x: this.bloodAltar.x, z: this.bloodAltar.z, life: A.life });
      }
      return;
    }
    a.t += dt;
    a.plate.rotation.z += dt * 0.35;
    a.ring.material.opacity = 0.55 + Math.sin(this.stageElapsed * 4) * 0.2;
    a.progMat.opacity = 0.5 + Math.sin(this.stageElapsed * 9) * 0.25;
    // 到点没人献祭：祭坛沉回海面
    if (a.t >= a.life) {
      this.#clearBloodAltar();
      if (this.isHost) this.bloodAltarT = A.interval;
      this.opts.onToast?.('🩸 血祭祭坛沉入海底');
      return;
    }
    const me = this.players.get(this.myId);
    if (!me || !me.alive) {
      a.prog = Math.max(0, a.prog - dt * A.decay);
      a.progMesh.visible = a.prog > 0;
      return;
    }
    const d = Math.hypot(me.boat.pos.x - a.x, me.boat.pos.z - a.z);
    if (d > A.radius) {
      // 开出去了：进度慢慢回落，不是直接清零
      a.prog = Math.max(0, a.prog - dt * A.decay);
      a.progMesh.visible = a.prog > 0.01;
      a.progMesh.scale.setScalar(Math.max(0.001, a.prog));
      return;
    }
    a.prog = Math.min(1, a.prog + dt / A.channel);
    a.progMesh.visible = true;
    a.progMesh.scale.setScalar(Math.max(0.001, a.prog));
    // 引导时祭坛里不断冒血雾
    this.bloodAltarFxT -= dt;
    if (this.bloodAltarFxT <= 0) {
      this.bloodAltarFxT = 0.85;
      const ang = Math.random() * Math.PI * 2;
      const rr = Math.random() * A.radius * 0.8;
      this.fx.play(
        'fxMagicDark',
        a.x + Math.cos(ang) * rr, 0.9, a.z + Math.sin(ang) * rr, 1.0,
      );
    }
    if (a.prog >= 1 && !this.boss?.airborne) this.#completeBloodAltar(me);
  }

  #completeBloodAltar(p) {
    const a = this.bloodAltar;
    if (!a || a.done) return;
    a.done = true;
    const dmg = Math.max(1, Math.round((this.boss?.maxHp || 1) * BOSS_BLOOD_ALTAR.damagePct));
    this.fx.play('fxMagicDark', a.x, 1.8, a.z, 2.4);
    this.fx.play('fxThunderRing', a.x, 0.6, a.z, 2.0);
    this.opts.onToast?.(`🩸 血祭完成！血魔受到 ${dmg} 点真实伤害`);
    this.#clearBloodAltar();
    // 主机结算 BOSS 血量并带上伤害值广播；客机只上报"谁完成的"，由主机补算
    if (this.isHost) {
      this.#dealBossDamage(dmg, { owner: p.id, pos: { x: a.x, z: a.z } });
      this.bloodAltarT = BOSS_BLOOD_ALTAR.interval;
      this.net?.send({ t: 'bossAltarDone', by: p.id, dmg });
    } else {
      this.net?.send({ t: 'bossAltarDone', by: p.id });
    }
  }

  #updateSafeRing(dt) {
    const ring = this.safeRing;
    if (!ring) return;
    const S = BOSS_SAFE_RING;
    ring.r = Math.max(S.minRadius, S.startRadius - (this.stageElapsed || 0) * S.shrinkSpeed);
    // 边界环 / 光墙跟着判定半径缩放（贴水符文大平面已删，原因见 #createSafeRingMesh）
    const fm = this.safeRingMesh;
    if (fm) {
      fm.t += dt;
      fm.ring.scale.set(ring.r, ring.r, 1);
      fm.wall.scale.set(ring.r, 3.6, ring.r);
      // 符文沿圆周的密度固定：每个贴图块约 19 米（16 个符文），圈缩小时符文跟着变密
      fm.wallTex.repeat.set(Math.max(1, (Math.PI * 2 * ring.r) / 19), 1);
      fm.ringMat.opacity = 0.75 + 0.2 * Math.sin(fm.t * 3.1);
      fm.wallMat.opacity = 0.8 + 0.18 * Math.sin(fm.t * 2.6);
      // 光墙缓慢绕圈，让符文阵保持“在转”的观感（原来靠大平面自转）
      fm.wall.rotation.y += dt * 0.12;
    }
    this.safeRingTick -= dt;
    if (this.safeRingTick > 0) return;
    this.safeRingTick = S.tick;
    const me = this.players.get(this.myId);
    if (!me?.alive) return;
    if (Math.hypot(me.boat.pos.x, me.boat.pos.z) <= ring.r) return;
    this.#damagePlayer(this.myId, S.outsideDps * S.tick, {
      knockback: false, source: '🔥 收缩火圈',
    });
    this.opts.onToast?.('🔥 已在安全圈外，立刻回到符文圈内！');
  }

  // ---------- 第二关：四枚能量核心（C 方案） ----------

  #clearCoreWave() {
    if (this.coreWave) {
      for (const c of this.coreWave.cores) this.fx?.stopAttached(`core${c.i}`);
    }
    this.coreWave = null;
  }

  #showCore(core) {
    // 特效异步加载，升起瞬间可能还没 load 完；已挂上的不要重复播放
    if (this.fx?.attached?.has(`core${core.i}`)) return;
    this.fx?.playAttached(`core${core.i}`, 'fxSpear1', () => ({ x: core.x, y: 2.6, z: core.z }), {
      loop: true,
      scale: () => 2.0,
    });
  }

  #spawnCoreWave() {
    const b = this.boss;
    if (!b) return;
    const cores = [];
    for (let i = 0; i < BOSS_CORE_WAVE.count; i++) {
      const a = (Math.PI * 2 / BOSS_CORE_WAVE.count) * i + (b.heading || 0);
      const x = b.pos.x + Math.sin(a) * BOSS_CORE_WAVE.ringRadius;
      const z = b.pos.z + Math.cos(a) * BOSS_CORE_WAVE.ringRadius;
      const core = { i, x, z, hp: BOSS_CORE_WAVE.hp, max: BOSS_CORE_WAVE.hp };
      cores.push(core);
      this.#showCore(core);
    }
    this.coreWave = { cores, left: BOSS_CORE_WAVE.window };
    this.net?.send({ t: 'bossCoreWave', cores: cores.map((c) => ({ i: c.i, x: c.x, z: c.z })) });
    this.opts.onToast?.(
      `🔶 能量核心升起！${BOSS_CORE_WAVE.window} 秒内打掉 ${BOSS_CORE_WAVE.count} 枚才出弱点窗口`,
    );
  }

  #coreAt(x, z) {
    const w = this.coreWave;
    if (!w) return null;
    for (const c of w.cores) {
      if (c.hp <= 0) continue;
      if (Math.hypot(x - c.x, z - c.z) <= BOSS_CORE_WAVE.coreRadius + 2.2) return c;
    }
    return null;
  }

  #damageCore(i, dmg) {
    const w = this.coreWave;
    if (!w) return;
    const core = w.cores.find((c) => c.i === i);
    if (!core || core.hp <= 0) return;
    core.hp = Math.max(0, core.hp - dmg);
    this.#spawnDamageText(dmg, core.x, 2.6, core.z, dmg >= 40);
    if (core.hp > 0) return;
    audio.play('weak_crit', { gap: 120 });
    this.fx?.stopAttached(`core${core.i}`);
    this.fx?.play('fxFireBall', core.x, 2.2, core.z, 1.6);
    if (!this.isHost) return;
    const left = w.cores.filter((c) => c.hp > 0).length;
    if (left === 0) this.#openWeakness();
    else this.opts.onToast?.(`🔶 核心击破，还剩 ${left} 枚`);
  }

  #openWeakness() {
    const W = BOSS_CORE_WAVE;
    this.weakT = W.weaknessTime;
    audio.play('cores_break');
    this.#clearCoreWave();
    this.coreWaveT = W.interval;
    this.fx?.play('fxMagic2Holy', this.boss.pos.x, 0.6, this.boss.pos.z, 3.4);
    this.opts.onToast?.(`💥 四核全破！弱点窗口 ${W.weaknessTime} 秒，BOSS 受伤 ×${W.weaknessMul}`);
    this.net?.send({ t: 'bossCoreWin', dur: W.weaknessTime });
  }

  #updateCoreWave(dt) {
    if (this.weakT > 0) this.weakT = Math.max(0, this.weakT - dt);
    const w = this.coreWave;
    if (!w) {
      if (this.isHost && this.ruleStage === BOSS_CORE_WAVE.stage && this.coreWaveT > 0) {
        this.coreWaveT = Math.max(0, this.coreWaveT - dt);
        if (this.coreWaveT <= 0) this.#spawnCoreWave();
      }
      return;
    }
    // 万一升起时素材还没加载完，每帧补挂一次（#showCore 内部会跳过已挂上的）
    for (const c of w.cores) if (c.hp > 0) this.#showCore(c);
    w.left -= dt;
    if (this.isHost && w.left <= 0) {
      this.#clearCoreWave();
      this.coreWaveT = BOSS_CORE_WAVE.interval;
      this.opts.onToast?.('⏱ 核心窗口结束但未全破——等下一轮升起');
      this.net?.send({ t: 'bossCoreWaveEnd' });
    }
  }

  #onPhaseChange(skill) {
    this.opts.onToast?.(`⚡ ${this.bossDef.name} 蓄力：${skill.name}！离开红圈`);
    this.#shakeCamera(0.6);
  }

  /**
   * 破韧触发：BOSS 跪地、头顶转星星、顶部 HUD 提示集火。
   * 只有前三关会走到这里（第四关没有 staggerMax，永远填不满槽）。
   */
  #onBossStagger() {
    const b = this.boss;
    if (!b || b.staggerTimer <= 0) return;
    audio.play('boss_stagger');
    const dur = b.staggerTimer;
    this.opts.onToast?.(`💫 ${this.bossDef.name} 破韧跪地！趁现在全力集火（${dur.toFixed(1)} 秒内伤害 ×${BOSS_STAGGER.damageMul}）`);
    this.skillFx.ringBurst('thunder', {
      x: b.pos.x, z: b.pos.z,
      radius: Math.max(16, (b.def.radius || 5) * 3.2), count: 96, up: 8,
    });
    this.#spawnBurst(b.pos.x, Math.max(3, (b.def.height || 6) * 0.7), b.pos.z, 0xffe08a, 2.2);
    this.fx.play('fxBoltStorm', b.pos.x, Math.max(3, (b.def.height || 6) * 0.85), b.pos.z, 1.1);
    this.#shakeCamera(0.75);
    this.hitStop = Math.max(this.hitStop, 0.06);
    if (this.isHost) this.net?.send({ t: 'bossStagger', dur });
  }

  /**
   * BOSS 技能特效：必须**从 BOSS 身体表面（嘴部/胸口）朝着目标喷出去**，
   * 而不是在它脚下原地炸一圈。喷吐/冲锋用带射程的粒子流，
   * 落点在“BOSS 正面 + 技能射程”处，正好是锁定玩家所在的方向。
   */
  #playSkillVisual(skill, info, when) {
    if (!skill || !this.skillFx || !this.boss) return;
    // 技能音效放在最前面：下面每个 kind 分支都有 early return，
    // 写在能通到的地方必然漏掉几种技能（表现为"有的技能没声音"）。
    // cast = 预警的短促高音（让玩家耳朵先知道该闪了），hit = 按元素落地。
    if (when === 'cast') audio.play('bossWarn', { gap: 300 });
    else audio.play(bossSkillSfx(skill.visual));
    const b = this.boss;
    const radius = b.def?.radius || 5;
    const h = Math.max(2.6, (b.def?.height || 7) * 0.62);
    // 只有第三关的雷龙是「冰霜 BOSS」：除落雷保留闪电外，技能都换成喷雪花。
    // 第四关血魔虽然也飘雪（fxTheme=ice），但它的喷火/喷血/水柱必须按技能自己的元素走。
    const frostBoss = b.def?.id === 'knight_thunder';
    let v = skill.visual || 'fire';
    // 第三关除落雷外都改成冰雪系，但新加的瞬影斩/跳劈已经声明 element:'thunder'，
    // 必须按自己的雷系走，否则“雷霆”技能会变成一团雪花
    if (frostBoss && skill.id !== 'thunder' && skill.element !== 'thunder') v = 'ice';
    const heading = info.heading ?? b.heading;
    const dx = Math.sin(heading);
    const dz = Math.cos(heading);
    // 嘴部：BOSS 正面边缘略靠内，技能从实体表面喷出
    const mx = b.pos.x + dx * radius * 0.78;
    const mz = b.pos.z + dz * radius * 0.78;
    // 全屏大招的预警不能被关卡的 telegraphScale 压短，单独取原始时长
    const tele = skill.kind === 'screen'
      ? Math.max(3.0, skill.telegraph || 0)
      : (skill.telegraph || 1.5) * (this.boss.telegraphScale || 1);

    if (when === 'cast') {
      const castDur = Math.max(0.5, tele * 0.7);
      if (skill.kind === 'screen') {
        // 血幕蓄力：BOSS 头顶聚起血云，单人模式把安全柱立起来
        this.skillFx.charge('blood', {
          x: b.pos.x, y: (b.def?.height || 7) * 1.1, z: b.pos.z,
          duration: Math.max(0.6, tele * 0.85), radius: radius * 2.4,
        });
        this.skillFx.ringBurst('blood', {
          x: b.pos.x, z: b.pos.z, radius: 6, count: 26, up: 10,
        });
        this.#maybeSpawnSafePillar(skill);
        return;
      }
      if (skill.kind === 'pull') {
        // 吸取蓄力：脚下一圈血漩涡 + 嘴前汇聚
        this.skillFx.vortex('blood', {
          x: b.pos.x, z: b.pos.z, radius: 18, height: 12, duration: Math.max(0.6, tele), rate: 120,
        });
        this.skillFx.charge('blood', {
          x: mx, y: h, z: mz, duration: Math.max(0.5, tele * 0.85), radius: radius * 1.4,
        });
        return;
      }
      if (skill.kind === 'blink') {
        // 瞬移落点先冒一团雾，提示“这里马上会有人出现”
        this.skillFx.ringBurst(v, {
          x: info.x, z: info.z, radius: 3, count: 10, up: 8,
        });
        return;
      }
      if (skill.kind === 'slam') {
        // 跳劈蓄力：落点下方雷光往上汇聚（玩家能看清“红圈中心就是砸点”）
        this.skillFx.charge('thunder', {
          x: info.x, y: 1.6, z: info.z,
          duration: Math.max(0.5, tele * 0.85),
          radius: (skill.outerRadius || 22) * 0.5,
        });
        return;
      }
      if (skill.kind === 'geyser') {
        // 水柱预警：落点先冒泡，蓄力读完再炸起来
        this.skillFx.charge('water', {
          x: info.x, y: 1.2, z: info.z,
          duration: Math.max(0.5, tele * 0.8), radius: (skill.radius || 7) * 0.9,
        });
        return;
      }
      if (skill.kind === 'rift') {
        // 裂隙喷发：红圈里先翻涌水花，三根水柱的位置能提前看出来
        this.skillFx.charge('water', {
          x: info.x, y: 1.2, z: info.z,
          duration: Math.max(0.5, tele * 0.85), radius: (skill.radius || 16) * 0.72,
        });
        this.skillFx.ringBurst('water', { x: info.x, z: info.z, radius: 5, count: 18, up: 3 });
        return;
      }
      if (skill.kind === 'gate') {
        // 召唤门：BOSS 脚下先烧起一圈法阵，门在结算时才真正立起来
        this.skillFx.charge('fire', {
          x: b.pos.x, y: 1.4, z: b.pos.z,
          duration: Math.max(0.6, tele * 0.8), radius: radius * 2.2,
        });
        this.skillFx.ringBurst('fire', { x: b.pos.x, z: b.pos.z, radius: 10, count: 30, up: 5 });
        return;
      }
      if (skill.kind === 'grid') {
        // 雷霆棋盘蓄力：BOSS 举剑，身周先炸一圈雷环做“开场重音”
        this.skillFx.charge('thunder', {
          x: b.pos.x, y: h, z: b.pos.z,
          duration: Math.max(0.6, tele * 0.8), radius: radius * 2.4,
        });
        this.skillFx.ringBurst('thunder', { x: b.pos.x, z: b.pos.z, radius: 14, count: 40, up: 9 });
        return;
      }
      if (skill.kind === 'laser') {
        // 血月激光蓄力：掌心聚血光，海面先亮一条“待发射”的暗红光带
        this.skillFx.charge('blood', {
          x: mx, y: h, z: mz,
          duration: Math.max(0.6, tele * 0.85), radius: radius * 1.5,
        });
        return;
      }
      if (skill.kind === 'wave') {
        // 海啸蓄力：BOSS 身前海面先亮起一片火星，提示“火墙要从这里推出去”
        this.skillFx.charge(v, {
          x: mx, y: 1.2, z: mz,
          duration: Math.max(0.6, tele * 0.85), radius: radius * 1.8,
        });
        this.skillFx.ringBurst('water', { x: b.pos.x, z: b.pos.z, radius: 6, count: 24, up: 4 });
        return;
      }
      if (skill.kind === 'zone') {
        // 暗影缠触蓄力：目标脚下一圈红雾聚起来，说明“这个圈马上长触手”
        this.skillFx.charge('blood', {
          x: info.x, y: 1.0, z: info.z,
          duration: Math.max(0.5, tele * 0.85), radius: (skill.radius || 13) * 0.75,
        });
        return;
      }
      // 蓄力：粒子朝嘴部汇聚，玩家能提前看出“要喷哪一元素”
      this.skillFx.charge(v, {
        x: mx, y: h, z: mz,
        duration: Math.max(0.5, tele * 0.85),
        radius: radius * 1.1,
      });
      if (v === 'fire') {
        this.skillFx.cone('fire', {
          x: mx, y: h, z: mz, dx, dz,
          angle: 44, range: radius * 1.7, duration: castDur,
        });
      } else if (v === 'ice') {
        // 冰霜 BOSS 开招先朝玩家方向喷一团雪花，和常驻的飘雪一起形成“雪龙”观感
        this.skillFx.cone('ice', {
          x: mx, y: h, z: mz, dx, dz,
          angle: 34, range: radius * 2.4, duration: castDur,
        });
      }
      return;
    }

    // 裂隙 / 召唤门的落地演出在各自的结算里已经把水柱、门和怪摆好了，
    // 这里只保留音效，不再补一圈多余的环爆。
    if (skill.kind === 'rift' || skill.kind === 'gate') return;

    if (skill.kind === 'cone' || skill.kind === 'path') {
      // 喷吐 / 冲锋：从嘴部沿朝向喷到射程末端（判定窗口 0.95 秒，特效同样持续）
      const reach = skill.kind === 'path' ? 34 : (skill.range || 24);
      // particleFx: false 的技能完全不吃程序化粒子（第三关扇形劈砍就是这种），
      // 观感只留 Effekseer 的刀光，不再叠一层雷雾。
      if (skill.particleFx !== false) {
        this.skillFx.cone(v, {
          x: mx, y: h, z: mz, dx, dz,
          angle: skill.kind === 'path' ? 24 : (skill.angle || 55),
          range: reach, duration: 0.95,
        });
        // 射程末端的爆点，让“喷到船附近”这件事有个落点
        this.skillFx.ringBurst(v, {
          x: b.pos.x + dx * reach,
          z: b.pos.z + dz * reach,
          radius: 6.5, count: 26, up: 5,
        });
        // 冰霜 BOSS：射程末端再炸一团雪雾，喷雪花的效果更明显
        if (v === 'ice') {
          this.skillFx.frost({ x: b.pos.x + dx * reach, z: b.pos.z + dz * reach, radius: 9 });
        }
      }
      // 扇形劈砍的巨型刀光：从嘴部沿朝向甩出去。
      // 必须用 playAttached 钉在世界坐标——BOSS 结算后会立刻追击，
      // 直接 play 的实体特效会被下一帧的 BOSS 位移带着走，刀光就"贴"在身上了。
      // 如果刀光劈向身后，把 rot 的 y 改成 heading + Math.PI 即可。
      if (skill.swingFx) {
        const sfx = skill.swingFx;
        this.fx?.playAttached(
          'skillSwingFx',
          sfx.fx,
          () => ({ x: mx, y: h * 0.85, z: mz }),
          {
            life: sfx.life ?? 1.6,
            scale: sfx.scale ?? 1.5,
            rot: () => ({ x: 0, y: heading, z: 0 }),
          },
        );
      }
    } else if (skill.kind === 'blink') {
      // 瞬移后的近战横扫：落点处甩出一道刀风（元素按技能走）
      this.skillFx.cone(v, {
        x: mx, y: h, z: mz, dx, dz,
        angle: skill.angle || 130, range: (skill.radius || 10) * 0.9, duration: 0.5,
      });
      this.skillFx.ringBurst(v, {
        x: b.pos.x + dx * 4, z: b.pos.z + dz * 4, radius: 5, count: 22, up: 8,
      });
    } else if (skill.kind === 'ring') {
      // 尾扫：从 BOSS 自身向外扩散的一圈
      this.skillFx.ringBurst(v === 'fire' ? 'water' : v, {
        x: b.pos.x, z: b.pos.z, radius: skill.radius || 18,
      });
    } else if (skill.kind === 'wave') {
      // 墙体的火柱由 #spawnLavaWaveRow 逐排铺开，这里只补一圈起浪的水花
      this.skillFx.ringBurst('water', { x: b.pos.x, z: b.pos.z, radius: 8, count: 30, up: 4 });
    } else if (skill.kind === 'zone') {
      // 触手从落点中心炸开一圈血雾（范围地标环由 #beginShadowZone 自己挂）
      this.skillFx.ringBurst(v, { x: info.x, z: info.z, radius: 3.5, count: 20, up: 3.5 });
    } else {
      // ground：落点在玩家身上（俯冲/落雷/阶段大招）
      // 落雷额外补一道"从天上劈下来"的 ef_lightning02（程序化 bolt 只画主闪，缺高度感）
      if (skill.skyFx) {
        this.fx?.play(skill.skyFx, info.x, skill.skyFxY ?? 8, info.z, skill.skyFxScale ?? 2.8);
      }
      if (v === 'thunder' || skill.id === 'phaseBlast') {
        this.skillFx.bolt({ x: info.x, z: info.z, height: 30 });
      }
      if (v === 'ice') this.skillFx.frost({ x: info.x, z: info.z, radius: skill.radius || 16 });
      this.skillFx.ringBurst(v, {
        x: info.x, z: info.z, radius: skill.radius || 12,
        // 崩海咆哮主体交给 effekseer 的 7 道火带，三渲这圈粒子从 90 降到 45，
        // 否则 30m 的粒子环会把火带整个盖住（实测结算画面只剩一片黄光）
        count: skill.id === 'phaseBlast' ? 45 : 52,
      });
    }
  }

  /**
   * 全屏大招的安全柱：只在“场上只剩一艘赛艇”时立起来。
   * 位置是竞技场中央；BOSS 正好压在中央时挪到背面 30m，避免安全区变成送死区。
   */
  #maybeSpawnSafePillar(skill) {
    if (!this.isHost) return;
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (alive.length > 1) return; // 多人靠两船贴靠，不放柱子
    let x = 0;
    let z = 0;
    const b = this.boss;
    if (b && Math.hypot(b.pos.x, b.pos.z) < 20) {
      const a = Math.atan2(b.pos.z, b.pos.x) + Math.PI;
      x = Math.cos(a) * 30;
      z = Math.sin(a) * 30;
    }
    this.#spawnSafePillar(x, z, skill.safeRadius || 6.2);
    this.opts.onToast?.('🛡 安全柱已升起！站进光柱里躲全屏血幕');
    this.net?.send({ t: 'bossPillar', x, z, r: skill.safeRadius || 6.2 });
  }

  #onBossDeath() {
    if (this.phase !== 'fight') return;
    this.stageClearGrade = gradeStage(
      this.stageElapsed, this.players.get(this.myId)?.revives ?? 0,
      BOSS_REVIVES, BOSS_LEVELS.length, this.stage,
    );
    this.stageResults.push({
      stage: this.stage,
      name: this.level.name,
      elapsed: this.stageElapsed,
      grade: this.stageClearGrade,
    });
    this.phase = 'clear';
    audio.play('boss_death');
    // 死亡演出播完（BOSS_PORTAL.delay）再升起传送门，不再 4.2 秒自动跳关
    this.clearT = BOSS_PORTAL.delay;
    // 收掉还没落地/还没消失的场地危险物，避免结算面板后面还挂着红圈和熔岩柱
    this.#clearThunder();
    this.#clearBloodAltar();
    this.#resetChargeLink();
    // 棋盘雷 / 旋转激光 / 待刷新的召唤门：BOSS 倒下后必须立刻收掉，
    // 否则结算面板背后还会有一张棋盘或一道还在转的光束
    this.#clearGridThunder();
    this.#clearLaserSweep();
    this.#clearGateVisuals();
    this.gateQueue.length = 0;
    this.hazards.length = 0;
    this.delayedHits.length = 0;
    this.weapons.clear();
    // BOSS 倒下：召唤物直接清场。clear 阶段小怪 AI 不再更新，留在场上只会僵在原地
    this.#clearMinions();
    // 死亡演出：白色大爆裂 + 碎片（体量按关卡递增，终章最大）
    this.fx.play('fxBossDeath', this.boss.pos.x, 3.4, this.boss.pos.z, 1.2 + this.stage * 0.16);
    this.fx.play('explosion', this.boss.pos.x, 2.4, this.boss.pos.z);
    this.opts.onStageResult?.({
      stage: this.stage,
      total: this.runStageCount,
      name: this.level.name,
      grade: this.stageClearGrade,
      elapsed: this.stageElapsed,
      damage: [...this.damageByPlayer.entries()].map(([id, dmg]) => ({
        id, name: this.order.find((e) => e.id === id)?.name || id, dmg,
        me: id === this.myId,
      })),
      // 承伤排名：这一关每个人挨了多少（含 AI），以及全队按来源汇总的挨打明细
      taken: [...this.players.values()].map((p) => ({
        id: p.id,
        name: this.order.find((e) => e.id === p.id)?.name || p.id,
        taken: Math.round(p.taken || 0),
        me: p.id === this.myId,
      })),
      takenBy: this.#takenTotals(),
    });
    if (this.isHost) this.net?.send({ t: 'bossState', stage: this.stage, phase: 'clear', hp: 0, dead: true });
    // 海克斯：通关后弹三选一（最后一关打完直接进结算，不再发卡）
    this.#offerHexCards();
  }

  #advanceStage() {
    // 海克斯无尽：打完当前计划的最后一层先问「继续 / 领奖」，不直接终局
    if (this.variant === 'hex' && this.stage >= this.runStageCount) {
      this.#openEndless();
      return;
    }
    if (this.stage >= BOSS_LEVELS.length) {
      this.#finishVictory();
      return;
    }
    this.startStage(this.stage + 1, { broadcast: true });
  }

  /** 第 4 层通关后弹出无尽选择：房主/单人可点，客机只读等待 */
  #openEndless() {
    if (this.phase === 'endless') return;
    this.phase = 'endless';
    this.opts.onStageResult?.(null);
    // 通关三选一还开着：等玩家选完卡再弹，不要替玩家决定（选完/超时后 #updateHex 会补弹）
    if (this.hexCardOffer) {
      this.endlessPending = true;
      return;
    }
    this.#showEndlessPanel();
  }

  #showEndlessPanel() {
    this.endlessPending = false;
    this.opts.onHexEndless?.({
      stage: this.stage,
      nextStage: this.stage + 1,
      allowPick: !!(this.isHost || this.solo),
    });
    this.opts.onToast?.(this.isHost || this.solo
      ? '🌀 已通过当前最高层：继续挑战还是结束领奖？'
      : '🌀 等待房主选择：继续挑战 / 结束领奖');
  }

  /**
   * UI 回调：无尽「继续挑战 / 结束领奖」。
   * 联机只认房主；续层时按同一 seed 延长计划并广播，客机随之进入同一层。
   */
  chooseEndless(cont) {
    if (this.phase !== 'endless') return;
    if (!this.isHost && !this.solo) return;
    this.endlessPending = false;
    this.opts.onHexEndless?.(null);
    if (cont) {
      const next = this.stage + 1;
      if (this.hexPlan && next > this.hexPlan.stages.length) {
        this.hexPlan = buildRunPlan(this.hexPlan.seed, next);
      }
      this.startStage(next, { broadcast: true });
    } else {
      this.#finishVictory();
    }
  }

  /** 终局面板：汇总评分、下发客机结算数据 */
  #finishVictory() {
    this.phase = 'victory';
    const total = this.stageResults.reduce((s, r) => s + r.elapsed, 0);
    const best = this.stageResults.reduce((bestG, r) => {
      const rank = { S: 4, A: 3, B: 2, C: 1 };
      return rank[r.grade] > rank[bestG] ? r.grade : bestG;
    }, 'C');
    const data = this.#resultData(true);
    data.grade = best;
    // 无尽层数：结算页显示“通过到第 N 层”（普通 4 层通关就是 4）
    if (this.variant === 'hex') data.endlessStage = this.stage;
    // 终局面板会盖住关卡评分卡：这里主动收起，避免“打完 BOSS 一直停在评分界面”
    this.opts.onStageResult?.(null);
    this.opts.onVictory?.(data);
    if (this.isHost) {
      // 输出/承伤统计也随终局消息下发，客机结算面板才有完整排名
      this.net?.send({
        t: 'bossEnd', victory: true, totalTime: total, grade: best,
        damage: data.damage, taken: data.taken, takenBy: data.takenBy,
        endlessStage: data.endlessStage,
      });
    }
  }

  // ---------- 过关传送门（第一~三关） ----------
  /**
   * BOSS 死亡演出结束后升起传送门。位置由主机抽签，客机等 bossPortal 消息再摆，
   * 否则两端会各刷一个位置、玩家看到的门和判定用的门不是同一个。
   * 注意 clear 计时是每个客户端自己推的：客机先到点时没有坐标，只切到 portal
   * 等消息，但**必须先把本地的过关评分卡收掉**，否则会一直停在结算页。
   */
  #openPortal(pos = null) {
    this.phase = 'portal';
    this.opts.onStageResult?.(null);
    if (!this.isHost && !pos) return;
    const spot = pos || this.#portalSpot();
    // 主机每 1.5s 会重发一次坐标：门已经在同一位置就不要再 spawn，
    // 否则会清空 ready 集合，玩家站着不动也要反复“重新进入”。
    if (this.portal && Math.hypot(spot.x - this.portal.x, spot.z - this.portal.z) < 0.5) return;
    this.#spawnPortal(spot.x, spot.z);
    if (this.isHost) this.net?.send({ t: 'bossPortal', x: spot.x, z: spot.z });
    this.opts.onToast?.('🌀 传送门已开启：所有玩家进入后前往下一关');
  }

  /** 场地圈内的随机落点，避开 BOSS 尸体与浮岩（门是竖着的，贴着岩石会被切掉半张脸） */
  #portalSpot() {
    const R = Math.max(24, this.arena?.radius || 92);
    const bx = this.boss?.pos.x ?? 0;
    const bz = this.boss?.pos.z ?? 0;
    const rocks = this.arena?.rocks || [];
    const clearOfRocks = (x, z) => {
      for (const r of rocks) {
        if (Math.hypot(x - r.x, z - r.z) < r.r + BOSS_PORTAL.doorRadius + 4) return false;
      }
      return true;
    };
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = R * (0.24 + Math.random() * 0.34);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x - bx, z - bz) < 26) continue;
      if (!clearOfRocks(x, z)) continue;
      return { x, z };
    }
    return { x: 0, z: R * 0.5 };
  }

  #spawnPortal(x, z) {
    this.#closePortal();
    this.portal = { x, z, r: BOSS_PORTAL.radius, t: 0, doneT: 0, ready: new Set() };
    this.portalSyncT = 0;
    this.#reviveForPortal(this.portal);
    this.#createPortalMesh(x, z);
    this.#paintPortalLabel(true);
  }

  /** 门升起时把阵亡玩家复活在门外一圈：否则“人没到齐”永远无法达成 */
  #reviveForPortal(pt) {
    for (const p of this.players.values()) {
      if (p.alive) continue;
      p.alive = true;
      p.hp = PLAYER_MAX_HP;
      p.invuln = PLAYER_INVULN_TIME;
      p.respawn = 0;
      p.rescueT = null;
      this.#clearRescueMarker(p);
      const a = Math.random() * Math.PI * 2;
      const d = pt.r + 7;
      p.boat?.resetTo(pt.x + Math.cos(a) * d, pt.z + Math.sin(a) * d, Math.atan2(-pt.x, -pt.z));
    }
  }

  #createPortalMesh(x, z) {
    const tex = runeTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color: 0xa87bff, transparent: true, opacity: 0.9,
      blending: THREE.NormalBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    rune.rotation.x = -Math.PI / 2;
    rune.position.set(x, 0.34, z);
    rune.scale.set(BOSS_PORTAL.runeSize, BOSS_PORTAL.runeSize, 1);
    rune.frustumCulled = false;
    this.scene.add(rune);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x9a6bff, transparent: true, opacity: 0.85,
      blending: THREE.NormalBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1.0, 96), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.36, z);
    ring.scale.set(BOSS_PORTAL.radius, BOSS_PORTAL.radius, 1);
    ring.frustumCulled = false;
    this.scene.add(ring);

    // 立在水面上的门：朝向场地中心（玩家基本上都从圈中间过来）
    const door = new THREE.Group();
    door.position.set(x, BOSS_PORTAL.y + 5.4, z);
    door.lookAt(0, BOSS_PORTAL.y + 5.4, 0);
    this.scene.add(door);
    const swirlTex = makePortalSwirlTexture();
    const swirlMat = new THREE.MeshBasicMaterial({
      map: swirlTex, color: 0xd8bcff, transparent: true, opacity: 0.9,
      blending: THREE.NormalBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    });
    const swirl = new THREE.Mesh(new THREE.CircleGeometry(1, 64), swirlMat);
    swirl.scale.set(BOSS_PORTAL.doorRadius, BOSS_PORTAL.doorRadius, 1);
    swirl.frustumCulled = false;
    door.add(swirl);
    // 门框：一圈略粗的紫环 + 一圈更亮的内环，转动时能看出“门在运转”
    const frameMat = new THREE.MeshBasicMaterial({
      color: 0x9d6bff, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const frame = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.06, 10, 80), frameMat,
    );
    frame.scale.set(BOSS_PORTAL.doorRadius, BOSS_PORTAL.doorRadius, 1);
    frame.frustumCulled = false;
    door.add(frame);
    const innerMat = new THREE.MeshBasicMaterial({
      color: 0xe6d4ff, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const inner = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.022, 8, 80), innerMat,
    );
    inner.scale.set(BOSS_PORTAL.doorRadius * 0.9, BOSS_PORTAL.doorRadius * 0.9, 1);
    inner.frustumCulled = false;
    door.add(inner);

    // 门楣浮字（DNF 那种“已准备”）：画布贴图，文字变化时才重绘
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const labelTex = new THREE.CanvasTexture(canvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const labelMat = new THREE.SpriteMaterial({
      map: labelTex, transparent: true, depthWrite: false, depthTest: false, fog: false,
    });
    const sprite = new THREE.Sprite(labelMat);
    sprite.scale.set(12, 3, 1);
    // 门楣字放在门环内侧的上三分之一处：贴到门顶会被顶部血条挡、也会在近处跑出画面
    sprite.position.set(x, BOSS_PORTAL.y + 5.4 + BOSS_PORTAL.doorRadius * 0.5, z);
    sprite.renderOrder = 10;
    sprite.frustumCulled = false;
    this.scene.add(sprite);
    this.portalMesh = {
      rune, ring, door, swirl, frame, inner, sprite,
      mat, ringMat, swirlMat, frameMat, innerMat, swirlTex,
      labelMat, labelTex, canvas, labelText: '', t: 0,
    };
  }

  #removePortalMesh() {
    const pm = this.portalMesh;
    if (!pm) return;
    this.scene.remove(pm.rune, pm.ring, pm.door, pm.sprite);
    pm.rune.geometry.dispose();
    pm.ring.geometry.dispose();
    pm.swirl.geometry.dispose();
    pm.frame.geometry.dispose();
    pm.inner.geometry.dispose();
    pm.mat.dispose();
    pm.ringMat.dispose();
    pm.swirlMat.dispose();
    pm.swirlTex.dispose();
    pm.frameMat.dispose();
    pm.innerMat.dispose();
    pm.labelMat.dispose();
    pm.labelTex.dispose();
    this.portalMesh = null;
  }

  #closePortal() {
    this.#removePortalMesh();
    this.portal = null;
  }

  /** 门楣文字：显示已准备人数；全员到位后切成“传送中” */
  #paintPortalLabel(force = false) {
    const pm = this.portalMesh;
    if (!pm) return;
    const total = this.players.size;
    const ready = this.portal?.ready.size ?? 0;
    const text = total > 0 && ready >= total ? '全员已准备 · 传送中…' : `已准备 ${ready}/${total}`;
    if (!force && pm.labelText === text) return;
    pm.labelText = text;
    const ctx = pm.canvas.getContext('2d');
    ctx.clearRect(0, 0, pm.canvas.width, pm.canvas.height);
    ctx.font = "bold 64px 'Microsoft YaHei','PingFang SC',sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(30,10,60,0.85)';
    ctx.strokeText(text, 256, 66);
    ctx.fillStyle = ready >= total && total > 0 ? '#ffe6a3' : '#e5d4ff';
    ctx.fillText(text, 256, 66);
    pm.labelTex.needsUpdate = true;
  }

  #updatePortal(dt) {
    const pt = this.portal;
    if (!pt) return;
    pt.t += dt;
    const pm = this.portalMesh;
    if (pm) {
      pm.t += dt;
      pm.rune.rotation.z += dt * 0.16;
      // 门面旋涡逆时针转，内环轻微呼吸，看起来“门在运转”
      pm.swirl.rotation.z -= dt * 0.55;
      const pulse = 0.9 + 0.025 * Math.sin(pm.t * 2.6);
      pm.inner.scale.set(BOSS_PORTAL.doorRadius * pulse, BOSS_PORTAL.doorRadius * pulse, 1);
      pm.mat.opacity = 0.82 + 0.16 * Math.sin(pm.t * 2.4);
      pm.ringMat.opacity = 0.72 + 0.22 * Math.sin(pm.t * 3.0);
      pm.swirlMat.opacity = 0.82 + 0.14 * Math.sin(pm.t * 2.0);
      pm.frameMat.opacity = 0.85 + 0.12 * Math.sin(pm.t * 3.4);
    }
    // 每艘船（含 AI）都在自己门口算判定：人类只算自己的，AI 由主机代算并广播，
    // 这样“我看到自己进去了”和“主机认定我进去了”不会打架。
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.id !== this.myId && !(p.ai && this.isHost)) continue;
      const inside = Math.hypot(p.boat.pos.x - pt.x, p.boat.pos.z - pt.z) <= pt.r;
      this.#setPortalReady(p, inside);
    }
    this.#paintPortalLabel();
    if (!this.isHost) return;
    // 客机切后台/漏消息时可能收不到唯一一次 bossPortal，门就永远不出现。
    // 等待全员进入期间由主机定期重发坐标，客机已经在同一位置有门就忽略。
    this.portalSyncT -= dt;
    if (this.portalSyncT <= 0) {
      this.portalSyncT = 1.5;
      this.net?.send({ t: 'bossPortal', x: pt.x, z: pt.z });
    }
    if (this.players.size > 0 && pt.ready.size >= this.players.size) {
      pt.doneT += dt;
      if (pt.doneT >= BOSS_PORTAL.advanceDelay) this.#advanceStage();
    } else {
      pt.doneT = 0;
    }
  }

  #setPortalReady(p, inside) {
    const pt = this.portal;
    if (!pt) return;
    if (pt.ready.has(p.id) === inside) return;
    if (inside) pt.ready.add(p.id);
    else pt.ready.delete(p.id);
    if (p.id === this.myId) {
      this.opts.onToast?.(inside ? '✅ 已准备：等待其他玩家进入传送门…' : '↩ 已离开传送门，准备取消');
    }
    if (!p.ai || this.isHost) this.net?.send({ t: 'bossReady', id: p.id, ready: inside });
  }

  #checkStageEvents() {
    if (!this.boss || this.boss.dead) return;
    // 血量阈值召唤
    for (const wave of this.summonWaves || []) {
      if (wave.fired || this.boss.hpRatio > wave.at) continue;
      if (this.stageElapsed - this.lastSummonAt < MINION_WAVE_INTERVAL * this.summonIntervalScale) continue;
      wave.fired = true;
      this.lastSummonAt = this.stageElapsed;
      const entries = [];
      const baseAngle = Math.random() * Math.PI * 2;
      const delta = this.difficulty.summonDelta || 0;
      // 按「整波总数」均分角度，而不是每类各自从 baseAngle 重头排：
      // 第三关现在岩窟兽/企鹅各 1 只，各自 count=1 会算出同一个角度、两只叠在一起。
      const total = wave.minions.reduce((n, g) => n + g.count + delta, 0);
      let idx = 0;
      for (const group of wave.minions) {
        const count = group.count + delta;
        for (let i = 0; i < count; i++) {
          const a = baseAngle + (idx / Math.max(1, total)) * Math.PI * 2;
          const r = this.arena.radius - 22;
          const x = Math.cos(a) * r;
          const z = Math.sin(a) * r;
          entries.push({ type: group.id, x, z });
          idx += 1;
        }
      }
      this.#spawnMinions(entries);
      if (this.isHost) this.net?.send({ t: 'bossSummon', entries });
    }
  }

  #updateStatusTimers(dt) {
    for (const key of Object.keys(this.bossStatus)) {
      this.bossStatus[key] = Math.max(0, this.bossStatus[key] - dt);
    }
    if (!this.boss) return;
    this.boss.speedScale = (this.bossBaseSpeed || 1) * (this.bossStatus.slow > 0 ? 0.4 : 1);
    this.boss.status.blind = this.bossStatus.blind;
    this.boss.status.root = this.bossStatus.root;
    this.boss.status.confuse = this.bossStatus.confuse;
    this.boss.status.silence = this.bossStatus.silence;
    this.boss.status.reverse = this.bossStatus.reverse;
    // dive / confuseCast 已在上面统一递减，这里只负责下发，不能再减一次
    // 沉水状态跳变时补入水/出水演出：压下去时水柱炸起，时效结束破水而出时再来一次
    const wasDiving = (this.boss.status.dive || 0) > 0;
    this.boss.status.dive = this.bossStatus.dive;
    const diving = (this.boss.status.dive || 0) > 0;
    if (!wasDiving && diving) this.#playDiveSplash(true);
    else if (wasDiving && !diving) this.#playDiveSplash(false);
    this.boss.status.slow = this.bossStatus.slow;
  }

  /** 深水炸弹沉水/浮出的水面演出（BOSS 位置固定，水柱从当地波高升起） */
  #playDiveSplash(submerge) {
    const b = this.boss;
    if (!b) return;
    const x = b.pos.x;
    const z = b.pos.z;
    const y = waveHeight(x, z, this.stageElapsed) + 0.7;
    // 下沉：一股被压起来的水柱；浮出：水柱更高 + 一圈冲击环，读作"破水而出"
    this.fx.play('toonWater', x, y, z, submerge ? 3.4 : 4.4);
    this.fx.play('ring', x, y + 0.3, z, submerge ? 2.8 : 4.0);
  }

  // ---------- 小怪 ----------
  /**
   * 小怪头顶血条：深色圆角底 + 红色填充 + 白描边，右侧单独一行百分比。
   * 用 Canvas + Sprite 而不是世界空间几何：Sprite 永远正对镜头，不用每帧算朝向；
   * depthTest:false + 较高的 renderOrder 保证被蟹壳/水母伞盖挡住时也读得到。
   */
  #makeMinionHpBar() {
    const canvas = document.createElement('canvas');
    canvas.width = MINION_BAR_W;
    canvas.height = MINION_BAR_H;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    }));
    // 画布里“条身”偏左、百分比文字在右侧占了一段空白。把锚点挪到条身中心，
    // 血条才是正对小怪头顶，而不是整体向左偏 13%。
    spr.center.set((6 + 178 / 2) / MINION_BAR_W, 0.5);
    spr.renderOrder = 58;
    spr.visible = false;
    this.scene.add(spr);
    return {
      canvas, ctx: canvas.getContext('2d'), tex, spr, ratio: -1, hp: -1,
    };
  }

  #drawMinionHpBar(bar, ratio) {
    const { ctx, canvas } = bar;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // ---- 胶囊条：左边 178px 是条身，右边留白写百分比 ----
    const bx = 6;
    const bw = 178;
    const bh = 26;
    const by = (canvas.height - bh) / 2;
    const r = bh / 2;
    ctx.fillStyle = 'rgba(10,10,14,0.82)';
    roundedRectPath(ctx, bx, by, bw, bh, r);
    ctx.fill();

    const fw = Math.max(0, Math.min(1, ratio)) * (bw - 4);
    if (fw > 0.75) {
      ctx.save();
      roundedRectPath(ctx, bx, by, bw, bh, r);
      ctx.clip();
      // 顶部亮红 → 底部暗红：平涂的红在亮海面上会发灰，渐变才读得出“血”
      const grad = ctx.createLinearGradient(0, by, 0, by + bh);
      grad.addColorStop(0, '#ff4a52');
      grad.addColorStop(0.5, '#d3142c');
      grad.addColorStop(1, '#8e0a1c');
      ctx.fillStyle = grad;
      ctx.fillRect(bx + 2, by + 2, fw, bh - 4);
      ctx.restore();
    }

    // 白描边：黑底压在水面上容易糊掉，这条边是“这是个血条”的识别线
    ctx.strokeStyle = 'rgba(248,250,253,0.92)';
    ctx.lineWidth = 2;
    roundedRectPath(ctx, bx + 1, by + 1, bw - 2, bh - 2, r);
    ctx.stroke();

    // ---- 百分比：白色描边字，和参考图一样放在条的右侧 ----
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 22px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    const pct = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
    const tx = bx + bw + 12;
    const ty = by + bh / 2;
    ctx.strokeText(pct, tx, ty);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(pct, tx, ty);
  }

  /** 每帧把血条贴到小怪头顶，并按相机距离反算世界尺寸保持恒定屏幕占比 */
  #syncMinionBars() {
    const cam = this.camera || this.opts?.camera;
    // 牌子高 ≈ 视野高度的 2.4%（16:9 下约 13% 屏宽），比玩家名牌小一档
    const SCREEN_H = 0.024;
    const ASPECT = MINION_BAR_W / MINION_BAR_H;
    for (const m of this.minions) {
      const bar = m.bar;
      if (!bar) continue;
      // 倒地动作播放期间就收掉，不然血条会挂在尸体上
      if (!m.alive || m.dying || m.hp <= 0) {
        bar.spr.visible = false;
        continue;
      }
      bar.spr.visible = true;
      const headY = (m.def.fitHeight || 3) + 0.9;
      let h = bar.spr.scale.y;
      if (cam?.isPerspectiveCamera) {
        MINION_BAR_V.set(m.mesh.position.x, m.mesh.position.y + headY, m.mesh.position.z);
        const d = Math.max(2.5, cam.position.distanceTo(MINION_BAR_V));
        const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
        h = viewH * SCREEN_H;
        bar.spr.scale.set(h * ASPECT, h, 1);
      }
      bar.spr.position.set(
        m.mesh.position.x,
        m.mesh.position.y + headY + h * 0.5,
        m.mesh.position.z,
      );
      const ratio = m.maxHp > 0 ? m.hp / m.maxHp : 0;
      const hp = Math.max(0, Math.round(m.hp));
      // 只在血量真的变了才重画 Canvas：每帧发光纹理上传的开销吃不消
      if (Math.abs(ratio - bar.ratio) > 0.001 || bar.hp !== hp) {
        bar.ratio = ratio;
        bar.hp = hp;
        this.#drawMinionHpBar(bar, ratio);
        bar.tex.needsUpdate = true;
      }
    }
  }

  #spawnMinions(entries) {
    for (const entry of entries) {
      if (this.minions.length >= MAX_ACTIVE_MINIONS) break;
      const def = BOSS_MINIONS[entry.type];
      if (!def) continue;
      const mesh = new THREE.Group();
      mesh.position.set(entry.x, 0, entry.z);
      this.scene.add(mesh);
      const minion = {
        def, mesh, pos: new THREE.Vector3(entry.x, 0, entry.z),
        hp: def.hp, maxHp: def.hp, t: Math.random() * 6,
        hitCd: 0, castCd: 0, alive: true, dying: 0, heading: 0, swing: 0,
        bar: this.#makeMinionHpBar(),
      };
      this.#loadMinionRig(minion);
      this.fx.play('tornado', entry.x, 0.8, entry.z);
      this.minions.push(minion);
    }
  }

  /** 把 walk/attack/death 三集的骨骼动画拼到同一只怪上 */
  #loadMinionRig(minion) {
    const def = minion.def;
    const loaded = []; // [url, 该文件的 clip 数]，调试用
    loadMinionModel(def.model).then(async (gltf) => {
      const clips = [...(gltf.animations || [])];
      loaded.push([def.model, (gltf.animations || []).length]);
      if (def.clipModels?.length) {
        for (const url of def.clipModels) {
          try {
            const extra = await loadMinionModel(url);
            clips.push(...(extra.animations || []));
            loaded.push([url, (extra.animations || []).length]);
          } catch (e) {
            // 以前这里完全静默：少一集动作只会表现为"怪不播攻击/施法"，
            // 排查时根本看不出是文件没加载。至少留一条 warn。
            console.warn('[minion] 追加动作加载失败:', def.id, url, e?.message || e);
          }
        }
      }
      // 调试钩子：动画合并是静默的，缺一集只表现为"怪不播攻击"。
      // 把每个文件的 clip 数留一份，无头验收不用去猜是哪一步断了。
      if (typeof window !== 'undefined') {
        (window.__minionClips ||= {})[def.id] = {
          clips: clips.map((c) => c.name), loaded,
        };
      }
      const root = instantiateMonsterModel(gltf, { height: def.fitHeight, sink: 0.25 });
      minion.mesh.add(root);
      minion.model = root;
      if (!clips.length) return;

      const byName = new Map(clips.map((c) => [c.name, c]));
      const named = (key) => (def.anims?.[key] ? byName.get(def.anims[key]) : null);
      const match = (re) => clips.find((c) => re.test(c.name || ''));
      const walk = named('walk') || named('move') || match(/walk|run|move/i) || clips[0];
      const atk = named('attack') || match(/attack|atk|bite|claw/i);
      const cast = named('cast') || match(/skill|cast|spell/i);
      const die = named('die') || match(/death|die|dead/i);

      minion.mixer = new THREE.AnimationMixer(root);
      if (walk) {
        minion.walkAction = minion.mixer.clipAction(walk);
        minion.walkAction.play();
      }
      if (atk) {
        minion.attackAction = minion.mixer.clipAction(atk);
        minion.attackAction.setLoop(THREE.LoopOnce, 1);
        minion.attackAction.clampWhenFinished = true;
      }
      if (cast) {
        // 远程施法动作（血魔的 skill01）：原地抬手掷刀，比爪击更像"打出一道东西"
        minion.castAction = minion.mixer.clipAction(cast);
        minion.castAction.setLoop(THREE.LoopOnce, 1);
        minion.castAction.clampWhenFinished = true;
      }
      if (die) {
        minion.dieAction = minion.mixer.clipAction(die);
        minion.dieAction.setLoop(THREE.LoopOnce, 1);
        minion.dieAction.clampWhenFinished = true;
      }
      minion.walkSpeed = walk ? Math.max(0.1, walk.duration || 1) : 1;
    }).catch(() => {
      const fallback = new THREE.Mesh(
        new THREE.SphereGeometry(def.radius, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x661122, emissive: 0x330811 }),
      );
      fallback.position.y = def.radius;
      fallback.userData.ownGeometry = true; // 这个几何体是就地新建的，回收时可以释放
      minion.mesh.add(fallback);
    });
  }

  #updateMinions(dt) {
    const alive = [...this.players.values()].filter((p) => p.alive);
    for (const m of this.minions) {
      if (!m.alive) continue;
      m.t += dt;
      m.mixer?.update(dt);
      // 死亡动作播完再移除，比瞬间消失有打击感
      if (m.dying) {
        m.dying -= dt;
        if (m.dying <= 0) this.#removeMinion(m);
        continue;
      }
      m.hitCd = Math.max(0, m.hitCd - dt);
      m.castCd = Math.max(0, (m.castCd || 0) - dt);
      if (!alive.length) continue;
      let target = alive[0];
      let best = Infinity;
      for (const p of alive) {
        const d = Math.hypot(p.boat.pos.x - m.pos.x, p.boat.pos.z - m.pos.z);
        if (d < best) { best = d; target = p; }
      }
      const dx = target.boat.pos.x - m.pos.x;
      const dz = target.boat.pos.z - m.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      m.heading = Math.atan2(dx, dz);
      const reach = m.def.radius + 2.6;
      const rangedRange = m.def.rangedRange || 0;
      const bubbleRange = m.def.bubbleRange || 0;
      if (d <= reach) {
        // 近战：爪击（原地大弯月，命中即时结算）
        if (m.hitCd <= 0) {
          m.hitCd = m.def.attackCooldown || 1.4;
          if (m.attackAction) {
            m.attackAction.reset();
            m.attackAction.play();
          } else {
            m.swing = 0.35;
          }
          this.#spawnSlashArc(m, target);
          if (target.id === this.myId && target.invuln <= 0) {
            this.#damagePlayer(target.id, m.def.contactDamage || 12, {
              awayFrom: { x: m.pos.x, z: m.pos.z },
              source: `💢 ${m.def.name}`,
            });
          }
        }
      } else if (rangedRange > 0 && d <= rangedRange && m.castCd <= 0) {
        // 远程（只有血魔）：停在原地抬手施法，掷出闪电弯刀
        // 伤害在读条飞到之后再结算（见 #updateArcs），视觉和掉血对得上
        m.castCd = m.def.rangedCooldown || 3.4;
        if (m.castAction) {
          m.castAction.reset();
          m.castAction.play();
        } else {
          m.swing = 0.35;
        }
        this.#spawnFlyingBlade(m, target, m.def.rangedDamage || 8);
      } else if (bubbleRange > 0 && d <= bubbleRange && m.castCd <= 0) {
        // 巨鲸鲨吐泡泡：停下来鼓鳃张嘴，泡泡延迟 0.32s 才从嘴里出来
        // （对应吐泡泡动作第 8~9 帧的开颌时刻，不然动作还没张嘴泡泡就先飞了）
        m.castCd = m.def.bubbleCooldown || 9;
        if (m.castAction) {
          m.castAction.reset();
          m.castAction.play();
        } else {
          m.swing = 0.35;
        }
        this.delayedHits.push({
          kind: 'whaleBubble', t: 0, delay: 0.32,
          minion: m, targetId: target.id,
        });
      } else {
        // 追到近战距离 / 远程射程内。
        // 巨鲸鲨是远程炮台：进了泡泡射程后保持在射程外沿，
        // 冷却期间也往回游，不再一路冲到船脸上只剩咬人。
        let dir = 1;
        if (bubbleRange > 0 && d < bubbleRange * 0.62) dir = -1;
        const step = Math.min(m.def.speed, 14) * dt * dir;
        m.pos.x += (dx / d) * step;
        m.pos.z += (dz / d) * step;
        // 走路动画的播放速度跟着实际移速走，避免“滑步”
        if (m.walkAction) {
          m.walkAction.setEffectiveTimeScale(
            THREE.MathUtils.clamp((m.def.speed || 8) / 6, 0.6, 1.8),
          );
        }
      }
      m.swing = Math.max(0, m.swing - dt);
      const lunge = m.swing > 0 ? Math.sin((1 - m.swing / 0.35) * Math.PI) * 0.5 : 0;
      m.mesh.position.set(
        m.pos.x + Math.sin(m.heading) * lunge,
        0.18 + Math.sin(m.t * 6) * 0.06,
        m.pos.z + Math.cos(m.heading) * lunge,
      );
      m.mesh.rotation.y = m.heading;
      // 玩家高速撞小怪 → 击杀
      const me = this.localBoat;
      const md = Math.hypot(me.pos.x - m.pos.x, me.pos.z - m.pos.z);
      if (md < m.def.radius + 2.6 && me.speed > 9) {
        this.#damageMinion(m, me.speed * 0.9);
        me.vel.multiplyScalar(0.86);
      }
    }
    // 血条的坐标/尺寸跟随后处理：上面的循环里有 continue 分支，
    // 放在循环外层才不会漏掉正在死亡动画里的小怪
    this.#syncMinionBars();
  }

  /** 统一的扣血入口：炮弹 / 激光 / 陷阱 / 撞击都走这里 */
  #damageMinion(m, dmg) {
    if (!m || !m.alive || m.dying) return 0;
    const dealt = Math.min(m.hp, dmg);
    m.hp -= dmg;
    this.#spawnBurst(m.pos.x, 1.6, m.pos.z, 0xffcf6a, 0.5);
    if (m.hp <= 0) this.#killMinion(m);
    return dealt;
  }

  #killMinion(m) {
    if (m.dying) return;
    m.dying = m.dieAction ? Math.max(0.8, m.dieAction.getClip().duration * 0.9) : 0.4;
    m.walkAction?.stop();
    if (m.attackAction) m.attackAction.stop();
    if (m.dieAction) {
      m.dieAction.reset();
      m.dieAction.play();
    }
    this.fx.play('explosion', m.pos.x, 1.0, m.pos.z);
    this.opts.onToast?.(`💥 击破 ${m.def.name}`);
    // 场上箱子太少时，小怪倒下补一个箱子
    if (this.itemBoxes.filter((b) => b.active).length < MINION_DROP_BOX_MIN) {
      const inactive = this.itemBoxes.find((b) => !b.active);
      if (inactive) {
        inactive.active = true;
        inactive.timer = 0;
        inactive.x = m.pos.x;
        inactive.z = m.pos.z;
      }
    }
  }

  #removeMinion(m) {
    m.alive = false;
    this.scene.remove(m.mesh);
    this.#disposeMinionMesh(m.mesh);
    this.#disposeMinionBar(m);
    m.mixer?.stopAllAction();
    m.mixer = null;
  }

  /** 回收小怪血条：Sprite 和 Canvas 纹理都是每只怪独占的，必须手动释放 */
  #disposeMinionBar(m) {
    const bar = m.bar;
    if (!bar) return;
    this.scene.remove(bar.spr);
    bar.spr.material.dispose();
    bar.tex.dispose();
    m.bar = null;
  }

  /**
   * 回收小怪网格。几何体与缓存 gltf 共享（SkeletonUtils 克隆不会复制 geometry），
   * 无条件 dispose 会把后续召唤出来的同一只怪的显存缓冲一起销毁；
   * 每只怪单独 clone 的材质则需要回收，否则连刷小怪会持续泄漏。
   */
  #disposeMinionMesh(mesh) {
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      if (o.userData.ownGeometry) o.geometry?.dispose();
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) mat.dispose?.();
    });
  }

  // ---------- 道具 ----------
  #buildItemBoxes() {
    // 与道具赛同一套外观：蓝色金属框 + 自发光面板 + 独立问号 + 水面光环 + 环绕光点
    this.boxField = new ItemBoxField(this.scene, ARENA_ITEM_SPOTS.length, {
      size: 2.4,
      floatHeight: 1.6,
      bob: 0.24,
      spin: 0.5,
      phase: 1.1,
    });
    for (const spot of ARENA_ITEM_SPOTS) {
      this.itemBoxes.push({
        x: spot.x, z: spot.z, active: true, timer: 0,
      });
    }
  }

  #resetItemBoxes() {
    for (const b of this.itemBoxes) {
      b.active = true;
      b.timer = 0;
    }
  }

  #updateItemBoxes(dt) {
    for (const box of this.itemBoxes) {
      if (!box.active) {
        box.timer -= dt;
        if (box.timer <= 0) box.active = true;
        continue;
      }
      const d = Math.hypot(this.localBoat.pos.x - box.x, this.localBoat.pos.z - box.z);
      if (d < 4.6) {
        const me = this.players.get(this.myId);
        if (!me?.alive) continue;
        const slot = this.myItems.findIndex((it) => !it);
        if (slot < 0) continue;
        box.active = false;
        // 海克斯：道具补给（boxes）减半，贪婪规则通过 boxRate 再乘一档
        box.timer = 8 * (this.hexMods.boxRate || 1) * (this.#hexHas('boxes') ? 0.5 : 1);
        const type = ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];
        this.myItems[slot] = type;
        this.fx.play('ring', box.x, 1.2, box.z);
        this.opts.onToast?.(`拾取 ${BOSS_ITEM_DEFS[type].icon} ${BOSS_ITEM_DEFS[type].name}`);
      }
    }
    this.boxField?.update(this.stageElapsed, this.itemBoxes);
  }

  #bindInput() {
    if (!this.input) return;
    // 怪物模式保留 W/↑ 油门，道具槽改用 Q/E/1
    this.input.bossItemMode = true;
    this.input.onItem = (slot) => {
      if (this.phase !== 'fight') return;
      const item = this.myItems[slot];
      if (!item) return;
      this.myItems[slot] = null;
      this.#useItem(item);
    };
  }

  // 对 BOSS 造成伤害：本地记账 + 客机上报主机
  #dealBossDamage(dmg, { crit = false, pos = null, owner = null, status = null, stagger = 0 } = {}) {
    // 破甲标枪的虚弱窗口：受伤 ×1.6，同时攻击累积的韧性 ×2
    if ((this.bossStatus.vulnerable || 0) > 0) {
      dmg *= 1.6;
      stagger *= 2;
    }
    // 被深水炸弹压在水里时是奖励窗口：挨打 +25%
    if ((this.bossStatus.dive || 0) > 0) dmg *= 1.25;
    // 第二关：四核全破后的弱点窗口
    if (this.weakT > 0) dmg *= BOSS_CORE_WAVE.weaknessMul;
    // 破韧跪地：前三关的破防窗口，全场伤害 ×damageMul
    if (this.boss?.staggerTimer > 0) dmg *= BOSS_STAGGER.damageMul;
    if (!this.boss || this.boss.dead || dmg <= 0) return 0;
    // 腾空到高空时不可命中：不跳伤害数字、不记输出统计、不叠韧性，
    // 否则血条不动却满屏“-120”，玩家会以为打中了但没生效。
    if (this.boss.airborne) return 0;
    const byId = owner || this.myId;
    this.totalDamage += dmg;
    this.damageByPlayer.set(byId, (this.damageByPlayer.get(byId) || 0) + dmg);
    this.#addAggro(byId, dmg);
    const b = this.boss;
    const x = pos?.x ?? b.pos.x;
    const z = pos?.z ?? b.pos.z;
    this.#spawnDamageText(
      dmg, x, Math.max(2.4, (b.def.height || 6) * 0.55), z,
      crit || dmg >= 40,
    );
    this.boss.applyDamage(dmg);
    // 自己的伤害才有金属闷响（队友/AI 的命中不播，否则就是一路嘟嘟嘟）
    // 弱点窗口内换成更"脆"的暴击音
    if (byId === this.myId) {
      audio.play(this.weakT > 0 ? 'weak_crit' : 'boss_damage_ranged', { gap: 90 });
    }
    // 韧性只在主机结算：客机把自己的增量塞进 bossHit 一起上报，
    // 否则三端各自破韧会出现“我这边跪了你那边还站着”。
    if (stagger > 0 && this.isHost) {
      if (this.boss.addStagger(stagger)) this.#onBossStagger();
    }
    if (!this.isHost) {
      // 顺带把控制状态送上去：BOSS 的 AI 只在主机跑，客机的 debuff 不送等于没放
      const hit = { id: 'boss', dmg };
      if (status) hit.status = status;
      if (stagger > 0) hit.stagger = stagger;
      this.net?.send({ t: 'bossHit', from: this.myId, hits: [hit] });
    }
    return dmg;
  }

  /**
   * 弱点判定。
   * 前三关：正面装甲 0.85×、侧面 1.25×、背后 1.45× —— 侧后仍有优势，
   * 但不再像以前那样“绕圈就稳赢”，真正的爆发留给破韧跪地窗口（×2.2）。
   * 第四关没有破韧机制，保持原来的 0.72 / 1.9 / 2.4，强度不变。
   */
  #weaknessMul(x, z) {
    const b = this.boss;
    if (!b) return 1;
    const dx = x - b.pos.x;
    const dz = z - b.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const dot = (dx * Math.sin(b.heading) + dz * Math.cos(b.heading)) / len;
    const staggerStage = this.ruleStage <= 3;
    if (dot > 0.62) return staggerStage ? 0.85 : 0.72;   // 正面装甲
    if (dot < -0.2) return staggerStage ? 1.45 : 2.4;    // 背部核心
    return staggerStage ? 1.25 : 1.9;                    // 侧面弱点
  }

  /** 主炮命中：弱点倍率 → 伤害 → 韧性累积 → 命中特效 */
  #applyWeaponHit(base, x, z, def, extra = {}) {
    const b = this.boss;
    if (!b || b.dead || !def) return;
    // 第二关能量核心：核心升起期间打中核心只扣核心，不进 BOSS 的弱点倍率
    const core = this.#coreAt(x, z);
    if (core) {
      const coreDmg = base * (extra?.crit ? 1.5 : 1);
      this.#spawnBurst(x, 2.4, z, 0xffb15a, 0.9);
      this.#damageCore(core.i, coreDmg);
      this.net?.send({ t: 'bossCoreHit', i: core.i, dmg: coreDmg, from: this.myId });
      return;
    }
    const mul = this.#weaknessMul(x, z);
    // 海克斯：卡牌/核心/规则的输出加成按“开火的人”结算，队友的卡不会加到自己身上
    const dmg = base * mul * (extra?.crit ? 1.5 : 1) * this.#hexDamageMul(extra?.owner);
    // 破韧：打弱点转化率高，正面装甲几乎攒不动；BOSS 出招预警时额外奖励（抓后摇）
    const weak = mul >= 1.2;
    let stagger = dmg * (weak ? BOSS_STAGGER.gainWeak : BOSS_STAGGER.gainOther);
    if (b.state === 'telegraph') stagger += dmg * BOSS_STAGGER.gainTelegraph;
    this.#dealBossDamage(dmg, { crit: mul >= 2, pos: { x, z }, owner: extra?.owner, stagger });
    this.#spawnBurst(x, 1.5, z, def.color || 0xffd28a, weak ? 1.2 : 0.72);
    if (weak) this.#spawnBurst(x, 2.4, z, 0xff6a30, 1.0);
  }

  #addAggro(id, dmg) {
    if (!id) return;
    this.aggro.set(id, (this.aggro.get(id) || 0) + dmg);
  }

  /** 当前被 BOSS 盯上的人（最近输出最高） */
  #topAggro() {
    let best = null;
    let bestV = 6;
    for (const [id, v] of this.aggro) {
      if (v > bestV) { bestV = v; best = id; }
    }
    return best;
  }

  #decayAggro(dt) {
    const k = Math.exp(-0.5 * dt);
    for (const [id, v] of this.aggro) {
      const nv = v * k;
      if (nv < 1) this.aggro.delete(id);
      else this.aggro.set(id, nv);
    }
  }

  // ---------- 双人协同：靠近充能 → 两人同时按 F 才是合击 ----------
  #updateCombo(dt, me) {
    this.comboCd = Math.max(0, this.comboCd - dt);
    // 队友进度 2 秒没更新就当过期，避免 HUD 一直挂着旧数字
    for (const [id, v] of this.comboPeers) {
      v.t -= dt;
      if (v.t <= 0) this.comboPeers.delete(id);
    }
    if (!this.localBoat) return;

    const mates = [...this.players.values()].filter(
      (p) => p.alive && p.id !== this.myId && me?.alive,
    );
    let near = null;
    let nearD = Infinity;
    for (const p of mates) {
      const d = Math.hypot(
        p.boat.pos.x - this.localBoat.pos.x,
        p.boat.pos.z - this.localBoat.pos.z,
      );
      if (d < nearD) { nearD = d; near = p; }
    }
    this.comboMateId = near?.id || null;
    if (near && nearD < 24 && this.phase === 'fight') {
      // 两个人靠在一起才能攒协同：分开躲技能就会掉
      this.comboCharge = Math.min(100, this.comboCharge + dt * 16);
    } else {
      this.comboCharge = Math.max(0, this.comboCharge - dt * 12);
    }
    this.comboReady = this.comboCharge >= 100 && this.comboCd <= 0;
    if (this.comboReady && !this.comboReadyPrev) audio.play('synergy');
    this.comboReadyPrev = this.comboReady;

    // 自己的进度同步给队友（4Hz 足够，没必要每帧发）
    this.comboSyncT -= dt;
    if (this.comboSyncT <= 0) {
      this.comboSyncT = 0.25;
      this.net?.send({ t: 'bossComboState', from: this.myId, c: Math.round(this.comboCharge) });
    }

    // 预备窗口：1.2 秒内两边都按下 F 才算“同时”
    if (this.comboArmed) {
      this.comboArmT = Math.max(0, this.comboArmT - dt);
      if (this.comboArmT <= 0 && this.comboArmed) {
        this.comboArmed = false;
        this.opts.onToast?.('协同没接上：需要队友在同一时间按 F');
      }
    }
    // 单人陪练：按下 F 后 AI 隔 0.35s“跟着按”，模拟双人合击
    if (this.comboAiArmT > 0) {
      this.comboAiArmT -= dt;
      if (this.comboAiArmT <= 0) this.#fireCombo(this.comboAiMate);
    }

    const held = !!this.input?.combo;
    if (held && !this.comboHeld) this.#armCombo(near);
    this.comboHeld = held;
  }

  /** 按下 F：自己进入预备，等队友在同一个窗口里也按下 */
  #armCombo(near) {
    if (!this.comboReady || this.comboArmed) return;
    if (!near) {
      this.opts.onToast?.('协同合击需要一名队友');
      return;
    }
    const d = Math.hypot(
      near.boat.pos.x - this.localBoat.pos.x,
      near.boat.pos.z - this.localBoat.pos.z,
    );
    if (d > 26) {
      this.opts.onToast?.('协同合击要靠近队友才能发动');
      return;
    }
    this.comboArmed = true;
    this.comboArmT = 1.2;
    this.net?.send({ t: 'bossComboArm', from: this.myId });
    if (near.ai) {
      // AI 没有输入，靠 0.35s 的延迟假装它跟着按下了 F
      this.comboAiArmT = 0.35;
      this.comboAiMate = near;
      this.opts.onToast?.('已预备协同，AI 队友正在跟上…');
    } else {
      this.opts.onToast?.('已预备协同，等队友同时按 F');
    }
  }

  #fireCombo(mate) {
    const boat = this.localBoat;
    const b = this.boss;
    if (!boat || !b || b.dead) return;
    this.comboArmed = false;
    this.comboArmT = 0;
    this.comboAiArmT = 0;
    this.comboAiMate = null;
    this.comboCharge = 0;
    this.comboReady = false;
    this.comboCd = 14;
    const ax = boat.pos.x;
    const az = boat.pos.z;
    const bx = b.pos.x;
    const bz = b.pos.z;
    this.#playComboFx(ax, az, bx, bz);
    this.#shakeCamera(0.9);
    this.hitStop = Math.max(this.hitStop, 0.08);
    const dmg = 260;
    // 破防：BOSS 定身 3.2 秒，双人集火窗口。先写 bossStatus 再结算伤害，
    // 状态就能随同一条 bossHit 送到主机——客机放的协同合击也要真的定住 BOSS
    this.bossStatus.root = Math.max(this.bossStatus.root || 0, 3.2);
    this.#dealBossDamage(dmg, {
      crit: true, pos: { x: bx, z: bz }, status: { root: 3.2 },
      stagger: dmg * BOSS_STAGGER.gainWeak,
    });
    const mateName = this.order?.find((e) => e.id === mate?.id)?.name || '队友';
    this.opts.onToast?.(`🤝 与 ${mateName} 同时按下 F，协同合击！BOSS 破防 3 秒`);
    // 完整广播（船位 + BOSS 位），其他客户端照着播同一套特效
    this.net?.send({
      t: 'bossComboFire', from: this.myId, ax, az, bx, bz, mate: mate?.id || null,
    });
  }

  /**
   * 双人合击的表现：整体交给 Effekseer。
   * 船头金色蓄能 → 沿「船 → BOSS」铺一串电流柱 → BOSS 身上爆白色冲击环 + 金色能量核，
   * 这样即使没有 JS 光束，也能读出“从我这根线打到 BOSS”的方向感。
   */
  #playComboFx(ax, az, bx, bz) {
    this.fx.play('fxBenediction', ax, 1.8, az, 1.6);
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      this.fx.play('fxArcBolt', x, 1.6, z, 1.1 + t * 1.1);
    }
    this.fx.play('fxSonicBoom', bx, 1.4, bz, 2.2);
    this.fx.play('fxSpear1', bx, 2.4, bz, 1.8);
  }

  // ---------- 救援：队友沉船后 6 秒内靠近可原地救起 ----------
  #updateRescues(dt) {
    const me = this.players.get(this.myId);
    for (const p of this.players.values()) {
      if (p.alive || p.rescueT == null) continue;
      p.rescueT -= dt;
      if (p.rescueMarker) {
        p.rescueMarker.position.set(p.boat.pos.x, 0.4 + Math.sin(p.rescueT * 6) * 0.15, p.boat.pos.z);
        p.rescueMarker.rotation.y += dt * 1.4;
        p.rescueMarker.children.forEach((c) => {
          c.material.opacity = Math.max(0, Math.min(0.9, p.rescueT / 2));
        });
      }
      const canRescue = me?.alive && p.id !== this.myId;
      if (canRescue && p.rescueT > 0) {
        const d = Math.hypot(
          this.localBoat.pos.x - p.boat.pos.x,
          this.localBoat.pos.z - p.boat.pos.z,
        );
        if (d < 5) {
          this.#rescuePlayer(p);
          this.net?.send({ t: 'bossRescue', id: p.id });
        }
      }
      if (p.rescueT <= 0) this.#clearRescueMarker(p);
    }
  }

  #rescuePlayer(p) {
    if (p.alive) return;
    this.#clearRescueMarker(p);
    p.alive = true;
    p.hp = Math.max(40, Math.round(PLAYER_MAX_HP * 0.5));
    p.invuln = PLAYER_INVULN_TIME;
    p.respawn = 0;
    p.rescueT = null;
    p.boat.resetTo(p.boat.pos.x, p.boat.pos.z, p.boat.heading);
    p.boat.applyFx('shield', PLAYER_INVULN_TIME);
    this.fx.play('ring', p.boat.pos.x, 1.2, p.boat.pos.z, 1.1);
    if (p.id === this.myId) this.opts.onToast?.('🛟 被队友救起！血量 50%');
  }

  #spawnRescueMarker(p) {
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.6, 0.22, 8, 28),
      new THREE.MeshBasicMaterial({
        color: 0x7cf7c0, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.4, 9, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x7cf7c0, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    beam.position.y = 4.4;
    group.add(ring, beam);
    group.position.set(p.boat.pos.x, 0.4, p.boat.pos.z);
    this.scene.add(group);
    p.rescueMarker = group;
    this.rescues.push({ id: p.id, marker: group });
  }

  #clearRescueMarker(p) {
    if (!p.rescueMarker) return;
    this.scene.remove(p.rescueMarker);
    p.rescueMarker.traverse((o) => {
      if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); }
    });
    p.rescueMarker = null;
    this.rescues = this.rescues.filter((r) => r.id !== p.id);
  }

  #useItem(item) {
    const behavior = BOSS_ITEM_BEHAVIOR[item] || {};
    const boat = this.localBoat;
    if (!boat) return;
    audio.play(itemSfxName(item));
    // 自身增益：立刻生效，不发射弹道
    switch (item) {
      case 'nitro':
        boat.applyFx('nitro');
        this.fx.play('ring', boat.pos.x, 1.2, boat.pos.z, 0.7);
        return;
      case 'shield':
        boat.applyFx('shield', behavior.duration || 3);
        this.#boatBarrier('shield:' + this.myId, 'shield', behavior.duration || 3);
        this.opts.onToast?.('🛡️ 护盾展开');
        this.fx.play('ring', boat.pos.x, 1.2, boat.pos.z, 1.8);
        return;
      case 'angel': {
        // 天使庇佑的护罩原来挂的是 fxBenediction（一颗升腾的圣光球）：它的粒子按
        // 世界坐标散开，船一开走看上去就是"在原地掉下一颗光球"，完全没有包住船。
        // 改用护盾同一套 Barrior01 素材、染成金色 —— 罩子会逐帧跟着船走，
        // 天使=金罩、护盾=蓝罩，仍然一眼能分清。船底符文仍保留，按下瞬间就有反馈。
        const life = behavior.duration || 3;
        boat.applyFx('angel', life);
        this.#boatBarrier('angel:' + this.myId, 'shield', life, { color: 0xffd76b });
        this.fx.play('fxMagic2Holy', boat.pos.x, 0.25, boat.pos.z, 0.55);
        this.fx.play('ring', boat.pos.x, 1.2, boat.pos.z, 1.4);
        this.opts.onToast?.('😇 天使庇佑');
        return;
      }
      case 'antimagn':
        boat.applyFx('shield', 3);
        this.#boatBarrier('antimagn:' + this.myId, 'antimagn', 3);
        this.opts.onToast?.('🧿 反磁护盾');
        this.fx.play('ring', boat.pos.x, 1.2, boat.pos.z, 1.8);
        return;
      case 'ramcrest': {
        // 冲角护符：不发射弹道，给一个限时撞船增益（结算在 #update 的撞击段）
        const life = behavior.duration || 8;
        const mul = behavior.ramMul || 3;
        this.ramBuff = { t: life, mul, cdScale: behavior.ramCdScale || 0.55 };
        this.opts.onToast?.(`🐗 冲角护符：${life} 秒内撞 BOSS 伤害 ×${mul}`);
        this.fx.play('ring', boat.pos.x, 1.2, boat.pos.z, 1.5);
        // 声爆冲击环 + 跟随船的冲角光罩（Barrior02，和 shield 的 Barrior01 区分开）
        this.fx.play('fxSonicBoom', boat.pos.x, 1.2, boat.pos.z, 0.55);
        this.#boatBarrier('ramcrest:' + this.myId, 'ramCrest', life);
        return;
      }
      default:
        break;
    }
    if (!this.boss || this.boss.dead) return;
    // 飞鱼群：先撕咬船附近的小怪，再让鱼群追向 BOSS
    if (item === 'fish') {
      this.#castFishSwarm(behavior);
      return;
    }
    // 放置类道具：丢在水面上当陷阱，等 BOSS 自己撞上来（双人联机时队友引怪）
    if (BOSS_TRAP_ITEMS[item]) {
      this.#placeTrap(item, BOSS_TRAP_ITEMS[item]);
      return;
    }
    this.#launchItemShot(item, behavior);
  }

  /** 飞鱼群：船周围 20m 的小怪吃 2 倍伤害，随后鱼群照常追向 BOSS */
  #castFishSwarm(behavior) {
    const boat = this.localBoat;
    if (!boat) return;
    const dmg = Math.max(120, (behavior.damage || 120) * 2);
    let cleared = 0;
    for (const m of this.minions) {
      if (!m.alive || m.dying) continue;
      const d = Math.hypot(m.pos.x - boat.pos.x, m.pos.z - boat.pos.z);
      if (d > 20) continue;
      this.#damageMinion(m, dmg);
      cleared++;
    }
    // 鱼群出水：船周围一圈落水水花（一次性，不常驻）
    this.fx.play('fxWaterImpact', boat.pos.x, 0.2, boat.pos.z, 1.0);
    if (cleared > 0) audio.play('fish_minion');
    this.opts.onToast?.(cleared
      ? `🐟 飞鱼群撕咬，清掉附近 ${cleared} 只小怪`
      : '🐟 飞鱼群扑向 BOSS');
    this.#launchItemShot('fish', behavior);
  }

  /**
   * 跟随船的护罩（比赛模式的 Barrior01/03 那套）。
   * 怪物模式以前只写了 shieldTimer，没有任何视觉——所以玩家说"护盾不显示"。
   */
  #boatBarrier(key, effect, life, opts = {}) {
    const boat = this.localBoat;
    if (!boat || !this.fx) return;
    this.fx.playAttached(key, effect, () => {
      const env = boat.getEffectEnvelope?.();
      return env || { x: boat.pos.x, y: (boat.pos.y || 0) + 0.7, z: boat.pos.z };
    }, {
      life, loop: true,
      scale: opts.scale ?? (() => boat.getEffectEnvelope?.().scale || 1.25),
      // 同一段护罩素材可以被染成不同颜色（天使=金、护盾=原色），
      // 见 Effects.playAttached 的 color：Effekseer 实例级染色，逐帧也会重贴。
      color: opts.color ?? null,
    });
  }

  // ---------- 地面陷阱 ----------
  #placeTrap(item, def) {
    const boat = this.localBoat;
    if (!boat) return;
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const x = boat.pos.x + fx * 6;
    const z = boat.pos.z + fz * 6;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(def.radius * 0.9, def.radius, 0.5, 20),
      new THREE.MeshBasicMaterial({
        color: def.visual === 'ice' ? 0x8fe8ff : 0xffd166,
        transparent: true, opacity: 0.45, depthWrite: false,
      }),
    );
    mesh.position.set(x, waveHeight(x, z, this.stageElapsed) + 0.3, z);
    this.scene.add(mesh);
    // 陷阱本体视觉：水雷挂暗红警戒环，黏性水泡挂青蓝光球
    if (item === 'mine') this.fx.play('fxThunderRing', x, 0.35, z, 1.6);
    else if (item === 'bubble') this.fx.play('fxCosmicMist', x, 1.3, z, 1.0);
    const halo = new THREE.Mesh(
      new THREE.RingGeometry(def.radius * 0.85, def.radius * 1.05, 40),
      new THREE.MeshBasicMaterial({
        color: 0xfff2b0, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.set(x, 0.35, z);
    this.scene.add(halo);
    this.traps.push({ x, z, r: def.radius, def, mesh, halo, t: def.life, by: this.myId });
    this.opts.onToast?.(`${def.desc}（已放置）`);
    if (def.lure && this.boss) {
      this.boss.lure = { x, z, t: def.lure };
      // 客机的诱饵要让主机也把 BOSS 引过去
      if (!this.isHost) this.net?.send({ t: 'bossLure', x, z, dur: def.lure });
    }
    this.fx.play('ring', x, 1.1, z, 1.1);
  }

  #updateTraps(dt) {
    const boss = this.boss;
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const trap = this.traps[i];
      trap.t -= dt;
      trap.halo.material.opacity = 0.45 + Math.sin(trap.t * 8) * 0.3;
      trap.halo.scale.setScalar(1 + Math.sin(trap.t * 5) * 0.06);
      const alive = trap.t > 0;
      const hitBoss = boss && !boss.dead
        && Math.hypot(boss.pos.x - trap.x, boss.pos.z - trap.z) < trap.r + boss.def.radius * 0.6;
      // 小怪自己踩进陷阱也会引爆：所以把陷阱丢在怪堆冲锋路径上是有收益的
      const stepped = this.minions.some((m) => m.alive && !m.dying
        && Math.hypot(m.pos.x - trap.x, m.pos.z - trap.z) < trap.r + m.def.radius);
      if (!alive || hitBoss || stepped) {
        this.#removeTrap(trap, i);
        if (hitBoss || stepped) this.#triggerTrap(trap);
      }
    }
  }

  #triggerTrap(trap) {
    const def = trap.def;
    audio.play('boss_bomb');
    this.skillFx.ringBurst(def.visual || 'fire', {
      x: trap.x, z: trap.z, radius: def.r + 4, count: 64,
    });
    this.fx.play('explosion', trap.x, 1.6, trap.z, 1.6);
    this.#shakeCamera(0.5);
    this.hitStop = Math.max(this.hitStop, 0.06);
    if (def.damage) this.#dealBossDamage(def.damage);
    // 陷阱范围内的所有小怪一起掉血
    for (const m of this.minions) {
      if (!m.alive || m.dying) continue;
      if (Math.hypot(m.pos.x - trap.x, m.pos.z - trap.z) > trap.r + m.def.radius) continue;
      this.#damageMinion(m, Math.max(120, (def.damage || 60) * 1.6));
    }
    if (def.root && this.boss) {
      // 困住时长必须写进 bossStatus：boss.status.* 每帧都会被 #updateStatusTimers
      // 用 bossStatus 覆盖，直接写 boss.status.root 只会生效一帧
      this.bossStatus.root = Math.max(this.bossStatus.root || 0, def.root);
      if (!this.isHost) {
        this.net?.send({ t: 'bossHit', from: this.myId, hits: [{ id: 'boss', dmg: 0, status: { root: def.root } }] });
      }
      this.opts.onToast?.(`💧 ${this.bossDef.name} 被困住了 ${def.root}s！`);
    }
    if (def.lure && this.boss) this.boss.lure = null;
  }

  #removeTrap(trap, index) {
    if (index >= 0) this.traps.splice(index, 1);
    this.scene.remove(trap.mesh);
    this.scene.remove(trap.halo);
    trap.mesh.geometry.dispose();
    trap.mesh.material.dispose();
    trap.halo.geometry.dispose();
    trap.halo.material.dispose();
  }

  #clearTraps() {
    for (const trap of this.traps) {
      this.scene.remove(trap.mesh);
      this.scene.remove(trap.halo);
      trap.mesh.geometry.dispose();
      trap.mesh.material.dispose();
      trap.halo.geometry.dispose();
      trap.halo.material.dispose();
    }
    this.traps = [];
  }

  // ---------- 玩家道具弹道 ----------
  /**
   * behavior.shots > 1 时一次打出多发（三连深水弹）。多发之间不排队、同时出手，
   * 只把弹速依次 +behavior.gap，靠到达时间差做出「连着三下」的观感——
   * 这样不用引入发射队列状态，也不用担心 reset 时漏清。
   */
  #launchItemShot(item, behavior) {
    const boat = this.localBoat;
    const style = ITEM_SHOTS[item] || DEFAULT_SHOT;
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const volley = Math.max(1, Math.min(5, behavior.shots || 1));
    const speedStep = behavior.shots > 1 ? (behavior.gap || 2) : 0;
    for (let n = 0; n < volley; n++) {
      const pos = {
        x: boat.pos.x + fx * 2.8,
        y: (boat.pos.y || 0) + 1.2,
        z: boat.pos.z + fz * 2.8,
      };
      const shot = {
        item, behavior, speed: style.speed + n * speedStep, life: 2.0, pos,
        // range > 0 的弹道有硬射程（深海鱼叉）：飞完就散，逼玩家贴脸放
        range: behavior.range || 0,
        travelled: 0,
        fxKey: 'shot-' + (this.shotSeq = (this.shotSeq || 0) + 1),
      };
      // 飞行体 = 一段 effekseer 特效，每帧把位置搬过去（playAttached 的 follow 回调）
      this.fx.playAttached(shot.fxKey, style.fx, () => shot.pos, { life: 2.0, loop: true });
      this.projectiles.push(shot);
    }
    // 起手：船头一圈冲击环，明确"从船发出去"
    this.fx.play('ring', boat.pos.x + fx * 2.2, 1.2, boat.pos.z + fz * 2.2, 0.7);
  }

  #updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const boss = this.boss;
      if (!boss || boss.dead) {
        this.#removeShot(i);
        continue;
      }
      const targetY = Math.max(1.8, (boss.def.height || 6) * 0.45);
      const pos = p.pos;
      const dx = boss.pos.x - pos.x;
      const dy = targetY - pos.y;
      const dz = boss.pos.z - pos.z;
      const d = Math.hypot(dx, dy, dz) || 0.001;
      const step = p.speed * dt;
      // 有射程上限的弹道：先累加已飞距离，超了就消失（不结算伤害）
      if (p.range > 0) {
        p.travelled += step;
        if (p.travelled > p.range) {
          this.opts.onToast?.('⚔️ 鱼叉射程不够，空手而归');
          this.#removeShot(i);
          continue;
        }
      }
      if (d <= step + 1.2) {
        this.#hitBossWithItem(p.item, p.behavior);
        this.#removeShot(i);
        continue;
      }
      pos.x += (dx / d) * step;
      pos.y += (dy / d) * step;
      pos.z += (dz / d) * step;
      if (p.life <= 0) this.#removeShot(i);
    }
  }

  #removeShot(i) {
    const p = this.projectiles[i];
    if (!p) return;
    if (p.fxKey) this.fx.stopAttached(p.fxKey);
    this.projectiles.splice(i, 1);
  }

  #clearProjectiles() {
    while (this.projectiles.length) this.#removeShot(this.projectiles.length - 1);
  }

  #hitBossWithItem(item, behavior) {
    const boss = this.boss;
    if (!boss || boss.dead) return;
    const bx = boss.pos.x;
    const bz = boss.pos.z;
    const by = Math.max(1.4, (boss.def.height || 6) * 0.38);
    if (behavior.damage) {
      // 引雷针带 stagger：破韧只在主机结算，非主机端 #dealBossDamage 内部会跳过
      this.#dealBossDamage(behavior.damage, { stagger: behavior.stagger || 0 });
    }
    // 控制类道具的实际 debuff 集合。本地照旧写上，客机还要整包上报主机——
    // BOSS 的 AI 只在主机跑，不送过去的话客机丢的道具对 BOSS 完全无效。
    const status = {};
    switch (item) {
      case 'missile':
        status.slow = 3;
        break;
      case 'ink':
        // 墨鱼改为沉默：BOSS 4 秒内不能起新技能（与章鱼的致盲区分）
        status.silence = behavior.duration || 4;
        this.opts.onToast?.('🔇 墨汁封喉！BOSS 沉默 4 秒，无法起技能');
        break;
      case 'weakspot':
        // 破甲标枪：打开 4 秒虚弱窗口，期间受伤 ×1.6、破韧 ×2
        status.vulnerable = behavior.duration || 4;
        this.opts.onToast?.('🎯 破甲命中！BOSS 虚弱 4 秒，集中火力');
        break;
      case 'harpoon':
        // 深海鱼叉：伤害最高，但射程只有 32 米，命中才给一个短破甲窗口
        status.vulnerable = behavior.duration || 2.5;
        this.opts.onToast?.('⚔️ 鱼叉贯穿！BOSS 破甲 2.5 秒');
        break;
      case 'thunderrod':
        // 引雷针：伤害 + 照搬墨鱼的沉默，额外送 90 点破韧（在伤害结算里）
        status.silence = behavior.duration || 3;
        this.opts.onToast?.('🌩️ 引雷命中！BOSS 被劈麻，沉默 3 秒');
        break;
      case 'bomb':
        // 深水炸弹：把 BOSS 压进水里 3 秒，期间不能放技能、挨打 +25%
        status.dive = 3;
        this.opts.onToast?.('💣 深水炸弹命中！BOSS 被压进水中 3 秒');
        break;
      case 'tide':
        // 方向转换器：BOSS 失控 3 秒，移动反向 + 技能方向随机
        status.reverse = behavior.duration || 3;
        status.confuseCast = behavior.duration || 3;
        this.opts.onToast?.('😈 BOSS 失控！移动方向反转，技能乱放');
        break;
      case 'bubble':
        status.root = behavior.duration || 2;
        break;
      default:
        break;
    }
    for (const key of Object.keys(status)) {
      this.bossStatus[key] = Math.max(this.bossStatus[key] || 0, status[key]);
    }
    // BOSS 被道具命中的专属音效（A 组）
    if (item === 'weakspot') audio.play('weakspot_javelin');
    else if (['ink', 'thunderrod', 'tide', 'bubble'].includes(item)) {
      audio.play('boss_control_hit');
    } else if (['bomb', 'missile', 'vortex', 'fish'].includes(item)) {
      audio.play(`boss_${item}`, { gap: 120 });
    } else if (['harpoon', 'barrage'].includes(item)) {
      // 这两件没有独立音效资源，借用炸弹那一下（gap 保证三连弹不会三重播）
      audio.play('boss_bomb', { gap: 150 });
    }
    if (!this.isHost && Object.keys(status).length) {
      // 客机：状态与主机取最大值叠加；同时让主机把 dive 同步回来，沉水演出两端一致
      this.net?.send({ t: 'bossHit', from: this.myId, hits: [{ id: 'boss', dmg: 0, status }] });
    }
    // 命中特效按道具选择，位置固定在 BOSS 身上（因为弹道已经飞到这里）
    // 三件新道具刻意选了三种不同「材质」：鱼叉=穿刺爆点、三连弹=水花、引雷针=天雷落地，
    // 都和已有道具的特效错开，命中瞬间能凭画面认出丢的是哪件。
    const hitFx = {
      missile: 'missile', bomb: 'explosion', mine: 'explosion', fish: 'explosion',
      vortex: 'explosion', ink: 'fxMonsterRoar',
      decoy: 'decoy', bubble: 'bubble', tide: 'fxDark2',
      weakspot: 'fxSpear1', harpoon: 'fxHarpoonHit', barrage: 'fxWaterImpact',
      thunderrod: 'fxLightningStrike',
    }[item] || 'hit';
    // BOSS 技能特效本身是按大场景制作的，命中时用 1.0 左右即可；旧的小特效维持 3.0
    // 新道具这几段素材是按弹着点做的，3.0 会糊满半个屏幕，所以单独压到 1.0~1.3。
    const fxScale = {
      ink: 1.0, tide: 1.0, weakspot: 1.0,
      harpoon: 1.15, barrage: 1.3, thunderrod: 1.0,
    }[item] ?? 3.0;
    this.fx.play(hitFx, bx, by, bz, fxScale);
    // 三连弹要在同一帧里连播三次水花，间隔拉开一点才听得出是「三下」
    if (item === 'barrage') {
      this.fx.play('fxWaterImpact', bx, by - 0.4, bz, 0.9);
    }
    // 命中反馈：震屏 + 短顿帧 + 爆点，让“打中了”有实感
    this.#shakeCamera(item === 'thunderrod' ? 0.75 : 0.5);
    this.hitStop = Math.max(this.hitStop, item === 'thunderrod' ? 0.075 : 0.055);
    this.#spawnBurst(bx, by, bz, item === 'thunderrod' ? 0xbfe4ff : 0xffd28a, 1.15);
  }

  // ---------- 打击感：震屏 / 爆点 / 伤害飘字 ----------
  #shakeCamera(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  /**
   * 命中反馈：只留火星，**不再生成任何光圈**。
   *
   * 原来这里是"加色白球 + 贴水面白色圆环"，圆环放大到直径 14m、透明度 0.75，
   * 每次打中 BOSS 都会在脚下炸出一圈白环——既看不出打中了什么，又把
   * effekseer 的命中特效盖掉了。现在视觉主体交给 this.fx.play(hitFx)，
   * 这里只补一小撮 three.js 火星（带重力、0.3 秒消失）。
   */
  #spawnBurst(x, y, z, color = 0xffd28a, scale = 1) {
    this.skillFx?.sparks({
      x, y, z,
      color,
      count: Math.round(10 + 8 * scale),
      up: 6 + 3 * scale,
      spread: 4 + 2 * scale,
    });
  }

  /**
   * 小怪近战挥砍：在「小怪 → 目标」的分界面上立一片带电的新月爪痕。
   * 竖立的平面法线朝玩家，玩家从正面看到完整的月牙，读作“它确实挥了一爪”。
   */
  #spawnSlashArc(m, target) {
    const dx = target.boat.pos.x - m.pos.x;
    const dz = target.boat.pos.z - m.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const heading = Math.atan2(dx / d, dz / d);
    // 近战的爪痕要够大：3.2m 起步，血魔这种 4.6m 高的怪直接劈出 ~6.7m 的弯月
    const size = Math.max(3.2, (m.def.fitHeight || 3) * 1.45);
    const reach = (m.def.radius || 2) + 1.4;
    const hx = m.pos.x + Math.sin(heading) * reach;
    const hy = 1.5 + size * 0.48;
    const hz = m.pos.z + Math.cos(heading) * reach;
    // 配了 meleeFx 的小怪（螃蟹的钳击）整段交给 Effekseer，不再画贴图弯月；
    // meleeFx2 是可选的副特效（螃蟹：爪痕之外再补一圈小水花）
    if (m.def.meleeFx) {
      this.fx.play(m.def.meleeFx, hx, hy, hz, m.def.meleeFxScale ?? null);
      if (m.def.meleeFx2) {
        this.fx.play(m.def.meleeFx2, hx, hy, hz, m.def.meleeFx2Scale ?? null);
      }
      return;
    }
    if (!this.slashTex) this.slashTex = makeSlashArcTexture();
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({
      map: this.slashTex,
      color: m.def.slashColor || 0xffb347,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(hx, hy, hz);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = heading;
    mesh.rotation.z = -0.32;
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.arcs.push({ mesh, t: 0, life: 0.34, type: 'ground', tilt: -0.32 });
  }

  /**
   * 小怪远程弹道，两种外观：
   * - `def.projFx`（企鹅冰锥 / 水母放电）：整段交给 Effekseer，粒子每帧跟着
   *   飞行点走，命中再放一发 `projHitFx`。不建任何 three.js 网格。
   * - 默认（血魔）：three.js 自旋新月弯刀的贴图平面。
   * 伤害都在弹体真正飞到目标位置时才结算（见 #updateArcs），
   * 这样"看到东西打到船上"和"掉血"是同一瞬间。
   */
  #spawnFlyingBlade(m, target, dmg) {
    const heading = Math.atan2(
      target.boat.pos.x - m.pos.x,
      target.boat.pos.z - m.pos.z,
    );
    const from = new THREE.Vector3(
      m.pos.x + Math.sin(heading) * (m.def.radius || 2) * 0.85,
      (m.def.fitHeight || 3) * 0.55,
      m.pos.z + Math.cos(heading) * (m.def.radius || 2) * 0.85,
    );
    const to = new THREE.Vector3(target.boat.pos.x, 1.25, target.boat.pos.z);
    const dist = Math.hypot(to.x - from.x, to.z - from.z) || 1;
    // 45m/s 左右：20m 约 0.44s，够看清飞行轨迹
    const life = Math.min(0.7, Math.max(0.24, dist / 45));

    // ---- 纯 Effekseer 弹道 ----
    if (m.def.projFx) {
      const arc = {
        mesh: null, t: 0, type: 'fx', life, from, to, dmg,
        targetId: target.id,
        hitFx: m.def.projHitFx || null,
        pos: from.clone(),
        source: `💢 ${m.def.name}·${m.def.projName || '远程'}`,
      };
      arc.fxKey = `minionProj_${++this.projSeq}`;
      this.arcs.push(arc);
      // follow 每帧读 arc.pos，粒子在飞行轨迹上持续喷出，天然带出尾迹
      this.fx.playAttached(arc.fxKey, m.def.projFx, () => arc.pos, { life: life + 0.06 });
      return;
    }

    // ---- three.js 贴图弯刀（血魔）----
    if (!this.slashTex) this.slashTex = makeSlashArcTexture();
    const size = Math.max(3.4, (m.def.fitHeight || 3) * 1.35);
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshBasicMaterial({
      map: this.slashTex,
      color: m.def.slashColor || 0xff3b52,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = heading;
    mesh.rotation.z = 0.9;
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.arcs.push({
      mesh, t: 0, type: 'blade', life, from, to, spin0: 0.9, dmg,
      targetId: target.id,
      source: `💢 ${m.def.name}·飞刀`,
    });
  }

  // ---------- 巨鲸鲨：吐泡泡（慢速弹幕） ----------

  /**
   * 泡泡外壳材质：一层菲涅尔蓝膜 + 球顶高光。
   * 为什么不用现成的 efk 贴图泡泡：泡泡要"在 3D 空间里慢慢飘 10 秒、能被船撞破"，
   * 尺寸/位置得由 JS 逐帧控制（Effekseer 的粒子位置由它自己的模块算，追不上）；
   * 也不用 MeshPhysicalMaterial 的 transmission —— 那要 envMap + 逐像素折射，
   * 场上同时 6~8 颗泡泡时开销不值。Effekseer 负责"出口"和"破裂"两下爆发，
   * 中间这段膜用一行菲涅尔着色器反而更通透。
   */
  #bubbleMaterial() {
    if (this.bubbleMat) return this.bubbleMat;
    this.bubbleMat = new THREE.ShaderMaterial({
      uniforms: {
        uTint: { value: new THREE.Color(0x8fe4ff) },   // 膜色（蓝）
        uCore: { value: new THREE.Color(0x0e3f74) },   // 内部（深海蓝，让泡泡在亮背景上也有实体感）
        uHi: { value: new THREE.Color(0xe8faff) },     // 高光点
      },
      vertexShader: `
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uTint;
        uniform vec3 uCore;
        uniform vec3 uHi;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vec3 n = normalize(vN);
          vec3 v = normalize(vV);
          // 边缘菲涅尔：气泡的"膜"在最外圈才亮，正面本来就是透的
          float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 2.6);
          // 视线空间固定方向的高光斑：气泡质感全靠这一小片亮，没有它就是个蓝球
          vec3 L = normalize(vec3(0.42, 0.72, 0.55));
          float spec = pow(max(dot(n, L), 0.0), 26.0);
          vec3 col = mix(uCore, uTint, 0.22 + 0.78 * rim);
          col = mix(col, uHi, spec * 0.9);
          float a = 0.26 + 0.60 * rim + spec * 0.55;
          gl_FragColor = vec4(col, clamp(a, 0.0, 0.93));
        }`,
      transparent: true,
      depthWrite: false,
      // 用普通混合而不是加色：终焉关是极夜冰海，背景本来就亮，
      // 加色泡泡在雪白浪花前会整个糊掉，看不出来就躲不掉。
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    return this.bubbleMat;
  }

  #bubbleGeometry() {
    if (!this.bubbleGeo) this.bubbleGeo = new THREE.SphereGeometry(1, 18, 14);
    return this.bubbleGeo;
  }

  /**
   * 吐出一串泡泡。泡泡的世界位置逐帧由 JS 推（`arcs` 里的 type: 'bubble'）：
   * - 速度只有 6m/s 左右，朝"吐出的方向"缓慢修正（转向率 0.5rad/s），
   *   满速 30m/s 的船一脚油门就能甩开，慢船/停船才会被贴上；
   * - 上下轻微起伏（每颗相位错开），看起来是水里的气泡而不是直线导弹；
   * - 碰船即破：扣血 + 破裂特效，漂到寿命也破（不扣血）。
   */
  #spawnBubbles(m, targetId) {
    const count = Math.max(1, m.def.bubbleCount || 2);
    const target = this.players.get(targetId);
    const aimPos = target ? target.boat.pos : m.pos;
    const heading = Math.atan2(aimPos.x - m.pos.x, aimPos.z - m.pos.z);
    const bodyR = m.def.radius || 3;
    const mouthY = (m.def.fitHeight || 2.5) * 0.55;
    const speed = m.def.bubbleSpeed || 6.2;
    const r = 1.35;
    const mat = this.#bubbleMaterial();
    const geo = this.#bubbleGeometry();

    for (let i = 0; i < count; i++) {
      const spread = (i - (count - 1) / 2) * 0.30;
      const dir = heading + spread;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 3;
      mesh.position.set(
        m.pos.x + Math.sin(dir) * bodyR * 0.9,
        mouthY,
        m.pos.z + Math.cos(dir) * bodyR * 0.9,
      );
      mesh.scale.setScalar(r);
      this.scene.add(mesh);
      this.arcs.push({
        type: 'bubble',
        mesh,
        pos: mesh.position.clone(),
        heading: dir,
        baseY: mouthY,
        r,
        speed,
        turn: m.def.bubbleTurn || 0.5,
        age: 0,
        life: m.def.bubbleLife || 10,
        wobble: Math.random() * Math.PI * 2,
        dmg: m.def.bubbleDamage || 8,
        targetId,
        source: `🫧 ${m.def.name}·泡泡`,
        t: 0,          // `#updateArcs` 里通用的计时字段，泡泡只把它当播放进度
        shared: true,  // 几何体/材质是全池共用的，销毁时不能 dispose
      });
    }
    // 出口那一口气：嘴部位置播一发蓝色水环（fxMagic1Water 按 0.2 倍缩放）
    this.fx?.play('fxMagic1Water', m.pos.x + Math.sin(heading) * bodyR, mouthY,
      m.pos.z + Math.cos(heading) * bodyR, 0.2);
  }

  /** 泡泡破裂：先放特效再结算伤害（伤害只结算本机，其它船各自算自己的） */
  #popBubble(a, i, hitPlayer = null) {
    this.fx?.play('fxMagic1Water', a.pos.x, a.pos.y, a.pos.z, 0.55);
    this.fx?.play('minionWaterSplash', a.pos.x, 0.6, a.pos.z, 0.14);
    if (hitPlayer) {
      this.#damagePlayer(hitPlayer.id, a.dmg, {
        awayFrom: { x: a.pos.x, z: a.pos.z },
        source: a.source,
        // 泡泡是碰撞伤害：终盘那两关也要真的掉血，否则「碰到掉血」等于没做
        hp: true,
      });
    }
    this.#disposeArc(a, i);
  }

  #disposeArc(a, i) {
    // Effekseer 弹道没有网格，只有一条跟随句柄要停
    if (a.fxKey) this.fx.stopAttached(a.fxKey);
    if (a.mesh) {
      this.scene.remove(a.mesh);
      // 泡泡的球体几何与材质是全池共用的，逐个 dispose 会让剩下的泡泡一起变黑
      if (!a.shared) {
        a.mesh.geometry.dispose();
        a.mesh.material.dispose();
      }
    }
    this.arcs.splice(i, 1);
  }

  /** 弹体飞到终点时的统一结算：先播命中特效，再扣本机血 */
  #resolveArcHit(a) {
    if (a.hitFx) this.fx.play(a.hitFx, a.to.x, a.to.y, a.to.z);
    if (a.targetId !== this.myId) return;
    const p = this.players.get(a.targetId);
    if (!p?.alive) return;
    this.#damagePlayer(a.targetId, a.dmg, {
      awayFrom: { x: a.from.x, z: a.from.z },
      source: a.source,
    });
  }

  #updateArcs(dt) {
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.t += dt;
      const k = Math.min(1, a.t / a.life);
      // 纯 Effekseer 弹道：只推飞行点，画面全交给粒子
      if (a.type === 'fx') {
        a.pos.lerpVectors(a.from, a.to, k);
        if (k >= 1) {
          this.#resolveArcHit(a);
          this.#disposeArc(a, i);
        }
        continue;
      }
      if (a.type === 'blade') {
        a.mesh.position.lerpVectors(a.from, a.to, k);
        // 飞行中自旋：新月刀身转起来才有“甩出去”的感觉
        a.mesh.rotation.z = a.spin0 + k * 9.5;
        a.mesh.scale.setScalar(0.8 + k * 0.3);
        a.mesh.material.opacity = (1 - k * 0.12) * 0.95;
        if (k >= 1) {
          this.#spawnBurst(a.to.x, a.to.y, a.to.z, a.mesh.material.color.getHex(), 1.3);
          this.#resolveArcHit(a);
          this.#disposeArc(a, i);
        }
        continue;
      }
      if (a.type === 'bubble') {
        a.age += dt;
        // 朝目标缓慢修正：转向率有限，所以"绕着开"能甩掉，直线硬冲才会被糊上
        const holder = this.players.get(a.targetId);
        if (holder?.alive) {
          const want = Math.atan2(holder.boat.pos.x - a.pos.x, holder.boat.pos.z - a.pos.z);
          let diff = want - a.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const maxTurn = a.turn * dt;
          a.heading += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
        }
        a.pos.x += Math.sin(a.heading) * a.speed * dt;
        a.pos.z += Math.cos(a.heading) * a.speed * dt;
        // 水里上下轻微起伏 + 自转：静止的球看着像贴图，动起来才像泡
        a.pos.y = a.baseY + Math.sin(a.age * 2.1 + a.wobble) * 0.32;
        a.mesh.position.copy(a.pos);
        a.mesh.rotation.y += dt * 0.8;
        a.mesh.rotation.x += dt * 0.35;
        const pulse = 1 + Math.sin(a.age * 3.3 + a.wobble) * 0.05;
        a.mesh.scale.setScalar(a.r * pulse);

        // 碰船即破：横向距离按泡泡半径 + 船体 2.2m，竖直方向给 3.2m 容差。
        // 任何一艘船碰上都会破（多人时队友也能替你挡），但只结算本机那一份伤害。
        let popMe = null;
        let hitAny = false;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          const dx = p.boat.pos.x - a.pos.x;
          const dz = p.boat.pos.z - a.pos.z;
          if (Math.hypot(dx, dz) > a.r + 2.2) continue;
          if (Math.abs((p.boat.pos.y || 0) - a.pos.y) > 3.2) continue;
          hitAny = true;
          if (p.id === this.myId) popMe = p;
        }
        if (hitAny) {
          this.#popBubble(a, i, popMe);
          continue;
        }
        if (a.age >= a.life) {
          this.#popBubble(a, i);
          continue;
        }
        continue;
      }
      // 近战爪痕：略微放大并斜着滑过去，再快速淡出
      a.mesh.scale.setScalar(0.85 + k * 0.6);
      a.mesh.rotation.z = a.tilt - k * 0.35;
      a.mesh.material.opacity = (1 - k) * 0.95;
      if (k >= 1) this.#disposeArc(a, i);
    }
  }

  #clearArcs() {
    for (const a of this.arcs) {
      if (a.fxKey) this.fx.stopAttached(a.fxKey);
      if (!a.mesh) continue;
      this.scene.remove(a.mesh);
      if (!a.shared) {
        a.mesh.geometry.dispose();
        a.mesh.material.dispose();
      }
    }
    this.arcs = [];
  }

  #updateBursts(dt) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.t += dt;
      const k = Math.min(1, b.t / b.life);
      b.core.scale.setScalar(b.scale * (0.6 + k * 4.2));
      b.core.material.opacity = (1 - k) * 0.95;
      b.ring.scale.setScalar(b.scale * (0.5 + k * 7));
      b.ring.material.opacity = (1 - k) * 0.75;
      if (k >= 1) {
        this.scene.remove(b.core, b.ring);
        b.core.geometry.dispose();
        b.core.material.dispose();
        b.ring.geometry.dispose();
        b.ring.material.dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  #clearBursts() {
    for (const b of this.bursts) {
      this.scene.remove(b.core, b.ring);
      b.core.geometry.dispose();
      b.core.material.dispose();
      b.ring.geometry.dispose();
      b.ring.material.dispose();
    }
    this.bursts = [];
  }

  #ensureDmgLayer() {
    if (this.dmgLayer && this.dmgLayer.isConnected) return this.dmgLayer;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:40;';
    document.body.appendChild(layer);
    this.dmgLayer = layer;
    return layer;
  }

  /** 伤害飘字：投影到屏幕坐标后向上飘并淡出 */
  #spawnDamageText(amount, x, y, z, crit = false) {
    if (!this.camera || typeof document === 'undefined') return;
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return;
    const px = (v.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const el = document.createElement('div');
    el.textContent = `-${Math.round(amount)}`;
    el.style.cssText = `position:absolute;left:${px}px;top:${py}px;`
      + 'transform:translate(-50%,-50%);white-space:nowrap;font-weight:800;'
      + `font:800 ${crit ? 30 : 22}px/1 system-ui,-apple-system,sans-serif;`
      + `color:${crit ? '#ffd166' : '#ffffff'};`
      + 'text-shadow:0 0 8px rgba(255,120,40,.9),0 2px 4px rgba(0,0,0,.65);';
    this.#ensureDmgLayer().appendChild(el);
    el.animate([
      { transform: 'translate(-50%,-50%) scale(.7)', opacity: 1 },
      { transform: 'translate(-50%,-170%) scale(1.15)', opacity: 0 },
    ], { duration: 720, easing: 'cubic-bezier(.2,.7,.3,1)' })
      .onfinish = () => el.remove();
  }

  // ---------- 网络 ----------
  #sendSync(dt) {
    this.syncTimer -= dt;
    if (this.syncTimer > 0) return;
    this.syncTimer = 0.1;
    const b = this.boss;
    if (!b) return;
    this.net?.send({
      t: 'bossState', stage: this.stage, phase: this.phase,
      hp: b.hp / b.maxHp, x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2),
      h: +b.heading.toFixed(3), dead: b.dead,
      // 破韧槽进度：客机不跑 addStagger，但顶部 HUD 的槽要靠这条同步涨起来；
      // 真正的“进入跪地”仍由 bossStagger 触发，这里只同步数值
      ...(b.staggerMax > 0 ? { stagger: b.stagger / b.staggerMax } : {}),
      // 深水炸弹的压制时长也要同步：客机的 BOSS 只跟位姿，不看 AI 状态，
      // 不单独下发的话客机永远看不到它被压进水里（只剩主机有沉水演出）
      ...(this.bossStatus.dive > 0 ? { dive: +this.bossStatus.dive.toFixed(2) } : {}),
      // 传送门坐标随状态一起下发：只靠那一条一次性的 bossPortal，
      // 客机一旦错过（切后台被节流 / 重连）就再也看不到门，整局卡在结算页。
      ...(this.portal ? { px: +this.portal.x.toFixed(2), pz: +this.portal.z.toFixed(2) } : {}),
      // 海克斯：房主选定的本局核心随状态下发，客机的伤害倍率与 HUD 才能跟上
      ...(this.variant === 'hex' && this.hexCoreId ? { hexCore: this.hexCoreId } : {}),
      // 状态条要全队一致：虚弱/沉默/失控等由主机下发，客机只取较大值
      status: {
        slow: +this.bossStatus.slow.toFixed(2),
        blind: +this.bossStatus.blind.toFixed(2),
        confuse: +this.bossStatus.confuse.toFixed(2),
        silence: +this.bossStatus.silence.toFixed(2),
        reverse: +this.bossStatus.reverse.toFixed(2),
        vulnerable: +this.bossStatus.vulnerable.toFixed(2),
      },
    });
  }

  /**
   * 客机追帧：阶段机在客机是**本地推**的（intro/countdown/clear 全靠自己的计时器），
   * 主机那边只管把 phase 塞进 bossState 每 0.1 秒广播一次。浏览器标签页切到后台时
   * requestAnimationFrame 会被节流到几乎不跑，切回来就可能还停在 countdown，
   * 而主机早就打完、开门、甚至进下一关了 —— 表现就是"客机倒计时都没结束 / 卡在结算页"。
   *
   * 所以这里以主机为准做一次纠正，但**只往前拉、不往回拽**：
   * 客机自己可以从 countdown 走到 fight，主机也已经接受这个节奏；
   * 只有「主机已经到了终局阶段，客机还停在战斗里」才需要纠正。
   */
  #adoptHostState(msg) {
    // 关卡落后多少都直接追上。以前只认 stage+1，漏掉一条 bossStage 就永久落后。
    if (msg.stage && msg.stage !== this.stage) {
      this.startStage(msg.stage);
      return;
    }
    const host = msg.phase;
    if (!host || host === this.phase) {
      // 阶段一致时只补一件事：主机已经开门但本机还是 clear（漏了 bossPortal）
      if (host === 'portal' && !this.portal && Number.isFinite(msg.px)) {
        this.#openPortal({ x: msg.px, z: msg.pz });
      }
      return;
    }
    if (host === 'victory' || host === 'defeat') {
      this.phase = host;
      return;
    }
    if (host !== 'clear' && host !== 'portal') return;
    // 主机已经打完 BOSS，客机还在 intro/countdown/fight：让 BOSS 走一次正常死亡流程，
    // 分关结算面板、特效、统计都会照常触发，比直接改 phase 干净
    if (this.phase === 'intro' || this.phase === 'countdown' || this.phase === 'fight') {
      if (this.boss && !this.boss.dead) {
        this.boss.applyDamage(this.boss.maxHp);
        return; // 下一帧的 bossState 再决定要不要开门
      }
      this.phase = 'clear';
      this.clearT = BOSS_PORTAL.delay;
    }
    if (host === 'portal' && this.phase !== 'portal') {
      // 门的位置由主机定：本机不能自己抽签，否则两端看到的是两道门
      if (Number.isFinite(msg.px)) this.#openPortal({ x: msg.px, z: msg.pz });
      else this.phase = 'portal';   // 等那条 bossPortal 补坐标
    }
  }

  handleNet(msg) {
    if (msg.t === 'bossState') {
      // 海克斯：房主选定的核心同步给客机（客机不自己抽）
      if (msg.hexCore && this.variant === 'hex' && !this.hexCorePicked) {
        this.hexCorePicked = true;
        this.hexCoreId = msg.hexCore;
        this.hexCoreTimer = 0;
        this.hexMods = combineMods(
          mergeMods([msg.hexCore], HEX_CORES),
          mergeMods(this.hexEntry?.rules || [], HEX_RULES),
        );
        this.#applyHexStagePlayers();
        const def = HEX_CORES.find((c) => c.id === msg.hexCore);
        if (def) this.opts.onToast?.(`${def.icon} 本局核心：${def.name}`);
        this.opts.onHexCards?.(null);
      }
      if (!this.isHost) this.#adoptHostState(msg);
      if (this.boss) {
        this.boss.setNetState({
          x: msg.x, z: msg.z, h: msg.h, hp: msg.hp * this.boss.maxHp,
          stagger: msg.stagger,
          // 主机通报 BOSS 已死：客机必须自己也走一遍 onDeath，
          // 否则客户端永远停在 fight、看不到分关结算面板
          ...(msg.dead ? { state: 'dying' } : {}),
        });
      }
      // 主机压制的沉水时间同步过来，客机才能看到 BOSS 沉下去/浮上来
      if (msg.dive) this.bossStatus.dive = Math.max(this.bossStatus.dive || 0, msg.dive);
      // 主机权威状态同步：客机的状态条与伤害倍率都按主机的为准
      if (msg.status && !this.isHost) {
        for (const key of Object.keys(msg.status)) {
          this.bossStatus[key] = Math.max(this.bossStatus[key] || 0, msg.status[key] || 0);
        }
      }
      return;
    }
    if (msg.t === 'bossHit') {
      for (const hit of msg.hits || []) {
        if (hit.id === 'boss') {
          // BOSS 血量以主机为准；客机只上报，不重复扣血
          if (this.isHost && this.boss) {
            this.boss.applyDamage(hit.dmg);
            // 客机打出的韧性增量由主机统一结算，满槽时主机广播 bossStagger
            if (hit.stagger && this.boss.addStagger(hit.stagger)) this.#onBossStagger();
            // 客机用控制类道具：AI 只在主机跑，必须把 debuff 叠到主机的权威状态上
            if (hit.status) {
              for (const key of Object.keys(hit.status)) {
                this.bossStatus[key] = Math.max(this.bossStatus[key] || 0, hit.status[key] || 0);
              }
            }
          }
          this.#addAggro(msg.from, hit.dmg);
        } else if (hit.id === this.myId) {
          // 主机算出的技能命中，同步扣本地玩家的血；
          // src 是主机带过来的伤害来源标签，阵亡面板据此显示“被什么打死”
          this.#damagePlayer(this.myId, hit.dmg, {
            knockback: false,
            source: hit.src || '👹 BOSS',
          });
          // 落雷/霜雪吐息命中还带限速：主机算出来，本端自己压自己的船
          if (hit.slow) {
            const speed = hit.slowSpeed || BOSS_THUNDER.slowSpeed;
            const label = hit.label || (hit.slowSpeed === BOSS_THUNDER.slowSpeed
              ? '⚡ 被雷击' : '❄ 被霜雪冻住');
            this.#applySlow(this.players.get(this.myId), speed, hit.slow, label,
              label.includes('漩涡') ? { variant: 'scroll' } : undefined);
          }
          // 焚风灼膛：主机算出的缴械时长，本端自己挂到自己的状态上
          if (hit.lock) this.#lockWeapon(this.players.get(this.myId), hit.lock);
        }
      }
      return;
    }
    if (msg.t === 'bossStagger') {
      // 主机判定破韧：客机本地进入跪地（计时/动画/伤害窗口都按同一时长推进），
      // 顶部提示和星星由本机播放，不再回传
      if (this.boss && this.boss.beginStagger(msg.dur)) this.#onBossStagger();
      return;
    }
    if (msg.t === 'bossPortal') {
      // 主机抽签的门的落点：客机按同一坐标升起，画面和判定才是同一道门
      if (this.phase === 'portal' || this.phase === 'clear') this.#openPortal({ x: msg.x, z: msg.z });
      return;
    }
    if (msg.t === 'bossAltarSpawn') {
      // 主机挑的祭坛落点：客机按同一坐标升起，画面上才是同一座祭坛
      this.#spawnBloodAltar(
        Number(msg.x) || 0,
        Number(msg.z) || 0,
        Number(msg.life) || BOSS_BLOOD_ALTAR.life,
      );
      return;
    }
    if (msg.t === 'bossAltarDone') {
      const a = this.bloodAltar;
      const x = a?.x ?? 0;
      const z = a?.z ?? 0;
      const fallback = Math.max(1, Math.round((this.boss?.maxHp || 1) * BOSS_BLOOD_ALTAR.damagePct));
      // 客机完成的献祭：血量由主机结算，主机再把带伤害值的版本广播给其他人
      if (this.isHost && !msg.dmg) {
        this.#dealBossDamage(msg.dmg ? msg.dmg : fallback, { owner: msg.by, pos: { x, z } });
        this.bloodAltarT = BOSS_BLOOD_ALTAR.interval;
        this.net?.send({ t: 'bossAltarDone', by: msg.by, dmg: fallback });
      }
      if (a) {
        this.fx.play('fxMagicDark', x, 1.8, z, 2.4);
        this.fx.play('fxThunderRing', x, 0.6, z, 2.0);
      }
      this.#clearBloodAltar();
      return;
    }
    if (msg.t === 'bossReady') {
      // 准备状态：自己的本地权威，别人的（含主机代算的 AI）以广播为准
      if (msg.id === this.myId || !this.portal) return;
      if (msg.ready) this.portal.ready.add(msg.id);
      else this.portal.ready.delete(msg.id);
      this.#paintPortalLabel();
      return;
    }
    if (msg.t === 'bossComboState') {
      // 队友的协同进度：只用来显示，蓄力本身仍在各自客户端
      if (msg.from === this.myId) return;
      const c = Math.max(0, Math.min(100, Number(msg.c) || 0));
      this.comboPeers.set(msg.from, { charge: c, t: 2 });
      return;
    }
    if (msg.t === 'bossComboArm') {
      // 两边都在预备窗口里按下了 F 才算合击：id 小的一方负责结算与广播，避免双份伤害
      if (!this.comboArmed || !this.comboReady) return;
      const p = this.players.get(msg.from);
      if (!p?.alive || !this.localBoat) return;
      const d = Math.hypot(
        p.boat.pos.x - this.localBoat.pos.x,
        p.boat.pos.z - this.localBoat.pos.z,
      );
      if (d > 26) return;
      if (this.myId < msg.from) this.#fireCombo(p);
      return;
    }
    if (msg.t === 'bossComboFire') {
      // 队友发起的合击：照抄同一套 Effekseer 特效，伤害由发起者结算
      this.#playComboFx(msg.ax, msg.az, msg.bx, msg.bz);
      this.#shakeCamera(0.7);
      this.hitStop = Math.max(this.hitStop, 0.05);
      this.comboCharge = 0;
      this.comboReady = false;
      this.comboArmed = false;
      this.comboArmT = 0;
      this.comboCd = 14;
      const name = this.order?.find((e) => e.id === msg.from)?.name || '队友';
      this.opts.onToast?.(`🤝 ${name} 与你协同合击！BOSS 破防 3 秒`);
      return;
    }
    if (msg.t === 'bossDown') {
      // 队友沉船：本地同步“已沉船”状态并立起救生圈，等待谁去救
      const p = this.players.get(msg.id);
      if (p && p.alive) {
        p.alive = false;
        p.hp = 0;
        p.boat.applyFx('sink', 2.4);
        if (p.revives > 0) {
          p.respawn = PLAYER_RESCUE_WINDOW;
          p.rescueT = PLAYER_RESCUE_WINDOW;
          this.#spawnRescueMarker(p);
        }
      }
      // 队友的死亡状态到齐之后，主机也要重新判一次全队存活：
      // 否则最后一艘船死在客机上时，主机永远收不到判负。
      this.#checkDefeat();
      return;
    }
    if (msg.t === 'bossRescue') {
      const p = this.players.get(msg.id);
      if (p && !p.alive) this.#rescuePlayer(p);
      return;
    }
    if (msg.t === 'bossThunder') {
      // 客机：落点由主机算，这里只负责把红色预警圈画出来。
      // 伤害和限速由主机结算后通过 bossHit 下发，避免两端各判一次。
      this.#showThunderWarn(msg.x, msg.z);
      return;
    }
    if (msg.t === 'bossVortex') {
      // 客机：只把跟人的龙卷画出来；伤害/减速等主机的 bossHit
      this.#clearVortex();
      this.vortex = {
        phase: 'warn', t: 0,
        warnDur: msg.warnDur || BOSS_VORTEX_CHASE.telegraph,
        x: msg.x, z: msg.z,
        targetId: msg.targetId, dur: msg.dur || BOSS_VORTEX_CHASE.duration,
        tick: 0,
      };
      return;
    }
    if (msg.t === 'healPack') {
      // 队友吃到了血包：本地把同一个收掉，别看起来还留在场上
      for (let i = this.healPacks.length - 1; i >= 0; i--) {
        const pk = this.healPacks[i];
        if (Math.hypot(pk.x - msg.x, pk.z - msg.z) > 1.5) continue;
        this.#removeHealPack(i);
        break;
      }
      return;
    }
    if (msg.t === 'healSpawn') {
      // 主机刷出了血包：客机在同一个坐标摆一个（以前各自 Math.random 选点，两端对不上）
      if (Number.isFinite(msg.x) && Number.isFinite(msg.z)) {
        if (!this.healPacks.some((pk) => Math.hypot(pk.x - msg.x, pk.z - msg.z) < 1.5)) {
          this.#spawnHealPack(msg.x, msg.z);
        }
      }
      return;
    }
    if (msg.t === 'fireCoreSpawn') {
      // 主机刷出了火力核心：客机在同一个位置摆一枚
      if (!this.fireCores.length) this.fireCores.push(this.#makeFireCore(msg.x, msg.z));
      return;
    }
    if (msg.t === 'fireCore') {
      // 别人吃掉了：本地也收掉（强化只加在吃的人身上，自己那份不共享）
      if (msg.by !== this.myId) {
        this.#clearFireCores();
        // 主机收到客机吃掉的消息后必须重置刷新计时，
        // 否则下一帧 fireCoreT 仍是 0，会立刻再刷一枚
        this.fireCoreT = BOSS_FIRE_CORE.interval;
      }
      return;
    }
    if (msg.t === 'bossCoreWave') {
      // 主机升起四枚核心：客机在同一批位置摆出同样的特效
      this.#clearCoreWave();
      const cores = (msg.cores || []).map((c) => ({
        i: c.i, x: c.x, z: c.z, hp: BOSS_CORE_WAVE.hp, max: BOSS_CORE_WAVE.hp,
      }));
      this.coreWave = { cores, left: BOSS_CORE_WAVE.window };
      for (const c of cores) this.#showCore(c);
      this.opts.onToast?.(
        `🔶 能量核心升起！${BOSS_CORE_WAVE.window} 秒内打掉 ${BOSS_CORE_WAVE.count} 枚才出弱点窗口`,
      );
      return;
    }
    if (msg.t === 'bossCoreHit') {
      if (msg.from !== this.myId) this.#damageCore(msg.i, msg.dmg);
      return;
    }
    if (msg.t === 'bossCoreWin') {
      // 主机确认四核全破：客机同步弱点窗口（伤害倍率在 #dealBossDamage 里按 weakT 统一算）
      this.weakT = msg.dur || BOSS_CORE_WAVE.weaknessTime;
      this.#clearCoreWave();
      this.fx?.play('fxMagic2Holy', this.boss?.pos.x ?? 0, 0.6, this.boss?.pos.z ?? 0, 3.4);
      this.opts.onToast?.(`💥 四核全破！弱点窗口 ${Math.round(this.weakT)} 秒`);
      return;
    }
    if (msg.t === 'bossCoreWaveEnd') {
      this.#clearCoreWave();
      return;
    }
    if (msg.t === 'bossCast') {
      // 延迟补偿：预警时长扣掉一半 RTT（这条消息从主机走到本机花掉的时间），
      // 红圈才会和主机在同一瞬间消失。不扣的话客机永远慢半拍——
      // 观感就是“圈还亮着，人已经被打飞了”。最多扣 0.4 秒，避免弱网时圈直接不显示。
      const lag = Math.min(0.4, (Number(this.net?.rtt) || 0) / 2000);
      // 熔岩追猎这类"跟人走"的红圈必须带上目标 id，客机才知道该追谁
      this.boss?.showWarning(
        msg.skill, msg.x, msg.z, msg.h,
        Math.max(0.25, (msg.dur || 1.2) - lag), msg.target ?? null,
      );
      // 客机也要看到蓄力演出（嘴前汇聚 / 血云 / 漩涡），否则红圈亮 3 秒才突然炸开
      const skill = BOSS_SKILLS[msg.skill];
      if (skill) this.#playSkillVisual(skill, { x: msg.x, z: msg.z, heading: msg.h }, 'cast');
      return;
    }
    if (msg.t === 'bossSkill') {
      // 主机结算后的技能演出：客机自己也放一遍（判定仍由主机算）。
      // bossHit 稍后会单独下发，所以这里绝不能碰 #damagePlayer。
      const skill = BOSS_SKILLS[msg.skill];
      if (!skill || !this.boss) return;
      const info = { x: msg.x, z: msg.z, heading: msg.h, ox: msg.ox, oz: msg.oz };
      if (skill.kind === 'pull') {
        // 客机也要被吸：本端的船由本端物理模拟，所以吸取状态本地开一份
        this.#beginPull(skill, info, false);
      } else if (skill.kind === 'geyser') {
        this.#resolveGeyserSkill(skill, info);
      } else if (skill.kind === 'screen') {
        this.#resolveScreenSkill(skill, info);
      } else if (skill.kind === 'blink') {
        // 客机不挪 BOSS 位置（主机的 bossState 会同步），只补残影和落点雾气
        this.skillFx.residue(skill.visual || 'blood', {
          x: this.boss.pos.x, z: this.boss.pos.z, height: (this.boss.def.height || 7) * 0.9,
        });
        this.skillFx.ringBurst(skill.visual || 'blood', {
          x: msg.x, z: msg.z, radius: 8, count: 40, up: 10,
        });
        this.#shakeCamera(0.4);
      } else if (skill.kind === 'slam') {
        // 客机：落地雷柱 + 余波环都本地演一遍，伤害由主机的 bossHit 下发
        this.#resolveSlamSkill(skill, info, false);
      } else if (skill.kind === 'rain') {
        // 客机：落点用同一套确定性螺旋复算，只演特效、不结算（判定由主机下发）
        this.#resolveRainSkill(skill, info, false);
      } else if (skill.kind === 'wave') {
        // 客机：本地也推一道火墙，伤害由主机的 bossHit 下发
        this.#resolveLavaWave(skill, info);
        this.#playSkillVisual(skill, info, 'hit');
      } else if (skill.kind === 'zone') {
        // 客机：触手圈本地演一遍（判定在主机），客机也能看到自己被缠
        this.#beginShadowZone(skill, info);
        this.#playSkillVisual(skill, info, 'hit');
      } else if (skill.kind === 'rift') {
        // 客机：三根水柱的落点只依赖 info，本地复算完全一致
        this.#resolveRift(skill, info);
      } else if (skill.kind === 'gate') {
        // 客机：只演门，不刷怪（怪由 bossSummon 下发）
        this.#beginSummonGate(skill, info);
      } else if (skill.kind === 'grid') {
        this.#beginGridThunder(skill, info);
      } else if (skill.kind === 'laser') {
        this.#beginLaserSweep(skill, info);
      } else {
        this.#playSkillVisual(skill, info, 'hit');
      }
      return;
    }
    if (msg.t === 'bossPillar') {
      // 主机立的安全柱：客机也要看到（只剩一人时全屏大招的唯一解法）
      this.#spawnSafePillar(msg.x || 0, msg.z || 0, msg.r || 6.2);
      return;
    }
    if (msg.t === 'bossSummon') {
      this.#spawnMinions(msg.entries || []);
      return;
    }
    if (msg.t === 'bossLava') {
      // kind 缺省 = 老存档/老房主的熔岩柱，保持兼容
      for (const z of msg.zones || []) this.#addHazardZone(z.x, z.z, msg.kind || 'lava');
      return;
    }
    if (msg.t === 'bossLure') {
      if (this.isHost && this.boss) {
        this.boss.lure = { x: msg.x, z: msg.z, t: msg.dur || 3 };
      }
      return;
    }
    if (msg.t === 'bossStage') {
      // 海克斯：先按房主 seed 复现整局计划，再开对应关卡（hexStages 让无尽续层长度一致）
      if (msg.hexSeed && this.variant === 'hex'
        && (!this.hexPlan || this.hexPlan.seed !== msg.hexSeed
          || this.hexPlan.stages.length < (msg.hexStages || 4))) {
        this.hexPlan = buildRunPlan(msg.hexSeed, Math.max(msg.hexStages || 4, msg.stage || 1));
        this.hexWaiting = false;
        this.startStage(msg.stage || 1);
        return;
      }
      if (this.hexWaiting) {
        this.hexWaiting = false;
        this.startStage(msg.stage || 1);
        return;
      }
      if (msg.stage !== this.stage) this.startStage(msg.stage);
      return;
    }
    if (msg.t === 'bossEnd') {
      if (msg.victory) {
        this.phase = 'victory';
        this.opts.onVictory?.({
          stages: this.stageResults,
          totalTime: msg.totalTime,
          grade: msg.grade || 'C',
          damage: msg.damage || [],
          taken: msg.taken || [],
          takenBy: msg.takenBy || [],
          endlessStage: msg.endlessStage,
          // 客机用自己的计划与选卡生成回顾（seed 与房主一致）
          hex: this.#hexReview(),
        });
      } else {
        this.phase = 'defeat';
        const data = this.#resultData(false);
        // 输出/承伤统计以主机为准：客机本地只算得到自己那一部分
        if (msg.damage) data.damage = msg.damage;
        if (msg.taken) data.taken = msg.taken;
        if (msg.takenBy) data.takenBy = msg.takenBy;
        this.opts.onDefeat?.(data);
      }
    }
  }

  /** 全队按来源汇总的承伤（结算面板“伤害来源”一栏的数据源） */
  #takenTotals() {
    const out = new Map();
    for (const p of this.players.values()) {
      for (const [source, dmg] of p.takenBy || []) {
        out.set(source, (out.get(source) || 0) + dmg);
      }
    }
    return [...out.entries()]
      .map(([source, dmg]) => ({ source, dmg: Math.round(dmg) }))
      .sort((a, b) => b.dmg - a.dmg);
  }

  #resultData(victory) {
    return {
      victory,
      stages: this.stageResults,
      stage: this.stage,
      // 海克斯按「层」计数（无尽续层），UI 用它决定显示“关 / 层”
      layer: this.variant === 'hex',
      totalTime: this.stageResults.reduce((s, r) => s + r.elapsed, 0),
      damage: [...this.damageByPlayer.entries()].map(([id, dmg]) => ({
        id, name: this.order.find((e) => e.id === id)?.name || id, dmg,
        me: id === this.myId,
      })),
      taken: [...this.players.values()].map((p) => ({
        id: p.id,
        name: this.order.find((e) => e.id === p.id)?.name || p.id,
        taken: Math.round(p.taken || 0),
        me: p.id === this.myId,
      })),
      takenBy: this.#takenTotals(),
      // 海克斯本局回顾：核心 / 拿到的卡牌 / 每关构成（结算面板用）
      hex: this.#hexReview(),
    };
  }

  /** 海克斯本局回顾数据：只做展示，不参与结算数值 */
  #hexReview() {
    if (this.variant !== 'hex' || !this.hexPlan) return null;
    const find = (pool, id) => pool.find((x) => x.id === id);
    return {
      seed: this.hexPlan.seed,
      boatId: this.order?.find((e) => e.id === this.myId)?.boatId || null,
      core: this.hexCore
        ? { id: this.hexCore.id, name: this.hexCore.name, icon: this.hexCore.icon }
        : null,
      cards: this.hexCardsPicked
        .map((id) => find(HEX_CARDS, id))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, icon: c.icon, rarity: c.rarity })),
      // 只回顾实际打过的层：无尽计划会预先延长，没打到的不该出现在结算里
      stages: this.hexPlan.stages.slice(0, Math.max(1, this.stage)).map((s, i) => ({
        stage: i + 1,
        bossName: BOSSES[s.bossId]?.name || '',
        rules: (s.rules || [])
          .map((id) => find(HEX_RULES, id))
          .filter(Boolean)
          .map((r) => ({ name: r.name, icon: r.icon, negative: !!r.negative })),
        hazards: (s.hazards || [])
          .map((h) => find(HEX_HAZARDS, h.id))
          .filter(Boolean)
          .map((h) => ({ name: h.name, icon: h.icon })),
      })),
    };
  }

  // ---------- 相机 ----------
  // 过场：4 段运镜。战斗阶段交回 CameraRig 的追尾机位，
  // 只把注视点锁在 BOSS 身上（不是绕 BOSS 转的俯视轨道镜头）。
  updateCamera(camera, dt) {
    this.camera = camera;
    if (!this.boss || this.phase !== 'intro') return false;
    // 按放慢后的时间轴取段，并对每段做 smoothstep，镜头不会在关键帧上突然加速
    const t = this.introT / BOSS_INTRO_TIME_SCALE;
    const boss = this.boss;
    const bx = boss?.pos.x || 0;
    const bz = boss?.pos.z || 0;
    const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
    const ease = (k) => { const x = Math.max(0, Math.min(1, k)); return x * x * (3 - 2 * x); };
    let px, py, pz, tx, ty, tz;
    if (t < 1.2) {
      const k = ease(t / 1.2);
      px = 0; py = lerp(78, 54, k); pz = lerp(150, 120, k);
      tx = 0; ty = 2; tz = 0;
    } else if (t < 3.0) {
      const k = ease((t - 1.2) / 1.8);
      px = lerp(0, 14, k); py = lerp(54, 20, k); pz = lerp(120, 56, k);
      tx = bx; ty = 4; tz = bz;
    } else if (t < 4.6) {
      const k = ease((t - 3.0) / 1.6);
      px = lerp(14, bx + 22, k); py = lerp(20, 13, k); pz = lerp(56, bz + 34, k);
      tx = bx; ty = 5; tz = bz;
    } else {
      const k = ease((t - 4.6) / 1.0);
      px = lerp(bx + 22, bx + 26, k); py = lerp(13, 15, k); pz = lerp(bz + 34, bz + 40, k);
      tx = bx; ty = 5; tz = bz;
    }
    camera.position.set(px, py, pz);
    camera.lookAt(tx, ty, tz);
    return true;
  }

  /** 战斗阶段的镜头注视点：BOSS 胸口高度 */
  getLockTarget() {
    // 传送门阶段要玩家自己把船开进门里，镜头必须回到正常追尾，
    // 不能再锁在 BOSS 尸体上（否则整段路都是背对门开车）
    if (!this.boss || this.phase === 'portal') return null;
    return {
      x: this.boss.pos.x,
      y: Math.max(3.2, (this.boss.def?.height || 7) * 0.42),
      z: this.boss.pos.z,
    };
  }

  /** 命中震屏：由 Game 在追尾相机摆好之后叠加 */
  applyCameraShake(camera, dt) {
    if (this.shake <= 0.001) return;
    // 震动幅度乘设置里的强度（0 = 完全不抖）。缩放放在消费点而不是发起处：
    // 发起处有十几处调用，还夹着直接写 this.shake 的地方，漏一个就"关了还在抖"。
    const s = this.shake * (this.shakeScale ?? 1);
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s * 0.5;
    camera.position.z += (Math.random() - 0.5) * s;
    this.shake = Math.max(0, this.shake - dt * 14);
  }

  dispose() {
    this.#clearBoss();
    this.#clearMinions();
    this.#clearProjectiles();
    this.#clearBursts();
    this.#clearArcs();
    this.#clearTraps();
    this.#removeSafeRingMesh();
    this.#closePortal();
    this.#clearCoreWave();
    this.#clearGridThunder();
    this.#clearLaserSweep();
    this.#clearGateVisuals();
    this.gateQueue.length = 0;
    this.weapons?.clear();
    this.#clearAiWeapons();
    for (const p of this.players.values()) this.#clearRescueMarker(p);
    this.skillFx?.clear();
    this.dmgLayer?.remove();
    this.dmgLayer = null;
    this.boxField?.dispose();
    this.boxField = null;
    this.itemBoxes.length = 0;
    if (this.input) {
      this.input.onItem = null;
      this.input.bossItemMode = false;
    }
  }

  #clearMinions() {
    for (const m of this.minions) {
      m.mixer?.stopAllAction();
      this.scene.remove(m.mesh);
      this.#disposeMinionMesh(m.mesh);
      this.#disposeMinionBar(m);
    }
    this.minions = [];
  }

  // ---------- 场地落区：熔岩柱 / 落石 / 毒雾 / 尖刺 ----------
  // 第三批把「预警圈 → 落区生效」这套熔岩柱逻辑扩成通用危险物：
  // kind 只影响外观、时长与伤害；联机仍只同步落点，各端只结算自己。
  #updateLavaZones(dt) {
    // 场上已有落区（例如「陨石齐落」事件）时也要继续更新，哪怕本关没有常驻危险物
    if (!this.lavaHazard && !this.hexHazardKinds?.length && !this.lavaZones.length) return;
    if (this.isHost && (this.lavaHazard || this.hexHazardKinds?.length)) {
      this.hexForceLava = Math.max(0, this.hexForceLava - dt);
      this.lavaTimer -= dt;
      if (this.lavaTimer <= 0) {
        this.lavaTimer = 4.0 + Math.random() * 1.8;
        const kind = this.#pickHazardKind();
        const zones = this.#rollHazardZones(kind);
        for (const z of zones) this.#addHazardZone(z.x, z.z, kind);
        this.net?.send({ t: 'bossLava', kind, zones });
      }
    }
    for (let i = this.lavaZones.length - 1; i >= 0; i--) {
      const zone = this.lavaZones[i];
      const cfg = HAZARD_ZONE[zone.kind] || HAZARD_ZONE.lava;
      zone.t += dt;
      if (zone.t < cfg.warn) {
        // 预警：红圈由暗转亮地闪，给玩家反应时间（和其他技能落点预警同一套红环）
        const k = zone.t / cfg.warn;
        zone.ring.material.opacity = 0.25 + k * 0.6;
        zone.ring.scale.setScalar(0.9 + k * 0.1);
        if (zone.column) zone.column.visible = false;
        continue;
      }
      const k = zone.t - cfg.warn;
      if (k > cfg.life + 0.35) {
        this.#removeLavaZone(zone, i);
        continue;
      }
      const p = Math.min(1, k / cfg.life);
      zone.ring.material.opacity = zone.kind === 'poison'
        ? 0.24 + Math.sin(k * 4) * 0.05
        : 0.85 * (1 - p);
      // 熔岩柱沿用原来的实体表现；落石/毒雾/尖刺一律交给 Effekseer，
      // 不再手搓圆柱/圆锥（那正是玩家看到的"绿色圆盘"和"灰色三角锥"）
      if (zone.column) {
        zone.column.visible = true;
        zone.column.scale.set(1, 0.4 + p * 1.6, 1);
        zone.column.position.y = 2 + p * 3;
        zone.column.material.opacity = 0.9 * (1 - p * 0.55);
      }
      if (cfg.dot) {
        // 毒雾：在存续时间里反复结算（只扣本机角色）
        zone.tick = (zone.tick ?? 0.35) - dt;
        if (zone.tick <= 0) {
          zone.tick += cfg.dot;
          const me = this.localBoat;
          if (me && Math.hypot(me.pos.x - zone.x, me.pos.z - zone.z) < cfg.r + 1.2) {
            this.#damagePlayer(this.myId, cfg.dmg, { source: cfg.source });
          }
        }
      } else if (!zone.hit && k >= (cfg.hitDelay || 0)) {
        zone.hit = true;
        const me = this.localBoat;
        const d = Math.hypot(me.pos.x - zone.x, me.pos.z - zone.z);
        if (d < cfg.r + 1.4) {
          this.#damagePlayer(this.myId, cfg.dmg, {
            awayFrom: { x: zone.x, z: zone.z },
            source: cfg.source,
          });
          this.#shakeCamera(0.6);
        }
      }
      if (!zone.fxPlayed && k >= (cfg.hitDelay || 0)) {
        zone.fxPlayed = true;
        if (zone.kind === 'lava') {
          this.skillFx.ringBurst('fire', { x: zone.x, z: zone.z, radius: cfg.r + 3, count: 46 });
          this.fx.play('fxMeteor', zone.x, 1.2, zone.z, 1.2);
        } else if (zone.kind === 'rockfall') {
          // 落石：陨石竖柱 + 入水水花，两层都是 Effekseer
          this.fx.play('fxMeteor', zone.x, 1.2, zone.z, 1.6);
          this.fx.play('fxWaterImpact', zone.x, 0.4, zone.z, 1.5);
        } else if (zone.kind === 'spike') {
          // 尖刺：用破水水花代替手搓的灰色圆锥
          this.fx.play('fxWaterImpact', zone.x, 0.3, zone.z, 2.0);
          this.fx.play('fxUpdraft', zone.x, 0.2, zone.z, 0.7);
        } else if (zone.kind === 'meteor') {
          // 陨石雨：更大一号的 Effekseer 陨石 + 入水水花
          this.fx.play('fxMeteor', zone.x, 1.6, zone.z, 2.2);
          this.fx.play('fxWaterImpact', zone.x, 0.4, zone.z, 1.8);
        } else if (zone.kind === 'poison') {
          // 毒雾：用膨胀冰雾表现"雾团"，替代半透明绿色圆柱
          this.fx.play('fxIceMist', zone.x, 1.2, zone.z, 1.8);
          this.fx.play('fxCosmicMist', zone.x, 1.6, zone.z, 0.9);
        }
      }
      // 毒雾的雾团会散，隔一会儿补一团，让危险区一直看得见
      if (zone.kind === 'poison' && k < cfg.life) {
        zone.fxTimer = (zone.fxTimer ?? 0) - dt;
        if (zone.fxTimer <= 0) {
          zone.fxTimer += 1.15;
          this.fx.play('fxIceMist', zone.x, 1.1, zone.z, 1.5);
        }
      }
    }
  }

  /** 本关可能出现的落区种类：熔岩 + 海克斯抽到的落石/毒雾/尖刺 */
  #pickHazardKind() {
    if (this.hexForceLava > 0) return 'lava';
    const pool = [];
    if (this.lavaHazard) pool.push('lava');
    for (const kind of this.hexHazardKinds || []) pool.push(kind);
    return pool[Math.floor(Math.random() * pool.length)] || 'lava';
  }

  /** 每波落区的数量与散布半径按种类区分 */
  #rollHazardZones(kind) {
    // 陨石雨「少而重」：固定 2 个落点；其余沿用原来的数量分布
    const count = kind === 'meteor'
      ? 2
      : kind === 'poison'
        ? 1 + Math.floor(Math.random() * 2)
        : kind === 'spike'
          ? 3 + Math.floor(Math.random() * 2)
          : 2 + Math.floor(Math.random() * 2);
    const zones = [];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = kind === 'poison' ? 10 + Math.random() * 14 : 14 + Math.random() * 18;
      zones.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
    }
    return zones;
  }

  #addHazardZone(x, z, kind = 'lava') {
    const cfg = HAZARD_ZONE[kind] || HAZARD_ZONE.lava;
    const r = cfg.r;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.75, r, 30),
      new THREE.MeshBasicMaterial({
        color: cfg.ring, transparent: true, opacity: 0.3, side: THREE.DoubleSide,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.09, z);
    this.scene.add(ring);
    // 只有熔岩柱保留实体柱体；新增危险物完全交给 Effekseer
    let column = null;
    if (kind === 'lava') {
      column = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.34, r * 0.7, 8, 12, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xff8a2a, transparent: true, opacity: 0.85,
          depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }),
      );
      column.position.set(x, 2, z);
      column.visible = false;
      this.scene.add(column);
    }
    this.lavaZones.push({
      kind, x, z, r, t: 0, hit: false, tick: 0.35, fxPlayed: false, fxTimer: 0, ring, column,
    });
  }

  #removeLavaZone(zone, index) {
    if (index >= 0) this.lavaZones.splice(index, 1);
    this.scene.remove(zone.ring);
    zone.ring.geometry.dispose();
    zone.ring.material.dispose();
    if (zone.column) {
      this.scene.remove(zone.column);
      zone.column.geometry.dispose();
      zone.column.material.dispose();
    }
  }

  #clearLavaZones() {
    for (const zone of this.lavaZones) {
      this.scene.remove(zone.ring);
      zone.ring.geometry.dispose();
      zone.ring.material.dispose();
      if (zone.column) {
        this.scene.remove(zone.column);
        zone.column.geometry.dispose();
        zone.column.material.dispose();
      }
    }
    this.lavaZones = [];
  }

  // ================= 海克斯：本局计划 / 核心 / 卡牌 / 随机事件 =================

  /** 本关是否抽到了某个危险物 */
  #hexHas(id) {
    return !!this.hexEntry?.hazards?.some((h) => h.id === id);
  }

  /** 结算本关的数值修正：核心（全队共享）+ 关卡规则；同时重置本关事件 */
  #prepareHexStage() {
    if (this.variant !== 'hex' || !this.hexEntry) {
      this.hexMods = mergeMods([], []);
      this.hexEvents = [];
      return;
    }
    // 换关时如果还挂着上一关的选卡浮层，先自动选第一张并关掉，避免卡住 UI
    if (this.hexCardOffer) this.#pickHexCard(this.hexCardOffer.cards[0]);
    this.opts.onHexCards?.(null);
    this.hexMods = combineMods(
      mergeMods(this.hexCoreId ? [this.hexCoreId] : [], HEX_CORES),
      mergeMods(this.hexEntry.rules, HEX_RULES),
    );
    this.hexCore = HEX_CORES.find((c) => c.id === this.hexCoreId) || null;
    // 事件按「开打后第几秒」触发，进关时全部复位
    this.hexEvents = (this.hexEntry.events || []).map((e) => ({ ...e, done: false }));
    this.hexEventT = 0;
    this.hexBerserkT = 0;
    this.hexBerserkBase = null;
    this.hexCardOffer = null;
    this.hexCardTimer = 0;
    this.hexOfferStage = 0;
  }

  /** 玩家身上的卡牌加成（跨关累计，退出房间才清空） */
  #hexBuff(id) {
    let b = this.hexBuffs.get(id);
    if (!b) {
      b = { dmgMul: 1, takenMul: 1, revive: 0, starterItems: 0, cards: [] };
      this.hexBuffs.set(id, b);
    }
    return b;
  }

  #hexDamageMul(id) {
    return (this.hexMods.playerDmgMul || 1) * (this.hexBuffs.get(id)?.dmgMul || 1);
  }

  #hexTakenMul(id) {
    return (this.hexMods.playerTakenMul || 1) * (this.hexBuffs.get(id)?.takenMul || 1);
  }

  /** 每关开局把核心/规则/卡牌效果写进玩家：回血、额外复活、开局道具 */
  #applyHexStagePlayers() {
    if (this.variant !== 'hex') return;
    for (const p of this.players.values()) {
      const card = this.hexBuffs.get(p.id);
      const revive = (this.hexMods.revive || 0) + (card?.revive || 0);
      if (revive > 0) p.revives = (p.revives || 0) + revive;
      if (this.hexMods.healFull) p.hp = p.maxHp || PLAYER_MAX_HP;
    }
    // 开局道具只发给本地玩家（客机自己的道具栏由本机维护）
    const me = this.players.get(this.myId);
    if (me) {
      const card = this.hexBuffs.get(this.myId);
      const extra = (this.hexMods.starterItems || 0) + (card?.starterItems || 0);
      for (let i = 0; i < extra; i++) {
        const slot = this.myItems.findIndex((it) => !it);
        if (slot < 0) break;
        this.myItems[slot] = ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];
      }
    }
  }

  /** 开局核心三选一：客机只展示，按钮只对房主可点 */
  #offerHexCore() {
    if (this.variant !== 'hex' || !this.hexPlan || this.hexCorePicked) return;
    this.hexCoreOptions = this.hexPlan.coreOptions;
    this.hexCoreTimer = 20;
    this.opts.onHexCards?.({
      kind: 'core',
      cards: this.hexPlan.coreOptions,
      timeout: 20,
      allowPick: this.isHost,
      seed: this.hexPlan.seed,
    });
  }

  /** 房主确认本局核心：写入计划并立刻生效 */
  #pickHexCore(id) {
    if (this.variant !== 'hex' || this.hexCorePicked || !this.isHost) return;
    const pick = this.hexCoreOptions?.includes(id) ? id : this.hexCoreOptions?.[0];
    if (!pick) return;
    this.hexCorePicked = true;
    this.hexCoreId = pick;
    this.hexCoreTimer = 0;
    this.hexCore = HEX_CORES.find((c) => c.id === pick) || null;
    this.hexMods = combineMods(
      mergeMods([pick], HEX_CORES),
      mergeMods(this.hexEntry?.rules || [], HEX_RULES),
    );
    this.#applyHexStagePlayers();
    if (this.hexCore) this.opts.onToast?.(`${this.hexCore.icon} 本局核心：${this.hexCore.name}`);
    this.opts.onHexCards?.(null);
  }

  /** 通关三选一：每台机器按 seed + 关卡确定性抽同样的 3 张，各自选各自的 */
  #offerHexCards() {
    if (this.variant !== 'hex' || !this.hexEntry || !this.hexPlan) return;
    // 最后一层也要发卡：玩家可能选择继续挑战，构筑需要在续层前继续成长
    if (this.hexOfferStage === this.stage) return;
    const rng = makeRng((this.hexPlan.seed ^ Math.imul(this.stage, 0x9e3779b1)) >>> 0);
    const owned = new Set(this.hexCardsPicked);
    const pool = HEX_CARDS.filter((c) => !owned.has(c.id));
    const picked = [];
    // 第三批：24 张卡池按稀有度权重抽（白 60 / 蓝 30 / 金 10），不保底、不重掷
    while (picked.length < 3 && pool.length) {
      const card = pickWeightedCard(rng, pool);
      pool.splice(pool.indexOf(card), 1);
      picked.push(card.id);
    }
    if (!picked.length) return;
    this.hexCardOffer = { cards: picked };
    this.hexCardTimer = 20;
    this.hexOfferStage = this.stage;
    this.opts.onHexCards?.({ kind: 'card', cards: picked, timeout: 20, allowPick: true, stage: this.stage });
  }

  /** 选卡：只作用于本地玩家，伤害结算时按开火人生效 */
  #pickHexCard(id) {
    const offer = this.hexCardOffer;
    if (!offer) return;
    this.hexCardOffer = null;
    this.hexCardTimer = 0;
    const def = HEX_CARDS.find((c) => c.id === id)
      || HEX_CARDS.find((c) => c.id === offer.cards[0]);
    if (!def) return;
    this.hexCardsPicked.push(def.id);
    const buff = this.#hexBuff(this.myId);
    const m = def.mods || {};
    if (m.dmgMul) buff.dmgMul *= m.dmgMul;
    if (m.takenMul) buff.takenMul *= m.takenMul;
    if (m.starterItems) buff.starterItems += m.starterItems;
    if (m.revive) {
      buff.revive += m.revive;
      const me = this.players.get(this.myId);
      if (me) me.revives += m.revive;
    }
    buff.cards.push(def.id);
    this.opts.onToast?.(`${def.icon} 获得卡牌：${def.name}（${def.desc}）`);
    this.opts.onHexCards?.(null);
  }

  /** 轻量局内事件：全部复用已有系统，不改战斗框架 */
  #triggerHexEvent(id) {
    if (id === 'airdrop') {
      const me = this.players.get(this.myId);
      if (me?.alive) {
        const max = me.maxHp || PLAYER_MAX_HP;
        me.hp = Math.min(max, me.hp + max * 0.3);
        this.opts.onToast?.('🪂 空投补给：回复 30% 生命');
      }
    } else if (id === 'berserk') {
      if (!this.boss) return;
      if (this.isHost) {
        this.hexBerserkBase = { dmg: this.boss.damageScale, cd: this.boss.cooldownScale };
        this.boss.damageScale *= 1.35;
        this.boss.cooldownScale *= 0.75;
      }
      this.hexBerserkT = 10;
      this.opts.onToast?.('💢 BOSS 暴走 10 秒！');
    } else if (id === 'storm') {
      // 全场闪电：每台机器只结算自己的角色，避免联机重复扣血
      this.opts.onToast?.('🌩 全场闪电！');
      const me = this.players.get(this.myId);
      if (me?.alive) this.#damagePlayer(this.myId, 14, { source: '全场闪电', hp: true });
    } else if (id === 'terrain') {
      // 熔岩地形：复用熔岩柱的落点/伤害链路，保证联机两端一致
      if (this.isHost) {
        this.lavaHazard = true;
        this.lavaTimer = 0;
        this.hexForceLava = 14;
      }
      this.opts.onToast?.('🌋 熔岩地形开始喷发');
    } else if (id === 'meteorshower') {
      // 陨石齐落：主机定落点，客机按 bossLava 消息复现（和普通危险物同一条链路）
      if (this.isHost) {
        const zones = this.#rollHazardZones('meteor');
        for (const z of zones) this.#addHazardZone(z.x, z.z, 'meteor');
        this.net?.send({ t: 'bossLava', kind: 'meteor', zones });
      }
      this.opts.onToast?.('☄ 陨石齐落！');
    } else if (id === 'armory') {
      // 军械补给：只补给本机（各端各领一份，和空投补给同一口径）
      const slot = this.myItems.findIndex((it) => !it);
      if (slot >= 0) {
        this.myItems[slot] = ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)];
        this.opts.onToast?.('🧰 军械补给：获得 1 个随机道具');
      } else {
        this.opts.onToast?.('🧰 军械补给：道具栏已满');
      }
    }
  }

  /** 海克斯每帧逻辑：卡牌/核心倒计时、暴走恢复、事件触发 */
  #updateHex(dt) {
    if (this.variant !== 'hex' || !this.hexPlan) return;
    if (this.hexCardOffer) {
      this.hexCardTimer -= dt;
      if (this.hexCardTimer <= 0) this.#pickHexCard(this.hexCardOffer.cards[0]);
    }
    // 无尽面板要等通关卡选完再弹（#openEndless 里遇到卡牌浮层会挂起）
    if (this.endlessPending && !this.hexCardOffer && this.phase === 'endless') {
      this.#showEndlessPanel();
    }
    if (!this.hexCorePicked && this.hexCoreTimer > 0) {
      this.hexCoreTimer -= dt;
      if (this.hexCoreTimer <= 0) this.#pickHexCore(this.hexCoreOptions?.[0]);
    }
    if (this.hexBerserkT > 0) {
      this.hexBerserkT -= dt;
      if (this.hexBerserkT <= 0 && this.hexBerserkBase && this.boss) {
        this.boss.damageScale = this.hexBerserkBase.dmg;
        this.boss.cooldownScale = this.hexBerserkBase.cd;
        this.hexBerserkBase = null;
        this.opts.onToast?.('💢 BOSS 暴走结束');
      }
    }
    if (this.phase !== 'fight') return;
    for (const e of this.hexEvents) {
      if (e.done || this.stageElapsed < e.at) continue;
      e.done = true;
      this.#triggerHexEvent(e.id);
    }
  }

  /** UI 三选一回调：有通关卡就先选卡，否则选本局核心 */
  pickHexPick(id) {
    if (this.hexCardOffer) {
      this.#pickHexCard(id);
      return;
    }
    if (!this.hexCorePicked) this.#pickHexCore(id);
  }

  /** 给 UI 用的当前构筑快照（带缓存：HUD 每帧取，避免每帧新建数组） */
  hexBuildInfo() {
    if (this.variant !== 'hex') return null;
    const rules = this.hexEntry?.rules || [];
    const hazards = this.hexEntry?.hazards || [];
    const sig = `${this.stage}|${this.runStageCount}|${this.hexCoreId}|${this.hexCardsPicked.length}`
      + `|${rules.join(',')}|${hazards.map((h) => h.id).join(',')}`;
    if (this.hexBuildCache?.sig === sig) return this.hexBuildCache.info;
    const info = {
      seed: this.hexPlan?.seed || 0,
      stage: this.stage,
      total: this.runStageCount,
      core: HEX_CORES.find((c) => c.id === this.hexCoreId) || null,
      cards: this.hexCardsPicked.map((id) => HEX_CARDS.find((c) => c.id === id)).filter(Boolean),
      rules: rules.map((id) => HEX_RULES.find((r) => r.id === id)).filter(Boolean),
      hazards: hazards.map((h) => HEX_HAZARDS.find((d) => d.id === h.id)).filter(Boolean),
    };
    this.hexBuildCache = { sig, info };
    return info;
  }
}
