// 临时工具：按「像素矩形」裁剪两张 HUD 截图并并排放大，用于比对面板材质细节。
//   RECTS='{"cur":[0,0,240,260],"ref":[0,0,540,590]}' A=xxx.jpg B=yyy.jpg OUTP=zzz.png node tests/_crop_zoom.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/crop-${stamp}`);
const port = 9660 + (Number(stamp.slice(-3)) % 30);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';

const IMGS = [
  { key: 'cur', src: process.env.A || 'C:\\Users\\94831\\.workbuddy\\clipboard-images\\clipboard-2026-11-16T02-56-15-628Z-13a3d877.jpg' },
  { key: 'ref', src: process.env.B || 'C:\\Users\\94831\\.workbuddy\\clipboard-images\\clipboard-2026-11-16T02-56-15-633Z-50c48ce0.jpg' },
];
const RECTS = JSON.parse(process.env.RECTS || '{"cur":[0,0,240,260],"ref":[0,0,540,590]}');
const OUTP = process.env.OUTP || 'shots/_tmp/zoom.png';

await fs.mkdir('shots/_tmp', { recursive: true });
for (const it of IMGS) await fs.copyFile(it.src, path.join('shots/_tmp', `${it.key}.jpg`));

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=900x600', base,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 60000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let info;
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  if (!info) throw new Error('cdp not ready');
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable');
  await sleep(500);

  const expr = `(async () => {
    const IMGS = ${JSON.stringify(IMGS.map((i) => ({ key: i.key, url: '/shots/_tmp/' + i.key + '.jpg' })))};
    const RECTS = ${JSON.stringify(RECTS)};
    const L1 = ${JSON.stringify(process.env.L1 || '改动后')};
    const L2 = ${JSON.stringify(process.env.L2 || '参考图')};
    const SAMPLE = ${JSON.stringify(process.env.SAMPLE || '')};
    const load = (u) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = u; });
    const ims = {};
    for (const it of IMGS) ims[it.key] = await load(it.url);
    if (SAMPLE) {
      const im = ims.cur;
      const cv0 = document.createElement('canvas');
      cv0.width = im.naturalWidth; cv0.height = im.naturalHeight;
      const g0 = cv0.getContext('2d');
      g0.drawImage(im, 0, 0);
      const out = SAMPLE.split(';').map((s) => {
        const [x, y] = s.split(',').map(Number);
        const d = g0.getImageData(x, y, 1, 1).data;
        return x + ',' + y + ' = rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')';
      });
      return { ok: true, samples: out };
    }
    const TARGET = 620;
    const cols = ['cur', 'ref'].map((k) => {
      const [x, y, w, h] = RECTS[k];
      const s = TARGET / w;
      return { k, x, y, w, h, ow: TARGET, oh: Math.round(h * s) };
    });
    const pad = 10, labelH = 22;
    const maxH = Math.max(...cols.map((c) => c.oh));
    const totalW = pad * 3 + TARGET * 2;
    const totalH = pad + maxH + labelH + pad;
    const cv = document.createElement('canvas');
    cv.width = totalW; cv.height = totalH;
    const c2 = cv.getContext('2d');
    c2.fillStyle = '#0e0e0e'; c2.fillRect(0, 0, totalW, totalH);
    c2.font = 'bold 15px sans-serif'; c2.textBaseline = 'top';
    cols.forEach((c, i) => {
      const x = pad + i * (TARGET + pad);
      c2.fillStyle = i === 0 ? '#8bd0ff' : '#ffd08b';
      c2.fillText(i === 0 ? (L1) : (L2), x, pad);
      c2.imageSmoothingEnabled = true;
      c2.drawImage(ims[c.k], c.x, c.y, c.w, c.h, x, pad + labelH, c.ow, c.oh);
    });
    return { ok: true, data: cv.toDataURL('image/png') };
  })()`;
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
  if (r.result.value.samples) { console.log(r.result.value.samples.join('\n')); return; }
  const b64 = String(r.result.value.data).split(',')[1];
  await fs.writeFile(path.resolve(OUTP), Buffer.from(b64, 'base64'));
  console.log('OK', OUTP);
}

try { await main(); } catch (e) { console.error('FAIL', e.message); }
child.kill();
process.exit(0);
