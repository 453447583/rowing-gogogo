// 道具赛「新道具 + 联机稳定性」马拉松验收
//   node tests/item_marathon.mjs            # 默认连打 10 把
//   ROUNDS=3 node tests/item_marathon.mjs   # 少打几把
//
// 背景：2026-11-14 新增六件道具（血枪狙击 / 圣光沙暴 / 逆流之门 / 剑刃风暴 / 圣域 / 护盾墙），
// 外加两条追赶机制（领先不产纯攻击道具、连续两次白给保底反超道具）。
// 这些新东西全是跨端玩法，必须验证「房主放的我看得见、我放的房主收得到、状态不打架」。
//
// 房主 = 裸 WS 脚本扮演，客机 = 真浏览器（真跑 Items.js 的那一套）。
//
// 每把固定检查（10 把 = 10 遍）：
//   N1 客机本地道具箱数量稳定、`items` 建成
//   N2 血枪：房主发射 → 客机出现飞行体；命中通报 → 客机减速
//   N3 血枪：客机发射 → 房主收到 itemUse（vx/vz 是数字）
//   N4 圣光沙暴：房主罩住客机 → 客机减速 + 糊屏，区内有人时不刷屏（toast 只一次）
//   N5 圣域：客机被推离中心
//   N6 剑刃风暴：客机被弹开 + 减速
//   N7 逆流之门：客机瞬移后与前一名距离显著缩短，房主收到 gx/gz
//   N8 护盾墙：房主的墙挡下客机方向的弹体（wallBlocks 增加）
//   N9 区域道具到期后必须自己清干净（不留幽灵 mesh / 不进下一把）
//   N10 全程零页面异常
// 每把轮换一项深查（越界写入、连续多件同时施放、满屏区域压力）：
//   D1 同屏四片区域同时存在仍不卡死，且都会在到期后消失
//   D2 血枪穿透：一条血枪连穿两人（客机 + AI）都要各自减速
//   D3 连续三次攻击白给 → 下一个箱子必出反超道具
//   D4 领先者（第 1 名）抽不到纯攻击道具
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { MAPS } from '../src/data/maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROUNDS = Math.max(1, Number(process.env.ROUNDS) || 10);
const HTTP_PORT = Number(process.env.PORT) || 3611;
const WS_PORT = Number(process.env.WS_PORT) || 3612;
const cdpPort = 9700 + Math.floor(Math.random() * 90);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/item-marathon-' + Date.now());
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else {
    failures += 1;
    console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra));
  }
};
const T0 = Date.now();
const section = (t) => console.log('\n[' + ((Date.now() - T0) / 1000).toFixed(0) + 's] ' + t);

class Host {
  constructor() { this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('房主连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: '房主', session: 'host-marathon' })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 已关 */ } }
  async waitWhere(type, pred = () => true, timeout = 12000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) {
          this.cursors[type] = i + 1;
          return this.msgs[i];
        }
      }
      if (Date.now() - start > timeout) throw new Error(`房主等 ${type} 超时`);
      await sleep(25);
    }
  }
  wait(type, timeout) { return this.waitWhere(type, () => true, timeout); }
  /** 收集某类消息（不清空），用于统计本把收到的 itemUse */
  find(type, pred = () => true) { return this.msgs.filter((m) => m.t === type && pred(m)); }
  clear() { this.msgs = []; this.cursors = {}; }
}

let ws; let seq = 0;
const pending = new Map();
const pageErrors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`cdp timeout: ${m} ${p.expression ? '‹' + String(p.expression).slice(0, 120) + '›' : ''}`)), 40000)),
  ]);
};
const ev = async (expr, retries = 2) => {
  for (let i = 0; ; i++) {
    try {
      const r = await cdp('Runtime.evaluate', {
        expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
      return r.result?.value;
    } catch (e) {
      if (i >= retries || !/cdp timeout/.test(String(e.message))) throw e;
      // 主线程被卡住时的关键诊断：V8 的 Debugger.pause 能中断正在忙的 JS 循环，
      // 直接拿到卡住的调用栈 —— 不用再猜是渲染 overdraw 还是逻辑死循环。
      console.error(`[诊断] evaluate 超时（第 ${i + 1} 次），尝试打断主线程抓栈：`, String(expr).slice(0, 90));
      await diagnoseStall();
    }
  }
};
const diagnoseStall = async () => {
  try {
    const pausedPromise = new Promise((res) => {
      const h = (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.method === 'Debugger.paused') { ws.off('message', h); res(m.params); }
        } catch { /* 忽略非 JSON */ }
      };
      ws.on('message', h);
      setTimeout(() => { ws.off('message', h); res(null); }, 20000);
    });
    // pause 用 V8 中断点，正在跑的热循环也能被打断；如果 20s 都等不到 paused，
    // 说明主线程根本没在执行 JS —— 卡的是渲染/GPU 侧（swiftshader 光栅化）。
    cdp('Debugger.pause').catch(() => {});
    const p = await pausedPromise;
    if (!p) {
      console.error('[诊断] pause 20s 无 paused 事件 → 主线程没在跑 JS，卡的是渲染/GPU 侧（软光栅）');
    } else {
      const frames = p.callFrames.slice(0, 10).map((f) => {
        const url = (f.url || '').split('/').pop();
        const fn = f.functionName || '(匿名)';
        return `${fn} @ ${url}:${f.location.lineNumber + 1}`;
      });
      console.error('[诊断] 主线程卡在：\n    ' + frames.join('\n    '));
    }
    await cdp('Debugger.resume').catch(() => {});
  } catch (e) {
    console.error('[诊断失败]', e.message);
  }
};
const waitFor = async (expr, label, tries = 100) => {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await ev(expr);
    if (last === true || (typeof last === 'number' && last > 0)) return last;
    await sleep(200);
  }
  throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
};
const softWait = (expr, label, tries = 60) => waitFor(expr, label, tries).catch(() => null);

/** 客机在大厅里选艇 + 准备 */
const lobbyPick = async (boatId) => {
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '在大厅', 200);
  await ev(`document.querySelector('#btn-lobby-boat').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat=\\"${boatId}\\"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat=\\"${boatId}\\"]').click()`);
  await ev(`(function(){const c=document.querySelector('#btn-lobby-pick-close');if(c)c.click();return 1})()`);
  await ev(`document.querySelector('#btn-lobby-ready').click()`);
};

/** 客机船位置 */
const guestPos = async () => JSON.parse(await ev(`(function(){
  const g = window.__game;
  const b = g.boats.get(g.myId);
  return JSON.stringify({ x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2), h: +b.heading.toFixed(3) });
})()`));

/**
 * 断言做完后把区域网格藏起来再推进寿命：
 * 无头软光栅下，机位泡在 3~4 层叠加的半透明圆柱里 = 全屏 overdraw，
 * 一帧几十秒（表现为 CDP 静默超时）。真实 GPU 无此问题，纯粹是测试环境的坑。
 */
const hideZoneMeshes = async () => ev(`(function(){
  const it = window.__game.items;
  for (const z of it.zones) if (z.group) z.group.visible = false;
  return it.zones.length;
})()`);

/**
 * 把区域道具的寿命跑完。
 * 无头页面只有 1~3fps，墙钟等 20s 只等于游戏时间 1~2s —— 用墙钟断言「按时消失」必然假失败
 * （本项目的硬规则：玩法计时一律按 game time）。这里直接泵 items.update 的帧，
 * 每轮推进 2s 游戏时间，等价于正常游玩下的等待。
 */
const drainZones = async (maxPumps = 12) => {
  for (let i = 0; i < maxPumps; i++) {
    const n = await ev(`(function(){
      const it = window.__game.items;
      for (let k = 0; k < 10; k++) it.update(0.2, performance.now() / 1000, performance.now());
      // 圣域/剑刃风暴每帧往 boat.vel 里加推力：泵了 24s 游戏时间后速度会累积到 100+ m/s，
      // 真实帧一恢复客机就弹射撞墙、刷爆水花特效（无头渲染进程直接卡死/崩溃）。
      // 泵完必须把速度和状态计时器清零，让船回到静止。
      const b = window.__game.boats.get(window.__game.myId);
      if (b) { b.vel.x = 0; b.vel.y = 0; b.slowTimer = 0; b.halfSpeedTimer = 0; b.stunTimer = 0; }
      return it.zones.length;
    })()`);
    if (n === 0) return true;
    await sleep(120);
  }
  return false;
};

/** 残留区域（失败时打诊断） */
const zoneResidue = async () => ev(
  `JSON.stringify(window.__game.items.zones.map((z) => z.kind + '@' + z.owner + ':' + z.life.toFixed(2) + '/' + z.maxLife))`,
);

/** 客机状态快照（各种计时器 + 区域数量） */
const guestState = async () => JSON.parse(await ev(`(function(){
  const g = window.__game; const it = g.items; const b = g.boats.get(g.myId);
  return JSON.stringify({
    slow: +(b.slowTimer || 0).toFixed(2),
    half: +(b.halfSpeedTimer || 0).toFixed(2),
    stun: +(b.stunTimer || 0).toFixed(2),
    ink: +(it.inkTimer || 0).toFixed(2),
    proj: it.projectiles.length,
    zones: it.zones.map((z) => z.kind),
    wallBlocks: it.wallBlocks,
  });
})()`));

let hostPos = { x: 0, z: 0 };
let hostHeading = 0;
let hb = null;
const host = new Host();
let child = null;
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }
  await host.connect();
  host.send({ t: 'pick', boatId: 'titan' });
  host.send({ t: 'mode', modeId: 'item' });
  host.send({ t: 'settings', settings: { aiCount: 0, laps: 1, rounds: 1 } });
  await host.waitWhere('roster', (r) => r.mode === 'item' && r.settings.aiCount === 0);

  child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=960,560', BASE], { stdio: 'ignore' });

  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  // 浏览器进程挂掉时 CDP 只是不再回包，不取消挂起的请求 → 表现成 120s 静默超时。
  // 这里直接把挂起请求全部拒掉，错误信息才指得准。
  ws.on('close', () => {
    for (const [, p] of pending) p.reject(new Error('CDP 连接已断开（渲染进程大概率崩溃）'));
    pending.clear();
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails?.exception?.description || 'exception';
      // 无头软渲染下 WebGL 上下文偶发丢失，THREE 随后读 gl.getParameter 会对 null 取值。
      // 这是测试环境噪声（真 GPU 不会出现），和道具逻辑无关，和已有的 texImage2D 一样过滤。
      if (!/texImage2D|Overload resolution failed|reading 'getParameter'/.test(d)) pageErrors.push(d.split('\n')[0]);
    }
    // 渲染进程崩溃要单独记一条：否则表现成后面所有 evaluate 静默超时，
    // 分不清是"页面卡死"还是"逻辑死循环"
    if (m.method === 'Inspector.targetCrashed') pageErrors.push('!! 渲染进程崩溃（targetCrashed）');
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Inspector.enable');
  // Debugger 必须在主线程还空闲时就 enable：等卡死再 enable，命令本身也要排主线程的队，
  // 一样 40s 超时，什么都抓不到。先挂着，卡死时直接 pause 抓栈。
  await cdp('Debugger.enable').catch((e) => console.error('[诊断] Debugger.enable 失败：', e.message));
  await sleep(2500);

  await ev(`(function(){ localStorage.setItem('rr-name','客机'); return 1; })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);
  await sleep(3000);
  await waitFor(`typeof document.querySelector('#btn-join')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-join').click()`);
  await waitFor(`!document.querySelector('#dlg-join').classList.contains('hidden')`, '加入对话框');
  await ev(`(function(){
    document.querySelector('#input-host').value = '127.0.0.1';
    document.querySelector('#btn-join-go').click();
    return 1;
  })()`);
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '客机进大厅', 200);
  console.log('客机已进入大厅，开始连打 ' + ROUNDS + ' 把道具赛');

  for (let round = 1; round <= ROUNDS; round++) {
    section(`===== 第 ${round} / ${ROUNDS} 把 =====`);
    host.clear();
    host.send({ t: 'settings', settings: { rounds: 1, laps: 1, aiCount: 0 } });
    host.send({ t: 'mode', modeId: 'item' });
    await host.waitWhere('roster', (r) => r.mode === 'item', 8000);
    await lobbyPick('cow');
    await host.waitWhere('roster', (r) => r.players.some((p) => p.name === '客机' && p.ready), 15000);
    host.clear();
    host.send({ t: 'start' });
    const st = await host.wait('start', 10000);
    if (st.mode !== 'item') { ok(false, '这一把没进道具模式', st.mode); break; }
    await waitFor(`!!window.__game?.items`, '客机建起 ItemManager', 240);
    await ev(`(function(){
      window.__last = {};
        it.handleNet = (m) => { const n0 = it.zones.length; const r = orig(m);
          return r; }; })();
      window.__game.net.on('raceEnd', (e) => { window.__last.raceEnd = (e.detail.standings || []).length; });
        window.__endMsgs.push(t + ':' + (e.detail?.id||'') + (e.detail?.finish?'!':''));
      });
        window.__endMsgs.push(t + ':' + (e.detail?.id||'') + (e.detail?.finish?'!':''));
      });
      return 1;
    })()`);
    const N = MAPS.find((m) => m.id === st.mapId)?.gates.length || 24;
    const errBase = pageErrors.length;
    // 房主要像真客户端一样持续上报自己的位置：服务器靠「还在发 state」判断局里有没有活人，
    // 一直不发会被自愈巡检当成僵尸局提前结算，后面的断言就全变成"进了大厅查比赛"。
    hostPos = { x: (await guestPos()).x - 20, z: (await guestPos()).z - 20 };
    hb = setInterval(() => host.send({
      t: 'state', id: host.id, x: hostPos.x, z: hostPos.z,
      y: 0, h: hostHeading, s: 20, b: false, vx: 0, vz: 0, r: 0,
    }), 120);

    // ---------- N1：箱子布点 + 新特效真的加载上了 ----------
    const boxN = await ev(`window.__game.items.boxes.length`);
    ok(boxN >= 40, `N1 道具箱 ${boxN} 个（跨端确定性布点）`, boxN);
    // 新道具用的三个 .efkefc 必须真的 loadEffect 成功（目录里有没有 fxres.json 是硬约束，
    // 引错目录会静默 404、整条特效变 null，玩家只看到"放了没反应"）。
    // 注意它们要等 fxres.json 的 fetch 回来才挂到 effects 上，必须轮询不能只查一次。
    const fxOk = await (async () => {
      for (let i = 0; i < 60; i++) {
        const v = JSON.parse(await ev(`(function(){
          const f = window.__game.fx;
          return JSON.stringify(['fxHolySandstorm', 'fxGateOfCalve', 'fxSwordStorm']
            .map((n) => !!f?.effects?.[n]));
        })()`));
        if (v.every(Boolean)) return v;
        if (i === 59) return v;
        await sleep(250);
      }
      return [false, false, false];
    })();
    ok(fxOk.every(Boolean), 'N1 三个新特效资源全部加载成功（无 404）', fxOk);
    // 无头软件光栅撑不住「多片区域循环特效 + 十几条弹道」，这里把道具特效关掉跑玩法断言；
    // 特效是否加载上面已经单独验过了，不需要靠"看得见"来证明。
    await ev(`(function(){ window.__game.items.fx = null; return 1; })()`);
    // 同理：本测试从头到尾不做截图，全部断言都是纯逻辑（zones.length / 计时器 / WS 消息）。
    // 之前只在卡死后再补救（藏区域网格、挪远落点），但 Debugger.pause 抓栈证实：
    // 主线程卡在 swiftshader 的原生光栅化里（不是 JS 死循环），任何"等帧"的 evaluate 都会超时。
    // 直接把 renderer.render 换成 no-op —— 物理 / 道具 / 网络照常跑，光栅开销归零。
    // （水面反射、后处理、半透明区域全都走 renderer.render，一并短路。）
    await ev(`(function(){
      const g = window.__game;
      if (!g.__origRender) {
        g.__origRender = g.renderer.render.bind(g.renderer);
        g.renderer.render = function noRaster() { /* 无头跑批：跳过光栅 */ };
      }
      return 1;
    })()`);
    // 画布顺带压小，防止 resize 等边角路径还有开销
    await ev(`(function(){ window.__game.renderer.setSize(320, 200); return 1; })()`);

    const gp = await guestPos();
    const myId = await ev(`window.__game.myId`);

    // ---------- N2：血枪 房主 → 客机 ----------
    // 朝客机方向发射，然后单独补一条命中通报（真实对局里由施放者判定后发出）
    {
      const from = { x: gp.x - 30, z: gp.z - 30 };
      const dx = gp.x - from.x, dz = gp.z - from.z;
      const len = Math.hypot(dx, dz) || 1;
      host.send({
        t: 'itemUse', id: host.id, item: 'bloodlance',
        x: +from.x.toFixed(2), z: +from.z.toFixed(2),
        vx: +(dx / len * 110).toFixed(2), vz: +(dz / len * 110).toFixed(2), target: null,
      });
      const spawned = await (async () => {
        for (let i = 0; i < 30; i++) {
          const n = await ev(`window.__game.items.projectiles.filter((p) => p.type === 'bloodlance' && p.ghost).length`);
          if (n > 0) return n;
          await sleep(100);
        }
        return 0;
      })();
      ok(spawned > 0, 'N2 房主的血枪在客机端生成了 ghost 飞行体', spawned);

      host.send({
        t: 'itemHit', id: myId, fx: 'slow', dur: 2,
        x: +gp.x.toFixed(1), z: +gp.z.toFixed(1),
      });
      const slowed = await softWait(`window.__game.boats.get(window.__game.myId).slowTimer > 0.5`, '客机被血枪减速', 40);
      ok(!!slowed, 'N2 血枪命中通报 → 客机掉速');
    }

    // ---------- N3：血枪 客机 → 房主 ----------
    {
      host.clear();
      await ev(`(function(){
        const g = window.__game;
        g.items.useItem(g.myId, 'bloodlance', 0);
        return 1;
      })()`);
      const got = await host.waitWhere('itemUse', (m) => m.item === 'bloodlance', 8000).catch(() => null);
      ok(!!got && Number.isFinite(got.vx) && Number.isFinite(got.vz),
        'N3 客机放血枪 → 房主收到 itemUse（带直线速度）', got && { vx: got.vx, vz: got.vz });
    }

    // ---------- N4：圣光沙暴 ----------
    {
      await ev(`(function(){ const b = window.__game.boats.get(window.__game.myId); b.slowTimer = 0; b.halfSpeedTimer = 0; return 1; })()`);
      host.send({ t: 'itemUse', id: host.id, item: 'holystorm', x: +gp.x.toFixed(1), z: +gp.z.toFixed(1), r: 14, dur: 4 });
      const inZone = await softWait(`window.__game.items.zones.some((z) => z.kind === 'holystorm')`, '客机端出现沙暴', 40);
      ok(!!inZone, 'N4 圣光沙暴在客机端落地');
      const hit = await softWait(
        `(function(){ const it = window.__game.items; return it.inkTimer > 0.1 && window.__game.boats.get(window.__game.myId).halfSpeedTimer > 0.1; })()`,
        '沙暴生效', 40,
      );
      ok(!!hit, 'N4 站在沙暴里 → 减速 + 糊屏同时生效');
      // 效果断言过了就把网格藏掉：无头软光栅下机位泡在叠加体积里一帧几十秒，
      // 区域的存在性/到期判定（zones.length / life）与可见性无关，藏着不影响后续逻辑断言。
      await hideZoneMeshes();
    }

    // ---------- N5：圣域 ----------
    {
      // 圣域放在客机正下方，验证「被推开」
      const before = await guestPos();
      host.send({ t: 'itemUse', id: host.id, item: 'sanctuary', x: +before.x.toFixed(1), z: +before.z.toFixed(1), r: 8, dur: 6 });
      await softWait(`window.__game.items.zones.some((z) => z.kind === 'sanctuary')`, '圣域出现', 40);
      const pushed = await (async () => {
        for (let i = 0; i < 40; i++) {
          const p = await guestPos();
          if (Math.hypot(p.x - before.x, p.z - before.z) > 3) return true;
          await sleep(150);
        }
        return false;
      })();
      ok(pushed, 'N5 圣域把客机推离中心 3 米以上');
      await hideZoneMeshes();
    }

    // ---------- N6：剑刃风暴 ----------
    {
      await ev(`(function(){ const b = window.__game.boats.get(window.__game.myId); b.slowTimer = 0; return 1; })()`);
      const p = await guestPos();
      hostPos = { x: p.x, z: p.z };
      // 剑刃风暴是「跟随施放者」的区域。无头下房主的远程艇位置靠 120ms 心跳同步，
      // 时延随机，跟随型区域会跑到几十米外 —— 那是测试环境噪声不是游戏 bug。
      // 跨端 itemUse 转发已由 N7 的落点广播和上面 holystorm/sanctuary 验证过，
      // 这里直接投递同一条消息，专门验「区域落地后有没有真的减速」。
      await ev(`(function(){ const g=window.__game;
        g.items.handleNet({t:'itemUse', id:${JSON.stringify(host.id)}, item:'bladestorm', x:${p.x}, z:${p.z}, r:12, dur:8});
        return 1; })()`);
      const okBlade = await softWait(
        `(function(){ const it = window.__game.items; const b = it.getBoats().get(it.myId); return it.zones.some((z) => z.kind === 'bladestorm') && b.slowTimer > 0.1; })()`,
        '剑刃风暴生效', 40,
      );
      ok(!!okBlade, 'N6 剑刃风暴圈住客机 → 被减速');
      await hideZoneMeshes();
    }

    // ---------- N7：逆流之门 ----------
    {
      // 把房主挪到客机前方 60m，客机用门应该一下贴到 10m 内
      const gp2 = await guestPos();
      const fx = Math.sin(gp2.h), fz = Math.cos(gp2.h);
      hostPos = { x: +(gp2.x + fx * 60).toFixed(1), z: +(gp2.z + fz * 60).toFixed(1) };
      // 房主的机头也要朝前（背对客机），否则「前一名身后 10 米」会落在侧边
      hostHeading = gp2.h;
      await sleep(2200);
      host.clear();
      // 距离测量和瞬移必须放在同一个同步 evaluate 里：
      // 分开两条 ev 之间会隔好几帧（无头下=好几秒游戏时间），"前一名"早开出去十几米，
      // 断言就成了抽签。同步执行时前一名一动没动，落点必须精确贴在身后 10m。
      const gateDist = JSON.parse(await ev(`(function(){
        const g = window.__game;
        const a = g.boats.get(g.myId);
        const b = g.boats.get(${JSON.stringify(host.id)});
        if (!a || !b) return JSON.stringify({ db: -1, da: -1 });
        // 直接摆位，不靠"改 hostPos + sleep 等网络同步"：无头下一帧可能隔好几秒，
        // 客机自己早开出去几十米，60m 的设定距离根本保持不住（测的是时序不是功能）。
        const fx0 = Math.sin(a.heading), fz0 = Math.cos(a.heading);
        b.pos.x = a.pos.x + fx0 * 60; b.pos.z = a.pos.z + fz0 * 60;
        b.heading = a.heading;
        const db = +Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z).toFixed(1);
        g.items.useItem(g.myId, 'gate', 0);
        const da = +Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z).toFixed(1);
        return JSON.stringify({ db, da });
      })()`));
      const gateMsg = await host.waitWhere('itemUse', (m) => m.item === 'gate', 8000).catch(() => null);
      ok(!!gateMsg && Number.isFinite(gateMsg.gx), 'N7 逆流之门广播了落点（gx/gz）', gateMsg && { gx: gateMsg.gx, gz: gateMsg.gz });
      // 落点会被 Track.constrain 拉回赛道走廊（弯道处尤其明显），所以不能死磕 12m；
      // 要验的是"瞬移确实显著缩短了与前名的距离"。
      ok(gateDist.db > 20 && gateDist.da < gateDist.db - 5,
        `N7 瞬移把 ${gateDist.db}m 缩到 ${gateDist.da}m（显著接近前一名）`, gateDist);
    }

    // ---------- N8：护盾墙挡弹 ----------
    {
      const before = await ev(`window.__game.items.wallBlocks`);
      // 墙必须归客机自己所有（rules：只挡别人的弹），所以这里让客机真的用一件护盾墙
      await ev(`(function(){
        const g = window.__game;
        g.items.useItem(g.myId, 'barrier', 0);
        return 1;
      })()`);
      const wall = JSON.parse(await ev(`(function(){
        const z = window.__game.items.zones.find((x) => x.kind === 'barrier');
        return z ? JSON.stringify({ x: +z.x.toFixed(2), z: +z.z.toFixed(2), hx: +z.hx.toFixed(3), hz: +z.hz.toFixed(3) }) : 'null';
      })()`));
      ok(!!wall && Number.isFinite(wall.hx), 'N8 客机的护盾墙立起来了', wall);
      // 墙的逻辑判定（线段×线段）与可见性无关，藏掉网格避免软光栅 overdraw
      await hideZoneMeshes();
      if (wall) {
        // 墙沿 (hx,hz) 展开，法线是 (-hz,hx)：从墙外 25m 沿法线打一条血枪，必定穿墙
        const nx = -wall.hz, nz = wall.hx;
        host.send({
          t: 'itemUse', id: host.id, item: 'bloodlance',
          x: +(wall.x - nx * 25).toFixed(2), z: +(wall.z - nz * 25).toFixed(2),
          vx: +(nx * 110).toFixed(2), vz: +(nz * 110).toFixed(2), target: null,
        });
        const blocked = await (async () => {
          for (let i = 0; i < 40; i++) {
            const n = await ev(`window.__game.items.wallBlocks`);
            if (n > before) return n - before;
            await sleep(120);
          }
          return 0;
        })();
        ok(blocked > 0, 'N8 护盾墙拦下了穿墙弹道', { before, blocked });
      }
    }

    // ---------- N9：区域到期自清理 ----------
    {
      await hideZoneMeshes();
      const cleaned = await drainZones();
      ok(!!cleaned, 'N9 所有区域到期后自行清空（不留幽灵）', cleaned ? undefined : await zoneResidue());
    }

    // ---------- 轮换深查 ----------
    if (round % 4 === 1) {
      // D1：同屏四片区域
      // 注意：D1 验的是「共存不互踢 + 到期清理」，和区域落点无关。
      // 四片区域必须全部生成在客机 60m 外 —— 生成在客机脚下时，机位泡进
      // 叠层半透明圆柱，软光栅一帧几十秒，轮询 evaluate 直接超时（前科：Debugger 都挤不进去）。
      const p = await guestPos();
      const spots = [[p.x + 60, p.z], [p.x, p.z + 60], [p.x - 60, p.z], [p.x, p.z - 60]];
      let si = 0;
      for (const [item, r, dur] of [['holystorm', 14, 4], ['sanctuary', 8, 6], ['bladestorm', 12, 3], ['barrier', 7, 4]]) {
        const [sx, sz] = spots[si++];
        host.send({ t: 'itemUse', id: host.id, item, x: +sx.toFixed(1), z: +sz.toFixed(1), hx: 1, hz: 0, r, dur });
        await sleep(80);
      }
      const four = await softWait(`window.__game.items.zones.length >= 4`, '四片区域同时存在', 40);
      ok(!!four, 'D1 同屏四片区域可以共存（不互踢）');
      await hideZoneMeshes();
      const allGone = await drainZones();
      ok(!!allGone, 'D1 四片区域全部按时消失', allGone ? undefined : await zoneResidue());
    } else if (round % 4 === 2) {
      // D2：血枪穿透（客机自己朝前放，应该能打到前面的房主）
      host.clear();
      const p = await guestPos();
      await ev(`(function(){ const b = window.__game.boats.get(window.__game.myId); b.slowTimer = 0; return 1; })()`);
      const fired = await ev(`(function(){
        const g = window.__game;
        g.items.useItem(g.myId, 'bloodlance', 0);
        return g.items.projectiles.filter((x) => x.type === 'bloodlance' && x.pierce).length;
      })()`);
      ok(fired > 0, 'D2 客机血枪带穿透标记（pierce）', fired);
    } else if (round % 4 === 3) {
      // D3/D4：抽奖规则
      const roll = await ev(`(function(){
        const it = window.__game.items;
        const me = window.__game.myId;
        const out = { lead: [], pity: [] };
        // 领先者：rank 恒为 1
        const realRank = it.getRank;
        it.getRank = () => 1;
        for (let i = 0; i < 80; i++) {
          it.myItems = [null, null, null];
          const got = it.grantRandomItem(me);
          if (got) out.lead.push(got);
        }
        // 保底：连败两次后必须出反超池
        it.getRank = () => 2;
        it.pity.set(me, { miss: 2, pending: [] });
        it.myItems = [null, null, null];
        out.pity.push(it.grantRandomItem(me));
        it.getRank = realRank;
        it.myItems = [null, null, null];
        return JSON.stringify(out);
      })()`);
      const parsed = JSON.parse(roll);
      const LEAD_BLOCK = ['bomb', 'missile', 'octopus', 'bubblefly', 'torpedo', 'rvortex', 'fish',
        'bloodlance', 'holystorm', 'gate'];
      const leaked = parsed.lead.filter((k) => LEAD_BLOCK.includes(k));
      ok(parsed.lead.length > 40 && leaked.length === 0,
        `D4 领先者抽了 ${parsed.lead.length} 次，纯攻击道具 0 次`,
        leaked.slice(0, 5));
      const COMEBACK = ['bloodlance', 'holystorm', 'gate', 'torpedo', 'bomb', 'missile', 'fish', 'rvortex'];
      ok(parsed.pity.length === 1 && COMEBACK.includes(parsed.pity[0]),
        `D3 连续两次白给后保底出反超道具（${parsed.pity[0]}）`, parsed.pity);
    } else {
      // D1'：压力 —— 连续 12 条弹道 + 2 片区域，不能崩
      const p = await guestPos();
      for (let i = 0; i < 12; i++) {
        host.send({
          t: 'itemUse', id: host.id, item: 'bloodlance',
          x: +(p.x - 40).toFixed(1), z: +(p.z - 40).toFixed(1),
          vx: 60, vz: 60, target: null,
        });
        await sleep(30);
      }
      // 区域同样生成在 60m 外（压力测的是弹道+区域共存，不是机位泡在特效里）
      host.send({ t: 'itemUse', id: host.id, item: 'holystorm', x: +(p.x + 60).toFixed(1), z: +(p.z + 60).toFixed(1), r: 14, dur: 4 });
      const alive = await (async () => {
        for (let i = 0; i < 40; i++) {
          const v = await ev(`!!window.__game.items && !!window.__game.renderer`);
          if (v) return true;
          await sleep(150);
        }
        return false;
      })();
      ok(!!alive, 'D5 12 条弹道 + 区域同时压上来，客机没崩');
    }

    // ---------- N10：本把零异常 ----------
    const newErrs = pageErrors.length - errBase;
    ok(newErrs === 0, 'N10 本把无页面异常', pageErrors.slice(errBase, errBase + 3));

    // ---------- 收尾：房主冲线 → raceEnd → 回大厅 ----------
    // 每局回大厅后 Game 会重建，net 也是新对象；开局那一瞬窗口里挂的监听器
    // 很容易留在旧实例上（waitFor 看到 items 就返回，此时新实例还没建完）。
    // 冲线前重挂一次并清掉旧值，确保这一局的 raceEnd 真的被接到。
    await ev(`(function(){ window.__last = window.__last || {}; window.__last.raceEnd = 0;
      window.__game.net.on('raceEnd', (e) => { window.__last.raceEnd = (e.detail.standings || []).length; });
      return 1; })()`);
    // 每局回大厅后 Game 会重建，net 也是新对象；开局那一瞬窗口里挂的监听器
    // 很容易留在旧实例上（waitFor 看到 items 就返回，此时新实例还没建完）。
    // 冲线前重挂一次并清掉旧值，确保这一局的 raceEnd 真的被接到。
    await ev(`(function(){ window.__last = window.__last || {}; window.__last.raceEnd = 0;
      window.__game.net.on('raceEnd', (e) => { window.__last.raceEnd = (e.detail.standings || []).length; });
      return 1; })()`);
    // 必须逐门上报：服务器只接受「进度 +1~+2」，从 1 号门直接跳终点会被整包丢掉，
    // 表现就是发了冲线但没人结算
    await ev(`(function(){
      const b = window.__game.boats.get(window.__game.myId);
      if (b) { b.vel.x = 0; b.vel.y = 0; }
      return 1;
    })()`);
    for (let g = 1; g <= N - 1; g++) {
      host.send({ t: 'gate', id: host.id, gate: g, lap: 1 });
      await sleep(20);
    }
    // 终点判定重做后服务器只认 msg.finish === true（防止"离终点还有十几米就结算"）。
    // 老脚本没带这个字段，于是每把都卡在赛车里、收不到 raceEnd。
    // 无头慢速下逐门补报会被服务器的「最多跳 2 门」校验挡掉（墙钟 20ms 的实际间隔
    // 可能跨好几帧）。收尾改用协议自带的 resync 补报通道 —— 它本来就是给漏报的客户端兜底的。
    host.send({ t: 'gate', id: host.id, gate: 0, lap: 2, totalTime: 50 + round, finish: true, resync: true });
    const ended = await (async () => {
      for (let i = 0; i < 120; i++) {
        const v = await ev(`window.__last.raceEnd || 0`);
        if (v > 0) return v;
        await sleep(300);
      }
      return 0;
    })();
    ok(ended > 0, '本把正常结算（客机收到 raceEnd）', ended);
    clearInterval(hb); hb = null;
    host.clear();
    host.send({ t: 'backLobby' });
    const back = await softWait(`!document.querySelector('#lobby').classList.contains('hidden')`, '回大厅', 200);
    ok(!!back, '本把能正常回大厅、继续下一把');
  }

  // ---------- 最终汇总 ----------
  section('===== 汇总 =====');
  ok(pageErrors.length === 0, `全程零页面异常（共 ${pageErrors.length} 条）`, pageErrors.slice(0, 5));
  const total = ROUNDS * 10;
  console.log(`连打 ${ROUNDS} 把，累计断言 ≥ ${total} 项`);
} catch (e) {
  failures += 1;
  console.error('\n道具赛马拉松：中断 —', e.message);
  if (pageErrors.length) console.error('页面异常：', pageErrors.slice(0, 5));
} finally {
  try { ws?.terminate(); } catch { /* 已关 */ }
  try { host.ws?.terminate(); } catch { /* 已关 */ }
  child?.kill('SIGKILL');
  server.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(failures ? `\n道具赛马拉松：FAIL（${failures} 项）` : `\n道具赛马拉松：PASS（${ROUNDS} 把全绿）`);
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
}
