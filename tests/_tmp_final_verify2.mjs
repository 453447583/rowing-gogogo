import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outDir = path.resolve('shots/verify4');
await fs.mkdir(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSession(mapId, shots) {
  const profile = path.resolve('.tmp_browser/fv2-' + mapId + '-' + Date.now());
  const port = 10120 + Math.floor(Math.random() * 40);
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
    await evalJS(`document.querySelector('.lp-card-map[data-map="${mapId}"]')?.click()`);
    await sleep(300);
    await evalJS(`document.querySelector('#btn-start-race')?.click()`);
    await waitFor(`!!(window.__game && window.__game.localBoat)`, 'game', 200);
    await sleep(2500);
    await evalJS(`(() => {
      const g = window.__game;
      g.cameraRig.follow = () => {};
      g.cameraRig.followLookAt = () => {};
      g.cameraRig.focusPodium = () => {};
      g.cameraRig.focusFinish = () => {};
      g.cameraRig.snapTo = () => {};
      g.phase = 'racing'; g.countdownLeft = 0; g.raceIntro = null;
      document.body.classList.remove('intro-on');
      const hud = document.querySelector('#hud'); if (hud) hud.style.display = 'none';
      if (g.localBoat) { g.localBoat.speed = 0; }
      return true;
    })()`);
    for (const s of shots) {
      await evalJS(`(() => {
        const g = window.__game;
        g.camera.position.set(${s.cam.join(',')});
        g.camera.lookAt(${s.look.join(',')});
        g.camera.updateMatrixWorld();
        return true;
      })()`);
      await sleep(600);
      await shot(s.name);
    }
    const probe = await evalJS(`(() => {
      const g = window.__game, env = g.env;
      return { map: g.mapDef.id, floes: env.iceFloes ? env.iceFloes.count : null,
        movers: (env.palaceMovers || []).map(m => ({ x: +m.collider.x.toFixed(1), z: +m.collider.z.toFixed(1), r: +m.collider.r.toFixed(1), amp: +m.amp.toFixed(2) })) };
    })()`);
    console.log('PROBE', JSON.stringify(probe));
  } catch (e) { console.error('FAIL', mapId, e.message); }
  finally {
    try { ws?.close(); } catch {}
    try { child.kill(); } catch {}
    await sleep(400);
    try { await fs.rm(profile, { recursive: true, force: true }); } catch {}
  }
}

await runSession('tide', [
  { name: 'tide_ice_v2', cam: [60, 12, -48], look: [135, 0, 0] },
  { name: 'tide_ice_v2_close', cam: [96, 6, -34], look: [140, 0, 2] },
]);
await runSession('palace', [
  { name: 'palace_mover_v2_a', cam: [138, 9, 42], look: [157, 1.5, 78] },
  { name: 'palace_mover_v2_b', cam: [-62, 9, 8], look: [-85, 1.5, 33] },
  { name: 'palace_mover_v2_c', cam: [122, 9, -8], look: [145, 1.5, -35] },
]);
console.log('DONE');
