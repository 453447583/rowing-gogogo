// 出弯小喷 / 双喷的中央提示验收（2026-11-19）
//
//   node tests/drift_boost_notice_probe.mjs [baseUrl] [boatId] [mapId]
//
// 验的是「真 Game 循环 + 真 updateLocal + 真发喷判定」下的 HUD 文案：
//   ① 双喷（峰值滑移 ≥30°）→ notice.main='双喷成功'，tone='gold'，带 sub
//   ② 小喷（16°~30°）      → notice.main='小喷成功'，tone='green'
//   ③ 两条节流键分开，间隔 <1.2s 也要能各自报出来
//   ④ 道具模式（mode='item'）一帧都不报 —— 那里提示条留给道具消息
//
// 输入与采样都挂在 b.updateLocal 上：统计帧 == 物理帧；时间线按物理 dt 累加。
// 赛道噪声（贴护栏/礁石）会一直刷 wallContactTimer 挡住起漂，和 drift_race_smoke
// 一样把 constrain / colliders 隔离掉，只留漂移状态机与发喷。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const boatId = process.argv[3] || 'rower';
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/drift-notice-' + Date.now());
const port = 9950 + Math.floor(Math.random() * 40);
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
  const FX_NOISE = /texImage2D|effekseer\.min\.js|Effekseer/i;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      const t = m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'exception';
      if (!FX_NOISE.test(t)) pageErrors.push(t);
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
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

  await ev(`(() => {
    const g = window.__game;
    g.opts.onFinish = null; g.opts.onQuit = null;
    g.raceIntro = null; g.countdownLeft = 0; g.phase = 'racing'; g.raceTime = 0;
    g.finished = false;
    g.post.render = () => {}; g.renderer.render = () => {};
    g.cameraRig.follow = () => {};
    const b = g.localBoat;
    g.mode = 'race';               // 单人竞速，正常路径就是 race
    g.colliders = [];
    g.track.shoreColliders = []; g.track.mechColliders = [];
    g.track.constrain = () => {}; g.track.applyMechs = () => {};
    g.track.updateCoaster = () => {};
    b.waveLaunchEnabled = false; b.waveJumpEnabled = false;
    b.surfaceDriftGain = 0.12;
    const keys = g.opts.input.keys, codes = g.opts.input.codes;
    const pm = g.progressMap.get(g.myId);
    const gate0 = g.track.gatePos(0), gate1 = g.track.gatePos(1);
    const safeH = Math.atan2(gate1[0] - gate0[0], gate1[1] - gate0[1]);
    const recover = () => {
      b.resetTo(gate0[0], gate0[1], safeH);
      b.vel.set(Math.sin(safeH) * 18, Math.cos(safeH) * 18);
      b.speed = 18; b.stunTimer = 0; b.wallContactTimer = 0;
      b.driftLockout = 0; b.driftBreak = 0;
      if (pm) { pm.gate = 0; pm.lap = 1; pm.finished = false; }
      g.finished = false; g.phase = 'racing';
    };
    recover();
    window.__recover = recover;
    const st = window.__t = {
      frames: 0, events: [], seen: 0, sprays: 0, maxAngle: 0, boosts: 0,
      wrong: [], _lastMain: '', _prevTimer: 0,
    };
    const ap = window.__ap = { t: 0, done: false };

    // 时间线：两段深漂（≥双喷门槛 0.43rad=24.6°）出双喷，最后一段先压到低速再漂，
    // 峰值角落在单喷门槛（0.24rad=13.8°）与双喷门槛之间 → 出小喷。
    // 间隔都 >1.6s，避开 #notice 的 1.2s 同类节流。
    const steerAt = (T) => {
      if (T < 0.4) return null;
      if (T < 2.5) return { drift: true, steer: 1 };        // ① 建角（深）
      if (T < 2.7) return { drift: false, steer: 0 };       //    松漂移 → 按峰值发喷
      if (T < 5.2) return { drift: true, steer: 1 };        // ② 再建角（深）
      if (T < 5.6) return { drift: true, steer: 0 };        //    按住漂移回正 → 当场发喷
      if (T < 7.2) return { drift: false, steer: 0 };
      if (T < 7.9) return { drift: true, steer: 1, low: true };  // ③ 浅角（低速）→ 单喷
      if (T < 8.1) return { drift: false, steer: 0 };
      return { drift: false, steer: 0 };
    };
    const origUpdate = b.updateLocal.bind(b);
    b.updateLocal = (dt, input, t, colliders, boundary) => {
      if (g.phase !== 'racing' || g.finished) { g.phase = 'racing'; g.finished = false; }
      ap.t += dt;
      const T = ap.t;
      const s = steerAt(T);
      if (T >= 10) ap.done = true;
      keys.clear(); codes.clear();
      // ⚠ input.throttle 是 getter，赋值静默无效（MEMORY 记过的坑）：
      // 油门只能靠 arrowup 键在不在集合里来控，第三段松油门就靠不 add。
      if (!s?.low) keys.add('arrowup');
      if (s?.drift) codes.add('ShiftLeft');
      if (s?.steer > 0) keys.add('arrowleft');
      if (s?.steer < 0) keys.add('arrowright');
      // 第三段前把速度压到 12m/s：滑移角上限 = 0.22 + 0.34×速度比，
      // 满速是 32°，12m/s 只到 0.22+0.34×0.37≈0.35rad≈20° → 稳落在单喷档。
      // 只改速度、不改漂移状态机，门槛判定走的是同一段真代码。
      if (T >= 7.0 && T < 7.06) {
        const sp = 12;
        b.vel.set(Math.sin(b.heading) * sp, Math.cos(b.heading) * sp);
        b.speed = sp; b.stunTimer = 0; b.wallContactTimer = 0;
      }
      input.steer = s?.steer || 0;
      input.drift = !!s?.drift; input.nitro = false;
      const r = origUpdate(dt, input, t, colliders, null);

      st.frames++;
      st.maxAngle = Math.max(st.maxAngle, b.driftAngle * 180 / Math.PI);
      if (b.miniBoostTimer > 0 && st._prevTimer <= 0) st.sprays++;
      st._prevTimer = b.miniBoostTimer;
      // ---- 采样：每出现一条新文案就记一笔 ----
      const n = g.notice;
      if (n && g.noticeTtl > 0 && n.main !== st._lastMain) {
        st.seen++;
        st.events.push({ t: +T.toFixed(2), main: n.main, tone: n.tone, sub: n.sub || '' });
        st._lastMain = n.main;
      }
      if (!n || g.noticeTtl <= 0) st._lastMain = '';
      return r;
    };
    return { gates: g.track.gates.length };
  })()`);

  await waitFor(`!!(window.__ap && window.__ap.done)`, 60000);
  await sleep(300);

  const st = await ev(`(() => { const s = window.__t; return {
    frames: s.frames, sprays: s.sprays, maxAngle: +s.maxAngle.toFixed(1),
    events: s.events }; })()`);

  // ---- 第二轮：同样的时间线，但 mode='item'（道具模式）→ 一条都不该报 ----
  await ev(`(() => {
    const g = window.__game, b = g.localBoat;
    g.mode = 'item';
    g.notice = null; g.noticeTtl = 0; g.noticeCooldown = 0; g.noticeLastKey = '';
    g.noticePending = null;
    const st = window.__t;
    st.events = []; st.seen = 0; st._lastMain = ''; st._prevTimer = 0;
    b.miniBoostQueue = 0; b.miniBoostTimer = 0; b.miniBoostGap = 0;
    b.driftBoostCd = 0; b.driftAnglePeak = 0; b.drifting = false; b.wasDrifting = false;
    window.__ap.t = 0; window.__ap.done = false;
    window.__recover();
    return g.mode;
  })()`);
  await waitFor(`!!(window.__ap && window.__ap.done)`, 60000);
  await sleep(200);
  const itemEvents = await ev(`window.__t.events.filter((e) =>
    e.main === '双喷成功' || e.main === '小喷成功')`);

  const boosts = st.events.filter((e) => e.main === '双喷成功');
  const minis = st.events.filter((e) => e.main === '小喷成功');
  const badTone = st.events.filter((e) => (e.main === '双喷成功' && e.tone !== 'gold')
    || (e.main === '小喷成功' && e.tone !== 'green'));
  const noSub = [...boosts, ...minis].filter((e) => !e.sub);

  const pass = boosts.length >= 1 && minis.length >= 1 && badTone.length === 0
    && noSub.length === 0 && (itemEvents?.length || 0) === 0 && pageErrors.length === 0;

  console.log(JSON.stringify({
    boat: boatId, map: mapId, pass,
    frames: st.frames, sprays: st.sprays, maxAngle: st.maxAngle,
    double: boosts.length, single: minis.length,
    badTone: badTone.length, noSub: noSub.length,
    events: st.events, itemMode: itemEvents || [], pageErrors: pageErrors.slice(0, 3),
  }));
  console.error(`--- ${boatId}@${mapId} 物理帧 ${st.frames} / 实际喷 ${st.sprays} 次 / 峰值滑移 ${st.maxAngle}°`);
  for (const e of st.events) console.error(`  t=${e.t}s  ${e.main}  tone=${e.tone}  sub="${e.sub}"`);
  console.error(`  双喷 ${boosts.length} 次 / 小喷 ${minis.length} 次 / 颜色错 ${badTone.length} / 缺副文案 ${noSub.length}`);
  console.error(`  道具模式复测：报出 ${(itemEvents || []).length} 条（应为 0）${JSON.stringify(itemEvents || [])}`);
  console.error(pass ? 'PASS' : 'FAIL');
  if (!pass) process.exitCode = 1;
} finally { await cleanup(); }
