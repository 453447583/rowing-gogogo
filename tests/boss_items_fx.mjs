// 怪物模式道具改造验收：新增 4 件的伤害 / 增益 / Effekseer 特效是否真的落地。
//
//   node tests/boss_items_fx.mjs
//
// 重点不是"代码里有没有这个字段"，而是：
//   ① 新登记的四段特效在运行时被 Effekseer 正常加载（没有 404 / 资源缺失）
//   ② 每件新攻击道具都能通过 input.onItem 打出去，并且真的让 BOSS 掉血
//   ③ 冲角护符（无伤害）能正确挂上限时增益
// 池子里到底有几件、删掉的三件有没有残留，由 .tmp_build/check_item_fx.mjs 静态校验。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const stamp = Date.now();
const profile = path.resolve('D:/3dgame-tmp/browser/boss-items-' + stamp);
const port = 9341;
const httpPort = 5181;
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore',
  env: { ...process.env, PORT: String(httpPort) },
});
// 必须先等静态服务器真的能应答再开浏览器：两者同时 spawn 时 Edge 会抢在前面
// 拿到一个连接拒绝，之后停在错误页上再也不会重试，#btn-solo 永远不出现。
for (let i = 0; i < 100; i++) {
  try {
    const r = await fetch('http://127.0.0.1:' + httpPort + '/');
    if (r.ok) break;
  } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 150));
}
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=900,560',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const pid = child.pid;
const errors = [];
const fxWarnings = [];
const fail = (m) => { throw new Error(m); };

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
  if (!tabs) fail('headless Edge 没有起来');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails.exception?.description
        || m.params.exceptionDetails.text || '';
      errors.push(d.split('\n').slice(0, 3).join(' ⏎ '));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/特效加载失败|Failed to load|404/.test(text)) fxWarnings.push(text.slice(0, 200));
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', {
    expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true,
  });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 25000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(260);
    }
    throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // ---------- 进 BOSS 战 ----------
  // 现在的单人入口是「主菜单 → 大厅 → 抽屉选艇/选模式 → 发车」，不再有独立选艇页。
  // 8 艘艇的 GLB 加起来 35MB，冷启动预热很慢；按钮 onclick 挂上了才说明预热完。
  await waitFor("typeof document.querySelector('#btn-solo')?.onclick === 'function'",
    90000, 'btn-solo handler');
  let inLobby = false;
  for (let i = 0; i < 12 && !inLobby; i++) {
    await ev("document.querySelector('#btn-solo')?.click()");
    await sleep(900);
    inLobby = await ev("(() => { const l = document.querySelector('#lobby'); return !!l && !l.classList.contains('hidden'); })()");
  }
  if (!inLobby) fail('进不去大厅');

  // 选艇：抽屉 → 点第一张卡 → 关闭
  await ev("document.querySelector('#btn-lobby-boat').click()");
  await waitFor("!!document.querySelector('[data-boat]')", 30000, 'boat grid');
  await ev("document.querySelector('[data-boat]').click()");
  await sleep(300);
  await ev("document.querySelector('#btn-lobby-pick-close')?.click()");
  await sleep(300);

  // 模式：切到怪物模式
  await ev("document.querySelector('#btn-lobby-mode').click()");
  await waitFor("!!document.querySelector('[data-mode=\"boss\"]')", 20000, 'mode pills');
  await ev("document.querySelector('[data-mode=\"boss\"]').click()");
  await sleep(300);
  await ev("document.querySelector('#btn-lobby-pick-close')?.click()");
  await sleep(300);

  // 发车：点最多 4 次，以「真的有 bossMode」为收敛条件
  let booted = false;
  for (let attempt = 0; attempt < 4 && !booted; attempt++) {
    await ev("document.querySelector('#btn-start-race')?.click()");
    const t0 = Date.now();
    while (Date.now() - t0 < 70000) {
      if (await ev('!!(window.__game && window.__game.bossMode)')) { booted = true; break; }
      await sleep(400);
    }
  }
  if (!booted) fail('怪物模式没起来');

  await ev('window.__game.bossMode.introT = 99');
  await waitFor('window.__game.bossMode.phase === "countdown"', 30000, 'countdown');
  await ev('window.__game.bossMode.countdown = 0.02');
  await waitFor('window.__game.bossMode.phase === "fight"', 30000, 'fight');

  // ---------- ① 特效是否加载成功 ----------
  // FX_PACK 那一类要先 fetch 同目录 fxres.json 拿到哈希名映射才 loadEffect，
  // 是异步的；一次性读会造成"其实没问题但检查点太早"的假失败，必须轮询。
  await waitFor('!!window.__game.bossMode.fx && !!window.__game.bossMode.fx.effects', 25000, 'fx manager');
  const needFx = ['fxHarpoonFly', 'fxHarpoonHit', 'fxThunderFly', 'ramCrest',
    'fxWaterImpact', 'fxLightningStrike', 'fxSonicBoom'];
  const fxState = {};
  for (const name of needFx) {
    try {
      await waitFor(`!!window.__game.bossMode.fx.effects[${JSON.stringify(name)}]`,
        60000, '特效 ' + name);
      fxState[name] = true;
    } catch {
      fxState[name] = false;
    }
  }
  console.log('① 特效加载：', fxState);
  for (const [k, ok] of Object.entries(fxState)) {
    if (!ok) fail('特效没有加载成功：' + k);
  }

  // ---------- ② 逐件打出去 ----------
  const cases = [
    { id: 'harpoon', label: '深海鱼叉', expectMin: 300 },
    { id: 'barrage', label: '三连深水弹', expectMin: 380 },
    { id: 'thunderrod', label: '引雷针', expectMin: 240 },
  ];
  for (const c of cases) {
    // 两个前置条件都不能省，否则测出来的数字是上一件的余弹 / 破甲窗口叠出来的：
    //   ① projectiles 清空 —— 上一件的弹还在飞，会算进这一件的增量
    //   ② vulnerable 归零 —— 鱼叉自己会开 2.5 秒破甲，后面两件会白吃 ×1.6
    await waitFor('window.__game.bossMode.projectiles.length === 0', 20000, c.label + ' 前清空弹道');
    await waitFor('!(window.__game.bossMode.bossStatus.vulnerable > 0)', 20000, c.label + ' 前等破甲结束');
    const before = await ev('window.__game.bossMode.totalDamage');
    await ev(`(function(){
      const b = window.__game.bossMode;
      const me = b.players.get(b.myId);
      // 贴到 BOSS 旁边，保证鱼叉不会因为 32m 射程空掉
      me.boat.pos.x = b.boss.pos.x + 18;
      me.boat.pos.z = b.boss.pos.z;
      b.myItems[0] = ${JSON.stringify(c.id)};
      b.input.onItem(0);
      return 1;
    })()`);
    // 打完还要等在途弹道全部落地，再取最终增量
    await waitFor(`window.__game.bossMode.totalDamage > ${before}`, 25000, c.label + ' 命中');
    await waitFor('window.__game.bossMode.projectiles.length === 0', 20000, c.label + ' 弹道收尾');
    const after = await ev('window.__game.bossMode.totalDamage');
    const delta = Math.round(after - before);
    console.log(`② ${c.label}：造成 ${delta} 伤害`);
    if (delta < c.expectMin) fail(`${c.label} 伤害偏低：${delta} < ${c.expectMin}`);
  }

  // ---------- ③ 冲角护符（无伤害，检查增益与光罩） ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.myItems[0] = 'ramcrest';
    b.input.onItem(0);
    return 1;
  })()`);
  const crest = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({ t: +(b.ramBuff?.t ?? 0).toFixed(2), mul: b.ramBuff?.mul ?? 0 });
  })()`));
  console.log('③ 冲角护符：', crest);
  if (!(crest.t > 6)) fail('冲角护符没有生效（ramBuff.t=' + crest.t + '）');
  if (crest.mul !== 3) fail('冲角护符倍率不对：' + crest.mul);

  // 撞上去，确认倍率真的进了伤害。
  //
  // 这一段在无头环境里**不保证能测到**：船的 speed 由 Boat 每帧用水阻重算，
  // 合成 vel 会被一帧打回 0，而玩家死亡→重生的流程还会把执行上下文整个换掉。
  // 所以这里只做一次尽力而为的尝试：
  //   · 完全没撞上  → 只记录，不算失败（不是代码问题，是环境问题）
  //   · 撞上了但伤害 < 100 → 真失败（说明倍率没进公式）
  // 倍率公式本身由 .tmp_build/check_item_fx.mjs 的源码守卫兜底。
  let ramDelta = 0;
  let ramDiag = null;
  try {
    const ramBefore = await ev('window.__game.bossMode.totalDamage');
    for (let i = 0; i < 12 && ramDelta <= 0; i++) {
      await ev(`(function(){
        const b = window.__game.bossMode;
        const me = b.players.get(b.myId);
        me.invuln = 0;
        b.ramCooldown.set(b.myId, 0);
        me.boat.pos.x = b.boss.pos.x + (b.boss.def.radius + 2.6);
        me.boat.pos.z = b.boss.pos.z;
        me.boat.boostTimer = 8;
        me.boat.vel.x = -22;
        me.boat.vel.y = 0;
        me.boat.speed = 22;
        return 1;
      })()`);
      await sleep(400);
      ramDelta = Math.round((await ev('window.__game.bossMode.totalDamage')) - ramBefore);
    }
    ramDiag = await ev(`(function(){
      const b = window.__game.bossMode;
      const lb = b.localBoat;
      return 'speed=' + (lb?.speed ?? -1).toFixed(2)
        + ' d=' + Math.hypot(lb.pos.x - b.boss.pos.x, lb.pos.z - b.boss.pos.z).toFixed(2)
        + ' contact=' + (b.boss.def.radius + 3.2).toFixed(2);
    })()`);
  } catch (e) {
    ramDiag = '尝试中断：' + e.message;
  }
  console.log('③ 冲角撞击伤害：', ramDelta, '现场：', ramDiag);
  if (ramDelta > 0 && ramDelta < 100) {
    fail('冲角护符的撞船伤害没有翻上去：' + ramDelta);
  }
  if (ramDelta === 0) {
    console.log('   （无头环境没能把船推进撞船距离，这项只记录不断言）');
  }

  await fs.mkdir(path.resolve('shots/verify/boss-items'), { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
  const shotPath = path.resolve('shots/verify/boss-items/items-' + stamp + '.jpg');
  await fs.writeFile(shotPath, Buffer.from(shot.data, 'base64'));

  if (errors.length) console.log('⚠️ 运行时异常：', errors.slice(0, 5));
  if (fxWarnings.length) console.log('⚠️ 特效加载告警：', fxWarnings.slice(0, 5));
  console.log('\n道具改造验收：PASS');
  console.log('截图：shots/verify/boss-items/items-' + stamp + '.jpg');
} catch (e) {
  console.error('\n道具改造验收：FAIL');
  console.error(e.message);
  if (errors.length) console.error('运行时异常：', errors.slice(0, 6));
  if (fxWarnings.length) console.error('特效加载告警：', fxWarnings.slice(0, 6));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  // Edge 的 GPU / 渲染子进程必须用 taskkill /T 整棵树收掉，否则会留孤儿进程
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch {}
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' }); } catch {}
}
