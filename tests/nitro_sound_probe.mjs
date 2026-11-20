// 氮气冲刺音验收（2026-11-19）
//
//   node tests/nitro_sound_probe.mjs [baseUrl] [boatId] [mapId]
//
// 验四件事：
//   ① 触发氮气时播的是 nitro_dash（新 3 秒成品），不是旧的 nitro_ignition
//   ② **不再启动任何循环**（旧版 startLoop('nitro_loop') 是"刺耳像老鼠叫"的来源）
//   ③ 冷却前不重播：0.3s 内连触两次只出声一次；隔 1.3s 再触发才出第二次
//   ④ 自己触发是满音量（vol=1），挂上 3 秒素材应有的时长
//
// 做法：hook window.__audio.play / startLoop 记调用，不碰游戏逻辑。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const boatId = process.argv[3] || 'rower';
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/nitro-sound-' + Date.now());
const port = 9850 + Math.floor(Math.random() * 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=900,560', '--autoplay-policy=no-user-gesture-required', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value;
async function waitFor(expr, ms = 45000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; }
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('timeout ' + u); }

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2500);
  const waitForClick = async (sel) => { await waitFor(`typeof document.querySelector('${sel}')?.onclick === 'function'`); await ev(`document.querySelector('${sel}').click(); 1`); };

  await waitForClick('#btn-solo');
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`);
  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#lobby-pick-body [data-boat="${boatId}"]')?.click(); 1`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-map').click(); 1`); await sleep(400);
  await ev(`document.querySelector('#lobby-pick-body [data-map="${mapId}"]')?.click(); 1`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`); await sleep(300);
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 50000)) throw new Error('对局没起来');
  await sleep(1000);

  // hook 音频：调用层记参数，底层 createBufferSource 记"真正出声"的次数
  const hooked = await ev(`(() => {
    const a = window.__audio;
    if (!a) return { error: 'no __audio' };
    window.__ns = [];
    window.__starts = [];
    const op = a.play.bind(a);
    a.play = (n, o = {}) => { window.__ns.push({ kind: 'play', name: n, vol: o.vol ?? null, gap: o.gap ?? null, lowpass: o.lowpass ?? null, t: performance.now() }); return op(n, o); };
    const sl = a.startLoop.bind(a);
    a.startLoop = (n, o) => { window.__ns.push({ kind: 'loop', name: n, t: performance.now() }); return sl(n, o); };
    return { ready: !!a.ready, state: a.ctx?.state || null, dashBuffered: a.sfxBuffers ? a.sfxBuffers.has('nitro_dash') : null,
      oldIgnition: a.sfxBuffers ? a.sfxBuffers.has('nitro_ignition') : null,
      oldLoop: a.sfxBuffers ? a.sfxBuffers.has('nitro_loop') : null };
  })()`);

  // 无头页面没有真实手势 → 音频引擎还没 unlock，这里手动走一次真实初始化，
  // 再等 3 秒素材解码完（loadSfx 是异步的，不等它 play 会静默回退）
  const afterResume = await ev(`(async () => {
    const a = window.__audio;
    a.unlock();
    if (a.ctx && a.ctx.state !== 'running') { try { await a.ctx.resume(); } catch {} }
    await a.loadSfx();
    const buf = a.sfxBuffers ? a.sfxBuffers.get('nitro_dash') : null;
    // 底层计数：只统计"3 秒素材"真正 start 的次数（gap 拦掉的调用不会走到这里）
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !AC.prototype.__durPatched) {
      AC.prototype.__durPatched = true;
      const orig = AC.prototype.createBufferSource;
      AC.prototype.createBufferSource = function patched() {
        const s = orig.call(this);
        const st = s.start.bind(s);
        s.start = function startPatched(...args) {
          // 时长按解码出的新素材自适应（换素材后不再写死 3 秒）
          if (s.buffer && Math.abs(s.buffer.duration - (buf ? buf.duration : 3)) < 0.08) {
            window.__starts.push({ t: performance.now(), dur: +s.buffer.duration.toFixed(2) });
          }
          return st(...args);
        };
        return s;
      };
    }
    return { state: a.ctx?.state, ready: !!a.ready, dash: buf ? +buf.duration.toFixed(2) : null,
      buffered: a.sfxBuffers ? a.sfxBuffers.size : 0 };
  })()`);

  // ⚠ 三段触发必须在**页面内**用 setTimeout 串起来：CDP 每次 evaluate 往返几百毫秒，
  // 用 Node 侧 sleep 控间隔会把 0.25s 拖成 1s+，节流就被"测没了"（踩过一次）。
  const burst = await ev(`(async () => {
    const b = window.__game.localBoat;
    const s0 = window.__starts.length;
    b.applyFx('nitro');                                   // 第一发：应该出声
    b.applyFx('nitro');                                   // 同一帧再来一发：必被 gap 挡住
    const s1 = window.__starts.length;
    await new Promise((r) => setTimeout(r, 1400));
    b.applyFx('nitro');                                   // 过冷却：应再响一次
    await new Promise((r) => setTimeout(r, 120));
    return { s0, s1, s2: window.__starts.length };
  })()`);
  const s0 = burst?.s0 ?? 0;      // 爆发前的总播放数
  const sMid = burst?.s1 ?? 0;    // 第一发 + 0.25s 内第二发之后
  const sEnd = burst?.s2 ?? 0;    // 过 1.2s 冷却第三发之后

  // 诊断（放在三段测量之后，避免它自己那次出声污染计数）
  const gapDebug = await ev(`(() => {
    const a = window.__audio;
    const before = Math.round(a.lastPlay.get('nitro_dash') || 0);
    const s0 = window.__starts.length;
    a.play('nitro_dash', { gap: 1200 });
    const mid = Math.round(a.lastPlay.get('nitro_dash') || 0);
    const n1 = window.__starts.length;
    a.play('nitro_dash', { gap: 1200 });
    const after = Math.round(a.lastPlay.get('nitro_dash') || 0);
    const n2 = window.__starts.length;
    return { before, mid, after, now: Math.round(performance.now()),
      delta: [n1 - s0, n2 - n1], lastPlaySize: a.lastPlay.size };
  })()`);

  const all = (await ev(`window.__ns || []`)) || [];
  const plays = all.filter((x) => x.kind === 'play');
  const loops = all.filter((x) => x.kind === 'loop');
  const dashPlays = plays.filter((x) => x.name === 'nitro_dash');
  const badNames = plays.filter((x) => x.name !== 'nitro_dash').map((x) => x.name);

  const checks = {
    '音频就绪': !!afterResume?.ready && afterResume?.state === 'running',
    '新素材已解码': (afterResume?.dash || 0) > 2.5,
    '旧素材未加载': hooked.oldIgnition === false && hooked.oldLoop === false,
    '第一次真的出声': sMid - s0 >= 1,
    '0.25s 内不重播': sMid - s0 === 1,
    '过冷却后再出声': sEnd - sMid === 1,
    '没有启动循环': loops.length === 0,
    '只播 nitro_dash': badNames.length === 0,
    '本地满音量': dashPlays.filter((x) => x.vol === 1).length >= 1,
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);

  console.log(JSON.stringify({
    pass: bad.length === 0, checks, hooked, afterResume, gapDebug,
    starts: { s0, sMid, sEnd },
    triggers: plays.map((x) => ({ n: x.name, vol: x.vol, gap: x.gap, lp: x.lowpass })),
    loops: loops.map((x) => x.name), bad,
  }, null, 1));
  console.error(bad.length === 0 ? 'PASS' : `FAIL → ${bad.join(' / ')}`);
  if (bad.length) process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
