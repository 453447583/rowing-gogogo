// 大厅图标效果截图（只截图，不改源码）
//   PICK=mode|map|weather node tests/lobby_icons_shot.mjs
// 一次进程只截一张（swiftshader 下第二次 captureScreenshot 会挂死）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/lobby-icons-${stamp}`);
const port = 9720 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const pick = process.env.PICK || 'mode';
const out = path.resolve(process.env.OUT || `shots/icons/lobby-${pick}.jpg`);

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
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

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

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1200);

  const btn = { mode: '#btn-lobby-mode', map: '#btn-lobby-map', weather: '#btn-lobby-weather' }[pick];
  await evaluate(`document.querySelector(${JSON.stringify(btn)})?.click(); 1`);
  await sleep(1400);

  const dom = await evaluate(`(() => {
    const imgs = [...document.querySelectorAll('.lp-pill img, .lp-card img, .lp-boss-card img, #lobby-settings-drawer img')].slice(0, 14);
    // 抽屉是否需要滚动：8 张地图卡必须一屏排完（用户明确要求不要拖右边滚动条）
    const dr = document.getElementById('lobby-pick-drawer');
    const cards = [...document.querySelectorAll('.lp-card-map')];
    const drBox = dr ? dr.getBoundingClientRect() : null;
    const lastCard = cards.length ? cards[cards.length - 1].getBoundingClientRect() : null;
    return {
      btn: ${JSON.stringify(btn)},
      count: imgs.length,
      srcs: imgs.map((i) => i.getAttribute('src')),
      broken: imgs.filter((i) => i.naturalWidth === 0).map((i) => i.getAttribute('src')),
      scroll: dr ? { need: dr.scrollHeight - dr.clientHeight, sh: dr.scrollHeight, ch: dr.clientHeight } : null,
      cards: cards.length,
      cardH: cards.length ? +cards[0].getBoundingClientRect().height.toFixed(1) : null,
      lastFits: !!(drBox && lastCard && lastCard.bottom <= drBox.bottom - 4),
    }; })()`);
  console.log('icons:', JSON.stringify(dom.result?.value));

  await fs.mkdir(path.dirname(out), { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: false });
  await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log('ok ->', out);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
