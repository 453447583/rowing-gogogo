// 水面外观验收截图：起跑视角 + 正对太阳视角（看太阳光路/菲涅尔）
// 运行前先 npm run dev（127.0.0.1:5173）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const MAP = process.argv[2] || 'ocean';
// 第 4 个参数指定要验证的天气（day/dusk/storm/blizzard/starry）
const WEATHER = process.argv[4] || 'dusk';
const TAG = process.argv[3] || MAP;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 端口/profile 都带时间戳：上一轮被 kill 的 Edge 有时还锁着 profile，
// 固定名字会让下一轮直接卡在 /json 探测上
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-look-${stamp}`);
const port = 9241 + (Number(stamp.slice(-3)) % 200);
// 默认连 5273 的 vite dev —— 5173 常被"启动服务器.bat"（build + node server.js）
// 占着、serve 的是 dist 里的旧包，改动根本验证不到
const url = process.env.WB_URL || 'http://127.0.0.1:5273/';
const outDir = path.resolve('shots/verify');
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${process.env.WB_WIN || '1440,900'}`, url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function waitForJson(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  // jpeg：1280×760 的 png 有 4MB，翻图工具直接拒收
  const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  await fs.writeFile(path.join(outDir, `water-${TAG}-${name}.jpg`), Buffer.from(s.data, 'base64'));
  console.log('saved', name);
}
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
// 轮询等元素出现：dev 首屏要现编译模块，固定 sleep 在慢机器/并发时会不等够就点空
async function waitSel(sel, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
    if (r.result?.value) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  // 必须挑游戏页那个 target：tabs[0] 有时是别的 target，
  // evaluate 会在错误的执行上下文里跑，表现为"截图是菜单但 querySelector 全是 null"
  const page = tabs.find((t) => t.type === 'page' && /5273|5173/.test(t.url))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  console.log('target:', page?.url);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    // 着色器编译失败会在这里打出来（否则只能靠截图猜）
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/error|fail|shader|glsl/i.test(text)) console.log('[console]', text.slice(0, 400));
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  // dev 模式首次访问要现编译模块，2.5s 不够（表现为停在主菜单、后面全截图都是菜单）
  await sleep(4500);

  const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`);
  console.log('menu ready:', await waitSel('#btn-solo'));
  await click('#btn-solo');
  await sleep(600);
  await evaluate(`(() => document.querySelector('#boat-list .boat-card'))()`);
  await waitSel('#boat-list .boat-card');
  await click('#boat-list .boat-card');
  await click('#btn-boat-ok');
  await waitSel('.map-card', 15000);
  const picked = await evaluate(`(() => { const c = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === ${JSON.stringify(MAP)}); if (!c) return 'no-card'; c.click(); return c.textContent.slice(0, 20); })()`);
  console.log('map:', picked.result?.value);
  await click('#btn-map-ok');
  await sleep(9000);

  await evaluate(`(() => { const g = window.__game; if (!g) return 'no-game'; g.phase = 'racing'; g.countdownLeft = 0; return 'ok'; })()`);
  await sleep(1200);
  await shot('start');

  // 正对太阳：太阳水平方向由 mapDef 默认 [0.45,0.7,0.3] 决定
  await evaluate(`(() => {
    const g = window.__game; const b = g?.localBoat; if (!b) return;
    // 用真实太阳方向（昼夜循环会改写 sunDir），而不是地图里的静态默认值
    const sd = g.water.uniforms.uSunDir.value;
    const h = Math.atan2(sd.x, sd.z);
    b.resetTo(0, 0, h); b.speed = 0; b.vel.set(0, 0);
  })()`);
  await sleep(2500);
  await shot('facing-sun');

  // 近水面低机位（白天）：抬高相机俯角接近水平，检验紧贴水面的细节
  await evaluate(`(() => {
    const g = window.__game; if (!g) return;
    const cam = g.camera;
    if (cam && g.localBoat) {
      const b = g.localBoat;
      cam.position.set(b.pos.x - 14, 3.2, b.pos.z - 14);
      cam.lookAt(b.pos.x + 30, 0, b.pos.z + 30);
      if (g.rig) g.rig.enabled = false;
    }
  })()`);
  await sleep(2200);
  await shot('low');

  // 黄昏：低太阳 + 暖色，检验太阳光路（和参考图最接近的场景）
  // 用 dev server 的动态 import 拿真正的天气预设——手工拼对象会让 RealSky 停在白天，
  // env.setWeather 再据此算 dayTint，sunDir 又被 applyDayTint 覆盖回高角度太阳。
  await evaluate(`(async () => {
    const g = window.__game; if (!g) return 'no-game';
    const { getWeather } = await import('/src/data/maps.js');
    const w = getWeather(${JSON.stringify(WEATHER)});
    g.weather = w;
    g.env.setWeather(w);
    g.water.setWeather(w);
    g.post?.setWeather?.(w);
    const b = g.localBoat;
    if (b) { b.resetTo(0, 0, Math.atan2(0.9, 0.35)); b.speed = 0; b.vel.set(0, 0); }
    if (g.rig) g.rig.enabled = false;
    const cam = g.camera;
    if (cam && b) { cam.position.set(b.pos.x, 2.4, b.pos.z - 6); cam.lookAt(b.pos.x + 25, 0.6, b.pos.z + 10); }
    return w.id;
  })()`);
  await sleep(2600);
  await shot(`${WEATHER}-path`);

  // 黄昏再拉一个侧后方机位：太阳光路的走向在这个角度最清楚
  await evaluate(`(() => {
    const g = window.__game; if (!g) return;
    const cam = g.camera; const b = g.localBoat;
    if (cam && b) {
      cam.position.set(b.pos.x - 22, 5.5, b.pos.z - 8);
      cam.lookAt(b.pos.x + 60, 1.2, b.pos.z + 26);
    }
  })()`);
  await sleep(2000);
  await shot(`${WEATHER}-low`);

  const info = await evaluate(`(() => {
    const g = window.__game; const u = g?.water?.uniforms;
    if (!u) return null;
    return {
      quality: g.quality,
      pixelRatio: g.renderer.getPixelRatio(),
      waterSeg: g.water.seg,
      sat: u.uSat.value, exposure: u.uExposure.value,
      glint: u.uGlint.value, cloud: u.uCloudAmt.value,
      waveScale: u.uWaveScale.value, waveCount: u.uWaveCount.value,
      sunDir: u.uSunDir.value.toArray(),
      shallow: u.uColorShallow.value.getHexString(),
      deep: u.uColorDeep.value.getHexString(),
    };
  })()`);
  console.log(JSON.stringify(info.result?.value, null, 2));
  ws.close();
  child.kill();
  await sleep(500);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
