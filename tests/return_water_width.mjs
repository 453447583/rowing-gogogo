// 秘境漂流：量 return_water 相对中心线的横向宽度，对照石堤内沿(HW-0.4)。
//   node tests/return_water_width.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/rw-${stamp}`;
const port = 9930 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';

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
    let water = null;
    t.group.traverse((o) => { if (o.name === 'return_water') water = o; });
    if (!water) return { err: 'no return_water' };
    const pos = water.geometry.attributes.position;
    const v = new V3();
    const byGate = new Map();
    const push = (g, d) => {
      if (!byGate.has(g)) byGate.set(g, []);
      byGate.get(g).push(d);
    };
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(water.matrixWorld);
      let best = { d: 1e9, seg: 0, px: 0, pz: 0 };
      for (let i = 0; i < t.gates.length; i++) {
        const a = t.gates[i], b = t.gates[(i + 1) % t.gates.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        let u = ((v.x - a[0]) * dx + (v.z - a[1]) * dz) / L2;
        u = Math.max(0, Math.min(1, u));
        const cx = a[0] + dx * u, cz = a[1] + dz * u;
        const d = Math.hypot(v.x - cx, v.z - cz);
        if (d < best.d) best = { d, seg: i, px: cx, pz: cz };
      }
      push(best.seg, +best.d.toFixed(2));
    }
    const rows = [];
    for (const [gate, arr] of [...byGate.entries()].sort((a, b) => a[0] - b[0])) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a - b);
      rows.push({ gate, n: arr.length,
        min: arr[0], p50: arr[Math.floor(arr.length * 0.5)],
        p90: arr[Math.floor(arr.length * 0.9)], max: arr[arr.length - 1] });
    }
    return { HW: t.gateWidth, innerEdge: t.gateWidth - 0.4,
      rows: rows.filter((r, i) => i % Math.max(1, Math.floor(rows.length / 24)) === 0) };
  })()`));
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
