// 一次性排查：松树实例到底有没有生成
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/pine-probe-' + Date.now());
const port = 9720 + Math.floor(Math.random() * 60);
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=800,450',
  'http://127.0.0.1:5173/'], { stdio: 'ignore' });
const local = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; let seq = 0; const pending = new Map();
const logs = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: '(function(){try{return (' + expr + ');}catch(e){return "ERR:"+e.message;}})()', returnByValue: true, awaitPromise: true });
  return r.exceptionDetails ? 'EXC:' + r.exceptionDetails.exception?.description : r.result.value;
};
const waitFor = async (expr, label, tries = 120) => {
  for (let i = 0; i < tries; i++) { if (await ev(expr).catch(() => false)) return; await local(500); }
  throw new Error('timeout ' + label);
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
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
    if (m.method === 'Runtime.consoleAPICalled') logs.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || '').split('\n')[0]);
    if (m.method === 'Network.responseReceived' && /pine_trees/.test(m.params?.response?.url || '')) logs.push('NET pine_trees ' + m.params.response.status);
  });
  await cdp('Runtime.enable'); await cdp('Network.enable'); await cdp('Page.enable');
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
    await ev(`(() => { const c=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='lake'); c?.click(); document.querySelector('#btn-map-ok')?.click(); })()`);
    await local(2500);
  }
  await waitFor(`!!(window.__game && window.__game.track)`, 'game');
  await local(9000);

  const dump = await ev(`(() => {
    const g = window.__game;
    const env = g.track?.env || g.env || g.environment;
    const out = { hasEnv: !!env, names: [], pine: 0, cone: 0, slots: null };
    if (!env) return JSON.stringify(out);
    out.slots = Array.isArray(env.pineSlots) ? env.pineSlots.length : null;
    out.pineMeshes = (env.pineMeshes || []).length;
    let inst = 0, meshes = 0;
    g.scene.traverse((o) => {
      if (o.isInstancedMesh) { inst++; out.names.push('INST ' + o.name + ' n=' + o.count); }
      if (o.isMesh && o.name) { meshes++; if (/pine|shore|tree/i.test(o.name)) out.names.push(o.name); }
    });
    out.instanced = inst; out.meshes = meshes;
    return JSON.stringify(out);
  })()`);
  console.log('DUMP', dump);

  // 直接把相机怼到第一棵树上，确认到底是"没生成"还是"生成了但看不见"
  const near = await ev(`(() => {
    const g = window.__game;
    let target = null;
    g.scene.traverse((o) => { if (o.isInstancedMesh && /shore-pines/.test(o.name) && !target) target = o; });
    if (!target) return JSON.stringify({ error: 'no instanced pine' });
    const arr = target.instanceMatrix.array;
    const px = arr[12], py = arr[13], pz = arr[14];
    const sx = Math.hypot(arr[0], arr[1], arr[2]);
    const sy = Math.hypot(arr[4], arr[5], arr[6]);
    const sz = Math.hypot(arr[8], arr[9], arr[10]);
    g.phase = 'racing'; g.countdownLeft = 0;
    g.cameraRig.update = () => {}; g.cameraRig.follow = () => {}; g.cameraRig.followLookAt = () => {};
    g.renderer.setSize(640, 360, false);
    if (g.postFx) g.postFx.enabled = false;
    g.camera.position.set(px + 26, py + 16, pz + 34);
    g.camera.lookAt(px, py + 4, pz);
    g.camera.updateMatrixWorld();
    const p = { x: px, y: py, z: pz };
    g.camera.updateMatrixWorld();
    return JSON.stringify({ x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1),
      sx: +sx.toFixed(2), sy: +sy.toFixed(2), sz: +sz.toFixed(2),
      visible: target.visible, count: target.count,
      tris: target.geometry.index ? target.geometry.index.count / 3 : null,
      mats: (Array.isArray(target.material) ? target.material : [target.material]).map(x => ({
        name: x.name, alphaTest: x.alphaTest, transparent: x.transparent, visible: x.visible,
        hasMap: !!x.map, mapW: x.map?.image?.width || 0, mapH: x.map?.image?.height || 0,
        color: x.color ? '#' + x.color.getHexString() : null, side: x.side,
      })),
      groups: (target.geometry.groups || []).map(g => ({ start: g.start, count: g.count, mi: g.materialIndex })),
      attrs: Object.keys(target.geometry.attributes),
      indexCount: target.geometry.index ? target.geometry.index.count : null,
      bbox: target.geometry.boundingBox ? { min: target.geometry.boundingBox.min.toArray().map(n => +n.toFixed(2)), max: target.geometry.boundingBox.max.toArray().map(n => +n.toFixed(2)) } : null,
    });
  })()`);
  console.log('NEAR', near);
  await local(2500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(path.resolve('shots/verify/pine-closeup.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot -> shots/verify/pine-closeup.png');

  console.log('LOGS', logs.slice(0, 30).join('\n'));
} catch (e) {
  console.error('probe fail', e.message);
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await local(400);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
