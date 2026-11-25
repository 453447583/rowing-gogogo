import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { waveHeight } from '../utils/waves.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';
import { makeContactShadowTexture } from './Textures.js';
import { loadEffectTexture } from './effectTextures.js';
import { homingConfig, steerHoming, segmentDistance } from './Homing.js';
import { audio, itemSfxName } from '../audio/AudioEngine.js';

// 道具系统：道具箱拾取 + 6 种道具 + 闪电（暴风雨）
// 联机：道具箱拾取/道具使用/命中结果/闪电 通过服务器转发同步；
//       命中判定权威方 = 施放者客户端（炸弹/导弹），受击方客户端自行应用效果

export const ITEM_DEFS = {
  nitro: { name: '氮气瓶', icon: '⚡', color: 0xffd34d, desc: '瞬间加速' },
  bomb: { name: '深水炸弹', icon: '💣', color: 0x51606f, desc: '自动跟踪前一名，炸沉2秒' },
  octopus: { name: '章鱼', icon: '🐙', color: 0x9a5ce0, desc: '追踪前一名，缠住2秒：转向锁死、掉速30%' },
  shield: { name: '护盾', icon: '🛡️', color: 0x4fd0ff, desc: '3秒免疫一切道具' },
  missile: { name: '追踪导弹', icon: '🚀', color: 0xff6a4d, desc: '锁定前一名，命中减速+短暂顿挫' },
  vortex: { name: '漩涡', icon: '🫧', color: 0x40e0d0, desc: '前方100米炸开水泡，卷入者升空5秒' },
  magnet: { name: '磁力吸盘', icon: '🧲', color: 0xff4d6a, desc: '把自己吸向最近的领先者' },
  ink: { name: '墨鱼喷墨', icon: '🌑', color: 0x2a2a3a, desc: '黑雾糊住所有对手5秒并失控' },
  waterfall: { name: '深海瀑布', icon: '🌊', color: 0x2f9fd8, desc: '18米内对手被水柱冲上天空3秒' },
  angel: { name: '天使庇佑', icon: '😇', color: 0xffe9a8, desc: '3秒无敌+清除负面+小加速' },
  fish: { name: '飞鱼群', icon: '🐟', color: 0x6ac8ff, desc: '攻击所有领先于你的对手' },
  rvortex: { name: '海洋之怒', icon: '🌊', color: 0x2fd0b0, desc: '漩涡缠住第一名，原地打转' },
  slowboat: { name: '减速艇', icon: '🐢', color: 0xff8a5c, desc: '除自己外所有对手速度减半4秒' },
  tide: { name: '方向转换器', icon: '😈', color: 0xff5a6a, desc: '其他玩家左右操控反转5秒' },
  bubblefly: { name: '泡泡蜻蜓', icon: '🫧', color: 0x8ed9ff, desc: '追踪前一名，把它关进异世界3秒' },
  torpedo: { name: '鱼雷齐射', icon: '🐠', color: 0x9fe8ff, desc: '正前方三发直线鱼雷，命中掀翻1.2秒' },
  // ---------- 2026-11-14 追赶/防御补池（玩家要求：落后能反超、领先靠防御）----------
  bloodlance: { name: '血枪狙击', icon: '🔱', color: 0xd0324f, desc: '朝第一名方向直线贯穿，命中掉速2秒' },
  holystorm: { name: '圣光沙暴', icon: '🌪️', color: 0xffe6a0, desc: '沙暴直接罩住第一名14米，区内速度减半并糊眼4秒' },
  gate: { name: '逆流之门', icon: '🚪', color: 0xb07bff, desc: '瞬移到前一名身后10米' },
  bladestorm: { name: '剑刃风暴', icon: '⚔️', color: 0x9fe8ff, desc: '12米内剑刃回旋3秒，撞上被弹开并减速' },
  sanctuary: { name: '圣域', icon: '✨', color: 0xfff2c0, desc: '身后落一片圣域6秒，进入者减速并被推开' },
  barrier: { name: '护盾墙', icon: '🧱', color: 0x4fd0ff, desc: '身后展开14米护盾墙4秒，挡下所有来袭弹' },
};

// 怪物模式（打 BOSS）的独立道具池：只保留对 BOSS 有明确结算的道具。
// 道具赛的深海瀑布 / 减速艇 / 泡泡蜻蜓 / 鱼雷齐射不进 BOSS 池（它们没有 BOSS 结算）；
// 水雷 / 泡泡陷阱 / 诱饵艇 / 反磁护盾按用户要求不加入 BOSS 掉落
// （`BOSS_TRAP_ITEMS` 与 `#placeTrap` 那一整套代码保留着但**暂不投放**，别当成 bug）。
//
// 2026-11-13 修订：摘掉三件「对 BOSS 没意义」的道具，补四件硬伤害。
//   删 rvortex（海洋之怒）：只有 26 伤害，desc 写的「持续掉血」在 #hitBossWithItem 里
//      根本没有 DoT 累积，名不副实，且与 vortex 撞名。
//   删 octopus（章鱼）：控制被 ink 完全覆盖 —— confuseCast 只在 skill.kind 是 cone/path
//      时才打偏（BossMode.js 的 #castSkill），而 silence 拦的是「起新技能」。
//   删 magnet（磁力吸盘）：0 伤害；单机只能吸 AI 队友；#hitBossWithItem 里给它写的
//      status.slow 是走不到的死分支（在 #castMagnet 就 return 了）。
//   保留 shield（用户要求）：注意它和 angel 写的是同一个 boat.shieldTimer，
//     但 2026-11-22 起口径分开了 —— shield 只保自己，angel 保全队（含 AI）。
//
// 2026-11-22 修订（用户逐条指定）：
//   删 tide（方向转换器）：BOSS 的「技能乱放」只在 cone/path 结算时偏转，其余技能完全不受
//      影响，名不副实；且怪物 / 海克斯模式里没有第二个真人可被反转操控。竞速/道具赛保留。
//   改 vortex：命中不再只是 160 伤害，而是把 BOSS 关进道具赛同款水泡里浮空
//      （status.bubble）——浮空期间不接新技能、玩家照常输出，小怪不受影响。
//   改 ink：命中时若 BOSS 正在读条，**当场打断**并补 40 伤害（以前只拦"起新技能"）。
//   改 fish：没小怪时对 BOSS 的伤害 120 → 180（有小怪时撕咬仍是 240×2）。
//   新增 icecage / beacon / synergy，见下面三条 desc。
//
// 注意：octopus / rvortex / magnet 这三个 id 在**竞速模式**的 ITEM_DEFS 里仍然有效，
// 那边不能跟着删（Items.js 的竞速结算、Homing.js、audio 都还引用着）。
export const BOSS_ITEM_DEFS = {
  nitro: { name: '氮气瓶', icon: '⚡', color: 0xffd34d, desc: '瞬间加速（撞 BOSS 伤害翻倍）' },
  bomb: { name: '深水炸弹', icon: '💣', color: 0x51606f, desc: '追踪 BOSS，180 伤害并压入水下 3 秒' },
  shield: { name: '护盾', icon: '🛡️', color: 0x4fd0ff, desc: '3 秒免疫 BOSS 伤害（只保自己）' },
  missile: { name: '追踪导弹', icon: '🚀', color: 0xff6a4d, desc: '命中 BOSS，200 伤害并减速 3 秒' },
  vortex: { name: '漩涡', icon: '🫧', color: 0x40e0d0, desc: '水泡把 BOSS 困在半空 2.5 秒：不能放技能，可继续输出' },
  ink: { name: '墨鱼喷墨', icon: '🌑', color: 0x2a2a3a, desc: '打断 BOSS 当前读条 + 40 伤害 + 沉默 4 秒' },
  angel: { name: '天使庇佑', icon: '😇', color: 0xffe9a8, desc: '全队（含 AI）3 秒无敌 + 清负面 + 小加速' },
  fish: { name: '飞鱼群', icon: '🐟', color: 0x6ac8ff, desc: '撕咬附近小怪，并对 BOSS 造成 180 伤害' },
  weakspot: { name: '破甲标枪', icon: '🎯', color: 0xffb84d, desc: '命中后 BOSS 虚弱 4 秒：受伤 ×1.6、破韧 ×2' },
  harpoon: { name: '深海鱼叉', icon: '⚔️', color: 0xff9e4d, desc: '32 米内 340 伤害，超出射程会空' },
  barrage: { name: '三连深水弹', icon: '💥', color: 0xff7a3d, desc: '一次打出三发，每发 130 伤害' },
  thunderrod: { name: '引雷针', icon: '🌩️', color: 0x9fd8ff, desc: '260 伤害 + 沉默 3 秒，附带 90 点破韧' },
  ramcrest: { name: '冲角护符', icon: '🐗', color: 0xff5a3d, desc: '8 秒内撞 BOSS 伤害 ×3，撞完不被弹开' },
  icecage: { name: '寒冰牢笼', icon: '❄️', color: 0x9fe8ff, desc: '冻住 BOSS：80 伤害 + 定身 2.6 秒 + 沉默 1.8 秒' },
  beacon: { name: '救援信标', icon: '🛟', color: 0x7fe0a0, desc: '立即救起倒地队友（45% 血），否则全队回 40 血' },
  synergy: { name: '协同伙伴', icon: '🤝', color: 0xffd76b, desc: '队伍协同值瞬间拉满，6 秒内不衰减' },
};

const DEFENSE_DURATION = 3;

// ---------- 2026-11-14 新增六件道具的数值 ----------
// 「血枪狙击」：朝第一名方向直线飞出，穿透沿途所有领先者
const BLOOD_LANCE_SPEED = 110;
const BLOOD_LANCE_LIFE = 0.58;   // ×110 m/s ≈ 64m 射程：比导弹远一倍多，但要预判
const BLOOD_LANCE_HIT_R = 2.6;   // 比追踪弹小 —— 直线弹靠精度换射程
const BLOOD_LANCE_SLOW = 2;      // 命中掉速 2 秒
// 「圣光沙暴」：以第一名为中心的减速区
const HOLY_STORM_R = 14;
const HOLY_STORM_DUR = 4;
// 「逆流之门」：瞬移到前一名身后
const GATE_BACK_DIST = 10;
// 「剑刃风暴」：跟随施放者旋转的近身圈
const BLADE_STORM_R = 12;
const BLADE_STORM_DUR = 3;
const BLADE_STORM_KNOCK = 18;    // 首次进入的弹开冲量（直接写进 vel，不吃抓地）
// 「圣域」：留在身后的减速 + 推开区
const SANCTUARY_R = 8;
const SANCTUARY_DUR = 6;
const SANCTUARY_PUSH = 22;
// 「护盾墙」：横向挡弹
const BARRIER_HALF_W = 7;
const BARRIER_DUR = 4;

// 区域特效每帧续一次状态时长：比剩余寿命略长，离开区域 0.3 秒内自然恢复
const ZONE_TICK = 0.3;

// 区域型道具（视觉 + 判定都在本机，效果只落到「自己的船」，跨端各算各的）
const ZONE_KINDS = ['holystorm', 'sanctuary', 'barrier', 'bladestorm'];

// 「纯攻击」道具：领先者（t < 0.25）抽不到。
// 第一名还能炸人既没道理、也会让领先方滚雪球，把反超空间留给后面的人。
const LEAD_BLOCK_ITEMS = [
  'bomb', 'missile', 'octopus', 'bubblefly', 'torpedo', 'rvortex', 'fish',
  'bloodlance', 'holystorm', 'gate',
];
// 保底池：连续两次攻击白给后，下一个箱子强制从这里出
const COMEBACK_POOL = [
  'bloodlance', 'holystorm', 'gate', 'torpedo', 'bomb', 'missile', 'fish', 'rvortex',
];
// 计入「攻击是否落空」的道具（区域/防御型不进统计）
const ATTACK_ITEMS = [
  'bomb', 'missile', 'octopus', 'bubblefly', 'torpedo', 'rvortex', 'fish',
  'bloodlance', 'holystorm', 'gate', 'ink', 'tide', 'slowboat', 'waterfall',
];

// 「漩涡」巨型水弹:投掷距离(米)、引信时长(秒)、AoE 半径(米)、被吸空时间(秒)
const BUBBLE_BOMB_DISTANCE = 100;
const BUBBLE_BOMB_FUSE = 0.45;
const BUBBLE_BOMB_RADIUS = 9;
const BUBBLE_BOMB_LIFT = 5;

// 「减速艇」：除自己外所有对手速度 ×0.5，持续 3.5 秒
const SLOWBOAT_DURATION = 3.5;
// 「深海瀑布」：以自己为圆心 18 米内的对手被水柱冲上天空 3 秒
const WATERFALL_RADIUS = 18;
const WATERFALL_LIFT = 3;
// 「追踪章鱼怪」：缠住 2 秒（转向锁死 + 拖拽偏航 + 速度 -30%）
const OCTOPUS_GRAB = 2;
// 「泡泡蜻蜓」：把命中目标关进异世界 3 秒
const VOID_DURATION = 3;

// 「鱼雷齐射」：正前方三发平行直线鱼雷（扇形 ±6°），命中掀翻
const TORPEDO_SPEED = 60;        // 比追踪弹快，靠速度换掉「自动锁定」的便利
const TORPEDO_LIFE = 2.2;        // ≈130m 射程：贴脸放必中，远放要预判
const TORPEDO_SPREAD = 0.105;    // 左右各偏 6°
const TORPEDO_HIT_R = 2.8;       // 刻意比追踪弹小（命中半径大就不需要瞄准了）
const CAPSIZE_DURATION = 1.2;

// 受击提示按道具类型区分（itemHit）
const HIT_TOASTS = {
  sink: '💣 被炸沉了！',
  slow: '💥 被击中减速！',
  spin: '🌀 被漩涡缠住打转！',
  inkStun: '🌑 被墨鱼喷了一脸墨汁！',
  ink: '🌑 被喷了一脸墨汁！',
  bubbleLift: '🫧 被巨型水泡卷到空中！',
  halfSpeed: '🐢 被减速艇命中，速度减半！',
  octoGrab: '🐙 被章鱼怪缠住了！',
  geyserLift: '🌊 被深海瀑布冲上了天空！',
  void: '🫧 被泡泡蜻蜓拉进了异世界！',
  missileHit: '🚀 被追踪导弹击中！',
  capsize: '🐠 被鱼雷掀翻了！',
};

const ITEM_IDS = Object.keys(ITEM_DEFS);

// 会伤到别人（或挡别人的路）的攻击/干扰道具。只有这些才给受害者发"来袭预警音"。
// 用户口径：被攻击方是靠听声音决定要不要放护盾的，所以预警必须在命中之前响。
const THREAT_ITEMS = new Set([
  'bomb', 'missile', 'octopus', 'bubblefly', 'torpedo', 'vortex', 'bloodlance',
  'fish', 'rvortex', 'waterfall', 'ink', 'slowboat', 'tide',
  'holystorm', 'bladestorm', 'sanctuary',
]);
// 这些是全场/锁定型：只要有人放，本地玩家就可能被波及（没有"飞过来"的过程可算方向）
const GLOBAL_THREATS = new Set([
  'ink', 'slowboat', 'tide', 'fish', 'rvortex', 'waterfall', 'holystorm',
]);
// 受击音按效果类型映射。以前只覆盖 4 种，其余 9 种命中时是静音的。
const HIT_SFX = {
  sink: 'bomb_hit',
  missileHit: 'missile_hit',
  capsize: 'missile_hit',
  octoGrab: 'boat_collide',
  halfSpeed: 'slow_hit',
  slow: 'slow_hit',
  ink: 'item_ink',
  inkStun: 'item_ink',
  bubbleLift: 'item_vortex',
  geyserLift: 'item_waterfall',
  void: 'item_bubblefly',
  spin: 'item_vortex',
  reverse: 'reverse_tide',
};

// 按名次的权重表：领先拿防御/加速，落后拿攻击（经典追赶设计）
// pool 可裁剪可用道具（竞技场只放 10 件：追踪类在 1v1 里必中，破坏平衡）
function rollItem(rank, total, pool = null) {
  const ids = pool || ITEM_IDS;
  const t = total > 1 ? (rank - 1) / (total - 1) : 0; // 0=领先 1=垫底
  const w = {
    nitro: 2.6 - t * 1.0,
    shield: 2.0 - t * 0.6,
    octopus: 1.2,
    vortex: 1.2 + t * 0.4,
    bomb: 0.5 + t * 1.8,
    missile: 0.3 + t * 2.2,
    magnet: 0.7 + t * 1.5,
    ink: 0.9 + t * 0.5,
    waterfall: 0.9 + t * 0.6,
    angel: 1.0 - t * 0.3,
    fish: 0.5 + t * 1.6,
    rvortex: 0.4 + t * 1.4,
    slowboat: 0.8 + t * 0.6,
    tide: 0.7,
    bubblefly: 0.7 + t * 0.8,
    // 鱼雷需要瞄准，领先时几乎用不上（前面没人），落后时是翻盘手段
    torpedo: 0.4 + t * 1.4,
    // 报复/防御型：领先时明显更容易抽到
    bladestorm: 0.9 - t * 0.2,
    sanctuary: 1.6 - t * 0.9,
    barrier: 1.4 - t * 0.8,
    // 纯翻盘型：只随落后程度上升
    bloodlance: 0.3 + t * 1.6,
    holystorm: 0.4 + t * 1.7,
    gate: 0.5 + t * 1.3,
  };
  // 领先者（前 25%）抽不到纯攻击道具 —— 只留加速/防御/近身反制
  if (t < 0.25) for (const k of LEAD_BLOCK_ITEMS) w[k] = 0;
  let sum = 0;
  for (const k of ids) sum += w[k] ?? 0;
  if (sum <= 0) {
    // 连败保底池全是"领跑屏蔽"成员：两者叠加会让权重全为 0，
    // 于是永远返回数组第一件（血枪）。此时解除屏蔽，保底才有意义。
    for (const k of ids) if (LEAD_BLOCK_ITEMS.includes(k)) w[k] = 0.4;
    sum = 0;
    for (const k of ids) sum += w[k] ?? 0;
  }
  let r = Math.random() * sum;
  for (const k of ids) {
    r -= w[k] ?? 0;
    if (r <= 0) return k;
  }
  return ids[0] || 'nitro';
}

// 爆炸光斑贴图（水花/爆炸通用）
let burstTex = null;
function getBurstTex() {
  if (burstTex) return burstTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.4, 'rgba(255,160,80,0.75)');
  g.addColorStop(1, 'rgba(255,120,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  burstTex = new THREE.CanvasTexture(c);
  return burstTex;
}

// 向上喷的水柱贴图（Effekseer 自带 Sample 资源）
let splashTex = null;
function getSplashTex() {
  if (!splashTex) {
    splashTex = loadEffectTexture(new THREE.TextureLoader(), '/effects/Basic/Texture/Splash01.png');
  }
  return splashTex;
}

// 接触阴影贴图（共享）：所有道具箱共用一张 128 的羽化圆斑
let contactShadowTex = null;
function getContactShadowTexture() {
  if (!contactShadowTex) contactShadowTex = makeContactShadowTexture();
  return contactShadowTex;
}

// 问号贴图（共享）：霓虹灯管版 —— 空心描边 + 三层辉光，不再是实心白字
// 画法：外圈洋红/紫晕 → 中层青色管壁 → 内芯近白高光。加色混合下读作"灯管"。
let questionTex = null;
function makeQuestionTexture() {
  if (questionTex) return questionTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.font = 'bold 196px "Arial Black", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const draw = (width, color, blur) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.strokeText('?', 128, 138);
  };
  // 由外到内：洋红晕 → 紫 → 青管壁 → 白芯
  draw(30, 'rgba(255, 61, 120, 0.55)', 34);
  draw(20, 'rgba(155, 123, 255, 0.85)', 22);
  draw(11, 'rgba(53, 230, 224, 1)', 14);
  draw(4, 'rgba(240, 255, 255, 0.98)', 4);
  ctx.shadowBlur = 0;
  questionTex = new THREE.CanvasTexture(c);
  questionTex.colorSpace = THREE.SRGBColorSpace;
  return questionTex;
}

// 箱体面板贴图（共享）：深黑底 + 冷调霓虹斜渐变（青→紫→洋红→橙→金）
// 参考图那种"彩色渐变发光块"。实心深底压住亮度，只有渐变带发光，Bloom 不会糊成白团。
let neonPanelTex = null;
function makeNeonPanelTexture() {
  if (neonPanelTex) return neonPanelTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  // 1) 深黑底
  ctx.fillStyle = '#0a0c12';
  ctx.fillRect(0, 0, 256, 256);
  // 2) 斜向五段霓虹渐变
  const g = ctx.createLinearGradient(0, 256, 256, 0);
  g.addColorStop(0.00, '#35e6e0');   // 青
  g.addColorStop(0.26, '#4a7bff');   // 蓝
  g.addColorStop(0.48, '#9b4bff');   // 紫
  g.addColorStop(0.68, '#ff3d9a');   // 洋红
  g.addColorStop(0.85, '#ff7a2f');   // 橙
  g.addColorStop(1.00, '#ffd24a');   // 金
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  ctx.globalAlpha = 1;
  // 3) 压暗四角，中心留亮 → 读起来是"从内部透光"而不是一块平色
  const vg = ctx.createRadialGradient(128, 128, 30, 128, 128, 186);
  vg.addColorStop(0, 'rgba(255,255,255,0.18)');
  vg.addColorStop(0.62, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, 256, 256);
  // 4) 细电路网格（1px 暗线），让面板有"科技表面"而不是塑料
  ctx.strokeStyle = 'rgba(6, 10, 18, 0.35)';
  ctx.lineWidth = 1;
  for (let i = 32; i < 256; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
  }
  neonPanelTex = new THREE.CanvasTexture(c);
  neonPanelTex.colorSpace = THREE.SRGBColorSpace;
  return neonPanelTex;
}

// 环绕光点贴图（共享）
let boxDotTex = null;
function makeBoxDotTexture() {
  if (boxDotTex) return boxDotTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(190,240,255,0.8)');
  g.addColorStop(1, 'rgba(120,200,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  boxDotTex = new THREE.CanvasTexture(c);
  return boxDotTex;
}

// 立方体金属边框：12 根圆柱按棱边摆好合并成一个几何（1 draw call）
function makeBoxFrameGeometry(size, bar) {
  const half = size * 0.5;
  const parts = [];
  const axis = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const add = (ax, ay, az, bx, by, bz) => {
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const geo = new THREE.CylinderGeometry(bar, bar, len + bar, 6, 1, false);
    dir.set(bx - ax, by - ay, bz - az).normalize();
    q.setFromUnitVectors(axis, dir);
    mid.set((ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5);
    geo.applyQuaternion(q);
    geo.translate(mid.x, mid.y, mid.z);
    parts.push(geo);
  };
  for (const y of [-half, half]) {
    for (const z of [-half, half]) add(-half, y, z, half, y, z);
    for (const x of [-half, half]) add(x, y, -half, x, y, half);
  }
  for (const x of [-half, half]) {
    for (const z of [-half, half]) add(x, -half, z, x, half, z);
  }
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

const BOX_MARK_PER_BOX = 4; // 四个侧面各一个问号（独立网格，可单独做呼吸/弹跳）
const BOX_DOTS_PER_BOX = 10; // 每个箱子的环绕光点数量

/**
 * 道具箱外观（道具赛 + 怪物模式共用）：
 * 蓝色金属框 metalness .9 / roughness .15（吃 scene.environment 反射）
 * + 自发光面板（低阈值 Bloom 直接起辉）
 * + 问号独立网格（呼吸缩放、拾取弹跳都改它的矩阵即可）
 * + 水面光环（单独扁平圆环，贴着 waveHeight 走）
 * + 环绕半透明光点（所有箱子共用一个 THREE.Points）
 * 全部按 InstancedMesh 合批：整套外观 5 个 draw call。
 */
export class ItemBoxField {
  /**
   * @param {THREE.Scene} scene
   * @param {number} count 箱子数量
   * @param {{size?:number, floatHeight?:number, bob?:number, spin?:number, phase?:number}} opts
   */
  constructor(scene, count, opts = {}) {
    this.scene = scene;
    this.count = count;
    this.size = opts.size ?? 1.5;
    this.floatHeight = opts.floatHeight ?? 1.6;
    this.bob = opts.bob ?? 0.26;
    this.spin = opts.spin ?? 0.55;
    this.phase = opts.phase ?? 0.9;
    this.time = 0;

    const size = this.size;
    const panelGeo = new THREE.BoxGeometry(size * 0.83, size * 0.83, size * 0.83);
    // 面板：深黑底 + 冷调霓虹斜渐变（青→紫→洋红→橙→金）。
    // map 和 emissiveMap 用同一张：黑色区域不发光，只有渐变带起辉，
    // 所以 Bloom 只会沿着色带走，不会把整个方块烧成一团白。
    const neonTex = makeNeonPanelTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      map: neonTex,
      emissiveMap: neonTex,
      emissive: 0xffffff,
      emissiveIntensity: 1.15,
      metalness: 0.62,
      roughness: 0.3,
      transparent: false,
      opacity: 1,
    });
    // 金属框：深黑哑光金属，只留极弱冷光；亮部交给面板和铆钉
    const frameGeo = makeBoxFrameGeometry(size, size * 0.052);
    const frameMat = new THREE.MeshStandardMaterial({
      color: 0x0f1218,
      emissive: 0x101a26,
      emissiveIntensity: 0.35,
      metalness: 0.95,
      roughness: 0.38,
    });
    // 黄铜铆钉：8 个箱体角各一颗，跟着箱体自转
    const rivetGeo = new THREE.SphereGeometry(size * 0.052 * 1.85, 8, 6);
    const rivetMat = new THREE.MeshStandardMaterial({
      color: 0xd9a441,
      emissive: 0x4a2c08,
      emissiveIntensity: 0.5,
      metalness: 1,
      roughness: 0.32,
    });
    const markGeo = new THREE.PlaneGeometry(size * 0.46, size * 0.46);
    const markMat = new THREE.MeshBasicMaterial({
      map: makeQuestionTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      opacity: 0.95,
    });

    const make = (geo, mat, n, order) => {
      const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      mesh.count = n;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = order;
      scene.add(mesh);
      return mesh;
    };
    this.panels = make(panelGeo, panelMat, count, 1);
    this.frames = make(frameGeo, frameMat, count, 1);
    this.marks = make(markGeo, markMat, count * BOX_MARK_PER_BOX, 3);
    // 黄铜铆钉：每箱 8 个角，单独一份实例（材质是铜色，不能和深黑框合并）
    this.rivets = make(rivetGeo, rivetMat, count * 8, 2);

    // 接触阴影：每个箱子脚下一片贴水软阴影，箱子不再像漂在半空
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    const shadowMat = new THREE.MeshBasicMaterial({
      map: getContactShadowTexture(),
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      color: 0x0c1014,
    });
    this.shadows = make(shadowGeo, shadowMat, count, 0);
    // 水面光环已删除（用户反馈那个半圆蓝色外圈太丑），ring 相关写入全部做空判断


    // 环绕光点：所有箱子共用一组 Points
    const dotCount = count * BOX_DOTS_PER_BOX;
    this.dotPos = new Float32Array(dotCount * 3);
    for (let i = 0; i < dotCount; i++) this.dotPos[i * 3 + 1] = -9999;
    const dotGeo = new THREE.BufferGeometry();
    dotGeo.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3));
    this.points = new THREE.Points(dotGeo, new THREE.PointsMaterial({
      map: makeBoxDotTexture(),
      color: 0xa8e6ff,
      size: size * 0.17,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);

    // 每颗粒子的轨道参数（角度/半径/高度/角速度）
    this.orbit = [];
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < BOX_DOTS_PER_BOX; j++) {
        this.orbit.push({
          a: (j / BOX_DOTS_PER_BOX) * Math.PI * 2 + i * 0.73,
          r: size * (1.02 + (j % 3) * 0.16),
          y: -size * 0.5 + (j % 5) * size * 0.26,
          speed: 0.55 + (j % 4) * 0.14,
        });
      }
    }

    // 复用的临时对象，避免每帧 new
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._v = new THREE.Vector3();
    // 8 个箱体角的局部坐标（黄铜铆钉用），size 变了要重建
    this.rivetLocal = [];
    {
      const h = size * 0.5;
      for (const x of [-h, h]) for (const y of [-h, h]) for (const z of [-h, h]) {
        this.rivetLocal.push(new THREE.Vector3(x, y, z));
      }
    }

    // ---------- 拾取破碎：碎片 + 散落水面 ----------
    // 箱子被吃掉时，在它原来的位置炸出十几片深黑碎片（带铜边高光），
    // 受重力落下、落到浪面上停一下再消失。整套只占 1 个 draw call。
    this.debrisPerBurst = 30;
    this.debrisSlots = 4;                       // 最多同时 4 次破碎（30 片/次）
    const debrisTotal = this.debrisPerBurst * this.debrisSlots;
    const debrisGeo = new THREE.BoxGeometry(size * 0.22, size * 0.22, size * 0.055);
    const debrisMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,                          // 真实颜色走 instanceColor
      // 千万别给白色 emissive：instanceColor 只乘漫反射，不乘自发光，
      // 加白色发光会把五色碎片统一洗成粉白（看起来像纸片）
      emissive: 0x000000,
      emissiveIntensity: 0,
      metalness: 0.25,                          // 金属度压住，否则颜色全靠反射、看着发灰
      roughness: 0.42,
      envMapIntensity: 1.15,
    });
    this.debris = make(debrisGeo, debrisMat, debrisTotal, 2);
    // 碎片调色板：箱壳的霓虹色 + 深黑金属片混在一起，像"彩玻璃壳炸开"
    this.debrisPalette = [0x35e6e0, 0x9b4bff, 0xff3d9a, 0xff7a2f, 0xffd24a, 0x14171c, 0x14171c];
    this._c = new THREE.Color();
    this.debrisState = Array.from({ length: debrisTotal }, () => ({
      life: 0, x: 0, y: -999, z: 0, vx: 0, vy: 0, vz: 0,
      rx: 0, ry: 0, rz: 0, spin: 0, settled: false,
    }));
    // 上一帧的"活着"状态：用来判断哪一秒被吃掉（true → false 就是拾取瞬间）
    this.prevAlive = new Uint8Array(count);
    this.prevPos = Array.from({ length: count }, () => ({ x: 0, y: 0, z: 0 }));
    this.lastDt = 0;

    // 先按空箱初始化一次，避免首帧出现零矩阵
    this.#layout(0, []);
  }

  /**
   * 在某点炸开一堆碎片。x/y/z 是箱体中心的世界坐标。
   * 供 update 内部的"箱子被吃掉"自动调用，也可以外部手动触发。
   */
  burst(x, y, z) {
    let made = 0;
    for (let i = 0; i < this.debrisState.length; i++) {
      const d = this.debrisState[i];
      if (made >= this.debrisPerBurst) break;
      if (d.life > 0) continue;                 // 槽位还在播，跳过
      const a = Math.random() * Math.PI * 2;
      const sp = 3.6 + Math.random() * 6.8;     // 水平散开速度：夸张一点，炸得满屏都是
      d.life = 1.4 + Math.random() * 1.1;
      d.settled = false;
      d.x = x + (Math.random() - 0.5) * 0.45;
      d.y = y + (Math.random() - 0.5) * 0.55;
      d.z = z + (Math.random() - 0.5) * 0.45;
      d.vx = Math.cos(a) * sp;
      d.vz = Math.sin(a) * sp;
      d.vy = 3.2 + Math.random() * 5.9;         // 向上先炸开：先冲高再受重力砸回水面
      d.rx = Math.random() * Math.PI * 2;
      d.ry = Math.random() * Math.PI * 2;
      d.rz = Math.random() * Math.PI * 2;
      d.spin = (Math.random() - 0.5) * 26;
      d.sc = 0.55 + Math.random() * 0.95;       // 每片大小不一，比清一色大方片更像碎玻璃
      // 每片单独上色：霓虹五色 + 深黑金属片混着飞
      const c = this.debrisPalette[(i + made) % this.debrisPalette.length];
      this.debris.setColorAt(i, this._c.setHex(c));
      made += 1;
    }
    if (this.debris.instanceColor) this.debris.instanceColor.needsUpdate = true;
    return made;
  }

  /** 碎片积分：重力 → 落水停一下 → 淡出消失 */
  #updateDebris(dt, t) {
    const arr = this.debrisState;
    let any = false;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i];
      if (d.life <= 0) {
        if (d.y !== -999) {
          d.y = -999;
          this._p.set(0, -999, 0);
          this._q.identity();
          this._s.set(0.001, 0.001, 0.001);
          this._m.compose(this._p, this._q, this._s);
          this.debris.setMatrixAt(i, this._m);
          any = true;
        }
        continue;
      }
      any = true;
      d.life -= dt;
      if (!d.settled) {
        d.vy -= 15 * dt;                        // 重力
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.z += d.vz * dt;
        const wy = waveHeight(d.x, d.z, t) + 0.04;
        if (d.y <= wy && d.vy < 0) {
          // 落到水面：停一下、水平速度几乎吃掉，再消失
          d.y = wy;
          d.vx *= 0.18; d.vz *= 0.18; d.vy = 0;
          d.settled = true;
          d.life = Math.min(d.life, 0.34);
        }
      } else {
        // 浮在水面上跟着浪轻轻起伏
        d.y = waveHeight(d.x, d.z, t) + 0.04;
        d.x += d.vx * dt; d.z += d.vz * dt;
      }
      d.rx += d.spin * dt;
      d.ry += d.spin * 0.6 * dt;
      this._p.set(d.x, d.y, d.z);
      this._e.set(d.rx, d.ry, d.rz);
      this._q.setFromEuler(this._e);
      const k = (d.life < 0.35 ? Math.max(0.05, d.life / 0.35) : 1) * (d.sc || 1);
      this._s.set(k, k, k);
      this._m.compose(this._p, this._q, this._s);
      this.debris.setMatrixAt(i, this._m);
    }
    if (any) this.debris.instanceMatrix.needsUpdate = true;
  }

  /** 把第 i 个箱子的所有部件藏到水下（仍在管线里，但不可见） */
  #hide(i, x = 0, z = 0) {
    this._p.set(x, -600, z);
    this._q.identity();
    this._s.set(1, 1, 1);
    this._m.compose(this._p, this._q, this._s);
    this.panels.setMatrixAt(i, this._m);
    this.frames.setMatrixAt(i, this._m);
    this.shadows.setMatrixAt(i, this._m);
    for (let k = 0; k < 8; k++) this.rivets.setMatrixAt(i * 8 + k, this._m);
    if (this.rings) this.rings.setMatrixAt(i, this._m);
    for (let k = 0; k < BOX_MARK_PER_BOX; k++) {
      this.marks.setMatrixAt(i * BOX_MARK_PER_BOX + k, this._m);
    }
    for (let j = 0; j < BOX_DOTS_PER_BOX; j++) {
      this.dotPos[(i * BOX_DOTS_PER_BOX + j) * 3 + 1] = -9999;
    }
  }

  #layout(t, boxes) {
    const n = Math.min(this.count, boxes.length);
    for (let i = 0; i < this.count; i++) {
      const b = i < n ? boxes[i] : null;
      if (!b || b.active === false) {
        this.#hide(i, b?.x || 0, b?.z || 0);
        continue;
      }
      const size = this.size;
      // 抬高段用赛道面高度（静态），平地才跟着海浪起伏
      const waterY = b.y > 0.5 ? b.y : waveHeight(b.x, b.z, t);
      const rot = t * this.spin + i * 0.62;
      const baseY = waterY + this.floatHeight + Math.sin(t * 1.5 + i * this.phase) * this.bob;

      // 面板 + 金属框（整体自转）
      this._p.set(b.x, baseY, b.z);
      this._e.set(0, rot, 0);
      this._q.setFromEuler(this._e);
      this._s.set(1, 1, 1);
      this._m.compose(this._p, this._q, this._s);
      this.panels.setMatrixAt(i, this._m);
      this.frames.setMatrixAt(i, this._m);

      // 黄铜铆钉：局部角点 → 乘箱体旋转 → 平移到箱体位置（此处 _q 还是箱体姿态）
      for (let k = 0; k < 8; k++) {
        this._v.copy(this.rivetLocal[k]).applyQuaternion(this._q);
        this._v.x += b.x; this._v.y += baseY; this._v.z += b.z;
        this._p.copy(this._v);
        this._s.set(1, 1, 1);
        this._m.compose(this._p, this._q, this._s);
        this.rivets.setMatrixAt(i * 8 + k, this._m);
      }

      // 接触阴影：贴水面、不跟箱子自转，比箱体略大一圈（软边的扩散感）
      this._p.set(b.x, waterY + 0.06, b.z);
      this._e.set(0, 0, 0);
      this._q.setFromEuler(this._e);
      this._s.set(size * 1.6, 1, size * 1.6);
      this._m.compose(this._p, this._q, this._s);
      this.shadows.setMatrixAt(i, this._m);

      // 问号：四个侧面各一个，独立网格；呼吸缩放
      const breathe = 1 + Math.sin(t * 2.4 + i * 1.31) * 0.1;
      for (let k = 0; k < BOX_MARK_PER_BOX; k++) {
        const yaw = rot + (k / BOX_MARK_PER_BOX) * Math.PI * 2;
        const d = size * 0.548;
        this._p.set(b.x + Math.sin(yaw) * d, baseY, b.z + Math.cos(yaw) * d);
        this._e.set(0, yaw, 0);
        this._q.setFromEuler(this._e);
        this._s.set(breathe, breathe, 1);
        this._m.compose(this._p, this._q, this._s);
        this.marks.setMatrixAt(i * BOX_MARK_PER_BOX + k, this._m);
      }

      // 环绕光点（缓慢绕箱体一圈，同时上下轻摆）
      for (let j = 0; j < BOX_DOTS_PER_BOX; j++) {
        const idx = i * BOX_DOTS_PER_BOX + j;
        const o = this.orbit[idx];
        const a = o.a + t * o.speed;
        this.dotPos[idx * 3] = b.x + Math.cos(a) * o.r;
        this.dotPos[idx * 3 + 1] = baseY + o.y + Math.sin(t * 2 + o.a) * size * 0.1;
        this.dotPos[idx * 3 + 2] = b.z + Math.sin(a) * o.r;
      }
    }
    this.panels.instanceMatrix.needsUpdate = true;
    this.frames.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
    this.marks.instanceMatrix.needsUpdate = true;
    this.rivets.instanceMatrix.needsUpdate = true;
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  /** @param {number} t 全局时间（秒） @param {{x:number,z:number,active?:boolean}[]} boxes */
  update(t, boxes) {
    const dt = Math.min(0.06, Math.max(0, t - (this.time || t)));
    this.time = t;
    // 箱子从"活着"变"没了"= 刚被玩家吃掉：在上一帧的位置炸开碎片。
    // 放在这里而不是玩家拾取回调里，是因为道具赛 / 怪物模式 / 竞技场
    // 三个模式删箱子的路径各不一样，这里一处就能全部覆盖。
    const n = Math.min(this.count, boxes.length);
    for (let i = 0; i < this.count; i++) {
      const b = i < n ? boxes[i] : null;
      const alive = !!(b && b.active !== false);
      if (this.prevAlive[i] && !alive) {
        const p = this.prevPos[i];
        this.burst(p.x, p.y, p.z);
      }
      this.prevAlive[i] = alive ? 1 : 0;
      if (alive) {
        // 抬高段用赛道面高度（和 #layout 同一套判断）
        const wy = b.y > 0.5 ? b.y : waveHeight(b.x, b.z, t);
        this.prevPos[i].x = b.x;
        this.prevPos[i].y = wy + this.floatHeight;
        this.prevPos[i].z = b.z;
      }
    }
    this.#layout(t, boxes);
    this.#updateDebris(dt, t);
  }

  dispose() {
    for (const mesh of [this.panels, this.frames, this.marks, this.points, this.shadows, this.rivets, this.debris]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }
}

export class ItemManager {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {object} opts.track Track
   * @param {object} opts.net NetClient（单人模式为桩）
   * @param {string} opts.myId
   * @param {boolean} opts.isHost 是否主机（AI 权威）
   * @param {boolean} opts.storm 是否暴风雨（启用闪电）
   * @param {Function} opts.getBoats () => Map<id, Boat>
   * @param {Function} opts.getRank (id) => number
   * @param {Function} opts.onToast (msg) => void
   */
  constructor(opts) {
    this.opts = opts;
    this.scene = opts.scene;
    this.track = opts.track;
    this.net = opts.net;
    this.myId = opts.myId;
    this.isHost = opts.isHost;
    this.solo = !!opts.solo;
    this.storm = opts.storm;
    this.getBoats = opts.getBoats;
    this.getCamera = opts.getCamera || (() => null);
    this.getRank = opts.getRank;
    this.getGate = opts.getGate || (() => null);
    // 地面高度：默认就是水面（waveHeight），天梯那种浮空平台传自己的甲板高度。
    // 项目里 7 处特效高度原本硬写 waveHeight(...)，在 36m 高的玻璃平台上层会把
    // 弹道/水柱画到海面上（看不见），所以统一走这个钩子。
    this.groundAt = typeof opts.groundAt === 'function'
      ? opts.groundAt
      : (x, z, t) => waveHeight(x, z, t);
    // 箱子被吃掉后多久重新刷（竞速 8s；天梯这类短时乱斗可以调短）
    this.boxRespawn = Number.isFinite(opts.boxRespawn) ? opts.boxRespawn : 8;
    // 天梯第 3 层的计分钩子：开箱 / 命中各回调一次
    this.onTakeBox = typeof opts.onTakeBox === 'function' ? opts.onTakeBox : null;
    this.onHit = typeof opts.onHit === 'function' ? opts.onHit : null;
    // 拾取的高度过滤。默认 Infinity = 关闭，所有老玩法（竞速/竞技场）行为一字不变。
    // 天梯必须开：10 层玻璃盘在 xz 上是完全重叠的，只按平面距离判的话，
    // 第 1 层的船会把第 3 层头顶 36m 处的箱子隔空吃掉。
    this.boxYPad = Number.isFinite(opts.boxYPad) ? opts.boxYPad : Infinity;
    // 组队赛制：同一队伍且不是自己。个人赛制下恒为 false，所有判定等于不启用。
    this.isTeammate = typeof opts.isTeammate === 'function' ? opts.isTeammate : () => false;
    this.onToast = opts.onToast || (() => {});
    this.fx = opts.fx || null; // Effekseer 特效（可选）{});

    this.myItems = [null, null, null]; // 本地玩家道具栏（3 格：Q/W/E）
    // 竞技场卡牌「军需官」：拾取箱子时额外再得一件的概率，默认 0
    this.bonusChance = 0;
    // 竞技场等自定池：只从这些 id 里抽（不传 = 全 16 件，原有模式完全不受影响）
    this.itemPool = Array.isArray(opts.itemPool) && opts.itemPool.length ? opts.itemPool : null;
    // 道具栏键位：道具赛 Q/W/E；怪物模式与竞技场是 Q/E/1（W 要让给油门）
    this.slotKeys = Array.isArray(opts.slotKeys) && opts.slotKeys.length === 3
      ? opts.slotKeys
      : ['Q', 'W', 'E'];
    this.aiItems = new Map();  // AI 艇道具 { items: [itemId...], useAt }
    // 联机时其他真人玩家手上的道具：id -> [itemId...]。
    // 覆盖式同步（收到整份列表就替换），不靠 "吃+1 / 用-1" 推算 ——
    // 道具使用有 7 处发 itemUse、还有若干不发，推算一定会漏。
    this.remoteItems = new Map();
    this.inkTimer = 0;         // 本地玩家被墨汁遮挡剩余时间
    this.voidTimer = 0;        // 本地玩家被泡泡蜻蜓关进异世界的剩余时间
    this.voidLen = VOID_DURATION; // 本次异世界总时长（淡入淡出用）
    this.voidWorld = null;     // 童话幻境（#void-dream CSS 全屏层，受击者本地显示）
    this.screenFlash = 0;      // 闪电屏幕闪光强度

    this.boxes = [];           // 道具箱
    this.boxField = null;      // 道具箱外观（合批 InstancedMesh + Points）
    this.geysers = [];         // 深海瀑布水柱
    this.octoGrabs = [];       // 缠在艇身上的章鱼（2 秒后沉海）
    this.bubbleBombs = [];     // 漩涡巨型水弹（施放者权威 AoE，引信后炸开）
    this.waterSprays = [];     // 水弹炸开时的水柱广告牌
    this.projectiles = [];     // 炸弹/导弹
    this.projectileSeq = 0;
    this.bursts = [];          // 爆炸粒子池
    this.warnings = [];        // 闪电预警
    this.bolts = [];           // 闪电束
    this.lightningTimer = 4 + Math.random() * 4;
    this.strikeStreak = new Map(); // id -> 连续被劈次数

    this.magnetAim = null;
    this.magnetReticle = this.#makeMagnetReticle();
    // 区域型道具（沙暴 / 圣域 / 护盾墙 / 剑刃风暴）
    this.zones = [];
    this.zoneSeq = 0;
    // 「连续两次攻击白给 → 下一个箱子强制反超道具」的保底计数，按玩家分开记
    this.pity = new Map();     // id -> { miss, pending: [{ t, item }] }
    this.clock = 0;            // 由 update() 写入，给保底计时用
    // 被护盾墙挡下的弹体计数。生产上没用途，纯粹给联机验收断言
    // 「墙真的拦住了东西」——否则测试只能看弹道消失，分不清是撞墙还是飞到期。
    this.wallBlocks = 0;
    this.#buildBoxes();
  }

  #makeMagnetReticle() {
    const corners = (width, height, corner) => {
      const x = width * 0.5;
      const y = height * 0.5;
      const p = [
        -x, y, 0, -x + corner, y, 0, -x, y, 0, -x, y - corner, 0,
        x, y, 0, x - corner, y, 0, x, y, 0, x, y - corner, 0,
        -x, -y, 0, -x + corner, -y, 0, -x, -y, 0, -x, -y + corner, 0,
        x, -y, 0, x - corner, -y, 0, x, -y, 0, x, -y + corner, 0,
      ];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      return geo;
    };
    const group = new THREE.Group();
    const neutral = new THREE.LineSegments(
      corners(7.2, 4.6, 1.25),
      new THREE.LineBasicMaterial({ color: 0xc8f4ff, transparent: true, opacity: 0.72, depthTest: false }),
    );
    const locked = new THREE.LineSegments(
      corners(6.2, 3.9, 1.05),
      new THREE.LineBasicMaterial({ color: 0xff283d, transparent: true, opacity: 0.96, depthTest: false }),
    );
    neutral.renderOrder = 10;
    locked.renderOrder = 10;
    group.add(neutral, locked);
    group.visible = false;
    this.scene.add(group);
    return { group, neutral, locked };
  }

  #updateMagnetReticle(t) {
    const reticle = this.magnetReticle;
    const aim = this.magnetAim;
    const boat = this.getBoats().get(this.myId);
    if (!reticle || !aim || !boat) {
      if (reticle) reticle.group.visible = false;
      return;
    }
    const target = aim.target ? this.getBoats().get(aim.target) : null;
    const locked = !!target;
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const anchor = target
      ? { x: target.pos.x, y: (target.pos.y || 0) + 2.05, z: target.pos.z }
      : { x: boat.pos.x + fx * 11, y: (boat.pos.y || 0) + 2.15, z: boat.pos.z + fz * 11 };
    reticle.group.position.set(anchor.x, anchor.y, anchor.z);
    const camera = this.getCamera();
    if (camera) reticle.group.quaternion.copy(camera.quaternion);
    reticle.neutral.visible = !locked;
    reticle.locked.visible = locked;
    const pulse = 1 + Math.sin(t * (locked ? 12 : 7)) * (locked ? 0.06 : 0.035);
    reticle.group.scale.setScalar(pulse);
    reticle.neutral.material.opacity = 0.52 + Math.sin(t * 7) * 0.2;
    reticle.group.visible = true;
  }

  /**
   * 泡泡蜻蜓的异世界：受击者本地切进一个**童话幻境**（粉紫→玫瑰→薄荷青的
   * 梦幻星云 + 飘动金色星尘），持续 3 秒；别人眼里受击艇留在赛道原地冻结，
   * 头顶冒晕眩金星。幻境用 index.html 里的 #void-dream CSS 全屏层实现 ——
   * 实拍验证过 3D 球壳方案会被起点线等透明物体穿透（后处理 + 透明队列排序），
   * CSS 层能 100% 盖住所有 3D/HUD，且零 GPU 开销。
   */
  #ensureVoidWorld() {
    if (this.voidWorld) return this.voidWorld;
    const el = typeof document !== 'undefined' ? document.getElementById('void-dream') : null;
    this.voidWorld = { el };
    return this.voidWorld;
  }

  #updateVoidWorld(dt, t) {
    const world = this.#ensureVoidWorld();
    const on = this.voidTimer > 0;
    if (!world.el) return;
    // 淡出交给 CSS transition（.28s）；这里只切换 class，避免每帧写样式。
    // 淡入同理，CSS 从 opacity 0 → 1 自然过渡，读成被光雾慢慢裹进去。
    if (on !== this._voidShown) {
      world.el.classList.toggle('hidden', !on);
      // 先移除 hidden，下一帧再加 show，保证 transition 触发
      if (on) requestAnimationFrame(() => world.el.classList.add('show'));
      else world.el.classList.remove('show');
      this._voidShown = on;
    }
  }

  // ---------- Effekseer 特效 ----------
  #playFx(name, x, z, y = 1, heading = null) {
    if (!this.fx) return;
    const handle = this.fx.play(name, x, y, z);
    if (handle && heading != null && handle.setRotation) handle.setRotation(0, heading, 0);
  }

  #fxShield(boat, id, dur) {
    if (!this.fx) return;
    this.#fxHullBarrier(boat, `shield:${id}`, 'shield', dur, true);
  }

  #fxHullBarrier(boat, key, effect, life, loop) {
    if (!this.fx || !boat) return;
    this.fx.playAttached(key, effect, () => {
      const envelope = boat.getEffectEnvelope?.();
      return envelope || { x: boat.pos.x, y: (boat.pos.y || 0) + 0.7, z: boat.pos.z };
    }, {
      life,
      loop,
      // Barrior03 has a larger authored radius than the regular barrier.
      scale: () => boat.getEffectEnvelope?.().scale || 1.25,
    });
  }

  /**
   * 把世界坐标换成这一声的"左右 + 远近"。
   * 追尾视角下屏幕右方 = (cos h, −sin h)，所以用位置在右向上的投影当 pan；
   * 越远越小声。没有本机艇 / 没给坐标时退回全屏均匀音量（和以前一样）。
   */
  #sfxAt(x, z, maxDist = 180) {
    try {
    const me = this.getBoats()?.get(this.myId);
    if (!me || x == null || z == null) return { pan: 0, vol: 1 };
    const dx = x - me.pos.x, dz = z - me.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.01) return { pan: 0, vol: 1 };
    const h = me.heading || 0;
    const right = (dx * Math.cos(h) - dz * Math.sin(h)) / dist;
    return {
      pan: Math.max(-1, Math.min(1, right * 0.9)),
      vol: Math.max(0.3, Math.min(1, 1 - dist / maxDist)),
    };
    } catch { return { pan: 0, vol: 1 }; }
  }

  /**
   * 攻击预警：只在"这次攻击真的会打到本机"时响，避免别人一放道具就满屏报警。
   * 三种判定：点名锁定我 / 全场型 / 弹道射线经过我附近的区域型。
   * 每次攻击（同一使用者 + 同一道具）500ms 内只响一次 —— 出手和弹道特效两处都会调它。
   */
  #maybeWarn(item, ownerId, x, z, vx, vz, target) {
    // 音效绝不能影响玩法：任何异常（音频节点/浏览器策略/脏坐标）都只让这一声不响，
    // 不能冒出去中断 useItem 或 handleNet —— 那样道具会整个失效。
    try {
    if (ownerId === this.myId || !THREAT_ITEMS.has(item)) return;
    const me = this.getBoats()?.get(this.myId);
    if (!me) return;
    let threat = false;
    if (target === this.myId || GLOBAL_THREATS.has(item)) {
      threat = true;
    } else if (ZONE_KINDS.includes(item)) {
      threat = Math.hypot(me.pos.x - x, me.pos.z - z) < 34;
    } else if (vx != null && vz != null && Math.abs(vx) + Math.abs(vz) > 0) {
      // 本机到弹道射线的垂直距离：直线弹靠这个预判，追踪弹另有 target 命中
      const dx = me.pos.x - x, dz = me.pos.z - z;
      const len = Math.hypot(vx, vz) || 1;
      const along = (dx * vx + dz * vz) / len;
      if (along > -8) threat = Math.abs(dx * vz - dz * vx) / len < 15;
    }
    if (!threat) return;
    const key = `${ownerId}:${item}`;
    if (!this._lastWarn) this._lastWarn = new Map();
    const now = performance.now();
    if (now - (this._lastWarn.get(key) || 0) < 500) return;
    this._lastWarn.set(key, now);
    const at = this.#sfxAt(x, z);
    // gap:0 必须写：同名音效默认 60ms 节流，多道具同帧命中时会把预警吞掉
    audio.play('incoming_alert', { gap: 0, pan: at.pan, vol: at.vol });
    } catch { /* 预警音失败不影响道具本身 */ }
  }

  /** 被护盾挡下时告诉受害者一声：否则 shield_break 永远播不到（命中消息根本没发出去） */
  #reportBlocked(targetId, ownerId, x, z) {
    try {
    if (targetId === this.myId) {
      const at = this.#sfxAt(x, z);
      // gap 300：本地先播一次，随后服务端转发回来的同一条消息会再触达一次，别响两遍
      audio.play('item_blocked', { gap: 300, pan: at.pan, vol: at.vol });
      this._lastBlockToast = performance.now();
      this.onToast('🛡️ 护盾抵挡了攻击！');
    }
    this.net.send({
      t: 'itemFx', id: targetId, fx: 'blocked', by: ownerId,
      x: +x.toFixed(1), z: +z.toFixed(1),
    });
    } catch { /* 拦截提示失败不影响拦截本身 */ }
  }

  #addProjectile(projectile) {
    // 弹道类攻击：本机是受害者时给带方向的预警（施放者自己不用听）
    this.#maybeWarn(
      projectile.type, projectile.owner,
      projectile.x, projectile.z, projectile.vx, projectile.vz, projectile.target,
    );
    projectile.fxKey = `projectile:${projectile.type}:${projectile.owner}:${++this.projectileSeq}`;
    // 追踪参数集中放在 Homing.js，命中半径 / 初速 / 寿命都从这里取，
    // 不再在 useItem 里散落魔法数字（以前四个弹道各写一套，改一处漏三处）。
    const cfg = homingConfig(projectile.type);
    if (cfg) {
      projectile.cfg = cfg;
      if (projectile.life == null) {
        // 寿命按"到目标的距离"自适应：固定 8s 的追踪弹在目标拉开 500m 时
        // 会在半路耗尽，表现就是"明明放出去了、对方既没受击特效也没停滞"。
        // 追踪弹本来就该追到底，这里只保证它有足够时间飞到（上限 14s）。
        let life = cfg.life;
        const tb = projectile.target ? this.getBoats().get(projectile.target) : null;
        if (tb) {
          const d = Math.hypot(tb.pos.x - projectile.x, tb.pos.z - projectile.z);
          const reach = d / Math.max(20, cfg.launch || cfg.speed) * 1.7 + 0.6;
          life = Math.max(cfg.life, Math.min(14, reach));
        }
        projectile.life = life;
      }
    }
    this.projectiles.push(projectile);
    if (projectile.type === 'bomb' && this.fx) {
      this.fx.playAttached(projectile.fxKey, 'itemBeam', () => ({
        x: projectile.x,
        y: projectile.mesh?.position.y ?? 0.8,
        z: projectile.z,
      }), {
        life: projectile.life,
        loop: true,
        rot: () => ({ x: 0, y: Math.atan2(projectile.vx, projectile.vz), z: 0 }),
      });
    }
    return projectile;
  }

  #stopProjectileFx(projectile) {
    if (projectile?.fxKey) this.fx?.stopAttached(projectile.fxKey);
  }

  #fxVortex(x, z, life) {
    if (!this.fx) return;
    this.fx.playAttached('vortex:' + x.toFixed(1) + ':' + z.toFixed(1), 'tornado',
      () => ({ x, y: 0.2, z }), { life, loop: true });
  }

  #fxMagnet(boat, targetId, life) {
    if (!this.fx || !boat || !targetId) return;
    const key = `magnet:${boat.group.uuid}:${targetId}`;
    this.fx.playAttached(key, 'magnet', () => {
      const target = this.getBoats().get(targetId);
      if (!target) return { x: boat.pos.x, y: (boat.pos.y || 0) + 0.7, z: boat.pos.z };
      return {
        x: (boat.pos.x + target.pos.x) * 0.5,
        y: ((boat.pos.y || 0) + (target.pos.y || 0)) * 0.5 + 0.8,
        z: (boat.pos.z + target.pos.z) * 0.5,
      };
    }, { life, loop: true });
  }

  #stopMagnetFx(boat, targetId) {
    if (!this.fx || !boat || !targetId) return;
    this.fx.stopAttached(`magnet:${boat.group.uuid}:${targetId}`);
  }

  // ---------- 区域型道具（沙暴 / 圣域 / 护盾墙 / 剑刃风暴）----------
  // 设计约定：区域由施放者用一条 itemUse 广播「位置 + 半径 + 时长」，
  // 之后**效果由各端在本地判给自己**（自己是不是站在别人的区域里）。
  // 这样跨端一定一致，也不会有「区域每帧发一次同步」的流量。
  // 视觉也全交给 Effekseer（playAttached），不再生成任何 Three.js 光圈/圆筒。

  #spawnZone(kind, owner, x, z, hx, hz, r, dur, follow = false) {
    const key = `zone:${++this.zoneSeq}`;
    const zone = {
      kind, owner, x, z, hx, hz, r, life: dur, maxLife: dur,
      group: null, follow, seen: new Set(), hit: new Set(), key, fxKeys: [],
    };
    this.zones.push(zone);
    if (!this.fx) return zone;

    const t0 = performance.now();
    const at = (px, pz, py) => () => ({ x: px, y: py, z: pz });
    const followCenter = (py) => () => ({ x: zone.x, y: py, z: zone.z });
    // 绕圈：中心 + 半径 + 角速度 + 相位
    const orbitAt = (rad, speed, ph, py) => () => {
      const ang = ((performance.now() - t0) / 1000) * speed + ph;
      return { x: zone.x + Math.cos(ang) * rad, y: py, z: zone.z + Math.sin(ang) * rad };
    };
    const add = (name, followFn, scale, y = 0, tag = '') => {
      const k = `${key}:${tag || name}`;
      this.fx.playAttached(k, name, followFn, { life: dur, loop: true, scale });
      zone.fxKeys.push(k);
    };

    // 2026-11-14 改版：区域类道具**不再画任何 Three.js 光圈/圆筒**，视觉全交给 Effekseer。
    // 素材实测（同机位对照）：fxHolySandstorm 是白灰尘卷（4 倍≈8m），
    // fxMagic2Holy 是**正对相机的符文圆盘**（setRotation 无效，铺不平地），
    // shield(Barrior01) 是青色半球罩（2 倍≈8m），fxBenediction 是柔和大金光。
    // 所以不去拉大单个特效（会糊），统一用「多个原尺寸实例排布」。
    if (kind === 'holystorm') {
      // 沙暴：外圈 8 团 + 内圈 4 团尘卷，铺满 14m 区域
      const R = zone.r || r;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        add('fxHolySandstorm', at(zone.x + Math.cos(a) * R * 0.62, zone.z + Math.sin(a) * R * 0.62, 1.0),
          2.6, 1.0, `o${i}`);
      }
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        add('fxHolySandstorm', at(zone.x + Math.cos(a) * R * 0.28, zone.z + Math.sin(a) * R * 0.28, 1.2),
          2.2, 1.2, `i${i}`);
      }
    } else if (kind === 'sanctuary') {
      // 圣域：一圈白色圣光尘雾围出 8m 结界 + 中心金色圣光。
      // （曾试过用 fxMagic2Holy 符文盘做封印，但它只在放大到 8 倍时显形、
      //   小尺寸几乎不可见，且 setRotation 无效铺不平地，实测放弃）
      const R = zone.r || r;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        add('fxHolySandstorm',
          at(zone.x + Math.cos(a) * R * 0.84, zone.z + Math.sin(a) * R * 0.84, 0.9),
          1.7, 0.9, `seal${i}`);
      }
      add('fxBenediction', followCenter(3.2), 0.75, 3.2, 'light');
    } else if (kind === 'bladestorm') {
      // 剑刃风暴：20 道小尺寸刀光高速绕圈（scale ≥1 会把贴图集整块露成方片，必须小）
      const R = zone.r || r;
      for (let i = 0; i < 20; i++) {
        add('fxSword1', orbitAt(R * 0.6, 4.6, (i * Math.PI) / 10, 0.9 + (i % 4) * 0.5), 0.68, 0.9, `blade${i}`);
      }
      for (let i = 0; i < 4; i++) {
        add('fxSwordStorm', orbitAt(R * 0.26, 5.4, (i / 4) * Math.PI * 2, 1.3), 0.75, 1.3, `storm${i}`);
      }
    } else if (kind === 'barrier') {
      // 护盾墙：3 个青色半球罩沿墙向排开、互相压叠成一道连续力场墙
      for (let i = 0; i < 3; i++) {
        const u = (i - 1) * r * 0.5;
        add('shield', at(x + hx * u, z + hz * u, 0.15), 1.9, 0.15, `seg${i}`);
      }
    }
    return zone;
  }

  /** 线段相交（用于护盾墙挡弹） */
  #segCross(ax, az, bx, bz, cx, cz, dx, dz) {
    const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
    const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }

  /** 这一帧的弹道线段是否被别家的护盾墙挡住；返回挡住它的墙（没有则 null） */
  #blockedByWall(p, ax, az) {
    if (!this.zones.length) return null;
    for (const z of this.zones) {
      if (z.kind !== 'barrier' || z.owner === p.owner) continue;
      // 组队规则：队友的弹道直接穿过护盾墙，只挡敌方来袭
      if (this.isTeammate(z.owner, p.owner)) continue;
      const x1 = z.x - z.hx * z.r, z1 = z.z - z.hz * z.r;
      const x2 = z.x + z.hx * z.r, z2 = z.z + z.hz * z.r;
      if (this.#segCross(ax, az, p.x, p.z, x1, z1, x2, z2)) return z;
    }
    return null;
  }

  /**
   * 护盾墙救援统计：挡下的这发弹原本会打到墙主人的队友吗？
   * 近似判定 —— 弹道前进方向 45m 内、横向偏移 4.5m 内有队友，就认为救下了一发。
   * 只有墙主人（或主机代算的 AI 墙）上报，避免多端重复计数。
   */
  #reportWallRescue(zone, p) {
    if (!zone || !p) return;
    const owner = zone.owner;
    if (owner !== this.myId && !(this.isHost && owner.startsWith('ai'))) return;
    if (this.isTeammate(owner, p.owner)) return; // 自己人打的弹不算救援
    const len = Math.hypot(p.vx, p.vz) || 1;
    const dx = p.vx / len, dz = p.vz / len;
    for (const [id, b] of this.getBoats()) {
      if (id === owner || !this.isTeammate(owner, id)) continue;
      const rx = b.pos.x - p.x, rz = b.pos.z - p.z;
      const along = rx * dx + rz * dz;
      if (along < 0 || along > 45) continue;
      if (Math.abs(rx * dz - rz * dx) > 4.5) continue;
      this.net.send({ t: 'itemStat', kind: 'rescue', by: owner });
      return;
    }
  }

  #updateZones(dt, t) {
    if (!this.zones.length) return;
    const boats = this.getBoats();
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i];
      z.life -= dt;
      if (z.follow) {
        const b = boats.get(z.owner);
        if (b) { z.x = b.pos.x; z.z = b.pos.z; }
      }
      if (z.life <= 0) {
        this.#disposeZone(z);
        this.zones.splice(i, 1);
        continue;
      }
      if (z.kind !== 'barrier') this.#applyZoneEffects(z, dt);
    }
  }

  /**
   * 区域效果只落到「本机权威的船」：自己的船 / 主机代算的 AI。
   * 别人的船由别人自己判，跨端一致且零同步流量。
   */
  #applyZoneEffects(z, dt) {
    const boats = this.getBoats();
    for (const [id, boat] of boats) {
      if (id === z.owner) continue;
      // 圣光沙暴是攻击区：队友进区不减速、不糊眼。
      // 剑刃风暴 / 圣域按组队规则会挡住队友，所以不跳过。
      if (z.kind === 'holystorm' && this.isTeammate(z.owner, id)) continue;
      const mine = id === this.myId || (this.isHost && id.startsWith('ai'));
      if (!mine) continue;
      const dx = boat.pos.x - z.x;
      const dz = boat.pos.z - z.z;
      const d = Math.hypot(dx, dz) || 1;
      if (d > z.r) continue;
      if (z.kind === 'holystorm') {
        boat.applyFx('halfSpeed', ZONE_TICK);
        if (id === this.myId) {
          this.inkTimer = Math.max(this.inkTimer, ZONE_TICK + 0.1);
          if (!z.seen.has(id)) { z.seen.add(id); this.onToast('🌪️ 被圣光沙暴糊住，速度减半！'); }
        }
      } else if (z.kind === 'sanctuary') {
        boat.applyFx('halfSpeed', ZONE_TICK);
        // 往回推：直接写 vel（Boat 每帧重解速度，施力会被抓地吃掉）
        boat.vel.x += (dx / d) * SANCTUARY_PUSH * dt;
        boat.vel.y += (dz / d) * SANCTUARY_PUSH * dt;
        if (id === this.myId && !z.seen.has(id)) { z.seen.add(id); this.onToast('✨ 被圣域挡住了！'); }
      } else if (z.kind === 'bladestorm') {
        boat.applyFx('slow', ZONE_TICK + 0.05);
        if (!z.hit.has(id)) {
          z.hit.add(id);
          boat.vel.x += (dx / d) * BLADE_STORM_KNOCK;
          boat.vel.y += (dz / d) * BLADE_STORM_KNOCK;
          boat.stunTimer = Math.max(boat.stunTimer, 0.28);
          if (id === this.myId) this.onToast('⚔️ 被剑刃风暴劈开了！');
        }
      }
    }
  }

  #disposeZone(z) {
    // 区域视觉全在 Effekseer 上：按登记过的键逐个停（护盾墙/剑刃风暴是多段拼接）
    if (Array.isArray(z.fxKeys)) {
      for (const k of z.fxKeys) this.fx?.stopAttached(k);
      z.fxKeys.length = 0;
    }
    if (z.group) {
      this.scene.remove(z.group);
      z.group.traverse?.((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          o.material?.dispose?.();
        }
      });
      z.group = null;
    }
    this.fx?.stopAttached(z.key);
  }

  // ---------- 道具箱 ----------
  #buildBoxes() {
    // 无赛道模式（竞技场）：直接给坐标表，跳过「沿赛道弧长布点」那一整套。
    // 那条逻辑依赖 gates / gateWidth / 近道 / 抬高段，竞技场一个都没有。
    if (Array.isArray(this.opts?.boxLayout)) {
      for (const p of this.opts.boxLayout) {
        this.boxes.push({
          idx: this.boxes.length, x: p.x, z: p.z, y: p.y ?? 0, active: true, respawn: 0,
        });
      }
      this.boxField = new ItemBoxField(this.scene, this.boxes.length, {
        size: 1.5, floatHeight: 1.55, bob: 0.26, spin: 0.55,
      });
      return;
    }
    const gates = this.track.gates;
    const N = gates.length;
    const width = this.track.gateWidth; // 半宽
    const push = (x, z) => this.boxes.push({
      idx: this.boxes.length, x, z,
      // 抬高段（瀑布/云端/栈道）要把箱子放到赛道面上，不能贴海面
      y: this.track.surfaceYAt ? this.track.surfaceYAt(x, z) : 0,
      active: true, respawn: 0,
    });

    // ---- 按「沿赛道弧长」布点，而不是按门号 ----
    // 各图门数差 8 倍（canyon 24 门 / baked 209 门），按门号取步长会让
    // 短图每 2 个门就一排（挤成墙）、长图十几排铺在两公里上（空得看不见）。
    // 统一改成「每 ROW_GAP 米一排」，几张图的密度就一致了。
    const segLen = [];
    let total = 0;
    for (let i = 0; i < N; i++) {
      const a = gates[i], b = gates[(i + 1) % N];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      segLen.push(d);
      total += d;
    }
    // 给定弧长 → 中线上的点 + 该处的横向法线
    const posAt = (sIn) => {
      let s = ((sIn % total) + total) % total;
      let i = 0;
      while (s > segLen[i] && i < N - 1) { s -= segLen[i]; i++; }
      const a = gates[i], b = gates[(i + 1) % N];
      const L = segLen[i] || 1;
      const t = Math.max(0, Math.min(1, s / L));
      return {
        x: a[0] + (b[0] - a[0]) * t,
        z: a[1] + (b[1] - a[1]) * t,
        nx: -(b[1] - a[1]) / L,
        nz: (b[0] - a[0]) / L,
      };
    };

    const ROW_GAP = 95;                                   // 每排间隔（米）
    const rows = Math.max(8, Math.min(18, Math.round(total / ROW_GAP)));
    const gap = total / rows;
    // 窄道（海峡/漂流 7.5~8m 半宽）放 5 个就够选线，宽道放 7 个
    const PER_ROW = width >= 12 ? 7 : 5;
    // 发车格后面留出 40m 空档：第一排不压在起跑线上，避免一开赛就整队吃箱
    const FIRST_OFFSET = Math.min(40, gap * 0.5);
    for (let r = 0; r < rows; r++) {
      const p = posAt(FIRST_OFFSET + r * gap);
      for (let j = 0; j < PER_ROW; j++) {
        const off = (j / (PER_ROW - 1) - 0.5) * 2 * width * 0.78;
        push(p.x + p.nx * off, p.z + p.nz * off);
      }
    }
    // Palace finish approach gets a denser chase line of boxes.
    for (const gateIndex of this.track.map.bonusItemGates || []) {
      const [gx, gz] = gates[gateIndex] || [];
      const nxt = gates[(gateIndex + 1) % gates.length];
      if (!nxt || gx == null) continue;
      const dx = nxt[0] - gx;
      const dz = nxt[1] - gz;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len;
      const nz = dx / len;
      for (const off of [-0.62, 0.62]) {
        push(gx + nx * width * off, gz + nz * width * off);
      }
    }
    // 近道内奖励道具箱：每条近道 3 个（左/中/右各一）。
    // 近道是「省时间」的路线，道具只给一点点甜头，不能变成补给站。
    if (this.track.shortcuts) {
      for (const sc of this.track.shortcuts) {
        const mid = sc.points[Math.floor(sc.points.length / 2)];
        const prev = sc.points[Math.floor(sc.points.length / 2) - 1] || sc.points[0];
        const dx = mid[0] - prev[0];
        const dz = mid[1] - prev[1];
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        for (const lane of [-1, 0, 1]) {
          const off = lane * sc.width * 0.78;
          push(mid[0] + nx * off, mid[1] + nz * off);
        }
      }
    }
    // 整套外观合批：面板 / 金属框 / 问号 / 水面光环 / 环绕光点
    this.boxField = new ItemBoxField(this.scene, this.boxes.length, {
      size: 1.5,
      floatHeight: 1.55,
      bob: 0.26,
      spin: 0.55,
    });
  }

  #updateBoxes(dt, t) {
    for (const b of this.boxes) {
      if (b.respawn > 0) {
        b.respawn -= dt;
        if (b.respawn <= 0) b.active = true;
      }
    }
    this.boxField?.update(t, this.boxes);
  }

  // ---------- 抽奖 + 反超保底 ----------
  /** 按玩家分开的保底状态 */
  #pityFor(id) {
    let p = this.pity.get(id);
    if (!p) { p = { miss: 0, pending: [] }; this.pity.set(id, p); }
    return p;
  }

  /**
   * 抽一件道具。
   * 保底规则（玩家要求）：连续两次「放了攻击道具但一下都没打中」，下一次强制出反超类，
   * 免得落后的人连续拿到打空的炸弹，越追越绝望。
   */
  #rollFor(takerId) {
    const rank = this.getRank(takerId);
    const total = this.getBoats().size;
    const p = this.#pityFor(takerId);
    let pool = this.itemPool;
    if (p.miss >= 2) {
      // 竞技场等自定池要按池子求交，别把池外道具塞进去
      const comeback = COMEBACK_POOL.filter((k) => !pool || pool.includes(k));
      if (comeback.length) {
        pool = comeback;
        p.miss = 0;
        p.pending.length = 0;
      }
    }
    return rollItem(rank, total, pool);
  }

  /** 记一次攻击出手，等待结算是否命中 */
  #noteAttackUse(id, item) {
    if (!ATTACK_ITEMS.includes(item)) return;
    const p = this.#pityFor(id);
    p.pending.push({ t: this.clock, item });
  }

  /** 攻击真的打中了：清空待结算与失败计数 */
  #noteHit(id) {
    const p = this.#pityFor(id);
    p.pending.length = 0;
    p.miss = 0;
    // 命中回调（天梯第 3 层的"打中 +1"靠它计数）。一处挂、所有弹道/区域都覆盖。
    this.onHit?.(id);
  }

  /** 出手 4 秒还没结算命中 → 记一次白给 */
  #tickPity(dt) {
    for (const [id, p] of this.pity) {
      if (!p.pending.length) continue;
      for (let i = p.pending.length - 1; i >= 0; i--) {
        if (this.clock - p.pending[i].t > 4) {
          p.miss += 1;
          p.pending.splice(i, 1);
        }
      }
    }
  }

  /**
   * 外部奖励发一件道具（撞碎火山岩掉落的奖励核走这里）。
   * 与开箱取道具共用同一套抽奖 / 槽位规则，只是没有箱子模型。
   * @param {string} takerId
   * @returns {string|null} 抽到的道具 id（槽位满 / 非本机且非主机时返回 null）
   */
  grantRandomItem(takerId) {
    const item = this.#rollFor(takerId);
    if (takerId === this.myId) {
      const slot = this.myItems.indexOf(null);
      if (slot === -1) return null;
      this.myItems[slot] = item;
      this.onToast(`获得 ${ITEM_DEFS[item].icon} ${ITEM_DEFS[item].name}（按 ${this.slotKeys[slot]} 使用）`);
    } else if (this.isHost) {
      let ai = this.aiItems.get(takerId);
      if (!ai) { ai = { items: [], useAt: 0 }; this.aiItems.set(takerId, ai); }
      if (ai.items.length >= 3) return null;
      ai.items.push(item);
      if (ai.items.length === 1) ai.useAt = performance.now() / 1000 + 1 + Math.random() * 2;
    } else {
      return null;
    }
    this.syncHeld(takerId);
    return item;
  }

  #takeBox(b, takerId) {
    b.active = false;
    b.respawn = this.boxRespawn;
    this.onTakeBox?.(takerId, b);
    if (takerId === this.myId) audio.play('pickup');
    // 拾取者获得道具（权重按名次 + 反超保底）
    const item = this.#rollFor(takerId);
    const SLOT_KEYS = this.slotKeys;
    if (takerId === this.myId) {
      const slot = this.myItems.indexOf(null);
      if (slot === -1) return; // 道具栏已满（调用处已拦截，防御性兜底）
      this.myItems[slot] = item;
      this.onToast(`获得 ${ITEM_DEFS[item].icon} ${ITEM_DEFS[item].name}（按 ${SLOT_KEYS[slot]} 使用）`);
      // 军需官：拾取箱子有概率再补一件（只影响本地玩家，不改变箱子刷新节奏）
      if (this.bonusChance > 0 && Math.random() < this.bonusChance) {
        const slot2 = this.myItems.indexOf(null);
        if (slot2 !== -1) {
          const extra = this.#rollFor(takerId);
          this.myItems[slot2] = extra;
          this.onToast(`军需官：额外获得 ${ITEM_DEFS[extra].icon} ${ITEM_DEFS[extra].name}`);
        }
      }
    } else if (this.isHost) {
      let ai = this.aiItems.get(takerId);
      if (!ai) {
        ai = { items: [], useAt: 0 };
        this.aiItems.set(takerId, ai);
      }
      if (ai.items.length >= 3) return; // AI 道具栏满
      ai.items.push(item);
      if (ai.items.length === 1) ai.useAt = performance.now() / 1000 + 1 + Math.random() * 2;
    }
    this.syncHeld(takerId);
  }

  // ---------- 道具使用 ----------
  #activateMagnet(id, target) {
    const boat = this.getBoats().get(id);
    if (!boat || !target) {
      if (id === this.myId) this.onToast('磁铁未找到目标，道具失效');
      this.net.send({ t: 'itemFx', id, fx: 'magnet', dur: 0, target: null });
      return false;
    }
    const targetBoat = this.getBoats().get(target);
    if (targetBoat?.shieldTimer > 0) {
      if (id === this.myId) this.onToast('目标护盾生效，磁铁被抵挡');
      this.net.send({ t: 'itemFx', id, fx: 'magnet', dur: 0, target: null });
      return false;
    }
    boat.magnetTimer = 2.5;
    boat.magnetTarget = target;
    this.#fxMagnet(boat, target, 2.5);
    if (id === this.myId) this.onToast('🧲 磁力吸盘启动，飞向前方目标！');
    this.net.send({ t: 'itemFx', id, fx: 'magnet', dur: 2.5, target });
    return true;
  }

  useItem(id, item, slot = -1) {
    const boats = this.getBoats();
    const boat = boats.get(id);
    if (!boat) return false;

    // 道具音效：只给本地艇播。这个函数同时给 AI 和客机回放用（Items 的 AI
    // 自动放道具、联机 itemUse 回放都走这里），全播就变成一堆非定位音叠在一起，
    // 分不清是谁在放什么，反而盖住了自己的道具声。
    if (boat.isLocal) audio.play(itemSfxName(item));
    // 全场 / 区域类没有弹道（不走 #addProjectile）：单机 AI 放这些时也要提醒本地玩家。
    // 联机时施放者本机 id===myId 会直接跳过，由接收端的 itemUse 分支补上。
    this.#maybeWarn(item, id, boat.pos.x, boat.pos.z, 0, 0, null);
    // 攻击类出手先记一笔，4 秒内没结算命中就算"白给"（反超保底用）
    this.#noteAttackUse(id, item);

    switch (item) {
      case 'nitro': {
        boat.applyFx('nitro');
        break;
      }
      case 'shield': {
        boat.applyFx('shield', DEFENSE_DURATION);
        this.#fxShield(boat, id, DEFENSE_DURATION);
        // 符文六角阵在船底铺一层，护盾的“神圣感”靠它立起来
        this.#playFx('fxMagic2Holy', boat.pos.x, boat.pos.z, 0.45);
        this.net.send({ t: 'itemFx', id, fx: 'shield', dur: DEFENSE_DURATION });
        break;
      }
      case 'bomb': {
        // 深水炸弹：自动跟踪前一名（自己第一则打第二），命中炸沉
        const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
        const target = this.#findChaseTarget(id);
        const launch = homingConfig('bomb').launch;
        let vx = fx * launch, vz = fz * launch;
        const tb = target ? boats.get(target) : null;
        if (tb) {
          // 有目标：初速直接朝目标，随后持续追踪
          const dx = tb.pos.x - boat.pos.x, dz = tb.pos.z - boat.pos.z;
          const len = Math.hypot(dx, dz) || 1;
          vx = dx / len * launch; vz = dz / len * launch;
        }
        const proj = this.#addProjectile({
          type: 'bomb', owner: id, x: boat.pos.x + fx * 3, z: boat.pos.z + fz * 3,
          vx, vz, target, mesh: this.#makeBomb(),
        });
        this.net.send({ t: 'itemUse', id, item, x: boat.pos.x + fx * 3, z: boat.pos.z + fz * 3, vx, vz, target, life: +proj.life.toFixed(2) });
        break;
      }
      case 'missile': {
        // 锁定前一名（自己除外；自己是第一则打第二）
        const target = this.#findChaseTarget(id);
        const launch = homingConfig('missile').launch;
        const vx0 = Math.sin(boat.heading) * launch;
        const vz0 = Math.cos(boat.heading) * launch;
        const proj = this.#addProjectile({
          type: 'missile', owner: id, x: boat.pos.x, z: boat.pos.z,
          vx: vx0, vz: vz0, target, mesh: this.#makeMissile(),
        });
        this.#playFx('missile', boat.pos.x, boat.pos.z, 1.4, boat.heading);
        this.net.send({ t: 'itemUse', id, item, x: boat.pos.x, z: boat.pos.z, vx: vx0, vz: vz0, target, life: +proj.life.toFixed(2) });
        break;
      }
      case 'octopus': {
        // 追踪章鱼怪：从船头弹射，短距离自动追名次前一位的对手
        const target = this.#findChaseTarget(id);
        const launch = homingConfig('octopus').launch;
        const vx0 = Math.sin(boat.heading) * launch;
        const vz0 = Math.cos(boat.heading) * launch;
        const p = this.#addProjectile({
          type: 'octopus', owner: id, x: boat.pos.x, z: boat.pos.z,
          vx: vx0, vz: vz0, target, mesh: this.#makeOctopus(),
        });
        this.#playFx('fxMagicDark', boat.pos.x, boat.pos.z, 1.1, boat.heading);
        this.net.send({ t: 'itemUse', id, item, x: boat.pos.x, z: boat.pos.z, vx: vx0, vz: vz0, target, life: +p.life.toFixed(2) });
        break;
      }
      case 'vortex': {
        // 漩涡 → 巨型水弹：沿主赛道中线往前 100 米处浮起水泡, 引信 0.45s 后炸开.
        // 必须沿赛道弧线投, 直线投在弯道会把水弹甩到护栏外。
        // AoE 判定仅施放者客户端执行(因 AoE 是一次性、跨多目标的施放型效果),
        // 命中目标触发 bubbleLift(空中悬浮 3s 后下坠);其余客户端仅复制视觉。
        const ahead = this.track?.routeAhead?.(
          boat.pos.x, boat.pos.z, this.getGate(id), BUBBLE_BOMB_DISTANCE,
        );
        const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
        const bx = ahead ? ahead.x : boat.pos.x + fx * BUBBLE_BOMB_DISTANCE;
        const bz = ahead ? ahead.z : boat.pos.z + fz * BUBBLE_BOMB_DISTANCE;
        this.#spawnBubbleBomb(id, bx, bz);
        this.#playFx('bubble', bx, bz, 1.4);
        this.net.send({ t: 'itemUse', id, item, x: +bx.toFixed(1), z: +bz.toFixed(1) });
        break;
      }
      case 'magnet': {
        if (id === this.myId && slot >= 0) {
          if (!this.magnetAim || this.magnetAim.slot !== slot) {
            this.magnetAim = {
              slot,
              target: this.#findMagnetTarget(id, true, true),
              timer: 2.2,
              noTargetGrace: 0.7,
              lockDelay: 0.38,
            };
            this.onToast('磁铁扫描前方目标');
            return false;
          }
          if (!this.magnetAim.target) {
            // 主动取消/确认时依然没吸到人：道具照常消耗，不退还
            this.myItems[slot] = null;
            this.magnetAim = null;
            this.onToast('没有吸到目标，磁铁已消耗');
            return true;
          }
          const lockedTarget = this.magnetAim.target;
          this.magnetAim = null;
          this.#activateMagnet(id, lockedTarget);
          return true;
        }
        // AI / 网络调用直接使用已选目标（组队时队友也可以被吸）。
        const target = this.#findMagnetTarget(id, true, true);
        this.#activateMagnet(id, target);
        break;
      }
      case 'ink': {
        // 墨鱼喷墨：黑雾糊住除自己外全部对手（糊屏5秒 + 短暂失控减速）
        let hitAny = false;
        for (const [oid, ob] of boats) {
          if (oid === id) continue;
          if (this.isTeammate(id, oid)) continue; // 组队：不喷队友
          if (ob.shieldTimer > 0) { this.#reportBlocked(oid, id, ob.pos.x, ob.pos.z); continue; } // 护盾免疫
          hitAny = true;
          this.#playFx('ink', ob.pos.x, ob.pos.z, 1.2);
          this.#playFx('fxMonsterRoar', ob.pos.x, ob.pos.z, 1.0);
          this.#spawnBurst(ob.pos.x, ob.pos.z, 4);
          this.#playFx('hit', ob.pos.x, ob.pos.z, 1);
          this.net.send({ t: 'itemHit', id: oid, by: id, fx: 'inkStun', dur: 1, x: +ob.pos.x.toFixed(1), z: +ob.pos.z.toFixed(1) });
          // 本地副本立即生效：自己是受害者时真实生效，否则仅远程视觉
          ob.applyFx('inkStun', 1);
          if (oid === this.myId) {
            this.inkTimer = 5;
            this.onToast('🌑 被墨鱼喷了一脸墨汁！');
          }
        }
        if (hitAny) this.#noteHit(id);
        if (id === this.myId && !hitAny) this.onToast('🌑 没有可喷墨的对手');
        break;
      }
      case 'waterfall': {
        // 深海瀑布：复用怪物模式 BOSS 的“向上喷”水柱视觉，
        // 以自己为圆心 18 米内（不含自己）的对手被水柱冲上天空 3 秒。
        let hitCount = 0;
        for (const [oid, ob] of boats) {
          if (oid === id) continue;
          if (this.isTeammate(id, oid)) continue; // 组队：不冲队友
          if (ob.shieldTimer > 0) { this.#reportBlocked(oid, id, ob.pos.x, ob.pos.z); continue; }
          if (Math.hypot(ob.pos.x - boat.pos.x, ob.pos.z - boat.pos.z) > WATERFALL_RADIUS) continue;
          hitCount++;
          this.#spawnGeyser(ob.pos.x, ob.pos.z, 1);
          this.net.send({ t: 'itemHit', id: oid, by: id, fx: 'geyserLift', dur: WATERFALL_LIFT, x: +ob.pos.x.toFixed(1), z: +ob.pos.z.toFixed(1) });
          ob.applyFx('geyserLift', WATERFALL_LIFT);
          if (oid === this.myId) this.onToast(HIT_TOASTS.geyserLift);
        }
        // 自己脚下也喷一圈水柱（纯视觉，不升空）
        this.#spawnGeyser(boat.pos.x, boat.pos.z, 0.8);
        this.net.send({ t: 'itemUse', id, item, x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
        if (hitCount) this.#noteHit(id);
        if (id === this.myId && !hitCount) this.onToast('🌊 18米内没有对手，深海瀑布落空');
        break;
      }
      case 'slowboat': {
        // 减速艇：除自己外全部对手速度 ×0.5，持续 3.5 秒（头顶红色汗颜标记 + 脚下冰雾）
        let hitAny = false;
        for (const [oid, ob] of boats) {
          if (oid === id) continue;
          if (this.isTeammate(id, oid)) continue; // 组队：不减速队友
          if (ob.shieldTimer > 0) { this.#reportBlocked(oid, id, ob.pos.x, ob.pos.z); continue; }
          hitAny = true;
          ob.applyFx('halfSpeed', SLOWBOAT_DURATION);
          // 以前受害者端只有一个头顶小图标，被打的人常常“不知道为什么突然变慢”
          this.#playFx('fxIceMist', ob.pos.x, ob.pos.z, 0.6);
          this.net.send({ t: 'itemHit', id: oid, by: id, fx: 'halfSpeed', dur: SLOWBOAT_DURATION, x: +ob.pos.x.toFixed(1), z: +ob.pos.z.toFixed(1) });
          if (oid === this.myId) this.onToast(HIT_TOASTS.halfSpeed);
        }
        this.#playFx('fxIceMist', boat.pos.x, boat.pos.z, 1.0, boat.heading);
        this.net.send({ t: 'itemUse', id, item, x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
        if (hitAny) this.#noteHit(id);
        if (id === this.myId && !hitAny) this.onToast('🐢 场上没有其他玩家，减速艇落空');
        break;
      }
      case 'tide': {
        // 方向转换器(原潮汐换道器): 除了释放者自己外,其他玩家左右操控整体反转 5 秒,
        // 头顶显示小恶魔标志.目标在自己客户端才能反转自己的输入,所以采用逐目标广播。
        let hitAny = false;
        const dur = 5;
        for (const [oid, ob] of boats) {
          if (oid === id) continue; // 释放者免疫
          if (this.isTeammate(id, oid)) continue; // 组队：不反转队友操控
          if (ob.shieldTimer > 0) { this.#reportBlocked(oid, id, ob.pos.x, ob.pos.z); continue; } // 护盾免疫(已是既有统一规则)
          hitAny = true;
          ob.applyFx('reverse', dur);
          this.net.send({ t: 'itemFx', id: oid, fx: 'reverse', dur, by: id });
          this.#playFx('tide', ob.pos.x, ob.pos.z, 1.2); // 受害者位置的方向流特效
          this.#playFx('fxDark2', ob.pos.x, ob.pos.z, 0.5); // 紫色暗影爆刺
          if (oid === this.myId) this.onToast('😈 操控被反转了！');
        }
        if (hitAny) this.#noteHit(id);
        if (id === this.myId && !hitAny) this.onToast('😈 场上没有其他玩家，方向转换器落空');
        break;
      }
      case 'bubblefly': {
        // 泡泡蜻蜓：自动追名次比自己高一位的对手，命中后把它关进异世界 3 秒
        const target = this.#findChaseTarget(id);
        const launch = homingConfig('bubblefly').launch;
        const vx0 = Math.sin(boat.heading) * launch;
        const vz0 = Math.cos(boat.heading) * launch;
        const p = this.#addProjectile({
          type: 'bubblefly', owner: id, x: boat.pos.x, z: boat.pos.z,
          vx: vx0, vz: vz0, target, mesh: this.#makeBubbleFly(),
        });
        this.#playFx('fxMagicCircle', boat.pos.x, boat.pos.z, 1.0, boat.heading);
        this.net.send({ t: 'itemUse', id, item, x: boat.pos.x, z: boat.pos.z, vx: vx0, vz: vz0, target, life: +p.life.toFixed(2) });
        break;
      }
      case 'torpedo': {
        // 鱼雷齐射：正前方三发平行鱼雷，不锁定 —— 贴脸放必中，远放要靠预判。
        // 这是整套道具里唯一「需要瞄准」的攻击，也是唯一能被侧移躲开的攻击。
        const originX = boat.pos.x;
        const originZ = boat.pos.z;
        for (const off of [-TORPEDO_SPREAD, 0, TORPEDO_SPREAD]) {
          const a = boat.heading + off;
          const sx = Math.sin(a), sz = Math.cos(a);
          const px = originX + sx * 3.4;
          const pz = originZ + sz * 3.4;
          const vx = sx * TORPEDO_SPEED;
          const vz = sz * TORPEDO_SPEED;
          this.#addProjectile({
            type: 'torpedo', owner: id, x: px, z: pz,
            vx, vz, target: null, life: TORPEDO_LIFE, mesh: this.#makeTorpedo(),
          });
          this.net.send({
            t: 'itemUse', id, item, x: +px.toFixed(2), z: +pz.toFixed(2),
            vx: +vx.toFixed(2), vz: +vz.toFixed(2), target: null,
          });
        }
        // 出手层：船头一次炮口闪光（三发的视觉靠 3D 弹体本体，不再叠三份特效）；
        // 命中层才用 toonWater 水爆 —— 出手和命中不用同一颗素材，玩家才分得清
        this.#playFx('muzzleLight', originX + Math.sin(boat.heading) * 3, originZ + Math.cos(boat.heading) * 3, 0.9, boat.heading);
        if (id === this.myId) this.onToast('🐠 鱼雷齐射！对准正前方，别放太远');
        break;
      }
      case 'angel': {
        // 天使庇佑：3 秒无敌 + 清除负面效果 + 小加速。
        // 组队模式保护全队（含自己）；个人模式只有自己。
        boat.applyFx('angel', DEFENSE_DURATION);
        // Angel also clears manager-owned penalties (ink HUD and lightning
        // streaks), which are not stored on the Boat instance.
        this.strikeStreak.delete(id);
        if (id === this.myId) {
          this.inkTimer = 0;
          this.screenFlash = 0;
        }
        this.#fxShield(boat, id, DEFENSE_DURATION);
        for (const [oid, ob] of boats) {
          if (oid === id || !this.isTeammate(id, oid)) continue;
          ob.applyFx('angel', DEFENSE_DURATION);
          this.strikeStreak.delete(oid);
          this.#fxShield(ob, oid, DEFENSE_DURATION);
          // by 用于服务端统计「救援」：保护到队友才计数，给自己加不计
          this.net.send({ t: 'itemFx', id: oid, fx: 'angel', dur: DEFENSE_DURATION, by: id });
        }
        this.net.send({ t: 'itemFx', id, fx: 'angel', dur: DEFENSE_DURATION, by: id });
        break;
      }
      case 'fish': {
        // 飞鱼群：攻击所有领先于自己的对手（施放者权威判定）
        const myRank = this.getRank(id);
        let hitCount = 0;
        for (const [oid, ob] of boats) {
          if (oid === id) continue;
          if (this.isTeammate(id, oid)) continue; // 组队：飞鱼只咬对手
          if (ob.shieldTimer > 0) { this.#reportBlocked(oid, id, ob.pos.x, ob.pos.z); continue; }
          if (this.getRank(oid) >= myRank) continue; // 只打领先的
          hitCount++;
          // 飞鱼视觉：从施放者飞向目标
          this.#spawnFish(boat.pos.x, boat.pos.z, ob.pos.x, ob.pos.z);
          this.#playFx('itemBeam', boat.pos.x, boat.pos.z, 1.5, Math.atan2(ob.pos.x - boat.pos.x, ob.pos.z - boat.pos.z));
          this.#playFx('hit', ob.pos.x, ob.pos.z, 1.2);
          this.net.send({ t: 'itemHit', id: oid, by: id, fx: 'slow', dur: 1.6, x: +ob.pos.x.toFixed(1), z: +ob.pos.z.toFixed(1) });
          ob.applyFx('slow', 1.6);
          if (oid === this.myId) this.onToast('🐟 被飞鱼群袭击！');
        }
        if (hitCount) this.#noteHit(id);
        if (id === this.myId && !hitCount) this.onToast('🐟 没有领先于你的对手，飞鱼群落空');
        break;
      }
      case 'rvortex': {
        // 海洋之怒：漩涡缠住第一名（自己除外）。
        // 组队规则：第一名如果是队友 → 道具直接无效（照常消耗，不产生效果）。
        const firstAny = this.#findMissileTarget(id, true);
        if (firstAny && this.isTeammate(id, firstAny)) {
          if (id === this.myId) this.onToast('🌊 第一名是队友，海洋之怒无效');
          break;
        }
        const target = this.#findMissileTarget(id);
        if (target) {
          const tb = boats.get(target);
          if (tb && tb.shieldTimer <= 0) {
            this.#fxVortex(tb.pos.x, tb.pos.z, 2);
            this.#playFx('fxMagic1Water', tb.pos.x, tb.pos.z, 0.3); // 蓝色水环铺底
            this.#spawnBurst(tb.pos.x, tb.pos.z, 5);
            this.net.send({ t: 'itemHit', id: target, by: id, fx: 'spin', dur: 2, x: +tb.pos.x.toFixed(1), z: +tb.pos.z.toFixed(1) });
            if (target === this.myId) this.onToast('🌊 被海洋之怒缠住了！');
            tb.applyFx('spin', 2);
            this.#noteHit(id);
          } else if (id === this.myId) {
            this.onToast('🌊 目标护盾生效，海洋之怒被抵挡');
          }
        } else if (id === this.myId) {
          this.onToast('🌊 没有可攻击的目标，海洋之怒落空');
        }
        break;
      }

      // ---------- 2026-11-14 新增：落后反超 ----------
      case 'bloodlance': {
        // 血枪狙击：朝「当前第一名」方向直线打出去，**不追踪**（对手变向就能躲）。
        // 穿透沿途所有领先于自己的对手 —— 这是唯一射程超过 60m 的攻击。
        // 组队规则：第一名是队友 → 道具无效；沿途队友穿透无效果。
        const firstAny = this.#findMissileTarget(id, true);
        if (firstAny && this.isTeammate(id, firstAny)) {
          if (id === this.myId) this.onToast('🔱 第一名是队友，血枪无效');
          break;
        }
        const target = this.#findMissileTarget(id);
        const tb = target ? boats.get(target) : null;
        let vx, vz;
        let lanceLife = BLOOD_LANCE_LIFE;
        if (tb) {
          const dx0 = tb.pos.x - boat.pos.x, dz0 = tb.pos.z - boat.pos.z;
          const dist0 = Math.hypot(dx0, dz0) || 1;
          // 射程跟着"到第一名的距离"走：旧版固定 0.58s×110m/s ≈ 64m，
          // 落后 100m 以上打出去必然在目标前耗尽 —— 玩家看到的就是"血枪放了没反应"。
          // 上限 4.5s ≈ 495m，再远就不是这一发该解决的问题了。
          lanceLife = Math.max(BLOOD_LANCE_LIFE, Math.min(4.5, dist0 / BLOOD_LANCE_SPEED + 0.25));
          // 提前量：远距离下目标 2~3 秒能跑 60~90m，只朝"当前位置"打必空。
          // 仍然是不追踪的直线弹，目标变向照样能躲（设计口径不变）。
          let tt = Math.min(lanceLife, Math.max(0.1, dist0 / BLOOD_LANCE_SPEED));
          for (let k = 0; k < 2; k++) {
            const ax = tb.pos.x + (tb.vel?.x || 0) * tt - boat.pos.x;
            const az = tb.pos.z + (tb.vel?.y || 0) * tt - boat.pos.z;
            tt = Math.min(lanceLife, Math.hypot(ax, az) / BLOOD_LANCE_SPEED);
          }
          const ax = tb.pos.x + (tb.vel?.x || 0) * tt;
          const az = tb.pos.z + (tb.vel?.y || 0) * tt;
          const dx = ax - boat.pos.x, dz = az - boat.pos.z;
          const len = Math.hypot(dx, dz) || 1;
          vx = dx / len * BLOOD_LANCE_SPEED;
          vz = dz / len * BLOOD_LANCE_SPEED;
        } else {
          vx = Math.sin(boat.heading) * BLOOD_LANCE_SPEED;
          vz = Math.cos(boat.heading) * BLOOD_LANCE_SPEED;
        }
        this.#addProjectile({
          type: 'bloodlance', owner: id, x: boat.pos.x, z: boat.pos.z,
          vx, vz, target: null, life: lanceLife,
          pierce: true, hitSet: new Set(), onlyAhead: true,
          mesh: this.#makeBloodLance(),
        });
        this.#playFx('fxHarpoonFly', boat.pos.x, boat.pos.z, 1.0, Math.atan2(vx, vz));
        this.net.send({
          t: 'itemUse', id, item,
          x: +boat.pos.x.toFixed(2), z: +boat.pos.z.toFixed(2),
          vx: +vx.toFixed(2), vz: +vz.toFixed(2), target: null,
          life: +lanceLife.toFixed(2),
        });
        if (id === this.myId) this.onToast(tb ? '🔱 血枪锁定第一名，直线贯穿！' : '🔱 前方无人，血枪空放');
        break;
      }
      case 'holystorm': {
        // 圣光沙暴：直接落在「当前第一名」头上，不需要瞄准 —— 落后 200m 也够得着。
        // 组队规则：第一名是队友 → 道具无效；队友进区不受影响。
        const firstAny = this.#findMissileTarget(id, true);
        if (firstAny && this.isTeammate(id, firstAny)) {
          if (id === this.myId) this.onToast('🌪️ 第一名是队友，圣光沙暴无效');
          break;
        }
        const target = this.#findMissileTarget(id);
        const tb = target ? boats.get(target) : null;
        const cx = tb ? tb.pos.x : boat.pos.x;
        const cz = tb ? tb.pos.z : boat.pos.z;
        this.#spawnZone('holystorm', id, cx, cz, 0, 0, HOLY_STORM_R, HOLY_STORM_DUR);
        this.net.send({
          t: 'itemUse', id, item, x: +cx.toFixed(1), z: +cz.toFixed(1),
          r: HOLY_STORM_R, dur: HOLY_STORM_DUR,
        });
        if (id === this.myId) this.onToast(tb ? '🌪️ 圣光沙暴罩住了第一名！' : '🌪️ 场上没有对手，沙暴落空');
        break;
      }
      case 'gate': {
        // 逆流之门：瞬移到「前一名」身后 10 米。位移只改自己这条船（自己权威），
        // 另一端点位只用来补两端门框特效。组队模式下队友也可以作为传送锚点。
        //
        // 2026-11-22：两条硬口径（用户反馈）
        //   ① 自己已经是第一名 → 不需要换位置（旧逻辑会找"第 2 名"往身后传，等于自罚）；
        //   ② 落地后船头必须朝**正前方**（旧逻辑完全不动 heading，船头会保持传送前的朝向，
        //      经常是背对赛道，落地第一脚油门直接往回冲）。
        if (this.getRank(id) === 1) {
          if (id === this.myId) this.onToast('🚪 已是第一名，逆流之门无需位移');
          break;
        }
        const target = this.#findChaseTarget(id, true);
        const tb = target ? boats.get(target) : null;
        if (!tb) {
          if (id === this.myId) this.onToast('🚪 前方没有可追随的目标，逆流之门落空');
          break;
        }
        const sx = boat.pos.x, sz = boat.pos.z;
        // 落点沿**赛道中线**退到目标身后 10m：直接按目标航向往后偏会在弯道把船送进
        // 护栏/岸线，而且给不出正确的"正前方"。respawnPoint 返回的是中线上的点 + 切线朝向，
        // 近道内也走近道自己的折线（和 R 键复位同一套）。
        const rp = this.track?.respawnPoint?.(tb.pos, this.getGate(target), GATE_BACK_DIST);
        let bx, bz, bh;
        if (rp) {
          bx = rp.x; bz = rp.z; bh = rp.heading;
        } else {
          bx = tb.pos.x - Math.sin(tb.heading) * GATE_BACK_DIST;
          bz = tb.pos.z - Math.cos(tb.heading) * GATE_BACK_DIST;
          bh = tb.heading;
        }
        this.#playFx('fxGateOfCalve', sx, sz, 1.1);
        this.#playFx('fxGateOfCalve', bx, bz, 1.1);
        boat.pos.x = bx;
        boat.pos.z = bz;
        const sy = this.track?.surfaceYAt?.(bx, bz);
        if (Number.isFinite(sy)) boat.pos.y = sy;
        boat.prevPos?.copy?.(boat.pos);
        // 保留 60% 速度，但速度方向要跟着新车头 —— 否则上一帧的世界速度会把船
        // 侧着推出去（滑移角瞬间拉满，看起来像被弹了一下）。
        const keepK = 0.6;
        const keepSpeed = Math.max(0, boat.speed) * keepK;
        boat.heading = bh;
        boat.angVel = 0;
        boat.drifting = false;
        boat.driftAngle = 0;
        boat.driftPathYaw = 0;
        boat.driftDA = 0;
        boat.speed = keepSpeed;
        boat.vel.set(Math.sin(bh) * keepSpeed, Math.cos(bh) * keepSpeed);
        // 落点可能压到护栏/岸线：交给赛道约束把船推回走廊，避免瞬移穿墙卡死
        try { this.track?.constrain?.(boat); } catch { /* 无赛道的模式跳过 */ }
        this.net.send({
          t: 'itemUse', id, item, x: +sx.toFixed(1), z: +sz.toFixed(1),
          gx: +bx.toFixed(1), gz: +bz.toFixed(1), gh: +bh.toFixed(3),
        });
        if (id === this.myId) this.onToast('🚪 逆流之门：已贴到前一名身后！');
        break;
      }
      case 'bladestorm': {
        // 剑刃风暴：跟着自己转 3 秒，谁贴上来就被弹开 + 减速
        this.#spawnZone('bladestorm', id, boat.pos.x, boat.pos.z, 0, 0,
          BLADE_STORM_R, BLADE_STORM_DUR, true);
        this.net.send({
          t: 'itemUse', id, item, x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1),
          r: BLADE_STORM_R, dur: BLADE_STORM_DUR,
        });
        if (id === this.myId) this.onToast('⚔️ 剑刃风暴展开，别让别人贴上来');
        break;
      }

      // ---------- 2026-11-14 新增：领先防御 ----------
      case 'sanctuary': {
        // 圣域：落在自己身后 12 米，追上来的人会被减速 + 推开
        const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
        const cx = boat.pos.x - fx * 12;
        const cz = boat.pos.z - fz * 12;
        this.#spawnZone('sanctuary', id, cx, cz, 0, 0, SANCTUARY_R, SANCTUARY_DUR);
        this.net.send({
          t: 'itemUse', id, item, x: +cx.toFixed(1), z: +cz.toFixed(1),
          r: SANCTUARY_R, dur: SANCTUARY_DUR,
        });
        if (id === this.myId) this.onToast('✨ 圣域已布在身后');
        break;
      }
      case 'barrier': {
        // 护盾墙：身后 8 米立一道横向墙，所有来袭弹撞墙即灭
        const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
        const cx = boat.pos.x - fx * 8;
        const cz = boat.pos.z - fz * 8;
        // 墙沿右舷方向展开（与航向垂直）
        const hx = fz, hz = -fx;
        this.#spawnZone('barrier', id, cx, cz, hx, hz, BARRIER_HALF_W, BARRIER_DUR);
        this.net.send({
          t: 'itemUse', id, item, x: +cx.toFixed(1), z: +cz.toFixed(1),
          hx: +hx.toFixed(3), hz: +hz.toFixed(3), r: BARRIER_HALF_W, dur: BARRIER_DUR,
        });
        if (id === this.myId) this.onToast('🧱 护盾墙立起，追踪弹会被挡下');
        break;
      }
    }
  }

  /**
   * 找名次恰好在自己前一位的目标（炸弹/导弹/章鱼/泡泡蜻蜓）。
   * 组队赛制默认只选对手：前一名是队友时改选「最接近自己的领先对手」；
   * 自己第一或前方没有对手时，改选排名最高的对手。
   * includeMate = true 时允许队友（逆流之门用）。
   */
  #findChaseTarget(excludeId, includeMate = false) {
    const boats = this.getBoats();
    const myRank = this.getRank(excludeId);
    const ok = (id) => id !== excludeId && (includeMate || !this.isTeammate(excludeId, id));
    const wanted = myRank > 1 ? myRank - 1 : myRank + 1;
    for (const [bid] of boats) {
      if (ok(bid) && this.getRank(bid) === wanted) return bid;
    }
    // 恰好前一名是队友 / 不存在：往前找名次最接近的对手
    let ahead = null, aheadRank = Infinity;
    for (const [bid] of boats) {
      if (!ok(bid)) continue;
      const r = this.getRank(bid);
      if (r < myRank && r < aheadRank) { aheadRank = r; ahead = bid; }
    }
    if (ahead) return ahead;
    // 自己第一 / 前方无对手：取排名最高的可选目标
    let best = null, bestRank = Infinity;
    for (const [bid] of boats) {
      if (!ok(bid)) continue;
      const r = this.getRank(bid);
      if (r < bestRank) { bestRank = r; best = bid; }
    }
    return best;
  }

  /** 找最近的领先于自己的目标（磁铁）；includeMate = true 时可以吸队友 */
  #findMagnetTarget(excludeId, aimed = true, includeMate = false) {
    const boats = this.getBoats();
    const me = boats.get(excludeId);
    let best = null, bestScore = Infinity;
    for (const [id, b] of boats) {
      if (id === excludeId) continue;
      if (!includeMate && this.isTeammate(excludeId, id)) continue;
      const dx = b.pos.x - (me ? me.pos.x : 0);
      const dz = b.pos.z - (me ? me.pos.z : 0);
      const d = Math.hypot(dx, dz);
      if (aimed) {
        if (!me || d > 120) continue;
        const fx = Math.sin(me.heading), fz = Math.cos(me.heading);
        const dot = (dx * fx + dz * fz) / Math.max(d, 0.001);
        // Wide forward visual cone: target any boat the player can reasonably see.
        if (dot < Math.cos(Math.PI * 0.42)) continue;
        const angle = Math.acos(THREE.MathUtils.clamp(dot, -1, 1));
        const score = angle * 8 + d * 0.015;
        if (score < bestScore) { bestScore = score; best = id; }
      } else if (d < bestScore) {
        bestScore = d;
        best = id;
      }
    }
    return best;
  }

  /** 飞鱼视觉：一条小鱼从施放者抛向目标 */
  #spawnFish(x0, z0, x1, z1) {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x6ac8ff, emissive: 0x1a4a7a, roughness: 0.4, flatShading: true });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.8, 6), mat);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 4), mat);
    tail.rotation.x = -Math.PI / 2;
    tail.position.z = -1.2;
    g.add(tail);
    this.scene.add(g);
    this.fishes = this.fishes || [];
    this.fishes.push({
      mesh: g, x: x0, z: z0,
      vx: (x1 - x0) / 0.7, vz: (z1 - z0) / 0.7,
      life: 0.7,
    });
  }

  #updateFishes(dt) {
    if (!this.fishes) return;
    for (let i = this.fishes.length - 1; i >= 0; i--) {
      const f = this.fishes[i];
      f.life -= dt;
      f.x += f.vx * dt;
      f.z += f.vz * dt;
      f.mesh.position.set(f.x, 1.6 + Math.sin(f.life * 20) * 0.5, f.z);
      f.mesh.rotation.y = Math.atan2(f.vx, f.vz);
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        f.mesh.traverse?.((o) => { if (o.isMesh) o.geometry.dispose(); });
        this.fishes.splice(i, 1);
      }
    }
  }

  /** 找第一名（自己除外）；组队默认只找对手，includeMate = true 时连队友一起看 */
  #findMissileTarget(excludeId, includeMate = false) {
    const boats = this.getBoats();
    let best = null, bestRank = Infinity;
    for (const [id] of boats) {
      if (id === excludeId) continue;
      if (!includeMate && this.isTeammate(excludeId, id)) continue;
      const r = this.getRank(id);
      if (r < bestRank) { bestRank = r; best = id; }
    }
    return best;
  }

  // ---------- 网络同步 ----------
  /**
   * 联机对手/队友当前手上的道具 id（最多 3 件）。
   * 优先级：本机真实道具栏 > 主机代模拟的 AI > 网络同步来的列表。
   */
  #heldIds(id) {
    if (id === this.myId) return this.myItems.filter(Boolean);
    const ai = this.aiItems.get(id);
    if (ai) return ai.items.slice(0, 3);
    return this.remoteItems.get(id) || [];
  }

  /** HUD 名次栏用：返回道具定义对象（含 name / icon），空槽不占位 */
  getHeldItems(id) {
    return this.#heldIds(id).map((it) => ITEM_DEFS[it]).filter(Boolean);
  }

  /**
   * 广播某人当前手上的完整道具列表。
   * 覆盖式而不是增量：道具使用分散在 7 处发 itemUse，还有几处根本不发，
   * 靠消息加减推算会出现"图标留在名次栏上"的幽灵道具。
   * 单人模式 net 是空壳，直接跳过。
   */
  syncHeld(id) {
    if (this.solo || !this.net) return;
    this.net.send({ t: 'itemHeld', by: id, items: this.#heldIds(id).slice(0, 3) });
  }

  handleNet(msg) {
    if (msg.t === 'itemHeld') {
      // 整份替换：这样既能补上漏掉的拾取，也能自动清掉已用掉的道具
      if (msg.by !== this.myId) {
        this.remoteItems.set(msg.by, Array.isArray(msg.items) ? msg.items.slice(0, 3) : []);
      }
      return;
    }
    if (msg.t === 'itemPick') {
      const b = this.boxes[msg.boxIdx];
      if (b && b.active && msg.by !== this.myId) {
        // 外观由 #updateBoxes 每帧根据 active 状态重排，无需单独隐藏 mesh
        b.active = false; b.respawn = this.boxRespawn;
      }
    } else if (msg.t === 'itemUse') {
      // 其他玩家施放道具 → 本地生成同样的实体
      if (msg.id === this.myId) return;
      // 听觉防守的关键：在视觉实体生成之前先给一声带方向的"来袭"提示。
      // 弹道类随后 #addProjectile 还会调一次，500ms 去重保证只响一声。
      this.#maybeWarn(msg.item, msg.id, msg.x, msg.z, msg.vx, msg.vz, msg.target);
      if (msg.item === 'bomb' || msg.item === 'missile' || msg.item === 'torpedo') {
        const heading = Math.atan2(msg.vx || 0, msg.vz || 1);
        this.#addProjectile({
          type: msg.item, owner: msg.id, x: msg.x, z: msg.z,
          vx: msg.vx, vz: msg.vz, target: msg.target,
          // 鱼雷没有 homingConfig，life 只能靠消息带；万一对面是老版本没带这个字段，
          // 这里必须兜一个默认值 —— 否则 p.life -= dt 得到 NaN，幽灵弹永远不销毁。
          life: Number.isFinite(msg.life) ? msg.life
            : (msg.item === 'torpedo' ? TORPEDO_LIFE : null),
          mesh: msg.item === 'bomb' ? this.#makeBomb()
            : msg.item === 'missile' ? this.#makeMissile()
              : this.#makeTorpedo(),
          // 远程副本一律 ghost：命中结算只在施放者端，副本碰到目标就消散。
          // 以前炸弹/导弹漏了这个标记，会一直飞到 life 结束才消失。
          ghost: true,
        });
        if (msg.item === 'missile') this.#playFx('missile', msg.x, msg.z, 1.4, heading);
        if (msg.item === 'torpedo') this.#playFx('muzzleLight', msg.x, msg.z, 0.9, heading);
      } else if (msg.item === 'octopus' || msg.item === 'bubblefly') {
        // 追踪型弹道：接收端只复制飞行视觉，命中结算在施放者端（ghost 弹道不结算）
        this.#addProjectile({
          type: msg.item, owner: msg.id, x: msg.x, z: msg.z,
          vx: msg.vx, vz: msg.vz, target: msg.target,
          // 寿命跟施放者一致，否则远距离时这边的视觉副本先消失、真正命中却"看不见弹"
          life: Number.isFinite(msg.life) ? msg.life : null,
          mesh: msg.item === 'octopus' ? this.#makeOctopus() : this.#makeBubbleFly(),
          ghost: true,
        });
        if (msg.item === 'octopus') this.#playFx('fxMagicDark', msg.x, msg.z, 1.1);
        else this.#playFx('fxMagicCircle', msg.x, msg.z, 1.0);
      } else if (msg.item === 'waterfall') {
        // 深海瀑布：水柱视觉在本端复现，升空由逐目标 itemHit 结算
        this.#spawnGeyser(msg.x, msg.z, 0.8);
      } else if (msg.item === 'vortex') {
        // 漩涡水弹: 接收端仅复制视觉(AoE 命中只在施放者端判)
        this.#spawnBubbleBomb(msg.id, msg.x, msg.z);
        this.#playFx('bubble', msg.x, msg.z, 1.4);
      } else if (msg.item === 'bloodlance') {
        // 血枪：远端只飞一条不结算的副本（命中由施放者端发 itemHit），
        // ghost + pierce 刻意不在撞到人时消散 —— 否则贯穿弹看起来只打了一个人。
        this.#addProjectile({
          type: 'bloodlance', owner: msg.id, x: msg.x, z: msg.z,
          vx: msg.vx, vz: msg.vz, target: null,
          life: Number.isFinite(msg.life) ? msg.life : BLOOD_LANCE_LIFE,
          pierce: true, hitSet: new Set(), ghost: true,
          mesh: this.#makeBloodLance(),
        });
        this.#playFx('fxHarpoonFly', msg.x, msg.z, 1.0, Math.atan2(msg.vx || 0, msg.vz || 1));
      } else if (ZONE_KINDS.includes(msg.item)) {
        // 区域型：位置/半径/时长各端自己存一份，效果由各端判给自己的船
        this.#spawnZone(
          msg.item, msg.id, msg.x, msg.z,
          msg.hx || 0, msg.hz || 0,
          msg.r || 6, msg.dur || 3,
          msg.item === 'bladestorm',
        );
      } else if (msg.item === 'gate') {
        // 逆流之门：两端各补一个门框，位移本身由施放者自己完成
        this.#playFx('fxGateOfCalve', msg.x, msg.z, 1.1);
        this.#playFx('fxGateOfCalve', msg.gx ?? msg.x, msg.gz ?? msg.z, 1.1);
      }
      // nitro/shield 由 itemFx / state 同步
    } else if (msg.t === 'itemFx') {
      const boat = this.getBoats().get(msg.id);

      // 护盾拦截：施放者端原本根本不发消息，所以 shield_break 这条音效永远播不到。
      // 现在拦截时补发这条消息，被挡下的人能听到"铛"并看到提示。
      if (msg.fx === 'blocked') {
        if (msg.id === this.myId) {
          const at = this.#sfxAt(msg.x, msg.z);
          audio.play('item_blocked', { gap: 300, pan: at.pan, vol: at.vol });
          if (performance.now() - (this._lastBlockToast || 0) > 300) {
            this.onToast('🛡️ 护盾抵挡了攻击！');
          }
        }
        return;
      }

      // 「方向转换器」必须在 myId 早退前处理:被反转的受害者就是自己,
      // 跳过 myId 早退会导致自己永远收不到反转,操控永远不会反向。
      if (msg.fx === 'reverse') {
        if (boat) boat.applyFx('reverse', msg.dur || 5);
        if (msg.id === this.myId) audio.play('reverse_tide');
        return;
      }

      if (boat) {
        if (msg.fx === 'angel') {
          // Keep manager-owned penalties in sync for Angel recipients.
          this.strikeStreak.delete(msg.id);
          if (msg.id === this.myId) {
            this.inkTimer = 0;
            this.screenFlash = 0;
          }
        }
        if (msg.id === this.myId) return;
        if (msg.fx === 'magnet') {
          if (!msg.target) {
            boat.magnetTimer = 0;
            boat.magnetTarget = null;
            return;
          }
          boat.magnetTimer = msg.dur || 2.5;
          boat.magnetTarget = msg.target || null;
          this.#fxMagnet(boat, msg.target, msg.dur || 2.5);
        } else {
          boat.applyFx(msg.fx, msg.dur);
        }
        if (msg.fx === 'shield' || msg.fx === 'angel') {
          this.#fxShield(boat, msg.id, msg.dur || DEFENSE_DURATION);
        }
      }
    } else if (msg.t === 'itemHit') {
      // 施放者权威判定：受击方本地应用
      if (msg.fx === 'geyserLift') this.#spawnGeyser(msg.x, msg.z, 1);
      // 章鱼怪缠身的触手各端都看得见（施放者那端由弹道本体衔接）
      if (msg.fx === 'octoGrab') this.#attachOctopus(this.getBoats().get(msg.id), this.#makeOctopus());
      this.#spawnBurst(msg.x, msg.z, 6);
      // 每次命中只放「一层」Effekseer：按道具类型挑，别一律套同一个 hit 环，
      // 玩家才会一眼分辨是被炸弹、导弹、鱼雷还是减速艇打中的。
      const hitVisual = msg.fx === 'sink' ? 'explosion'
        : msg.fx === 'halfSpeed' ? 'fxIceMist'
          : msg.fx === 'capsize' ? 'toonWater'
            : msg.fx === 'octoGrab' ? 'fxMagicDark'
              : 'hit';
      if (hitVisual) this.#playFx(hitVisual, msg.x, msg.z, 1);
      if (msg.id === this.myId) {
        const me = this.getBoats().get(this.myId);
        // 声音方向指向"打我的人"，不是命中点（命中点就在自己身边，算了没有方向感）
        const attacker = this.getBoats()?.get(msg.by);
        const at = this.#sfxAt(attacker?.pos.x ?? msg.x, attacker?.pos.z ?? msg.z);
        if (me && me.shieldTimer > 0) {
          audio.play('shield_break', { gap: 0, pan: at.pan, vol: at.vol });
          this.onToast('🛡️ 护盾抵挡了攻击！');
        } else if (me) {
          me.applyFx(msg.fx, msg.dur);
          // 受击音：以前只覆盖 4 种 fx，其余 9 种（墨汁/漩涡/瀑布/飞鱼/血枪…）
          // 打中你时是完全静音的。现在查表 + 通用 hit 兜底，保证任何命中都有声音。
          const sfx = HIT_SFX[msg.fx] || 'hit';
          audio.play(sfx, {
            gap: sfx === 'boat_collide' ? 200 : 0,
            pan: at.pan,
            vol: at.vol,
          });
          if (msg.fx === 'ink' || msg.fx === 'inkStun') {
            this.inkTimer = Math.max(this.inkTimer, msg.fx === 'inkStun' ? 5 : (msg.dur || 3));
          }
          if (msg.fx === 'void') {
            this.voidTimer = msg.dur || VOID_DURATION;
            this.voidLen = this.voidTimer;
          }
          this.onToast(HIT_TOASTS[msg.fx] || '💥 受到攻击！');
          // 失败归因图标（HUD 中央偏下闪一下）：护盾拦下不走这里，
          // 「挡住了」本来就不是失败，报个受击图标只会误导。
          this.opts.onMyHit?.(msg);
          if (msg.fx === 'sink') this.screenFlash = Math.max(this.screenFlash, 0.5);
          if (msg.fx === 'missileHit') this.screenFlash = Math.max(this.screenFlash, 0.45);
          if (msg.fx === 'capsize') this.screenFlash = Math.max(this.screenFlash, 0.4);
        }
      } else {
        const boat = this.getBoats().get(msg.id);
        if (boat) boat.applyFx(msg.fx, msg.dur);
      }
    } else if (msg.t === 'lightning') {
      // 兼容旧服务端：老包只有 strikeAt（发送端的绝对时间，跨端不同源，不可用）
      const delay = msg.delay != null ? msg.delay : 2;
      this.#addWarning(msg.x, msg.z, delay);
    }
  }

  // ---------- 闪电（暴风雨）----------
  #scheduleLightning(dt) {
    this.lightningTimer -= dt;
    if (this.lightningTimer > 0) return;
    this.lightningTimer = 5 + Math.random() * 5;

    // 随机挑一艘艇，在其前方 15~35 米落雷（不能太远，否则无意义）
    const boats = [...this.getBoats().values()];
    if (!boats.length) return;
    const boat = boats[Math.floor(Math.random() * boats.length)];
    const dist = 15 + Math.random() * 20;
    const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
    const x = boat.pos.x + fx * dist;
    const z = boat.pos.z + fz * dist;
    const delay = 2; // 2 秒预警
    this.#addWarning(x, z, delay);
    // 只发「还剩几秒」，不发绝对时间戳。
    // 以前发 strikeAt = 本地 elapsed + 2，而 elapsed 是每个客户端自己的比赛计时，
    // 两端根本不同源 —— 客机要么立刻落雷、要么预警圈永远不消失。
    this.net.send({ t: 'lightning', x: +x.toFixed(1), z: +z.toFixed(1), delay });
  }

  #addWarning(x, z, delay = 2) {
    const geo = new THREE.RingGeometry(3, 5.5, 32);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe37a, transparent: true, opacity: 0.8,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    this.scene.add(mesh);
    this.warnings.push({ x, z, left: delay, dur: Math.max(0.2, delay), mesh });
    // 落雷原来只有地上的光环、没有任何声音：躲避全靠低头看地面。
    // 现在 2 秒预警同时响一声，方向和音量按落点算。
    const at = this.#sfxAt(x, z, 280);
    audio.play('incoming_alert', { gap: 0, pan: at.pan, vol: at.vol * 0.85 });
  }

  #makeBolt(x, z) {
    audio.play('storm_thunder', { gap: 180 });
    this.screenFlash = Math.max(this.screenFlash, 0.85);
    // 落雷本体换成怪物模式同款 Effekseer 竖雷（ef_lightning02），
    // 以前是程序化画的一条锯齿 Line，又细又平，跟 BOSS 关的雷完全不像同一个游戏。
    // 注意：fx 是异步加载的，刚进图时可能还没就绪 → play 返回 null，这时要退回程序化闪电。
    if (this.fx && this.fx.play('fxArcBolt', x, 6, z, 3.0)) return;
    // Effekseer 未加载时的兜底：程序化锯齿闪电束
    const pts = [];
    let px = x, pz = z;
    const H = 90;
    const seg = 10;
    for (let i = 0; i <= seg; i++) {
      const y = (i / seg) * H;
      pts.push(px, y, pz);
      px = x + (Math.random() - 0.5) * 7 * (1 - i / seg);
      pz = z + (Math.random() - 0.5) * 7 * (1 - i / seg);
      pts.push(px, y, pz);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xcfe8ff, transparent: true, opacity: 1, depthWrite: false,
    });
    const mesh = new THREE.Line(geo, mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.bolts.push({ mesh, life: 0.45 });
  }

  #updateLightning(dt, t) {
    for (let i = this.warnings.length - 1; i >= 0; i--) {
      const w = this.warnings[i];
      w.left -= dt;
      if (w.left <= 0) {
        // 落雷！
        this.#makeBolt(w.x, w.z);
        this.#spawnBurst(w.x, w.z, 8);
        this.#applyLightningHit(w.x, w.z);
        this.scene.remove(w.mesh);
        w.mesh.geometry.dispose();
        w.mesh.material.dispose();
        this.warnings.splice(i, 1);
      } else {
        // 预警动画：脉冲光环收缩 + 亮度提升（用剩余比例，和时钟无关）
        const urgency = 1 - Math.min(1, w.left / w.dur); // 0→1
        w.mesh.position.set(w.x, this.groundAt(w.x, w.z, t) + 0.3, w.z);
        const s = 1.6 - urgency * 0.9 + Math.sin(t * 18) * 0.12 * urgency;
        w.mesh.scale.setScalar(Math.max(0.4, s));
        w.mesh.material.opacity = 0.35 + urgency * 0.55 + Math.sin(t * 18) * 0.15 * urgency;
      }
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.life -= dt;
      b.mesh.material.opacity = Math.max(0, b.life / 0.45);
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        b.mesh.material.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  #applyLightningHit(x, z) {
    // 每个客户端只对自己权威的艇应用（本地艇 + 主机的 AI）
    const R = 6;
    for (const [id, boat] of this.getBoats()) {
      const mine = id === this.myId || (this.isHost && this.aiItems !== undefined && boat !== this.getBoats().get(this.myId) && id.startsWith('ai'));
      if (!mine) continue;
      const d = Math.hypot(boat.pos.x - x, boat.pos.z - z);
      if (d > R) {
        this.strikeStreak.set(id, 0);
        continue;
      }
      if (boat.shieldTimer > 0) {
        if (id === this.myId) this.onToast('🛡️ 护盾抵挡了闪电！');
        continue;
      }
      const streak = (this.strikeStreak.get(id) || 0) + 1;
      this.strikeStreak.set(id, streak);
      if (streak >= 3) {
        boat.applyFx('sink', 2);
        this.strikeStreak.set(id, 0);
        if (id === this.myId) this.onToast('⚡ 连续被闪电击中，沉入海底！');
      } else {
        boat.applyFx('slow', 1);
        if (id === this.myId) this.onToast(`⚡ 被闪电击中！(${streak}/3)`);
      }
    }
  }

  // ---------- 实体 ----------
  #makeBomb() {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x2c3644, emissive: 0x101820, roughness: 0.5, metalness: 0.6 }),
    );
    this.scene.add(m);
    return m;
  }

  #makeMissile() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 1.6, 10),
      new THREE.MeshStandardMaterial({ color: 0xd8503a, emissive: 0x551208, roughness: 0.4 }),
    );
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getBurstTex(), transparent: true, opacity: 0.9, depthWrite: false,
    }));
    flame.scale.setScalar(1.6);
    flame.position.z = -1.1;
    g.add(flame);
    this.scene.add(g);
    return g;
  }

  /**
   * 鱼雷：细长雷体 + 十字尾翼 + 尾流泡泡。
   * 三个一起飞，所以刻意做小（0.2m 半径），靠亮银色反光在小尺寸下也能看清。
   */
  #makeTorpedo() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xe6f1fa, metalness: 0.6, roughness: 0.3,
      emissive: 0x1d5470, emissiveIntensity: 0.65,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.4, 10), bodyMat);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 10), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = 0.95;
    g.add(nose);
    const finMat = new THREE.MeshStandardMaterial({ color: 0x7ad0f0, emissive: 0x1b5a78, roughness: 0.5 });
    for (let i = 0; i < 4; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.06, 0.34), finMat);
      fin.position.z = -0.6;
      fin.rotation.z = (i / 4) * Math.PI * 2;
      g.add(fin);
    }
    const trail = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getBurstTex(), transparent: true, opacity: 0.5, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    trail.scale.setScalar(1.05);
    trail.position.z = -1.0;
    g.add(trail);
    this.scene.add(g);
    return g;
  }

  /** 血枪狙击的飞行体：一根红色穿刺长枪（沿 +Z 朝前） */
  #makeBloodLance() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff3355, transparent: true, opacity: 0.92,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 4.2, 6), mat);
    shaft.rotation.x = Math.PI / 2;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.5, 8), mat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 2.85;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getBurstTex(), color: 0xff5a6a, transparent: true, opacity: 0.55,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    halo.scale.setScalar(2.4);
    halo.position.z = 1.2;
    g.add(shaft, tip, halo);
    this.scene.add(g);
    return g;
  }

  #makeOctopus() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9a5ce0, emissive: 0x2a0a4a, roughness: 0.35 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 10), bodyMat);
    body.scale.y = 0.7;
    g.add(body);
    for (const [ex, ez] of [[-0.4, 0.5], [0.4, 0.5]]) {
      const eye = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      eye.position.set(ex, 0.35, ez);
      g.add(eye);
      const pupil = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0x101010 }),
      );
      pupil.position.set(ex, 0.35, ez + 0.15);
      g.add(pupil);
    }
    // 8 条触手：缠住艇身时靠它们摆动
    const tentMat = new THREE.MeshStandardMaterial({ color: 0x7a3fc0, emissive: 0x2a0a4a, roughness: 0.45 });
    const tentGeo = new THREE.CylinderGeometry(0.09, 0.2, 1.7, 6);
    const tentacles = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const ten = new THREE.Mesh(tentGeo, tentMat);
      ten.position.set(Math.cos(a) * 0.75, -0.85, Math.sin(a) * 0.75);
      ten.rotation.z = Math.cos(a) * 0.55;
      ten.rotation.x = Math.sin(a) * 0.55;
      g.add(ten);
      tentacles.push({ mesh: ten, a });
    }
    g.userData = { tentacles };
    this.scene.add(g);
    return g;
  }

  /** 章鱼命中后缠在艇身上，2 秒后松手沉海 */
  #attachOctopus(boat, mesh) {
    if (!boat || !mesh) return;
    mesh.position.set(0, 1.25, 0);
    mesh.rotation.set(0, 0, 0);
    boat.group.add(mesh);
    this.octoGrabs.push({ mesh, life: OCTOPUS_GRAB });
  }

  #updateOctoGrabs(dt, t) {
    for (let i = this.octoGrabs.length - 1; i >= 0; i--) {
      const grab = this.octoGrabs[i];
      grab.life -= dt;
      const tentacles = grab.mesh.userData?.tentacles || [];
      for (const ten of tentacles) {
        ten.mesh.rotation.z = Math.cos(ten.a) * 0.55 + Math.sin(t * 7 + ten.a) * 0.35;
        ten.mesh.rotation.x = Math.sin(ten.a) * 0.55 + Math.cos(t * 6 + ten.a) * 0.3;
      }
      if (grab.life <= 0) {
        // 松手：沉回海里（沿艇身往下掉再移除）
        grab.mesh.position.y -= dt * 3.2;
        grab.mesh.rotation.z += dt * 1.6;
        if (grab.mesh.position.y < -2.4) {
          grab.mesh.parent?.remove(grab.mesh);
          grab.mesh.traverse?.((o) => {
            if (o.isMesh) { o.geometry.dispose(); o.material.dispose?.(); }
          });
          this.octoGrabs.splice(i, 1);
        }
      }
    }
  }

  // 「漩涡」巨型水弹：玩家释放后,在正前方 100 米处从水面浮起并胀大,
  // 0.45 秒后炸开(只在施放者端 AoE 判 + 广播 itemHit),范围内所有人升空 3 秒,
  // 3 秒后下坠回赛道, 速度归零重新加速.
  #makeBubbleBomb() {
    // 肥皂泡质感由 bubbleMaterial 提供(菲涅尔轮廓 + 薄膜彩虹 + 一点镜面高光),
    // 主壳 + 内层薄膜 + 一圈伴生小水泡三层叠加, 才有真实水泡的厚度和颤动。
    const g = new THREE.Group();
    const shellMat = makeBubbleMaterial({ tint: 0x8fe6ff, opacity: 0.92, rim: 1.25, phase: 0 });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(4.6, 48, 32), shellMat);
    g.add(shell);

    // 内层薄膜:略小一号 + 相位错开, 转动时两层彩虹错位, 读出「膜在流动」
    const innerMat = makeBubbleMaterial({ tint: 0xc9f6ff, opacity: 0.55, rim: 0.85, phase: 1.7 });
    const inner = new THREE.Mesh(new THREE.SphereGeometry(3.7, 32, 24), innerMat);
    g.add(inner);

    // 伴生小水泡:贴在外壳附近缓慢自转, 让轮廓不是死板的正圆
    const bubbles = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = 0.42 + (i % 4) * 0.26;
      const mat = makeBubbleMaterial({ tint: 0xbdf2ff, opacity: 0.75, rim: 1.1, phase: i * 0.9 });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), mat);
      const band = (i % 3 - 1) * 1.5;
      mesh.position.set(Math.cos(a) * 4.5, band, Math.sin(a) * 4.5);
      g.add(mesh);
      bubbles.push({ mesh, mat, a, band, drift: 0.16 + (i % 3) * 0.07 });
    }

    // 中心辉光:加色混合的软球, 给水弹体积感(不随层缩放而消失)
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x7fe4ff, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(2.1, 20, 14), glowMat);
    g.add(glow);

    g.userData = {
      shell, inner, glow, bubbles,
      mats: [shellMat, innerMat, glowMat, ...bubbles.map((b) => b.mat)],
    };
    this.scene.add(g);
    return g;
  }

  /**
   * 生成一颗水弹(owner 端使用), 或纯视觉复制(其他客户端)。
   * - owner 端: 用此方法并附加额外字段 {owner: id, authentic: true} 用于 AoE 判定。
   * - 接收端: 直接传 owner=x z 即可, 不会做 AoE。
   */
  #spawnBubbleBomb(owner, x, z) {
    const mesh = this.#makeBubbleBomb();
    this.bubbleBombs.push({
      mesh, owner, x, z,
      life: BUBBLE_BOMB_FUSE + 0.55,    // 引信 + 炸开残余动画时长
      fuse: BUBBLE_BOMB_FUSE,           // 剩余引信时长
      popDone: false,                   // 炸开是否已触发(防止多次结算)
      authentic: owner === this.myId    // owner client 判定;非 owner 端只做视觉
        || (this.isHost && owner.startsWith?.('ai')),
    });
  }

  #updateBubbleBombs(dt, t) {
    for (let i = this.bubbleBombs.length - 1; i >= 0; i--) {
      const b = this.bubbleBombs[i];
      const ud = b.mesh.userData;
      b.life -= dt;
      b.fuse -= dt;

      // 薄膜相位统一推进, 彩虹会缓慢游走
      for (const m of ud.mats) if (m.uniforms) m.uniforms.uTime.value = t;

      // 伴生小水泡绕壳公转 + 上下浮动
      for (const s of ud.bubbles) {
        s.a += s.drift * dt;
        s.mesh.position.set(Math.cos(s.a) * 4.5, s.band + Math.sin(t * 1.7 + s.a * 2) * 0.35, Math.sin(s.a) * 4.5);
        s.mesh.scale.setScalar(1 + Math.sin(t * 3.1 + s.a * 3) * 0.12);
      }

      // 引信阶段:从水底升起并胀大, 辉光随涨大变亮
      if (b.fuse > 0) {
        const k = 1 - b.fuse / BUBBLE_BOMB_FUSE;    // 0→1
        const scale = 0.30 + k * 0.70;              // 0.30 → 1.00
        b.mesh.scale.setScalar(scale);
        b.mesh.position.y = this.groundAt(b.x, b.z, t) + 0.4 - (1 - k) * 3.2;
        const flicker = 0.18 + k * 0.16 + Math.sin(t * 22) * 0.03;
        ud.glow.material.opacity = flicker;
      } else if (!b.popDone) {
        // 炸开瞬间: 强闪 + 水柱 + 冲击环
        b.mesh.scale.setScalar(1.18);
        ud.glow.material.opacity = 0.85;
        this.#spawnBurst(b.x, b.z, 8);
        this.#spawnWaterCrown(b.x, b.z, t);
        this.#playFx('bubblePop', b.x, b.z, 1);
        this.#playFx('hit', b.x, b.z, 1);

        // 仅施放者权威端做 AoE 判定, 命中后逐目标广播 itemHit
        // (受击方的实际姿态变化 + 水泡包裹视觉 在各自 boat.applyFx('bubbleLift') 落地)
        if (b.authentic) {
          const boats = this.getBoats();
          for (const [oid, ob] of boats) {
            if (oid === b.owner) continue;        // 施放者免疫
            if (ob.shieldTimer > 0) { this.#reportBlocked(oid, b.owner, ob.pos.x, ob.pos.z); continue; }     // 护盾免疫
            const d = Math.hypot(ob.pos.x - b.x, ob.pos.z - b.z);
            if (d > BUBBLE_BOMB_RADIUS) continue;
            ob.applyFx('bubbleLift', BUBBLE_BOMB_LIFT);
            this.net.send({
              t: 'itemHit', id: oid, by: b.owner, fx: 'bubbleLift', dur: BUBBLE_BOMB_LIFT,
              x: +b.x.toFixed(1), z: +b.z.toFixed(1),
            });
            if (oid === this.myId) this.onToast('🫧 被巨型水泡卷到空中！');
          }
        }
        b.popDone = true;
      } else {
        // 炸开后残余动画:快速膨胀消散(像爆开的泡泡), 辉光先亮后灭
        const k = 1 - b.life / 0.55;     // 0→1
        b.mesh.scale.setScalar(1.18 + k * 0.85);
        const fade = Math.max(0, 1 - k);
        ud.shell.material.uniforms.uOpacity.value = 0.92 * fade;
        ud.inner.material.uniforms.uOpacity.value = 0.55 * fade;
        ud.glow.material.opacity = 0.85 * fade * fade;
      }

      // 水弹 Y 始终贴水(水面落差已用 waveHeight 吸收)
      if (b.fuse > 0) {
        b.mesh.position.x = b.x;
        b.mesh.position.z = b.z;
      } else {
        b.mesh.position.set(b.x, this.groundAt(b.x, b.z, t) + 0.6, b.z);
      }
      b.mesh.rotation.y = t * 1.2;

      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.traverse?.((o) => {
          if (o.isMesh) o.geometry.dispose();
          if (o.material) o.material.dispose?.();
        });
        this.bubbleBombs.splice(i, 1);
      }
    }
  }

  /** 水弹炸开时的水柱：一圈向上喷的 Splash01 广告牌，0.8 秒内升起再落下 */
  #spawnWaterCrown(x, z, t) {
    const tex = getSplashTex();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      const r = 2.6 + (i % 3) * 1.6;
      s.position.set(x + Math.cos(a) * r, this.groundAt(x, z, t) + 1.2, z + Math.sin(a) * r);
      s.scale.set(3.2, 7.5, 1);
      this.scene.add(s);
      this.waterSprays.push({ sprite: s, life: 0.8, maxLife: 0.8, x, z });
    }
  }

  #updateWaterSprays(dt, t) {
    for (let i = this.waterSprays.length - 1; i >= 0; i--) {
      const s = this.waterSprays[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.sprite);
        s.sprite.material.dispose();
        this.waterSprays.splice(i, 1);
        continue;
      }
      const k = 1 - s.life / s.maxLife;         // 0→1
      s.sprite.material.opacity = 0.85 * (1 - k) * (k < 0.15 ? k / 0.15 : 1);
      s.sprite.position.y = this.groundAt(s.x, s.z, t) + 1.2 + k * 6.5;
      const w = 3.2 + k * 2.6;
      s.sprite.scale.set(w, 7.5 + k * 3.5, 1);
    }
  }

  // 泡泡蜻蜓：半透明泡泡身体 + 四片发光翅膀（追踪型弹道）
  #makeBubbleFly() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 18, 12),
      makeBubbleMaterial({ tint: 0xbdf2ff, opacity: 0.85, rim: 1.3, phase: 0 }),
    );
    body.scale.set(0.8, 0.9, 1.5);
    g.add(body);
    const wingMat = new THREE.MeshBasicMaterial({
      color: 0xcdf6ff, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const wingGeo = new THREE.PlaneGeometry(1.5, 0.6);
    const wings = [];
    for (let i = 0; i < 4; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const wing = new THREE.Mesh(wingGeo, wingMat);
      wing.position.set(side * 0.85, 0.2, i < 2 ? 0.25 : -0.3);
      wing.rotation.z = side * 0.35;
      g.add(wing);
      wings.push({ mesh: wing, side });
    }
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: 0x8fe6ff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }),
    );
    g.add(glow);
    g.userData = { wings, glow };
    this.scene.add(g);
    return g;
  }

  /**
   * 深海瀑布：蓝色向上水柱。
   * 构造照搬怪物模式 BOSS 的熔岩柱（开口圆柱 + 加色混合、由下往上缩放），
   * 换成水色，并补一圈扩散的水面冲击环。
   */
  #spawnGeyser(x, z, scale = 1) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5 * scale, 3.0 * scale, 16 * scale, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x7fdcff, transparent: true, opacity: 0.8, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    core.position.y = 8 * scale;
    g.add(core);
    // 外层水雾：更宽更淡，读作“瀑布砸下来的水汽”
    const mist = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2 * scale, 5.2 * scale, 13 * scale, 16, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x2f8fd8, transparent: true, opacity: 0.35, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    mist.position.y = 7 * scale;
    g.add(mist);
    const ringGeo = new THREE.RingGeometry(1.2 * scale, 2.4 * scale, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xa8f0ff, transparent: true, opacity: 0.7, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }));
    g.add(ring);
    this.scene.add(g);
    this.geysers.push({ group: g, x, z, life: 2.4, maxLife: 2.4, core, mist, ring, scale });
  }

  #updateGeysers(dt, t) {
    for (let i = this.geysers.length - 1; i >= 0; i--) {
      const gz = this.geysers[i];
      gz.life -= dt;
      if (gz.life <= 0) {
        this.scene.remove(gz.group);
        gz.group.traverse((o) => {
          if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); }
        });
        this.geysers.splice(i, 1);
        continue;
      }
      const k = gz.life / gz.maxLife;                  // 1→0
      const fadeIn = Math.min(1, (1 - k) * 8);
      const fadeOut = Math.min(1, k * 2.2);
      const grow = 0.3 + Math.min(1, (1 - k) * 3.2) * 0.85;
      gz.group.position.set(gz.x, this.groundAt(gz.x, gz.z, t), gz.z);
      gz.group.rotation.y = t * 0.9;
      gz.core.scale.set(1, grow, 1);
      gz.core.position.y = 8 * gz.scale * grow;
      gz.core.material.opacity = 0.8 * fadeIn * fadeOut;
      gz.mist.scale.set(1 + (1 - k) * 0.25, grow * 0.9, 1 + (1 - k) * 0.25);
      gz.mist.material.opacity = 0.35 * fadeIn * fadeOut;
      gz.ring.scale.setScalar(1 + (1 - k) * 2.4);
      gz.ring.material.opacity = 0.7 * fadeOut;
    }
  }

  #spawnBurst(x, z, scale) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getBurstTex(), transparent: true, opacity: 1, depthWrite: false,
    }));
    s.position.set(x, 1, z);
    s.scale.setScalar(scale * 0.5);
    this.scene.add(s);
    this.bursts.push({ sprite: s, life: 0.6, maxLife: 0.6, scale });
  }

  #updateBursts(dt) {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.life -= dt;
      if (b.life <= 0) {
        this.scene.remove(b.sprite);
        b.sprite.material.dispose();
        this.bursts.splice(i, 1);
        continue;
      }
      const t = 1 - b.life / b.maxLife;
      b.sprite.material.opacity = 1 - t;
      b.sprite.scale.setScalar(b.scale * (0.5 + t * 1.6));
    }
  }

  #updateProjectiles(dt, t) {
    const boats = this.getBoats();
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      const cfg = p.cfg || homingConfig(p.type);
      const homing = !!cfg;

      // 追踪：朝「拦截点」转向（炸弹/导弹/章鱼怪/泡泡蜻蜓共用 Homing.js）
      if (p.target) {
        const tb = boats.get(p.target);
        if (tb && cfg) {
          steerHoming(p, {
            x: tb.pos.x,
            z: tb.pos.z,
            vx: tb.vel?.x || 0,
            vz: tb.vel?.y || 0,
            speed: tb.speed || 0,
          }, cfg, dt);
        } else if (!tb) {
          p.target = null;
        }
      }

      const prevX = p.x;
      const prevZ = p.z;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      const hover = cfg ? cfg.hover : p.type === 'torpedo' ? 0.45 : 1.2;
      const bob = homing ? Math.sin(t * 6 + p.x) * 0.2 : 0;
      p.mesh.position.set(p.x, this.groundAt(p.x, p.z, t) + hover + bob, p.z);
      if (p.type === 'missile' || p.type === 'bomb' || p.type === 'torpedo' || homing) {
        p.mesh.rotation.y = Math.atan2(p.vx, p.vz);
      }
      if (p.type === 'octopus') p.mesh.rotation.z = Math.sin(t * 9) * 0.25;
      if (p.type === 'bubblefly') {
        // 翅膀高频扇动
        for (const w of p.mesh.userData?.wings || []) {
          w.mesh.rotation.z = w.side * (0.35 + Math.sin(t * 34 + (w.side > 0 ? 0 : 1)) * 0.5);
        }
      }

      // 护盾墙：别家的墙会把这颗弹直接打灭（含追踪弹 / 鱼雷 / 血枪）。
      // 判定用「本帧位移线段 × 墙线段」，80m/s 的弹一帧走 1.3m，只看落点会穿过去。
      const wallZone = this.#blockedByWall(p, prevX, prevZ);
      const wallHit = !!wallZone;
      if (wallHit) {
        p.life = 0;
        this.wallBlocks += 1;
        this.#reportWallRescue(wallZone, p);
        this.#spawnBurst(p.x, p.z, 3);
        this.#playFx('antimagn', p.x, p.z, 0.7);
      }

      // 命中判定：仅施放者客户端权威（AI 由主机代判）
      // 用「一帧内的线段」判圆，而不是只看当前位置：80 m/s 的弹一帧走 1.3m，
      // 只看落点会从目标身侧“穿过去”，表现就是“明明撞上了却没炸”。
      const iAmOwner = p.owner === this.myId || (this.isHost && p.owner.startsWith('ai'));
      const hitR = cfg ? cfg.hitR : p.type === 'torpedo' ? TORPEDO_HIT_R : 2.4;
      const near = (boat) => segmentDistance(prevX, prevZ, p.x, p.z, boat.pos.x, boat.pos.z) < hitR;
      if (!wallHit && iAmOwner) {
        for (const [id, boat] of boats) {
          if (id === p.owner) continue;
          // 组队：弹道穿过队友不结算（血枪等穿透弹继续往前飞）
          if (this.isTeammate(p.owner, id)) continue;
          // 追踪弹只结算锁定的目标，避免半路误伤路人
          if (p.target && id !== p.target) continue;
          // 血枪只打排名比自己高的人（落后才有用，不会误伤后面的队友）
          if (p.onlyAhead && this.getRank(id) >= this.getRank(p.owner)) continue;
          // 穿透弹已经打过的人不再重复结算
          if (p.pierce && p.hitSet.has(id)) continue;
          if (!near(boat)) continue;
          if (boat.shieldTimer > 0) {
            // 以前只弹一句 toast，被挡的人收不到任何消息 → shield_break 永远不响
            this.#reportBlocked(id, p.owner, boat.pos.x, boat.pos.z);
            if (p.pierce) {
              // 穿透弹被护盾挡住的是「这一个目标」，弹体继续往前飞
              p.hitSet.add(id);
              this.#spawnBurst(boat.pos.x, boat.pos.z, 3);
              continue;
            }
            this.#spawnBurst(p.x, p.z, 3.5);
            p.life = 0;
            break;
          }
          if (p.pierce) {
            // 血枪狙击：贯穿。命中一个不消失，继续往前打下一个
            p.hitSet.add(id);
            boat.applyFx('slow', BLOOD_LANCE_SLOW);
            this.net.send({
              t: 'itemHit', id, by: p.owner, fx: 'slow', dur: BLOOD_LANCE_SLOW,
              x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1),
            });
            this.#playFx('fxHarpoonHit', boat.pos.x, boat.pos.z, 1.0);
            this.#spawnBurst(boat.pos.x, boat.pos.z, 5);
            if (id === this.myId) this.screenFlash = Math.max(this.screenFlash, 0.35);
            this.#noteHit(p.owner);
            continue;
          }
          if (p.type === 'torpedo') {
            // 掀翻：船体侧翻半圈再翻回来，期间失控（1.2s）。不减速 —— 船已经停了。
            boat.applyFx('capsize', CAPSIZE_DURATION);
            this.net.send({ t: 'itemHit', id, by: p.owner, fx: 'capsize', dur: CAPSIZE_DURATION, x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
            this.#spawnBurst(p.x, p.z, 7);
            this.#playFx('toonWater', boat.pos.x, boat.pos.z, 1.0);
            if (id === this.myId) this.screenFlash = Math.max(this.screenFlash, 0.4);
            this.#noteHit(p.owner);
            p.life = 0;
            break;
          }
          if (p.type === 'octopus') {
            // 缠住：转向锁死 + 偏航拖拽 + 速度 -30%，2 秒后松手沉海
            boat.applyFx('octoGrab', OCTOPUS_GRAB);
            this.net.send({ t: 'itemHit', id, by: p.owner, fx: 'octoGrab', dur: OCTOPUS_GRAB, x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
            this.#playFx('fxMagicDark', boat.pos.x, boat.pos.z, 1.2);
            this.#spawnBurst(p.x, p.z, 4);
            this.#noteHit(p.owner);
            p.life = 0;
            // 弹道本体挂到艇身上（add 会自动从 scene 移除），2 秒后由 #updateOctoGrabs 沉海
            this.#attachOctopus(boat, p.mesh);
            p.mesh = null;
            break;
          }
          if (p.type === 'bubblefly') {
            // 异世界：3 秒内在赛道消失，3 秒后回到消失处继续前行
            boat.applyFx('void', VOID_DURATION);
            this.net.send({ t: 'itemHit', id, by: p.owner, fx: 'void', dur: VOID_DURATION, x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
            this.#playFx('fxMagic2Holy', boat.pos.x, boat.pos.z, 1.1);
            this.#playFx('bubble', boat.pos.x, boat.pos.z, 1.2);
            this.#spawnBurst(p.x, p.z, 4.5);
            if (id === this.myId) this.onToast(HIT_TOASTS.void);
            this.#noteHit(p.owner);
            p.life = 0;
            break;
          }
          const fx = p.type === 'bomb' ? 'sink' : p.type === 'missile' ? 'missileHit' : 'slow';
          const dur = p.type === 'bomb' ? 2 : p.type === 'missile' ? 1.8 : 1.5;
          this.net.send({ t: 'itemHit', id, by: p.owner, fx, dur, x: +p.x.toFixed(1), z: +p.z.toFixed(1) });
          // 无条件本地生效：id === myId 时 boat 就是本机对象，必须真实沉没/减速。
          boat.applyFx(fx, dur);
          this.#spawnBurst(p.x, p.z, 6);
          // 命中只保留「一层」Effekseer 特效（本项目历史教训：白球+白环叠两层被删过两次，
          // 且 Effekseer 直改 viewport，同屏层数过多会黑屏）。三类弹各用一种，靠材质区分辨识度。
          this.#playFx(p.type === 'bomb' ? 'explosion' : p.type === 'missile' ? 'hanmadoHit' : 'hit', p.x, p.z, 1);
          if (id === this.myId) this.screenFlash = Math.max(this.screenFlash, 0.45);
          this.#noteHit(p.owner);
          p.life = 0;
          break;
        }
      } else if (!wallHit && p.ghost && !p.pierce) {
        // 非权威端：视觉副本飞到目标附近即消散（真正效果由 itemHit 下发）
        let reached = false;
        if (p.target) {
          const tb = boats.get(p.target);
          reached = !!tb && segmentDistance(prevX, prevZ, p.x, p.z, tb.pos.x, tb.pos.z) < hitR + 0.6;
        } else {
          // 无锁定弹（鱼雷齐射）：撞到谁都算到了，否则弹体会一直飞到生命结束
          for (const [id, b] of boats) {
            if (id === p.owner) continue;
            if (this.isTeammate(p.owner, id)) continue;
            if (segmentDistance(prevX, prevZ, p.x, p.z, b.pos.x, b.pos.z) < hitR + 0.6) {
              reached = true;
              break;
            }
          }
        }
        if (reached) {
          this.#spawnBurst(p.x, p.z, 3);
          p.life = 0;
        }
      }

      if (p.life <= 0) {
        this.#stopProjectileFx(p);
        if (p.mesh) {
          this.scene.remove(p.mesh);
          p.mesh.traverse?.((o) => { if (o.isMesh) o.geometry.dispose(); });
        }
        this.projectiles.splice(i, 1);
      }
    }
  }

  // ---------- 主更新 ----------
  update(dt, t, now) {
    this.clock = now; // 反超保底用它计时
    if (this.magnetAim) {
      this.magnetAim.timer -= dt;
      this.magnetAim.target = this.#findMagnetTarget(this.myId, true, true);
      if (this.magnetAim.target) {
        this.magnetAim.noTargetGrace = 0.7;
        this.magnetAim.lockDelay -= dt;
        // A valid target is enough to trigger the pull after a short readable lock-on.
        if (this.magnetAim.lockDelay <= 0) {
          const target = this.magnetAim.target;
          const slot = this.magnetAim.slot;
          this.magnetAim = null;
          this.myItems[slot] = null;
          this.#activateMagnet(this.myId, target);
        }
      } else if ((this.magnetAim.noTargetGrace -= dt) <= 0) {
        // 吸不到人 = 磁铁白扔，槽位直接清空。道具必须从道具栏消失：
        // 若失败反而退还，玩家会看到"按了键没反应、道具还在"，像卡住。
        this.myItems[this.magnetAim.slot] = null;
        this.magnetAim = null;
        this.net.send({ t: 'itemFx', id: this.myId, fx: 'magnet', dur: 0, target: null });
        this.onToast('前方没有目标，磁铁已消耗');
      } else if (this.magnetAim.timer <= 0) {
        this.myItems[this.magnetAim.slot] = null;
        this.magnetAim = null;
        this.net.send({ t: 'itemFx', id: this.myId, fx: 'magnet', dur: 0, target: null });
        this.onToast('磁铁未吸到目标，道具已消耗');
      }
    }
    this.#updateMagnetReticle(t);
    this.#updateBoxes(dt, t);
    this.#updateProjectiles(dt, t);
    this.#updateBubbleBombs(dt, t);
    this.#updateWaterSprays(dt, t);
    this.#updateGeysers(dt, t);
    this.#updateOctoGrabs(dt, t);
    this.#updateVoidWorld(dt, t);
    this.#updateBursts(dt);
    this.#updateFishes(dt);
    this.#updateZones(dt, t);
    this.#tickPity(dt);
    if (this.inkTimer > 0) this.inkTimer -= dt;
    if (this.voidTimer > 0) this.voidTimer -= dt;
    // 持续音：墨汁糊眼 / 漩涡缠住（氮气持续音由 Boat 的 nitroLoopTimer 负责）
    if (this.inkTimer > 0) audio.startLoop('ink_loop', { vol: 0.5 });
    else audio.stopLoop('ink_loop');
    const localBoat = this.getBoats().get(this.myId);
    if (localBoat && localBoat.spinTimer > 0) audio.startLoop('spin_loop', { vol: 0.55 });
    else audio.stopLoop('spin_loop');
    // 屏幕闪光衰减必须无条件跑：
    // 以前它写在 #updateLightning 里，而那只在暴风雨（storm）时才被调用 ——
    // 非暴风雨房被打中一次 screenFlash 就再也不降，白蓝色蒙版永久糊在屏幕上
    // （用户报的「被道具打之后屏幕一直灰蒙蒙」就是这个）。
    this.screenFlash = Math.max(0, this.screenFlash - dt * 2.2);
    // 磁力吸盘：本地权威艇被吸向领先对手（速度叠加朝向目标的拉力，不接管操控）
    const boats = this.getBoats();
    for (const [id, boat] of boats) {
      if (!(boat.magnetTimer > 0) || !boat.magnetTarget) continue;
      const authoritative = id === this.myId || (this.isHost && id.startsWith('ai'));
      if (!authoritative) { boat.magnetTimer -= dt; continue; }
      boat.magnetTimer -= dt;
      const tb = boats.get(boat.magnetTarget);
      if (tb && tb !== boat) {
        const dx = tb.pos.x - boat.pos.x;
        const dz = tb.pos.z - boat.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const pull = 30 * dt;
        boat.vel.x += (dx / d) * pull;
        boat.vel.y += (dz / d) * pull;
        // 拉力特效：目标与自身之间的小光点
        if (Math.random() < 0.3) {
          const k = 0.3 + Math.random() * 0.4;
          this.#spawnBurst(boat.pos.x + dx * k, boat.pos.z + dz * k, 1.2);
        }
      } else {
        // A target can disappear after lock (finish/disconnect). End the pull
        // immediately instead of leaving a stale magnet state on the boat.
        this.#stopMagnetFx(boat, boat.magnetTarget);
        boat.magnetTimer = 0;
        boat.magnetTarget = null;
      }
    }
    if (this.storm) {
      if (this.isHost || this.solo) this.#scheduleLightning(dt);
      this.#updateLightning(dt, t);
    }

    // 道具箱拾取判定（本地艇 + 主机判 AI）：道具栏满 3 格则不再拾取
    for (const [id, boat] of boats) {
      const mine = id === this.myId || (this.isHost && id.startsWith('ai'));
      if (!mine) continue;
      if (id === this.myId) {
        if (!this.myItems.includes(null)) continue; // 3 格全满
      } else {
        const ai = this.aiItems.get(id);
        if (ai && ai.items.length >= 3) continue; // AI 栏满
      }
      for (const b of this.boxes) {
        if (!b.active) continue;
        // 高度过滤（天梯）：只在 boxYPad 有限时生效，老玩法走 Infinity 分支等于没这句
        if (Math.abs(boat.pos.y - b.y) > this.boxYPad) continue;
        const d = Math.hypot(boat.pos.x - b.x, boat.pos.z - b.z);
        if (d < 2.6) {
          this.#takeBox(b, id);
          this.net.send({ t: 'itemPick', boxIdx: b.idx, by: id });
          break;
        }
      }
    }

    // AI 按时机智能使用道具（攻击有目标才放、防御/氮气主动、满格兜底腾格）
    for (const [id, ai] of [...this.aiItems]) {
      if (!ai.items.length) { this.aiItems.delete(id); continue; }
      if (now < ai.useAt) continue;
      const boat = boats.get(id);
      if (!boat) { this.aiItems.delete(id); continue; }
      const idx = this.#aiPickItem(id, ai.items, boat, boats);
      if (idx >= 0) {
        const item = ai.items.splice(idx, 1)[0];
        this.useItem(id, item);
        this.syncHeld(id); // 名次栏图标跟着消失（覆盖式，不怕 itemUse 分支漏发）
        ai.useAt = now + 1.2 + Math.random() * 1.6;
      } else {
        ai.useAt = now + 0.4; // 暂无可放道具，稍后再评估
      }
    }
  }

  /** AI 道具时机选择：返回道具栏里当前最该释放的下标，-1 表示暂不释放 */
  #aiPickItem(id, items, boat, boats) {
    const total = boats.size;
    const rank = this.getRank(id);
    const hasAhead = rank > 1;
    const hasBehind = rank < total;
    const canBoost = boat.boostTimer <= 0 && (boat.speed ?? 0) < (boat.def?.maxSpeed ?? 40) * 1.2;

    // 攻击型需前方有目标；防御/通用型赛道中有人即可
    // 章鱼怪/泡泡蜻蜓都锁定“名次前一位”，落后时才放；减速艇/深海瀑布打全场，随时可放
    const AHEAD = ['bomb', 'missile', 'fish', 'rvortex', 'magnet', 'octopus', 'bubblefly', 'torpedo',
      'bloodlance', 'holystorm', 'gate'];
    // 区域/防御型：场上有人就放（圣域/护盾墙/剑刃风暴都是「守住身后」）
    const ANY = ['ink', 'tide', 'slowboat', 'waterfall', 'vortex', 'shield', 'angel',
      'bladestorm', 'sanctuary', 'barrier'];

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it === 'nitro') { if (canBoost) return i; continue; }
      if (AHEAD.includes(it)) { if (hasAhead) return i; continue; }
      if (ANY.includes(it)) { if (hasAhead || hasBehind) return i; continue; }
    }
    // 满格兜底：无适放道具时放掉一个，避免永久占格停止拾取
    if (items.length >= 3) return 0;
    return -1;
  }

  dispose() {
    this.boxField?.dispose();
    this.boxField = null;
    for (const z of this.zones) this.#disposeZone(z);
    this.zones.length = 0;
    for (const g of this.geysers) this.scene.remove(g.group);
    this.geysers.length = 0;
    for (const g of this.octoGrabs) g.mesh.parent?.remove(g.mesh);
    this.octoGrabs.length = 0;
    for (const b of this.bubbleBombs) {
      this.scene.remove(b.mesh);
      b.mesh.traverse?.((o) => {
        if (o.isMesh) o.geometry.dispose();
        if (o.material) o.material.dispose?.();
      });
    }
    for (const p of this.projectiles) {
      this.#stopProjectileFx(p);
      this.scene.remove(p.mesh);
    }
    for (const w of this.warnings) this.scene.remove(w.mesh);
    for (const b of this.bolts) this.scene.remove(b.mesh);
    for (const b of this.bursts) this.scene.remove(b.sprite);
    for (const s of this.waterSprays) this.scene.remove(s.sprite);
    this.waterSprays.length = 0;
    if (this.voidWorld) {
      // CSS 幻境层：只收起显示，DOM 常驻（切局/离场都归位，避免下一局残留）
      if (this.voidWorld.el) {
        this.voidWorld.el.classList.add('hidden');
        this.voidWorld.el.classList.remove('show');
      }
      this._voidShown = false;
      this.voidWorld = null;
    }
    if (this.magnetReticle) {
      this.scene.remove(this.magnetReticle.group);
      this.magnetReticle.group.traverse((obj) => {
        if (obj.isLineSegments) {
          obj.geometry.dispose();
          obj.material.dispose();
        }
      });
    }
  }
}
