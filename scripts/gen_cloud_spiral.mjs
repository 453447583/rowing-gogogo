// 秘境漂流：把云端段（门 30..65）重铺成「双螺旋塔」
//
//   node scripts/gen_cloud_spiral.mjs            # 算一遍并打印指标，不写文件
//   node scripts/gen_cloud_spiral.mjs --write    # 写回 src/data/baked-data.js
//
// ── 为什么是这个形状 ────────────────────────────────────────────
// ① 门 29 是楼梯尽头，来车朝东 → 螺旋中心只能放在 A 的正北，
//    逆时针切线才还是朝东。塔心到 A 的距离 = 入口半径 rEntry。
// ② 上升段与下降段同在 r = 95（标准双螺旋，像停车楼的坡道）：
//    两道坡道靠同一根半径 88 的塔柱托底，坡度板只向外挑 7.5m ——
//    不需要打柱子，也就不会出现"柱子穿过下一层走廊"这种穿模。
// ③ 塔心必须够北：下降圈最南点 = C.z − 95，离楼梯线（z≈10）要留
//    两条走廊的宽度。所以入口用一段"径向收拢"把半径从 rEntry=124
//    收到 95 —— 这段收拢同时把塔心推到 C.z = 134，南沿 39m，够远。
// ④ 门号数量不变（30..65 共 36 槽）→ edgeDrop / jumps / returnFrom 全都不用改号。
// ⑤ 总长控制在 950~1050m（原来 530m）。整圈 3052m → 约 3500m。
import fs from 'node:fs';
import path from 'node:path';
import { BAKED_TRACK } from '../src/data/baked-track.js';

const WRITE = process.argv.includes('--write');
const TAU = Math.PI * 2;

const GATES = BAKED_TRACK.gates.map((p) => [p[0], p[1]]);
const GATE_Y = BAKED_TRACK.gateY.slice();
const N = GATES.length;
const A = GATES[29];
const F = GATES[66];
const yA = GATE_Y[29];
const yF = GATE_Y[66];

const CFG = {
  rEntry: 140,      // 入口半径（= 塔心到门 29 的距离）
  mergeTurns: 0.18, // 径向收拢所占的转角
  rMain: 88,        // 上升段半径
  rDown: 76,        // 下降段半径（收进内圈，与上升段在平面上永不重叠）
  upTurns: 0.58,    // 上升圈数（含收拢段）
  crestTurns: 0.06, // 塔顶平台
  downTurns: 0.65,  // 下降圈数
  topY: 63.1,       // 塔顶水面高度（沿用原来的 63m）
};

function build() {
  const C = [A[0], A[1] + CFG.rEntry];
  const th0 = Math.atan2(A[1] - C[1], A[0] - C[0]);   // −90°，A 在塔心正南
  const pts = [];
  const radiusAt = (t, span) => {
    // 收拢段之后半径恒为 rMain
    if (t >= span) return CFG.rMain;
    const k = t / span;
    const s = k * k * (3 - 2 * k);
    return CFG.rEntry + (CFG.rMain - CFG.rEntry) * s;
  };

  // ---- 上升螺旋 ----
  const upSweep = CFG.upTurns * TAU;
  const mergeSpan = CFG.mergeTurns / CFG.upTurns;     // 收拢段占上升段的比例
  const upSteps = Math.max(60, Math.round((upSweep * CFG.rMain) / 1.5));
  for (let i = 0; i <= upSteps; i++) {
    const t = i / upSteps;
    const th = th0 + upSweep * t;
    const r = radiusAt(t, mergeSpan);
    // 高度用 smoothstep：起步平缓（刚从楼梯上来不能立刻陡），中段均匀
    const s = t * t * (3 - 2 * t);
    pts.push({ x: C[0] + Math.cos(th) * r, z: C[1] + Math.sin(th) * r, y: yA + (CFG.topY - yA) * s });
  }

  // ---- 塔顶平台 ----
  const thUpEnd = th0 + upSweep;
  const crestSweep = CFG.crestTurns * TAU;
  const crestSteps = Math.max(8, Math.round((crestSweep * CFG.rMain) / 1.5));
  for (let i = 1; i <= crestSteps; i++) {
    const t = i / crestSteps;
    const th = thUpEnd + crestSweep * t;
    const s2 = t * t * (3 - 2 * t);
    const r = CFG.rMain + (CFG.rDown - CFG.rMain) * s2;
    pts.push({ x: C[0] + Math.cos(th) * r, z: C[1] + Math.sin(th) * r, y: CFG.topY });
  }

  // ---- 下降螺旋：前 25% 还是水台，之后越来越陡 ----
  const thD0 = thUpEnd + crestSweep;
  const downSweep = CFG.downTurns * TAU;
  const downSteps = Math.max(36, Math.round((downSweep * CFG.rDown) / 1.5));
  for (let i = 1; i <= downSteps; i++) {
    const t = i / downSteps;
    const th = thD0 + downSweep * t;
    // 下降剖面必须是「先陡后缓」：
    //   第一版写成「前 25% 还是水台」，结果崖口出来还是平的，艇起跳后立刻落在
    //   同一块 63m 的水台上（验收里 '飞行中高度明显下降' 直接 FAIL）。
    //   现在前 10% 就掉掉 9m（≈31% 坡），崖口是真瀑布唇，艇才有落差可飞。
    const y = CFG.topY + (yF - CFG.topY) * (1 - Math.pow(1 - t, 3));
    pts.push({ x: C[0] + Math.cos(th) * CFG.rDown, z: C[1] + Math.sin(th) * CFG.rDown, y });
  }

  // ---- 出口水槽：二次贝塞尔接回森林口 F，起点沿螺旋切向 ----
  const e = pts[pts.length - 1];
  const thEnd = thD0 + downSweep;
  const tx = -Math.sin(thEnd), tz = Math.cos(thEnd);
  const toF = Math.hypot(e.x - F[0], e.z - F[1]);
  const ctl = [e.x + tx * toF * 0.42, e.z + tz * toF * 0.42];
  const exitSteps = Math.max(12, Math.round(toF / 6));
  for (let i = 1; i <= exitSteps; i++) {
    const t = i / exitSteps, mt = 1 - t;
    pts.push({
      x: mt * mt * e.x + 2 * mt * t * ctl[0] + t * t * F[0],
      z: mt * mt * e.z + 2 * mt * t * ctl[1] + t * t * F[1],
      y: yF,
    });
  }
  return { pts, C, thEnd, toF };
}

function resample(pts, count) {
  const seg = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    seg.push(d); total += d;
  }
  const out = [];
  for (let k = 0; k < count; k++) {
    const s = (total * k) / (count - 1);
    let acc = 0, i = 0;
    while (i < seg.length - 1 && acc + seg[i] < s) { acc += seg[i]; i++; }
    const t = seg[i] ? Math.min(1, (s - acc) / seg[i]) : 0;
    out.push({
      x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
      z: pts[i].z + (pts[i + 1].z - pts[i].z) * t,
      y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
    });
  }
  return { out, total };
}

// ---------------- 计算 + 自检 ----------------
const { pts, C, thEnd, toF } = build();
// 门 30..66 共 37 点：out[0] 就是门 29（螺旋起点），门 30 = out[1]、门 66 = out[36]
const { out, total } = resample(pts, 37);
const newGates = GATES.map((p) => p.slice());
const newY = GATE_Y.slice();
for (let i = 0; i < 36; i++) {
  newGates[30 + i] = [+out[i + 1].x.toFixed(2), +out[i + 1].z.toFixed(2)];
  newY[30 + i] = +out[i + 1].y.toFixed(2);
}
newGates[29] = GATES[29].slice(); newY[29] = GATE_Y[29];
newGates[66] = GATES[66].slice(); newY[66] = GATE_Y[66];

const segDist = (px, pz, a, b) => {
  const sx = b[0] - a[0], sz = b[1] - a[1];
  const L2 = sx * sx + sz * sz || 1;
  let t = ((px - a[0]) * sx + (pz - a[1]) * sz) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - sx * t, pz - a[1] - sz * t);
};

let minR = Infinity;
for (let i = 31; i < 65; i++) {
  const a = newGates[i - 2], b = newGates[i], c = newGates[i + 2];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  if (cross < 1e-6) continue;
  minR = Math.min(minR, (ab * bc * ca) / (2 * cross));
}

let clrStairs = Infinity, clrStairsGate = -1;
let clrRest = Infinity, clrRestGate = -1;
let selfGap = Infinity, selfPair = null;
for (let i = 30; i <= 65; i++) {
  const p = newGates[i];
  for (let k = 0; k <= 25; k++) {
    const d = segDist(p[0], p[1], GATES[k], GATES[k + 1]);
    if (d < clrStairs) { clrStairs = d; clrStairsGate = k; }
  }
  for (let k = 69; k < N - 1; k++) {
    const d = segDist(p[0], p[1], GATES[k], GATES[k + 1]);
    if (d < clrRest) { clrRest = d; clrRestGate = k; }
  }
  for (let j = i + 6; j <= 65; j++) {
    const d = Math.hypot(p[0] - newGates[j][0], p[1] - newGates[j][1]);
    if (d < selfGap) { selfGap = d; selfPair = [i, j]; }
  }
}
// 自距最近那对点，上下差多少（差得够多就是"上一层压着下一层"，不是穿模）
const selfDY = selfPair ? Math.abs(newY[selfPair[0]] - newY[selfPair[1]]) : 0;

let maxGrade = 0, gradeAt = -1;
for (let i = 30; i <= 66; i++) {
  const a = newGates[i - 1], b = newGates[i];
  const h = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const g = Math.abs(newY[i] - newY[i - 1]) / h;
  if (g > maxGrade) { maxGrade = g; gradeAt = i; }
}

const entryHeading = Math.atan2(newGates[30][0] - newGates[29][0], newGates[30][1] - newGates[29][1]);
const prevHeading = Math.atan2(GATES[29][0] - GATES[28][0], GATES[29][1] - GATES[28][1]);
const kink = Math.abs(((entryHeading - prevHeading + Math.PI * 3) % TAU) - Math.PI);

// 塔柱外沿（供 Track 建体用）
const towerR = CFG.rDown - 8;
// 平面投影上叠了几层：只统计"沿赛道隔了 ≥12 个门"的点对（相邻点是同一条坡道，天然挨着）
let maxStack = 0;
const stackPairs = [];
for (let i = 30; i <= 65; i++) {
  for (let j = i + 12; j <= 65; j++) {
    const dh = Math.hypot(newGates[i][0] - newGates[j][0], newGates[i][1] - newGates[j][1]);
    const dv = Math.abs(newY[i] - newY[j]);
    if (dh < 22 && dv < 7) {
      maxStack++;
      if (stackPairs.length < 6) stackPairs.push({ i, j, dh: +dh.toFixed(1), dv: +dv.toFixed(1) });
    }
  }
}

console.log('=== 云端双螺旋塔 ===');
console.log(`塔心 (${C[0].toFixed(0)}, ${C[1].toFixed(0)})  塔柱半径 ${towerR}  上升半径 ${CFG.rMain} / 下降半径 ${CFG.rDown}`);
console.log(`上升 ${CFG.upTurns} 圈（含 ${CFG.mergeTurns} 圈径向收拢）+ 顶部 ${CFG.crestTurns} 圈 + 下降 ${CFG.downTurns} 圈`);
console.log(`段长 ${total.toFixed(0)}m（原来 530m）  出口到森林口 ${toF.toFixed(0)}m  最高 ${Math.max(...newY.slice(30, 67)).toFixed(1)}m`);
console.log(`最小转弯半径 ${minR.toFixed(1)}m  最大坡度 ${(maxGrade * 100).toFixed(1)}%（门 ${gradeAt}）  入口折角 ${(kink * 180 / Math.PI).toFixed(1)}°`);
console.log(`净空: 楼梯侧 ${clrStairs.toFixed(1)}m(门${clrStairsGate})  森林/回程侧 ${clrRest.toFixed(1)}m(门${clrRestGate})`);
console.log(`自距最近 ${selfGap.toFixed(1)}m ${JSON.stringify(selfPair)} 上下差 ${selfDY.toFixed(1)}m  同投影叠层对 ${maxStack}`);
if (stackPairs.length) console.log('   叠层样例:', JSON.stringify(stackPairs));

const FAIL = [];
if (minR < 30) FAIL.push(`最小转弯半径 ${minR.toFixed(1)}m < 30m`);
if (kink > 18) FAIL.push(`入口折角 ${(kink * 180 / Math.PI).toFixed(1)}° > 18°`);
if (clrStairs < 18) FAIL.push(`离楼梯只有 ${clrStairs.toFixed(1)}m（要 ≥18m）`);
if (clrRest < 25) FAIL.push(`离森林/回程只有 ${clrRest.toFixed(1)}m（要 ≥25m）`);
if (maxStack > 0) FAIL.push(`有 ${maxStack} 对门在平面上几乎同高叠在一起，会穿模`);
if (selfDY < 12 && selfGap < 30) FAIL.push(`螺旋两层只隔 ${selfGap.toFixed(1)}m / 上下 ${selfDY.toFixed(1)}m，会互穿`);
if (maxGrade > 1.5) FAIL.push(`最大坡度 ${(maxGrade * 100).toFixed(0)}% 太陡`);
if (FAIL.length) {
  console.log('\n❌ 不合格：');
  for (const f of FAIL) console.log('   -', f);
  if (WRITE) process.exitCode = 1;
}

if (process.argv.includes('--dump')) {
  for (let i = 30; i <= 66; i++) {
    const a = Math.atan2(newGates[i][1] - C[1], newGates[i][0] - C[0]) * 180 / Math.PI;
    const r = Math.hypot(newGates[i][0] - C[0], newGates[i][1] - C[1]);
    console.log('门', String(i).padStart(3), 'xyz', newGates[i][0].toFixed(0).padStart(5), newGates[i][1].toFixed(0).padStart(5), newY[i].toFixed(1).padStart(6), ' 方位', a.toFixed(0).padStart(5), ' 半径', r.toFixed(0));
  }
}

if (WRITE && !FAIL.length) {
  const file = path.resolve('src/data/baked-track.js');
  let src = fs.readFileSync(file, 'utf8');
  src = src.replace(/^  gates: \[.*\],$/m, `  gates: ${JSON.stringify(newGates.map((p) => [+p[0], +p[1]]))},`);
  src = src.replace(/^  gateY: \[.*\],$/m, `  gateY: ${JSON.stringify(newY)},`);
  if (!src.includes('云端双螺旋塔')) {
    src = src.replace(
      /^(export const BAKED_TRACK = \{)/m,
      '// 2026-11-12：云端段（门 30..65）重铺成「双螺旋塔」——生成器 scripts/gen_cloud_spiral.mjs。\n'
      + `//   上升 ${CFG.upTurns} 圈（r ${CFG.rEntry}→${CFG.rMain}，先径向收拢）+ 顶部平台 + 下降 ${CFG.downTurns} 圈（r ${CFG.rMain}）+ 出口水槽。\n`
      + '//   门号数量不变（209），所以 edgeDrop / jumps / returnFrom 全部沿用。\n$1',
    );
  }
  fs.writeFileSync(file, src);
  console.log('\n✅ 已写入 src/data/baked-track.js');
} else if (WRITE) {
  console.log('\n⚠️ 自检不通过，没有写文件。');
}
