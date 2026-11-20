// 漂移轨迹探针：量化"一直按住漂移键，半径是不是一直往外"
//
//   node tests/drift_arc_probe.mjs [baseUrl] [boatId] [mapId] [tag]
//
// 直接推进 Boat.updateLocal（与渲染帧率无关），采集 5 秒持续漂移的世界坐标、
// 船头角、速度方向角、滑移角、速度。Node 端按 0.5s 窗口算瞬时曲率半径与
// 最小二乘圆拟合半径 —— 半径随时间变大 = 真的往外扩，不是"看着靠外"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const boatId = process.argv[3] || 'rower';
const mapId = process.argv[4] || 'ocean';
const tag = process.argv[5] || 'a';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/drift-arc-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=640,400', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };

const EXPR = `(() => {
  const g = window.__game, b = g.localBoat;
  const dt = 1 / 60;
  const reset = (v) => {
    b.resetTo(0, 0, 0);
    b.floatMode = false;
    b.waveLaunchEnabled = false; b.waveJumpEnabled = false; b.waveJump = false;
    b.boostTimer = 0; b.nitroLoopTimer = 0; b.miniBoostTimer = 0; b.miniBoostQueue = 0;
    b.miniBoostGap = 0; b.driftBoostCd = 0; b.driftLockout = 0; b.driftBreak = 0;
    b.nitroBottles = 0; b.nitroCharge = 0; b.nitroAllowed = true;
    b.sinkTimer = 0; b.stunTimer = 0; b.slowTimer = 0; b.halfSpeedTimer = 0;
    b.voidTimer = 0; b.bubbleLiftTimer = 0; b.geyserLiftTimer = 0; b.bubbleFalling = false;
    b.airborne = false; b.onCoaster = null;
    b.drifting = false; b.driftTime = 0; b.driftDir = 0; b.driftAngle = 0; b.driftWant = 0;
    b.driftAnglePeak = 0; b.driftPathYaw = 0; b.driftDA = 0; b.driftChain = 0;
    b.sparkLevel = 0; b.driftCharge = 0; b.wallContactTimer = 0; b.wallHitCooldown = 0;
    b.prevNitroKey = false; b.prevDriftKey = false;
    b.steerInput = 0; b.angVel = 0; b.thrustState = 0;
    b.vel.set(0, v); b.speed = v; b.heading = 0;
  };
  const run = (n, inp, t0) => { for (let i = 0; i < n; i++) b.updateLocal(dt, inp, t0 + i * dt, [], null); };
  const warm = () => run(600, { throttle: 1, steer: 0 });
  const arc = (drift, steer, secs) => {
    reset(0); warm();
    const pts = [];
    const inp = { throttle: 1, steer: steer, drift: drift };
    for (let i = 0; i < Math.round(secs * 60); i++) {
      run(1, inp, i * dt);
      pts.push([+(i * dt).toFixed(3), +b.pos.x.toFixed(3), +b.pos.z.toFixed(3),
        +b.heading.toFixed(5), +Math.atan2(b.vel.y, b.vel.x).toFixed(5),
        +(b.driftAngle * 180 / Math.PI).toFixed(2), +b.speed.toFixed(2),
        +(b.driftPathYaw).toFixed(4)]);
    }
    return pts;
  };
  return {
    boat: b.def.id, maxSpeed: b.def.maxSpeed,
    drift: arc(true, 1, 5),
    plain: arc(false, 1, 5),
  };
})()`;

// 最小二乘圆拟合：x²+z² + D x + E z + F = 0
function fitCircle(pts) {
  let sx = 0, sz = 0, sxx = 0, szz = 0, sxz = 0, sxc = 0, szc = 0, sc = 0;
  for (const p of pts) {
    const x = p[1], z = p[2], c = x * x + z * z;
    sx += x; sz += z; sxx += x * x; szz += z * z; sxz += x * z;
    sxc += x * c; szc += z * c; sc += c;
  }
  const n = pts.length;
  const A = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]];
  const B = [-sxc, -szc, -sc];
  // 3x3 高斯消元
  const M = A.map((r, i) => [...r, B[i]]);
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let k = i + 1; k < 3; k++) {
      const f = M[k][i] / M[i][i];
      for (let j = i; j < 4; j++) M[k][j] -= f * M[i][j];
    }
  }
  const sol = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let v = M[i][3];
    for (let j = i + 1; j < 3; j++) v -= M[i][j] * sol[j];
    sol[i] = v / M[i][i];
  }
  const cx = -sol[0] / 2, cz = -sol[1] / 2;
  const r = Math.sqrt(Math.max(0, cx * cx + cz * cz - sol[2]));
  return { r, cx, cz };
}

function summarize(pts, label) {
  const win = 30; // 0.5s
  const rows = [];
  for (let s = 0; s + win <= pts.length; s += win) {
    const seg = pts.slice(s, s + win);
    // 瞬时曲率半径 = v / yawRate（速度方向角变化率）
    let sumR = 0, cnt = 0;
    for (let k = 1; k < seg.length; k++) {
      let d = seg[k][4] - seg[k - 1][4];
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      const yawRate = Math.abs(d) * 60;
      if (yawRate > 1e-4) { sumR += seg[k][6] / yawRate; cnt++; }
    }
    const fit = fitCircle(seg);
    rows.push({
      t: +((s + win / 2) / 60).toFixed(2),
      curvR: cnt ? +(sumR / cnt).toFixed(1) : null,
      fitR: fit ? +fit.r.toFixed(1) : null,
      ang: +(seg.reduce((a, p) => a + Math.abs(p[5]), 0) / seg.length).toFixed(1),
      spd: +(seg.reduce((a, p) => a + p[6], 0) / seg.length).toFixed(1),
      yaw: +(seg.reduce((a, p) => a + p[7], 0) / seg.length).toFixed(3),
    });
  }
  console.log(label);
  for (const r of rows) console.log('  t=' + r.t + 's  曲率R=' + r.curvR + 'm  拟合R=' + r.fitR
    + 'm  滑移角=' + r.ang + '°  速度=' + r.spd + 'm/s  pathYaw=' + r.yaw);
  return rows;
}

try {
  const tabs = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) return r.json(); } catch {}
      await sleep(150);
    }
    throw new Error('devtools timeout');
  })();
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable');
  await sleep(3000);
  const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;
  const waitFor = async (expr, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(300); } return false; };

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await ev(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#lobby') && !document.querySelector('#lobby').classList.contains('hidden')`);
  await ev(`document.querySelector('#btn-lobby-boat')?.click()`); await sleep(400);
  await ev(`document.querySelector('.lp-card[data-boat="${boatId}"]')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-map')?.click()`); await sleep(400);
  await ev(`document.querySelector('.lp-card[data-map="${mapId}"]')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-start-race')?.click()`);
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 40000)) throw new Error('对局没起来');
  await sleep(1000);
  await ev(`(() => { const g = window.__game; g.opts.onFinish = null; g.opts.onQuit = null; g.phase = 'racing'; return true; })()`);

  const data = await ev(EXPR);
  if (!data || !data.drift) throw new Error('no arc data');
  await fs.mkdir('.tmp_build', { recursive: true });
  await fs.writeFile(`.tmp_build/arc_${tag}.json`, JSON.stringify(data));
  console.log(`=== ${data.boat}  maxSpeed=${data.maxSpeed}  方向键=左(steer+1) 持续 5s ===`);
  const d = summarize(data.drift, '--- 漂移');
  const p = summarize(data.plain, '--- 普通转向');
  const first = d[0]?.fitR, last = d[d.length - 1]?.fitR;
  console.log(`\n结论: 漂移半径 ${first}m -> ${last}m (变化 ${first ? ((last / first - 1) * 100).toFixed(1) : '?'}%)`
    + ` | 普通转向 ${p[0]?.fitR}m -> ${p[p.length - 1]?.fitR}m`
    + ` | 漂移首窗/普通首窗 = ${first && p[0]?.fitR ? (first / p[0].fitR).toFixed(2) : '?'}x`);
} catch (e) {
  console.error('arc probe FAIL:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
