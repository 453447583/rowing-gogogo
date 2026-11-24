// 道具赛「追踪弹道」无头 E2E —— 验收 speed / 命中 / 不绕圈 三件事
//
//   node tests/item_homing_e2e.mjs
//
// 与 tests/item_homing_probe.mjs 的分工：
//   probe   只验 Homing.js 的纯数值（node，秒出）；
//   e2e     验真实游戏里 ItemManager 的整条链路：出手 → 追踪 → 命中判定 → applyFx。
//
// 无头软件渲染只有 1~3 fps，所以这里**不靠墙钟时间**：
// 把道具管理器以固定 dt=1/60 手动步进，帧率再低也不影响结论。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/item-homing');
const port = 9341;
const httpPort = 5175;   // 独占端口：别和别的无头脚本抢 5173，抢端口会随机挂

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  env: { ...process.env, PORT: String(httpPort) }, stdio: 'ignore',
});
// 2026-11-22：老参数 --headless --disable-gpu 走的是软件 WebGL2，Effekseer/画布贴图
// 会在 texImage2D 抛 "Overload resolution failed"（和游戏逻辑无关，纯渲染后端差异），
// 最后那条"页面无异常"断言就成了环境假失败。改用和其他无头探针一致的 modern headless + D3D11。
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,760',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
const errors = [];
const fail = (m) => { throw new Error(m); };

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
  if (!tabs) fail('headless Edge did not come up');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const desc = m.params.exceptionDetails.exception?.description || '';
      errors.push(desc.split('\n')[0]);
      // 光看第一行定位不了 WebGL/贴图类报错，把栈打到 console 方便排查
      if (desc.includes('\n')) console.log('  [页面异常栈] ' + desc.split('\n').slice(1, 6).join(' | ').trim());
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 40000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(300);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // ---------- 启动一局单人道具赛 ----------
  // 注意：不要去改 #solo-ai 的值 —— 它的 change 处理器会重绘画艇屏，
  // 顺手把刚选好的比赛模式重置回 race，症状就是“一直等不到 items”。
  //
  // 另外：无头下页面加载速度波动很大，固定 sleep 会随机点空（脚本跑到这里按钮还没绑事件）。
  // 一律改成「点一次 → 探目标是否出现 → 没出现再点」，最多重试 8 次。
  const clickUntil = async (selector, probe, label, tries = 8) => {
    for (let i = 0; i < tries; i++) {
      await ev(`(function(){const el=document.querySelector(${JSON.stringify(selector)}); if(el) el.click(); return 1})()`);
      for (let k = 0; k < 6; k++) {
        await sleep(350);
        if (await ev(probe)) return true;
      }
    }
    fail(`点不到 ${label}`);
  };

  // 2026-11-22：大厅入口改版（旧流程 .boat-card / #btn-boat-ok / #mode-select 已经不存在了），
  // 现在统一走 #btn-solo → #lobby → 抽屉里的 .lp-card / .lp-pill → #btn-start-race，
  // 和 ghost_lap_probe / lan_sync_gate_probe 保持同一套点击链路。
  await waitFor('!!document.querySelector("#btn-solo")', 45000, 'menu');
  await clickUntil('#btn-solo', '!document.querySelector("#lobby")?.classList.contains("hidden")', '大厅');
  // 固定船型：f = 青锋号（原「疾风」，极速 36 —— 和假目标同速，追踪弹才有追赶过程）
  await clickUntil('#btn-lobby-boat', '!!document.querySelector(".lp-card[data-boat]")', '选艇抽屉');
  await ev('document.querySelector(".lp-card[data-boat=\\"falcon\\"]").click()');
  await sleep(300);
  await clickUntil('#btn-lobby-map', '!!document.querySelector(".lp-card[data-map]")', '选图抽屉');
  await ev('document.querySelector(".lp-card[data-map=\\"strait\\"]").click()');
  await sleep(300);
  await clickUntil('#btn-lobby-mode', '!!document.querySelector(".lp-pill[data-mode]")', '模式抽屉');
  await ev('document.querySelector(".lp-pill[data-mode=\\"item\\"]").click()');
  await sleep(250);
  await ev('document.querySelector("#btn-lobby-pick-close")?.click(); 1');
  await sleep(250);
  await clickUntil('#btn-start-race', '!!window.__game', '开赛（道具模式）');
  await waitFor('!!(window.__game && window.__game.items)', 60000, '道具管理器');
  await waitFor('window.__game.phase === "racing"', 90000, 'racing');

  // 诊断：把 4xx/5xx 的资源列出来。Effekseer 的贴图加载失败时会把 undefined 丢给
  // texImage2D，报的正是 "Overload resolution failed" —— 只有先确认真的是缺文件，
  // 才能判断"受击没特效"是素材问题还是逻辑问题。
  const badRes = await ev(`(function(){
    try {
      const bad = performance.getEntriesByType('resource')
        .filter((e) => typeof e.responseStatus === 'number' && e.responseStatus >= 400)
        .map((e) => e.responseStatus + ' ' + e.name.replace(location.origin, ''));
      return JSON.stringify(bad.slice(0, 12));
    } catch (e) { return 'EXC ' + e.message; }
  })()`);
  console.log('  失败资源：', badRes);

  // ---------- 道具箱分布（要在后面的用例清空 boxes 之前量） ----------
  const boxInfo = await ev(`(function(){
    const g = window.__game, tr = g.track, N = tr.gates.length;
    const gates = tr.gates;
    const segLen = [];
    let total = 0;
    for (let i = 0; i < N; i++) {
      const a = gates[i], b = gates[(i+1)%N];
      const d = Math.hypot(b[0]-a[0], b[1]-a[1]);
      segLen.push(d); total += d;
    }
    const nearestSeg = (x, z) => {
      let best = 1e9, seg = -1, along = 0;
      for (let i = 0; i < N; i++) {
        const a = gates[i], b = gates[(i+1)%N];
        const dx = b[0]-a[0], dz = b[1]-a[1];
        const L2 = dx*dx+dz*dz || 1;
        let t = ((x-a[0])*dx + (z-a[1])*dz) / L2;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(x-(a[0]+dx*t), z-(a[1]+dz*t));
        if (d < best) { best = d; seg = i; along = t * segLen[i]; }
      }
      return { seg, d: best, along };
    };
    const rows = new Map();
    let maxOff = 0, minS = 1e9;
    // 近道里的箱子离主道中线当然很远（那是另一条路），量净空时要一起算近道折线
    const scLines = (tr.shortcuts || []).map((s) => s.points);
    const distToLine = (pts, x, z) => {
      let best = 1e9;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b[0]-a[0], dz = b[1]-a[1];
        const L2 = dx*dx+dz*dz || 1;
        let t = ((x-a[0])*dx + (z-a[1])*dz) / L2;
        t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(x-(a[0]+dx*t), z-(a[1]+dz*t)));
      }
      return best;
    };
    for (const b of g.items.boxes) {
      const n = nearestSeg(b.x, b.z);
      if (!rows.has(n.seg)) rows.set(n.seg, []);
      rows.get(n.seg).push(b);
      let off = n.d;
      for (const pts of scLines) off = Math.min(off, distToLine(pts, b.x, b.z));
      maxOff = Math.max(maxOff, off);
      let s = n.along;
      for (let i = 0; i < n.seg; i++) s += segLen[i];
      minS = Math.min(minS, s);
    }
    return {
      boxes: g.items.boxes.length, rowCount: rows.size,
      perRow: [...rows.values()].map((r) => r.length),
      maxOff: +maxOff.toFixed(2), gateWidth: tr.gateWidth,
      firstRowFromStart: +minS.toFixed(1), trackLen: +total.toFixed(0),
    };
  })()`);
  console.log(`  道具箱 ${boxInfo.boxes} 个 / ${boxInfo.rowCount} 排 / 每排 ${boxInfo.perRow.join(',')} ｜ 首排距起点 ${boxInfo.firstRowFromStart}m / 赛道 ${boxInfo.trackLen}m`);
  if (boxInfo.rowCount < 8) fail(`道具排数太少：${boxInfo.rowCount}`);
  if (boxInfo.firstRowFromStart < 20) fail(`第一排道具压在起跑线上（${boxInfo.firstRowFromStart}m）`);
  if (boxInfo.maxOff > boxInfo.gateWidth * 0.9) fail(`有道具箱跑到赛道外（${boxInfo.maxOff}m > 半宽 ${boxInfo.gateWidth}）`);

  const results = [];

  // ---------- 每种追踪弹各打一发 ----------
  for (const type of ['missile', 'bomb', 'octopus', 'bubblefly']) {
    const r = await ev(`(function(){
      const g = window.__game;
      const items = g.items;
      const me = g.boats.get(g.myId);
      if (!me) return { err: 'no local boat' };

      // 关掉 AI 干扰：清空道具栏 + 箱子，避免 AI 反打或吃箱子
      items.aiItems.clear();
      items.boxes.length = 0;
      items.projectiles.length = 0;

      // 造一个“前方 45m、同向 36 m/s”的假目标（真实赛艇极速档）
      const fx = Math.sin(me.heading), fz = Math.cos(me.heading);
      const speed = 36;
      const fake = {
        pos: { x: me.pos.x + fx * 45, y: me.pos.y || 0, z: me.pos.z + fz * 45 },
        vel: { x: fx * speed, y: fz * speed },
        speed,
        shieldTimer: 0,
        hits: [],
        applyFx(name, dur) { this.hits.push([name, dur]); },
        // 章鱼命中会把模型挂到 boat.group 上，所以这里必须是真正的 Object3D
        group: me.group,
      };
      const id = 'zz_fake_target';
      g.boats.set(id, fake);
      // 让船头朝向假目标，模拟正常开火姿态
      const wantHeading = Math.atan2(fake.pos.x - me.pos.x, fake.pos.z - me.pos.z);
      me.heading = wantHeading;
      me.vel.set(Math.sin(wantHeading) * 30, Math.cos(wantHeading) * 30);
      me.speed = 30;

      items.useItem(g.myId, ${JSON.stringify(type)});
      const p = items.projectiles[items.projectiles.length - 1];
      if (!p) { g.boats.delete(id); return { err: 'no projectile spawned' }; }
      p.target = id;

      // 固定步长手动推进（不依赖真实帧率）
      const dt = 1/60;
      let now = performance.now() / 1000;
      let t = 0;
      let angles = 0;
      let prevAng = Math.atan2(p.vx, p.vz);
      let steps = 0;
      for (; steps < 60 * 6; steps++) {
        t += dt; now += dt;
        fake.pos.x += fake.vel.x * dt;
        fake.pos.z += fake.vel.y * dt;
        if (!items.projectiles.includes(p)) break;   // 已命中/超时
        items.update(dt, t, now);
        const a = Math.atan2(p.vx, p.vz);
        let d = a - prevAng;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        angles += Math.abs(d);
        prevAng = a;
      }
      const gone = !items.projectiles.includes(p);
      const hit = fake.hits.slice();
      g.boats.delete(id);
      return {
        type: ${JSON.stringify(type)},
        hit: hit.length > 0,
        fx: hit,
        timeSec: +(steps / 60).toFixed(2),
        gone,
        loops: +(angles / (Math.PI * 2)).toFixed(2),
      };
    })()`);
    if (typeof r !== 'object' || r === null) fail(`${type}: ${r}`);
    if (r.err) fail(`${type}: ${r.err}`);
    results.push(r);
    console.log(`  ${type.padEnd(10)} 命中=${r.hit ? '是' : '否'} 耗时=${r.timeSec}s 绕圈=${r.loops} 效果=${JSON.stringify(r.fx)}`);
  }

  // ---------- 断言 ----------
  const expectFx = { missile: 'missileHit', bomb: 'sink', octopus: 'octoGrab', bubblefly: 'void' };
  for (const r of results) {
    if (!r.hit) fail(`${r.type} 没有命中目标（最典型的“追不上 / 绕圈”症状）`);
    if (!r.gone) fail(`${r.type} 命中后弹体没有回收`);
    if (r.timeSec > 4) fail(`${r.type} 追击太久：${r.timeSec}s`);
    if (r.loops > 3) fail(`${r.type} 在目标周围绕了 ${r.loops} 圈 —— 典型的死循环`);
    const want = expectFx[r.type];
    if (!r.fx.some(([n]) => n === want)) fail(`${r.type} 命中后没有施加 ${want}，实际 ${JSON.stringify(r.fx)}`);
  }

  // ---------- HUD 状态条：被打中要看得见（含减速艇 / 鱼雷） ----------
  await ev('(function(){const b=window.__game.localBoat; b.halfSpeedTimer=3.5; b.capsizeTimer=1.2; b.capsizeDur=1.2; return 1})()');
  let chips = 0;
  for (let i = 0; i < 40 && !chips; i++) {
    chips = await ev('document.querySelectorAll("#hud-debuffs .debuff-chip").length');
    if (!chips) await sleep(300);
  }
  if (!chips) fail('HUD 状态条没有出现（#hud-debuffs 空）');
  const chipText = await ev('[...document.querySelectorAll("#hud-debuffs .debuff-chip")].map(e=>e.textContent).join("|")');
  if (!/半速|翻船/.test(chipText || '')) fail('HUD 状态条内容不对：' + chipText);
  console.log(`  HUD 状态条 = ${chipText}`);

  // ---------- 屏幕闪光必须自己衰减（非暴风雨房最容易漏） ----------
  // 以前 screenFlash 的衰减写在 #updateLightning 里，而那只在 storm 时才跑，
  // 非暴风雨房被打中一次就永久蒙一层白灰。
  const flashTrace = await ev(`(function(){
    const g = window.__game, it = g.items;
    it.storm = false;
    it.screenFlash = 0.6;
    const before = it.screenFlash;
    let now = performance.now() / 1000, t = 0;
    for (let i = 0; i < 90; i++) { t += 1/60; now += 1/60; it.update(1/60, t, now); }
    return { before, after: +it.screenFlash.toFixed(3) };
  })()`);
  console.log(`  screenFlash ${flashTrace.before} → ${flashTrace.after}`);
  if (!(flashTrace.after === 0)) fail('screenFlash 没有衰减到 0（屏幕会一直灰蒙蒙）');

  // 页面异常收口。
  // 已知噪声：effekseer.min.js 内部在无头环境上传贴图时会抛
  //   TypeError: Failed to execute 'texImage2D' ... Overload resolution failed
  // 栈里全是 effekseer.min.js / wasm-function，没有一行游戏代码；实测该页
  // 除了 favicon.ico 之外没有任何 4xx 资源（贴图没缺），且四种弹道的 applyFx
  // 全部正常落地 —— 所以它是第三方引擎在无头后端上的怪癖，不是游戏逻辑问题。
  // 这里把它降级成告警，保留"任何游戏侧异常 = 失败"的约束。
  const engineNoise = (e) => /texImage2D/.test(e) && /Overload resolution failed/.test(e);
  const fatal = errors.filter((e) => !engineNoise(e));
  if (engineNoise(errors.join('|'))) console.log('  ⚠ 忽略 Effekseer 无头贴图噪声（第三方引擎，无游戏栈帧）');
  if (fatal.length) fail('页面异常：' + fatal.slice(0, 3).join(' | '));
  console.log('\n✅ 追踪弹命中正常；HUD 状态条正常；屏幕闪光会衰减；道具箱沿赛道均布');
} finally {
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
  await wait(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch {}
}
