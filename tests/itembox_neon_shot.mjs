// 道具箱新外观 + 拾取破碎效果（只截图，不改源码）
//   node tests/itembox_neon_shot.mjs
// 用 g.post.render() + toDataURL 取图（swiftshader 下 captureScreenshot 只能一次）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/itembox-${stamp}`);
const port = 9760 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const outDir = path.resolve(process.env.OUT || 'shots/icons');

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
  await sleep(1000);
  await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
  await sleep(700);
  await evaluate('document.querySelector(\'[data-mode="item"]\')?.click(); 1');
  await sleep(600);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 90000) {
    if ((await evaluate('!!(window.__game && window.__game.items && window.__game.items.boxField)')).result?.value) {
      ready = true; break;
    }
    await sleep(200);
  }
  if (!ready) throw new Error('没进到道具赛');

  await fs.mkdir(outDir, { recursive: true });

  // ---- 第一张：新外观 ----
  const shot1 = await evaluate(`(() => {
    const g = window.__game;
    const f = g.items.boxField, bs = g.items.boxes;
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    if (g.cameraRig) g.cameraRig.follow = () => {};
    // 找一个还在的箱子
    let idx = bs.findIndex((b) => b && b.active !== false);
    if (idx < 0) idx = 0;
    const b = bs[idx];
    const y = f.prevPos?.[idx]?.y || 1.6;
    g.phase = 'countdown'; g.countdownLeft = 999;   // 冻住倒计时，别让比赛推进
    g.camera.position.set(b.x + 4.6, y + 1.9, b.z + 4.6);
    g.camera.lookAt(b.x, y, b.z);
    g.camera.updateMatrixWorld(true);
    g.post.render(1 / 60);
    return { data: g.renderer.domElement.toDataURL('image/jpeg', 0.88), box: [b.x, y, b.z], idx };
  })()`);
  const v1 = shot1.result?.value || {};
  if (!v1.data) throw new Error('第一张没取到');
  await fs.writeFile(path.join(outDir, 'itembox-neon.jpg'), Buffer.from(v1.data.split(',')[1], 'base64'));
  console.log('box at', JSON.stringify(v1.box), 'idx', v1.idx);

  // ---- 第二张：炸开后的碎片 ----
  const shot2 = await evaluate(`(() => {
    const g = window.__game;
    const f = g.items.boxField, bs = g.items.boxes;
    const b = bs[${Number(v1.idx) || 0}];
    const y = f.prevPos?.[${Number(v1.idx) || 0}]?.y || 1.6;
    // 不手动 burst：让 update() 靠 prevAlive 1→0 自动触发，和游戏里完全同一条路径
    b.active = false;                            // 模拟被吃掉：箱子消失、只剩碎片
    // 手动推进 0.48s：碎片炸开、开始往水面落
    const t0 = f.time || 0;
    for (let i = 1; i <= 16; i++) f.update(t0 + i * 0.03, bs);
    // 同排相邻的箱子还在（游戏里本来就该在），只留碎片好判断破碎效果
    const hid = [f.panels, f.frames, f.marks, f.rivets, f.points, f.shadows].filter(Boolean);
    for (const m of hid) m.visible = false;
    g.camera.position.set(b.x + 5.2, y + 1.4, b.z + 5.2);
    g.camera.lookAt(b.x, y - 0.6, b.z);
    g.camera.updateMatrixWorld(true);
    g.post.render(1 / 60);
    const data = g.renderer.domElement.toDataURL('image/jpeg', 0.88);
    for (const m of hid) m.visible = true;
    const live = f.debrisState.filter((d) => d.life > 0).length;
    return { data, made: live, live };
  })()`);
  const v2 = shot2.result?.value || {};
  if (!v2.data) throw new Error('第二张没取到');
  await fs.writeFile(path.join(outDir, 'itembox-burst.jpg'), Buffer.from(v2.data.split(',')[1], 'base64'));
  console.log('burst made', v2.made, 'live', v2.live);
  console.log('ok ->', outDir);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
