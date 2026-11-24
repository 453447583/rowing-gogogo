// 设置面板验收：无头里真的点开面板、改每一项、确认生效 + 存档 + 冻结输入。
//
//   node tests/settings_probe.mjs
//
// 为什么不能只靠肉眼：
//   ① "冻结输入"是最容易漏的一环 —— 面板开着时船还在动，改完设置回来已经撞墙；
//   ② 改键用的是捕获阶段抢事件，如果抢不到，按 W 会一边改键一边开船；
//   ③ 存档结构是版本化的，读档写错一个键名就变成"这次改了下次又没了"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/settings-probe');
const port = 9747;
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const shotDir = path.resolve('shots/verify');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 60000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout ${method}`)); }, timeout);
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
const val = async (expr) => (await evaluate(expr)).result?.value;

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok: !!ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 78 }, 45000);
  await fs.mkdir(shotDir, { recursive: true });
  const p = path.join(shotDir, `${name}.jpg`);
  await fs.writeFile(p, Buffer.from(r.data, 'base64'));
  return p;
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
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 40000) {
    if (await val('!!window.__audio && !!document.querySelector("#btn-solo")')) { ready = true; break; }
    await sleep(250);
  }
  check('页面启动', ready);
  if (!ready) throw new Error('主菜单没起来');

  // 干净起步：先清掉可能残留的存档，保证断言的是默认值
  await evaluate('localStorage.removeItem("rr-settings-v1"); localStorage.removeItem("rapids-quality"); 1');
  await cdp('Page.reload');
  await sleep(1500);
  const t1 = Date.now();
  while (Date.now() - t1 < 40000) {
    if (await val('!!window.__audio && !!document.querySelector("#btn-solo")')) break;
    await sleep(250);
  }

  // ---- 1. 菜单里按 Esc 也能开面板（不只是在比赛里）----
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  check('菜单里 Esc 打开设置', await val('!document.getElementById("settings-panel").classList.contains("hidden")'));

  // ---- 2. 六个标签页齐全（辅助 / 素材来源是后来补的）----
  const tabs = await val('[...document.querySelectorAll(".sp-tab")].map(b => b.textContent)');
  check('标签页', JSON.stringify(tabs) === JSON.stringify(['画面', '音频', '界面', '辅助', '键位', '素材来源']), JSON.stringify(tabs));

  // ---- 3. 画面：切低画质立刻写进设置（比赛里由 Game 落实）----
  const seg = await val(`(() => {
    const rows = [...document.querySelectorAll('.sp-row')];
    const row = rows.find(r => r.querySelector('b')?.textContent === '画质');
    if (!row) return 'no-row';
    row.querySelector('[data-val="low"]').click();
    return 'ok';
  })()`);
  check('画质行存在', seg === 'ok');
  await sleep(300);
  const q = await val('JSON.parse(localStorage.getItem("rr-settings-v1")||"{}").quality');
  check('画质写入存档', q === 'low', `quality=${q}`);

  // ---- 4. 音频：滑条改音量要落到总线 ----
  await val(`(() => { [...document.querySelectorAll('.sp-tab')].find(b=>b.textContent==='音频').click(); return 1; })()`);
  await sleep(250);
  const volSet = await val(`(() => {
    const rows = [...document.querySelectorAll('.sp-row')];
    const row = rows.find(r => r.querySelector('b')?.textContent === '背景音乐');
    if (!row) return 'no-row';
    const r = row.querySelector('input[type=range]');
    r.value = '0.15';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return { v: window.__audio.vol.music, shown: row.querySelector('.sp-val').textContent };
  })()`);
  check('音乐音量落到总线', volSet?.v === 0.15, JSON.stringify(volSet));

  // ---- 5. 界面：HUD 缩放要写到 #hud 的 --hs ----
  await val(`(() => { [...document.querySelectorAll('.sp-tab')].find(b=>b.textContent==='界面').click(); return 1; })()`);
  await sleep(250);
  const hudSet = await val(`(() => {
    const rows = [...document.querySelectorAll('.sp-row')];
    const row = rows.find(r => r.querySelector('b')?.textContent === 'HUD 尺寸');
    if (!row) return 'no-row';
    const r = row.querySelector('input[type=range]');
    r.value = '1.3';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return document.getElementById('hud').style.getPropertyValue('--hs');
  })()`);
  check('HUD 缩放生效', hudSet === '1.3', `--hs=${hudSet}`);

  // ---- 6. 键位：7 个动作 + 改键冲突检测 ----
  await val(`(() => { [...document.querySelectorAll('.sp-tab')].find(b=>b.textContent==='键位').click(); return 1; })()`);
  await sleep(250);
  const keyCount = await val('document.querySelectorAll(".sp-key").length');
  check('键位 7 行', keyCount === 7, `rows=${keyCount}`);

  // 点第一行（油门）→ 按 I
  await evaluate(`document.querySelector('.sp-key').click(); 1`);
  await sleep(200);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  await sleep(300);
  const rebound = await val(`(() => {
    const k = JSON.parse(localStorage.getItem('rr-settings-v1')||'{}').keys || {};
    return { throttle: k.throttle, label: document.querySelector('.sp-key')?.textContent };
  })()`);
  check('改键写入存档', rebound?.throttle === 'KeyI', JSON.stringify(rebound));

  // 冲突：点第二行（刹车）→ 按 I，应当被拒
  await evaluate(`document.querySelectorAll('.sp-key')[1].click(); 1`);
  await sleep(200);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i', code: 'KeyI', windowsVirtualKeyCode: 73 });
  await sleep(300);
  const conflict = await val(`(() => {
    const k = JSON.parse(localStorage.getItem("rr-settings-v1")||"{}").keys || {};
    return { brake: k.brake, throttle: k.throttle };
  })()`);
  check('冲突键被拒绝', conflict?.brake === 'KeyS' && conflict?.throttle === 'KeyI', JSON.stringify(conflict));

  // 关掉面板再进比赛。注意不能按 Esc —— 上一段还在"等待按键"状态，
  // Esc 只会取消改键（这是面板的既有行为），不会关面板。
  await evaluate(`(() => { document.querySelector('[data-sp="ok"]')?.click(); return 1; })()`);
  await sleep(300);
  check('面板已关闭（进比赛前）',
    await val('document.getElementById("settings-panel").classList.contains("hidden")'));

  // ---- 7. 进一局，验证比赛内打开时冻结输入 + 面板截图 ----
  await val(`(() => { document.querySelector('#btn-solo')?.click(); return 1; })()`);
  const t2 = Date.now();
  while (Date.now() - t2 < 20000) {
    if ((await val('document.querySelectorAll(".map-card").length')) > 0) break;
    await sleep(250);
  }
  await evaluate(`(() => { document.querySelector('.map-card')?.click(); return 1; })()`);
  await sleep(300);
  await evaluate(`(() => { document.querySelector('#btn-map-ok')?.click(); return 1; })()`);
  // 固定 sleep 会偶发抢跑：无头软件光栅下开一局要好几秒，等"HUD 出来 + __game 就位"再往下。
  // 注意 __game 是在 Game 构造函数里挂的，比 main.js 的 game = new Game() 早一瞬，
  // 所以还要等 HUD 可见（showScreen 在构造之前就已经切屏了，两者叠加才稳）。
  const tRace = Date.now();
  let raced = false;
  while (Date.now() - tRace < 40000) {
    const ok = await val(`!!window.__game && !!window.__game.phase && !document.getElementById('hud').classList.contains('hidden')`);
    if (ok) { raced = true; break; }
    await sleep(400);
  }
  await sleep(1200);
  check('已进入比赛', raced, '');

  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  const inRace = await val(`(() => ({
    open: !document.getElementById('settings-panel').classList.contains('hidden'),
    frozen: !!window.__game?.opts?.input?.frozen,
    throttle: window.__game?.opts?.input?.throttle,
    exitShown: !document.querySelector('[data-sp="exit"]').classList.contains('hidden'),
  }))()`);
  check('比赛内 Esc 打开设置', inRace?.open === true, JSON.stringify(inRace));
  check('打开时冻结驾驶输入', inRace?.frozen === true && inRace?.throttle === 0, JSON.stringify(inRace));
  check('面板里有「退出比赛」', inRace?.exitShown === true, JSON.stringify(inRace));

  const p1 = await shot('settings-panel-video');
  console.log('  截图', p1);

  // ---- 8. 比赛内改画质要真的落到 Game ----
  // 面板会记住上一次停留的标签页（键位），先切回画面
  await val(`(() => { [...document.querySelectorAll('.sp-tab')].find(b=>b.textContent==='画面').click(); return 1; })()`);
  await sleep(250);
  await val(`(() => {
    const rows = [...document.querySelectorAll('.sp-row')];
    const row = rows.find(r => r.querySelector('b')?.textContent === '画质');
    row?.querySelector('[data-val="high"]')?.click();
    return 1;
  })()`);
  await sleep(600);
  const applied = await val(`(() => ({
    quality: window.__game.quality,
    locked: window.__game.qualityLockedByUser,
  }))()`);
  check('比赛内改画质立刻生效', applied?.quality === 'high', JSON.stringify(applied));

  const p2 = await shot('settings-panel-race');
  console.log('  截图', p2);

  // ---- 9. Esc 关闭 → 解冻 ----
  await val(`(() => { window.__esc = 0; window.addEventListener('keydown', e => { if (e.key === 'Escape') window.__esc++; }); return 1; })()`);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(120);
  console.log('  esc120', JSON.stringify(await val(`(() => ({ esc: window.__esc, open: !document.getElementById('settings-panel').classList.contains('hidden'), frozen: !!window.__game?.opts?.input?.frozen }))()`)));
  await sleep(400);
  const closed = await val(`(() => ({
    open: !document.getElementById('settings-panel').classList.contains('hidden'),
    frozen: !!window.__game?.opts?.input?.frozen,
    esc: window.__esc,
  }))()`);
  check('Esc 关闭并解冻', closed?.open === false && closed?.frozen === false, JSON.stringify(closed));

  // ---- 10. HUD 缩放的视觉证据：1.35 倍与 0.85 倍各拍一张（面板关着，看整体排版）----
  // 只缩放不重排的话，放大后速度表会顶出画面右下角、名次板会压到小地图上，
  // 所以这两张图是"能不能用"的唯一依据。必须走面板改（直接写 localStorage
  // 不会触发 settings 的监听，等于没改）。
  for (const [scale, tag] of [['1.35', 'hud-135'], ['0.85', 'hud-085']]) {
    await evaluate(`(() => { document.querySelector('#quality-btn')?.click(); return 1; })()`);
    await sleep(300);
    await val(`(() => { [...document.querySelectorAll('.sp-tab')].find(b=>b.textContent==='界面').click(); return 1; })()`);
    await sleep(200);
    await val(`(() => {
      const rows = [...document.querySelectorAll('.sp-row')];
      const row = rows.find(r => r.querySelector('b')?.textContent === 'HUD 尺寸');
      const r = row.querySelector('input[type=range]');
      r.value = '${scale}';
      r.dispatchEvent(new Event('input', { bubbles: true }));
      r.dispatchEvent(new Event('change', { bubbles: true }));
      return 1;
    })()`);
    await sleep(200);
    await evaluate(`(() => { document.querySelector('[data-sp="ok"]')?.click(); return 1; })()`);
    await sleep(700);
    const p = await shot(tag);
    console.log('  截图', p);
  }

  const fail = results.filter((x) => !x.ok);
  console.log(`\n${results.length - fail.length}/${results.length} 通过`);
  ws.close(); child.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(fail.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FAIL', e.message);
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
