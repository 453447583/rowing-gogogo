// 秘境漂流（baked）场景侦查：把指定门位附近的可见网格列出来（名字/尺寸/中心/材质）
//   MAP=baked GATES=0,10,17,23,25,54,79,86 R=45 node tests/baked_scene_probe.mjs
// 用于回答"这个横在水面上的白条到底是什么""那个巨大的东西是什么"之类的定位问题。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/baked-${stamp}`);
const port = 9600 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'baked';
const gates = (process.env.GATES || '0,10,17,23,25,54,79,86').split(',').map(Number);
const radius = Number(process.env.R || 45);

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 180000) {
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
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

async function waitForJson(u, timeout = 20000) {
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
      const d = msg.params.exceptionDetails;
      console.log('EXC', d.exception?.description?.slice(0, 300) || d.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find((x) => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map((x) => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  // GLB 赛道要加载一会儿，等 track.group 里有东西
  const t1 = Date.now();
  let ready = false;
  while (Date.now() - t1 < 150000) {
    const r = await evaluate('(() => { const g = window.__game; if (!g || !g.track) return 0; return g.track.group ? g.track.group.children.length : 0; })()');
    if (Number(r.result?.value) > 6) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) throw new Error('赛道没加载完');
  await sleep(2500);   // 等 GLB 异步到位

  const out = await evaluate(`(() => {
    const g = window.__game, t = g.track;
    const N = t.gates.length;
    const THREE = window.__THREE__;
    const box = new (window.__game.constructor === Object ? Object : Object)();
    const b3 = (o) => {
      const bb = { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } };
      o.updateWorldMatrix(true, true);
      o.traverse((m) => {
        if (!m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const geoBB = m.geometry.boundingBox;
        m.matrixWorld.elements; // 确保矩阵就绪
        const corners = [
          [geoBB.min.x, geoBB.min.y, geoBB.min.z], [geoBB.max.x, geoBB.min.y, geoBB.min.z],
          [geoBB.min.x, geoBB.max.y, geoBB.min.z], [geoBB.max.x, geoBB.max.y, geoBB.min.z],
          [geoBB.min.x, geoBB.min.y, geoBB.max.z], [geoBB.max.x, geoBB.min.y, geoBB.max.z],
          [geoBB.min.x, geoBB.max.y, geoBB.max.z], [geoBB.max.x, geoBB.max.y, geoBB.max.z],
        ];
        const e = m.matrixWorld.elements;
        for (const [x, y, z] of corners) {
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          bb.min.x = Math.min(bb.min.x, wx); bb.max.x = Math.max(bb.max.x, wx);
          bb.min.y = Math.min(bb.min.y, wy); bb.max.y = Math.max(bb.max.y, wy);
          bb.min.z = Math.min(bb.min.z, wz); bb.max.z = Math.max(bb.max.z, wz);
        }
      });
      return bb;
    };
    const rows = [];
    const seen = new Set();
    const scan = (root, tag) => {
      root.traverse((o) => {
        if (!o.isMesh && !o.isGroup) return;
        if (o.isMesh && !o.isMesh) return;
        if (seen.has(o)) return;
        seen.add(o);
        const bb = b3(o);
        if (!Number.isFinite(bb.min.x)) return;
        const cx = (bb.min.x + bb.max.x) / 2, cy = (bb.min.y + bb.max.y) / 2, cz = (bb.min.z + bb.max.z) / 2;
        const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
        if (Math.max(sx, sz) < 3 && sy < 3) return;      // 小件不列
        const mat = o.material || (o.children || []).map((c) => c.material).find(Boolean);
        rows.push({
          who: o.name || '(anon)', tag, mesh: !!o.isMesh,
          c: [+cx.toFixed(1), +cy.toFixed(1), +cz.toFixed(1)],
          s: [+sx.toFixed(1), +sy.toFixed(1), +sz.toFixed(1)],
          col: mat && mat.color ? '#' + mat.color.getHexString() : null,
          op: mat && mat.opacity != null ? +mat.opacity.toFixed(2) : null,
          tr: mat ? !!mat.transparent : null,
        });
      });
    };
    scan(t.group, 'track.group');
    if (g.scene) scan(g.scene, 'scene');
    if (g.env && g.env.group) scan(g.env.group, 'env');

    // 按门位归并：每个门附近的超大件 / 横跨件
    // SCAN=a-b:step —— 逐门打印走廊附近最近的几件东西，用来找"横在水面上的白条"
    const SCAN_RANGE = ${JSON.stringify(process.env.SCAN || '')};
    if (SCAN_RANGE) {
      const parts = SCAN_RANGE.split('-').map(Number);
      const a = parts[0], b = parts[1], step = parts[2] || 5;
      const lines = [];
      for (let gi = a; gi <= b; gi += step) {
        const gx = t.gates[gi][0], gz = t.gates[gi][1];
        const list = rows
          .filter((r) => r.tag !== 'scene')
          .map((r) => ({ ...r, d: Math.hypot(Math.max(0, Math.abs(gx - r.c[0]) - r.s[0] / 2), Math.max(0, Math.abs(gz - r.c[2]) - r.s[2] / 2)) }))
          .filter((r) => r.d < 26)
          .sort((p, q) => p.d - q.d)
          .slice(0, 4)
          .map((r) => r.who + '(' + r.s.join('x') + ',' + (r.col || '-') + ',d' + r.d.toFixed(0) + ')');
        lines.push('g' + gi + ' y=' + (t.gateY ? t.gateY[gi].toFixed(1) : '?') + ' :: ' + list.join(' | '));
      }
      return lines;
    }

    const report = ${JSON.stringify(gates)}.map((gi) => {
      const gx = t.gates[gi][0], gz = t.gates[gi][1];
      const near = rows
        .map((r) => ({ ...r, d: Math.hypot(r.c[0] - gx, r.c[2] - gz) }))
        .filter((r) => r.d < ${radius})
        .sort((a, b) => b.s[0] * b.s[2] - a.s[0] * a.s[2])
        .slice(0, 14)
        .map((r) => ({ who: r.who, tag: r.tag, d: +r.d.toFixed(1), c: r.c, s: r.s, col: r.col, op: r.op }));
      return {
        gate: gi,
        gatePos: [+gx.toFixed(1), +gz.toFixed(1)],
        gateY: t.gateY ? +t.gateY[gi].toFixed(2) : null,
        boatY: gi === 0 && g.localBoat ? +g.localBoat.pos.y.toFixed(2) : null,
        near,
      };
    });
    const all = rows
      .filter((r) => r.tag !== 'scene')
      .sort((a, b) => b.s[0] * b.s[2] - a.s[0] * a.s[2])
      .slice(0, ${Number(process.env.LIST || 0)})
      .map((r) => ({ who: r.who, s: r.s, c: r.c, col: r.col }));
    return { map: g.mapDef.id, gates: N, report, all };
  })()`);

  const r0 = out.result?.value;
  if (Array.isArray(r0)) { for (const line of r0) console.log(line); return; }
  const r = r0;
  if (!r) {
    console.error('无输出', out.exceptionDetails?.exception?.description?.slice(0, 400));
    throw new Error('侦查没返回结果');
  }
  if (r.all && r.all.length) {
    console.log('\n=== 场景大件（按 XZ 面积排）===');
    for (const a of r.all) console.log(`   ${String(a.who).padEnd(28)} size=${a.s.join('×')}  c=${a.c.join(',')}  ${a.col || ''}`);
  }
  for (const gi of r.report) {
    console.log(`\n--- gate ${gi.gate}  世界(${gi.gatePos})  赛道面 y=${gi.gateY}${gi.boatY != null ? `  船 y=${gi.boatY}` : ''}`);
    for (const n of gi.near) {
      console.log(`   ${n.who.padEnd(26)} d=${String(n.d).padStart(6)}  size=${n.s.join('×')}  c=${n.c.join(',')}  ${n.col || ''}${n.op != null && n.op < 1 ? ` op=${n.op}` : ''}  [${n.tag}]`);
    }
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
