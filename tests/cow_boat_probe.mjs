// 牛来号（第 9 艘船）双模式验收：
//   1) 大厅选艇抽屉 9 格布局（奇数条时最后一张铺满整行）—— 用真实鼠标点击开抽屉
//   2) 竞速：骨骼模型加载、fitTo:'height' 缩放、四个动作随状态切换
//   3) 怪物模式：牛来号能进、拿到自己的主炮、HUD 不出错
// 用法：node tests/cow_boat_probe.mjs [baseUrl]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cow-boat-' + Date.now());
const port = 9900 + Math.floor(Math.random() * 40);
const outDir = 'shots/verify/cow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fs.mkdir(outDir, { recursive: true });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1024,640', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + m)); }
    }, 30000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
  });
};
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const shot = async (name) => {
  const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  await fs.writeFile(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  console.log('  shot →', path.join(outDir, name));
};
// 点击助手：这里用 DOM 的 .click() 就够了（大厅按钮都是普通 onclick）。
// 试过 Input.dispatchMouseEvent + scrollIntoView，反而会因抽屉滚动/滑出动画把坐标算歪，
// 频繁点空（有时点到「游戏设置」）。要真实鼠标的场景在别的探针里。
const mouseClick = async (sel) => {
  const ok = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!ok) throw new Error('找不到元素: ' + sel);
  await sleep(160);
};
const poll = async (expr, ms = 30000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true;
    await sleep(250);
  }
  console.log('  ! 超时未满足:', label || expr);
  return false;
};

const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

const COW = `[...(window.__game?.boats?.values?.() || [])].find((x) => x.def?.id === 'cow')`;
const errors = [];
try {
  let tabs = null;
  for (let i = 0; i < 80 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  if (!tabs) throw new Error('Edge DevTools 没起来');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const t = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
      if (!/texImage2D|effekseer/i.test(t)) errors.push(t);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Input.enable').catch(() => {});

  // ---- 大厅 ----
  await poll(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 60000, '主菜单');
  await mouseClick('#btn-solo');
  await poll(`!!document.querySelector('#btn-lobby-boat')?.offsetParent`, 30000, '大厅');

  // ---- 选艇抽屉 ----
  await mouseClick('#btn-lobby-boat');
  await sleep(700);
  const drawer = await evaluate(`(() => {
    const d = document.querySelector('#lobby-pick-drawer');
    const r = d.getBoundingClientRect();
    const g = document.querySelector('#lobby-pick-body .lp-grid');
    const cards = [...g.querySelectorAll('.lp-card')];
    const gr = g.getBoundingClientRect();
    return {
      open: d.classList.contains('open'),
      rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width)],
      transform: getComputedStyle(d).transform,
      className: g.className,
      cards: cards.length,
      columns: getComputedStyle(g).gridTemplateColumns,
      lastWidth: Math.round(cards.at(-1).getBoundingClientRect().width),
      gridWidth: Math.round(gr.width),
      lastName: cards.at(-1).textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  console.log('DRAWER', JSON.stringify(drawer));
  await shot('20-picker.jpg');
  // 抽屉是可滚动的：9 格里的最后一张在折叠线以下，单独滚到底看整行
  await evaluate(`document.querySelector('#lobby-pick-drawer').scrollTop = 9999`);
  await sleep(400);
  await shot('20b-picker-bottom.jpg');

  // ---- 选牛 → 展示台 ----
  await mouseClick('[data-boat="cow"]');
  await sleep(2500);
  // 选完船后抽屉可能已经被选择动作关掉了；此时再点 × 会量到"滑出屏幕后"的坐标，
  // 那里正好压着「游戏设置」——上一轮就是这样把设置抽屉点开了
  if (await evaluate(`document.querySelector('#lobby-pick-drawer')?.classList.contains('open')`)) {
    await mouseClick('#btn-lobby-pick-close');
  }
  await sleep(1500);
  // 探针自己的收尾：scrollIntoView 会把文档横向滚走，抽屉也可能被误点开，
  // 截图前统一复位（这些是测试脚本的行为，跟游戏无关）
  await evaluate(`(() => {
    window.scrollTo(0, 0);
    document.scrollingElement.scrollLeft = 0;
    document.querySelector('#lobby-pick-drawer')?.classList.remove('open');
    document.querySelector('#lobby-settings-drawer')?.classList.remove('open');
    return 1;
  })()`);
  await sleep(600);
  await shot('21-showcase.jpg');
  const picked = await evaluate(`document.querySelector('.pavatar-me, .lobby-boat-strip .lb-on')?.textContent || ''`);
  console.log('PICKED(before boss)', picked.replace(/\s+/g, ' ').trim().slice(0, 40));

  // ---- 怪物模式：切模式 → 开赛 ----
  await mouseClick('#btn-lobby-mode');
  await sleep(500);
  await mouseClick('[data-mode="boss"]');
  await sleep(600);
  await mouseClick('#btn-lobby-pick-close');
  await sleep(400);
  const mode = await evaluate(`document.querySelector('.lobby-mode-name')?.textContent || ''`);
  console.log('MODE', mode);
  await mouseClick('#btn-start-race');

  const bossUp = await poll(`!!window.__game?.bossMode`, 90000, '怪物模式起局');
  const boss = await evaluate(`(() => {
    const g = window.__game; if (!g) return { noGame: true };
    const b = ${COW};
    const bm = g.bossMode;
    const p = bm?.players?.get(bm.myId);
    const pb = p?.boat;
    return {
      bossMode: !!bm,
      phase: bm?.phase,
      stage: bm?.stageIndex,
      boatsKeys: [...(g.boats?.values?.() || [])].map((x) => x.def?.id),
      localBoat: g.localBoat?.def?.id,
      playerBoat: pb?.def?.id,
      playerBoatAnim: pb?.animMap ? Object.keys(pb.animMap) : null,
      playerHasModel: !!pb?.modelRoot,
      boatId: b?.def?.id,
      weaponName: bm?.weapons?.def?.name || null,
      playerHp: p ? Math.round(p.hp) : null,
    };
  })()`);
  console.log('BOSS', JSON.stringify(boss));
  // 跳过过场与倒计时，进战斗看炮口
  await evaluate(`(() => { const bm = window.__game?.bossMode; if (bm) { bm.introT = 99; } return 1; })()`);
  await sleep(600);
  await evaluate(`(() => { const bm = window.__game?.bossMode; if (bm) { bm.countdown = 0.02; } return 1; })()`);
  await poll(`window.__game?.bossMode?.phase === 'fight'`, 40000, '第 1 关开打');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74 });
  await sleep(2500);
  const firing = await evaluate(`(() => {
    const b = ${COW};
    const w = window.__game?.bossMode?.weapons;
    return {
      phase: window.__game?.bossMode?.phase,
      weapon: w?.def?.name,
      heat: w ? +w.heat.toFixed(1) : null,
      projectiles: w ? w.projectiles.length : null,
      animKey: b?.animKey,
    };
  })()`);
  console.log('FIRE', JSON.stringify(firing));
  await shot('22-boss.jpg');

  console.log('ERRORS', errors.length ? errors.slice(0, 4) : '无');
} finally {
  await cleanup();
}
