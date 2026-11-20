import { RAW, sampleClosed, cumLength } from '../canyon-track-core.mjs';

const poly = sampleClosed(RAW.map((p) => [p[0], p[1], p[2] ?? 0]), 24);
const cum = cumLength(poly);
const total = cum[cum.length - 1];
const N = poly.length;

const pairs = [];
for (let i = 0; i < N; i += 2) {
  for (let j = i + 1; j < N; j += 2) {
    let dArc = Math.abs(cum[j] - cum[i]);
    dArc = Math.min(dArc, total - dArc);
    if (dArc < 120) continue;
    const d = Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1]);
    if (d < 26) {
      pairs.push({ i, j, d, a: poly[i], b: poly[j], ci: Math.round(i / 24) % 39, cj: Math.round(j / 24) % 39 });
    }
  }
}
pairs.sort((p, q) => p.d - q.d);
console.log('原图自交/贴回过近的地方（距离 < 26m）：');
const seen = new Set();
for (const p of pairs.slice(0, 12)) {
  const key = `${Math.min(p.ci, p.cj)}-${Math.max(p.ci, p.cj)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`  控制点 ${p.ci} ↔ ${p.cj}   间距 ${p.d.toFixed(1)}m   (${p.a[0].toFixed(0)},${p.a[1].toFixed(0)}) - (${p.b[0].toFixed(0)},${p.b[1].toFixed(0)})`);
}
console.log('\n控制点原始坐标：');
RAW.forEach((p, i) => console.log(String(i).padStart(2), `(${p[0]}, ${p[1]})`));
