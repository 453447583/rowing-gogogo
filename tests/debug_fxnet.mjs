// 诊断：打开预览页，抓所有网络请求，看 efkefc 的依赖到底卡在哪个 URL
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const target = process.argv[2] || '/effects/LightningStrike/LightningStrike.efkefc';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fxnet');
const port = 9293;
const sleep = (m) => new Promise((r) => setTimeout(r, m));
let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
async function waitJson(url, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); }
  throw new Error('cdp timeout');
}

await fs.mkdir(path.dirname(profile), { recursive: true });
child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=420,320', 'about:blank'], { stdio: 'ignore' });
const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

const reqs = new Map();
const failed = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Network.requestWillBeSent') {
    reqs.set(m.params.requestId, m.params.request.url);
  } else if (m.method === 'Network.responseReceived') {
    const url = reqs.get(m.params.requestId) || m.params.response.url;
    if (m.params.response.status >= 400) failed.push(`HTTP ${m.params.response.status}  ${url}`);
  } else if (m.method === 'Network.loadingFailed') {
    const url = reqs.get(m.params.requestId) || '?';
    failed.push(`FAILED ${m.params.errorText}  ${url}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('EXC:', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (txt && m.params.type !== 'debug') console.log('CONSOLE[' + m.params.type + ']:', txt.slice(0, 300));
  }
});
await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 320, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: `http://127.0.0.1:${process.env.FXPORT || 3112}/fx-preview.html?fx=X&p=${encodeURIComponent(target)}&scale=1&v=${Date.now()}` });
await sleep(9000);
const state = await cdp('Runtime.evaluate', {
  expression: 'JSON.stringify({ready: window.__ready, hud: document.getElementById("hud").textContent})',
  returnByValue: true,
});
console.log('state', state.result.value);
console.log('--- 请求总数', reqs.size);
for (const [, url] of reqs) {
  if (url.includes('/effects/') || url.includes('/fx-projects/')) console.log('  ok ', url.replace('http://127.0.0.1:${process.env.FXPORT || 3112}', ''));
}
if (failed.length) {
  console.log('--- 失败', failed.length);
  for (const f of failed.slice(0, 20)) console.log('  ' + f.replace('http://127.0.0.1:${process.env.FXPORT || 3112}', ''));
}
try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
