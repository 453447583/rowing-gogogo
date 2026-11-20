// 秘境漂流：从起点隧道朝前打射线，确认挡路黑墙是哪一块网格。
//   node tests/cave_ray_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/caveray-${stamp}`;
const port = 9900 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const GATE = Number(process.env.GATE || 2);
const BACK = Number(process.env.BACK || 4);

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=900,560', 'about:blank'], { stdio: 'ignore' });
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

  const out = val(await evaluate(`(() => {
    const g = window.__game, t = g.track, V3 = g.camera.position.constructor;
    const gi = ${GATE};
    const a = t.gates[gi], b = t.gates[gi + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const fx = dx / L, fz = dz / L;
    const o = [a[0] - fx * ${BACK}, (t.gateY[gi] ?? 0) + 2.2, a[1] - fz * ${BACK}];
    const origin = new V3(...o);
    // 遍历可见网格，用包围盒先筛，再用"点到三角形"最近距离近似射线命中
    const hits = [];
    const dir = new V3(fx, 0, fz);
    const tmp = new V3();
    t.group.updateMatrixWorld(true);
    t.group.traverse((mesh) => {
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry?.attributes?.position) return;
      const pos = mesh.geometry.attributes.position;
      const idx = mesh.geometry.index;
      const at = idx ? (k) => idx.getX(k) : (k) => k;
      const tri = idx ? idx.count / 3 : pos.count / 3;
      let best = Infinity, bestT = 0;
      // 抽样最多 2000 面（大网格按步长取）
      const step = Math.max(1, Math.floor(tri / 2000));
      for (let k = 0; k < tri; k += step) {
        let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < 3; j++) {
          tmp.fromBufferAttribute(pos, at(k * 3 + j)).applyMatrix4(mesh.matrixWorld);
          cx += tmp.x; cy += tmp.y; cz += tmp.z;
        }
        cx /= 3; cy /= 3; cz /= 3;
        const rx = cx - origin.x, ry = cy - origin.y, rz = cz - origin.z;
        const along = rx * dir.x + ry * dir.y + rz * dir.z;
        if (along < 0 || along > 120) continue;
        const cross = Math.abs(rx * dir.z - rz * dir.x);
        if (cross < 2.5 && Math.abs(ry) < 4.5 && along < best) { best = along; bestT = cx; }
      }
      if (best < Infinity) hits.push({ name: mesh.name || '(anon)', dist: +best.toFixed(1), x: +bestT.toFixed(1) });
    });
    return { gate: gi, origin: o.map(v => +v.toFixed(1)), hits: hits.sort((a, b) => a.dist - b.dist).slice(0, 14) };
  })()`));
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
