// 给每个 deco 布景拍一张"贴脸照"，用来肉眼验收资产是不是真的出现了
// 用法: node tests/canyon_deco_shots.mjs [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/deco-shots-' + Date.now());
const port = 9300 + Math.floor(Math.random() * 300);
const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,720', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  const tab = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3000);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(600);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][0]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(600);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='ocean'); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  await sleep(12000);

  const labels = await cdp('Runtime.evaluate', {
    expression: `JSON.stringify((window.__game?.track?.courseProps || []).filter(p => p.kind === 'deco').map((p, i) => i))`,
    returnByValue: true,
  });
  const n = JSON.parse(labels.result.value || '[]').length;
  console.log('deco 数量:', n);
  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});

  for (let i = 0; i < n; i++) {
    const moved = await cdp('Runtime.evaluate', {
      expression: `(() => { try {
        const g = window.__game, t = g.track;
        const list = (t.courseProps || []).filter(p => p.kind === 'deco');
        const p = list[${i}];
        if (!p || !g.localBoat) return JSON.stringify({ ok: false, why: 'no prop/boat' });
        g.phase = 'racing'; g.countdownLeft = 0;
        const dx = Math.sin(p.dir), dz = Math.cos(p.dir);
        // resetTo 会把船吸附回航道中线，所以落点之后要重新"转头看资产"，
        // 否则侧向布景（崖壁/山体）永远在画面外
        g.localBoat.resetTo(p.x - dx * 45, p.z - dz * 45, Math.atan2(dx, dz));
        g.localBoat.speed = 0; g.localBoat.vel.set(0, 0);
        const b = g.localBoat;
        b.heading = Math.atan2(p.x - b.pos.x, p.z - b.pos.z);
        return JSON.stringify({ ok: true, label: p.label, boat: [Math.round(b.pos.x), Math.round(b.pos.z)], deco: [Math.round(p.x), Math.round(p.z)] });
      } catch (err) { return JSON.stringify({ ok: false, why: String(err && err.message || err) }); } })()`, returnByValue: true,
    });
    const info = JSON.parse(moved.result.value || '{}');
    await sleep(1800);
    const s = await cdp('Page.captureScreenshot', { format: 'png' });
    const file = `shots/verify/canyon-deco-${i}-${(info.label || 'x')}.png`;
    await fs.writeFile(file, Buffer.from(s.data, 'base64'));
    console.log('saved', file, info.ok ? '' : '(定位失败)');
  }
}
main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
