/**
 * 天梯第 5 层（随机落雷）逻辑探针。
 *
 * 只测判定与计分，不渲染：
 *  1) 每波 2 个落点，都在「避开塔身 / 避开边缘」的环带里；
 *  2) 同一波两道雷间距 ≥ BOLT_MIN_GAP（圈不会叠成一坨）；
 *  3) 站在圈里 = 被劈一次，圈外安全；
 *  4) 每波没被劈的人 +1；
 *  5) 层结束按「被劈次数升序」结算，最少的拿 SCORE_RANK[0]。
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

const dt = 1 / 60;
let guard = 0;
let waveSeen = 0;
let aPlacedOnBolt = false;
let aStruck = 0;
const checked = [];

/** 把船挪到离所有落雷都远的固定点，保证它安全（测试要确定性） */
function keepSafe(boat) {
  const pts = [[0, 34], [34, 0], [0, -34], [-34, 0]];
  let best = pts[0], bd = -1;
  for (const [x, z] of pts) {
    let d = Infinity;
    for (const bolt of run.bolts) d = Math.min(d, Math.hypot(bolt.x - x, bolt.z - z));
    if (d > bd) { bd = d; best = [x, z]; }
  }
  boat.pos.x = best[0];
  boat.pos.z = best[1];
}

while (run.running && guard < 20000) {
  guard += 1;
  keepSafe(b);
  // 被劈过一次之后就把 a 也挪到安全点：本测试只验证"站圈里挨一下"，
  // 后面几波让它和 b 一样安全，才能比较结算排名
  if (aStruck > 0) keepSafe(a);
  // 第一波预警出现后：把 a 摆到第一道雷正中心
  if (!aPlacedOnBolt && run.bolts.length) {
    aPlacedOnBolt = true;
    a.pos.x = run.bolts[0].x;
    a.pos.z = run.bolts[0].z;
    checked.push({
      wave: run.wave,
      n: run.bolts.length,
      pts: run.bolts.map((x) => ({ x: x.x, z: x.z })),
    });
  }
  // 第三波开始前直接掐时间，别真跑满 75 秒
  if (run.wave >= 3) run.timeLeft = Math.min(run.timeLeft, 0.02);
  run.update(dt, entries);
  if (run.wave > waveSeen) waveSeen = run.wave;
  if (!aStruck && run.struckOf('a') > 0) aStruck = run.struckOf('a');
}

// ---- 1/2) 落点范围与间距 ----
assert.ok(checked.length >= 1, '应该看到过至少一波落雷');
for (const w of checked) {
  assert.equal(w.n, T.BOLTS_PER_WAVE, `每波应落 ${T.BOLTS_PER_WAVE} 个`);
  for (const p of w.pts) {
    const d = Math.hypot(p.x, p.z);
    assert.ok(d >= T.SPIRE_CLEAR - 0.01, `落点不能压中央塔身（d=${d.toFixed(1)}）`);
    assert.ok(d <= R - T.EDGE_MARGIN + 0.01, `落点不能贴平台边缘（d=${d.toFixed(1)}）`);
  }
  if (w.pts.length === 2) {
    const gap = Math.hypot(w.pts[0].x - w.pts[1].x, w.pts[0].z - w.pts[1].z);
    assert.ok(gap >= T.BOLT_MIN_GAP - 0.01, `同波两雷间距应 ≥ ${T.BOLT_MIN_GAP}（实际 ${gap.toFixed(1)}）`);
  }
}

// ---- 3) a 站圈里被劈 ----
assert.ok(hitEvents >= 1, 'a 站在雷心应该被劈到');
assert.equal(aStruck, 1, `a 只应被劈 1 次（实际 ${aStruck}）`);
assert.equal(run.struckOf('b'), 0, 'b 一直躲开，不应被劈');

// ---- 4) 没被劈的每波 +1（b 至少比 a 多）----
assert.ok(score.get('b') > score.get('a'), `b 的躲雷分应高于 a（a=${score.get('a')} b=${score.get('b')}）`);

// ---- 5) 结算：被劈最少的排第一，拿最高排名分 ----
assert.equal(run.running, false, '时间到应结束');
assert.equal(run.order[0].id, 'b', '被劈最少的 b 应该第一');
assert.equal(run.order[0].n, 0);
assert.equal(run.order[1].n, 1);
const bBefore = score.get('b');
assert.ok(bBefore >= T.SCORE_DODGE + T.SCORE_RANK[0], 'b 应拿到躲雷分 + 第一名排名分');

run.dispose();

// ---- 6) 掉出平台的人垫底：不能靠跳下去躲雷 ----
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
  struck: { a: run.struckOf('a'), b: run.struckOf('b') },
  score: { a: score.get('a'), b: score.get('b') },
});
