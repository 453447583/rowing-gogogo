// 积分钱包：和排行榜共用同一份 leaderboard.json（v2 的 players 层）。
//
// 为什么要独立一层
// ----------------
// boards 是"同名只留最好成绩"的成绩单，钱包是"每笔收支都要累计"的账户。
// 两者混在 boards 里会被 better() / Top50 截断玩坏，所以这里只碰 db.players。
//
// 写入口径：所有变更都是一条 op（带唯一 id），apply 幂等。
//   家里 JSON / MySQL：直接改权威 players 并落盘。
//   线上 remote：先在本地缓存 apply（at 置 0，等家里回包覆盖），再把 op 推给家里。
// 这样两台机器同时给同一个 uid 加分也不会互相覆盖。

import { SHOP_MAP } from '../src/data/shop.js';

const UID_RE = /^u_[A-Za-z0-9_-]{6,48}$/;
const ITEM_RE = /^[a-z0-9_]{1,32}$/;
const MODE_RE = /^[a-z0-9_:]{1,24}$/;
const MAX_DAILY = 300;
const MAX_GRANT = 200;
const MAX_SEEN = 500;
const MAX_LOG = 60;
const READ_TTL_MS = Number(process.env.LEADERBOARD_TTL_MS) || 3000;

export function cleanUid(v) {
  const s = String(v ?? '');
  return UID_RE.test(s) ? s : '';
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function blank(uid) {
  return {
    uid, n: '', pts: 0, earned: 0, spent: 0,
    inv: {}, equip: { frame: '', title: '', fx: '', paint: '', nitroFx: '', badges: [] },
    seen: {}, log: [], day: { date: '', earned: 0 },
    at: 0,
  };
}

/** 把桥接 / 客户端送来的 op 洗成安全结构；at 一律由家里服务器覆盖。 */
export function sanitizeWalletOp(raw, { homeClock = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
  const uid = cleanUid(raw.uid);
  if (!id || !uid) return null;
  const kind = String(raw.kind ?? '');
  if (!['grant', 'buy', 'useTicket', 'equip'].includes(kind)) return null;
  const op = {
    id, uid, kind,
    n: String(raw.n ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12),
    at: homeClock ? Date.now() : (Number(raw.at) || Date.now()),
  };
  if (kind === 'grant') {
    const d = Math.round(Number(raw.d));
    op.d = Number.isFinite(d) && d > 0 ? Math.min(MAX_GRANT, d) : 0;
    op.mode = MODE_RE.test(String(raw.mode ?? '')) ? String(raw.mode) : 'other';
    if (!op.d) return null;
  } else if (kind === 'buy') {
    if (!SHOP_MAP[String(raw.item ?? '')]) return null;
    op.item = String(raw.item);
  } else if (kind === 'useTicket') {
    // 券可以有多张：按客户端指定（服务器会再校验这张券是否在当前模式生效）。
    // 老客户端不带 item 时仍按幸运券处理。
    const key = String(raw.item ?? '') || 'hex_ticket';
    if (SHOP_MAP[key]?.type !== 'ticket') return null;
    op.item = key;
  } else if (kind === 'equip') {
    const slot = String(raw.slot ?? '');
    if (!['frame', 'title', 'fx', 'paint', 'badge', 'nitroFx'].includes(slot)) return null;
    if (!ITEM_RE.test(String(raw.item ?? ''))) return null;
    // 喷射尾焰是新槽：只认本类商品，别把头像框塞进尾焰槽（老槽沿用原校验）
    if (slot === 'nitroFx' && SHOP_MAP[String(raw.item)]?.type !== 'nitroFx') return null;
    op.slot = slot;
    op.item = String(raw.item);
  }
  return op;
}

export function createWallet({ store, db }) {
  let players = db?.players || (db ? (db.players = {}) : {});
  let lastRead = 0;

  function get(uid) {
    const id = cleanUid(uid);
    return id ? (players[id] || null) : null;
  }

  function remember(p, op, label, localOnly) {
    p.seen[op.id] = op.at || Date.now();
    const ids = Object.keys(p.seen);
    for (let i = 0; i < ids.length - MAX_SEEN; i++) delete p.seen[ids[i]];
    p.log.unshift({ id: op.id, d: label, mode: op.mode || op.kind, at: op.at || Date.now() });
    if (p.log.length > MAX_LOG) p.log.length = MAX_LOG;
    if (op.n) p.n = op.n;
    // remote 上先记账、时间戳留 0：家里的权威快照一到就能无条件覆盖本机缓存
    p.at = localOnly ? 0 : (op.at || Date.now());
  }

  /**
   * 应用一条积分操作。
   * @returns {{ok:boolean, duplicate?:boolean, reason?:string, player?:object}}
   */
  function apply(raw, { localOnly = false, homeClock = false } = {}) {
    const op = sanitizeWalletOp(raw, { homeClock });
    if (!op) return { ok: false, reason: 'bad-op' };
    const p = players[op.uid] || (players[op.uid] = blank(op.uid));
    if (p.seen?.[op.id]) return { ok: false, duplicate: true, player: p };
    p.seen ||= {};
    p.log ||= [];
    p.day ||= { date: '', earned: 0 };

    if (op.kind === 'grant') {
      if (p.day.date !== today()) p.day = { date: today(), earned: 0 };
      const remain = Math.max(0, MAX_DAILY - (Number(p.day.earned) || 0));
      if (remain <= 0) return { ok: false, reason: 'daily-limit', player: p };
      const d = Math.min(op.d, remain);
      p.pts = (Number(p.pts) || 0) + d;
      p.earned = (Number(p.earned) || 0) + d;
      p.day.earned += d;
      remember(p, op, `+${d} 积分`, localOnly);
    } else if (op.kind === 'buy') {
      const item = SHOP_MAP[op.item];
      const cost = Number(item?.cost) || 0;
      if (!cost || (Number(p.pts) || 0) < cost) return { ok: false, reason: 'not-enough', player: p };
      p.pts -= cost;
      p.spent = (Number(p.spent) || 0) + cost;
      p.inv ||= {};
      p.inv[op.item] = (Number(p.inv[op.item]) || 0) + 1;
      remember(p, op, `兑换 ${item.name} -${cost}`, localOnly);
    } else if (op.kind === 'useTicket') {
      p.inv ||= {};
      const key = op.item || 'hex_ticket';
      if ((Number(p.inv[key]) || 0) < 1) return { ok: false, reason: 'no-ticket', player: p };
      p.inv[key] -= 1;
      if (p.inv[key] <= 0) delete p.inv[key];
      remember(p, op, `使用${SHOP_MAP[key]?.name || '券'}`, localOnly);
    } else if (op.kind === 'equip') {
      p.inv ||= {};
      if ((Number(p.inv[op.item]) || 0) < 1) return { ok: false, reason: 'not-owned', player: p };
      p.equip ||= { frame: '', title: '', fx: '', paint: '', nitroFx: '', badges: [] };
      if (op.slot === 'badge') {
        // 徽章是"最多同时戴 3 枚"的收藏槽：再点一次摘下来，满了拒绝
        const list = Array.isArray(p.equip.badges) ? p.equip.badges : [];
        const at = list.indexOf(op.item);
        if (at >= 0) list.splice(at, 1);
        else if (list.length >= 3) return { ok: false, reason: 'badge-full', player: p };
        else list.push(op.item);
        p.equip.badges = list;
      } else {
        p.equip[op.slot] = op.item;
      }
      remember(p, op, `装备 ${SHOP_MAP[op.item]?.name || op.item}`, localOnly);
    }

    store?.writePlayer?.(op.uid, p, op);
    return { ok: true, player: p };
  }

  async function refresh(force = false) {
    const now = Date.now();
    if (!force && now - lastRead < READ_TTL_MS) return false;
    lastRead = now;
    let data = null;
    try { data = await store?.readAll?.(); } catch { return false; }
    if (!data?.players) return false;
    players = data.players;
    if (db) db.players = players;
    return true;
  }

  function snapshot(uid, name = '') {
    const p = get(uid);
    if (!p) return { uid: cleanUid(uid), n: name, pts: 0, earned: 0, spent: 0, inv: {}, equip: { frame: '', title: '' }, log: [], at: 0 };
    return {
      uid: p.uid, n: name || p.n || '',
      pts: Number(p.pts) || 0,
      earned: Number(p.earned) || 0,
      spent: Number(p.spent) || 0,
      inv: { ...(p.inv || {}) },
      equip: { ...(p.equip || { frame: '', title: '' }) },
      log: (p.log || []).slice(0, 12),
      at: Number(p.at) || 0,
    };
  }

  function raw() { return players; }

  return { apply, refresh, snapshot, get, raw };
}
