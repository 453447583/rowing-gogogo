import { buildLoopTrack } from '../canyon-loop-track.mjs';

console.log('kS   kZ   单圈    最急R   净空    覆盖  桥高');
let best = null;
for (const kS of [1.4, 1.8, 2.2, 2.6, 3.0]) {
  for (const kZ of [1.4, 1.8, 2.2]) {
    const t = buildLoopTrack({ stretchS: kS, stretchZ: kZ });
    const ok = t.minR >= 22 && t.gap >= 2;
    console.log(
      String(kS).padEnd(5), String(kZ).padEnd(5),
      t.total.toFixed(0).padEnd(7), t.minR.toFixed(1).padEnd(7),
      t.gap.toFixed(1).padEnd(7), t.extent.toFixed(0).padEnd(6), t.maxY.toFixed(1),
      ok ? '  << OK' : '',
    );
    if (ok && (!best || t.total < best.total)) best = { kS, kZ, ...t };
  }
}
if (best) console.log('\n最省长度的一组：kS=%s kZ=%s 单圈 %s m 最急R %s 净空 %s',
  best.kS, best.kZ, best.total.toFixed(0), best.minR.toFixed(1), best.gap.toFixed(1));
