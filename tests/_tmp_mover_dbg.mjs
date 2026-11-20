import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('shots/verify4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.resolve('.tmp_browser/fd-' + Date.now());
const port = 10180 + Math.floor(Math.random() * 20);
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,720', 'http://127.0.0.1:5173/'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, 90000); pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } }); }); };
const evalJS = async (e) => { const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error'); return r.result.value; };
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
  await evalJS(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#btn-lobby-map')`, 'lobby');
  await sleep(700);
  await evalJS(`document.querySelector('#btn-lobby-map')?.click()`);
  await waitFor(`!!document.querySelector('.lp-card-map')`, 'drawer');
  await sleep(400);
  await evalJS(`document.querySelector('.lp-card-map[data-map="palace"]')?.click()`);
  await sleep(300);
  await evalJS(`document.querySelector('#btn-start-race')?.click()`);
  await waitFor(`!!(window.__game && window.__game.localBoat)`, 'game', 200);
  await sleep(3000);
  await waitFor(`(window.__game.env.palaceMovers || []).length > 0`, 'movers', 40, 500);
  const info = await evalJS(`(() => {
    const g = window.__game;
    g.cameraRig.follow = () => {}; g.cameraRig.followLookAt = () => {};
    g.cameraRig.focusPodium = () => {}; g.cameraRig.focusFinish = () => {}; g.cameraRig.snapTo = () => {};
    g.phase = 'racing'; g.countdownLeft = 0; g.raceIntro = null;
    document.body.classList.remove('intro-on');
    const hud = document.querySelector('#hud'); if (hud) hud.style.display = 'none';
    const mv = g.env.palaceMovers[0];
    const h = mv.holder;
    let meshes = 0, visibleMeshes = 0;
    h.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) visibleMeshes++; } });
    h.updateMatrixWorld(true);
    return {
      pos: [+h.position.x.toFixed(1), +h.position.y.toFixed(1), +h.position.z.toFixed(1)],
      rot: +h.rotation.y.toFixed(2), scale: +h.children[0].scale.x.toFixed(3),
      vis: h.visible, inScene: !!h.parent, meshes, visibleMeshes,
      cam: g.camera.position.toArray().map(v => +v.toFixed(1)),
    };
  })()`);
  console.log('MOVER', JSON.stringify(info));
  // 相机放到礁体东侧 18m、高 5m，直视（避开正对太阳的过曝）
  await evalJS(`(() => {
    const g = window.__game, h = g.env.palaceMovers[0].holder;
    g.camera.position.set(h.position.x + 18, 5, h.position.z);
    g.camera.lookAt(h.position.x, 1.2, h.position.z);
    g.camera.updateMatrixWorld();
  })()`);
  await sleep(1500);
  await shot('palace_mover_dbg');
  // 再来一张更近的正上方斜视
  await evalJS(`(() => {
    const g = window.__game, h = g.env.palaceMovers[0].holder;
    g.camera.position.set(h.position.x + 9, 9, h.position.z - 9);
    g.camera.lookAt(h.position.x, 0.5, h.position.z);
    g.camera.updateMatrixWorld();
  })()`);
  await sleep(1200);
  await shot('palace_mover_dbg2');
} catch (e) { console.error('FAIL', e.message); }
finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} await sleep(300); try { await fs.rm(profile, { recursive: true, force: true }); } catch {} process.exit(0); }
