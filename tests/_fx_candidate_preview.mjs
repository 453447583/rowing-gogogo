// 临时预览：把「未被尾焰使用」的候选 Effekseer 逐个渲染成图，用来挑流光号新尾焰
//   node tests/_fx_candidate_preview.mjs
// 复用 public/fx-preview.html + scripts/fx_preview_server.mjs，独立 WebGL，不碰游戏源码。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/fxcand-' + Date.now());
const cdpPort = 9395;
const httpPort = 3111;
const out = path.resolve('shots/fxcand');
await fs.mkdir(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 未登记 / 未被尾焰使用的直线光束候选 + 两段参照（当前流光、琥珀电光）
const CANDS = [
  // —— 新增光束/激光类对比 ——
  { name: 'Laser01_jet',        p: '/effects/Basic/Laser01.efkefc', map: 0, scale: 0.5 },
  { name: 'Laser02_itemBeam',   p: '/effects/Basic/Laser02.efkefc', map: 0, scale: 0.5 },
  { name: 'Laser03_missile',    p: '/effects/Basic/Laser03.efkefc', map: 0, scale: 0.5 },
  { name: 'P2_SwordLightning',  p: '/effects/P2_SwordLightning/P2_SwordLightning.efkefc', map: 1, scale: 0.5 },
  { name: 'T2_Spear1',          p: '/effects/T2_Spear1/T2_Spear1.efkefc', map: 1, scale: 0.5 },
  { name: 'N_MagicMeteor',      p: '/effects/N_MagicMeteor/N_MagicMeteor.efkefc', map: 1, scale: 0.5 },
  { name: 'LightningStrike',    p: '/effects/LightningStrike/LightningStrike.efkefc', map: 0, scale: 0.5 },
  { name: 'ef_parts_hit01',     p: '/effects/EffectMaterials/ef_parts_hit01.efkefc', map: 0, scale: 0.5 },
  { name: 'P2_SwordSacred',     p: '/effects/P2_SwordSacred/P2_SwordSacred.efkefc', map: 1, scale: 0.5 },
  // —— 上一轮已看 ——
  { name: 'ef_lightning01', p: '/effects/EffectMaterials/ef_lightning01.efkefc', map: 0, scale: 0.5 },
  { name: 'N_MagicThunder', p: '/effects/N_MagicThunder/N_MagicThunder.efkefc', map: 1, scale: 0.5 },
  { name: 'P1_Herald',      p: '/effects/P1_Herald/P1_Herald.efkefc',           map: 1, scale: 0.5 },
  { name: 'A_BlueLaser',    p: '/effects/A_BlueLaser/A_BlueLaser.efkefc',      map: 1, scale: 0.5 },
  { name: 'ef_holy01',      p: '/effects/EffectMaterials/ef_holy01.efkefc',    map: 0, scale: 0.5 },
  { name: 'T2_Light3',      p: '/effects/T2_Light3/T2_Light3.efkefc',          map: 1, scale: 0.5 },
  { name: 'REF_ef_ice02_current_dolphin', p: '/effects/EffectMaterials/ef_ice02.efkefc', map: 0, scale: 0.9 },
  { name: 'REF_ef_lightning02_vintage',   p: '/effects/EffectMaterials/ef_lightning02.efkefc', map: 0, scale: 0.6 },
];
const TIMES = [150, 400, 800]; // ms

const server = spawn(process.execPath, [path.resolve('scripts/fx_preview_server.mjs'), String(httpPort), path.join(process.cwd(), 'public')], { stdio: 'ignore' });
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch(`http://127.0.0.1:${httpPort}/fx-preview.html`); ready = r.ok; } catch { /* 等 */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('fx preview server 没起来'); }
}
const child = spawn(edge, ['--headless=new', '--use-angle=d3d11', '--no-sandbox',
  '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile, '--window-size=760,600',
  'about:blank'], { stdio: 'ignore' });

let ws;
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    await wait(200);
  }
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 60000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(200);
    }
    throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  for (const c of CANDS) {
    const url = `http://127.0.0.1:${httpPort}/fx-preview.html?p=${encodeURIComponent(c.p)}&map=${c.map}&scale=${c.scale}&y=2`;
    await cdp('Page.navigate', { url });
    await sleep(300);
    try {
      await waitFor('window.__ready === true', 60000, c.name + ' ready');
    } catch (e) {
      const meta = await ev('JSON.stringify(window.__meta ? window.__meta() : {})');
      console.error(`  ✗ ${c.name} 加载失败: ${e.message} meta=${meta}`);
      continue;
    }
    for (const ms of TIMES) {
      const ok = await ev(`window.__freeze(${ms}, 10.5)`);
      if (!ok) { console.error(`  ✗ ${c.name} @${ms}ms freeze 失败`); continue; }
      const shot = await ev(`document.getElementById('cv').toDataURL('image/jpeg', 0.86)`);
      if (typeof shot === 'string' && shot.startsWith('data:image')) {
        const f = path.join(out, `${c.name}_${ms}ms.jpg`);
        await fs.writeFile(f, Buffer.from(shot.split(',')[1], 'base64'));
        console.log(`  ✓ ${c.name} @${ms}ms`);
      } else {
        console.error(`  ✗ ${c.name} @${ms}ms 截图失败`, String(shot).slice(0, 80));
      }
    }
  }
} catch (e) {
  console.error('中断：', e.message);
} finally {
  if (child?.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  server.kill();
}
process.exit(0);
