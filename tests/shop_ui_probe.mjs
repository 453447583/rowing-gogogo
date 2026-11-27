// 激流小店 UI 截图：node tests/shop_ui_probe.mjs
// 前置：dev server 5199 + 游戏服务器 3000/3001（/auth 走 vite 代理）
// 账号门是强制的：必须先拿真 token，否则点名牌只会弹登录页。
// 样例钱包数据通过「同一模块实例」注入：从 performance 找 vite 实际加载的 URL（可能带 ?t=），
// 直接 import('/src/ui/walletPanel.js') 会拿到第二个实例（root 为 null）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const cdpPort = 9960 + Math.floor(Math.random() * 30);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/shop-ui-' + Date.now());
const shots = path.resolve('shots/verify');
fs.mkdirSync(shots, { recursive: true });

const now = Date.now();
const DEMO = {
  uid: 'u_demo', n: '测试船长', pts: 2600, earned: 9000, spent: 6400,
  inv: { frame_silver: 1, title_rough: 2, hex_ticket: 3 },
  equip: { frame: 'frame_silver', title: 'title_rough' },
  log: [
    { d: '竞速上榜 第 1 名 · 珊瑚湾 · 3 圈', at: now - 40 * 60e3 },
    { d: '海克斯 通过第 4 层', at: now - 3 * 3600e3 },
    { d: '天梯到达第 5 层', at: now - 26 * 3600e3 },
    { d: '兑换 白银激流框 -1500', at: now - 32 * 3600e3 },
    { d: '竞速上榜 第 3 名 · 熔岩峡谷 · 3 圈', at: now - 50 * 3600e3 },
    { d: '怪物模式 击杀雷霆龙骑士', at: now - 74 * 3600e3 },
  ],
};

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

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
  const waitFor = async (expr, label, tries = 120) => {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await ev(expr);
      if (last === true) return true;
      await sleep(250);
    }
    console.error('    timeout:', label, JSON.stringify(last));
    return false;
  };
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
    console.log('  · shots/verify/' + name);
  };

  await waitFor(`!!document.getElementById('name-plate')`, '主菜单');
  const user = 'shopui' + Date.now().toString(36).slice(-4);
  const token = await ensureTestAccount('http://127.0.0.1:3000', user, 'sail123456');
  ok(!!token, '测试账号 token 已拿到');
  await ev(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', ${JSON.stringify(user)});
    localStorage.setItem('rr-wallet-cache', ${JSON.stringify(JSON.stringify(DEMO))});
    return 1;
  })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);

  const inited = await waitFor(`!!document.querySelector('#wallet-panel .ws')`, '面板 init');
  ok(inited, '小店面板初始化完成');
  await sleep(2200); // 背景 3D 起来再拍

  // 动态 import 必须带 vite 给 main.js 的那个 ?t= 版本串，否则会拿到另一个模块实例。
  // 从 performance 里捞真实 URL，就能拿到页面正在用的 walletPanel 单例。
  const modUrl = await ev(`performance.getEntriesByType('resource')
    .map(x => x.name).find(n => n.includes('/src/ui/walletPanel.js')) || '/src/ui/walletPanel.js'`);

  const open = async () => {
    // 走真实入口（有 token 才不会被账号门挡住）
    await ev(`(function(){ document.getElementById('name-plate').click(); return 1; })()`);
    await sleep(520);
    // 再塞样例钱包进来，点分类触发同一次重绘（截图里能看到已装备/买不起等状态）
    await ev(`(async function(){
      const m = await import(${JSON.stringify(modUrl)});
      m.walletPanel.data = ${JSON.stringify(DEMO)};
      document.querySelector('[data-ws-cat="all"]')?.click();
      return 1;
    })()`);
    await sleep(420);
  };
  const clickSel = async (sel) => {
    const r = await ev(`(function(){ const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return 'MISS'; el.click(); return 1; })()`);
    await sleep(340);
    return r;
  };

  await open();
  await shot('shop_01_all.png');

  // 点第一张卡试穿：右侧预览应跟着换
  await ev(`(function(){ document.querySelectorAll('.ws-card')[2]?.click(); return 1; })()`);
  await sleep(360);
  await shot('shop_02_pick.png');

  await clickSel('[data-ws-cat="title"]');
  await shot('shop_03_title.png');

  await clickSel('[data-ws-cat="all"]');
  await clickSel('[data-ws-filter="equipped"]');
  await shot('shop_04_equipped.png');

  await clickSel('[data-ws-filter="all"]');
  await clickSel('[data-ws-view="bag"]');
  await shot('shop_05_bag.png');

  await clickSel('[data-ws-view="log"]');
  await shot('shop_06_log.png');

  // 结构断言
  await clickSel('[data-ws-view="bag"]');
  await clickSel('[data-ws-cat="all"]');
  ok(await waitFor(`!!document.querySelector('.ws-grid')`, '回到商城'), '切回商城视图');
  await ev(`(function(){ document.querySelectorAll('.ws-card')[2]?.click(); return 1; })()`);
  await sleep(420);
  const stat = await ev(`(function(){
    const cards = [...document.querySelectorAll('.ws-card')];
    const grid = document.querySelector('.ws-grid');
    const main = document.querySelector('.ws-main');
    const side = document.querySelector('.ws-side');
    return {
      cards: cards.length,
      used: cards.filter(c => c.classList.contains('owned')).length,
      picked: !!document.querySelector('.ws-card.sel'),
      pts: document.querySelector('.ws-bal b')?.textContent,
      rowTop: [...new Set(cards.map(c => Math.round(c.getBoundingClientRect().top)))].length,
      overflowX: grid.scrollWidth > grid.clientWidth + 1,
      scrollY: grid.scrollHeight > grid.clientHeight + 1,
      sideW: Math.round(side.getBoundingClientRect().width),
      mainW: Math.round(main.getBoundingClientRect().width),
    };
  })()`);
  ok(stat && stat.cards === 8, '商城 8 件商品全部渲染', stat?.cards);
  ok(stat && stat.used === 2, '已装备两件（框 + 称号）有绿色描边', stat?.used);
  ok(stat && stat.picked === true, '点卡片后进入选中/试穿态', stat?.picked);
  ok(stat && stat.pts === '2600', '余额读缓存正确', stat?.pts);
  ok(stat && stat.rowTop === 2, '4 列 2 行排布', stat?.rowTop);
  ok(stat && !stat.overflowX, '商城无横向溢出');
  ok(stat && !stat.scrollY, '8 件商品一屏排完（不用滚动）', stat && `${stat.scrollY}`);
  ok(stat && stat.sideW >= 200, '右侧穿搭预览占位正常', stat?.sideW);
  ok(pageErrors.length === 0, '无页面异常', pageErrors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}
if (failures) process.exitCode = 1;
