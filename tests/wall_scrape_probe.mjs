// 贴墙脱困探针：船头斜顶在赛道边墙上，按住油门 + 往反方向打方向，
// 看它多久能把船头掰开、多快重新跑起来。
//
//   WB_URL=http://127.0.0.1:3000/ node tests/wall_scrape_probe.mjs
//
// 判据（贴墙后 3 秒）：
//   tEscape   = 从顶住到横向离开墙面 3m 的帧数（60 帧 = 1 秒）
//   speedOut  = 离开墙面那一刻的速度（>10 m/s 才算"能开走"）
//   travel    = 3 秒内沿赛道方向前进的距离（蜗牛爬行会是个位数）
// 两个方向都跑：玩家按的是"和墙相反"的那个方向键，取较好的那一侧判定。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
// 无头配置目录一律写在项目外（项目硬约束）
const profile = path.resolve(`D:/3dgame-tmp/browser/wall-${stamp}`);
const port = 9800 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:3000/';
const mapId = process.env.MAP || 'strait';

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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
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

  const t1 = Date.now();
  while (Date.now() - t1 < 90000) {
    if ((await evaluate('!!(window.__game && window.__game.track && window.__game.localBoat)')).result?.value) break;
    await sleep(300);
  }
  await evaluate('(() => { const g = window.__game; if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; } if (g.phase !== "racing") { g.raceIntro = null; g.countdownLeft = 0; g.phase = "racing"; } if (g.rafId) cancelAnimationFrame(g.rafId); return 1; })()');

  const out = await evaluate(`(() => {
    const g = window.__game, t = g.track, b = g.localBoat;
    const N = t.gates.length;
    const limit = Number.isFinite(t.edgeOffset) ? t.edgeOffset : t.gateWidth - 0.6;

    // 挑一段直一点的赛段当靶场：相邻两门方向夹角最小的一段
    let best = 0, bestDot = -2;
    for (let i = 1; i < N - 1; i++) {
      const a = t.gates[i], c = t.gates[i + 1], p = t.gates[i - 1];
      const d1 = Math.atan2(a[0] - p[0], a[1] - p[1]);
      const d2 = Math.atan2(c[0] - a[0], c[1] - a[1]);
      let dd = d2 - d1;
      while (dd > Math.PI) dd -= Math.PI * 2;
      while (dd < -Math.PI) dd += Math.PI * 2;
      const dot = Math.cos(dd);
      if (dot > bestDot) { bestDot = dot; best = i; }
    }

    const a = t.gates[best], c = t.gates[(best + 1) % N];
    const fwd = Math.atan2(c[0] - a[0], c[1] - a[1]);
    const rxx = Math.cos(fwd), rzz = -Math.sin(fwd);   // 右舷方向

    const DT = 1 / 60;
    const STEPS = 180;                                  // 3 秒

    // 沿中线的投影距离（前进量）与带符号横向偏移
    const proj = (x, z) => {
      const sx = c[0] - a[0], sz = c[1] - a[1];
      const len = Math.hypot(sx, sz) || 1;
      return ((x - a[0]) * sx + (z - a[1]) * sz) / len;
    };
    const lat = (x, z) => (x - a[0]) * rxx + (z - a[1]) * rzz;

    // 真人操作：先按住油门 + 往离墙那边打方向（最多 2 秒），
    // 船一旦离开墙面就松方向（不打方向就会一直画圈，那不是玩家的动作）。
    const run = (label, steer, angleDeg, initSpeed) => {
      const startX = a[0] + rxx * (limit - 1.0);
      const startZ = a[1] + rzz * (limit - 1.0);
      const startHeading = fwd + angleDeg * Math.PI / 180;
      b.resetTo(startX, startZ, startHeading, { keepNitro: true });
      b.pos.y = t.surfaceYAt ? t.surfaceYAt(startX, startZ, best) : b.pos.y;
      b.vel.set(Math.sin(startHeading) * initSpeed, Math.cos(startHeading) * initSpeed);
      b.speed = initSpeed;
      b.stunTimer = 0; b.driftState = null; b.driftAngle = 0; b.driftTime = 0;
      b.wallContactTimer = 0; b.wallHitCooldown = 0;
      const input = { throttle: 1, steer, drift: false };

      let maxLat = -Infinity;
      let escapeFrame = null, escapeSpeed = null;
      let alignFrame = null;
      let contactFrames = 0;
      let minSpeed = Infinity;
      let releasedAt = null;
      const trace = [];
      const s0 = proj(b.pos.x, b.pos.z);
      for (let i = 0; i < STEPS; i++) {
        b.updateLocal(DT, input, 20 + i * DT, [], null);
        const h0 = b.heading;
        t.constrain(b);
        const dHStep = ((b.heading - h0) * 180 / Math.PI);
        const L = lat(b.pos.x, b.pos.z);
        if (L > maxLat) maxLat = L;
        if ((b.wallContactTimer || 0) > 0) contactFrames += 1;
        const sp = Math.hypot(b.vel.x, b.vel.y);
        if (i > 12) minSpeed = Math.min(minSpeed, sp);
        // 船头相对墙面切线（直道段就是 fwd）夹角小于 10° = 玩家感觉"船头转回来了"
        let dHead = b.heading - fwd;
        while (dHead > Math.PI) dHead -= Math.PI * 2;
        while (dHead < -Math.PI) dHead += Math.PI * 2;
        if (alignFrame === null && Math.abs(dHead) < 10 * Math.PI / 180) alignFrame = i;
        if (i % 3 === 0 && i < 96) {
          const wd = b.wallDbg || {};
          trace.push([i, +(dHead * 180 / Math.PI).toFixed(1), +((b.angVel || 0)).toFixed(2),
            +sp.toFixed(1), +L.toFixed(2), wd.into == null ? '-' : wd.into,
            wd.align == null ? '-' : wd.align, +dHStep.toFixed(2), wd.dh == null ? '-' : wd.dh, wd.n == null ? '-' : wd.n, wd.thr == null ? '-' : wd.thr]);
        }
        // 顶住之后横向退开 3m = 真的离开了墙
        if (escapeFrame === null && maxLat > limit - 2.7 && L < maxLat - 3.0) {
          escapeFrame = i; escapeSpeed = sp;
          releasedAt = i; input.steer = 0;
        }
        // 2 秒还没离开就松手（真人也会松一下再试）
        if (releasedAt === null && i > 120) { input.steer = 0; }
      }
      return {
        label, steer, angleDeg, initSpeed,
        maxLat: +maxLat.toFixed(2),
        endLat: +lat(b.pos.x, b.pos.z).toFixed(2),
        alignFrame,
        escapeFrame,
        escapeSpeed: escapeSpeed == null ? null : +escapeSpeed.toFixed(1),
        travel: +(proj(b.pos.x, b.pos.z) - s0).toFixed(1),
        endSpeed: +Math.hypot(b.vel.x, b.vel.y).toFixed(1),
        minSpeed: +minSpeed.toFixed(2),
        contactFrames,
        trace,
      };
    };

    return {
      gate: best, limit: +limit.toFixed(2),
      // A：斜着擦上墙（≈29°），中速 10m/s —— 最常见的蹭墙
      scrapeAway: run('A 斜擦-打离墙方向', -1, 29, 10),
      scrapeInto: run('A 斜擦-反而往墙里打', 1, 29, 10),
      // B：几乎垂直顶死、速度只剩 2m/s —— 用户说的"卡住只能复位"
      headOnAway: run('B 顶死-打离墙方向', -1, 70, 2),
    };
  })()`);

  const r = out.result?.value;
  if (!r) throw new Error('no data: ' + JSON.stringify(out).slice(0, 300));
  console.log(JSON.stringify(r, null, 1));
  if (process.env.DEBUG) {
    console.log('B 帧/i, 船头相对墙角度, angVel, 速度, 横向位置, wallContact');
    for (const row of r.headOnAway.trace || []) console.log(row.join('\t'));
  }

  const a1 = r.scrapeAway;
  check('A 斜擦墙：船头 0.5 秒内回正', a1.alignFrame != null && a1.alignFrame <= 30,
    a1.alignFrame == null ? '没回正' : `${a1.alignFrame} 帧（${(a1.alignFrame / 60).toFixed(2)}s）`);
  check('A 斜擦墙：打离墙方向能脱离', a1.escapeFrame != null && a1.escapeFrame <= 75,
    a1.escapeFrame == null ? '没离开墙' : `${a1.escapeFrame} 帧（${(a1.escapeFrame / 60).toFixed(2)}s）`);
  check('A 斜擦墙：脱离时速度 ≥ 10m/s', a1.escapeSpeed != null && a1.escapeSpeed >= 10,
    `${a1.escapeSpeed} m/s`);
  check('A 斜擦墙：3 秒沿赛道跑出 20m 以上', a1.travel >= 20, `${a1.travel} m`);
  check('A 斜擦墙：全程没被压到 2m/s 以下', a1.minSpeed > 2, `min=${a1.minSpeed}`);

  const b1 = r.headOnAway;
  check('B 顶死（70°/2m/s）：船头 0.8 秒内回正', b1.alignFrame != null && b1.alignFrame <= 48,
    b1.alignFrame == null ? '没回正' : `${b1.alignFrame} 帧（${(b1.alignFrame / 60).toFixed(2)}s）`);
  check('B 顶死：打方向能脱困（≤1.9s）', b1.escapeFrame != null && b1.escapeFrame <= 114,
    b1.escapeFrame == null ? '3 秒内没脱困（只能复位）' : `${b1.escapeFrame} 帧（${(b1.escapeFrame / 60).toFixed(2)}s）`);
  check('B 顶死：脱困后跑出 8m 以上', b1.travel >= 8, `${b1.travel} m`);

  console.log(`诊断：往墙里打方向（不该能脱困）travel=${r.scrapeInto.travel}m `
    + `endSpeed=${r.scrapeInto.endSpeed}`);

  console.log(`\n${results.every((x) => x.ok) ? 'ALL PASS' : 'HAS FAIL'}`);
}

main().catch((e) => { console.error('ERROR', e.message); process.exitCode = 1; })
  .finally(() => { try { child.kill(); } catch { /* ignore */ } });
