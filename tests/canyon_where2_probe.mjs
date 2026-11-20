import { buildLoopTrack } from '../canyon-loop-track.mjs';
import { cumLength } from '../canyon-track-core.mjs';

const t = buildLoopTrack({ stretchS: 2.2, stretchZ: 1.8 });
const poly = t.poly;
const n = poly.length;
const cum = cumLength(poly);
const total = cum[n];

// 最急弯
let worst = { r: Infinity, i: 0 };
for (let i = 0; i < n; i += 2) {
  const a = poly[(i - 6 + n) % n], b = poly[i], c = poly[(i + 6) % n];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  const R = area < 1e-7 ? 1e6 : (ab * bc * ca) / (4 * area);
  if (R < worst.r) worst = { r: R, i };
}
console.log(`最急弯 R=${worst.r.toFixed(1)}  @ ${(cum[worst.i] / total * 100).toFixed(0)}%  位置 (${poly[worst.i][0].toFixed(0)}, ${poly[worst.i][1].toFixed(0)})`);

// 最近的非相邻段
const hits = [];
for (let i = 0; i < n; i += 3) {
  for (let j = i + 1; j < n; j += 3) {
    let da = Math.abs(cum[j] - cum[i]);
    da = Math.min(da, total - da);
    if (da < 120) continue;
    if (Math.abs((poly[i][2] || 0) - (poly[j][2] || 0)) > 1.6) continue;
    const d = Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
    if (d < 18) hits.push({ i, j, d, da });
  }
}
hits.sort((a, b) => a.d - b.d);
console.log('\n走廊重叠（间距 < 18m 且高度相近）前 6 处：');
for (const h of hits.slice(0, 6)) {
  console.log(`  ${(cum[h.i] / total * 100).toFixed(0)}% ↔ ${(cum[h.j] / total * 100).toFixed(0)}%`,
    `间距 ${h.d.toFixed(1)}m  (${poly[h.i][0].toFixed(0)},${poly[h.i][1].toFixed(0)}) ↔ (${poly[h.j][0].toFixed(0)},${poly[h.j][1].toFixed(0)})`);
}
console.log('重叠采样对总数', hits.length);
