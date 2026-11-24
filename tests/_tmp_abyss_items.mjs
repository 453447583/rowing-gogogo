// 第 5 头 BOSS：逐件道具命中后是否真的吃到伤害 / 控制状态
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/abyss-items-' + Date.now());
const port = 9990 + Math.floor(Math.random() * 30);
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
  if (r?.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || '').slice(0, 500));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('t'); }
async function waitFor(e, ms = 30000, label = e) { const t0 = Date.now(); let l; while (Date.now() - t0 < ms) { l = await ev(e); if (l) return l; await sleep(250); } throw new Error('timeout ' + label + ' last=' + JSON.stringify(l)); }

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
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
  const skip = async () => {
    await ev(`(() => {
      const b=window.__game.bossMode;
      if(b.hexPlan?.stages?.[0]) b.hexPlan.stages[0].bossId='abyss_herald';
      document.getElementById('hex-cards')?.classList.add('hidden');
      b.startStage(1, { broadcast:false });
      b.introT=99;
      return 1;
    })()`);
    await waitFor(`window.__game.bossMode.phase === 'countdown'`, 30000);
    await ev(`window.__game.bossMode.countdown = 0.02; 1`);
    await waitFor(`window.__game.bossMode.phase === 'fight'`, 30000);
  };
  await skip();
  console.log('BOSS：', await ev(`window.__game.bossMode.bossDef.id`));

  const cases = [
    ['missile', 'slow'], ['bomb', 'dive'], ['vortex', 'bubble'], ['ink', 'silence'],
    ['icecage', 'root'], ['weakspot', 'vulnerable'], ['harpoon', 'vulnerable'],
    ['thunderrod', 'silence'], ['fish', null], ['barrage', null],
  ];
  for (const [item, key] of cases) {
    await waitFor(`window.__game.bossMode.projectiles.length === 0`, 20000, item + ' 前置清弹');
    const before = await ev(`window.__game.bossMode.totalDamage`);
    await ev(`(() => {
      const b = window.__game.bossMode;
      const me = b.players.get(b.myId);
      me.boat.pos.x = b.boss.pos.x + 14; me.boat.pos.z = b.boss.pos.z;
      me.boat.vel.x = 0; me.boat.vel.y = 0;
      for (const k of Object.keys(b.bossStatus)) b.bossStatus[k] = 0;
      b.myItems[0] = ${JSON.stringify(item)};
      b.input.onItem(0);
      return 1;
    })()`);
    await waitFor(`window.__game.bossMode.projectiles.length === 0`, 20000, item + ' 命中');
    await sleep(300);
    const r = await ev(`(() => {
      const b = window.__game.bossMode;
      const s = {};
      for (const [k, v] of Object.entries(b.bossStatus)) if (v > 0.05) s[k] = +v.toFixed(2);
      return { dmg: Math.round(b.totalDamage), status: s };
    })()`);
    const delta = r.dmg - Math.round(before);
    const ok = !key || (r.status[key] || 0) > 0;
    console.log(`${ok && delta > 0 ? 'PASS' : 'CHECK'} ${item}: dmg=${delta} status=${JSON.stringify(r.status)}`);
  }
} catch (e) {
  console.error('失败：', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
