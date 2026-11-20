// 撞墙提示验收：比赛模式触发 wall / rock 两种撞击，确认只有 wall 不弹 HUD 文字。
//   node tests/wall_notice_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/wallnotice-${stamp}`;
const port = 9945 + (Number(stamp.slice(-3)) % 20);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=900,560', 'about:blank'], { stdio: 'ignore' });
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
async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = val(await evaluate(expr)); if (last) return last; await sleep(250); }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}
try {
  let info;
  for (let i = 0; i < 160; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ } await sleep(150); }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="canyon"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="canyon"]').click(); 1`);
  await sleep(300);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);
  await sleep(600);

  const results = [];
  for (const kind of ['wall', 'rock', 'buoy', 'missile']) {
    const r = val(await evaluate(`(async () => {
      const g = window.__game, b = g.localBoat;
      // 先清掉可能残留的提示
      g.notice = null; g.noticeTtl = 0; g.noticePending = null; g.noticeCooldown = 0;
      const K = ${JSON.stringify(kind)};
      if (K === 'wall') b.wallHitSpeed = 12;
      else b.lastHardHit = { kind: K };
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
      const out = { kind: K, notice: g.notice ? { main: g.notice.main, sub: g.notice.sub } : null,
        hudText: document.querySelector('#assist-chip')?.textContent?.trim() || null };
      g.notice = null; g.noticeTtl = 0;
      return out;
    })()`));
    results.push(r);
    console.log(JSON.stringify(r));
  }
  const ok = !results.find((r) => r.kind === 'wall').notice
    && !!results.find((r) => r.kind === 'rock').notice
    && !!results.find((r) => r.kind === 'buoy').notice
    && !!results.find((r) => r.kind === 'missile').notice;
  console.log(ok ? 'wall notice probe: PASS' : 'wall notice probe: FAIL');
  process.exitCode = ok ? 0 : 2;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
