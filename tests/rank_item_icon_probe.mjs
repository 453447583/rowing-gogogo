// 名次栏「持有道具图标」验收探针
//   node tests/rank_item_icon_probe.mjs
// 验四件事：① 自己那行显示道具（最多 3 枚）② 用掉后图标消失
//          ③ 组队模式同队显示 ④ 对手不显示（不能开透视）
// 截图只调一次 Page.captureScreenshot（swiftshader 下第二次会挂死）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/rankicons-${stamp}`);
const port = 9720 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const out = path.resolve(process.env.OUT || 'shots/verify/rank-item-icons.jpg');

const child = spawn(edge, [
  '--headless=new', '--use-angle=d3d11', '--no-sandbox',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1440x900', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});
async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label, JSON.stringify(detail)); }
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log('  EXC', d.exception?.description?.slice(0, 260) || d.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1800);

  // 等主菜单 → 单人 → 道具模式
  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
  await sleep(600);
  await evaluate(`(() => { const c = document.querySelector('[data-mode="item"]'); if (c) c.click(); return 1; })()`);
  await sleep(500);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!(window.__game && window.__game.items && window.__game.localBoat)')).result?.value) {
      ready = true; break;
    }
    await sleep(200);
  }
  if (!ready) throw new Error('没进到道具赛');
  await evaluate(`(() => {
    const g = window.__game;
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    document.body.classList.remove('intro-on');
    document.querySelector('#hud')?.classList.remove('hidden');
    return 1;
  })()`);

  // 读名次栏：每行名字 + 图标（有图记 src，没图记 emoji）
  const readRows = `(() => [...document.querySelectorAll('#hud-rank .rank-row')].map((row) => ({
    name: row.querySelector('.rank-name')?.textContent || '',
    me: row.classList.contains('me'),
    icons: [...row.querySelectorAll('.rank-item')].map((el) => ({
      src: el.querySelector('img')?.getAttribute('src') || null,
      text: el.querySelector('img') ? null : el.textContent,
      title: el.getAttribute('title') || '',
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    })),
  })))()`;

  // ① 自己塞满 3 件
  await evaluate(`(() => { window.__game.items.myItems = ['nitro', 'bomb', 'octopus']; return 1; })()`);
  await sleep(1200);
  let rows = (await evaluate(readRows)).result?.value || [];
  let me = rows.find((r) => r.me) || null;
  ok(!!me && me.icons.length === 3, '自己那行显示 3 枚道具图标', me);
  ok(me?.icons.every((x) => !!x.src), '图标走的是图片贴图（不是 emoji 兜底）', me?.icons);
  ok(me?.icons.every((x) => x.w >= 22 && x.h >= 22 && x.w <= 28 && x.h <= 28),
    '图标尺寸匹配名次栏（22~28px）', me?.icons);

  // ② 用掉一件 → 图标跟着少一枚
  await evaluate(`(() => {
    const g = window.__game;
    g.items.myItems[0] = null;
    g.items.syncHeld(g.myId);
    return 1;
  })()`);
  await sleep(1000);
  rows = (await evaluate(readRows)).result?.value || [];
  me = rows.find((r) => r.me) || null;
  ok(me?.icons.length === 2, '用掉一件后图标减为 2 枚', me);

  // ③/④ 造一个同队 + 一个对手，走真实的网络入口注入持有列表
  const injected = await evaluate(`(() => {
    const g = window.__game;
    g.format = 'team';
    const meEntry = g.entryById.get(g.myId) || g.order?.find((x) => x.id === g.myId);
    if (meEntry) meEntry.team = 'blue';
    for (const [id, name, team] of [['p2', '蓝队队友', 'blue'], ['p3', '红队对手', 'red']]) {
      if (!g.progressMap.has(id)) g.progressMap.set(id, { lap: 1, prog: 1000, gate: 2 });
      const e = { id, name, team, ai: false };
      g.entryById.set(id, e);
      if (g.order && !g.order.some((x) => x.id === id)) g.order.push(e);
      g.items.handleNet({ t: 'itemHeld', by: id, items: team === 'blue' ? ['shield', 'missile'] : ['bomb'] });
    }
    return { teams: [...g.entryById.values()].map((e) => e.id + ':' + (e.team || '-')) };
  })()`);
  console.log('  注入:', JSON.stringify(injected.result?.value));
  await sleep(1200);
  rows = (await evaluate(readRows)).result?.value || [];
  const mate = rows.find((r) => r.name.includes('蓝队队友')) || null;
  const foe = rows.find((r) => r.name.includes('红队对手')) || null;
  ok(!!mate && mate.icons.length === 2, '同队队友显示 2 枚图标', mate);
  ok(!!foe && foe.icons.length === 0, '对手那行没有任何图标（不透视）', foe);

  // 队友用掉一件 → 也跟着减
  await evaluate(`(() => {
    window.__game.items.handleNet({ t: 'itemHeld', by: 'p2', items: ['missile'] });
    return 1;
  })()`);
  await sleep(1000);
  rows = (await evaluate(readRows)).result?.value || [];
  const mate2 = rows.find((r) => r.name.includes('蓝队队友')) || null;
  ok(mate2?.icons.length === 1, '队友用掉后图标减为 1 枚', mate2);

  // 截图：把 HUD 亮出来，名次板别被隐藏
  await evaluate(`(() => {
    const g = window.__game;
    const panel = document.querySelector('#hud-rank');
    panel?.classList.remove('hidden');
    document.body.classList.remove('intro-on');
    return 1;
  })()`);
  await sleep(600);
  await fs.mkdir(path.dirname(out), { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88, captureBeyondViewport: false });
  await fs.writeFile(out, Buffer.from(shot.data, 'base64'));

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  console.log('截图:', out);
  if (fail) process.exitCode = 1;
}

try { await main(); } catch (e) {
  console.error('探针异常:', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 已断开 */ }
  child.kill('SIGKILL');
}
