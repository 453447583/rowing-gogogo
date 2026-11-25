// 临时诊断：天梯第 1 层中线"空气墙" / 第 2 层撞到第 1 层障碍的来源
// WB_URL=http://127.0.0.1:5199/ node tests/_tmp_tower_collider_debug.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/tcol-${stamp}`);
const port = 9980 + (Number(stamp.slice(-1)) % 8);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,720', 'about:blank'],
  { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('cdp ' + m)), 60000);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } }); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
async function waitFor(expr, timeout = 45000) { const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = val(await evaluate(expr)); if (last) return last; await sleep(250); }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last)); }
try {
  let info;
  for (let i = 0; i < 120; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (info.length) break; } catch {}
    await sleep(150);
  }
  if (!info) throw new Error('edge debug port timeout');
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url }); await sleep(3000);
  try { await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 12000); }
  catch { await cdp('Page.reload'); await sleep(3000); await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000); }
  await evaluate(`document.querySelector('#btn-solo').click();1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-mode').click();1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click();1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await evaluate(`document.querySelector('#btn-start-race').click();1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';return 1;})()`);
  await sleep(400);
  const info2 = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,me=g.localBoat;
    const list=[...g.env.colliders,...b.arena.shoreColliders,...b.arena.mechColliders];
    return JSON.stringify({map:g.mapDef?.id, envN:g.env.colliders.length, shoreN:b.arena.shoreColliders.length,
      boatY:+me.pos.y.toFixed(2), ball:{x:+b.football.ball.x.toFixed(1),z:+b.football.ball.z.toFixed(1),r:b.football.ball.r},
      near:list.map((c,i)=>({i,src:i<g.env.colliders.length?'env':i<g.env.colliders.length+b.arena.shoreColliders.length?'shore':'mech',
        x:+(c.x||0).toFixed(1),z:+(c.z||0).toFixed(1),r:+(c.r||0).toFixed(1),
        b:c.bottomY==null?'none':+c.bottomY.toFixed(1),t:c.topY==null?'none':+c.topY.toFixed(1)}))
        .filter(c=>Math.abs(c.x)<40&&Math.abs(c.z)<25),
      obstacles:b.football.obstacles.map(o=>({x:+o.x.toFixed(1),z:+o.z.toFixed(1),r:+o.r.toFixed(1)}))});})()`)));
  console.log(JSON.stringify(info2, null, 1));
  // 中线实测：把球挪开，船从 (-12,0.4,0) 朝 +x 冲，看能不能越过 x=0
  const run = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,me=g.localBoat;
    b.football.ball.x=70; b.football.ball.z=25;
    me.pos.set(-12,0.4,0); me.heading=Math.PI/2; me.vel.set(34,0); me.stunTimer=0;
    const out=[];for(let i=0;i<45;i++){await new Promise(r=>requestAnimationFrame(r));
      if(i%5===0)out.push([+me.pos.x.toFixed(1),+me.pos.y.toFixed(1),+me.vel.x.toFixed(1),+(me.stunTimer||0).toFixed(2)]);}
    return JSON.stringify(out);})()`)));
  console.log('中线冲刺轨迹 [x,y,vx,stun]:', JSON.stringify(run));
} catch (e) { console.error('诊断异常', e); } finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} }
