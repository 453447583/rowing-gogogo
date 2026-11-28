// 云端天梯第 2 层「泡泡送包子」实机验收：包子 / 终点门 / 泡泡 / 持货减速 / 炸落 / 送达计分
//   WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_deliver_probe.mjs
// 截图：shots/verify/sky-tower-deliver-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/deliver-${stamp}`);
const port = 9960 + (Number(stamp.slice(-2)) % 8);
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
    return g.renderer.domElement.toDataURL('image/jpeg', 0.90);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    ok(false, '截图 ' + file, String(dataUrl).slice(0, 120)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, '截图 ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

/** 把所有人拽到第 2 层（探针用，正常流程是走上楼光柱） */
const GOTO_L2 = `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=1;const bt=b.boats.get(id);if(!bt)continue;
    bt.skyLayer=1;bt.pos.y=18.4;bt.diveTargetY=18.4;bt.vel.set(0,0,0);bt.heading=0;}
  const me=window.__game.localBoat; me.pos.set(0,18.4,-14); me.vel.set(0,0); return 1;})()`;

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
    source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @ '+e.filename+':'+e.lineno));
      // 无头验收专用：塞本地 token 过账号门，并拦掉登录面板对 token 的清理。
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
  try {
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 12000);
  } catch {
    await cdp('Page.reload', { ignoreCache: true });
    await sleep(3000);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000);
  }
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='1';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  try {
    await waitFor(`!!window.__game?.localBoat`, 60000);
  } catch (e) {
    console.log('  页面错误: ' + val(await evaluate(`JSON.stringify(window.__errs||[])`)));
    throw e;
  }

  console.log('\n[2] 第 2 层场景：终点门 / 包子 / 石台');
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    b.layerIndex=1;b.layerPhase='round';b.layerTimeLeft=60;b.layerWaitLeft=0;b.upliftOpen=false;
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(400);
  await evaluate(GOTO_L2);
  // 等 GLB 旗门加载（异步）
  let glbOk = false;
  try {
    await waitFor(`(()=>{const d=window.__game.bossMode.deliver;
      return d.gates.every(g=>!!g.holder.userData.glb);})()`, 15000);
    glbOk = true;
  } catch { glbOk = false; }
  const sc = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,d=b.deliver;
    return JSON.stringify({
      mode:g.mode, layer:d.layer, deckY:+d.deckY.toFixed(2),
      gates:d.gates.length, gateX:d.gates.map(x=>+x.x.toFixed(1)),
      gateGlb:d.gates.map(x=>!!x.holder.userData.glb),
      cargo:{held:d.cargo.held,x:+d.cargo.x.toFixed(1),z:+d.cargo.z.toFixed(1)},
      bun:{y:+d.cargoGroup.position.y.toFixed(2), vis:d.cargoGroup.visible,
           geo:d.bunMesh.geometry.attributes.position.count,
           mat:d.bunMesh.material.type, hasMap:!!d.bunMesh.material.map},
      beacon:d.beacon.visible,
      entries:b.ids.map(id=>b.players.get(id).layer),
    });})()`)));
  console.log('  ' + JSON.stringify(sc));
  ok(sc.mode === 'skytower', '模式 skytower', sc.mode);
  ok(sc.layer === 1, '第 2 层模块绑定 layer=1', sc.layer);
  ok(Math.abs(sc.deckY - 18.3) < 0.01, '台面 y = layerY(1)+0.30 = 18.3', sc.deckY);
  ok(sc.gates === 2, '两端各一个终点门', sc.gates);
  ok(sc.gateX.length === 2 && sc.gateX[0] === -46 && sc.gateX[1] === 46, '门在 x=±46', sc.gateX);
  ok(glbOk && sc.gateGlb.every(Boolean), 'flag_gate.glb 已叠到门上（复用赛道现成旗门）', sc.gateGlb);
  ok(sc.cargo.held === false && Math.abs(sc.cargo.x) < 0.1 && Math.abs(sc.cargo.z - 15) < 0.5,
    '包子在石台上待抢（z=15，避开中央塔柱）', sc.cargo);
  ok(sc.bun.vis === true && sc.bun.y > 2.5 && sc.bun.y < 3.6, '包子悬在台面上方', sc.bun);
  ok(sc.bun.geo > 800 && sc.bun.mat === 'MeshPhysicalMaterial', '包子是形变球面 + PBR（不是素球）', sc.bun);
  ok(sc.bun.hasMap === true, '包子有 canvas 面皮贴图', sc.bun.hasMap);
  ok(sc.beacon === true, '货在中央时光柱亮着', sc.beacon);
  ok(sc.entries.every((l) => l === 1), '全部人在第 2 层', sc.entries);

  console.log('\n[3] 抢货 → 背货减速');
  const grab = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,d=b.deliver,me=g.localBoat;
    me.pos.set(d.cargo.x,18.4,d.cargo.z-2.5); me.vel.set(0,0);
    await new Promise(r=>setTimeout(r,220));
    const carried = d.carrierId===b.myId;
    await new Promise(r=>setTimeout(r,200));
    return JSON.stringify({carried, speedMul:+me.speedMul.toFixed(3), beacon:d.beacon.visible,
      cargoAt:{x:+d.cargo.x.toFixed(1),z:+d.cargo.z.toFixed(1)},
      score:d.scores.get(b.myId)||0});
  })()`)));
  console.log('  ' + JSON.stringify(grab));
  ok(grab.carried === true, '碰到包子就背上（carrierId = 我）', grab);
  ok(Math.abs(grab.speedMul - 0.72) < 0.02, '背货极速 ×0.72', grab.speedMul);
  ok(grab.beacon === false, '货被背走后光柱熄灭', grab.beacon);

  console.log('\n[4] 背货不能放泡泡 / K 键放泡泡');
  const fire = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,d=b.deliver,me=g.localBoat;
    const asCarrier = d.fire(b.myId, me, 0);
    // 掉货后再放（模拟"追的人"）
    d.applyNet({t:'deliverDrop', id:b.myId});
    await new Promise(r=>setTimeout(r,60));
    d.cooldown.clear();
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyK',key:'k'}));
    await new Promise(r=>setTimeout(r,120));
    const bub = d.bubbles[d.bubbles.length-1];
    // AI 在我背货那 400ms 里也会放泡泡，所以只数"我名下的"
    const mine = d.bubbles.filter(x=>x.owner===b.myId).length;
    const info = bub ? {n:d.bubbles.length, mine, ai:d.bubbles.length-mine,
      isShader:bub.mat.type==='ShaderMaterial', owner:bub.owner,
      x:+bub.x.toFixed(1), z:+bub.z.toFixed(1), scale:+bub.mesh.scale.x.toFixed(2)} : null;
    // 延长引信，方便截图
    if (bub) bub.t = -6;
    return JSON.stringify({asCarrier, bubbles:info, carrierNow:d.carrierId});
  })()`)));
  console.log('  ' + JSON.stringify(fire));
  ok(fire.asCarrier === false, '背着包子的人不能放泡泡', fire.asCarrier);
  ok(fire.bubbles && fire.bubbles.mine === 1, 'K 键放出一颗泡泡（我名下 1 颗）', fire.bubbles);
  ok(fire.bubbles?.isShader === true, '泡泡用的是肥皂泡着色器（巨鲸鲨同款）', fire.bubbles?.isShader);
  ok(fire.bubbles?.owner != null, '泡泡记了归属', fire.bubbles?.owner);
  ok(fire.bubbles?.z > 4, '泡泡出现在船头前方（不是原地）', fire.bubbles);

  console.log('\n[5] 截图：全景 / 终点门 / 包子 / 泡泡');
  await shot(`const c=g.camera; c.position.set(0,46,118); c.lookAt(0,20,6); c.updateMatrixWorld();`,
    'sky-tower-deliver-overview.jpg');
  await shot(`const c=g.camera; c.position.set(26,27,26); c.lookAt(46,20,0); c.updateMatrixWorld();`,
    'sky-tower-deliver-gate.jpg');
  await shot(`const c=g.camera; c.position.set(5.5,23.6,24); c.lookAt(0,21.3,15); c.updateMatrixWorld();`,
    'sky-tower-deliver-bun.jpg');
  await evaluate(`(()=>{const d=window.__game.bossMode.deliver,me=window.__game.localBoat;
    const b=d.bubbles[d.bubbles.length-1]; if(b){ b.x=10; b.z=6; b.vx=0; b.vz=0; b.t=-6; }
    me.pos.set(10,18.4,14); me.heading=Math.PI; return 1;})()`);
  await sleep(300);
  await shot(`const c=g.camera; c.position.set(13,22.6,17); c.lookAt(10,20.8,6); c.updateMatrixWorld();`,
    'sky-tower-deliver-bubble.jpg');

  console.log('\n[6] 3 秒引信 → 爆炸 / 炸中持货者掉货 + 僵直');
  // 量法和第一层单测一样：只在"真正发生的那一帧"断言，别拿几秒后的状态当结论
  const pop = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,d=b.deliver;
    // 清掉截图用的旧泡泡
    d.bubbles.slice().forEach(x=>{x.dead=true;d.group.remove(x.mesh);d.group.remove(x.warn);});
    d.bubbles.length=0;
    const me=g.localBoat, meId=b.myId;
    // 先让自己背上包子（石台不在原点，位置从 d.cargo 读）
    d.carrierId=null; d.cargo.held=false; d.respawnIn=0; d.cargo.x=0; d.cargo.z=15;
    me.pos.set(0,18.4,15); me.vel.set(0,0);
    await new Promise(r=>setTimeout(r,240));
    const carrierWas = d.carrierId;
    // 换 AI 来当追的一方：在 10m 外朝我放一颗
    const foeId = b.ids.find(i=>i!==meId);
    const foe = b.boats.get(foeId);
    foe.pos.set(0,18.4,5); foe.heading=0; foe.vel.set(0,0);
    d.cooldown.clear();
    d.fire(foeId, foe, b.ids.indexOf(foeId));
    const bub = d.bubbles[d.bubbles.length-1];
    if(!bub) return JSON.stringify({err:'no bubble'});
    // 钉在持货者身上，让引信到点必然命中
    bub.vx=0; bub.vz=0; bub.x=me.pos.x; bub.z=me.pos.z;
    const t0=performance.now();
    let poppedAt=null;
    for(let i=0;i<300;i++){
      await new Promise(r=>requestAnimationFrame(r));
      if(bub.dead){ poppedAt=(performance.now()-t0)/1000; break; }
    }
    return JSON.stringify({carrierWas, isMe: carrierWas===meId, poppedAt: poppedAt==null?null:+poppedAt.toFixed(2),
      stun:+(me.stunTimer||0).toFixed(2), carrierNow:d.carrierId,
      cargoHeld:d.cargo.held, scoreCollected:null, bubbles:d.bubbles.length});
  })()`)));
  console.log('  ' + JSON.stringify(pop));
  ok(pop.isMe === true, '炸之前我确实背着包子', pop);
  ok(pop.poppedAt !== null && pop.poppedAt >= 2.6 && pop.poppedAt <= 4.2, '引信 3 秒后爆炸', pop.poppedAt);
  ok(pop.stun > 0.3, '被炸中进入僵直（stunTimer > 0）', pop.stun);
  ok(pop.carrierNow === null && pop.cargoHeld === false, '被炸中掉货', pop);

  console.log('\n[7] 送达终点门 → +2 分 · 货回中央');
  const deliver = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,d=b.deliver,me=g.localBoat;
    const p=b.players.get(b.myId);
    const before=p.score;
    me.stunTimer=0;
    d.carrierId=null; d.cargo.held=false; d.respawnIn=0; d.cargo.x=0; d.cargo.z=15;
    me.pos.set(0,18.4,15); me.vel.set(0,0);
    await new Promise(r=>setTimeout(r,220));
    const carried=d.carrierId===b.myId;
    const gx=(b.ids.indexOf(b.myId)%2===0?-1:1)*46;
    me.pos.set(gx*0.94,18.4,0); me.vel.set(0,0);
    await new Promise(r=>setTimeout(r,400));
    const mid={score:p.score, deliverScore:d.scores.get(b.myId)||0, carrier:d.carrierId, gap:+(p.score-before).toFixed(1)};
    await new Promise(r=>setTimeout(r,1700));
    return JSON.stringify({carried, myGate:gx, ...mid, back:{x:+d.cargo.x.toFixed(1), z:+d.cargo.z.toFixed(1), held:d.cargo.held}});
  })()`)));
  console.log('  ' + JSON.stringify(deliver));
  ok(deliver.carried === true, '走到中央重新背上包子', deliver);
  ok(deliver.gap === 2, '送达得 +2 分', deliver);
  ok(deliver.carrier === null, '送达后货脱手', deliver.carrier);
  ok(Math.abs(deliver.back?.x ?? 99) < 0.5 && deliver.back?.held === false, '1.6 秒后货回中央石台', deliver.back);

  console.log('\n[8] 整页截图（含 HUD 的第 2 层面板）');
  await evaluate(`(()=>{const me=window.__game.localBoat; me.pos.set(6,18.4,2); me.heading=0.35; me.vel.set(0,0); me.speed=0; return 1;})()`);
  await sleep(600);
  const pageShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.writeFile(path.join(shots, 'sky-tower-deliver-hud.jpg'), Buffer.from(pageShot.data, 'base64'));
  ok(true, '截图 sky-tower-deliver-hud.jpg（含 HUD）');

  console.log('\n[8b] 中央塔柱挡船（第 2 层地板起的那根水晶柱）');
  const block = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,me=g.localBoat;
    me.stunTimer=0;
    me.pos.set(0,18.4,-14); me.heading=0; me.vel.set(0,26);
    await new Promise(r=>setTimeout(r,650));
    return JSON.stringify({z:+me.pos.z.toFixed(1), vz:+me.vel.y.toFixed(1)});
  })()`)));
  console.log('  ' + JSON.stringify(block));
  ok(block.z < 0, '撞到塔柱就停下（没穿过去）', block);

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
