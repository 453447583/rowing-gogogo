// 海克斯第 5 头 BOSS 入场页截图（旧版左侧叠层版）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cs-shot-' + Date.now());
const port = 9960 + Math.floor(Math.random() * 30);
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
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 600));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('t'); }
async function waitFor(e, ms = 30000) { const t0 = Date.now(); let l; while (Date.now() - t0 < ms) { l = await ev(e); if (l) return l; await sleep(250); } throw new Error('timeout ' + e + ' last=' + JSON.stringify(l)); }
async function shot(file) {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
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
  let inLobby = false;
  for (let i = 0; i < 12 && !inLobby; i++) { await ev(`document.querySelector('#btn-solo')?.click(); 1`); await sleep(800); inLobby = await ev(`(() => { const l = document.querySelector('#lobby'); return !!l && !l.classList.contains('hidden'); })()`); }
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
  const info = await ev(`(() => {
    const b = window.__game.bossMode;
    return { plan: (b.hexPlan?.stages || []).map((s) => s.bossId), boss: b.bossDef?.id };
  })()`);
  console.log('计划：', JSON.stringify(info));
  // 固定把第 1 层换成第 5 头 BOSS，避免随机计划里没有它；不写回数据表，只改本局计划
  await ev(`(() => {
    const b = window.__game.bossMode;
    if (b.hexPlan?.stages?.[0]) b.hexPlan.stages[0].bossId = 'abyss_herald';
    b.startStage(1, { broadcast: false });
    return 1;
  })()`);
  await sleep(2200);
  // 第一层会自动弹核心三选一，截图前收掉遮罩
  await ev(`document.getElementById('hex-cards')?.classList.add('hidden'); 1`);
  await sleep(350);
  console.log('入场页状态：', JSON.stringify(await ev(`(() => {
    const el = document.getElementById('boss-cutscene');
    const w = document.getElementById('cs-weather');
    const r = el.getBoundingClientRect();
    return { visible: !el.classList.contains('hidden'), boss: window.__game.bossMode.bossDef.id,
      weatherHTML: w.innerHTML.slice(0, 180), weatherText: w.textContent.slice(0, 80),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
  })()`)));
  await shot('shots/verify/hex-cutscene-restored.jpg');

  // 阶段结算 / 终局：保持赛博版（只截图确认没被误改）
  await ev(`(async () => {
    const u = await import('/src/ui/ui.js');
    document.getElementById('boss-cutscene').classList.add('hidden');
    u.showBossStageResult({ stage: 2, layer: true, grade: 'A', elapsed: 75.5,
      damage: [{ name:'ok没问题', dmg:5210, me:true }],
      taken: [{ name:'ok没问题', taken:1280, me:true }],
      takenBy: [{ source:'双拳砸海', dmg:620 }] });
    return 1;
  })()`);
  await sleep(600);
  await shot('shots/verify/hex-stage-result-kept.jpg');
} catch (e) {
  console.error('失败：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
