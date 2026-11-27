// 云端天梯第 8/9/10 层 · 真联机中继验收（房主 = 无头浏览器，客人 = 裸 WS）
//   npm run build && node tests/sky_tower_layer8910_net_e2e.mjs
//
// 验证的是服务器 RELAY_TYPES 与两端 handleNet 接线：
//   1) 房主进第 8 层后，客机能收到 towerCrystalState / towerCrystalHp
//   2) 客机上报 towerCrystalHit，房主真的扣水晶血
//   3) 房主进第 9 层后，客机能收到 towerPaintState
//   4) 客机上报 towerPaintBreak，房主真的断笔
//   5) 房主进第 10 层抢冠，客机收到 towerCrownGrab / towerCrownState
//   6) 客机上报 towerCrownFire，房主生成泡泡并回传 towerCrownBubble
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3481;
const WS_PORT = 3482;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tower-net-' + Date.now());
const cdpPort = 9540 + Math.floor(Math.random() * 40);
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

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
    LEADERBOARD_FILE: path.resolve('.tmp_build/tower_net_e2e.json'),
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
const j = async (expr) => {
  const raw = await ev(expr);
  if (typeof raw !== 'string' || (raw[0] !== '{' && raw[0] !== '[')) {
    throw new Error('非 JSON: ' + String(raw).slice(0, 300));
  }
  return JSON.parse(raw);
};
const waitFor = async (expr, label, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(250);
  }
  throw new Error('timeout: ' + label);
};

class Guest {
  constructor(name) { this.name = name; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'guest-tower' })));
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

  console.log('\n[1] 房主建房 → 大厅 → 模式切到天梯');
  const token = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯联机房主');
  ok(!!token, '房主拿到账号 token');
  await ev(`localStorage.setItem('rr-name','房主'); localStorage.setItem('rr-account-token','${token}'); location.reload();`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-host').click()`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进入大厅');
  await sleep(800);

  guest = new Guest('挑战者');
  await guest.connect();
  await ev(`document.querySelector('#btn-lobby-mode').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click()`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  const roster = await guest.waitWhere('roster', (r) => r.mode === 'skytower', 9000);
  ok(roster.mode === 'skytower', '客人看到房间模式 = skytower');

  console.log('\n[2] 开局 → 天梯控制器就绪');
  // 双方先选艇（和竞技场 e2e 同一套大厅要求）
  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await sleep(300);
  guest.send({ t: 'pick', boatId: 'rower' });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.boatId === 'rower'), 9000);
  guest.clear();
  guest.send({ t: 'ready', ready: true });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.ready), 9000);
  guest.clear();
  await ev(`(() => { const b=document.querySelector('#btn-start-race'); if(!b||b.disabled) return 'blocked'; b.click(); return 'ok'; })()`);
  const startMsg = await guest.waitWhere('start', (m) => m.mode === 'skytower', 15000);
  ok(startMsg.order.length >= 2, '客人收到 skytower 开局名单', startMsg.order?.length);
  await waitFor(`window.__game?.mode === 'skytower' && !!window.__game.bossMode`, '天梯控制器');
  await ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(500);
  ok(await ev(`window.__game.isHost === true`), '浏览器那端是房主');

  const DECK8 = 126.3, DECK9 = 144.3, DECK10 = 162.3;
  const gotoLayer = (layer, deck) => `(()=>{const b=window.__game.bossMode;
    for(const [id,p] of b.players){p.layer=${layer};const bt=b.boats.get(id);if(!bt)continue;
      p.alive=true;p.fallWater=null;p.invuln=0;bt.skyFall=false;bt.liftRide=null;bt.skyLayer=${layer};
      bt.diveTargetY=${deck};bt.vel.set(0,0);bt.vy=0;bt.speed=0;}
    const me=window.__game.localBoat; me.pos.set(0,${deck},0); me.heading=0;
    return 1;})()`;

  console.log('\n[3] 第 8 层：状态广播 + 冲撞扣血');
  await ev(gotoLayer(7, DECK8));
  const st8 = await guest.waitWhere('towerCrystalState', (m) => Array.isArray(m.hp), 9000);
  ok(!!st8 && Array.isArray(st8.hp), '客机收到 towerCrystalState', st8 && st8.hp);
  await ev(`(()=>{const b=window.__game.bossMode,r=b.crystal,me=window.__game.localBoat;
    r.shieldLeft=0; r.hp=[300,300];
    me.pos.set(16,${DECK8},0); me.heading=Math.PI/2; me.vel.set(0,0); me.speed=0;
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyW',key:'w'})); return 1;})()`);
  const hpMsg = await guest.waitWhere('towerCrystalHp', (m) => Array.isArray(m.hp), 12000).catch(() => null);
  await ev(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyW',key:'w'}));1`);
  ok(!!hpMsg && hpMsg.hp[1] < 300, '房主冲撞 → 客机收到 towerCrystalHp（血量下降）', hpMsg && hpMsg.hp);

  console.log('\n[4] 客机 → 房主：towerCrystalHit');
  const beforeHit = await ev(`window.__game.bossMode.crystal.hp[1]`);
  guest.send({ t: 'towerCrystalHit', by: guest.id, side: 1, dmg: 30, x: 24, z: 0 });
  await sleep(700);
  const afterHit = await ev(`window.__game.bossMode.crystal.hp[1]`);
  ok(afterHit <= beforeHit - 25, '客机上报撞击，房主真的扣血', { beforeHit, afterHit });

  console.log('\n[5] 第 9 层：归属快照 + 断笔上报');
  await ev(gotoLayer(8, DECK9));
  const st9 = await guest.waitWhere('towerPaintState', (m) => typeof m.g === 'string' || Array.isArray(m.c), 12000);
  ok(!!st9 && (typeof st9.g === 'string' || Array.isArray(st9.c)), '客机收到 towerPaintState', st9 && { g: String(st9.g || '').length, c: st9.c });
  const hostId = await ev(`window.__game.myId`);
  guest.send({ t: 'towerPaintBreak', id: hostId, dur: 1.5 });
  await sleep(600);
  const inkBreak = await ev(`window.__game.bossMode.paint.inkBreak.get(window.__game.myId) || 0`);
  ok(inkBreak > 0, '客机上报断笔，房主进入断笔状态', inkBreak);

  console.log('\n[6] 第 10 层：抢冠广播 + 客机泡泡请求');
  await ev(gotoLayer(9, DECK10));
  const st10 = await guest.waitWhere('towerCrownState', (m) => typeof m.st === 'string', 12000);
  ok(!!st10, '客机收到 towerCrownState', st10 && st10.st);
  await ev(`(()=>{const b=window.__game.bossMode;const id=[...b.players.keys()].find(k=>k!==b.myId);
    const p=b.players.get(id); if(p) p.alive=false; return 1;})()`);
  await sleep(2400);
  const grab = await ev(`(()=>{const b=window.__game.bossMode,r=b.crown,me=window.__game.localBoat;
    me.pos.set(r.crown.x,${DECK10},r.crown.z); me.vel.set(0,0); me.speed=0; return 1;})()`);
  void grab;
  await guest.waitWhere('towerCrownGrab', (m) => !!m.id, 12000);
  const holderNow = await ev(`window.__game.bossMode.crown.holder`);
  ok(!!holderNow, '房主抢到皇冠并广播 towerCrownGrab', holderNow);
  // 把刚才藏起来的客机船重新放回本层（不然房主不认为它在本层，泡泡请求会被忽略）
  await ev(`(()=>{const b=window.__game.bossMode;const p=b.players.get('${guest.id}');
    if(p){p.alive=true;p.layer=9;} const bt=b.boats.get('${guest.id}'); if(bt){bt.skyLayer=9;bt.diveTargetY=${DECK10};bt.pos.set(10,${DECK10},10);}
    return 1;})()`);
  await sleep(400);
  guest.clear();
  const hx = await ev(`window.__game.localBoat.pos.x`);
  const hz = await ev(`window.__game.localBoat.pos.z`);
  const ids = await j(`(()=>{const b=window.__game.bossMode;
    return JSON.stringify({players:[...b.players.keys()],boats:[...b.boats.keys()],
      crownBoats:[...b.crown.boats.keys()]});})()`);
  console.log('  host ids: ' + JSON.stringify(ids) + ' guest=' + guest.id);
  guest.send({ t: 'towerCrownFire', by: guest.id, x: hx, z: hz });
  const bubMsg = await guest.waitWhere('towerCrownBubble', (m) => Number.isFinite(m.x), 6000).catch(() => null);
  await sleep(120);
  const hostBubbles = await ev(`window.__game.bossMode.crown.bubbles.length`);
  ok(!!bubMsg && hostBubbles > 0, '客机请求放泡泡，房主生成并回传 towerCrownBubble', { bub: !!bubMsg, hostBubbles });

  console.log('\n[7] 控制台错误检查');
  await sleep(400);
  ok(errors.length === 0, '无未捕获异常', errors.slice(0, 3));

  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
  if (failures) console.error('失败项：' + failures);
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  try { guest?.ws?.close(); } catch {}
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
}
process.exitCode = failures ? 1 : 0;
