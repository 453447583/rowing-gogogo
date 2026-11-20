// 浮桶走线取景：在指定门附近摆几台固定机位，把浮桶链拍下来看有没有交叉/穿模。
//
//   node tests/buoy_shot.mjs                 # 默认拍 36/38/40/11 四段
//   MAP=strait GATES=36,38,40,11 node tests/buoy_shot.mjs
//   WEATHER=starry MAP=strait GATES=38,11 node tests/buoy_shot.mjs  # 指定天气 + 打印浮桶自发光
//
// 出图：shots/strait/<天气>/buoy-g<门号>-<机位>.jpg（默认 day 仍是老路径）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/buoyshot-${stamp}`;
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const weather = process.env.WEATHER || '';
const gates = (process.env.GATES || '36,38,40,11').split(',').map(Number);
const outDir = weather ? path.resolve('shots', mapId, weather) : path.resolve('shots', mapId);

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
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

// 机位：相对"当前门 → 下一门"的姿态。back=沿赛道往后退，up=高度
const POSES = [
  { name: 'chase', back: 26, lat: 0, up: 5.0, tFwd: 12, tLat: 0, tUp: 1.2, fov: 68 },
  { name: 'side', back: 6, lat: 26, up: 6.0, tFwd: 6, tLat: 0, tUp: 1.0, fov: 60 },
  { name: 'top', back: 4, lat: 0, up: 34, tFwd: 4, tLat: 0, tUp: 0, fov: 55 },
];

async function main() {
  let info;
  for (let i = 0; i < 160; i++) {
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
  await sleep(400);
  // 指定天气：开天气抽屉 → 点对应色板。默认不选，走大厅里保留的天气。
  if (weather) {
    await evaluate(`document.querySelector('#btn-lobby-weather').click(); 1`);
    await waitFor(`!!document.querySelector('[data-weather="${weather}"]')`, 30000);
    await evaluate(`document.querySelector('[data-weather="${weather}"]').click(); 1`);
    await sleep(300);
  }
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {};
    g.cameraRig.followLookAt = () => {};
    g.cameraRig.snapTo = () => {};
    return 1;
  })()`);
  await sleep(400);

  // 量化读数：确认浮桶材质真的带了自发光（不是只改了图看不出差别）
  const matInfo = val(await evaluate(`(() => {
    const b = window.__game.track.edgeBuoys;
    if (!b || !b.body) return { err: 'no edgeBuoys' };
    const m = b.body.material;
    const e = m.emissive;
    return {
      weather: window.__game.track.buoyWeather,
      emissive: e ? '#' + [e.r, e.g, e.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('') : null,
      intensity: m.emissiveIntensity,
      count: b.body.count,
    };
  })()`));
  console.log('浮桶材质', JSON.stringify(matInfo));

  await fs.mkdir(outDir, { recursive: true });
  for (const gate of gates) {
    const frame = val(await evaluate(`(() => {
      const T = window.__game.track;
      const N = T.gates.length;
      const a = T.gates[${gate}], b = T.gates[(${gate} + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      return { gx: a[0], gz: a[1], fx: dx / L, fz: dz / L, nx: -dz / L, nz: dx / L };
    })()`));
    for (const p of POSES) {
      const expr = `(async () => {
        const g = window.__game;
        const F = ${JSON.stringify(frame)};
        const cx = F.gx - F.fx * ${p.back} + F.nx * ${p.lat};
        const cz = F.gz - F.fz * ${p.back} + F.nz * ${p.lat};
        const tx = F.gx + F.fx * ${p.tFwd} + F.nx * ${p.tLat};
        const tz = F.gz + F.fz * ${p.tFwd} + F.nz * ${p.tLat};
        g.camera.position.set(cx, ${p.up}, cz);
        g.camera.fov = ${p.fov};
        g.camera.updateProjectionMatrix();
        g.camera.lookAt(tx, ${p.tUp}, tz);
        await new Promise((r) => requestAnimationFrame(r));
        g.camera.position.set(cx, ${p.up}, cz);
        g.camera.lookAt(tx, ${p.tUp}, tz);
        await new Promise((r) => requestAnimationFrame(r));
        g.post.render(1 / 60);
        return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
      })()`;
      const r = await evaluate(expr);
      const v = r?.result?.value;
      if (typeof v !== 'string' || !v.startsWith('data:image')) {
        console.log('g' + gate, p.name, 'SHOT FAIL',
          String(r?.exceptionDetails?.exception?.description || '').slice(0, 120));
        continue;
      }
      const f = path.join(outDir, `buoy-g${gate}-${p.name}.jpg`);
      await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
      console.log('g' + gate, p.name, 'ok');
    }
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  process.exit();
});
