// 幽灵车 / 圈评的纯函数单测（不依赖浏览器）
//
//   node tests/lap_telemetry.test.mjs
//
// 覆盖三件事：
//   ① 幽灵存档的二进制打包 → 解包，位置/朝向的量化误差必须在视觉上不可见；
//   ② 圈评文案：新纪录 / 变快 / 变慢 / 稳定 / 首圈 五种输入都要给出合理的一句话；
//   ③ 道具 fx → 归因图标的映射（漏一个就是"被打了却没有图标"）。
import assert from 'node:assert/strict';
import { encodeGhost, decodeGhost } from '../src/game/GhostStore.js';
import { buildReview, impactKeyFromFx, IMPACT_ICONS } from '../src/game/LapTelemetry.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  ${name}: ${e.message}`);
  }
}

// ---------- ① 打包往返 ----------
check('encode/decode 往返：位置误差 ≤ 1cm，朝向误差 ≤ 0.01°', () => {
  const pts = [];
  // 一段 2 秒、20Hz 的轨迹（含负坐标、跨 2π 的朝向）
  for (let i = 0; i < 40; i++) {
    pts.push(50, -88.42 + i * 1.37, -1012.3 - i * 0.42, (i * 0.31) % (Math.PI * 2));
  }
  const rec = encodeGhost(pts, { mapId: 'strait', boatId: 'rower', arcTotal: 3000, lapTime: 2 });
  assert.equal(rec.n, 40);
  const d = decodeGhost(rec);
  assert.ok(d, 'decode 返回空');
  let maxPos = 0;
  let maxAng = 0;
  for (let i = 0; i < 40; i++) {
    maxPos = Math.max(maxPos, Math.abs(d.x[i] - pts[i * 4 + 1]));
    maxPos = Math.max(maxPos, Math.abs(d.z[i] - pts[i * 4 + 2]));
    let dh = Math.abs(d.h[i] - (((pts[i * 4 + 3] % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)));
    if (dh > Math.PI) dh = Math.PI * 2 - dh;
    maxAng = Math.max(maxAng, dh);
  }
  assert.ok(maxPos <= 0.011, `位置误差 ${maxPos}m 超过 1cm`);
  assert.ok(maxAng <= 0.0002, `朝向误差 ${maxAng}rad 超过 0.01°`);
  // 时间轴累加正确
  assert.ok(Math.abs(d.t[39] - 2) < 0.05, `累计时间 ${d.t[39]} ≠ 2s`);
});

check('空/损坏记录不抛异常', () => {
  assert.equal(decodeGhost(null), null);
  assert.equal(decodeGhost({ v: 1, n: 5, data: 'not-base64!!' }), null);
  assert.equal(decodeGhost({ v: 2, n: 5, data: '' }), null);
});

check('记录上限：超过 6000 点会被截断（localStorage 配额保护）', () => {
  const pts = new Array(6500 * 4).fill(0);
  const rec = encodeGhost(pts, { lapTime: 325 });
  assert.equal(rec.n, 6000);
});

// ---------- ② 圈评 ----------
const seg = (a, b, c, d) => [a, b, c, d];

check('新纪录：报提升秒数，tone=best', () => {
  const r = buildReview({
    lapTime: 71.5, prevTime: 73, bestTime: 72,
    segT: seg(18, 36, 54, 71.5), prevSegT: seg(18.4, 36.5, 54.6, 72), stats: { drift: 4, maxSpeed: 30 },
  });
  assert.equal(r.tone, 'best');
  assert.match(r.main, /新纪录|破纪录/);
  assert.match(r.main, /0\.5/);
});

check('比上一圈慢：tone=bad，副标题指出最慢的一段', () => {
  const r = buildReview({
    lapTime: 74, prevTime: 73, bestTime: 72,
    segT: seg(18, 40, 56, 74), prevSegT: seg(18, 36, 56, 73),
  });
  assert.equal(r.tone, 'bad');
  assert.match(r.main, /慢/);
  assert.match(r.sub, /第 2 段慢了 4\.0 秒/);
});

check('比上一圈快：tone=good', () => {
  const r = buildReview({
    lapTime: 72.4, prevTime: 73, bestTime: 71,
    segT: seg(18, 36, 54, 72.4), prevSegT: seg(18.5, 36.5, 54.6, 73),
    stats: { drift: 5, maxSpeed: 31 },
  });
  assert.equal(r.tone, 'good');
  assert.match(r.main, /快/);
});

check('差 0.04 秒以内算「稳住」，不制造假精度', () => {
  const r = buildReview({ lapTime: 73.02, prevTime: 73, bestTime: 70 });
  assert.equal(r.tone, 'even');
  assert.match(r.main, /稳住|一样/);
});

check('首圈没有参照：只报时长 + 标杆，不说"快慢"', () => {
  const r = buildReview({ lapTime: 78.2, prevTime: null, bestTime: null });
  assert.equal(r.tone, 'first');
  assert.match(r.main, /第 1 圈/);
});

check('撞墙多时副标题改成撞墙提醒', () => {
  const r = buildReview({
    lapTime: 76, prevTime: 74, bestTime: 72,
    // 分段耗时与上一圈完全一致（没有某一段特别慢），此时应该把「撞墙 3 次」顶上来
    segT: seg(18, 36, 54, 74), prevSegT: seg(18, 36, 54, 74),
    stats: { wall: 3, drift: 1 },
  });
  assert.match(r.sub, /撞墙 3 次/);
});

check('非法输入返回 null，不抛', () => {
  assert.equal(buildReview(null), null);
  assert.equal(buildReview({ lapTime: 0 }), null);
  assert.equal(buildReview({ lapTime: -3 }), null);
});

// ---------- ③ 归因映射 ----------
check('道具 fx 全部映射到已有图标', () => {
  const fxs = ['sink', 'slow', 'spin', 'ink', 'inkStun', 'bubbleLift', 'halfSpeed',
    'octoGrab', 'geyserLift', 'void', 'missileHit', 'capsize', 'reverse', '未知'];
  for (const fx of fxs) {
    const key = impactKeyFromFx(fx);
    assert.ok(IMPACT_ICONS[key], `${fx} → ${key} 没有图标定义`);
  }
  assert.equal(impactKeyFromFx('sink'), 'bomb');
  assert.equal(impactKeyFromFx('capsize'), 'torpedo');
  assert.equal(impactKeyFromFx('???'), 'other');
});

console.log(`\nlap telemetry: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
