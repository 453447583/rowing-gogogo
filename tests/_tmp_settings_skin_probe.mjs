// 一次性探针：设置面板浅色青春版截图 + 关键尺寸/色值断言
// 用法：node tests/_tmp_settings_skin_probe.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 3311, WS_PORT = 3412;
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/settings-skin-${stamp}`);
const cdpPort = 9750 + (Number(stamp.slice(-2)) % 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return true; } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}
async function waitJson(u, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(200);
  }
  throw new Error('timeout ' + u);
}

const server = spawn(process.execPath, ['server/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: path.resolve('.tmp_build/lb-probe-settings.json'), LB_STORE: 'json' },
  stdio: 'ignore',
});
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--force-device-scale-factor=1', `http://127.0.0.1:${PORT}/`],
{ stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp timeout ' + method)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); } });
  });
}
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
};
async function waitFor(expr, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(200); }
  throw new Error('waitFor timeout: ' + expr);
}
let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures++; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

async function main() {
  await waitHttp(`http://127.0.0.1:${PORT}/`);
  const tabs = await waitJson(`http://127.0.0.1:${cdpPort}/json`);
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
  await waitFor(`!!document.querySelector('#settings-panel .sp-card')`, 40000);
  // 首页没有 HUD 的画质按钮，走全局 Esc（main.js 里最后兜底打开设置）
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 1`);
  await waitFor(`!document.querySelector('#settings-panel')?.classList.contains('hidden')`, 10000);
  await ev(`document.querySelector('#settings-panel [data-tab="audio"]')?.click(); 1`);
  await sleep(600);

  const layout = await ev(`(() => {
    const card = document.querySelector('#settings-panel .sp-card');
    const top = document.querySelector('#settings-panel .sp-topbar');
    const head = document.querySelector('#settings-panel .sp-head');
    const tabs = document.querySelector('#settings-panel .sp-tabs');
    const rows = [...document.querySelectorAll('#settings-panel .sp-row')];
    const cs = getComputedStyle(card);
    const r = card.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      left: Math.round(r.left), topPx: Math.round(r.top),
      bg: cs.backgroundColor, radius: cs.borderRadius,
      topbar: top ? getComputedStyle(top).backgroundColor : '',
      topbarH: top ? Math.round(top.getBoundingClientRect().height) : 0,
      title: document.querySelector('#settings-panel .sp-title')?.textContent.trim(),
      active: document.querySelector('#settings-panel .sp-tab.on')?.textContent.trim(),
      tabNames: [...document.querySelectorAll('#settings-panel .sp-tab')].map(x=>x.textContent.trim()),
      tabW: Math.round(tabs?.getBoundingClientRect().width || 0),
      labelColors: rows.map(x=>getComputedStyle(x.querySelector('.sp-label b')).color),
      rowCount: rows.length,
      rangeFill: getComputedStyle(rows[0].querySelector('.sp-range')).backgroundImage,
      headShadow: getComputedStyle(document.querySelector('#settings-panel .sp-title')).textShadow,
    };
  })()`);
  ok(layout.bg === 'rgb(247, 249, 250)', '面板白底', layout);
  ok(layout.radius === '18px', '18px 圆角', layout);
  ok(layout.topbar === 'rgb(22, 196, 214)' && layout.topbarH === 8, '8px 青蓝顶条', layout);
  ok(layout.title === '设置', '标题文字', layout);
  ok(layout.active === '音频', '默认选中音频', layout);
  ok(layout.tabNames.join('/') === '画面/音频/界面/辅助/键位/素材来源', '六个页签', layout);
  ok(layout.rowCount === 5, '音频页五行', layout);
  ok(layout.labelColors.every((c) => c === 'rgb(17, 33, 43)'), '深墨蓝项名', layout);
  ok(/22, 196, 214/.test(layout.rangeFill), '滑杆青蓝填充', layout);
  ok(Math.abs(layout.w - 817) <= 2 && Math.abs(layout.h - 546) <= 2, '817×546 参考尺寸', layout);

  // 排行榜不能跟着变白
  const lbStyle = await ev(`(() => {
    const c = document.querySelector('#leaderboard .lb-card');
    return c ? getComputedStyle(c).backgroundImage.slice(0, 60) : 'none';
  })()`);
  ok(!/247, 249, 250/.test(lbStyle), '排行榜未被浅色皮肤污染', lbStyle);

  const shot = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 90 });
  await fs.mkdir('shots/verify', { recursive: true });
  await fs.writeFile('shots/verify/settings_light_audio.jpg', Buffer.from(shot.data, 'base64'));

  console.log(failures ? `FAIL ${failures}` : 'PASS');
  if (failures) process.exitCode = 1;
}
main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; })
  .finally(async () => {
    try { ws?.close(); } catch {}
    child.kill(); server.kill();
    await sleep(300);
    process.exit(process.exitCode || 0);
  });
