// 海克斯无尽「继续挑战 / 结束领奖」流程验收（2026-11-22 用户反馈）
//
//   node tests/hex_endless_flow_probe.mjs
//
// 用户口径：
//   ① 打完第 4 层要正中央弹出选择面板（以前只有一条 toast，界面啥也没有）
//   ② 面板期间**船还能开**（以前被锁在 endless 阶段，油门没反应）
//   ③ 选「继续挑战」→ **先弹三选一 → 选完卡才升起**去下一层的传送门，开进去到下一层
//      （2026-11-22 用户二次指定：先问继续/领奖，再选卡，选完卡才升门）
//   ④ 选「结束领奖」→ 直接升起回大厅的传送门，开进去直接回大厅
//
// 无头 1~3fps，全部用轮询；打 BOSS 直接 applyDamage 秒杀，弹道/走位都不等。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hex-endless-' + Date.now());
const portSeed = Date.now() % 400;
const port = 9500 + portSeed;
const httpPort = 5500 + portSeed;
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
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
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

  /** 把船按进门里：每 250ms 重新贴一次门心并清零速度（低帧率下载具惯性会把船带出去） */
  const enterPortal = async (doneExpr, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const ok = await ev(doneExpr);
      if (ok) return;
      await ev(`(function(){
        const b = window.__game?.bossMode; const p = b?.portal;
        if (!p) return 0;
        const me = b.players.get(b.myId);
        me.boat.pos.x = p.x; me.boat.pos.z = p.z;
        if (me.boat.vel) { me.boat.vel.x = 0; me.boat.vel.y = 0; }
        me.boat.speed = 0;
        return 1;
      })()`);
      await sleep(250);
    }
    throw new Error('timeout entering portal: ' + label);
  };

  const panelState = () => ev(`(function(){
    const el = document.getElementById('hex-endless');
    const b = window.__game?.bossMode;
    return JSON.stringify({
      hidden: el?.classList.contains('hidden'),
      go: document.getElementById('he-go')?.disabled,
      sub: (document.getElementById('he-sub')?.textContent || '').slice(0, 24),
      phase: b?.phase, stage: b?.stage,
      mode: b?.portalMode,
      portal: !!b?.portal,
      canControl: b?.canControl ? b.canControl() : null,
    });
  })()`);

  await sleep(1200);
  await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 30000, 'btn-solo');
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

  // 直接跳到第 4 层（本局计划的最后一层），打死 BOSS，等清关计时走到无尽选择
  const killBossAt = async (stage) => {
    await ev(`(function(){
      const b = window.__game.bossMode;
      b.startStage(${stage});
      b.introT = 99; b.countdown = 0.02; b.clearT = 0.05;
      return 1;
    })()`);
    await waitFor(`window.__game.bossMode.stage === ${stage}`, 30000, 'stage ' + stage);
    await waitFor('window.__game.bossMode.phase === "fight"', 40000, 'fight ' + stage);
    await ev('(function(){ const b = window.__game.bossMode; b.boss.applyDamage(999999); return 1 })()');
    // 通关三选一：能点就直接点第一张，别等 20 秒超时（面板要等选完卡才弹）
    await waitFor('window.__game.bossMode.phase === "clear"', 40000, 'clear ' + stage);
    await sleep(400);
    await ev(`(function(){
      const b = window.__game.bossMode;
      if (b.hexCardOffer) b.pickHexPick(b.hexCardOffer.cards[0].id);
      b.clearT = Math.min(b.clearT ?? 0.05, 0.05);
      return 1;
    })()`);
    await waitFor('window.__game.bossMode.phase === "endless"', 45000, 'endless ' + stage);
  };

  // ---------- ① 第 4 层通关：面板必须真的弹出来，而且船能开 ----------
  await killBossAt(4);
  await waitFor('!document.getElementById("hex-endless").classList.contains("hidden")', 20000, '面板可见');
  const s1 = JSON.parse(await panelState());
  console.log('  第 4 层通关后：', s1);
  report(s1.hidden === false, '选择面板真的显示出来了（不再是只有一条 toast）');
  report(s1.go === false, '「继续挑战」按钮可以点');
  report(s1.canControl === true, '面板期间可以操控赛艇（canControl=true）');
  report(s1.portal === false, '面板阶段还没有升门（选完才升）');

  // 真的把船开起来：按住油门，看输入是否真的进了船体。
  // 无头机 1~3fps 且 dt 被截到 0.05，2.5 秒真实时间只推进零点几秒模拟时间，
  // 所以不看绝对速度，只看三件事：输入没被冻结 / 船速从 0 起来 / 松开后回落。
  await ev('(function(){const i=window.__game.opts.input;i.keys.add("arrowup");return 1})()');
  await sleep(3000);
  const drive = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode; const me = b.players.get(b.myId);
    return JSON.stringify({
      throttle: window.__game.opts.input.throttle,
      speed: +(me.boat.speed||0).toFixed(3),
      x: +me.boat.pos.x.toFixed(2), z: +me.boat.pos.z.toFixed(2),
    });
  })()`));
  await ev('(function(){window.__game.opts.input.keys.delete("arrowup");return 1})()');
  await sleep(1200);
  const coast = +(await ev('(function(){const b=window.__game.bossMode;const me=b.players.get(b.myId);return +(me.boat.speed||0).toFixed(3)})()'));
  console.log('  面板期间开船：', drive, '松开后 speed=', coast);
  report(drive.throttle === 1, `面板期间油门输入没有被冻结（throttle=${drive.throttle}）`);
  report(drive.speed > 0.02, `面板期间船真的动了（speed=${drive.speed}）`);
  report(drive.speed > coast, `松开油门后速度回落（${drive.speed} → ${coast}）`);

  // ---------- ② 选「继续挑战」→ 先选卡 → 选完才升门 → 开进门 → 第 5 层 ----------
  await ev('document.getElementById("he-go").click()');
  // 新顺序：继续挑战不是直接升门，而是先把本层三选一放出来（BOSS 倒下时没发）
  await waitFor('!!window.__game.bossMode.hexCardOffer', 20000, '继续后先弹三选一');
  const s2a = JSON.parse(await panelState());
  const cardUi = await ev(`(function(){
    const el = document.getElementById('hex-cards');
    const btn = el?.querySelector('.hex-card');
    return JSON.stringify({
      visible: !!el && !el.classList.contains('hidden'),
      count: el ? el.querySelectorAll('.hex-card').length : 0,
      text: (btn?.textContent || '').trim().slice(0, 18),
    });
  })()`);
  const s2b = JSON.parse(cardUi);
  console.log('  选继续后（选卡前）：', s2a, s2b);
  report(s2a.hidden === true, '选完后选择面板收起');
  report(s2a.portal === false, '选继续后还没升门（先选卡，顺序对了）');
  report(s2b.visible && s2b.count >= 2, `选卡面板真的显示出来了（${s2b.count} 张：${s2b.text}）`);
  report(s2a.canControl === true, '选卡期间船还能开（不锁舵）');

  // 点第一张卡（走真实 UI 点击，不直接调方法，确认按钮链路通）
  await ev(`(function(){
    document.querySelector('#hex-cards .hex-card').click();
    return 1;
  })()`);
  await waitFor('!window.__game.bossMode.hexCardOffer', 20000, '卡已选中');
  await waitFor('window.__game.bossMode.phase === "portal"', 20000, 'next portal');
  const s2 = JSON.parse(await panelState());
  console.log('  选完卡后：', s2);
  report(s2.mode === 'next' && s2.portal === true, `选完卡才升起「去下一层」的门（mode=${s2.mode}）`);
  await enterPortal('window.__game.bossMode.stage === 5', '第 5 层');
  await waitFor('window.__game.bossMode.stage === 5', 45000, '第 5 层');
  const s3 = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({ stage: b.stage, phase: b.phase, portal: !!b.portal, mode: b.portalMode });
  })()`));
  console.log('  进门后：', s3);
  report(s3.stage === 5, `进门后进到第 5 层（stage=${s3.stage}）`);
  report(s3.portal === false, '换层时门已收起');

  // ---------- ③ 第 5 层通关：选「结束领奖」→ 升门 → 进门直接回大厅 ----------
  await killBossAt(5);
  await waitFor('!document.getElementById("hex-endless").classList.contains("hidden")', 20000, '第 5 层面板');
  const bestBefore = await ev('Number(localStorage.getItem("rr-hex-best") || 0)');
  await ev('document.getElementById("he-stop").click()');
  await waitFor('window.__game?.bossMode?.phase === "portal"', 20000, 'lobby portal');
  const s4 = JSON.parse(await panelState());
  console.log('  选领奖后：', s4);
  report(s4.mode === 'lobby' && s4.portal === true, `选领奖后升起的是「回大厅」的门（mode=${s4.mode}）`);
  report(s4.canControl === true, '领奖门阶段仍然能开船（自己开进去）');
  await enterPortal('document.getElementById("hud")?.classList.contains("hidden")', '回大厅');
  // 回大厅 = HUD 收起 + 对局释放（window.__game 是调试引用，dispose 后不会自动清空，
  // 所以用 #hud 的 hidden 作为"已经离开对局"的判据）
  await waitFor('document.getElementById("hud")?.classList.contains("hidden")', 25000, '回大厅（HUD 收起）');
  const after = await ev(`JSON.stringify({
    hudHidden: document.getElementById('hud')?.classList.contains('hidden'),
    menuVisible: !document.getElementById('home')?.classList.contains('hidden'),
    best: Number(localStorage.getItem('rr-hex-best') || 0),
  })`);
  const s5 = JSON.parse(after);
  console.log('  进门后：', s5, '（进门前最佳层数：' + bestBefore + '）');
  report(s5.hudHidden === true, '开进领奖门后离开对局（HUD 已收起，回到大厅/主菜单）');
  report(s5.best >= 5, `本次通过层数已记账（最佳=${s5.best}）`);
} catch (e) {
  failed += 1;
  console.error('探针异常：', e.message);
} finally {
  try { ws?.close(); } catch { /* */ }
  child.kill('SIGKILL');
  server.kill('SIGKILL');
}
console.log(failed ? `\n海克斯无尽选择流程：${failed} 项失败` : '\n海克斯无尽选择流程：全部通过');
process.exit(failed ? 1 : 0);
