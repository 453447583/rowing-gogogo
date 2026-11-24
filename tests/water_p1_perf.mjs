// P1 的帧成本验收：同一局里对比"道具倒影通道 开 / 关"的平均帧时间与 p95。
// 只关这一项（setReflectProps([]) → pass 直接跳过），其它 P1 项保持开启，
// 这样测到的就是那一次低分辨率 pass 的真实代价。
//
//   node tests/water_p1_perf.mjs            # ocean / day
//   MAP=ocean WEATHER=storm node tests/water_p1_perf.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-perf-${stamp}`);
const port = 9820 + (Number(stamp.slice(-3)) % 90);
const MAP = process.env.MAP || 'ocean';
const WEATHER = process.env.WEATHER || '';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

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

async function waitFor(expr, timeout = 120000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

async function main() {
  let tabs;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { tabs = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5199/?raceIntro=0' });
  await sleep(4500);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${MAP}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${MAP}"]').click(); 1`);
  await sleep(300);
  if (WEATHER) {
    await evaluate(`document.querySelector('#btn-lobby-weather').click(); 1`);
    await waitFor(`!!document.querySelector('[data-weather="${WEATHER}"]')`, 30000);
    await evaluate(`document.querySelector('[data-weather="${WEATHER}"]').click(); 1`);
    await sleep(300);
  }
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`window.__game?.phase === 'racing'`, 150000);
  await evaluate(`(() => {
    const g = window.__game;
    const inp = g.opts?.input;
    if (inp) { inp.clear = () => {}; inp.keys.add('w'); }
    return 1;
  })()`);
  await sleep(2500);

  const measure = `(async () => {
    const g = window.__game;
    const times = [];
    let last = performance.now();
    await new Promise((res) => {
      const tick = (now) => {
        times.push(now - last); last = now;
        if (times.length >= 190) res(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    return {
      avg: +avg.toFixed(2),
      p50: +times[Math.floor(times.length * 0.5)].toFixed(2),
      p95: +times[Math.floor(times.length * 0.95)].toFixed(2),
      fps: +(1000 / avg).toFixed(1),
    };
  })()`;

  const on = await evaluate(measure);
  await evaluate(`window.__game.water.setReflectProps([]); 1`);
  await sleep(400);
  const off = await evaluate(measure);
  // 复位，别影响后面的检查
  await evaluate(`window.__game.water.setReflectProps([window.__game.localBoat.group]); 1`);

  // 帧时间被 vsync 锁在 60fps，看不出这几十个 draw call 的代价，补一个 draw call 计数
  const dcRes = await evaluate(`(() => {
    const g = window.__game, info = g.renderer.info;
    const prev = info.autoReset;
    info.autoReset = false;
    const count = (withProps) => {
      if (withProps) g.water.setReflectProps([g.localBoat.group]);
      else g.water.setReflectProps([]);
      info.reset();
      if (withProps) g.water.renderPropReflection(g.renderer, g.scene, g.camera);
      g.post.render(1 / 60);
      return { calls: info.render.calls, tris: info.render.triangles };
    };
    const a2 = count(true), b2 = count(false);
    info.autoReset = prev;
    g.water.setReflectProps([g.localBoat.group]);
    return { on: a2, off: b2 };
  })()`);
  const dc = dcRes?.result?.value;
  if (dc) {
    console.log(`draw call: 开=${dc.on.calls} 关=${dc.off.calls} (+${dc.on.calls - dc.off.calls})  ` +
      `三角形: 开=${dc.on.tris} 关=${dc.off.tris} (+${dc.on.tris - dc.off.tris})`);
  }
  const a = on?.result?.value; const b = off?.result?.value;
  if (!a || !b) { console.error('FAIL', JSON.stringify(on?.exceptionDetails?.exception?.description || on).slice(0, 300)); return; }
  console.log(`${MAP}/${WEATHER || 'day'}  倒影开: avg=${a.avg}ms p95=${a.p95}ms ${a.fps}fps`);
  console.log(`${MAP}/${WEATHER || 'day'}  倒影关: avg=${b.avg}ms p95=${b.p95}ms ${b.fps}fps`);
  console.log(`道具倒影通道成本: ${(a.avg - b.avg).toFixed(2)}ms/帧 (${((a.avg - b.avg) / b.avg * 100).toFixed(1)}%)`);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(500);
  process.exit();
});
