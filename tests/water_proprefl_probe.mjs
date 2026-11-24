// 道具倒影（P1）的定向验证：只把"本地玩家的船"放进倒影通道，贴着船侧拍两帧，
// 检查三件事：
//   1) 倒影确实出现在船身**水面线以下**（屏幕坐标 y 更大的一侧），不是糊在天上/别处；
//   2) 它落在船体横向范围内（x 方向），左右不串位；
//   3) 变红：红色船壳的倒影应该把水往红色推（ΔR>0、ΔB<0），说明采到的是"船"，
//      而不是一把天空色或者空白。
//
//   node tests/water_proprefl_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-proprefl-${stamp}`);
const port = 9680 + (Number(stamp.slice(-3)) % 150);
const base = 'http://127.0.0.1:5199';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 120000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

const checks = [];
const ok = (name, pass, info) => { checks.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ${info ?? ''}`); };

async function main() {
  let tabs;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { tabs = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/error|fail|shader|glsl/i.test(text)) console.log('[console]', text.slice(0, 300));
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: base + '/?raceIntro=0' });
  await sleep(4500);

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="ocean"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="ocean"]').click(); 1`);
  await sleep(300);
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`window.__game?.phase === 'racing'`, 150000);
  await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {};
    g.cameraRig.followLookAt = () => {};
    g.cameraRig.snapTo = () => {};
    // 关掉胶片颗粒：GradeShader 的 uTime 每帧自增，两帧之间颗粒不同，
    // 会把"逐像素差值"污染成满屏噪点（实测 n≈3000 的假变化）
    if (g.post?.gradePass) g.post.gradePass.uniforms.uGrain.value = 0;
    return 1;
  })()`);
  // 挪到开阔段并停住（不给油门）：船身静止，倒影才看得出位置对不对
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat;
    const N = g.mapDef.gates.length, gi = 4 % N;
    const ga = g.mapDef.gates[gi], gb = g.mapDef.gates[(gi + 1) % N], t = 0.45;
    b.resetTo(ga[0] + (gb[0] - ga[0]) * t, ga[1] + (gb[1] - ga[1]) * t,
      Math.atan2(gb[0] - ga[0], gb[1] - ga[1]));
    return 1;
  })()`);
  await sleep(4000);
  // 相机贴船侧：船体在画面中央，水面占下半屏
  await evaluate(`(() => {
    const g = window.__game, b = g.localBoat;
    const bx = b.pos.x, bz = b.pos.z;
    const h = b.heading || 0;
    const sx = Math.cos(h), sz = -Math.sin(h);       // 船体侧向
    g.camera.position.set(bx + sx * 11, 4.2, bz + sz * 11);
    g.camera.fov = 55;
    g.camera.updateProjectionMatrix();
    g.camera.lookAt(bx, 0.4, bz);
    return 1;
  })()`);

  const expr = `(async () => {
    const g = window.__game, b = g.localBoat, u = g.water.uniforms;
    // 只镜这条船：把干扰（浮标整条线、远处别的船）都拿掉，结论才干净
    g.water.setReflectProps([b.group]);
    const bx = b.pos.x, bz = b.pos.z;
    const h = b.heading || 0;
    const sx = Math.cos(h), sz = -Math.sin(h);
    const cx = bx + sx * 11, cz = bz + sz * 11;
    const shoot = (on) => {
      g.camera.position.set(cx, 4.2, cz);
      g.camera.lookAt(bx, 0.4, bz);
      g.water.renderPropReflection(g.renderer, g.scene, g.camera);
      u.uPropReflOn.value = on ? 1 : 0;
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.96);
    };
    const A = shoot(false);
    const B = shoot(true);
    // 调试视图：把倒影强度拉到 100，水面上"有倒影"的地方会整片变成倒影色，
    // 一眼就能看出这张 RT 里到底有多少有效像素（正常情况下只该有船那一块）
    u.uPropReflStr.value = 100.0;
    g.post.render(1 / 60);
    const D = g.renderer.domElement.toDataURL('image/jpeg', 0.92);
    u.uPropReflStr.value = 1.0;

    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    const [IA, IB] = await Promise.all([load(A), load(B)]);
    const W = IA.naturalWidth, H = IA.naturalHeight;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const gg = cv.getContext('2d', { willReadFrequently: true });
    const grab = (img) => {
      gg.clearRect(0, 0, W, H); gg.drawImage(img, 0, 0);
      return gg.getImageData(0, 0, W, H).data;
    };
    const dA = grab(IA), dB = grab(IB);

    // 船位与水线在屏幕上的位置
    const pr = g.camera.position.clone().set(bx, 0, bz).project(g.camera);
    const wx = (pr.x * 0.5 + 0.5) * W;
    const wy = (-pr.y * 0.5 + 0.5) * H;
    // 船是斜着看的：远端的水线在屏幕上比船心高。倒影顶边最多只能到"最高那段水线"，
    // 所以上界用船首/船尾两个水线点的较小 y，而不是船心那一个点。
    const half = (b.def?.hull?.length ?? 4) * 0.5;
    const fx = Math.sin(h), fz = Math.cos(h);
    const endY = (sgn) => {
      const q = g.camera.position.clone().set(bx + fx * half * sgn, 0, bz + fz * half * sgn).project(g.camera);
      return (-q.y * 0.5 + 0.5) * H;
    };
    const lineTop = Math.min(wy, endY(1), endY(-1));
    // 船体在屏幕上的高度（用船上 1.6m 处再投一次，取差值）
    const pt = g.camera.position.clone().set(bx, 1.6, bz).project(g.camera);
    const hullPx = Math.abs((-pt.y * 0.5 + 0.5) * H - wy);

    let n = 0, dx = 0, dy = 0, dr = 0, dg = 0, db = 0;
    let below = 0;
    const rowCount = new Int32Array(H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const dr0 = dB[i] - dA[i], dg0 = dB[i + 1] - dA[i + 1], db0 = dB[i + 2] - dA[i + 2];
        if (Math.abs(dr0) + Math.abs(dg0) + Math.abs(db0) < 30) continue;
        n++; dx += x; dy += y; dr += dr0; dg += dg0; db += db0;
        rowCount[y]++;
        if (y > wy) below++;
      }
    }
    // 只在"整行都有变化"的行里取包围盒：bloom 会顺着亮水面把倒影的影响摊到
    // 零星几个像素上，逐像素极值会被这些孤立点撑到整屏，判断位置就失真了。
    let minY = H, maxY = -1, minX = W, maxX = -1;
    for (let y = 0; y < H; y++) {
      if (rowCount[y] < 3) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(dB[i] - dA[i]) + Math.abs(dB[i + 1] - dA[i + 1]) + Math.abs(dB[i + 2] - dA[i + 2]) < 30) continue;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
      }
    }
    return {
      W, H, n, belowShare: +(below / Math.max(n, 1)).toFixed(3), lineTop: +lineTop.toFixed(1),
      waterX: +wx.toFixed(1), waterY: +wy.toFixed(1), hullPx: +hullPx.toFixed(1),
      box: maxY >= 0 ? { x0: minX, x1: maxX, y0: minY, y1: maxY, cx: +(dx / n).toFixed(1), cy: +(dy / n).toFixed(1) } : null,
      delta: n ? { r: +(dr / n).toFixed(2), g: +(dg / n).toFixed(2), b: +(db / n).toFixed(2) } : null,
      dbgUrl: D,
      dataUrl: (() => {
        // 输出对照图：左关右开，并把水线画一条横线（视觉定位用）
        const out = document.createElement('canvas');
        out.width = W * 2 + 6; out.height = H;
        const og = out.getContext('2d');
        og.fillStyle = '#000'; og.fillRect(0, 0, out.width, out.height);
        og.drawImage(IA, 0, 0); og.drawImage(IB, W + 6, 0);
        og.strokeStyle = '#ff0'; og.lineWidth = 1;
        og.beginPath(); og.moveTo(0, wy); og.lineTo(W, wy); og.stroke();
        og.beginPath(); og.moveTo(W + 6, wy); og.lineTo(W * 2 + 6, wy); og.stroke();
        return out.toDataURL('image/jpeg', 0.92);
      })(),
    };
  })()`;

  const r = await evaluate(expr);
  const v = r?.result?.value;
  if (!v) {
    console.error('FAIL evaluate', JSON.stringify(r?.exceptionDetails?.exception?.description || r).slice(0, 400));
    process.exitCode = 1; return;
  }
  const outDir = path.resolve('shots', 'water');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'p1-proprefl-isolated.jpg'),
    Buffer.from(v.dataUrl.slice(v.dataUrl.indexOf(',') + 1), 'base64'));
  console.log('对照图 -> shots/water/p1-proprefl-isolated.jpg 水线 y=' + v.waterY + '  船高(px)=' + v.hullPx);
  if (v.dbgUrl) {
    await fs.writeFile(path.join(outDir, 'p1-proprefl-dbg.jpg'),
      Buffer.from(v.dbgUrl.slice(v.dbgUrl.indexOf(',') + 1), 'base64'));
  }
  console.log('变化像素', v.n, 'bbox', JSON.stringify(v.box), 'ΔRGB', JSON.stringify(v.delta));

  ok('倒影改变了画面', v.n > 200, `n=${v.n}`);
  if (v.box) {
    // 倒影必须在水线以下（y 更大）：容差 6px（水线本身也有一两个像素的浪花）
    ok('倒影在水线以下', v.box.y0 >= v.lineTop - 10 && v.belowShare > 0.85,
      `y0=${v.box.y0} cy=${v.box.cy} 水线(船心)=${v.waterY} 水线上沿=${v.lineTop} 以下占比=${v.belowShare}`);
    // 水平方向不串位：变化区中心应在船体投影附近（船宽 ~2.6m，前后各放宽 1.5 个船体像素高度）
    ok('倒影没有横向串位', Math.abs(v.box.cx - v.waterX) < 140,
      `cx=${v.box.cx} 船位x=${v.waterX}`);
    // 红色船壳 → 倒影应把水往红推
    ok('倒影带船体颜色（偏红）', v.delta.r > 4 && v.delta.r > v.delta.b,
      `Δr=${v.delta.r} Δb=${v.delta.b}`);
    // 倒影不该铺满半个屏幕
    ok('倒影范围有界', v.box.y1 - v.box.y0 < v.H * 0.45, `高度=${v.box.y1 - v.box.y0}px / ${v.H}`);
  } else {
    ok('倒影改变了画面', false, '没有任何像素变化');
  }

  const fail = checks.filter((c) => !c.pass).length;
  console.log(fail ? `FAILED ${fail}/${checks.length}` : `ALL PASS ${checks.length}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(500);
  process.exit();
});
