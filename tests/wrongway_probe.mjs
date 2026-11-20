// 逆行误判探针：开局后逐帧采样 wrongWay 判定与几何依据
//   node tests/wrongway_probe.mjs [url] [mapId...]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5199/';
const maps = process.argv.slice(3);
const targets = maps.length ? maps : ['strait', 'baked', 'canyon'];
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/ww-' + Date.now());
const port = 9500 + Math.floor(Math.random() * 90);

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=960,600', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 120000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, label, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
};

try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2200);

  for (const mapId of targets) {
    // 进单人选艇屏
    await waitFor(`!!document.querySelector('#btn-solo')`, '主菜单');
    for (let i = 0; i < 10; i++) {
      await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
      await sleep(700);
      if (await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false)) break;
    }
    await ev(`(() => {
      const c = [...document.querySelectorAll('#map-list .map-card')].find(x => x.dataset.mapId === '${mapId}');
      c && c.click(); return !!c;
    })()`);
    await sleep(500);
    if (process.env.AI) {
      // 单人陪练 AI 数（>0 时发车位会横向拉开，模拟联机多船出生）
      await ev(`(() => { const s = document.querySelector('#solo-ai'); if (s) s.value = '${process.env.AI}'; return s ? s.value : null; })()`);
    }
    await ev(`document.querySelector('#btn-map-ok')?.click()`);
    await waitFor(`!!window.__game && window.__game.phase`, '开赛 ' + mapId, 200);
    // 软件光栅只有 1~3fps，倒计时会拖到几十秒：先把画布缩到 320×200 提帧率
    await ev(`(() => { try { window.__game.renderer.setSize(320, 200, false); } catch {} return true; })()`);
    await sleep(800);

    const info = await ev(`(() => {
      const g = window.__game;
      const b = g.localBoat;
      const pm = g.progressMap.get(g.myId);
      const T = g.track;
      const N = T.gates.length;
      const at = (i) => {
        const [gx, gz] = T.gates[i];
        const dx = gx - b.pos.x, dz = gz - b.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
        return { i, dist: +len.toFixed(1), dot: +(((fx * dx + fz * dz) / len).toFixed(3)) };
      };
      const sp = T.spawnTransform(0, 1);
      return {
        map: g.mapDef.id,
        open: !!T.openTrack, closed: !!T.loopClosed,
        gates: N, gateWidth: T.gateWidth,
        phase: g.phase, gate: pm.gate, lap: pm.lap,
        pos: [+b.pos.x.toFixed(1), +b.pos.z.toFixed(1)],
        heading: +b.heading.toFixed(2),
        speed: +b.speed.toFixed(1),
        spawn: { x: +sp.x.toFixed(1), z: +sp.z.toFixed(1), h: +sp.heading.toFixed(2) },
        gate0: T.gates[0], gate1: T.gates[1],
        dot: [at(0), at(1), at(2), at(3), at(pm.gate)],
        wrongWay: T.isWrongWay(b.pos, b.heading, pm.gate),
      };
    })()`);
    console.log('==', mapId, JSON.stringify(info));
    if (process.env.QUICK) {
      await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await sleep(1200);
      continue;
    }
    // 等倒计时结束再踩油门（低帧率下要大等）
    await waitFor(`window.__game?.phase === 'racing'`, '倒计时结束 ' + mapId, 200);
    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', code: 'ArrowUp' }))`);
    for (let k = 0; k < 14; k++) {
      await sleep(420);
      const s = await ev(`(() => {
        const g = window.__game; if (!g) return null;
        const b = g.localBoat; const pm = g.progressMap.get(g.myId);
        const [gx, gz] = g.track.gates[pm.gate];
        const dx = gx - b.pos.x, dz = gz - b.pos.z, len = Math.hypot(dx, dz) || 1;
        const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
        return {
          phase: g.phase, gate: pm.gate, lap: pm.lap,
          sp: +b.speed.toFixed(0), x: +b.pos.x.toFixed(0), z: +b.pos.z.toFixed(0),
          dot: +(((fx * dx + fz * dz) / len).toFixed(2)),
          ww: g.track.isWrongWay(b.pos, b.heading, pm.gate),
        };
      })()`);
      if (s) console.log('   ', k, JSON.stringify(s));
      if (s && s.phase === 'racing' && k > 10) break;
    }
    await ev(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', code: 'ArrowUp' }))`);

    await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(1200);
  }
  console.log('probe done');
} catch (e) {
  console.error('probe FAIL', e.message);
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  setTimeout(() => process.exit(0), 200);
}
