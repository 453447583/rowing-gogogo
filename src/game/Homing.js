// 追踪弹道数学（炸弹 / 导弹 / 章鱼 / 泡泡蜻蜓共用）
//
// 为什么单独抽出来：
//   1. Items.js 里的 #updateProjectiles 是私有方法，纯数值没法脱离浏览器验证；
//   2. 追踪参数（速度/转向/命中半径）原来是散在 useItem 里的魔法数字，
//      改一处漏一处（炸弹 26、导弹 30、章鱼 24、蜻蜓 26，全是随手写的）；
//   3. tests/item_homing_probe.mjs 直接 import 这个文件跑纯 node 仿真，
//      改参数前先量命中率，不靠眼睛看。
//
// 2026-11-04 修的三个硬伤（用户报的“追上了不炸 / 来回绕 / 追不上”）：
//   A. 速度太低：26~30 m/s = 94~108 km/h，而赛艇极速 26.5~36 m/s、氮气 61 m/s，
//      追踪弹从正后方发射时永远追不上（纯 node 仿真：48 组场景 0 命中）。
//   B. 转向半径 > 命中半径：turnRate 3.2 rad/s、速度 30 → 转弯半径 9.4m，
//      而命中判定只有 2.2m。弹体一旦被目标甩开，就绕着目标匀速转圈，永远进不了判定球，
//      直到 life 耗尽 —— 这就是“反复来回飞”的死循环。
//   C. 无提前量：只朝目标“当前位置”飞，目标一转弯就得重新绕。

/** 每种追踪弹的飞行参数。launch = 出手瞬间初速，会按 accel 加速到 speed。 */
export const HOMING_DEFS = {
  // 深水炸弹：慢一点、飘一点（贴水面跳弹感），命中即炸沉
  bomb: { launch: 30, speed: 62, accel: 40, turn: 6.4, hitR: 3.4, life: 8.5, gain: 36, hover: 0.6 },
  // 追踪导弹：最快、最莽，命中减速
  missile: { launch: 34, speed: 80, accel: 56, turn: 7.6, hitR: 3.6, life: 8.0, gain: 40, hover: 1.2 },
  // 章鱼怪：中速，命中缠身
  octopus: { launch: 28, speed: 62, accel: 38, turn: 5.8, hitR: 3.4, life: 8.0, gain: 36, hover: 1.6 },
  // 泡泡蜻蜓：比导弹稍慢，轻盈
  bubblefly: { launch: 30, speed: 66, accel: 40, turn: 6.2, hitR: 3.4, life: 8.0, gain: 36, hover: 1.6 },
  // 血枪狙击：**不追踪**（lead:false、turn:0），出手时朝第一名方向锁死直线飞出去。
  // 这里登记它只是为了复用 #updateProjectiles 里的 hover / hitR / life 取数，
  // 免得在 useItem 里再写一套魔法数字。命中判定走「穿透」，见 Items.js 的 p.pierce。
  bloodlance: { launch: 110, speed: 110, accel: 0, turn: 0, hitR: 2.6, life: 0.58, gain: 0, hover: 0.95, lead: false },
};

export function homingConfig(type) {
  return HOMING_DEFS[type] || null;
}

const MIN_SPEED = 8;

/**
 * 推进一帧追踪转向。
 *
 * @param {{x:number,z:number,vx:number,vz:number}} p 弹体（就地修改 vx/vz）
 * @param {{x:number,z:number,vx?:number,vz?:number,speed?:number}} target 目标位置与速度
 * @param {object} cfg HOMING_DEFS 里的一项
 * @param {number} dt 帧间隔
 * @returns {{dist:number, err:number}} 本帧距离 / 剩余角度误差（弧度），给调用方做近炸/特效判断
 */
export function steerHoming(p, target, cfg, dt) {
  const sp = Math.hypot(p.vx, p.vz) || 0;
  const dx = target.x - p.x;
  const dz = target.z - p.z;
  const dist = Math.hypot(dx, dz) || 0.001;

  const tvx = target.vx || 0;
  const tvz = target.vz || 0;
  const tSpeed = target.speed != null ? target.speed : Math.hypot(tvx, tvz);

  let aimX = target.x;
  let aimZ = target.z;
  if (cfg.lead !== false) {
    // 提前量（迭代求拦截时间）：t = |目标 + v·t − 弹| / 弹速。
    // 单次 t=dist/速度 会在“迎面高速交错”时算出一个远在弹体背后的假想点，
    // 弹体于是原地掉头，目标却已经飞过去了 —— 会诱发无限绕圈。
    // 迭代两次就能收敛到真实拦截时刻。
    let tEst = dist / Math.max(sp, MIN_SPEED);
    for (let k = 0; k < 3; k++) {
      const ax = target.x + tvx * tEst - p.x;
      const az = target.z + tvz * tEst - p.z;
      tEst = Math.hypot(ax, az) / Math.max(sp, MIN_SPEED);
      if (tEst > 3) { tEst = 3; break; }
    }
    // 拦截点必须在弹体前方，否则退回“直接朝目标”——否则目标明明在后面，
    // 弹体却以为它马上会跑到前面去，于是一路加速远离（本项目的真 bug）。
    const dotAim = (target.x + tvx * tEst - p.x) * p.vx + (target.z + tvz * tEst - p.z) * p.vz;
    if (dotAim > 0) {
      aimX = target.x + tvx * tEst;
      aimZ = target.z + tvz * tEst;
    }
  }

  const desired = Math.atan2(aimX - p.x, aimZ - p.z);
  const cur = Math.atan2(p.vx, p.vz);
  let dh = desired - cur;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  const err = Math.abs(dh);

  // 目标速度必须被“追上”，否则落在后面等到 life 耗尽也不会命中。
  // gain = 保证的接近速度余量（m/s）。
  const chase = Math.max(cfg.speed, tSpeed + cfg.gain);
  // 大角度机动时收油：转弯半径 = 速度/角速度，不收油就永远大于命中半径 → 绕圈。
  const slow = 1 - 0.62 * Math.min(1, err / (Math.PI * 0.5));
  const want = Math.max(MIN_SPEED, chase * slow);
  const dv = Math.min(Math.abs(want - sp), (cfg.accel || 30) * dt);
  const newSp = sp + (want >= sp ? dv : -dv);

  const maxTurn = (cfg.turn || 6) * dt;
  const turn = dh > maxTurn ? maxTurn : dh < -maxTurn ? -maxTurn : dh;
  const na = cur + turn;
  p.vx = Math.sin(na) * newSp;
  p.vz = Math.cos(na) * newSp;

  return { dist, err, speed: newSp };
}

/**
 * 线段 vs 圆：高速弹体一帧能走 1~2m，只判“当前位置”会穿透。
 * 返回线段到圆心的最近距离（<=r 即命中）。
 */
export function segmentDistance(ax, az, bx, bz, cx, cz) {
  const sx = bx - ax;
  const sz = bz - az;
  const len2 = sx * sx + sz * sz;
  if (len2 < 1e-8) return Math.hypot(cx - ax, cz - az);
  let u = ((cx - ax) * sx + (cz - az) * sz) / len2;
  if (u < 0) u = 0;
  else if (u > 1) u = 1;
  return Math.hypot(ax + sx * u - cx, az + sz * u - cz);
}
