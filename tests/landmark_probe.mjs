// 霓虹海峡 / 任意图：列出远景灯塔等 landmarks 的位置、到赛道中线距离、是否登记碰撞体。
//   MAP=strait node tests/landmark_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/landmark-${stamp}`;
const port = 9880 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';

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
  await waitFor(`!!window.__game?.env?.landmarks`, 120000);
  await sleep(16000); // 灯塔是延迟 0~3.5s 装进来的，多等几个

  const out = val(await evaluate(`(() => {
    const g = window.__game, e = g.env, tr = g.track;
    const list = [];
    for (const h of e.landmarks || []) {
      const box = new (window.__THREE_BOX__ || Object)();
      let size = null;
      h.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox;
        if (!size) size = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map(v => +v.toFixed(1));
      });
      const x = h.position.x, z = h.position.z;
      list.push({
        isLighthouse: !!h.userData?.isLighthouse,
        userData: Object.fromEntries(Object.entries(h.userData || {}).filter(([k]) => k !== 'isLighthouse').slice(0, 6)),
        nearGate: (() => { let bi = 0, bd = Infinity; for (let i = 0; i < tr.gates.length; i++) { const d = Math.hypot(tr.gates[i][0] - x, tr.gates[i][1] - z); if (d < bd) { bd = d; bi = i; } } return [bi, +bd.toFixed(1)]; })(),
        shortcutD: +Math.min(1e9, ...(tr.shortcuts || []).flatMap(sc => (sc.points || []).map(pt => Math.hypot(pt[0] - x, pt[1] - z)))).toFixed(1),
        userData: Object.fromEntries(Object.entries(h.userData || {}).filter(([k]) => k !== 'isLighthouse').slice(0, 6)),
        nearGate: (() => { let bi = 0, bd = Infinity; for (let i = 0; i < tr.gates.length; i++) { const d = Math.hypot(tr.gates[i][0] - x, tr.gates[i][1] - z); if (d < bd) { bd = d; bi = i; } } return [bi, +bd.toFixed(1)]; })(),
        shortcutD: +Math.min(1e9, ...(tr.shortcuts || []).flatMap(sc => (sc.points || []).map(pt => Math.hypot(pt[0] - x, pt[1] - z)))).toFixed(1),
        pos: [+x.toFixed(1), +z.toFixed(1)],
        centerD: tr.arcAt ? +tr.arcAt(x, z).d.toFixed(2) : null,
        side: Math.sign((x - tr.gates[0][0]) || 1),
        size,
        colliderNear: (e.colliders || []).filter(c => Math.hypot(c.x - x, c.z - z) < 30)
          .map(c => ({ r: +c.r.toFixed(1), d: +Math.hypot(c.x - x, c.z - z).toFixed(1) })),
      });
    }
    return { map: g.mapDef.id, gateWidth: tr.gateWidth, edgeOffset: tr.edgeOffset,
      colliders: e.colliders.length, landmarks: list };
  })()`));
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
