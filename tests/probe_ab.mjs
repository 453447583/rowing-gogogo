// A/B 对照：同一机位，先截一张空画面，再往 BOSS 脚下塞 8 个超大 fxFireBand，再截一张。
// 两张图放一起看，能确定"到底有没有画到屏幕上"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/probe-ab');
const port = 9301;
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
  const buf = Buffer.from(s.data, 'base64');
  await fs.writeFile(path.join(outDir, name), buf);
  return buf.length;
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
    console.log('PAGE EXC:', (m.params.exceptionDetails.exception?.description || '').slice(0, 240));
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
await sleep(1800);

// 锁住 BOSS 不乱放技能，机位稳定
await ev('(function(){const bm=window.__game.bossMode;if(bm.boss){bm.boss.phaseLock=999;bm.boss.cooldowns=Object.fromEntries(Object.keys(bm.boss.cooldowns||{}).map(k=>[k,999]));}})()');
await sleep(600);

const sizeA = await shotTo('ab_before.png');
console.log('A 空画面已存', sizeA, 'bytes');

console.log(await ev(`(function(){
  const bm = window.__game.bossMode;
  const b = bm.boss.pos;
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = b.x + Math.cos(a) * 9;
    const z = b.z + Math.sin(a) * 9;
    bm.fx.play('fxFireBand', x, 4, z, 8.0);
    out.push(1);
  }
  return 'played ' + out.length + ' at radius 9 around boss ' + Math.round(b.x) + ',' + Math.round(b.z);
})()`));
await sleep(1500);
console.log('transient', await ev('window.__game.bossMode.fx.transient.length'));
const sizeB = await shotTo('ab_after.png');
console.log('B 放火后已存', sizeB, 'bytes');
console.log('字节差', sizeB - sizeA);

try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
