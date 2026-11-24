// 云端天梯 2026-11-24 改动验收：
//   ① 第一层浮在竞技场海面上（水面可见 + 下沉到 WATER_Y）
//   ② 每层地面是玻璃（透明、不封底，能看穿到海面）
//   ③ 每层天空复用 WEATHERS（层号 → 天气）
//   ④ 掉出第一层 → 落海 → 沉没 → 回第一层
//   node tests/sky_tower_glass_water_probe.mjs
// 截图：shots/verify/sky-tower-glass-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/towerwater-${stamp}`);
const port = 9980 + (Number(stamp.slice(-2)) % 15);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const child = spawn(edge, [
  '--headless=new', '--no-sandbox',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { fails.push(label); console.log('  ✗ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}
async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting ' + expr + ' (last=' + JSON.stringify(last) + ')');
}
async function shot(camExpr, file) {
  // 必须先停掉 rAF：主循环每帧都会用 CameraRig 覆盖相机，不停就是"机位白设"
  const dataUrl = val(await evaluate(`(() => { const g=window.__game;
    cancelAnimationFrame(g.rafId);
    ${camExpr || ''}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.9);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    ok(false, '截图 ' + file, String(dataUrl).slice(0, 120)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, '截图 ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

try {
  const info = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });

  console.log('\n[1] 进入天梯模式（晴朗白天）');
  await cdp('Page.navigate', { url });
  await sleep(3000);
  try {
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 15000);
  } catch {
    await cdp('Page.reload', { ignoreCache: true });
    await sleep(3000);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000);
  }
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='0';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);
  ok(val(await evaluate(`window.__game.mode`)) === 'skytower', '模式为 skytower');

  // 快进到 fight（跳过标题卡与航拍）
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(500);

  console.log('\n[2] 第一层浮在海面上');
  const w = JSON.parse(val(await evaluate(`(()=>{const g=window.__game;
    return JSON.stringify({vis:g.water.mesh.visible, y:g.water.mesh.position.y, skyFall:'ok',
      waterY:g.bossMode.scenery.constructor.name});})()`)));
  ok(w.vis === true, '水面可见（不再是隐藏状态）', w);
  ok(Math.abs(w.y + 6) < 0.01, '水面下沉到 -6m（第一层下方 6m）', w);

  console.log('\n[3] 玻璃地面');
  const gl = JSON.parse(val(await evaluate(`(()=>{const s=window.__game.bossMode.scenery;
    const mats=s.glassMats||[];
    return JSON.stringify({n:mats.length, tr:mats.every(m=>m.transparent===true),
      dw:mats.every(m=>m.depthWrite===false),
      op:mats.map(m=>+m.uniforms.uOpacity.value.toFixed(3)),
      plat:s.platforms.length});})()`)));
  ok(gl.n === 10, '10 层都用玻璃材质', gl.n);
  ok(gl.tr && gl.dw, '玻璃透明且不写深度（能看穿到下层/海面）', gl);
  ok(gl.op.every((o) => o > 0.02 && o < 0.2), '玻璃基础不透明度很低', gl.op);

  console.log('\n[4] 每层天空复用现有天气');
  const rawTw = val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    const out=[];
    for(const layer of [0,1,2,3,4,5]){
      p.layer=layer; boat.skyLayer=layer; boat.pos.y=layer*18+0.4;
      b.update(1/60, layer);
      const s=b.scenery;
      out.push({layer, id:s.weather?.id, zenith:s.skyMat.uniforms.uZenith.value.getHexString(),
        stars:s.skyMat.uniforms.uStars.value, cover:+s.skyMat.uniforms.uCloudCover.value.toFixed(2),
        fogDensity:+g.scene.fog.density.toExponential(1)});
    }
    return JSON.stringify({base:b.baseWeatherId, out});})()`));
  if (typeof rawTw !== 'string' || !rawTw.startsWith('{')) {
    ok(false, '读取每层天气失败', String(rawTw).slice(0, 400));
    throw new Error('天气探针失败: ' + String(rawTw).slice(0, 400));
  }
  const tw = JSON.parse(rawTw);
  console.log('  ' + JSON.stringify(tw.out.map((o) => o.layer + ':' + o.id)));
  ok(tw.base === 'day', '第一层天气 = 大厅选的天气（day）', tw.base);
  const ids = tw.out.map((o) => o.id);
  ok(ids[0] === 'day' && ids[1] === 'dusk' && ids[2] === 'storm' && ids[3] === 'blizzard' && ids[4] === 'starry',
    '层号按 WEATHERS 顺序切天气（day→dusk→storm→blizzard→starry）', ids);
  ok(tw.out[4].stars > 0.5 && tw.out[0].stars === 0, '星空层才有星场', tw.out.map((o) => o.stars));
  ok(tw.out.every((o) => o.fogDensity <= 1e-5), '切层后场景雾仍是近 0（天空球不被染平）', tw.out.map((o) => o.fogDensity));
  const uniqZenith = new Set(tw.out.map((o) => o.zenith));
  ok(uniqZenith.size === 5, '5 种天气的天顶色各不相同', [...uniqZenith]);
  // 切层是低频事件，但一次要连带 env.setWeather（重烘 PMREM）+ 建雨/雪，
  // 卡太久会变成"上楼瞬间一顿"。200ms 是宽松上限，实测远低于它。
  const cost = +val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.layer=1; boat.skyLayer=1; boat.pos.y=18.4;
    const t0=performance.now(); b.update(1/60,1); return +(performance.now()-t0).toFixed(1);})()`));
  ok(cost < 200, '切层（含整条天气链）耗时可接受', cost + 'ms');
  console.log('  切层耗时: ' + cost + 'ms');

  console.log('\n[5] 掉出第一层 → 落海');
  const fall = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.invuln=0; p.fallWater=null; boat.skyFall=false;
    p.layer=0; boat.skyLayer=0; boat.pos.set(200, 0.4, 0);
    b.arena.constrain(boat, 1/60);
    const started = !!p.fallWater && boat.skyFall === true;
    let minY = boat.pos.y;
    // 跑完整段落海动画（下落 1.15s + 沉没 0.55s），全程记录最低点
    for(let i=0;i<130;i++){ b.update(1/60, i/60); minY=Math.min(minY, boat.pos.y); }
    const mid = {minY:+minY.toFixed(2)};
    return JSON.stringify({started, mid, after:{y:+boat.pos.y.toFixed(2), skyFall:boat.skyFall,
      layer:p.layer, fw:p.fallWater, invuln:+p.invuln.toFixed(2), d:Math.hypot(boat.pos.x,boat.pos.z).toFixed(1)}});})()`)));
  console.log('  ' + JSON.stringify(fall));
  ok(fall.started === true, '第一层越界直接进入落海（不是落下一层）', fall);
  ok(fall.mid.minY < -3, '船真的掉到海面高度（不是原地弹回）', fall.mid);
  ok(fall.after.skyFall === false && fall.after.fw === null, '落海结束后状态复位', fall.after);
  ok(fall.after.layer === 0 && Math.abs(fall.after.y - 0.4) < 0.6, '回到第一层平台高度', fall.after);
  ok(+fall.after.d < 70, '落点在出生圈内（不会被立刻判定再次坠落）', fall.after);

  console.log('\n[6] 截图');
  // 高空俯视：看得到玻璃层 + 下面的海
  const cam = `window.__game.camera.position.set(150, 96, 210); window.__game.camera.lookAt(0, 12, 0);`;
  const w0 = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.layer=0; boat.skyLayer=0; boat.pos.set(0,0.4,60); b.update(1/60,1);
    return JSON.stringify({id:b.scenery.weather.id});})()`)));
  ok(w0.id === 'day', '第 1 层是白天', w0);
  await shot(cam, 'sky-tower-glass-day.jpg');
  // 抬头看天：验收"每层天空就是那套天气"
  await evaluate(`(()=>{const g=window.__game; g.camera.position.set(0, 40, 150); g.camera.lookAt(0, 260, 150); return 1;})()`);
  await shot('', 'sky-tower-sky-day.jpg');
  // 暴风雨层（第 3 层）
  const w2 = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.layer=2; boat.skyLayer=2; boat.pos.set(0, 36.4, 40); b.update(1/60,2);
    return JSON.stringify({id:b.scenery.weather.id});})()`)));
  ok(w2.id === 'storm', '第 3 层是暴风雨', w2);
  await shot(cam, 'sky-tower-glass-storm.jpg');
  await evaluate(`(()=>{const g=window.__game; g.camera.position.set(0, 76, 120); g.camera.lookAt(0, 300, 120); return 1;})()`);
  await shot('', 'sky-tower-sky-storm.jpg');
  // 星空层（第 5 层）
  const w4 = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.layer=4; boat.skyLayer=4; boat.pos.set(0, 72.4, 30); b.update(1/60,4);
    g.camera.position.set(60, 150, 200); g.camera.lookAt(0, 60, 0);
    return JSON.stringify({id:b.scenery.weather.id});})()`)));
  ok(w4.id === 'starry', '第 5 层是星空', w4);
  await shot('', 'sky-tower-glass-starry.jpg');
  // 第一层近景：透过玻璃看海
  await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.layer=0; boat.skyLayer=0; boat.pos.set(0,0.4,70); b.update(1/60,5);
    g.camera.position.set(0, 6, 96); g.camera.lookAt(0, -6, 0); return 1;})()`);
  await shot('', 'sky-tower-glass-water.jpg');

  // 落海瞬间：船应在海面上、有水花
  const dur = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.invuln=0; p.fallWater=null; boat.skyFall=false;
    p.layer=0; boat.skyLayer=0; boat.pos.set(200,0.4,0);
    b.arena.constrain(boat,1/60);
    for(let i=0;i<76;i++) b.update(1/60, i/60);
    g.camera.position.set(170, 26, 120); g.camera.lookAt(190, -6, 20);
    return JSON.stringify({y:+boat.pos.y.toFixed(2), fw:!!p.fallWater, splashed:!!p.fallWater?.splashed});})()`)));
  console.log('  ' + JSON.stringify(dur));
  ok(dur.fw === true && Math.abs(dur.y + 5.65) < 1.2, '落海瞬间船贴在海面上（不是悬空/反弹）', dur);
  await shot('', 'sky-tower-glass-dive.jpg');

  console.log('\n[7] 控制台错误检查');
  await sleep(500);
  const real = errors.filter((e) => !/effekseer\.min\.js|wasm:\/\/wasm/.test(e));
  ok(real.length === 0, '无未捕获异常（排除 Effekseer 环境噪声）', real.slice(0, 3));

  console.log('\n结果: ' + (fails.length ? `失败 ${fails.length} 项` : '全部通过'));
  if (fails.length) console.log(fails.join('\n'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  fails.push('PROBE EXCEPTION: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
process.exitCode = fails.length ? 1 : 0;
