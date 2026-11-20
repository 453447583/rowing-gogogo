// 任务线B验收出图：起点线（霓虹海峡 z=16）/ 最后直道 4 个加速带 + 4 块移动岩石。
//   WB_URL=http://127.0.0.1:5199/ node tests/pass_b_shot.mjs
// 机位全部由页面内实测坐标反推（岩石 group.position、加速带 boostPad 世界坐标），
// 不写死数字 —— 地图一改机位跟着走。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/passb-${stamp}`);
const port = 9300 + (Number(stamp.slice(-3)) % 60);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const outDir = path.resolve('shots/pass_b');
const MAP = process.env.MAP || 'strait';

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1360x780', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* not up */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function shot(name, camExpr, lookExpr, fov = 55) {
  const r = await evaluate(`(() => {
    const g = window.__game;
    const c = g.camera;
    const cam = ${camExpr}, look = ${lookExpr};
    c.position.set(cam[0], cam[1], cam[2]);
    c.up.set(0, 1, 0);
    c.lookAt(look[0], look[1], look[2]);
    if (c.fov !== ${fov}) { c.fov = ${fov}; }
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    g.renderer.render(g.scene, c);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.88);
  })()`);
  const data = r.result?.value;
  if (!data) {
    console.log('shot FAIL', name, r.exceptionDetails?.exception?.description || JSON.stringify(r).slice(0, 200));
    return;
  }
  await fs.writeFile(path.join(outDir, `${name}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
  console.log('saved', name);
}

// 实时截图：不停主循环，让雪/水面继续更新（雪花位置是每帧算的，
// 停 raf 之后就冻结在"上一次跟随相机的位置"，画面里几乎没雪）。
// 只把 cameraRig.follow 换成空实现，相机就定在自己设的机位上，不会被跟随时覆盖。
async function shotLive(name, camExpr, lookExpr, fov = 55) {
  await evaluate(`(() => {
    const g = window.__game;
    const c = g.camera;
    const cam = ${camExpr}, look = ${lookExpr};
    g.cameraRig.follow = () => {};
    c.position.set(cam[0], cam[1], cam[2]);
    c.up.set(0, 1, 0);
    c.lookAt(look[0], look[1], look[2]);
    c.fov = ${fov};
    c.updateProjectionMatrix();
    c.updateMatrixWorld(true);
    return 1;
  })()`);
  await sleep(700);   // 让雪层按新相机位置补齐
  try {
    const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
    await fs.writeFile(path.join(outDir, `${name}.jpg`), Buffer.from(s.data, 'base64'));
    console.log('saved', name, '(live)');
  } catch (e) {
    console.log('live shot failed:', e.message);
  }
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const logs = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('[exc] ' + (msg.params.exceptionDetails?.exception?.description || '').split('\n')[0]);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');

  // 等主模块绑定事件
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1200);
  for (let i = 0; i < 12; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(700);
    if ((await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value) break;
  }
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-card[data-map]')].find((x) => x.dataset.map === ${JSON.stringify(MAP)});
    c?.click(); return 1;
  })()`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t1 = Date.now();
  while (Date.now() - t1 < 120000) {
    if ((await evaluate('!!(window.__game && window.__game.track && window.__game.localBoat)')).result?.value) break;
    await sleep(300);
  }

  // 可选切天气（暴风雪验收）：必须在冻结相机/主循环之前切，雪层重建要跑几帧才铺满
  const weather = process.env.WEATHER || '';
  if (weather && weather !== 'day') {
    // 先跳出开场环绕机位：phase 还是 countdown 时相机在赛道上方转圈，
    // 自己设的机位会被每帧覆盖，拍出来是一张全景俯视图
    await evaluate(`(() => {
      const g = window.__game;
      g.phase = 'racing';
      g.countdownLeft = 0;
      return 1;
    })()`);
    await sleep(600);
    const wr = await evaluate(`(async () => {
      const g = window.__game;
      const m = await import('/src/data/maps.js');
      const w = m.getWeather(${JSON.stringify(weather)});
      g.weather = w;
      g.env.setWeather(w);
      g.water.setWeather(w);
      g.post?.setWeather?.(w);
      return w.id;
    })()`);
    console.log('weather:', wr.result?.value ?? wr.exceptionDetails?.exception?.description);
    await sleep(3500);
    const snow = await evaluate(`(() => {
      const g = window.__game;
      const s = g.env?.snowLayers || g.env?.snow;
      if (!s) return 'no-snow-handle';
      return Array.isArray(s) ? s.map((x) => ({ n: x.count, size: x.material?.size })) : 'single';
    })()`);
    console.log('snow layers:', JSON.stringify(snow.result?.value));
    // 天气图必须"活着"拍：雪花位置每帧跟相机算，冻住 raf 之后就只剩上次跟随的残影
    await shotLive('08-weather-level', '[0, 5, 46]', '[0, 3.5, 6]', 60);
    await shotLive('08-weather-sky', '[0, 3, 34]', '[0, 16, 8]', 68);
  }

  // 冻结：停跟随相机 + 停主循环，之后自己摆机位
  const frozen = await evaluate(`(() => {
    const g = window.__game;
    if (!g) return 'no-game';
    g.opts.onFinish = null; g.opts.onQuit = null;
    g.cameraRig.follow = () => {};
    g.cameraRig.snapTo = () => {};
    g.phase = 'racing';
    if (g.rafId) { cancelAnimationFrame(g.rafId); g.rafId = 0; }
    return 'ok';
  })()`);
  console.log('freeze:', frozen.result?.value);
  // 等 Blender 岩石 GLB 异步到位
  await sleep(1500);

  const info2 = await evaluate(`(() => {
    const g = window.__game, t = g.track;
    const mh = t.magmaHazards;
    const drifters = (mh?.drifters || []).map((d, i) => ({
      i, gate: d.gate, axis: d.axis, r: d.r,
      x: +d.group.position.x.toFixed(1), y: +d.group.position.y.toFixed(2), z: +d.group.position.z.toFixed(1),
      children: d.group.children.length,
      meshes: (() => { let n = 0; d.group.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
      hasMap: (() => { let m = false; d.group.traverse((o) => { if (o.isMesh && o.material?.map) m = true; }); return m; })(),
    }));
    const pads = (t.pads || []).map((p, i) => ({
      i, x: +p.x.toFixed(1), z: +p.z.toFixed(1), halfW: p.halfW, halfL: p.halfL,
      dir: +(p.dir * 180 / Math.PI).toFixed(0),
    }));
    return {
      gate0: t.gates[0], gate1: t.gates[1],
      startWidth: t.startWidth, startLineHalf: +t.startLineHalfWidth().toFixed(2),
      pads, drifters,
      padCount: (t.pads || []).length,
      padColor: t.map?.padColor,
      drifterCount: drifters.length,
    };
  })()`);
  const d = info2.result?.value;
  if (!d) {
    console.log('info EXC:', info2.exceptionDetails?.exception?.description || JSON.stringify(info2).slice(0, 300));
  } else {
    console.log('INFO', JSON.stringify({ ...d, pads: d.pads.length, drifters: d.drifters }, null, 1));
  }

  // ---- ① 起点线：从 z=44 高处俯看 z=16 的格线 + 旗门两腿 ----
  await shot('01-start-line', '[0, 9, 44]', '[0, 0.5, 12]', 58);
  await shot('02-start-line-side', '[26, 5, 30]', '[0, 1.2, 14]', 46);
  // 天气验收：一张平视看雪量/雪片大小，一张仰视看天空里的雪花
  // （已在冻结前用 shotLive 出过，这里不再重复）

  // ---- ② 最后直道：4 个加速带 + 4 块岩石 ----
  const dr = (d?.drifters || []);
  const pads = (d?.pads || []);
  if (dr.length >= 4) {
    // 每块岩石近景：赛道行进方向是 z 递增，相机放在上游（z 更小）侧后方 26m
    for (const s of dr) {
      await shot(`03-rock-${s.i}-gate${s.gate}`, `[${s.x - 6}, 7, ${s.z - 26}]`, `[${s.x}, 1.2, ${s.z}]`, 52);
    }
    // 加速带特写：左右各一个，验证"左右左右"交替的摆法确实生效
    if (pads.length >= 2) {
      for (let k = 0; k < 2; k++) {
        const p = pads[k];
        await shot(`04-pad-${k === 0 ? 'left' : 'right'}`, `[${p.x - 4}, 6, ${p.z - 24}]`, `[${p.x}, 0.3, ${p.z}]`, 55);
      }
    }
    // 斜俯视北段：能同时看到加速带 + 岩石 + 回程的波浪栈道
    await shot('06-straight-north', '[28, 56, -640]', '[98, 0, -300]', 60);
  } else {
    console.log('no drifters, skip straight shots');
  }

  // ---- ③ 波浪栈道（gate 24→28，抬升 0.5~3.0m）：验证木纹 + 板条结构 ----
  await shot('07-boardwalk-front', '[14, 11, -500]', '[12, 2.4, -590]', 58);
  await shot('07-boardwalk-drive', '[17, 6.2, -537]', '[10, 2.2, -578]', 62);
  await shot('07-boardwalk-side', '[42, 14, -570]', '[10, 2.0, -572]', 52);

  if (logs.length) console.log('--- page exceptions ---\n' + logs.slice(0, 10).join('\n'));
  ws.close(); child.kill();
}

main().catch((e) => { console.error('FATAL', e.message); try { child.kill(); } catch { /* */ } process.exitCode = 1; });
