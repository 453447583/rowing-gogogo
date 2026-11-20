// 生成漂移改造的单页报告（单文件 HTML，内联 CSS/SVG，无外部依赖）
//   node tests/_gen_drift_report.mjs
// 数据来源：tests/_run_drift_probes.mjs 落盘的 8 份 JSON（.tmp_build/drift_<id>.json）
// 参数口径直接 import DRIFT_TUNING，避免"调完参数忘了同步报告数字"。
import fs from 'node:fs';
import { DRIFT_TUNING } from '../src/game/Boat.js';

const probe = JSON.parse(fs.readFileSync('.tmp_build/drift_rower.json', 'utf8'));
const dblDeg = DRIFT_TUNING.doubleAngle * 180 / Math.PI;
const sglDeg = DRIFT_TUNING.singleAngle * 180 / Math.PI;
const capDeg = (DRIFT_TUNING.angleBase + DRIFT_TUNING.angleGain) * 180 / Math.PI;

// 8 船数据**直接读探针 JSON**，不再手抄常量
const IDS = ['rower', 'cow', 'skiff', 'falcon', 'titan', 'dolphin', 'vintage', 'longship'];
const BOATS = IDS.map((id) => {
  const p = JSON.parse(fs.readFileSync(`.tmp_build/drift_${id}.json`, 'utf8'));
  return {
    name: p.boat, id,
    ang: p.build.peak, t30: p.build.t30,
    drop: p.entry.drop1s, frame: +p.entry.maxDrop.toFixed(2),
    keep: p.drag.keep[2],
    dt: p.cornerTest.drift.t, dr: p.cornerTest.drift.radius,
    pt: p.cornerTest.plain.t, pr: p.cornerTest.plain.radius,
  };
}).sort((a, b) => b.ang - a.ang);

const corner = probe.cornerTest;
const spd = probe.spd;
const ang = probe.ang;
const tightest = BOATS.reduce((a, b) => (a.dt < b.dt ? a : b));
const heaviest = BOATS.reduce((a, b) => (a.pr > b.pr ? a : b));
const minAng = Math.min(...BOATS.map((b) => b.ang));

// ---------- 90° 弯示意：两条四分之一圆弧，同一出发点、同一初始朝向 ----------
const W = 340, H = 300, PAD = 46;
const rMax = corner.plain.radius;
const scale = Math.min((W - PAD * 2) / (rMax * 1.02), (H - PAD * 2) / (rMax * 1.02));
const arc = (R) => {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const th = (i / 40) * (Math.PI / 2);
    const x = R * Math.sin(th);
    const y = R * (1 - Math.cos(th));
    pts.push(`${(PAD + x * scale).toFixed(1)},${(H - PAD - y * scale).toFixed(1)}`);
  }
  return 'M' + pts.join(' L');
};
const driftEnd = [PAD + corner.drift.radius * scale, H - PAD - corner.drift.radius * scale];
const plainEnd = [PAD + corner.plain.radius * scale, H - PAD - corner.plain.radius * scale];

// ---------- 折线图工具 ----------
function lineChart(series, opts) {
  const w = 560, h = 200, padL = 46, padR = 54, padT = 18, padB = 32;
  const xs = series[0].data.length - 1;
  const lo = opts.min, hi = opts.max;
  const px = (i) => padL + (i / xs) * (w - padL - padR);
  const py = (v) => padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB);
  let out = `<svg viewBox="0 0 ${w} ${h}" class="chart">`;
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4;
    out += `<line x1="${padL}" y1="${py(v).toFixed(1)}" x2="${w - padR}" y2="${py(v).toFixed(1)}" class="grid"/>`;
    out += `<text x="${padL - 8}" y="${(py(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${opts.fmt(v)}</text>`;
  }
  for (let k = 0; k <= xs; k += 10) {
    out += `<text x="${px(k).toFixed(1)}" y="${h - 10}" class="axis" text-anchor="middle">${(k / 60).toFixed(2)}s</text>`;
  }
  for (const s of series) {
    const d = s.data.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    out += `<path d="${d}" class="ln" stroke="${s.color}"/>`;
    out += `<text x="${w - padR + 6}" y="${(py(s.data[s.data.length - 1]) + 4).toFixed(1)}" class="lbl" fill="${s.color}">${s.label}</text>`;
  }
  out += `</svg>`;
  return out;
}

const speedChart = lineChart([{ data: spd, color: '#5ad1c8', label: `${spd[spd.length - 1].toFixed(1)}%` }],
  { min: -8, max: 1, fmt: (v) => `${v.toFixed(0)}%` });
const angChart = lineChart([{ data: ang, color: '#f7b955', label: `${ang[ang.length - 1].toFixed(0)}°` }],
  { min: 0, max: 36, fmt: (v) => `${v.toFixed(0)}°` });

const rows = BOATS.map((b) => `<tr>
  <td class="nm">${b.name}<small>${b.id}</small></td>
  <td><b>${b.ang.toFixed(1)}°</b></td>
  <td>${b.t30.toFixed(2)}s</td>
  <td>${b.drop.toFixed(2)}%</td>
  <td>${b.frame.toFixed(2)}%</td>
  <td>${b.keep.toFixed(1)}%</td>
  <td class="hl">${b.dt.toFixed(2)}s<small>${b.dr.toFixed(1)}m</small></td>
  <td>${b.pt.toFixed(2)}s<small>${b.pr.toFixed(1)}m</small></td>
  <td class="ok">${(((b.pt - b.dt) / b.pt) * 100).toFixed(0)}%</td>
</tr>`).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>漂移系统重做 · 激流勇进</title>
<style>
  :root{
    --bg:#0b1418; --panel:#111e24; --panel2:#16262e; --line:#22383f;
    --ink:#e6f2f3; --dim:#8fa8ad; --teal:#5ad1c8; --amber:#f7b955; --rose:#ef7a76;
  }
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 700px at 15% -10%,#16323a 0%,#0b1418 55%) fixed;
    color:var(--ink);font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
    padding:38px 20px 70px}
  .wrap{max-width:1080px;margin:0 auto}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:.5px}
  .sub{color:var(--dim);margin:0 0 26px;font-size:14px}
  h2{font-size:17px;margin:34px 0 14px;padding-left:11px;border-left:3px solid var(--teal);letter-spacing:.4px}
  .card{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);
    border-radius:14px;padding:18px 20px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:820px){.grid2{grid-template-columns:1fr}}
  .lead{font-size:15px;color:#cfe2e4}
  .lead b{color:var(--teal)}
  .kv{display:grid;grid-template-columns:88px 1fr;gap:6px 12px;font-size:14px;margin:0}
  .kv dt{color:var(--dim)}
  .kv dd{margin:0}
  .bad{color:var(--rose)}
  .good{color:var(--teal)}
  svg.chart{width:100%;height:auto;display:block}
  .grid{stroke:#1d3238;stroke-width:1}
  .axis{fill:#6f8a8f;font-size:10px;font-family:inherit}
  .lbl{font-size:11px;font-family:inherit}
  .ln{fill:none;stroke-width:2.4;stroke-linejoin:round;stroke-linecap:round}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th,td{padding:9px 8px;text-align:center;border-bottom:1px solid var(--line)}
  th{color:var(--dim);font-weight:500;font-size:12.5px;white-space:nowrap}
  td small{display:block;color:var(--dim);font-size:11px;line-height:1.3}
  td.nm{text-align:left;font-weight:600}
  td.hl{color:var(--teal);font-weight:600}
  td.ok{color:var(--amber);font-weight:600}
  .scroll{overflow-x:auto}
  .tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;
    border:1px solid var(--line);color:var(--dim);margin-right:6px}
  .tag.on{border-color:#2f5d5a;background:#12312f;color:var(--teal)}
  ul{margin:8px 0 0;padding-left:20px}
  li{margin:5px 0}
  code{background:#0e1a1f;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:13px}
  .note{color:var(--dim);font-size:13px;margin-top:10px}
  .arc-label{font-size:11px;font-family:inherit}
</style></head>
<body><div class="wrap">

<h1>漂移系统重做 · 从"一顿一顿"到跑跑卡丁车</h1>
<p class="sub">滑移角成为真正的物理状态 · 方向键连续控制 · 单/双喷按漂移深度判定 · 撞障碍只丢本次集气 · 轨迹贴内弯</p>

<div class="card">
  <p class="lead">结论：<b>车头 = 轨迹方向 + 滑移角</b>。方向键决定"想要多少滑移角"，轨迹按自己的曲率转弯，
  速度永远沿轨迹走 —— 这才是"漂"，旧版只是把车头的转向速度拉高三倍，所以既没滑移感又一停一顿。</p>
  <div class="grid2" style="margin-top:14px">
    <div>
      <h3 style="font-size:14px;color:var(--rose);margin:0 0 8px">旧版三处阶跃（= 一顿一顿）</h3>
      <ul>
        <li>按下 Shift 的<b>一帧</b>把速度砍掉 8~18%（<code>driftCut</code>）</li>
        <li>拉车头倍率在 <code>2.05 / 0.75 / -1.65</code> 三点间跳变</li>
        <li>松键即断漂，再按住又重新砍一次速</li>
        <li>方向入弯锁死，反打变成"和车头对抗"</li>
        <li>速度方向被强行跟着车头转 → 滑移角只有 14°，是假侧滑</li>
      </ul>
    </div>
    <div>
      <h3 style="font-size:14px;color:var(--teal);margin:0 0 8px">新版全部换成连续量</h3>
      <ul>
        <li>入漂<b>不掉速</b>，减速由"拖曳曲线"在 ${DRIFT_TUNING.dragRamp}s 内渐入</li>
        <li>滑移角按 ${DRIFT_TUNING.angleRate.toFixed(1)} rad/s 限速逼近目标，没有阶跃</li>
        <li>断漂进 ${DRIFT_TUNING.chainWindow}s "补气窗口"，气与计时都不清零</li>
        <li>方向键连续改滑移角 → 拖漂 / 彩虹漂 / 断漂补气</li>
        <li>满速滑移角上限约 ${capDeg.toFixed(0)}°，速度方向沿轨迹 → 真的在侧滑</li>
      </ul>
    </div>
  </div>
</div>

<h2>本轮调校：从"一直往外甩"到贴内弯</h2>
<div class="card">
  <p class="lead">实测反馈是"<b>偏移半径一直往外，不符合物理逻辑</b>"。为此补了 <code>tests/drift_arc_probe.mjs</code>：
  按住漂移键 + 方向键 5 秒，记录世界坐标与轨迹方向，按 0.5s 窗口做最小二乘圆拟合算真实曲率半径。</p>
  <table style="margin-top:12px">
    <thead><tr><th style="text-align:left">赤焰号 @ 外海</th><th>起漂 0.5s 拟合 R</th><th>稳态（4.75s）拟合 R</th><th>稳态滑移角</th></tr></thead>
    <tbody>
      <tr><td style="text-align:left" class="bad">调整前</td><td>41.3m</td><td>28.1m</td><td>36.7°</td></tr>
      <tr><td style="text-align:left" class="good">调整后</td><td><b>29.0m</b></td><td><b>21.7m</b></td><td><b>29.7°</b></td></tr>
    </tbody>
  </table>
  <ul>
    <li>物理上半径并没有"持续变大"，但 <b>36.7° 的滑移角让船沿切线横滑太多</b>，加上起漂头 0.5s 先被甩到 41m 再收回，主观读起来就是"往外飘"。</li>
    <li>收紧 <code>angleBase ${DRIFT_TUNING.angleBase}</code> / <code>angleGain ${DRIFT_TUNING.angleGain}</code> / <code>angleCap ${DRIFT_TUNING.angleCap}</code>，把 <code>pathYaw</code> 提到 <b>${DRIFT_TUNING.pathYaw}</b>、<code>pathYawTau</code> 压到 <b>${DRIFT_TUNING.pathYawTau}</b>：起漂立刻入弯，不再先甩出去。</li>
    <li>双喷门槛同步从 30° 下调到 <b>${dblDeg.toFixed(1)}°</b>：最重的磐石号满速峰值只有 27.3°，不降门槛的话碰撞掉速后真循环只给单喷。</li>
  </ul>
</div>

<h2>漂移到底有没有用：同样转 90°</h2>
<div class="grid2">
  <div class="card">
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
      <path d="${arc(corner.plain.radius)}" fill="none" stroke="#5d757b" stroke-width="2" stroke-dasharray="6 5"/>
      <path d="${arc(corner.drift.radius)}" fill="none" stroke="#5ad1c8" stroke-width="3"/>
      <circle cx="${driftEnd[0].toFixed(1)}" cy="${driftEnd[1].toFixed(1)}" r="4" fill="#5ad1c8"/>
      <circle cx="${plainEnd[0].toFixed(1)}" cy="${plainEnd[1].toFixed(1)}" r="4" fill="#5d757b"/>
      <text x="${(driftEnd[0] + 10).toFixed(1)}" y="${(driftEnd[1] + 4).toFixed(1)}" class="arc-label" fill="#5ad1c8">
        漂移 ${corner.drift.t}s · R${corner.drift.radius}m</text>
      <text x="${(plainEnd[0] + 10).toFixed(1)}" y="${(plainEnd[1] + 4).toFixed(1)}" class="arc-label" fill="#93a9ad">
        纯打方向 ${corner.plain.t}s · R${corner.plain.radius}m</text>
      <text x="${PAD}" y="${H - 16}" class="axis">同一出发点、同一初始朝向、同样油门到底</text>
    </svg>
  </div>
  <div class="card">
    <dl class="kv">
      <dt>转 90° 用时</dt><dd><b class="good">${corner.drift.t}s</b> vs ${corner.plain.t}s（快 ${(((corner.plain.t - corner.drift.t) / corner.plain.t) * 100).toFixed(0)}%）</dd>
      <dt>弯道半径</dt><dd><b class="good">${corner.drift.radius}m</b> vs ${corner.plain.radius}m（紧 ${(((corner.plain.radius - corner.drift.radius) / corner.plain.radius) * 100).toFixed(0)}%）</dd>
      <dt>弯中速度</dt><dd>${corner.drift.s90} vs ${corner.plain.s90} km/h</dd>
      <dt>出弯速度</dt><dd><b class="good">${corner.drift.exitPeak}</b> vs ${corner.plain.exitPeak} km/h（双喷顶到极速 ×${(corner.drift.exitPeak / probe.drag.topStraight).toFixed(2)}）</dd>
    </dl>
    <p class="note">漂移中速度上限被压到直道的 ${(DRIFT_TUNING.speedRatio * 100).toFixed(0)}%（滑移角拉满再压 ${(DRIFT_TUNING.speedAngleLoss * 100).toFixed(0)}%），
    但换来 ${(corner.plain.radius / corner.drift.radius).toFixed(1)} 倍的转向能力 —— 弯里省下的时间远大于掉的那点速度。</p>
  </div>
</div>

<h2>入漂不再"闷一下"：速度与滑移角逐帧曲线（赤焰号）</h2>
<div class="grid2">
  <div class="card">
    <div style="font-size:13px;color:var(--dim);margin-bottom:6px">速度相对极速（按下漂移键那一刻 = 0s）</div>
    ${speedChart}
    <p class="note">前 0.3 秒几乎不掉速，之后才慢慢"黏"下去；1 秒累计 ${probe.entry.drop1s.toFixed(2)}%，单帧最大跌幅 ${probe.entry.maxDrop.toFixed(2)}%。
    旧版是按下那一帧直接 −9%。</p>
  </div>
  <div class="card">
    <div style="font-size:13px;color:var(--dim);margin-bottom:6px">滑移角（车头与轨迹的夹角）</div>
    ${angChart}
    <p class="note">${probe.build.t30.toFixed(2)} 秒到 ${dblDeg.toFixed(1)}°（双喷门槛），${probe.build.tPeak.toFixed(2)} 秒到峰值 ${probe.build.peak.toFixed(1)}°。
    逐帧最大变化 ${probe.entry.maxAngJump.toFixed(1)}°，没有任何一帧跳变。</p>
  </div>
</div>

<h2>逐船手感（漂移角 / 建角速度 / 拖漂保速 / 弯道能力）</h2>
<div class="card scroll">
  <table>
    <thead><tr>
      <th style="text-align:left">赛艇</th><th>峰值滑移角</th><th>到 ${dblDeg.toFixed(1)}°</th><th>入漂 1s 掉速</th>
      <th>单帧最大跌幅</th><th>拖漂 3s 保速</th><th>90° 弯 · 漂移</th><th>90° 弯 · 不漂</th><th>省时</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note">八条船峰值都过 ${dblDeg.toFixed(1)}° 双喷门槛（最低 ${minAng.toFixed(1)}°），差异来自
  <code>driftAngle / driftRate / driftYaw / driftDrag</code>：${tightest.name}过 90° 弯最快（${tightest.dt.toFixed(2)}s）；
  ${heaviest.name}最"重"（不漂半径 ${heaviest.pr.toFixed(1)}m）。</p>
</div>

<h2>验收清单（都是跑出来的，不是估的）</h2>
<div class="card">
  <p>
    <span class="tag on">按住漂移键持续朝方向键漂</span>
    <span class="tag on">滑移角 &gt; ${dblDeg.toFixed(1)}° 回正 → 双喷</span>
    <span class="tag on">入漂减速渐进</span>
    <span class="tag on">撞障碍只丢本次集气</span>
    <span class="tag on">拖漂</span>
    <span class="tag on">彩虹漂移</span>
    <span class="tag on">断漂补气</span>
    <span class="tag on">逐船差异</span>
    <span class="tag on">真循环双喷</span>
    <span class="tag on">0 碎段</span>
    <span class="tag on">轨迹贴内弯</span>
  </p>
  <ul>
    <li><b>撞障碍</b>：漂移中撞墙后 <code>nitroBottles</code> 1 → 1（一瓶不掉），底部集气只回退到本次起漂前的量（0.428 → 0.25）。</li>
    <li><b>彩虹漂</b>：左右反打，滑移角在 ${probe.rainbow.min}° ~ +${probe.rainbow.max}° 之间连续穿越 0 共 ${probe.rainbow.flips} 次，漂移全程不断，集气 +${probe.rainbow.gaugeGain}。</li>
    <li><b>断漂补气</b>：松键 0.2s 再按住 → 计时从 ${probe.chain.chainBefore.time.toFixed(2)}s 接到 ${probe.chain.chainAfter.time.toFixed(2)}s（同一次漂移），不会重新走启动分支。</li>
    <li><b>点按不给喷</b>：按住 0.1s 就松，喷数 0（最短漂移时长 ${DRIFT_TUNING.minHold}s）。</li>
    <li><b>贴墙不再闪切</b>：真 Game 循环里连续漂移段 4.21s + 1.80s，&lt;0.16s 的碎段 <b>0</b>；回正发喷后加了 ${DRIFT_TUNING.relock}s 起漂冷却，修掉了"刚发完喷又黏回漂移"的 0.12s 碎段。</li>
    <li><b>回归</b>：<code>npm test</code> PASS、<code>npm run build</code> 通过、实机循环 0 NaN / 0 逻辑异常。</li>
  </ul>
</div>

<h2>实机循环验收（真 Game rAF，不是纯物理探针）</h2>
<div class="card">
  <p style="margin-top:0"><code>tests/drift_race_smoke.mjs</code> 把输入与统计挂在 <code>Boat.updateLocal</code> 上：统计帧 == 物理帧，时间线按真正传给物理的 dt 累加，不受无头 rAF 节流影响。10.5 秒游戏时间内依次跑：加速 → 拖漂 2s → 彩虹反打 1.6s → 重建角 → <b>受控注入一次真实碰撞</b> → 冷却 → 重新起漂 → 按住漂移键回正发喷。</p>
  <p class="note">为让结果可复现，隔离了三类与漂移状态机无关的环境噪声：起点附近的静态碰撞体/护栏（<code>wallContactTimer</code> 会被逐帧刷成 0.35，起漂条件永远进不去）、外海圆边界回弹、浪尖抛飞。碰撞改成往船头前塞一个临时 collider，走的仍是 <code>updateLocal</code> 里同一段圆碰撞与 <code>cancelDriftForCollision()</code>。</p>
  <table>
    <thead><tr>
      <th style="text-align:left">组合</th><th>物理帧</th><th>连续漂移段</th><th>碎段</th>
      <th>滑移角</th><th>碰撞集气回退</th><th>氮气瓶</th><th>双喷</th><th>NaN / 逻辑异常</th>
    </tr></thead>
    <tbody>
      <tr><td>赤焰号 @ 外海</td><td>646</td><td>4.21s + 1.80s</td><td>0</td><td>−29.2° ~ 29.6°</td><td>0.428 → 0.25</td><td>1 → 1</td><td>2 发</td><td>0 / 0</td></tr>
      <tr><td>牛来号 @ 海峡</td><td>636</td><td>4.22s + 1.82s</td><td>0</td><td>−33.4° ~ 33.6°</td><td>0.430 → 0.25</td><td>1 → 1</td><td>2 发</td><td>0 / 0</td></tr>
      <tr><td>磐石号 @ 湖泊</td><td>627</td><td>4.21s + 1.78s</td><td>0</td><td>−27.1° ~ 27.3°</td><td>0.429 → 0.25</td><td>1 → 1</td><td>2 发</td><td>0 / 0</td></tr>
    </tbody>
  </table>
  <ul>
    <li><b>碰撞语义</b>：起漂基准 <code>driftGaugeStart = 0.25</code>，撞前底部集气涨到 0.43，撞后精确回退到 0.25，<code>nitroBottles</code> 一瓶不掉，硬直结束后重新起漂成功。</li>
    <li><b>双喷</b>：峰值滑移角过 ${dblDeg.toFixed(1)}° 后按住漂移键回中，队列排 2 发小喷，按 0.75s 间隔依次落地（喷射计时器起跳 2 次）。发喷同帧队列就被消费一发，所以只数队列峰值会误判成单喷。</li>
    <li><b>彩虹漂</b>：真循环里方向反打后滑移角从 +29° 连续穿到 −29°，漂移全程不中断。</li>
    <li><b>无头特效异常</b>：<code>--disable-gpu</code> 下 Effekseer 加载贴图会固定抛一次 <code>texImage2D Overload resolution failed</code>，属资源加载层，已从逻辑异常里单列隔离。</li>
  </ul>
</div>

<h2>调手感看哪里</h2>
<div class="card">
  <p style="margin-top:0">全部在 <code>src/game/Boat.js</code> 的 <code>DRIFT_TUNING</code>，逐船在 <code>src/data/boats.js</code> 的 <code>BOAT_HANDLING</code>：</p>
  <ul>
    <li><code>angleBase / angleGain / angleCap</code> — 滑移角上限（满速 ${DRIFT_TUNING.angleBase}+${DRIFT_TUNING.angleGain} ≈ ${capDeg.toFixed(0)}°，硬上限 ${(DRIFT_TUNING.angleCap * 180 / Math.PI).toFixed(0)}°）</li>
    <li><code>angleRate</code> — 建角/反打速度（${DRIFT_TUNING.angleRate.toFixed(1)} rad/s；调小更"绵"，调大更"脆"）</li>
    <li><code>straightenFast / straightenSlow</code> — 过 ${dblDeg.toFixed(1)}° 后松方向甩正的快慢（${DRIFT_TUNING.straightenFast}s）／拖漂保角（${DRIFT_TUNING.straightenSlow}s）</li>
    <li><code>pathYaw / pathYawTau</code> — 漂移中轨迹偏航倍率（<b>${DRIFT_TUNING.pathYaw}</b>）与入弯响应（${DRIFT_TUNING.pathYawTau}s）；必须 &gt; 1，否则漂移比不漂还慢，调大 = 更贴内弯</li>
    <li><code>speedRatio / speedAngleLoss / dragRamp</code> — 漂移速度上限与"拖曳"渐入时间</li>
    <li><code>singleAngle / doubleAngle</code> — ${sglDeg.toFixed(1)}° 单喷 / ${dblDeg.toFixed(1)}° 双喷</li>
  </ul>
</div>

</div></body></html>`;

fs.mkdirSync('shots/drift', { recursive: true });
fs.writeFileSync('shots/drift/index.html', html);
console.log('shots/drift/index.html', (html.length / 1024).toFixed(1) + ' KB');
