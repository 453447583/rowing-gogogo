// 积分商店配置：服务端发奖 / 扣款、客户端渲染都读这一份，避免两边价格对不上。
// 物品只做外观与"非排位娱乐券"，不卖竞速数值；随机券在排位模式里被服务器直接拦截。
// 头像框 / 称号的 PNG 来自「糖果奇幻版」素材包（public/shop-assets/）。key 是历史 ID，不动；
// 只换展示名、描述与图片，价格保持原样，老账号 inv / equip 不用迁移。

export const SHOP_ITEMS = [
  { key: 'frame_bronze', name: '珊瑚浪花框', type: 'frame', cost: 500, color: '#e48b5c', img: '/shop-assets/frame_coral.png', desc: '贝壳与珊瑚，焦糖水纹切角' },
  { key: 'frame_silver', name: '潮汐珍珠框', type: 'frame', cost: 1500, color: '#7fc9e8', img: '/shop-assets/frame_tide.png', desc: '冰蓝浪花与珍珠，清爽一圈' },
  { key: 'frame_gold', name: '鎏金冲线框', type: 'frame', cost: 4000, color: '#f5b93d', img: '/shop-assets/frame_gold_wing.png', desc: '金翼加皇冠，排行榜上最显眼' },
  { key: 'frame_cyber', name: '赛博霓虹框', type: 'frame', cost: 8000, color: '#4fd8e8', img: '/shop-assets/frame_cyber.png', desc: '青蓝科技环，赛场身份感' },
  { key: 'frame_season', name: '赛季限定框', type: 'frame', cost: 12000, color: '#b98bff', img: '/shop-assets/frame_season.png', desc: '紫粉缎带与星星，赛季纪念' },
  { key: 'title_rough', name: '破浪新手', type: 'title', color: '#2fa98b', img: '/shop-assets/title_fantasy_破浪新手.png', cost: 800, desc: '入门称号，薄荷绿金属字牌' },
  { key: 'title_breaker', name: '破局者', type: 'title', color: '#e09024', img: '/shop-assets/title_fantasy_破局者.png', cost: 1200, desc: '残局翻盘专用称号' },
  { key: 'title_tide', name: '潮汐领航', type: 'title', color: '#3a86d8', img: '/shop-assets/title_fantasy_潮汐领航.png', cost: 2500, desc: '带队赢下组队赛的证明' },
  { key: 'title_ace', name: '浪尖高手', type: 'title', color: '#d98a2b', img: '/shop-assets/title_fantasy_浪尖高手.png', cost: 3000, desc: '通关海克斯 4 层的证明' },
  { key: 'title_star', name: '赛季之星', type: 'title', color: '#8d95ae', img: '/shop-assets/title_fantasy_赛季之星.png', cost: 5000, desc: '赛季高光玩家限定称号' },
  { key: 'title_legend', name: '激流传说', type: 'title', color: '#8b5ce6', img: '/shop-assets/title_fantasy_激流传说.png', cost: 7000, desc: '长期使用积分兑换的称号' },
  { key: 'title_master', name: '巅峰·大师', type: 'title', color: '#9b6be8', img: '/shop-assets/title_fantasy_巅峰_大师.png', cost: 9000, desc: '巅峰段位认证，紫金字牌' },
  { key: 'title_strongest', name: '巅峰·最强', type: 'title', color: '#e0a12b', img: '/shop-assets/title_fantasy_巅峰_最强.png', cost: 11000, desc: '巅峰段位进阶，金字荣耀' },
  { key: 'title_legendary', name: '巅峰·传奇', type: 'title', color: '#c8443a', img: '/shop-assets/title_fantasy_巅峰_传奇.png', cost: 15000, desc: '巅峰最高荣誉，红金字牌' },
  { key: 'hex_ticket', name: '海克斯幸运券', type: 'ticket', cost: 600, nonRankedOnly: true, desc: '仅联机道具赛（非排位）：开局随机获得一件道具' },
  { key: 'hex_support', name: '海克斯支援券', type: 'ticket', cost: 600, modes: ['boss'], desc: '联机怪物 / 海克斯房：开局随机支援一件道具，每局一次' },
  // ---- 名牌光效（B 套电子环光 PNG + 原有 CSS 类，随 roster / 榜单下发）----
  { key: 'fx_warm', name: '暖光呼吸', type: 'fx', cost: 600, color: '#ffb46b', img: '/shop-assets/haloB_gold.png', desc: '暖橙电子环，名字压在光心里' },
  { key: 'fx_ice', name: '冰蓝描边', type: 'fx', cost: 1200, color: '#7fd8ff', img: '/shop-assets/haloB_blue.png', desc: '冰蓝电子环 + 轻辉光' },
  { key: 'fx_jade', name: '翠绿流光', type: 'fx', cost: 2000, color: '#5fe0a8', img: '/shop-assets/haloB_green.png', desc: '翠绿电子环，扫光流转' },
  { key: 'fx_volt', name: '紫电闪烁', type: 'fx', cost: 3200, color: '#b98bff', img: '/shop-assets/haloB_purple.png', desc: '紫色电子环，闪烁不停' },
  { key: 'fx_aurora', name: '彩霞粒子', type: 'fx', cost: 4800, color: '#ff8fc7', img: '/shop-assets/haloB_pink.png', desc: '粉霞电子环 + 渐变光点' },
  { key: 'fx_cyan', name: '潮青光', type: 'fx', cost: 4000, color: '#46e0d8', img: '/shop-assets/haloB_cyan.png', desc: '潮青电子环，冷色最清爽' },
  { key: 'fx_prism', name: '七彩循环', type: 'fx', cost: 6000, color: '#ffd166', img: '/shop-assets/haloB_rainbow.png', desc: '青环 + 粉内环，最显眼' },
  // ---- 船体涂装（卡面是磐石号实渲的 6 色，见 tests/paint_shop_cards.mjs；
  //      游戏里是着色器染色，八艘赛艇通用，不改船模）----
  { key: 'paint_red', name: '赤焰红', type: 'paint', cost: 2000, color: '#ff5a3c', img: '/shop-assets/boat_d_red.png', desc: '正红船壳，八艘赛艇通用' },
  { key: 'paint_blue', name: '霜蓝', type: 'paint', cost: 2000, color: '#6fc8ff', img: '/shop-assets/boat_d_blue.png', desc: '霜蓝船壳，赛道上一眼认出' },
  { key: 'paint_jade', name: '翡翠', type: 'paint', cost: 2000, color: '#3fd08a', img: '/shop-assets/boat_d_green.png', desc: '翡翠绿船壳，八艘通用' },
  { key: 'paint_violet', name: '紫电', type: 'paint', cost: 2000, color: '#a86bff', img: '/shop-assets/boat_d_purple.png', desc: '紫电船壳，八艘通用' },
  { key: 'paint_gold', name: '金砂', type: 'paint', cost: 2000, color: '#f0c060', img: '/shop-assets/boat_d_gold.png', desc: '金砂船壳，八艘通用' },
  { key: 'paint_tide', name: '潮青', type: 'paint', cost: 2000, color: '#46e0d0', img: '/shop-assets/boat_d_cyan.png', desc: '潮青船壳，八艘通用' },
  // ---- 徽章（B 套冷银 PNG，名字后小标志 + 商店大图）----
  { key: 'badge_wave', name: '破浪徽章', type: 'badge', cost: 1200, color: '#6FD6C2', glyph: '浪', img: '/shop-assets/badge_s_surf.png', imgSm: '/shop-assets/badge_s_surf_sm.png', desc: '冷银浪花徽章，最多戴 3 枚' },
  { key: 'badge_abyss', name: '深渊徽章', type: 'badge', cost: 2400, color: '#8E78D9', glyph: '渊', img: '/shop-assets/badge_s_abyss.png', imgSm: '/shop-assets/badge_s_abyss_sm.png', desc: '冷银深渊纹章' },
  { key: 'badge_dragon', name: '龙王徽章', type: 'badge', cost: 5000, color: '#FF8C61', glyph: '龙', img: '/shop-assets/badge_s_dragon.png', imgSm: '/shop-assets/badge_s_dragon_sm.png', desc: '冷银龙首徽章，最显眼' },
  // ---- 喷射尾焰（8 艘赛艇原生特效加强版，只换视觉，不改速度 / 氮气时长）----
  { key: 'jet_ember', name: '熔岩喷射 · 赤焰号', type: 'nitroFx', cost: 3000, color: '#ff8a4a', img: '/shop-assets/nitro_jet_ember.jpg', desc: '赤焰号火球 + 白热火芯，三喷口加强' },
  { key: 'jet_ice', name: '冰川喷射 · 绯鲨号', type: 'nitroFx', cost: 3000, color: '#9fefff', img: '/shop-assets/nitro_jet_ice.jpg', desc: '绯鲨号水柱加长，水花三喷口铺开' },
  { key: 'jet_jade', name: '青玉喷射 · 青锋号', type: 'nitroFx', cost: 3500, color: '#9dffdd', img: '/shop-assets/nitro_jet_jade.jpg', desc: '青锋号风团加大，拖尾更密' },
  { key: 'jet_volt', name: '雷弧喷射 · 流光号', type: 'nitroFx', cost: 7000, color: '#b18cff', img: '/shop-assets/nitro_jet_volt.jpg', desc: '流光号三束雷光 + 紫电粒子加强' },
  { key: 'jet_aurora', name: '极光喷射 · 琥珀号', type: 'nitroFx', cost: 8000, color: '#9ff2e0', img: '/shop-assets/nitro_jet_aurora.jpg', desc: '琥珀号电光加亮，拖尾更长' },
  { key: 'jet_dragon', name: '龙息喷射 · 长鲸号', type: 'nitroFx', cost: 12000, color: '#ffb060', img: '/shop-assets/nitro_jet_dragon.jpg', desc: '长鲸号长焰加粗，赛季典藏' },
  { key: 'jet_frost', name: '霜刃喷射 · 磐石号', type: 'nitroFx', cost: 5000, color: '#a8d8f0', img: '/shop-assets/nitro_jet_frost.jpg', desc: '磐石号碎冰加密，双侧喷口' },
  { key: 'jet_gale', name: '疾风喷射 · 牛来号', type: 'nitroFx', cost: 6000, color: '#f2e4cc', img: '/shop-assets/nitro_jet_gale.jpg', desc: '牛来号气流团加强，更持久' },
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
