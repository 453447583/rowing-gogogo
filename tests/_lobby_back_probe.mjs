// 一次性探针：量大厅左上角返回按钮相对红色顶栏的位置，并截顶部特写。
// 不改源码。用法：node tests/_lobby_back_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/lobby-back-${stamp}`);
const port = 9740 + (Number(stamp.slice(-2)) % 40);
const out = path.resolve('shots/verify/lobby-back-topbar.jpg');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', 'http://127.0.0.1:5199/',
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
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
  // 无头窗口真实视口小于 1280x720，强制设成 1280x720 再截图
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1500);

  const dom = await evaluate(`(() => {
    const b = document.getElementById('btn-lobby-back');
    const bar = document.querySelector('.lobby-topbar');
    const ico = b.querySelector('.lb-house');
    if (!b || !bar) return { err: 'missing button or topbar' };
    const rb = b.getBoundingClientRect();
    const rt = bar.getBoundingClientRect();
    const ri = ico.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    const borderBottom = parseFloat(cs.borderBottomWidth) || 0;
    return {
      button: { w: +rb.width.toFixed(1), h: +rb.height.toFixed(1), left: +rb.left.toFixed(1), top: +rb.top.toFixed(1), bottom: +rb.bottom.toFixed(1) },
      icon: { w: +ri.width.toFixed(1), h: +ri.height.toFixed(1) },
      topbar: { h: +rt.height.toFixed(1), borderBottom, innerBottom: +(rt.bottom - borderBottom).toFixed(1) },
      gapTop: +(rb.top - rt.top).toFixed(1),
      gapBottom: +((rt.bottom - borderBottom) - rb.bottom).toFixed(1),
      text: b.textContent.trim(),
    };
  })()`);
  console.log('measure:', JSON.stringify(dom.result?.value));

  await fs.mkdir(path.dirname(out), { recursive: true });
  const shot = await cdp('Page.captureScreenshot', {
    format: 'jpeg', quality: 92,
    clip: { x: 0, y: 0, width: 640, height: 70, scale: 2 },
    captureBeyondViewport: false,
  });
  await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('ok ->', out);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
