// 云端天梯第 6 层（塔防 · 杀怪竞速）实机验收
//   node tests/sky_tower_defense_probe.mjs
// 截图：shots/verify/sky-tower-defense-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/tower-defense-${stamp}`);
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

const GOTO_L6 = `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=5;const bt=b.boats.get(id);if(!bt)continue;
    p.alive=true;p.fallWater=null;bt.skyFall=false;bt.liftRide=null;bt.skyLayer=5;
    bt.diveTargetY=90.4;bt.vel.set(0,0);bt.vy=0;}
  const me=window.__game.localBoat; me.pos.set(-18,90.4,0); me.heading=Math.PI/2;
  const foe=[...b.boats.values()].find(x=>x!==me); if(foe){foe.pos.set(18,90.4,0);}
  // 层号/坠落轨迹采样：第 6 层必须全程留在本层（[5.5] 用这份数据做断言）
  window.__falls=[]; window.__trace=[];
  if(!window.__fallPatched){ window.__fallPatched=1; const orig=b.arena.opts.onFall;
    b.arena.opts.onFall=(boat,layer)=>{window.__falls.push({layer,x:+boat.pos.x.toFixed(1),
      z:+boat.pos.z.toFixed(1),y:+boat.pos.y.toFixed(1),sky:boat.skyLayer,
      d:+Math.hypot(boat.pos.x,boat.pos.z).toFixed(1),me:boat===window.__game.localBoat});
      orig(boat,layer);};}
  clearInterval(window.__tr);
  window.__tr=setInterval(()=>{const p=b.players.get(b.myId),bt=window.__game.localBoat;
    window.__trace.push({t:+(performance.now()/1000).toFixed(1),pl:p&&p.layer,sky:bt.skyLayer,
      y:+bt.pos.y.toFixed(1),d:+Math.hypot(bt.pos.x,bt.pos.z).toFixed(1),
      lift:!!bt.liftRide,fall:!!bt.skyFall});},200);
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
  await evaluate(GOTO_L6);

  console.log('\n[2] 层绑定 / 场地 / 刷怪');
  await sleep(600);
  const raw = val(await evaluate(`(()=>{try{const g=window.__game,b=g.bossMode,r=b.defense;
    if(!r) return 'ERR:no defense';
    return JSON.stringify({mode:g.mode, layer:r.layer, deckY:+r.deckY.toFixed(2),
      layerY:+r.group.position.y.toFixed(2), running:r.running, timeLeft:+r.timeLeft.toFixed(1),
      decor:r.group.children.filter(c=>c.userData.glb).length,
      layers:[...b.players.values()].map(p=>p.layer)});}catch(e){return 'ERR:'+e.stack;}})()`));
  if (String(raw).slice(0, 1) !== '{') { console.log('  raw: ' + String(raw).slice(0, 500)); throw new Error('第 6 层初始化失败'); }
  const sc = JSON.parse(raw);
  console.log('  ' + JSON.stringify(sc));
  ok(sc.mode === 'skytower', '模式 skytower', sc.mode);
  ok(sc.layer === 5 && sc.deckY === 90.3, '绑定第 6 层 · 甲板 y=90.3', { l: sc.layer, y: sc.deckY });
  ok(sc.layers.every((l) => l === 5), '两条船都在第 6 层', sc.layers);

  await waitFor(`window.__game.bossMode.defense.minions.length > 0`, 20000);
  await sleep(1200);
  const wave = JSON.parse(val(await evaluate(`(()=>{const r=window.__game.bossMode.defense;
    const R=41;
    return JSON.stringify({wave:r.wave, n:r.minions.length,
      types:r.minions.map(m=>m.type), hp:r.minions.map(m=>m.hp),
      alive:r.minions.filter(m=>m.alive).length,
      r:r.minions.map(m=>+Math.hypot(m.pos.x,m.pos.z).toFixed(1)),
      models:r.minions.filter(m=>!!m.model).length,
      outR:r.minions.filter(m=>Math.hypot(m.pos.x,m.pos.z)>R+2).length});})()`)));
  console.log('  ' + JSON.stringify(wave));
  ok(wave.wave >= 1, '波次已开始', wave.wave);
  ok(wave.n >= 2, '第一波至少 2 只怪', wave.n);
  ok(wave.types.every((t) => ['beast', 'penguin', 'blood', 'whale_shark'].includes(t)), '怪物类型来自 BOSS_MINIONS', wave.types);
  ok(wave.outR === 0, '怪物都落在第 6 层平台内', wave.r);
  ok(wave.models >= 1, '小怪 GLB 模型已加载', { models: wave.models, n: wave.n });

  console.log('\n[3] 小怪追击玩家（复用怪物模式移动口径）');
  const chase = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.defense;
    const me=g.localBoat;
    const m=r.minions.find(x=>x.alive);
    const d0=Math.hypot(m.pos.x-me.pos.x, m.pos.z-me.pos.z);
    await new Promise(res=>setTimeout(res,1600));
    const d1=Math.hypot(m.pos.x-me.pos.x, m.pos.z-me.pos.z);
    return JSON.stringify({d0:+d0.toFixed(1), d1:+d1.toFixed(1), moving:m.alive});})()`)));
  console.log('  ' + JSON.stringify(chase));
  ok(chase.d1 < chase.d0, '小怪朝船靠近', chase);

  console.log('\n[4] J 键主炮 → 打死小怪 + 计分');
  const kill = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.defense;
    const me=g.localBoat,p=b.players.get(b.myId);
    const m=r.minions.find(x=>x.alive);
    if(!m) return JSON.stringify({err:'no minion'});
    const hp0=m.hp, k0=r.killsOf(b.myId), s0=p.score;
    // 把船摆到怪正西 12m，船头朝它，按住 J 连射
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyJ',key:'j'}));
    const t0=performance.now();
    while(performance.now()-t0<9000 && m.alive){
      const dx=m.pos.x-me.pos.x, dz=m.pos.z-me.pos.z;
      const d=Math.hypot(dx,dz);
      // 保持在 10~14m 外圈，别撞死它（撞死也算，但这里要看炮弹伤害）
      if(d>14||d<9){ me.pos.set(m.pos.x-12, 90.4, m.pos.z); }
      me.heading=Math.atan2(dx,dz);
      me.vel.set(0,0);
      await new Promise(res=>setTimeout(res,70));
    }
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyJ',key:'j'}));
    return JSON.stringify({hp0, hpNow:+m.hp.toFixed(0), alive:m.alive,
      killsGain:r.killsOf(b.myId)-k0, scoreGain:p.score-s0, type:m.type});})()`)));
  console.log('  ' + JSON.stringify(kill));
  ok(kill.alive === false, '按住 J 能打死小怪', kill);
  ok(kill.killsGain > 0, '击杀记进本层积分', kill);
  ok(kill.scoreGain > 0, '击杀分同步进天梯总分', kill);

  console.log('\n[5] 撞怪也能击杀（沿用船速×0.9）');  const ram = JSON.parse(val(await evaluate(`(async()=>{const g=window.__game,b=g.bossMode,r=b.defense;
    const me=g.localBoat;
    const m=r.minions.find(x=>x.alive);
    if(!m) return JSON.stringify({skip:true});
    m.hp=1;
    const k0=r.killsOf(b.myId);
    me.pos.set(m.pos.x-6, 90.4, m.pos.z); me.heading=Math.PI/2; me.vel.set(24,0);
    me.speed=24;
    const t0=performance.now();
    while(performance.now()-t0<1500 && m.alive){
      me.pos.set(m.pos.x-4.5, 90.4, m.pos.z); me.speed=24;
      await new Promise(res=>setTimeout(res,60));
    }
    return JSON.stringify({alive:m.alive, killsGain:r.killsOf(b.myId)-k0});})()`)));
  console.log('  ' + JSON.stringify(ram));
  if (!ram.skip) ok(ram.killsGain > 0, '高速撞怪算击杀', ram);

  console.log('\n[5.5] 层号稳定性 / 坠落记录');
  const diag = JSON.parse(val(await evaluate(`(()=>{
    const tr=window.__trace||[]; const chg=[];
    for(let i=0;i<tr.length;i++){ if(!i||tr[i].pl!==tr[i-1].pl||tr[i].sky!==tr[i-1].sky) chg.push(tr[i]); }
    return JSON.stringify({rows:tr.length, changes:chg.slice(0,12), falls:(window.__falls||[]).slice(0,6),
      nowLayer:window.__game.bossMode.players.get(window.__game.bossMode.myId)?.layer});})()`)));
  console.log('  ' + JSON.stringify(diag));
  ok(diag.changes.length === 1 && diag.nowLayer === 5, '第 6 层全程停留在本层（无坠落/无回写）', diag);

  console.log('\n[6] HUD 第 6 层口径');
  const hud = JSON.parse(val(await evaluate(`(()=>{const g=window.__game;
    const d=g.bossMode.hudData();
    return JSON.stringify({def:d.towerDefense, kills:d.towerDefenseKills,
      left:d.towerDefenseLeft, wave:d.towerDefenseWave,
      cap:document.querySelector('#tower-hud .th-cell-cargo .th-cap')?.textContent,
      val:document.getElementById('th-cargo')?.textContent,
      phase:document.getElementById('th-phase-txt')?.textContent,
      hint:document.querySelector('#tower-hud .th-hint')?.textContent,
      tail:document.querySelector('#th-boards .th-row')?.textContent});})()`)));
  console.log('  ' + JSON.stringify(hud));
  ok(hud.def === true, 'HUD 切到塔防口径', hud);
  ok(/KILLS/.test(hud.cap || '') && String(hud.val) === String(hud.kills), '第三格 = 击杀积分', hud);
  ok(/塔防/.test(hud.phase || ''), '阶段条显示塔防/波次/击杀', hud.phase);
  ok(/J 键/.test(hud.hint || ''), '底部提示写明 J 键开炮', hud.hint);
  await cdpShot('sky-tower-defense-hud.jpg');
  await shot('', 'sky-tower-defense-scene.jpg');

  console.log('\n[7] 时间到 → 按击杀分结算');
  const fin = JSON.parse(val(await evaluate(`(async()=>{const r=window.__game.bossMode.defense;
    r.timeLeft=0.2;
    await new Promise(res=>setTimeout(res,600));
    return JSON.stringify({running:r.running, left:+r.timeLeft.toFixed(2),
      order:r.order.map(o=>({id:o.id,n:o.n})), winner:r.winner,
      kills:[...r.kills.entries()]});})()`)));
  console.log('  ' + JSON.stringify(fin));
  ok(fin.running === false && fin.left === 0, '时间到停表', fin);
  ok(fin.order.length >= 1 && fin.order[0].n >= fin.order[fin.order.length - 1].n, '按击杀分降序排名', fin.order);

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
