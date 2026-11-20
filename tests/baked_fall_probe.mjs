// 秘境漂流：掉落 / 起飞 / 镜头 三项行为验收
//   node tests/baked_fall_probe.mjs
//
// 为什么这么测：
//   ① 无头软件光栅只有 1~3 fps，靠"真的开过去"要等几分钟，而且 dt 一大物理就不准；
//      这里直接把船摆到目标门、把状态位摆好，再看下一帧的结果 —— 测的是判定逻辑本身。
//   ② "冲出边缘" 必须用真几何验：把人放在中线上 9.5m 处跑一次 track.constrain，
//      看护栏是不是真的放行（overEdge），而不是靠看截图猜。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/baked-fall-${stamp}`);
const port = 9590 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=760,440', url,
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
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400) || 'eval failed');
  return r.result?.value;
};

let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}`, JSON.stringify(detail ?? null)); }
}

async function waitForJson(u, timeout = 25000) {
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
      console.log('EXC', msg.params.exceptionDetails.exception?.description?.slice(0, 400));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(700);
    cardsReady = await evaluate('!!document.querySelector(".lp-card[data-map]")');
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  await evaluate(`(() => {
    const c = [...document.querySelectorAll('.lp-card[data-map]')].find(x => x.dataset.map === 'baked');
    c?.click();
  })()`);
  await sleep(600);
  // 发车最多点三次：冷启动时按钮的 onclick 可能还没挂上（点了等于没点），
  // 这里以"真的出现 __game"为收敛条件，而不是点一次就死等。
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt++) {
    await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
    const t2 = Date.now();
    while (Date.now() - t2 < 70000) {
      if (await evaluate('!!window.__game && !!window.__game.track')) { booted = true; break; }
      await sleep(400);
    }
  }
  if (!booted) throw new Error('对局没起来（点了 3 次发车）');
  await evaluate(`(() => { const g = window.__game; g.phase = 'racing'; g.countdownLeft = 0; })()`);
  await sleep(Number(process.env.WARM || 16000));

  // ---------- 1. 悬崖边缘：护栏必须放行 ----------
  const edgeOut = await evaluate(`(() => {
    const g = window.__game;
    const t = g.track;
    const N = g.mapDef.gates.length;
    // 悬崖段门号从地图数据读，赛道一改布局这里不用跟着改
    const i = t.edgeDrops && t.edgeDrops[0] ? t.edgeDrops[0].from + 2 : 44;
    const a = g.mapDef.gates[i], b = g.mapDef.gates[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    const x = a[0] + nx * 9.5, z = a[1] + nz * 9.5;
    const boat = g.localBoat;
    boat.resetTo(x, z, Math.atan2(dx, dz));
    boat.isAi = false;
    boat.airborne = false; boat.waveJump = false;
    boat.overEdge = 0; boat.fallTimer = 0;
    boat.pos.y = t.gateY[i];
    const before = { x: boat.pos.x, z: boat.pos.z };
    // 直接跑一次护栏：边缘外 9.5m > edge 8.2，应该放行而不是推回
    t.constrain(boat);
    return {
      moved: +Math.hypot(boat.pos.x - before.x, boat.pos.z - before.z).toFixed(2),
      overEdge: +(boat.overEdge || 0).toFixed(2),
      edgeDrops: (t.edgeDrops || []).length,
    };
  })()`);
  check('云端平台外侧不再被护栏推回', edgeOut.moved < 0.05, edgeOut);
  check('冲出边缘会打上 overEdge 标记', edgeOut.overEdge > 0, edgeOut);

  // ---------- 2. 护栏内侧仍然拦得住 ----------
  const edgeIn = await evaluate(`(() => {
    const g = window.__game;
    const t = g.track;
    const i = t.edgeDrops && t.edgeDrops[0] ? t.edgeDrops[0].from + 2 : 44;
    const a = g.mapDef.gates[i], b = g.mapDef.gates[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L, nz = dx / L;
    const x = a[0] + nx * 6.2, z = a[1] + nz * 6.2;   // 护栏以内
    const boat = g.localBoat;
    boat.resetTo(x, z, Math.atan2(dx, dz));
    boat.airborne = false; boat.overEdge = 0;
    const before = { x: boat.pos.x, z: boat.pos.z };
    t.constrain(boat);
    return {
      moved: +Math.hypot(boat.pos.x - before.x, boat.pos.z - before.z).toFixed(2),
      overEdge: +(boat.overEdge || 0).toFixed(2),
    };
  })()`);
  check('护栏以内正常行驶不被推动', edgeIn.moved < 0.35 && edgeIn.overEdge === 0, edgeIn);

  // ---------- 3. 掉落 → 闪烁 → 归位 ----------
  await evaluate(`(() => {
    const g = window.__game;
    const boat = g.localBoat;
    const i = g.track.edgeDrops && g.track.edgeDrops[0] ? g.track.edgeDrops[0].from + 2 : 44;
    const a = g.mapDef.gates[i], b = g.mapDef.gates[i + 1];
    boat.resetTo(a[0], a[1], Math.atan2(b[0] - a[0], b[1] - a[1]));
    boat.pos.y = g.track.gateY[i];
    const pm = g.progressMap.get(g.myId); if (pm) pm.gate = i + 1;
    boat.overEdge = 0.2;      // 模拟"刚冲出边缘"
    boat.fallTimer = 0;
    window.__fallTrace = { seenFall: false, seenBlink: false, yMin: boat.pos.y };
  })()`);
  // 坠落 1.05s 游戏时间；无头下 dt 被钳到 50ms/帧，掉满要 20 帧上下 ——
  // 1~3fps 的软件光栅就是十几秒墙钟，所以轮询窗口给到 25s。
  for (let i = 0; i < 250; i++) {
    const s = await evaluate(`(() => {
      const g = window.__game; const b = g.localBoat;
      const t = window.__fallTrace;
      if (b.fallTimer > 0) t.seenFall = true;
      if (b.blinkTimer > 0) t.seenBlink = true;
      t.yMin = Math.min(t.yMin, b.pos.y);
      return { fall: +b.fallTimer.toFixed(2), blink: +b.blinkTimer.toFixed(2), y: +b.pos.y.toFixed(1), vis: b.group.visible };
    })()`);
    if (i > 4 && s.fall === 0 && (await evaluate('window.__fallTrace.seenFall'))) break;
    await sleep(100);
  }
  const trace = await evaluate('window.__fallTrace');
  check('掉落会进入坠落状态', trace.seenFall === true, trace);
  check('坠落过程中艇身会闪烁', trace.seenBlink === true, trace);
  check('坠落高度足够（>2m，肉眼能看出是在下坠）', trace.yMin < 60.5 - 2, { yMin: +trace.yMin.toFixed(1) });
  const after = await evaluate(`(() => {
    const g = window.__game; const b = g.localBoat;
    return { y: +b.pos.y.toFixed(1), fall: b.fallTimer, blink: b.blinkTimer, vis: b.group.visible, air: b.airborne };
  })()`);
  check('归位后回到赛道高度且不再闪烁', after.fall === 0 && after.blink === 0 && after.vis === true && !after.air, after);

  // ---------- 4. 瀑布崖口起飞 ----------
  const jump = await evaluate(`(() => {
    const g = window.__game;
    const b = g.localBoat;
    const jg = (g.mapDef.baked && g.mapDef.baked.jumps && g.mapDef.baked.jumps[0].gate) || 44;
    // 船要摆在**崖口本身**（jg），不是前一门：崖口前一门到崖口之间往往还是平顶，
    // 摆早一门的话起跳点落在平顶上，测出来永远是「原地弹一下」。
    const i = jg;
    const a = g.mapDef.gates[i], c = g.mapDef.gates[i + 1];
    b.resetTo(a[0], a[1], Math.atan2(c[0] - a[0], c[1] - a[1]));
    b.pos.y = g.track.gateY[i];
    b.speed = 30; b.airborne = false; b.waveJump = false; b.vy = 0;
    b.jumpGate = jg - 1;                   // 上一帧还在崖口前一门
    const pm = g.progressMap.get(g.myId); if (pm) pm.gate = jg;   // 本帧越过崖口
    return { y0: +b.pos.y.toFixed(1), v0: b.speed };
  })()`);
  await sleep(900);
  const jr = await evaluate(`(() => {
    const b = window.__game.localBoat;
    return { air: b.airborne, wy: b.waveJump, vy: +b.vy.toFixed(2), y: +b.pos.y.toFixed(1), jumpGate: b.jumpGate };
  })()`);
  check('越过崖口会进入腾空（而不是贴着瀑布水条）', jr.air === true && jr.wy === true, jr);
  check('起飞有向上的初速度', jr.vy > 0.5, jr);

  // 弹道要**手动步进**验证：无头下 1~3 fps，等墙钟等于等不到几帧游戏时间，
  // 而且 Runtime.evaluate 会被整帧阻塞到超时。这里一次性在页面里跑 4 秒 @60Hz 的
  // 纯物理 + 相机，既确定又快（相机也一起步进，才能验"镜头不会掉到船下面"）。
  const flight = await evaluate(`(() => {
    const g = window.__game; const b = g.localBoat;
    const y0 = b.pos.y;
    const input = { throttle: 1, steer: 0, drift: false, nitro: false };
    let yMin = y0, camBad = 0, frames = 0, landed = false, worst = null;
    for (let i = 0; i < 300; i++) {
      // 手动步进要自己补上 Game#update 每帧写的那两个字段，否则测的就不是真实链路：
      //   diveTargetY     —— 贴坡/抬高的目标高度
      //   surfaceLandingY —— 腾空时的落点高度（瀑布坡是抬高的，不能按海平面落地）
      b.surfaceLandingY = b.airborne ? g.track.surfaceYAt(b.pos.x, b.pos.z) : null;
      b.updateLocal(1 / 60, input, g.elapsed + i / 60, [...g.colliders], g.mapDef.boundary);
      g.track.constrain(b);
      g.cameraRig.follow(b, 1 / 60, g.elapsed + i / 60);
      frames++;
      if (b.airborne) yMin = Math.min(yMin, b.pos.y);
      // 前 5 帧是"瞬移之后的收敛期"（相机从上一处 lerp 过来），不计入。
      // 判据用"低于船 1.5m 以上"：追随镜头在自由落体里会有零点几米的滞后，
      // 那不是"看不见"，只有整段压在船下面才是问题。
      if (i >= 5) {
        const deficit = b.pos.y - g.camera.position.y;
        if (deficit > camBad) {
          camBad = deficit;
          worst = { i, boatY: +b.pos.y.toFixed(1), camY: +g.camera.position.y.toFixed(1), air: b.airborne, hs: +g.cameraRig.heightSmooth.toFixed(1) };
        }
      }
      if (!b.airborne && i > 30) { landed = true; break; }
    }
    return {
      y0: +y0.toFixed(1), yMin: +yMin.toFixed(1), yEnd: +b.pos.y.toFixed(1),
      frames, landed, camBad: +camBad.toFixed(2), worst, air: b.airborne,
    };
  })()`);
  check('飞行中高度明显下降（走的是弹道不是贴坡）', flight.yMin < flight.y0 - 25, flight);
  check('最终落回水面（结束腾空）', flight.landed === true, flight);
  check('瀑布飞行全程镜头不压在船下面', flight.camBad < 1.5, flight);

  console.log(`\n${pass}/${pass + fail} PASS`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
});
