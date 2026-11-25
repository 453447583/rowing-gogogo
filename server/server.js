import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { BOATS } from '../src/data/boats.js';
import { MAPS, WEATHERS } from '../src/data/maps.js';
import { BOSS_LEVELS } from '../src/data/bosses.js';
import { createLeaderboard } from './leaderboard.js';
import { createStore } from './lb-store.js';
import { createWallet, sanitizeWalletOp, cleanUid } from './wallet.js';
import { createAccounts } from './accounts.js';
import { ticketAllowed, SHOP_MAP } from '../src/data/shop.js';
import { findCpolarUrl, readUrlFile, normalizeBridgeUrl } from './public-url.js';

const WEATHER_IDS = [...WEATHERS.map((w) => w.id), 'random'];
const MODE_IDS = ['race', 'item', 'launch', 'boss', 'arena', 'skytower'];
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
  // 2026-11-22 三件新道具带来的通道：
  //   bossBeacon  救援信标（谁被救 / 谁回血，由各自客户端结算）
  //   bossComboFill 协同伙伴（队友也要把槽位锁满，否则一边满一边空）
  //   bossTeamFx  天使庇佑改为全队生效，真人各自施加
  'bossBeacon', 'bossComboFill', 'bossTeamFx',
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
  // 云端天梯：冲刺能量 / 入账 / 开闸 / 结束。
  // 这四条以前**不在白名单里**，等于联机天梯的同步消息全被服务器丢了（只有单人能玩）。
  // 第 1 层水球赛又加了球的位姿（footBall，房主 15Hz）与进球（footGoal），一起补进来。
  'towerDash', 'towerScore', 'towerOpen', 'towerEnd',
  'footBall', 'footGoal',
  // 第 2 层泡泡送包子：抢货 / 掉货 / 送达 / 泡泡生成与爆炸
  'deliverGrab', 'deliverDrop', 'deliverScore', 'bubbleSpawn', 'bubblePop',
  // 第 3 层道具箱大乱斗：只多一条"本层时间到"（格子/开箱/命中复用上面的
  // itemPick / itemUse / itemHeld / itemHit / itemFx，服务器零改动）
  'itemRushEnd',
  // 第 4 层雷霆龙骑士（位姿 / 读条 / 输出上报 / 玩家受击 / 结算）
  'towerBossState', 'towerBossCast', 'towerBossHit', 'towerBossHurt', 'towerBossEnd',
  // 第 5 层随机落雷（落点广播 / 命中计数 / 本层结算）。
  // towerScore 复用第 57 行那条：每躲一波的加分与层结束排名分都走它。
  'towerBoltWave', 'towerBoltHit', 'towerBoltEnd',
  // 第 6 层塔防（刷怪 / 小怪快照 / 客机命中 / 受击 / 结算）
  'towerDefSpawn', 'towerDefState', 'towerDefHit', 'towerDefHurt', 'towerDefEnd',
  // 第 7 层缩圈：圈半径+里程快照 / 掉圈上报 / 本层结算（漏一条客机就看不见圈）
  'towerShrinkState', 'towerShrinkFall', 'towerShrinkEnd',
]);

// 语音信令不属于玩法中继：它在大厅和比赛里都要能用，而且必须按目标玩家定向投递。
// 放 RELAY_TYPES 里会同时踩两个坑：只有 racing 阶段才转发、且会全房广播。
// 局域网（3001）和线上同源 /ws 都开放：本机双开调试走的就是局域网入口。
const VOICE_TYPES = new Set(['voiceState', 'voiceSignal']);
const VOICE_SIGNAL_KINDS = new Set(['offer', 'answer', 'candidate']);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');
// 排行榜：服务器唯一权威。默认写 server/data/leaderboard.json（已在 .gitignore）；
// 配 LB_STORE=mysql + MYSQL_* 就改走 MySQL —— 局域网那台机器和线上 Render
// 可以因此共用同一张榜。测试用 LEADERBOARD_FILE 指到临时文件。
const dataFile = process.env.LEADERBOARD_FILE || path.join(__dirname, 'data', 'leaderboard.json');
// 榜单和钱包共用同一份存储 / 同一个内存 db：JSON 是同一个文件，MySQL 是同一个库，
// remote 是同一条桥接隧道。分开建两个 store 会互相覆盖，绝不这么干。
const gameStore = await createStore({ file: dataFile });
const gameDb = await gameStore.init();
gameStore.attach?.(gameDb.boards || {}, gameDb.players || {}, gameDb.accounts || {}, gameDb.tokens || {});
const leaderboard = await createLeaderboard({ store: gameStore, db: gameDb });
const wallet = createWallet({ store: gameStore, db: gameDb });
const accounts = createAccounts({ store: gameStore, db: gameDb });
// 每台服务器一份随机标签：家里 LAN 和线上 Render 的 raceSeq 都从 0 开始，
// 拼进 op.id 才能防止两边同一局号把积分重复入账。
const INSTANCE_ID = crypto.randomBytes(6).toString('hex');
console.log(`[排行榜] 存储：${leaderboard.kind}${leaderboard.location ? ` → ${leaderboard.location}` : ''}`);
// 退出前把没落盘的战绩 / 积分写掉：Render 重新部署会发 SIGTERM，
// 不接这一下的话最后 2 秒内的成绩会跟着进程一起消失。
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    Promise.all([leaderboard.flush(), gameStore.flush?.()]).finally(() => process.exit(0));
  });
}
const HTTP_PORT = Number(process.env.PORT) || 3000;
const WS_PORT = Number(process.env.WS_PORT) || 3001;

// ---------- 排行榜桥接 ----------
// 家里那台（JSON 存储）负责开 /lb-api/*，线上那条（LB_STORE=remote）负责调。
// 没配 token 就整个接口当不存在：默认暴露到公网的东西越少越好。
// 两端用同一个密钥就行：LEADERBOARD_TOKEN（线上拿它当请求头），
// 家里那台拿它当准入 token；LB_BRIDGE_TOKEN 是等价别名，老的配置不用改。
const BRIDGE_TOKEN = process.env.LEADERBOARD_TOKEN || process.env.LB_BRIDGE_TOKEN || '';
// 线上实例的登记地址（形如 https://xxx.onrender.com/lb-api/register）：
// 家里每 60 秒把当前 cpolar 地址推过去，cpolar 换域名时线上自动跟上。
const REGISTER_URL = process.env.LB_REGISTER_URL || '';
const PUBLIC_URL_FILE = path.join(__dirname, 'data', 'public-url.txt');
/** 桥接单次请求体上限：一批 10 条 + 头像 dataURL，1MB 足够 */
const BRIDGE_BODY_MAX = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.ktx2': 'image/ktx2',
  '.mp4': 'video/mp4',
};

// 值得动态压缩的类型：文本是稳赚，GLB/glTF 里的顶点块和 JSON 块通常还能再省 10~25%。
// 图片/音频/视频本身已压过，再压只会白烧 Render 单核的 CPU，直接跳过。
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.txt', '.svg', '.glb', '.gltf', '.bin', '.wasm',
]);

/**
 * 缓存策略：
 * - index.html 随部署变化，必须回源校验；
 * - Vite 产物 /assets/* 文件名自带 hash，一年 immutable；
 * - 模型/图标/音频按天缓存，配合 ETag 二次访问 304，不再每次刷新重下 482MB。
 */
function cacheControlFor(urlPath) {
  if (urlPath.endsWith('.html')) return 'no-cache';
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=86400, stale-while-revalidate=604800';
}

/** 单段 Range（音效试听/拖动进度）；压缩会破坏字节偏移，所以走 Range 时不压缩。 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Number(m[2]) : size - 1;
  } else {
    // bytes=-N：最后 N 字节
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  }
  if (end >= size) end = size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

function serveStatic(req, res, filePath, urlPath, st) {
  const ext = path.extname(filePath).toLowerCase();
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const cacheControl = cacheControlFor(urlPath);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl }).end();
    return;
  }
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    ETag: etag,
    'Last-Modified': st.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
  };

  const range = parseRange(req.headers.range, st.size);
  if (range) {
    if (range.invalid) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${st.size}`,
      'Content-Length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(filePath, { start: range.start, end: range.end })
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }

  // 流式压缩，避免把 18MB 整块读进内存；br 用 q4 平衡单核 CPU 和体积。
  const accept = String(req.headers['accept-encoding'] || '');
  let encoder = null;
  if (COMPRESSIBLE.has(ext) && st.size > 1024) {
    if (/\bbr\b/.test(accept)) {
      res.setHeader('Content-Encoding', 'br');
      encoder = zlib.createBrotliCompress({
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
      });
    } else if (/\bgzip\b/.test(accept)) {
      res.setHeader('Content-Encoding', 'gzip');
      encoder = zlib.createGzip({ level: 6 });
    }
    if (encoder) res.setHeader('Vary', 'Accept-Encoding');
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); encoder?.destroy(); return; }
  const stream = fs.createReadStream(filePath).on('error', () => res.destroy());
  if (encoder) {
    encoder.on('error', () => res.destroy());
    stream.pipe(encoder).pipe(res);
  } else {
    stream.pipe(res);
  }
}

// ---------- 静态文件服务 ----------
const httpServer = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400).end('Bad Request');
    return;
  }
  if (urlPath.startsWith('/auth/')) {
    (async () => {
      const action = urlPath.slice('/auth/'.length);
      if (req.method !== 'POST' || !['register', 'login', 'reset', 'session'].includes(action)) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      let body;
      try { body = JSON.parse(await readBody(req, 8192)); } catch { sendJson(res, 400, { ok: false, error: 'bad json' }); return; }
      const p = body || {};
      const out = action === 'session' ? await accounts.session(p.token)
        : action === 'register' ? await accounts.register(p.user, p.pass, p.nick)
          : action === 'login' ? await accounts.login(p.user, p.pass)
            : await accounts.reset(p.user, p.code, p.pass);
      sendJson(res, out?.ok === false ? 400 : 200, out && typeof out === 'object' ? out : { ok: false, error: 'unauthorized' });
    })().catch((err) => sendJson(res, 500, { ok: false, error: err?.message || '服务器错误' }));
    return;
  }
  if (urlPath.startsWith('/lb-api/')) {
    handleBridgeRequest(req, res, urlPath);
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.includes('\0')) {
    res.writeHead(400).end('Bad Request');
    return;
  }
  const filePath = path.join(DIST, urlPath);
  if (filePath !== DIST && !filePath.startsWith(DIST + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end('Not Found');
      return;
    }
    serveStatic(req, res, filePath, urlPath, st);
  });
});

// ---------- 排行榜桥接接口 ----------
// 用途：把家里那台的一份 leaderboard.json 变成线上也能读写的"数据库"。
//   家里（JSON 存储）  GET  /lb-api/boards?since=<ms>   增量拉取（since 缺省 = 全量）
//                      POST /lb-api/write              批量写（entry.at 由家里盖时间戳）
//   线上（remote 存储） POST /lb-api/register            家里换了公网地址就推过来
// 全部要求 Authorization: Bearer <LB_BRIDGE_TOKEN>；没配 token 一律 404。
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = BRIDGE_BODY_MAX) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 定长比较，避免按响应时间猜 token */
function bridgeTokenOk(req) {
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!BRIDGE_TOKEN || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(BRIDGE_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 榜单 key 白名单：只认排行榜真正会产生的四种前缀 */
const BRIDGE_KEY_RE = /^(?:r:[A-Za-z0-9_-]{1,32}:[1-9]|bt:[1-6]|bs:[1-6]:[1-9]|hx:[1-6]|tw:best)$/;

/**
 * 清洗一条来自线上的成绩。客户端能伪造的一切都在这里过一遍：
 * 名字去掉控制字符、时间必须合理、头像只收字符串、at 一律用家里的时钟。
 * @returns {{key:string, entry:object, kind:'time'|'progress'}|null}
 */
function sanitizeBridgeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const key = String(it.key || '');
  if (!BRIDGE_KEY_RE.test(key)) return null;
  const e = it.entry;
  if (!e || typeof e !== 'object') return null;
  const name = String(e.n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  if (!name) return null;
  const t = Number(e.t);
  if (!Number.isFinite(t) || t <= 0 || t > 86400) return null;
  const entry = {
    n: name,
    a: typeof e.a === 'string' ? e.a.slice(0, 80000) : '',
    b: String(e.b ?? '').slice(0, 32),
    t: Math.round(t * 100) / 100,
    // 时间戳必须由家里盖：增量拉取按 since 比较的就是这个字段，
    // 用线上机器的时钟会因两台机器时差漏记录
    at: Date.now(),
  };
  const bl = Number(e.bl);
  if (Number.isFinite(bl) && bl > 0 && bl <= 3600) entry.bl = Math.round(bl * 100) / 100;
  const c = Number(e.c);
  if (Number.isFinite(c) && c > 0) entry.c = Math.min(9, Math.round(c));
  return { key, entry, kind: key.startsWith('hx:') ? 'progress' : 'time' };
}

async function handleBridgeRequest(req, res, urlPath) {
  if (!BRIDGE_TOKEN) return sendJson(res, 404, { error: 'not found' });
  if (!bridgeTokenOk(req)) return sendJson(res, 401, { error: 'unauthorized' });

  // 账号操作统一转给家里权威实例；线上自己不存密码哈希 / 不签 token
  if (req.method === 'POST' && urlPath === '/lb-api/auth') {
    let body;
    try { body = JSON.parse(await readBody(req, 8192)); } catch { return sendJson(res, 400, { ok: false, error: 'bad json' }); }
    const p = body?.payload || {};
    const action = String(body?.action || '');
    const out = action === 'register' ? await accounts.register(p.user, p.pass, p.nick)
      : action === 'login' ? await accounts.login(p.user, p.pass)
        : action === 'reset' ? await accounts.reset(p.user, p.code, p.pass)
          : action === 'session' ? await accounts.session(p.token)
            : { ok: false, error: 'bad action' };
    return sendJson(res, out?.ok === false ? 400 : 200, out);
  }

  // 增量拉取：since 之后的记录（>= 是故意的，同一毫秒内写的两条不会漏）
  if (req.method === 'GET' && urlPath === '/lb-api/boards') {
    const since = Number(new URL(req.url, 'http://localhost').searchParams.get('since')) || 0;
    const at = Date.now(); // 先盖时间戳再快照：期间新写入的下一轮还会再发一次
    const out = {};
    for (const [key, list] of Object.entries(leaderboard.raw())) {
      if (!Array.isArray(list) || !list.length) continue;
      const fresh = since ? list.filter((e) => (Number(e.at) || 0) >= since) : list;
      if (fresh.length) out[key] = fresh;
    }
    // 钱包和榜单走同一个 since：玩家档案的 at 由家里时钟盖，线上本地 optimistic 版本是 0
    const players = {};
    for (const [uid, p] of Object.entries(wallet.raw())) {
      if (!p || (Number(p.at) || 0) < since) continue;
      players[uid] = wallet.snapshot(uid, p.n);
    }
    return sendJson(res, 200, { v: 2, at, boards: out, players, kind: leaderboard.kind });
  }

  if (req.method === 'POST' && urlPath === '/lb-api/write') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'bad json' }); }
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length > 50) return sendJson(res, 413, { error: 'too many items' });
    let applied = 0;
    for (const it of items) {
      if (it?.type === 'walletOp') {
        // 钱包只认 op：家里用自己的时钟盖 at，再按 op.id 幂等应用
        const op = sanitizeWalletOp(it.op, { homeClock: true });
        if (op && wallet.apply(op).ok) applied++;
        continue;
      }
      const clean = sanitizeBridgeItem(it);
      if (!clean) continue;
      // add() 内部还会和本地权威缓存比一次，比当前榜差的不会覆盖
      if (leaderboard.add(clean.key, clean.entry, clean.kind)) applied++;
    }
    return sendJson(res, 200, { ok: true, applied, got: items.length });
  }

  if (req.method === 'POST' && urlPath === '/lb-api/register') {
    // 只有"线上那条"（remote 存储）才需要收地址，家里那台收不到也别乱改状态
    if (leaderboard.kind !== 'remote') return sendJson(res, 409, { error: 'not a remote client' });
    let body;
    try { body = JSON.parse(await readBody(req, 4096)); } catch { return sendJson(res, 400, { error: 'bad json' }); }
    const url = normalizeBridgeUrl(body?.url);
    if (!url) return sendJson(res, 400, { error: 'bad url' });
    const changed = await leaderboard.setRemoteUrl(url);
    if (changed) console.log(`[排行榜] 家里服务器地址已更新 → ${url}`);
    return sendJson(res, 200, { ok: true, url });
  }

  return sendJson(res, 404, { error: 'not found' });
}

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
  if (BRIDGE_TOKEN && leaderboard.kind !== 'remote') {
    console.log(`  排行榜桥接:  /lb-api/boards · /lb-api/write（Bearer 鉴权，给线上读这份 JSON）`);
  }
  console.log('========================================');
});

// ---------- 家里地址自动登记 ----------
// cpolar 免费版每次重启隧道都会换二级域名，手动去线上后台改环境变量太容易忘。
// 所以家里这端每 60 秒：找当前公网地址 → 推给线上的 /lb-api/register。
// 地址来源优先级：PUBLIC_URL 环境变量 → server/data/public-url.txt → cpolar 日志。
// 只有"家里那台"（非 remote 存储）才跑这个循环。
if (REGISTER_URL && BRIDGE_TOKEN && leaderboard.kind !== 'remote') {
  let lastUrl = '';
  let lastNoUrl = 0;
  let lastFail = 0;
  const registerTick = async () => {
    const url = normalizeBridgeUrl(process.env.PUBLIC_URL)
      || normalizeBridgeUrl(readUrlFile(PUBLIC_URL_FILE))
      || findCpolarUrl(HTTP_PORT);
    if (!url) {
      if (Date.now() - lastNoUrl > 300000) {
        lastNoUrl = Date.now();
        console.log('[桥接] 还没找到公网地址：在 cpolar 里给本机这个端口建一条 HTTP 隧道，或用 PUBLIC_URL 指定');
      }
      return;
    }
    try {
      const res = await fetch(REGISTER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${BRIDGE_TOKEN}` },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (url !== lastUrl) {
        lastUrl = url;
        console.log(`[桥接] 线上已登记本机地址：${url}`);
      }
    } catch (err) {
      if (Date.now() - lastFail > 300000) {
        lastFail = Date.now();
        console.warn(`[桥接] 地址登记失败：${err?.message || err}`);
      }
    }
  };
  registerTick();
  setInterval(registerTick, 60000).unref?.();
}

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
  // 本局真人数量（排行榜按 1~6 人分桶，AI 不计）与本局已上报的榜类
  raceHumans: 1,
  // 本局开赛瞬间的真人名单（排行榜要显示整队，不能只留房主的名字）
  raceRoster: [],
  lbDone: new Set(),
  // 幸运券：每个真人每局最多自动用一张，开赛时清空
  ticketDone: new Set(),
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

// 语音只发给「已 hello 且支持语音的连接」的玩家（局域网 / 线上同源都算）。
function broadcastVoice(msg, exclude = null) {
  for (const p of room.players.values()) {
    if (p.id === exclude || !p.voiceCapable) continue;
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
      // 客户端靠这个字段画语音状态（局域网 / 线上都可能有）
      voiceOn: p.voiceCapable === true && p.voiceOn === true,
      style: p.ai || !p.uid ? null : walletStyle(p.uid, p.name),
    })),
  };
}

/** 名次 → 积分区间：只奖完赛真人，Daily 上限在 wallet.js 里统一兜底 */
function rankPoints(rank) {
  if (rank === 1) return 120;
  if (rank === 2) return 80;
  if (rank === 3) return 50;
  if (rank <= 10) return (11 - rank) * 5;
  return 10;
}

/** 服务器生成 op.id：客户端给什么都不采信，重放也撞不上 */
function newOpId(kind, uid) {
  return `${INSTANCE_ID}:${kind}:${uid}:${Date.now().toString(36)}:${crypto.randomBytes(3).toString('hex')}`;
}

/** 只把本人钱包发给本人；绝不塞进 roster / welcome 广播给别人 */
function sendWallet(p) {
  if (!p || !p.uid || !p.ws) return;
  sendTo(p, { t: 'wallet', ...wallet.snapshot(p.uid, p.name) });
}

/** 外观状态随名单 / 榜单一起下发：客户端只负责画，不自己决定谁有什么框 */
function walletStyle(uid, name = '') {
  const snap = wallet.snapshot(uid, name);
  const frame = SHOP_MAP[snap.equip?.frame];
  const title = SHOP_MAP[snap.equip?.title];
  return {
    frame: snap.equip?.frame || '',
    frameColor: frame?.color || '',
    title: snap.equip?.title || '',
    titleName: title?.name || '',
  };
}

function stylesByName(names) {
  const out = {};
  const byUid = {};
  for (const [uid, p] of Object.entries(wallet.raw())) {
    byUid[uid] = p;
    if (p.n) out[p.n] = walletStyle(uid, p.n);
  }
  for (const name of names) {
    if (!name || out[name]) continue;
    const p = [...room.players.values()].find((x) => !x.ai && x.name === name);
    if (p?.uid) out[name] = walletStyle(p.uid, name);
  }
  return out;
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
function handleConnection(ws, req = null) {
  // 语音信令对局域网（:3001）和线上同源 /ws 都开放：
  // 本机双开调试走的就是局域网入口 + localhost（安全上下文），麦克风可用。
  // 跨机的 http://192.168.x.x 拿不到麦克风，客户端会禁用语音并提示，不需要服务端拦。
  const voiceCapable = true;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* 出错统一走 close */ });

  // ---- 加入 / 断线重连 ----
  const doHello = async (msg) => {
    const name = String(msg.name || '玩家').slice(0, 10);
    const key = String(msg.session || '').slice(0, 64);
    let uid = cleanUid(msg.uid);
    // 登录账号的 token 优先于本机 uid：同一账号在多台设备上共用同一个钱包
    const token = String(msg.token || '').slice(0, 160);
    if (token) {
      try {
        const acc = await accounts.session(token);
        if (acc) uid = acc.uid;
      } catch { /* 网络抖动时先按本机 uid 进房，UI 会提示登录失效 */ }
    }
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
        // 老客户端没有 uid；升级后第一次重连补上，已绑定的 uid 不允许被改
        if (uid && !prev.uid) prev.uid = uid;
        if (avatar) prev.avatar = avatar;
        // 换连接就当作重新开麦：旧浏览器页签可能还挂着麦克风，不能让它的 voiceOn 复活。
        if (prev.voiceOn) broadcastVoice({ t: 'voiceState', id: prev.id, on: false }, prev.id);
        prev.voiceCapable = voiceCapable;
        prev.voiceOn = false;
        if (old && old !== ws) { try { old.close(); } catch {} } // 旧连接（重复页签）让位
        me = prev;
        assignTeam(me); // 重连保留原队伍；老房间没队则补一次
        sendTo(me, { ...welcomeFor(me), resumed: true });
        sendWallet(me);
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
      id, ws, session: key, uid, name,
      boatId: null, ready: false, ai: false, avatar: avatar || null,
      inGame: false, lastRaceAt: 0,
      state: null, prog: -1, lap: 0, bestLap: null,
      finished: false, finishTime: null, laps: [],
      graceTimer: null,
      voiceCapable,   // 该连接是否支持语音信令（局域网 / 线上都支持）
      voiceOn: false,
    };
    room.players.set(id, me);
    if (!room.hostId) room.hostId = id; // 房间第一个人当房主
    assignTeam(me); // 组队房间：进房即自动均衡分队
    sendTo(me, welcomeFor(me));
    sendWallet(me);
    broadcast(rosterPayload(), id);
  };

  // hello 现在要等账号校验（带 token 时还要过隧道问家里那台），这期间客户端
  // open 后顺手发出来的 pick/mode/settings 会被当成"还没座位"静默丢掉，
  // 表现就是"偶尔进房赛艇没选上、模式没切"。先按原始报文排队，hello 落地再回放。
  let helloPending = false;
  const earlyMsgs = [];

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // pong 原样带回客户端的时间戳：客户端据此算 RTT，用来给技能预警做延迟补偿
    if (msg.t === 'ping') {
      try { ws.send(JSON.stringify({ t: 'pong', ts: msg.ts })); } catch {}
      return;
    }
    if (msg.t === 'hello') {
      earlyMsgs.length = 0;
      helloPending = true;
      doHello(msg)
        .catch((err) => console.warn('[账号] hello 失败：', err?.message || err))
        .finally(() => {
          helloPending = false;
          // 回放排队消息：还没坐到座位的话下面的 !me 守卫会照旧丢掉，不会误处理
          for (const buf of earlyMsgs.splice(0)) { try { ws.emit('message', buf); } catch {} }
        });
      return;
    }
    if (helloPending) {
      if (earlyMsgs.length < 64) earlyMsgs.push(raw); // 64 条足够覆盖 open 后那一瞬间，防恶意灌爆
      return;
    }
    if (!me || me.ws !== ws) return;

    // ---- 联机语音信令：服务器只当红娘，不碰音频流 ----
    // 不走 RELAY_TYPES：大厅里也要能连麦，而且 offer/answer/ICE 必须定向投递。
    if (VOICE_TYPES.has(msg.t)) {
      if (!voiceCapable) return;
      if (msg.t === 'voiceState') {
        const on = msg.on === true;
        if (me.voiceOn === on) return;
        me.voiceOn = on;
        broadcastVoice({ t: 'voiceState', id: me.id, on }, me.id);
        // 名单里也带一份：中途加入的人看 welcome，已经在房里的人看这条 roster。
        broadcastVoice(rosterPayload(), me.id);
        return;
      }
      // voiceSignal：{ to, data:{ kind:'offer'|'answer'|'candidate', ... } }
      if (!me.voiceOn) return;
      const to = String(msg.to || '');
      const target = room.players.get(to);
      if (!target || target.id === me.id || target.ai || !target.voiceCapable) return;
      const data = msg.data;
      if (!data || typeof data !== 'object') return;
      const kind = String(data.kind || '');
      if (!VOICE_SIGNAL_KINDS.has(kind)) return;
      let safeData;
      if (kind === 'candidate') {
        const c = data.candidate;
        if (!c || typeof c !== 'object') return;
        const candidate = String(c.candidate || '');
        if (!candidate || candidate.length > 4000) return;
        safeData = {
          kind,
          candidate: {
            candidate,
            sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
            sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null,
          },
        };
      } else {
        const sdp = typeof data.sdp === 'string' ? data.sdp : '';
        if (!sdp || sdp.length > 120000) return;
        safeData = { kind, sdp };
      }
      sendTo(target, { t: 'voiceSignal', from: me.id, to, data: safeData });
      return;
    }

    // ---- 头像：怪物模式的玩家列表显示；只存内存，本次会话有效 ----
    if (msg.t === 'avatar') {
      const a = safeAvatar(msg.avatar);
      if (a && a !== me.avatar) {
        me.avatar = a;
        broadcast(rosterPayload());
      }
      return;
    }

    // ---- 排行榜：查询 / 房主上报 ----
    // 竞速成绩由服务器在结算时自己记账（最可信）；只有怪物 / 海克斯没有统一结算，
    // 才由房主在这一局结束时一次性上报。
    if (msg.t === 'lbGet') {
      // 走 MySQL 时先按 TTL 同步一次（别人在另一台服务器刚跑的成绩也能看到），
      // JSON 模式下 refresh 直接返回，不影响速度。
      leaderboard.refresh()
        .catch(() => {})
        .then(() => {
          const snap = leaderboard.snapshot(me.name);
          const names = new Set();
          for (const list of Object.values(snap.boards || {})) {
            for (const e of list || []) if (e?.n) names.add(e.n);
          }
          sendTo(me, { t: 'lb', ...snap, styles: stylesByName([...names]) });
        });
      return;
    }
    if (msg.t === 'lbSubmit') {
      if (room.mode !== 'boss' || room.phase !== 'racing') return;
      if (me.id !== room.hostId) return; // 只收房主：每个客机各报一份会重复计数
      const variant = room.settings.variant === 'hex' ? 'hex' : 'classic';
      if ((msg.variant || 'classic') !== variant) return;
      const tag = `${room.raceSeq}:${variant}`;
      if (room.lbDone.has(tag)) return; // 同一局只记一次
      room.lbDone.add(tag);
      leaderboard.recordBoss({
        variant,
        // 人数用开赛时统计的真人数量，不信任消息里自报的人数
        humans: room.raceHumans,
        victory: msg.victory === true,
        totalTime: msg.totalTime,
        cleared: msg.cleared,
        stages: Array.isArray(msg.stages) ? msg.stages.slice(0, 9) : [],
        // 身份也取服务器这一侧的值
        player: { name: me.name, avatar: me.avatar, boatId: me.boatId },
        // 整队名单由服务器给出，不信任客户端自报（房主只是上报者，不是唯一队员）
        players: room.raceRoster || [],
      });
      // 积分：海克斯按通过层数给，经典只有通关才给；全员同榜同分，不由房主独吞
      const stagesForScore = Array.isArray(msg.stages) ? msg.stages.slice(0, 9) : [];
      const clearedForScore = Math.max(0, Math.min(stagesForScore.length,
        Math.round(Number(msg.cleared) || 0) || stagesForScore.length));
      const d = variant === 'hex'
        ? (clearedForScore * 10 + (clearedForScore >= 4 ? 30 : 0))
        : (msg.victory === true ? 120 : 0);
      if (d > 0) {
        for (const who of (room.raceRoster || [])) {
          if (!who?.uid) continue;
          const p = [...room.players.values()].find((x) => !x.ai && x.name === who.name);
          if (!p) continue;
          const res = wallet.apply({
            id: newOpId(`boss:${variant}`, who.uid), uid: who.uid, kind: 'grant',
            d, mode: variant === 'hex' ? 'hex' : 'boss', n: p.name,
          }, { localOnly: gameStore.kind === 'remote' });
          if (res.ok) sendWallet(p);
        }
      }
      return;
    }

    // ---- 积分钱包：查询 / 兑换 / 穿戴 / 非排位幸运券 ----
    // 钱包按 uid 记账，不按名字；所有扣款都在服务器校验余额，客户端只发物品 key。
    if (msg.t === 'walletGet') {
      wallet.refresh().catch(() => {}).finally(() => sendWallet(me));
      return;
    }
    if (msg.t === 'shopBuy' || msg.t === 'shopEquip') {
      if (!me.uid) return;
      const buying = msg.t === 'shopBuy';
      const op = {
        id: newOpId(buying ? 'buy' : 'equip', me.uid),
        uid: me.uid,
        kind: buying ? 'buy' : 'equip',
        item: String(msg.item || '').slice(0, 32),
        slot: String(msg.slot || '') === 'title' ? 'title' : 'frame',
        n: me.name,
      };
      const res = wallet.apply(op, { localOnly: gameStore.kind === 'remote' });
      if (res.ok) {
        sendWallet(me);
        sendTo(me, { t: 'toast', msg: buying ? '兑换成功，已放进背包' : '已装备' });
      } else {
        sendTo(me, { t: 'toast', msg: res.reason === 'not-enough' ? '积分不够' : '兑换失败，请稍后再试' });
      }
      return;
    }
    if (msg.t === 'shopUseTicket') {
      // 只在联机非排位生效：单人没有服务器，排位房直接拒绝，防止券影响榜单公平
      if (!me.uid || room.phase !== 'racing') return;
      if (!ticketAllowed({ mode: room.mode, format: room.format })) return;
      if (room.ticketDone.has(me.id)) return;
      room.ticketDone.add(me.id);
      const res = wallet.apply({
        id: newOpId('useTicket', me.uid), uid: me.uid,
        kind: 'useTicket', n: me.name,
      }, { localOnly: gameStore.kind === 'remote' });
      if (res.ok) {
        sendWallet(me);
        // 客户端收到后调现有的 ItemManager.grantRandomItem()，沿用原有抽奖权重和保底
        sendTo(me, { t: 'luckyItem', ok: true });
      }
      return;
    }
    if (msg.t === 'towerResult') {
      if (room.mode !== 'skytower' || room.phase !== 'racing') return;
      if (me.id !== room.hostId) return; // 天梯分数由房主上报，客机各报一份会重复发奖
      const tag = `${room.raceSeq}:tower`;
      if (room.lbDone.has(tag)) return;
      room.lbDone.add(tag);
      const roster = new Map((room.raceRoster || []).map((p) => [p.name, p]));
      const scores = (Array.isArray(msg.scores) ? msg.scores : []).slice(0, 6).map((s) => {
        const name = String(s?.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
        return {
          name,
          ai: s?.ai === true,
          layer: Math.max(1, Math.min(10, Math.round(Number(s?.layer) || 1))),
          score: Math.max(0, Math.round(Number(s?.score) || 0)),
        };
      }).filter((s) => s.name && roster.has(s.name) && !s.ai);
      // 天梯榜：最高层优先，同层比整局用时；elapsed 取服务器墙钟，不采信客户端自报的高分
      leaderboard.recordTower({
        scores,
        elapsed: Math.max(1, (Date.now() - (room.roundStartAt || Date.now())) / 1000),
        players: room.raceRoster,
      });
      scores.forEach((s, i) => {
        const p = [...room.players.values()].find((x) => !x.ai && x.name === s.name);
        if (!p?.uid) return;
        const d = rankPoints(i + 1) + (s.layer >= 5 ? 40 : 0);
        const res = wallet.apply({
          id: newOpId('tower', p.uid), uid: p.uid, kind: 'grant',
          d, mode: 'tower', n: p.name,
        }, { localOnly: gameStore.kind === 'remote' });
        if (res.ok) sendWallet(p);
      });
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
      // 海克斯：赛艇由开局随机分配，服务器也不接受手动选艇
      if (room.mode === 'boss' && room.settings.variant === 'hex') {
        toastTo(me, '海克斯模式：赛艇在开局随机分配，不能手动选择');
        sendTo(me, rosterPayload());
        sendTo(me, { t: 'pickResult', ok: false, boatId: null });
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
      // 海克斯赛艇随机分配，没有"先选艇"这一步
      const hexRandom = room.mode === 'boss' && room.settings.variant === 'hex';
      if (want && !me.boatId && !hexRandom) {
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
      // 海克斯：赛艇由开局随机分配，跳过所有"先选艇"校验
      const hexRandom = room.mode === 'boss' && room.settings.variant === 'hex';
      // 房主自己没选艇不该把整局卡死：开赛前给房主补一艘空闲赛艇。
      // （以前这里直接拒绝，提示的是"房主还没选赛艇"，看起来像客户端的问题）
      if (!hexRandom && !me.boatId) {
        const used = new Set(humans.map((p) => p.boatId).filter(Boolean));
        const free = BOATS.find((b) => !used.has(b.id)) || BOATS[0];
        me.boatId = free.id;
        broadcast(rosterPayload());
      }
      const offline = humans.find((p) => !isOnline(p));
      if (offline) { toastTo(me, `${offline.name} 正在重连，稍等一下`); return; }
      const noBoat = hexRandom ? null : humans.find((p) => !p.boatId);
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
        // 阶段 + 赛程时间：只认玩家自己上报的（AI 由主机代报，也以主机的为准）。
        // 快照里把房主那份带给客机，客机据此判断"我该发车了/我落后几秒"。
        if (typeof msg.ph === 'string') target.phase = msg.ph;
        if (Number.isFinite(msg.rt)) target.raceTime = msg.rt;
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
    // 掉线时立刻告诉其他线上玩家「我不再收语音了」，别等 15s 座位清理。
    if (me.voiceOn) {
      me.voiceOn = false;
      broadcastVoice({ t: 'voiceState', id: me.id, on: false }, me.id);
      broadcastVoice(rosterPayload(), me.id);
    }
    // 不立刻踢人：先给 15s 重连窗口，赛艇与房主身份都留着
    clearTimeout(me.graceTimer);
    me.graceTimer = setTimeout(() => removePlayer(me.id), GHOST_GRACE_MS);
    broadcast(rosterPayload());
  });
}

wss.on('connection', (ws, req) => handleConnection(ws, req));
wssOnline.on('connection', (ws, req) => handleConnection(ws, req));

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
  // 开赛墙钟：随 start 广播下发，客户端据此把「过场 + 倒计时」锚在同一条时间轴上。
  // 双开自测时后台标签页的 rAF 会被浏览器暂停，没有这条锚点，那一端会滞留在倒计时。
  room.roundStartAt = Date.now();

  // 清理旧 AI，按设置生成新 AI
  for (const [id, p] of [...room.players]) {
    if (p.ai) {
      room.players.delete(id);
      room.teams.delete(id);
      room.itemStats.delete(id);
    }
  }
  const hexRandomBoat = room.mode === 'boss' && room.settings.variant === 'hex';
  // 海克斯：本局给每名真人随机发一艘不重复的赛艇。只作用于本局 order，
  // 不改 p.boatId —— 回到闯关 / 竞速时玩家原来的选艇仍然有效。
  const hexBoatByPlayer = new Map();
  if (hexRandomBoat) {
    const ids = BOATS.map((b) => b.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    let k = 0;
    for (const p of room.players.values()) {
      if (p.ai) continue;
      hexBoatByPlayer.set(p.id, ids[k++ % ids.length]);
    }
  }
  const usedBoats = new Set(
    hexRandomBoat
      ? [...hexBoatByPlayer.values()]
      : [...room.players.values()].map((p) => p.boatId).filter(Boolean),
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

  // 排行榜分桶用的真人数量：开赛瞬间统计（AI 不算）。中途有人退赛不改本局分桶。
  room.raceHumans = Math.max(1, Math.min(6, humanCount()));
  // 开赛瞬间把真人名单拍下来：结算时有人掉线也照样把整队写进排行榜。
  // AI 不进榜，所以这里和 raceHumans 用同一个过滤口径。
  room.raceRoster = [...room.players.values()]
    .filter((p) => !p.ai && p.ws)
    .slice(0, 6)
    .map((p) => ({
      name: p.name, avatar: typeof p.avatar === 'string' ? p.avatar : '',
      boatId: p.boatId || '', uid: p.uid || '',
    }));
  room.lbDone.clear();
  room.ticketDone.clear();

  // 重置比赛状态
  for (const p of room.players.values()) {
    p.state = null;
    p.phase = null;
    p.raceTime = 0;
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
    id: p.id, name: p.name, boatId: hexBoatByPlayer.get(p.id) || p.boatId, ai: p.ai, avatar: p.avatar || null,
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
    // 服务器墙钟：两端用同一条 start 广播算发车时刻（客户端会扣掉消息在路上的时间）
    startAt: room.roundStartAt,
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
      style: p.ai || !p.uid ? null : walletStyle(p.uid, p.name),
    };
  });

  // 竞速排行榜：只收个人赛（组队赛人多、碰撞多，成绩和单人不可比）。
  // 服务器手里就是最终成绩，直接记账 —— 客户端不参与，也伪造不了。
  if (room.mode === 'race' && room.format === 'solo') {
    leaderboard.recordRace({
      mapId: room.mapId,
      laps: room.settings.laps,
      results,
    });
  }

  // 积分：服务器手里就是最终名次，真人完赛才发；唯一键带 INSTANCE_ID，
  // 家里 LAN 和线上 Render 同时跑过同一局号也不会重复入账。
  for (const r of results) {
    if (r.ai || r.dnf || r.rank == null) continue;
    const p = room.players.get(r.id);
    if (!p?.uid) continue;
    const d = rankPoints(r.rank);
    const res = wallet.apply({
      id: newOpId('race', p.uid), uid: p.uid, kind: 'grant',
      d, mode: 'race', n: p.name,
    }, { localOnly: gameStore.kind === 'remote' });
    if (res.ok) sendWallet(p);
  }

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
  room.roundStartAt = 0;
  room.scores.clear();
  room.teamScores = { blue: 0, red: 0 };
  room.roundWins = { blue: 0, red: 0 };
  room.itemStats.clear();
  room.raceRoster = [];
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
  if (!list.length) return;
  // 附上房主的阶段/赛程时间：客机被后台标签页拖住时，靠它把本地状态直接拉到 racing，
  // 并按房主的 raceTime 对齐成绩（否则晚发车的一端结算时间会凭空少几秒）。
  const host = room.players.get(getHostId());
  const extra = host && typeof host.phase === 'string'
    ? { ph: host.phase, rt: Number(host.raceTime) || 0 }
    : null;
  broadcast({ t: 'snap', p: list, ...(extra || {}) });
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
