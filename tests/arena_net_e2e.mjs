// 潮汐竞技场（1v1）联机 E2E：房主 = 无头浏览器，客人 = 裸 WS
//   node tests/arena_net_e2e.mjs
//
// 验证的是「表现层」而不是协议（协议见 tests/arena_net.test.mjs）：
//   1) 大厅里把模式切到竞技场，两边名单一致
//   2) 开局后浏览器真的建起了 ArenaMode（order 2 人，本地艇有、对手艇有）
//   3) 客人发 arenaDmg → 房主掉血、并回传 arenaHp
//   4) 房主自动广播的 arenaCore / arenaRound 客人收得到（Game.js 的监听表不能漏）
//   5) HUD 的据点条与技能条在联机里同样出现
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const HTTP_PORT = 3441;
const WS_PORT = 3442;
// arenaCinema=0：跳过开场动画（无头低帧率下 10s 游戏时间会放大成两三分钟，超时假失败）
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&arenaCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/arena-e2e-' + Date.now());
const cdpPort = 9500 + Math.floor(Math.random() * 90);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const server = spawn(process.execPath, ['server/server.js'], {
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', BASE], { stdio: 'ignore' });

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
const waitFor = async (expr, label, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
};
const shot = async (name) => {
  // 输出 jpeg：1280×760 的 png 有 3MB 多，翻图/发人都嫌重
  const res = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 74 });
  await fs.writeFile(path.join(out, name + '.jpg'), Buffer.from(res.data, 'base64'));
  console.log('  shot -> shots/verify/' + name + '.jpg');
};

class Guest {
  constructor(name) { this.name = name; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'guest-arena' })));
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
  async waitWhere(type, pred, timeout = 9000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) {
          this.cursors[type] = i + 1;
          return this.msgs[i];
        }
      }
      if (Date.now() - start > timeout) throw new Error(`${this.name} 等 ${type} 超时`);
      await sleep(30);
    }
  }
  wait(type, timeout) { return this.waitWhere(type, () => true, timeout); }
  clear() { this.msgs = []; this.cursors = {}; }
}

let guest = null;
try {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(200);
  }
  let tabs = null;
  for (let i = 0; i < 120 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails?.exception?.description || 'exception';
      // effekseer 的 WASM 在传贴图时会报 texImage2D，这是特效插件的老问题
      // （怪物模式同样会报），跟竞技场联机无关，别让它把断言全带红
      if (!/texImage2D/.test(d)) errors.push(d);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2200);

  // ---- 1. 房主建房 ----
  await ev(`localStorage.setItem('rr-name','房主'); location.reload();`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单', 120);
  await ev(`document.querySelector('#btn-host').click()`);
  // 大厅改造后，建房直接进 #lobby（老的 #menu-boat / #mode-select / #btn-map-ok 已是空壳）
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '进入大厅', 150);
  await sleep(800);
  ok(true, '房主连上服务器并进入大厅');

  // ---- 2. 客人加入 + 双方选艇 ----
  guest = new Guest('挑战者');
  const gw = await guest.connect();
  ok(gw.players.filter((p) => !p.ai).length >= 2, '客人加入后房间有 2 人', gw.players.map((p) => p.name));

  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉', 150);
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev(`(function(){const c=document.querySelector('#btn-lobby-pick-close');if(c)c.click();return 1})()`);
  await sleep(400);
  guest.send({ t: 'pick', boatId: 'rower' });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.boatId === 'rower'));

  // ---- 3. 切模式到竞技场 ----
  await ev(`document.querySelector('#btn-lobby-mode').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="arena"]')`, '模式抽屉', 150);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="arena"]').click()`);
  await ev(`(function(){const c=document.querySelector('#btn-lobby-pick-close');if(c)c.click();return 1})()`);
  const rArena = await guest.waitWhere('roster', (r) => r.mode === 'arena', 8000);
  ok(rArena.mode === 'arena', '客人看到房间模式切成 arena');

  // ---- 4. 开局 ----
  guest.clear();
  // 非房主的真人必须先准备（房主点开始才会被服务器接受）
  guest.send({ t: 'ready', ready: true });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.ready), 8000);
  guest.clear();
  const startRes = await ev(`(() => { const b = document.querySelector('#btn-start-race'); if (!b || b.disabled) return { err: b ? 'disabled' : 'missing' }; b.click(); return { ok: true }; })()`);
  ok(startRes.ok, '房主点开始按钮可点', startRes);
  const startMsg = await guest.wait('start', 15000);
  ok(startMsg.mode === 'arena', '客人收到 mode=arena 的 start', startMsg.mode);
  ok(startMsg.order.length === 2 && !startMsg.order.some((o) => o.ai), '本局名单 2 人、无 AI');

  await waitFor(`!!window.__game && window.__game.mode === 'arena'`, '浏览器建立竞技场', 120);
  const g0 = await ev(`(() => {
    const g = window.__game;
    const a = g.bossMode;
    return {
      mode: g.mode, isArena: g.isArena, isHost: g.isHost,
      hasArenaMode: !!a, phase: a?.phase,
      players: a ? [...a.players.keys()] : [],
      boats: g.boats ? g.boats.size : 0,
      myHp: a?.players?.get(g.myId)?.hp ?? null,
      foeHp: a?.['players']?.get(a?.foeId)?.hp ?? null,
    };
  })()`);
  ok(g0.hasArenaMode && g0.players.length === 2, 'ArenaMode 建起来且读到 2 名玩家', g0);
  ok(g0.boats >= 2, '场上真的有 2 条船', g0.boats);
  ok(g0.isHost === true, '浏览器那端是房主（核心/擂台/回合由它算）');

  // 倒计时结束进入 fight（房主本地跑 stage，客人只是显示）
  await waitFor(`window.__game?.bossMode?.phase === 'fight'`, '进入 fight', 120);
  ok(true, '倒计时结束进入 fight');

  // ---- 5. 客人打房主：受击方权威 ----
  const hostId = await ev(`window.__game.myId`);
  const foeId = await ev(`window.__game.bossMode.foeId`);
  const hpBefore = await ev(`window.__game.bossMode.players.get(window.__game.myId).hp`);
  // 清缓冲要在发消息"之前"：arenaHp 是收到伤害后立刻回的，
  // 放在等掉血之后清，会把已经到达的那条自己擦掉（第一版就栽在这）
  guest.clear();
  guest.send({ t: 'arenaDmg', to: hostId, dmg: 30, from: foeId, x: 0, z: 0 });
  const hpDropped = await (async () => {
    for (let i = 0; i < 40; i++) {
      const hp = await ev(`window.__game.bossMode.players.get(window.__game.myId).hp`);
      if (hp < hpBefore) return hp;
      await sleep(150);
    }
    return null;
  })();
  ok(hpDropped != null && hpDropped < hpBefore, `客人打房主 → 房主掉血 ${hpBefore} → ${hpDropped}`);

  // 房主回传 arenaHp（受击方扣完血广播），客人必须收到
  const hpMsg = await guest.waitWhere('arenaHp', (m) => m.id === hostId, 6000).catch(() => null);
  ok(!!hpMsg, '房主把 arenaHp 广播回客人', hpMsg);

  // ---- 6. 房主权威广播：arenaCore ----
  guest.clear();
  const coreMsg = await guest.wait('arenaCore', 8000).catch(() => null);
  ok(!!coreMsg && typeof coreMsg.z === 'number', 'arenaCore 核心位置到达客人', coreMsg);

  // ---- 7. HUD ----
  const hud = await ev(`(() => ({
    core: !document.getElementById('arena-core')?.classList.contains('hidden'),
    skills: !document.getElementById('arena-skills')?.classList.contains('hidden'),
    modeClass: document.getElementById('hud')?.className || '',
  }))()`);
  ok(hud.core && hud.skills, '联机里 HUD 关卡条 / 技能条都在', hud);
  await shot('arena-net-fight');

  // ---- 8. 远程艇要跟着客人的快照走 ----
  // 只验证"伤害/广播"是不够的：如果 state 快照没打进来，对手在房主屏幕上就是定格的一艘船
  guest.clear();
  const foeStart = await ev(`(() => { const b = window.__game.boats.get(window.__game.bossMode.foeId); return b ? [b.pos.x, b.pos.z] : null; })()`);
  ok(!!foeStart, '房主场景里有对手艇', foeStart);
  const targetX = foeStart[0] + 26;
  const targetZ = foeStart[1] + 18;
  for (let i = 0; i < 14; i++) {
    guest.send({ t: 'state', id: guest.id, x: targetX, z: targetZ, h: 0, s: 0, b: false });
    await sleep(90);
  }
  const foeNow = await (async () => {
    for (let i = 0; i < 30; i++) {
      const p = await ev(`(() => { const b = window.__game.boats.get(window.__game.bossMode.foeId); return b ? [b.pos.x, b.pos.z] : null; })()`);
      if (p && Math.hypot(p[0] - targetX, p[1] - targetZ) < 6) return p;
      await sleep(120);
    }
    return null;
  })();
  ok(!!foeNow, `客人发 state 快照 → 房主那端的对手艇跟过去了（目标 ${targetX.toFixed(0)},${targetZ.toFixed(0)}）`, foeNow);

  // ---- 9. 回合广播（房主结算后客人跟着切）----
  // 第 1 关的第一次超时只是进加时（不会结算），所以直接把加时状态与核心位置
  // 摆到"已经推进到对方门线"，让下一次超时判定走 #endRound → 发 arenaRound。
  guest.clear();
  await ev(`(() => { const a = window.__game.bossMode;
    a.delivery.overtime = true;
    a.delivery.z = -29;
    a.timeoutHandled = false;
    a.roundTime = 0.05;
    return a.phase; })()`);
  const roundMsg = await guest.wait('arenaRound', 12000).catch(() => null);
  ok(!!roundMsg, 'arenaRound 回合结算广播到达客人', roundMsg && { round: roundMsg.round, phase: roundMsg.phase, winner: roundMsg.winner });

  if (errors.length) ok(false, '页面异常: ' + errors.slice(0, 2).join(' | '));
  else ok(true, '全程无页面异常');
} catch (e) {
  failures += 1;
  console.error('竞技场 E2E 异常:', e.message);
  try { await shot('arena-net-fail'); } catch { /* 截图失败无所谓 */ }
} finally {
  try { ws?.terminate(); } catch {}
  try { guest?.ws?.close(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(failures ? `\n竞技场联机 E2E：${failures} 项失败` : '\n竞技场联机 E2E：全部通过');
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
