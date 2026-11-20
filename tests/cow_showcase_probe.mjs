// 大厅展示台单帧对照：只在 1360×800 下拍牛来号的展示台（和最早那张 02-showcase 同尺寸对比），
// 顺便把展示台里模型的世界包围盒量出来（判断 fitTo:'height' 有没有被动画/克隆覆盖）。
// 用法：node tests/cow_showcase_probe.mjs [baseUrl]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cow-show-' + Date.now());
const port = 9860 + Math.floor(Math.random() * 40);
const outDir = 'shots/verify/cow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fs.mkdir(outDir, { recursive: true });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1360,800', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + m)); } }, 30000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
  });
};
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const shot = async (name) => {
  const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  await fs.writeFile(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  console.log('  shot →', path.join(outDir, name));
};
const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

try {
  let tabs = null;
  for (let i = 0; i < 80 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  for (let i = 0; i < 90; i++) {
    if (await evaluate(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`)) break;
    await sleep(300);
  }
  await evaluate(`document.querySelector('#btn-solo').click()`);
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`!!document.querySelector('#btn-lobby-boat')?.offsetParent`)) break;
    await sleep(250);
  }
  await evaluate(`document.querySelector('#btn-lobby-boat').click()`);
  await sleep(700);
  await evaluate(`document.querySelector('[data-boat="cow"]').click()`);
  await sleep(3000);
  await evaluate(`document.querySelector('#lobby-pick-drawer')?.classList.remove('open')`);
  await sleep(1200);

  // 等模型就位（GLB 2MB，且入口弹跳要 0.48s）
  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!window.__showcase?.model`)) break;
    await sleep(300);
  }
  await sleep(6000); // 软件渲染只有 1~2fps：入场弹跳按帧算，墙钟得多等几秒才跑完
  const info = await evaluate(`(() => {
    const sc = window.__showcase;
    if (!sc) return { hasShowcase: false };
    if (!sc.model) return { hasShowcase: true, boatId: sc.boatId, model: false };
    let bb = null;
    sc.model.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      bb = bb ? bb.union(b) : b;
    });
    return {
      hasShowcase: true,
      boatId: sc.boatId,
      modelScale: +sc.model.scale.x.toFixed(3),
      baseScale: +sc.model.userData.baseScale?.toFixed(3),
      worldHeight: bb ? +(bb.max.y - bb.min.y).toFixed(2) : null,
      minY: bb ? +bb.min.y.toFixed(2) : null,
      hasMixer: !!sc.model.userData.mixer,
    };
  })()`);
  console.log('SHOWCASE', JSON.stringify(info));
  await shot('30-showcase-1360.jpg');
} finally {
  await cleanup();
}
