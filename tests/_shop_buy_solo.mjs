// 探针：局域网联机后小店的购买按钮是否可用（按钮亮不亮 / 点了服务器怎么回）
// node tests/_shop_buy_solo.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:5199/';
const cdpPort = 9990 + Math.floor(Math.random() * 9);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/shop-lan-' + Date.now());
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
  const consoleLines = [];
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
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleLines.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleLines.push('EXC ' + (m.params?.exceptionDetails?.exception?.description || ''));
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
  const click = async (sel) => {
    const r = await ev(`(function(){ const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'MISS'; el.click(); return 1; })()`);
    await sleep(400);
    return r;
  };

  await waitFor(`!!document.getElementById('name-plate')`);
  const user = 'sl' + Date.now().toString(36).slice(-4);
  const token = await ensureTestAccount('http://127.0.0.1:3000', user, 'sail123456');
  console.log('token', user, token ? 'ok' : 'EMPTY');
  const DEMO = { uid: 'u_demo', n: user, pts: 3000, earned: 9000, spent: 0, inv: {}, equip: { badges: [] }, log: [] };
  await ev(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', ${JSON.stringify(user)});
    localStorage.setItem('rr-wallet-cache', ${JSON.stringify(JSON.stringify(DEMO))});
    return 1;
  })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);
  await waitFor(`!!document.querySelector('#wallet-panel .ws')`);
  await sleep(1500);

  const modUrl = await ev(`performance.getEntriesByType('resource')
    .map(x => x.name).find(n => n.includes('/src/ui/walletPanel.js')) || '/src/ui/walletPanel.js'`);

  // 走局域网：入口 → 创建/加入本机
  console.log('entry-solo:', await click('#btn-entry-solo'));
  const inLobby = await waitFor(`!document.getElementById('lobby')?.classList.contains('hidden')`, 80);
  console.log('inLobby:', inLobby);
  await sleep(1200);

  const dump = async (tag) => {
    const st = await ev(`(async function(){
      const m = await import(${JSON.stringify(modUrl)});
      const w = m.walletPanel;
      // 小店没开时 net 也能读到（同一个单例）
      const panel = document.getElementById('wallet-panel');
      if (panel.classList.contains('hidden')) document.getElementById('name-plate').click();
      await new Promise(r => setTimeout(r, 900));
      // 余额临时改大：只验证「联机 + 积分够」时按钮是否可用，不动服务端账本
      w.points = () => 3000; // 临时：只验证「联机 + 积分够」时按钮是否可用
      document.querySelector('[data-ws-cat="all"]')?.click();
      await new Promise(r => setTimeout(r, 300));
      const btn = document.querySelector('.ws-card [data-ws-buy]');
      return {
        solo: !!w.getSolo(),
        connected: !!w.net?.connected,
        canBuy: !w.getSolo() && !!w.net?.connected,
        pts: w.points(),
        btn: btn ? { disabled: btn.disabled, text: btn.textContent.trim() } : null,
      };
    })()`);
    console.log(tag, JSON.stringify(st));
    return st;
  };

  const st = await dump('局域网联机');
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, 'shop_buy_lan.png'), Buffer.from(r.data, 'base64'));
  console.log('  · shots/verify/shop_buy_lan.png');

  if (st && st.btn && !st.btn.disabled) {
    const clicked = await ev(`(function(){
      const b = document.querySelector('.ws-card [data-ws-buy]');
      b.click(); return 1;
    })()`);
    await sleep(1500);
    const toast = await ev(`(document.querySelector('#toast')?.textContent || document.querySelector('.toast')?.textContent || '').trim()`);
    console.log('click:', clicked, 'toast:', JSON.stringify(toast));
    const after = await ev(`(async function(){
      const m = await import(${JSON.stringify(modUrl)});
      return { pts: m.walletPanel.points(), inv: m.walletPanel.data?.inv || {} };
    })()`);
    console.log('after buy:', JSON.stringify(after));
  }
  console.log('console:', consoleLines.slice(-8));

  // 模拟"掉线重连中"（真实断线会 emit reconnecting 且 connected=false）：
  // 小店开着时按钮要立刻从「购 买」退回「需联机」，余额标成未联机
  await ev(`(async function(){
    const m = await import(${JSON.stringify(modUrl)});
    const w = m.walletPanel;
    w.net.connected = false;
    w.net.dispatchEvent(new CustomEvent('reconnecting', { detail: { attempt: 1 } }));
    return 1;
  })()`);
  await sleep(500);
  const offline = await ev(`(async function(){
    const m = await import(${JSON.stringify(modUrl)});
    const w = m.walletPanel;
    const b = document.querySelector('.ws-card .ws-b1');
    return {
      connected: !!w.net?.connected,
      btn: b ? { disabled: b.disabled, text: b.textContent.trim() } : null,
      note: document.querySelector('[data-ws="balnote"]')?.textContent,
      sub: document.querySelector('[data-ws="sub"]')?.textContent,
    };
  })()`);
  console.log('掉线后:', JSON.stringify(offline));
  const r2 = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, 'shop_buy_offline.png'), Buffer.from(r2.data, 'base64'));
  console.log('  · shots/verify/shop_buy_offline.png');

  // 点一张「积分够」的卡：应弹一次解释，且 offlineWarned 置位（不会每次点都弹）
  const cardToast = await ev(`(async function(){
    const m = await import(${JSON.stringify(modUrl)});
    const w = m.walletPanel;
    w.offlineWarned = false;
    document.querySelector('.ws-card')?.click();
    await new Promise(r => setTimeout(r, 500));
    const t1 = document.querySelector('#toast')?.textContent?.trim() || '';
    const warned = w.offlineWarned;
    document.querySelectorAll('.ws-card')[1]?.click();
    await new Promise(r => setTimeout(r, 400));
    return { firstToast: t1, warned, afterSecond: w.offlineWarned };
  })()`);
  console.log('点卡提示:', JSON.stringify(cardToast));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}
