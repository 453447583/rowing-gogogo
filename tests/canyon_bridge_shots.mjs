// 立交桥外观验收：从坡道下方接近、桥上、桥下各拍一张
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/bridge-shots-' + Date.now());
const port = 9600 + Math.floor(Math.random() * 200);
const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1000,560', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(3000);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(700);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][0]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(700);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='ocean'); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  // 新版流程多了一步「比赛大厅」：点开始比赛
  await sleep(1500);
  await cdp('Runtime.evaluate', { expression: `(() => { const b=document.querySelector('#btn-start-race'); if (b && !b.classList.contains('hidden')) b.click(); })()` });
  for (let i = 0; i < 40; i++) {
    const r = await cdp('Runtime.evaluate', { expression: '!!(window.__game && window.__game.track && window.__game.track.gates)', returnByValue: true });
    if (r.result.value) break;
    await sleep(1000);
  }
  await cdp('Runtime.evaluate', { expression: `(() => { window.__game?.renderer?.setSize?.(960, 540); return true; })()` });
  await sleep(1500);

  const put = async (gate, back, name) => {
    await cdp('Runtime.evaluate', {
      expression: `(() => {
        const g = window.__game, t = g.track, b = g.localBoat;
        g.phase = 'racing'; g.countdownLeft = 0;
        const a = t.gates[${gate}], c = t.gates[(${gate} + 1) % t.gates.length];
        const dx = c[0]-a[0], dz = c[1]-a[1], L = Math.hypot(dx,dz)||1;
        b.resetTo(a[0] - dx/L*${back}, a[1] - dz/L*${back}, Math.atan2(dx, dz));
        const pm = g.progressMap.get(g.myId); if (pm) pm.gate = ${gate};
        return true;
      })()`,
    });
    await sleep(1600);
    const s = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.mkdir('shots/verify', { recursive: true });
    await fs.writeFile(`shots/verify/bridge-${name}.png`, Buffer.from(s.data, 'base64'));
    console.log('saved', `shots/verify/bridge-${name}.png`);
  };

  await put(25, 55, 'approach');  // 坡道前
  await put(26, 8, 'ramp');       // 坡道上
  await put(27, 0, 'deck');       // 桥面
}
main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
