// 把 shots/fx_preview 的 4 帧截图拼成总览长图（file:// 打开，绕开 dev server 的目录缓存）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const DATA = [
  ['ef_fire01', '火焰 01', '持续燃烧柱'],
  ['ef_fire02', '火焰 02', '环形爆燃'],
  ['ef_fire03', '火焰 03', '火球飞行'],
  ['ef_holy01', '圣光', '垂直光柱'],
  ['ef_ice01', '冰 01', '冰锥穿刺'],
  ['ef_ice02', '冰 02', '冰冻爆裂'],
  ['ef_ice03', '冰 03', '冰晶生长'],
  ['ef_lightning01', '雷电 01', '单道落雷'],
  ['ef_lightning02', '雷电 02', '球状电弧'],
  ['ef_lightning03', '雷电 03', '多段连锁闪'],
  ['ef_parts_hit01', '打击 01', '轻命中'],
  ['ef_parts_hit02', '打击 02', '重命中'],
  ['ef_wind01', '风 01', '气流环'],
  ['ef_wind02', '风 02', '风刃'],
  ['ef_wind03', '风 03', '龙卷与地裂'],
];
const srcDir = process.argv[2] || 'shots/fx_preview';
const outPng = process.argv[3] || 'shots/fx_sheet.png';
const cols = 4;

const rows = DATA.map(([id, cn, desc]) => `
  <div class="row">
    <div class="name"><b>${cn}</b><span>${desc}</span><i>${id}</i></div>
    ${Array.from({ length: cols }, (_, i) => `<img src="../${srcDir.replace(/\\/g, '/')}/${id}_${i}.png">`).join('')}
  </div>`).join('');

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;background:#eef0f3;color:#1d2129;font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif}
.sheet{width:1000px;padding:20px 22px 22px}
h1{margin:0 0 3px;font-size:19px;font-weight:600}
.sub{margin:0 0 14px;font-size:12px;color:#6b7280}
.row{display:flex;align-items:center;gap:8px;padding:7px 9px;background:#fff;
border:1px solid #e1e4e8;border-radius:9px;margin-bottom:7px}
.name{width:118px;flex:none}
.name b{display:block;font-size:13px;font-weight:600}
.name span{font-size:11.5px;color:#6b7280}
.name i{display:block;font-size:10px;color:#a2a8b2;font-style:normal;margin-top:2px}
img{width:203px;height:152px;border-radius:5px;display:block;background:#0d1218}
</style></head><body><div class="sheet">
<h1>Effekseer EffectMaterials · 15 个特效</h1>
<p class="sub">官方 CC0 素材（KTK_kumamoto / Effekseer）· scale 0.75 · 自动取景 · 左→右为时间推进</p>
${rows}
</div></body></html>`;

const sheetPath = path.resolve('.tmp_fx_src/sheet.html');
await fs.writeFile(sheetPath, html, 'utf8');

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fx-sheet');
const port = 9271;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
async function waitJson(url, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('devtools timeout');
}
async function main() {
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.mkdir(path.dirname(outPng), { recursive: true });
  child = spawn(edge, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, '--allow-file-access-from-files',
    '--window-size=1040,1200', 'about:blank'], { stdio: 'ignore' });
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1040, height: 1200, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: pathToFileURL(sheetPath).href });
  await sleep(1600);
  const h = await cdp('Runtime.evaluate', { expression: 'document.body.scrollHeight', returnByValue: true });
  const H = h.result.value;
  const shot = await cdp('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1000, height: H, scale: 2 },
  });
  await fs.writeFile(outPng, Buffer.from(shot.data, 'base64'));
  console.log('saved', outPng, 'height', H);
}
main()
  .then(async () => { try { ws?.terminate(); } catch {} try { child.kill('SIGKILL'); } catch {} await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e.message); try { ws?.terminate(); } catch {} try { child.kill('SIGKILL'); } catch {} await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(1); });
