// 语音信令回归（纯 WebSocket，不开浏览器）
//   node tests/voice_signal.test.mjs
//
// 语音是 Mesh P2P，服务端只转发信令；局域网（3001）和线上同源 /ws 都开放。
// 这里验证四件事：
//   1) 大厅阶段（phase='lobby'）也能广播 voiceState，不受 RELAY_TYPES 的 racing 限制
//   2) offer / answer / ICE candidate 按 to 定向投递，不会全房乱发
//   3) 局域网连接同样可以开麦、发信令（本机双开调试就是这条链路）
//   4) 玩家掉线时，其他人立刻收到 voiceState:false，不等 15s 座位缓冲
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HTTP_PORT = 3565;
const WS_PORT = 3566;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
}

class Client {
  constructor(name, url) {
    this.name = name;
    this.url = url;
    this.msgs = [];
    this.cursors = {};
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => reject(new Error(this.name + ' 连接超时')), 6000);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'voice-' + this.name }));
      });
      this.ws.on('error', (e) => { clearTimeout(timer); reject(e); });
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
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 已关 */ } }
  clear() { this.msgs = []; this.cursors = {}; }
  close() { try { this.ws.close(); } catch { /* 已关 */ } }
  async waitWhere(type, pred = () => true, timeout = 6000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        const m = this.msgs[i];
        if (m.t === type && pred(m)) { this.cursors[type] = i + 1; return m; }
      }
      if (Date.now() - start > timeout) throw new Error(`${this.name} 等 ${type} 超时`);
      await sleep(20);
    }
  }
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
const serverErr = [];
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) serverErr.push(s); });

const clients = [];
try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) { up = true; break; } } catch { /* 等 */ }
    await sleep(150);
  }
  ok(up, '测试服务器已启动', serverErr.slice(-2));

  const onlineUrl = `ws://127.0.0.1:${HTTP_PORT}/ws`;
  const lanUrl = `ws://127.0.0.1:${WS_PORT}`;

  const a = new Client('线上甲', onlineUrl);
  const b = new Client('线上乙', onlineUrl);
  const lan = new Client('局域网丙', lanUrl);
  clients.push(a, b, lan);

  const wa = await a.connect();
  const wb = await b.connect();
  await lan.connect();
  ok(wa.id !== wb.id && !!lan.id, '两个线上入口 + 一个局域网入口都能进同一房间', {
    a: wa.id, b: wb.id, lan: lan.id,
  });

  // 1) 大厅阶段开麦：voiceState 必须能广播（RELAY_TYPES 只在 racing 生效，别混用）
  a.clear(); b.clear(); lan.clear();
  a.send({ t: 'voiceState', on: true });
  const gotStateA = await b.waitWhere('voiceState', (m) => m.id === a.id && m.on === true, 4000);
  ok(!!gotStateA, '大厅阶段：甲的 voiceState 能广播给乙');

  const rosterAfterA = await b.waitWhere('roster', (m) => m.players.some((p) => p.id === a.id && p.voiceOn === true), 4000);
  ok(!!rosterAfterA, 'roster 里能看到甲的 voiceOn=true');

  b.send({ t: 'voiceState', on: true });
  const gotStateB = await a.waitWhere('voiceState', (m) => m.id === b.id && m.on === true, 4000);
  ok(!!gotStateB, '大厅阶段：乙的 voiceState 能广播给甲');

  // 2) 定向信令：offer 只给目标；candidate 只给目标
  b.clear(); lan.clear();
  a.send({ t: 'voiceSignal', to: b.id, data: { kind: 'offer', sdp: 'v=0 fake-offer' } });
  const offer = await b.waitWhere('voiceSignal', () => true, 4000);
  ok(offer.from === a.id && offer.to === b.id && offer.data.sdp === 'v=0 fake-offer',
    'offer 按 to 定向投递，带正确 from', offer);
  ok(!lan.msgs.some((m) => m.t === 'voiceSignal'), '定向信令不会发给无关的第三方');

  a.clear();
  b.send({ t: 'voiceSignal', to: a.id, data: {
    kind: 'candidate',
    candidate: { candidate: 'candidate:1 1 udp 1 127.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  } });
  const candidate = await a.waitWhere('voiceSignal', () => true, 4000);
  ok(candidate.data.kind === 'candidate' && candidate.data.candidate.sdpMLineIndex === 0,
    'ICE candidate 按 to 定向投递', candidate);

  // 3) 局域网入口同样能开麦：本机双开（localhost + 3001）就是这条链路
  a.clear(); b.clear();
  lan.send({ t: 'voiceState', on: true });
  const gotLanState = await a.waitWhere('voiceState', (m) => m.id === lan.id && m.on === true, 4000);
  ok(!!gotLanState, '局域网玩家开麦后，线上玩家能收到 voiceState');
  const rosterAfterLan = await a.waitWhere('roster', (m) => m.players.some((p) => p.id === lan.id && p.voiceOn === true), 4000);
  ok(!!rosterAfterLan, 'roster 里能看到局域网玩家的 voiceOn=true');

  a.clear();
  lan.send({ t: 'voiceSignal', to: a.id, data: { kind: 'offer', sdp: 'v=0 lan-offer' } });
  const lanOffer = await a.waitWhere('voiceSignal', (m) => m.from === lan.id, 4000);
  ok(lanOffer.data.sdp === 'v=0 lan-offer', '局域网玩家的 voiceSignal 能定向发给线上玩家');

  // 4) 掉线立刻通知：不等 15 秒座位缓冲
  a.clear();
  b.close();
  const off = await a.waitWhere('voiceState', (m) => m.id === b.id && m.on === false, 4000);
  ok(!!off, '线上玩家断开时立刻广播 voiceState:false');
} catch (err) {
  failures += 1;
  console.error('  ✗ 语音信令测试异常', err);
} finally {
  for (const c of clients) c.close();
  server.kill();
}

if (serverErr.length) console.error('[server stderr]', serverErr.slice(-5).join('\n'));
process.exitCode = failures ? 1 : 0;
