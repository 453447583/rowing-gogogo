// 终点线判定单元测试：node tests/finish_line.test.mjs
import {
  segmentCrossesLine, arcDelta, lapIsComplete, trackFinishLine,
} from '../src/game/finishLine.js';

let pass = 0;
let fail = 0;
function ok(cond, name, extra = '') {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗', name, extra);
}

// 起点线在原点，赛道朝 +Z 跑，线宽 ±17m
const GX = 0; const GZ = 0; const DX = 0; const DZ = 1; const HW = 17;
const cross = (px, pz, cx, cz) => segmentCrossesLine(px, pz, cx, cz, GX, GZ, DX, DZ, HW);

// 1) 船头正中压线
{
  const r = cross(0, -1, 0, 1);
  ok(r !== null, '正中压线应判定通过');
  ok(r && Math.abs(r.x) < 1e-9 && Math.abs(r.z) < 1e-9, '交点应落在线上', JSON.stringify(r));
  ok(r && r.lateral < 1e-9, '横向偏移应为 0', String(r?.lateral));
}

// 2) 高速整段跨过（一帧从线后 8m 直接到线前 8m）——旧圆形判定会漏，这里必须过
{
  const r = cross(0, -8, 0, 8);
  ok(r !== null, '高速整段跨线应判定通过（防隧穿）');
}

// 3) 从线外横切（横向 30m > 17m）不算
{
  const r = cross(30, -1, 30, 1);
  ok(r === null, '赛道宽度外横切不算');
}

// 4) 边缘：横向正好 16.9m 算，17.1m 不算
{
  ok(cross(16.9, -1, 16.9, 1) !== null, '宽度内边缘应算');
  ok(cross(17.1, -1, 17.1, 1) === null, '宽度外边缘不算');
}

// 5) 反向穿越（倒车回去）不算
{
  ok(cross(0, 1, 0, -1) === null, '倒车穿线不算');
}

// 6) 贴着线抖动（两帧都在线前）不算
{
  ok(cross(0, 0.2, 0, 0.6) === null, '线前来回移动不算');
  ok(cross(0, -0.2, 0, -0.1) === null, '线后移动不算');
}

// 7) 一帧之内静止压线（起终点同一位置）不重复计入
{
  ok(cross(0, 0, 0, 0) === null, '原地不动不计数');
}

// 8) 弧长增量：跨过 0 点（首尾相接）
{
  ok(Math.abs(arcDelta(2150, 10, 2167.8) - 27.8) < 1e-6, '跨 0 点增量应为 +27.8', String(arcDelta(2150, 10, 2167.8)));
  ok(Math.abs(arcDelta(10, 2150, 2167.8) + 27.8) < 1e-6, '反向跨 0 点应为 -27.8', String(arcDelta(10, 2150, 2167.8)));
  ok(Math.abs(arcDelta(100, 110, 2167.8) - 10) < 1e-6, '普通增量');
}

// 9) 圈数门槛：没跑够 45% 不算
{
  ok(lapIsComplete(1000, 2167.8) === true, '跑了 46% 应算完成一圈');
  ok(lapIsComplete(900, 2167.8) === false, '只跑 41% 不算');
  ok(lapIsComplete(0, 0) === true, '开环赛道(total=0) 不拦');
}

// 10) 终点线取法：闭合环线 = 0 号门，方向指向 1 号门
{
  const track = {
    gates: [[0, 0], [0, 60], [40, 90], [0, 60]],   // 最后一门回卷到 1 号门
    gateWidth: 8, startWidth: 26, openTrack: false, loopClosed: false,
    gateDir: (i) => {
      const g = track.gates[i]; const n = track.gates[(i + 1) % track.gates.length];
      const dx = n[0] - g[0]; const dz = n[1] - g[1];
      const L = Math.hypot(dx, dz) || 1;
      return { dx: dx / L, dz: dz / L };
    },
    startLineHalfWidth() { return Math.max(this.startWidth * 0.5, this.gateWidth * 2) + 2; },
  };
  const line = trackFinishLine(track);
  ok(line && line.index === 0, '闭合环线终点应为 0 号门', JSON.stringify(line));
  ok(line && Math.abs(line.dz - 1) < 1e-9, '闭合环线前向应为 +Z', String(line?.dz));
  ok(line && line.open === false, '闭合环线 open=false');
  ok(line && line.halfWidth === 18, '闭合环线半宽 = 起点线半宽(18)', String(line?.halfWidth));
}

// 11) 开环赛道：终点 = 最后一门，方向取「倒数第二门 → 最后一门」
//     ⚠ 这里绝不能调 gateDir(最后一门)：它对最后一门会回卷到 0 号门，方向正好反向，
//     旧版就是因为这个才改用"离最后一门 13m 的圆"，导致船头没到线就结算。
{
  const gates = [[0, 0], [0, 100], [0, 300], [0, 640]];
  const track = {
    gates, gateWidth: 10, startWidth: 26, openTrack: true, loopClosed: false,
    // 故意写成"回卷"语义，模拟真实实现的坑
    gateDir: (i) => ({ dx: 0, dz: gates[i][1] > 0 ? -1 : 1 }),
    startLineHalfWidth() { return 18; },
  };
  const line = trackFinishLine(track);
  ok(line && line.index === 3, '开环赛道终点应为最后一门', String(line?.index));
  ok(line && Math.abs(line.dz - 1) < 1e-9, '开环终点前向必须朝赛道外(+Z)，不能回卷成 -1', String(line?.dz));
  ok(line && line.open === true, '开环赛道 open=true');
  ok(line && Math.abs(line.halfWidth - 11.5) < 1e-9, '开环终点半宽按门宽(10×1.15)', String(line?.halfWidth));
}

// 12) 开环但已闭合（回程接回起点）= 按闭合环线处理
{
  const track = {
    gates: [[0, 0], [0, 100]], gateWidth: 8, startWidth: 26,
    openTrack: true, loopClosed: true,
    gateDir: () => ({ dx: 0, dz: 1 }),
    startLineHalfWidth() { return 18; },
  };
  const line = trackFinishLine(track);
  ok(line && line.index === 0 && line.open === false, 'openTrack + loopClosed 应走闭合环线', JSON.stringify(line));
}

// 13) 门太少 → 没有终点线（竞技场/BOSS 模式）
{
  ok(trackFinishLine(null) === null, '空 track 返回 null');
  ok(trackFinishLine({ gates: [[0, 0]] }) === null, '只有 1 个门返回 null');
}

console.log(fail === 0 ? `finish line: PASS (${pass})` : `finish line: FAIL (${fail}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
