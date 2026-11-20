// 探针：验证三套新骨骼动画包能加载、clip 名齐全，并验证 Boss.playOnce('enrage') 能起播
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/probe-anim');
const port = 9317;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 240);
  return r?.result?.value;
};
async function waitJson(url, t = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); }
  throw new Error('cdp timeout');
}

let fails = 0;
const check = (ok, label, extra = '') => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + extra : ''));
  if (!ok) fails++;
};

await fs.mkdir(path.dirname(profile), { recursive: true });
child = spawn(edge, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'http://127.0.0.1:3000/'], { stdio: 'ignore' });
const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const pageErrors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push((m.params.exceptionDetails.exception?.description || '').slice(0, 200));
  }
});
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await sleep(3500);

// 1. 三个新动画包能加载，clip 名与 bosses.js 的 anims 映射一致
for (const [pack, want] of [
  ['fd_skills.glb', ['fd_rift_slam', 'fd_gate_call', 'fd_enrage']],
  ['dk_skills.glb', ['dk_grid_thunder', 'dk_enrage']],
  ['bd_skills.glb', ['bd_laser_sweep', 'bd_enrage']],
]) {
  const names = await ev(`window.__loadMonsterModel('/monsters/${pack}').then(g => g.animations.map(a => a.name))`);
  check(Array.isArray(names) && want.every((n) => names.includes(n)), pack + ' clips', JSON.stringify(names));
}

// 2. 进第一关，确认 action 表里挂了新 clip、playOnce 能切到 fd_enrage
await ev('document.querySelector("#btn-solo").click()');
await sleep(500);
await ev('[...document.querySelectorAll("#boat-list .boat-card")].find(x => x.textContent.includes("疾风")).click()');
await ev('document.querySelector("#btn-boat-ok").click()');
await sleep(500);
console.log('mode:', await ev(`(function(){
  const m = document.querySelector('#mode-select');
  m.value = 'boss'; m.dispatchEvent(new Event('change'));
  const s = document.getElementById('boss-stage');
  if (s) { s.value = '1'; s.dispatchEvent(new Event('change')); }
  const ok = document.querySelector('#btn-map-ok'); ok && ok.click();
  return 'ok:' + !!ok;
})()`));
await sleep(10000);
await ev('(function(){ const b = window.__game.bossMode; if (b) b.introT = 99; return 1; })()');
await sleep(800);
await ev('(function(){ const b = window.__game.bossMode; if (b) b.countdown = 0.02; return 1; })()');
await sleep(2500);

const info = await ev(`(function(){
  const b = window.__game.bossMode.boss;
  if (!b) return 'no boss';
  return JSON.stringify({ ready: b.ready, anim: b.animName,
    names: Object.keys(b.actions || {}).filter(k => /^(fd_|dk_|bd_)/.test(k)) });
})()`);
console.log('boss:', info);
let parsed = null;
try { parsed = JSON.parse(info); } catch {}
check(!!parsed && parsed.ready, 'boss ready');
check(!!parsed && ['fd_rift_slam', 'fd_gate_call', 'fd_enrage'].every((n) => parsed.names.includes(n)),
  'stage1 actions include new clips');

const played = await ev(`(function(){
  const b = window.__game.bossMode.boss;
  const ok = b.playOnce('enrage', 1.4);
  return JSON.stringify({ ok, anim: b.animName, hold: +b.animHold.toFixed(2) });
})()`);
console.log('playOnce:', played);
const pl = JSON.parse(played);
check(pl.ok === true && pl.anim === 'fd_enrage' && pl.hold >= 1.4, 'playOnce enrage drives fd_enrage');

check(pageErrors.every((e) => e.includes('texImage2D')), 'no unexpected page exceptions',
  pageErrors.join(' | ').slice(0, 300));
console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILED');

try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(fails === 0 ? 0 : 1);
