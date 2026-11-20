// 临时探针：验证第 2 关「潮汐擂台」开局不再直接判出圈 + 顶部提示条不再压扁
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9353;
const httpPort = 5214;
const profile = path.resolve('D:/3dgame-tmp/browser/arena-ringout-' + Date.now());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile, '--window-size=960,560', `http://127.0.0.1:${httpPort}/`], { stdio: 'ignore' });

let ws;
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
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
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 40000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await wait(250);
    }
    throw new Error('timeout: ' + label + ' last=' + JSON.stringify(last));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');

  await wait(1200);
  await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 25000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 25000, 'lobby');
  await ev('document.querySelector("#btn-lobby-boat").click()');
  await waitFor('!!document.querySelector("#lobby-pick-body [data-boat=\\"titan\\"]")', 20000, '选艇');
  await ev('document.querySelector("#lobby-pick-body [data-boat=\\"titan\\"]").click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector("#lobby-pick-body [data-mode=\\"arena\\"]")', 20000, '模式');
  await ev('document.querySelector("#lobby-pick-body [data-mode=\\"arena\\"]").click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev(`(function(){
    const sel = document.querySelector("#sel-ai");
    if (sel) { sel.value = "1"; if (sel.onchange) sel.onchange(); }
    return 1;
  })()`);
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game && !!window.__game.bossMode', 60000, 'game boot');
  await waitFor('window.__game.bossMode.phase === "countdown"', 30000, 'countdown');
  await ev('(function(){ const b=window.__game.bossMode; b.intro=0.01; b.cinema=0; b.countdown=0.02; return 1; })()');
  await waitFor('window.__game.bossMode.phase === "fight"', 120000, 'round1 fight');

  // 第 1 关收尾 → 第 2 关擂台
  await ev('(function(){ window.__game.bossMode.roundTime = 0.001; return 1; })()');
  await waitFor('window.__game.bossMode.phase === "roundEnd"', 60000, 'roundEnd');
  await ev('(function(){ window.__game.bossMode.endTimer = 0.01; return 1; })()');
  await waitFor('window.__game.bossMode.round === 2 && window.__game.bossMode.phase === "countdown"', 60000, '第 2 关');

  // 进入 fight 前记录出生点
  await ev('(function(){ const b=window.__game.bossMode; b.intro=0.01; b.cinema=0; b.countdown=0.02; return 1; })()');
  await waitFor('window.__game.bossMode.phase === "fight"', 60000, '第 2 关 fight');

  const atStart = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const f = (id) => { const p = b.boats.get(id).pos; return +Math.hypot(p.x, p.z).toFixed(2); };
    return JSON.stringify({
      ring: b.ring,
      me: f(b.myId), foe: f(b.foeId),
      myScore: b.players.get(b.myId).ringScore,
      foeScore: b.players.get(b.foeId).ringScore,
      myAlive: b.players.get(b.myId).alive,
    });
  })()`));
  console.log('擂台开打瞬间：', JSON.stringify(atStart));

  // 什么都不做，等一段时间看会不会被扣分
  await wait(6000);
  const after = JSON.parse(await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    const f = (id) => { const p = b.boats.get(id).pos; return +Math.hypot(p.x, p.z).toFixed(2); };
    return JSON.stringify({
      myScore: me.ringScore, foeScore: b.players.get(b.foeId).ringScore,
      myAlive: me.alive, myRespawn: +me.respawn.toFixed(2), me: f(b.myId), foe: f(b.foeId),
    });
  })()`));
  console.log('静止 6s 后：', JSON.stringify(after));

  // 顶部提示条排版：文字是否溢出 / 被裁
  const bar = JSON.parse(await ev(`(function(){
    const el = document.getElementById('arena-core');
    const tr = el?.querySelector('.ac-track');
    const sp = tr?.querySelector('span');
    if (!tr || !sp) return JSON.stringify({ missing: true });
    const r = sp.getBoundingClientRect(), t = tr.getBoundingClientRect();
    const cs = getComputedStyle(sp);
    return JSON.stringify({
      text: sp.textContent,
      track: [Math.round(t.width), Math.round(t.height)],
      span: [Math.round(r.width), Math.round(r.height)],
      overflowX: sp.scrollWidth > tr.clientWidth + 1,
      clippedY: r.height > t.height + 1,
      lineHeight: cs.lineHeight, fontSize: cs.fontSize,
    });
  })()`));
  console.log('顶部提示条：', JSON.stringify(bar));

  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
  await fs.writeFile(path.resolve('shots/nitro/arena-ringout.png'), Buffer.from(shot.data, 'base64'));

  const pass = atStart.me < atStart.ring - 3 && atStart.foe < atStart.ring - 3
    && after.myScore === atStart.myScore && after.foeScore === atStart.foeScore && after.myAlive
    && !bar.overflowX && !bar.clippedY && bar.missing !== true;
  console.log(pass ? 'PASS' : 'FAIL');
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  child.kill('SIGKILL');
}
