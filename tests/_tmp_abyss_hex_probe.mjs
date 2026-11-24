// 海克斯模式下第 5 关 BOSS 的道具/受击/音效探针
//   node tests/_tmp_abyss_hex_probe.mjs        （需 dev server 5199）
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/abyss-hex-' + Date.now());
const port = 9860 + Math.floor(Math.random() * 40);
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

  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('[data-mode="boss"][data-variant="hex"]')`, 20000, 'hex card');
  await ev(`document.querySelector('[data-mode="boss"][data-variant="hex"]').click(); 1`);
  await sleep(300);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);

  let booted = false;
  for (let a = 0; a < 4 && !booted; a++) {
    await ev(`document.querySelector('#btn-start-race')?.click(); 1`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      if (await ev(`!!window.__game?.bossMode`)) { booted = true; break; }
      await sleep(400);
    }
  }
  if (!booted) throw new Error('海克斯没起来');

  const skipIntro = async () => {
    await ev(`window.__game.bossMode.introT = 99; 1`);
    await waitFor(`window.__game.bossMode.phase === 'countdown'`, 30000, 'countdown');
    await ev(`window.__game.bossMode.countdown = 0.02; 1`);
    await waitFor(`window.__game.bossMode.phase === 'fight'`, 30000, 'fight');
  };
  await skipIntro();
  await sleep(1200);

  console.log('海克斯计划：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    return { variant: b.variant, stage: b.stage, boss: b.bossDef?.id, originStage: b.hexEntry?.originStage,
      plan: (b.hexPlan?.stages || []).map((s) => s.bossId), phase: b.phase };
  })()`)));

  // 强制换到第 5 层
  await ev(`window.__game.bossMode.startStage(5, { broadcast: false }); 1`);
  await skipIntro();
  await sleep(1200);
  console.log('第 5 层：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    return { stage: b.stage, boss: b.bossDef?.id, height: b.boss?.def?.height,
      hp: Math.round(b.boss?.hp), hexEntry: b.hexEntry?.originStage, phase: b.phase };
  })()`)));

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

  // 被动观察 30 秒：BOSS 自己会不会出招 / 有没有出声音
  await ev(`(async () => {
    const b = window.__game.bossMode;
    window.__sfx.length = 0;
    window.__casts = 0;
    if (b.boss && !b.boss.__wrappedWarn) {
      const ow = b.boss.showWarning.bind(b.boss);
      b.boss.showWarning = (...a) => { window.__casts += 1; return ow(...a); };
      b.boss.__wrappedWarn = true;
    }
    return 1;
  })()`);
  await sleep(30000);
  console.log('被动 30s：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    const counts = {};
    for (const n of window.__sfx) counts[n] = (counts[n] || 0) + 1;
    return { casts: window.__casts, sfx: counts, phase: b.phase,
      hp: Math.round(b.players.get(b.myId)?.hp || 0), bossHp: Math.round(b.boss?.hp || 0) };
  })()`)));

  // 漩涡
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
  await sleep(700);
  console.log('漩涡后：', JSON.stringify(await ev(`(() => {
    const b = window.__game.bossMode;
    return { sfx: (window.__sfx || []).slice(), bubble: (b.bossStatus.bubble || 0).toFixed(2),
      bossBubble: (b.boss?.status?.bubble || 0).toFixed(2), liftY: (b.boss?.liftY || 0).toFixed(2),
      wrap: !!b.boss?.bubbleWrap?.visible };
  })()`)));

  // 逐个技能，采样 4 秒内的最大受击状态
  for (const id of ['abyssSlam', 'abyssSweep', 'abyssRoar', 'abyssCharge', 'abyssSpikes', 'abyssSword']) {
    await ev(`(() => {
      const b = window.__game.bossMode;
      const me = b.players.get(b.myId);
      const h = b.boss.heading;
      me.boat.pos.x = b.boss.pos.x + Math.sin(h) * 8;
      me.boat.pos.z = b.boss.pos.z + Math.cos(h) * 8;
      me.hp = 100; me.invuln = 0;
      me.boat.stunTimer = 0; me.boat.stunStarsTimer = 0; me.boat.spinTimer = 0;
      me.boat.geyserLiftTimer = 0; me.boat.bubbleLiftTimer = 0;
      window.__sfx.length = 0;
      window.__peak = { stun: 0, stars: 0, spin: 0, geyser: 0, bubble: 0, dmg: 0, src: '' };
      window.__peakTimer = setInterval(() => {
        const p = window.__peak;
        p.stun = Math.max(p.stun, me.boat.stunTimer || 0);
        p.stars = Math.max(p.stars, me.boat.stunStarsTimer || 0);
        p.spin = Math.max(p.spin, me.boat.spinTimer || 0);
        p.geyser = Math.max(p.geyser, me.boat.geyserLiftTimer || 0);
        p.bubble = Math.max(p.bubble, me.boat.bubbleLiftTimer || 0);
        if (me.lastHit && me.lastHit.source !== p.src) { p.src = me.lastHit.source; p.dmg = me.lastHit.dmg; }
      }, 80);
      b.boss.showWarning(${JSON.stringify(id)}, me.boat.pos.x, me.boat.pos.z, h, 0.35);
      return 1;
    })()`);
    await sleep(4200);
    console.log(`技能 ${id}：`, JSON.stringify(await ev(`(() => {
      clearInterval(window.__peakTimer);
      return { peak: window.__peak, sfx: (window.__sfx || []).slice() };
    })()`)));
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
