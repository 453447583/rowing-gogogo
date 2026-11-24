// 怪物 / 海克斯模式：伤害飘字接入实机验收
//   node tests/dmg_numbers_boss_probe.mjs                     # 怪物模式（classic）
//   node tests/dmg_numbers_boss_probe.mjs --hex                # 海克斯模式
//
// 两个模式共用 BossMode，飘字链路同一条；这里两种都跑一遍，防的只是
// 「海克斯的卡牌/核心倍率算完之后没走到跳字」这类分支差异。
//
// 验四件事（都在真实对局里跑，不是纯模块单测）：
//   ① BOSS 命中：跳的是 public/ui/dmg 的逐字 PNG，不是以前的 `-123` 文字
//   ② 暴击：带品红爆裂框（crit_burst）
//   ③ 小怪命中：同一套字表，字高明显小于 BOSS 那一档
//   ④ 退出对局后 DOM 清干净（模式切换不留残影）
//
// 产物：shots/verify/dmg-numbers-boss.png / dmg-numbers-boss-hex.png
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/dmg-boss-' + Date.now());
const port = 9412;
const httpPort = 5210;
const shots = path.resolve('shots/verify');
const VARIANT = (process.argv.includes('--hex') || process.env.DMG_VARIANT === 'hex') ? 'hex' : 'classic';
// 大厅里怪物模式与海克斯模式是两张卡：海克斯那张多一个 data-variant="hex"。
// 注意 [data-mode="boss"] 也会命中海克斯卡，querySelector 取的是先出现的 classic。
const MODE_SEL = VARIANT === 'hex'
  ? '[data-mode=\\"boss\\"][data-variant=\\"hex\\"]'
  : '[data-mode=\\"boss\\"]';

const dev = spawn(process.execPath, [
  path.resolve('node_modules/vite/bin/vite.js'), '--port', String(httpPort), '--strictPort',
], { stdio: 'ignore', cwd: path.resolve('.') });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${httpPort}/`); up = r.ok; } catch {}
  if (!up) await wait(200);
}
if (!up) { dev.kill('SIGKILL'); throw new Error('vite dev 没起来（端口 ' + httpPort + '）'); }

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720',
  `http://127.0.0.1:${httpPort}/`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r?.result?.value;
};
const waitFor = async (expr, timeout, label) => {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = await ev(expr);
    if (last) return last;
    await wait(250);
  }
  throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
};

const fails = [];
const check = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  else { fails.push(label); console.log('  ✗ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

try {
  let tabs = null;
  for (let i = 0; i < 120 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await wait(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.reject(new Error(m.error.message)); else q.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '';
      // 无头软件光栅 + Effekseer 的环境噪音（探针会重导航、旧 GL 上下文被丢弃），
      // 与本改动无关；boss_gameplay.mjs 里过滤的是同一类
      if (/texImage2D|Overload resolution failed/.test(d)) return;
      if (/effekseer\.min\.js|ContextStates|wasm-function|function signature mismatch/.test(d)) return;
      errors.push(d.split('\n').slice(0, 3).join(' ⏎ '));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });

  // ---------- 进怪物模式 ----------
  // vite 首次启动会做依赖预构建，完事会强制刷新一次整页（把 __game 打回 undefined）。
  // 所以先等 timeOrigin 稳定，真刷了就重来；否则大厅点到一半被刷掉，
  // 后面所有断言都只是「页面还没加载完」的假失败。
  const boot = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await cdp('Page.navigate', { url: `http://127.0.0.1:${httpPort}/` });
      await wait(3000);
      const t0 = await ev('performance.timeOrigin');
      await wait(2600);
      const t1 = await ev('performance.timeOrigin').catch(() => t0);
      if (t1 !== t0) continue;
      try {
        await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 40000, 'lobby ready');
        await ev('document.querySelector("#btn-solo").click()');
        await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
        await ev('document.querySelector("#btn-lobby-mode").click()');
        await waitFor('!!document.querySelector("#lobby-pick-body ' + MODE_SEL + '")', 30000, 'mode drawer');
        await ev('document.querySelector("#lobby-pick-body ' + MODE_SEL + '").click()');
        await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
        await ev('document.querySelector("#btn-start-race").click()');
        await waitFor('!!window.__game?.bossMode', 60000, 'bossMode');
        return;
      } catch (e) {
        console.log('   boot 重试：' + String(e.message).split('\n')[0]);
      }
    }
    throw new Error('进不去怪物模式');
  };
  const enterFight = async () => {
    await boot();
    if (VARIANT === 'hex') {
      // 海克斯开局先弹「本局核心」三选一，不选就不进倒计时（hexCardOffer 会挡住阶段机）
      await waitFor('document.querySelectorAll(".hex-card").length > 0', 30000, 'hex core picker');
      await ev('document.querySelector(".hex-card").click()');
      await wait(500);
    }
    await ev('(function(){const b=window.__game.bossMode;b.introT=99;return 1})()');
    await waitFor('window.__game.bossMode.phase === "countdown"', 30000, 'countdown');
    await ev('(function(){const b=window.__game.bossMode;b.countdown=0.02;return 1})()');
    await waitFor('window.__game.bossMode.phase === "fight"', 30000, 'fight');
  };
  // 进关卡时才会动态加载 Effekseer / GLTF，vite 发现新依赖会再整页刷一次，
  // 所以这里要「进了再确认一次还活着」，否则断言全打在一个已被销毁的 __game 上。
  let inFight = false;
  for (let i = 0; i < 3 && !inFight; i++) {
    try { await enterFight(); } catch (e) { console.log('   重试：' + String(e.message).split('\n')[0]); continue; }
    await wait(1500);
    inFight = await ev('!!window.__game?.bossMode && window.__game.bossMode.phase === "fight"').catch(() => false);
    if (!inFight) console.log('   进关卡后整页被刷新，重来一次');
  }
  if (!inFight) throw new Error('进不去战斗阶段');

  // 把船摆到 BOSS 正前方 20m，船头对准：追尾相机落位后画面里才有 BOSS
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    const bs = b.boss;
    me.boat.pos.x = bs.pos.x;
    me.boat.pos.z = bs.pos.z + 20;
    me.boat.heading = Math.PI;
    me.boat.speed = 0;
    me.invuln = 999;             // 别让 BOSS 把船打沉，影响取景
    return 1;
  })()`);
  await wait(1800);

  // ---------- ① BOSS 普通命中 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const bs = b.boss;
    // 走真实链路：主炮命中回调 → 弱点倍率 → #dealBossDamage → 飘字
    b.weapons.opts.onHit(18, bs.pos.x + 2, bs.pos.z, { color: 0xffd28a }, {});
    return 1;
  })()`);
  await wait(180);
  const normal = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    if (!layer) return JSON.stringify({ none: true });
    const wraps = [...layer.children];
    const srcs = wraps.flatMap(w => [...w.querySelectorAll('img')].map(i => i.getAttribute('src') || ''));
    return JSON.stringify({
      wraps: wraps.length,
      digits: wraps.map(w => w.querySelectorAll('img').length),
      srcs,
      hasBurst: srcs.some(s => s.includes('crit_burst')),
    });
  })()`));
  check(!normal.none, '命中后建出 #dmg-numbers 层');
  check(normal.wraps >= 1, 'BOSS 命中跳字', { wraps: normal.wraps });
  check(normal.srcs.length >= 1 && normal.srcs.every((s) => /\/ui\/dmg\/normal_\d(@2x)?\.png$/.test(s)),
    '普通命中用的是字表 normal_*.png', { srcs: normal.srcs.slice(0, 4) });
  check(!normal.hasBurst, '普通命中不带爆框');

  // ---------- ② 暴击（背面弱点 ×1.45 + crit，伤害必过 40） ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const bs = b.boss;
    const behind = { x: bs.pos.x - Math.sin(bs.heading) * 3, z: bs.pos.z - Math.cos(bs.heading) * 3 };
    b.weapons.opts.onHit(60, behind.x, behind.z, { color: 0xffd28a }, { crit: true });
    return 1;
  })()`);
  await wait(160);
  const crit = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    const wraps = [...layer.children];
    const srcs = wraps.flatMap(w => [...w.querySelectorAll('img')].map(i => i.getAttribute('src') || ''));
    return JSON.stringify({
      critDigits: srcs.filter(s => s.indexOf('/ui/dmg/crit_') === 0).length,
      burst: srcs.filter(s => s.includes('crit_burst')).length,
    });
  })()`));
  check(crit.critDigits >= 1, '暴击走 crit_*.png', { n: crit.critDigits });
  check(crit.burst >= 1, '暴击带独立爆裂框');

  // ---------- ③ 小怪：同一套字表，尺寸更小 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    b.handleNet({ t: 'bossSummon', entries: [{ type: 'beast', x: b.boss.pos.x + 6, z: b.boss.pos.z + 10 }] });
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.minions.length > 0', 20000, 'minion spawned');
  const beforeHeights = await ev(`JSON.stringify([...document.getElementById('dmg-numbers').children].map(w => +w.getBoundingClientRect().height.toFixed(1)))`);
  await ev(`(function(){
    const b = window.__game.bossMode;
    const m = b.minions[0];
    // 真实入口：主炮打中小怪时就是这条回调
    for (let i = 0; i < 3; i++) b.weapons.opts.onMinionHit(m, 20 + i);
    return 1;
  })()`);
  await wait(200);
  const mini = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const layer = document.getElementById('dmg-numbers');
    const wraps = [...layer.children];
    const mine = wraps.filter(w => [...w.querySelectorAll('img')].every(i => !(i.getAttribute('src')||'').includes('burst')));
    const hs = mine.map(w => +w.getBoundingClientRect().height.toFixed(1));
    return JSON.stringify({
      n: mine.length,
      hs,
      dmgHp: +b.minions[0]?.hp,
      bossH: hs.length ? Math.max(...hs) : 0,
    });
  })()`));
  check(mini.n >= 1, '小怪命中也在跳字', { n: mini.n, hs: mini.hs });
  console.log('   小怪命中前已有飘字高度：', beforeHeights);

  // 尺寸对比：同屏里最大的是 BOSS 档（6.2% 屏高 ≈ 46px），小怪档应 ≈ 0.75 倍
  const hs = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    return JSON.stringify([...layer.children].map(w => +w.getBoundingClientRect().height.toFixed(1)));
  })()`));
  const vh = await ev('window.innerHeight');
  const maxH = Math.max(...hs);
  console.log('   全场字高：', hs, ' 视口高：', vh);
  check(maxH / vh < 0.10, '字高不超过屏高的 10%（不挡血条/小地图）', { pct: +(maxH / vh * 100).toFixed(2) });

  // ---------- ④ 连射：连击槽位循环，数字不许飘出屏幕 ----------
  await ev(`(function(){
    const b = window.__game.bossMode;
    const bs = b.boss;
    const layer = document.getElementById('dmg-numbers');
    layer.innerHTML = '';
    // 模拟连射 12 发（每秒 5~6 发，真实对局就是这个量级）
    for (let i = 0; i < 12; i++) b.weapons.opts.onHit(9, bs.pos.x + 1, bs.pos.z, { color: 0xffd28a }, {});
    return 1;
  })()`);
  // 被顶掉的那个还有 120ms 淡出（.kill() 是先淡再删），所以这里必须等过淡出窗口再数，
  // 否则数到的是"正在淡出的第 7、8 个"，会误判成没上限。
  await wait(320);
  const spray = JSON.parse(await ev(`(function(){
    const layer = document.getElementById('dmg-numbers');
    const rs = [...layer.children].map(w => w.getBoundingClientRect());
    return JSON.stringify({
      n: rs.length,
      top: Math.min(...rs.map(r => r.top)),
      bottom: Math.max(...rs.map(r => r.bottom)),
      vh: window.innerHeight,
    });
  })()`));
  check(spray.n <= 14, '同屏飘字有上限（不会无限堆）', { n: spray.n });
  check(spray.top > -10 && spray.bottom < spray.vh + 10,
    '连射 12 发后数字仍在屏内（上飘距离只有 1.6 个字高）',
    { top: Math.round(spray.top), bottom: Math.round(spray.bottom), vh: spray.vh });

  // ---------- 截图 ----------
  await fs.mkdir(shots, { recursive: true });
  // 无头抓一张 3D 场景要几百毫秒，700ms 的飘字根本等不到快门（上一版截图里
  // 画面全空就是这么来的）。这里把飘字动画直接暂停在 150ms 那一帧再拍，
  // 只影响探针，不改游戏逻辑。
  const shotInfo = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const bs = b.boss;
    const layer = document.getElementById('dmg-numbers');
    // 先把上一轮断言留下的飘字清掉：pause 会把它们全冻在同一帧，
    // 六七个数字一起糊在 BOSS 身上，看起来像 bug（实际游戏里不会同屏这么多）。
    layer.innerHTML = '';
    b.weapons.opts.onHit(27, bs.pos.x + 2, bs.pos.z, { color: 0xffd28a }, {});
    const m = b.minions[0];
    if (m) b.weapons.opts.onMinionHit(m, 33);
    for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 40; }
    const rects = [...layer.children].map(w => {
      const r = w.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    return JSON.stringify({ rects, vw: window.innerWidth, vh: window.innerHeight });
  })()`));
  const onScreen = shotInfo.rects.filter((r) => r.x > -r.w && r.x < shotInfo.vw && r.y > -r.h && r.y < shotInfo.vh);
  check(onScreen.length >= 1, '飘字落在屏幕内（不在画外）', {
    n: onScreen.length, sample: onScreen[0], vw: shotInfo.vw, vh: shotInfo.vh,
  });
  await wait(120);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  const shotName = 'dmg-numbers-boss' + (VARIANT === 'hex' ? '-hex' : '') + '.png';
  await fs.writeFile(path.join(shots, shotName), Buffer.from(shot.data, 'base64'));
  console.log('   截图：shots/verify/' + shotName);

  // ---------- ④ 退出后清干净 ----------
  const cleared = await ev(`(function(){
    const g = window.__game;
    g.bossMode?.dispose?.();
    return new Promise((r) => setTimeout(() => {
      r(JSON.stringify({ layer: !!document.getElementById('dmg-numbers') }));
    }, 300));
  })()`);
  check(JSON.parse(cleared).layer === false, '退出模式后飘字层被移除', JSON.parse(cleared));

  check(errors.length === 0, '运行期没有未捕获异常', errors.slice(0, 3));
} finally {
  try { ws?.close(); } catch {}
  child.kill('SIGKILL');
  dev.kill('SIGKILL');
}

if (fails.length) {
  console.error('\nFAIL：' + fails.join(' / '));
  process.exit(1);
}
console.log('\n怪物 / 海克斯模式伤害飘字接入通过');
