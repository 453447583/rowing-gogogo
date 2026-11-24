// P1 水面的"同帧 A/B"探针：把某一项 P1 特性开/关各渲一帧，逐像素比色差。
//
//   node tests/water_p1_ab.mjs absorb          # 三分量吸收
//   node tests/water_p1_ab.mjs mid             # 5~15m 中频波列
//   node tests/water_p1_ab.mjs reflblur        # 反射距离分层模糊 / 掠射拉伸
//   node tests/water_p1_ab.mjs proprefl        # 艇/浮标倒影
//
//   MAP=ocean WEATHER=dusk POSE=chase node tests/water_p1_ab.mjs mid
//
// 为什么要"同帧"：水面有 uTime，两次 HTTP 截图之间浪已经走了几米，逐像素比色差
// 全是噪声。这里在同一个 Runtime.evaluate 里改 uniform → 渲染 → 读回，
// uTime / 相机 / 船位完全一致，差值只剩这一项本身。
//
// 输出：shots/water/p1-<knob>-<pose>.jpg（左=关 右=开）+ 三个距离带的平均色与 ΔE。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const KNOB = process.argv[2] || 'absorb';
const MAP = process.env.MAP || 'ocean';
const WEATHER = process.env.WEATHER || '';
const POSE = process.env.POSE || (KNOB === 'proprefl' ? 'chase' : 'mid');
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-p1ab-${stamp}`);
const port = 9540 + (Number(stamp.slice(-3)) % 200);
const url = 'http://127.0.0.1:5199/?raceIntro=0';

// 每个开关：uniform 名 / 开 / 关
const KNOBS = {
  absorb: { u: 'uAbsorbHue', on: 0.85, off: 0.0 },
  mid: { u: 'uMidWave', on: 1.0, off: 0.0 },
  reflblur: { u: 'uReflBlur', on: 1.0, off: 0.0 },
  proprefl: { u: 'uPropReflOn', on: 1.0, off: 0.0 },
  // 三项一起开关：验证"整套 P1 对水色的总影响"（天气逐项回归用这项）
  all: { u: '__all', on: 1.0, off: 0.0 },
};
let knob = KNOBS[KNOB];
// ON=0.55：临时试别的档位（调参时用），不写死进脚本
if (process.env.ON) knob = { ...knob, on: Number(process.env.ON) };
if (!knob) {
  console.error('未知开关', KNOB, '可选：', Object.keys(KNOBS).join(' / '));
  process.exit(1);
}

const POSES = {
  mid: { fwd: 16, side: 0, up: 11, pitch: 14, fov: 62 },
  low: { fwd: 7, side: 6, up: 2.6, pitch: 9, fov: 70 },
  top: { fwd: 0, side: 14, up: 30, pitch: 62, fov: 60 },
  chase: { fwd: -15, side: 0, up: 4.6, pitch: 11, fov: 64, reset: true },
  // 贴近船侧的机位：专门看船体/浮标在水里的倒影（aim:'boat' = 直接看向船位）
  hull: { fwd: 2, side: 9, up: 3.2, pitch: 0, fov: 55, reset: true, aim: 'boat' },
};
const pose = POSES[POSE];

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
      if (/error|fail|shader|glsl/i.test(text)) console.log('[console]', text.slice(0, 400));
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url });
  await sleep(4500);

  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 90000);
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 60000);
  await evaluate(`document.querySelector('#btn-lobby-map').click(); 1`);
  await waitFor(`!!document.querySelector('.lp-card[data-map="${MAP}"]')`, 60000);
  await evaluate(`document.querySelector('.lp-card[data-map="${MAP}"]').click(); 1`);
  await sleep(400);
  if (WEATHER) {
    await evaluate(`document.querySelector('#btn-lobby-weather').click(); 1`);
    await waitFor(`!!document.querySelector('[data-weather="${WEATHER}"]')`, 30000);
    await evaluate(`document.querySelector('[data-weather="${WEATHER}"]').click(); 1`);
    await sleep(300);
  }
  await evaluate(`(() => { const s = document.querySelector('#sel-ai'); if (s) { s.value = '0'; s.dispatchEvent(new Event('change', { bubbles: true })); } return 1; })()`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await waitFor(`!!window.__game?.localBoat`, 150000);
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
    const inp = g.opts?.input;
    if (inp) { inp.clear = () => {}; inp.keys.add('w'); inp.keys.add('arrowup'); }
    return 1;
  })()`);
  await sleep(9000);

  if (pose.reset) {
    await evaluate(`(() => {
      const g = window.__game, b = g.localBoat;
      const N = g.mapDef.gates.length, gi = 4 % N;
      const ga = g.mapDef.gates[gi], gb = g.mapDef.gates[(gi + 1) % N], t = 0.38;
      b.resetTo(ga[0] + (gb[0] - ga[0]) * t, ga[1] + (gb[1] - ga[1]) * t,
        Math.atan2(gb[0] - ga[0], gb[1] - ga[1]));
      return 1;
    })()`);
    await sleep(6000);
  }

  const expr = `(async () => {
    const g = window.__game;
    const b = g.localBoat;
    const fx0 = b.forward?.x ?? b.dir?.x ?? 0;
    const fz0 = b.forward?.z ?? b.dir?.z ?? 1;
    const L = Math.hypot(fx0, fz0) || 1;
    const ux = fx0 / L, uz = fz0 / L;
    const nx = -uz, nz = ux;
    const bx = b.pos?.x ?? b.position.x, bz = b.pos?.z ?? b.position.z;
    const cx = bx + ux * ${pose.fwd} + nx * ${pose.side};
    const cz = bz + uz * ${pose.fwd} + nz * ${pose.side};
    const pitch = ${pose.pitch} * Math.PI / 180;
    const reach = 26;
    let tx = cx + ux * reach * Math.cos(pitch);
    let tz = cz + uz * reach * Math.cos(pitch);
    let ty = Math.max(0.2, ${pose.up} - reach * Math.sin(pitch));
    ${pose.aim === 'boat' ? `tx = bx + ux * 1.5; tz = bz + uz * 1.5; ty = 0.6;` : ''}
    g.camera.position.set(cx, ${pose.up}, cz);
    g.camera.fov = ${pose.fov};
    g.camera.updateProjectionMatrix();
    g.camera.lookAt(tx, ty, tz);
    await new Promise((r) => requestAnimationFrame(r));
    // 冻住浪与相机：两次渲染之间不能有任何 rAF 进来改 uTime
    const u = g.water.uniforms;
    const isAll = '${knob.u}' === '__all';
    // 用"当前天气实际生效的档位"作为开态，而不是写死 0.55 ——
    // 星空档自己收到 0.25，写死会把它盖回白天档
    const hueOn = u.uAbsorbHue.value;
    const apply = (v) => {
      if (isAll) {
        u.uAbsorbHue.value = v * hueOn;
        u.uMidWave.value = v;
        u.uReflBlur.value = v;
      } else {
        u['${knob.u}'].value = v;
      }
    };
    const shoot = (v) => {
      g.camera.position.set(cx, ${pose.up}, cz);
      g.camera.lookAt(tx, ty, tz);
      // 道具倒影必须先按当前机位重渲一次（它会把 uPropReflOn 写回 1），
      // 所以开关值要在这次 pass 之后再写，否则"关"的那一帧又被打开
      g.water.renderPropReflection?.(g.renderer, g.scene, g.camera);
      apply(v);
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.94);
    };
    const A = shoot(${knob.off});
    const B = shoot(${knob.on});
    apply(${knob.on});

    const load = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    const [IA, IB] = await Promise.all([load(A), load(B)]);
    const W = IA.naturalWidth, H = IA.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W * 2 + 6; cv.height = H;
    const cx2 = cv.getContext('2d');
    cx2.fillStyle = '#000'; cx2.fillRect(0, 0, cv.width, cv.height);
    cx2.drawImage(IA, 0, 0);
    cx2.drawImage(IB, W + 6, 0);

    // 水面分带取样：近距离（画面下沿）、中景、远景（贴近天际线）
    const bands = [
      { name: 'near', y0: 0.80, y1: 0.97 },
      { name: 'mid', y0: 0.62, y1: 0.78 },
      { name: 'far', y0: 0.44, y1: 0.56 },
    ];
    const grab = (img) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const gg = c.getContext('2d', { willReadFrequently: true });
      gg.drawImage(img, 0, 0);
      return gg;
    };
    const gA = grab(IA), gB = grab(IB);
    const srgb = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    const out = [];
    for (const bd of bands) {
      const y = Math.round(H * bd.y0);
      const h = Math.round(H * (bd.y1 - bd.y0));
      // 左右各留 8%：避开边缘的岩石/船体
      const x = Math.round(W * 0.10);
      const w = Math.round(W * 0.80);
      const dA = gA.getImageData(x, y, w, h).data;
      const dB = gB.getImageData(x, y, w, h).data;
      let ar = 0, ag = 0, ab = 0, br = 0, bg = 0, bb = 0, n = 0;
      let maxd = 0;
      for (let i = 0; i < dA.length; i += 4) {
        ar += dA[i]; ag += dA[i + 1]; ab += dA[i + 2];
        br += dB[i]; bg += dB[i + 1]; bb += dB[i + 2];
        for (let k = 0; k < 3; k++) maxd = Math.max(maxd, Math.abs(dA[i + k] - dB[i + k]));
        n++;
      }
      // 梯度能量（平均 |∇亮度|）：肉眼"有没有波纹"比平均色更能说明问题。
      // 同一个 ROI 里 on/off 各算一次，纹理是变多还是被抹平一眼就能读出来。
      const gradOf = (d) => {
        const L = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        let sum = 0, cnt = 0;
        for (let yy = 0; yy < h - 1; yy++) {
          for (let xx = 0; xx < w - 1; xx++) {
            const i = (yy * w + xx) * 4;
            sum += Math.hypot(Math.abs(L(i + 4) - L(i)), Math.abs(L(i + w * 4) - L(i)));
            cnt++;
          }
        }
        return sum / Math.max(cnt, 1);
      };
      ar /= n; ag /= n; ab /= n; br /= n; bg /= n; bb /= n;
      // CIE76 ΔE（sRGB → Lab 近似）：ΔE<1 基本看不出，<2.3 是"肉眼临界"
      const lab = (r, g_, b_) => {
        const R = srgb(r / 255), G = srgb(g_ / 255), B = srgb(b_ / 255);
        let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
        let Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
        let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
        const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        X = f(X); Y = f(Y); Z = f(Z);
        return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
      };
      const lA = lab(ar, ag, ab), lB = lab(br, bg, bb);
      const dE = Math.hypot(lA[0] - lB[0], lA[1] - lB[1], lA[2] - lB[2]);
      out.push({
        band: bd.name,
        off: [ar, ag, ab].map((v) => +v.toFixed(1)),
        on: [br, bg, bb].map((v) => +v.toFixed(1)),
        dRGB: [br - ar, bg - ag, bb - ab].map((v) => +v.toFixed(1)),
        dE: +dE.toFixed(2),
        maxPixelDelta: maxd,
        grad: [+gradOf(dA).toFixed(2), +gradOf(dB).toFixed(2)],
      });
    }
    // 变化区域包围盒 + 放大裁剪：倒影这类"只改几百个像素"的改动，
    // 缩略图上看不出来，必须 2× 放大到 boat 附近才判得出位置/朝向对不对
    const dAll = gA.getImageData(0, 0, W, H);
    const dBAll = gB.getImageData(0, 0, W, H);
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(dAll.data[i] - dBAll.data[i])  > 24
          || Math.abs(dAll.data[i + 1] - dBAll.data[i + 1]) > 24
          || Math.abs(dAll.data[i + 2] - dBAll.data[i + 2]) > 24) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    let zoomUrl = null, box = null;
    if (x1 > x0 && y1 > y0) {
      const pad = 40;
      const bx = Math.max(0, x0 - pad), by = Math.max(0, y0 - pad);
      const bw = Math.min(W - bx, x1 - x0 + pad * 2), bh = Math.min(H - by, y1 - y0 + pad * 2);
      box = { x: bx, y: by, w: bw, h: bh };
      const z = document.createElement('canvas');
      z.width = Math.round(bw * 2) * 2 + 8; z.height = Math.round(bh * 2);
      const zg = z.getContext('2d');
      zg.imageSmoothingEnabled = false;
      zg.fillStyle = '#000'; zg.fillRect(0, 0, z.width, z.height);
      zg.drawImage(IA, bx, by, bw, bh, 0, 0, Math.round(bw * 2), Math.round(bh * 2));
      zg.drawImage(IB, bx, by, bw, bh, Math.round(bw * 2) + 8, 0, Math.round(bw * 2), Math.round(bh * 2));
      zoomUrl = z.toDataURL('image/png');
    }
    return { dataUrl: cv.toDataURL('image/jpeg', 0.92), W, H, bands: out, zoomUrl, box };
  })()`;

  const r = await evaluate(expr);
  const v = r?.result?.value;
  if (!v?.dataUrl) {
    console.error('FAIL', JSON.stringify(r?.exceptionDetails?.exception?.description || r).slice(0, 400));
    return;
  }
  const outDir = path.resolve('shots', 'water');
  await fs.mkdir(outDir, { recursive: true });
  const f = path.join(outDir, `p1-${KNOB}-${POSE}${WEATHER ? '-' + WEATHER : ''}.jpg`);
  await fs.writeFile(f, Buffer.from(v.dataUrl.slice(v.dataUrl.indexOf(',') + 1), 'base64'));
  console.log(`拼图 -> ${path.basename(f)}  ${v.W}x${v.H}  左=关(${knob.u}=${knob.off}) 右=开(${knob.on})`);
  for (const b of v.bands) {
    console.log(`  ${b.band.padEnd(4)} off=${b.off.join(',')} on=${b.on.join(',')}  ΔRGB=${b.dRGB.join(',')}  ΔE=${b.dE}  maxΔ=${b.maxPixelDelta}  梯度 ${b.grad[0]}→${b.grad[1]} (×${(b.grad[1] / Math.max(b.grad[0], 1e-6)).toFixed(2)})`);
  }
  if (v.zoomUrl) {
    const zf = path.join(outDir, `p1-${KNOB}-${POSE}${WEATHER ? '-' + WEATHER : ''}-zoom.png`);
    await fs.writeFile(zf, Buffer.from(v.zoomUrl.slice(v.zoomUrl.indexOf(',') + 1), 'base64'));
    console.log(`放大 -> ${path.basename(zf)}  变化区 ${JSON.stringify(v.box)}`);
  }
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(500);
  process.exit();
});
