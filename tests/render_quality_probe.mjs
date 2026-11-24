// 渲染清晰度诊断：真机跑一局单人练习，量画布像素尺寸 / 画质档 / 后处理 / 帧率并截图。
//   node tests/render_quality_probe.mjs
// 只在浏览器里读数，不改游戏源码。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const PORT = 5291;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/renderprobe-' + Date.now());
const cdpPort = 9700 + Math.floor(Math.random() * 80);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await vite.listen();
const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1400,860', `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 90000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const waitFor = async (expr, label, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
};
const shot = async (name) => {
  const res = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
  await fs.writeFile(path.join(out, name + '.jpg'), Buffer.from(res.data, 'base64'));
  console.log('  shot -> shots/verify/' + name + '.jpg');
};

const MEASURE = `(async () => {
  const s = await import('/src/settings.js');
  const g = window.__game;
  const r = g.renderer, p = g.post;
  const canvas = r.domElement;
  const gl = r.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const passes = p?.composer?.passes?.map((x) => x.constructor.name || 'custom') || [];
  const grade = p?.gradePass?.material?.uniforms || {};
  // 2.5 秒 rAF 实测帧时，去掉加载后的头几帧
  const frames = await new Promise((resolve) => {
    const t = []; let last = 0;
    const step = (now) => {
      if (last) t.push(now - last);
      last = now;
      if (now - t0 < 2500) requestAnimationFrame(step); else resolve(t.slice(3));
    };
    const t0 = performance.now();
    requestAnimationFrame(step);
  });
  frames.sort((a, b) => a - b);
  const avg = frames.reduce((a, b) => a + b, 0) / Math.max(1, frames.length);
  return {
    devicePixelRatio: window.devicePixelRatio,
    window: window.innerWidth + 'x' + window.innerHeight,
    settings: { quality: s.settings.get('quality'), renderScale: s.settings.get('renderScale'), autoQuality: s.settings.get('autoQuality'), showFps: s.settings.get('showFps') },
    runtimeQuality: g.quality,
    rendererPixelRatio: r.getPixelRatio(),
    canvasBacking: canvas.width + 'x' + canvas.height,
    canvasCss: Math.round(canvas.getBoundingClientRect().width) + 'x' + Math.round(canvas.getBoundingClientRect().height),
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    webgl2: r.capabilities.isWebGL2,
    postActive: !!p?.composer,
    passes,
    bloom: p?.bloomPass ? { strength: p.bloomPass.strength, radius: p.bloomPass.radius, threshold: p.bloomPass.threshold } : null,
    aa: p?.aaPass?.constructor?.name || null,
    grain: grade.uGrain?.value ?? null,
    vignette: grade.uVignette?.value ?? null,
    fps: Math.round(1000 / avg),
    frameMs: { avg: +avg.toFixed(1), median: +frames[Math.floor(frames.length / 2)].toFixed(1), p95: +frames[Math.floor(frames.length * 0.95)].toFixed(1) },
  };
})()`;

try {
  let list = null;
  for (let i = 0; i < 60 && !list; i++) {
    await sleep(400);
    list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json()).catch(() => null);
  }
  const page = list?.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到可调试页面');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 用 1080p 测，贴近用户窗口；DPR 1 = 大多数桌面显示器的真实情况
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Runtime.evaluate', { expression: 'location.reload()' });
  await sleep(1500);
  await waitFor(`!!document.querySelector('#btn-entry-solo')`, '入口页');
  await ev(`document.querySelector('#btn-entry-solo').click()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '大厅');
  await sleep(500);
  await ev(`document.querySelector('#btn-start-race').click()`);
  await waitFor(`!!window.__game && !!window.__game.renderer && !!window.__game.post`, '比赛渲染器');
  await sleep(6000); // 让新合成器 / SMAA 查找纹理和着色器完成预热

  const m = await ev(MEASURE);
  console.log('\n=== 当前渲染状态（1280x720, DPR=1, 单人练习） ===');
  console.log(JSON.stringify(m, null, 2));
  await shot('render-quality-current');

  // 对照量一次 100% 渲染分辨率，让 125% 超采样的性能代价有具体数字。
  // 无头环境里运行中重建合成器偶尔会丢 CDP 上下文，失败只记录、不影响主结果。
  try {
    await ev(`(async () => { const s = await import('/src/settings.js'); s.settings.set('renderScale', 1); return s.settings.get('renderScale'); })()`);
    await sleep(4000);
    const m100 = await ev(MEASURE);
    console.log('\n=== 100% 分辨率对照（同一场景） ===');
    console.log(JSON.stringify({ canvasBacking: m100.canvasBacking, rendererPixelRatio: m100.rendererPixelRatio, fps: m100.fps, frameMs: m100.frameMs }, null, 2));
  } catch (err) {
    console.log('\n（100% 对照在无头环境里没能测到：' + err.message + '）');
  }
  console.log('\n截图：render-quality-current.jpg（125% 超采样 + SMAA）');
} catch (e) {
  console.error('render probe FAIL', e.message);
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await vite.close().catch(() => {});
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
