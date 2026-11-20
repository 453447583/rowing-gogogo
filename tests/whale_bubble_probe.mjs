// 巨鲸鲨「吐泡泡」验收 + 第 4 关大招移除的运行时确认。
//
//   node tests/whale_bubble_probe.mjs
//
// 做法（沿用 boss_gameplay.mjs 的套路）：
//   ① 单人 → 怪物模式 → startStage(4)（终焉关，血魔 + 召唤巨鲸鲨）
//   ② 把 BOSS 血量压到 0.74 × maxHp，让召唤阈值事件吐出 2 只巨鲸鲨
//   ③ 把船挪到鲸鱼射程内，等 arcs 里出现 type === 'bubble'
//   ④ 断言：用的是 whale_shark_spit 骨骼动作、泡泡速度 6m/s 级、撞船掉血、破裂后 arcs 清干净
//   ⑤ 顺便确认第四关的 BOSS 技能表里已经没有 'screen'（全屏血幕），也没升起过安全柱
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/whale-bubble-' + Date.now());
// 端口随机：写死端口时如果上一轮 Edge 没退干净，新一轮会连到**旧页面**上，
// 于是"代码明明改了却看不到新钩子"（本轮踩过，白查了半小时）。
const port = 9400 + Math.floor(Math.random() * 120);
const httpPort = 5200 + Math.floor(Math.random() * 60);
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=980,580',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { throw new Error(m); };
let ws;

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '';
      errors.push(d.split('\n').slice(0, 4).join(' ⏎ '));
    }
    if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      const t = e.text || '';
      // 资源 404 只认真正会影响演出的（模型 / 特效 / 贴图 / 骨骼）；
      // favicon 之类的噪音不能把验收判死。
      const asset404 = /404/.test(t) && /\.(glb|efk|efkefc|png|jpg|ktx2|hdr|mp3|ogg|wav)(\?|$)/i.test(e.url || '');
      if (asset404) errors.push('404: ' + e.url);
      else if (!/404/.test(t) && /monsters|GLTF|fetch|Failed/i.test(t)) {
        errors.push('LOG: ' + t.slice(0, 160) + (e.url ? ' @' + e.url : ''));
      }
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  // 无头 Edge 的渲染进程偶尔直接崩掉：这时 CDP 永远不回包，脚本会静默干等到天荒地老
  // （本轮白等了 7 分钟）。所以①每个调用加超时 ②socket 一断就把挂起的全部 reject。
  const bail = (why) => {
    for (const [, q] of pending) q.rej(new Error(why));
    pending.clear();
  };
  ws.on('close', () => bail('CDP 连接已关闭（页面/渲染进程崩了）'));
  ws.on('error', () => bail('CDP 连接出错（页面/渲染进程崩了）'));
  const cdp = (method, params = {}, timeout = 45000) => {
    const id = ++seq;
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { return Promise.reject(e); }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        rej(new Error(`CDP 超时 ${timeout}ms: ${method}`));
      }, timeout);
      pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
    });
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Log.enable');
  // 自检：确认页面跑的就是最新 bundle（否则后面所有断言都在验旧代码）
  // 无头冷启动时 1.5s 可能连 script 标签都还没解析出来，所以轮询而不是死等一次
  let bundleHasHook = null;
  for (let i = 0; i < 40; i++) {
    const r = await cdp('Runtime.evaluate', {
      expression: `(function(){ const s = document.querySelector('script[type=module]'); if (!s) return 'no-script'; return fetch(s.src).then(r=>r.text()).then(t=>t.includes('__minionClips')); })()`,
      returnByValue: true, awaitPromise: true,
    }, 90000);
    const v = r.result?.value;
    if (v === true) { bundleHasHook = true; break; }
    if (v === false) { bundleHasHook = false; break; }
    await wait(500);
  }
  if (bundleHasHook !== true) fail('页面加载的不是最新 bundle（没有 __minionClips），先 npm run build');
  const sleep = (ms) => cdp('Runtime.evaluate', {
    expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true,
  });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    }, 90000);
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
  /** 阶段化等待：超时也先打一行，方便判断卡在哪一步（无头渲染只有 1~3fps） */
  const step = async (name, expr, timeout, label) => {
    const t0 = Date.now();
    try {
      const v = await waitFor(expr, timeout, label || name);
      console.log(`   · ${name} ok (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      return v;
    } catch (e) {
      console.log(`   · ${name} FAILED (${((Date.now() - t0) / 1000).toFixed(0)}s): ${e.message}`);
      throw e;
    }
  };
  const shot = async (file, w = 320, h = 200) => {
    // 平时画布压到 320×200 保帧率；要出图的时候才临时放大，抓完立刻缩回去，
    // 免得后面那几十秒的等待又被软件渲染拖死。
    // 注意：改画布尺寸会让 Effekseer 重新上传贴图，此刻还在飞的粒子会抛
    // texImage2D Overload —— 先把粒子全停掉再换尺寸（泡泡本身是 three.js 网格，不受影响）。
    if (w > 320) {
      await ev('(function(){ const f = window.__game.fx; if (f) { f.ctx?.stopAll?.(); f.transient.length = 0; } return 1; })()');
      await sleep(600);
      await ev(`window.__game.renderer.setSize(${w}, ${h})`);
      await sleep(900);
    }
    const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 84 }, 120000);
    await fs.mkdir('shots/verify', { recursive: true });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    if (w > 320) {
      await ev('window.__game.renderer.setSize(320, 200)');
      await sleep(300);
    }
  };

  // ---------- 进终焉关 ----------
  // 单人练习现在是先进大厅（2026-11 版式），模式在大厅右侧抽屉里改，
  // 不再有"选艇屏 → 模式下拉"那条老路径。
  // 主菜单按钮的 onclick 是启动后期（资源预热之后）才挂上的，只判元素存在会点空。
  // 软件渲染下这个时刻可能远超 2.5s，所以直接等 onclick 变成函数再点，并允许重点几次。
  await step('菜单启动', 'typeof document.querySelector("#btn-solo")?.onclick === "function"', 120000);
  for (let i = 0; i < 4; i++) {
    await ev('document.querySelector("#btn-solo").click()');
    await sleep(800);
    if (await ev(`!document.querySelector('#lobby').classList.contains('hidden')`)) break;
    await sleep(2000);
  }
  await step('进入大厅', `!document.querySelector('#lobby').classList.contains('hidden')`, 90000);
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await step('模式抽屉', '!!document.querySelector(".lp-pill[data-mode=\\"boss\\"]")', 30000);
  await ev('document.querySelector(".lp-pill[data-mode=\\"boss\\"]").click()');
  await sleep(700);
  await ev('document.querySelector("#btn-lobby-pick-close")?.click()');
  await ev('document.querySelector("#btn-start-race").click()');
  await step('进入怪物模式', '!!window.__game?.bossMode', 90000);
  // 软件渲染（swiftshader）在 980×580 下每帧要好几秒，终焉关又是 BOSS + 2 只鲸鱼 + 满屏特效，
  // 主线程一忙，连 Runtime.evaluate 都会挂到超时（本轮卡死两次）。先把画布压到 320×200，
  // 只留逻辑；要看画面的时候再临时放大（见 shotAt）。
  await ev('window.__game.renderer.setSize(320, 200)');
  await ev('window.__game.bossMode.introT = 99');
  await step('第一关倒计时', 'window.__game.bossMode.phase === "countdown"', 90000);
  await ev('window.__game.bossMode.startStage(4)');
  await sleep(1500);
  await ev('window.__game.bossMode.introT = 99');
  await step('第四关倒计时', 'window.__game.bossMode.phase === "countdown"', 90000,
    'stage4 countdown (stage=' + (await ev('window.__game.bossMode.stage')) + ')');
  await ev('window.__game.bossMode.countdown = 0.02');
  await step('第四关开打', 'window.__game.bossMode.phase === "fight"', 60000);

  const stageSkillCheck = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({ stage: b.stage, boss: b.bossDef.id, skills: b.bossDef.skills });
  })()`));
  console.log('① 第四关技能表：', stageSkillCheck.skills.join(' / '));
  if (stageSkillCheck.skills.includes('screen')) fail('第四关仍然带着全屏血幕');

  // ---------- 压血触发召唤 ----------
  // 先让 BOSS 闭嘴：这一轮只测鲸鱼，血魔满屏技能会把软件渲染拖到 evaluate 超时
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.boss.cooldownScale = 999;
    b.boss.hp = b.boss.hpMax * 0.74;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.minions.filter(m => m.def.id === "whale_shark").length >= 1',
    45000, 'whale_shark summon');
  const whaleCount = await ev('window.__game.bossMode.minions.filter(m => m.def.id === "whale_shark").length');
  console.log('② 召唤出的巨鲸鲨：', whaleCount, '只');

  // ---------- 把船送到鲸鱼嘴边，逼它吐泡泡 ----------
  // 骨骼动画是异步合进来的（#loadMinionRig 里 loadMinionModel 逐文件拼 clip），
  // 召唤刚完成时 castAction 可能还没挂上，先等它 ready。
  const whaleState = async () => JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify(b.minions.map(m => ({
      id: m.def.id, alive: !!m.alive, model: !!m.model,
      walk: !!m.walkAction, atk: !!m.attackAction, cast: !!m.castAction, die: !!m.dieAction,
      clips: m.mixer ? m.mixer._actions.map(a => a._clip?.name) : null,
      clipModels: m.def.clipModels || null, anims: m.def.anims || null,
    })));
  })()`));
  await sleep(6000);
  console.log('   召唤物骨骼状态：', JSON.stringify(await whaleState()));
  console.log('   动画合并明细：', JSON.stringify(await ev('JSON.stringify(window.__minionClips || null)')));
  console.log('   全局调试键：', JSON.stringify(await ev('JSON.stringify(Object.keys(window).filter(k => k.startsWith("__")))')));
  console.log('   动作加载告警：', errors.filter((l) => /minion|追加|monster|glb/i.test(l)).slice(0, 8));
  await step('鲸鱼骨架就绪',
    'window.__game.bossMode.minions.some(m => m.def.id === "whale_shark" && m.castAction)',
    90000);
  const clipNames = await ev(`(function(){
    const b = window.__game.bossMode;
    const w = b.minions.find(m => m.def.id === 'whale_shark' && m.alive);
    return JSON.stringify(w.mixer._actions.map(a => a._clip.name));
  })()`);
  console.log('   鲸鱼已挂载的 clip：', clipNames);

  const castInfo = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    const whale = b.minions.find(m => m.def.id === 'whale_shark' && m.alive);
    if (!whale) return JSON.stringify({ ok: false });
    // 船放在鲸鱼正前方 14m（在 bubbleRange 26m 内、又在近战距离外）
    me.boat.pos.x = whale.pos.x + 14;
    me.boat.pos.z = whale.pos.z;
    me.boat.vel && me.boat.vel.set(0, 0, 0);
    me.hp = 100; me.invuln = 0;
    whale.castCd = 0;
    return JSON.stringify({ ok: true, whaleAt: [whale.pos.x, whale.pos.z],
      hasCastAction: !!whale.castAction, castClip: whale.castAction?._clip?.name || null });
  })()`));
  console.log('③ 鲸鱼施法前：', castInfo);
  if (!castInfo.hasCastAction) fail('鲸鱼没有 castAction（whale_shark_spit 没合进骨架）');

  await waitFor('window.__game.bossMode.arcs.some(a => a.type === "bubble")', 45000, 'bubble spawn');
  const bubbleInfo = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const bs = b.arcs.filter(a => a.type === 'bubble');
    const a0 = bs[0];
    return JSON.stringify({
      count: bs.length,
      speed: +a0.speed.toFixed(2),
      turn: +a0.turn.toFixed(2),
      life: a0.life,
      r: a0.r,
      dmg: a0.dmg,
      y: +a0.pos.y.toFixed(2),
      source: a0.source,
      shared: !!a0.shared,
      meshInScene: !!a0.mesh?.parent,
    });
  })()`));
  console.log('④ 泡泡：', bubbleInfo);
  if (bubbleInfo.speed > 8) fail('泡泡太快了：' + bubbleInfo.speed);
  if (!bubbleInfo.meshInScene) fail('泡泡没有挂进场景');

  // 截图放到最后抓：760×420 的一次 resize + 抓图在软件渲染下要十几秒，
  // 放在这里会把泡泡全部熬到自然破裂（本轮就这么踩了一次）。
  const reshot = 'shots/verify/whale-bubble-fly.jpg';

  // ---------- 撞船掉血 ----------
  // 软件渲染下船会被浪推着漂，泡泡只有 6.2m/s 追不上，所以每轮把船贴到泡泡身上，
  // 让它必然碰上（测的是"碰到会掉血"，不是"能不能追上"）。
  const before = await ev('window.__game.bossMode.players.get(window.__game.bossMode.myId).hp');
  const hitLog = [];
  const hitOk = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      const v = await ev(`(function(){
        const b = window.__game.bossMode;
        const me = b.players.get(b.myId);
        let a = b.arcs.find(x => x.type === 'bubble');
        if (!a) {
          // 上一串已经破了：把鲸鱼冷却清零、把船摆到它嘴前 12m，催它再吐一串
          const w = b.minions.find(m => m.def.id === 'whale_shark' && m.alive);
          if (w) {
            w.castCd = 0;
            me.boat.pos.x = w.pos.x + 12;
            me.boat.pos.z = w.pos.z;
            me.boat.vel && me.boat.vel.set(0, 0, 0);
          }
          return { why: 'nobubble', hp: me.hp, forced: !!w };
        }
        me.boat.pos.x = a.pos.x; me.boat.pos.z = a.pos.z; me.invuln = 0;
        me.boat.vel && me.boat.vel.set(0, 0, 0);
        const dx = me.boat.pos.x - a.pos.x, dz = me.boat.pos.z - a.pos.z;
        return {
          hp: me.hp, age: +a.age.toFixed(2), dist: +Math.hypot(dx, dz).toFixed(2),
          dy: +Math.abs((me.boat.pos.y || 0) - a.pos.y).toFixed(2),
          invuln: me.invuln, alive: me.alive, bid: b.myId,
          players: [...b.players.keys()],
        };
      })()`);
      if (typeof v === 'object' && v) {
        hitLog.push(v);
        if (typeof v.hp === 'number' && v.hp < before) return v.hp;
      }
      await sleep(320);
    }
    return null;
  })();
  if (hitOk == null) {
    console.log('   命中诊断（前 6 帧）：', JSON.stringify(hitLog.slice(0, 6)));
    fail('泡泡贴上船却没有掉血');
  }
  console.log('⑤ 被泡泡命中：hp', before, '→', hitOk);

  // ---------- 破掉的泡泡要清干净，共享几何体不能被 dispose ----------
  const cleanup = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    return JSON.stringify({
      bubbles: b.arcs.filter(a => a.type === 'bubble').length,
      bubbleGeoAlive: !!b.bubbleGeo && b.bubbleGeo.attributes.position.count > 0,
      bubbleMatAlive: !!b.bubbleMat && b.bubbleMat.uniforms.uTint.value.getHexString(),
      safePillar: !!b.safePillar,
    });
  })()`));
  console.log('⑥ 破裂后：', cleanup);
  if (!cleanup.bubbleGeoAlive) fail('共享球体几何被 dispose 了');
  if (cleanup.safePillar) fail('第四关不该再升起安全柱（全屏大招已移除）');

  // ---------- 出图：再催一串泡泡，放大画布抓飞行中的画面 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    const w = b.minions.find(m => m.def.id === 'whale_shark' && m.alive);
    if (w) {
      w.castCd = 0;
      me.boat.pos.x = w.pos.x + 15;
      me.boat.pos.z = w.pos.z;
      me.boat.vel && me.boat.vel.set(0, 0, 0);
      me.invuln = 6;   // 抓图期间别被糊掉，留两颗泡泡在画面里
    }
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.arcs.some(a => a.type === "bubble")', 45000, 'bubble for shot');
  await sleep(1500);   // 等吐出瞬间那发水环粒子播完
  // 只截 320×200 的"有没有泡泡"存证。真正的观感图走 tests/whale_bubble_look.mjs：
  // 运行中改变渲染器尺寸会让 Effekseer 重传贴图并抛 texImage2D 异常（本轮实测），
  // 观感脚本改成启动时就把窗口定好，全程不 resize。
  await shot(reshot);
  console.log('⑦ 飞行画面：', reshot);


  if (errors.length) {
    console.log('控制台异常：', errors.slice(0, 5));
    fail('页面有未捕获异常');
  }
  console.log('PASS: 巨鲸鲨吐泡泡 + 第四关全屏大招移除');
} finally {
  try { ws?.terminate(); } catch {}
  // kill 单进程会留下孤儿渲染进程（本轮攒到 97 个 msedge 把 CPU 占满，
  // 后续运行全变成"启动超时 / 抓图超时"），必须连子树一起收。
  for (const p of [child, server]) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true }); } catch {}
  }
  await wait(600);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
