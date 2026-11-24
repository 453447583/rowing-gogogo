// 海克斯卡面验收（一次性）：打开 dev 页面，直接调 UI.showHexCards 拍核心卡与金卡三选一。
//   node tests/_hex_cards_shot.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hex-cards-' + Date.now());
const port = 9720 + Math.floor(Math.random() * 40);
const base = process.env.HEX_BASE || 'http://127.0.0.1:5199/';
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
  if (r?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
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

  // 等 UI 模块可导入（dev server 会按需编译）
  const ready = await ev(`(async () => {
    for (let i = 0; i < 120; i++) {
      try { const m = await import('/src/ui/ui.js'); if (m.showHexCards) { window.__hexUI = m; return true; } } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  })()`);
  if (!ready) throw new Error('UI 模块不可用');

  await sleep(2600); // 等 main.js 初始化完，否则它会把面板再关掉
  // ① 开局核心三选一
  await ev(`window.__hexUI.showHexCards({ kind:'core', cards:['pow','steel','rich'], timeout:20 }); 1`);
  await sleep(900);
  await shot('shots/verify/hex-core-cards.jpg');

  // ② 通关金卡三选一（带重掷 / 弃牌按钮）
  await ev(`window.__hexUI.showHexCards({ kind:'card', stage:2, cards:['neptune','glasscannon','aegis'], timeout:20, extra:{reroll:true, discard:true} }); 1`);
  await sleep(700);
  await shot('shots/verify/hex-gold-cards.jpg');

  // ③ 蓝卡 / 白卡各一张，确认稀有度框色区分
  await ev(`window.__hexUI.showHexCards({ kind:'card', stage:3, cards:['weak','pierce','critcore'], timeout:20 }); 1`);
  await sleep(600);
  await shot('shots/verify/hex-blue-white-cards.jpg');

  // 尺寸自检：三张卡不溢出视口、插画与文字区都在
  const fit = await ev(`(() => {
    const rows = [...document.querySelectorAll('#hex-cards .hex-card')];
    const panel = document.querySelector('#hex-cards .hex-cards-panel').getBoundingClientRect();
    return {
      cards: rows.length,
      arts: document.querySelectorAll('#hex-cards .hc-art img').length,
      scrolls: document.querySelectorAll('#hex-cards .hc-scroll').length,
      seals: document.querySelectorAll('#hex-cards .hc-seal img').length,
      panelW: Math.round(panel.width), panelH: Math.round(panel.height),
      vw: innerWidth, vh: innerHeight,
      cardW: rows[0] ? Math.round(rows[0].getBoundingClientRect().width) : 0,
      cardH: rows[0] ? Math.round(rows[0].getBoundingClientRect().height) : 0,
      broken: [...document.querySelectorAll('#hex-cards img')].filter((i) => i.complete && i.naturalWidth === 0).length,
    };
  })()`);
  console.log('  尺寸/结构:', JSON.stringify(fit));

  // ④ HUD 词缀条：主循环每帧会重置真实 #hex-strip，这里用独立容器复刻同样的 class
  await ev(`window.__hexUI.showHexCards(null); 1`);
  const stripOk = await ev(`(() => {
    document.getElementById('hex-strip-probe')?.remove();
    const box = document.createElement('div');
    box.id = 'hex-strip-probe';
    box.className = 'hex-strip';
    box.style.cssText = 'position:fixed;left:50%;top:13%;transform:translateX(-50%);z-index:95;display:flex;'
      + 'padding:8px 14px;background:rgba(8,12,16,.94);border:1px solid rgba(180,140,80,.4);border-radius:3px;font-size:11px';
    const rows = [
      ['neg hs-prefix', 'berserk', '狂暴的'],
      ['neg hs-variant', 'abyssDeep', '深渊·噬海龙'],
      ['hs-arena', 'maelstrom', '漩涡深渊'],
      ['hs-relic', 'relicCount', '2'],
      ['hs-anchor', 'anchor', '1'],
      ['', 'rage', '狂暴'],
      ['neg', 'venom', '瘴气'],
    ];
    box.innerHTML = '<span class="hs-core"><img class="hex-ico" src="/icons/hex/pow.png">火力狂欢</span>'
      + '<span class="hs-rules">' + rows.map(function (a) {
        return '<span class="hs-rule ' + a[0] + '"><img class="hex-ico" src="/icons/hex/' + a[1] + '.png">' + a[2] + '</span>';
      }).join('') + '</span>'
      + '<span class="hs-build">构筑 <b>3</b></span>';
    document.body.appendChild(box);
    return 'ok';
  })()`);
  console.log('  状态栏模拟:', stripOk);
  await sleep(500);
  await shot('shots/verify/hex-strip.jpg');

} finally {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
}
