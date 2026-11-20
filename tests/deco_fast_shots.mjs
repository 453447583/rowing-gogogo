// 快速验收：小分辨率渲染 + 只拍 3 个关键布景（崖壁 / 隧道 / 山体），并打印定位失败原因
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/deco-fast-' + Date.now());
const port = 9400 + Math.floor(Math.random() * 200);
const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=960,540', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

const WANT = [
  { match: '峡谷崖壁', idx: 0, name: 'cliff' },
  { match: '隧道壳', idx: 0, name: 'tunnel' },
  { match: '远景山体', idx: 0, name: 'mountain' },
];

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3000);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(800);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][0]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(800);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='ocean'); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  await sleep(10000);
  // 小分辨率：软件渲染快 10 倍，只需要看清"有没有"
  await cdp('Runtime.evaluate', { expression: `(() => { const g = window.__game; g?.renderer?.setSize?.(720, 405); return true; })()` });
  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});

  for (const w of WANT) {
    const r = await cdp('Runtime.evaluate', {
      expression: `(() => { try {
        const g = window.__game, t = g.track, b = g.localBoat;
        const list = (t.courseProps || []).filter((p) => p.kind === 'deco' && p.label.indexOf(${JSON.stringify(w.match)}) >= 0);
        const p = list[${w.idx}];
        if (!p) return JSON.stringify({ ok: false, why: 'no prop ' + ${JSON.stringify(w.match)} });
        g.phase = 'racing'; g.countdownLeft = 0;
        const dx = Math.sin(p.dir), dz = Math.cos(p.dir);
        b.resetTo(p.x - dx * 42, p.z - dz * 42, Math.atan2(dx, dz));
        b.speed = 0; b.vel.set(0, 0);
        b.heading = Math.atan2(p.x - b.pos.x, p.z - b.pos.z);
        return JSON.stringify({ ok: true, label: p.label, boat: [Math.round(b.pos.x), Math.round(b.pos.z)], deco: [Math.round(p.x), Math.round(p.z)] });
      } catch (e) { return JSON.stringify({ ok: false, why: String((e && e.message) || e) }); } })()`, returnByValue: true,
    });
    const info = JSON.parse(r.result.value || '{}');
    console.log(w.name, JSON.stringify(info));
    await sleep(1200);
    const s = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(`shots/verify/deco-vis-${w.name}.png`, Buffer.from(s.data, 'base64'));
  }
}
main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
