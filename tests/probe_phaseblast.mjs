// 探针：进第一关把 BOSS 血压到 1/3，验证崩海咆哮（phaseBlast）会不会放、火带有没有出现
// 进关流程照抄 tests/boss_visual.mjs；截图靠轮询状态，不用固定等待（无头渲染 dt 会被 clamp）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/probe-pb');
const port = 9295;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = path.resolve('shots/verify');
const STAGE = process.argv[2] || '1';

let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 180);
  return r?.result?.value;
};
const shotTo = async (name) => {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, name), Buffer.from(s.data, 'base64'));
};
async function waitJson(url, t = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); }
  throw new Error('cdp timeout');
}

await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(path.dirname(profile), { recursive: true });
child = spawn(edge, ['--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'http://127.0.0.1:3000/'], { stdio: 'ignore' });
const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('PAGE EXC:', (m.params.exceptionDetails.exception?.description || '').slice(0, 200));
  }
});
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await sleep(3500);

await ev('document.querySelector("#btn-solo").click()');
await sleep(500);
await ev('[...document.querySelectorAll("#boat-list .boat-card")].find(x => x.textContent.includes("疾风")).click()');
await ev('document.querySelector("#btn-boat-ok").click()');
await sleep(500);
console.log('mode:', await ev(`(function(){
  const m = document.querySelector('#mode-select');
  m.value = 'boss'; m.dispatchEvent(new Event('change'));
  const s = document.getElementById('boss-stage');
  if (s) { s.value = '${STAGE}'; s.dispatchEvent(new Event('change')); }
  const ok = document.querySelector('#btn-map-ok'); ok && ok.click();
  return 'stage:' + (s ? s.value : 'none') + ' ok:' + !!ok;
})()`));

await sleep(9000);
await ev('(function(){ const b = window.__game.bossMode; if (b) b.introT = 99; return 1; })()');
await sleep(900);
await ev('(function(){ const b = window.__game.bossMode; if (b) b.countdown = 0.02; return 1; })()');
await sleep(1600);
console.log('phase:', await ev('window.__game.bossMode.phase'));

// 压血到 30%：下一帧过线，必放 phaseBlast
console.log('压血 ->', await ev('(function(){const b=window.__game.bossMode.boss;b.hp=b.maxHp*0.3;return Math.round(b.hp)+"/"+b.maxHp})()'));

await sleep(1500);
console.log('蓄力中', await ev(`(function(){const b=window.__game.bossMode.boss;
  return JSON.stringify({state:b.state, skill:b.telegraph&&b.telegraph.skill?b.telegraph.skill.id:null});})()`));
await shotTo('pb' + STAGE + '_charge.png');

// 轮询到蓄力结束（无头渲染 fps 低，3 秒游戏时间可能要 15~30 秒墙钟）
let st = '';
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  st = await ev('(function(){return window.__game.bossMode.boss.state})()');
  if (st && st !== 'telegraph') break;
}
console.log('蓄力结束 state =', st);
await sleep(200);
console.log('结算后', await ev(`(function(){const bm=window.__game.bossMode;
  return JSON.stringify({transient:(bm.fx&&bm.fx.transient)?bm.fx.transient.length:-1});})()`));
await shotTo('pb' + STAGE + '_blast.png');
console.log('done');

try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
