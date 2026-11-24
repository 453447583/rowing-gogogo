// 线上联机入口的域名白名单（2026-11-24）
//
// 为什么需要这一层：
//   线上模式走的是「同源 /ws」（见 NetClient.#url）。而本地跑 `node server/server.js`
//   时，同一个进程既托管 dist 静态页、又开了同源 /ws —— 于是 http://localhost:3000
//   点「联机对战」也能连上本地服务器，看起来线上模式在本地可用了。
//   后果是本地调试的房间和线上房间混在一个入口里，排查问题时根本分不清对端是谁。
//
// 口径：只有部署在 Render 线上网址（*.onrender.com，或用 VITE_ONLINE_HOST 构建时
// 追加的域名）才允许进入线上联机；localhost / 127.x / 内网 IP / 任意裸 IP 一律拒绝。
// 注意这里拦的是「从哪个页面进线上模式」，不是拦服务器本身：
// 局域网模式（30xx 端口 ws://IP:3001）完全不受影响，本地依旧能联机调试。

// 线上服务当前域名（Render 服务名 rowing-gogogo）
const DEFAULT_ONLINE_HOSTS = ['rowing-gogogo.onrender.com'];

// 构建期追加：VITE_ONLINE_HOST=a.example.com,b.example.com npm run build
// 只认构建时写进产物的值，运行时没法用 URL 参数绕过。
// 写成 `import.meta.env && ...` 而不是可选链：Vite 的静态替换匹配的是这个完整表达式。
const ENV_RAW = (import.meta.env && import.meta.env.VITE_ONLINE_HOST) || '';
const ENV_HOSTS = String(ENV_RAW)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const ONLINE_HOSTS = [...DEFAULT_ONLINE_HOSTS, ...ENV_HOSTS];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 当前页面是否在线上网址下（决定「联机对战」能不能用）。
 * @param {string} [hostname] 默认取 location.hostname，方便单测直接传值。
 */
export function isOnlineHost(hostname) {
  const fromLocation = typeof location !== 'undefined' ? location.hostname : '';
  const host = String(hostname === undefined ? fromLocation : hostname || '')
    .toLowerCase()
    .replace(/:\d+$/, '');
  if (!host) return false; // file:// 打开、或拿不到 hostname
  // 本机 / 内网 / 任何裸 IP 都不认（含 ::1、[::1]）
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === '::1' || host === '[::1]' || host === '0.0.0.0') return false;
  if (IPV4_RE.test(host)) return false;
  if (ONLINE_HOSTS.includes(host)) return true;
  // Render 换了服务名也不至于整个线上入口挂掉
  return host.endsWith('.onrender.com');
}

/** 给界面的提示文案用。 */
export const ONLINE_HINT = '线上联机只能在线上网址使用（本地请选「局域网对战」或「练习模式」）';
