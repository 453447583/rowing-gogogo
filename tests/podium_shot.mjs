// 领奖台结算板截图验收：房主浏览器 + WS 客人跑完一局，抓领奖台（结算板浮在天空里）
//   node tests/podium_shot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';
import { MAPS } from '../src/data/maps.js';

const HTTP_PORT = 3421;
const WS_PORT = 3422;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/podium-' + Date.now());
const cdpPort = 9600 + Math.floor(Math.random() * 90);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (c, l, x) => { if (c) console.log('  ✓ ' + l); else { fail++; console.error('  ✗ ' + l, x === undefined ? '' : JSON.stringify(x)); } };

const server = spawn(process.execPath, ['server/server.js'], {
  env: {
    ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    // 别把探针账号写进真实排行榜文件
    LEADERBOARD_FILE: path.resolve('.tmp_build/podium.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1440,860', BASE], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 120000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const waitFor = async (expr, label, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
};
const shot = async (name) => {
  const res = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  await fs.writeFile(path.join(out, name + '.jpg'), Buffer.from(res.data, 'base64'));
  console.log('  shot -> shots/verify/' + name + '.jpg');
};

class Guest {
  constructor(name) { this.name = name; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 5000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'guest-podium' })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async wait(type, timeout = 8000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type) { this.cursors[type] = i + 1; return this.msgs[i]; }
      }
      if (Date.now() - start > timeout) throw new Error(`${this.name} 等 ${type} 超时`);
      await sleep(30);
    }
  }
  last(t) { return [...this.msgs].reverse().find((m) => m.t === t); }
  finish(mapId, laps) {
    const N = MAPS.find((m) => m.id === mapId).gates.length;
    for (let lap = 1; lap <= laps; lap++) for (let g = 0; g < N; g++) this.send({ t: 'gate', id: this.id, gate: g, lap });
    this.send({ t: 'gate', id: this.id, gate: 0, lap: laps + 1, totalTime: 58.4, finish: true });
  }
}

try {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch {}
    await sleep(200);
  }
  let tabs = null;
  for (let i = 0; i < 120 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails?.exception?.description || 'exception';
      // 无头软件渲染下 Effekseer 的 texImage2D 会失败，跟这套 UI 探针无关
      if (!/texImage2D/.test(d)) errors.push(d);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2200);

  await waitFor(`!!document.querySelector('#btn-host')`, '主菜单');
  // 账号体系：入口强制登录，先拿真实 token；占位串会被 /auth/session 校验清掉。
  const e2eToken = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, 'e2e房主');
  ok(!!e2eToken, '房主拿到账号 token', e2eToken ? 'ok' : 'empty');
  await ev(`localStorage.setItem('rr-name','房主'); localStorage.setItem('rr-account-token','${e2eToken}');`);
  // 现在「开始比赛」直接进大厅（赛艇/地图/天气/模式都在大厅里选），
  // 不再经过 #menu-boat / #btn-map-ok。慢机器上首屏绑定也慢，只在主菜单可见时点一次。
  for (let i = 0; i < 24; i++) {
    const onMain = await ev(`!document.querySelector('#menu-main').classList.contains('hidden')`).catch(() => false);
    if (!onMain) break;
    await ev(`document.querySelector('#btn-host')?.click()`).catch(() => {});
    await sleep(500);
  }
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, '大厅');
  await sleep(400);

  const guest = new Guest('二号');
  await guest.connect();
  // 房主在大厅选一艘没被占的赛艇
  await ev(`(() => { const c = [...document.querySelectorAll('.lp-card[data-boat]:not(.locked)')][0]; c && c.click(); return !!c; })()`);
  await sleep(500);
  guest.send({ t: 'pick', boatId: 'titan' });
  await guest.wait('roster');
  // 大厅流程里选完船还得单独准备，否则房主按钮一直是「等待二号准备…」
  guest.send({ t: 'ready', ready: true });
  await guest.wait('roster');
  // 1 圈 + 2 个 AI，让结算板有 4 行。三个 select 各自有 onchange，
  // 只触发 #sel-laps 的话 AI / 局数不会下发，开赛时还是 0 AI。
  await ev(`(() => {
    const s = document.querySelector('#sel-laps'); if (s) { s.value = '1'; }
    const ai = document.querySelector('#sel-ai'); if (ai) { ai.value = '${process.env.AICOUNT ?? '2'}'; }
    const rr = document.querySelector('#sel-rounds'); if (rr) { rr.value = '${process.env.ROUNDS || '1'}'; }
    // 依次触发 onchange 走服务器设置
    [s, ai, rr].forEach((x) => x && x.onchange && x.onchange()); return true;
  })()`);
  await sleep(600);
  await ev(`document.querySelector('#btn-start-race').click()`);
  const start = await guest.wait('start', 10000);
  ok(!!start.order.find((o) => o.ai), '本局带 AI', start.order.map((o) => o.name));
  await waitFor(`!!window.__game && !!window.__game.track`, '浏览器开赛');
  await ev(`(() => { try { window.__game.renderer.setSize(480, 300, false); } catch {} return true; })()`);

  guest.finish(start.mapId, start.laps);
  await guest.wait(process.env.ROUNDS === '3' ? 'roundEnd' : 'raceEnd', 30000);
  await waitFor(`!document.querySelector('#podium-board')?.classList.contains('hidden')`, '领奖台', 80);
  // 领奖台只有 10 秒，软件渲染下 captureScreenshot + 往返可能吃掉大半；
  // 先量 DOM 再截图，且不再额外 sleep，避免量到自动退出之后的结果页
  const board = await ev(`(() => {
    const b = document.querySelector('#podium-board');
    if (!b) return null;
    // 入场动画带 fill:both，没跑完时量到的是 from 帧（差 16px 会被误判成没居中）
    b.getAnimations?.().forEach((a) => { try { a.finish(); } catch {} });
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      visible: !b.classList.contains('hidden'),
      anims: b.getAnimations?.().map((a) => a.playState).join(',') || '',
      rows: b.querySelectorAll('.pb-row').length,
      title: document.querySelector('#podium-board-title')?.textContent,
      sub: document.querySelector('#podium-board-sub')?.textContent,
      bg: cs.backgroundColor, blur: cs.backdropFilter,
      bgImage: cs.backgroundImage,
      w: Math.round(r.width), h: Math.round(r.height),
      vw: document.documentElement.clientWidth,
      vh: innerHeight,
      centerDx: Math.round((r.left + r.right) / 2 - document.documentElement.clientWidth / 2),
      centerDy: Math.round((r.top + r.bottom) / 2 - innerHeight / 2),
      rowHeights: [...b.querySelectorAll('.pb-rows .pb-row')].map((x) => Math.round(x.getBoundingClientRect().height)),
      gapAvg: (() => {
        const rs = [...b.querySelectorAll('.pb-rows .pb-row')].map((x) => x.getBoundingClientRect());
        if (rs.length < 2) return 0;
        let sum = 0;
        for (let i = 1; i < rs.length; i++) sum += rs[i].top - rs[i - 1].bottom;
        return Math.round(sum / (rs.length - 1));
      })(),
      inView: r.right <= document.documentElement.clientWidth + 1 && r.left >= -1 && r.bottom <= innerHeight,
      meRow: !!b.querySelector('.pb-row.me'),
    };
  })()`);
  console.log('  board:', JSON.stringify(board));
  ok(board?.visible, '领奖台上结算板可见');
  ok(board?.rows >= 5, '结算板包含表头 + 全部选手', board?.rows);
  ok(board?.bg?.startsWith('rgba') || board?.bg?.startsWith('linear-gradient'), '背景是半透明', board?.bg);
  ok(board?.blur === 'none', '领奖台结算板不用毛玻璃，赛艇依然清晰', board?.blur);
  ok(board?.inView, '结算板没有超出屏幕');
  // 面板必须居中，且高度随人数（不再拉满整屏）
  ok(Math.abs(board?.centerDx ?? 999) <= 3, '面板水平居中', board?.centerDx);
  ok(Math.abs(board?.centerDy ?? 999) <= 3, '面板垂直居中', board?.centerDy);
  ok((board?.h ?? 9999) < board?.vh * 0.86, '面板高度由参赛人数决定，没拉满整屏', { h: board?.h, vh: board?.vh });
  ok((board?.gapAvg ?? 999) <= 12, '行距紧凑（不再是 space-evenly 摊开）', board?.gapAvg);
  ok(board?.meRow, '自己那一行有高亮');
  // 面板底色必须够透：领奖台上的赛艇要能透过来。
  // 取 background-image 里所有 rgba 的 alpha，最大那个就是面板最浓的地方。
  const alphas = [...String(board?.bgImage || '').matchAll(/rgba?\([^)]*?,\s*([\d.]+)\)/g)]
    .map((m) => Number(m[1]))
    .filter((a) => Number.isFinite(a));
  const maxAlpha = alphas.length ? Math.max(...alphas) : 1;
  ok(maxAlpha <= 0.35, '面板底色够透（最大 alpha ≤ 0.35）', { maxAlpha, alphas });
  ok(!/blur\((1[0-9]|[2-9][0-9])px/.test(board?.blur || ''), '背景模糊很轻，不会把赛艇糊成色块', board?.blur);
  await shot(process.env.ROUNDS === '3' ? 'podium-board-round' : 'podium-board');
  await waitFor(`!document.querySelector('#results').classList.contains('hidden')`, '结果页', 60);
  const hid = await ev(`document.querySelector('#podium-board')?.classList.contains('hidden')`);
  ok(hid === true, '进结果页后结算板已收起');
  // 结果页也必须居中，且面板尺寸跟着行数走
  const res = await ev(`(() => {
    const p = document.querySelector('#results');
    const r = p.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      vw: document.documentElement.clientWidth, vh: innerHeight,
      centerDx: Math.round((r.left + r.right) / 2 - document.documentElement.clientWidth / 2),
      centerDy: Math.round((r.top + r.bottom) / 2 - innerHeight / 2),
      rows: p.querySelectorAll('#results-body .nr-row').length,
    };
  })()`);
  console.log('  results:', JSON.stringify(res));
  ok(Math.abs(res.centerDx) <= 3, '结果页水平居中', res.centerDx);
  ok(Math.abs(res.centerDy) <= 3, '结果页垂直居中', res.centerDy);
  ok(res.h < res.vh * 0.9, '结果页高度由行数决定，没拉满整屏', { h: res.h, vh: res.vh, rows: res.rows });
  await shot('results-panel');
  ok(!errors.length, '无页面异常', errors.slice(0, 2));
} catch (e) {
  fail++;
  console.error('podium probe FAIL', e.message);
  try { await shot('podium-board-fail'); } catch {}
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  server.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(fail ? `\n领奖台结算板：${fail} 项失败` : '\n领奖台结算板：全部通过');
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
}
