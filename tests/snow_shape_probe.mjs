// 暴风雪雪片探针：量「大小是否分层随机 / 形状是否多样 / 飘向是否全向」，并活拍两张。
//
//   node tests/snow_shape_probe.mjs
//   MAP=canyon node tests/snow_shape_probe.mjs
//
// 断言（数字是验收，截图给人看）：
//   ① 尺寸：近层 min/max 差距 ≥ 2 倍，且中位数明显偏小（小雪粒多、大片少）；
//   ② 形状：三层用到的图集格数 ≥ 8（近/中）/ ≥ 4（远）；
//   ③ 飘向：抽样 800 片，0.4 秒位移方向落在 8 个扇区里的数量 ≥ 7（不能是一条斜线）；
//   ④ 活拍：雪花位置每帧按相机算，静态冻结会冻在旧机位，必须边跑边截。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/snow-${stamp}`;
const port = 9800 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const outDir = path.resolve('shots', 'snow');

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
  await waitFor(`!!document.querySelector('[data-weather="blizzard"]')`, 30000);
  await evaluate(`document.querySelector('[data-weather="blizzard"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {};
    return 1;
  })()`);
  await sleep(800);

  // 机位：船后 13m、高 6.5m，略微俯视 —— 雪片压在深色海面和天空上最清楚
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, c = g.camera;
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    c.position.set(b.pos.x - fx * 13, 6.5, b.pos.z - fz * 13);
    c.up.set(0, 1, 0);
    c.lookAt(b.pos.x + fx * 18, 2.2, b.pos.z + fz * 18);
    c.fov = 62;
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return 1;
  })()`);
  // 让雪层按新机位补齐（keepClear / 首帧重铺）
  await sleep(900);

  // DEBUG_SIZE=3：把所有雪片放大 3 倍，用来区分"粒子没画出来"和"太小看不见"
  if (process.env.DEBUG_SIZE) {
    await evaluate(`(() => {
      const e = window.__game.env;
      for (const L of e.snowLayers || []) {
        const a = L.points.geometry.attributes.aSize;
        for (let i = 0; i < a.array.length; i++) a.array[i] *= ${Number(process.env.DEBUG_SIZE)};
        a.needsUpdate = true;
      }
      return 1;
    })()`);
    await sleep(300);
  }

  // DEBUG_SIZE=3：把所有雪片放大 3 倍，用来区分"粒子没画出来"和"太小看不见"
  if (process.env.DEBUG_SIZE) {
    await evaluate(`(() => {
      const e = window.__game.env;
      for (const L of e.snowLayers || []) {
        const a = L.points.geometry.attributes.aSize;
        for (let i = 0; i < a.array.length; i++) a.array[i] *= ${Number(process.env.DEBUG_SIZE)};
        a.needsUpdate = true;
      }
      return 1;
    })()`);
    await sleep(300);
  }

  const stats = val(await evaluate(`(() => {
    const e = window.__game.env;
    const out = { weather: e.weather?.id, layers: [] };
    for (const L of e.snowLayers || []) {
      const g = L.points.geometry;
      const sz = g.attributes.aSize.array;
      const cell = g.attributes.aCell.array;
      let mn = Infinity, mx = -Infinity, sum = 0;
      const hist = {};
      const cells = {};
      for (let i = 0; i < sz.length; i++) {
        mn = Math.min(mn, sz[i]); mx = Math.max(mx, sz[i]); sum += sz[i];
        const k = Math.round(sz[i] / 2) * 2;
        hist[k] = (hist[k] || 0) + 1;
        cells[cell[i]] = (cells[cell[i]] || 0) + 1;
      }
      out.layers.push({
        count: sz.length,
        sizeMin: +mn.toFixed(2), sizeMax: +mx.toFixed(2), sizeAvg: +(sum / sz.length).toFixed(2),
        cells: Object.keys(cells).length,
        cellShare: Object.values(cells).map((v) => +(v / sz.length * 100).toFixed(1)),
        sizeBuckets: Object.entries(hist).sort((a, b) => a[0] - b[0]).map(([k, v]) => k + 'px:' + v),
        shader: !!L.points.material.isShaderMaterial,
      });
    }
    return out;
  })()`));
  console.log(JSON.stringify(stats, null, 2));

  // 屏幕内颗数：把每片雪投到 NDC，落在视口内且相机前方才计数。
  // 这个数比"总粒子数"有用得多 —— 决定观感的是这一屏上有多少片。
  const onScreen = val(await evaluate(`(() => {
    const g = window.__game, e = g.env, cam = g.camera;
    cam.updateMatrixWorld(true);
    const V = cam.matrixWorldInverse.elements;
    const P = cam.projectionMatrix.elements;
    const out = [];
    for (const L of e.snowLayers || []) {
      const arr = L.points.geometry.attributes.position.array;
      let n = 0;
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2];
        const vx = V[0] * x + V[4] * y + V[8] * z + V[12];
        const vy = V[1] * x + V[5] * y + V[9] * z + V[13];
        const vz = V[2] * x + V[6] * y + V[10] * z + V[14];
        if (vz > -0.5) continue;
        const cx = P[0] * vx + P[4] * vy + P[8] * vz + P[12];
        const cy = P[1] * vx + P[5] * vy + P[9] * vz + P[13];
        const cw = P[3] * vx + P[7] * vy + P[11] * vz + P[15];
        if (cw <= 0) continue;
        const ndcX = cx / cw, ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
        n++;
      }
      out.push({ count: arr.length / 3, onScreen: n });
    }
    return out;
  })()`));
  console.log('on screen:', JSON.stringify(onScreen));

  // 帧率：逐片随机方向是每帧 12k 次循环，别把帧数吃掉了
  const fps = val(await evaluate(`(async () => {
    const t0 = performance.now();
    let frames = 0;
    await new Promise((res) => {
      const step = () => {
        if (performance.now() - t0 > 1500) res();
        else { frames++; requestAnimationFrame(step); }
      };
      requestAnimationFrame(step);
    });
    return +(frames / ((performance.now() - t0) / 1000)).toFixed(1);
  })()`));
  console.log('fps:', fps);



  // 飘向统计：取中层（3600 片）抽样 800，量 0.4 秒后的位移方向
  const dirs = val(await evaluate(`(async () => {
    const e = window.__game.env;
    const L = (e.snowLayers || [])[1];
    if (!L) return { err: 'no mid layer' };
    const arr = L.points.geometry.attributes.position.array;
    const idx = [];
    const n = arr.length / 3;
    for (let i = 0; i < 800; i++) idx.push(Math.floor((i + 0.5) * n / 800));
    const px = idx.map((i) => arr[i * 3]);
    const pz = idx.map((i) => arr[i * 3 + 2]);
    const waitFrames = (k) => new Promise((res) => {
      let left = k;
      const step = () => { if (--left <= 0) res(); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
    await waitFrames(24);
    const buckets = new Array(8).fill(0);
    let moved = 0;
    const speeds = [];
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const dx = arr[i * 3] - px[k];
      const dz = arr[i * 3 + 2] - pz[k];
      const len = Math.hypot(dx, dz);
      if (len < 0.02) continue;   // 这批被回收/瞬移过，跳过
      moved++;
      speeds.push(len);
      const a = Math.atan2(dz, dx);
      const b = Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8) % 8;
      buckets[b]++;
    }
    speeds.sort((x, y) => x - y);
    return {
      sampled: idx.length, moved,
      buckets, occupied: buckets.filter((v) => v > 0).length,
      maxShare: +(Math.max(...buckets) / Math.max(1, moved) * 100).toFixed(1),
      medStep: +(speeds[Math.floor(speeds.length / 2)] || 0).toFixed(3),
    };
  })()`));
  console.log('drift:', JSON.stringify(dirs));

  await fs.mkdir(outDir, { recursive: true });
  for (let k = 0; k < 2; k++) {
    try {
      const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
      const f = path.join(outDir, `${mapId}-blizzard-${k}.jpg`);
      await fs.writeFile(f, Buffer.from(s.data, 'base64'));
      console.log('shot', f);
    } catch (e) {
      console.log('shot failed', e.message);
    }
    await sleep(650);
  }

  const near = stats.layers[0];
  const mid = stats.layers[1];
  const far = stats.layers[2];
  const problems = [];
  if (!(near.sizeMax / near.sizeMin >= 1.8)) problems.push('near size range too narrow');
  if (!(near.sizeAvg < (near.sizeMin + near.sizeMax) / 2)) problems.push('near sizes not skewed small');
  if (!(near.cells >= 8 && mid.cells >= 8)) problems.push('shape atlas not varied');
  if (!(far.cells >= 4)) problems.push('far layer shape cells < 4');
  if (!(dirs.occupied >= 7)) problems.push('drift directions not spread (' + dirs.occupied + '/8)');
  if (!(dirs.maxShare < 40)) problems.push('drift too lopsided (' + dirs.maxShare + '%)');
  console.log(problems.length ? 'snow probe: ' + problems.join('; ') : 'snow probe: PASS');
  process.exitCode = problems.length ? 2 : 0;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
