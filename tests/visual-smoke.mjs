import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// 浏览器配置必须落在项目盘（D:），跑完立刻删。
// 以前写死在 C:\Users\...\.codex\... 下，无头浏览器配置越攒越多，C 盘被吃掉 5GB+。
const profile = path.resolve('D:/3dgame-tmp/browser/visual-smoke');
const port = 9227;
const outputScreenshot = path.resolve('dragon-palace-visual.png');
const screenshot = 'D:\\3Dgame - 副本\\dragon-palace-visual.png';
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  // 无头下没有真实 GPU，必须显式允许 swiftshader 软件光栅，
  // 否则 WebGL 上下文创建失败，页面会一直卡在启动阶段
  '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`,
  // 软件光栅很慢：1440×900 下龙宫场景每帧要数秒，断言排队排到超时。
  // 缩到 1024×640，帧耗时砍一半以上
  `--user-data-dir=${profile}`, '--window-size=1024,640', 'http://127.0.0.1:5173/',
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function waitForJson(url, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
try {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  // tabs[0] 不一定是游戏页：Edge 自带扩展会留一个 background_page 目标，
  // 连到它上面所有 evaluate 都拿不到 window.__game。按 URL 挑真正的页面目标。
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
  if (!page) throw new Error(`no game page target: ${tabs.map((t) => `${t.type}:${t.url}`).join(' | ')}`);
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  // 连上时页面可能还在初始导航（about:blank → 游戏页），此时 evaluate 会报
  // "Execution context was destroyed"。显式导航一次，等到按钮真的存在再往下走。
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  const evaluate = async (expression) => {
    try {
      return await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    } catch (e) {
      if (/context was destroyed|Cannot find context|Inspected target navigated/i.test(e.message)) return { result: {} };
      throw e;
    }
  };
  // 页面刚打开时菜单按钮的点击监听可能还没挂上（模块脚本晚于 DOM 解析执行），
  // 固定 sleep 会偶发“点了没反应、后面全是空点击”。改成等到菜单真的出现再往下走。
  const waitUntil = async (expression, timeout = 12000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = await evaluate(expression);
      if (r.result?.value) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await waitUntil(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`, 20000);
  console.log('[visual] menu ready');
  const click = async (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
  await click('#btn-solo');
  // 点击也要重试：首帧时菜单脚本可能还没绑定监听，单次点击会静默落空
  const boatMenuShown = await waitUntil(`(() => { const el = document.querySelector('#menu-boat'); if (!el || el.classList.contains('hidden')) { document.querySelector('#btn-solo')?.click(); return false; } return true; })()`, 12000);
  if (!boatMenuShown) throw new Error('boat menu did not open');
  await waitUntil(`document.querySelectorAll('#boat-list .boat-card').length > 0`);
  await cdp('Runtime.evaluate', {
    expression: `(() => [...document.querySelectorAll('#boat-list .boat-card')].find(x => x.textContent.includes('疾风'))?.click())()`,
  });
  await click('#btn-boat-ok');
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 300))`, awaitPromise: true });
  await waitUntil(`!document.querySelector('#menu-map')?.classList.contains('hidden')`);
  console.log('[visual] map menu ready');
  await cdp('Runtime.evaluate', {
    expression: `(() => { const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === 'palace' || x.textContent.includes('龙宫')); card?.click(); const mode = document.querySelector('#mode-select'); if (mode) { mode.value = 'item'; mode.dispatchEvent(new Event('change')); } const ai = document.querySelector('#solo-ai'); if (ai) ai.value = '1'; document.querySelector('#btn-map-ok')?.click(); })()`,
  });
  // 地图 GLB 加起来几十 MB，无头软件渲染下解析很慢，给模型加载留足时间
  await waitUntil(`!!window.__game?.localBoat?.modelRoot`, 45000).catch(async (e) => {
    const dump = await cdp('Runtime.evaluate', {
      expression: `(() => ({ has: !!window.__game, boat: window.__game?.localBoat?.def?.id, mr: !!window.__game?.localBoat?.modelRoot, menuMap: document.querySelector('#menu-map')?.className, res: performance.getEntriesByType('resource').filter(e => e.name.includes('.glb')).map(e => e.name.split('/').pop() + ':' + e.responseStatus + ':' + e.transferSize), boatModelUrl: window.__game?.localBoat?.def?.model }))()`,
      returnByValue: true,
    });
    throw new Error(`${e.message} | ${JSON.stringify(dump.result.value)}`);
  });
  // 模型刚挂上时还没跑过一帧，艇体 yaw 要等 Boat 的逐帧逻辑写回才稳定
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 800))`, awaitPromise: true });
  console.log('[visual] boat model mounted');
  const falconVisual = await cdp('Runtime.evaluate', {
    expression: `(() => { const b = window.__game?.localBoat; return { id: b?.def?.id, modelLoaded: !!b?.modelRoot, wrapperYaw: b?.modelRoot?.rotation?.y }; })()`,
    returnByValue: true,
  });
  assert.equal(falconVisual.result.value.id, 'falcon', 'visual test selected the Falcon');
  assert.equal(falconVisual.result.value.modelLoaded, true, 'Falcon GLB loaded before orientation check');
  // yacht.glb 内部节点已经把船首朝 +Z，falcon 的 visualRotationY 是 0（见 boats.js），
  // 岛民旧断言要求 π/2 是过期值
  assert.ok(Math.abs(falconVisual.result.value.wrapperYaw - 0) < 1e-6, 'Falcon wrapper keeps its authored yaw (0) after animation starts');
  await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; if (!g?.localBoat) return; g.phase = 'racing'; g.countdownLeft = 0; const b = g.localBoat; b.resetTo(158, 75, Math.atan2(-15, 50)); b.speed = 10; b.vel.set(Math.sin(b.heading) * 10, Math.cos(b.heading) * 10); const pm = g.progressMap?.get(g.myId); if (pm) pm.gate = 2; })()`,
  });
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 450))`, awaitPromise: true });
  const approach = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile('D:\\3Dgame - 副本\\dragon-palace-approach.png', Buffer.from(approach.data, 'base64'));
  await cdp('Runtime.evaluate', {
    expression: `(() => { const keys = window.__game?.opts?.input?.keys; if (!keys) return; keys.add('w'); keys.add('a'); keys.add('shift'); })()`,
  });
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 320))`, awaitPromise: true });
  const midDrift = await cdp('Runtime.evaluate', {
    expression: `(() => ({ angle: window.__game?.localBoat?.driftAngle || 0, heading: window.__game?.localBoat?.heading || 0, drifting: !!window.__game?.localBoat?.drifting, speed: window.__game?.localBoat?.speed || 0, keys: [...(window.__game?.opts?.input?.keys || [])] }))()`,
    returnByValue: true,
  });
  assert.ok(Math.abs(midDrift.result.value.angle) <= 0.53, `drift angle comfort bound while held: ${midDrift.result.value.angle}`);
  assert.ok(Math.abs(midDrift.result.value.angle) >= 0.03, `drift angle must build while held: ${midDrift.result.value.angle}`);
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 580))`, awaitPromise: true });
  await cdp('Runtime.evaluate', {
    expression: `(() => { window.__game?.opts?.input?.keys?.clear(); })()`,
  });
  const drift = await cdp('Runtime.evaluate', {
    expression: `(() => ({ angle: window.__game?.localBoat?.driftAngle || 0, heading: window.__game?.localBoat?.heading || 0 }))()`,
    returnByValue: true,
  });
  assert.ok(Math.abs(drift.result.value.angle) <= 0.53, `drift angle comfort bound after release: ${drift.result.value.angle}`);
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 900))`, awaitPromise: true });
  await cdp('Runtime.evaluate', {
    expression: `(() => { const b = window.__game?.localBoat; if (!b) return; b.nitroCharge = 0.58; b.nitroBottles = 1; })()`,
  });
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 120))`, awaitPromise: true });
  const nitroHud = await cdp('Runtime.evaluate', {
    expression: `(() => { const bar = document.querySelector('#nitro-wrap'); const stock = document.querySelector('#nitro-stock'); const slots = [...document.querySelectorAll('#nitro-stock .nitro-slot')]; return { barVisible: !!bar && !bar.classList.contains('hidden'), stockVisible: !!stock && !stock.classList.contains('hidden'), fill: document.querySelector('#nitro-fill')?.style.width || '', packedSlots: slots.filter((s) => s.classList.contains('packed')).length, rankVisible: !!document.querySelector('#hud-rank') && !document.querySelector('#hud-rank').classList.contains('hidden'), rankRows: document.querySelectorAll('#hud-rank .rank-row').length, rankMe: document.querySelector('#hud-rank .rank-row.me .rank-name')?.textContent || '', boatCount: window.__game?.boats?.size || 0 }; })()`,
    returnByValue: true,
  });
  assert.equal(nitroHud.result.value.barVisible, true, 'bottom drift charge gauge is visible during racing');
  assert.equal(nitroHud.result.value.stockVisible, true, 'upper-right nitro pack panel is visible during racing');
  // CSSOM 会把 '58.0%' 序列化成 '58%'，所以按数值比较而不是比字符串
  assert.ok(Math.abs(parseFloat(nitroHud.result.value.fill) - 58) < 0.2, `bottom gauge uses only current drift charge: ${nitroHud.result.value.fill}`);
  assert.equal(nitroHud.result.value.packedSlots, 1, 'upper-right panel independently renders stored nitro packs');
  assert.equal(nitroHud.result.value.rankVisible, true, 'left rank panel is visible during racing');
  assert.equal(nitroHud.result.value.rankRows, nitroHud.result.value.boatCount, 'left rank panel lists every boat');
  assert.ok(nitroHud.result.value.rankMe.length > 0, 'left rank panel highlights the local player');
  await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; if (!g?.localBoat || !g.items) return; const b = g.localBoat; const pm = g.progressMap?.get(g.myId); if (pm) pm.prog = 2; const ai = g.aiBoats?.[0]; const aiId = [...g.boats.entries()].find(([, boat]) => boat === ai)?.[0]; const aiPm = aiId ? g.progressMap?.get(aiId) : null; if (ai && aiPm) { ai.updateLocal = () => {}; ai.pos.set(b.pos.x + Math.sin(b.heading) * 20, b.pos.y, b.pos.z + Math.cos(b.heading) * 20); ai.heading = b.heading; ai.speed = 0; ai.vel.set(0, 0); aiPm.prog = 20; g.items.getRank = (id) => id === aiId ? 1 : 2; } g.items.myItems[0] = 'magnet'; g.items.useItem(g.myId, 'magnet', 0); })()`,
  });
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 220))`, awaitPromise: true });
  const state = await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; const p = g?.env?.palaceProp; const walls = g?.track?.edgeWalls || []; const materials = new Set(walls.map(w => w.material)); const reticle = g?.items?.magnetReticle; return { canvas: !!document.querySelector('canvas'), game: !!g, boats: g?.boats?.size || 0, palace: g?.mapDef?.id || null, coaster: !!g?.track?.coasterCurve, edgeWalls: walls.length, neonWalls: walls.filter(w => w?.userData?.edgeType === 'neon').length, buoys: g?.track?.edgeBuoys?.count || 0, buoys: g?.track?.edgeBuoys?.count || 0,
        buoys: g?.track?.edgeBuoys?.count || 0, sharedNeonMaterial: materials.size === 1, magnetReticleVisible: !!reticle?.group?.visible, magnetTargetLocked: !!reticle?.locked?.visible, magnetNeutralVisible: !!reticle?.neutral?.visible, palacePosition: p ? [p.position.x, p.position.y, p.position.z] : null }; })()`,
    returnByValue: true,
  });
  const rail = await cdp('Runtime.evaluate', {
    expression: `(() => { const c = window.__game?.track?.coasterCurve; if (!c) return null; let prev = null; let maxStep = 0; let minY = Infinity; let maxY = -Infinity; for (let i = 0; i <= 48; i++) { const p = c.getPointAt(i / 48); if (prev) maxStep = Math.max(maxStep, p.distanceTo(prev)); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); prev = p; } return { maxStep, minY, maxY }; })()`,
    returnByValue: true,
  });
  assert.equal(state.result.value.canvas, true);
  assert.equal(state.result.value.game, true);
  assert.equal(state.result.value.palace, 'palace');
  assert.equal(state.result.value.coaster, true);
   // 赛道边界已改为浮桶链表达，霓虹光墙整体停用（用户要求）
   assert.equal(state.result.value.edgeWalls, 0, 'neon edge walls are retired in favour of buoy chains');
   assert.ok(state.result.value.buoys >= 20, `track edges are marked by buoy chains: ${state.result.value.buoys}`);
   assert.equal(state.result.value.sharedNeonMaterial, true, 'main course and shortcuts share one neon material');
   assert.equal(state.result.value.magnetReticleVisible, true, 'magnet aim shows a world-space reticle');
   assert.equal(state.result.value.magnetTargetLocked, true, 'magnet aim marks the locked target with a red reticle');
  assert.equal(state.result.value.magnetNeutralVisible, false, 'locked targets replace the neutral bow reticle');
  assert.ok(rail.result.value && rail.result.value.maxStep < 15, `coaster curve is continuous: ${JSON.stringify(rail.result.value)}`);
  assert.ok(rail.result.value.maxY > 8 && rail.result.value.minY < -1, `coaster has a readable rise and water entry: ${JSON.stringify(rail.result.value)}`);
  await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; if (!g?.localBoat) return; g.showPodium([{ id: g.myId, name: 'Visual Test', boatId: g.localBoat.def.id }]); })()`,
  });
  await cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, 700))`, awaitPromise: true });
  const podiumScene = await cdp('Runtime.evaluate', {
    expression: `(() => { const g = window.__game; const p = g?.podiumGroup; if (!p) return null; const e = g.camera.matrixWorld.elements; const fx = -e[8], fy = -e[9], fz = -e[10]; const dx = p.position.x - g.camera.position.x, dy = p.position.y - g.camera.position.y, dz = p.position.z - g.camera.position.z; const distance = Math.hypot(dx, dy, dz); return { x: p.position.x, z: p.position.z, distance, facing: (fx * dx + fy * dy + fz * dz) / distance, podiumBoats: p.children.filter(x => x.userData?.podiumBoat).length }; })()`,
    returnByValue: true,
  });
  assert.deepEqual([podiumScene.result.value.x, podiumScene.result.value.z], [215, -205], 'Dragon Palace podium uses its offshore anchor');
  assert.ok(podiumScene.result.value.distance > 10 && podiumScene.result.value.distance < 24, `podium camera keeps a close readable view: ${podiumScene.result.value.distance}`);
  assert.ok(podiumScene.result.value.facing > 0.98, `podium camera directly faces the offshore stage: ${podiumScene.result.value.facing}`);
  assert.equal(podiumScene.result.value.podiumBoats, 1, 'completed racers appear on the world-space podium');
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(outputScreenshot, Buffer.from(shot.data, 'base64'));
  console.log('visual integration checks: PASS', state.result.value, 'rail=', rail.result.value, 'podium=', podiumScene.result.value, 'nitro=', nitroHud.result.value, 'drift=', { mid: midDrift.result.value, released: drift.result.value });
} catch (err) {
  console.error('visual integration checks: FAIL', err);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  // 收尾：把临时浏览器配置删掉，别在磁盘上留垃圾
  await new Promise((r) => setTimeout(r, 400));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
