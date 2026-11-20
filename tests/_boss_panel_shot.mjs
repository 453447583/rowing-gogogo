// 临时：怪物模式 HUD 单张实拍（只拍一张，避免软渲染下 captureScreenshot 挂死）
//   node tests/_boss_panel_shot.mjs   → shots/_tmp/after-boss.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/boss-shot-${stamp}`);
const port = 9720 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const out = process.env.OUT || 'shots/_tmp/after-boss.jpg';
const GPU = process.env.GPU !== '0';

const args = ['--headless=new', '--no-sandbox',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank'];
if (GPU) args.push('--use-angle=d3d11'); else args.push('--disable-gpu');
const child = spawn(edge, args, { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

try {
  let info;
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  if (!info) throw new Error('cdp 没起来');
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await sleep(2000);

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`(() => { const s=document.querySelector('#sel-ai'); if (s) { s.value='1'; if (s.onchange) s.onchange(); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 50000);
  await evaluate(`(() => {
    const g = window.__game;
    if (g.bossMode) for (let i = 0; i < 120; i++) g.bossMode.update(0.2, i * 0.2);
    g.phase = 'racing'; g.countdownLeft = 0;
    return 1;
  })()`);
  await sleep(1500);
  // OLD=1：临时把两块面板打回改动前（细金线 + 近黑内腔），只用于同视口前后对比。
  if (process.env.OLD === '1') {
    await evaluate(`(() => {
      const s = document.createElement('style');
      s.textContent = \`
        #hud.boss-mode #minimap-wrap {
          border: 3px solid #B98A45 !important; border-radius: 8px !important;
          padding: 8px 8px 6px !important;
          box-shadow: inset 0 1px 0 #4A4438, inset 0 -2px 0 #0D0C0A,
            inset 0 0 22px rgba(0,0,0,.5), 0 0 0 1px #0D0C0A, 0 8px 20px rgba(0,0,0,.55) !important;
        }
        #hud.boss-mode #minimap-wrap::before { background-image: none !important; }
        #hud.boss-mode #minimap-wrap::after {
          background:
            radial-gradient(circle 3px at 7px 7px, #E3C07A 0 44%, #6b5227 74%, transparent 78%),
            radial-gradient(circle 3px at calc(100% - 7px) 7px, #E3C07A 0 44%, #6b5227 74%, transparent 78%),
            radial-gradient(circle 3px at 7px calc(100% - 7px), #E3C07A 0 44%, #6b5227 74%, transparent 78%),
            radial-gradient(circle 3px at calc(100% - 7px) calc(100% - 7px), #E3C07A 0 44%, #6b5227 74%, transparent 78%) !important;
        }
        #hud.boss-mode #player-list .pl-self {
          padding: 8px 10px 8px 8px !important; border-radius: 7px !important;
          box-shadow: inset 0 1px 0 #4A4438, inset 0 -2px 0 #0D0C0A,
            inset 0 0 22px rgba(0,0,0,.5), 0 0 0 1px #0D0C0A, 0 8px 20px rgba(0,0,0,.55) !important;
        }\`;
      document.head.appendChild(s);
      return 1;
    })()`);
    await sleep(300);
  }
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88, fromSurface: true }, 45000);
  await fs.writeFile(path.resolve(out), Buffer.from(shot.data, 'base64'));
  console.log('OK', out);
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
