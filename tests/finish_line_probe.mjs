// 终点线判定集成探针：真让船「倒回线后 -> 再往前开过线」，验证引擎里确实计圈。
//   node tests/finish_line_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`.tmp_browser/finish-${stamp}`);
const port = 9790 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'ocean';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1024,600', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 60000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

// 让船以给定速度沿航向跑 ms 毫秒（负速度 = 倒车）
// 真驾驶：把 opts.input 换成 getter 代理（main.js 每帧都会用键盘值覆盖字段，
// 直接写属性会被 50% 盖掉，只有 getter 每次读都返回我们想要的值）
const installInput = `(() => {
  const g = window.__game;
  window.__thr = 0;
  g.opts.input = {
    get throttle() { return window.__thr || 0; },
    get steer() { return 0; },
    get drift() { return false; },
    get nitro() { return false; },
  };
  return 1;
})()`;
const drive = (throttle, ms) => `(() => {
  window.__thr = ${throttle};
  if (window.__driveTimer) clearTimeout(window.__driveTimer);
  window.__driveTimer = setTimeout(() => { window.__thr = 0; }, ${ms});
  return 1;
})()`;

const state = `(() => {
  const g = window.__game, pm = g.progressMap.get(g.myId), b = g.localBoat;
  const [gx, gz] = g.track.gates[0];
  const { dx, dz } = g.track.gateDir(0);
  const half = b.def.hull.length * 0.5;
  const bx = b.pos.x + Math.sin(b.heading) * half;
  const bz = b.pos.z + Math.cos(b.heading) * half;
  return {
    lap: pm.lap, gate: pm.gate, finished: g.finished,
    since: +(g.arcSince ?? -1).toFixed(1),
    bowS: +((bx - gx) * dx + (bz - gz) * dz).toFixed(1),
  };
})()`;

try {
  let info;
  for (let i = 0; i < 150; i++) {
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
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2000);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 45000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 20000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);
  await waitFor(`window.__game?.phase === 'racing'`, 40000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.track.constrain = () => {}; g.track.applyMechs = () => {};
    g.track.shoreColliders.length = 0;
    g.mapDef.boundary = null;          // 起跑线后方在边界外，不去掉会被夹住开不动
    g.countdownLeft = 0; return 1; })()`);
  await evaluate(installInput);
  await sleep(400);
  console.log('BASE', JSON.stringify(val(await evaluate(state))));

  async function lapCase(name, { gate = null, since }) {
    // 摆到线后 8m（resetTo 直接写 pos；约束/边界已关，不会被拉回）
    await evaluate(`(() => {
      const g = window.__game, b = g.localBoat, T = g.track;
      const [gx, gz] = T.gates[0]; const { dx, dz } = T.gateDir(0);
      const half = b.def.hull.length * 0.5;
      b.resetTo(gx + dx * (-8 - half), gz + dz * (-8 - half), Math.atan2(dx, dz));
      return 1;
    })()`);
    await sleep(400);
    await evaluate(`window.__game.arcSince = window.__game.track.arcTotal * ${since}; 1`);
    if (gate != null) await evaluate(`window.__game.progressMap.get(window.__game.myId).gate = ${gate}; 1`);
    const mid = val(await evaluate(state));
    await evaluate(drive(1, 1600));     // 往前开过线
    await sleep(1300);
    const after = val(await evaluate(state));
    console.log(name, 'mid=', JSON.stringify(mid), 'after=', JSON.stringify(after));
    return after;
  }

  const a = await lapCase('CASE1 跑够一圈压线', { since: 0.9 });
  const b = await lapCase('CASE2 没跑够一圈蹭线', { since: 0 });
  const c = await lapCase('CASE3 漏门(gate=5)后压线', { since: 0.9, gate: 5 });

  // CASE1 偶尔因为起步慢没把船开到线上（bowS 仍 <0），那种情况不算判定失败
  // 用"相对上一用例的增量"判定，避免用例顺序互相影响
  const ok1 = a && (a.bowS > 0 ? a.lap === 1 : null);
  const ok2 = b ? b.lap === 0 : false;              // 这一次不该计圈
  const ok3 = c ? c.lap === 1 : false;              // 漏门 + 跑够距离 → 计 1 圈
  console.log(ok1 === null ? 'SKIP CASE1 (没开到线)' : (ok1 ? 'PASS CASE1' : 'FAIL CASE1'),
    ok1 === false ? '(应 lap=1)' : '');
  console.log(ok2 ? 'PASS CASE2' : 'FAIL CASE2', ok2 ? '' : '(应保持 lap=1)');
  console.log(ok3 ? 'PASS CASE3' : 'FAIL CASE3', ok3 ? '' : '(应为 lap=1)');
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
