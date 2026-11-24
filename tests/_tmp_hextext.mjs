// 找出 HUD 里把图标路径当文字打出来的元素
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hextext-' + Date.now());
const port = 9940 + Math.floor(Math.random() * 40);
const base = 'http://127.0.0.1:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 400));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('t'); }
async function waitFor(e, ms = 25000) { const t0 = Date.now(); let l; while (Date.now() - t0 < ms) { l = await ev(e); if (l) return l; await sleep(250); } throw new Error('timeout ' + e); }

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  let inLobby = false;
  for (let i = 0; i < 12 && !inLobby; i++) { await ev(`document.querySelector('#btn-solo')?.click(); 1`); await sleep(800); inLobby = await ev(`(() => { const l = document.querySelector('#lobby'); return !!l && !l.classList.contains('hidden'); })()`); }
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('[data-mode="boss"][data-variant="hex"]')`, 20000);
  await ev(`document.querySelector('[data-mode="boss"][data-variant="hex"]').click(); 1`);
  await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  for (let a = 0; a < 4; a++) {
    await ev(`document.querySelector('#btn-start-race')?.click(); 1`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) { if (await ev(`!!window.__game?.bossMode`)) break; await sleep(400); }
    if (await ev(`!!window.__game?.bossMode`)) break;
  }
  await waitFor(`!!window.__game?.bossMode`, 60000);
  await ev(`window.__game.bossMode.introT = 99; 1`);
  await waitFor(`window.__game.bossMode.phase === 'countdown'`, 30000);
  await ev(`window.__game.bossMode.countdown = 0.02; 1`);
  await waitFor(`window.__game.bossMode.phase === 'fight'`, 30000);
  await sleep(1500);

  console.log('含 hex/ 的文本节点：', JSON.stringify(await ev(`(() => {
    const out = [];
    const walk = (el) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && /hex\\//.test(n.nodeValue || '')) {
          out.push({ tag: el.tagName, id: el.id, cls: el.className, text: n.nodeValue.trim().slice(0, 60),
            rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })() });
        }
        if (n.nodeType === 1) walk(n);
      }
    };
    walk(document.body);
    return out;
  })()`)));
} catch (e) {
  console.error('失败：', e.message);
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
