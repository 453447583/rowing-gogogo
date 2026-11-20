// 熔岩夜航（magma）主题验收：亮蓝水道 / 大浪 / 新障碍是否真的生效。
// 用法（先起 dist 静态服务）：node tests/serve-dist.mjs &  然后
//   node tests/magma_look.mjs
// 输出：shots/verify/magma-theme-g*.jpg + 控制台 DIAG（含着色器报错）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/magma-look-${stamp}`);
const port = 9680 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const outDir = path.resolve('shots/verify');
const size = process.env.SIZE || '560x320';
const gates = (process.env.GATES || '2,6,10,14,18').split(',').map(Number);

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${size}`, url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const shaderErrors = [];
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

async function waitForJson(u, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 400)
        || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const txt = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      const s = String(txt);
      if (/WebGLProgram|shader|GLSL|compile/i.test(s)) shaderErrors.push(s.slice(0, 500));
      console.log(`CONSOLE.${msg.params.type}`, s.slice(0, 400));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const ready = await evaluate(`(() => {
      const b = document.querySelector('#btn-solo');
      return !!b && typeof b.onclick === 'function';
    })()`);
    if (ready.result?.value) break;
    await sleep(250);
  }
  // 冷启动时 main.js 可能刚绑好 onclick，多点几次直到主菜单真的切走
  for (let i = 0; i < 10; i++) {
    await evaluate(`(() => {
      const b = document.querySelector('#btn-solo');
      if (!b) return 0;
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      b.click();
      return 1;
    })()`);
    await sleep(700);
    const moved = await evaluate(`(() => document.querySelector('#menu-main')?.classList.contains('hidden'))()`);
    if (moved.result?.value) break;
  }
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find(x => x.dataset.map === 'magma');
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`magma 选不到：${picked.result?.value}`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ok = false;
  while (Date.now() - t2 < 90000) {
    const st = await evaluate(`(() => ({
      game: !!window.__game, track: !!window.__game?.track,
      startBtn: document.querySelector('#btn-start-race')?.className || null,
      screens: [...document.querySelectorAll('#ui-root > *')].filter(e => !e.classList.contains('hidden')).map(e => e.id).slice(0, 8),
      boat: !!window.__game?.localBoat,
    }))()`);
    if (st.result?.value?.track) { ok = true; break; }
    if (process.env.DEBUG && Math.floor((Date.now() - t2) / 5000) !== Math.floor((Date.now() - t2 - 400) / 5000)) {
      console.log('waiting', JSON.stringify(st.result?.value));
    }
    await sleep(400);
  }
  if (!ok) throw new Error('对局没起来');
  await sleep(Number(process.env.WARM || 6000));

  await evaluate(`(() => { const g = window.__game; g.phase = 'racing'; g.countdownLeft = 0; })()`);
  const diag = await evaluate(`(() => {
    const g = window.__game;
    const u = g.water?.uniforms || {};
    const mh = g.track.magmaHazards;
    const d0 = mh?.drifters?.[0];
    const gz0 = mh?.geysers?.[0];
    return {
      map: g.mapDef?.id,
      uAzure: u.uAzure?.value,
      azureShallow: u.uAzureShallow?.value?.getHexString?.(),
      azureCoverage: u.uAzureCoverage?.value,
      waveScale: u.uWaveScale?.value,
      azureMats: !!(g.water?.material),
      drifters: mh?.drifters?.length ?? 0,
      geysers: mh?.geysers?.length ?? 0,
      rollers: mh?.rollers?.length ?? 0,
      impactRocks: mh?.impactRocks?.length ?? 0,
      faults: g.track.faults?.length ?? 0,
      gateCount: g.mapDef?.gates?.length,
      boiler: (() => { const r = mh?.rollers?.[0]; return r ? [+r.x.toFixed(1), +r.z.toFixed(1)] : null; })(),
      drifterOff: d0 ? +d0.off.toFixed(2) : null,
      geyserUp: gz0 ? +gz0.up01.toFixed(2) : null,
      boostVisuals: (g.track.marine?.boosts || []).length,
      launchPlatforms: (g.track.marine?.platforms || []).length,
      buoys: (g.track.marine?.buoys || []).length,
      portalProps: (g.track.courseProps || []).filter(p => p.kind === 'portal').length,
      courseKinds: (g.track.courseProps || []).map(p => p.kind),
      programs: g.renderer?.info?.programs?.length ?? -1,
    };
  })()`);
  console.log('DIAG', JSON.stringify(diag.result?.value ?? diag.exceptionDetails?.exception?.description, null, 1));

  // 断层规则冒烟：低速进裂谷 → 坠落标记；高速进裂谷 → 起跳。
  if (process.env.FAULT_TEST) {
    const lowSpeed = await evaluate(`(() => {
      const g = window.__game; const b = g.localBoat; const f = g.track.faults[0];
      b.resetTo(f.cx, f.cz, Math.atan2(f.fx, f.fz));
      b.speed = 4; b.vel.set(Math.sin(b.heading) * 4, Math.cos(b.heading) * 4);
      return { inFault: !!g.track.faultAt(b.pos), faults: g.track.faults.length };
    })()`);
    await sleep(Number(process.env.FAULT_WAIT ?? 1400));
    const lowAfter = await evaluate(`(() => { const b = window.__game.localBoat; return { fall: +b.faultFall.toFixed(2), speed: +b.speed.toFixed(1), y: +b.pos.y.toFixed(1), grace: +b.faultGrace.toFixed(2), res: b.__respawned ? 1 : 0 }; })()`);
    await evaluate(`(() => {
      const g = window.__game; const b = g.localBoat; const f = g.track.faults[0];
      b.resetTo(f.cx - f.fx * 6, f.cz - f.fz * 6, Math.atan2(f.fx, f.fz));
      b.speed = 26; b.vel.set(Math.sin(b.heading) * 26, Math.cos(b.heading) * 26);
      b.faultGrace = 0; b.faultFall = 0; b.airborne = false;
    })()`);
    await sleep(900);
    const fastAfter = await evaluate(`(() => { const b = window.__game.localBoat; return { airborne: !!b.airborne, vy: +b.vy.toFixed(2), grace: +b.faultGrace.toFixed(2), fall: +b.faultFall.toFixed(2) }; })()`);
    console.log('FAULT_LOW', JSON.stringify(lowSpeed.result?.value), JSON.stringify(lowAfter.result?.value));
    console.log('FAULT_FAST', JSON.stringify(fastAfter.result?.value));
  }

  for (const gi of gates) {
    const r = await evaluate(`(() => {
      const g = window.__game;
      const N = g.mapDef.gates.length;
      const a = g.mapDef.gates[${gi} % N], b = g.mapDef.gates[(${gi} + 1) % N];
      const t = ${Number(process.env.GATE_T ?? 0.5)};
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const boat = g.localBoat;
      boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
      boat.speed = 0; boat.vel.set(0, 0);
      const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = ${gi}; pm.lap = 1; }
      for (let i = 0; i < 120; i++) g.cameraRig.follow(boat, 1 / 60);
      return { x: +x.toFixed(1), z: +z.toFixed(1) };
    })()`);
    if (r.exceptionDetails) {
      console.log(`g${gi} EXC:`, r.exceptionDetails.exception?.description?.slice(0, 300));
      continue;
    }
    await sleep(Number(process.env.SETTLE || 1600));
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    await fs.mkdir(outDir, { recursive: true });
    const f = path.join(outDir, `magma-theme-g${gi}.jpg`);
    await fs.writeFile(f, Buffer.from(shot.data, 'base64'));
    console.log(`g${gi}`, JSON.stringify(r.result?.value), '->', path.basename(f));
  }
  console.log('SHADER_ERRORS', JSON.stringify(shaderErrors));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
