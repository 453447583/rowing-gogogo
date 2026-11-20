// 竞技场开场标题卡 + 敌船船顶血量铭牌 + 道具赛氮气空槽 实机验收
//   node tests/arena_intro_probe.mjs
//
// 验三件事（对应本轮用户三条诉求）：
//   ① 开场：正中央标题卡（背景模糊）+ 全部 HUD 收起 5 秒 → 镜头飞行 → 最后 3 秒 3-2-1
//      → 进战瞬间 HUD 才淡入
//   ② 竞技场对手血量不在右上角，而是贴在敌方赛艇船顶（世界空间 Sprite，锻铁样式）
//   ③ 道具赛右上角氮气条保留「空槽」外形（能看见格子，不再是一片空白）
//
// 截图：
//   arena-intro.jpg    —— CDP 合成（3D + 开场浮层，含背景模糊）
//   item-hud-frame.jpg —— CDP 合成（道具赛 HUD，看氮气空槽）
//   arena-foe-plate.jpg—— 页面内 toDataURL（敌船船顶铭牌）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/arena-intro-${stamp}`);
const port = 9990 + (Number(stamp.slice(-3)) % 9);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const shots = path.resolve('shots/verify');

const child = spawn(edge, [
  // 不加 --disable-gpu：软件光栅下每次 reload 都要重新编译一整套着色器，
  // 主线程会被锁住几十秒，[3/4] 的 boot() 就会像"页面没起来"一样超时
  '--headless=new', '--no-sandbox',
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

/** 完整玩家路径：重载 → 单人 → 选艇 → 选模式 → 开赛（不跳过开场） */
async function boot(mode, { ai = '1', query = '' } = {}) {
  await cdp('Page.navigate', { url: url + query });
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
  await sleep(1200);
  return val(await evaluate(`window.__game.mode`));
}

/** 页面内 canvas 直读（同一 JS 任务里 render + toDataURL，可反复截） */
async function saveShot(expr, file) {
  const dataUrl = val(await evaluate(`(() => { const g=window.__game; ${expr}
    g.post.render(1/60);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.88);
  })()`));
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) {
    console.log('  ! 截图失败 ' + file + ': ' + String(dataUrl).slice(0, 140));
    return false;
  }
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(path.join(shots, file), buf);
  console.log('  \u2192 shots/verify/' + file + '  ' + buf.length + 'B');
  return true;
}

/** CDP 合成截图（含 DOM）。swiftshader 下第二次有可能挂死，所以调用点都包 try */
async function captcha(file) {
  try {
    const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 }, 70000);
    await fs.writeFile(path.join(shots, file), Buffer.from(shot.data, 'base64'));
    console.log('  \u2192 shots/verify/' + file + '（CDP 合成）');
    return true;
  } catch (e) {
    console.log('  ! CDP 截图失败（swiftshader 已知坑）：' + e.message);
    return false;
  }
}

const INTRO_SNAP = `(() => {
  const el = document.getElementById('arena-intro');
  const hud = document.getElementById('hud');
  const cs = (e, p) => (e ? getComputedStyle(e).getPropertyValue(p) : null);
  return {
    exists: !!el,
    cls: el ? el.className : null,
    title: el?.querySelector('.ai-title')?.textContent,
    sub: el?.querySelector('.ai-sub')?.textContent,
    foot: el?.querySelector('.ai-foot')?.textContent,
    veilBlur: cs(el?.querySelector('.ai-veil'), 'backdrop-filter'),
    bodyIntro: document.body.classList.contains('intro-on'),
    hudOpacity: cs(hud, 'opacity'),
    hudPE: cs(hud, 'pointer-events'),
    countText: el?.querySelector('.ai-count')?.textContent || '',
    countDisplay: cs(el?.querySelector('.ai-count'), 'display'),
    intro: window.__game?.bossMode?.intro ?? null,
    cinema: window.__game?.bossMode?.cinema ?? null,
  };
})()`;

const NITRO_SNAP = `(() => {
  const w = document.getElementById('nitro-wrap');
  const pill = w?.querySelector('.nitro-pill');
  const cells = [...document.querySelectorAll('#nitro-cells i')];
  const cs = (e, p) => (e ? getComputedStyle(e).getPropertyValue(p) : null);
  return {
    hidden: w?.classList.contains('hidden'),
    locked: w?.classList.contains('locked'),
    stockHidden: document.getElementById('nitro-stock')?.classList.contains('hidden'),
    pillBorder: cs(pill, 'border-top-color'),
    pillBg: cs(pill, 'background-image').slice(0, 48),
    cellCount: cells.length,
    cellOpacity: cells.map((c) => cs(c, 'opacity')),
    cellOn: cells.map((c) => c.classList.contains('on')),
    cellBg: cs(cells[0], 'background-image').slice(0, 48),
    hint: document.getElementById('nitro-hint')?.textContent,
    box: (() => { const b = w?.getBoundingClientRect(); return b ? [Math.round(b.width), Math.round(b.height)] : null; })(),
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

  // ================= ① 竞技场开场标题卡 =================
  console.log('\n[1/4] 竞技场开场 —— 标题卡 + HUD 收起');
  await boot('arena');
  const s0 = val(await evaluate(INTRO_SNAP));
  console.log('  INTRO ' + JSON.stringify(s0));
  ok(s0?.exists === true, '开场浮层 #arena-intro 已挂到 DOM');
  ok(/^第\s*1\s*关[：:]潮汐运送$/.test(s0?.title || ''), '正中央大字 = 第 1 关：潮汐运送', s0?.title);
  ok(/潮汐核心/.test(s0?.sub || ''), '副标题 = 本关目标（推进潮汐核心）', s0?.sub);
  ok(/三局两胜/.test(s0?.foot || ''), '底部小字 = 潮汐竞技场 · 三局两胜', s0?.foot);
  ok(/blur\((?!0px)/.test(s0?.veilBlur || ''), '背景模糊层生效（backdrop-filter: blur）', s0?.veilBlur);
  ok(s0?.bodyIntro === true, 'body 挂上 intro-on');
  ok(s0?.hudOpacity === '0', '开场期间常驻 HUD 全透明', s0?.hudOpacity);
  ok(s0?.hudPE === 'none', '开场期间 HUD 不吃点击', s0?.hudPE);
  ok((s0?.intro ?? 0) > 0.5, '标题卡还在倒计时（5 秒段）', s0?.intro);
  // 开场期间 Esc 必须哑火（否则设置面板会盖在模糊遮罩下面）
  const esc0 = val(await evaluate(`(() => {
    const root = document.getElementById('settings-panel');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return {
      bodyIntro: document.body.classList.contains('intro-on'),
      open: root ? !root.classList.contains('hidden') : null,
    };
  })()`));
  console.log('  ESC ' + JSON.stringify(esc0));
  ok(esc0?.bodyIntro === true, '按 Esc 时确实还在开场', esc0?.bodyIntro);
  ok(esc0?.open === false, '开场期间按 Esc 不弹设置面板', esc0?.open);
  await captcha('arena-intro.jpg');

  // ---- 标题卡 → 镜头飞行段 ----
  await evaluate(`(() => { window.__game.bossMode.intro = 0.05; window.__game.bossMode.cinema = 6.9; return 1; })()`);
  await sleep(1200);
  const s1 = val(await evaluate(INTRO_SNAP));
  ok(/ai-out/.test(s1?.cls || ''), '标题卡结束进入淡出段（ai-out：模糊与大字淡掉）', s1?.cls);
  ok(s1?.bodyIntro === true, '镜头飞行期间 HUD 仍然收着', s1?.bodyIntro);

  // ---- 镜头最后 3 秒接 3-2-1 ----
  await evaluate(`(() => { window.__game.bossMode.cinema = 2.4; return 1; })()`);
  await sleep(1200);
  const s2 = val(await evaluate(INTRO_SNAP));
  console.log('  COUNT ' + JSON.stringify({ text: s2?.countText, display: s2?.countDisplay }));
  ok(s2?.countDisplay === 'flex' && /^[123]$/.test(s2?.countText || ''), '镜头末段出现大号倒数', s2?.countText);

  // ---- 进战：浮层撤掉、HUD 淡回来 ----
  await evaluate(`(() => { window.__game.bossMode.cinema = 0.01; return 1; })()`);
  await sleep(1800);
  const s3 = val(await evaluate(INTRO_SNAP));
  ok(s3?.bodyIntro === false, '进战后 body 摘掉 intro-on');
  // HUD 是 .45s 淡入过渡，无头 1~3fps 下"摘类"这一帧本身就可能晚到 1s，这里轮询等它淡完
  let hudOp = s3?.hudOpacity;
  for (let i = 0; i < 20 && hudOp !== '1'; i++) {
    await sleep(300);
    hudOp = val(await evaluate(`getComputedStyle(document.getElementById('hud')).opacity`));
  }
  ok(hudOp === '1', '进战后常驻 HUD 恢复不透明', hudOp);
  // 浮层是"先淡出、600ms 后再从 DOM 摘"，低帧率下这个 setTimeout 会晚到，轮询等一下
  let introGone = s3?.exists === false;
  for (let i = 0; i < 12 && !introGone; i++) {
    await sleep(300);
    introGone = val(await evaluate(`!document.getElementById('arena-intro')`)) === true;
  }
  ok(introGone, '开场浮层已从 DOM 摘除', { exists: !introGone });
  // 进战后 Esc 恢复正常：按一次开、再按一次关
  const esc1 = val(await evaluate(`(() => {
    const root = document.getElementById('settings-panel');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const open = root ? !root.classList.contains('hidden') : null;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const closed = root ? root.classList.contains('hidden') : null;
    return { open, closed };
  })()`));
  ok(esc1?.open === true, '进战后 Esc 能打开设置面板', esc1);
  ok(esc1?.closed === true, '再按一次 Esc 关掉设置面板', esc1);

  // ================= ② 敌船船顶血条 =================
  console.log('\n[2/4] 竞技场 —— 对手血量挂在敌方赛艇上方');
  const gone = val(await evaluate(`(() => !document.getElementById('arena-foe'))()`));
  ok(gone === true, '右上角对手血条框已彻底移除');
  const plate = val(await evaluate(`(() => {
    const g = window.__game, m = g.bossMode;
    const me = g.localBoat;
    const foe = [...g.boats.values()].find((b) => b !== me);
    m.phase = 'countdown'; m.countdown = 999; m.cinema = 0; m.intro = 0;
    me.resetTo(0, -18, 0); me.speed = 0; me.vel.set(0, 0); me.airborne = false;
    foe.resetTo(0, 8, 0); foe.speed = 0; foe.vel.set(0, 0); foe.airborne = false;
    // 自己跑一帧，让名牌把位置/尺寸算出来
    m.update(1 / 60, 0.016);
    const bars = [...m.hpBars.values()];
    const mine = m.hpBars.get(m.myId);
    const f = bars.find((b) => b !== mine);
    if (!f) return null;
    const px = f.ctx.getImageData(0, 0, f.canvas.width, f.canvas.height).data;
    let solid = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 24) solid++;
    return {
      bars: bars.length,
      foeVisible: f.spr.visible,
      mineVisible: mine ? mine.spr.visible : null,
      w: f.canvas.width, h: f.canvas.height,
      solid,
      aspect: +(f.spr.scale.x / f.spr.scale.y).toFixed(3),
      pos: [+f.spr.position.x.toFixed(1), +f.spr.position.y.toFixed(2), +f.spr.position.z.toFixed(1)],
      foeZ: +foe.pos.z.toFixed(1),
    };
  })()`));
  console.log('  PLATE ' + JSON.stringify(plate));
  ok(plate?.foeVisible === true, '敌方赛艇船顶有血量铭牌', plate?.foeVisible);
  ok(plate?.mineVisible === false, '自己船顶不挂铭牌', plate?.mineVisible);
  ok(plate?.solid > 20000, '铭牌确实画了东西（非空贴图）', plate?.solid);
  ok(Math.abs((plate?.aspect || 0) - 512 / 184) < 0.06, '铭牌比例 512×184', plate?.aspect);
  ok(Math.abs((plate?.pos?.[2] ?? 99) - (plate?.foeZ ?? 0)) < 0.6, '铭牌跟敌船同一平面（贴在船顶正上方）',
    { plateZ: plate?.pos?.[2], foeZ: plate?.foeZ });
  ok((plate?.pos?.[1] ?? 0) > 3, '铭牌在船顶之上（y > 3m）', plate?.pos?.[1]);

  // 距离衰减：纯恒定屏占会让 70m 外的牌子按线性放大（h ∝ d），
  // 这里量 20m / 80m 两档，要求远端的世界高度增长明显慢于线性。
  const shrink = val(await evaluate(`(() => {
    const g = window.__game, m = g.bossMode, cam = g.camera;
    const me = g.localBoat;
    const foe = [...g.boats.values()].find((b) => b !== me);
    const mine = m.hpBars.get(m.myId);
    const f = [...m.hpBars.values()].find((b) => b !== mine);
    if (!f || !cam.isPerspectiveCamera) return null;
    m.phase = 'countdown'; m.countdown = 999; m.cinema = 0; m.intro = 0;
    const at = (dist) => {
      cam.position.set(foe.pos.x, 4.6, foe.pos.z - dist);
      cam.updateMatrixWorld();
      m.update(1 / 60, 0.016);
      const dy = cam.position.y - ((foe.pos.y || 0) + 3.3);
      const d = Math.hypot(cam.position.x - foe.pos.x, dy, cam.position.z - foe.pos.z);
      const viewH = 2 * d * Math.tan(cam.fov * Math.PI / 360);
      return { d: +d.toFixed(1), h: +f.spr.scale.y.toFixed(4), screen: +(f.spr.scale.y / viewH).toFixed(4) };
    };
    return { near: at(20), far: at(80) };
  })()`));
  console.log('  SHRINK ' + JSON.stringify(shrink));
  const n = shrink?.near, fr = shrink?.far;
  ok(!!n && !!fr, '远近两档都能量到铭牌尺寸', shrink);
  if (n && fr) {
    ok(Math.abs(n.screen - 0.078) < 0.012, '近距（20m）屏占 ≈ 7.8%', n.screen);
    ok(fr.screen < n.screen * 0.8, '远距铭牌屏占明显收小', { near: n.screen, far: fr.screen });
    ok(fr.h / n.h < 3.2, '世界尺寸增长慢于线性（无衰减时 ≈ 4.0）', +(fr.h / n.h).toFixed(2));
  }

  // 贴图原图直出（512×184），用来肉眼检查锻铁质感/铆钉/菱形刻度
  const texUrl = val(await evaluate(`(() => {
    const g = window.__game, m = g.bossMode;
    const mine = m.hpBars.get(m.myId);
    const f = [...m.hpBars.values()].find((b) => b !== mine);
    return f ? f.canvas.toDataURL('image/png') : '';
  })()`));
  if (typeof texUrl === 'string' && texUrl.startsWith('data:image')) {
    await fs.writeFile(path.join(shots, 'arena-foe-plate-tex.png'),
      Buffer.from(texUrl.slice(texUrl.indexOf(',') + 1), 'base64'));
    console.log('  \u2192 shots/verify/arena-foe-plate-tex.png（铭牌贴图原图）');
  }

  // ================= ③ 道具赛氮气空槽 =================
  console.log('\n[3/4] 道具赛 —— 右上角氮气条（空槽也要看得见）');
  await boot('item');
  const n0 = val(await evaluate(NITRO_SNAP));
  console.log('  NITRO ' + JSON.stringify(n0));
  ok(n0?.hidden === false, '道具赛 #nitro-wrap 不隐藏', n0?.hidden);
  ok(n0?.locked === true, '道具赛给氮气条打上 locked（不可集气）', n0?.locked);
  ok(n0?.stockHidden === true, '氮气瓶两格收起（道具赛拿不到）', n0?.stockHidden);
  ok(/197, 150, 79|185, 138, 69/.test(n0?.pillBorder || ''), '空槽边框 = 黄铜', n0?.pillBorder);
  ok((n0?.cellCount || 0) === 6, '六格能量格都在 DOM 里', n0?.cellCount);
  ok((n0?.cellOpacity || []).every((o) => Number(o) >= 0.9), '空格子不再是 0.12 隐形透明',
    n0?.cellOpacity);
  ok(/gradient/.test(n0?.cellBg || ''), '空格子有暗铁渐变底（不是纯黑）', n0?.cellBg);
  ok((n0?.box?.[0] || 0) > 120 && (n0?.box?.[1] || 0) > 20, '氮气条有实体尺寸', n0?.box);
  await captcha('item-hud-frame.jpg');

  // ---- 拾到氮气道具后仍然会点亮 ----
  await evaluate(`(() => { const b = window.__game.localBoat; b.boostTimer = 4.2; b.boostState = 'active'; return 1; })()`);
  await sleep(900);
  const n1 = val(await evaluate(NITRO_SNAP));
  // 点亮靠 .on 类（底色换成橙红渐变、加外发光），不是靠不透明度 ——
  // 空格子被 locked 规则钉成 opacity:1 了，拿透明度当判据会误判
  const lit = (n1?.cellOn || []).filter(Boolean).length;
  ok(lit >= 3, '氮气道具生效时格子照常点亮', lit);
  ok(/255, 196, 106|255, 90, 26/.test(n1?.cellBg || ''), '点亮格子是橙红渐变（locked 暗铁底让位）', n1?.cellBg);

  // ================= ④ 防溢出 =================
  console.log('\n[4/4] 竞速模式 —— 开场/氮气改动不许溢出');
  await boot('race');
  const r0 = val(await evaluate(`(() => ({
    intro: !!document.getElementById('arena-intro'),
    introOn: document.body.classList.contains('intro-on'),
    hudOpacity: getComputedStyle(document.getElementById('hud')).opacity,
    locked: document.getElementById('nitro-wrap')?.classList.contains('locked'),
    stockHidden: document.getElementById('nitro-stock')?.classList.contains('hidden'),
    hint: document.getElementById('nitro-hint')?.textContent,
  }))()`));
  console.log('  RACE ' + JSON.stringify(r0));
  ok(r0?.intro === false, '竞速模式没有开场浮层');
  ok(r0?.introOn === false, '竞速模式 body 没有 intro-on');
  ok(r0?.hudOpacity === '1', '竞速模式 HUD 正常显示', r0?.hudOpacity);
  ok(r0?.locked === false, '竞速模式氮气条没有 locked（仍可集气）', r0?.locked);
  ok(/集气/.test(r0?.hint || ''), '竞速模式提示语仍是「集气」', r0?.hint);

  // ================= ⑤ 3D 合成图（放在最后：CDP 截图之后软光栅极易挂死） =================
  console.log('\n[5/5] 3D 合成截图 —— 敌船船顶铭牌');
  try {
    await boot('arena', { query: '?arenaCinema=0' });
    const shown = await saveShot(`
      const m = g.bossMode;
      m.phase = 'countdown'; m.countdown = 999;
      const me = g.localBoat;
      const foe = [...g.boats.values()].find((b) => b !== me);
      me.resetTo(0, -14, 0); me.speed = 0; me.vel.set(0, 0);
      foe.resetTo(0, 12, 0); foe.speed = 0; foe.vel.set(0, 0);
      m.update(1 / 60, 0.016);
      g.cameraRig.follow = () => {};
      g.camera.position.set(0, 4.6, -22);
      g.camera.lookAt(0, 4.6, 12);
      g.camera.updateMatrixWorld();
    `, 'arena-foe-plate.jpg');
    if (!shown) console.log('  ! 3D 合成图没取到（不影响断言）');
  } catch (e) {
    console.log('  ! 3D 合成图失败（软光栅已知坑）：' + e.message);
  }

  console.log('\n' + (fails.length ? `FAIL ${fails.length} 项：\n  - ` + fails.join('\n  - ') : 'PASS 全部通过'));
  try { ws.close(); } catch {}
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]); } catch {}
  process.exit(fails.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e.message);
  try { ws?.close(); } catch {}
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)]); } catch {}
  process.exit(1);
});
