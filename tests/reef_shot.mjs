// 礁石高度验收：直接读 Environment.colliders 里的 rock，打印 bottomY/topY，
// 并把相机怼到第一块礁石前面 18m 拍特写。
//   node tests/reef_shot.mjs <mapId> <weather> <tag>
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const MAP = process.argv[2] || 'tide';
const WEATHER = process.argv[3] || 'day';
const TAG = process.argv[4] || `${MAP}-${WEATHER}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/reef-${stamp}`);
const port = 9450 + (Number(stamp.slice(-3)) % 120);
const url = process.env.WB_URL || 'http://127.0.0.1:5273/';
const outDir = path.resolve('shots/verify');
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function waitForJson(u, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${u}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
// 等任意布尔表达式成立：`#btn-solo` 是静态 HTML，DOM 一存在就 true，
// 但 main.js 还没执行完时 onclick 是空的 —— 点下去等于没点（表现为一直停在主菜单）
async function waitExpr(expr, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evaluate(`!!(${expr})`);
    if (r.result?.value) return true;
    await sleep(250);
  }
  return false;
}
async function waitSel(sel, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
    if (r.result?.value) return true;
    await sleep(250);
  }
  return false;
}
async function shot(name) {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, `reef-${TAG}-${name}.png`), Buffer.from(s.data, 'base64'));
  console.log('saved', name);
}

async function main() {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = tabs.find((t) => t.type === 'page' && /5273|5173/.test(t.url))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(1200);

  const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`);
  const booted = await waitExpr(`document.querySelector('#btn-solo') && document.querySelector('#btn-solo').onclick`, 30000);
  console.log('booted:', booted);
  await click('#btn-solo');
  await sleep(900);
  // 新版 UI 把"选艇 + 选图"并成了一屏，确认按钮是 #btn-map-ok，
  // #btn-boat-ok 已被 CSS 隐藏（点它等于没点）
  if (await waitSel('#boat-list .boat-card', 6000)) {
    await click('#boat-list .boat-card');
    await sleep(400);
  }
  const okMap = await waitSel('.map-card', 20000);
  console.log('map cards ready:', okMap);
  if (!okMap) {
    const txt = await evaluate('document.body.innerText.slice(0, 160)');
    console.log('body:', JSON.stringify(txt.result?.value));
  }
  const ids = await evaluate(`[...document.querySelectorAll('.map-card')].map(x => x.dataset.mapId)`);
  console.log('cards:', JSON.stringify(ids.result?.value));
  const picked = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === ${JSON.stringify(MAP)});
    if (!c) return 'no-card';
    c.click();
    return c.dataset.mapId;
  })()`);
  console.log('map:', picked.result?.value);
  await click('#btn-map-ok');
  await sleep(9000);
  await evaluate(`(() => { const g = window.__game; if (!g) return 'no-game'; g.phase = 'racing'; g.countdownLeft = 0; return 'ok'; })()`);
  await sleep(1500);

  if (WEATHER !== 'day') {
    await evaluate(`(async () => {
      const g = window.__game; if (!g) return 'no-game';
      const { getWeather } = await import('/src/data/maps.js');
      const w = getWeather(${JSON.stringify(WEATHER)});
      g.weather = w; g.env.setWeather(w); g.water.setWeather(w); g.post?.setWeather?.(w);
      return w.id;
    })()`);
    await sleep(2000);
  }

  // 读碰撞体：礁石是否真的露出水面（topY > 0 且幅度合理）
  const info = await evaluate(`(() => {
    const g = window.__game;
    const rocks = (g.env?.colliders || []).filter((c) => c.type === 'rock');
    if (!rocks.length) return null;
    return {
      count: rocks.length,
      list: rocks.slice(0, 6).map((c) => ({
        x: +c.x.toFixed(1), z: +c.z.toFixed(1), r: c.r,
        bottom: +c.bottomY.toFixed(2), top: +c.topY.toFixed(2),
      })),
    };
  })()`);
  console.log(JSON.stringify(info.result?.value));

  // 用户截图里那种"半沉的小石头"其实是 SceneDressing 的海面礁盘，
  // 不是 mapDef.rocks（后者本来就露出 3m）。两块都拍。
  const reefs = await evaluate(`(() => {
    const g = window.__game;
    const fl = g.env?.dressing?.floaters || [];
    return fl.filter((f) => f.kind === 'rock').slice(0, 3).map((f) => ({
      x: +f.obj.position.x.toFixed(1),
      y: +f.obj.position.y.toFixed(1),
      z: +f.obj.position.z.toFixed(1),
      size: +(f.obj.geometry?.parameters?.radius || 0).toFixed(1),
    }));
  })()`);
  console.log('decor reefs:', JSON.stringify(reefs.result?.value));

  const target = reefs.result?.value?.[0];
  if (target) {
    await evaluate(`(() => {
      const g = window.__game; if (!g) return;
      // 跟随镜头每帧都会覆盖相机，先把 rig 的更新掐掉再摆机位
      // 相机由 Game.cameraRig 每帧接管（不是 g.rig）
      const rig = g.cameraRig;
      if (rig) {
        rig.follow = () => {};
        rig.followLookAt = () => {};
        rig.snapTo = () => {};
      }
      const cam = g.camera;
      cam.position.set(${target.x} + 6, 3.2, ${target.z} + 16);
      cam.lookAt(${target.x}, ${Math.max(0.3, target.size * 0.3)}, ${target.z});
    })()`);
    await sleep(1800);
    await shot('close');
  }

  ws.close();
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
