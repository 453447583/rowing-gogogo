// 空气墙探针：在页面里用「自动驾驶跑中线」测护栏到底有多容易碰到
//
//   node tests/airwall_probe.mjs <mapId>
//
// 做法：把本地艇放到 0 号门，全油门朝下一个门开，每帧手动调
//   boat.updateLocal(dt, input, t, [], boundary)  ← 碰撞体传空，隔离出护栏本身
//   track.constrain(boat)                          ← 只测这一个
// 统计 wallContactTimer 从 0→>0 的次数（= 被护栏推回来的帧）。
// 跑中线还能频繁撞墙 → 护栏（edgeOffset）比可视水面窄，就是"空气墙"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const mapId = process.argv[2] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/airwall-' + mapId);
const port = 9353;
const httpPort = 5183;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  env: { ...process.env, PORT: String(httpPort) }, stdio: 'ignore',
});
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=900,560',
  `http://127.0.0.1:${httpPort}/`], { stdio: 'ignore' });

let ws;
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  if (!tabs) throw new Error('headless Edge 没起来');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleepCd = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 90000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleepCd(300);
    }
    throw new Error('timeout: ' + label + ' last=' + JSON.stringify(last));
  };

  await waitFor('!!document.querySelector("#btn-solo")', 45000, 'menu');
  for (let i = 0; i < 10; i++) {
    await ev('document.querySelector("#btn-solo").click()');
    await sleepCd(600);
    if (await ev('[...document.querySelectorAll(".boat-card")].length > 0')) break;
  }
  await ev('[...document.querySelectorAll(".boat-card")].find(x => x.textContent.includes("疾风")).click()');
  await sleepCd(300);
  await ev('document.querySelector("#btn-boat-ok").click()');
  // 等地图卡片渲染出来再按 data-map-id 点，别用文字匹配（地图名和 id 不一样）
  await waitFor('document.querySelectorAll(".map-card").length > 0', 30000, 'map cards');
  const picked = await ev(`(function(){
    const c=document.querySelector('.map-card[data-map-id="${mapId}"]');
    if(!c) return 'no-card';
    c.click(); return c.dataset.mapId;
  })()`);
  if (picked !== mapId) throw new Error('没选中地图 ' + mapId + '（' + picked + '）');
  await sleepCd(400);
  await ev('document.querySelector("#btn-map-ok").click()');
  await waitFor('!!(window.__game && window.__game.track)', 90000, 'game boot');
  const realMap = await ev('window.__game.mapDef.id');
  if (realMap !== mapId) throw new Error('启动的地图不对：' + realMap);
  await ev('(function(){ try{ window.__game.renderer.setSize(320,200,false); }catch(e){} return 1 })()');
  await sleepCd(1200);

  // HULL=old：把碰撞形状换回旧版的「88% 宽 × 62% 长」圆角矩形，
  // 用来做 A/B —— 判断"贴墙率高"是船体轮廓变严了，还是探针的循迹本来就菜。
  if (process.env.HULL === 'old') {
    await ev(`(function(){ const b = window.__game.localBoat, h = b.def.hull;
      const hw = h.width * 0.5 * 0.88, hl = h.length * 0.5 * 0.62;
      b.hullFootprint = Float32Array.from([hw, hl, -hw, hl, -hw, -hl, hw, -hl]);
      return b.hullFootprint.length; })()`);
  }
  // HULL=old：把碰撞形状换回旧版的「88% 宽 × 62% 长」圆角矩形，
  // 用来做 A/B —— 判断"贴墙率高"是船体轮廓变严了，还是探针的循迹本来就菜。
  const hullOld = process.env.HULL === 'old' ? '1' : '0';
  const out = await ev(`(function(){
    const g = window.__game, tr = g.track, b = g.localBoat;
    // 必须在这个同步 IIFE 里改：整段模拟是同步跑的，中途不会有 GLB 加载回调覆盖它
    if (${hullOld}) {
      const h = b.def.hull, hw = h.width * 0.5 * 0.88, hl = h.length * 0.5 * 0.62;
      b.hullFootprint = Float32Array.from([hw, hl, -hw, hl, -hw, -hl, hw, -hl]);
    }
    const gates = tr.gates, N = gates.length;
    const limit = Number.isFinite(tr.edgeOffset) ? tr.edgeOffset : tr.gateWidth - 0.6;
    const start = gates[0], next = gates[1];
    b.resetTo(start[0], start[1], Math.atan2(next[0]-start[0], next[1]-start[1]));
    let gi = 1, t = 0, lap = 0;
    const hits = [];
    let contactFrames = 0, frames = 0;
    const trace = [];
    const DT = 1/60;
    // 纯追踪：沿门折线取「前方 16m」的预瞄点，按航向误差收油。
    // 全油门直冲门心那种开法过不了弯，会把「驾驶员太菜」算成「空气墙」。
    const LOOKAHEAD = 16;
    const aimAhead = () => {
      let remain = LOOKAHEAD;
      let i = gi;
      let px = b.pos.x, pz = b.pos.z;
      for (let c = 0; c < 12; c++) {
        const nx = gates[i % N][0], nz = gates[i % N][1];
        const d = Math.hypot(nx - px, nz - pz);
        if (d >= remain) {
          const k = remain / (d || 1);
          return [px + (nx - px) * k, pz + (nz - pz) * k];
        }
        remain -= d;
        px = nx; pz = nz;
        i++;
      }
      return [gates[gi % N][0], gates[gi % N][1]];
    };
    for (let k = 0; k < 60 * 240; k++) {
      t += DT;
      // 推进目标门号
      while (Math.hypot(gates[gi % N][0] - b.pos.x, gates[gi % N][1] - b.pos.z) < 11) {
        gi++;
        if (gi % N === 0) lap++;
      }
      const [ax, az] = aimAhead();
      const desired = Math.atan2(ax - b.pos.x, az - b.pos.z);
      let dh = desired - b.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      const steer = Math.max(-1, Math.min(1, dh * 2.6));
      const throttle = Math.abs(dh) > 0.55 ? 0.55 : Math.abs(dh) > 0.3 ? 0.8 : 1;
      b.updateLocal(DT, { throttle, steer, boost: false }, t, [], null);
      const before = b.wallContactTimer;
      tr.constrain(b);
      frames++;
      if (k % 300 === 0) trace.push({ t: +t.toFixed(1), gate: gi % N, x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1),
        lat: +(tr.lateralAt(b.pos, b.gateHint).lat).toFixed(2), sp: +b.speed.toFixed(1), wall: +b.wallContactTimer.toFixed(2) });
      if (b.wallContactTimer > 0) {
        contactFrames++;
        if (before <= 0) {
          const loc = tr.lateralAt(b.pos);
          hits.push({ gate: gi % N, lat: +loc.lat.toFixed(2), over: +(loc.lat - limit).toFixed(2) });
        }
      }
    }
    const byGate = {};
    for (const h of hits) {
      const k2 = Math.floor(h.gate / 5) * 5;
      byGate[k2] = (byGate[k2] || 0) + 1;
    }
    return {
      mapId: g.mapDef.id, gates: N, gateWidth: tr.gateWidth, limit: +limit.toFixed(2),
      frames, laps: lap,
      hits: hits.length,
      contactPct: +((contactFrames / frames) * 100).toFixed(2),
      hotGates: Object.entries(byGate).sort((a, b2) => b2[1] - a[1]).slice(0, 6),
      trace: trace.slice(0, 24),
      sample: hits.slice(0, 4),
    };
  })()`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch {}
}
