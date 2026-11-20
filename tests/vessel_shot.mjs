// 选艇+选图合并屏 视觉验收
//   node tests/vessel_shot.mjs [baseUrl]
// 产出：shots/verify/vessel-*.png + 控制台报错检查
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/vessel-' + Date.now());
const port = 9300 + Math.floor(Math.random() * 120);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1600,900', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 90000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const local = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, label, tries = 80) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return;
    await local(400);
  }
  throw new Error('timeout: ' + label);
};
const shot = async (name) => {
  const res = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, name + '.png'), Buffer.from(res.data, 'base64'));
  console.log('shot ->', 'shots/verify/' + name + '.png');
};

try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await local(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description || 'exception');
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await local(2500);

  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  // #btn-solo 在 HTML 里就有，main.js 的事件可能还没绑上：点到真的切屏为止
  let opened = false;
  for (let i = 0; i < 12 && !opened; i++) {
    await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1200);
    opened = await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false);
  }
  if (!opened) throw new Error('点了 12 次也没进选艇页');
  await local(2500);
  await shot('vessel-1-default');

  // 选第二艘船看参数面板是否跟随
  await ev(`[...document.querySelectorAll('.boat-card')][2]?.click()`);
  await local(1200);
  await shot('vessel-2-falcon');

  // 选一张长赛道（霓虹海峡），看右侧高亮 + 详情卡
  await ev(`(() => {
    const c = [...document.querySelectorAll('#map-list .map-card')].find(x => x.dataset.mapId === 'strait');
    c?.scrollIntoView({ block: 'nearest' }); c?.click();
  })()`);
  await local(1200);
  await shot('vessel-3-strait');

  // 滚到列表底部，验证"上下可移动"
  const scrollInfo = await ev(`(() => {
    const l = document.querySelector('#map-list');
    l.scrollTop = l.scrollHeight;
    return { max: Math.round(l.scrollHeight - l.clientHeight), top: Math.round(l.scrollTop) };
  })()`);
  await local(900);
  const scrolledTop = await ev(`Math.round(document.querySelector('#map-list').scrollTop)`);
  console.log('scroll:', JSON.stringify(scrollInfo), 'after=', scrolledTop);
  await shot('vessel-4-scrolled');
  if (scrollInfo.max <= 0) throw new Error('赛道列表内容不足一屏，无法上下移动');
  if (scrolledTop <= 0) throw new Error('赛道列表不能滚动');

  // 点"确认出战"→ 必须真的开赛（HUD 出现、game 实例存在）
  await ev(`document.querySelector('#btn-map-ok').click()`);
  await local(4000);
  const started = await ev(`(() => ({
    game: !!(window.__game && window.__game.track),
    hudVisible: !document.querySelector('#hud')?.classList.contains('hidden'),
    map: window.__game?.mapDef?.id,
  }))()`);
  console.log('started:', JSON.stringify(started));
  if (!started.game || !started.hudVisible) throw new Error('确认出战没有真正开赛: ' + JSON.stringify(started));
  await shot('vessel-5-race-started');

  const info = await ev(`(() => ({
    boat: document.querySelector('#boat-title-name')?.textContent,
    role: document.querySelector('#boat-title-role')?.textContent,
    maps: document.querySelectorAll('#map-list .map-card').length,
    selected: document.querySelector('#map-list .map-card.selected')?.dataset.mapId,
    scrollTop: Math.round(document.querySelector('#map-list').scrollTop),
    scrollMax: Math.round(document.querySelector('#map-list').scrollHeight - document.querySelector('#map-list').clientHeight),
    goText: document.querySelector('#btn-map-ok')?.textContent,
  }))()`);
  console.log('state:', JSON.stringify(info));
  if (!info.maps) throw new Error('赛道列表为空');
  if (errors.length) throw new Error('page exceptions: ' + errors.slice(0, 2).join(' | '));
  console.log('vessel screen: PASS');
} catch (e) {
  console.error('vessel screen FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
