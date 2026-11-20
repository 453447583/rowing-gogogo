// 熔岩图机制冒烟：喷泉弹跳板 / 滚石硬碰撞回弹 / 撞碎岩掉奖励。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/magma-mech-${stamp}`);
const port = 9840 + (Number(stamp.slice(-3)) % 20);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=560x320', url,
], { stdio: 'ignore' });

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
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXC', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.reload'); await sleep(1200);
  for (let i = 0; i < 40; i++) {
    if ((await evaluate(`(() => { const b=document.querySelector('#btn-solo'); return !!b && typeof b.onclick==='function'; })()`)).result?.value) break;
    await sleep(300);
  }
  for (let i = 0; i < 10; i++) {
    await evaluate(`(() => { const b=document.querySelector('#btn-solo'); if(!b) return 0; b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); b.click(); return 1; })()`);
    await sleep(700);
    if ((await evaluate(`(() => document.querySelector('#menu-main')?.classList.contains('hidden'))()`)).result?.value) break;
  }
  let cards = false;
  for (let i = 0; i < 12 && !cards; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cards = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cards) throw new Error('地图抽屉打不开');
  const picked = await evaluate(`(() => { const c=[...document.querySelectorAll('.lp-card[data-map]')].find(x=>x.dataset.map==='magma'); if(!c) return 'missing'; c.click(); return 'ok'; })()`);
  if (picked.result?.value !== 'ok') throw new Error('magma 选不到');
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  for (let i = 0; i < 90; i++) {
    if ((await evaluate('!!window.__game?.localBoat && !!window.__game?.track')).result?.value) break;
    await sleep(500);
  }
  await sleep(3500);
  // 等 __game 稳定（无头下启动很慢，偶尔会晚一两秒）
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = (await evaluate('!!window.__game?.localBoat && !!window.__game?.track')).result?.value === true;
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('__game 未就绪');
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0; })()`);

  const out = await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, t0 = g.track;
    const cols = () => [...g.colliders, ...t0.shoreColliders, ...t0.mechColliders];
    const step = (input, n, ext) => {
      let t = 0;
      for (let i = 0; i < n; i++) {
        t += 1/60;
        b.updateLocal(1/60, input, g.elapsed + t, cols(), g.mapDef.boundary);
        t0.constrain(b);
        t0.applyMechs(b, 1/60);
        if (ext) ext(i);
      }
    };

    // ① 喷泉弹跳板：从板前 26m、6m/s 起步，应该被顶起来
    const pads = t0.jumpPads || [];
    let pad = null;
    if (pads.length) {
      const p = pads[0];
      b.resetTo(p.x - Math.sin(p.dir) * 26, p.z - Math.cos(p.dir) * 26, p.dir);
      b.speed = 6; b.vel.set(Math.sin(b.heading) * 6, Math.cos(b.heading) * 6);
      b.faultFall = 0; b.faultGrace = 0; b.airborne = false; b.faultPadCd = 0;
      let maxVy = 0, air = false;
      step({ throttle: 1, steer: 0 }, 200, () => {
        if (b.airborne) air = true;
        maxVy = Math.max(maxVy, b.vy || 0);
      });
      pad = { count: pads.length, launched: air, maxVy: +maxVy.toFixed(2), speed: +b.speed.toFixed(1) };    }

    // ② 滚石硬碰撞：迎面 34m/s 撞上去，看速度是否被"反弹"（法向分量反向）
    const rollers = t0.magmaHazards?.rollers || [];
    let roller = null;
    if (rollers.length) {
      const r = rollers[0];
      const dirX = r.x - Math.sin(0), dirZ = 0;
      // 从滚石正后方 12m 朝它冲
      const ux = 1, uz = 0;
      b.resetTo(r.x - 12, r.z, Math.atan2(ux, uz));
      b.speed = 34; b.vel.set(ux * 34, uz * 34);
      b.stunTimer = 0; b.airborne = false; b.collisionRoll = 0; b.angVel = 0;
      let before = null, after = null, roll = 0, spin = 0;
      step({ throttle: 1, steer: 0 }, 40, () => {
        const d = Math.hypot(b.pos.x - r.x, b.pos.z - r.z);
        if (before == null && d < r.r + 1.4) before = { vx: b.vel.x, speed: b.speed };
        after = { vx: b.vel.x, vz: b.vel.y, speed: b.speed, roll: b.collisionRoll, angVel: b.angVel };
        roll = Math.max(roll, Math.abs(b.collisionRoll));
        spin = Math.max(spin, Math.abs(b.angVel));
      });
      roller = { before, after, maxRoll: +roll.toFixed(3), maxAngVel: +spin.toFixed(2), shove: +(r.shoveT || 0).toFixed(2) };
    }

    // ③ 撞碎岩：20m/s 撞上去 → 碎 + 掉奖励核
    const rocks = t0.magmaHazards?.impactRocks || [];
    let rockReport = null;
    if (rocks.length) {
      const rk = rocks[0];
      // 顺着赛道方向撞过去（岩块在航道边缘，直接沿世界 +x 会先被护栏推开）
      const ga = t0.gates[rk.gate];
      const gb = t0.gates[(rk.gate + 1) % t0.gates.length];
      const dx = gb[0] - ga[0], dz = gb[1] - ga[1];
      const L = Math.hypot(dx, dz) || 1;
      const ux = dx / L, uz = dz / L;
      b.resetTo(rk.x - ux * 10, rk.z - uz * 10, Math.atan2(ux, uz));
      b.speed = 24; b.vel.set(ux * 24, uz * 24); b.airborne = false; b.boostTimer = 0;
      b.stunTimer = 0; b.heavyImpactSpeed = 0;
      b.waveJumpEnabled = false;   // 大浪会把船抛起来，applyMechs 对腾空船直接 return
      step({ throttle: 1, steer: 0 }, 30);
      rockReport = {
        shattered: rk.shatterT > 0,
        lootVisible: !!rk.loot?.visible,
        boostTimer: +b.boostTimer.toFixed(2),
      };
    }
    return { map: g.mapDef.id, pad, roller, rockReport };
  })()`);
  console.log('MECH', JSON.stringify(out.result?.value ?? out.exceptionDetails?.exception?.description, null, 1));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
