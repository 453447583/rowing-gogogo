// 临时诊断：定点截图 + 场景几何体 X 光
// node tests/_tmp_xray.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/xray-' + Date.now());
const port = 9600 + Math.floor(Math.random() * 120);
const outDir = path.resolve('shots/xray');
await fs.mkdir(outDir, { recursive: true });

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=960,540', `${base}`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const listeners = new Set();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, ${ms}))`, awaitPromise: true });
function waitEvent(method, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { listeners.delete(fn); reject(new Error('event timeout: ' + method)); }, timeout);
    const fn = (m) => { if (m.method !== method) return; clearTimeout(t); listeners.delete(fn); resolve(m.params); };
    listeners.add(fn);
  });
}
const evalJS = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
async function waitJson(url, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('devtools timeout: ' + url);
}
async function shot(name) {
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  const f = path.join(outDir, name + '.png');
  await fs.writeFile(f, Buffer.from(res.data, 'base64'));
  console.log('  shot ->', path.relative(process.cwd(), f));
}
async function waitFor(expr, label, tries = 90, gap = 500) {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(expr).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error('timeout waiting for ' + label);
}
async function enterMap(mapId) {
  await cdp('Page.reload', { ignoreCache: true }).catch(() => {});
  await waitEvent('Page.loadEventFired', 60000).catch(() => {});
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`, 'main menu', 120, 700);
  await new Promise((r) => setTimeout(r, 600));
  await evalJS(`(() => { document.querySelector('#btn-solo')?.click(); })()`);
  await waitFor(`!!document.querySelector('#btn-lobby-map')`, 'lobby', 60, 500);
  await new Promise((r) => setTimeout(r, 800));
  await evalJS(`(() => { document.querySelector('#btn-lobby-map')?.click(); })()`);
  await waitFor(`!!document.querySelector('.lp-card-map')`, 'map drawer', 60, 500);
  await new Promise((r) => setTimeout(r, 400));
  await evalJS(`(() => { document.querySelector('.lp-card-map[data-map="${mapId}"]')?.click(); })()`);
  await new Promise((r) => setTimeout(r, 500));
  await evalJS(`(() => { document.querySelector('#btn-start-race')?.click(); })()`);
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    await evalJS(`(() => {
      const g = window.__game;
      if (g) return 'already';
      const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === ${JSON.stringify(mapId)});
      if (!card) return 'no-card';
      card.click();
      document.querySelector('#btn-map-ok')?.click();
      return 'clicked';
    })()`).catch(() => 'err');
    await new Promise((res) => setTimeout(res, 3000));
    started = await evalJS(`!!window.__game`).catch(() => false);
  }
  await sleep(6000);
  const id = await evalJS(`(() => {
    const g = window.__game; if (!g) return 'no game';
    g.phase = 'racing'; g.countdownLeft = 0;
    g.renderer.setSize(960, 540, false);
    return g.mapDef?.id;
  })()`);
  if (id !== mapId) throw new Error(`map is ${id}, expected ${mapId}`);
  console.log('  map =', id);
}
async function place(gateA, gateB, t = 0.35) {
  await waitFor(`!!(window.__game && window.__game.localBoat && window.__game.mapDef)`, 'game instance');
  await evalJS(`(() => {
    const g = window.__game;
    const a = g.mapDef.gates[${gateA}], b = g.mapDef.gates[${gateB}];
    const tx = a[0] + (b[0] - a[0]) * ${t};
    const tz = a[1] + (b[1] - a[1]) * ${t};
    const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const boat = g.localBoat;
    boat.resetTo(tx, tz, heading);
    boat.speed = 9; boat.vel.set(0, 0);
    const pm = g.progressMap?.get(g.myId);
    if (pm) { pm.gate = ${gateB}; pm.lap = 1; }
    for (const [id, b2] of g.boats) {
      const p = g.progressMap.get(id);
      b2.diveTargetY = g.track.diveHeightAt(b2.pos, p ? p.gate : null);
    }
    g.cameraRig?.snap?.();
  })()`);
  await sleep(1000);
}
// 场景 X 光：列出船附近的合成几何体
async function xray(label, radius = 110) {
  const rows = await evalJS(`(() => {
    const g = window.__game;
    const boat = g.localBoat;
    const out = [];
    const v = new (boat.pos.constructor)();
    g.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const t = o.geometry.type || '';
      if (!/Cylinder|Box|Cone|Torus|Tetra|Octa|Dodeca|Icosa/.test(t)) return;
      o.getWorldPosition(v);
      const d = Math.hypot(v.x - boat.pos.x, v.z - boat.pos.z);
      if (d > ${radius}) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const col = m && m.color ? '#' + m.color.getHexString() : '';
      const em = m && m.emissive ? '#' + m.emissive.getHexString() : '';
      let parent = o.parent, chain = [];
      for (let i = 0; i < 4 && parent; i++) { chain.push(parent.name || parent.type); parent = parent.parent; }
      out.push({ t, d: +d.toFixed(1), x: +v.x.toFixed(1), y: +v.y.toFixed(1), z: +v.z.toFixed(1),
        col, em, name: o.name, chain: chain.join('<') });
    });
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, 90);
  })()`);
  console.log('--- xray', label, '---');
  for (const r of rows) console.log(`${r.d}m ${r.t} @(${r.x},${r.y},${r.z}) col=${r.col} em=${r.em} name=${r.name} chain=${r.chain}`);
}

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    for (const l of listeners) l(m);
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');

  await enterMap('ocean');
  for (const [a, b, t, tag] of [[4, 5, 0.5, 'g4-5'], [5, 6, 0.5, 'g5-6'], [6, 7, 0.5, 'g6-7'], [9, 10, 0.5, 'g9-10'], [24, 26, 0.3, 'g25-overpass'], [26, 28, 0.4, 'g27-ring']]) {
    await place(a, b, t);
    await shot(`ocean_${tag}`);
  }
  await xray('ocean g6', 90);

  await enterMap('palace');
  for (const [a, b, t, tag] of [[7, 8, 0.5, 'g7-8'], [8, 9, 0.5, 'g8-9'], [9, 10, 0.5, 'g9-10'], [12, 13, 0.5, 'g12-13']]) {
    await place(a, b, t);
    await shot(`palace_${tag}`);
  }
  await xray('palace g8', 130);
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 400));
  process.exit(process.exitCode || 0);
}
