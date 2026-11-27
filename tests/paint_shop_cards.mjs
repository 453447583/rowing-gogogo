// 重出商店 6 张涂装卡面：用磐石号的真实模型离屏渲一遍，覆盖
// public/shop-assets/boat_d_*.png（原来那套素材是素材包里的「重装赛艇」，
// 8 艘里没有一艘长那样，卡面和实机对不上）。
//
//   node tests/paint_shop_cards.mjs
//
// 前置：dev server 5199（没起的话脚本自己拉一个，跑完关掉）。
// 旧图先备份到 .tmp_build/paint_cards_old/，后悔了直接拷回来。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { SHOP_ITEMS } from '../src/data/shop.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.resolve('.');
const OUT_DIR = path.join(ROOT, 'public/shop-assets');
const BAK_DIR = path.join(ROOT, '.tmp_build/paint_cards_old');
const BASE = process.env.WB_URL || 'http://127.0.0.1:5199/';
const cdpPort = 9940 + Math.floor(Math.random() * 20);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/paint-cards-' + Date.now());

const paints = SHOP_ITEMS.filter((it) => it.type === 'paint');

async function alive(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; }
}

let dev = null;
if (!(await alive(BASE))) {
  console.log('· dev server 未启动，先拉一个 5199');
  // 直接打 vite 的 bin：Windows 上 spawn('npx.cmd') 会 EINVAL，走 node + bin 最稳
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  dev = spawn(process.execPath, [viteBin, '--port', '5199', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, TEMP: path.join(ROOT, '.tmp_build'), TMP: path.join(ROOT, '.tmp_build') },
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(500); up = await alive(BASE); }
  if (!up) { dev.kill(); throw new Error('dev server 起不来'); }
}

fs.mkdirSync(BAK_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const child = spawn(edge, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', `${BASE}tests/paint_cards_page.html`,
  '--use-angle=d3d11', '--enable-gpu'], { stdio: 'ignore' });

let ws = null;
let wrote = 0;
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
  const errors = [];
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
      errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const ev = async (expression) => (await cdp('Runtime.evaluate', {
    expression: `(async function(){ try { return (${expression}); } catch(e){ return 'ERR:'+e.message; } })()`,
    returnByValue: true, awaitPromise: true,
  }))?.result?.value;

  let ready = false;
  for (let i = 0; i < 160 && !ready; i++) {
    ready = (await ev('!!window.__ready')) === true;
    if (!ready) await sleep(250);
  }
  if (!ready) throw new Error('渲染页没就绪：' + JSON.stringify(errors));

  for (const it of paints) {
    const url = await ev(`window.__card(${JSON.stringify(it.key)})`);
    if (typeof url !== 'string' || !url.startsWith('data:image/png')) {
      throw new Error(`${it.key} 渲染失败：${url}`);
    }
    const buf = Buffer.from(url.split(',')[1], 'base64');
    const name = path.basename(it.img);
    const dst = path.join(OUT_DIR, name);
    // 只在第一次覆盖前留底，重复跑不会把备份刷成新图
    if (fs.existsSync(dst) && !fs.existsSync(path.join(BAK_DIR, name))) {
      fs.copyFileSync(dst, path.join(BAK_DIR, name));
    }
    fs.writeFileSync(dst, buf);
    wrote += 1;
    console.log(`  ✓ ${it.key.padEnd(12)} → public/shop-assets/${name}  ${(buf.length / 1024).toFixed(0)} KB`);
  }
  if (errors.length) console.error('  页面异常：', errors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
  dev?.kill();
}
console.log(`完成：${wrote} 张（旧图备份在 .tmp_build/paint_cards_old/）`);
