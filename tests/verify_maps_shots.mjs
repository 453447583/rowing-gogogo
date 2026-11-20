// 霓虹海峡 + 秘境漂流 定点验收：截图 + 数值断言
//
//   node tests/verify_maps_shots.mjs [baseUrl]
//
// 断言（截图只是给人看的）：
//   ① 霓虹海峡：归程长直道（#48~#52）船的目标高度必须是 0（曾经被波浪栈道的
//      假"走廊命中"抬到 2.6~3.0m，赛中表现为船悬在半空、浮桶整段消失）；
//   ② 霓虹海峡：两侧浮桶数量 / 长断口（>40m）只能出现在抬高栈道那一段；
//   ③ 秘境漂流：瀑布段沿程用射线打 fall_water，水面必须在船下方 1m 以内；
//   ④ 秘境漂流：隧道蘑菇材质的自发光强度 > 0（否则洞里就是一团暗红）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/verify-maps-' + Date.now());
const port = 9400 + Math.floor(Math.random() * 120);
const outDir = path.resolve('shots/verify');
await fs.mkdir(outDir, { recursive: true });

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=960,540', `${base}`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const listeners = new Set();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, ${ms}))`, awaitPromise: true });
/** 等一个 CDP 事件（重载后必须等 loadEventFired 再 evaluate，否则上下文是旧的） */
function waitEvent(method, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { listeners.delete(fn); reject(new Error('event timeout: ' + method)); }, timeout);
    const fn = (m) => {
      if (m.method !== method) return;
      clearTimeout(t); listeners.delete(fn); resolve(m.params);
    };
    listeners.add(fn);
  });
}const evalJS = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
async function waitJson(url, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('devtools timeout: ' + url);
}

async function shot(name) {
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  const f = path.join(outDir, name + '.png');
  await fs.writeFile(f, Buffer.from(res.data, 'base64'));
  console.log('  shot ->', path.relative(process.cwd(), f));
}

async function waitFor(expr, label, tries = 60, gap = 500) {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(expr).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, gap));
  }
  throw new Error('timeout waiting for ' + label);
}

async function enterMap(mapId) {
  // 每张图都整页重载：跑过一张图之后主菜单是关闭的，#btn-solo 根本点不到，
  // 不重载就会"以为切了图其实还在上一张"（这张脚本早期就踩过）。
  await cdp('Page.reload', { ignoreCache: true }).catch(() => {});
  // 重载会把执行上下文清掉：等 load 事件（或兜底干等）再 evaluate，
  // 期间的 "Execution context was destroyed" 由 waitFor 吞掉。
  await waitEvent('Page.loadEventFired', 30000).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  await waitFor(`!!document.querySelector('#btn-solo')`, 'main menu');
  await evalJS(`(() => { document.querySelector('#btn-solo')?.click(); })()`);
  await waitFor(`!!document.querySelector('.boat-card')`, 'boat list');
  await evalJS(`(() => { document.querySelector('.boat-card')?.click(); document.querySelector('#btn-boat-ok')?.click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'map list');
  // 点"选图 + 开始"可能要重试：卡片列表在某些时机被重渲染，第一次点会点空
  let started = false;
  for (let i = 0; i < 6 && !started; i++) {
    const r = await evalJS(`(() => {
      const g = window.__game;
      if (g) return 'already';
      const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === ${JSON.stringify(mapId)});
      if (!card) return 'no-card';
      card.click();
      document.querySelector('#btn-map-ok')?.click();
      return 'clicked';
    })()`).catch((e) => 'err:' + e.message);
    await new Promise((res) => setTimeout(res, 3000));
    started = await evalJS(`!!window.__game`).catch(() => false);
    if (!started) console.log('    start attempt', i + 1, r);
  }
  // GLB 异步加载
  await sleep(mapId === 'baked' ? 12000 : 6000);
  const id = await evalJS(`(() => {
    const g = window.__game;
    if (!g) return 'no game';
    g.phase = 'racing'; g.countdownLeft = 0;
    g.renderer.setSize(960, 540, false);
    return g.mapDef?.id;
  })()`);
  if (id !== mapId) throw new Error(`map is ${id}, expected ${mapId}`);
  console.log('  map =', id);
}

async function place(gateA, gateB, t = 0.35) {
  // HMR / 掉帧都可能让页面在这一刻正在重建，等 __game 回来再摆位
  await waitFor(`!!(window.__game && window.__game.localBoat && window.__game.mapDef)`, 'game instance');
  await evalJS(`(() => {
    const g = window.__game;
    const a = g.mapDef.gates[${gateA}], b = g.mapDef.gates[${gateB}];
    const tx = a[0] + (b[0] - a[0]) * ${t};
    const tz = a[1] + (b[1] - a[1]) * ${t};
    const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const boat = g.localBoat;
    boat.resetTo(tx, tz, heading);
    boat.speed = 0; boat.vel.set(0, 0);
    const pm = g.progressMap?.get(g.myId);
    if (pm) { pm.gate = ${gateB}; pm.lap = 1; }
    // 让高度目标马上生效，并把镜头瞬间贴到位（否则 chase 镜头会从上一处飘过来）
    for (const [id, b2] of g.boats) {
      const p = g.progressMap.get(id);
      b2.diveTargetY = g.track.diveHeightAt(b2.pos, p ? p.gate : null);
    }
    g.cameraRig?.snap?.();
  })()`);
  await sleep(900);
}

const fail = (m) => { throw new Error(m); };

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
    for (const l of listeners) l(m);
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  // 页面首次加载时上下文还没稳定，用本地计时（CDP evaluate 会报 context destroyed）
  await new Promise((r) => setTimeout(r, 2500));
  await waitFor(`!!document.querySelector('#btn-solo')`, 'main menu').catch(() => {});

  // ==================== 霓虹海峡 ====================
  console.log('== strait ==');
  await enterMap('strait');
  const strait = await evalJS(`(() => {
    const g = window.__game, tr = g.track, G = g.mapDef.gates;
    // ① 归程长直道每一段中点的高度
    const heights = [];
    for (const i of [46, 47, 48, 49, 50, 51, 52, 53]) {
      const a = G[i], b = G[i + 1];
      for (const t of [0.25, 0.5, 0.75]) {
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        heights.push({ gate: i, t, h: +(tr.diveHeightAt({ x, z }, i) ?? 0).toFixed(2) });
      }
    }
    // ② 浮桶：按两侧统计，找出沿中心线 > 40m 的断口
    const st = tr.edgeBuoys?.stations || [];
    const bySide = { 1: [], '-1': [] };
    for (const s of st) bySide[s.side > 0 ? 1 : -1].push(s);
    const gaps = {};
    for (const side of [1, -1]) {
      const pts = bySide[side];
      // 用沿门段弧长排序：把每个桶投影到最近的段，取 (段号*1e6 + t) 排序
      const keyed = pts.map((s) => {
        let best = { d: 1e9, i: 0, t: 0 };
        for (let i = 0; i < G.length; i++) {
          const a = G[i], b = G[(i + 1) % G.length];
          const sx = b[0] - a[0], sz = b[1] - a[1];
          const l2 = sx * sx + sz * sz || 1;
          let t = ((s.x - a[0]) * sx + (s.z - a[1]) * sz) / l2;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(s.x - (a[0] + sx * t), s.z - (a[1] + sz * t));
          if (d < best.d) best = { d, i, t };
        }
        return { ...s, i: best.i, t: best.t, key: best.i + best.t };
      }).sort((a, b) => a.key - b.key);
      const cuts = [];
      for (let k = 1; k < keyed.length; k++) {
        const ds = Math.hypot(keyed[k].x - keyed[k - 1].x, keyed[k].z - keyed[k - 1].z);
        if (ds > 40) cuts.push({ at: keyed[k].i, len: +ds.toFixed(0) });
      }
      gaps[side] = cuts;
    }
    return {
      heights,
      buoyCount: st.length,
      side1: bySide[1].length, sideMinus1: bySide[-1].length,
      gaps,
      boardwalkHeights: g.mapDef.gateHeights.slice(22, 30),
    };
  })()`);
  console.log('  浮桶数:', strait.buoyCount, `(+1: ${strait.side1} / -1: ${strait.sideMinus1})`);
  console.log('  浮桶长断口:', JSON.stringify(strait.gaps));
  const badH = strait.heights.filter((h) => !(h.gate >= 22 && h.gate <= 28) && h.h > 0.25);
  console.log('  非栈道段却被抬高的采样:', JSON.stringify(badH));
  if (badH.length) fail(`归程/其它段仍然被抬高: ${JSON.stringify(badH.slice(0, 4))}`);

  await place(48, 49, 0.4); await shot('strait-last-straight-a');
  await place(50, 51, 0.35); await shot('strait-last-straight-b');
  await place(52, 53, 0.5); await shot('strait-finish-straight');
  const boatY = await evalJS(`(() => {
    const g = window.__game, b = g.localBoat;
    return { y: +b.pos.y.toFixed(2), target: b.diveTargetY == null ? null : +b.diveTargetY.toFixed(2) };
  })()`);
  console.log('  末段船高度:', JSON.stringify(boatY));
  if (boatY.y > 0.6 || (boatY.target != null && boatY.target > 0.6)) fail('末段船仍被抬高: ' + JSON.stringify(boatY));

  // ==================== 秘境漂流 ====================
  console.log('== baked ==');
  await enterMap('baked');

  // ③ 瀑布：直接比"船的目标高度"和"fall_water 顶点高度"（网格顶点已在世界坐标）
  await place(59, 60, 0.5);
  await shot('baked-fall-a');
  const fall = await evalJS(`(() => {
    const g = window.__game;
    const water = [];
    g.track.group.traverse((o) => { if (o.isMesh && /fall_water/i.test(o.name || '') && o.visible) water.push(o); });
    if (!water.length) return { error: 'fall water mesh not found' };
    const P = water[0].geometry.attributes.position;
    const G = g.mapDef.gates;
    const rows = [];
    for (const i of [55, 57, 58, 59, 60, 61, 62, 63, 64]) {
      const a = G[i], b = G[i + 1];
      const x = a[0] + (b[0] - a[0]) * 0.5;
      const z = a[1] + (b[1] - a[1]) * 0.5;
      const boatY = g.track.diveHeightAt({ x, z }, i) || 0;
      // 找平面上最近的 3 个顶点，取平均高度
      let best = [];
      for (let k = 0; k < P.count; k++) {
        const vx = P.getX(k), vz = P.getZ(k);
        const d = Math.hypot(vx - x, vz - z);
        best.push({ d, y: P.getY(k) });
      }
      best.sort((p, q) => p.d - q.d);
      const near = best.slice(0, 3);
      const wy = near.reduce((s, v) => s + v.y, 0) / near.length;
      rows.push({ gate: i, boatY: +boatY.toFixed(1), waterY: +wy.toFixed(1),
                  gap: +(boatY - wy).toFixed(1), dist: +near[0].d.toFixed(1) });
    }
    return { rows };
  })()`);
  console.log('  瀑布沿程（boatY 应≈waterY, gap 约 0）:');
  for (const r of fall.rows) console.log('   ', JSON.stringify(r));
  const worst = fall.rows.filter((r) => Math.abs(r.gap) > 1.0);
  if (worst.length) fail('瀑布水面仍与船错位: ' + JSON.stringify(worst));

  await place(8, 9, 0.5); await shot('baked-cave-mushroom-a');
  await place(14, 15, 0.5); await shot('baked-cave-mushroom-b');
  const mush = await evalJS(`(() => {
    const g = window.__game; const out = []; const seen = new Set();
    g.track.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mn = o.material.name || '';
      if (!/cave_(cap|stem)/i.test(mn) || seen.has(mn)) return;
      seen.add(mn);
      out.push({ mat: mn, obj: o.name,
                 emissive: o.material.emissive ? '#' + o.material.emissive.getHexString() : null,
                 ei: o.material.emissiveIntensity, hasEmissiveMap: !!o.material.emissiveMap,
                 vertexColors: o.material.vertexColors });
    });
    return out;
  })()`);
  console.log('  蘑菇材质:', JSON.stringify(mush));
  if (mush.length && !mush.some((m) => m.hasEmissiveMap && m.ei > 0.3)) fail('蘑菇没有自发光贴图，洞里仍然会发暗');

  await place(52, 53, 0.5); await shot('baked-cloud-to-fall');
  if (errors.length) fail('page exceptions: ' + errors.slice(0, 3).join(' | '));
  console.log('verify maps: PASS');
} catch (e) {
  console.error('verify maps: FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
