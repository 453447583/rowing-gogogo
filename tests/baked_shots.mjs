// 秘境漂流定点验图：山洞（蘑菇）+ 瀑布（水面在船下）
//   node tests/baked_shots.mjs [baseUrl]
//
// 软件光栅很慢，所以只进一次图、只拍两张，其余靠断言：
//   ① cave_cap / cave_stem 必须带 emissiveMap（否则洞里就是一团暗红）
//   ② 瀑布水面（fall_water_ribbon）在船正下方的偏差必须 < 1m
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/baked-shots-' + Date.now());
const port = 9500 + Math.floor(Math.random() * 100);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=800,450', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 240000)),
  ]);
};
const evalJS = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const local = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, label, tries = 120) => {
  for (let i = 0; i < tries; i++) {
    const ok = await evalJS(expr).catch(() => false);
    if (ok) return;
    await local(500);
  }
  throw new Error('timeout: ' + label);
};

try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await local(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await local(3000);

  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  // 单次 click 偶尔会落空（菜单过渡 / 事件还没绑上），点到"选船页真的开了"为止
  let opened = false;
  for (let i = 0; i < 10 && !opened; i++) {
    await evalJS(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1500);
    opened = await evalJS(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false);
  }
  if (!opened) throw new Error('solo 连点 10 次也没进选船页');
  await waitFor(`!!document.querySelector('.boat-card')`, 'boats');
  await evalJS(`(() => { document.querySelector('.boat-card').click(); document.querySelector('#btn-boat-ok').click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'maps');
  for (let i = 0; i < 8 && !(await evalJS(`!!window.__game`).catch(() => false)); i++) {
    await evalJS(`(() => {
      const card = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === 'baked');
      card?.click(); document.querySelector('#btn-map-ok')?.click();
    })()`);
    await local(3000);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await local(8000);   // GLB
  await evalJS(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    g.renderer.setSize(800, 450, false);
  })()`);

  const place = async (gateA, gateB, t = 0.5) => {
    await evalJS(`(() => {
      const g = window.__game;
      const a = g.mapDef.gates[${gateA}], b = g.mapDef.gates[${gateB}];
      const x = a[0] + (b[0] - a[0]) * ${t}, z = a[1] + (b[1] - a[1]) * ${t};
      const boat = g.localBoat;
      boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
      boat.speed = 0; boat.vel.set(0, 0);
      const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = ${gateB}; pm.lap = 1; }
      boat.diveTargetY = g.track.diveHeightAt(boat.pos, ${gateB});
      boat.pos.y = boat.diveTargetY ?? boat.pos.y;
      // 相机接口叫 snapTo(boat)，不是 snap()；不调它镜头会从上一个位置飘半天
      (g.cameraRig?.snapTo?.bind(g.cameraRig) || (() => {}))(boat);
    })()`);
    await local(2200);
  };
  const shot = async (name) => {
    const res = await cdp('Page.captureScreenshot', { format: 'png' });
    const f = path.join(out, name + '.png');
    await fs.writeFile(f, Buffer.from(res.data, 'base64'));
    console.log('shot ->', path.relative(process.cwd(), f));
  };

  // ---------- 山洞：蘑菇 ----------
  await place(6, 7, 0.5);
  await shot('baked-cave-mushroom');
  const mush = await evalJS(`(() => {
    const g = window.__game; const out = []; const seen = new Set();
    g.track.group.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mn = o.material.name || '';
      if (!/cave_(cap|stem)/i.test(mn) || seen.has(mn)) return;
      seen.add(mn);
      out.push({ mat: mn, emissive: o.material.emissive ? '#' + o.material.emissive.getHexString() : null,
        ei: o.material.emissiveIntensity, emissiveMap: !!o.material.emissiveMap,
        vertexColors: o.material.vertexColors, map: !!o.material.map });
    });
    return out;
  })()`);
  console.log('蘑菇材质:', JSON.stringify(mush));
  if (!mush.length) throw new Error('cave_stem/cave_cap 材质没找到');
  if (!mush.every((m) => m.emissiveMap && m.ei >= 0.4 && !m.vertexColors)) throw new Error('蘑菇自发光没生效');

  // ---------- 瀑布：水面在船下 ----------
  // 瀑布段地形最重（森林 + 3.4km 地形），截图前先把渲染尺寸压到 480x270，
  // 否则软件光栅下 Page.captureScreenshot 会直接超时
  await evalJS(`(() => { const g = window.__game; g.renderer.setSize(320, 180, false); if (g.postFx) g.postFx.enabled = false; })()`);
  await local(1500);
  await place(60, 61, 0.5);
  await shot('baked-fall-b');
  const gap = await evalJS(`(() => {
    const g = window.__game;
    const meshes = [];
    g.track.group.traverse((o) => { if (o.isMesh && /fall_water/i.test(o.name || '') && o.visible) meshes.push(o); });
    if (!meshes.length) return { error: 'no fall water mesh' };
    const P = meshes[0].geometry.attributes.position;
    const rows = [];
    for (const gi of [57, 58, 59, 60, 61, 62, 63, 64]) {
      const a = g.mapDef.gates[gi], b = g.mapDef.gates[gi + 1];
      const x = a[0] + (b[0] - a[0]) * 0.5, z = a[1] + (b[1] - a[1]) * 0.5;
      const boatY = g.track.diveHeightAt({ x, z }, gi) || 0;
      let wy = null, bd = 1e9;
      for (let k = 0; k < P.count; k++) {
        const d = Math.hypot(P.getX(k) - x, P.getZ(k) - z);
        if (d < bd) { bd = d; wy = P.getY(k); }
      }
      rows.push({ gi, boatY: +boatY.toFixed(1), waterY: +wy.toFixed(1), dist: +bd.toFixed(1), gap: +(boatY - wy).toFixed(1) });
    }
    return { name: meshes[0].name, rows };
  })()`);
  console.log('瀑布沿程:', JSON.stringify(gap));
  if (gap.error) throw new Error(gap.error);
  const bad = gap.rows.filter((r) => Math.abs(r.gap) > 1.0 || r.dist > 6);
  if (bad.length) throw new Error('瀑布水面与船错位: ' + JSON.stringify(bad));
  console.log('baked shots: PASS');
} catch (e) {
  console.error('baked shots FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
