// 排行榜 UI 验收：真实联机入口 → 大厅按钮 → 面板三个页签截图 + 关键尺寸断言
//   npm run build && PORT=3441 WS_PORT=3442 LEADERBOARD_FILE=... node server/server.js
//   node tests/leaderboard_shot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/lb-shot-' + Date.now());
const port = 9760 + Math.floor(Math.random() * 30);
const base = process.env.LB_BASE || 'http://127.0.0.1:3441/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r?.result?.value;
};
async function waitFor(expr, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(200); }
  return false;
}
async function waitJson(u, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}
const shot = async (file) => {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 }, 60000);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  console.log('  → ' + file);
};

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: base });
  await waitFor(`typeof document.querySelector('#btn-entry-online')?.onclick === 'function'`, 30000);
  await sleep(400);

  // ---------- ① 真实线上入口进大厅 ----------
  console.log('① 联机大厅');
  await ev(`document.querySelector('#btn-entry-online').click(); 1`);
  const inLobby = await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  ok(inLobby, '线上入口能进大厅');
  const rankRowShown = await waitFor(`!document.querySelector('#btn-lobby-leaderboard')?.classList.contains('hidden')`, 8000);
  ok(rankRowShown, '联机大厅显示排行榜按钮行');

  const size = await ev(`(() => {
    const a = document.querySelector('#btn-lobby-settings').getBoundingClientRect();
    const b = document.querySelector('#btn-lobby-leaderboard').getBoundingClientRect();
    const row = document.querySelector('#lobby').getBoundingClientRect();
    return { aw: Math.round(a.width), bw: Math.round(b.width), bh: Math.round(b.height),
      same: Math.abs(a.width - b.width) < 1.5, bottom: Math.round(row.bottom),
      btnBottom: Math.round(b.bottom), vh: innerHeight };
  })()`);
  ok(size?.same, '排行榜按钮宽度与「游戏设置」一致', size);
  ok(size && size.btnBottom <= size.vh, '按钮没有被 720p 视口切掉', size);
  await shot('shots/verify/lb-0-lobby.jpg');

  // ---------- ② 打开面板：空榜 ----------
  console.log('② 空榜');
  await ev(`document.querySelector('#btn-lobby-leaderboard').click(); 1`);
  const opened = await waitFor(`!document.querySelector('#leaderboard')?.classList.contains('hidden')`, 8000);
  ok(opened, '点击后排行榜居中弹出');
  await sleep(900);
  const emptyText = await ev(`document.querySelector('#leaderboard [data-lb="pane"]').textContent.trim()`);
  ok(/还没有任何成绩/.test(emptyText || ''), '空榜给出明确提示', emptyText?.slice(0, 40));
  await shot('shots/verify/lb-1-empty.jpg');

  // ---------- ③ 塞一份样例数据核对排版 ----------
  console.log('③ 三个页签');
  await ev(`(() => {
    const at = Date.now();
    const ME = localStorage.getItem('rr-name') || '玩家';
    const e = (n, t, bl, b) => ({ n, t, bl, b: b || 'falcon', a: '', at });
    const boards = {
      'r:strait:3': [
        e('东海一哥', 187.4, 61.2, 'falcon'),
        e('浪里白条', 189.8, 62.4, 'titan'),
        e('海风', 193.2, 63.9, 'dolphin'),
        e(ME, 196.5, 64.8, 'vintage'),
        e('阿龙', 201.1, 66.2, 'longship'),
        e('夜航', 205.7, 67.5, 'cow'),
        e('摸鱼选手', 212.3, 69.9, 'rower'),
        e('新手', 240.8, 78.1, 'skiff'),
      ],
      'bt:2': [
        e('双人通关组', 268.4, 0, 'titan'),
        e('东海一哥', 281.2, 0, 'falcon'),
        e('浪里白条', 305.6, 0, 'dolphin'),
      ],
      'bs:2:1': [e('东海一哥', 52.3, 0, 'falcon'), e('双人通关组', 58.9, 0, 'titan')],
      'bs:2:2': [e('双人通关组', 61.0, 0, 'titan'), e('东海一哥', 66.4, 0, 'falcon')],
      'hx:2': [
        { n: '海克斯之王', c: 4, t: 312.5, b: 'falcon', a: '', at },
        { n: '东海一哥', c: 3, t: 240.2, b: 'titan', a: '', at },
        { n: '浪里白条', c: 3, t: 261.8, b: 'dolphin', a: '', at },
        { n: '阿龙', c: 2, t: 180.4, b: 'longship', a: '', at },
      ],
    };
    const p = window.__leaderboard;
    p.data = { v: 1, boards, mine: { 'r:strait:3': boards['r:strait:3'][3] }, at };
    p.loading = false;
    p.tab = 'race'; p.mapId = 'strait'; p.laps = 3;
    document.querySelector('#leaderboard [data-lb-tab="race"]').click();
    return 1;
  })()`);
  await sleep(250);
  const raceRows = await ev(`document.querySelectorAll('#leaderboard .lb-row').length`);
  ok(raceRows === 8, '竞速页渲染 8 条成绩', raceRows);
  const mineShown = await ev(`!!document.querySelector('#leaderboard .lb-row.me') && /我的最好成绩/.test(document.querySelector('#leaderboard .lb-mine').textContent)`);
  ok(mineShown, '自己那一行高亮 + 底部「我的最好成绩」');
  await shot('shots/verify/lb-2-race.jpg');

  await ev(`(() => { const p = window.__leaderboard; p.humans = 2; document.querySelector('#leaderboard [data-lb-tab="boss"]').click(); return 1; })()`);
  await sleep(250);
  const bossTxt = await ev(`document.querySelector('#leaderboard [data-lb="pane"]').textContent`);
  ok(/四关全通/.test(bossTxt) && /单关最快/.test(bossTxt), '怪物页有「通关总时长」和「单关最快」两块');
  await shot('shots/verify/lb-3-boss.jpg');

  await ev(`(() => { const p = window.__leaderboard; p.humans = 2; document.querySelector('#leaderboard [data-lb-tab="hex"]').click(); return 1; })()`);
  await sleep(250);
  const hexTxt = await ev(`document.querySelector('#leaderboard [data-lb="pane"]').textContent`);
  ok(/通过关卡数优先/.test(hexTxt) && hexTxt.includes('4 / 4'), '海克斯页显示通过关卡数', hexTxt?.slice(0, 60));
  await shot('shots/verify/lb-4-hex.jpg');

  const fit = await ev(`(() => {
    const c = document.querySelector('#leaderboard .lb-card').getBoundingClientRect();
    return { w: Math.round(c.width), h: Math.round(c.height), vw: innerWidth, vh: innerHeight };
  })()`);
  ok(fit && fit.w <= fit.vw && fit.h <= fit.vh, '面板没有超viewport', fit);

  // ---------- ④ 练习模式隐藏入口 ----------
  console.log('④ 练习模式');
  await ev(`document.querySelector('#leaderboard [data-lb="close"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-back').click(); 1`);
  await waitFor(`!document.querySelector('#menu-entry')?.classList.contains('hidden')`, 10000);
  await ev(`document.querySelector('#btn-entry-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 20000);
  await sleep(600);
  const soloHidden = await ev(`document.querySelector('#btn-lobby-leaderboard')?.classList.contains('hidden')`);
  ok(soloHidden === true, '练习模式大厅隐藏排行榜入口');
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { child.kill(); } catch { /* 忽略 */ }
}

if (failures) { console.error(`\n${failures} 项未通过`); process.exit(1); }
console.log('\nleaderboard UI PASS');
