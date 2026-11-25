// 积分商店配置：服务端发奖 / 扣款、客户端渲染都读这一份，避免两边价格对不上。
// 物品只做外观与"非排位娱乐券"，不卖竞速数值；随机券在排位模式里被服务器直接拦截。

export const SHOP_ITEMS = [
  { key: 'frame_bronze', name: '青铜浪花框', type: 'frame', cost: 500, color: '#c98b52', desc: '入门头像框，铜色水纹' },
  { key: 'frame_silver', name: '白银激流框', type: 'frame', cost: 1500, color: '#cbd5df', desc: '银色切角，配冰蓝高光' },
  { key: 'frame_gold', name: '黄金冲线框', type: 'frame', cost: 4000, color: '#ffcf4d', desc: '金框，排行榜上很显眼' },
  { key: 'frame_cyber', name: '赛博霓虹框', type: 'frame', cost: 8000, color: '#59e8ff', desc: '青紫霓虹，赛场身份感' },
  { key: 'frame_season', name: '赛季限定框', type: 'frame', cost: 12000, color: '#b98bff', desc: '赛季限定头像框，赛季结束后不再上架' },
  { key: 'title_rough', name: '破浪新手', type: 'title', cost: 800, desc: '挂在名字前的小称号' },
  { key: 'title_breaker', name: '破局者', type: 'title', cost: 1200, desc: '残局翻盘专用称号' },
  { key: 'title_tide', name: '潮汐领航', type: 'title', cost: 2500, desc: '带队赢下组队赛的证明' },
  { key: 'title_ace', name: '浪尖高手', type: 'title', cost: 3000, desc: '通关海克斯 4 层的证明' },
  { key: 'title_star', name: '赛季之星', type: 'title', cost: 5000, desc: '赛季高光玩家限定称号' },
  { key: 'title_legend', name: '激流传说', type: 'title', cost: 7000, desc: '长期使用积分兑换的称号' },
  { key: 'hex_ticket', name: '海克斯幸运券', type: 'ticket', cost: 600, nonRankedOnly: true, desc: '仅联机道具赛（非排位）：开局随机获得一件道具' },
  { key: 'hex_support', name: '海克斯支援券', type: 'ticket', cost: 600, modes: ['boss'], desc: '联机怪物 / 海克斯房：开局随机支援一件道具，每局一次' },
  // ---- 名牌光效（纯 CSS，随 roster / 榜单下发，房间里所有人都看得见）----
  { key: 'fx_warm', name: '暖光呼吸', type: 'fx', cost: 600, color: '#ffb46b', desc: '名字外圈暖橙呼吸光' },
  { key: 'fx_ice', name: '冰蓝描边', type: 'fx', cost: 1200, color: '#7fd8ff', desc: '冰蓝描边 + 轻微辉光' },
  { key: 'fx_jade', name: '翠绿流光', type: 'fx', cost: 2000, color: '#5fe0a8', desc: '翠绿扫光，从名字上掠过' },
  { key: 'fx_volt', name: '紫电闪烁', type: 'fx', cost: 3200, color: '#b98bff', desc: '紫电闪一下、停一下' },
  { key: 'fx_aurora', name: '彩霞粒子', type: 'fx', cost: 4800, color: '#ff8fc7', desc: '彩霞渐变 + 星点粒子' },
  { key: 'fx_prism', name: '七彩循环', type: 'fx', cost: 6000, color: '#ffd166', desc: '六色循环流转，最显眼' },
  // ---- 船体涂装（只染船壳主网格，所有人可见）----
  { key: 'paint_red', name: '赤焰红', type: 'paint', cost: 2000, color: '#ff5a3c', desc: '船壳染成赤焰红，贴图细节保留' },
  { key: 'paint_blue', name: '霜蓝', type: 'paint', cost: 2000, color: '#6fc8ff', desc: '霜蓝船壳，赛道上一眼认出' },
  { key: 'paint_jade', name: '翡翠', type: 'paint', cost: 2000, color: '#3fd08a', desc: '翡翠绿船壳' },
  { key: 'paint_violet', name: '紫电', type: 'paint', cost: 2000, color: '#a86bff', desc: '紫电船壳' },
  { key: 'paint_gold', name: '金砂', type: 'paint', cost: 2000, color: '#f0c060', desc: '金砂色船壳' },
  { key: 'paint_tide', name: '潮青', type: 'paint', cost: 2000, color: '#46e0d0', desc: '潮青色船壳' },
  // ---- 徽章（最多同时佩戴 3 枚，挂在名字后面）----
  { key: 'badge_wave', name: '破浪徽章', type: 'badge', cost: 1200, color: '#6FD6C2', glyph: '浪', desc: '名字后面的小徽章，最多戴 3 枚' },
  { key: 'badge_abyss', name: '深渊徽章', type: 'badge', cost: 2400, color: '#8E78D9', glyph: '渊', desc: '深渊配色的小徽章' },
  { key: 'badge_dragon', name: '龙王徽章', type: 'badge', cost: 5000, color: '#FF8C61', glyph: '龙', desc: '最显眼的龙王徽章' },
];

export const SHOP_MAP = Object.fromEntries(SHOP_ITEMS.map((it) => [it.key, it]));

/** 排位口径：客户端只用来提示，服务器只按 room 字段独立判定，不信任这里。 */
export function isRankedMode({ solo = false, mode = '', format = 'solo', challenge = false } = {}) {
  if (challenge) return false;
  if (solo) return false;
  return mode === 'race' && format === 'solo'
    || mode === 'boss'
    || mode === 'skytower';
}

/**
 * 券的生效口径（客户端提示 / 服务器独立判定，服务器不信任这里）：
 * - hex_ticket  ：联机道具赛（非排位）；
 * - hex_support ：联机怪物 / 海克斯房（PvE，开局支援），单人没有服务器结算所以不可用。
 */
export function ticketAllowed(key, { solo = false, mode = '', format = 'solo' } = {}) {
  const it = SHOP_MAP[key];
  if (!it || it.type !== 'ticket') return false;
  if (solo) return false;
  if (key === 'hex_support') return mode === 'boss';
  if (key === 'hex_ticket') return mode === 'item';
  return false;
}
