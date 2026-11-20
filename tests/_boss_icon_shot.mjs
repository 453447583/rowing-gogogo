// BOSS 图标实机出图（2026-11-19 修复后核对）
//   node tests/_boss_icon_shot.mjs
// 出图 shots/hud/boss-icon.jpg（血条徽章区域）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boss-icon-' + Date.now());
const port = 9600 + Math.floor(Math.random() * 40);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = base.includes('?') ? `${base}&raceIntro=0` : `${base}?raceIntro=0`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1100,640', '--force-device-scale-factor=1', url], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 60000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value;
async function waitFor(expr, ms = 40000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; }
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('timeout'); }

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2500);

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await ev(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`);
  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`); await sleep(500);
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]')?.click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 15000);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`); await sleep(300);
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 50000);
  await sleep(2200);
  await ev(`(() => { const g = window.__game; g.phase='racing'; g.countdownLeft=0;
    const h = document.getElementById('hud'); h.style.transition='none'; h.style.opacity='1'; return 1; })()`);
  await sleep(900);
  // 图标是懒加载的，等它真的解码完再截，否则徽章是空的（踩过一次）
  await waitFor(`(() => { const i = document.getElementById('boss-icon')?.querySelector('img');
    return !!i && i.complete && i.naturalWidth > 0; })()`, 12000);
  // decode() + 两帧 rAF：PNG 解码完还要等合成器真的把它画上去，
  // 只 sleep 会偶发截到"徽章是空的"（踩过两次）
  await ev(`(async () => {
    const i = document.querySelector('#boss-icon img');
    if (i?.decode) { try { await i.decode(); } catch {} }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;
  })()`);
  await sleep(400);

  const rect = await ev(`(() => { const r = document.getElementById('boss-hud').getBoundingClientRect();
    return { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 8), w: Math.min(r.width + 20, 1100), h: r.height + 16 }; })()`);
  const shot = await cdp('Page.captureScreenshot', {
    format: 'jpeg', quality: 92,
    clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 2 },
  });
  await fs.mkdir('shots/hud', { recursive: true });
  await fs.writeFile('shots/hud/boss-icon.jpg', Buffer.from(shot.data, 'base64'));
  const dom = await ev(`(() => { const i = document.getElementById('boss-icon')?.querySelector('img');
    return { src: i?.getAttribute('src'), loaded: i ? (i.complete && i.naturalWidth > 0) : null }; })()`);

  // 第二张：过场大标题（手动触发一次，真实开局时它只出现 2~3 秒）
  await ev(`(() => { const g = window.__game;
    g.opts.onBossCutscene?.({ stage: 1, total: 4, level: {},
      boss: { id: 'dragon_deep', name: '深渊火龙', icon: '🐲', intro: '海面骤然灼热，巨影自浪涛中升起。' },
      weatherLabel: '🌋 熔岩火山' });
    return 1; })()`);
  await waitFor(`(() => { const i = document.querySelector('#cs-name img');
    return !!i && i.complete && i.naturalWidth > 0; })()`, 10000);
  await sleep(600);
  const r2 = await ev(`(() => { const r = document.getElementById('boss-cutscene').getBoundingClientRect();
    return { x: 0, y: Math.max(0, r.y), w: Math.min(560, r.width), h: r.height }; })()`);
  const shot2 = await cdp('Page.captureScreenshot', {
    format: 'jpeg', quality: 92,
    clip: { x: r2.x, y: r2.y, width: r2.w, height: r2.h, scale: 2 },
  });
  await fs.writeFile('shots/hud/boss-cutscene.jpg', Buffer.from(shot2.data, 'base64'));

  console.log(JSON.stringify({ ok: true, out: ['shots/hud/boss-icon.jpg', 'shots/hud/boss-cutscene.jpg'], rect, dom }));
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
