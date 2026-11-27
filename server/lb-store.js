// 排行榜的存储层：JSON 文件（默认）、MySQL（可选）或远端桥接（可选）。
//
// 为什么要分一层
// -------------
// 局域网和线上是两台机器上的两个进程。想让两边看到同一张榜，只能把成绩写进
// 同一个数据库；但数据库不能是"必须品" —— 家里开局域网时不装 MySQL 也得能玩，
// 数据库挂了也不能让比赛开不了局。所以：默认 JSON，配了 MYSQL_* 才走 MySQL，
// 配了 LEADERBOARD_REMOTE_URL 才走远端桥接，连不上自动回落并打日志。
//
// 三种实现的共同契约：
//   init()        读出全量榜单（对象：boardKey -> entry[]）
//   write(key,e)  落一条成绩（同名去重由上层内存逻辑 + 这里的条件更新共同保证）
//   readAll()     让上层刷新缓存；返回 null 表示"以内存为准，不用重读"
//
// 远端桥接是什么
// -------------
// 线上 Render 连不到家里的 127.0.0.1。用 cpolar 之类的隧道把家里那台
// server.js 的 3000 端口暴露出去之后，家里那份 leaderboard.json 就成了
// 唯一权威：局域网直接读它，线上通过 /lb-api/boards|write 读写它。
// 为避免 1Mbps 的免费隧道被头像 dataURL 撑爆，读接口支持 ?since= 增量拉取。
//
// 记录字段保持短名（n/a/b/t/bl/c/at），和文件版一致，换存储不用改上层逻辑：
//   n 名字  a 头像  b 赛艇  t 用时(秒)  bl 最快圈  c 通过关卡数  at 时间戳

import fs from 'node:fs';
import path from 'node:path';
import { normalizeBridgeUrl } from './public-url.js';

/** a 是否比 b 更好；b 为空表示榜上还没有这个人 */
export function better(a, b, kind) {
  if (!b) return true;
  const at = Number(a.t) || 0;
  const bt = Number(b.t) || 0;
  // 海克斯按层数、天梯按到达层数：层数优先，同层比用时
  if (kind === 'progress' || kind === 'tower') {
    const ac = Number(a.c) || 0;
    const bc = Number(b.c) || 0;
    if (ac !== bc) return ac > bc;
    return at < bt;
  }
  return at < bt;
}

// ---------- JSON 文件 ----------

const SAVE_DEBOUNCE_MS = 2000;

/**
 * JSON 存储：内存里的 { boards, players } 就是权威数据，写盘只是"落个备份"。
 * v1 老文件只有 boards，读到后补一层空 players；v2 原样带上钱包。
 */
export function createJsonStore(file) {
  let db = { v: 3, boards: {}, players: {}, accounts: {}, tokens: {} };
  let dirty = false;
  let timer = null;

  const persist = () => {
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 先写临时文件再改名：写到一半进程被杀也不会留下半个 JSON
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        v: 3,
        boards: db.boards || {},
        players: db.players || {},
        accounts: db.accounts || {},
        tokens: db.tokens || {},
      }));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[leaderboard] 保存失败：', err?.message || err);
    }
  };

  const schedule = () => {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (dirty) persist();
    }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
  };

  return {
    kind: 'json',
    file,
    async init() {
      try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (rec && typeof rec.boards === 'object' && rec.boards) {
          db = {
            v: 3,
            boards: rec.boards,
            players: rec.players && typeof rec.players === 'object' ? rec.players : {},
            accounts: rec.accounts && typeof rec.accounts === 'object' ? rec.accounts : {},
            tokens: rec.tokens && typeof rec.tokens === 'object' ? rec.tokens : {},
          };
        }
      } catch {
        // 文件不存在 / 被改坏：从空榜开始，不影响服务器启动
      }
      return db;
    },
    attach(boards, players, accounts, tokens) {
      if (boards) db.boards = boards;
      if (players) db.players = players;
      if (accounts) db.accounts = accounts;
      if (tokens) db.tokens = tokens;
    },
    async readAll() { return null; },
    write() { schedule(); },
    writePlayer() { schedule(); },
    writeAccount() { schedule(); },
    writeToken() { schedule(); },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (dirty) persist();
    },
    async close() { await this.flush(); },
  };
}

// ---------- MySQL ----------

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function tableName() {
  const raw = String(process.env.MYSQL_TABLE || 'leaderboard');
  // 表名是拼进 SQL 的（标识符不能用占位符），只允许字母数字下划线
  return /^[A-Za-z0-9_]{1,48}$/.test(raw) ? raw : 'leaderboard';
}

export function mysqlConfigFromEnv() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: envInt('MYSQL_PORT', 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'rapids_race',
    table: tableName(),
    ssl: process.env.MYSQL_SSL === '1' ? { rejectUnauthorized: false } : undefined,
  };
}

/**
 * MySQL 存储：两层结构，内存缓存负责排序和"同名只留最好"，
 * 数据库负责持久化与跨进程共享。读之前会按 TTL 从库里拉一次（readAll），
 * 所以局域网和线上可以同时写同一张表。
 */
export async function createMysqlStore(cfg = mysqlConfigFromEnv()) {
  let mysql;
  try {
    mysql = await import('mysql2/promise');
  } catch {
    throw new Error('没有安装 mysql2（npm i mysql2）');
  }

  const table = cfg.table || 'leaderboard';
  const base = {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    charset: 'utf8mb4',
    ssl: cfg.ssl,
    connectTimeout: 8000,
  };

  // 库可能还没建：先不带 database 连一次，建库后再建连接池
  {
    const boot = await mysql.createConnection(base);
    try {
      await boot.query(
        `CREATE DATABASE IF NOT EXISTS \`${String(cfg.database).replace(/[^A-Za-z0-9_]/g, '')}\`
         CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } finally {
      await boot.end().catch(() => {});
    }
  }

  const pool = mysql.createPool({ ...base, database: cfg.database, connectionLimit: 4, waitForConnections: true });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`${table}\` (
      board_key VARCHAR(64) NOT NULL,
      name VARCHAR(32) NOT NULL,
      avatar TEXT NULL,
      boat VARCHAR(32) NULL,
      team TEXT NULL,
      \`time\` DOUBLE NOT NULL DEFAULT 0,
      best_lap DOUBLE NULL,
      cleared TINYINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (board_key, name),
      KEY idx_board_time (board_key, \`time\`),
      KEY idx_board_cleared (board_key, cleared)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // 老库补列（必须放在 CREATE TABLE 之后）：MySQL 5.7 不支持 ADD COLUMN IF NOT EXISTS，
  // 重复列错误（1060）直接忽略。
  try {
    await pool.query('ALTER TABLE `' + table + '` ADD COLUMN team TEXT NULL');
  } catch (err) {
    if (err?.code !== 'ER_DUP_FIELDNAME' && err?.errno !== 1060) throw err;
  }

  // 钱包与榜单同库不同表：uid 是主键，data 存整个玩家档案（余额/背包/流水）。
  const playerTable = `${table}_players`;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`${playerTable}\` (
      uid VARCHAR(64) NOT NULL,
      name VARCHAR(32) NOT NULL DEFAULT '',
      data TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (uid),
      KEY idx_player_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // 账号 / 会话：用户名是唯一索引，密码和备用码只存盐 + 哈希
  const accountTable = `${table}_accounts`;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`${accountTable}\` (
      user_key VARCHAR(32) NOT NULL,
      uid VARCHAR(64) NOT NULL,
      user_name VARCHAR(32) NOT NULL,
      data TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (user_key),
      UNIQUE KEY idx_account_uid (uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  const tokenTable = `${table}_tokens`;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`${tokenTable}\` (
      token VARCHAR(128) NOT NULL,
      uid VARCHAR(64) NOT NULL,
      data TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (token),
      KEY idx_token_uid (uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const parseTeam = (v) => {
    if (!v) return undefined;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : undefined; } catch { return undefined; }
  };

  const rowToEntry = (r) => {
    const team = parseTeam(r.team);
    return {
      n: r.name,
      a: r.avatar || '',
      b: r.boat || '',
      ...(team ? { p: team } : {}),
      t: Number(r.time) || 0,
      bl: r.best_lap == null ? null : Number(r.best_lap),
      c: Number(r.cleared) || 0,
      at: Number(r.updated_at) || 0,
    };
  };

  const rowToPlayer = (r) => {
    try {
      const data = JSON.parse(r.data);
      return data && typeof data === 'object' ? data : null;
    } catch { return null; }
  };

  return {
    kind: 'mysql',
    async init() {
      // 首次启动直接空表；数据由 readAll 在需要时拉
      return { boards: {}, players: {}, accounts: {}, tokens: {} };
    },
    attach() {},
    async readAll() {
      const [rows] = await pool.query(
        `SELECT board_key, name, avatar, boat, team, \`time\`, best_lap, cleared, updated_at
           FROM \`${table}\``,
      );
      const boards = {};
      for (const r of rows) {
        (boards[r.board_key] || (boards[r.board_key] = [])).push(rowToEntry(r));
      }
      const [prows] = await pool.query(`SELECT uid, name, data, updated_at FROM \`${playerTable}\``);
      const players = {};
      for (const r of prows) {
        const data = rowToPlayer(r);
        if (data) players[r.uid] = data;
      }
      const [arows] = await pool.query(`SELECT user_key, data FROM \`${accountTable}\``);
      const accounts = {};
      for (const r of arows) {
        try { accounts[r.user_key] = JSON.parse(r.data); } catch { /* 坏行跳过 */ }
      }
      const [trows] = await pool.query(`SELECT token, data FROM \`${tokenTable}\``);
      const tokens = {};
      for (const r of trows) {
        try { tokens[r.token] = JSON.parse(r.data); } catch { /* 坏行跳过 */ }
      }
      return { boards, players, accounts, tokens };
    },
    /**
     * 条件写入：先锁行再比较，避免局域网和线上同时提交时把更好的成绩覆盖掉。
     * 单条记录一次事务，写入量很小（一局几个人），性能不是问题。
     */
    async write(boardKey, entry, kind) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.execute(
          `SELECT \`time\`, cleared FROM \`${table}\` WHERE board_key = ? AND name = ? FOR UPDATE`,
          [boardKey, entry.n],
        );
        if (!rows.length) {
          await conn.execute(
            `INSERT INTO \`${table}\`
               (board_key, name, avatar, boat, team, \`time\`, best_lap, cleared, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [boardKey, entry.n, entry.a || '', entry.b || '',
              entry.p ? JSON.stringify(entry.p) : null, Number(entry.t) || 0,
              entry.bl == null ? null : Number(entry.bl), Number(entry.c) || 0, Number(entry.at) || Date.now()],
          );
        } else if (better(entry, { t: rows[0].time, c: rows[0].cleared }, kind)) {
          await conn.execute(
            `UPDATE \`${table}\`
                SET avatar = ?, boat = ?, team = ?, \`time\` = ?, best_lap = ?, cleared = ?, updated_at = ?
              WHERE board_key = ? AND name = ?`,
            [entry.a || '', entry.b || '', entry.p ? JSON.stringify(entry.p) : null, Number(entry.t) || 0,
              entry.bl == null ? null : Number(entry.bl), Number(entry.c) || 0,
              Number(entry.at) || Date.now(), boardKey, entry.n],
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    },
    /**
     * 钱包写入：按 updated_at 条件覆盖，避免局域网和线上两台机器互相冲掉余额。
     * 真正的并发安全靠 wallet.js 的 op 幂等 + 这里的条件更新两层一起保证。
     */
    async writePlayer(uid, record) {
      if (!uid) return;
      const at = Number(record.at) || Date.now();
      await pool.execute(
        `INSERT INTO \`${playerTable}\` (uid, name, data, updated_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = IF(VALUES(updated_at) >= updated_at, VALUES(name), name),
           data = IF(VALUES(updated_at) >= updated_at, VALUES(data), data),
           updated_at = GREATEST(updated_at, VALUES(updated_at))`,
        [String(uid).slice(0, 64), String(record.n || '').slice(0, 32),
          JSON.stringify(record), at],
      );
    },
    async writeAccount(key, record) {
      if (!key) return;
      await pool.execute(
        `INSERT INTO \`${accountTable}\` (user_key, uid, user_name, data, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`,
        [String(key).slice(0, 32), String(record.uid || '').slice(0, 64),
          String(record.user || '').slice(0, 32), JSON.stringify(record),
          Number(record.at) || Date.now()],
      );
    },
    async writeToken(token, record) {
      if (!token) return;
      await pool.execute(
        `INSERT INTO \`${tokenTable}\` (token, uid, data, updated_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`,
        [String(token).slice(0, 128), String(record.uid || '').slice(0, 64),
          JSON.stringify(record), Number(record.at) || Date.now()],
      );
    },
    async flush() { /* 每条写入都是即时事务，没有待落盘队列 */ },
    async close() { await pool.end().catch(() => {}); },
    get info() { return `${cfg.host}:${cfg.port}/${cfg.database}.${table}`; },
  };
}

// ---------- 远端桥接（家里那份 JSON，通过隧道给线上用） ----------

/** 待补发队列上限：隧道断一天也不至于把内存吃满 */
const OUTBOX_MAX = 500;
/** 一次 POST 带多少条：一批 10 条，按 1Mbps 的隧道算也就几 KB */
const OUTBOX_BATCH = 10;
const WRITE_DEBOUNCE_MS = 800;

export function remoteConfigFromEnv() {
  return {
    url: normalizeBridgeUrl(process.env.LEADERBOARD_REMOTE_URL),
    token: process.env.LEADERBOARD_TOKEN || '',
  };
}

/**
 * 远端存储：真正数据在家里那台 server.js 的 leaderboard.json，
 * 本进程（线上 Render）只是个"带缓存的代理"。
 *
 * - 读：GET /lb-api/boards?since=<上次拿到的时间戳>，只取新增/更新的记录。
 *   since 是**家里那台时钟**，写接口会用自己的 now 覆盖 entry.at，
 *   所以两台机器的时钟不同步也不会漏数据。
 * - 写：先进待补发队列，再 POST /lb-api/write。隧道断了就留在队列里，
 *   下次读成功或下次写入时自动重试（最多攒 OUTBOX_MAX 条）。
 * - 读失败返回 null：上层保留内存缓存，玩家不会看到空榜，也不会刷屏报错。
 *
 * @param {{url:string, token:string}} cfg
 */
export function createRemoteStore(cfg = remoteConfigFromEnv()) {
  let base = normalizeBridgeUrl(cfg.url);
  const token = cfg.token || '';
  /** 合并后的全量数据：榜单 + 钱包，增量拉回来的结果拼在这里 */
  let cache = { boards: {}, players: {}, accounts: {}, tokens: {} };
  /** 已经同步到的时间点（对端时钟） */
  let since = 0;
  /** @type {Array<object>} 榜单条目与钱包 op 共用一个补发队列 */
  const outbox = [];
  let timer = null;
  let flushing = null;
  let lastWarn = 0;

  /** 隧道断了会每 3 秒重试一次，日志按分钟节流，别把 stdout 刷满 */
  const warn = (msg) => {
    const now = Date.now();
    if (now - lastWarn < 60000) return;
    lastWarn = now;
    console.warn(`[leaderboard] ${msg}`);
  };

  async function call(pathname, init = {}) {
    const ac = new AbortController();
    // 免费隧道（cpolar / localhost.run）经常几十秒才回，8 秒太短：
    // 一超时就整轮同步失败，榜单和钱包都会卡在旧缓存上。20 秒留出余量，
    // 真断线时也只多等一下，不会把请求堆死（readAll 有 TTL 去重）。
    const timerId = setTimeout(() => ac.abort(), 20000);
    timerId.unref?.();
    try {
      const res = await fetch(base + pathname, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timerId);
    }
  }

  /** 增量合并：榜单名沿用 better()，钱包用家里的 at 无条件覆盖本地 optimistic 值 */
  function merge(data) {
    for (const [key, list] of Object.entries(data?.boards || {})) {
      if (!Array.isArray(list)) continue;
      const dst = cache.boards[key] || (cache.boards[key] = []);
      const kind = key.startsWith('hx:') || key.startsWith('tw:') ? 'progress' : 'time';
      for (const e of list) {
        if (!e || !e.n) continue;
        const i = dst.findIndex((x) => x.n === e.n);
        if (i < 0) dst.push(e);
        else if (better(e, dst[i], kind)) dst[i] = e;
      }
    }
    for (const [uid, p] of Object.entries(data?.players || {})) {
      if (!uid || !p || typeof p !== 'object') continue;
      const cur = cache.players[uid];
      if (!cur || (Number(p.at) || 0) >= (Number(cur.at) || 0)) cache.players[uid] = p;
    }
    return cache;
  }

  function drain() {
    if (flushing) return flushing;
    flushing = (async () => {
      while (outbox.length) {
        const batch = outbox.slice(0, OUTBOX_BATCH);
        await call('/lb-api/write', { method: 'POST', body: JSON.stringify({ items: batch }) });
        outbox.splice(0, batch.length);
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      drain().catch((err) => warn(`成绩/积分还没送到家里服务器（${outbox.length} 条待补发）：${err?.message || err}`));
    }, WRITE_DEBOUNCE_MS);
    timer.unref?.();
  };

  const api = {
    kind: 'remote',
    get info() { return String(base).replace(/^https?:\/\//, ''); },
    async init() {
      // 先拉一次：隧道没通就空榜起步，不影响开局
      try { await api.readAll(); } catch { /* readAll 自己已经处理过错误 */ }
      return cache;
    },
    attach(boards, players, accounts, tokens) {
      // 上层把内存引用接走；remote 仍以自家 cache 为准，只把引用对齐
      if (boards) cache.boards = boards;
      if (players) cache.players = players;
      if (accounts) cache.accounts = accounts;
      if (tokens) cache.tokens = tokens;
    },
    /** @returns {Promise<{boards:object, players:object}|null>} null = 保留内存缓存 */
    async readAll() {
      let data;
      try {
        data = await call(`/lb-api/boards?since=${since}`);
      } catch (err) {
        warn(`读家里服务器失败：${err?.message || err}`);
        // 隧道刚恢复时，借这次读把积压的成绩补发掉
        if (outbox.length && !flushing) schedule();
        return null;
      }
      merge(data);
      const at = Number(data?.at) || 0;
      if (at > since) since = at;
      return cache;
    },
    write(key, entry, kind) {
      outbox.push({ type: 'board', key, entry, kind });
      if (outbox.length > OUTBOX_MAX) outbox.shift(); // 太长就丢最旧的，避免无限增长
      schedule();
    },
    /** 钱包只推 op，不推整条余额：家里按 op.id 幂等应用，天然不会互相覆盖 */
    writePlayer(uid, record, op) {
      if (!op) return;
      outbox.push({ type: 'walletOp', op });
      if (outbox.length > OUTBOX_MAX) outbox.shift();
      schedule();
    },
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      await drain().catch(() => {});
    },
    async close() { await api.flush(); },
    /**
     * 换目标地址（cpolar 免费版重启就会换域名，线上靠 /lb-api/register 更新这里）。
     * 地址一变就清缓存、从头全量拉，避免新旧两份数据混在一起。
     */
    async setUrl(url) {
      const next = normalizeBridgeUrl(url);
      if (!next) return false;
      if (next === base) return true;
      base = next;
      since = 0;
      cache = { boards: {}, players: {}, accounts: {}, tokens: {} };
      await drain().catch(() => {}); // 积压的成绩发给新地址（也是同一个家）
      return true;
    },
    /**
     * 账号操作必须由家里那台权威实例做：线上 Render 直接把请求转发到 /lb-api/auth，
     * 不自己存密码哈希，也不在两端各生成一份 token。
     */
    async authRequest(action, payload) {
      const data = await call('/lb-api/auth', {
        method: 'POST',
        body: JSON.stringify({ action, payload }),
      });
      return data;
    },
  };
  return api;
}

/**
 * 按环境变量选存储。LB_STORE=mysql 才连库，=remote 才走远端桥接；
 * 配不上就用 JSON，并说明原因。
 * @param {{file?:string, force?:'json'|'mysql'|'remote'}} opts
 */
export async function createStore(opts = {}) {
  const want = opts.force || process.env.LB_STORE || 'json';
  const file = opts.file || process.env.LEADERBOARD_FILE || 'server/data/leaderboard.json';
  if (want === 'remote') {
    const cfg = remoteConfigFromEnv();
    if (!cfg.url || !cfg.token) {
      console.warn('[排行榜] LB_STORE=remote 但没配 LEADERBOARD_REMOTE_URL / LEADERBOARD_TOKEN，回落到 JSON 文件');
    } else {
      console.log(`[排行榜] 使用家里服务器：${cfg.url}`);
      return createRemoteStore(cfg);
    }
  }
  if (want === 'mysql') {
    try {
      const store = await createMysqlStore();
      console.log(`[排行榜] 使用 MySQL：${store.info}`);
      return store;
    } catch (err) {
      console.warn(`[排行榜] MySQL 连接失败，回落到 JSON 文件：${err?.message || err}`);
    }
  }
  return createJsonStore(file);
}
