// 落日霓虹阶段结算 / 无尽选择面板截图验收（1280×720、真实场景与 HUD）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/neon-shot-' + Date.now());
const port = 9990 + Math.floor(Math.random() * 9);
const base = 'http://localhost:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 700));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('t'); }
async function waitFor(e, ms = 30000) { const t0 = Date.now(); let l; while (Date.now() - t0 < ms) { l = await ev(e); if (l) return l; await sleep(250); } throw new Error('timeout ' + e + ' last=' + JSON.stringify(l)); }
async function shot(file) {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 94 });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  console.log('→', file);
}

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  for (let i = 0; i < 12; i++) { await ev(`document.querySelector('#btn-solo')?.click(); 1`); await sleep(700); if (await ev(`!!document.querySelector('#lobby') && !document.querySelector('#lobby').classList.contains('hidden')`)) break; }
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('[data-mode="boss"][data-variant="hex"]')`, 20000);
  await ev(`document.querySelector('[data-mode="boss"][data-variant="hex"]').click(); 1`);
  await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  for (let a = 0; a < 4; a++) {
    await ev(`document.querySelector('#btn-start-race')?.click(); 1`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) { if (await ev(`!!window.__game?.bossMode`)) break; await sleep(400); }
    if (await ev(`!!window.__game?.bossMode`)) break;
  }
  await waitFor(`!!window.__game?.bossMode`, 60000);
  await ev(`(() => { document.getElementById('hex-cards')?.classList.add('hidden'); return 1; })()`);
  await sleep(500);
  await shot('shots/verify/neon-baseline.jpg');

  // 真实文字与数据（提示词里锁定的文案），只灌 DOM，不改源码数据表
  await ev(`(async () => {
    const u = await import('/src/ui/ui.js');
    document.getElementById('boss-cutscene')?.classList.add('hidden');
    u.showBossStageResult({ stage: 2, layer: true, grade: 'A', elapsed: 75.5,
      damage: [{ name:'ok没问题', dmg:5210, me:true }],
      taken: [{ name:'ok没问题', taken:1280, me:true }],
      takenBy: [{ source:'双拳磋海', dmg:620 }] });
    return 1;
  })()`);
  await sleep(700);
  console.log('阶段结算：', JSON.stringify(await ev(`(() => {
    const el = document.getElementById('boss-result');
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { hidden: el.classList.contains('hidden'),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      shadow: cs.boxShadow, pointer: cs.pointerEvents,
      title: document.getElementById('br-head').textContent,
      stats: document.getElementById('br-stats').textContent,
      src: document.getElementById('br-src').textContent,
      grade: document.getElementById('br-grade').textContent,
      tables: [...el.querySelectorAll('.be-table h4')].map((x) => x.textContent),
      cells: [...el.querySelectorAll('.sn-tables td')].map((x) => x.textContent),
      cellWidths: [...el.querySelectorAll('.sn-tables tr:nth-child(1) td')].map((x) => [x.getBoundingClientRect().width, x.scrollWidth]),
      srcBox: (() => { const r = document.querySelector('.sn-src').getBoundingClientRect(); return [Math.round(r.y), Math.round(r.bottom)]; })(),
      titleFont: getComputedStyle(document.querySelector('.sn-title')).fontSize };
  })()`)));
  await shot('shots/verify/neon-stage-result.jpg');

  await ev(`(async () => {
    const u = await import('/src/ui/ui.js');
    u.showBossStageResult(null);
    u.showHexEndless({ stage: 4, nextStage: 5, allowPick: true,
      preview: { bossName:'深渊传令官', bossIcon:'hex/abyssHerald.png', variant:null,
        arena:{ name:'固定战场', icon:'hex/starCompass.png' },
        weather:{ name:'黄昏海面', icon:'hex/weatherDusk.png' },
        relic:{ name:'深渊罗盘', icon:'hex/relicHourglass.png' },
        rules:[{ name:'怒涛', icon:'hex/stormConductor.png' }] } });
    return 1;
  })()`);
  await sleep(700);
  console.log('无尽选择：', JSON.stringify(await ev(`(() => {
    const el = document.getElementById('hex-endless');
    const r = el.getBoundingClientRect();
    return { hidden: el.classList.contains('hidden'),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      head: el.querySelector('.he-head').textContent,
      headStyle: (() => { const s = getComputedStyle(el.querySelector('.he-head')); return { color: s.color, fill: s.webkitTextFillColor, bg: s.backgroundImage.slice(0, 70), clip: s.webkitBackgroundClip }; })(),
      sub: el.querySelector('.he-sub').textContent.slice(0, 40),
      buttons: [...el.querySelectorAll('.he-actions button')].map((b) => b.textContent.trim()) };
  })()`)));
  await shot('shots/verify/neon-endless.jpg');
} catch (e) {
  console.error('失败：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
