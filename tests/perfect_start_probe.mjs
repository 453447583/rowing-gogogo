// 完美起步（严格档）+ 冲线慢动作 的浏览器端探针
//
//   node tests/perfect_start_probe.mjs
//
// 为什么要有它：完美起步的判定嵌在 Game.#loop 的倒计时段里，纯 node 测不到，
// 只能真开一局、改 `countdownLeft` + `input.throttle` 造出「按下的那一帧」。
//
// 验四件事：
//   ① 抢跑（窗口开始前就按住不放）→ 拿不到完美起步；
//   ② 正点（数字 1 → 0 那一瞬按下，±0.15s 窗口内）→ 拿到；
//   ③ 太迟（窗口过了才按）→ 拿不到；
//   ④ 慢动作只放慢世界、不拖长成绩（elapsed 增量 ≈ 0.32 × raceTime 增量）。
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/perfect-${stamp}`;
const port = 9780 + (Number(stamp.slice(-3)) % 20);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = `${base}?raceIntro=0`;
const mapId = process.env.MAP || 'strait';

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

async function waitFor(expr, timeout = 90000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(200);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

let failed = 0;
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

async function startSolo() {
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(250);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  // 只等船建好，**不等 racing**：倒计时只有 4 秒，等它跑完就没得测了。
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
}

/**
 * 把倒计时摆到指定时刻，并清掉上一档的状态。
 * ⚠ `throttle` 是 Input 上的 getter（每次读都从按键集合重算），直接赋值既不会生效
 *   也不会报错 —— 必须动真正的按键集合。这里用 arrowup（油门键之一），
 *   不依赖键位绑定表，改键设置也不会影响探针。
 */
const arm = (left) => evaluate(`(() => {
  const g = window.__game;
  const i = g.opts.input;
  g.phase = 'countdown';
  g.countdownLeft = ${left};
  g.perfectStart = false;
  g.psHeld = false;
  g.psPressedAt = null;
  if (i) { i.frozen = false; i.keys.clear(); i.codes.clear(); }
  return 1;
})()`);

const press = (on) => evaluate(`(() => {
  const i = window.__game.opts.input;
  if (!i) return 0;
  if (${on ? 1 : 0}) i.keys.add('arrowup'); else i.keys.delete('arrowup');
  return 1;
})()`);
const peek = async () => val(await evaluate(`(() => {
  const g = window.__game;
  return {
    perfect: !!g.perfectStart,
    left: g.countdownLeft,
    pressedAt: g.psPressedAt,
    boost: g.localBoat?.boostTimer || 0,
    phase: g.phase,
    notice: g.notice ? { main: g.notice.main, tone: g.notice.tone } : null,
  };
})()`));

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
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

  await startSolo();

  // ---------- ① 抢跑：窗口开始前就按住不放 ----------
  await arm(2.5);
  await press(1);            // 这一帧离「1→0」还有 1.5 秒，远在窗口外
  await sleep(120);
  await evaluate(`(() => { window.__game.countdownLeft = 1.0; return 1; })()`); // 硬推进窗口
  await sleep(120);
  let a = await peek();
  report(a && a.perfect === false, `抢跑（提前按住不放）拿不到完美起步（perfect=${a?.perfect}）`);

  // ---------- ② 正点：窗口内按下 ----------
  await arm(1.5);
  await sleep(80);
  await evaluate(`(() => { window.__game.countdownLeft = 1.05; return 1; })()`);
  await press(1);
  await sleep(120);
  let b = await peek();
  report(b && b.perfect === true, `1.05s 时按下 → 完美起步（perfect=${b?.perfect} 按下于 ${b?.pressedAt?.toFixed?.(2)})`);

  // ---------- ③ 太迟：窗口过了才按 ----------
  await arm(1.5);
  await sleep(80);
  await evaluate(`(() => { window.__game.countdownLeft = 0.6; return 1; })()`);
  await press(1);
  await sleep(120);
  let c = await peek();
  report(c && c.perfect === false, `0.60s 才按下 → 太迟，拿不到（perfect=${c?.perfect}）`);

  // ---------- ④ 正点这一档发车时真的给加速 + 出绿色提示 ----------
  await arm(1.5);
  await sleep(80);
  await evaluate(`(() => { window.__game.countdownLeft = 1.05; return 1; })()`);
  await press(1);
  await sleep(140);
  await evaluate(`(() => { window.__game.countdownLeft = 0.02; return 1; })()`); // 直接推到发车
  await sleep(320);
  const d = await peek();
  report(d && d.phase === 'racing' && d.boost > 1.0, `发车时给氮气（boostTimer=${d?.boost?.toFixed?.(2)}s）`);
  report(d && d.notice && d.notice.main === '完美起步' && d.notice.tone === 'green',
    `中央提示条出「完美起步」绿色（${d?.notice?.main || '无'}/${d?.notice?.tone || '无'}）`);

  // ---------- ⑤ 冲线慢动作：只放慢世界，成绩照真实时间 ----------
  await press(0);
  const slow = val(await evaluate(`(() => {
    const g = window.__game;
    g.phase = 'racing';
    g.finished = false;
    g.startSlowMo = 0.6;
    g.startSlowMoScale = 0.32;
    return { e: g.elapsed, r: g.raceTime, t: performance.now() };
  })()`));
  await sleep(700);
  const slow2 = val(await evaluate(`(() => {
    const g = window.__game;
    return { e: g.elapsed, r: g.raceTime, left: g.startSlowMo };
  })()`));
  const dE = slow2.e - slow.e;
  const dR = slow2.r - slow.r;
  const ratio = dR > 0.01 ? dE / dR : 0;
  report(ratio > 0.15 && ratio < 0.55,
    `慢动作让世界只走 0.32×（elapsed/raceTime = ${ratio.toFixed(2)}，dE=${dE.toFixed(2)}s dR=${dR.toFixed(2)}s）`);
  // 慢动作按「游戏内时间」倒计时，而每帧 dt 被截到 0.05：无头浏览器掉到 8fps 时
  // 墙钟 700ms 只推进约 0.3s 游戏时间。固定 sleep 会假失败，改成轮询等它归零。
  let left = slow2.left;
  for (let i = 0; i < 30 && left > 0; i++) {
    await sleep(150);
    left = val(await evaluate(`window.__game.startSlowMo`));
  }
  report(left === 0, `0.6s 慢动作按时结束（剩余 ${left}）`);

  await evaluate(`(() => { const g = window.__game; g.startSlowMo = 0; g.startSlowMoScale = 0.32; return 1; })()`);
} catch (e) {
  failed += 1;
  console.error('probe error:', e?.message || e);
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  console.log(`\nperfect start / slow-mo probe: ${failed ? `${failed} FAIL` : 'all PASS'}`);
  process.exit(failed ? 1 : 0);
}
