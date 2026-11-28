// 云端天梯 · 局域网 / 线上入口 · 真双客户端全景联机探针
//   MODE=lan   node tests/skytower_net_full_probe.mjs
//   MODE=online node tests/skytower_net_full_probe.mjs
//
// 两个真 Edge 客户端连同一台本地服务器：
//   - lan    ：http://127.0.0.1:<port>/?ws=<wsPort>，房主 #btn-host，客人 #btn-join
//   - online ：http://tower-e2e.onrender.com:<port>/（--host-resolver-rules 指到 127.0.0.1）
//              .onrender.com 命中线上入口白名单，走同源 /ws，等价于 Render 部署链路
//
// 覆盖：船-船碰撞穿模、足球跨端撞击/进球计分、包子送达与泡泡、道具箱吃箱/放道具、
//       BOSS 命中、落雷命中、塔防击杀、缩圈惩罚、水晶泡泡/扣血、涂地、皇冠加冕，
//       以及 RTT / 30Hz 快照频率 / 事件端到端延迟。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const MODE = (process.env.MODE || 'lan').toLowerCase() === 'online' ? 'online' : 'lan';
const HTTP_PORT = MODE === 'online' ? 3583 : 3581;
const WS_PORT = MODE === 'online' ? 3584 : 3582;
const FAKE_HOST = 'tower-e2e.onrender.com';
const BASE = MODE === 'online'
  ? `http://${FAKE_HOST}:${HTTP_PORT}/?towerCinema=0`
  : `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = Date.now();
const CDP_HOST = 9810 + (stamp % 30);
const CDP_GUEST = 9850 + (stamp % 30);
const DECK = [0.4, 18.3, 36.3, 54.3, 72.3, 90.3, 108.3, 126.3, 144.3, 162.3];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

class Client {
  constructor(label, cdpPort, profile, url) {
    this.label = label;
    this.cdpPort = cdpPort;
    this.profile = profile;
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.errors = [];
    this.child = null;
    this.ws = null;
  }
  async launch() {
    const args = [
      '--headless=new', '--no-sandbox', `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profile}`, '--window-size=1280,760',
    ];
    if (MODE === 'online') args.push(`--host-resolver-rules=MAP ${FAKE_HOST} 127.0.0.1`);
    args.push(this.url);
    this.child = spawn(edge, args, { stdio: 'ignore' });
    let tabs = null;
    for (let i = 0; i < 150 && !tabs; i++) {
      try { const r = await fetch(`http://127.0.0.1:${this.cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
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
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params?.exceptionDetails?.exception?.description || 'exception';
        // Effekseer 的 WASM 在 headless 反复切层卸载时会报 null function signature，
        // 与游戏逻辑无关（真机不会触发），和已有的 WebGL 误报一起过滤。
        if (!/texImage2D|Overload resolution failed|Cannot read properties of null \(reading 'getParameter'\)|null function or function signature mismatch/.test(d)) {
          this.errors.push(d.split('\n').slice(0, 5).join(' | '));
        }
      }
    });
    await this.cdp('Page.enable');
    await this.cdp('Runtime.enable');
  }
  cdp(method, params = {}, timeout = 120000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej })),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${this.label} cdp timeout: ${method}`)), timeout)),
    ]);
  }
  async ev(expr) {
    const r = await this.cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.value;
  }
  async j(expr) {
    const raw = await this.ev(expr);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  async waitFor(expr, label, tries = 160) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { last = await this.ev(expr); } catch (e) { last = e.message; }
      if (last === true || (typeof last === 'number' && last > 0)) return last;
      await sleep(200);
    }
    throw new Error(`${this.label} timeout: ${label} (last=${JSON.stringify(last)})`);
  }
  close() { try { this.ws?.close(); } catch { /* 关了 */ } try { this.child?.kill(); } catch { /* 关了 */ } }
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/skytower_full_' + MODE + '.json'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

const host = new Client('房主', CDP_HOST, path.resolve(`D:/3dgame-tmp/browser/tower-full-host-${stamp}`), BASE);
const guest = new Client('客机', CDP_GUEST, path.resolve(`D:/3dgame-tmp/browser/tower-full-guest-${stamp}`), BASE);

let hostId = null, guestId = null;
const failed = (label, extra) => { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); };
const run = async (label, fn) => {
  try { await fn(); } catch (e) { failed(label + '：探针异常', e?.stack || String(e)); }
};

const setLayer = (c, layer) => c.ev(`(()=>{const g=window.__game,b=g.bossMode,y=${DECK[layer]};
  b.phase='fight'; b.timeLeft=900; b.layerIndex=${layer}; b.layerPhase='round'; b.layerTimeLeft=120;
  for(const [id,p] of b.players){p.layer=${layer};p.alive=true;p.invuln=0;p.fallWater=null;
    const bt=b.boats.get(id); if(!bt) continue; bt.skyLayer=${layer}; bt.liftRide=null; bt.skyFall=false;
    bt.diveTargetY=y; bt.vy=0; bt.speed=0; bt.vel.set(0,0);}
  const me=g.localBoat; me.pos.set(0,y,0); me.vel.set(0,0); me.speed=0; me.vy=0; me.liftRide=null; me.skyLayer=${layer}; me.diveTargetY=y;
  return 1;})()`);

const park = (c, x, z, y, heading = 0) => c.ev(`(()=>{const b=window.__game.localBoat;
  b.pos.set(${x},${y},${z}); b.heading=${heading}; b.vel.set(0,0); b.speed=0; b.vy=0; b.liftRide=null;
  return 1;})()`);

const stateOf = (c) => c.j(`(()=>{const g=window.__game,b=g.bossMode;return JSON.stringify({
  myId:g.myId,isHost:g.isHost,netMode:g.net?.mode,rtt:+(g.net?.rtt||0).toFixed(1),
  phase:b.phase,layer:b.layerIndex,lp:b.layerPhase,
  players:[...b.players].map(([id,p])=>({id,s:p.score,l:p.layer,alive:p.alive})),
  boats:[...b.boats].map(([id,bt])=>({id,x:+bt.pos.x.toFixed(2),z:+bt.pos.z.toFixed(2),h:+bt.heading.toFixed(2),s:+bt.speed.toFixed(2)})),
  rx:{...window.__np?.rx},tx:{...window.__np?.tx},
});})()`);

const playerScore = async (c, id) => {
  const st = await stateOf(c);
  return st.players.find((p) => p.id === id)?.s ?? null;
};
const rxOf = async (c, type) => (await c.ev(`(window.__np?.rx?.[${JSON.stringify(type)}]||0)`)) || 0;
const txOf = async (c, type) => (await c.ev(`(window.__np?.tx?.[${JSON.stringify(type)}]||0)`)) || 0;
// 事件 key 会带上 id/by 后缀（如 towerCrystalFire:p3），断言一律按前缀求和。
const rxStarts = (c, prefix) => c.j(`(()=>{let n=0;for(const k in (window.__np?.rx||{}))if(k.startsWith(${JSON.stringify(prefix)}))n+=window.__np.rx[k];return n;})()`);
const txTimeStarts = (c, prefix) => c.j(`(()=>{let t=0;for(const k in (window.__np?.txT||{}))if(k.startsWith(${JSON.stringify(prefix)}))t=Math.max(t,window.__np.txT[k]);return t;})()`);
const rxTimeStarts = (c, prefix) => c.j(`(()=>{let t=0;for(const k in (window.__np?.rxT||{}))if(k.startsWith(${JSON.stringify(prefix)}))t=Math.max(t,window.__np.rxT[k]);return t;})()`);
// 跨端事件一律轮询：无头双开 + CDP 注入下单程可能到 600ms，固定 sleep 会假阴性。
const waitForRx = async (c, prefix, base = 0, tries = 16) => {
  let n = await rxStarts(c, prefix);
  for (let i = 0; i < tries && n <= base; i++) {
    await sleep(150);
    n = await rxStarts(c, prefix);
  }
  return n;
};

async function installProbe(c) {
  await c.ev(`(()=>{const g=window.__game;window.__np={rx:{},rxT:{},tx:{},txT:{}};
    const os=g.net.send.bind(g.net);
    g.net.send=(m)=>{const k=m.t+(m.id?':'+m.id:(m.by?':'+m.by:''));
      window.__np.tx[k]=(window.__np.tx[k]||0)+1;window.__np.txT[k]=Date.now();return os(m);};
    const ws=g.net.ws;
    if(ws){const prev=ws.onmessage;ws.onmessage=(e)=>{try{const m=JSON.parse(e.data);
      const k=m.t+(m.id?':'+m.id:(m.by?':'+m.by:''));
      window.__np.rx[k]=(window.__np.rx[k]||0)+1;window.__np.rxT[k]=Date.now();}catch(_){}
      if(prev)return prev(e);};}
    return 1;})()`);
}

try {
  console.log(`\n===== 天梯双客户端全景联机探针（${MODE === 'lan' ? '局域网' : '线上同源'}）=====`);
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(200);
  }
  await Promise.all([host.launch(), guest.launch()]);

  const tokenHost = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯房主A');
  const tokenGuest = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯客机B');
  ok(!!tokenHost && !!tokenGuest, '两端都拿到真实账号 token');
  for (const [c, token, name] of [[host, tokenHost, '天梯房主A'], [guest, tokenGuest, '天梯客机B']]) {
    await c.ev(`localStorage.setItem('rr-name',${JSON.stringify(name)});localStorage.setItem('rr-account-token',${JSON.stringify(token)});1`);
    await c.ev(`location.reload();1`);
    await sleep(2400);
    // 主菜单阶段还没有 __game（它是在 Game 构造、也就是点入口之后才挂的），
    // 这里只等入口按钮就绪。无头双开偶发把 2.3MB bundle 卡在 loading，重载兜底。
    const readyExpr = `!!document.querySelector('#btn-host')
      || !!document.querySelector('#btn-join') || !!document.querySelector('#btn-entry-online')`;
    let ready = false;
    for (let attempt = 0; attempt < 3 && !ready; attempt++) {
      try {
        await c.waitFor(readyExpr, '主菜单与游戏实例', 50);
        ready = true;
      } catch (e) {
        if (attempt === 2) {
          const diag = await c.ev(`JSON.stringify({href:location.href,ready:document.readyState,
            body:document.body?.innerText?.slice(0,180),
            keys:Object.keys(window).filter(k=>/game|^__/i.test(k)).slice(0,20)})`);
          throw new Error(c.label + ' 初始化失败：' + diag + ' | errors=' + JSON.stringify(c.errors.slice(0, 3)) + '\n' + e.message);
        }
        console.error(`  [${c.label}] 页面卡在 loading，重载重试 ${attempt + 1}/2`);
        await c.ev(`location.reload();1`);
        await sleep(1800);
      }
    }
    await sleep(600);
  }

  console.log('\n[1] 双端入场 → 天梯房间');
  const inLobby = `!document.querySelector('#lobby')?.classList.contains('hidden')`;
  if (MODE === 'lan') {
    await host.ev(`document.querySelector('#btn-host').click();1`);
    await guest.ev(`document.querySelector('#btn-join').click();1`);
    await guest.waitFor(`!document.querySelector('#dlg-join')?.classList.contains('hidden')`, '加入对话框');
    await guest.ev(`(()=>{document.querySelector('#input-host').value='127.0.0.1';document.querySelector('#btn-join-go').click();return 1;})()`);
    await host.waitFor(inLobby, '房主进大厅');
    await guest.waitFor(inLobby, '客机进大厅');
  } else {
    const gate = await host.ev(`!document.querySelector('#btn-entry-online')?.classList.contains('is-locked')`);
    ok(gate === true, '线上入口在 .onrender.com 域名下解锁');
    // 串行入场：两端同时点线上入口时 hello 的账号校验会抢同一条链路，
    // 无头双开偶发一侧卡在登录态。房主先落厅，客机再进。
    const diagOf = (c) => c.ev(`JSON.stringify({net:window.__game?.net?.mode,
      connected:window.__game?.net?.connected,url:location.href,
      toast:[...document.querySelectorAll('.toast,[class*=toast]')].map(x=>x.textContent).slice(0,4)})`);
    await host.ev(`document.querySelector('#btn-entry-online').click();1`);
    try {
      await host.waitFor(inLobby, '房主进大厅', 80);
    } catch (e) { throw new Error('房主进大厅失败：' + await diagOf(host) + '\n' + e.message); }
    await guest.ev(`document.querySelector('#btn-entry-online').click();1`);
    try {
      await guest.waitFor(inLobby, '客机进大厅', 80);
    } catch (e) { throw new Error('客机进大厅失败：' + await diagOf(guest) + '\n' + e.message); }
  }

  await host.ev(`document.querySelector('#btn-lobby-mode').click();1`);
  await host.waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉');
  await host.ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click();1`);
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
  ok(started === 'ok', '房主开始天梯对局', started);
  await host.waitFor(`!!window.__game?.bossMode`, '房主天梯控制器');
  await guest.waitFor(`!!window.__game?.bossMode`, '客机天梯控制器');
  hostId = await host.ev(`window.__game.myId`);
  guestId = await guest.ev(`window.__game.myId`);
  ok(!!hostId && !!guestId && hostId !== guestId, '两端拿到不同玩家 id', { hostId, guestId });

  await host.ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0.05;b.phase='countdown';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await host.waitFor(`window.__game.bossMode.layerPhase==='round'`, '第 1 层开赛');
  await guest.waitFor(`window.__game.bossMode.layerPhase==='round'`, '客机同步第 1 层开赛');
  await Promise.all([installProbe(host), installProbe(guest)]);
  const s0 = await stateOf(host), g0 = await stateOf(guest);
  ok(s0.isHost === true && g0.isHost === false, '判定权威只在房主端', { host: s0.isHost, guest: g0.isHost });
  ok(s0.players.length === 2 && g0.players.length === 2, '两端都看到 2 名真人', { host: s0.players.length, guest: g0.players.length });
  ok(s0.netMode === (MODE === 'online' ? 'online' : 'lan') && g0.netMode === s0.netMode,
    `两端网络入口一致：${s0.netMode}`, { host: s0.netMode, guest: g0.netMode });

  console.log('\n[2] 延迟 / 快照频率');
  const rx0 = await rxOf(host, 'snap');
  await sleep(2000);
  const rx1 = await rxOf(host, 'snap');
  const snapRate = (rx1 - rx0) / 2;
  const sLat = await stateOf(host), gLat = await stateOf(guest);
  // 无头双浏览器 + 每帧 CDP 打点会把 30Hz 压到十几 Hz；这里只卡「没有断流」，
  // 真机帧率另看 RTT 和事件端到端延迟。
  ok(snapRate >= 12, `房主收到船位快照流正常（实测 ${snapRate.toFixed(1)}Hz，无头双开）`, snapRate);
  ok(sLat.rtt < 300 && gLat.rtt < 300, `两端 RTT 正常（${sLat.rtt}ms / ${gLat.rtt}ms）`, { host: sLat.rtt, guest: gLat.rtt });

  await run('[3] 船-船碰撞 / 穿模', async () => {
    await Promise.all([setLayer(host, 0), setLayer(guest, 0)]);
    await park(host, -6, 25, DECK[0], Math.PI / 2);
    await park(guest, 6, 25, DECK[0], -Math.PI / 2);
    await sleep(300);
    await Promise.all([host.ev(`window.__game.bossMode.input.keys.add('w');1`), guest.ev(`window.__game.bossMode.input.keys.add('w');1`)]);
    await sleep(2600);
    await Promise.all([host.ev(`window.__game.bossMode.input.keys.delete('w');1`), guest.ev(`window.__game.bossMode.input.keys.delete('w');1`)]);
    await sleep(300);
    const hs = await stateOf(host), gs = await stateOf(guest);
    const hb = hs.boats.find((b) => b.id === hostId), hr = hs.boats.find((b) => b.id === guestId);
    const gb = gs.boats.find((b) => b.id === guestId), gr = gs.boats.find((b) => b.id === hostId);
    const distH = Math.hypot(hb.x - hr.x, hb.z - hr.z);
    const distG = Math.hypot(gb.x - gr.x, gb.z - gr.z);
    const viewDiff = Math.hypot(hr.x - gb.x, hr.z - gb.z);
    ok(distH > 2.2 && distG > 2.2, `两端都没看到船体穿模（房主 ${distH.toFixed(2)}m / 客机 ${distG.toFixed(2)}m）`,
      { hostBoat: hb, hostViewGuest: hr, guestBoat: gb, guestViewHost: gr });
    ok(viewDiff < 6, `两端对客机船位认识一致（差 ${viewDiff.toFixed(2)}m）`, { viewDiff, hr, gb });
  });

  await run('[4] 第 1 层：客机撞球 + 进球计分', async () => {
    await Promise.all([setLayer(host, 0), setLayer(guest, 0)]);
    await park(host, 45, 0, DECK[0]);
    // 从场地上沿起步，等快照追上来时正好压到球；太近会在打点间隙里直接穿过去。
    await park(guest, 0, 30.5, DECK[0], Math.PI);
    await guest.ev(`window.__game.localBoat.vel.set(0,-18);1`);
    await sleep(180);
    const pre = await host.j(`(()=>{const g=window.__game,b=g.bossMode,bt=b.boats.get(${JSON.stringify(guestId)});
      const s=bt?.remoteSnaps?.at(-1)||{};return JSON.stringify({myId:g.myId,me:{x:+g.localBoat.pos.x.toFixed(1),z:+g.localBoat.pos.z.toFixed(1)},
        guest:{x:+bt.pos.x.toFixed(1),z:+bt.pos.z.toFixed(1)},snap:{x:+s.x.toFixed(1),z:+s.z.toFixed(1),vz:+s.vz.toFixed(1)}});})()`);
    // 只确认快照方向对、已经离开起点即可；精确 z 会被 CDP 打点间隙左右。
    ok(pre.snap.z > 20 && pre.snap.z < 30.5 && pre.snap.vz < -5,
      '房主已收到客机贴球的最新快照', pre);
    await host.ev(`(()=>{const f=window.__game.bossMode.football;f.resetTimer=0;f.kickoffLock=0;
      f.ball.dead=false;f.ball.x=0;f.ball.z=25;f.ball.vx=0;f.ball.vz=0;f.ball.lastTouch=null;return 1;})()`);
    await sleep(350);
    const ballH = await host.ev(`(()=>{const f=window.__game.bossMode.football;return JSON.stringify({last:f.ball.lastTouch,vz:+f.ball.vz.toFixed(2),x:+f.ball.x.toFixed(2),z:+f.ball.z.toFixed(2)});})()`).then(JSON.parse);
    ok(ballH.last === guestId && Math.abs(ballH.z - 25) > 0.3,
      `房主认下客机撞球（lastTouch=${ballH.last}, z=${ballH.z}）`, { ballH, pre });
    // 停球 + 两端收油门：15Hz 球快照 + 客机指数跟随（时间常数约 71ms），
    // 球刚被撞飞时速度很高，固定 250ms 会撞上取样错位。改成轮询收敛。
    await Promise.all([
      host.ev(`(()=>{const g=window.__game,b=g.bossMode.football.ball;
        b.vx=0;b.vz=0;g.localBoat.vel.set(0,0);g.localBoat.speed=0;return 1;})()`),
      guest.ev(`(()=>{const g=window.__game;g.localBoat.vel.set(0,0);g.localBoat.speed=0;return 1;})()`),
    ]);
    let ballG, ballH2, gap = Infinity;
    for (let i = 0; i < 20 && gap >= 3; i++) {
      await sleep(150);
      ballH2 = await host.ev(`(()=>{const b=window.__game.bossMode.football.ball;return JSON.stringify({x:+b.x.toFixed(2),z:+b.z.toFixed(2)});})()`).then(JSON.parse);
      ballG = await guest.ev(`(()=>{const b=window.__game.bossMode.football.ball;return JSON.stringify({x:+b.x.toFixed(2),z:+b.z.toFixed(2)});})()`).then(JSON.parse);
      gap = Math.hypot(ballG.x - ballH2.x, ballG.z - ballH2.z);
    }
    ok(gap < 3, `客机看到的球位跟着房主走（差 ${gap.toFixed(2)}m）`, { ballH2, ballG });

    const beforeH = await playerScore(host, guestId), beforeG = await playerScore(guest, guestId);
    const side = await host.ev(`window.__game.bossMode.football.attackDir(${JSON.stringify(guestId)},window.__game.bossMode.ids.indexOf(${JSON.stringify(guestId)}))`);
    await host.ev(`(()=>{const f=window.__game.bossMode.football;f.ball.dead=false;f.resetTimer=0;
      f.ball.x=${side}*47;f.ball.z=0;f.ball.vx=${side}*38;f.ball.vz=0;f.ball.lastTouch=${JSON.stringify(guestId)};return 1;})()`);
    await sleep(450);
    const afterH = await playerScore(host, guestId), afterG = await playerScore(guest, guestId);
    ok(afterH - beforeH === 1, `客机进球房主 +1（${beforeH}→${afterH}）`, { beforeH, afterH, side });
    ok(afterG - beforeG === 1, `客机进球自己也 +1（${beforeG}→${afterG}）`, { beforeG, afterG, side });
  });

  await run('[5] 第 2 层：包子送达 + 泡泡跨端', async () => {
    await Promise.all([setLayer(host, 1), setLayer(guest, 1)]);
    const idx = await guest.ev(`window.__game.bossMode.ids.indexOf(${JSON.stringify(guestId)})`);
    const doorX = idx % 2 === 0 ? -46 : 46;
    await park(guest, doorX, 0, DECK[1]);
    await host.ev(`(()=>{const d=window.__game.bossMode.deliver;d.carrierId=null;d.cargo.held=false;return 1;})()`);
    const beforeH = await playerScore(host, guestId), beforeG = await playerScore(guest, guestId);
    await sleep(200);
    await host.ev(`(()=>{const d=window.__game.bossMode.deliver;d.carrierId=${JSON.stringify(guestId)};d.cargo.held=true;return 1;})()`);
    await sleep(450);
    const afterH = await playerScore(host, guestId), afterG = await playerScore(guest, guestId);
    ok(afterH - beforeH === 2 && afterG - beforeG === 2,
      `客机送达两端都 +2（房主 ${beforeH}→${afterH} / 客机 ${beforeG}→${afterG}）`, { afterH, afterG });
    ok(await waitForRx(guest, 'deliverScore') > 0, '客机收到 deliverScore 广播');

    const fired = await guest.ev(`(()=>{const g=window.__game,b=g.bossMode,bt=g.boats.get(g.myId);
      b.deliver.cooldown.delete(g.myId); return b.deliver.fire(g.myId,bt,${idx})?1:0;})()`);
    await sleep(350);
    const bubbles = await host.ev(`window.__game.bossMode.deliver.bubbles.length`);
    ok(fired === 1 && bubbles > 0, `客机放泡泡在房主侧生成权威泡泡（${bubbles} 个）`, { fired, bubbles });
    ok(await waitForRx(host, 'bubbleSpawn') > 0, '房主收到 bubbleSpawn');
  });

  await run('[6] 第 3 层：客机吃箱 + 放道具', async () => {
    await Promise.all([setLayer(host, 2), setLayer(guest, 2)]);
    await sleep(300);
    const box = await guest.j(`(()=>{const it=window.__game.bossMode.itemRush.items;
      const b=(it.boxes||[]).find(x=>x.active);return b?JSON.stringify({i:b.idx,x:b.x,z:b.z}):'null';})()`);
    ok(!!box, '第 3 层存在可拾取箱子', box);
    if (box) {
      await park(guest, box.x, box.z, DECK[2]);
      await sleep(450);
      const hb = await host.ev(`(window.__game.bossMode.itemRush.bx.get(${JSON.stringify(guestId)})||0)`);
      const gb = await guest.ev(`(window.__game.bossMode.itemRush.bx.get(${JSON.stringify(guestId)})||0)`);
      ok(hb > 0 && gb > 0, `客机吃箱两端计数一致（房主 ${hb} / 客机 ${gb}）`, { hb, gb });
    }
    const used = await guest.ev(`(()=>{const b=window.__game.bossMode.itemRush;
      b.items.myItems[0]='bomb';b.running=true;return b.useSlot(0)?1:0;})()`);
    await sleep(350);
    ok(used === 1 && await waitForRx(host, 'itemUse') > 0, '客机放道具走真实网络到房主');
  });

  await run('[7] 第 4 层：客机雷炮命中 BOSS', async () => {
    await Promise.all([setLayer(host, 3), setLayer(guest, 3)]);
    await sleep(400);
    await host.ev(`(()=>{const b=window.__game.bossMode.bossRush;
      if(!b.boss) b.update(0.02,[]); b.running=true; b.started=true; b.cannonCd.set(${JSON.stringify(guestId)},0); return 1;})()`);
    const boss = await host.j(`(()=>{const b=window.__game.bossMode.bossRush.boss;
      return b?JSON.stringify({x:b.pos.x,z:b.pos.z,hp:b.hp}):'null';})()`);
    ok(!!boss, 'BOSS 已在房主侧生成', boss);
    if (boss) {
      await guest.ev(`(()=>{const g=window.__game,b=g.bossMode.bossRush,bt=g.boats.get(g.myId);
        bt.pos.set(${boss.x}+10,${DECK[3]},${boss.z});b.running=true;b.started=true;b.cannonCd.set(g.myId,0);
        return b.fireCannon()?1:0;})()`);
      await sleep(400);
      const dmg = await host.ev(`(window.__game.bossMode.bossRush.damageBy.get(${JSON.stringify(guestId)})||0)`);
      ok(dmg > 0, `客机雷炮在房主侧记伤害（${dmg}）`, dmg);
      ok(await waitForRx(host, 'towerBossHit') > 0, '房主收到 towerBossHit');
    }
  });

  await run('[8] 第 5 层：落雷命中广播', async () => {
    await Promise.all([setLayer(host, 4), setLayer(guest, 4)]);
    await park(guest, 8, 0, DECK[4]);
    await sleep(300);
    const rx0 = await rxStarts(guest, 'towerBoltHit');
    await host.ev(`window.__game.net.send({t:'towerBoltHit',id:${JSON.stringify(guestId)},n:1,x:8,z:0});1`);
    await sleep(300);
    ok(await waitForRx(guest, 'towerBoltHit', rx0) > rx0, '客机收到房主落雷命中广播');
  });

  await run('[8b] 远端船高度跟随快照（修复"看不见对手船"）', async () => {
    await Promise.all([setLayer(host, 4), setLayer(guest, 4)]);
    await sleep(450);
    // 探针的 setLayer 会给所有船强写 diveTargetY；这里清掉客机上的"远端船高度"，
    // 只留网络快照作为唯一高度来源 —— 正是之前第 2 层以上"船被平台挡住"的现场。
    await guest.ev(`(()=>{const g=window.__game,bt=g.bossMode.boats.get(${JSON.stringify(hostId)});
      if(bt){bt.diveTargetY=null;bt.remoteSkyY=false;bt.pos.y=0.4;} return 1;})()`);
    await sleep(900);
    const gY = await guest.ev(`(()=>{const g=window.__game,bt=g.bossMode.boats.get(${JSON.stringify(hostId)});
      return bt?+bt.pos.y.toFixed(2):-1;})()`);
    const hY = await host.ev(`(()=>{const g=window.__game,bt=g.bossMode.boats.get(${JSON.stringify(hostId)});
      return bt?+bt.pos.y.toFixed(2):-1;})()`);
    ok(gY > 60 && Math.abs(gY - hY) < 1.2, `客机上的房主船高度跟随快照（客机 ${gY} / 房主 ${hY}）`, { gY, hY });
  });

  await run('[9] 第 6 层：客机击杀同步', async () => {
    await Promise.all([setLayer(host, 5), setLayer(guest, 5)]);
    await host.ev(`(()=>{const d=window.__game.bossMode.defense;d.running=true;d.started=true;d.nextIn=0;
      d.update(0.02,[]);return 1;})()`);
    const minion = await host.ev(`(()=>{const d=window.__game.bossMode.defense;const m=(d.minions||[])[0];return m?m.id:null;})()`);
    ok(minion !== null, '塔防小怪已生成', minion);
    if (minion !== null) {
      await guest.ev(`window.__game.net.send({t:'towerDefHit',i:${minion},dmg:999,ram:false,id:${JSON.stringify(guestId)}});1`);
      await sleep(350);
      const kills = await host.ev(`(window.__game.bossMode.defense.killsOf(${JSON.stringify(guestId)})||0)`);
      ok(kills > 0, `客机击杀在房主侧记账（${kills}）`, kills);
      ok(await waitForRx(guest, 'towerDefState') > 0, '客机收到房主塔防状态');
    }
  });

  await run('[10] 第 7 层：缩圈惩罚跨端', async () => {
    await Promise.all([setLayer(host, 6), setLayer(guest, 6)]);
    await host.ev(`(()=>{const s=window.__game.bossMode.shrink;s.dist.set(${JSON.stringify(guestId)},200);s.running=true;s.started=true;s.clockOn=true;return 1;})()`);
    const rx0 = await rxStarts(guest, 'towerShrinkFall');
    await guest.ev(`window.__game.net.send({t:'towerShrinkFall',id:${JSON.stringify(guestId)}});1`);
    await sleep(350);
    const dist = await host.ev(`(window.__game.bossMode.shrink.metersOf(${JSON.stringify(guestId)})||0)`);
    ok(dist <= 125, `客机掉圈房主扣 80m（剩 ${dist}m）`, dist);
    ok(await waitForRx(guest, 'towerShrinkFall', rx0) > rx0, '客机收到带扣减量的 towerShrinkFall');
  });

  await run('[11] 第 8 层：水晶泡泡 + 扣血同步', async () => {
    await Promise.all([setLayer(host, 7), setLayer(guest, 7)]);
    const info = await guest.j(`(()=>{const g=window.__game,c=g.bossMode.crystal;
      c.running=true;c.started=true;c.clockOn=true;c.charges.set(${JSON.stringify(guestId)},1);
      const diag={disposed:c.disposed,running:c.running,isHost:c.isHost,solo:c.solo,
        hasBoat:!!c.boats?.get(${JSON.stringify(guestId)})};
      const fired=c.fireBubble(${JSON.stringify(guestId)})?1:0;
      let tx=0;for(const k in (window.__np?.tx||{}))if(k.startsWith('towerCrystalFire'))tx+=window.__np.tx[k];
      return JSON.stringify({fired,tx,charge:c.charges.get(${JSON.stringify(guestId)}),...diag});})()`);
    ok(info.fired === 1 && info.tx > 0, '客机水晶泡泡发出请求', info);
    ok(await waitForRx(host, 'towerCrystalFire') > 0, '房主收到 towerCrystalFire', info);
    const hp0 = await host.ev(`window.__game.bossMode.crystal.hp[1]`);
    await host.ev(`(()=>{const c=window.__game.bossMode.crystal;c.running=true;c.started=true;c.clockOn=true;c.shieldLeft=0;
      window.__game.bossMode.handleNet({t:'towerCrystalHit',by:${JSON.stringify(guestId)},side:1,dmg:30,x:24,z:0});return 1;})()`);
    const hp1 = await host.ev(`window.__game.bossMode.crystal.hp[1]`);
    await host.ev(`window.__game.net.send({t:'towerCrystalHp',hp:[${hp0},${hp1}],by:${JSON.stringify(guestId)}});1`);
    await sleep(350);
    const hpG = await guest.ev(`window.__game.bossMode.crystal.hp[1]`);
    ok(hp0 - hp1 >= 25, `水晶被客机打掉血（${hp0}→${hp1}）`, { hp0, hp1 });
    ok(Math.abs(hp1 - hpG) < 1, '客机侧水晶血量与房主一致', { hp1, hpG });
  });

  await run('[12] 第 9 层：涂地泡泡跨端', async () => {
    await Promise.all([setLayer(host, 8), setLayer(guest, 8)]);
    const rx0 = await rxStarts(host, 'towerPaintFire');
    const info = await guest.j(`(()=>{const g=window.__game,p=g.bossMode.paint;
      p.running=true;p.started=true;p.clockOn=true;p.bubbleCd.delete(${JSON.stringify(guestId)});
      const diag={disposed:p.disposed,running:p.running,hasBoat:!!p.boats?.get(${JSON.stringify(guestId)}),
        isHost:p.isHost,solo:p.solo,elapsed:p.elapsed};
      const fired=p.fireBubble(${JSON.stringify(guestId)})?1:0;
      return JSON.stringify({fired,...diag});})()`);
    ok(info.fired === 1, '客机涂地泡泡成功发射', info);
    ok(await waitForRx(host, 'towerPaintFire', rx0) > rx0, '房主收到 towerPaintFire');
    // 泡泡 0.8s 引信 + 房主清色后广播 towerPaintState，等两端收敛再比。
    let hc, gc;
    for (let i = 0; i < 16; i++) {
      await sleep(150);
      hc = await host.j(`JSON.stringify(window.__game.bossMode.paint.count)`);
      gc = await guest.j(`JSON.stringify(window.__game.bossMode.paint.count)`);
      if (JSON.stringify(hc) === JSON.stringify(gc)) break;
    }
    ok(JSON.stringify(hc) === JSON.stringify(gc), `两端涂地归属计数一致 ${JSON.stringify(hc)}`, { hc, gc });
  });

  await run('[13] 第 10 层：皇冠泡泡 + 加冕计分', async () => {
    await Promise.all([setLayer(host, 9), setLayer(guest, 9)]);
    await sleep(250);
    const rx0 = await rxStarts(guest, 'towerCrownBubble');
    const fired = await guest.ev(`(()=>{const c=window.__game.bossMode.crown;c.running=true;c.started=true;c.clockOn=true;
      c.bubbleCd.delete(${JSON.stringify(guestId)});
      return c.fireBubble(${JSON.stringify(guestId)})?1:0;})()`);
    // 无头双开 + CDP 注入会把单程拉到 600ms 上下；固定 350ms 会假阴性，改成轮询。
    let fireSeen = 0, bubbleSeen = 0;
    for (let i = 0; i < 16; i++) {
      await sleep(150);
      fireSeen = await rxStarts(host, 'towerCrownFire');
      bubbleSeen = await rxStarts(guest, 'towerCrownBubble');
      if (fireSeen > 0 && bubbleSeen > rx0) break;
    }
    ok(fired === 1 && fireSeen > 0, '客机放泡泡消息到房主', { fired, fireSeen });
    ok(bubbleSeen > rx0, '客机放泡泡房主回传 towerCrownBubble', { rx0, bubbleSeen });

    const beforeH = await playerScore(host, guestId), beforeG = await playerScore(guest, guestId);
    const idx = await host.ev(`window.__game.bossMode.ids.indexOf(${JSON.stringify(guestId)})`);
    const zoneX = idx % 2 === 0 ? -15 : 15;
    await park(guest, zoneX, 0, DECK[9]);
    await sleep(300);
    await host.ev(`(()=>{const c=window.__game.bossMode.crown;c.running=true;c.started=true;c.clockOn=true;
      c.holder=${JSON.stringify(guestId)};c.chargeId=${JSON.stringify(guestId)};c.charge=2.99;
      c.crown.state='hold';c.crown.lock=0;
      return 1;})()`);
    await sleep(400);
    const afterH = await playerScore(host, guestId), afterG = await playerScore(guest, guestId);
    ok(afterH - beforeH >= 8, `客机加冕房主 +8（${beforeH}→${afterH}）`, { beforeH, afterH });
    ok(afterG - beforeG >= 8, `客机加冕自己 +8（${beforeG}→${afterG}）`, { beforeG, afterG });
    ok(await waitForRx(guest, 'towerCrownScore') > 0, '客机收到 towerCrownScore');
  });

  console.log('\n[14] 事件端到端延迟');
  // 用收发打点测「同一条消息」的单程：txT 是本机 net.send 时刻，rxT 是对端
  // onmessage 时刻，同一台机器时钟一致。不要再拿两次 CDP 注入之间的墙钟差当延迟 ——
  // 那里面混着探针 sleep / Runtime.evaluate 开销，会把 30ms 的网络读成 3000ms。
  const h2gTx = await txTimeStarts(host, 'footBall');      // 房主 → 客机（第 1 层 15Hz 球快照）
  const h2gRx = await rxTimeStarts(guest, 'footBall');
  const g2hTx = await txTimeStarts(guest, 'bubbleSpawn');  // 客机 → 房主（第 2 层放泡泡）
  const g2hRx = await rxTimeStarts(host, 'bubbleSpawn');
  const down = h2gTx && h2gRx ? h2gRx - h2gTx : -1;
  const up = g2hTx && g2hRx ? g2hRx - g2hTx : -1;
  console.log(`  · 房主→客机 footBall 快照单程：${down}ms`);
  console.log(`  · 客机→房主 bubbleSpawn 单程：${up}ms`);
  ok(down >= 0 && down < 300, `下行单程延迟 ${down}ms 正常`, { h2gTx, h2gRx, down });
  ok(up >= 0 && up < 300, `上行单程延迟 ${up}ms 正常`, { g2hTx, g2hRx, up });

  const guestFireAt = await txTimeStarts(guest, 'towerCrownFire');
  const hostFireAt = await rxTimeStarts(host, 'towerCrownFire');
  const hostScoreAt = await txTimeStarts(host, 'towerCrownScore');
  const guestScoreAt = await rxTimeStarts(guest, 'towerCrownScore');
  ok(guestFireAt > 0 && hostFireAt > 0 && hostScoreAt > 0 && guestScoreAt > 0,
    '抓到客机→房主→客机的完整事件链', { guestFireAt, hostFireAt, hostScoreAt, guestScoreAt });

  ok(host.errors.length === 0 && guest.errors.length === 0, '两端无未捕获异常',
    { host: host.errors.slice(0, 3), guest: guest.errors.slice(0, 3) });
  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  host.close(); guest.close();
  try { server.kill(); } catch { /* 关了 */ }
  process.exitCode = failures ? 1 : 0;
}
