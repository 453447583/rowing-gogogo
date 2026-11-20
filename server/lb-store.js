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
  if (kind === 'progress') {
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
 * JSON 存储：内存里的 boards 就是权威数据，写盘只是"落个备份"。
 * 因此 init 返回空对象、由上层把 boards 传进来（attach），write 只标记脏。
 */
export function createJsonStore(file) {
  let ref = null;
  let dirty = false;
  let timer = null;

  const persist = () => {
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 先写临时文件再改名：写到一半进程被杀也不会留下半个 JSON
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, boards: ref || {} }));
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
        if (rec && rec.v === 1 && rec.boards && typeof rec.boards === 'object') return rec.boards;
      } catch {
        // 文件不存在 / 被改坏：从空榜开始，不影响服务器启动
      }
      return {};
    },
    attach(boards) { ref = boards; },
    async readAll() { return null; },
    write() { schedule(); },
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
      \`time\` DOUBLE NOT NULL DEFAULT 0,
      best_lap DOUBLE NULL,
      cleared TINYINT UNSIGNED NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (board_key, name),
      KEY idx_board_time (board_key, \`time\`),
      KEY idx_board_cleared (board_key, cleared)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const rowToEntry = (r) => ({
    n: r.name,
    a: r.avatar || '',
    b: r.boat || '',
    t: Number(r.time) || 0,
    bl: r.best_lap == null ? null : Number(r.best_lap),
    c: Number(r.cleared) || 0,
    at: Number(r.updated_at) || 0,
  });

  return {
    kind: 'mysql',
    async init() {
      // 首次启动直接空表；数据由 readAll 在需要时拉
      return {};
    },
    attach() {},
    async readAll() {
      const [rows] = await pool.query(
        `SELECT board_key, name, avatar, boat, \`time\`, best_lap, cleared, updated_at
           FROM \`${table}\``,
      );
      const out = {};
      for (const r of rows) {
        (out[r.board_key] || (out[r.board_key] = [])).push(rowToEntry(r));
      }
      return out;
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
               (board_key, name, avatar, boat, \`time\`, best_lap, cleared, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [boardKey, entry.n, entry.a || '', entry.b || '', Number(entry.t) || 0,
              entry.bl == null ? null : Number(entry.bl), Number(entry.c) || 0, Number(entry.at) || Date.now()],
          );
        } else if (better(entry, { t: rows[0].time, c: rows[0].cleared }, kind)) {
          await conn.execute(
            `UPDATE \`${table}\`
                SET avatar = ?, boat = ?, \`time\` = ?, best_lap = ?, cleared = ?, updated_at = ?
              WHERE board_key = ? AND name = ?`,
            [entry.a || '', entry.b || '', Number(entry.t) || 0,
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
  /** 合并后的全量榜单（增量拉回来的结果拼在这里） */
  let cache = {};
  /** 已经同步到的时间点（对端时钟） */
  let since = 0;
  /** @type {Array<{key:string, entry:object, kind:string}>} */
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
    const timerId = setTimeout(() => ac.abort(), 8000);
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

  /** 增量合并：同名记录用 better() 决定要不要替换（和家里那台口径一致） */
  function merge(boards) {
    for (const [key, list] of Object.entries(boards || {})) {
      if (!Array.isArray(list)) continue;
      const dst = cache[key] || (cache[key] = []);
      const kind = key.startsWith('hx:') ? 'progress' : 'time';
      for (const e of list) {
        if (!e || !e.n) continue;
        const i = dst.findIndex((x) => x.n === e.n);
        if (i < 0) dst.push(e);
        else if (better(e, dst[i], kind)) dst[i] = e;
      }
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
      drain().catch((err) => warn(`成绩还没送到家里服务器（${outbox.length} 条待补发）：${err?.message || err}`));
    }, WRITE_DEBOUNCE_MS);
    timer.unref?.();
  };

  const api = {
    kind: 'remote',
    get info() { return String(base).replace(/^https?:\/\//, ''); },
    async init() {
      // 先拉一次：隧道没通就空榜起步，不影响开局
      try { await api.readAll(); } catch { /* readAll 自己已经处理过错误 */ }
      return {};
    },
    attach() {},
    /** @returns {Promise<Record<string, Array<object>>|null>} null = 保留内存缓存 */
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
      merge(data?.boards);
      const at = Number(data?.at) || 0;
      if (at > since) since = at;
      return cache;
    },
    write(key, entry, kind) {
      outbox.push({ key, entry, kind });
      if (outbox.length > OUTBOX_MAX) outbox.shift(); // 太长就丢最旧的，避免无限增长
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
      cache = {};
      await drain().catch(() => {}); // 积压的成绩发给新地址（也是同一个家）
      return true;
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
