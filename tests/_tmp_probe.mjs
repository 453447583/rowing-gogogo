// 临时诊断 v2：定点截图 + 场景结构
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/probe-' + Date.now());
const port = 9850 + Math.floor(Math.random() * 100);
const outDir = path.resolve('shots/probe');
await fs.mkdir(outDir, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=800,450', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, 45000);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const evalJS = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url) { const t0 = Date.now(); while (Date.now() - t0 < 25000) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('cdp not ready'); }
async function waitFor(expr, label, tries = 90, gap = 500) { for (let i = 0; i < tries; i++) { if (await evalJS(expr).catch(() => false)) return; await sleep(gap); } throw new Error('timeout ' + label); }
async function shot(name) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(outDir, name + '.png'), Buffer.from(r.data, 'base64')); console.log('shot', name); }
async function enterMap(mapId) {
  await cdp('Page.reload', { ignoreCache: true }).catch(() => {});
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`, 'menu', 150, 600);
  await sleep(500);
  await evalJS(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#btn-lobby-map')`, 'lobby', 60, 500);
  await sleep(700);
  await evalJS(`document.querySelector('#btn-lobby-map')?.click()`);
  await waitFor(`!!document.querySelector('.lp-card-map')`, 'drawer', 40, 400);
  await sleep(300);
  await evalJS(`document.querySelector('.lp-card-map[data-map="${mapId}"]')?.click()`);
  await sleep(400);
  await evalJS(`document.querySelector('#btn-start-race')?.click()`);
  await waitFor(`!!(window.__game && window.__game.localBoat)`, 'game', 160, 500);
  await sleep(2500);
  await evalJS(`(() => { const g = window.__game; g.phase='racing'; g.countdownLeft=0; })()`);
  const id = await evalJS(`window.__game.mapDef.id`);
  if (id !== mapId) throw new Error('map=' + id);
  console.log('map', id);
}
async function place(a, b, t = 0.4) {
  await evalJS(`(() => {
    const g = window.__game;
    const A = g.mapDef.gates[${a}], B = g.mapDef.gates[${b}];
    const tx = A[0] + (B[0]-A[0]) * ${t}, tz = A[1] + (B[1]-A[1]) * ${t};
    const hd = Math.atan2(B[0]-A[0], B[1]-A[1]);
    g.localBoat.resetTo(tx, tz, hd);
    g.localBoat.speed = 8;
    const pm = g.progressMap?.get(g.myId); if (pm) { pm.gate = ${b}; pm.lap = 1; }
    g.cameraRig?.snap?.();
    return [tx, tz];
  })()`);
  await sleep(1200);
}
async function xray(label, radius) {
  const rows = await evalJS(`(() => {
    const g = window.__game, boat = g.localBoat, out = [];
    const v = boat.pos.clone();
    g.env.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      o.getWorldPosition(v);
      const d = Math.hypot(v.x - boat.pos.x, v.z - boat.pos.z);
      if (d > ${radius}) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const col = m?.color ? '#' + m.color.getHexString() : '';
      let p = o.parent, chain = [];
      for (let i = 0; i < 5 && p; i++) { chain.push(p.name || p.type); p = p.parent; }
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      out.push({ d: +d.toFixed(1), geo: o.geometry.type, x: +v.x.toFixed(1), y: +v.y.toFixed(1), z: +v.z.toFixed(1),
        sx: +(bb.max.x-bb.min.x).toFixed(1), sy: +(bb.max.y-bb.min.y).toFixed(1), sz: +(bb.max.z-bb.min.z).toFixed(1),
        col, em: m?.emissive ? '#' + m.emissive.getHexString() : '', n: o.name, ch: chain.join('<') });
    });
    out.sort((a,b) => a.d - b.d);
    return out.slice(0, 70);
  })()`);
  console.log('--- xray', label, '---');
  for (const r of rows) console.log(`${r.d}m ${r.geo} ${r.sx}x${r.sy}x${r.sz} @(${r.x},${r.y},${r.z}) ${r.col} em${r.em} n='${r.n}' ch=${r.ch}`);
}
try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');

  await enterMap('ocean');
  await place(9, 10, 0.5); await shot('ocean_g9-10'); await xray('ocean g10', 90);
  await place(10, 11, 0.45); await shot('ocean_g10-11');
  await place(24, 26, 0.35); await shot('ocean_g25');
  await place(26, 28, 0.45); await shot('ocean_g27');

  await enterMap('palace');
  await place(7, 8, 0.5); await shot('palace_g7-8'); await xray('palace g8', 150);
  await place(8, 9, 0.5); await shot('palace_g8-9');
  await place(2, 3, 0.5); await shot('palace_g2-3');
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(300);
  process.exit(process.exitCode || 0);
}
