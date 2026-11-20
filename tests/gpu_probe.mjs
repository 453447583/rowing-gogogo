// GPU 身份 + 合成负载基准：确认无头 Edge 有没有拿到真显卡（而不是 swiftshader）。
//
//   node tests/gpu_probe.mjs
//
// swiftshader（软件光栅）下测出来的帧时间没有参考价值 —— 它按 CPU 核数跑，
// 和核显的瓶颈（填充率 / EU 数量）完全不是一回事。所以测真机性能前先看这一行。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/gpu-${stamp}`);
const port = 9640 + (Number(stamp.slice(-3)) % 40);
// 关键：**不加 --disable-gpu**，让 headless=new 走 ANGLE/D3D11 拿真显卡
const child = spawn(edge, [
  '--headless=new', '--no-sandbox',
  '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1440x900',
  'about:blank',
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
  });
  await cdp('Runtime.enable');
  const r = await cdp('Runtime.evaluate', {
    returnByValue: true, awaitPromise: true,
    expression: `(async () => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?';
      const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : '?';
      // 合成负载：同样的片元量在 swiftshader 和真 GPU 上差 100 倍
      const W = 1440, H = 900;
      c.width = W; c.height = H;
      gl.viewport(0, 0, W, H);
      const vs = '#version 300 es\\nin vec2 p; void main(){ gl_Position = vec4(p,0,1); }';
      const fs = '#version 300 es\\nprecision highp float; out vec4 o; void main(){ float a=0.0; vec2 q=gl_FragCoord.xy*0.01; for(int i=0;i<180;i++){ a += sin(q.x*float(i)+a)*cos(q.y*float(i)-a); } o = vec4(a*0.001,0,0,1); }';
      const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); return sh; };
      const pr = gl.createProgram();
      gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(pr); gl.useProgram(pr);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.finish();
      const N = 40;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) { gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); }
      gl.finish();
      const ms = (performance.now() - t0) / N;
      return { vendor, renderer, msPerFrame: +ms.toFixed(2), fhdFps: +(1000 / ms).toFixed(0) };
    })()`,
  });
  const v = r.result?.value;
  console.log(JSON.stringify(v, null, 2));
  console.log(v && /swiftshader|software|basic render/i.test(v.renderer)
    ? '=> 软件光栅，帧时间不可参考'
    : '=> 真 GPU，帧时间可参考');
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
