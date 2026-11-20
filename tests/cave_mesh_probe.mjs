// 秘境漂流：把 cave_shell / stairs_shell 等大网格的**每个子网格**逐行列出来
// （gates 探针只列整体包围盒，定位不到"哪一面"挡路时用这个）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/cavelist-${stamp}`;
const port = 9890 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const filter = process.env.FILTER || 'cave';

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
  await waitFor(`!!document.querySelector('.lp-card[data-map="baked"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="baked"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.track?.group`, 120000);
  await sleep(9000);

  const out = val(await evaluate(`(() => {
    const t = window.__game.track;
    const rows = [];
    const F = ${JSON.stringify(filter)};
    // 到最近门中线的距离（用包围盒中心近似；再按 bbox 半径筛）
    const gateDist = (x, z) => {
      let best = 1e9, bi = 0;
      for (let i = 0; i < t.gates.length; i++) {
        const d = Math.hypot(t.gates[i][0] - x, t.gates[i][1] - z);
        if (d < best) { best = d; bi = i; }
      }
      return [bi, +best.toFixed(1)];
    };
    t.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      if (!(o.name || '').toLowerCase().includes(F.toLowerCase())) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const c = bb.getCenter(new (window.__game.camera.position.constructor)());
      const s = bb.getSize(new (window.__game.camera.position.constructor)());
      const [gi, gd] = gateDist(c.x, c.z);
      const mat = o.material;
      rows.push({
        name: o.name,
        c: [+c.x.toFixed(1), +c.y.toFixed(1), +c.z.toFixed(1)],
        s: [+s.x.toFixed(1), +s.y.toFixed(1), +s.z.toFixed(1)],
        ymin: +bb.min.y.toFixed(1), ymax: +bb.max.y.toFixed(1),
        gate: gi, gd,
        col: mat?.color ? '#' + mat.color.getHexString() : null,
        vis: o.visible,
        verts: o.geometry.attributes.position?.count ?? 0,
      });
    });
    return rows.sort((a, b) => a.gate - b.gate);
  })()`));
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
