// 瀑布底部定点一张（最轻量：只进秘境漂流、只停在瀑布落水处，水面必须托着船）
//   node tests/fall_shot.mjs [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fall-' + Date.now());
const port = 9600 + Math.floor(Math.random() * 100);
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=720,405', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 240000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const local = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, label, tries = 160) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await local(500);
  }
  throw new Error('timeout: ' + label);
};

try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await local(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await local(3000);

  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  for (let i = 0; i < 10; i++) {
    await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1200);
    if (await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false)) break;
  }
  await waitFor(`!!document.querySelector('.boat-card')`, 'boats');
  await ev(`(() => { document.querySelector('.boat-card').click(); document.querySelector('#btn-boat-ok').click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'maps');
  for (let i = 0; i < 8 && !(await ev(`!!window.__game`).catch(() => false)); i++) {
    await ev(`(() => { [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === 'baked')?.click(); document.querySelector('#btn-map-ok')?.click(); })()`);
    await local(3000);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await local(9000);

  // 停在瀑布落水处（y≈10），先把渲染尺寸压到 480x270 让软件光栅跑得动
  await ev(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    g.renderer.setSize(480, 270, false);
    const a = g.mapDef.gates[64], b = g.mapDef.gates[65];
    const x = a[0] + (b[0] - a[0]) * 0.5, z = a[1] + (b[1] - a[1]) * 0.5;
    const boat = g.localBoat;
    boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
    boat.speed = 0; boat.vel.set(0, 0);
    boat.diveTargetY = g.track.diveHeightAt(boat.pos, 65);
    boat.pos.y = boat.diveTargetY ?? 8;
    const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = 65; pm.lap = 1; }
    g.cameraRig?.snapTo?.(boat);
  })()`);
  await local(3000);
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.resolve('shots/verify/baked-fall-bottom.png'), Buffer.from(res.data, 'base64'));
  console.log('shot -> shots/verify/baked-fall-bottom.png');

  // ---------- 第二张：瀑布中段（固定机位，看"水面托着船"----------
  await ev(`(() => {
    const g = window.__game;
    const a = g.mapDef.gates[60], b = g.mapDef.gates[61];
    const x = a[0] + (b[0] - a[0]) * 0.5, z = a[1] + (b[1] - a[1]) * 0.5;
    const boat = g.localBoat;
    boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
    boat.speed = 0; boat.vel.set(0, 0);
    boat.diveTargetY = g.track.diveHeightAt(boat.pos, 61);
    boat.pos.y = boat.diveTargetY ?? 35;
    // 固定机位：把追车镜头停掉，从下游侧上方看瀑布斜坡
    g.cameraRig.update = () => {};
    g.camera.position.set(x + 26, boat.pos.y + 13, z + 34);
    g.camera.lookAt(x, boat.pos.y + 1, z);
  })()`);
  await local(2500);
  const res2 = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.resolve('shots/verify/baked-fall-slope.png'), Buffer.from(res2.data, 'base64'));
  console.log('shot -> shots/verify/baked-fall-slope.png');

  const info = await ev(`(() => {
    const g = window.__game, b = g.localBoat, pm = g.progressMap.get(g.myId);
    let mesh = null;
    g.track.group.traverse((o) => { if (o.isMesh && /fall_water/i.test(o.name || '') && o.visible) mesh = o; });
    const P = mesh.geometry.attributes.position;
    let wy = null, bd = 1e9;
    for (let k = 0; k < P.count; k++) {
      const d = Math.hypot(P.getX(k) - b.pos.x, P.getZ(k) - b.pos.z);
      if (d < bd) { bd = d; wy = P.getY(k); }
    }
    return { mesh: mesh.name, boatY: +b.pos.y.toFixed(2), waterY: +wy.toFixed(2),
             gap: +(b.pos.y - wy).toFixed(2), dist: +bd.toFixed(2), gate: pm && pm.gate };
  })()`);
  console.log('落水处:', JSON.stringify(info));
  console.log(Math.abs(info.gap) < 1 ? 'PASS 水面在船下' : 'FAIL 水面与船错位');
} catch (e) {
  console.error('fall shot FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
