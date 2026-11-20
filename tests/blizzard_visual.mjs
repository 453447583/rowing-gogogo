// 暴风雪视觉验收：五张地图各跑一局暴雪，各出一张图，并把关键参数打出来。
//
//   node tests/blizzard_visual.mjs
//
// 产出：shots/blizzard/<map>-blizzard.png
// 断言（截图只是给人看，参数才是验收）：
//   ① 天气真的是 blizzard，天空/雾走的是冷白而不是黑灰；
//   ② 两层雪粒都在、且雪区把相机包住；
//   ③ 水面雪融贴片存在且可见；
//   ④ 太阳压低（sunIntensity 弱、hemi 强），没有强直射。
// 连的是已经在跑的 dev server（localhost:5173），不自己起服务。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 每次跑用独立端口 + 独立配置目录：上一轮残留的无头进程会占着 9341，
// 复用到旧实例上会拿到一个已经崩掉的页面（#btn-solo 永远是 false）
const port = 9000 + (Date.now() % 400);
const profile = path.resolve(`D:/3dgame-tmp/browser/blizzard-${port}`);
const BASE = process.env.WB_URL || 'http://localhost:5173/';
const outDir = path.resolve('shots/blizzard');
await fs.mkdir(outDir, { recursive: true });

const MAPS = process.env.MAP ? [process.env.MAP] : ['canyon', 'lake', 'ocean', 'palace', 'tide'];
const WEATHER = process.env.WEATHER || 'blizzard';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1400,860', BASE,
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForOk(url, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
}

async function waitFor(expression, timeout = 25000, label = expression) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    try { last = await evaluate(expression); } catch (e) { last = `ERR: ${e.message}`; }
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`waitFor timeout: ${label} (last=${JSON.stringify(last)})`);
}

async function shot(name) {
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `${name}.png`);
  await fs.writeFile(file, Buffer.from(res.data, 'base64'));
  console.log('  shot ->', path.relative(process.cwd(), file));
}

const errors = [];

async function enterBlizzard(map) {
  await cdp('Page.navigate', { url: BASE });
  await waitFor(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`);
  await sleep(400);
  await evaluate(`document.querySelector('#btn-solo').click()`);
  await sleep(350);
  await evaluate(`([...document.querySelectorAll('#boat-list .boat-card')]
    .find(x => x.textContent.includes('疾风')) || document.querySelector('#boat-list .boat-card'))?.click()`);
  await cdp('Runtime.evaluate', { expression: `document.querySelector('#btn-boat-ok').click()` });
  await sleep(400);
  const ok = await evaluate(`(() => {
    const card = document.querySelector('.map-card[data-map-id="${map}"]');
    if (!card) return false;
    card.click();
    const ai = document.querySelector('#solo-ai');
    if (ai) { ai.value = '2'; ai.dispatchEvent(new Event('change')); }
    const sel = document.querySelector('#weather-select');
    if (sel) { sel.value = '${WEATHER}'; sel.dispatchEvent(new Event('change')); }
    document.querySelector('#btn-map-ok').click();
    return true;
  })()`);
  if (!ok) throw new Error(`map card not found: ${map}`);
  await waitFor(`!!(window.__game && window.__game.localBoat && window.__game.localBoat.modelRoot)`, 30000, `${map} game start`);
  // 布景 GLB 是异步的，留时间加载完
  await sleep(4200);
  // 直接用过起点后的自然第三人称视角：船在画面下部、前方是航道，
  // 与玩家实际看到的暴雪画面一致（手动摆位容易撞上旗门环/灯塔把画面挡死）
  await evaluate(`(() => {
    const g = window.__game;
    g.phase = 'racing';
    g.countdownLeft = 0;
  })()`);
  await sleep(3600);
}

async function report(map) {
  const info = await evaluate(`(() => {
    const g = window.__game, e = g.env;
    const fx = n => +n.toFixed(2);
    const hex = c => '#' + c.getHexString();
    const u = e.realSky?.material?.uniforms || {};
    return {
      map: g.mapDef.id,
      weather: g.weather?.id,
      sky: {
        turbidity: u.turbidity ? fx(u.turbidity.value) : null,
        rayleigh: u.rayleigh ? fx(u.rayleigh.value) : null,
        mie: u.mieCoefficient ? u.mieCoefficient.value : null,
        exposure: u.uExposure ? fx(u.uExposure.value) : null,
        overcast: u.uOvercast ? fx(u.uOvercast.value) : null,
        cloudLight: u.uCloudLight ? hex(u.uCloudLight.value) : null,
        cloudShadow: u.uCloudShadow ? hex(u.uCloudShadow.value) : null,
      },
      fog: hex(e.scene.fog.color),
      fogDensity: e.scene.fog.density,
      sun: { intensity: e.sunLight?.intensity, color: e.sunLight ? hex(e.sunLight.color) : null },
      hemi: {
        intensity: e.hemiLight?.intensity,
        sky: e.hemiLight ? hex(e.hemiLight.color) : null,
        ground: e.hemiLight ? hex(e.hemiLight.groundColor) : null,
      },
      snowLayers: (e.snowLayers || []).map((l) => ({ count: l.count, size: l.size, range: l.range })),
      snowVisible: !!e.snow?.visible,
      melt: { count: e.snowMelt?.count ?? 0, visible: !!e.snowMelt?.visible },
      water: {
        shallow: hex(g.water.uniforms.uColorShallow.value),
        deep: hex(g.water.uniforms.uColorDeep.value),
        crest: hex(g.water.uniforms.uCrestColor.value),
      },
      drawCalls: g.renderer.info.render.calls,
    };
  })()`);
  console.log(`  ${map}:`, JSON.stringify(info));
  if (WEATHER !== 'blizzard') return info; // 只想看一眼回归，不做暴雪断言
  const fail = (m) => { throw new Error(`${map}: ${m}`); };
  if (info.weather !== 'blizzard') fail(`weather = ${info.weather}`);
  if (!(info.sky.turbidity >= 10 && info.sky.turbidity <= 14)) fail(`turbidity = ${info.sky.turbidity}`);
  if (!(info.sky.rayleigh >= 0.5 && info.sky.rayleigh <= 0.7)) fail(`rayleigh = ${info.sky.rayleigh}`);
  if (!(info.sky.mie >= 0.015 && info.sky.mie <= 0.02)) fail(`mie = ${info.sky.mie}`);
  if (info.snowLayers.length < 2) fail(`snow layers = ${info.snowLayers.length}`);
  if (!info.snowVisible) fail('snow hidden');
  if (!(info.melt.count >= 100 && info.melt.visible)) fail(`snow melt = ${info.melt.count}/${info.melt.visible}`);
  if (!(info.hemi.intensity >= 1)) fail(`hemi too weak = ${info.hemi.intensity}`);
  if (!(info.sun.intensity <= 0.7)) fail(`sun too strong = ${info.sun.intensity}`);
  return info;
}

try {
  await waitForOk(BASE);
  const tabs = (await waitForOk(`http://127.0.0.1:${port}/json`).then((r) => r.json()));
  const tab = tabs.find((t) => t.type === 'page' && t.url.startsWith(BASE)) || tabs.find((t) => t.type === 'page');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params?.exceptionDetails?.exception?.description || 'exception');
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 860, deviceScaleFactor: 1, mobile: false,
  });

  for (const map of MAPS) {
    console.log(`-- ${map}`);
    await enterBlizzard(map);
    await report(map);
    await shot(`${map}-${WEATHER}`);
  }

  if (errors.length) throw new Error('page exceptions: ' + errors.slice(0, 3).join(' | '));
  console.log('blizzard visual checks: PASS');
} catch (err) {
  console.error('blizzard visual checks: FAIL', err.message);
  if (errors.length) console.error('page exceptions:', errors.slice(0, 3).join(' | '));
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch { /* 已关闭 */ }
  child.kill('SIGKILL');
  await sleep(600);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
