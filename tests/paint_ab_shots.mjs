// 船体涂装 A/B 出图（方案 B 轻量版）· 只截图，不改游戏源码
//   node tests/paint_ab_shots.mjs
// 产物：shots/paint_ab/1..7_*.png（默认 + 6 色）、8..9_*_multiply.png（旧乘算对照）
//       shots/paint_ab/sheet.png（7 张总览）、shots/paint_ab/compare.png（乘算 vs 换漆）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import sharp from 'sharp';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/paint-${stamp}`);
const port = 9900 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/preview/paint_ab.html';
const OUT = path.resolve('shots/paint_ab');

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 60000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(300);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

async function grab(jsExpr, file) {
  const r = await evaluate(jsExpr);
  const v = val(r);
  const b64 = String(v || '').split(',')[1];
  if (!b64) throw new Error('empty shot ' + file + ' -> ' + String(v).slice(0, 200));
  const out = path.join(OUT, file);
  await fs.writeFile(out, Buffer.from(b64, 'base64'));
  console.log('OK', out, (b64.length / 1365 | 0) + 'KB');
  return out;
}

const TITLES = ['① 原色 · 未涂装', '② 赤焰红', '③ 霜蓝', '④ 翡翠', '⑤ 紫电', '⑥ 金砂', '⑦ 潮青'];
const HEXES = ['', '#ff5a3c', '#6fc8ff', '#3fd08a', '#a86bff', '#f0c060', '#46e0d0'];
const FILES = ['1_default', '2_paint_red', '3_paint_blue', '4_paint_jade', '5_paint_violet', '6_paint_gold', '7_paint_tide'];

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
      console.log('EXC', (m.params.exceptionDetails.exception?.description || '').slice(0, 400));
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await sleep(1500);

  const meta = await waitFor(`(() => {
    const a = window.__paintAB;
    return a && a.ready ? { meshes: a.meshCount, mats: a.materialNames, n: a.variants.length } : 0;
  })()`, 60000);
  console.log('META', JSON.stringify(meta));

  await fs.mkdir(OUT, { recursive: true });
  const made = [];
  for (let i = 0; i < 7; i++) {
    await evaluate(`window.__paintAB.setVariant(${i}, 'shader'); 1`);
    await sleep(220);
    made.push(await grab(
      `window.__paintAB.shotLabeled(${JSON.stringify(TITLES[i])}, '方案B 着色器换漆 · 绯鲨号 boat_redcar.glb', ${JSON.stringify(HEXES[i])})`,
      FILES[i] + '.png',
    ));
  }

  // 旧乘算对照（源码现状 #applyPaint：整船 color.lerp(tint, 0.7)）
  const mult = [];
  for (const [i, f, t, h] of [[1, '8_paint_red_multiply', '赤焰红 · 旧乘算对照', '#ff5a3c'], [2, '9_paint_blue_multiply', '霜蓝 · 旧乘算对照', '#6fc8ff']]) {
    await evaluate(`window.__paintAB.setVariant(${i}, 'multiply'); 1`);
    await sleep(220);
    mult.push(await grab(
      `window.__paintAB.shotLabeled(${JSON.stringify(t)}, '现状 #applyPaint 材质乘算', ${JSON.stringify(h)})`,
      f + '.png',
    ));
  }

  // ---- 总览 4×2（最后一格放旧乘算对照，正好填满并形成对照） ----
  const sheetSrc = [...made, mult[1]];
  const tiles = await Promise.all(sheetSrc.map(async (f) => ({
    input: await sharp(f).resize(600).toBuffer(),
  })));
  const tw = 600; const th = await sharp(tiles[0].input).metadata().then((m) => m.height);
  const cols = 4, rows = Math.ceil(tiles.length / cols);
  await sharp({ create: { width: cols * tw, height: rows * th, channels: 3, background: '#0d1b24' } })
    .composite(tiles.map((t, i) => ({ input: t.input, left: (i % cols) * tw, top: Math.floor(i / cols) * th })))
    .png().toFile(path.join(OUT, 'sheet.png'));
  console.log('OK', path.join(OUT, 'sheet.png'));

  // ---- 乘算 vs 换漆 2×2 ----
  const pairs = [
    [mult[0], made[1]],
    [mult[1], made[2]],
  ];
  const pw = 700;
  const pimgs = [];
  for (const [a, b] of pairs) {
    pimgs.push(await sharp(a).resize(pw).toBuffer());
    pimgs.push(await sharp(b).resize(pw).toBuffer());
  }
  const ph = await sharp(pimgs[0]).metadata().then((m) => m.height);
  await sharp({ create: { width: pw * 2, height: ph * 2, channels: 3, background: '#0d1b24' } })
    .composite(pimgs.map((input, i) => ({ input, left: (i % 2) * pw, top: Math.floor(i / 2) * ph })))
    .png().toFile(path.join(OUT, 'compare.png'));
  console.log('OK', path.join(OUT, 'compare.png'));
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
}
child.kill();
setTimeout(() => process.exit(process.exitCode || 0), 300);
