// 积分钱包验收：node tests/wallet_probe.mjs
//   W1 老 v1 排行榜文件升级到 v2 后补空 players，原榜单不动
//   W2 op.id 幂等：重复结算不重复加分；每日上限 300
//   W3 兑换 / 装备 / 幸运券扣减走服务器校验
//   W4 服务器按 uid 发奖：同名不同 uid 不串分，重连 / 改名不丢
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createStore, createRemoteStore } from '../server/lb-store.js';
import { createWallet } from '../server/wallet.js';
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

async function unitChecks() {
  const file = path.join(TMP, 'wallet_unit.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }
  fs.writeFileSync(file, JSON.stringify({
    v: 1,
    boards: { 'r:canyon:1': [{ n: '老玩家', t: 66.6, at: 1 }] },
  }));

  const store = await createStore({ file });
  const db = await store.init();
  store.attach?.(db.boards || {}, db.players || {});
  ok(!!db.boards['r:canyon:1'] && Object.keys(db.players || {}).length === 0,
    'W1 v1 文件迁移：boards 保留，players 补空');

  const wallet = createWallet({ store, db });
  const uid = 'u_unitplayer01';
  const op = { id: 'run-001', uid, kind: 'grant', d: 120, mode: 'race', n: '甲' };
  ok(wallet.apply(op).ok && wallet.snapshot(uid).pts === 120, 'W2 发奖 120 分到账');
  ok(wallet.apply(op).duplicate === true && wallet.snapshot(uid).pts === 120,
    'W2 同一 op.id 重放不加分（幂等）');

  for (let i = 0; i < 4; i++) {
    wallet.apply({ id: `run-00${i + 2}`, uid, kind: 'grant', d: 100, mode: 'race' });
  }
  ok(wallet.snapshot(uid).pts === 300, 'W2 每日上限 300 分截断', wallet.snapshot(uid).pts);
  ok(wallet.apply({ id: 'run-999', uid, kind: 'grant', d: 50, mode: 'race' }).reason === 'daily-limit',
    'W2 到上限后继续发奖被拒');

  // 另开一个钱包实例模拟服务器重启：重新读文件，余额不能丢
  await store.flush();
  const store2 = await createStore({ file });
  const db2 = await store2.init();
  const wallet2 = createWallet({ store: store2, db: db2 });
  ok(wallet2.snapshot(uid).pts === 300, 'W2 重启后余额还在（同一 JSON 文件）');

  // 兑换：单笔发奖有上限，测试里直接改缓存里的余额（生产路径永远走 grant）
  const uid2 = 'u_shopplayer01';
  wallet2.apply({ id: 'seed-0', uid: uid2, kind: 'grant', d: 10, mode: 'race' });
  wallet2.raw()[uid2].pts = 1000;
  ok(wallet2.apply({ id: 'buy-1', uid: uid2, kind: 'buy', item: 'hex_ticket' }).ok
    && wallet2.snapshot(uid2).pts === 400 && wallet2.snapshot(uid2).inv.hex_ticket === 1,
  'W3 兑换幸运券：扣分 600，背包 +1', wallet2.snapshot(uid2));
  ok(wallet2.apply({ id: 'use-1', uid: uid2, kind: 'useTicket' }).ok
    && !wallet2.snapshot(uid2).inv.hex_ticket,
  'W3 使用幸运券：背包扣 1');
  ok(wallet2.apply({ id: 'use-2', uid: uid2, kind: 'useTicket' }).reason === 'no-ticket',
    'W3 没有券时拒绝使用');
  wallet2.raw()[uid2].pts = 1000;
  wallet2.apply({ id: 'buy-2', uid: uid2, kind: 'buy', item: 'frame_bronze' });
  ok(wallet2.apply({ id: 'equip-1', uid: uid2, kind: 'equip', item: 'frame_bronze', slot: 'frame' }).ok
    && wallet2.snapshot(uid2).equip.frame === 'frame_bronze',
  'W3 装备头像框：只认自己背包里的物品');

  await store2.flush();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(raw.v >= 2 && !!raw.boards['r:canyon:1'] && !!raw.players[uid2],
    'W1 落盘是 {v:2+, boards, players, accounts}，老榜单没被覆盖');
  try { fs.unlinkSync(file); } catch { /* 忽略 */ }
}

async function bridgeChecks() {
  // 家里那台开 /lb-api/*，线上 remote 实例只推 op、不推余额。
  // 两台机器同时加分时靠 op.id 幂等 + 家里时钟覆盖本地 optimistic 版本。
  const HTTP_PORT = 3443;
  const WS_PORT = 3444;
  const file = path.join(TMP, 'wallet_bridge.json');
  const token = 'wallet-bridge-token';
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
      LEADERBOARD_FILE: file, LEADERBOARD_TOKEN: token,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const errs = [];
  server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) errs.push(s); });
  const get = async () => {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/lb-api/boards?since=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return r.json();
  };
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.status === 200) break; } catch { /* 还没起来 */ }
      await sleep(200);
    }
    const store = createRemoteStore({
      url: `http://127.0.0.1:${HTTP_PORT}`, token,
    });
    await store.init();
    const wallet = createWallet({ store, db: { boards: {}, players: {} } });
    const uid = 'u_bridgeplayer01';
    const op = { id: 'bridge:race:001', uid, kind: 'grant', d: 90, mode: 'race', n: '桥接玩家' };
    ok(wallet.apply(op, { localOnly: true }).ok, 'W5 线上实例先本地 optimistic 入账');
    ok(wallet.snapshot(uid).at === 0, 'W5 optimistic 版本 at=0，等家里权威快照覆盖');
    await store.flush();
    const home1 = await get();
    ok(home1?.players?.[uid]?.pts === 90 && (home1.players[uid].at || 0) > 0,
      'W5 walletOp 经桥接写进家里 JSON，时间戳由家里重盖', home1?.players?.[uid]);

    // 同一 op 再推一次（隧道重发 / 两台机器撞车）：家里不能重复加分
    store.writePlayer(uid, wallet.get(uid), op);
    await store.flush();
    const home2 = await get();
    ok(home2?.players?.[uid]?.pts === 90, 'W5 同一 op 重放不重复加分（线上 / 局域网不串）');

    await wallet.refresh(true);
    ok(wallet.snapshot(uid).pts === 90 && wallet.snapshot(uid).at > 0,
      'W5 线上实例拉回家里快照，覆盖本地 0 时间戳', wallet.snapshot(uid));
    ok(errs.length === 0, '桥接过程中服务器没有报错输出', errs.slice(0, 3));
  } finally {
    server.kill();
    await sleep(300);
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

class Client {
  constructor(name, uid) {
    this.name = name;
    this.uid = uid;
    this.session = `s-${uid}-${Date.now()}`;
    this.msgs = [];
    this.id = null;
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({
        t: 'hello', name: this.name, session: this.session, uid: this.uid,
      })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
        this.msgs.push(msg);
      });
    });
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); }
  async wait(type, ms = 12000, pred = () => true) {
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
  const HTTP_PORT = 3441;
  const WS_PORT = 3442;
  const file = path.join(TMP, 'wallet_server.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT), LEADERBOARD_FILE: file },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const errs = [];
  server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) errs.push(s); });
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.status === 200) break; } catch { /* 还没起来 */ }
      await sleep(200);
    }
    // 同名不同 uid：验证积分不按名字串
    const a = new Client('同名', 'u_serverhost01');
    const b = new Client('同名', 'u_serverguest1');
    await a.connect(WS_PORT);
    await b.connect(WS_PORT);
    a.send({ t: 'pick', boatId: 'falcon' });
    b.send({ t: 'pick', boatId: 'titan' });
    await sleep(150);
    a.send({ t: 'mode', modeId: 'race' });
    a.send({ t: 'settings', settings: { laps: 1, aiCount: 0 } });
    b.send({ t: 'ready', ready: true });
    await sleep(150);
    a.clear(); b.clear();
    a.send({ t: 'start' });
    const start = await a.wait('start', 6000);
    ok(!!start, 'W4 服务端能开赛');
    const N = MAPS.find((m) => m.id === (start?.mapId || 'canyon'))?.gates.length || 24;
    for (const c of [a, b]) {
      for (let g = 0; g <= N - 1; g++) c.send({ t: 'gate', id: c.id, gate: g, lap: 1 });
    }
    for (const c of [a, b]) c.send({ t: 'gate', id: c.id, gate: 0, lap: 2, totalTime: 66.6, finish: true });
    ok(!!(await a.wait('raceEnd', 16000)), 'W4 结算完成');

    a.clear(); b.clear();
    a.send({ t: 'walletGet' });
    b.send({ t: 'walletGet' });
    const wa = await a.wait('wallet', 5000);
    const wb = await b.wait('wallet', 5000);
    ok(wa?.uid === 'u_serverhost01' && wa.pts === 120, 'W4 第 1 名按 uid 拿到 120 积分', wa);
    ok(wb?.uid === 'u_serverguest1' && wb.pts === 80, 'W4 第 2 名同名不同 uid 拿 80，不串分', wb);

    // 改名 + 新 session 重连：uid 不变，积分还在
    a.session = `s-new-${Date.now()}`;
    a.close();
    const a2 = new Client('改名了', 'u_serverhost01');
    a2.session = a.session;
    await a2.connect(WS_PORT);
    a2.clear();
    a2.send({ t: 'walletGet' });
    const wa2 = await a2.wait('wallet', 5000);
    ok(wa2?.pts === 120, 'W4 改名 / 重连后 uid 不变，积分还在', wa2);

    b.close();
    a2.close();
    ok(errs.length === 0, '服务器没有报错输出', errs.slice(0, 3));
  } finally {
    server.kill();
    await sleep(300);
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

console.log('wallet checks:');
await unitChecks();
await bridgeChecks();
await serverChecks();
if (failures) {
  console.error(`\n${failures} 项未通过`);
  process.exit(1);
}
console.log('\nall wallet checks PASS');
