/**
 * 天梯第 7 层（缩圈 · 累计里程）逻辑探针。
 *
 * 只测判定与计分，不渲染：
 *  1) 里程 = 逐帧位移累加；瞬移（>MAX_STEP）不算里程；
 *  2) 圈半径 60 秒从 R0 收到 R1 后停住（不会再缩）；
 *  3) 圈外待够 OUT_GRACE 掉下去：扣 FALL_PENALTY 里程、抓回安全圈内、次数 +1；
 *  4) 结算按里程降序，第一名拿 SCORE_RANK[0]；
 *  5) 组队时按队伍总里程排名，队员各拿一份名次分；
 *  6) 只有 AI 在场时不走表（真人上来才开始计时）。
 *
 * 运行：node tests/sky_tower_shrink.test.mjs
 */
import assert from 'node:assert/strict';
import { SKY_TOWER, layerRadius } from '../src/data/skyTowerRun.js';
import { SkyTowerShrinkRun } from '../src/game/SkyTowerShrinkRun.js';

const S = SKY_TOWER.SHRINK;
const R = layerRadius(S.LAYER);
const R0 = R * S.R0;
const dt = 1 / 60;

const scene = { add() {}, remove() {} };
const fx = { play() {} };

function makeBoat(x = 0, z = 0) {
  return {
    pos: { x, y: 108.4, z, set(px, py, pz) { this.x = px; this.y = py; this.z = pz; } },
    vel: { x: 0, y: 0, z: 0, set(px, py, pz) { this.x = px; this.y = py; this.z = pz; } },
    heading: 0,
    speed: 0,
    vy: 0,
    stunTimer: 0,
    slowTimer: 0,
    diveTargetY: 0,
  };
}

const mk = (opts = {}) => new SkyTowerShrinkRun(scene, {
  solo: true, isHost: true, myId: 'a', fx,
  onScore: opts.onScore || (() => 0),
  onEvent: opts.onEvent || (() => {}),
  teamOf: opts.teamOf || null,
  isAi: opts.isAi || (() => false),
});

// ---- 1) 里程累加 + 瞬移不计 ----
{
  const a = makeBoat(0, 0);
  const b = makeBoat(0, 10);
  const entries = [{ id: 'a', boat: a }, { id: 'b', boat: b }];
  const run = mk();
  run.update(dt, entries);            // started + clockOn

  const step = 0.4;
  let expected = 0;
  for (let i = 0; i < 200; i++) {
    // 左右横移（模拟漂移绕圈），始终留在圈内
    a.pos.x += (i % 2 === 0 ? step : -step) * (i % 4 < 2 ? 1 : -1);
    expected += step;
    run.update(dt, entries);
  }
  const got = run.metersOf('a');
  assert.ok(Math.abs(got - expected) <= 2, `里程应 ≈ ${expected.toFixed(0)}m（实际 ${got}m）`);

  const before = got;
  a.pos.x += 20;                      // 瞬移：> MAX_STEP，必须不计
  run.update(dt, entries);
  assert.equal(run.metersOf('a'), before, '单帧位移 > MAX_STEP 视为传送，不计里程');
  run.dispose();
}

// ---- 2) 圈半径：60 秒收到 R1 后停住 ----
{
  const a = makeBoat(0, 0);
  const entries = [{ id: 'a', boat: a }];
  const run = mk();
  assert.ok(Math.abs(run.ringR - R0) < 0.01, `起始圈半径应为 ${R0.toFixed(1)}（实际 ${run.ringR.toFixed(1)}）`);
  run.update(dt, entries);

  let prev = run.ringR;
  let monotone = true;
  for (let i = 0; i < Math.round(S.SHRINK_TIME / dt) + 30; i++) {
    run.update(dt, entries);
    if (run.ringR > prev + 1e-6) monotone = false;
    prev = run.ringR;
  }
  assert.ok(monotone, '圈只能缩不能涨');
  assert.ok(Math.abs(run.ringR - S.R1) < 0.6, `缩完应停在 R1=${S.R1}（实际 ${run.ringR.toFixed(2)}）`);
  // 再多跑 2 秒，不能再缩（用户口径：缩到一定距离就停）
  for (let i = 0; i < 120; i++) run.update(dt, entries);
  assert.ok(Math.abs(run.ringR - S.R1) < 0.6, '缩到底之后不再继续缩');
  run.dispose();
}

// ---- 3) 圈外待够 OUT_GRACE：扣里程 + 抓回圈内 ----
{
  const a = makeBoat(0, 0);
  const entries = [{ id: 'a', boat: a }];
  const run = mk();
  run.update(dt, entries);
  // 先跑出一段里程
  for (let i = 0; i < 300; i++) {
    a.pos.x = (i % 60) * 0.3;
    run.update(dt, entries);
  }
  const before = run.metersOf('a');
  assert.ok(before > 40, `垫底里程应 > 40m（实际 ${before}）`);

  // 站到圈外（离塔心 ringR + 6）等它超时
  const outAt = run.ringR + 6;
  let fell = 0;
  for (let i = 0; i < Math.ceil((S.OUT_GRACE + 0.4) / dt); i++) {
    a.pos.x = outAt; a.pos.z = 0;
    run.update(dt, entries);
    if (run.fallsOf('a') > 0) { fell += 1; break; }
  }
  assert.ok(fell === 1, '圈外超时应掉下去一次');
  assert.equal(run.fallsOf('a'), 1, '掉圈次数应记 1 次');
  assert.equal(run.metersOf('a'), Math.max(0, before - S.FALL_PENALTY),
    `掉圈应扣 ${S.FALL_PENALTY}m（${before} → ${run.metersOf('a')}）`);
  const back = Math.hypot(a.pos.x, a.pos.z);
  assert.ok(back <= run.ringR, `应被抓回安全圈内（实际 ${back.toFixed(1)} > ${run.ringR.toFixed(1)}）`);
  assert.ok(back > 1, '不要刚好落在塔心');
  run.dispose();
}

// ---- 4) 结算：里程降序 + 第一名拿最高排名分 ----
{
  const a = makeBoat(0, 0);
  const b = makeBoat(0, 10);
  const entries = [{ id: 'a', boat: a }, { id: 'b', boat: b }];
  const score = new Map([['a', 0], ['b', 0]]);
  const run = mk({ onScore: (id, pts) => { score.set(id, (score.get(id) || 0) + pts); return score.get(id); } });
  run.update(dt, entries);
  for (let i = 0; i < 240; i++) {
    a.pos.x = (i % 40) * 0.25;        // a 一直动
    run.update(dt, entries);          // b 不动
  }
  assert.ok(run.metersOf('a') > run.metersOf('b'), 'a 应比 b 跑得多');
  run.timeLeft = 0.005;
  run.update(dt, entries);
  assert.equal(run.running, false, '时间到应结束');
  assert.equal(run.order[0].id, 'a', '里程多的排第一');
  assert.equal(run.order[0].n, run.metersOf('a'), '榜上的数字就是米数');
  assert.equal(score.get('a'), S.SCORE_RANK[0], `第一名应拿 ${S.SCORE_RANK[0]} 分`);
  assert.equal(score.get('b'), S.SCORE_RANK[1], `第二名应拿 ${S.SCORE_RANK[1]} 分`);
  run.dispose();
}

// ---- 5) 组队：按队伍总里程排名，队员各拿一份 ----
{
  const a = makeBoat(0, 0);
  const b = makeBoat(0, 10);
  const c = makeBoat(0, -10);
  const entries = [{ id: 'a', boat: a }, { id: 'b', boat: b }, { id: 'c', boat: c }];
  const score = new Map();
  // a、b 同队（红队），c 单人队
  const run = mk({
    teamOf: (id) => (id === 'c' ? null : 0),
    onScore: (id, pts) => { score.set(id, (score.get(id) || 0) + pts); return score.get(id); },
  });
  run.update(dt, entries);
  // b 跑得多，a 少一点：红队总和要压过 c
  for (let i = 0; i < 240; i++) {
    b.pos.z = (i % 50) * 0.3;
    a.pos.z = (i % 20) * 0.15;
    run.update(dt, entries);
  }
  run.timeLeft = 0.005;
  run.update(dt, entries);
  assert.equal(run.teams.length, 2, '应汇总成 2 支队伍');
  assert.ok(run.teams[0].ids.includes('b'), '红队应第一');
  assert.equal(score.get('a'), S.SCORE_RANK[0], '同队两人都拿第一名分数（a）');
  assert.equal(score.get('b'), S.SCORE_RANK[0], '同队两人都拿第一名分数（b）');
  assert.equal(score.get('c'), S.SCORE_RANK[1], '单人队拿第二名分数');
  run.dispose();
}

// ---- 6) 只有 AI 在场不走表 ----
{
  const s = makeBoat(0, 0);
  const entries = [{ id: 'solo', boat: s }];
  const run = mk({ isAi: (id) => id === 'solo' });
  const t0 = run.timeLeft;
  for (let i = 0; i < 120; i++) run.update(dt, entries);
  assert.equal(run.timeLeft, t0, '只有 AI 时不应开始倒计时');
  assert.ok(Math.abs(run.ringR - R0) < 0.01, '只有 AI 时圈也不该缩');
  run.dispose();
}

console.log('sky_tower_shrink: PASS', { R0: +R0.toFixed(1), R1: S.R1, grace: S.OUT_GRACE });
