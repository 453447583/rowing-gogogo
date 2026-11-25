// 一次性探针：① 排行榜多人队伍展示 ② BOSS BGM 每层轮换
// 用法：node tests/_tmp_team_lb_bgm_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3311, WS_PORT = 3412;
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/team-lb-${stamp}`);
const cdpPort = 9700 + (Number(stamp.slice(-2)) % 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    LEADERBOARD_FILE: path.resolve('.tmp_build/lb-probe-team.json'), LB_STORE: 'json' },
  stdio: 'ignore',
});
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', `http://127.0.0.1:${PORT}/`],
{ stdio: 'ignore' });

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
async function waitFor(expr, ms = 30000) {
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await waitFor(`!!window.__leaderboard && !!window.__audio`, 40000);
  await sleep(400);

  // ---- ① 4 人海克斯队 / 6 人怪物队 ----
  console.log('① 排行榜整队名单');
  await ev(`(() => {
    const p4 = [{n:'房主大黄'},{n:'青铜甲'},{n:'薄荷乙'},{n:'紫电丙'}];
    const p6 = [{n:'房主钢铁侠'},{n:'队友二'},{n:'队友三'},{n:'队友四'},{n:'队友五'},{n:'队友六'}];
    window.__leaderboard.data = { boards: {
      'hx:4': [{ n:'房主大黄', a:'', b:'skiff', c:9, t:321.5, p:p4 }],
      'bt:6': [{ n:'房主钢铁侠', a:'', b:'rower', t:521.5, p:p6 }],
      'bs:6:2': [{ n:'房主钢铁侠', a:'', b:'rower', t:66.6, p:p6 }],
    }, mine:{} };
    window.__leaderboard.tab = 'hex';
    window.__leaderboard.humans = 4;
    window.__leaderboard.open();
    return 1;
  })()`);
  await sleep(600);
  const hex = await ev(`(() => {
    const card = document.querySelector('.lb-card');
    const row = document.querySelector('.lb-row.team');
    return {
      names: [...document.querySelectorAll('.lb-row.team .lb-mate')].map(x=>x.textContent.trim()),
      hostText: document.querySelector('.lb-mate.host')?.textContent.trim() || '',
      wide: card.classList.contains('lb-wide'),
      ultra: card.classList.contains('lb-ultra'),
      width: Math.round(card.getBoundingClientRect().width),
      rowH: Math.round(row?.getBoundingClientRect().height || 0),
      overflow: !!row && row.scrollWidth > row.clientWidth + 1,
    };
  })()`);
  ok(hex.names.length === 4, '4 人队显示 4 个名字', hex);
  ok(/房/.test(hex.hostText), '房主带标记', hex);
  ok(hex.wide && !hex.ultra, '4 人中宽面板', hex);
  ok(!hex.overflow, '名字列不溢出', hex);

  await ev(`(() => { window.__leaderboard.tab='boss'; window.__leaderboard.humans=6;
    window.__leaderboard.loading=false; window.__leaderboard._render?.();
    document.querySelector('[data-lb-tab="boss"]')?.click(); return 1; })()`);
  await sleep(500);
  const boss = await ev(`(() => {
    const card = document.querySelector('.lb-card');
    return { ultra: card.classList.contains('lb-ultra'),
      width: Math.round(card.getBoundingClientRect().width),
      names: [...document.querySelectorAll('.lb-row.team .lb-mate')].map(x=>x.textContent.trim()) };
  })()`);
  ok(boss.ultra, '6 人队最宽面板', boss);
  ok(boss.names.length >= 6, '6 人队显示 6 个名字', boss);

  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.mkdir('shots/verify', { recursive: true });
  await fs.writeFile('shots/verify/leaderboard_team.jpg', Buffer.from(shot.data, 'base64'));

  // ---- ② BOSS BGM 每层换曲 ----
  console.log('② BOSS BGM 按层轮换');
  const bgm = await ev(`(() => {
    window.__audio.unlock();
    const got = [];
    for (let s=1; s<=6; s++) got.push(window.__audio.startBossBgm({ seed: 20261124, stage: s }));
    return { got, ready: window.__audio.ready, pool: window.__audio.music?.mode };
  })()`);
  ok(bgm.ready === true, '音频已解锁', bgm);
  ok(bgm.got.length === 6 && bgm.got.every((x, i) => i === 0 || x !== bgm.got[i-1]),
    '相邻层不重复', bgm);
  ok(bgm.got.every((x) => ['boss','bossHerald','bossFire','bossIron','bossDeep','bossSnow','bossFinal'].includes(x)),
    '只从 7 首 BOSS 曲里抽', bgm);
  await sleep(3000);
  const loaded = await ev(`(() => {
    const m = window.__audio.music;
    return { mode: m?.mode, sample: m?.sample === true, pending: m?.pending === true,
      buffers: window.__audio.sampleBuffers?.size || 0 };
  })()`);
  ok(loaded.sample && !loaded.pending, 'BOSS BGM MP3 已解码并在播', loaded);

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
