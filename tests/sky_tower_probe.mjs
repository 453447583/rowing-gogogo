// 云端天梯第一关实机验收：开场动画 + 场景渲染 + 运货/上楼/入账玩法
//   node tests/sky_tower_probe.mjs
// 截图：shots/verify/sky-tower-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/skytower-${stamp}`);
const port = 9970 + (Number(stamp.slice(-2)) % 20);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const child = spawn(edge, [
  '--headless=new', '--no-sandbox',
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

  console.log('\n[1] 进入天梯模式');
  await cdp('Page.navigate', { url });
  await sleep(3000);
  // 首屏脚本若因资源竞争没起来，重载一次
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
    const errs = val(await evaluate(`JSON.stringify(window.__errs||[])`));
    console.log('  页面错误: ' + errs);
    throw e;
  }

  const mode = val(await evaluate(`window.__game.mode`));
  ok(mode === 'skytower', '模式为 skytower', mode);
  const st = val(await evaluate(`(()=>{const b=window.__game.bossMode;return JSON.stringify({phase:b?.phase, intro:b?.intro, cargos:b?.cargos?.length, arena:!!b?.arena, scenery:!!b?.scenery});})()`));
  console.log('  初始状态: ' + st);
  const s0 = JSON.parse(st);
  ok(s0.cargos > 0, '货物已生成', s0.cargos);
  ok(s0.arena && s0.scenery, '场景与场地已建');

  console.log('\n[2] 场景渲染（开场镜头）');
  await sleep(1200);
  await shot('', 'sky-tower-cinema.jpg');
  const skyDiff = val(await evaluate(`(()=>{
    const g=window.__game,s=g.bossMode.scenery.sky;
    s.visible=true; g.post.render(1/60); const a=g.renderer.domElement.toDataURL('image/png').length;
    s.visible=false; g.post.render(1/60); const b=g.renderer.domElement.toDataURL('image/png').length;
    s.visible=true; g.post.render(1/60);
    return JSON.stringify({on:a,off:b});
  })()`));
  const sd = JSON.parse(skyDiff);
  ok(sd.on !== sd.off, '体积云天空球真实参与渲染', sd);

  // 调试：列出可见的大物体，排查画面遮挡
  if (process.env.DUMP_SCENE) {
    const scene = val(await evaluate(`(()=>{const g=window.__game,out=[];out.push({envVisible:g.env.group.visible,waterVisible:g.water.mesh.visible,sceneBg:g.scene.background?.type||'none'});g.scene.traverse(o=>{
      if(!o.isMesh||!o.visible)return;let p=o.parent,vis=true;while(p){if(!p.visible)vis=false;p=p.parent;}if(!vis)return;
      const bb=o.geometry?.boundingSphere;if(bb&&bb.radius>100)out.push({n:o.name||o.type,g:o.geometry?.type,r:Math.round(bb.radius),y:Math.round(o.position.y),c:o.material?.color?.getHexString?.()});});return JSON.stringify(out.slice(0,30));})()`));
    console.log('  SCENE: ' + scene);
    const roots = val(await evaluate(`JSON.stringify(window.__game.scene.children.map(o=>({n:o.name||o.type,v:o.visible,c:o.children.length})))`));
    console.log('  ROOTS: ' + roots);
  }

  console.log('\n[3] 快进到 fight 阶段');
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(900);
  await shot('', 'sky-tower-fight.jpg');
  // 3D 画布截图不含 DOM HUD，这里补一张整页截图看 HUD 实际排版
  const pageShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.writeFile(path.join(shots, 'sky-tower-hud.jpg'), Buffer.from(pageShot.data, 'base64'));
  ok(true, '截图 sky-tower-hud.jpg（含 HUD）');
  const hud = val(await evaluate(`JSON.stringify(window.__game.opts.onHud ? window.__game.bossMode.hudData() : {})`));
  console.log('  HUD: ' + hud);
  const hd = JSON.parse(hud);
  ok(hd.mode === 'skytower', 'HUD 模式正确');
  ok(hd.towerPlayers?.length === 3, '3 名玩家（本地+2AI）', hd.towerPlayers?.length);
  ok(hd.towerLayers === 10, '10 层配置', hd.towerLayers);
  ok(hd.towerUpliftOpen === false, '收集期上升通道关闭', hd.towerUpliftOpen);
  ok((hd.towerCollectLeft ?? 0) > 0, '收集期倒计时可见', hd.towerCollectLeft);
  const stadium = val(await evaluate(`!!window.__game.arenaStadium`));
  ok(stadium === true, '竞技场看台已建（塔在赛场中央）');

  console.log('\n[4] 模拟捡货（前 4 层各有小游戏，运货从第 5 层开始）');
  const picked = val(await evaluate(`(()=>{
    const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    p.layer=4; boat.skyLayer=4; boat.pos.y=72.3;
    const c=b.cargos.find(c=>c.mesh.visible&&c.layer===4);
    if(!c) return 'no cargo';
    boat.pos.set(c.mesh.position.x, c.mesh.position.y, c.mesh.position.z);
    b.phase='fight';
    b.update(1/60, 1);
    return JSON.stringify({cargo:p.cargo.length, val:p.cargo[0]?.typeId, layer:p.layer});
  })()`));
  console.log('  ' + picked);
  const pk = JSON.parse(picked);
  ok(pk.cargo >= 1, '拾取货物成功', pk);

  console.log('\n[5] 模拟顶层入账');
  const scored = val(await evaluate(`(()=>{
    const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    const top=b.arena.uplinks.length;
    const dy=b.arena.uplinks[1].y-b.arena.uplinks[0].y;
    p.layer=top; boat.skyLayer=top; boat.pos.set(0, top*dy+0.4, 0);
    const before=p.score;
    b.update(1/60, 2);
    return JSON.stringify({before, after:p.score, layer:p.layer, cargo:p.cargo.length});
  })()`));
  console.log('  ' + scored);
  const sc = JSON.parse(scored);
  ok(sc.after > sc.before, '顶层入账加分', sc);
  ok(sc.layer === 0, '入账后回底层', sc);

  console.log('\n[5a] 60 秒后开启上升通道');
  const opened = val(await evaluate(`(()=>{
    const b=window.__game.bossMode; b.fightTime=61; b.update(1/60,1);
    return JSON.stringify({mode:b.upliftOpen,arena:b.arena.upliftOpen,scenery:b.scenery.upliftOpen});
  })()`));
  console.log('  ' + opened);
  const op = JSON.parse(opened);
  ok(op.mode && op.arena && op.scenery, '玩法/判定/光柱三处同步开启', op);

  console.log('\n[5b] 撞击把对手推下平台');
  const push = val(await evaluate(`(()=>{
    const g=window.__game,b=g.bossMode,me=g.localBoat;
    const otherId=b.ids.find(id=>id!==b.myId), ob=b.boats.get(otherId), op=b.players.get(otherId);
    if(!ob||!op) return JSON.stringify({err:'no foe'});
    const p=b.players.get(b.myId);
    b.phase='fight'; p.ramCd=0; p.overheat=0; op.pushCd=0;
    me.pos.set(0,0.4,0); me.vel.set(21,0,0); me.heading=Math.PI/2;
    ob.pos.set(3,0.4,0); ob.vel.set(0,0,0); ob.vy=0;
    const before=ob.vel.x;
    b.constrainBoat(me);
    return JSON.stringify({before, after:ob.vel.x, lift:ob.vy, cd:op.pushCd});
  })()`));
  console.log('  ' + push);
  const ps = JSON.parse(push);
  ok(ps.after > ps.before + 5, '冲刺撞击给了对手水平推力', ps);
  ok(ps.lift > 0, '撞击带一点上抛（更容易掉下去）', ps);

  console.log('\n[6] 过热机制');
  const heat = val(await evaluate(`(()=>{
    const g=window.__game,b=g.bossMode,p=b.players.get(b.myId);
    b.phase='fight'; p.energy=100; p.overheat=0; p.dashTimes.length=0;
    const now=performance.now()/1000;
    for(let i=0;i<3;i++){ b.dashQueued=true; b.driveBoat(1/60,{throttle:1,steer:1,drift:false,nitro:false}); }
    return JSON.stringify({overheat:p.overheat, energy:p.energy});
  })()`));
  console.log('  ' + heat);
  const ht = JSON.parse(heat);
  ok(ht.overheat > 0, '连续 3 次冲刺触发过热', ht);

  console.log('\n[7] 坠落丢货');
  const fall = val(await evaluate(`(()=>{
    const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    // 手动塞 3 件货（同时维护 cargo 数组与船尾挂载列表，模拟真实拾取）
    const list=b.cargoOnBoat.get(b.myId)||[]; b.cargoOnBoat.set(b.myId,list);
    for(let i=0;i<3;i++){const c=b.cargos.find(c=>c.mesh.visible);if(c){c.mesh.visible=false;p.cargo.push(c);list.push(c);}}
    const before=p.cargo.length;
    const dy=b.arena.uplinks[1].y-b.arena.uplinks[0].y;
    p.invuln=0; p.layer=4; boat.skyLayer=4; boat.pos.set(999,72.4,0);
    b.arena.constrain(boat,1/60);
    return JSON.stringify({before, after:p.cargo.length, layer:p.layer});
  })()`));
  console.log('  ' + fall);
  const fl = JSON.parse(fall);
  ok(fl.after < fl.before, '坠落丢货', fl);

  console.log('\n[8] 控制台错误检查');
  await sleep(600);
  // 无头软光栅下 Effekseer WASM 会报纹理上下文错误（竞技场探针同样有），属环境噪声
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
