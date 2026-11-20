/**
 * 终点线 / 圈数判定的纯几何逻辑（不依赖 three / DOM，可直接单元测试）。
 *
 * 背景：旧判定是「船中心离 0 号门小于 N 米」，两个致命问题：
 *   1. 必须按顺序碰到每个门，从门边绕过去几米，后面全部作废（冲线也不结算）；
 *   2. 逐帧采样点可能整段跨过判定圆（高速 + 低帧率），永远等不到那一刻。
 *
 * 现在改为：拿**船头**这一帧的位移线段，与起点线所在直线求交。
 * 只要船头真的从线后穿到线前、交点在赛道宽度内，就算压线。
 */

/**
 * 船头线段与终点线的交点。
 * @param {number} px 上一帧船头 x
 * @param {number} pz 上一帧船头 z
 * @param {number} cx 这一帧船头 x
 * @param {number} cz 这一帧船头 z
 * @param {number} gx 终点线中心 x
 * @param {number} gz 终点线中心 z
 * @param {number} dx 赛道前向单位向量 x（指向"跑出去"的方向）
 * @param {number} dz 赛道前向单位向量 z
 * @param {number} halfWidth 终点线半宽
 * @returns {{x:number,z:number,lateral:number,t:number}|null} 交点；不算压线时返回 null
 */
export function segmentCrossesLine(px, pz, cx, cz, gx, gz, dx, dz, halfWidth) {
  const sPrev = (px - gx) * dx + (pz - gz) * dz;
  const sCur = (cx - gx) * dx + (cz - gz) * dz;
  // 只认「线后 → 线前」；反向穿越（倒车回线）不算
  if (!(sPrev < 0 && sCur >= 0)) return null;
  const den = sPrev - sCur;
  const t = Math.abs(den) > 1e-9 ? sPrev / den : 0;
  const x = px + (cx - px) * t;
  const z = pz + (cz - pz) * t;
  const lateral = Math.abs((x - gx) * -dz + (z - gz) * dx);
  if (lateral > halfWidth) return null; // 从赛道外横切过去，不算
  return { x, z, lateral, t };
}

/**
 * 弧长增量：处理首尾相接（一圈到头回到 0）的跳变。
 * @param {number} prevS 上一帧弧长
 * @param {number} s 这一帧弧长
 * @param {number} total 一圈总弧长
 * @returns {number} 有向增量（向前为正）
 */
export function arcDelta(prevS, s, total) {
  if (!(total > 0)) return 0;
  let d = s - prevS;
  if (d > total * 0.5) d -= total;
  else if (d < -total * 0.5) d += total;
  return d;
}

/**
 * 压线是否有效：除了几何相交，还要求"这一圈真的跑够了"。
 * 防止原地来回蹭线刷圈、开局倒车压线、被弹回起点重复计数。
 * @param {number} arcSince 上次过线后累计的前向弧长
 * @param {number} total 一圈总弧长
 * @param {number} minRatio 最低比例（0.45 = 至少跑过大半圈）
 */
export function lapIsComplete(arcSince, total, minRatio = 0.45) {
  if (!(total > 0)) return true;
  return arcSince >= total * minRatio;
}

/**
 * 一条赛道的终点线（所有地图唯一口径）。
 *
 * - 闭合环线（海湾/湖泊/海峡/熔岩…）：终点 = 0 号门 = 起点线，方向取 0 号门指向 1 号门；
 * - 开环赛道（秘境漂流这类一条道跑到头的图）：终点 = 最后一门，
 *   方向**必须**取「倒数第二门 → 最后一门」—— 不能用 gateDir(最后一门)，
 *   那个函数对最后一门会回卷到 0 号门，方向正好是反的（旧版就是因此改用 13m 圆形范围，
 *   于是船头还在十几米外就结算了）。
 *
 * 半宽：闭合环线用起点线的可视宽度（和黑白格线一样宽，压到线就算）；
 * 开环用门宽（旗门两根杆之间）。
 *
 * @param {object} track Track 实例
 * @returns {{index:number,x:number,z:number,dx:number,dz:number,halfWidth:number,open:boolean}|null}
 */
export function trackFinishLine(track) {
  const gates = track?.gates;
  if (!Array.isArray(gates) || gates.length < 2) return null;
  const open = !!track.openTrack && !track.loopClosed;
  const index = open ? gates.length - 1 : 0;
  const [x, z] = gates[index];
  let dx; let dz;
  if (open) {
    const [ax, az] = gates[gates.length - 2];
    const lx = x - ax; const lz = z - az;
    const len = Math.hypot(lx, lz) || 1;
    dx = lx / len; dz = lz / len;
  } else {
    const d = track.gateDir(0);
    dx = d.dx; dz = d.dz;
  }
  const gateWidth = Number(track.gateWidth) || 8;
  const halfWidth = open
    ? gateWidth * 1.15
    : (typeof track.startLineHalfWidth === 'function'
      ? track.startLineHalfWidth()
      : Math.max(gateWidth * 2, 18));
  return { index, x, z, dx, dz, halfWidth, open };
}
