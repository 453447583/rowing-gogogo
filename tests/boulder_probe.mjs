// 礁石贴图隔离探针：只留 reef-boulders 这一批实例，其余场景全部隐藏，
// 用来回答"到底是不是贴图没生效 / 是不是过曝发白"。
//   node tests/boulder_probe.mjs [mapId]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const mapId = process.argv[2] || 'lake';
const base = process.env.BASE_URL || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boulder-' + Date.now());
const port = 9900 + Math.floor(Math.random() * 90);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });

const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=960,540', base],
{ stdio: 'ignore' });

const local = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout ' + m)), 240000)),
  ]);
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: '(function(){try{return (' + expr + ');}catch(e){return "ERR:"+e.message;}})()', returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC:' + r.exceptionDetails.exception?.description : r.result.value;
};
const waitFor = async (expr, label, tries = 160) => {
  for (let i = 0; i < tries; i++) { if (await ev(expr).catch(() => false)) return true; await local(500); }
  throw new Error('timeout: ' + label);
};

try {
  let tabs = null;
  for (let i = 0; i < 150 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    if (!tabs) await local(200);
  }
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await local(2500);

  await waitFor(`!!document.querySelector('#btn-solo')`, 'menu');
  for (let i = 0; i < 10; i++) {
    await ev(`document.querySelector('#btn-solo')?.click()`).catch(() => {});
    await local(1000);
    if (await ev(`!document.querySelector('#menu-boat')?.classList.contains('hidden')`).catch(() => false)) break;
  }
  await waitFor(`!!document.querySelector('.boat-card')`, 'boats');
  await ev(`(() => { document.querySelector('.boat-card').click(); document.querySelector('#btn-boat-ok').click(); })()`);
  await waitFor(`!!document.querySelector('.map-card')`, 'maps');
  for (let i = 0; i < 8 && !(await ev(`!!window.__game`).catch(() => false)); i++) {
    await ev(`(() => { const c=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='${mapId}'); if(!c) throw new Error('no map'); c.click(); document.querySelector('#btn-map-ok')?.click(); })()`);
    await local(2500);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await waitFor(`!!window.__game.scene.children.length`, 'scene');
  // 等 GLB 到齐（礁石是异步挂上去的）
  await waitFor(`(() => { let n = 0; window.__game.scene.traverse(o => { if (o.isInstancedMesh && /reef-boulders/.test(o.name)) n++; }); return n > 0; })()`, 'boulders', 60);
  // 开场还有几秒倒计时，倒计时期间画面上盖的是 #bg-image 那张卡通插画（z-index 0），
  // 3D 画布在它上层但还没开始画东西。这里直接关掉背景层 + 清倒计时，
  // 否则截到的是插画而不是场景（我第一次就栽在这）。
  for (let i = 0; i < 5; i++) {
    await ev(`(() => {
      const g = window.__game;
      g.phase = 'racing'; g.countdownLeft = 0; g.raceTime = 1;
      for (const id of ['bg-image', 'bg-overlay', 'countdown', 'intro']) {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      }
      return 1;
    })()`);
    await local(1200);
  }
  await local(1500);

  const info = await ev(`(() => {
    const g = window.__game;
    let target = null;
    g.scene.traverse((o) => { if (o.isInstancedMesh && /reef-boulders/.test(o.name) && !target) target = o; });
    if (!target) return '{"err":"no boulder"}';

    // 关 UI 面板，画面别被 HUD 压着（注意：**不要**隐藏 3D 物体，
    // 之前试过把场景整体 visible=false，主循环会抛异常直接停掉，
    // 结果截出来是一张纯色板）
    for (const id of ['ui-root', 'hud']) {
      const el = document.getElementById(id); if (el) el.style.display = 'none';
    }
    g.phase = 'racing'; g.countdownLeft = 0;
    g.cameraRig.update = () => {}; g.cameraRig.follow = () => {}; g.cameraRig.followLookAt = () => {};
    g.renderer.setSize(960, 540, false);
    if (g.postFx) g.postFx.enabled = false;

    const a = target.instanceMatrix.array;
    // 水面以上的那块（y 最大）
    let best = 0, bestY = -1e9;
    for (let i = 0; i < target.count; i++) {
      if (a[i * 16 + 13] > bestY) { bestY = a[i * 16 + 13]; best = i; }
    }
    const o = best * 16;
    const px = a[o + 12], py = a[o + 13], pz = a[o + 14];
    const sxz = Math.hypot(a[o], a[o + 1], a[o + 2]);
    const sy  = Math.hypot(a[o + 4], a[o + 5], a[o + 6]);
    // 贴脸：距离约等于石块宽度，斜上方 35°
    const d = sxz * 0.55;
    g.camera.position.set(px + d * 0.8, py + sy * 0.25 + d * 0.7, pz + d);
    g.camera.lookAt(px, py + sy * 0.12, pz);
    g.camera.updateMatrixWorld();
    window.__bp = { px, py, pz, sxz, sy };

    const m = Array.isArray(target.material) ? target.material[0] : target.material;
    const bb = target.geometry.boundingBox;
    const uv = target.geometry.attributes.uv;
    let uMin = [9, 9], uMax = [-9, -9];
    if (uv) for (let i = 0; i < uv.count; i++) {
      uMin[0] = Math.min(uMin[0], uv.getX(i)); uMax[0] = Math.max(uMax[0], uv.getX(i));
      uMin[1] = Math.min(uMin[1], uv.getY(i)); uMax[1] = Math.max(uMax[1], uv.getY(i));
    }
    return JSON.stringify({
      count: target.count, picked: best,
      mat: { name: m.name, hasMap: !!m.map, mapW: m.map?.image?.width || 0,
        normalMap: !!m.normalMap, roughMap: !!m.roughnessMap, metalMap: !!m.metalnessMap,
        vertexColors: !!m.vertexColors, color: '#' + m.color.getHexString(),
        rough: m.roughness, metal: m.metalness, env: m.envMapIntensity,
        transparent: m.transparent, opacity: m.opacity },
      geo: { height: bb ? +(bb.max.y - bb.min.y).toFixed(3) : null,
        widthX: bb ? +(bb.max.x - bb.min.x).toFixed(3) : null,
        widthZ: bb ? +(bb.max.z - bb.min.z).toFixed(3) : null,
        uv: [uMin.map(v => +v.toFixed(2)), uMax.map(v => +v.toFixed(2))] },
      inst: { pos: [px.toFixed(1), py.toFixed(1), pz.toFixed(1)], sxz: sxz.toFixed(2), sy: sy.toFixed(2),
        worldH: (bb ? (bb.max.y - bb.min.y) * sy : 0).toFixed(2) },
      cam: [g.camera.position.x.toFixed(1), g.camera.position.y.toFixed(1), g.camera.position.z.toFixed(1)],
      toneMapping: g.renderer.toneMapping, exposure: g.renderer.toneMappingExposure,
      frame: g.renderer.info.render.frame,
    });
  })()`);
  console.log('探针信息:', info);
  // 场景里都有哪些实例化网格 / 名字带 rock 的物体 —— 对账用
  console.log('清单:', await ev(`JSON.stringify((() => {
    const out = { inst: [], rockish: [] };
    window.__game.scene.traverse((o) => {
      const tris = o.geometry?.index ? Math.round(o.geometry.index.count / 3) : (o.geometry?.attributes?.position?.count / 3 | 0);
      if (o.isInstancedMesh) out.inst.push(o.name + ' x' + o.count + ' tri' + tris + ' vis' + (o.visible ? 1 : 0) + ' parent:' + (o.parent?.name || o.parent?.type));
      else if (o.isMesh && /rock|boulder|reef|ice|floe|cliff/i.test(o.name || '')) out.rockish.push(o.name + ' tri' + tris);
    });
    return out;
  })())`));
  await local(2000);
  // 主循环还活着吗？frame 不涨说明卡死了，截出来会是纯色板
  const f1 = await ev(`window.__game.renderer.info.render.frame`);
  await local(1200);
  const f2 = await ev(`window.__game.renderer.info.render.frame`);
  console.log('渲染帧:', f1, '->', f2, '｜calls/tris:', await ev(`JSON.stringify((() => { const i = window.__game.renderer.info.render; return { calls: i.calls, tris: i.triangles }; })())`));
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, `boulder-${mapId}.png`), Buffer.from(shot.data, 'base64'));
  console.log('shot -> shots/verify/boulder-' + mapId + '.png');

  // 第二张：同一个位置，抬高到俯视 —— 看整块礁石和它周围的水面关系
  await ev(`(() => {
    const g = window.__game;
    const b = window.__bp;
    if (!b) return 0;
    g.camera.position.set(b.px + b.sxz * 1.6, b.py + b.sxz * 1.9, b.pz + b.sxz * 1.6);
    g.camera.lookAt(b.px, b.py + b.sy * 0.2, b.pz);
    g.camera.updateMatrixWorld();
    return 1;
  })()`);
  await local(1600);
  const shot2 = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, `boulder-${mapId}-top.png`), Buffer.from(shot2.data, 'base64'));
  console.log('shot -> shots/verify/boulder-' + mapId + '-top.png');

  // 第三张：把礁石材质染成纯红后回到第一个机位。
  // 用来做确定性识别——画面里那块"白疙瘩"到底是不是它。
  await ev(`(() => {
    const g = window.__game;
    g.scene.traverse((o) => {
      if (!o.isInstancedMesh || !/reef-boulders/.test(o.name)) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) { m.color.setHex(0xff0000); m.map = null; m.needsUpdate = true; }
    });
    const b = window.__bp;
    const d = b.sxz * 0.55;
    g.camera.position.set(b.px + d * 0.8, b.py + b.sy * 0.25 + d * 0.7, b.pz + d);
    g.camera.lookAt(b.px, b.py + b.sy * 0.12, b.pz);
    g.camera.updateMatrixWorld();
    return 1;
  })()`);
  await local(1600);
  const shot3 = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.join(out, `boulder-${mapId}-red.png`), Buffer.from(shot3.data, 'base64'));
  console.log('shot -> shots/verify/boulder-' + mapId + '-red.png');
} catch (e) {
  console.error('boulder probe: FAIL', e.message);
  process.exitCode = 1;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
