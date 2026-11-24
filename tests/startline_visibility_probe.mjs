// 起点线可见性探针：进指定地图，俯拍起点线 + 输出水面相位/起点线高度数值。
//   MAP=baked WB_URL=http://127.0.0.1:5199/ node tests/startline_visibility_probe.mjs
// 只读验证，不改源码。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/startline-vis-${stamp}`);
const port = 9920 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'baked';
const weather = process.env.WEATHER || '';
const out = path.resolve(`shots/verify/startline-${mapId}.jpg`);

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
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(1200);
  for (let i = 0; i < 12; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    if ((await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value) break;
  }
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-card[data-map]')].find((x) => x.dataset.map === ${JSON.stringify(mapId)});
    c?.click(); return 1;
  })()`);
  if (weather) {
    await evaluate('document.querySelector("#btn-lobby-weather")?.click(); 1');
    await sleep(700);
    await evaluate(`(() => {
      const c = [...document.querySelectorAll('[data-weather]')].find((x) => x.dataset.weather === ${JSON.stringify(weather)});
      c?.click(); return 1;
    })()`);
    await sleep(400);
  }
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if ((await evaluate('!!(window.__game && window.__game.track && window.__game.localBoat)')).result?.value) break;
    await sleep(300);
  }
  // 跳过开场镜头，稳定到 racing
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0;
    if (g.intro) g.intro=0; if (g.cinema) g.cinema=0; return 1; })()`);
  await sleep(800);

  const dom = await evaluate(`(() => {
    const g = window.__game, t = g.track;
    const line = t.startLine;
    const gate = t.gates[0];
    const attr = line.geometry.attributes.position;
    const ys = [];
    for (let i = 0; i < attr.count; i++) ys.push(attr.getY(i));
    // 找所有复用主水面材质的网格，验证新相位公式对两种情况都正确
    const waterMeshes = [];
    g.scene.traverse((o) => {
      const u = o.material?.uniforms;
      if (!u?.uCenter) return;
      const m = o.matrixWorld.elements;
      const p = o.geometry?.attributes?.position;
      if (!p) return;
      const lx = p.getX(0), lz = p.getZ(0);
      const wx = m[0]*lx + m[4]*p.getY(0) + m[8]*lz + m[12];
      const wz = m[2]*lx + m[6]*p.getY(0) + m[10]*lz + m[14];
      waterMeshes.push({
        name: o.name || '(unnamed)',
        meshPos: [+m[12].toFixed(1), +m[14].toFixed(1)],
        uCenter: [+u.uCenter.value.x.toFixed(1), +u.uCenter.value.y.toFixed(1)],
        firstLocalXZ: [+lx.toFixed(1), +lz.toFixed(1)],
        firstWorldXZ: [+wx.toFixed(1), +wz.toFixed(1)],
        oldPhaseXZ: [+(lx + u.uCenter.value.x).toFixed(1), +(lz + u.uCenter.value.y).toFixed(1)],
        newPhaseXZ: [+wx.toFixed(1), +wz.toFixed(1)],
      });
    });
    return {
      map: g.mapDef.id,
      mapName: g.mapDef.name,
      gate0: gate,
      gate1: t.gates[1],
      gate2: t.gates[2],
      startLineCount: attr.count,
      startLineY: { min: +Math.min(...ys).toFixed(2), max: +Math.max(...ys).toFixed(2) },
      waterMeshes: waterMeshes.slice(0, 8),
    };
  })()`);
  console.log('measure:', JSON.stringify(dom.result?.value, null, 1));

  // 同一任务内设相机 + 渲染 + 读像素，避免 game loop 把相机改回去
  const dataUrl = await evaluate(`(() => {
    const g = window.__game;
    const [x, z] = g.track.gates[0];
    const [x1, z1] = g.track.gates[1];
    // 沿 0→1 门向量的反方向架机位，从发车格正后方低角度看起点线（拱顶 7.6m）
    const dx = x1 - x, dz = z1 - z, len = Math.hypot(dx, dz) || 1;
    const fx = dx / len, fz = dz / len;
    g.camera.position.set(x - fx * 13, 3.5, z - fz * 13);
    g.camera.lookAt(x, 0, z);
    g.camera.updateMatrixWorld();
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.92);
  })()`);
  const v = dataUrl.result?.value;
  if (typeof v !== 'string' || !v.startsWith('data:image')) throw new Error('截图失败: ' + String(v).slice(0, 200));
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
  console.log('ok ->', out);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
