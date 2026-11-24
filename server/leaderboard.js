// 联机排行榜（服务器端唯一权威）。
//
// 为什么放在服务器
// ----------------
// 排行榜是"所有人共享"的数据：客户端各存各的 localStorage 只能看到自己，
// 局域网里几个人对不上号。所以由服务器在结算时直接记账，客户端只读不写
// （怪物 / 海克斯没有统一结算，才允许房主一次性上报，见 recordBoss）。
//
// 存储
// ----
// 默认写 JSON 文件；配了 MYSQL_* 并设 LB_STORE=mysql 就改走 MySQL，
// 这样局域网那台机器和线上 Render 可以读写同一张榜（细节见 lb-store.js）。
// 内存里始终保一份全量缓存：排序、同名去重、Top N 都在这里算，
// 数据库只负责持久化，读的时候按 3 秒 TTL 同步一次。
//
// 榜单 key 命名（短前缀，纯粹为了 JSON / 表里小一点）
//   r:<mapId>:<laps>        竞速：地图 × 圈数（只收个人赛）
//   bt:<humans>             怪物：四关全通总时长
//   bs:<humans>:<stage>     怪物：单关最快
//   hx:<humans>             海克斯：通过关卡数 → 总用时
//
// 每条记录：
//   n 名字（去重键）  a 头像  b 赛艇  t 用时(秒)  bl 最快圈(竞速)
//   c 通过关卡数(海克斯)  at 时间戳  p 整队名单[{n,a,b}]（怪物/海克斯，房主排第一）

import { createStore, better } from './lb-store.js';

const MAX_PER_BOARD = 50;
/** 下发给客户端的条数：面板只展示 Top10，留 20 条够「我的最好成绩」落位 */
const SHIP_PER_BOARD = 20;
const MAX_NAME = 12;
/** 从库里重新拉全量的最小间隔（局域网 + 线上同时在线时别每个请求都打库） */
const READ_TTL_MS = Number(process.env.LEADERBOARD_TTL_MS) || 3000;

/** 数字清洗：非法/负数/离谱值直接丢弃，避免伪造包把榜单写成 NaN */
function num(v, max = 86400) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return Math.round(n * 100) / 100;
}

function cleanName(v) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME);
}

/** 榜单排序：海克斯按通过关卡数，其余按用时；同分规则和写入时保持一致 */
function sortBoard(key, list) {
  const progress = key.startsWith('hx:');
  list.sort((a, b) => (progress
    ? ((Number(b.c) || 0) - (Number(a.c) || 0)) || ((Number(a.t) || 0) - (Number(b.t) || 0))
    : (Number(a.t) || 0) - (Number(b.t) || 0)));
  if (list.length > MAX_PER_BOARD) list.length = MAX_PER_BOARD;
  return list;
}

/**
 * @param {{file?:string, store?:object}} opts store 可注入（测试用），否则按环境变量选
 */
export async function createLeaderboard(opts = {}) {
  const store = opts.store || await createStore({ file: opts.file });
  /** @type {Record<string, Array<object>>} */
  let boards = (await store.init()) || {};
  store.attach?.(boards);
  let lastRead = 0;
  // 写队列：一局结算可能同时写 5 条，串行化后事务顺序可控，也不会打爆连接池
  let chain = Promise.resolve();

  function enqueue(fn) {
    chain = chain.then(fn).catch((err) => {
      console.warn('[leaderboard] 写入失败：', err?.message || err);
    });
    return chain;
  }

  /**
   * 写一条成绩（内存 + 底层存储）。
   * @param {string} key 榜单 key
   * @param {object} entry 已清洗的记录
   * @param {'time'|'progress'} kind
   */
  function add(key, entry, kind = 'time') {
    if (!key || !entry || !entry.n) return false;
    const list = boards[key] || (boards[key] = []);
    // 同名只留最好一条：不然一个人刷十次就能占满整张榜
    const idx = list.findIndex((e) => e.n === entry.n);
    if (idx >= 0) {
      if (!better(entry, list[idx], kind)) return false;
      list.splice(idx, 1);
    }
    list.push(entry);
    sortBoard(key, list);
    enqueue(() => store.write(key, entry, kind));
    return true;
  }

  /** 竞速：服务器在结算时直接记账，客户端不参与 */
  function recordRace({ mapId, laps, results }) {
    if (!mapId) return 0;
    const key = `r:${mapId}:${Math.max(1, Math.min(9, Number(laps) || 1))}`;
    let n = 0;
    for (const r of results || []) {
      if (r.ai) continue;                  // AI 不进榜
      if (r.dnf) continue;                 // 没跑完的不算成绩
      const t = num(r.time);
      if (!t) continue;
      const name = cleanName(r.name);
      if (!name) continue;
      if (add(key, {
        n: name,
        a: typeof r.avatar === 'string' ? r.avatar : '',
        b: r.boatId || '',
        t,
        bl: num(r.bestLap, 3600),
        at: Date.now(),
      })) n++;
    }
    return n;
  }

  /**
   * 怪物 / 海克斯：房主一次性上报。
   * @param {{variant:'classic'|'hex', humans:number, victory:boolean,
   *          totalTime:number, cleared?:number,
   *          stages:Array<{stage:number,elapsed:number}>,
   *          player:{name:string, avatar?:string, boatId?:string},
   *          players?:Array<{name:string, avatar?:string, boatId?:string}>} p
   */
  function recordBoss(p) {
    const humans = Math.max(1, Math.min(6, Math.round(Number(p.humans) || 1)));
    const who = p.player || {};
    const name = cleanName(who.name);
    if (!name) return 0;
    const base = {
      n: name,
      a: typeof who.avatar === 'string' ? who.avatar : '',
      b: who.boatId || '',
      at: Date.now(),
    };
    // 怪物 / 海克斯是团队成绩：把开赛时服务器拍下的真人名单整份存下来。
    // 去重按名字（和榜单去重键一致），房主/上报者排第一，UI 会把他标红。
    const team = [];
    const seen = new Set();
    for (const pl of (Array.isArray(p.players) ? p.players : [])) {
      if (pl?.ai) continue; // AI 不进榜，整队名单里也不该出现
      const nm = cleanName(pl?.name ?? pl?.n);
      if (!nm || seen.has(nm)) continue;
      seen.add(nm);
      team.push({
        n: nm,
        a: typeof pl?.avatar === 'string' ? pl.avatar : '',
        b: pl?.boatId || '',
      });
      if (team.length >= 6) break;
    }
    if (!seen.has(name)) team.unshift({ n: name, a: base.a, b: base.b });
    base.p = team;
    const stages = Array.isArray(p.stages) ? p.stages : [];
    let n = 0;

    if (p.variant === 'hex') {
      // 海克斯：按「通过关卡数」排，同关卡比总用时。失败也记 ——
      // 这样榜上能看到"打到第几关"，而不是只有通关的人有资格。
      const cleared = Math.max(0, Math.min(stages.length, Math.round(Number(p.cleared ?? stages.length) || 0)));
      const t = num(stages.reduce((s, x) => s + (Number(x.elapsed) || 0), 0)) || num(p.totalTime);
      if (!t || cleared < 1) return 0;
      if (add(`hx:${humans}`, { ...base, c: cleared, t }, 'progress')) n++;
      return n;
    }

    if (!p.victory) return 0; // 经典闯关只收四关全通
    const total = num(p.totalTime) || num(stages.reduce((s, x) => s + (Number(x.elapsed) || 0), 0));
    if (!total) return 0;
    if (add(`bt:${humans}`, { ...base, t: total })) n++;
    for (const s of stages) {
      const st = Math.round(Number(s.stage) || 0);
      const el = num(s.elapsed, 3600);
      if (st < 1 || st > 9 || !el) continue;
      if (add(`bs:${humans}:${st}`, { ...base, t: el })) n++;
    }
    return n;
  }

  /**
   * 刷新缓存（仅当存储支持"别人也可能写"时才有意义）。
   * 先把待写队列排空，再拉全量，保证刚提交的成绩自己马上能看到。
   */
  async function refresh(force = false) {
    const now = Date.now();
    if (!force && now - lastRead < READ_TTL_MS) return false;
    lastRead = now;
    await chain;
    let data = null;
    try {
      data = await store.readAll();
    } catch (err) {
      console.warn('[leaderboard] 读取失败：', err?.message || err);
      return false;
    }
    if (!data) return false; // JSON：内存即权威
    // 库里读回来的顺序不保证（MySQL 不写 ORDER BY），这里统一排一遍再进缓存
    for (const [key, list] of Object.entries(data)) {
      if (Array.isArray(list)) sortBoard(key, list);
    }
    boards = data;
    store.attach?.(boards);
    return true;
  }

  /** 给面板用的快照：每榜前 20 + 请求者自己的最好一条 */
  function snapshot(meName) {
    const boardsOut = {};
    const mine = {};
    for (const [key, list] of Object.entries(boards)) {
      if (!Array.isArray(list) || !list.length) continue;
      boardsOut[key] = list.slice(0, SHIP_PER_BOARD);
      if (meName) {
        const own = list.find((e) => e.n === meName);
        if (own) mine[key] = own;
      }
    }
    return { v: 1, boards: boardsOut, mine, at: Date.now(), store: store.kind };
  }

  /** 全量榜单（只读引用：桥接接口 /lb-api/boards 用，别就地改） */
  function raw() {
    return boards;
  }

  /**
   * 线上实例专用：家里那台换了公网地址就切过去并立刻重拉。
   * 只对支持 setUrl 的存储（远端桥接）有效。
   * @returns {Promise<boolean>} 是否切换成功
   */
  async function setRemoteUrl(url) {
    if (typeof store.setUrl !== 'function') return false;
    const changed = await store.setUrl(url);
    if (changed) await refresh(true);
    return changed;
  }

  return {
    recordRace,
    recordBoss,
    refresh,
    snapshot,
    add,
    raw,
    setRemoteUrl,
    get kind() { return store.kind; },
    /** 存储位置（JSON 是文件路径，MySQL 是 host:port/db.table），启动日志里打出来 */
    get location() { return store.info || store.file || ''; },
    get size() { return Object.keys(boards).length; },
    /** 立刻落盘 / 排空写队列（进程退出前用） */
    async flush() {
      await chain;
      await store.flush?.();
    },
    async close() {
      await chain;
      await store.close?.();
    },
  };
}
