// 5 头 BOSS 的专属包围光环配置（只被 game/BossAura.js 读取）。
// 数值全部相对 BOSS 自身尺寸：scale/radius 是 def.radius 的倍数，y/size/back 是 def.height 的倍数。
// 想换配色或调强弱只改这里，绘制逻辑不用动。
//
// 统一四层：
//   ground  地面法阵（两层反向旋转符文 + 外边界环 + 周期扩散环）
//   orbit   环绕粒子（火星 / 火球 / 电弧 / 血雾 / 光羽）
//   column  跟随 BOSS 的背后竖向法阵（面向相机的 billboard）
//   signature 招牌演出（地脉喷发 / 火球爆发 / 落雷 / 心跳 / 圣光冲击）
//
// phase2 在血量跌破 1/3 时由 Boss 调用 setPhase(2) 生效；
// hex 是海克斯深渊变体叠加的暗紫色层。

const HEX_TINT = 0x7a46c8;

/** 兜底配置：BOSS 表里新增 id 但忘了写光环时，至少还有一圈主题环 */
const FALLBACK = {
  style: 'lava',
  tint: 0xff3b1f,
  accent: 0xff9a3c,
  glow: 0xffe08a,
  eye: 0xff4a1e,
  weak: { ring: 0xffb066, core: 0xffe0a0 },
  ground: {
    outer: { scale: 3.4, spin: 0.14, opacity: 0.5 },
    inner: { scale: 2.2, spin: -0.3, opacity: 0.38 },
    ring: { radius: 1.36, width: 0.1, opacity: 0.5 },
    pulse: { every: 7, from: 1.36, to: 2.8, life: 1.2, opacity: 0.5 },
  },
  orbit: {
    kind: 'ember',
    embers: { count: 60, radius: 1.05, speed: 1, size: 0.6, rise: 1, color: 0xff9a3c },
  },
  column: { size: 1.5, y: 0.62, back: 1.05, spin: 0.1, opacity: 0.55 },
  signature: { kind: 'eruption', every: 7, count: 14 },
  phase2: { intensity: 1.45, tint: 0xff6a2e, accent: 0xffc060 },
  hex: { tint: HEX_TINT, opacity: 0.3 },
  death: { color: 0xffe0a0, glow: 0xff5a2a },
};

export const BOSS_AURAS = {
  // 第一关：深渊火龙 —— 熔岩地脉 / 古龙苏醒
  dragon_deep: {
    ...FALLBACK,
    style: 'lava',
    tint: 0xff3b1f,
    accent: 0xff9a3c,
    glow: 0xffe08a,
    eye: 0xff4a1e,
    weak: { ring: 0xffb066, core: 0xffe0a0 },
    ground: {
      outer: { scale: 3.5, spin: 0.13, opacity: 0.55, color: 0xff3b1f },
      inner: { scale: 2.25, spin: -0.3, opacity: 0.42, color: 0xffb066 },
      ring: { radius: 1.36, width: 0.12, opacity: 0.55, color: 0xff5a2a },
      pulse: { every: 6.5, from: 1.36, to: 2.8, life: 1.2, opacity: 0.55, color: 0xff7a3a },
    },
    orbit: {
      kind: 'ember',
      embers: { count: 80, radius: 1.05, speed: 1.15, size: 0.72, rise: 1.35, color: 0xff9a3c },
    },
    column: { size: 1.55, y: 0.62, back: 1.05, spin: 0.1, opacity: 0.6, color: 0xff5a2a },
    signature: { kind: 'eruption', every: 7, count: 20, color: 0xffc060 },
    phase2: { intensity: 1.45, tint: 0xff7a3a, accent: 0xffd070, glow: 0xfff0b0 },
    death: { color: 0xffc070, glow: 0xff3b1f },
  },

  // 第二关：炎狱火龙 —— 焚海 / 火球环绕（和第一关同模型，必须拉开）
  dragon_inferno: {
    ...FALLBACK,
    style: 'flame',
    tint: 0xff6a28,
    accent: 0xffb060,
    glow: 0xfff2c0,
    eye: 0xffb020,
    weak: { ring: 0xffa040, core: 0xfff2c0 },
    ground: {
      outer: { scale: 3.9, spin: 0.2, opacity: 0.72, color: 0xffa040 },
      inner: { scale: 2.5, spin: -0.42, opacity: 0.55, color: 0xff5a18 },
      ring: { radius: 1.4, width: 0.14, opacity: 0.7, color: 0xffb040 },
      pulse: { every: 5.2, from: 1.4, to: 3.0, life: 1.05, opacity: 0.62, color: 0xffc860 },
    },
    orbit: {
      kind: 'flame',
      embers: { count: 56, radius: 1.1, speed: 1.5, size: 0.66, rise: 1.5, color: 0xffb060 },
      satellites: { count: 4, radius: 1.08, y: 0.5, yVar: 0.14, speed: 1.0, size: 0.42, color: 0xffc060 },
    },
    column: { size: 1.65, y: 0.64, back: 1.12, spin: 0.16, opacity: 0.78, color: 0xff5a10 },
    signature: { kind: 'fireball', every: 5, count: 16, color: 0xffe0a0 },
    phase2: { intensity: 1.55, tint: 0xff8a40, accent: 0xfff0c0, glow: 0xffffff },
    death: { color: 0xfff4c8, glow: 0xff7a20 },
  },

  // 第三关：雷霆龙骑士 —— 雷裁决阵（不再用 ice 雪花）
  knight_thunder: {
    ...FALLBACK,
    style: 'thunder',
    tint: 0x6f8dff,
    accent: 0xbfe4ff,
    glow: 0xeaf4ff,
    eye: 0x9fd8ff,
    weak: { ring: 0x9fd8ff, core: 0xffffff },
    ground: {
      outer: { scale: 3.4, spin: 0.28, opacity: 0.56, color: 0xbfe4ff },
      inner: { scale: 2.2, spin: -0.5, opacity: 0.5, color: 0x6f8dff },
      ring: { radius: 1.38, width: 0.1, opacity: 0.62, color: 0xbfe4ff },
      pulse: { every: 6, from: 1.38, to: 2.9, life: 0.95, opacity: 0.52, color: 0xeaf4ff },
    },
    orbit: {
      kind: 'bolt',
      embers: { count: 44, radius: 1.0, speed: 1.8, size: 0.5, rise: 0.9, color: 0xbfe4ff },
      arcs: { count: 6, segments: 9, refresh: 0.08, color: 0xbfe4ff },
    },
    column: { size: 1.4, y: 0.6, back: 1.05, spin: 0.22, opacity: 0.66, color: 0x9fd0ff },
    signature: { kind: 'skybolt', every: 9, count: 1, color: 0xd8f0ff },
    phase2: { intensity: 1.5, tint: 0x8a90ff, accent: 0xeaf4ff, glow: 0xffffff },
    death: { color: 0xd8f0ff, glow: 0x6f8dff },
  },

  // 第四关：暗夜血魔·终焉 —— 血月心跳
  blood_nightmare: {
    ...FALLBACK,
    style: 'blood',
    tint: 0xc81f3c,
    accent: 0xff5a7a,
    glow: 0xff9bb0,
    eye: 0xff3b5a,
    weak: { ring: 0xff7d92, core: 0xffd0da },
    ground: {
      outer: { scale: 3.7, spin: 0.16, opacity: 0.55, color: 0xc81f3c },
      inner: { scale: 2.4, spin: -0.24, opacity: 0.42, color: 0xff5a7a },
      ring: { radius: 1.42, width: 0.12, opacity: 0.6, color: 0xd82a4a },
      pulse: { every: 4, from: 1.42, to: 3.0, life: 1.0, opacity: 0.5, color: 0xff5a7a },
    },
    orbit: {
      kind: 'blood',
      embers: { count: 70, radius: 1.1, speed: 0.7, size: 0.6, rise: -0.85, color: 0xff5a7a },
      mist: { count: 26, radius: 1.35, size: 2.1, speed: 0.5, color: 0xc81f3c, opacity: 0.22 },
    },
    column: { size: 1.6, y: 0.64, back: 1.1, spin: 0.08, opacity: 0.7, color: 0xd82a4a },
    signature: { kind: 'heartbeat', every: 4, count: 0, color: 0xff7d92 },
    phase2: { intensity: 1.5, tint: 0xff2a4a, accent: 0xff9bb0, glow: 0xffd0da },
    death: { color: 0xffa0b8, glow: 0xc81f3c },
  },

  // 第五关：深渊传令官 —— 六翼圣裁阵（终章，做得最重）
  abyss_herald: {
    ...FALLBACK,
    style: 'holy',
    tint: 0xb9a0ff,
    accent: 0x7a5fd0,
    glow: 0xd8c9ff,
    eye: 0xd8f0ff,
    weak: { ring: 0xd8c9ff, core: 0xffffff },
    ground: {
      outer: { scale: 4.2, spin: 0.12, opacity: 0.72, color: 0xa98aff },
      inner: { scale: 2.6, spin: -0.22, opacity: 0.6, color: 0x6a4fc0 },
      ring: { radius: 1.42, width: 0.1, opacity: 0.72, color: 0xbca4ff },
      pulse: { every: 10, from: 1.42, to: 3.2, life: 1.4, opacity: 0.66, color: 0xbca4ff },
    },
    orbit: {
      kind: 'holy',
      embers: { count: 80, radius: 1.15, speed: 0.9, size: 0.75, rise: 1.1, color: 0xd8c9ff },
      satellites: { count: 3, radius: 1.0, y: 0.56, yVar: 0.22, speed: 0.7, size: 0.34, color: 0xb9a0ff },
    },
    column: { size: 1.85, y: 0.65, back: 1.15, spin: 0.06, opacity: 0.85, color: 0xb497ff },
    signature: { kind: 'shockwave', every: 10, count: 20, color: 0xd8c9ff },
    phase2: { intensity: 1.6, tint: 0xb066ff, accent: 0xd0a0ff, glow: 0xf0e0ff },
    death: { color: 0xe8d8ff, glow: 0xa06cff },
  },
};

export function getBossAura(bossId) {
  return BOSS_AURAS[bossId] || FALLBACK;
}
