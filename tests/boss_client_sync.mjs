// 怪物模式联机 E2E：房主 = 裸 WS（脚本扮演），客机 = 真浏览器。
//   node tests/boss_client_sync.mjs
//
// 这个文件专门复现并防回归用户报的那个 bug：
//   「一台上开主机 + 一台开客户端，主机把 BOSS 打完进了传送门，
//     客户端那边连倒计时都没结束，之后永远卡在结算页，门也不出来。」
//
// 根因有两层：
//   1) 服务端 RELAY_TYPES 漏了 bossPortal / bossReady —— 门与"已准备"根本传不过去
//   2) 客户端阶段机是本地推的，被浏览器节流后就永久停在 countdown，没有任何追帧
//
// 所以这里断言的是"客机自己能不能追上"，而不是"消息有没有到"：
//   A. 客机建起来时 isHost=false（AI/判定都应该在主机那侧）
//   B. 客机被卡在 countdown 时，主机一句 bossState(stage:2, phase:fight) 就能把它拽过去
//   C. 主机通报 BOSS 死亡 → 客机走完正常死亡流程进入 clear
//   D. 主机进 portal 并下发 px/pz → 客机在**同一个坐标**立起门（不是自己抽签）
//   E. 只收到一次性的 bossPortal（漏掉 bossState）也要能开门
//   F. 主机 10Hz 的 bossState 在客机这侧要真的按 10Hz 落地
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTTP_PORT = Number(process.env.PORT) || 3571;
const WS_PORT = Number(process.env.WS_PORT) || 3572;
const cdpPort = 9700 + Math.floor(Math.random() * 90);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boss-client-sync-' + Date.now());
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else {
    failures += 1;
    console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

class Host {
  constructor() { this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('主机连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: '房主', session: 'host-boss' })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 已关 */ } }
  async waitWhere(type, pred = () => true, timeout = 10000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) {
          this.cursors[type] = i + 1;
          return this.msgs[i];
        }
      }
      if (Date.now() - start > timeout) throw new Error(`主机等 ${type} 超时`);
      await sleep(25);
    }
  }
  wait(type, timeout) { return this.waitWhere(type, () => true, timeout); }
  clear() { this.msgs = []; this.cursors = {}; }
}

let ws; let seq = 0;
const pending = new Map();
const pageErrors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 120000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', {
    expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
  return r.result?.value;
};
const waitFor = async (expr, label, tries = 200) => {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await ev(expr);
    if (last === true || (typeof last === 'number' && last > 0)) return last;
    await sleep(250);
  }
  throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
};

const host = new Host();
let child = null;
try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }

  // ---- 房主先建房（浏览器后才能以"客人"身份加入）----
  await host.connect();
  host.send({ t: 'pick', boatId: 'titan' });
  host.send({ t: 'mode', modeId: 'boss' });
  await host.waitWhere('roster', (r) => r.mode === 'boss');

  child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=960,560', BASE], { stdio: 'ignore' });

  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
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
      // 无头 Edge + SwiftShader 下 Effekseer WASM / WebGL 上下文丢失的已知环境噪声，
      // 见 DEV_BOSS_ATTACK_FX.md 与 .workbuddy/memory/2026-11-17.md；真 GPU 不会出现。
      if (!/texImage2D|Overload resolution failed|null function or function signature mismatch|Cannot read properties of null \(reading 'getParameter'\)/.test(d)) pageErrors.push(d.split('\n')[0]);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2500);

  // ---- 浏览器以客人身份加入 ----
  await ev(`(function(){ localStorage.setItem('rr-name','客机'); return 1; })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);
  await sleep(3000);
  await waitFor(`typeof document.querySelector('#btn-join')?.onclick === 'function'`, '主菜单就绪');
  await ev(`document.querySelector('#btn-join').click()`);
  await waitFor(`!document.querySelector('#dlg-join').classList.contains('hidden')`, '加入对话框');
  await ev(`(function(){
    const i = document.querySelector('#input-host');
    i.value = '127.0.0.1';
    document.querySelector('#btn-join-go').click();
    return 1;
  })()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '客机进入大厅');
  ok(true, '浏览器以"客人"身份进入大厅');

  // 客人选艇 + 准备（走真实 UI，顺便验一遍大厅在联机下能不能用）
  await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机'), 12000).catch(() => null);
  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="cow"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="cow"]').click()`);
  await ev(`(function(){const c=document.querySelector('#btn-lobby-pick-close');if(c)c.click();return 1})()`);
  const pickedRoster = await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机' && p.boatId === 'cow'), 15000).catch(() => null);
  if (!pickedRoster) console.error('  debug roster:', JSON.stringify([...host.msgs].reverse().find((m) => m.t === 'roster')?.players));
  ok(!!pickedRoster, '客人在大厅里选艇，服务器收到了');
  await ev(`document.querySelector('#btn-lobby-ready').click()`);
  const readyRoster = await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机' && p.ready), 15000).catch(() => null);
  if (!readyRoster) console.error('  debug roster:', JSON.stringify([...host.msgs].reverse().find((m) => m.t === 'roster')?.players));
  ok(!!readyRoster, '客人的"准备"状态同步到房主');
  if (!pickedRoster || !readyRoster) throw new Error('客机没能完成选艇 / 准备，后面所有断言都会失真');

  // ---- 开战 ----
  host.clear();
  host.send({ t: 'start' });
  await host.wait('start', 8000);
  await waitFor(`!!window.__game?.bossMode`, '客机建立 BossMode', 240);
  const base = JSON.parse(await ev(`(function(){
    const g = window.__game, b = g.bossMode;
    return JSON.stringify({
      isHost: g.isHost, mode: g.mode, stage: b.stage, phase: b.phase,
      players: [...b.players.keys()].length, boats: g.boats ? g.boats.size : 0,
      hostHuman: b.isHost,
    });
  })()`));
  ok(base.isHost === false && base.hostHuman === false, '客机侧 isHost=false（AI 与判定都在主机那边）', base);
  ok(base.players === 2 && base.boats >= 2, '客机场景里 2 名玩家 2 条船', base);

  // 装一层接收计数：后面要验 10Hz 的 bossState 是不是真的按 10Hz 落地
  await ev(`(function(){
    window.__rx = {};
    const ws = window.__game.net.ws;
    const prev = ws.onmessage;
    ws.onmessage = (e) => {
      try { const m = JSON.parse(e.data); window.__rx[m.t] = (window.__rx[m.t] || 0) + 1; } catch (_) {}
      return prev(e);
    };
    return 1;
  })()`);

  // ---- B. 卡在 countdown 的客机必须被拽到主机所在的第 2 关 ----
  // 先把客机按在 countdown 上不动（真实场景 = 标签页被浏览器节流）
  await ev(`(function(){ const b = window.__game.bossMode; b.phase = 'countdown'; b.countdown = 99; return 1; })()`);
  host.send({
    t: 'bossState', stage: 2, phase: 'fight', hp: 1, x: 0, z: 0, h: 0, dead: false,
    status: { slow: 0, blind: 0, confuse: 0, silence: 0, reverse: 0, vulnerable: 0 },
  });
  const jumped = await waitFor(`window.__game.bossMode.stage === 2`, '客机追上主机关卡', 60).catch(() => null);
  ok(!!jumped, '主机一句 bossState(stage:2) 就把卡在倒计时的客机拽到第 2 关');
  const afterJump = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({ stage: b.stage, phase: b.phase, hp: Math.round(b.boss.hp) });
  })()`));
  ok(afterJump.stage === 2, '客机 stage 已经是 2', afterJump);

  // 让客机进入 fight（主机通报 phase:fight 后本地才会真正开打）
  await ev(`(function(){ const b = window.__game.bossMode; b.phase = 'fight'; return 1; })()`);

  // ---- C. 主机通报 BOSS 死亡 → 客机走完正常死亡流程 ----
  for (let i = 0; i < 6; i++) {
    host.send({
      t: 'bossState', stage: 2, phase: 'fight', hp: 0, x: 0, z: 0, h: 0, dead: true,
      status: { slow: 0, blind: 0, confuse: 0, silence: 0, reverse: 0, vulnerable: 0 },
    });
    await sleep(120);
  }
  const cleared = await waitFor(
    `['clear','portal','victory'].includes(window.__game.bossMode.phase)`,
    '客机进入 clear',
    80,
  ).catch(() => null);
  ok(!!cleared, '主机通报 BOSS 已死 → 客机自己走完死亡流程（不会停在 fight）');
  ok(await ev(`window.__game.bossMode.phase !== 'fight'`), '客机 phase 已离开 fight', await ev(`window.__game.bossMode.phase`));

  // ---- D. 主机开门并下发坐标 → 客机必须在同一坐标立门 ----
  host.send({ t: 'bossState', stage: 2, phase: 'portal', hp: 0, x: 0, z: 0, h: 0, dead: true, px: 31.5, pz: -17.25,
    status: { slow: 0, blind: 0, confuse: 0, silence: 0, reverse: 0, vulnerable: 0 } });
  const portalUp = await waitFor(`!!window.__game.bossMode.portal`, '客机开出传送门', 120).catch(() => null);
  ok(!!portalUp, '客机看到了传送门（这就是用户报的"门一直不出来"）');
  const pPos = JSON.parse(await ev(`(function(){
    const p = window.__game.bossMode.portal;
    return JSON.stringify(p ? { x: +p.x.toFixed(2), z: +p.z.toFixed(2), phase: window.__game.bossMode.phase } : null);
  })()`));
  ok(!!pPos && Math.abs(pPos.x - 31.5) < 0.6 && Math.abs(pPos.z + 17.25) < 0.6,
    '门的位置和主机下发的坐标一致（不是客机自己抽签）', pPos);

  // ---- D2. 客机自己的 clear 计时到点、但还没收到门坐标：评分卡必须先收掉 ----
  // 用户复现的“客机一直停在评分结算界面”：客机 clearT 先走完时走的是
  // #openPortal(无坐标) 分支，以前在 return 前没有收卡，于是永远停在评分页。
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.startStage(3);
    b.phase = 'fight';
    return 1;
  })()`);
  await waitFor(`window.__game.bossMode.stage === 3 && !window.__game.bossMode.portal`, '第 3 关且门已清空', 120);
  host.send({ t: 'bossState', stage: 3, phase: 'clear', hp: 0, x: 0, z: 0, h: 0, dead: true,
    status: { slow: 0, blind: 0, confuse: 0, silence: 0, reverse: 0, vulnerable: 0 } });
  await waitFor(`window.__game.bossMode.phase === 'clear'`, '第 3 关 clear', 120);
  ok(await ev(`!document.querySelector('#boss-result')?.classList.contains('hidden')`),
    'BOSS 死亡后客机自己弹出本地过关评分卡');
  await ev(`(function(){ window.__game.bossMode.clearT = 0.0001; return 1; })()`);
  await waitFor(`window.__game.bossMode.phase === 'portal'`, '客机本地计时到点进入 portal', 60);
  ok(await ev(`document.querySelector('#boss-result')?.classList.contains('hidden')`),
    '客机自己的 clear 计时到点就收掉评分卡（不再等主机开门）');
  ok(await ev(`!window.__game.bossMode.portal`),
    '此时门尚未出现：门仍然等主机下发坐标（结算先本地完成）');

  // ---- E. 只收到一次性 bossPortal（漏掉 bossState）也要能开门 ----
  // 新开一关，先把门清掉，模拟"客户端切后台漏了整段 bossState"
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.startStage(3);
    b.phase = 'fight';
    return 1;
  })()`);
  await waitFor(`window.__game.bossMode.stage === 3 && !window.__game.bossMode.portal`, '第 3 关且门已清空', 120);
  // 先让主机把它拽到 clear 但不带 px，再单独补一条 bossPortal
  host.send({ t: 'bossState', stage: 3, phase: 'clear', hp: 0, x: 0, z: 0, h: 0, dead: true,
    status: { slow: 0, blind: 0, confuse: 0, silence: 0, reverse: 0, vulnerable: 0 } });
  await waitFor(`window.__game.bossMode.phase === 'clear' || window.__game.bossMode.phase === 'portal'`, '第 3 关 clear', 120);
  host.send({ t: 'bossPortal', x: -22.5, z: 41 });
  const viaMsg = await waitFor(`!!window.__game.bossMode.portal`, '单条 bossPortal 也能开门', 120).catch(() => null);
  ok(!!viaMsg, '哪怕只收到一条 bossPortal，客机也能把门立起来（漏消息不再等于永久卡死）');
  const p2 = JSON.parse(await ev(`(function(){
    const p = window.__game.bossMode.portal;
    return JSON.stringify(p ? { x: +p.x.toFixed(2), z: +p.z.toFixed(2) } : null);
  })()`));
  ok(!!p2 && Math.abs(p2.x + 22.5) < 0.6 && Math.abs(p2.z - 41) < 0.6, '一次性消息里的坐标同样被采用', p2);

  // ---- F. 10Hz 的 bossState 落地率 ----
  await ev(`(function(){ window.__rx = {}; return 1; })()`);
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    host.send({
      t: 'bossState', stage: 3, phase: 'portal', hp: 0, x: 0, z: 0, h: 0, dead: true,
      px: -22.5, pz: 41,
      status: { slow: 0, blind: 0, confuse: 0, silence: 0, reverse: 0, vulnerable: 0 },
    });
    await sleep(100);
  }
  const span = (Date.now() - t0) / 1000;
  const rx = await ev(`JSON.stringify(window.__rx)`) || '{}';
  const rxMap = JSON.parse(rx);
  const rate = (rxMap.bossState || 0) / span;
  console.log(`  · 主机 10Hz 广播，客机实收 ${rxMap.bossState || 0} 条 / ${span.toFixed(1)}s ≈ ${rate.toFixed(1)}/s`);
  ok(rate > 7, `bossState 在客机这侧按接近 10Hz 落地（实测 ${rate.toFixed(1)}/s）`);

  // ---- G. 客机回传 bossReady 房主要收得到 ----
  host.clear();
  await ev(`(function(){ window.__game.net.send({ t: 'bossReady', id: window.__game.myId, ready: true }); return 1; })()`);
  const readyMsg = await host.waitWhere('bossReady', () => true, 6000).catch(() => null);
  ok(!!readyMsg && readyMsg.ready === true, '客机点进传送门后回传的 bossReady 能到达主机');

  ok(pageErrors.length === 0, pageErrors.length ? '页面异常: ' + pageErrors.slice(0, 2).join(' | ') : '客机全程无页面异常');
} catch (e) {
  failures += 1;
  console.error('怪物模式客户端同步 E2E 异常:', e.message);
} finally {
  try { ws?.terminate(); } catch {}
  try { host.ws?.close(); } catch {}
  try { child?.kill('SIGKILL'); } catch {}
  server.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(failures ? `\n怪物模式客户端同步 E2E：${failures} 项失败` : '\n怪物模式客户端同步 E2E：全部通过');
  process.exit(failures ? 1 : 0);
}
