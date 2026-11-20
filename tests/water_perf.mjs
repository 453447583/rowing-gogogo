// 真机帧时间探针（核显 Iris Xe 上量水面的填充率代价）
//
//   node tests/water_perf.mjs
//   SIZE=2880x1800 node tests/water_perf.mjs      # 满屏最坏情况
//   MAP=baked node tests/water_perf.mjs
//
// 和 water_ab.mjs 的区别：那个拍图（走 CPU 软光栅也行），这个**必须真 GPU**
// （不加 --disable-gpu），测的是 requestAnimationFrame 的实际间隔。
//
// 顺便把"水面这一层单独占多少"量出来：把 water.mesh 隐藏再测一遍，
// 差值就是水面的填充率成本 —— 计划加平面反射时靠它估代价。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/perf-${stamp}`);
const port = 9640 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const size = process.env.SIZE || '1440x900';
const mapId = process.env.MAP || 'ocean';
const FRAMES = Number(process.env.FRAMES || 240);

const child = spawn(edge, [
  '--headless=new', '--no-sandbox',
  '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${size}`, url,
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

// 页面内测 GPU 帧成本。
// rAF 间隔会被 vsync 钉在 16.7ms（60fps），**量不出余量**——所以改用
// "post.render 循环 + readPixels 强制同步"：每帧结束读 1 个像素，管线必须跑完才返回。
// 这会牺牲管线重叠（比真实帧偏慢），但各配置之间可直接横向比。
const MEASURE = `window.__gpuBench = (k) => {
  const g = window.__game;
  const gl = g.renderer.getContext();
  const px = new Uint8Array(4);
  const once = () => { g.post.render(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
  for (let i = 0; i < 6; i++) once();            // 预热：着色器编译 + 首帧上传都在这里
  const samples = [];
  for (let i = 0; i < k; i++) {
    const t = performance.now(); once(); samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  return { p50: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2) };
}; 1`;

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
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 400));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 精确视口：--window-size 在 headless=new 下会被窗口装饰/缩放影响，
  // 实测 innerWidth 只有 1029。用 deviceMetricsOverride 钉死，drawSize 才等于我们指定的值。
  const [vw, vh] = size.split('x').map(Number);
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: vw, height: vh, deviceScaleFactor: 1, mobile: false,
  });
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-card[data-map]')].find(x => x.dataset.map === ${JSON.stringify(mapId)});
    c?.click(); return 1; })()`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ok = false;
  while (Date.now() - t2 < 60000) {
    if ((await evaluate('!!window.__game && !!window.__game.track')).result?.value) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) throw new Error('对局没起来');
  await evaluate(`(() => { const g = window.__game;
    if (g?.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    if (g) { g.phase = 'racing'; g.countdownLeft = 0; } return 1; })()`);
  await sleep(Number(process.env.WARM || 18000));
  await evaluate(MEASURE);

  const info2 = await evaluate(`(() => { const g = window.__game;
    const r = g.renderer; const v = r.getContext().getParameter(r.getContext().VERSION);
    const dbg = r.getContext().getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: dbg ? r.getContext().getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?',
      gl: v, inner: [innerWidth, innerHeight], dpr: devicePixelRatio,
      drawSize: [r.domElement.width, r.domElement.height], quality: g.quality,
    }; })()`);
  console.log('env:', JSON.stringify(info2.result?.value));

  const runs = [];
  const shot = async (label) => {
    const r = await evaluate(`window.__gpuBench(${FRAMES})`);
    const v = r.result?.value;
    if (!v) { console.log(label, 'measure failed', JSON.stringify(r.exceptionDetails?.exception?.description)); return null; }
    const rec = { label, ...v };
    runs.push(rec);
    console.log(`${label.padEnd(20)} ${String(v.p50).padStart(7)} ms   预算 16.67ms 时余 ${(16.67 - v.p50).toFixed(2)} ms`);
    return rec;
  };

  await shot('全场景');
  // 水面单独成本：隐藏水面（连同 farSea 一起，它是 mesh 的子节点）
  await evaluate('window.__game.water.mesh.visible = false; 1');
  await sleep(400);
  const noWater = await shot('隐藏水面');
  await evaluate('window.__game.water.mesh.visible = true; 1');
  await sleep(400);
  // 环境反射单独的代价：关掉 uEnvOn（片元走回解析天空那条路径）
  await evaluate('window.__game.water.uniforms.uEnvOn.value = 0; 1');
  await sleep(400);
  const noEnv = await shot('关环境反射');
  await evaluate('window.__game.water.uniforms.uEnvOn.value = 1; 1');
  await sleep(400);
  const back = await shot('再开回来');       // 复测：估一下本机测量波动
  const total = runs[0];
  if (total && noWater) {
    const waterMs = total.p50 - noWater.p50;
    console.log(`\n水面这一层 ≈ ${waterMs.toFixed(2)} ms（占本帧 ${(waterMs / total.p50 * 100).toFixed(0)}%）`);
    if (noEnv) console.log(`其中环境反射 ≈ ${(total.p50 - noEnv.p50).toFixed(2)} ms（负值=在噪声内）`);
    if (back) console.log(`复测波动：${(back.p50 - total.p50).toFixed(2)} ms`);
    console.log(`再加一次半分辨率场景渲染（平面反射）粗估 +${(noWater.p50 * 0.25).toFixed(2)}～${(noWater.p50 * 0.4).toFixed(2)} ms`);
    console.log(`60fps 只剩 ${(16.67 - total.p50).toFixed(2)} ms 余量；120fps 需要 ≤ 8.33ms`);
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
