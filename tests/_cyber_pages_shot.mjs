// 赛博终端数据页验收（一次性）：过场 / 阵亡 / 通关 / 阶段结算 / 无尽选择
//   node tests/_cyber_pages_shot.mjs   （需 dev server 5199）
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cyber-' + Date.now());
const port = 9760 + Math.floor(Math.random() * 30);
const base = process.env.CYBER_BASE || 'http://127.0.0.1:5199/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 90000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
  return r?.result?.value;
};
async function waitJson(u, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('timeout ' + u);
}
async function shot(file) {
  const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 }, 60000);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  console.log('  → ' + file);
}

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base });

  const ready = await ev(`(async () => {
    for (let i = 0; i < 160; i++) {
      try { const m = await import('/src/ui/ui.js'); if (m.showBossEnd) { window.__ui = m; return true; } } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })()`);
  if (!ready) throw new Error('UI 模块不可用');

  // 面板原本挂在 HUD 里（菜单时整块隐藏），这里搬到 body 上按视口定位再截图
  const mounted = await ev(`(() => {
    window.__mountPanels = function () {
      const full = ['boss-end', 'boss-cutscene'];
      const center = ['boss-result', 'hex-endless'];
      for (const id of [...full, ...center]) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.parentElement !== document.body) document.body.appendChild(el);
        el.style.position = 'fixed';
        el.style.zIndex = '9000';
        // 新样式自带 left/top 居中，不能再塞 inset:0（会把 transform 偏移叠成负坐标）
      }
    };
    window.__mountPanels();
    for (const id of ['boss-end', 'boss-cutscene', 'boss-result', 'hex-endless']) {
      document.getElementById(id)?.classList.add('hidden');
    }
    return 'ok';
  })()`);
  console.log('  mount:', mounted);
  await sleep(2600);

  const HEX = `{
    seed: 3262759842,
    coreId: 'steel',
    entry: { rules: ['venom','ironwall'], hazards: [{id:'thunder'},{id:'boxes'},{id:'heal'}],
      combos: [{label:'裂空真击 → 焚风灼膛'}], danger: 3 },
    prefix: { name:'冰封的', icon:'hex/frostPrefix.png', desc:'每次受击附带 2 秒减速' },
    variant: { name:'深渊·焚寂龙', icon:'hex/abyssInferno.png', desc:'伤害 +15% · 冷却 -10%' },
    arena: { name:'漩涡深渊', icon:'hex/maelstrom.png', desc:'船速 -7%，龙卷追人' },
    relics: [{ id:'star', name:'星辰罗盘', icon:'hex/starCompass.png', desc:'全队伤害 +6%' }],
    anchors: 1,
    boats: [{ name:'ok没问题', boatId:'falcon', me:true }],
    cards: [{ id:'neptune', name:'海神庇佑', icon:'hex/neptune.png', rarity:'gold' },
            { id:'pierce', name:'穿甲弹头', icon:'hex/pierce.png', rarity:'white' }],
    stages: [{ stage:1, bossName:'深渊火龙', rules:[{name:'瘴气',icon:'hex/venom.png',negative:true}],
      hazards:[{name:'静电场',icon:'hex/shockFeedback.png'}], prefix:null, arena:null, relic:null }]
  }`;

  // ① 过场简报
  await ev(`(async () => { window.__mountPanels?.(); const u = await import('/src/ui/ui.js'); u.showBossEnd(null); u.showBossStageResult(null); u.showHexEndless(null);
    u.showBossCutscene({
      boss: { id:'dragon_inferno', name:'炎狱火龙', icon:'🔥', intro:'余烬未熄，第二头火龙自火焰中踏出。' },
      stage: 2, total: 4, layer: true,
      level: { weather:'blizzard', name:'锈蚀港口' },
      weatherLabel: '锈蚀港口 · 暴风雪',
      hex: ${HEX},
    }); return 1; })()`);
  await sleep(700);
  await shot('shots/verify/cyber-cutscene.jpg');

  // ② 阵亡全屏
  await ev(`(async () => { window.__mountPanels?.(); const u = await import('/src/ui/ui.js'); u.showBossCutscene(null);
    u.showBossEnd({
      victory: false, stage: 5, layer: true, totalTime: 125.5, gradeWhenLost: 'C',
      damage: [{ name:'ok没问题', dmg:3615, me:true }],
      taken: [{ name:'ok没问题', taken:240, me:true }],
      takenBy: [{ source:'双拳磋海', dmg:138 },{ source:'近身反制', dmg:72 },
                { source:'深渊咆哮', dmg:18 },{ source:'回身横扫', dmg:12 }],
      hex: ${HEX},
    }); return 1; })()`);
  await sleep(700);
  await shot('shots/verify/cyber-end-defeat.jpg');

  // ③ 通关全屏（3 人数据，验证列宽）
  await ev(`(async () => { window.__mountPanels?.(); const u = await import('/src/ui/ui.js');
    u.showBossEnd({
      victory: true, grade: 'S', totalTime: 632.4, endlessStage: 4,
      damage: [{ name:'ok没问题', dmg:18642, me:true },{ name:'浪里白条', dmg:15220 },{ name:'东海一哥', dmg:9871 }],
      taken: [{ name:'ok没问题', taken:4210, me:true },{ name:'浪里白条', taken:6380 },{ name:'东海一哥', taken:5120 }],
      takenBy: [{ source:'熔岩海啸', dmg:2400 },{ source:'近身反制', dmg:1180 },{ source:'深渊咆哮', dmg:960 }],
      hex: ${HEX},
    }); return 1; })()`);
  await sleep(700);
  await shot('shots/verify/cyber-end-victory.jpg');

  // ④ 阶段结算
  await ev(`(async () => { window.__mountPanels?.(); const u = await import('/src/ui/ui.js'); u.showBossEnd(null);
    u.showBossStageResult({ stage:2, layer:false, grade:'A', elapsed:75.5,
      damage: [{ name:'ok没问题', dmg:5210, me:true },{ name:'浪里白条', dmg:4300 }],
      taken: [{ name:'ok没问题', taken:1280, me:true },{ name:'浪里白条', taken:960 }],
      takenBy: [{ source:'静电场', dmg:620 },{ source:'落石雨', dmg:410 }] }); return 1; })()`);
  await sleep(600);
  await shot('shots/verify/cyber-stage-result.jpg');

  // ⑤ 无尽选择
  await ev(`(async () => { window.__mountPanels?.(); const u = await import('/src/ui/ui.js'); u.showBossStageResult(null);
    u.showHexEndless({ stage:4, nextStage:5, allowPick:true, preview:{
      stage:5, bossName:'深渊传令官', bossIcon:'hex/abyssHerald.png',
      variant:{ name:'深渊·断誓骑士' }, arena:{ id:'maelstrom', name:'漩涡深渊', icon:'hex/maelstrom.png' },
      weather:{ id:'storm', name:'逆浪', icon:'hex/thundercloud.png' },
      prefix:{ name:'冰封的', icon:'hex/frostPrefix.png' },
      rules:[{ id:'rage', name:'狂暴', icon:'hex/rage.png', negative:true }],
      relic:{ name:'时砂', icon:'hex/relicHourglass.png' } } }); return 1; })()`);
  await sleep(600);
  await shot('shots/verify/cyber-hex-endless.jpg');

  // ⑥ 版面自检：来源列与双表不重叠、表格不溢出、数字右对齐
  const fit = await ev(`(() => {
    const u = window.__ui;
    u.showHexEndless(null);
    u.showBossEnd({ victory:true, grade:'S', totalTime:600, endlessStage:4,
      damage:[{name:'ok没问题',dmg:18642,me:true},{name:'浪里白条',dmg:15220}],
      taken:[{name:'ok没问题',taken:4210,me:true},{name:'浪里白条',taken:6380}],
      takenBy:[{source:'熔岩海啸',dmg:2400}], hex:null });
    const end = document.getElementById('boss-end');
    const src = document.getElementById('boss-end-src').getBoundingClientRect();
    const tabs = document.getElementById('boss-end-tables').getBoundingClientRect();
    const numTd = document.querySelector('#boss-end td.num');
    const cards = [...document.querySelectorAll('#boss-end .be-table table')].map((t) => {
      const r = t.getBoundingClientRect(); return { w: Math.round(r.width), right: Math.round(r.right) };
    });
    const overflowX = end.scrollWidth - end.clientWidth;
    const overflowY = end.scrollHeight - end.clientHeight;
    return {
      srcRight: Math.round(src.right), tabsLeft: Math.round(tabs.left),
      gap: Math.round(tabs.left - src.right),
      numAlign: numTd ? getComputedStyle(numTd).textAlign : '',
      tables: cards, overflowX, overflowY,
      vh: innerHeight, endH: Math.round(end.getBoundingClientRect().height),
    };
  })()`);
  // 标题细节放大（检查是否被裁 / 字距是否正常）
  const tbox = await ev(`(() => {
    const h = document.querySelector('#boss-end .be-top h2');
    const r = h.getBoundingClientRect();
    const cs = getComputedStyle(h);
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      fs: cs.fontSize, lh: cs.lineHeight, ov: cs.overflow, top: Math.round(h.parentElement.getBoundingClientRect().y) };
  })()`);
  console.log('  标题框:', JSON.stringify(tbox));
  if (tbox) {
    const r = await cdp('Page.captureScreenshot', { format: 'png',
      clip: { x: Math.max(0, tbox.x - 60), y: Math.max(0, tbox.y - 14), width: tbox.w + 120, height: tbox.h + 28, scale: 3 } }, 60000);
    await fs.writeFile('shots/verify/cyber-title-zoom.png', Buffer.from(r.data, 'base64'));
    console.log('  → shots/verify/cyber-title-zoom.png');
  }
  console.log('  版面:', JSON.stringify(fit));
} finally {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
}
