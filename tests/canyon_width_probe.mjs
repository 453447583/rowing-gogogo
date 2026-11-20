import { buildTrack, sampleClosed, cumLength } from '../canyon-track-core.mjs';

console.log('== 不同航道半宽下，现有布局能不能装 ==');
for (const hw of [5.5, 6, 6.5, 7, 7.5]) {
  const t = buildTrack({ scale: 0.88, rMin: 25, halfWidth: hw });
  console.log(`半宽${hw}（全宽${hw * 2}m） 单圈${t.total.toFixed(0)}m 最急R=${t.minR.toFixed(1)} 净空=${t.clearance.gap.toFixed(1)}m@${(t.clearance.at * 100).toFixed(0)}%`);
}

const t = buildTrack({ scale: 0.88, rMin: 25, halfWidth: 7.5 });
const cum = cumLength(t.poly);
const total = cum[cum.length - 1];
const zones = [];
for (let i = 0; i < t.poly.length; i += 3) {
  for (let j = i + 1; j < t.poly.length; j += 3) {
    let dArc = Math.abs(cum[j] - cum[i]);
    dArc = Math.min(dArc, total - dArc);
    if (dArc < 120) continue;
    const d = Math.hypot(t.poly[i][0] - t.poly[j][0], t.poly[i][1] - t.poly[j][1]);
    if (d >= 15) continue;
    zones.push({ f: cum[i] / total, d, x: t.poly[i][0], z: t.poly[i][1] });
  }
}
zones.sort((a, b) => a.d - b.d);
const merged = [];
for (const z of zones) {
  const last = merged[merged.length - 1];
  if (last && Math.abs(z.f - last.f) < 0.02) { last.n++; last.d = Math.min(last.d, z.d); continue; }
  merged.push({ f: z.f, d: z.d, x: z.x, z: z.z, n: 1 });
}
console.log('\n== 走廊重叠区（原始布局，全宽15m）==');
for (const m of merged.slice(0, 10)) {
  console.log(`  f=${(m.f * 100).toFixed(0)}%  (${m.x.toFixed(0)}, ${m.z.toFixed(0)})  两腿间距=${m.d.toFixed(1)}m`);
}
console.log('重叠采样点数量', zones.length);
