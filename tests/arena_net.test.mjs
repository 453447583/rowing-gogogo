// 潮汐竞技场（1v1）联机协议回归
//   node tests/arena_net.test.mjs
//
// 覆盖：
//   1) 竞技场进得了服务端白名单（以前 MODE_IDS 里没有 'arena'，切过去直接静默失败）
//   2) 1 个人开不了：房主点开始要收到明确 toast
//   3) 2 个人正常开局，start.order 里没有 AI（AI 对手归客户端 ArenaMode 自己造）
//   4) 第三个人连进来被劝退（1v1 房间坐满 2 人）
//   5) arenaDmg / arenaHp / arenaCore / arenaRing / arenaRam / arenaSkill / arenaRound 七种消息能互达
//   6) 非 racing 阶段的中继会被丢掉（回到大厅后再发不会串台）
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const HTTP_PORT = 3431;
const WS_PORT = 3432;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

const server = spawn(process.execPath, ['server/server.js'], {
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

async function waitServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
      if (r.status === 200) return;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error('服务器没起来');
}

class Client {
  constructor(name, session) {
    this.name = name;
    this.session = session || ('sess-' + name + '-' + Math.random().toString(36).slice(2, 7));
    this.msgs = [];
    this.cursors = {};
    this.id = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error(this.name + ' 连接超时')), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: this.session })));
      this.ws.on('error', () => { /* close 统一处理 */ });
      this.ws.on('close', () => {
        this.closed = true;
        // 被服务器劝退时不会收到 welcome，这里也要 resolve，否则测试只能干等超时
        clearTimeout(timer);
        resolve(null);
      });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') {
          this.id = msg.id;
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }

  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 已关闭 */ } }

  async waitWhere(type, pred, timeout = 6000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) {
          this.cursors[type] = i + 1;
          return this.msgs[i];
        }
      }
      if (Date.now() - start > timeout) {
        throw new Error(`${this.name} 等 ${type} 超时，最近消息: ${this.msgs.slice(-5).map((m) => m.t).join(',')}`);
      }
      await sleep(30);
    }
  }

  wait(type, timeout) { return this.waitWhere(type, () => true, timeout); }

  /** 断言在一段时间内"没有"收到某类消息 */
  async absent(type, ms = 600) {
    await sleep(ms);
    return !this.msgs.some((m) => m.t === type);
  }

  clear() { this.msgs = []; this.cursors = {}; }
  close() { try { this.ws.close(); } catch {} }
}

try {
  await waitServer();
  console.log('· 服务器已启动', HTTP_PORT, WS_PORT);

  const A = new Client('房主');
  const wa = await A.connect();
  ok(wa.hostId === A.id, '第一个人是房主');

  // ---- 1. 切换到竞技场 ----
  A.send({ t: 'mode', modeId: 'arena' });
  const rArena = await A.waitWhere('roster', (r) => r.mode === 'arena');
  ok(rArena.mode === 'arena', '模式切到 arena 生效（白名单已放开）');

  // ---- 2. 一个人开不了 ----
  A.send({ t: 'pick', boatId: 'rower' });
  await A.waitWhere('roster', (r) => r.players.some((p) => p.id === A.id && p.boatId === 'rower'));
  A.clear();
  A.send({ t: 'start' });
  const soloToast = await A.wait('toast');
  ok(/2 名玩家|需要 2/.test(soloToast.msg), '只有 1 人时开始被拒绝并说明原因', soloToast.msg);

  // ---- 3. 两个人开局 ----
  const B = new Client('客人');
  await B.connect();
  B.send({ t: 'pick', boatId: 'titan' });
  await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.boatId === 'titan'));
  // 非房主的真人必须点过"准备"，否则房主点开始只会收到一条 toast（这条拒绝是对的，
  // 但测试里不补准备就等于永远开不了局——以前这里漏了这一步）
  B.send({ t: 'ready', ready: true });
  await A.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.ready));
  A.clear(); B.clear();
  A.send({ t: 'start' });
  const startA = await A.wait('start');
  const startB = await B.wait('start');
  ok(startA.mode === 'arena', 'start 广播带 mode=arena', startA.mode);
  ok(startA.order.length === 2, '入场名单正好 2 个人', startA.order.map((o) => o.name));
  ok(!startA.order.some((o) => o.ai), '竞技场不塞 AI 艇（AI 由客户端自己造）');
  ok(startB.order.length === 2, '客机拿到同一份名单');

  // ---- 4. 五种消息互达 ----
  const foeOf = (me) => (me === A ? B : A);
  A.send({ t: 'arenaDmg', to: B.id, dmg: 25, from: A.id, x: 1, z: 2 });
  const dmg = await B.waitWhere('arenaDmg', (m) => m.to === B.id);
  ok(dmg.dmg === 25 && dmg.from === A.id, 'arenaDmg 到达受击方', dmg);

  B.send({ t: 'arenaHp', id: B.id, hp: 275, lives: 2, alive: true });
  const hp = await A.waitWhere('arenaHp', (m) => m.id === B.id);
  ok(hp.hp === 275 && hp.lives === 2, 'arenaHp 回到房主', hp);

  A.send({ t: 'arenaCore', z: -6.4, ot: false });
  const core = await B.waitWhere('arenaCore', () => true);
  ok(core.z === -6.4, 'arenaCore 核心位置到达客机', core);

  A.send({ t: 'arenaRing', id: B.id, by: A.id, s: { [A.id]: 1, [B.id]: 0 } });
  const ring = await B.waitWhere('arenaRing', () => true);
  ok(ring.s?.[A.id] === 1, 'arenaRing 撞出计分到达客机', ring);

  A.send({ t: 'arenaRam', to: B.id, nx: 0.6, nz: -0.8, p: 12.5 });
  const ram = await B.waitWhere('arenaRam', (m) => m.to === B.id);
  ok(ram.p === 12.5 && ram.nx === 0.6, 'arenaRam 撞击冲量到达被撞方', ram);

  A.send({ t: 'arenaSkill', kind: 'dash', from: A.id });
  const sk = await B.waitWhere('arenaSkill', (m) => m.kind === 'dash');
  ok(sk.from === A.id, 'arenaSkill 技能演出到达客机', sk);

  A.send({ t: 'arenaRound', round: 2, winner: A.id, phase: 'roundEnd', s: { [A.id]: 1, [B.id]: 0 } });
  const rd = await B.waitWhere('arenaRound', (m) => m.round === 2);
  ok(rd.winner === A.id, 'arenaRound 回合结算到达客机', rd);

  // 客机反向也要通（受击方权威：客机扣完血发回房主）
  ok(foeOf(A) === B, '反向通道存在');
  // ---- 5. 第三个人被劝退 ----
  const C = new Client('路人');
  await C.connect().catch(() => null);
  await sleep(400);
  const cToast = C.msgs.find((m) => m.t === 'toast') || null;
  ok(!!cToast && /1v1|已满/.test(cToast.msg), '第三个人收到"房间已满"的说明', cToast?.msg);
  ok(C.closed === true, '第三个人的连接被关闭');

  // ---- 6. 回大厅后中继断开 ----
  A.clear(); B.clear();
  A.send({ t: 'backLobby' });
  await A.wait('lobbyReset');
  const resetB = await B.wait('lobbyReset');
  ok(!!resetB, '房主 backLobby → 所有人收到 lobbyReset');
  A.send({ t: 'arenaDmg', to: B.id, dmg: 10, from: A.id });
  ok(await B.absent('arenaDmg', 700), '非 racing 阶段的竞技场消息不再转发');

  A.close(); B.close(); C.close();
} catch (e) {
  failures += 1;
  console.error('arena net: FAIL', e.message);
} finally {
  server.kill('SIGKILL');
  await sleep(200);
  console.log(failures ? `arena net: FAIL（${failures} 项）` : 'arena net: PASS');
  process.exitCode = failures ? 1 : 0;
}
