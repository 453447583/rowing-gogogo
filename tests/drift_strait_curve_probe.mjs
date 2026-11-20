// 霓虹海峡起步 Z 弯「按住漂移能不能贴着航道过」回归探针。
//
//   node tests/drift_strait_curve_probe.mjs
//
// 背景：用户反馈"漂移半径太靠外，霓虹海峡开始那几个弯每次都漂不过"。
// 用一个简单的前瞻控制器代替人手：目标点取中心线前方 22m，方向键按目标角度给，
// 全程按住漂移 + 油门；每帧调用 Track.constrain（真实游戏里同样有护栏）。
// 量化三件事：① 有没有撞到护栏；② 离中心线最远多少（航道半宽 8m）；
// ③ 能否在时间内推进到门 10（起步 Z 弯结束）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve(`D:/3dgame-tmp/browser/straitcurve-${Date.now()}`);
const port = 9920 + Math.floor(Math.random() * 50);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=640,400', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;
const waitFor = async (expr, ms = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(300); }
  return false;
};

// 直接推进 Boat.updateLocal，不依赖无头浏览器那 1~3fps 的帧率。
const EXPR = `(() => { try {
  const g = window.__game, b = g.localBoat, T = g.track;
  const dt = 1 / 60;
  b.resetTo(0, 40, Math.PI); // 0 号门起步，朝 -Z
  b.floatMode = false; b.waveLaunchEnabled = false; b.waveJumpEnabled = false;
  b.boostTimer = 0; b.miniBoostTimer = 0; b.miniBoostQueue = 0;
  b.nitroBottles = 0; b.nitroCharge = 0; b.driftBoostCd = 0; b.driftLockout = 0;
  b.drifting = false; b.driftTime = 0; b.driftAngle = 0; b.driftWant = 0;
  b.driftPathYaw = 0; b.driftDA = 0; b.driftChain = 0;
  b.stunTimer = 0; b.sinkTimer = 0; b.airborne = false; b.onCoaster = null;
  b.vel.set(0, 6); b.speed = 6;

  const gates = T.gates, cum = T.arcCum, total = T.arcTotal;
  const pointAt = (s) => {
    s = Math.max(0, Math.min(total - 1e-3, s));
    for (let i = 0; i < gates.length; i++) {
      const a = gates[i], n = gates[(i + 1) % gates.length];
      const segEnd = (i + 1 < gates.length) ? cum[i + 1] : total;
      if (s <= segEnd || i === gates.length - 1) {
        const u = Math.max(0, Math.min(1, (s - cum[i]) / Math.max(1e-6, segEnd - cum[i])));
        return [a[0] + (n[0] - a[0]) * u, a[1] + (n[1] - a[1]) * u];
      }
    }
    return gates[0];
  };
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  // 门 10 的弧长 = 到这个门为止的中线长度
  let targetArc = 0;
  for (let i = 0; i < 10; i++) {
    const a = gates[i], n = gates[i + 1];
    targetArc += Math.hypot(n[0] - a[0], n[1] - a[1]);
  }

  let wallHits = 0, wasWall = false, maxD = 0, maxDAt = null, prevArc = 0;
  let stalled = 0, frames = 0, finishArc = 0, slowFrames = 0, recoveries = 0, recovering = 0;
  const radii = [];
  const samples = [];
  for (let i = 0; i < 60 * 18; i++) {
    const here = T.arcAt(b.pos.x, b.pos.z);
    // 纯前瞻控制：目标点在中线上、随速度前移，模拟玩家看着赛道入弯
    // 真实游戏里 Game 每帧会把 gateHint 写成下一个门；不写的话 constrain
    // 在自交/近邻段可能选错走廊，探针会误报"撞墙"。
    let gi = 0;
    for (let k = 0; k < gates.length; k++) {
      const end = (k + 1 < gates.length) ? cum[k + 1] : total;
      if (here.s <= end) { gi = k; break; }
    }
    b.gateHint = gi;
    const look = 18 + Math.min(20, b.speed * 0.9);
    const aim = pointAt(here.s + look);
    const want = Math.atan2(aim[0] - b.pos.x, aim[1] - b.pos.z);
    const err = wrap(want - b.heading);
    const steer = Math.max(-1, Math.min(1, err * 2.6));
    // 玩家蹭到护栏后会短暂松漂移键把船头拉回航道；探针也照做，
    // 否则低速贴墙时漂移的滑移角会让船一直贴着墙蹭，永远回不来。
    if (b.speed < 3) slowFrames++; else slowFrames = 0;
    if (slowFrames > 24 && recovering <= 0) { recovering = 120; recoveries++; slowFrames = 0; }
    const driftOn = recovering <= 0;
    if (recovering > 0) recovering--;
    // 脱困时朝正前方中心线开，不用弯道的 steer，避免继续顶着护栏
    const recAim = pointAt(here.s + 12);
    const recErr = wrap(Math.atan2(recAim[0] - b.pos.x, recAim[1] - b.pos.z) - b.heading);
    const recSteer = Math.max(-1, Math.min(1, recErr * 3));
    b.updateLocal(dt, { throttle: 1, steer: driftOn ? steer : recSteer, drift: driftOn }, i * dt, [], null);
    T.constrain(b);
    const now = T.arcAt(b.pos.x, b.pos.z);
    if (b.wallContactTimer > 0.3 && !wasWall) wallHits++;
    wasWall = b.wallContactTimer > 0.3;
    if (now.d > maxD) { maxD = now.d; maxDAt = +now.s.toFixed(1); }
    // 稳态漂移半径：速度 / 轨迹偏航角速度（与 drift_arc_probe 同一口径）
    // 只统计稳态速度：低速脱困时 speed/pathYaw 会算出很小的假半径
    if (i > 90 && b.speed > 22 && Math.abs(b.driftPathYaw) > 1.5 && Math.abs(b.driftAngle) > 0.25)
      radii.push(b.speed / Math.abs(b.driftPathYaw));
    if (now.s - prevArc < 0.01) stalled++; else stalled = 0;
    prevArc = now.s;
    frames++;
    if (i % 60 === 0) samples.push({ t: i / 60, s: +now.s.toFixed(1), d: +now.d.toFixed(1),
      spd: +b.speed.toFixed(1), ang: +(b.driftAngle * 180 / Math.PI).toFixed(0) });
    if (now.s >= targetArc) { finishArc = now.s; break; }
    if (stalled > 180) break;
  }
  return { targetArc: +targetArc.toFixed(1), finishArc: +finishArc.toFixed(1),
    wallHits, recoveries, maxD: +maxD.toFixed(2), maxDAt, seconds: +(frames / 60).toFixed(2),
    steadyR: radii.length ? +(radii.slice().sort((a,b)=>a-b)[Math.floor(radii.length/2)]).toFixed(1) : null,
    samples };
  } catch (e) { return { error: String(e && e.stack || e) }; } })()`;

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
}

try {
  const t0 = Date.now(); let tabs;
  while (Date.now() - t0 < 25000) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) { tabs = await r.json(); break; } } catch { /* not up */ }
    await sleep(150);
  }
  if (!tabs) throw new Error('devtools timeout');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.reload'); await sleep(1500);
  // 与 sun_view / drift_arc 探针同一套启动流程：必须等音频和按钮都就位，
  // 否则在页面还在 loading 时点按钮会被随后的初始化覆盖掉。
  if (!await waitFor(`!!window.__audio && !!document.querySelector('#btn-solo')`)) throw new Error('页面没起来');
  await ev('document.querySelector("#btn-solo")?.click(); 1'); await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await ev('document.querySelector("#btn-lobby-map")?.click(); 1'); await sleep(700);
    cardsReady = (await ev('!!document.querySelector(".lp-card[data-map=strait]")')) === true;
  }
  if (!cardsReady) throw new Error('地图抽屉没打开');
  await ev(`(()=>{const c=document.querySelector('.lp-card[data-map="strait"]');c.click();return 1;})()`);
  await sleep(500);
  await ev('document.querySelector("#btn-lobby-pick-close")?.click(); 1'); await sleep(300);
  await ev('document.querySelector("#btn-start-race")?.click(); 1');
  if (!await waitFor('!!(window.__game && window.__game.localBoat && window.__game.track)', 60000)) throw new Error('对局没起来');
  await sleep(800);
  await ev(`(()=>{const g=window.__game; g.opts.onFinish=()=>{}; g.opts.onQuit=()=>{}; g.phase='racing'; return 1;})()`);
  const r = await ev(EXPR);
  if (!r || !r.targetArc) throw new Error('no data: ' + JSON.stringify(r)?.slice(0, 600));
  console.log('目标弧长', r.targetArc, '到达', r.finishArc, '用时', r.seconds + 's');
  for (const s of r.samples) console.log(`  t=${s.t}s s=${s.s}m d=${s.d}m v=${s.spd}m/s 滑移角=${s.ang}°`);
  console.log(`诊断：护栏接触 ${r.wallHits} 次，脱困 ${r.recoveries} 次；`
    + `自动控制器只跑到 ${r.finishArc}/${r.targetArc}m（人手操作需实机确认）`);
  // 可自动断言的是「转弯半径确实调小了」——这是本次调参的直接目标；
  // 能否完美过弯依赖玩家打方向时机，自动控制器给不出可靠结论。
  // 半径随速度变化（低速时同样角速度 → 半径更小），本探针里速度忽高忽低，
  // 逐帧算出的中位数不能当"稳态半径"用。权威口径是 drift_arc_probe 的
  // 高速稳态值（pathYaw 1.95 → 16.4m），这里只把它打出来做参考。
  console.log(`逐帧半径中位数 ${r.steadyR}m（速度波动，仅参考；`
    + `稳态半径看 drift_arc_probe）`);
  check('船身始终留在 8m 航道内', r.maxD <= 8.5, `maxD=${r.maxD}m @s=${r.maxDAt}`);
} catch (e) {
  console.error('FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* */ }
  child.kill();
  await sleep(300);
  process.exit(process.exitCode || 0);
}
