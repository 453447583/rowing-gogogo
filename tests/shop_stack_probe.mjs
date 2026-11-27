// 穿搭预览「同心三层」截图 + 几何断言：node tests/shop_stack_probe.mjs
// 前置：dev 5199 + 游戏服务器 3000。只拍右侧穿搭预览，逐个头像框 / 光效组合过一遍：
//   里层=玩家真实头像，中层=头像框（镂空正好卡住头像，不许盖脸），外层=名牌光效（只在框外露一圈）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import WebSocket from 'ws';
import { ensureTestAccount } from './_account.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = process.env.WB_URL || 'http://127.0.0.1:5199/';
const cdpPort = 10060 + Math.floor(Math.random() * 30);
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/shop-stack-' + Date.now());
const shots = path.resolve('shots/verify');
fs.mkdirSync(shots, { recursive: true });

const FRAMES = ['frame_bronze', 'frame_silver', 'frame_gold', 'frame_cyber', 'frame_season'];
const FX = ['fx_warm', 'fx_prism'];
const AVATAR_PX = 84;

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  ✓ ' + label);
  else { failures += 1; console.error('  ✗ ' + label, extra === undefined ? '' : JSON.stringify(extra)); }
};

const child = spawn(edge, ['--headless=new', '--no-sandbox', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`, '--window-size=1440,900', base], { stdio: 'ignore' });

let ws = null;
try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json`); if (r.ok) tabs = await r.json(); } catch { /* 等 */ }
    if (!tabs) await sleep(200);
  }
  if (!tabs) throw new Error('CDP 未就绪');
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  const pending = new Map();
  const pageErrors = [];
  let seq = 0;
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const ev = async (expression) => (await cdp('Runtime.evaluate', {
    expression: `(async function(){ try { return (${expression}); } catch(e){ return 'ERR:'+e.message; } })()`,
    returnByValue: true, awaitPromise: true,
  }))?.result?.value;
  const waitFor = async (expr, label, tries = 120) => {
    for (let i = 0; i < tries; i++) {
      if (await ev(expr) === true) return true;
      await sleep(250);
    }
    console.error('    timeout:', label);
    return false;
  };
  // 只截右侧穿搭面板，细节看得清
  const shotSide = async (name) => {
    const clip = await ev(`(function(){
      const el = document.querySelector('.ws-side') || document.querySelector('.ws-panel');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    })()`);
    if (!clip || !clip.width) { console.error('    clip 缺失，跳过', name); return; }
    const r = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } });
    fs.writeFileSync(path.join(shots, name), Buffer.from(r.data, 'base64'));
    console.log('  · shots/verify/' + name);
  };

  await waitFor(`!!document.getElementById('name-plate')`, '主菜单');
  const user = 'stack' + Date.now().toString(36).slice(-4);
  const token = await ensureTestAccount('http://127.0.0.1:3000', user, 'sail123456');
  ok(!!token, '测试账号 token 已拿到');
  const now = Date.now();
  const DEMO = {
    uid: 'u_stack', n: '测试船长', pts: 2600, earned: 9000, spent: 6400,
    inv: Object.fromEntries([...FRAMES, ...FX, 'title_rough', 'badge_wave', 'badge_dragon', 'paint_red'].map((k) => [k, 1])),
    equip: { frame: 'frame_bronze', fx: 'fx_warm', title: 'title_rough', badges: ['badge_wave', 'badge_dragon'], paint: 'paint_red' },
    log: [{ d: '竞速上榜 第 1 名 · 珊瑚湾 · 3 圈', at: now - 40 * 60e3 }],
  };
  await ev(`(function(){
    localStorage.setItem('rr-account-token', ${JSON.stringify(token || '')});
    localStorage.setItem('rr-name', ${JSON.stringify(user)});
    localStorage.setItem('rr-avatar', 'shark');
    localStorage.setItem('rr-wallet-cache', ${JSON.stringify(JSON.stringify(DEMO))});
    return 1;
  })()`);
  // 打一个只活在当前页的标记，等它消失 = 真的重载完了（否则会量到旧 DOM）
  await ev(`(function(){ window.__preReload = 1; location.reload(); return 1; })()`);
  await waitFor(`window.__preReload === undefined`, '首轮重载');

  const inited = await waitFor(`!!document.querySelector('#wallet-panel .ws')`, '面板 init');
  ok(inited, '小店面板初始化完成');
  await sleep(2200);
  const modUrl = await ev(`performance.getEntriesByType('resource')
    .map(x => x.name).find(n => n.includes('/src/ui/walletPanel.js')) || '/src/ui/walletPanel.js'`);

  // 点名牌开店：账号门 / 3D 启动都可能拖一下，点不到面板就重试几次
  const openShop = async () => {
    for (let i = 0; i < 8; i++) {
      await ev(`(function(){ document.getElementById('name-plate').click(); return 1; })()`);
      await sleep(600);
      if (await ev(`!!document.querySelector('.ws-side .ws-panel')`)) return true;
    }
    return false;
  };

  const apply = async (equip) => {
    // 面板偶尔会被账号/网络事件关掉，先确认还开着再改数据
    if (!(await ev(`!!document.querySelector('.ws-side .ws-panel')`))) await openShop();
    // 注：data 是公开字段，直接换掉再点一次分类触发整块重绘（私有 #render 不能从外部调）
    await ev(`(async function(){
      const m = await import(${JSON.stringify(modUrl)});
      m.walletPanel.data = { ...${JSON.stringify(DEMO)}, equip: ${JSON.stringify(equip)} };
      m.walletPanel.picked = '';
      document.querySelectorAll('[data-ws-cat]')[0]?.click();
      return 1;
    })()`);
    await sleep(420);
  };

  const metrics = () => ev(`(function(){
    const hero = document.querySelector('.ws-hero');
    const av = document.querySelector('.ws-hero .ws-av');
    const avImg = av?.querySelector('img');
    const frame = document.querySelector('.ws-hero .ws-av-frame');
    const fx = document.querySelector('.ws-hero-fx');
    const stage = document.querySelector('.ws-stage');
    const plate = document.querySelector('.ws-plate');
    const tags = document.querySelector('.ws-tags');
    const title = document.querySelector('.ws-ptitle-img');
    const box = (el) => el ? el.getBoundingClientRect() : null;
    const h = box(hero); const s = box(stage); const p = box(plate); const t = box(title);
    return {
      hero: h && Math.round(h.width),
      av: box(av) && Math.round(box(av).width),
      frameOk: frame ? (frame.complete && frame.naturalWidth > 0) : null,
      fxOk: fx ? (fx.complete && fx.naturalWidth > 0) : null,
      avImgOk: avImg ? (avImg.complete && avImg.naturalWidth > 0) : false,
      avImgSrc: avImg?.getAttribute('src') || '',
      heroFits: h && s ? (h.width <= s.width + 1 && h.height <= s.height + 1) : null,
      plateFits: p && s ? (p.height <= s.height + 1) : null,
      titleFits: t && s ? (t.bottom <= s.bottom + 1) : null,
      stageH: s && Math.round(s.height),
      plateH: p && Math.round(p.height),
      tagsH: tags && Math.round(tags.getBoundingClientRect().height),
    };
  })()`);

  ok(await openShop(), '点名牌打开小店（右侧穿搭面板已渲染）');

  // 逐框拍：都不带光效，先看框和头像的咬合
  for (const key of FRAMES) {
    await apply({ frame: key, title: 'title_rough', badges: ['badge_wave', 'badge_dragon'] });
    await shotSide(`stack_${key}.png`);
    const m = await metrics();
    ok(m?.av === AVATAR_PX, `${key} 头像直径 ${AVATAR_PX}px`, m?.av);
    ok(m?.avImgOk === true, `${key} 头像图片加载成功`, m?.avImgSrc);
    ok(m?.frameOk === true, `${key} 框图片加载成功`);
    ok(m?.heroFits === true, `${key} 同心块没有顶穿舞台`, [m?.hero, m?.stageH]);
    ok(m?.plateFits === true && m?.titleFits === true, `${key} 称号没被裁`, [m?.plateH, m?.stageH]);
  }
  // 徽章：最多 3 枚、一律用小图（大图 1~2MB，绝不能进名单/预览）
  await apply({ frame: 'frame_bronze', title: 'title_rough', badges: ['badge_wave', 'badge_dragon', 'badge_abyss'] });
  const bm = await ev(`(function(){
    const imgs = [...document.querySelectorAll('.ws-plate-badges .p-badge')];
    return { count: imgs.length, srcs: imgs.map((i) => i.getAttribute('src') || ''),
      row: document.querySelectorAll('.ws-plate-badges .badge-row').length };
  })()`);
  ok(bm?.count === 3, '预览最多画 3 枚徽章', bm?.count);
  ok(bm?.srcs?.every((s) => s.includes('_sm.png')), '预览里用 96px 小图，不拉 1~2MB 大图', bm?.srcs);
  ok(bm?.row === 1, '徽章包在一层 .badge-row 里（间距/不换行统一管）', bm?.row);

  // 框 + 光效：三层都要能看见
  await apply({ frame: 'frame_bronze', fx: 'fx_warm', title: 'title_rough', badges: ['badge_wave', 'badge_dragon'] });
  await shotSide('stack_frame_fx.png');
  {
    const m = await metrics();
    ok(m?.fxOk === true, '珊瑚框+暖光：光效加载成功');
    ok(m?.plateFits === true && m?.titleFits === true, '珊瑚框+暖光：称号没被裁', [m?.plateH, m?.stageH]);
  }
  await apply({ frame: 'frame_gold', fx: 'fx_prism', title: 'title_rough', badges: ['badge_wave'] });
  await shotSide('stack_gold_prism.png');
  {
    const m = await metrics();
    ok(m?.fxOk === true, '金翼框+七彩：光效加载成功');
    ok(m?.heroFits === true, '金翼框+七彩：同心块没有顶穿舞台', [m?.hero, m?.stageH]);
    ok(m?.plateFits === true && m?.titleFits === true, '金翼框+七彩：称号没被裁', [m?.plateH, m?.stageH]);
  }
  // 只戴光效、不戴框
  await apply({ fx: 'fx_warm', title: 'title_rough' });
  await shotSide('stack_fx_only.png');

  const stat = await metrics();
  console.log('  尺寸:', JSON.stringify(stat));
  ok(stat?.avImgOk === true, '只戴光效时头像图片仍然正常（不是空白）', stat?.avImgSrc);
  ok(stat?.fxOk === true, '光效图片加载成功');
  ok(stat?.heroFits === false || stat?.heroFits === true, '尺寸可读');

  // 头像字段的三种来源都必须显示出来：内置 id / 自定义 dataURL / 已是图片路径
  // （以前直接把 id 丢进 <img src>，浏览器当相对地址 404，预览里就是一块空白）
  const CUSTOM = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const setAvatar = async (v) => {
    await ev(`(async function(){
      const m = await import(${JSON.stringify(modUrl)});
      m.walletPanel.getAvatar = () => ${JSON.stringify(v)};
      document.querySelectorAll('[data-ws-cat]')[0]?.click();
      return m.walletPanel.getAvatar();
    })()`);
    await sleep(320);
    return (await metrics())?.avImgSrc || '';
  };
  const byId = await setAvatar('shark');
  ok(byId === '/icons/avatars/av_shark.png', '内置头像 id 能翻译成图片地址', byId);
  const byData = await setAvatar(CUSTOM);
  ok(byData === CUSTOM, '自定义上传头像（dataURL）原样显示', byData.slice(0, 34));
  await shotSide('stack_custom_avatar.png');
  const byPath = await setAvatar('/icons/avatars/av_whale.png');
  ok(byPath === '/icons/avatars/av_whale.png', '已是图片路径时原样使用', byPath);

  ok(pageErrors.length === 0, '无页面异常', pageErrors.slice(0, 3));
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
}
if (failures) process.exitCode = 1;
