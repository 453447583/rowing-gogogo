// HUD 换皮出图：竞速 / 道具 / 怪物 三张，只看观感不做断言。
//
//   node tests/hud_skin_shot.mjs
//
// 注意：
//   - 无头窗口的视口比 --window-size 小一圈（800×460 实测只有 779×326），
//     那个高度塞不下 210px 速度表，HUD 会互相压。用 Emulation.setDeviceMetricsOverride
//     覆写成 1280×720，只在启动时改一次，不碰运行中的 renderer.setSize
//     （那会让 Effekseer 抛 texImage2D）。
//   - 模式切换靠"重载页面→大厅→选模式"，比在比赛里找退赛按钮可靠。
//   - 收进程走 taskkill /T，否则 Edge 的渲染子进程会留成孤儿把 CPU 占满。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hud-skin-' + Date.now());
const port = 9600 + Math.floor(Math.random() * 90);
const httpPort = 5330 + Math.floor(Math.random() * 60);
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=800,460',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// ONLY=race|item|boss|arena 只跑其中一张，省时间
const only = process.env.ONLY || '';
let ws;

try {
  let tabs = null;
  for (let i = 0; i < 200 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
  if (!tabs) throw new Error('Edge 调试端口没起来');
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
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
  const bail = (why) => { for (const [, q] of pending) q.rej(new Error(why)); pending.clear(); };
  ws.on('close', () => bail('CDP 连接已关闭'));
  ws.on('error', () => bail('CDP 连接出错'));
  const cdp = (method, params = {}, timeout = 90000) => {
    const id = ++seq;
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { return Promise.reject(e); }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id); rej(new Error(`CDP 超时 ${timeout}ms: ${method}`));
      }, timeout);
      pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
    });
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
  });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 60000, label = expr) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await wait(400);
    }
    throw new Error('timeout waiting for ' + label);
  };
  const shot = async (file) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 120000);
    await fs.mkdir('shots/verify', { recursive: true });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log('   · 出图', file);
  };

  /** 从当前状态一路走到"大厅里选好模式、已发车、比赛开始" */
  const startRace = async (mode) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 45000, '菜单启动');
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        await cdp('Page.reload', {});
        await wait(3000);
      }
    }
    for (let i = 0; i < 4; i++) {
      await ev('document.querySelector("#btn-solo").click()');
      await wait(800);
      if (await ev(`!document.querySelector('#lobby').classList.contains('hidden')`)) break;
      await wait(2000);
    }
    await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 90000, '进入大厅');
    if (mode && mode !== 'race') {
      await ev('document.querySelector("#btn-lobby-mode").click()');
      await waitFor(`!!document.querySelector('.lp-pill[data-mode="${mode}"]')`, 30000, '模式抽屉');
      await ev(`document.querySelector('.lp-pill[data-mode="${mode}"]').click()`);
      await wait(700);
      await ev('document.querySelector("#btn-lobby-pick-close")?.click()');
    }
    await ev('document.querySelector("#btn-start-race").click()');
    await waitFor(`!document.querySelector('#hud').classList.contains('hidden')`, 90000, '比赛 HUD');
    // 软件渲染下一帧要 0.3~1s，倒计时（3s 游戏时间）可能要走十几秒；
    // 等不到就直接截图，别把整轮卡死在这。
    await waitFor(`document.querySelector('#countdown').classList.contains('hidden')`, 90000, '倒计时结束')
      .catch(() => console.log('   · 倒计时没走完，直接截图'));
    await wait(800);
  };

  // ---------- 1. 竞速 ----------
  await startRace('race');
  await ev(`(function(){
    const nb = document.getElementById('hud-progress-bar');
    if (nb) nb.style.width = '42%';
    const nt = document.getElementById('hud-progress-text');
    if (nt) nt.innerHTML = '<span class="pt-label">赛道进度</span><b class="pt-num">42<small>%</small></b>';
    // 集气进度由 updateHud 每帧覆盖，直接改 DOM 宽度没用，改船上的状态才能看到彩虹
    const b = window.__game?.localBoat;
    if (b) { b.nitroCharge = 0.58; b.nitroBottles = 1; }
    return 1;
  })()`);
  await wait(1000);
  // 右上那两块怪东西是什么？把落点上的元素打出来
  console.log('   · 右上落点元素：', await ev(`(function(){
    const at = (x, y) => document.elementsFromPoint(x, y).slice(0, 3)
      .map((e) => e.id || e.className || e.tagName).join(' > ');
    return JSON.stringify({ p850: at(850, 40), p1170: at(1170, 34) });
  })()`));
  console.log('   · 右上布局：', await ev(`(function(){
    const box = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return JSON.stringify(['#quality-btn', '#nitro-stock'].map(box));
  })()`));
  await shot('shots/verify/hud-race.jpg');

  // ---------- 2. 道具赛 ----------
  if (!only || only === 'item') {
    await cdp('Page.reload', {});
    await wait(3500);
    await startRace('item');
    await wait(1500);
    await shot('shots/verify/hud-items.jpg');
  }

  // ---------- 3. 怪物模式 ----------
  if (!only || only === 'boss') {
    await cdp('Page.reload', {});
    await wait(3500);
    await startRace('boss');
    await ev('window.__game.bossMode.introT = 99');
    await waitFor('window.__game.bossMode.phase === "countdown"', 60000, '倒计时');
    await ev('window.__game.bossMode.comboCharge = 0.62');
    await wait(1500);
    await shot('shots/verify/hud-boss.jpg');
  }

  // ---------- 4. 竞技场 ----------
  if (!only || only === 'arena') {
    await cdp('Page.reload', {});
    await wait(3500);
    await startRace('arena');
    await wait(2000);
    await shot('shots/verify/hud-arena.jpg');
  }
  console.log('PASS: 出图完成');
} finally {
  try { ws?.terminate(); } catch {}
  for (const p of [child, server]) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true }); } catch {}
  }
  await wait(600);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
