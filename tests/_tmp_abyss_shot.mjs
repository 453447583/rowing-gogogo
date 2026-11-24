// 第 5 关 BOSS 泡泡包裹视觉探针（截图 + 包围盒）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/abyss-shot-' + Date.now());
const port = 9900 + Math.floor(Math.random() * 40);
const base = 'http://127.0.0.1:5199/';
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
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 500));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); }
  throw new Error('timeout ' + u);
}
async function waitFor(e, ms = 25000, label = e) {
  const t0 = Date.now(); let l;
  while (Date.now() - t0 < ms) { l = await ev(e); if (l) return l; await sleep(250); }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(l));
}
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
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000, 'btn');
  let inLobby = false;
  for (let i = 0; i < 12 && !inLobby; i++) {
    await ev(`document.querySelector('#btn-solo')?.click(); 1`); await sleep(800);
    inLobby = await ev(`(() => { const l = document.querySelector('#lobby'); return !!l && !l.classList.contains('hidden'); })()`);
  }
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('[data-mode="boss"][data-variant="hex"]')`, 20000, 'hex card');
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
  await waitFor(`!!window.__game?.bossMode`, 60000, 'bossMode');
  await ev(`window.__game.bossMode.introT = 99; 1`);
  await waitFor(`window.__game.bossMode.phase === 'countdown'`, 30000, 'cd');
  await ev(`window.__game.bossMode.countdown = 0.02; 1`);
  await waitFor(`window.__game.bossMode.phase === 'fight'`, 30000, 'fight');
  const planInfo = await ev(`(() => {
    const b = window.__game.bossMode;
    return { plan: (b.hexPlan?.stages || []).map((s) => s.bossId), stage: b.stage };
  })()`);
  console.log('计划：', JSON.stringify(planInfo));
  // 固定把第 1 层换成第 5 头 BOSS，保证截图一定是深渊传令官
  await ev(`(() => {
    const b = window.__game.bossMode;
    if (b.hexPlan?.stages?.[0]) b.hexPlan.stages[0].bossId = 'abyss_herald';
    b.startStage(1, { broadcast: false });
    return 1;
  })()`);
  await sleep(300);
  await ev(`document.getElementById('hex-cards')?.classList.add('hidden'); 1`);
  await ev(`window.__game.bossMode.introT = 99; 1`);
  await waitFor(`window.__game.bossMode.phase === 'countdown'`, 30000, 'cd2');
  await ev(`window.__game.bossMode.countdown = 0.02; 1`);
  await waitFor(`window.__game.bossMode.phase === 'fight'`, 30000, 'fight2');
  console.log('当前 BOSS：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    return { id: b.bossDef.id, stage: b.stage, h: b.boss.def.height };
  })()`)));
  await sleep(1200);

  console.log('包围盒：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    const THREE = b.boss?.group?.constructor ? null : null;
    const box = new (window.__game.constructor.THREE || Object)();
    return 'skip';
  })()`)));

  // 用 three 的 Box3 量模型实际尺寸（从 boss.model 往上找）
  console.log('尺寸：', JSON.stringify(await ev(`(async () => {
    const b = window.__game.bossMode;
    const mod = await import('/node_modules/three/build/three.module.js');
    const box = new mod.Box3().setFromObject(b.boss.model || b.boss.group);
    const size = box.getSize(new mod.Vector3());
    const bb = b.boss.bubbleWrap;
    let br = null;
    if (bb) { const bg = new mod.Box3().setFromObject(bb); const bs = bg.getSize(new mod.Vector3()); br = +bs.x.toFixed(2); }
    return { modelH: +size.y.toFixed(2), modelW: +size.x.toFixed(2), modelD: +size.z.toFixed(2),
      defH: b.boss.def.height, defR: b.boss.def.radius, bubbleDia: br };
  })()`)));

  // 强制浮空：保持 fight（状态同步只在 fight 跑），把船移到 BOSS 正前方让追尾镜头对着它
  await ev(`(() => {
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    b.bossStatus.bubble = 9; b.bossStatus.root = 9;
    const h = b.boss.heading;
    me.boat.pos.x = b.boss.pos.x + Math.sin(h) * 26;
    me.boat.pos.z = b.boss.pos.z + Math.cos(h) * 26;
    b.boss.pos.x += 0; b.boss.heading = h;
    me.boat.heading = Math.atan2(b.boss.pos.x - me.boat.pos.x, b.boss.pos.z - me.boat.pos.z);
    return 1;
  })()`);
  await sleep(1800);
  await shot('shots/verify/abyss-bubble.jpg');
  console.log('状态：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    return { liftY: +(b.boss.liftY || 0).toFixed(2), wrap: !!b.boss.bubbleWrap?.visible,
      bubble: +(b.boss.status.bubble || 0).toFixed(2), phase: b.phase };
  })()`)));

  // 对照：无泡泡
  await ev(`(() => { const b = window.__game.bossMode; b.bossStatus.bubble = 0; return 1; })()`);
  await sleep(1500);
  await shot('shots/verify/abyss-nobubble.jpg');
} catch (e) {
  console.error('失败：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
