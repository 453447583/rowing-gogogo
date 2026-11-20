// 终点判定几何探针：量「代码认为的船头」和「实际渲染出来的船头」差多少，
// 以及压线结算那一帧，视觉船头究竟在线前还是线后。
//
//   node tests/finish_bow_probe.mjs                 # 默认 strait（闭合环线）
//   MAP=baked FINISH=last node tests/finish_bow_probe.mjs
//
// FINISH=first  终点 = gates[0]（闭合环线，跨起点线）
// FINISH=last   终点 = gates[N-1]（开环烘焙赛道的最后一道门）
//
// 判定读数是 s（船头沿赛道前向到终点线的有符号距离）：
//   s < 0 还没压线，s >= 0 已过线。
//   结算发生在 s 明显 < 0 的那一帧 = 「船头还没进终点就完成了」。
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/bow-${stamp}`;   // 必须在项目外
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const which = process.env.FINISH || 'first';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1024,600', 'about:blank'], { stdio: 'ignore' });

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

// 渲染网格在「本船前向」上的最远点 = 视觉船头
const MEASURE = `(() => {
  const g = window.__game;
  const out = [];
  for (const [id, b] of g.boats) {
    const h = b.heading;
    const fx = Math.sin(h), fz = Math.cos(h);
    b.group.updateMatrixWorld(true);
    let best = -1e9;
    let bestName = '';
    b.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geo = o.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const bb = geo.boundingBox;
      if (!bb) return;
      const e = o.matrixWorld.elements;
      for (const x of [bb.min.x, bb.max.x]) {
        for (const y of [bb.min.y, bb.max.y]) {
          for (const z of [bb.min.z, bb.max.z]) {
            const wx = e[0]*x + e[4]*y + e[8]*z + e[12];
            const wz = e[2]*x + e[6]*y + e[10]*z + e[14];
            const d = (wx - b.pos.x) * fx + (wz - b.pos.z) * fz;
            if (d > best) { best = d; bestName = o.name || o.parent?.name || '?'; }
          }
        }
      }
    });
    out.push({
      id, def: b.def?.id, hullLen: b.def?.hull?.length,
      codeBow: +((b.def?.hull?.length || 4.5) * 0.5).toFixed(3),
      visualBow: +best.toFixed(3), mesh: bestName,
    });
  }
  return out;
})()`;

// 终点参考：闭合环线用 gates[0]，开环用最后一门
const FIN = `(() => {
  const T = window.__game.track;
  const idx = ${which === 'last' ? 'T.gates.length - 1' : '0'};
  return { idx, gate: T.gates[idx], dir: T.gateDir(idx), N: T.gates.length,
    openTrack: !!T.openTrack, loopClosed: !!T.loopClosed, arcTotal: T.arcTotal };
})()`;

const snapshot = `(() => {
  const g = window.__game, b = g.localBoat, T = g.track, pm = g.progressMap.get(g.myId);
  const idx = window.__fin.idx;
  const [gx, gz] = T.gates[idx]; const { dx, dz } = T.gateDir(idx);
  const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
  const half = (b.def.hull.length || 4.5) * 0.5;
  const vis = window.__bowVis ?? half;
  return {
    t: +g.raceTime.toFixed(2),
    lap: pm.lap,
    codeS: +(((b.pos.x + fx * half - gx) * dx + (b.pos.z + fz * half - gz) * dz)).toFixed(2),
    visS: +(((b.pos.x + fx * vis - gx) * dx + (b.pos.z + fz * vis - gz) * dz)).toFixed(2),
    fin: !!(g.finished || pm.finished),
  };
})()`;

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
  await waitFor(`window.__game?.phase === 'racing'`, 120000);

  const bow = val(await evaluate(MEASURE));
  console.log('MAP', mapId, 'FINISH', which);
  console.log('BOW', JSON.stringify(bow));
  await evaluate(`(() => {
    const rows = ${JSON.stringify(bow)};
    const mine = rows.find((r) => r.id === window.__game.myId);
    window.__bowVis = mine ? mine.visualBow : null;
    return window.__bowVis;
  })()`);
  const fin = val(await evaluate(FIN));
  console.log('FIN', JSON.stringify({ idx: fin.idx, N: fin.N, openTrack: fin.openTrack,
    loopClosed: fin.loopClosed, arcTotal: +(+fin.arcTotal).toFixed(1) }));
  await evaluate(`window.__fin = ${JSON.stringify({ idx: fin.idx })}; 1`);

  // 去掉干扰，真开过终点线
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.track.constrain = () => {}; g.track.applyMechs = () => {};
    g.track.shoreColliders.length = 0; g.mapDef.boundary = null;
    if ('countdownLeft' in g) g.countdownLeft = 0;
    g.opts.input = {
      get throttle() { return window.__thr || 0; }, get steer() { return 0; },
      get drift() { return false; }, get nitro() { return false; },
    };
    return 1;
  })()`);

  // 摆到终点线后方。先让判定自己跑几帧把 bowPrev/arcPrev 建好，
  // 再灌 arcSince —— 否则和它内部的 arcSince = 0 撞车。
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, T = g.track;
    const idx = window.__fin.idx;
    const [gx, gz] = T.gates[idx]; const { dx, dz } = T.gateDir(idx);
    const half = (b.def.hull.length || 4.5) * 0.5;
    b.resetTo(gx - dx * (14 + half), gz - dz * (14 + half), Math.atan2(dx, dz));
    return 1;
  })()`);
  await sleep(1200);
  await evaluate(`(() => { const g = window.__game;
    if (!g.track.openTrack) g.arcSince = g.track.arcTotal * 0.9; return 1; })()`);

  // 逐帧录制
  await evaluate(`(() => {
    const g = window.__game;
    window.__rec = [];
    if (window.__hooked) return 1;
    window.__hooked = 1;
    const tick = () => {
      try {
        const b = g.localBoat;
        if (b) {
          const T = g.track, idx = window.__fin.idx;
          const [gx, gz] = T.gates[idx], { dx, dz } = T.gateDir(idx);
          const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
          const half = (b.def.hull.length || 4.5) * 0.5;
          const vis = window.__bowVis ?? half;
          const pm = g.progressMap.get(g.myId);
          window.__rec.push({
            t: +g.raceTime.toFixed(2),
            lap: pm.lap,
            codeS: +(((b.pos.x + fx * half - gx) * dx + (b.pos.z + fz * half - gz) * dz)).toFixed(2),
            visS: +(((b.pos.x + fx * vis - gx) * dx + (b.pos.z + fz * vis - gz) * dz)).toFixed(2),
            fin: !!(g.finished || pm.finished),
          });
          if (window.__rec.length > 4000) window.__rec.shift();
        }
      } catch { /* */ }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return 1;
  })()`);

  const before = val(await evaluate(snapshot));
  console.log('BEFORE', JSON.stringify(before));

  await evaluate(`window.__thr = 1; 1`);
  await sleep(9000);
  await evaluate(`window.__thr = 0; 1`);

  const rec = val(await evaluate(`window.__rec`)) || [];
  console.log('FRAMES', rec.length);
  let at = -1;
  for (let i = 1; i < rec.length; i++) {
    if (rec[i].fin !== rec[i - 1].fin || rec[i].lap !== rec[i - 1].lap) { at = i; break; }
  }
  if (at < 0) {
    console.log('NO EVENT. 末 6 帧：');
    console.log(JSON.stringify(rec.slice(-6)));
  } else {
    console.log('结算/计圈帧上下文（visS 应为 0 附近；<0 表示船头还没到线就结算）：');
    console.log(JSON.stringify(rec.slice(Math.max(0, at - 3), at + 2), null, 1));
  }
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
