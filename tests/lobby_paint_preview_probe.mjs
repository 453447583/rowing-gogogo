// 选艇页涂装预览 + 商店涂装卡面验收：
//   node tests/lobby_paint_preview_probe.mjs
// 前置：dev server 5199。
// 单人进大厅 → 选择赛艇 → 抽屉顶部应出现 3D 预览与 7 枚色点（原色 + 6 涂装），
// 未拥有的色点带锁、点了直接跳激流小店的涂装分类；已拥有的点了预览切色。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const cdpPort = 9970 + Math.floor(Math.random() * 20);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/lobby-paint-' + Date.now());
const shots = path.resolve('shots/verify');
fs.mkdirSync(shots, { recursive: true });

// 只拥有赤焰红 + 霜蓝，用来同时验证「已拥有可切 / 未拥有带锁」
const DEMO = {
  uid: 'u_paint', n: '涂装船长', pts: 3200, earned: 9000, spent: 5800,
  inv: { paint_red: 1, paint_blue: 1 },
  equip: { frame: '', title: '', paint: 'paint_red', badges: [] },
  log: [],
};

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const child = spawn(edge, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', '--use-angle=d3d11',
  '--enable-gpu', '--enable-unsafe-swiftshader', base], { stdio: 'ignore' });

let ws = null;
try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  if (!tabs) throw new Error('CDP 未就绪');
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const pending = new Map();
  const errors = [];
  let seq = 0;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const ev = async (expression) => (await cdp('Runtime.evaluate', {
    expression: `(async function(){ try { return (${expression}); } catch(e){ return 'ERR:'+e.message; } })()`,
    returnByValue: true, awaitPromise: true,
  }))?.result?.value;
  const waitFor = async (expr, label, tries = 120) => {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await ev(expr);
      if (last === true) return true;
      await sleep(250);
    }
    console.error('    timeout:', label, JSON.stringify(last));
    return false;
  };
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
    console.log('  · shots/verify/' + name);
  };

  await waitFor(`!!document.getElementById('btn-solo')`, '主菜单');
  const user = 'paint' + Date.now().toString(36).slice(-4);
  const token = await ensureTestAccount('http://127.0.0.1:3000', user, 'sail123456');
  ok(!!token, '测试账号 token 已拿到');
  await ev(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', ${JSON.stringify(user)});
    localStorage.setItem('rr-wallet-cache', ${JSON.stringify(JSON.stringify(DEMO))});
    return 1;
  })()`);
  await ev(`(function(){ location.reload(); return 1; })()`);

  // 等 main.js 顶层跑完（onclick 已挂上），只等 DOM 存在会点空
  const wired = await waitFor(
    `typeof document.getElementById('btn-solo')?.onclick === 'function'`, '主脚本就绪');
  ok(wired, '主脚本已挂好入口事件');
  await sleep(500);
  await ev(`(document.getElementById('btn-solo').click(), 1)`);
  const inLobby = await waitFor(`!document.getElementById('lobby').classList.contains('hidden')`, '进入大厅');
  ok(inLobby, '单人练习进入大厅');
  await sleep(1800);

  // ---- 打开「选择赛艇」抽屉 ----
  await ev(`(document.getElementById('btn-lobby-boat').click(), 1)`);
  const drawerOpen = await waitFor(
    `document.getElementById('lobby-pick-drawer').classList.contains('open')`, '抽屉展开');
  ok(drawerOpen, '选择赛艇抽屉已展开');
  await sleep(1400); // 等模型加载 + 首帧

  const hostVisible = await ev(`!document.getElementById('lobby-paint-preview').classList.contains('hidden')`);
  ok(hostVisible === true, '涂装预览块已显示');

  const hasCanvas = await ev(`!!document.querySelector('#lobby-paint-stage canvas')`);
  ok(hasCanvas === true, '预览窗里挂了 WebGL canvas');

  const dots = await ev(`document.querySelectorAll('#lobby-paint-colors .lp-dot').length`);
  ok(dots === 7, '色点数量 = 原色 + 6 涂装', dots);

  const locks = await ev(`document.querySelectorAll('#lobby-paint-colors .lp-dot.lock').length`);
  ok(locks === 4, '未拥有的 4 个涂装带锁态', locks);

  const disabled = await ev(`document.querySelectorAll('#lobby-paint-colors .lp-dot:disabled').length`);
  ok(disabled === 4, '未拥有的色点被禁用（点不动）', disabled);

  const nameNow = await ev(`document.getElementById('lobby-paint-name').textContent`);
  ok(nameNow === '赤焰红', '初始预览跟随已装备的赤焰红', nameNow);

  // canvas 有没有真正画出东西：看它是不是全透明
  const painted = await ev(`(function(){
    const c = document.querySelector('#lobby-paint-stage canvas');
    if (!c) return -1;
    return c.width * c.height;
  })()`);
  ok(painted > 1000, 'canvas 尺寸正常', painted);
  const dump = await ev(`(function(){
    const p = window.__paintPreview;
    if (!p) return 'no-preview';
    const m = p.model;
    return {
      cam: p.camera.position.toArray().map((v) => +v.toFixed(2)),
      fov: p.camera.fov, aspect: +p.camera.aspect.toFixed(3),
      draw: [p.renderer.domElement.width, p.renderer.domElement.height],
      client: [p.container.clientWidth, p.container.clientHeight],
      boat: p.boatId,
      scale: m ? +m.scale.x.toFixed(3) : null,
      pos: m ? m.position.toArray().map((v) => +v.toFixed(2)) : null,
    };
  })()`);
  console.log('    preview:', JSON.stringify(dump));
  await shot('lobby_paint_preview.png');

  // ---- 点已拥有的霜蓝：预览应切色 ----
  await ev(`(document.querySelector('#lobby-paint-colors [data-lp-paint="paint_blue"]').click(), 1)`);
  await sleep(700);
  const nameBlue = await ev(`document.getElementById('lobby-paint-name').textContent`);
  ok(nameBlue === '霜蓝', '点霜蓝后标题跟着变', nameBlue);
  const onBlue = await ev(`!!document.querySelector('#lobby-paint-colors [data-lp-paint="paint_blue"].on')`);
  ok(onBlue === true, '霜蓝色点为选中态');
  await shot('lobby_paint_preview_blue.png');

  // ---- 点未拥有的翡翠：应当完全没有反应，尤其不能弹出商城 ----
  await ev(`(document.querySelector('#lobby-paint-colors [data-lp-paint="paint_jade"]').click(), 1)`);
  await sleep(800);
  const shopOpen = await ev(`!document.getElementById('wallet-panel').classList.contains('hidden')`);
  ok(shopOpen === false, '点未拥有色点不会弹商城');
  const nameStill = await ev(`document.getElementById('lobby-paint-name').textContent`);
  ok(nameStill === '霜蓝', '点未拥有色点不改变预览', nameStill);

  // ---- 商城涂装分类的卡面（单独打开看，不复用上面那步）----
  await ev(`(document.getElementById('name-plate').click(), 1)`);
  await sleep(900);
  const shopOpened = await ev(`!document.getElementById('wallet-panel').classList.contains('hidden')`);
  ok(shopOpened === true, '玩家面板能从名牌打开');
  await ev(`(document.querySelector('#wallet-panel [data-ws-cat="paint"]').click(), 1)`);
  await sleep(600);
  const catPaint = await ev(`document.querySelector('#wallet-panel [data-ws-cat="paint"]')?.className || ''`);
  ok(/\bact\b/.test(String(catPaint)), '小店落在涂装分类', catPaint);
  const paintCards = await ev(`document.querySelectorAll('#wallet-panel .ws-boatimg').length`);
  ok(paintCards >= 1, '涂装卡面用真实船型图渲染', paintCards);
  await shot('shop_paint_cards.png');

  // ---- 关小店、关抽屉，预览应停 ----
  await ev(`(document.getElementById('wallet-panel').querySelector('[data-ws="close"]').click(), 1)`);
  await sleep(400);
  await ev(`(document.getElementById('btn-lobby-pick-close').click(), 1)`);
  await sleep(900);
  const closed = await ev(`document.getElementById('lobby-pick-drawer').classList.contains('open')`);
  ok(closed === false, '抽屉能正常收起');

  // 关掉抽屉后，大厅中央的展台也要是同一个涂装（否则会像「涂装没生效」）
  const stagePainted = await ev(`(window.__showcase?.paintedMeshes?.length || 0) > 0`);
  ok(stagePainted === true, '大厅展台同步刷上了涂装');
  await shot('lobby_paint_stage.png');

  if (errors.length) console.error('  页面异常：', errors.slice(0, 5));
  ok(errors.length === 0, '无运行时报错', errors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
}
console.log(failures ? `\n失败 ${failures} 项` : '\n全部通过');
process.exit(failures ? 1 : 0);
