// 诊断"熔岩图按方向键半天没反应"：直接步进 updateLocal，看油门/转向到底有没有生效。
// 用法：先 node tests/serve-dist.mjs，再 node tests/magma_control_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/magma-ctrl-${stamp}`);
const port = 9760 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const mapId = process.env.MAP || 'magma';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=560x320', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (method, params = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + method)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const waitJson = async (u, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
};

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = tabs.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.reload'); await sleep(1200);

  for (let i = 0; i < 40; i++) {
    const r = await evaluate(`(() => { const b = document.querySelector('#btn-solo'); return !!b && typeof b.onclick === 'function'; })()`);
    if (r.result?.value) break;
    await sleep(300);
  }
  for (let i = 0; i < 10; i++) {
    await evaluate(`(() => { const b = document.querySelector('#btn-solo'); if (!b) return 0; b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); b.click(); return 1; })()`);
    await sleep(700);
    const moved = await evaluate(`(() => document.querySelector('#menu-main')?.classList.contains('hidden'))()`);
    if (moved.result?.value) break;
  }
  let cards = false;
  for (let i = 0; i < 12 && !cards; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cards = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cards) throw new Error('地图抽屉打不开');
  const picked = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-card[data-map]')].find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing';
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`${mapId} 选不到`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  for (let i = 0; i < 90; i++) {
    if ((await evaluate('!!window.__game?.localBoat && !!window.__game?.track')).result?.value) break;
    await sleep(500);
  }
  await sleep(4000);
  await evaluate(`(() => { const g = window.__game; g.phase = 'racing'; g.countdownLeft = 0; })()`);

  const report = await evaluate(`(() => {
    const g = window.__game;
    const b = g.localBoat;
    const input = { throttle: 1, steer: 0, drift: false, nitro: false };
    const cols = () => [...g.colliders, ...g.track.shoreColliders, ...g.track.mechColliders];
    const log = [];
    let t = 0;
    for (let i = 0; i < 240; i++) {
      t += 1 / 60;
      b.updateLocal(1/60, input, g.elapsed + t, cols(), g.mapDef.boundary);
      g.track.constrain(b);
      g.track.applyMechs(b, 1/60);
      if (i % 40 === 0) log.push({
        i,
        speed: +b.speed.toFixed(2),
        y: +b.pos.y.toFixed(2),
        vy: +(b.vy || 0).toFixed(2),
        air: b.airborne ? 1 : 0,
        wj: b.waveJump ? 1 : 0,
        stun: +b.stunTimer.toFixed(2),
        fall: +b.faultFall.toFixed(2),
        sink: +b.sinkTimer.toFixed(2),
        slow: +b.slowTimer.toFixed(2),
        cap: +b.capsizeTimer.toFixed(2),
        dive: b.diveTargetY,
        oc: b.onCoaster ? 1 : 0,
      });
    }
    const speedAfter = +b.speed.toFixed(2);
    // 转向：直行后按住左舵 1s，看航向变化
    const h0 = b.heading;
    const steerInput = { throttle: 1, steer: -1, drift: false, nitro: false };
    for (let i = 0; i < 60; i++) {
      t += 1 / 60;
      b.updateLocal(1/60, steerInput, g.elapsed + t, cols(), g.mapDef.boundary);
      g.track.constrain(b);
    }
    let dh = b.heading - h0;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    // 谁在贴着船？把最近的碰撞体打出来（stun 恒为 0.5 = 每帧都在撞同一个东西）
    const near = [...g.colliders, ...g.track.shoreColliders, ...g.track.mechColliders]
      .map((c) => ({
        t: c.type || 'env', x: +(+c.x).toFixed(1), z: +(+c.z).toFixed(1), r: +(+c.r).toFixed(1),
        d: +Math.hypot(b.pos.x - c.x, b.pos.z - c.z).toFixed(2),
      }))
      .filter((c) => Number.isFinite(c.d))
      .sort((a, c) => a.d - c.d)
      .slice(0, 5);
    return {
      map: g.mapDef.id,
      gateCount: g.mapDef.gates.length,
      phase: g.phase,
      pos: [+b.pos.x.toFixed(1), +b.pos.z.toFixed(1)],
      log,
      near,
      speedAfter,
      steerDeg: +(dh * 180 / Math.PI).toFixed(1),
      waveScale: g.water?.uniforms?.uWaveScale?.value,
      waveJumpEnabled: !!b.waveJumpEnabled,
    };
  })()`);
  console.log('CTRL', JSON.stringify(report.result?.value ?? report.exceptionDetails?.exception?.description, null, 1));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
