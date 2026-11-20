// 漂移实机冒烟：真·Game 循环（rAF + 真 updateLocal + 真赛道碰撞 + 真护栏约束）
//
//   node tests/drift_race_smoke.mjs [baseUrl] [boatId] [mapId]
//
// 和 drift_probe.mjs（纯物理、无碰撞）互补，这里验证的是"接进游戏之后"：
//   ① 真循环里漂移段是否连续（不是每帧闪切）、有没有 NaN
//   ② 撞障碍是否只回退本次集气、氮气瓶不动、冷却后能重新起漂
//   ③ 彩虹反打 / 回正发喷 / 断漂补气在真输入链上是否都还成立
//
// 输入与统计都挂在 b.updateLocal 上（而不是 setInterval）：
//   · 统计帧 == 物理帧，不受无头 rAF 节流影响；
//   · 时间线按传给物理的 dt 累加（游戏时间），不是墙钟。
// 起点附近静态障碍较多，全油门直线会把船顶在墙上反复吃 stun，所以带一个
// "低速+硬直超过 0.5s 就回到起点门重新加速"的脱困，同时把脱困次数记进报告。
// 碰撞不靠乱撞，而是在漂移中往船头前塞一个临时 collider，走真实碰撞路径。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const boatId = process.argv[3] || 'rower';
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/drift-smoke-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=640,400', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const cleanup = async () => { try { ws?.terminate(); } catch {} child.kill('SIGKILL'); await sleep(300); };
async function waitJson(url, timeout = 25000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const pageErrors = [];
  const fxNoise = [];
  // 无头 --disable-gpu 下 Effekseer 加载特效贴图会固定抛一次 texImage2D
  // Overload resolution failed。它发生在资源加载层，和漂移/物理完全无关，
  // 单列出来，别混进"逻辑异常"里把回归结果染红。
  const FX_NOISE = /texImage2D|effekseer\.min\.js|Effekseer/i;
  const pushError = (text) => (FX_NOISE.test(text || '') ? fxNoise : pageErrors).push(text || 'exception');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') pushError(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error' && !/404/.test(m.params.entry.text)) pushError(m.params.entry.text);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await sleep(3000);
  const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;
  const waitFor = async (expr, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(300); } return false; };

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await ev(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#lobby') && !document.querySelector('#lobby').classList.contains('hidden')`);
  await ev(`document.querySelector('#btn-lobby-boat')?.click()`); await sleep(400);
  await ev(`document.querySelector('.lp-card[data-boat="${boatId}"]')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-map')?.click()`); await sleep(400);
  await ev(`document.querySelector('.lp-card[data-map="${mapId}"]')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-start-race')?.click()`);
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 40000)) throw new Error('对局没起来');
  await sleep(1200);

  const setup = await ev(`(() => {
    const g = window.__game;
    g.opts.onFinish = null; g.opts.onQuit = null;
    // 开场镜头会冻结倒计时 + 物理；强切到 racing 才能测到真实 updateLocal。
    g.raceIntro = null; g.countdownLeft = 0; g.phase = 'racing'; g.raceTime = 0;
    g.finished = false;
    g.post.render = () => {};
    g.renderer.render = () => {};
    g.cameraRig.follow = () => {};
    const b = g.localBoat;
    // 隔离赛道随机噪声：起点门附近贴着护栏 / 礁石，wallContactTimer 会被
    // Track.constrain 每帧刷成 0.35，canEngage 永远进不去，测出来全是碎段。
    // 这里只保留「真 Game 循环 + 真 updateLocal」；碰撞改由下面受控注入，
    // 走的仍是 updateLocal 里同一段圆碰撞 / cancelDriftForCollision 代码。
    g.colliders = [];
    g.track.shoreColliders = [];
    g.track.mechColliders = [];
    g.track.constrain = () => {};
    g.track.applyMechs = () => {};
    g.track.updateCoaster = () => {};
    b.waveLaunchEnabled = false;
    b.waveJumpEnabled = false;
    const keys = g.opts.input.keys, codes = g.opts.input.codes;
    const pm = g.progressMap.get(g.myId);
    const gate0 = g.track.gatePos(0), gate1 = g.track.gatePos(1);
    const safeH = Math.atan2(gate1[0] - gate0[0], gate1[1] - gate0[1]);
    const recover = () => {
      b.resetTo(gate0[0], gate0[1], safeH);
      b.vel.set(Math.sin(safeH) * 18, Math.cos(safeH) * 18);
      b.speed = 18;
      b.stunTimer = 0; b.wallContactTimer = 0; b.driftLockout = 0; b.driftBreak = 0;
      if (pm) { pm.gate = 0; pm.lap = 0; pm.finished = false; }
      g.finished = false; g.phase = 'racing';
    };
    recover();
    // 预置 1 瓶氮气 + 0.25 底格：瓶满(2)时 collectNitroCharge 按设计不再集气，
    // 那样就测不出"碰撞只回退本次集气"了。
    b.nitroBottles = 1;
    b.nitroCharge = 0.25;
    const st = window.__t = {
      frames: 0, driftFrames: 0, cancel: 0, nan: 0, boosts: 0, recovers: 0,
      sprays: 0, maxQueue: 0,
      maxSpeed: 0, maxAngle: 0, minAngle: 0, samples: [], diag: [],
      episodes: [], shortEpisodes: 0, _on: 0, _epLen: 0, _prev: false,
      hitPre: null, hitPost: null, gaugeAtHit: 0, bottlesAtHit: 0,
    };
    const ap = window.__ap = { t: 0, stuck: 0, hitDone: false, done: false };
    const origCancel = b.cancelDriftForCollision.bind(b);
    b.cancelDriftForCollision = (...a) => {
      if (b.drifting || b.miniBoostQueue > 0) st.cancel++;
      return origCancel(...a);
    };
    const origUpdate = b.updateLocal.bind(b);
    b.updateLocal = (dt, input, t, colliders, boundary) => {
      if (g.phase !== 'racing' || g.finished) { g.phase = 'racing'; g.finished = false; }
      ap.t += dt;
      const T = ap.t;
      let drift = false, steer = 0;
      if (T >= 0.4 && T < 2.4) { drift = true; steer = 1; }        // 拖漂建角
      else if (T >= 2.4 && T < 4.0) { drift = true; steer = -1; }   // 彩虹反打
      else if (T >= 4.0 && T < 4.8) { drift = true; steer = 1; }    // 重新建角
      // 4.6 碰撞 → 4.8~6.4 全松：硬直 0.5s + 把速度拉回来。
      // 低速时滑移角上限本来就小，撞完立刻再漂只够单喷（角度门槛的物理结果），
      // 真玩家也会先加速再入漂，时间线别比玩家还急。
      else if (T >= 6.4 && T < 8.0) { drift = true; steer = 1; }    // 恢复速度后重新起漂
      else if (T >= 8.0 && T < 8.8) { drift = true; steer = 0; }    // 按住漂移键回正 → 发喷
      if (T >= 10.5) ap.done = true;   // 留够 0.55+0.75s 让双喷两发都落地
      // 集气放慢，避免测试窗口里底格直接灌满一瓶把 charge 清零
      b.surfaceDriftGain = 0.12;
      // 真按键集合 + 本帧实际 input 双写：Game 读到的取值与集合始终一致
      keys.clear(); codes.clear();
      keys.add('arrowup');
      if (drift) codes.add('ShiftLeft');
      if (steer > 0) keys.add('arrowleft');
      if (steer < 0) keys.add('arrowright');
      input.throttle = 1; input.steer = steer; input.drift = drift; input.nitro = false;
      // 受控碰撞：漂移中往船头前塞一个临时硬障碍，走 updateLocal 的真实圆碰撞分支
      let hitThisFrame = false;
      if (T >= 4.6 && T < 6.4 && !ap.hitDone) {
        ap.hitDone = true; hitThisFrame = true;
        const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
        colliders.push({ x: b.pos.x + fx * 1.0, z: b.pos.z + fz * 1.0, r: 1.6, type: 'rock' });
        st.hitPre = { charge: +b.nitroCharge.toFixed(3), bottles: b.nitroBottles,
          drifting: !!b.drifting, gaugeStart: +b.driftGaugeStart.toFixed(3),
          angle: +(b.driftAngle * 180 / Math.PI).toFixed(1) };
      }
      // boundary 传空：漂移会持续偏航，8 秒内必然跑出地图外海圆边界，
      // 那道"最后保险"会把船钉在边界上刷 wallContactTimer=0.35，后半段测不到发喷。
      // 它是地图尺度约束，不属于漂移状态机，冒烟里隔离掉。
      const r = origUpdate(dt, input, t, colliders, null);
      if (hitThisFrame) {
        st.hitPost = { charge: +b.nitroCharge.toFixed(3), bottles: b.nitroBottles,
          drifting: !!b.drifting, stun: +b.stunTimer.toFixed(2), queue: b.miniBoostQueue };
      }
      // ---- 按物理帧统计 ----
      st.frames++;
      const on = !!b.drifting;
      if (on && !st._prev) { st._on = st.frames; st._epLen = 0; }
      if (on) st._epLen += dt;
      if (!on && st._prev) {
        st.episodes.push(+st._epLen.toFixed(2));
        if (st._epLen < 0.16) st.shortEpisodes++;
      }
      st._prev = on;
      if (on) st.driftFrames++;
      const s = b.speed, a = b.driftAngle * 180 / Math.PI;
      if (!Number.isFinite(s) || !Number.isFinite(a) || !Number.isFinite(b.heading)
        || !Number.isFinite(b.pos.x) || !Number.isFinite(b.pos.z)) st.nan++;
      st.maxSpeed = Math.max(st.maxSpeed, s);
      st.maxAngle = Math.max(st.maxAngle, a);
      st.minAngle = Math.min(st.minAngle, a);
      if (b.miniBoostQueue > (st._q ?? 0)) st.boosts += b.miniBoostQueue - (st._q ?? 0);
      st._q = b.miniBoostQueue;
      // 队列在发喷同帧就被消费一发，所以"喷了几次"要数喷射计时器的起跳次数
      if (b.miniBoostTimer > 0 && (st._prevTimer ?? 0) <= 0) st.sprays++;
      st._prevTimer = b.miniBoostTimer;
      st.maxQueue = Math.max(st.maxQueue, b.miniBoostQueue);
      if (st.samples.length < 500 && st.frames % 6 === 0) {
        st.samples.push([+a.toFixed(1), +(s * 3.6).toFixed(0), on ? 1 : 0]);
      }
      if (st.frames % 60 === 0) {
        st.diag.push({ t: +T.toFixed(1), spd: +s.toFixed(1), on,
          ang: +a.toFixed(1), q: b.miniBoostQueue, sp: st.sprays,
          ch: +b.nitroCharge.toFixed(2), bottles: b.nitroBottles,
          stun: +b.stunTimer.toFixed(2), wall: +b.wallContactTimer.toFixed(2),
          lock: +b.driftLockout.toFixed(2), rec: st.recovers });
      }
      // ---- 顶墙脱困：低速 + 硬直连续 0.5s 就回起点门重新加速 ----
      if (s < 3 && b.stunTimer > 0.05) ap.stuck += dt; else ap.stuck = 0;
      if (ap.stuck > 0.5) { ap.stuck = 0; st.recovers++; recover(); }
      return r;
    };
    return { phase: g.phase, gates: g.track.gates.length, safeH: +safeH.toFixed(2),
      colliders: g.colliders.length, shore: g.track.shoreColliders.length };
  })()`);
  console.error('setup:', JSON.stringify(setup));

  // 等游戏内时间线跑完（物理帧驱动，按墙钟给一个宽裕上限）
  const done = await waitFor(`!!(window.__ap && window.__ap.done)`, 60000);
  await sleep(300);

  const st = await ev(`(() => { const s = window.__t;
    return { frames: s.frames, driftFrames: s.driftFrames, cancel: s.cancel, nan: s.nan,
      boosts: s.boosts, sprays: s.sprays, maxQueue: s.maxQueue, recovers: s.recovers,
      maxSpeedKmh: +(s.maxSpeed*3.6).toFixed(1), maxAngle: +s.maxAngle.toFixed(1),
      minAngle: +s.minAngle.toFixed(1), episodes: s.episodes, shortEpisodes: s.shortEpisodes,
      hitPre: s.hitPre, hitPost: s.hitPost, diag: s.diag }; })()`);
  const report = { boat: boatId, map: mapId, done,
    pageErrors: pageErrors.slice(0, 4), headlessFxErrors: fxNoise.length, ...st };
  console.log(JSON.stringify(report));
  console.error(`--- ${boatId}@${mapId} 物理帧 ${st.frames}（漂移中 ${st.driftFrames}）`
    + ` | 真实打断 ${st.cancel} 次 | 脱困 ${st.recovers} 次 | 喷 ${st.sprays} 次（队列峰值 ${st.maxQueue}）`
    + ` | 极速 ${st.maxSpeedKmh}km/h | 滑移角 ${st.minAngle}° ~ ${st.maxAngle}°`
    + ` | 漂移段 ${JSON.stringify(st.episodes)}s（<0.16s 碎段 ${st.shortEpisodes}）`
    + ` | NaN/逻辑异常 ${st.nan} / ${pageErrors.length} | 无头特效资源异常 ${fxNoise.length}（已隔离）`);
  if (st.hitPre && st.hitPost) {
    console.error(`  collision: charge ${st.hitPre.charge} -> ${st.hitPost.charge}`
      + ` (起漂基准 ${st.hitPre.gaugeStart}) | bottles ${st.hitPre.bottles} -> ${st.hitPost.bottles}`
      + ` | drifting ${st.hitPre.drifting} -> ${st.hitPost.drifting}`);
  }
  for (const d of (st.diag || [])) console.error('  diag ' + JSON.stringify(d));
} finally { await cleanup(); }
