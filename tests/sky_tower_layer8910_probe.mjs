// 云端天梯第 8/9/10 层（水晶攻防 / 涂地竞速 / 加冕仪式）无头验收
//   node tests/sky_tower_layer8910_probe.mjs
//
// 不启动可见浏览器：Edge --headless=new + CDP。
// 除了单人 + AI 的玩法主流程，还会在同页再建一份 isHost=false 的「影子客机」，
// 把房主发出的 towerCrystal* / towerPaint* / towerCrown* 全量喂给它的 applyNet，
// 专门验证联机分支（快照、抢冠、掉冠、加冕、涂地归属）真的能落地。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/tower-8910-${stamp}`);
const port = 9920 + (Number(stamp.slice(-2)) % 30);
const httpPort = 5199;
const url = `http://127.0.0.1:${httpPort}/?towerCinema=0`;
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const vite = await (await import('vite')).createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { port: httpPort, strictPort: true, hmr: false },
});
await vite.listen();

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
const j = async (expr) => {
  const raw = val(await evaluate(expr));
  if (typeof raw !== 'string' || raw[0] !== '{' && raw[0] !== '[') {
    throw new Error('非 JSON 返回: ' + String(raw).slice(0, 400));
  }
  return JSON.parse(raw);
};

async function waitHttp(u, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}
async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(200);
  }
  throw new Error('timeout waiting ' + expr + ' (last=' + JSON.stringify(last) + ')');
}

const DECK8 = 126.3, DECK9 = 144.3, DECK10 = 162.3;

/** 把两条船都搬到某一层，可选把 AI 钉在远处 */
const gotoLayer = (layer, deck) => `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=${layer};const bt=b.boats.get(id);if(!bt)continue;
    p.alive=true;p.fallWater=null;p.invuln=0;bt.skyFall=false;bt.liftRide=null;bt.skyLayer=${layer};
    bt.diveTargetY=${deck};bt.vel.set(0,0);bt.vy=0;bt.speed=0;}
  const me=window.__game.localBoat; me.pos.set(0,${deck},0); me.heading=0;
  const foe=[...b.boats.values()].find(x=>x!==me); if(foe){foe.pos.set(20,${deck},20);}
  return 1;})()`;

try {
  await waitHttp(`http://127.0.0.1:${httpPort}/`);
  const info = await waitHttp(`http://127.0.0.1:${port}/json/list`).then(() => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()));
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
    if (m.method === 'Inspector.targetCrashed') console.log('  [crash] renderer crashed');
    if (m.method === 'Page.frameNavigated') {
      const u = m.params?.frame?.url || '';
      if (!/^about:blank$/.test(u)) console.log('  [nav] ' + u);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  try { await cdp('Inspector.enable'); } catch {}
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @ '+e.filename+':'+e.lineno));
      try{
        const rm = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(k){ if(k==='rr-account-token') return; return rm.call(this,k); };
        localStorage.setItem('rr-account-token','probe-token');
      }catch(e){}`,
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  console.log('\n[1] 进入天梯 · 单人 + 1 AI');
  await cdp('Page.navigate', { url });
  await sleep(3000);
  try { await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000); }
  catch { await cdp('Page.reload', { ignoreCache: true }); await sleep(3000);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000); }
  await evaluate(`document.querySelector('#btn-solo').click();1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-mode').click();1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click();1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='1';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click();1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(300);

  console.log('\n[2] 影子客机：同一页面再建一份 isHost=false 的模块');
  const mkGuest = val(await evaluate(`(async()=>{
    const b=window.__game.bossMode;
    const C=await import('/src/game/SkyTowerCrystalRun.js');
    const P=await import('/src/game/SkyTowerPaintRun.js');
    const W=await import('/src/game/SkyTowerCrownRun.js');
    const sock={out:[]};
    const net={send:(m)=>sock.out.push(m)};
    const sideOf=(id)=>b.players.get(id)?.team==='red'?1:(b.ids.indexOf(id)>0&&b.ids.indexOf(id)%2===1?1:0);
    const isAi=(id)=>!!b.players.get(id)?.ai;
    const gc=new C.SkyTowerCrystalRun(window.__game.scene,{myId:'guest',isHost:false,solo:false,fx:window.__game.fx,
      net,onScore:()=>0,onEvent:()=>{},onToast:()=>{},sideOf,isAi,colliders:[]});
    const gp=new P.SkyTowerPaintRun(window.__game.scene,{myId:'guest',isHost:false,solo:false,fx:window.__game.fx,
      net,onScore:()=>0,onEvent:()=>{},onToast:()=>{},sideOf,isAi,colliders:[]});
    const gw=new W.SkyTowerCrownRun(window.__game.scene,{myId:'guest',isHost:false,solo:false,fx:window.__game.fx,
      net,onScore:()=>0,onEvent:()=>{},onToast:()=>{},sideOf,isAi,colliders:[]});
    gc.group.visible=false;gp.group.visible=false;gw.group.visible=false;
    b.__guest={gc,gp,gw,sock};
    // 房主发出的每一帧网络消息，转手喂给影子客机
    // 注意：单人模式下模块会跳过所有广播，所以这里把 solo 改成 false（只影响发包，不改玩法）
    b.crystal.solo=false; b.paint.solo=false; b.crown.solo=false;
    b.crystal.net.send=(m)=>gc.applyNet(m);
    b.paint.net.send=(m)=>gp.applyNet(m);
    b.crown.net.send=(m)=>gw.applyNet(m);
    return JSON.stringify({ok:true});
  })()`));
  ok(String(mkGuest).includes('ok'), '影子客机创建成功', mkGuest);

  // ---------------------------------------------------------------- 第 8 层
  console.log('\n[3] 第 8 层绑定 / 水晶几何');
  await evaluate(gotoLayer(7, DECK8));
  await sleep(1200);
  const c0 = await j(`(()=>{const b=window.__game.bossMode,r=b.crystal;
    return JSON.stringify({layer:r.layer,deck:+r.deckY.toFixed(1),y:+r.group.position.y.toFixed(1),
      x:[+r.crystals[0].group.position.x.toFixed(1),+r.crystals[1].group.position.x.toFixed(1)],
      hp:r.hp.slice(),segs:[r.segsOf(0),r.segsOf(1)],
      boxes:r.boxes.length,active:r.boxes.filter(x=>x.active).length,
      colliders:b.arena.shoreColliders.filter(c=>c.bottomY>120).length,
      shield:+r.shieldLeft.toFixed(1),clock:r.clockOn,running:r.running});})()`);
  console.log('  ' + JSON.stringify(c0));
  ok(c0.layer === 7 && c0.y === DECK8, '绑定第 8 层 · 甲板 y=126.3', c0);
  ok(c0.x[0] === -24 && c0.x[1] === 24, '两座水晶在 x=±24（边缘往里 6m）', c0.x);
  ok(c0.hp[0] === 300 && c0.hp[1] === 300 && c0.segs[0] === 3, '3 段 × 100 耐久', c0);
  ok(c0.boxes === 6 && c0.colliders >= 4, '6 个道具箱 + 礁石/旋转障碍碰撞圆', c0);
  ok(c0.clock === true && c0.running === true, '本层已开跑', c0);

  console.log('\n[4] 冲撞扣水晶耐久（同时验证客机快照）');
  const ram = await j(`(async()=>{const b=window.__game.bossMode,r=b.crystal,me=window.__game.localBoat;
    r.shieldLeft=0; r.hp=[300,300];
    me.pos.set(14,${DECK8},0); me.heading=Math.PI/2; me.vel.set(0,0); me.speed=0;
    const hp0=r.hp[1];
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w'}));
    const t0=performance.now(); const e0=r.elapsed;
    // 无头渲染帧率会掉，按模块内 elapsed（受 dt 钳制）等，而不是按墙钟
    while(performance.now()-t0<9000 && r.hp[1]===hp0 && r.elapsed-e0<4.0){ await new Promise(res=>setTimeout(res,60)); }
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w'}));
    await new Promise(res=>setTimeout(res,400));
    return JSON.stringify({hp0,hp1:r.hp[1],segs:r.segsOf(1),guestHp:b.__guest.gc.hp[1],
      bounced:+Math.hypot(me.vel.x,me.vel.y).toFixed(1)});})()`);
  console.log('  ' + JSON.stringify(ram));
  ok(ram.hp1 < ram.hp0, '撞到对方水晶会掉耐久', ram);
  ok(ram.guestHp === ram.hp1, '客机血量快照与房主一致', { host: ram.hp1, guest: ram.guestHp });

  console.log('\n[5] 道具箱 → 泡泡炸弹 → 再扣水晶');
  const bub = await j(`(async()=>{const b=window.__game.bossMode,r=b.crystal,me=window.__game.localBoat;
    r.hp=[300,300]; r.charges.clear(); r.shieldLeft=0;
    r.boxes.forEach(x=>{x.active=true;x.respawnAt=0;});
    me.pos.set(0,${DECK8},6); me.vel.set(0,0); me.speed=0;
    await new Promise(res=>setTimeout(res,900));
    const ch=r.charges.get(b.myId)||0;
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1'}));
    const t0=performance.now();
    while(performance.now()-t0<9000 && r.hp[1]===300){ await new Promise(res=>setTimeout(res,80)); }
    await new Promise(res=>setTimeout(res,200));
    return JSON.stringify({charges:ch,left:r.charges.get(b.myId),hp1:r.hp[1],
      guestBubbles:b.__guest.gc.bubbles.length,guestHp:b.__guest.gc.hp[1],
      guestCh:b.__guest.gc.charges.get(b.myId)});})()`);
  console.log('  ' + JSON.stringify(bub));
  ok(bub.charges >= 1, '开到箱子上捡到泡泡炸弹', bub);
  ok(bub.hp1 < 300, '泡泡命中对方水晶掉耐久', bub);
  ok(bub.guestHp === bub.hp1, '客机水晶血量同步', bub);

  console.log('\n[6] 打碎水晶 → 直接获胜并按剩余段数结算');
  const down = await j(`(async()=>{const b=window.__game.bossMode,r=b.crystal,me=window.__game.localBoat;
    r.shieldLeft=0; r.hp=[300,1];
    const meP=b.players.get(b.myId); const s0=meP.score;
    me.pos.set(16,${DECK8},0); me.heading=Math.PI/2; me.vel.set(0,0); me.speed=0;
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w'}));
    const t0=performance.now(); const e0=r.elapsed;
    while(performance.now()-t0<12000 && r.running && r.elapsed-e0<5.0){ await new Promise(res=>setTimeout(res,60)); }
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w'}));
    await new Promise(res=>setTimeout(res,500));
    return JSON.stringify({running:r.running,hp:r.hp.slice(),order:r.order.map(o=>({n:o.n})),
      teams:r.teams.length,score:meP.score,s0,winner:r.winner,
      guestRunning:b.__guest.gc.running,guestOrder:b.__guest.gc.order.map(o=>o.id)});})()`);
  console.log('  ' + JSON.stringify(down));
  ok(down.running === false && down.hp[1] === 0, '对方水晶被打碎，本层即时结束', down);
  ok(down.order.length === 2 && down.order[0].n >= down.order[1].n, '按剩余段数排名', down.order);
  ok(down.score > down.s0, '拿到本层排名分（我方大胜）', { s0: down.s0, s: down.score });
  ok(down.guestRunning === false && down.guestOrder.length === 2, '客机收到结算并停表', down);

  // ---------------------------------------------------------------- 第 9 层
  console.log('\n[7] 第 9 层绑定 / 涂地');
  await evaluate(gotoLayer(8, DECK9));
  await evaluate(`(()=>{const r=window.__game.bossMode.paint;r.count=[0,0];
    for(let i=0;i<r.owner.length;i++){if(r.owner[i]>0)r.owner[i]=0;}return 1;})()`);
  await sleep(900);
  const p0 = await j(`(()=>{const b=window.__game.bossMode,r=b.paint;
    return JSON.stringify({layer:r.layer,deck:+r.deckY.toFixed(1),n:r.owner.length,
      playable:r.playable,tl:+r.timeLeft.toFixed(1),clock:r.clockOn,
      rotors:r.rotors.length,colliders:b.arena.shoreColliders.filter(c=>c.bottomY>140).length});})()`);
  console.log('  ' + JSON.stringify(p0));
  ok(p0.layer === 8 && p0.deck === DECK9, '绑定第 9 层 · 甲板 y=144.3', p0);
  ok(p0.n > 1000 && p0.playable > 1000, '地面网格已建立', p0);
  ok(p0.clock === true && p0.rotors === 2, '本层已开跑 + 两根旋转障碍', p0);

  const paint = await j(`(async()=>{const b=window.__game.bossMode,r=b.paint,me=window.__game.localBoat;
    me.pos.set(0,${DECK9},-14); me.heading=Math.PI/2; me.vel.set(0,0); me.speed=0;
    r.inkBreak.clear();
    const c0=r.count[0];
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w'}));
    await new Promise(res=>setTimeout(res,1600));
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w'}));
    await new Promise(res=>setTimeout(res,200));
    return JSON.stringify({c0,c1:r.count[0],ratio:+r.ratioOf(0).toFixed(3),
      guestC:b.__guest.gp.count[0],guestPlay:b.__guest.gp.playable,
      gridColored:r.gridGeo.attributes.color.getW(0)});})()`);
  console.log('  ' + JSON.stringify(paint));
  ok(paint.c1 > paint.c0, '开起来船尾在留色', paint);
  ok(paint.ratio > 0.01, '覆盖率在涨', paint);
  ok(paint.guestC > 0 && Math.abs(paint.guestC - paint.c1) < 200, '客机也按同一份归属涂抹', paint);

  console.log('\n[8] 撞人断笔 / 泡泡清色');
  const ink = await j(`(async()=>{const b=window.__game.bossMode,r=b.paint,me=window.__game.localBoat;
    // 先把 AI 判死，避免它覆盖我方颜色干扰计数
    const foeId=[...b.players.keys()].find(k=>k!==b.myId);
    const pFoe=b.players.get(foeId); const wasAlive=pFoe?.alive; if(pFoe) pFoe.alive=false;
    r.inkBreak.set(b.myId,1.5);
    me.pos.set(0,${DECK9},10); me.heading=0; const c0=r.count[0];
    await new Promise(res=>setTimeout(res,600));
    const stuck=r.count[0];
    r.inkBreak.clear();
    // 先在泡泡落点（船头 +5m）手铺一小片蓝色，确保「清色」有东西可清
    const N=Math.round(Math.sqrt(r.owner.length)), CELL=1.2, HALF=N*CELL/2;
    const bx=0, bz=15;
    for(let iz=0;iz<N;iz++){for(let ix=0;ix<N;ix++){
      const i=iz*N+ix; if(r.owner[i]<0) continue;
      const cx=-HALF+(ix+0.5)*CELL, cz=-HALF+(iz+0.5)*CELL;
      if(Math.hypot(cx-bx,cz-bz)>3) continue;
      if(r.owner[i]!==1){ if(r.owner[i]>0) r.count[r.owner[i]-1]=Math.max(0,r.count[r.owner[i]-1]-1); r.owner[i]=1; r.count[0]++; }
    }}
    const before=r.count[0];
    r.inkBreak.set(b.myId,2.0);   // 这段只验证泡泡清色，不让自己继续涂
    r.fireBubble(b.myId);
    const tb=performance.now();
    while(performance.now()-tb<5000 && r.bubbles.length>0){ await new Promise(res=>setTimeout(res,60)); }
    await new Promise(res=>setTimeout(res,150));
    r.inkBreak.clear();
    if(pFoe) pFoe.alive=wasAlive;
    return JSON.stringify({c0,stuck,before,after:r.count[0],guestC:b.__guest.gp.count[0]});})()`);
  console.log('  ' + JSON.stringify(ink));
  ok(ink.stuck === ink.c0, '断笔期间不涨涂色', ink);
  ok(ink.after < ink.before, '泡泡把落点半径内的颜色清回中立', ink);
  ok(Math.abs(ink.guestC - ink.after) < 260, '客机清色/归属大致同步', ink);

  console.log('\n[9] 时间到 → 按覆盖率结算');
  const pfin = await j(`(async()=>{const b=window.__game.bossMode,r=b.paint,me=b.players.get(b.myId);
    const s0=me.score; r.timeLeft=0.01;
    await new Promise(res=>setTimeout(res,1200));
    return JSON.stringify({running:r.running,order:r.order.map(o=>o.n),teams:r.teams.length,
      s0,score:me.score,guestRun:b.__guest.gp.running,guestTeams:b.__guest.gp.teams.length});})()`);
  console.log('  ' + JSON.stringify(pfin));
  ok(pfin.running === false && pfin.order.length === 2, '时间到停表并排名', pfin);
  ok(pfin.order[0] >= pfin.order[1], '按覆盖率降序', pfin.order);
  ok(pfin.score > pfin.s0, '拿到本层排名分', pfin);
  ok(pfin.guestRun === false && pfin.guestTeams === 2, '客机收到结算', pfin);

  // ---------------------------------------------------------------- 第 10 层
  console.log('\n[10] 第 10 层绑定 / 皇冠落地');
  await evaluate(gotoLayer(9, DECK10));
  // 先让 AI 消失，保证这段只验证「皇冠落地 + 单人抢」的确定性
  await evaluate(`(()=>{const b=window.__game.bossMode;
    const id=[...b.players.keys()].find(k=>k!==b.myId);
    const p=b.players.get(id); if(p) p.alive=false;
    const bt=b.boats.get(id); if(bt){bt.pos.set(20,${DECK10},20);bt.vel.set(0,0);}
    return 1;})()`);
  await sleep(2600);
  const w0 = await j(`(()=>{const b=window.__game.bossMode,r=b.crown;
    return JSON.stringify({layer:r.layer,deck:+r.deckY.toFixed(1),state:r.crown.state,
      x:+r.crown.x.toFixed(1),z:+r.crown.z.toFixed(1),holder:r.holder,
      zones:r.zones.length,rotors:r.rotors.length,clock:r.clockOn,
      guestState:b.__guest.gw.crown.state,guestX:+b.__guest.gw.crown.x.toFixed(1)});})()`);
  console.log('  ' + JSON.stringify(w0));
  ok(w0.layer === 9 && w0.deck === DECK10, '绑定第 10 层 · 甲板 y=162.3', w0);
  ok(w0.zones === 2 && w0.rotors === 2, '两个加冕区 + 两根旋转障碍', w0);
  ok(w0.state === 'idle' && !w0.holder, '皇冠已落地待抢', w0);
  ok(w0.guestState === 'idle' && Math.abs(w0.guestX - w0.x) < 0.4, '客机同步皇冠落点', w0);

  console.log('\n[11] 抢冠 → 自家加冕区站 3 秒 +8');
  const crown1 = await j(`(async()=>{const b=window.__game.bossMode,r=b.crown,me=window.__game.localBoat;
    const [foeId,foe]=[...b.boats.entries()].find(([id])=>id!==b.myId)||[];
    // 先把 AI 判死，避免它在这段里抢冠/撞人干扰读条
    const pFoe=b.players.get(foeId); const wasAi=pFoe?.ai; if(pFoe) pFoe.alive=false;
    if(foe){foe.pos.set(20,${DECK10},-20);foe.vel.set(0,0);}
    me.pos.set(r.crown.x,${DECK10},r.crown.z); me.vel.set(0,0); me.speed=0;
    const t0=performance.now();
    while(performance.now()-t0<2600 && r.holder!==b.myId){ await new Promise(res=>setTimeout(res,50)); }
    const got=r.holder;
    const guestHolder=b.__guest.gw.holder;
    const s0=b.players.get(b.myId).score;
    me.pos.set(r.zones[0].x,${DECK10},0); me.vel.set(0,0); me.speed=0;
    const t1=performance.now();
    while(performance.now()-t1<12000 && r.counts[0]===0){ await new Promise(res=>setTimeout(res,60)); }
    const out={got,guestHolder,counts:r.counts.slice(),s0,score:b.players.get(b.myId).score,
      holderNow:r.holder,state:r.crown.state,guestCounts:b.__guest.gw.counts.slice()};
    if(pFoe){pFoe.alive=true;pFoe.ai=wasAi;}
    return JSON.stringify(out);})()`);
  console.log('  ' + JSON.stringify(crown1));
  ok(!!crown1.got, '站到皇冠上能捡起来', crown1.got);
  ok(crown1.guestHolder === crown1.got, '客机同步持冠者', { host: crown1.got, guest: crown1.guestHolder });
  ok(crown1.counts[0] >= 1, '在自家加冕区连续站 3 秒完成加冕', crown1);
  ok(crown1.score - crown1.s0 >= 8, '每次加冕 +8 分', { s0: crown1.s0, s: crown1.score });
  ok(crown1.guestCounts[0] >= 1, '客机收到加冕次数', crown1);
  ok(crown1.state === 'drop', '加冕后皇冠重新从塔顶下落', crown1);

  console.log('\n[12] 被撞掉冠 + 2 秒锁');
  const crown2 = await j(`(async()=>{const b=window.__game.bossMode,r=b.crown,me=window.__game.localBoat;
    const [foeId,foe]=[...b.boats.entries()].find(([id])=>id!==b.myId);
    const pFoe=b.players.get(foeId); const wasAi=pFoe.ai; pFoe.alive=false;
    // 等新皇冠落地（AI 先不出场，避免它抢走）
    let guard=0; while(r.crown.state!=='idle' && guard++<220){ await new Promise(res=>setTimeout(res,60)); }
    me.pos.set(r.crown.x,${DECK10},r.crown.z); me.vel.set(0,0); me.speed=0;
    const t0=performance.now();
    while(performance.now()-t0<2200 && r.holder!==b.myId){ await new Promise(res=>setTimeout(res,50)); }
    const got=r.holder;
    // 把 AI 放出来、摆到身边、朝我撞过来（临时关掉 AI 驾驶，免得它自己踩刹车）
    pFoe.alive=true; pFoe.ai=false;
    // 复活无敌 2 秒会挡住"被撞掉冠"，这里显式清零，专测撞冠
    pFoe.invuln=0; b.players.get(b.myId).invuln=0;
    foe.pos.set(me.pos.x-3,${DECK10},me.pos.z); foe.vel.set(24,0); foe.speed=24;
    const t1=performance.now();
    while(performance.now()-t1<5000 && r.holder){ await new Promise(res=>setTimeout(res,40)); foe.vel.set(24,0); foe.speed=24; }
    const dropped=!r.holder;
    const lockAt=r.crown.lock;
    me.pos.set(r.crown.x,${DECK10},r.crown.z);
    await new Promise(res=>setTimeout(res,300));
    const regrab=r.holder;
    pFoe.ai=wasAi;
    return JSON.stringify({got,dropped,lockAt:+(lockAt||0).toFixed(1),regrab,
      dropState:r.crown.state,guestHolder:b.__guest.gw.holder});})()`);
  console.log('  ' + JSON.stringify(crown2));
  ok(!!crown2.got, '第二次也抢到皇冠', crown2);
  ok(crown2.dropped === true, '被对手撞到会掉冠', crown2);
  ok(crown2.lockAt > 0, '掉冠后进入不可拾取锁', crown2);
  ok(!crown2.regrab, '锁定期内抢不回来', crown2);
  ok(!crown2.guestHolder, '客机也看到掉冠', crown2);

  console.log('\n[13] 时间到 → 按加冕次数结算');
  const wfin = await j(`(async()=>{const b=window.__game.bossMode,r=b.crown,me=b.players.get(b.myId);
    const s0=me.score; r.timeLeft=0.01;
    await new Promise(res=>setTimeout(res,1200));
    return JSON.stringify({running:r.running,counts:r.counts.slice(),order:r.order.map(o=>o.n),
      teams:r.teams.length,s0,score:me.score,guestRun:b.__guest.gw.running,
      guestTeams:b.__guest.gw.teams.length});})()`);
  console.log('  ' + JSON.stringify(wfin));
  ok(wfin.running === false && wfin.order.length === 2, '时间到停表并排名', wfin);
  ok(wfin.order[0] >= wfin.order[1], '按加冕次数降序', wfin.order);
  ok(wfin.score >= wfin.s0, '排名分结算（至少不低于原分）', wfin);
  ok(wfin.guestRun === false && wfin.guestTeams === 2, '客机收到结算', wfin);

  console.log('\n[14] HUD 三层口径');
  const hud = await j(`(async()=>{const g=window.__game,b=g.bossMode;
    const out={};
    for(const [layer,deck,key] of [[7,${DECK8},'crystal'],[8,${DECK9},'paint'],[9,${DECK10},'crown']]){
      for(const [id,p] of b.players){p.layer=layer;const bt=b.boats.get(id);if(bt){bt.skyLayer=layer;bt.diveTargetY=deck;bt.pos.y=deck;}}
      await new Promise(res=>setTimeout(res,220));
      const d=b.hudData();
      const cap=key[0].toUpperCase()+key.slice(1);
      out[key]={flag:!!d['tower'+cap],
        mine:d['tower'+cap+'Mine'],
        phase:document.getElementById('th-phase-txt')?.textContent||'',
        panel:document.getElementById('th-'+key)?.className||''};
    }
    return JSON.stringify(out);})()`);
  console.log('  ' + JSON.stringify(hud));
  ok(hud.crystal.flag === true && /3/.test(String(hud.crystal.mine)), 'HUD 切到水晶耐久口径', hud.crystal);
  ok(hud.paint.flag === true && /涂地/.test(hud.paint.phase) && !/hidden/.test(hud.paint.panel),
    'HUD 切到涂地覆盖率口径', hud.paint);
  ok(hud.crown.flag === true && /加冕/.test(hud.crown.phase) && !/hidden/.test(hud.crown.panel),
    'HUD 切到加冕口径', hud.crown);

  console.log('\n[15] 控制台错误检查');
  await sleep(400);
  const real = errors.filter((e) => !/effekseer\.min\.js|wasm:\/\/wasm/.test(e));
  const pageErrs = JSON.parse(val(await evaluate(`JSON.stringify(window.__errs||[])`)) || '[]')
    .filter((e) => !/effekseer|wasm/.test(e));
  ok(real.length === 0 && pageErrs.length === 0, '无未捕获异常',
    { cdp: real.slice(0, 3), page: pageErrs.slice(0, 3) });

  console.log('\n结果: ' + (fails.length ? `失败 ${fails.length} 项` : '全部通过'));
  if (fails.length) console.log(fails.join('\n'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  fails.push('PROBE EXCEPTION: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { await vite.close(); } catch {}
}
process.exitCode = fails.length ? 1 : 0;
