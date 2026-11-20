// 立交桥验收：高度剖面 / 上下层高度分离 / 桥下净空 / 实拍
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/overpass-' + Date.now());
const port = 9500 + Math.floor(Math.random() * 200);
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

const evalJson = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
  try { return JSON.parse(r.result.value); } catch { return { raw: r.result.value }; }
};

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
  // 等赛道真正建好（现在布景 GLB 有 30MB，软件渲染下加载更慢）
  for (let i = 0; i < 40; i++) {
    const r = await cdp('Runtime.evaluate', { expression: '!!(window.__game && window.__game.track && window.__game.track.gates)', returnByValue: true });
    if (r.result.value) break;
    await sleep(1000);
  }
  await sleep(2500);
  await cdp('Runtime.evaluate', { expression: `(() => { window.__game?.renderer?.setSize?.(960, 540); return true; })()` });

  const info = await evalJson(`(() => {
    const g = window.__game, t = g.track;
    return JSON.stringify({
      overpass: t.overpass,
      gateY: Array.from(t.gateY).map((v) => +v.toFixed(2)),
      info: t.overpassInfo || null,
      gates: t.gates.length,
    });
  })()`);
  console.log('gateY:', JSON.stringify(info.gateY));
  console.log('overpassInfo:', JSON.stringify(info.info));

  // 上层：把船放到 gate 27 正上方的桥面，gate 编号也设为 27
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game, t = g.track, b = g.localBoat;
      g.phase = 'racing'; g.countdownLeft = 0;
      const p = t.gates[27];
      b.resetTo(p[0], p[1], 0);
      const pm = g.progressMap.get(g.myId); if (pm) pm.gate = 27;
      return true;
    })()`,
  });
  await sleep(1500);
  const upper = await evalJson(`(() => { const g = window.__game, t = g.track, b = g.localBoat; const pm = g.progressMap.get(g.myId); return JSON.stringify({ mapId: g.mapDef && g.mapDef.id, weather: g.weather && g.weather.id, mapId: g.mapDef && g.mapDef.id, weather: g.weather && g.weather.id, myId: g.myId, hasPm: !!pm, gate: pm && pm.gate, y: +b.pos.y.toFixed(2), target: b.diveTargetY, deck27obj: t.diveHeightAt({x:t.gates[27][0], z:t.gates[27][1]}, 27), deckBoat: t.diveHeightAt(b.pos, 28), hasOp: !!t.overpass, divesLen: t.dives.length, gy27: t.gateY[27], posAtGate: [Math.round(b.pos.x), Math.round(b.pos.z)], gate27: t.gates[27] }); })()`);
  console.log('桥上 y:', JSON.stringify(upper));
  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});
  { const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('shots/verify/overpass-on.png', Buffer.from(shot.data, 'base64'));
    console.log('saved shots/verify/overpass-on.png'); }
  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});
  { const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('shots/verify/overpass-on.png', Buffer.from(shot.data, 'base64'));
    console.log('saved shots/verify/overpass-on.png'); }

  // 下层：同一片水面的交叉点附近，但进度是 gate 22
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game, t = g.track, b = g.localBoat;
      const a = t.gates[22], c = t.gates[23];
      b.resetTo(a[0] + (c[0]-a[0])*0.28, a[1] + (c[1]-a[1])*0.28, Math.atan2(c[0]-a[0], c[1]-a[1]));
      const pm = g.progressMap.get(g.myId); if (pm) pm.gate = 22;
      return true;
    })()`,
  });
  await sleep(1500);
  const lower = await evalJson(`(() => { const g = window.__game; return JSON.stringify({ y: +g.localBoat.pos.y.toFixed(2), target: g.localBoat.diveTargetY }); })()`);
  console.log('桥下 y:', JSON.stringify(lower));

  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});
  let s = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile('shots/verify/overpass-under.png', Buffer.from(s.data, 'base64'));
  console.log('saved shots/verify/overpass-under.png');
}
main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
