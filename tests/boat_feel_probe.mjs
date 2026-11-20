// 船体手感实测（氮气 / 漂移专项）
//
//   node tests/boat_feel_probe.mjs [baseUrl] [boatIndex] [mapId]
//
// 直接调用 Boat.updateLocal（不经过渲染帧率），所以结果与机器性能无关：
//   ① 直道极速（km/h）
//   ② 氮气：从巡航极速开氮气，5 秒内的峰值 → 用户要的"氮气最高 220 码"
//   ③ 漂移：同样的 2.5 秒里，漂移走的路 vs 直道走的路（漂移骑车比直线还快就是这里露馅）
//   ④ 漂移中/出弯的瞬时速度曲线（看托漂与双喷）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const boatIndex = Number(process.argv[3] ?? 0);
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boat-feel-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=640,400', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };

const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

async function waitJson(url, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('devtools timeout');
}

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2500);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(900);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('.boat-card')][${boatIndex}]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(800);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId===${JSON.stringify(mapId)}); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    const r = await cdp('Runtime.evaluate', { expression: '!!(window.__game && window.__game.localBoat)', returnByValue: true });
    if (r.result.value) break;
    await sleep(800);
  }
  await sleep(800);

  const res = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game, b = g.localBoat, def = b.def;
      const dt = 1 / 60;
      const kmh = (v) => +(v * 3.6).toFixed(1);
      const reset = (v = 0) => {
        b.resetTo(0, 0, 0);
        b.boostTimer = 0; b.miniBoostTimer = 0; b.miniBoostQueue = 0;
        b.nitroBottles = 0; b.nitroCharge = 0; b.nitroAllowed = true;
        b.sinkTimer = 0; b.stunTimer = 0; b.slowTimer = 0; b.halfSpeedTimer = 0;
        b.voidTimer = 0; b.bubbleLiftTimer = 0; b.geyserLiftTimer = 0; b.bubbleFalling = false;
        b.airborne = false; b.onCoaster = null; b.drifting = false; b.driftTime = 0;
        b.driftDir = 0; b.prevNitroKey = false; b.prevDriftKey = false;
        b.steerInput = 0; b.angVel = 0; b.thrustState = 0;
        b.vel.set(0, v); b.speed = v;
        b.heading = 0;
        b.prevPos.copy(b.pos);
      };
      const run = (n, inp, t0 = 0) => {
        for (let i = 0; i < n; i++) b.updateLocal(dt, inp, t0 + i * dt, [], null);
      };

      // ---------- ① 直道极速 ----------
      reset(0);
      const straight = [];
      for (let s = 0; s < 10; s++) {
        run(60, { throttle: 1, steer: 0 });
        straight.push(kmh(b.speed));
      }
      const topStraight = kmh(b.speed);

      // ---------- ② 氮气峰值 ----------
      reset(topStraight / 3.6);
      b.nitroBottles = 2;
      const nitro = [];
      // 先踩 0.5s 油门让 thrustState 起满，再点氮气
      run(30, { throttle: 1, steer: 0 });
      let t = 0;
      for (let s = 0; s < 6; s++) {
        for (let i = 0; i < 30; i++) {
          // 只在第一帧按下（edge trigger）
          run(1, { throttle: 1, steer: 0, nitro: i === 0 && s === 0 }, t);
          t += dt;
        }
        nitro.push(kmh(b.speed));
      }
      const topNitro = Math.max(...nitro);

      // ---------- ③ 漂移 vs 直道（同样 2.5s，走多远）----------
      const travel = (drift) => {
        reset(30);
        const x0 = b.pos.x, z0 = b.pos.z;
        const curve = [];
        for (let s = 0; s < 5; s++) {
          run(30, { throttle: 1, steer: drift ? 1 : 0, drift }, s * 0.5);
          curve.push(kmh(b.speed));
        }
        return { d: +Math.hypot(b.pos.x - x0, b.pos.z - z0).toFixed(1), curve, end: kmh(b.speed) };
      };
      const straightRun = travel(false);
      const driftRun = travel(true);

      // ---------- ④ 出弯瞬间：松漂移后 1s 的速度（托漂/双喷）----------
      reset(30);
      run(120, { throttle: 1, steer: 1, drift: true }, 0);
      const driftExitBefore = kmh(b.speed);
      const exit = [];
      for (let s = 0; s < 8; s++) {
        run(8, { throttle: 1, steer: 0, drift: false }, 2 + s * 0.133);
        exit.push(kmh(b.speed));
      }

      return JSON.stringify({
        boat: def.name, maxSpeed: def.maxSpeed, boostPower: def.boostPower,
        handling: b.handling,
        straight, topStraight,
        nitro, topNitro,
        straightRun, driftRun,
        driftExitBefore, exit,
      }, null, 1);
    })()`, returnByValue: true,
  });
  console.log(res.result.value);
  if (res.exceptionDetails) console.error(res.exceptionDetails);
} finally {
  await cleanup();
}
