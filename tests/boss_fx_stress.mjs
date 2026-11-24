// 定位"放漩涡 / 新道具卡死"：不 stub FX，逐个触发并记录崩溃前最后播的特效名。
//   node tests/boss_fx_stress.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boss-fx-stress-' + Date.now());
const port = 9351;
const httpPort = 5179;
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let ok = false;
  for (let i = 0; i < 100 && !ok; i++) {
    try { ok = (await fetch(`http://127.0.0.1:${httpPort}/`)).ok; } catch { /* */ }
    if (!ok) await wait(200);
  }
  if (!ok) { server.kill('SIGKILL'); throw new Error('静态服务未启动'); }
}
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,760',
  `http://127.0.0.1:${httpPort}/`], { stdio: 'ignore' });

let ws; const errors = []; const fxLog = [];
try {
  let tabs;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch { /* */ }
    await wait(200);
  }
  ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  let seq = 0; const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const q = pending.get(m.id); pending.delete(m.id); m.error ? q.rej(new Error(m.error.message)) : q.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push((d.exception?.description || '').split('\n')[0]);
      if (errors.length <= 5) {
        const fr = (d.stackTrace?.callFrames || []).slice(0, 4)
          .map((f) => `${f.functionName || '?'}@${String(f.url).split('/').pop()}:${f.lineNumber}`);
        console.log('  [异常]', errors[errors.length - 1], fr.join(' <- '));
      }
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq; ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: `new Promise(r=>setTimeout(r,${ms}))`, awaitPromise: true });
  const ev = async (e) => {
    const r = await cdp('Runtime.evaluate', { expression: `(function(){try{return (${e})}catch(x){return 'ERR:'+x.message}})()`, returnByValue: true });
    return r.result?.value;
  };
  const waitFor = async (e, ms = 45000) => {
    const t0 = Date.now(); let v;
    while (Date.now() - t0 < ms) { v = await ev(e); if (v) return v; await sleep(250); }
    throw new Error('timeout ' + e + ' last=' + JSON.stringify(v));
  };
  await sleep(1200);
  await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 40000);
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector("#lobby-pick-body [data-mode=\\"boss\\"]")');
  await ev('document.querySelector("#lobby-pick-body [data-mode=\\"boss\\"]").click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.bossMode', 60000);
  await ev('(function(){const b=window.__game.bossMode;b.introT=99;return 1})()');
  await waitFor('window.__game.bossMode.phase === "countdown"');
  await ev('(function(){window.__game.bossMode.countdown=0.02;return 1})()');
  await waitFor('window.__game.bossMode.phase === "fight"');

  // 给 fx.play / playAttached 装日志，但保留原调用，不掩盖崩溃
  await ev(`(function(){
    const fx = window.__game.bossMode.fx;
    if (!fx) return 0;
    const p = fx.play.bind(fx), a = fx.playAttached.bind(fx);
    window.__fxLog = [];
    fx.play = (n, ...rest) => { window.__fxLog.push('play:' + n); return p(n, ...rest); };
    fx.playAttached = (k, n, ...rest) => { window.__fxLog.push('attach:' + n); return a(k, n, ...rest); };
    return 1;
  })()`);

  const items = ['vortex', 'icecage', 'beacon', 'synergy', 'shield', 'angel', 'bomb'];
  for (const item of items) {
    const before = errors.length;
    await ev(`(function(){
      const b = window.__game.bossMode, me = b.players.get(b.myId);
      me.invuln = 0; me.alive = true;
      b.myItems[0] = ${JSON.stringify(item)};
      try { b.input.onItem(0); } catch (e) {}
      return 1;
    })()`);
    await sleep(900);
    const log = await ev('JSON.stringify(window.__fxLog || [])');
    const names = JSON.parse(log || '[]').slice(-8);
    console.log(`${item.padEnd(10)} newErrors=${errors.length - before} lastFx=${names.join(',')}`);
    await ev('window.__fxLog = []; 1');
  }
  console.log('errors:', JSON.stringify([...new Set(errors)].slice(0, 10), null, 2));
} catch (e) {
  console.error('probe error:', e.message);
} finally {
  try { ws?.terminate(); } catch { /* */ }
  try { child?.kill('SIGKILL'); } catch { /* */ }
  server.kill('SIGKILL');
  await wait(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => { /* */ });
}
