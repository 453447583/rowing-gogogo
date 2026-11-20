// 道具赛「联机全道具体检」—— 主机 = 真浏览器，客人 = 裸 WS 客户端
//
//   node tests/item_net_audit.mjs
//
// 为什么要这么搭：
//   · 主机用真浏览器，才能验证 handleNet 收到消息后的**真实表现**（受击方视角）；
//   · 客人用裸 WS，才能精确控制「发什么消息、什么时候发」，不受帧率和操控影响；
//   · 服务端是同一个 server.js，RELAY_TYPES 白名单一起验。
//
// 覆盖的 bug 类型（就是用户报的那三类）：
//   A 静默失效：消息发了但对端没反应 → 逐条断言对端状态真的变了
//   B 追不上/绕圈：交给 tests/item_homing_probe.mjs + item_homing_e2e.mjs
//   C 双端不同源：落雷以前发绝对时间戳 strikeAt，两端时钟不同源 →
//                 客机要么立刻落雷、要么预警圈永远不消失。这里断言只发 delay。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/item-net');
const cdPort = 9345;
const HTTP_PORT = 3421;
const WS_PORT = 3422;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

const server = spawn(process.execPath, [path.resolve('server/server.js')], {
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
      if (r.status === 200) return;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('服务器没起来');
}

// ---------- 裸 WS 客人 ----------
class Client {
  constructor(name) {
    this.name = name;
    this.session = 'sess-' + Math.random().toString(36).slice(2, 9);
    this.msgs = [];
    this.cursors = {};
    this.id = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: this.session })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  clear() { this.msgs = []; this.cursors = {}; }
  async waitWhere(type, pred, timeout = 12000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) { this.cursors[type] = i + 1; return this.msgs[i]; }
      }
      if (Date.now() - start > timeout) {
        throw new Error(`${this.name} 等 ${type} 超时，最近: ${this.msgs.slice(-5).map((m) => m.t).join(',')}`);
      }
      await sleep(40);
    }
  }
  wait(type, timeout) { return this.waitWhere(type, () => true, timeout); }
  close() { try { this.ws.close(); } catch {} }
}

let child;
let ws;
const errors = [];

try {
  await waitServer();
  console.log('· 服务器已启动', HTTP_PORT, WS_PORT);

  child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=' + cdPort, '--user-data-dir=' + profile, '--window-size=1000,600',
    `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`], { stdio: 'ignore' });

  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdPort}/json`); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  if (!tabs) throw new Error('无头 Edge 没起来');

  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleepCd = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 45000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleepCd(300);
    }
    throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // ---------- 建局：裸 WS 当房主（方便精确下发 mode/map/settings），浏览器当客人 ----------
  // 反过来（浏览器当房主）时，`#mode-select` 的 onchange 不一定发得出去，
  // 而且服务端只认 phase==='lobby' 的 mode 消息 —— 直接由 WS 房主指定最稳。
  const guest = new Client('客人');
  const welcome = await guest.connect();
  guest.send({ t: 'pick', boatId: 'titan' });
  guest.send({ t: 'mode', modeId: 'item' });
  guest.send({ t: 'weather', weatherId: 'storm' });   // 顺带把暴风雨打开，落雷才好测
  guest.send({ t: 'settings', settings: { laps: 1, rounds: 1, aiCount: 0 } });
  await sleep(800);

  await sleepCd(1500);
  await ev('document.querySelector("#btn-join").click()');
  await sleepCd(400);
  await ev('(function(){const i=document.querySelector("#input-host"); i.value="127.0.0.1"; return 1})()');
  await ev('document.querySelector("#btn-join-go").click()');
  // 联机入口统一进大厅：赛艇在大厅的抽屉里选（旧的 .boat-card 选艇屏已废弃）
  await waitFor('!!document.querySelector("#lobby") && !document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor('!!document.querySelector(".lp-card[data-boat]")', 20000, 'lobby boat picker');
  await ev('document.querySelector(".lp-card[data-boat=\\"rower\\"]").click()');
  await sleepCd(500);
  await ev('document.querySelector("#btn-lobby-pick-close").click()');
  await ev('document.querySelector("#btn-lobby-ready").click()');

  const rosterReady = await guest.waitWhere('roster',
    (r) => r.players.filter((p) => !p.ai).length === 2 && r.players.every((p) => p.boatId),
    20000);
  const modeNow = rosterReady?.mode;
  ok(modeNow === 'item', '联机房间模式 = 道具模式', modeNow);
  await sleepCd(600);
  guest.send({ t: 'start' });
  try {
    await waitFor('!!(window.__game && window.__game.items)', 45000, 'item race boot');
  } catch (e) {
    const toast = await ev('document.querySelector("#game-toast")?.textContent || document.querySelector("#lobby-toast")?.textContent || ""');
    throw new Error(`${e.message}；toast=${JSON.stringify(toast)}；mode=${modeNow}`);
  }
  await waitFor('window.__game.phase === "racing"', 60000, 'racing');
  const myId = await ev('window.__game.myId');
  const peerId = guest.id;
  console.log(`· 开赛成功，本机 ${myId} / 对端 ${peerId}`);
  ok(!!myId && myId !== peerId, '两端 id 不同（真的联机，不是本地桩）', { myId, peerId });

  // 让本机处在最后一名：fish / rvortex 这类按名次选目标的道具才有确定性
  const beLast = `(function(){
    const g = window.__game;
    const me = g.progressMap.get(g.myId);
    const him = g.progressMap.get(${JSON.stringify(peerId)});
    if (me) me.prog = 10;
    if (him) him.prog = 400;
    return g.items.getRank(g.myId);
  })()`;

  // 客人收到的开局消息要能拿到自己的船
  await guest.wait('start', 15000);

  // ---------- 1. 客人 → 主机：每一种受击 fx 都要在对端落地 ----------
  console.log('\n· 受击同步（客人打主机）');
  const HIT_CASES = [
    ['bomb → sink', { fx: 'sink', dur: 2 }, 'window.__game.localBoat.sinkTimer > 0'],
    ['missile → missileHit', { fx: 'missileHit', dur: 1.8 }, 'window.__game.localBoat.slowTimer > 0'],
    ['fish/闪电 → slow', { fx: 'slow', dur: 1.5 }, 'window.__game.localBoat.slowTimer > 0'],
    ['rvortex → spin', { fx: 'spin', dur: 2 }, 'window.__game.localBoat.spinTimer > 0'],
    ['vortex → bubbleLift', { fx: 'bubbleLift', dur: 5 }, 'window.__game.localBoat.bubbleLiftTimer > 0'],
    ['waterfall → geyserLift', { fx: 'geyserLift', dur: 3 }, 'window.__game.localBoat.geyserLiftTimer > 0'],
    ['slowboat → halfSpeed', { fx: 'halfSpeed', dur: 3.5 }, 'window.__game.localBoat.halfSpeedTimer > 0'],
    ['octopus → octoGrab', { fx: 'octoGrab', dur: 2 }, 'window.__game.localBoat.octoGrabTimer > 0'],
    ['bubblefly → void', { fx: 'void', dur: 3 }, 'window.__game.localBoat.voidTimer > 0'],
    ['ink → inkStun', { fx: 'inkStun', dur: 1 }, 'window.__game.items.inkTimer > 0'],
    ['torpedo → capsize', { fx: 'capsize', dur: 1.2 }, 'window.__game.localBoat.capsizeTimer > 0'],
  ];
  for (const [label, msg, probe] of HIT_CASES) {
    await ev('(function(){const b=window.__game.localBoat; b.shieldTimer=0; window.__game.items.inkTimer=0; return 1})()');
    guest.send({ t: 'itemHit', id: myId, dur: msg.dur, fx: msg.fx, x: 0, z: 0 });
    let hit = false;
    for (let i = 0; i < 40; i++) { if (await ev(probe)) { hit = true; break; } await sleepCd(150); }
    ok(hit, '受击结算：' + label);
  }

  console.log('\n· 状态同步（itemFx）');
  // 注意 itemFx 的语义：`id` 是「施放者自己」。handleNet 对 id===myId 会早退
  // （施放者本地已经应用过），所以这里只能用对端的 id 来验证接收端表现。
  const peerBoat = (field) => `window.__game.boats.get(${JSON.stringify(peerId)}).${field} > 0`;
  // 「方向转换器」是特例：它必须在 myId 早退之前处理，因为受害者就是自己
  guest.send({ t: 'itemFx', id: myId, fx: 'reverse', dur: 5, by: peerId });
  let revHit = false;
  for (let i = 0; i < 40; i++) {
    if (await ev('window.__game.localBoat.reverseControlTimer > 0')) { revHit = true; break; }
    await sleepCd(150);
  }
  ok(revHit, '状态结算：tide → reverse（受害者是本地时不会被 myId 早退吃掉）');

  const FX_CASES = [
    ['magnet（对端被吸）', { id: peerId, fx: 'magnet', dur: 2.5, target: myId }, peerBoat('magnetTimer')],
    ['shield（对端开盾）', { id: peerId, fx: 'shield', dur: 3 }, peerBoat('shieldTimer')],
    ['angel（对端天使）', { id: peerId, fx: 'angel', dur: 3 }, peerBoat('shieldTimer')],
  ];
  for (const [label, msg, probe] of FX_CASES) {
    guest.send({ t: 'itemFx', ...msg });
    let hit = false;
    for (let i = 0; i < 40; i++) { if (await ev(probe)) { hit = true; break; } await sleepCd(150); }
    ok(hit, '状态结算：' + label);
  }

  // 护盾免疫：本地开盾后被鱼雷打，必须挡掉
  await ev('(function(){const b=window.__game.localBoat; b.shieldTimer=5; b.capsizeTimer=0; return 1})()');
  guest.send({ t: 'itemHit', id: myId, fx: 'capsize', dur: 1.2, x: 0, z: 0 });
  await sleepCd(800);
  ok(!(await ev('window.__game.localBoat.capsizeTimer > 0')), '护盾免疫：护盾期间鱼雷不生效');

  // 天使清负面（本地施放，走 useItem 的真实路径）
  await ev('(function(){const g=window.__game; g.localBoat.shieldTimer=0; g.localBoat.reverseControlTimer=5; return 1})()');
  await ev('window.__game.items.useItem(window.__game.myId, "angel")');
  await sleepCd(600);
  ok(await ev('window.__game.localBoat.shieldTimer > 0'), '状态结算：angel 给到无敌');
  ok(!(await ev('window.__game.localBoat.reverseControlTimer > 0')), 'angel 清掉了方向反转');

  // ---------- 2. 主机 → 客人：每个道具都必须有消息发出去 ----------
  console.log('\n· 施放同步（主机放道具，客人必须收到）');
  const SEND_CASES = [
    ['bomb', 'itemUse'], ['missile', 'itemUse'], ['octopus', 'itemUse'],
    ['bubblefly', 'itemUse'], ['torpedo', 'itemUse'], ['vortex', 'itemUse'],
    ['waterfall', 'itemUse'], ['slowboat', 'itemUse'],
  ];
  for (const [item, type] of SEND_CASES) {
    guest.clear();
    await ev(`(function(){const g=window.__game; g.items.projectiles.length=0; return g.items.useItem(g.myId, ${JSON.stringify(item)})})()`);
    let got = null;
    try { got = await guest.wait(type, 8000); } catch { /* 超时 */ }
    ok(!!got, `发出并被转发：${item}（${type}）`, got ? undefined : '客人没收到');
    if (got && item === 'torpedo') ok(got.target === null || got.target === undefined, '鱼雷不带锁定目标（需要瞄准）');
  }

  // 逐个目标型道具：命中必须转发
  // tide 是特例：它不发明 itemHit，而是逐个目标发 itemFx{fx:'reverse'}
  for (const [item, expectFx] of [['ink', 'inkStun'], ['tide', 'reverse'], ['fish', 'slow'], ['rvortex', 'spin']]) {
    guest.clear();
    const rank = await ev(`(function(){
      const g = window.__game; const me = g.boats.get(g.myId);
      // 先把自己压到最后一名（fish 只打领先者 / rvortex 只打第一名）
      const a = g.progressMap.get(g.myId); if (a) a.prog = 10;
      const b = g.progressMap.get(${JSON.stringify(peerId)}); if (b) b.prog = 400;
      // 把对端的船摆到正前方，保证 AoE 判定也能命中
      const t = g.boats.get(${JSON.stringify(peerId)});
      if (t) {
        t.pos.x = me.pos.x + Math.sin(me.heading) * 12;
        t.pos.z = me.pos.z + Math.cos(me.heading) * 12;
        // 上一段测过 shield/angel，护盾还挂着就会把这些道具全挡掉 —— 先清掉
        t.shieldTimer = 0;
      }
      g.items.useItem(g.myId, ${JSON.stringify(item)});
      return g.items.getRank(g.myId);
    })()`);
    let got = null;
    try {
      got = await guest.waitWhere(item === 'tide' ? 'itemFx' : 'itemHit',
        (m) => m.id === peerId && m.fx === expectFx, 9000);
    } catch { /* 超时 */ }
    ok(!!got, `命中广播：${item} → ${expectFx}（本机名次 ${rank}）`, got ? undefined : '对端没收到');
  }

  // ---------- 3. 鱼雷/导弹走完弹道真的能打中远端并广播 ----------
  console.log('\n· 弹道 → 远端命中（本机打对端，走完整条链路）');
  for (const [item, wantFx] of [['torpedo', 'capsize'], ['missile', 'missileHit']]) {
    guest.clear();
    await ev(`(function(){
      const g=window.__game; const me=g.boats.get(g.myId); const t=g.boats.get(${JSON.stringify(guest.id)});
      if(!t) return 'no guest boat';
      g.items.projectiles.length=0;
      const fx=Math.sin(me.heading), fz=Math.cos(me.heading);
      t.pos.x=me.pos.x+fx*26; t.pos.z=me.pos.z+fz*26; t.heading=me.heading;
      t.speed=0; t.vel.set(0,0);
      me.heading=Math.atan2(t.pos.x-me.pos.x, t.pos.z-me.pos.z);
      return g.items.useItem(g.myId, ${JSON.stringify(item)});
    })()`);
    let got = null;
    try { got = await guest.waitWhere('itemHit', (m) => m.id === guest.id, 20000); } catch { /* 超时 */ }
    ok(!!got, `${item} 真能打中远端并广播命中`, got ? undefined : '20s 内没收到 itemHit');
    if (got) ok(got.fx === wantFx, `${item} 命中效果 = ${wantFx}`, got.fx);
  }

  // ---------- 4. 落雷：只发相对时间，两端不会错拍 ----------
  console.log('\n· 暴风雨落雷（双端时钟不同源）');
  guest.clear();
  // 本机是客人不排雷，临时把 isHost 打开来验证「发送端只发 delay」
  await ev(`(function(){ const it=window.__game.items; it.storm=true; it.isHost=true; it.lightningTimer=0.001; return 1; })()`);
  let strike = null;
  try {
    strike = await guest.waitWhere('lightning', () => true, 30000);
  } catch { /* 超时 */ }
  ok(!!strike, '落雷会广播给对端', strike ? undefined : '30s 内没有 lightning 消息');
  if (strike) {
    ok(typeof strike.delay === 'number' && strike.delay > 0, '落雷只发相对延迟 delay（不发绝对时间戳）', strike);
    ok(strike.strikeAt === undefined, '不再下发 strikeAt（跨端时钟不同源会造成"立刻落雷/圈不消失"）');
  }
  // 落雷本体必须是怪物模式那颗 effekseer 素材，不是旧的程序化锯齿线
  ok(await ev('!!(window.__game.fx && window.__game.fx.effects && window.__game.fx.effects.fxArcBolt)'),
    '落雷素材 fxArcBolt（怪物模式同款）已加载');
  // 对端注入一条 lightning 后，预警圈必须在 delay 后自己消失（不能永久残留）
  await ev(`(function(){ const it=window.__game.items; it.warnings.length=0; it.handleNet({t:'lightning', x:0, z:0, delay:0.5}); return it.warnings.length; })()`);
  const warnBefore = await ev('window.__game.items.warnings.length');
  let cleared = false;
  for (let i = 0; i < 60; i++) {
    if ((await ev('window.__game.items.warnings.length')) === 0) { cleared = true; break; }
    await sleepCd(200);
  }
  ok(warnBefore === 1 && cleared, '客人端的落雷预警圈会按 delay 正常收掉');

  // ---------- 5. 页面不能有异常 ----------
  ok(errors.length === 0, '页面无 JS 异常', errors.slice(0, 3));

  guest.close();
} catch (e) {
  failures += 1;
  console.error('\n✗ 体检中断：', e.message);
} finally {
  try { ws?.close(); } catch {}
  try { child?.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? '\n✅ 联机全道具体检全部通过' : `\n❌ ${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
