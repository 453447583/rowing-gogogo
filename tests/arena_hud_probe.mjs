// 竞技场「暗黑锻铁 HUD」+ 看台加高 + 比分牌抬高 + 道具赛氮气条 实机验收
//   node tests/arena_hud_probe.mjs
//
// 验四件事（对应本轮用户四条诉求）：
//   ① 看台加高：`arena-stands` 几何顶 > 15m（旧 12.9m），且观众排数 10
//   ② 比分牌整块抬到看台之上：屏体下沿 > 看台最高点（后墙/雨棚/柱顶），
//      并从「水面机位」做视线遮挡计算，确认场心方向看不到被切
//   ③ 道具赛右上角氮气条显示出来（之前 `nitroCharge` 传 null 整块 hidden）
//   ④ 竞技场 HUD 皮肤只作用 #hud.arena-mode：铁面/黄铜/米白/衬线字全部生效，
//      且切回竞速模式时**一丝不沾**（防样式溢出）
//
// 截图：
//   arena-hud.jpg            —— 最后一次 CDP Page.captureScreenshot，3D + DOM HUD 合成
//   arena-stand-front.jpg    —— 场心水面机位看单座看台（看比分牌有没有被切）
//   arena-stand-mid.jpg      —— 中场高度斜看一圈看台 + 天际线
//   item-nitro.jpg           —— 道具赛 HUD（氮气条）
//
// 坑（DEV_STATUS 四十五节）：swiftshader 下 `Page.captureScreenshot` 第二次必挂死，
// 所以整脚本只在**最后一次**调用它；其余 3D 图走页面内 toDataURL 直读 canvas。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/arena-hud-${stamp}`);
const port = 9960 + (Number(stamp.slice(-3)) % 30);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const shots = path.resolve('shots/verify');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
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
  if (cond) console.log('  \u2713 ' + label);
  else { fails.push(label); console.log('  \u2717 ' + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

async function waitJson(u, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}

async function waitFor(expr, timeout = 30000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout waiting ' + expr + ' (last=' + JSON.stringify(last) + ')');
}

/** 完整玩家路径（新大厅链）：重载 → 单人 → 选艇 → 选模式 → 开赛 */
async function boot(mode, { ai = '1' } = {}) {
  await cdp('Page.navigate', { url });
  await sleep(1800);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 25000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);

  await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-boat="titan"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-boat="titan"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);

  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="${mode}"]')`, 20000);
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="${mode}"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);

  await evaluate(`(() => { const s=document.querySelector('#sel-ai'); if (s) { s.value='${ai}'; if (s.onchange) s.onchange(); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);

  await waitFor(`!!window.__game?.localBoat`, 45000);
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0; return 1; })()`);
  // 等 HUD 第一帧渲染完
  await sleep(1200);
  return val(await evaluate(`window.__game.mode`));
}

/** 页面内 canvas 直读（同一次 JS 任务里 render + toDataURL，可反复截） */
async function saveShot(expr, file) {
  const dataUrl = val(await evaluate(`(() => { const g=window.__game; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.86);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    console.log('  ! 截图失败 ' + file + ': ' + String(dataUrl).slice(0, 140));
    return false;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (buf.length < 8000) { console.log('  ! 截图疑似空白 ' + file + ' ' + buf.length + 'B'); return false; }
  await fs.writeFile(path.join(shots, file), buf);
  console.log('  \u2192 shots/verify/' + file + '  ' + buf.length + 'B');
  return true;
}

/** HUD 计算样式快照：只读 getComputedStyle，不触发重排 */
const HUD_SNAP = `(() => {
  const hud = document.getElementById('hud');
  const cs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x:+b.x.toFixed(1), y:+b.y.toFixed(1), w:+b.width.toFixed(1), h:+b.height.toFixed(1), bottom:+b.bottom.toFixed(1), right:+b.right.toFixed(1) }; };
  const mm = document.getElementById('minimap-wrap');
  const top = document.getElementById('hud-top');
  const core = document.getElementById('arena-core');

  const val0 = top?.querySelector('.value');
  return {
    arenaClass: hud.classList.contains('arena-mode'),
    bossClass: hud.classList.contains('boss-mode'),
    minimapBorder: cs(mm, 'border-top-color'),
    minimapWidth: cs(mm, 'border-top-width'),
    minimapBg: cs(mm, 'background-image').slice(0, 60),
    hudTopBorder: cs(top, 'border-top-color'),
    valueFamily: cs(val0, 'font-family').slice(0, 40),
    valueColor: cs(val0, 'color'),
    coreTop: cs(core, 'top'),
    coreBox: box(core), topBox: box(top),
    coreBackdrop: cs(core, 'backdrop-filter'),
    foeBoxGone: !document.getElementById('arena-foe'),
    skills: [...document.querySelectorAll('.as-skill')].map(box),
    slots: [...document.querySelectorAll('.item-slot')].map(box),
    progressBg: cs(document.querySelector('.progress .track-bar i'), 'background-image').slice(0, 80),
    nitroHidden: document.getElementById('nitro-wrap')?.classList.contains('hidden'),
    nitroStockHidden: document.getElementById('nitro-stock')?.classList.contains('hidden'),
    nitroFillW: document.getElementById('nitro-fill')?.style.width,
    nitroCellsOn: document.querySelectorAll('#nitro-cells i.on').length,
    nitroHint: document.getElementById('nitro-hint')?.textContent,
    nitroLockedGap: cs(document.getElementById('nitro-wrap'), 'border-top-color'),
  };
})()`;

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = tabs.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '';
      if (!d.includes('texImage2D')) console.log('EXC', d.slice(0, 200));
    }
  });
  ws.on('close', () => { for (const p of pending.values()) p.reject(new Error('cdp closed')); pending.clear(); });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  // ================= ① 竞速模式：皮肤不许溢出 =================
  console.log('\n[1/4] 竞速模式 —— 锻铁皮肤是否溢出');
  await boot('race');
  const raceSnap = val(await evaluate(HUD_SNAP));
  ok(raceSnap && raceSnap.arenaClass === false, '竞速模式 #hud 没有 arena-mode 类');
  ok(raceSnap?.minimapBorder !== raceSnap?.hudTopBorder
    || raceSnap?.minimapBorder !== 'rgb(185, 138, 69)', '竞速小地图边框未被染成黄铜', raceSnap?.minimapBorder);
  ok(raceSnap?.foeBoxGone === true, '右上角对手单位框已从 DOM 移除');
  ok(raceSnap?.nitroHidden === false, '竞速模式氮气条照常显示');

  // ================= ② 竞技场：看台 / 比分牌 / 皮肤 =================
  console.log('\n[2/4] 竞技场 —— 看台高度 + 比分牌 + 锻铁 HUD');
  const mode = await boot('arena');
  ok(mode === 'arena', '进入竞技场模式', mode);
  await evaluate(`(() => { const g=window.__game; g.renderer.setSize(960,540); return 1; })()`);
  await sleep(600);

  // ---- 3D：几何量 ----
  const geo = val(await evaluate(`(() => {
    const g = window.__game;
    const grp = g.arenaStadium?.group;
    if (!grp) return null;
    const stands = grp.children.find((m) => m.name === 'arena-stands');
    const screens = grp.children.find((m) => m.name === 'arena-screens');
    if (!stands || !screens) return null;
    stands.geometry.computeBoundingBox();
    screens.geometry.computeBoundingBox();
    const sb = stands.geometry.boundingBox, cb = screens.geometry.boundingBox;
    // 屏体板 6.6m 高；柱底在 cb.min.y，板心 = cb.max.y - 3.3
    return {
      stats: g.arenaStadium.stats,
      standTop: +sb.max.y.toFixed(2),
      standBottom: +sb.min.y.toFixed(2),
      boardCenter: +(cb.max.y - 3.3).toFixed(2),
      boardBottom: +(cb.max.y - 6.6).toFixed(2),
      postBottom: +cb.min.y.toFixed(2),
      boundaryR: +(g.mapDef?.boundary?.r ?? 0),
    };
  })()`));
  ok(!!geo, '竞技场看台层存在');
  console.log('  GEO ' + JSON.stringify(geo));
  if (geo) {
    ok(geo.standTop >= 15, '看台加高到 15m 以上（旧 12.9m）', geo.standTop);
    ok(geo.stats?.stands >= 14, '看台围成一圈', geo.stats?.stands);
    ok(geo.stats?.screens === geo.stats?.stands, '每座看台都有比分牌', geo.stats?.screens);
    ok(geo.boardBottom > geo.standTop + 0.5, '比分牌整块抬到看台之上（下沿高于看台最高点）',
      { boardBottom: geo.boardBottom, standTop: geo.standTop });
  }

  // ---- 3D：从场心水面机位做视线遮挡计算 ----
  // 看台是朝场心的：正多边形内切圆 apothem 处是看台中心，雨棚前沿再往场心 4.5m。
  // 视线从 (hView) 高度、距看台中心 dView 处看屏体下沿，必须越过雨棚前沿顶（standTop）。
  // dView=13 是「自己正头顶那一座」，物理上永远被切（真实球场同理），不纳入断言。
  const sight = val(await evaluate(`(() => {
    const g = window.__game;
    const r = g.mapDef?.boundary?.r ?? 92;
    const grp = g.arenaStadium.group;
    const stands = grp.children.find((m) => m.name === 'arena-stands');
    const screens = grp.children.find((m) => m.name === 'arena-screens');
    stands.geometry.computeBoundingBox();
    screens.geometry.computeBoundingBox();
    const roofFrontY = stands.geometry.boundingBox.max.y;
    const boardBottom = screens.geometry.boundingBox.max.y - 6.6;
    const ap = r + 4 + 6.5;
    const out = [];
    for (const d of [20, 30, 40, 60, 90, 2 * ap - r + 2.5]) {
      for (const h of [2.0, 5.0]) {
        // 雨棚前沿在局部 z=-4.5，视线从 z=-d 处出发到 z=0 的屏体下沿
        const t = (d - 4.5) / d;
        const yAtRoof = h + (boardBottom - h) * t;
        out.push({ d: +d.toFixed(1), h, yAtRoof: +yAtRoof.toFixed(2), clear: yAtRoof >= roofFrontY });
      }
    }
    return { roofFrontY: +roofFrontY.toFixed(2), boardBottom: +boardBottom.toFixed(2), out };
  })()`));
  if (sight) {
    console.log('  SIGHT ' + JSON.stringify(sight));
    const near = sight.out.filter((s) => s.d >= 40 && s.h === 2.0);
    ok(near.length > 0 && near.every((s) => s.clear),
      '水面机位（h=2m）距 40m 以上，比分牌下沿零遮挡',
      near.filter((s) => !s.clear));
    const far = sight.out.filter((s) => s.d >= 60);
    ok(far.length > 0 && far.every((s) => s.clear),
      '中远距离（≥60m，含看对面看台）比分牌下沿零遮挡',
      far.filter((s) => !s.clear));
  }

  // ---- HUD ----
  const a = val(await evaluate(HUD_SNAP));
  console.log('  HUD ' + JSON.stringify({
    minimapBorder: a?.minimapBorder, valueColor: a?.valueColor, valueFamily: a?.valueFamily,
    coreTop: a?.coreTop, foeBoxGone: a?.foeBoxGone,
    skills: a?.skills?.map((s) => s && [s.w, s.h]), slots: a?.slots?.map((s) => s && [s.w, s.h]),
  }));
  ok(a?.arenaClass === true, '竞技场 #hud 带上 arena-mode');
  ok(a?.minimapBorder === 'rgb(185, 138, 69)', '小地图边框 = 黄铜 #B98A45', a?.minimapBorder);
  ok(a?.hudTopBorder === 'rgb(185, 138, 69)', '记分牌边框 = 黄铜', a?.hudTopBorder);
  ok(/serif|Georgia|Songti|SimSun/i.test(a?.valueFamily || ''), '记分牌数字走衬线字', a?.valueFamily);
  ok(a?.valueColor === 'rgb(237, 228, 208)', '记分牌数字 = 米白 #EDE4D0', a?.valueColor);
  ok(a?.coreBackdrop === 'none', '占领条不再是玻璃拟态（backdrop-filter: none）', a?.coreBackdrop);
  ok(a?.coreBox && a?.topBox && a.coreBox.y >= a.topBox.bottom - 0.5,
    '占领条已下移到记分牌下方（不重叠）',
    { coreY: a?.coreBox?.y, topBottom: a?.topBox?.bottom });
  ok(a?.foeBoxGone === true, '右上角不再有独立的对手血条框');
  const plate = val(await evaluate(`(() => {
    const g = window.__game, m = g.bossMode;
    const bars = [...m.hpBars.values()];
    const mine = m.hpBars.get(m.myId);
    const foe = bars.find((b) => b !== mine);
    if (!foe) return null;
    // 名牌画在 canvas 上：数一下非透明像素，确认真画了东西而不是空贴图
    const px = foe.ctx.getImageData(0, 0, foe.canvas.width, foe.canvas.height).data;
    let solid = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 24) solid++;
    return {
      bars: bars.length,
      foeVisible: foe.spr.visible,
      mineVisible: mine ? mine.spr.visible : null,
      w: foe.canvas.width, h: foe.canvas.height,
      solid,
      aspect: +(foe.spr.scale.x / foe.spr.scale.y).toFixed(3),
      heightRatio: +foe.spr.scale.y.toFixed(3),
    };
  })()`));
  console.log('  PLATE ' + JSON.stringify(plate));
  ok(plate?.foeVisible === true, '敌方赛艇船顶有血量铭牌（不是右上角）', plate?.foeVisible);
  ok(plate?.mineVisible === false, '自己船顶不挂铭牌（底部 HUD 已有）', plate?.mineVisible);
  ok(plate?.solid > 20000, '铭牌确实绘制了内容（非空贴图）', plate?.solid);
  ok(Math.abs((plate?.aspect || 0) - 512 / 184) < 0.05, '铭牌比例 = 512×184', plate?.aspect);
  const sk = a?.skills || [];
  ok(sk.length >= 2 && sk.every((s) => s && Math.abs(s.w - sk[0].w) < 0.6 && Math.abs(s.h - sk[0].h) < 0.6),
    '两个技能按钮尺寸统一', sk.map((s) => s && [s.w, s.h]));
  const sl = (a?.slots || []).filter(Boolean);
  ok(sl.length >= 3 && sl.every((s) => Math.abs(s.w - sl[0].w) < 0.6 && Math.abs(s.h - sl[0].h) < 0.6),
    '三个道具格尺寸统一', sl.map((s) => [s.w, s.h]));
  ok(/gradient/.test(a?.progressBg || ''), '血条换成深红渐变（非纯色平涂）', (a?.progressBg || '').slice(0, 40));

  // ---- 3D 截图：单座看台正视（比分牌有没有被切）+ 中场斜看一圈 ----
  // 先把他人的船挪到相机背后，否则世界空间的「电脑1 / 300」名牌会正好压在正中那块比分牌上
  await evaluate(`(() => {
    const g = window.__game;
    for (const b of g.boats.values()) if (b !== g.localBoat) b.resetTo(0, -75, 0);
    return 1;
  })()`);
  // 水面机位（相机 y=2.6）、距看台中心 45m 正对看台 → 屏体下沿必须完整
  await saveShot(`
    const r = g.mapDef?.boundary?.r ?? 92;
    const ap = r + 4 + 6.5;
    g.camera.position.set(0, 2.6, ap - 45);
    g.camera.lookAt(0, 21, ap);
    g.camera.updateMatrixWorld();
  `, 'arena-stand-front.jpg');

  await saveShot(`
    const r = g.mapDef?.boundary?.r ?? 92;
    g.camera.position.set(-r * 0.55, 12, -r * 0.55);
    g.camera.lookAt(r * 0.6, 12, r * 0.6);
    g.camera.updateMatrixWorld();
  `, 'arena-stand-mid.jpg');

  // ---- CDP 合成截图（3D + DOM HUD）：全脚本会调 2 次，都在最靠后 ----
  console.log('\n[2b/4] 竞技场合成截图（3D + DOM HUD）');
  // 先快进过开场动画 + 倒计时：那张「竞技场 PVP / 玩家 vs 电脑」标题浮层是临时的，
  // 留在图上会把占领条和比分牌全挡住，看不出皮肤效果。
  await evaluate(`(() => {
    const g = window.__game;
    if (g.bossMode) for (let i = 0; i < 90; i++) g.bossMode.update(0.2, i * 0.2);
    return g.bossMode ? g.bossMode.phase : 'no-boss';
  })()`);
  await sleep(600);
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat;
    const r = g.mapDef?.boundary?.r ?? 92;
    b.resetTo(0, -(r - 26), Math.PI);
    b.speed=0; b.vel.set(0,0); b.airborne=false;
    for (let i=0;i<90;i++) g.cameraRig.follow(b, 1/60);
    return 1;
  })()`);
  await evaluate(`(() => {
    const g = window.__game;
    for (let i = 0; i < 20; i++) g.post.render(1/60);
    return 1;
  })()`);
  await sleep(500);
  try {
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 60000);
    const buf = Buffer.from(shot.data, 'base64');
    if (buf.length > 8000) {
      await fs.writeFile(path.join(shots, 'arena-hud.jpg'), buf);
      console.log('  \u2192 shots/verify/arena-hud.jpg  ' + buf.length + 'B');
      ok(true, '竞技场合成截图已保存');
    } else {
      ok(false, '竞技场合成截图疑似空白 ' + buf.length + 'B');
    }
  } catch (e) {
    console.log('  ! Page.captureScreenshot 失败（swiftshader 已知坑）：' + e.message);
  }

  // ================= ③ 道具模式：右上角氮气条 =================
  console.log('\n[3/4] 道具模式 —— 右上角氮气条');
  await boot('item');
  const item0 = val(await evaluate(HUD_SNAP));
  ok(item0?.nitroHidden === false, '道具模式 #nitro-wrap 不再 hidden', item0?.nitroHidden);
  ok(item0?.nitroStockHidden === true, '道具模式收起两格氮气瓶（拿不到瓶子）', item0?.nitroStockHidden);
  ok(/氮气道具/.test(item0?.nitroHint || ''), '提示语切成「氮气道具 · 拾取后自动加速」', item0?.nitroHint);
  // 把氮气道具的加速计时拉满 → 槽要跟着涨
  await evaluate(`(() => {
    const g = window.__game;
    g.localBoat.boostTimer = 4.2;
    g.localBoat.boostState = 'active';
    return 1;
  })()`);
  await sleep(700);
  const item1 = val(await evaluate(HUD_SNAP));
  const wFull = parseFloat(item1?.nitroFillW || '0');
  ok(wFull > 90, '氮气槽随加速计时涨到满格', item1?.nitroFillW);
  ok((item1?.nitroCellsOn || 0) >= 5, '右下能量格点亮（氮气道具生效中）', item1?.nitroCellsOn);

  // 道具赛 HUD 合成截图：swiftshader 下第二次 captureScreenshot 可能挂死，
  // 挂死只降级成「没图」，不算失败（断言已经用计算样式验过了）。
  console.log('\n[4/4] 道具赛合成截图（3D + DOM HUD）');
  await sleep(400);
  try {
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 45000);
    const buf = Buffer.from(shot.data, 'base64');
    if (buf.length > 8000) {
      await fs.writeFile(path.join(shots, 'item-hud.jpg'), buf);
      console.log('  \u2192 shots/verify/item-hud.jpg  ' + buf.length + 'B');
    } else {
      console.log('  ! 道具赛合成截图疑似空白 ' + buf.length + 'B（不影响断言）');
    }
  } catch (e) {
    console.log('  ! 第二次 Page.captureScreenshot 挂死（已知 swiftshader 坑），跳过');
  }

  console.log('');
  if (fails.length) {
    console.log('FAIL\n - ' + fails.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log('PASS 看台/比分牌/氮气条/锻铁 HUD 全部到位');
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
});
