// 第 5 关（深渊传令官）在海克斯里的道具/受击/音效探针
//   node tests/_tmp_abyss_probe.mjs        （需 dev server 5199）
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/abyss-' + Date.now());
const port = 9820 + Math.floor(Math.random() * 40);
const base = 'http://127.0.0.1:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const errors = [];
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 800));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* ignore */ }
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}
async function waitFor(expr, ms = 25000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) {
    last = await ev(expr);
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout: ' + label + ' last=' + JSON.stringify(last));
}

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '';
      errors.push(d.split('\n').slice(0, 2).join(' | '));
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000, 'btn-solo');
  let inLobby = false;
  for (let i = 0; i < 12 && !inLobby; i++) {
    await ev(`document.querySelector('#btn-solo')?.click(); 1`);
    await sleep(800);
    inLobby = await ev(`(() => { const l = document.querySelector('#lobby'); return !!l && !l.classList.contains('hidden'); })()`);
  }
  if (!inLobby) throw new Error('进不去大厅');

  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('[data-boat]')`, 30000, 'boat grid');
  await ev(`document.querySelector('[data-boat]').click(); 1`);
  await sleep(250);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('[data-mode="boss"]')`, 20000, 'mode pills');
  await ev(`document.querySelector('[data-mode="boss"]').click(); 1`);
  await sleep(250);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(250);

  let booted = false;
  for (let a = 0; a < 4 && !booted; a++) {
    await ev(`document.querySelector('#btn-start-race')?.click(); 1`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (await ev(`!!window.__game?.bossMode`)) { booted = true; break; }
      await sleep(400);
    }
  }
  if (!booted) throw new Error('怪物模式没起来');

  const skipIntro = async () => {
    await ev(`window.__game.bossMode.introT = 99; 1`);
    await waitFor(`window.__game.bossMode.phase === 'countdown'`, 30000, 'countdown');
    await ev(`window.__game.bossMode.countdown = 0.02; 1`);
    await waitFor(`window.__game.bossMode.phase === 'fight'`, 30000, 'fight');
  };
  await skipIntro();

  // 切到第 5 关
  await ev(`window.__game.bossMode.startStage(5, { broadcast: false }); 1`);
  await skipIntro();
  await sleep(600);
  console.log('关卡特写：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    return { stage: b.stage, boss: b.bossDef?.id, height: b.boss?.def?.height, radius: b.boss?.def?.radius,
      hp: Math.round(b.boss?.hp), airborne: b.boss?.airborne, phase: b.phase };
  })()`)));

  // 音效监听
  await ev(`(() => {
    window.__sfx = [];
    const a = window.__audio;
    if (!a.__wrapped) {
      const orig = a.play.bind(a);
      a.play = (n, o) => { window.__sfx.push(n); return orig(n, o); };
      a.__wrapped = true;
    }
    return 1;
  })()`);

  const readState = () => ev(`(() => {
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    return {
      sfx: (window.__sfx || []).slice(),
      bubbleStatus: Number((b.bossStatus.bubble || 0).toFixed(2)),
      bossBubble: Number((b.boss?.status?.bubble || 0).toFixed(2)),
      liftY: Number((b.boss?.liftY || 0).toFixed(2)),
      wrapVisible: !!b.boss?.bubbleWrap?.visible,
      stun: Number((me?.boat?.stunTimer || 0).toFixed(2)),
      stars: Number((me?.boat?.stunStarsTimer || 0).toFixed(2)),
      spin: Number((me?.boat?.spinTimer || 0).toFixed(2)),
      geyser: Number((me?.boat?.geyserLiftTimer || 0).toFixed(2)),
      hp: Math.round(me?.hp || 0),
      lastHit: me?.lastHit || null,
      errors: 0,
    };
  })()`);

  // ① 漩涡道具
  await ev(`(() => {
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.boat.pos.x = b.boss.pos.x + 12; me.boat.pos.z = b.boss.pos.z;
    window.__sfx.length = 0;
    b.myItems[0] = 'vortex';
    b.input.onItem(0);
    return 1;
  })()`);
  await waitFor(`window.__game.bossMode.projectiles.length === 0`, 20000, 'vortex 命中');
  await sleep(500);
  console.log('① 漩涡后：', JSON.stringify(await readState()));

  // ② 逐个技能：砸海 / 横扫 / 咆哮 / 冲锋 / 影刺 / 圣剑
  for (const id of ['abyssSlam', 'abyssSweep', 'abyssRoar', 'abyssCharge', 'abyssSpikes', 'abyssSword']) {
    await ev(`(() => {
      const b = window.__game.bossMode;
      const me = b.players.get(b.myId);
      // 站在 BOSS 正前方 8m，保证扇形/环形都能命中
      const h = b.boss.heading;
      me.boat.pos.x = b.boss.pos.x + Math.sin(h) * 8;
      me.boat.pos.z = b.boss.pos.z + Math.cos(h) * 8;
      me.hp = 100; me.invuln = 0;
      me.boat.stunTimer = 0; me.boat.stunStarsTimer = 0; me.boat.spinTimer = 0;
      me.boat.geyserLiftTimer = 0; me.boat.bubbleLiftTimer = 0;
      window.__sfx.length = 0;
      b.boss.showWarning(${JSON.stringify(id)}, me.boat.pos.x, me.boat.pos.z, h, 0.35);
      return 1;
    })()`);
    await sleep(2600);
    console.log(`② ${id}：`, JSON.stringify(await readState()));
  }

  console.log('页面异常：', errors.slice(0, 6));
} catch (e) {
  console.error('探针失败：', e.message);
  console.error('页面异常：', errors.slice(0, 6));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}
