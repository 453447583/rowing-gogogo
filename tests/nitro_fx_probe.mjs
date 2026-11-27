// 氮气尾焰对比探针：为什么绯鲨号 / 流光号的加速尾焰"看着时断时续"
//
//   node tests/nitro_fx_probe.mjs                # 依次跑 rower / skiff / dolphin
//   BOATS=skiff node tests/nitro_fx_probe.mjs    # 只跑一条
//
// 采三组硬数据，避免靠肉眼猜：
//   ① 粒子句柄数（fx.attached 里 boost:<id>:<i> 的 handles.length）——
//      若加速期间周期性地掉到 0，就是**代码断续**（补发 / 池子的问题）；
//   ② 存活句柄数（handle.exists !== false）—— 素材播完就消失的话这里会长期偏低；
//   ③ 尾焰区域像素亮度增量 —— 关掉氮气拍一帧、开氮气再拍一帧，逐像素相减，
//      统计"变亮"的像素占比与平均增量，用来判断是不是**单纯太淡**。
// 像素只在浏览器里算（只回传统计值），否则 1280×760×4 的数组序列化会拖死 CDP。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import { ensureTestAccount, seedExpr } from './_account.mjs';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/nitro-${stamp}`;
const port = 9760 + (Number(stamp.slice(-3)) % 20);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const url = `${base}?raceIntro=0`;
const mapId = process.env.MAP || 'strait';
// SPEED：实战速度。高速下 trail 粒子会被拉开，间隔大于火球直径就会看成断续，
// 所以用 30 复测才能验证「跑起来到底连不连续」。
const speed = Number(process.env.SPEED || 8);
const boats = (process.env.BOATS || 'rower,skiff,dolphin').split(',').map((s) => s.trim()).filter(Boolean);

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

async function waitFor(expr, timeout = 120000, label = expr) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + label + ' last=' + JSON.stringify(last));
}

let failed = 0;
const report = (ok, msg) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

/** 进大厅 → 选船 → 选图 → 0 AI → 开赛 → 等到 racing */
async function startRace(boatId) {
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`);
  await evaluate(`document.querySelector('#btn-lobby-boat')?.click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-boat="${boatId}"]')`);
  await evaluate(`document.querySelector('.lp-card[data-boat="${boatId}"]').click(); 1`);
  await sleep(250);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${mapId}"]')`);
  await evaluate(`document.querySelector('.lp-card[data-map="${mapId}"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 150000);
  await waitFor(`window.__game?.phase === 'racing'`, 240000);
  await evaluate(`(() => { const g = window.__game; g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; return 1; })()`);
  await sleep(400);
}

/** 相机固定在船尾侧后方；用 interval 每帧把船推成匀速前进（尾焰才会拖出尾迹） */
const HELPERS = `
window.__nitroCam = () => {
  const g = window.__game, b = g.localBoat;
  const h = b.heading;
  const fx = Math.sin(h), fz = Math.cos(h);
  g.cameraRig.follow = () => {};
  g.camera.position.set(b.pos.x - fx * 9 + fz * 3.2, b.pos.y + 3.4, b.pos.z - fz * 9 - fx * 3.2);
  g.camera.lookAt(b.pos.x, b.pos.y + 0.9, b.pos.z);
  g.camera.updateMatrixWorld(true);
};
window.__nitroDrive = (on, speed = 8) => {
  if (window.__nitroTimer) { clearInterval(window.__nitroTimer); window.__nitroTimer = null; }
  if (!on) return 1;
  const g = window.__game;
  window.__nitroTimer = setInterval(() => {
    const b = g.localBoat;
    if (!b) return;
    b.boostTimer = 30; b.miniBoostTimer = 0;
    const h = b.heading;
    b.vel.set(Math.sin(h) * speed, 0, Math.cos(h) * speed);
    b.speed = speed;
    window.__nitroCam();
  }, 16);
  return 1;
};
window.__nitroSeries = () => {
  const a = window.__game.fx.attached;
  const keys = [...a.keys()].filter((x) => x.startsWith('boost:'));
  const per = keys.map((key) => {
    const it = a.get(key);
    const hs = it?.handles || [];
    return { n: hs.length, alive: hs.filter((h) => h && h.exists !== false).length, pool: it?.pool };
  });
  return {
    nozzles: per.length,
    n: per.reduce((x, y) => x + y.n, 0),
    alive: per.reduce((x, y) => x + y.alive, 0),
    per,
  };
};
window.__nitroGrab = (tag) => {
  const g = window.__game, b = g.localBoat;
  if (tag === 'off') { b.boostTimer = 0; b.miniBoostTimer = 0; }
  window.__nitroCam();
  // ⚠ 必须走真实渲染管线：中/高画质时 Effekseer 是在 PostFx 的 FxPass 里画的，
  // 直接 renderer.render 只会得到"没有尾焰"的画面（像素对比会全是水面噪声）。
  g.fx.update(0.016);
  g.post.render(0.016);
  if (!g.post.isActive) g.fx.draw(g.camera);
  const gl = g.renderer.getContext();
  const w = g.renderer.domElement.width, h = g.renderer.domElement.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  window.__nitroBuf = window.__nitroBuf || {};
  window.__nitroBuf[tag] = buf;
  let sum = 0;
  for (let i = 0; i < buf.length; i += 4) sum += 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2];
  return { w, h, mean: +(sum / (buf.length / 4)).toFixed(2) };
};
window.__nitroDiff = () => {
  const A = window.__nitroBuf?.off, B = window.__nitroBuf?.on;
  if (!A || !B) return null;
  const n = Math.min(A.length, B.length);
  let brighter = 0, sum = 0, max = 0;
  for (let i = 0; i < n; i += 4) {
    const la = 0.299 * A[i] + 0.587 * A[i + 1] + 0.114 * A[i + 2];
    const lb = 0.299 * B[i] + 0.587 * B[i + 1] + 0.114 * B[i + 2];
    const d = lb - la;
    if (d > 18) { brighter += 1; sum += d; if (d > max) max = d; }
  }
  return {
    brighterPct: +(100 * brighter / (n / 4)).toFixed(2),
    avgDelta: brighter ? +(sum / brighter).toFixed(1) : 0,
    maxDelta: +max.toFixed(0),
  };
};
1`;

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
  // 强制账号门：没 token 点 #btn-solo 只会弹登录页，大厅永远打不开
  const token = await ensureTestAccount(base, 'nitro探针', 'sail123456');
  if (!token) throw new Error('测试账号 token 获取失败');
  await evaluate(seedExpr({ name: 'nitro探针', token }));
  await cdp('Page.reload');
  await sleep(2200);
  try { await cdp('Page.bringToFront'); } catch { /* */ }

  const results = [];
  for (let k = 0; k < boats.length; k++) {
    const boatId = boats[k];
    if (k === 0) {
      await startRace(boatId);
    } else {
      await evaluate(`(() => { try { window.__game?.dispose(); } catch {} window.__game = null; location.reload(); return 1; })()`);
      await sleep(2600);
      try { await cdp('Page.bringToFront'); } catch { /* */ }
      await startRace(boatId);
    }
    await evaluate(HELPERS);
    await evaluate(`window.__nitroCam(); window.__nitroDrive(true, ${speed}); 1`);
    await sleep(900); // 让尾迹先铺开

    console.log(`\n=== ${boatId} ===`);
    const series = [];
    for (let i = 0; i < 26; i++) {
      const s = val(await evaluate(`window.__nitroSeries()`));
      if (s && typeof s === 'object') series.push(s);
      await sleep(100);
    }
    const alive = series.map((s) => s.alive);
    const minAlive = Math.min(...alive);
    const zeros = alive.filter((h) => h === 0).length;
    const avgAlive = +(alive.reduce((a, b) => a + b, 0) / (alive.length || 1)).toFixed(1);
    const nozzleCount = series[0]?.nozzles ?? 0;
    const pool = series[0]?.per?.[0]?.pool ?? '?';
    console.log('存活句柄序列 =', alive.join(','));
    console.log(`喷口 ${nozzleCount} 个 · 单口池 ${pool} · 平均存活 ${avgAlive} · 最少 ${minAlive} · 归零次数 ${zeros}`);

    // 像素对比：先关氮气（等粒子散完）拍，再开氮气 0.7s 拍
    await evaluate(`window.__nitroDrive(false); window.__game.localBoat.boostTimer = 0; 1`);
    await sleep(800);
    const off = val(await evaluate(`window.__nitroGrab('off')`));
    await evaluate(`window.__nitroDrive(true, ${speed}); 1`);
    await sleep(700);
    const on = val(await evaluate(`window.__nitroGrab('on')`));
    const diff = val(await evaluate(`window.__nitroDiff()`));
    // 帧率采样：尾焰实例数从 18 涨到 42，必须确认没有把帧率拖垮
    const fps = val(await evaluate(`new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const tick = () => {
        n += 1;
        if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
        else res(Math.round(n / ((performance.now() - t0) / 1000)));
      };
      requestAnimationFrame(tick);
    })`));
    console.log('亮度 off/on =', off?.mean, '/', on?.mean, ' 增量 =', JSON.stringify(diff), ' fps =', fps);

    if (diff) results.push({ boatId, ...diff, avgAlive, minAlive, zeros, nozzles: nozzleCount });

    try {
      const jpg = val(await evaluate(`(() => {
        const g = window.__game, b = g.localBoat;
        b.boostTimer = 30; window.__nitroCam();
        // 同上：走 PostFx 合成器，否则拍不到 Effekseer 尾焰
        g.fx.update(0.016);
        g.post.render(0.016);
        if (!g.post.isActive) g.fx.draw(g.camera);
        return g.renderer.domElement.toDataURL('image/jpeg', 0.88);
      })()`));
      if (typeof jpg === 'string' && jpg.startsWith('data:image')) {
        await fs.mkdir('shots/nitro', { recursive: true });
        await fs.writeFile(`shots/nitro/${boatId}.jpg`, Buffer.from(jpg.split(',')[1], 'base64'));
        console.log('shot → shots/nitro/' + boatId + '.jpg');
      }
    } catch (e) { console.log('shot skipped:', e.message); }
    await evaluate(`window.__nitroDrive(false); 1`);
  }

  console.log('\n=== 汇总 ===');
  for (const r of results) {
    console.log(`${r.boatId.padEnd(8)} 亮像素 ${String(r.brighterPct).padStart(5)}%  平均增量 ${String(r.avgDelta).padStart(5)}  峰值 ${String(r.maxDelta).padStart(4)}  平均存活 ${String(r.avgAlive).padStart(5)}  归零 ${r.zeros}`);
  }
  const broken = results.filter((r) => r.zeros > 0);
  report(broken.length === 0, broken.length
    ? `代码断续：${broken.map((r) => r.boatId).join('、')} 在加速期间粒子归零`
    : '代码没有断续：整个加速期粒子句柄始终 > 0（问题在素材强度 / 密度）');
} catch (e) {
  console.log('ERR', e.stack || e.message);
  failed += 1;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
console.log(failed === 0 ? 'nitro fx probe: PASS' : `nitro fx probe: ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
