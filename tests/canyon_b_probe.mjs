import { buildTrack } from '../canyon-track-core.mjs';

console.log('缩放  目标R  单圈    最急R   净空    覆盖R   说明');
for (const [scale, rMin] of [[1.0, 22], [1.10, 22], [1.15, 22], [1.15, 24], [1.20, 22], [1.25, 22]]) {
  const t = buildTrack({ scale, rMin, halfWidth: 7.5, maxRadius: 400 });
  const ok = t.minR >= rMin * 0.95 && t.clearance.gap >= 2 ? 'OK' : '';
  console.log(
    String(scale).padEnd(5), String(rMin).padEnd(6),
    t.total.toFixed(0).padEnd(7), t.minR.toFixed(1).padEnd(7),
    t.clearance.gap.toFixed(1).padEnd(7), t.radius.toFixed(0).padEnd(7),
    `门${t.gateCount} 圈时${(t.total * 2 / 26 / 60).toFixed(2)}分 ${ok}`,
  );
}
