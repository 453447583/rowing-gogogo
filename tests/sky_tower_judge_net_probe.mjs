// 云端天梯 · 联机「判定用最新快照位」回归探针
//   node tests/sky_tower_judge_net_probe.mjs
//
// 背景（2026-11-27）：房主原本拿远端船的渲染插值位 boat.pos 做各层道具判定，
// 而 boat.pos 固定慢 REMOTE_SAMPLE_DELAY(66ms) + 30Hz 采样 + 网络往返，
// 客机本地已经撞到球/包子/皇冠，房主却用旧船位判没碰到 → 穿模无反应。
// 修复：SkyTowerMode.#judgeBoat() 用最新快照位 + 半个 RTT 外推，只改判定视图。
//
// 本探针验三件事：
//   1) 渲染位在远处、最新快照位贴球：房主足球碰撞真的触发（客机撞球被认）
//   2) 反过来渲染位贴球、最新快照位在远处：房主不误判（不会隔空撞球）
//   3) 十层小游戏拿到的 entries 全部使用判定位，且没有污染远端船的渲染位
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3561;
const WS_PORT = 3562;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tower-judge-' + Date.now());
const cdpPort = 9700 + Math.floor(Math.random() * 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/tower_judge_probe.json'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', BASE,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 120000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const json = async (expr) => {
  const raw = await ev(expr);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
};
const waitFor = async (expr, label, tries = 160) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
};

class Guest {
  constructor(name) { this.name = name; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'guest-tower-judge' })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 关了 */ } }
  async waitWhere(type, pred = () => true, timeout = 12000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) {
          this.cursors[type] = i + 1;
          return this.msgs[i];
        }
      }
      if (Date.now() - start > timeout) throw new Error(`客人等 ${type} 超时`);
      await sleep(30);
    }
  }
  clear() { this.msgs = []; this.cursors = {}; }
}

let guest = null;
try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(200);
  }
  let tabs = null;
  for (let i = 0; i < 120 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails?.exception?.description || 'exception';
      if (!/texImage2D/.test(d)) errors.push(d);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2200);

  console.log('\n[1] 建天梯房 → 一真人房主 + 一真人客机');
  const token = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯判定位房主');
  ok(!!token, '房主拿到账号 token');
  await ev(`localStorage.setItem('rr-name','房主'); localStorage.setItem('rr-account-token',${JSON.stringify(token)}); location.reload();`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-host').click()`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进入大厅');
  await sleep(800);

  guest = new Guest('判定位客人');
  await guest.connect();
  await ev(`document.querySelector('#btn-lobby-mode').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click()`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  const roster = await guest.waitWhere('roster', (r) => r.mode === 'skytower', 9000);
  ok(roster.mode === 'skytower', '房间模式 = skytower');
  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  guest.send({ t: 'pick', boatId: 'rower' });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.boatId === 'rower'), 9000);
  guest.clear();
  guest.send({ t: 'ready', ready: true });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.ready), 9000);
  guest.clear();
  const started = await ev(`(() => { const b=document.querySelector('#btn-start-race'); if(!b||b.disabled) return 'blocked'; b.click(); return 'ok'; })()`);
  ok(started === 'ok', '房主点开始');
  await guest.waitWhere('start', (m) => m.mode === 'skytower', 15000);
  await waitFor(`window.__game?.mode === 'skytower' && !!window.__game.bossMode`, '天梯控制器');
  await ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0.05;b.phase='countdown';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase==='round'`, '第 1 层开赛', 80);
  ok(await ev(`window.__game.isHost === true`), '浏览器端是房主（判定权威）');
  ok(await ev(`window.__game.bossMode.boats.has(${JSON.stringify(guest.id)})`), '房主已建立客机远端船');

  // 冻结远端船的渲染插值：让 boat.pos 永远停在人为塞进去的「旧渲染位」，
  // 这样旧代码（拿 boat.pos 判定）与新代码（拿 remoteSnaps 判定）结果必然不同。
  const patched = await ev(`(()=>{const b=window.__game.bossMode;const bt=b.boats.get(${JSON.stringify(guest.id)});
    if(!bt) return 'no-boat'; bt.updateRemote=()=>{}; window.__judgeBoat=bt; return 'ok';})()`);
  ok(patched === 'ok', '冻结客机船渲染位（只在本探针内）', patched);

  const parkOthers = `(()=>{const g=window.__game,b=g.bossMode;
    const me=g.localBoat; me.pos.set(45,18.4,0); me.vel.set(0,0); me.speed=0;
    for(const [id,p] of b.players){p.layer=0;p.alive=true;p.invuln=0;
      const bt=b.boats.get(id); if(!bt||id===${JSON.stringify(guest.id)})continue;
      bt.pos.set(-45,18.4,0);bt.vel.set(0,0);bt.speed=0;}
    return 1;})()`;

  console.log('\n[2] 渲染位在远处 + 最新快照位贴球 → 房主认下客机撞球');
  guest.send({ t: 'state', id: guest.id, x: 0, z: 27.4, h: Math.PI, s: 18, b: false, y: 18.4, vx: 0, vz: -18, r: 0 });
  await sleep(180);
  await ev(parkOthers);
  const setupA = await json(`(()=>{const b=window.__game.bossMode,f=b.football,bt=window.__judgeBoat;
    bt.pos.set(40,18.4,0); bt.vel.set(0,0);
    // 服务器 30Hz 会把客人最后一条 state 反复广播回来；探针要塞自定义快照，
    // 就得在这里掐掉入队（只影响本探针页面，不改源码）。
    bt.setRemoteState=()=>{};
    bt.remoteSnaps.length=0; bt.remoteSnaps.push({t:bt.remoteClock,x:0,z:27.4,heading:Math.PI,speed:18,boosting:false,vx:0,vz:-18,roll:0,y:18.4});
    bt.target={x:0,z:27.4,heading:Math.PI,speed:18,boosting:false,vx:0,vz:-18,y:18.4};
    f.ball.dead=false; f.ball.x=0; f.ball.z=25; f.ball.vx=0; f.ball.vz=0; f.ball.hop=0; f.ball.lastTouch=null;
    f.resetTimer=0; f.kickoffLock=0;
    return JSON.stringify({render:{x:bt.pos.x,z:bt.pos.z},snap:{x:bt.remoteSnaps[0].x,z:bt.remoteSnaps[0].z}});})()`);
  ok(Math.abs(setupA.render.x - 40) < 0.01 && Math.abs(setupA.snap.z - 27.4) < 0.01,
    '前置条件：渲染位 x=40、最新快照位 z=27.4', setupA);
  // 手动同步推进 16 帧（约 0.27s）：避免 CDP 求值间隙里游戏主循环继续跑，
  // 把人为塞进去的 remoteSnaps 又冲掉，造成假阴性。
  const hitA = await json(`(()=>{const b=window.__game.bossMode;
    b.phase='fight'; b.layerIndex=0; b.layerPhase='round'; b.layerTimeLeft=120; b.timeLeft=600;
    for(let i=0;i<16;i++) b.update(1/60, b.fightTime + i/60);
    const f=b.football,bt=window.__judgeBoat;
    return JSON.stringify({last:f.ball.lastTouch,vz:+f.ball.vz.toFixed(2),ballZ:+f.ball.z.toFixed(2),
      renderX:+bt.pos.x.toFixed(2),snapZ:+bt.remoteSnaps[bt.remoteSnaps.length-1].z.toFixed(2),layer:b.layerPhase});})()`);
  ok(hitA.last === guest.id, '房主把球判成客机碰到（lastTouch=客机）', hitA);
  ok(hitA.vz < -5, '球被客机向 -z 顶出去', hitA);
  ok(Math.abs(hitA.renderX - 40) < 0.01, '判定没有修改远端船的渲染位', hitA);

  console.log('\n[3] 渲染位贴球 + 最新快照位在远处 → 房主不误判');
  await ev(parkOthers);
  const setupB = await json(`(()=>{const b=window.__game.bossMode,f=b.football,bt=window.__judgeBoat;
    bt.pos.set(0,18.4,27.4); bt.vel.set(0,0,-18);
    bt.remoteSnaps.length=0; bt.remoteSnaps.push({t:bt.remoteClock,x:0,z:-25,heading:Math.PI,speed:0,boosting:false,vx:0,vz:0,roll:0,y:18.4});
    bt.target={x:0,z:-25,heading:Math.PI,speed:0,boosting:false,vx:0,vz:0,y:18.4};
    f.ball.dead=false; f.ball.x=0; f.ball.z=25; f.ball.vx=0; f.ball.vz=0; f.ball.hop=0; f.ball.lastTouch=null;
    f.resetTimer=0; f.kickoffLock=0;
    return JSON.stringify({render:{x:bt.pos.x,z:bt.pos.z},snap:{x:bt.remoteSnaps[0].x,z:bt.remoteSnaps[0].z}});})()`);
  ok(Math.abs(setupB.render.z - 27.4) < 0.01 && Math.abs(setupB.snap.z + 25) < 0.01,
    '前置条件：渲染位 z=27.4、最新快照位 z=-25', setupB);
  const hitB = await json(`(()=>{const b=window.__game.bossMode;
    b.phase='fight'; b.layerIndex=0; b.layerPhase='round'; b.layerTimeLeft=120; b.timeLeft=600;
    for(let i=0;i<16;i++) b.update(1/60, b.fightTime + i/60);
    const f=b.football,bt=window.__judgeBoat;
    return JSON.stringify({last:f.ball.lastTouch,vz:+f.ball.vz.toFixed(2),ballZ:+f.ball.z.toFixed(2),
      renderZ:+bt.pos.z.toFixed(2),snapZ:+bt.remoteSnaps[bt.remoteSnaps.length-1].z.toFixed(2)});})()`);
  ok(hitB.last !== guest.id, '渲染位贴球也不会隔空判客机撞球', hitB);
  ok(Math.abs(hitB.vz) < 1, '球没有被莫名的冲量弹走', hitB);

  console.log('\n[4] 十层 entries 全部用判定位（含包子 / 皇冠 / 水晶 / 落雷 / BOSS）');
  await ev(`(()=>{const b=window.__game.bossMode;const names=['football','deliver','itemRush','bossRush','thunder','defense','shrink','crystal','paint','crown'];
    window.__cap=null; window.__mods={};
    for(const n of names){const m=b[n];if(!m)continue;window.__mods[n]=m.update.bind(m);
      // fight 分支每帧会把十层模块全调一遍，非本层 entries 都是空表；
      // 只记录真正拿到 live entries 的那个模块。
      m.update=(dt,entries)=>{if(!entries.length)return;window.__cap={name:n,entries:entries.map(e=>({id:e.id,
        x:e.boat.pos.x,z:e.boat.pos.z,y:e.boat.pos.y,heading:e.boat.heading,
        vx:e.boat.vel.x,vz:e.boat.vel.y,hasDef:!!e.boat.def}))};};}
    b.phase='fight'; b.timeLeft=600; b.layerPhase='round'; b.layerTimeLeft=120; b.itemQueued=-1;
    const bt=window.__judgeBoat; bt.pos.set(40,18.4,0); bt.vel.set(0,0);
    bt.remoteSnaps.length=0; bt.remoteSnaps.push({t:bt.remoteClock,x:11,z:-7,heading:1.2,speed:9,boosting:false,vx:2,vz:-3,roll:0,y:18.4});
    bt.target={x:11,z:-7,heading:1.2,speed:9,boosting:false,vx:2,vz:-3,y:18.4};
    if(b.net) b.net.rtt=20;
    return 'ok';})()`);
  const names = ['football', 'deliver', 'itemRush', 'bossRush', 'thunder', 'defense', 'shrink', 'crystal', 'paint', 'crown'];
  for (let i = 0; i < names.length; i++) {
    // 必须在同一次 CDP 求值里「调用 update → 读捕获结果」，否则主循环会先跑一帧，
    // 把 __cap 覆盖成当前层的模块（旧版探针这里连续 9 项误报成 crown）。
    const cap = await json(`(()=>{const b=window.__game.bossMode;
      for(const [id,p] of b.players){p.layer=${i};p.alive=true;p.invuln=0;}
      b.phase='fight'; b.timeLeft=600; b.layerIndex=${i}; b.layerPhase='round'; b.layerTimeLeft=120; b.itemQueued=-1;
      window.__cap=null; b.update(1/60, b.fightTime); return JSON.stringify(window.__cap);})()`);
    const en = cap?.entries?.find((e) => e.id === guest.id);
    // flight = rtt/2000 = 0.01s；判定位 = 快照位 + 速度 × 0.01
    const expX = 11 + 2 * 0.01, expZ = -7 - 3 * 0.01;
    ok(cap?.name === names[i] && !!en, `第 ${i + 1} 层 entries 已交给 ${names[i]}`, cap);
    ok(!!en && Math.abs(en.x - expX) < 0.05 && Math.abs(en.z - expZ) < 0.05,
      `第 ${i + 1} 层判定用最新快照位（非渲染位 x=40）`, en && { x: en.x, z: en.z, expX, expZ });
    ok(!!en && en.hasDef && Math.abs(en.vx - 2) < 0.01 && Math.abs(en.vz + 3) < 0.01,
      `第 ${i + 1} 层判定位保留船体定义与速度`, en);
    const realPos = await json(`(()=>{const bt=window.__judgeBoat;return JSON.stringify({x:bt.pos.x,z:bt.pos.z});})()`);
    ok(Math.abs(realPos.x - 40) < 0.01 && Math.abs(realPos.z) < 0.01,
      `第 ${i + 1} 层判定没有污染远端船渲染位`, realPos);
  }

  await ev(`(()=>{const b=window.__game.bossMode;
    for(const [n,fn] of Object.entries(window.__mods||{})) b[n].update=fn;
    window.__mods=null; return 1;})()`);

  ok(errors.length === 0, '整段流程无未捕获异常', errors.slice(0, 3));
  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  try { guest?.ws?.close(); } catch { /* 关了 */ }
  try { ws?.close(); } catch { /* 关了 */ }
  try { child.kill(); } catch { /* 关了 */ }
  try { server.kill(); } catch { /* 关了 */ }
  process.exitCode = failures ? 1 : 0;
}
