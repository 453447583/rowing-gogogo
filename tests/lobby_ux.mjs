// 大厅体验三项验收：展示台鼠标拖动 / 聊天框贴玩家列表 / 迎宾横幅
//   node tests/lobby_ux.mjs
//
// 2026-11-14 用户需求：
//   ① 大厅中央赛艇只会自动旋转 → 加鼠标拖动：水平=左右转身、垂直=俯仰（机位升降），
//     松手 3 秒后平滑回到自动摆头
//   ② 聊天框展开会遮玩家列表 → 改为贴在玩家列表上沿、左对齐，高度自适应不顶标题
//   ③ 联机有人进房 → 展示台上方弹「欢迎"Xxx"贵宾进入房间」；有人退房弹灰色离开提示
//
// 浏览器先进房（成为房主），裸 WS 客机后进 → 触发欢迎；断开 → 触发离开。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HTTP_PORT = Number(process.env.PORT) || 3641;
const WS_PORT = Number(process.env.WS_PORT) || 3642;
const cdpPort = 9700 + Math.floor(Math.random() * 90);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = 'D:/3Dgame - 副本/D:/3dgame-tmp/browser/lobby-ux-' + Date.now();
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};
const T0 = Date.now();
const section = (t) => console.log('\n[' + ((Date.now() - T0) / 1000).toFixed(0) + 's] ' + t);

let ws; let seq = 0;
const pending = new Map();
const pageErrors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`cdp timeout: ${m}`)), 40000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', {
    expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
  return r.result?.value;
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

const softWaitText = async () => {
  for (let i = 0; i < 40; i++) {
    const t = await ev(`document.querySelector('#lobby-players').textContent.includes('贵宾测试')`);
    if (t) return true;
    await sleep(200);
  }
  return false;
};

/** 裸 WS 客机（后来进房的那位「贵宾」） */
class Guest {
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      this.msgs = [];
      const timer = setTimeout(() => reject(new Error('客机连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: '贵宾测试', session: 'guest-ux' })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { clearTimeout(timer); resolve(msg); }
      });
    });
  }
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

let child = null;
try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }

  // ---------- 浏览器进房（先到 → 房主） ----------
  child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--window-size=1280,760', BASE], { stdio: 'ignore' });

  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('close', () => {
    for (const [, p] of pending) p.reject(new Error('CDP 连接已断开'));
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
      if (!/texImage2D|Overload resolution failed/.test(d)) pageErrors.push(d.split('\n')[0]);
    }
    if (m.method === 'Inspector.targetCrashed') pageErrors.push('!! 渲染进程崩溃');
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Inspector.enable');
  // headless 默认视口 ~800×637，比真实游玩小得多，布局断言会被假挤压。
  // 统一到 1600×900 再量。
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(2500);

  await ev(`(function(){ localStorage.setItem('rr-name','房主本机'); return 1; })()`);
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
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '进大厅', 200);
  section('浏览器已进大厅（房主）');

  // ---------- ① 展示台鼠标拖动 ----------
  section('① 展示台鼠标拖动转身 / 俯仰');
  const hasShowcase = await waitFor(`!!window.__showcase && !!window.__showcase.model`, '展示台就绪');
  ok(!!hasShowcase, '大厅展示台已建好（window.__showcase）');
  const before = await ev(`(function(){
    const s = window.__showcase;
    return JSON.stringify({ yaw: +s.holder.rotation.y.toFixed(3), camY: +s.camera.position.y.toFixed(2), manual: +s.manual.toFixed(2) });
  })()`);
  const b = JSON.parse(before);
  ok(b.manual < 0.3, '初始是自动摆头模式', before);
  // 模拟拖动：按下 → 向右拖 260px、向上拖 120px → 松手
  await ev(`(function(){
    const s = window.__showcase;
    const el = s.renderer.domElement;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pe = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true,
    }));
    pe('pointerdown', cx, cy);
    for (let i = 1; i <= 8; i++) pe('pointermove', cx + i * 32, cy - i * 15);
    pe('pointerup', cx + 256, cy - 120);
    return 1;
  })()`);
  await sleep(500);
  const after = JSON.parse(await ev(`(function(){
    const s = window.__showcase;
    return JSON.stringify({ yaw: +s.holder.rotation.y.toFixed(3), camY: +s.camera.position.y.toFixed(2), manual: +s.manual.toFixed(2), userYaw: +s.userYaw.toFixed(3) });
  })()`));
  ok(after.manual > 0.6, '拖动后切到手动接管', after);
  ok(Math.abs(after.yaw - b.yaw) > 0.5, `拖动真的转了身（yaw ${b.yaw} → ${after.yaw}）`);
  ok(after.camY > b.camY + 0.4, `向上拖抬升了机位（camY ${b.camY} → ${after.camY}）`);
  // 松手 3 秒后回到自动
  await sleep(3600);
  const resume = JSON.parse(await ev(`(function(){
    const s = window.__showcase;
    return JSON.stringify({ manual: +s.manual.toFixed(2), yaw: +s.holder.rotation.y.toFixed(3) });
  })()`));
  ok(resume.manual < 0.6, '松手 3 秒后平滑交还自动摆头', resume);

  // ---------- ② 聊天框贴玩家列表上沿 ----------
  section('② 聊天框位置（不再遮玩家列表）');
  // 房主加一台 AI 充人数，让玩家列表有多行
  await ev(`(function(){ return 1; })()`);
  // 按 Enter 打开大厅聊天
  await ev(`(function(){
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return 1;
  })()`);
  await waitFor(`document.querySelector('#chat-lobby').classList.contains('open')`, '聊天面板打开');
  await sleep(400);   // 等 placeLobby 定位 + 过渡
  console.log('  [dump]', await ev(`(function(){
    const w = document.querySelector('.lobby-roster-wrap');
    const kids = [...w.children].map((k) => (k.id || k.className) + '=' + Math.round(k.getBoundingClientRect().height));
    return JSON.stringify({ rosterH: Math.round(w.getBoundingClientRect().height), kids,
      brandH: Math.round(document.querySelector('.lobby-brand').getBoundingClientRect().height) });
  })()`));
  const layout = JSON.parse(await ev(`(function(){
    const chat = document.querySelector('#chat-lobby').getBoundingClientRect();
    const roster = document.querySelector('.lobby-roster-wrap').getBoundingClientRect();
    const brand = document.querySelector('.lobby-brand').getBoundingClientRect();
    const log = document.querySelector('#chat-lobby-log');
    return JSON.stringify({
      chatTop: Math.round(chat.top), chatBottom: Math.round(chat.bottom),
      rosterTop: Math.round(roster.top), brandBottom: Math.round(brand.bottom),
      logMax: log.style.maxHeight, logClientH: log.clientHeight,
    });
  })()`));
  ok(layout.chatBottom <= layout.rosterTop + 6, `聊天底沿贴在列表上沿（${layout.chatBottom} ≤ ${layout.rosterTop}+6）`, layout);
  ok(layout.chatTop >= layout.brandBottom, `聊天顶端没碰标题（${layout.chatTop} ≥ ${layout.brandBottom}）`, layout);
  ok(layout.logMax && parseInt(layout.logMax) <= 172, '消息区高度被自适应钳制', layout.logMax);
  await ev(`(function(){
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 1;
  })()`);

  // ---------- ③ 迎宾横幅 ----------
  section('③ 进房欢迎 / 退房离开横幅');
  const guest = new Guest();
  await guest.connect();
  // 诊断：名单有没有在浏览器侧更新（roster 处理器是否跑过）
  const rosterShown = await softWaitText();
  console.log('  [dump] 名单含贵宾:', rosterShown,
    '| 横幅元素:', await ev(`(function(){ const el = document.querySelector('#lobby-welcome'); return el ? el.outerHTML.slice(0, 160) : 'null'; })()`));
  const welcomed = await waitFor(`(function(){
    const el = document.querySelector('#lobby-welcome');
    return !!(el && el.classList.contains('show') && !el.classList.contains('bye') && el.textContent.includes('贵宾测试'));
  })()`, '欢迎横幅出现');
  const welcomedText = await ev(`document.querySelector('#lobby-welcome').textContent`);
  ok(!!welcomed, `进房弹出欢迎横幅：${welcomedText}`);
  // 效果截图：大厅是 DOM UI（无大块 WebGL overdraw），CDP 截图安全。
  // 截图前把聊天框也打开，让「欢迎横幅 + 聊天贴列表上沿」同框呈现。
  // 注意：此前用 Esc 关聊天时，main.js 的 Esc 处理器顺手开了设置面板（既有交互），
  // 这里先补一发 Esc 关掉设置，再 Enter 开聊天。
  await ev(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 1; })()`);
  await sleep(200);
  await ev(`(function(){ window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
  await sleep(500);
  try {
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 84 });
    const fs = await import('node:fs/promises');
    const out = fileURLToPath(new URL('../shots/verify/', import.meta.url));
    await fs.mkdir(out, { recursive: true });
    await fs.writeFile(out + 'lobby_welcome_chat.jpg', Buffer.from(shot.data, 'base64'));
    ok(true, '截图已保存 shots/verify/lobby_welcome_chat.jpg');
  } catch (e) {
    console.error('  (截图失败，不影响断言：', e.message + ')');
  }
  // 4 秒后自动淡出
  const faded = await (async () => {
    for (let i = 0; i < 30; i++) {
      const showing = await ev(`document.querySelector('#lobby-welcome').classList.contains('show')`);
      if (!showing) return true;
      await sleep(200);
    }
    return false;
  })();
  ok(faded, '横幅约 4 秒自动淡出');
  // 退房 → 灰色离开提示
  guest.ws.close();
  const bye = await waitFor(`(function(){
    const el = document.querySelector('#lobby-welcome');
    return !!(el && el.classList.contains('show') && el.classList.contains('bye') && el.textContent.includes('离开'));
  })()`, '离开横幅出现');
  const byeText = await ev(`document.querySelector('#lobby-welcome').textContent`);
  ok(!!bye, `退房弹出灰色离开提示：${byeText}`);

  // ---------- 收尾 ----------
  ok(pageErrors.length === 0, '全程零页面异常', pageErrors.slice(0, 4));
} catch (e) {
  failures += 1;
  console.error('\n✗ 探针中断：', e.message);
} finally {
  try { await cdp('Browser.close').catch(() => {}); } catch { /* 已断 */ }
  if (child) spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  server.kill();
}

console.log('\n===== 汇总 =====');
console.log(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
