// 道具图标新 PNG 的实际 HUD 效果截图探针（只截图，不改源码）
//   node tests/item_icon_shot.mjs
// 进道具赛 → 塞三件道具 → 拍 HUD。截图只调一次（swiftshader 下第二次 captureScreenshot 会挂死）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/icons-${stamp}`);
const port = 9680 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const out = path.resolve(process.env.OUT || 'shots/icons/hud-item-icons.jpg');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
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
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log('EXC', d.exception?.description?.slice(0, 300) || d.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1500);

  // 等主菜单
  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1000);

  // 选道具模式：先开模式抽屉，再点道具卡
  await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
  await sleep(700);
  const cards = await evaluate(`(() => [...document.querySelectorAll('[data-mode]')].map((e) => e.dataset.mode))()`);
  console.log('mode cards:', JSON.stringify(cards.result?.value));
  const picked = await evaluate(`(() => {
    const c = document.querySelector('[data-mode="item"]');
    if (!c) return 'missing';
    c.click(); return 'ok'; })()`);
  console.log('pick item:', picked.result?.value);
  await sleep(600);

  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!(window.__game && window.__game.items && window.__game.localBoat)')).result?.value) {
      ready = true; break;
    }
    await sleep(200);
  }
  if (!ready) throw new Error('没进到道具赛');

  // 把三格塞满：氮气瓶 / 深水炸弹 / 章鱼 —— 都是这次新图标里的
  const set = await evaluate(`(() => {
    const g = window.__game;
    g.items.myItems = ['nitro', 'bomb', 'octopus'];
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    return g.mode + '|' + g.items.myItems.join(','); })()`);
  console.log('items:', set.result?.value);
  await sleep(1800);

  const dom = await evaluate(`(() => {
    const bar = document.querySelector('#item-slots');
    return {
      barClass: bar?.className,
      slots: [...document.querySelectorAll('#item-slots .item-slot')].map((el) => ({
        name: el.querySelector('.item-name')?.textContent,
        img: el.querySelector('.item-icon img')?.getAttribute('src') || null,
        text: el.querySelector('.item-icon img') ? null : el.querySelector('.item-icon')?.textContent,
      })),
    }; })()`);
  console.log('dom:', JSON.stringify(dom.result?.value));

  // 开场镜头会隐藏整个 HUD，强制亮出来才能拍到道具栏
  const shown = await evaluate(`(() => {
    document.body.classList.remove('intro-on');
    const hud = document.querySelector('#hud');
    const bar = document.querySelector('#item-slots');
    hud?.classList.remove('hidden');
    bar?.classList.remove('hidden');
    const r = bar?.getBoundingClientRect();
    return {
      hudHidden: hud?.classList.contains('hidden'),
      barHidden: bar?.classList.contains('hidden'),
      display: bar ? getComputedStyle(bar).display : null,
      rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null,
    }; })()`);
  console.log('shown:', JSON.stringify(shown.result?.value));
  await sleep(700);

  await fs.mkdir(path.dirname(out), { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: false });
  await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('ok ->', out);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
