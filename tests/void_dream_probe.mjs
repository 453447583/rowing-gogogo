// 童话幻境视觉探针：进单人道具赛，直接置本地 voidTimer 触发幻境，多时刻截图。
//   WB_URL=http://127.0.0.1:5199/ node tests/void_dream_probe.mjs
// 只读验证，不改源码。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/void-dream-${stamp}`);
const port = 9940 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 120000) {
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
const val = (r) => r.result?.value;

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function shot(name) {
  const dataUrl = val(await evaluate(`(() => {
    const g = window.__game;
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) throw new Error('截图失败 ' + name);
  await fs.writeFile(path.resolve(`shots/verify/${name}.jpg`), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  console.log('ok ->', name);
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
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (val(await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")'))) break;
    await sleep(250);
  }
  // 单人道具赛：大厅模式卡选 items
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1200);
  for (let i = 0; i < 12; i++) {
    await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
    await sleep(700);
    if (val(await evaluate('!!document.querySelector(".lp-pill[data-mode]")'))) break;
  }
  const modePicked = val(await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-pill[data-mode]')].find((x) => x.dataset.mode === 'item');
    c?.click(); return !!c;
  })()`));
  console.log('item mode picked:', modePicked);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (val(await evaluate(`!!(window.__game && window.__game.items && window.__game.localBoat && window.__game.phase === 'racing')`))) break;
    await sleep(300);
  }
  await evaluate(`(() => { const g=window.__game; g.intro=0; g.cinema=0; g.countdownLeft=0; return 1; })()`);
  await sleep(600);

  const st = val(await evaluate(`(() => { const g=window.__game; return {
    mode: g.mode, hasItems: !!g.items, phase: g.phase,
    localBoat: !!g.localBoat, myId: g.items?.myId,
  }; })()`));
  console.log('state:', JSON.stringify(st));

  // 正常画面
  await shot('void-0-normal');

  // 触发幻境：直接置本地 voidTimer / voidLen（走与真实命中相同的 #updateVoidWorld）
  await evaluate(`(() => {
    const g = window.__game;
    g.items.voidLen = 3; g.items.voidTimer = 3;
    g.localBoat.voidTimer = 3;
    return 1;
  })()`);
  await sleep(400);  // 淡入中
  await shot('void-1-fadein');
  await sleep(800);  // 稳态
  await shot('void-2-steady');
  await sleep(1000); // 稳态后期
  await shot('void-3-late');

  // 查询 CSS 幻境层状态
  const w = val(await evaluate(`(() => {
    const it = window.__game.items;
    const el = document.getElementById('void-dream');
    if (!el) return { err: 'no element' };
    return {
      voidTimer: +it.voidTimer.toFixed(2), voidLen: it.voidLen,
      hasHidden: el.classList.contains('hidden'),
      hasShow: el.classList.contains('show'),
      opacity: getComputedStyle(el).opacity,
      zIndex: getComputedStyle(el).zIndex,
    };
  })()`));
  console.log('voidDream:', JSON.stringify(w));

  // CSS 遮罩层不受 3D screenshot 影响：用 CDP 截整屏（含 CSS 层）另存一张
  const pageShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90, captureBeyondViewport: false });
  await fs.writeFile(path.resolve('shots/verify/void-4-css-layer.jpg'), Buffer.from(pageShot.data, 'base64'));
  console.log('ok -> void-4-css-layer');

  // 计时结束后应自动收起幻境，回到赛道
  await evaluate(`(() => { const it = window.__game.items; it.voidTimer = 0.01; return 1; })()`);
  await sleep(900);
  const after = val(await evaluate(`(() => {
    const el = document.getElementById('void-dream');
    return { hidden: el.classList.contains('hidden'), show: el.classList.contains('show'),
             opacity: getComputedStyle(el).opacity };
  })()`));
  console.log('afterExpire:', JSON.stringify(after));
  const afterShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: false });
  await fs.writeFile(path.resolve('shots/verify/void-5-restored.jpg'), Buffer.from(afterShot.data, 'base64'));
  console.log('ok -> void-5-restored');
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
