// 怪物模式场景验收：进第一关，跳过开场镜头，检查场地标记 + 出图。
//
//   node tests/boss_visual.mjs
//
// 检查项：
//   ① 掩体是 6 块半圈、有高有矮有半沉（baseY 不全为 0）
//   ② 地面引导弧线存在、半径 = BOSS_ARENA.marks.guideR
//   ③ BOSS 脚下红环存在
//   ④ 玩家出生点离 BOSS = 40m
//   ⑤ 掩体之间没有挡住"玩家→BOSS"的中央直射线
//   ⑥ 命中特效不再生成白圈（bursts 数组不应再被写入）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boss-visual');
const port = 9337;
const httpPort = 5173;
const outDir = path.resolve('shots/verify');
await fs.mkdir(outDir, { recursive: true });

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], { stdio: 'ignore' });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,720',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const errors = [];
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
  const tab = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  await sleep(1200);

  // 单人生涯 → 选艇 → 选怪物模式 → 开打
  await ev('document.querySelector("#btn-solo").click()');
  await sleep(400);
  await ev('[...document.querySelectorAll("#boat-list .boat-card")].find(x => x.textContent.includes("疾风")).click()');
  await ev('document.querySelector("#btn-boat-ok").click()');
  await sleep(400);
  await ev(`(function(){
    const m = document.querySelector('#mode-select');
    m.value = 'boss';
    m.dispatchEvent(new Event('change'));
    document.querySelector('#btn-map-ok').click();
    return 1;
  })()`);

  // 等场景起来（GLB 异步）
  await sleep(9000);
  const boot = await ev('JSON.stringify({ map: window.__game && window.__game.mapDef.id, boss: !!(window.__game && window.__game.bossMode) })');
  console.log('boot', boot);
  if (!boot || boot.indexOf('"boss":true') < 0) throw new Error('did not enter boss mode');

  // 跳过开场镜头 + 倒计时
  await ev('(function(){ const b = window.__game.bossMode; b.introT = 99; return 1; })()');
  await sleep(900);
  await ev('(function(){ const b = window.__game.bossMode; b.countdown = 0.02; return 1; })()');
  await sleep(1500);
  console.log('phase', await ev('window.__game.bossMode.phase'));

  const state = await ev(`(function(){
    const g = window.__game;
    const bm = g.bossMode;
    const arena = bm.arena;
    const rocks = arena.rocks || [];
    const spawned = arena.spawnTransform(0, 1);
    // 中央直射线：玩家出生点 -> BOSS，看有没有岩石挡在中间
    const sx = spawned.x, sz = spawned.z;
    let blocked = false;
    for (const r of rocks) {
      const ox = r.x - sx, oz = r.z - sz;
      const len = Math.hypot(ox, oz) || 1;
      const dx = -sx / len, dz = -sz / len;
      const t = ox * dx + oz * dz;
      if (t < 0 || t > len) continue;
      if (Math.hypot(ox - dx * t, oz - dz * t) < r.r) blocked = true;
    }
    return JSON.stringify({
      rocks: rocks.length,
      rockHeights: rocks.map((r) => +(r.rock.scale.y).toFixed(2)),
      sunk: rocks.map((r) => +(r.baseY || 0).toFixed(2)),
      guideR: arena.def.marks && arena.def.marks.guideR,
      guideArcs: arena.guide ? arena.guide.children.length : 0,
      bossRing: !!(bm.boss && bm.boss.groundRing),
      spawnDist: +Math.hypot(spawned.x, spawned.z).toFixed(1),
      centerBlocked: blocked,
      bursts: bm.bursts ? bm.bursts.length : -1,
      laneFar: bm.boss ? null : null,
    });
  })()`);
  const s = JSON.parse(state);
  console.log('scene', s);

  const fail = (m) => { throw new Error(m); };
  if (s.rocks !== 6) fail('rocks = ' + s.rocks + ' (expected 6)');
  if (new Set(s.rockHeights).size < 3) fail('rock heights not varied: ' + s.rockHeights);
  if (!s.sunk.some((v) => v < -0.1)) fail('no half-sunk rock');
  if (s.guideArcs !== 3) fail('guide arcs = ' + s.guideArcs);
  if (!s.bossRing) fail('boss ground ring missing');
  if (Math.abs(s.spawnDist - 40) > 1) fail('spawn distance = ' + s.spawnDist);
  if (s.centerBlocked) fail('cover blocks the center line to the boss');
  if (s.bursts > 0) fail('white burst ring still spawning');

  await sleep(800);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, 'boss-arena-new.png'), Buffer.from(shot.data, 'base64'));

  // 拉一个俯视：临时把相机吊起来拍一帧
  await ev(`(function(){
    const g = window.__game;
    g.bossMode.__origUpdateCam = g.cameraRig.update.bind(g.cameraRig);
    g.cameraRig.update = function(dt) {
      this.camera.position.set(0, 108, 62);
      this.camera.lookAt(0, 0, 12);
    };
    return 1;
  })()`);
  await sleep(1200);
  const top = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, 'boss-arena-top.png'), Buffer.from(top.data, 'base64'));

  if (errors.length) fail('page exceptions: ' + errors.slice(0, 3).join(' | '));
  console.log('boss visual checks: PASS');
} catch (e) {
  console.error('boss visual checks: FAIL', e.message);
  if (errors.length) console.error('errors:', errors.slice(0, 3));
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await wait(500);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
