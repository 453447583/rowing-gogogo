// WebSocket 网络客户端：JSON 协议 + 事件分发
//
// 稳定性要点（局域网实测踩过的坑）：
//  1. 应用层心跳：ws 协议层的 ping 只有服务端能发，客户端感知不到"假在线"，
//     所以这里自己发 {t:'ping'}，超过 26s 没收到任何消息就主动断开重连。
//  2. 断线自动重连：1s / 2s / 3s … 退避重试，最多 12 次。
//  3. 会话续座：session 存在 sessionStorage（同一页签刷新保留，开两个页签不会串），
//     重连时带给服务器，服务器把它送回原来的座位，赛艇 / 房主身份都不丢。
//  4. 断线期间的控制消息进队列（pick/start/backLobby 等），连上后按顺序补发；
//     快照 / 状态这类时效性强的消息直接丢，补发只会让人瞬移。
import { isOnlineHost, ONLINE_HINT } from './onlineHost.js';

const QUEUE_TYPES = new Set([
  'pick', 'ready', 'map', 'weather', 'mode', 'format', 'teamSwitch', 'teamName',
  'settings', 'start', 'nextRound', 'backLobby',
]);
const MAX_RETRY = 12;
const STALE_MS = 26000;
// RTT 探针间隔：2 秒。旧版 8 秒一次 + 0.7 平滑把波动全抹平了，
// 右上角角标看起来像"永远 12ms"，不是真实网络状况。
const PING_MS = 2000;

export class NetClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.myId = null;
    this.connected = false;
    this.session = null;
    this.hostName = '';
    this.name = '';
    this.manualClose = false;
    // lan = 老局域网（ws://IP:3001）；online = Render 同源（wss://域名/ws）
    this.mode = 'lan';
    this.queue = [];
    this.lastRecv = 0;
    // 最近一次 ping 的往返延迟（毫秒），0 表示还没测到。
    // BOSS 技能的预警时长会扣掉一半 RTT，好让红圈在主机和客机上同时消失。
    this.rtt = 0;
    this.attempt = 0;
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  connect(host, name, avatar, mode = 'lan') {
    this.hostName = host || '';
    this.mode = mode === 'online' ? 'online' : 'lan';
    // 网络层再兜一道（界面已经拦了）：线上模式是同源 /ws，本地那台
    // node server/server.js 同样有 /ws，不拦的话 localhost 也能进线上房间。
    if (this.mode === 'online' && !isOnlineHost()) {
      return Promise.reject(new Error(ONLINE_HINT));
    }
    this.rtt = 0; // 换线路/重连后旧延迟不能留着冒充新连接的实测值
    this.name = String(name || '玩家').slice(0, 10);
    // 头像随 hello 一起注册；重连时会原样重发
    this.avatar = typeof avatar === 'string' ? avatar : '';
    this.manualClose = false;
    this.attempt = 0;
    this.session = this.#ensureSession();
    return this.#open();
  }

  #ensureSession() {
    try {
      let s = sessionStorage.getItem('rr-session');
      if (!s) {
        s = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        sessionStorage.setItem('rr-session', s);
      }
      return s;
    } catch {
      return 's' + Math.random().toString(36).slice(2, 10);
    }
  }

  #url() {
    // 线上：和网页同源，只走一个公网端口（Render 的 443 -> 服务内部 PORT）。
    // 必须是 wss：HTTPS 页面里用 ws:// 会被浏览器拦，Render 也会 301 到 TLS。
    if (this.mode === 'online') {
      if (typeof location === 'undefined') return 'ws://localhost:3000/ws';
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws`;
    }
    // 局域网：完全保留老逻辑（默认 3001，?ws= 可覆盖）
    const hostname = (this.hostName || location.hostname || 'localhost')
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/:\d+$/, '');
    // 默认 WS 走 3001；?ws=3414 或 window.__WS_PORT__ 可覆盖（调试 / 改端口时用）
    let port = 3001;
    try {
      const q = new URLSearchParams(location.search).get('ws');
      if (q) port = Number(q) || 3001;
      else if (typeof window !== 'undefined' && Number(window.__WS_PORT__)) port = Number(window.__WS_PORT__);
    } catch { /* 没有 location 的环境用默认值 */ }
    return `ws://${hostname}:${port}`;
  }

  #open() {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.#url());
      } catch (e) {
        reject(e);
        return;
      }
      this.ws = ws;
      let settled = false;
      const wasRetry = this.attempt > 0;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error('连接超时'));
      }, 5000);
      const settleOk = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(msg);
      };
      const settleErr = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      };

      ws.onopen = () => {
        // 连接后必须发送 hello 注册（带 session，服务器据此把老座位还给我们）
        this.#raw({ t: 'hello', name: this.name, session: this.session, avatar: this.avatar });
      };
      ws.onerror = () => settleErr(new Error('无法连接服务器'));
      ws.onclose = () => {
        const wasConnected = this.connected;
        this.#stopTimers();
        this.connected = false;
        this.rtt = 0;
        this.myId = null;
        if (this.ws === ws) this.ws = null;
        if (!wasConnected) {
          // 首连就失败：把错误抛给调用方，由界面提示；重连中的失败交给 onclose 继续排下一次
          settleErr(new Error('连接已关闭'));
          return;
        }
        if (this.manualClose) return;
        this.#emit('reconnecting', { attempt: this.attempt });
        this.#scheduleReconnect();
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        this.lastRecv = Date.now();
        if (msg.t === 'pong') {
          // 服务器把 ts 原样带回：直接显示最新一次实测 RTT，不做平滑，
          // 这样角标会随真实网络抖动起伏（技能预警扣延迟也用这个值）。
          const sent = Number(msg.ts);
          if (Number.isFinite(sent)) {
            const rtt = performance.now() - sent;
            if (rtt >= 0 && rtt < 5000) this.rtt = rtt;
          }
          return;
        }
        if (msg.t === 'welcome') {
          this.myId = msg.id;
          this.connected = true;
          this.attempt = 0;
          this.#startHeartbeat();
          this.#flush();
          this.#emit('welcome', msg);
          if (wasRetry) this.#emit('reconnected', msg);
          settleOk(msg);
          return;
        }
        this.#emit(msg.t, msg);
      };
    });
  }

  #startHeartbeat() {
    clearInterval(this.pingTimer);
    this.lastRecv = Date.now();
    const beat = () => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // 后台标签页的定时器会被浏览器限流，这时不能用"多久没消息"判死
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!hidden && Date.now() - this.lastRecv > STALE_MS) {
        try { ws.close(); } catch {}
        return;
      }
      // 带上发送时间戳，服务器原样回传，这里就能算出 RTT
      this.#raw({ t: 'ping', ts: performance.now() });
    };
    // 连上先打一次，别等 1 秒才有第一个延迟样本（第一关开场就在放技能）
    beat();
    this.pingTimer = setInterval(beat, PING_MS);
  }

  #stopTimers() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  #scheduleReconnect() {
    if (this.manualClose || this.reconnectTimer) return;
    this.attempt += 1;
    if (this.attempt > MAX_RETRY) {
      this.#emit('disconnect', { lost: true });
      return;
    }
    const delay = Math.min(800 * this.attempt, 4000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      this.#open().catch(() => { /* onclose 里会继续排下一次 */ });
    }, delay);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #raw(msg) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
    }
    return false;
  }

  on(type, fn) {
    this.addEventListener(type, fn);
    return () => this.removeEventListener(type, fn);
  }

  send(msg) {
    if (this.connected && this.#raw(msg)) return true;
    // 断线重连期间只缓存"控制类"消息，画面同步类过时就作废
    if (!this.manualClose && QUEUE_TYPES.has(msg.t) && this.queue.length < 60) {
      this.queue.push(msg);
    }
    return false;
  }

  #flush() {
    if (!this.queue.length) return;
    const items = this.queue;
    this.queue = [];
    for (const m of items) this.#raw(m);
  }

  close() {
    this.manualClose = true;
    this.#stopTimers();
    this.queue = [];
    this.connected = false;
    this.myId = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch {} }
  }
}
