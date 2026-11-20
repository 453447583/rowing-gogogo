// 大厅「游戏设置」抽屉 + 换头像入口的验收脚本
//
// 验收两件事（用户两轮反馈的原话）：
//   ① 大厅「游戏设置」打开的必须是**原来那条主机设置抽屉**，不是比赛内的深海设置面板；
//      抽屉底部在「单人练习 + 怪物模式」下要出现「起始关卡」按钮组。
//   ② 换头像不再是大厅展示台上那块独立头像，而是点「参赛选手」里自己那一行的头像。
//
// 用法：npm run build && PORT=5179 node tests/serve-dist.mjs & node tests/lobby_settings_avatar.mjs http://127.0.0.1:5179/
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5179/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/lobby-ui-' + Date.now());
const port = 10020 + Math.floor(Math.random() * 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=760,470', base], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};

const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

const out = {};
try {
  let tabs = null;
  for (let i = 0; i < 60 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const errs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // 无头 Edge 有时先开一个 about:blank 页：握手后强制导航一次，别在空白页上跑断言
  if (!(await (async () => (await cdp('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result.value)()).includes('127.0.0.1')) {
    await cdp('Page.navigate', { url: base });
  }
  await sleep(2600);

  const evalJs = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true;})()`);
  /** 轮询等某个条件成立（软件渲染下启动很慢，固定 sleep 不够稳） */
  const waitFor = async (expr, timeout = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { if (await evalJs(`!!(${expr})`)) return true; } catch { /* 页面还在换栈，忽略 */ }
      await sleep(220);
    }
    return false;
  };
  const shot = async (file) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    await fs.mkdir('shots/verify', { recursive: true });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  };

  // 1) 主菜单 → 单人练习（单人也会进大厅）
  await waitFor(`!document.querySelector('#menu-main')?.classList.contains('hidden')`, 15000);
  out.clickedSolo = await click('#btn-solo');
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 15000);
  await sleep(700);
  out.lobbyVisible = await evalJs(`!document.querySelector('#lobby').classList.contains('hidden')`);

  // 2) 旧入口必须已经删干净；「我」那一行必须是可点的头像
  out.legacyLobbyAvatar = await evalJs(`!!document.querySelector('#lobby-avatar')`);
  out.meAvatarClicks = await evalJs(`document.querySelectorAll('#lobby-players [data-avatar-me]').length`);
  out.rowCount = await evalJs(`document.querySelectorAll('#lobby-players .player-row').length`);

  // 3) 切到怪物模式（选关按钮只在这个模式出现）
  await click('#btn-lobby-mode');
  await waitFor(`!!document.querySelector('.lp-pill[data-mode="boss"]')`, 6000);
  await click('.lp-pill[data-mode="boss"]');
  await sleep(900);

  // 4) 游戏设置 → 必须是原来那条抽屉，不能是比赛内设置面板
  await click('#btn-lobby-settings');
  await sleep(600);
  out.drawerOpen = await evalJs(`document.querySelector('#lobby-settings-drawer').classList.contains('open')`);
  out.gamePanelOpen = await evalJs(`!document.querySelector('#settings-panel').classList.contains('hidden')`);
  out.stagePickVisible = await evalJs(`!document.querySelector('#lobby-stage-pick').classList.contains('hidden')`);
  out.stageBtnCount = await evalJs(`document.querySelectorAll('#lobby-stage-grid .lsp-btn').length`);
  out.stageBtnLabels = await evalJs(`[...document.querySelectorAll('#lobby-stage-grid .lsp-btn')].map(b=>b.textContent)`);
  out.stageOnBefore = await evalJs(`document.querySelector('#lobby-stage-grid .lsp-btn.on')?.dataset.stage || null`);
  await shot('shots/verify/lobby-settings-drawer.jpg');

  // 5) 点第 2 关（如果存在）：高亮要跟着走，抽屉不能被关掉
  const picked = await evalJs(`(()=>{const b=[...document.querySelectorAll('#lobby-stage-grid .lsp-btn')][1];
    if(!b) return null; b.click(); return b.dataset.stage;})()`);
  await sleep(500);
  out.stagePicked = picked;
  out.stageOnAfter = await evalJs(`document.querySelector('#lobby-stage-grid .lsp-btn.on')?.dataset.stage || null`);
  out.selectSynced = await evalJs(`document.querySelector('#boss-stage')?.value || null`);
  out.drawerStillOpen = await evalJs(`document.querySelector('#lobby-settings-drawer').classList.contains('open')`);
  await shot('shots/verify/lobby-settings-drawer-picked.jpg');
  // 抽屉滚到底：确认 4 个关卡按钮和底部说明在同一屏内能看到，不被裁掉
  await evalJs(`(()=>{const d=document.querySelector('#lobby-settings-drawer');if(d)d.scrollTop=d.scrollHeight;return true;})()`);
  await sleep(300);
  await shot('shots/verify/lobby-settings-drawer-bottom.jpg');

  // 6) 头像：点自己那一行的头像 → 弹头像弹窗
  await click('#btn-lobby-settings-close');
  await sleep(400);
  await click('#lobby-players [data-avatar-me]');
  await sleep(600);
  out.avatarDialogOpen = await evalJs(`!document.querySelector('#dlg-avatar').classList.contains('hidden')`);
  out.avatarCellCount = await evalJs(`document.querySelectorAll('#avatar-grid .av-cell').length`);
  await shot('shots/verify/lobby-avatar-from-roster.jpg');

  out.errors = errs.slice(0, 6);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await cleanup();
}
