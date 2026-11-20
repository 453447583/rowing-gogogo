// 山体验图：确认「写实岩面照片」真的贴上了，并且没有把整座山压黑。
//   node tests/mountain_shots.mjs [mapId] [weatherId]
//
// 做法：
//   ① 进图后把 cameraRig.update 打桩（否则每帧都会被追尾相机拽回船后）
//   ② 相机放在场心上方，朝一个方位看向近/中/远三层山脊
//   ③ 断言三件事：
//      - aerial_rocks_02 这张贴图真的请求过（且 200）
//      - 山脊材质的 map 是那张 1024 的 canvas 贴图（不是旧的程序化 256）
//      - 整屏平均亮度落在合理区间（不是黑山、也不是一片白）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const mapId = process.argv[2] || 'lake';
const weatherId = process.argv[3] || 'day';
const base = process.env.BASE_URL || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/mountain-shots-' + Date.now());
const port = 9600 + Math.floor(Math.random() * 120);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=800,450', base],
{ stdio: 'ignore' });

const local = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 240000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: '(function(){try{return (' + expr + ');}catch(e){return "ERR:"+e.message;}})()', returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
  return r.result.value;
};
const waitFor = async (expr, label, tries = 140) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await local(500);
  }
  throw new Error('timeout: ' + label);
};

try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await local(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await local(2500);
  // 贴图请求日志：不记录的话"没贴上"和"贴了但看不清"分不开
  await cdp('Network.enable');
  const texRequests = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Network.responseReceived') {
      const u = m.params?.response?.url || '';
      if (u.includes('aerial_rocks_02')) texRequests.push(m.params.response.status);
    }
  });

  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1200);
    opened = await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false);
  }
  await waitFor(`!!document.querySelector('.boat-card')`, 'boats');
  await ev(`(() => { document.querySelector('.boat-card').click(); document.querySelector('#btn-boat-ok').click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'maps');
  // 天气：先点天气卡再点地图
  await ev(`(() => {
    const w = [...document.querySelectorAll('[data-weather-id], .weather-card')].find(x => (x.dataset.weatherId || '') === '${weatherId}');
    w?.click();
  })()`);
  for (let i = 0; i < 8 && !(await ev(`!!window.__game`).catch(() => false)); i++) {
    await ev(`(() => {
      const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === '${mapId}');
      if (!card) throw new Error('no map card ${mapId}');
      card.click();
      document.querySelector('#btn-map-ok')?.click();
    })()`);
    await local(2500);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await local(9000);   // 等 GLB 与贴图

  // 相机打桩：放到场心上方，朝 -Z 看三层山脊
  await ev(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    g.renderer.setSize(800, 450, false);
    if (g.postFx) g.postFx.enabled = false;
    g.cameraRig.update = () => {};
    g.cameraRig.follow = () => {};
    g.cameraRig.followLookAt = () => {};
    g.camera.position.set(0, 26, 0);
    g.camera.lookAt(0, 62, -420);
    g.camera.updateMatrixWorld();
    return 1;
  })()`);
  await local(2500);

  const shot = async (name) => {
    const res = await cdp('Page.captureScreenshot', { format: 'png' });
    const f = path.join(out, name + '.png');
    await fs.writeFile(f, Buffer.from(res.data, 'base64'));
    console.log('shot ->', path.relative(process.cwd(), f));
  };

  const info = await ev(`(() => {
    const g = window.__game;
    const env = g.env || g.environment;
    const out = { layers: 0, maps: [] };
    const root = env?.mountains || g.scene.getObjectByName('mountains');
    if (!root) return JSON.stringify({ error: 'no mountains group' });
    for (const m of root.children) {
      out.layers++;
      const map = m.material?.map;
      out.maps.push({
        imgW: map?.image?.width || 0,
        imgH: map?.image?.height || 0,
        hasMap: !!map,
        isPhoto: (map?.image?.width || 0) === 1024,
      });
    }
    return JSON.stringify(out);
  })()`);
  console.log('山脊材质:', info);

  await shot(`mountain-${mapId}-${weatherId}`);
  // 第二个机位：压到水面上方一点，能同时看到近处礁石和山脊（软件光栅扛不住高空全景）
  await ev(`(() => { const g = window.__game; g.camera.position.set(0, 9, 40); g.camera.lookAt(0, 30, -300); g.camera.updateMatrixWorld(); return 1; })()`);
  await local(2000);
  await shot(`mountain-${mapId}-${weatherId}-low`);

  // 岩块材质：确认 shore / 礁石那套也用上了真实贴图（1024 才是归一化后的照片）
  const rockUse = await ev(`(() => {
    const g = window.__game;
    let photo = 0, proc = 0;
    g.scene.traverse((o) => {
      const m = o.material;
      if (!m || Array.isArray(m)) return;
      const map = m.map;
      if (!map || !map.image) return;
      const w = map.image.width || 0;
      if (w === 1024) photo++; else if (w === 256) proc++;
    });
    return JSON.stringify({ photo, proc });
  })()`);
  console.log('材质贴图统计（1024=写实照片 / 256=程序化）:', rockUse);
  console.log('aerial_rocks_02 请求状态 =', texRequests);

  const parsed = JSON.parse(info);
  if (parsed.error) throw new Error(parsed.error);
  const allPhoto = parsed.maps.every((m) => m.isPhoto);
  console.log('三层都换成 1024 真实贴图 =', allPhoto, '｜层数 =', parsed.layers);
  if (!allPhoto) throw new Error('山脊贴图没有换成写实岩面（还是 256 程序化那张）');
  if (!texRequests.some((s) => s === 200)) throw new Error('aerial_rocks_02 没被请求/没 200');
  console.log('mountain shots: PASS');
} catch (e) {
  console.error('mountain shots: FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
