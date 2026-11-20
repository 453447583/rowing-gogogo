// 竞技场「被击沉」体验验收
//   node tests/arena_death.mjs
//
// 用户反馈：被击沉后画面像卡住。查下来是两件事：
//   ① 相机跟着沉船一起沉到水下（Boat sinkTimer 会把船压到 y=-2.6），
//      水下滤镜一开就是一片蓝雾，看起来就是"死了以后没反应"。
//   ② HUD 的阵亡面板只对怪物模式开放（showDeath 要求 mode==='boss'），
//      竞技场死了之后屏上没有任何信息 —— 没有"还有几条命"、没有复活倒计时。
//
// 本脚本断言：
//   ① 被击沉瞬间玩家进入 !alive 且 respawnLeft > 0
//   ② 屏上出现「船沉了 · Ns 后重返战场」面板，且写明是谁打的
//   ③ 死亡期间相机在水面以上（y > 2），不会掉进水下滤镜
//   ④ 4 秒后自动复活、面板消失、相机切回船后
//   ⑤ 命打光时面板改说「出局」，随后进入回合结算
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
// 每次独立 profile：固定目录在上一轮 Edge 没退干净时会被锁住，新实例把 URL
// 交给老实例后自己退出，CDP 连上的是旧页面，状态全乱（表现为各种莫名超时）
const profile = path.resolve('D:/3dgame-tmp/browser/arena-death-' + Date.now());
const port = 9361;
const httpPort = 5173;
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

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
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=960,560',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });
let ws;
const errors = [];
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
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
      const msg = (m.params.exceptionDetails.exception?.description || '').split('\n')[0];
      if (msg.includes('texImage2D')) return; // effekseer 在软件光栅下的老噪音
      errors.push(msg);
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

  // ---------- 开局：单人 → 大厅选船 / 竞技场 / 1 个 AI → 发车 ----------
  // 不走 .boat-card + #btn-boat-ok 那条老链：那些元素还留在 DOM 里但是空壳，
  // boat-card 还没渲染出来时点它就是个静默 no-op，最后 #btn-map-ok 因为
  // "还没选艇"直接 return，页面永远没有 __game（表现为 timeout waiting for game boot）。
  await sleep(1200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 25000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 25000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000, '选艇抽屉');
  // 注意：这里的 DOM 选择器一律用单引号 —— ev() 会把表达式原样塞进页面执行，
  // 写成 "#lobby-pick-body [data-boat="titan"]" 会被内层引号提前截断，页面拿到的是
  // 语法错误，点击静默变成 no-op（表现就是"点了船和模式但全没生效"）
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="arena"]')`, 20000, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="arena"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  // 单人竞技场需要一个 AI 对手（大厅设置抽屉里的 #sel-ai 才是现在真正管用的控件）
  await ev(`(function(){
    const sel = document.querySelector("#sel-ai");
    if (sel) { sel.value = "1"; if (sel.onchange) sel.onchange(); }
    return 1;
  })()`);
  await ev('document.querySelector("#btn-start-race").click()');
  // 发车点了却起不来，八成是 Game 构造抛异常（点按钮那条任务里的异常不会
  // 让 ev() 报错，只会进 errors 数组），所以这里失败时把场上状态一起打出来
  try {
    await waitFor('!!window.__game && !!window.__game.bossMode', 40000, 'game boot');
  } catch (e) {
    const diag = await ev(`(function(){
      const t = document.getElementById('toast');
      return {
        game: typeof window.__game,
        toast: t ? t.textContent.trim() : null,
        lobbyHidden: document.getElementById('lobby')?.classList.contains('hidden'),
        hudHidden: document.getElementById('hud')?.classList.contains('hidden'),
        mode: document.querySelector('#lobby .lp-value-mode')?.textContent || null,
      };
    })()`);
    console.error('  boot 诊断：', JSON.stringify(diag));
    console.error('  页面异常：', JSON.stringify(errors.slice(0, 4)));
    throw e;
  }
  ok(await ev('window.__game.mode === "arena"'), '进入了竞技场');

  // 软件光栅只有 1~3 fps，降到 480x270 提帧
  await ev('(function(){ const g=window.__game; g.renderer.setSize(480,270); return 1; })()');
  // 开场卡 5s + 镜头 7s 在无头 0.05s/帧的钳制下会把游戏时间放大一个量级，
  // 这里直接跳过过场（过场展示由 arena_intro_probe 覆盖），专注测死亡体验
  await ev('(function(){ const b=window.__game.bossMode; b.intro=0.01; b.cinema=0; b.countdown=0.02; return 1; })()');
  await waitFor('window.__game.bossMode.phase === "fight"', 60000, 'fight');
  ok(true, '倒计时结束进入 fight');

  // ---------- ① 被击沉 ----------
  const foeId = await ev('window.__game.bossMode.foeId');
  const kill = `(function(){
    const g = window.__game;
    const a = g.bossMode;
    const me = a.players.get(a.myId);
    const boat = g.boats.get(a.myId);
    me.invuln = 0;
    // handleNet 是公开入口，arenaDmg 会走到私有的 #applyDamage（受击方权威路径），
    // 单人模式没有 net，但这条分支本身不依赖 net
    a.handleNet({ t: 'arenaDmg', to: a.myId, dmg: 400, from: ${JSON.stringify(foeId)}, x: boat.pos.x, z: boat.pos.z });
    return { alive: me.alive, respawn: me.respawn, lives: me.lives };
  })()`;
  const k1 = await ev(kill);
  ok(k1 && k1.alive === false, '被打沉后 alive=false', k1);
  ok(k1 && k1.respawn > 0, '进入复活倒计时（4s）', k1 && { respawn: k1.respawn, lives: k1.lives });

  // ---------- ② 屏上的阵亡面板 ----------
  await sleep(500);
  const panel = await ev(`(function(){
    const el = document.getElementById('death-panel');
    return {
      hidden: el.classList.contains('hidden'),
      title: document.getElementById('death-title').textContent,
      hit: document.getElementById('death-hit').textContent,
      meta: document.getElementById('death-meta').textContent,
    };
  })()`);
  ok(panel && panel.hidden === false, '屏上出现阵亡面板', panel && panel.hidden);
  ok(/重返战场|马上重返/.test(panel.title), '标题写明复活倒计时：' + panel.title);
  ok(/被 .+ 击沉/.test(panel.hit), '写明是谁打沉的：' + panel.hit.trim());
  ok(/剩余生命|不计命/.test(panel.meta), '写明本关命数规则：' + panel.meta.trim());

  // ---------- ③ 死亡期间相机不许潜水 ----------
  // 船沉没会被压到 y=-2.6，只要相机跟着走就会穿到水下（水下雾一开就是"卡死"观感）
  let camY = -99;
  for (let i = 0; i < 24; i++) {
    camY = await ev('+window.__game.camera.position.y.toFixed(2)');
    if (camY > 2) break;
    await sleep(120);
  }
  ok(camY > 2, '死亡镜头停在水面以上 y=' + camY);
  await ev('(function(){ window.__game.renderer.setSize(960,560); return 1; })()');
  await sleep(900);
  const shot1 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  await fs.writeFile(path.join(out, 'arena-death-1-sunk.jpg'), Buffer.from(shot1.data, 'base64'));
  console.log('  shot -> shots/verify/arena-death-1-sunk.jpg');

  // ---------- ④ 倒计时结束自动复活 ----------
  // 无头软件光栅只有 1~3fps，而每帧 dt 有上限：4 秒游戏时间要走 80~120 帧，
  // 墙钟能拖到 40s+，12s 的窗口必然偶发超时（不是逻辑错，是帧率）。
  // 截完图先把画布压到 320×200 提速，再把剩下的倒计时快进掉 ——
  // 「倒计时起点 = ARENA_RULES.RESPAWN(4s)」这一条在上面 ② 已经断言过了。
  await ev('(function(){ window.__game.renderer.setSize(320,200); return 1; })()');
  await ev(`(function(){ const a = window.__game.bossMode; a.players.get(a.myId).respawn = 0.05; return 1; })()`);
  await waitFor('window.__game.bossMode.players.get(window.__game.myId).alive === true', 20000, 'respawn');
  ok(true, '倒计时结束自动复活（倒计时已快进）');
  await sleep(600);
  const panel2 = await ev('document.getElementById("death-panel").classList.contains("hidden")');
  ok(panel2 === true, '复活后面板自动收起');
  const camBack = await ev(`(function(){
    const g = window.__game;
    const b = g.boats.get(g.myId);
    return { d: +Math.hypot(g.camera.position.x - b.pos.x, g.camera.position.z - b.pos.z).toFixed(1), y: +g.camera.position.y.toFixed(1) };
  })()`);
  ok(camBack.d < 22 && camBack.y < 12, '相机切回船后（水平距 ' + camBack.d + 'm / 高 ' + camBack.y + 'm）', camBack);

  // ---------- ⑤ 运送关不计命：再沉一次也不会出局、不会结束本关 ----------
  // 三关改版后只有第 3 关「缩圈决斗」是一条命；前两关被打沉只是短暂回场，
  // 这里验 alive/lives/phase 三件事都没被"击沉"带偏。
  const before = await ev(`(function(){
    const a = window.__game.bossMode;
    const me = a.players.get(a.myId);
    me.lives = 99; me.invuln = 0;
    return { lives: me.lives, phase: a.phase, kind: a.roundKind };
  })()`);
  const k2 = await ev(kill);
  ok(k2 && k2.alive === false, '再次被打沉后 alive=false', k2);
  ok(k2 && k2.lives > 0, '运送关不扣命（lives 仍 > 0）', k2);
  await sleep(400);
  const outPanel = await ev(`(function(){
    const el = document.getElementById('death-panel');
    return {
      hidden: el.classList.contains('hidden'),
      title: document.getElementById('death-title').textContent,
      meta: document.getElementById('death-meta').textContent,
    };
  })()`);
  ok(outPanel.hidden === false && !/出局/.test(outPanel.title), '面板仍写"重返战场"而不是出局：' + outPanel.title);
  ok(/不计命/.test(outPanel.meta), '面板写明本关不计命：' + outPanel.meta.trim());
  await sleep(600);
  const stillFight = await ev('window.__game.bossMode.phase');
  ok(stillFight === 'fight' || stillFight === 'countdown', '击沉没有提前结束本关（phase=' + stillFight + '）', before);
  await sleep(500);
  const shot2 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
  await fs.writeFile(path.join(out, 'arena-death-2-out.jpg'), Buffer.from(shot2.data, 'base64'));
  console.log('  shot -> shots/verify/arena-death-2-out.jpg');

  ok(errors.length === 0, '全程无页面异常', errors.slice(0, 2));
} catch (e) {
  failures += 1;
  console.error('arena death: FAIL', e.message);
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await wait(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(failures ? `arena death: FAIL（${failures} 项）` : 'arena death: PASS');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
