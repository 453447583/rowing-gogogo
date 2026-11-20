// 断层（裂谷）几何的唯一真源。
// Track 用它建裂谷视觉 + 判定，Water 用它烘"水面挖洞"遮罩 —— 两边必须算同一份矩形，
// 否则会出现"视觉上是个坑、水面却没挖开"或者反过来的错位。
//
// 约定：fault 定义在地图数据里 { after, width, minSpeed, at? }
//   after = 该门之后的赛段；at = 段内位置（默认 0.5 中点）
// 返回矩形：中心 (cx,cz)、沿赛道方向 (fx,fz)、法线 (nx,nz)、
//           沿赛道半长 width/2、横向半宽 halfAcross。

export function faultRects(mapDef) {
  const list = mapDef?.faults;
  if (!list || !list.length) return [];
  const gates = mapDef.gates || [];
  const N = gates.length;
  if (!N) return [];
  const halfAcross = mapDef.gateWidth ?? 15;
  const out = [];
  for (const spec of list) {
    const gi = ((Math.round(spec.after) % N) + N) % N;
    const a = gates[gi];
    const b = gates[(gi + 1) % N];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    const t = spec.at ?? 0.5;
    out.push({
      gate: gi,
      cx: a[0] + dx * t,
      cz: a[1] + dz * t,
      fx, fz,
      nx: -fz, nz: fx,
      width: spec.width ?? 10,
      halfAcross,
      minSpeed: spec.minSpeed ?? 15,
    });
  }
  return out;
}

/** 点是否落在某道裂谷的矩形里 */
export function faultAt(pos, rects) {
  if (!rects || !rects.length) return null;
  for (const f of rects) {
    const dx = pos.x - f.cx;
    const dz = pos.z - f.cz;
    const along = dx * f.fx + dz * f.fz;
    const across = Math.abs(dx * f.nx + dz * f.nz);
    if (Math.abs(along) <= f.width * 0.5 && across <= f.halfAcross) return f;
  }
  return null;
}
