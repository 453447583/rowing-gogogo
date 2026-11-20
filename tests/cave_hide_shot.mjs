// 秘境漂流黑墙归因：同一机位逐网格隐藏，出图对比。
//   node tests/cave_hide_shot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/cavehide-${stamp}`;
const port = 9910 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const GATE = Number(process.env.GATE || 3);
const BACK = Number(process.env.BACK || 8);
const outDir = path.resolve('shots/cave_diag');
const CASES = ['base', 'noShell', 'noTunnel', 'noBoth'];

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
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.track?.group`, 120000);
  await sleep(9000);
  // 固定机位
  const cam = val(await evaluate(`(() => {
    const g = window.__game, t = g.track, c = g.camera, gi = ${GATE};
    const a = t.gates[gi], b = t.gates[gi + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
    const fx = dx / L, fz = dz / L;
    const px = a[0] - fx * ${BACK}, pz = a[1] - fz * ${BACK};
    const y = (t.gateY[gi] ?? 0) + 2.4;
    g.cameraRig.follow = () => {};
    c.position.set(px, y, pz); c.up.set(0, 1, 0);
    c.lookAt(a[0] + fx * 22, y + 1.2, a[1] + fz * 22);
    c.fov = 66; c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    if (g.rafId) { cancelAnimationFrame(g.rafId); g.rafId = 0; }
    return { pos: [px, y, pz], look: [a[0] + fx * 22, y + 1.2, a[1] + fz * 22] };
  })()`));
  console.log('cam', JSON.stringify(cam));
  await fs.mkdir(outDir, { recursive: true });
  for (const name of CASES) {
    const v = val(await evaluate(`(() => {
      const g = window.__game, t = g.track;
      let shell = null, tunnel = null;
      t.group.traverse((o) => {
        if (o.name === 'cave_shell') shell = o;
        if (o.name === 'start_tunnel') tunnel = o;
      });
      const C = ${JSON.stringify(name)};
      if (shell) shell.visible = !(C === 'noShell' || C === 'noBoth');
      if (tunnel) tunnel.visible = !(C === 'noTunnel' || C === 'noBoth');
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
