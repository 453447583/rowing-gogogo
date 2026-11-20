// 对照实验：把 fxFireBand 扔到船前方的空地上，三个不同 scale 并排，看清它到底多大、能不能看见
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/probe-fb2');
const port = 9299;
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

// 船头方向（朝 BOSS），在 20~26m 的空地上并排播三个不同 scale
console.log(await ev(`(function(){
  const bm = window.__game.bossMode;
  const boat = bm.localBoat;
  const p = boat.pos;
  const h = boat.heading !== undefined ? boat.heading : 0;
  const fxDir = Math.sin(h), fzDir = Math.cos(h);
  // 垂直方向做并排
  const px = Math.cos(h), pz = -Math.sin(h);
  const D = 24;
  const out = [];
  const scales = [1.7, 3.0, 5.0];
  const offs = [-14, 0, 16];
  for (let i = 0; i < 3; i++) {
    const x = p.x + fxDir * D + px * offs[i];
    const z = p.z + fzDir * D + pz * offs[i];
    bm.fx.play('fxFireBand', x, 4.0, z, scales[i]);
    out.push(scales[i] + '@' + Math.round(x) + ',' + Math.round(z));
  }
  return 'boat ' + Math.round(p.x) + ',' + Math.round(p.z) + ' | ' + out.join(' / ');
})()`));
await sleep(1400);
console.log('transient', await ev('window.__game.bossMode.fx.transient.length'));
await shotTo('fireband_scales.png');
console.log('saved fireband_scales.png');

try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
