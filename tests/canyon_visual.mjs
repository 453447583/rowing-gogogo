import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 同 visual-smoke：浏览器配置放项目盘，跑完就删，不要往 C 盘写
const profile = path.resolve('D:/3dgame-tmp/browser/canyon-visual');
const cleanup = async () => {
  await new Promise((r) => setTimeout(r, 400));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};
const port = 9231;
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'http://127.0.0.1:5173/',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function waitForJson(url, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
async function shot(name) {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(`D:\\3Dgame - 副本\\canyon-${name}.png`, Buffer.from(s.data, 'base64'));
  console.log('saved', name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 900))`, awaitPromise: true });
  const click = async (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });

  await click('#btn-solo');
  await sleep(400);
  await cdp('Runtime.evaluate', { expression: `(() => [...document.querySelectorAll('#boat-list .boat-card')].find(x => x.textContent.includes('疾风'))?.click())()`, awaitPromise: true });
  await click('#btn-boat-ok');
  await sleep(400);
  await cdp('Runtime.evaluate', {
    expression: `(() => { const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === 'canyon' || x.textContent.includes('峡谷')); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()`,
    awaitPromise: true,
  });
  await sleep(5000);

  await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; if (!g?.localBoat) return; g.phase = 'racing'; g.countdownLeft = 0; })()`,
    awaitPromise: true,
  });
  await sleep(500);
  await shot('start-line');

  await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; const b = g?.localBoat; if (!b) return; b.resetTo(-78, 130, Math.atan2(14, 18)); b.speed = 8; b.vel.set(Math.sin(b.heading)*8, Math.cos(b.heading)*8); const pm = g.progressMap?.get(g.myId); if (pm) pm.gate = 13; })()`,
    awaitPromise: true,
  });
  await sleep(600);
  await shot('shortcut-exit');

  const info = await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; const t = g?.track; const walls = t?.edgeWalls || []; const gates = t?.gates || []; const sc = t?.shortcuts?.[0]; return { map: g?.mapDef?.id, gates: gates.length, edgeWalls: walls.length, shortcutPoints: sc?.points, shortcutRenderPoints: sc?.renderPoints, startLine: !!t?.startLine, pistons: (t?.pistons||[]).map(p=>[Math.round(p.x),Math.round(p.z)]), mechs: (t?.mechColliders||[]).length }; })()`,
    returnByValue: true,
  });
  console.log('INFO', JSON.stringify(info.result.value, null, 2));
}

main().then(async () => {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await cleanup();
  process.exit(0);
}).catch(async (err) => {
  console.error('FAIL', err);
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await cleanup();
  process.exit(1);
});
