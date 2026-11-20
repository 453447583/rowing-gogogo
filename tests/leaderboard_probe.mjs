// 联机排行榜验收：node tests/leaderboard_probe.mjs
// 覆盖：
//   L1 竞速记账：AI / 未完赛被排除，同名只留最好一条，榜单按用时升序
//   L2 怪物经典：只有四关全通才记总时长，并且按关卡各记一条单关成绩
//   L3 海克斯：按通过关卡数优先、总用时其次；失败也记
//   L4 持久化：重启（重新 load）后成绩还在
//   L5 服务器链路：真人跑完一局 → lbGet 能读到这条竞速成绩
//   L6 服务器链路：房主上报怪物成绩 → 落地为 bt:1 / bs:1:2
//   L7 鉴权：非房主上报被忽略（不新增记录）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createLeaderboard } from '../server/leaderboard.js';
import { better } from '../server/lb-store.js';
import { MAPS } from '../src/data/maps.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, '.tmp_build');
fs.mkdirSync(TMP, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

/** 模拟 MySQL 那种"内存只是缓存、真数据在库里"的存储，用来验异步写入/刷新链路 */
function createMemoryStore() {
  const data = new Map();
  const bucket = (key) => {
    if (!data.has(key)) data.set(key, new Map());
    return data.get(key);
  };
  return {
    kind: 'mem',
    async init() { return {}; },
    attach() {},
    async readAll() {
      const out = {};
      for (const [k, m] of data) out[k] = [...m.values()];
      return out;
    },
    seed(key, entry) {
      bucket(key).set(entry.n, {
        a: '', b: '', c: 0, bl: null, at: Date.now(), ...entry,
      });
    },
    async write(key, entry, kind) {
      const m = bucket(key);
      const cur = m.get(entry.n);
      if (!cur || better(entry, cur, kind)) m.set(entry.n, { ...entry });
    },
    async flush() {},
  };
}

// ---------- L1~L4：模块级 ----------
async function unitChecks() {
  const file = path.join(TMP, 'lb_unit.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行没有旧文件 */ }
  const lb = await createLeaderboard({ file });

  lb.recordRace({
    mapId: 'canyon',
    laps: 1,
    results: [
      { name: '快船', boatId: 'falcon', avatar: '', time: 61.2, bestLap: 61.2, ai: false, dnf: false },
      { name: '慢船', boatId: 'titan', avatar: '', time: 75.8, bestLap: 75.8, ai: false, dnf: false },
      { name: '电脑1', boatId: 'rower', avatar: '', time: 50.1, bestLap: 50.1, ai: true, dnf: false },
      { name: '弃赛', boatId: 'skiff', avatar: '', time: null, bestLap: null, ai: false, dnf: true },
    ],
  });
  let snap = lb.snapshot('快船');
  let list = snap.boards['r:canyon:1'] || [];
  ok(list.length === 2, 'L1 AI 与未完赛不进榜（只剩 2 条真人成绩）', list.map((e) => e.n));
  ok(list[0]?.n === '快船' && list[1]?.n === '慢船', 'L1 按用时升序', list.map((e) => [e.n, e.t]));
  ok(snap.mine['r:canyon:1']?.t === 61.2, 'L1 snapshot 带出自己的最好成绩');

  // 同名再跑：更快就替换，更慢就忽略
  lb.recordRace({ mapId: 'canyon', laps: 1, results: [{ name: '快船', boatId: 'falcon', time: 58.4, bestLap: 58.4 }] });
  lb.recordRace({ mapId: 'canyon', laps: 1, results: [{ name: '快船', boatId: 'falcon', time: 70.1, bestLap: 70.1 }] });
  snap = lb.snapshot('快船');
  list = snap.boards['r:canyon:1'];
  ok(list.filter((e) => e.n === '快船').length === 1 && list[0].t === 58.4,
    'L1 同名只留最好一条（58.4，70.1 被忽略）', list.map((e) => [e.n, e.t]));

  // 不同圈数是不同的榜
  lb.recordRace({ mapId: 'canyon', laps: 3, results: [{ name: '快船', boatId: 'falcon', time: 180.0 }] });
  snap = lb.snapshot('快船');
  ok(!!snap.boards['r:canyon:3'] && snap.boards['r:canyon:1'].length === 2,
    'L1 1 圈 / 3 圈分成两张榜');

  // L2 经典：没通关不记；通关记总时长 + 每关
  lb.recordBoss({
    variant: 'classic', humans: 2, victory: false, totalTime: 120,
    stages: [{ stage: 1, elapsed: 40 }], player: { name: '半途', boatId: 'falcon' },
  });
  snap = lb.snapshot('半途');
  ok(!snap.boards['bt:2'], 'L2 经典闯关：没打到第四关不进总时长榜');

  lb.recordBoss({
    variant: 'classic', humans: 2, victory: true, totalTime: 300,
    stages: [{ stage: 1, elapsed: 60 }, { stage: 2, elapsed: 80 }, { stage: 3, elapsed: 90 }, { stage: 4, elapsed: 70 }],
    player: { name: '四人队', boatId: 'titan' },
  });
  snap = lb.snapshot('四人队');
  ok(snap.boards['bt:2']?.[0]?.t === 300, 'L2 通关总时长进 bt:2');
  ok(snap.boards['bs:2:2']?.[0]?.t === 80, 'L2 单关最快进 bs:2:2（第二关 80s）');
  ok(!snap.boards['bt:3'], 'L2 人数分桶：3 人榜不受影响');

  // L3 海克斯：关卡数优先，同关卡比用时
  lb.recordBoss({
    variant: 'hex', humans: 2, victory: false, cleared: 2,
    stages: [{ stage: 1, elapsed: 50 }, { stage: 2, elapsed: 60 }],
    player: { name: '海克斯A', boatId: 'falcon' },
  });
  lb.recordBoss({
    variant: 'hex', humans: 2, victory: false, cleared: 2,
    stages: [{ stage: 1, elapsed: 40 }, { stage: 2, elapsed: 40 }],
    player: { name: '海克斯B', boatId: 'falcon' },
  });
  lb.recordBoss({
    variant: 'hex', humans: 2, victory: true, cleared: 4,
    stages: [{ stage: 1, elapsed: 30 }, { stage: 2, elapsed: 30 }, { stage: 3, elapsed: 30 }, { stage: 4, elapsed: 30 }],
    player: { name: '海克斯C', boatId: 'falcon' },
  });
  snap = lb.snapshot('海克斯A');
  const hex = snap.boards['hx:2'] || [];
  ok(hex.map((e) => e.n).join(',') === '海克斯C,海克斯B,海克斯A',
    'L3 先比通过关卡，再比总用时', hex.map((e) => [e.n, e.c, e.t]));

  // L4a 异步存储链路（MySQL 走的就是这条：内存是缓存，真数据在库里）
  const mem = createMemoryStore();
  const lbm = await createLeaderboard({ store: mem });
  lbm.recordRace({ mapId: 'lake', laps: 3, results: [{ name: '云玩家', boatId: 'falcon', time: 90.1 }] });
  await lbm.refresh(true);
  ok(lbm.snapshot('云玩家').boards['r:lake:3']?.[0]?.n === '云玩家',
    'L4a 异步存储：写入后 refresh 能从存储读回');

  mem.seed('r:lake:3', { n: '云玩家', t: 80.0 });
  await lbm.refresh(true);
  lbm.recordRace({ mapId: 'lake', laps: 3, results: [{ name: '云玩家', boatId: 'falcon', time: 95.0 }] });
  await lbm.refresh(true);
  ok(lbm.snapshot('云玩家').boards['r:lake:3'][0].t === 80.0,
    'L4a 异步存储：更慢的重复成绩不会覆盖库里更好的那条');

  // L4b 持久化（2 秒合并写，测试里手动 flush 再重新加载）
  await lb.flush();
  const lb2 = await createLeaderboard({ file });
  const snap2 = lb2.snapshot('快船');
  ok(snap2.boards['r:canyon:1']?.length === 2 && snap2.boards['bt:2']?.[0]?.t === 300,
    'L4 重新 load 后成绩还在（文件持久化）');
  try { fs.unlinkSync(file); } catch { /* 忽略 */ }
}

// ---------- L5~L7：服务器链路 ----------
class Client {
  constructor(name, session) {
    this.name = name;
    this.session = session || `sess-${name}-${Math.random().toString(36).slice(2, 8)}`;
    this.msgs = [];
    this.id = null;
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({
        t: 'hello', name: this.name, session: this.session,
      })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        if (msg.t === 'welcome') {
          this.id = msg.id;
          clearTimeout(timer);
          resolve(msg);
        }
        this.msgs.push(msg);
      });
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }

  /** 等某类消息（从后往前找，忽略连接前收到的） */
  async wait(type, ms = 15000, pred = () => true) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const hit = [...this.msgs].reverse().find((m) => m.t === type && pred(m));
      if (hit) return hit;
      await sleep(60);
    }
    return null;
  }

  clear() { this.msgs = []; }
  close() { try { this.ws.close(); } catch { /* 已断 */ } }
}

async function serverChecks() {
  const HTTP_PORT = 3431;
  const WS_PORT = 3432;
  const file = path.join(TMP, 'lb_server.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }

  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT), LEADERBOARD_FILE: file },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const errs = [];
  server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) errs.push(s); });

  const waitServer = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
        if (r.status === 200) return;
      } catch { /* 还没起来 */ }
      await sleep(200);
    }
    throw new Error('服务器没起来');
  };

  try {
    await waitServer();
    const host = new Client('房主');
    await host.connect(WS_PORT);

    // ---- L5 竞速：单人个人赛跑完一圈 ----
    host.send({ t: 'pick', boatId: 'falcon' });
    await sleep(150);
    host.send({ t: 'mode', modeId: 'race' });
    host.send({ t: 'settings', settings: { laps: 1, aiCount: 0 } });
    await sleep(150);
    host.clear();
    host.send({ t: 'start' });
    const start = await host.wait('start', 6000);
    ok(!!start, 'L5 单人能开赛（拿到 start）');
    const N = MAPS.find((m) => m.id === (start?.mapId || 'canyon'))?.gates.length || 24;
    for (let g = 0; g <= N - 1; g++) {
      host.send({ t: 'gate', id: host.id, gate: g, lap: 1 });
      await sleep(10);
    }
    host.send({ t: 'gate', id: host.id, gate: 0, lap: 2, totalTime: 66.6, lapTime: 66.6, finish: true });
    // 结算窗口固定 10 秒（checkRoundEnd）
    const end = await host.wait('raceEnd', 15000);
    ok(!!end, 'L5 冲线后 10 秒窗口结束 → raceEnd');

    host.send({ t: 'lbGet' });
    let lb = await host.wait('lb', 5000);
    ok(!!lb, 'L5 lbGet 有回包');
    const raceKey = `r:${start?.mapId || 'canyon'}:1`;
    ok(lb?.boards?.[raceKey]?.[0]?.n === '房主' && Math.abs(lb.boards[raceKey][0].t - 66.6) < 0.05,
      'L5 服务器把这条竞速成绩记进了对应地图 × 1 圈', lb?.boards?.[raceKey]);

    // ---- L6 怪物：房主上报四关全通 ----
    host.clear();
    host.send({ t: 'mode', modeId: 'boss' });
    host.send({ t: 'settings', settings: { variant: 'classic' } });
    await sleep(150);
    host.send({ t: 'pick', boatId: 'falcon' });
    await sleep(150);
    host.send({ t: 'start' });
    const bossStart = await host.wait('start', 6000);
    ok(!!bossStart, 'L6 怪物模式能开赛');
    host.send({
      t: 'lbSubmit', variant: 'classic', victory: true, totalTime: 240,
      cleared: 4,
      stages: [{ stage: 1, elapsed: 50 }, { stage: 2, elapsed: 60 }, { stage: 3, elapsed: 70 }, { stage: 4, elapsed: 60 }],
    });
    await sleep(300);
    host.clear();
    host.send({ t: 'lbGet' });
    lb = await host.wait('lb', 5000);
    ok(lb?.boards?.['bt:1']?.[0]?.n === '房主' && lb.boards['bt:1'][0].t === 240,
      'L6 房主上报 → 通关总时长落到 bt:1', lb?.boards?.['bt:1']);
    ok(lb?.boards?.['bs:1:2']?.[0]?.t === 60, 'L6 单关成绩落到 bs:1:2');

    // ---- L7 鉴权：客机上报被忽略 ----
    const guest = new Client('客机');
    await guest.connect(WS_PORT);
    guest.clear();
    guest.send({
      t: 'lbSubmit', variant: 'classic', victory: true, totalTime: 1,
      cleared: 4, stages: [{ stage: 1, elapsed: 1 }],
    });
    await sleep(300);
    guest.send({ t: 'lbGet' });
    const guestLb = await guest.wait('lb', 5000);
    ok(guestLb?.boards?.['bt:1']?.every((e) => e.n !== '客机'),
      'L7 非房主上报被丢弃（榜单里没有客机）', guestLb?.boards?.['bt:1']?.map((e) => e.n));

    guest.close();
    host.close();
    ok(errs.length === 0, '服务器没有报错输出', errs.slice(0, 3));
  } finally {
    server.kill();
    await sleep(300);
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

console.log('leaderboard checks:');
await unitChecks();
await serverChecks();
if (failures) {
  console.error(`\n${failures} 项未通过`);
  process.exit(1);
}
console.log('\nall leaderboard checks PASS');
