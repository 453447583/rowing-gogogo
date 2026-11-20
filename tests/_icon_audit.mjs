// 图标盘点（一次性审计工具）
//   node tests/_icon_audit.mjs
//
// 目的：把"画面上真正显示的图标来自哪里"一次性问清楚，避免再靠猜。
// 做三件事：
//   ① 大厅：dump 所有可见 <img>、background-image、emoji 文本节点
//   ② 怪物模式：dump #boss-icon 的真实 DOM（png 还是回退 emoji）、玩家列表头像
//   ③ 进局后：dump HUD 上所有图标的来源
//
// 输出一行 JSON，人工读；不在这里做判定。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/icon-audit-' + Date.now());
const port = 9700 + Math.floor(Math.random() * 50);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
async function waitFor(expr, ms = 45000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; }
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('timeout ' + u); }

// 通用扫描：可见元素里的 img / background-image / emoji
const SCAN = `(() => {
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const out = { imgs: [], bgs: [], emojis: [] };
  for (const im of document.querySelectorAll('img')) {
    if (!vis(im)) continue;
    const r = im.getBoundingClientRect();
    out.imgs.push({ src: im.getAttribute('src')?.slice(0, 120), w: Math.round(r.width), h: Math.round(r.height),
      loaded: im.complete && im.naturalWidth > 0, parent: im.parentElement?.id || im.parentElement?.className?.toString().slice(0, 40) });
  }
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bg.includes('url(')) {
      out.bgs.push({ url: bg.slice(0, 140), el: el.id || el.className?.toString().slice(0, 40) });
    }
  }
  // emoji：文本里非 ASCII 且落在常见符号/象形区
  const re = /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue?.trim();
    if (!t || t.length > 24 || !re.test(t)) continue;
    const p = n.parentElement;
    if (!p || !vis(p)) continue;
    out.emojis.push({ text: t, el: p.id || p.className?.toString().slice(0, 40) || p.tagName });
  }
  return out;
})()`;

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url });
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 40000);
  await sleep(600);

  // ---------- ① 标题 / 大厅首页 ----------
  const title = await ev(SCAN);

  await ev(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await sleep(800);
  const lobby = await ev(SCAN);

  // 打开各个选择抽屉，抓里面的图标
  const drawers = {};
  for (const [name, open, close] of [
    ['boat', '#btn-lobby-boat', '#btn-lobby-pick-close'],
    ['map', '#btn-lobby-map', '#btn-lobby-pick-close'],
    ['mode', '#btn-lobby-mode', '#btn-lobby-pick-close'],
  ]) {
    await ev(`document.querySelector('${open}')?.click(); 1`);
    await sleep(700);
    drawers[name] = await ev(SCAN);
    await ev(`document.querySelector('${close}')?.click(); 1`);
    await sleep(300);
  }

  // ---------- ② 进怪物模式 ----------
  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await sleep(500);
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]')?.click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 15000);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  await ev(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value='2'; s.dispatchEvent(new Event('change')); } return 1; })()`);
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 50000);
  await sleep(1500);

  const bossHud = await ev(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    const icon = document.getElementById('boss-icon');
    const img = icon?.querySelector('img');
    const cs = document.getElementById('cs-name');
    const csImg = cs?.querySelector('img');
    return {
      mode: g.mode,
      bossIconHTML: icon ? icon.innerHTML.slice(0, 160) : null,
      bossImgSrc: img?.getAttribute('src') || null,
      bossImgLoaded: img ? (img.complete && img.naturalWidth > 0) : null,
      bossIconText: icon?.textContent || null,
      csNameHTML: cs ? cs.innerHTML.slice(0, 220) : null,
      csImgSrc: csImg?.getAttribute('src') || null,
      csImgLoaded: csImg ? (csImg.complete && csImg.naturalWidth > 0) : null,
      csText: cs?.textContent || null,
    };
  })()`);

  await sleep(1200);
  const fight = await ev(`(() => {
    const out = { playerList: [], rank: [] };
    const list = document.getElementById('player-list');
    if (list) {
      out.playerListHTML = list.innerHTML.slice(0, 700);
      out.avatars = [...list.querySelectorAll('.pl-avatar')].map((a) => ({
        hasImg: !!a.querySelector('img'),
        src: a.querySelector('img')?.getAttribute('src')?.slice(0, 60) || null,
        svgHead: a.querySelector('svg') ? a.querySelector('svg').outerHTML.slice(0, 90) : null,
        fill: a.querySelector('rect')?.getAttribute('fill') || null,
      }));
    }
    const rank = document.getElementById('hud-rank');
    if (rank) out.rankHTML = rank.innerHTML.slice(0, 400);
    return out;
  })()`);
  const fightScan = await ev(SCAN);

  const report = { title, lobby, drawers, bossHud, fight, fightScan };
  await fs.mkdir('.tmp_build', { recursive: true });
  await fs.writeFile('.tmp_build/icon-audit.json', JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
