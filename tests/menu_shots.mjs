// 主菜单改造验收：4 张截图（主界面 / 改名 / 加入 / 说明）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/menu-shots');
const port = 9241;
const URL = process.env.SHOT_URL || 'http://127.0.0.1:8765/';
const OUT = path.resolve('shots/verify');
await fs.mkdir(OUT, { recursive: true });

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1366,768', URL,
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const cdp = (m, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + url);
}

try {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 240));
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  const waitUntil = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(150); }
    return false;
  };

  await cdp('Page.navigate', { url: URL });
  if (!await waitUntil(`document.readyState === 'complete' && !!document.querySelector('#name-plate')`)) {
    throw new Error('menu not ready');
  }
  await sleep(1200);

  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
    console.log('[menu] wrote', name);
  };

  await shot('menu-1-home');

  await ev(`document.querySelector('#name-plate').click()`);
  await sleep(500);
  await shot('menu-2-name');
  await ev(`document.querySelector('[data-close="dlg-name"]').click()`);
  await sleep(250);

  await ev(`document.querySelector('#btn-join').click()`);
  await sleep(500);
  await shot('menu-3-join');
  await ev(`document.querySelector('[data-close="dlg-join"]').click()`);
  await sleep(250);

  await ev(`document.querySelector('#btn-help').click()`);
  await sleep(500);
  await shot('menu-4-help');

  const diag = await ev(`JSON.stringify({
    home: getComputedStyle(document.querySelector('#menu-main')).width,
    plate: document.querySelector('#name-plate-text').textContent,
    btns: [...document.querySelectorAll('.wood-btn')].map(b => b.textContent.trim()).filter(Boolean),
    bg: getComputedStyle(document.querySelector('#bg-image')).backgroundImage || document.querySelector('#bg-image').getAttribute('src'),
  })`);
  console.log('[menu] diag', diag);
  console.log('[menu] errors', logs.length ? logs.join(' | ') : 'none');
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
