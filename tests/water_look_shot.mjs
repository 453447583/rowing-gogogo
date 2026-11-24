// 水面观感取景：在开阔水面上摆几个和参考图（写实海面）接近的机位。
//
//   node tests/water_look_shot.mjs             # 默认 ocean / day
//   MAP=ocean WEATHER=storm node tests/water_look_shot.mjs
//
// 机位：
//   mid  11m 高、俯角约 14° —— 和参考图的船尾俯视角最接近
//   low  2.6m 高、几乎贴水 —— 看近处细节波纹有没有"溶掉"
//   top  30m 高俯视        —— 看波纹尺度、有没有成片白斑
// 出图：shots/water/<map>-<weather>-<pose>.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/water-look-${stamp}`);
const port = 9241 + (Number(stamp.slice(-3)) % 200);
const url = (process.env.WB_URL || 'http://127.0.0.1:5199/') + '?raceIntro=0';
const MAP = process.env.MAP || 'ocean';
const WEATHER = process.env.WEATHER || '';
const outDir = path.resolve('shots', 'water');

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${process.env.WB_WIN || '1280,760'}`, 'about:blank'], { stdio: 'ignore' });

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

/** 相对船位的机位：fwd 沿船头前向（米）、side 侧向、up 高度、pitch 俯角（度）
 *  towardSun=true 时朝向改用太阳水平方向（黄昏才看得见金光路） */
const POSES = [
  { name: 'mid', fwd: 16, side: 0, up: 11, pitch: 14, fov: 62 },
  { name: 'low', fwd: 7, side: 6, up: 2.6, pitch: 9, fov: 70 },
  { name: 'top', fwd: 0, side: 14, up: 30, pitch: 62, fov: 60 },
  { name: 'sun', fwd: 0, side: 0, up: 4.2, pitch: 5, fov: 66, towardSun: true },
  // 追尾：相机在船后，看尾迹与船首浪（P0 泡沫那一档的验收机位）
  // reset: 起点附近礁石密，船会卡住 → 拍之前先挪到第 4~5 门之间的开阔段
  { name: 'chase', fwd: -15, side: 0, up: 4.6, pitch: 11, fov: 64, reset: true },
];

async function main() {
  let tabs;
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); if (r.ok) { tabs = await r.json(); break; } } catch { /* */ }
    await sleep(150);
  }
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
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
  // 无头窗真实视口只有窗口高度减浏览器 UI：不 override 就不是 720p
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
    return 1;
  })()`);
  await sleep(500);
  // 船得动起来才有尾迹和船首浪，否则对比会失真。
  // 注意：无头页没有焦点，Input 会在 blur 时 clear() 掉按键，
  // 所以先把 clear 换成空实现，再塞 'w'（键名是 e.key 小写）。
  await evaluate(`(() => {
    const g = window.__game;
    // Input 实例挂在 opts 上（main.js 里 new 完传给 Game），不是 g.input
    const inp = g.opts?.input;
    if (inp) {
      inp.clear = () => {};
      inp.keys.add('w');
      inp.keys.add('arrowup');
    }
    return 1;
  })()`);
  await sleep(9000);
  const run = val(await evaluate(`(() => {
    const g = window.__game, b = g.localBoat, u = g.water.uniforms;
    return {
      phase: g.phase, countdown: g.countdownLeft, throttle: g.opts?.input?.throttle,
      keys: [...(g.opts?.input?.keys || [])], bind: g.opts?.input?.bindings?.throttle,
      speed: +(b.speed ?? 0).toFixed(1), trailSegs: u.uTrailSegs.value,
      bow: +u.uBowFoam.value.x.toFixed(2),
    };
  })()`));
  console.log('船况', JSON.stringify(run));

  await fs.mkdir(outDir, { recursive: true });
  for (const p of POSES) {
    if (p.reset) {
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
      let fx, fz;
      if (${p.towardSun ? 'true' : 'false'}) {
        const sd = g.water.uniforms.uSunDir.value;
        const sl = Math.hypot(sd.x, sd.z) || 1;
        fx = sd.x / sl; fz = sd.z / sl;
      } else {
        fx = b.forward?.x ?? b.dir?.x ?? 0;
        fz = b.forward?.z ?? b.dir?.z ?? 1;
      }
      const L = Math.hypot(fx, fz) || 1;
      const ux = fx / L, uz = fz / L;
      const nx = -uz, nz = ux;
      const bx = b.pos?.x ?? b.position.x, bz = b.pos?.z ?? b.position.z;
      const cx = bx + ux * ${p.fwd} + nx * ${p.side};
      const cz = bz + uz * ${p.fwd} + nz * ${p.side};
      const pitch = ${p.pitch} * Math.PI / 180;
      const reach = 26;
      const tx = cx + ux * reach * Math.cos(pitch);
      const tz = cz + uz * reach * Math.cos(pitch);
      const ty = Math.max(0.2, ${p.up} - reach * Math.sin(pitch));
      g.camera.position.set(cx, ${p.up}, cz);
      g.camera.fov = ${p.fov};
      g.camera.updateProjectionMatrix();
      g.camera.lookAt(tx, ty, tz);
      await new Promise((r) => requestAnimationFrame(r));
      g.camera.position.set(cx, ${p.up}, cz);
      g.camera.lookAt(tx, ty, tz);
      await new Promise((r) => requestAnimationFrame(r));
      g.post.render(1 / 60);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.92);
    })()`;
    const r = await evaluate(expr);
    const v = r?.result?.value;
    if (typeof v !== 'string' || !v.startsWith('data:image')) {
      console.log(p.name, 'SHOT FAIL', String(r?.exceptionDetails?.exception?.description || '').slice(0, 160));
      continue;
    }
    const f = path.join(outDir, `${MAP}-${WEATHER || 'day'}-${p.name}.jpg`);
    await fs.writeFile(f, Buffer.from(v.slice(v.indexOf(',') + 1), 'base64'));
    console.log(p.name, 'ok ->', f);
  }

  const info = val(await evaluate(`(() => {
    const g = window.__game; const u = g?.water?.uniforms;
    if (!u) return null;
    return {
      quality: g.quality,
      pixelRatio: g.renderer.getPixelRatio(),
      waterSeg: g.water.seg,
      sat: u.uSat.value, exposure: u.uExposure.value,
      glint: u.uGlint.value, cloud: u.uCloudAmt.value,
      waveScale: u.uWaveScale.value, waveCount: u.uWaveCount.value,
      envOn: u.uEnvOn.value, envMax: u.uEnvMax.value, reflMax: u.uReflMax.value,
      rough: u.uRough.value, absorb: u.uAbsorb.value, foam: u.uFoamStrength.value,
      shallow: u.uColorShallow.value.getHexString(),
      deep: u.uColorDeep.value.getHexString(),
    };
  })()`));
  console.log('水面参数', JSON.stringify(info));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* 已断 */ }
  child.kill();
  await sleep(500);
  process.exit();
});
