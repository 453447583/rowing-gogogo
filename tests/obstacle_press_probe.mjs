// 撞柱子"抽搐"复现 / 回归探针：船头顶住熔岩岩石障碍，一直按油门，
// 统计接触后的前后抖动幅度与速度符号翻转次数。
//   MAP=magma node tests/obstacle_press_probe.mjs
// 判据（接触后 4 秒）：
//   pen      = 最大侵入深度（>0.25m 说明位置解算没把船推出去）
//   flips    = 沿接近方向的速度符号翻转次数（健康值 ≤ 2；抽搐会到几十）
//   backMax  = 接触后向后的最大位移（健康值 < 1.5m；抽搐会反复退好几米）
//   speedMax = 接触后的峰值速度（健康值接近 0）
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
// 无头配置目录一律写在项目外（项目硬约束）
const profile = path.resolve(`D:/3dgame-tmp/browser/press-${stamp}`);
const port = 9700 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'magma';

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
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      console.log('EXC', d.exception?.description?.slice(0, 300) || d.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1500);

  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find((x) => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map((x) => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t1 = Date.now();
  let ready = false;
  while (Date.now() - t1 < 90000) {
    if ((await evaluate('!!(window.__game && window.__game.track && window.__game.track.magmaObstacles)')).result?.value) {
      ready = true; break;
    }
    await sleep(300);
  }
  if (!ready) throw new Error('没拿到 magmaObstacles');
  // 等 GLB 装完：碰撞轮廓要等模型顶点求出来（兜底八边形与真模型略有差异，
  // 不等这一步会让"撞柱子会不会二次回弹"这类指标随加载时机飘）。
  for (let i = 0; i < 200; i++) {
    if ((await evaluate('!!window.__game.localBoat.modelRoot')).result?.value) break;
    await sleep(200);
  }
  await evaluate('(() => { const g = window.__game; if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; } if (g.phase !== "racing") { g.raceIntro = null; g.countdownLeft = 0; g.phase = "racing"; } return 1; })()');

  const hullOld = process.env.HULL === 'old' ? '1' : '0';
  const out = await evaluate(`(() => {
    const g = window.__game, t = g.track, b = g.localBoat;
    // HULL=old：换回旧版碰撞轮廓，用来 A/B 判断指标变化是不是护栏变严引起的
    if (${hullOld}) {
      const h = b.def.hull, hw = h.width * 0.5 * 0.88, hl = h.length * 0.5 * 0.62;
      b.hullFootprint = Float32Array.from([hw, hl, -hw, hl, -hw, -hl, hw, -hl]);
    }
    const N = t.gates.length;
    const ob = (t.magmaObstacles || [])[0];
    if (!ob) return { err: '这张图没有熔岩障碍' };
    const colliders = [...g.colliders, ...t.shoreColliders, ...t.mechColliders];

    // 从柱子正面 9m 处朝它开：方向取"柱子所在门 -> 下一门"的前进方向反过来
    const gi = ob.gate;
    const a = t.gates[gi], c = t.gates[(gi + 1) % N];
    const fwd = Math.atan2(c[0] - a[0], c[1] - a[1]);
    const startX = ob.x - Math.sin(fwd) * 9;
    const startZ = ob.z - Math.cos(fwd) * 9;

    // steerFrom：接触后第 N 帧开始打方向（模拟"顶住了想蹭出去"）
    const run = (label, initSpeed, steerFrom, latOff) => {
      // latOff：沿"船右侧"方向偏移起点，用来模拟擦着柱子边过去
      const rx0 = Math.cos(fwd);
      const rz0 = -Math.sin(fwd);
      const sx0 = startX + rx0 * (latOff || 0);
      const sz0 = startZ + rz0 * (latOff || 0);
      b.resetTo(sx0, sz0, fwd, { keepNitro: true });
      b.pos.y = t.surfaceYAt ? t.surfaceYAt(sx0, sz0, gi) : b.pos.y;
      b.vel.set(Math.sin(fwd) * initSpeed, Math.cos(fwd) * initSpeed);
      b.speed = initSpeed;
      b.stunTimer = 0;
      b.driftState = null;
      const input = { throttle: 1, steer: 0, drift: false };
      const samples = [];
      let contact = -1;
      let penMax = 0;
      let backMax = 0;
      let speedMax = 0;
      let flips = 0;
      let lastSign = 0;
      let contactX = 0, contactZ = 0;
      let yawMin = Infinity, yawMax = -Infinity;
      let shakeFrames = 0, stunFrames = 0, speedAfter = 0;
      const STEPS = 300;                        // 5 秒
      const DT = 1 / 60;
      let escapeDist = null;
      for (let i = 0; i < STEPS; i++) {
        if (steerFrom != null && contact >= 0 && i === contact + steerFrom) input.steer = -1;
        b.updateLocal(DT, input, 10 + i * DT, colliders, null);
        // 必须补上走廊约束：Game 每帧在 updateLocal 之后调 track.constrain(boat)。
        // 少了这一步，就复现不出"柱子把人往外顶、护栏把人往里推"的夹击抖动。
        t.constrain(b);
        const dx = b.pos.x - ob.x, dz = b.pos.z - ob.z;
        const dist = Math.hypot(dx, dz);
        const minD = ob.r + 1.3;
        const pen = minD - dist;
        // 接触判定：贴到表面就算（pen>0.02 只在"真陷进去"时触发，会把正常刹车漏掉）
        if (dist < minD + 0.06 && contact < 0) { contact = i; contactX = b.pos.x; contactZ = b.pos.z; }
        if (contact >= 0) {
          penMax = Math.max(penMax, pen);
          // 沿"接近方向"投影的位移：正 = 朝柱子，负 = 被弹回去
          const along = (b.pos.x - contactX) * Math.sin(fwd) + (b.pos.z - contactZ) * Math.cos(fwd);
          backMax = Math.max(backMax, -along);
          speedMax = Math.max(speedMax, Math.hypot(b.vel.x, b.vel.y));
          // 接触稳定之后的峰值速度：撞上那一瞬间的速度不算（撞击前本来就该有速度）
          if (i > contact + 20) speedAfter = Math.max(speedAfter, Math.hypot(b.vel.x, b.vel.y));
          const vAlong = b.vel.x * Math.sin(fwd) + b.vel.y * Math.cos(fwd);
          // 只在「真的贴着柱面」时统计来回抽：船体轮廓改严格之后，
          // 撞飞出去再蹭到别的东西（护栏/另一根柱子）也会让速度方向变号，
          // 那不属于"被困在柱子前反复弹"，不该算进这个指标。
          if (dist < minD + 0.06) {
            const sign = Math.abs(vAlong) < 0.25 ? 0 : Math.sign(vAlong);
            if (sign !== 0 && lastSign !== 0 && sign !== lastSign) flips += 1;
            if (sign !== 0) lastSign = sign;
          }
          yawMin = Math.min(yawMin, b.heading);
          yawMax = Math.max(yawMax, b.heading);
          if ((b.hitShake || 0) > 0.25) shakeFrames += 1;
          if ((b.stunTimer || 0) > 0) stunFrames += 1;
          if (i % 10 === 0) samples.push([i, +dist.toFixed(2), +vAlong.toFixed(2)]);
        }
      }
      if (steerFrom != null) escapeDist = +Math.hypot(b.pos.x - ob.x, b.pos.z - ob.z).toFixed(1);
      return {
        label, initSpeed,
        escapeDist,
        contactStep: contact,
        penMax: +penMax.toFixed(2),
        backMax: +backMax.toFixed(2),
        speedMax: +speedMax.toFixed(1),
        speedAfter: +speedAfter.toFixed(2),
        flips,
        yawRangeDeg: Number.isFinite(yawMin) ? +((yawMax - yawMin) * 180 / Math.PI).toFixed(1) : null,
        shakeFrames,
        stunFrames,
        tail: samples.slice(-8),
        // 诊断：船跑哪儿去了、有没有被什么计时器冻住
        start: [+startX.toFixed(1), +startZ.toFixed(1)],
        end: [+b.pos.x.toFixed(1), +b.pos.z.toFixed(1)],
        endSpeed: +b.speed.toFixed(2),
        d0: +Math.hypot(sx0 - ob.x, sz0 - ob.z).toFixed(1),
        d1: +Math.hypot(b.pos.x - ob.x, b.pos.z - ob.z).toFixed(1),
        flags: {
          airborne: !!b.airborne, voidT: +(b.voidTimer || 0).toFixed(2),
          stun: +(b.stunTimer || 0).toFixed(2), capsize: +(b.capsizeTimer || 0).toFixed(2),
          sinking: +(b.sinkTimer || 0).toFixed(2), spin: +(b.spinTimer || 0).toFixed(2),
        },
      };
    };

    return {
      map: g.mapDef.id, obstacleR: ob.r, kind: ob.kind,
      press: run('按住油门顶住柱子', 0),
      crash: run('20m/s 撞上去', 20),
      escape: run('顶住 1 秒后向左打方向', 0, 60),
      graze: run('20m/s 擦着柱子边过', 20, null, (ob.r + 1.3) * 0.82),
    };
  })()`);

  const r = out.result?.value;
  if (!r || r.err) throw new Error(r?.err || '自测没返回结果');
  const ob = { rSafe: r.obstacleR + 1.3 };
  console.log(JSON.stringify(r, null, 1));
  // 顶住柱子：不许被弹开、不许甩头、不许抖屏、不许穿透。
  // 速度阈值 2026-11-16 从 1.2 放宽到 6：旧版是靠"每帧 vel *= 0.55"把速度削成 0 的，
  // 那条正是"高速撞石头就停住、顶住就再也出不来"的病根。现在法向速度照样被墙吃掉，
  // 但推力还在（速度表读得到螺旋桨在转），所以有 2~4 m/s 是正常的；
  // 真正要守的是「位置不抖」——penMax / backMax / yawRange / shake 四个指标。
  const pressOk = r.press.penMax < 0.3 && r.press.backMax < 1.0 && r.press.speedAfter < 6
    && r.press.yawRangeDeg < 15 && r.press.shakeFrames === 0;
  // 高速撞：允许弹一次（会退一点、甩一下头），但不能来回抽、不能弹回十几米
  const crashOk = r.crash.flips <= 3 && r.crash.backMax < 7 && r.crash.penMax < 0.3;
  // 脱困：打方向之后必须离开柱子（不被粘住），并且能重新跑起来
  const escapeOk = !r.escape || (r.escape.escapeDist > ob.rSafe && r.escape.speedAfter > 3);
  console.log(pressOk ? 'PASS press' : 'FAIL press');
  console.log(crashOk ? 'PASS crash' : 'FAIL crash');
  // 擦边：不许被顶回来、不许卡住，必须顺着柱面滑过去
  const grazeOk = !r.graze || (r.graze.backMax < 3 && r.graze.flips <= 3 && r.graze.d1 > 14);
  console.log(escapeOk ? 'PASS escape' : 'FAIL escape');
  console.log(grazeOk ? 'PASS graze' : 'FAIL graze');
  if (!pressOk || !crashOk || !escapeOk || !grazeOk) process.exitCode = 2;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { child.kill(); } catch { /* 已退 */ }
});
