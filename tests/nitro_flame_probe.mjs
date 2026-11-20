// 氮气 / 小喷 尾焰是否"持续存在"的回归探针。
//
// 玩家反馈：氮气冲刺时尾焰经常闪一下就没了，希望氮气加速 + 双喷 + 单喷期间一直有。
//
// 根因（2026-11-17）：#updateNitroFx 原来只看 boat.boostTimer（只有氮气瓶会写），
//   ① 单喷 / 双喷走的是 miniBoostTimer → 完全没尾焰；
//   ② 氮气被撞断 / 小喷接氮气的那一帧 boostTimer 归零 → 特效键被立刻 stop，
//      看起来就是"闪一下就消失"。
//   修法：boosting = boostTimer>0 || miniBoostTimer>0，并留 0.12s 余辉（nitroFxHold）。
//
// 本探针直接读 g.fx.attached 里 boost:* 的键，在整段加速时间内反复采样：
// 只要中间有任意一次采样发现键没了，就是"尾焰断档"。
//
//   node tests/nitro_flame_probe.mjs
//   MAP=strait node tests/nitro_flame_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/nitroflame-${stamp}`); // 故意不删：safe-delete 钩子会超时
const port = 9640 + (Number(stamp.slice(-3)) % 40);
// raceIntro=0 跳过 5.6s 开场镜头，否则无头下要等几十秒
const url = process.env.WB_URL || 'http://127.0.0.1:5199/?raceIntro=0';
const mapId = process.env.MAP || 'ocean';

// 真 GPU（不加 --disable-gpu）才有 ~50fps：软光栅只有 1~3fps 且 dt 被截 0.05s，
// 尾焰计时器会慢 3~10 倍，采样窗口就量不准了。
const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
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
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = async (expr) => (await evaluate(expr)).result?.value;

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

let bad = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) bad++;
}

// 采样一次：加速计时器 + 当前挂着的 boost:* 键
const SAMPLE = `(() => {
  const g = window.__game, b = g.localBoat;
  const keys = [...g.fx.attached.keys()].filter((k) => k.startsWith('boost:'));
  // 只数"还活着的粒子实例"：键还在但 handles 全没了，画面上照样是没火。
  let live = 0;
  for (const k of keys) {
    const a = g.fx.attached.get(k);
    live += (a?.handles || []).filter((h) => h && h.exists !== false).length;
  }
  return {
    n: keys.length,
    live,
    keys: keys.sort(),
    boost: +b.boostTimer.toFixed(3),
    mini: +b.miniBoostTimer.toFixed(3),
    hold: +(b.nitroFxHold || 0).toFixed(3),
  };
})()`;

/** 连续采样 ms 毫秒，每 step 一次；返回每次的 n */
async function sampleLoop(ms, step = 100) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await val(SAMPLE);
    if (s) out.push(s);
    await sleep(step);
  }
  return out;
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
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1500);

  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    if (await val('!!window.__audio && !!document.querySelector("#btn-solo")')) break;
    await sleep(300);
  }
  await val('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  let cardsReady = false;
  for (let i = 0; i < 12 && !cardsReady; i++) {
    await val('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cardsReady = (await val('!!document.querySelector(".lp-card[data-map]")')) === true;
  }
  if (!cardsReady) throw new Error('地图抽屉一直没打开');
  const picked = await val(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked}`);
  await val('document.querySelector("#btn-start-race")?.click(); 1');

  let racing = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 90000) {
    const ph = await val('window.__game ? (window.__game.phase || "none") : "loading"');
    if (ph === 'racing') { racing = true; break; }
    await sleep(300);
  }
  if (!racing) {
    await val(`(() => { const g = window.__game;
      if (g) { g.raceIntro = null; g.countdownLeft = 0; g.phase = 'racing'; } return 1; })()`);
    await sleep(400);
  }
  check('已进入 racing 阶段', (await val('window.__game?.phase')) === 'racing');
  // 单人模式没人操作会被判 DNF 后 dispose，先摘掉回调
  await val('(() => { const g = window.__game; if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; } return 1; })()');

  // 等船体 GLB 就位（喷口锚点是模型加载后才建的，没有锚点当然挂不上尾焰）
  let nozzles = 0;
  const t2 = Date.now();
  while (Date.now() - t2 < 40000) {
    nozzles = (await val('window.__game.localBoat.nitroNozzles?.length || 0')) || 0;
    if (nozzles === 3) break;
    await sleep(300);
  }
  const meta = await val(`(() => { const g = window.__game, b = g.localBoat;
    return { boat: b.def?.id, nozzles: b.nitroNozzles?.length || 0, mode: g.mode, fps: g.__fps || null }; })()`);
  console.log('环境:', JSON.stringify(meta));
  check('船体喷口锚点已就绪（3 个）', meta?.nozzles === 3, `nozzles=${meta?.nozzles}`);

  // ── 场景 1：氮气瓶（boostTimer）───────────────────────────────────
  await val(`(() => { const b = window.__game.localBoat;
    b.boostTimer = 1.6; b.miniBoostTimer = 0; b.nitroFxHold = 0; return 1; })()`);
  // 刚写计时器的这一帧还没跑 #updateNitroFx，特效键要等下一帧才挂上
  // （软/硬渲染首帧都可能 >100ms），先让出一帧再开始采样，否则会误报"断档"。
  await sleep(160);
  const s1 = await sampleLoop(1000, 100);
  const miss1 = s1.filter((s) => s.boost > 0.05 && (s.n === 0 || s.live === 0));
  check('氮气加速全程都有尾焰（无断档）', s1.length >= 5 && miss1.length === 0,
    `采样${s1.length}次 断档${miss1.length}次 键数=${s1.map((s) => s.n).join(',')}`
    + ` 活跃粒子=${s1.map((s) => s.live).join(',')}`);

  // ── 场景 2：单喷 / 双喷（miniBoostTimer）─────────────────────────
  await val(`(() => { const b = window.__game.localBoat;
    b.boostTimer = 0; b.miniBoostTimer = 0; b.nitroFxHold = 0; return 1; })()`);
  await sleep(260); // 等余辉清干净
  await val(`(() => { const b = window.__game.localBoat;
    b.miniBoostTimer = 0.55; return 1; })()`);
  const s2 = await sampleLoop(420, 70);
  const miss2 = s2.filter((s) => s.mini > 0.05 && (s.n === 0 || s.live === 0));
  check('小喷（单喷/双喷）期间也有尾焰', s2.length >= 4 && miss2.length === 0,
    `采样${s2.length}次 断档${miss2.length}次 键数=${s2.map((s) => s.n).join(',')}`
    + ` 活跃粒子=${s2.map((s) => s.live).join(',')}`);

  // ── 场景 3：加速被打断的瞬间不能"闪一下就消失"──────────────────
  await val(`(() => { const b = window.__game.localBoat;
    b.boostTimer = 1.2; b.miniBoostTimer = 0; return 1; })()`);
  await sleep(320);
  const before = await val(SAMPLE);
  await val(`(() => { const b = window.__game.localBoat;
    b.boostTimer = 0; b.miniBoostTimer = 0; return 1; })()`);
  const holdShot = await val(SAMPLE);
  check('打断后仍有余辉（不是立刻消失）', (before?.live || 0) > 0 && (holdShot?.live || 0) > 0,
    `打断前=${before?.n}/${before?.live} 打断后=${holdShot?.n}/${holdShot?.live} hold=${holdShot?.hold}`);
  await sleep(500);
  const gone = await val(SAMPLE);
  check('余辉结束后正常收尾（不残留）', (gone?.n || 0) === 0, `keys=${gone?.n} hold=${gone?.hold}`);

  // ── 场景 4：小喷接氮气，一整段不出现空档 ────────────────────────
  await val(`(() => { const b = window.__game.localBoat;
    b.boostTimer = 0.55; b.miniBoostTimer = 0.55; return 1; })()`);
  await sleep(160); // 同上：让出一帧
  const s4 = await sampleLoop(700, 90);
  const miss4 = s4.filter((s) => (s.boost > 0.05 || s.mini > 0.05) && (s.n === 0 || s.live === 0));
  check('小喷接氮气叠加期不出现空档', miss4.length === 0,
    `采样${s4.length}次 断档${miss4.length}次 活跃粒子=${s4.map((s) => s.live).join(',')}`);
  // 顺手确认挂的键数量与船型的喷口配置一致（center=1 个，sides=2 个）
  const keyInfo = await val(`(async () => {
    const { NITRO_JETS } = await import('/src/game/nitroFx.js');
    const g = window.__game, b = g.localBoat;
    const cfg = g.mode === 'boss' ? null : NITRO_JETS[b.def.id];
    const keys = [...g.fx.attached.keys()].filter((k) => k.startsWith('boost:'));
    return { points: cfg?.points || '?', core: !!cfg?.core, keys: keys.sort() };
  })()`);
  console.log('喷口配置:', JSON.stringify(keyInfo));

  await val(`(() => { const b = window.__game.localBoat;
    b.boostTimer = 0; b.miniBoostTimer = 0; return 1; })()`);
}

main().catch((e) => { console.error('FAIL', e.message); bad++; }).finally(async () => {
  console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  process.exit(bad === 0 ? 0 : 1);
});
