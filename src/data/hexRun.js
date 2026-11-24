// 海克斯大乱斗 · 随机局内计划
// 纯数据 + 确定性随机：同一个 seed 在任何机器上都生成完全相同的一套计划，
// 所以联机只需要同步 seed，客机不需要（也不允许）自己做随机。

import { BOSSES, BOSS_SKILLS } from './bosses.js';

// BOSS 原始顺序（对应 BOSS_LEVELS 的 1~5 关）。
// 海克斯模式只打乱出场顺序，不改它们的数值与技能。
//
// 2026-11-22 用户要求「新加的第五头也要进海克斯前 4 层」：
// 池子从 4 头扩到 5 头，前 4 层从这 5 头里**按环取连续 4 头**（一局内不重复，
// 每局随机漏掉 1 头），所以第 1 层就有 1/5 概率撞上深渊传令官。
// 顺序必须保持「由弱到强」—— originStage / danger 都靠 index+1 推出来，
// 新 BOSS 只能追加在末尾（index 4 → 危险评级 5 星）。
export const HEX_BOSS_ORDER = [
  'dragon_deep', 'dragon_inferno', 'knight_thunder', 'blood_nightmare', 'abyss_herald',
];

// 开局轮转只占前 4 层（一局常规层数）：5 头里取 4 头，第 5 层起改为逐层完全随机。
export const HEX_START_BOSS_SLOTS = 4;

// 无尽 / 第 5 层起的随机池：和轮转池同一份（保留独立常量，方便以后单独调权重）
export const HEX_ENDLESS_BOSSES = [...HEX_BOSS_ORDER];

// 无尽成长起点：第 5 层起每层血量 ×1.35、伤害 ×1.18。
// 必须独立成常量 —— 不能再用「BOSS 池长度 / 关卡表长度」，否则池子从 4 头变 5 头时
// 成长会整体后移一层（第 5 层本该 ×1.35，会变成 ×1.0）。
export const HEX_ENDLESS_SCALE_FROM = 5;

// 危险评级上限（星星数）：最后追加进池的那头 BOSS 按第 5 关算
const BOSS_DANGER_MAX = 5;

// 每关从该 BOSS 自己的技能池里抽几个（抽不满就全上）
export const HEX_SKILL_COUNT = 5;

// 「重机制」解锁层：召唤门（kind='gate'）与追人龙卷风只从这一层起出现，且同层互斥。
// 计划生成（本文件）和运行时（BossMode 的 #vortexEnabled）必须用同一个常量，
// 否则会出现「计划里删了、运行时又被 BOSS 自带机制放出来」的漏网（2026-11-22 第 2 层被卷就是这条）。
export const HEX_HARD_MECH_MIN_STAGE = 5;

// 天气池：复用 WEATHERS 的 id（day/dusk/storm/blizzard/starry），
// 与场景主题各自独立抽取，允许"火龙打雪原"这类违和组合。
export const HEX_WEATHERS = ['day', 'dusk', 'storm', 'blizzard', 'starry'];

// ---------- 天气玩法效果（只作用于海克斯，不影响竞速天气外观） ----------
// 每层天气 = 一个明确的取舍：mods 沿用战斗里已有的倍率位，
// aimSpread 是玩家道具的「偏航角」（度），BossMode 会按难度再放大。
export const HEX_WEATHER_EFFECTS = {
  day: {
    id: 'day', name: '顺风', icon: 'hex/weatherDay.png',
    desc: '顺风：全队船速 +6%，但 BOSS 伤害 +8%',
    mods: { playerSpeedMul: 1.06, bossDmgMul: 1.08 },
  },
  dusk: {
    id: 'dusk', name: '逆光', icon: 'hex/weatherDusk.png',
    desc: '逆光：全队伤害 +12%，但 BOSS 技能预警缩短 15%',
    mods: { playerDmgMul: 1.12 },
    telegraphScale: 0.85,
  },
  storm: {
    id: 'storm', name: '逆浪', icon: 'hex/thundercloud.png',
    desc: '逆浪：赛艇速度 -10%，道具弹道会小幅偏航',
    mods: { playerSpeedMul: 0.9 },
    aimSpread: 3,
  },
  blizzard: {
    id: 'blizzard', name: '白茫', icon: 'hex/blizzardWeather.png',
    desc: '白茫：视野大幅缩小，道具弹道明显偏航',
    mods: {},
    aimSpread: 6,
  },
  starry: {
    id: 'starry', name: '月光', icon: 'hex/starryWeather.png',
    desc: '月光：全队受到伤害 -10%，但道具弹道轻微偏航',
    mods: { playerTakenMul: 0.9 },
    aimSpread: 2,
  },
};

/** 弹道偏航按难度放大：普通 ×1 / 精英 ×1.25 / 噩梦 ×1.5 */
export const HEX_AIM_SPREAD_DIFF = { normal: 1, elite: 1.25, nightmare: 1.5 };

export function getHexWeatherEffect(id) {
  return HEX_WEATHER_EFFECTS[id] || null;
}

// ---------- P3 精英前缀（第 2 层起 40% 概率） ----------
// 只挂已有倍率位 + 复用一个已有 Effekseer 特效，不做新资产。
// frost 的减速在 BossMode.#damagePlayer 里挂；decay 的无敌在 #dealBossDamage 里拦。
export const HEX_PREFIX_CHANCE = 0.4;

export const HEX_PREFIXES = [
  {
    id: 'berserk', name: '狂暴的', icon: 'hex/berserk.png', fx: 'fxFireBurst',
    desc: '攻速 +25%，血量 -10%',
    mods: { bossCdMul: 0.8, bossHpMul: 0.9 },
  },
  {
    id: 'frost', name: '冰封的', icon: 'hex/frostPrefix.png', fx: 'fxIceMist',
    desc: '每次受击附带 2 秒减速',
    mods: {},
  },
  {
    id: 'greedy', name: '贪婪的', icon: 'hex/greedyPrefix.png', fx: 'ring',
    desc: '道具箱刷新更快，但伤害 +15%',
    mods: { boxRate: 0.67, bossDmgMul: 1.15 },
  },
  {
    id: 'decay', name: '腐朽的', icon: 'hex/decayPrefix.png', fx: 'ink',
    desc: '血量 -25%，但每 20 秒无敌 2 秒',
    mods: { bossHpMul: 0.75 },
    decayInvuln: { cd: 20, time: 2 },
  },
];

// ---------- P4 深渊变体（现有 4 头 BOSS 的暗色强化版） ----------
// 只做「改名 + 数值 + 借 1 个别人家的技能」，模型仍是原 BOSS 的 GLB，零新资产。
// 每头 BOSS 只对应一个变体；第 3 层起按层数递增概率出现，越深越常见。
export const HEX_VARIANT_CHANCE = 0.35;

export const HEX_VARIANTS = {
  dragon_deep: {
    id: 'abyss_deep', name: '深渊·噬海龙', title: '沉入无光之海的旧神', icon: 'hex/abyssDeep.png',
    fx: 'fxMagicDark', desc: '血量 +20% · 冷却 -15% · 借来「静电网」',
    mods: { bossHpMul: 1.2, bossCdMul: 0.85 }, borrowedSkill: 'gridThunder',
  },
  dragon_inferno: {
    id: 'abyss_inferno', name: '深渊·焚寂龙', title: '吞下整片火海的残骸', icon: 'hex/abyssInferno.png',
    fx: 'fxFireBall', desc: '伤害 +15% · 冷却 -10% · 借来「霜息」',
    mods: { bossDmgMul: 1.15, bossCdMul: 0.9 }, borrowedSkill: 'frostBreath',
  },
  knight_thunder: {
    id: 'abyss_knight', name: '深渊·断誓骑士', title: '被雷海吞没的守誓者', icon: 'hex/abyssKnight.png',
    fx: 'fxSwordStorm', desc: '血量 +15% · 移速 +10% · 借来「暗影触手」',
    mods: { bossHpMul: 1.15, bossSpeedMul: 1.1 }, borrowedSkill: 'shadowTendrils',
  },
  blood_nightmare: {
    id: 'abyss_nightmare', name: '深渊·渊眠之母', title: '在血月下产卵的梦魇', icon: 'hex/abyssNightmare.png',
    fx: 'fxMagicCircle', desc: '血量 +25% · 伤害 +10% · 借来「裂隙喷发」',
    mods: { bossHpMul: 1.25, bossDmgMul: 1.1 }, borrowedSkill: 'rift',
  },
  // 2026-11-22：新 BOSS 补上对应变体，否则它永远只是"深渊传令官"，
  // 其它 4 头都有深渊形态、层数越深越常见，唯独它没有会被读成"没做完"。
  // 借招选了 skills 里没人引用的「狂怒」(kind='buff')：不是新资产，
  // 也不和它自己的 7 招重复，正好把这张闲置技能表用起来。
  abyss_herald: {
    id: 'abyss_herald_x', name: '深渊·放逐传令官', title: '被自己的圣光逐出天门的宣判者', icon: 'hex/abyssHerald_512.png',
    fx: 'fxHerald', desc: '血量 +20% · 伤害 +12% · 借来「狂怒」',
    mods: { bossHpMul: 1.2, bossDmgMul: 1.12 }, borrowedSkill: 'rage',
  },
};

/** 按 BOSS 取它的深渊变体（plan 里只存变体 id，两端查表一致） */
/** 海克斯里用的 BOSS 立绘（不动 bosses.js 的 emoji，避免影响经典模式）
 *  2026-11-23：abyss_herald 换成 512² 重制版（旧的 128² 放到 76px 会糊） */
export const HEX_BOSS_PORTRAIT = {
  dragon_deep: 'hex/abyssDeep.png',
  dragon_inferno: 'hex/abyssInferno.png',
  knight_thunder: 'hex/abyssKnight.png',
  blood_nightmare: 'hex/abyssNightmare.png',
  abyss_herald: 'hex/abyssHerald_512.png',
};

export function getHexVariant(bossId, variantId) {
  if (!variantId) return null;
  const v = HEX_VARIANTS[bossId];
  return v && v.id === variantId ? v : null;
}

// ---------- P4 场地修饰（每 5 层） ----------
// 只追加「已有危险物 + 已有倍率位 + 一段已有 Effekseer」，不新建场景实体。
// 第 5/10/15… 层从池里抽一个，和本层词缀、天气叠在一起。
export const HEX_ARENAS = [
  {
    id: 'maelstrom', name: '漩涡深渊', icon: 'hex/maelstrom.png', fx: 'fxBigVortex',
    desc: '海面被巨涡撕开：船速 -7%，龙卷持续追人',
    hazardIds: ['vortex'], mods: { playerSpeedMul: 0.93 },
  },
  {
    id: 'glacier', name: '极寒浮冰', icon: 'hex/glacier.png', fx: 'fxIceMist',
    desc: '浮冰挤满航道：船速 -5%，BOSS 出手更慢',
    hazardIds: ['spike'], mods: { playerSpeedMul: 0.95, bossCdMul: 1.08 },
  },
  {
    id: 'reef', name: '暗礁坟场', icon: 'hex/reef.png', fx: 'fxWaterImpact',
    desc: '沉船残骸浮出海面：落石与尖刺同时出现',
    hazardIds: ['rockfall', 'spike'], mods: {},
  },
  {
    id: 'thundercloud', name: '雷云风暴', icon: 'hex/thundercloud.png', fx: 'fxBoltStorm',
    desc: '雷云压到海面：全场落雷，但全员伤害 +8%',
    hazardIds: ['thunder'], mods: { playerDmgMul: 1.08 },
  },
  {
    id: 'bloodmoon', name: '血月祭坛', icon: 'hex/bloodmoon.png', fx: 'fxMagicDark',
    desc: '血月当空：BOSS 伤害 +8%，但医疗包刷新更快',
    hazardIds: ['bloodmoon'], mods: { bossDmgMul: 1.08, healRate: 0.85 },
  },
];

// ---------- 场景道具（每关 4~5 件，纯确定性抽取） ----------
// 2026-11-22 用户要求：海克斯每关随机器具，让场地不再是同一套礁石。
// 只用项目里现成的 GLB / 带贴图模型，禁止程序化几何体；每关结构固定为
// 「1~2 件主玩法 + 2~3 件掩体/氛围」，主玩法从弹射跳台与浮标阵里抽。
// kind：ramp 弹射跳台（纯触发区，不挡路）/ buoys 浮标阵（可撞）/ solid 实体掩体 /
//       topper 摆在现有浮岩上的小雕塑（不新增碰撞）。
export const HEX_ARENA_PROP_DEFS = [
  {
    id: 'ramp', name: '弹射跳台', kind: 'ramp', model: '/models/launch_platform.glb',
    target: 8, r: 3.6, ring: [30, 46], launchVy: 7.4, boost: 0.9, minSpeed: 7,
  },
  {
    id: 'buoys', name: '浮标阵', kind: 'buoys', model: '/models/props/buoy_fallback.glb',
    target: 2.6, r: 5.2, ring: [26, 40], count: [4, 6],
  },
  {
    id: 'volcanic_pillar', name: '火山柱', kind: 'solid', model: '/models/magma/volcanic_pillar.glb',
    target: 8, r: 2.8, ring: [52, 68], y: -0.4,
  },
  {
    id: 'obsidian_shard', name: '黑曜石柱', kind: 'solid', model: '/models/magma/obsidian_shard.glb',
    target: 5.6, r: 2.6, ring: [50, 68], y: -0.5,
  },
  {
    id: 'lava_spikes', name: '熔岩尖岩', kind: 'solid', model: '/models/magma/lava_spikes.glb',
    target: 4.6, r: 2.8, ring: [48, 66], y: -0.6,
  },
  {
    id: 'rock_boulder', name: '海蚀礁石', kind: 'solid', model: '/models/rock_boulder.glb',
    target: 5.2, r: 2.8, ring: [44, 64], y: -0.45,
  },
  {
    id: 'old_boat', name: '废弃小船', kind: 'solid', model: '/models/old_boat.glb',
    target: 6.4, r: 2.4, ring: [46, 64], y: -0.25,
  },
  {
    id: 'shipwreck', name: '沉船残骸', kind: 'solid', model: '/models/shipwreck.glb',
    target: 6.5, r: 3.6, ring: [50, 68], y: -0.5,
  },
  {
    id: 'shell_sculpture', name: '贝壳石雕', kind: 'topper', model: '/models/decor/shell_sculpture.glb',
    target: 2.0,
  },
  {
    id: 'gull_statue', name: '海鸥石像', kind: 'topper', model: '/models/decor/gull_statue.glb',
    target: 1.6,
  },
];

// 每个场景主题（1 火山 / 2 珊瑚浅海 / 3 锈蚀港口 / 4 极夜冰海）的可选掩体与雕塑。
// 全部带贴图或至少是项目里已经在用的设计件，避免临时手搓几何体。
export const HEX_PROP_POOLS = {
  1: ['volcanic_pillar', 'obsidian_shard', 'lava_spikes', 'rock_boulder'],
  2: ['rock_boulder', 'old_boat', 'shell_sculpture', 'gull_statue'],
  3: ['old_boat', 'shipwreck', 'rock_boulder', 'gull_statue'],
  4: ['shipwreck', 'old_boat', 'rock_boulder', 'shell_sculpture'],
};

// ---------- 竞技场阵型（2026-11-23） ----------
// 每关从主题池里抽 1 个阵型替换掉默认礁石阵，让场地本身成为玩法的一部分。
// 全部使用项目现成 GLB（带贴图），不手搓几何体；落点由 seed 推导，两端一致。
// 阵型部件：solid 参与碰撞 / kelp 海草区不挡船但减速 / spikes 尖刺区（也扎 BOSS）/
//           launch 弹射台（高抛，空中免疫震地类）/ 漩涡只走水面着色器，不建模型。
export const HEX_FORMATION_PARTS = [
  // 海草堆：一个部件 = 一堆，BossArena 会在堆心周围撒 blades 株海草
  { id: 'kelp_clump', kind: 'kelp', model: '/models/hazards/hazard_kelp.glb', target: 6.5, r: 4.2, blades: 12 },
  { id: 'rock_extra', kind: 'solid', model: '/models/rock_boulder.glb', target: 8.5, r: 4.2, y: -0.5 },
  { id: 'dock', kind: 'solid', model: '/models/shore/dock_wood.glb', target: 8.0, r: 3.2, y: -0.35 },
  { id: 'rowboat', kind: 'solid', model: '/models/rowboat.glb', target: 5.2, r: 1.9, y: -0.2 },
  { id: 'skiff', kind: 'solid', model: '/models/skiff.glb', target: 5.6, r: 2.1, y: -0.2 },
  { id: 'wreck_ship', kind: 'solid', model: '/models/shipwreck.glb', target: 9.5, r: 4.2, y: -0.6 },
  { id: 'wreck_mary', kind: 'solid', model: '/models/mary_chalmers.glb', target: 10.0, r: 4.6, y: -0.6 },
  { id: 'wreck_viking', kind: 'solid', model: '/models/gislinge_viking_boat.glb', target: 10.0, r: 4.0, y: -0.55 },
  { id: 'wreck_yacht', kind: 'solid', model: '/models/frickies_yacht.glb', target: 9.0, r: 4.2, y: -0.5 },
  { id: 'ice_large', kind: 'solid', model: '/models/props/iceberg_large.glb', target: 9.0, r: 4.6, y: -0.8 },
  { id: 'ice_small', kind: 'solid', model: '/models/props/iceberg_small.glb', target: 5.6, r: 2.8, y: -0.6 },
  { id: 'pillar', kind: 'solid', model: '/models/magma/volcanic_pillar.glb', target: 8.0, r: 2.8, y: -0.4 },
  { id: 'shard', kind: 'solid', model: '/models/magma/obsidian_shard.glb', target: 5.6, r: 2.6, y: -0.5 },
  { id: 'spikes', kind: 'spikes', model: '/models/magma/lava_spikes.glb', target: 4.6, r: 3.0, y: -0.6 },
  {
    id: 'launcher', kind: 'launch', model: '/models/launch_platform.glb',
    target: 8.4, r: 4.0, launchVy: 12.5, boost: 1.0, minSpeed: 6.5,
  },
];

export const HEX_FORMATIONS = [
  { id: 'reef', name: '礁石阵', desc: '浮岩掩体挡水墙与射线', themes: [1, 2, 3, 4] },
  { id: 'kelp', name: '海草堆', desc: '穿过海草堆会半隐身：减速但减伤并断开 BOSS 锁定', themes: [2, 3] },
  { id: 'launcher', name: '弹射器阵', desc: '高抛腾空，躲开震地类技能', themes: [1, 2, 3, 4] },
  { id: 'whirlpool', name: '漩涡阵', desc: '顺流加速；把 BOSS 引进涡心减速掉血', themes: [1, 2, 3, 4] },
  { id: 'wreck', name: '沉船墓场', desc: '大型残骸掩体与窄航道', themes: [2, 3, 4] },
  { id: 'iceberg', name: '冰山阵', desc: '冰山挡技能，撞击更弹', themes: [4] },
  { id: 'volcano', name: '火山柱阵', desc: '柱林挡射线，尖刺双向掉血', themes: [1] },
];

// 主题池：只抽与当前海域相符的阵型，避免冰海里长珊瑚、火山里漂冰山。
export const HEX_FORMATION_POOLS = {
  1: ['reef', 'launcher', 'whirlpool', 'volcano'],
  2: ['reef', 'kelp', 'launcher', 'whirlpool', 'wreck'],
  3: ['reef', 'kelp', 'wreck', 'launcher', 'whirlpool'],
  4: ['reef', 'iceberg', 'whirlpool', 'launcher', 'wreck'],
};

// ---------- P4 深渊遗物（每 5 层自动获得，永久累积） ----------
// 只落在已有倍率位；一局里可以重复拿，但同类数值会乘算叠加。
export const HEX_RELICS = [
  { id: 'obsidian', name: '黑曜石锚', icon: 'hex/obsidian.png', desc: '全队受到伤害 -6%', mods: { takenMul: 0.94 } },
  { id: 'star', name: '星辰罗盘', icon: 'hex/starCompass.png', desc: '全队造成伤害 +6%', mods: { dmgMul: 1.06 } },
  { id: 'lantern', name: '幽光提灯', icon: 'hex/lantern.png', desc: '医疗包刷新间隔 -10%', mods: { healRate: 0.9 } },
  { id: 'horn', name: '深渊号角', icon: 'hex/horn.png', desc: 'BOSS 血量 -6%', mods: { bossHpMul: 0.94 } },
  { id: 'tear', name: '潮汐之泪', icon: 'hex/tear.png', desc: '船速 +5%，道具箱刷新间隔 -8%', mods: { playerSpeedMul: 1.05, boxRate: 0.92 } },
  { id: 'hourglass', name: '时砂', icon: 'hex/relicHourglass.png', desc: 'BOSS 出手更慢（冷却 +6%）', mods: { bossCdMul: 1.06 } },
];

// ---------- 本局核心（L0，开局三选一，全队共享） ----------
// 效果只走已经存在的倍率位：玩家伤害、玩家受伤、复活次数、开局道具。
export const HEX_CORES = [
  {
    id: 'pow', name: '火力狂欢', icon: 'hex/pow.png', desc: '全队造成伤害 +30%',
    mods: { dmgMul: 1.3 },
  },
  {
    id: 'steel', name: '钢铁洪流', icon: 'hex/steel.png', desc: '全队受到伤害 -25%',
    mods: { takenMul: 0.75 },
  },
  {
    id: 'rich', name: '富甲一方', icon: 'hex/rich.png', desc: '每关开局额外获得 1 个随机道具',
    mods: { starterItems: 1 },
  },
  // 2026-11-22 流派核心：开局三选一从 8 张里抽，5 张是"决定打法"的流派，
  // 3 张基础（火力/钢铁/祝福）保留给想稳一点的组合。
  {
    id: 'overload', name: '爆破·过载', icon: 'hex/overload.png', desc: '每用一件道具，下次主炮伤害 +15%，最多叠 3 层（5 秒不叠就清空）',
    mods: { overload: 1 },
  },
  {
    id: 'detonate', name: '爆破·殉爆', icon: 'hex/detonate.png', desc: '沉船瞬间对 BOSS 炸 200 伤害（配上逆流屏障＝炸完还能爬起来）',
    mods: { detonate: 200 },
  },
  {
    id: 'reflect', name: '铁壁·反伤', icon: 'hex/reflect.png', desc: '受击时反弹 20% 伤害给 BOSS',
    mods: { reflectPct: 0.2 },
  },
  {
    id: 'combo', name: '潮汐·连击', icon: 'hex/combo.png', desc: '连续命中叠 5% 伤害，上限 50%；2 秒没命中就清零',
    mods: { comboStackPct: 0.05 },
  },
  {
    id: 'rewind', name: '时间·回溯', icon: 'hex/rewind.png', desc: '时间锚触发时，额外把 BOSS 血条回退到 10 秒前',
    mods: { rewind: 1 },
  },
  {
    id: 'bless', name: '海神祝福', icon: 'hex/bless.png', desc: '每关开局回满血，且复活次数 +1',
    mods: { healFull: true, revive: 1 },
  },
];

// ---------- 关卡规则（L1，词缀） ----------
// tier 1 = 轻，2 = 重；negative 只用于过场卡标红。
// 所有字段都在 BossMode.startStage 里被换算成已有的 hp/dmg/cd/speed 倍率。
export const HEX_RULES = [
  {
    id: 'rage', name: '狂暴', icon: 'hex/rage.png', tier: 2, negative: true,
    desc: 'BOSS 出手更快（冷却 -25%），但血量 -20%',
    mods: { bossCdMul: 0.75, bossHpMul: 0.8 },
  },
  {
    id: 'regen', name: '再生', icon: 'hex/regen.png', tier: 2, negative: true,
    desc: 'BOSS 血量 +35%',
    mods: { bossHpMul: 1.35 },
  },
  {
    id: 'armor', name: '重甲', icon: 'hex/armorRule.png', tier: 2, negative: true,
    desc: 'BOSS 血量 +15%，全队伤害 -15%',
    mods: { bossHpMul: 1.15, playerDmgMul: 0.85 },
  },
  {
    id: 'venom', name: '瘴气', icon: 'hex/venom.png', tier: 1, negative: true,
    desc: '全队受到伤害 +15%，但医疗包刷新更快',
    mods: { playerTakenMul: 1.15, healRate: 0.7 },
  },
  {
    id: 'greed', name: '贪婪', icon: 'hex/greed.png', tier: 1, negative: false,
    desc: '道具箱刷新更快，但 BOSS 伤害 +15%',
    mods: { boxRate: 0.7, bossDmgMul: 1.15 },
  },
  {
    id: 'gale', name: '疾风', icon: 'hex/gale.png', tier: 1, negative: false,
    desc: 'BOSS 血量 +10%，但医疗包刷新更快',
    mods: { bossHpMul: 1.1, healRate: 0.75 },
  },
  {
    id: 'bloodrage', name: '血怒', icon: 'hex/bloodrage.png', tier: 2, negative: false,
    desc: '全队伤害 +25%，但受到伤害 +20%',
    mods: { playerDmgMul: 1.25, playerTakenMul: 1.2 },
  },
  {
    id: 'ironwall', name: '铁壁', icon: 'hex/ironwall.png', tier: 1, negative: false,
    desc: '全队受到伤害 -20%，但伤害 -10%',
    mods: { playerTakenMul: 0.8, playerDmgMul: 0.9 },
  },
  {
    id: 'fortune', name: '时来运转', icon: 'hex/fortune.png', tier: 1, negative: false,
    desc: '每关开局额外获得 1 个随机道具',
    mods: { starterItems: 1 },
  },
  {
    id: 'trial', name: '试炼', icon: 'hex/trial.png', tier: 2, negative: false,
    desc: '本关危险物 +2，但全队伤害 +15%',
    mods: { hazardAdd: 2, playerDmgMul: 1.15 },
  },
  // 第四批：新增轻规则 2 条 + 重规则 1 条（只使用已被 BossMode 消费的倍率位）
  {
    id: 'frenzy', name: '狂热', icon: 'hex/frenzy.png', tier: 1, negative: true,
    desc: '全队伤害 +12%，但受到伤害 +12%',
    mods: { playerDmgMul: 1.12, playerTakenMul: 1.12 },
  },
  {
    id: 'bounty', name: '悬赏', icon: 'hex/bounty.png', tier: 1, negative: false,
    desc: '每关开局额外获得 2 个随机道具，但伤害 -10%',
    mods: { starterItems: 2, playerDmgMul: 0.9 },
  },
  {
    id: 'colossus', name: '巨像', icon: 'hex/colossus.png', tier: 2, negative: true,
    desc: 'BOSS 血量 +30%，但出手更慢（冷却 +25%）',
    mods: { bossHpMul: 1.3, bossCdMul: 1.25 },
  },
];

// ---------- 危险物池（L4 静态部分） ----------
// cost 是预算消耗；high = 高伤害来源，每关最多 3 个（wild 强度）。
export const HEX_HAZARDS = [
  { id: 'lava', name: '熔岩雨', icon: 'hex/lava.png', cost: 2, high: true, desc: '场上持续落熔岩柱' },
  { id: 'thunder', name: '静电场', icon: 'hex/shockFeedback.png', cost: 2, high: true, desc: '定时全场落雷' },
  { id: 'vortex', name: '追踪漩涡', icon: 'hex/maelstrom.png', cost: 3, high: true, desc: '龙卷持续追人' },
  { id: 'heal', name: '医疗补给', icon: 'hex/healPack.png', cost: 1, high: false, desc: '医疗包刷新更快' },
  { id: 'boxes', name: '道具补给', icon: 'hex/supply.png', cost: 1, high: false, desc: '道具箱刷新更快' },
  // 第三批新增：复用熔岩柱的落点/伤害链路（kind 决定外观与节奏），不另起一套实体
  { id: 'rockfall', name: '落石雨', icon: 'hex/rockfall.png', cost: 2, high: true, kind: 'rockfall', desc: '场地随机砸落巨石' },
  { id: 'poison', name: '毒雾', icon: 'hex/poison.png', cost: 2, high: false, kind: 'poison', desc: '绿色毒雾持续腐蚀船体' },
  { id: 'spike', name: '尖刺阵', icon: 'hex/spike.png', cost: 2, high: true, kind: 'spike', desc: '海面突然刺出尖刺' },
  // 第四批：陨石雨（落点更少更重，Effekseer 陨石）/ 血月（纯数值危险物，不占落区）
  { id: 'meteor', name: '陨石雨', icon: 'hex/meteor.png', cost: 3, high: true, kind: 'meteor', desc: '陨石成片砸落，落点少但伤害更高' },
  { id: 'bloodmoon', name: '血月', icon: 'hex/bloodmoon.png', cost: 2, high: false, desc: 'BOSS 造成的伤害 +20%' },
];

// ---------- 局内随机事件（轻量版） ----------
// at = 开打后第几秒触发；每关抽 1~2 个。
export const HEX_EVENTS = [
  { id: 'airdrop', name: '空投补给', icon: 'hex/airdrop.png', desc: '随机空投医疗包' },
  { id: 'berserk', name: 'BOSS 暴走', icon: 'hex/berserk.png', desc: 'BOSS 攻速与伤害短暂提升' },
  { id: 'storm', name: '全场闪电', icon: 'hex/thundercloud.png', desc: '随机位置落下雷电' },
  { id: 'terrain', name: '熔岩地形', icon: 'hex/lava.png', desc: '场地随机喷发熔岩柱' },
  // 第四批：复用现有落区 / 道具栏，不新增系统
  { id: 'meteorshower', name: '陨石齐落', icon: 'hex/meteor.png', desc: '场地连续落下陨石' },
  { id: 'armory', name: '军械补给', icon: 'hex/armoryEvent.png', desc: '本机立即获得 1 个随机道具' },
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
  { id: 'pierce', name: '穿甲弹头', icon: 'hex/pierce.png', rarity: 'white', desc: '造成伤害 +15%', mods: { dmgMul: 1.15 } },
  { id: 'plate', name: '装甲板', icon: 'hex/plate.png', rarity: 'white', desc: '受到伤害 -12%', mods: { takenMul: 0.88 } },
  { id: 'supply', name: '开局补给', icon: 'hex/supply.png', rarity: 'white', desc: '每关开局额外获得 1 个随机道具', mods: { starterItems: 1 } },
  // 2026-11-22：换掉 5 张"只是数值不同"的白卡，改成真正改打法的机制卡
  { id: 'staggerHunter', name: '破韧猎手', icon: 'hex/staggerHunter.png', rarity: 'white', desc: 'BOSS 跪地窗口内，你的伤害额外 +60%', mods: { staggerBonus: 0.6 } },
  { id: 'armorPiercer', name: '破甲弹头', icon: 'hex/armorPiercer.png', rarity: 'white', desc: '无视 BOSS 正面装甲的减伤', mods: { pierceFront: 1 } },
  { id: 'itemEcho', name: '道具回响', icon: 'hex/itemEcho.png', rarity: 'white', desc: '每用一件道具，3 秒内主炮射速翻倍', mods: { itemEcho: 3 } },
  { id: 'shockFeedback', name: '雷击导引', icon: 'hex/shockFeedback.png', rarity: 'white', desc: '被雷击时向 BOSS 回放一道 30 伤害电弧', mods: { shockFeedback: 30 } },
  { id: 'ration', name: '战备口粮', icon: 'hex/ration.png', rarity: 'white', desc: '每关开局额外获得 1 个随机道具', mods: { starterItems: 1 } },
  { id: 'scout', name: '侦察改装', icon: 'hex/scout.png', rarity: 'white', desc: '造成伤害 +5%，受到伤害 -7%', mods: { dmgMul: 1.05, takenMul: 0.93 } },
  // —— 蓝（中等强度） ——
  { id: 'weak', name: '弱点猎手', icon: 'hex/weak.png', rarity: 'blue', desc: '造成伤害 +22%', mods: { dmgMul: 1.22 } },
  { id: 'critcore', name: '暴击核心', icon: 'hex/critcore.png', rarity: 'blue', desc: '造成伤害 +25%', mods: { dmgMul: 1.25 } },
  { id: 'patch', name: '应急修复', icon: 'hex/patch.png', rarity: 'blue', desc: '受到伤害 -18%', mods: { takenMul: 0.82 } },
  { id: 'quartermaster', name: '军需官', icon: 'hex/quartermaster.png', rarity: 'blue', desc: '每关开局额外获得 2 个随机道具', mods: { starterItems: 2 } },
  { id: 'composite', name: '复合装甲', icon: 'hex/composite.png', rarity: 'blue', desc: '受到伤害 -22%', mods: { takenMul: 0.78 } },
  { id: 'sharpshooter', name: '神射手', icon: 'hex/sharpshooter.png', rarity: 'blue', desc: '造成伤害 +28%', mods: { dmgMul: 1.28 } },
  { id: 'veteran', name: '老兵经验', icon: 'hex/veteran.png', rarity: 'blue', desc: '造成伤害 +20%，受到伤害 -8%', mods: { dmgMul: 1.2, takenMul: 0.92 } },
  { id: 'reserve', name: '备件箱', icon: 'hex/reserve.png', rarity: 'blue', desc: '每关开局额外获得 2 个随机道具', mods: { starterItems: 2 } },
  { id: 'lowHpFury', name: '残血狂热', icon: 'hex/lowHpFury.png', rarity: 'blue', desc: '血量低于 35% 时，伤害 +80%', mods: { lowHpBonus: 0.8 } },
  { id: 'lastStand', name: '逆流屏障', icon: 'hex/lastStand.png', rarity: 'blue', desc: '本局第一次沉船时，原地免死并回 30% 血', mods: { lastStand: 0.3 } },
  // —— 金（稀有，高收益往往带代价） ——
  { id: 'neptune', name: '海神庇佑', icon: 'hex/neptune.png', rarity: 'gold', desc: '立刻获得 1 次额外复活', mods: { revive: 1 } },
  { id: 'bloodrage', name: '血怒', icon: 'hex/bloodrage.png', rarity: 'gold', desc: '造成伤害 +40%，但受到伤害 +25%', mods: { dmgMul: 1.4, takenMul: 1.25 } },
  { id: 'glasscannon', name: '玻璃大炮', icon: 'hex/glasscannon.png', rarity: 'gold', desc: '造成伤害 +50%，但受到伤害 +20%', mods: { dmgMul: 1.5, takenMul: 1.2 } },
  { id: 'berserk', name: '狂战核心', icon: 'hex/berserk.png', rarity: 'gold', desc: '造成伤害 +55%，但受到伤害 +30%', mods: { dmgMul: 1.55, takenMul: 1.3 } },
  { id: 'aegis', name: '神盾', icon: 'hex/aegis.png', rarity: 'gold', desc: '受到伤害 -32%，但造成伤害 -10%', mods: { takenMul: 0.68, dmgMul: 0.9 } },
];

// ---------- 跨体系联动（2026-11-22）----------
// 关卡规则 / BOSS 前缀 / 天气 / 危险物 / 场地修饰 / 核心 各自独立随机，
// 这里让它们"撞在一起"时额外产生一个效果 —— 玩家不用额外操作，进关就能感觉到彩蛋。
// when 里写的键全部命中才算触发；mods 走和卡牌/词缀同一套倍率位。
export const HEX_SYNERGIES = [
  {
    id: 'frostSupply', name: '寒霜补给', icon: 'hex/frostSupply.png',
    desc: '贪婪 × 冰封的：开道具箱附赠 1 秒护盾',
    when: { rule: 'greed', prefix: 'frost' }, mods: { boxShield: 1 },
  },
  {
    id: 'bulwark', name: '堡垒', icon: 'hex/bulwark.png',
    desc: '巨像 × 铁壁：BOSS 血 +30%，但每 20 秒露 3 秒破甲窗口',
    when: { rule: 'colossus', rule2: 'ironwall' }, mods: { bossHpMul: 1.3, staggerWindow: 3 },
  },
  {
    id: 'stormConductor', name: '雷云导体', icon: 'hex/stormConductor.png',
    desc: '逆浪 × 静电场：落雷半径 +40%，雷击后地面留 3 秒导电区',
    when: { weather: 'storm', hazard: 'thunder' }, mods: { thunderRadiusAdd: 0.4, conductT: 3 },
  },
  {
    id: 'plague', name: '瘟疫', icon: 'hex/plague.png',
    desc: '腐朽的 × 毒雾：毒雾每跳同时腐蚀 BOSS 1% 最大血',
    when: { prefix: 'decay', hazard: 'poison' }, mods: { poisonBossDot: 0.01 },
  },
  {
    id: 'maelstromFrost', name: '霜涡', icon: 'hex/maelstromFrost.png',
    desc: '漩涡深渊 × 冰封的：被龙卷拖拽时额外减速 2 秒',
    when: { arena: 'maelstrom', prefix: 'frost' }, mods: { vortexSlow: 2 },
  },
  {
    id: 'firstAid', name: '先遣补给', icon: 'hex/firstAid.png',
    desc: '富甲一方 × 时来运转：第一件开局道具自带一次免伤',
    when: { core: 'rich', rule: 'fortune' }, mods: { firstItemInvuln: 1 },
  },
  {
    id: 'reefBounty', name: '礁场悬赏', icon: 'hex/reefBounty.png',
    desc: '试炼 × 暗礁坟场：危险物 +2，但每次命中后给 1 秒无敌',
    when: { rule: 'trial', arena: 'reef' }, mods: { hazardPostInvuln: 1 },
  },
  {
    id: 'blindMeteor', name: '盲陨', icon: 'hex/blindMeteor.png',
    desc: '白茫 × 陨石雨：视野更暗，但陨石落点提前 1.5 秒亮预警圈',
    when: { weather: 'blizzard', hazard: 'meteor' }, mods: { meteorWarnAdd: 1.5 },
  },
  {
    id: 'berserkClash', name: '狂潮', icon: 'hex/berserkClash.png',
    desc: '狂暴的 × 狂暴：BOSS 冷却再 -15%，但每次出招后硬直 2 秒',
    when: { prefix: 'berserk', rule: 'rage' }, mods: { bossCdMul: 0.85, castRecovery: 2 },
  },
  {
    id: 'tideMoon', name: '静月', icon: 'hex/tideMoon.png',
    desc: '时砂 × 月光：BOSS 出手更慢，你们受伤再 -5%',
    when: { relic: 'hourglass', weather: 'starry' }, mods: { bossCdMul: 1.06, takenMul: 0.95 },
  },
];

/**
 * 从本关数据里找出所有生效的联动。
 * 不动用随机数：所有输入都来自 buildRunPlan 的确定性计划，两端算出的结果天然一致。
 */
export function matchHexSynergies(entry, coreId, relicIds = []) {
  if (!entry) return [];
  const out = [];
  for (const s of HEX_SYNERGIES) {
    const w = s.when || {};
    if (w.rule && !(entry.rules || []).includes(w.rule)) continue;
    if (w.rule2 && !(entry.rules || []).includes(w.rule2)) continue;
    if (w.prefix && entry.prefix !== w.prefix) continue;
    if (w.weather && entry.weather !== w.weather) continue;
    if (w.hazard && !(entry.hazards || []).some((h) => h.id === w.hazard)) continue;
    if (w.arena && entry.arena !== w.arena) continue;
    if (w.core && coreId !== w.core) continue;
    if (w.relic && !(relicIds || []).includes(w.relic)) continue;
    out.push(s);
  }
  return out;
}

const HAZARD_BUDGET = [3, 4, 5, 6, 7, 9, 11];

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
function rollRules(rng, count, lightOnly = false) {
  const light = HEX_RULES.filter((r) => r.tier === 1);
  const heavy = lightOnly ? [] : HEX_RULES.filter((r) => r.tier === 2);
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
function rollHazards(rng, budget, highLimit = 3) {
  const out = [];
  let left = budget;
  let high = 0;
  let guard = 0;
  while (left > 0 && guard++ < 24) {
    const pool = HEX_HAZARDS.filter((h) => h.cost <= left
      && !out.some((o) => o.id === h.id)
      && (!h.high || high < highLimit));
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
  // 前 4 层最多 1 个事件，第 3 层起才有；第 5 层起恢复 1~2 个
  const count = stage >= 5 ? 2 : (stage >= 3 ? 1 : 0);
  const picked = pickMany(rng, HEX_EVENTS, count);
  return picked.map((e, i) => ({
    id: e.id,
    at: Math.round(24 + rng() * 20 + i * (30 + rng() * 20)),
  }));
}

/**
 * 本关场景道具：阵型是主体，这里只补 2~3 件小道具做点缀。
 * 用独立的 rng（seed ^ stage）抽取，不消耗主随机流 ——
 * 这样无尽续层重算计划时，前面各层的词缀/天气/道具一件都不会变。
 */
function rollHexProps(rng, themeStage, stage) {
  // 2026-11-23 用户反馈"道具太少感觉不到效果"：点缀道具 2~3 → 3~5 件
  const total = 3 + (rng() < 0.5 ? 1 : 0) + (rng() < 0.5 ? 1 : 0);
  const mains = ['ramp', 'buoys'];
  // 主玩法最多 1 件；第 3 层起偶尔跳台 + 浮标一起上（占满 2 个名额）
  const both = total >= 3 && rng() < (stage >= 3 ? 0.3 : 0.12);
  const ids = both ? mains.slice() : [mains[rng() < 0.5 ? 0 : 1]];
  const pool = shuffle(rng, HEX_PROP_POOLS[themeStage] || HEX_PROP_POOLS[2]);
  for (const id of pool) {
    if (ids.length >= total || ids.length >= 5) break;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.map((id) => ({ id }));
}

const HEX_PROP_MAP = new Map(HEX_ARENA_PROP_DEFS.map((p) => [p.id, p]));

/**
 * 场景道具落点（纯函数，无 three 依赖，可在 Node 里无头验收）。
 * 规则：远离出生线、BOSS 中心、浮岩、漩涡、道具箱与栅栏；同批道具互不重叠。
 * 位置只依赖 seed 与传入的浮岩布局，房主客机各算一遍即可，不需要同步消息。
 */
export function planHexPropPlacements(specs, seed, ctx = {}) {
  const rng = makeRng((seed >>> 0) || 1);
  const rocks = ctx.rocks || [];
  const whirlpools = ctx.whirlpools || [];
  const itemSpots = ctx.itemSpots || [];
  const fenceRadius = ctx.fenceRadius || 87;
  const spawnZ = ctx.spawnZ ?? 40;
  const used = [];
  const takenRocks = new Set();
  const out = [];

  const spotFree = (x, z, r) => {
    const dist = Math.hypot(x, z);
    if (dist + r + 6 > fenceRadius) return false;
    if (dist < 20 + r) return false;
    for (const rock of rocks) {
      if (Math.hypot(x - rock.x, z - rock.z) < rock.r + r + 3) return false;
    }
    for (const w of whirlpools) {
      if (Math.hypot(x - w.x, z - w.z) < w.r + r + 2) return false;
    }
    for (const s of itemSpots) {
      if (Math.hypot(x - s.x, z - s.z) < r + 4) return false;
    }
    for (const u of used) {
      if (Math.hypot(x - u.x, z - u.z) < u.r + r + 4) return false;
    }
    for (let sx = -22; sx <= 22; sx += 11) {
      if (Math.hypot(x - sx, z - spawnZ) < r + 8) return false;
    }
    return true;
  };

  for (const raw of specs) {
    const spec = HEX_PROP_MAP.get(raw.id);
    if (!spec) continue;
    if (spec.kind === 'topper') {
      const pool = [];
      for (let i = 0; i < rocks.length; i++) {
        if (rocks[i].r >= 3.2 && !takenRocks.has(i)) pool.push(i);
      }
      if (!pool.length) continue;
      const idx = pool[Math.floor(rng() * pool.length)];
      takenRocks.add(idx);
      out.push({ spec, kind: 'topper', rock: rocks[idx] });
      continue;
    }
    const [r0, r1] = spec.ring || [40, 66];
    let spot = null;
    for (let i = 0; i < 80 && !spot; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = r0 + rng() * (r1 - r0);
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      if (spotFree(x, z, spec.r)) spot = { x, z, ang };
    }
    // 兜底：沿整圈扫一遍，仍找不到就跳过，绝不叠着放
    if (!spot) {
      const rad = (r0 + r1) * 0.5;
      for (let i = 0; i < 48; i++) {
        const ang = (i / 48) * Math.PI * 2;
        const x = Math.cos(ang) * rad;
        const z = Math.sin(ang) * rad;
        if (spotFree(x, z, spec.r)) { spot = { x, z, ang }; break; }
      }
    }
    if (!spot) continue;
    used.push({ x: spot.x, z: spot.z, r: spec.r });
    // 跳台沿场地切向摆：绕 BOSS 跑图时正好从正面压过去
    const ry = spec.kind === 'ramp' ? -spot.ang : rng() * Math.PI * 2;
    const count = spec.kind === 'buoys'
      ? Math.round(spec.count[0] + rng() * (spec.count[1] - spec.count[0]))
      : 0;
    out.push({ spec, kind: spec.kind, x: spot.x, z: spot.z, ry, count });
  }
  return out;
}

/**
 * 阵型落点（纯函数，无 three 依赖）：只依赖阵型 id 与 seed。
 * 规则与道具一致：避开出生线、BOSS 中心（15m 内）、道具箱、栅栏，部件之间不重叠。
 * 返回 parts（实体/海草/尖刺/弹射台）与 whirlpools（水面漩涡，仅着色器表现）。
 */
export function planHexFormation(id, seed, ctx = {}) {
  const def = typeof id === 'string' ? HEX_FORMATIONS.find((f) => f.id === id) : id;
  if (!def) return null;
  const rng = makeRng(((seed >>> 0) ^ 0x5f356495) || 1);
  const fenceRadius = ctx.fenceRadius || 87;
  const spawnZ = ctx.spawnZ ?? 40;
  const itemSpots = ctx.itemSpots || [];
  const rocks = ctx.rocks || [];
  const used = [];
  const parts = [];
  const whirlpools = [];

  const spotFree = (x, z, r, pad = 4) => {
    const dist = Math.hypot(x, z);
    if (dist + r + 6 > fenceRadius) return false;
    if (dist < 15 + r) return false;
    for (const rock of rocks) {
      if (Math.hypot(x - rock.x, z - rock.z) < rock.r + r + 3) return false;
    }
    for (const w of whirlpools) {
      if (Math.hypot(x - w.x, z - w.z) < w.r + r + 2) return false;
    }
    for (const s of itemSpots) {
      if (Math.hypot(x - s.x, z - s.z) < r + 4) return false;
    }
    for (const u of used) {
      if (Math.hypot(x - u.x, z - u.z) < u.r + r + pad) return false;
    }
    for (let sx = -22; sx <= 22; sx += 11) {
      if (Math.hypot(x - sx, z - spawnZ) < r + 9) return false;
    }
    return true;
  };

  const placePart = (partId, ring, opts = {}) => {
    const spec = HEX_FORMATION_PART_MAP.get(partId);
    if (!spec) return null;
    const r = opts.r ?? spec.r;
    let spot = null;
    for (let i = 0; i < 70 && !spot; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = ring[0] + rng() * (ring[1] - ring[0]);
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      if (spotFree(x, z, r, opts.pad ?? 4)) spot = { x, z, ang };
    }
    if (!spot) {
      const rad = (ring[0] + ring[1]) * 0.5;
      for (let i = 0; i < 48; i++) {
        const ang = (i / 48) * Math.PI * 2;
        const x = Math.cos(ang) * rad;
        const z = Math.sin(ang) * rad;
        if (spotFree(x, z, r, opts.pad ?? 4)) { spot = { x, z, ang }; break; }
      }
    }
    if (!spot) return null;
    used.push({ x: spot.x, z: spot.z, r });
    // 弹射台沿切向摆，绕场跑图时正好从正面压上去
    const ry = spec.kind === 'launch' ? -spot.ang : rng() * Math.PI * 2;
    const entry = { partId: spec.id, kind: spec.kind, x: spot.x, z: spot.z, ry, r };
    parts.push(entry);
    return entry;
  };

  const placeWhirlpool = () => {
    const r = 8 + rng() * 2.4;
    for (let i = 0; i < 60; i++) {
      const ang = rng() * Math.PI * 2;
      const rad = 26 + rng() * 30;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      if (!spotFree(x, z, r, 2)) continue;
      used.push({ x, z, r });
      whirlpools.push({ x, z, r, spin: rng() < 0.5 ? -1 : 1 });
      return;
    }
  };

  switch (def.id) {
    case 'reef':
      // 沿用现有浮岩布局，再补 3 块带贴图的礁石，让掩体密度明显提高
      for (let i = 0; i < 3; i++) placePart('rock_extra', [22, 52], { pad: 5 });
      break;
    case 'kelp': {
      // 10 个海草堆（每堆 12 株），再配 2 座木栈桥 + 2 条小船
      for (let i = 0; i < 10; i++) placePart('kelp_clump', [26, 66], { pad: 3 });
      placePart('dock', [38, 62]);
      placePart('dock', [38, 62]);
      placePart('rowboat', [34, 62]);
      placePart('skiff', [34, 62]);
      break;
    }
    case 'launcher': {
      for (let i = 0; i < 6; i++) placePart('launcher', [34, 58], { pad: 6 });
      break;
    }
    case 'whirlpool': {
      for (let i = 0; i < 7; i++) placeWhirlpool();
      break;
    }
    case 'wreck': {
      placePart('wreck_mary', [34, 60], { pad: 6 });
      placePart('wreck_viking', [34, 60], { pad: 6 });
      placePart('wreck_yacht', [36, 62], { pad: 6 });
      placePart('wreck_ship', [36, 62], { pad: 6 });
      for (let i = 0; i < 6; i++) placePart(i % 2 ? 'skiff' : 'rowboat', [30, 62]);
      break;
    }
    case 'iceberg': {
      for (let i = 0; i < 6; i++) placePart('ice_large', [30, 64], { pad: 5 });
      for (let i = 0; i < 6; i++) placePart('ice_small', [28, 66], { pad: 4 });
      break;
    }
    case 'volcano': {
      for (let i = 0; i < 5; i++) placePart('pillar', [30, 66]);
      for (let i = 0; i < 5; i++) placePart('shard', [28, 66]);
      for (let i = 0; i < 3; i++) placePart('spikes', [30, 60]);
      break;
    }
    default:
      break;
  }

  return { id: def.id, name: def.name, desc: def.desc, parts, whirlpools };
}

const HEX_FORMATION_PART_MAP = new Map(HEX_FORMATION_PARTS.map((p) => [p.id, p]));

/**
 * BOSS 连招：从本关技能子集里派生 1~2 组两连击。
 * 同一张技能卡只会出现在一组连招里，避免一招被反复"白嫖"。
 * label 预先拼好，过场/UI 不需要再认识 BOSS_SKILLS。
 */
function rollCombos(rng, stage, skills) {
  // 前 4 层最多 1 组连招；第 5 层起恢复原有节奏
  const count = stage < 5 ? (stage >= 3 ? 1 : (rng() < 0.5 ? 1 : 0)) : (stage >= 3 ? (rng() < 0.65 ? 2 : 1) : (rng() < 0.5 ? 1 : 2));
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

// 同名卡最多叠 3 张（PRD 3.2.2 叠加上限）：无尽模式层数够多时卡池会被抽干，
// 有上限的重复抽取才能让构筑继续成长，同时避免无限叠同一条属性。
export const HEX_CARD_MAX_STACKS = 3;

/** 预算之外再追加 N 个不同危险物（「试炼」规则）：高伤来源仍不超过 3 个 */
function addExtraHazards(rng, hazards, count, highLimit = 3) {
  let high = hazards.filter((o) => HEX_HAZARDS.find((h) => h.id === o.id)?.high).length;
  for (let i = 0; i < count; i++) {
    const pool = HEX_HAZARDS.filter((h) => !hazards.some((o) => o.id === h.id)
      && (!h.high || high < highLimit));
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
  // 5 头 BOSS 环上取连续 4 头：一局内不重复、每局随机漏掉 1 头。
  // 起点随机（而不是固定从最弱的开始），避免第 1 层永远是同一头。
  const order = HEX_BOSS_ORDER.slice();
  const startAt = Math.floor(rng() * order.length);
  const rotated = order.map((_, i) => order[(startAt + i) % order.length]);
  // 轮转只覆盖前 4 层；池子比层数多时按层数截断，池子更少时退化成全体循环
  const rotateSlots = Math.min(HEX_START_BOSS_SLOTS, rotated.length);
  const count = Math.max(1, Math.floor(stageCount) || 4);
  const stages = [];
  for (let i = 0; i < count; i++) {
    const stage = i + 1;
    // 前 4 层取环上的连续 4 头；第 5 层起完全随机，无尽天梯不设固定循环
    const bossId = stage <= rotateSlots
      ? rotated[stage - 1]
      : pickOne(rng, HEX_ENDLESS_BOSSES);
    // 危险评级按 BOSS 原本属于第几关：新 BOSS 追加在池尾，natural 是 5 星
    const originStage = HEX_BOSS_ORDER.indexOf(bossId) + 1 || BOSS_DANGER_MAX;
    // 层数越高词缀越多：第 1~2 层 1 条、第 3~4 层 2 条、第 5 层起 3 条（PRD P4）
    // 前 4 层：最多 2 条轻词缀；第 5 层起恢复 1/2/3 条的完整曲线
    const ruleCount = stage < 5 ? Math.min(2, 1 + Math.floor((stage - 1) / 2))
      : Math.min(3, 1 + Math.floor((stage - 1) / 2));
    const rules = rollRules(rng, ruleCount, stage < 5);
    const hazardAdd = rules.reduce(
      (sum, id) => sum + (HEX_RULES.find((r) => r.id === id)?.mods?.hazardAdd || 0), 0,
    );
    const budget = HAZARD_BUDGET[Math.min(i, HAZARD_BUDGET.length - 1)];
    // 前 4 层高风险危险物最多 1 个；第 5 层起恢复 3 个
    const highLimit = stage < 5 ? 1 : 3;
    const hazards = addExtraHazards(rng, rollHazards(rng, budget, highLimit), hazardAdd, highLimit);
    // P4：每 5 层场地修饰 —— 把它的危险物直接塞进本层列表（不重复），
    // 数值在 BossMode 里和词缀一起合并；外观只播一段已有 Effekseer。
    const arena = stage % 5 === 0 ? pickOne(rng, HEX_ARENAS) : null;
    for (const id of arena?.hazardIds || []) {
      if (!hazards.some((h) => h.id === id)) hazards.push({ id });
    }
    // 每 3 层插一个"静水层"：无危险物、BOSS 出手慢 20%，给玩家喘口气（每 5 层主题关优先）
    const quiet = stage % 3 === 0 && !arena;
    if (quiet) hazards.length = 0;
    // 主题关的天气跟着场地走，强化"这一关有主题"的读感
    const themeWeather = arena ? ({
      maelstrom: 'storm', glacier: 'blizzard', reef: 'dusk',
      thundercloud: 'storm', bloodmoon: 'starry',
    }[arena.id] || null) : null;
    // L2：本关技能子集（顺序也随机，进关后轮转出招）
    let skills = shuffle(rng, BOSSES[bossId].skills.slice()).slice(0, HEX_SKILL_COUNT);
    // 2026-11-22：召唤怪物（kind='gate'）和龙卷风都太难 ——
    //   ① 第 1~4 层只允许普通 BOSS 技能，抽到召唤门就换成同 BOSS 的其它技能；
    //   ② 第 5 层起两者都放开，但**同一层只能有其中一个**（优先保留召唤门）。
    const hasSummon = skills.some((id) => BOSS_SKILLS[id]?.kind === 'gate');
    if (stage < HEX_HARD_MECH_MIN_STAGE && hasSummon) {
      skills = skills.filter((id) => BOSS_SKILLS[id]?.kind !== 'gate');
      const fill = shuffle(rng, BOSSES[bossId].skills.filter(
        (id) => !skills.includes(id) && BOSS_SKILLS[id]?.kind !== 'gate',
      ));
      while (skills.length < HEX_SKILL_COUNT && fill.length) skills.push(fill.shift());
    }
    if (stage < HEX_HARD_MECH_MIN_STAGE || hasSummon) {
      for (let k = hazards.length - 1; k >= 0; k--) {
        if (hazards[k].id === 'vortex') hazards.splice(k, 1);
      }
    }
    // P4 深渊变体：第 3 层起出现，层数越高概率越大（上限 70%）。
    // 变体会借来另一头 BOSS 的 1 个技能，所以技能数变 6；模型/动作仍是原 BOSS。
    const variant = stage >= 5 && rng() < Math.min(0.7, HEX_VARIANT_CHANCE + (stage - 5) * 0.05)
      ? HEX_VARIANTS[bossId]
      : null;
    if (variant?.borrowedSkill && !skills.includes(variant.borrowedSkill)) {
      skills.push(variant.borrowedSkill);
      // 借招发生在上面的互斥筛选之后：万一借来的是召唤门，也必须把本层漩涡再收一次，
      // 否则计划生成阶段就会留下「门 + 龙卷」同层（2026-11-24 修复）。
      if (BOSS_SKILLS[variant.borrowedSkill]?.kind === 'gate') {
        for (let k = hazards.length - 1; k >= 0; k--) {
          if (hazards[k].id === 'vortex') hazards.splice(k, 1);
        }
      }
    }
    // L3：场景主题（1~4 关的美术布景）与天气各自独立随机
    const themeStage = 1 + Math.floor(rng() * 4);
    // 场景道具用独立随机流，避免影响主序列（续层重算时前几层保持一致）
    const props = rollHexProps(
      makeRng((seed ^ Math.imul(stage, 0x27d4eb2d)) >>> 0), themeStage, stage,
    );
    // 阵型同样走独立随机流；连续两层不抽同一个，避免整局都是同一套场地
    const formationRng = makeRng((seed ^ Math.imul(stage, 0x1f123bb5)) >>> 0);
    const formationPool = HEX_FORMATION_POOLS[themeStage] || HEX_FORMATION_POOLS[2];
    let formation = pickOne(formationRng, formationPool);
    const prevFormation = stages[stages.length - 1]?.formation;
    if (prevFormation && formation === prevFormation) {
      const alt = formationPool.filter((id) => id !== prevFormation);
      if (alt.length) formation = pickOne(formationRng, alt);
    }
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
      themeStage,
      // 每关 2~3 件点缀小道具；场地主体由 formation 阵型决定
      props,
      formation,
      weather: themeWeather || pickOne(rng, HEX_WEATHERS),
      quiet,
      // P3 精英前缀：第 2 层起 40% 概率带一个（数值 + 复用一个已有 Effekseer 特效）
      // 精英前缀从第 5 层才开始，前 4 层只打普通 BOSS
      prefix: stage >= 5 && rng() < HEX_PREFIX_CHANCE
        ? pickOne(rng, HEX_PREFIXES).id
        : null,
      // P4：深渊变体 / 场地修饰 / 深渊遗物（每 5 层自动给 1 个）
      variant: variant?.id || null,
      arena: arena?.id || null,
      relic: stage % 5 === 0 ? pickOne(rng, HEX_RELICS).id : null,
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

/**
 * 运行时兜底：把一层计划里的「重机制」按层数重新收一遍。
 *
 * buildRunPlan 生成时已经筛过，但计划和运行时之间还有几条能绕过它的路：
 *   · 旧页面里已经算好的 hexPlan（改完代码没刷新）；
 *   · 无尽续层时按同一 seed 延长计划；
 *   · BOSS 自带的关卡机制不看计划（第 1 关的龙自带追人龙卷，被排到第 2 层就会跟过来）。
 * 这里只做纯数据裁剪，两端算出的结果一致，不会造成主机/客机不同步。
 *
 * 规则：层数 < HEX_HARD_MECH_MIN_STAGE 时去掉召唤门技能与龙卷危险物；
 *       同层有召唤门时也去掉龙卷（两者不能同时）。
 */
export function sanitizeHexEntry(entry) {
  if (!entry) return entry;
  const stage = entry.stage || 0;
  const isGate = (id) => BOSS_SKILLS[id]?.kind === 'gate';
  const skills = (entry.skills || []).filter(
    (id) => stage >= HEX_HARD_MECH_MIN_STAGE || !isGate(id),
  );
  const hasGate = skills.some(isGate);
  const dropVortex = stage < HEX_HARD_MECH_MIN_STAGE || hasGate;
  const hazards = dropVortex
    ? (entry.hazards || []).filter((h) => h.id !== 'vortex')
    : (entry.hazards || []);
  const skillsChanged = skills.length !== (entry.skills || []).length;
  const hazardsChanged = hazards.length !== (entry.hazards || []).length;
  if (!skillsChanged && !hazardsChanged) return entry;
  // 连招是从技能子集派生出来的，技能被裁掉时不能留下引用了空技能的连招
  const combos = (entry.combos || []).filter((c) => (c.skills || []).every((id) => skills.includes(id)));
  return { ...entry, skills, hazards, combos };
}

/** 合并一组规则/核心的数值加成（乘法叠乘，加法相加） */
// 2026-11-22：机制卡 / 流派核心 / 跨体系联动新增的"计数类"字段。
// 它们必须走加法（默认 0），不能像倍率那样默认 1 相乘，否则 overload=1 会把伤害翻一倍。
export const HEX_ADD_KEYS = new Set([
  'starterItems', 'revive', 'hazardAdd',
  // 卡牌 / 核心
  'overload', 'detonate', 'reflectPct', 'comboStackPct', 'rewind',
  'staggerBonus', 'lowHpBonus', 'pierceFront', 'itemEcho', 'shockFeedback', 'lastStand',
  // 跨体系联动
  'boxShield', 'staggerWindow', 'thunderRadiusAdd', 'conductT',
  'poisonBossDot', 'vortexSlow', 'firstItemInvuln', 'hazardPostInvuln',
  'meteorWarnAdd', 'castRecovery', 'quietLayer',
]);

export function mergeMods(ids, pool) {
  const out = {
    bossHpMul: 1, bossDmgMul: 1, bossCdMul: 1, bossSpeedMul: 1,
    playerDmgMul: 1, playerTakenMul: 1, playerSpeedMul: 1,
    healRate: 1, boxRate: 1, starterItems: 0, revive: 0,
    dmgMul: 1, takenMul: 1, healFull: false, hazardAdd: 0,
  };
  for (const k of HEX_ADD_KEYS) out[k] = 0;
  for (const id of ids || []) {
    const def = pool.find((x) => x.id === id);
    if (!def?.mods) continue;
    for (const [k, v] of Object.entries(def.mods)) {
      if (typeof v === 'boolean') out[k] = out[k] || v;
      else if (HEX_ADD_KEYS.has(k)) out[k] += v;
      else out[k] *= v;
    }
  }
  return out;
}

export const hexDefs = {
  HEX_CORES, HEX_RULES, HEX_HAZARDS, HEX_EVENTS, HEX_CARDS, HEX_PREFIXES,
  HEX_VARIANTS, HEX_ARENAS, HEX_RELICS,
};

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
      else if (HEX_ADD_KEYS.has(k)) out[k] += v;
      else out[k] *= v;
    }
  }
  return out;
}
