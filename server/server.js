import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BOATS } from '../src/data/boats.js';
import { MAPS, WEATHERS } from '../src/data/maps.js';
import { BOSS_LEVELS } from '../src/data/bosses.js';

const WEATHER_IDS = [...WEATHERS.map((w) => w.id), 'random'];
const MODE_IDS = ['race', 'item', 'launch', 'boss', 'arena'];
const BOSS_DIFFICULTIES = ['normal', 'elite', 'nightmare'];
// 竞技场是 1v1：这个房间（单房间服务器）同时最多坐 2 个真人。
// AI 对手由客户端 ArenaMode 自己生成，服务员不掺和。
const ARENA_MAX_PLAYERS = 2;
// 道具模式中继消息（比赛内转发给其他玩家）
const RELAY_TYPES = new Set([
  // itemHeld：吃到/用掉道具时广播一次「这个人当前手上有什么」，覆盖式同步。
  // 原来的 itemPick 不带道具名、itemUse 只有 7 个分支发，都没法准确显示名次栏图标。
  'itemPick', 'itemUse', 'itemHeld', 'itemHit', 'itemFx', 'lightning',
  // 怪物模式：主机广播 BOSS 状态 / 召唤 / 关卡推进，客户端回传命中
  'bossState', 'bossHit', 'bossSummon', 'bossStage', 'bossEnd', 'bossCast',
  // 破韧跪地：主机判定满槽、客机跟着跪。漏了这条客机永远看不到 BOSS 破防
  'bossStagger',
  // 双人配合：沉船通报 / 救援 / 协同合击（进度同步 + 预备握手 + 完整演出广播）
  'bossDown', 'bossRescue', 'bossComboState', 'bossComboArm', 'bossComboFire',
  // 技能演出 / 落雷 / 安全柱 / 熔岩 / 诱饵 / 血包 / 火力核心
  'bossSkill', 'bossThunder', 'bossVortex', 'bossPillar', 'bossLava', 'bossLure',
  'healPack', 'healSpawn', 'fireCoreSpawn', 'fireCore',
  // 第二关四核波次：核心位置 / 单个核心扣血 / 全破后的弱点窗口 / 波次结束
  'bossCoreWave', 'bossCoreHit', 'bossCoreWin', 'bossCoreWaveEnd',
  // 第四关血祭祭坛：主机广播落点，完成的玩家广播结果
  'bossAltarSpawn', 'bossAltarDone',
  // 过关传送门：门的落点 + 每人「已准备」状态。
  // 这两条不转发的话：客机永远看不到门，主机也永远凑不齐 pt.ready，
  // 整局就卡在结算页上等一个不会来的切关。
  'bossPortal', 'bossReady',
  // 潮汐竞技场（1v1）：伤害/血量归受击方算，核心/擂台/回合归房主算，撞击由被撞方本地应用
  'arenaDmg', 'arenaHp', 'arenaRound', 'arenaSkill', 'arenaEnd',
  'arenaCore', 'arenaRing', 'arenaRam',
  // 组队数据统计：救援（护盾墙挡弹）由施放者端上报，服务器累计后进结算
  'itemStat',
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
const HTTP_PORT = Number(process.env.PORT) || 3000;
const WS_PORT = Number(process.env.WS_PORT) || 3001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

// ---------- 静态文件服务 ----------
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(DIST, urlPath);
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- 单实例保护 ----------
// 以前重复启动会抛未捕获的 EADDRINUSE，栈里只有 node:net，看不出「服务器其实
// 已经好好地在跑」。先探一下同端口是不是本游戏，是就直接提示访问、不要再启第二个。
function probeOwnServer(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) { finish(body.includes('激流勇进')); req.destroy(); }
      });
      res.on('end', () => finish(body.includes('激流勇进')));
      res.on('error', () => finish(false));
    });
    req.on('error', () => finish(false));
    req.on('timeout', () => { finish(false); req.destroy(); });
  });
}

// 只有「用默认 3000 直接启动」才做单实例判断；测试脚本都显式指定 PORT/WS_PORT，
// 它们要的是各自独立的实例，别被这里拦下。
if (!process.env.PORT && (await probeOwnServer(HTTP_PORT))) {
  console.log('========================================');
  console.log('  《激流勇进》服务器已经在运行');
  console.log(`  直接打开:  http://localhost:${HTTP_PORT}`);
  console.log(`  无需重复启动；要重启请先关闭占用 ${HTTP_PORT}/${WS_PORT} 的旧进程`);
  console.log('========================================');
  process.exit(0);
}

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[端口占用] HTTP 端口 ${HTTP_PORT} 已被其它程序占用（不是本游戏服务器）。`);
    console.error('  换端口:  PORT=3010 WS_PORT=3011 npm run server');
    console.error(`  查占用:  netstat -ano | findstr :${HTTP_PORT}`);
  } else {
    console.error('[HTTP 服务异常]', err);
  }
  process.exit(1);
});

httpServer.listen(HTTP_PORT, () => {
  const ips = getLanIps();
  console.log('========================================');
  console.log('  激流勇进 · 局域网主机已启动');
  console.log('========================================');
  console.log(`  本机游玩:  http://localhost:${HTTP_PORT}`);
  for (const ip of ips) {
    console.log(`  朋友加入:  http://${ip}:${HTTP_PORT}`);
  }
  console.log(`  线上 WebSocket 入口:  /ws（同源，部署后用 wss://域名/ws）`);
  console.log('========================================');
});

function getLanIps() {
  const res = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) res.push(iface.address);
    }
  }
  return res.length ? res : ['127.0.0.1'];
}

// ---------- 游戏房间 ----------
const room = {
  players: new Map(), // id -> player
  phase: 'lobby',     // lobby | racing | intermission
  mapId: 'canyon',
  weather: 'day',     // day | dusk | storm | random
  mode: 'race',       // race | item | launch | boss
  // 赛制：solo = 个人，team = 组队 3v3。怪物模式不参与赛制。
  format: 'solo',
  teams: new Map(),   // id -> 'blue' | 'red'（仅组队赛制）
  teamNames: { blue: '蓝队', red: '红队' },
  // 单局积分制：队伍分（blue/red），每局结束累加
  teamScores: { blue: 0, red: 0 },
  roundWins: { blue: 0, red: 0 },
  // 组队数据：id -> { hit, taken, rescue }（命中 / 被击 / 救援）
  itemStats: new Map(),
  settings: {
    laps: 3, rounds: 1, aiCount: 0, difficulty: 'normal',
    // 组队赛制下每个 AI 的队伍：由房主在左下角选手行里逐个分配（null = 待分队）
    aiTeams: [],
    // 比赛设置：single = 单场定胜负，bestOf3 = 三局两胜（打满 3 局），points3 = 三局积分制
    matchFormat: 'single',
    // 怪物模式分支：classic = 闯关（现有玩法），hex = 海克斯（每关技能顺序随机）
    variant: 'classic',
  },
  round: 0,
  raceSeq: 0,         // 每开一局 +1：客户端靠它丢掉重复/过期的 start
  hostId: null,       // 显式房主：掉线缓冲期先不换人，座位真没了才顺延
  scores: new Map(),  // id -> 总积分
  roundEndTimer: null,
  raceWatchdog: null, // 整局超时兜底（全员不进圈时房间不会永远停在 racing）
};

// 心跳：浏览器会自动回 pong，用来踢掉"半开"连接（拔网线 / 关笔记本 / 掉 Wi-Fi）
const HEARTBEAT_MS = 10000;
// 掉线后座位保留多久：短暂抖动重连回来，赛艇和房主身份都不丢
const GHOST_GRACE_MS = 15000;
// 单局最长时长，超时强制结算（防止房间卡在 racing 后，下一局永远开不了）
const RACE_MAX_MS = 25 * 60 * 1000;
// 多久收不到"我还在比赛里"的迹象（state/gate）就认为这局已经没人跑了
const RACE_IDLE_MS = 20000;
// 单条连接允许积压的字节数：弱网时宁可丢一帧快照，也不让内存原地起飞
const MAX_BUFFERED = 512 * 1024;

const wss = new WebSocketServer({ port: WS_PORT });

// 线上（Render）入口：公网只转发一个端口，所以把 WebSocket 挂在网页的同一个
// HTTP 服务上，路径固定 /ws。浏览器侧用 wss://<域名>/ws，不走 3001。
// 局域网入口仍是上面的 wss（3001），老玩家填 IP 的流程一个字不用改。
const wssOnline = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { pathname = String(req.url || '').split('?')[0]; }
  if (pathname !== '/ws') { socket.destroy(); return; }
  wssOnline.handleUpgrade(req, socket, head, (ws) => wssOnline.emit('connection', ws, req));
});

// 原来的日志是同步打印的，端口冲突时也会先显示「已启动」，误导排查。
// 放到真正 listening 之后再报；冲突则给出明确提示而不是抛未捕获异常。
wss.on('listening', () => console.log(`WebSocket 服务已启动 (端口 ${WS_PORT})`));
wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[端口占用] WebSocket 端口 ${WS_PORT} 已被占用。`);
    console.error('  换端口:  PORT=3010 WS_PORT=3011 npm run server');
    console.error(`  查占用:  netstat -ano | findstr :${WS_PORT}`);
  } else {
    console.error('[WebSocket 服务异常]', err);
  }
  process.exit(1);
});

let nextId = 1;

function isOnline(p) {
  return !!p && !!p.ws && p.ws.readyState === 1;
}

/** 占座的真人数（含 15s 重连缓冲里的座位：位置是他的，不能被别人顶掉） */
function humanCount() {
  return [...room.players.values()].filter((p) => !p.ai).length;
}

const TEAM_IDS = ['blue', 'red'];

/** 某队的真人数量（AI 在开赛时才生成，赛前分队只看真人） */
function teamHumans(team) {
  return [...room.players.values()].filter((p) => !p.ai && room.teams.get(p.id) === team).length;
}

/** 房主手动分配的 AI 队伍列表：长度对齐 aiCount，未分配的位置为 null */
function aiTeamsList() {
  if (room.mode === 'boss' || room.mode === 'arena') return [];
  const src = Array.isArray(room.settings.aiTeams) ? room.settings.aiTeams : [];
  const n = Math.max(0, Math.min(3, Number(room.settings.aiCount) || 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(src[i] === 'blue' || src[i] === 'red' ? src[i] : null);
  }
  return out;
}

/** 某队已占的位置：真人 + 已分配的 AI（每队上限 3）。exceptAi 用于给正在换队的 AI 让位 */
function teamOccupied(team, exceptAi = null) {
  let n = teamHumans(team);
  const list = aiTeamsList();
  for (let i = 0; i < list.length; i++) {
    if (exceptAi === 'ai' + (i + 1)) continue;
    if (list[i] === team) n++;
  }
  return n;
}

/** 新进组队房间的真人自动落到人少的一队；两队相同进蓝队 */
function assignTeam(p) {
  if (room.format !== 'team') { room.teams.delete(p.id); return; }
  if (room.teams.has(p.id)) return;
  const blue = teamHumans('blue');
  const red = teamHumans('red');
  let team = 'blue';
  // 注意：这里要写 'red' 字符串。以前写成 team = red 会把人数 0 存进队伍表，
  // 导致后续所有人分队 / 开赛校验全部错乱。
  if (blue > red || blue >= 3) team = 'red';
  // 容量要连已分配的 AI 一起算，避免把新玩家塞进已经满 3 人的队
  if (teamOccupied(team) >= 3) {
    const other = team === 'blue' ? 'red' : 'blue';
    if (teamOccupied(other) < 3) team = other;
  }
  if (teamOccupied(team) < 3) room.teams.set(p.id, team);
}

/** 组队模式下没有分队的真人补一次分队（切赛制 / 老房间兼容用） */
function ensureTeams() {
  if (room.format !== 'team') return;
  for (const p of room.players.values()) {
    if (!p.ai) assignTeam(p);
  }
}

function statsFor(id) {
  let s = room.itemStats.get(id);
  if (!s) { s = { hit: 0, taken: 0, rescue: 0 }; room.itemStats.set(id, s); }
  return s;
}

function boatName(id) {
  return BOATS.find((b) => b.id === id)?.name || '该赛艇';
}

function sendTo(p, msg) {
  if (!isOnline(p)) return;
  // 弱网积压时只丢"可再生"的快照；过门/完赛/道具这类控制消息必须送达，
  // 否则一丢就是名次与结算永久错乱（以前这里把所有消息一起丢了）。
  if (p.ws.bufferedAmount > MAX_BUFFERED && msg.t === 'snap') return;
  try { p.ws.send(JSON.stringify(msg)); } catch { /* 连接刚好断了，交给 close */ }
}

function toastTo(p, msg) {
  sendTo(p, { t: 'toast', msg });
}

function broadcast(msg, exclude = null) {
  for (const p of room.players.values()) {
    if (p.id === exclude) continue;
    sendTo(p, msg);
  }
}

// 头像字段：内置头像 id（如 'wave'）或客户端压缩好的 dataURL，限制长度防止恶意大包
function safeAvatar(v) {
  const s = typeof v === 'string' ? v : '';
  if (/^[a-z0-9_-]{1,24}$/.test(s)) return s;
  if (s.length <= 40000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) return s;
  return null;
}

function rosterPayload() {
  return {
    t: 'roster',
    mapId: room.mapId,
    weather: room.weather,
    mode: room.mode,
    format: room.format,
    teams: Object.fromEntries(room.teams),
    teamNames: room.teamNames,
    settings: room.settings,
    phase: room.phase,
    round: room.round,
    raceSeq: room.raceSeq,
    hostId: getHostId(),
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, boatId: p.boatId, ai: p.ai || false,
      avatar: p.avatar || null,
      ready: p.ready === true,
      offline: !p.ai && !isOnline(p),
      team: room.teams.get(p.id) || null,
    })),
  };
}

function welcomeFor(p) {
  return {
    t: 'welcome', id: p.id, hostId: getHostId(),
    mapId: room.mapId, weather: room.weather, mode: room.mode,
    format: room.format, teams: Object.fromEntries(room.teams),
    teamNames: room.teamNames,
    settings: room.settings, phase: room.phase, round: room.round,
    raceSeq: room.raceSeq,
    lanIps: getLanIps(),
    players: rosterPayload().players,
  };
}

function getHostId() {
  // 座位还在（哪怕正在 15s 重连缓冲里）就还是他：避免网络抖一下房主就换人
  const host = room.players.get(room.hostId);
  if (host && !host.ai) return host.id;
  const next = [...room.players.values()].find((p) => !p.ai && isOnline(p));
  room.hostId = next ? next.id : null;
  return room.hostId;
}

// 两个入口（局域网 3001 / 线上同源 /ws）共用同一套房间逻辑，不复制代码
function handleConnection(ws) {
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* 出错统一走 close */ });

  // ---- 加入 / 断线重连 ----
  const doHello = (msg) => {
    const name = String(msg.name || '玩家').slice(0, 10);
    const key = String(msg.session || '').slice(0, 64);
    const avatar = safeAvatar(msg.avatar);
    // 同一个会话回来：直接坐回原来的位子（赛艇、房主身份、积分都还在）
    if (key) {
      const prev = [...room.players.values()].find((p) => !p.ai && p.session === key);
      if (prev) {
        clearTimeout(prev.graceTimer);
        prev.graceTimer = null;
        // 重连回来的人不在这里强行标记"不在比赛里"：网络抖一下（双方同时掉线几百毫秒）
        // 会被巡检误判成"没人跑了"而把整局作废。真实客户端在 welcome 之后会立刻
        // 用 inGame 上报自己到底还在不在比赛里 —— 刷新出来的新页面报 false，
        // 只是抖了一下的老页面报 true。
        const old = prev.ws;
        prev.ws = ws;
        prev.name = name;
        prev.session = key;
        if (avatar) prev.avatar = avatar;
        if (old && old !== ws) { try { old.close(); } catch {} } // 旧连接（重复页签）让位
        me = prev;
        assignTeam(me); // 重连保留原队伍；老房间没队则补一次
        sendTo(me, { ...welcomeFor(me), resumed: true });
        broadcast(rosterPayload());
        return;
      }
    }
    const id = 'p' + nextId++;
    // 竞技场 1v1：坐满 2 个真人后，第三个人直接劝退。
    // 不"先坐下再说"——那样开局时人数超标，房主点了开始只会收到一条 toase，
    // 房间就卡在那里谁都开不了（单房间服务器没有第二个房间可以分流）。
    if (room.mode === 'arena' && humanCount() >= ARENA_MAX_PLAYERS) {
      try {
        ws.send(JSON.stringify({ t: 'toast', msg: '竞技场是 1v1，房间已满 2 人；等房主切回其他模式再来' }));
      } catch { /* 连接已经断了 */ }
      setTimeout(() => { try { ws.close(); } catch {} }, 120);
      return;
    }
    me = {
      id, ws, session: key, name,
      boatId: null, ready: false, ai: false, avatar: avatar || null,
      inGame: false, lastRaceAt: 0,
      state: null, prog: -1, lap: 0, bestLap: null,
      finished: false, finishTime: null, laps: [],
      graceTimer: null,
    };
    room.players.set(id, me);
    if (!room.hostId) room.hostId = id; // 房间第一个人当房主
    assignTeam(me); // 组队房间：进房即自动均衡分队
    sendTo(me, welcomeFor(me));
    broadcast(rosterPayload(), id);
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // pong 原样带回客户端的时间戳：客户端据此算 RTT，用来给技能预警做延迟补偿
    if (msg.t === 'ping') {
      try { ws.send(JSON.stringify({ t: 'pong', ts: msg.ts })); } catch {}
      return;
    }
    if (msg.t === 'hello') { doHello(msg); return; }
    if (!me || me.ws !== ws) return;

    // ---- 头像：怪物模式的玩家列表显示；只存内存，本次会话有效 ----
    if (msg.t === 'avatar') {
      const a = safeAvatar(msg.avatar);
      if (a && a !== me.avatar) {
        me.avatar = a;
        broadcast(rosterPayload());
      }
      return;
    }

    // ---- 聊天：大厅与比赛内共用同一条通道 ----
    // 只做纯文本转发（客户端用 textContent 渲染，天然防 XSS），并限制长度与频率。
    if (msg.t === 'chat') {
      const text = String(msg.text ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 60);
      if (!text) return;
      const now = Date.now();
      me.chatAt = (me.chatAt || []).filter((t) => now - t < 5000);
      if (me.chatAt.length >= 3) return; // 5 秒最多 3 条，多的一律丢弃（不回报，免得反被刷）
      me.chatAt.push(now);
      // 队伍频道只在组队赛制下可用；其余情况一律按全部频道处理
      const teamOnly = msg.channel === 'team' && room.format === 'team' && room.teams.has(me.id);
      const out = {
        t: 'chat', id: me.id, name: me.name, text,
        channel: teamOnly ? 'team' : 'all',
      };
      for (const p of room.players.values()) {
        if (p.id === me.id) continue;
        if (teamOnly && room.teams.get(p.id) !== room.teams.get(me.id)) continue;
        sendTo(p, out);
      }
      return;
    }

    // ---- 是否在比赛中（刷新页面 / 主动退赛会上报 false）----
    // 这一条是"房间卡在 racing"的自愈开关：以前所有人刷新后座位还在，
    // phase 永远停在 racing，再点开始只会收到"比赛正在进行中"。
    if (msg.t === 'inGame') {
      me.inGame = msg.on === true;
      me.lastRaceAt = Date.now();
      // 只有"这一局真的有参赛座位"的人退赛才算中断本局。
      // 否则比赛途中新打开页面/围观的人一进来就会把别人的比赛拆了。
      // 而且必须确认已经没有别人还在跑：否则一个人中途退出（或只刷新了自己那一页）
      // 就会把另一个人正在跑的比赛一起作废。
      if (!me.inGame && room.phase === 'racing' && me.boatId) {
        const now = Date.now();
        const othersLive = [...room.players.values()].some((p) => p !== me && !p.ai
          && isOnline(p) && p.inGame && now - p.lastRaceAt < RACE_IDLE_MS);
        if (!othersLive) {
          resetRace();
          broadcast(rosterPayload());
          broadcast({ t: 'lobbyReset' });
          broadcast({ t: 'toast', msg: '有人离开了比赛，本局已中断，请重新选艇准备' });
        }
      }
      return;
    }

    // ---- 选艇（唯一制：先选先得）----
    if (msg.t === 'pick') {
      if (room.phase === 'racing') {
        toastTo(me, '比赛进行中，这局跑完再换艇');
        // 同 ready：把服务器名单和否决回执一起发回去，客户端立刻回滚乐观选择
        sendTo(me, rosterPayload());
        sendTo(me, { t: 'pickResult', ok: false, boatId: msg.boatId });
        return;
      }
      if (!BOATS.some((b) => b.id === msg.boatId)) return;
      if (me.boatId === msg.boatId) {
        sendTo(me, { t: 'pickResult', ok: true, boatId: msg.boatId });
        return;
      }
      const holder = [...room.players.values()].find(
        (p) => p.id !== me.id && p.boatId === msg.boatId,
      );
      if (holder) {
        toastTo(me, `「${boatName(msg.boatId)}」已经被 ${holder.name} 选了，换一艘吧`);
        // 顺手把最新名单推回去，客户端的"已占用"标记不会和服务器脱节
        sendTo(me, rosterPayload());
        // 明确否决：客户端的乐观选艇必须立刻收回，否则本地显示已选、
        // 服务器却认为没选，房主点开始就会一直提示"还没选赛艇"
        sendTo(me, { t: 'pickResult', ok: false, boatId: msg.boatId });
        return;
      }
      me.boatId = msg.boatId;
      // 换艇等于重新表态：之前的"准备"作废，避免换完艇房主以为已就绪
      me.ready = false;
      broadcast(rosterPayload());
      sendTo(me, { t: 'pickResult', ok: true, boatId: msg.boatId });
      return;
    }

    // ---- 准备 / 取消准备（房主以外的人）----
    if (msg.t === 'ready') {
      if (room.phase === 'racing') {
        toastTo(me, '比赛进行中，这局跑完再说');
        // 让客户端的乐观"已准备"回滚，避免它以为准备成功、房主那边却是未准备
        sendTo(me, rosterPayload());
        return;
      }
      if (me.id === getHostId()) return; // 房主点开始就等于准备，不需要自己盖戳
      const want = msg.ready !== false;
      if (want && !me.boatId) {
        toastTo(me, '先选一艘赛艇，再点准备');
        sendTo(me, rosterPayload());
        return;
      }
      if ((me.ready === true) === want) return;
      me.ready = want;
      broadcast(rosterPayload());
      return;
    }

    // ---- 主机设置：地图 / 天气 / 模式 / 赛制只有房主能改 ----
    // 一律在"非比赛进行中"生效（intermission 也允许，避免上一局刚结束、房主
    // 改设置被静默吞掉，客户端还停在旧值上）。拒绝必须回话，不能点了没反应。
    if (msg.t === 'map') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主可以更改地图 / 天气 / 模式'); return; }
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这一局跑完再换地图'); return; }
      if (!MAPS.some((m) => m.id === msg.mapId)) return;
      if (room.mapId === msg.mapId) return;
      room.mapId = msg.mapId;
      broadcast(rosterPayload());
      return;
    }
    if (msg.t === 'weather') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主可以更改地图 / 天气 / 模式'); return; }
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这一局跑完再换天气'); return; }
      if (!WEATHER_IDS.includes(msg.weatherId)) return;
      if (room.weather === msg.weatherId) return;
      room.weather = msg.weatherId;
      broadcast(rosterPayload());
      return;
    }
    if (msg.t === 'mode') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主可以更改地图 / 天气 / 模式'); return; }
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这一局跑完再换模式'); return; }
      // 兼容两种字段名：大厅抽屉历史上有发过 mode，选艇屏发的是 modeId
      const modeId = msg.modeId ?? msg.mode;
      if (!MODE_IDS.includes(modeId)) return;
      // 竞技场 3v3 还没做（客户端 ArenaMode 是严格的 1v1 回合制），组队赛制下先挡住
      if (modeId === 'arena' && room.format === 'team') {
        toastTo(me, '竞技场 3v3 还在开发中，先切回个人赛制玩 1v1');
        return;
      }
      // 切到 1v1 前先看人数：人多的时候切过去只会让"开始"永远点不动
      if (modeId === 'arena' && humanCount() > ARENA_MAX_PLAYERS) {
        toastTo(me, `竞技场是 1v1，现在房间里有 ${humanCount()} 人，先请走多余的人`);
        return;
      }
      if (room.mode === modeId) return;
      room.mode = modeId;
      // 只改模式，不动任何人的选艇/准备：客人的状态必须跨设置变更保留
      broadcast(rosterPayload());
      return;
    }

    // ---- 赛制：个人 / 组队（只有房主能改，比赛进行中不可改）----
    if (msg.t === 'format') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主可以更改赛制'); return; }
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这一局跑完再换赛制'); return; }
      const format = msg.format === 'team' ? 'team' : 'solo';
      if (format === 'team' && room.mode === 'arena') {
        toastTo(me, '竞技场 3v3 还在开发中，先切到竞速 / 道具 / 弹射再开组队');
        return;
      }
      if (room.format === format) return;
      room.format = format;
      room.roundWins = { blue: 0, red: 0 };
      room.teamScores = { blue: 0, red: 0 };
      if (format === 'team') {
        // 组队默认三局两胜；玩家仍可在设置里改成单场定胜负或三局积分制
        if (room.settings.matchFormat === 'single') room.settings.matchFormat = 'bestOf3';
        room.settings.rounds = room.settings.matchFormat === 'single' ? 1 : 3;
        ensureTeams();
      } else {
        room.teams.clear();
      }
      // 切赛制会让所有人的准备状态失去意义，统一重置
      for (const p of room.players.values()) if (!p.ai) p.ready = false;
      broadcast(rosterPayload());
      return;
    }

    // ---- 换队：自己随时可以换，房主可以帮所有人换；AI 的队伍只有房主能分配 ----
    if (msg.t === 'teamSwitch') {
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这局跑完再调整队伍'); return; }
      if (room.format !== 'team' || room.mode === 'boss') return;
      const aiMatch = /^ai([1-9]\d*)$/.exec(String(msg.id));
      if (aiMatch) {
        if (me.id !== getHostId()) { toastTo(me, '只有房主可以分配 AI 的队伍'); return; }
        const idx = Number(aiMatch[1]) - 1;
        const list = aiTeamsList();
        if (idx < 0 || idx >= list.length) return;
        const from = list[idx];
        const to = msg.team === 'blue' || msg.team === 'red'
          ? msg.team
          : (from === 'blue' ? 'red' : 'blue');
        if (to === from) return;
        if (teamOccupied(to, 'ai' + (idx + 1)) >= 3) {
          toastTo(me, `${room.teamNames[to] || '目标队伍'}已经满 3 人，先把人换出去`);
          return;
        }
        list[idx] = to;
        room.settings.aiTeams = list;
        broadcast(rosterPayload());
        return;
      }
      const target = room.players.get(msg.id);
      if (!target || target.ai) return;
      // 权限：改自己随时可以；改别人只有房主可以
      if (target.id !== me.id && me.id !== getHostId()) {
        toastTo(me, '只能给自己换队，房主可以帮所有人换队');
        return;
      }
      const from = room.teams.get(target.id);
      const to = msg.team === 'blue' || msg.team === 'red'
        ? msg.team
        : (from === 'blue' ? 'red' : 'blue');
      if (to === from) return;
      if (teamOccupied(to) >= 3) {
        toastTo(me, `${room.teamNames[to] || '目标队伍'}已经满 3 人，先把人换出去`);
        return;
      }
      // 换队只硬限制「目标队未满 3 人」；人数差交给开赛校验，
      // 否则 2 个玩家时任何换队都会变成 2v0，谁都换不动。
      const blueAfter = teamHumans('blue') + (to === 'blue' ? 1 : from === 'blue' ? -1 : 0);
      const redAfter = teamHumans('red') + (to === 'red' ? 1 : from === 'red' ? -1 : 0);
      if (Math.abs(blueAfter - redAfter) > 1) {
        toastTo(me, '已换队；两队人数差超过 1 人，开赛前要再调整一下');
      }
      room.teams.set(target.id, to);
      target.ready = false; // 换队后重新准备
      broadcast(rosterPayload());
      return;
    }

    // ---- 房主改队名：1–8 字符，不能为空、不能与另一队重名 ----
    if (msg.t === 'teamName') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主可以改队名'); return; }
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这局跑完再改队名'); return; }
      if (room.format !== 'team') return;
      const team = msg.team === 'red' ? 'red' : 'blue';
      const other = team === 'blue' ? 'red' : 'blue';
      const name = String(msg.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 8);
      if (!name) { toastTo(me, '队名不能为空'); return; }
      if (name === room.teamNames[other]) { toastTo(me, '两个队伍的队名不能一样'); return; }
      room.teamNames[team] = name;
      broadcast(rosterPayload());
      return;
    }
    if (msg.t === 'settings') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主可以更改比赛设置'); return; }
      if (room.phase === 'racing') { toastTo(me, '比赛进行中，这一局跑完再改设置'); return; }
      const s = msg.settings || {};
      if ([1, 3, 5].includes(s.laps)) room.settings.laps = s.laps;
      // 比赛设置（三选一）：单场定胜负 / 三局两胜（打满 3 局）/ 三局积分制
      if (['single', 'bestOf3', 'points3'].includes(s.matchFormat)) {
        room.settings.matchFormat = s.matchFormat;
        room.settings.rounds = s.matchFormat === 'single' ? 1 : 3;
      }
      if ([1, 3].includes(s.rounds)) {
        room.settings.rounds = s.rounds;
        // 个人赛制保留原有"局数"设置；组队赛制由比赛设置决定局数
        if (room.format === 'solo') room.settings.matchFormat = s.rounds === 1 ? 'single' : 'points3';
      }
      if ([0, 1, 2, 3].includes(s.aiCount)) {
        room.settings.aiCount = s.aiCount;
        // 数量变了：保留已分配的队伍，新增的 AI 先空着等房主分配
        room.settings.aiTeams = aiTeamsList();
      }
      if (BOSS_DIFFICULTIES.includes(s.difficulty)) room.settings.difficulty = s.difficulty;
      if (s.variant === 'hex' || s.variant === 'classic') room.settings.variant = s.variant;
      broadcast(rosterPayload());
      return;
    }

    // ---- 开始比赛 / 下一局（每一种拒绝都要回话，不能静默吞掉）----
    if (msg.t === 'start' || msg.t === 'nextRound') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主能开始比赛'); return; }
      const humans = [...room.players.values()].filter((p) => !p.ai);
      if (room.phase === 'racing') {
        // 房间里没有任何在线真人还在比赛 → 这是刷新/崩溃留下的僵尸局，
        // 直接作废回大厅，不再用一句"比赛正在进行中"把房主卡死。
        // 判定口径必须和巡检一致（20s 内真有位置/过门消息），
        // 否则崩了但 socket 还没断的客户端会把房间永远卡住。
        const now = Date.now();
        const live = humans.some((p) => isOnline(p) && p.inGame && now - p.lastRaceAt < RACE_IDLE_MS);
        if (live) { toastTo(me, '比赛正在进行中'); return; }
        resetRace();
        broadcast(rosterPayload());
        broadcast({ t: 'lobbyReset' });
        toastTo(me, '上一局已中断，已回到大厅，请重新选艇准备');
        return;
      }
      if (!humans.length) { toastTo(me, '房间里还没有玩家'); return; }
      // 房主自己没选艇不该把整局卡死：开赛前给房主补一艘空闲赛艇。
      // （以前这里直接拒绝，提示的是"房主还没选赛艇"，看起来像客户端的问题）
      if (!me.boatId) {
        const used = new Set(humans.map((p) => p.boatId).filter(Boolean));
        const free = BOATS.find((b) => !used.has(b.id)) || BOATS[0];
        me.boatId = free.id;
        broadcast(rosterPayload());
      }
      const offline = humans.find((p) => !isOnline(p));
      if (offline) { toastTo(me, `${offline.name} 正在重连，稍等一下`); return; }
      const noBoat = humans.find((p) => !p.boatId);
      if (noBoat) {
        toastTo(me, `${noBoat.name} 还没选赛艇，请让对方重新选一艘`);
        // 对方本地很可能还显示着"已选艇"（乐观更新没被服务器接受）：
        // 推一份服务器名单 + 否决回执，让它的界面立刻自我纠正
        for (const p of humans.filter((x) => !x.boatId)) {
          if (!p.ws) continue;
          sendTo(p, rosterPayload());
          sendTo(p, { t: 'pickResult', ok: false, boatId: null });
        }
        return;
      }
      // 非房主的真人必须点过"准备"（房主自己点开始就是表态）
      const notReady = humans.filter((p) => p.id !== me.id && !p.ready);
      if (notReady.length) {
        toastTo(me, `${notReady.map((p) => p.name).join('、')} 还没准备`);
        return;
      }
      // ---- 组队赛制开赛校验（怪物模式不参与赛制，直接跳过）----
      if (room.format === 'team' && room.mode !== 'boss') {
        ensureTeams();
        // AI 的队伍由房主在左下角选手行里逐个分配，没分完不能开赛
        const aiList = aiTeamsList();
        const unassigned = aiList.findIndex((tm) => !tm);
        if (unassigned >= 0) {
          toastTo(me, `电脑${unassigned + 1} 还没分队，先在左侧名单里给它选蓝队或红队`);
          return;
        }
        // 开赛人数要连 AI 一起算：双方总人数（真人 + AI）一样就能开赛
        const blueTotal = teamOccupied('blue');
        const redTotal = teamOccupied('red');
        const blueName = room.teamNames.blue || '蓝队';
        const redName = room.teamNames.red || '红队';
        if (!blueTotal && !redTotal) { toastTo(me, '先把玩家分到蓝队和红队'); return; }
        if (blueTotal > 3) { toastTo(me, `${blueName}最多 3 人（含 AI），请调整队伍`); return; }
        if (redTotal > 3) { toastTo(me, `${redName}最多 3 人（含 AI），请调整队伍`); return; }
        if (blueTotal !== redTotal) {
          toastTo(me, `两队人数要一样（含 AI）：${blueName} ${blueTotal} 人 / ${redName} ${redTotal} 人`);
          return;
        }
        // 新比赛从 0 开始累计局胜点 / 队伍分
        if (room.round === 0) {
          room.roundWins = { blue: 0, red: 0 };
          room.teamScores = { blue: 0, red: 0 };
          room.itemStats.clear();
        }
      }
      // 竞技场是严格 1v1：正好 2 个真人才能开（单机练习走单机入口，不走联机房间）
      if (room.mode === 'arena') {
        if (humans.length > ARENA_MAX_PLAYERS) {
          toastTo(me, `竞技场是 1v1，现在房间里有 ${humans.length} 人`);
          return;
        }
        if (humans.length < 2) {
          toastTo(me, '竞技场需要 2 名玩家才能开战');
          return;
        }
      }
      startRound();
      return;
    }

    // ---- 比赛中的状态同步 ----
    if (msg.t === 'state' && room.phase === 'racing') {
      // 玩家只能写自己的状态；主机仅可代发 AI 艇（target.ai）。
      // 不允许主机覆写真人玩家的状态：主机的远程艇数据是滞后的插值视图，
      // 覆写后快照会在真实位置与滞后位置间来回跳变，其他端表现为卡顿慢速。
      const target = room.players.get(msg.id) || me;
      const hostAuth = me.id === getHostId() && msg.auth === true;
      if (target && (target === me || (target.ai && hostAuth))) {
        target.state = [msg.x, msg.z, msg.h, msg.s, msg.b ? 1 : 0, msg.y ?? 0,
          msg.vx ?? 0, msg.vz ?? 0, msg.r ?? 0, hostAuth ? 1 : 0];
        // 还在发位置 = 还在比赛里，房间自愈巡检据此判断"有没有活人"
        if (target === me) { me.inGame = true; me.lastRaceAt = Date.now(); }
      }
      return;
    }

    // ---- 航点/圈数事件（仅主机可代报 AI）----
    if (msg.t === 'gate' && room.phase === 'racing') {
      const target = room.players.get(msg.id) || me;
      if (!target || (target !== me && !(target.ai && me.id === getHostId()))) return;
      if (target === me) { me.inGame = true; me.lastRaceAt = Date.now(); }
      handleGate(target, msg);
      return;
    }

    // ---- 道具模式：中继道具/闪电消息给其他玩家 ----
    if (RELAY_TYPES.has(msg.t) && room.phase === 'racing') {
      // 组队数据：命中 / 被击 / 救援（只统计玩家之间；AI 打的、自己打自己不算）
      if (msg.t === 'itemHit') {
        const by = msg.by || me.id;
        const victim = room.players.get(msg.id);
        if (victim && room.players.has(by) && victim.id !== by) {
          statsFor(by).hit += 1;
          statsFor(victim.id).taken += 1;
        }
      } else if (msg.t === 'itemFx' && msg.fx === 'angel' && msg.by) {
        const by = msg.by;
        const target = msg.id;
        if (by !== target && room.players.has(by) && room.players.has(target)) {
          statsFor(by).rescue += 1;
        }
      } else if (msg.t === 'itemStat' && msg.kind === 'rescue' && msg.by) {
        if (room.players.has(msg.by)) statsFor(msg.by).rescue += 1;
      }
      broadcast(msg, me.id);
      return;
    }

    // ---- 返回大厅 ----
    if (msg.t === 'backLobby') {
      if (me.id !== getHostId()) { toastTo(me, '只有房主能回大厅'); return; }
      resetRace();
      broadcast(rosterPayload());
      broadcast({ t: 'lobbyReset' }); // 所有人都回到选艇屏（以前只有房主自己换了屏）
      return;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    if (me.ws !== ws) return; // 座位已经被新连接接管（重连/重复页签），别误删
    me.ws = null;
    // 不立刻踢人：先给 15s 重连窗口，赛艇与房主身份都留着
    clearTimeout(me.graceTimer);
    me.graceTimer = setTimeout(() => removePlayer(me.id), GHOST_GRACE_MS);
    broadcast(rosterPayload());
  });
}

wss.on('connection', handleConnection);
wssOnline.on('connection', handleConnection);

function removePlayer(id) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.graceTimer);
  room.players.delete(id);
  room.teams.delete(id);
  room.itemStats.delete(id);
  if (room.hostId === id) {
    room.hostId = null;
    getHostId(); // 顺延给下一个在线真人
  }
  broadcast({ t: 'left', id });
  if (room.players.size === 0) resetRace();
  else broadcast(rosterPayload());
}

// 心跳巡检：ws 没在 10s 内回 pong，就当连接已死直接断开
const heartbeatTimer = setInterval(() => {
  for (const ws of [...wss.clients, ...wssOnline.clients]) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { try { ws.terminate(); } catch {} }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeatTimer));
wssOnline.on('close', () => clearInterval(heartbeatTimer));

function startRound() {
  clearTimeout(room.roundEndTimer);
  room.roundEndTimer = null;
  room.phase = 'racing';
  room.round += 1;
  room.raceSeq += 1; // 单局序号：客户端用它识别"这一局是不是新的一局"

  // 清理旧 AI，按设置生成新 AI
  for (const [id, p] of [...room.players]) {
    if (p.ai) {
      room.players.delete(id);
      room.teams.delete(id);
      room.itemStats.delete(id);
    }
  }
  const usedBoats = new Set(
    [...room.players.values()].map((p) => p.boatId).filter(Boolean),
  );
  // 怪物模式现在也允许 AI 陪练；竞技场不塞 —— AI 对手由客户端 ArenaMode 自己生成
  const noAi = room.mode === 'arena';
  // 组队赛制：按房主在左下角名单里逐个分配好的队伍生成 AI
  const aiTeams = aiTeamsList();
  for (let i = 0; i < (noAi ? 0 : room.settings.aiCount); i++) {
    const free = BOATS.filter((b) => !usedBoats.has(b.id));
    if (!free.length) break;
    const pick = free[Math.floor(Math.random() * free.length)];
    usedBoats.add(pick.id);
    const id = 'ai' + (i + 1);
    const team = room.format === 'team' && room.mode !== 'boss' ? (aiTeams[i] || null) : null;
    // 组队模式还没分队的 AI 不开赛（开赛校验已拦截，这里兜底）
    if (room.format === 'team' && room.mode !== 'boss' && !team) break;
    room.players.set(id, {
      id, ws: null, name: `电脑${i + 1}`, boatId: pick.id, ai: true,
      team,
      state: null, prog: -1, lap: 0, bestLap: null, finished: false, finishTime: null,
    });
    if (team) room.teams.set(id, team);
  }

  // 重置比赛状态
  for (const p of room.players.values()) {
    p.state = null;
    p.prog = -1;
    p.lap = 0;
    p.bestLap = null;
    p.finished = false;
    p.finishTime = null;
    p.laps = [];
    // 开局即视为"在比赛中"，客户端后续的 state/gate 会持续续期
    p.inGame = !p.ai;
    p.lastRaceAt = Date.now();
  }

  const order = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, boatId: p.boatId, ai: p.ai, avatar: p.avatar || null,
    team: room.teams.get(p.id) || null,
  }));

  // 天气：随机 = 开赛时抽取一个具体天气
  let weather = room.weather;
  if (room.mode === 'boss') {
    // 怪物模式天气由关卡自动推进，第 1 关固定晴朗
    weather = BOSS_LEVELS[0].weather;
  } else if (weather === 'random') {
    const ids = WEATHERS.map((w) => w.id);
    weather = ids[Math.floor(Math.random() * ids.length)];
  }

  broadcast({
    t: 'start',
    raceSeq: room.raceSeq,
    mapId: room.mapId,
    weather,
    mode: room.mode,
    format: room.format,
    teamNames: room.teamNames,
    matchFormat: room.settings.matchFormat,
    laps: room.settings.laps,
    round: room.round,
    rounds: room.settings.rounds,
    difficulty: room.settings.difficulty,
    // 只有怪物模式用得上：classic = 闯关，hex = 海克斯（每关技能顺序随机）
    variant: room.settings.variant || 'classic',
    order,
  });

  // 整局兜底：没人冲线（挂机/掉线）时房间也不会永远停在 racing。
  // 竞技场没有"冲线"这回事，回合归客户端房主控；这里只负责把卡死的房间拉回大厅 ——
  // 扔进竞速那套 endRound 会广播一份按里程排名的成绩单，竞技场里根本没有那个概念。
  clearTimeout(room.raceWatchdog);
  room.raceWatchdog = setTimeout(() => {
    room.raceWatchdog = null;
    if (room.phase !== 'racing') return;
    if (room.mode === 'arena') {
      resetRace();
      broadcast(rosterPayload());
      return;
    }
    endRound();
  }, RACE_MAX_MS);
}

function handleGate(p, msg) {
  const mapDef = MAPS.find((m) => m.id === room.mapId);
  const N = mapDef?.gates.length || 24;
  // 客户端语义：gate = 刚穿过的门(0..N-1)，lap = 过门后的圈数（过起点线时已 +1）
  // 进度 = (lap-1)*N + gate + 1，单调递增
  const lapCap = room.settings.laps + 1;
  const lap = Math.max(1, Math.min(lapCap, Math.round(Number(msg.lap) || 1)));
  const gate = Math.max(0, Math.min(N - 1, Math.round(Number(msg.gate) || 0)));
  const newProg = (lap - 1) * N + gate + 1;
  // 判定完赛所需的圈号：闭合环线要跑满 laps 圈（客户端过线 lap = laps+1）；
  // 开环赛道只跑一趟（客户端过线 lap = 2）
  const needLap = (mapDef?.baked && !mapDef.baked.closed) ? 2 : lapCap;

  // 重连补报：客户端在断线那几秒穿过的门/冲线没法补发（消息早被丢了），
  // 回来时报一次"我现在到哪了"。只允许向前跳，名次/圈数不会倒退，
  // 否则断一次线这名玩家的服务端进度就永久卡在断线点，之后所有过门被
  // "最多跳 2 门"拒掉，结算时永远缺他一个人。
  if (msg.resync === true) {
    if (newProg > p.prog) {
      p.prog = newProg;
      p.lap = lap;
      broadcast({ t: 'gate', id: p.id, gate, lap, totalTime: null });
    }
    // 冲线消息也可能正好丢在断线窗口里：补报里带上 finish 标记就直接结算
    if (msg.finish === true && !p.finished) {
      p.finished = true;
      p.finishTime = msg.totalTime;
      broadcast({ t: 'finish', id: p.id, time: p.finishTime, bestLap: p.bestLap, finishWindowSeconds: 10 });
      checkRoundEnd();
    }
    return;
  }

  // 第一条进度消息无条件放行：开环赛道（秘境漂流）从中间发车，前几个门在身后，
  // 用"最多跳 2 门"去卡会把之后所有消息全部拒掉，房间就永远停在 racing。
  // 「补圈跳门」放行：客户端改成以船头压终点线为唯一圈数依据后，漏掉几个门
  // 也会直接报 lap+1，newProg 会比 p.prog 跳很远。只放行 lap 恰好 +1
  // 且进度确实前进的消息，其它乱序/倒退仍然拒掉。
  const lapJump = lap === (p.lap || 0) + 1 && newProg > p.prog;
  if (p.prog >= 0 && !lapJump && (newProg <= p.prog || newProg > p.prog + 2)) return; // 非法/乱序
  const oldLap = p.lap;
  p.prog = newProg;
  p.lap = lap;
  // lap>=2 才是真正跑完的一圈（第一次过线只是发车）；完赛消息 lap=laps+1 也带最后一圈用时
  if (msg.lapTime != null && lap >= 2 && lap > oldLap && lap <= room.settings.laps + 1) {
    p.laps.push(msg.lapTime);
    if (p.bestLap == null || msg.lapTime < p.bestLap) p.bestLap = msg.lapTime;
  }
  broadcast({ t: 'gate', id: p.id, gate, lap, totalTime: msg.totalTime ?? null });

  // 完赛：客户端船头真正压过终点线时才会带 finish: true。
  // 旧版只要消息里带 totalTime 就结算 —— 过门消息顺带一个时间戳就能提前结束比赛。
  // 除了标记，再要求圈数确实跑满，这样乱序/伪造的过门消息不会把任何人提前判定为完赛。
  if (msg.finish === true && msg.totalTime != null && lap >= needLap && !p.finished) {
    p.finished = true;
    p.finishTime = msg.totalTime;
    broadcast({ t: 'finish', id: p.id, time: p.finishTime, bestLap: p.bestLap, finishWindowSeconds: 10 });
    checkRoundEnd();
  }
}

function checkRoundEnd() {
  const racers = [...room.players.values()];
  // The first racer with a recorded finish time opens a fixed ten-second
  // results window. This includes AI and every connected human client.
  // Never end early when all remaining racers happen to finish in that window.
  if (racers.some((p) => p.finished && p.finishTime != null) && !room.roundEndTimer) {
    room.roundEndTimer = setTimeout(() => {
      room.roundEndTimer = null;
      if (room.phase === 'racing') endRound();
    }, 10000);
  }
}

function endRound() {
  clearTimeout(room.roundEndTimer);
  room.roundEndTimer = null;
  room.phase = 'intermission';

  const racers = [...room.players.values()];
  // 排名：完赛按用时，未完赛按进度（DNF）
  racers.sort((a, b) => {
    const aDone = a.finished && a.finishTime != null;
    const bDone = b.finished && b.finishTime != null;
    if (aDone && bDone) return a.finishTime - b.finishTime;
    if (aDone) return -1;
    if (bDone) return 1;
    return b.prog - a.prog;
  });

  const results = racers.map((p, i) => {
    const pts = racers.length - i; // 第1名 N 分，依次递减
    p.roundPoints = pts;
    room.scores.set(p.id, (room.scores.get(p.id) || 0) + pts);
    const st = room.itemStats.get(p.id) || { hit: 0, taken: 0, rescue: 0 };
    return {
      id: p.id, name: p.name, boatId: p.boatId, ai: p.ai, avatar: p.avatar || null,
      team: room.teams.get(p.id) || null,
      rank: i + 1,
      time: p.finishTime,
      bestLap: p.bestLap,
      points: pts,
      dnf: !(p.finished && p.finishTime != null),
      totalScore: room.scores.get(p.id),
      stats: { hit: st.hit, taken: st.taken, rescue: st.rescue },
    };
  });

  // ---- 组队：单局队伍分 + 局胜点（同分时队内最好名次更靠前者胜，单局必分胜负）----
  let roundWinner = null;
  let teamRoundScores = { blue: 0, red: 0 };
  const teamStats = {
    blue: { hit: 0, taken: 0, rescue: 0 },
    red: { hit: 0, taken: 0, rescue: 0 },
  };
  if (room.format === 'team' && room.mode !== 'boss') {
    const blue = results.filter((r) => r.team === 'blue');
    const red = results.filter((r) => r.team === 'red');
    const blueScore = blue.reduce((n, r) => n + r.points, 0);
    const redScore = red.reduce((n, r) => n + r.points, 0);
    teamRoundScores = { blue: blueScore, red: redScore };
    room.teamScores.blue += blueScore;
    room.teamScores.red += redScore;
    if (blueScore !== redScore) {
      roundWinner = blueScore > redScore ? 'blue' : 'red';
    } else {
      // 队伍分相同：队内最好名次更靠前者胜（名次唯一，不会继续平）
      const bestBlue = blue.length ? Math.min(...blue.map((r) => r.rank)) : Infinity;
      const bestRed = red.length ? Math.min(...red.map((r) => r.rank)) : Infinity;
      roundWinner = bestBlue < bestRed ? 'blue' : 'red';
    }
    room.roundWins[roundWinner] += 1;
    for (const r of results) {
      if (!r.team || !teamStats[r.team]) continue;
      teamStats[r.team].hit += r.stats.hit;
      teamStats[r.team].taken += r.stats.taken;
      teamStats[r.team].rescue += r.stats.rescue;
    }
  }

  const isFinal = room.round >= room.settings.rounds;
  // 组队终局胜负：三局两胜比局胜点，三局积分制比总积分，单场就是本局胜者
  let winnerTeam = null;
  if (room.format === 'team' && room.mode !== 'boss') {
    if (room.settings.matchFormat === 'points3') {
      winnerTeam = room.teamScores.blue === room.teamScores.red
        ? (room.roundWins.blue >= room.roundWins.red ? 'blue' : 'red')
        : (room.teamScores.blue > room.teamScores.red ? 'blue' : 'red');
    } else if (room.settings.matchFormat === 'bestOf3') {
      winnerTeam = room.roundWins.blue === room.roundWins.red
        ? (room.teamScores.blue >= room.teamScores.red ? 'blue' : 'red')
        : (room.roundWins.blue > room.roundWins.red ? 'blue' : 'red');
    } else {
      winnerTeam = roundWinner;
    }
  }
  const teamInfo = {
    format: room.format,
    teamNames: room.teamNames,
    matchFormat: room.settings.matchFormat,
    teamRoundScores,
    teamScores: { ...room.teamScores },
    roundWins: { ...room.roundWins },
    roundWinner,
    winnerTeam,
    teamStats,
  };
  clearTimeout(room.raceWatchdog);
  room.raceWatchdog = null;
  if (isFinal) {
    const standings = [...room.scores.entries()]
      .map(([id, score]) => {
        const p = room.players.get(id);
        return p
          ? {
            id, name: p.name, boatId: p.boatId, ai: p.ai, avatar: p.avatar || null,
            team: room.teams.get(id) || null, score,
          }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    broadcast({
      t: 'raceEnd', results, standings, round: room.round, rounds: room.settings.rounds,
      ...teamInfo,
    });
    // 一局打完立刻回到大厅状态：AI 全清 + 所有人释放选艇。
    // 以前这里只重置了 phase / scores，AI 和上一局的选艇会残留到下一局，
    // 表现就是"重新选赛艇时提示该赛艇已被选择"（尤其带 AI 的时候）。
    room.phase = 'lobby';
    room.round = 0;
    room.scores.clear();
    room.teamScores = { blue: 0, red: 0 };
    room.roundWins = { blue: 0, red: 0 };
    room.itemStats.clear();
    releasePicks();
    broadcast(rosterPayload());
  } else {
    broadcast({
      t: 'roundEnd', results, round: room.round, rounds: room.settings.rounds,
      ...teamInfo,
    });
  }
}

/** 释放上一局的所有选艇（连带清掉 AI 与每局比赛状态） */
function releasePicks() {
  for (const [id, p] of [...room.players]) {
    if (p.ai) { room.players.delete(id); room.teams.delete(id); room.itemStats.delete(id); continue; }
    p.boatId = null;
    p.ready = false;
    p.state = null;
    p.prog = -1;
    p.lap = 0;
    p.bestLap = null;
    p.finished = false;
    p.finishTime = null;
    p.laps = [];
    p.inGame = false;
    p.lastRaceAt = 0;
  }
}

function resetRace() {
  clearTimeout(room.roundEndTimer);
  room.roundEndTimer = null;
  clearTimeout(room.raceWatchdog);
  room.raceWatchdog = null;
  room.phase = 'lobby';
  room.round = 0;
  room.scores.clear();
  room.teamScores = { blue: 0, red: 0 };
  room.roundWins = { blue: 0, red: 0 };
  room.itemStats.clear();
  releasePicks();
  if (!room.players.size) room.hostId = null;
}

// ---------- 快照广播 30Hz ----------
// 20Hz(50ms) 时单次量化就要吃掉半个身位；30Hz 把端到端量化压到 33ms，
// 配合客户端延迟回放插值，远端艇不再有肉眼可见的滞后。
const SNAPSHOT_INTERVAL_MS = 33;
setInterval(() => {
  if (room.phase !== 'racing') return;
  const list = [];
  for (const p of room.players.values()) {
    if (p.state) list.push([p.id, ...p.state]);
  }
  if (list.length) broadcast({ t: 'snap', p: list });
}, SNAPSHOT_INTERVAL_MS);

// ---------- 僵尸房间自愈 ----------
// 典型场景：比赛开着的时候所有人刷新页面。座位靠 session 续座还在，
// phase 会永远停在 racing，再点开始只会收到"比赛正在进行中"。
// 只要没有任何在线真人还在比赛里（明确上报 inGame 且 20s 内有位置/过门消息），
// 就把房间拉回大厅。
setInterval(() => {
  if (room.phase !== 'racing') return;
  const now = Date.now();
  const live = [...room.players.values()].some((p) => !p.ai && isOnline(p) && p.inGame
    && now - p.lastRaceAt < RACE_IDLE_MS);
  if (live) return;
  resetRace();
  broadcast(rosterPayload());
  broadcast({ t: 'lobbyReset' });
}, 3000);
