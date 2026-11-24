// 怪物模式（打 BOSS）数据表
// 关卡 / BOSS / 技能 / 小怪 / 难度 / 竞技场
// 所有数值集中在这里，便于策划直接调参。

// 房间最多容纳的真人玩家数
export const BOSS_MAX_PLAYERS = 4;
// 每人可用的复活次数
export const BOSS_REVIVES = 1;

// ---------- 难度 ----------
export const BOSS_DIFFICULTIES = [
  { id: 'normal', name: '普通', icon: '⚔️', hpScale: 1.0, dmgScale: 1.0, summonDelta: 0, cdScale: 1.0 },
  { id: 'elite', name: '精英', icon: '🔥', hpScale: 1.2, dmgScale: 1.15, summonDelta: 0, cdScale: 0.9 },
  { id: 'nightmare', name: '噩梦', icon: '💀', hpScale: 1.35, dmgScale: 1.3, summonDelta: 1, cdScale: 0.8 },
];

export function getBossDifficulty(id) {
  return BOSS_DIFFICULTIES.find((d) => d.id === id) || BOSS_DIFFICULTIES[0];
}

// ---------- 玩家生存参数 ----------
export const PLAYER_MAX_HP = 100;
// 沉船后的“可被救援”窗口：队友 6 秒内开船靠近就能原地救起，
// 没人来才消耗一次复活次数自动复活。
export const PLAYER_RESCUE_WINDOW = 6;
export const PLAYER_INVULN_TIME = 2.5;     // 复活后的无敌时间（秒）
export const BOSS_HIT_KNOCKBACK = 9;       // 被 BOSS 击中后的击退强度
export const BOSS_HIT_STUN = 1.0;          // 被 BOSS 击中后的失控时长（秒）
export const BOSS_RAM_BASE = 60;           // 高速撞 BOSS 的基础伤害
export const BOSS_RAM_NITRO_MULT = 2;      // 氮气中撞 BOSS 的伤害倍率

// ---------- BOSS 技能 ----------
// kind: cone(扇形) / ring(环带) / ground(落点) / path(路径) / buff(增益)
// telegraph: 命中前的地面预警时长（秒）
export const BOSS_SKILLS = {
  // 第一关喷火：fxFireBurst 是原地爆燃（主体），龙口再挂一团 P2_FireBall 当“喷出点”。
  // mouthFx 由 Boss.js 按朝向算到嘴前，避免火球生在身体中心。
  flame: {
    id: 'flame', name: '喷火吐息', kind: 'cone', angle: 55, range: 26,
    damage: 22, dps: true, cooldown: 8, telegraph: 1.9, visual: 'fire',
    anim: 'flame', fx: ['fxFireBurst', 'fxFire2'], fxScale: 1.6, fxScale2: 1.15,
    mouthFx: { fx: 'fxFireBall', scale: 1.1 },
    hitFx: 'fxFireBurst', hitFxScale: 0.9,
  },
  // 第二关「熔岩海啸」：替代原来的喷火吐息，避免和第一关火舌雷同。
  // 火龙掀浪，一道 30m 宽的火墙贴着海面沿正前方推进；危险区是整条直线通道，
  // 侧向跑出通道（或开氮气甩开）才安全。视觉是横向火带 + 一排火柱，不是扇形火舌。
  lavaTsunami: {
    id: 'lavaTsunami', name: '熔岩海啸', kind: 'wave',
    width: 30, reach: 54, waveSpeed: 19, bandThickness: 7,
    damage: 26, cooldown: 13, telegraph: 2.1, visual: 'fire',
    anim: 'aoe', fx: ['fxFireBand'], fxScale: 1.8,
    hitFx: 'fxWaterImpact', hitFxScale: 1.5,
  },
  // 第一关尾扫：T2_Spear1 的橙红放射球当“尾巴拍起的一圈火星”，
  // 第二段 fxFireBand 铺环形火带（fxScale2 只作用于后续段）。
  sweepDeep: {
    id: 'sweepDeep', name: '尾扫冲击', kind: 'ring', radius: 20,
    damage: 26, cooldown: 11, telegraph: 1.9, visual: 'fire',
    anim: 'tail', fx: ['fxSpear1', 'fxFireBand', 'fxEmberSlash'],
    fxScale: 1.3, fxScale2: 1.7,
    hitFx: 'fxClawSlash', hitFxScale: 0.85,
  },
  sweep: {
    id: 'sweep', name: '尾扫冲击', kind: 'ring', radius: 20,
    damage: 26, cooldown: 11, telegraph: 1.9, visual: 'water',
    anim: 'tail', fx: ['fxClawSlash'], fxScale: 1.5,
    hitFx: 'fxClawSlash', hitFxScale: 0.85,
  },
  dive: {
    id: 'dive', name: '俯冲撞击', kind: 'ground', radius: 9,
    damage: 30, cooldown: 14, telegraph: 2.2, visual: 'fire',
    anim: 'jump', fx: ['fxUpdraft'], fxScale: 1.3,
    // 落点：火流星砸海（groundFx 由 BossMode 在结算点播放）
    groundFx: { fx: 'fxMeteor', scale: 1.3, y: 1.0 },
    // 命中点改成落水水花：俯冲砸的是海面，比再炸一团火更贴切
    hitFx: 'fxWaterImpact', hitFxScale: 1.3,
  },
  // 第一关追加 · 双段俯冲：红圈持续追船（track），锁定后原地连砸两次，
  // 第二段半径更大、伤害略低但覆盖整个逃跑路线，逼玩家在锁定瞬间急转。
  diveCombo: {
    id: 'diveCombo', name: '双段俯冲', kind: 'divecombo',
    radius: 12, secondRadius: 18, secondDelay: 0.62,
    damage: 24, secondDamage: 16,
    track: true, trackSpeed: 26, trackUntil: 0.68,
    cooldown: 17, telegraph: 2.2, visual: 'fire',
    anim: 'riftSlam', fx: ['fxUpdraft'], fxScale: 1.5,
    groundFx: { fx: 'fxMeteor', scale: 1.4, y: 1.2 },
    hitFx: 'fxWaterImpact', hitFxScale: 1.4,
    toast: '🌋 双段俯冲！锁定后会连砸两次，锁定结束立刻急转',
  },
  // 第一关追加 · 熔岩龙息扫射：龙口火舌左右横扫约 100°，判定跟着火舌转，
  // 扫完在通道上留两片熔岩（HAZARD_ZONE.lava），逼迫横向走位。
  flameSweep: {
    id: 'flameSweep', name: '熔岩龙息扫射', kind: 'flamesweep',
    angle: 72, range: 30, sweepDeg: 104, duration: 1.55,
    damage: 12, tickInterval: 0.28, residue: 2,
    cooldown: 19, telegraph: 1.8, visual: 'fire',
    anim: 'flame', fx: ['fxFireBurst', 'fxFire2'], fxScale: 1.7, fxScale2: 1.2,
    hitFx: 'fxFireBurst', hitFxScale: 0.95,
    toast: '🔥 龙息扫射！火舌会左右横扫，别站在正面',
  },
  // 第一关追加 · 熔火棋盘：复用雷霆棋盘的走位框架，改成熔岩配色与火柱喷发。
  // 血量降到 55% 才进池，避免教学关开局就上棋盘。
  magmaChess: {
    id: 'magmaChess', name: '熔火棋盘', kind: 'grid',
    minHpRatio: 0.55, theme: 'fire',
    cols: 5, rows: 5, groupCells: 2,
    waves: 4, warnTime: 0.75, activeTime: 0.4,
    damage: 18, cooldown: 30, telegraph: 1.8, visual: 'fire',
    anim: 'cast', fx: ['fxFireBand'], fxScale: 1.8,
    hitFx: 'fxFireBurst', hitFxScale: 1.0,
    toast: '🔥 熔火棋盘！站到暗格里躲开喷发的火柱',
  },
  // 裂空翼击（第一关，地面版）：原地展开双翼猛拍一下，白色声爆环贴水面推出去。
  // kind=ring 的判定是「环带 ±3.4m」——贴着 BOSS 站着、或者跑到环外都安全，
  // 只有正好站在红环上会挨打，逼玩家看红环判断站位，而不是无脑后撤。
  wingShockGround: {
    id: 'wingShockGround', name: '裂空翼击', kind: 'ring', radius: 19,
    damage: 22, cooldown: 15, telegraph: 1.9, visual: 'fire',
    anim: 'wingBlast', fx: ['fxSonicBoom', 'fxWind1'], fxScale: 1.7, fxScale2: 1.5,
    hitFx: 'fxClaw4', hitFxScale: 0.9,
  },
  // 裂空翼击（第二关，空中版）：飞到空中振翅，冲击环从更高处压下来。
  // 同一招在第二关半径更大、伤害更高、动作走 fd_fly_blast（悬停振翅），
  // 和第一关的地面版拉开区分。
  wingShockAir: {
    id: 'wingShockAir', name: '裂空翼击', kind: 'ring', radius: 22,
    damage: 24, cooldown: 17, telegraph: 2.0, visual: 'fire',
    anim: 'wingBlast', fx: ['fxSonicBoom', 'fxWind1'], fxScale: 1.9, fxScale2: 1.6,
    hitFx: 'fxClaw4', hitFxScale: 1.0,
  },
  // 龙鳞骤雨（第二关专属）：腾空后把鳞片泼向整片区域，
  // 红圈预警 1.8 秒点名一整块 26m 的圆形区域，圈内逐片落下陨石式龙鳞。
  // 单个落点伤害不高（13），但落点密集，考验的是“整块区域都得跑出去”。
  scaleRain: {
    id: 'scaleRain', name: '龙鳞骤雨', kind: 'rain', radius: 26,
    damage: 13, spotCount: 12, spotRadius: 4.2,
    // 原来的 0.15 + 12×0.085 ≈ 1.1 秒，加上 2.4 秒预警，整招要 3.5 秒才落完；
    // 特效在天上停留的时间又长，读起来就是“转半天才下来”。
    // 压缩到 0.08 + 12×0.05 ≈ 0.63 秒，整招从 3.5 秒缩到约 2.4 秒。
    spotDelay: 0.05, startDelay: 0.08,
    cooldown: 26, telegraph: 1.8, visual: 'fire',
    // 预警阶段只在 BOSS 身边卷一层风（真正的大雨在 resolve 时整片铺开）
    anim: 'fly', fx: ['fxWind1'], fxScale: 1.6,
    hitFx: 'fxFireBurst', hitFxScale: 1.1,
  },
  // 第二关追加 · 焚海龙息横扫：复用血月激光的贴海旋转光束，换成橙金色火柱、
  // 只扫 240°（留一个安全的背身缺口），礁石/沉船依旧能挡光。
  infernoBeam: {
    id: 'infernoBeam', name: '焚海龙息横扫', kind: 'laser',
    duration: 2.7, sweepDeg: 240, spinDir: -1, beamWidth: 7, reach: 90,
    damage: 11, tickInterval: 0.38,
    cooldown: 24, telegraph: 1.8, visual: 'fire',
    beamColor: 0xff7a1e, coreColor: 0xfff0c0, attachFx: 'fxEmberSlash',
    anim: 'aoe', fx: ['fxFireBand'], fxScale: 2.0,
    hitFx: 'fxFireBurst', hitFxScale: 1.1,
    toast: '🔥 焚海龙息！躲到礁石背后，或顺着光束转向绕圈',
  },
  // 第二关追加 · 双浪熔岩海啸：两堵同向火墙错开 9m、间隔 0.85 秒推进，
  // 单浪的“侧向跑出通道”不再一次奏效，必须判断缝隙或提前拉开距离。
  twinTsunami: {
    id: 'twinTsunami', name: '双浪熔岩海啸', kind: 'wave',
    width: 30, reach: 60, waveSpeed: 19, bandThickness: 7,
    count: 2, waveGap: 0.85, waveOffset: 9,
    damage: 22, cooldown: 21, telegraph: 2.2, visual: 'fire',
    anim: 'aoe', fx: ['fxFireBand'], fxScale: 1.9,
    hitFx: 'fxWaterImpact', hitFxScale: 1.5,
    toast: '🌊 双浪海啸！两堵火墙错开推进，盯住中间缝隙',
  },
  // 第二关追加 · 陨火龙鳞连袭：龙鳞骤雨升格为三轮，第三轮落点半径收缩，
  // 像一张越收越紧的网，后半段持续施压。
  scaleRainX: {
    id: 'scaleRainX', name: '陨火龙鳞连袭', kind: 'rain', radius: 26,
    damage: 12, spotCount: 12, spotRadius: 4.2,
    spotDelay: 0.05, startDelay: 0.08,
    waves: 3, waveDelay: 0.8,
    cooldown: 30, telegraph: 1.8, visual: 'fire',
    anim: 'fly', fx: ['fxWind1'], fxScale: 1.6,
    hitFx: 'fxFireBurst', hitFxScale: 1.1,
    toast: '☄ 陨火龙鳞连袭！三轮龙鳞，最后一张网会收紧',
  },
  // 焚风灼膛（第二关专属）：红圈预警结束后把命中者的炮膛烧红，
  // lockWeapon 秒内**按 J 打不出炮弹**。红圈是普通地面技能，走位跑出去就能躲，
  // 护盾 / 复活无敌照常免疫（伤害为 0 时不会挂锁）——是“逼你放风筝”，不是无解缴械。
  overheat: {
    id: 'overheat', name: '焚风灼膛', kind: 'ground', radius: 7.5,
    damage: 10, cooldown: 18, telegraph: 1.9, visual: 'fire',
    anim: 'flame', fx: ['fxFireBurst'], fxScale: 1.3,
    // 命中点补一团火球：红圈只负责预警，落点要有“烧穿”的观感
    groundFx: { fx: 'fxFireBall', scale: 1.3, y: 0.8 },
    hitFx: 'fxFireBurst', hitFxScale: 1,
    lockWeapon: 6,
  },
  slash: {
    // 第三关专属：正面扇形的雷霆横扫。以前是 fullMap 全图判定，
    // 除了天使护盾没有任何走位解法（用户实测：太变态）。改成 kind=cone 后
    // 只打 BOSS 正前方 120° × 46m 的扇形：往侧面绕 60° 就能出圈，
    // 绕到身后 / 开出射程更安全。element 必须显式标 thunder：
    // 第三关的 frostBoss 会把非雷系技能染成冰蓝。
    id: 'slash', name: '横扫剑击', kind: 'cone', angle: 120, range: 46,
    // cone 是 0.95 秒的持续判定窗口（每 0.45 秒最多吃一跳，每跳 ×0.6），
    // 全程站在扇形里约 1.8 倍伤害 ≈ 25 点，和原来的单发 24 基本持平。
    damage: 14, cooldown: 14, telegraph: 3.0, visual: 'thunder', element: 'thunder',
    // 雷骑士挥砍：P2_SwordLightning 自带的剑要“握在手里”，
    // 所以走 handFx —— Boss.js 会把它挂到右手剑骨 Bone_Sword_R_1 上，
    // 随挥砍动作一起甩；life 覆盖整段蓄力，避免剑在红光最亮时提前消失。
    anim: 'attack', fx: ['fxSwordLightning'], fxScale: 2.4,
    handFx: { fx: 'fxSwordLightning', scale: 1.6, life: 3.2 },
    // 扇形劈砍的巨型刀光：结算瞬间沿扇形方向甩出去（BossMode 的命中分支播放）。
    // 换掉原来的 P2_SwordMoonlight —— 实测那套素材本体只有暗色剑模型 + 极淡白烟，
    // 没有任何月牙状亮贴图，在 46m 的扇形里根本读不出来。
    // 改用 T2_Sword1（fxSword1，青蓝弧形剑气）。
    // 注意：EffectFX 的 setScale 是**在加载缩放之上相乘**的（base 0.4），
    // 所以这里的 scale 要给到 12 才算 4.8 倍，能横跨大半个扇形；给 2 只有 0.8 倍，等于看不见。
    // particleFx: false —— 这招不再叠 SkillFx 的程序化雷雾（那团白雾），只留 Effekseer 刀光。
    particleFx: false,
    swingFx: { fx: 'fxSword1', scale: 12, life: 1.1 },
    hitFx: 'fxClawSlash', hitFxScale: 1.1,
  },
  charge: {
    id: 'charge', name: '冲锋突刺', kind: 'path', width: 6,
    damage: 26, cooldown: 12, telegraph: 2.1, visual: 'thunder',
    // 冲锋是直线贯穿：T2_Sword1 的蓝白剑气拖出一条路径痕迹。
    // track = 预警前半段持续修正朝向（玩家侧移躲不掉，必须急转或开氮气甩开）
    track: true,
    anim: 'move', fx: ['fxSword1'], fxScale: 1.4,
    hitFx: 'fxIceBloom', hitFxScale: 1,
  },
  thunder: {
    id: 'thunder', name: '落雷', kind: 'ground', radius: 7,
    damage: 32, cooldown: 13, telegraph: 2.2, visual: 'thunder',
    anim: 'cast', fx: ['fxBoltStorm'], fxScale: 1.35,
    hitFx: 'fxArcBolt', hitFxScale: 1.2,
    // 落雷本体：P1_LightningStrike 自带「天雷落地 + 电弧 + 落地烟尘」，
    // 比原来单束 ef_lightning02 更有从天上劈下来的高度感；
    // 原来的 ef_lightning02 仍保留在 hitFx，负责命中点那一下爆闪。
    // 离水面高度不合适时只调 skyFxY（中心高度）和 skyFxScale，别动特效本身。
    skyFx: 'fxLightningStrike', skyFxY: 8, skyFxScale: 2.0,
  },
  // 第三关新增：雷霆瞬影斩。复用第四关的 blink 机制（预警落在船头前 → 瞬移贴脸 → 横扫），
  // 但换成雷系配色，给第三关一个"躲不掉就掉 30 血"的突脸技能。
  blinkSlash: {
    id: 'blinkSlash', name: '雷霆瞬影斩', kind: 'blink',
    damage: 30, radius: 11, angle: 140,
    cooldown: 18, telegraph: 1.15, visual: 'thunder', element: 'thunder',
    // 瞬影落点接一记重劈（dk_smash），和普通横扫 attack 分开
    anim: 'slashBlink', fx: ['fxArcBolt'], fxScale: 1.25,
    hitFx: 'fxClawSlash', hitFxScale: 1.0,
  },
  // 第三关新增：跳劈震地。BOSS 跃向落点，落地砸出三段伤害：
  // 中心 42 → 外圈 30 → 0.5 秒延迟余波 16（躲开中心还得继续往外跑）。
  // 红圈按最大的余波半径（26）画，圈外才是安全区。
  slam: {
    id: 'slam', name: '裂地雷锤', kind: 'slam',
    damage: 42, radius: 9, outerRadius: 22, outerDamage: 30,
    waveRadius: 26, waveDamage: 16, waveDelay: 0.5,
    cooldown: 23, telegraph: 2.0, visual: 'thunder', element: 'thunder',
    anim: 'jumpSlam', fx: [], fxScale: 1.2,
    hitFx: 'fxBoltStorm', hitFxScale: 1.3,
  },
  rage: {
    id: 'rage', name: '狂怒', kind: 'buff', duration: 10,
    moveScale: 1.25, attackScale: 1.3, cooldown: 32, telegraph: 1.2,
    anim: 'cast', fx: [], hitFx: null,
  },
  // ---------- 第四关专属（与第三关刻意不重叠） ----------
  // 深渊吸取：把范围内的赛艇往自己嘴边拖。持续 skills.duration 秒，
  // 玩家只要还在驾驶（油门/转向有输入）或开氮气就能顶住/完全免疫。
  pull: {
    id: 'pull', name: '深渊吸取', kind: 'pull',
    radius: 64, duration: 2.8, power: 13, damage: 14,
    cooldown: 15, telegraph: 1.8, visual: 'blood',
    anim: 'pull', fx: ['fxBigVortex'], fxScale: 1.3,
    hitFx: 'hit', hitFxScale: 2,
  },
  // 血幕降临：全屏大招。多人的解法是**任意两艘赛艇贴靠**（物理接触），
  // 只剩一人时改躲场地中央的「安全柱」。没解的玩家全体扣血。
  screen: {
    id: 'screen', name: '血幕降临', kind: 'screen',
    radius: 92, damage: 40, safeRadius: 6.2,
    cooldown: 30, telegraph: 3.0, visual: 'blood',
    anim: 'screenCast', fx: ['fxBoltStorm'], fxScale: 1.8,
    hitFx: 'explosion', hitFxScale: 2,
  },
  // 瞬影突袭：预警圈画在目标船头前方，时间一到 BOSS 瞬移过去，
  // 直接接一刀近战横扫（不再是喷吐）。
  blink: {
    id: 'blink', name: '瞬影突袭', kind: 'blink',
    damage: 30, radius: 10, angle: 130,
    cooldown: 15, telegraph: 1.0, visual: 'blood',
    anim: 'blinkCast', fx: ['fxArcBolt'], fxScale: 1.15,
    hitFx: 'fxClawSlash', hitFxScale: 0.9,
  },
  // 暗影缠触：替代原来的血焰吐息。血魔抬手，一片暗影触手从海面伸出并持续 3.4 秒，
  // 圈内每 0.6 秒被缠一次（掉血 + 大幅减速），跑出红圈才是解法。
  // 视觉是 N_MagicDark 的血色触手，和第一关的橙色火舌、第二关的熔岩海啸都完全不同。
  shadowTendrils: {
    id: 'shadowTendrils', name: '暗影缠触', kind: 'zone',
    radius: 13, damage: 3, duration: 3.4, tickInterval: 0.6,
    slowSpeed: 7, slowTime: 1.4, slowLabel: '🩸 被暗影触手缠住',
    cooldown: 16, telegraph: 1.9, visual: 'blood',
    anim: 'tendrils', fx: ['fxMagicDark'], fxScale: 0.85,
    hitFx: 'fxMagicDark', hitFxScale: 0.7,
  },
  // 霜雪吐息：常驻喷雪花，命中后挂 3 秒减速 debuff（和喷火的区分点）
  frostBreath: {
    id: 'frostBreath', name: '霜雪吐息', kind: 'cone', angle: 70, range: 24,
    damage: 13, dps: true, slowSpeed: 9, slowTime: 3,
    cooldown: 10, telegraph: 1.6, visual: 'ice',
    anim: 'frost', fx: ['fxIceMist'], fxScale: 1.4,
    hitFx: 'fxIceBloom', hitFxScale: 0.9,
  },
  // 裂海泉涌：玩家脚下先炸一根水柱，随后 BOSS 脚下推出一圈扩散浪；
  // 浪经过船时只有「石头挡在 BOSS 与船之间」才安全。
  // 浪速从 24 降到 11：配合一层层向外亮起的红色预警，玩家有足够时间绕到礁石背后。
  geyser: {
    id: 'geyser', name: '裂海泉涌', kind: 'geyser',
    radius: 7, damage: 18, waveSpeed: 11, waveDamage: 24,
    cooldown: 18, telegraph: 2.0, visual: 'water',
    // 裂海泉涌单独用「双手上托召唤水柱」，不再和落雷/吸取共用施法段
    anim: 'geyser', fx: ['tornado'], hitFx: 'explosion',
  },
  // ---------- 每关个性化玩法（第三十八轮） ----------
  // 第一关 · 裂隙喷发：红圈点名一块 16m 的区域，圈内从水里钻出三根水柱（左 / 中 / 右）。
  // 教学关定位：单根伤害 14、只掀翻不致命，让新玩家第一次学会“红圈里不能待”。
  rift: {
    id: 'rift', name: '裂隙喷发', kind: 'rift',
    radius: 16, spotRadius: 5.2, spotOffset: 10,
    damage: 14, cooldown: 20, telegraph: 1.7, visual: 'water',
    slowSpeed: 12, slowTime: 1.2, slowLabel: '🌊 被水柱掀翻',
    // 抬身前压 + 双翼下砸（fd_skills.glb），砸下去的瞬间三根水柱破水
    anim: 'riftSlam', fx: ['fxMagic1Water'], fxScale: 1.2,
    hitFx: 'fxWaterImpact', hitFxScale: 1.0,
  },
  // 第一关 · 熔岩追猎（第 5 招）：全场唯一"追着人跑"的技能。
  // 一道带热浪扭曲的光柱锁住一艘赛艇，红圈以 trackSpeed 追船，
  // 速度（26）高于赛艇在怪物模式的极速（约 17~21），所以**直线逃跑一定被追上**；
  // 真正能躲的只有最后 trackUntil 之后的锁定窗口（约 0.7 秒）：
  // 在锁定那一刻急转或开氮气冲出 7m 圈。这是第一关命中率最高的一招，
  // 专治"只会一路直线后撤"的新玩家，但对会看红圈急转的人是公平解法。
  hunterBeam: {
    id: 'hunterBeam', name: '熔岩追猎', kind: 'ground', radius: 7,
    damage: 26, cooldown: 17, telegraph: 1.9, visual: 'fire',
    // 锁定窗口压在 0.72：留给玩家约 0.55 秒，全速直线能刚好跑出 9m 左右的有效圈
    // （7m 圈 + 船体半径）；减速、回头、贴圈边打输出都会被砸中。
    track: true, trackSpeed: 26, trackUntil: 0.72,
    // 立起前身仰头咆哮（fd_rear_roar）：不需要新做骨骼，第一关已有这段施法动作
    anim: 'cast',
    // BOSS 脚下先烧一圈火焰法阵，玩家一眼看到"它在点名了"
    fx: ['fxFireRune'], fxScale: 1.1,
    // 跟随红圈的竖向光柱（T2_Light3）：钉在世界坐标，红圈移到哪它灌到哪
    followFx: { fx: 'fxTrackBeam', scale: 1.6, y: 5.5 },
    groundFx: { fx: 'fxFireBurst', scale: 1.5, y: 0.9 },
    hitFx: 'fxFireBurst', hitFxScale: 1.0,
  },
  // 第二关 · 深渊召唤门：BOSS 两侧各开一道火门，1.1 秒后从门里钻出螃蟹 + 水母。
  // 和血量召唤（summonWaves）是两套：这套由技能 CD 驱动，门开在 BOSS 身边，
  // 玩家能提前看见“兵从哪来”，可以先把门堵住。
  summonGate: {
    id: 'summonGate', name: '深渊召唤门', kind: 'gate',
    gateCount: 2, gateRadius: 32, gateSpread: 0.85, openDelay: 1.1,
    spawns: [{ type: 'crab', count: 1 }, { type: 'jelly', count: 1 }],
    cooldown: 25, telegraph: 2.2, visual: 'fire',
    // 门面是程序化暖色旋涡（怕 P2_GateOfCalve 的贴图在部分显卡抛异常），
    // 所以这里不再挂 Effekseer 的 fx 字段，纯靠结算里的门 + 火焰法阵。
    // 立身展翼咆哮 → 低头前推（fd_skills.glb），门顺着龙首方向推开
    anim: 'gateCall', fx: [], fxScale: 1,
    hitFx: null,
  },
  // 第三关 · 雷霆棋盘：终盘（HP ≤ 1/3）才解锁。6×6 棋盘铺满竞技场，
  // 对角两块 3×3 棋盘格交替点名，循环 2 轮共 4 波；每波 0.9 秒预警 → 0.45 秒天雷。
  // 站错格子就挨劈，是全关唯一“必须横跨场地”的走位考验。
  gridThunder: {
    id: 'gridThunder', name: '雷霆棋盘', kind: 'grid',
    minHpRatio: 1 / 3,
    cols: 6, rows: 6, groupCells: 3,
    waves: 4, warnTime: 0.9, activeTime: 0.45,
    damage: 22, cooldown: 34, telegraph: 1.8, visual: 'thunder', element: 'thunder',
    // 举斧向天引雷并保持微颤 5.6 秒（dk_skills.glb），落雷瞬间整把斧砸向海面
    anim: 'gridCast', fx: ['fxBoltStorm'], fxScale: 2.0,
    hitFx: 'fxArcBolt', hitFxScale: 1.2,
  },
  // 第四关 · 血月激光：血魔掌心凝出一束血光，贴海面横扫一整圈（4.2 秒 / 360°）。
  // 判定是“光束轴线 ±2.5m”，跟着光束一起转；被扫中每 0.4 秒掉一次血。
  // 解法只有“顺着光束的转向绕圈跑”或者开氮气硬穿。
  laserSweep: {
    id: 'laserSweep', name: '血月激光', kind: 'laser',
    duration: 4.2, spinDir: -1, beamWidth: 5, reach: 88,
    damage: 12, tickInterval: 0.4,
    cooldown: 26, telegraph: 1.7, visual: 'blood',
    // 双臂平举、拧身慢扫 2.9 秒（bd_skills.glb），和光束同步转
    anim: 'laserCast', fx: ['fxEmberSlash'], fxScale: 3.0,
    hitFx: 'fxMagicDark', hitFxScale: 1.0,
  },
  // 阶段转换大招：BOSS 定身蓄力 3 秒，脚下亮起大范围红圈，
  // 站在圈内会挨打，跑出 30m 就能躲开（不是全屏无法规避的秒杀）。
  phaseBlast: {
    id: 'phaseBlast', name: '崩海咆哮', kind: 'ground', radius: 30,
    damage: 34, cooldown: 999, telegraph: 3.0, visual: 'fire',
    anim: 'aoe', fx: ['tornado', 'explosion'], hitFx: 'explosion',
  },
  // ---------- 第五关 / 海克斯无尽 · 深渊传令官 ----------
  // 这套技能的 fx 全部是怪物模式此前没引用过的 Effekseer（见 Effects.js 末尾注册块）。
  // pose 字段交给 Boss.#applyProceduralPose：这只 GLB 没有动画 clip，
  // 近战动作靠肩 / 肘 / 胸腔 / 膝的程序化骨骼姿态完成。
  abyssCharge: {
    id: 'abyssCharge', name: '裂爪冲锋', kind: 'path', width: 7,
    damage: 30, cooldown: 12, telegraph: 1.9, visual: 'blood',
    // pose：前 40% 高举蓄力，冲锋段双臂从头顶向下劈（Boss.#applyProceduralPose）
    track: true, pose: 'slashDown', anim: 'lunge',
    // 血量/动作之外的反馈：sfx 让第 5 关不再只有一声很轻的 boss_magic，
    // hitKind 让打中玩家时走可见的眩晕演出（默认分支以前只写 stunTimer，看不见）。
    // 2026-11-23：换成第 5 关专属音（此前 7 招全借第 1/3/4 关的通用池）。
    icon: 'holy', sfx: 'boss_herald_roar',
    fx: [], hitFx: 'fxPartsHit1', hitFxScale: 1.0,
  },
  abyssSweep: {
    id: 'abyssSweep', name: '回身横扫', kind: 'cone', angle: 130, range: 24,
    damage: 20, cooldown: 14, telegraph: 2.1, visual: 'blood',
    pose: 'sweep', anim: 'sweep',
    // P2_SwordMoonlight 本体只有暗色剑影 + 淡白烟，必须放大到能横跨扇形
    icon: 'holy', sfx: 'boss_herald_sword', hitKind: 'spin',
    fx: ['fxSwordMoonlight'], fxScale: 8.0,
    hitFx: 'fxPartsHit1', hitFxScale: 0.9,
  },
  abyssSlam: {
    id: 'abyssSlam', name: '双拳砸海', kind: 'slam',
    damage: 40, radius: 10, outerRadius: 22, outerDamage: 28,
    waveRadius: 26, waveDamage: 14, waveDelay: 0.5,
    cooldown: 22, telegraph: 2.0, visual: 'blood',
    pose: 'slam', anim: 'slam',
    // 砸海必须把船掀上天（case 'launched' 的 geyserLift），只掉血不算反馈
    icon: 'holy', sfx: 'boss_herald_slam', hitKind: 'launched',
    fx: ['fxHolySandstorm'], fxScale: 5.0,
    hitFx: 'fxMagicThunder', hitFxScale: 2.6,
  },
  abyssRoar: {
    id: 'abyssRoar', name: '深渊咆哮', kind: 'ring', radius: 20,
    damage: 18, cooldown: 16, telegraph: 1.8, visual: 'blood',
    pose: 'roar', anim: 'roar',
    icon: 'holy', sfx: 'boss_herald_roar', hitKind: 'spin',
    fx: ['fxHerald'], fxScale: 1.8,
    hitFx: 'fxHoly1', hitFxScale: 1.2,
  },
  abyssSpikes: {
    id: 'abyssSpikes', name: '影刺追猎', kind: 'zone',
    radius: 12, damage: 4, duration: 3.0, tickInterval: 0.6,
    slowSpeed: 8, slowTime: 1.2, slowLabel: '🩸 被影刺钉住',
    cooldown: 15, telegraph: 1.7, visual: 'blood',
    pose: 'cast', anim: 'cast',
    icon: 'holy', sfx: 'boss_herald_spike', hitKind: 'grab',
    fx: ['fxDark2'], fxScale: 2.4,
    hitFx: 'fxBolt1', hitFxScale: 1.1,
  },
  abyssSword: {
    id: 'abyssSword', name: '天罚圣剑', kind: 'rain',
    minHpRatio: 0.5,
    radius: 22, damage: 34, spotCount: 3, spotRadius: 5.0,
    spotDelay: 0.45, startDelay: 0.5,
    cooldown: 26, telegraph: 2.0, visual: 'blood',
    pose: 'swordCast', anim: 'swordCast',
    icon: 'holy', sfx: 'boss_herald_sword', hitKind: 'shock',
    fx: ['fxSwordSacred'], fxScale: 1.4,
    hitFx: 'fxMagicThunder', hitFxScale: 2.8,
  },
  abyssHeraldGate: {
    id: 'abyssHeraldGate', name: '圣光降临', kind: 'gate',
    minHpRatio: 0.5,
    gateCount: 2, gateRadius: 30, gateSpread: 0.85, openDelay: 1.1,
    spawns: [{ type: 'crab', count: 1 }, { type: 'jelly', count: 1 }],
    cooldown: 28, telegraph: 2.2, visual: 'blood',
    pose: 'summon', anim: 'summon',
    // 圣光降临用第 5 关专属音（2026-11-24 补上 boss_herald_gate.wav）。
    icon: 'holy', sfx: 'boss_herald_gate',
    fx: ['fxHerald', 'fxGateOfCalve'], fxScale: 1.8,
    hitFx: null,
  },
};

// 第一阶段（前 2/3 血）：固定正面战场，船只能左右横移 + 前后推进，
// 到通道边界就冻结，不再绕圈。剩下 1/3 才解禁环绕并让 BOSS 狂怒。
export const BOSS_PHASE2_RATIO = 1 / 3;
// 第一阶段：BOSS 站桩的正面战场。玩家在“离 BOSS 14~44 米”的环形区域里走位，
// 只限制到 BOSS 的距离，不做左右横向墙（追尾镜头下横墙会变成看不见的空气墙）。
export const BOSS_LANE = {
  near: 14,       // 离 BOSS 最近（再往前就撞脸了）
  // 离 BOSS 最远。52 是配合"引导线 46m"定的：玩家得真能跑到引导线上，
  // 否则那条线只是个够不着的装饰。
  far: 52,
};

// 玩家出生点离 BOSS 的距离（米）。必须小于 BOSS_LANE.far，否则开打那一帧
// 会被 constrainBoat 硬拉回来，看起来像瞬移。
export const BOSS_SPAWN_DISTANCE = 40;

// ---------- 各关节奏 ----------
// move: BOSS 从第一阶段就整体追击玩家（跑到赛艇面前放技能），而不是原地站桩。
// cooldownScale: 技能冷却倍率（>1 = 放得慢）。
// telegraphScale: 地面红圈预警时长倍率（<1 = 红圈刚亮就出手，更难躲）。
// speedScale: BOSS 追击移动速度倍率。
// walkStride: 走/跑随机节奏里「踱步」段的位移比例（缺省 0.55）。
export const BOSS_PACE = {
  // 第一关：从第一阶段就缓慢游走（speedScale 0.8 = 5.4→4.3，玩家永远追得上），
  // 不再原地站桩，但没有任何技能加压：冷却放宽到 1.15 倍，预警略长。
  1: { move: true, cooldownScale: 1.15, telegraphScale: 1.05, speedScale: 0.8, walkStride: 0.7 },
  // 第二关：解除站桩，追击速度降到 1.15（全程游走后 1.3 会贴脸太死），
  // 踱步段不再压到 0.55 倍，否则一半时间仍按 5.9×0.55 慢走，玩家体感还是“挪得很慢”。
  2: { move: true, cooldownScale: 1.05, telegraphScale: 1.0, speedScale: 1.15, walkStride: 0.9 },
  // 第三关高压：技能间隔恢复到正常节奏、预警缩短、追击提速，
  // 靠瞬影斩/跳劈/追踪冲锋持续施压，而不是只等 14 秒一次的雷霆横扫
  3: { move: true, cooldownScale: 1.0, telegraphScale: 0.92, speedScale: 1.0 },
  // 第四关高压：技能节奏比正常稍快、预警略有压缩，但保留可见的反应窗口
  4: { move: true, cooldownScale: 1.15, telegraphScale: 0.72, speedScale: 1.1 },
  // 第五关：深渊传令官本体有 7 个技能，冷却保持正常节奏；
  // 预警比第四关放宽一档（0.8），否则冲锋 + 砸地叠起来没有反应窗口。
  5: { move: true, cooldownScale: 1.05, telegraphScale: 0.8, speedScale: 1.05 },
};

// 第一阶段 BOSS 不追人；进入第二阶段后才追击
export const BOSS_PHASE_THRESHOLDS = [BOSS_PHASE2_RATIO];

// ---------- 难度递增 ----------
// 每熬过 stepTime 秒，BOSS 技能冷却与小怪波间隔各乘一次 stepScale（-5%），
// 最多叠到 minScale（-25%）。作用是防止“拖久了就稳赢”，后期节奏自然变快。
export const BOSS_PRESSURE = {
  stepTime: 60,
  stepScale: 0.95,
  minScale: 0.75,
  maxSteps: 5,
};

// ---------- 近身反制 ----------
// 贴着 BOSS 打会周期性被尾流掀开：推开 + 少量伤害 + 短暂减速。
// 不是要禁止贴脸，而是让“绕背输出”有成本，避免全程船头顶着 BOSS 站着不动。
export const BOSS_CLOSE_PUNISH = {
  range: 12,        // 船心离 BOSS 中心小于这个距离才算贴身
  cooldown: 5,      // 同一艘船的触发间隔
  damage: 8,
  push: 18,         // 推开的冲量（米/秒）
  slowSpeed: 13,
  slowTime: 0.9,
};

// 放置类道具：拾取后按 Q/E/1 放在水面上，等 BOSS 自己踩上去
export const BOSS_TRAP_ITEMS = {
  mine: { radius: 6.5, damage: 200, life: 30, visual: 'water', desc: '水面漂雷，BOSS 碾到就炸' },
  bubble: { radius: 6.0, damage: 70, root: 2.6, life: 30, visual: 'ice', desc: '黏性水泡，困住 BOSS 2.6 秒' },
  decoy: { radius: 7.0, damage: 120, lure: 3.5, life: 30, visual: 'water', desc: '幻影诱饵，勾引 BOSS 过来再炸' },
};

// ---------- 周期性落雷（第 2 关起） ----------
// 独立于 BOSS 自己的技能 CD 跑：每关一个固定间隔，落点选"离 BOSS 最远的玩家"，
// 逼玩家不能一直躲在场地外圈。命中除了掉血，还会把船限速到 slowSpeed 持续 slowTime 秒。
export const BOSS_THUNDER = {
  fromStage: 2,                     // 第 1 关纯单挑，不加落雷
  interval: { 2: 12, 3: 9.5, 4: 8.5 },
  telegraph: 1.6,                   // 地面红圈预警时长
  damage: 18,
  radius: 9,
  slowSpeed: 10,                    // 命中后最高速度（米/秒）
  slowTime: 5,
};

// ---------- 追踪漩涡（第一关专属的持续压力） ----------
// 第一关只有两个技能，打完一轮就空窗很久，实测偏简单。这里补一个"满场追着你跑"的常驻龙卷：
// 起手先在目标脚下亮一圈预警，随后龙卷以 chaseSpeed 一路追，追上就一直啃。
// 目标选择：联机时挑"对 BOSS 伤害最高"的那艘船（damageByPlayer 现成的数据），
// 单机时就是自己。这样打得越猛越容易被咬，逼玩家边跑边打而不是站桩输出。
// 形态按真实龙卷做：横向不铺太大，纵向拉得很高（y 缩放 2.8，总高约 8~9m ≈ BOSS 体高）。
export const BOSS_VORTEX_CHASE = {
  stages: [1],           // 只在第一关出现
  firstDelay: 8,         // 开打 8 秒后第一次
  interval: 0,           // 0 = 常驻：出现之后不再消失，只在目标死亡时换人
  telegraph: 1.5,        // 起手预警（目标船头前方画圈）
  duration: 0,           // 0 = 永久跟随（靠 BOSS 死亡 / 关卡结束清掉）
  radius: 6.5,           // 判定半径
  damage: 5,             // 每 tick 伤害
  tickInterval: 1.0,     // 每秒结算一次
  slowSpeed: 18,         // 咬中后限速（满速 30+ 压到 18，两秒后恢复；原 14 太黏人）
  slowTime: 2.2,
  chaseSpeed: 8.5,       // 龙卷追赶速度：比船慢，全速能拉开，一停就被吃
  spawnAhead: 9,         // 从目标前方 9m 浮现（挡路比追尾更难受）
  retarget: 3,           // 目标阵亡后多久转火到下一个最高伤害
  // 主体用 ef_wind02（上升气流）纵向拉 5.4 倍：横向只放大 1.4 保持纤细，
  // offsetY 把整体压到水面以下一点，粒子正好从水里往上抽
  scale: { x: 1.4, y: 5.4, z: 1.4 },
  offsetY: -1.5,
  // 地面层用 ef_wind03 压扁铺地，提供"水被卷起来"的碎片和裂纹
  groundScale: { x: 1.5, y: 0.9, z: 1.5 },
};

// ---------- 第二关专属：符文安全圈收缩 ----------
// 视觉用 M_Magic2Holy（符文六角阵），半径随时间从 startRadius 收到 minRadius。
// 圈外不再是安全区：每秒吃 outsideDps，逼玩家跟着圈心走（缩圈即“火烧全场”）。
export const BOSS_SAFE_RING = {
  stages: [2],
  startRadius: 84,      // 开打时的圈半径（场地边缘附近）
  minRadius: 26,        // 收缩下限，再小玩家就没法绕背了
  shrinkSpeed: 0.55,    // 米/秒（约 105 秒从满场收到最小）
  outsideDps: 5,        // 圈外每秒伤害
  tick: 1.0,            // 圈外伤害结算间隔
};

// ---------- 第二关专属：能量核心波次（C 方案） ----------
// BOSS 周围升起 count 枚 T2_Spear1 橙红核心，window 秒内全部打掉才开弱点窗口；
// 没打完就收起，等下一轮（interval）重新升起。弱点窗口内 BOSS 受到的伤害 ×weaknessMul。
export const BOSS_CORE_WAVE = {
  stage: 2,
  firstDelay: 14,       // 开打后第一轮升起的时间
  interval: 34,         // 两轮之间的间隔
  window: 20,           // 打核心的时间窗口
  count: 4,             // 每轮核心数
  ringRadius: 15,       // 环绕 BOSS 的半径
  coreRadius: 2.6,      // 单枚核心的命中半径
  hp: 180,              // 单枚核心血量
  weaknessTime: 8,      // 打完后的弱点窗口时长
  weaknessMul: 1.7,     // 弱点窗口内 BOSS 受伤倍率
};

// ---------- 第三关专属：电荷互斥 ----------
// 第二关是"两人必须挤进同一个安全圈"，第三关正好反过来：雷云把电荷灌进船体，
// 两艘船靠近就会互相放电。判定只吃距离、不吃血量（第三关玩家本身是临时无敌的），
// 代价是被强力弹开 + 短暂失控，逼两个人在场地两侧分开走位，而不是一直贴在一起。
export const BOSS_CHARGE = {
  stage: 3,
  minDist: 13,      // 两船小于这个距离开始蓄电
  breakTime: 0.55,  // 贴身多久才炸，擦身而过不算
  cooldown: 1.8,    // 同一对玩家两次放电的间隔
  push: 15,         // 弹开冲量（米/秒）
  stun: 0.32,       // 短暂失控时长
};

// ---------- 第四关专属：血祭祭坛 ----------
// 场上定时升起一座暗红祭坛：开船站进去引导 channel 秒完成献祭，
// BOSS 直接掉 damagePct 比例的最大生命。代价是引导期间船必须停在原地——
// 在第四关这种高压技能环境里，站桩本身就是风险，不需要再额外扣血。
export const BOSS_BLOOD_ALTAR = {
  stage: 4,
  firstDelay: 12,   // 开打后第一座祭坛出现的时间
  interval: 38,     // 两次祭坛之间的间隔
  life: 18,         // 没人献祭时祭坛存在多久
  radius: 8,        // 献祭判定半径
  channel: 2.6,     // 站进去需要引导多久
  decay: 1.6,       // 离开祭坛后进度每秒回落（不清零，避免被击退一次就白站）
  damagePct: 0.045, // 献祭成功扣掉 BOSS 最大生命的比例
};

// ---------- 破韧（第 1~3 关 + 第 5 关） ----------
// 打侧面/背面弱点、或趁 BOSS 出招预警时命中，会累积韧性槽；
// 满槽后 BOSS 跪地 duration 秒：不移动、不出招，受到的伤害 ×damageMul。
// 没有配置 staggerMax 的 BOSS（第四关 blood_nightmare）不启用这套机制。
export const BOSS_STAGGER = {
  duration: 5.0,       // 跪地时长（前三关统一 5 秒的输出窗口）
  damageMul: 2.2,      // 破韧窗口内玩家伤害倍率
  decay: 8,            // 没继续输出时每秒回落（小摩擦不会永久累积）
  lock: 6,             // 破韧结束后的免疫积累时间（防止连续跪地）
  gainWeak: 0.55,      // 侧面/背面命中：每点伤害转化的韧性值
  gainOther: 0.18,     // 正面装甲命中：转化率低得多
  gainTelegraph: 0.35, // 出招预警期间命中：额外叠加（奖励抓后摇）
};

// ---------- 过关传送门（第一~三关） ----------
// BOSS 死亡演出播完后，在场地圈内随机位置升起一道传送门；
// 所有玩家（含 AI 陪练）都进入门内才算过关，人没到齐就一直等。
// 门体是程序化的（旋涡门面 + 双紫环 + 地面符文阵）：
// 试过 P2_CosmicMist 叠在门上，素材自带的大面积雾面会把整屏洗白、门反而看不清，所以不用特效层。
export const BOSS_PORTAL = {
  delay: 2.6,        // 死亡演播多久后升起（秒）
  radius: 8.0,       // 判定半径：船心进这个圈就算“已准备”
  y: 2.2,            // 门体中心离水面高度
  doorRadius: 7.2,   // 竖直门框半径（门面 / 门环都用它）
  runeSize: 18,      // 地面符文阵直径
  advanceDelay: 0.9, // 全员到位后再停留多久才切关
};

// ---------- 随机血包 ----------
// 2026-11-14 改版：以前是「开局就在场上常驻 3 个、吃掉 30 秒后换个位置」，
// 玩家反馈开局之外几乎见不到。现在改成**每隔 30 秒在场上随机刷出一个**，
// 同时最多存在 3 个（不至于满地图都是绿盒子）。
// 刷新由主机摇点并广播 healSpawn；拾取由本机判定后广播 healPack。
export const BOSS_HEAL_PACK = {
  interval: 30,       // 刷新间隔（秒）
  first: 20,          // 开战后第一次刷新：别一开局就白送
  max: 3,             // 场上同时存在的上限
  heal: 25,           // 单个回复量
  pickupRadius: 4.6,
};

// ---------- 火力核心（四个关卡通用的 J 键强化道具） ----------
// BOSS 模式专属，**不进竞速道具池**：不占 Q/E/1 道具槽，而是场地中环定时刷新的独立金色核心。
// 选择“定时刷新”而不是“打 BOSS 才掉”的原因：不奖励本来就输出领先的人、
// 双方都能提前绕位争抢、也不会污染 ITEM_DEFS 的随机权重表。
export const BOSS_FIRE_CORE = {
  interval: 26,       // 吃掉/过期后，下一枚的冷却
  first: 9,           // 开战后第一枚的刷新延迟（正好错过安全起手）
  duration: 12,       // 强化持续时间
  shotMul: 3,         // 齐射弹丸数量倍率（“3 倍粒子”）
  shotDamage: 0.6,    // 单颗伤害 ×0.6 → 一轮齐射总伤害 ×1.8
  beamDamage: 1.8,    // 激光没有齐射：整束伤害直接 ×1.8
  pickupRadius: 4.6,
  life: 20,           // 没人捡就存在 20 秒，到点换位置
  minRadius: 40,      // 只在中环/外环刷新，不会刷在 BOSS 脚边
};

// 火力核心外圈的升降铁钉：想吃核心就得挑铁圈落下去的窗口穿过去。
// 一轮「升 0.4s → 保持 2s → 降 1.5s → 落底空窗 1.2s」，碰到的船被弹开并掉血。
// 落底空窗必须留足，否则铁圈刚落到水下就立刻回升，穿圈时几乎必被扎。
export const BOSS_FIRE_CORE_SPIKES = {
  radius: 6,          // 铁圈半径：比 4.6m 的拾取半径略大，必须穿圈才能吃到
  count: 24,          // 铁钉数量
  raise: 0.4,         // 升起耗时
  hold: 2.0,          // 完全升起后保持（危险窗口）
  lower: 1.5,         // 落回水下耗时
  bottom: 1.2,        // 完全落到水下后的安全空窗（此时穿圈不会受伤）
  sink: 2.6,          // 收起时整圈下沉的深度（钉尖要没入水面）
  upThreshold: 0.35,  // 升起进度超过该值才开始判定伤害
  hitBand: 1.3,       // 离铁钉圈中心线的命中带宽（船体宽约 2m，太窄会漏判）
  damage: 12,         // 触碰一次掉血
  cooldown: 1.5,      // 同一玩家的再次受伤冷却
};

// 每关进入战斗后的“安全起手”时间：这段时间 BOSS 不主动放技能，
// 只转身/巡航，给玩家看清场地、捡第一批道具的时间。
export const BOSS_GRACE_TIME = 4;

// ---------- BOSS ----------
// anims: 语义名 -> glb 内动画片段名
export const BOSSES = {
  dragon_deep: {
    id: 'dragon_deep', name: '深渊火龙', icon: '🐲', title: '烈焰苏醒',
    model: '/monsters/fire_dragon_boss.glb',
    hp: 3000, radius: 5.5, height: 7.2, speed: 5.4, turnRate: 0.9, waterSink: 0.5,
    fxTheme: 'fire',
    // 第一关动作：待机/喷火/近身撕咬/尾扫/振翼
    // 本体 7 段 clip 里有 idle/attack/breath/jump/roar/run/walk —— 这里把 breath 用起来，
    // 喷火不再借 roar，读起来是“真正在吐火”而不是站着干吼。
    anims: {
      idle: 'idle', move: 'walk', attack: 'attack',
      // 新做的骨骼动作包（fd_anims2.glb）：尾链横扫（躯干反向拧腰，不再和撕咬共用 attack）
      tail: 'fd_tail_sweep',
      // 新做：立起前身仰头咆哮（施法/大招起手）
      cast: 'fd_rear_roar', aoe: 'fd_rear_roar',
      flame: 'breath', breath: 'breath',
      // 新做：前倾下沉的倒地
      death: 'fd_death',
      // 新做：受击回缩
      hurt: 'fd_hit',
      // 新做的骨骼动作包（fd_anims.glb）：地面振翼冲击
      wingBlast: 'fd_ground_wingblast',
      // 新做的骨骼动作包（fd_skills.glb）：裂隙喷发下砸 / 召唤门展翼 / 阶段转换
      riftSlam: 'fd_rift_slam', gateCall: 'fd_gate_call', enrage: 'fd_enrage',
    },
    clipModels: ['/monsters/fd_anims.glb', '/monsters/fd_anims2.glb', '/monsters/fd_skills.glb'],
    // sweepDeep = 第一关专属尾扫（T2_Spear1 火星 + 火带），与二/三关的 sweep 区分
    // wingShockGround = 地面版裂空翼击（振翅 → 声爆环）
    // rift = 裂隙喷发（圈内三根水柱，教学用）
    // hunterBeam = 熔岩追猎（第 5 招，2026-11-17 追加）：唯一"追着船跑"的锁定光柱，
    //   补足第一关 4 招全是"原地放、侧向跑开就安全"的短板
    // 2026-11-23 追加三招提升第一关压迫感：
    //   diveCombo = 双段俯冲（红圈持续追船，锁定后连砸两次）
    //   flameSweep = 熔岩龙息扫射（火舌左右横扫 + 熔岩带）
    //   magmaChess = 熔火棋盘（HP ≤ 55% 才进池的棋盘走位）
    skills: ['flame', 'sweepDeep', 'wingShockGround', 'rift', 'hunterBeam', 'flameSweep', 'diveCombo', 'magmaChess'],
    // 第一关：纯单挑。不召唤小怪，靠场地熔岩柱逼走位，重点打绕背弱点
    staggerMax: 260,
    summon: [],
    lavaHazard: true,
    intro: '海面骤然灼热，巨影自浪涛中升起。',
  },
  dragon_inferno: {
    id: 'dragon_inferno', name: '炎狱火龙', icon: '🐉', title: '烈焰焚海',
    model: '/monsters/fire_dragon_boss.glb',
    hp: 4500, radius: 6.0, height: 7.8, speed: 5.9, turnRate: 1.0, waterSink: 0.5,
    fxTheme: 'fire',
    // 第二关全动作：远距离追人用 run、贴身用 walk，喷火 breath、俯冲 jump、AOE 立起咆哮
    anims: {
      idle: 'idle', move: 'walk', moveFast: 'run', attack: 'attack',
      // 尾扫改用新做的尾链横扫，和撕咬分开
      tail: 'fd_tail_sweep',
      cast: 'fd_rear_roar', flame: 'breath', breath: 'breath', jump: 'jump',
      // 熔岩海啸：立起前身掀浪，不再复用普通咆哮
      aoe: 'fd_rear_roar',
      // 倒地不再借用 roar（否则“死了还在仰头叫”）
      death: 'fd_death',
      hurt: 'fd_hit',
      // 新做的骨骼动作包（fd_anims.glb）：悬停扑翼 / 空中翼击 / 收翼俯冲
      fly: 'fd_fly_loop', wingBlast: 'fd_fly_blast', flyDive: 'fd_fly_dive',
      // 新做的骨骼动作包（fd_skills.glb）：召唤门展翼 / 阶段转换
      gateCall: 'fd_gate_call', enrage: 'fd_enrage',
    },
    clipModels: ['/monsters/fd_anims.glb', '/monsters/fd_anims2.glb', '/monsters/fd_skills.glb'],
    // 追加的 overheat 排最后：喷火/尾扫/俯冲都在冷却时才轮到“锁 J”，
    // 不会一开场就连续缴械，节奏是“打一阵 → 被压一轮火力”。
    // flameInferno 已换成 lavaTsunami（熔岩海啸）：第二关不再和第一关共用喷火吐息
    // wingShockAir = 空中版裂空翼击；scaleRain = 龙鳞骤雨（腾空泼鳞，整区走位）
    // summonGate = 深渊召唤门（技能驱动的固定刷怪点）
    // 2026-11-23 追加三招：
    //   infernoBeam = 焚海龙息横扫（240° 旋转火柱，掩体可挡）
    //   twinTsunami = 双浪熔岩海啸（两堵错开 9m 的火墙）
    //   scaleRainX = 陨火龙鳞连袭（三轮龙鳞，第三轮收缩）
    skills: ['lavaTsunami', 'sweep', 'dive', 'overheat', 'wingShockAir', 'scaleRain', 'summonGate', 'infernoBeam', 'twinTsunami', 'scaleRainX'],
    // 第二关：召唤海。三波小怪持续涌来，击杀会掉道具箱，主打清杂与双人分工。
    // 原本的机兵（beast）换成海底甲壳蟹 + 水母：螃蟹近战顶前排，水母远程放电，
    // 两种怪的远近分工正好对应第二关“边躲龙息边清杂”的节奏。
    // 血魔只在第四关当 BOSS，这里不再作为杂兵出现。
    staggerMax: 330,
    summon: [
      { at: 0.85, minions: [{ id: 'crab', count: 2 }, { id: 'jelly', count: 2 }] },
      { at: 0.62, minions: [{ id: 'crab', count: 2 }, { id: 'jelly', count: 2 }] },
      { at: 0.4, minions: [{ id: 'crab', count: 3 }, { id: 'jelly', count: 2 }] },
      { at: 0.2, minions: [{ id: 'crab', count: 3 }, { id: 'jelly', count: 3 }] },
    ],
    intro: '余烬未熄，第二头火龙自火焰中踏出。',
  },
  knight_thunder: {
    id: 'knight_thunder', name: '雷霆龙骑士', icon: '⚔️', title: '雷鸣裁决',
    model: '/monsters/dragonknight.glb',
    // 本体 dragonknight.glb 里的 10 个 clip 全是静帧（255 通道但 0 运动），
    // 真正带关键帧的动画全部收进了 dk_anims.glb（同一副 85 骨骼）：
    // 上传的 站立/走路/挥砍/咆哮/奔跑 5 段 + Blender 新做的 重劈/回旋/引雷/倒地/踱步 5 段。
    // Boss.js 会用这里的同名 clip 覆盖本体的静帧。
    clipModels: ['/monsters/dk_anims.glb', '/monsters/dk_slam.glb', '/monsters/dk_hit_fixed.glb',
      '/monsters/dk_skills.glb'],
    hp: 5500, radius: 4.6, height: 7.0, speed: 6.4, turnRate: 1.3, waterSink: 0.3,
    fxTheme: 'ice',
    anims: {
      idle: 'Armature_Stand_full',        // 上传：站立待机
      // 上传的 Stand Work 与 dk_run 是同一段数据，看起来“只会跑”，
      // 改用 Blender 按同骨架新做的慢速踱步循环（双腿交替 + 髋部起伏）。
      move: 'dk_walk_loop',
      moveFast: 'dk_run',                 // 上传：奔跑（远距离/终盘追人）
      attack: 'Armature_Attack_full',     // 上传：平滑的挥砍（用户点名要用这段）
      tail: 'dk_tail',                    // 新做：扭腰回旋横扫（斧头已绑手）
      cast: 'dk_cast',                    // 新做：举剑引雷
      aoe: 'Armature_Taunt_full',         // 上传：仰头咆哮（崩海咆哮）
      // 口吐雪花：用咆哮（仰头张口）那一段，比平砍更像是从嘴里喷出来的
      breath: 'Armature_Taunt_full',
      death: 'dk_death',                  // 新做：跪倒扑地
      fidget: 'Armature_Stand_full',
      // Blender 新做：跃起 → 举锤 → 砸地 → 起身（配合 slam 的跃劈位移）
      jumpSlam: 'dk_jump_slam',
      // 破韧跪地：复用 dk_death 的前半段，Boss.js 会停在 staggerHold 处保持单膝跪姿，
      // 不会一路躺平“假死”。
      stagger: 'dk_death',
      // Blender 新做：瞬影落点的重劈（原 dk_smash 一直没被用上），
      // 让“雷霆瞬影斩”和普通横扫 attack 明显区分开
      slashBlink: 'dk_smash',
      // Blender 新做（dk_hit_fixed.glb，从 dk_anims2.glb 修正）：受击后仰。
      // 原文件里斧头骨骼（Bone_Sword_R_1）是恒定值、没跟手，受击时斧头会脱手；
      // 修正版按站立 clip 量出的握持偏移，逐帧把斧头绑到右手骨上。
      hurt: 'dk_hit',
      // Blender 新做（dk_skills.glb）：雷霆棋盘举斧引雷 5.6s / 阶段转换举斧咆哮
      gridCast: 'dk_grid_thunder', enrage: 'dk_enrage',
    },
    // 新增瞬影斩（突脸）与跳劈震地（三段 AOE），配合雷霆横扫形成高压技能组
    // gridThunder = 雷霆棋盘（终盘 HP ≤ 1/3 才解锁的棋盘走位大招）
    staggerMax: 400,
    // 破韧时把 dk_death 冻在 0.95s（刚单膝跪倒、还没扑地）的姿势
    staggerHold: 0.95,
    skills: ['slash', 'blinkSlash', 'slam', 'charge', 'thunder', 'sweep', 'gridThunder'],
    // 第三关：暴风雪里的冰霜企鹅，替换掉原本召唤的血魔（血魔是第四关的 BOSS）。
    // 场上只留 1 只岩窟兽 + 1 只企鹅：召唤物太多时技能弹幕全被挡住，
    // 玩家根本看不清 BOSS 的蓄力，也判断不出小怪有没有卡住。
    summon: [
      { at: 0.5, minions: [{ id: 'beast', count: 1 }, { id: 'penguin', count: 1 }] },
    ],
    intro: '雷云压顶，甲胄铿锵，雷霆龙骑士落雷登场。',
  },
  blood_nightmare: {
    id: 'blood_nightmare', name: '暗夜血魔·终焉', icon: '👹', title: '终焉降临',
    model: '/monsters/blood_demon_prince.glb',
    hp: 7600, radius: 5.0, height: 6.6, speed: 6.9, turnRate: 1.5, waterSink: 0.35,
    fxTheme: 'ice',
    // 本体 7 段 clip：站立/奔跑/普攻/两个施法/受击/倒地。
    // 原先 7 个技能里有 6 个都播 skill01，动作几乎一模一样；
    // 现在按招式拆成独立的骨骼动作（bd_anims.glb，同一副 77 骨骼）：
    //   落雷 = 举臂引雷  吸取 = 双臂前伸回收  缠触 = 高举下砸
    //   泉涌 = 双手上托  霜息 = 吸气前吐      血幕 = 展翼仰头
    anims: {
      idle: 'stand', move: 'run', attack: 'attack01',
      cast: 'bd_thunder',          // 落雷：单臂高举指天 → 下挥
      pull: 'bd_pull',             // 深渊吸取：双臂前伸 → 往怀里拉
      tendrils: 'bd_tendrils',     // 暗影缠触：双臂高举 → 砸向海面
      geyser: 'bd_geyser',         // 裂海泉涌：双手上托 → 下压
      frost: 'bd_frost',           // 霜雪吐息：吸气后仰 → 前倾吐出
      breath: 'bd_frost',
      screenCast: 'bd_screen',     // 血幕降临：展翼 + 双臂张开 + 仰头
      aoe: 'bd_screen',
      // 瞬影突袭：前摇用本体普攻段（抬刀），落点再接一刀
      blinkCast: 'attack01',
      tail: 'skill02',
      death: 'die',
      hurt: 'bd_hit',              // 新做：受击后仰回弹
      // Blender 新做（bd_skills.glb）：血月激光双臂平举拧身慢扫 / 阶段转换展翼咆哮
      laserCast: 'bd_laser_sweep', enrage: 'bd_enrage',
    },
    clipModels: ['/monsters/bd_anims.glb', '/monsters/bd_skills.glb'],
    // 保留落雷（唯一与第三关同名的技能），其余全部是第四关专属：
    // 吸取 / 瞬移突袭 / 暗影缠触 / 喷雪花 / 水柱
    // 「血幕降临」（kind: 'screen' 的全屏大招）已按玩家要求从本关移除：
    // 单发 40 点、范围 92m，试玩时无解。技能定义仍保留在 BOSS_SKILLS 里，
    // 安全柱 / 贴靠判定那套代码也没删，想恢复只要把 'screen' 加回这个数组。
    // laserSweep = 血月激光（贴海面 360° 旋转光束）
    skills: ['thunder', 'pull', 'blink', 'shadowTendrils', 'frostBreath', 'geyser', 'laserSweep'],
    // 第四关：只留两只巨鲸鲨的远程压制，不再召唤血魔。
    // 终盘阶段玩家已经要同时躲激光 + 吸取 + 水柱，再塞 4 只血魔没有操作空间。
    summon: [
      { at: 0.75, minions: [{ id: 'whale_shark', count: 2 }] },
      { at: 0.25, minions: [{ id: 'whale_shark', count: 2 }] },
    ],
    intro: '黑暗吞没了整片海，血魔自深渊爬出——终焉之战。',
  },
  // 第五头 BOSS：4 关经典流程里是第 5 关；海克斯里从第 1 层起就参与轮转
  // （2026-11-22 用户要求"新 BOSS 也要在前 4 层出现"，见 hexRun.js 的 HEX_BOSS_ORDER）。
  // GLB 来自 Sketchfab「Aion boss rigged character」：157 关节骨架、13.7k 面，
  // 但导出包里没有动画 clip，所以 anims 为空，动作全部由 Boss.#applyProceduralPose
  // 驱动肩 / 肘 / 腕 / 胸 / 头 / 下颌 / 膝，做出冲锋、横扫、砸地、咆哮、施法。
  abyss_herald: {
    id: 'abyss_herald', name: '深渊传令官', icon: '😈', title: '堕翼圣裁',
    model: '/monsters/abyss_herald.glb',
    // 朝向已用渲染截图核对：模型原始正面（脸/胸）朝 +Z，玩家也在 +Z 侧，
    // 不能再加 Math.PI，否则整只 BOSS 会背对玩家。
    modelRotationY: 0,
    hp: 7000, radius: 4.8, height: 8.2, speed: 6.2, turnRate: 1.3, waterSink: 0.3,
    fxTheme: 'ice',
    proceduralPose: true,
    anims: {},
    skills: ['abyssCharge', 'abyssSweep', 'abyssSlam', 'abyssRoar',
      'abyssSpikes', 'abyssSword', 'abyssHeraldGate'],
    staggerMax: 360,
    summon: [],
    intro: '圣光自深海裂口垂落，六翼残破的传令官展开双臂——它来宣判。',
  },
};

// ---------- 小怪 ----------
// 蜘蛛没有骨骼动画，已替换为 first_game 里的骨架兽：
// walk / attack / death 三集共用同一套 57 骨骼，可以合成一套完整动作。
export const BOSS_MINIONS = {
  beast: {
    id: 'beast', name: '岩窟兽', icon: '🐾',
    model: '/monsters/beast_walk.glb',
    clipModels: ['/monsters/beast_attack.glb', '/monsters/beast_death.glb'],
    hp: 260, speed: 8.2, radius: 2.2, fitHeight: 3.2,
    // 伤害必须低于 BOSS 单发（22~34）：小怪是骚扰，不该成为主要死因
    contactDamage: 6, attackCooldown: 1.8,
    // 挥爪光弧颜色（琥珀）：命中瞬间在身前亮起一片新月形爪痕
    slashColor: 0xffb347,
    procedural: false,
    anims: { walk: 'Walk', attack: 'Attack', die: 'Death' },
  },
  blood: {
    id: 'blood', name: '血魔', icon: '👹',
    model: '/monsters/blood_demon_prince.glb',
    hp: 450, speed: 6.4, radius: 2.3, fitHeight: 4.6,
    contactDamage: 11, attackCooldown: 2.0, heavyDamage: 22, heavyCooldown: 4,
    // 远程飞刀：距玩家 8~20m 时原地施法，朝赛艇掷出闪电弯刀（命中才结算）
    rangedDamage: 9, rangedCooldown: 3.4, rangedRange: 20,
    // 血魔的爪痕偏赤红，一眼就能和岩窟兽的琥珀爪痕区分开
    slashColor: 0xff3b52,
    procedural: false,
    anims: { idle: 'stand', move: 'run', attack: 'attack01', cast: 'skill01', hurt: 'stun', die: 'die' },
  },
  // 巨鲸鲨（精英）：14 骨手工绑定，体长 9m。动作分 5 个文件，clip 名带前缀，
  // 所以必须靠 anims 精确指定（`swim` 匹配不上 loadMinionRig 的 /walk|run|move/ 正则）。
  whale_shark: {
    id: 'whale_shark', name: '巨鲸鲨', icon: '🦈',
    model: '/monsters/whale_shark_swim.glb',
    clipModels: ['/monsters/whale_shark_idle.glb',
      '/monsters/whale_shark_bite.glb', '/monsters/whale_shark_spit.glb',
      '/monsters/whale_shark_die.glb'],
    // fitHeight 量的是模型高度（2.45m），体长会跟着到 9m 上下
    // hp 不变，但游速从 8.0 降到 5.2：9m 体长的精英追着船跑太快会很窒息
    hp: 900, speed: 5.2, radius: 3.4, fitHeight: 2.5,
    // 精英怪：单次伤害要压得住，但比杂兵疼
    contactDamage: 14, attackCooldown: 2.4,
    // 咬合水花偏冷白，和两条鱼怪区分开
    slashColor: 0x8fe3ff,
    // 9m 体长的撕咬：整段交给 Effekseer 的水面爆点，比贴图弯月更有分量
    meleeFx: 'minionWaterSplash', meleeFxScale: 0.34,
    // 吐泡泡（远程弹幕）：34m 内就能起手；BossMode 会让它保持在射程外沿，
    // 不再一路冲脸到咬合距离才吐。泡泡只有 6.2m/s、转向率 0.5rad/s，
    // 船一开就能甩掉，停船/低速才会被糊上，所以伤害可以给到 8 而不是骚扰级的 4。
    // 撞上即破（扣血 + 蓝环破裂特效），漂满 10 秒也自己破掉。
    bubbleDamage: 8, bubbleCooldown: 7.5, bubbleRange: 34, bubbleCount: 2,
    bubbleSpeed: 6.2, bubbleTurn: 0.5, bubbleLife: 10,
    procedural: false,
    anims: {
      move: 'whale_shark_swim', attack: 'whale_shark_bite',
      cast: 'whale_shark_spit', die: 'whale_shark_die',
    },
  },
  // 冰霜企鹅：11 骨，8 个分件按共用 atlas 合并成 3 个 draw call。
  penguin: {
    id: 'penguin', name: '冰霜企鹅', icon: '🐧',
    model: '/monsters/penguin_move.glb',
    clipModels: ['/monsters/penguin_idle.glb', '/monsters/penguin_attack.glb',
      '/monsters/penguin_cast.glb', '/monsters/penguin_hurt.glb', '/monsters/penguin_die.glb'],
    // 体型对齐岩窟兽（fitHeight 3.2）：原来 1.5m 高的企鹅在暴风雪里几乎看不见，
    // 判定半径也从 1.1 同步放大到 1.8，否则模型变大后炮弹会从身体两侧穿过去。
    hp: 220, speed: 5.8, radius: 1.8, fitHeight: 3.2,
    contactDamage: 7, attackCooldown: 1.6,
    // 远程吐冰：8~16m 停下来施法。弹体整段走 Effekseer（minionIceFly 跟着飞行点喷冰晶），
    // 命中再放一发 minionIceHit 冰花，不再有 three.js 的实体锥体
    rangedDamage: 6, rangedCooldown: 3.4, rangedRange: 16,
    projFx: 'minionIceFly', projHitFx: 'minionIceHit', projName: '冰锥',
    slashColor: 0xbfe9ff,
    procedural: false,
    anims: {
      idle: 'penguin_idle', move: 'penguin_move', attack: 'penguin_attack',
      cast: 'penguin_cast', hurt: 'penguin_hurt', die: 'penguin_die',
    },
  },
  // 海底甲壳蟹（第二关）：29 骨 + 6 段动作（idle/walk/attack/skill/block/die）。
  // 纯近战：血厚、步速偏慢，负责顶在火龙前面吃伤害；
  // crab_skill 是它自带的远程蓄力动作，这里不挂远程，保留给后续扩展。
  crab: {
    id: 'crab', name: '海底甲壳蟹', icon: '🦀',
    model: '/monsters/crab.glb',
    // 螃蟹是横宽体型：判定半径拉到 5m，模型高度同步放大到 4.6m，
    // 否则蟹壳只有 3.2m 高、判定圈却 10m 宽，看起来还会是“贴图大小的螃蟹”。
    hp: 420, speed: 5.2, radius: 5, fitHeight: 4.6,
    // 判定半径 5m 已经很难绕开，攻速和接触伤害要压下来：
    // 3 秒一次钳击、单次 8 点，玩家贴着它走一小段也不会连续掉血。
    contactDamage: 8, attackCooldown: 3.0,
    // 蟹壳偏橙红，爪痕和深海的冷色背景拉得开
    slashColor: 0xff9a3c,
    // 钳击是近战：主特效给爪痕，副特效补一圈小水花（螃蟹是从水里探出来的）
    meleeFx: 'minionClaw', meleeFx2: 'minionWaterSplash', meleeFx2Scale: 0.16,
    procedural: false,
    anims: {
      idle: 'crab_idle', move: 'crab_walk', attack: 'crab_attack',
      cast: 'crab_skill', die: 'crab_die',
    },
  },
  // 深海电水母（第二关）：33 骨，但只有 idle/cast/die 三段，没有单独的移动/近战动作。
  // 移动复用 idle 的漂浮循环（水母本来就靠伞盖一开一合慢慢漂），
  // 攻击统一走 cast 的放电动作：远程 8~18m 停下来放电，贴脸时也播同一段。
  jelly: {
    id: 'jelly', name: '深海电水母', icon: '🪼',
    model: '/monsters/jelly_idle.glb',
    clipModels: ['/monsters/jelly_cast.glb', '/monsters/jelly_die.glb'],
    // 判定半径 4m（直径 8m），模型高度同步放大到 5m；
    // 水母伞盖撑开后本来就宽，只放大高度会让伞盖和判定圈对不上。
    hp: 300, speed: 4.0, radius: 4, fitHeight: 5.0,
    // 水母是“远程骚扰”定位：接触伤害压到 4，贴脸放电和远程放电都拉长间隔，
    // 让它靠减速/消耗制造压力，而不是贴上来就一直掉血。
    contactDamage: 4, attackCooldown: 3.0,
    rangedDamage: 5, rangedCooldown: 4.5, rangedRange: 18,
    // 放电弹体沿飞行点喷电流，命中再炸一发连锁光柱（和企鹅冰锥同一套弹道机制）
    projFx: 'minionBoltFly', projHitFx: 'minionBoltHit', projName: '放电',
    // 电光偏冷白蓝，和血魔的赤红飞刀区分开
    slashColor: 0xa8e8ff,
    procedural: false,
    anims: {
      idle: 'jelly_idle', move: 'jelly_idle', attack: 'jelly_cast',
      cast: 'jelly_cast', die: 'jelly_die',
    },
  },
};

// 小怪同时在场的上限
export const MAX_ACTIVE_MINIONS = 6;
// 两波召唤之间的最小间隔（秒）
export const MINION_WAVE_INTERVAL = 6;
// 场上道具箱少于这个数量时，小怪死亡才会掉落道具箱
export const MINION_DROP_BOX_MIN = 8;

// ---------- 五关配置 ----------
// 第 5 关为「深渊传令官」：单人练习选关可直接进，闯关模式打完第 4 关后接这一关。
export const BOSS_LEVELS = [
  { stage: 1, weather: 'day', boss: 'dragon_deep', name: '第一关 · 深渊火龙' },
  { stage: 2, weather: 'dusk', boss: 'dragon_inferno', name: '第二关 · 炎狱火龙' },
  { stage: 3, weather: 'blizzard', boss: 'knight_thunder', name: '第三关 · 雷霆龙骑士' },
  { stage: 4, weather: 'storm', boss: 'blood_nightmare', name: '第四关 · 暗夜血魔·终焉' },
  { stage: 5, weather: 'blizzard', boss: 'abyss_herald', name: '第五关 · 深渊传令官' },
];

export function getBossLevel(stage) {
  return BOSS_LEVELS.find((l) => l.stage === stage) || BOSS_LEVELS[0];
}

// ---------- 圆形竞技场 ----------
export const BOSS_ARENA = {
  id: 'boss-arena',
  name: '怪物竞技场',
  icon: '🐉',
  desc: '封闭的圆形海面，五头巨兽盘踞其间',
  laps: 1,
  style: 'arena',
  // 竞技场不再建远景山脊：四周改由 ArenaStadium 的环形看台围合出「真正的竞技场」。
  // 怪物模式不受影响 —— BossThemes 本来就整组隐藏通用远景，主题自带火山/海岛背景；
  // mountainStyle / setMountainTint 调色基础设施保留，以后要用随时开。
  noMountains: true,
  mountainStyle: 'volcano',
  // 天空：'real' = 比赛模式那套写实天空（雾/太阳由关卡主题接管）
  bossSkyMode: 'real',
  waterColor: 0x2fc8c8,
  waterDeep: 0x1460c8,
  waterCrest: 0x9ff2ee,
  fogColor: 0xbfe6f7,
  fogDensity: 0.0026,
  skyTop: 0x3f9ff0,
  skyBottom: 0xcdeeff,
  sunColor: 0xfff8e8,
  gateWidth: 16,
  boundary: { x: 0, z: 0, r: 92 },
  gates: (() => {
    // 16 个环绕点：只用于罗盘/出生点参照，不承担赛道判定
    const pts = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push([Math.round(Math.cos(a) * 84), Math.round(Math.sin(a) * 84)]);
    }
    return pts;
  })(),
  rocks: [],
  // 地面标记：一圈"推荐绕行线" + BOSS 脚下红环（红环半径 = BOSS 半径 ×1.35）
  marks: { guideR: 46, guideColor: 0xff8a3a, bossRingColor: 0xff3b2a, bossRingScale: 1.35 },
  // 通用地标（灯塔/广告牌）在竞技场里一律丢到这个半径的外圈，
  // 免得落在战场中景抢 BOSS 的视线
  landmarkRing: 150,
  podium: { x: 0, z: 0, heading: 0 },
};

// 场地内 12 个道具箱散布点：3 个同心环（4 + 4 + 4）
export const ARENA_ITEM_SPOTS = (() => {
  const spots = [];
  const rings = [
    { r: 24, offset: 0.0 },
    { r: 50, offset: Math.PI / 4 },
    { r: 74, offset: Math.PI / 8 },
  ];
  for (const ring of rings) {
    for (let i = 0; i < 4; i++) {
      const a = ring.offset + (i / 4) * Math.PI * 2;
      spots.push({
        x: Math.round(Math.cos(a) * ring.r * 10) / 10,
        z: Math.round(Math.sin(a) * ring.r * 10) / 10,
      });
    }
  }
  return spots;
})();

// ---------- 玩家在 BOSS 战中的道具改写表 ----------
// damage：命中 BOSS 的伤害；duration：控制类效果持续时间
// range：弹道最大飞行距离（米，不填 = 无限追）；shots/gap：齐射数与出手间隔
// ramMul：撞船伤害倍率（只在 ramcrest 用）；stagger：命中直接追加的破韧值
export const BOSS_ITEM_BEHAVIOR = {
  nitro: { desc: '瞬间加速。撞 BOSS 伤害翻倍的前提' },
  bomb: { damage: 180, desc: '直冲 BOSS 的水雷，命中 180 伤害' },
  missile: { damage: 200, slow: 3, desc: '锁定 BOSS，命中 200 伤害并减速 3 秒' },
  fish: {
    // 2026-11-22：没小怪时 120 太亏，抬到 180；小怪撕咬单独给 minionDamage，
    // 不再用 damage×2 推导，免得改 BOSS 伤害时顺手把小怪伤害也翻了倍。
    damage: 180, minionDamage: 240,
    desc: '对 BOSS 造成 180 伤害，并撕咬船附近的小怪（240）',
  },
  vortex: {
    damage: 160, bubble: 2.5,
    desc: '水泡把 BOSS 困在半空 2.5 秒：期间不能起新技能，玩家照常输出',
  },
  ink: { damage: 40, duration: 4, desc: '打断 BOSS 当前读条 + 40 伤害 + 沉默 4 秒' },
  shield: { duration: 3, desc: '3 秒免疫一切伤害（只保护自己）' },
  angel: { duration: 3, desc: '全队 3 秒无敌 + 清除负面 + 小加速（含 AI 队友）' },
  weakspot: { damage: 100, duration: 4, desc: '命中后 BOSS 虚弱 4 秒：受到伤害 ×1.6、破韧累积 ×2' },
  // 2026-11-13 新增四件。设计意图：现在伤害天花板只有 200（导弹），
  // 打 BOSS 最优解是绕圈溜，所以补「贴脸高风险高回报」和「主动撞船」两条路。
  harpoon: {
    damage: 340, range: 32, duration: 2.5,
    desc: '32 米内命中 340 伤害，并打开 2.5 秒破甲窗口（超出射程直接空）',
  },
  barrage: {
    damage: 130, shots: 3, gap: 2,
    // gap 这里是「弹速增量」而不是秒：三发同时出手，速度依次 44/46/48，
    // 依次到达就是三连爆，不用引入发射队列状态。
    desc: '一次打出三发深水弹，每发 130 伤害',
  },
  thunderrod: {
    damage: 260, duration: 3, stagger: 90,
    desc: '引雷劈中 BOSS：260 伤害 + 沉默 3 秒，并追加 90 点破韧',
  },
  ramcrest: {
    duration: 8, ramMul: 3, ramCdScale: 0.55,
    desc: '8 秒内撞 BOSS 伤害 ×3、撞击冷却缩短，撞完不被弹开',
  },
  // ---------- 2026-11-22 新增（用户指定）----------
  icecage: {
    damage: 80, duration: 2.6, silence: 1.8,
    desc: '寒冰牢笼：80 伤害 + 定身 2.6 秒 + 沉默 1.8 秒',
  },
  beacon: {
    heal: 40, revive: 0.45, range: 0,
    desc: '救援信标：立即救起倒地的队友（45% 血量，不消耗复活次数），否则全队回 40 血',
  },
  synergy: {
    duration: 6,
    desc: '协同伙伴：队伍协同值瞬间拉满，6 秒内不衰减',
  },
};

// ---------- 关卡评级 ----------
// score = 用时得分（60%）+ 剩余复活次数得分（40%）
export function gradeStage(elapsed, revivesLeft, maxRevives, totalStages, stage) {
  // 用时基准：每关 60 秒为满分线，线性衰减到 180 秒为 0 分
  const timeScore = Math.max(0, Math.min(1, (180 - elapsed) / 120));
  const reviveScore = maxRevives > 0 ? revivesLeft / maxRevives : 0;
  const score = timeScore * 0.6 + reviveScore * 0.4;
  if (score >= 0.85) return 'S';
  if (score >= 0.65) return 'A';
  if (score >= 0.4) return 'B';
  return 'C';
}
