// 单张特效截图（支持 xs/ys/zs 拉高），用于确认龙卷被纵向拉伸后的形态
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const fx = process.argv[2] || 'ef_wind03';
const q = process.argv[3] || 'scale=1&xs=1.9&ys=2.8&zs=1.9';
const ms = Number(process.argv[4] || 1200);
const dist = Number(process.argv[5] || 14);
const out = process.argv[6] || `shots/vortex_${fx}.png`;

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/shot-one');
const port = 9291;
const sleep = (m) => new Promise((r) => setTimeout(r, m));
let child, ws, seq = 0;
const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const evalV = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true }))?.result?.value;
async function waitJson(url, t = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < t) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); }
  throw new Error('cdp timeout');
}

await fs.mkdir(path.dirname(profile), { recursive: true });
child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=420,320', 'about:blank'], { stdio: 'ignore' });
const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
await cdp('Page.enable'); await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 420, height: 320, deviceScaleFactor: 1, mobile: false });
await cdp('Page.navigate', { url: `http://127.0.0.1:${process.env.FXPORT || 3112}/fx-preview.html?fx=${fx}&${q}&v=${Date.now()}` });
for (let i = 0; i < 60; i++) { await sleep(250); if (await evalV('window.__ready===true') === true) break; }
console.log('ready =', await evalV('window.__ready === true'), '| hud =', JSON.stringify(await evalV('document.getElementById("hud").textContent')));
const r = await evalV(`JSON.stringify(window.__play(${ms}, ${dist}))`);
console.log('measure', r);
await sleep(100);
const rect = await evalV("(()=>{const r=document.getElementById('cv').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()");
const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...rect, scale: 1 } });
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
console.log('saved', out);
try { ws.terminate(); } catch {}
try { child.kill('SIGKILL'); } catch {}
await sleep(300); await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
process.exit(0);
