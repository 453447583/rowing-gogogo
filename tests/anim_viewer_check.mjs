// 一次性校验：动画查看器能否正常加载 crab.glb 并列出全部 clip
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/anim-viewer');
const port = 9231;
const URL_ = 'http://127.0.0.1:5173/tools/anim-viewer/index.html';
const shot = path.resolve('shots/verify/rig/anim-viewer.png');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1180,760', URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let seq = 0;
const pending = new Map();
const errors = [];

function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('anim-viewer'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 连不上');
}

const url = await connect();
ws = new WebSocket(url, { perMessageDeflate: false });
await new Promise((r) => ws.on('open', r));

ws.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description
      || m.params.exceptionDetails?.text || 'exception');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
});

await cdp('Runtime.enable');
await cdp('Page.enable');
await cdp('Log.enable');

// 等 clip 列表渲染出来
let info = null;
for (let i = 0; i < 60; i++) {
  const r = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const clips = [...document.querySelectorAll('#clips .clip')].map(b => ({
        name: b.querySelector('.cname')?.textContent,
        tag: b.querySelector('.ctag')?.textContent,
        meta: b.querySelector('.cmeta')?.textContent,
      }));
      return JSON.stringify({
        clips,
        meta: document.getElementById('meta')?.innerText.replace(/\\n/g, ' | '),
        cur: document.getElementById('cur-clip')?.textContent,
        status: document.getElementById('status')?.textContent,
      });
    })()`,
    returnByValue: true,
  });
  const parsed = JSON.parse(r.result.value || '{}');
  if (parsed.clips?.length) { info = parsed; break; }
  await sleep(400);
}

await sleep(1200); // 让动画跑几帧再截图
const png = await cdp('Page.captureScreenshot', { format: 'png' });
await fs.mkdir(path.dirname(shot), { recursive: true });
await fs.writeFile(shot, Buffer.from(png.data, 'base64'));

ws.close();
child.kill();
await sleep(200);
await fs.rm(profile, { recursive: true, force: true }).catch(() => {});

console.log(JSON.stringify({ info, errors, shot }, null, 1));
