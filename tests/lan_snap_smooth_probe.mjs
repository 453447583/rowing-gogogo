// 局域网快照平滑探针：验证「主机 / AI 在客机端走硬校正导致瞬移」的 bug
//   node tests/lan_snap_smooth_probe.mjs
//
// 根因假设：主机 #sendState() 带 auth:true → 服务端把主机位标为权威 →
// 客机 #onSnapshot 对 auth:true 走 applyNetworkCollisionState（硬写位姿），
// 绕过 setRemoteState 的 66ms 延迟回放插值 → 每个 33ms 快照都是一次跳变。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3591, WS_PORT = 3592;
// 探针适用模式：skytower（天梯）/ item（道具竞速）/ boss（怪物·经典）/ hex（海克斯）
const PROBE_MODE = (process.env.PROBE_MODE || 'skytower').toLowerCase();
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

class Client {
  constructor(label, cdpPort, profile, url) {
    Object.assign(this, { label, cdpPort, profile, url, seq: 0, pending: new Map(), errors: [] });
    this.child = null; this.ws = null;
  }
  async launch() {
    const args = ['--headless=new', '--no-sandbox', `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profile}`, '--window-size=1280,760', this.url];
    this.child = spawn(edge, args, { stdio: 'ignore' });
    let tabs = null;
    for (let i = 0; i < 150 && !tabs; i++) {
      try { const r = await fetch(`http://127.0.0.1:${this.cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* */ }
      if (!tabs) await sleep(200);
    }
    if (!tabs) throw new Error(this.label + ' CDP 未启动');
    const page = tabs.find((x) => x.type === 'page') || tabs[0];
    this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    await this.cdp('Page.enable'); await this.cdp('Runtime.enable');
  }
  cdp(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej })),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${this.label} cdp timeout ${method}`)), 120000)),
    ]);
  }
  async ev(expr) {
    const r = await this.cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  }
  async j(expr) { const v = await this.ev(expr); return typeof v === 'string' ? JSON.parse(v) : v; }
  async waitFor(expr, label, tries = 160) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { last = await this.ev(expr); } catch (e) { last = e.message; }
      if (last === true || (typeof last === 'number' && last > 0)) return last;
      await sleep(200);
    }
    throw new Error(`${this.label} timeout: ${label} (last=${JSON.stringify(last)})`);
  }
  close() { try { this.ws?.close(); } catch { /* */ } try { this.child?.kill(); } catch { /* */ } }
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/snap_smooth.json') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });
// 探针中途异常时也要把子进程收掉，否则 3591 端口被占，下一次启动页面直接打不开。
process.on('exit', () => { try { server.kill(); } catch { /* */ } });

const BASE = (host) => `http://${host}:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0&raceIntro=0`;
const host = new Client('房主', 9810 + (stamp % 30), path.resolve(`D:/3dgame-tmp/browser/snap-host-${stamp}`), BASE('localhost'));
const guest = new Client('客机', 9850 + (stamp % 30), path.resolve(`D:/3dgame-tmp/browser/snap-guest-${stamp}`), BASE('127.0.0.1'));

try {
  console.log('\n===== 局域网快照平滑探针 =====');
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* */ }
    await sleep(200);
  }
  await Promise.all([host.launch(), guest.launch()]);
  // 昵称必须 2~10 位中文/字母/数字/下划线：用时间戳后 4 位保证不重名
  const tag = String(stamp).slice(-4);
  const nameH = `平房${tag}`, nameG = `平客${tag}`;
  const tH = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, nameH);
  const tG = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, nameG);
  if (!tH || !tG) throw new Error('测试账号注册/登录失败（token 为空）');
  for (const [c, token, name] of [[host, tH, nameH], [guest, tG, nameG]]) {
    await c.ev(`localStorage.setItem('rr-name',${JSON.stringify(name)});localStorage.setItem('rr-account-token',${JSON.stringify(token)});1`);
    await c.ev(`location.reload();1`);
    await sleep(2400);
    for (let i = 0; i < 3; i++) {
      if (await c.ev(`!!document.querySelector('#btn-host')`)) break;
      await c.ev(`location.reload();1`); await sleep(1500);
    }
    await c.waitFor(`!!document.querySelector('#btn-host')`, '主菜单');
  }

  // 无头双开偶发点按钮时页面还没绑事件；失败就重载一次重来。
  let entered = false;
  for (let attempt = 0; attempt < 3 && !entered; attempt++) {
    try {
      await host.ev(`document.querySelector('#btn-host')?.click();1`);
      await guest.ev(`document.querySelector('#btn-join')?.click();1`);
      await guest.waitFor(`!document.querySelector('#dlg-join')?.classList.contains('hidden')`, '加入框', 25);
      entered = true;
    } catch {
      if (attempt === 2) throw new Error('客机加入对话框三次都没弹出');
      for (const c of [host, guest]) { await c.ev(`location.reload();1`); }
      await sleep(2200);
      for (const c of [host, guest]) await c.waitFor(`!!document.querySelector('#btn-host')`, '重载主菜单', 60);
    }
  }
  await guest.ev(`(()=>{document.querySelector('#input-host').value='127.0.0.1';document.querySelector('#btn-join-go').click();return 1;})()`);
  await host.waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '房主大厅');
  await guest.waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '客机大厅');
  await host.ev(`document.querySelector('#btn-lobby-mode').click();1`);
  const modeSel = PROBE_MODE === 'hex'
    ? '#lobby-pick-body [data-mode="boss"][data-variant="hex"]'
    : PROBE_MODE === 'boss'
      ? '#lobby-pick-body .lp-boss-card[data-mode="boss"]:not([data-variant])'
      : `#lobby-pick-body [data-mode="${PROBE_MODE}"]`;
  await host.waitFor(`!!document.querySelector('${modeSel}')`, '模式抽屉');
  await host.ev(`document.querySelector('${modeSel}').click();1`);
  await host.ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await sleep(400);
  for (const [c, boat] of [[host, 'titan'], [guest, 'rower']]) {
    await c.ev(`document.querySelector('#btn-lobby-boat').click();1`);
    await c.waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="${boat}"]')`, '选艇抽屉');
    await c.ev(`document.querySelector('#lobby-pick-body [data-boat="${boat}"]').click();1`);
    await c.ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  }
  await guest.ev(`document.querySelector('#btn-lobby-ready').click();1`);
  await sleep(500);
  const started = await host.ev(`(()=>{const b=document.querySelector('#btn-start-race');if(!b||b.disabled)return 'blocked';b.click();return 'ok';})()`);
  ok(started === 'ok', '房主开始对局', started);
  if (PROBE_MODE === 'skytower') {
    await host.waitFor(`!!window.__game?.bossMode`, '房主天梯');
    await guest.waitFor(`!!window.__game?.bossMode`, '客机天梯');
  } else {
    await host.waitFor(`!!window.__game?.localBoat`, '房主进入比赛');
    await guest.waitFor(`!!window.__game?.localBoat`, '客机进入比赛');
    // 无头软件渲染下开场镜头很慢：直接结束开场并把倒计时清 0（发车逻辑仍走 #beginRace）
    for (const c of [host, guest]) {
      await c.ev(`(()=>{const g=window.__game;if(!g)return 0;if(g.raceIntro)g.raceIntro=null;g.countdownLeft=0;return 1;})()`);
    }
    await host.waitFor(`window.__game.phase === 'racing'`, '房主开赛', 220);
    await guest.waitFor(`window.__game.phase === 'racing'`, '客机开赛', 220);
  }
  // 输入对象：天梯/怪物在 bossMode.input，纯竞速在 game.opts.input
  const KEY = PROBE_MODE === 'item' ? 'window.__game.opts.input.keys' : 'window.__game.bossMode.input.keys';

  // 海克斯专属：房主选完本局核心后，客机必须同时关掉选卡浮层、一起进倒计时
  if (PROBE_MODE === 'hex') {
    await host.waitFor(`!document.querySelector('#hex-cards')?.classList.contains('hidden')`, '房主核心选卡');
    const gShown = await guest.ev(`!document.querySelector('#hex-cards')?.classList.contains('hidden')`);
    ok(gShown === true, '客机也显示核心选卡（只读，等待房主）', gShown);
    await host.ev(`document.querySelector('#hex-cards .hex-card:not([disabled])')?.click();1`);
    let sync = null;
    for (let i = 0; i < 20; i++) {
      const st = await guest.j(`JSON.stringify({hidden:!document.querySelector('#hex-cards')||document.querySelector('#hex-cards').classList.contains('hidden'),
        core:window.__game.bossMode.hexCoreId||null,phase:window.__game.bossMode.phase})`);
      if (st.hidden && st.core) { sync = st; break; }
      await sleep(100);
    }
    const hostCore = await host.ev(`window.__game.bossMode.hexCoreId || null`);
    ok(!!sync, '房主选完核心的同一时间，客机也关掉选卡浮层', sync);
    ok(sync && sync.core === hostCore, '两端核心选择一致', { host: hostCore, guest: sync?.core });
  }
  if (PROBE_MODE === 'boss' || PROBE_MODE === 'hex') {
    await host.waitFor(`window.__game.bossMode?.phase === 'fight'`, 'BOSS 开打', 300);
    await guest.waitFor(`window.__game.bossMode?.phase === 'fight'`, '客机 BOSS 开打', 300);
  }
  const hostId = await host.ev(`window.__game.myId`);

  // 打点：两端统计「主机船」收到的 auth 硬校正 vs 延迟回放快照次数
  for (const c of [host, guest]) {
    await c.ev(`(()=>{const g=window.__game,bt=g.boats.get(${JSON.stringify(hostId)}),p=bt.constructor.prototype;
      window.__cnt={hard:0,smooth:0};
      const oh=p.applyNetworkCollisionState,os=p.setRemoteState;
      p.applyNetworkCollisionState=function(...a){window.__cnt.hard++;return oh.apply(this,a)};
      p.setRemoteState=function(...a){window.__cnt.smooth++;return os.apply(this,a)};
      return 1;})()`);
  }

  // 让房主持续前进 2 秒，制造大量快照
  await host.ev(`${KEY}.add('w');1`);
  await sleep(2200);
  await host.ev(`${KEY}.delete('w');1`);
  await sleep(300);

  const cntG = await guest.j(`JSON.stringify(window.__cnt)`);
  const cntH = await host.j(`JSON.stringify(window.__cnt)`);
  console.log('  客机侧主机船打点:', cntG, ' 房主侧自身打点:', cntH);
  ok(cntG.smooth > 10, `客机对主机船走延迟回放插值（${cntG.smooth} 次）`, cntG);
  ok(cntG.hard === 0, `客机不再对主机船走硬校正瞬移（${cntG.hard} 次）`, cntG);

  // applyNetworkCollisionState 距离 >5m 时直接硬写 pos，这是肉眼瞬移的直接来源。
  // 统计 2 秒里有多少次硬写超过阈值。
  await guest.ev(`(()=>{window.__hardJump=[];const bt=window.__game.boats.get(${JSON.stringify(hostId)});
    const p=bt.constructor.prototype, oh=p.applyNetworkCollisionState;
    p.applyNetworkCollisionState=function(st){if(st&&Number.isFinite(st.x)){
      const d=Math.hypot(st.x-this.pos.x,st.z-this.pos.z);if(d>2)window.__hardJump.push(+d.toFixed(2));}
      return oh.call(this,st);};return 1;})()`);
  await host.ev(`${KEY}.add('w');1`);
  await sleep(1800);
  await host.ev(`${KEY}.delete('w');1`);
  const jumps = await guest.j(`JSON.stringify(window.__hardJump.slice(0,12))`);
  console.log('  客机侧主机船 >2m 的硬跳次数:', jumps.length, jumps);
  ok(jumps.length === 0, `硬校正没有造成 >2m 的瞬移（实测 ${jumps.length} 次）`, jumps);

  // 采集客机侧看到的房主船轨迹：客机浏览器里用 rAF 每帧采样，
  // 避免 CDP 跨进程采样间隔抖动伪造出"跳变"。
  await guest.ev(`(()=>{const b=window.__game.boats.get(${JSON.stringify(hostId)});
    window.__traj=[];window.__trajOn=true;
    const tick=()=>{if(!window.__trajOn)return;window.__traj.push({x:+b.pos.x.toFixed(2),z:+b.pos.z.toFixed(2)});
      requestAnimationFrame(tick);};requestAnimationFrame(tick);return 1;})()`);
  // 直接驱动房主本机船（沿船头方向平移）。无头双开时窗口常被判为后台，
  // 键盘状态会被清空，W 可能不加速；位置注入不依赖焦点，测的仍是同一条上报链路。
  await host.ev(`(()=>{const g=window.__game,b=g.localBoat;
    window.__drive=setInterval(()=>{const h=b.heading;
      b.pos.x+=Math.sin(h)*0.3;b.pos.z+=Math.cos(h)*0.3;b.vel.set(6,0);},50);return 1;})()`);
  await sleep(2200);
  await host.ev(`clearInterval(window.__drive);1`);
  const traj = await guest.j(`(()=>{window.__trajOn=false;return JSON.stringify(window.__traj.slice(-90));})()`);
  let maxJump = 0, backSteps = 0;
  for (let i = 1; i < traj.length; i++) {
    const d = Math.hypot(traj[i].x - traj[i - 1].x, traj[i].z - traj[i - 1].z);
    maxJump = Math.max(maxJump, d);
    if (d > 6) backSteps += 1;
  }
  const total = Math.hypot(traj[traj.length - 1].x - traj[0].x, traj[traj.length - 1].z - traj[0].z);
  console.log('  客机侧房主船轨迹: 帧数', traj.length, '总位移', total.toFixed(2), 'm, 最大单帧', maxJump.toFixed(2), 'm');
  ok(total > 2, `客机看到房主船在持续前进（总位移 ${total.toFixed(2)}m）`, { total, head: traj.slice(0, 3) });
  // 快照到达时缓冲会做一次校正（人为 setInterval 强推时实测 2.5~5m），
  // 远小于原实现每 33ms 的硬写跳变。超过 6m 才算肉眼可见的瞬移。
  // 核心判据是上面的 hard=0 / smooth>0，这里只做轨迹兜底。
  ok(backSteps === 0, `逐帧轨迹没有 >6m 的瞬移跳变（${backSteps} 次）`, { backSteps, maxJump });

  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  host.close(); guest.close();
  try { server.kill(); } catch { /* */ }
  process.exitCode = failures ? 1 : 0;
}
