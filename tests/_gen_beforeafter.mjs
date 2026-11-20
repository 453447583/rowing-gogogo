// 流光号尾焰 改前/改后 对比（游戏内真实截图）
import fs from 'node:fs/promises';
import path from 'node:path';
const dir = path.resolve('shots/nitro');
const b64 = async (f) => (await fs.readFile(path.join(dir, f))).toString('base64');

const items = [
  { tag: '改前', cls: 'old', name: '一团 toonWater 水花粒子', file: 'ab_OLD_foam.jpg',
    desc: '散、淡、没有方向——一团白泡沫糊在船尾，进图后基本看不清（亮像素仅 22.6%）。' },
  { tag: '改后', cls: 'new', name: '直线水流（主）+ 水花粒子（辅）', file: 'NEW_jetstream.jpg',
    desc: '<b>三根笔直水柱从船尾三个喷口向后上方喷出</b>，带流动水纹、末端渐隐；原来的水花粒子降为船尾的辅助飞溅。纯 three.js 三个 mesh，加法混合被 bloom 抓到、更亮更醒目。' },
];
const cards = await Promise.all(items.map(async (it) => {
  const src = await b64(it.file);
  return `<article class="card ${it.cls}">
    <div class="tag">${it.tag}</div>
    <div class="shot"><img src="data:image/jpeg;base64,${src}"></div>
    <h2>${it.name}</h2><p>${it.desc}</p></article>`;
}));
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>流光号尾焰 改前/改后</title>
<style>
 *{box-sizing:border-box}body{margin:0;background:#0b0f14;color:#e8eef5;font-family:'Segoe UI','Microsoft YaHei',sans-serif;padding:26px 22px 44px}
 h1{font-size:22px;margin:0 0 18px;letter-spacing:1px}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:1240px}
 @media(max-width:780px){.grid{grid-template-columns:1fr}}
 .card{background:#141c26;border:1px solid #243447;border-radius:14px;padding:13px}
 .card.new{border-color:#3f7fb0;box-shadow:0 8px 26px #0006}
 .tag{display:inline-block;font-size:11px;padding:3px 10px;border-radius:20px;background:#2a2020;color:#c99;margin-bottom:9px}
 .card.new .tag{background:#1c4d70;color:#cdeaff}
 .shot{background:#05070a;border-radius:10px;overflow:hidden;aspect-ratio:16/10}
 .shot img{width:100%;height:100%;object-fit:cover;display:block}
 h2{font-size:16px;margin:11px 0 6px}p{font-size:13px;line-height:1.7;margin:0;color:#b7c6d6}p b{color:#9fd0f0}
</style></head><body>
<h1>绯鲨号 · 尾焰「直线水流」改造（同船·同机位·30m/s）</h1>
<div class="grid">${cards.join('')}</div></body></html>`;
const out = path.resolve('shots/nitro/before_after.html');
await fs.writeFile(out, html, 'utf8');
console.log('wrote', out);
