// 水面重塑验收：真实行驶中活拍，看尾流 + 反射 + 无斑点；并测帧率。
//
//   node tests/water_rework_shot.mjs
//   MAP=strait WEATHER=day node tests/water_rework_shot.mjs
//   MAP=canyon WEATHER=blizzard node tests/water_rework_shot.mjs
//
// 出图：shots/water_final/<map>-<weather>-{0,1}.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/wfinal-${stamp}`;
const port = 9860 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const weather = process.env.WEATHER || 'day';
const outDir = path.resolve('shots', 'water_final');

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
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

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
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-lobby-weather').click(); 1`);
  await waitFor(`!!document.querySelector('[data-weather="${weather}"]')`, 30000);
  await evaluate(`document.querySelector('[data-weather="${weather}"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.water`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
  await sleep(600);

  // 真跑 3 秒：updateLocal + constrain 与游戏中同一路径，水面的尾迹状态会跟着更新
  const run = val(await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, tr = g.track;
    let t = g.elapsed || 0;
    for (let k = 0; k < 180; k++) {
      t += 1 / 60;
      b.updateLocal(1 / 60, { throttle: 1, steer: 0, boost: false }, t, [], null);
      tr.constrain(b, 1 / 60);
    }
    g.cameraRig.follow = () => {};
    g.cameraRig.followLookAt = () => {};
    return { speed: +b.speed.toFixed(1), x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1) };
  })()`));
  console.log('drive:', JSON.stringify(run));

  // 追尾机位：船后 11m、高 4.2m，略微俯视 —— 尾流、近水纹、中景反射同框
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, c = g.camera;
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    c.position.set(b.pos.x - fx * 11, 4.2, b.pos.z - fz * 11);
    c.up.set(0, 1, 0);
    c.lookAt(b.pos.x + fx * 26, 0.8, b.pos.z + fz * 26);
    c.fov = 64;
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return 1;
  })()`);
  await sleep(350);

  const fps = val(await evaluate(`(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise((res) => {
      const step = () => { if (performance.now() - t0 > 1200) res(); else { frames++; requestAnimationFrame(step); } };
      requestAnimationFrame(step);
    });
    return +(frames / ((performance.now() - t0) / 1000)).toFixed(1);
  })()`));
  console.log('fps:', fps);

  await fs.mkdir(outDir, { recursive: true });
  for (let k = 0; k < 2; k++) {
    try {
      const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      const f = path.join(outDir, `${mapId}-${weather}-${k}.jpg`);
      await fs.writeFile(f, Buffer.from(s.data, 'base64'));
      console.log('shot', f);
    } catch (e) {
      console.log('shot failed', e.message);
    }
    await sleep(500);
  }
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
