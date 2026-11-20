/**
 * 全地图导向牌数值审计（不启动浏览器）：
 *   node tests/guide_signs_audit.mjs
 *
 * 检查三件事：① 8 张图都有牌；② 每块牌的方向 = 该处弯道转向；
 * ③ 每块牌与近道 / 岛 / 暗礁 / 领奖台 / 其它赛段都保持净空。
 * 湖泊额外断言：环线是右弯，箭头必须是 »（旧版固定 « 就是错在这里）。
 */
import assert from 'node:assert/strict';
import { MAPS } from '../src/data/maps.js';
import { planGuideSigns, guideDistToPolyline } from '../src/game/GuideSigns.js';
import { sampleAt } from '../src/game/LakeStadiumLayout.js';

const EPS = 1e-6;
const rows = [];

for (const map of MAPS) {
  const plan = planGuideSigns(map, { colliders: [] });
  const { signs, stats, layout } = plan;
  assert.ok(signs.length > 0, `${map.id}: 没有生成任何导向牌`);
  assert.equal(stats.signs, signs.length, `${map.id}: stats 数量不一致`);
  let dirChecked = 0;

  for (const s of signs) {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z) && Number.isFinite(s.baseY),
      `${map.id}: 牌坐标非有限值`);
    for (const sc of map.shortcuts || []) {
      const d = guideDistToPolyline(sc.points || [], s.x, s.z);
      assert.ok(d >= sc.width + 10 - EPS,
        `${map.id}: 牌 (${s.x.toFixed(1)},${s.z.toFixed(1)}) 压进近道，距 ${d.toFixed(1)}m`);
    }
    for (const is of map.islands || []) {
      assert.ok(Math.hypot(s.x - is.x, s.z - is.z) >= is.r + 7 - EPS,
        `${map.id}: 牌插进岛屿`);
    }
    for (const r of map.rocks || []) {
      assert.ok(Math.hypot(s.x - r.x, s.z - r.z) >= r.r + 6 - EPS,
        `${map.id}: 牌插进暗礁`);
    }
    if (map.podium) {
      assert.ok(Math.hypot(s.x - map.podium.x, s.z - map.podium.z) >= 28 - EPS,
        `${map.id}: 牌插进领奖台`);
    }
    // 到本段中心线的距离应等于 off；到其它段不能更近
    let otherMin = Infinity;
    for (const smp of layout.samples) {
      const d = Math.abs(smp.s - s.s);
      if (Math.min(d, layout.total - d) < 24) continue;
      otherMin = Math.min(otherMin, Math.hypot(s.x - smp.x, s.z - smp.z));
    }
    assert.ok(otherMin >= map.gateWidth / 2 + 5 - EPS,
      `${map.id}: 牌 (${s.x.toFixed(1)},${s.z.toFixed(1)}) 贴到折返赛段，距 ${otherMin.toFixed(1)}m`);

    // 方向：用与实现完全相同的 frameAt/turnAt 复算该牌所在位置的局部转向
    const frameAt = (t) => {
      const p = sampleAt(layout, t);
      const a = sampleAt(layout, t - 6);
      const b = sampleAt(layout, t + 6);
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const L = Math.hypot(tx, tz) || 1;
      return { tx: tx / L, tz: tz / L };
    };
    const f1 = frameAt(s.s - 9);
    const f2 = frameAt(s.s + 9);
    const cross = f1.tx * f2.tz - f1.tz * f2.tx;
    if (Math.abs(cross) > 0.01) {
      const expect = cross > 0 ? 'right' : 'left';
      assert.equal(s.dir, expect,
        `${map.id}: 牌在 s=${s.s.toFixed(0)} 的箭头方向反了 (cross=${cross.toFixed(3)}, dir=${s.dir})`);
      dirChecked++;
    }
  }

  // 覆盖率只作观测：用户已否决「铺满 2/3」的高密度方案，不设下限断言
  if (map.id === 'lake') {
    assert.ok(stats.right > 0 && stats.left === 0,
      `lake 是右弯环线，箭头必须全部指右（旧版固定 « 就是错的）：${JSON.stringify(stats)}`);
  }
  rows.push({
    map: map.id,
    name: map.name,
    length: stats.total,
    groups: stats.groups,
    signs: stats.signs,
    left: stats.left,
    right: stats.right,
    coverage: stats.coverage,
    coveredMeters: stats.coveredMeters,
    dirChecked,
  });
}

console.log('导向牌布点审计：');
for (const r of rows) {
  console.log(`  ${r.map.padEnd(7)} ${r.name.padEnd(6)} 弧长 ${String(r.length).padStart(5)}m  `
    + `${String(r.groups).padStart(3)} 组 / ${String(r.signs).padStart(3)} 块  `
    + `« ${String(r.left).padStart(3)}  » ${String(r.right).padStart(3)}  `
    + `覆盖 ${String(r.coveredMeters).padStart(4)}m (${(r.coverage * 100).toFixed(1)}%)  方向已验 ${r.dirChecked}`);
}
console.log(`PASS：${rows.length} 张地图全部有导向牌，方向与净空全部通过（稀疏版，覆盖率仅供参考）`);
