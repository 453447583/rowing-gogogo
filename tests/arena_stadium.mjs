// 竞技场环形看台验收
//   node tests/arena_stadium.mjs
//
// 用户需求：① 去掉四周山脉、看台围成一圈且完全无缝紧贴；② 每座看台上都有
// 实时比分牌（数据来自 ArenaMode.getScoreboard）；③ 开场动画（俯瞰→场内→
// 环看台→贴船，配「竞技场PVP XX vs XX」标题，播完接追尾相机）。
//
// 断言：
//   ① BOSS_ARENA.noMountains → 竞技场不再建远景山脊（env.mountains 不存在）
//   ② 看台成百观众 + 每座看台一块比分牌 + 彩旗/灯柱
//   ③ 无缝：相邻看台中心弦长 ≤ 看台长度（端墙互相咬合，零缝隙）
//   ④ 看台几何都在硬边界外（纯视觉不写 colliders）
//   ⑤ 比分牌吃实时数据：改 players.score 后 update → scoreInfo 跟着变
//   ⑥ 开场动画：boot 时 cinema>0、标题浮层在 DOM、相机被接管在高空；
//      快进后 phase 正常走到 fight（动画不卡相位机）、浮层淡出
//   ⑦ 全程零页面异常
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/arena-stadium-' + Date.now());
const port = 9362;
const httpPort = 5173;
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], { stdio: 'ignore' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch {}
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来'); }
}
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=720,420',
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
      const msg = (m.params.exceptionDetails.exception?.description || '').split('\n')[0];
      if (msg.includes('texImage2D')) return;
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

  // ---------- 开局（与 arena_death 同一条新大厅链） ----------
  await sleep(1200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 25000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 25000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="arena"]')`, 20000, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="arena"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev(`(function(){
    const sel = document.querySelector("#sel-ai");
    if (sel) { sel.value = "1"; if (sel.onchange) sel.onchange(); }
    return 1;
  })()`);
  await ev('document.querySelector("#btn-start-race").click()');
  try {
    await waitFor('!!window.__game && !!window.__game.bossMode', 40000, 'game boot');
  } catch (e) {
    const diag = await ev(`(function(){
      const t = document.getElementById('toast');
      return {
        game: typeof window.__game,
        toast: t ? t.textContent.trim() : null,
        mode: document.querySelector('#lobby .lp-value-mode')?.textContent || null,
      };
    })()`);
    console.error('  boot 诊断：', JSON.stringify(diag));
    console.error('  页面异常：', JSON.stringify(errors.slice(0, 4)));
    throw e;
  }
  ok(await ev('window.__game.mode === "arena"'), '进入了竞技场');

  // ---------- ① 山脉已移除 ----------
  ok(await ev('window.__game.env.mountains == null'), '竞技场不再建远景山脊（noMountains）');

  // ---------- ⑥ 开场动画（先断言，截图排模拟之前） ----------
  const cin0 = await ev(`(function(){
    const a = window.__game.bossMode;
    const el = document.getElementById('arena-intro');
    return {
      cinema: a.cinema, phase: a.phase, overlay: !!el,
      title: el ? (el.querySelector('.ai-title')?.textContent || '') : '',
      hudHidden: document.body.classList.contains('intro-on'),
    };
  })()`);
  ok(cin0 && cin0.cinema > 0 && cin0.phase === 'countdown', '开局进入开场动画（cinema>0 且倒计时冻结）', cin0);
  ok(cin0 && cin0.overlay, '关卡过场卡已挂到 DOM');
  ok(cin0 && /第\s*1\s*关/.test(cin0.title) && cin0.title.includes('潮汐运送'),
    '过场卡标题为「第 X 关：名字」', cin0 && cin0.title);
  ok(cin0 && cin0.hudHidden, '过场期间常驻 HUD 已隐藏（body.intro-on）');
  // 动画前段相机被接管且在高空俯瞰
  const camHigh = await ev(`(function(){
    const g = window.__game;
    return g.bossMode.updateCamera(g.camera, 0);
  })()`);
  ok(camHigh === true, '开场动画接管相机（updateCamera 返回 true）');
  ok(await ev('window.__game.camera.position.y > 20'), '动画起始机位在高空俯瞰');
  // 两张动画帧截图：俯瞰起点 + 看台环扫段（排在一切模拟之前）
  for (const [tag, cin] of [['start', 6.9], ['sweep', 2.0]]) {
    const shot = await ev(`(function(){
      const g = window.__game;
      g.bossMode.cinema = ${cin};
      g.bossMode.updateCamera(g.camera, 0);
      g.post.render(1/60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.84);
    })()`);
    if (typeof shot === 'string' && shot.startsWith('data:image')) {
      await fs.writeFile(path.join(out, 'arena_stadium_cinema_' + tag + '.jpg'), Buffer.from(shot.split(',')[1], 'base64'));
      ok(true, '开场动画帧已保存 arena_stadium_cinema_' + tag + '.jpg');
    } else {
      ok(false, '开场动画帧截图失败 ' + tag, String(shot).slice(0, 120));
    }
  }
  // 动画不卡相位机：快进 12s（动画 7s + 倒计时 3s + 余量）必须走到 fight
  await ev(`(function(){
    const g = window.__game;
    for (let i = 0; i < 60; i++) g.bossMode.update(0.2, i * 0.2);
    return 1;
  })()`);
  ok(await ev('window.__game.bossMode.phase === "fight"'), '快进后正常进入 fight（开场动画不阻塞相位机）');
  ok(await ev('window.__game.bossMode.cinema <= 0'), '动画计时已清零');
  ok(await ev(`(function(){
    const el = document.getElementById('arena-intro');
    return !el || el.classList.contains('ai-done') || el.style.opacity === '0';
  })()`), '关卡过场卡已淡出');
  ok(await ev('!document.body.classList.contains("intro-on")'), '过场结束 HUD 已恢复');

  // ---------- ② 看台层建立 ----------
  await ev('(function(){ const g=window.__game; g.renderer.setSize(480,270); return 1; })()');
  const stats = await ev(`(function(){
    const s = window.__game.arenaStadium;
    return s ? s.stats : null;
  })()`);
  ok(!!stats, 'arenaStadium 已创建', stats);
  if (stats) {
    ok(stats.stands >= 14, '看台数 ≥14 围成一圈', { stands: stats.stands });
    ok(stats.screens === stats.stands, '每座看台都有一块比分牌', stats);
    ok(stats.sitting + stats.cheering > 300, '观众人偶成百（坐观+欢呼）', stats);
    ok(stats.cheering > stats.sitting * 0.25, '欢呼人偶占比合理（>25% 坐观数）', stats);
    ok(stats.pennants > 50, '彩旗串齐备', stats);
  }

  // ---------- ③ 无缝：相邻看台中心弦长 ≤ 看台长度 ----------
  const ring = await ev(`(function(){
    const g = window.__game;
    const stands = g.arenaStadium.group.children.find((m) => m.name === 'arena-stands');
    if (!stands) return null;
    const m = stands.instanceMatrix.array;
    const pts = [];
    for (let i = 0; i < m.length; i += 16) pts.push([m[i + 12], m[i + 14]]);
    // 按方位角排序，取相邻中心的最小距离和最大角距
    pts.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]));
    let maxChord = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length];
      maxChord = Math.max(maxChord, Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]));
    }
    return { maxChord: +maxChord.toFixed(2), standLen: 44 };
  })()`);
  ok(ring && ring.maxChord <= ring.standLen, '相邻看台端墙互相咬合（弦长 ≤ 台长，零缝隙）', ring);

  // ---------- ④ 纯视觉：都在硬边界外、零新增碰撞 ----------
  const geo = await ev(`(function(){
    const g = window.__game;
    const stands = g.arenaStadium.group.children.find((m) => m.name === 'arena-stands');
    if (!stands) return null;
    const r = g.mapDef.boundary.r;
    const m = stands.instanceMatrix.array;
    let minR = Infinity;
    for (let i = 0; i < m.length; i += 16) {
      const d = Math.hypot(m[i + 12], m[i + 14]);
      if (d < minR) minR = d;
    }
    return { minR: +minR.toFixed(1), boundary: r, colliderTotal: g.colliders.length, envColliders: g.env.colliders.length };
  })()`);
  ok(geo && geo.minR > geo.boundary, '所有看台都在硬边界之外', geo);
  ok(geo && geo.colliderTotal === geo.envColliders, '看台没有新增任何碰撞体（纯视觉）', geo);

  // ---------- ⑤ 比分牌吃实时数据 ----------
  const sb0 = await ev(`(function(){
    const g = window.__game;
    g.arenaStadium.update(1.0, 1.0);   // 首帧立即拉一次
    const s = g.arenaStadium.scoreInfo();
    return s ? { my: s.myName, foe: s.foeName, myScore: s.myScore, foeScore: s.foeScore } : null;
  })()`);
  ok(!!sb0, '比分牌从 ArenaMode 拉到了实时比分', sb0);
  const sb1 = await ev(`(function(){
    const g = window.__game;
    const me = g.bossMode.players.get(g.bossMode.myId);
    me.score = 2;
    const foe = g.bossMode.players.get(g.bossMode.foeId);
    if (foe) foe.score = 1;
    g.arenaStadium.update(2.0, 0.6);
    const s = g.arenaStadium.scoreInfo();
    return s ? { myScore: s.myScore, foeScore: s.foeScore } : null;
  })()`);
  ok(sb1 && sb1.myScore === 2 && sb1.foeScore === 1, '改比分后下一拍比分牌跟着刷新（实时）', sb1);
  await ev(`(function(){
    const g = window.__game;
    g.bossMode.players.get(g.bossMode.myId).score = 0;
    g.bossMode.players.get(g.bossMode.foeId).score = 0;
    return 1;
  })()`);

  // ---------- ⑤ 人浪在动（整组矩阵比对：单实例的相位可能恰好两拍都没跳起） ----------
  const crowdSnap = () => ev(`(function(){
    const mesh = window.__game.arenaStadium.group.children.find((m) => m.name === 'arena-crowd-cheering');
    if (!mesh) return null;
    const a = mesh.instanceMatrix.array;
    let h = 0;
    for (let i = 0; i < a.length; i += 4) h = (h * 31 + (a[i] * 1e3 | 0) + (a[i + 1] * 1e3 | 0) * 7) % 1e9;
    return h;
  })()`);
  const before = await crowdSnap();
  await ev('(function(){ window.__game.arenaStadium.update(0.8); return 1; })()');
  const mid = await crowdSnap();
  await ev('(function(){ window.__game.arenaStadium.update(2.2); return 1; })()');
  const after = await crowdSnap();
  ok(!!before && (before !== mid || mid !== after), '人浪推进后欢呼人偶矩阵发生变化（update 生效）');

  ok(errors.length === 0, '全程零页面异常', errors.slice(0, 4));
} finally {
  try { await fs.writeFile('D:/3dgame-tmp/browser/arena-stadium-done', String(Date.now())); } catch {}
  try { ws?.close(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  try {
    const { execFileSync } = await import('node:child_process');
    if (child.pid) execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    if (server.pid) execFileSync('taskkill', ['/F', '/T', '/PID', String(server.pid)], { stdio: 'ignore' });
  } catch {}
}
console.log(failures ? `\n竞技场看台：FAIL（${failures} 项未过）` : '\n竞技场看台：PASS');
process.exit(failures ? 1 : 0);
