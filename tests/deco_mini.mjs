// 最小诊断：只做一次传送，把异常原样打印出来
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/deco-mini');
const port = 9251;
const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=900,520', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.method === 'Runtime.exceptionThrown') console.log('PAGE EXCEPTION:', m.params.exceptionDetails.exception?.description?.slice(0, 400) || m.params.exceptionDetails.text); });
  await sleep(1500);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(600);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][0]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(600);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='ocean'); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  await sleep(9000);
  const r = await cdp('Runtime.evaluate', {
    expression: `JSON.stringify({
      map: window.__game?.mapDef?.id,
      phase: window.__game?.phase,
      kinds: (window.__game?.track?.courseProps || []).map((p) => p.kind),
      decoInMap: (window.__game?.mapDef?.courseProps || []).filter((p) => p.kind === 'deco').length,
      mapCards: [...document.querySelectorAll('.map-card')].map((c) => c.dataset.mapId),
      js: [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src')).join(','),
    })`, returnByValue: true,
  });
  console.log(r.result.value);
}
main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
