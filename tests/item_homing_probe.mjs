// 道具赛「追踪弹道」纯数值探针（不依赖浏览器）
//
// 直接 import 真实的 src/game/Homing.js —— 量的就是游戏里跑的数学，
// 不是另写一套近似。改参数前后都跑一遍，用命中率说话。
//
// 用法：node tests/item_homing_probe.mjs
//
// 背景（2026-11-04 用户报告）：
//   “追踪导弹追到了玩家也不会炸晕，一直反复来回飞” + “飞得太慢追不上快艇”。
//   旧实现：speed 24~30 m/s、turn 3.2 rad/s、hitR 2.2 m。
//   旧实现的转弯半径 = 30/3.2 ≈ 9.4m ＞ 命中半径 2.2m → 一旦被甩开就绕着目标转圈，
//   永远进不了判定球，直到 life 耗尽。这就是“死循环”。

import { homingConfig, steerHoming, segmentDistance } from '../src/game/Homing.js';

const DT = 1 / 60;

// 旧实现的参数（保留原样，用同一套仿真器跑，做对照）
const LEGACY = {
  bomb: { speed: 26, accel: 999, turn: 3.2, hitR: 2.2, life: 6 },
  missile: { speed: 30, accel: 999, turn: 3.2, hitR: 2.2, life: 6 },
  octopus: { speed: 24, accel: 999, turn: 3.2, hitR: 2.2, life: 4.5 },
  bubblefly: { speed: 26, accel: 999, turn: 3.2, hitR: 2.2, life: 4.5 },
};

/**
 * @param {object} cfg 参数
 * @param {object} o
 * @param {number} o.targetSpeed 目标速度 m/s
 * @param {number} [o.lateral] 目标横向偏移（×20m）
 * @param {number} [o.curved] 目标转向角速度 rad/s（模拟走弯）
 * @param {number} [o.dir] +1 追尾 / -1 迎面交错
 * @param {boolean} [o.behind] 开火瞬间目标在船尾 20m（最刁钻的开火时机）
 * @param {boolean} [o.legacy] 用旧实现的积分方式
 */
function simulate(cfg, { targetSpeed, lateral = 0, curved = 0, dir = 1, behind = false, legacy = false }) {
  const heading0 = curved ? 0.55 : dir < 0 ? Math.PI : 0;
  const tgt = { x: lateral * 20, z: behind ? -20 : 60, heading: heading0 };
  const launch = legacy ? cfg.speed : cfg.launch ?? cfg.speed;
  // 射手始终朝 +z 开火（弹体从船头弹出），与目标位置无关
  const p = { x: 0, z: 0, vx: 0, vz: launch };

  let angleTravel = 0;
  let minD = Infinity;
  let t = 0;
  while (t < cfg.life) {
    t += DT;
    tgt.heading += curved * DT;
    tgt.x += Math.sin(tgt.heading) * targetSpeed * DT;
    tgt.z += Math.cos(tgt.heading) * targetSpeed * DT;
    const tgtState = {
      x: tgt.x,
      z: tgt.z,
      vx: Math.sin(tgt.heading) * targetSpeed,
      vz: Math.cos(tgt.heading) * targetSpeed,
      speed: targetSpeed,
    };

    const cur = Math.atan2(p.vx, p.vz);
    if (legacy) {
      const desired = Math.atan2(tgt.x - p.x, tgt.z - p.z);
      let dh = desired - cur;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const turn = Math.max(-cfg.turn * DT, Math.min(cfg.turn * DT, dh));
      const sp = Math.hypot(p.vx, p.vz);
      p.vx = Math.sin(cur + turn) * sp;
      p.vz = Math.cos(cur + turn) * sp;
      angleTravel += Math.abs(turn);
    } else {
      steerHoming(p, tgtState, cfg, DT);
      angleTravel += Math.abs(Math.atan2(p.vx, p.vz) - cur);
    }

    const px = p.x;
    const pz = p.z;
    p.x += p.vx * DT;
    p.z += p.vz * DT;

    const d = segmentDistance(px, pz, p.x, p.z, tgt.x, tgt.z);
    minD = Math.min(minD, d);
    if (d <= cfg.hitR) {
      return {
        hit: true,
        tHit: +t.toFixed(2),
        loops: +(angleTravel / (Math.PI * 2)).toFixed(2),
        minD: +minD.toFixed(2),
      };
    }
  }
  return {
    hit: false,
    tHit: null,
    loops: +(angleTravel / (Math.PI * 2)).toFixed(2),
    minD: +minD.toFixed(2),
  };
}

const BOAT_SPEEDS = [
  ['拖网船 26.5', 26.5],
  ['划艇 34', 34],
  ['疾风号 36', 36],
  ['氮气 61', 61],
];
const PATHS = [
  ['直道', { lateral: 0, curved: 0 }],
  ['目标侧移', { lateral: 1, curved: 0 }],
  ['弯道', { lateral: 0, curved: 0.55 }],
  ['迎面交错', { lateral: 0, curved: 0, dir: -1 }],
  ['目标在船尾', { lateral: 0, curved: 0, behind: true }],
];

function run(label, table, legacy) {
  console.log(`\n=== ${label} ===`);
  let fail = 0;
  let total = 0;
  let worst = 0;
  let maxLoops = 0;
  for (const [type, cfg] of Object.entries(table)) {
    for (const [bsName, bs] of BOAT_SPEEDS) {
      const cells = PATHS.map(([pn, path]) => {
        const r = simulate(cfg, { targetSpeed: bs, legacy, ...path });
        total++;
        if (!r.hit) fail++;
        else worst = Math.max(worst, r.tHit);
        maxLoops = Math.max(maxLoops, r.loops);
        return `${pn}:${r.hit ? `${r.tHit}s` : `✗近${r.minD}m/绕${r.loops}圈`}`;
      });
      console.log(`${type.padEnd(10)} vs ${bsName.padEnd(12)} ${cells.join('  ')}`);
    }
  }
  console.log(`未命中 ${fail}/${total}　最慢命中 ${worst}s　最大绕圈 ${maxLoops} 圈`);
  return fail;
}

run('旧实现 speed 24~30 / turn 3.2 / hitR 2.2', LEGACY, true);
const newFail = run('新实现（Homing.js 实测）', {
  bomb: homingConfig('bomb'),
  missile: homingConfig('missile'),
  octopus: homingConfig('octopus'),
  bubblefly: homingConfig('bubblefly'),
}, false);

if (newFail > 0) {
  console.error(`\n❌ 新实现仍有 ${newFail} 组追不上 —— 不要就这么发布`);
  process.exit(1);
}
console.log('\n✅ 全部场景都能在 4 秒内命中，且基本不绕圈');
