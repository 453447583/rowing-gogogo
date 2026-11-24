// 挑战模式（影子对战）的浏览器端探针
//
//   node tests/ghost_lap_probe.mjs
//   MAP=canyon node tests/ghost_lap_probe.mjs
//
// 验六件事（全部读真实 DOM 与真实 Game 状态，不靠肉眼看图）：
//   ⓪ 普通竞速不再出现影子（幽灵只属于挑战模式）；
//   ① 挑战模式里没有记录时：不建影子，HUD 差值条隐藏；
//   ② 有记录时：建出影子、按时间轴推进、HUD 差值条出现；
//   ③ 圈评 / 归因共用中央偏下一条轨道，归因会压掉圈评；
//   ④ 设置页「辅助」已删掉幽灵开关（只剩 2 个开关 + 清除按钮）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/ghost-${stamp}`;
const port = 9730 + (Number(stamp.slice(-3)) % 30);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = `${base}?raceIntro=0`;
const mapId = process.env.MAP || 'strait';
// 探针固定用同一艘艇：幽灵存档 key 含 boatId，船一变就读不到刚写的记录
const BOAT = process.env.BOAT || 'rower';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 90000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

let failed = 0;
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

/** 进大厅 → 选图 → 0 AI →（可选）切模式 → 开赛 */
async function startSolo(mode = null, { waitRacing = true } = {}) {
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  // 固定船型：幽灵存档是按「地图 × 船型」分 key 的，reload 后如果默认船变了，
  // 就会读不到刚写的记录（第一次跑通、第二次跑不通，就是这个坑）。
  await evaluate(`document.querySelector('#btn-lobby-boat')?.click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-boat="${BOAT}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-boat="${BOAT}"]').click(); 1`);
  await sleep(250);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  // 挑战模式：在「模式」抽屉的独立卡片里切（2026-11-18 起幽灵只在这个模式出现）
  if (mode === 'challenge') {
    await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
    await waitFor(`!!document.querySelector('.lp-boss-card[data-mode="challenge"]')`, 60000);
    await evaluate(`document.querySelector('.lp-boss-card[data-mode="challenge"]').click(); 1`);
    await sleep(250);
    await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
    await sleep(200);
  }
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 150000);
  // #initGhost 在构造函数里（#createBoats 之后）就已经跑完了，所以「有没有影子」
  // 不必等倒计时结束 —— 无头低帧率下倒计时按游戏内时间走，等它纯粹是浪费时间，
  // 而且页面被判定成后台标签时 rAF 会停，等待会假超时。
  if (!waitRacing) return;
  // 倒计时 3.5 秒是「游戏内时间」：无头浏览器偶发掉到 1~2fps（着色器首帧编译 +
  // 软件回退）时，墙钟要 2 分钟以上才数完，120s 会假超时 —— 给到 240s。
  await waitFor(`window.__game?.phase === 'racing'`, 240000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
  await sleep(400);
}

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
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
  // 页面被判定成后台标签时 rAF 会被节流/暂停，倒计时（按游戏内时间走）就永远数不完
  try { await cdp('Page.bringToFront'); } catch { /* 老版本 CDP 没有这个方法 */ }

  // 先把旧幽灵清干净，保证「没记录」的分支是真的没记录
  await evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('rr-ghost-v1:')) localStorage.removeItem(k); return 1; })()`);

  // ---------- ⓪ 普通竞速：影子不再出现 ----------
  // 2026-11-18：幽灵车从「设置开关」升级成独立挑战模式，普通竞速 / 道具里
  // 不应该再有那艘半透明船（否则分不清是影子还是对手）。
  await startSolo('race', { waitRacing: false });
  const plainRaw = await evaluate(`(() => {
    const g = window.__game;
    if (!g) return { err: 'no __game', screen: document.body.className };
    return {
      mode: g.mode, challenge: !!g.challenge, hasGhost: !!g.ghostBoat,
      phase: g.phase, boats: (g.order || []).length,
    };
  })()`);
  console.log('race 局状态 =', JSON.stringify(plainRaw?.result?.value
    ?? plainRaw?.exceptionDetails?.exception?.description));
  const plain = val(plainRaw);
  report(plain && plain.mode === 'race' && plain.challenge === false,
    `普通竞速 challenge=false（mode=${plain?.mode}）`);
  report(plain && !plain.hasGhost, '普通竞速不建影子（影子只属于挑战模式）');

  // 回大厅切到挑战模式，后面全部用例都在挑战模式里跑
  await cdp('Page.navigate', { url });
  await sleep(2000);
  try { await cdp('Page.bringToFront'); } catch { /* 老版本 CDP 没有这个方法 */ }
  await startSolo('challenge');
  const modeInfo = val(await evaluate(`(() => ({
    challenge: !!window.__game.challenge,
    mode: window.__game.mode,
    boats: window.__game.order.length,
  }))()`));
  report(modeInfo && modeInfo.challenge && modeInfo.mode === 'race',
    '挑战模式：mode 归一化成 race + challenge=true');
  report(modeInfo && modeInfo.boats === 1, `挑战模式强制 0 AI（场上 ${modeInfo?.boats} 人）`);

  // ---------- ① 无记录 ----------
  const noRec = val(await evaluate(`(() => ({
    hasGhost: !!window.__game.ghostBoat,
    stripHidden: document.querySelector('#ghost-strip').classList.contains('hidden'),
  }))()`));
  report(noRec && !noRec.hasGhost, `无记录时不建幽灵（ghostBoat=${noRec?.hasGhost}）`);
  report(noRec && noRec.stripHidden, '无记录时右下差值条隐藏');

  const meta = val(await evaluate(`(() => {
    const g = window.__game;
    return { mapId: g.mapDef.id, boatId: g.myEntry.boatId,
      arcTotal: g.track.arcTotal, gates: g.track.gates.length,
      spawn: { x: g.mySpawn.x, z: g.mySpawn.z }, lapArc: g.progressMap.get(g.myId).lapArc };
  })()`));
  console.log('race =', JSON.stringify(meta));

  // ---------- 写一条合成记录：沿门中心线、60 秒一圈 ----------
  const wrote = val(await evaluate(`(async () => {
    const mod = await import('/src/game/GhostStore.js');
    const g = window.__game;
    const tr = g.track;
    const N = tr.gates.length;
    const segs = (tr.openTrack && !tr.loopClosed) ? N - 1 : N;
    const LAP = 60, HZ = 20;
    const total = (() => { let s = 0; for (let i = 0; i < segs; i++) {
      const a = tr.gates[i], b = tr.gates[(i + 1) % N];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    } return s; })();
    const speed = total / LAP;                 // m/s
    const samples = [];
    let acc = 0;
    for (let k = 0; k < LAP * HZ; k++) {
      const arc = (k / (LAP * HZ)) * total;
      let run = 0, px = tr.gates[0][0], pz = tr.gates[0][1], hd = 0;
      for (let i = 0; i < segs; i++) {
        const a = tr.gates[i], b = tr.gates[(i + 1) % N];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (run + L >= arc) {
          const f = (arc - run) / (L || 1);
          px = a[0] + (b[0] - a[0]) * f;
          pz = a[1] + (b[1] - a[1]) * f;
          hd = Math.atan2(b[0] - a[0], b[1] - a[1]);
          break;
        }
        run += L; px = b[0]; pz = b[1];
      }
      samples.push(1000 / HZ, px, pz, hd);
    }
    const rec = mod.encodeGhost(samples, {
      mapId: g.mapDef.id, boatId: g.myEntry.boatId, arcTotal: total, lapTime: LAP, hz: HZ,
    });
    rec.lapArc = g.progressMap.get(g.myId).lapArc;
    mod.writeGhost(rec);
    return { n: rec.n, bytes: Math.round(rec.data.length / 1024), speed: +speed.toFixed(1) };
  })()`));
  console.log('synth record =', JSON.stringify(wrote));
  if (!wrote?.n) throw new Error('合成记录写入失败');

  // ---------- ② 重新开局，幽灵应当在 ----------
  await cdp('Page.navigate', { url });
  await sleep(2000);
  try { await cdp('Page.bringToFront'); } catch { /* 老版本 CDP 没有这个方法 */ }
  await startSolo('challenge');
  await sleep(600);

  const g1 = val(await evaluate(`(() => {
    const g = window.__game;
    return {
      hasGhost: !!g.ghostBoat,
      loaded: !!g.ghostRecord,
      bestLap: g.ghostRecord?.lapTime,
      // 幽灵的模型树必须有 mesh（材质被染成半透明）
      meshes: (() => { let n = 0; g.ghostBoat?.boat?.group?.traverse((o) => { if (o.isMesh) n += 1; }); return n; })(),
      ghostPos: g.ghostBoat ? { x: +g.ghostBoat.boat.pos.x.toFixed(1), z: +g.ghostBoat.boat.pos.z.toFixed(1) } : null,
      playerPos: { x: +g.localBoat.pos.x.toFixed(1), z: +g.localBoat.pos.z.toFixed(1) },
    };
  })()`));
  report(g1 && g1.hasGhost, `有记录时建出幽灵（bestLap=${g1?.bestLap}s）`);
  report(g1 && g1.meshes > 0, `幽灵有实体网格（${g1?.meshes} 个 mesh）`);

  // 时间推进：把本圈时间推到 20 秒，幽灵必须沿轨迹跑到别处（不是钉在起点）
  const p0 = g1?.ghostPos;
  await evaluate(`(() => { const g = window.__game; g.lapStart = g.raceTime - 20; return 1; })()`);
  await sleep(600);
  const g2 = val(await evaluate(`(() => {
    const g = window.__game;
    return {
      ghostPos: { x: +g.ghostBoat.boat.pos.x.toFixed(1), z: +g.ghostBoat.boat.pos.z.toFixed(1) },
      delta: g.ghostDelta == null ? null : +g.ghostDelta.toFixed(2),
      visible: g.ghostBoat.root.visible,
      stripHidden: document.querySelector('#ghost-strip').classList.contains('hidden'),
      deltaText: document.querySelector('#ghost-delta').textContent,
      tagVisible: g.ghostBoat.tag.visible,
    };
  })()`));
  const moved = p0 && g2 && Math.hypot(g2.ghostPos.x - p0.x, g2.ghostPos.z - p0.z) > 20;
  report(moved, `幽灵随时间轴推进（移动 ${p0 && g2 ? Math.hypot(g2.ghostPos.x - p0.x, g2.ghostPos.z - p0.z).toFixed(0) : '?'}m）`);
  report(g2 && !g2.stripHidden && /\d\.\d\d/.test(g2.deltaText || ''), `右下差值条显示（${g2?.deltaText}）`);
  report(g2 && g2.visible, '落后时幽灵可见');
  report(g2 && g2.tagVisible, '车顶差值牌可见');

  // ---------- ②b 领先时藏起来（A3 口径）----------
  // 把船挪到赛道 30%、本圈计时拨到 10 秒：幽灵跑到同一位置要 18 秒，
  // 玩家领先 8 秒 → 幽灵与差值条都应该收起来。
  // （只挪到 30% 而不是 95%：进度换算里"负差值小于半圈才补一圈"，
  //   30% 的差值 -0.7 圈会被正确补回，95% 的 -0.05 圈会被当成还没出发）
  await evaluate(`(() => {
    const g = window.__game, tr = g.track, b = g.localBoat;
    const arc = tr.arcTotal * 0.3;
    const N = tr.gates.length;
    const segs = (tr.openTrack && !tr.loopClosed) ? N - 1 : N;
    let run = 0, px = tr.gates[0][0], pz = tr.gates[0][1];
    for (let i = 0; i < segs; i++) {
      const a = tr.gates[i], c = tr.gates[(i + 1) % N];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (run + L >= arc) {
        const f = (arc - run) / (L || 1);
        px = a[0] + (c[0] - a[0]) * f; pz = a[1] + (c[1] - a[1]) * f; break;
      }
      run += L; px = c[0]; pz = c[1];
    }
    b.pos.set(px, b.pos.y, pz);
    b.prevPos.copy(b.pos);
    g.lapStart = g.raceTime - 10;
    return 1;
  })()`);
  await sleep(450);
  const lead = val(await evaluate(`(() => {
    const g = window.__game;
    return {
      delta: g.ghostDelta == null ? null : +g.ghostDelta.toFixed(2),
      visible: g.ghostBoat.root.visible,
      stripHidden: document.querySelector('#ghost-strip').classList.contains('hidden'),
    };
  })()`));
  // 挑战模式里影子恒在场上（没有「领先就藏」的阈值开关了）：
  // 明明领先 7 秒，影子与差值条仍然必须在。
  report(lead && lead.delta < -0.6 && !!lead.visible && !lead.stripHidden,
    `领先 ${lead?.delta}s 时幽灵仍然可见（默认不隐藏）`);

  // ---------- ②c 出图：半透明幽灵在追尾机位下长什么样 ----------
  try {
    // 先等 GLB 就位（否则拍到的是程序化后备方块，看不出半透明的实际观感）
    try {
      await waitFor(`!!window.__game?.ghostBoat?.boat?.modelRoot`, 25000);
      await sleep(300);
    } catch { console.log('GLB 未就绪，用后备艇体出图'); }
    const look = val(await evaluate(`(() => {
      const b = window.__game.ghostBoat.boat;
      let meshes = 0, transparent = 0;
      b.group.traverse((o) => {
        if (!o.isMesh) return;
        meshes += 1;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        if (ms.some((m) => m && m.transparent && m.opacity < 0.6)) transparent += 1;
      });
      return { fallbackVisible: b.fallbackHull?.visible, hasModel: !!b.modelRoot, meshes, transparent };
    })()`));
    console.log('ghost look =', JSON.stringify(look));
    const jpg = val(await evaluate(`(() => {
      const g = window.__game, gb = g.ghostBoat, b = g.localBoat;
      // 把时间拨回幽灵刚出发，玩家退到幽灵正后方 9m、机位抬到 6m
      g.lapStart = g.raceTime - 6;
      gb.update(0.016, g.elapsed, 6, 0.1);
      const gp = gb.boat.pos;
      const hx = Math.sin(gb.boat.heading), hz = Math.cos(gb.boat.heading);
      g.cameraRig.follow = () => {};
      g.camera.position.set(gp.x - hx * 13, 5.6, gp.z - hz * 13);
      g.camera.lookAt(gp.x, 1.1, gp.z);
      g.camera.updateMatrixWorld(true);
      g.ghostBoat.setVisible(true);
      g.renderer.render(g.scene, g.camera);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.86);
    })()`));
    if (typeof jpg === 'string' && jpg.startsWith('data:image')) {
      await fs.mkdir('shots/ghost', { recursive: true });
      await fs.writeFile(`shots/ghost/${mapId}-ghost.jpg`, Buffer.from(jpg.split(',')[1], 'base64'));
      console.log('shot → shots/ghost/' + mapId + '-ghost.jpg');
    }
  } catch (e) {
    console.log('shot skipped:', e.message);
  }

  // ---------- ③ 中央提示条：归因 / 系统提示 / 圈评共用同一个槽 ----------
  await evaluate(`(() => {
    const g = window.__game;
    g.notice = { main: '测试评价', sub: '第 2 段慢了 0.40 秒', tone: 'red', priority: 1 };
    g.noticeTtl = 1.2; g.noticePending = null;
    return 1;
  })()`);
  await sleep(260);
  const rev = val(await evaluate(`(() => {
    const chip = document.querySelector('#assist-chip');
    return {
      shown: parseFloat(chip.style.opacity || '0') > 0,
      main: document.querySelector('#ac-main').textContent,
      sub: document.querySelector('#ac-sub').textContent,
      tone: chip.dataset.tone,
    };
  })()`));
  report(rev && rev.shown && rev.main === '测试评价', `圈评渲染（${rev?.main} / ${rev?.sub}）`);
  report(rev && rev.tone === 'red', `圈评语气色生效（tone=${rev?.tone}）`);

  // 打点：写进去之后轮询看 DOM 什么时候换字，同时把 ttl / 可见性也带回来
  // （无头低帧率下 200ms 可能一帧都没跑，固定 sleep 会误判成"没渲染"）
  await evaluate(`(() => {
    const g = window.__game;
    g.notice = { main: '🧱 撞墙', sub: '蹭到护栏', tone: 'red', priority: 3 };
    g.noticeTtl = 0.9; g.noticePending = null;
    window.__probeFrames = 0;
    return 1;
  })()`);
  let imp = null;
  for (let i = 0; i < 24; i++) {
    imp = val(await evaluate(`(() => {
      const g = window.__game;
      const chip = document.querySelector('#assist-chip');
      return {
        shown: parseFloat(chip.style.opacity || '0') > 0,
        main: document.querySelector('#ac-main').textContent,
        sub: document.querySelector('#ac-sub').textContent,
        tone: chip.dataset.tone,
        ttl: +Number(g.noticeTtl).toFixed(2),
        phase: g.phase,
        hidden: document.hidden,
      };
    })()`));
    if (imp && /撞墙/.test(imp.main)) break;
    await sleep(150);
  }
  report(imp && imp.shown && /撞墙/.test(imp.main),
    `归因徽章渲染（${imp?.main} · ${imp?.sub}｜ttl=${imp?.ttl} phase=${imp?.phase} hidden=${imp?.hidden}）`);
  report(imp && imp.tone === 'red', '物理撞击走红色（和道具受击的紫色分开）');

  // 超时后自动淡出（同一条槽被清空，不会残留上一条）。
  // 用轮询而不是固定 sleep：headless 低帧率下 dt 被截到 0.05，游戏内时间大约只有
  // 墙钟的 0.7 倍，固定等 0.9s 会卡在"刚好差一点"的边界上（实测 ttl 还剩 0.05）。
  let gone = null;
  for (let i = 0; i < 24; i++) {
    gone = val(await evaluate(`(() => {
      const g = window.__game;
      const chip = document.querySelector('#assist-chip');
      return {
        ttl: g.noticeTtl,
        op: parseFloat(chip.style.opacity || '0'),
      };
    })()`));
    if (gone && gone.ttl <= 0 && gone.op < 0.05) break;
    await sleep(150);
  }
  report(!!gone && gone.ttl <= 0 && gone.op < 0.05,
    `提示条到点自动收起（ttl=${gone?.ttl?.toFixed?.(2) ?? gone?.ttl} / opacity=${gone?.op}）`);

  // ---------- ④ 真过线：必须出评价 + 落一条幽灵存档 ----------
  const before = val(await evaluate(`(() => {
    const g = window.__game;
    const L = g.finishLine;
    const b = g.localBoat;
    const pm = g.progressMap.get(g.myId);
    pm.lap = 1;
    // 摆到线后 12m、正对线（不调 resetTo：它会清速度，而且会把 arcPrev 打回 null）
    const sx = L.x - L.dx * 12;
    const sz = L.z - L.dz * 12;
    b.pos.set(sx, b.pos.y, sz);
    b.prevPos.copy(b.pos);
    b.heading = Math.atan2(L.dx, L.dz);
    b.vel.set(L.dx * 32, L.dz * 32);
    b.speed = 32;
    // 手动把「船头压线判定」的状态对齐到当前位置，并假装这一圈已经跑够
    // （#crossedFinish 第一帧会把 arcSince 清 0，所以必须自己写 arcPrev）
    b.arcPrev = null;
    const bow = { x: sx + L.dx * 2, z: sz + L.dz * 2 };
    g.arcPrev = g.track.arcAt(bow.x, bow.z).s;
    g.bowPrev = { x: bow.x, z: bow.z };
    g.arcSince = g.track.arcTotal * 0.6;
    g.lapStart = g.raceTime - 65;
    // 清掉上一步留下的提示，确保过线出的是这一圈的圈评
    g.noticeTtl = 0; g.noticePending = null;
    // 模拟「开局时一条记录都没有」（第一次跑这张图的人就是这种状态）：
    // 清掉幽灵 + 清掉存档 + 清掉内存里的历史最好成绩，
    // 验证过线后 #saveGhost 会不会当场把它建出来。
    // 只清 ghostBoat 是不够的：ghostRecord 还在（本探针前面写过一条 60s 的合成
    // 记录），而 #finishLap 只有「比历史最快还快」才存 —— 65s 的圈会被直接跳过，
    // 幽灵自然不会重建，断言就变成假失败。
    g.ghostBoat?.dispose();
    g.ghostBoat = null;
    g.ghostVisible = false;
    g.ghostRecord = null;
    g.ghostBest0 = null;
    for (const k of Object.keys(localStorage)) if (k.startsWith('rr-ghost-v1:')) localStorage.removeItem(k);
    return { lapTimes: g.lapTimes.length, x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1) };
  })()`));
  // 每帧补一次速度（水阻会把船拖住）
  for (let i = 0; i < 8; i++) {
    await evaluate(`(() => { const g = window.__game; const b = g.localBoat; const L = g.finishLine;
      b.vel.set(L.dx * 30, L.dz * 30); b.speed = 30; return 1; })()`);
    await sleep(180);
  }
  const after = val(await evaluate(`(() => {
    const g = window.__game;
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('rr-ghost-v1:'));
    return {
      lapTimes: g.lapTimes.length,
      lap: g.progressMap.get(g.myId).lap,
      notice: g.notice ? { main: g.notice.main, sub: g.notice.sub, tone: g.notice.tone } : null,
      savedKeys: keys,
      bestLap: g.ghostRecord?.lapTime ?? null,
      ghostNow: !!g.ghostBoat,
    };
  })()`));
  report(after && after.lapTimes > before.lapTimes, `过线计圈（${before?.lapTimes} → ${after?.lapTimes} 圈）`);
  report(after && !!after.ghostNow, '第一圈跑完当场建出幽灵（本局下一圈就能看到，不用重开）');
  report(after && !!after.notice && after.notice.main.length > 0,
    `过线出圈评（${after?.notice?.main || '无'} / ${after?.notice?.sub || '无'}）`);
  report(after && after.savedKeys.length >= 1, `幽灵存档已落盘（${after?.savedKeys?.join(',') || '无'}）`);

  // ---------- ⑤ 设置页「辅助」 ----------
  await evaluate(`document.querySelector('#quality-btn')?.click(); 1`);
  await sleep(500);
  const panel = val(await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.sp-tab')].map((b) => b.textContent.trim());
    const assistTab = document.querySelector('.sp-tab[data-tab="assist"]');
    assistTab?.click();
    return new Promise((res) => setTimeout(() => {
      const pane = document.querySelector('[data-sp="pane"]');
      const labels = [...pane.querySelectorAll('.sp-label b')].map((b) => b.textContent);
      const switches = pane.querySelectorAll('.sp-sw').length;
      const btn = [...pane.querySelectorAll('.sp-key')].map((b) => b.textContent.trim());
      res({ tabs, labels, switches, btn });
    }, 260));
  })()`));
  report(panel && !panel.labels.includes('幽灵车'), '设置页已删除「幽灵车」开关（影子改成挑战模式玩法）');
  report(panel && panel.switches === 2, `辅助页只剩 2 个开关（${panel?.switches}）`);
  report(panel && panel.btn.includes('清除全部'), `清除按钮在（${panel?.btn?.join('/')}）`);

  const fp = val(await evaluate(`!!document.querySelector('#fp-ghost') && !!document.querySelector('#fp-ghost-lab')`));
  report(!!fp, '结算页多一格「幽灵最佳」（对比本局最快圈）');

  // ---------- ⑥ HUD 实拍（CDP 只截 2 张，放最后）----------
  try {
    await evaluate(`document.querySelector('[data-sp="close"]')?.click(); 1`);
    await sleep(300);
    // 设置面板是「冻结驾驶输入但不暂停」：关掉之后要等它淡出，否则截到的是半透明面板
    await sleep(400);
    await evaluate(`(() => {
      const g = window.__game;
      g.notice = { main: '过弯漂亮，快了 0.32 秒', sub: '第 2 段快了 0.21 秒', tone: 'green', priority: 1 };
      g.noticeTtl = 1.4; g.noticePending = null;
      g.lapStart = g.raceTime - 18;
      return 1;
    })()`);
    await sleep(160);
    const s1 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    await fs.mkdir('shots/ghost', { recursive: true });
    await fs.writeFile(`shots/ghost/${mapId}-hud-review.jpg`, Buffer.from(s1.data, 'base64'));
    await evaluate(`(() => {
      const g = window.__game;
      g.notice = { main: '🧱 撞墙', sub: '蹭到护栏', tone: 'red', priority: 3 };
      g.noticeTtl = 0.9; g.noticePending = null;
      return 1;
    })()`);
    await sleep(140);
    const s2 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    await fs.writeFile(`shots/ghost/${mapId}-hud-impact.jpg`, Buffer.from(s2.data, 'base64'));
    console.log('hud shots → shots/ghost/' + mapId + '-hud-review.jpg / -hud-impact.jpg');
  } catch (e) {
    console.log('hud shot skipped:', e.message);
  }
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
console.log(failed === 0 ? 'ghost lap probe: PASS' : `ghost lap probe: ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
