// 冰汐海峡（tide）视觉验收：无头 Edge 跑一遍真流程，按 4 种天气出图。
//
//   node tests/tide_visual.mjs
//
// 产出：shots/verify/tide-<view>-<weather>.png
// 顺带做的断言（这才是主要目的，截图只是给人看）：
//   ① 岩壁 / 冰山 GLB 真的加载成了 InstancedMesh，数量对得上；
//   ② 冰山碰撞体进了 colliders；
//   ③ AI 在 20s 内能推进多个门（走线没有被地形堵死）。
//
// 浏览器配置文件一律落在项目盘 D:/3dgame-tmp/browser/，跑完删掉。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { WEATHERS } from '../src/data/maps.js';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tide-visual');
const port = 9331;
const httpPort = 5173;
const outDir = path.resolve('shots/verify');
await fs.mkdir(outDir, { recursive: true });

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], { stdio: 'ignore' });
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,720',
  `http://127.0.0.1:${httpPort}/`,
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = (ms) => cdp('Runtime.evaluate', {
  expression: `new Promise(r => setTimeout(r, ${ms}))`, awaitPromise: true,
});
async function waitForOk(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForJson(url, timeout = 15000) {
  const r = await waitForOk(url, timeout);
  return r.json();
}

// 视角：门号 + 段内比例 + 朝向 → 把船放到那条线上，让追车镜头自己构图
const VIEWS = {
  corner5: { from: 4, to: 5, t: 0.62 },   // 直角弯前，看两侧岩壁夹出的"门"
  zed: { from: 8, to: 9, t: 0.45 },       // Z 字上折
  ice: { from: 12, to: 13, t: 0.35 },     // 冰山群 + 冰面护栏
  channel: { from: 6, to: 7, t: 0.5 },    // 北岸峡谷壁夹道 + 与冰原的交界
};

let shotCount = 0;

async function placeAt(viewKey) {
  const v = VIEWS[viewKey];
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game;
      const gates = g.mapDef.gates;
      const a = gates[${v.from}], b = gates[${v.to}];
      const t = ${v.t};
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
      const boat = g.localBoat;
      boat.resetTo(x, z, heading);
      boat.speed = 0;
      boat.vel.set(0, 0);
      g.phase = 'racing';
      g.countdownLeft = 0;
      const pm = g.progressMap?.get(g.myId);
      if (pm) { pm.gate = (${v.to} + 1) % gates.length; pm.lap = 1; }
      // 镜头立刻贴到位，不要从上一个点飘过来
      g.cameraRig?.snap?.();
    })()`,
  });
}

async function setWeather(id) {
  const w = WEATHERS.find((x) => x.id === id);
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const w = ${JSON.stringify(w)};
      const g = window.__game;
      g.weather = w;
      g.env.setWeather(w);
      g.water.setWeather(w);
    })()`,
  });
}

async function shot(name) {
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  const file = path.join(outDir, `tide-${name}.png`);
  await fs.writeFile(file, Buffer.from(res.data, 'base64'));
  shotCount++;
  console.log('  shot ->', path.relative(process.cwd(), file));
}

const errors = [];
try {
  await waitForOk(`http://127.0.0.1:${httpPort}/`);
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket(tabs[0].webSocketDebuggerUrl);
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
  await cdp('Log.enable');
  await sleep(900);

  const click = (selector) => cdp('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})?.click()`, returnByValue: true,
  });

  // 单人生涯 → 选船 → 选冰汐海峡 → 开赛
  await click('#btn-solo');
  await sleep(350);
  await cdp('Runtime.evaluate', {
    expression: `(() => [...document.querySelectorAll('#boat-list .boat-card')].find(x => x.textContent.includes('疾风'))?.click())()`,
  });
  await click('#btn-boat-ok');
  await sleep(350);
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === 'tide');
      card?.click();
      const ai = document.querySelector('#solo-ai');
      if (ai) { ai.value = '1'; ai.dispatchEvent(new Event('change')); }
      // 天气不在这里选：下面每个镜头都会显式 setWeather()，
      // 少碰一个菜单控件就少一处和 UI 改版耦合的地方
      document.querySelector('#btn-map-ok')?.click();
    })()`,
  });
  // GLB 地形是异步加载的，多等一会儿
  await sleep(6500);

  const state = await cdp('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const g = window.__game;
      const e = g?.env;
      const cliffs = e?.cliffMesh;
      const large = e?.icebergLarge;
      const small = e?.icebergSmall;
      return {
        map: g?.mapDef?.id,
        gates: g?.mapDef?.gates?.length,
        boundary: g?.mapDef?.boundary?.r,
        cliffInstances: cliffs?.count ?? 0,
        cliffMaterialVertexColors: !!cliffs?.material?.vertexColors,
        icebergLarge: large?.count ?? 0,
        icebergSmall: small?.count ?? 0,
        icebergColliders: (e?.colliders || []).filter((c) => c.type === 'iceberg').length,
        edgeWalls: (g?.track?.edgeWalls || []).length,
        iceSheet: !!e?.iceSheet,
        drawCalls: g?.renderer?.info?.render?.calls ?? 0,
      };
    })()`,
  });
  const s = state.result.value;
  console.log('scene:', s);
  const fail = (m) => { throw new Error(m); };
  if (s.map !== 'tide') fail('did not land on the tide map');
  if (!(s.cliffInstances >= 8)) fail(`cliff instances = ${s.cliffInstances}`);
  if (!s.cliffMaterialVertexColors) fail('cliff material lost vertex colors');
  if (!(s.icebergLarge >= 8)) fail(`large icebergs = ${s.icebergLarge}`);
  if (!(s.icebergSmall >= 18)) fail(`small icebergs = ${s.icebergSmall}`);
  if (!(s.icebergColliders >= 8)) fail(`iceberg colliders = ${s.icebergColliders}`);
  if (!s.iceSheet) fail('ice sheet missing');

  // ---------- 出图 ----------
  await setWeather('day');
  await placeAt('corner5'); await sleep(700); await shot('corner5-day');
  await placeAt('ice'); await sleep(700); await shot('ice-day');
  await placeAt('channel'); await sleep(700); await shot('channel-day');
  await setWeather('dusk');
  await placeAt('ice'); await sleep(700); await shot('ice-dusk');
  await setWeather('storm');
  await placeAt('corner5'); await sleep(700); await shot('corner5-storm');
  await setWeather('blizzard');
  await placeAt('ice'); await sleep(700); await shot('ice-blizzard');

  // ---------- AI 能不能跑起来（走线没被地形堵死）----------
  // 注意：无头浏览器是软件渲染，帧率极低（实测 1~3 fps），墙钟时间完全不能用来
  // 判断 AI 跑得快不快。所以先把渲染尺寸压到 320x200 换取帧率，再按**游戏内
  // raceTime** 计时——方案里"14s 推进 4~6 个门"指的就是游戏时间。
  await setWeather('day');
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game;
      g.renderer.setSize(320, 200, false);
      g.phase = 'racing';
      g.countdownLeft = 0;
      g.raceTime = 0;
      window.__aiWatch = { t0: 0, travelled: 0, prev: null, gates: new Set(), maxGate: -1 };
    })()`,
  });
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    await sleep(700);
    const r = await cdp('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const g = window.__game;
        const ai = g.aiBoats?.[0];
        if (!ai) return { t: g.raceTime, done: false };
        const w = window.__aiWatch;
        let best = -1, bd = 1e9;
        g.mapDef.gates.forEach(([x, z], i) => {
          const d = Math.hypot(ai.pos.x - x, ai.pos.z - z);
          if (d < bd) { bd = d; best = i; }
        });
        if (best >= 0) { w.gates.add(best); w.maxGate = Math.max(w.maxGate, best); }
        if (w.prev) w.travelled += Math.hypot(ai.pos.x - w.prev.x, ai.pos.z - w.prev.z);
        w.prev = { x: ai.pos.x, z: ai.pos.z };
        return { t: g.raceTime, done: g.raceTime >= 12, travelled: w.travelled,
                 gates: w.gates.size, maxGate: w.maxGate, spd: ai.speed ?? 0 };
      })()`,
    });
    if (r.result.value?.done) break;
  }
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  const aiState = await cdp('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const g = window.__game; const w = window.__aiWatch;
      g.renderer.setSize(1280, 720, false);
      return { gameTime: +g.raceTime.toFixed(1), travelled: +w.travelled.toFixed(0),
               gates: w.gates.size, maxGate: w.maxGate };
    })()`,
  });
  console.log(`ai: 游戏内 ${aiState.result.value.gameTime}s（墙钟 ${wall}s）走了 `
    + `${aiState.result.value.travelled}m，经过 ${aiState.result.value.gates} 个门的邻域，`
    + `最远到 #${aiState.result.value.maxGate}（均速 ${(aiState.result.value.travelled / Math.max(0.1, aiState.result.value.gameTime)).toFixed(1)} m/s）`);
  const avgSpeed = aiState.result.value.travelled / Math.max(0.1, aiState.result.value.gameTime);
  if (!(avgSpeed > 8)) fail(`AI average speed only ${avgSpeed.toFixed(1)} m/s (route may be blocked)`);
  if (!(aiState.result.value.maxGate >= 3)) fail(`AI only reached gate #${aiState.result.value.maxGate}`);

  if (errors.length) fail('page exceptions: ' + errors.slice(0, 3).join(' | '));
  console.log(`tide visual checks: PASS  (${shotCount} screenshots)`);
} catch (err) {
  console.error('tide visual checks: FAIL', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
