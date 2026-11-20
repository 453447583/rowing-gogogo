// AI 冲线探针：确认主机端 AI 仍然按"船头压线"结算，并且能打开 10s 结算窗口。
//
//   node tests/ai_finish_probe.mjs
//
// 做法：把一台 AI 艇摆到终点线后 6m、把弧长门槛灌满，下一帧再摆到线前 6m ——
// 两帧之间船头线段正好跨过终点线，等价于"它自己开过去了"，但不依赖 AI 转向。
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/ai-${stamp}`;
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1024,600', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
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
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

const place = (dist) => `(() => {
  const g = window.__game, T = g.track, L = g.finishLine;
  const b = g.aiBoats.find((x) => !g.progressMap.get([...g.boats].find(([, v]) => v === x)[0])?.finished);
  if (!b) return 'NO_AI';
  b.resetTo(L.x + L.dx * ${dist}, L.z + L.dz * ${dist}, Math.atan2(L.dx, L.dz));
  return 'ok';
})()`;

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  const errors = [];
  await cdp('Runtime.enable'); await cdp('Page.enable');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
    }
  });
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(400);
  // 单人默认 0 台 AI，先补 3 台
  await evaluate(`(() => {
    const sel = document.querySelector('#sel-ai');
    if (sel) { sel.value = '3'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    return sel ? sel.value : 'no-sel';
  })()`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await waitFor(`window.__game.aiBoats.length > 0`, 60000);

  await evaluate(`(() => {
    const g = window.__game;
    window.__fin = 0;
    g.opts.onFinish = (r) => { window.__fin = r; };
    g.track.constrain = () => {}; g.track.applyMechs = () => {};
    g.finishLaps = 1;              // 过线一次就算完赛，省时间
    if ('countdownLeft' in g) g.countdownLeft = 0;
    return 1;
  })()`);

  console.log('A', val(await evaluate(place(-6))));
  await sleep(400);
  // 灌满弧长门槛（等价于"它已经跑完这一圈"）
  await evaluate(`(() => {
    const g = window.__game;
    for (const [, pm] of g.progressMap) {
      if (pm.finState) pm.finState.arcSince = g.track.arcTotal * 0.9;
      pm.lap = 1;
    }
    return 1;
  })()`);
  const before = val(await evaluate(`(() => {
    const g = window.__game;
    return [...g.progressMap].map(([id, pm]) => ({ id, lap: pm.lap, fin: pm.finished }));
  })()`));
  console.log('B', val(await evaluate(place(6))));
  await sleep(700);
  const after = val(await evaluate(`(() => {
    const g = window.__game;
    return {
      rows: [...g.progressMap].map(([id, pm]) => ({ id, lap: pm.lap, fin: pm.finished })),
      finWindow: g.finishWindowActive, onFinish: window.__fin,
    };
  })()`));
  console.log('BEFORE', JSON.stringify(before));
  console.log('AFTER ', JSON.stringify(after));
  console.log('AI 结算成功:', after.rows.some((r) => r.fin) ? 'YES' : 'NO');
  console.log('结算窗口打开:', after.finWindow ? 'YES' : 'NO');
  if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 3));
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
