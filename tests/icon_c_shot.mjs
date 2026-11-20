// C 类第二批：出图核对（大厅头像 / 皇冠 / 难度下拉 + 怪物模式提示条图标）
//   npm run dev → node tests/icon_c_shot.mjs
//
// 只截 2 张（CDP 连续截图在无头下容易挂，且每次会重新合成）：
//   ① 大厅：头像 PNG / 房主皇冠 / 设置抽屉里的难度图标
//   ② 怪物模式 HUD：卷轴提示条开头的元素图标
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/icon-c-shot-' + Date.now());
const port = 9700 + Math.floor(Math.random() * 50);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/?raceIntro=0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1200,760', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
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

const shot = async (file) => {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 60000);
  const data = r.data;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(data, 'base64'));
  console.log('  → ' + file);
};

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

  // ---------- ① 大厅 ----------
  console.log('① 大厅');
  await ev(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await sleep(1200);
  // 切到怪物模式，让难度下拉出现在抽屉里
  await ev(`document.querySelector('#btn-lobby-mode')?.click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 15000);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(600);
  await ev(`(() => { const d = document.querySelector('#lobby-settings-drawer'); if (d && !d.classList.contains('open')) document.querySelector('#btn-lobby-settings')?.click(); return 1; })()`);
  await sleep(700);
  await shot('shots/icons/c_lobby.jpg');

  // ---------- ② 怪物模式卷轴提示 ----------
  console.log('② 怪物模式提示条');
  await ev(`document.querySelector('#btn-start-race')?.click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);
  await sleep(1800);
  await ev(`(() => {
    const g = window.__game;
    g.phase = 'racing';
    if ('countdownLeft' in g) g.countdownLeft = 0;
    g.opts.onFinish = () => {};
    g.opts.onQuit = () => {};
    return 1;
  })()`);
  await sleep(400);
  await ev(`(async () => {
    const ui = await import('/src/ui/ui.js');
    ui.toast('🔥 熔岩海啸！侧向跑出火墙通道');
    return 1;
  })()`);
  await sleep(700);
  await shot('shots/icons/c_boss_toast.jpg');
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
