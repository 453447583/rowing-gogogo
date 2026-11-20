// R 键复位是否保住氮气条 / 氮气瓶（回归探针）
//
// 玩家反馈：攒了半条气和一瓶氮气，按 R 脱困之后右上角瓶子清空、气条归零。
// 现在的规则：
//   R 键 / 掉水 / 掉断层（Game.respawnLocal + 两处掉出赛道兜底）→ keepNitro，保留；
//   发车摆位 Boat.resetTo(...) 不传 opts → 仍然清空（新一局从零开始）。
//
//   node tests/nitro_reset_probe.mjs
//   MAP=strait node tests/nitro_reset_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/nitro-${stamp}`);   // 故意不删：safe-delete 钩子会超时
const port = 9640 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const mapId = process.env.MAP || 'ocean';

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
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
  await sleep(1200);

  const t0 = Date.now();
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
    const c = cards.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  // 等进 racing（开场镜头 + 倒计时之后）。无头软渲染只有 1~3fps，dt 又被截到 0.05s，
  // 游戏时间比真实时间慢 3~10 倍，所以这里给足 120s；实在等不到就直接把阶段推过去
  // （本探针只验"复位是否没收氮气"，倒计时本身由别的探针覆盖）。
  const t1 = Date.now();
  let racing = false;
  while (Date.now() - t1 < 120000) {
    const r = await evaluate(`(() => {
      const g = window.__game;
      return g ? (g.phase || 'none') : 'loading';
    })()`);
    if (r.result?.value === 'racing') { racing = true; break; }
    await sleep(400);
  }
  if (!racing) {
    console.log('（倒计时没跑完，直接把 phase 推到 racing）');
    await evaluate(`(() => {
      const g = window.__game;
      if (g) { g.raceIntro = null; g.countdownLeft = 0; g.phase = 'racing'; }
      return 1; })()`);
    await sleep(400);
  }
  const ph = await evaluate('window.__game?.phase');
  check('已进入 racing 阶段', ph.result?.value === 'racing', String(ph.result?.value));
  // 单人模式没人动会超时 dispose，先摘掉回调
  await evaluate('(() => { const g = window.__game; if (g.opts) { g.opts.onFinish = () => {}; g.opts.onQuit = () => {}; } return 1; })()');

  // 预置：半条气 + 1 瓶
  const pre = await evaluate(`(() => {
    const b = window.__game.localBoat;
    b.nitroCharge = 0.62; b.nitroBottles = 1;
    return { c: b.nitroCharge, n: b.nitroBottles, x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1) };
  })()`);
  console.log('预置:', JSON.stringify(pre.result?.value));

  // 按 R（走真实键盘路径）。顺手给 respawnLocal 挂个计数器当正样本：
  // 如果按键根本没被接住，氮气也会"看起来没丢"，那样的 PASS 是假的。
  await evaluate(`(() => {
    const g = window.__game;
    if (!g.__respawnWrapped) {
      const orig = g.respawnLocal.bind(g);
      g.__respawnHits = 0;
      g.respawnLocal = (...a) => { g.__respawnHits++; return orig(...a); };
      g.__respawnWrapped = 1;
    }
    return 1; })()`);
  const key = await evaluate(`(() => {
    const ev = { code: 'KeyR', key: 'r', keyCode: 82, bubbles: true };
    window.dispatchEvent(new KeyboardEvent('keydown', ev));
    document.dispatchEvent(new KeyboardEvent('keydown', ev));
    return 1;
  })()`);
  await sleep(1500);

  const after = await evaluate(`(() => {
    const g = window.__game, b = g.localBoat;
    return { c: +b.nitroCharge.toFixed(2), n: b.nitroBottles,
      x: +b.pos.x.toFixed(1), z: +b.pos.z.toFixed(1), phase: g.phase, hits: g.__respawnHits };
  })()`);
  const a = after.result?.value || {};
  console.log('按 R 之后:', JSON.stringify(a));
  check('R 键确实触发了 respawnLocal（正样本）', (a.hits || 0) > 0, `hits=${a.hits}`);
  check('R 键后氮气条集气保留', a.c === 0.62, `charge=${a.c}`);
  check('R 键后氮气瓶保留', a.n === 1, `bottles=${a.n}`);

  // 掉水兜底同样保留（直接调 resetTo 的 keepNitro 分支已覆盖 R 路径，这里验"新一局仍清空"）
  const fresh = await evaluate(`(() => {
    const b = window.__game.localBoat;
    b.resetTo(b.pos.x, b.pos.z, b.heading);
    return { c: b.nitroCharge, n: b.nitroBottles };
  })()`);
  const f = fresh.result?.value || {};
  console.log('发车摆位 resetTo() 无 opts:', JSON.stringify(f));
  check('发车摆位仍然清空氮气（新一局从零开始）', f.c === 0 && f.n === 0, `charge=${f.c} bottles=${f.n}`);
  check('R 键没有把船扔到离谱的位置', Number.isFinite(a.x) && Number.isFinite(a.z));
}

main().catch((e) => { console.error('FAIL', e.message); bad++; }).finally(async () => {
  console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
});
