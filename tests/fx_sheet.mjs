// 特效对照表：同一机位、同一比例，逐个渲染候选 Effekseer，用来挑「区域道具」的视觉
//   node tests/fx_sheet.mjs
// 产出 shots/fxsheet/<name>_s<scale>.jpg
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fxsheet-' + Date.now());
const port = 9393;
const httpPort = 5203;
const out = path.resolve('shots/fxsheet');
await fs.mkdir(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 候选：地面法阵 / 光柱 / 墙 / 剑刃 / 沙暴
const CANDIDATES = [
  'fxHolySandstorm', 'fxMagic2Holy', 'fxBenediction', 'fxMagicCircle', 'fxMagicThunder',
  'fxMagic1Water', 'fxThunderRing', 'fxSwordStorm', 'fxSword1', 'fxSwordMoonlight',
  'fxSwordSacred', 'fxSwordLightning', 'fxLight3', 'fxHerald', 'fxSonicBoom',
  'antimagn', 'shield', 'magnet', 'tornado', 'fxGateOfCalve', 'fxLightningStrike',
];
// 三档比例：1=原始尺寸，4=放大四倍，8=再大一档（判断能把 8~14m 区域铺满要用多大）
const SCALES = [1, 4, 8];

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch { /* 等 */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来'); }
}
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=520,320',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
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
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
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

  // 单人道具赛（有 items + fx，场景干净）
  await sleep(1200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 25000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 25000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000, '选艇');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="item"]')`, 20000, '模式');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="item"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev(`(function(){ const s = document.querySelector('#sel-ai'); if (s) { s.value='0'; if (s.onchange) s.onchange(); } return 1; })()`);
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.items', 60000, 'boot');
  await ev('(function(){ window.__game.renderer.setSize(480, 280); return 1; })()');
  await waitFor(`(function(){
    const fx = window.__game.fx;
    return ${JSON.stringify(CANDIDATES)}.every((n) => !!fx?.effects?.[n]);
  })()`, 90000, '特效加载').catch(() => console.error('  (部分特效没加载上，跳过它们)'));
  console.log('  开始逐个渲染…');

  for (const name of CANDIDATES) {
    for (const scale of SCALES) {
      const has = await ev(`!!window.__game.fx?.effects?.[${JSON.stringify(name)}]`);
      if (!has) continue;
      await ev(`(function(){
        const fx = window.__game.items.fx || window.__game.fx;
        for (const k of [...fx.attached.keys()]) fx.stopAttached(k);
        return 1;
      })()`);
      await sleep(120);
      await ev(`(function(){
        const g = window.__game;
        g.fx.playAttached('probe', ${JSON.stringify(name)}, () => ({ x: 0, y: 0.4, z: 0 }), { life: 9, loop: true, scale: ${scale} });
        return 1;
      })()`);
      await sleep(1100);
      const shot = await ev(`(function(){
        const g = window.__game;
        // 固定机位：离原点 26m、高 12m，视野里能容下 ~30m 宽
        g.camera.position.set(13, 12, 22);
        g.camera.lookAt(0, 1.5, 0);
        g.post.render(1 / 60);
        return g.renderer.domElement.toDataURL('image/jpeg', 0.82);
      })()`);
      if (typeof shot === 'string' && shot.startsWith('data:image')) {
        await fs.writeFile(path.join(out, `${name}_s${scale}.jpg`), Buffer.from(shot.split(',')[1], 'base64'));
        console.log(`  ✓ ${name} x${scale}`);
      } else {
        console.error(`  ✗ ${name} x${scale}`, String(shot).slice(0, 100));
      }
    }
  }
} catch (e) {
  console.error('中断：', e.message);
} finally {
  if (child?.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  server.kill();
}
process.exit(0);
