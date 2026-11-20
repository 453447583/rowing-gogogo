// 尾焰方案对比画廊（游戏内真实截图，单文件 HTML）
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('shots/nitro');
const b64 = async (f) => (await fs.readFile(path.join(dir, f))).toString('base64');

const items = [
  {
    tag: '你选的 · 有硬伤', name: 'P2_SwordLightning', cn: '剑雷爆发（平衡版）',
    file: 'ab_P2_balanced.jpg', bad: true,
    desc: '蓝白光晕是横向铺开的，不是向后光束；<b>船尾下方明显飞出一把黑色剑</b>（素材自带的 2 个 3D 模型之一）。叠加多点会糊满半屏（亮像素 58%），叠加少点又几乎看不见（20%）。',
  },
  {
    tag: '纯贴图 · 干净', name: 'Laser01 (jet)', cn: '青绿直喷光束',
    file: 'ab_Laser01_streak.jpg',
    desc: '一束干净的直线喷流，向后、无杂物、不糊屏。缺点是偏细、偏青绿，不够「炸裂」。',
  },
  {
    tag: '纯贴图 · 推荐', name: 'N_MagicThunder（细）', cn: '蓝白雷光柱',
    file: 'ab_Thunder_slim.jpg', good: true,
    desc: '笔直向后射出的蓝白光束，<b>零 3D 模型、无任何杂物</b>，素材包里从未被使用过。干净、明亮、天生贴合「流光」。',
  },
  {
    tag: '纯贴图 · 推荐', name: 'N_MagicThunder（粗）', cn: '蓝紫雷光柱（加粗）',
    file: 'ab_Thunder_punch.jpg', good: true,
    desc: '同素材放大，光束更粗、更炸裂，蓝紫配色最贴流光号。唯一要收的是「别射太远」，我会把拖尾长度压到贴船尾。',
  },
];

const cards = await Promise.all(items.map(async (it) => {
  const src = await b64(it.file);
  return `<article class="card ${it.good ? 'good' : ''} ${it.bad ? 'bad' : ''}">
    <div class="tag ${it.good ? 't-good' : it.bad ? 't-bad' : ''}">${it.tag}</div>
    <div class="shot"><img src="data:image/jpeg;base64,${src}" alt="${it.name}"></div>
    <h2>${it.cn}</h2><div class="code">${it.name}</div>
    <p>${it.desc}</p>
  </article>`;
}));

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>流光号尾焰 · 游戏内实测对比</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0b0f14;color:#e8eef5;font-family:'Segoe UI','Microsoft YaHei',sans-serif;padding:26px 20px 46px}
  h1{font-size:23px;margin:0 0 6px;letter-spacing:1px}
  .lead{color:#9fb3c8;font-size:14px;line-height:1.75;margin:0 0 20px;max-width:960px}
  .lead b{color:#8fd6ff}.lead .warn{color:#ffb27a}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;max-width:1180px}
  .card{background:#141c26;border:1px solid #243447;border-radius:14px;padding:13px;opacity:.9}
  .card.good{border-color:#3f7fb0;box-shadow:0 8px 26px #0006;opacity:1}
  .card.bad{border-color:#7a3a3a;background:#1c1416}
  .tag{display:inline-block;font-size:11px;padding:3px 9px;border-radius:20px;background:#1d2b3a;color:#8fb7d8;margin-bottom:9px}
  .tag.t-good{background:#1c4d70;color:#cdeaff}.tag.t-bad{background:#5a2226;color:#ffc9c9}
  .shot{background:#05070a;border-radius:10px;overflow:hidden;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center}
  .shot img{width:100%;height:100%;object-fit:cover;display:block}
  h2{font-size:17px;margin:11px 0 1px}.code{font:11.5px Consolas,monospace;color:#6d8aa5;margin-bottom:8px}
  p{font-size:12.5px;line-height:1.65;margin:0;color:#b7c6d6}p b{color:#ffb27a}
  .card.good p b{color:#9fd0f0}
</style></head><body>
<h1>流光号 · 尾焰游戏内实测（同船/同机位/同 30m/s）</h1>
<p class="lead">这四张都是真的在游戏里、船尾 9m 侧后方拍的，不是素材缩略图。<br>
<span class="warn">你要的 P2_SwordLightning 有个硬伤：它自带 2 个 3D 剑模型，船尾会飞出一把黑剑</span>（第一张），而且它本质是「原地爆发」，怎么调都成不了「向后喷的光束」。<br>
右侧两个 <b>N_MagicThunder</b> 是纯贴图（零模型、无杂物）、素材包从未使用、笔直蓝紫光束——最贴你「流光=直直光线向后喷」的描述。</p>
<div class="grid">${cards.join('')}</div>
</body></html>`;

const out = path.resolve('shots/nitro/ab_compare.html');
await fs.writeFile(out, html, 'utf8');
console.log('wrote', out, (html.length / 1024).toFixed(0) + 'KB');
