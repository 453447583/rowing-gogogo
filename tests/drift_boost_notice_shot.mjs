// 出弯小喷 / 双喷提示条的实机出图（2026-11-19）
//
//   node tests/drift_boost_notice_shot.mjs [baseUrl] [boatId] [mapId]
//
// 复用 drift_boost_notice_probe 的输入时间线，只做两件事：
//   ① 打出一次双喷（金色）→ 截图
//   ② 低速打一次小喷（绿色）→ 截图
// 出图 shots/hud/drift-double.jpg / drift-single.jpg
//
// 截图走 CDP Page.captureScreenshot（抓的是 DOM 合成层，含 canvas 与 HUD），
// 每局只拍一次：swiftshader 软渲染下连拍第二次容易挂死（MEMORY 记过的坑）。
// 拍之前把 noticeTtl 顶到 5s，否则 0.9s 的提示条在截图请求路上就淡没了。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
// ?raceIntro=0：跳过开场环绕镜头 + HUD 淡入。hud_chip_shot.mjs 用的同一个口子。
// 不加的话 #hud 整层 opacity 停在 0（CSS transition 在无头里不推进），
// DOM 全对、截图只剩水面。
const url = base.includes('?') ? `${base}&raceIntro=0` : `${base}?raceIntro=0`;
const boatId = process.argv[3] || 'rower';
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/drift-notice-shot-' + Date.now());
const port = 9990 + Math.floor(Math.random() * 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 无头软渲染吃内存：1280×720 @dpr2 = 2560×1440 的合成缓冲，实测连跑两轮会崩渲染进程。
// 出图只关心提示条，降到 1000×620 且钉死 dpr=1，画面小一点但稳。
// ⚠ 必须走 --headless=new + --use-angle=d3d11（不加 --disable-gpu）：
// 老的软渲染 headless 下 Page.captureScreenshot 只合成 WebGL 层，
// DOM 的 HUD 一个字都不进图（实测 chip opacity=1、文本正确，图里却只有水面）。
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1000,620', '--force-device-scale-factor=1', url], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const cleanup = async () => { try { ws?.terminate(); } catch {} child.kill('SIGKILL'); await sleep(300); };
async function waitJson(url, timeout = 25000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

const outDir = path.resolve('shots/hud');
await fs.mkdir(outDir, { recursive: true });

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3000);
  const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;
  const waitFor = async (expr, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; };

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await ev(`document.querySelector('#btn-solo')?.click()`);
  await waitFor(`!!document.querySelector('#lobby') && !document.querySelector('#lobby').classList.contains('hidden')`);
  await ev(`document.querySelector('#btn-lobby-boat')?.click()`); await sleep(400);
  await ev(`document.querySelector('.lp-card[data-boat="${boatId}"]')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-map')?.click()`); await sleep(400);
  await ev(`document.querySelector('.lp-card[data-map="${mapId}"]')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click()`); await sleep(300);
  await ev(`document.querySelector('#btn-start-race')?.click()`);
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 40000)) throw new Error('对局没起来');
  await sleep(1500);

  // 装时间线：slow=false 打双喷，slow=true 用低速打小喷
  await ev(`(() => {
    const g = window.__game, b0 = g.localBoat;
    g.opts.onFinish = null; g.opts.onQuit = null;
    g.raceIntro = null; g.countdownLeft = 0; g.phase = 'racing'; g.raceTime = 0;
    g.finished = false;
    g.cameraRig.follow = () => {};
    g.mode = 'race';
    g.colliders = []; g.track.shoreColliders = []; g.track.mechColliders = [];
    g.track.constrain = () => {}; g.track.applyMechs = () => {}; g.track.updateCoaster = () => {};
    b0.waveLaunchEnabled = false; b0.waveJumpEnabled = false; b0.surfaceDriftGain = 0.12;
    const keys = g.opts.input.keys, codes = g.opts.input.codes;
    const gate0 = g.track.gatePos(0), gate1 = g.track.gatePos(1);
    const safeH = Math.atan2(gate1[0] - gate0[0], gate1[1] - gate0[1]);
    const recover = () => {
      b0.resetTo(gate0[0], gate0[1], safeH);
      b0.vel.set(Math.sin(safeH) * 18, Math.cos(safeH) * 18);
      b0.speed = 18; b0.stunTimer = 0; b0.wallContactTimer = 0;
      b0.driftLockout = 0; b0.driftBreak = 0;
      b0.miniBoostQueue = 0; b0.miniBoostTimer = 0; b0.miniBoostGap = 0;
      b0.driftBoostCd = 0; b0.driftAnglePeak = 0; b0.drifting = false; b0.wasDrifting = false;
      g.notice = null; g.noticeTtl = 0; g.noticeCooldown = 0; g.noticeLastKey = '';
      g.finished = false; g.phase = 'racing';
    };
    recover();
    const plan = window.__plan = { slow: false, t: 0, ready: false, fireAt: 0 };
    const origUpdate = b0.updateLocal.bind(b0);
    b0.updateLocal = (dt, input, t, colliders, boundary) => {
      if (g.phase !== 'racing' || g.finished) { g.phase = 'racing'; g.finished = false; }
      plan.t += dt;
      const T = plan.t;
      let drift = false, steer = 0;
      if (plan.slow) {
        if (T >= 0.1 && T < 0.16) {
          const sp = 12;
          b0.vel.set(Math.sin(b0.heading) * sp, Math.cos(b0.heading) * sp);
          b0.speed = sp; b0.stunTimer = 0; b0.wallContactTimer = 0;
        }
        if (T >= 0.3 && T < 1.0) { drift = true; steer = 1; }
        else if (T >= 1.0 && T < 1.2) { drift = false; steer = 0; }
      } else {
        if (T >= 0.3 && T < 2.4) { drift = true; steer = 1; }
        else if (T >= 2.4 && T < 2.6) { drift = false; steer = 0; }
      }
      keys.clear(); codes.clear();
      if (!(plan.slow && T >= 0.16 && T < 1.2)) keys.add('arrowup');
      if (drift) codes.add('ShiftLeft');
      if (steer > 0) keys.add('arrowleft');
      input.steer = steer; input.drift = drift; input.nitro = false;
      const r = origUpdate(dt, input, t, colliders, null);
      const n = g.notice;
      if (!plan.ready && n && (n.main === '双喷成功' || n.main === '小喷成功') && !plan.slow
        && (plan.t > 2.4)) {
        plan.ready = true; g.noticeTtl = 5;   // 顶住 TTL，留给截图
      }
      if (!plan.ready && plan.slow && n && n.main === '小喷成功') {
        plan.ready = true; g.noticeTtl = 5;
      }
      // 截图窗口内不许过期：无头软渲染帧率低，UI 的 rAF 可能好几帧才轮到一次，
      // 0.9s 的 TTL 很容易在"检测到 → 真正拍到"之间被递减掉。
      if (plan.ready) g.noticeTtl = 999;
      return r;
    };
    return true;
  })()`);

  const shoot = async (file) => {
    // #hud 的淡入走 CSS transition，而无头页面不推进 transition 进度：
    // inline opacity=1 了、computed 还停在 0（读到的就是过渡起始值）。
    // 所以先关过渡再置 1，并强制一次 reflow 让样式落地。
    await ev(`(() => { const h = document.getElementById('hud');
      h.style.transition = 'none'; h.style.opacity = '1'; void h.offsetHeight; return true; })()`);
    await sleep(200);
    const diag = await ev(`(() => {
      const a = document.getElementById('hud-assist');
      const c = document.getElementById('assist-chip');
      const hud = document.getElementById('hud');
      const ra = a?.getBoundingClientRect(), rc = c?.getBoundingClientRect();
      const cs = (el) => { if (!el) return null; const s = getComputedStyle(el);
        return { op: s.opacity, vis: s.visibility, disp: s.display, z: s.zIndex, pos: s.position }; };
      const hit = document.elementFromPoint(400, 140);
      return {
        dpr: window.devicePixelRatio, vh: window.innerHeight,
        hudClass: hud?.className, assistClass: a?.className,
        hudStyleAttr: hud?.getAttribute('style'),
        anims: (document.getAnimations?.() || []).slice(0, 8).map((an) => (an.animationName || an.transitionProperty || '?')
          + '@' + (an.effect?.target?.id || an.effect?.target?.className || '?')),
        hudStyle: cs(hud), assistStyle: cs(a), chipStyle: cs(c),
        hitAt140: hit ? (hit.id || hit.className || hit.tagName) : null,
        chipTone: c?.dataset.tone, chipOpacity: getComputedStyle(c).opacity,
        mainText: document.getElementById('ac-main')?.textContent,
        ar: ra ? [Math.round(ra.x), Math.round(ra.y), Math.round(ra.width), Math.round(ra.height)] : null,
        cr: rc ? [Math.round(rc.x), Math.round(rc.y), Math.round(rc.width), Math.round(rc.height)] : null,
      };
    })()`);
    console.error('  dom:', JSON.stringify(diag));
    const rect = await ev(`(() => { const r = document.getElementById('hud-assist').getBoundingClientRect();
      return { x: Math.max(0, r.x - 40), y: Math.max(0, r.y - 30), w: r.width + 80, h: r.height + 60 }; })()`);
    const res = await cdp('Page.captureScreenshot', {
      format: 'jpeg', quality: 88,
      clip: { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 },
    });
    await fs.writeFile(file, Buffer.from(res.data, 'base64'));
    console.error(`  出图 ${file}（${Math.round(rect.w)}×${Math.round(rect.h)}）`);
  };

  await waitFor(`!!window.__plan && window.__plan.ready`, 30000);
  const litOk = await waitFor(`+getComputedStyle(document.getElementById('assist-chip')).opacity > 0.5`, 4000);
  if (!litOk) console.error('  ⚠ 提示条没亮起来：', JSON.stringify(await ev(`(() => { const g = window.__game; return {
    notice: g.notice ? g.notice.main : null, ttl: +g.noticeTtl.toFixed(2),
    phase: g.phase, finished: g.finished, mode: g.mode }; })()`)));
  await sleep(150);
  await shoot(path.join(outDir, 'drift-double.jpg'));

  // 第二轮：低速 → 小喷
  await ev(`(() => { const p = window.__plan; p.slow = true; p.t = 0; p.ready = false;
    window.__recoverProbe && window.__recoverProbe(); return true; })()`);
  await ev(`(() => {
    const g = window.__game, b0 = g.localBoat;
    const gate0 = g.track.gatePos(0), gate1 = g.track.gatePos(1);
    const safeH = Math.atan2(gate1[0] - gate0[0], gate1[1] - gate0[1]);
    b0.resetTo(gate0[0], gate0[1], safeH);
    b0.vel.set(Math.sin(safeH) * 18, Math.cos(safeH) * 18); b0.speed = 18;
    b0.stunTimer = 0; b0.wallContactTimer = 0; b0.driftLockout = 0; b0.driftBreak = 0;
    b0.miniBoostQueue = 0; b0.miniBoostTimer = 0; b0.miniBoostGap = 0;
    b0.driftBoostCd = 0; b0.driftAnglePeak = 0; b0.drifting = false; b0.wasDrifting = false;
    g.notice = null; g.noticeTtl = 0; g.noticeCooldown = 0; g.noticeLastKey = ''; g.noticePending = null;
    g.finished = false; g.phase = 'racing';
    return true;
  })()`);
  await waitFor(`!!window.__plan && window.__plan.ready`, 30000);
  const litOk2 = await waitFor(`+getComputedStyle(document.getElementById('assist-chip')).opacity > 0.5`, 4000);
  if (!litOk2) console.error('  ⚠ 小喷提示条没亮起来：', JSON.stringify(await ev(`(() => { const g = window.__game; return {
    notice: g.notice ? g.notice.main : null, ttl: +g.noticeTtl.toFixed(2),
    phase: g.phase, finished: g.finished, mode: g.mode }; })()`)));
  await sleep(150);
  await shoot(path.join(outDir, 'drift-single.jpg'));

  console.log(JSON.stringify({ ok: true, out: ['shots/hud/drift-double.jpg', 'shots/hud/drift-single.jpg'] }));
} finally { await cleanup(); }
