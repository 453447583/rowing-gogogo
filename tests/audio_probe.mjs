// 音频验收：无头浏览器里真的把 AudioContext 建起来、逐条试播、核对覆盖度。
//
//   node tests/audio_probe.mjs
//
// 为什么值得单独测：
//   ① 音效表是**字符串键**，道具池里加一个新道具而忘了配 `item_<id>`，
//      程序不会报错，只会静默回落到 item_default —— 玩家听到的就是"这个道具没声"；
//   ② BGM 是 setInterval 排程的，调度器写错（while 条件反了 / next 不推进）时
//      第一次 tick 有声音、之后就没了，人耳要听好几秒才发现，脚本 1 秒就能看 step 停没停；
//   ③ 持续层（引擎/漂移）是常驻节点，start/stop 不配对会让节点泄漏，
//      连着打十局之后整台机器都在响 —— 这里断言 stop 之后句柄真的被清空。
//
// 无头 Chrome 没有声卡，但 AudioContext 仍然可用（--mute-audio 只静音输出），
// ctx.currentTime 会照常走，所以节点创建与调度都能验证，只是"听不到"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/audio-probe');
const port = 9741;
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', '--mute-audio',
  // 无头环境没有真实用户手势，自动播放策略会把 ctx 卡在 suspended；
  // 这条 flag 只影响"要不要手势"，不影响节点/调度逻辑本身
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1000,700', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 60000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
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
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  // 等主菜单起来。注意 #btn-solo 是 index.html 里的静态标签，页面一解析就有，
  // 但 main.js 要等整个模块图（three + 场景）拉完才执行到挂 __audio 那一行，
  // 所以必须两个条件一起等，否则会抢在 __audio 之前读（假失败）。
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 40000) {
    const r = await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")');
    if (r.result?.value) { ready = true; break; }
    await sleep(250);
  }
  check('页面启动', ready);
  if (!ready) throw new Error('主菜单/音频模块没起来');

  // ---- 真实手势解锁 ----
  // 必须走 CDP 派发（isTrusted=true）。页面里 eval 出来的 dispatchEvent 是合成事件，
  // 浏览器不认它是"用户手势"，AudioContext 会一直卡在 suspended。
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await sleep(500);

  const unlocked = await evaluate(`(() => {
    const a = window.__audio;
    if (!a) return { error: 'no-audio-handle' };
    return {
      ready: a.ready,
      state: a.ctx ? a.ctx.state : null,
      t: a.ctx ? +a.ctx.currentTime.toFixed(2) : 0,
      vol: a.vol,
      music: a.music ? a.music.mode : null,
    };
  })()`);
  const u = unlocked.result?.value || {};
  check('AudioContext 已建立', u.ready === true, JSON.stringify(u));
  if (!u.ready) throw new Error('音频引擎没起来：' + JSON.stringify(u));
  check('菜单 BGM 在播', u.music === 'menu', `mode=${u.music}`);

  // ---- 1. 道具池 ↔ 音效表 一一对应 ----
  const cover = await evaluate(`(async () => {
    const a = window.__audio;
    const items = await import('/src/game/Items.js');
    const ids = new Set([
      ...Object.keys(items.ITEM_DEFS || {}),
      ...Object.keys(items.BOSS_ITEM_DEFS || {}),
    ]);
    const missing = [...ids].filter((id) => !a.hasSfx('item_' + id));
    return { total: ids.size, missing };
  })()`);
  const c = cover.result?.value || {};
  check('每个道具都有专属音效', c.missing && c.missing.length === 0,
    `${c.total} 个道具${c.missing?.length ? '，缺：' + c.missing.join(',') : ''}`);

  // ---- 2. 逐条试播：任何一条抛异常都说明合成参数写坏了 ----
  const played = await evaluate(`(async () => {
    const m = await import('/src/audio/AudioEngine.js');
    const a = window.__audio;
    const bad = [];
    for (const name of m.SFX_NAMES) {
      try {
        a.play(name, { gap: 0 });
      } catch (e) {
        bad.push(name + ': ' + e.message);
      }
    }
    return { count: m.SFX_NAMES.length, bad };
  })()`);
  const p = played.result?.value || {};
  check('全部音效可试播', p.bad && p.bad.length === 0,
    `${p.count} 条${p.bad?.length ? '，炸了：' + p.bad.join(' | ') : ''}`);

  // ---- 3. BGM 调度器必须持续推进（第一次 tick 有声音、之后没了是最常见的写法错误）----
  const step1 = await evaluate('window.__audio.music ? window.__audio.music.step : -1');
  await sleep(1500);
  const step2 = await evaluate('window.__audio.music ? window.__audio.music.step : -1');
  check('BGM 调度器在推进',
    step1.result?.value >= 0 && step2.result?.value > step1.result?.value,
    `step ${step1.result?.value} → ${step2.result?.value}`);

  // ---- 4. 四套 BGM 都能切 ----
  const modes = await evaluate(`(() => {
    const a = window.__audio;
    const got = [];
    for (const m of ['race', 'boss', 'arena', 'menu']) {
      a.startMusic(m);
      got.push(a.music ? a.music.mode : 'none');
    }
    return got;
  })()`);
  check('四套 BGM 可切换', JSON.stringify(modes.result?.value) === JSON.stringify(['race', 'boss', 'arena', 'menu']),
    JSON.stringify(modes.result?.value));

  // ---- 5. 持续层 start/stop 必须配对，句柄要真的被清掉 ----
  const loops = await evaluate(`(() => {
    const a = window.__audio;
    a.startAmbience();
    const hasEngine = !!a.loops.engine;
    a.setEngine(0.8, true);
    a.setEngine(0.1, false);
    a.startDrift();
    const hasDrift = !!a.loops.drift;
    a.setDrift(0.9);
    a.stopDrift();
    a.stopAmbience();
    return { hasEngine, hasDrift, engineAfter: !!a.loops.engine, driftAfter: !!a.loops.drift };
  })()`);
  const l = loops.result?.value || {};
  check('引擎/水声层可起可停',
    l.hasEngine === true && l.engineAfter === false, JSON.stringify(l));
  check('漂移层可起可停',
    l.hasDrift === true && l.driftAfter === false, JSON.stringify(l));

  // ---- 6. 音量能落到总线上（不是只改了个数字）----
  const vols = await evaluate(`(() => {
    const a = window.__audio;
    a.setVolume('music', 0.2);
    a.setMuted(true);
    const mutedTarget = a.buses.master.gain.value;
    a.setMuted(false);
    return { musicVol: a.vol.music, muted: a.muted, masterGain: a.buses.master.gain.value };
  })()`);
  const v = vols.result?.value || {};
  check('音量写入总线', v.musicVol === 0.2 && v.muted === false, JSON.stringify(v));

  // ---- 7. 进一局：验证比赛 BGM + 引擎层真的被主循环驱动 ----
  // 地图卡片在"选艇屏"里，得先点主菜单的练习模式
  await evaluate(`(() => { document.querySelector('#btn-solo')?.click(); return 1; })()`);
  const tCards = Date.now();
  let cards = 0;
  while (Date.now() - tCards < 20000) {
    const r = await evaluate('document.querySelectorAll(".map-card").length');
    cards = r.result?.value || 0;
    if (cards > 0) break;
    await sleep(250);
  }
  check('选艇屏地图卡片已就绪', cards > 0, `cards=${cards}`);
  await evaluate(`(() => {
    const c = document.querySelector('.map-card');
    if (c) c.click();
    return 1;
  })()`);
  await sleep(300);
  await evaluate(`(() => { document.querySelector('#btn-map-ok')?.click(); return 1; })()`);
  await sleep(9000);
  const race = await evaluate(`(() => {
    const g = window.__game, a = window.__audio;
    if (!g || !a) return { error: 'no-game' };
    return { music: a.music ? a.music.mode : null, engine: !!a.loops.engine, phase: g.phase };
  })()`);
  const r = race.result?.value || {};
  check('开赛切到比赛 BGM', r.music === 'race', JSON.stringify(r));
  check('开赛起引擎层', r.engine === true, JSON.stringify(r));

  const fail = results.filter((x) => !x.ok);
  console.log(`\n${results.length - fail.length}/${results.length} 通过`);
  ws.close(); child.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(fail.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FAIL', e.message);
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
