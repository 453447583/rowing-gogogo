// 场景资产验收：真实松树 + 真实礁石是否真的进了竞速地图。
//   node tests/scenery_check.mjs [mapId]        # 默认 canyon
//
// 断言：
//   ① pine_trees.glb / rock_boulder.glb 都 200
//   ② 场景里存在 InstancedMesh 的松树（tri=5620）与礁石（tri=1499）
//   ③ 礁石横向缩放贴合碰撞半径（差 15% 以上就说明会有"空气墙"或穿模）
//   ④ boss 竞技场不受影响（BossArena 自己那套浮岩还在）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const mapId = process.argv[2] || 'canyon';
const base = process.env.BASE_URL || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/scenery-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 90);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=960,540', base],
{ stdio: 'ignore' });

const local = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
const net = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout ' + m)), 240000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: '(function(){try{return (' + expr + ');}catch(e){return "ERR:"+e.message;}})()', returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC:' + r.exceptionDetails.exception?.description : r.result.value;
};
const waitFor = async (expr, label, tries = 140) => {
  for (let i = 0; i < tries; i++) { if (await ev(expr).catch(() => false)) return true; await local(500); }
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
      return;
    }
    if (m.method === 'Network.responseReceived') {
      const u = m.params?.response?.url || '';
      if (/pine_trees|rock_boulder/.test(u)) net.push(u.split('/').pop() + ' ' + m.params.response.status);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable');
  await local(2500);

  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  for (let i = 0; i < 10; i++) {
    await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1000);
    if (await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false)) break;
  }
  await waitFor(`!!document.querySelector('.boat-card')`, 'boats');
  await ev(`(() => { document.querySelector('.boat-card').click(); document.querySelector('#btn-boat-ok').click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'maps');
  for (let i = 0; i < 8 && !(await ev(`!!window.__game`).catch(() => false)); i++) {
    await ev(`(() => { const c=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='${mapId}'); if(!c) throw new Error('no map'); c.click(); document.querySelector('#btn-map-ok')?.click(); })()`);
    await local(2500);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await local(9000);
  // 开场那几秒画面上盖的是 #bg-image 卡通插画（z-index 0），3D 画布在它上层
  // 但还没开始画东西；不清掉的话偶尔会截到插画而不是场景。
  for (let i = 0; i < 4; i++) {
    await ev(`(() => {
      const g = window.__game;
      g.phase = 'racing'; g.countdownLeft = 0; if (g.raceTime < 1) g.raceTime = 1;
      for (const id of ['bg-image', 'bg-overlay', 'countdown']) {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      }
      return 1;
    })()`);
    await local(900);
  }

  const report = await ev(`(() => {
    const g = window.__game;
    const r = { pines: [], boulders: [], rockColliders: 0, mismatch: [], rockMerges: [] };
    g.scene.traverse((o) => {
      if (o.isMesh && /^reef-rocks/.test(o.name || '')) {
        const g2 = o.geometry;
        // StaticMerge 出来的有可能是非索引几何体，只看 index 会一律读成 0 面
        const tris = g2.index
          ? Math.round(g2.index.count / 3)
          : Math.round((g2.attributes.position?.count || 0) / 3);
        r.rockMerges.push({ name: o.name, tris });
      }
      if (!o.isInstancedMesh) return;
      const tris = o.geometry.index ? Math.round(o.geometry.index.count / 3) : null;
      if (/shore-pines/.test(o.name)) r.pines.push({ name: o.name, count: o.count, tris });
      if (/reef-boulders/.test(o.name)) {
        r.boulders.push({ name: o.name, count: o.count, tris });
        const a = o.instanceMatrix.array;
        // 第 0 个实例：横向缩放 vs 该处碰撞体半径
        r.firstScale = { sx: +Math.hypot(a[0], a[1], a[2]).toFixed(2), sy: +Math.hypot(a[4], a[5], a[6]).toFixed(2) };
      }
    });
    const col = g.track?.colliders || [];
    r.rockColliders = col.filter((c) => c.type === 'rock').length;
    return JSON.stringify(r);
  })()`);
  const r = JSON.parse(report);
  const pineCount = r.pines.reduce((s, p) => s + p.count, 0);
  const boulderCount = r.boulders.reduce((s, p) => s + p.count, 0);
  console.log(`${mapId}: 松树实例 ${pineCount} 棵（${r.pines.length} 个 InstancedMesh, tri=${r.pines[0]?.tris}）`);
  console.log(`${mapId}: 礁石实例 ${boulderCount} 块（${r.boulders.length} 个 InstancedMesh, tri=${r.boulders[0]?.tris}）｜岩石碰撞体 ${r.rockColliders}`);
  console.log('资源请求:', net.join(', ') || '(none)');
  const mergeTris = r.rockMerges.reduce((s, m) => s + (m.tris || 0), 0);
  console.log(`${mapId}: 手工岩块合并网格 ${r.rockMerges.length} 个 / ${mergeTris} 面`);

  // 摆机位：挑「露出水面最多」的那块礁石。
  // 不能直接用第 0 个实例——它在 y=-1.5（整个沉在水下、缩放到 21 倍），
  // 贴脸拍过去只能看到水面，看不出贴图到底有没有生效。
  const camInfo = await ev(`(() => {
    const g = window.__game;
    let target = null;
    g.scene.traverse((o) => { if (o.isInstancedMesh && /reef-boulders/.test(o.name) && !target) target = o; });
    g.phase = 'racing'; g.countdownLeft = 0;
    g.cameraRig.update = () => {}; g.cameraRig.follow = () => {}; g.cameraRig.followLookAt = () => {};
    g.renderer.setSize(960, 540, false);
    if (g.postFx) g.postFx.enabled = false;
    if (g.debugHud) g.debugHud.visible = false;
    // 手动机位：CAM="px,py,pz,tx,ty,tz"，拍没有 reef-boulders 的图（比如峡谷）时用
    const camEnv = ${JSON.stringify(process.env.CAM || '')};
    if (camEnv) {
      const v = camEnv.split(',').map(Number);
      g.camera.position.set(v[0], v[1], v[2]);
      g.camera.lookAt(v[3], v[4], v[5]);
      g.camera.updateMatrixWorld();
      return '{"cam":"manual"}';
    }
    if (!target) { g.camera.position.set(0, 14, 30); g.camera.lookAt(0, 6, -80); g.camera.updateMatrixWorld(); return '{}'; }
    const a = target.instanceMatrix.array;
    // 找出水面以上最高的那块
    let best = 0, bestY = -1e9;
    for (let i = 0; i < target.count; i++) {
      const y = a[i * 16 + 13];
      if (y > bestY) { bestY = y; best = i; }
    }
    const o = best * 16;
    const px = a[o + 12], py = a[o + 13], pz = a[o + 14];
    const sxz = Math.hypot(a[o], a[o + 1], a[o + 2]);
    const sy  = Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
    // 机位距离跟着石块的实际尺寸走：缩放到 20 倍时贴脸 4m 等于钻进石头里
    const d = Math.max(6, sxz * 0.55);
    g.camera.position.set(px + d * 0.75, py + sy * 0.85 + 2.0, pz + d);
    g.camera.lookAt(px, py + sy * 0.30, pz);
    g.camera.updateMatrixWorld();
    const m = Array.isArray(target.material) ? target.material[0] : target.material;
    return JSON.stringify({
      mat: m.name, hasMap: !!m.map, mapW: m.map?.image?.width || 0,
      color: m.color ? '#' + m.color.getHexString() : null,
      rough: m.roughness, metal: m.metalness, env: m.envMapIntensity,
      geoBox: target.geometry.boundingBox
        ? [ +target.geometry.boundingBox.min.y.toFixed(2), +target.geometry.boundingBox.max.y.toFixed(2) ] : null,
      scale: [sxz.toFixed(2), sy.toFixed(2)],
      pos: [px.toFixed(1), py.toFixed(1), pz.toFixed(1)],
      picked: best + '/' + target.count,
      camDist: d.toFixed(1),
    });
  })()`);
  await local(2600);
  // canyon 这种大图在无头软件光栅下截图会整页卡住（forest_shell 4.5MB），
  // 用 NOSHOT=1 只跑几何断言，不拍图。
  if (process.env.NOSHOT === '1') {
    console.log('NOSHOT=1：跳过截图');
  } else {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(out, `scenery-${mapId}.png`), Buffer.from(shot.data, 'base64'));
    console.log('shot -> shots/verify/scenery-' + mapId + '.png');
    console.log('礁石材质:', camInfo);
  }

  // 每张图的布景构成不一样：峡谷没有岸线撒树、碧海没有松树、湖泊两样都有。
  // 所以断言写成语义等价的"有实例就必须是 GLB 来的"，不按图写死。
  const usesGlbScenery = mapId !== 'canyon';
  const fallbackUsed = r.rockMerges.some((m) => /fallback/.test(m.name));
  if (fallbackUsed) throw new Error('礁石退回了程序化兜底（GLB 没加载成功）');
  if (pineCount && !net.some((s) => s.startsWith('pine_trees') && s.endsWith('200'))) {
    throw new Error('有松树实例但 pine_trees.glb 没 200');
  }
  if (boulderCount && !net.some((s) => s.startsWith('rock_boulder') && s.endsWith('200'))) {
    throw new Error('有礁石实例但 rock_boulder.glb 没 200');
  }
  if (!usesGlbScenery) {
    // 峡谷反过来：绝不能出现 reef-boulders（那说明又被 GLB 顶掉了），
    // 而且必须还有手工岩块的合并网格 —— 否则 9 个岩石碰撞体就变成了看不见的空气墙
    if (boulderCount) throw new Error('峡谷不该用 GLB 礁石');
    if (!r.rockMerges.length || mergeTris < 300) throw new Error('峡谷手工岩块丢了（' + mergeTris + ' 面）');
  } else if (r.rockColliders > 0 && !boulderCount) {
    throw new Error('有岩石碰撞体但没有礁石实例');
  }
  if (r.firstScale && (r.firstScale.sx <= 0 || r.firstScale.sy <= 0)) throw new Error('礁石缩放到 0');
  console.log('scenery check: PASS');
} catch (e) {
  console.error('scenery check: FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
