// 秘境漂流·山洞段单机验图（轻量：只进一张图、只拍一张、只查蘑菇材质）
//   node tests/baked_cave_shot.mjs [baseUrl]
// 这张脚本存在的理由：整图验收在软件光栅下太慢（森林 + 3.4km 地形能把一帧拖到几秒），
// 而"蘑菇是不是还是暗红"只需要山洞段一张图 + 两条材质断言。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/baked-cave-' + Date.now());
const port = 9500 + Math.floor(Math.random() * 100);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=800,450', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 60000)),
  ]);
};
const evalJS = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const local = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let tabs = null;
  for (let i = 0; i < 100 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await local(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await local(3000);

  const waitFor = async (expr, label) => {
    for (let i = 0; i < 60; i++) {
      const ok = await evalJS(expr).catch(() => false);
      if (ok) return;
      await local(500);
    }
    throw new Error('timeout: ' + label);
  };
  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  await evalJS(`document.querySelector('#btn-solo').click()`);
  await waitFor(`!!document.querySelector('#boat-list .boat-card')`, 'boats');
  await evalJS(`(() => { document.querySelector('#boat-list .boat-card').click(); document.querySelector('#btn-boat-ok').click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'maps');
  for (let i = 0; i < 6 && !(await evalJS(`!!window.__game`).catch(() => false)); i++) {
    await evalJS(`(() => {
      const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === 'baked');
      card?.click(); document.querySelector('#btn-map-ok')?.click();
    })()`);
    await local(2500);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await local(6000);   // GLB
  await evalJS(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    g.renderer.setSize(800, 450, false);
    const a = g.mapDef.gates[7], b = g.mapDef.gates[8];
    const x = a[0] + (b[0] - a[0]) * 0.5, z = a[1] + (b[1] - a[1]) * 0.5;
    const boat = g.localBoat;
    boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
    boat.speed = 0; boat.vel.set(0, 0);
    boat.diveTargetY = g.track.diveHeightAt(boat.pos, 8);
    const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = 8; pm.lap = 1; }
    g.cameraRig?.snap?.();
  })()`);
  await local(2500);
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  const f = path.join(out, 'baked-cave-mushroom.png');
  await fs.writeFile(f, Buffer.from(res.data, 'base64'));
  console.log('shot ->', path.relative(process.cwd(), f));

  const mush = await evalJS(`(() => {
    const g = window.__game; const out = []; const seen = new Set();
    g.track.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mn = o.material.name || '';
      if (!/cave_(cap|stem)/i.test(mn) || seen.has(mn)) return;
      seen.add(mn);
      out.push({ mat: mn, emissive: o.material.emissive ? '#' + o.material.emissive.getHexString() : null,
        ei: o.material.emissiveIntensity, emissiveMap: !!o.material.emissiveMap,
        vertexColors: o.material.vertexColors, map: !!o.material.map });
    });
    return out;
  })()`);
  console.log('蘑菇材质:', JSON.stringify(mush, null, 1));
  const good = mush.length && mush.every((m) => m.emissiveMap && m.ei >= 0.4 && !m.vertexColors);
  console.log(good ? 'cave mushroom: PASS' : 'cave mushroom: FAIL');
} catch (e) {
  console.error('cave shot FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
