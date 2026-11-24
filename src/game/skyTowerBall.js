/**
 * 第 1 层水球赛：球的刚体（纯函数，不 import three / DOM）。
 *
 * 为什么手写而不是上 cannon-es
 * ----------------------------
 * 场上只有三类碰撞：球-矩形围板（两端留球门缺口）、球-圆柱障碍、球-船。
 * 引入物理引擎要额外解决「谁是权威、每帧往引擎塞哪些刚体、船的积分器和引擎怎么对齐」，
 * 而船本身是自写扫掠圆物理（Boat.js 的 vel 直接驱动物理位移），两套积分器放一起必然打架。
 * 这里用冲量法（法向按恢复系数反弹、切向几乎全保留）就够用，而且**全部是纯函数**：
 * 房主跑这一份，客机只收 6 个浮点做插值，不需要确定性锁步。
 *
 * 坐标约定与 Boat 完全一致：x/z 是世界平面，heading 的前向是 (sin, cos)。
 * 球心高度 = 台面 + r + hop，hop 只做视觉弹跳，不参与平面判定
 * （和真实足球一样：球贴地滚的时候，判定就是平面上的一个圆）。
 */

/** 手感常数：这几个数是「球像不像球」的全部，调参先动这里 */
export const BALL_PHYS = {
  DRAG_LIN: 1.9,      // 滚动阻尼（m/s²）：一脚 20m/s 大约滚 70m，正好穿过半场
  DRAG_QUAD: 0.012,   // 二次项：高速长传衰减更快，避免"永动球"
  E_BOARD: 0.72,      // 围板（能量网）恢复系数
  E_OBSTACLE: 0.86,   // 礁石 / 熔岩柱：比围板更弹，撞上去会被"弹射"
  E_BOAT: 0.42,       // 船撞球：偏"推"不偏"弹"，否则一碰就飞、没法带球
  BOAT_PUSH_K: 0.35,  // 反作用给船的比例：撞球让船掉点速，但不是撞墙
  HOP_G: 22,          // 弹跳重力
  HOP_E: 0.38,        // 落地反弹
  HOP_MIN_SPEED: 13,  // 相对法向速度超过这个才起跳（轻碰不起跳）
  HOP_MAX: 3.2,       // 单次起跳初速上限
  MAX_SPEED: 46,      // 球速硬上限：防止连续对撞叠出超音速球
  MIN_SPEED: 0.05,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 新球状态：中圈、静止 */
export function createBallState(x = 0, z = 0) {
  return {
    x, z, vx: 0, vz: 0,
    hop: 0, vy: 0,
    spin: 0, spinX: 1, spinZ: 0,
    lastTouch: null, touchAge: 99,
    goalCd: 0,
    dead: false,        // 进球后到重新开球之间为 true：不参与碰撞、不显示
  };
}

/** 放回中圈（进球后 / 开局） */
export function resetBall(ball, x = 0, z = 0) {
  ball.x = x; ball.z = z;
  ball.vx = 0; ball.vz = 0;
  ball.hop = 0; ball.vy = 0;
  ball.spin = 0;
  ball.dead = false;
  ball.goalCd = 0;
  return ball;
}

/**
 * 推进一帧。
 *
 * @param {object} ball  createBallState() 的产物（就地修改）
 * @param {number} dt    帧时长（s），内部会钳到 ≤50ms（切后台回来不要一步跨过整场）
 * @param {object} w     世界：{
 *   halfL, halfW, goalW, goalH, r, boardE, ballMass,
 *   obstacles: [{ x, z, r }],                                 静态圆柱
 *   posts:     [{ x, z, r }],                                 门柱
 *   boats:     [{ id, x, z, vx, vz, r, mass }]                本层可碰球的船
 * }
 * @returns {Array<object>} 事件：goal / board / obstacle / boat / touch
 */
export function stepBall(ball, dt, w) {
  const ev = [];
  dt = clamp(dt, 0, 0.05);
  if (!(dt > 0) || ball.dead) return ev;

  const P = BALL_PHYS;
  ball.touchAge += dt;
  ball.goalCd = Math.max(0, ball.goalCd - dt);

  // ---------- 1. 平面位移 ----------
  ball.x += ball.vx * dt;
  ball.z += ball.vz * dt;

  // ---------- 2. 滚动阻尼（线性 + 二次）----------
  const sp = Math.hypot(ball.vx, ball.vz);
  if (sp > P.MIN_SPEED) {
    const dec = (P.DRAG_LIN + P.DRAG_QUAD * sp * sp) * dt;
    const k = Math.max(0, sp - dec) / sp;
    ball.vx *= k;
    ball.vz *= k;
  } else if (sp > 0) {
    ball.vx = 0;
    ball.vz = 0;
  }

  // ---------- 3. 静态圆柱（门柱 + 礁石 / 熔岩柱）----------
  // 先解门柱再判进球：球打在立柱上要真的被弹回来，而不是"擦柱算进"。
  const hitCircle = (c, restitution) => {
    const dx = ball.x - c.x;
    const dz = ball.z - c.z;
    const d = Math.hypot(dx, dz);
    const rSum = w.r + c.r;
    if (d >= rSum) return false;
    // 正中命中时方向退化：沿球速反方向弹，别让它卡在圆心
    let nx, nz;
    if (d > 1e-4) { nx = dx / d; nz = dz / d; } else {
      const s = Math.hypot(ball.vx, ball.vz) || 1;
      nx = -ball.vx / s; nz = -ball.vz / s;
    }
    // 位置修正：只推球（石头不动）
    ball.x = c.x + nx * rSum;
    ball.z = c.z + nz * rSum;
    const vn = ball.vx * nx + ball.vz * nz;
    if (vn < 0) {
      // 法向反弹 + 切向轻微摩擦：斜撞会被"抹"向切线滑走，而不是原路弹回
      const tx = ball.vx - vn * nx;
      const tz = ball.vz - vn * nz;
      ball.vx = tx * 0.99 - vn * restitution * nx;
      ball.vz = tz * 0.99 - vn * restitution * nz;
      if (-vn > P.HOP_MIN_SPEED) {
        ball.vy = Math.max(ball.vy, Math.min(P.HOP_MAX, -vn * 0.12));
      }
      return Math.abs(vn);
    }
    return 0;
  };

  for (const p of w.posts || []) {
    const sp2 = hitCircle(p, 0.8);
    if (sp2 > 2) ev.push({ type: 'post', x: p.x, z: p.z, speed: sp2 });
  }
  for (const o of w.obstacles || []) {
    const sp2 = hitCircle(o, P.E_OBSTACLE);
    if (sp2 > 2) ev.push({ type: 'obstacle', id: o.id, x: o.x, z: o.z, speed: sp2 });
  }

  // ---------- 4. 围板 / 球门 ----------
  // 围板内表面就是球场边线：球心最多到 (halfL - r)，再往前就是墙。
  // 门洞范围内（|z| 小于门宽一半）不挡，球心越过这条线就算进球。
  const limX = w.halfL - w.r;
  const limZ = w.halfW - w.r;
  if (Math.abs(ball.x) > limX) {
    const inMouth = Math.abs(ball.z) < w.goalW / 2 - w.r * 0.4 && ball.hop < w.goalH;
    if (inMouth && ball.goalCd <= 0) {
      ev.push({ type: 'goal', side: ball.x > 0 ? 1 : -1, x: ball.x, z: ball.z });
      ball.dead = true;
      ball.goalCd = 1;
      return ev;
    }
    if (!inMouth) {
      ball.x = Math.sign(ball.x) * limX;
      if ((ball.x > 0 && ball.vx > 0) || (ball.x < 0 && ball.vx < 0)) {
        ball.vx = -ball.vx * w.boardE;
        ball.vz *= 0.985;
        ev.push({ type: 'board', axis: 'x', x: ball.x, z: ball.z, speed: Math.abs(ball.vx) });
      }
    }
  }
  if (Math.abs(ball.z) > limZ) {
    ball.z = Math.sign(ball.z) * limZ;
    if ((ball.z > 0 && ball.vz > 0) || (ball.z < 0 && ball.vz < 0)) {
      ball.vz = -ball.vz * w.boardE;
      ball.vx *= 0.985;
      ev.push({ type: 'board', axis: 'z', x: ball.x, z: ball.z, speed: Math.abs(ball.vz) });
    }
  }

  // ---------- 5. 船（冲量解算）----------
  for (const b of w.boats || []) {
    const dx = ball.x - b.x;
    const dz = ball.z - b.z;
    let d = Math.hypot(dx, dz);
    const rSum = w.r + b.r;
    if (d >= rSum) continue;
    let nx, nz;
    if (d > 1e-4) { nx = dx / d; nz = dz / d; } else {
      nx = Math.sin(b.heading || 0); nz = Math.cos(b.heading || 0); d = 1e-4;
    }
    // 球被顶出去（船是主动体，位置不让）
    ball.x = b.x + nx * rSum;
    ball.z = b.z + nz * rSum;
    const rvx = ball.vx - b.vx;
    const rvz = ball.vz - b.vz;
    const vn = rvx * nx + rvz * nz;
    ball.lastTouch = b.id;
    ball.touchAge = 0;
    if (vn < 0) {
      // 1/m1 + 1/m2 的法向冲量：重球吃走大部分速度，轻船撞不动球
      const invM = 1 / w.ballMass + 1 / Math.max(0.5, b.mass);
      const j = -(1 + P.E_BOAT) * vn / invM;
      ball.vx += (nx * j) / w.ballMass;
      ball.vz += (nz * j) / w.ballMass;
      // 反作用：冲量要除以船的质量才是"掉多少速度"，只回传一部分，
      // 否则顶一下球自己就停住，手感很闷
      const back = (j * P.BOAT_PUSH_K) / Math.max(0.5, b.mass);
      ev.push({
        type: 'boat', id: b.id,
        ix: -nx * back, iz: -nz * back,
        speed: -vn,
      });
      if (-vn > P.HOP_MIN_SPEED) {
        ball.vy = Math.max(ball.vy, Math.min(P.HOP_MAX, -vn * 0.14));
      }
    }
    // 只在"真的碰上去"时报 touch：球贴着船慢慢蹭不该每帧刷事件
    if (vn < -1) ev.push({ type: 'touch', id: b.id, speed: -vn });
  }

  // ---------- 6. 限速 ----------
  const v = Math.hypot(ball.vx, ball.vz);
  if (v > P.MAX_SPEED) {
    const k = P.MAX_SPEED / v;
    ball.vx *= k;
    ball.vz *= k;
  }

  // ---------- 7. 视觉弹跳（不参与平面判定）----------
  if (ball.hop > 0 || ball.vy > 0) {
    ball.vy -= P.HOP_G * dt;
    ball.hop += ball.vy * dt;
    if (ball.hop <= 0) {
      ball.hop = 0;
      ball.vy = ball.vy < -3 ? -ball.vy * P.HOP_E : 0;
    }
  }

  // ---------- 8. 滚动自转（视觉）----------
  const sv = Math.hypot(ball.vx, ball.vz);
  if (sv > 0.2) {
    ball.spinX = -ball.vz / sv;
    ball.spinZ = ball.vx / sv;
    ball.spin += (sv / Math.max(0.5, w.r)) * dt;
  }
  return ev;
}
