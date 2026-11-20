// 硬物碰撞探针：量「高速撞石头」之后船到底飞出去多远、速度还剩多少。
//
//   node tests/rock_bounce_probe.mjs            # strait
//   MAP=magma node tests/rock_bounce_probe.mjs
//
// 两个场景：
//   COAST  松开油门、以极速斜撞石头 → 看反弹距离 / 反弹后速度 / 偏转角
//   THROTTLE 按住油门顶上去     → 看会不会被"钉"在石头上（速度≈0、位置不动）
//
// 输出的是纯净数字：接触瞬间速度、离开接触点最远退了多远、速度方向偏了多少度。
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/rock-${stamp}`;
const port = 9900 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'strait';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1024,600', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(400);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 120000);
  await waitFor(`window.__game?.phase === 'racing'`, 120000);

  // 碰撞体清单
  const list = val(await evaluate(`(() => {
    const g = window.__game;
    const all = [...(g.colliders || []), ...(g.track.shoreColliders || [])];
    return all.map((c, i) => ({
      i, x: +(+c.x).toFixed(1), z: +(+c.z).toFixed(1), r: +(+(c.r || 0)).toFixed(2),
      type: c.type || '?', heavy: !!c.heavy, hasRef: !!c.ref,
    }));
  })()`));
  console.log('COLLIDERS', Array.isArray(list) ? list.length : list);
  if (Array.isArray(list)) {
    const heavy = list.filter((c) => c.heavy);
    console.log('HEAVY', JSON.stringify(heavy.slice(0, 12)));
    console.log('BY_TYPE', JSON.stringify(list.reduce((m, c) => {
      m[c.type] = (m[c.type] || 0) + 1; return m;
    }, {})));
  }

  // 挑一块"孤立"的石头：离其它碰撞体都远，测试不受干扰
  const pick = val(await evaluate(`(() => {
    const g = window.__game;
    const all = [...(g.colliders || []), ...(g.track.shoreColliders || [])];
    let best = null, bestScore = -1;
    for (const c of all) {
      if (!c.heavy) continue;
      let nearest = Infinity;
      for (const o of all) {
        if (o === c) continue;
        nearest = Math.min(nearest, Math.hypot(o.x - c.x, o.z - c.z) - (o.r || 0));
      }
      if (nearest > bestScore) { bestScore = nearest; best = c; }
    }
    if (!best) {
      // 没有 heavy 就退而求其次：挑最大的岸礁
      for (const c of all) {
        const s = (c.r || 0) + (c.heavy ? 100 : 0);
        if (s > bestScore) { bestScore = s; best = c; }
      }
    }
    return best ? { x: best.x, z: best.z, r: best.r, type: best.type || '?',
      heavy: !!best.heavy, hasRef: !!best.ref, gap: +(bestScore).toFixed(2) } : null;
  })()`));
  console.log('PICK', JSON.stringify(pick));
  if (!pick) throw new Error('没有可用的石头');

  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.track.applyMechs = () => {};        // 别让"撞碎"把石头打掉
    g.mapDef.boundary = null;
    if ('countdownLeft' in g) g.countdownLeft = 0;
    window.__thr = 0;
    g.opts.input = {
      get throttle() { return window.__thr || 0; }, get steer() { return 0; },
      get drift() { return false; }, get nitro() { return false; },
    };
    return 1;
  })()`);

  // 摆位 + 记录。approach 方向：从石头指向"外侧随机一点"，但保证朝向石头。
  const setup = (speed) => `(() => {
    const g = window.__game, b = g.localBoat, R = ${JSON.stringify(pick)};
    // 从石头的 -Z 侧 42m 外向石头冲（角度偏 18°，模拟"斜着撞"）
    const ang = 0.32;
    const ux = Math.sin(ang), uz = -Math.cos(ang);      // 前进方向（指向石头）
    const D = 42;
    const sx = R.x - ux * D, sz = R.z - uz * D;
    b.resetTo(sx, sz, Math.atan2(ux, uz));
    b.vel.set(ux * ${speed}, uz * ${speed});
    b.speed = ${speed};
    b.stunTimer = 0;
    g.track.constrain = (bb) => {};      // 只留石头碰撞，不要护栏干扰
    window.__rec = [];
    if (!window.__hooked) {
      window.__hooked = 1;
      const tick = () => {
        try {
          const bb = g.localBoat, R2 = window.__rock;
          const dx = bb.pos.x - R2.x, dz = bb.pos.z - R2.z;
          const dist = Math.hypot(dx, dz);
          // 离最近一块石头的表面距离
          let near = 1e9;
          for (const c of window.__allRocks) {
            near = Math.min(near, Math.hypot(bb.pos.x - c.x, bb.pos.z - c.z) - (c.r || 0) - 1.3);
          }
          window.__rec.push({
            t: +g.raceTime.toFixed(2),
            sp: +Math.hypot(bb.vel.x, bb.vel.y).toFixed(2),
            near: +near.toFixed(2),
            dist: +dist.toFixed(2),
            // 沿"来向"的位移：正 = 被推回去
            back: +((bb.pos.x - window.__contact.x) * -window.__ux
              + (bb.pos.z - window.__contact.z) * -window.__uz).toFixed(2),
            // 速度方向与来向的夹角（度）：0=正对，180=完全反向弹回
            ang: +(Math.atan2(bb.vel.x, bb.vel.y) * 180 / Math.PI).toFixed(1),
            stun: +bb.stunTimer.toFixed(2),
            his: +(bb.heavyImpactSpeed || 0).toFixed(2),
          });
          if (window.__rec.length > 900) window.__rec.shift();
        } catch { /* */ }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    window.__rock = R;
    window.__ux = ux; window.__uz = uz;
    window.__contact = { x: R.x, z: R.z };
    return { sx: +sx.toFixed(1), sz: +sz.toFixed(1), gap: +((Math.hypot(sx - R.x, sz - R.z) - R.r - 1.3)).toFixed(1) };
  })()`;

  await evaluate(`window.__allRocks = [...(window.__game.colliders || []),
    ...(window.__game.track.shoreColliders || [])]; 1`);

  const analyze = `(() => {
    const rec = window.__rec || [];
    if (rec.length < 4) return { ok: false, note: 'not enough frames' };
    // 撞击帧 = 速度相对上一帧掉得最狠的那一帧
    let hit = -1, worst = 0;
    for (let i = 1; i < rec.length; i++) {
      const drop = rec[i - 1].sp - rec[i].sp;
      if (drop > worst) { worst = drop; hit = i; }
    }
    if (hit < 0 || worst < 3) return { ok: false, note: 'no impact', maxDrop: +worst.toFixed(2),
      minNear: +Math.min(...rec.map((r) => r.near)).toFixed(2) };
    let maxBack = -1e9;
    for (let i = hit; i < rec.length; i++) maxBack = Math.max(maxBack, rec[i].back);
    const tail = rec.slice(Math.max(0, hit - 1), hit + 7)
      .map((r) => ({ sp: r.sp, near: r.near, back: r.back, ang: r.ang, stun: r.stun }));
    return {
      ok: true,
      speedBefore: rec[hit - 1].sp,
      speedAfter: rec[hit].sp,
      dropInOneFrame: +worst.toFixed(2),
      bounceBackDist: +maxBack.toFixed(2),
      frames: rec.length,
      tail,
    };
  })()`;

  // 玩家真实操作：从 42m 外一路踩着油门撞上去
  console.log('--- 油门全开撞石头（28 m/s 级）---');
  console.log('SETUP', JSON.stringify(val(await evaluate(setup(28)))));
  await evaluate(`window.__thr = 1; 1`);
  await sleep(2600);
  console.log('RESULT', JSON.stringify(val(await evaluate(analyze)), null, 1));
  await evaluate(`window.__thr = 0; 1`);

  console.log('--- THROTTLE 顶住（模拟玩家按住油门撞石头）---');
  console.log('SETUP', JSON.stringify(val(await evaluate(setup(28)))));
  await evaluate(`window.__thr = 1; 1`);
  await sleep(5000);
  const pinned = val(await evaluate(`(() => {
    const rec = window.__rec || [];
    const R = window.__rock, touch = R.r + 1.4;
    let hit = -1;
    for (let i = 0; i < rec.length; i++) if (rec[i].dist <= touch) { hit = i; break; }
    if (hit < 0) return { ok: false };
    const seg = rec.slice(hit);
    return {
      ok: true,
      frames: seg.length,
      speedAvgLast: +(seg.slice(-20).reduce((a, r) => a + r.sp, 0) / Math.min(20, seg.length)).toFixed(2),
      last8: seg.slice(-8).map((r) => ({ sp: r.sp, near: r.near, stun: r.stun, back: r.back })),
      backLast: seg[seg.length - 1].back,
      backMax: +Math.max(...seg.map((r) => r.back)).toFixed(2),
      distLast: seg[seg.length - 1].dist,
      stunLast: seg[seg.length - 1].stun,
    };
  })()`));
  console.log('PINNED', JSON.stringify(pinned));
  await evaluate(`window.__thr = 0; 1`);
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
