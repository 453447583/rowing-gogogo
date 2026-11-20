// 熔岩图障碍碰撞全盘审计（无头 Edge + CDP，纯逻辑，不截图）
//   用法：node tests/magma_collision_audit.mjs
//   WB_URL 默认 http://127.0.0.1:5199/（vite dev，实时读源码）
// 检查四类问题：
//   ① 障碍清单：每类 collider 是否带 bottomY/topY（腾空 3D sweep 的门槛）
//   ② 高速冲撞：boost 极速下沿 +X 直冲障碍，是否被拦住 / 是否被推到出口侧
//   ③ 腾空冲撞：airborne 下是否穿模
//   ④ 移动障碍：滚石/浮桶自己扫过静止船时，是否逐帧都有碰撞
//   ⑤ 喷发泉：可见但未生成碰撞的时间窗口
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/magma-collision-${stamp}`);
const port = 9950 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=560,320', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
const waitJson = async (u, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
};

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = tabs.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXC', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
    }
  });
  ws.on('close', () => { for (const p of pending.values()) p.reject(new Error('cdp closed')); pending.clear(); });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.reload'); await sleep(1200);

  for (let i = 0; i < 40; i++) {
    if (val(await evaluate(`(() => { const b=document.querySelector('#btn-solo'); return !!b && typeof b.onclick==='function'; })()`)) === true) break;
    await sleep(300);
  }
  for (let i = 0; i < 10; i++) {
    await evaluate(`(() => { const b=document.querySelector('#btn-solo'); if(!b) return 0; b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); b.click(); return 1; })()`);
    await sleep(700);
    if (val(await evaluate(`!!document.querySelector('#menu-main')?.classList.contains('hidden')`)) === true) break;
  }
  let cards = false;
  for (let i = 0; i < 12 && !cards; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cards = val(await evaluate('!!document.querySelector(".lp-card[data-map]")')) === true;
  }
  if (!cards) throw new Error('地图抽屉打不开');
  const picked = val(await evaluate(`(() => { const c=[...document.querySelectorAll('.lp-card[data-map]')].find(x=>x.dataset.map==='magma'); if(!c) return 'missing'; c.click(); return 'ok'; })()`));
  if (picked !== 'ok') throw new Error('magma 选不到');
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  let ready = false;
  for (let i = 0; i < 90; i++) {
    ready = val(await evaluate('!!window.__game?.localBoat && !!window.__game?.track')) === true;
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('__game 未就绪');
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0; })()`);
  // GLB 异步加载，等静态岩石代理全挂上
  for (let i = 0; i < 30; i++) {
    const n = Number(val(await evaluate(`(() => (window.__game?.track?.magmaObstacles||[]).filter(x=>!!x.holder).length)()`)) || 0);
    if (n >= 9) break;
    await sleep(400);
  }

  const report = val(await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, t = g.track;
    // 固定一个"第一口泉正在喷发"的时刻，保证 magmaGeyser 一定在 collider 清单里
    const gy0 = t.magmaHazards?.geysers?.[0];
    const T = gy0 ? (0.78 - gy0.phase) * gy0.period : g.elapsed + 3;
    t.updateMechs(1/60, T);
    const all = () => [...g.colliders, ...t.shoreColliders, ...t.mechColliders];

    // ---------- ① 障碍清单 ----------
    const types = {};
    const note = (c, where) => {
      const k = (c.type || 'untyped') + '@' + where;
      const e = types[k] || (types[k] = { count: 0, heavy: 0, withHeight: 0, radius: [] });
      e.count++;
      if (c.heavy) e.heavy++;
      if (Number.isFinite(c.bottomY) && Number.isFinite(c.topY)) e.withHeight++;
      e.radius.push(+(c.r || 0).toFixed(2));
    };
    for (const c of g.colliders) note(c, 'env');
    for (const c of t.shoreColliders) note(c, 'shore');
    for (const c of t.mechColliders) note(c, 'mech');
    for (const e of Object.values(types)) {
      e.radius = [Math.min(...e.radius), Math.max(...e.radius)];
    }

    // ---------- ② / ③ 高速 / 腾空冲撞 ----------
    // 每种类型取第一个代表；固定 T 让移动障碍不动，单独测"障碍自身移动"见 ④
    const picks = [];
    const seen = new Set();
    for (const c of [...t.shoreColliders, ...t.mechColliders]) {
      const k = c.type || 'untyped';
      if (!/magma|hammer|buoy/.test(k) || seen.has(k)) continue;
      seen.add(k);
      picks.push({ type: k, x: c.x, z: c.z, r: c.r, heavy: !!c.heavy,
        height: Number.isFinite(c.bottomY) && Number.isFinite(c.topY), ref: c });
    }
    // real=false：只把目标障碍喂给 Boat，隔离出纯 CCD 行为（不受全图其它石头干扰）
    // real=true ：喂全图 colliders + 走 applyMechs，验证真实集成场景
    const runHit = (p, speed, dt, air, real) => {
      // 每个用例都从干净状态起跑：撞碎岩一旦碎掉会有 6s 重生 CD，
      // 不重置会让后续用例"障碍凭空消失"，误报成穿模。
      for (const rk of (t.magmaHazards?.impactRocks || [])) {
        rk.shatterT = 0; rk.hitCd = 0; rk.lootT = 0;
        if (rk.group) rk.group.visible = true;
        if (rk.frags) rk.frags.visible = false;
        if (rk.loot) rk.loot.visible = false;
      }
      for (const ro of (t.magmaHazards?.rollers || [])) ro.shoveT = 0;
      t.updateMechs(1/60, T);
      const ux = 1, uz = 0;                 // 沿世界 +X 直冲，避开赛道护栏方向问题
      b.resetTo(p.x - 16, p.z, Math.atan2(ux, uz));
      b.speed = speed; b.vel.set(speed, 0);
      b.boostTimer = 999;                  // 持续 boost，速度不被松油门水阻吃掉
      b.airborne = !!air; b.waveJump = !!air; b.airTime = 0;
      b.pos.y = air ? 2.0 : 0; b.vy = 0;
      b.stunTimer = 0; b.spinTimer = 0; b.capsizeTimer = 0; b.voidTimer = 0;
      b.onCoaster = null; b.waveLaunchEnabled = false; b.faultFall = 0;
      let minD = 1e9, maxPast = -1e9, feedback = false, frames = 0;
      for (let i = 0; i < 44; i++) {
        t.updateMechs(dt, T);              // 固定 T：障碍保持在同一位置
        b.updateLocal(dt, { throttle: 1, steer: 0, drift: false, nitro: true }, T,
          real ? all() : [p.ref], null);
        if (real) t.applyMechs(b, dt);
        const d = Math.hypot(b.pos.x - p.x, b.pos.z - p.z);
        minD = Math.min(minD, d);
        maxPast = Math.max(maxPast, b.pos.x - p.x);
        if (b.stunTimer > 0 || b.heavyImpactSpeed > 0) feedback = true;
        frames++;
      }
      const R = p.r + 1.3;
      // 撞碎岩被高速撞开后船穿过去是设计内的正反馈，不算穿模
      const shattered = (t.magmaHazards?.impactRocks || []).some(rk => rk.shatterT > 0);
      const breakable = p.type === 'magmaImpact' && shattered;
      return {
        speed, dt: +dt.toFixed(4), air: !!air,
        minD: +minD.toFixed(2), pushR: +R.toFixed(2),
        maxPast: +maxPast.toFixed(2),
        neverDetected: minD >= R + 0.05,
        crossed: maxPast > R + 1.0 && !breakable,
        breakable,
        feedback,
        finalSpeed: +b.speed.toFixed(1),
      };
    };
    const hits = [];
    const graze = [];
    for (const p of picks) {
      const rows = [];
      const realRows = [];
      for (const speed of [20, 38, 56]) {
        for (const dt of [1/60, 0.05]) {
          for (const air of [false, true]) {
            rows.push(runHit(p, speed, dt, air, false));
            realRows.push(runHit(p, speed, dt, air, true));
          }
        }
      }
      const bad = rows.filter(r => r.neverDetected || r.crossed);
      const realBad = realRows.filter(r => r.neverDetected || r.crossed);
      hits.push({ type: p.type, r: p.r, heavy: p.heavy, height: p.height,
        cases: rows.length, bad: bad.length, realBad: realBad.length,
        breakable: rows.filter(r => r.breakable).length,
        noFeedback: rows.filter(r => !r.feedback).length,
        badSample: bad.slice(0, 6), realBadSample: realBad.slice(0, 4) });

      // 擦边：从障碍上游、横向偏 0.92×碰撞半径处直冲。
      // 这里只检验 CCD 不会把船"反向弹回"或把横向偏移抹平（那样才是法线回归）；
      // 擦到边掉速停住是原有的撞击反馈，不算 bug。
      const R = p.r + 1.3;
      b.resetTo(p.x - 16, p.z + R * 0.92, Math.atan2(1, 0));
      b.speed = 26; b.vel.set(26, 0); b.boostTimer = 0;
      b.airborne = false; b.waveJump = false; b.pos.y = 0; b.vy = 0;
      b.stunTimer = 0; b.onCoaster = null; b.waveLaunchEnabled = false;
      t.updateMechs(1/60, T);
      let grazePast = -1e9;
      for (let i = 0; i < 60; i++) {
        b.updateLocal(1/60, { throttle: 1, steer: 0, drift: false, nitro: false }, T, [p.ref], null);
        grazePast = Math.max(grazePast, b.pos.x - p.x);
      }
      // heavy 滚石撞上会走法向回弹 + 甩头，船被弹到赛道中线属正常；
      // 只要求"没被反向弹飞 / 没卡死在起点"，不要求横向偏移原封不动。
      graze.push({ type: p.type, past: +grazePast.toFixed(2),
        lateral: +(b.pos.z - p.z).toFixed(2),
        notRepelled: grazePast > -4 });
    }

    // ---------- ④ 移动障碍扫过静止船 ----------
    const moving = [];
    for (const kind of ['magmaRoller', 'magmaDrifter']) {
      const c0 = t.mechColliders.find(c => c.type === kind);
      if (!c0) continue;
      b.resetTo(c0.x, c0.z, Math.PI/2);
      b.speed = 0; b.vel.set(0, 0); b.boostTimer = 0;
      b.airborne = false; b.waveJump = false; b.pos.y = 0;
      b.stunTimer = 0; b.onCoaster = null; b.waveLaunchEnabled = false;
      let minD = 1e9, overlapFrames = 0, pushed = 0;
      for (let i = 0; i < 120; i++) {
        const tt = T + i * 0.05;
        t.updateMechs(0.05, tt);
        const c = t.mechColliders.find(x => x.type === kind);
        b.updateLocal(0.05, { throttle: 0, steer: 0, drift: false, nitro: false }, tt, all(), null);
        t.applyMechs(b, 0.05);
        if (!c) continue;
        const d = Math.hypot(b.pos.x - c.x, b.pos.z - c.z);
        minD = Math.min(minD, d);
        if (d < c.r + 1.3) overlapFrames++;
        if (d >= c.r + 1.3 - 0.01) pushed++;
      }
      moving.push({ kind, minD: +minD.toFixed(2), overlapFrames, pushedFrames: pushed });
    }

    // ---------- ⑤ 喷发泉可见 / 可撞窗口 ----------
    const geyserWindows = [];
    const gy = t.magmaHazards?.geysers?.[0];
    if (gy) {
      for (const c of [0.58, 0.63, 0.68, 0.74, 0.80, 0.90, 0.95]) {
        t.updateMechs(1/60, gy.period * c - gy.phase * gy.period);
        const visible = !!gy.column.visible;
        const col = t.mechColliders.find(x => x.type === 'magmaGeyser' && Math.abs(x.x - gy.x) < 0.01);
        geyserWindows.push({ phase: c, up: +(gy.up01 || 0).toFixed(2), visible, hasCollider: !!col });
      }
      t.updateMechs(1/60, T);
    }

    return { map: g.mapDef.id, types, hits, graze, moving, geyserWindows };
  })()`));

  if (!report || typeof report !== 'object') throw new Error('审计返回异常: ' + JSON.stringify(report));
  console.log('=== 障碍清单 ===');
  console.log(JSON.stringify(report.types, null, 1));
  console.log('=== 冲撞结果 ===');
  for (const h of report.hits) {
    console.log(`${h.type.padEnd(16)} r=${h.r} heavy=${h.heavy} height=${h.height}  隔离bad=${h.bad}/${h.cases}  实图bad=${h.realBad}/${h.cases}  breakable=${h.breakable}  noFeedback=${h.noFeedback}`);
    for (const s of h.badSample) console.log('    ISO', JSON.stringify(s));
    for (const s of h.realBadSample) console.log('    REAL', JSON.stringify(s));
  }
  console.log('=== 擦边绕行（不该被钉住） ===');
  console.log(JSON.stringify(report.graze));
  console.log('=== 移动障碍扫过静止船 ===');
  console.log(JSON.stringify(report.moving, null, 1));
  console.log('=== 喷发泉窗口 ===');
  console.log(JSON.stringify(report.geyserWindows, null, 1));
  const totalBad = report.hits.reduce((a, h) => a + h.bad + h.realBad, 0);
  const grazeRepelled = report.graze.filter(x => !x.notRepelled).length;
  console.log('TOTAL_BAD', totalBad, 'GRAZE_REPELLED', grazeRepelled);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
  child.kill();
  await sleep(300);
  // D:/3dgame-tmp/browser 目录不删（safe-delete 钩子会 ETIMEDOUT）
});
