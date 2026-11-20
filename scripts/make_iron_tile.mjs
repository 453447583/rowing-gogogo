// 把 AI 生成的锻铁贴图做成「可无缝平铺」的 UI 瓦片。
//   node scripts/make_iron_tile.mjs <源图> [输出]
//
// 为什么必须处理：照片类纹理直接 background-repeat 会在每条接缝上出现明显网格线。
// 做法是业界通用的 "offset + 羽化混合"：
//   ① 把图按半宽半高滚卷（roll），滚完的四条边来自原图中线，跨瓦片边界天然连续；
//   ② 滚卷后接缝跑到了画面正中央 —— 用一张中心权重 1、边缘权重 0 的柔性遮罩，
//      把原图（中心连续）在中间盖回去，过渡带宽 200px，噪声纹理上看不出痕迹。
// 另外源图右下角有生成工具的水印，所以只取左上 1280² 再缩放。
import sharp from 'sharp';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'public/ui/boss-iron.jpg';
if (!SRC) {
  console.error('usage: node scripts/make_iron_tile.mjs <src.jpg> [out.jpg]');
  process.exit(1);
}

const S = 768;            // 输出边长（UI 上按 ~380px 平铺，2 倍超采样足够）
const CROP = 1280;        // 源图取左上 1280²：避开右下角水印
const FADE = 200;         // 接缝羽化带宽

// 色调：原图是"锈铁"（橙褐），这里往"冷灰金属石板"拉。
//   SAT  保留多少原始彩度（1 = 原图橙褐，0 = 纯灰）
//   LIFT 中间调提亮倍数（>1 更银亮）
//   COOL 冷色偏移（蓝↑红↓，冷灰金属那种微微发青）
//   FLAT 压平低频斑驳的力度（0~1，越大表面越平）
//   MED  中位亮度锁定值：颜色映射后整体亮度会漂，这里做一次整体偏移把它钉死，
//        CSS 那层压暗罩就是按这个基准标定的（#4A4A4D → #333336 的区间）。
const SAT = 0.10;
const LIFT = 1.26;
const COOL = 0.030;
const FLAT_LO = 0.90;      // 压掉大块明暗（"岩石斑驳"主要活在这层）
const FINE = 0.55;         // 极细颗粒（喷砂 / 磨砂金属的手感）放大倍数
const MED = 77;            // ≈ #4D4D4F，正好落在用户要的面板底色区间中段

const base = await sharp(SRC)
  .extract({ left: 0, top: 0, width: CROP, height: CROP })
  .resize(S, S, { fit: 'fill' })
  .removeAlpha()
  .raw()
  .toBuffer();

// ① 先压平大范围明暗：原图整体从左上到右下有几十级的亮度漂移，直接滚卷平铺的话，
//    「原图区」和「滚卷区」的平均亮度不同，羽化带会显出一个淡淡的矩形色块。
//    做法：减去低通（sigma 60）的 72%，再补回全局均值 —— 只压掉大块渐变，
//    中高频的斑驳/锈点/划痕原样保留。
const blur = await sharp(base, { raw: { width: S, height: S, channels: 3 } })
  .blur(60).raw().toBuffer();
let mr = 0, mg = 0, mb = 0;
for (let i = 0; i < base.length; i += 3) { mr += base[i]; mg += base[i + 1]; mb += base[i + 2]; }
const n = base.length / 3;
const mean = [mr / n, mg / n, mb / n];
const FLAT = FLAT_LO;
const flat = Buffer.alloc(base.length);
for (let i = 0; i < base.length; i += 3) {
  for (let c = 0; c < 3; c++) {
    const lo = blur[i + c] - mean[c];
    flat[i + c] = Math.max(0, Math.min(255, Math.round(base[i + c] - lo * FLAT)));
  }
}

// ② 钢色分级：按亮度去色 → 提亮中间调 → 轻微冷偏。
//    只动颜色，纹理结构（锻打纹 / 划痕 / 斑点）原样保留。
for (let i = 0; i < flat.length; i += 3) {
  const L = 0.299 * flat[i] + 0.587 * flat[i + 1] + 0.114 * flat[i + 2];
  for (let c = 0; c < 3; c++) {
    let v = L + (flat[i + c] - L) * SAT;
    v = 255 * Math.pow(Math.max(0, v) / 255, 1 / LIFT);
    if (c === 0) v *= 1 - COOL;
    if (c === 2) v *= 1 + COOL;
    flat[i + c] = Math.max(0, Math.min(255, Math.round(v)));
  }
}

// ②' 颗粒取向：原图是"粗粝锻铁"，大块斑驳在 UI 尺寸下读起来像岩石。
//     ① 已经压掉了大块明暗，这里再把**高频颗粒**按亮度加回来 —— 磨砂金属的
//     手感来自"整体平整 + 细密砂点"，而不是靠大凹凸。加的是亮度差，不引入彩噪。
const fine = await sharp(base, { raw: { width: S, height: S, channels: 3 } })
  .blur(1.8).raw().toBuffer();
for (let i = 0; i < flat.length; i += 3) {
  const hi = (0.299 * (base[i] - fine[i])
    + 0.587 * (base[i + 1] - fine[i + 1])
    + 0.114 * (base[i + 2] - fine[i + 2])) * FINE;
  for (let c = 0; c < 3; c++) {
    flat[i + c] = Math.max(0, Math.min(255, Math.round(flat[i + c] + hi)));
  }
}

// ③ 锁定中位亮度：② 的幂曲线会让整体亮度浮到不确定的位置，而 CSS 的压暗罩
//    是按"贴图多亮"标定的（顶部 #4A4A4D、底部 #333336 是算出来的）。这里做一次
//    整体偏移，把中位精确钉到 MED —— 只平移不改对比度，纹理动态范围原样保留。
const lum = (i) => 0.299 * flat[i] + 0.587 * flat[i + 1] + 0.114 * flat[i + 2];
const lums = [];
for (let i = 0; i < flat.length; i += 3) lums.push(lum(i));
lums.sort((a, b) => a - b);
const shift = MED - lums[lums.length >> 1];
for (let i = 0; i < flat.length; i += 3) {
  for (let c = 0; c < 3; c++) {
    flat[i + c] = Math.max(0, Math.min(255, Math.round(flat[i + c] + shift)));
  }
}

// ④ 软限幅：原图是"锈铁麻点"，亮点/暗坑的对比度按 UI 尺寸看太重，
//    铺到面板上就是一层"坑坑洼洼"。用户要的是"细腻哑光、颗粒细小平整"，
//    所以把偏离中位的幅度软压到 RANGE 以内（tanh，不是硬截断 —— 硬截断会出台阶）。
//    RANGE=26 → 贴图落在 #33~#67，配合压暗罩正好得到 #333336~#4A4A4D。
const RANGE = 26;
for (let i = 0; i < flat.length; i += 3) {
  for (let c = 0; c < 3; c++) {
    const d = flat[i + c] - MED;
    const v = MED + RANGE * Math.tanh(d / RANGE);
    flat[i + c] = Math.max(0, Math.min(255, Math.round(v)));
  }
}

const H = S >> 1;
const rolled = Buffer.alloc(flat.length);
for (let y = 0; y < S; y++) {
  const sy = (y + H) % S;
  for (let x = 0; x < S; x++) {
    const sx = (x + H) % S;
    const di = (y * S + x) * 3;
    const si = (sy * S + sx) * 3;
    rolled[di] = flat[si];
    rolled[di + 1] = flat[si + 1];
    rolled[di + 2] = flat[si + 2];
  }
}

const out = Buffer.alloc(flat.length);
for (let y = 0; y < S; y++) {
  const dy = Math.min(y, S - 1 - y);
  for (let x = 0; x < S; x++) {
    const d = Math.min(x, S - 1 - x, dy);
    const t = Math.min(1, d / FADE);
    const w = t * t * (3 - 2 * t);      // smoothstep：中心 1（用原图），边缘 0（用滚卷图）
    const i = (y * S + x) * 3;
    out[i] = rolled[i] * (1 - w) + flat[i] * w;
    out[i + 1] = rolled[i + 1] * (1 - w) + flat[i + 1] * w;
    out[i + 2] = rolled[i + 2] * (1 - w) + flat[i + 2] * w;
  }
}

const abs = path.resolve(OUT);
await sharp(out, { raw: { width: S, height: S, channels: 3 } })
  .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
  .toFile(abs);

// 平铺自检：左右两列、上下两行的平均色差，接缝不该比图内正常邻列差更多
const colGap = (a, b) => {
  let s = 0;
  for (let y = 0; y < S; y++) {
    for (let c = 0; c < 3; c++) s += Math.abs(out[(y * S + a) * 3 + c] - out[(y * S + b) * 3 + c]);
  }
  return s / (S * 3);
};
const rowGap = (a, b) => {
  let s = 0;
  for (let x = 0; x < S; x++) {
    for (let c = 0; c < 3; c++) s += Math.abs(out[(a * S + x) * 3 + c] - out[(b * S + x) * 3 + c]);
  }
  return s / (S * 3);
};
// 取中位色给 CSS 兜底用
const px = [];
for (let i = 0; i < out.length; i += 3) px.push([out[i], out[i + 1], out[i + 2]]);
const med = (k) => px.map((p) => p[k]).sort((a, b) => a - b)[px.length >> 1];
const hex = (v) => v.toString(16).padStart(2, '0');
console.log(JSON.stringify({
  out: abs,
  size: S,
  seamColGap: +colGap(S - 1, 0).toFixed(2),
  innerColGap: +colGap(S >> 1, (S >> 1) + 1).toFixed(2),
  seamRowGap: +rowGap(S - 1, 0).toFixed(2),
  innerRowGap: +rowGap(S >> 1, (S >> 1) + 1).toFixed(2),
  median: `#${hex(med(0))}${hex(med(1))}${hex(med(2))}`,
}, null, 2));
