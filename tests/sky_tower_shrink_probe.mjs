// 云端天梯第 7 层（缩圈 · 累计里程）实机验收
//   node tests/sky_tower_shrink_probe.mjs
// 截图：shots/verify/sky-tower-shrink-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/tower-shrink-${stamp}`);
const port = 9990 + (Number(stamp.slice(-2)) % 8);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/?towerCinema=0';
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
    await sleep(200);
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
async function cdpShot(file) {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  const buf = Buffer.from(r.data, 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, 'CDP 截图 ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

const DECK = 108.4;
const GOTO_L7 = `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=6;const bt=b.boats.get(id);if(!bt)continue;
    p.alive=true;p.fallWater=null;bt.skyFall=false;bt.liftRide=null;bt.skyLayer=6;
    bt.diveTargetY=${DECK};bt.vel.set(0,0);bt.vy=0;}
  const me=window.__game.localBoat; me.pos.set(0,${DECK},10); me.heading=0;
  const foe=[...b.boats.values()].find(x=>x!==me); if(foe){foe.pos.set(12,${DECK},-12);}
  return 1;})()`;

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
    if (m.method === 'Page.frameNavigated') {
      const u = m.params?.frame?.url || '';
      if (!/^about:blank$/.test(u)) console.log('  [nav] ' + u);
    }
    if (m.method === 'Inspector.targetCrashed') console.log('  [crash] renderer crashed');
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
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
  await cdp('Page.navigate', { url }); await sleep(3000);
  try { await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 25000); }
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
  try { await waitFor(`!!window.__game?.localBoat`, 60000); }
  catch (e) { console.log('  页面错误: ' + val(await evaluate(`JSON.stringify(window.__errs||[])`))); throw e; }
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(400);
  await evaluate(GOTO_L7);

  console.log('\n[2] 层绑定 / 安全圈几何');
  await sleep(600);
  const raw = val(await evaluate(`(()=>{try{const g=window.__game,b=g.bossMode,r=b.shrink;
    if(!r) return 'ERR:no shrink';
    const R0=35*0.98;
    return JSON.stringify({mode:g.mode, layer:r.layer, deckY:+r.deckY.toFixed(2),
      layerY:+r.group.position.y.toFixed(2), ring:+r.ringR.toFixed(2), R0:+R0.toFixed(2), R1:16,
      running:r.running, timeLeft:+r.timeLeft.toFixed(1),
      wallScale:+r.wall.scale.x.toFixed(2), wallY:+r.wall.position.y.toFixed(1),
      wallH:+r.wall.geometry.parameters.height.toFixed(1),
      rimY:+r.rim.position.y.toFixed(2), targetR:+r.target.geometry.parameters.outerRadius.toFixed(1),
      targetY:+r.target.position.y.toFixed(2),
      topY:+r.top.position.y.toFixed(1), topScale:+r.top.scale.x.toFixed(2),
      dangerScale:+r.danger.scale.x.toFixed(2), dangerIn:+r.danger.geometry.parameters.innerRadius.toFixed(2),
      wallBlend:r.wall.material.blending, wallDepthWrite:r.wall.material.depthWrite,
      layers:[...b.players.values()].map(p=>p.layer)});}catch(e){return 'ERR:'+e.stack;}})()`));
  if (String(raw).slice(0, 1) !== '{') {
    console.log('  raw: ' + String(raw).slice(0, 600));
    console.log('  __errs: ' + val(await evaluate(`JSON.stringify((window.__errs||[]).slice(-6))`)));
    console.log('  cdpErr: ' + JSON.stringify(errors.slice(-4)));
    throw new Error('第 7 层初始化失败');
  }
  const sc = JSON.parse(raw);
  console.log('  ' + JSON.stringify(sc));
  ok(sc.mode === 'skytower', '模式 skytower', sc.mode);
  ok(sc.layer === 6 && sc.deckY === 108.3, '绑定第 7 层 · 甲板 y=108.3', { l: sc.layer, y: sc.deckY });
  ok(sc.layers.every((l) => l === 6), '两条船都在第 7 层', sc.layers);
  ok(Math.abs(sc.ring - sc.R0) < 1.2, '起始安全圈 ≈ 层半径×0.98', { ring: sc.ring, R0: sc.R0 });
  ok(Math.abs(sc.wallScale - sc.ring) < 0.2, '圈墙半径跟着安全圈', { wallScale: sc.wallScale, ring: sc.ring });
  ok(sc.wallH === 7 && Math.abs(sc.wallY - 3.5) < 0.01, '圈墙高度 7m、贴地起', { h: sc.wallH, y: sc.wallY });
  ok(sc.wallBlend === 1 && sc.wallDepthWrite === false, '光幕用普通混合 + 不写深度（禁 AdditiveBlending）',
    { blend: sc.wallBlend, dw: sc.wallDepthWrite });
  ok(Math.abs(sc.targetR - 16) < 0.2 && sc.targetY > 0, '终点圈画在 16m（缩到这里就停）', { r: sc.targetR });
  ok(Math.abs(sc.topY - 7) < 0.01 && Math.abs(sc.topScale - sc.ring) < 0.2, '顶圈把 7m 高的光幕框出来', sc);
  ok(sc.dangerIn >= 1 && Math.abs(sc.dangerScale - sc.ring) < 0.2, '圈外警示带跟着圈走', sc);
  ok(sc.running === true && sc.timeLeft > 60, '本层已开跑', { left: sc.timeLeft });

  console.log('\n[3] 里程 = 逐帧位移累加');
  // 真开：从 (0,-18) 朝 +x 直行，绕开中央塔身、别开到圈外（开出去会掉圈重生产生瞬移）
  const dist = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,r=g.bossMode.shrink;
    const me=g.localBoat;
    r.falls.clear(); r.outT.clear();
    me.pos.set(0,${DECK},-18); me.heading=Math.PI/2; me.vel.set(0,0); me.speed=0;
    await new Promise(res=>setTimeout(res,200));
    const m0=r.metersOf(r.myId);
    let path=0, lx=me.pos.x, lz=me.pos.z;
    const t=setInterval(()=>{path+=Math.hypot(me.pos.x-lx,me.pos.z-lz);lx=me.pos.x;lz=me.pos.z;},25);
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w'}));
    await new Promise(res=>setTimeout(res,1500));
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w'}));
    await new Promise(res=>setTimeout(res,120));
    clearInterval(t);
    path+=Math.hypot(me.pos.x-lx,me.pos.z-lz);
    return JSON.stringify({m0, m1:r.metersOf(r.myId), path:+path.toFixed(1),
      falls:r.fallsOf(r.myId), d:+Math.hypot(me.pos.x,me.pos.z).toFixed(1),
      ring:+r.ringR.toFixed(1)});})()`)));
  console.log('  ' + JSON.stringify(dist));
  // 没头 GPU 帧率低（画质自动降档 + dt 上限 0.05），按"确实在涨 + 与真实位移同量级"卡
  ok(dist.m1 - dist.m0 > 3, '开动起来里程在涨', dist);
  ok(dist.falls === 0 && dist.d < dist.ring, '这段驾驶全程在圈内（没触发掉圈瞬移）', dist);
  ok(Math.abs((dist.m1 - dist.m0) - dist.path) < dist.path * 0.4 + 2,
    '里程 ≈ 实际位移（不是按时间/速度算的）', dist);

  console.log('\n[3b] AI 也在攒里程（缩圈层不能站桩）');
  const ai = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.shrink;
    const id=[...b.boats.keys()].find(k=>k!==b.myId); const bt=b.boats.get(id);
    const m0=r.metersOf(id); const p0={x:+bt.pos.x.toFixed(1),z:+bt.pos.z.toFixed(1)};
    let spdMax=0; const t=setInterval(()=>{spdMax=Math.max(spdMax,bt.speed||0);},40);
    await new Promise(res=>setTimeout(res,3000));
    clearInterval(t);
    return JSON.stringify({id, m0, m1:r.metersOf(id), spdMax:+spdMax.toFixed(1), p0, p1:{x:+bt.pos.x.toFixed(1),z:+bt.pos.z.toFixed(1)},
      spd:+(bt.speed||0).toFixed(1), falls:r.fallsOf(id), ring:+r.ringR.toFixed(1),
      aiLayer:b.players.get(id)?.layer, aiAlive:b.players.get(id)?.alive,
      aiInList:b.players.has(id), fallLog:r.fallLog||[],
      d:+Math.hypot(bt.pos.x,bt.pos.z).toFixed(1)});})()`)));
  console.log('  ' + JSON.stringify(ai));
  // AI 掉出平台会被抓回圈内并扣里程（跟玩家同一套规则），所以偶尔一次掉圈
  // 会把它的里程清零，这里只卡"它确实在高速跑动"，里程增长仅作参考
  const moved = Math.hypot(ai.p1.x - ai.p0.x, ai.p1.z - ai.p0.z);
  ok(moved > 8 && ai.spdMax > 8, 'AI 在缩圈层也在跑（不然单人打 AI 等于白拿分）',
    { moved: +moved.toFixed(1), spdMax: ai.spdMax, m0: ai.m0, m1: ai.m1, falls: ai.falls });

  console.log('\n[4] 瞬移不算里程');
  const tp = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,r=g.bossMode.shrink;
    const me=g.localBoat; const m0=r.metersOf(r.myId);
    me.pos.set(0,${DECK},0); me.vel.set(0,0);   // 一次 18m 以上的瞬移
    await new Promise(res=>setTimeout(res,260));
    return JSON.stringify({m0, m1:r.metersOf(r.myId)});})()`)));
  console.log('  ' + JSON.stringify(tp));
  ok(Math.abs(tp.m1 - tp.m0) <= 2, '单帧位移过大当传送，不计里程', tp);

  console.log('\n[5] 圈外超时 → 掉圈扣里程 + 抓回圈内');
  const fall = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.shrink;
    const me=g.localBoat; const p=b.players.get(b.myId);
    // 底数直接给（只为验证扣减口径，不然要真开 400m）；同时清掉之前的掉圈记录
    r.falls.clear(); r.outT.clear(); r.dist.set(b.myId, 500);
    const m0=r.metersOf(b.myId);
    const outAt=r.ringR+5;
    const t0=performance.now();
    while(performance.now()-t0<4000 && r.fallsOf(b.myId)===0){
      me.pos.set(0,${DECK},outAt); me.vel.set(0,0);
      await new Promise(res=>setTimeout(res,40));
    }
    const back=Math.hypot(me.pos.x,me.pos.z);
    return JSON.stringify({m0, m1:r.metersOf(b.myId), falls:r.fallsOf(b.myId),
      lost:m0-r.metersOf(b.myId), back:+back.toFixed(1), ring:+r.ringR.toFixed(1),
      invuln:+(p.invuln||0).toFixed(2)});})()`)));
  console.log('  ' + JSON.stringify(fall));
  ok(fall.falls === 1, '圈外停留 1.6 秒掉下去一次', fall);
  ok(Math.abs(fall.lost - 80) <= 3, '掉圈扣 80m 里程', fall);
  ok(fall.back <= fall.ring, '被抓回安全圈内', fall);
  ok(fall.invuln > 0, '抓回来给一段无敌', fall);

  console.log('\n[5b] 圈外报警：整圈变红 + 截图');
  const alert0 = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.shrink;
    const me=g.localBoat;
    me.pos.set(0,${DECK},r.ringR+3); me.vel.set(0,0);       // 站到圈外（还没到 1.6 秒）
    await new Promise(res=>setTimeout(res,320));
    const red={rim:r.rim.material.color.getHex(), danger:+r.danger.material.opacity.toFixed(2), myOut:r.myOut};
    return JSON.stringify(red);})()`)));
  console.log('  ' + JSON.stringify(alert0));
  ok(alert0.myOut === true && alert0.rim === 0xff8a5a && alert0.danger > 0.5,
    '在圈外时整圈变红报警', alert0);
  await cdpShot('sky-tower-shrink-outside.jpg');
  const alert1 = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,r=g.bossMode.shrink;
    const me=g.localBoat;
    me.pos.set(0,${DECK},6); me.vel.set(0,0);               // 回圈内
    await new Promise(res=>setTimeout(res,320));
    return JSON.stringify({rim:r.rim.material.color.getHex(), myOut:r.myOut});})()`)));
  console.log('  ' + JSON.stringify(alert1));
  ok(alert1.myOut === false && alert1.rim === 0x9ff8ff, '回圈内恢复青色', alert1);

  console.log('\n[6] 圈会缩、缩到 16m 就停');
  const shrink = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,r=g.bossMode.shrink;
    const me=g.localBoat; me.pos.set(0,${DECK},0); me.vel.set(0,0);
    const r0=+r.ringR.toFixed(2);
    await new Promise(res=>setTimeout(res,1200));
    const r1=+r.ringR.toFixed(2);
    r.shrinkT=59.95;                       // 快进到缩圈末段（#radiusAt 只认 shrinkT）
    await new Promise(res=>setTimeout(res,600));
    const r2=+r.ringR.toFixed(2);
    await new Promise(res=>setTimeout(res,600));
    const r3=+r.ringR.toFixed(2);
    return JSON.stringify({r0, r1, r2, r3, wall:+r.wall.scale.x.toFixed(2)});})()`)));
  console.log('  ' + JSON.stringify(shrink));
  ok(shrink.r1 < shrink.r0, '圈在缩小', shrink);
  ok(Math.abs(shrink.r2 - 16) < 1.2, '缩到 16m 附近', shrink);
  ok(Math.abs(shrink.r3 - shrink.r2) < 0.4, '缩到底之后不再缩', shrink);
  ok(Math.abs(shrink.wall - shrink.r3) < 0.2, '圈墙跟着缩', shrink);

  console.log('\n[7] 缩圈层镜头（圈墙贴地、圈外警示带可见）');
  // 把镜头拉到圈内偏北、朝外看：塔身在背后，正前方 12m 就是圈墙
  await evaluate(`(()=>{const g=window.__game,r=g.bossMode.shrink,me=g.localBoat;
    r.shrinkT=8; r.falls.clear(); r.outT.clear();
    me.pos.set(0,${DECK},18); me.heading=0; me.vel.set(0,0); return 1;})()`);
  await sleep(500);
  await shot('', 'sky-tower-shrink-scene.jpg');
  await cdpShot('sky-tower-shrink-hud.jpg');

  console.log('\n[8] HUD 第 7 层口径');
  const hud = JSON.parse(val(await evaluate(`(()=>{const g=window.__game;
    const d=g.bossMode.hudData();
    return JSON.stringify({shrk:d.towerShrink, meters:d.towerShrinkMeters, ring:d.towerShrinkRing,
      left:d.towerShrinkLeft, falls:d.towerShrinkFalls,
      cap:document.querySelector('#tower-hud .th-cell-cargo .th-cap')?.textContent,
      val:document.getElementById('th-cargo')?.textContent,
      phase:document.getElementById('th-phase-txt')?.textContent,
      hint:document.querySelector('#tower-hud .th-hint')?.textContent,
      cls:document.getElementById('tower-hud')?.className,
      tail:document.querySelector('#th-boards .th-row')?.textContent});})()`)));
  console.log('  ' + JSON.stringify(hud));
  ok(hud.shrk === true, 'HUD 切到缩圈口径', hud);
  ok(/DIST/.test(hud.cap || '') && String(hud.val) === `${hud.meters}m`, '第三格 = 累计里程', hud);
  ok(/缩圈/.test(hud.phase || '') && /安全圈/.test(hud.phase || ''), '阶段条显示缩圈/安全圈/里程', hud.phase);
  ok(/漂移/.test(hud.hint || ''), '底部提示写明漂移也算里程', hud.hint);
  ok(/shrink/.test(hud.cls || ''), 'HUD 挂了 shrink 配色类', hud.cls);
  ok(/m/.test(hud.tail || ''), '榜单尾巴显示米数', hud.tail);

  console.log('\n[9] 时间到 → 按里程结算');
  const fin = JSON.parse(val(await evaluate(`(async()=>{const r=window.__game.bossMode.shrink;
    r.timeLeft=0.01;
    await new Promise(res=>setTimeout(res,500));
    return JSON.stringify({running:r.running, left:+r.timeLeft.toFixed(2),
      order:r.order.map(o=>({id:o.id,n:o.n})), teams:r.teams.length, winner:r.winner,
      meters:[...r.dist.entries()].map(([k,v])=>[k,Math.round(v)])});})()`)));
  console.log('  ' + JSON.stringify(fin));
  ok(fin.running === false && fin.left === 0, '时间到停表', fin);
  ok(fin.order.length >= 1 && fin.order[0].n >= fin.order[fin.order.length - 1].n, '按里程降序排名', fin.order);

  console.log('\n[10] 控制台错误检查');
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
