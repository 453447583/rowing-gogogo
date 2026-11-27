// 探针：复现「积分够了但购买按钮是灰的」，读钱包/按钮真实状态
// node tests/_shop_buy_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:5199/';
const cdpPort = 9990 + Math.floor(Math.random() * 9);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/shop-buy-' + Date.now());
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

  await waitFor(`!!document.getElementById('name-plate')`);
  const user = 'sb' + Date.now().toString(36).slice(-4);
  const token = await ensureTestAccount('http://127.0.0.1:3000', user, 'sail123456');
  console.log('token', user, token ? 'ok' : 'EMPTY');
  const DEMO = { uid: 'u_demo', n: '测试船长', pts: 3000, earned: 9000, spent: 6000, inv: {}, equip: { badges: [] }, log: [] };
  await ev(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', ${JSON.stringify(user)});
    localStorage.setItem('rr-wallet-cache', ${JSON.stringify(JSON.stringify(DEMO))});
    return 1;
  })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);
  await waitFor(`!!document.querySelector('#wallet-panel .ws')`);
  await sleep(1800);
  await ev(`(function(){ document.getElementById('name-plate').click(); return 1; })()`);
  await sleep(700);

  const modUrl = await ev(`performance.getEntriesByType('resource')
    .map(x => x.name).find(n => n.includes('/src/ui/walletPanel.js')) || '/src/ui/walletPanel.js'`);

  const dump = async (tag) => {
    const st = await ev(`(async function(){
      const m = await import(${JSON.stringify(modUrl)});
      const w = m.walletPanel;
      const btn = document.querySelector('.ws-card [data-ws-buy]');
      const cards = [...document.querySelectorAll('.ws-card')];
      const affordCards = cards.filter(c => !c.classList.contains('locked')).length;
      return {
        pts: w.points(),
        solo: !!w.getSolo(),
        connected: !!w.net?.connected,
        canBuy: !w.getSolo() && !!w.net?.connected,
        cards: cards.length,
        affordCards,
        btn: btn ? {
          disabled: btn.disabled,
          text: btn.textContent.trim(),
          bg: getComputedStyle(btn).backgroundColor,
          color: getComputedStyle(btn).color,
        } : null,
        firstCardText: cards[0]?.querySelector('.ws-b1')?.textContent.trim(),
        firstCardDisabled: cards[0]?.querySelector('.ws-b1')?.disabled,
      };
    })()`);
    console.log(tag, JSON.stringify(st, null, 0));
    return st;
  };

  await dump('主菜单(未联机)');
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, 'shop_buy_menu.png'), Buffer.from(r.data, 'base64'));
  console.log('  · shots/verify/shop_buy_menu.png');

  // 点第一张卡的购买键（如果没 disabled），看有没有 toast
  const clicked = await ev(`(function(){
    const b = document.querySelector('.ws-card [data-ws-buy]');
    if (!b) return 'no btn';
    if (b.disabled) return 'disabled';
    b.click();
    return 'clicked';
  })()`);
  console.log('click:', clicked);
  await sleep(800);
  const toast = await ev(`(document.querySelector('.toast, #toast')?.textContent || '').trim()`);
  console.log('toast:', JSON.stringify(toast));
  console.log('pageErrors', pageErrors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}
