// 秘境漂流：扫描 cave_shell 里"横在航道前方、高于水面"的三角面，定位黑色挡板。
//   node tests/cave_wall_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/cavewall-${stamp}`;
const port = 9895 + (Number(stamp.slice(-3)) % 20);
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
    const t = window.__game.track;
    const meshNames = ${JSON.stringify((process.env.NAMES || 'cave_shell,stairs_shell').split(','))};
    const V3 = window.__game.camera.position.constructor;
    const distPolyline = (x, z) => {
      let best = 1e9, bi = 0, bt = 0;
      for (let i = 0; i < t.gates.length; i++) {
        const a = t.gates[i], b = t.gates[(i + 1) % t.gates.length];
        const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz || 1;
        let u = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
        u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(x - (a[0] + dx * u), z - (a[1] + dz * u));
        if (d < best) { best = d; bi = i; bt = u; }
      }
      return { d: best, i: bi, t: bt };
    };
    const out = [];
    t.group.traverse((o) => {
      if (!o.isMesh || !meshNames.includes(o.name)) return;
      const pos = o.geometry.attributes.position;
      const idx = o.geometry.index;
      const at = idx ? (k) => idx.getX(k) : (k) => k;
      const triCount = idx ? idx.count / 3 : pos.count / 3;
      const v = new V3();
      let nCross = 0;
      const samples = [];
      const samplesByGate = {};
      for (let k = 0; k < triCount; k++) {
        let cx = 0, cy = 0, cz = 0;
        let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
        for (let j = 0; j < 3; j++) {
          v.fromBufferAttribute(pos, at(k * 3 + j)).applyMatrix4(o.matrixWorld);
          cx += v.x; cy += v.y; cz += v.z;
          minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
          minz = Math.min(minz, v.z); maxz = Math.max(maxz, v.z);
        }
        cx /= 3; cy /= 3; cz /= 3;
        const loc = distPolyline(cx, cz);
        if (loc.i > 24) continue;
        const y0 = t.gateY[loc.i] ?? 0;
        const y1 = t.gateY[(loc.i + 1) % t.gates.length] ?? y0;
        const deck = y0 + (y1 - y0) * loc.t;
        if (loc.d < 6 && cy > deck + 1.6) {
          nCross++;
          if (cy > deck + 1.5 && (samplesByGate[loc.i] || 0) < 3) { samplesByGate[loc.i] = (samplesByGate[loc.i] || 0) + 1;
            samples.push({ gate: loc.i, d: +loc.d.toFixed(1), y: +cy.toFixed(1), above: +(cy - deck).toFixed(1),
              c: [+cx.toFixed(1), +cz.toFixed(1)], span: +(Math.max(maxx - minx, maxz - minz)).toFixed(1) });
          }
        }
      }
      out.push({ name: o.name, triCount, nCross, samples });
    });
    return out;
  })()`));
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
