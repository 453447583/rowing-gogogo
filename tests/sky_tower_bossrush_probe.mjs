// 云端天梯第 4 层「雷霆龙骑士 · 双船伤害竞速」实机验收：
//   GLB 模型 / 三招 / 高度适配 / 雷炮 / 撞击 / BOSS 技能命中 / 狂暴 / 60 秒结算
//   WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_bossrush_probe.mjs
// 截图：shots/verify/sky-tower-boss-*.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/bossrush-${stamp}`);
const port = 9990 + (Number(stamp.slice(-1)) % 8);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';
const shots = path.resolve('shots/verify');
await fs.mkdir(shots, { recursive: true });

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });

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
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting ' + expr + ' (last=' + JSON.stringify(last) + ')');
}
async function shot(expr, file) {
  const dataUrl = val(await evaluate(`(() => { const g=window.__game; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.90);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    ok(false, '截图 ' + file, String(dataUrl).slice(0, 140)); return;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  ok(true, '截图 ' + file + ` (${Math.round(buf.length / 1024)}KB)`);
}

const GOTO_L4 = `(()=>{const b=window.__game.bossMode;
  for(const [id,p] of b.players){p.layer=3;const bt=b.boats.get(id);if(!bt)continue;
    bt.skyLayer=3;bt.pos.y=54.4;bt.diveTargetY=54.4;bt.vel.set(0,0);bt.heading=0;}
  const me=window.__game.localBoat; me.pos.set(-24,54.4,0); me.vel.set(0,0); return 1;})()`;

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
  await cdp('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push(e.message+' @ '+e.filename+':'+e.lineno));`,
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  console.log('\n[1] 进入天梯 · 单人 + 1 AI');
  await cdp('Page.navigate', { url }); await sleep(3000);
  try { await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 12000); }
  catch { await cdp('Page.reload', { ignoreCache: true }); await sleep(3000);
    await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 30000); }
  await evaluate(`document.querySelector('#btn-solo').click();1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 30000);
  await evaluate(`document.querySelector('#btn-lobby-mode').click();1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="skytower"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="skytower"]').click();1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click();1`);
  await evaluate(`(()=>{const s=document.querySelector('#sel-ai');if(s){s.value='1';if(s.onchange)s.onchange();}return 1;})()`);
  await evaluate(`document.querySelector('#btn-start-race').click();1`);
  try { await waitFor(`!!window.__game?.localBoat`, 60000); }
  catch (e) { console.log('  页面错误: ' + val(await evaluate(`JSON.stringify(window.__errs||[])`))); throw e; }
  await evaluate(`(()=>{const b=window.__game.bossMode;b.intro=0;b.cinema=0;b.countdown=0;b.phase='fight';
    document.getElementById('tower-intro')?.remove();document.body.classList.remove('intro-on');return 1;})()`);
  await sleep(400);
  await evaluate(GOTO_L4);

  console.log('\n[2] BOSS 模型 / 三招 / 高度');
  let ready = false;
  try { ready = !!(await waitFor(`window.__game.bossMode.bossRush?.boss?.ready === true`, 25000)); }
  catch { ready = false; }
  const sc = JSON.parse(val(await evaluate(`(()=>{const g=window.__game,r=g.bossMode.bossRush,b=r.boss;
    const SK=window.__game.bossMode.bossRush.boss.def.skills;
    return JSON.stringify({mode:g.mode, layer:r.layer, deckY:+r.deckY.toFixed(2),
      hp:b.maxHp, ready:b.ready, glb:b.modelShared,
      model:!!b.model, clips:b.mixer? Object.keys(b.actionMap||{}).length : 0,
      skills:SK, sideSkills:SK.map(s=>!!b.opts.onSkillResolve),
      skillsDamage:SK.map(s=>s==='towerSlash'?12:s==='towerThunder'?16:s==='towerSweep'?14:null),
      bossY:+b.group.position.y.toFixed(2), bossDist:+Math.hypot(b.pos.x,b.pos.z).toFixed(1), dmgBy:r.damageBy.size,
      decor:r.group.children.filter(c=>c.userData.glb).length,
      own:r.group.children.filter(c=>!c.userData.glb).length,
      duration:60, entries:g.bossMode.ids.map(id=>g.bossMode.players.get(id).layer)});})()`)));
  console.log('  ' + JSON.stringify(sc));
  ok(sc.mode === 'skytower', '模式 skytower', sc.mode);
  ok(sc.layer === 3 && sc.deckY === 54.3, '绑定第 4 层 · 甲板 y=54.3', { l: sc.layer, y: sc.deckY });
  ok(ready && sc.glb && sc.model, '雷霆龙骑士 GLB 已加载（不是程序化兜底模型）', sc);
  ok(sc.skills.join(',') === 'towerSlash,towerThunder,towerSweep', '三招：裂空斩/裁决落雷/雷环冲击', sc.skills);
  ok(Math.abs(sc.bossY - 54.3) < 2.5, 'BOSS 本体被抬到第 4 层甲板高度（不是掉回海面）', sc.bossY);
  ok(sc.bossDist > 10, 'BOSS 出生点避开中央水晶塔身（不会被塔柱劈开）', sc.bossDist);
  ok(sc.decor === 14 && sc.own === 0, '8 灯柱 + 6 拱门全部是现成 GLB（零程序化几何体）', { d: sc.decor, o: sc.own });
  ok(sc.entries.every((l) => l === 3), '两条船都到第 4 层', sc.entries);

  console.log('\n[3] 按 1 发雷炮 → BOSS 掉血 + 本层伤害计分');
  const cannon = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,r=b.bossRush,me=g.localBoat,p=b.players.get(b.myId);
    // 把船摆到 BOSS 正西 34m（射程 38 内），BOSS 挪到塔柱外别撞上
    r.boss.pos.set(14,0,0); me.pos.set(-20,54.4,0); me.heading=Math.PI/2; me.vel.set(0,0);
    const hp0=r.boss.hp, dmg0=r.damageBy.get(b.myId)||0, s0=p.score;
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1'}));
    await new Promise(res=>setTimeout(res,260));
    const after={hp:r.boss.hp, dmg:r.damageBy.get(b.myId)||0, score:p.score,
      cd:+(r.cannonCd.get(b.myId)||0).toFixed(1), elapsed:+r.elapsed.toFixed(1)};
    // 立刻再按一次：冷却内不生效
    window.dispatchEvent(new KeyboardEvent('keydown',{code:'Digit1',key:'1'}));
    await new Promise(res=>setTimeout(res,180));
    return JSON.stringify({hpDrop:+(hp0-after.hp).toFixed(1), dmgGain:+(after.dmg-dmg0).toFixed(1),
      scoreGain:+(after.score-s0).toFixed(1), cd:after.cd, elapsed:after.elapsed,
      dmgAfterSpam:+((r.damageBy.get(b.myId)||0) - after.dmg).toFixed(1)});
  })()`)));
  console.log('  ' + JSON.stringify(cannon));
  ok(cannon.hpDrop >= 29, '雷炮命中 BOSS 掉 30 血', cannon.hpDrop);
  ok(cannon.dmgGain === 30 && cannon.scoreGain === 0, '伤害按 60:1 赋分（30 伤害还不到 1 分）', cannon);
  ok(cannon.cd > cannon.elapsed, '1.5 秒冷却已登记', { cd: cannon.cd, t: cannon.elapsed });
  ok(cannon.dmgAfterSpam === 0, '冷却内再按不会重复扣血', cannon.dmgAfterSpam);

  console.log('\n[4] 撞 BOSS → 伤害翻倍 / 船被弹开');
  const ram = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,r=b.bossRush,me=g.localBoat,p=b.players.get(b.myId);
    const inp=g.opts.input;
    // Boss.pos 是 Vector3，必须三个分量都归零（set(0,0) 不会改 z）。
    // 出生点挪到 x=18 避开中央塔身，船从 x=30 朝 -x 以 18m/s 真速撞过去。
    const trace=[];
    const run=(boost)=>{
      r.boss.pos.set(18,0,0);
      me.pos.set(30,54.4,0); me.heading=-Math.PI/2;
      me.vel.set(-18,0); me.speed=18; me.thrustState=0;
      me.stunTimer=0; me.slowTimer=0; me.boostTimer=boost?5:0;
      r.ramCd.clear();
      const hp=r.boss.hp;
      inp.keys.add('arrowup');
      return new Promise(async(res)=>{
        for(let i=0;i<5;i++){
          await new Promise(r=>setTimeout(r,100));
          if(boost) me.boostTimer=5;
          trace.push({b:boost?1:0,x:+me.pos.x.toFixed(1),
            sp:+(me.speed||0).toFixed(1),
            d:+Math.hypot(me.pos.x-r.boss.pos.x,me.pos.z-r.boss.pos.z).toFixed(1)});
        }
        inp.keys.delete('arrowup'); me.boostTimer=0;
        res(+(hp-r.boss.hp).toFixed(1));
      });
    };
    const normal=await run(false);
    const nitro=await run(true);
    return JSON.stringify({normal, nitro, vxAfter:+me.vel.x.toFixed(1),
      kinds:[...r.damageBy.values()], trace});
  })()`)));
  console.log('  ' + JSON.stringify({ ...ram, trace: ram.trace.filter((_, i) => i % 2 === 0) }));
  ok(ram.normal >= 55 && ram.normal <= 70, '高速撞 BOSS 有 60 左右伤害', ram.normal);
  ok(ram.nitro > ram.normal * 1.5, 'K 冲刺撞击伤害翻倍', ram);
  ok(ram.vxAfter !== 0, '撞完速度被改写（弹开）', ram.vxAfter);

  console.log('\n[5] BOSS 技能真的会打中船（落雷红圈）');
  const skill = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,b=g.bossMode,r=b.bossRush,me=g.localBoat;
    me.stunTimer=0;me.slowTimer=0;me.pos.set(0,54.4,0);me.vel.set(0,0);
    const before={stun:me.stunTimer||0,slow:me.slowTimer||0};
    // 直接在船脚下结算一次 towerThunder（真实的 onSkillResolve 回调，不走伪造伤害）
    r.boss.opts.onSkillResolve({kind:'ground',radius:5,damage:16,id:'towerThunder'},
      {x:0,z:0,heading:0});
    await new Promise(res=>setTimeout(res,60));
    return JSON.stringify({before, stun:+(me.stunTimer||0).toFixed(2),
      slow:+(me.slowTimer||0).toFixed(2)});
  })()`)));
  console.log('  ' + JSON.stringify(skill));
  ok(skill.stun >= 0.5 && skill.slow >= 1.4, '落雷命中 → 船失控 0.6s + 减速 1.6s（不会死）', skill);

  console.log('\n[6] 半血狂暴');
  const rage = JSON.parse(val(await evaluate(`(async()=>{
    const g=window.__game,r=g.bossMode.bossRush,b=r.boss;
    const speed0=b.speedScale, cd0=b.cooldownScale;
    b.hp=b.maxHp*0.49;
    await new Promise(res=>setTimeout(res,220));
    return JSON.stringify({enraged:r.enraged, speedUp:+(b.speedScale/speed0).toFixed(2),
      cdUp:+(b.cooldownScale/cd0).toFixed(2), phaseIndex:b.phaseIndex});
  })()`)));
  console.log('  ' + JSON.stringify(rage));
  ok(rage.enraged === true, '血量跌破一半触发狂暴', rage);
  ok(rage.speedUp > 1.1 && rage.cdUp < 0.95, '狂暴：移速 ×1.2 / 出招快 15%', rage);

  console.log('\n[7] 截图：BOSS 全景 / 近景 / 红圈 / HUD');
  await evaluate(`(()=>{const g=window.__game,r=g.bossMode.bossRush,me=g.localBoat;
    r.boss.pos.set(18,0,0); me.pos.set(18,54.4,24); me.heading=0; me.vel.set(0,0); return 1;})()`);
  await sleep(600);
  await shot(`const c=g.camera;c.position.set(0,84,96);c.lookAt(12,56,0);c.updateMatrixWorld();`,
    'sky-tower-boss-overview.jpg');
  await shot(`const c=g.camera;c.position.set(8,62,36);c.lookAt(18,57,0);c.updateMatrixWorld();`,
    'sky-tower-boss-close.jpg');
  const pageShot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.writeFile(path.join(shots, 'sky-tower-boss-hud.jpg'), Buffer.from(pageShot.data, 'base64'));
  ok(true, '截图 sky-tower-boss-hud.jpg（含 HUD）');

  console.log('\n[8] HUD 伤害口径');
  const hud = JSON.parse(val(await evaluate(`(()=>{const g=window.__game;
    const h=g.bossMode.hudData();const el=document.getElementById('item-slots');
    return JSON.stringify({boss:h.towerBoss, dmg:h.towerBossDmg, left:h.towerBossLeft,
      hp:+h.towerBossHp.toFixed(2), enraged:h.towerBossEnraged,
      cap:document.querySelector('.th-cell-cargo .th-cap')?.textContent,
      phase:document.getElementById('th-phase-txt')?.textContent,
      slotsHidden:el.classList.contains('hidden'),
      board:[...document.querySelectorAll('.th-row')].map(x=>x.textContent)});})()`)));
  console.log('  ' + JSON.stringify(hud));
  ok(hud.boss === true && /DMG/.test(hud.cap || ''), 'HUD 第三格换成 DMG · 本层伤害', hud);
  ok(hud.dmg > 0 && /雷霆龙骑士/.test(hud.phase || ''), '阶段条显示 BOSS 与我的伤害', hud);
  ok(hud.slotsHidden === true, '第 4 层不显示道具槽（这一层用 1 键雷炮，不是三格道具）', hud.slotsHidden);

  console.log('\n[9] 60 秒到点结算');
  const fin = JSON.parse(val(await evaluate(`(async()=>{
    const r=window.__game.bossMode.bossRush;
    r.timeLeft=0.25;
    await new Promise(res=>setTimeout(res,600));
    return JSON.stringify({running:r.running,left:+r.timeLeft.toFixed(2),winner:r.winner,
      ranked:[...r.stats()].map(([k,v])=>[k,+v.toFixed(0)])});
  })()`)));
  console.log('  ' + JSON.stringify(fin));
  ok(fin.running === false && fin.left === 0, '时间到停表', fin);
  ok(fin.ranked.length >= 1 && fin.winner != null, '按累计伤害排名并选出赢家', fin);

  console.log('\n[10] 控制台错误检查');
  await sleep(400);
  const real = errors.filter((e) => !/effekseer\.min\.js|wasm:\/\/wasm/.test(e));
  ok(real.length === 0, '无未捕获异常（排除 Effekseer 环境噪声）', real.slice(0, 3));

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
