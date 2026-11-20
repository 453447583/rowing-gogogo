// 竞速模式 / 道具模式 联机 E2E：房主 = 裸 WS（脚本扮演），客机 = 真浏览器。
//   node tests/race_item_net_e2e.mjs
//
// 这两个模式跟 BOSS 模式不一样：没有"主机跑 AI、客机跟着看"的阶段机，
// 每个人各跑各的，服务器只做「快照聚合 + 进度/名次 + 结算」。风险点因此不同：
//
//   竞速
//   R1 名单里要有 AI，客机才看得到对手
//   R2 主机代报的 AI 快照必须真的能推动客机那端的 AI 船（否则 AI 在客机屏幕上定格）
//   R3 别人的过门进度要同步过来（名次/HUD 才不是自己瞎猜）
//   R4 有人冲线 → 客机亮出完结观察期
//   R6 一局打满 → raceEnd → 客机能走到最终结算
//   R7 房主回大厅 → 所有人跟着 lobbyReset
//   R5 多局制第 1 局结束 → roundEnd → 客机进领奖台（这是"卡在结算页"的另一条路径）
//
//   道具
//   I1 客机本地道具箱布点非空
//   I2 别人吃箱子 → 本地同一个箱子立刻消失
//   I3 别人的炸弹 → 本地出现 ghost 弹道（只飞不结算）
//   I4 别人的减速命中 → 本地船被减速
//   I5 方向转换器必须在 myId 早退之前处理（自己就是受害者）
//   I6 闪电预警圈要出现在本地
//   I7 `#buildBoxes` 里不许有 Math.random（一用 boxIdx 就跨端错位）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAPS } from '../src/data/maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTTP_PORT = Number(process.env.PORT) || 3581;
const WS_PORT = Number(process.env.WS_PORT) || 3582;
const cdpPort = 9800 + Math.floor(Math.random() * 90);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/race-item-' + Date.now());
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

/** 从源码里按花括号配对取出一个方法的函数体（比 indexOf 第二个方法名可靠） */
function methodBody(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return '';
}

class Host {
  constructor() { this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('房主连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: '房主', session: 'host-race' })));
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
      if (Date.now() - start > timeout) throw new Error(`房主等 ${type} 超时`);
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
const waitFor = async (expr, label, tries = 100) => {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await ev(expr);
    if (last === true || (typeof last === 'number' && last > 0)) return last;
    await sleep(250);
  }
  throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
};
const softWait = (expr, label, tries = 100) => waitFor(expr, label, tries).catch(() => null);

/** 大厅里选艇 + 准备（走真实 UI，顺便验大厅本身） */
const lobbyPick = async (boatId) => {
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '回到大厅', 200);
  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat=\\"${boatId}\\"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat=\\"${boatId}\\"]').click()`);
  await ev(`(function(){const c=document.querySelector('#btn-lobby-pick-close');if(c)c.click();return 1})()`);
  await ev(`document.querySelector('#btn-lobby-ready').click()`);
};

/** 房主按真实客户端的方式跑完一圈：逐门上报，最后一门带 totalTime */
const runHostLap = async (fromGate, N, totalTime) => {
  for (let g = fromGate; g <= N - 1; g++) {
    host.send({ t: 'gate', id: host.id, gate: g, lap: 1 });
    await sleep(12);
  }
  host.send({ t: 'gate', id: host.id, gate: 0, lap: 2, totalTime, finish: true });
};

const host = new Host();
let child = null;
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

try {
  // ---------- I7（静态）：布点必须确定性 ----------
  const itemsSrc = await fs.readFile(path.join(ROOT, 'src/game/Items.js'), 'utf8');
  const boxBody = methodBody(itemsSrc, '#buildBoxes()');
  ok(boxBody.length > 400 && !/Math\.random\s*\(/.test(boxBody),
    `道具箱布点不含 Math.random（${boxBody.length} 字符，boxIdx 才能跨端对齐）`);

  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }
  await host.connect();
  host.send({ t: 'pick', boatId: 'titan' });
  host.send({ t: 'mode', modeId: 'race' });
  host.send({ t: 'settings', settings: { aiCount: 1, laps: 1, rounds: 1 } });
  await host.waitWhere('roster', (r) => r.mode === 'race' && r.settings.aiCount === 1);

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
      // 无头软渲染的已知环境噪声（见 DEV_BOSS_ATTACK_FX.md / 2026-11-17 日志）
      if (!/texImage2D|Overload resolution failed|null function or function signature mismatch|reading 'getParameter'/.test(d)) pageErrors.push(d.split('\n')[0]);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2500);

  // ---------- 客机入房 ----------
  await ev(`(function(){ localStorage.setItem('rr-name','客机'); return 1; })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);
  await sleep(3000);
  await waitFor(`typeof document.querySelector('#btn-join')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-join').click()`);
  await waitFor(`!document.querySelector('#dlg-join').classList.contains('hidden')`, '加入对话框');
  await ev(`(function(){
    document.querySelector('#input-host').value = '127.0.0.1';
    document.querySelector('#btn-join-go').click();
    return 1;
  })()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '客机进大厅', 200);
  ok(true, '浏览器以客人身份进入大厅');

  // ======================= 竞速：单局制 → raceEnd =======================
  await lobbyPick('cow');
  await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机' && p.ready), 15000);
  ok(true, '客机选艇 + 准备，房主收到');
  host.clear();
  host.send({ t: 'start' });
  const startMsg = await host.wait('start', 10000);
  const N = MAPS.find((m) => m.id === startMsg.mapId)?.gates.length || 24;
  ok(startMsg.mode === 'race' && startMsg.order.length === 3, 'R1 竞速开局：2 真人 + 1 AI', {
    mode: startMsg.mode, gates: N, order: startMsg.order.map((o) => o.ai ? o.name + '(AI)' : o.name),
  });
  await waitFor(`!!window.__game?.boats`, '客机建起比赛', 240);
  const r1 = JSON.parse(await ev(`(function(){
    const g = window.__game;
    return JSON.stringify({ mode: g.mode, isHost: g.isHost, boats: g.boats.size, ai: g.aiBoats.length });
  })()`));
  ok(r1.mode === 'race' && r1.boats >= 3 && r1.ai >= 1, 'R1 客机场景里 3 条船（含 1 台 AI）', r1);

  // 装一个观察钩子：直接看客机收到了哪条结算消息（比猜 DOM 可靠）
  await ev(`(function(){
    window.__last = {};
    window.__game.net.on('roundEnd', (e) => { window.__last.roundEnd = e.detail.round; });
    window.__game.net.on('raceEnd', (e) => { window.__last.raceEnd = (e.detail.standings || []).length; });
    return 1;
  })()`);

  // ---------- R2：主机代报的 AI 快照要能推动客机那端的 AI ----------
  const aiId = await ev(`[...window.__game.boats.keys()].find((k) => k.startsWith('ai')) || null`);
  const aiBefore = aiId ? JSON.parse(await ev(`(function(){
    const b = window.__game.boats.get(${JSON.stringify(aiId)});
    return JSON.stringify({ x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1) });
  })()`)) : null;
  if (aiId && aiBefore) {
    const tgtX = aiBefore.x + 40;
    const tgtZ = aiBefore.z + 30;
    for (let i = 0; i < 24; i++) {
      host.send({
        t: 'state', id: aiId, auth: true,
        x: tgtX, z: tgtZ, y: 0, h: 0, s: 20, b: false, vx: 0, vz: 0, r: 0,
      });
      await sleep(60);
    }
    const aiNow = await (async () => {
      for (let i = 0; i < 50; i++) {
        const p = await ev(`(function(){
          const b = window.__game.boats.get(${JSON.stringify(aiId)});
          return b ? [b.pos.x, b.pos.z] : null;
        })()`);
        if (Array.isArray(p) && Math.hypot(p[0] - tgtX, p[1] - tgtZ) < 8) return p;
        await sleep(200);
      }
      return null;
    })();
    ok(!!aiNow, `R2 主机代报 AI 快照 → 客机那端的 AI 艇跟过去了（目标 ${tgtX.toFixed(0)},${tgtZ.toFixed(0)}）`, aiNow);
  } else {
    ok(false, 'R2 客机场景里找不到 AI 艇', { aiId, aiBefore });
  }

  // ---------- R3：别人的过门进度要同步 ----------
  // 注意客户端 progressMap 里存的是「下一个要过的门」：房主刚过 3 号门，
  // 客机这边应该是 4（`#onRemoteGate` 里 `pm.gate = (gate + 1) % N`）。
  for (const g of [1, 2, 3]) { host.send({ t: 'gate', id: host.id, gate: g, lap: 1 }); await sleep(40); }
  const gateSynced = await (async () => {
    for (let i = 0; i < 50; i++) {
      const g = await ev(`(function(){
        const pm = window.__game.progressMap.get(${JSON.stringify(host.id)});
        return pm ? pm.gate : -999;
      })()`);
      if (g === 4) return g;
      await sleep(200);
    }
    return null;
  })();
  ok(gateSynced === 4, 'R3 房主过门进度同步到客机（过完 3 号门 → 客机看到「下一个是 4 号」）', gateSynced);

  // ---------- R4：冲线 → 客机亮出完结观察期 ----------
  await runHostLap(4, N, 61.5);
  const finishUi = await softWait(
    `!!document.querySelector('#finish-window-countdown')?.classList.contains('show')`,
    '完结观察期 UI', 80,
  );
  ok(!!finishUi, 'R4 收到别人冲线 → 客机亮出完结观察期倒计时');

  // ---------- R6：10 秒窗口后 raceEnd → 最终结算 ----------
  const raceEnd = await (async () => {
    for (let i = 0; i < 120; i++) {
      const v = await ev(`window.__last.raceEnd || 0`);
      if (v > 0) return v;
      await sleep(300);
    }
    return 0;
  })();
  ok(raceEnd > 0, 'R6 一局打满 → 客机收到 raceEnd（没有卡在比赛里）', raceEnd);
  const finalScreen = await softWait(
    `!document.querySelector('#podium').classList.contains('hidden')`,
    '最终结算画面', 80,
  );
  ok(!!finalScreen, 'R6 客机走到了最终结算画面');
  const finalNames = await ev(`JSON.stringify([...document.querySelectorAll('#podium-players .name')].map((e) => e.textContent))`);
  ok(/房主/.test(String(finalNames)), 'R6 结算画面是真名次', finalNames);

  // ---------- R7：房主回大厅 → 全员 lobbyReset ----------
  host.clear();
  host.send({ t: 'backLobby' });
  await host.wait('lobbyReset', 8000).catch(() => null);
  const backLobby = await softWait(`!document.querySelector('#lobby').classList.contains('hidden')`, '回大厅', 200);
  ok(!!backLobby, 'R7 房主回大厅 → 客机跟着回到大厅（可以开下一局）');

  // ======================= 竞速：多局制 → roundEnd 领奖台 =======================
  host.clear();
  host.send({ t: 'settings', settings: { rounds: 3, laps: 1, aiCount: 1 } });
  await host.waitWhere('roster', (r) => r.settings.rounds === 3, 8000);
  await lobbyPick('cow');
  await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机' && p.ready), 15000);
  host.clear();
  host.send({ t: 'start' });
  const start2 = await host.wait('start', 10000);
  ok(start2.rounds === 3, '多局制开局：rounds = 3', start2.rounds);
  await waitFor(`!!window.__game?.boats`, '客机第二局建起比赛', 240);
  await ev(`(function(){
    window.__last = {};
    window.__game.net.on('roundEnd', (e) => { window.__last.roundEnd = e.detail.round; });
    window.__game.net.on('raceEnd', (e) => { window.__last.raceEnd = (e.detail.standings || []).length; });
    return 1;
  })()`);
  for (const g of [1, 2, 3]) { host.send({ t: 'gate', id: host.id, gate: g, lap: 1 }); await sleep(40); }
  await runHostLap(4, N, 58.2);
  const roundEndRound = await (async () => {
    for (let i = 0; i < 120; i++) {
      const v = await ev(`window.__last.roundEnd || 0`);
      if (v > 0) return v;
      await sleep(300);
    }
    return 0;
  })();
  ok(roundEndRound > 0, 'R5 多局制第 1 局结束 → 客机收到 roundEnd（不是 raceEnd）', roundEndRound);
  const podiumShown = await softWait(`!document.querySelector('#podium').classList.contains('hidden')`, '领奖台', 80);
  ok(!!podiumShown, 'R5 roundEnd → 客机进领奖台（不会卡在比赛画面里）');

  // 回大厅准备测道具模式
  host.clear();
  host.send({ t: 'backLobby' });
  await host.wait('lobbyReset', 8000).catch(() => null);
  await softWait(`!document.querySelector('#lobby').classList.contains('hidden')`, '回大厅', 200);

  // ======================= 道具模式 =======================
  host.clear();
  host.send({ t: 'settings', settings: { rounds: 1, laps: 1, aiCount: 0 } });
  host.send({ t: 'mode', modeId: 'item' });
  await host.waitWhere('roster', (r) => r.mode === 'item', 8000);
  await lobbyPick('cow');
  await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机' && p.ready), 15000);
  host.clear();
  host.send({ t: 'start' });
  const itemStart = await host.wait('start', 10000);
  ok(itemStart.mode === 'item', '切到道具模式后正常开局', itemStart.mode);
  await waitFor(`!!window.__game?.items`, '客机建起 ItemManager', 240);

  const boxInfo = JSON.parse(await ev(`(function(){
    const it = window.__game.items;
    return JSON.stringify({ n: it.boxes.length, sample: it.boxes.slice(0, 2).map((b) => [+b.x.toFixed(1), +b.z.toFixed(1)]) });
  })()`));
  ok(boxInfo.n >= 40, `I1 客机本地道具箱 ${boxInfo.n} 个（布点由赛道几何算，跨端一致）`, boxInfo);

  // I2：别人吃箱子 → 本地同一个箱子消失
  host.send({ t: 'itemPick', boxIdx: 2, by: host.id });
  const boxGone = await (async () => {
    for (let i = 0; i < 40; i++) {
      if ((await ev(`window.__game.items.boxes[2].active`)) === false) return true;
      await sleep(150);
    }
    return false;
  })();
  ok(boxGone, 'I2 别人吃掉 3 号箱 → 本地箱子立刻消失');

  // I3：别人的炸弹 → 本地 ghost 弹道
  const projBefore = await ev(`window.__game.items.projectiles.length`);
  host.send({ t: 'itemUse', id: host.id, item: 'bomb', x: 0, z: 0, vx: 0, vz: 20 });
  let projGrew = null;
  for (let i = 0; i < 40 && projGrew == null; i++) {
    const n = await ev(`window.__game.items.projectiles.length`);
    if (n > projBefore) projGrew = n;
    else await sleep(150);
  }
  const ghost = await ev(`(function(){
    const p = window.__game.items.projectiles;
    return p.length ? !!p[p.length - 1].ghost : null;
  })()`);
  ok(projGrew != null && ghost === true, `I3 别人的炸弹 → 本地出现 ghost 弹道（只飞不结算，${projBefore} → ${projGrew}）`);

  const myId = await ev(`window.__game.myId`);

  // I4：减速命中
  host.send({ t: 'itemHit', id: myId, fx: 'slow', dur: 1.6, x: 0, z: 0 });
  let slowed = 0;
  for (let i = 0; i < 40 && !slowed; i++) {
    slowed = await ev(`+(window.__game.localBoat.slowTimer || 0).toFixed(2)`);
    if (!slowed) await sleep(150);
  }
  ok(slowed > 0, `I4 被别人减速命中 → 本地船 slowTimer = ${slowed}`);

  // I5：方向转换器（受害者就是自己，必须在 myId 早退之前处理）
  host.send({ t: 'itemFx', id: myId, fx: 'reverse', dur: 5, by: host.id });
  let reversed = 0;
  for (let i = 0; i < 40 && !reversed; i++) {
    reversed = await ev(`+(window.__game.localBoat.reverseControlTimer || 0).toFixed(2)`);
    if (!reversed) await sleep(150);
  }
  ok(reversed > 0, `I5 被方向转换器命中 → 本地操控反转 ${reversed}s`);

  // I6：闪电预警圈
  const warnBefore = await ev(`window.__game.items.warnings.length`);
  host.send({ t: 'lightning', x: 6, z: 6, delay: 2 });
  let warned = null;
  for (let i = 0; i < 40 && warned == null; i++) {
    const n = await ev(`window.__game.items.warnings.length`);
    if (n > warnBefore) warned = n;
    else await sleep(150);
  }
  ok(warned != null, `I6 别人的落雷 → 本地出现预警圈（${warnBefore} → ${warned}）`);

  ok(pageErrors.length === 0, pageErrors.length ? '页面异常: ' + pageErrors.slice(0, 2).join(' | ') : '客机全程无页面异常');
} catch (e) {
  failures += 1;
  console.error('竞速 / 道具联机 E2E 异常:', e.message);
} finally {
  try { ws?.terminate(); } catch {}
  try { host.ws?.close(); } catch {}
  try { child?.kill('SIGKILL'); } catch {}
  server.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(failures ? `\n竞速 / 道具联机 E2E：${failures} 项失败` : '\n竞速 / 道具联机 E2E：全部通过');
  process.exit(failures ? 1 : 0);
}
