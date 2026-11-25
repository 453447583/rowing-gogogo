// 联机全流程 E2E：打完一局 → 回大厅 → 再开一局（用户报的"点了开始没反应"）
//   node tests/net_flow.mjs
// 主机 = 无头浏览器，客人 = 纯 WS 客户端（跑完一圈触发结算）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';
import { MAPS } from '../src/data/maps.js';

const HTTP_PORT = 3413;
const WS_PORT = 3414;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/netflow-' + Date.now());
const cdpPort = 9400 + Math.floor(Math.random() * 90);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const server = spawn(process.execPath, ['server/server.js'], {
  env: {
    ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    // 别把探针账号写进真实排行榜文件
    LEADERBOARD_FILE: path.resolve('.tmp_build/net_flow.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

// ---- 无头浏览器 ----
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', BASE], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 90000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const waitFor = async (expr, label, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
};
const shot = async (name) => {
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('  shot -> shots/verify/' + name + '.png');
};

// ---- 客人客户端 ----
class Guest {
  constructor(name) { this.name = name; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'guest-flow' })));
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
  async wait(type, timeout = 8000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type) { this.cursors[type] = i + 1; return this.msgs[i]; }
      }
      if (Date.now() - start > timeout) throw new Error(`${this.name} 等 ${type} 超时`);
      await sleep(30);
    }
  }
  clear() { this.msgs = []; this.cursors = {}; }
  last(type) { return [...this.msgs].reverse().find((m) => m.t === type); }
  finish(mapId, laps) {
    const N = MAPS.find((m) => m.id === mapId).gates.length;
    for (let lap = 1; lap <= laps; lap++) {
      for (let g = 0; g < N; g++) this.send({ t: 'gate', id: this.id, gate: g, lap });
    }
    this.send({ t: 'gate', id: this.id, gate: 0, lap: laps + 1, totalTime: 61.2, finish: true });
  }
}

let guest = null;
try {
  // 等两个服务起来
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
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2200);

  // ---- 1. 房主建局 ----
  await waitFor(`!!document.querySelector('#btn-host')`, '主菜单');
  // 账号体系：入口强制登录，先拿真实 token；占位串会被 /auth/session 校验清掉。
  const e2eToken = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, 'e2e房主');
  ok(!!e2eToken, '房主拿到账号 token', e2eToken ? 'ok' : 'empty');
  await ev(`localStorage.setItem('rr-name','房主'); localStorage.setItem('rr-account-token','${e2eToken}'); location.reload();`);
  await sleep(2500);
  await waitFor(`!!document.querySelector('#btn-host')`, '主菜单(刷新后)');
  await ev(`document.querySelector('#btn-host').click()`);
  await waitFor(`!document.querySelector('#menu-boat').classList.contains('hidden')`, '进入选艇屏');
  await sleep(1200);
  ok(true, '房主连接到服务器并进入选艇屏');

  // ---- 2. 客人加入 ----
  guest = new Guest('二号');
  const gw = await guest.connect();
  // welcome 里的 players 已经包含"我自己"，所以是 2 个人
  ok(gw.players.filter((p) => !p.ai).length >= 2, '客人加入时看到房主已在房间', gw.players.map((p) => p.name));

  // ---- 3. 双方选艇 ----
  await ev(`(() => { const c = [...document.querySelectorAll('.boat-card')].find(x => !x.classList.contains('taken')); c && c.click(); return true; })()`);
  await sleep(600);
  const hostBoat = await ev(`document.querySelector('#boat-title-name')?.textContent`);
  guest.send({ t: 'pick', boatId: 'titan' });
  await guest.wait('roster');
  ok(!!hostBoat, '房主选到赛艇: ' + hostBoat);

  await ev(`document.querySelector('#btn-map-ok').click()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '进入大厅');
  await sleep(500);

  // 圈数改成 1 圈，客人一圈就能完赛
  await ev(`(() => { const s = document.querySelector('#sel-laps'); if (s) { s.value = '1'; s.onchange && s.onchange(); } return !!s; })()`);
  await sleep(500);

  // ---- 4. 开局 ----
  const started1 = await ev(`(() => { const b = document.querySelector('#btn-start-race'); if (!b || b.disabled) return { err: b ? 'disabled' : 'missing' }; b.click(); return { ok: true }; })()`);
  ok(started1.ok, '房主点"开始游戏"按钮可点', started1);
  const s1 = await guest.wait('start', 8000);
  await waitFor(`!!window.__game && !!window.__game.track`, '浏览器开赛');
  ok(!!s1.raceSeq, '客人收到 start（raceSeq=' + s1.raceSeq + '）');

  // ---- 5. 客人跑完 → 10s 结算 ----
  guest.clear();
  guest.finish(s1.mapId, s1.laps);
  await guest.wait('raceEnd', 25000);
  ok(true, '客人完赛 → 服务器结算 raceEnd');
  await waitFor(`!document.querySelector('#results').classList.contains('hidden')`, '房主看到结果页', 120);
  await sleep(600);
  await shot('net-flow-1-results');

  // ---- 6. 房主"再来一局"：必须真的回到选艇屏 ----
  await ev(`(() => { const b = document.querySelector('#btn-back-lobby'); if (b) b.click(); return b ? b.textContent : null; })()`);
  await waitFor(`!document.querySelector('#menu-boat').classList.contains('hidden')`, '回到选艇屏', 60);
  ok(true, '点"再来一局"真的回到了选艇屏（以前会卡在结果页）');
  await guest.wait('lobbyReset', 6000);
  ok(true, '客人也收到了 lobbyReset');
  await sleep(800);
  await shot('net-flow-2-boatselect');

  // ---- 7. 上一局的选艇必须已释放，双方重新选 ----
  const freeCheck = await ev(`(() => ({
    taken: [...document.querySelectorAll('.boat-card.taken')].length,
    total: document.querySelectorAll('.boat-card').length,
  }))()`);
  ok(freeCheck.taken === 0, '回到选艇屏时没有"被占用"的赛艇', freeCheck);
  await ev(`(() => { const c = [...document.querySelectorAll('.boat-card')].find(x => !x.classList.contains('taken')); c && c.click(); return true; })()`);
  await sleep(600);
  guest.send({ t: 'pick', boatId: 'titan' });
  await guest.wait('roster');
  await ev(`document.querySelector('#btn-map-ok').click()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '再次进入大厅');
  await sleep(500);

  // ---- 8. 再开一局（核心回归）----
  guest.clear();
  await ev(`document.querySelector('#btn-start-race').click()`);
  const s2 = await guest.wait('start', 10000);
  ok(s2.raceSeq > s1.raceSeq, '第二局真的开起来了（raceSeq ' + s1.raceSeq + ' → ' + s2.raceSeq + '）');
  await waitFor(`!!window.__game && !!window.__game.track`, '第二局浏览器开赛', 100);
  const gameInfo = await ev(`({ map: window.__game?.mapDef?.id, seq: window.__game?.raceSeq ?? null })`);
  ok(!!gameInfo.map, '第二局场景已建立', gameInfo);
  await sleep(1200);
  await shot('net-flow-3-second-race');

  if (errors.length) ok(false, '页面异常: ' + errors.slice(0, 2).join(' | '));
  else ok(true, '全程无页面异常');
} catch (e) {
  failures += 1;
  console.error('E2E 异常:', e.message);
  try { await shot('net-flow-fail'); } catch {}
} finally {
  try { ws?.terminate(); } catch {}
  try { guest?.ws?.close(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(failures ? `\n联机全流程：${failures} 项失败` : '\n联机全流程：全部通过');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
