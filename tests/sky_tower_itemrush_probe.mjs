// 云端天梯第 3 层「道具箱大乱斗」实机验收：
//   箱子复用道具赛 / 吃箱 +1 / 命中 +1 / 1-2-3 放道具 / 60 秒结束 /
//   10 层重叠不能隔空吃箱 / 场边装饰全是现成 GLB（零新增程序化几何体）
//   WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_itemrush_probe.mjs
// 截图：shots/verify/sky-tower-itemrush-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/itemrush-${stamp}`);
const port = 9970 + (Number(stamp.slice(-2)) % 8);
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
    ok(false, '截图 ' + file, String(dataUrl).slice(0, 140)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, '截图 ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

/** 把所有人拽到第 3 层（正常流程是走升降光柱） */
const GOTO_L3 = `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=2;const bt=b.boats.get(id);if(!bt)continue;
    bt.skyLayer=2;bt.pos.y=36.4;bt.diveTargetY=36.4;bt.vel.set(0,0);bt.heading=0;}
  const me=window.__game.localBoat; me.pos.set(0,36.4,-16); me.vel.set(0,0); return 1;})()`;

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
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(400);
  await evaluate(GOTO_L3);
  await sleep(900);

  console.log('\n[2] 第 3 层场景：箱子 / 装饰 / 高度');
  // GLB 是异步加载的，等齐 20 件
  let glbCount = 0;
  try {
    await waitFor(`window.__game.bossMode.itemRush.group.children.filter(c=>c.userData.glb).length>=20`, 20000);
  } catch { /* 下面用实际数兜底 */ }

  const sc = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,r=b.itemRush;
    const grp=r.group;
    const glb = grp.children.filter(c=>c.userData.glb);
    // 我们"亲手造"的物体只允许是 0：所有子节点都必须来自 GLB（或 GLB 自己的后代）
    const own = [];
    grp.children.forEach(c=>{ if(!c.userData.glb) own.push(c.type+':'+(c.name||'?')); });
    const f = r.items.boxField;
    return JSON.stringify({
      mode:g.mode, layer:r.layer, deckY:+r.deckY.toFixed(2),
      boxes:r.items.boxes.length,
      rings:[...new Set(r.items.boxes.map(x=>+Math.hypot(x.x,x.z).toFixed(0)))].sort((a,b)=>a-b),
      boxY:+r.items.boxes[0].y.toFixed(2),
      pool:r.items.itemPool.length,
      hasGate:r.items.itemPool.includes('gate'),
      respawn:r.items.boxRespawn,
      duration:r.timeLeft,
      glb:glb.length, arches:glb.filter(c=>c.userData.glb==='shortcut_arch').length,
      poles:glb.filter(c=>c.userData.glb==='street_light_pole').length,
      own,
      field:{ hasMap:!!f?.panels?.material?.map, mapName:f?.panels?.material?.map?.name||'',
              emissive:!!f?.panels?.material?.emissiveMap, count:f?.count||0 },
      entries:b.ids.map(id=>b.players.get(id).layer),
    });})()`)));
  console.log('  ' + JSON.stringify(sc));
  ok(sc.mode === 'skytower', '模式 skytower', sc.mode);
  ok(sc.layer === 2, '层绑定 layer=2（第 3 层）', sc.layer);
  ok(Math.abs(sc.deckY - 36.3) < 0.01, '甲板 y = layerY(2)+0.30 = 36.3', sc.deckY);
  ok(sc.boxes === 56, '同心 4 圈共 56 个箱子', sc.boxes);
  ok(sc.rings.length === 4 && sc.rings[0] === 14 && sc.rings[3] === 53, '四圈半径 14/27/40/53', sc.rings);
  ok(Math.abs(sc.boxY - 36.3) < 0.5, '箱子摆在第 3 层甲板上（不是海面）', sc.boxY);
  ok(sc.pool === 18 && sc.hasGate === false, '道具池 18 种 · 剔除依赖赛道的 gate', { pool: sc.pool });
  ok(sc.respawn === 4, '补箱 4 秒', sc.respawn);
  ok(Math.abs(sc.duration - 60) < 1.2, '限时 60 秒', sc.duration);
  ok(sc.own.length === 0, '场边没有一个自己造的程序化几何体（全部来自 GLB）', sc.own);
  ok(sc.glb === 20 && sc.poles === 12 && sc.arches === 8,
    '12 根路灯杆 + 8 座近道拱门（全用现成 GLB，没有 portal 那个粉色呼啦圈）',
    { glb: sc.glb, poles: sc.poles, arches: sc.arches });
  ok(sc.field.hasMap === true && sc.field.emissive === true,
    '箱子是道具赛那个带贴图的霓虹箱（map + emissiveMap）', sc.field);
  ok(sc.field.count === 56, '箱子外观实例数与数据一致', sc.field.count);
  ok(sc.entries.every((l) => l === 2), '全部人在第 3 层', sc.entries);

  console.log('\n[3] 10 层重叠：高度过滤（不能隔空吃箱）');
  const gate = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,r=b.itemRush,me=g.localBoat;
    const p=b.players.get(b.myId);
    // 找一个箱子，把船摆到它正下方 18m（第 2 层），平面距离 0
    const box=r.items.boxes[10];
    const before=box.active;
    const bx0=r.bx.get(b.myId)||0;
    p.layer=1; me.skyLayer=1; me.pos.set(box.x,18.4,box.z); me.diveTargetY=18.4; me.vel.set(0,0);
    await new Promise(res=>setTimeout(res,260));
    const afterLower=box.active;
    const gainedLower=(r.bx.get(b.myId)||0)-bx0;
    // 回到第 3 层、同一个位置：应该被吃到
    p.layer=2; me.skyLayer=2; me.pos.set(box.x,36.4,box.z); me.diveTargetY=36.4;
    await new Promise(res=>setTimeout(res,260));
    const gainedUpper=(r.bx.get(b.myId)||0)-bx0;
    return JSON.stringify({before, afterLower, gainedLower, gainedUpper, activeNow:box.active});
  })()`)));
  console.log('  ' + JSON.stringify(gate));
  ok(gate.before === true, '箱子初始是活的', gate);
  ok(gate.gainedLower === 0 && gate.afterLower === true, '在下一层同坐标吃不到（高度过滤生效）', gate);
  ok(gate.gainedUpper === 1 && gate.activeNow === false, '站到第 3 层同坐标才吃得到', gate);

  console.log('\n[4] 吃箱 → A 分 +1 / 道具栏 +1 / 箱子补回');
  const pick = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,r=b.itemRush,me=g.localBoat;
    const p=b.players.get(b.myId);
    r.items.myItems=[null,null,null];
    const s0=p.score, bx0=r.bx.get(b.myId)||0;
    // 挑一个还没吃过的箱子
    const box=r.items.boxes.find(x=>x.active);
    const idx=box.idx;
    me.pos.set(box.x,36.4,box.z); me.vel.set(0,0);
    await new Promise(res=>setTimeout(res,240));
    const held=r.items.myItems.filter(Boolean);
    const dScore=p.score-s0, dBx=(r.bx.get(b.myId)||0)-bx0;
    // 必须马上开走：不挪开的话 4 秒后补出的新箱会原地被再吃一次
    me.pos.set(0,36.4,-16);
    await new Promise(res=>setTimeout(res,4200));
    return JSON.stringify({dScore, dBx, heldCount:held.length, heldId:held[0]||null,
      boxBack:r.items.boxes[idx].active});
  })()`)));
  console.log('  ' + JSON.stringify(pick));
  ok(pick.dScore === 1, '吃到一个箱子 A 分 +1', pick.dScore);
  ok(pick.dBx === 1, '本层箱子计数 +1', pick.dBx);
  ok(pick.heldCount === 1, '道具栏进账 1 格（走道具赛那套）', pick.heldCount);
  ok(pick.boxBack === true, '4 秒后同一个位置补回箱子', pick.boxBack);

  console.log('\n[5] 打中对手 → B 分 +1（ItemManager.onHit 钩子）');
  const hit = JSON.parse(val(await evaluate(`(()=>{
    const b=window.__game.bossMode,r=b.itemRush,p=b.players.get(b.myId);
    const s0=p.score, h0=r.hit.get(b.myId)||0;
    r.items.onHit(b.myId);
    return JSON.stringify({dScore:p.score-s0, dHit:(r.hit.get(b.myId)||0)-h0,
      rankAfter:r.rank(b.myId)});
  })()`)));
  console.log('  ' + JSON.stringify(hit));
  ok(hit.dScore === 1 && hit.dHit === 1, '命中一次 +1 分 +1 命中数', hit);
  ok(hit.rankAfter >= 1, '名次接口可用（道具赛的"打前一名"要用它）', hit.rankAfter);

  console.log('\n[6] 1/2/3 放道具（天梯里 W 是油门，所以主键盘数字）');
  const use = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,r=b.itemRush,me=g.localBoat;
    r.items.myItems=['shield',null,null];
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1'}));
    await new Promise(res=>setTimeout(res,240));
    const shield=+(me.shieldTimer||0).toFixed(2);
    const after=r.items.myItems.slice();
    // 方向转换器（tide）：只要求"场上有别人"，最能证明"对手默认当敌方"
    const foeId=b.ids.find(i=>i!==b.myId);
    const foe=b.boats.get(foeId);
    const fp=b.players.get(foeId);
    // AI 可能已经开出玻璃边缘掉下去了，测之前先把它按回甲板
    fp.layer=2; fp.alive=true; fp.fallWater=null;
    foe.skyLayer=2; foe.skyFall=false; foe.pos.set(6,36.4,6); foe.diveTargetY=36.4; foe.vel.set(0,0);
    foe.reverseControlTimer=0;
    const h0=r.hit.get(b.myId)||0;
    r.items.myItems=[null,'tide',null];
    // 关键：上面刚把 AI 拽回甲板，必须让主循环跑一帧，r.boats 才会重建出 2 条船。
    // 不等这一帧直接放，ItemManager 眼里场上只有我一个，方向转换器会"落空"。
    await new Promise(res=>setTimeout(res,200));
    const keysBefore=[...r.boats.keys()];
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit2',key:'2'}));
    await new Promise(res=>setTimeout(res,240));
    return JSON.stringify({shield, after, left:r.items.myItems.filter(Boolean).length,
      boats:r.boats.size, reverse:+(foe.reverseControlTimer||0).toFixed(2), dHit:(r.hit.get(b.myId)||0)-h0,
      dbg:{ keysBefore, foeShield:+(foe.shieldTimer||0).toFixed(2), mate:r.sameTeam(b.myId, foeId) }});
  })()`)));
  console.log('  ' + JSON.stringify(use));
  ok(use.shield > 0, '按 1 放出护盾（策略生效）', use);
  ok(use.after[0] === null, '用掉的格子清空', use.after);
  ok(use.boats === 2, '本层判定表里有 2 条船（我 + AI）', use.boats);
  ok(use.reverse > 0, '按 2 放出方向转换器 → 对手操控被反转（默认敌方）', use.reverse);
  ok(use.dHit === 1, '打中对手同时记 B 分（命中 +1）', use.dHit);

  console.log('\n[7] 截图：全景 / 箱子近景 / 路灯 / 传送门');
  await evaluate(`(()=>{const r=window.__game.bossMode.itemRush;
    for(let i=0;i<10;i++){r.bx.set('x'+i,1);} return 1;})()`);
  await shot(`const c=g.camera; c.position.set(0,74,120); c.lookAt(0,40,0); c.updateMatrixWorld();`,
    'sky-tower-itemrush-overview.jpg');
  await shot(`const c=g.camera; c.position.set(20,41.5,40); c.lookAt(14,38.6,14); c.updateMatrixWorld();`,
    'sky-tower-itemrush-boxes.jpg');
  await shot(`const c=g.camera; c.position.set(24,44,44); c.lookAt(0,40,0); c.updateMatrixWorld();`,
    'sky-tower-itemrush-decor.jpg');
  await evaluate(`(()=>{const me=window.__game.localBoat; me.pos.set(6,36.4,10); me.heading=0.4; me.vel.set(0,0); me.speed=0;
    const r=window.__game.bossMode.itemRush; r.timeLeft=47; r.items.myItems=['missile','shield','nitro']; return 1;})()`);
  await sleep(700);
  await shot(`const c=g.camera; c.position.set(9,40.4,17); c.lookAt(6,37.6,10); c.updateMatrixWorld();`,
    'sky-tower-itemrush-slot.jpg');

  console.log('\n[8] 整页截图（含 HUD：箱子数 / 三条道具槽 / 1-2-3 键位）');
  await sleep(500);
  const pageShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.writeFile(path.join(shots, 'sky-tower-itemrush-hud.jpg'), Buffer.from(pageShot.data, 'base64'));
  ok(true, '截图 sky-tower-itemrush-hud.jpg（含 HUD）');
  const hud = JSON.parse(val(await evaluate(`(()=>{const el=document.getElementById('item-slots');
    const keys=[...el.querySelectorAll('.item-slot .item-key')].map(k=>k.textContent);
    const th=document.getElementById('th-cargo'); const cap=document.querySelector('.th-cell-cargo .th-cap');
    const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
    return JSON.stringify({slotsHidden:el.classList.contains('hidden'), keys, boxCell:th?.textContent,
      cap:cap?.textContent, phase:document.getElementById('th-phase-txt')?.textContent,
      hudClass:document.getElementById('hud').className,
      display:cs.display, bottom:cs.bottom, opacity:cs.opacity,
      box:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]});})()`)));
  console.log('  ' + JSON.stringify(hud));
  ok(hud.slotsHidden === false, '第 3 层显示道具槽', hud.slotsHidden);
  ok(/tower-rush/.test(hud.hudClass), 'HUD 挂上 tower-rush 类', hud.hudClass);
  ok(hud.display === 'flex' && hud.box[3] > 60, '道具槽真的画出来了（display:flex + 有高度）', { d: hud.display, box: hud.box });
  ok(hud.keys.join('') === '123', '道具槽键位是 1/2/3（不是 Q/W/E）', hud.keys);
  ok(/BOX/.test(hud.cap || ''), 'HUD 换成"本层箱子"口径', hud.cap);
  ok(/道具箱/.test(hud.phase || ''), '阶段条显示本层玩法与倒计时', hud.phase);

  console.log('\n[9] 60 秒到点结算');
  const fin = JSON.parse(val(await evaluate(`(async()=>{
    const b=window.__game.bossMode,r=b.itemRush;
    r.timeLeft=0.25;
    await new Promise(res=>setTimeout(res,700));
    return JSON.stringify({running:r.running, left:+r.timeLeft.toFixed(2),
      active:r.items.boxes.filter(x=>x.active).length,
      held:r.items.myItems.filter(Boolean).length});
  })()`)));
  console.log('  ' + JSON.stringify(fin));
  ok(fin.running === false && fin.left === 0, '时间到就停表', fin);
  ok(fin.active === 0, '结束后箱子全部收起', fin.active);
  ok(fin.held === 0, '结束后道具栏清空', fin.held);

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
