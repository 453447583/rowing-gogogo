// 怪物模式「暗黑锻铁 HUD」实机验收
//   node tests/boss_hud_probe.mjs        （npm run test:boss:hud）
//
// 验四件事：
//   ① 皮肤只作用 #hud.boss-mode：切回竞速模式一丝不沾（防样式溢出）
//   ② BOSS 铭牌按参考图合成单行：[盾形徽章] 名字 | 分段血槽 | 阶段铜牌，
//      菱形刻度 5 → 4，血槽不再是原来的白色金属尖角（clip-path 已清掉）
//   ③ 小地图 / 玩家名牌 / 关卡时间 / 热量集气 / 道具三格 / 协同合击 / 氮气条
//      全部换成同一套锻铁材质（黄铜边框 + 米白衬线 + 深红血槽）
//   ④ 小地图赛道线转暖金（canvas 像素采样，不是"看着像"）
//
// 截图：boss-hud.jpg（3D + DOM HUD 合成）、boss-plate.jpg（铭牌特写，3D 忽略）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/boss-hud-${stamp}`);
const port = 9990 + (Number(stamp.slice(-3)) % 9);
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
async function waitFor(expr, timeout = 45000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

/** 完整玩家路径：重载 → 单人 → 选艇 → 选模式 → 开赛 */
async function boot(mode) {
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
  await evaluate(`(() => { const s=document.querySelector('#sel-ai'); if (s) { s.value='1'; if (s.onchange) s.onchange(); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 50000);
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0; return 1; })()`);
  await sleep(900);
  return val(await evaluate(`window.__game.mode`));
}

/** 快进开场过场 + 倒计时，落到真正的战斗帧（否则画面被过场压暗，看不清 HUD） */
async function toFight() {
  await evaluate(`(() => {
    const g = window.__game;
    if (g.bossMode) for (let i = 0; i < 120; i++) g.bossMode.update(0.2, i * 0.2);
    g.phase = 'racing'; g.countdownLeft = 0;
    return g.bossMode ? g.bossMode.phase : 'none';
  })()`);
  await sleep(900);
}

const SNAP = `(() => {
  const hud = document.getElementById('hud');
  const cs = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p) : null);
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      bottom: Math.round(b.bottom), right: Math.round(b.right) }; };
  const q = (s) => document.querySelector(s);
  const plate = q('#boss-hud .boss-top');
  const crest = q('#boss-hud .boss-crest');
  const barFrame = q('#boss-hud .boss-bar-frame');
  const name = q('#boss-hud .boss-name');
  const phase = q('#boss-hud #boss-phase');
  const mm = document.getElementById('minimap-wrap');
  return {
    vw: innerWidth, vh: innerHeight,
    bossMode: hud.classList.contains('boss-mode'),
    bossHudShown: !document.getElementById('boss-hud').classList.contains('hidden'),
    // 铁面贴图有没有真的被浏览器取回（只有 CSS 真引用了它才会有这条资源记录）
    ironTile: (() => {
      const rs = performance.getEntriesByType('resource').filter((r) => /boss-iron/.test(r.name));
      if (!rs.length) return 0;
      const r = rs[rs.length - 1];
      return Math.round(r.decodedBodySize || r.transferSize || 1);
    })(),
    // --- BOSS 铭牌 ---
    plate: {
      box: box(plate),
      border: cs(plate, 'border-top-color'),
      borderW: cs(plate, 'border-top-width'),
      bg: cs(plate, 'background-image').slice(0, 46),
      pos: cs(plate, 'position'),
    },
    sameRow: !!(barFrame && name && plate && plate.contains(barFrame)
      && Math.abs(box(barFrame).y - box(name).y) < 26),
    crest: crest ? {
      box: box(crest),
      clip: cs(crest, 'clip-path').slice(0, 40),
      bg: cs(crest, 'background-image').slice(0, 46),
      icon: document.getElementById('boss-icon')?.textContent,
    } : null,
    bossName: document.getElementById('boss-name')?.textContent,
    nameFont: cs(name, 'font-family')?.slice(0, 34),
    nameColor: cs(name, 'color'),
    barFrame: barFrame ? {
      box: box(barFrame),
      clip: cs(barFrame, 'clip-path'),
      filter: cs(barFrame, 'filter'),
      border: cs(barFrame, 'border-top-color'),
    } : null,
    hpFillBg: cs(document.querySelector('#boss-hud .boss-hp i'), 'background-image').slice(0, 70),
    diamonds: [...document.querySelectorAll('#boss-hud .boss-hp .dia')].map((d) => ({
      left: d.style.left, x: Math.round(d.getBoundingClientRect().x),
      w: Math.round(d.getBoundingClientRect().width),
    })),
    phaseBadge: phase ? {
      text: phase.textContent,
      border: cs(phase, 'border-top-color'),
      bg: cs(phase, 'background-image').slice(0, 46),
      radius: cs(phase, 'border-top-left-radius'),
    } : null,
    tips: (() => { const t = q('#boss-hud .boss-tips'); return t ? {
      box: box(t), bg: cs(t, 'background-image').slice(0, 46),
      border: cs(t, 'border-top-color'), font: cs(t, 'font-family').slice(0, 30),
    } : null; })(),
    // --- 小地图 ---
    minimap: {
      box: box(mm),
      border: cs(mm, 'border-top-color'),
      borderW: cs(mm, 'border-top-width'),
      // 铁面贴图是 background-image 的第二层，切片要够长才看得到 url(...)
      bg: cs(mm, 'background-image').slice(0, 260),
      label: document.getElementById('minimap-weather')?.textContent,
      labelFont: cs(document.getElementById('minimap-weather'), 'font-family').slice(0, 30),
      labelColor: cs(document.getElementById('minimap-weather'), 'color'),
      warmPx: (() => {
        const c = document.getElementById('minimap');
        const g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let gold = 0, teal = 0;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
          if (a < 40) continue;
          if (r > 170 && gg > 130 && b < 170) gold++;
          if (gg > 190 && b > 160 && r < 110) teal++;
        }
        return { gold, teal };
      })(),
    },
    // --- 玩家名牌 ---
    plSelf: (() => { const p = q('#player-list .pl-self'); return p ? {
      box: box(p), border: cs(p, 'border-top-color'), bg: cs(p, 'background-image').slice(0, 46),
      name: q('#player-list .pl-name')?.textContent,
      nameFont: cs(q('#player-list .pl-name'), 'font-family').slice(0, 30),
      hpBorder: cs(q('#player-list .pl-hp'), 'border-top-color'),
      hpFill: cs(q('#player-list .pl-hp i'), 'background-image').slice(0, 62),
      revive: q('#player-list .pl-revive')?.textContent?.trim(),
      reviveBg: cs(q('#player-list .pl-revive'), 'background-image').slice(0, 40),
    } : null; })(),
    // --- 关卡 / 时间 ---
    chips: [...document.querySelectorAll('#hud-top .hud-chip')].filter((c) => c.getBoundingClientRect().width > 0).map((c) => ({
      text: c.textContent.replace(/\\s+/g, ' ').trim(),
      box: box(c),
      border: cs(c, 'border-top-color'),
      bg: cs(c, 'background-image').slice(0, 40),
      font: cs(c.querySelector('.value'), 'font-family').slice(0, 26),
      // 定宽之后内容会不会溢出（挤出边框 / 被截掉）。
      // ⚠ 必须查 chip 自己：.chip-body 的 min-width 是 auto，不会缩小，
      //   而是把内容顶出父框——查它自己永远量不出来。
      overflow: c.scrollWidth > c.clientWidth + 1,
    })),
    // --- 热量 / 集气 ---
    skills: [...document.querySelectorAll('#skill-track .sk-slot')].map((s) => ({
      text: s.textContent.replace(/\\s+/g, ' ').trim(),
      box: box(s),
      border: cs(s, 'border-top-color'),
      keyBg: cs(s.querySelector('.sk-key'), 'background-image').slice(0, 34),
      keyBorder: cs(s.querySelector('.sk-key'), 'border-top-color'),
      barBorder: cs(s.querySelector('.sk-bar'), 'border-top-color'),
      fill: cs(s.querySelector('.sk-bar i'), 'background-image').slice(0, 52),
    })),
    // --- 道具三格 ---
    slots: [...document.querySelectorAll('.item-slot')].map((s) => ({
      box: box(s), border: cs(s, 'border-top-color'),
      // 钢面贴图在 background-image 第二层，切片要够长才看得到 url(...)
      bg: cs(s, 'background-image').slice(0, 200),
      keyBorder: cs(s.querySelector('.item-key'), 'border-top-color'),
      name: s.querySelector('.item-name')?.textContent,
    })),
    // --- 协同合击 / 氮气 ---
    combo: (() => { const c = q('#combo-bar'); return c ? {
      box: box(c), border: cs(c, 'border-top-color'), bg: cs(c, 'background-image').slice(0, 40),
      name: c.querySelector('.cb-name')?.textContent,
      pctColor: cs(c.querySelector('.cb-pct'), 'color'),
      meterBorder: cs(c.querySelector('.cb-meter'), 'border-top-color'),
    } : null; })(),
    nitro: (() => { const n = q('#nitro-wrap'); return n ? {
      box: box(n),
      pillBorder: cs(n.querySelector('.nitro-pill'), 'border-top-color'),
      fill: cs(n.querySelector('#nitro-fill'), 'background-image').slice(0, 46),
    } : null; })(),
    quality: (() => { const b = q('#quality-btn'); return b ? { box: box(b), border: cs(b, 'border-top-color') } : null; })(),
  };
})()`;

// 用户 2026-11-17 定稿的黄铜描边色 #B08A45（原 #B98A45 偏橙一档）
const BRASS = 'rgb(176, 138, 69)';
const PAPER = 'rgb(237, 228, 208)';

async function captcha(file) {
  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 }, 60000);
  const buf = Buffer.from(shot.data, 'base64');
  if (buf.length < 8000) { console.log('  ! 截图疑似空白 ' + file); return false; }
  await fs.writeFile(path.join(shots, file), buf);
  console.log('  \u2192 shots/verify/' + file + '  ' + buf.length + 'B');
  return true;
}

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
      if (!/texImage2D/.test(d)) console.log('EXC', d.slice(0, 200));
    }
  });
  ws.on('close', () => { for (const p of pending.values()) p.reject(new Error('cdp closed')); pending.clear(); });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  // ================= ① 竞速模式：皮肤不许溢出 =================
  console.log('\n[1/3] 竞速模式 —— 锻铁皮肤是否溢出');
  const raceMode = await boot('race');
  const r = val(await evaluate(SNAP));
  ok(raceMode === 'race', '进入竞速模式', raceMode);
  ok(r?.bossMode === false, '竞速模式 #hud 没有 boss-mode 类');
  ok(r?.minimap?.border !== BRASS, '竞速小地图边框未被染成黄铜', r?.minimap?.border);
  ok(r?.minimap?.warmPx?.teal > r?.minimap?.warmPx?.gold, '竞速小地图赛道线仍是青色',
    r?.minimap?.warmPx);
  ok(r?.bossHudShown === false, '竞速模式 #boss-hud 隐藏');

  // ================= ② 怪物模式 =================
  console.log('\n[2/3] 怪物模式 —— 锻铁 HUD');
  const bossMode = await boot('boss');
  ok(bossMode === 'boss', '进入怪物模式', bossMode);
  await evaluate(`(() => { const g=window.__game; g.renderer.setSize(960,540); return 1; })()`);
  await toFight();
  const s = val(await evaluate(SNAP));
  if (!s) throw new Error('快照取不到');
  console.log('  PLATE ' + JSON.stringify({
    plate: s.plate?.box, crest: s.crest?.box, bar: s.barFrame?.box,
    sameRow: s.sameRow, diamonds: s.diamonds?.length,
    name: s.bossName, phase: s.phaseBadge?.text,
  }));
  console.log('  MINIMAP ' + JSON.stringify({ border: s.minimap?.border, warm: s.minimap?.warmPx, label: s.minimap?.label }));

  ok(s.bossMode === true, '怪物模式 #hud 带上 boss-mode');
  ok(s.bossHudShown === true, '#boss-hud 已显示');

  // --- BOSS 铭牌 ---
  ok(s.plate?.border === BRASS && s.plate?.borderW === '2px', '铭牌黄铜 2px 包边',
    { border: s.plate?.border, w: s.plate?.borderW });
  ok(/linear-gradient/.test(s.plate?.bg || ''), '铭牌是实底锻铁渐变（不是镂空）', s.plate?.bg);
  ok(s.crest && s.crest.box && s.crest.box.w >= 36 && s.crest.box.h >= 40, '左端盾形徽章已建立',
    s.crest?.box);
  ok(/polygon/.test(s.crest?.clip || ''), '徽章是盾形（clip-path polygon）', s.crest?.clip);
  ok(!!s.crest?.icon, '徽章内保留 BOSS 图标', s.crest?.icon);
  ok(s.sameRow === true, '名字 / 血槽 / 阶段铜牌在同一行（单行铭牌）');
  ok(s.barFrame?.clip === 'none', '血槽不再是白色金属尖角（clip-path 已清）', s.barFrame?.clip);
  ok(s.barFrame?.border === BRASS, '血槽外框黄铜', s.barFrame?.border);
  ok(s.diamonds?.length === 4, '菱形刻度 = 4 个', s.diamonds?.length);
  ok(JSON.stringify(s.diamonds?.map((d) => d.left)) === JSON.stringify(['20%', '40%', '60%', '80%']),
    '菱形等分在 20/40/60/80%', s.diamonds?.map((d) => d.left));
  ok(s.phaseBadge?.border === BRASS, '阶段徽章黄铜边', s.phaseBadge?.border);
  ok(/serif|Georgia|Songti|SimSun/i.test(s.nameFont || ''), 'BOSS 名走衬线字', s.nameFont);
  ok(s.nameColor === PAPER, 'BOSS 名米白 #EDE4D0', s.nameColor);
  ok(/gradient/.test(s.tips?.bg || '') && s.tips?.border === BRASS, '操作提示行 = 窄锻铁条 + 黄铜细边',
    { bg: s.tips?.bg, border: s.tips?.border });

  // --- 小地图 ---
  ok(s.minimap?.border === BRASS, '小地图黄铜包边', s.minimap?.border);
  ok(s.minimap?.borderW === '2px', '小地图 2px 黄铜细边（框带主体走 inset 灰带）', s.minimap?.borderW);
  ok(/boss-iron/.test(s.minimap?.bg || ''), '小地图铺的是锻铁贴图（不再是纯色渐变）', s.minimap?.bg);
  ok(s.ironTile > 0, '锻铁贴图文件能加载（/ui/boss-iron.jpg）', s.ironTile);
  ok(/serif|Georgia|Songti|SimSun/i.test(s.minimap?.labelFont || ''), '地图名走衬线字', s.minimap?.labelFont);
  ok(s.minimap?.labelColor === 'rgb(227, 192, 122)', '地图名 = 黄铜高光 #E3C07A', s.minimap?.labelColor);
  ok((s.minimap?.warmPx?.gold || 0) > (s.minimap?.warmPx?.teal || 0) * 3 && s.minimap?.warmPx?.gold > 200,
    '赛道线已转暖金（canvas 像素采样：金 >> 青）', s.minimap?.warmPx);

  // --- 玩家名牌 ---
  ok(!!s.plSelf, '玩家名牌存在');
  ok(s.plSelf?.border === BRASS, '玩家名牌黄铜包边', s.plSelf?.border);
  ok(/linear-gradient/.test(s.plSelf?.bg || ''), '玩家名牌是实底锻铁面板', s.plSelf?.bg);
  ok(/serif|Georgia|Songti|SimSun/i.test(s.plSelf?.nameFont || ''), '玩家名走衬线字', s.plSelf?.nameFont);
  ok(s.plSelf?.hpBorder === BRASS, '玩家血槽黄铜边', s.plSelf?.hpBorder);
  ok(/122, 15, 30|199, 48, 63/.test(s.plSelf?.hpFill || ''), '玩家血槽 = 深红宝石渐变', s.plSelf?.hpFill);
  ok(/复活/.test(s.plSelf?.revive || ''), '「复活 ×N」保留', s.plSelf?.revive);

  // --- 关卡 / 时间 ---
  ok((s.chips?.length || 0) >= 2, '关卡 / 时间两块铭牌都在', s.chips?.length);
  ok(s.chips?.every((c) => c.border === BRASS), '两块都换成黄铜小铭牌', s.chips?.map((c) => c.border));
  ok(s.chips?.every((c) => /serif|Georgia|Songti|SimSun/i.test(c.font || '')), '铭牌文字走衬线',
    s.chips?.map((c) => c.font));
  ok(s.chips?.length >= 2 && s.chips.every((c) => Math.abs(c.box.w - s.chips[0].box.w) < 0.6),
    '关卡框与时间框等宽', s.chips?.map((c) => c.box.w));
  ok(s.chips?.every((c) => !c.overflow), '定宽后数字没被挤爆', s.chips?.map((c) => c.overflow));

  // --- 热量 / 集气 ---
  ok((s.skills?.length || 0) === 2, '热量 / 集气两槽都在', s.skills?.length);
  ok(s.skills?.every((k) => k.border === BRASS), '两槽黄铜包边', s.skills?.map((k) => k.border));
  ok(s.skills?.every((k) => k.keyBorder === BRASS && /gradient/.test(k.keyBg || '')), '键位 J / CTRL 是铜牌',
    s.skills?.map((k) => k.keyBg));
  ok(s.skills?.every((k) => k.barBorder === BRASS), '能量条黄铜刻度槽', s.skills?.map((k) => k.barBorder));

  // --- 道具三格 ---
  const sl = s.slots || [];
  ok(sl.length === 3, '道具三格存在', sl.length);
  ok(sl.every((x) => x.border === BRASS), '三格黄铜边框', sl.map((x) => x.border));
  ok(sl.every((x) => /boss-iron/.test(x.bg || '')), '三格铺的是钢面贴图（不再是皮革底）', sl.map((x) => x.bg));
  ok(sl.every((x) => Math.abs(x.box.w - sl[0].box.w) < 0.6 && Math.abs(x.box.h - sl[0].box.h) < 0.6),
    '三格尺寸统一', sl.map((x) => [x.box.w, x.box.h]));
  ok(sl.every((x) => x.keyBorder === BRASS), '键位 Q / E / 1 铜牌', sl.map((x) => x.keyBorder));

  // --- 协同合击 / 氮气 / 设置 ---
  ok(s.combo?.border === BRASS, '协同合击黄铜包边', s.combo?.border);
  ok(s.combo?.pctColor === 'rgb(227, 192, 122)', '协同百分比 = 黄铜高光（去青蓝）', s.combo?.pctColor);
  ok(s.combo?.meterBorder === BRASS, '协同进度槽黄铜边', s.combo?.meterBorder);
  ok(s.nitro?.pillBorder === BRASS, '氮气条黄铜包边', s.nitro?.pillBorder);
  ok(/176, 138, 69|227, 192, 122|138, 90, 28/.test(s.nitro?.fill || ''), '氮气填充转暖金', s.nitro?.fill);
  ok(s.quality?.border === BRASS, '设置按钮黄铜边', s.quality?.border);

  // --- 撞色检查：怪物 HUD 里不该再有青蓝 ---
  const cyan = val(await evaluate(`(() => {
    const bad = [];
    const probe = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const st = getComputedStyle(el);
      for (const p of ['border-top-color', 'color', 'background-color']) {
        const v = st.getPropertyValue(p);
        const m = /rgba?\\((\\d+), (\\d+), (\\d+)/.exec(v || '');
        if (!m) continue;
        const [rr, gg, bb] = [+m[1], +m[2], +m[3]];
        if (bb > 150 && bb > rr + 40 && gg > rr) bad.push(sel + ' ' + p + '=' + v);
      }
    };
    ['#minimap-wrap', '#minimap-weather', '#hud-top .hud-chip .value',
     '#skill-track .sk-slot', '#skill-track .sk-name', '#combo-bar',
     '#combo-bar .cb-pct', '#combo-bar .cb-hint', '.item-slot',
     '#boss-hud .boss-top', '#boss-hud .boss-name', '#hud.boss-mode #quality-btn'].forEach(probe);
    return bad;
  })()`));
  ok(Array.isArray(cyan) && cyan.length === 0, '怪物 HUD 内不再有青蓝色残留', cyan);

  // --- 截图 ---
  console.log('\n[3/3] 截图');
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat;
    if (b) { b.speed = 0; b.vel.set(0, 0); }
    for (let i = 0; i < 12; i++) g.post.render(1/60);
    return 1;
  })()`);
  await sleep(500);
  await captcha('boss-hud.jpg');
  // 铭牌特写（2 倍放大），肉眼核对盾形徽章 / 菱形刻度 / 铜牌细节
  try {
    const plate = s.plate?.box;
    if (plate) {
      const shot = await cdp('Page.captureScreenshot', {
        format: 'jpeg', quality: 92,
        clip: { x: plate.x - 14, y: plate.y - 10, width: plate.w + 28, height: 120, scale: 2 },
      }, 60000);
      const buf = Buffer.from(shot.data, 'base64');
      if (buf.length > 4000) {
        await fs.writeFile(path.join(shots, 'boss-plate.jpg'), buf);
        console.log('  \u2192 shots/verify/boss-plate.jpg  ' + buf.length + 'B');
      }
    }
  } catch (e) {
    console.log('  ! 铭牌特写失败（swiftshader 第二次截图已知坑）：' + e.message);
  }

  console.log('');
  if (fails.length) {
    console.log('FAIL\n - ' + fails.join('\n - '));
    process.exitCode = 1;
  } else {
    console.log('PASS 怪物模式锻铁 HUD 全部到位，且未污染其它模式');
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
});
