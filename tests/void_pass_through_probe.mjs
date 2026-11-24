// 验证受击艇变影子后，其他艇能穿过去（船对船碰撞被跳过）。
// 单人道具赛 + 1 AI：把 AI 变 void 影子停住，把本地艇瞬移到 AI 身上，
// 跑若干帧后看本地艇是否被弹开（速度反向/位置分离）。
//   WB_URL=http://127.0.0.1:5199/ node tests/void_pass_through_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/void-passthrough-${stamp}`);
const port = 9980 + (Number(stamp.slice(-3)) % 20);
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
  await evaluate(`(() => { const s=document.getElementById('sel-ai'); if(s){s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}));} return 1; })()`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (val(await evaluate(`!!(window.__game && window.__game.localBoat && window.__game.phase === 'racing')`))) break;
    await sleep(300);
  }
  await evaluate(`(() => { const g=window.__game; g.intro=0; g.cinema=0; g.countdownLeft=0; return 1; })()`);
  await sleep(600);

  const id = val(await evaluate(`[...window.__game.boats.keys()].find((k)=>k!=='me')`));
  if (!id) { console.log('FAIL no AI'); return; }

  // A) 对照组：不 void，把本地艇放到 AI 身上，看是否被弹开
  const baseline = val(await evaluate(`(() => {
    const g=window.__game, me=g.localBoat, ai=g.boats.get(${JSON.stringify(id)});
    me.pos.x=ai.pos.x; me.pos.z=ai.pos.z; me.vel.set(0,0); me.speed=0;
    return { d: +Math.hypot(me.pos.x-ai.pos.x, me.pos.z-ai.pos.z).toFixed(2) };
  })()`));
  await sleep(500);
  const baselineAfter = val(await evaluate(`(() => {
    const g=window.__game, me=g.localBoat, ai=g.boats.get(${JSON.stringify(id)});
    return { d: +Math.hypot(me.pos.x-ai.pos.x, me.pos.z-ai.pos.z).toFixed(2),
             speed: +me.speed.toFixed(2) };
  })()`));
  console.log('BASELINE(无void,应被弹开):', JSON.stringify(baseline), '->', JSON.stringify(baselineAfter));

  // B) 实验组：AI 变 void 影子，再把本地艇放到它身上，看是否穿过（不被弹开）
  const exp = val(await evaluate(`(() => {
    const g=window.__game, me=g.localBoat, ai=g.boats.get(${JSON.stringify(id)});
    ai.applyFx('void', 3);
    me.pos.x=ai.pos.x; me.pos.z=ai.pos.z; me.vel.set(0,0); me.speed=0;
    return { d: +Math.hypot(me.pos.x-ai.pos.x, me.pos.z-ai.pos.z).toFixed(2),
             aiVoid: +ai.voidTimer.toFixed(2) };
  })()`));
  await sleep(600);
  const expAfter = val(await evaluate(`(() => {
    const g=window.__game, me=g.localBoat, ai=g.boats.get(${JSON.stringify(id)});
    return { d: +Math.hypot(me.pos.x-ai.pos.x, me.pos.z-ai.pos.z).toFixed(2),
             speed: +me.speed.toFixed(2), aiVoid: +ai.voidTimer.toFixed(2) };
  })()`));
  console.log('EXPERIMENT(void影子,应穿过):', JSON.stringify(exp), '->', JSON.stringify(expAfter));

  const pushedBaseline = baselineAfter.d - baseline.d;
  const pushedExp = expAfter.d - exp.d;
  console.log(`分离量: 无void=${pushedBaseline.toFixed(2)}m, void影子=${pushedExp.toFixed(2)}m`);
  console.log(pushedBaseline > 0.3 && Math.abs(pushedExp) < 0.2
    ? 'PASS: 普通艇会弹开，void 影子可穿过'
    : 'CHECK: 结果需人工确认（AI 自身也在移动会带来噪声）');
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
