/**
 * 竞技场「随机跑」数据：词缀池 + 三选一卡池。
 *
 * 只放纯数据与抽取函数，效果全部由 ArenaMode 读取 stats 后乘算，
 * 这样联机时房主抽到什么、客机看到什么都是同一份 id，不需要同步效果实现。
 */

/** 每关进场词缀。stars = 强度档（1 轻 / 2 中 / 3 重） */
export const ARENA_MODIFIERS = [
  { id: 'thin_ice', name: '薄冰', stars: 1, desc: '擂台半径 -15%' },
  { id: 'low_gravity', name: '低重力', stars: 1, desc: '撞击冲量 ×1.6' },
  { id: 'tide_back', name: '潮汐倒灌', stars: 1, desc: '核心无人推动时回中速度 ×2' },
  { id: 'twin_core', name: '双核', stars: 3, desc: '两个核心同时在场，任一进门得分' },
  { id: 'golden_core', name: '黄金核心', stars: 2, desc: '核心推进速度 ×1.5' },
  { id: 'ammo_control', name: '弹药管制', stars: 2, desc: '不刷远程道具，只出撞击 / 护盾类' },
  { id: 'no_shield', name: '无盾', stars: 3, desc: '决斗关不能举盾' },
  { id: 'thunder', name: '闪击', stars: 2, desc: '每 30 秒全场雷击，圈心安全' },
  { id: 'fast_shrink', name: '缩圈加速', stars: 2, desc: '决斗缩圈 75 秒 → 45 秒' },
  { id: 'short_clock', name: '加时诅咒', stars: 1, desc: '每关时限 90 秒 → 60 秒' },
];

export const ARENA_MODIFIER_BY_ID = new Map(ARENA_MODIFIERS.map((m) => [m.id, m]));

/**
 * 三选一卡池（24 张）。
 * stats 用「加算」：dmg +0.2 = 炮伤 +20%，taken -0.15 = 受伤 -15%，
 * dashCd +0.3 = 冲刺冷却 -30%（字段名表示削减量，避免负数绕晕）。
 * sup 类在 1v1 里权重为 0，永远不会出现在竞技场的候选里。
 */
export const ARENA_CARDS = [
  // ---------------- 火力 ----------------
  { id: 'pierce', cat: 'pow', rarity: 'white', name: '穿甲弹头', max: 3, stats: { dmg: 0.2 }, desc: '主炮伤害 +20%' },
  { id: 'flank', cat: 'pow', rarity: 'blue', name: '侧舷猎手', max: 2, stats: { side: 0.25 }, desc: '从对手侧后方命中，伤害 +25%' },
  { id: 'crit', cat: 'pow', rarity: 'blue', name: '暴击核心', max: 2, stats: { crit: 0.15 }, desc: '15% 概率打出双倍伤害' },
  { id: 'rapid', cat: 'pow', rarity: 'white', name: '连射装置', max: 1, stats: { fireRate: 0.25, dmg: -0.1 }, desc: '射速 +25%，单发伤害 -10%' },

  // ---------------- 防御 ----------------
  { id: 'armor', cat: 'def', rarity: 'white', name: '装甲板', max: 3, stats: { taken: -0.15 }, desc: '受到伤害 -15%' },
  { id: 'dash_armor', cat: 'def', rarity: 'blue', name: '冲刺装甲', max: 2, stats: { dashInvuln: 0.15 }, desc: '冲刺无敌时间 +0.15 秒' },
  { id: 'repair', cat: 'def', rarity: 'white', name: '应急修复', max: 2, stats: { respawnCut: 1.2 }, desc: '被击沉后复活时间 -1.2 秒' },
  { id: 'poseidon', cat: 'def', rarity: 'gold', name: '海神庇佑', max: 1, stats: { revive: 1 }, desc: '每局首次被击沉时满血复活' },

  // ---------------- 机动 ----------------
  { id: 'rudder', cat: 'mob', rarity: 'white', name: '舵机强化', max: 3, stats: { turn: 0.15 }, desc: '转向速度 +15%' },
  { id: 'turbo', cat: 'mob', rarity: 'white', name: '涡轮', max: 3, stats: { speed: 0.08 }, desc: '极速 +8%' },
  { id: 'dash_cell', cat: 'mob', rarity: 'blue', name: '冲刺蓄能', max: 2, stats: { dashCd: 0.3 }, desc: '冲刺冷却 -30%' },
  { id: 'ram', cat: 'mob', rarity: 'blue', name: '冲角', max: 1, stats: { ram: 0.8 }, desc: '撞击冲量 +80%' },

  // ---------------- 道具 ----------------
  { id: 'supply', cat: 'itm', rarity: 'white', name: '开局补给', max: 2, stats: { starter: 1 }, desc: '每关开始额外获得 1 件道具' },
  { id: 'shield_start', cat: 'itm', rarity: 'blue', name: '应急护盾', max: 1, stats: { shieldStarter: 1 }, desc: '每关开始获得 1 个护盾' },
  { id: 'quartermaster', cat: 'itm', rarity: 'blue', name: '军需官', max: 1, stats: { bonusChance: 0.4 }, desc: '拾取道具箱时 40% 概率再得一件' },
  { id: 'arcane', cat: 'itm', rarity: 'blue', name: '秘术补给', max: 1, stats: { damageStarter: 1 }, desc: '每关开始获得 1 件随机伤害道具' },

  // ---------------- 协同（1v1 不出现） ----------------
  { id: 'wingman', cat: 'sup', rarity: 'blue', name: '僚机协议', max: 1, weight: 0, stats: { dmg: 0.1 }, desc: '队友伤害 +10%（1v1 不生效）' },
  { id: 'link', cat: 'sup', rarity: 'blue', name: '协同护盾', max: 1, weight: 0, stats: { taken: -0.1 }, desc: '队友同场时受伤 -10%（1v1 不生效）' },
  { id: 'rally', cat: 'sup', rarity: 'gold', name: '集火指令', max: 1, weight: 0, stats: { dmg: 0.2 }, desc: '集火同一目标时伤害 +20%（1v1 不生效）' },
  { id: 'relay', cat: 'sup', rarity: 'white', name: '接力补给', max: 1, weight: 0, stats: { starter: 1 }, desc: '队友道具共享（1v1 不生效）' },

  // ---------------- 狂野 ----------------
  { id: 'bloodrage', cat: 'wild', rarity: 'gold', name: '血怒', max: 1, stats: { dmg: 0.4, taken: 0.25 }, desc: '炮伤 +40%，但受到伤害 +25%' },
  { id: 'glass', cat: 'wild', rarity: 'gold', name: '玻璃大炮', max: 1, stats: { dmg: 0.5, taken: 0.2 }, desc: '炮伤 +50%，但受到伤害 +20%' },
  { id: 'gambler', cat: 'wild', rarity: 'gold', name: '赌徒', max: 1, stats: { gambler: true }, desc: '每关开始随机获得 +15% 炮伤或 +8% 极速' },
  { id: 'rewind', cat: 'wild', rarity: 'gold', name: '时间回溯', max: 1, stats: { rewind: 1 }, desc: '每局首次被击沉时满血回到出生点' },
];

export const ARENA_CARD_BY_ID = new Map(ARENA_CARDS.map((c) => [c.id, c]));

export const ARENA_CARD_CATS = {
  pow: '火力',
  def: '防御',
  mob: '机动',
  itm: '道具',
  sup: '协同',
  wild: '狂野',
};

/** mulberry32：同一个种子两端能得到同一串随机数 */
export function makeRng(seed) {
  let a = 0;
  const s = String(seed);
  for (let i = 0; i < s.length; i++) a = (a * 31 + s.charCodeAt(i)) >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * 抽本关词缀：第 1/2 关 1 条，第 3 关起 2 条。
 * 同一条词缀整场只出现一次；两条时避免「双 3 星」直接打死一关。
 */
export function pickModifierIds(round, used = new Set(), rng = Math.random) {
  const count = round >= 3 ? 2 : 1;
  const pool = ARENA_MODIFIERS.filter((m) => !used.has(m.id));
  const picked = [];
  while (picked.length < count && pool.length) {
    let candidates = pool;
    if (picked.length === 1 && picked[0].stars >= 3) {
      const safe = pool.filter((m) => m.stars < 3);
      if (safe.length) candidates = safe;
    }
    const one = candidates[Math.floor(rng() * candidates.length)];
    picked.push(one);
    pool.splice(pool.indexOf(one), 1);
  }
  return picked.map((m) => m.id);
}

/** 三选一候选：排除已满层与 1v1 不生效的协同卡 */
export function pickCardOffers(ownedCounts = {}, rng = Math.random, n = 3) {
  const avail = ARENA_CARDS.filter((c) => {
    if (c.weight === 0 || c.max <= 0) return false;
    return (ownedCounts[c.id] || 0) < c.max;
  });
  const out = shuffled(avail, rng).slice(0, n).map((c) => c.id);
  if (out.length < n) {
    // 候选被买空时退回到全池（仍排除协同），保证永远能凑够三张
    const rest = shuffled(ARENA_CARDS.filter((c) => c.weight !== 0 && !out.includes(c.id)), rng);
    for (const c of rest) {
      if (out.length >= n) break;
      out.push(c.id);
    }
  }
  return out;
}
