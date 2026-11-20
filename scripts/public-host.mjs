// 一键"公网开黑"：本机服务器 + Cloudflare 快速隧道。
//   node scripts/public-host.mjs [--port 3000] [--ws-port 3001]
// 或双击项目根目录的 启动服务器-公网.bat
//
// 它做三件事：
//   1) 启动本机 server.js（页面和 WebSocket 同源同端口，排行榜 JSON 也在本机）
//   2) 启动 cloudflared 快速隧道，把本机端口暴露成一个公网 https 网址
//   3) 把"发给朋友的链接"打印出来；Ctrl+C 时两个进程一起退
//
// 为什么这样就能共用排行榜：局域网入口和"联机对战"入口连的都是这台
// server.js —— 一个进程、一份 server/data/leaderboard.json，天然共用。
// （两台服务器写同一份本地 JSON 是做不到的，文件没法跨机器共享。）
//
// 注意：快速隧道（trycloudflare.com）的网址**每次重启都会变**，要重发给朋友。
// 想要固定网址：注册 Cloudflare → 添加自己的域名 → 建命名隧道
//   cloudflared tunnel login
//   cloudflared tunnel create rapids
//   cloudflared tunnel route dns rapids 你的子域名
//   cloudflared tunnel run --url http://localhost:3000 rapids
// 本脚本只负责"快速隧道"，固定域名请按上面手动跑（server.js 不用改）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 参数 ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
}
const HTTP_PORT = Number(arg('--port', process.env.PORT || 3000));
const WS_PORT = Number(arg('--ws-port', process.env.WS_PORT || 3001));

// ---------- cloudflared 位置 ----------
const candidates = [
  process.env.CLOUDFLARED_PATH,
  path.join(ROOT, 'tools', 'cloudflared', 'cloudflared.exe'),
  'cloudflared',
].filter(Boolean);
const cloudflaredBin = candidates.find((p) =>
  p.includes('/') || p.includes('\\') ? fs.existsSync(p) : true);
if (!cloudflaredBin) {
  console.error('[public-host] 找不到 cloudflared。');
  console.error('  下载 https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe');
  console.error('  放到 tools/cloudflared/cloudflared.exe，或安装进 PATH。');
  process.exit(1);
}

// 页面必须已经构建过：隧道直接对外，没 dist 朋友打开就是 404
if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('[public-host] 还没有构建产物（dist/）。先跑一次 npm run build 或 启动服务器.bat。');
  process.exit(1);
}

const kids = [];
const die = (who) => {
  console.error(`[public-host] ${who} 退出了，整体关闭`);
  for (const k of kids) { try { k.kill(); } catch { /* 已退 */ } }
  process.exit(1);
};

// ---------- 1) 本机服务器 ----------
const server = spawn(process.execPath, ['server/server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(HTTP_PORT), WS_PORT: String(WS_PORT) },
  stdio: 'inherit',
});
kids.push(server);
server.on('exit', (code) => die(`server.js（退出码 ${code}）`));
server.on('error', (err) => die(`server.js 启动失败：${err.message}`));

// 本机就绪再开隧道：隧道通了但页面 404 会让人以为是隧道的问题
for (let i = 0; i < 80; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}/`);
    if (r.ok) break;
  } catch { /* 还没起来 */ }
  await sleep(250);
}

// ---------- 2) 快速隧道 ----------
console.log('\n[public-host] 正在建立公网隧道（首次约 5~15 秒）…');
const tunnel = spawn(cloudflaredBin, ['tunnel', '--url', `http://localhost:${HTTP_PORT}`, '--no-autoupdate'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
kids.push(tunnel);
tunnel.on('exit', (code) => die(`cloudflared（退出码 ${code}）`));
tunnel.on('error', (err) => die(`cloudflared 启动失败：${err.message}`));

const publicUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const scan = (d) => {
    buf += d.toString();
    // cloudflared 把日志写 stderr，网址形如 |  https://xxxx.trycloudflare.com  |
    const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (m) resolve(m[0]);
  };
  tunnel.stdout.on('data', scan);
  tunnel.stderr.on('data', scan);
  const timer = setTimeout(() => reject(new Error('60 秒内没拿到隧道网址')), 60000);
  tunnel.on('exit', () => { clearTimeout(timer); reject(new Error('cloudflared 提前退出')); });
});

// 隧道网址通了不代表页面通了：Cloudflare 边缘建立完成前可能 502，重试确认
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  try {
    const r = await fetch(`${publicUrl}/`);
    ready = r.ok;
  } catch { /* 边缘还没就绪 */ }
  if (!ready) await sleep(500);
}

// ---------- 3) 把链接打出来 ----------
console.log(`
========================================================
  激流勇进 · 公网开黑已就绪${ready ? '' : '（页面还在预热，稍等几秒再刷新）'}

  发给朋友的链接（每次重启都会变，记得重发）：
    ${publicUrl}

  朋友打开后点「联机对战」即可；你在家里玩可以照旧走
  「局域网对战」。两边成绩写进同一份
    server/data/leaderboard.json
================================================--------
`);
console.log('[public-host] 按 Ctrl+C 关闭服务器和隧道。');

const shutdown = () => {
  console.log('\n[public-host] 正在关闭…');
  for (const k of kids) { try { k.kill(); } catch { /* 已退 */ } }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
