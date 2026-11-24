// 局域网同步 / 逆流之门 / 远距离道具 三组回归探针（2026-11-22）
//
// 背景（用户报障）：
//   1. 一台电脑双开局域网，切到另一个客户端时它还卡在倒计时；已开跑的那一端
//      技能/名次判定全乱 —— 根因是隐藏标签页的 rAF 被浏览器暂停，
//      倒计时按 dt 累减就永久冻结。
//   2. 逆流之门：第一名用了会往"第 2 名身后"传（等于自罚）；传送后车头没改朝向，
//      经常背对赛道。
//   3. 距离过远时血枪/泡泡蜻蜓打出去没有受击效果 —— 血枪寿命固定 ≈64m、
//      追踪弹固定 8s，目标一远就在半路耗尽。
//
// 用法：WB_URL=http://127.0.0.1:5199/ node tests/lan_sync_gate_probe.mjs
// 只读验证（不改源码），PASS/FAIL 直接打印。

import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/sync-gate-${stamp}`);
const port = 9860 + (Number(stamp.slice(-3)) % 40);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = `${base}${base.includes('?') ? '&' : '?'}raceIntro=0`;

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 120000) {
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
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r.result?.value;

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

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
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (val(await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")'))) break;
    await sleep(250);
  }

  // ---------- 单人道具赛（2 个 AI，保证有"前一名"） ----------
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1200);
  for (let i = 0; i < 12; i++) {
    await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
    await sleep(600);
    if (val(await evaluate('!!document.querySelector(".lp-pill[data-mode]")'))) break;
  }
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-pill[data-mode]')].find((x) => x.dataset.mode === 'item');
    c?.click(); return !!c;
  })()`);
  await sleep(500);
  await evaluate(`(() => {
    const s = document.querySelector('#sel-ai');
    if (s) { s.value = '2'; s.dispatchEvent(new Event('change', { bubbles: true })); }
    return s?.value;
  })()`);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (val(await evaluate(`!!(window.__game && window.__game.items && window.__game.localBoat)`))) break;
    await sleep(300);
  }
  await evaluate(`(() => { const g = window.__game; g.phase = 'racing'; g.countdownLeft = 0; g.raceIntro && g.endRaceIntro?.(); return 1; })()`);
  await sleep(800);

  const st = val(await evaluate(`(() => { const g = window.__game; return {
    mode: g.mode, phase: g.phase, boats: g.boats.size, myId: g.myId,
    hasItems: !!g.items, ai: g.aiBoats.length,
  }; })()`));
  console.log('state:', JSON.stringify(st));
  ok(st.mode === 'item' && st.boats >= 3, `进入单人道具赛（${st.boats} 艘）`);

  // ---------- ① 隐藏标签页 4s：倒计时必须一次性补齐 ----------
  // 用真实的 visibilitychange 路径：先切 hidden，把"隐藏起点"倒拨 4s
  // （等价于在后台待了 4 秒、且后台补帧一次都没跑到），再切回 visible。
  const cd = val(await evaluate(`(async () => {
    const g = window.__game;
    const vis = (hidden) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    g.phase = 'countdown';
    g.raceIntro = null;
    g.countdownLeft = 3.999;
    const before = g.countdownLeft;
    vis(true);
    g._hiddenSince = performance.now() - 4000;
    g._hiddenSim = 0;            // 后台补帧一帧都没跑（被浏览器限流）
    vis(false);
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: +g.countdownLeft.toFixed(2), phase: g.phase, timerOff: g._hiddenTimer == null };
  })()`));
  ok(cd && cd.after === 0 && cd.phase === 'racing' && cd.timerOff,
    `隐藏 4s 且补帧未运行 → 倒计时一次性补齐并发车（left ${cd?.before}→${cd?.after}, phase=${cd?.phase}）`, cd);

  // ---------- ② 后台补帧定时器：模拟 visibilitychange ----------
  const bg = val(await evaluate(`(async () => {
    const g = window.__game;
    const e0 = g.elapsed;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    const timerOn = g._hiddenTimer != null;
    await new Promise((r) => setTimeout(r, 1400));
    const e1 = g.elapsed;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    return { timerOn, off: g._hiddenTimer == null, dElapsed: +(e1 - e0).toFixed(2), phase: g.phase };
  })()`));
  ok(bg && bg.timerOn && bg.off, '隐藏标签页时启动后台补帧、回来时停掉', bg);
  ok(bg && bg.dElapsed > 0.5, `后台补帧真的在推进世界（Δelapsed=${bg?.dElapsed}s）`, bg);

  // ---------- ③ 逆流之门：第一名不位移 ----------
  const g1 = val(await evaluate(`(() => {
    const g = window.__game;
    const mine = g.progressMap.get(g.myId);
    for (const [id, pm] of g.progressMap) pm.prog = id === g.myId ? 9999 : 10;
    mine.finished = false;
    const b = g.localBoat;
    const before = { x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2) };
    g.items.useItem(g.myId, 'gate');
    return { rank: g.__rankOf ? g.__rankOf(g.myId) : null,
      moved: +Math.hypot(b.pos.x - before.x, b.pos.z - before.z).toFixed(3), before };
  })()`));
  ok(g1 && g1.moved < 0.05, `第一名用逆流之门不换位置（位移 ${g1?.moved}m）`, g1);

  // ---------- ④ 逆流之门：第二名贴到前一名身后 + 车头朝正前方 ----------
  const g2 = val(await evaluate(`(() => {
    const g = window.__game;
    const aiId = [...g.boats.keys()].find((id) => id !== g.myId && g.aiBoats.includes(g.boats.get(id)));
    const ai = g.boats.get(aiId);
    const b = g.localBoat;
    // 造一个明确的名次：AI 第 1，我第 2，其余垫底
    let k = 0;
    for (const [id, pm] of g.progressMap) pm.prog = id === aiId ? 5000 : (id === g.myId ? 4000 : (k++ + 1));
    // 让船头先背对赛道，验证传送后会被掰正
    b.heading += Math.PI;
    const rp = g.track.respawnPoint(ai.pos, g.progressMap.get(aiId).gate, 10);
    const before = { rank: [...g.progressMap.entries()].filter(([, p]) => p.prog > 0).length };
    const okUse = g.items.useItem(g.myId, 'gate') !== false;
    const distAi = Math.hypot(b.pos.x - ai.pos.x, b.pos.z - ai.pos.z);
    const distTarget = rp ? Math.hypot(b.pos.x - rp.x, b.pos.z - rp.z) : null;
    // 船头与"落点赛道切线"的夹角
    let ang = null;
    if (rp) {
      let d = b.heading - rp.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ang = Math.abs(d);
    }
    return { okUse, distAi: +distAi.toFixed(2), distTarget: distTarget == null ? null : +distTarget.toFixed(2),
      ang: ang == null ? null : +(ang * 180 / Math.PI).toFixed(1), hasRp: !!rp };
  })()`));
  ok(g2 && g2.okUse, '逆流之门在第二名时正常生效', g2);
  ok(g2 && g2.distAi > 6 && g2.distAi < 20, `落点在目标身后约 10m（实际 ${g2?.distAi}m）`, g2);
  ok(g2 && g2.ang != null && g2.ang < 12, `传送后车头朝正前方（偏差 ${g2?.ang}°）`, g2);

  // ---------- ⑤ 远距离道具：血枪/泡泡蜻蜓的射程按距离自适应 ----------
  const far = val(await evaluate(`(() => {
    const g = window.__game;
    const aiId = [...g.boats.keys()].find((id) => id !== g.myId && g.aiBoats.includes(g.boats.get(id)));
    const ai = g.boats.get(aiId);
    const b = g.localBoat;
    // 把 AI 摆到正前方 220m（只在调用的这一瞬间生效：弹道参数在出手时定死）
    b.heading = 0;
    ai.pos.x = b.pos.x; ai.pos.z = b.pos.z + 220;
    ai.vel.set(0, 0); ai.speed = 0;
    let k = 0;
    for (const [id, pm] of g.progressMap) pm.prog = id === aiId ? 5000 : (id === g.myId ? 4000 : (k++ + 1));
    g.items.projectiles.length = 0;
    g.items.useItem(g.myId, 'bloodlance');
    const lance = g.items.projectiles[g.items.projectiles.length - 1];
    const lanceRes = lance ? { type: lance.type, life: +lance.life.toFixed(2),
      vx: +lance.vx.toFixed(1), vz: +lance.vz.toFixed(1) } : null;
    g.items.projectiles.length = 0;
    g.items.useItem(g.myId, 'bubblefly');
    const fly = g.items.projectiles[g.items.projectiles.length - 1];
    const flyRes = fly ? { type: fly.type, life: +fly.life.toFixed(2), target: fly.target } : null;
    return { lanceRes, flyRes, dist: 220 };
  })()`));
  ok(far && far.lanceRes && far.lanceRes.life > 1.5,
    `血枪射程按距离延长（220m → life ${far?.lanceRes?.life}s，旧版固定 0.58s）`, far);
  ok(far && far.lanceRes && Math.abs(far.lanceRes.vz) > 100 && Math.abs(far.lanceRes.vx) < 6,
    `血枪朝目标方向（vz=${far?.lanceRes?.vz}, vx=${far?.lanceRes?.vx}）`, far);
  ok(far && far.flyRes && far.flyRes.life > 8,
    `泡泡蜻蜓寿命按距离延长（220m → life ${far?.flyRes?.life}s，旧版固定 8s）`, far);

  console.log(failures ? `\nFAIL ${failures} 项` : '\nPASS 全部通过');
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退出 */ }
  await sleep(300);
});
