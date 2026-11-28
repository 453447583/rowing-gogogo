// 单人「云端天梯 · 组队模式」验收：
//   1) 单人也能看到 AI 行、房主（自己）能给 AI 点蓝 / 红（复用道具/竞速组队 UI）
//   2) AI 数量可选到 +5：1 真人 + 5 AI = 3v3
//   3) 满员时点对面队伍会互换，人数始终 3 / 3
//   4) 开局名单 / 控制器 ids=6、两队各 3 人
//   5) 升降光柱已恢复，但本层比赛进行中不显示，打满 60 秒才出现
//
//   node tests/sky_tower_solo_teams_e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const HTTP_PORT = 3521;
const WS_PORT = 3522;
const BASE = `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}&towerCinema=0`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/tower-solo-teams-' + Date.now());
const cdpPort = 9700 + Math.floor(Math.random() * 40);
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

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
    LEADERBOARD_FILE: path.resolve('.tmp_build/tower_solo_teams.json'),
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
const shot = async (expr, file) => {
  const dataUrl = await ev(`(() => { const g=window.__game; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.88);
  })()`);
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    ok(false, '截图 ' + file, String(dataUrl).slice(0, 120)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, `截图 ${file} (${Math.round(buf.length / 1024)}KB)`);
};

/** 读大厅里每个 AI/自己当前选中的队伍 */
const teamState = () => ev(`(()=>{
  const out={};
  document.querySelectorAll('[data-team-switch]').forEach((b)=>{
    const id=b.getAttribute('data-team-switch');
    if(!out[id]) out[id]={blue:false,red:false};
    if(b.classList.contains('selected')) out[id][b.getAttribute('data-team')]=true;
  });
  return JSON.stringify(out);
})()`).then(JSON.parse);

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
  const token = await ensureTestAccount(`http://127.0.0.1:${HTTP_PORT}`, '天梯单人组队');
  ok(!!token, '拿到账号 token');
  await ev(`localStorage.setItem('rr-name','单人天梯'); localStorage.setItem('rr-account-token','${token}'); location.reload();`);
  await sleep(2600);

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, '主菜单', 200);

  console.log('\n[1] 单人 → 天梯 → 组队');
  await ev(`document.querySelector('#btn-solo').click()`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进入大厅');
  await ev(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, '选艇抽屉', 100);
  await ev(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await ev(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, '模式抽屉', 100);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click(); 1`);
  await sleep(400);
  // 不再手动切组队：天梯加入 AI 时应自动切到组队，房主马上能点蓝/红
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(300);
  ok(await ev(`!!document.querySelector('#sel-ai')`), '单人也能看到 AI 数量设置');

  console.log('\n[2] 加 1 个 AI：自动切组队，能看到 AI 行并点蓝 / 红');
  await ev(`(()=>{const s=document.querySelector('#sel-ai');s.value='1';s.onchange();return 1;})()`);
  await waitFor(`!!document.querySelector('[data-team-switch="ai1"]')`, 'AI 分行出现', 60);
  ok(await ev(`!!document.querySelector('[data-team-switch="me"]')`), '自己这一行也有蓝 / 红按钮');
  let ts = await teamState();
  ok(ts.me?.blue === true, '默认自己蓝队', ts.me);
  ok(ts.ai1?.red === true, '默认电脑1 红队（1v1）', ts.ai1);
  // 房主给 AI 选蓝队
  await ev(`document.querySelector('[data-team-switch="ai1"][data-team="blue"]').click(); 1`);
  await sleep(250);
  ts = await teamState();
  ok(ts.ai1?.blue === true && ts.ai1?.red === false, '房主把电脑1 改到蓝队', ts.ai1);
  // 再点回红队
  await ev(`document.querySelector('[data-team-switch="ai1"][data-team="red"]').click(); 1`);
  await sleep(250);
  ts = await teamState();
  ok(ts.ai1?.red === true, '房主又能把电脑1 改回红队', ts.ai1);

  console.log('\n[3] 人数不齐：开赛被拦下（不会悄悄变成 2v1）');
  await ev(`(()=>{const s=document.querySelector('#sel-ai');s.value='2';s.onchange();return 1;})()`);
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  await sleep(900);
  ok(await ev(`!document.querySelector('#lobby')?.classList.contains('hidden') && !window.__game?.bossMode`),
    '1 真人 + 2 AI（蓝 2 / 红 1）留在组队大厅');
  const veto = await ev(`document.getElementById('toast')?.textContent || ''`);
  ok(/两队人数要一样/.test(veto), '提示「两队人数要一样」并建议 1 / 3 / 5', veto);

  console.log('\n[4] 加到 5 个 AI：1 真人 + 5 AI = 3v3');
  await ev(`(()=>{const s=document.querySelector('#sel-ai');s.value='5';s.onchange();return 1;})()`);
  await waitFor(`!!document.querySelector('[data-team-switch="ai5"]')`, '5 个 AI 分行出现', 60);
  const aiOpts = await ev(`(()=>JSON.stringify([...document.querySelectorAll('#sel-ai option')].map(o=>o.value)))()`).then(JSON.parse);
  ok(aiOpts.includes('4') && aiOpts.includes('5'), 'AI 数量选项开放到 +5', aiOpts);
  ts = await teamState();
  const blueN = Object.values(ts).filter((t) => t.blue).length;
  const redN = Object.values(ts).filter((t) => t.red).length;
  ok(blueN === 3 && redN === 3, '默认 3 / 3 分队', { blueN, redN });
  ok(ts.me?.blue === true, '自己仍在蓝队', ts.me);

  console.log('\n[5] 满员互换：点对面队伍也能继续调整');
  await ev(`document.querySelector('[data-team-switch="ai1"][data-team="blue"]').click(); 1`);
  await sleep(300);
  ts = await teamState();
  const blueN2 = Object.values(ts).filter((t) => t.blue).length;
  const redN2 = Object.values(ts).filter((t) => t.red).length;
  ok(ts.ai1?.blue === true, '满员时电脑1 也能换到蓝队（与蓝队一名 AI 互换）', ts.ai1);
  ok(blueN2 === 3 && redN2 === 3, '互换后仍是 3 / 3', { blueN2, redN2 });

  console.log('\n[6] 开赛：名单 / 控制器都是 3v3');
  await ev(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`window.__game?.mode === 'skytower' && !!window.__game.bossMode`, '天梯控制器', 400);
  await ev(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0.05;b.phase='countdown';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase === 'cutscene'`, '第 1 层规则过场', 80);
  const st = await ev(`(()=>{const b=window.__game.bossMode,g=window.__game;
    const teams={blue:0,red:0};
    for(const p of b.players.values()) if(p.team) teams[p.team]=(teams[p.team]||0)+1;
    return JSON.stringify({
      ids:b.ids.length, teamMode:b.teamMode, myTeam:b.teamOf?.(g.myId)||null, teams,
      aiTeams:[...b.players.values()].filter(p=>p.ai).map(p=>({id:p.id,team:p.team})),
      upliftMeshes:b.arena.uplinkMeshes.map(g=>g.children.length),
      liftRings:b.scenery.liftRings.map(g=>g.children.length),
      upliftVisible:b.arena.uplinkMeshes.map(g=>g.visible),
      liftVisible:b.scenery.liftRings.map(g=>g.visible),
      upliftOpen:b.arena.upliftOpenAt[0],
      wakePools:[...b.boats.values()].map(bt=>(bt.wakePool||[]).length),
    });})()`).then(JSON.parse);
  ok(st.ids === 6, '场上 6 名玩家（1 真人 + 5 AI）', st.ids);
  ok(st.teamMode === true, '控制器进入组队模式', st.teamMode);
  ok(st.teams.blue === 3 && st.teams.red === 3, '两队各 3 人', st.teams);
  ok(st.aiTeams.length === 5 && st.aiTeams.every((a) => a.team), '5 个 AI 全部按房主分配进场', st.aiTeams);
  ok(st.aiTeams.find((a) => a.id === 'ai1')?.team === 'blue', '电脑1 在蓝队（与开赛前点击一致）', st.aiTeams);

  console.log('\n[7] 上升通道：比赛期不显示，打满 60 秒才出现');
  ok(st.upliftMeshes.every((n) => n >= 3), 'Arena 升降光柱 / 光环已恢复', st.upliftMeshes);
  ok(st.liftRings.every((n) => n >= 3), 'Scenery 升降光柱 / 光环已恢复', st.liftRings);
  ok(st.upliftOpen === false, '比赛期升降门关闭（等 60 秒结束再开）', st.upliftOpen);
  ok(st.upliftVisible.every((v) => v === false), '比赛进行中天梯（Arena 光柱）不出现', st.upliftVisible);
  ok(st.liftVisible.every((v) => v === false), '比赛进行中天梯（Scenery 光柱）不出现', st.liftVisible);
  ok(st.wakePools.every((n) => n === 0), '天梯里的船不再生成尾迹 / 漂移痕 / 水花 / 水雾', st.wakePools);
  await ev(`(()=>{const b=window.__game.bossMode;b.cutsceneLeft=0.02;return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase === 'round'`, '第 1 层开赛', 60);
  // 把本层计时打到 0：走真实的 #endRound → 开门路径，光柱应该出现
  await ev(`(()=>{const b=window.__game.bossMode;b.layerTimeLeft=0.01;return 1;})()`);
  await waitFor(`window.__game.bossMode.layerPhase === 'travel'`, '第 1 层打满 60 秒', 120);
  const liftAfter = await ev(`(()=>{const b=window.__game.bossMode;return JSON.stringify({
    open:b.upliftOpen, arena:b.arena.uplinkMeshes[0].visible, scenery:b.scenery.liftRings[0].visible,
  });})()`).then(JSON.parse);
  ok(liftAfter.open === true && liftAfter.arena === true && liftAfter.scenery === true,
    '60 秒结束后天梯出现（Arena + Scenery 光柱都显形）', liftAfter);
  // 站到上升通道位置拍一张：光柱已出现，甲板上没有白色泡沫弧
  await shot(`const b=g.bossMode; const up=b.arena.uplinks[0];
    b.boost=null; const c=g.camera; c.position.set(up.x+16, 8, up.z+16); c.lookAt(up.x, 3, up.z); c.updateMatrixWorld();`,
  'sky-tower-lift-restored.jpg');

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
