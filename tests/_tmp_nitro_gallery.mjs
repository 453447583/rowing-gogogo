// 临时探针：逐船截取氮气尾焰（7 条船，排除牛来号），供做手机预览页
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/nitro-gallery-' + Date.now());
const port = 9377;
const httpPort = 5213;
const out = path.resolve('shots/nitro');
await fs.mkdir(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BOATS = (process.env.ONLY ? process.env.ONLY.split(',') : ['rower', 'skiff', 'falcon', 'titan', 'dolphin', 'vintage', 'longship', 'cow']);
const BOAT_FX = {
  rower: 'fxFireBall', skiff: 'toonWater', falcon: 'fxWind1', titan: 'fxIceShards',
  dolphin: 'fxIceMist', vintage: 'fxArcBolt', longship: 'fxFireBand', cow: 'fxUpdraft',
};

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch(`http://127.0.0.1:${httpPort}/`); ready = r.ok; } catch { /* 等 */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来'); }
}
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=960,600',
  `http://127.0.0.1:${httpPort}/`], { stdio: 'ignore' });

let ws;
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    await wait(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: `new Promise(r => setTimeout(r, ${ms}))`, awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: `(function(){ try { return (${expr}); } catch (e) { return 'ERR:' + e.message; } })()`,
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 60000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  for (const id of BOATS) {
    await cdp('Page.navigate', { url: `http://127.0.0.1:${httpPort}/` });
    await sleep(1500);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 60000, id + ' 菜单');
    await ev(`document.querySelector('#btn-solo').click()`);
    await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 30000, id + ' 大厅').catch(async () => {
      await ev(`document.querySelector('#btn-solo').click()`);
      await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 15000, id + ' 大厅2');
    });
    await ev(`document.querySelector('#btn-lobby-boat').click()`);
    await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="${id}"]')`, 20000, id + ' 选艇');
    await ev(`document.querySelector('#lobby-pick-body [data-boat="${id}"]').click()`);
    await ev(`(function(){ const c = document.querySelector('#btn-lobby-pick-close'); if (c) c.click(); return 1; })()`);
    await ev(`(function(){ const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; if (s.onchange) s.onchange(); } return 1; })()`);
    await ev(`document.querySelector('#btn-start-race').click()`);
    await waitFor(`!!window.__game?.localBoat`, 60000, id + ' 开局');
    await waitFor(`window.__game.localBoat.def.id === '${id}'`, 30000, id + ' 船型');
    // 模型换成 GLB 后才有喷口锚点
    await waitFor(`!!window.__game.localBoat.nitroNozzles?.length`, 120000, id + ' 模型');
    await waitFor(`!!window.__game.fx?.effects?.${BOAT_FX[id] || 'jet'}`, 120000, id + ' 素材');
    await ev(`(function(){ const b = window.__game.localBoat; b.boostTimer = 999; b.nitroLoopTimer = 999; return 1; })()`);
    // 让船真的跑起来：不踩油门的话拖尾全都叠在出发点上，截图看不出喷射
    await ev(`(function(){
      const fire = (type, code) => dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
      fire('keydown', 'KeyW'); fire('keydown', 'ArrowUp');
      return 1;
    })()`);
    // 连续采样前先等倒计时过完并跑起来
    await sleep(3200);
    // 连续性采样：加速期间每个喷口上的存活实例数必须始终 >= 1
    // 先等 400ms 让第一帧 update 真的建出 boost:* 实例，否则首个采样点必然读到 0
    await sleep(400);
    const samples = [];
    for (let i = 0; i < 26; i++) {
      samples.push(await ev(`(function(){
        const a = window.__game.fx.attached;
        const n = [...a.entries()].filter(([k]) => k.startsWith('boost:'))
          .map(([, v]) => (v.handles ? v.handles.length : 0));
        return n.length ? Math.min(...n) : 0;
      })()`));
      await sleep(100);
    }
    const minAlive = Math.min(...samples.map((s) => Number(s) || 0));
    await sleep(500);
    const img = await ev(`(function(){
      const g = window.__game, b = g.localBoat;
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      g.camera.position.set(b.pos.x - fx * 8, (b.pos.y || 0) + 3, b.pos.z - fz * 8);
      g.camera.lookAt(b.pos.x, (b.pos.y || 0) + 0.8, b.pos.z);
      g.camera.updateMatrixWorld(true);
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.8);
    })()`);
    if (typeof img === 'string' && img.startsWith('data:image')) {
      await fs.writeFile(path.join(out, `${id}.jpg`), Buffer.from(img.split(',')[1], 'base64'));
      console.log('OK', id, 'minAlive=' + minAlive, await ev(`[...window.__game.fx.attached.keys()].filter(k => k.startsWith('boost:'))`));
    } else {
      console.error('FAIL', id, String(img).slice(0, 160));
    }
  }
} catch (e) {
  console.error('中断：', e.message);
} finally {
  if (child?.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  server.kill();
}
process.exit(0);
