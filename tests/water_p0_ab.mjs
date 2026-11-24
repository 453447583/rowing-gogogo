// P0 水面调参的 A/B 对比：把改前 / 改后同机位截图拼成一张，并对水面 ROI 算梯度能量
// （平均 |∇亮度|，数值越大 = 可见细节越多），避免"看个大概"。
//
//   node tests/water_p0_ab.mjs mid
//   node tests/water_p0_ab.mjs top
//   node tests/water_p0_ab.mjs low
//
// 依赖：dev server（5199）在跑，且 shots/water/before/<pose>.jpg 已存好基线。
// 出图：shots/water/ab-<pose>.jpg（左=改前，右=改后）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pose = process.argv[2] || 'mid';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-p0ab-${stamp}`);
const port = 9480 + (Number(stamp.slice(-3)) % 60);
const base = 'http://127.0.0.1:5199';
const before = `${base}/shots/water/before/${pose}.jpg`;
const after = `${base}/shots/water/ocean-day-${pose}.jpg`;
const out = path.resolve('shots', 'water', `ab-${pose}.jpg`);

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=800,600', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });

async function main() {
  let tabs;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { tabs = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  // 必须停在同源页面，canvas 才能读像素（跨域图会污染 canvas）
  await cdp('Page.navigate', { url: before });
  await sleep(2500);

  const expr = `(async () => {
    const load = (u) => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = () => rej(new Error('load ' + u));
      im.src = u + '?t=' + Date.now();
    });
    const A = await load(${JSON.stringify(before)});
    const B = await load(${JSON.stringify(after)});
    const W = A.naturalWidth, H = A.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W * 2 + 6; cv.height = H;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#000'; cx.fillRect(0, 0, cv.width, cv.height);
    cx.drawImage(A, 0, 0);
    cx.drawImage(B, W + 6, 0);

    // 水面 ROI：避开左侧太阳高光、浮标链与上方山体
    const roi = {
      x: Math.round(W * 0.44), y: Math.round(H * 0.58),
      w: Math.round(W * 0.38), h: Math.round(H * 0.18),
    };
    const stat = (img) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(roi.x, roi.y, roi.w, roi.h).data;
      const L = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      let sum = 0, n = 0;
      for (let y = 0; y < roi.h - 1; y++) {
        for (let x = 0; x < roi.w - 1; x++) {
          const i = (y * roi.w + x) * 4;
          sum += Math.hypot(Math.abs(L(i + 4) - L(i)), Math.abs(L(i + roi.w * 4) - L(i)));
          n++;
        }
      }
      let m = 0, k = 0;
      for (let i = 0; i < d.length; i += 4) { m += L(i); k++; }
      m /= k;
      let v = 0;
      for (let i = 0; i < d.length; i += 4) { const q = L(i) - m; v += q * q; }
      return { grad: +(sum / n).toFixed(3), mean: +m.toFixed(1), sd: +Math.sqrt(v / k).toFixed(2) };
    };
    return { dataUrl: cv.toDataURL('image/jpeg', 0.9), W, H, roi, before: stat(A), after: stat(B) };
  })()`;

  const r = await evaluate(expr);
  const v = r?.result?.value;
  if (!v?.dataUrl) {
    console.error('FAIL', JSON.stringify(r?.exceptionDetails?.exception?.description || r).slice(0, 300));
    return;
  }
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, Buffer.from(v.dataUrl.slice(v.dataUrl.indexOf(',') + 1), 'base64'));
  console.log('拼图 ->', path.basename(out), `${v.W}x${v.H}  ROI=${JSON.stringify(v.roi)}`);
  console.log('改前', JSON.stringify(v.before));
  console.log('改后', JSON.stringify(v.after));
  console.log('梯度能量 ×', (v.after.grad / Math.max(v.before.grad, 1e-6)).toFixed(2));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  process.exit();
});
