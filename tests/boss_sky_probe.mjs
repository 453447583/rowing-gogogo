// 怪物模式四关天空预设验收：逐关切主题，读 RealSky uniform + 天气字段，并活拍天空。
//   node tests/boss_sky_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/bosssky-${stamp}`;
const port = 9940 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const outDir = path.resolve('shots/boss_sky');

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
  while (Date.now() - t0 < timeout) { last = val(await evaluate(expr)); if (last) return last; await sleep(250); }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}
try {
  let info;
  for (let i = 0; i < 160; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ } await sleep(150); }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  // 进怪物模式：大厅模式抽屉里的 boss 卡
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-boss-card[data-mode="boss"]')`, 30000);
  await evaluate(`document.querySelector('.lp-boss-card[data-mode="boss"]').click(); 1`);
  await sleep(400);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.themes`, 150000);
  await waitFor(`window.__game?.phase === 'racing'`, 150000);
  await evaluate(`(() => { const b = window.__game.bossMode; if (b) { b.introT = 99; b.countdown = 0.01; } return 1; })()`);
  await sleep(1800);

  await fs.mkdir(outDir, { recursive: true });
  const rows = [];
  for (const stage of [1, 2, 3, 4]) {
    const r = val(await evaluate(`(() => {
      const g = window.__game;
      g.themes.setTheme(${stage});
      const w = g.themes.current ? (window.__BOSS_THEME_WEATHER__ || null) : null;
      const rs = g.env.realSky;
      const u = rs?.u || {};
      const theme = (function(){ try { return g.themes.current; } catch(e) { return null; } })();
      return {
        stage: ${stage}, theme,
        weatherId: g.env.weather?.id, skyPreset: g.env.weather?.skyPreset,
        snow: g.env.weather?.snow, stars: g.env.weather?.stars,
        fog: g.env.weather?.fogColor?.getHexString?.() ?? g.env.weather?.fogColor,
        water: g.env.weather?.waterColor?.getHexString?.() ?? g.env.weather?.waterColor,
        turbidity: u.turbidity?.value, rayleigh: u.rayleigh?.value,
        overcast: u.uOvercast?.value, exposure: u.uExposure?.value,
        sat: u.uSkySaturation?.value, nightMix: u.uNightMix?.value,
        nightSky: !!g.env.nightSky?.visible,
        sunDisc: u.uSunDisc?.value,
      };
    })()`));
    rows.push(r);
    console.log('stage', stage, JSON.stringify(r));
    const v = val(await evaluate(`(() => {
      const g = window.__game;
      g.post?.render?.(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.86);
    })()`));
    if (typeof v === 'string' && v.startsWith('data:image')) {
      const f = path.join(outDir, `stage${stage}.jpg`);
      await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
      console.log('shot', f);
    }
    await sleep(400);
  }
  console.log('SUMMARY', JSON.stringify(rows));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
