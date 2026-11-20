// 礁石验收：把相机怼到 mapDef.rocks 里最大的一块前面，验证"整块岩石露在水面上"。
// 与 reef_shot.mjs 的区别：那个拍的是 SceneDressing 的海面装饰礁盘，
// 这个拍的是 env 的 rock colliders（真正会被船撞到的礁石）。
//   node tests/boulder_shot.mjs <mapId> <weather> <tag> [...更多机位]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const MAP = process.argv[2] || 'ocean';
const WEATHER = process.argv[3] || 'day';
const TAG = process.argv[4] || `${MAP}-${WEATHER}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/boulder-${stamp}`);
const port = 9560 + (Number(stamp.slice(-3)) % 120);
const url = process.env.WB_URL || 'http://127.0.0.1:5273/';
const outDir = path.resolve('shots/verify');
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 45000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    // 无头软件光栅偶尔会把 captureScreenshot 卡死；没有超时就是静默挂起，
    // 排查时完全看不出卡在哪一步
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp timeout: ${method}`));
    }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
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
  // CANVAS=1 直接走 toDataURL，不等合成器出新帧。
  // 岩块很大时一帧要算整屏水面 + 岩石贴图，软件光栅能拖到 40s+，
  // captureScreenshot 会一路挂到超时；配合 SMALL=1 把画布缩小才算得完。
  if (!process.env.CANVAS) {
    try {
      const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
      await fs.writeFile(path.join(outDir, `boulder-${TAG}-${name}.jpg`), Buffer.from(s.data, 'base64'));
      console.log('saved', name, '(captureScreenshot)');
      return;
    } catch (e) {
      // 贴近大块礁石时无头合成器经常卡住不产新帧，captureScreenshot 会挂到超时。
      // 退回"自己 render 一次 + 读 canvas"：绕开合成器，同任务内读像素也不会被清空。
      console.log('fallback toDataURL:', e.message);
    }
  }
  const r = await evaluate(`(() => {
    const g = window.__game;
    if (!g?.renderer) return null;
    g.renderer.render(g.scene, g.camera);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
  })()`);
  const data = r.result?.value;
  if (!data) throw new Error('toDataURL failed');
  await fs.writeFile(path.join(outDir, `boulder-${TAG}-${name}.jpg`),
    Buffer.from(data.split(',')[1], 'base64'));
  console.log('saved', name, '(canvas)');
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
  if (!booted) throw new Error('menu never booted');
  await click('#btn-solo');
  await sleep(900);
  if (await waitSel('#boat-list .boat-card', 6000)) {
    await click('#boat-list .boat-card');
    await sleep(400);
  }
  if (!(await waitSel('.map-card', 20000))) throw new Error('map cards missing');
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

  // 真实模型的高度（InstancedMesh 的几何体包围盒 × 实例缩放）
  const stats = await evaluate(`(() => {
    const g = window.__game;
    const im = g.scene.getObjectByName('reef-boulders');
    const rocks = (g.env?.colliders || []).filter((c) => c.type === 'rock');
    let geoH = 0, ins = null;
    if (im?.isInstancedMesh) {
      im.geometry.computeBoundingBox();
      const bb = im.geometry.boundingBox;
      // 实例矩阵是列主序，elements[5] 就是 y 轴缩放
      const sy = im.instanceMatrix.array[5];
      geoH = (bb.max.y - bb.min.y) * sy;
      ins = { count: im.count, sy: +sy.toFixed(2) };
    }
    return {
      hasBoulderMesh: !!im,
      instanced: ins,
      worldHeightOfFirst: +geoH.toFixed(2),
      rocks: rocks.map((c) => ({
        x: +c.x.toFixed(1), z: +c.z.toFixed(1), r: c.r,
        bottom: +c.bottomY.toFixed(2), top: +c.topY.toFixed(2),
        exposed: +c.topY.toFixed(2),
      })).sort((a, b) => b.r - a.r).slice(0, 5),
    };
  })()`);
  console.log('stats:', JSON.stringify(stats.result?.value));
  // returnByValue 下取不到值几乎都是页内抛异常（例如某个碰撞体没有 topY），
  // 不打印就只剩一个 undefined，完全看不出是哪一行炸的
  if (!stats.result?.value) {
    console.log('stats EXC:', stats.exceptionDetails?.exception?.description
      || stats.exceptionDetails?.text || JSON.stringify(stats.exceptionDetails || {}));
  }

  const list = stats.result?.value?.rocks || [];
  // 别去改相机：把 cameraRig 的 follow/snapTo 换成空实现，跟随逻辑会每帧拿到
  // undefined，整帧都在抛异常，captureScreenshot 于是永远等不到新帧（挂到超时）。
  // 正确做法是把船开到礁石前面，让真正的追尾相机自己取景 —— 也更接近玩家看到的画面。
  //
  // 已知限制：贴近大块礁石时一帧要算整屏水面 + 4MB 岩石贴图，软件光栅能拖到 40s+，
  // 期间 JS 主线程被占死，Runtime.evaluate 也会跟着超时。这是渲染卡顿，不是游戏卡死
  // （同一机位有时能出图、有时不能，就是帧时抖动的结果）。
  // 传送点也别落在礁石碰撞圆柱里（礁石阵有石头离中线只有 4m，r 却有 3.6）。
  //
  // 机位来源（优先级从高到低）：
  //   ① RIG=x,z,heading;x,z,heading —— 手工机位
  //   ② ROCK=1 —— 从最大的三块礁石自动生成：船停在礁石 +z 侧
  //      （heading=π 朝 -z），让真追尾相机自己把礁石框进画面
  //   ③ 默认 ocean 的固定机位
  // 峡谷这类"礁石在窄河道里、没有 InstancedMesh"的图必须走 ②，
  // 因为它一块石头的位置和 ocean 差了十万八千里，写死坐标只会拍到水面。
  const rigEnv = process.env.RIG || '';
  let rigs;
  if (rigEnv) {
    rigs = rigEnv.split(';').map((s, i) => {
      const [x, z, h] = s.split(',').map(Number);
      return { name: `rig${i}`, x, z, heading: h };
    });
  } else if (process.env.ROCK) {
    rigs = list.slice(0, 3).map((c, i) => ({
      name: `rock${i + 1}-r${c.r}`,
      x: c.x,
      z: c.z + c.r + 11,
      heading: Math.PI,
    }));
  } else {
    rigs = [{ name: 'front', x: 270, z: -76, heading: Math.PI / 2 }];
  }
  if (process.env.NOSHOT) { ws.close(); child.kill(); await sleep(400); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(0); }

  // SMALL=1：把画布缩到 640×400。软件光栅的耗时基本跟像素数成正比，
  // 缩小之后同一机位能在超时内出图（代价只是分辨率，看岩块露出比例足够了）。
  if (process.env.SMALL) {
    const sz = process.env.SMALL === '1' ? [640, 400] : process.env.SMALL.split('x').map(Number);
    const r = await evaluate(`(() => {
      const g = window.__game; if (!g?.renderer) return 'no-game';
      g.renderer.setPixelRatio(1);
      g.renderer.setSize(${sz[0]}, ${sz[1]}, false);
      g.camera.aspect = ${sz[0]} / ${sz[1]};
      g.camera.updateProjectionMatrix();
      return g.renderer.domElement.width + 'x' + g.renderer.domElement.height;
    })()`);
    console.log('canvas:', r.result?.value, r.exceptionDetails?.text || '');
    await sleep(600);
  }
  // CAM=x,y,z,tx,ty,tz;... —— 用一台临时相机对着指定点渲染，完全不碰游戏相机。
  // 用途：岩块到底露出多少，必须"同一个机位、只有代码变"才能比出来；
  // 追尾机位的取景会被船的落点、浪高、松紧曲线搅动，前后两张永远对不齐。
  // 注意：这里是自己调 renderer.render(tmpCam)，主循环仍按游戏相机跑，
  // 所以不会像"把 cameraRig.follow 换成空实现"那样让整帧抛异常。
  const camEnv = process.env.CAM || '';
  if (camEnv) {
    for (const [i, spec] of camEnv.split(';').entries()) {
      const v = spec.split(',').map(Number);
      if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) { console.log('bad CAM spec', spec); continue; }
      const r = await evaluate(`(() => {
        const g = window.__game; if (!g?.renderer) return 'no-game';
        const cam = g.camera.clone();
        cam.position.set(${v[0]}, ${v[1]}, ${v[2]});
        cam.lookAt(${v[3]}, ${v[4]}, ${v[5]});
        cam.updateMatrixWorld(true);
        g.renderer.render(g.scene, cam);
        return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
      })()`);
      // PROJ=1：把 mapDef.rocks 的碰撞体投影到这张图的像素坐标上。
      // 「改了半天没变化」十有八九是画面里那些大石头其实是岩壁布景（#buildBanks），
      // 而不是会撞船的障碍岩块。先把位置对上，再去讨论高度。
      if (process.env.PROJ) {
        const p = await evaluate(`(() => {
          const g = window.__game; if (!g?.camera) return 'no-game';
          const cam = g.camera.clone();
          cam.position.set(${v[0]}, ${v[1]}, ${v[2]});
          cam.lookAt(${v[3]}, ${v[4]}, ${v[5]});
          cam.updateMatrixWorld(true);
          cam.updateProjectionMatrix();
          const w = g.renderer.domElement.width, h = g.renderer.domElement.height;
          const rocks = (g.env?.colliders || []).filter((c) => c.type === 'rock');
          return { size: w + 'x' + h, rocks: rocks.map((c) => {
            const a = cam.position.clone().set(c.x, 0, c.z).project(cam);
            const b = cam.position.clone().set(c.x, c.topY, c.z).project(cam);
            return { x: +c.x.toFixed(0), z: +c.z.toFixed(0), r: c.r,
              px: Math.round((a.x * 0.5 + 0.5) * w), py: Math.round((-a.y * 0.5 + 0.5) * h),
              topPy: Math.round((-b.y * 0.5 + 0.5) * h), inFront: a.z < 1 };
          }) };
        })()`);
        console.log('proj:', JSON.stringify(p.result?.value));
      }
      const data = r.result?.value;
      if (typeof data !== 'string' || !data.startsWith('data:')) {
        console.log(`cam${i} EXC:`, r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || data);
        continue;
      }
      await fs.writeFile(path.join(outDir, `boulder-${TAG}-cam${i}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
      console.log('saved', `cam${i}`, `from (${v[0]},${v[1]},${v[2]})`);
    }
    ws.close();
    child.kill();
    await sleep(400);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    process.exit(0);
  }
  for (const rig of rigs) {
    console.log('rig', rig.name, rig.x, rig.z);
    const r = await evaluate(`(() => {
      const g = window.__game; if (!g) return 'no-game';
      const b = g.localBoat; if (!b) return 'no-boat';
      b.resetTo(${rig.x}, ${rig.z}, ${rig.heading});
      b.speed = 0; b.vel.set(0, 0, 0);
      return 'ok';
    })()`);
    console.log(' cam:', r.result?.value, r.exceptionDetails?.text || '');
    await sleep(2200);
    await shot(rig.name);
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
