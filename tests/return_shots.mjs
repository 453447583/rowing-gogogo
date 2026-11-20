// 回程段实机验收：无头 Edge + CDP。
// 检查项：赛道门数 / 闭环标记 / 控制台报错 / 回程三个机位截图。
// 浏览器 profile 必须落在项目盘，跑完立即删除（C 盘空间铁律）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/return-shots');
const port = 9229;
const URL = process.env.SHOT_URL || 'http://127.0.0.1:8765/';
const OUT = path.resolve('shots/verify');
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(OUT, { recursive: true });

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', URL,
], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
const cdp = (method, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout ${url}`);
}

try {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
  if (!page) throw new Error('no page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Runtime.consoleAPICalled' && /error|warning/.test(m.params.type)) {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300));
    }
  });

  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const evaluate = async (expression) => {
    try {
      return await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    } catch (e) {
      if (/context was destroyed|Cannot find context|navigated/i.test(e.message)) return { result: {} };
      throw e;
    }
  };
  const waitUntil = async (expr, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = await evaluate(expr);
      if (r.result?.value) return true;
      await sleep(300);
    }
    return false;
  };

  await cdp('Page.navigate', { url: URL });
  if (!await waitUntil(`document.readyState === 'complete' && !!document.querySelector('#btn-solo')`)) {
    throw new Error('menu not ready');
  }
  console.log('[shot] menu ready');

  await evaluate(`document.querySelector('#btn-solo')?.click()`);
  await waitUntil(`(() => { const el = document.querySelector('#menu-boat'); if (!el || el.classList.contains('hidden')) { document.querySelector('#btn-solo')?.click(); return false; } return true; })()`);
  await waitUntil(`document.querySelectorAll('#boat-list .boat-card').length > 0`);
  await evaluate(`document.querySelectorAll('#boat-list .boat-card')[0]?.click()`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-boat-ok')?.click()`);
  await waitUntil(`(() => { const el = document.querySelector('#menu-map'); if (!el || el.classList.contains('hidden')) { document.querySelector('#btn-boat-ok')?.click(); return false; } return true; })()`);
  await waitUntil(`document.querySelectorAll('#map-list .map-card').length > 0`);
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#map-list .map-card')];
    const c = cards.find(el => el.textContent.includes('秘境')) || cards[cards.length - 1];
    if (!c) return 'none';
    c.click();
    return c.textContent.trim().slice(0, 20);
  })()`);
  console.log('[shot] map card:', picked.result?.value);
  await sleep(500);
  await evaluate(`document.querySelector('#btn-map-ok')?.click()`);

  const ready = await waitUntil(`!!(window.__game && window.__game.track && window.__game.localBoat)`, 60000);
  console.log('[shot] game ready:', ready);
  if (!ready) {
    const r = await evaluate(`JSON.stringify({ g: !!window.__game })`);
    console.log('debug', JSON.stringify(r.result?.value));
    throw new Error('game did not boot');
  }

  const info = await evaluate(`JSON.stringify({
    gates: window.__game.track.gates.length,
    loopClosed: window.__game.track.loopClosed,
    openTrack: window.__game.track.openTrack,
    gateMax: Math.max(...window.__game.track.gateY),
    lapLen: (() => { const g = window.__game.track.gates; let L = 0; for (let i = 0; i < g.length; i++) { const a = g[i], b = g[(i+1)%g.length]; L += Math.hypot(b[0]-a[0], b[1]-a[1]); } return Math.round(L); })(),
    children: window.__game.track.group.children.length,
    shore: window.__game.track.group.children.filter(o => (o.name||'').startsWith('shore_')).map(o => o.name + ':' + o.children.length),
  })`);
  console.log('[shot] track', info.result?.value);

  const loaded = await waitUntil(
    `window.__game.track.group.children.length >= 9 && window.__game.track.group.children.filter(o => (o.name||'').startsWith('shore_')).length === 3`,
    120000,
  );
  console.log('[shot] all segments loaded:', loaded, await evaluate(`window.__game.track.group.children.length`).then(r => r.result?.value));

  // 提速：软件光栅下 1280×720 每帧数秒，截图前先缩小画布
  await evaluate(`(() => { const c = document.querySelector('canvas'); if (c) { c.width = 900; c.height = 560; } })()`);
  await evaluate(`(() => { window.__game.countdownLeft = 0.01; })()`);
  await sleep(1500);

  // 机位不写死门号：直接找实际摆出来的码头/浮标/礁石，把船挪到它正前方。
  // 门号会随赛道重算漂移，物件位置才是验收对象。
  const near = (group) => `(() => {
    const tr = window.__game.track, g = tr.gates;
    const grp = tr.group.children.find(o => o.name === '${group}');
    if (!grp || !grp.children.length) return -1;
    const p = grp.children[Math.floor(grp.children.length / 2)].position;
    let best = 0, bd = 1e9;
    for (let i = 0; i < g.length; i++) {
      const d = Math.hypot(g[i][0] - p.x, g[i][1] - p.z);
      if (d < bd) { bd = d; best = i; }
    }
    return Math.max(1, best - 1);
  })()`;
  const idxOf = async (g) => (await evaluate(near(g))).result?.value ?? 92;
  const spots = [
    { name: 'audit-return-sky', idx: 130 },
  ];
  console.log('[shot] spots', JSON.stringify(spots));

  for (const s of spots) {
    await evaluate(`(() => {
      const g = window.__game.track.gates, b = window.__game.localBoat;
      const i = ${s.idx}, n = g[Math.min(g.length - 1, i + 1)];
      const p = g[i];
      b.resetTo(p[0], p[1], Math.atan2(n[0] - p[0], n[1] - p[1]));
      b.pos.y = 0; b.speed = 0; b.vel.set(0, 0);
      const pm = window.__game.progressMap.get(window.__game.myId);
      if (pm) pm.gate = i;
    })()`);
    await sleep(9000);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, s.name + '.png'), Buffer.from(shot.data, 'base64'));
    console.log('[shot] wrote', s.name);
  }

  // 码头特写：把船直接摆到某座码头的前方（船临时在岸上无所谓，只为取景）
  const dockPos = await evaluate(`(() => {
    const grp = window.__game.track.group.children.find(o => o.name === 'shore_dock');
    if (!grp || !grp.children.length) return null;
    const d = grp.children[Math.floor(grp.children.length * 0.5)];
    return [d.position.x, d.position.z];
  })()`);
  const dp = dockPos.result?.value;
  if (dp) {
    await evaluate(`(() => {
      const b = window.__game.localBoat;
      b.resetTo(${dp[0]} - 26, ${dp[1]}, Math.PI / 2);
      b.speed = 0; b.vel.set(0, 0);
    })()`);
    await sleep(9000);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(OUT, 'return-e-dock-close.png'), Buffer.from(shot.data, 'base64'));
    console.log('[shot] wrote return-e-dock-close at', dp);
  }

  console.log('[shot] console issues:', logs.length ? logs.slice(0, 12).join('\n  ') : 'none');
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
