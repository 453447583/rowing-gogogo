// 漂移手感专项探针（2026-11-16 重做后）
//
//   node tests/drift_probe.mjs [baseUrl] [boatIndex] [mapId]
//
// 直接调用 Boat.updateLocal（不经过渲染帧率），所以结果与机器性能无关。
// 全部用数字验收，不看截图：
//   ① 入漂掉速曲线：逐帧速度百分比 + 最大单帧跌幅（"一顿一顿"会在这里露馅）
//   ② 建角曲线：滑移角（度）逐帧，看起漂用多久、峰值多大
//   ③ 拖漂：长按 3 秒后的保速率
//   ④ 出弯喷：松键给的喷数 + 之后 1 秒的峰值速度
//   ⑤ 回正双喷：按住漂移键、把车头回正 → 应当当场双喷
//   ⑥ 彩虹漂：左右反打，滑移角连续穿越 0，且漂移不断、集气继续涨
//   ⑦ 撞障碍：只丢本次集气，氮气瓶一个不掉
//   ⑧ 弯道能力：漂移 vs 普通转向的轨迹角速度
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const boatId = process.argv[3] || 'rower';
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/drift-probe-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=640,400', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };

const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
  // 浏览器配置目录留在 D:/3dgame-tmp/browser，不删：safe-delete 守卫在批量并发跑时
  // 会被多个进程同时请求而抢不到状态锁，超时后把整个探针打断（8 并发实测全挂）。
};

async function waitJson(url, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('devtools timeout');
}

const EXPR = `(() => {
  const g = window.__game, b = g.localBoat, def = b.def;
  const dt = 1 / 60;
  const kmh = (v) => +(v * 3.6).toFixed(1);
  const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
  const r2 = (v, n = 2) => +v.toFixed(n);

  // 关掉"浪尖抛飞"：strait 的浪峰每 4~8 秒把船抛起来一次，落地自带加速，
  // 会让"直道极速"在 117~141 km/h 之间随机跳（实测）。漂移的数值必须跑在
  // 干净基线上，否则量到的是浪不是漂移。
  const reset = (v = 30, float = false) => {
    b.resetTo(0, 0, 0);
    b.floatMode = float;
    b.waveLaunchEnabled = false;
    b.waveJumpEnabled = false;
    b.waveJump = false;
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
    b.vel.set(0, v); b.speed = v;
    b.heading = 0;
    b.prevPos.copy(b.pos);
  };
  const run = (n, inp, t0 = 0) => {
    for (let i = 0; i < n; i++) b.updateLocal(dt, inp, t0 + i * dt, [], null);
  };
  // 先把推力拉到稳态（10 秒 = 肯定到极速），再开始测试
  // 不这样，"入漂掉速"里看到的会是推力爬升，而不是漂移本身的减速
  const warm = () => { run(600, { throttle: 1, steer: 0 }); };

  // ---------- ① 入漂掉速曲线 ----------
  reset(0); warm();
  const v0 = b.speed;
  const spd = [], ang = [];
  let maxDrop = 0, maxAngJump = 0, prevA = 0;
  for (let i = 0; i < 60; i++) {
    run(1, { throttle: 1, steer: 1, drift: true }, i * dt);
    spd.push(r2((b.speed / v0) * 100 - 100));
    const a = deg(b.driftAngle);
    ang.push(a);
    if (i > 0 && spd[i] - spd[i - 1] < maxDrop) maxDrop = spd[i] - spd[i - 1];
    if (i > 0 && Math.abs(a - prevA) > maxAngJump) maxAngJump = Math.abs(a - prevA);
    prevA = a;
  }
  const entry = { v0: kmh(v0), drop1s: spd[59], maxDrop, maxAngJump, angAt1s: ang[59] };

  // ---------- ② 建角：多少秒到双喷门槛（随 DRIFT_TUNING.doubleAngle）----------
  reset(0); warm();
  const dblDeg = 24.6;   // = DRIFT_TUNING.doubleAngle(0.43rad) 的度数
  let t30 = -1, peak = 0, tPeak = -1;
  for (let i = 0; i < 90; i++) {
    run(1, { throttle: 1, steer: 1, drift: true }, i * dt);
    const a = Math.abs(deg(b.driftAngle));
    if (a >= dblDeg && t30 < 0) t30 = r2(i * dt);
    if (a > peak) { peak = a; tPeak = r2(i * dt); }
  }
  const build = { t30, peak, tPeak };

  // ---------- ③ 拖漂：长按 3 秒的保速率 ----------
  reset(0); warm();
  const topStraight = b.speed;
  const hold = [];
  for (let s = 1; s <= 3; s++) {
    run(60, { throttle: 1, steer: 1, drift: true }, (s - 1));
    hold.push(r2((b.speed / topStraight) * 100));
  }
  const drag = { topStraight: kmh(topStraight), keep: hold };

  // ---------- ④ 出弯喷：松键后 1 秒 ----------
  reset(0); warm();
  run(72, { throttle: 1, steer: 1, drift: true });
  const exitAngle = deg(b.driftAngle);
  run(1, { throttle: 1, steer: 1, drift: false });
  const granted = b.miniBoostQueue + (b.miniBoostTimer > 0 ? 1 : 0);
  let exitPeak = 0;
  for (let i = 0; i < 60; i++) {
    run(1, { throttle: 1, steer: 0, drift: false });
    exitPeak = Math.max(exitPeak, b.speed);
  }
  const exit = { angleAtRelease: exitAngle, granted, peak: kmh(exitPeak), ratio: r2(exitPeak / topStraight) };

  // ---------- ⑤ 回正双喷（按住漂移键不松）----------
  reset(0); warm();
  run(72, { throttle: 1, steer: 1, drift: true });     // 1.2s 拉满角度
  const beforeStraighten = { drift: b.drifting, angle: deg(b.driftAngle) };
  // 松方向键但一直按住漂移键：车头应当快速甩正并当场双喷
  run(36, { throttle: 1, steer: 0, drift: true });
  const afterStraighten = {
    drift: b.drifting,
    angle: deg(b.driftAngle),
    queue: b.miniBoostQueue,
    timer: r2(b.miniBoostTimer),
  };
  let straightenPeak = 0;
  for (let i = 0; i < 60; i++) {
    run(1, { throttle: 1, steer: 0, drift: true });
    straightenPeak = Math.max(straightenPeak, b.speed);
  }
  const straighten = { beforeStraighten, afterStraighten, peak: kmh(straightenPeak), ratio: r2(straightenPeak / topStraight) };

  // ---------- ⑥ 彩虹漂：左右反打 ----------
  reset(0); warm();
  const swing = [];
  let flips = 0, prevSign = 0;
  const gauge0 = b.nitroCharge + b.nitroBottles;
  for (let k = 0; k < 8; k++) {
    const s = k % 2 === 0 ? 1 : -1;
    for (let i = 0; i < 20; i++) {
      run(1, { throttle: 1, steer: s, drift: true });
      swing.push(deg(b.driftAngle));
      const sg = Math.sign(b.driftAngle);
      if (sg !== 0 && sg !== prevSign) { if (prevSign !== 0) flips++; prevSign = sg; }
    }
  }
  const rainbow = {
    flips,
    min: Math.min(...swing), max: Math.max(...swing),
    stillDrifting: b.drifting,
    gaugeGain: r2((b.nitroCharge + b.nitroBottles) - gauge0),
  };

  // ---------- ⑦ 撞障碍：只丢本次集气 ----------
  reset(0); warm();
  b.nitroCharge = 0.45; b.nitroBottles = 1;      // 之前攒下的家底
  run(120, { throttle: 1, steer: 1, drift: true });   // 2 秒漂移集气
  const beforeHit = { charge: r2(b.nitroCharge), bottles: b.nitroBottles, gaugeStart: r2(b.driftGaugeStart) };
  b.cancelDriftForCollision();
  const afterHit = { charge: r2(b.nitroCharge), bottles: b.nitroBottles, drifting: b.drifting, collided: b.driftCollided };
  // 撞完继续按住漂移键：冷却过了要能重新起漂
  run(30, { throttle: 0.4, steer: 1, drift: true });
  const reengage = { drifting: b.drifting, lockout: r2(b.driftLockout) };
  const hit = { beforeHit, afterHit, reengage };

  // ---------- ⑧ 弯道能力：漂移 vs 普通 ----------
  // 轨迹转角 = 速度方向的累计变化（真正的"弯转了多少"）；
  // 车头转角（heading）在漂移里会被滑移角额外放大，不能拿来比弯道能力。
  const turnTest = (drift) => {
    reset(0); warm();
    const h0 = b.heading, x0 = b.pos.x, z0 = b.pos.z;
    let prev = Math.atan2(b.vel.x, b.vel.y), path = 0;
    for (let i = 0; i < 120; i++) {
      run(1, { throttle: 1, steer: 1, drift }, i * dt);
      const a = Math.atan2(b.vel.x, b.vel.y);
      let d = a - prev;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      path += d;
      prev = a;
    }
    return { dh: deg(b.heading - h0), path: deg(path), travel: r2(Math.hypot(b.pos.x - x0, b.pos.z - z0)), end: kmh(b.speed) };
  };
  const turn = { drift: turnTest(true), normal: turnTest(false) };

  // ---------- ⑨ 过 90° 弯的代价：漂移 vs 纯打方向 ----------
  // 这是"漂移到底有没有用"的唯一硬指标：转同样的 90°，谁更快、半径谁更小。
  const corner = (useDrift) => {
    reset(0); warm();
    let prev = Math.atan2(b.vel.x, b.vel.y), turned = 0, t = 0, minS = 1e9, jump = 0;
    while (turned < Math.PI / 2 && t < 6) {
      run(1, { throttle: 1, steer: 1, drift: useDrift }, t);
      const a = Math.atan2(b.vel.x, b.vel.y);
      let d = a - prev;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      turned += d; prev = a; t += dt;
      minS = Math.min(minS, b.speed);
    }
    const s90 = b.speed;
    let peak = 0;
    for (let i = 0; i < 54; i++) { run(1, { throttle: 1, steer: 0, drift: false }); peak = Math.max(peak, b.speed); }
    return { t: r2(t), s90: kmh(s90), minSpeed: kmh(minS), radius: r2(s90 / ((Math.PI / 2) / t)), exitPeak: kmh(peak) };
  };
  const cornerTest = { drift: corner(true), plain: corner(false) };

  // ---------- ⑩ 短点一下不该给喷 ----------
  reset(0); warm();
  run(6, { throttle: 1, steer: 1, drift: true });
  run(2, { throttle: 1, steer: 1, drift: false });
  const tap = { angle: deg(b.driftAngle), queue: b.miniBoostQueue, timer: r2(b.miniBoostTimer) };

  // ---------- ⑩ 断漂补气：松一下马上再按住 ----------
  reset(0); warm();
  run(60, { throttle: 1, steer: 1, drift: true });
  const chainBefore = { time: r2(b.driftTime), angle: deg(b.driftAngle) };
  run(12, { throttle: 1, steer: 1, drift: false });   // 松 0.2s
  const midAngle = deg(b.driftAngle);
  run(1, { throttle: 1, steer: 1, drift: true });
  const chainAfter = { drifting: b.drifting, time: r2(b.driftTime), chain: r2(b.driftChain) };

  return JSON.stringify({
    boat: def.name, id: def.id, maxSpeed: def.maxSpeed,
    handling: b.handling,
    entry, build, drag, exit, straighten, rainbow, hit, turn, cornerTest, tap,
    chain: { chainBefore, midAngle, chainAfter },
    spd: spd.slice(0, 40),
    ang: ang.slice(0, 40),
  });
})()`;

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const pageErrors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'exception');
    }
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
      pageErrors.push(m.params.entry.text);
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Log.enable');
  await sleep(2500);
  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true });
    return r.result?.value;
  };
  const click = (sel) => evalJs(`!!document.querySelector(${JSON.stringify(sel)})?.click()`);
  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalJs(expr)) return true;
      await sleep(300);
    }
    return false;
  };

  // 主菜单 → 大厅（#btn-solo 的 onclick 是异步挂的，要等）
  if (!await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`)) {
    throw new Error('主菜单没就绪');
  }
  await click('#btn-solo');
  if (!await waitFor(`!!document.querySelector('#lobby') && !document.querySelector('#lobby').classList.contains('hidden')`)) {
    throw new Error('大厅没打开');
  }
  // 选艇
  await click('#btn-lobby-boat'); await sleep(400);
  await evalJs(`!!document.querySelector('.lp-card[data-boat="${boatId}"]')?.click()`); await sleep(300);
  await click('#btn-lobby-pick-close'); await sleep(300);
  // 选图
  await click('#btn-lobby-map'); await sleep(400);
  await evalJs(`!!document.querySelector('.lp-card[data-map="${mapId}"]')?.click()`); await sleep(300);
  await click('#btn-lobby-pick-close'); await sleep(300);
  // 发车
  await click('#btn-start-race');
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 40000)) {
    throw new Error('对局没起来');
  }
  await sleep(800);
  // 防结算时 dispose 掉 __game
  await evalJs(`(() => { const g=window.__game; if(!g) return false; g.opts.onFinish=null; g.opts.onQuit=null; g.phase='racing'; return true; })()`);
  const chosen = await evalJs(`window.__game.localBoat.def.id`);
  if (chosen !== boatId) console.error(`[warn] 实际船 = ${chosen}（要求 ${boatId}）`);

  const res = await cdp('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: false });
  if (res.exceptionDetails) {
    console.error('EXC:', JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails));
  } else {
    const data = JSON.parse(res.result.value);
    data.pageErrors = pageErrors.slice(0, 6);
    console.log(JSON.stringify(data));
    const t = data.turn;
    console.error(`--- ${data.boat}(${data.id}) 峰值滑移角 ${data.build.peak}° / ${data.build.t30}s 到 30°`
      + ` | 入漂 1s 掉速 ${data.entry.drop1s}%（单帧最大 ${data.entry.maxDrop}%）`
      + ` | 拖漂 3s 保持 ${data.drag.keep[2]}%`
      + ` | 出弯${data.exit.granted === 2 ? '双' : data.exit.granted === 1 ? '单' : '无'}喷 → ${data.exit.ratio}x 极速`
      + ` | 回正${data.straighten.afterStraighten.drift ? '未断漂' : '断漂'}（峰值 ${data.straighten.ratio}x）`
      + ` | 轨迹转角 漂${t.drift.path}° vs 直${t.normal.path}°`
      + ` | 彩虹漂换向 ${data.rainbow.flips} 次(气+${data.rainbow.gaugeGain})`
      + ` | 撞障碍 气 ${data.hit.beforeHit.charge}→${data.hit.afterHit.charge} 瓶 ${data.hit.beforeHit.bottles}→${data.hit.afterHit.bottles}`
      + `\n    转 90° 弯：漂移 ${data.cornerTest.drift.t}s（半径 ${data.cornerTest.drift.radius}m，出弯 ${data.cornerTest.drift.s90}→${data.cornerTest.drift.exitPeak}km/h）`
      + ` / 不漂 ${data.cornerTest.plain.t}s（半径 ${data.cornerTest.plain.radius}m，${data.cornerTest.plain.s90}km/h）`
      + `
    转 90° 弯：漂移 ${data.cornerTest.drift.t}s（半径 ${data.cornerTest.drift.radius}m，出弯 ${data.cornerTest.drift.s90}→${data.cornerTest.drift.exitPeak}km/h）`
      + ` / 不漂 ${data.cornerTest.plain.t}s（半径 ${data.cornerTest.plain.radius}m，${data.cornerTest.plain.s90}km/h）`
      + ` | 点按喷 ${data.tap.queue}/${data.tap.timer}`
      + ` | 页面异常 ${data.pageErrors.length}`);
    if (data.pageErrors.length) console.error(data.pageErrors);
  }
} finally {
  await cleanup();
}
