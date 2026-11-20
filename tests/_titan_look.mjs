// 临时：只看船。进单人 -> 选 titan（磐石号）-> 摆到海面 -> 四个 3/4 机位各渲一次。
//   node tests/_titan_look.mjs            -> shots/_tmp/titan-1..4.jpg
//   BOAT=lake 可换船；MAP=ocean 换图
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/titan-${stamp}`);
const port = 9860 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const boatId = process.env.BOAT || 'titan';
const mapId = process.env.MAP || 'ocean';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

try {
  let info;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') console.log('EXC', (m.params.exceptionDetails.exception?.description || '').slice(0, 300));
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await sleep(2000);

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 40000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 20000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  if (process.env.WEATHER) {
    await evaluate(`document.querySelector('#btn-lobby-weather')?.click(); 1`);
    await sleep(500);
    const w = await evaluate(`(() => {
      const b = document.querySelector('[data-weather=${JSON.stringify(process.env.WEATHER)}]');
      if (!b) return 'missing';
      b.click(); return 'ok';
    })()`);
    if (w.result?.value !== 'ok') throw new Error('天气选不到: ' + process.env.WEATHER);
    await sleep(300);
  }
  await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="${boatId}"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-boat="${boatId}"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="race"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="race"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);

  await waitFor(`!!window.__game?.localBoat?.modelRoot`, 60000);
  await sleep(2500);

  const info2 = await evaluate(`(() => {
    const g = window.__game;
    if (${process.env.DRIVE === '1'}) {
      // 驾驶态：不冻结主循环，直接给一个加速中的状态，让 #updateNitroFx 每帧挂尾焰
      g.phase = 'racing'; g.countdownLeft = 0;
      const b = g.localBoat;
      const N = g.mapDef.gates.length;
      const a = g.mapDef.gates[3 % N], b2 = g.mapDef.gates[4 % N];
      const x = (a[0] + b2[0]) / 2, z = (a[1] + b2[1]) / 2;
      b.resetTo(x, z, Math.atan2(b2[0] - a[0], b2[1] - a[1]));
      b.speed = 30; b.boostTimer = 9; b.nitroBottles = 2;
      return { drive: true, id: b.def.id, nozzles: (b.nitroNozzles || []).length };
    }
    if (g.rafId) cancelAnimationFrame(g.rafId);
    g.rafId = 0;
    g.phase = 'racing'; g.countdownLeft = 0;
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    const b = g.localBoat;
    const N = g.mapDef.gates.length;
    const a = g.mapDef.gates[3 % N], b2 = g.mapDef.gates[4 % N];
    const x = (a[0] + b2[0]) / 2, z = (a[1] + b2[1]) / 2;
    b.resetTo(x, z, Math.atan2(b2[0] - a[0], b2[1] - a[1]));
    b.speed = 0; b.vel.set(0, 0);
    b.pos.y = b.pos.y;
    const box = new (window.THREE ? window.THREE.Box3 : Object)();
    const s = b.modelRoot?.scale?.x ?? 1;
    return { def: b.def.id, name: b.def.name, x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1), scale: +s.toFixed(2) };
  })()`);
  console.log('INFO', JSON.stringify(val(info2)));

  if (process.env.DRIVE === '1') {
    // 让主循环跑几帧把尾焰挂上去，然后整屏截一张（只截一次，软/硬渲染都稳）
    await sleep(1200);
    const att = await evaluate(`(() => {
      const g = window.__game;
      const keys = [...g.fx.attached.keys()].filter(k => k.startsWith('boost:'));
      const mine = keys.filter(k => k.includes(':' + g.myId + ':'));
      return { all: keys.length, mine, boostTimer: +g.localBoat.boostTimer.toFixed(2) };
    })()`);
    console.log('NITRO', JSON.stringify(val(att)));
    const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true }, 60000);
    const out = path.resolve('shots/_tmp/titan-boost.jpg');
    await fs.writeFile(out, Buffer.from(s.data, 'base64'));
    console.log('OK', out);
    child.kill();
    process.exit(0);
  }

  const angles = process.env.DIR === '1'
    // [右, 上, 前] 船体局部坐标：正前 = 船头方向，负前 = 船尾方向
    ? [[0, 1.6, 8], [0, 1.6, -8], [5.5, 2.4, 0], [0, 9, -3]]
    : [[5.2, 2.6, 4.4], [-5.2, 2.6, 4.4], [5.2, 2.2, -4.6], [-5.0, 4.2, -5.0]];
  for (let i = 0; i < angles.length; i++) {
    const r = await evaluate(`(() => {
      const g = window.__game;
      const b = g.localBoat;
      const o = ${JSON.stringify(angles[i])};
      const p = b.pos;
      const rel = ${process.env.DIR === '1'};
      const h = b.heading;
      const fx = Math.sin(h), fz = Math.cos(h);
      const rx = Math.cos(h), rz = -Math.sin(h);
      const dx = rel ? rx * o[0] + fx * o[2] : o[0];
      const dz = rel ? rz * o[0] + fz * o[2] : o[2];
      g.camera.position.set(p.x + dx, p.y + o[1], p.z + dz);
      g.camera.lookAt(p.x, p.y + 0.75, p.z);
      g.camera.updateMatrixWorld(true);
      g.renderer.render(g.scene, g.camera);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    })()`);
    const b64 = String(val(r) || '').split(',')[1];
    if (!b64) { console.log('shot', i, 'EMPTY', val(r)?.slice?.(0, 200)); continue; }
    const out = path.resolve(`shots/_tmp/titan-${i + 1}.jpg`);
    await fs.writeFile(out, Buffer.from(b64, 'base64'));
    console.log('OK', out);
  }
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
