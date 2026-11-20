// 一次性校验：牛来.glb 在引擎侧能否加载 4 个骨骼动作 + smile 形态键
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cow-rig');
const port = 9241;
const MODEL = '/models/cow_rider.glb';
const URL_ = `http://127.0.0.1:5173/tools/anim-viewer/index.html?model=${encodeURIComponent(MODEL)}`;
const outDir = path.resolve('shots/verify/cow');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=760,480', URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
let seq = 0;
const pending = new Map();
const errors = [];

function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error(`cdp timeout ${method}`)); }
    }, 20000);
  });
}

async function connect() {
  for (let i = 0; i < 80; i++) {
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

let result = {};
try {
  const url = await connect();
  ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  ws.on('close', () => { for (const [, p] of pending) p.reject(new Error('ws closed')); pending.clear(); });
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

  // 等 clip 列表渲染
  let info = null;
  for (let i = 0; i < 80; i++) {
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
          status: document.getElementById('status')?.textContent,
        });
      })()`,
      returnByValue: true,
    });
    const parsed = JSON.parse(r.result.value || '{}');
    if (parsed.clips?.length) { info = parsed; break; }
    await sleep(400);
  }
  result.info = info;
  result.status = info?.status;

  // 探形态键（three.js 侧）
  const morph = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const out = [];
      const s = window.__av ? window.__av : null;
      return JSON.stringify({ hasHook: !!s });
    })()`,
    returnByValue: true,
  });
  result.morphProbe = morph.result.value;

  await fs.mkdir(outDir, { recursive: true });

  // 逐个动作截图
  const names = (info?.clips || []).map((c) => c.name);
  const shoot = async (idx, file) => {
    const r = await cdp('Runtime.evaluate', {
      expression: `document.querySelectorAll('#clips .clip')[${idx}]?.click(), document.querySelectorAll('#clips .clip').length`,
      returnByValue: true,
    });
    if (!r.result.value) return;
    await sleep(900);
    const jpg = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
    await fs.writeFile(path.join(outDir, file), Buffer.from(jpg.data, 'base64'));
  };

  for (let i = 0; i < Math.min(names.length, 4); i++) {
    await shoot(i, `clip${i}_${names[i]}.jpg`);
  }
  result.shots = await fs.readdir(outDir);
} catch (e) {
  result.error = String(e && e.message ? e.message : e);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify({ ...result, errors: errors.slice(0, 6) }, null, 1));
