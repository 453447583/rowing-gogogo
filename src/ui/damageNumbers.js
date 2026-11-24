/**
 * 伤害飘字 · 霓虹电竞 C 方案（只换字形，显示方式沿用旧版）
 *
 * 素材：public/ui/dmg/（逐字透明 PNG，normal / crit 各 10 张，含 @2x）
 * 规格：docs/伤害数字_霓虹C_字表_提示词.md
 *
 * 口径（2026-11-24 晚按用户反馈收敛）：
 *   1. **尺寸/位置/动画沿用旧版文字飘字**：字高对齐旧的 22px / 30px 字号，
 *      从命中点中心弹出、上飘、淡出。不要按屏高百分比放大（上一版 6.2% 屏高被否）。
 *   2. **倾斜方向要「向右倒」**。素材本身是向左倒的（实测字干 -10.9°，字表 md 写的
 *      是向右 9°，生成时方向反了），这里逐字补一次 CSS 斜切把净倾角扳到向右约 9°，
 *      见 TILT_DEG。
 *   3. 描边/硬阴影已烘进字形，**不要**再给字加 text-shadow / 发光。
 *   4. 相邻字底边对齐、横向重叠 2%（x += w * 0.98），这是字表给的拼字规则。
 *
 * 为什么用 DOM 而不是 Sprite：投影一次写 left/top 的绝对定位层最省，
 * 低配本零 3D 开销；素材本身透明、不进城后处理，颗粒/泛光吃不掉它。
 */

const ASSET_BASE = '/ui/dmg';

// metrics.json 内联（避免运行时 fetch 造成首跳缺字）。
// 数值 = 每张 PNG 的画布宽高；h 的差异来自 0/3/6/8/9 的过冲，底边仍是同一条基线。
const METRICS_1X = {
  normal: [[81, 111], [84, 107], [85, 111], [81, 111], [85, 111],
    [81, 107], [83, 111], [73, 107], [83, 111], [80, 111]],
  crit: [[108, 150], [113, 148], [115, 150], [109, 150], [114, 148],
    [108, 148], [111, 150], [98, 148], [111, 150], [107, 150]],
  burst: [512, 512],
};
const METRICS_2X = {
  normal: [[161, 222], [169, 216], [171, 220], [163, 222], [169, 216],
    [161, 218], [165, 222], [147, 216], [165, 222], [159, 222]],
  crit: [[217, 298], [227, 294], [229, 298], [219, 298], [227, 294],
    [217, 294], [223, 298], [197, 294], [223, 298], [213, 298]],
  burst: [1024, 1024],
};

// 墨迹占画布高：实测 normal_0 = 107/111、crit_0 = 146/150（含描边与硬阴影）
const INK_RATIO = 0.963;

// 旧版文字是 font:800 22px / 30px：数字可见高 ≈ 0.72 × 字号，再加外面那圈 2px 黑描边，
// 肉眼占位大约 20px / 26px。素材自带描边，所以直接按这个「视觉占位」给墨迹高。
// 要调大小只动这两个数（上一版按 6.2% 屏高 = 45px 被否，别再放大回去）。
const INK_PX = { normal: 20, crit: 27 };

// 素材实测向左 10.9°，目标向右 9°：补 20° 斜切。
// CSS skewX(-θ) + transform-origin:50% 100% = 顶边右移，即标准右倾（合成斜体）。
const TILT_DEG = 20;

const MAX_TOTAL = 14;        // 全场同时在场的上限（连射时不把 DOM 撑爆）
const FADE_OUT_MS = 120;     // 被顶掉的那一个快速淡出

export class DamageNumbers {
  constructor() {
    this.layer = null;
    this.stack = [];
    this.preloaded = false;
  }

  /** 预热：把 22 张字 + 爆框塞进图片缓存，避免第一次命中闪一下空白 */
  preload() {
    if (this.preloaded || typeof document === 'undefined') return;
    this.preloaded = true;
    const names = [];
    for (const suffix of ['', '@2x']) {
      for (const style of ['normal', 'crit']) {
        for (let i = 0; i < 10; i++) names.push(`${style}_${i}${suffix}.png`);
      }
    }
    names.push('crit_burst.png', 'crit_burst@2x.png');
    for (const n of names) {
      const img = new Image();
      img.src = `${ASSET_BASE}/${n}`;
    }
  }

  #ensureLayer() {
    if (this.layer && this.layer.isConnected) return this.layer;
    const el = document.createElement('div');
    el.id = 'dmg-numbers';
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:40;';
    document.body.appendChild(el);
    this.layer = el;
    return el;
  }

  /**
   * 跳一个字。
   * @param {number} value 伤害值（四舍五入后逐字拼）
   * @param {boolean} crit 是否暴击
   * @param {number} x 屏幕像素 x（命中点，数字以它为中心）
   * @param {number} y 屏幕像素 y
   * @param {number} scale 尺寸倍率（小怪传 0.75，比 BOSS 小一号）
   */
  spawn({ value, crit = false, x, y, scale = 1 }) {
    if (typeof document === 'undefined' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // 四舍五入后是 0 的（0.4 这类零头）就不跳，否则满屏"0"
    if (!Number.isFinite(value) || Math.round(value) < 1) return;
    this.preload();
    const layer = this.#ensureLayer();

    const style = crit ? 'crit' : 'normal';
    const hiDpr = (window.devicePixelRatio || 1) >= 1.5;
    const metrics = hiDpr ? METRICS_2X : METRICS_1X;
    const suffix = hiDpr ? '@2x' : '';
    const table = metrics[style];

    // ---- 尺寸：固定像素（对齐旧版字号），不跟屏高走 ----
    const pngH = (INK_PX[style] / INK_RATIO) * scale;
    const k = pngH / table[0][1];   // 所有字共用一个字号系数，画布高差异保留

    const digits = String(Math.max(0, Math.round(value))).split('');
    const items = [];
    let maxH = 0;
    for (const ch of digits) {
      const d = ch.charCodeAt(0) - 48;
      const m = table[d] || table[0];
      items.push({ d, w: m[0] * k, h: m[1] * k });
      if (m[1] * k > maxH) maxH = m[1] * k;
    }
    let total = 0;
    for (const it of items) total += it.w * 0.98;

    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;left:0;top:0;width:${total}px;height:${maxH}px;`
      + 'transform-origin:50% 50%;will-change:transform,opacity;';

    // ---- 逐字拼 ----
    // 每个字单独斜切、原点压在底边：字距仍按基线排（这是合成斜体的标准做法）。
    // 整串一起斜切会让右边那个字顶出色块，也会把字距一起带歪。
    let cx = 0;
    for (const it of items) {
      const img = document.createElement('img');
      img.src = `${ASSET_BASE}/${style}_${it.d}${suffix}.png`;
      img.alt = '';
      img.draggable = false;
      img.style.cssText = `position:absolute;left:${cx}px;bottom:0;`
        + `width:${it.w}px;height:${it.h}px;pointer-events:none;`
        + `transform:skewX(${-TILT_DEG}deg);transform-origin:50% 100%;`;
      wrap.appendChild(img);
      cx += it.w * 0.98;
    }

    // ---- 爆裂框（仅暴击，独立一层，先消失字留下）----
    if (crit) {
      const [bw, bh] = metrics.burst;
      const burst = document.createElement('img');
      burst.src = `${ASSET_BASE}/crit_burst${suffix}.png`;
      burst.alt = '';
      burst.draggable = false;
      // 单字暴击时 total×1.12 会比字还小，给个字高的下限兜住
      const size = Math.max(total * 1.12, pngH * 1.55);
      // 垂直居中到数字本身（照 md 的 bottom:-size*0.10 摆，四位数时方框会飘到头顶）
      burst.style.cssText = `position:absolute;left:${(total - size) / 2}px;`
        + `bottom:${maxH * 0.5 - size / 2}px;width:${size}px;height:${size * (bh / bw)}px;`
        + 'pointer-events:none;z-index:-1;';
      wrap.appendChild(burst);
      // 爆框：纯色块缩放淡出，不发光不模糊（和 HUD 的干净铁律一致）。
      // 字表给的是 0.35s 内 1→0，但按 md 那条 cubic-bezier 实测 150ms 就淡到 0.1，
      // 屏幕上等于没出现过 —— 改成前 35% 保持满不透明，后半段再收。
      burst.animate([
        { transform: 'scale(0.8)', opacity: 1, offset: 0, easing: 'ease-out' },
        { transform: 'scale(1.02)', opacity: 1, offset: 0.35 },
        { transform: 'scale(1.1)', opacity: 0, offset: 1 },
      ], { duration: 350, easing: 'linear', fill: 'forwards' });
    }

    // ---- 位置/动画：沿用旧版（命中点居中 → 上飘 → 淡出，720ms）----
    const X = x - total * 0.5;
    const Y = y - maxH * 0.5;
    const rise = maxH * 1.6;      // 旧版净升约 1.2 个字高
    wrap.style.transform = `translate3d(${X}px,${Y}px,0)`;
    layer.appendChild(wrap);
    const anim = wrap.animate([
      { transform: `translate3d(${X}px,${Y}px,0) scale(0.7)`, opacity: 1, offset: 0 },
      { transform: `translate3d(${X}px,${Y - rise}px,0) scale(1.15)`, opacity: 0, offset: 1 },
    ], { duration: 720, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });

    // ---- 容量控制：全场满 14 个时，最老的快速淡出 ----
    const item = { el: wrap };
    this.stack.push(item);
    while (this.stack.length > MAX_TOTAL) this.#kill(this.stack[0].el);

    anim.onfinish = () => {
      wrap.remove();
      const i = this.stack.indexOf(item);
      if (i >= 0) this.stack.splice(i, 1);
    };
  }

  #kill(el) {
    const i = this.stack.findIndex((s) => s.el === el);
    if (i >= 0) this.stack.splice(i, 1);
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_OUT_MS, fill: 'forwards' });
    setTimeout(() => el.remove(), FADE_OUT_MS + 20);
  }

  /** 退出模式时清空（DOM 节点别留在 body 上） */
  destroy() {
    for (const s of this.stack) s.el.remove();
    this.stack.length = 0;
    this.layer?.remove();
    this.layer = null;
    this.preloaded = false;
  }
}
