// 渲染开销探针：给"能不能把道具换成带贴图的 GLB"这个问题量一个基线。
//   node tests/render_stats.mjs [mapId] [--json]
//
// 输出的是**硬件无关**的量：draw call、三角形、贴图张数与显存估算、可见网格结构。
// 帧率/毫秒数在无头软件光栅下没有参考价值（恒 1~3 fps），所以不测。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const MAP = process.argv[2] || 'canyon';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/render-stats');
const port = 9733;
const url = process.env.WB_URL || 'http://127.0.0.1:5273/';
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,760', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 60000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

// 菜单是异步渲染的（选艇列表、地图卡片都要等一帧），固定 sleep 会偶发抢跑
async function waitSel(sel, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const r = await evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
    if (r.result?.value) return true;
    await sleep(200);
  }
  return false;
}

async function waitForJson(u, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

const STATS = `(() => {
  const g = window.__game;
  if (!g?.renderer) return { error: 'no-game' };
  const info = g.renderer.info;
  const scene = g.scene;

  // 可见网格结构统计（InstancedMesh 的实例数一起数出来，判断"合批有没有做好"）
  let plain = 0, instanced = 0, instancedInstances = 0, skinned = 0, lines = 0;
  const topInstanced = [];
  const texByUuid = new Map();
  const matByUuid = new Set();
  scene.traverse((o) => {
    if (o.isSkinnedMesh) skinned++;
    if (o.isLine || o.isLineSegments) lines++;
    if (!o.isMesh) return;
    if (o.isInstancedMesh) {
      instanced++;
      instancedInstances += o.count;
      topInstanced.push({ name: o.name || o.parent?.name || '?', count: o.count, tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 });
    } else plain++;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      matByUuid.add(m.uuid);
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        const t = m[slot];
        if (t?.image && t.image.width) texByUuid.set(t.uuid, { w: t.image.width, h: t.image.height, slot });
      }
    }
  });
  topInstanced.sort((a, b) => b.count - a.count);

  // 显存估算：只算 RGBA8 + mipmap 链（×1.33），压缩贴图（KTX2/Basis）会小一个数量级
  let texBytes = 0;
  const sizes = {};
  for (const t of texByUuid.values()) {
    texBytes += t.w * t.h * 4 * 1.33;
    const k = t.w + 'x' + t.h;
    sizes[k] = (sizes[k] || 0) + 1;
  }

  // postFx 的最后一趟永远是"1 draw / 1 tri"的全屏 blit，直接读 info 会得出 1/1 的假数。
  // 自己强制跑一遍场景 pass，紧接着读，才拿到真正的地景开销。
  g.renderer.info.autoReset = false;
  g.renderer.info.reset();
  g.renderer.render(scene, g.camera);
  const sceneCalls = info.render.calls;
  const sceneTris = info.render.triangles;
  g.renderer.info.reset();
  g.renderer.info.autoReset = true;

  // 按"最近的命名祖先"分组，看这 500 多个网格到底是哪来的
  const groups = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    let named = 'root';
    for (let p = o; p; p = p.parent) { if (p.name) { named = p.name; break; } }
    const g2 = groups.get(named) || { meshes: 0, tris: 0 };
    g2.meshes++;
    const pos = o.geometry?.attributes?.position;
    const idx = o.geometry?.index;
    g2.tris += ((idx ? idx.count : (pos?.count || 0)) / 3) * (o.isInstancedMesh ? o.count : 1);
    groups.set(named, g2);
  });
  const byGroup = [...groups.entries()].map(([k, v]) => ({ name: k, meshes: v.meshes, ktris: +(v.tris / 1000).toFixed(1) }))
    .sort((a, b) => b.meshes - a.meshes).slice(0, 14);

  return {
    map: g.mapDef?.id,
    scenePass: { calls: sceneCalls, ktris: +(sceneTris / 1000).toFixed(1) },
    byGroup,
    draw: { calls: info.render.calls, triangles: info.render.triangles, lines: info.render.lines, points: info.render.points },
    memory: { geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? null },
    count: { plainMesh: plain, instancedMesh: instanced, instances: instancedInstances, skinned, lines, materials: matByUuid.size, uniqueTextures: texByUuid.size },
    texVramMB: +(texBytes / 1048576).toFixed(1),
    texSizes: sizes,
    topInstanced: topInstanced.slice(0, 12),
    pixelRatio: g.renderer.getPixelRatio(),
    canvas: g.renderer.domElement.width + 'x' + g.renderer.domElement.height,
  };
})()`;

async function main() {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(1500);

  const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`);
  // 主菜单要等 bundle 起来才有；不等就点空，#btn-solo 点不到 → 后面全是空
  if (!(await waitSel('#btn-solo', 30000))) throw new Error('main menu never booted');
  await click('#btn-solo'); await sleep(900);
  await waitSel('#boat-list .boat-card');
  await click('#boat-list .boat-card'); await sleep(400);
  await click('#btn-boat-ok');
  if (!(await waitSel('.map-card'))) throw new Error('map cards never appeared');
  const pick = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === ${JSON.stringify(MAP)});
    if (!c) return 'no-card';
    c.click(); return 'ok';
  })()`);
  if (pick.result?.value !== 'ok') {
    const ids = await evaluate(`[...document.querySelectorAll('.map-card')].map(x => x.dataset.mapId)`);
    throw new Error(`map card ${MAP} missing; have=${JSON.stringify(ids.result?.value)}`);
  }
  await click('#btn-map-ok');
  // 异步 GLB（灯塔/道具/航标）要等它们落地，否则数出来的 draw call 是半成品
  await sleep(16000);
  await evaluate(`(() => { const g = window.__game; if (!g) return; g.phase = 'racing'; g.countdownLeft = 0; return 1; })()`);
  await sleep(2500);

  const r = await evaluate(STATS);
  const v = r.result?.value;
  if (!v || v.error) {
    console.log('FAIL', JSON.stringify(v), r.exceptionDetails?.exception?.description || '');
    process.exit(1);
  }
  console.log(JSON.stringify(v, null, 2));
  ws.close(); child.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

main().catch(async (e) => { console.error('FAIL', e.message); child.kill(); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(1); });
