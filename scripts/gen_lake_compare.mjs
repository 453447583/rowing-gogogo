// 生成「湖泊环线 · 看台与赛道周边装饰」单文件对比页：截图全部内联成 base64，无外部依赖。
//   node scripts/gen_lake_compare.mjs
// 左 = 装饰关闭（?lakeStadium=0），右 = 装饰开启（默认）。两张同门号、同机位、同天气，
// 所以除了新增道具之外的像素（尤其水面）应当完全一致。
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('shots/verify');
const read = async (f) => (await fs.readFile(path.join(dir, f))).toString('base64');
const [off0, on0, off4, on4] = await Promise.all([
  read('lake-stand-off-g0.jpg'),
  read('lake-stand-on-g0.jpg'),
  read('lake-stand-off-g4.jpg'),
  read('lake-stand-on-g4.jpg'),
]);
const img = (b) => 'data:image/jpeg;base64,' + b;

const slider = (tag, before, after) => `
<div class="compare" style="--pos:50%">
  <img src="${after}" alt="装饰开启">
  <div class="overlay"><img src="${before}" alt="装饰关闭"></div>
  <div class="divider"></div>
  <div class="grip">&#8596;</div>
  <span class="tag l">关闭装饰</span><span class="tag r">开启装饰</span>
  <input type="range" min="0" max="100" value="50" aria-label="${tag} 前后对比滑块">
</div>`;

const pair = (title, before, after) => `
<div class="pair">
  <div class="shot"><img src="${before}" alt="装饰关闭"><div class="cap"><b>关闭</b> · ${title} · ?lakeStadium=0</div></div>
  <div class="shot"><img src="${after}" alt="装饰开启"><div class="cap"><b>开启</b> · ${title} · 默认</div></div>
</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>湖泊环线 · 看台与赛道周边装饰</title>
<style>
:root{--bg:#f5f7fa;--card:#fff;--ink:#16202c;--muted:#5b6b7d;--line:#dfe6ee;--blue:#1262d2}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.6}
.wrap{max-width:1180px;margin:0 auto;padding:32px 20px 64px}
header{animation:rise .6s ease both}
h1{font-size:26px;margin:0 0 8px;font-weight:600}
h2{font-size:18px;margin:34px 0 6px;font-weight:600}
.sub{color:var(--muted);font-size:14px;margin:0 0 14px}
.hint{font-size:13px;color:var(--muted);margin:0 0 14px}
.badges{display:flex;flex-wrap:wrap;gap:8px}
.badge{font-size:12px;padding:5px 11px;border-radius:999px;background:#e8f0fd;color:#0d4ea8;border:1px solid #cfe0fa}
.badge.amber{background:#fff2e2;color:#8a4b06;border-color:#f7dcb8}
.badge.green{background:#e6f6ec;color:#0d7a45;border-color:#c4e8d3}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;animation:rise .6s ease both}
.card:nth-child(2){animation-delay:.08s}.card:nth-child(3){animation-delay:.16s}
.card h3{font-size:15px;margin:0 0 8px;font-weight:600}
.card p{font-size:13px;color:var(--muted);margin:0}
.k{color:var(--blue);font-weight:600}
.compare{position:relative;width:100%;aspect-ratio:560/320;border-radius:14px;overflow:hidden;border:1px solid var(--line);background:#0b2a55;margin-bottom:18px;animation:rise .7s ease both}
.compare img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.compare .overlay{position:absolute;inset:0;width:100%;clip-path:inset(0 calc(100% - var(--pos)) 0 0);transition:clip-path .1s linear}
.compare .divider{position:absolute;top:0;bottom:0;left:50%;width:2px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.25);pointer-events:none}
.compare input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:ew-resize;margin:0}
.grip{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:28px;height:28px;border-radius:50%;background:#fff;color:#0d4ea8;font-size:13px;line-height:28px;text-align:center;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.tag{position:absolute;top:10px;font-size:11px;padding:4px 9px;border-radius:6px;background:rgba(8,20,36,.72);color:#fff;pointer-events:none}
.tag.l{left:10px}.tag.r{right:10px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;animation:rise .7s ease both}
.shot{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.shot img{width:100%;display:block}
.shot .cap{font-size:12px;color:var(--muted);padding:9px 12px;border-top:1px solid var(--line)}
.shot .cap b{color:var(--ink)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line)}
th{background:#eef3f9;font-weight:600}
tr:last-child td{border-bottom:0}
.ok{color:#0d7a45}.warn{color:#a35b00}
footer{margin-top:28px;font-size:12px;color:var(--muted)}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media(max-width:760px){.cards{grid-template-columns:1fr}.pair{grid-template-columns:1fr}.wrap{padding:22px 14px 48px}h1{font-size:22px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>湖泊环线 · 看台与赛道周边装饰</h1>
  <p class="sub">同门号、同机位、同天气实拍。左半为关闭装饰（?lakeStadium=0），右半为开启；拖动分割线可逐像素比对，<b>水面应当完全一致</b>。</p>
  <div class="badges">
    <span class="badge green">水面渲染零改动</span>
    <span class="badge">仅 lake 地图生效</span>
    <span class="badge amber">?lakeStadium=0 一键关闭</span>
    <span class="badge">其它地图零改动</span>
  </div>
</header>

<div class="cards">
  <div class="card"><h3>① 看台（P1 主体）</h3><p>沿赛道外侧弧长布点 <span class="k">10 座</span>，单座 44×13m、6 排台阶、顶棚 + 后柱 + 两端封墙；<span class="k">1739 名观众</span>按确定性哈希排座，全部合批成 2 个 draw call。</p></div>
  <div class="card"><h3>② 赛场设施</h3><p><span class="k">4 座大屏</span>架在顶棚上（程序化贴图：标题条 + 棋盘格 + 计分板）、<span class="k">20 根灯塔</span>、<span class="k">30 块广告板</span>（两种配色交替）、<span class="k">170 面檐下彩旗</span>。</p></div>
  <div class="card"><h3>③ 赛道边缘</h3><p>弯道外侧每 16m 一组 <span class="k">黑白 Chevron 立牌</span>（急弯三连排）、橙白浮台、黄黑警示柱；沿弧长布点，避开近道 / 岛屿 / 暗礁 / 领奖台，<b>不写任何碰撞体</b>。</p></div>
</div>

<h2>拖动对比</h2>
<p class="hint">机位 A：起点直道（门 0）</p>
${slider('起点直道', img(off0), img(on0))}
<p class="hint">机位 B：东弧弯道（门 4）</p>
${slider('东弧弯道', img(off4), img(on4))}

<h2>并排对照</h2>
${pair('起点直道 · 门 0', img(off0), img(on0))}
${pair('东弧弯道 · 门 4', img(off4), img(on4))}

<h2>水面回退的验收依据</h2>
<table>
  <tr><th>检查项</th><th>结果</th></tr>
  <tr><td>Water.js 内是否还有赛事代码</td><td class="ok">0 处：<code>setStadium</code> / <code>#applyStadiumPalette</code> / <code>uStadiumFoam</code> 已全部删除</td></tr>
  <tr><td>运行时实测水面 uniform</td><td class="ok">water.setStadium = undefined；uStadiumFoam 不存在；uSat = 0.8（地图默认，非 1.05）；水色 1c6170 / 12404f 由天气与昼夜决定</td></tr>
  <tr><td>Game 是否还接后处理调色</td><td class="ok">已移除 setMapGrade 调用，只切装饰层可见性</td></tr>
  <tr><td>门控（纯逻辑断言）</td><td class="ok">仅 lake 为 true；canyon / ocean / palace / tide / strait / baked 全部 false；?lakeStadium=0 为 false</td></tr>
  <tr><td>岸边种树避让</td><td class="ok">种树与摆石改用与看台同一份占地数据（LakeStadiumLayout），看台范围内不种树，rng 顺序保持不变</td></tr>
  <tr><td>空气墙（airwall_probe lake）</td><td class="ok">装饰层不写 colliders</td></tr>
  <tr><td>生产构建</td><td class="ok">通过</td></tr>
  <tr><td>玩法回归 npm test</td><td class="warn">历史遗留失败：moving obstacle caps use the same cyan marker language（与本次改动无关）</td></tr>
</table>

<footer>截图：无头 Edge + 真实追随相机 + 合成器输出，560×320 JPEG。所有图片已内联，本页可离线打开，无外部依赖。</footer>
</div>
<script>
document.querySelectorAll('.compare').forEach(function (box) {
  var range = box.querySelector('input');
  var divider = box.querySelector('.divider');
  var grip = box.querySelector('.grip');
  function apply() {
    var p = range.value + '%';
    box.style.setProperty('--pos', p);
    divider.style.left = p;
    grip.style.left = p;
  }
  range.addEventListener('input', apply);
  apply();
});
</script>
</body>
</html>
`;

const out = path.join(dir, 'lake-stadium-compare.html');
await fs.writeFile(out, html, 'utf8');
console.log('saved', out, (Buffer.byteLength(html) / 1024).toFixed(0) + 'KB');
