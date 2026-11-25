// 临时取景脚本：只进第 2 层拍包子/石台/终点门/泡泡的近距离图，方便调视觉
//   node tests/_tmp_deliver_shots.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/dshot-${stamp}`);
const port = 9930 + (Number(stamp.slice(-2)) % 8);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}
async function shot(expr, file) {
  const dataUrl = val(await evaluate(`(() => { const g=window.__game; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.92);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    console.log('  ✗ ' + file + ' ' + String(dataUrl).slice(0, 100)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  console.log('  ✓ ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

try {
  const info = await (async () => {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) return r.json(); } catch {}
      await sleep(250);
    }
    throw new Error('devtools 没起来');
  })();
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  await cdp('Page.navigate', { url });
  await sleep(3200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 40000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='0';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);

  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');
    const me=window.__game.localBoat; const p=b.players.get(b.myId);
    p.layer=1; me.skyLayer=1; me.pos.set(0,18.4,15); me.diveTargetY=18.4; me.vel.set(0,0);
    const d=b.deliver; d.carrierId=null; d.cargo.held=false; d.respawnIn=0; d.cargo.x=0; d.cargo.z=15;
    return 1;})()`);
  await sleep(1200);
  // 把玩家挪开镜头，别挡着；顺手把货放回石台（刚才站在石台上已经把它背走了）
  await evaluate(`(()=>{const me=window.__game.localBoat; me.pos.set(0,18.4,-30); me.vel.set(0,0);
    const d=window.__game.bossMode.deliver;
    d.carrierId=null; d.cargo.held=false; d.respawnIn=0; d.cargoReturn=false;
    d.cargo.x=0; d.cargo.z=15; d.cargoGroup.position.set(0,3,15); return 1;})()`);
  await sleep(900);

  console.log('取景…');
  await shot(`const c=g.camera; c.position.set(3.4,21.9,20.6); c.lookAt(0,21.0,15); c.updateMatrixWorld();`,
    'd-bun-close.jpg');
  await shot(`const c=g.camera; c.position.set(13,20.1,29); c.lookAt(0,20.4,12); c.updateMatrixWorld();`,
    'd-bun-context.jpg');
  await shot(`const c=g.camera; c.position.set(20,20.2,10); c.lookAt(46,20.6,0); c.updateMatrixWorld();`,
    'd-gate.jpg');
  await shot(`const c=g.camera; c.position.set(-20,20.2,10); c.lookAt(-46,20.6,0); c.updateMatrixWorld();`,
    'd-gate-cool.jpg');
  await evaluate(`(()=>{const d=window.__game.bossMode.deliver;
    d.cooldown.clear(); d.fire('shot', {pos:{x:0,y:18.4,z:4}, heading:0}, 1);
    const b=d.bubbles[d.bubbles.length-1];
    // t 不能给负数：u=t/FUSE 为负会让泡泡缩成一颗弹珠（截图时踩过）
    if(b){ b.vx=0; b.vz=0; b.x=2; b.z=6; b.t=2.2; }
    return 1;})()`);
  await sleep(120);
  await shot(`const c=g.camera; c.position.set(6,20.7,13); c.lookAt(2,20.4,6); c.updateMatrixWorld();`,
    'd-bubble.jpg');
  await shot(`const c=g.camera; c.position.set(0,36,62); c.lookAt(0,19.5,12); c.updateMatrixWorld();`,
    'd-layer-overview.jpg');

  // 背货视觉：包子挂在船尾上方，别飞到天上或沉进地板
  await evaluate(`(()=>{const g=window.__game,b=g.bossMode,d=b.deliver,me=g.localBoat;
    me.pos.set(6,18.4,6); me.heading=1.1; me.vel.set(0,0);
    d.carrierId=b.myId; d.cargo.held=true; d.beacon.visible=false; return 1;})()`);
  await sleep(700);
  await shot(`const c=g.camera; c.position.set(14.5,20.4,15); c.lookAt(6,19.6,6); c.updateMatrixWorld();`,
    'd-carrier.jpg');
  console.log('done');
} catch (e) {
  console.error('异常: ' + (e?.stack || e));
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
