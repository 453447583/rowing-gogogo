// 诊断：fxFireBand 到底有没有加载成功、单独手播能不能看见
// 顺便把场上所有 effekseer handle 和 three.js 的爆点都列出来，看谁在抢画面
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/probe-fb');
const port = 9297;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const outDir = path.resolve('shots/verify');

let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200);
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
    console.log('PAGE EXC:', (m.params.exceptionDetails.exception?.description || '').slice(0, 220));
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
await ev(`(function(){const m=document.querySelector('#mode-select');m.value='boss';m.dispatchEvent(new Event('change'));document.querySelector('#btn-map-ok').click();})()`);
await sleep(9000);
await ev('(function(){const b=window.__game.bossMode;if(b)b.introT=99;})()');
await sleep(900);
await ev('(function(){const b=window.__game.bossMode;if(b)b.countdown=0.02;})()');
await sleep(1600);
console.log('phase:', await ev('window.__game.bossMode.phase'));

// ① FX_DEFS 里加载了什么
console.log('\n[1] fx.effects 里的键:');
console.log(await ev(`(function(){
  const fx = window.__game.bossMode.fx;
  if (!fx) return 'no fx';
  const keys = Object.keys(fx.effects || {});
  return JSON.stringify({
    total: keys.length,
    failedFlag: fx.failed,
    hasFireBand: keys.includes('fxFireBand'),
    fireBandLoaded: !!fx.effects['fxFireBand'],
    fireFxKeys: keys.filter(k => /fire|Fire/.test(k)),
  });
})()`));

// ② 单机手播一个，看看能不能渲染
console.log('\n[2] 手动在船前 14m 播一个 fxFireBand（scale 2.5）:');
console.log(await ev(`(function(){
  const bm = window.__game.bossMode;
  const p = bm.localBoat ? bm.localBoat.pos : {x:0,z:0};
  bm.fx.play('fxFireBand', p.x, 3.0, p.z - 14, 2.5);
  return 'played at ' + Math.round(p.x) + ',' + Math.round(p.z - 14);
})()`));
await sleep(1200);
console.log('transient:', await ev('window.__game.bossMode.fx.transient.length'));
await shotTo('fireband_manual.png');

// ③ 看 three.js 那边在画什么（结算时抢画面的元凶）
console.log('\n[3] SkillFx 里活着的粒子数 / 场景里的大圈:');
console.log(await ev(`(function(){
  const bm = window.__game.bossMode;
  const sfx = bm.skillFx;
  let meshes = 0;
  bm.scene.traverse(o => { if (o.isMesh && o.visible) meshes++; });
  return JSON.stringify({
    skillFxParticles: sfx && sfx.particles ? sfx.particles.length : (sfx && sfx.p ? sfx.p.length : 'n/a'),
    sceneMeshes: meshes,
  });
})()`));

try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
