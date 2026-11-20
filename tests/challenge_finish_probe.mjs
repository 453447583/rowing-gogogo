// 挑战模式完赛流程验收：强制完赛 → 检查无 10 秒倒计时/无领奖台/完成面板为挑战版 → 空格回大厅。
//   node tests/challenge_finish_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/chfinish-${stamp}`;
const port = 9955 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const outDir = path.resolve('shots/challenge');

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
async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = val(await evaluate(expr)); if (last) return last; await sleep(250); }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}
try {
  let info;
  for (let i = 0; i < 160; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ } await sleep(150); }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="canyon"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="canyon"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-boss-card[data-mode="challenge"]')`, 30000);
  await evaluate(`document.querySelector('.lp-boss-card[data-mode="challenge"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await evaluate(`(() => { const g=window.__game; window.__origOnFinish = g.opts.onFinish; g.opts.onQuit=()=>{}; return 1; })()`);
  await sleep(500);

  // 触发完赛：真实压线路径受物理/时间影响较大，这里直接置 finished 并调用
  // 原始 onFinish 回调 —— 验证的是 main.js 的完赛 UI 流程（本探针的目标）。
  await evaluate(`(() => {
    const g = window.__game, pm = g.progressMap.get(g.myId);
    g.finished = true;
    pm.finished = true;
    g.finishTime = g.raceTime;
    g.bestLap = g.bestLap ?? (g.raceTime / 3);
    window.__origOnFinish?.({ time: g.finishTime, bestLap: g.bestLap, rank: 1 });
    return 1;
  })()`);
  await sleep(1800);

  const state = val(await evaluate(`(() => ({
    finished: window.__game?.finished,
    finishPanelHidden: document.querySelector('#finish-panel')?.classList.contains('hidden'),
    finishPanelChallenge: document.querySelector('#finish-panel')?.classList.contains('challenge'),
    countdownShow: document.querySelector('#finish-window-countdown')?.classList.contains('show'),
    podiumHidden: document.querySelector('#podium')?.classList.contains('hidden'),
    hint: document.querySelector('#fp-hint')?.textContent,
    medal: document.querySelector('#fp-medal')?.textContent,
    eyebrow: document.querySelector('#fp-eyebrow')?.textContent,
    total: document.querySelector('#fp-total')?.textContent,
    best: document.querySelector('#fp-best')?.textContent,
    ghost: document.querySelector('#fp-ghost')?.textContent,
    standings: document.querySelector('#fp-standings')?.textContent?.trim(),
  }))()`));
  console.log('after finish', JSON.stringify(state));

  await fs.mkdir(outDir, { recursive: true });
  const v = val(await evaluate(`(() => { const g=window.__game; g.post?.render?.(1/60); return g.renderer.domElement.toDataURL('image/jpeg',0.86); })()`));
  if (typeof v === 'string' && v.startsWith('data:image')) {
    await fs.writeFile(path.join(outDir, 'finish.jpg'), Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log('shot challenge/finish.jpg');
  }

  // 空格退出 → 应回大厅
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await sleep(900);
  const afterSpace = val(await evaluate(`(() => ({
    lobbyVisible: !document.querySelector('#lobby')?.classList.contains('hidden'),
    finishPanelHidden: document.querySelector('#finish-panel')?.classList.contains('hidden'),
    game: !!window.__game,
  }))()`));
  console.log('after space', JSON.stringify(afterSpace));

  const ok = state.finished && !state.finishPanelHidden && state.finishPanelChallenge
    && !state.countdownShow && state.podiumHidden
    && /空格/.test(state.hint || '') && (state.standings || '').length === 0
    && afterSpace.lobbyVisible && afterSpace.finishPanelHidden;
  console.log(ok ? 'challenge finish probe: PASS' : 'challenge finish probe: FAIL');
  process.exitCode = ok ? 0 : 2;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
