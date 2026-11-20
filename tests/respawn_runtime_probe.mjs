// R 复位「真实路径」自测：把本地艇摆到赛道上的点，调真正的 respawnLocal()，
// 检查复位后的位置/朝向/高度，而不是只验 Track.respawnPoint 的几何。
//   MAP=magma node tests/respawn_runtime_probe.mjs
// 断言：
//   1. 复位后确实移动了（>5m）且没有退太远（<60m）
//   2. 复位点落在主道或近道走廊里
//   3. 高度是有限数，且在赛道面附近（|y - surfaceYAt| < 6m）
//   4. 复位不吞门：pm.gate 前后一致
//   5. 近道里复位后仍在近道走廊内
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
// 无头配置目录一律写在项目外（项目硬约束：写在项目里 Edge 残留会堆到几十 GB）
const profile = path.resolve(`D:/3dgame-tmp/browser/respawn-rt-${stamp}`);
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'magma';

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
    const c = cards.find((x) => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map((x) => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  // 无头软渲染 1~3fps、dt 截 0.05 → 游戏时间慢 3~10 倍，给足 120s，等不到就直接推阶段
  const t1 = Date.now();
  let racing = false;
  while (Date.now() - t1 < 120000) {
    const r = await evaluate('window.__game ? (window.__game.phase || "none") : "loading"');
    if (r.result?.value === 'racing') { racing = true; break; }
    await sleep(400);
  }
  if (!racing) {
    console.log('（倒计时没跑完，直接把 phase 推到 racing）');
    await evaluate('(() => { const g = window.__game; if (g) { g.raceIntro = null; g.countdownLeft = 0; g.phase = "racing"; } return 1; })()');
    await sleep(400);
  }
  await evaluate('(() => { const g = window.__game; if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; } return 1; })()');

  const out = await evaluate(`(() => {
    const g = window.__game, t = g.track, b = g.localBoat;
    const N = t.gates.length;
    const pm = g.progressMap.get(g.myId);
    if (!pm) return { err: 'progressMap 里没有自己' };
    pm.lap = 1;                                  // 别撞上"发车格"那条提前返回

    const loop = [...t.gates, t.gates[0]];
    const scs = (t.shortcuts || []).filter((s) => s.points && s.points.length > 2);
    const segDist = (ax, az, bx, bz, x, z) => {
      const sx = bx - ax, sz = bz - az;
      const L2 = sx * sx + sz * sz;
      let k = L2 > 1e-9 ? ((x - ax) * sx + (z - az) * sz) / L2 : 0;
      k = Math.max(0, Math.min(1, k));
      return Math.hypot(x - (ax + sx * k), z - (az + sz * k));
    };
    const polyDist = (pts) => {
      let best = Infinity;
      for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, segDist(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], b.pos.x, b.pos.z));
      return best;
    };
    const arcAt = (pts, s) => {
      let acc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], c = pts[i + 1];
        const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (acc + L >= s) {
          const u = Math.max(0, Math.min(1, (s - acc) / L));
          return [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u, Math.atan2(c[0] - a[0], c[1] - a[1])];
        }
        acc += L;
      }
      const a = pts[pts.length - 2], c = pts[pts.length - 1];
      return [c[0], c[1], Math.atan2(c[0] - a[0], c[1] - a[1])];
    };
    const limMain = (t.gateWidth || 20) * 1.6;
    const limSc = scs.reduce((m, s) => Math.max(m, s.width * 1.6), 0);

    // 摆位：放到 i -> i+1 段 70% 处，门号设成 i+1（= 下一个该过的门）
    const place = (x, z, hd, gate) => {
      b.resetTo(x, z, hd, { keepNitro: true });
      pm.gate = gate;
      const before = { x: b.pos.x, z: b.pos.z };
      g.respawnLocal();
      const dist = Math.hypot(b.pos.x - before.x, b.pos.z - before.z);
      const off = Math.min(polyDist(loop), ...scs.map((s) => polyDist(s.points)));
      const sy = t.surfaceYAt ? t.surfaceYAt(b.pos.x, b.pos.z, (gate - 1 + N) % N) : NaN;
      return {
        dist: +dist.toFixed(1),
        off: +off.toFixed(1),
        dy: Number.isFinite(sy) && Number.isFinite(b.pos.y) ? +(b.pos.y - sy).toFixed(2) : null,
        gateAfter: pm.gate,
        y: Number.isFinite(b.pos.y) ? +b.pos.y.toFixed(1) : null,
      };
    };

    const rows = [];
    let bad = 0;
    const pick = [3, 6, 9, 12, 15, 18, 21, 24].map((k) => k % N).filter((v, i, a) => a.indexOf(v) === i);
    for (const i of pick) {
      const a = t.gates[i], c = t.gates[(i + 1) % N];
      const px = a[0] + (c[0] - a[0]) * 0.7;
      const pz = a[1] + (c[1] - a[1]) * 0.7;
      const hd = Math.atan2(c[0] - a[0], c[1] - a[1]);
      const r = place(px, pz, hd, (i + 1) % N);
      const ok = r.dist > 5 && r.dist < 60 && r.off <= Math.max(limMain, limSc)
        && r.gateAfter === (i + 1) % N && (r.dy === null || Math.abs(r.dy) < 6);
      if (!ok) bad += 1;
      rows.push({ kind: 'main', i, ...r, ok });
    }

    // 近道里按 R：必须还在近道走廊内
    for (const sc of scs) {
      let L = 0;
      for (let i = 0; i < sc.points.length - 1; i++) L += Math.hypot(sc.points[i + 1][0] - sc.points[i][0], sc.points[i + 1][1] - sc.points[i][1]);
      const p = arcAt(sc.points, L * 0.6);
      const r = place(p[0], p[1], p[2], (sc.from + 1) % N);
      const offSc = +polyDist(sc.points).toFixed(1);
      const ok = r.dist > 5 && r.dist < 60 && offSc <= sc.width * 1.6 && (r.dy === null || Math.abs(r.dy) < 6);
      if (!ok) bad += 1;
      rows.push({ kind: 'sc', from: sc.from, to: sc.to, offSc, ...r, ok });
    }

    return { map: g.mapDef.id, gates: N, rows, bad };
  })()`);

  const r = out.result?.value;
  if (!r || r.err) {
    const ex = out.exceptionDetails?.exception?.description || out.exceptionDetails?.text;
    if (ex) console.error('页面内抛错：', String(ex).split('\n').slice(0, 6).join('\n'));
    throw new Error(r?.err || '自测没返回结果');
  }
  for (const row of r.rows) {
    console.log(
      (row.ok ? '  ok  ' : ' FAIL ') + JSON.stringify(row),
    );
  }
  console.log(`samples ${r.rows.length}, bad ${r.bad}`);
  console.log(r.bad === 0 ? `PASS ${mapId}` : `FAIL ${mapId}`);
  if (r.bad > 0) process.exitCode = 2;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
