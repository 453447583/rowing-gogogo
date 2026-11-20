// Effekseer 素材预览截图：扫描覆盖率曲线 → 自动取景 → 按曲线选 4 个代表性时刻
// 用法: node shot_fx.mjs [fx1,fx2,...] [--scale=0.75] [--out=shots/fx_preview] [--base=http://127.0.0.1:3112/]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const listArg = argv.find((a) => !a.startsWith('--'));
const opt = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const NAMES = [
  'ef_fire01', 'ef_fire02', 'ef_fire03', 'ef_holy01',
  'ef_ice01', 'ef_ice02', 'ef_ice03',
  'ef_lightning01', 'ef_lightning02', 'ef_lightning03',
  'ef_parts_hit01', 'ef_parts_hit02',
  'ef_wind01', 'ef_wind02', 'ef_wind03',
];
const names = listArg ? listArg.split(',') : NAMES;
const globalScale = opt('scale', '0.75');
const outDir = opt('out', 'shots/fx_preview');
const base = opt('base', 'http://127.0.0.1:3112/');
const scanMs = Number(opt('scanms', '3200'));

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fx-preview');
const port = 9261;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const evalV = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};
async function waitJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('devtools timeout');
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.dirname(profile), { recursive: true });
  child = spawn(edge, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=420,320', 'about:blank'], { stdio: 'ignore' });
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('  PAGE EXC:', (m.params.exceptionDetails.exception?.description || '').slice(0, 160));
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      console.log('  PAGE ERR:', JSON.stringify(m.params.args?.[0]?.value || '').slice(0, 160));
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 320, deviceScaleFactor: 1, mobile: false });

  const summary = [];
  for (const name of names) {
    const url = `${base}fx-preview.html?fx=${encodeURIComponent(name)}&scale=${globalScale}`;
    await cdp('Page.navigate', { url });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (await evalV('window.__ready === true') === true) { ready = true; break; }
    }
    if (!ready) { console.log(name, 'NOT READY'); continue; }

    // 自适应取景：扫描两轮，让峰值覆盖率落在 0.2~0.5
    let dist = 10.5;
    let curve = null;
    for (let k = 0; k < 3; k++) {
      curve = await evalV(`window.__scan(${scanMs}, 100, ${dist})`);
      if (!curve || !curve.length) break;
      const peak = Math.max(...curve.map((c) => c.cover));
      if (peak < 0.16) dist = Math.max(1.8, dist * 0.72);
      else if (peak > 0.52) dist = Math.min(34, dist * 1.36);
      else break;
    }
    if (!curve || !curve.length) { console.log(name, 'SCAN FAIL'); continue; }

    const peakIdx = curve.reduce((bi, c, i) => (c.cover > curve[bi].cover ? i : bi), 0);
    const peak = curve[peakIdx];
    const thr = Math.max(0.008, peak.cover * 0.22);
    let lastIdx = peakIdx;
    for (let i = curve.length - 1; i >= 0; i--) { if (curve[i].cover >= thr) { lastIdx = i; break; } }
    const tEnd = curve[lastIdx].t;

    // 选帧：把有效区间四等分，每段取覆盖率最高的时刻（天然不重复、且覆盖全程）
    const pick = [];
    for (let s = 0; s < 4; s++) {
      const a = (tEnd * s) / 4, b = (tEnd * (s + 1)) / 4;
      const cand = curve.filter((c) => c.t >= a - 1e-6 && c.t <= b + 1e-6);
      const best = cand.reduce((x, c) => (c.cover > x.cover ? c : x), cand[0] || { t: a });
      pick.push(+Math.max(0.05, best.t).toFixed(2));
    }
    const uniq = [...new Set(pick)].sort((x, y) => x - y);
    while (uniq.length < 4) uniq.push(+(uniq[uniq.length - 1] + 0.15).toFixed(2));

    for (let i = 0; i < 4; i++) {
      await evalV(`window.__freeze(${Math.round(uniq[i] * 1000)}, ${dist})`);
      await sleep(60);
      const rect = await evalV("(()=>{const r=document.getElementById('cv').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
      const shot = await cdp('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true, clip: { ...rect, scale: 1 },
      });
      await fs.writeFile(path.join(outDir, `${name}_${i}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`ok ${name} dist=${dist.toFixed(1)} peak=${peak.cover}@${peak.t}s end=${tEnd}s frames=${uniq.join(',')}`);
    summary.push({ name, dist, peak: peak.cover, tPeak: peak.t, tEnd, frames: uniq });
  }
  await fs.writeFile(path.join(outDir, '_summary.json'), JSON.stringify(summary, null, 1));
}

main()
  .then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e.message); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
