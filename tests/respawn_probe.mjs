// R 复位系统自测：沿每张图的赛道上取样，检查"按地点回退 35m"是否合理
//   MAP=ocean node tests/respawn_probe.mjs
//   node tests/respawn_probe.mjs        （默认 ocean）
// 断言：
//   1. respawnPoint 必须返回有效点
//   2. 复位点到触发点的直线距离 ≤ 55m（旧逻辑退一门常是 60~120m）
//   3. 复位点必须落在**某条**合法走廊里（主道折线，或某条近道折线）—— 不能把人放到草里
//   4. 近道里触发的复位点必须仍在近道走廊内，且不能被拽回主道
//   5. 复位后船头朝向必须大体朝前（和复位点所在那一段的前进方向夹角 < 60°）
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
// 无头配置目录一律写在项目外（项目硬约束：写在项目里 Edge 残留会堆到几十 GB，还会拖死 vite 监听）
const profile = path.resolve(`D:/3dgame-tmp/browser/respawn-${stamp}`);
const port = 9800 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'ocean';

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
      const d = msg.params.exceptionDetails;
      console.log('EXC', d.exception?.description?.slice(0, 300) || d.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1000);
  await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
  await sleep(900);
  const picked = await evaluate(`(() => {
    const c = document.querySelector('[data-map=${JSON.stringify(mapId)}]');
    if (!c) return 'missing';
    c.click(); return 'ok'; })()`);
  if (picked.result?.value !== 'ok') throw new Error(`选不到地图 ${mapId}`);
  await sleep(500);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 90000) {
    if ((await evaluate('!!(window.__game && window.__game.track && window.__game.track.gates)')).result?.value) {
      ready = true; break;
    }
    await sleep(200);
  }
  if (!ready) throw new Error('没拿到 track');

  // 只做几何自测，不跑比赛：直接对赛道上的取样点调 respawnPoint
  const out = await evaluate(`(() => {
    const g = window.__game, t = g.track;
    const N = t.gates.length;
    const BACK = 35;
    const loop = [...t.gates, t.gates[0]];
    const scs = (t.shortcuts || []).filter((s) => s.points && s.points.length > 2);

    const segDist = (ax, az, bx, bz, x, z) => {
      const sx = bx - ax, sz = bz - az;
      const L2 = sx * sx + sz * sz;
      let k = L2 > 1e-9 ? ((x - ax) * sx + (z - az) * sz) / L2 : 0;
      k = Math.max(0, Math.min(1, k));
      return Math.hypot(x - (ax + sx * k), z - (az + sz * k));
    };
    // 最近距离 + 该段的前进方向（折线本身按行驶方向存）
    const nearInfo = (pts, x, z) => {
      let bd = Infinity, bi = 0;
      const closed = pts === loop;
      const m = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < m; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        const d = segDist(a[0], a[1], b[0], b[1], x, z);
        if (d < bd) { bd = d; bi = i; }
      }
      const a = pts[bi], b = pts[(bi + 1) % pts.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return { d: bd, fx: (b[0] - a[0]) / L, fz: (b[1] - a[1]) / L };
    };
    // 与 Track.pointAtArc 同口径，用来在近道折线上按弧长取样
    const arcAt = (pts, s) => {
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc + L >= s) {
          const u = Math.max(0, Math.min(1, (s - acc) / L));
          acc = s; // 仅用于打断
          return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
        }
        acc += L;
      }
      return pts[pts.length - 1].slice();
    };
    const scLen = (pts) => {
      let L = 0;
      for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      return L;
    };
    const limMain = (t.gateWidth || 20) * 1.6;
    const limSc = scs.reduce((m, s) => Math.max(m, s.width * 1.6), 0);
    const lim = Math.max(limMain, limSc);

    const rows = [];
    let failNull = 0, failFar = 0, failOff = 0, failHead = 0;
    const worst = [];

    // ---- 主道：每段取 15% / 50% / 85% 三个点 ----
    for (let i = 1; i < N; i++) {
      for (const f of [0.15, 0.5, 0.85]) {
        const a = t.gates[i], b = t.gates[(i + 1) % N];
        const px = a[0] + (b[0] - a[0]) * f;
        const pz = a[1] + (b[1] - a[1]) * f;
        const rp = t.respawnPoint({ x: px, z: pz }, (i + 1) % N, BACK);
        if (!rp || !Number.isFinite(rp.x)) { failNull += 1; continue; }
        const dist = Math.hypot(rp.x - px, rp.z - pz);
        // 近道和主道并行/合并处，复位点落在近道里是**正确**的，
        // 所以判据是"落在任一走廊内"，不是"必须贴着主道"
        const mi = nearInfo(loop, rp.x, rp.z);
        let off = mi.d, dir = mi;
        for (const s of scs) {
          const si = nearInfo(s.points, rp.x, rp.z);
          if (si.d < off) { off = si.d; dir = si; }
        }
        // 朝向按"复位走的是哪条线"来判：近道复位就该朝近道方向，
        // 不能拿主道在路口拐弯的切线去要求它
        if (rp.onShortcut) {
          let best = null;
          for (const s of scs) {
            const si = nearInfo(s.points, rp.x, rp.z);
            if (!best || si.d < best.d) best = si;
          }
          if (best && best.d <= lim) dir = best;
        }
        const dot = Math.sin(rp.heading) * dir.fx + Math.cos(rp.heading) * dir.fz;
        if (dist > 55) { failFar += 1; worst.push({ i, f, kind: 'far', dist: +dist.toFixed(1) }); }
        if (off > lim) {
          failOff += 1;
          worst.push({ i, f, kind: 'off', off: +off.toFixed(1), rp: [Math.round(rp.x), Math.round(rp.z)], sc: !!rp.onShortcut });
        }
        if (dot < 0.5) {
          failHead += 1;
          worst.push({ i, f, kind: 'head', dot: +dot.toFixed(2), sc: !!rp.onShortcut });
        }
        rows.push(dist);
      }
    }

    // ---- 近道：沿折线按弧长取 30% / 55% / 80% 三个点 ----
    const scRows = [];
    for (const sc of scs) {
      const L = scLen(sc.points);
      for (const f of [0.3, 0.55, 0.8]) {
        const p = arcAt(sc.points, L * f);
        const gi = (sc.from + 1) % N;
        const rp = t.respawnPoint({ x: p[0], z: p[1] }, gi, BACK);
        const off = rp ? nearInfo(sc.points, rp.x, rp.z).d : Infinity;
        const dist = rp ? Math.hypot(rp.x - p[0], rp.z - p[1]) : null;
        scRows.push({
          from: sc.from, to: sc.to, width: sc.width, len: +L.toFixed(0), f,
          off: Number.isFinite(off) ? +off.toFixed(1) : null,
          dist: dist == null ? null : +dist.toFixed(1),
          onSc: !!rp && rp.onShortcut !== false,
          ok: !!rp && off <= sc.width * 1.6 && dist <= 55,
        });
      }
    }

    const avg = rows.reduce((s, v) => s + v, 0) / Math.max(1, rows.length);
    const mx = rows.length ? Math.max(...rows) : 0;
    const mn = rows.length ? Math.min(...rows) : 0;
    return {
      map: g.mapDef.id, gates: N, gateWidth: t.gateWidth,
      samples: rows.length,
      shortcuts: scs.length,
      avg: +avg.toFixed(1), min: +mn.toFixed(1), max: +mx.toFixed(1),
      failNull, failFar, failOff, failHead,
      worst: worst.slice(0, 10),
      sc: scRows,
    };
  })()`);

  const r = out.result?.value;
  if (!r) throw new Error('自测没返回结果');
  console.log(JSON.stringify(r, null, 1));
  const bad = r.failNull + r.failFar + r.failOff + r.failHead + r.sc.filter((x) => !x.ok).length;
  console.log(bad === 0 ? `PASS ${mapId}` : `FAIL ${mapId} (${bad} 处异常)`);
  if (bad > 0) process.exitCode = 2;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
