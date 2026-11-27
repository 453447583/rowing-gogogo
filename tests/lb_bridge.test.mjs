// 排行榜桥接验收：node tests/lb_bridge.test.mjs
//
// 场景：家里那台 server.js 写本地 leaderboard.json，cpolar 把它的端口暴露到公网，
// 线上那条 server.js 用 LB_STORE=remote 通过隧道读写同一份数据。
//
// 覆盖：
//   B1 隧道不通时写入先入队，地址恢复后自动补发（不丢成绩）
//   B2 增量拉取：since 只取新增/更新，合并时"更差的不覆盖"
//   B3 读失败返回 null → 上层保留缓存（榜单不会突然清空）
//   B4 setUrl 换地址后从头全量拉（cpolar 换域名的场景）
//   H1 家里写一条 → 线上 lbGet 读得到，且 payload.store === 'remote'
//   H2 线上真跑完一局 → 成绩落进家里的 JSON 文件
//   H3 鉴权：token 错 → 401
//   H4 线上 /lb-api/register 换地址后榜单照样能读
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createRemoteStore } from '../server/lb-store.js';
import { findCpolarUrl } from '../server/public-url.js';
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

async function waitFor(fn, ms = 8000, step = 150) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const v = await fn(); if (v) return v; } catch { /* 还没好 */ }
    await sleep(step);
  }
  return null;
}

/** 拿一个空闲端口：固定端口撞上一次跑残留的进程，整轮都会误判 */
async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

// ---------- 假的家（只实现桥接的两个接口，用来做单元测试） ----------
function startFakeHome(port = 0) {
  const state = { boards: {}, received: [], queries: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    if (req.method === 'POST' && url.pathname === '/lb-api/write') {
      const items = JSON.parse(body || '{}').items || [];
      for (const it of items) {
        const list = state.boards[it.key] || (state.boards[it.key] = []);
        const cur = list.findIndex((e) => e.n === it.entry.n);
        const e = { ...it.entry, at: Date.now() };
        if (cur >= 0) list[cur] = e; else list.push(e);
        state.received.push({ key: it.key, entry: e });
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/lb-api/boards') {
      const since = Number(url.searchParams.get('since')) || 0;
      state.queries.push(since);
      const at = Date.now();
      const out = {};
      for (const [k, list] of Object.entries(state.boards)) {
        const fresh = since ? list.filter((e) => (Number(e.at) || 0) >= since) : list;
        if (fresh.length) out[k] = fresh;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ v: 1, at, boards: out }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port, state, server,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// ---------- B1~B4 ----------
async function unitChecks() {
  // 先开一个，记下端口，再关掉 —— 等会儿用它模拟"隧道断了"
  const probe = await startFakeHome();
  const port = probe.port;
  await probe.close();

  const store = createRemoteStore({ url: `http://127.0.0.1:${port}`, token: 'unit-token' });
  const data0 = await store.init();
  ok(data0 && Object.keys(data0.boards || {}).length === 0 && Object.keys(data0.players || {}).length === 0,
    'B3 隧道不通时 init 也能返回空榜 / 空钱包（不影响开局）');

  store.write('r:canyon:1', { n: '甲', t: 61.2 }, 'time');
  store.write('r:canyon:1', { n: '乙', t: 58.4 }, 'time');
  await sleep(1400);
  ok(store !== null, 'B1 写入先进队列，不抛异常');
  ok((await store.readAll()) === null, 'B3 读失败返回 null（上层保留内存缓存）');

  const home = await startFakeHome(port);
  try {
    await store.flush();
    ok(home.state.received.length === 2, 'B1 地址恢复后队列自动补发（2 条都到了）', home.state.received.length);

    const got = await store.readAll();
    ok(got?.boards?.['r:canyon:1']?.length === 2, 'B2 全量拉取合并进缓存', got && Object.keys(got));
    ok(home.state.queries[0] === 0, 'B2 首次拉取 since=0（要全量）', home.state.queries[0]);

    // 家里新来一条更好的成绩 → 下一次增量只该带这一条
    home.state.boards['r:canyon:1'].push({ n: '丙', t: 55, at: Date.now() });
    const before = home.state.queries.length;
    await sleep(10);
    const merged = await store.readAll();
    ok(home.state.queries.length > before && home.state.queries.at(-1) > 0,
      'B2 后续拉取带上 since（增量）', home.state.queries.slice(-2));
    ok(merged?.boards?.['r:canyon:1']?.some((e) => e.n === '丙'), 'B2 增量记录合并进缓存');

    // 更差的同名成绩不该覆盖缓存
    home.state.boards['r:canyon:1'].push({ n: '甲', t: 99, at: Date.now() + 1 });
    const worse = await store.readAll();
    const jia = worse?.boards?.['r:canyon:1']?.find((e) => e.n === '甲');
    ok(jia?.t === 61.2, 'B2 更差的同名成绩不覆盖缓存', jia);

    // 换地址 → 清缓存 + 从头全量拉（用 localhost 当"新域名"，同一个服务）
    await sleep(10);
    await store.setUrl(`http://localhost:${port}`);
    await store.readAll();
    ok(home.state.queries.at(-1) === 0, 'B4 换地址后重新全量拉（since 归零）', home.state.queries.slice(-2));
    // 同一个地址重复登记不该清缓存（cpolar 地址没变时每 60 秒都会推一次）
    const beforeRepeat = home.state.queries.length;
    await store.setUrl(`http://localhost:${port}/`);
    await store.readAll();
    const tailQueries = home.state.queries.slice(beforeRepeat);
    ok(!tailQueries.includes(0), 'B4 同一地址重复登记不重拉（避免每 60 秒清一次缓存）', tailQueries);
  } finally {
    await home.close();
  }
}

// ---------- B5 公网地址识别（cpolar 日志） ----------
async function logChecks() {
  const dir = path.join(TMP, 'cpolar_logs');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // 真实日志是转义过的 JSON，且隧道可能是昨天建的、今天零点日志已轮转
  const line = (port, url) => 'time="2026-11-20T08:44:14+08:00" level=debug msg="Read message {\\"Type\\":\\"NewTunnel\\",'
    + `\\"Payload\\":{\\"Url\\":\\"${url}\\",\\"Protocol\\":\\"https\\",\\"LocalAddr\\":\\"http://localhost:${port}\\"}}"`;
  const old = path.join(dir, 'cpolar_service.log.20261120');
  const fresh = path.join(dir, 'cpolar_service.log.20261121');
  fs.writeFileSync(old, [
    line(3000, 'https://old.r8.cpolar.top'),
    line(3000, 'https://newest-in-old.r8.cpolar.top'),
    line(30000, 'https://wrong-port.r8.cpolar.top'),
  ].join('\n'));
  fs.writeFileSync(fresh, 'time="2026-11-21T00:00:01+08:00" level=info msg="log rotated"\n');
  // 让新文件确实更新（Windows 上毫秒可能相同）
  const now = Date.now();
  fs.utimesSync(old, new Date(now - 60000), new Date(now - 60000));
  fs.utimesSync(fresh, new Date(now), new Date(now));

  const hit = findCpolarUrl(3000, dir);
  ok(hit === 'https://newest-in-old.r8.cpolar.top', 'B5 新日志里没有隧道记录时往回翻（返回旧日志里最新那条）', hit);
  ok(findCpolarUrl(30000, dir) === 'https://wrong-port.r8.cpolar.top', 'B5 端口精确匹配（3000 不会误吃 30000）');
  ok(findCpolarUrl(8080, dir) === null, 'B5 没有对应端口返回 null');

  // 新日志里也有一条时，以新日志为准
  fs.appendFileSync(fresh, `\n${line(3000, 'https://today.r8.cpolar.top')}\n`);
  ok(findCpolarUrl(3000, dir) === 'https://today.r8.cpolar.top', 'B5 新日志有记录时优先用新的');
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 真服务器：家里 + 线上两条 ----------
class Client {
  constructor(name) { this.name = name; this.msgs = []; this.id = null; }

  connect(port) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: this.name })));
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

function spawnServer(env) {
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const errs = [];
  child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) errs.push(s); });
  return { child, errs };
}

async function waitHttp(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.status === 200) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function bridgeChecks() {
  const HOME_HTTP = await freePort(); const HOME_WS = await freePort();
  const ONLINE_HTTP = await freePort(); const ONLINE_WS = await freePort();
  const TOKEN = 'bridge-test-token';
  const file = path.join(TMP, 'lb_bridge_home.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }

  const home = spawnServer({
    PORT: String(HOME_HTTP), WS_PORT: String(HOME_WS),
    LEADERBOARD_FILE: file, LB_BRIDGE_TOKEN: TOKEN,
  });
  const online = spawnServer({
    PORT: String(ONLINE_HTTP), WS_PORT: String(ONLINE_WS),
    LB_STORE: 'remote',
    LEADERBOARD_REMOTE_URL: `http://127.0.0.1:${HOME_HTTP}`,
    LEADERBOARD_TOKEN: TOKEN,
  });

  try {
    ok(await waitHttp(HOME_HTTP), 'H0 家里那台起来了');
    ok(await waitHttp(ONLINE_HTTP), 'H0 线上那台起来了');

    const post = (port, p, body, token = TOKEN) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    // ---- H1 家里写 → 线上读到 ----
    const w = await post(HOME_HTTP, '/lb-api/write', {
      items: [{ key: 'bt:2', entry: { n: '老王', t: 300, a: 'wave', b: 'falcon' }, kind: 'time' }],
    });
    ok(w.status === 200, 'H1 带 token 的写入被接受', w.status);

    const client = new Client('线上玩家');
    await client.connect(ONLINE_WS);
    const lb1 = await waitFor(async () => {
      client.clear();
      client.send({ t: 'lbGet' });
      const msg = await client.wait('lb', 2000);
      return msg?.boards?.['bt:2']?.length ? msg : null;
    }, 12000);
    ok(lb1?.boards?.['bt:2']?.[0]?.n === '老王', 'H1 家里写入的成绩线上 lbGet 能读到', lb1?.boards?.['bt:2']);
    ok(lb1?.store === 'remote', 'H1 线上自报存储类型 remote', lb1?.store);

    // ---- H2 线上跑完一局 → 落到家里 JSON ----
    client.send({ t: 'pick', boatId: 'falcon' });
    await sleep(150);
    client.send({ t: 'mode', modeId: 'race' });
    client.send({ t: 'settings', settings: { laps: 1, aiCount: 0 } });
    await sleep(150);
    client.clear();
    client.send({ t: 'start' });
    const start = await client.wait('start', 6000);
    ok(!!start, 'H2 线上能开赛');
    const gates = MAPS.find((m) => m.id === (start?.mapId || 'canyon'))?.gates.length || 24;
    for (let g = 0; g <= gates - 1; g++) {
      client.send({ t: 'gate', id: client.id, gate: g, lap: 1 });
      await sleep(8);
    }
    client.send({ t: 'gate', id: client.id, gate: 0, lap: 2, totalTime: 64.4, lapTime: 64.4, finish: true });
    const end = await client.wait('raceEnd', 16000);
    ok(!!end, 'H2 冲线后结算');

    const raceKey = `r:${start?.mapId || 'canyon'}:1`;
    const landed = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${HOME_HTTP}/lb-api/boards?since=0`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const data = await r.json();
      return data?.boards?.[raceKey]?.some((e) => e.n === '线上玩家') ? data : null;
    }, 12000);
    ok(!!landed, 'H2 线上跑出的成绩落进家里那份 JSON', raceKey);
    // JSON 存储有 2 秒合并写盘，落盘要等一下
    const onDisk = await waitFor(() => {
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        return rec?.boards?.[raceKey]?.some((e) => e.n === '线上玩家') ? rec : null;
      } catch { return null; }
    }, 6000);
    ok(!!onDisk, 'H2 家里的 leaderboard.json 里确实写进去了');

    // ---- H2b 钱包档案必须全量下发 ----
    // 曾经的 bug：/lb-api/boards 用「上次拉取时刻(since)」去过滤「档案写入时刻(p.at)」，
    // 线上首次拉取时钱包还是空的，之后老档案的 at 永远小于已经推进的 since，
    // 线上积分就一直是 0。这里用一个"未来时间"当 since 复现该场景：
    // 榜单增量为 0 是对的，但钱包档案必须一条不少地全发过来。
    const walletOp = await post(HOME_HTTP, '/lb-api/write', {
      items: [{
        type: 'walletOp',
        op: { id: 'h2b:wallet:1', uid: 'u_testwallet000001', kind: 'grant', d: 50, mode: 'race', n: '钱包测试' },
      }],
    });
    ok(walletOp.status === 200, 'H2b 家里接受钱包 op', walletOp.status);
    const futureSince = Date.now() + 3600e3;
    const snap = await fetch(`http://127.0.0.1:${HOME_HTTP}/lb-api/boards?since=${futureSince}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }).then((r) => r.json());
    ok(snap?.players?.u_testwallet000001?.pts === 50,
      'H2b 钱包档案不被 since 过滤（线上能补回历史积分）', snap?.players?.u_testwallet000001);
    ok(!Object.keys(snap?.boards || {}).length, 'H2b 榜单依旧按 since 增量', Object.keys(snap?.boards || {}));

    // ---- H3 鉴权 ----
    const bad = await post(HOME_HTTP, '/lb-api/write', { items: [] }, 'wrong-token');
    ok(bad.status === 401, 'H3 token 不对 → 401', bad.status);
    const badGet = await fetch(`http://127.0.0.1:${HOME_HTTP}/lb-api/boards`, { headers: { authorization: 'Bearer nope' } });
    ok(badGet.status === 401, 'H3 读接口同样要 token', badGet.status);

    // ---- H4 换地址登记 ----
    const reg = await post(ONLINE_HTTP, '/lb-api/register', { url: `http://localhost:${HOME_HTTP}` });
    ok(reg.status === 200, 'H4 线上接受新地址（cpolar 换域名的场景）', reg.status);
    const regBad = await post(ONLINE_HTTP, '/lb-api/register', { url: `http://localhost:${HOME_HTTP}` }, 'nope');
    ok(regBad.status === 401, 'H4 换地址也要 token', regBad.status);
    const lb2 = await waitFor(async () => {
      client.clear();
      client.send({ t: 'lbGet' });
      const msg = await client.wait('lb', 2000);
      return msg?.boards?.['bt:2']?.length ? msg : null;
    }, 12000);
    ok(lb2?.boards?.['bt:2']?.[0]?.n === '老王', 'H4 换地址后榜单照样能读');

    client.close();
    ok(home.errs.length === 0, '家里那台没有报错输出', home.errs.slice(0, 3));
    ok(online.errs.length === 0, '线上那台没有报错输出', online.errs.slice(0, 3));
  } finally {
    home.child.kill('SIGKILL');
    online.child.kill('SIGKILL');
    await sleep(300);
    // 子进程崩了的话，stderr 是唯一线索，别只留一个 ✗
    if (home.errs.length) console.error('[家里那台 stderr]', home.errs.slice(0, 5).join('\n'));
    if (online.errs.length) console.error('[线上那台 stderr]', online.errs.slice(0, 5).join('\n'));
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

console.log('leaderboard bridge checks:');
await unitChecks();
await logChecks();
await bridgeChecks();
if (failures) {
  console.error(`\n${failures} 项未通过`);
  process.exit(1);
}
console.log('\nall leaderboard bridge checks PASS');
