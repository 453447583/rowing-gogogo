// 临时探针：量「名牌光效 / 徽章」卡面插画的实际占位并截图
// node tests/_shop_art_measure.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:5199/';
const cdpPort = 9990 + Math.floor(Math.random() * 9);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/shop-art-' + Date.now());
const shots = path.resolve('shots/verify');
fs.mkdirSync(shots, { recursive: true });

const child = spawn(edge, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', base], { stdio: 'ignore' });

let ws = null;
try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  if (!tabs) throw new Error('CDP 未就绪');
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const pending = new Map();
  const pageErrors = [];
  let seq = 0;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const ev = async (expression) => (await cdp('Runtime.evaluate', {
    expression: `(async function(){ try { return (${expression}); } catch(e){ return 'ERR:'+e.message; } })()`,
    returnByValue: true, awaitPromise: true,
  }))?.result?.value;
  const waitFor = async (expr, tries = 120) => {
    for (let i = 0; i < tries; i++) { if (await ev(expr) === true) return true; await sleep(250); }
    return false;
  };
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
    console.log('  · shots/verify/' + name);
  };

  await waitFor(`!!document.getElementById('name-plate')`);
  const user = 'sa' + Date.now().toString(36).slice(-4);
  const token = await ensureTestAccount('http://127.0.0.1:3000', user, 'sail123456');
  console.log('token', user, token ? token.slice(0, 8) + '…' : 'EMPTY');
  await ev(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', ${JSON.stringify(user)});
    return 1;
  })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);
  await waitFor(`!!document.querySelector('#wallet-panel .ws')`);
  await sleep(1800);
  await ev(`(function(){ document.getElementById('name-plate').click(); return 1; })()`);
  await sleep(600);

  const measure = async (cat) => {
    await ev(`(function(){ document.querySelector('[data-ws-cat="${cat}"]')?.click(); return 1; })()`);
    await sleep(500);
    const info = await ev(`(function(){
      const cards = [...document.querySelectorAll('.ws-card')];
      return cards.slice(0, 2).map((c) => {
        const top = c.querySelector('.ws-top').getBoundingClientRect();
        const art = c.querySelector('.ws-art').getBoundingClientRect();
        const img = c.querySelector('.ws-art img');
        const ib = img ? img.getBoundingClientRect() : null;
        return {
          card: [Math.round(c.getBoundingClientRect().width), Math.round(c.getBoundingClientRect().height)],
          top: [Math.round(top.width), Math.round(top.height)],
          art: [Math.round(art.width), Math.round(art.height)],
          img: ib ? [Math.round(ib.width), Math.round(ib.height), Math.round(ib.top - top.top), Math.round(ib.left - top.left)] : null,
        };
      });
    })()`);
    console.log(cat, JSON.stringify(info));
    await shot(`shop_art_${cat}.png`);
  };

  await measure('fx');
  await measure('badge');
  console.log('pageErrors', pageErrors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}
