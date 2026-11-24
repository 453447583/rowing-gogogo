// 远端受击艇状态探针：单人道具赛里给一艘 AI 艇施加 void，
// 验证它在别人眼里「留在赛道可见 + 冻结 + 头顶晕眩金星」，并截图。
//   WB_URL=http://127.0.0.1:5199/ node tests/void_remote_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/void-remote-${stamp}`);
const port = 9960 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';

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
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r.result?.value;

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
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
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if (val(await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")'))) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1200);
  // 加一个 AI 对手（单人默认 0 AI）
  await evaluate(`(() => { const s=document.getElementById('sel-ai'); if(s){s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));} return 1; })()`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (val(await evaluate(`!!(window.__game && window.__game.localBoat && window.__game.phase === 'racing')`))) break;
    await sleep(300);
  }
  await evaluate(`(() => { const g=window.__game; g.intro=0; g.cinema=0; g.countdownLeft=0; return 1; })()`);
  await sleep(700);

  const boats = val(await evaluate(`(() => {
    const g = window.__game;
    return [...g.boats.keys()];
  })()`));
  console.log('boats:', JSON.stringify(boats));
  const targetId = (boats || []).find((id) => id !== 'me');
  if (!targetId) { console.log('FAIL: 没有 AI 对手艇'); return; }

  // 对 AI 艇施加 void（远端表现路径）
  const before = val(await evaluate(`(() => {
    const g = window.__game, b = g.boats.get(${JSON.stringify(targetId)});
    return { visible: b.group.visible, pos: [+b.pos.x.toFixed(1), +b.pos.z.toFixed(1)],
             voidTimer: b.voidTimer, dizzy: !!b.dizzyMark };
  })()`));
  console.log('before:', JSON.stringify(before));

  await evaluate(`(() => {
    const g = window.__game, b = g.boats.get(${JSON.stringify(targetId)});
    b.applyFx('void', 3);
    return 1;
  })()`);
  await sleep(900);

  const after = val(await evaluate(`(() => {
    const g = window.__game, b = g.boats.get(${JSON.stringify(targetId)});
    // 统计影子材质：遍历艇的 mesh，看有多少个 transparent + opacity<1
    let shadowMeshes = 0, totalMeshes = 0, minOpacity = 1;
    (b.modelRoot || b.group).traverse((o) => {
      if (!o.isMesh) return;
      totalMeshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && m.transparent && m.opacity < 1) {
          shadowMeshes++;
          minOpacity = Math.min(minOpacity, m.opacity);
        }
      }
    });
    return { visible: b.group.visible, pos: [+b.pos.x.toFixed(1), +b.pos.z.toFixed(1)],
             voidTimer: +b.voidTimer.toFixed(2), dizzy: !!b.dizzyMark,
             dizzyVisible: b.dizzyMark ? b.dizzyMark.visible : null,
             starCount: b.dizzyMark ? b.dizzyMark.children.length : 0,
             shadowMeshes, totalMeshes, minOpacity: +minOpacity.toFixed(2),
             voidShadowOn: !!b._voidShadowOn };
  })()`));
  console.log('after:', JSON.stringify(after));

  // 把相机对准这艘 AI 艇拍特写
  await evaluate(`(() => {
    const g = window.__game, b = g.boats.get(${JSON.stringify(targetId)});
    g.camera.position.set(b.pos.x, b.pos.y + 6, b.pos.z + 10);
    g.camera.lookAt(b.pos.x, b.pos.y + 1.5, b.pos.z);
    g.camera.updateMatrixWorld();
    g.post.render(1/60);
    return 1;
  })()`);
  const shot = val(await evaluate(`(() => { const g=window.__game; g.post.render(1/60); return g.renderer.domElement.toDataURL('image/jpeg',0.92); })()`));
  if (typeof shot === 'string' && shot.startsWith('data:image')) {
    await fs.mkdir(path.resolve('shots/verify'), { recursive: true });
    await fs.writeFile(path.resolve('shots/verify/void-remote-dizzy.jpg'), Buffer.from(shot.slice(shot.indexOf(',') + 1), 'base64'));
    console.log('ok -> void-remote-dizzy');
  }

  // 到期：影子材质应恢复（transparent/opacity 回到原值），星星收起，速度 0 从起步
  await evaluate(`(() => { const g=window.__game, b=g.boats.get(${JSON.stringify(targetId)}); b.voidTimer = 0.01; return 1; })()`);
  await sleep(700);
  const restored = val(await evaluate(`(() => {
    const g = window.__game, b = g.boats.get(${JSON.stringify(targetId)});
    let shadowMeshes = 0, minOpacity = 1;
    (b.modelRoot || b.group).traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m && m.transparent && m.opacity < 1) {
        shadowMeshes++; minOpacity = Math.min(minOpacity, m.opacity);
      }
    });
    return { voidTimer: +b.voidTimer.toFixed(2), voidShadowOn: !!b._voidShadowOn,
             shadowMeshes, minOpacity, speed: +b.speed.toFixed(2),
             dizzyVisible: b.dizzyMark ? b.dizzyMark.visible : null,
             visible: b.group.visible };
  })()`));
  console.log('restored:', JSON.stringify(restored));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
