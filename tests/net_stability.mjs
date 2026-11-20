// 联机稳定性验收（纯 WebSocket，不开浏览器，秒级跑完）
//
//   node tests/net_stability.mjs
//
// 覆盖的是"协议层会不会把玩家坑死"这一类问题，不开渲染：
//   ① 中继白名单：怪物模式 / 竞技场用到的每一条广播都必须真的被转发
//      —— 少一条的表现就是"客机看不到传送门 / 永远卡在结算页"这种玄学故障
//   ② 比赛进行中新来的人：不能把别人的局拆了，也不能顶替参赛座位
//   ③ 断线重连：15s 座位缓冲内回来，id / 房主身份 / 选艇都要还在
//   ④ 僵尸局自愈：全员退出比赛后房间要能回到大厅，不能永远停在 racing
//   ⑤ 4 人同时推快照：丢包率、端到端延迟、抖动是否可接受
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HTTP_PORT = Number(process.env.PORT) || 3561;
const WS_PORT = Number(process.env.WS_PORT) || 3562;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else {
    failures += 1;
    console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra));
  }
};

// ---------- ① 必须先确认"该转发的一条都不许漏" ----------
// 这份清单是**玩法依赖**，不是从实现里抄的：写测试的人按玩法列，
// 实现里少了哪条，这里就会红。
const REQUIRED_RELAY = [
  // 怪物模式：状态与推进
  'bossState', 'bossHit', 'bossSummon', 'bossStage', 'bossEnd', 'bossCast', 'bossStagger',
  // 双人配合
  'bossDown', 'bossRescue', 'bossComboState', 'bossComboArm', 'bossComboFire',
  // 技能演出 / 环境机关
  'bossSkill', 'bossThunder', 'bossVortex', 'bossPillar', 'bossLava', 'bossLure',
  // 血包 / 火力核心
  'healPack', 'healSpawn', 'fireCoreSpawn', 'fireCore',
  // 第二关四核波次
  'bossCoreWave', 'bossCoreHit', 'bossCoreWin', 'bossCoreWaveEnd',
  // 第四关血祭祭坛
  'bossAltarSpawn', 'bossAltarDone',
  // 过关传送门：漏了 = 客机永远看不到门 / 房主永远凑不齐 ready
  'bossPortal', 'bossReady',
  // 潮汐竞技场
  'arenaDmg', 'arenaHp', 'arenaRound', 'arenaSkill', 'arenaEnd',
  'arenaCore', 'arenaRing', 'arenaRam',
  // 道具模式（老功能，别在新改动里被顺手删掉）
  'itemPick', 'itemUse', 'itemHit', 'itemFx', 'lightning',
];

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.cursors = {};
    this.pings = new Map();
    this.rtts = [];
  }
  connect(session = '') {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error(this.name + ' 连接超时')), 6000);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: session || this.name }));
      });
      this.ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') {
          const sent = this.pings.get(msg.ts);
          if (sent) { this.rtts.push(Date.now() - sent); this.pings.delete(msg.ts); }
          return;
        }
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 已关 */ } }
  ping() {
    const ts = this.name + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    this.pings.set(ts, Date.now());
    this.send({ t: 'ping', ts });
  }
  async waitWhere(type, pred = () => true, timeout = 8000) {
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
      await sleep(20);
    }
  }
  wait(type, timeout) { return this.waitWhere(type, () => true, timeout); }
  has(type, pred = () => true) { return this.msgs.some((m) => m.t === type && pred(m)); }
  clear() { this.msgs = []; this.cursors = {}; }
  close() { try { this.ws.close(); } catch { /* 已关 */ } }
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const serverErr = [];
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) serverErr.push(s); });

const all = [];
try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }

  // ---------- ① 中继白名单 ----------
  const src = await fs.readFile(path.join(ROOT, 'server/server.js'), 'utf8');
  const block = src.slice(src.indexOf('const RELAY_TYPES = new Set(['));
  const body = block.slice(0, block.indexOf(']);'));
  const declared = new Set([...body.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  const missing = REQUIRED_RELAY.filter((t) => !declared.has(t));
  ok(missing.length === 0, `RELAY_TYPES 覆盖全部玩法消息（共 ${REQUIRED_RELAY.length} 条）`, missing);

  // 真正开一局，然后逐条打过去看有没有被吞
  const host = new Client('房主');
  all.push(host);
  await host.connect();
  host.send({ t: 'pick', boatId: 'titan' });
  host.send({ t: 'mode', modeId: 'boss' });
  const rosterPicked = await host.waitWhere('roster', (r) => r.players.some((p) => p.boatId === 'titan'));
  const hostBoatBefore = rosterPicked.players.find((p) => p.id === host.id)?.boatId;
  await host.waitWhere('roster', (r) => r.mode === 'boss');

  const guest = new Client('客人');
  all.push(guest);
  await guest.connect();
  guest.send({ t: 'pick', boatId: 'cow' });
  guest.send({ t: 'ready', ready: true });
  await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客人' && p.ready));

  host.clear(); guest.clear();
  host.send({ t: 'start' });
  const startMsg = await guest.wait('start', 8000);
  ok(startMsg.mode === 'boss' && startMsg.order.length === 2, '怪物模式 2 人开局', {
    mode: startMsg.mode, order: startMsg.order.map((o) => o.name),
  });

  // 客人 → 房主
  const lostToHost = [];
  for (const t of REQUIRED_RELAY) {
    host.clear();
    guest.send({ t, probe: t });
    const got = await host.waitWhere(t, (m) => m.probe === t, 2500).catch(() => null);
    if (!got) lostToHost.push(t);
  }
  ok(lostToHost.length === 0, '客人 → 房主：全部消息都能到达', lostToHost);

  // 房主 → 客人
  const lostToGuest = [];
  for (const t of REQUIRED_RELAY) {
    guest.clear();
    host.send({ t, probe: t });
    const got = await guest.waitWhere(t, (m) => m.probe === t, 2500).catch(() => null);
    if (!got) lostToGuest.push(t);
  }
  ok(lostToGuest.length === 0, '房主 → 客人：全部消息都能到达', lostToGuest);

  // ---------- ② 比赛进行中新来的人 ----------
  host.clear(); guest.clear();
  const late = new Client('迟到者');
  all.push(late);
  const lateWelcome = await late.connect();
  ok(lateWelcome.phase === 'racing', '迟到的玩家拿到的 welcome 明确写着"比赛进行中"', lateWelcome.phase);
  const lateMe = lateWelcome.players.find((p) => p.id === late.id);
  ok(!!lateMe && !lateMe.boatId, '迟到者没有参赛座位（boatId 为空）');
  await sleep(400);
  ok(!host.has('lobbyReset') && !guest.has('lobbyReset'), '迟到者进来没有把正在跑的局拆掉');
  host.clear();
  host.send({ t: 'start' });
  const busy = await host.wait('toast', 4000).catch(() => null);
  ok(!!busy && /正在进行中/.test(busy.msg), '比赛中的房间，房主再点开始会被明确拒绝', busy?.msg);
  // 迟到的玩家想抢参赛位：比赛进行中选艇必须被拒
  late.clear();
  late.send({ t: 'pick', boatId: 'skiff' });
  const latePicked = await late.waitWhere('pickResult', (m) => m.ok === false, 4000).catch(() => null);
  ok(!!latePicked, '比赛进行中选艇被明确否决（不会半路插进别人那局）');

  // ---------- ③ 断线重连：15s 座位缓冲（在比赛里断，座位也不能丢）----------
  host.clear(); guest.clear();
  const hostIdBefore = host.id;
  ok(!!hostBoatBefore, '断线前房主有选艇记录', hostBoatBefore);
  host.close();
  await sleep(600);
  const again = new Client('房主');
  all.push(again);
  const resumed = await again.connect('房主');
  ok(resumed.resumed === true, '同一会话重连 → 服务器回 resumed:true', resumed.resumed);
  ok(resumed.id === hostIdBefore, '重连坐回原来的座位（id 不变）', { was: hostIdBefore, now: resumed.id });
  const rr = await again.waitWhere(
    'roster',
    (r) => r.players.some((p) => p.id === hostIdBefore && p.boatId === hostBoatBefore),
    6000,
  ).catch(() => null);
  ok(!!rr, '重连后选艇还留着（不用重新选一遍）');
  const hostStill = await guest.waitWhere('roster', (r) => r.hostId === hostIdBefore, 5000).catch(() => null);
  ok(!!hostStill, '房主身份没有因为断线抖一下就被换人');

  // ---------- ④ 僵尸局自愈 ----------
  guest.clear(); again.clear(); late.clear();
  guest.send({ t: 'inGame', on: false });
  again.send({ t: 'inGame', on: false });
  const back = await guest.wait('lobbyReset', 8000).catch(() => null);
  ok(!!back, '全员退出比赛后房间自动回到大厅（不会永远卡在 racing）');
  const rosterAfter = await guest.waitWhere('roster', (r) => r.phase === 'lobby', 6000).catch(() => null);
  ok(!!rosterAfter, 'roster 里的 phase 也变回 lobby');
  ok(!!rosterAfter && rosterAfter.players.every((p) => !p.boatId), '回大厅后所有选艇都被释放（不会有人被锁在上一局的艇上）');

  // ---------- ⑤ 4 人推快照：丢包 / 延迟 / 抖动 ----------
  // 就用房间里现有的 4 个真人（迟到者也算一个），不再多开客户端：
  // 多出来的第 5 人会被服务器判成"没选赛艇"，把整局的开始按钮堵死
  again.send({ t: 'mode', modeId: 'race' });
  await again.waitWhere('roster', (r) => r.mode === 'race', 6000);
  const slots = [
    [again, 'titan'],
    [guest, 'cow'],
    [late, 'skiff'],
    [new Client('P4'), 'falcon'],
  ];
  for (const [c, boatId] of slots) {
    if (!all.includes(c)) { all.push(c); await c.connect(); }
    c.send({ t: 'pick', boatId });
    if (c !== again) c.send({ t: 'ready', ready: true });
  }
  const round = slots.map(([c]) => c);
  await again.waitWhere('roster', (r) => r.players.filter((p) => !p.ai).length === 4, 8000).catch(() => null);
  round.forEach((c) => c.clear());
  again.send({ t: 'start' });
  for (const c of round) await c.wait('start', 8000);
  round.forEach((c) => { c.clear(); c.rtts.length = 0; c.pings.clear(); });
  const sendT0 = Date.now();
  let tick = 0;
  while (Date.now() - sendT0 < 6000) {
    tick += 1;
    for (const c of round) {
      c.send({ t: 'state', x: tick * 0.1, z: 0, h: 0, s: 12, b: false });
      c.ping();
    }
    await sleep(50); // 20Hz，和真实客户端的快照频率一致
  }
  const sendT1 = Date.now();
  await sleep(600);

  // 服务器不是把每条 state 原样转出去，而是凑成 33ms 一帧的 snap 广播
  // （见 server.js 的 SNAPSHOT_INTERVAL_MS）。所以这里数 snap，不是数 state。
  // 期望值按"真正在推快照的那段时间"算，不能把后面那 600ms 静默期也算进去，
  // 否则恒定少 18 帧，看起来像丢包其实只是口径错。
  const expectSnaps = Math.floor((sendT1 - sendT0) / 33);
  const counts = round.map((c) => c.msgs.filter((m) => m.t === 'snap').length);
  const spread = Math.max(...counts) - Math.min(...counts);
  const drops = [];
  round.forEach((c, i) => {
    const snaps = c.msgs.filter((m) => m.t === 'snap');
    const full = snaps.filter((m) => m.p.length === round.length).length;
    if (counts[i] / expectSnaps < 0.85 || full / Math.max(1, snaps.length) < 0.95) {
      drops.push({
        who: c.name, snaps: counts[i], expect: expectSnaps,
        rate: +(counts[i] / expectSnaps).toFixed(3), fullFrames: full,
      });
    }
  });
  ok(drops.length === 0, `${round.length} 人 × ${tick} 帧状态，快照中转没有丢包（${counts.join('/')}）`, drops);
  // 四个人收到的帧数必须几乎一样：只要有一端明显少，那就是"那一端的画面要卡"
  ok(spread <= 2, `4 端收到的帧数一致（极差 ${spread}），没有人被单独落下`, counts);

  // 位置真的传过去了：每个人看到的最后一条快照里，其他人都在最后那个 tick 附近
  const lastTickX = tick * 0.1;
  const stale = [];
  for (const c of round) {
    const snaps = c.msgs.filter((m) => m.t === 'snap');
    const last = snaps[snaps.length - 1];
    if (!last) { stale.push({ who: c.name, why: '没有快照' }); continue; }
    for (const entry of last.p) {
      const [id, x] = entry;
      if (id === c.id) continue;
      if (Math.abs(x - lastTickX) > 1.5) stale.push({ who: c.name, id, x, want: lastTickX });
    }
  }
  ok(stale.length === 0, '每个人的最新位置都同步到了其他人（画面不会定格）', stale.slice(0, 4));

  const rtts = round.flatMap((c) => c.rtts).sort((a, b) => a - b);
  const p50 = rtts[Math.floor(rtts.length * 0.5)] || 0;
  const p95 = rtts[Math.floor(rtts.length * 0.95)] || 0;
  const worst = rtts[rtts.length - 1] || 0;
  console.log(`  · 本机回环 RTT：p50=${p50}ms p95=${p95}ms max=${worst}ms（样本 ${rtts.length}）`);
  ok(p95 > 0 && p95 < 200, 'p95 延迟在可接受范围内（<200ms，本机回环）', { p50, p95, worst });

  const jitter = round.map((c) => {
    const r = c.rtts;
    let worstJ = 0;
    for (let i = 1; i < r.length; i++) worstJ = Math.max(worstJ, Math.abs(r[i] - r[i - 1]));
    return worstJ;
  });
  const maxJ = Math.max(...jitter, 0);
  ok(maxJ < 300, `帧间抖动可控（最大 ${maxJ}ms，偶尔一次 GC 属正常）`, jitter);

  if (serverErr.length) ok(false, '服务端无异常输出: ' + serverErr.slice(0, 2).join(' | '));
  else ok(true, '服务端全程无异常输出');
} catch (e) {
  failures += 1;
  console.error('联机稳定性验收异常:', e.message);
} finally {
  for (const c of all) c.close();
  server.kill('SIGKILL');
  await sleep(200);
  console.log(failures ? `\n联机稳定性验收：${failures} 项失败` : '\n联机稳定性验收：全部通过');
  process.exit(failures ? 1 : 0);
}
