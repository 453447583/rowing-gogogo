// 「浮桶倒影一直在闪」的量化探针。
//
// 现象：高画质（= 唯一开道具倒影的档位）下，赛道两侧那排浮桶在水里的倒影
// 会持续抖/闪。要区分"内容真的在动"和"采样在跳"，只能数像素：
//   · 机位钉死（不跟船、不震屏、颗粒关掉），船停住 → 画面里在动的只有
//     波浪/高光/随浪起伏的浮桶；
//   · 连续抓 N 帧，逐像素算帧间亮度差；
//   · 只统计「道具倒影真正覆盖」的像素（uPropReflStr 1 → 40 的差分建 mask，
//     这是唯一能准确圈出影响区的办法），并抠掉船身那块（船倒影又大又稳，
//     会把统计稀释掉）；
//   · 同时统计"同一水带里没有被倒影覆盖"的像素做**对照组**：那部分是纯水面
//     自身在动，用它归一化，才分得清"倒影在闪"还是"整片水都在动"。
//
// 变体：
//   on     当前实现（mip + 足迹偏置 + 4×MSAA + 水下裁剪）
//   lod0   强制 0 级采样（关掉足迹模糊）—— 验证这一步有没有用
//   on2    再测一次 on —— 验证指标本身可复现（不会被场景漂移带跑）
//   rt2x   倒影图 480×270 → 960×540 —— 验证"图太小被放大"
//   lift   整排浮桶抬高 1m（水下那截桶身不再进倒影）
//   off    关掉道具倒影（"没有这个特效"的地板线）
//
// 另附一张 6 帧连拍（放大 3 倍）：截图看不出闪烁，但连拍能看出边缘在爬。
//
//   node tests/buoy_refl_flicker_probe.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/buoy-flicker-${stamp}`);
const port = 9540 + (Number(stamp.slice(-3)) % 150);
const base = 'http://127.0.0.1:5199';

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 180000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (e) => cdp('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function waitFor(expr, timeout = 150000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) {
    last = val(await evaluate(expr));
    if (last) return last;
    await sleep(250);
  }
  throw new Error('timeout ' + expr + ' last=' + JSON.stringify(last));
}

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
      if (/error|shader|glsl|fail/i.test(text)) console.log('[console]', text.slice(0, 300));
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
  await waitFor(`window.__game?.phase === 'racing'`, 180000);

  // 机位钉死 + 关颗粒；船停在原处
  const r = await evaluate(`(() => {
    const g = window.__game;
    g.opts.onFinish = () => {}; g.opts.onQuit = () => {};
    g.cameraRig.follow = () => {};
    g.cameraRig.followLookAt = () => {};
    g.cameraRig.snapTo = () => {};
    if (g.post?.gradePass) g.post.gradePass.uniforms.uGrain.value = 0;
    const b = g.localBoat;
    // 固定到第 4 门之后的开阔段：每局船位随机，不钉住取景每次都变，没法对比
    const N = g.mapDef.gates.length, gi = 4 % N;
    const ga = g.mapDef.gates[gi], gb = g.mapDef.gates[(gi + 1) % N], t = 0.45;
    b.resetTo(ga[0] + (gb[0] - ga[0]) * t, ga[1] + (gb[1] - ga[1]) * t,
      Math.atan2(gb[0] - ga[0], gb[1] - ga[1]));
    b.speed = 0;
    const h = b.heading || 0;
    const fx = Math.sin(h), fz = Math.cos(h);
    g.camera.position.set(b.pos.x - fx * 10, 3.1, b.pos.z - fz * 10);
    g.camera.fov = 62;
    g.camera.updateProjectionMatrix();
    g.camera.lookAt(b.pos.x + fx * 26, 0.5, b.pos.z + fz * 26);
    return { quality: g.quality, buoys: g.track?.edgeBuoys?.count ?? 0, hasPr: !!g.water?.renderTarget };
  })()`);
  const info = val(r);
  console.log('环境:', JSON.stringify(info));
  if (!info?.buoys) throw new Error('这张图没有边缘浮桶，测不了');
  await sleep(1200);

  const expr = `(async () => {
    const g = window.__game, u = g.water.uniforms, gl = g.renderer.getContext();
    const pr = g.water.renderTarget || null;
    const body = g.track.edgeBuoys.body;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const N = 16;
    // 冻结水面时间（只让浮桶继续随浪起伏）：对照组=没被倒影覆盖的水面应该几乎
    // 不动，mask 区里的帧间差就只剩"浮桶倒影自己在跳"这一件事，指标才干净。
    g.water.update = () => {};
    // 把世界步长钉死成 1/60：否则一帧卡到 30fps，波浪/浮桶一次走两倍距离，
    // 帧间差跟着翻倍 —— 之前 on 与 on2 同一套配置能差一倍，就是被这个带跑的。
    g.clock.getDelta = () => 1 / 60;
    // 机位每帧强制写回同一个位姿：船在浪上还会上下浮，相机跟着动一点就是
    // 整帧位移，帧间差会被这种"全局平移"灌满，什么都测不出来。
    const camPos = g.camera.position.clone();
    const camQuat = g.camera.quaternion.clone();
    const camFov = g.camera.fov, camAspect = g.camera.aspect;
    const lockCam = () => {
      g.camera.position.copy(camPos);
      g.camera.quaternion.copy(camQuat);
      if (g.camera.fov !== camFov || g.camera.aspect !== camAspect) {
        g.camera.fov = camFov; g.camera.aspect = camAspect;
        g.camera.updateProjectionMatrix();
      }
      g.camera.updateMatrixWorld();
    };
    // 泛光会把浮桶本体（在 mask 外）的运动抹进倒影区，先关掉
    const bloom0 = g.post.bloomPass ? g.post.bloomPass.strength : null;
    if (g.post.bloomPass) g.post.bloomPass.strength = 0;
    const bufA = new Uint8Array(W * H * 4);
    const bufB = new Uint8Array(W * H * 4);
    const read = (dst) => { gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, dst); return dst; };
    const frame = () => new Promise((res) => requestAnimationFrame(() => res()));
    const draw = () => {
      lockCam();
      g.water.renderPropReflection(g.renderer, g.scene, g.camera);
      g.post.render(1 / 60);
    };
    const lum = (b, i) => (b[i] * 299 + b[i + 1] * 587 + b[i + 2] * 114) / 1000;
    const oldStr = u.uPropReflStr.value;

    // ---- 建 mask：倒影强度 1 → 40 的差分 ----
    draw(); read(bufA);
    u.uPropReflStr.value = 40;
    draw(); read(bufB);
    u.uPropReflStr.value = oldStr;

    const b = g.localBoat;
    const pc = g.camera.position.clone().set(b.pos.x, 0.2, b.pos.z).project(g.camera);
    const bx = (pc.x * 0.5 + 0.5) * W, by = (-pc.y * 0.5 + 0.5) * H;
    const mask = new Uint8Array(W * H);
    let masked = 0, y0 = H, y1 = -1, x0 = W, x1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(lum(bufB, i) - lum(bufA, i)) < 14) continue;
        if (Math.abs(x - bx) < 190 && y > by - 120) continue;
        mask[y * W + x] = 1; masked++;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
      }
    }
    // 对照组：同一条水带里没被倒影覆盖的像素（纯水面自身的动）
    const ctrl = new Uint8Array(W * H);
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (!mask[p]) ctrl[p] = 1;
      }
    }

    const measure = async (label) => {
      await frame(); await frame(); await frame();
      let s = 0, c = 0, spk = 0, s2 = 0, c2 = 0;
      draw(); read(bufA);
      for (let k = 0; k < N; k++) {
        await frame();
        draw(); read(bufB);
        for (let p = 0; p < W * H; p++) {
          if (!mask[p] && !ctrl[p]) continue;
          const i = p * 4;
          const d = Math.abs(lum(bufB, i) - lum(bufA, i));
          if (mask[p]) { s += d; c++; if (d > 20) spk++; }
          else { s2 += d; c2++; }
        }
        bufA.set(bufB);
      }
      const mad = s / Math.max(c, 1), madC = s2 / Math.max(c2, 1);
      return { label, mad: +mad.toFixed(3), ctrl: +madC.toFixed(3),
        rel: +(mad / Math.max(madC, 1e-6)).toFixed(2), speckle: +(spk / Math.max(c, 1)).toFixed(4) };
    };

    // 6 帧连拍（放大 2.5 倍），看边缘有没有在爬。
    // 取景对准"离镜头最近的边缘浮桶"：桶身和它的倒影同框，才是用户看的那块。
    const CW = 320, CH = 200;
    const cp = g.camera.position;
    let near = null, nd = 1e9, npj = null;
    for (const s of g.track.edgeBuoys.stations) {
      const d = Math.hypot(s.x - cp.x, s.z - cp.z);
      if (d < 6 || d > 14) continue;
      const q = g.camera.position.clone().set(s.x, 0.2, s.z).project(g.camera);
      if (Math.abs(q.x) > 0.7 || q.y > 0.2) continue;   // 只取画面中段、水面上的
      if (d < nd) { nd = d; near = s; npj = q; }
    }
    if (!near) { near = g.track.edgeBuoys.stations[0]; nd = -1; npj = { x: 0, y: 0 }; }
    const pj = npj;
    const bestX = Math.max(0, Math.min(W - CW, Math.round((pj.x * 0.5 + 0.5) * W - CW / 2)));
    const bestY = Math.max(0, Math.min(H - CH, Math.round((-pj.y * 0.5 + 0.5) * H - CH * 0.30)));
    const strip = async () => {
      const S = 2.5;
      const cv = document.createElement('canvas');
      cv.width = CW * S * 3; cv.height = CH * S * 2;
      const cg = cv.getContext('2d');
      cg.imageSmoothingEnabled = false;
      for (let k = 0; k < 6; k++) {
        await frame(); draw();
        const col = k % 3, row = (k / 3) | 0;
        cg.drawImage(g.renderer.domElement, bestX, bestY, CW, CH,
          col * CW * S, row * CH * S, CW * S, CH * S);
        cg.fillStyle = '#0ff'; cg.font = '20px sans-serif';
        cg.fillText(String(k), col * CW * S + 6, row * CH * S + 22);
      }
      return cv.toDataURL('image/jpeg', 0.92);
    };

    const out = [];
    u.uPropReflOn.value = 1;
    if ('uPropReflLod' in u) u.uPropReflLod.value = 1;
    out.push(await measure('on'));
    await frame(); draw();
    const fullUrl = g.renderer.domElement.toDataURL('image/jpeg', 0.92);
    const stripOn = await strip();

    let stripLod0 = null;
    if ('uPropReflLod' in u) {
      u.uPropReflLod.value = 0;
      out.push(await measure('lod0'));
      stripLod0 = await strip();
      u.uPropReflLod.value = 1;
      out.push(await measure('on2'));
    }

    if (pr) {
      const w0 = pr.width, h0 = pr.height;
      pr.setSize(960, 540);
      out.push(await measure('rt2x'));
      pr.setSize(w0, h0);
    }

    body.position.y = 1.0;
    out.push(await measure('lift'));
    body.position.y = 0;

    u.uPropReflOn.value = 0;
    out.push(await measure('off'));
    u.uPropReflOn.value = 1;
    if (bloom0 !== null) g.post.bloomPass.strength = bloom0;

    return { W, H, masked, bbox: [x0, y0, x1, y1], crop: [bestX, bestY],
      maskShare: +(masked / (W * H)).toFixed(4),
      buoys: body.count, pr: pr ? [pr.width, pr.height, pr.samples ?? 0, !!pr.texture.generateMipmaps] : null,
      drift: +(g.camera.position.distanceTo(g.camera.position)).toFixed(3),
      near: [+nd.toFixed(1), Math.round(pj.x*100)/100], out, fullUrl, stripOn, stripLod0 };
  })()`;

  const res = await evaluate(expr);
  const v = res?.result?.value;
  if (res?.exceptionDetails) {
    console.error('FAIL evaluate', JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails).slice(0, 800));
    process.exitCode = 1; return;
  }
  if (!v || !v.out) {
    console.error('FAIL evaluate', JSON.stringify(res).slice(0, 800));
    process.exitCode = 1; return;
  }
  const outDir = path.resolve('shots', 'water');
  await fs.mkdir(outDir, { recursive: true });
  const save = async (name, url) => {
    if (!url) return;
    await fs.writeFile(path.join(outDir, name), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    console.log('图 ->', path.join('shots/water', name));
  };
  await save('buoy-refl-full.jpg', v.fullUrl);
  await save('buoy-refl-strip-on.jpg', v.stripOn);
  await save('buoy-refl-strip-lod0.jpg', v.stripLod0);

  console.log(`画面 ${v.W}×${v.H}  浮桶 ${v.buoys} 只  倒影图 ${JSON.stringify(v.pr)}`);
  console.log(`最近浮桶 ${JSON.stringify(v.near)} m/ndc，取景 ${JSON.stringify(v.crop)}`);
  console.log(`倒影覆盖 ${v.masked} px（${(v.maskShare * 100).toFixed(2)}%） bbox ${JSON.stringify(v.bbox)}`);
  console.log('');
  console.log('变体     倒影区帧间差   同带水面(对照)   比值   差>20 像素占比');
  for (const o of v.out) {
    console.log(`${o.label.padEnd(8)} ${String(o.mad).padStart(10)} ${String(o.ctrl).padStart(14)} ${String(o.rel).padStart(8)} ${String(o.speckle).padStart(14)}`);
  }
  const on = v.out.find((o) => o.label === 'on');
  const off = v.out.find((o) => o.label === 'off');
  console.log('');
  if (on && off) console.log(`倒影自己贡献的闪烁：on=${on.mad}  off=${off.mad}  →  ${(on.mad - off.mad).toFixed(3)}`);
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(500);
  process.exit();
});
