// 漂移姿态取景（2026-11-16 重做后）
//
//   node tests/drift_shot.mjs [baseUrl] [boatId] [mapId]
//
// 直接把物理推到指定时刻，再从「车尾跟拍」+「俯视」两个机位各拍一张，
// 用来肉眼确认：车头指向弯内、船身真的在侧滑、侧倾跟着滑移角走。
// 输出 shots/drift/<tag>-<view>-<n>.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const boatId = process.argv[3] || 'cow';
const mapId = process.argv[4] || 'strait';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/drift-shot-' + Date.now());
const port = 9800 + Math.floor(Math.random() * 150);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--use-angle=d3d11', '--enable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1280,720', base],
{ stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const cleanup = async () => { try { ws?.terminate(); } catch {} child.kill('SIGKILL'); await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); };
async function waitJson(url, timeout = 30000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

const CAPTURE = (frames) => `(() => {
  const g = window.__game, b = g.localBoat, dt = 1 / 60;
  const cam = g.camera;
  g.cameraRig.follow = () => {};
  b.resetTo(0, 0, 0);
  b.waveLaunchEnabled = false; b.waveJumpEnabled = false; b.waveJump = false;
  b.boostTimer = 0; b.miniBoostTimer = 0; b.miniBoostQueue = 0; b.nitroBottles = 0;
  b.stunTimer = 0; b.airborne = false; b.onCoaster = null; b.drifting = false;
  b.driftAngle = 0; b.driftWant = 0; b.driftTime = 0; b.driftAnglePeak = 0;
  b.vel.set(0, 0); b.speed = 0; b.heading = 0; b.thrustState = 0; b.steerInput = 0;
  b.prevPos.copy(b.pos);
  const run = (n, inp, t0) => { for (let i = 0; i < n; i++) b.updateLocal(dt, inp, t0 + i * dt, [], null); };
  run(600, { throttle: 1, steer: 0 }, 0);          // 拉到极速
  const shots = [];
  const grab = (view, label) => {
    const h = b.heading;
    if (view === 'chase') {
      const back = 8.5, up = 3.4;
      cam.position.set(b.pos.x - Math.sin(h) * back, b.pos.y + up, b.pos.z - Math.cos(h) * back);
      cam.lookAt(b.pos.x, b.pos.y + 1.2, b.pos.z);
    } else {
      cam.position.set(b.pos.x - Math.sin(h) * 9, b.pos.y + 13, b.pos.z - Math.cos(h) * 9);
      cam.lookAt(b.pos.x, b.pos.y, b.pos.z);
    }
    cam.updateMatrixWorld();
    g.post.render(1 / 60);
    shots.push({
      label, view,
      png: g.renderer.domElement.toDataURL('image/jpeg', 0.88),
      angle: +(b.driftAngle * 180 / Math.PI).toFixed(1),
      speed: +(b.speed * 3.6).toFixed(1),
      drifting: b.drifting,
      heading: +b.heading.toFixed(3),
      slip: +(b.slipAngle * 180 / Math.PI).toFixed(1),
    });
  };
  const plan = ${JSON.stringify(frames)};
  let t = 0;
  for (const step of plan) {
    run(step.n, step.inp, t); t += step.n * dt;
    for (const v of ['chase', 'top']) grab(v, step.label);
  }
  return JSON.stringify(shots);
})()`;

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
  const waitFor = async (expr, ms = 25000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(300); } return false; };

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
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 45000)) throw new Error('对局没起来');
  await sleep(900);
  await ev(`(() => { const g=window.__game; g.opts.onFinish=null; g.opts.onQuit=null; g.phase='racing'; document.querySelector('#hud')?.classList.remove('hidden'); })()`);

  const frames = [
    // 直道基准
    { n: 0, inp: { throttle: 1, steer: 0 }, label: 'straight' },
    // 起漂 0.10s（角度刚建立）
    { n: 6, inp: { throttle: 1, steer: 1, drift: true }, label: 'drift-0.10s' },
    // 起漂 0.40s（角度拉满）
    { n: 18, inp: { throttle: 1, steer: 1, drift: true }, label: 'drift-0.40s' },
    // 拖漂 1.2s
    { n: 48, inp: { throttle: 1, steer: 1, drift: true }, label: 'drift-1.20s' },
    // 松方向回正（按住漂移键）：双喷起手
    { n: 8, inp: { throttle: 1, steer: 0, drift: true }, label: 'straighten' },
  ];

  const raw = await cdp('Runtime.evaluate', { expression: CAPTURE(frames), returnByValue: true });
  if (raw.exceptionDetails) {
    console.error('EXC:', raw.exceptionDetails.exception?.description || raw.exceptionDetails.text);
  } else {
    const shots = JSON.parse(raw.result.value);
    const dir = path.resolve('shots/drift');
    await fs.mkdir(dir, { recursive: true });
    let i = 0;
    for (const s of shots) {
      const file = path.join(dir, `${boatId}-${String(i).padStart(2, '0')}-${s.view}-${s.label}.jpg`);
      await fs.writeFile(file, Buffer.from(s.png.split(',')[1], 'base64'));
      console.error(`${path.basename(file)}  滑移 ${s.angle}° 速度 ${s.speed}km/h drift=${s.drifting}`);
      i++;
    }
    console.error(`已写入 ${shots.length} 张 → shots/drift/`);
  }
} finally { await cleanup(); }
