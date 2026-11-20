// 找出 cpolar 当前给「本机某个端口」分配的公网地址。
//
// 为什么读日志而不是问 cpolar
// --------------------------
// cpolar 的 Web UI 在 127.0.0.1:9200，但它的 REST 接口要登录态
// （/api/v1/tunnels 直接回 401），我们拿不到浏览器里的 cookie。
// 好在服务日志里存的是完整的结构化记录，一行一条 NewTunnel：
//
//   msg="... Read message {\"Type\":\"NewTunnel\",\"Payload\":{...,\"Url\":
//        \"https://34933039.r8.cpolar.top\",\"Protocol\":\"https\",\"LocalAddr\":
//        \"http://localhost:5173\",...}}"
//
// 所以做法是：在日志尾部找「最后一条 LocalAddr 端口匹配的 https Url」。
// 取不到时按 PUBLIC_URL 环境变量 → server/data/public-url.txt 兜底，
// 也就是 cpolar 换了地址、日志格式又变了的情况下，手动粘一行还能救。
//
// 免费版每次重启隧道域名都会变，所以这个函数是"每次登记前都重新算一遍"，
// 不要缓存太久。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_DIR = process.env.CPOLAR_LOG_DIR || path.join(os.homedir(), '.cpolar', 'logs');
/** 日志一天能有几十 MB，只读尾巴：隧道地址只会出现在最近的活动里 */
const TAIL_BYTES = 3 * 1024 * 1024;

function readTail(file, bytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 在 cpolar 日志里找指定本地端口的 https 公网地址。
 * @param {number} port 本地 HTTP 端口（要和 cpolar 隧道配置里的本地端口一致）
 * @param {string} [dir] 日志目录（测试可注入）
 * @returns {string|null}
 */
export function findCpolarUrl(port, dir = LOG_DIR) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => f.startsWith('cpolar_service.log') && !f.includes('.master.log'));
  } catch {
    return null;
  }
  // 按修改时间从新到旧。只看最新一份是不够的：隧道是昨天建的、日志今天零点轮转，
  // 新文件里就没有 NewTunnel 记录（真踩过），所以往回翻几份。
  const files = names
    .map((f) => {
      const full = path.join(dir, f);
      try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 3);

  // 端口后面必须紧跟 / 或引号，否则 3000 会误匹配 30001
  const portRe = new RegExp(`:${port}(?:[/"]|$)`);
  for (const file of files) {
    let text;
    try { text = readTail(file.full); } catch { continue; }
    let hit = null;
    for (const raw of text.split('\n')) {
      // 日志里是转义过的 JSON（\"Url\":\"https://...\"），先还原成正常引号再匹配
      if (!raw.includes('LocalAddr') || !raw.includes('Url')) continue;
      const line = raw.replace(/\\"/g, '"');
      const url = /"Url":"(https:\/\/[^"]+)"/.exec(line);
      const local = /"LocalAddr":"([^"]*)"/.exec(line);
      if (!url || !local) continue;
      if (!portRe.test(local[1])) continue;
      hit = url[1]; // 顺序遍历 → 留下最新的一条
    }
    if (hit) return hit; // 这份里有就直接用，别再翻更早的
  }
  return null;
}

/** 手动兜底：server/data/public-url.txt 里粘一行地址 */
export function readUrlFile(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    return /^https?:\/\//.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * 清洗桥接地址：只留协议 + 主机（+端口）。
 * 带路径/尾斜杠会让后面的 /lb-api/... 拼错，统一去掉。
 * @returns {string|null}
 */
export function normalizeBridgeUrl(url) {
  const s = String(url || '').trim();
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(s.replace(/\/+$/, ''))) return null;
  return s.replace(/\/+$/, '');
}
