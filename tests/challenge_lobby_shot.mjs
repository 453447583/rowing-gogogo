// 挑战模式：大厅「模式」抽屉的实拍验收
//
//   node tests/challenge_lobby_shot.mjs
//
// 只做两件事：确认抽屉里挑战卡片在那儿、把抽屉拍下来看排版有没有被挤坏。
// 截图走 CDP 一次（headless 下 DOM 面板只能这样拍，且拍多张容易挂）。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = `D:/3dgame-tmp/browser/lobbyshot-${stamp}`;
const port = 9870 + (Number(stamp.slice(-3)) % 20);
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 60000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(200);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

let failed = 0;
const report = (ok, msg) => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

try {
  let info;
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { info = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.navigate', { url: base });
  await sleep(2500);
  try { await cdp('Page.bringToFront'); } catch { /* */ }

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`);
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-boss-card[data-mode="challenge"]')`);
  await sleep(500);

  const card = val(await evaluate(`(() => {
    const b = document.querySelector('.lp-boss-card[data-mode="challenge"]');
    const r = b.getBoundingClientRect();
    const drawer = document.querySelector('#lobby-pick-drawer');
    const dr = drawer?.getBoundingClientRect();
    return {
      text: b.textContent.replace(/\\s+/g, ' ').trim(),
      box: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) },
      insideDrawer: dr ? r.top >= dr.top - 2 && r.bottom <= dr.bottom + 2 : false,
      scrollOverflow: drawer ? drawer.scrollHeight - drawer.clientHeight : 0,
      drawerOpen: drawer?.classList.contains('open'),
    };
  })()`));
  console.log('card =', JSON.stringify(card));
  report(card?.drawerOpen, '模式抽屉打开');
  report(card?.text?.includes('挑战模式'), `挑战卡片存在（${card?.text}）`);
  report(card?.insideDrawer, '挑战卡片在抽屉可视区域内（没被裁掉）');
  report(card?.box?.h > 40, `卡片高度正常（${card?.box?.h}px）`);

  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir('shots/challenge', { recursive: true });
  await fs.writeFile('shots/challenge/lobby-mode.png', Buffer.from(shot.data, 'base64'));
  console.log('shot → shots/challenge/lobby-mode.png');
} catch (e) {
  console.log('ERR', e.message);
  failed += 1;
} finally {
  try { ws?.close(); } catch { /* */ }
  try { child.kill(); } catch { /* */ }
  await sleep(300);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch { /* */ }
}
console.log(failed === 0 ? 'challenge lobby shot: PASS' : `challenge lobby shot: ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
