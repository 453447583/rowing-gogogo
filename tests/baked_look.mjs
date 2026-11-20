// 秘境漂流（baked）定点观景：把船放到指定门，用**真实追随相机**拍玩家视角。
//
//   node tests/baked_look.mjs                  # 默认几个关键门
//   node tests/baked_look.mjs 32,40,51,58,62   # 指定门号（打在中点）
//   GATE_T=0.2 node tests/baked_look.mjs 58     # 指定在门间的位置
//   TAG=fix node tests/baked_look.mjs           # 文件名前缀
//
// 为什么不用 baked_shots.mjs：那个脚本还在走旧选图页（.map-card / #btn-map-ok），
// 大厅改版后已经点不进去了。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/baked-look-${stamp}`);
const port = 9640 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const outDir = path.resolve('shots/verify');
const tag = process.env.TAG || 'look';
// 观景脚本按门号摆船，对任何地图都通用（MAP=palace 可拍真实水下玩家视角）
const mapId = process.env.MAP || 'baked';
const tPos = Number(process.env.GATE_T ?? 0.5);
const gates = (process.env.GATES || '32,40,48,52,58,60,62,70').split(',').map(Number);

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `--window-size=${process.env.SIZE || '900x520'}`, url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
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
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

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
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 600)
        || msg.params.exceptionDetails.text);
    }
    // 控制台错误也要打：开局阶段很多错误是被 try/catch 吞掉的，
    // 表现就是"点了发车没反应"，光看未捕获异常一条都看不到。
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const txt = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      console.log(`CONSOLE.${msg.params.type}`, String(txt).slice(0, 500));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 顺手把页面里的未捕获错误/未处理 Promise 记下来：开局阶段很多错误被 async 流程
  // 吞掉，表现就是"点了发车没反应 / __game 忽然没了"。
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push('ERR ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || 0)));
      addEventListener('unhandledrejection', (e) => window.__errs.push('REJ ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))));`,
  });
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  // 抽屉偶尔会点在 onlick 绑定之前（冷启动时 main.js 的模块图还没跑完），
  // 所以要"点到真的出现地图卡片"为止，而不是点一次就等。
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await sleep(400);
  // WEATHER：发车前走大厅「天气」抽屉改单人天气，用来验「非晴朗白天不生效」这类门控。
  // 注意不能改 #weather-select：大厅改版后那个下拉不再渲染选项，赋值会被吞成空串。
  if (process.env.WEATHER) {
    await evaluate('document.querySelector("#btn-lobby-weather")?.click(); 1');
    await sleep(500);
    const w = await evaluate(`(() => {
      const b = document.querySelector('[data-weather=${JSON.stringify(process.env.WEATHER)}]');
      if (!b) return 'missing';
      b.click(); return 'ok';
    })()`);
    if (w.result?.value !== 'ok') {
      throw new Error(`天气 ${process.env.WEATHER} 选不到：${w.result?.value}`);
    }
    await sleep(300);
  }
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ok = false;
  while (Date.now() - t2 < 60000) {
    if ((await evaluate('!!window.__game && !!window.__game.track')).result?.value) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) {
    const errs = await evaluate('window.__errs || []');
    console.log('页面错误:', JSON.stringify(errs.result?.value ?? errs.result ?? null));
    throw new Error('对局没起来');
  }
  await sleep(Number(process.env.WARM || 20000));   // 等 GLB 段模型落地

  await evaluate(`(() => {
    const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0;
    // 探针绝不希望比赛"真的结束"：单人模式下船停在原地也会走完各种超时/废弃判定，
    // 一旦结算，main.js 会把 Game dispose 掉，window.__game 变成 undefined，
    // 后面每一门都报 "Cannot read properties of undefined (reading 'mapDef')"。
    if (g.opts) {
      g.opts.onFinish = () => {};
      g.opts.onQuit = () => {};
    }
  })()`);

  // DIAG：临时诊断片段（返回可序列化值就打印），排查"某段的可视宽度/高度"用
  if (process.env.DIAG) {
    const r = await evaluate(process.env.DIAG);
    console.log('diag:', JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description));
  }

  for (const gi of gates) {
    const r = await evaluate(`(() => {
      const g = window.__game;
      const N = g.mapDef.gates.length;
      const a = g.mapDef.gates[${gi} % N], b = g.mapDef.gates[(${gi} + 1) % N];
      const t = ${tPos};
      const x = a[0] + (b[0] - a[0]) * t;
      const z = a[1] + (b[1] - a[1]) * t;
      const boat = g.localBoat;
      boat.resetTo(x, z, Math.atan2(b[0] - a[0], b[1] - a[1]));
      boat.speed = 0; boat.vel.set(0, 0);
      const pm = g.progressMap.get(g.myId); if (pm) { pm.gate = ${gi}; pm.lap = 1; }
      boat.diveTargetY = g.track.diveHeightAt(boat.pos, ${gi});
      boat.pos.y = boat.diveTargetY ?? boat.pos.y;
      // PRE：摆好机位之后、收敛相机之前要跑的调试片段
      ${process.env.PRE || ''}
      // 相机不用 snapTo：高差大的机位（瀑布 55m / 云端 63m）直接 snap 会让
      // 追随镜头卡在两个高度之间。这里手动以固定步长跑 180 帧，让 lerp 收敛到位。
      for (let i = 0; i < 180; i++) {
        g.cameraRig.follow(boat, 1 / 60);
      }
      return {
        x: +x.toFixed(1), z: +z.toFixed(1), y: +(boat.diveTargetY ?? 0).toFixed(1),
        camY: +g.camera.position.y.toFixed(1),
      };
    })()`);
    if (r.exceptionDetails) {
      console.log(`g${gi} EXC:`, r.exceptionDetails.exception?.description?.slice(0, 300));
      continue;
    }
    const pos = r.result?.value;
    await sleep(Number(process.env.SETTLE || 1400));
    // CANVAS=1：同一次 JS 任务里 render + toDataURL 直读画布。
    // swiftshader 下 CDP Page.captureScreenshot 拍到第 3 张必挂死（实测），所以默认走这条。
    let buf;
    if (process.env.CANVAS === '1') {
      const durl = await evaluate(`(() => { const g = window.__game;
        g.post.render(1/60);
        return g.renderer.domElement.toDataURL('image/jpeg', 0.82); })()`);
      const s = durl.result?.value;
      if (typeof s !== 'string' || !s.startsWith('data:image')) {
        console.log(`g${gi} 截图失败:`, String(s).slice(0, 120));
        continue;
      }
      buf = Buffer.from(s.slice(s.indexOf(',') + 1), 'base64');
    } else {
      const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
      buf = Buffer.from(shot.data, 'base64');
    }
    await fs.mkdir(outDir, { recursive: true });
    const f = path.join(outDir, `${mapId}-${tag}-g${gi}.jpg`);
    await fs.writeFile(f, buf);
    console.log(`g${gi}`, JSON.stringify(pos), '->', path.basename(f));
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
