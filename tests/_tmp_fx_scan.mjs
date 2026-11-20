// 临时探针：扫描候选特效的覆盖率曲线，判断是否"持续不断"以及形状/朝向
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9393;
const profile = path.resolve('D:/3dgame-tmp/browser/fx-scan-' + Date.now());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { name: 'fire01_08', url: '/effects/EffectMaterials/ef_fire01.efkefc', scale: 0.8 },
  { name: 'fire03_05', url: '/effects/EffectMaterials/ef_fire03.efkefc', scale: 0.5 },
  { name: 'wind01_08', url: '/effects/EffectMaterials/ef_wind01.efkefc', scale: 0.8 },
  { name: 'laser01_08', url: '/effects/Basic/Laser01.efkefc', scale: 0.8 },
];

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const outDir = path.resolve('shots/fxscan');
await fs.mkdir(outDir, { recursive: true });

let ws;
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    await wait(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  const js = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 720, height: 540, deviceScaleFactor: 1, mobile: false });

  for (const c of CASES) {
    const q = `fx=?&p=${encodeURIComponent(c.url)}&scale=${c.scale}${c.map ? '&map=1' : ''}`;
    await cdp('Page.navigate', { url: `http://127.0.0.1:5214/fx-preview.html?${q}` });
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) { ready = await js('!!window.__ready').catch(() => false); if (!ready) await wait(150); }
    if (!ready) { console.log(`${c.name}: LOAD FAIL`); continue; }
    const scan = await js('JSON.stringify(window.__scan(2200, 100, 9))');
    const curve = JSON.parse(scan) || [];
    const peak = Math.max(...curve.map((s) => s.cover), 0.0001);
    const line = curve.map((s) => `${s.t}:${(s.cover / peak).toFixed(2)}`).join(' ');
    // 取覆盖最高的一帧截图
    let best = curve[0];
    for (const s of curve) if (s.cover > best.cover) best = s;
    await js(`window.__freeze(${Math.round(best.t * 1000)}, 4)`);
    await wait(120);
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    await fs.writeFile(path.join(outDir, `${c.name}.jpg`), Buffer.from(shot.data, 'base64'));
    console.log(`${c.name}  bw=${best.bw} bh=${best.bh}\n  ${line}`);
  }
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  child.kill('SIGKILL');
}
