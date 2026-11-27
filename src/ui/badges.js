// 徽章小图标：房间选手行 / 排行榜 / 比赛内名牌 / 小店穿搭预览共用同一份实现。
//
// 服务端只下发「装备了哪几枚」+ 名称/颜色/图，画由客户端负责：
//   { key, name, color, glyph, img, imgSm }
// - img  ：商店大图（1536²，1~2MB），只给商品卡用；
// - imgSm：96² 的小图（约 10KB），名次栏/名单里一律用它，否则三名玩家各戴 3 枚就是 6MB 贴图。
// 老徽章没有 PNG 时退回「色块 + 一个字」的内联样式，不会出现空框。
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** 服务端已经限制 3 枚，这里再兜一层：任何来源都最多画 3 个 */
export const MAX_BADGES = 3;

/**
 * 返回一排徽章的 HTML（外面包一层 .badge-row，间距/不换行由它保证）。
 * cls 用来适配不同场景的尺寸：名单 .p-badge、比赛内名牌 .mp-badge。
 */
export function badgeChips(badges, { cls = 'p-badge', max = MAX_BADGES } = {}) {
  const list = (Array.isArray(badges) ? badges : []).filter(Boolean).slice(0, max);
  if (!list.length) return '';
  const chips = list.map((b) => {
    const name = b.name || '徽章';
    const src = b.imgSm || b.img || '';
    return src
      ? `<img class="${cls}" src="${esc(src)}" alt="" title="${esc(name)}" aria-label="${esc(name)}">`
      : `<i class="${cls}" style="--c:${esc(b.color || '#FFD166')}" title="${esc(name)}" aria-label="${esc(name)}">${esc(b.glyph || '★')}</i>`;
  }).join('');
  return `<span class="badge-row">${chips}</span>`;
}
