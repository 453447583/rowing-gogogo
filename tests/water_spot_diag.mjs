// 水面斑点归因探针：逐项关掉水面着色器的一层，活拍对比，定位"短划线暗斑"来源。
//
//   node tests/water_spot_diag.mjs
//   MAP=ocean node tests/water_spot_diag.mjs
//
// 出图：shots/water_diag/<map>-<case>.jpg
// 注意：只改 uniform，不动源码；每个案例都从同一套基线值恢复，避免互相污染。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/wdiag-${stamp}`;
const port = 9840 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'ocean';
const weather = process.env.WEATHER || 'day';
const outDir = path.resolve('shots', 'water_diag');

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
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
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-lobby-weather').click(); 1`);
  await waitFor(`!!document.querySelector('[data-weather="${weather}"]')`, 30000);
  await evaluate(`document.querySelector('[data-weather="${weather}"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.water`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {};
    return 1;
  })()`);
  await sleep(700);

  // 固定机位：船后 16m、高 8m，向前俯看 —— 近处水纹 + 中景反射 + 远处雾都在画面里
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, c = g.camera;
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    c.position.set(b.pos.x - fx * 16, 8, b.pos.z - fz * 16);
    c.up.set(0, 1, 0);
    c.lookAt(b.pos.x + fx * 80, 0.4, b.pos.z + fz * 80);
    c.fov = 62;
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return 1;
  })()`);
  await sleep(700);

  const fps = val(await evaluate(`(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise((res) => {
      const step = () => { if (performance.now() - t0 > 1500) res(); else { frames++; requestAnimationFrame(step); } };
      requestAnimationFrame(step);
    });
    return +(frames / ((performance.now() - t0) / 1000)).toFixed(1);
  })()`));
  console.log('fps:', fps);

  // 记录基线：每个 case 前都完整恢复，防止叠加
  const base = val(await evaluate(`(() => {
    const u = window.__game.water.uniforms;
    const keys = ['uEnvOn','uEnvAmt','uFoamStrength','uGlint','uShoreStrength','uReflMax','uSpecGain','uCloudAmt','uWaveScale'];
    const out = {};
    for (const k of keys) out[k] = u[k]?.value;
    return out;
  })()`));
  console.log('baseline uniforms:', JSON.stringify(base));

  const CASES = {
    base: {},
    noEnv: { uEnvOn: 0 },
    noFoam: { uFoamStrength: 0 },
    noGlint: { uGlint: 0 },
    noShore: { uShoreStrength: 0 },
    noReflection: { uEnvOn: 0, uReflMax: 0, uCloudAmt: 0 },
    noSpec: { uSpecGain: 0, uGlint: 0 },
    reflHigh: { uEnvAmt: 0.85, uEnvMax: 1.8, uReflMax: 0.70, uCloudAmt: 0.5 },
    reflMax: { uEnvAmt: 1.0, uEnvMax: 2.5, uReflMax: 0.95, uCloudAmt: 0.6 },
    reflHigh: { uEnvAmt: 0.85, uEnvMax: 1.8, uReflMax: 0.70, uCloudAmt: 0.5 },
    reflMax: { uEnvAmt: 1.0, uEnvMax: 2.5, uReflMax: 0.95, uCloudAmt: 0.6 },
  };

  await fs.mkdir(outDir, { recursive: true });
  // 冻结主循环：上面用 Page.captureScreenshot 时每格差 1~2 秒、船和浪都变了，
  // A/B 根本不可比。冻结后只改 uniform + post.render()，同一帧对比才有效。
  await evaluate(`(() => { const g = window.__game; if (g.rafId) { cancelAnimationFrame(g.rafId); g.rafId = 0; } return 1; })()`);
  await sleep(200);
  for (const [name, patch] of Object.entries(CASES)) {
    const v = val(await evaluate(`(() => {
      const g = window.__game, u = g.water.uniforms;
      const base = ${JSON.stringify(base)};
      const patch = ${JSON.stringify(patch)};
      for (const k in base) if (u[k]) u[k].value = base[k];
      for (const k in patch) if (u[k]) u[k].value = patch[k];
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
    })()`));
    if (typeof v !== 'string' || !v.startsWith('data:image')) {
      console.log('shot failed', name, String(v).slice(0, 120));
      continue;
    }
    const f = path.join(outDir, `${mapId}-${weather}-${name}.jpg`);
    await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log('shot', name);
  }
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
