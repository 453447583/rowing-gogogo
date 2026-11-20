// 潮汐竞技场（1v1）冒烟验收：
//   ① 模式能进，phase 从 countdown 走到 fight，无页面异常
//   ② AI 对手存在且会动（第 2 帧位置与出生点不同）
//   ③ 本地按 J 开火能打掉 AI 的血（证明「假 BOSS 代理」这条链路真的通了）
//   ④ 把 AI 血打到 0 会扣命并进入 roundEnd
//
//   node tests/arena_smoke.mjs
//
// 无头渲染只有 1~3 fps，所有断言都靠轮询状态变化，不用固定 sleep 卡时间。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// 每次用独立 profile：固定目录在上一轮 Edge 还没退干净时会被锁住，
// 新启动的实例会把 URL 交给老实例然后自己退出，表现就是 CDP 连上了但状态乱跳
const profile = path.resolve('D:/3dgame-tmp/browser/arena-smoke-' + Date.now());
const port = 9341;
const httpPort = 5173;
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 静态服务必须先就绪再启 Edge：抢跑的话首页会拿到 ERR_CONNECTION_REFUSED，
// 页面永久停在错误页（后面所有断言都变成"没加载完"的假失败）
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch {}
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来（端口 ' + httpPort + '）'); }
}
// 不再加 --disable-gpu：软件光栅下每关首次编译着色器会把主线程锁死几十秒（CDP 都没响应），
// 表现为"第 2/3 关开局页面假死"。用硬件加速的 headless 帧率也能从 1~3fps 提到 60fps。
const child = spawn(edge, ['--headless=new', '--no-sandbox',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=960,560',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });
let ws;
const errors = [];
const fail = (m) => { throw new Error(m); };
const ok = (cond, label) => { if (cond) console.log('  ✓ ' + label); else fail(label); };

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
      const d = m.params.exceptionDetails;
      const msg = (d.exception?.description || d.text || '').split('\n')[0];
      // 无头 Edge 软件光栅下 Effekseer 贴图会报 texImage2D overload，真机不出现，不算失败
      if (msg.includes('texImage2D')) return;
      // 带上出错的脚本 URL：只说"私有字段没声明"根本定不到是哪个文件
      errors.push(msg + (d.url ? ' @' + d.url : '') + (d.scriptId ? ' #' + d.scriptId : ''));
    }
    if (m.method === 'Inspector.targetCrashed') {
      errors.push('!! 渲染进程崩溃（Inspector.targetCrashed）');
      // 崩溃后所有 evaluate 都不会回了，直接把等待中的请求打醒，别干等 45s 超时
      for (const q of pending.values()) q.rej(new Error('renderer crashed'));
      pending.clear();
    }
  });
  ws.on('close', () => {
    for (const q of pending.values()) q.rej(new Error('cdp closed'));
    pending.clear();
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    // 没有超时会卡死整个脚本（浏览器崩了 / 端口被上一轮占着时就是这样）
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        pending.delete(id);
        rej(new Error('cdp timeout ' + method));
      }, 45000);
      pending.set(id, {
        res: (v) => { clearTimeout(t); res(v); },
        rej: (e) => { clearTimeout(t); rej(e); },
      });
    });
  };
  await cdp('Runtime.enable');
  // 提前开 Debugger 域：假死时 dumpHang 要发 Debugger.pause，没 enable 就不会有回调
  await cdp('Debugger.enable').catch(() => {});
  const sleep = async (ms) => {
    try {
      return await cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
    } catch (e) {
      if (/^cdp timeout/.test(e.message)) await dumpHang('sleep ' + ms);
      throw e;
    }
  };
  const ev = async (expr) => {
    let r;
    try {
      r = await cdp('Runtime.evaluate', {
        expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
        returnByValue: true,
      });
    } catch (e) {
      // 任何一次 evaluate 超时都先抓一次栈，别指望包在外面的 try 恰好命中
      if (/^cdp timeout/.test(e.message)) await dumpHang(String(expr).replace(/\s+/g, ' ').slice(0, 60));
      throw e;
    }
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 30000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(300);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };
  // 页面"假死"时用 V8 的异步中断抓调用栈：死循环能定到具体行；抓不到说明不是 JS 卡住
  let onPaused = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.method === 'Debugger.paused' && onPaused) { const f = onPaused; onPaused = null; f(m.params); }
  });
  const dumpHang = async (tag) => {
    console.log('!! 页面无响应（' + tag + '），尝试 Debugger.pause 抓栈');
    const p = new Promise((res) => { onPaused = res; });
    ws.send(JSON.stringify({ id: ++seq, method: 'Debugger.pause', params: {} }));
    const params = await Promise.race([p, new Promise((r) => setTimeout(() => r(null), 10000))]);
    if (!params) {
      console.log('   pause 无回调 → 不是 JS 死循环，更像渲染/GPU 卡死');
      return;
    }
    for (const f of params.callFrames.slice(0, 15)) {
      console.log('   ', f.functionName || '(anon)', (f.url || '').split('/').pop(), 'L' + (f.location.lineNumber + 1));
    }
    ws.send(JSON.stringify({ id: ++seq, method: 'Debugger.resume', params: {} }));
  };

  // ---------- 开局：单人 → 大厅里选船 / 模式 / AI → 发车 ----------
  // 不要再走 .boat-card + #btn-boat-ok 这条老链：那套元素还留在 DOM 里但是空壳，
  // 一旦 boat-card 还没渲染出来（模块加载快慢不定），点它就是个静默 no-op，
  // 结果 #btn-map-ok 因为"还没选艇"直接 return，页面永远没有 __game。
  await sleep(1200);
  await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 25000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 25000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor('!!document.querySelector("#lobby-pick-body [data-boat=\\"titan\\"]")', 20000, '选艇抽屉');
  await ev('document.querySelector("#lobby-pick-body [data-boat=\\"titan\\"]").click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector("#lobby-pick-body [data-mode=\\"arena\\"]")', 20000, '模式抽屉');
  await ev('document.querySelector("#lobby-pick-body [data-mode=\\"arena\\"]").click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  // 单人竞技场需要至少一个 AI 对手（大厅设置抽屉里的 #sel-ai 才是现在真正管用的控件）
  await ev(`(function(){
    const sel = document.querySelector("#sel-ai");
    if (sel) { sel.value = "1"; if (sel.onchange) sel.onchange(); }
    return 1;
  })()`);
  await ev('document.querySelector("#btn-start-race").click()');
  // 别用固定 sleep：包体积变大后 6 秒不一定加载完，会误报 "mode 不是 arena"
  await waitFor('!!window.__game && !!window.__game.bossMode', 40000, 'game boot');

  const mode = await ev('window.__game && window.__game.mode');
  if (mode !== 'arena') fail('mode 不是 arena，实际 = ' + mode);
  console.log('① 模式：', mode, '｜ players =', await ev('window.__game.bossMode.players.size'));

  // 降分辨率提帧率（软件光栅下 1~3 fps）
  await ev('(function(){ const g=window.__game; g.renderer.setSize(320,200); return 1; })()');

  await waitFor('window.__game.bossMode.phase === "countdown"', 25000, 'countdown');
  await ev('(function(){ const b=window.__game.bossMode; b.intro=0.01; b.cinema=0; b.countdown=0.02; return 1; })()');
  // 开场动画 7s + 倒计时 3s，无头低帧率下游戏时间走得慢，超时给足
  await waitFor('window.__game.bossMode.phase === "fight"', 150000, 'fight');
  console.log('② phase 进入 fight');

  const foeId = await ev('window.__game.bossMode.foeId');
  if (!foeId) fail('没有对手 foeId');
  const spawnPos = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const boat = b.boats.get(b.foeId);
    return JSON.stringify({ x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
  })()`));
  await sleep(6000);
  const movedPos = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const boat = b.boats.get(b.foeId);
    return JSON.stringify({ x: +boat.pos.x.toFixed(1), z: +boat.pos.z.toFixed(1) });
  })()`));
  const moved = Math.hypot(movedPos.x - spawnPos.x, movedPos.z - spawnPos.z);
  console.log('③ AI 走位位移 =', moved.toFixed(1), 'm', spawnPos, '→', movedPos);
  // 软件光栅只有 1~3 fps，位移量随帧率剧烈波动（实测 1.1~4.2m），
  // 所以真正的判据是 driveAi 的**输出**，而不是墙钟时间内的位移。
  const aiCmd = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const boat = b.boats.get(b.foeId);
    const cmd = b.driveAi(0.016, boat, b.foeId);
    return JSON.stringify(cmd);
  })()`));
  console.log('   driveAi 输出 =', JSON.stringify(aiCmd));
  if (!aiCmd || !aiCmd.throttle) fail('driveAi 没给出油门，AI 不会动');
  if (moved < 0.3) fail('AI 实际位移过小: ' + moved);
  const drift = Math.abs(Math.hypot(movedPos.x, movedPos.z) - Math.hypot(spawnPos.x, spawnPos.z));
  console.log('   离场心半径变化 =', drift.toFixed(1), 'm（正常应向内收，不应往外漂）');

  // ---------- 开火打掉 AI 的血 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const foe = b.boats.get(b.foeId);
    const me = b.localBoat;
    // 把对手摆到正前方 22m，船头对准他：辅助角 ±8° 内必中
    me.pos.x = 0; me.pos.z = 0; me.heading = 0;
    foe.pos.x = 0; foe.pos.z = 22; foe.heading = Math.PI;
    const fp = b.players.get(b.foeId);
    fp.hp = 300; fp.alive = true; fp.invuln = 0; fp.lives = 3;
    b.players.get(b.myId).invuln = 99;   // 本机别被反打，专注测命中
    window.__input = window.__input || null;
    return 1;
  })()`);
  // 通过输入层按 J：Input.fire 读的是 keys 集合
  await ev(`(function(){
    const inp = window.__game.opts.input;
    inp.keys.add("j");
    return inp.fire;
  })()`);
  const hpBefore = await ev('window.__game.bossMode.players.get(window.__game.bossMode.foeId).hp');
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.foeId).hp < 300', 30000, 'AI 掉血');
  const hpAfter = await ev('window.__game.bossMode.players.get(window.__game.bossMode.foeId).hp');
  console.log('④ 开火命中：AI hp', hpBefore, '→', hpAfter);
  if (!(hpAfter < hpBefore)) fail('开火没造成伤害');

  // 伤害飘字：打中了必须看得到数字，否则就是干巴巴的互射
  const dmgTexts = await ev('window.__game.bossMode.dmgTexts.length');
  console.log('   命中飘字数量 =', dmgTexts);
  if (!(dmgTexts > 0)) fail('没有命中飘字');

  // 手感参数：炮塔辅助角必须够大，否则又退回"迎面对冲"
  const cfg = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const w = b.weapons.get(b.myId);
    const rs = b.items.boxes.map(x => Math.hypot(x.x, x.z));
    return JSON.stringify({
      turretYaw: +w.turretYaw.toFixed(2),
      boxMin: +Math.min(...rs).toFixed(0), boxMax: +Math.max(...rs).toFixed(0),
    });
  })()`));
  console.log('   炮塔辅助角 =', (cfg.turretYaw * 180 / Math.PI).toFixed(0) + '°',
    '｜道具箱半径 =', cfg.boxMin + '~' + cfg.boxMax + 'm');
  if (cfg.turretYaw < 0.5) fail('炮塔辅助角太小，侧身打不了，会变成对轰');
  if (cfg.boxMax > 52) fail('道具箱太靠外圈，抢箱子变跑腿');

  // 浮岩必须挡弹道：否则双方视线永远通畅，又退回"隔着固定距离比 DPS"
  const cover = await ev(`(function(){
    const w = window.__game.bossMode.weapons.get(window.__game.bossMode.myId);
    return w.opts.getObstacles().length;
  })()`);
  console.log('   挡弹掩体数量 =', cover);
  if (!(cover > 0)) fail('没有掩体，对轰无解');
  const hudCls = await ev('document.getElementById("hud").className');
  console.log('   HUD 模式类 =', hudCls);
  if (!hudCls.includes('arena-mode')) fail('竞技场血条样式类没生效');

  // ---------- ⑥ 道具箱与道具槽 ----------
  const itemState = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({
      boxes: b.items.boxes.length,
      pool: b.items.itemPool,
      bars: b.hpBars.size,
      barVisible: [...b.hpBars.values()].filter(x => x.spr.visible).length,
    });
  })()`));
  console.log('⑥ 道具箱 =', itemState.boxes, '｜池 =', itemState.pool.join(','), '｜血条可见 =', itemState.barVisible + '/' + itemState.bars);
  if (!(itemState.boxes >= 10)) fail('道具箱太少: ' + itemState.boxes);
  if (itemState.pool.length !== 10) fail('道具池不是 10 件: ' + itemState.pool.length);
  if (itemState.barVisible < 1) fail('血条没显示');

  // 手动塞一格道具并使用：验证 useItemSlot → ItemManager 这条链路
  await ev(`(function(){ const b = window.__game.bossMode; b.items.myItems[0] = "nitro"; return 1; })()`);
  const used = await ev(`(function(){ const b = window.__game.bossMode; return b.useItemSlot(0); })()`);
  const slotAfter = await ev('window.__game.bossMode.items.myItems[0]');
  console.log('⑦ 使用道具：consumed =', used, '｜槽位 =', slotAfter);
  if (used === false) fail('useItemSlot 返回 false');
  if (slotAfter !== null) fail('道具没有被消耗');

  // 伤害类道具：直接给对手挂「方向转换器」，验证它真的作用到了对手身上
  await ev(`(function(){ const b = window.__game.bossMode; b.items.myItems[0] = "tide"; return 1; })()`);
  await ev('window.__game.bossMode.useItemSlot(0)');
  await sleep(600);
  const tideState = await ev(`(function(){
    const b = window.__game.bossMode;
    const foe = b.boats.get(b.foeId);
    return JSON.stringify({ reverse: foe.reverseControlTimer || 0 });
  })()`);
  console.log('⑧ 方向转换器作用到对手：', tideState);
  await ev('(function(){ window.__game.opts.input.keys.delete("j"); return 1; })()');

  // AI 定住：后面测据点和技能都需要一个不跑的目标，否则一直在打空 / 抢不到圈
  await ev(`(function(){
    const b = window.__game.bossMode;
    const idle = { throttle: 0, steer: 0, drift: false, nitro: false };
    b.driveAi = () => idle;
    b.players.get(b.myId).invuln = 999;   // 本机别被 AI 打死，专注测机制
    return 1;
  })()`);

  // ---------- ⑨ 第 1 关「潮汐运送」：只有贴近核心才推得动 ----------
  // 这一关不再是"站圈攒进度"：核心是实体，谁贴近就往谁的进攻门走，
  // 到线直接判本关胜负。这里验：核心/球门存在 → 我靠近会推进 → 到线判分。
  const deliveryInit = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const g = b.deliveryGroup;
    return JSON.stringify({
      kind: b.roundKind,
      hasCore: !!b.coreHolder,
      visible: !!g && g.visible,
      goals: g ? g.children.filter((c) => c.type === 'Group').length : 0,
      side: b.deliverySide.get(b.myId),
    });
  })()`));
  console.log('⑨ 运送：关卡 =', deliveryInit.kind, '｜核心齐备 =', deliveryInit.hasCore,
    '｜球门 =', deliveryInit.goals, '｜推进方向 =', deliveryInit.side);
  if (deliveryInit.kind !== 'delivery') fail('第 1 关不是潮汐运送');
  if (!deliveryInit.hasCore || !deliveryInit.visible) fail('潮汐核心没有生成');
  if (deliveryInit.goals < 2) fail('球门不足两个');
  if (!deliveryInit.side) fail('没有阵营推进方向');

  // 我贴着核心、对手扔到 40m 外：核心应朝我的进攻门移动
  await ev(`(function(){
    const b = window.__game.bossMode;
    const side = b.deliverySide.get(b.myId);
    b.localBoat.resetTo(0, side * 4, 0);
    b.localBoat.speed = 0;
    b.boats.get(b.foeId).resetTo(0, -side * 40, Math.PI);
    const me = b.players.get(b.myId);
    me.hp = 300; me.alive = true; me.invuln = 99; me.respawn = 0;
    const fp = b.players.get(b.foeId);
    fp.hp = 300; fp.alive = true; fp.invuln = 99; fp.respawn = 0;
    b.delivery.z = 0; b.delivery.overtime = false;
    b.roundTime = 90;
    return 1;
  })()`);
  const side = deliveryInit.side;
  await waitFor('Math.abs(window.__game.bossMode.delivery.z) > 1', 40000, '核心被推动');
  const z1 = await ev('+window.__game.bossMode.delivery.z.toFixed(2)');
  const pushMe = await ev('window.__game.bossMode.delivery.me');
  console.log('   贴近核心后：核心 z =', z1, '（应朝', side, '走）｜推我计数 =', pushMe);
  if (Math.sign(z1) !== side) fail('推进方向不对: ' + z1 + ' vs side ' + side);
  if (!(pushMe > 0)) fail('贴近核心但没算作推进');

  // 推到球门线 → 判本关胜、比分 +1
  await ev(`(function(){
    const b = window.__game.bossMode;
    const side = b.deliverySide.get(b.myId);
    b.delivery.z = side * 28.5;                       // 门线 = 32 - 3.2 = 28.8
    b.localBoat.resetTo(0, side * 32, 0);
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.phase === "roundEnd"', 40000, '核心送达判分');
  const round1 = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({
      winner: b.lastRoundWinner === b.myId ? "me" : b.lastRoundWinner,
      me: b.players.get(b.myId).score,
      foe: b.players.get(b.foeId).score,
      reason: b.lastRoundReason,
    });
  })()`));
  console.log('   核心送达：', round1);
  if (round1.winner !== 'me') fail('推进到线却没判我赢');
  if (round1.me < 1) fail('赢下本关没加分');

  // ---------- ⑩ 第 2 关「潮汐擂台」：过场卡 + 撞出判分 ----------
  await ev('(function(){ window.__game.bossMode.endTimer = 0.01; return 1; })()');
  await waitFor('window.__game.bossMode.round === 2 && window.__game.bossMode.phase === "countdown"', 40000, '第 2 关开场');
  const card2 = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const el = document.getElementById('arena-intro');
    return JSON.stringify({
      kind: b.roundKind,
      title: el?.querySelector('.ai-title')?.textContent || '',
      introOn: document.body.classList.contains('intro-on'),
      hudPE: getComputedStyle(document.getElementById('hud')).pointerEvents,
      ring: b.ring,
      ringVisible: !!b.ringVisual?.visible,
      lives: b.players.get(b.myId).lives,
    });
  })()`));
  console.log('⑩ 第 2 关过场卡：', JSON.stringify(card2));
  if (card2.kind !== 'ringout') fail('第 2 关不是潮汐擂台');
  if (!/第\s*2\s*关/.test(card2.title) || !card2.title.includes('潮汐擂台')) fail('第 2 关过场卡标题不对: ' + card2.title);
  if (!card2.introOn) fail('第 2 关过场卡没有收起 HUD');
  if (card2.hudPE !== 'none') fail('过场期间 HUD 仍在吃点击: ' + card2.hudPE);
  if (card2.ring !== 45 || !card2.ringVisible) fail('擂台圈没有出现/半径不对: ' + card2.ring);

  await ev(`(function(){
    const b = window.__game.bossMode;
    b.intro = 0.01; b.cinema = 0; b.countdown = 0.02;
    b.players.get(b.myId).invuln = 99;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.phase === "fight" && window.__game.bossMode.roundKind === "ringout"', 40000, '擂台开打');
  ok(await ev('!document.body.classList.contains("intro-on")'), '第 2 关过场结束 HUD 已恢复');

  // 对手推出擂台 → 我 +1、对手 2 秒后回场
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.localBoat.resetTo(0, 0, 0);
    b.boats.get(b.foeId).resetTo(50, 0, Math.PI);
    const me = b.players.get(b.myId), fp = b.players.get(b.foeId);
    me.ringScore = 0; me.alive = true; me.invuln = 99;
    fp.ringScore = 0; fp.alive = true; fp.invuln = 0; fp.respawn = 0;
    return 1;
  })()`);
  const ring1 = await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).ringScore', 30000, '撞出计分');
  const foeOut = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const fp = b.players.get(b.foeId);
    return JSON.stringify({ alive: fp.alive, respawn: +fp.respawn.toFixed(1) });
  })()`));
  console.log('   对手出圈：我撞出数 =', ring1, '｜对手回场倒计时 =', foeOut.respawn);
  if (!(ring1 >= 1)) fail('对手出圈没给我加分');
  if (foeOut.alive || !(foeOut.respawn > 0)) fail('对手出圈后没有回场倒计时');

  // 撞出数落后时超时 → 对手拿下本关（1:1 进第 3 关）
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId), fp = b.players.get(b.foeId);
    me.ringScore = 1; fp.ringScore = 3;
    me.hp = 300; fp.hp = 300;
    fp.alive = true; fp.respawn = 0;
    b.roundTime = 0.001;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.phase === "roundEnd"', 30000, '擂台超时结算');
  const round2 = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({
      winner: b.lastRoundWinner === b.foeId ? "foe" : b.lastRoundWinner,
      me: b.players.get(b.myId).score,
      foe: b.players.get(b.foeId).score,
      reason: b.lastRoundReason,
    });
  })()`));
  console.log('   擂台超时：', round2);
  if (round2.winner !== 'foe') fail('撞出数少的一方不该赢');
  if (round2.me !== 1 || round2.foe !== 1) fail('比分应为 1:1');

  // ---------- ⑪ 第 3 关「缩圈决斗」：一条命 + 缩圈 + 格挡 ----------
  await ev('(function(){ window.__game.bossMode.endTimer = 0.01; return 1; })()');
  await waitFor('window.__game.bossMode.round === 3 && window.__game.bossMode.phase === "countdown"', 40000, '第 3 关开场');
  const card3 = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const el = document.getElementById('arena-intro');
    return JSON.stringify({
      kind: b.roundKind,
      title: el?.querySelector('.ai-title')?.textContent || '',
      introOn: document.body.classList.contains('intro-on'),
      lives: b.players.get(b.myId).lives,
      yaw: +b.weapons.get(b.myId).turretYaw.toFixed(2),
    });
  })()`));
  console.log('⑪ 第 3 关过场卡：', JSON.stringify(card3));
  if (card3.kind !== 'duel') fail('第 3 关不是缩圈决斗');
  if (!/第\s*3\s*关/.test(card3.title) || !card3.title.includes('缩圈决斗')) fail('第 3 关过场卡标题不对: ' + card3.title);
  if (!card3.introOn) fail('第 3 关过场卡没有收起 HUD');
  if (card3.lives !== 1) fail('决斗关不是一条命: ' + card3.lives);
  if (Math.abs(card3.yaw - 0.61) > 0.02) fail('决斗关炮口辅助角不是 35°: ' + card3.yaw);

  await cdp('Debugger.enable').catch(() => {});
  try {
    await ev(`(function(){
      const b = window.__game.bossMode;
      b.intro = 0.01; b.cinema = 0;
      b.countdown = 0.02;
      b.players.get(b.myId).invuln = 99;
      return 1;
    })()`);
    await waitFor('window.__game.bossMode.phase === "fight" && window.__game.bossMode.roundKind === "duel"', 40000, '决斗开打');
  } catch (e) {
    console.log('   页面异常记录：', errors.slice(0, 6));
    await dumpHang(e.message);
    throw e;
  }

  // 缩圈：75 秒从 50m 收到 30m
  await ev('(function(){ window.__game.bossMode.duelT = 60; return 1; })()');
  await sleep(1500);
  const shrink = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({ ring: +b.ring.toFixed(1), t: +b.duelT.toFixed(1) });
  })()`));
  console.log('   缩圈：duelT =', shrink.t, 's ｜半径 =', shrink.ring + 'm');
  if (!(shrink.ring < 50 && shrink.ring >= 30)) fail('缩圈半径不在 30~50m: ' + shrink.ring);

  // 圈外掉血：站在 45m（当前圈约 34m）每秒掉血
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.localBoat.resetTo(45, 0, 0);
    b.boats.get(b.foeId).resetTo(0, -45, Math.PI);
    const me = b.players.get(b.myId), fp = b.players.get(b.foeId);
    me.hp = 300; me.alive = true; me.invuln = 0;
    fp.hp = 300; fp.alive = true; fp.invuln = 99;
    return 1;
  })()`);
  const hpOut = await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp < 300', 30000, '圈外掉血');
  // waitFor 返回的是表达式本身（true），要看真实血量得单独读一次
  const hpNow = await ev('+window.__game.bossMode.players.get(window.__game.bossMode.myId).hp.toFixed(0)');
  console.log('   圈外 1 秒后 hp =', hpNow, '｜判据 =', hpOut);

  // 举盾：按住 H → 能量下降、盾牌面板可见
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.localBoat.resetTo(0, 0, 0);
    b.players.get(b.myId).hp = 300;
    b.players.get(b.myId).invuln = 99;
    window.__game.opts.input.keys.add("h");
    return 1;
  })()`);
  const shield = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode, bs = b.blockState;
    return JSON.stringify({
      energy: +bs.energy.toFixed(2),
      active: !!bs.active,
      visible: !!b.blockShield?.visible,
      hudOn: !document.getElementById('arena-block')?.classList.contains('hidden'),
    });
  })()`));
  console.log('   举盾：', JSON.stringify(shield));
  if (!(shield.energy < 0.999)) fail('举盾没有消耗能量: ' + shield.energy);
  if (!shield.active || !shield.visible) fail('举盾时盾牌面板没显示');
  if (!shield.hudOn) fail('决斗关 HUD 没有举盾能量条');
  await ev('(function(){ window.__game.opts.input.keys.delete("h"); return 1; })()');

  // 技能测试前把双方拉回场内（圈外掉血段把人放在 45m，别带进下一段）
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.localBoat.resetTo(0, 0, 0);
    b.boats.get(b.foeId).resetTo(0, 20, Math.PI);
    const me = b.players.get(b.myId), fp = b.players.get(b.foeId);
    me.hp = 300; me.alive = true; me.invuln = 99;
    fp.hp = 300; fp.alive = true; fp.invuln = 99;
    return 1;
  })()`);

  // ---------- ⑩ 固定技能：K 冲刺 / F 潮汐爆发 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.localBoat.resetTo(0, 0, 0);
    b.boats.get(b.foeId).resetTo(0, 34, Math.PI);
    const st = b.skills.get(b.myId);
    st.dashCd = 0; st.ultCd = 0;
    b.localBoat.speed = 4;
    b.players.get(b.myId).alive = true;
    return 1;
  })()`);
  const spdBefore = await ev('+window.__game.bossMode.localBoat.speed.toFixed(1)');
  await ev('(function(){ window.__game.opts.input.keys.add("k"); return 1; })()');
  const dashCded = await waitFor('window.__game.bossMode.skills.get(window.__game.bossMode.myId).dashCd > 0', 25000, '冲刺进 CD');
  await ev('(function(){ window.__game.opts.input.keys.delete("k"); return 1; })()');
  const spdAfter = await ev('+window.__game.bossMode.localBoat.speed.toFixed(1)');
  console.log('⑩ 冲刺：速度', spdBefore, '→', spdAfter, '｜CD 起算 =', dashCded);
  if (!(spdAfter > spdBefore)) fail('冲刺没提速: ' + spdBefore + ' → ' + spdAfter);

  await ev(`(function(){
    const b = window.__game.bossMode;
    b.localBoat.resetTo(0, 0, 0);
    b.boats.get(b.foeId).resetTo(0, 10, Math.PI);   // 站在大招半径 16m 内
    const fp = b.players.get(b.foeId);
    fp.hp = 300; fp.alive = true; fp.invuln = 0;
    b.skills.get(b.myId).ultCd = 0;
    return 1;
  })()`);
  await ev('(function(){ window.__game.opts.input.keys.add("f"); return 1; })()');
  await waitFor('window.__game.bossMode.skills.get(window.__game.bossMode.myId).ultCd > 0', 25000, '大招进 CD');
  await ev('(function(){ window.__game.opts.input.keys.delete("f"); return 1; })()');
  const ultRing = await ev('window.__game.bossMode.ults.length');
  await waitFor('window.__game.bossMode.players.get(window.__game.bossMode.foeId).hp < 300', 30000, '大招命中');
  const ultHp = await ev('window.__game.bossMode.players.get(window.__game.bossMode.foeId).hp');
  console.log('   大招：预警环 =', ultRing, '个｜对手 hp 300 →', ultHp);
  if (!(ultHp < 300)) fail('大招没造成伤害');

  // HUD：关卡目标条与技能指示必须真的显示出来
  const hudExtra = JSON.parse(await ev(`(function(){
    return JSON.stringify({
      core: !document.getElementById("arena-core").classList.contains("hidden"),
      skills: !document.getElementById("arena-skills").classList.contains("hidden"),
      kindDuel: document.getElementById("arena-core").classList.contains("kind-duel"),
      hint: document.getElementById("ac-hint").textContent,
    });
  })()`));
  console.log('   HUD 关卡条 =', hudExtra.core, '｜技能条 =', hudExtra.skills,
    '｜决斗样式 =', hudExtra.kindDuel, '｜提示 =', hudExtra.hint);
  if (!hudExtra.core || !hudExtra.skills) fail('关卡/技能 HUD 没显示');
  if (!hudExtra.kindDuel) fail('第 3 关没有切到决斗样式');

  // ---------- 血量判定收口：我 300 / 对手 100 → 2:1 结束整场 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId), fp = b.players.get(b.foeId);
    b.localBoat.resetTo(0, 0, 0);
    b.boats.get(b.foeId).resetTo(0, 20, Math.PI);
    me.hp = 300; me.alive = true; me.invuln = 99;
    fp.hp = 100; fp.alive = true; fp.invuln = 99;
    b.roundTime = 0.001;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.phase === "matchEnd"', 40000, '整场结束');
  const endState = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({
      phase: b.phase, winner: b.matchWinner === b.myId ? "me" : b.matchWinner,
      me: b.players.get(b.myId).score, foe: b.players.get(b.foeId).score,
    });
  })()`));
  console.log('    整场结算：', endState);
  if (endState.winner !== 'me') fail('血量高的一方没赢下决斗');
  if (endState.me !== 2) fail('先到 2 分没有结束整场: ' + endState.me);

  if (errors.length) fail('页面异常: ' + errors.slice(0, 3).join(' | '));
  console.log('arena smoke: PASS');
} catch (e) {
  console.error('arena smoke: FAIL', e.message);
  if (errors.length) console.error('errors:', errors.slice(0, 3));
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await wait(500);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
