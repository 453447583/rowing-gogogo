// 临时：生成手机可看的单文件预览页 + 逐张图片（dist/nitro/）
// 图片外链 + loading=lazy：公网隧道很慢，页面框架能先出来，图片滚到哪加载哪。
// 注意：每次 build 都会清空 dist，build 之后要重新跑一次本脚本。
import fs from 'node:fs';

const list = [
  ['longship', '长鲸号', '双喷口 · 笔直长焰（标杆）'],
  ['rower', '赤焰号', '单喷口 · 橙红火柱（新，同长鲸号风格）'],
  ['falcon', '青锋号', '双喷口 · 薄荷火柱（新，同长鲸号风格）'],
  ['skiff', '绯鲨号', '双喷口 · 青蓝火柱（新，去掉四散粒子）'],
  ['dolphin', '流光号', '双喷口 · 淡紫火柱（新，去掉四散粒子）'],
  ['cow', '牛来号', '单喷口 · 驼色浓雾（新增，最笨重）'],
  ['titan', '磐石号', '双喷口 · 厚重白雾'],
  ['vintage', '琥珀号', '单喷口 · 冰蓝电弧'],
];

fs.mkdirSync('dist/nitro', { recursive: true });
let cards = '';
for (const [id, name, tag] of list) {
  fs.copyFileSync(`shots/nitro/web/${id}.jpg`, `dist/nitro/${id}.jpg`);
  cards += `<section><h2>${name}<span>${tag}</span></h2><img loading="lazy" width="560" height="350" alt="${name}" src="./nitro/${id}.jpg"></section>`;
}
fs.copyFileSync('shots/nitro/web/arena-ringout.jpg', 'dist/nitro/arena-ringout.jpg');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>激流勇进 · 尾焰与竞技场修复</title><style>
*{box-sizing:border-box}
body{margin:0;background:#070d14;color:#e3edf7;font:15px/1.65 system-ui,-apple-system,"PingFang SC",sans-serif}
header{padding:20px 16px 12px;background:linear-gradient(180deg,#0d1a26,#070d14)}
header h1{margin:0 0 6px;font-size:19px;letter-spacing:.02em}
header p{margin:0 0 4px;color:#7d93a9;font-size:13px}
main{padding:0 12px 32px}
section{margin:14px 0;background:#0d1722;border:1px solid #16283a;border-radius:14px;overflow:hidden}
h2{margin:0;padding:11px 14px;font-size:15px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
h2 span{font-size:12px;font-weight:500;color:#6fd8c0;background:rgba(84,247,208,.1);border:1px solid rgba(84,247,208,.25);padding:2px 9px;border-radius:999px}
img{display:block;width:100%;height:auto;background:#000;min-height:120px}
ul{margin:0;padding:12px 18px 16px 32px;color:#a9bccd;font-size:13.5px}
li{margin:4px 0}
footer{padding:0 16px 26px;color:#5f748a;font-size:12.5px}
footer b{color:#8aa3ba}
</style></head><body>
<header><h1>氮气尾焰改版 · 实机截图</h1>
<p>① 赤焰号 / 青锋号 / 绯鲨号 / 流光号 → 长鲸号同款火焰尾焰</p>
<p>② 绯鲨号、流光号的四散粒子已去掉，改为从喷口射出的火柱</p>
<p>③ 牛来号新增尾焰：单喷口驼色浓雾，做得又大又慢最笨重</p>
<p>④ 全部尾焰在加速期间持续喷射，不会断流</p></header>
<main>${cards}</main>
<footer>截图来自无头浏览器实机渲染。<b>哪条船的尾焰想更大 / 更小 / 换色，直接说船名即可。</b></footer>
</body></html>`;

fs.writeFileSync('dist/nitro-preview.html', html);
console.log('written', (html.length / 1024).toFixed(1) + 'KB + 8 imgs');
