// 云端天梯第 5 层（随机落雷 · 躲雷 + 互推）实机验收
//   node tests/sky_tower_thunder_probe.mjs
// 截图：shots/verify/sky-tower-thunder-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/tower-thunder-${stamp}`);
const port = 9970 + (Number(stamp.slice(-2)) % 20);
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

// 把所有人搬到第 5 层（layer=4，甲板 y=72.3）
const GOTO_L5 = `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=4;const bt=b.boats.get(id);if(!bt)continue;
    p.alive=true;p.fallWater=null;bt.skyFall=false;bt.liftRide=null;bt.skyLayer=4;
    bt.diveTargetY=72.4;bt.vel.set(0,0);bt.vy=0;}
  const me=window.__game.localBoat; me.pos.set(-22,72.4,0); me.heading=Math.PI/2;
  const foe=[...b.boats.values()].find(x=>x!==me); if(foe){foe.pos.set(22,72.4,0);}
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
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @ '+e.filename+':'+e.lineno));
      // 无头验收专用：塞一个本地 token 过账号门，并拦掉 main.js 校验失败时的 removeItem，
      // 否则每次新建 profile 都会被登录面板挡住进不去大厅。
      try{
        const rm = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(k){ if(k==='rr-account-token') return; return rm.call(this,k); };
        localStorage.setItem('rr-account-token','probe-token');
      }catch(e){}`,
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  console.log('\n[1] 进入天梯 · 单人 + 1 AI');
  await cdp('Page.navigate', { url }); await sleep(3000);
  try { await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 12000); }
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
  await evaluate(GOTO_L5);

  console.log('\n[2] 层绑定 / 场地');
  await sleep(500);
  // 场边 GLB 是异步加载的，给它几秒（玩家实际跑上来时早就加载完了）
  try { await waitFor(`window.__game.bossMode.thunder.group.children.filter(c=>c.userData.glb).length >= 13`, 9000); } catch {}
  const rawSc = val(await evaluate(`(()=>{try{const g=window.__game,b=g.bossMode,r=b.thunder;
    if(!r) return 'ERR:no thunder';
    return JSON.stringify({mode:g.mode, layer:r.layer, deckY:+r.deckY.toFixed(2),
      running:r.running, timeLeft:+r.timeLeft.toFixed(1), wave:r.wave,
      decor:r.group.children.filter(c=>c.userData.glb).length,
      own:r.group.children.filter(c=>!c.userData.glb&&c.name!=='thunder-warning').length,
      layers:[...b.players.values()].map(p=>p.layer)});}catch(e){return 'ERR:'+e.stack;}})()`));
  if (String(rawSc).slice(0, 1) !== '{') {
    console.log('  raw: ' + String(rawSc).slice(0, 600));
    console.log('  page errs: ' + val(await evaluate(`JSON.stringify(window.__errs||[])`)));
    throw new Error('第 5 层初始化失败');
  }
  const sc = JSON.parse(rawSc);
  console.log('  ' + JSON.stringify(sc));
  ok(sc.mode === 'skytower', '模式 skytower', sc.mode);
  ok(sc.layer === 4 && sc.deckY === 72.3, '绑定第 5 层 · 甲板 y=72.3', { l: sc.layer, y: sc.deckY });
  ok(sc.layers.every((l) => l === 4), '两条船都在第 5 层', sc.layers);
  ok(sc.decor === 13, '场边 8 灯柱 + 5 拱门都是现成 GLB', sc.decor);

  console.log('\n[3] 每波 2 个随机落雷 + 红圈预警');
  await waitFor(`window.__game.bossMode.thunder.bolts.length > 0`, 15000);
  const wave1 = JSON.parse(val(await evaluate(`(()=>{const r=window.__game.bossMode.thunder;
    const pts=r.bolts.map(b=>({x:b.x,z:b.z,r:+Math.hypot(b.x,b.z).toFixed(2),warn:!!b.group}));
    return JSON.stringify({n:r.bolts.length, pts, wave:r.wave});})()`)));
  console.log('  ' + JSON.stringify(wave1));
  ok(wave1.n === 2, '一波同时 2 个落雷', wave1.n);
  ok(wave1.pts.every((p) => p.r >= 10.99 && p.r <= 42.51), '落点避开中央塔身与平台边缘', wave1.pts.map((p) => p.r));
  ok(wave1.pts.every((p) => p.warn), '每个落点都带红色预警圈', wave1);
  await shot('', 'sky-tower-thunder-warn.jpg');

  console.log('\n[4] 站进红圈 → 被劈中（计数 + 击退 + 失控）');
  // 等到一道"还来得及跑过去"的预警（>0.6s），否则截图耗时会把它耗到落地
  try { await waitFor(`window.__game.bossMode.thunder.bolts.some(x=>!x.done && x.t>0.6)`, 8000); } catch {}
  const hit = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.thunder;
    const me=g.localBoat;
    // 等当前这波还在预警里，再把船挪到第一道雷正中
    const b0=r.bolts.find(x=>!x.done); if(!b0) return JSON.stringify({err:'no bolt'});
    const n0=r.struckOf(b.myId);
    const t0=r.bolts.map(x=>({t:+x.t.toFixed(2),done:x.done,x:+x.x.toFixed(1),z:+x.z.toFixed(1)}));
    const p=performance.now();
    let placed=0;
    while(performance.now()-p<3200 && r.struckOf(b.myId)===n0){
      me.pos.x=b0.x; me.pos.z=b0.z; me.vel.set(0,0); placed++;
      await new Promise(res=>setTimeout(res,50));
    }
    const n1=r.struckOf(b.myId);
    return JSON.stringify({n0,n1,stun:+(me.stunTimer||0).toFixed(2),slow:+(me.slowTimer||0).toFixed(2),
      speed:+Math.hypot(me.vel.x,me.vel.y).toFixed(1), placed,
      mePos:[+me.pos.x.toFixed(1),+me.pos.z.toFixed(1)], bolt0:[+b0.x.toFixed(1),+b0.z.toFixed(1)],
      layer:b.players.get(b.myId)?.layer, alive:b.players.get(b.myId)?.alive,
      entries:b.ids.map(id=>[id,b.players.get(id)?.layer]),
      t0, now:r.bolts.map(x=>({t:+x.t.toFixed(2),done:x.done}))});})()`)));
  console.log('  ' + JSON.stringify(hit));
  ok(hit.n1 === hit.n0 + 1, '站在圈里被打中一次（计数 +1）', hit);
  ok(hit.stun > 0 || hit.slow > 0, '被劈后进入失控/减速', hit);
  await shot('', 'sky-tower-thunder-strike.jpg');

  console.log('\n[5] 躲开红圈 → 不被劈 + 每波 +1 分');
  const dodge = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.thunder;
    const me=g.localBoat,p=b.players.get(b.myId);
    const n0=r.struckOf(b.myId), s0=p.score;
    // 站到场地最外侧、远离所有落雷的一个点，等两波过去
    const t0=performance.now();
    while(performance.now()-t0<9000){
      let best=null,bd=-1;
      for(const ang of [0,1,2,3,4,5]){
        const x=Math.cos(ang)*40,z=Math.sin(ang)*40;
        let d=Infinity; for(const bo of r.bolts) d=Math.min(d,Math.hypot(x-bo.x,z-bo.z));
        if(d>bd){bd=d;best=[x,z];}
      }
      me.pos.set(best[0],72.4,best[1]); me.vel.set(0,0);
      await new Promise(res=>setTimeout(res,80));
    }
    return JSON.stringify({struckGain:r.struckOf(b.myId)-n0, scoreGain:p.score-s0, waves:r.wave});})()`)));
  console.log('  ' + JSON.stringify(dodge));
  ok(dodge.struckGain === 0, '始终站在圈外不会被劈', dodge);
  ok(dodge.scoreGain > 0, '每躲过一波拿到 +1 分', dodge);

  console.log('\n[6] HUD 第 5 层口径');
  const hud = JSON.parse(val(await evaluate(`(()=>{const g=window.__game;
    const d=g.bossMode.hudData();
    return JSON.stringify({thunder:d.towerThunder, mine:d.towerThunderMine,
      next:+d.towerThunderNext.toFixed(1), left:d.towerThunderLeft,
      cap:document.querySelector('#tower-hud .th-cell-cargo .th-cap')?.textContent,
      val:document.getElementById('th-cargo')?.textContent,
      phase:document.getElementById('th-phase-txt')?.textContent,
      hint:document.querySelector('#tower-hud .th-hint')?.textContent,
      cls:document.getElementById('tower-hud')?.classList.contains('thunder'),
      tail:document.querySelector('#th-boards .th-row')?.textContent});})()`)));
  console.log('  ' + JSON.stringify(hud));
  ok(hud.thunder === true && hud.cls === true, 'HUD 切到落雷口径', hud);
  ok(/STRUCK/.test(hud.cap || '') && String(hud.val) === String(hud.mine), '第三格 = 被劈次数', hud);
  ok(/落雷竞技/.test(hud.phase || '') && /下一波/.test(hud.phase || ''), '阶段条显示本层倒计时与下一波', hud.phase);
  ok(/红圈/.test(hud.hint || '') && /最少者胜/.test(hud.hint || ''), '底部提示写明躲雷 + 互推', hud.hint);
  ok(/劈/.test(hud.tail || ''), '榜单每人显示被劈次数', hud.tail);
  await cdpShot('sky-tower-thunder-hud-full.jpg');

  console.log('\n[7] 时间到 → 按被劈次数结算');
  const fin = JSON.parse(val(await evaluate(`(async()=>{const b=window.__game.bossMode,r=b.thunder;
    r.timeLeft=0.2;
    await new Promise(res=>setTimeout(res,600));
    return JSON.stringify({running:r.running, left:+r.timeLeft.toFixed(2), winner:r.winner,
      order:r.order.map(o=>({id:o.id,n:o.n,dnf:!!o.dnf})), struck:[...r.struck.entries()]});})()`)));
  console.log('  ' + JSON.stringify(fin));
  ok(fin.running === false && fin.left === 0, '时间到停表', fin);
  ok(fin.order.length === 2, '两人都进结算', fin.order);
  // AI 可能自己冲出平台 → dnf 垫底；存活者里按被劈次数升序
  const live = fin.order.filter((o) => !o.dnf);
  if (live.length) {
    const minN = Math.min(...live.map((o) => o.n));
    ok(live[0].n === minN, '存活者里被劈最少的排第一', fin.order);
    ok(fin.winner === live[0].id, '被劈最少者获胜', fin.winner);
  } else {
    ok(true, '全员掉层（本层无胜者）');
  }
  const firstDnf = fin.order.findIndex((o) => o.dnf);
  ok(firstDnf < 0 || fin.order.slice(firstDnf).every((o) => o.dnf), '掉出平台的人排在最后', fin.order);

  console.log('\n[8] 控制台错误检查');
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
