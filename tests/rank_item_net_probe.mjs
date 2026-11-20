// 名次栏道具图标的「联机协议」轻量探针（不需要浏览器，两个裸 WS 客户端）
//   node tests/rank_item_net_probe.mjs
// 验：itemHeld 在 RELAY_TYPES 白名单里，racing 阶段能转发给对端，
//     且消息里的 items 列表原样到达（名次栏图标就是靠它刷新）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const HTTP_PORT = 3461;
const WS_PORT = 3462;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  PASS', label);
  else { fail++; console.error('  FAIL', label, extra === undefined ? '' : JSON.stringify(extra)); }
}

const server = spawn(process.execPath, [path.resolve('server/server.js')], {
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) console.error('[server]', s);
});

class Client {
  constructor(name) {
    this.name = name;
    this.session = 'sess-' + Math.random().toString(36).slice(2, 9);
    this.msgs = [];
    this.id = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('连接超时')), 8000);
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
  send(m) { this.ws.send(JSON.stringify(m)); }
  has(type, pred = () => true) { return this.msgs.some((m) => m.t === type && pred(m)); }
}

async function main() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.status === 200) break; } catch { /* 等 */ }
    await sleep(200);
  }
  const host = new Client('房主');
  const guest = new Client('客人');
  await host.connect();
  await guest.connect();
  ok(!!host.id && !!guest.id && host.id !== guest.id, '两个真人连进同一房间', { host: host.id, guest: guest.id });

  host.send({ t: 'pick', boatId: 'titan' });
  host.send({ t: 'mode', modeId: 'item' });
  host.send({ t: 'settings', settings: { laps: 1, rounds: 1, aiCount: 0 } });
  guest.send({ t: 'pick', boatId: 'rower' });
  guest.send({ t: 'ready', ready: true });
  await sleep(900);
  host.send({ t: 'start' });
  await sleep(1200);
  ok(guest.has('raceStart') || guest.has('start'), '比赛已开局（RELAY 只在 racing 阶段生效）',
    guest.msgs.map((m) => m.t).slice(-12));

  // 房主吃到两件道具 → 广播持有列表
  host.send({ t: 'itemHeld', by: host.id, items: ['nitro', 'bomb'] });
  await sleep(700);
  const held = guest.msgs.filter((m) => m.t === 'itemHeld');
  ok(held.length > 0, 'itemHeld 被服务器转发给对端', guest.msgs.map((m) => m.t).slice(-12));
  ok(held.some((m) => m.by === host.id && Array.isArray(m.items)
    && m.items.length === 2 && m.items[0] === 'nitro' && m.items[1] === 'bomb'),
  '道具列表原样到达（名次栏图标靠它刷新）', held);

  // 用掉一件 → 再发一次覆盖式列表，对端应拿到 1 件（不是累加成 3 件）
  host.send({ t: 'itemHeld', by: host.id, items: ['bomb'] });
  await sleep(600);
  const held2 = guest.msgs.filter((m) => m.t === 'itemHeld');
  ok(held2.length === 2 && held2[1].items.length === 1 && held2[1].items[0] === 'bomb',
    '用掉后覆盖式更新，不会累积成幽灵图标', held2.map((m) => m.items));
}

try { await main(); } catch (e) {
  fail++; console.error('探针异常:', e.message);
} finally {
  console.log(`\n结果: ${fail === 0 ? '全部 PASS' : fail + ' 项 FAIL'}`);
  server.kill('SIGKILL');
  if (fail) process.exitCode = 1;
}
