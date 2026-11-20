// 赛道进度探针：进度条必须是「按圈数比例」，不是「整条赛道跑完就 100%」
//
//   node tests/lap_progress_probe.mjs            # 霓虹海峡（作者配 1 圈，单人固定跑 3 圈）
//   MAP=canyon node tests/lap_progress_probe.mjs
//
// 用户反馈：HUD 明明显示 3 圈，跑完第 1 圈进度条就 100%。
// 根因：分母用的是地图作者默认圈数（strait = 1），不是本局实际圈数（3）。
// 本探针直接读 HUD 上的百分比，逐档核对 0 / 17 / 33 / 50 / 66 / 100。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/lapprog-${stamp}`;
const port = 9660 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

let failed = 0;
try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
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
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
  await sleep(500);

  const meta = val(await evaluate(`(() => {
    const g = window.__game;
    return { mapId: g.mapDef.id, laps: g.laps, finishLaps: g.finishLaps, mapDefaultLaps: g.track.laps };
  })()`));
  console.log('race laps =', JSON.stringify(meta));

  // 发车瞬间（还没动）：进度必须是 0%。发车格在起点线**后方** 4m，
  // 按绝对弧长算是"上一圈的 99%"，不做 lapArc 补偿的话一开局就 33%（3 圈图）。
  {
    const spawn = val(await evaluate(`(() => {
      const g = window.__game, pm = g.progressMap.get(g.myId);
      return { lap: pm.lap, lapArc: +pm.lapArc.toFixed(1), arcTotal: +g.track.arcTotal.toFixed(1),
        text: document.querySelector('#hud-progress-text .pt-num')?.textContent.trim() };
    })()`));
    const pct = parseFloat(String(spawn?.text).replace(/[^\d.]/g, ''));
    const ok = Math.abs(pct) <= 1.0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  spawn (发车格，线后 4m)  shown=${pct}%  expect≈0%  lapArc=${spawn?.lapArc}/${spawn?.arcTotal}`);
  }

  // 逐档核对：lap + 位置（0 = 起点线 / 0.5 = 赛道一半弧长）
  const cases = [
    { lap: 1, at: 0, expect: 0 },
    { lap: 1, at: 0.5, expect: 100 / 3 / 2 },
    { lap: 2, at: 0, expect: 100 / 3 },
    { lap: 2, at: 0.5, expect: 50 },
    { lap: 3, at: 0, expect: 200 / 3 },
    { lap: 4, at: 0, expect: 100 },
  ];
  const readings = [];
  for (const c of cases) {
    const r = await evaluate(`(function(){
      const g = window.__game, tr = g.track, b = g.localBoat;
      const pm = g.progressMap.get(g.myId);
      pm.lap = ${c.lap};
      pm.lapArc = 0;   // 这一组测的是"从起点线算"，发车偏移由上面那条单独验
      pm.lapArc = 0;   // 这一组测的是"从起点线算"，发车偏移由上面那条单独验
      const arc = tr.arcTotal * ${c.at};
      // 按弧长找点：沿 gates 折线累加
      const N = tr.gates.length;
      const segs = (tr.openTrack && !tr.loopClosed) ? N - 1 : N;
      let acc = 0, px = tr.gates[0][0], pz = tr.gates[0][1];
      for (let i = 0; i < segs; i++) {
        const a = tr.gates[i], b2 = tr.gates[(i + 1) % N];
        const L = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
        if (acc + L >= arc) {
          const k = (arc - acc) / (L || 1);
          px = a[0] + (b2[0] - a[0]) * k;
          pz = a[1] + (b2[1] - a[1]) * k;
          break;
        }
        acc += L;
        px = b2[0]; pz = b2[1];
      }
      b.pos.set(px, 0, pz);
      b.speed = 0;
      return { x: px, z: pz };
    })()`);
    await sleep(200);
    const shown = val(await evaluate(`(() => {
      const el = document.querySelector('#hud-progress-text .pt-num');
      const bar = document.querySelector('#hud-progress-bar');
      return { text: el ? el.textContent.trim() : '', width: bar ? bar.style.width : '' };
    })()`));
    const got = parseFloat(String(shown?.text).replace(/[^\d.]/g, ''));
    readings.push({ ...c, got, width: shown?.width, pos: r });
  }

  let bad = 0;
  for (const r of readings) {
    const ok = Number.isFinite(r.got) && Math.abs(r.got - r.expect) <= 1.5;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  lap=${r.lap} at=${r.at}  shown=${r.got}%  expect≈${r.expect.toFixed(0)}%  bar=${r.width}`);
  }
  failed = bad;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
console.log(failed === 0 ? 'lap progress probe: PASS' : `lap progress probe: ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
