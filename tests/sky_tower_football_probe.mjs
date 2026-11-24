// 云端天梯第 1 层「水球赛」实机验收：球 / 球门 / 障碍 + 进球 + 船能撞球
//   WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_football_probe.mjs
// 截图：shots/verify/sky-tower-football-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/football-${stamp}`);
const port = 9990 + (Number(stamp.slice(-2)) % 8);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { fails.push(label); console.log('  ✗ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}
async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting ' + expr + ' (last=' + JSON.stringify(last) + ')');
}
async function shot(expr, file) {
  const dataUrl = val(await evaluate(`(() => { const g=window.__game; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.88);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    ok(false, '截图 ' + file, String(dataUrl).slice(0, 120)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, '截图 ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

try {
  const info = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @ '+e.filename+':'+e.lineno));`,
  });
  // 无头窗口真实视口只有 1088×546，截图按 1280×720 覆盖
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  console.log('\n[1] 进入天梯 · 单人 + 2 AI');
  await cdp('Page.navigate', { url });
  await sleep(3000);
  try {
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 12000);
  } catch {
    await cdp('Page.reload', { ignoreCache: true });
    await sleep(3000);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000);
  }
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='2';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  try {
    await waitFor(`!!window.__game?.localBoat`, 60000);
  } catch (e) {
    console.log('  页面错误: ' + val(await evaluate(`JSON.stringify(window.__errs||[])`)));
    throw e;
  }

  console.log('\n[2] 场景：球 / 球门 / 障碍');
  const st = val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,f=b.football;
    return JSON.stringify({
      mode:g.mode, hasF:!!f, ball:f?{x:+f.ball.x.toFixed(1),z:+f.ball.z.toFixed(1),y:+f.ballMesh.position.y.toFixed(2)}:null,
      obs:f?.obstacles.map(o=>({t:o.type,x:Math.round(o.x),z:Math.round(o.z),r:+o.r.toFixed(1)})),
      goals:f?.goalNets.length, posts:f?.postColliders?.length,
      colliders:b.arena.shoreColliders.length,
      cargoL0:b.cargos.filter(c=>c.layer===0).length,
      cargoAll:b.cargos.length,
      spawn:b.ids.map((id,i)=>({id,x:+g.boats.get(id).pos.x.toFixed(1),z:+g.boats.get(id).pos.z.toFixed(1)})),
    });})()`));
  console.log('  ' + st);
  const s = JSON.parse(st);
  ok(s.mode === 'skytower', '模式 skytower', s.mode);
  ok(s.hasF === true, '足球层已创建');
  ok(s.ball && Math.abs(s.ball.x) < 0.6 && Math.abs(s.ball.z) < 0.6, '球在中圈', s.ball);
  ok(s.ball?.y > 2.0 && s.ball?.y < 3.0, '球落在玻璃台面上（y≈2.5）', s.ball?.y);
  ok(s.obs?.length >= 2 && s.obs?.length <= 3, '障碍 2~3 个', s.obs);
  ok(s.obs?.every((o) => Math.abs(o.x) <= 26 && Math.abs(o.z) <= 18), '障碍只在中圈带', s.obs);
  ok(s.goals === 2, '两个球门', s.goals);
  ok(s.posts === 4, '四根门柱', s.posts);
  ok(s.colliders === s.obs?.length, '障碍同时进了船体碰撞列表', { col: s.colliders, obs: s.obs?.length });
  ok(s.cargoL0 === 0, '第 1 层不再刷货', s.cargoL0);
  ok(s.cargoAll > 0, '第 2 层往上仍是运货（暂时）', s.cargoAll);
  ok(s.spawn?.length === 3, '3 名玩家', s.spawn);

  console.log('\n[3] 快进到 fight + 全景截图');
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(600);
  await shot(`const c=g.camera; c.position.set(0,86,104); c.lookAt(0,0,0); c.updateMatrixWorld();`,
    'sky-tower-football-overview.jpg');
  await shot(`const c=g.camera; c.position.set(28,14,16); c.lookAt(50,4,0); c.updateMatrixWorld();`,
    'sky-tower-football-goal.jpg');

  console.log('\n[4] 船撞球：球被顶出去');
  const kick = val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,f=b.football,me=g.localBoat;
    b.phase='fight';
    // 把球摆在船正前方 6m，船以 28m/s 冲过去
    f.ball.dead=false; f.ball.x=0; f.ball.z=0; f.ball.vx=0; f.ball.vz=0;
    me.pos.set(0,0.4,-6); me.heading=0; me.vel.set(0,28);
    const before=Math.hypot(f.ball.vx,f.ball.vz);
    await new Promise(r=>setTimeout(r,320));
    return JSON.stringify({before, after:+Math.hypot(f.ball.vx,f.ball.vz).toFixed(2),
      bz:+f.ball.z.toFixed(2), boatSpeed:+Math.hypot(me.vel.x,me.vel.y).toFixed(1)});
  })()`));
  console.log('  ' + kick);
  const k = JSON.parse(kick);
  ok(k.after > 8, '球被撞出明显速度（>8m/s）', k);
  ok(k.bz > 0, '球往船头的方向走了', k);

  console.log('\n[5] 障碍反弹');
  const bounce = val(await evaluate(`(async()=>{
    const g=window.__game,f=g.bossMode.football,o=f.obstacles[0];
    f.ball.dead=false;
    f.ball.x=o.x-9; f.ball.z=o.z; f.ball.vx=26; f.ball.vz=0;
    const x0=f.ball.x;
    await new Promise(r=>setTimeout(r,260));
    return JSON.stringify({ox:o.x, ox0:+x0.toFixed(1), vx:+f.ball.vx.toFixed(1), x:+f.ball.x.toFixed(1)});
  })()`));
  console.log('  ' + bounce);
  const bo = JSON.parse(bounce);
  ok(bo.vx < 3, '球撞障碍后被弹回（vx 反向/归零）', bo);

  console.log('\n[6] 进球 + 计分 + 回中圈');
  const goal = val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,f=b.football;
    const p=b.players.get(b.myId);
    const before=p.score;
    f.ball.dead=false; f.ball.x=40; f.ball.z=0; f.ball.vx=42; f.ball.vz=0;
    await new Promise(r=>setTimeout(r,900));
    const mid={dead:f.ball.dead, x:+f.ball.x.toFixed(1), score:p.score, goals:f.goals.get(b.myId)||0};
    await new Promise(r=>setTimeout(r,1400));
    return JSON.stringify({before, ...mid, reset:{x:+f.ball.x.toFixed(1), dead:f.ball.dead}});
  })()`));
  console.log('  ' + goal);
  const gl = JSON.parse(goal);
  ok(gl.dead === true, '球越过门线 → dead（进球）', gl);
  ok(gl.score === gl.before + 1, '进球记在进攻方头上（+1 分）', gl);
  ok(Math.abs(gl.reset?.x ?? 99) < 2 && gl.reset?.dead === false, '1.4 秒后球回中圈', gl.reset);

  console.log('\n[7] 球不出球场（连续 4 秒乱踢）');
  const lock = val(await evaluate(`(async()=>{
    const g=window.__game,f=g.bossMode.football;
    let maxX=0,maxZ=0,bad=0;
    for(let i=0;i<240;i++){
      if(i%12===0){ // 每 0.2 秒随机一脚
        const a=Math.random()*Math.PI*2, s=20+Math.random()*40;
        f.ball.dead=false; f.ball.vx+=Math.cos(a)*s; f.ball.vz+=Math.sin(a)*s;
      }
      await new Promise(r=>requestAnimationFrame(r));
      maxX=Math.max(maxX,Math.abs(f.ball.x)); maxZ=Math.max(maxZ,Math.abs(f.ball.z));
      if(Math.abs(f.ball.x)>50||Math.abs(f.ball.z)>31) bad++;
      if(f.ball.dead){ f.ball.dead=false; f.ball.x=0; f.ball.z=0; f.ball.vx=0; f.ball.vz=0; }
    }
    return JSON.stringify({maxX:+maxX.toFixed(1), maxZ:+maxZ.toFixed(1), bad});
  })()`));
  console.log('  ' + lock);
  const lk = JSON.parse(lock);
  ok(lk.maxX <= 48.5 && lk.maxZ <= 29.5, '球心始终在围板内', lk);
  ok(lk.bad === 0, '没有一帧跑出球场', lk);

  console.log('\n[8] 整页截图（含 HUD）');
  const pageShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.writeFile(path.join(shots, 'sky-tower-football-hud.jpg'), Buffer.from(pageShot.data, 'base64'));
  ok(true, '截图 sky-tower-football-hud.jpg（含 HUD）');

  console.log('\n[9] 控制台错误检查');
  await sleep(400);
  const real = errors.filter((e) => !/effekseer\.min\.js|wasm:\/\/wasm/.test(e));
  ok(real.length === 0, '无未捕获异常（排除 Effekseer 环境噪声）', real.slice(0, 3));

  console.log('\n结果: ' + (fails.length ? `失败 ${fails.length} 项` : '全部通过'));
  if (fails.length) console.log(fails.join('\n'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  fails.push('PROBE EXCEPTION: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
process.exitCode = fails.length ? 1 : 0;
