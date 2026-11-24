// 生成主界面标题 logo（复刻参考图左上角标题 · 透明底 PNG）。
//   node scripts/make_menu_logo.mjs   → public/ui/menu-logo.png
//
// 口径（用户 2026-11-24 拍板："完全按照图上的左上角标题"）：
//   奶白 → 橙金的竖向渐变字面 + 深紫黑粗描边 + 斜体 + 右下硬阴影 + 字面里的水平切痕速度纹。
//   不要迷彩色块、不要背光（上一版被否）。
// 依然离线渲染成图片而不是 DOM 真字：CSS 描边在不同浏览器上会盖住渐变填充（发黑事故），
// 烘成 PNG 后任何机器显示一致；Noto Sans SC 900 是 OFL 许可，渲染结果可商用。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import sharp from 'sharp';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FONT = "'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif";
const TEXT = '激流勇进';

// ---------- 几何 ----------
const W = 1400; const H = 430; const F = 300; const X = 116; const Y = 330; const SKEW = -10;
const SW = 28;            // 深色描边（居中，向外露 ~14）
const SHADOW = { dx: 12, dy: 15, color: '#170710', opacity: .5 };  // 右下硬阴影

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字面里的水平切痕（参考图的"速度感"纹理）：亮奶金 + 少量深金细条，裁在字形内 */
function streaks(seed) {
  const r = rng(seed);
  let s = '';
  const yTop = Y - F * 0.80; const yBot = Y - 8;
  for (let k = 0; k < 9; k++) {
    const y = yTop + r() * (yBot - yTop);
    const h = 5 + r() * 9;
    const w = 130 + r() * 330;
    const x = 40 + r() * (W - w - 80);
    s += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="#FFF8DC" opacity="${(0.38 + r() * 0.3).toFixed(2)}"/>`;
  }
  for (let k = 0; k < 5; k++) {
    const y = yTop + r() * (yBot - yTop);
    const h = 4 + r() * 6;
    const w = 90 + r() * 240;
    const x = 40 + r() * (W - w - 80);
    s += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="${h.toFixed(0)}" fill="#DE8A3E" opacity="${(0.22 + r() * 0.16).toFixed(2)}"/>`;
  }
  return s;
}

const T = (attrs) => `<text x="${X}" y="${Y}" font-family="${FONT}" font-size="${F}" font-weight="900" letter-spacing="2" ${attrs}>${TEXT}</text>`;

function logoSvg() {
  const grad = `
    <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFCF0"/>
      <stop offset=".3" stop-color="#FFE9B4"/>
      <stop offset=".58" stop-color="#FFC75E"/>
      <stop offset=".85" stop-color="#FA9C43"/>
      <stop offset="1" stop-color="#EF7F35"/>
    </linearGradient>
    <mask id="body" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">
      <g transform="skewX(${SKEW})">${T('fill="#fff"')}</g>
    </mask>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" data-logo="sunset" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;overflow:visible">
  <defs>${grad}</defs>
  <g class="art">
    <g transform="skewX(${SKEW})">
      ${T(`x="${X + SHADOW.dx}" y="${Y + SHADOW.dy}" fill="${SHADOW.color}" fill-opacity="${SHADOW.opacity}" stroke="${SHADOW.color}" stroke-opacity="${SHADOW.opacity}" stroke-width="${SW}"`)}
      ${T(`fill="none" stroke="#1D0A18" stroke-width="${SW}" stroke-linejoin="round"`)}
      ${T('fill="url(#fill)"')}
    </g>
    <g mask="url(#body)">${streaks(20261124)}</g>
  </g>
</svg>`;
}

// ---------- 渲染 ----------
const tmp = path.resolve('D:/3dgame-tmp/logo/' + Date.now());
await fs.mkdir(tmp, { recursive: true });
const assetHtml = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style></head><body>${logoSvg()}</body></html>`;
await fs.writeFile(path.join(tmp, 'asset.html'), assetHtml);

const profile = path.resolve('D:/3dgame-tmp/browser/logo-' + Date.now());
const cdpPort = 9700 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(EDGE, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1500,900', 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 60000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const shotClip = async (clip) => Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })).data, 'base64');

try {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${cdpPort}/json`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      break;
    } catch { await sleep(500); }
  }
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable');
  await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });

  await cdp('Page.navigate', { url: 'file:///' + path.join(tmp, 'asset.html').replaceAll('\\', '/') });
  for (let i = 0; i < 100; i++) {
    if (await ev(`document.readyState === 'complete' && !!document.querySelector('[data-logo]')`).catch(() => false)) break;
    await sleep(200);
  }
  await ev(`document.fonts.ready.then(() => true)`);
  await sleep(400);

  const rect = await ev(`(() => { const r = document.querySelector('.art').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
  const pad = 6;
  const raw = await shotClip({ x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 1 });
  const out = await sharp(raw)
    .trim({ threshold: 1 })
    .extend({ top: 8, bottom: 8, left: 10, right: 10, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: true, quality: 92 })
    .toBuffer();
  const meta = await sharp(out).metadata();
  await fs.mkdir('public/ui', { recursive: true });
  await fs.writeFile('public/ui/menu-logo.png', out);
  console.log(`logo -> public/ui/menu-logo.png  ${meta.width}x${meta.height}  ${(out.length / 1024) | 0}KB`);
  console.log('DONE');
} catch (err) {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
} finally {
  try { await cdp('Browser.close'); } catch {}
  child.kill();
}
process.exit(process.exitCode || 0);
