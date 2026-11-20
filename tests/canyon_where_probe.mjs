import { designPoint, designPolyline, DESIGN } from '../canyon-track-design.mjs';
import { worstRadius } from '../canyon-track-core.mjs';

const dense = designPolyline(DESIGN, 2400);
const info = worstRadius(dense, 12);
console.log('最急 R', info.r.toFixed(2), '@u=', (info.at).toFixed(3), '位置', info.pos.map((v) => v.toFixed(0)));

// 每 2% 段的最小半径
const M = dense.length;
const step = 48;
const rows = [];
for (let i = 0; i < M; i += step) {
  let best = Infinity, bi = 0;
  for (let j = i; j < Math.min(M, i + step); j++) {
    const a = dense[(j - 12 + M) % M], b = dense[j], c = dense[(j + 12) % M];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    const R = area < 1e-7 ? 1e6 : (ab * bc * ca) / (4 * area);
    if (R < best) { best = R; bi = j; }
  }
  rows.push([i / M, best]);
}
rows.sort((x, y) => x[1] - y[1]);
console.log('最急的 6 个 u 区段:');
for (const [u, R] of rows.slice(0, 6)) console.log('  u=', u.toFixed(2), 'R=', R.toFixed(1));

console.log('\n各特征处的弯径:');
for (const f of DESIGN.features) {
  let best = Infinity, at = 0;
  for (let i = 0; i < 400; i++) {
    const u = f.u0 + (f.u1 - f.u0) * (i / 400);
    const idx = Math.round(u * M);
    const a = dense[(idx - 12 + M) % M], b = dense[idx % M], c = dense[(idx + 12) % M];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    const R = area < 1e-7 ? 1e6 : (ab * bc * ca) / (4 * area);
    if (R < best) { best = R; at = u; }
  }
  console.log(' ', f.key.padEnd(8), 'R=', best.toFixed(1), '@u=', at.toFixed(3));
}
