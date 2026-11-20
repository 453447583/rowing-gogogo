// BOSS 模式第 2 关（珊瑚浅海）远景岛树木验收：确认岛上用的是松树 GLB 而不是卡通棕榈。
//   node tests/boss_tree_shot.mjs [stage]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const STAGE = Number(process.argv[2] || 2);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/boss-tree-${stamp}`);
const port = 9600 + (Number(stamp.slice(-3)) % 100);
const url = process.env.WB_URL || 'http://127.0.0.1:5273/';
const outDir = path.resolve('shots/verify');
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function waitForJson(u, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${u}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
async function waitExpr(expr, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evaluate(`!!(${expr})`);
    if (r.result?.value) return true;
    await sleep(250);
  }
  return false;
}
async function shot(name) {
  const s = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(outDir, `boss-tree-${name}.png`), Buffer.from(s.data, 'base64'));
  console.log('saved', name);
}

async function main() {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = tabs.find((t) => t.type === 'page' && /5273|5173/.test(t.url))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(1200);

  console.log('booted:', await waitExpr(`document.querySelector('#btn-solo')?.onclick`, 30000));
  await evaluate(`document.querySelector('#btn-solo').click()`);
  await sleep(900);
  if (await waitExpr(`document.querySelector('#boat-list .boat-card')`, 8000)) {
    await evaluate(`document.querySelector('#boat-list .boat-card').click()`);
    await sleep(400);
  }
  await waitExpr(`document.querySelector('.map-card')`, 20000);
  // 切到怪物模式再确认出战
  const entered = await evaluate(`(() => {
    const m = document.querySelector('#mode-select');
    if (!m) return 'no-mode-select';
    m.value = 'boss';
    m.dispatchEvent(new Event('change'));
    document.querySelector('#btn-map-ok').click();
    return 'ok';
  })()`);
  console.log('enter:', entered.result?.value);
  await sleep(11000);

  const boot = await evaluate(`JSON.stringify({ map: window.__game?.mapDef?.id, boss: !!window.__game?.bossMode })`);
  console.log('boot', boot.result?.value);

  await evaluate(`(() => { const b = window.__game?.bossMode; if (b) { b.introT = 99; b.countdown = 0.02; } })()`);
  await sleep(1500);

  // 直接切到目标关（setTheme 是公开方法）
  const themed = await evaluate(`(() => {
    const g = window.__game;
    if (!g?.themes) return 'no-themes';
    g.themes.setTheme(${STAGE});
    return g.themes.current;
  })()`);
  console.log('theme:', themed.result?.value);
  await sleep(2500);

  // 统计主题组里的树实例 + 是否还有旧的锥形棕榈
  const stats = await evaluate(`(() => {
    const g = window.__game;
    const grp = g.themes?.group;
    if (!grp) return null;
    let pineInstanced = 0;
    let legacyCones = 0;
    grp.traverse((o) => {
      if (o.isInstancedMesh && /pine/.test(o.name)) pineInstanced += o.count;
      // 旧棕榈 = ConeGeometry(2.6,1.1,5) 那四片叶子
      if (o.isMesh && o.geometry?.parameters?.radius === 2.6
        && o.geometry?.parameters?.height === 1.1) legacyCones++;
    });
    return { pineInstanced, legacyCones, kids: grp.children.length };
  })()`);
  console.log('theme stats:', JSON.stringify(stats.result?.value));

  // 拉相机看远景岛（岛半径 175~245m）
  await evaluate(`(() => {
    const g = window.__game;
    const rig = g.cameraRig;
    if (rig) { rig.follow = () => {}; rig.followLookAt = () => {}; rig.snapTo = () => {}; }
    const cam = g.camera;
    const b = g.localBoat;
    cam.position.set(b ? b.pos.x : 0, 26, b ? b.pos.z : 0);
    cam.lookAt(0, 18, 200);
  })()`);
  await sleep(2200);
  await shot(`stage${STAGE}-islands`);

  ws.close();
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  child.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
