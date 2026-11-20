// 起点线体检：量出起点附近各 z 截面上的"可行驶航道"横向范围，
// 用来判断旗门/黑白格线有没有"看着能过、过线不计圈"的缝隙。
//   WB_URL=http://127.0.0.1:3000/ node tests/startline_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/startline-${stamp}`);
const port = 9900 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:3000/';
const mapId = process.env.MAP || 'strait';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 120000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* not up */ }
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
  for (let i = 0; i < 12; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    if ((await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value) break;
  }
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-card[data-map]')].find((x) => x.dataset.map === ${JSON.stringify(mapId)});
    c?.click(); return 1;
  })()`);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  const t1 = Date.now();
  while (Date.now() - t1 < 90000) {
    if ((await evaluate('!!(window.__game && window.__game.track && window.__game.localBoat)')).result?.value) break;
    await sleep(300);
  }

  const out = await evaluate(`(() => {
    const g = window.__game, t = g.track;
    const N = t.gates.length;
    const limit = Number.isFinite(t.edgeOffset) ? t.edgeOffset : t.gateWidth - 0.6;
    // 点到整条门折线的最近距离（与 #probeMain 同一口径，起点附近没有近道）
    const distToTrack = (x, z) => {
      let best = Infinity;
      for (let i = 0; i < N; i++) {
        const a = t.gates[i], b = t.gates[(i + 1) % N];
        const sx = b[0] - a[0], sz = b[1] - a[1];
        const len2 = sx * sx + sz * sz || 1;
        let u = ((x - a[0]) * sx + (z - a[1]) * sz) / len2;
        u = Math.max(0, Math.min(1, u));
        const d = Math.hypot(x - (a[0] + sx * u), z - (a[1] + sz * u));
        if (d < best) best = d;
      }
      return best;
    };
    const profile = [];
    for (let z = 44; z >= 0; z -= 2) {
      let lo = null, hi = null;
      for (let x = -46; x <= 46; x += 0.25) {
        if (distToTrack(x, z) <= limit) { if (lo === null) lo = x; hi = x; }
      }
      profile.push({ z, lo: lo == null ? null : +lo.toFixed(1), hi: hi == null ? null : +hi.toFixed(1),
        width: lo == null ? 0 : +(hi - lo).toFixed(1) });
    }
    return {
      gate0: t.gates[0], gate1: t.gates[1], gateLast: t.gates[N - 1],
      gateWidth: t.gateWidth, startWidth: t.startWidth, limit: +limit.toFixed(2),
      startLineHalf: +t.startLineHalfWidth().toFixed(2),
      profile,
    };
  })()`);

  const r = out.result?.value;
  if (!r) throw new Error('no data: ' + JSON.stringify(out).slice(0, 300));
  console.log(JSON.stringify({ ...r, profile: undefined }, null, 1));
  console.log('z\t左边界\t右边界\t可行驶宽度');
  for (const row of r.profile) {
    console.log(`${row.z}\t${row.lo}\t${row.hi}\t${row.width}`);
  }
}

main().catch((e) => { console.error('ERROR', e.message); process.exitCode = 1; })
  .finally(() => { try { child.kill(); } catch { /* ignore */ } });
