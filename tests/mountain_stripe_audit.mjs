// 山脊「竖条拉伸」量化审计 —— 补上之前漏掉的验收判据
//
//   node tests/mountain_stripe_audit.mjs [图片...]
//
// 之前验收只查了"无接缝 / 无破面 / 色板 / 性能"，没有任何判据去抓
// 「贴图或阴影被纵向拉成长条」，所以带竖条的图也 PASS 了。这个脚本直接
// 读截图像素，在山体带里量两个方向的高频能量：
//   · stripe = 水平二阶差分 / 垂直二阶差分 —— 竖条会让它远大于 1
//   · colRow = 列均值方差 / 行均值方差 —— 竖条会让列间差异远大于行间
// 用二阶差分是为了压掉山脊轮廓这种低频大边缘，只留"拉丝"。
//
// 2026-11-15 补第二组判据：用户反馈"贴图几乎没有，太贫瘠了"，而旧版只查
// "不拉丝"，一块平滑灰板同样能 PASS。所以再加
//   · detail = 水平高频能量 —— 山体表面必须有可测的纹理细节
//   旧平滑版 2.17~2.49，烘了岩面浮雕后 3.96~4.10，阈值取 3.3。
// 暴雪/浓雾把整幅画面压成近白，垂直高频 <3.0 时比值全是量化噪声，单独跳过。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const files = process.argv.slice(2).length ? process.argv.slice(2) : [
  'shots/water/mtn-final-ocean-day-mountain-y0-base.jpg',
  'shots/water/mtn2-canyon-day-mountain-y0-base.jpg',
  'shots/water/mtn-fix-ocean-day-mountain-y0-base.jpg',
  'shots/water/mtn-fix-canyon-day-mountain-y0-base.jpg',
];
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/mtn-audit-' + Date.now());
const port = 9750 + Math.floor(Math.random() * 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };

const AUDIT = `(async (b64) => {
  const img = new Image();
  img.src = 'data:image/jpeg;base64,' + b64;
  await img.decode();
  const W = img.width, H = img.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  // 山体带：避开天空和水面
  const y0 = Math.round(H * 0.28), y1 = Math.round(H * 0.50);
  const x0 = Math.round(W * 0.02), x1 = Math.round(W * 0.98);
  const lum = (x, y) => {
    const k = (y * W + x) * 4;
    return 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
  };
  let sx = 0, sy = 0, nx = 0, ny = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0 + 1; x < x1 - 1; x++) {
      sx += Math.abs(lum(x + 1, y) - 2 * lum(x, y) + lum(x - 1, y)); nx++;
    }
  }
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = x0; x < x1; x++) {
      sy += Math.abs(lum(x, y + 1) - 2 * lum(x, y) + lum(x, y - 1)); ny++;
    }
  }
  const ex = sx / nx, ey = sy / ny;
  // 列均值 / 行均值的离散度
  const colM = [], rowM = [];
  for (let x = x0; x < x1; x++) {
    let s = 0; for (let y = y0; y < y1; y++) s += lum(x, y);
    colM.push(s / (y1 - y0));
  }
  for (let y = y0; y < y1; y++) {
    let s = 0; for (let x = x0; x < x1; x++) s += lum(x, y);
    rowM.push(s / (x1 - x0));
  }
  const variance = (a) => { const m = a.reduce((p, q) => p + q, 0) / a.length;
    return a.reduce((p, q) => p + (q - m) * (q - m), 0) / a.length; };
  const vc = variance(colM), vr = variance(rowM);
  return { W, H, roi: [x0, y0, x1, y1], horizEnergy: +ex.toFixed(3), vertEnergy: +ey.toFixed(3),
    stripe: +(ex / Math.max(1e-6, ey)).toFixed(3),
    colVar: +vc.toFixed(1), rowVar: +vr.toFixed(1),
    colRow: +(vc / Math.max(1e-6, vr)).toFixed(3) };
})`;

try {
  const tabs = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) return r.json(); } catch {}
      await sleep(150);
    }
    throw new Error('devtools timeout');
  })();
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Runtime.enable');
  console.log('山脊竖条审计（ROI = 图片 28%~50% 高度的山体带）');
  const out = [];
  for (const f of files) {
    let b64;
    try { b64 = (await fs.readFile(f)).toString('base64'); }
    catch { console.log('  跳过（文件不存在）:', f); continue; }
    const r = await cdp('Runtime.evaluate', {
      expression: AUDIT + '(' + JSON.stringify(b64) + ')',
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    const v = r.result.value;
    out.push({ file: path.basename(f), ...v });
    console.log(`  ${path.basename(f).padEnd(46)} stripe=${String(v.stripe).padStart(7)}`
      + `  colRow=${String(v.colRow).padStart(7)}  detail=${String(v.horizEnergy).padStart(6)}`
      + `  (水平高频 ${v.horizEnergy} / 垂直高频 ${v.vertEnergy})`);
  }
  // 旧拉丝图 stripe 1.01~1.11 / colRow 2.34~2.65；旧平滑版 detail 2.17~2.49；
  // 烘焙岩面浮雕后 stripe 0.64~0.67 / colRow 1.50~1.99 / detail 3.96~4.10。
  const bad = [];
  for (const v of out) {
    if (v.vertEnergy < 3.0) {
      v.verdict = 'SKIP: 低对比度天气（整幅近白，量化比值不可信）';
      console.log(`    ↳ ${v.file}: ${v.verdict}`);
      continue;
    }
    if (v.stripe > 0.85 || v.colRow > 2.2) bad.push(`${v.file}: 纵向拉丝`);
    if (v.horizEnergy < 3.3) bad.push(`${v.file}: 贴图贫瘠(detail=${v.horizEnergy})`);
  }
  console.log(bad.length ? `  => 检出 ${bad.length} 项不合格:\n     ${bad.join('\n     ')}`
    : '  => 全部合格：无纵向拉丝(stripe<=0.85, colRow<=2.2)，贴图有细节(detail>=3.3)');
  if (bad.length) process.exitCode = 1;
  await fs.mkdir('.tmp_build', { recursive: true });
  await fs.writeFile('.tmp_build/mountain_stripe.json', JSON.stringify(out, null, 2));
} catch (e) {
  console.error('mountain stripe audit FAIL:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
