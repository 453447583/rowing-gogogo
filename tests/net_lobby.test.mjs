// 联机大厅回归测试：验证"打完一局后能再开一局"和"上一局的选艇/AI 不会残留"
//   node tests/net_lobby.test.mjs
// 覆盖：
//   1) 选艇唯一制 + 抢同一艘艇的提示
//   2) 带 AI 打完一局 → raceEnd 后 AI 必须消失、所有人的选艇必须释放
//   3) 上一局 AI 用过的赛艇，这一局真人可以直接选（之前会提示"已被选择"）
//   4) 房主 backLobby → 所有人收到 lobbyReset，再开一局能拿到新的 raceSeq
//   5) 非房主点开始 → 收到明确的 toast（而不是静默没反应）
//   6) 同会话重连 → 服务器把原来的座位还回来（id 不变）
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { MAPS } from '../src/data/maps.js';

const HTTP_PORT = 3411;
const WS_PORT = 3412;
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
  for (let i = 0; i < 60; i++) {
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
    this.id = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error(this.name + ' 连接超时')), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: this.session })));
      this.ws.on('error', reject);
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

  send(m) { this.ws.send(JSON.stringify(m)); }

  /** 等一条指定类型的"还没读过"的消息 */
  async wait(type, timeout = 8000) { return this.waitWhere(type, () => true, timeout); }

  /** 等一条满足条件的新消息（名单类消息要按内容判断，别按到达顺序） */
  async waitWhere(type, pred, timeout = 8000) {
    this.cursors = this.cursors || {};
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
        throw new Error(`${this.name} 等 ${type} 超时，最近消息: ${this.msgs.slice(-4).map((m) => m.t).join(',')}`);
      }
      await sleep(30);
    }
  }

  boatOf(id) {
    const r = this.last('roster');
    return r?.players.find((p) => p.id === id)?.boatId ?? null;
  }

  clear() { this.msgs = []; this.cursors = {}; }
  last(type) { return [...this.msgs].reverse().find((m) => m.t === type); }
  close() { try { this.ws.close(); } catch {} }
}

function finishRace(c, mapId, laps) {
  const N = MAPS.find((m) => m.id === mapId).gates.length;
  for (let lap = 1; lap <= laps; lap++) {
    for (let g = 0; g < N; g++) c.send({ t: 'gate', id: c.id, gate: g, lap });
  }
  // 当前协议：冲线必须带 finish:true（只带 totalTime 会被当成过门消息丢掉）
  c.send({ t: 'gate', id: c.id, gate: 0, lap: laps + 1, totalTime: 62.5, finish: true });
}

try {
  await waitServer();
  console.log('· 服务器已启动', HTTP_PORT, WS_PORT);

  const A = new Client('房主');
  const B = new Client('客人');
  const wa = await A.connect();
  const wb = await B.connect();
  ok(wa.hostId === A.id, '第一个人是房主', wa.hostId);
  ok(wb.hostId === A.id, '第二个人看到同一个房主');

  // ---- 1. 选艇唯一制 ----
  A.send({ t: 'pick', boatId: 'rower' });
  await A.waitWhere('roster', (r) => r.players.some((p) => p.id === A.id && p.boatId === 'rower'));
  B.send({ t: 'pick', boatId: 'rower' });
  const toast = await B.wait('toast');
  ok(/已经|已被/.test(toast.msg), '抢同一艘赛艇会被拒绝并提示', toast.msg);
  B.send({ t: 'pick', boatId: 'titan' });
  const rPick = await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.boatId === 'titan'));
  ok(rPick.players.find((p) => p.id === B.id)?.boatId === 'titan', '换一艘就能选上');

  // ---- 2. 带一个 AI 开赛 ----
  A.send({ t: 'settings', settings: { laps: 1, aiCount: 1 } });
  await A.waitWhere('roster', (r) => r.settings.laps === 1 && r.settings.aiCount === 1);
  // 非房主必须准备：服务器现在会拦"有人没准备"，这是大厅流程的一部分
  B.send({ t: 'ready', ready: true });
  await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.ready === true));
  A.send({ t: 'start' });
  const start1 = await A.wait('start');
  await B.wait('start');
  const aiEntry = start1.order.find((o) => o.ai);
  ok(!!aiEntry, 'AI 已加入本局', start1.order.map((o) => o.name));
  ok(start1.laps === 1, '圈数设置生效', start1.laps);

  // ---- 3. 两个人跑完 → raceEnd ----
  finishRace(A, start1.mapId, start1.laps);
  finishRace(B, start1.mapId, start1.laps);
  const end1 = await A.wait('raceEnd', 20000);
  ok(end1.results.length >= 3, '结算里包含 AI', end1.results.map((r) => r.name));

  const rosterAfter = await A.waitWhere('roster', (r) => r.players.every((p) => !p.boatId), 5000);
  ok(!!rosterAfter, 'raceEnd 之后服务器补发了名单');
  ok(rosterAfter && !rosterAfter.players.some((p) => p.ai), 'AI 不会残留到大厅');
  ok(rosterAfter && rosterAfter.players.every((p) => !p.boatId), '上一局的选艇全部释放', rosterAfter?.players);

  // ---- 4. 上一局 AI 用过的赛艇，这一局真人可直接选 ----
  A.clear();
  A.send({ t: 'pick', boatId: aiEntry.boatId });
  const rAi = await A.waitWhere('roster', (r) => r.players.some((p) => p.id === A.id && p.boatId === aiEntry.boatId));
  ok(rAi.players.find((p) => p.id === A.id)?.boatId === aiEntry.boatId,
    'AI 上局占用的赛艇现在可以选', { want: aiEntry.boatId, got: rAi.players.find((p) => p.id === A.id)?.boatId });

  // ---- 5. 回大厅 → 所有人一起回选艇屏 ----
  A.clear(); B.clear();
  A.send({ t: 'backLobby' });
  await A.wait('lobbyReset');
  await B.wait('lobbyReset');
  ok(true, '房主回大厅时，客人也收到 lobbyReset');
  const rReset = A.last('roster');
  ok(rReset && rReset.phase === 'lobby' && rReset.players.every((p) => !p.boatId), '大厅重置：phase=lobby 且无残留选艇');

  // ---- 5.5 房主改模式 / 天气 / 地图：客人的选艇和准备必须原样保留 ----
  B.send({ t: 'pick', boatId: 'titan' });
  await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.boatId === 'titan'));
  B.send({ t: 'ready', ready: true });
  await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.ready === true));
  A.clear(); B.clear();
  A.send({ t: 'mode', modeId: 'item' });
  const rMode = await A.waitWhere('roster', (r) => r.mode === 'item');
  const bMode = rMode.players.find((p) => p.id === B.id);
  ok(bMode?.boatId === 'titan' && bMode?.ready === true, '换模式后客人的选艇 / 准备都保留', bMode);
  A.send({ t: 'weather', weatherId: 'storm' });
  const rWeather = await A.waitWhere('roster', (r) => r.weather === 'storm');
  ok(rWeather.players.find((p) => p.id === B.id)?.ready === true, '换天气后客人的准备保留');
  const currentMap = A.last('roster').mapId;
  const nextMap = MAPS.find((m) => m.id !== currentMap).id;
  A.send({ t: 'map', mapId: nextMap });
  const rMap = await A.waitWhere('roster', (r) => r.mapId === nextMap);
  ok(rMap.players.find((p) => p.id === B.id)?.ready === true, '换地图后客人的准备保留');
  // 老客户端（只发 mode 字段）也要生效：以前服务器只认 modeId，整包丢掉
  A.send({ t: 'mode', mode: 'race' });
  const rMode2 = await A.waitWhere('roster', (r) => r.mode === 'race');
  ok(rMode2.players.find((p) => p.id === B.id)?.ready === true, 'mode 字段兼容且不影响准备');

  // ---- 5.6 抢艇被拒要回执，客户端才能立刻收回"乐观已选" ----
  A.send({ t: 'pick', boatId: 'rower' });
  await A.waitWhere('roster', (r) => r.players.some((p) => p.id === A.id && p.boatId === 'rower'));
  B.clear();
  B.send({ t: 'pick', boatId: 'rower' });
  const ackPick = await B.wait('pickResult');
  ok(ackPick.ok === false && ackPick.boatId === 'rower', '抢艇失败会收到 pickResult 否决回执', ackPick);
  const rReject = B.last('roster');
  ok(rReject.players.find((p) => p.id === B.id)?.boatId === 'titan',
    '被拒后仍保留客人原来那艘艇（客户端据此回滚到已确认值）',
    rReject.players.find((p) => p.id === B.id));

  // ---- 6. 再开一局必须能开（核心回归点）----
  // 顺带覆盖：房主自己没选艇时，服务器自动补一艘，不能把整局卡死
  A.clear(); B.clear();
  A.send({ t: 'backLobby' });
  await A.wait('lobbyReset');
  await B.wait('lobbyReset');
  B.send({ t: 'pick', boatId: 'titan' });
  await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.boatId === 'titan'));
  B.send({ t: 'ready', ready: true });
  await B.waitWhere('roster', (r) => r.players.some((p) => p.id === B.id && p.ready === true));
  A.clear(); B.clear();
  A.send({ t: 'start' });
  const start2 = await A.wait('start', 5000);
  await B.wait('start', 5000);
  ok(start2.raceSeq > start1.raceSeq, '第二局的 raceSeq 递增（客户端据此丢弃重复 start）', [start1.raceSeq, start2.raceSeq]);
  ok(start2.order.filter((o) => !o.ai).length === 2, '第二局两个真人都在', start2.order);
  const hostEntry = start2.order.find((o) => !o.ai && o.name === '房主');
  ok(!!hostEntry?.boatId, '房主没选艇也能开赛（服务器自动补艇）', hostEntry);

  // ---- 7. 非房主点开始要有反馈 ----
  B.clear();
  B.send({ t: 'start' });
  const t2 = await B.wait('toast');
  ok(/房主/.test(t2.msg), '非房主开赛会被明确拒绝', t2.msg);

  // ---- 8. 同会话重连（断线续座）----
  const sessionA = A.session;
  const idA = A.id;
  A.ws.removeAllListeners();
  const A2 = new Client('房主', sessionA);
  const wa2 = await A2.connect();
  ok(wa2.id === idA, '重连后拿回同一个座位 id', { old: idA, now: wa2.id });
  ok(wa2.resumed === true, 'welcome 标记了 resumed');
  ok(A2.last('welcome')?.phase === 'racing', '重连时能看到当前比赛阶段');

  // ---- 9. 房主掉线：先留 15s 重连缓冲，之后房主顺延给剩下的人 ----
  B.clear();
  A2.close();
  await sleep(1200);
  const rGrace = B.last('roster');
  ok(rGrace?.players.find((p) => p.id === idA)?.offline === true, '房主掉线先进重连缓冲（座位保留）');
  await sleep(15500);
  const rAfter = B.last('roster');
  ok(rAfter && !rAfter.players.some((p) => p.id === idA), '缓冲期结束，掉线玩家被清出房间', rAfter?.players);
  ok(rAfter?.hostId === B.id, '房主顺延给剩下的玩家', rAfter?.hostId);
  B.clear();
  B.send({ t: 'start' });
  const t3 = await B.wait('toast');
  ok(!/只有房主/.test(t3.msg), '新房主点开始不再是"没反应/没权限"', t3.msg);
} catch (e) {
  failures += 1;
  console.error('测试异常:', e.message);
} finally {
  server.kill('SIGKILL');
  await sleep(200);
  console.log(failures ? `\n联机大厅回归：${failures} 项失败` : '\n联机大厅回归：全部通过');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
