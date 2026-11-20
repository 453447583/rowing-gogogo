// 海克斯大乱斗 · 随机局内计划
// 纯数据 + 确定性随机：同一个 seed 在任何机器上都生成完全相同的一套计划，
// 所以联机只需要同步 seed，客机不需要（也不允许）自己做随机。

import { BOSSES, BOSS_SKILLS } from './bosses.js';

// 4 头 BOSS 的原始顺序（对应 BOSS_LEVELS 的 1~4 关）。
// 海克斯模式只打乱出场顺序，不改它们的数值与技能。
export const HEX_BOSS_ORDER = [
  'dragon_deep', 'dragon_inferno', 'knight_thunder', 'blood_nightmare',
];

// 每关从该 BOSS 自己的技能池里抽几个（抽不满就全上）
export const HEX_SKILL_COUNT = 5;

// 天气池：复用 WEATHERS 的 id（day/dusk/storm/blizzard/starry），
// 与场景主题各自独立抽取，允许"火龙打雪原"这类违和组合。
export const HEX_WEATHERS = ['day', 'dusk', 'storm', 'blizzard', 'starry'];

// ---------- 本局核心（L0，开局三选一，全队共享） ----------
// 效果只走已经存在的倍率位：玩家伤害、玩家受伤、复活次数、开局道具。
export const HEX_CORES = [
  {
    id: 'pow', name: '火力狂欢', icon: '🔥', desc: '全队造成伤害 +30%',
    mods: { dmgMul: 1.3 },
  },
  {
    id: 'steel', name: '钢铁洪流', icon: '🛡', desc: '全队受到伤害 -25%',
    mods: { takenMul: 0.75 },
  },
  {
    id: 'rich', name: '富甲一方', icon: '💰', desc: '每关开局额外获得 1 个随机道具',
    mods: { starterItems: 1 },
  },
  {
    id: 'glass', name: '玻璃舰队', icon: '💎', desc: '造成伤害 +50%，但受到伤害 +35%',
    mods: { dmgMul: 1.5, takenMul: 1.35 },
  },
  {
    id: 'bless', name: '海神祝福', icon: '🌊', desc: '每关开局回满血，且复活次数 +1',
    mods: { healFull: true, revive: 1 },
  },
  {
    id: 'crit', name: '会心一击', icon: '🎯', desc: '全队造成伤害 +20%',
    mods: { dmgMul: 1.2 },
  },
];

// ---------- 关卡规则（L1，词缀） ----------
// tier 1 = 轻，2 = 重；negative 只用于过场卡标红。
// 所有字段都在 BossMode.startStage 里被换算成已有的 hp/dmg/cd/speed 倍率。
export const HEX_RULES = [
  {
    id: 'rage', name: '狂暴', icon: '⚡', tier: 2, negative: true,
    desc: 'BOSS 出手更快（冷却 -25%），但血量 -20%',
    mods: { bossCdMul: 0.75, bossHpMul: 0.8 },
  },
  {
    id: 'regen', name: '再生', icon: '💚', tier: 2, negative: true,
    desc: 'BOSS 血量 +35%',
    mods: { bossHpMul: 1.35 },
  },
  {
    id: 'armor', name: '重甲', icon: '🪖', tier: 2, negative: true,
    desc: 'BOSS 血量 +15%，全队伤害 -15%',
    mods: { bossHpMul: 1.15, playerDmgMul: 0.85 },
  },
  {
    id: 'venom', name: '瘴气', icon: '☠', tier: 1, negative: true,
    desc: '全队受到伤害 +15%，但医疗包刷新更快',
    mods: { playerTakenMul: 1.15, healRate: 0.7 },
  },
  {
    id: 'greed', name: '贪婪', icon: '🪙', tier: 1, negative: false,
    desc: '道具箱刷新更快，但 BOSS 伤害 +15%',
    mods: { boxRate: 0.7, bossDmgMul: 1.15 },
  },
  {
    id: 'gale', name: '疾风', icon: '🌬', tier: 1, negative: false,
    desc: 'BOSS 血量 +10%，但医疗包刷新更快',
    mods: { bossHpMul: 1.1, healRate: 0.75 },
  },
  {
    id: 'bloodrage', name: '血怒', icon: '🩸', tier: 2, negative: false,
    desc: '全队伤害 +25%，但受到伤害 +20%',
    mods: { playerDmgMul: 1.25, playerTakenMul: 1.2 },
  },
  {
    id: 'ironwall', name: '铁壁', icon: '🧱', tier: 1, negative: false,
    desc: '全队受到伤害 -20%，但伤害 -10%',
    mods: { playerTakenMul: 0.8, playerDmgMul: 0.9 },
  },
  {
    id: 'fortune', name: '时来运转', icon: '🍀', tier: 1, negative: false,
    desc: '每关开局额外获得 1 个随机道具',
    mods: { starterItems: 1 },
  },
  {
    id: 'trial', name: '试炼', icon: '🔥', tier: 2, negative: false,
    desc: '本关危险物 +2，但全队伤害 +15%',
    mods: { hazardAdd: 2, playerDmgMul: 1.15 },
  },
  // 第四批：新增轻规则 2 条 + 重规则 1 条（只使用已被 BossMode 消费的倍率位）
  {
    id: 'frenzy', name: '狂热', icon: '💢', tier: 1, negative: true,
    desc: '全队伤害 +12%，但受到伤害 +12%',
    mods: { playerDmgMul: 1.12, playerTakenMul: 1.12 },
  },
  {
    id: 'bounty', name: '悬赏', icon: '🪙', tier: 1, negative: false,
    desc: '每关开局额外获得 2 个随机道具，但伤害 -10%',
    mods: { starterItems: 2, playerDmgMul: 0.9 },
  },
  {
    id: 'colossus', name: '巨像', icon: '🗿', tier: 2, negative: true,
    desc: 'BOSS 血量 +30%，但出手更慢（冷却 +25%）',
    mods: { bossHpMul: 1.3, bossCdMul: 1.25 },
  },
];

// ---------- 危险物池（L4 静态部分） ----------
// cost 是预算消耗；high = 高伤害来源，每关最多 3 个（wild 强度）。
export const HEX_HAZARDS = [
  { id: 'lava', name: '熔岩雨', icon: '🌋', cost: 2, high: true, desc: '场上持续落熔岩柱' },
  { id: 'thunder', name: '静电场', icon: '⚡', cost: 2, high: true, desc: '定时全场落雷' },
  { id: 'vortex', name: '追踪漩涡', icon: '🌀', cost: 3, high: true, desc: '龙卷持续追人' },
  { id: 'heal', name: '医疗补给', icon: '💚', cost: 1, high: false, desc: '医疗包刷新更快' },
  { id: 'boxes', name: '道具补给', icon: '📦', cost: 1, high: false, desc: '道具箱刷新更快' },
  // 第三批新增：复用熔岩柱的落点/伤害链路（kind 决定外观与节奏），不另起一套实体
  { id: 'rockfall', name: '落石雨', icon: '🪨', cost: 2, high: true, kind: 'rockfall', desc: '场地随机砸落巨石' },
  { id: 'poison', name: '毒雾', icon: '☠', cost: 2, high: false, kind: 'poison', desc: '绿色毒雾持续腐蚀船体' },
  { id: 'spike', name: '尖刺阵', icon: '🔺', cost: 2, high: true, kind: 'spike', desc: '海面突然刺出尖刺' },
  // 第四批：陨石雨（落点更少更重，Effekseer 陨石）/ 血月（纯数值危险物，不占落区）
  { id: 'meteor', name: '陨石雨', icon: '☄', cost: 3, high: true, kind: 'meteor', desc: '陨石成片砸落，落点少但伤害更高' },
  { id: 'bloodmoon', name: '血月', icon: '🌕', cost: 2, high: false, desc: 'BOSS 造成的伤害 +20%' },
];

// ---------- 局内随机事件（轻量版） ----------
// at = 开打后第几秒触发；每关抽 1~2 个。
export const HEX_EVENTS = [
  { id: 'airdrop', name: '空投补给', icon: '🪂', desc: '随机空投医疗包' },
  { id: 'berserk', name: 'BOSS 暴走', icon: '💢', desc: 'BOSS 攻速与伤害短暂提升' },
  { id: 'storm', name: '全场闪电', icon: '🌩', desc: '随机位置落下雷电' },
  { id: 'terrain', name: '熔岩地形', icon: '🌋', desc: '场地随机喷发熔岩柱' },
  // 第四批：复用现有落区 / 道具栏，不新增系统
  { id: 'meteorshower', name: '陨石齐落', icon: '☄', desc: '场地连续落下陨石' },
  { id: 'armory', name: '军械补给', icon: '🧰', desc: '本机立即获得 1 个随机道具' },
];

// ---------- 卡牌稀有度 ----------
// 只按权重抽卡：白 60 / 蓝 30 / 金 10，不做保底、不做重掷。
// UI 侧已经把 rarity 当 class 用（white/blue/gold），替换外观时可以直接沿用。
export const HEX_RARITY_WEIGHTS = { white: 60, blue: 30, gold: 10 };

// ---------- 关卡通关三选一（24 张完整卡池） ----------
// 效果仍然只落在已有的四个字段上：dmgMul / takenMul / starterItems / revive，
// 这样不需要改战斗框架，数值强弱完全由稀有度决定。
export const HEX_CARDS = [
  // —— 白（常见，小幅数值） ——
  { id: 'pierce', name: '穿甲弹头', icon: '💥', rarity: 'white', desc: '造成伤害 +15%', mods: { dmgMul: 1.15 } },
  { id: 'plate', name: '装甲板', icon: '🛡', rarity: 'white', desc: '受到伤害 -12%', mods: { takenMul: 0.88 } },
  { id: 'supply', name: '开局补给', icon: '📦', rarity: 'white', desc: '每关开局额外获得 1 个随机道具', mods: { starterItems: 1 } },
  { id: 'keel', name: '加固龙骨', icon: '⚓', rarity: 'white', desc: '受到伤害 -10%', mods: { takenMul: 0.9 } },
  { id: 'steady', name: '稳定炮座', icon: '🎯', rarity: 'white', desc: '造成伤害 +12%', mods: { dmgMul: 1.12 } },
  { id: 'whetstone', name: '磨刀石', icon: '🪨', rarity: 'white', desc: '造成伤害 +10%', mods: { dmgMul: 1.1 } },
  { id: 'bulkhead', name: '水密隔舱', icon: '🚪', rarity: 'white', desc: '受到伤害 -14%', mods: { takenMul: 0.86 } },
  { id: 'drilled', name: '速射炮组', icon: '🔩', rarity: 'white', desc: '造成伤害 +16%', mods: { dmgMul: 1.16 } },
  { id: 'ration', name: '战备口粮', icon: '🍱', rarity: 'white', desc: '每关开局额外获得 1 个随机道具', mods: { starterItems: 1 } },
  { id: 'scout', name: '侦察改装', icon: '🔭', rarity: 'white', desc: '造成伤害 +5%，受到伤害 -7%', mods: { dmgMul: 1.05, takenMul: 0.93 } },
  // —— 蓝（中等强度） ——
  { id: 'weak', name: '弱点猎手', icon: '🎯', rarity: 'blue', desc: '造成伤害 +22%', mods: { dmgMul: 1.22 } },
  { id: 'critcore', name: '暴击核心', icon: '✨', rarity: 'blue', desc: '造成伤害 +25%', mods: { dmgMul: 1.25 } },
  { id: 'patch', name: '应急修复', icon: '🔧', rarity: 'blue', desc: '受到伤害 -18%', mods: { takenMul: 0.82 } },
  { id: 'quartermaster', name: '军需官', icon: '🎖', rarity: 'blue', desc: '每关开局额外获得 2 个随机道具', mods: { starterItems: 2 } },
  { id: 'composite', name: '复合装甲', icon: '🧱', rarity: 'blue', desc: '受到伤害 -22%', mods: { takenMul: 0.78 } },
  { id: 'sharpshooter', name: '神射手', icon: '🎯', rarity: 'blue', desc: '造成伤害 +28%', mods: { dmgMul: 1.28 } },
  { id: 'veteran', name: '老兵经验', icon: '🎖', rarity: 'blue', desc: '造成伤害 +20%，受到伤害 -8%', mods: { dmgMul: 1.2, takenMul: 0.92 } },
  { id: 'reserve', name: '备件箱', icon: '🧰', rarity: 'blue', desc: '每关开局额外获得 2 个随机道具', mods: { starterItems: 2 } },
  { id: 'reinforce', name: '结构强化', icon: '🏗', rarity: 'blue', desc: '受到伤害 -20%', mods: { takenMul: 0.8 } },
  // —— 金（稀有，高收益往往带代价） ——
  { id: 'neptune', name: '海神庇佑', icon: '🌊', rarity: 'gold', desc: '立刻获得 1 次额外复活', mods: { revive: 1 } },
  { id: 'bloodrage', name: '血怒', icon: '🩸', rarity: 'gold', desc: '造成伤害 +40%，但受到伤害 +25%', mods: { dmgMul: 1.4, takenMul: 1.25 } },
  { id: 'glasscannon', name: '玻璃大炮', icon: '💎', rarity: 'gold', desc: '造成伤害 +50%，但受到伤害 +20%', mods: { dmgMul: 1.5, takenMul: 1.2 } },
  { id: 'berserk', name: '狂战核心', icon: '🔥', rarity: 'gold', desc: '造成伤害 +55%，但受到伤害 +30%', mods: { dmgMul: 1.55, takenMul: 1.3 } },
  { id: 'aegis', name: '神盾', icon: '🛡', rarity: 'gold', desc: '受到伤害 -32%，但造成伤害 -10%', mods: { takenMul: 0.68, dmgMul: 0.9 } },
];

const HAZARD_BUDGET = [5, 7, 9, 11];

/** 字符串 -> 32 位无符号整数（房主用时间戳做种子时也能稳定复现） */
export function hashSeed(input) {
  const str = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小、快、确定性好，足够做「每把不同」的抽取 */
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rng, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pickOne(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

/** 从池里不重复地抽 n 个（用于核心三选一） */
function pickMany(rng, list, n) {
  return shuffle(rng, list).slice(0, n);
}

/** 抽本关规则：第 1 条从轻规则里抽，第 2 条起允许重规则（重规则最多 1 条，其余用轻规则补） */
function rollRules(rng, count) {
  const light = HEX_RULES.filter((r) => r.tier === 1);
  const heavy = HEX_RULES.filter((r) => r.tier === 2);
  const out = [];
  const first = pickOne(rng, light.length ? light : HEX_RULES);
  out.push(first.id);
  if (count > 1) {
    const rest = shuffle(rng, heavy.filter((r) => !out.includes(r.id))).slice(0, 1);
    out.push(...rest.map((r) => r.id));
  }
  // 第 3 条（无尽第 5 层起）必须是轻规则：三条全是负向重词缀会直接劝退
  while (out.length < count) {
    const pool = light.filter((r) => !out.includes(r.id));
    if (!pool.length) break;
    out.push(pickOne(rng, pool).id);
  }
  return out;
}

/** 按预算装危险物：高伤来源最多 3 个，装不满就把便宜的补上 */
function rollHazards(rng, budget) {
  const out = [];
  let left = budget;
  let high = 0;
  let guard = 0;
  while (left > 0 && guard++ < 24) {
    const pool = HEX_HAZARDS.filter((h) => h.cost <= left
      && !out.some((o) => o.id === h.id)
      && (!h.high || high < 3));
    if (!pool.length) break;
    const h = pickOne(rng, pool);
    out.push({ id: h.id });
    left -= h.cost;
    if (h.high) high++;
  }
  return out;
}

/** 每关抽 1~2 个事件，并给一个 25~90 秒之间的触发时刻 */
function rollEvents(rng, stage) {
  const count = stage >= 3 ? 2 : (rng() < 0.5 ? 1 : 2);
  const picked = pickMany(rng, HEX_EVENTS, count);
  return picked.map((e, i) => ({
    id: e.id,
    at: Math.round(24 + rng() * 20 + i * (30 + rng() * 20)),
  }));
}

/**
 * BOSS 连招：从本关技能子集里派生 1~2 组两连击。
 * 同一张技能卡只会出现在一组连招里，避免一招被反复"白嫖"。
 * label 预先拼好，过场/UI 不需要再认识 BOSS_SKILLS。
 */
function rollCombos(rng, stage, skills) {
  const count = stage >= 3 ? (rng() < 0.65 ? 2 : 1) : (rng() < 0.5 ? 1 : 2);
  const pairs = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) pairs.push([skills[i], skills[j]]);
  }
  if (!pairs.length) return [];
  const used = new Set();
  const out = [];
  for (const [a, b] of shuffle(rng, pairs)) {
    if (out.length >= count) break;
    if (used.has(a) || used.has(b)) continue;
    used.add(a);
    used.add(b);
    const an = BOSS_SKILLS[a]?.name || a;
    const bn = BOSS_SKILLS[b]?.name || b;
    out.push({
      id: `${a}-${b}`,
      skills: [a, b],
      label: `${an} → ${bn}`,
      // 第一段结算后隔 0.35~0.6 秒接第二段：能看出是连招，又不会两团特效糊在一起
      gap: 0.35 + rng() * 0.25,
      cooldown: 16 + rng() * 6,
    });
  }
  return out;
}

/** 预算之外再追加 N 个不同危险物（「试炼」规则）：高伤来源仍不超过 3 个 */
function addExtraHazards(rng, hazards, count) {
  let high = hazards.filter((o) => HEX_HAZARDS.find((h) => h.id === o.id)?.high).length;
  for (let i = 0; i < count; i++) {
    const pool = HEX_HAZARDS.filter((h) => !hazards.some((o) => o.id === h.id)
      && (!h.high || high < 3));
    if (!pool.length) break;
    const h = pickOne(rng, pool);
    hazards.push({ id: h.id });
    if (h.high) high++;
  }
  return hazards;
}

/**
 * 生成一局的完整计划。
 * @param {number|string} seedInput
 * @param {number} stageCount 层数：默认 4 层；无尽模式每续一层就把本局计划延长一层。
 *   核心三选一用独立 rng，延长层数不会改变开局给出的三个核心。
 * @returns {{seed:number, coreOptions:string[], stages:Array}}
 */
export function buildRunPlan(seedInput, stageCount = 4) {
  const seed = (typeof seedInput === 'number' ? seedInput >>> 0 : hashSeed(seedInput)) || 1;
  const rng = makeRng(seed);
  // 4 头 BOSS 全排列不重复：只打乱顺序，数值仍用各自原始配置；无尽层数超出后循环复用
  const order = shuffle(rng, HEX_BOSS_ORDER.slice());
  const count = Math.max(1, Math.floor(stageCount) || 4);
  const stages = [];
  for (let i = 0; i < count; i++) {
    const stage = i + 1;
    const bossId = order[i % order.length];
    const originStage = HEX_BOSS_ORDER.indexOf(bossId) + 1;
    // 层数越高词缀越多：第 1~2 层 1 条、第 3~4 层 2 条、第 5 层起 3 条（PRD P4）
    const ruleCount = Math.min(3, 1 + Math.floor((stage - 1) / 2));
    const rules = rollRules(rng, ruleCount);
    const hazardAdd = rules.reduce(
      (sum, id) => sum + (HEX_RULES.find((r) => r.id === id)?.mods?.hazardAdd || 0), 0,
    );
    const budget = HAZARD_BUDGET[Math.min(i, HAZARD_BUDGET.length - 1)];
    const hazards = addExtraHazards(rng, rollHazards(rng, budget), hazardAdd);
    // L2：本关技能子集（顺序也随机，进关后轮转出招）
    const skills = shuffle(rng, BOSSES[bossId].skills.slice()).slice(0, HEX_SKILL_COUNT);
    stages.push({
      stage,
      bossId,
      originStage,
      danger: originStage, // 危险评级：BOSS 原本属于第几关，就按几颗星
      rules,
      hazards,
      events: rollEvents(rng, stage),
      budget,
      skills,
      // 第三批：BOSS 连招（1~2 组），都在本关技能子集内
      combos: rollCombos(rng, stage, skills),
      // L3：场景主题（1~4 关的美术布景）与天气各自独立随机
      themeStage: 1 + Math.floor(rng() * 4),
      weather: pickOne(rng, HEX_WEATHERS),
    });
  }
  // 核心三选一独立随机流：不能和层数生成混在一起，否则续层会把开局核心换掉
  const coreRng = makeRng((seed ^ 0x2545f491) >>> 0);
  return {
    seed,
    coreOptions: pickMany(coreRng, HEX_CORES.map((c) => c.id), 3),
    stages,
  };
}

/** 合并一组规则/核心的数值加成（乘法叠乘，加法相加） */
export function mergeMods(ids, pool) {
  const out = {
    bossHpMul: 1, bossDmgMul: 1, bossCdMul: 1, bossSpeedMul: 1,
    playerDmgMul: 1, playerTakenMul: 1, playerSpeedMul: 1,
    healRate: 1, boxRate: 1, starterItems: 0, revive: 0,
    dmgMul: 1, takenMul: 1, healFull: false, hazardAdd: 0,
  };
  for (const id of ids || []) {
    const def = pool.find((x) => x.id === id);
    if (!def?.mods) continue;
    for (const [k, v] of Object.entries(def.mods)) {
      if (typeof v === 'boolean') out[k] = out[k] || v;
      else if (k === 'starterItems' || k === 'revive' || k === 'hazardAdd') out[k] += v;
      else out[k] *= v;
    }
  }
  return out;
}

export const hexDefs = { HEX_CORES, HEX_RULES, HEX_HAZARDS, HEX_EVENTS, HEX_CARDS };

/**
 * 按稀有度权重从候选池里抽一张卡（不修改入参）。
 * 只做权重抽卡，不做保底/重掷：白卡多、金卡稀有，但每次三选一都可能出金。
 */
export function pickWeightedCard(rng, pool) {
  if (!pool?.length) return null;
  let total = 0;
  for (const c of pool) total += HEX_RARITY_WEIGHTS[c.rarity] || 1;
  let roll = rng() * total;
  for (const c of pool) {
    roll -= HEX_RARITY_WEIGHTS[c.rarity] || 1;
    if (roll < 0) return c;
  }
  return pool[pool.length - 1];
}

/** 把多份 mergeMods 结果合成一份（倍率相乘、计数相加、布尔取或） */
export function combineMods(...list) {
  const out = mergeMods([], []);
  for (const mods of list) {
    if (!mods) continue;
    for (const [k, v] of Object.entries(mods)) {
      if (typeof v === 'boolean') out[k] = out[k] || v;
      else if (k === 'starterItems' || k === 'revive' || k === 'hazardAdd') out[k] += v;
      else out[k] *= v;
    }
  }
  return out;
}
