// 尾焰素材 A/B：同一船（流光号）、同一机位、同一速度，运行时挂不同 Effekseer 出图
//   node tests/_nitro_ab.mjs
// 不进源码配置：直接 playAttached 到中间喷口（key 不以 boost: 开头，避开 #updateNitroFx 管理）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/nitroab-${stamp}`;
const port = 9780 + (Number(stamp.slice(-3)) % 15);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = `${base}?raceIntro=0`;
const speed = Number(process.env.SPEED || 30);

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

async function waitFor(expr, timeout = 150000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

async function startRace() {
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`);
  await evaluate(`document.querySelector('#btn-lobby-boat')?.click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-boat="skiff"]')`);
  await evaluate(`document.querySelector('.lp-card[data-boat="skiff"]').click(); 1`);
  await sleep(250);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="strait"]')`);
  await evaluate(`document.querySelector('.lp-card[data-map="strait"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value='0'; s.dispatchEvent(new Event('change',{bubbles:true})); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 150000);
  await waitFor(`window.__game?.phase === 'racing'`, 240000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
  await sleep(500);
}

// 相机固定在船尾侧后方（与 nitro_fx_probe 同机位）
const CAM = `
window.__abCam = () => {
  const g = window.__game, b = g.localBoat;
  const h = b.heading, fx = Math.sin(h), fz = Math.cos(h);
  g.cameraRig.follow = () => {};
  g.camera.position.set(b.pos.x - fx*9 + fz*3.2, b.pos.y + 3.4, b.pos.z - fz*9 - fx*3.2);
  g.camera.lookAt(b.pos.x, b.pos.y + 0.9, b.pos.z);
  g.camera.updateMatrixWorld(true);
};
window.__abDrive = (on, sp = 30) => {
  if (window.__abTimer) { clearInterval(window.__abTimer); window.__abTimer = null; }
  if (!on) return 1;
  const g = window.__game;
  window.__abTimer = setInterval(() => {
    const b = g.localBoat; if (!b) return;
    b.boostTimer = 0; b.miniBoostTimer = 0;   // 不用正式尾焰，纯靠 probe 手动挂
    const h = b.heading;
    b.vel.set(Math.sin(h)*sp, 0, Math.cos(h)*sp);
    b.speed = sp;
    window.__abCam();
  }, 16);
  return 1;
};
window.__abMount = (effectName, cfg) => {
  const g = window.__game, b = g.localBoat;
  const anchors = b.nitroNozzles || [];
  if (!anchors.length) return 'no anchor';
  if (!g.fx.effects[effectName]) return 'effect missing: ' + effectName;
  for (const k of [...g.fx.attached.keys()]) if (k.startsWith('probe:')) g.fx.stopAttached(k);
  const pick = (i) => cfg.points === 'triple' ? true : (cfg.points === 'center' ? i === 1 : i !== 1);
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const a = anchors[i];
    if (!a || !pick(i)) continue;
    const V = new (b.pos.constructor)();
    const follow = () => { a.getWorldPosition(V); return V; };
    const rot = () => ({ x: Math.PI/2, y: b.heading + Math.PI, z: 0 });
    g.fx.playAttached('probe:' + effectName + ':' + i, effectName, follow, {
      rot, loop: true, scale: cfg.scale, color: cfg.color,
      loopEvery: cfg.loopEvery, pool: cfg.pool, trail: cfg.trail !== false,
    });
    n += 1;
  }
  return 'ok x' + n;
};
window.__abShot = () => {
  const g = window.__game;
  window.__abCam();
  g.fx.update(0.016);
  g.post.render(0.016);
  if (!g.post.isActive) g.fx.draw(g.camera);
  return g.renderer.domElement.toDataURL('image/jpeg', 0.88);
};
1`;

// 三组对照
const CANDS = [
  { name: 'OLD_foam', fx: 'toonWater', scale: 1.3, color: 0xd8feff, points: 'triple', loopEvery: 0.025, pool: 10 },
];

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2400);
  await startRace();
  await evaluate(CAM);
  await evaluate(`window.__abCam(); window.__abDrive(true, ${speed}); 1`);
  await sleep(1200);

  await fs.mkdir('shots/nitro', { recursive: true });
  for (const c of CANDS) {
    const r = await evaluate(`window.__abMount(${JSON.stringify(c.fx)}, ${JSON.stringify(c)})`);
    console.log(`mount ${c.name}:`, val(r));
    await sleep(1400); // 铺开尾迹
    const jpg = val(await evaluate(`window.__abShot()`));
    if (typeof jpg === 'string' && jpg.startsWith('data:image')) {
      await fs.writeFile(`shots/nitro/ab_${c.name}.jpg`, Buffer.from(jpg.split(',')[1], 'base64'));
      console.log('  shot -> shots/nitro/ab_' + c.name + '.jpg');
    } else {
      console.log('  shot fail', String(jpg).slice(0, 80));
    }
  }
  await evaluate(`window.__abDrive(false); 1`);
} catch (e) {
  console.log('ERR', e.stack || e.message);
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(0);
