/**
 * 船对船碰撞：真实接触点 + 法向冲量（2D 刚体，带转动）。
 *
 * 为什么单独一个文件
 * ------------------
 * 旧的 `boatCollisionResponse(defA, defB, 相对法向速度, 重叠量)` 只拿到"两船中心连线"这个
 * 方向，对 4~5 米长、2 米宽的细长船体来说，中心连线和真实接触面的法线可以差到 60° 以上：
 *   · 并排擦碰 → 中心连线带前后分量，船被"推着往前/往后窜"；
 *   · 船头撞对手船身 → 法线指向斜后方，读起来是"刻意往别的方向撞"。
 * 而且它结算完还有一刀与方向无关的 `vel *= retention`，所以不管撞哪都得掉速。
 *
 * 这里改成：
 *   ① 用「船体中轴线段」求两船最近点，得到**真实接触法线**（细长体最稳的做法）；
 *   ② 沿法线施加冲量：按质量分配，正撞两船一起减速，侧撞只横推不减速；
 *   ③ 接触点偏离重心 → 产生**力矩**，船头朝被撞的反方向甩（杠杆臂为 0 时无力矩，
 *      所以正撞不会莫名其妙转圈，只有真实物理会给的那部分旋转）；
 *   ④ 切向摩擦用库仑上限，擦边几乎不掉速、正面硬顶才磨掉速度。
 *
 * 全部是纯函数（不 import three / DOM），`tests/boat_contact.test.mjs` 直接单测。
 */

import { boatCollisionMass } from '../data/boats.js';

/** 法向恢复系数：0.22 ≈ 撞完还有一点点弹开，但不会弹成弹球。 */
export const RESTITUTION = 0.22;
/** 单次碰撞给单船的速度改变上限（m/s）：防止极端相对速度把船弹飞。 */
export const MAX_DV = 9;
/** 单次碰撞的船头偏转上限（弧度）：≈13.7°，再多玩家会读成"失控"。 */
export const MAX_YAW = 0.24;
/** 把角冲量换算成可见船头偏转的等效时长（s）。 */
const LEVER_TIME = 0.09;
/** 偏航转动惯量的放大系数：纯刚体太爱转，1.6 倍读起来才是"重船"。 */
const YAW_INERTIA_K = 1.6;
/** 切向摩擦系数（库仑上限按法向冲量算）。 */
const TANGENT_MU = 0.30;
/** "越侧撞越甩头"的补手感项，只在明显撞击时给。 */
const LATERAL_YAW = 0.05;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * 船体本地轴。heading 的约定与 Boat 完全一致（前向 x=sin, z=cos）。
 * 横向轴取 (cos, -sin)：和既有障碍/护栏碰撞里 `lateral = n·(cos, -sin)` 的取法一模一样，
 * 这样"船头被撞歪的方向"跟撞石头、蹭护栏是同一套符号，不会互相打架。
 */
export function hullAxes(heading) {
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  return { fx: s, fz: c, lx: c, lz: -s };
}

/**
 * 椭圆支撑半径（沿某个方向的"船体伸到多远"）。
 * 侧向由船宽管，艏艉由船长管 —— 并排发车格用船宽、追尾用船长，两边都说得通。
 * 这个函数原来在 Game.js 里，挪过来只为了让它和接触法线共用同一份船体尺寸约定。
 */
export function boatCollisionRadius(def, heading, nx, nz) {
  const length = Math.max(2.5, def.hull?.length || 4.5) * 0.46;
  const width = Math.max(1.2, def.hull?.width || 1.8) * 0.55;
  const { fx, fz, lx, lz } = hullAxes(heading);
  const forward = nx * fx + nz * fz;
  const lateral = nx * lx + nz * lz;
  return Math.hypot(length * forward, width * lateral) + 0.12;
}

/** 船体中轴线段（两端点）。0.74 是去掉首尾收尖后的有效中轴长度。 */
export function hullSegment(def, heading, x, z) {
  const { fx, fz } = hullAxes(heading);
  const half = Math.max(0.8, (def.hull?.length || 4.5) * 0.5 * 0.74);
  return {
    x0: x - fx * half, z0: z - fz * half,
    x1: x + fx * half, z1: z + fz * half,
    half,
  };
}

/**
 * 两条线段上的最近点对（Ericson 的夹取法，2D 版）。
 * 返回各自线上的最近点坐标：{ ax, az, bx, bz }。
 */
export function segmentClosestPoints(ax0, az0, ax1, az1, bx0, bz0, bx1, bz1) {
  const dax = ax1 - ax0, daz = az1 - az0;
  const dbx = bx1 - bx0, dbz = bz1 - bz0;
  const rx = ax0 - bx0, rz = az0 - bz0;
  const a = dax * dax + daz * daz;
  const e = dbx * dbx + dbz * dbz;
  const f = dbx * rx + dbz * rz;
  const EPS = 1e-8;
  let s = 0;
  let t = 0;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp(f / e, 0, 1);
  } else {
    const c = dax * rx + daz * rz;
    if (e <= EPS) {
      t = 0; s = clamp(-c / a, 0, 1);
    } else {
      const b = dax * dbx + daz * dbz;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  return {
    ax: ax0 + dax * s, az: az0 + daz * s,
    bx: bx0 + dbx * t, bz: bz0 + dbz * t,
  };
}

/**
 * 两船接触法线：n 的方向是「从对方指向自己」，也就是**本船该被推开的方向**。
 * 同时在两船各自的中轴上给出接触点，供下面的力矩计算用。
 */
export function boatContactNormal(aDef, aHeading, ax, az, bDef, bHeading, bx, bz) {
  const segA = hullSegment(aDef, aHeading, ax, az);
  const segB = hullSegment(bDef, bHeading, bx, bz);
  const cp = segmentClosestPoints(
    segA.x0, segA.z0, segA.x1, segA.z1,
    segB.x0, segB.z0, segB.x1, segB.z1,
  );
  let nx = cp.ax - cp.bx;
  let nz = cp.az - cp.bz;
  const segDist = Math.hypot(nx, nz);
  if (segDist < 1e-3) {
    // 中轴已经交叉（严重穿插）：退化成中心连线，保证方向确定、不含 NaN。
    nx = ax - bx;
    nz = az - bz;
    const cd = Math.hypot(nx, nz);
    if (cd > 1e-3) {
      nx /= cd;
      nz /= cd;
    } else {
      // 连重心都完全重合（生成/网络瞬移才会出现）：用本船横向轴当推开方向，
      // 至少保证法线是单位向量、且两船一定会被分开，不会原地叠着互相穿过。
      const fa = hullAxes(aHeading);
      nx = fa.lx;
      nz = fa.lz;
    }
  } else {
    nx /= segDist;
    nz /= segDist;
  }

  // 并排（两条中轴几乎平行 + 推力几乎纯横向）时，最近点对是**退化**的：
  // 整段贴着的距离都一样，算法会稳定地挑到某一端的端点，于是接触点被当成在船头/船尾，
  // 凭空产生力矩 —— 并排擦碰就变成"船头自己甩开"。物理上并排平推不该有扭矩，
  // 所以这种情况把接触点换成两船重心（杠杆臂 0）。
  // 注意要排除"轴向前后接触"（追尾/迎头），那时端点是真实接触位置，杠杆臂必须保留。
  let useAx = cp.ax; let useAz = cp.az;
  let useBx = cp.bx; let useBz = cp.bz;
  const daxx = segA.x1 - segA.x0; const dazz = segA.z1 - segA.z0;
  const dbxx = segB.x1 - segB.x0; const dbzz = segB.z1 - segB.z0;
  const cross = Math.abs(daxx * dbzz - dazz * dbxx)
    / Math.max(1e-6, Math.hypot(daxx, dazz) * Math.hypot(dbxx, dbzz));
  const fa = hullAxes(aHeading);
  const lateralDot = Math.abs(nx * fa.lx + nz * fa.lz);
  const parallel = cross < 0.22 && lateralDot > 0.7;
  if (parallel) {
    useAx = ax; useAz = az;
    useBx = bx; useBz = bz;
  }

  return {
    nx, nz, segDist,
    ax: useAx, az: useAz,
    bx: useBx, bz: useBz,
    parallel,
    halfA: segA.half, halfB: segB.half,
  };
}

/** 偏航转动惯量（绕竖轴）→ 逆。船越长越宽越难转。 */
function invYawInertia(def) {
  const m = boatCollisionMass(def);
  const L = Math.max(2.5, def.hull?.length || 4.5);
  const W = Math.max(1.2, def.hull?.width || 1.8);
  const inertia = m * (L * L + W * W) / 12 * YAW_INERTIA_K;
  return inertia > 1e-6 ? 1 / inertia : 0;
}

/**
 * 结算一次船对船接触。
 *
 * 输入（全部是世界坐标 / 世界速度）：
 *   aDef,bDef        船型（取质量、船长、船宽）
 *   ax,az / bx,bz    两船位置（重心）
 *   aHeading,bHeading
 *   avx,avz / bvx,bvz 两船当前平面速度
 *   aw,bw            两船偏航角速度（远程船没有就传 0）
 *   nx,nz            接触法线（来自 boatContactNormal，方向 = A 被推开的方向）
 *   penetration      重叠深度（>0）
 *
 * 输出：
 *   sepA/sepB        按质量比分的分离量（沿 n / -n）
 *   dvAx..yawB       速度与船头偏转的增量
 *   impactSpeed      接近速度（取正，0 表示只是贴着、没有撞击）
 */
export function resolveBoatImpact(opts) {
  const {
    aDef, bDef, ax, az, bx, bz, aHeading, bHeading,
    avx = 0, avz = 0, aw = 0, bvx = 0, bvz = 0, bw = 0,
    nx, nz, penetration = 0,
  } = opts;

  const mA = boatCollisionMass(aDef);
  const mB = boatCollisionMass(bDef);
  const overlap = Math.max(0, penetration);
  const sepA = overlap * (mB / (mA + mB));
  const sepB = overlap - sepA;

  const out = {
    sepA, sepB,
    dvAx: 0, dvAz: 0, yawA: 0,
    dvBx: 0, dvBz: 0, yawB: 0,
    impactSpeed: 0,
    friction: 0,
  };

  const fa = hullAxes(aHeading);
  const fb = hullAxes(bHeading);

  // 接触点相对各自重心的偏移，拆成（横向 u / 前向 v）本地分量。
  const rax = opts.acx != null ? opts.acx - ax : 0;
  const raz = opts.acz != null ? opts.acz - az : 0;
  const rbx = opts.bcx != null ? opts.bcx - bx : 0;
  const rbz = opts.bcz != null ? opts.bcz - bz : 0;
  const uA = rax * fa.lx + raz * fa.lz;
  const vA = rax * fa.fx + raz * fa.fz;
  const uB = rbx * fb.lx + rbz * fb.lz;
  const vB = rbx * fb.fx + rbz * fb.fz;

  // 点速度的转动分量：dp/dθ = v·L − u·F（由 heading 的定义直接求导得来）。
  const pavx = aw * (vA * fa.lx - uA * fa.fx);
  const pavz = aw * (vA * fa.lz - uA * fa.fz);
  const pbvx = bw * (vB * fb.lx - uB * fb.fx);
  const pbvz = bw * (vB * fb.lz - uB * fb.fz);

  const rvx = avx + pavx - (bvx + pbvx);
  const rvz = avz + pavz - (bvz + pbvz);
  const vn = rvx * nx + rvz * nz;
  // vn >= 0：正在分离 → 只做位置分离，一个速度都不要动。
  // （贴着并排跑的时候每帧都会走这条分支，所以不会抖。）
  if (vn >= 0) return out;

  // 角冲量在接触点法向上的"杠杆臂"，同时也是把 J 转成角速度的系数。
  const crossA = (vA * fa.lx - uA * fa.fx) * nx + (vA * fa.lz - uA * fa.fz) * nz;
  const crossB = (vB * fb.lx - uB * fb.fx) * nx + (vB * fb.lz - uB * fb.fz) * nz;
  const invIA = invYawInertia(aDef);
  const invIB = invYawInertia(bDef);

  const denom = 1 / mA + 1 / mB + crossA * crossA * invIA + crossB * crossB * invIB;
  if (!(denom > 1e-6)) return out;

  const jn = -(1 + RESTITUTION) * vn / denom;

  // 切向摩擦：擦边（切向速度大、法向速度小）才明显；正面硬顶切向≈0，几乎没有。
  const tx = -nz;
  const tz = nx;
  const vt = rvx * tx + rvz * tz;
  const jtMax = TANGENT_MU * Math.abs(jn);
  const jt = clamp(-vt / denom, -jtMax, jtMax);

  let dvAx = (jn * nx + jt * tx) / mA;
  let dvAz = (jn * nz + jt * tz) / mA;
  let dvBx = -(jn * nx + jt * tx) / mB;
  let dvBz = -(jn * nz + jt * tz) / mB;

  const magA = Math.hypot(dvAx, dvAz);
  if (magA > MAX_DV) {
    const k = MAX_DV / magA;
    dvAx *= k;
    dvAz *= k;
  }
  const magB = Math.hypot(dvBx, dvBz);
  if (magB > MAX_DV) {
    const k = MAX_DV / magB;
    dvBx *= k;
    dvBz *= k;
  }

  const impactSpeed = -vn;
  // 力矩 → 可见的船头偏转。接触在重心正侧面时 cross=0（物理上确实不转），
  // 所以正撞和"并排平推"都不会莫名其妙打转。
  let yawA = jn * crossA * invIA * LEVER_TIME;
  let yawB = -jn * crossB * invIB * LEVER_TIME;

  // 补一点"越侧撞越甩头"：只在大冲击下给，贴着磨不会累积成原地打转。
  if (impactSpeed > 3) {
    const k = Math.min(1, impactSpeed / 12) * LATERAL_YAW;
    const latA = nx * fa.lx + nz * fa.lz;
    const latB = nx * fb.lx + nz * fb.lz;
    yawA += k * (latA >= 0 ? 1 : -1) * Math.abs(latA);
    yawB += k * (latB >= 0 ? -1 : 1) * Math.abs(latB);
  }

  out.dvAx = dvAx;
  out.dvAz = dvAz;
  out.yawA = clamp(yawA, -MAX_YAW, MAX_YAW);
  out.dvBx = dvBx;
  out.dvBz = dvBz;
  out.yawB = clamp(yawB, -MAX_YAW, MAX_YAW);
  out.impactSpeed = impactSpeed;
  out.friction = jt;
  return out;
}

/**
 * 旧接口（无几何信息）：沿给定法线的退化版冲量。
 * 保留它是为了 `tests/gameplay.test.mjs` 里"重船受到的推速更小 / 有上限"这两条断言，
 * 数学上与 resolveBoatImpact 在杠杆臂为 0 时完全等价。
 */
export function boatCollisionResponse(localDef, otherDef, relativeNormalSpeed, overlap) {
  const localMass = boatCollisionMass(localDef);
  const otherMass = boatCollisionMass(otherDef);
  const separation = Math.max(0, overlap) * (otherMass / (localMass + otherMass));
  const otherSeparation = Math.max(0, overlap) - separation;
  if (relativeNormalSpeed >= 0) {
    return { separation, otherSeparation, deltaNormal: 0, otherDeltaNormal: 0 };
  }
  const impulse = -(1 + RESTITUTION) * relativeNormalSpeed
    / (1 / localMass + 1 / otherMass);
  const deltaNormal = Math.min(8, impulse / localMass);
  const otherDeltaNormal = Math.min(8, impulse / otherMass);
  return { separation, otherSeparation, deltaNormal, otherDeltaNormal };
}
