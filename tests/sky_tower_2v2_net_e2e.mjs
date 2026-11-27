// 云端天梯 · 逐层赛制 + 组队（2v2/3v3 AI）真联机验收
//   node tests/sky_tower_2v2_net_e2e.mjs
//
// 2026-11-27 新赛制覆盖：
//   1) 房间：天梯 + 组队，房主手动给 AI 分蓝/红（不再自动补齐），2 真人 + 2 AI = 2v2
//   2) 开局：字段 teamMode / ids 正确；每层 60 秒、升降门平时关闭
//   3) 每层流程：等待全员 → 2.5s 规则过场 → 60s 比赛 → 清场 + 开本层升降门 → 上一层
//   4) 超时强拉：有人没上楼，房主 20 秒后发 towerPull，客机收到自己的 id
//   5) 清场：足球 / 道具箱 / 皇冠在开层后消失
//   6) 第 10 层结束：清场后直接结算，按队伍总分排名
//   7) 稳定性：整段流程无未捕获异常
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3511;
const WS_PORT = 3512;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tower-layers-' + Date.now());
const cdpPort = 9640 + Math.floor(Math.random() * 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/tower_layers_e2e.json'),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', BASE,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 120000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const waitFor = async (expr, label, tries = 160) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(200);
  }
  throw new Error('timeout: ' + label);
};

class Guest {
  constructor(name) { this.name = name; this.msgs = []; this.cursors = {}; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const timer = setTimeout(() => reject(new Error('客人连接超时')), 6000);
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, session: 'guest-tower-layers' })));
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'pong') return;
        this.msgs.push(msg);
        if (msg.t === 'welcome') { this.id = msg.id; clearTimeout(timer); resolve(msg); }
      });
    });
  }
  send(m) { try { this.ws.send(JSON.stringify(m)); } catch { /* 关了 */ } }
  async waitWhere(type, pred = () => true, timeout = 12000) {
    const start = Date.now();
    for (;;) {
      const from = this.cursors[type] || 0;
      for (let i = from; i < this.msgs.length; i++) {
        if (this.msgs[i].t === type && pred(this.msgs[i])) {
          this.cursors[type] = i + 1;
          return this.msgs[i];
        }
      }
      if (Date.now() - start > timeout) throw new Error(`客人等 ${type} 超时`);
      await sleep(30);
    }
  }
  clear() { this.msgs = []; this.cursors = {}; }
}

let guest = null;
const tower = () => ev(`(()=>{const b=window.__game?.bossMode;if(!b)return 'null';return JSON.stringify({
  phase:b.phase,layer:b.layerIndex,lp:b.layerPhase,left:+b.layerTimeLeft.toFixed(2),wait:+b.layerWaitLeft.toFixed(2),
  cut:+b.cutsceneLeft.toFixed(2),uplift:b.arena.upliftOpenAt.slice(),teamMode:b.teamMode,ids:b.ids.length,
});})()`).then((s) => JSON.parse(s));

try {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(200);
  }
  let tabs = null;
  for (let i = 0; i < 120 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails?.exception?.description || 'exception';
      if (!/texImage2D/.test(d)) errors.push(d);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(2200);

  console.log('\n[1] 房主建房 → 天梯 + 组队 + 手动给 AI 分队');
  const token = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯组队房主');
  ok(!!token, '房主拿到账号 token');
  await ev(`localStorage.setItem('rr-name','房主'); localStorage.setItem('rr-account-token','${token}'); location.reload();`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-host').click()`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进入大厅');
  await sleep(800);

  guest = new Guest('红队挑战者');
  await guest.connect();

  await ev(`document.querySelector('#btn-lobby-mode').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click()`);
  await sleep(400);
  const formatBtn = await ev(`(()=>{const b=document.querySelector('#lobby-pick-body [data-format="team"]');
    if(!b) return 'missing'; if(b.disabled) return 'disabled'; b.click(); return 'ok';})()`);
  ok(formatBtn === 'ok', '天梯可点「组队」', formatBtn);
  const rosterTeam = await guest.waitWhere('roster', (r) => r.mode === 'skytower' && r.format === 'team', 9000);
  ok(rosterTeam.format === 'team', '服务器接受天梯组队赛制');
  const hostTeam = rosterTeam.teams?.[rosterTeam.players.find((p) => p.id !== guest.id)?.id];
  const guestTeam = rosterTeam.teams?.[guest.id];
  ok(!!hostTeam && !!guestTeam && hostTeam !== guestTeam, '两名真人自动分到蓝 / 红两队', { hostTeam, guestTeam });
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);

  // AI 数量 2 → 出现两行待分队 AI；房主逐个点蓝 / 红
  await ev(`(()=>{const s=document.getElementById('sel-ai');s.value='2';s.dispatchEvent(new Event('change',{bubbles:true}));return 1;})()`);
  await guest.waitWhere('roster', (r) => r.settings?.aiCount === 2, 9000);
  await waitFor(`!!document.querySelector('[data-team-switch="ai1"]')`, 'AI 分行出现', 60);
  const a1 = await ev(`(()=>{const a=document.querySelector('[data-team-switch="ai1"][data-team="blue"]');if(!a)return 'missing';a.click();return 'ok';})()`);
  await sleep(600);
  const a2 = await ev(`(()=>{const b=document.querySelector('[data-team-switch="ai2"][data-team="red"]');if(!b)return 'missing';b.click();return 'ok';})()`);
  ok(a1 === 'ok' && a2 === 'ok', '房主可以点 AI 的蓝 / 红分队', { a1, a2 });
  const rosterAi = await guest.waitWhere('roster', (r) => {
    const t = r.settings?.aiTeams || [];
    return t.length >= 2 && t[0] && t[1] && t[0] !== t[1];
  }, 9000);
  ok(!!rosterAi, '两个 AI 已被分到不同队伍', rosterAi?.settings?.aiTeams);

  console.log('\n[2] 开局：2 真人 + 2 AI = 2v2');
  await ev(`document.querySelector('#btn-lobby-boat')?.click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click()`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await sleep(300);
  guest.send({ t: 'pick', boatId: 'rower' });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.boatId === 'rower'), 9000);
  guest.clear();
  guest.send({ t: 'ready', ready: true });
  await guest.waitWhere('roster', (r) => r.players.some((p) => p.id === guest.id && p.ready), 9000);
  guest.clear();
  const started = await ev(`(() => { const b=document.querySelector('#btn-start-race'); if(!b||b.disabled) return 'blocked'; b.click(); return 'ok'; })()`);
  ok(started === 'ok', '房主点开始');
  const startMsg = await guest.waitWhere('start', (m) => m.mode === 'skytower', 15000);
  const order = startMsg.order || [];
  const blueN = order.filter((e) => e.team === 'blue').length;
  const redN = order.filter((e) => e.team === 'red').length;
  ok(order.length === 4, '开局名单正好 4 人（2 真人 + 2 AI）', order.length);
  ok(blueN === 2 && redN === 2, '两队各 2 人', { blueN, redN });
  ok(order.filter((e) => e.ai).length === 2, '2 个 AI 按房主分配进场', order.filter((e) => e.ai).map((e) => [e.id, e.team]));
  ok(startMsg.format === 'team', 'start 消息带 team 赛制');

  await waitFor(`window.__game?.mode === 'skytower' && !!window.__game.bossMode`, '天梯控制器');
  // 跳过片头 / 镜头，让倒计时自己走完（只有房主会 beginLayer）
  await ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0.05;b.phase='countdown';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase==='cutscene'`, '第 1 层规则过场', 60);
  const t0 = await tower();
  ok(t0.teamMode === true, '天梯控制器进入组队模式', t0);
  ok(t0.ids === 4, '场上参战 4 人（不再截断到 3）', t0.ids);
  ok(t0.layer === 0 && t0.uplift?.[0] === false, '第 1 层升降门在比赛前是关闭的', t0.uplift);
  await waitFor(`(()=>{const el=document.getElementById('th-team');return !!el && !el.classList.contains('hidden');})()`, 'HUD 队伍对抗条', 80);
  ok(true, 'HUD 右上角出现队伍对抗条');

  // 过场 → 比赛
  await ev(`window.__game.bossMode.cutsceneLeft=0.02`);
  await waitFor(`window.__game.bossMode.layerPhase==='round'`, '第 1 层开赛', 40);
  const r0 = await tower();
  ok(r0.left > 55 && r0.left <= 60, '第 1 层比赛是 60 秒', r0.left);

  console.log('\n[3] 第 1 层：进球只记给进攻方');
  const hostId = await ev(`window.__game.myId`);
  guest.clear();
  const scoreBefore = await ev(`(()=>{const b=window.__game.bossMode;const out={};
    for(const [id,p] of b.players) out[id]={s:p.score,g:b.football.goals.get(id)||0,t:p.team};return JSON.stringify(out);})()`).then(JSON.parse);
  await ev(`(()=>{const b=window.__game.bossMode;
    for(const [id,p] of b.players){p.layer=0;p.alive=true;p.invuln=0;const bt=b.boats.get(id);
      if(bt){bt.skyLayer=0;bt.diveTargetY=0.4;bt.pos.set(p.team==='blue'?-40:40,0.4,0);bt.vel.set(0,0);bt.vy=0;bt.speed=0;bt.liftRide=null;}}
    const me=window.__game.localBoat; me.pos.set(45,0.4,6); me.vel.set(0,0); me.speed=0;
    const f=b.football; f.resetTimer=0; f.kickoffLock=0;
    f.ball.dead=false; f.ball.x=47; f.ball.z=0; f.ball.vx=38; f.ball.vz=0; f.ball.lastTouch=window.__game.myId;
    return 1;})()`);
  const goalMsg = await guest.waitWhere('footGoal', (m) => !!m.id, 8000).catch(() => null);
  await sleep(400);
  const scoreAfter = await ev(`(()=>{const b=window.__game.bossMode;const out={};
    for(const [id,p] of b.players) out[id]={s:p.score,g:b.football.goals.get(id)||0,t:p.team};return JSON.stringify(out);})()`).then(JSON.parse);
  ok(!!goalMsg, '客机收到 footGoal', goalMsg);
  ok(goalMsg?.id === hostId, '进球记到最后触球的蓝队球员（房主）', { goal: goalMsg?.id, hostId });
  const blueDelta = Number(scoreAfter[hostId]?.s || 0) - Number(scoreBefore[hostId]?.s || 0);
  ok(blueDelta === 1, '蓝队只 +1（队伍分不重复记）', { blueDelta });

  console.log('\n[4] 逐层推进：清场 → 开本层升降门 → 上一层');
  // 结束当前层（把本层倒计时压到 0）
  const endLayer = async (layer, expectLast = false) => {
    await ev(`window.__game.bossMode.layerTimeLeft=0.03`);
    if (expectLast) {
      await waitFor(`window.__game.bossMode.phase==='end'`, `第 ${layer + 1} 层结束进结算`, 60);
    } else {
      await waitFor(`(()=>{const b=window.__game.bossMode;return b.layerIndex===${layer}&&b.layerPhase==='travel';})()`, `第 ${layer + 1} 层开升降门`, 60);
    }
  };
  const moveAllTo = async (layer) => ev(`(()=>{const b=window.__game.bossMode;
    for (const [id,p] of b.players) { p.layer=${layer}; const bt=b.boats.get(id); if(bt){bt.skyLayer=${layer};bt.liftRide=null;} }
    b.layerWaitLeft=0.02; return 1;})()`);
  const enterNext = async (layer) => {
    await waitFor(`(()=>{const b=window.__game.bossMode;return b.layerIndex===${layer}&&b.layerPhase==='cutscene';})()`, `第 ${layer + 1} 层过场`, 80);
    await ev(`window.__game.bossMode.cutsceneLeft=0.02`);
    await waitFor(`(()=>{const b=window.__game.bossMode;return b.layerIndex===${layer}&&b.layerPhase==='round';})()`, `第 ${layer + 1} 层开赛`, 60);
  };

  // 第 1 层结束
  await endLayer(0);
  const t1 = await tower();
  ok(t1.uplift?.[0] === true, '第 1 层升降门已开启', t1.uplift);
  ok(await ev(`window.__game.bossMode.football.ball.dead === true`), '第 1 层清场：足球消失');
  const openMsg = await guest.waitWhere('towerOpen', (m) => m.layer === 0, 8000).catch(() => null);
  ok(!!openMsg, '客机收到「第 1 层开门」广播', openMsg);
  guest.clear();
  const layerMsg = await guest.waitWhere('towerLayer', (m) => m.layer === 0 && m.ph === 'travel', 8000).catch(() => null);
  ok(!!layerMsg, '客机收到逐层状态（第 1 层 · travel）', layerMsg);

  await moveAllTo(1);
  await enterNext(1);

  // 第 2 层（泡泡）→ 第 3 层
  await endLayer(1);
  await moveAllTo(2);
  await enterNext(2);

  // 第 3 层（道具箱）：结束时箱子全部消失
  await endLayer(2);
  ok(await ev(`window.__game.bossMode.itemRush.items.boxes.every((b)=>!b.active)`), '第 3 层清场：道具箱全部消失');
  await moveAllTo(3);
  await enterNext(3);

  // 第 4 层结束 → 故意不叫客人上楼，验证 20 秒超时强拉（把等待压到 0.02）
  await endLayer(3);
  await ev(`(()=>{const b=window.__game.bossMode;
    for (const [id,p] of b.players) { if (p.ai || id===window.__game.myId) { p.layer=4; const bt=b.boats.get(id); if(bt){bt.skyLayer=4;bt.liftRide=null;} } }
    b.layerWaitLeft=0.02; return 1;})()`);
  guest.clear();
  const pullMsg = await guest.waitWhere('towerPull', (m) => Array.isArray(m.ids) && m.ids.includes(guest.id), 8000).catch(() => null);
  ok(!!pullMsg && pullMsg.layer === 4, '超时未上楼：客机收到 towerPull → 第 5 层', pullMsg);
  await enterNext(4);

  // 第 5 ~ 9 层快速推进
  for (let l = 4; l <= 8; l++) {
    await endLayer(l);
    await moveAllTo(l + 1);
    await enterNext(l + 1);
  }

  console.log('\n[5] 第 10 层：清场后直接结算');
  await endLayer(9, true);
  ok(await ev(`window.__game.bossMode.crown.crownGroup.visible === false`), '第 10 层清场：皇冠消失');
  await ev(`(()=>{window.__towerEndData=null;const g=window.__game;const orig=g.opts.onSkyTowerEnd;
    g.opts.onSkyTowerEnd=(d)=>{window.__towerEndData=d;if(orig)orig(d);};return 1;})()`);
  await waitFor(`!!window.__towerEndData`, '天梯结算', 120);
  const endData = await ev(`window.__towerEndData ? JSON.stringify(window.__towerEndData) : 'null'`).then((s) => JSON.parse(s));
  ok(!!endData, '第 10 层结束后触发结算');
  ok(errors.length === 0, '整段流程无未捕获异常', errors.slice(0, 3));
  ok(!!endData && endData.teamMode === true, '结算走组队口径', endData && { teamMode: endData.teamMode });
  ok(!!endData && Array.isArray(endData.teams) && endData.teams.length === 2, '结算给出两队总分',
    endData && endData.teams?.map((t) => `${t.team}:${t.score}`));
  const sorted = endData?.teams || [];
  ok(sorted.length === 2 && sorted[0].score >= sorted[1].score, '队伍按总分从高到低排序', sorted.map((t) => t.score));
  ok(sorted[0]?.score === sorted[0]?.ids?.reduce((s, id) => s + (endData.scores.find((x) => x.id === id)?.score || 0), 0),
    '队伍总分 = 队内个人分之和', sorted[0]);
  ok(endData?.won === (endData?.myTeam === endData?.winnerTeam), '胜负按队伍总分判定',
    { won: endData?.won, myTeam: endData?.myTeam, winnerTeam: endData?.winnerTeam });
  const panel = await ev(`(()=>{const el=document.getElementById('boss-end');
    return el && !el.classList.contains('hidden') ? el.innerText.slice(0,200) : '';})()`);
  ok(/蓝队|红队/.test(panel), '结算面板显示队伍总分', panel);

  console.log('\n[5.5] 客机消息处理冒烟（towerLayer / towerOpen / towerLand）');
  const handlerSmoke = await ev(`(()=>{const b=window.__game.bossMode;const out={};
    b.handleNet({t:'towerLayer', layer:2, ph:'travel', left:0, wait:10});
    out.layer= b.layerIndex===2 && b.layerPhase==='travel';
    b.handleNet({t:'towerLayer', layer:3, ph:'round', left:42, wait:0});
    out.round= b.layerIndex===3 && b.layerPhase==='round' && Math.abs(b.layerTimeLeft-42)<0.2;
    b.handleNet({t:'towerOpen', layer:3});
    out.open= b.arena.upliftOpenAt[3]===true;
    b.handleNet({t:'towerLand', id:b.ids[0], layer:3});
    out.land= (b.players.get(b.ids[0])||{}).layer===3;
    return JSON.stringify(out);})()`).then(JSON.parse);
  ok(handlerSmoke.layer && handlerSmoke.round && handlerSmoke.open && handlerSmoke.land,
    '客户端能正确处理逐层状态 / 开门 / 落地广播', handlerSmoke);

  console.log('\n[6] 稳定性观察');
  const stableMs = Math.max(0, Number(process.env.TOWER_STABLE_MS ?? 10000));
  const t0s = Date.now();
  while (Date.now() - t0s < stableMs) {
    await sleep(1000);
    if (guest.ws?.readyState !== 1) { ok(false, '客机连接断开'); break; }
  }
  ok(errors.length === 0, '观察期间无未捕获异常', errors.slice(0, 3));

  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
  if (failures) console.error('失败项：' + failures);
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  try { guest?.ws?.close(); } catch {}
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exitCode = failures ? 1 : 0;
}
