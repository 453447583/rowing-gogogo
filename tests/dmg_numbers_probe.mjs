// 伤害飘字（霓虹电竞 C 方案）字表落地验收
//   node tests/dmg_numbers_probe.mjs
//
// 验六件事：
//   ① 逐字拼：N 位数字 = N 个 <img>，都指向 public/ui/dmg/ 下的 normal_/crit_
//   ② 尺寸：普通墨迹 ≈16px、暴击 ≈22px（对齐旧版 22px / 30px 字号的可见高，不跟屏高走）
//   ③ 小怪档：scale=0.75 时比 BOSS 小（≈12px）
//   ④ 倾斜：**向右倒**（素材本身向左 10.9°，靠 CSS 斜切扳正）——按像素斜率验
//   ⑤ 容量 + 生命周期：连跳 20 次不无限堆、动画完自动回收；DPR≥1.5 换 @2x 尺寸不变
//   ⑥ 暴击：独立爆裂框，数字上没有 text-shadow / filter（字表铁律）
//
// 产物：shots/verify/dmg-numbers.png（亮底总览）、dmg-numbers-crit.png（暴击特写）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import sharp from 'sharp';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/dmg-' + Date.now());
const port = 9411;
const httpPort = 5209;
const shots = path.resolve('shots/verify');

// 1) 起 vite dev：模块要走源码，build 产物会晚一步
const dev = spawn(process.execPath, [
  path.resolve('node_modules/vite/bin/vite.js'), '--port', String(httpPort), '--strictPort',
], { stdio: 'ignore', cwd: path.resolve('.') });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = false;
for (let i = 0; i < 150 && !ok; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${httpPort}/tests/dmg_numbers_page.html`);
    ok = r.ok;
  } catch {}
  if (!ok) await wait(200);
}
if (!ok) { dev.kill('SIGKILL'); throw new Error('vite dev 没起来（端口 ' + httpPort + '）'); }

// 2) 无头 Edge：要真 GPU，否则 WAAPI + 透明合成会糊成一团
const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720',
  `http://127.0.0.1:${httpPort}/tests/dmg_numbers_page.html`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, timeout = 60000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r?.result?.value;
};

const fails = [];
const check = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  else { fails.push(label); console.log('  ✗ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

/** 截一张整页图，返回 { buf, scale }（无头抓图是 1088 宽，要按比例换回 CSS 像素） */
const shotPage = async () => {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data, 'base64');
  const meta = await sharp(buf).metadata();
  return { buf, scale: meta.width / 1280 };
};

/** 量「亮墨迹」的左右中轴斜率：正 = 顶边偏右（右倾），负 = 左倾 */
const measureSlope = async (buf, rect, shotScale, useAlpha = false, whole = false) => {
  const pad = 6;
  const img = sharp(buf);
  const { data, info } = await (whole ? img : img.extract({
    left: Math.max(0, Math.round(rect.x * shotScale) - pad),
    top: Math.max(0, Math.round(rect.y * shotScale) - pad),
    width: Math.round(rect.w * shotScale) + pad * 2,
    height: Math.round(rect.h * shotScale) + pad * 2,
  }))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lum = (x, y) => {
    const i = (y * info.width + x) * 4;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  const rows = [];
  for (let y = 0; y < info.height; y++) {
    let mn = 1e9; let mx = -1;
    for (let x = 0; x < info.width; x++) {
      const hit = useAlpha ? data[(y * info.width + x) * 4 + 3] > 40 : lum(x, y) > 110;
      if (hit) { if (x < mn) mn = x; if (x > mx) mx = x; }
    }
    if (mx >= 0) rows.push({ y, c: (mn + mx) / 2 });
  }
  if (rows.length < 8) return { slope: 0, rows: rows.length };
  const span = rows[rows.length - 1].y - rows[0].y || 1;
  const at = (p) => rows[Math.min(rows.length - 1, Math.round(p * (rows.length - 1)))].c;
  return { slope: (at(0.15) - at(0.85)) / span, rows: rows.length };
};

try {
  let tabs = null;
  for (let i = 0; i < 100 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await wait(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.reject(new Error(m.error.message)); else q.resolve(m.result);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 无头窗真实视口只有 1088×546，必须显式改设备尺寸，否则坐标全偏
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  for (let i = 0; i < 80; i++) { if (await ev('!!window.__ready')) break; await wait(200); }
  check(await ev('!!window.__ready'), '模块加载完成');

  // ---------- ① 普通命中：四位数 ----------
  await ev(`window.__spawn({ value: 1280, crit: false, x: 330, y: 420 })`);
  await wait(140);
  const normal = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    const wraps = layer ? layer.children : [];
    const w = wraps[wraps.length - 1];
    if (!w) return JSON.stringify({ none: true });
    const imgs = [...w.querySelectorAll('img')];
    const r = w.getBoundingClientRect();
    return JSON.stringify({
      wraps: wraps.length,
      digits: imgs.length,
      h: parseFloat(w.style.height), w: r.width,
      cx: r.x + r.width / 2, cy: r.y + r.height / 2,
      shadows: imgs.map(i => getComputedStyle(i).textShadow).filter(s => s && s !== 'none').length,
      filters: imgs.map(i => getComputedStyle(i).filter).filter(f => f && f !== 'none').length,
      src: imgs[0]?.getAttribute('src') || '',
    });
  })()`));
  check(!normal.none, '普通命中生成了 DOM 节点');
  check(normal.digits === 4, '四位数 = 4 个 <img>（逐字拼，不是一张整字）', { digits: normal.digits });
  check(/\/ui\/dmg\/normal_\d\.png$/.test(normal.src || ''), '用的是 normal 字表', { src: normal.src });
  // 板高 = 墨迹 20px / 0.963（素材留白比例）
  check(Math.abs(normal.h - 20.8) < 1.2, '普通字板高 ≈20px（对齐旧版 22px 字号的视觉占位）', { h: +normal.h.toFixed(1) });
  // 旧版动画从 t=0 就往上升，140ms 时已经抬了一截，所以只断言「起点在命中点、只会往上」
  check(Math.abs(normal.cx - 330) < 3 && normal.cy <= 420 && normal.cy > 420 - 45,
    '数字以命中点为中心、只会往上飘（沿用旧版定位）', { cx: Math.round(normal.cx), cy: Math.round(normal.cy) });
  check(normal.shadows === 0 && normal.filters === 0, '数字上没有任何 text-shadow / filter（描边已烘进字）');

  // ---------- ② 暴击 ----------
  await ev(`window.__spawn({ value: 3480, crit: true, x: 760, y: 420 })`);
  await wait(140);
  const crit = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    const w = layer.children[layer.children.length - 1];
    const imgs = [...w.querySelectorAll('img')];
    const r = w.getBoundingClientRect();
    const burst = imgs.find(i => (i.getAttribute('src') || '').includes('crit_burst'));
    const br = burst ? burst.getBoundingClientRect() : null;
    return JSON.stringify({
      digits: imgs.filter(i => !(i.getAttribute('src') || '').includes('burst')).length,
      burst: !!burst,
      burstW: br ? br.width : 0,
      critSrc: imgs[0]?.getAttribute('src') || '',
      h: parseFloat(w.style.height),
    });
  })()`));
  check(crit.digits === 4, '暴击四位数 = 4 个字 + 1 个爆框', { digits: crit.digits });
  check(/\/ui\/dmg\/crit_\d\.png$/.test(crit.critSrc || ''), '用的是 crit 字表', { src: crit.critSrc });
  check(crit.burst && crit.burstW > 0, '爆裂框是独立一层且有尺寸', { w: Math.round(crit.burstW) });
  check(Math.abs(crit.h - 28) < 1.5, '暴击字板高 ≈28px（对齐旧版 30px 字号）', { h: +crit.h.toFixed(1) });

  // ---------- ③ 小怪档 ----------
  await ev(`window.__spawn({ value: 17, crit: false, x: 980, y: 620, scale: 0.75 })`);
  await wait(130);
  const mini = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    const w = layer.children[layer.children.length - 1];
    return JSON.stringify({ h: parseFloat(w.style.height) });
  })()`));
  check(Math.abs(mini.h - 20.8 * 0.75) < 1.2, '小怪数字比 BOSS 小一号（≈0.75）', { h: +mini.h.toFixed(1) });

  // ---------- ⑤ 容量 ----------
  await ev(`(function(){
    for (let i = 0; i < 20; i++) window.__spawn({ value: 100 + i, crit: false, x: 640, y: 300 });
    return 1;
  })()`);
  // 被顶掉的那个还有 120ms 淡出，等过淡出窗口再数
  await wait(320);
  const pile = await ev(`document.getElementById('dmg-numbers').children.length`);
  check(pile <= 14, '全场飘字有上限（不会无限堆 DOM）', { n: pile });

  // ---------- ⑥ 生命周期 + 高分屏 ----------
  await wait(1400);
  const left = await ev(`document.getElementById('dmg-numbers')?.children.length || 0`);
  check(left === 0, '动画结束自动回收 DOM（不留节点）', { left });

  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 2, mobile: false,
  });
  await wait(120);
  await ev(`window.__spawn({ value: 4321, crit: false, x: 640, y: 400 })`);
  await wait(160);
  const hi = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    const w = layer.children[layer.children.length - 1];
    const img = w.querySelector('img');
    return JSON.stringify({
      dpr: window.devicePixelRatio,
      src: img.getAttribute('src'),
      h: parseFloat(w.style.height),
    });
  })()`));
  check(/@2x\.png$/.test(hi.src || ''), 'DPR≥1.5 时换 @2x 字表', { dpr: hi.dpr, src: hi.src });
  check(Math.abs(hi.h - 20.8) < 1.2, '@2x 下屏幕上尺寸不变（只是更清晰）', { h: +hi.h.toFixed(1) });
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });

  // ---------- 截图 ----------
  await fs.mkdir(shots, { recursive: true });
  await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    layer.innerHTML = '';
    window.__spawn({ value: 1280, crit: false, x: 300, y: 430 });
    window.__spawn({ value: 340,  crit: false, x: 620, y: 430 });
    window.__spawn({ value: 3480, crit: true,  x: 900, y: 430 });
    window.__spawn({ value: 27,   crit: false, x: 420, y: 640, scale: 0.75 });
    window.__spawn({ value: 651,  crit: false, x: 640, y: 640, scale: 0.75 });
    // 停在 30ms：这时透明度还接近 1，拍出来才是真实浓度（动画是大半程在淡出）
    for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 30; }
    return 1;
  })()`);
  await wait(150);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(shots, 'dmg-numbers.png'), Buffer.from(shot.data, 'base64'));
  console.log('   截图：shots/verify/dmg-numbers.png');

  // 暴击特写（放大 3 倍看清楚倾斜和爆框）
  await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    layer.innerHTML = '';
    window.__spawn({ value: 8888, crit: true, x: 640, y: 380, scale: 3 });
    for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 30; }
    return 1;
  })()`);
  await wait(150);
  const shot2 = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(shots, 'dmg-numbers-crit.png'), Buffer.from(shot2.data, 'base64'));
  console.log('   截图：shots/verify/dmg-numbers-crit.png');
  // ---------- ④ 倾斜方向：必须向右倒（放最后，因为要临时摘掉页面底色） ----------
  // 放大 6 倍跳在深色底上量「亮墨迹」左右中轴：源素材斜率是 -0.19（向左倒），
  // 补 20° 斜切后应该翻成正数。
  // 页面本身有渐变底，要先把 html/body 的底色摘掉，omitBackground 才有真正的 alpha
  await ev(`document.documentElement.style.background = 'none'; document.body.style.background = 'none'`);
  await cdp('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await ev(`(function(){
    document.getElementById('dmg-numbers').innerHTML = '';
    window.__spawn({ value: 1, crit: false, x: 640, y: 400, scale: 6 });
    const layer = document.getElementById('dmg-numbers');
    // 停在 40ms：这时还不透明、字形最亮，量斜率不会被淡出干扰
    for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 40; }
    return 1;
  })()`);
  await wait(120);
  const tiltRect = JSON.parse(await ev(`(function(){
    const w = document.getElementById('dmg-numbers').children[0];
    const r = w.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
  })()`));
  await wait(200);
  const tiltRaw = await cdp('Page.captureScreenshot', { format: 'png', omitBackground: true });
  const tiltShot = {
    buf: Buffer.from(tiltRaw.data, 'base64'),
    scale: (await sharp(Buffer.from(tiltRaw.data, 'base64')).metadata()).width / 1280,
  };
  const tilt = await measureSlope(tiltShot.buf, tiltRect, tiltShot.scale, true);
  // 和素材原始斜率比：同样的量法下素材是 -0.19，补 20° 斜切后应往正方向挪约 0.28
  const assetTilt = await measureSlope(path.resolve('public/ui/dmg/normal_1.png'), { x: 0, y: 0, w: 0, h: 0 }, 1, true, true);
  await fs.writeFile(path.join(shots, '_tilt_digit.png'), tiltShot.buf);
  await cdp('Emulation.setDefaultBackgroundColorOverride', {});
  check(tilt.slope > 0.03 && tilt.slope - assetTilt.slope > 0.2,
    '字是向右倒的（素材 -0.19 → 渲染后为正，且净挪了 20° 斜切那一段）',
    { rendered: +tilt.slope.toFixed(3), asset: +assetTilt.slope.toFixed(3), rows: tilt.rows });
  const skewC = await ev(`(function(){
    const img = document.querySelector('#dmg-numbers img');
    return new DOMMatrix(getComputedStyle(img).transform).c;
  })()`);
  check(Number(skewC) < -0.3, '每个字都带 -20° 斜切（矩阵 c 分量为负）', { c: +Number(skewC).toFixed(3) });
  await ev(`document.getElementById('dmg-numbers').innerHTML = ''`);

} finally {
  try { ws?.close(); } catch {}
  child.kill('SIGKILL');
  dev.kill('SIGKILL');
}

if (fails.length) {
  console.error('\nFAIL：' + fails.join(' / '));
  process.exit(1);
}
console.log('\n伤害飘字验收通过');
