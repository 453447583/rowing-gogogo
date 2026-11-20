// 列出指定门附近**所有**网格（含小件），用来定位"彩色屏幕方块"。
//   MAP=baked GATE=27 R=45 node tests/near_meshes_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/near-${stamp}`;
const port = 9915 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'baked';
const GATE = Number(process.env.GATE || 27);
const R = Number(process.env.R || 45);

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
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.track?.group`, 120000);
  await sleep(9000);

  const out = val(await evaluate(`(() => {
    const g = window.__game, t = g.track, V3 = g.camera.position.constructor;
    const gi = ${GATE}, R = ${R};
    const p = t.gates[gi];
    const rows = [];
    const scan = (root, tag) => root.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const c = bb.getCenter(new V3()), s = bb.getSize(new V3());
      const d = Math.hypot(c.x - p[0], c.z - p[1]) - Math.max(s.x, s.z) * 0.5;
      if (d > R) return;
      const mat = o.material;
      const col = mat && mat.color ? '#' + mat.color.getHexString() : null;
      rows.push({ name: o.name || '(anon)', tag, d: +d.toFixed(1),
        c: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)],
        s: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)], col,
        map: !!(mat?.map), em: mat?.emissive ? '#' + mat.emissive.getHexString() : null });
    });
    scan(t.group, 'track');
    if (g.env?.group) scan(g.env.group, 'env');
    if (g.scene) scan(g.scene, 'scene');
    return rows.filter(r => r.tag !== 'scene').sort((a, b) => a.d - b.d).slice(0, 40);
  })()`));
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
