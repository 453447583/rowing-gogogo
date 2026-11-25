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
