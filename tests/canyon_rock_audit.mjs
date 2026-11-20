// 礁石通行性审计：逐站计算"走廊里最大的连续空档"，把把路堵死的礁石剔掉
import fs from 'node:fs';
import { buildLoopTrack } from '../canyon-seg-track.mjs';

const HW = 7.5;
const SAFE = 6.2;          // 至少要有 6.2m 连续空档（船宽约 2.5~3m）
const t = buildLoopTrack({ peak: 5, halfWidth: HW, maxExtent: 820 });
const poly = t.poly;
let rocks = t.obstacles.map((r) => ({ ...r }));

// 每个点到中心线的站号（沿弧长）
const cum = [0];
for (let i = 0; i < poly.length; i++) {
  const a = poly[i], b = poly[(i + 1) % poly.length];
  cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
}
const total = cum[poly.length];

// 把礁石投影到最近的中心线站点，记录 (站号, 横向偏移)
function locate(rock) {
  let best = Infinity, bi = 0, boff = 0;
  for (let i = 0; i < poly.length; i++) {
    const d = Math.hypot(poly[i][0] - rock.x, poly[i][1] - rock.z);
    if (d < best) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const nx = -tz, nz = tx;
      boff = (rock.x - a[0]) * nx + (rock.z - a[1]) * nz;
      best = d; bi = i;
    }
  }
  return { i: bi, off: boff };
}

function audit(list) {
  const byStation = new Map();
  for (const r of list) {
    const { i, off } = locate(r);
    const span = Math.ceil((r.r + 2) / 2);
    for (let k = -span; k <= span; k++) {
      const s = (i + k + poly.length) % poly.length;
      if (!byStation.has(s)) byStation.set(s, []);
      byStation.get(s).push({ lo: off - r.r, hi: off + r.r, r });
    }
  }
  let worst = { gap: Infinity, station: -1, blockers: [] };
  for (let i = 0; i < poly.length; i += 2) {
    const blocked = (byStation.get(i) || [])
      .filter((b) => b.hi > -HW && b.lo < HW)
      .map((b) => [Math.max(-HW, b.lo), Math.min(HW, b.hi)])
      .sort((a, b) => a[0] - b[0]);
    let pos = -HW, best = 0;
    for (const [lo, hi] of blocked) {
      if (lo > pos) best = Math.max(best, lo - pos);
      pos = Math.max(pos, hi);
    }
    best = Math.max(best, HW - pos);
    if (best < worst.gap) {
      worst = { gap: best, station: i, blockers: (byStation.get(i) || []).map((b) => b.r) };
    }
  }
  return worst;
}

let w = audit(rocks);
console.log('剔除前：礁石', rocks.length, '最窄空档', w.gap.toFixed(2), 'm @站', w.station);

let guard = 0;
while (w.gap < SAFE && guard++ < 60) {
  // 摘掉该站点附近最难躲的那颗（内边缘最靠中的）
  const near = w.blockers
    .map((r) => ({ r, loc: locate(r) }))
    .sort((a, b) => Math.abs(b.loc.off) - b.r.r - (Math.abs(a.loc.off) - a.r.r))[0];
  if (!near) break;
  rocks = rocks.filter((x) => x !== near.r);
  w = audit(rocks);
}

console.log('剔除后：礁石', rocks.length, '最窄空档', w.gap.toFixed(2), 'm @站', w.station);

const data = JSON.parse(fs.readFileSync('canyon-map-data.json', 'utf8'));
data.rocks = rocks.map((r) => ({ x: Math.round(r.x), z: Math.round(r.z), r: +r.r.toFixed(1), s: +(r.r / 3).toFixed(2) }));
data.rockAudit = { minGap: +w.gap.toFixed(2), safe: w.gap >= SAFE };
fs.writeFileSync('canyon-map-data.json', JSON.stringify(data, null, 1));
console.log('已写入 canyon-map-data.json，最窄空档', w.gap.toFixed(2), 'm', w.gap >= SAFE ? 'PASS' : 'FAIL');
