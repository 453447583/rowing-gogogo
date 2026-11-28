/**
 * 天梯第 5 层（棋盘落雷）逻辑探针。
 *
 * 只测判定与计分，不渲染：
 *  1) 每波点亮「一半」格子（floor(有效格数 / 2)）；
 *  2) 站在亮格里 = 被劈一次，亮格之外安全；
 *  3) 每波没被劈的人 +1，被劈的 0（不扣分）；
 *  4) 层结束按「被劈次数升序」结算，最少的拿 SCORE_RANK[0]；
 *  5) 掉出平台的人垫底。
 *
 * 运行：node tests/sky_tower_thunder.test.mjs
 */
import assert from 'node:assert/strict';
import { SKY_TOWER, layerRadius } from '../src/data/skyTowerRun.js';
import { SkyTowerThunderRun } from '../src/game/SkyTowerThunderRun.js';

const T = SKY_TOWER.THUNDER;
const R = layerRadius(T.LAYER);

const scene = { add() {}, remove() {} };
const fx = { play() {} };

function makeBoat(x, z) {
  return {
    pos: { x, y: 72.4, z },
    vel: { x: 0, y: 0 },
    heading: 0,
    vy: 0,
    stunTimer: 0,
    slowTimer: 0,
  };
}

const a = makeBoat(0, 20);
const b = makeBoat(0, -20);
const score = new Map([['a', 0], ['b', 0]]);

let hitEvents = 0;
const run = new SkyTowerThunderRun(scene, {
  solo: true,
  isHost: true,
  myId: 'a',
  fx,
  onScore: (id, pts) => {
    score.set(id, (score.get(id) || 0) + pts);
    return score.get(id);
  },
  onEvent: (e) => { if (e.type === 'hit') hitEvents += 1; },
});

const entries = [
  { id: 'a', boat: a, index: 0 },
  { id: 'b', boat: b, index: 1 },
];

const cellCenter = (i) => run.cellCenters[i];

/** 把船挪到不在当前亮格里的最近格子中心（测试要确定性） */
function keepSafe(boat) {
  let best = null, bd = Infinity;
  for (const c of run.validCells) {
    if (run.cells.has(c.i)) continue;
    const d = Math.hypot(c.x - boat.pos.x, c.z - boat.pos.z);
    if (d < bd) { bd = d; best = c; }
  }
  if (best) { boat.pos.x = best.x; boat.pos.z = best.z; }
}

/** 把船摆进当前某一格亮格里 */
function putOnWarned(boat) {
  for (const i of run.cells) {
    const c = cellCenter(i);
    if (c) { boat.pos.x = c.x; boat.pos.z = c.z; return true; }
  }
  return false;
}

const dt = 1 / 60;
let guard = 0;
let waveSeen = 0;
let aPlacedWave = -1;
let aStruck = 0;
let recordedWave = 0;
const waves = [];

while (run.running && guard < 20000) {
  guard += 1;
  const warning = run.warnT > 0 && run.cells.size > 0;
  if (warning) {
    if (run.wave !== recordedWave) {
      recordedWave = run.wave;
      waves.push({ wave: run.wave, n: run.cells.size });
    }
    // b 永远躲在安全格
    keepSafe(b);
    if (aStruck === 0) {
      // 还没被劈过：每波都把 a 摆进一个亮格（验证"站亮格 = 被劈"）
      if (run.wave !== aPlacedWave) {
        aPlacedWave = run.wave;
        putOnWarned(a);
      }
    } else {
      // 被劈过一次之后 a 也躲安全格，用于比较排名
      keepSafe(a);
    }
  }
  // 第三波开始后直接掐时间，别真跑满 60 秒
  if (run.wave >= 3) run.timeLeft = Math.min(run.timeLeft, 0.02);
  run.update(dt, entries);
  if (run.wave > waveSeen) waveSeen = run.wave;
  if (!aStruck && run.struckOf('a') > 0) aStruck = run.struckOf('a');
}

// ---- 1) 每波点亮一半格子 ----
assert.ok(waves.length >= 1, '应该看到过至少一波落雷');
const half = Math.floor(run.validCells.length / 2);
for (const w of waves) {
  assert.equal(w.n, half, `第 ${w.wave} 波应点亮 ${half} 格（实际 ${w.n}）`);
}

// ---- 2) 站亮格被劈，安全格不被劈 ----
assert.ok(hitEvents >= 1, 'a 站在亮格里应该被劈到');
assert.equal(aStruck, 1, `a 只应被劈 1 次（实际 ${aStruck}）`);
assert.equal(run.struckOf('b'), 0, 'b 一直在安全格，不应被劈');

// ---- 3) 没被劈的每波 +1 ----
assert.ok(score.get('b') > score.get('a'), `b 的躲雷分应高于 a（a=${score.get('a')} b=${score.get('b')}）`);

// ---- 4) 结算：被劈最少的排第一，拿最高排名分 ----
assert.equal(run.running, false, '时间到应结束');
assert.equal(run.order[0].id, 'b', '被劈最少的 b 应该第一');
assert.equal(run.order[0].n, 0);
assert.equal(run.order[1].n, 1);
assert.ok(score.get('b') >= T.SCORE_DODGE + T.SCORE_RANK[0], 'b 应拿到躲雷分 + 第一名排名分');

run.dispose();

// ---- 5) 掉出平台的人垫底：不能靠跳下去躲雷 ----
const run2 = new SkyTowerThunderRun(scene, {
  solo: true, isHost: true, myId: 'a', fx,
  onScore: () => 0, onEvent: () => {},
});
run2.update(1 / 60, entries);
run2.noteFall('a');
run2.timeLeft = 0.01;
run2.update(1 / 60, entries);
assert.equal(run2.order[0].id, 'b', '掉层的 a 应垫底');
assert.equal(run2.order[1].dnf, true, 'a 应标记 dnf');
assert.equal(run2.winner, 'b', '胜者只能是留在场上的人');
run2.dispose();

console.log('sky_tower_thunder: PASS', {
  waves: waveSeen,
  cells: { valid: run.validCells.length, perWave: half },
  struck: { a: 1, b: 0 },
  score: { a: score.get('a'), b: score.get('b') },
});
