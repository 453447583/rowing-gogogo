// 区域道具视觉验收（特效替换后的观感 + 几何彻底移除）
//   node tests/item_zone_visual.mjs
//
// 背景：用户反馈「圣域/剑刃风暴/护盾墙外面罩着一个又大又丑的 Three.js 光圈」，
// 要求全部换成 Effekseer。改版后：
//   圣光沙暴 = 只留沙暴柱
//   圣域     = 地面符文阵 + 中心金色圣光
//   剑刃风暴 = 剑刃风暴本体 + 6 道刀光绕圈
//   护盾墙   = 4 段能量壁沿墙向拼成一排
//
// 断言：
//   ① 四类区域都不再生成任何 Three.js 几何（zone.group === null）
//   ② 每类都挂上了 Effekseer 实例（fxKeys 非空、且 fx.attached 里真的有这些键）
//   ③ 四个特效名在运行时都加载成功（不是 404 变 null）
//   ④ 四张截图落盘，供人眼确认观感
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/zone-visual-' + Date.now());
const port = 9382;
const httpPort = 5193;
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch { /* 等 */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来'); }
}
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=760,460',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
const errors = [];
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    await wait(200);
  }
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
      const msg = (m.params.exceptionDetails.exception?.description || '').split('\n')[0];
      if (!msg.includes('texImage2D')) errors.push(msg);
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
      awaitPromise: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 30000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  // ---------- 单人道具赛开局 ----------
  await sleep(1200);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 25000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 25000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="item"]')`, 20000, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="item"]').click()`);
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev(`(function(){
    const sel = document.querySelector("#sel-ai");
    if (sel) { sel.value = "1"; if (sel.onchange) sel.onchange(); }
    return 1;
  })()`);
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.items', 60000, 'game boot');
  console.log('  已进入道具赛（单人 + 1 AI）');

  // 特效需要 fxres.json + efk 二进制都就绪才真的能播：
  // 只查 fx.effects[name] 存在是不够的（早期版本就栽在这 —— 表项在、play 返回 null，
  // 区域挂上去却什么也不显示）。这里逐个试播一次再停掉，确认真的可播放。
  const needFx = ['fxHolySandstorm', 'fxBenediction', 'fxSword1', 'fxSwordStorm', 'shield'];
  const fxReady = await waitFor(`(function(){
    const fx = window.__game.fx;
    const names = ${JSON.stringify(needFx)};
    if (!names.every((n) => !!fx?.effects?.[n])) return false;
    for (const n of names) {
      const h = fx.ctx.play(fx.effects[n], 0, 0, 0);
      if (!h) return false;
      h.stop();
    }
    return true;
  })()`, 90000, '特效可播放').catch(() => false);
  ok(!!fxReady, '五个特效资源真的可播放（不只表项存在）');

  // 画布压小：无头软光栅下 700px 宽的加色粒子会很慢
  await ev('(function(){ window.__game.renderer.setSize(560, 340); return 1; })()');

  const kinds = [
    ['holystorm', '圣光沙暴（只留沙暴柱）'],
    ['sanctuary', '圣域（符文阵 + 中心圣光）'],
    ['bladestorm', '剑刃风暴（本体 + 6 道刀光绕圈）'],
    ['barrier', '护盾墙（4 段能量壁拼一排）'],
  ];

  for (const [kind, label] of kinds) {
    console.log('\n[' + kind + '] ' + label);
    // 清掉上一片，避免叠加
    await ev(`(function(){
      const it = window.__game.items;
      for (const z of it.zones) { (z.fxKeys || []).forEach((k) => it.fx.stopAttached(k)); z.life = 0; }
      return 1;
    })()`);
    await sleep(300);
    await ev(`(function(){ window.__game.items.useItem(window.__game.myId, ${JSON.stringify(kind)}, 0); return 1; })()`);
    const z = await waitFor(`(function(){
      const it = window.__game.items;
      const z = it.zones.find((x) => x.kind === ${JSON.stringify(kind)});
      if (!z) return null;
      return JSON.stringify({ x: +z.x.toFixed(1), z: +z.z.toFixed(1), r: z.r, group: z.group, fxN: (z.fxKeys || []).length,
        attached: (z.fxKeys || []).filter((k) => it.fx.attached.has(k)).length });
    })()`, 15000, kind + ' 区域生成');
    const info = JSON.parse(z);
    ok(info.group == null, `${kind}：不再有任何 Three.js 几何（group=null）`, info);
    ok(info.fxN > 0 && info.attached === info.fxN, `${kind}：Effekseer 实例全部挂上（${info.attached}/${info.fxN}）`, info);

    // 等粒子起来再截图（Effekseer 前 0.3s 是蓄势）
    await sleep(1400);
    const zz = JSON.parse(await ev(`(function(){
      const it = window.__game.items;
      const z = it.zones.find((x) => x.kind === ${JSON.stringify(kind)});
      return JSON.stringify({ x: z ? +z.x.toFixed(1) : 0, z: z ? +z.z.toFixed(1) : 0, r: z ? z.r : 8 });
    })()`));
    const shot = await ev(`(function(){
      const g = window.__game;
      const cx = ${zz.x}, cz = ${zz.z}, r = ${zz.r};
      g.camera.position.set(cx + r * 0.15, r * 1.35 + 6, cz + r * 1.5 + 8);
      g.camera.lookAt(cx, 1.2, cz);
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.85);
    })()`);
    if (typeof shot === 'string' && shot.startsWith('data:image')) {
      await fs.writeFile(path.join(out, `zone_${kind}.jpg`), Buffer.from(shot.split(',')[1], 'base64'));
      ok(true, `${kind} 截图已保存 shots/verify/zone_${kind}.jpg`);
    } else {
      ok(false, `${kind} 截图失败`, String(shot).slice(0, 120));
    }

    // 到期清理：把寿命归零推进一帧，该区域登记的 Effekseer 实例必须全部停掉，
    // 否则会留下"区域没了特效还在"的幽灵（旧几何版本靠 dispose 保证，改特效后要靠 fxKeys）
    const cleaned = await ev(`(function(){
      const it = window.__game.items;
      const z = it.zones.find((x) => x.kind === ${JSON.stringify(kind)});
      if (!z) return true;
      const keys = [...(z.fxKeys || [])];
      z.life = 0.001;
      it.update(0.05, performance.now() / 1000, performance.now());
      return keys.every((k) => !it.fx.attached.has(k));
    })()`);
    ok(cleaned === true, `${kind}：到期后特效实例全部停止（不留幽灵）`, cleaned);
  }

  ok(errors.length === 0, '全程零页面异常', errors.slice(0, 4));
} catch (e) {
  failures += 1;
  console.error('\n✗ 中断：', e.message);
  console.error('  页面异常：', JSON.stringify(errors.slice(0, 4)));
} finally {
  if (child?.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]);
  server.kill();
}

console.log('\n===== 汇总 =====');
console.log(failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
