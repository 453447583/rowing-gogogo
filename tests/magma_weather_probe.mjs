// 熔岩「逐天气适配 + 障碍贴图」实机验收（无头 Edge + CDP）
//   用法：先起静态服务（npm run preview / node tests/serve-dist.mjs），再
//          node tests/magma_weather_probe.mjs
//
// 走的是**真实玩家路径**：每次 location.reload → 单人 → 选 magma → 选天气 →
// 开始比赛。天气只在对局开始时下发（没有中途切换 API），所以五档必须开五局。
//
// 验四件事：
//   ① 五档天气拿到的 id / 名称 / 光照 / 雾 / 大气参数彼此不同（不再永远 starry）
//   ② 障碍 GLB 真的带 UV + albedo 贴图 + 自发光贴图 + 烘焙顶点色，且已接入场景
//   ③ 每档出一张同机位实机图，肉眼可比的亮度/天幕差异
//   ④ 星夜额外一张近机位图，看岩石棱面与熔岩裂纹
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/magma-wx-${stamp}`);
const port = 9920 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const shots = path.resolve('shots/verify');
const WEATHERS = ['day', 'dusk', 'storm', 'blizzard', 'starry'];

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=720,420', 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
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

async function waitJson(u, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}

async function clickWhenReady(predicate, action, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (val(await evaluate(predicate)) === true) {
      await evaluate(action);
      return true;
    }
    await sleep(300);
  }
  return false;
}

/** 完整玩家路径：重载 → 单人 → magma → 指定天气 → 开赛 */
async function bootRace(weatherId) {
  await cdp('Page.navigate', { url });
  await sleep(1800);
  const entered = await clickWhenReady(
    `(() => { const b=document.querySelector('#btn-solo'); return !!b && typeof b.onclick==='function'; })()`,
    `(() => { const b=document.querySelector('#btn-solo'); b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); b.click(); })()`,
    60,
  );
  if (!entered) throw new Error('单人按钮不可用');
  for (let i = 0; i < 10; i++) {
    await sleep(600);
    if (val(await evaluate(`!!document.querySelector('#menu-main')?.classList.contains('hidden')`)) === true) break;
    await evaluate(`(() => { const b=document.querySelector('#btn-solo'); b?.click(); })()`);
  }

  let cards = false;
  for (let i = 0; i < 14 && !cards; i++) {
    await evaluate(`document.querySelector('#btn-lobby-map')?.click(); 1`);
    await sleep(700);
    cards = val(await evaluate(`!!document.querySelector('.lp-card[data-map]')`)) === true;
  }
  if (!cards) throw new Error('地图抽屉打不开');
  const picked = val(await evaluate(
    `(() => { const c=[...document.querySelectorAll('.lp-card[data-map]')].find(x=>x.dataset.map==='magma'); if(!c) return 'missing'; c.click(); return 'ok'; })()`,
  ));
  if (picked !== 'ok') throw new Error('magma 选不到');
  await sleep(400);

  if (weatherId) {
    let opened = false;
    for (let i = 0; i < 14 && !opened; i++) {
      await evaluate(`document.querySelector('#btn-lobby-weather')?.click(); 1`);
      await sleep(500);
      opened = val(await evaluate(`!!document.querySelector('[data-weather]')`)) === true;
    }
    if (!opened) throw new Error('天气抽屉打不开');
    const w = val(await evaluate(
      `(() => { const b=document.querySelector('[data-weather="${weatherId}"]'); if(!b) return 'missing'; b.click(); return 'ok'; })()`,
    ));
    if (w !== 'ok') throw new Error('天气选不到 ' + weatherId);
    await sleep(400);
  }

  await evaluate(`document.querySelector('#btn-start-race')?.click(); 1`);
  let ready = false;
  for (let i = 0; i < 90; i++) {
    ready = val(await evaluate('!!window.__game?.localBoat && !!window.__game?.track')) === true;
    if (ready) break;
    await sleep(500);
  }
  if (!ready) {
    const dbg = val(await evaluate(`(() => ({
      href: location.href, game: !!window.__game, boat: !!window.__game?.localBoat,
      lobby: !!document.querySelector('#lobby'),
      lobbyHidden: document.querySelector('#lobby')?.classList.contains('hidden'),
      cards: document.querySelectorAll('.lp-card[data-map]').length,
      startBtn: !!document.querySelector('#btn-start-race'),
      phase: window.__game?.phase, map: window.__game?.mapDef?.id,
    }))()`));
    console.log('DEBUG_NOT_READY', JSON.stringify(dbg));
    throw new Error('__game 未就绪 (' + weatherId + ')');
  }
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0; })()`);
  for (let i = 0; i < 40; i++) {
    const n = Number(val(await evaluate(
      `(() => (window.__game?.track?.magmaObstacles||[]).filter(x=>!!x.holder).length)()`,
    )) || 0);
    if (n >= 9) break;
    await sleep(400);
  }
  // 等贴图解码完（GLTFLoader 的贴图是异步解码的，早截会拍到白模）
  for (let i = 0; i < 20; i++) {
    const done = val(await evaluate(`(() => {
      const t=window.__game?.track; const o=(t?.magmaObstacles||[]).find(x=>!!x.holder);
      if (!o) return false;
      let mesh=null; o.holder.traverse(n=>{ if(!mesh && n.isMesh) mesh=n; });
      const img = mesh?.material?.map?.image;
      return !!img && img.width > 0;
    })()`));
    if (done === true) break;
    await sleep(300);
  }
}

async function shotSetup(expr) {
  const r = await evaluate(`(() => { const g=window.__game, b=g.localBoat, t=g.track; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.84);
  })()`);
  return val(r);
}

/**
 * 截图走「页面内 canvas 直读」而不是 CDP Page.captureScreenshot。
 * 坑（DEV_STATUS 四十五已记）：swiftshader 下 captureScreenshot 第二次调用会挂死，
 * 一个脚本只能稳定截一张。canvas.toDataURL 在同一任务里紧跟 render 调用，
 * 不受 drawingBuffer 清空影响，而且能反复截、能一次脚本出多张。
 */
async function saveShot(expr, file) {
  const dataUrl = await shotSetup(expr);
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    throw new Error('canvas 截图失败: ' + String(dataUrl).slice(0, 160));
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (buf.length < 6000) throw new Error(`canvas 截图疑似空白 (${file}, ${buf.length}B)`);
  await fs.writeFile(path.join(shots, file), buf);
  return file;
}

// 近机位：把船斜放在岩石侧前方，追尾相机正好压到岩体上，能看清棱面 / 贴图 / 裂纹
const ROCK_CAM = `
  const o=(t.magmaObstacles||[]).find(x=>!!x.holder) || t.magmaObstacles[0];
  const N=t.gates.length, ga=t.gates[o.gate], gb=t.gates[(o.gate+1)%N];
  const dx=gb[0]-ga[0], dz=gb[1]-ga[1], L=Math.hypot(dx,dz)||1;
  const ux=dx/L, uz=dz/L;
  b.resetTo(o.x-ux*8-uz*2.6, o.z-uz*8+ux*2.6, Math.atan2(ux,uz));
  b.speed=0; b.vel.set(0,0); b.airborne=false;
  for (let i=0;i<120;i++) g.cameraRig.follow(b, 1/60);
`;

// 统一的"障碍面前"机位：这样五档晴天/黄昏/雷暴/雪暴/星夜可以直接横向比亮度
const OBSTACLE_CAM = `
  const o=(t.magmaObstacles||[]).find(x=>!!x.holder) || t.magmaObstacles[0];
  const N=t.gates.length, ga=t.gates[o.gate], gb=t.gates[(o.gate+1)%N];
  const dx=gb[0]-ga[0], dz=gb[1]-ga[1], L=Math.hypot(dx,dz)||1;
  const ux=dx/L, uz=dz/L;
  b.resetTo(ga[0]-ux*14, ga[1]-uz*14, Math.atan2(ux,uz));
  b.speed=0; b.vel.set(0,0); b.airborne=false;
  for (let i=0;i<120;i++) g.cameraRig.follow(b, 1/60);
`;

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = tabs.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXC', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 240));
    }
  });
  ws.on('close', () => { for (const p of pending.values()) p.reject(new Error('cdp closed')); pending.clear(); });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  const rows = [];
  const files = [];
  for (const id of WEATHERS) {
    await bootRace(id);
    const diag = val(await evaluate(`(() => {
      const g=window.__game, e=g.env, w=g.weather, t=g.track;
      const fog = e.scene.fog;
      const o=(t.magmaObstacles||[]).find(x=>!!x.holder);
      let mesh=null; o?.holder?.traverse(n=>{ if(!mesh && n.isMesh) mesh=n; });
      return {
        id: w.id, name: w.name,
        sun: +e.sunLight.intensity.toFixed(3),
        hemi: +e.hemiLight.intensity.toFixed(3),
        fog: '#' + fog.color.getHexString(),
        fogDensity: +fog.density.toFixed(5),
        exposure: +(e.realSky?.u?.uExposure?.value ?? -1).toFixed(3),
        nightMix: +(e.realSky?.u?.uNightMix?.value ?? -1).toFixed(2),
        tint: '#' + (e.realSky?.u?.uTint?.value?.getHexString?.() ?? ''),
        horizon: '#' + (e.realSky?.u?.uHorizonColor?.value?.getHexString?.() ?? ''),
        waveScale: +(g.water?.uniforms?.uWaveScale?.value ?? -1).toFixed(2),
        dayCycle: !!e.dayCycleOn,
        nightSky: !!e.nightSky,
        rain: !!e.rain?.visible,
        snow: !!e.snow?.visible,
        rock: mesh ? {
          tris: (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3,
          uv: !!mesh.geometry.attributes.uv,
          vcol: !!mesh.geometry.attributes.color,
          albedo: mesh.material.map ? [mesh.material.map.image.width, mesh.material.map.image.height] : null,
          emissive: mesh.material.emissiveMap ? mesh.material.emissiveMap.image.width : null,
          emisIntensity: mesh.material.emissiveIntensity,
          repeatWrap: mesh.material.map?.wrapS === 1000,
        } : null,
      };
    })()`));
    if (!diag) throw new Error('诊断取不到 ' + id);
    rows.push(diag);
    console.log('WX', JSON.stringify(diag));

    files.push(await saveShot(OBSTACLE_CAM, `magma-weather-${id}.jpg`));
    // 白天最亮、星夜最暗，各补一张近机位看岩体细节
    if (id === 'day' || id === 'starry') {
      files.push(await saveShot(ROCK_CAM, `magma-rock-closeup-${id}.jpg`));
    }
  }

  // --- 断言 ---
  const fails = [];
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) fails.push('duplicate weather id ' + r.id);
    seen.add(r.id);
  }
  if (seen.size !== WEATHERS.length) fails.push(`only ${seen.size}/${WEATHERS.length} distinct weather ids reached the race`);
  for (const r of rows) {
    if (!r.rock) { fails.push(`${r.id}: no rock mesh in scene`); continue; }
    if (!r.rock.uv) fails.push(`${r.id}: rock has no UV`);
    if (!r.rock.vcol) fails.push(`${r.id}: rock has no baked vertex colour`);
    if (!r.rock.albedo) fails.push(`${r.id}: rock has no albedo texture`);
    if (!r.rock.emissive) fails.push(`${r.id}: rock has no emissive texture`);
    if (!r.rock.repeatWrap) fails.push(`${r.id}: albedo texture is not REPEAT-wrapped`);
  }
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  if (by.day && by.starry && !(by.day.sun > by.starry.sun)) fails.push('magma day is not brighter than the starry night');
  if (by.day && by.starry && !(by.day.fogDensity < by.starry.fogDensity)) fails.push('magma day is not clearer than the starry night');
  if (by.day && by.day.dayCycle) fails.push('magma day still runs the dynamic day cycle');
  if (by.storm && !by.storm.rain) fails.push('magma thunderstorm has no rain');
  if (by.blizzard && !by.blizzard.snow) fails.push('magma snowstorm has no snow');
  if (by.starry && !by.starry.nightSky) fails.push('magma starry night has no star field');
  const skys = rows.map((r) => r.tint + '/' + r.horizon);
  if (new Set(skys).size < rows.length) fails.push('sky tints are not distinct across weathers');
  const fogs = rows.map((r) => r.fog);
  if (new Set(fogs).size < rows.length) fails.push('scene fog colours are not distinct across weathers');

  console.log('SHOTS', files.join(' '));
  if (fails.length) {
    console.log('FAIL\n - ' + fails.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log('PASS 五档天气观感/参数互相可辨，障碍贴图已接入');
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
});
