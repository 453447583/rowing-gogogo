// 临时：尾焰候选素材接触表。
// 一次浏览器会话里，用真实船尾喷口 + 真实旋转，把每个候选素材各拍两档缩放，
// 输出到 shots/fxprobe/<name>_<scale>.jpg，方便一次性对比形状（是否像"从喷口喷出去"）。
//   node tests/_tmp_fx_jet_probe.mjs
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fxjet-' + Date.now());
const port = 9378;
const httpPort = 5214;
const out = path.resolve('shots/fxprobe');
await fs.mkdir(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// [素材名, 小缩放, 大缩放]
const CASES = [
  ['fxFireBand', 0.3, 0.5],
  ['fxFire2', 0.35, 0.7],
  ['fxFireBall', 0.3, 0.6],
  ['fxEmberSlash', 0.3, 0.6],
  ['fxIceMist', 0.35, 0.7],
  ['fxIceShards', 0.3, 0.6],
  ['fxIceBloom', 0.3, 0.6],
  ['fxWind1', 0.4, 0.8],
  ['fxUpdraft', 0.35, 0.6],
  ['fxArcBolt', 0.35, 0.7],
  ['fxBoltStorm', 0.3, 0.6],
  ['fxSword1', 0.3, 0.6],
  ['fxSwordMoonlight', 0.3, 0.6],
  ['toonWater', 0.6, 1.0],
  ['fxMagic1Water', 0.35, 0.7],
  ['fxHolySandstorm', 0.3, 0.6],
  ['fxSonicBoom', 0.3, 0.6],
  ['fxClawSlash', 0.3, 0.6],
  ['fxSpear1', 0.3, 0.6],
];

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

  // 开一局单人对 AI=0，跑长鲸号（船体最好看、船尾喷口位置清晰）
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 60000, '菜单');
  await ev(`document.querySelector('#btn-solo').click()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 30000, '大厅').catch(async () => {
    await ev(`document.querySelector('#btn-solo').click()`);
    await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 15000, '大厅2');
  });
  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="longship"]')`, 20000, '选艇');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="longship"]').click()`);
  await ev(`(function(){ const c = document.querySelector('#btn-lobby-pick-close'); if (c) c.click(); return 1; })()`);
  await ev(`(function(){ const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; if (s.onchange) s.onchange(); } return 1; })()`);
  await ev(`document.querySelector('#btn-start-race').click()`);
  await waitFor(`!!window.__game?.localBoat`, 60000, '开局');
  await waitFor(`!!window.__game.localBoat.nitroNozzles?.length`, 120000, '模型');
  // 关掉游戏自己的尾焰，只留探针
  await ev(`(function(){ const b = window.__game.localBoat; b.boostTimer = 0; b.nitroLoopTimer = 0; return 1; })()`);
  // 相机固定在船尾正后上方
  await ev(`(function(){
    const g = window.__game, b = g.localBoat;
    g.camera.position.set(b.pos.x - Math.sin(b.heading) * 8.5, b.pos.y + 3.2, b.pos.z - Math.cos(b.heading) * 8.5);
    g.camera.lookAt(b.pos.x, b.pos.y + 0.9, b.pos.z);
    g.camera.updateMatrixWorld(true);
    return 1;
  })()`);

  // 船自己会往前开，所以每次拍照前都要把相机重新贴回船尾
  const shoot = async () => ev(`(function(){
    const g = window.__game, b = g.localBoat;
    g.camera.position.set(b.pos.x - Math.sin(b.heading) * 8.5, b.pos.y + 3.2, b.pos.z - Math.cos(b.heading) * 8.5);
    g.camera.lookAt(b.pos.x, b.pos.y + 0.9, b.pos.z);
    g.camera.updateMatrixWorld(true);
    g.post.render(1 / 60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.72);
  })()`);

  for (const [name, s1, s2] of CASES) {
    for (const scale of [s1, s2]) {
      const ok = await ev(`(function(){
        const g = window.__game, b = g.localBoat;
        g.fx.stopAttached('probe');
        const anchor = b.nitroNozzles[1];
        const follow = () => { const v = { x: 0, y: 0, z: 0 }; const m = anchor.matrixWorld.elements;
          v.x = m[12]; v.y = m[13]; v.z = m[14]; return v; };
        const rot = () => ({ x: Math.PI / 2, y: b.heading + Math.PI, z: 0 });
        g.fx.playAttached('probe', ${JSON.stringify(name)}, follow, {
          rot, loop: true, scale: ${scale}, loopEvery: 0.35, pool: 2,
        });
        return g.fx.attached.has('probe');
      })()`);
      if (!ok) { console.error('FAIL play', name, scale, ok); continue; }
      await sleep(900);
      const img = await shoot();
      if (typeof img === 'string' && img.startsWith('data:image')) {
        await fs.writeFile(path.join(out, `${name}_${scale}.jpg`), Buffer.from(img.split(',')[1], 'base64'));
      }
      await ev(`(function(){ window.__game.fx.stopAttached('probe'); return 1; })()`);
      await sleep(150);
    }
    console.log('ok', name);
  }
} catch (e) {
  console.error('中断：', e.message);
} finally {
  if (child?.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  server.kill();
}
