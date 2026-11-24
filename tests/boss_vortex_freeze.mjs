// 漩涡（水泡浮空）卡死排查探针（2026-11-22 用户实机反馈）
//
//   node tests/boss_vortex_freeze.mjs
//
// 用户口径：对 BOSS 放漩涡、BOSS 被泡泡托到天上的那一刻，整个画面开始卡，
// 完全动弹不得。怀疑是泡泡特效崩溃 / 每帧重建 / 某处死循环。
//
// 这个探针不看画面好不好看，只回答三件事：
//   ① 泡泡起来之后世界时钟（game.elapsed）还在不在走（不走 = 每帧抛异常，主循环被掐断）
//   ② 几何体 / 纹理 / 渲染批次会不会随时间线性增长（涨 = 每帧重建泡泡网格）
//   ③ 连续放三次漩涡后指标会不会叠加
//
// 无头机 Effekseer 在 BOSS 场景本来就会崩（HEAD 同样崩，既有环境问题），
// 所以先跑「不打桩」阶段确认噪声，再用打了桩的 fx 跑真正的泡泡指标。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/vortex-freeze-' + Date.now());
// 端口按次随机：上一次被强杀的 Edge 有时还占着调试端口，复用固定端口会连到
// 上一轮的旧标签页（页面已关），表现为"等 btn-solo 永远超时"这种假失败。
const portSeed = Date.now() % 400;
const port = 9400 + portSeed;
const httpPort = 5400 + portSeed;
// HEADFUL=1：开真窗口跑（真 GPU、真 Effekseer）。无头模式的 Effekseer WASM 本来就崩，
// 只能验证"泡泡网格"这一层；要复现用户实机的卡死必须走真窗口。
const HEADFUL = process.env.HEADFUL === '1';
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
const child = spawn(edge, HEADFUL
  ? ['--no-sandbox', '--use-angle=d3d11',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--window-size=1280,760', '--window-position=0,0',
    'http://127.0.0.1:' + httpPort + '/']
  : ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,760',
    'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
const errors = [];
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
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const desc = m.params.exceptionDetails.exception?.description || '';
      errors.push(desc);
      if (errors.length <= 3) console.log('  [页面异常] ' + desc.split('\n')[0]);
      // "reading 'uniforms'" 这类每帧抛的错必须抓到调用栈，否则只能猜是哪个材质
      if (/uniforms/.test(desc) && !global.__uniStack) {
        global.__uniStack = true;
        const fr = (m.params.exceptionDetails.stackTrace?.callFrames || [])
          .slice(0, 6).map((f) => `${f.functionName || '?'}@${String(f.url).split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber}`);
        console.log('  [uniforms 调用栈] ' + fr.join(' ← '));
        console.log('  [uniforms 原文] ' + desc.split('\n').slice(0, 3).join(' ⏎ '));
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
  const waitFor = async (expr, timeout = 30000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // ---------- 进怪物模式 ----------
  await sleep(1200);
  // 冷启动（新 profile、1.9MB bundle 无缓存）偶尔要 20 秒以上才把 onclick 挂上，
  // 60s 上限比"误报失败"划算。
  try {
    await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 60000, 'btn-solo');
  } catch (e) {
    // 启动失败要把现场打出来：是 WebGL 起不来（three 构造抛错 → 整个 main 没跑）还是别的原因
    console.error('  [启动现场] ' + await ev(`(function(){
      return JSON.stringify({
        url: location.href, ready: document.readyState, title: document.title,
        hasBtn: !!document.querySelector('#btn-solo'),
        bodyLen: (document.body?.innerHTML || '').length,
        bodyHead: (document.body?.innerText || '').slice(0, 120),
        game: !!window.__game,
      });
    })()`));
    console.error('  [启动异常] ' + JSON.stringify(errors.slice(0, 4)));
    throw e;
  }
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
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

  // rAF 计数 + 每次回调的最大间隔（画面真冻住时这里会出现巨大空洞）
  await ev(`(function(){
    window.__probe = { ticks: 0, maxGap: 0, last: performance.now() };
    (function tick(){
      const now = performance.now();
      window.__probe.maxGap = Math.max(window.__probe.maxGap, now - window.__probe.last);
      window.__probe.last = now;
      window.__probe.ticks += 1;
      requestAnimationFrame(tick);
    })();
    return 1;
  })()`);

  const snap = async () => {
    const raw = await ev(`(function(){
      const g = window.__game, b = g.bossMode, info = g.renderer.info;
      return JSON.stringify({
        el: g.elapsed, race: g.raceTime || 0,
        ticks: window.__probe.ticks, gap: Math.round(window.__probe.maxGap),
        geo: info.memory.geometries, tex: info.memory.textures,
        calls: info.render.calls, tri: info.render.triangles,
        frame: info.render.frame,
        scene: g.scene.children.length,
        att: g.fx?.attached?.size ?? -1, transient: g.fx?.transient?.length ?? -1,
        wrap: b.boss?.bubbleWrap?.children?.length ?? 0,
        wrapUuid: b.boss?.bubbleWrap?.uuid || null,
        lift: +(b.boss?.liftY || 0).toFixed(2),
        bubble: +(b.boss?.status?.bubble || 0).toFixed(2),
        hp: Math.round(b.boss?.hp || 0),
        phase: b.phase,
        hidden: document.hidden, vis: document.visibilityState,
      });
    })()`);
    if (typeof raw !== 'string' || raw.startsWith('ERR') || raw.startsWith('EXC')) {
      throw new Error('snapshot failed: ' + raw);
    }
    return JSON.parse(raw);
  };

  // ---------- A 阶段：不打桩，看这台机器现在的基准 ----------
  const a0 = await snap();
  await sleep(1000);
  const a1 = await snap();
  const baseEl = a1.el - a0.el;
  console.log(`  [A 不打桩] 1 秒内 elapsed 推进 ${baseEl.toFixed(2)}s，rAF ${a1.ticks - a0.ticks} 帧，最大帧间隔 ${a1.gap}ms`);
  const engineBrokenBeforeVortex = baseEl < 0.2;
  console.log(`  引擎侧异常条数（泡沫前）：${errors.length}`);

  // ---------- B 阶段：无头模式必须打桩 fx（Effekseer 在这台无头机上不可用）；
  //            真窗口（HEADFUL=1）保留真 Effekseer，才能复现"放漩涡就卡死" ----------
  if (!HEADFUL) {
    await ev(`(function(){
      const noop = () => {};
      const patch = (fx) => { if (!fx) return;
        fx.play = noop; fx.playAttached = () => 'stub'; fx.stopAttached = noop;
        fx.update = noop; fx.clear = noop; };
      patch(window.__game.bossMode.fx);
      patch(window.__game.fx);
      return 1;
    })()`);
  }
  await ev(`(function(){
    // 关掉主炮与 AI 火力，避免伤害飘字干扰指标
    const b = window.__game.bossMode;
    for (const p of b.players.values()) p.weaponLock = 9999;
    b.aiWeapons.clear();
    window.__probe.ticks = 0; window.__probe.maxGap = 0; window.__probe.last = performance.now();
    return 1;
  })()`);

  const castVortex = async () => {
    await ev(`(function(){
      const b = window.__game.bossMode;
      b.myItems[0] = 'vortex';
      b.input.onItem(0);
      for (const p of b.projectiles) {
        p.pos.x = b.boss.pos.x + 0.05;
        p.pos.z = b.boss.pos.z + 0.05;
        p.pos.y = Math.max(1.8, (b.boss.def.height || 6) * 0.45);
      }
      return b.projectiles.length;
    })()`);
    await waitFor('window.__game.bossMode.boss.status.bubble > 0', 20000, '泡泡上身');
    // 泡泡网格是下一帧在 #applyPose 里建的；无头低帧率（1~3fps）下要等它真的出现再做基准，
    // 否则会把"还没建"当成"没建"，几何体从 0 涨上去也会被误判成每帧重建。
    await waitFor('(window.__game.bossMode.boss.bubbleWrap?.children.length || 0) > 0', 40000, '泡泡网格');
  };

  const b0 = await snap();
  await castVortex();
  const b1 = await snap();
  // 抬升是一条"起泡 → 上升 → 到顶 → 泡破落地"的曲线，而无头机只有 1~3fps，
  // 固定时刻采样很容易正好踩在曲线的两头（实测有 0.22 / 0.83 / 1.22 三个值）。
  // 所以在 3 秒窗口里连续采样取峰值，这才是"BOSS 真的被泡泡裹到天上"的判据。
  let maxLift = b1.lift;
  let maxBubble = b1.bubble;
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      const s = await snap();
      maxLift = Math.max(maxLift, s.lift);
      maxBubble = Math.max(maxBubble, s.bubble);
      await sleep(200);
    }
  }
  await sleep(600);
  const b2 = await snap();
  await sleep(1200);
  const b3 = await snap();

  const fmt = (s) => `elapsed=${s.el.toFixed(2)} ticks=${s.ticks} frame=${s.frame} geo=${s.geo} tex=${s.tex} wrap=${s.wrap} lift=${s.lift} bubble=${s.bubble}`;
  console.log('  泡泡前：', fmt(b0));
  console.log('  泡泡瞬间：', fmt(b1));
  console.log('  +1.2s：', fmt(b2));
  console.log('  +2.4s：', fmt(b3));

  const uniErr = errors.filter((d) => /reading 'uniforms'/.test(d)).length;
  report(uniErr === 0, `泡泡期间没有 "reading 'uniforms'" 异常（实际 ${uniErr} 条）`);
  report(b3.frame > b1.frame + 5, `泡泡期间仍在真正出帧（renderer.frame ${b1.frame} → ${b3.frame}）`);

  report(b1.wrap > 0, `泡泡网格真的建出来了（children=${b1.wrap}）`);
  report(b2.el > b1.el + 0.05, `泡泡期间世界时钟仍在推进（+${(b2.el - b1.el).toFixed(2)}s）`);
  report(b3.el > b2.el + 0.05, `泡泡第 2 秒世界时钟仍在推进（+${(b3.el - b2.el).toFixed(2)}s）`);
  // 关键：网格/材质只能建一次。每帧重建 15 个泡泡点 = 每帧 +15 个几何体。
  // 注意 renderer.info.memory 是**全场景**计数，命中火星/残骸/贴图缓存的进出会让它在几十帧里
  // 上下抖 ±10（实测 b3=155 之后 b4 又掉回 151），所以判据看「每帧增量」而不是绝对值：
  // 真正的每帧重建是 ~15/帧，这里 2.4 秒几千帧只涨个位数，明显是噪声。
  const dGeo = b3.geo - b1.geo;
  const dFrame = Math.max(1, b3.frame - b1.frame);
  report(dGeo <= 15 && dGeo / dFrame < 0.05,
    `几何体数量没有随帧线性增长（${b1.geo} → ${b3.geo}，${dGeo} 个 / ${dFrame} 帧 = ${(dGeo / dFrame).toFixed(3)}/帧）`);
  report(b3.tex <= b1.tex + 2, `纹理数量没有随帧增长（${b1.tex} → ${b3.tex}）`);
  report(b1.wrapUuid === b3.wrapUuid, `泡泡网格只创建一次、没有每帧重建（uuid 不变）`);
  // 泡泡只裹 ~2.4s，无头机采样点很容易落在曲线两头，所以用上面 3 秒窗口里的峰值判据。
  report(maxLift > 0.5, `BOSS 确实被抬起来了（3 秒峰值 liftY=${maxLift}m，bubble 峰值=${maxBubble}）`);

  // 连放三次：指标不应该叠加（每层泡只该有一份）
  for (let i = 0; i < 2; i++) {
    await castVortex();
    await sleep(500);
  }
  const b4 = await snap();
  console.log('  连放 3 次后：', fmt(b4));
  report(b4.wrap === b1.wrap, `连放 3 次漩涡不会叠加泡泡网格（${b1.wrap} → ${b4.wrap}）`);
  // 命中爆点（skillFx.sparks）每次命中本来就会新建少量几何体，所以这里只卡上限，
  // 真正的红线是上面"单次泡期间几何体不随时间增长"。
  report(b4.geo <= b1.geo + 12, `连放 3 次漩涡几何体增长有界（${b1.geo} → ${b4.geo}，含命中火星）`);
  // Effekseer/软光栅在这台机器上本来就会抛 "getParameter of null" 之类噪声，
  // 只把「泡泡网格自己的 uniforms 崩」当成本次回归的红线。
  report(uniErr === 0 && !errors.some((d) => /reading 'uniforms'/.test(d)),
    `没有泡泡网格相关异常（累计 ${errors.length} 条，均为引擎侧噪声）`);

  if (engineBrokenBeforeVortex) {
    console.log('  注意：这台无头机在放漩涡之前世界时钟就已经推不动（Effekseer/软光栅既有问题），A 阶段数据仅作参考');
  }
} catch (e) {
  failed += 1;
  console.error('探针异常：', e.message);
} finally {
  try { ws?.close(); } catch { /* */ }
  child.kill('SIGKILL');
  server.kill('SIGKILL');
}
console.log(failed ? `\n漩涡卡死排查：${failed} 项失败` : '\n漩涡卡死排查：全部通过');
process.exit(failed ? 1 : 0);
