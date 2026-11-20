import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/diag2-' + Date.now());
const port = 10020 + Math.floor(Math.random() * 30);
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
async function enterMap(mapId) {
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`, 'menu');
  await sleep(400);
  await evalJS(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#btn-lobby-map')`, 'lobby');
  await sleep(700);
  await evalJS(`document.querySelector('#btn-lobby-map')?.click()`);
  await waitFor(`!!document.querySelector('.lp-card-map')`, 'drawer');
  await sleep(400);
  await evalJS(`document.querySelector('.lp-card-map[data-map="${mapId}"]')?.click()`);
  await sleep(300);
  await evalJS(`document.querySelector('#btn-start-race')?.click()`);
  await waitFor(`!!(window.__game && window.__game.localBoat)`, 'game', 160);
  await sleep(1500);
}
async function goto(a, b, t) {
  await evalJS(`(() => {
    const g = window.__game, A = g.mapDef.gates[${a}], B = g.mapDef.gates[${b}];
    const tx = A[0]+(B[0]-A[0])*${t}, tz = A[1]+(B[1]-A[1])*${t};
    const hd = Math.atan2(B[0]-A[0], B[1]-A[1]);
    const boat = g.localBoat;
    boat.resetTo(tx, tz, hd); boat.heading = hd; boat.speed = 0;
    const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = ${b}; pm.lap = 1; }
    g.cameraRig.snapTo(boat);
  })()`);
  await sleep(1300);
  await evalJS(`(() => { const g = window.__game; g.cameraRig.snapTo(g.localBoat); })()`);
  await sleep(300);
}
try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await enterMap('palace');
  await waitFor(`(window.__game.env.palaceArchProps || []).length > 0`, 'archprops', 60, 500);
  const props = await evalJS(`(() => {
    const g = window.__game;
    const info = (h) => {
      const root = h.children[0];
      return { pos: [+h.position.x.toFixed(1), +h.position.y.toFixed(2), +h.position.z.toFixed(1)], yaw: +h.rotation.y.toFixed(2), scale: +root.scale.x.toFixed(3), kids: root.children.length, vis: h.visible };
    };
    return {
      arch: (g.env.palaceArchProps || []).slice(0, 4).map(info),
      movers: (g.env.palaceMovers || []).map(m => info(m.holder)),
    };
  })()`);
  console.log('PROPS', JSON.stringify(props));
  await evalJS(`(() => { document.querySelector('#hud').style.display='none'; const g = window.__game; g.phase='racing'; g.countdownLeft=0; })()`);
  // 把 0 号移动礁钉在船正前方 26m，近距离看模型
  await goto(0, 1, 0.45);
  await evalJS(`(() => {
    const g = window.__game, mv = g.env.palaceMovers[0], boat = g.localBoat;
    mv.amp = 0; mv.phase = 0;
    mv.cx = boat.pos.x + Math.sin(boat.heading) * 26;
    mv.cz = boat.pos.z + Math.cos(boat.heading) * 26;
    g.cameraRig.snapTo(boat);
  })()`);
  await sleep(600);
  await shot('coral_mover_close');
  // 把 0 号入口珊瑚礁钉在正前方
  await evalJS(`(() => {
    const g = window.__game, h = g.env.palaceArchProps[0], boat = g.localBoat;
    h.position.set(boat.pos.x + Math.sin(boat.heading) * 26, -2.6, boat.pos.z + Math.cos(boat.heading) * 26);
    g.cameraRig.snapTo(boat);
  })()`);
  await sleep(400);
  await shot('coral_arch_close');
  // 氮气 HUD（比赛内，hud 已显示）
  await evalJS(`(() => {
    document.querySelector('#hud').style.display = '';
    const stock = document.querySelector('#nitro-stock');
    stock.classList.remove('hidden');
    document.querySelectorAll('.nitro-slot').forEach(s => s.classList.add('packed'));
  })()`);
  await sleep(300);
  const nitro = await evalJS(`(() => {
    const stock = document.querySelector('#nitro-stock');
    const pack = document.querySelector('.nitro-pack');
    const sr = stock.getBoundingClientRect(), pr = pack.getBoundingClientRect();
    const cs = getComputedStyle(pack);
    return { display: cs.display, opacity: cs.opacity, w: +pr.width.toFixed(1), h: +pr.height.toFixed(1), stock: [+sr.width.toFixed(1), +sr.height.toFixed(1)] };
  })()`);
  console.log('NITRO', JSON.stringify(nitro));
  await shot('hud_nitro_race');
} catch (e) { console.error('FAIL', e.message); process.exitCode = 1; }
finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} await sleep(300); process.exit(process.exitCode || 0); }
