// 波浪系统：JS 与 GLSL 共用同一套参数，保证视觉与物理一致
// h(x,z,t) = Σ amp * sin( (x*dx + z*dz) * k - t * speed )
//
// 设计目标（竞速 / 道具水面）：
//   - 大长涌浪：晴天总振幅约 0.9m（峰谷 ≈ 1.8m），暴风雨再乘天气倍率；
//     峰谷压到船高两倍以内，浮桶/赛艇不会被浪峰整块遮住；
//   - 波长都大于水面网格间距（700m / 192 ≈ 3.65m）的两倍，避免顶点混叠；
//   - JS 侧提供坡度、垂直速度、涌流三个采样，船体、腾空、横向推挤全部同源。
//
// 大浪只在竞速 / 道具模式启用：怪物 / 竞技场 / 弹射模式走平静海面，
// 由 setBigWaves() 统一切换，水面着色器与船体物理同时生效。

export const WAVE_PARAMS = [
  // [dirX, dirZ, amplitude, wavelength, speed]
  // 总振幅 0.91m：涌浪感保留，但浪峰不再高过船身把赛道/浮桶整块盖住
  [0.82, 0.57, 0.36, 52.0, 1.05], // 主涌浪：波长最长，负责把船整体抬起来
  [-0.45, 0.89, 0.25, 29.0, 1.35],
  [0.96, -0.28, 0.16, 17.0, 1.95],
  [-0.66, -0.75, 0.09, 11.0, 2.50],
  [0.20, -0.98, 0.05, 7.0, 3.10],
];

export const WAVE_AMP_SUM = WAVE_PARAMS.reduce((s, w) => s + w[2], 0);

const K = WAVE_PARAMS.map((w) => (Math.PI * 2) / w[3]);

// 非竞速/道具模式（怪物、竞技场、弹射）的平静海面倍率：
// 新波形总振幅约 0.91，乘 0.34 ≈ 0.31，和改动前的手感基本一致。
export const CALM_WAVE_SCALE = 0.34;
// 竞速/道具允许的最大倍率：暴风雨 2.4 → 峰谷约 4.4m
const MAX_WAVE_SCALE = 2.4;

let bigWaves = true;
/** 是否启用海啸级大浪（只有竞速 / 道具模式为 true） */
export function setBigWaves(on) {
  bigWaves = !!on;
  // 切换模式时立即把当前倍率收敛到对应档位，避免沿用上一局的浪高
  waveScale = clampWaveScale(waveScale);
}

/** 当前模式允许的波浪倍率（水面 GLSL 与船体物理共用） */
export function clampWaveScale(v) {
  const s = Math.min(MAX_WAVE_SCALE, Math.max(0.4, v || 1));
  return bigWaves ? s : CALM_WAVE_SCALE;
}

let waveScale = 1.0;
export function setWaveScale(v) {
  waveScale = clampWaveScale(v);
}
export function getWaveScale() {
  return waveScale;
}

/** 当前模式 / 天气下的总波幅（GLSL 泡沫归一化、腾空判定共用） */
export function waveAmpSum() {
  return WAVE_AMP_SUM * waveScale;
}

/** 水面高度（世界坐标） */
export function waveHeight(x, z, t) {
  let h = 0;
  for (let i = 0; i < WAVE_PARAMS.length; i++) {
    const w = WAVE_PARAMS[i];
    const phase = (x * w[0] + z * w[1]) * K[i] - t * w[4];
    h += w[2] * Math.sin(phase);
  }
  return h * waveScale;
}

/** 水面坡度（用于艇身倾斜），返回 [dh/dx, dh/dz] */
export function waveSlope(x, z, t) {
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < WAVE_PARAMS.length; i++) {
    const w = WAVE_PARAMS[i];
    const phase = (x * w[0] + z * w[1]) * K[i] - t * w[4];
    const c = w[2] * K[i] * Math.cos(phase);
    dx += c * w[0];
    dz += c * w[1];
  }
  return [dx * waveScale, dz * waveScale];
}

/**
 * 船体所在水面的垂直变化率 dh/dt（含"船在波面上移动"的贡献）。
 * 冲上浪尖时为正、从浪尖滑下时为负，用来判定是否被浪抛起。
 * vx/vz 是船的水平速度（m/s）。
 */
export function waveVerticalRate(x, z, t, vx = 0, vz = 0) {
  let rate = 0;
  for (let i = 0; i < WAVE_PARAMS.length; i++) {
    const w = WAVE_PARAMS[i];
    const phase = (x * w[0] + z * w[1]) * K[i] - t * w[4];
    const cos = Math.cos(phase);
    // d/dt sin(phase) = cos(phase) * (k * (dir·v) - speed)
    rate += w[2] * cos * (K[i] * (w[0] * vx + w[1] * vz) - w[4]);
  }
  return rate * waveScale;
}

/**
 * 涌流场（m/s）：低频阵风 + 交叉波向，给船一个左右/前后的缓慢推挤。
 * 强度随当地波高抬升，浪尖处推得更明显，读起来是"浪在搬船"而不是隐形逆流。
 */
export function waveCurrent(x, z, t) {
  const s = waveScale;
  const gust = 0.55 + 0.45 * Math.sin(t * 0.21 + x * 0.012 + z * 0.009);
  const hn = Math.max(-1, Math.min(1, (waveHeight(x, z, t) / Math.max(waveAmpSum(), 1e-3))));
  const boost = 0.55 + 0.45 * hn;
  const u = (Math.sin(z * 0.052 + t * 0.42) * 0.62
    + Math.sin(z * 0.108 - x * 0.017 + t * 0.87) * 0.30) * 1.15 * s * gust * boost;
  const v = (Math.cos(x * 0.047 - t * 0.37) * 0.62
    + Math.sin(x * 0.086 + z * 0.026 - t * 0.71) * 0.30) * 1.15 * s * gust * boost;
  return [u, v];
}

/** 生成 GLSL 端的波浪 uniform 值（vec4 数组: dirX, dirZ, k, amp） */
export function waveUniforms() {
  return WAVE_PARAMS.map((w, i) => ({
    dirX: w[0], dirZ: w[1], k: K[i], amp: w[2], speed: w[4],
  }));
}
