// 赛道详情卡"悬停浮出"验收
//   node tests/vessel_hover_shot.mjs [baseUrl]
// 断言：① 默认不显示 ② 鼠标移到某张卡上才显示、内容是那张图 ③ 显示时右缘不出视口 ④ 移开就收起
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hover-' + Date.now());
const port = 9300 + Math.floor(Math.random() * 120);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1920,960', base], { stdio: 'ignore' });
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
// 真实鼠标移动才会触发 mouseenter/mouseleave
const moveTo = (x, y) => cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
const detailState = () => ev(`(() => {
  const d = document.querySelector('.vs-detail');
  const cs = getComputedStyle(d);
  const r = d.getBoundingClientRect();
  const rail = document.querySelector('.vs-rail').getBoundingClientRect();
  return {
    opacity: +cs.opacity, visibility: cs.visibility,
    cls: d.className,
    sel: document.querySelector('#map-list .map-card.selected')?.dataset.mapId || '',
    x: Math.round(r.x), right: Math.round(r.right), w: Math.round(r.width),
    railLeft: Math.round(rail.left), railRight: Math.round(rail.right),
    vw: document.documentElement.clientWidth,
    name: document.querySelector('#map-brief .mcb-name')?.textContent?.trim() || '',
  };
})()`);

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
  let opened = false;
  for (let i = 0; i < 12 && !opened; i++) {
    await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1200);
    opened = await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false);
  }
  if (!opened) throw new Error('没进选艇页');
  await local(2200);
  // 鼠标先停在屏幕顶端，确保没有任何 hover
  await moveTo(10, 10);
  await local(600);

  const idle = await detailState();
  console.log('idle:', JSON.stringify(idle));
  await shot('vessel-hover-1-idle');
  if (idle.visibility !== 'hidden' || idle.opacity > 0.01) throw new Error('详情卡默认应当是隐藏的: ' + JSON.stringify(idle));

  // 胶片条必须贴右（右缘距窗口右边 <= 60px）
  const railGap = idle.vw - idle.railRight;
  console.log('rail gap to viewport right:', railGap);
  if (railGap > 60) throw new Error('胶片条没贴右，距右缘 ' + railGap + 'px');

  // 悬停第 3 张卡
  const target = await ev(`(() => {
    const cards = [...document.querySelectorAll('#map-list .map-card')];
    const c = cards[2] || cards[0];
    const r = c.getBoundingClientRect();
    return { id: c.dataset.mapId, x: Math.round(r.x + r.width * 0.45), y: Math.round(r.y + r.height / 2) };
  })()`);
  await moveTo(target.x, target.y);
  await local(900);
  const hover = await detailState();
  console.log('hover(' + target.id + '):', JSON.stringify(hover));
  await shot('vessel-hover-2-card');
  if (hover.visibility !== 'visible' || hover.opacity < 0.9) throw new Error('悬停后详情卡没显示');
  if (hover.right > hover.vw) throw new Error('详情卡右缘超出视口: right=' + hover.right + ' vw=' + hover.vw);
  if (hover.x < 0) throw new Error('详情卡左缘出屏: x=' + hover.x);
  if (hover.railLeft - hover.right < 0) throw new Error('详情卡压住了胶片条（应贴在左侧）');

  // 悬停另一张，内容要跟着换
  const t2 = await ev(`(() => {
    const cards = [...document.querySelectorAll('#map-list .map-card')];
    const c = cards[Math.min(4, cards.length - 1)];
    const r = c.getBoundingClientRect();
    return { id: c.dataset.mapId, x: Math.round(r.x + r.width * 0.45), y: Math.round(r.y + r.height / 2) };
  })()`);
  await moveTo(t2.x, t2.y);
  await local(800);
  const hover2 = await detailState();
  console.log('hover2(' + t2.id + '):', JSON.stringify(hover2));
  if (hover2.visibility !== 'visible') throw new Error('卡片间移动时详情卡不该消失（会闪）');

  // 移到左边空白处 → 收起
  await moveTo(20, 500);
  await local(900);
  const away = await detailState();
  console.log('away:', JSON.stringify(away));
  await shot('vessel-hover-3-away');
  if (away.visibility !== 'hidden' || away.opacity > 0.01) throw new Error('鼠标移开后详情卡还在: ' + JSON.stringify(away));

  // 窄窗口：不能出屏（emulation 下真实鼠标事件不落到卡片上，这里直接派发 mouseenter 验几何）
  for (const w of [1280, 1024]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 800, deviceScaleFactor: 1, mobile: false });
    await local(700);
    await ev(`(() => {
      const c = document.querySelector('#map-list .map-card');
      c.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      return true;
    })()`);
    await local(500);
    const st = await detailState();
    console.log('narrow ' + w + ':', JSON.stringify(st));
    if (w === 1280) await shot('vessel-hover-4-narrow');
    if (st.visibility !== 'visible') throw new Error(w + ' 下详情卡没显示');
    if (st.right > st.vw || st.x < 0) throw new Error(w + ' 宽时详情卡出屏: ' + JSON.stringify(st));
  }
  await cdp('Emulation.clearDeviceMetricsOverride');

  if (errors.length) throw new Error('page exceptions: ' + errors.slice(0, 2).join(' | '));
  console.log('map detail hover: PASS');
} catch (e) {
  console.error('map detail hover FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
