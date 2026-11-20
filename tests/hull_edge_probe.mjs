// 船体边缘碰撞探针：量「船体外缘到底能压过浮桶线多少」
//
//   node tests/hull_edge_probe.mjs                 # 默认霓虹海峡
//   MAP=canyon BOAT=赤焰号 node tests/hull_edge_probe.mjs
//   MAP=strait GATES=3,12,30 node tests/hull_edge_probe.mjs
//
// 做法：把船摆到某门中心线上、船头正对赛道外侧，全油门往外顶 3 秒
// （每帧 updateLocal + track.constrain，跟真机完全同一条路径），
// 然后**用模型全部顶点**（非游戏内部轮廓，独立真值）量每个顶点到中心线的距离，
// 取最大值减掉走廊半径 edgeOffset：
//   over > 0 → 船体已经压过浮桶线 N 米还没被拦（穿模）
//   over ≈ 0 → 船体边缘正好停在浮桶线上（用户要求的口径）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/hulled-${stamp}`;
const port = 9700 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const boatName = process.env.BOAT || '';
const gateArg = process.env.GATES || '';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  // 选船（可选）：点缩略条里同名那张
  if (boatName) {
    await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
    await waitFor(`!!document.querySelector('.lp-card[data-boat]')`, 30000);
    await evaluate(`(function(){
      const c=[...document.querySelectorAll('.lp-card[data-boat]')].find(x=>x.textContent.includes(${JSON.stringify(boatName)}));
      if(c) c.click(); return !!c;
    })()`);
    await sleep(300);
  }
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  // 等船模加载完（轮廓从"hull 参数兜底"换成"模型真实凸包"要等这一下）
  await waitFor(`!!window.__game.localBoat.modelRoot`, 60000, 'glb model');
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {};
    return 1;
  })()`);
  await sleep(600);

  const hullOld = process.env.HULL === 'old' ? '1' : '0';
  const out = await evaluate(`(function(){
    const g = window.__game, tr = g.track, b = g.localBoat;
    // HULL=old：换回旧版「88% 宽 × 62% 长」的近似轮廓，用来量化修复前的穿模量
    if (${hullOld}) {
      const h = b.def.hull, hw = h.width * 0.5 * 0.88, hl = h.length * 0.5 * 0.62;
      b.hullFootprint = Float32Array.from([hw, hl, -hw, hl, -hw, -hl, hw, -hl]);
    }
    const N = tr.gates.length;
    const limit = Number.isFinite(tr.edgeOffset) ? tr.edgeOffset : tr.gateWidth - 0.6;
    const segs = (tr.openTrack && !tr.loopClosed) ? N - 1 : N;
    // 到中心线折线的最近距离（探针自己实现，不借用 Track 私有方法）
    const distToCenter = (x, z) => {
      let best = Infinity;
      for (let i = 0; i < segs; i++) {
        const a = tr.gates[i], c = tr.gates[(i + 1) % N];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const L2 = dx * dx + dz * dz || 1;
        let u = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = a[0] + dx * u, pz = a[1] + dz * u;
        const d = (x - px) * (x - px) + (z - pz) * (z - pz);
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };

    // ---- 真值：模型全部顶点（抽样）在船体局部坐标里的 XZ ----
    b.group.updateMatrixWorld(true);
    const c0 = Math.cos(b.heading), s0 = Math.sin(b.heading);
    const local = [];   // [right, fwd] 相对船位
    let meshes = 0;
    b.modelRoot.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const attr = o.geometry?.attributes?.position;
      if (!attr || attr.count < 3) return;
      meshes++;
      const e = o.matrixWorld.elements;
      const stride = Math.max(1, Math.floor(attr.count / 2500));
      const arr = attr.array;
      for (let i = 0; i < attr.count; i += stride) {
        const vx = arr[i * 3], vy = arr[i * 3 + 1], vz = arr[i * 3 + 2];
        // 顶点 → 世界（列主序 4x4）
        const wx = e[0] * vx + e[4] * vy + e[8] * vz + e[12];
        const wz = e[2] * vx + e[6] * vy + e[10] * vz + e[14];
        const dx = wx - b.pos.x, dz = wz - b.pos.z;
        // 世界偏移 → 船体局部（绕 Y 轴 -heading）
        local.push(c0 * dx - s0 * dz, s0 * dx + c0 * dz);
      }
    });
    if (!local.length) return { err: 'no mesh vertices' };

    // 近道区段：那里走廊是"主道 ∪ 近道"，用主道中线量会误报，跳过即可
    const scGates = new Set();
    for (const sc of tr.shortcuts || []) {
      for (let i = sc.from; i <= sc.to; i++) scGates.add(i % N);
    }

    const want = ${gateArg ? JSON.stringify(gateArg.split(',').map(Number)) : 'null'};
    const gates = want || (() => {
      const list = [];
      for (let i = 2; i < N - 4; i++) if (!scGates.has(i) && i % Math.max(1, Math.floor(N / 8)) === 0) list.push(i);
      return list.slice(0, 8);
    })();

    const rows = [];
    const DT = 1 / 60;
    for (const gateIdx of gates) {
      const side = rows.length % 2 === 0 ? 1 : -1;
      const a = tr.gates[(gateIdx - 1 + N) % N], c = tr.gates[gateIdx], n = tr.gates[(gateIdx + 1) % N];
      const fdx = n[0] - c[0], fdz = n[1] - c[1];
      const fl = Math.hypot(fdx, fdz) || 1;
      // 左法线（与 Track 一致：(x,z) 方向的左法线是 (dz,-dx) 的相反数）
      const nxp = -fdz / fl, nzp = fdx / fl;
      b.resetTo(c[0], c[1], Math.atan2(fdx, fdz));
      b.gateHint = gateIdx;
      // 船头正对赛道外侧
      b.heading = Math.atan2(nxp * side, nzp * side);
      b.speed = 0;
      let t = 0;
      for (let k = 0; k < 240; k++) {
        t += DT;
        b.updateLocal(DT, { throttle: 1, steer: 0, boost: false }, t, [], null);
        tr.constrain(b, DT);
      }
      // 量真值：模型每个顶点到中心线的距离
      let maxD = 0;
      const ch = Math.cos(b.heading), sh = Math.sin(b.heading);
      for (let i = 0; i < local.length; i += 2) {
        const lx = local[i], lz = local[i + 1];
        const wx = b.pos.x + ch * lx + sh * lz;
        const wz = b.pos.z - sh * lx + ch * lz;
        const d = distToCenter(wx, wz);
        if (d > maxD) maxD = d;
      }
      // 游戏内部轮廓（采样点）最外距离，用来核对两者一致
      let hullD = 0;
      const fp = b.hullFootprint;
      for (let i = 0; i < (fp?.length || 0); i += 2) {
        const lx = fp[i], lz = fp[i + 1];
        const wx = b.pos.x + ch * lx + sh * lz;
        const wz = b.pos.z - sh * lx + ch * lz;
        const d = distToCenter(wx, wz);
        if (d > hullD) hullD = d;
      }
      // 旧版口径还能再往外多少：旧版采样点收到 62% 长 / 88% 宽，外加 0.35m 容差。
      // 同一姿态下真值轮廓比旧采样点远多少 + 容差 = 旧版允许的穿模量。
      const halfL = (b.def?.hull?.length || 4.6) * 0.5;
      const halfW = (b.def?.hull?.width || 1.9) * 0.5;
      const oldPts = [
        [halfW * 0.88, halfL * 0.62], [-halfW * 0.88, halfL * 0.62],
        [halfW * 0.88, -halfL * 0.62], [-halfW * 0.88, -halfL * 0.62],
        [0, halfL * 0.62], [0, -halfL * 0.62], [0, 0],
      ];
      let oldD = 0;
      for (const [ox, oz] of oldPts) {
        const wx = b.pos.x + ch * ox + sh * oz;
        const wz = b.pos.z - sh * ox + ch * oz;
        oldD = Math.max(oldD, distToCenter(wx, wz));
      }
      rows.push({
        gate: gateIdx, side,
        over: +(maxD - limit).toFixed(3),          // 真值穿模量（>0 = 出线）
        hullOver: +(hullD - limit).toFixed(3),     // 内部碰撞轮廓
        legacy: +(maxD - oldD + 0.35).toFixed(2),  // 旧版规则下同一姿态还能再压进去多少
        lat: +distToCenter(b.pos.x, b.pos.z).toFixed(2),  // 船中心到中线距离（太小 = 没顶到墙）
        contact: +(b.wallContactTimer || 0).toFixed(2),
      });
    }
    const worst = rows.reduce((m, r) => Math.max(m, r.over), -Infinity);
    return {
      mapId: g.mapDef.id, boat: b.def.id, gateWidth: tr.gateWidth, limit: +limit.toFixed(2),
      outlinePts: (b.hullFootprint?.length || 0) / 2, verts: local.length / 2, meshes,
      worst: +worst.toFixed(3), rows,
    };
  })()`);

  console.log(JSON.stringify(val(out), null, 2));
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
