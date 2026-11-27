// 账号登录 UI 全链路：node tests/account_ui_probe.mjs
//   U1 未登录点入口 → 弹账号面板（不会直接进游戏）
//   U2 注册 → 一次性备用码必须真的显示出来（以前画在隐藏面板里，玩家永远拿不到）
//   U3 点「我已保存」→ 自动继续原先进游戏的动作
//   U4 刷新后 token 还在，不再弹登录，直接进大厅
//   U5 退出登录 → 清 token，下次点入口重新弹面板
//   U6 密码错 → 留在面板上并提示；备用码重置 → 能用新密码登录
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTTP_PORT = Number(process.env.PORT) || 3601;
const WS_PORT = Number(process.env.WS_PORT) || 3602;
const cdpPort = 9920 + Math.floor(Math.random() * 60);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/acc-ui-' + Date.now());
const file = path.resolve('.tmp_build/account_ui.json');
const shots = path.resolve('shots/verify');
fs.mkdirSync(shots, { recursive: true });
try { fs.unlinkSync(file); } catch { /* 首次运行 */ }

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const server = spawn(process.execPath, ['server/server.js'], {
  env: {
    ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT),
    LEADERBOARD_FILE: file,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[server]', s); });

let child = null;
let ws = null;
try {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }
  child = spawn(edge, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`, '--window-size=1440,900',
    `http://127.0.0.1:${HTTP_PORT}/?ws=${WS_PORT}`], { stdio: 'ignore' });

  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const pending = new Map();
  const pageErrors = [];
  let seq = 0;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  const ev = async (expression) => (await cdp('Runtime.evaluate', {
    expression: `(function(){ try { return (${expression}); } catch(e){ return 'ERR:'+e.message; } })()`,
    returnByValue: true, awaitPromise: true,
  }))?.result?.value;
  const waitFor = async (expr, label, tries = 80) => {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await ev(expr);
      if (last === true) return true;
      await sleep(250);
    }
    console.error('    timeout:', label, JSON.stringify(last));
    return false;
  };
  const shot = async (name) => {
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
  };

  // ---- U1：未登录不许直接进游戏 ----
  ok(await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '主菜单'), '主菜单就绪');
  await ev(`(function(){ document.querySelector('#btn-solo').click(); return 1; })()`);
  ok(await waitFor(`!document.querySelector('#account-panel').classList.contains('hidden')`, '账号面板'),
    'U1 未登录点入口 → 弹账号面板，不会直接开赛');
  await shot('acc_01_login.png');

  // ---- U2：注册必须先把备用码给玩家看 ----
  await ev(`(function(){ document.querySelector('[data-ac-tab="register"]').click(); return 1; })()`);
  await sleep(350);
  await shot('acc_02_register.png');
  const user = '探针' + Date.now().toString(36).slice(-4);
  const pass = 'sail123456';
  await ev(`(function(){
    document.querySelector('[data-ac="user"]').value = ${JSON.stringify(user)};
    document.querySelector('[data-ac="pass"]').value = ${JSON.stringify(pass)};
    return 1;
  })()`);
  await ev(`(function(){ document.querySelector('[data-ac="submit"]').click(); return 1; })()`);
  const codeShown = await waitFor(`/^[0-9A-F]{16}$/.test(document.querySelector('.ac-code')?.textContent || '')`, '备用码', 40);
  const backup = await ev(`document.querySelector('.ac-code')?.textContent || ''`);
  ok(codeShown, 'U2 注册后备用码真的显示在面板里', backup);
  ok(await ev(`!document.querySelector('#account-panel').classList.contains('hidden')`),
    'U2 备用码这一屏不会自动关掉（玩家必须看到）');
  ok(!!(await ev(`localStorage.getItem('rr-account-token')`)), 'U2 token 已写入 localStorage');
  await shot('acc_03_backup.png');

  // ---- U3：点「我已保存」接着进游戏 ----
  await ev(`(function(){ document.querySelector('[data-ac="again"]').click(); return 1; })()`);
  ok(await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '进大厅'),
    'U3 点「我已保存」→ 自动继续原先的动作（单人练习）');
  ok(await ev(`document.querySelector('#account-panel').classList.contains('hidden')`), 'U3 面板已关闭');
  await shot('acc_04_after.png');

  // ---- U4：刷新后仍是登录态 ----
  await ev(`(function(){ location.reload(); return 1; })()`);
  await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '刷新后主菜单', 100);
  ok(!!(await ev(`localStorage.getItem('rr-account-token')`)), 'U4 刷新后 token 仍在（没被启动校验误删）');
  await ev(`(function(){ document.querySelector('#btn-host').click(); return 1; })()`);
  ok(await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, '刷新后进大厅'),
    'U4 刷新后点入口直接进大厅，不再弹登录');
  await shot('acc_05_reenter.png');

  // ---- U5：退出登录 ----
  await ev(`(function(){ document.querySelector('#name-plate').click(); return 1; })()`);
  await sleep(600);
  await shot('acc_06_wallet.png');
  const hasLogout = await ev(`!!document.querySelector('[data-wp="logout"]')`);
  ok(hasLogout, 'U5 玩家面板里有「退出登录 / 切换账号」入口');
  if (hasLogout) {
    await ev(`(function(){ document.querySelector('[data-wp="logout"]').click(); return 1; })()`);
    await waitFor(`typeof document.querySelector('#btn-host')?.onclick === 'function'`, '退出后主菜单', 100);
    ok(!(await ev(`localStorage.getItem('rr-account-token')`)), 'U5 退出后 token 已清空');
    await ev(`(function(){ document.querySelector('#btn-host').click(); return 1; })()`);
    ok(await waitFor(`!document.querySelector('#account-panel').classList.contains('hidden')`, '再次弹面板'),
      'U5 退出后点入口重新弹账号面板');
  }

  // ---- U6：密码错 / 备用码重置 ----
  await ev(`(function(){ document.querySelector('[data-ac-tab="login"]').click(); return 1; })()`);
  await sleep(300);
  await ev(`(function(){
    document.querySelector('[data-ac="user"]').value = ${JSON.stringify(user)};
    document.querySelector('[data-ac="pass"]').value = 'wrong-pass';
    document.querySelector('[data-ac="submit"]').click();
    return 1;
  })()`);
  await sleep(1200);
  ok(await ev(`!document.querySelector('#account-panel').classList.contains('hidden')`),
    'U6 密码错误时留在面板上，不会误进游戏');
  ok(!(await ev(`localStorage.getItem('rr-account-token')`)), 'U6 密码错误不会写入 token');

  await ev(`(function(){ document.querySelector('[data-ac-tab="reset"]').click(); return 1; })()`);
  await sleep(300);
  await ev(`(function(){
    document.querySelector('[data-ac="user"]').value = ${JSON.stringify(user)};
    document.querySelector('[data-ac="code"]').value = ${JSON.stringify(backup)};
    document.querySelector('[data-ac="pass"]').value = 'newpass123';
    document.querySelector('[data-ac="submit"]').click();
    return 1;
  })()`);
  ok(await waitFor(`!!localStorage.getItem('rr-account-token')`, '重置后拿到 token', 40),
    'U6 用备用码重置密码并登录成功');
  await sleep(600);
  await shot('acc_07_reset.png');

  ok(pageErrors.length === 0, '页面全程无异常', pageErrors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* 忽略 */ }
  try { child?.kill(); } catch { /* 忽略 */ }
  server.kill();
  await sleep(300);
  try { fs.unlinkSync(file); } catch { /* 忽略 */ }
}

if (failures) {
  console.error(`\n${failures} 项未通过`);
  process.exit(1);
}
console.log('\n登录 UI 全链路 PASS');
