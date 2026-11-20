// 霓虹海峡石构件取景探针（**只截图，不改源码**）
//   node tests/strait_wall_shot.mjs
//   OUT=shots/strait TAG=v2 node tests/strait_wall_shot.mjs
//
// 用途：改完 stone_wall / gate_lintel 资产后，用几个固定机位确认
//   ① 门洞净空够（开过去视野不被横梁切）
//   ② 石纹三平面投影 + 高度凹凸有没有生效（不是平面色块）
//   ③ 城墙顶的松树落在墙面上（不是悬浮）
// 机位全部按 gate 17 的局部坐标算，换地图/换门号用 GATE=18 覆盖。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/straitshot-${stamp}`;   // 必须在项目外
const port = 9720 + (Number(stamp.slice(-3)) % 40);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const gate = Number(process.env.GATE || 17);
const outDir = path.resolve(process.env.OUT || 'shots/strait');
const tag = process.env.TAG || 'v1';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${process.env.SIZE || '1280x720'}`, 'about:blank'], { stdio: 'ignore' });

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

async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

// 机位：fwd/up/lat 都是相对门架的姿态（fwd = 赛道前进方向，lat = 横向）
const POSES = [
  { name: 'approach', fwd: -38, lat: 0, up: 6.5, tFwd: 0, tUp: 8.0, fov: 62 },
  { name: 'clearance', fwd: -14, lat: 0, up: 3.2, tFwd: 10, tUp: 11.5, fov: 70 },
  { name: 'arch', fwd: -3, lat: 0, up: 2.4, tFwd: 6, tUp: 12.6, fov: 76 },
  { name: 'wall', fwd: 6, lat: -13.5, up: 4.2, tFwd: 6, tLat: -23, tUp: 4.6, fov: 55 },
  { name: 'walltop', fwd: 2, lat: -20, up: 12, tFwd: 2, tLat: -17, tUp: 6.2, fov: 55 },
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
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  // 等石构件合批完成（GLB 异步加载 + mergeGeometries）
  try {
    await waitFor(`!!window.__game.track.group.getObjectByName('strait_stone')`, 60000);
    console.log('STONE mesh ready');
  } catch {
    console.log('STONE mesh NOT found（可能这张图没有 straitProps）');
  }
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    // 相机自管：把跟随机位停掉，后面手工摆
    g.cameraRig.follow = () => {};
    g.cameraRig.followLookAt = () => {};
    g.cameraRig.snapTo = () => {};
    if (g.post.render) { const r = g.post.render.bind(g.post); g.__origRender = r; }
    return 1;
  })()`);
  await sleep(300);
  console.log('PATCH', JSON.stringify(val(await evaluate(`window.__stonePatch || null`))));

  // 门架姿态
  const frame = val(await evaluate(`(() => {
    const T = window.__game.track;
    const a = T.gates[${gate}];
    const b = T.gates[(${gate} + 1) % T.gates.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    return { gx: a[0], gz: a[1], fx: dx / L, fz: dz / L, nx: -dz / L, nz: dx / L, y: T.gateY[${gate}] || 0 };
  })()`));
  console.log('GATE', JSON.stringify(frame));

  await fs.mkdir(outDir, { recursive: true });
  for (const p of POSES) {
    const expr = `(async () => {
      const g = window.__game;
      const F = ${JSON.stringify(frame)};
      const tLat = ${p.tLat ?? 0};
      const cx = F.gx + F.fx * ${p.fwd} + F.nx * ${p.lat};
      const cz = F.gz + F.fz * ${p.fwd} + F.nz * ${p.lat};
      const tx = F.gx + F.fx * ${p.tFwd} + F.nx * tLat;
      const tz = F.gz + F.fz * ${p.tFwd} + F.nz * tLat;
      g.camera.position.set(cx, F.y + ${p.up}, cz);
      g.camera.fov = ${p.fov};
      g.camera.updateProjectionMatrix();
      g.camera.lookAt(tx, F.y + ${p.tUp}, tz);
      await new Promise((r) => requestAnimationFrame(r));
      g.camera.position.set(cx, F.y + ${p.up}, cz);
      g.camera.lookAt(tx, F.y + ${p.tUp}, tz);
      await new Promise((r) => requestAnimationFrame(r));
      g.camera.position.set(cx, F.y + ${p.up}, cz);
      g.camera.lookAt(tx, F.y + ${p.tUp}, tz);
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    })()`;
    const r = await evaluate(expr);
    const v = r?.result?.value;
    if (r?.exceptionDetails) {
      console.log(p.name, 'EXC', String(r.exceptionDetails.exception?.description).slice(0, 200));
      continue;
    }
    if (typeof v !== 'string' || !v.startsWith('data:image')) {
      console.log(p.name, 'SHOT FAIL');
      continue;
    }
    const f = path.join(outDir, `${tag}-${mapId}-g${gate}-${p.name}.jpg`);
    await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log(p.name, 'ok ->', path.basename(f));
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  process.exit();
});
