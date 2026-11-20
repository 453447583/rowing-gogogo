// 选船界面截图 + 逐船手感实测（每条船跑一遍加速/滑行/转向）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boats-' + Date.now());
const port = 9950 + Math.floor(Math.random() * 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1440,860', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };

const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

try {
  let tabs = null;
  for (let i = 0; i < 60 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const errs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await sleep(2500);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(1200);
  await fs.mkdir('shots/verify', { recursive: true });
  let s = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile('shots/verify/boat-select.png', Buffer.from(s.data, 'base64'));
  console.log('saved shots/verify/boat-select.png');
  const rows = await cdp('Runtime.evaluate', {
    expression: `JSON.stringify({
      rows: [...document.querySelectorAll('#boat-stats .stat-row')].map(r => r.textContent.replace(/\\s+/g,' ').trim()),
      overflow: (() => { const p = document.getElementById('boat-stats'); return p ? [p.scrollHeight, p.clientHeight] : null; })(),
    })`, returnByValue: true,
  });
  console.log('STATS', rows.result.value);
  console.log('ERRORS', errs.length ? errs.slice(0, 3) : '无');
} finally {
  await cleanup();
}
