// 深挖：deco 模型挂进场景后的世界包围盒 / 可见性 / 材质透明度，并贴脸拍照
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/canyon-deco-box');
const port = 9242;
const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,720', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (method, params = {}) => { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, timeout = 15000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(url); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('devtools timeout'); }

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  const tab = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await sleep(1500);
  const click = (sel) => cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true });
  await click('#btn-solo'); await sleep(600);
  await cdp('Runtime.evaluate', { expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][0]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()` });
  await sleep(600);
  await cdp('Runtime.evaluate', { expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId==='ocean'); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()` });
  await sleep(9000);

  const report = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game; const t = g?.track;
      const V3 = g?.camera?.position?.constructor; // 借现成的 Vector3
      const out = { vec3: !!V3, props: [] };
      const worldBox = (root) => {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        const v = new V3();
        root.updateMatrixWorld(true);
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          const geo = o.geometry;
          if (!geo.boundingBox) geo.computeBoundingBox();
          const bb = geo.boundingBox;
          for (let i = 0; i < 8; i++) {
            v.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
            v.applyMatrix4(o.matrixWorld);
            const a = [v.x, v.y, v.z];
            for (let k = 0; k < 3; k++) { if (a[k] < min[k]) min[k] = a[k]; if (a[k] > max[k]) max[k] = a[k]; }
          }
        });
        return { min, max };
      };
      for (const p of (t?.courseProps || [])) {
        const rec = { kind: p.kind, label: p.label, at: [Math.round(p.x), Math.round(p.z)], span: Math.round(p.span) };
        if (p.holder && V3) {
          const b = worldBox(p.holder);
          rec.min = b.min.map((n) => +n.toFixed(1));
          rec.max = b.max.map((n) => +n.toFixed(1));
          rec.size = [0, 1, 2].map((k) => +(b.max[k] - b.min[k]).toFixed(1));
          rec.visible = p.holder.visible;
          rec.worldY = +p.holder.position.y.toFixed(2);
          let meshes = 0, transparent = 0, minOpacity = 1;
          p.holder.traverse((o) => {
            if (!o.isMesh) return;
            meshes++;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) { if (!m) continue; if (m.transparent) transparent++; minOpacity = Math.min(minOpacity, m.opacity ?? 1); }
          });
          rec.meshes = meshes; rec.transparentMats = transparent; rec.minOpacity = +minOpacity.toFixed(2);
        }
        out.props.push(rec);
      }
      out.waterY = t?.waterLevel ?? null;
      out.camPos = g?.camera ? [g.camera.position.x, g.camera.position.y, g.camera.position.z].map((v) => +v.toFixed(1)) : null;
      return out;
    })()`, returnByValue: true,
  });
  console.log(JSON.stringify(report.result.value, null, 2));

  // 把船放到第一块崖壁正前方 55m，朝向它
  const tp = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game, t = g.track, b = g.localBoat;
      const p = (t.courseProps||[]).find(x => x.kind === 'deco' && /崖壁/.test(x.label));
      if (!p || !b) return 'skip';
      g.phase = 'racing'; g.countdownLeft = 0;
      const dx = Math.sin(p.dir), dz = Math.cos(p.dir);
      b.resetTo(p.x - dx * 55, p.z - dz * 55, Math.atan2(dx, dz));
      b.speed = 0; b.vel.set(0, 0);
      return { boat: [Math.round(b.position.x), Math.round(b.position.z)], deco: [Math.round(p.x), Math.round(p.z)], dir: p.dir };
    })()`, returnByValue: true,
  });
  console.log('teleport', JSON.stringify(tp.result.value));
  await sleep(2000);
  const s1 = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});
  await fs.writeFile('shots/verify/canyon-deco-closeup.png', Buffer.from(s1.data, 'base64'));
  console.log('saved shots/verify/canyon-deco-closeup.png');
}
main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
