import { buildTrack } from '../canyon-track-core.mjs';

for (const rMin of [22, 25, 30]) {
  const t = buildTrack({ scale: 0.88, rMin, halfWidth: 7.5 });
  console.log(
    `rMin=${rMin}  缩放=${t.cfg.scale.toFixed(3)}  单圈=${t.total.toFixed(0)}m  门=${t.gateCount}`,
    `最急R=${t.minR.toFixed(1)}(放宽前${t.beforeMinR.toFixed(1)})`,
    `悬空=${t.clearance.gap.toFixed(1)}m@${(t.clearance.at * 100).toFixed(0)}%`,
    `最高坡=${t.maxHeight.toFixed(2)}m`,
  );
}

const t = buildTrack({ scale: 0.88, rMin: 25, halfWidth: 7.5 });
const f = t.features;
for (const [k, v] of Object.entries(f)) {
  console.log(' ', k.padEnd(10), `f=${(v.f * 100).toFixed(1)}%`.padEnd(9), `(${v.x.toFixed(0)}, ${v.z.toFixed(0)})`.padEnd(18), `y=${v.y.toFixed(2)}`);
}
const r = t.poly.map((p) => Math.hypot(p[0], p[1]));
console.log('覆盖半径', Math.max(...r).toFixed(1), '  2圈时长@26m/s', (t.total * 2 / 26 / 60).toFixed(2), '分');
