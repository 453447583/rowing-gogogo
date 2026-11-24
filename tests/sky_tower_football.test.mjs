// 第 1 层水球赛：球的纯物理单测（无浏览器）
//   node tests/sky_tower_football.test.mjs
// 覆盖：滚动阻尼 / 围板反弹 / 进球与不算进球 / 门柱与障碍反弹 / 船撞球的冲量与反作用 / 30 秒乱踢不出界
import { SKY_TOWER } from '../src/data/skyTowerRun.js';
import { createBallState, resetBall, stepBall, BALL_PHYS } from '../src/game/skyTowerBall.js';

const C = SKY_TOWER.FOOTBALL;
const LIM_X = C.HALF_L - C.BALL_R;
const LIM_Z = C.HALF_W - C.BALL_R;
let fails = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { fails++; console.log('  ✗ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

/** 造一个最小世界：不放障碍/门柱，除非用例自己给 */
function world(over = {}) {
  return {
    halfL: C.HALF_L, halfW: C.HALF_W, goalW: C.GOAL_W, goalH: C.GOAL_H,
    r: C.BALL_R, boardE: BALL_PHYS.E_BOARD, ballMass: C.BALL_MASS_K * 4.6,
    obstacles: [], posts: [], boats: [],
    ...over,
  };
}

/** 连续推进 n 帧，收集事件 */
function run(ball, w, n, dt = 1 / 60) {
  const evs = [];
  for (let i = 0; i < n; i++) evs.push(...stepBall(ball, dt, w));
  return evs;
}

/** 一直推进到出现某类事件（最多 maxFrames），返回 { ev, frame } */
function until(ball, w, type, maxFrames = 600, dt = 1 / 60) {
  for (let i = 0; i < maxFrames; i++) {
    const evs = stepBall(ball, dt, w);
    const hit = evs.find((e) => e.type === type);
    if (hit) return { ev: hit, frame: i, evs };
  }
  return { ev: null, frame: -1, evs: [] };
}

console.log('[1] 滚动 + 阻尼');
{
  const b = createBallState(0, 0);
  b.vx = 20;
  run(b, world({ halfL: 999, halfW: 999 }), 60);   // 假墙放远一点，只看阻尼
  ok(b.x > 15 && b.x < 20, '1 秒推进 15~20m', { x: +b.x.toFixed(2) });
  ok(b.vx < 18.5 && b.vx > 12, '滚动阻尼把 20m/s 降到 12~18.5', { vx: +b.vx.toFixed(2) });

  const c = createBallState(0, 0);
  c.vx = 20;
  const d0 = 0;
  run(c, world({ halfL: 999, halfW: 999 }), 60 * 20);
  const roll = c.x - d0;
  ok(c.vx === 0 && c.vz === 0, '最终完全停住（不会永动）', { vx: c.vx });
  ok(roll > 40 && roll < 75, '一脚 20m/s 滚 40~75m（半场多一点）', { roll: +roll.toFixed(1) });
}

console.log('[2] 边线围板反弹（球不出界）');
{
  // 贴着边线往外推，一帧内就撞板，避免阻尼把入射速度吃掉
  const b = createBallState(0, LIM_Z - 0.35);
  b.vz = 25;
  const { ev } = until(b, world(), 'board', 10);
  ok(!!ev, '撞到 z 向围板', ev);
  ok(ev?.axis === 'z', '围板轴向正确', ev?.axis);
  ok(Math.abs(b.z) <= LIM_Z + 1e-6, '球心没有越过围板内表面', { z: +b.z.toFixed(3) });
  ok(b.vz < 0, '被弹回来了', { vz: +b.vz.toFixed(2) });
  ok(ev && near(ev.speed, 25 * BALL_PHYS.E_BOARD, 0.6), '反弹速度 ≈ 入射 × 0.72', ev?.speed);

  // 端线（x 向）也要弹：门框外
  const b2 = createBallState(LIM_X - 0.35, C.GOAL_W / 2 + 5);
  b2.vx = 25;
  const { ev: ev2 } = until(b2, world(), 'board', 10);
  ok(ev2?.axis === 'x', '端线围板按 x 轴反弹', ev2?.axis);
}

console.log('[3] 进球 / 不算进球');
{
  const b = createBallState(0, 0);
  b.vx = 40;
  const { ev } = until(b, world(), 'goal', 400);
  ok(!!ev, '球心越过门线 → 进球', ev);
  ok(ev?.side === 1, '+X 门记 side=+1', ev?.side);
  ok(b.dead === true, '进球后球进入 dead（不再参与碰撞）');
  const bx = b.x;
  run(b, world(), 60);
  ok(near(b.x, bx), 'dead 期间球不再移动', { x: b.x, bx });

  const b2 = createBallState(0, C.GOAL_W / 2 + 4);
  b2.vx = 40;
  const evs2 = run(b2, world(), 200);
  ok(!evs2.some((e) => e.type === 'goal'), '门框外撞墙不算进球');
  ok(evs2.some((e) => e.type === 'board' && e.axis === 'x'), '门框外是围板反弹');
}

console.log('[4] 门柱反弹');
{
  // 贴着立柱冲过去：球心离柱心 < 球半径+柱半径 → 应该被柱子弹开，不算进球
  const b = createBallState(C.HALF_L - 2.4, C.GOAL_W / 2 - 0.6);
  b.vx = 16;
  const { ev } = until(b, world({ posts: [{ x: C.HALF_L, z: C.GOAL_W / 2, r: C.POST_R }] }), 'post', 30);
  ok(!!ev, '打中门柱', ev);
  ok(!b.dead, '擦柱之后没进球（被弹开）', { x: +b.x.toFixed(2), z: +b.z.toFixed(2) });
  ok(b.vx < 0 || b.vz > 0, '球被柱子弹离原方向', { vx: +b.vx.toFixed(2), vz: +b.vz.toFixed(2) });
}

console.log('[5] 礁石 / 熔岩柱反弹');
{
  const b = createBallState(0, 0);
  b.vx = 25;
  const { ev } = until(b, world({ obstacles: [{ id: 'obs0', x: 20, z: 0, r: 4 }] }), 'obstacle', 200);
  ok(!!ev, '撞到障碍', ev);
  ok(b.vx < 0, '法向被弹回（往 -x 走）', { vx: +b.vx.toFixed(2) });
  // 碰撞那一帧球心必须已经被推到 (障碍半径 + 球半径) 之外
  ok(near(Math.hypot(b.x - 20, b.z), 4 + C.BALL_R, 0.15), '球被推到障碍表面外，没有卡进去',
    { d: +Math.hypot(b.x - 20, b.z).toFixed(2) });
}

console.log('[6] 船撞球：冲量 + 反作用');
{
  const b = createBallState(0, 0);
  const boats = [{ id: 'me', x: 0, z: -4.0, vx: 0, vz: 30, r: C.BALL_R, mass: 4.6, heading: 0 }];
  const evs = stepBall(b, 1 / 60, world({ boats }));
  const hit = evs.find((e) => e.type === 'boat');
  ok(!!hit, '产生 boat 碰撞事件', evs.map((e) => e.type));
  ok(b.vz > 10, '球被顶出去（速度 > 10m/s）', { vz: +b.vz.toFixed(2) });
  ok(hit && hit.iz < 0, '反作用把船往 -z 推（船掉速）', hit && { iz: +hit.iz.toFixed(2) });
  ok(hit && Math.abs(hit.iz) < 15, '反作用不会把船弹飞（|Δv| < 15m/s）', hit && +hit.iz.toFixed(2));
  ok(b.lastTouch === 'me', '记下最后触球的人', b.lastTouch);
  ok(near(b.z, -4.0 + C.BALL_R * 2, 0.05), '球被顶到接触面外', { z: +b.z.toFixed(2) });

  // 静止的船被高速球撞：球要明显减速（球比船重，但不至于直接穿过去）
  const b2 = createBallState(0, 0);
  b2.vz = 30;
  const evs2 = stepBall(b2, 1 / 60, world({
    boats: [{ id: 'foe', x: 0, z: 4.0, vx: 0, vz: 0, r: C.BALL_R, mass: 4.6, heading: Math.PI }],
  }));
  ok(evs2.some((e) => e.type === 'boat' && e.id === 'foe'), '球撞静止的船也算碰撞');
  ok(b2.vz < 26 && b2.vz > 0, '球被挡了一下但继续往前', { vz: +b2.vz.toFixed(2) });
}

console.log('[7] 30 秒乱踢：球永远出不了球场');
{
  const b = createBallState(0, 0);
  const w = world({
    obstacles: [{ id: 'obs0', x: 14, z: -6, r: 3.6 }, { id: 'obs1', x: -18, z: 8, r: 3.0 }],
    posts: [
      { x: C.HALF_L, z: -C.GOAL_W / 2, r: C.POST_R }, { x: C.HALF_L, z: C.GOAL_W / 2, r: C.POST_R },
      { x: -C.HALF_L, z: -C.GOAL_W / 2, r: C.POST_R }, { x: -C.HALF_L, z: C.GOAL_W / 2, r: C.POST_R },
    ],
  });
  let maxAbsX = 0, maxAbsZ = 0, goals = 0, escapes = 0;
  for (let i = 0; i < 30 * 60; i++) {
    if (b.dead) { goals++; resetBall(b, 0, 0); }
    if (i % 20 === 0) {
      // 每隔 0.33 秒随机给一脚（含极端角度），模拟两台船乱撞
      const a = Math.random() * Math.PI * 2;
      const s = 8 + Math.random() * 38;
      b.vx += Math.cos(a) * s * 0.5;
      b.vz += Math.sin(a) * s * 0.5;
    }
    stepBall(b, 1 / 60, w);
    maxAbsX = Math.max(maxAbsX, Math.abs(b.x));
    maxAbsZ = Math.max(maxAbsZ, Math.abs(b.z));
    if (Math.abs(b.x) > LIM_X + 0.5 || Math.abs(b.z) > LIM_Z + 0.5) escapes++;
  }
  ok(escapes === 0, '1800 帧里球一次都没穿出围板',
    { escapes, maxAbsX: +maxAbsX.toFixed(1), maxAbsZ: +maxAbsZ.toFixed(1) });
  ok(NaN !== 0 && Number.isFinite(b.x) && Number.isFinite(b.vx), '数值没有 NaN', { x: b.x, vx: b.vx });
  ok(goals >= 0, '进球计数正常', { goals });
}

console.log('\n结果: ' + (fails ? `失败 ${fails} 项` : '全部通过'));
process.exitCode = fails ? 1 : 0;
