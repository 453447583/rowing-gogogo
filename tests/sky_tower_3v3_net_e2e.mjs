// 云端天梯 · 3v3（含 AI）联机验收
//   node tests/sky_tower_3v3_net_e2e.mjs
//
// 覆盖：
//   1) 天梯组队每队上限 = 3（不再限制 2v2）；3 真人 + 3 AI 能凑成 3v3
//   2) 房主手动把 AI 分到缺人的队伍，人数相同才能开赛
//   3) 开局 order = 6 人、两队各 3 人；控制器 ids = 6
//   4) 第 1 层正常开赛（60 秒）→ 结束清场开本层升降门
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3521;
const WS_PORT = 3522;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tower-3v3-' + Date.now());
const cdpPort = 9680 + Math.floor(Math.random() * 30);

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
    LEADERBOARD_FILE: path.resolve('.tmp_build/tower_3v3_e2e.json'),
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
const waitFor = async (expr, label, tries = 160) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
};

class Guest {
  constructor(name, session) { this.name = name; this.session = session; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 6000);
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
  latest(type) {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === type) return this.msgs[i];
    return null;
  }
}

let g1 = null; let g2 = null;
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

  console.log('\n[1] 房主建房 → 天梯 + 组队，再加两名客人');
  const token = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯3v3房主');
  await ev(`localStorage.setItem('rr-name','房主'); localStorage.setItem('rr-account-token','${token}'); location.reload();`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-host').click()`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进入大厅');
  await sleep(600);
  g1 = new Guest('蓝队玩家', 'guest-tower-3v3-a');
  g2 = new Guest('红队玩家', 'guest-tower-3v3-b');
  await g1.connect();
  await g2.connect();

  await ev(`document.querySelector('#btn-lobby-mode').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click()`);
  await sleep(400);
  const fmt = await ev(`(()=>{const b=document.querySelector('#lobby-pick-body [data-format="team"]');if(!b||b.disabled)return 'no';b.click();return 'ok';})()`);
  ok(fmt === 'ok', '天梯可切换组队');
  const rosterTeam = await g1.waitWhere('roster', (r) => r.mode === 'skytower' && r.format === 'team', 9000);
  ok(rosterTeam.format === 'team', '服务器接受天梯组队');
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);

  // 3 个 AI
  await ev(`(()=>{const s=document.getElementById('sel-ai');s.value='3';s.dispatchEvent(new Event('change',{bubbles:true}));return 1;})()`);
  await g1.waitWhere('roster', (r) => r.settings?.aiCount === 3, 9000);
  await waitFor(`!!document.querySelector('[data-team-switch="ai3"]')`, '3 个 AI 分行出现', 60);

  // 按真人分布把 AI 分到缺人的队伍，凑成 3v3
  const r0 = g1.latest('roster');
  const humans = r0.players.filter((p) => !p.ai);
  const count = (t) => humans.filter((p) => r0.teams[p.id] === t).length;
  let needBlue = 3 - count('blue');
  let needRed = 3 - count('red');
  ok(humans.length === 3, '房间里有 3 名真人', humans.length);
  ok(needBlue + needRed === 3, '3 个 AI 正好补满到 3v3', { blue: count('blue'), red: count('red') });
  for (let i = 1; i <= 3; i++) {
    const team = needBlue > 0 ? 'blue' : 'red';
    if (team === 'blue') needBlue -= 1; else needRed -= 1;
    const clicked = await ev(`(()=>{const b=document.querySelector('[data-team-switch="ai${i}"][data-team="${team}"]');if(!b)return 'no';b.click();return 'ok';})()`);
    ok(clicked === 'ok', `电脑${i} 分到${team === 'blue' ? '蓝' : '红'}队`);
    await sleep(500);
  }
  const rosterBalanced = await g1.waitWhere('roster', (r) => {
    const t = r.settings?.aiTeams || [];
    if (t.length < 3 || t.some((x) => !x)) return false;
    const humansB = r.players.filter((p) => !p.ai && r.teams[p.id] === 'blue').length;
    const humansR = r.players.filter((p) => !p.ai && r.teams[p.id] === 'red').length;
    return humansB + t.filter((x) => x === 'blue').length === 3
      && humansR + t.filter((x) => x === 'red').length === 3;
  }, 9000);
  ok(!!rosterBalanced, '两队都补到 3 人（含 AI）', rosterBalanced?.settings?.aiTeams);

  console.log('\n[2] 开局：3 真人 + 3 AI = 3v3');
  await ev(`document.querySelector('#btn-lobby-boat')?.click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await sleep(200);
  const boats = ['rower', 'skiff'];
  const guests = [g1, g2];
  for (let i = 0; i < guests.length; i++) {
    guests[i].send({ t: 'pick', boatId: boats[i] });
    await guests[i].waitWhere('roster', (r) => r.players.some((p) => p.id === guests[i].id && p.boatId === boats[i]), 9000);
    guests[i].send({ t: 'ready', ready: true });
    await guests[i].waitWhere('roster', (r) => r.players.some((p) => p.id === guests[i].id && p.ready), 9000);
  }
  const started = await ev(`(() => { const b=document.querySelector('#btn-start-race'); if(!b||b.disabled) return 'blocked'; b.click(); return 'ok'; })()`);
  ok(started === 'ok', '房主点开始');
  const startMsg = await g1.waitWhere('start', (m) => m.mode === 'skytower', 15000);
  const order = startMsg.order || [];
  const blueN = order.filter((e) => e.team === 'blue').length;
  const redN = order.filter((e) => e.team === 'red').length;
  ok(order.length === 6, '开局名单正好 6 人（3 真人 + 3 AI）', order.length);
  ok(blueN === 3 && redN === 3, '两队各 3 人', { blueN, redN });
  ok(order.filter((e) => e.ai).length === 3, '3 个 AI 按房主分配进场', order.filter((e) => e.ai).map((e) => [e.id, e.team]));

  await waitFor(`window.__game?.mode === 'skytower' && !!window.__game.bossMode`, '天梯控制器');
  await ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0.05;b.phase='countdown';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase==='cutscene'`, '第 1 层规则过场', 60);
  const t0 = await ev(`(()=>{const b=window.__game.bossMode;return JSON.stringify({ids:b.ids.length,teamMode:b.teamMode});})()`).then(JSON.parse);
  ok(t0.teamMode === true && t0.ids === 6, '控制器进入 3v3（ids=6，不再截断到 4）', t0);
  await ev(`window.__game.bossMode.cutsceneLeft=0.02`);
  await waitFor(`window.__game.bossMode.layerPhase==='round'`, '第 1 层开赛', 40);
  ok(await ev(`window.__game.bossMode.layerTimeLeft > 55`), '第 1 层比赛 60 秒起跑');

  console.log('\n[3] 第 1 层结束：清场 + 开本层升降门');
  await ev(`(()=>{const b=window.__game.bossMode;b.layerTimeLeft=0.03;return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase==='travel'`, '第 1 层开升降门', 60);
  ok(await ev(`window.__game.bossMode.arena.upliftOpenAt[0]===true`), '第 1 层升降门已开启');
  ok(await ev(`window.__game.bossMode.football.ball.dead===true`), '第 1 层清场：足球消失');
  const openMsg = await g1.waitWhere('towerOpen', (m) => m.layer === 0, 8000).catch(() => null);
  ok(!!openMsg, '客机收到「第 1 层开门」广播', openMsg);
  ok(errors.length === 0, '流程无未捕获异常', errors.slice(0, 3));

  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
  if (failures) console.error('失败项：' + failures);
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  try { g1?.ws?.close(); } catch {}
  try { g2?.ws?.close(); } catch {}
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exitCode = failures ? 1 : 0;
}
