import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/xray-' + Date.now());
const port = 9700 + Math.floor(Math.random() * 120);
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=960,540', 'http://127.0.0.1:5173/'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const evalJS = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url) { const t0 = Date.now(); while (Date.now() - t0 < 20000) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('cdp timeout'); }
try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const info = await evalJS(`(() => ({
      ready: document.readyState,
      game: !!window.__game,
      solo: !!document.querySelector('#btn-solo'),
      menu: document.querySelector('#menu')?.className,
      boats: document.querySelectorAll('.boat-card').length,
      maps: document.querySelectorAll('.map-card').length,
      text: (document.body.innerText || '').slice(0, 160).replace(/\\n/g, ' | '),
      err: window.__bootError || '',
    }))()`);
    console.log(i, JSON.stringify(info));
    if (info.solo) { await evalJS(`document.querySelector('#btn-solo').click()`); }
  }
} catch (e) { console.error('ERR', e.message); }
finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} process.exit(0); }
