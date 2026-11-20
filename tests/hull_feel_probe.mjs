// 逐船手感实测：node tests/hull_feel_probe.mjs [baseUrl] [boatIndex]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const boatIndex = Number(process.argv[3] ?? 0);
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hull-feel-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=900,520', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };

const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

async function waitJson(url, timeout = 20000) {
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
  await click('#btn-solo'); await sleep(1000);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][${boatIndex}]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(900);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='ocean'); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  await sleep(1500);
  await cdp('Runtime.evaluate', { expression: `(() => { const b=document.querySelector('#btn-start-race'); if (b && !b.classList.contains('hidden')) b.click(); })()` });
  for (let i = 0; i < 40; i++) {
    const r = await cdp('Runtime.evaluate', { expression: '!!(window.__game && window.__game.track && window.__game.localBoat)', returnByValue: true });
    if (r.result.value) break;
    await sleep(1000);
  }
  await sleep(1500);

  const res = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game, b = g.localBoat, def = b.def;
      const dt = 1 / 60;
      // 1) 0 → 90% 极速
      b.resetTo(0, 0, 0);
      let t = 0, t90 = null;
      for (let i = 0; i < 60 * 30; i++) {
        t += dt;
        b.updateLocal(dt, { throttle: 1, steer: 0 }, t, [], null);
        if (b.speed >= def.maxSpeed * 0.9) { t90 = t; break; }
      }
      // 2) 松油门滑行到 50%
      const v0 = b.speed;
      let coastT = 0, coastD = 0;
      while (b.speed > v0 * 0.5 && coastT < 40) {
        const x0 = b.pos.x, z0 = b.pos.z;
        coastT += dt;
        b.updateLocal(dt, { throttle: 0, steer: 0 }, t + coastT, [], null);
        coastD += Math.hypot(b.pos.x - x0, b.pos.z - z0);
      }
      // 3) 转向（打满 1 秒）
      const turnTest = (speed) => {
        b.resetTo(0, 0, 0);
        b.vel.set(0, speed); b.speed = speed;
        const h0 = b.heading;
        for (let i = 0; i < 60; i++) b.updateLocal(dt, { throttle: 1, steer: 1 }, 1 + i * dt, [], null);
        return +(((b.heading - h0) * 180) / Math.PI).toFixed(1);
      };
      // 4) 漂移 0.6 秒掉多少速（入漂瞬间掉速 + 漂移阻力）
      const driftTest = () => {
        b.resetTo(0, 0, 0);
        b.vel.set(0, 25); b.speed = 25;
        const v1 = b.speed;
        for (let i = 0; i < 36; i++) b.updateLocal(dt, { throttle: 1, steer: 1, drift: true }, 1 + i * dt, [], null);
        return { before: +v1.toFixed(1), after: +b.speed.toFixed(1) };
      };
      return JSON.stringify({
        boat: def.name,
        handling: b.handling,
        t90: t90 ? +t90.toFixed(2) : null,
        coastT: +coastT.toFixed(2), coastD: +coastD.toFixed(0),
        turn5: turnTest(5), turn15: turnTest(15), turn28: turnTest(28),
        drift: driftTest(),
      });
    })()`, returnByValue: true,
  });
  console.log(res.result.value);
} finally {
  await cleanup();
}
