// 秘境漂流道具赛：确认"上坡彩色方块"是不是道具箱（ItemBoxField）。
//   MAP=baked GATE=27 node tests/itembox_shot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/ibox-${stamp}`;
const port = 9920 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const GATE = Number(process.env.GATE || 27);
const outDir = path.resolve('shots/itembox_diag');

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
  // 选道具赛
  const mode = await evaluate(`(() => {
    document.querySelector('#btn-lobby-mode')?.click();
    const cards = [...document.querySelectorAll('.lp-pill[data-mode],.lp-boss-card[data-mode]')];
    const c = cards.find(x => x.dataset.mode === 'item');
    if (!c) return 'modes:' + cards.map(x => x.dataset.mode).join(',');
    c.click(); return 'ok';
  })()`);
  console.log('mode', JSON.stringify(mode.result?.value));
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.water`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await sleep(2500);

  const info2 = val(await evaluate(`(() => {
    const g = window.__game;
    const t = g.track, gi = ${GATE};
    const p = t.gates[gi], b = t.gates[gi + 1];
    const dx = b[0] - p[0], dz = b[1] - p[1], L = Math.hypot(dx, dz) || 1;
    const fx = dx / L, fz = dz / L;
    const bx = p[0] - fx * 12, bz = p[1] - fz * 12;
    const y = (t.gateY[gi] ?? 0) + 3.0;
    g.cameraRig.follow = () => {};
    g.camera.position.set(bx, y, bz);
    g.camera.up.set(0, 1, 0);
    g.camera.lookAt(p[0] + fx * 22, y + 1.0, p[1] + fz * 22);
    g.camera.fov = 66; g.camera.updateProjectionMatrix(); g.camera.updateMatrixWorld(true);
    if (g.rafId) { cancelAnimationFrame(g.rafId); g.rafId = 0; }
    // 道具箱场景对象：找所有带 THREE.InstancedMesh 且名字/itemBoxField 相关
    const boxes = [];
    g.scene.traverse((o) => {
      if (o.isInstancedMesh && (o.name || '').toLowerCase().includes('item') || o === g.items?.boxField?.panel) {
        boxes.push({ name: o.name || '(anon)', count: o.count });
      }
    });
    const field = g.items?.boxField || null;
    return { mode: g.mode, boxes, hasField: !!field, boxCount: field?.count ?? 0,
      itemPos: field?.positions ? Array.from(field.positions).slice(0, 6) : null };
  })()`));
  console.log('info', JSON.stringify(info2));

  await fs.mkdir(outDir, { recursive: true });
  for (const name of ['base', 'noBoxes']) {
    const v = val(await evaluate(`(() => {
      const g = window.__game;
      const f = g.items?.boxField;
      if (f) {
        const show = ${JSON.stringify(name)} === 'base';
        for (const k of ['panels', 'frames', 'marks', 'rivets', 'shadows', 'points']) {
          if (f[k]) f[k].visible = show;
        }
      }
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    })()`));
    if (typeof v !== 'string' || !v.startsWith('data:image')) { console.log('shot fail', name, String(v).slice(0, 100)); continue; }
    const f = path.join(outDir, `g${GATE}-${name}.jpg`);
    await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log('shot', f);
  }
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
