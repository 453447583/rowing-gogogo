// 赛艇浪花「改动前 / 改动后」对比图（**纯运行时预览，不改游戏源码**）
//
// 做法：无头浏览器进图 -> 冻结 Game 主循环 -> 手动定步长推进物理/浪花池/水面尾迹，
// 两遍独立确定性模拟各渲染一次：第一遍拍「原样」，第二遍打开临时注入的
// 「船尾喷口清晰白色水滴」Sprite 层拍「预览」，页面内左右拼图 + 中文标注后回传 PNG。
// src/、index.html、dist/ 全程零改动；关掉页面后注入层随之消失。
//
//   WB_URL=http://127.0.0.1:5199/ MAP=ocean node tests/wake_compare_shot.mjs
//   VIEWS=chase,bow MODES=cruise,nitro node tests/wake_compare_shot.mjs
//
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/wake-cmp-${stamp}`);   // 故意不删：safe-delete 钩子会超时
const port = 9640 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'ocean';
const outDir = path.resolve(process.env.OUT || 'shots/wake_compare');
const gate = Number(process.env.GATE ?? 3);
const gateT = Number(process.env.GATE_T ?? 0.08);
const FRAMES = Number(process.env.FRAMES ?? 180);
const BOW_ON = process.env.BOW === '1';     // 本轮不改任何水面 uniform，只做船尾喷口飞溅
const BOTH_BASE = process.env.BOTH_BASE === '1'; // 诊断用：两遍都不开预览，验证渲染是否漂移

// 机位全部相对「模拟结束时的船位」计算，保证船始终在画面里。
const VIEWS = {
  chase:  { name: '追尾（游戏机位）', back: 9.5, side: 0,   h: 3.4,  ahead: 5.0, lookY: 0.6 },
  rear45: { name: '侧后 45°',        back: 8.0, side: 7.0, h: 3.2,  ahead: 1.2, lookY: 0.5 },
  bow:    { name: '船头低机位迎面',  back: -8.5, side: 2.6, h: 2.2,  ahead: 0.0, lookY: 0.6 },
  top:    { name: '俯视',            back: 5.5, side: 1.5, h: 12.0, ahead: 0.0, lookY: 0.2 },
};
const MODES = {
  cruise: { name: '常速巡航', input: { throttle: 0.72, steer: 0, drift: false, nitro: false }, nitro: false },
  nitro:  { name: '氮气加速', input: { throttle: 1, steer: 0, drift: false, nitro: true },  nitro: true },
};
const wantViews = (process.env.VIEWS || 'chase,rear45,bow,top').split(',');
const wantModes = (process.env.MODES || 'cruise,nitro').split(',');

// ---- 页面内：临时飞溅预览层 ------------------------------------------------
const PREVIEW_INIT = `(() => {
  const g = window.__game, b = g.localBoat;
  // 用户要「清晰版水花」：一颗颗边界清楚的白色水滴，像下雨那样从船尾喷口
  // 散开、受重力划弧线落回水面。柔边雾团 / 模糊圆点一律不用 → 运行时自己
  // 用 2D canvas 画一张实心带高光的水滴贴图，不依赖任何外部资源。
  const srcSprite = b.splashPool[0].sprite;
  const SpriteCtor = srcSprite.constructor;
  const MatCtor = srcSprite.material.constructor;
  const TexCtor = srcSprite.material.map.constructor;
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 96;
  const c2d = cv.getContext('2d');
  c2d.clearRect(0, 0, 64, 96);
  // 圆润小水珠（不是 UI 水滴图标）：实心、边界干净、只留一点冷白高光。
  // 椭圆外全透明，绝不做柔边 / 羽化 / 渐隐圆团。
  c2d.beginPath();
  c2d.ellipse(32, 48, 25, 36, 0, 0, Math.PI * 2);
  c2d.closePath();
  const grd = c2d.createLinearGradient(10, 12, 56, 86);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.55, 'rgba(248,253,255,1)');
  grd.addColorStop(1, 'rgba(205,235,248,1)');
  c2d.fillStyle = grd; c2d.fill();
  c2d.lineWidth = 2; c2d.strokeStyle = 'rgba(255,255,255,1)'; c2d.stroke();
  c2d.beginPath(); c2d.ellipse(23, 34, 7, 11, -0.35, 0, Math.PI * 2);
  c2d.fillStyle = 'rgba(255,255,255,1)'; c2d.fill();
  const dropTex = new TexCtor(cv);
  dropTex.colorSpace = srcSprite.material.map.colorSpace;
  dropTex.needsUpdate = true;

  const drops = [];               // 只有清晰水滴，不再有任何雾团 / 柔边粒子池
  for (let i = 0; i < 128; i++) {
    const s = new SpriteCtor(new MatCtor({
      map: dropTex, transparent: true, opacity: 0, depthWrite: false,
      depthTest: true, color: 0xffffff,
    }));
    s.visible = false; s.renderOrder = 3;
    g.scene.add(s);
    drops.push({ s, life: 0, maxLife: 0.6, vx: 0, vy: 0, vz: 0, w: 0.16, h: 0.24, op: 1 });
  }
  const P = { drops, di: 0, acc: 0, seed: 1, on: false };
  P.rnd = () => { P.seed = (P.seed * 1664525 + 1013904223) >>> 0; return P.seed / 4294967296; };
  P.reset = () => {
    P.seed = 1; P.acc = 0; P.di = 0; P.on = false;
    for (const p of P.drops) { p.life = 0; p.s.visible = false; }
  };
  P.show = (on) => {
    P.on = !!on;
    for (const p of P.drops) p.s.visible = P.on && p.life > 0;
  };
  P.active = () => {
    let d = 0;
    for (const p of P.drops) if (p.life > 0) d++;
    return { d, m: 0 };
  };

  // 清晰版水花 = 从「船尾喷射口」一颗颗射出的实心白色水滴，
  // 像下雨那样上抛、受重力划弧线落回水面；没有雾团、没有柔边圆点、
  // 没有细长碎粒，也绝不在船头 / 船侧 / 远处水面撒粒子。
  // 喷口用 Boat.nitroNozzles（挂在 group 上，随横滚/俯仰/腾空走），
  // 发射率 / 尺寸 / 散开角由 (speed/maxSpeed, boosting) 驱动，随机数用确定性 LCG。
  P.step = (dt, boat, boosting) => {
    const R = P.rnd;
    const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
    const sx = fz, sz = -fx;
    const v = Math.min(1.2, boat.speed / (boat.def.maxSpeed || 30));
    const k = boosting ? 1 : 0;
    const boatV = Math.max(0, boat.speed || 0);

    let noz = (boat.nitroNozzles || []).map((a) => {
      const q = boat.pos.clone();
      a.getWorldPosition(q);
      return q;
    });
    if (!noz.length) {
      const L = boat.def.hull.length;
      noz = [boat.pos.clone().set(
        boat.pos.x - fx * L * 0.5, boat.pos.y + 0.25, boat.pos.z - fz * L * 0.5,
      )];
    }

    // 发射：只从喷口出。世界系速度 = 船速 - 向后喷射 + 侧向随机 + 上抛，
    // 让水滴留在船尾后方几米内散开，而不是一帧就飞出画面。
    P.acc += dt;
    const interval = k ? 0.032 : 0.045;
    while (P.acc >= interval) {
      P.acc -= interval;
      const src = noz[Math.floor(R() * noz.length)];
      const burst = 2 + Math.floor(R() * (k ? 3 : 2));
      for (let j = 0; j < burst; j++) {
        const p = P.drops[P.di]; P.di = (P.di + 1) % P.drops.length;
        p.s.position.set(
          src.x - fx * 0.30 + (R() - 0.5) * 0.20,   // 起点往船后推一点，别贴在船壳上
          src.y + 0.22 + R() * 0.12,           // 抬到水面之上，否则水珠被不透明水面挡掉
          src.z - fz * 0.30 + (R() - 0.5) * 0.20,
        );
        // 相对船只后退 2~5 m/s：水滴始终留在船尾几米内，
        // 不会冲到追尾相机跟前被透视放大成巨型贴片。
        const back = (1.8 + v * 1.8 + k * 2.2) * (0.60 + R() * 0.70);
        const spread = (1.2 + v * 1.6 + k * 2.0) * (0.45 + R() * 0.90);
        const lateral = (R() - 0.5) * 2 * spread;
        const up = (2.0 + v * 1.5 + k * 1.8) * (0.60 + R() * 0.60);
        p.vx = fx * (boatV - back) + sx * lateral;
        p.vz = fz * (boatV - back) + sz * lateral;
        p.vy = up;
        p.maxLife = 0.45 + R() * 0.22;
        p.life = p.maxLife;
        const w = (0.11 + v * 0.07 + k * 0.08) * (0.80 + R() * 0.45);
        p.w = w; p.h = w * 1.10;              // 配 64×96 贴图 → 近似正圆小水珠
        p.op = 0.95;                          // 全程实心，只在末尾快速淡出
        p.s.material.color.setRGB(1, 1, 1);   // 纯白，别被水色染暗
        p.s.material.rotation = 0;
        p.s.scale.set(p.w, p.h, 1);
        p.s.visible = P.on;
      }
    }

    // 积分：明显重力 → 雨滴抛物线；尺寸恒定、不膨胀，保持边界清晰
    const GRAV = 16.0;
    const bx = boat.pos.x, bz = boat.pos.z;
    for (const p of P.drops) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.vy -= GRAV * dt;
      p.s.position.x += p.vx * dt;
      p.s.position.y += p.vy * dt;
      p.s.position.z += p.vz * dt;
      // 硬边界：绝不让水珠飘到船尾 6m 以外 / 冲到相机前，也别飘上天空
      const dx = p.s.position.x - bx, dz = p.s.position.z - bz;
      const dd = dx * dx + dz * dz;
      if (dd > 36 || p.s.position.y > 2.6) { p.life = 0; p.s.visible = false; continue; }
      // 落到水面就收掉，避免水滴穿过不透明水面露出船底
      if (p.s.position.y < 0.03 && p.vy < 0) { p.life = 0; p.s.visible = false; continue; }
      const t = 1 - p.life / p.maxLife;
      let fade = t > 0.72 ? Math.max(0, (1 - t) / 0.28) : 1;
      if (dd > 16) fade *= Math.max(0, 1 - (Math.sqrt(dd) - 4) / 2);
      p.s.material.opacity = p.op * fade;
      // 下落中的水珠轻微纵向拉长，像雨滴坠落；上升时仍是圆的，绝不拉成细长碎条
      p.s.scale.set(p.w, p.h * (p.vy < 0 ? 1.18 : 1.0), 1);
      p.s.visible = P.on && fade > 0;
    }
  };

  // 页面内拼图：两张 JPEG -> 一张带标题栏 / 页脚的 PNG，避免 Node 端图像依赖
  P.compose = async (u1, u2, labels) => {
    const load = (u) => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('decode failed'));
      im.src = u;
    });
    const a = await load(u1), c2 = await load(u2);
    const W = a.width, H = a.height, GAP = 14, BAR = 52, FOOT = 46;
    const cv = document.createElement('canvas');
    cv.width = W * 2 + GAP; cv.height = H + BAR + FOOT;
    const c = cv.getContext('2d');
    c.fillStyle = '#101820'; c.fillRect(0, 0, cv.width, cv.height);
    c.drawImage(a, 0, BAR);
    c.drawImage(c2, W + GAP, BAR);
    c.fillStyle = '#334155'; c.fillRect(W, BAR, GAP, H);
    c.font = 'bold 22px "Microsoft YaHei", "PingFang SC", sans-serif';
    c.fillStyle = '#cbd5e1'; c.fillText(labels[0], 16, 34);
    c.fillStyle = '#5eead4'; c.fillText(labels[1], W + GAP + 16, 34);
    c.fillStyle = '#1e293b'; c.fillRect(0, BAR + H, cv.width, 2);
    c.font = '16px "Microsoft YaHei", "PingFang SC", sans-serif';
    c.fillStyle = '#94a3b8'; c.fillText(labels[2], 16, cv.height - 15);
    return cv.toDataURL('image/png');
  };

  window.__WP = P;
  return { drops: drops.length };
})()`;

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  `--window-size=${process.env.SIZE || '960x540'}`,
  url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 240000) {
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
const evaluate = (expression, timeout = 240000) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
}, timeout);

async function waitForJson(u, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

// 单组：两遍完全相同的确定性模拟，各自只渲染一次。
// 同一流程里连续 render 两次会让水面/天空出现状态漂移，所以「改动前」「改动后」
// 必须是两次独立的「第一次渲染」；第一遍的图暂存到 window.__WAKE_A。
function prepExpr(viewKey, modeKey, idx, isSecond) {
  const V = VIEWS[viewKey], M = MODES[modeKey];
  const labelBefore = `改动前 · ${M.name} · ${V.name}`;
  const labelAfter = `改动后 · ${M.name} · ${V.name}`;
  const foot = M.nitro
    ? '同一机位 / 同一速度：右侧仅预览「船尾喷口射出的清晰白色水滴，像雨滴一样受重力散落，氮气更密更大」，源码零改动'
    : '同一机位 / 同一速度：右侧仅预览「船尾喷口射出的清晰白色水滴，像雨滴一样受重力散落」，源码零改动';
  return `(async () => {
    const g = window.__game, b = g.localBoat, w = g.water, P = window.__WP;
    const V = ${JSON.stringify(V)}, M = ${JSON.stringify(M)};
    const SHOW = ${JSON.stringify(!!isSecond && !BOTH_BASE)};
    const N = g.mapDef.gates.length;
    const gi = ${gate} % N;
    const a = g.mapDef.gates[gi], c = g.mapDef.gates[(gi + 1) % N];
    const t = ${gateT};
    const ax = a[0] + (c[0] - a[0]) * t, az = a[1] + (c[1] - a[1]) * t;
    const heading = Math.atan2(c[0] - a[0], c[1] - a[1]);
    b.resetTo(ax, az, heading);
    b.speed = 0; b.boostTimer = 0; b.vel.set(0, 0);
    b.pos.y = 0;
    P.reset();

    const dt = 1 / 60;
    let T = g.elapsed + 1.2;
    for (let i = 0; i < ${FRAMES}; i++) {
      if (M.nitro) b.boostTimer = Math.max(b.boostTimer, 1.2);
      else b.boostTimer = 0;
      b.updateLocal(dt, M.input, T, [], null);
      if (b.pos.y < -0.6) b.pos.y = 0;
      if (M.nitro) b.boostTimer = Math.max(b.boostTimer, 1.2);
      w.setBoatDisturbances([{
        x: b.pos.x, z: b.pos.z, heading: b.heading, speed: b.speed,
        maxSpeed: b.def.maxSpeed, boosting: M.nitro, isLocal: true,
        length: b.def.hull.length,
      }], dt);
      w.update(T);
      P.step(dt, b, M.nitro);
      T += dt;
    }

    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    const sx = fz, sz = -fx;
    const bx = b.pos.x, bz = b.pos.z, by = b.pos.y;
    g.cameraRig.follow = () => {};
    g.camera.position.set(bx - fx * V.back + sx * V.side, by + V.h, bz - fz * V.back + sz * V.side);
    g.camera.lookAt(bx + fx * V.ahead, by + V.lookY, bz + fz * V.ahead);
    g.camera.updateMatrixWorld(true);

    // ---- 本遍唯一的一次渲染 ----
    const bf = w.uniforms.uBowFoam.value;
    const saved = { x: bf.x, y: bf.y, z: bf.z, foam: w.uniforms.uFoamStrength.value };
    P.show(false);
    if (SHOW) {
      P.show(true);
      if (${JSON.stringify(BOW_ON)}) {
        bf.x = Math.min(0.95, saved.x * 1.08);
        // 乘法保留「常速 vs 氮气」原有的强弱差，别用 clamp 把两档压成同一个值
        bf.y = Math.min(0.62, saved.y * 1.30 + (M.nitro ? 0.03 : 0.01));
        bf.z = Math.min(0.78, saved.z * 1.10);
      }
      // 刻意不动 uFoamStrength：那是全海面浪尖白沫，改了就变成「水面材质换了」
    }
    g.post.render(0);
    const shot = g.renderer.domElement.toDataURL('image/jpeg', 0.90);

    // 还原，避免污染下一遍
    bf.set(saved.x, saved.y, saved.z);
    w.uniforms.uFoamStrength.value = saved.foam;
    const live = P.active();
    P.show(false);
    const info = {
      view: ${JSON.stringify(viewKey)}, mode: ${JSON.stringify(modeKey)}, idx: ${idx},
      map: g.mapDef.id,
      speed: +b.speed.toFixed(1), max: +b.def.maxSpeed.toFixed(1),
      boost: +b.boostTimer.toFixed(2),
      live, cam: [+g.camera.position.x.toFixed(1), +g.camera.position.y.toFixed(1), +g.camera.position.z.toFixed(1)],
      bowFoam: [+saved.x.toFixed(3), +saved.y.toFixed(3), +saved.z.toFixed(3)],
    };
    if (!${JSON.stringify(!!isSecond)}) { window.__WAKE_A = shot; return { staged: true, info }; }
    const png = await P.compose(window.__WAKE_A, shot, ${JSON.stringify([labelBefore, labelAfter, foot])});
    return { png, info };
  })()`;
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((x) => x.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); ws.on('close', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('EXC', String(msg.params.exceptionDetails.exception?.description
        || msg.params.exceptionDetails.text).slice(0, 400));
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      addEventListener('error', (e) => window.__errs.push('ERR ' + (e.message || '')));
      addEventListener('unhandledrejection', (e) => window.__errs.push('REJ ' + String(e.reason && e.reason.message || e.reason)));`,
  });
  await cdp('Page.reload');
  await sleep(1200);

  // ---- 进单人 -> 选图 -> 发车 ----
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cards = false;
  for (let i = 0; i < 12 && !cards; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cards = (await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value === true;
  }
  if (!cards) throw new Error('地图抽屉没打开');
  const picked = await evaluate(`(() => {
    const cs = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cs.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cs.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图选不到：${picked.result?.value}`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ready = false;
  while (Date.now() - t2 < 60000) {
    if ((await evaluate('!!window.__game && !!window.__game.track')).result?.value) { ready = true; break; }
    await sleep(400);
  }
  if (!ready) throw new Error('对局没起来');
  await evaluate(`(() => { const g = window.__game;
    g.phase = 'racing'; g.countdownLeft = 0; g.finished = false;
    if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; }
    return 1; })()`);
  // 先让主循环跑几帧完成初始化，再提前冻结：单人模式船不动也会走完超时判定，
  // 一旦结算 main.js 会 dispose 掉 __game（软渲染被残留进程拖慢时尤其容易触发）。
  // GLB / 纹理是 Promise 异步加载，不依赖 rAF，停循环后照样落地。
  await sleep(4500);
  const early = await evaluate(`(() => { const g = window.__game;
    if (!g) return 'lost';
    cancelAnimationFrame(g.rafId);
    g.phase = 'racing'; g.countdownLeft = 0; g.finished = false;
    return 'ok'; })()`);
  console.log('freeze-early:', JSON.stringify(early.result?.value));
  await sleep(Number(process.env.WARM || 9000));

  const alive = await evaluate(`(() => ({
    game: !!window.__game, errs: (window.__errs || []).slice(0, 6),
  }))()`);
  console.log('alive:', JSON.stringify(alive.result?.value));
  if (!alive.result?.value?.game) throw new Error('对局在预热期间被 dispose');

  // ---- 冻结主循环，之后世界完全由探针手动步进 ----
  const frozen = await evaluate(`(() => {
    const g = window.__game;
    cancelAnimationFrame(g.rafId);
    g.cameraRig.follow = () => {};
    if (g.localBoat?.label) g.localBoat.label.visible = false;
    // 画面里只留本地艇：其它船（含名字牌/它们的浪花）会抢走对比注意力
    for (const a of (g.boats?.values() || [])) {
      if (a === g.localBoat) continue;
      if (a.group) a.group.visible = false;
      if (a.label) a.label.visible = false;
      if (a.nameSprite) a.nameSprite.visible = false;
      for (const w of a.wakePool || []) { w.sprite.visible = false; w.crest.visible = false; }
      for (const s of a.splashPool || []) s.sprite.visible = false;
      for (const s of a.mistPool || []) s.sprite.visible = false;
    }
    const N = g.mapDef.gates.length;
    const gi = ${gate} % N;
    const a = g.mapDef.gates[gi], c = g.mapDef.gates[(gi + 1) % N];
    return {
      map: g.mapDef.id, gates: N, segLen: +Math.hypot(c[0]-a[0], c[1]-a[1]).toFixed(1),
      hull: [g.localBoat.def.hull.length, g.localBoat.def.hull.width],
      maxSpeed: g.localBoat.def.maxSpeed,
      nozzles: g.localBoat?.nitroNozzles?.length || 0,
      errs: (window.__errs || []).slice(0, 5),
    };
  })()`);
  console.log('scene:', JSON.stringify(frozen.result?.value ?? frozen.exceptionDetails?.exception?.description));

  const init = await evaluate(PREVIEW_INIT);
  console.log('preview layer:', JSON.stringify(init.result?.value ?? init.exceptionDetails?.exception?.description));
  if (!init.result?.value) throw new Error('预览层初始化失败');

  await fs.mkdir(outDir, { recursive: true });
  let done = 0, idx = 0;
  for (const modeKey of wantModes) {
    for (const viewKey of wantViews) {
      idx++;
      if (!MODES[modeKey] || !VIEWS[viewKey]) { console.log(`跳过未知 ${viewKey}/${modeKey}`); continue; }
      let r;
      try {
        // 两遍独立模拟：各自只 render 一次，第一遍把「改动前」暂存在页面里
        const a = await evaluate(prepExpr(viewKey, modeKey, idx, false));
        if (a.exceptionDetails) {
          throw new Error('A: ' + String(a.exceptionDetails.exception?.description || a.exceptionDetails.text).slice(0, 300));
        }
        if (a.result?.value?.staged !== true) throw new Error('A 未暂存');
        r = await evaluate(prepExpr(viewKey, modeKey, idx, true));
      } catch (e) {
        console.log(`${idx} ${viewKey}/${modeKey} FAIL ${e.message}`);
        continue;
      }
      if (r.exceptionDetails) {
        console.log(`${idx} ${viewKey}/${modeKey} EXC`,
          String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 500));
        continue;
      }
      const v = r.result?.value;
      if (!v || typeof v.png !== 'string' || !v.png.startsWith('data:image')) {
        console.log(`${idx} ${viewKey}/${modeKey} 没有拿到图片`);
        continue;
      }
      const f = path.join(outDir, `${String(idx).padStart(2, '0')}-${viewKey}-${modeKey}.png`);
      await fs.writeFile(f, Buffer.from(v.png.slice(v.png.indexOf(',') + 1), 'base64'));
      console.log(`${idx} ${viewKey}/${modeKey}`, JSON.stringify(v.info), '->', path.basename(f));
      done++;
    }
  }
  console.log('DONE', done, '/', wantModes.length * wantViews.length, '->', outDir);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* 已退 */ }
  child.kill();
});
