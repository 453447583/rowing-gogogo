// 秘境漂流回程：水面收窄前后对比（同一机位，隐藏/显示 return_water 之外的海面不好比，
// 这里直接拍修复后的现场，看白堤外还有没有蓝色水面耳朵）。
//   MAP=baked GATE=110 node tests/return_water_shot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/rwshot-${stamp}`;
const port = 9935 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const GATE = Number(process.env.GATE || 110);
const outDir = path.resolve('shots/return_water');

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = val(await evaluate(expr)); if (last) return last; await sleep(250); }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}
try {
  let info;
  for (let i = 0; i < 160; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ } await sleep(150); }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="baked"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="baked"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.track?.group`, 120000);
  await sleep(9000);

  await evaluate(`(() => {
    const g = window.__game, t = g.track, c = g.camera, gi = ${GATE};
    const a = t.gates[gi], b = t.gates[gi + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const fx = dx / L, fz = dz / L;
    c.position.set(a[0] - fx * 16, (t.gateY[gi] ?? 0) + 7, a[1] - fz * 16);
    c.up.set(0, 1, 0);
    c.lookAt(a[0] + fx * 30, (t.gateY[gi] ?? 0) + 1, a[1] + fz * 30);
    c.fov = 64; c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    g.cameraRig.follow = () => {};
    if (g.rafId) { cancelAnimationFrame(g.rafId); g.rafId = 0; }
    return 1;
  })()`);
  await fs.mkdir(outDir, { recursive: true });
  const v = val(await evaluate(`(() => {
    const g = window.__game;
    g.post.render(1 / 60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
  })()`));
  if (typeof v !== 'string' || !v.startsWith('data:image')) throw new Error('shot fail ' + String(v).slice(0, 120));
  const f = path.join(outDir, `g${GATE}-after.jpg`);
  await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
  console.log('shot', f);
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
