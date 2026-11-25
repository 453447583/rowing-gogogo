// 一次性探针：右上角改名入口的新样式 + 点击仍能打开改名弹窗
// 用法：node tests/_tmp_nameplate_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3311, WS_PORT = 3412;
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/nameplate-${stamp}`);
const cdpPort = 9790 + (Number(stamp.slice(-2)) % 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}
async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/lb-probe-nameplate.json'), LB_STORE: 'json' },
  stdio: 'ignore',
});
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', `http://127.0.0.1:${PORT}/`],
{ stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp timeout ' + method)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};
async function waitFor(expr, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(200); }
  throw new Error('waitFor timeout: ' + expr);
}
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

async function main() {
  await waitHttp(`http://127.0.0.1:${PORT}/`);
  const tabs = await waitJson(`http://127.0.0.1:${cdpPort}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor(`!!document.querySelector('#name-plate .mp-edit')`, 40000);
  await sleep(300);

  const shape = await ev(`(() => {
    const b = document.querySelector('#name-plate');
    const cs = getComputedStyle(b), r = b.getBoundingClientRect();
    const before = getComputedStyle(b, '::before');
    const entry = document.querySelector('#btn-entry-lan');
    const ec = getComputedStyle(entry);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(innerWidth - r.right), top: Math.round(r.top),
      radius: cs.borderRadius, border: cs.borderColor,
      bg: cs.backgroundImage.slice(0, 70),
      bar: before.backgroundColor, barW: before.width,
      entryBorder: ec.borderColor, entryBar: getComputedStyle(entry, '::before').backgroundColor,
      icon: !!b.querySelector('svg'),
      edit: b.querySelector('.mp-edit')?.textContent.trim(),
    };
  })()`);
  ok(shape.h === 38, '38px 工具条高度', shape);
  ok(shape.radius === '3px' && shape.border === shape.entryBorder, '同款金边/直角', shape);
  ok(shape.bar === shape.entryBar, '同款左侧橙光条', shape);
  ok(shape.icon && shape.edit === '改名', '图标 + 改名标保留', shape);

  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  await fs.mkdir('shots/verify', { recursive: true });
  await fs.writeFile('shots/verify/nameplate_ms_btn.jpg', Buffer.from(shot.data, 'base64'));

  await ev(`document.querySelector('#name-plate').click(); 1`);
  await sleep(350);
  const dialog = await ev(`!document.querySelector('#dlg-name')?.classList.contains('hidden')`);
  ok(dialog === true, '点击仍能打开改名弹窗', dialog);

  console.log(failures ? `FAIL ${failures}` : 'PASS');
  if (failures) process.exitCode = 1;
}
main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    child.kill(); server.kill();
    await sleep(300);
    process.exit(process.exitCode || 0);
  });
