// 弹射器音效验收（2026-11-20）
//
//   node tests/launcher_sound_probe.mjs [baseUrl]
//
// 验三件事：
//   ① 弹射器接触即弹时播的是 launcher_launch（新素材），不是大浪的 wave_launch
//   ② 新素材已解码到 sfxBuffers（文件确实存在、可解码）
//   ③ 弹射只播一次、不启动循环
//
// 做法：hook window.__audio.play / startLoop 记调用；把本地船瞬移到第一个弹射平台触发。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/launcher-sound-' + Date.now());
const port = 9970 + Math.floor(Math.random() * 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=900,560', '--autoplay-policy=no-user-gesture-required', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }))?.result?.value;
async function waitFor(expr, ms = 45000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; }
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('timeout ' + u); }

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2500);
  const waitForClick = async (sel) => { await waitFor(`typeof document.querySelector('${sel}')?.onclick === 'function'`); await ev(`document.querySelector('${sel}').click(); 1`); };

  await waitForClick('#btn-solo');
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`);
  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`); await sleep(300);
  await ev(`document.querySelector('#lobby-pick-body [data-boat="rower"]')?.click(); 1`); await sleep(250);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`); await sleep(250);
  // 弹射模式：确保有弹射平台
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`); await sleep(350);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="launch"]')?.click(); 1`); await sleep(250);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`); await sleep(250);
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  if (!await waitFor('!!(window.__game && window.__game.localBoat)', 50000)) throw new Error('对局没起来');
  await sleep(800);

  // 解锁音频 + 等待全部采样解码
  const diag = await ev(`(async () => {
    const a = window.__audio;
    a.unlock();
    if (a.ctx && a.ctx.state !== 'running') { try { await a.ctx.resume(); } catch {} }
    await a.loadSfx();
    const g = window.__game;
    const b = g.localBoat;
    const plats = g.track.marine?.platforms || [];
    // hook 播放调用
    window.__ls = [];
    const op = a.play.bind(a);
    a.play = (n, o = {}) => { window.__ls.push({ name: n, kind: 'play' }); return op(n, o); };
    const sl = a.startLoop.bind(a);
    a.startLoop = (n) => { window.__ls.push({ name: n, kind: 'loop' }); return sl(n); };
    window.__buf = { launcher: a.sfxBuffers.has('launcher_launch'), wave: a.sfxBuffers.has('wave_launch') };
    window.__dur = a.sfxBuffers.get('launcher_launch')?.duration || 0;
    if (!plats.length) return { err: 'no platforms', mode: g.mode };
    const p = plats[0];
    b.airborne = false; b.onCoaster = false; b.launchCooldown = 0;
    b.pos.y = p.y || 0;
    b.pos.x = p.x; b.pos.z = p.z;
    return { plats: plats.length, p: { x: +p.x.toFixed(1), z: +p.z.toFixed(1), y: p.y || 0 } };
  })()`);
  await sleep(600); // 跑几帧让 Track 的弹射检测命中
  const res = await ev(`(() => ({
    plays: window.__ls || [],
    buf: window.__buf || {},
    dur: +(window.__dur || 0).toFixed(2),
    airborne: !!window.__game.localBoat.airborne,
  }))()`);

  const launcherPlays = res.plays.filter((x) => x.kind === 'play' && x.name === 'launcher_launch');
  const loops = res.plays.filter((x) => x.kind === 'loop');
  const checks = {
    '有弹射平台': !(diag?.err),
    '弹射音已解码': !!res.buf.launcher && res.dur > 1,
    '接触即弹触发': !!res.airborne,
    '播 launcher_launch': launcherPlays.length >= 1,
    '未误播 wave_launch': !res.plays.some((x) => x.name === 'wave_launch'),
    '无循环': loops.length === 0,
  };
  const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log(JSON.stringify({ diag, res, checks, bad }, null, 2));
  console.log(bad.length ? 'FAIL → ' + bad.join(' / ') : 'PASS');
  if (bad.length) process.exitCode = 1;
} catch (e) {
  console.error('PROBE ERROR', e);
  process.exitCode = 1;
} finally {
  try { ws && ws.close(); } catch {}
  try { child.kill(); } catch {}
}
