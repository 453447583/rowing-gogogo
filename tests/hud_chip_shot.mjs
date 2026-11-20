// 中央提示条版式出图 / 布局探针
//
//   node tests/hud_chip_shot.mjs
//   MAP=canyon node tests/hud_chip_shot.mjs
//
// 干什么：
//   ① 真进一局，把 5 个色调各播一次，量出面板的真实几何（宽高、斜切角度、
//      文字是否溢出、光晕是否被裁）；
//   ② 每个色调截一张图到 shots/hud/chip-<tone>.jpg，肉眼核对版式。
//
// 为什么不在页面里单独搭个 mock：这套 CSS 是 index.html 内联的，字体回退、
// HUD 缩放、父级定位全在真实环境里，mock 出来的和游戏里不是一个东西。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/chip-${stamp}`;
const port = 9820 + (Number(stamp.slice(-3)) % 30);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = `${base}?raceIntro=0`;
const mapId = process.env.MAP || 'strait';
const BOAT = process.env.BOAT || 'rower';
const TONES = (process.env.TONES || 'purple,red,green,gold,blue').split(',');

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

let failed = 0;
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

/** 每条提示的示例文案：主字尽量短（撞墙 2 字）和长（圈评 10 字）各来一条 */
const CASES = {
  purple: { main: '💥 被炸沉', sub: '吃了导弹', ttl: 4 },
  red: { main: '🧱 撞墙', sub: '蹭到护栏', ttl: 4 },
  green: { main: '完美起步', sub: '氮气 1.8s', ttl: 4 },
  gold: { main: '第 2 圈 58.4 秒', sub: '破纪录 · 快了 1.20 秒', ttl: 4 },
  blue: { main: '跨越断层', sub: '落地稳', ttl: 4 },
};

async function startSolo() {
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-boat')?.click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-boat="${BOAT}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-boat="${BOAT}"]').click(); 1`);
  await sleep(250);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 240000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
  await sleep(400);
}

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await startSolo();

  await fs.mkdir('shots/hud', { recursive: true });

  for (const tone of TONES) {
    const c = CASES[tone] || CASES.blue;
    await evaluate(`(() => {
      const g = window.__game;
      g.notice = { main: ${JSON.stringify(c.main)}, sub: ${JSON.stringify(c.sub)}, tone: '${tone}', priority: 3 };
      g.noticeTtl = ${c.ttl}; g.noticePending = null;
      g.noticeCooldown = 0;
      return 1;
    })()`);
    await sleep(420);

    const geo = val(await evaluate(`(() => {
      const chip = document.querySelector('#assist-chip');
      const plate = chip.querySelector('.ac-plate');
      const main = document.querySelector('#ac-main');
      const sub = document.querySelector('#ac-sub');
      const bar = chip.querySelector('.ac-bar');
      const r = chip.getBoundingClientRect();
      const pr = plate.getBoundingClientRect();
      const mr = main.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      const br = bar.getBoundingClientRect();
      const cs = getComputedStyle(main);
      return {
        tone: chip.dataset.tone,
        op: parseFloat(chip.style.opacity || '0'),
        w: +r.width.toFixed(1), h: +r.height.toFixed(1),
        left: +r.left.toFixed(1), top: +r.top.toFixed(1),
        plateW: +pr.width.toFixed(1), plateH: +pr.height.toFixed(1),
        mainX: +mr.left.toFixed(1), mainRight: +mr.right.toFixed(1),
        barW: +br.width.toFixed(1), barH: +br.height.toFixed(1),
        subSize: getComputedStyle(sub).fontSize,
        mainSize: cs.fontSize,
        stroke: cs.webkitTextStrokeWidth,
        bgClip: cs.webkitBackgroundClip || cs.backgroundClip,
        /* 主字是否真的压在面板内（左右各留 8px 内边距） */
        mainInside: mr.left > pr.left + 6 && mr.right < pr.right - 6,
        subInside: sr.right < pr.right - 2 || sr.width === 0,
        vw: innerWidth,
      };
    })()`));
    // 逐项判定，失败时直接说哪一项不对（一次跑完不用猜）
    const checks = {
      // 多层背景时 background-clip 会返回列表（"text, text"），只能正则
      '裁字生效': /(^|,\s*)text(,|$)/.test(geo?.bgClip || ''),
      '可见': geo && geo.op > 0.9,
      '主字在面板内': geo && geo.mainInside,
      '副字在面板内': geo && geo.subInside,
      '左侧光条 3px': geo && geo.barW >= 2.5 && geo.barW <= 4.5,
      '主字 22~26px': geo && parseFloat(geo.mainSize) >= 22 && parseFloat(geo.mainSize) <= 26,
      '副字 ≈50%': geo && parseFloat(geo.subSize) >= 11 && parseFloat(geo.subSize) <= 14,
      '描边 1~2px': geo && parseFloat(geo.stroke) >= 1 && parseFloat(geo.stroke) <= 2,
      '面板够高': geo && geo.plateH >= 40,
    };
    const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    report(bad.length === 0, `[${tone}] 版式 ${geo?.w}×${geo?.h} 面板 ${geo?.plateW}×${geo?.plateH} `
      + `主字 ${geo?.mainSize} 描边 ${geo?.stroke}` + (bad.length ? ` ✗ ${bad.join('/')}` : ''));

    // 一条一条截：clip 只框住提示条那一小块，像素少、也躲开整屏截图的老坑
    try {
      const clip = {
        x: Math.max(0, geo.left - 30), y: Math.max(0, geo.top - 30),
        width: geo.w + 60, height: geo.h + 60, scale: 2,
      };
      const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92, clip });
      await fs.writeFile(`shots/hud/chip-${tone}.jpg`, Buffer.from(shot.data, 'base64'));
      console.log(`  shot → shots/hud/chip-${tone}.jpg`);
    } catch (e) {
      console.log(`  shot skipped (${tone}): ${e.message}`);
    }
    await evaluate(`(() => { window.__game.noticeTtl = 0; return 1; })()`);
    await sleep(260);
  }

  // 面板形状：四个角必须都不在圆角矩形上（斜切就是靠 clip-path 的四个斜角）
  const shape = val(await evaluate(`(() => {
    const chip = document.querySelector('#assist-chip');
    chip.dataset.tone = 'red';
    window.__game.notice = { main: '撞墙', sub: '蹭到护栏', tone: 'red', priority: 3 };
    window.__game.noticeTtl = 4;
    const plate = chip.querySelector('.ac-plate');
    const cp = getComputedStyle(plate).clipPath;
    return { cp, radius: getComputedStyle(chip).borderRadius };
  })()`));
  report(shape && /polygon/.test(shape.cp || ''), `面板用 clip-path 斜切（${shape?.cp}）`);

  console.log(failed === 0 ? 'hud chip probe: PASS' : `hud chip probe: ${failed} FAIL`);
} catch (e) {
  console.error('probe error:', e?.message || e);
  failed += 1;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(failed === 0 ? 0 : 1);
