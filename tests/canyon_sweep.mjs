import { buildLoopTrack } from '../canyon-loop-track.mjs';

console.log('圆角R  kS    环心X  环心Z   单圈   最急R  净空   覆盖');
const rows = [];
for (const R of [22, 26, 30]) {
  for (const kS of [2.2, 2.6]) {
    for (const cx of [20, 36, 52]) {
      for (const cz of [-250, -228, -206]) {
        const t = buildLoopTrack({ filletR: R, stretchS: kS, stretchZ: 1.8, cx, cz });
        const ok = t.minR >= 20 && t.gap >= 0;
        rows.push({ R, kS, cx, cz, ...t, ok });
        if (ok || rows.length % 9 === 0) {
          console.log(
            String(R).padEnd(6), String(kS).padEnd(5), String(cx).padEnd(7), String(cz).padEnd(8),
            t.total.toFixed(0).padEnd(6), t.minR.toFixed(1).padEnd(6), t.gap.toFixed(1).padEnd(6),
            t.extent.toFixed(0).padEnd(5), ok ? '<< OK' : '',
          );
        }
      }
    }
  }
}
rows.sort((a, b) => (b.ok - a.ok) || (b.minR + b.gap * 3) - (a.minR + a.gap * 3));
console.log('\n最优 3 组：');
for (const r of rows.slice(0, 3)) {
  console.log(`  R=${r.R} kS=${r.kS} 环心(${r.cx},${r.cz}) 单圈${r.total.toFixed(0)} 最急R${r.minR.toFixed(1)} 净空${r.gap.toFixed(1)} 覆盖${r.extent.toFixed(0)}`);
}
