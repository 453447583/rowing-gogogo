import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/diag-' + Date.now());
const port = 9990 + Math.floor(Math.random() * 30);
const outDir = path.resolve('shots/verify4');
await fs.mkdir(outDir, { recursive: true });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=960,540', 'http://127.0.0.1:5173/'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, 90000); pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } }); }); };
const evalJS = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error'); return r.result.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(u) { const t0 = Date.now(); while (Date.now() - t0 < 25000) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('cdp'); }
async function waitFor(expr, label, tries = 120, gap = 500) { for (let i = 0; i < tries; i++) { if (await evalJS(expr).catch(() => false)) return; await sleep(gap); } throw new Error('timeout ' + label); }
async function shot(n) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(outDir, n + '.png'), Buffer.from(r.data, 'base64')); console.log('shot', n); }
try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`, 'menu');
  await sleep(400);
  const nitro = await evalJS(`(() => {
    const stock = document.querySelector('#nitro-stock');
    stock.classList.remove('hidden');
    document.querySelectorAll('.nitro-slot').forEach(s => s.classList.add('packed'));
    const pack = document.querySelector('.nitro-pack');
    const cs = getComputedStyle(pack);
    const r = pack.getBoundingClientRect();
    const sr = stock.getBoundingClientRect();
    return { display: cs.display, opacity: cs.opacity, w: r.width, h: r.height, stock: [sr.width, sr.height] };
  })()`);
  console.log('NITRO', JSON.stringify(nitro));
  await sleep(200);
  await shot('hud_nitro');
  // enter palace
  await evalJS(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#btn-lobby-map')`, 'lobby');
  await sleep(700);
  await evalJS(`document.querySelector('#btn-lobby-map')?.click()`);
  await waitFor(`!!document.querySelector('.lp-card-map')`, 'drawer');
  await sleep(400);
  await evalJS(`document.querySelector('.lp-card-map[data-map="palace"]')?.click()`);
  await sleep(300);
  await evalJS(`document.querySelector('#btn-start-race')?.click()`);
  await waitFor(`!!(window.__game && window.__game.localBoat)`, 'game', 160);
  await sleep(1500);
  await waitFor(`(window.__game.env.palaceMovers || []).length > 0`, 'movers', 60, 500);
  const info = await evalJS(`(() => {
    const g = window.__game;
    return {
      map: g.mapDef.id,
      moverGates: g.mapDef.moverGates,
      movers: (g.env.palaceMovers || []).map(m => ({ x: +m.collider.x.toFixed(1), z: +m.collider.z.toFixed(1), r: +m.collider.r.toFixed(2) })),
      archSpots: (g.env.palaceArchSpots || []).length,
      coralSpots: (g.env.palaceCoralSpots || []).length,
      boulderSpots: (g.env.palaceBoulderSpots || []).length,
      props: (g.track.courseProps || []).map(p => ({ kind: p.kind, gate: p.gate })),
    };
  })()`);
  console.log('PALACE', JSON.stringify(info));
  await evalJS(`(() => { document.querySelector('#hud').style.display='none'; const g = window.__game; g.phase='racing'; g.countdownLeft=0; })()`);
  const goto = async (a, b, t) => {
    await evalJS(`(() => {
      const g = window.__game, A = g.mapDef.gates[${a}], B = g.mapDef.gates[${b}];
      const tx = A[0]+(B[0]-A[0])*${t}, tz = A[1]+(B[1]-A[1])*${t};
      const hd = Math.atan2(B[0]-A[0], B[1]-A[1]);
      const boat = g.localBoat;
      boat.resetTo(tx, tz, hd); boat.heading = hd; boat.speed = 0;
      const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = ${b}; pm.lap = 1; }
      g.cameraRig.snapTo(boat);
    })()`);
    await sleep(1400);
    await evalJS(`(() => { const g = window.__game; g.cameraRig.snapTo(g.localBoat); })()`);
    await sleep(300);
  };
  // 让移动礁先走到偏移最大处，再去拍
  await sleep(2500);
  await goto(8, 9, 0.35); await shot('palace_arch_new');
  await goto(0, 1, 0.5); await shot('palace_mover_g1');
  await goto(7, 8, 0.4); await shot('palace_mover_g8');
  await goto(13, 14, 0.5); await shot('palace_mover_g14');
  const after = await evalJS(`(() => {
    const g = window.__game;
    return (g.env.palaceMovers || []).map(m => ({ x: +m.collider.x.toFixed(1), z: +m.collider.z.toFixed(1), px: +m.collider.px.toFixed(1), pz: +m.collider.pz.toFixed(1) }));
  })()`);
  console.log('MOVERS_AFTER', JSON.stringify(after));
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} await sleep(300); process.exit(process.exitCode || 0); }
