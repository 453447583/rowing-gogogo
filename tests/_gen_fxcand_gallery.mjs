// 生成流光号尾焰候选对比画廊（单文件 HTML，图片 base64 内嵌）
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('shots/fxcand');
const b64 = async (f) => (await fs.readFile(path.join(dir, f))).toString('base64');

// 主推 3 个 + 2 个落选示意
const items = [
  {
    tag: '首推 · 完全未使用', name: 'N_MagicThunder', cn: '魔法雷光柱',
    file: 'N_MagicThunder_400ms.jpg',
    pros: '笔直贯穿的白蓝电光柱，视觉最强烈；素材包里从未被任何特效登记使用，7 艘赛艇尾焰都没用过；蓝白配色天然贴合「流光」的淡紫冰主题。',
    con: '原素材是竖直落雷，做成尾焰需要旋转 90° 让光柱朝船尾水平喷出（我来调）。',
    hot: true,
  },
  {
    tag: '最像尾焰 · 赛艇未用', name: 'Laser01 (jet)', cn: '直通喷射光束',
    file: 'Laser01_jet_400ms.jpg',
    pros: '造型最标准的一束直线喷流（亮绿芯 + 青白光锥），「向后喷」的读法最强；7 艘赛艇尾焰都没用过它。',
    con: '怪物模式的加速尾焰 jet 用的就是这段（同素材，不同用途）；颜色是绿，需染成冰蓝紫。',
  },
  {
    tag: '配色最贴 · 赛艇未用', name: 'P2_SwordLightning', cn: '蓝紫雷光',
    file: 'P2_SwordLightning_400ms.jpg',
    pros: '蓝紫竖向强电光 + 横向扩散光晕，冲击力强，配色最贴流光号淡紫主题；7 艘赛艇尾焰没用过。',
    con: 'BOSS 技能「蓝紫雷斩」在用这段；横向光晕可能偏「爆炸」而非「持续喷」。',
  },
  {
    tag: '落选示意', name: 'ef_lightning01', cn: '紫色电球',
    file: 'ef_lightning01_150ms.jpg',
    pros: '—', con: '是一颗紫色爆炸电球，不是直线光束，视觉也不够强。', dim: true,
  },
  {
    tag: '落选示意', name: 'A_BlueLaser', cn: '蓝色光点',
    file: 'A_BlueLaser_400ms.jpg',
    pros: '—', con: '只是一个蓝色小光点 + 细弧线，太弱且已被「引雷针」道具占用。', dim: true,
  },
];

const cards = await Promise.all(items.map(async (it) => {
  const src = await b64(it.file);
  const hot = it.hot ? 'hot' : '';
  const dim = it.dim ? 'dim' : '';
  return `<article class="card ${hot} ${dim}">
    <div class="tag ${it.hot ? 't-hot' : it.dim ? 't-dim' : ''}">${it.tag}</div>
    <div class="shot"><img src="data:image/jpeg;base64,${src}" alt="${it.name}"></div>
    <h2>${it.cn}</h2><div class="code">${it.name}</div>
    ${it.pros !== '—' ? `<p class="pros"><b>优点</b> ${it.pros}</p>` : ''}
    <p class="con"><b>注意</b> ${it.con}</p>
  </article>`;
}));

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>流光号尾焰候选对比</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; background:#0b0f14; color:#e8eef5; font-family:'Segoe UI','Microsoft YaHei',sans-serif; padding:28px 20px 50px; }
  h1 { font-size:24px; margin:0 0 6px; letter-spacing:1px; }
  .lead { color:#9fb3c8; font-size:14px; line-height:1.7; margin:0 0 22px; max-width:900px; }
  .lead b { color:#8fd6ff; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:18px; max-width:1100px; }
  .card { background:#141c26; border:1px solid #243447; border-radius:14px; padding:14px; opacity:.82; }
  .card.hot { border-color:#3f7fb0; box-shadow:0 0 0 1px #2b5f8a,0 8px 30px #0008; opacity:1; }
  .card.dim { opacity:.5; }
  .tag { display:inline-block; font-size:11px; padding:3px 9px; border-radius:20px; background:#1d2b3a; color:#8fb7d8; margin-bottom:10px; }
  .tag.t-hot { background:#1c4d70; color:#cdeaff; }
  .tag.t-dim { background:#2a2020; color:#c99; }
  .shot { background:#05070a; border-radius:10px; overflow:hidden; aspect-ratio:4/3; display:flex; align-items:center; justify-content:center; }
  .shot img { width:100%; height:100%; object-fit:contain; display:block; }
  h2 { font-size:18px; margin:13px 0 2px; }
  .code { font:12px Consolas,monospace; color:#6d8aa5; margin-bottom:10px; }
  p { font-size:12.5px; line-height:1.6; margin:7px 0; color:#b7c6d6; }
  p b { color:#e8eef5; }
  .pros b { color:#7fe0a8; }
  .con b { color:#ffb27a; }
  .foot { margin-top:26px; color:#7d93a8; font-size:12.5px; max-width:900px; line-height:1.8; }
  .foot b { color:#9fd0f0; }
</style></head><body>
<h1>流光号 · 尾焰特效候选</h1>
<p class="lead">当前尾焰用的是 <b>冰雾膨胀（ef_ice02）</b>——一大张软边白团，所以看着像灰尘、看不清。下面 3 个都是<b>直线光束</b>、视觉更强、且与现有 7 艘赛艇尾焰（火球/水花/风团/冰晶/电弧/火带/气流）<b>都不重复</b>。点开大图看细节，选一个告诉我就行。</p>
<div class="grid">${cards.join('')}</div>
<p class="foot"><b>说明：</b>这些是素材在独立预览台里、竖直流向时的原始样子。真正做成尾焰时，我会把它旋转成朝船尾水平喷出、染色成流光号的冰蓝紫、并按「密而近 / 不糊屏」的原则调好补喷节奏和喷射口。你先挑中意的，我再动手加入。</p>
</body></html>`;

const out = path.resolve('shots/fxcand/gallery.html');
await fs.writeFile(out, html, 'utf8');
console.log('wrote', out, (html.length / 1024).toFixed(0) + 'KB');
