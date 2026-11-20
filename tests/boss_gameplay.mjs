// 怪物模式玩法验收：持续判定 / 周期落雷限速 / 随机血包。
//
//   node tests/boss_gameplay.mjs
//
// 无头渲染只有 1~3 fps，所以每一步都用"轮询到状态变化"而不是固定 sleep，
// 否则会出现"代码没问题但断言随机失败"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// 每次用独立 profile（原因同 arena_smoke：固定目录会被上一轮残留实例锁住）
const profile = path.resolve('D:/3dgame-tmp/browser/boss-gameplay-' + Date.now());
const port = 9339;
const httpPort = 5173;
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], { stdio: 'ignore' });
// 静态服务必须先起来再启 Edge：否则首页会拿到 ERR_CONNECTION_REFUSED，
// 页面永久停在错误页，后面所有断言都只是"没加载完"的假失败。
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch {}
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来（端口 ' + httpPort + '）'); }
}
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1000,600',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
const errors = [];
const fail = (m) => { throw new Error(m); };

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
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
      // 保留前几行栈：只打 message 的话，texImage2D 这类错误根本定不到位
      const d = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '';
      // 无头软件光栅 + Effekseer 的已知环境噪音：真正带 GPU 的浏览器里不会出现，
      // 也不是本项目的代码问题。不过滤的话每次都会把"全部通过"变成 FAIL。
      if (/texImage2D|Overload resolution failed/.test(d)) return;
      errors.push(d.split('\n').slice(0, 4).join(' ⏎ '));
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  /** 轮询直到 expr 为真，返回最后一次的值 */
  const waitFor = async (expr, timeout = 25000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(280);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // 大厅改造后单人入口变成：#btn-solo → #lobby → #btn-lobby-mode → [data-mode=boss] → #btn-start-race。
  // 老的 #boat-list / #btn-boat-ok / #mode-select / #btn-map-ok 虽然还留在 DOM 里，
  // 但已经是空壳（不再驱动任何状态），照着点会静默失败。
  const boot = async () => {
    await sleep(1200);
    await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 25000, 'btn-solo handler');
    await ev('document.querySelector("#btn-solo").click()');
    await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 25000, 'lobby shown');
    await ev('document.querySelector("#btn-lobby-mode").click()');
    await waitFor('!!document.querySelector("#lobby-pick-body [data-mode=\\"boss\\"]")', 25000, 'mode drawer');
    await ev('document.querySelector("#lobby-pick-body [data-mode=\\"boss\\"]").click()');
    await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
    await ev('document.querySelector("#btn-start-race").click()');
    await waitFor('!!window.__game?.bossMode', 40000, 'bossMode created');
    await ev('(function(){const b=window.__game.bossMode;b.introT=99;return 1})()');
    await waitFor('window.__game.bossMode.phase === "countdown"', 25000, 'countdown');
    await ev('(function(){const b=window.__game.bossMode;b.countdown=0.02;return 1})()');
    await waitFor('window.__game.bossMode.phase === "fight"', 25000, 'fight');
  };
  await boot();

  // ---------- ① 持续判定：站在锥形里要连续掉血 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.hp = 100; me.invuln = 0;
    me.boat.pos.x = 0; me.boat.pos.z = 20;
    b.hazards.push({
      skill: { kind: 'cone', damage: 20, range: 34, angle: 70, visual: 'fire' },
      info: { x: 0, z: 0, heading: 0 },
      t: 0, next: 0, hitCd: new Map(),
    });
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp < 95', 25000, 'cone tick damage');
  const hpAfterCone = await ev('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp');
  console.log('① 持续判定：站在锥形里被扣到 hp =', hpAfterCone);
  if (!(hpAfterCone <= 88)) fail('cone tick too weak: hp=' + hpAfterCone);

  // ---------- ② 周期落雷 + 限速 ----------
  await ev('(function(){ window.__game.bossMode.startStage(2); return 1; })()');
  await sleep(1200);
  await ev('(function(){const b=window.__game.bossMode;b.introT=99;return 1})()');
  await waitFor('window.__game.bossMode.phase === "countdown"', 20000, 'stage2 countdown');
  await ev('(function(){const b=window.__game.bossMode;b.countdown=0.02;return 1})()');
  await waitFor('window.__game.bossMode.phase === "fight"', 20000, 'stage2 fight');
  console.log('   第 2 关 phase =', await ev('window.__game.bossMode.phase'));

  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.hp = 100; me.invuln = 0;
    me.boat.pos.x = 0; me.boat.pos.z = 45;   // 离 BOSS 最远，会被选成落雷目标
    b.thunderT = 0.01;
    return 1;
  })()`);
  await waitFor('!!window.__game.bossMode.thunderWarn', 25000, 'thunder warning ring');
  console.log('② 落雷：红色预警圈已出现');
  await ev('(function(){ const b = window.__game.bossMode; if (b.thunderWarn) b.thunderWarn.t = 1.55; return 1; })()');
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).boat.speedCap === 10', 25000, 'thunder speed cap');
  const afterThunder = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    return JSON.stringify({ hp: me.hp, cap: me.boat.speedCap, capT: +me.boat.speedCapTimer.toFixed(1) });
  })()`));
  console.log('② 落雷后：', afterThunder);
  if (!(afterThunder.hp < 100)) fail('thunder did not damage the player');
  if (!(afterThunder.capT > 3)) fail('speed cap timer too short: ' + afterThunder.capT);

  // ---------- ③ 血包：计时刷新 + 拾取 ----------
  // 2026-11-14 改版后不再「开局摆 3 个」，而是每 BOSS_HEAL_PACK.interval 秒刷一个。
  // 所以这里不再断言 t=0 就有 3 个，而是把计时器按到 0，看它是否真的生出来。
  const packBefore = await ev('window.__game.bossMode.healPacks.length');
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.healSpawnT = 0.01;                 // 强制走一次刷新分支
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.healPacks.length > ' + packBefore, 25000, 'heal pack spawned by timer');
  const packAfter = await ev('window.__game.bossMode.healPacks.length');
  const packMax = await ev('window.__game.bossMode.healPacks.length <= 3');
  console.log('③ 血包刷新：', packBefore, '→', packAfter, '（上限 3 个：', packMax, '）');
  if (!packMax) fail('heal pack spawn exceeded max 3');

  // 把刚刷出来的那个搬到船脚下（无头里跑不了真驾驶，直接改坐标最稳）
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.hp = 40; me.invuln = 0;
    const pk = b.healPacks[b.healPacks.length - 1];
    pk.x = me.boat.pos.x; pk.z = me.boat.pos.z;
    pk.group.position.set(pk.x, 1.9, pk.z);
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp === 65', 25000, 'heal pack +25');
  const healState = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({ hp: b.players.get(b.myId).hp, packs: b.healPacks.length });
  })()`));
  console.log('③ 血包拾取：', healState);
  // 吃掉之后必须从场上摘掉，否则同一格会反复回血
  if (healState.packs !== packAfter - 1) fail('heal pack did not get consumed: ' + healState.packs);

  // ---------- ④ 天使庇佑必须有可见特效 ----------
  // 用户报的原话：「最高画质下天使守护技能释放不显示特效」。
  // 以前这个道具只改状态、屏幕上什么都不多，所以这里断言的是"真的挂了东西上去"：
  //   · 船身跟随的圣光（fxBenediction）挂进 fx.attached
  //   · 脚下一次符文阵（fxMagic2Holy）被触发
  //   · 保护时长真的生效（shieldTimer > 0）
  const angelFxLoaded = await (async () => {
    for (let i = 0; i < 200; i++) {
      if (await ev('!!window.__game.bossMode.fx.effects.fxBenediction && !!window.__game.bossMode.fx.effects.fxMagic2Holy')) return true;
      await sleep(300);
    }
    return false;
  })();
  if (!angelFxLoaded) fail('天使特效资源没加载成功（fxBenediction / fxMagic2Holy）');
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.hp = 100; me.alive = true; me.invuln = 0;
    b.myItems[0] = 'angel';
    b.input.onItem(0);
    return 1;
  })()`);
  const angelState = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    return JSON.stringify({
      attached: b.fx.attached.has('angel:' + b.myId),
      shield: +(me.boat.shieldTimer || 0).toFixed(2),
      itemGone: b.myItems[0] === null,
      effects: Object.keys(b.fx.attached),
    });
  })()`));
  console.log('④ 天使庇佑：', angelState);
  if (!angelState.attached) fail('天使庇佑没有挂上跟随圣光（玩家会看到"放了没特效"）');
  if (!(angelState.shield > 0)) fail('天使庇佑没有生效保护');
  if (!angelState.itemGone) fail('用了道具但槽位没清空');

  // ---------- ⑤ 聊天条不再压住协同进度条 ----------
  // 怪物 / 竞技场左下角被「协同合击」长条占着，比赛内聊天必须让开。
  const chatCss = JSON.parse(await ev(`(function(){
    const hud = document.getElementById('hud');
    const bar = document.getElementById('chat-game-bar');
    const log = document.getElementById('chat-game-log');
    const g = (el) => el ? getComputedStyle(el).bottom : null;
    return JSON.stringify({ modeClass: hud.className, bar: g(bar), log: g(log) });
  })()`));
  console.log('⑤ 聊天条 bottom =', chatCss.bar, '｜日志 =', chatCss.log, '｜HUD 类 =', chatCss.modeClass);
  if (!/boss-mode/.test(chatCss.modeClass)) fail('HUD 没有 boss-mode 类，聊天条不会被让开');
  if (chatCss.bar !== '104px') fail('怪物模式下聊天输入条没抬到 104px，仍然压着协同条: ' + chatCss.bar);
  if (chatCss.log !== '104px') fail('怪物模式下聊天记录没抬到 104px: ' + chatCss.log);

  if (errors.length) fail('page exceptions: ' + errors.slice(0, 3).join(' | '));
  console.log('boss gameplay checks: PASS');
} catch (e) {
  console.error('boss gameplay checks: FAIL', e.message);
  if (errors.length) console.error('errors:', errors.slice(0, 3));
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await wait(500);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
