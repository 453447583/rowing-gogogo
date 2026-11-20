// 巨鲸鲨泡泡的「观感」出图（不是断言，只看效果）。
//
//   node tests/whale_bubble_look.mjs
//
// 为什么单独一支脚本：
//   `whale_bubble_probe.mjs` 为了跑得动会先把渲染器压到 320×200，抓图时再 setSize 放大，
//   而**运行中改变渲染器尺寸会让 Effekseer 重传贴图并抛 texImage2D 异常**（已实测）。
//   出图脚本改成启动时就把窗口定成 900×520，全程不 resize，画面干净、也没有假异常。
//
// 做法：进终焉关 → 压血召唤巨鲸鲨 → 逼它吐一串泡泡 → 把泡泡"定格"到镜头前 7m / 18m，
// 让它停在画面中央，用来看清膜的边缘、蓝色和高光点。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/whale-look-' + Date.now());
const port = 9500 + Math.floor(Math.random() * 90);
const httpPort = 5270 + Math.floor(Math.random() * 60);
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
// 窗口定成 600×340：软件渲染下 900×520 的 Page.captureScreenshot 会直接超时
// （swiftshader 的读回太慢），这个尺寸单张能稳定抓下来。
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=600,340',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { throw new Error(m); };
let ws;

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await wait(200);
  }
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'))
    || tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
      return;
    }
    // 页面里的 console.warn（比如「[minion] 追加动作加载失败」）默认收不到，
    // 缺动作时只表现为"施法动作不播"，不显式抓一遍就只能瞎猜。
    if (m.method === 'Runtime.consoleAPICalled' && /warning|error/.test(m.params.type)) {
      const t = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/minion|monster|glb|fx|effect/i.test(t)) console.log('   [page]', t.slice(0, 200));
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const bail = (why) => {
    for (const [, q] of pending) q.rej(new Error(why));
    pending.clear();
  };
  ws.on('close', () => bail('CDP 连接已关闭'));
  ws.on('error', () => bail('CDP 连接出错'));
  const cdp = (method, params = {}, timeout = 90000) => {
    const id = ++seq;
    try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { return Promise.reject(e); }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        rej(new Error(`CDP 超时 ${timeout}ms: ${method}`));
      }, timeout);
      pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
    });
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    }, 90000);
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 60000, label = expr) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await ev(expr)) return true;
      await wait(400);
    }
    throw new Error('timeout waiting for ' + label);
  };
  const shot = async (file) => {
    const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 }, 120000);
    await fs.mkdir('shots/verify', { recursive: true });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
    console.log('   · 出图', file);
  };

  // ---------- 进终焉关 ----------
  // 无头冷启动偶尔会"卡在启动"：按钮的 onclick 是资源预热之后才挂上的，
  // 这一等有时直接超过一分钟（本轮遇到过），所以允许重载重试。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 45000, '菜单启动');
      break;
    } catch (e) {
      if (attempt === 2) throw e;
      console.log('   启动超时，重载页面重试', attempt + 1);
      await cdp('Page.reload', {});
      await wait(3000);
    }
  }
  for (let i = 0; i < 4; i++) {
    await ev('document.querySelector("#btn-solo").click()');
    await wait(800);
    if (await ev(`!document.querySelector('#lobby').classList.contains('hidden')`)) break;
    await wait(2000);
  }
  await waitFor(`!document.querySelector('#lobby').classList.contains('hidden')`, 90000, '进入大厅');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector(".lp-pill[data-mode=\\"boss\\"]")', 30000, '模式抽屉');
  await ev('document.querySelector(".lp-pill[data-mode=\\"boss\\"]").click()');
  await wait(700);
  await ev('document.querySelector("#btn-lobby-pick-close")?.click()');
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.bossMode', 90000, '进入怪物模式');
  await ev('window.__game.bossMode.introT = 99');
  await waitFor('window.__game.bossMode.phase === "countdown"', 90000, '第一关倒计时');
  await ev('window.__game.bossMode.startStage(4)');
  await wait(1500);
  await ev('window.__game.bossMode.introT = 99');
  await waitFor('window.__game.bossMode.phase === "countdown"', 90000, '第四关倒计时');
  await ev('window.__game.bossMode.countdown = 0.02');
  await waitFor('window.__game.bossMode.phase === "fight"', 60000, '第四关开打');

  // BOSS 闭嘴：这一轮只看泡泡，满屏技能会把软件渲染拖死
  await ev('window.__game.bossMode.boss.cooldownScale = 999');
  await ev('window.__game.bossMode.boss.hp = window.__game.bossMode.boss.hpMax * 0.74');
  await waitFor('window.__game.bossMode.minions.some(m => m.def.id === "whale_shark")', 60000, '召唤巨鲸鲨');
  // 这里不等 castAction：骨架动画是异步合进来的，偶尔会卡很久（本轮遇到过两次），
  // 而吐泡泡的 AI 分支在没挂动作时会退回 m.swing 的"摆尾"假动作，照样吐泡。
  // 出图只关心泡泡长什么样，所以给它最多 25s，等不到就直接往下走。
  const rigReady = await waitFor(
    'window.__game.bossMode.minions.some(m => m.def.id === "whale_shark" && m.castAction)',
    25000, '鲸鱼骨架就绪',
  ).catch(() => false);
  console.log('   鲸鱼骨骼动作：', rigReady ? 'whale_shark_spit 已挂载' : '未就绪（用摆尾假动作吐泡，不影响出图）');

  // 船摆到鲸鱼正前方 14m（在 bubbleRange 26m 内），催它吐泡泡
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    const w = b.minions.find(m => m.def.id === 'whale_shark' && m.alive);
    me.boat.pos.x = w.pos.x + 14; me.boat.pos.z = w.pos.z;
    me.boat.vel && me.boat.vel.set(0, 0, 0);
    me.invuln = 999;   // 出图期间别被糊掉，留两颗泡泡在画面里
    w.castCd = 0;
    return 1;
  })()`);
  await waitFor('window.__game.bossMode.arcs.some(a => a.type === "bubble")', 60000, '吐泡泡');
  await wait(1200);

  // 定格：把泡泡停在镜头正前方（速度清零 + 位置按相机朝向重算），
  // 这样它不会在两帧之间飞走，能看清膜边缘和高光。
  // 顺便把每颗泡泡投影到 NDC 报出来——出图时"看不见泡泡"十次有九次是它跑到画面外了。
  const parked = await ev(`(function(){
    const b = window.__game.bossMode;
    const cam = window.__game.camera;
    cam.updateMatrixWorld(true);
    const e = cam.matrixWorld.elements;
    // 相机朝向 = -Z 轴
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const bs = b.arcs.filter(a => a.type === 'bubble');
    const dists = [6, 11];
    bs.forEach((a, i) => {
      if (i > 1) { a.mesh.visible = false; return; }   // 多出来的泡泡会重叠成一坨，藏掉
      const d = dists[i % dists.length];
      a.speed = 0; a.turn = 0;
      a.life = 9999; a.age = 0; a.wobble = 0;
      // 左右错开，两颗并排更好比较远近的尺寸差
      const sx = (i === 0 ? -1 : 1) * d * 0.22;
      a.pos.set(cam.position.x + fx * d + sx, cam.position.y + fy * d - 0.5, cam.position.z + fz * d);
      a.baseY = a.pos.y;
      a.mesh.position.copy(a.pos);
      a.mesh.scale.setScalar(a.r);
    });
    const m = b.bubbleMat;
    return JSON.stringify({
      n: bs.length,
      cam: [cam.position.x, cam.position.y, cam.position.z].map(v => +v.toFixed(1)),
      mat: m ? {
        blending: m.blending, side: m.side, transparent: m.transparent,
        tint: m.uniforms.uTint.value.getHexString(),
        hasHi: /uHi/.test(m.fragmentShader),
      } : null,
      ndc: bs.map((a) => {
        const v = a.mesh.position.clone().project(cam);
        return [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
      }),
    });
  })()`);
  console.log('   定格泡泡：', parked);
  if (!JSON.parse(parked).n) fail('没有泡泡可以定格');
  // 开始出图：先把 HUD 收起来，否则血条 / 技能圈会盖住画面正中
  await ev(`(function(){
    const root = document.getElementById('ui-root');
    if (root) root.style.display = 'none';
    document.querySelectorAll('.hud, #hud, #boss-hud').forEach((n) => { n.style.display = 'none'; });
    return 1;
  })()`);
  await wait(800);
  await shot('shots/verify/whale-bubble-close.jpg');

  // 稍微侧一点再看一次：换个背景（水面 / 冰岩）判断会不会被背景吞掉
  await ev(`(function(){
    const b = window.__game.bossMode;
    const me = b.players.get(b.myId);
    me.boat.heading += 0.9;
    return 1;
  })()`);
  await wait(1400);
  await shot('shots/verify/whale-bubble-side.jpg');
  console.log('PASS: 出图完成');
} finally {
  try { ws?.terminate(); } catch {}
  // 只 kill 启动进程会留下一堆孤儿渲染进程：本轮攒到 97 个 msedge，
  // 直接把 CPU 占满，后面的运行全在"启动超时 / 抓图超时"里打转。
  // 用 taskkill /T 连子树一起收。
  for (const p of [child, server]) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', String(p.pid)], { windowsHide: true }); } catch {}
  }
  await wait(600);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
