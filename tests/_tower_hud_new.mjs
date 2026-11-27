// 天梯 HUD 改版验收：右上自己/队伍/榜单 + 左上信息卡 + 底部 K 栏 + 第 3 层道具栏
//   node tests/_tower_hud_new.mjs
// 截图：shots/verify/tower-hud-new-*.png
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/towerhud-${stamp}`);
const port = 9910 + (Number(stamp.slice(-2)) % 20);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const VW = Number(process.env.HUD_W || 1440);
const VH = Number(process.env.HUD_H || 810);
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${VW},${VH}`, 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;
const fails = [];
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { fails.push(label); console.log('  ✗ ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}
async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting ' + expr + ' (last=' + JSON.stringify(last) + ')');
}
async function pageShot(file) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(shots, file), Buffer.from(r.data, 'base64'));
  ok(true, '截图 ' + file);
}

try {
  const info = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  console.log('\n[1] 进天梯（单人 + 2 AI）');
  await cdp('Page.navigate', { url });
  await sleep(3000);
  try {
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 12000);
  } catch {
    await cdp('Page.reload', { ignoreCache: true });
    await sleep(3000);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000);
  }
  await evaluate(`localStorage.setItem('rr-name','HUD探针');localStorage.setItem('rr-account-token','probe-token');1`);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='2';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 60000);

  console.log('\n[2] 跳过开场，进 fight');
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');
    b.players.get(b.myId).layer=4;window.__game.localBoat.skyLayer=4;return 1;})()`);
  await sleep(1200);
  await pageShot('tower-hud-new-layer5.png');

  console.log('\n[3] 底部对齐检查');
  const geo = val(await evaluate(`(()=>{
    const r=(s)=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};};
    return JSON.stringify({
      dash:r('#tower-hud .th-dash'), bottom:r('#tower-hud .th-bottom'),
      info:r('#tower-hud .th-info'), prow:r('#tower-hud .th-prow'), ticker:r('#tower-hud .th-ticker'),
      boards:r('#tower-hud .th-boards'), pips:document.querySelectorAll('#th-cargo-pips i').length,
      steps:document.querySelectorAll('#th-steps s').length,
      stepsOn:document.querySelectorAll('#th-steps s.on').length,
      prowTxt:document.querySelector('#th-prow-txt')?.textContent,
      phaseTxt:document.querySelector('#th-phase-txt')?.textContent,
      teamHidden:document.querySelector('#th-team')?.classList.contains('hidden'),
    });
  })()`));
  console.log('  ' + geo);
  const g = JSON.parse(geo);
  ok(g.steps === 10 && g.stepsOn === 5, '层进度 10 段、当前第 5 层点亮 5 段', { steps: g.steps, on: g.stepsOn });
  ok(g.dash.w > 300, 'K 栏有正常宽度', g.dash);
  ok(!!g.prowTxt && g.prowTxt.includes('层'), '右上自己条有名字/层数/战绩', g.prowTxt);
  ok(g.teamHidden === true, '个人赛制不显示队伍条');
  ok(g.info && g.info.w > 150 && g.info.h > 90, '左上信息卡尺寸正常', g.info);

  console.log('\n[4] 第 3 层：道具栏 + K 栏');
  const enter3 = val(await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
    const dy=b.arena.uplinks[1].y-b.arena.uplinks[0].y;
    p.layer=2;boat.skyLayer=2;boat.pos.set(0, 2*dy+0.4, 0);boat.vel.set(0,0,0);
    b.itemRush.items.myItems=['sanctuary','shield',null];
    return JSON.stringify({phase:b.phase,layer:p.layer});})()`));
  console.log('  ' + enter3);
  await sleep(1600);
  await pageShot('tower-hud-new-layer3.png');
  const geo2 = val(await evaluate(`(()=>{
    const r=(s)=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};};
    const slots=[...document.querySelectorAll('#item-slots .item-slot')].map(e=>{const b=e.getBoundingClientRect();
      return {w:Math.round(b.width),h:Math.round(b.height)};});
    return JSON.stringify({dash:r('#tower-hud .th-dash'),bag:r('#item-slots'),slots,
      names:[...document.querySelectorAll('#item-slots .item-name')].map(e=>e.textContent),
      keys:[...document.querySelectorAll('#item-slots .item-key')].map(e=>e.textContent),
      shown:getComputedStyle(document.querySelector('#item-slots')).display,
      rush:document.querySelector('#hud').classList.contains('tower-rush')});
  })()`));
  console.log('  ' + geo2);
  const g2 = JSON.parse(geo2);
  ok(g2.shown === 'flex', '道具栏显示', g2.shown);
  ok(g2.dash.w > 300, 'K 栏有正常宽度', g2.dash);
  ok(g2.bag && Math.abs(g2.bag.w - g2.dash.w) <= 2, '道具栏总宽与 K 栏一致', { dash: g2.dash, bag: g2.bag });
  ok(Math.abs((g2.dash.x + g2.dash.w / 2) - (g2.bag.x + g2.bag.w / 2)) <= 2, '两者水平居中对齐');
  ok(g2.dash.y + g2.dash.h <= g2.bag.y, 'K 栏在道具栏上方不重叠', { dash: g2.dash, bag: g2.bag });
  ok(g2.slots.length === 3 && g2.slots.every((s) => Math.abs(s.w - g2.slots[0].w) <= 1), '三格等宽', g2.slots);
  ok(g2.keys.join('') === '123', '序号 1/2/3', g2.keys);

  console.log('\n[4b] 第 8/9/10 层专属小面板（信息卡下方）');
  const found = val(await evaluate(`(()=>{
    const b=window.__game.bossMode,p=b.players.get(b.myId);
    const out={};
    for(let L=0;L<10;L++){p.layer=L;const h=b.hudData();
      if(h.towerCrystal&&out.crystal===undefined)out.crystal=L;
      if(h.towerPaint&&out.paint===undefined)out.paint=L;
      if(h.towerCrown&&out.crown===undefined)out.crown=L;}
    return JSON.stringify(out);
  })()`));
  console.log('  ' + found);
  const fl = JSON.parse(found);
  const pick = fl.crown ?? fl.paint ?? fl.crystal;
  if (pick !== undefined) {
    await evaluate(`(()=>{const g=window.__game,b=g.bossMode,p=b.players.get(b.myId),boat=g.localBoat;
      const dy=b.arena.uplinks[1].y-b.arena.uplinks[0].y;
      p.layer=${pick};boat.skyLayer=${pick};boat.pos.set(0, ${pick}*dy+0.4, 0);boat.vel.set(0,0,0);return 1;})()`);
    await sleep(1200);
    await pageShot('tower-hud-new-sub.png');
    const sub = val(await evaluate(`(()=>{
      const r=(s)=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();
        return {y:Math.round(b.y),h:Math.round(b.height),w:Math.round(b.width)};};
      return JSON.stringify({info:r('#tower-hud .th-info'),crystal:r('#th-crystal'),paint:r('#th-paint'),
        crown:r('#th-crown'),crystalHidden:document.querySelector('#th-crystal').classList.contains('hidden'),
        paintHidden:document.querySelector('#th-paint').classList.contains('hidden'),
        crownHidden:document.querySelector('#th-crown').classList.contains('hidden')});
    })()`));
    console.log('  ' + sub);
    const sb = JSON.parse(sub);
    const vis = [sb.crystalHidden ? null : sb.crystal, sb.paintHidden ? null : sb.paint, sb.crownHidden ? null : sb.crown].filter(Boolean);
    ok(vis.length === 1, '同一时刻只有一个专属小面板显示', sb);
    ok(vis.length === 1 && vis[0].y >= sb.info.y + sb.info.h, '小面板在信息卡下方不重叠', { info: sb.info, sub: vis[0] });
  }

  console.log('\n[5] 组队条（模拟 team 数据）');
  await evaluate(`(()=>{
    const b=window.__game.bossMode;
    let k=0;
    for (const [id,p] of b.players) {
      const mine = id===b.myId;
      p.team = mine ? 'blue' : 'red';
      p.score = mine ? 7 : (k++ === 0 ? 3 : 2);
    }
    return 1;
  })()`);
  await sleep(900);
  const teamTxt = val(await evaluate(`JSON.stringify({
    hidden:document.querySelector('#th-team').classList.contains('hidden'),
    mine:document.querySelector('#tt-mine-name')?.textContent,
    foe:document.querySelector('#tt-foe-name')?.textContent,
    a:document.querySelector('#tt-mine')?.textContent,
    b:document.querySelector('#tt-foe')?.textContent})`));
  console.log('  ' + teamTxt);
  const tt = JSON.parse(teamTxt);
  ok(tt.hidden === false, '有队伍数据时显示队伍条');
  ok(tt.a === '7' && tt.b === '5', '队伍总分按队员累加（7 : 5）', tt);
  await pageShot('tower-hud-new-team.png');

  console.log('\n[6] 控制台错误');
  const real = errors.filter((e) => !/effekseer\.min\.js|wasm:\/\/wasm/.test(e));
  ok(real.length === 0, '无未捕获异常', real.slice(0, 3));

  console.log('\n结果: ' + (fails.length ? `失败 ${fails.length} 项` : '全部通过'));
  if (fails.length) console.log(fails.join('\n'));
} catch (e) {
  console.error('探针异常: ' + (e?.stack || e));
  fails.push('PROBE EXCEPTION: ' + e.message);
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
}
process.exitCode = fails.length ? 1 : 0;
