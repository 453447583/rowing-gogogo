// 计圈周期探针：反复把船摆到终点线后方、灌满弧长、开过线，
// 看 pm.lap 每次涨多少、第几次过线才结算。
//
//   node tests/finish_lap_cycle_probe.mjs        # strait
//   MAP=baked node tests/finish_lap_cycle_probe.mjs
//
// 输出每一轮的：过线前 lap / 过线后 lap / 是否结算 / 视觉船头在线前还是线后。
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/lap-${stamp}`;
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';
const CYCLES = Number(process.env.CYCLES || 4);

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

  // 干净环境：去掉赛道约束/机关/边界，屏蔽结算界面
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
    // 每帧记录，压线那一帧好抓
    window.__rec = [];
    if (!window.__hooked) {
      window.__hooked = 1;
      const tick = () => {
        try {
          const b = g.localBoat, T = g.track;
          if (b && T) {
            const L2 = g.finishLine;
            if (!L2) { requestAnimationFrame(tick); return; }
            const gx = L2.x, gz = L2.z, d = L2;
            const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
            const half = (b.def.hull.length || 4.5) * 0.5;
            const pm = g.progressMap.get(g.myId);
            window.__rec.push({
              t: +g.raceTime.toFixed(2),
              lap: pm.lap,
              bowS: +(((b.pos.x + fx * half - gx) * d.dx + (b.pos.z + fz * half - gz) * d.dz)).toFixed(2),
              ctrS: +(((b.pos.x - gx) * d.dx + (b.pos.z - gz) * d.dz)).toFixed(2),
              fin: !!(g.finished || pm.finished),
              arcS: +((g.arcSince || 0)).toFixed(0),
              arcP: g.arcPrev == null ? null : +g.arcPrev.toFixed(1),
              bpv: g.bowPrev ? +(((g.bowPrev.x - gx) * d.dx + (g.bowPrev.z - gz) * d.dz)).toFixed(2) : null,
            });
            if (window.__rec.length > 6000) window.__rec.shift();
          }
        } catch { /* */ }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    return { laps: g.laps, openTrack: !!g.track.openTrack, loopClosed: !!g.track.loopClosed,
      lap0: g.progressMap.get(g.myId).lap, finishLine: g.finishLine, finishLaps: g.finishLaps };
  })()`).then((r) => console.log('INIT', JSON.stringify(val(r))));

  const place = `(() => {
    const g = window.__game, b = g.localBoat, T = g.track;
    const open = !!T.openTrack && !T.loopClosed;
    const idx = open ? T.gates.length - 1 : 0;
    const [gx, gz] = T.gates[idx];
    const d = open
      ? (() => { const a = T.gates[T.gates.length - 2];
          const lx = gx - a[0], lz = gz - a[1], L = Math.hypot(lx, lz) || 1;
          return { dx: lx / L, dz: lz / L }; })()
      : T.gateDir(0);
    const half = (b.def.hull.length || 4.5) * 0.5;
    b.resetTo(gx - d.dx * (16 + half), gz - d.dz * (16 + half), Math.atan2(d.dx, d.dz));
    return 1;
  })()`;

  await evaluate(`window.__noArc = ${process.env.NOARC ? 'true' : 'false'}; 1`);

  for (let c = 1; c <= CYCLES; c++) {
    await evaluate(place);
    await sleep(900);
    await evaluate(`(() => { const g = window.__game;
      if (!window.__noArc && !(g.track.openTrack && !g.track.loopClosed)) g.arcSince = g.track.arcTotal * 0.9; return 1; })()`);
    const base = val(await evaluate(`(() => { const g = window.__game, pm = g.progressMap.get(g.myId);
      return { lap: pm.lap, fin: !!(g.finished || pm.finished), arcSince: +(g.arcSince || 0).toFixed(0) }; })()`));
    await evaluate(`window.__thr = 1; 1`);
    await sleep(4200);
    await evaluate(`window.__thr = 0; 1`);
    await sleep(300);
    const after = val(await evaluate(`(() => { try {
      const g = window.__game, pm = g?.progressMap?.get(g.myId);
      if (!pm) return { lap: null, fin: true, gone: true };
      return { lap: pm.lap, fin: !!(g.finished || pm.finished) };
    } catch (e) { return { lap: null, fin: true, err: String(e) }; } })()`)) || {};
    // 这一轮里第一次「lap 变化 或 结算」的帧
    const rec = val(await evaluate(`(() => { try { return window.__rec.splice(0); }
      catch (e) { return []; } })()`)) || [];
    let at = -1;
    for (let i = 1; i < (Array.isArray(rec) ? rec.length : 0); i++) {
      if (rec[i].lap !== rec[i - 1].lap || rec[i].fin !== rec[i - 1].fin) { at = i; break; }
    }
    const arr = Array.isArray(rec) ? rec : [];
    const ctx = at >= 0 ? arr[at] : null;
    console.log(`CYCLE ${c}  lap ${base.lap} -> ${after.lap}  fin ${base.fin} -> ${after.fin}`
      + (ctx ? `   触发帧 bowS=${ctx.bowS} ctrS=${ctx.ctrS}` : `   （无事件）末帧=${JSON.stringify(arr.slice(-2))}`));
    if (after.fin) { console.log('已结算，停止'); break; }
  }
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
