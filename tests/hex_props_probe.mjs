// 海克斯「每关 2~3 件点缀道具 + 随机阵型」无头验收（2026-11-23）
//
//   node tests/hex_props_probe.mjs
//
// 不占用对话浏览器：自己起静态服务 + 无头 Edge（CDP），进海克斯第 1 关后检查：
//   ① 计划里的点缀道具全部建成（GLB 真的加载出网格，不是空气墙）
//   ② 本关阵型真的装配出来：实体/海草/尖刺/弹射台都进了各自的判定列表
//   ③ 漩涡阵只走水面着色器（6~7 个 uWhirls），不再出现浮在水面的独立漩涡模型
//   ④ 七个阵型逐个重建都不报错、都有贴图网格
//   ⑤ 弹射台压上去真的腾空（弹射器阵的核心玩法）
//   ⑥ 掩体遮挡：blocksLine 挡伤害、rayHitDistance 截断激光视觉
//   ⑦ 整局没有脚本异常打断（Effekseer/软光栅环境噪声不计）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hex-props-' + Date.now());
const portSeed = Date.now() % 400;
const port = 9800 + portSeed;
const httpPort = 5400 + portSeed;
const shotFile = path.resolve('.tmp_build/hex_props_stage.jpg');

const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch { /* */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来（先跑 npm run build）'); }
}
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,760',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
let failed = 0;
const errors = [];
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* */ }
    await wait(200);
  }
  if (!tabs) throw new Error('headless Edge did not come up');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl, { perMessageDeflate: false });
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
      const desc = m.params.exceptionDetails.exception?.description || '';
      errors.push(desc);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 40000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  await sleep(1200);
  let booted = false;
  for (let attempt = 0; attempt < 2 && !booted; attempt++) {
    try {
      await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 35000, 'btn-solo');
      booted = true;
    } catch (e) {
      if (attempt) throw e;
      try { await ev('location.reload()'); } catch { /* */ }
      await sleep(2000);
    }
  }
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector(\'#lobby-pick-body [data-mode="boss"][data-variant="hex"]\')', 30000, 'hex 模式卡');
  await ev('document.querySelector(\'#lobby-pick-body [data-mode="boss"][data-variant="hex"]\').click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.bossMode', 45000, 'bossMode');
  await ev('(function(){window.__game.bossMode.introT=99;return 1})()');
  await waitFor('window.__game.bossMode.phase === "countdown"', 30000, 'countdown');
  await ev('(function(){window.__game.bossMode.countdown=0.02;return 1})()');
  await waitFor('window.__game.bossMode.phase === "fight"', 30000, 'fight');

  // 等道具与阵型异步加载完（网络 + 贴图上传）
  await waitFor('(window.__game?.bossMode?.arena?.hexProps?.length || 0) >= 3', 25000, 'hexProps');
  try {
    await waitFor(`(function(){
      const a = window.__game.bossMode.arena;
      const f = window.__game.bossMode.hexEntry?.formation || 'reef';
      if (f === 'reef' || f === 'whirlpool') return true;
      const need = { kelp: 14, launcher: 6, wreck: 10, iceberg: 12, volcano: 13 }[f] || 4;
      if (f === 'kelp') return (a.formationParts || []).length >= need && (a.kelpZones || []).length >= 10;
      return (a.formationParts || []).length >= need;
    })()`, 30000, 'formationParts');
  } catch { /* 部件少就少，下面按实际数量断言 */ }
  await sleep(800);

  const collect = () => ev(`(function(){
    const g = window.__game, a = g.bossMode.arena;
    const count = (root) => {
      let meshes = 0, maps = 0;
      root?.traverse?.((o) => {
        if (!o.isMesh) return;
        meshes += 1;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        if (mats.some((m) => m && (m.map || m.normalMap))) maps += 1;
      });
      return { meshes, maps };
    };
    return JSON.stringify({
      stage: g.bossMode.stage,
      formation: g.bossMode.hexEntry?.formation || 'reef',
      plan: (g.bossMode.hexEntry?.props || []).map((p) => p.id),
      built: (a.hexProps || []).map((p) => {
        const target = p.topper ? p.model : (p.model || p.holder);
        return { id: p.spec.id, kind: p.kind, x: +(p.x || 0).toFixed(1), z: +(p.z || 0).toFixed(1), ...count(target), buoys: p.buoys?.length || 0 };
      }),
      solids: (a.solidProps || []).map((p) => p.spec.id),
      parts: (a.formationParts || []).map((p) => ({
        id: p.spec.id, kind: p.kind, ...count(p.model),
      })),
      whirl: (a.whirlpools || []).map((w) => ({ formation: !!w.formation, glb: !!w.holder, r: +w.r.toFixed(1) })),
      waterWhirl: g.water?.uniforms?.uWhirlCount?.value ?? -1,
      launchPads: (a.launchPads || []).length,
      kelpZones: (a.kelpZones || []).length,
      kelpBlades: (a.kelpZones || []).map((z) => z.blades || 0),
      spikeZones: (a.spikeZones || []).length,
      rocks: (a.rocks || []).length,
      frame: g.renderer?.info?.render?.frame || 0,
    });
  })()`);
  const state = JSON.parse(await collect());
  console.log('  运行时道具：', JSON.stringify(state));

  // 截图必须是"没有核心弹窗"的实战画面：把核心计时压到 0，让 update 自动选第一张
  await ev('(function(){const b=window.__game.bossMode;b.hexCoreTimer=0.01;return 1})()');
  await waitFor('window.__game.bossMode.hexCorePicked === true', 10000, 'hexCorePicked');
  await sleep(1800);
  // 相机先对准跳台（本关有的话），保证截图上能看清道具本体
  await ev(`(function(){
    const g = window.__game, a = g.bossMode.arena;
    const prop = (a.hexProps || []).find((p) => p.kind === 'ramp') || (a.launchPads || [])[0];
    const b = g.localBoat;
    if (prop) { b.pos.x = prop.x; b.pos.z = prop.z + 9; b.vel.x = 0; b.vel.y = 0; }
    return 1;
  })()`);
  await sleep(1200);
  fs.mkdirSync(path.dirname(shotFile), { recursive: true });
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));

  // 单元级验证弹射：跳台（点缀道具）或阵型弹射台都试一次。
  // 2026-11-23：接触后先进一段「爬台」（Y 轴抬到台面），再起跳，
  // 所以这里要连续步进 constrain 把爬台段跑完，不能只看第一帧。
  const ramp = await ev(`(function(){
    const g = window.__game, a = g.bossMode.arena;
    const prop = (a.hexProps || []).find((p) => p.kind === 'ramp') || (a.launchPads || [])[0];
    if (!prop) return null;
    const b = g.localBoat;
    b.pos.x = prop.x; b.pos.z = prop.z;
    b.pos.y = 0;
    // 故意从背面撞：以前会被方向判定拒绝，现在必须照样弹
    b.vel.x = -Math.sin(prop.ry) * 20; b.vel.y = -Math.cos(prop.ry) * 20;
    b.airborne = false; b.hexRampAt = 0; b.rampRide = null;
    a.constrain(b, 1 / 60);
    const ride = !!b.rampRide;
    const startY = b.pos.y;
    let peakY = startY;
    for (let i = 0; i < 30 && !b.airborne; i++) {
      a.constrain(b, 1 / 60);
      peakY = Math.max(peakY, b.pos.y);
    }
    return JSON.stringify({
      src: prop.kind || 'launch', ride,
      deckY: +(prop.deckY || 0).toFixed(2),
      rose: +(peakY - startY).toFixed(2),
      airborne: !!b.airborne, vy: +(b.vy || 0).toFixed(2),
    });
  })()`);
  const rampRes = ramp ? JSON.parse(ramp) : null;

  // 水面漩涡：直接写 uniform，确认 6~7 个中心真的进着色器（不建任何模型）
  const waterProbe = JSON.parse(await ev(`(function(){
    const g = window.__game;
    const list = [];
    for (let i = 0; i < 7; i++) list.push({ x: -60 + i * 20, z: (i % 2 ? 18 : -18), r: 8 + i * 0.3, spin: i % 2 ? -1 : 1 });
    g.water.setWhirlpools(list);
    const u = g.water.uniforms;
    const a = u.uWhirls.value[0], b = u.uWhirls.value[6];
    return JSON.stringify({
      count: u.uWhirlCount.value,
      first: [a.x, a.y, a.z, a.w],
      last: [b.x, b.y, b.z, b.w],
    });
  })()`));
  // 复位：真实关卡的漩涡阵才让水面着色器接管，其它阵型保持 0 个
  await ev(`(function(){
    const g = window.__game;
    const list = (g.bossMode.hexEntry?.formation === 'whirlpool') ? (g.bossMode.arena.whirlpools || []) : [];
    g.water.setWhirlpools(list);
    return 1;
  })()`);

  // 掩体遮挡：实体/浮岩挡在中间时 blocksLine 必须为真，rayHitDistance 必须提前截断
  const occl = JSON.parse(await ev(`(function(){
    const a = window.__game.bossMode.arena;
    const p = (a.solidProps || [])[0] || (a.rocks || [])[0];
    if (!p) return JSON.stringify({ none: true });
    const blocked = a.blocksLine(p.x - p.r * 3, p.z, p.x + p.r * 3, p.z, 0.2);
    const clear = a.blocksLine(p.x - p.r * 3, p.z + p.r * 6, p.x + p.r * 3, p.z + p.r * 6, 0.2);
    const hit = a.rayHitDistance(p.x - p.r * 3, p.z, 1, 0, p.r * 8);
    return JSON.stringify({ id: p.spec?.id || 'rock', blocked, clear, hit: +hit.toFixed(1), far: +(p.r * 8).toFixed(1) });
  })()`));

  // 逐个重建七个阵型：异步 GLB 加载完成后都要有网格，且各判定列表数量对得上
  const cycle = [];
  let padLaunch = null;
  // 每个阵型的计划部件数（与 planHexFormation 一致），等齐了再统计，避免异步 GLB 晚到导致少算
  const CYCLE_PARTS = { reef: 3, kelp: 14, launcher: 6, whirlpool: 0, wreck: 10, iceberg: 12, volcano: 13 };
  for (const id of ['reef', 'kelp', 'launcher', 'whirlpool', 'wreck', 'iceberg', 'volcano']) {
    await ev(`(function(){ window.__game.bossMode.arena.setFormation({ id: '${id}' }, 20261123, { tint: 0xffffff }); return 1; })()`);
    if (id === 'reef' || id === 'whirlpool') {
      await sleep(id === 'reef' ? 900 : 300);
    } else {
      try {
        await waitFor(`(window.__game.bossMode.arena.formationParts || []).length >= ${CYCLE_PARTS[id]}`, 25000, id + ' 阵型部件');
        // 海草堆还要等所有株数建完（parts 计数按堆走，堆内株数是同步拼的，这里只多等一拍）
        if (id === 'kelp') await waitFor('(window.__game.bossMode.arena.kelpZones || []).length >= 10', 20000, 'kelp 海草堆');
      } catch { /* 记录到下面统一报错 */ }
      await sleep(300);
    }
    // 弹射器阵：把船放到弹射台上，确认先爬台（Y 轴抬高）再真的被弹起来
    if (id === 'launcher') {
      const r = await ev(`(function(){
        const g = window.__game, a = g.bossMode.arena;
        const pad = (a.launchPads || [])[0];
        if (!pad) return null;
        const b = g.localBoat;
        b.pos.x = pad.x; b.pos.z = pad.z; b.pos.y = 0;
        // 从背面接近也一样要弹（旧版方向判定会拒绝）
        b.vel.x = -Math.sin(pad.ry) * 20; b.vel.y = -Math.cos(pad.ry) * 20;
        b.airborne = false; b.hexRampAt = 0; b.rampRide = null;
        a.constrain(b, 1 / 60);
        const ride = !!b.rampRide;
        let peakY = b.pos.y;
        for (let i = 0; i < 30 && !b.airborne; i++) {
          a.constrain(b, 1 / 60);
          peakY = Math.max(peakY, b.pos.y);
        }
        return JSON.stringify({
          ride, deckY: +(pad.deckY || 0).toFixed(2), rose: +peakY.toFixed(2),
          airborne: !!b.airborne, vy: +(b.vy || 0).toFixed(2),
        });
      })()`);
      padLaunch = r ? JSON.parse(r) : null;
    }
    cycle.push(JSON.parse(await ev(`(function(){
      const a = window.__game.bossMode.arena;
      let meshes = 0;
      for (const p of a.formationParts || []) p.model.traverse((o) => { if (o.isMesh) meshes += 1; });
      return JSON.stringify({
        id: '${id}',
        parts: (a.formationParts || []).length,
        meshes,
        whirl: (a.whirlpools || []).length,
        pads: (a.launchPads || []).length,
        kelp: (a.kelpZones || []).length,
        kelpBlades: (a.kelpZones || []).map((z) => z.blades || 0),
        spikes: (a.spikeZones || []).length,
      });
    })()`)));
  }
  console.log('  阵型重建：', JSON.stringify(cycle));

  const realFormation = state.formation;
  report(state.built.length >= 3 && state.built.length <= state.plan.length,
    `计划 ${state.plan.length} 件点缀道具，建成 ${state.built.length} 件（${state.plan.join('/')}）`);
  report(state.built.every((p) => p.meshes > 0), '每件点缀道具都真的加载出了网格，没有看不见的空气墙');
  const mapped = state.built.concat(state.parts).filter((p) => p.maps > 0).length;
  console.log(`  带贴图网格的部件：${mapped} 个（其余为顶点色/纯色 PBR 材质）`);
  const expectedSolids = state.built.filter((p) => p.kind === 'solid').length + state.parts.filter((p) => p.kind === 'solid').length;
  report(expectedSolids === state.solids.length,
    `实体掩体全部进避障/碰撞列表（${state.solids.join('/') || '本关无'}）`);
  // 本关阵型
  if (realFormation === 'whirlpool') {
    report(state.whirl.length >= 6 && state.whirl.length <= 7 && state.whirl.every((w) => w.formation && !w.glb),
      `漩涡阵：${state.whirl.length} 个漩涡全部由水面着色器生成，没有独立模型`);
    report(state.waterWhirl === state.whirl.length, `水面 uniform uWhirlCount=${state.waterWhirl} 与漩涡数一致`);
    report(state.parts.length === 0, '漩涡阵不摆实体部件');
  } else {
    report(state.whirl.every((w) => !w.formation), `非漩涡阵不再出现阵型漩涡（${state.whirl.length} 个）`);
    report(state.waterWhirl === 0, `水面着色器关闭漩涡（uWhirlCount=${state.waterWhirl}）`);
    if (realFormation === 'reef') {
      report(state.parts.length === 3 && state.rocks > 0,
        `礁石阵保留 ${state.rocks} 块浮岩 + 补 3 块礁石`);
    } else {
      report(state.parts.length >= 6 && state.parts.every((p) => p.meshes > 0),
        `本关阵型 ${realFormation} 建成 ${state.parts.length} 个带网格部件`);
      const kindSet = new Set(state.parts.map((p) => p.kind));
      if (realFormation === 'launcher') report(state.launchPads >= 6 && kindSet.has('launch'),
        `弹射器阵 ${state.launchPads} 个弹射台全部进触发列表`);
      if (realFormation === 'kelp') {
        const minBlades = Math.min(...state.kelpBlades);
        report(state.kelpZones >= 10 && minBlades >= 10 && kindSet.has('kelp'),
          `海草堆 ${state.kelpZones} 堆、每堆 ${minBlades}~${Math.max(...state.kelpBlades)} 株`);
      }
      if (realFormation === 'volcano') report(state.spikeZones === 3 && kindSet.has('spikes'),
        `火山柱阵 ${state.spikeZones} 片尖刺进双向掉血区`);
      if (realFormation === 'iceberg') {
        const ice = state.parts.filter((p) => p.id.startsWith('ice_'));
        report(ice.length === 12, '冰山阵 6 大 6 小冰山全部落位');
      }
    }
  }
  // 半隐身单元验证：调用 Boat.setStealth 后船体材质真的变半透明，松开后复原
  const stealth = JSON.parse(await ev(`(function(){
    const b = window.__game.localBoat;
    const opac = () => {
      const out = [];
      b.modelRoot?.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m) out.push(+m.opacity.toFixed(2));
      });
      return out;
    };
    b.setStealth(1);
    const hidden = opac();
    b.setStealth(0);
    const back = opac();
    return JSON.stringify({
      hiddenMin: hidden.length ? Math.min(...hidden) : -1,
      backMin: back.length ? Math.min(...back) : -1,
      count: hidden.length,
    });
  })()`));
  report(stealth.count > 0 && stealth.hiddenMin <= 0.5 && stealth.backMin >= 0.99,
    `海草半隐身：船体 ${stealth.count} 个材质透明度 ${stealth.hiddenMin}，退出后复原 ${stealth.backMin}`);
  // 七个阵型逐个重建
  for (const row of cycle) {
    if (row.id === 'whirlpool') {
      report(row.parts === 0 && row.meshes === 0, 'whirlpool 不摆实体部件');
    } else if (row.id === 'reef') {
      report(row.parts === 3 && row.meshes >= 3, `reef 阵型补 ${row.parts} 块礁石`);
    } else {
      report(row.parts >= 6 && row.meshes >= row.parts,
        `${row.id} 阵型重建出 ${row.parts} 个部件、${row.meshes} 个网格`);
    }
    if (row.id === 'whirlpool') report(row.whirl >= 6 && row.whirl <= 7, `whirlpool 重建出 ${row.whirl} 个水面漩涡`);
    else report(row.whirl === 0, `${row.id} 不产水面漩涡（${row.whirl}）`);
    if (row.id === 'launcher') report(row.pads >= 6, `launcher 触发台 ${row.pads} 个`);
    if (row.id === 'kelp') report(row.kelp >= 10 && Math.min(...row.kelpBlades) >= 10,
      `kelp 海草 ${row.kelp} 堆、每堆至少 ${Math.min(...row.kelpBlades)} 株`);
    if (row.id === 'volcano') report(row.spikes === 3, `volcano 尖刺区 ${row.spikes} 片`);
    if (row.id === 'iceberg') report(row.parts === 12, `iceberg ${row.parts} 块冰山`);
    if (row.id === 'wreck') report(row.parts === 10, `wreck ${row.parts} 件沉船/小船`);
  }
  // 弹射器阵的接触测试：背面进入 + 低速也必须先爬台再起跳
  report(padLaunch ? padLaunch.ride && padLaunch.rose > 0.5 && padLaunch.airborne && padLaunch.vy > 0 : false,
    padLaunch
      ? `launcher 背面接触：爬台 ${padLaunch.rose}m（台面 ${padLaunch.deckY}m）→ 腾空 vy=${padLaunch.vy}`
      : 'launcher 阵没抽到弹射台');
  // 漩涡阵单独截一张：抬到高空俯视整片场地，确认是"水面上的漏斗"而非浮在水上的独立模型
  const whirlInfo = JSON.parse(await ev(`(function(){
   try {
    const g = window.__game, a = g.bossMode.arena;
    a.setFormation({ id: 'whirlpool' }, 20261123, { tint: 0xffffff });
    g.water.setWhirlpools(a.whirlpools || []);
    const b = g.localBoat;
    b.pos.x = 0; b.pos.z = 38; b.vel.x = 0; b.vel.y = 0;
    // 相机接管：boss 模式走 follow/followLookAt，每帧都会覆盖机位，这里全部改成固定俯视
    const rig = g.cameraRig;
    const look = function() {
      this.camera.position.set(0, 34, 62);
      this.camera.lookAt(0, 0, -10);
    };
    rig.follow = look;
    rig.followLookAt = look;
    rig.snapTo = look;
    return JSON.stringify({
      whirl: (a.whirlpools || []).length,
      uniform: g.water.uniforms.uWhirlCount.value,
      spots: (a.whirlpools || []).map((w) => [+w.x.toFixed(0), +w.z.toFixed(0), +w.r.toFixed(1)]),
    });
   } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
  })()`));
  await sleep(1500);
  console.log('  漩涡位置：', JSON.stringify(whirlInfo));
  const whirlShot = path.resolve('.tmp_build/hex_whirlpool.jpg');
  const shot2 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(whirlShot, Buffer.from(shot2.data, 'base64'));
  console.log('  漩涡阵截图：' + whirlShot);

  // 海草堆单独截一张：船压在草丛里，确认草是成堆的、船进入后半隐身
  await ev(`(function(){ window.__game.bossMode.arena.setFormation({ id: 'kelp' }, 20261123, { tint: 0xffffff }); return 1; })()`);
  try {
    await waitFor('(window.__game.bossMode.arena.kelpZones || []).length >= 10', 25000, '截图海草堆');
  } catch { /* 下面会按实际数量报错 */ }
  const kelpInfo = JSON.parse(await ev(`(function(){
   try {
    const g = window.__game, a = g.bossMode.arena;
    const list = a.kelpZones || [];
    if (!list.length) return JSON.stringify({ error: 'no kelp zone' });
    // 挑离 BOSS 最远的一堆，避免截图被技能特效盖住
    const boss = g.bossMode.boss;
    const dist = (z) => boss ? Math.hypot(z.x - boss.pos.x, z.z - boss.pos.z) : 0;
    const z = list.slice().sort((p, q) => dist(q) - dist(p))[0];
    const b = g.localBoat;
    b.pos.x = z.x; b.pos.z = z.z; b.vel.x = 0; b.vel.y = 0;
    const rig = g.cameraRig;
    const look = function() {
      this.camera.position.set(z.x, 12, z.z + 20);
      this.camera.lookAt(z.x, 2.2, z.z);
    };
    rig.follow = look;
    rig.followLookAt = look;
    rig.snapTo = look;
    return JSON.stringify({ zones: list.length, x: +z.x.toFixed(1), z: +z.z.toFixed(1), r: +z.r.toFixed(1), blades: z.blades, bossDist: +dist(z).toFixed(0) });
   } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
  })()`));
  await sleep(1600);
  // 采样半隐身进度：进草后透明度应压到 0.45 附近
  const kelpStealth = JSON.parse(await ev(`(function(){
    const g = window.__game;
    const b = g.localBoat;
    const me = g.bossMode.players.get(g.bossMode.myId);
    const op = [];
    b.modelRoot?.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) op.push(+m.opacity.toFixed(2));
    });
    return JSON.stringify({ mix: +(me?.kelpMix ?? 0).toFixed(2), minOpacity: op.length ? Math.min(...op) : -1, inKelp: g.bossMode.arena.kelpZones.some((z) => Math.hypot(b.pos.x - z.x, b.pos.z - z.z) <= z.r) });
  })()`));
  const kelpShot = path.resolve('.tmp_build/hex_kelp.jpg');
  const shot3 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(kelpShot, Buffer.from(shot3.data, 'base64'));
  console.log('  海草堆截图：', JSON.stringify({ ...kelpInfo, ...kelpStealth }), '->', kelpShot);
  report(!kelpInfo.error && kelpStealth.inKelp && kelpStealth.mix > 0.8 && kelpStealth.minOpacity <= 0.55,
    `进草半隐身生效（kelpMix=${kelpStealth.mix} / 最低不透明度=${kelpStealth.minOpacity}）`);

  // 弹射台爬台段截图：把船钉在台面高度（rampRide 的 dur 拉长，速度归零），
  // 确认视觉上船是"停在台面上"，不是从台面中间穿过去。
  await ev(`(function(){ window.__game.bossMode.arena.setFormation({ id: 'launcher' }, 20261123, { tint: 0xffffff }); return 1; })()`);
  try {
    await waitFor('(window.__game.bossMode.arena.launchPads || []).length >= 6', 25000, '截图弹射台');
  } catch { /* 下面按实际数量报错 */ }
  const padInfo = JSON.parse(await ev(`(function(){
    const g = window.__game, a = g.bossMode.arena;
    const pads = a.launchPads || [];
    if (!pads.length) return JSON.stringify({ error: 'no pad' });
    const boss = g.bossMode.boss;
    const dist = (p) => boss ? Math.hypot(p.x - boss.pos.x, p.z - boss.pos.z) : 0;
    const pad = pads.slice().sort((p, q) => dist(q) - dist(p))[0];
    const b = g.localBoat;
    b.pos.x = pad.x; b.pos.z = pad.z; b.vel.set(0, 0); b.speed = 0;
    b.airborne = false; b.hexRampAt = 0;
    // t≈1 且 dur 极长 → 停在爬台终点（台面高度），用于定格截图
    b.rampRide = { t: 0.995, dur: 1000, fromY: 0, toY: pad.deckY || 1.1, vy: 12.5, boost: 0, dirX: Math.sin(pad.ry), dirZ: Math.cos(pad.ry), speed: 0 };
    const rig = g.cameraRig;
    const look = function() {
      this.camera.position.set(pad.x, 10, pad.z + 16);
      this.camera.lookAt(pad.x, 1.2, pad.z);
    };
    rig.follow = look; rig.followLookAt = look; rig.snapTo = look;
    return JSON.stringify({ pads: pads.length, x: +pad.x.toFixed(1), z: +pad.z.toFixed(1), deckY: +(pad.deckY || 0).toFixed(2) });
  })()`));
  await sleep(700);
  const padShot = path.resolve('.tmp_build/hex_launcher.jpg');
  const shot4 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  fs.writeFileSync(padShot, Buffer.from(shot4.data, 'base64'));
  const padY = await ev('(function(){ const b = window.__game.localBoat; return JSON.stringify({ y: +b.pos.y.toFixed(2), ride: !!b.rampRide }); })()');
  console.log('  弹射台截图：', padInfo, padY, '->', padShot);
  report(!padInfo.error && JSON.parse(padY).y > 0.8,
    `爬台定格在台面高度（y=${JSON.parse(padY).y} / 台面 ${padInfo.deckY}m）`);
  await ev('(function(){ window.__game.localBoat.rampRide = null; return 1; })()');

  // 复位成真实关卡阵型，避免探针把后面留下的自动行为带歪
  await ev(`(function(){
    const g = window.__game;
    const id = g.bossMode.hexEntry?.formation || 'reef';
    g.bossMode.arena.setFormation({ id }, 20261123, { tint: 0xffffff });
    g.water.setWhirlpools(id === 'whirlpool' ? (g.bossMode.arena.whirlpools || []) : []);
    return id;
  })()`);
  report(waterProbe.count === 7 && waterProbe.first[2] > 0 && waterProbe.last[2] > 0,
    `水面着色器可写入 7 个漩涡（首 ${JSON.stringify(waterProbe.first)} / 末 ${JSON.stringify(waterProbe.last)}）`);
  report(occl.none ? true : (occl.blocked && !occl.clear && occl.hit < occl.far),
    occl.none ? '场地上没有掩体，跳过遮挡检查' : `掩体挡视线（${occl.id}: blocked=${occl.blocked} / clear=${occl.clear} / 截断 ${occl.hit}m < ${occl.far}m）`);
  const launchRes = rampRes || padLaunch;
  report(launchRes ? launchRes.airborne && launchRes.vy > 0 && launchRes.ride && launchRes.rose > 0.5 : true,
    launchRes
      ? `${rampRes ? '背面压上跳台' : '背面压上阵型弹射台'}：先爬台 ${launchRes.rose}m（台面 ${launchRes.deckY}m）再腾空 vy=${launchRes.vy}`
      : '本关没抽到跳台/弹射台，跳过触发检查');
  report(state.frame > 0, `渲染在跑（frame=${state.frame}）`);
  const fatal = errors.filter((d) => !/texImage2D|getParameter of null|effekseer|WebGL2RenderingContext|context lost/i.test(d));
  report(fatal.length === 0, `没有脚本异常打断（红线 ${fatal.length} 条 / 环境噪声 ${errors.length} 条）`);
  if (fatal.length) console.log('  异常样本：', fatal.slice(0, 3).map((d) => d.split('\n')[0]));
  console.log('  截图：' + shotFile);
} catch (e) {
  failed += 1;
  console.error('探针异常：', e.message);
} finally {
  try { ws?.close(); } catch { /* */ }
  child.kill('SIGKILL');
  server.kill('SIGKILL');
}
console.log(failed ? `\n海克斯场景道具：${failed} 项失败` : '\n海克斯场景道具：全部通过');
process.exit(failed ? 1 : 0);
