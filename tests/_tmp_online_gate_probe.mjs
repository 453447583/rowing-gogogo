// 一次性探针：验证「联机对战」在本地地址下被拦（2026-11-24）。
// 用法：node tests/_tmp_online_gate_probe.mjs
// 逻辑：本地起 server/server.js（dist 静态页 + 同源 /ws 都在同一个端口），
// 用无头 Edge 打开 127.0.0.1:PORT，点「联机对战」，期望：
//   1) 弹出提示文案提到「线上网址」
//   2) 没有进入大厅（#lobby 仍是 hidden）
//   3) 按钮带 is-locked 且 aria-disabled=true
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3311;
const WS_PORT = 3412;
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/online-gate-${stamp}`);
const port = 9600 + (Number(stamp.slice(-2)) % 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return true; } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`timeout ${u}`);
}
async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`timeout ${u}`);
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/lb-probe-online-gate.json'),
    LB_STORE: 'json',
  },
  stdio: 'ignore',
});

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720',
  `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};

async function main() {
  await waitHttp(`http://127.0.0.1:${PORT}/`);
  const info = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  // 等入口页出现，并且等主模块真正跑过（syncOnlineEntryGate 会给按钮写 aria-disabled）
  let inited = false;
  for (let i = 0; i < 120; i++) {
    inited = await evaluate(`(() => {
      const b = document.querySelector('#btn-entry-online');
      return !!b && b.getAttribute('aria-disabled') !== null;
    })()`);
    if (inited) break;
    await sleep(250);
  }
  if (!inited) throw new Error('主模块没在 30s 内初始化（按钮没有 aria-disabled）');
  await sleep(300);

  const before = await evaluate(`(() => {
    const b = document.querySelector('#btn-entry-online');
    return { locked: b.classList.contains('is-locked'), aria: b.getAttribute('aria-disabled'),
             note: b.parentElement.querySelector('.entry-note')?.textContent.trim() || '' };
  })()`);

  await evaluate(`document.querySelector('#btn-entry-online').click()`);
  await sleep(1500);

  const after = await evaluate(`(() => {
    const t = document.getElementById('toast');
    return { toast: (t?.textContent || '').trim(),
             lobbyHidden: document.getElementById('lobby').classList.contains('hidden'),
             menuEntryHidden: document.getElementById('menu-entry').classList.contains('hidden') };
  })()`);

  const pass = before.locked === true
    && before.aria === 'true'
    && after.lobbyHidden === true
    && after.menuEntryHidden === false
    && /线上网址/.test(after.toast);

  // 第二段：局域网入口本地必须照旧能用（?ws= 指到本进程 WS_PORT）
  await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ws=${WS_PORT}` });
  await sleep(1500);
  for (let i = 0; i < 120; i++) {
    const ok = await evaluate(`(() => {
      const b = document.querySelector('#btn-entry-online');
      return !!b && b.getAttribute('aria-disabled') !== null;
    })()`);
    if (ok) break;
    await sleep(250);
  }
  await evaluate(`document.querySelector('#btn-entry-lan').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('#btn-host').click()`);
  let lanLobby = false;
  for (let i = 0; i < 40; i++) {
    lanLobby = await evaluate(`!document.getElementById('lobby').classList.contains('hidden')`);
    if (lanLobby) break;
    await sleep(250);
  }
  const lan = { lanLobby };
  console.log(JSON.stringify({ before, after, lan }, null, 2));
  console.log(pass && lanLobby ? 'PASS' : 'FAIL');
  if (!(pass && lanLobby)) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    child.kill();
    server.kill();
    await sleep(300);
    process.exit(process.exitCode || 0);
  });
