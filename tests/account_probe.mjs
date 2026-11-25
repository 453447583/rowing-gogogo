// 正式账号验收：node tests/account_probe.mjs
//   A1 注册：用户名唯一、密码只存盐 + 哈希、返回一次性备用码
//   A2 登录：密码对了才发 token，token 能换回账号
//   A3 备用码重置：只能用一次，重置后旧密码失效
//   A4 服务端：hello 带 token 时钱包主键切到账号 uid，两台"设备"共享同一个钱包
//   A5 账号钱包不受改名影响；未登录的本机 uid 不会顶掉账号钱包
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createStore } from '../server/lb-store.js';
import { createAccounts } from '../server/accounts.js';
import { createWallet } from '../server/wallet.js';

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
  const file = path.join(TMP, 'account_unit.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }
  const store = await createStore({ file });
  const db = await store.init();
  store.attach?.(db.boards || {}, db.players || {}, db.accounts || {}, db.tokens || {});
  const accounts = createAccounts({ store, db });
  const wallet = createWallet({ store, db });

  // A1 注册
  const reg = await accounts.register('测试水手', 'abc123456');
  ok(reg.ok && !!reg.token && /^u_[0-9a-f]{20}$/.test(reg.uid), 'A1 注册成功并返回账号 uid', reg);
  ok(/^[0-9A-F]{16}$/.test(reg.backupCode || ''), 'A1 返回一次性备用码');
  ok((await accounts.register('测试水手', 'other12345')).reason !== 'ok'
    && (await accounts.register('测试水手', 'other12345')).ok === false,
  'A1 用户名不能重复');

  const accRec = db.accounts['测试水手'];
  ok(accRec && !('pass' in accRec) && !JSON.stringify(accRec).includes('abc123456'),
    'A1 落盘没有明文密码，只有 salt/hash');
  ok(accRec.salt?.length === 32 && accRec.hash?.length === 64, 'A1 盐 16 字节、哈希 32 字节');

  // A2 登录
  ok((await accounts.login('测试水手', 'wrong-pass')).ok === false, 'A2 密码错误拒绝登录');
  const login = await accounts.login('测试水手', 'abc123456');
  ok(login.ok && login.uid === reg.uid, 'A2 密码正确发 token，uid 与注册一致', login);
  const sess = await accounts.session(login.token);
  ok(sess?.uid === reg.uid && sess.user === '测试水手', 'A2 token 能换回账号');
  ok((await accounts.session('t-not-a-real-token')) === null, 'A2 假 token 换不到账号');

  // 大小写 / 空格归一：同名只算一个人
  const login2 = await accounts.login('  测试水手  ', 'abc123456');
  ok(login2.ok && login2.uid === reg.uid, 'A2 用户名前后空格不产生第二个账号');

  // A3 备用码只生效一次
  const used = await accounts.reset('测试水手', reg.backupCode, 'newpass123');
  ok(used.ok, 'A3 备用码可以重置密码');
  ok((await accounts.login('测试水手', 'newpass123')).ok, 'A3 新密码可登录');
  ok((await accounts.login('测试水手', 'abc123456')).ok === false, 'A3 旧密码失效');
  ok((await accounts.reset('测试水手', reg.backupCode, 'again12345')).ok === false,
    'A3 同一备用码不能二次使用');

  // A4 账号 uid 就是钱包主键
  wallet.apply({ id: 'acc-seed-1', uid: reg.uid, kind: 'grant', d: 120, mode: 'race', n: '测试水手' });
  ok(wallet.snapshot(reg.uid).pts === 120, 'A4 账号 uid 可直接作为钱包主键');

  await store.flush();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(raw.v >= 3 && !!raw.accounts['测试水手'] && !!raw.tokens?.[login.token],
    'A1 账号与会话随榜单落进同一个 JSON（v3）');
  try { fs.unlinkSync(file); } catch { /* 忽略 */ }
}

class Client {
  constructor(name, { uid = '', token = '' } = {}) {
    this.name = name;
    this.uid = uid;
    this.token = token;
    this.session = `s-${uid || 'acc'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.msgs = [];
    this.id = null;
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const timer = setTimeout(() => reject(new Error(`${this.name} 连接超时`)), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({
        t: 'hello', name: this.name, session: this.session, uid: this.uid, token: this.token,
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
  const HTTP_PORT = 3451;
  const WS_PORT = 3452;
  const file = path.join(TMP, 'account_server.json');
  try { fs.unlinkSync(file); } catch { /* 首次运行 */ }
  const server = spawn(process.execPath, ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT), LEADERBOARD_FILE: file },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const errs = [];
  server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) errs.push(s); });
  const post = async (p, body) => {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/auth/${p}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.status === 200) break; } catch { /* 还没起来 */ }
      await sleep(200);
    }

    const reg = await post('register', { user: '账号甲', pass: 'sail123456' });
    ok(reg.ok && !!reg.token, 'A4 HTTP 注册接口可用', reg);
    ok((await post('register', { user: '账号甲', pass: 'sail123456' })).ok === false,
      'A4 同名注册被拒');
    ok((await post('login', { user: '账号甲', pass: 'bad-pass' })).ok === false,
      'A4 错误密码登录被拒');

    // 两台"电脑"：本机 uid 完全不同，但带同一个账号 token
    const pcA = new Client('家里电脑', { uid: 'u_homepc000001', token: reg.token });
    await pcA.connect(WS_PORT);
    pcA.clear();
    pcA.send({ t: 'walletGet' });
    const wa = await pcA.wait('wallet', 5000);
    ok(wa?.uid === reg.uid, 'A4 带 token 的 hello 把钱包主键切到账号 uid', wa);

    // 先给账号加一笔分（走真实的服务器发奖路径：竞速单人名次）
    pcA.send({ t: 'pick', boatId: 'falcon' });
    await sleep(120);
    pcA.send({ t: 'mode', modeId: 'race' });
    pcA.send({ t: 'settings', settings: { laps: 1, aiCount: 0 } });
    await sleep(150);
    pcA.clear();
    pcA.send({ t: 'start' });
    const start = await pcA.wait('start', 6000);
    ok(!!start, 'A4 账号玩家能开赛');
    const N = start?.gates?.length || 24;
    for (let g = 0; g <= N - 1; g++) pcA.send({ t: 'gate', id: pcA.id, gate: g, lap: 1 });
    pcA.send({ t: 'gate', id: pcA.id, gate: 0, lap: 2, totalTime: 60.1, finish: true });
    ok(!!(await pcA.wait('raceEnd', 16000)), 'A4 结算完成');
    pcA.clear();
    pcA.send({ t: 'walletGet' });
    const afterRace = await pcA.wait('wallet', 5000);
    ok(afterRace?.pts === 120, 'A4 第 1 名 120 分记到账号', afterRace);

    // 换第二台电脑：本机 uid 不同、名字也不同，只带账号 token
    const pcB = new Client('公司电脑', { uid: 'u_officepc0001', token: reg.token });
    await pcB.connect(WS_PORT);
    pcB.clear();
    pcB.send({ t: 'walletGet' });
    const wb = await pcB.wait('wallet', 5000);
    ok(wb?.uid === reg.uid && wb?.pts === 120,
      'A4 换电脑换名字登录同一账号，积分照旧（跨设备共享）', wb);

    // 未登录的游客用本机 uid：不能读到账号钱包
    const guest = new Client('游客', { uid: 'u_guestpc00001' });
    await guest.connect(WS_PORT);
    guest.clear();
    guest.send({ t: 'walletGet' });
    const wg = await guest.wait('wallet', 5000);
    ok(wg?.uid === 'u_guestpc00001' && wg?.pts === 0,
      'A5 不带 token 的游客拿到的是本机空钱包，看不到账号余额', wg);

    // 伪造 token 不能顶掉账号
    const fake = new Client('伪造者', { uid: 'u_fakerpc00001', token: 't-forged-token' });
    await fake.connect(WS_PORT);
    fake.clear();
    fake.send({ t: 'walletGet' });
    const wf = await fake.wait('wallet', 5000);
    ok(wf?.uid === 'u_fakerpc00001', 'A5 假 token 被忽略，不会切到别人账号');

    pcA.close(); pcB.close(); guest.close(); fake.close();
    ok(errs.length === 0, '服务器没有报错输出', errs.slice(0, 3));
  } finally {
    server.kill();
    await sleep(300);
    try { fs.unlinkSync(file); } catch { /* 忽略 */ }
  }
}

console.log('account checks:');
await unitChecks();
await serverChecks();
if (failures) {
  console.error(`\n${failures} 项未通过`);
  process.exit(1);
}
console.log('\nall account checks PASS');
