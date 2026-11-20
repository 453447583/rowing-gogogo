// 竞速/道具开场镜头取景探针（**只截图，不改源码**）
//
// 目的：检查开场镜头（#startRaceIntro 的高空回旋段）有没有把水面网格之外
// 的"未建模灰色地面"拍进画面。开场镜头在 countdown 期间会冻结倒计时，
// 所以只要在进图后把 raceIntro.dur 拉到极大，就能把镜头**钉**在任意进度上取图。
//
//   node tests/race_intro_shot.mjs
//   MAP=ocean T=0.02,0.14,0.3 TAG=fix node tests/race_intro_shot.mjs
//   MAP=strait WEATHER=dusk node tests/race_intro_shot.mjs
//
// T = 开场镜头的归一化进度（0 = 第一个机位，1 = 落到船尾）。
// 归因开关：
//   HIDE=far      隐藏远景海面（Water.farSea）——判断画面里的浅色平板是不是它
//   YOFF=-2.6     把 farSea 压到水面以下（默认 -0.6，浪谷比它还低就会漏出来）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/intro-${stamp}`);   // 故意不删：safe-delete 钩子会超时
const port = 9680 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const outDir = path.resolve(process.env.OUT || 'shots/intro');
const mapId = process.env.MAP || 'ocean';
const want = (process.env.T || '0.02,0.16,0.34').split(',').map(Number);

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${process.env.SIZE || '1280x720'}`, url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 400)
        || msg.params.exceptionDetails.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await sleep(400);
  if (process.env.WEATHER) {
    await evaluate('document.querySelector("#btn-lobby-weather")?.click(); 1');
    await sleep(500);
    const w = await evaluate(`(() => {
      const b = document.querySelector('[data-weather=${JSON.stringify(process.env.WEATHER)}]');
      if (!b) return 'missing'; b.click(); return 'ok'; })()`);
    if (w.result?.value !== 'ok') throw new Error(`天气 ${process.env.WEATHER} 选不到：${w.result?.value}`);
    await sleep(300);
  }
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  // 抓 raceIntro：进图瞬间它就在（构造函数里建的），必须在 5.6s 播完之前拿到
  const t1 = Date.now();
  let ready = false;
  while (Date.now() - t1 < 30000) {
    const r = await evaluate('!!(window.__game && window.__game.raceIntro)');
    if (r.result?.value) { ready = true; break; }
    const g = await evaluate('!!window.__game');
    if (g.result?.value) {
      // 已经有 game 但 raceIntro 为空 = 已经播完，后续拍不到开场
      console.log('警告：进图时开场镜头已结束');
      break;
    }
    await sleep(80);
  }
  if (!ready) throw new Error('没拿到 raceIntro');

  // 钉住镜头：倒计时在开场期间是冻结的，dur 拉大 → 停在指定进度
  await evaluate(`(() => {
    const g = window.__game;
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    g.phase = 'countdown';
    g.countdownLeft = 999;
    g.raceIntro.dur = 9999;
    g.raceIntro.t = 9999 * ${want[0]};
    return 1; })()`);
  await sleep(1200);
  const info2 = await evaluate(`(() => {
    const g = window.__game, w = g.water;
    const c = g.camera.position;
    const wy = g.track.gateY?.[0] ?? 0;
    const d = g.camera.getWorldDirection(new g.camera.position.constructor());
    return {
      map: g.mapDef.id, water: [+c.x.toFixed(0), +c.y.toFixed(0), +c.z.toFixed(0)],
      dir: [+d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2)],
      boat: [+g.localBoat.pos.x.toFixed(0), +g.localBoat.pos.z.toFixed(0)],
      plane: [w.mesh.position.x, w.mesh.position.z], size: w.size, gateY: +wy.toFixed(2),
      distEdge: +Math.max(
        Math.abs(c.x - w.mesh.position.x), Math.abs(c.z - w.mesh.position.z),
      ).toFixed(0),
      half: +(w.size / 2).toFixed(0),
      farY: w.farSea?.position.y, farVis: w.farSea?.visible,
      // 水体调色/倒影现况：核对"是不是只有星空动了数值"用
      weather: g.weather?.id,
      grade: w.grade,
      u: {
        sat: w.uniforms.uSat.value, exp: w.uniforms.uExposure.value,
        absorb: w.uniforms.uAbsorb.value,
        envOn: w.uniforms.uEnvOn.value, envAmt: w.uniforms.uEnvAmt.value,
        envMax: w.uniforms.uEnvMax.value,
      },
    }; })()`);
  console.log('scene:', JSON.stringify(info2.result?.value));

  if (process.env.HIDE || process.env.YOFF) {
    const r = await evaluate(`(() => {
      const w = window.__game.water;
      ${process.env.YOFF ? `w.farSea.position.y = ${Number(process.env.YOFF)};` : ''}
      ${process.env.HIDE === 'far' ? 'w.farSea.parent.remove(w.farSea);' : ''}
      return [w.farSea.visible, w.farSea.position.y, !!w.farSea.parent]; })()`);
    console.log('farSea:', JSON.stringify(r.result?.value));
  }

  if (process.env.DIAG) {
    // 沿画面某个角的射线做 AABB 粗筛：找出"这块浅色平板到底是哪个物体"
    const nx = Number(process.env.DIAG_X ?? 0.92);
    const ny = Number(process.env.DIAG_Y ?? -0.7);
    const r = await evaluate(`(() => {
      const g = window.__game, cam = g.camera;
      const V3 = cam.position.constructor;
      const origin = cam.position.clone();
      const p = new V3(${nx}, ${ny}, 0.5); p.unproject(cam);
      const dir = p.sub(origin).normalize();
      const hits = [];
      const corners = [];
      const box = { min: new V3(), max: new V3() };
      g.scene.updateMatrixWorld(true);
      g.scene.traverse((o) => {
        if (!o.visible || !o.geometry) return;
        const g2 = o.geometry;
        if (!g2.boundingBox) g2.computeBoundingBox();
        const bb = g2.boundingBox; if (!bb) return;
        box.min.copy(bb.min); box.max.copy(bb.max);
        const ext = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
        if (ext < ${Number(process.env.DIAG_MIN || 40)}) return;   // 只关心大平板
        // 世界 AABB（8 角）
        let mnx = 1e9, mny = 1e9, mnz = 1e9, mxx = -1e9, mxy = -1e9, mxz = -1e9;
        for (let i = 0; i < 8; i++) {
          const v = new V3(
            i & 1 ? bb.max.x : bb.min.x,
            i & 2 ? bb.max.y : bb.min.y,
            i & 4 ? bb.max.z : bb.min.z,
          ).applyMatrix4(o.matrixWorld);
          mnx = Math.min(mnx, v.x); mny = Math.min(mny, v.y); mnz = Math.min(mnz, v.z);
          mxx = Math.max(mxx, v.x); mxy = Math.max(mxy, v.y); mxz = Math.max(mxz, v.z);
        }
        // 射线 vs AABB（slab）
        let t0 = 0, t1 = 8000, ok = true;
        const o0 = [origin.x, origin.y, origin.z], d0 = [dir.x, dir.y, dir.z];
        const mn = [mnx, mny, mnz], mx = [mxx, mxy, mxz];
        for (let i = 0; i < 3; i++) {
          if (Math.abs(d0[i]) < 1e-6) { if (o0[i] < mn[i] || o0[i] > mx[i]) { ok = false; break; } continue; }
          let ta = (mn[i] - o0[i]) / d0[i], tb = (mx[i] - o0[i]) / d0[i];
          if (ta > tb) { const s = ta; ta = tb; tb = s; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
          if (t0 > t1) { ok = false; break; }
        }
        if (!ok) return;
        const mat = o.material;
        hits.push({
          n: o.name || o.type,
          geo: g2.type,
          par: o.parent?.name || '',
          t: +t0.toFixed(0),
          ext: +ext.toFixed(0),
          y: [+mny.toFixed(1), +mxy.toFixed(1)],
          col: mat?.color ? '#' + mat.color.getHexString() : (mat?.type || '?'),
          tr: mat?.transparent ? 1 : 0,
          vis: o.visible,
        });
      });
      hits.sort((a, b) => a.t - b.t);
      return hits.slice(0, 14);
    })()`);
    console.log('DIAG ray hits:', JSON.stringify(r.result?.value, null, 1));
  }

  for (const T of want) {
    const r = await evaluate(`(async () => {
      const g = window.__game;
      // 每遍都重新钉一次（循环每帧会把 t 往前推一点）
      g.raceIntro.t = 9999 * ${T};
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      g.raceIntro.t = 9999 * ${T};
      g.post.render(1/60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.87);
    })()`);
    const v = r.result?.value;
    if (r.exceptionDetails) { console.log(`T=${T} EXC:`, r.exceptionDetails.exception?.description?.slice(0, 300)); continue; }
    if (typeof v !== 'string' || !v.startsWith('data:image')) { console.log(`T=${T} 截图失败`); continue; }
    await fs.mkdir(outDir, { recursive: true });
    const f = path.join(outDir, `${process.env.TAG || 'intro'}-${mapId}-${process.env.WEATHER || 'day'}-t${String(T).replace('.', 'p')}.jpg`);
    await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log(`T=${T} ok ->`, path.basename(f));
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
});
