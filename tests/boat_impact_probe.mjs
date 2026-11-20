// 船对船冲量集成探针：在真实引擎里跑物理帧，验证
//   ① 侧撞：船被推开、横向速度真的留得住（旧版会被抓地 + 滑移角上限一帧抹平）
//   ② 正撞：明显掉速，但船头不乱转
//   ③ 并排同速：不掉速（旧版每帧一刀 vel *= retention）
// 跑法：node tests/boat_impact_probe.mjs        （需要 dev server 在 5199）
//      MAP=ocean node tests/boat_impact_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
// ⚠ 浏览器 profile 必须写在项目外：项目内的临时目录会被 vite 的文件监听拖死
const profile = `D:/3dgame-tmp/browser/boatimpact-${stamp}`;
const port = 9860 + (Number(stamp.slice(-3)) % 30);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const mapId = process.env.MAP || 'ocean';

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
// 无头环境启动偶尔很慢，把每一步打到 stderr 并立刻 flush，卡住时才知道死在哪
const step = (m) => { try { process.stderr.write(`· ${m}\n`); } catch { /* */ } };
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

/**
 * 通用实验壳：把 AI 艇冻成一面"船形墙"，把本地艇摆到指定相对位置与速度，
 * 然后用两层 requestAnimationFrame 精确等 2 个物理帧，取前后快照。
 * （无头下只有 1~3fps，靠 sleep 等不到稳定的帧数，必须用 rAF 卡帧。）
 */
const runCase = (cfg) => `new Promise((resolve) => {
  const g = window.__game, b = g.localBoat, o = g.aiBoats[0];
  if (!o) { resolve({ err: 'no ai boat' }); return; }
  // 冻结对手：不跑它自己的物理，只作为一面静止的船体（碰撞结算照样会对它施加冲量）
  if (!o.__frozen) {
    o.updateLocal = () => {};
    o.__frozen = true;
    // 记录每次冲量调用，卡住/没触发时能一眼看出是哪一步没走
    window.__imp = [];
    const orig = b.applyBoatImpact.bind(b);
    b.applyBoatImpact = (...a) => { window.__imp.push(a.slice(0, 3).map((v) => +Number(v).toFixed(2))); return orig(...a); };
  }
  window.__imp.length = 0;
  o.vel.set(0, 0); o.speed = 0;

  const H = ${cfg.heading ?? '0'};
  const hx = Math.sin(H), hz = Math.cos(H);
  const rx = Math.cos(H), rz = -Math.sin(H);   // 与引擎一致的横向轴

  b.resetTo(${cfg.bx}, ${cfg.bz}, H);
  o.heading = H + ${cfg.oh ?? 0};
  // 先把对手按名义偏移摆好，再用引擎自己的碰撞几何量出"刚好贴住"的距离，
  // 保证每次都是实打实重叠 0.45m —— 船型（窄船/长船）换了也不用改这个探针。
  const nOf = ${cfg.of}, nOr = ${cfg.or};
  o.pos.set(b.pos.x + hx * nOf + rx * nOr, 0, b.pos.z + hz * nOf + rz * nOr);
  let dbg = null;
  if (window.__bc && (nOf || nOr)) {
    const { boatContactNormal, boatCollisionRadius } = window.__bc;
    const c0 = boatContactNormal(b.def, b.heading, b.pos.x, b.pos.z, o.def, o.heading, o.pos.x, o.pos.z);
    const minD = boatCollisionRadius(b.def, b.heading, c0.nx, c0.nz)
      + boatCollisionRadius(o.def, o.heading, c0.nx, c0.nz);
    const len = Math.hypot(nOf, nOr) || 1;
    const want = minD - 0.45;
    // 注意：nOf/nOr 是「本船前向/横向」的局部偏移，要换回世界坐标
    const ux = (hx * nOf + rx * nOr) / len;
    const uz = (hz * nOf + rz * nOr) / len;
    o.pos.set(b.pos.x + ux * want, 0, b.pos.z + uz * want);
    dbg = { minD: +minD.toFixed(2), placed: +want.toFixed(2), n: [+c0.nx.toFixed(2), +c0.nz.toFixed(2)] };
  }
  o.prevPos.copy(o.pos);
  b.vel.set(hx * ${cfg.vf} + rx * ${cfg.vr}, hz * ${cfg.vf} + rz * ${cfg.vr});
  b.speed = Math.hypot(b.vel.x, b.vel.y);
  b.impactGripTimer = 0;

  const snap = () => {
    const spd = Math.hypot(b.vel.x, b.vel.y);
    return {
      spd: +spd.toFixed(2),
      // 前向 / 横向分量，符号约定与 Boat 内一致（横向：右为正）
      vf: +((b.vel.x * Math.sin(b.heading) + b.vel.y * Math.cos(b.heading))).toFixed(2),
      vl: +((b.vel.x * Math.cos(b.heading) - b.vel.y * Math.sin(b.heading))).toFixed(2),
      hdg: +(b.heading * 180 / Math.PI).toFixed(2),
      x: +b.pos.x.toFixed(3), z: +b.pos.z.toFixed(3),
      // 与对手的平面距离
      d: +Math.hypot(b.pos.x - o.pos.x, b.pos.z - o.pos.z).toFixed(3),
    };
  };
  const s0 = snap();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const s1 = snap();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve(JSON.stringify({ s0, s1, s2: snap(), imp: window.__imp.slice(0, 4), dbg }));
    }));
  }));
})`;

try {
  let info;
  for (let i = 0; i < 150; i++) {
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
  // 预热：把碰撞模块挂到 window，探针里要用它量真实贴合距离
  const warm = () => evaluate("import('/src/game/boatContact.js').then((m) => { window.__bc = m; return 1; })")
    .then((r) => val(r));
  step('navigate'); await cdp('Page.navigate', { url });
  await sleep(2000);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000); step('lobby ready');
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000); step('lobby open');
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`); step('map drawer');
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`, 45000); step('map card');
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  // 默认是「无 AI」，得先选一个 AI 艇当碰撞对手（选择后 UI 会重渲染，等一下再确认）
  await sleep(400);
  await evaluate(`(() => {
    const s = document.querySelector('#sel-ai');
    if (!s) return 'no-select';
    s.value = '1';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value;
  })()`);
  await sleep(500);
  console.log('AI', val(await evaluate(`document.querySelector('#sel-ai')?.value ?? 'gone'`)));
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  step('race started'); await waitFor(`!!window.__game?.localBoat`, 120000); step('localBoat ok');
  try {
    await waitFor(`window.__game?.phase === 'racing'`, 90000);
  } catch (e) {
    console.error('DBG', JSON.stringify(val(await evaluate(`(() => {
      const g = window.__game;
      return {
        phase: g?.phase, mode: g?.mode, cd: g?.countdownLeft,
        boats: g ? [...g.boats.keys()].slice(0, 4) : null,
        lobby: document.querySelector('#lobby')?.className,
        dlg: [...document.querySelectorAll('.dialog,[id^=dlg-]')]
          .filter((d) => !d.classList.contains('hidden')).map((d) => d.id).slice(0, 6),
        btnStart: !!document.querySelector('#btn-start-race'),
      };
    })()`))));
    throw e;
  }

  // 去掉一切会干扰位置的约束；输入换成常量代理（main.js 每帧回写键盘值）
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.track.constrain = () => {}; g.track.applyMechs = () => {};
    g.track.shoreColliders.length = 0;
    g.mapDef.boundary = null;
    g.countdownLeft = 0;
    g.opts.input = {
      get throttle() { return 0; }, get steer() { return 0; },
      get drift() { return false; }, get nitro() { return false; },
    };
    return 1;
  })()`);
  await sleep(300);
  // 预载碰撞模块（量距用）；dev server 下直接 import 源码，和引擎跑的是同一份
  console.log('WARM', val(await warm()));
  await sleep(100);

  // CASE1 侧撞：并排贴近但整体几乎静止（vf=0），横向以 8 m/s 撞过去。
  // 旧版在这里会被 slipCap（=0）一帧抹平 —— 这就是"撞了却推不动"。
  const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
  const side = parse(val(await evaluate(runCase({
    heading: 0, bx: 0, bz: 0, of: 0, or: 2.4, oh: 0, vf: 20, vr: 6,
  }))));
  console.log('CASE1 侧撞', JSON.stringify(side));

  // CASE2 正撞：正前方 4.4m 一艘迎头船，28 m/s 撞上去
  const head = parse(val(await evaluate(runCase({
    heading: 0, bx: 0, bz: 0, of: 4.4, or: 0, oh: Math.PI, vf: 28, vr: 0,
  }))));
  console.log('CASE2 正撞', JSON.stringify(head));

  // CASE3 并排同速：贴在一起但没有任何接近速度 → 一分速度都不该掉
  const glide = parse(val(await evaluate(runCase({
    heading: 0, bx: 0, bz: 0, of: 0, or: 2.4, oh: 0, vf: 22, vr: 0,
  }))));
  console.log('CASE3 并排', JSON.stringify(glide));

  const fail = [];
  if (!side?.s1) fail.push('CASE1 没拿到快照');
  else {
    // ① 横向必须被推开：合速度的横向分量要明显下降（两船按质量分摊冲量，
    //    本船一般不会直接反向，但"接近速度"必须被消掉并转为分离）
    const dvl = side.s1.vl - side.s0.vl;
    if (dvl > -2) fail.push(`CASE1 没有被横向推开（Δvl=${dvl.toFixed(2)}）`);
    // ② 侧撞不该改变前向速度 —— 这正是"被刻意推向别的方向"的核心指标。
    //    旧版按中心连线推，法线带前后分量，这里会掉/涨 2~4 m/s。
    const dvf = Math.abs(side.s1.vf - side.s0.vf);
    if (dvf > 2) fail.push(`CASE1 前向速度被莫名改变（Δvf=${dvf.toFixed(2)}）`);
    // ③ 侧撞不该大幅掉速（只该有擦碰摩擦那一点）
    if (side.s1.spd < side.s0.spd * 0.85) fail.push(`CASE1 侧撞掉速过多（${side.s0.spd} → ${side.s1.spd}）`);
    // ④ 位置被推开
    if (side.s2.d <= side.s0.d) fail.push('CASE1 位置没有被推开');
  }
  if (!head?.s1) fail.push('CASE2 没拿到快照');
  else {
    if (head.s1.spd > head.s0.spd * 0.62) fail.push(`CASE2 正撞没掉速（${head.s0.spd} → ${head.s1.spd}）`);
    if (!head.imp?.length) fail.push('CASE2 引擎没有调用冲量接口');
    // 正撞不该把船头拧掉：容忍几度（两船未必严格同轴）
    if (Math.abs(head.s1.hdg - head.s0.hdg) > 6) fail.push(`CASE2 正撞船头偏转过大（Δ=${(head.s1.hdg - head.s0.hdg).toFixed(2)}°）`);
  }
  if (!glide?.s1) fail.push('CASE3 没拿到快照');
  else {
    if (glide.s1.spd < glide.s0.spd * 0.9) fail.push(`CASE3 并排同速却掉速（${glide.s0.spd} → ${glide.s1.spd}）`);
  }


  if (fail.length) {
    console.log('FAIL');
    for (const f of fail) console.log('  ·', f);
  } else {
    console.log('PASS 侧撞推得动 / 正撞才掉速 / 并排不掉速');
  }
} catch (e) {
  console.error('FAIL', e.message);
}
child.kill();
process.exit(0);
