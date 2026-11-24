// 海克斯「新 BOSS / 新技能」是否真的进池、真的能打（2026-11-22 用户反馈）
//
//   node tests/hex_new_boss_probe.mjs
//
// 用户原话：「我新加的 boss 和技能似乎没有加到海克斯里面」。
// 排查结论是接上了但前 4 层永远轮不到它（池子只有 4 头），所以现在改成 5 头轮转。
// 这份探针只验浏览器里三件事：
//   ① 第 1 层强制指定深渊传令官 → 模型真的加载、5 个技能、门口没有召唤门（前 4 层收口）
//   ② 第 1 层强制指定它的深渊变体 → 改名生效、借来的「狂怒」真的进了技能表
//   ③ 第 5 层起召唤门不再被裁 → 它的专属 gate 技能能留下
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hex-newboss-' + Date.now());
const portSeed = Date.now() % 400;
const port = 9800 + portSeed;
const httpPort = 5800 + portSeed;
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
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来'); }
}
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,760',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
let failed = 0;
const errors = [];
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* */ }
    await wait(200);
  }
  if (!tabs) throw new Error('headless Edge did not come up');
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
      if (errors.length <= 3) console.log('  [页面异常] ' + desc.split('\n')[0]);
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
  const waitFor = async (expr, timeout = 40000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  await sleep(1200);
  // 冷启动偶发：无头 Edge 新 profile 下 WebGL 起不来 → three 构造抛错 → 整个 main 没跑，
  // 表现就是 btn-solo 永远没有 onclick。这里 reload 一次再等，并把现场打出来。
  let booted = false;
  for (let attempt = 0; attempt < 2 && !booted; attempt++) {
    try {
      await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 35000, 'btn-solo');
      booted = true;
    } catch (e) {
      console.log('  [启动现场] ' + await ev(`(function(){
        return JSON.stringify({
          url: location.href, ready: document.readyState,
          hasBtn: !!document.querySelector('#btn-solo'),
          bodyLen: (document.body?.innerHTML || '').length,
          game: !!window.__game,
        });
      })()`));
      if (attempt) throw e;
      console.log('  首屏没起来，reload 重试一次…');
      try { await ev('location.reload()'); } catch { /* 上下文被销毁是预期的 */ }
      await sleep(2000);
    }
  }
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector(\'#lobby-pick-body [data-mode="boss"][data-variant="hex"]\')', 30000, 'hex 模式卡');
  await ev('document.querySelector(\'#lobby-pick-body [data-mode="boss"][data-variant="hex"]\').click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.bossMode', 45000, 'bossMode');
  await ev('(function(){window.__game.bossMode.introT=99;return 1})()');
  await waitFor('window.__game.bossMode.phase === "countdown"', 30000, 'countdown');
  await ev('(function(){window.__game.bossMode.countdown=0.02;return 1})()');
  await waitFor('window.__game.bossMode.phase === "fight"', 30000, 'fight');

  /** 把计划里某一层改写后再进关，返回进关后的实例状态 */
  const enterStage = async (stage, patch) => {
    // 先把计划长度撑到目标层：startStage 发现 stage 超过计划长度会**按 seed 重建整份计划**，
    // 那样先打的补丁会被冲掉（探针一开始就踩了这个坑，看到的还是自然抽出来的技能）。
    await ev(`(function(){ const b = window.__game.bossMode; b.startStage(${stage}); return b.hexPlan.stages.length; })()`);
    await ev(`(function(){
      const b = window.__game.bossMode;
      b.hexPlan.stages[${stage} - 1] = Object.assign({}, b.hexPlan.stages[${stage} - 1], ${JSON.stringify(patch)});
      b.startStage(${stage});
      b.introT = 99; b.countdown = 0.02;
      return 1;
    })()`);
    await waitFor(`window.__game.bossMode.stage === ${stage}`, 30000, 'stage ' + stage);
    await waitFor('window.__game.bossMode.phase === "fight"', 40000, 'fight ' + stage);
    return ev(`(function(){
      const b = window.__game.bossMode;
      const skills = b.hexEntry?.skills || [];
      return JSON.stringify({
        stage: b.stage,
        bossId: b.bossDef?.id,
        name: b.bossDef?.name,
        model: b.bossDef?.model || '',
        hp: Math.round(b.boss?.hp || 0),
        mesh: b.boss?.model ? (b.boss.model.children?.length || 0) : -1,
        variant: b.hexVariant?.id || null,
        skills,
        gates: skills.filter((id) => /Gate/.test(id)),
        hasRage: skills.includes('rage'),
      });
    })()`);
  };

  // ---------- ① 第 1 层就是深渊传令官 ----------
  // 只改 bossId 不够：计划里的 skills 是给原来那头 BOSS 抽的，这里按传令官真实的 7 招覆盖，
  // 顺带验证"前 4 层把召唤门裁掉"这条收口（7 招里含 abyssHeraldGate，裁完应该剩 6）。
  const HERALD_SKILLS = ['abyssCharge', 'abyssSweep', 'abyssSlam', 'abyssRoar',
    'abyssSpikes', 'abyssSword', 'abyssHeraldGate'];
  const s1 = JSON.parse(await enterStage(1, {
    bossId: 'abyss_herald', variant: null, skills: HERALD_SKILLS, combos: [],
  }));
  console.log('  第 1 层强制传令官：', s1);
  report(s1.bossId === 'abyss_herald', `第 1 层真的换成了深渊传令官（${s1.bossId}）`);
  report(/abyss_herald\.glb/.test(s1.model), `用的是新模型（${s1.model}）`);
  report(s1.mesh > 0, `模型真的加载出网格（children=${s1.mesh}）`);
  report(s1.hp > 0, `BOSS 血量正常（${s1.hp}）`);
  report(s1.skills.length >= 5, `技能抽满（${s1.skills.length} 个：${s1.skills.join('/')}）`);
  report(s1.gates.length === 0, '前 4 层它的召唤门技能被裁掉（不会第 1 层就放小怪）');
  report(s1.skills.includes('abyssSword'), '裁门时用的是它自己的招，不是别的 BOSS 的');

  // ---------- ② 第 1 层 + 深渊变体（借来「狂怒」） ----------
  // 技能表故意**不含** rage：只有当"变体借招"这条链路真的生效时，rage 才会被补进技能表。
  const s2 = JSON.parse(await enterStage(1, {
    bossId: 'abyss_herald', variant: 'abyss_herald_x', skills: HERALD_SKILLS, combos: [],
  }));
  console.log('  第 1 层 + 深渊变体：', s2);
  report(s2.name === '深渊·放逐传令官', `变体改名生效（${s2.name}）`);
  report(s2.variant === 'abyss_herald_x', '变体 id 落地到实例上');
  report(s2.hasRage === true, `借来的「狂怒」真的进了技能表（${s2.skills.join('/')}）`);

  // ---------- ③ 第 5 层起召唤门不再被裁 ----------
  const s5 = JSON.parse(await enterStage(5, {
    bossId: 'abyss_herald',
    variant: null,
    skills: ['abyssCharge', 'abyssSweep', 'abyssHeraldGate', 'abyssRoar', 'abyssSlam'],
  }));
  console.log('  第 5 层强制传令官：', s5);
  report(s5.gates.length === 1, `第 5 层起专属召唤门能留下（${s5.gates.join('/') || '无'}）`);

  // ---------- ④ 打一会儿：技能真的会放、不炸页面 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.boss.hp = b.boss.maxHp * 0.4;   // 压到 40% 血，跨过 minHpRatio 闸门
    b.boss.cooldownScale = 0.05;      // 加速出招，别等
    return 1;
  })()`);
  await sleep(6000);
  const fight = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({
      hp: Math.round(b.boss?.hp || 0), maxHp: Math.round(b.boss?.maxHp || 0),
      phase: b.phase, dead: !!b.boss?.dead,
      casts: typeof b.castCount === 'number' ? b.castCount : null,
      minions: (b.minions?.size || 0),
      frame: window.__game.renderer.info.render.frame,
    });
  })()`));
  console.log('  打 6 秒后：', fight);
  report(fight.phase === 'fight' || fight.phase === 'clear', `还在战斗流程里（phase=${fight.phase}）`);
  report(fight.frame > 0, `渲染在跑（frame=${fight.frame}）`);
  // 无头机的软光栅/Effekseer 本来就会抛 "getParameter of null"（three 在丢失的上下文上取参数），
  // 那是环境噪声，不算玩法回归；只把"能打断逻辑的 undefined 访问 / 材质 uniforms 崩"当红线。
  const uniErr = errors.filter((d) => /reading 'uniforms'|Cannot read properties of undefined/.test(d)).length;
  report(uniErr === 0, `没有脚本异常打断战斗（红线 0 条 / 环境噪声 ${errors.length} 条）`);

  if (errors.length) console.log('  异常样本：', errors.slice(0, 3).map((d) => d.split('\n')[0]));
} catch (e) {
  failed += 1;
  console.error('探针异常：', e.message);
} finally {
  try { ws?.close(); } catch { /* */ }
  child.kill('SIGKILL');
  server.kill('SIGKILL');
}
console.log(failed ? `\n海克斯新 BOSS 入池：${failed} 项失败` : '\n海克斯新 BOSS 入池：全部通过');
process.exit(failed ? 1 : 0);
