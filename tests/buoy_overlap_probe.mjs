// 浮桶重叠探针：把赛道所有浮桶站位的真实坐标读出来，找出互相靠得太近的一对。
//
//   node tests/buoy_overlap_probe.mjs            # strait
//   MAP=magma node tests/buoy_overlap_probe.mjs
//
// 只读不写。输出：
//   ① 站位总数、最近的一对距离
//   ② 所有距离 < LIMIT 的站位对（x/z/左右侧/所属门号），按距离排序
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/buoy-${stamp}`;
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const LIMIT = Number(process.env.LIMIT || 3.2);

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=800,500', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = info.find((t) => t.type === 'page');
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
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(400);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);

  const out = val(await evaluate(`(() => {
    const T = window.__game.track;
    const eb = T.edgeBuoys;
    if (!eb) return { err: 'no edgeBuoys' };
    const st = eb.stations;
    const gates = T.gates;
    // 站位 → 最近的赛道弧长（用来判断它在哪个门附近）
    const arcOf = (p) => {
      let best = 1e9, bi = -1;
      for (let i = 0; i < gates.length; i++) {
        const d = Math.hypot(gates[i][0] - p.x, gates[i][1] - p.z);
        if (d < best) { best = d; bi = i; }
      }
      return { gate: bi, gateDist: +best.toFixed(1) };
    };
    const pairs = [];
    for (let i = 0; i < st.length; i++) {
      for (let j = i + 1; j < st.length; j++) {
        const d = Math.hypot(st[i].x - st[j].x, st[i].z - st[j].z);
        if (d < ${LIMIT}) {
          pairs.push({
            d: +d.toFixed(2),
            a: { i, x: +st[i].x.toFixed(1), z: +st[i].z.toFixed(1), side: st[i].side, ...arcOf(st[i]) },
            b: { i: j, x: +st[j].x.toFixed(1), z: +st[j].z.toFixed(1), side: st[j].side, ...arcOf(st[j]) },
          });
        }
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    let minD = 1e9, minPair = null;
    for (let i = 0; i < st.length; i++) {
      for (let j = i + 1; j < st.length; j++) {
        const d = Math.hypot(st[i].x - st[j].x, st[i].z - st[j].z);
        if (d < minD) { minD = d; minPair = [i, j]; }
      }
    }
    // 复算拐角斜接点长度：内角越尖，斜接点被拉得越远（尖刺）
    const N = gates.length, halfW = T.edgeOffset;
    const dirs = [], norms = [];
    for (let i = 0; i < N; i++) {
      const a = gates[i], b = gates[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz) || 1;
      dirs.push([dx / L, dz / L]);
      norms.push([-dz / L, dx / L]);
    }
    const miters = [];
    for (let i = 0; i < N; i++) {
      const d1 = dirs[(i - 1 + N) % N], d2 = dirs[i];
      const turn = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
      const v = gates[i], n1 = norms[(i - 1 + N) % N], n2 = norms[i];
      for (const side of [1, -1]) {
        if (!(side * turn > 0)) continue;           // 只有内角才走斜接
        const p1x = v[0] + n1[0] * side * halfW, p1z = v[1] + n1[1] * side * halfW;
        const p2x = v[0] + n2[0] * side * halfW, p2z = v[1] + n2[1] * side * halfW;
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(den) < 1e-6) continue;
        const t = ((p2x - p1x) * d2[1] - (p2z - p1z) * d2[0]) / den;
        const mx = p1x + d1[0] * t, mz = p1z + d1[1] * t;
        miters.push({
          gate: i, side,
          turnDeg: +(turn * 180 / Math.PI).toFixed(1),
          miterLen: +Math.hypot(mx - v[0], mz - v[1]).toFixed(1),
        });
      }
    }
    miters.sort((a, b) => b.miterLen - a.miterLen);
    return {
      map: window.__game.mapDef.id,
      halfW: +halfW.toFixed(2),
      worstMiters: miters.slice(0, 8),
      stations: st.length,
      lines: eb.ropes.length,
      minDistance: +minD.toFixed(2),
      minPair,
      overlapCount: pairs.length,
      limit: ${LIMIT},
      pairs: pairs.slice(0, 20),
    };
  })()`));
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
