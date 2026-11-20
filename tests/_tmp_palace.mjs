// 临时诊断 v3：仅深海龙宫
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/palace-' + Date.now());
const port = 9950 + Math.floor(Math.random() * 40);
const outDir = path.resolve('shots/palace');
await fs.mkdir(outDir, { recursive: true });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=720,405', 'http://127.0.0.1:5173/'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, 90000); pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } }); }); };
const evalJS = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error'); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(u) { const t0 = Date.now(); while (Date.now() - t0 < 25000) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('cdp'); }
async function waitFor(expr, label, tries = 90, gap = 500) { for (let i = 0; i < tries; i++) { if (await evalJS(expr).catch(() => false)) return; await sleep(gap); } throw new Error('timeout ' + label); }
async function shot(n) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(outDir, n + '.png'), Buffer.from(r.data, 'base64')); console.log('shot', n); }
try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`, 'menu', 160, 600);
  await sleep(400);
  await evalJS(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#btn-lobby-map')`, 'lobby');
  await sleep(600);
  await evalJS(`document.querySelector('#btn-lobby-map')?.click()`);
  await waitFor(`!!document.querySelector('.lp-card-map')`, 'drawer');
  await sleep(300);
  await evalJS(`document.querySelector('.lp-card-map[data-map="palace"]')?.click()`);
  await sleep(300);
  await evalJS(`document.querySelector('#btn-start-race')?.click()`);
  await waitFor(`!!(window.__game && window.__game.localBoat)`, 'game', 160, 500);
  await sleep(2500);
  await evalJS(`(() => { const g = window.__game; g.phase='racing'; g.countdownLeft=0; return g.mapDef.id; })()`);
  await evalJS(`(() => {
    const g = window.__game, A = g.mapDef.gates[7], B = g.mapDef.gates[8];
    const t = 0.5, tx = A[0]+(B[0]-A[0])*t, tz = A[1]+(B[1]-A[1])*t;
    g.localBoat.resetTo(tx, tz, Math.atan2(B[0]-A[0], B[1]-A[1]));
    const pm = g.progressMap?.get(g.myId); if (pm) { pm.gate = 8; pm.lap = 0; }
    g.cameraRig?.snap?.();
  })()`);
  await sleep(1500);
  await shot('g8');
  const dump = await evalJS(`(() => {
    const g = window.__game, boat = g.localBoat, out = [];
    const box = new (boat.pos.constructor)();
    g.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox;
      const c = bb.getCenter(box.clone()).applyMatrix4(o.matrixWorld);
      const size = bb.getSize(box.clone()).multiply(o.getWorldScale(box.clone()));
      const d = Math.hypot(c.x - boat.pos.x, c.z - boat.pos.z);
      if (d > 140 || size.y < 0.4) return;
      let p = o.parent, chain = [];
      for (let i = 0; i < 5 && p; i++) { chain.push(p.name || p.type); p = p.parent; }
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      out.push({ d: +d.toFixed(0), geo: o.geometry.type, x: +c.x.toFixed(1), y: +c.y.toFixed(1), z: +c.z.toFixed(1),
        sx: +size.x.toFixed(1), sy: +size.y.toFixed(1), sz: +size.z.toFixed(1),
        col: m?.color ? '#' + m.color.getHexString() : '', map: m?.map ? 1 : 0, n: o.name, ch: chain.join('<') });
    });
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, 80);
  })()`);
  console.log('--- palace g8 meshes ---');
  for (const r of dump) console.log(`${r.d}m ${r.geo} ${r.sx}x${r.sy}x${r.sz} @(${r.x},${r.y},${r.z}) ${r.col} tex${r.map} n='${r.n}' ch=${r.ch}`);
  const groups = await evalJS(`(() => {
    const g = window.__game, boat = g.localBoat, out = [];
    const p = boat.pos.constructor;
    for (const root of [g.env?.group, g.track?.group]) {
      if (!root) continue;
      for (const ch of root.children) {
        if (!ch.isGroup) continue;
        const c = new p(); ch.getWorldPosition(c);
        out.push({ n: ch.name || ch.type, x: +c.x.toFixed(0), y: +c.y.toFixed(0), z: +c.z.toFixed(0), d: +Math.hypot(c.x - boat.pos.x, c.z - boat.pos.z).toFixed(0), kids: ch.children.length });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, 60);
  })()`);
  console.log('--- groups ---');
  for (const r of groups) console.log(`${r.d}m ${r.n} kids=${r.kids} @(${r.x},${r.y},${r.z})`);
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} await sleep(300); process.exit(process.exitCode || 0); }
