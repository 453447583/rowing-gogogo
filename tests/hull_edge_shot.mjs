// 船体边缘碰撞出图：把船顶到浮桶线上，俯拍一张，肉眼确认"船壳边缘正好压在浮桶线上"
//
//   node tests/hull_edge_shot.mjs
//   MAP=canyon GATE=6 node tests/hull_edge_shot.mjs
//
// 出图：shots/hull/<地图>-g<门号>-top.jpg / -side.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/hullshot-${stamp}`;
const port = 9760 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const gate = Number(process.env.GATE || 48);
const outDir = path.resolve('shots', 'hull');

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
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await waitFor(`!!window.__game.localBoat.modelRoot`, 60000);
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {}; g.cameraRig.followLookAt = () => {}; g.cameraRig.snapTo = () => {};
    return 1;
  })()`);
  await sleep(500);

  // 把船顶到浮桶线上（与 hull_edge_probe 同一条路径：全油门垂直往外推 4 秒）
  const info2 = val(await evaluate(`(function(){
    const g = window.__game, tr = g.track, b = g.localBoat;
    const N = tr.gates.length, GI = ${gate};
    const c = tr.gates[GI], n = tr.gates[(GI + 1) % N];
    const fdx = n[0] - c[0], fdz = n[1] - c[1];
    const fl = Math.hypot(fdx, fdz) || 1;
    const nx = -fdz / fl, nz = fdx / fl;
    b.resetTo(c[0], c[1], Math.atan2(fdx, fdz));
    b.gateHint = GI;
    b.heading = Math.atan2(nx, nz);
    b.speed = 0;
    const DT = 1 / 60;
    let t = 0;
    for (let k = 0; k < 240; k++) { t += DT; b.updateLocal(DT, { throttle: 1, steer: 0, boost: false }, t, [], null); tr.constrain(b, DT); }
    b.group.position.copy(b.pos);
    b.group.rotation.set(0, b.heading, 0);
    return { x: b.pos.x, z: b.pos.z, h: b.heading, nx, nz, limit: tr.edgeOffset };
  })()`));
  console.log('boat pressed:', JSON.stringify(info2));

  await fs.mkdir(outDir, { recursive: true });
  // 机位：top 是真的正俯视（相机 up 设成船头方向，画面里"上"= 船头），
  // 这样浮桶线在船体哪一侧、贴没贴住一眼就能判。
  const POSES = [
    { name: 'top', up: 14, fov: 42, vert: true },
    { name: 'topwide', up: 30, fov: 55, vert: true },
    { name: 'side', up: 3.0, fov: 60, lat: 14 },
  ];
  for (const p of POSES) {
    const r = await evaluate(`(async () => {
      const g = window.__game;
      const F = ${JSON.stringify(info2)};
      const b = g.localBoat;
      const place = () => {
        const cx = b.pos.x - F.nx * ${p.lat || 0} - Math.sin(F.h) * ${p.back || 0};
        const cz = b.pos.z - F.nz * ${p.lat || 0} - Math.cos(F.h) * ${p.back || 0};
        if (${p.vert ? 'true' : 'false'}) {
          // 正俯视：相机在船正上方，画面"上"= 船头方向
          g.camera.up.set(Math.sin(F.h), 0, Math.cos(F.h));
          g.camera.position.set(b.pos.x, ${p.up}, b.pos.z);
          g.camera.lookAt(b.pos.x, 0, b.pos.z);
        } else {
          g.camera.up.set(0, 1, 0);
          g.camera.position.set(cx, ${p.up}, cz);
          g.camera.lookAt(b.pos.x, 0.6, b.pos.z);
        }
        g.camera.fov = ${p.fov};
        g.camera.updateProjectionMatrix();
      };
      place();
      await new Promise((r2) => requestAnimationFrame(r2));
      place();
      await new Promise((r2) => requestAnimationFrame(r2));
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    })()`);
    const v = r?.result?.value;
    if (typeof v !== 'string' || !v.startsWith('data:image')) {
      console.log(p.name, 'SHOT FAIL', String(r?.exceptionDetails?.exception?.description || '').slice(0, 160));
      continue;
    }
    const f = path.join(outDir, `${mapId}-g${gate}-${p.name}.jpg`);
    await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log('shot', f);
  }
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
