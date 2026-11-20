// 牛来号在竞速视角下的取景/尺寸标定 + 动画状态切换实测。
// 小窗口跑（软件渲染帧率太低，大窗口十几秒才走 0.4 秒游戏时间）。
// 用法：node tests/cow_framing_probe.mjs [baseUrl]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cow-frame-' + Date.now());
const port = 9930 + Math.floor(Math.random() * 40);
const outDir = 'shots/verify/cow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fs.mkdir(outDir, { recursive: true });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=720,460', base], { stdio: 'ignore' });

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
const poll = async (expr, ms = 20000, label = '') => {
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

// 牛在画面里占多少屏高：把"包围球上下端"投到 NDC 再取差（比肉眼看图稳定）
const PICK = `(() => {
  const g = window.__game;
  const b = [...g.boats.values()].find((x) => x.def?.id === 'cow');
  if (!b || !b.modelRoot) return null;
  const V3 = b.pos.constructor;
  const c = b.effectEnvelope.center.clone();
  b.group.localToWorld(c);
  const r = b.effectEnvelope.radius;
  const cam = g.camera;
  const top = c.clone().add(new V3(0, r * 0.62, 0)).project(cam);
  const bot = c.clone().add(new V3(0, -r * 0.62, 0)).project(cam);
  return {
    phase: g.phase,
    raceTime: +g.raceTime.toFixed(2),
    camY: +cam.position.y.toFixed(2),
    camDist: +Math.hypot(cam.position.x - b.pos.x, cam.position.z - b.pos.z).toFixed(2),
    fov: +cam.fov.toFixed(1),
    screenFrac: +((top.y - bot.y) / 2).toFixed(3),
    scale: +b.modelRoot.scale.x.toFixed(3),
    speed: +b.speed.toFixed(2),
    animKey: b.animKey,
    timeScale: b.mixer ? +b.mixer.timeScale.toFixed(2) : null,
    smile: +(b.smileMix || 0).toFixed(2),
  };
})()`;

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
      if (!/texImage2D/.test(t)) errors.push(t);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  await poll(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 40000, '主菜单');
  await evaluate(`document.querySelector('#btn-solo').click()`);
  await poll(`!!document.querySelector('#btn-lobby-boat')?.offsetParent`, 20000, '大厅');
  await evaluate(`document.querySelector('#btn-lobby-boat').click()`);
  await sleep(600);
  await evaluate(`document.querySelector('[data-boat="cow"]').click()`);
  await sleep(1500);
  await evaluate(`document.querySelector('#btn-lobby-pick-close').click()`);
  await sleep(500);
  await evaluate(`document.querySelector('#btn-start-race')?.click()`);

  await poll(`!!window.__game && [...window.__game.boats.values()].some((x) => x.def?.id === 'cow' && x.modelRoot)`, 40000, '骨骼模型加载');
  await poll(`window.__game.phase === 'racing'`, 60000, '倒计时结束');
  await sleep(1200);
  console.log('A idle   ', JSON.stringify(await evaluate(PICK)));
  await shot('10-framing-idle.jpg');

  // 油门：等 speed 起来，看 walk 的步频 timeScale 是否跟速度挂钩
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });
  await poll(`[...window.__game.boats.values()].some((x) => x.def?.id === 'cow' && x.speed > 12)`, 25000, '加速到 12m/s');
  console.log('C run    ', JSON.stringify(await evaluate(PICK)));
  await shot('12-run.jpg');

  // 氮气：Ctrl
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await poll(`[...window.__game.boats.values()].some((x) => x.def?.id === 'cow' && x.animKey === 'boost')`, 15000, 'boost 动作');
  console.log('D boost  ', JSON.stringify(await evaluate(PICK)));
  await shot('13-boost.jpg');
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 });

  // 跳舞：模拟冲线第一名
  await evaluate(`(() => { const b = [...window.__game.boats.values()].find((x) => x.def?.id === 'cow'); b.playDance(6); return b.danceTimer; })()`);
  await sleep(1200);
  console.log('E dance  ', JSON.stringify(await evaluate(PICK)));
  await shot('14-dance.jpg');

  console.log('ERRORS', errors.length ? errors.slice(0, 4) : '无');
} finally {
  await cleanup();
}
