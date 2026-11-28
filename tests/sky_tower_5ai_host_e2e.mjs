// 联机房主 + 5 AI：验证服务器放开到 +5 AI、1 真人 + 5 AI 能组成 3v3，
// 以及满员时房主点对面队伍会互换（服务器 teamSwitch 交换逻辑）。
//   node tests/sky_tower_5ai_host_e2e.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3531;
const WS_PORT = 3532;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tower-5ai-' + Date.now());
const cdpPort = 9740 + Math.floor(Math.random() * 40);

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
    LEADERBOARD_FILE: path.resolve('.tmp_build/tower_5ai.json'),
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
const teamState = () => ev(`(()=>{
  const out={};
  document.querySelectorAll('[data-team-switch]').forEach((b)=>{
    const id=b.getAttribute('data-team-switch');
    if(!out[id]) out[id]={blue:false,red:false};
    if(b.classList.contains('selected')) out[id][b.getAttribute('data-team')]=true;
  });
  return JSON.stringify(out);
})()`).then(JSON.parse);
const counts = (ts) => ({
  blue: Object.values(ts).filter((t) => t.blue).length,
  red: Object.values(ts).filter((t) => t.red).length,
});

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
  const token = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '五AI房主');
  ok(!!token, '拿到账号 token');
  await ev(`localStorage.setItem('rr-name','五AI房主'); localStorage.setItem('rr-account-token','${token}'); location.reload();`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单');
  await ev(`document.querySelector('#btn-host').click()`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进入大厅');
  await sleep(700);

  console.log('\n[1] 联机天梯 + 5 个 AI（自动切组队）');
  await ev(`document.querySelector('#btn-lobby-mode').click()`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click()`);
  await sleep(400);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  // 不手动点「组队」：加 AI 时应自动切组队，否则房主根本看不到 AI 的蓝/红按钮
  await ev(`(()=>{const s=document.querySelector('#sel-ai');s.value='5';s.dispatchEvent(new Event('change',{bubbles:true}));return 1;})()`);
  await waitFor(`!!document.querySelector('[data-team-switch="ai5"]')`, '5 个 AI 行出现（自动切组队）', 80);
  const opts = await ev(`(()=>JSON.stringify([...document.querySelectorAll('#sel-ai option')].map(o=>o.value)))()`).then(JSON.parse);
  ok(opts.includes('5'), '服务器接受 +5 AI（设置没有被白名单挡回 3）', opts);

  console.log('\n[2] 房主逐个给 AI 分队 → 3v3');
  const clickTeam = async (id, team) => {
    const r = await ev(`(()=>{const b=document.querySelector('[data-team-switch="${id}"][data-team="${team}"]');if(!b)return 'no';b.click();return b.disabled?'disabled':'ok';})()`);
    for (let i = 0; i < 20; i++) {
      if (await ev(`!!document.querySelector('[data-team-switch="${id}"][data-team="${team}"].selected')`).catch(() => false)) break;
      await sleep(150);
    }
    return r;
  };
  ok(await clickTeam('ai1', 'blue') === 'ok', '电脑1 → 蓝队');
  ok(await clickTeam('ai2', 'blue') === 'ok', '电脑2 → 蓝队');
  ok(await clickTeam('ai3', 'red') === 'ok', '电脑3 → 红队');
  ok(await clickTeam('ai4', 'red') === 'ok', '电脑4 → 红队');
  ok(await clickTeam('ai5', 'red') === 'ok', '电脑5 → 红队');
  await sleep(400);
  let ts = await teamState();
  ok(counts(ts).blue === 3 && counts(ts).red === 3, '满员 3 / 3（房主 + 5 AI）', counts(ts));

  console.log('\n[3] 满员互换（服务器 teamSwitch）');
  await clickTeam('ai1', 'red'); // 红队满员 → 与红队一名 AI 互换
  ts = await teamState();
  ok(ts.ai1?.red === true, '电脑1 换到红队（与红队一名 AI 互换）', ts.ai1);
  ok(counts(ts).blue === 3 && counts(ts).red === 3, '互换后仍是 3 / 3', counts(ts));
  await clickTeam('ai1', 'blue'); // 换回来
  ts = await teamState();
  ok(ts.ai1?.blue === true && counts(ts).blue === 3 && counts(ts).red === 3, '再换回蓝队，人数不变', { ai1: ts.ai1, ...counts(ts) });

  console.log('\n[4] 开赛：1 真人 + 5 AI = 3v3');
  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉');
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`window.__game?.mode === 'skytower' && !!window.__game.bossMode`, '天梯控制器', 400);
  await ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0.05;b.phase='countdown';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase === 'cutscene'`, '第 1 层规则过场', 80);
  const st = await ev(`(()=>{const b=window.__game.bossMode;
    const teams={blue:0,red:0};
    for(const p of b.players.values()) if(p.team) teams[p.team]=(teams[p.team]||0)+1;
    return JSON.stringify({ ids:b.ids.length, teamMode:b.teamMode, teams,
      ai:[...b.players.values()].filter(p=>p.ai).map(p=>({id:p.id,team:p.team})),
      uplift:b.arena.uplinkMeshes.map(g=>g.children.length) });})()`).then(JSON.parse);
  ok(st.ids === 6, '场上 6 人（1 真人 + 5 AI）', st.ids);
  ok(st.teamMode === true, '控制器进入组队模式', st.teamMode);
  ok(st.teams.blue === 3 && st.teams.red === 3, '两队各 3 人', st.teams);
  ok(st.ai.length === 5 && st.ai.every((a) => a.team), '5 个 AI 全部按房主分配进场', st.ai);
  ok(st.uplift.every((n) => n >= 3), '升降光柱已恢复（Arena 有光柱 / 光环网格）', st.uplift);
  ok(await ev(`[...window.__game.bossMode.boats.values()].every(bt=>!(bt.wakePool||[]).length)`),
    '甲板上不再生成白色泡沫弧（船尾迹池已关闭）');

  console.log('\n[5] 第 1 层 60 秒 → 开升降门 → 上楼');
  await ev(`(()=>{const b=window.__game.bossMode;b.cutsceneLeft=0.02;return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase === 'round'`, '第 1 层开赛', 60);
  ok(await ev(`window.__game.bossMode.layerTimeLeft > 55`), '本层比赛 60 秒起跑');
  await ev(`(()=>{const b=window.__game.bossMode;b.layerTimeLeft=0.03;return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase === 'travel'`, '第 1 层结束进入传送', 60);
  ok(await ev(`window.__game.bossMode.arena.upliftOpenAt[0]===true`), '升降门已开启（上升通道恢复）');
  ok(await ev(`window.__game.bossMode.football.ball.dead===true`), '第 1 层清场：足球消失');
  // 把 20 秒的等待压到 0.02 秒，验证超时强拉仍能进入第 2 层
  await ev(`window.__game.bossMode.layerWaitLeft=0.02`);
  await waitFor(`(()=>{const b=window.__game.bossMode;return b.layerIndex===1&&b.layerPhase==='cutscene';})()`, '前往第 2 层', 100);
  ok(true, '状态机顺利进入第 2 层');

  ok(errors.length === 0, '流程无未捕获异常', errors.slice(0, 3));
  console.log('\n结果: ' + (failures ? `失败 ${failures} 项` : '全部通过'));
  if (failures) console.error('失败项：' + failures);
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  failures += 1;
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
  process.exitCode = failures ? 1 : 0;
}
