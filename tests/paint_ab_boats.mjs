// 8 艘船 × 3 关键色（+ 原色）涂装出图
//   node tests/paint_ab_boats.mjs            # 全部 8 艘
//   BOATS=skiff,titan node tests/paint_ab_boats.mjs
// 产物：shots/paint_ab/boats/<id>_<key>.png + shots/paint_ab/boats_sheet.png
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import sharp from 'sharp';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/pboats-${stamp}`);
const port = 9950 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/preview/paint_ab.html';
const OUT = path.resolve('shots/paint_ab/boats');

// 3 个关键色：暖（赤焰红）/ 冷（霜蓝）/ 金属（金砂）
const PICKS = [
  { i: 0, key: 'default', name: '原色', hex: '' },
  { i: 1, key: 'red', name: '赤焰红', hex: '#ff5a3c' },
  { i: 2, key: 'blue', name: '霜蓝', hex: '#6fc8ff' },
  { i: 5, key: 'gold', name: '金砂', hex: '#f0c060' },
];
const WANT = (process.env.BOATS || 'rower,skiff,falcon,titan,dolphin,vintage,longship,cow').split(',').map((s) => s.trim());

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

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
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(300);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

async function grab(jsExpr, file) {
  const v = val(await evaluate(jsExpr));
  const b64 = String(v || '').split(',')[1];
  if (!b64) throw new Error('empty shot ' + file + ' -> ' + String(v).slice(0, 200));
  const out = path.join(OUT, file);
  await fs.writeFile(out, Buffer.from(b64, 'base64'));
  return out;
}

try {
  let info;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXC', (m.params.exceptionDetails.exception?.description || '').slice(0, 300));
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await sleep(1500);
  await waitFor('!!(window.__paintAB && window.__paintAB.ready)', 90000);

  await fs.mkdir(OUT, { recursive: true });
  const rows = [];
  for (const boatId of WANT) {
    const meta = val(await evaluate(`window.__paintAB.setBoat(${JSON.stringify(boatId)})`));
    const name = (meta && meta.name) || boatId;
    console.log('BOAT', boatId, name, JSON.stringify(meta));
    const cells = [];
    for (const p of PICKS) {
      await evaluate(`window.__paintAB.setVariant(${p.i}, 'shader'); 1`);
      await sleep(180);
      const f = `${boatId}_${p.key}.png`;
      cells.push(await grab(
        `window.__paintAB.shotLabeled(${JSON.stringify(`${name} · ${p.name}`)}, ${JSON.stringify(boatId + ' · ' + p.key)}, ${JSON.stringify(p.hex)})`,
        f,
      ));
    }
    rows.push({ boatId, name, cells });
  }

  // 总览：每艘一行 4 格
  const TW = 470;
  const tileBufs = [];
  for (const r of rows) for (const f of r.cells) tileBufs.push(await sharp(f).resize(TW).toBuffer());
  const th = await sharp(tileBufs[0]).metadata().then((m) => m.height);
  await sharp({
    create: { width: TW * 4, height: th * rows.length, channels: 3, background: '#0d1b24' },
  }).composite(tileBufs.map((input, i) => ({
    input, left: (i % 4) * TW, top: Math.floor(i / 4) * th,
  }))).png().toFile(path.resolve('shots/paint_ab/boats_sheet.png'));
  console.log('OK', path.resolve('shots/paint_ab/boats_sheet.png'));
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
}
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);
