// 怪物模式道具改动验收（2026-11-22 用户逐条指定）
//
//   node tests/boss_new_items.mjs
//
// 验九件事：
//   ① 方向转换器（tide）已从怪物/海克斯池删除，池子里换上了三件新道具
//   ② 漩涡：BOSS 被水泡托到半空（liftY / status.bubble），期间不能放技能、**照常掉血**
//   ③ 漩涡会打断正在读条的技能
//   ④ 墨鱼：打断读条 + 40 伤害 + 沉默
//   ⑤ 寒冰牢笼：80 伤害 + 定身 + 沉默
//   ⑥ 飞鱼群：没小怪时对 BOSS 180 伤害（旧版 120）
//   ⑦ 救援信标：倒地队友当场救起（45% 血），且**不扣**复活次数
//   ⑧ 协同伙伴：协同值瞬间拉满，队友走远也不掉（comboPinT）
//   ⑨ 天使庇佑：护盾只保自己，天使覆盖到 AI 队友
//
// 无头渲染 1~3 fps，所有断言都用轮询；弹道不等它飞，直接搬到 BOSS 身上（否则要等十几秒）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boss-items-' + Date.now());
const port = 9345;
const httpPort = 5177;
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch { /* */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来（端口 ' + httpPort + '）'); }
}
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,760',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
const errors = [];
let failed = 0;
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};
const fail = (m) => { throw new Error(m); };

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* */ }
    await wait(200);
  }
  if (!tabs) fail('headless Edge did not come up');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl, { perMessageDeflate: false });
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
      const desc = m.params.exceptionDetails.exception?.description || '';
      errors.push(desc);
      // 只打前三条，避免死循环刷屏；第一条通常就是根因
      if (errors.length <= 3 || /uniforms/.test(desc)) {
        const fr = (m.params.exceptionDetails.stackTrace?.callFrames || [])
          .slice(0, 4).map((f) => `${f.functionName || '?'}@${String(f.url).split('/').pop()}:${f.lineNumber}`);
        console.log('  [页面异常] ' + desc.split('\n')[0] + (fr.length ? ' ← ' + fr.join(' ← ') : ''));
      }
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
  const waitFor = async (expr, timeout = 25000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // ---------- 进怪物模式（1 名 AI 队友，救援信标要用） ----------
  await sleep(1200);
  await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 30000, 'btn-solo handler');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
  // 带 1 个 AI 陪练：救援信标 / 天使全队都要一个队友
  await ev('(function(){const s=document.querySelector("#sel-ai");if(s){s.value="1";s.dispatchEvent(new Event("change",{bubbles:true}));}return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector("#lobby-pick-body [data-mode=\\"boss\\"]")', 30000, 'mode drawer');
  await ev('document.querySelector("#lobby-pick-body [data-mode=\\"boss\\"]").click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.bossMode', 45000, 'bossMode');
  await ev('(function(){window.__game.bossMode.introT=99;return 1})()');
  await waitFor('window.__game.bossMode.phase === "countdown"', 30000, 'countdown');
  await ev('(function(){window.__game.bossMode.countdown=0.02;return 1})()');
  await waitFor('window.__game.bossMode.phase === "fight"', 30000, 'fight');

  const roster = await ev('JSON.stringify([...window.__game.bossMode.players.values()].map(p=>({id:p.id,ai:!!p.ai})))');
  console.log('  名单：', roster);

  // 这台无头机的 Effekseer WASM 在 BOSS 场景会崩（HEAD 版本同样崩，属于既有环境问题），
  // 崩了之后 fx.update 每帧抛错、整个循环停摆，后面的断言全部变成假失败。
  // 做法：只把 Effekseer 那层的 4 个入口换掉，**保留 skillFx**（那是 three.js 程序化粒子，
  // 不碰 wasm；#spawnBurst 依赖它的 sparks，整个换掉会抛错，反而让弹道删不掉）。
  await ev(`(function(){
    const noop = () => {};
    const patch = (fx) => {
      if (!fx) return;
      fx.play = noop;
      fx.playAttached = () => 'stub';
      fx.stopAttached = noop;
      fx.update = noop;
      fx.clear = noop;
    };
    patch(window.__game.bossMode.fx);
    patch(window.__game.fx);
    return 1;
  })()`);
  // 这里就统计一次：如果还没用任何道具就已经有 uniforms/wasm 报错，说明是引擎侧噪声，
  // 和下面的水泡网格无关（水泡要等漩涡命中才创建）。
  console.log('  启动阶段引擎异常计数：', errors.filter((d) => /uniforms|wasm:\/\/|getParameter/.test(d)).length);

  // 装一个伤害探针：BOSS 每次 applyDamage 的数值都记下来。
  // 直接比 hp 差会被主炮/AI 陪练的流弹污染（实测漩涡 160 打出来是 320），
  // 有了逐次调用才能判断"到底是道具打了两下，还是别的东西补了刀"。
  await ev(`(function(){
    const b = window.__game.bossMode;
    if (!b.boss.__dmgPatched) {
      const orig = b.boss.applyDamage.bind(b.boss);
      b.boss.applyDamage = (a) => { (b.__hits = b.__hits || []).push(Math.round(a)); return orig(a); };
      b.boss.__dmgPatched = true;
    }
    b.__hits = [];
    // 关掉主炮与 AI 陪练的火力：这些伤害会混进"道具伤害"的读数里
    for (const p of b.players.values()) p.weaponLock = 9999;
    b.aiWeapons.clear();
    return 1;
  })()`);

  // 统一口径：每次命中前把会干扰伤害数字的乘区清干净
  const cleanRoom = `(function(){
    const b = window.__game.bossMode;
    b.bossStatus.vulnerable = 0; b.bossStatus.dive = 0;
    b.bossStatus.root = 0; b.bossStatus.silence = 0; b.bossStatus.bubble = 0;
    b.weakT = 0; b.prefixInvulnT = 0;
    const bo = b.boss;
    bo.airborne = false; bo.staggerTimer = 0; bo.status.vulnerable = 0;
    bo.status.bubble = 0; bo.status.dive = 0; bo.status.silence = 0; bo.status.root = 0;
    b.projectiles.length = 0;
    b.__hits = [];
    b.myItems[0] = null; b.myItems[1] = null; b.myItems[2] = null;
    return bo.hp;
  })()`;

  /** 用一件道具打 BOSS：出手后把弹道直接搬到 BOSS 身上（省掉十几秒飞行） */
  const hitWith = async (item) => {
    const before = await ev(cleanRoom);
    const shots = await ev(`(function(){
      const b = window.__game.bossMode;
      b.myItems[0] = ${JSON.stringify(item)};
      b.input.onItem(0);
      for (const p of b.projectiles) {
        p.pos.x = b.boss.pos.x + 0.05;
        p.pos.z = b.boss.pos.z + 0.05;
        p.pos.y = Math.max(1.8, (b.boss.def.height || 6) * 0.45);
      }
      return b.projectiles.length;
    })()`);
    await waitFor(`window.__game.bossMode.boss.hp < ${before}`, 20000, `${item} 命中`);
    const hits = await ev('JSON.stringify(window.__game.bossMode.__hits || [])');
    return { shots, hits: JSON.parse(hits) };
  };

  // ---------- ① 道具池 ----------
  const pool = await ev(`(function(){
    const b = window.__game.bossMode;
    const out = {};
    for (const id of ['tide', 'icecage', 'beacon', 'synergy']) {
      b.myItems[0] = id;
      out[id] = !!b.hudData().items[0];
    }
    b.myItems[0] = null;
    return JSON.stringify(out);
  })()`);
  const poolObj = JSON.parse(pool);
  report(poolObj.tide === false, '方向转换器已从怪物/海克斯池删除');
  report(poolObj.icecage && poolObj.beacon && poolObj.synergy, '三件新道具已入池（寒冰牢笼 / 救援信标 / 协同伙伴）');

  // ---------- ② 漩涡：水泡浮空 + 照常掉血 ----------
  const vx = await hitWith('vortex');
  console.log('   漩涡 shots =', vx.shots, '｜伤害调用 =', JSON.stringify(vx.hits));
  const vx160 = vx.hits.filter((x) => x === 160).length;
  report(vx160 === 1, `漩涡伤害 160 且只结算一次（实测 ${JSON.stringify(vx.hits)}）`);
  const bubbleState = await ev(`JSON.stringify({
    st: window.__game.bossMode.bossStatus.bubble,
    bs: window.__game.bossMode.boss.status.bubble,
  })`);
  const bs = JSON.parse(bubbleState);
  report(bs.st > 0 && bs.bs > 0, `水泡状态已挂上（bossStatus=${bs.st?.toFixed?.(2)} / boss.status=${bs.bs?.toFixed?.(2)}）`);
  const lifted = await waitFor('window.__game.bossMode.boss.liftY > 0.5', 12000, 'BOSS 浮空');
  report(!!lifted, `BOSS 被托离水面（liftY=${Number(lifted).toFixed(2)}m）`);
  // 泡体是 three.js 网格（不走 Effekseer）：壳 + 内层 + 12 颗小水泡 + 中心辉光
  const wrap = JSON.parse(await ev(`(function(){
    const w = window.__game.bossMode.boss.bubbleWrap;
    return JSON.stringify(w ? {
      visible: w.visible, kids: w.children.length, r: w.userData?.r,
    } : null);
  })()`));
  report(!!wrap && wrap.visible && wrap.kids >= 14,
    `水泡罩已挂在 BOSS 身上（可见=${wrap?.visible} 网格=${wrap?.kids} 半径=${wrap?.r?.toFixed?.(2)}m）`);
  // 浮空期间可以继续打：再补一发导弹，血必须还在掉
  const whileFloat = await hitWith('missile');
  report(whileFloat.hits.includes(200),
    `浮空期间玩家仍能继续攻击 BOSS（导弹 ${JSON.stringify(whileFloat.hits)}）`);

  // ---------- ③ 漩涡打断读条 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.boss.state = 'telegraph';
    b.boss.telegraph = { skill: { kind: 'cone' }, info: { x: 0, z: 0 }, timer: 5, total: 5, heading: 0 };
    return 1;
  })()`);
  await hitWith('vortex');
  // 打断成功后 BOSS 会立刻回到 chase/idle（不可能是 telegraph），红圈也要清干净
  const afterVortex = JSON.parse(await ev(`JSON.stringify({
    st: window.__game.bossMode.boss.state,
    tele: window.__game.bossMode.boss.telegraph,
  })`));
  report(afterVortex.st !== 'telegraph' && afterVortex.tele === null,
    `漩涡打断读条（state=${afterVortex.st} / telegraph=${afterVortex.tele}）`);

  // ---------- ④ 墨鱼：打断 + 40 伤害 + 沉默 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.boss.state = 'telegraph';
    b.boss.telegraph = { skill: { kind: 'cone' }, info: { x: 0, z: 0 }, timer: 5, total: 5, heading: 0 };
    return 1;
  })()`);
  const inkHit = await hitWith('ink');
  const inkState = await ev(`JSON.stringify({
    st: window.__game.bossMode.boss.state,
    tele: window.__game.bossMode.boss.telegraph,
    sil: window.__game.bossMode.bossStatus.silence,
  })`);
  const ink = JSON.parse(inkState);
  report(inkHit.hits.includes(40), `墨鱼补了 40 伤害（实测 ${JSON.stringify(inkHit.hits)}）`);
  report(ink.st !== 'telegraph' && ink.tele === null,
    `墨鱼打断读条（state=${ink.st} / telegraph=${ink.tele}）`);
  report(ink.sil > 3, `墨鱼沉默已挂上（${ink.sil?.toFixed?.(2)}s）`);

  // ---------- ⑤ 寒冰牢笼 ----------
  const cageHit = await hitWith('icecage');
  const cage = JSON.parse(await ev(`JSON.stringify({
    root: window.__game.bossMode.bossStatus.root,
    sil: window.__game.bossMode.bossStatus.silence,
  })`));
  report(cageHit.hits.includes(80), `寒冰牢笼 80 伤害（实测 ${JSON.stringify(cageHit.hits)}）`);
  report(cage.root > 2 && cage.sil > 1, `寒冰牢笼定身 ${cage.root?.toFixed(2)}s + 沉默 ${cage.sil?.toFixed(2)}s`);

  // ---------- ⑥ 飞鱼群 180 ----------
  const fishHit = await hitWith('fish');
  report(fishHit.hits.includes(180), `飞鱼群空场伤害 180（实测 ${JSON.stringify(fishHit.hits)}，旧版 120）`);

  // ---------- ⑦ 救援信标 ----------
  const beacon = await ev(`(function(){
    const b = window.__game.bossMode;
    const ai = [...b.players.values()].find((p) => p.ai);
    if (!ai) return JSON.stringify({ err: '没有 AI 队友' });
    // 造一个"倒地且复活次数用尽"的队友：信标要能不用次数把人捞起来
    ai.alive = false; ai.hp = 0; ai.revives = 0; ai.respawn = 0;
    b.myItems[0] = 'beacon';
    b.input.onItem(0);
    return JSON.stringify({
      alive: ai.alive, hp: ai.hp, revives: ai.revives,
      maxHp: ai.maxHp || 100,
    });
  })()`);
  const bcn = JSON.parse(beacon);
  report(!bcn.err && bcn.alive === true, `救援信标把倒地队友救起（alive=${bcn.alive}）`);
  report(!bcn.err && bcn.revives === 0, `救起不消耗复活次数（revives=${bcn.revives}）`);
  report(!bcn.err && bcn.hp > 0 && bcn.hp < bcn.maxHp, `救起后是残血而不是满血（${bcn.hp}/${bcn.maxHp}）`);

  // ---------- ⑧ 协同伙伴 ----------
  const syn = await ev(`(function(){
    const b = window.__game.bossMode;
    b.comboCharge = 0; b.comboCd = 0; b.comboReady = false; b.comboPinT = 0;
    b.myItems[0] = 'synergy';
    b.input.onItem(0);
    return JSON.stringify({ charge: b.comboCharge, pin: b.comboPinT, ready: b.comboReady });
  })()`);
  const sy = JSON.parse(syn);
  report(sy.charge === 100 && sy.ready === true, `协同值瞬间拉满（${sy.charge} / ready=${sy.ready}）`);
  await sleep(900);
  const synAfter = await ev('window.__game.bossMode.comboCharge');
  report(synAfter === 100, `拉满后 0.9 秒不衰减（仍为 ${synAfter}）`);

  // ---------- ⑨ 天使全队 ----------
  const angel = await ev(`(function(){
    const b = window.__game.bossMode;
    const ai = [...b.players.values()].find((p) => p.ai);
    // 先清空护盾，避免上一轮的 shield 还在
    for (const p of b.players.values()) if (p.boat) p.boat.shieldTimer = 0;
    b.myItems[0] = 'angel';
    b.input.onItem(0);
    const me = b.players.get(b.myId);
    return JSON.stringify({
      self: me.boat.shieldTimer, ai: ai ? ai.boat.shieldTimer : null,
    });
  })()`);
  const ang = JSON.parse(angel);
  report(ang.self > 0, `天使庇佑保住自己（shield=${ang.self?.toFixed?.(2)}s）`);
  report(ang.ai > 0, `天使庇佑覆盖到 AI 队友（shield=${ang.ai?.toFixed?.(2)}s）`);

  // 护盾仍然只保自己
  const shield = await ev(`(function(){
    const b = window.__game.bossMode;
    const ai = [...b.players.values()].find((p) => p.ai);
    for (const p of b.players.values()) if (p.boat) p.boat.shieldTimer = 0;
    b.myItems[0] = 'shield';
    b.input.onItem(0);
    const me = b.players.get(b.myId);
    return JSON.stringify({ self: me.boat.shieldTimer, ai: ai ? ai.boat.shieldTimer : null });
  })()`);
  const sh = JSON.parse(shield);
  report(sh.self > 0 && sh.ai === 0, `护盾只保自己（self=${sh.self?.toFixed?.(2)} / ai=${sh.ai}）`);

  // ---------- ⑩ 圈外持续掉血：不再有任何"受击"演出 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.hp = 100; me.invuln = 0; me.alive = true;
    me.boat.stunTimer = 0; me.boat.hitShake = 0; me.boat.stunStarsTimer = 0;
    b.hurtFlash = 0;
    // 造一个已经缩到最小的安全圈，把船放到圈外；#updateSafeRing 每帧都会跑
    b.safeRing = { r: 0 }; b.stageElapsed = 9999; b.safeRingTick = 0;
    me.boat.pos.x = 60; me.boat.pos.z = 60;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp < 100',
    20000, '圈外扣血');
  const quiet = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode, me = b.players.get(b.myId);
    const out = {
      hp: me.hp, stun: me.boat.stunTimer, shake: me.boat.hitShake,
      flash: b.hurtFlash, stars: me.boat.stunStarsTimer,
    };
    b.safeRing = null; b.safeRingTick = 0;
    return JSON.stringify(out);
  })()`));
  report(quiet.hp < 100 && quiet.stun === 0 && quiet.shake === 0
    && quiet.flash === 0 && quiet.stars === 0,
  `圈外只掉血不晕不闪（hp=${quiet.hp?.toFixed(1)} stun=${quiet.stun} shake=${quiet.shake} flash=${quiet.flash}）`);

  // ---------- ⑪ 落雷：头顶金星 + 2 秒眩晕，但不进异世界 ----------
  const shock = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode, me = b.players.get(b.myId);
    me.invuln = 0; me.alive = true;
    me.boat.stunTimer = 0; me.boat.stunStarsTimer = 0; me.boat.voidTimer = 0;
    b.handleNet({ t: 'bossHit', hits: [{ id: b.myId, dmg: 10, src: '⚡ 落雷', kind: 'shock' }] });
    return JSON.stringify({
      stars: me.boat.stunStarsTimer, stun: me.boat.stunTimer, void: me.boat.voidTimer,
    });
  })()`));
  report(shock.stars >= 1.9 && shock.stun >= 1.9,
    `落雷眩晕 2 秒（stars=${shock.stars?.toFixed(2)} stun=${shock.stun?.toFixed(2)}）`);
  report(shock.void === 0, `落雷不会误触发异世界隐身（void=${shock.void}）`);
  await sleep(400);
  const starVisible = await ev(`(() => {
    const me = window.__game.bossMode.players.get(window.__game.bossMode.myId);
    return !!(me.boat.dizzyMark && me.boat.dizzyMark.visible);
  })()`);
  report(starVisible === true, '头顶三颗金星真的显示出来了');

  // ---------- ⑫ 尾扫：原地打转 1.2 秒 ----------
  const spin = await ev(`(function(){
    const b = window.__game.bossMode, me = b.players.get(b.myId);
    me.invuln = 0; me.alive = true; me.boat.spinTimer = 0;
    b.handleNet({ t: 'bossHit', hits: [{ id: b.myId, dmg: 10, src: '🐲 尾扫冲击', kind: 'spin' }] });
    return me.boat.spinTimer;
  })()`);
  report(spin >= 1.1, `尾扫触发原地打转（spinTimer=${Number(spin).toFixed(2)}s）`);

  // ---------- ⑬ 圈外冰封减速要保留（只是不算"受击"） ----------
  const cold = await ev(`(function(){
    const b = window.__game.bossMode, me = b.players.get(b.myId);
    b.hexPrefix = { id: 'frost' };
    me.hp = 100; me.invuln = 0; me.alive = true;
    me.boat.slowTimer = 0; me.boat.stunTimer = 0; me.boat.hitShake = 0;
    b.hurtFlash = 0;
    b.safeRing = { r: 0 }; b.stageElapsed = 9999; b.safeRingTick = 0;
    me.boat.pos.x = 60; me.boat.pos.z = 60;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp < 100',
    20000, '冰封圈外扣血');
  const coldState = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode, me = b.players.get(b.myId);
    const out = { hp: me.hp, slow: me.boat.slowTimer, stun: me.boat.stunTimer, flash: b.hurtFlash };
    b.safeRing = null; b.safeRingTick = 0; b.hexPrefix = null;
    return JSON.stringify(out);
  })()`));
  report(coldState.slow > 1 && coldState.stun === 0 && coldState.flash === 0,
    `圈外保留冰封减速但不晕不闪（slow=${coldState.slow?.toFixed(2)} stun=${coldState.stun} flash=${coldState.flash}）`);

  // ---------- ⑭ 图表里其余受击姿态（故意不传 kind，验来源文案兜底） ----------
  const cases = [
    ['burn', '🔥 喷火吐息', 'bodyTintKind', 'burn'],
    ['frost', '❄ 霜雪吐息', 'bodyTintKind', 'frost'],
    ['knockback', '🐗 冲锋突刺', 'stunTimer', 1],
    ['vortex', '🌀 追踪漩涡', 'pullT', 1],
    ['bubble', '🌊 裂海泉涌', 'bubbleLiftTimer', 2],
    ['launched', '⚔ 裂地雷锤', 'geyserLiftTimer', 1],
    ['grab', '🌑 暗影缠触', 'octoGrabTimer', 1],
  ];
  for (const [label, src, field, expect] of cases) {
    const result = await ev(`(function(){
      const b = window.__game.bossMode, me = b.players.get(b.myId);
      me.invuln = 0; me.alive = true; me.boat.shieldTimer = 0;
      me.boat.capsizeTimer = 0; me.pullT = 0; me.boat.spinTimer = 0;
      me.boat.bubbleLiftTimer = 0; me.boat.geyserLiftTimer = 0;
      me.boat.octoGrabTimer = 0; me.boat.stunTimer = 0;
      b.handleNet({ t: 'bossHit', hits: [{ id: b.myId, dmg: 5, src: ${JSON.stringify(src)} }] });
      const isPull = ${JSON.stringify(label)} === 'vortex';
      return JSON.stringify({
        field: isPull ? me.pullT : me.boat[${JSON.stringify(field)}],
        spin: me.boat.spinTimer,
        stun: me.boat.stunTimer,
        capsize: me.boat.capsizeTimer,
        slow: me.boat.slowTimer,
      });
    })()`);
    const got = JSON.parse(result);
    const ok = typeof expect === 'number' ? got.field >= expect : got.field === expect;
    // 冲锋：不再 360° 掀翻，只留默认顿挫 + 击退
    const extra = label === 'vortex' ? (got.spin === 0 && got.slow >= 2.5 && got.stun === 0)
      : label === 'knockback' ? (got.capsize === 0 && got.stun >= 1)
        : label === 'grab' ? (got.stun < 0.5) : true;
    report(ok && extra, `${label} 受击姿态生效（${field}=${got.field} spin=${got.spin} stun=${got.stun}）`);
  }

  // 染色到期必须恢复：材质是克隆出来的，不清会把同模型其他艇也染红。
  // 先掐掉所有外部伤害源：第一关噬海龙自带熔岩柱，站在上面每 tick 都会重新上 burn，
  // 不清干净时这条断言会随机假红（timer 被刷回 ~1.1s，见 2026-11-22 两次偶发）。
  await ev(`(function(){
    try {
      const b = window.__game.bossMode;
      if (Array.isArray(b.hazards)) b.hazards.length = 0;
      if (Array.isArray(b.lavaZones)) { for (const z of b.lavaZones) z.dead = true; b.lavaZones.length = 0; }
      if (Array.isArray(b.delayedHits)) b.delayedHits.length = 0;
      b.bossStatus.silence = 99;
      if (b.boss?.status) b.boss.status.silence = 99;
      const me = b.players.get(b.myId);
      me.hp = 100; me.alive = true;
    } catch (e) { /* 字段不存在就跳过 */ }
    return 1;
  })()`);
  await sleep(700);
  await ev(`(function(){
    const me = window.__game.bossMode.players.get(window.__game.bossMode.myId);
    me.boat.applyFx('burn', 2);
    me.boat.bodyTintTimer = 0.001;
    return 1;
  })()`);
  await sleep(450);
  const tintAfter = await ev(`(() => {
    const me = window.__game.bossMode.players.get(window.__game.bossMode.myId);
    return JSON.stringify({ kind: me.boat.bodyTintKind, timer: me.boat.bodyTintTimer });
  })()`);
  const tintVal = JSON.parse(tintAfter);
  report(tintVal.kind === null && tintVal.timer === 0,
    `红热染色到期自动恢复（不会污染共享材质｜kind=${tintVal.kind} timer=${tintVal.timer}）`);

  // 只放行「游戏侧」异常：Effekseer/WASM 那几条是这台无头机的既有问题
  // （用 HEAD 版本跑同一场景同样崩，见 tests/boss_gameplay.mjs 的现状），
  // 和本次道具改动无关，不该让它们把玩法验收拖红。
  const engineNoise = (d) => /effekseer\.min\.js|wasm:\/\/|texImage2D|getParameter|ContextStates|reading 'uniforms'/
    .test(d);
  const fatal = errors.filter((d) => !engineNoise(d));
  if (fatal.length) fail('页面异常：' + fatal.slice(0, 3).map((d) => d.split('\n')[0]).join(' | '));
  console.log(failed ? `\n怪物模式道具改动：${failed} 项失败` : '\n怪物模式道具改动：全部通过');
} catch (e) {
  failed += 1;
  console.error('探针异常：', e.message);
} finally {
  try { ws?.terminate(); } catch { /* */ }
  try { child?.kill('SIGKILL'); } catch { /* */ }
  server.kill('SIGKILL');
  await wait(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => { /* */ });
  process.exit(failed ? 1 : 0);
}
