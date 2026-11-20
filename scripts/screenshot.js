// 聊天框截图脚本
// 用 Playwright headless Chromium 打开本地 server，模拟登录 → 大厅 → 进入聊天 → 截图；
// 然后强制 DOM 切到"比赛内"状态，再截图一张。
// 用法：npx playwright@latest install chromium && node scripts/screenshot.js
import { chromium } from 'playwright';
import { createServer } from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = 3000;
const WS_PORT = 3001;

// —— 轻量静态 server（不依赖 ESM import BOATS 那些，纯粹读 dist/ 文件）——
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.bin': 'application/octet-stream',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mtl': 'text/plain',
  '.obj': 'text/plain',
};

const httpServer = createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(DIST, urlPath);
  if (!filePath.startsWith(DIST)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// 最小化 ws：只回 hello → welcome + 转发 chat，避免真实游戏房间（太重）
const wss = new WebSocketServer({ port: WS_PORT });
let nextId = 1;
wss.on('connection', (ws) => {
  let me = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'hello') {
      me = { id: 'p' + nextId++, ws, name: String(msg.name || '玩家').slice(0, 10) };
      ws.send(JSON.stringify({ t: 'welcome', id: me.id, hostId: me.id, lanIps: ['127.0.0.1'], players: [{ id: me.id, name: me.name, boatId: null, offline: false }] }));
      // 欢迎后立刻发一条"别人"的聊天
      setTimeout(() => ws.send(JSON.stringify({ t: 'chat', id: 'p999', name: '测试玩家', text: '嘿！你在看聊天框吗？' })), 400);
      setTimeout(() => ws.send(JSON.stringify({ t: 'chat', id: 'p888', name: '另一个人', text: '8 秒后我会淡出~' })), 2200);
    } else if (msg.t === 'chat') {
      // echo 回来让大厅/比赛的横条也出效果
      ws.send(JSON.stringify({ t: 'chat', id: me.id, name: me.name, text: String(msg.text || '').slice(0, 60) }));
    } else if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: Number(msg.ts) || 0 }));
    }
  });
  ws.on('close', () => {});
});

await new Promise((r) => httpServer.listen(PORT, r));
console.log(`截图 server: http://localhost:${PORT}`);
console.log(`WS: ws://localhost:${WS_PORT}`);

const browser = await chromium.launch({ headless: true, args: ['--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 允许 WebGL
await page.addInitScript(() => {
  // 我们只截图 DOM UI，Three.js 渲染会黑屏，但 HUD / 聊天框 / 大厅面板都是 DOM，没问题
});

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(1500);

// —— 1. 主菜单：填昵称 → 进入大厅 ——
const nameInput = page.locator('#input-name');
await nameInput.waitFor({ state: 'visible', timeout: 8000 });
await nameInput.fill('截图小哥');
await page.waitForTimeout(300);

// 先尝试"进入大厅"按钮；如果有"练习模式"也可以，选联机那个
// 按钮顺序：单机 / 联机 / 练习
const enterButtons = page.locator('#menu-main button');
const count = await enterButtons.count();
console.log(`菜单按钮数：${count}`);
if (count >= 2) {
  await enterButtons.nth(1).click(); // 联机大厅
} else if (count === 1) {
  await enterButtons.first().click();
}
await page.waitForTimeout(1200);

// —— 2. 大厅：按 Enter 呼出聊天 → 截图 ——
console.log('=== 大厅状态 ===');
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
const lobbyOpen = await page.evaluate(() => document.getElementById('chat-lobby')?.classList.contains('open'));
console.log('chat-lobby open:', lobbyOpen);
await page.screenshot({ path: path.resolve(__dirname, '..', 'shot-lobby.png'), fullPage: false });
console.log('→ shot-lobby.png');

// 发条消息让列表有内容
await page.keyboard.type('大厅消息测试 哈喽~', { delay: 30 });
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.screenshot({ path: path.resolve(__dirname, '..', 'shot-lobby-filled.png') });
console.log('→ shot-lobby-filled.png');

// —— 3. 模拟"比赛内"：隐藏大厅、显示 HUD、按 Enter、发消息、收气泡 ——
await page.evaluate(() => {
  const lobby = document.getElementById('lobby');
  const hud = document.getElementById('hud');
  if (lobby) { lobby.classList.add('hidden'); lobby.classList.remove('open'); }
  if (hud) hud.classList.remove('hidden');
  // 把速度表、氮气、赛道进度都强制露出来，方便看位置
  document.querySelector('.speedo')?.classList.remove('hidden');
  document.getElementById('nitro-wrap')?.classList.remove('hidden');
  document.querySelector('.progress')?.classList.remove('hidden');
  // 调一下赛道进度条的值
  const bar = document.getElementById('hud-progress-bar');
  const text = document.getElementById('hud-progress-text');
  if (bar) bar.style.transform = 'scaleX(0.45)';
  if (text) text.textContent = '赛道进度 45%';
  // 隐藏结算面板
  document.getElementById('finish-panel')?.classList.add('hidden');
  document.getElementById('countdown')?.classList.add('hidden');
  document.getElementById('race-msg')?.classList.add('hidden');
});
await page.waitForTimeout(300);

// 让 ChatUI 知道现在在 game 屏幕：强制重新算
await page.evaluate(() => {
  // ChatUI.screen 是 getter，会重新取 #hud 和 #lobby 的 hidden 类
});

// 比赛内状态图（先截一张，显示自己发的横条 + 别人的气泡）
await page.waitForTimeout(2500); // 让欢迎后的两条"别人"消息弹出气泡
await page.screenshot({ path: path.resolve(__dirname, '..', 'shot-game-bubbles.png') });
console.log('→ shot-game-bubbles.png (有气泡)');

// 按 Enter 打开游戏内聊天输入条
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const gameOpen = await page.evaluate(() => document.getElementById('chat-game-bar')?.classList.contains('open'));
console.log('chat-game-bar open:', gameOpen);
await page.screenshot({ path: path.resolve(__dirname, '..', 'shot-game-open.png') });
console.log('→ shot-game-open.png');

// 输一条、发送，让横条也出现
await page.keyboard.type('无线电测试，赛道进度 45%~', { delay: 30 });
await page.keyboard.press('Enter');
await page.waitForTimeout(500);
await page.screenshot({ path: path.resolve(__dirname, '..', 'shot-game-bar.png') });
console.log('→ shot-game-bar.png');

// 清理
await browser.close();
wss.close();
await new Promise((r) => httpServer.close(r));
console.log('全部完成，文件在项目根目录：');
console.log('  shot-lobby.png       大厅（空消息）');
console.log('  shot-lobby-filled.png 大厅（有消息）');
console.log('  shot-game-bubbles.png 比赛内（只有气泡弹出）');
console.log('  shot-game-open.png    比赛内（Enter 呼出输入条）');
console.log('  shot-game-bar.png     比赛内（已发送自己的横条 + 气泡）');
