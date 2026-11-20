// 局部放大核对（一次性工具）：房主皇冠 / 难度图标 到底有没有画出来
//   node tests/_c_lobby_zoom.mjs
// 用 CDP 的 clip + scale 只截两块小区域，不整屏截图。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/icon-c-zoom-' + Date.now());
const port = 9700 + Math.floor(Math.random() * 50);
const url = 'http://127.0.0.1:5199/?raceIntro=0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1200,760', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};
async function waitFor(expr, ms = 45000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; }
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('timeout ' + u); }

async function clip(box, scale, file) {
  const r = await cdp('Page.captureScreenshot', {
    format: 'png', clip: { ...box, scale }, captureBeyondViewport: true,
  }, 60000);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  console.log('  → ' + file);
}

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url });
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 45000);
  await sleep(500);
  await ev(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await sleep(1200);
  await ev(`document.querySelector('#btn-lobby-mode')?.click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 15000);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(500);
  await ev(`(() => { const d = document.querySelector('#lobby-settings-drawer'); if (d && !d.classList.contains('open')) document.querySelector('#btn-lobby-settings')?.click(); return 1; })()`);
  await sleep(800);

  const box1 = await ev(`(() => { const r = document.querySelector('#lobby-players .player-row').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  console.log('玩家行', JSON.stringify(box1));
  await clip(box1, 2.2, 'shots/icons/zoom_player_row.png');

  const box2 = await ev(`(() => { const s = document.querySelector('#sel-difficulty'); const f = s.closest('.hs-field') || s;
    const r = f.getBoundingClientRect();
    return { x: Math.round(r.x) - 6, y: Math.round(r.y) - 6, width: Math.round(r.width) + 12, height: Math.round(r.height) + 12 }; })()`);
  console.log('难度下拉', JSON.stringify(box2));
  await clip(box2, 2.2, 'shots/icons/zoom_diff.png');
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
