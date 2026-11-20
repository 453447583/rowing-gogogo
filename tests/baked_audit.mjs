// 秘境漂流（baked）网格审计 + 逐门验图
//
//   node tests/baked_audit.mjs                # 审计 + 默认门号截图
//   GATES=22,24,26 node tests/baked_audit.mjs  # 只拍指定门
//   AUDIT_ONLY=1 node tests/baked_audit.mjs    # 只出 JSON，不截图（快）
//
// 审计内容（全部序列化回 node 端）：
//   · 每个 baked_* / 程序化网格的材质名、包围盒、三角面数
//   · 包围盒中心到赛道中心线的最近距离 + 距该处水面的高差
//     → 用来找"横跨赛道的巨大物体"（距离 < 走廊半宽 且 bbox 高于水面）
//   · bbox.min.y 与水面几乎重合的网格 → z-fighting / 白色闪烁嫌疑
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/baked-audit-${stamp}`);
const port = 9680 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const outDir = path.resolve('shots/verify');
const gates = (process.env.GATES || '22,24,26,28,32,36,40,44,48,52,56,60,66,72,80,95,120,150,180')
  .split(',').map(Number);
const auditOnly = process.env.AUDIT_ONLY === '1';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=960,560', url,
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

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return await r.json(); } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('devtools 没起来');
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
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 400));
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
    const c = cards.find(x => x.dataset.map === 'baked');
    if (!c) return 'missing';
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error('baked 地图选不到');
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ok = false;
  while (Date.now() - t2 < 60000) {
    if ((await evaluate('!!window.__game && !!window.__game.track')).result?.value) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) throw new Error('对局没起来');
  await sleep(Number(process.env.WARM || 22000));

  await evaluate(`(() => { const g = window.__game; g.phase = 'racing'; g.countdownLeft = 0; })()`);

  // ---------- 网格审计 ----------
  const audit = await evaluate(`(() => {
    const g = window.__game;
    const THREEg = g.track.group;
    const gates = g.track.gates;
    const gateY = g.track.gateY;
    const N = gates.length;
    const HW = g.track.gateWidth;
    const near = (x, z) => {
      let best = { d: 1e9, i: 0, t: 0 };
      for (let i = 0; i < N; i++) {
        const a = gates[i], b = gates[(i + 1) % N];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L2 = dx * dx + dz * dz || 1;
        let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = a[0] + dx * t, pz = a[1] + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best.d) best = { d, i, t };
      }
      return best;
    };
    const out = [];
    THREEg.updateMatrixWorld(true);
    THREEg.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geo = o.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox.clone().applyMatrix4(o.matrixWorld);
      const cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
      const n = near(cx, cz);
      const y0 = gateY[n.i] ?? 0, y1 = gateY[(n.i + 1) % N] ?? y0;
      const deck = y0 + (y1 - y0) * n.t;
      const tri = geo.index ? geo.index.count / 3 : (geo.attributes.position ? geo.attributes.position.count / 3 : 0);
      // 竖向是否覆盖"水面上下"——z-fighting 的典型特征
      const straddle = bb.min.y < deck + 0.35 && bb.max.y > deck - 0.35;
      out.push({
        name: o.name || '(unnamed)',
        parent: o.parent?.name || '',
        mat: o.material?.name || '',
        vis: o.visible,
        tri: Math.round(tri),
        bb: [ +bb.min.x.toFixed(1), +bb.min.y.toFixed(1), +bb.min.z.toFixed(1),
              +bb.max.x.toFixed(1), +bb.max.y.toFixed(1), +bb.max.z.toFixed(1) ],
        gate: n.i, dist: +n.d.toFixed(1), deck: +deck.toFixed(1),
        aboveWater: +(bb.max.y - deck).toFixed(1),
        inCorridor: n.d < HW + 1.0 && bb.max.y > deck + 0.3,
        straddle,
      });
    });
    return out;
  })()`);
  const list = audit.result?.value || [];
  await fs.mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, 'baked_audit.json');
  await fs.writeFile(jsonPath, JSON.stringify(list, null, 1));
  console.log(`审计 ${list.length} 个网格 -> ${path.basename(jsonPath)}`);

  const visible = list.filter((m) => m.vis);
  const intrude = visible.filter((m) => m.inCorridor).sort((a, b) => a.dist - b.dist);
  console.log('\n=== 侵入走廊（bbox 中心距中线 < 走廊半宽+1 且高出水面）===');
  for (const m of intrude.slice(0, 25)) {
    console.log(`  g${m.gate} d=${m.dist} +${m.aboveWater}m tri=${m.tri} ${m.name} [${m.mat}] bb=${m.bb.join(',')}`);
  }
  const strad = visible.filter((m) => m.straddle);
  console.log('\n=== 与水面共面（z-fighting 嫌疑）===');
  for (const m of strad.slice(0, 25)) {
    console.log(`  g${m.gate} d=${m.dist} tri=${m.tri} ${m.name} [${m.mat}] bbY=${m.bb[1]}~${m.bb[4]} deck=${m.deck}`);
  }
  console.log('\n=== 全部可见网格（按门号）===');
  for (const m of visible.slice().sort((a, b) => a.gate - b.gate)) {
    console.log(`  g${m.gate}\td=${m.dist}\ttri=${m.tri}\t${m.name}\t[${m.mat}]\tbb=${m.bb.join(',')}`);
  }

  // ---------- 走廊射线扫描：找"横跨在航道上方的东西" ----------
  // 合并网格（return_bank_proc / decor_* / forest_*）的包围盒横跨整图，靠 bbox 永远
  // 判不出来。改成从水面正上方往下打射线：只要第一命中点比该处水面高出 2.2m 以上，
  // 就说明那个位置的天上/头顶确实有东西压着 —— 这正是"巨大物体横跨赛道"的判据。
  const rays = await evaluate(`(() => {
    const g = window.__game;
    const T = g.track;
    const gates = T.gates, gateY = T.gateY, N = gates.length, HW = T.gateWidth;
    // 页面里没有 THREE 全局，也拿不到 Raycaster —— 改成逐顶点世界坐标扫描。
    // 合并网格的 bbox 横跨全图毫无意义，但顶点一定落在真实位置上。
    const V3 = g.camera.position.constructor;
    const M4 = T.group.matrixWorld.constructor;
    const v = new V3();
    const SE = [];   // 每段：ax,az,dx,dz,L2,deck0,deck1
    for (let i = 0; i < N; i++) {
      const a = gates[i], b = gates[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      SE.push([a[0], a[1], dx, dz, dx * dx + dz * dz || 1, gateY[i] ?? 0, gateY[(i + 1) % N] ?? (gateY[i] ?? 0)]);
    }
    T.group.updateMatrixWorld(true);
    const over = new Map(), nearW = new Map();
    const bump = (map, key, gate, y, deck, extra) => {
      const e = map.get(key) || { key, n: 0, minG: 1e9, maxG: -1, maxY: -1e9, maxAbove: -1e9, lat: 0 };
      e.n++;
      if (gate < e.minG) e.minG = gate;
      if (gate > e.maxG) e.maxG = gate;
      if (y > e.maxY) e.maxY = y;
      const ab = y - deck;
      if (ab > e.maxAbove) e.maxAbove = ab;
      if (extra) e.lat = Math.min(e.lat, extra);
      map.set(key, e);
    };
    const tmp = new M4();
    T.group.traverse((o) => {
      if (!o.isMesh || !o.visible || !o.geometry) return;
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      const key = (o.name || '(unnamed)') + '|' + (o.material?.name || '');
      const inst = o.isInstancedMesh ? o.count : 1;
      const step = Math.max(1, Math.floor(pos.count / 4000));
      for (let ii = 0; ii < inst; ii++) {
        let base = o.matrixWorld;
        if (o.isInstancedMesh) {
          o.getMatrixAt(ii, tmp);
          base = tmp.premultiply(o.matrixWorld);
        }
        for (let k = 0; k < pos.count; k += step) {
          v.fromBufferAttribute(pos, k).applyMatrix4(base);
          let best = 1e9, bi = 0, bt = 0;
          for (let s = 0; s < SE.length; s++) {
            const e = SE[s];
            let t = ((v.x - e[0]) * e[2] + (v.z - e[1]) * e[3]) / e[4];
            t = t < 0 ? 0 : (t > 1 ? 1 : t);
            const px = e[0] + e[2] * t, pz = e[1] + e[3] * t;
            const dd = (v.x - px) * (v.x - px) + (v.z - pz) * (v.z - pz);
            if (dd < best) { best = dd; bi = s; bt = t; }
          }
          const d = Math.sqrt(best);
          if (d > HW + 0.6) continue;
          const e = SE[bi];
          const deck = e[5] + (e[6] - e[5]) * bt;
          if (v.y > deck + 2.2) bump(over, key, bi, v.y, deck);
          else if (v.y > deck - 0.45 && v.y < deck + 1.7) bump(nearW, key, bi, v.y, deck, d);
        }
      }
    });
    const ser = (m) => [...m.values()].map((e) => ({
      key: e.key, n: e.n, minG: e.minG, maxG: e.maxG,
      maxAbove: +e.maxAbove.toFixed(1), maxY: +e.maxY.toFixed(1), lat: +e.lat.toFixed(1),
    }));
    return { over: ser(over), nearW: ser(nearW) };
  })()`);
  if (rays.exceptionDetails) {
    console.log('sweep EXC:', rays.exceptionDetails.exception?.description?.slice(0, 500));
  }
  const over = rays.result?.value?.over || [];
  const nearW = rays.result?.value?.nearW || [];
  console.log('\n=== 走廊上空有顶点（高出水面 2.2m 以上、横向在走廊内）===');
  for (const e of over.sort((a, b) => b.maxAbove - a.maxAbove).slice(0, 20)) {
    console.log(`  +${e.maxAbove}m y≈${e.maxY} gate ${e.minG}..${e.maxG} x${e.n} ${e.key}`);
  }
  console.log('\n=== 走廊内贴着水面的顶点（白色闪烁 / 穿插嫌疑）===');
  for (const e of nearW.sort((a, b) => b.n - a.n).slice(0, 20)) {
    console.log(`  y≈${e.maxY} gate ${e.minG}..${e.maxG} x${e.n} 最近 ${e.lat}m ${e.key}`);
  }

  if (auditOnly) return;

  // ---------- 逐门验图 ----------
  for (const gi of gates) {
    const r = await evaluate(`(() => {
      const g = window.__game;
      const N = g.mapDef.gates.length;
      const a = g.mapDef.gates[${gi} % N], b = g.mapDef.gates[(${gi} + 1) % N];
      const t = 0.5;
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const boat = g.localBoat;
      boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
      boat.speed = 0; boat.vel.set(0, 0);
      const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = ${gi}; pm.lap = 1; }
      boat.diveTargetY = g.track.diveHeightAt(boat.pos, ${gi});
      boat.pos.y = boat.diveTargetY ?? boat.pos.y;
      for (let i = 0; i < 180; i++) g.cameraRig.follow(boat, 1 / 60);
      return { y: +(boat.diveTargetY ?? 0).toFixed(1), camY: +g.camera.position.y.toFixed(1) };
    })()`);
    if (r.exceptionDetails) { console.log(`g${gi} EXC`, r.exceptionDetails.exception?.description?.slice(0, 200)); continue; }
    await sleep(Number(process.env.SETTLE || 1200));
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
    const f = path.join(outDir, `baked-audit-g${gi}.jpg`);
    await fs.writeFile(f, Buffer.from(shot.data, 'base64'));
    console.log(`g${gi}`, JSON.stringify(r.result?.value), '->', path.basename(f));
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
