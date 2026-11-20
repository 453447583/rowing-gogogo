// 深海龙宫水下实拍：把"水下模式"强行打开，用临时相机在几个固定机位渲染。
//
//   node tests/palace_uw_shot.mjs            # 用默认机位
//   CAMS="名字|x,y,z,tx,ty,tz;..." node tests/palace_uw_shot.mjs
//
// 为什么不能直接拿 game 相机拍：
//   uwK（水下程度）是由 **game.camera.position.y** 反推的，跑在水下段才有值；
//   而"跑进水下段"要十几秒游戏时间，无头软件光栅下要等几分钟。
//   所以这里直接调 env.setUnderwater(1)，再用 clone 出来的相机立刻 render 一次 —— 
//   不改游戏相机、不动主循环，一帧就能看清布景。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/palace-${stamp}`);
const port = 9680 + (Number(stamp.slice(-3)) % 100);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const outDir = path.resolve('shots/verify');
const mapId = process.env.MAP || 'palace';
// 水下等级：默认拉满拍水下；UW=0 拍水面视角（改布景后确认没把水上画面搞坏）
const uw = Number(process.env.UW ?? 1);

// 默认机位：大殿 / 遗迹 / 仰视水面
const DEFAULT_CAMS = [
  'atrium|118,-4,126,58,-3,145',
  'ruins|-150,-4,-8,-120,-5,-95',
  'lookup|90,-7,138,90,6,150',
];

const cams = (process.env.CAMS || DEFAULT_CAMS.join(';'))
  .split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, nums] = s.split('|');
    return { name, v: nums.split(',').map(Number) };
  });

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 60000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});

async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  });
  await cdp('Runtime.enable');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXC', m.params.exceptionDetails.exception?.description?.slice(0, 700)
        || m.params.exceptionDetails.text);
    }
    // 控制台报错也要打：光看未捕获异常会漏掉 warn/error，而"对局起不来"
    // 很多时候是某个模块在 catch 里把错误吞了。
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      const txt = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      console.log(`CONSOLE.${m.params.type}`, String(txt).slice(0, 500));
    }
  });
  // 重载一次：这样上面的 exceptionThrown 监听能抓到**模块加载期**的错误。
  // （连上再监听时，页面往往已经跑完了，加载期异常会被完全漏掉 —— 表现就是
  //  "某个按钮点了没反应"，却一条报错都看不到。）
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1200);

  const t0 = Date.now();
  // 必须等 main.js 整个模块图执行完（用 __audio 当哨兵）：
  // #btn-solo 是静态标签，页面一解析就存在，抢在它挂上 onclick 之前点等于没点。
  while (Date.now() - t0 < 40000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  // 大厅改版后：单人 → 大厅 → 抽屉里选图 → 发车。
  // 选图卡片是 .lp-card[data-map]，不是选艇屏的 .map-card。
  await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
  const tPick = Date.now();
  while (Date.now() - tPick < 15000) {
    if ((await evaluate('!!document.querySelector(".lp-card[data-map]")')).result?.value) break;
    await sleep(200);
  }
  const picked = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.lp-card[data-map]')];
    const c = cards.find(x => x.dataset.map === ${JSON.stringify(mapId)});
    if (!c) return 'missing:' + cards.map(x => x.dataset.map).join(',');
    c.click(); return 'ok';
  })()`);
  if (picked.result?.value !== 'ok') throw new Error(`地图 ${mapId} 选不到：${picked.result?.value}`);
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');

  const t2 = Date.now();
  let ok = false;
  while (Date.now() - t2 < 45000) {
    if ((await evaluate('!!window.__game && !!window.__game.env')).result?.value) { ok = true; break; }
    await sleep(400);
  }
  if (!ok) throw new Error('对局没起来');

  // 等异步 GLB（龙宫主体 / 道具 / 航标）落地，否则拍到的宫殿是缺的
  await sleep(Number(process.env.WARM || 22000));

  const stat = await evaluate(`(() => {
    const g = window.__game;
    g.env.setUnderwater(1);
    const grp = g.env.group;
    let meshes = 0, inst = 0;
    grp.traverse((o) => { if (o.isMesh) { meshes++; if (o.isInstancedMesh) inst++; } });
    return {
      meshes, inst,
      fish: g.env.fishGroup ? g.env.fishGroup.children.length : -1,
      hasPalace: !!g.env.palaceAtrium,
      uw: g.env.uwK,
    };
  })()`);
  console.log('scene:', JSON.stringify(stat.result?.value));

  // DIAG：临时诊断片段（返回可序列化的值就会打印出来），排查"这块多边形是什么"用
  if (process.env.DIAG) {
    const r = await evaluate(process.env.DIAG);
    console.log('diag:', JSON.stringify(r.result?.value ?? r.exceptionDetails?.exception?.description));
  }

  for (const { name, v } of cams) {
    if (v.length !== 6 || v.some((n) => !Number.isFinite(n))) { console.log('bad cam', name); continue; }
    const r = await evaluate(`(() => {
      const g = window.__game;
      const UW = ${uw};
      g.env.setUnderwater(UW);
      // PRE：渲染前要跑的调试片段（A/B 用，例如隐藏某组布景看它是不是元凶）
      ${process.env.PRE || ''}
      // 后处理也要拉满：水下蓝调靠 GradeShader 的逐通道吸收，直接 renderer.render
      // 会把这一层完全跳过（拍到的是"没下水"的原始色）。
      g.post?.setUnderwater?.(UW);
      if (g.post?.gradePass) g.post.gradePass.uniforms.uUnderwater.value = UW;
      const cam = g.camera.clone();
      cam.position.set(${v[0]}, ${v[1]}, ${v[2]});
      cam.lookAt(${v[3]}, ${v[4]}, ${v[5]});
      cam.fov = Number(g.camera.fov) || 62;
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      // 合成器的 RenderPass 抓的是构造时那个相机实例，必须临时换掉才能换个机位出图
      const rp = g.post?.composer?.passes?.find((p) => p.camera);
      if (rp) {
        const old = rp.camera;
        rp.camera = cam;
        g.post.render(0.016);
        rp.camera = old;
      } else {
        g.renderer.render(g.scene, cam);
      }
      return g.renderer.domElement.toDataURL('image/jpeg', 0.86);
    })()`);
    const data = r.result?.value;
    if (typeof data !== 'string' || !data.startsWith('data:')) {
      console.log(`${name} EXC:`, r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || data);
      continue;
    }
    await fs.mkdir(outDir, { recursive: true });
    const p = path.join(outDir, `palace-uw${uw > 0.5 ? '' : '0'}-${name}.jpg`);
    await fs.writeFile(p, Buffer.from(data.split(',')[1], 'base64'));
    console.log('saved', p);
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  // 不要 process.exit()：Windows 上它会把还没 flush 的 stdout 直接截掉，
  // 表现是"脚本跑完了一点输出都没有"，排查时非常误导。
});
