/**
 * 船对船冲量（真实接触法线）单测。
 * 跑法：node tests/boat_contact.test.mjs
 *
 * 覆盖：
 *   ① 接触法线来自船体几何，不再等于「两船中心连线」
 *   ② 正撞两船一起减速、不产生莫名旋转
 *   ③ 并排擦碰不掉速（旧版每帧一刀常速衰减是"撞哪都掉速"的根源）
 *   ④ 追尾：后船减速、前船被顶出去
 *   ⑤ 船头撞船身：被撞的船以横向推开为主
 *   ⑥ 正在分离时不动速度（并排贴着跑不抖）
 *   ⑦ 分离量按质量比分配
 *   ⑧ 速度/偏转有上限，极端相对速度不会把船弹飞
 */
import assert from 'node:assert/strict';
import { getBoat, boatCollisionMass } from '../src/data/boats.js';
import {
  hullAxes, hullSegment, segmentClosestPoints, boatContactNormal,
  resolveBoatImpact, boatCollisionRadius, MAX_DV, MAX_YAW,
} from '../src/game/boatContact.js';

let n = 0;
const ok = (msg) => { n++; console.log(`  ok ${n} - ${msg}`); };
const deg = (r) => (r * 180) / Math.PI;

const titan = getBoat('titan');
const falcon = getBoat('falcon');

// ---------- 线段最近点 ----------
{
  // 两条平行线段（错开）→ 最近点应垂直对齐
  const cp = segmentClosestPoints(0, 0, 0, 4, 3, 1, 3, 5);
  assert.ok(Math.abs(cp.ax - 0) < 1e-9 && Math.abs(cp.bx - 3) < 1e-9);
  assert.ok(Math.abs(cp.az - cp.bz) < 1e-9, '平行线段最近点同高');
  ok('segmentClosestPoints：平行线段给出垂足');
}
{
  const cp = segmentClosestPoints(0, 0, 2, 0, 5, 0, 9, 0);
  assert.ok(Math.abs(cp.ax - 2) < 1e-9 && Math.abs(cp.bx - 5) < 1e-9);
  ok('segmentClosestPoints：共线不重叠取两端点');
}

// ---------- ① 法线来自几何 ----------
// A 斜插到 B 的船艏侧面（真实接触在 A 的船身 vs B 的艏尖），
// 中心连线只有 ~9° 偏离 B 的中轴，几何法线偏离 ~50° —— 这正是"被推向莫名其妙方向"的来源。
{
  const aH = 0.7;
  const aX = -0.35, aZ = 2.2;
  const bH = 0;
  const bX = 0, bZ = 0;
  const c = boatContactNormal(titan, aH, aX, aZ, titan, bH, bX, bZ);

  const fa = hullAxes(aH);
  const latA = Math.abs(c.nx * fa.lx + c.nz * fa.lz);
  assert.ok(latA > 0.9, `A 受到的推力应几乎全在横向（实测 |n·L|=${latA.toFixed(2)}）`);

  const cdx = aX - bX, cdz = aZ - bZ;
  const cd = Math.hypot(cdx, cdz);
  const cnx = cdx / cd, cnz = cdz / cd;
  const dot = c.nx * cnx + c.nz * cnz;
  const angle = deg(Math.acos(Math.max(-1, Math.min(1, dot))));
  assert.ok(angle > 25, `几何法线与中心连线应明显不同（实测差 ${angle.toFixed(1)}°）`);

  const fb = hullAxes(bH);
  const alongB = Math.abs(c.nx * fb.fx + c.nz * fb.fz);
  assert.ok(alongB < 0.75, `推力不应沿 B 的中轴（实测 ${(alongB * 100).toFixed(0)}%）`);
  ok(`接触法线来自船体几何（与中心连线差 ${angle.toFixed(1)}°）`);
}

// ---------- ② 正撞：一起减速、不转 ----------
{
  const aH = 0, bH = 0;
  const c = boatContactNormal(titan, aH, 0, -2.0, titan, bH, 0, 0);
  assert.ok(Math.abs(c.nx) < 0.02, '正撞法线应几乎沿中轴');
  assert.ok(c.nz < -0.9, '法线从对方指回自己（A 在后方 → nz 为负）');

  const r = resolveBoatImpact({
    aDef: titan, bDef: titan,
    ax: 0, az: -2.0, bx: 0, bz: 0,
    aHeading: aH, bHeading: bH,
    avx: 0, avz: 20, bvx: 0, bvz: 10,
    nx: c.nx, nz: c.nz, penetration: boatCollisionRadius(titan, aH, c.nx, c.nz) * 2 - 2.0,
    acx: c.ax, acz: c.az, bcx: c.bx, bcz: c.bz,
  });
  assert.ok(r.impactSpeed > 9, `接近速度应≈10（实测 ${r.impactSpeed.toFixed(2)}）`);
  assert.ok(r.dvAz < 0, 'A 被减速');
  assert.ok(r.dvBz > 0, 'B 被顶出去');
  assert.ok(Math.abs(r.yawA) < 1e-6 && Math.abs(r.yawB) < 1e-6,
    `正撞不应产生旋转（实测 ${r.yawA.toFixed(4)} / ${r.yawB.toFixed(4)}）`);
  ok('正撞：两船沿中轴交换冲量，一起减速，不旋转');
}

// ---------- ③ 并排擦碰：不掉速 ----------
{
  const aH = 0, bH = 0;
  const c = boatContactNormal(titan, aH, 1.55, 0, titan, bH, 0, 0);
  assert.ok(c.nx > 0.98, '并排时法线应纯横向');
  const r = resolveBoatImpact({
    aDef: titan, bDef: titan,
    ax: 1.55, az: 0, bx: 0, bz: 0,
    aHeading: aH, bHeading: bH,
    avx: 0, avz: 26, bvx: 0, bvz: 26,
    nx: c.nx, nz: c.nz, penetration: 0.6,
    acx: c.ax, acz: c.az, bcx: c.bx, bcz: c.bz,
  });
  assert.equal(r.impactSpeed, 0, '同速并排跑没有接近速度');
  assert.ok(Math.hypot(r.dvAx, r.dvAz) < 1e-9, '不该给任何速度变化');
  assert.ok(r.sepA > 0 && r.sepB > 0, '位置仍要分开');
  ok('并排擦碰：只做位置分离，一分速度都不掉');
}

// ---------- ④ 追尾 ----------
{
  const c = boatContactNormal(titan, 0, 0, 1.0, falcon, 0, 0, 3.6);
  const r = resolveBoatImpact({
    aDef: titan, bDef: falcon,
    ax: 0, az: 1.0, bx: 0, bz: 3.6,
    aHeading: 0, bHeading: 0,
    avx: 0, avz: 30, bvx: 0, bvz: 14,
    nx: c.nx, nz: c.nz, penetration: 0.9,
    acx: c.ax, acz: c.az, bcx: c.bx, bcz: c.bz,
  });
  const dvA = Math.hypot(r.dvAx, r.dvAz);
  const dvB = Math.hypot(r.dvBx, r.dvBz);
  assert.ok(r.dvBz > 4, `被追尾的轻艇应被明显顶出去（实测 ${r.dvBz.toFixed(2)}）`);
  assert.ok(dvB > dvA, `轻艇得到的推速应大于重船（${dvB.toFixed(2)} > ${dvA.toFixed(2)}）`);
  assert.ok(dvA <= MAX_DV + 1e-9 && dvB <= MAX_DV + 1e-9, '推速在上限内');
  ok(`追尾：重船减速 ${dvA.toFixed(2)}，前船被顶出 ${dvB.toFixed(2)} m/s`);
}

// ---------- ⑤ 船头撞船身：被撞方以横向推开为主 ----------
{
  // A 从侧面斜插 B 的船身（A 在 B 的 -X 侧，几乎垂直冲向 B 的侧面）
  const aH = 1.2;
  const aX = -2.6, aZ = 0.2;
  const bH = 0;
  const c = boatContactNormal(titan, aH, aX, aZ, titan, bH, 0, 0);
  assert.ok(Math.abs(c.nx + 1) < 0.02, '侧面接触的法线应几乎垂直于 B 的中轴');
  const r = resolveBoatImpact({
    aDef: titan, bDef: titan,
    ax: aX, az: aZ, bx: 0, bz: 0,
    aHeading: aH, bHeading: bH,
    // A 沿自己船头冲刺，B 静止
    avx: Math.sin(aH) * 24, avz: Math.cos(aH) * 24,
    bvx: 0, bvz: 0,
    nx: c.nx, nz: c.nz, penetration: 1.2,
    acx: c.ax, acz: c.az, bcx: c.bx, bcz: c.bz,
  });
  const fb = hullAxes(bH);
  const lat = Math.abs(r.dvBx * fb.lx + r.dvBz * fb.lz);
  const along = Math.abs(r.dvBx * fb.fx + r.dvBz * fb.fz);
  assert.ok(lat > along, `被撞船应以横向推开为主（横 ${lat.toFixed(2)} vs 纵 ${along.toFixed(2)}）`);
  assert.ok(Math.abs(r.yawA) > 1e-4 || Math.abs(r.yawB) > 1e-4, '非正撞应产生船头偏转');
  assert.ok(Math.abs(r.yawA) <= MAX_YAW + 1e-9 && Math.abs(r.yawB) <= MAX_YAW + 1e-9);
  ok(`船头撞船身：横向推开 ${lat.toFixed(2)} > 纵向 ${along.toFixed(2)}，偏转 ${deg(r.yawA).toFixed(1)}°`);
}

// ---------- ⑥ 正在分离：速度一动不动 ----------
{
  const r = resolveBoatImpact({
    aDef: titan, bDef: titan,
    ax: 1.5, az: 0, bx: 0, bz: 0,
    aHeading: 0, bHeading: 0,
    avx: 5, avz: 0, bvx: 0, bvz: 0,   // 正在往远离方向走
    nx: 1, nz: 0, penetration: 0.2,
    acx: 1.5, acz: 0, bcx: 0.7, bcz: 0,
  });
  assert.equal(r.impactSpeed, 0);
  assert.equal(r.dvAx, 0);
  assert.equal(r.yawA, 0);
  assert.ok(r.sepA > 0);
  ok('分离中：只分离位置，不施加冲量');
}

// ---------- ⑦ 分离量按质量比 ----------
{
  const heavy = resolveBoatImpact({
    aDef: titan, bDef: falcon,
    ax: 1, az: 0, bx: 0, bz: 0, aHeading: 0, bHeading: 0,
    avx: 0, avz: 0, bvx: 0, bvz: 0,
    nx: 1, nz: 0, penetration: 1,
  });
  const mA = boatCollisionMass(titan);
  const mB = boatCollisionMass(falcon);
  assert.ok(mA > mB);
  assert.ok(heavy.sepB > heavy.sepA, '轻艇被分到的分离更多');
  assert.ok(Math.abs(heavy.sepA + heavy.sepB - 1) < 1e-9, '分离量守恒');
  ok(`质量分配：重船分离 ${heavy.sepA.toFixed(2)}m，轻艇 ${heavy.sepB.toFixed(2)}m`);
}

// ---------- ⑧ 上限 ----------
{
  const c = boatContactNormal(falcon, 0, 0, -1.2, titan, 0, 0, 0);
  const r = resolveBoatImpact({
    aDef: falcon, bDef: titan,
    ax: 0, az: -1.2, bx: 0, bz: 0, aHeading: 0, bHeading: 0,
    avx: 0, avz: 200, bvx: 0, bvz: -200,   // 相对 400 m/s 的鬼畜场景
    nx: c.nx, nz: c.nz, penetration: 2,
    acx: c.ax, acz: c.az, bcx: c.bx, bcz: c.bz,
  });
  assert.ok(Math.hypot(r.dvAx, r.dvAz) <= MAX_DV + 1e-9);
  assert.ok(Math.hypot(r.dvBx, r.dvBz) <= MAX_DV + 1e-9);
  assert.ok(Math.abs(r.yawA) <= MAX_YAW + 1e-9);
  ok(`极端相对速度：推速封顶 ${MAX_DV} m/s，偏转封顶 ${deg(MAX_YAW).toFixed(1)}°`);
}

// ---------- 兜底：完全重合不产生 NaN ----------
{
  const c = boatContactNormal(titan, 0, 0, 0, titan, 1.2, 0, 0);
  assert.ok(Number.isFinite(c.nx) && Number.isFinite(c.nz), '重合时法线仍有限');
  assert.ok(Math.abs(Math.hypot(c.nx, c.nz) - 1) < 1e-6, '法线仍是单位向量');
  const seg = hullSegment(titan, 0, 5, 5);
  assert.ok(Math.abs(seg.x1 - seg.x0) < 1e-9, 'heading=0 时中轴沿 +Z');
  ok('完全重合 / 退化输入不产生 NaN');
}

console.log(`\nboat contact: PASS (${n})`);
