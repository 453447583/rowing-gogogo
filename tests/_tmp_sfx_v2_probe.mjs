// 一次性探针：21 条 V2 音效能否经 HTTP 取到并在 WebAudio 里解码/试播
// 用法：node tests/_tmp_sfx_v2_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3311, WS_PORT = 3412;
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/sfxv2-${stamp}`);
const cdpPort = 9810 + (Number(stamp.slice(-2)) % 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYS = [
  'boss_herald_charge', 'boss_herald_roar', 'boss_herald_sweep', 'boss_herald_blink',
  'boss_herald_sword', 'boss_fire_breath', 'boss_lava_wave', 'boss_tail_sweep',
  'boss_dive', 'boss_magma_chess', 'boss_sword_slash', 'boss_thunder_strike',
  'boss_pull', 'boss_blood_curse', 'boss_frost_breath', 'boss_gate_open',
  'boss_rage', 'boss_minion_spawn', 'boss_vortex_warn', 'boss_vortex_hit', 'hex_card_offer',
];

async function waitHttp(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}
async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/lb-probe-sfxv2.json'), LB_STORE: 'json' },
  stdio: 'ignore',
});
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1000,700', `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp timeout ' + method)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};
async function waitFor(expr, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(200); }
  throw new Error('waitFor timeout: ' + expr);
}
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

async function main() {
  await waitHttp(`http://127.0.0.1:${PORT}/`);
  const tabs = await waitJson(`http://127.0.0.1:${cdpPort}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await waitFor(`!!window.__audio`);
  await ev(`window.__audio.unlock(); 1`);
  await sleep(500);

  const out = await ev(`(async () => {
    const keys = ${JSON.stringify(KEYS)};
    const ctx = window.__audio.ctx;
    const decoded = [], failed = [], played = [];
    for (const k of keys) {
      const url = '/audio/sfx/' + k + '.wav';
      try {
        const res = await fetch(url);
        if (!res.ok) { failed.push(k + ' HTTP ' + res.status); continue; }
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        decoded.push([k, +buf.duration.toFixed(2), buf.sampleRate, buf.numberOfChannels]);
      } catch (e) { failed.push(k + ': ' + e.message); continue; }
      try { window.__audio.play(k, { gap: 0 }); played.push(k); }
      catch (e) { failed.push(k + ' play: ' + e.message); }
    }
    return { decoded, failed, played, ready: window.__audio.ready };
  })()`);

  ok(out.ready === true, 'AudioContext 已就绪', { ready: out.ready });
  ok(out.failed.length === 0, '21 条全部可取到并解码', out.failed);
  ok(out.decoded.length === 21 && out.played.length === 21, '21 条全部可试播', {
    decoded: out.decoded.length, played: out.played.length,
  });
  const bad = out.decoded.filter(([, d, sr, ch]) => sr !== 48000 || ch !== 1 || d < 0.5);
  ok(bad.length === 0, '采样率/声道/时长正确', bad);
  console.log(JSON.stringify(out.decoded));
  console.log(failures ? `FAIL ${failures}` : 'PASS');
  if (failures) process.exitCode = 1;
}
main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    child.kill(); server.kill();
    await sleep(300);
    process.exit(process.exitCode || 0);
  });
