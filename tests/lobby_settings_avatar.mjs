// 大厅「游戏设置」抽屉 + 换头像入口的验收脚本
//
// 验收两件事（用户两轮反馈的原话）：
//   ① 大厅「游戏设置」打开的必须是**原来那条主机设置抽屉**，不是比赛内的深海设置面板；
//      抽屉底部在「单人练习 + 怪物模式」下要出现「起始关卡」按钮组。
//   ② 换头像不再是大厅展示台上那块独立头像；「参赛选手」里任何一行的头像都只做展示，
//      点了不进商城也不弹窗；真正的换头像入口只有初始界面（选艇页小圆章 + 商城右侧穿搭预览）。
//
// 用法：npm run build && PORT=5179 node tests/serve-dist.mjs & node tests/lobby_settings_avatar.mjs http://127.0.0.1:5179/
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

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
  // 强制登录：没 token 点 solo 只会弹账号面板，后面的大厅断言全部读不到 DOM。
  const token = await ensureTestAccount(String(base).replace(/\/+$/, ''), 'lobbyUi');
  out.tokenReady = !!token;
  await evalJs(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', '大厅测试');
    location.reload(); return 1;
  })()`);
  await sleep(2600);
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 15000);
  out.clickedSolo = await click('#btn-solo');
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 15000);
  await sleep(700);
  out.lobbyVisible = await evalJs(`!document.querySelector('#lobby').classList.contains('hidden')`);

  // 2) 旧入口必须已经删干净；「我」那一行也不能再挂进商城的入口（只做展示）
  out.legacyLobbyAvatar = await evalJs(`!!document.querySelector('#lobby-avatar')`);
  out.avatarShopEntries = await evalJs(`document.querySelectorAll('#lobby-players [data-avatar-shop]').length`);
  out.rowCount = await evalJs(`document.querySelectorAll('#lobby-players .player-row').length`);

  // 2b) 长昵称 + 3 枚徽章：只截名字，徽章和（你）不能被挤掉
  out.badgeFit = await evalJs(`(async function(){
    const row = document.querySelector('#lobby-players .player-row');
    const pn = row && row.querySelector('.pname');
    if (!pn) return null;
    const { badgeChips } = await import('/src/ui/badges.js');
    const txt = pn.querySelector('.p-name-txt');
    if (txt) txt.textContent = '超长昵称测试一二三四五六七八九十';
    pn.insertAdjacentHTML('beforeend', badgeChips([
      { name: '破浪徽章', imgSm: '/shop-assets/badge_s_surf_sm.png', img: '/shop-assets/badge_s_surf.png' },
      { name: '龙王徽章', imgSm: '/shop-assets/badge_s_dragon_sm.png', img: '/shop-assets/badge_s_dragon.png' },
      { name: '深渊徽章', imgSm: '/shop-assets/badge_s_abyss_sm.png', img: '/shop-assets/badge_s_abyss.png' },
      { name: '第 4 枚不该出现', imgSm: '/shop-assets/badge_s_surf_sm.png' },
    ]));
    await new Promise((r) => setTimeout(r, 260));
    const chips = [...pn.querySelectorAll('.badge-row .p-badge')];
    const rowR = row.getBoundingClientRect();
    const last = chips[chips.length - 1].getBoundingClientRect();
    const srcs = chips.map((c) => c.getAttribute('src') || '');
    return {
      chipCount: chips.length,
      usedSmall: srcs.every((s) => s.includes('_sm.png')),
      nameTruncated: txt ? txt.scrollWidth > txt.clientWidth + 1 : null,
      lastBadgeW: Math.round(last.width),
      lastBadgeInside: last.right <= rowR.right - 2,
      lastBadgeVisible: last.width > 8 && last.height > 8,
      wraps: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size,
    };
  })()`);
  // 名单每秒会重画一次，注入的徽章会被冲掉：拍图前再插一遍，拍完立刻数一遍确认拍到了
  const injectChips = `(async function(){
    const row = document.querySelector('#lobby-players .player-row');
    const pn = row && row.querySelector('.pname');
    if (!pn || pn.querySelector('.badge-row')) return 0;
    const { badgeChips } = await import('/src/ui/badges.js');
    pn.insertAdjacentHTML('beforeend', badgeChips([
      { name: '破浪徽章', imgSm: '/shop-assets/badge_s_surf_sm.png' },
      { name: '龙王徽章', imgSm: '/shop-assets/badge_s_dragon_sm.png' },
      { name: '深渊徽章', imgSm: '/shop-assets/badge_s_abyss_sm.png' },
    ]));
    return pn.querySelectorAll('.badge-row .p-badge').length;
  })()`;
  let shotChips = 0;
  for (let i = 0; i < 4 && shotChips !== 3; i++) {
    await evalJs(injectChips);
    await sleep(60);
    await shot('shots/verify/lobby-longname-badges.jpg');
    shotChips = await evalJs(`document.querySelectorAll('#lobby-players .badge-row .p-badge').length`);
  }
  out.shotChips = shotChips;


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

  // 6) 房间 / 大厅选手行的头像只做展示：点了不进商城、也不弹头像弹窗；
  //    换头像只保留初始界面的两个入口（选艇页小圆章 + 小店右侧穿搭预览）
  await click('#btn-lobby-settings-close');
  await sleep(400);
  await click('#lobby-players .player-row .pavatar');
  await sleep(600);
  out.avatarDialogOpen = await evalJs(`!document.querySelector('#dlg-avatar').classList.contains('hidden')`);
  out.shopOpen = await evalJs(`!document.querySelector('#wallet-panel').classList.contains('hidden')`);
  await shot('shots/verify/lobby-avatar-row-static.jpg');

  // 7) 小圆章仍能打开头像弹窗；小店右侧预览仍是头像入口
  await click('#avatar-chip');
  await sleep(400);
  out.chipDialogOpen = await evalJs(`!document.querySelector('#dlg-avatar').classList.contains('hidden')`);
  await click('#btn-avatar-ok');
  await click('#name-plate');
  await sleep(900);
  out.shopOpened = await evalJs(`!document.querySelector('#wallet-panel').classList.contains('hidden')`);
  out.avatarShopClicks = await evalJs(`document.querySelectorAll('#wallet-panel [data-ws-avatar]').length`);
  await shot('shots/verify/shop-avatar-entry.jpg');

  out.errors = errs.slice(0, 6);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await cleanup();
}
