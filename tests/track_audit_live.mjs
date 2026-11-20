// 赛道实地审计（浏览器内跑真实 Track/Game）：道具箱分布 + 空气墙侵入
//
//   node tests/track_audit_live.mjs [mapId] [--item]
//
// 两个指标：
//   1) 道具箱沿赛道的分布 —— 如果全都挤在起点，nearestGate 的分布会集中在 0 附近；
//   2) 碰撞体侵入航道 —— 把每个 collider 投到赛道中线上，算它还剩多少净空。
//      intrusion > 0 就是「看起来能过、实际被弹回来」的空气墙。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const mapId = process.argv[2] || 'canyon';
const wantItem = process.argv.includes('--item');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/track-audit');
const port = 9351;
const httpPort = 5181;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  env: { ...process.env, PORT: String(httpPort) }, stdio: 'ignore',
});
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=900,560',
  `http://127.0.0.1:${httpPort}/`], { stdio: 'ignore' });

let ws;
const fail = (m) => { throw new Error(m); };
try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  if (!tabs) fail('headless Edge 没起来');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const q = pending.get(m.id); pending.delete(m.id);
      if (m.error) q.rej(new Error(m.error.message)); else q.res(m.result);
    }
  });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const cdp = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  };
  await cdp('Runtime.enable');
  const sleepCd = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 60000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleepCd(300);
    }
    throw new Error('timeout: ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  await waitFor('!!document.querySelector("#btn-solo")', 45000, 'menu');
  for (let i = 0; i < 10; i++) {
    await ev('document.querySelector("#btn-solo").click()');
    await sleepCd(600);
    if (await ev('[...document.querySelectorAll(".boat-card")].length > 0')) break;
  }
  await ev('[...document.querySelectorAll(".boat-card")].find(x => x.textContent.includes("疾风")).click()');
  await sleepCd(300);
  await ev('document.querySelector("#btn-boat-ok").click()');
  // 等地图卡片真的渲染出来再点，否则点到的是上一屏残留/空列表
  await waitFor('document.querySelectorAll(".map-card").length > 0', 30000, 'map cards');
  const picked = await ev(`(function(){
    const c=document.querySelector('.map-card[data-map-id="${mapId}"]');
    if(!c) return 'no-card';
    c.click();
    return c.dataset.mapId;
  })()`);
  if (picked !== mapId) throw new Error('没选中地图 ' + mapId + '（' + picked + '）');
  await sleepCd(400);
  await ev(`(function(){
    const sel=document.querySelector('#mode-select'); if(sel && ${wantItem}){ sel.value='item'; sel.dispatchEvent(new Event('change')); }
    return 1})()`);
  await sleepCd(400);
  await ev('document.querySelector("#btn-map-ok").click()');
  await waitFor('!!(window.__game && window.__game.track)', 90000, 'game boot');
  const realMap = await ev('window.__game.mapDef.id');
  if (realMap !== mapId) throw new Error('启动的地图不对：' + realMap);
  await ev('(function(){ try{ window.__game.renderer.setSize(320,200,false); }catch(e){} return 1 })()');
  await sleepCd(1500);
  // 倒计时阶段 items.update 可能还没跑（箱子全藏在 y=-600），要等到 racing 才有意义
  if (wantItem) await waitFor('window.__game.phase === "racing"', 90000, 'racing');

  // 可选截图：起点一张，把船瞬移到赛道中段再一张
  if (process.argv.includes('--shot')) {
    await fs.mkdir(path.resolve('shots/verify'), { recursive: true });
    const shot = async (name) => {
      const res = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
      await fs.writeFile(path.resolve(`shots/verify/${name}.jpg`), Buffer.from(res.data, 'base64'));
      console.log('  shot -> shots/verify/' + name + '.jpg');
    };
    await cdp('Page.enable');
    await sleepCd(800);
    await shot(`boxes-${mapId}-start`);
    await ev(`(function(){
      const g = window.__game, tr = g.track, b = g.localBoat;
      const N = tr.gates.length;
      const gi = Math.floor(N * 0.45);
      const a = tr.gates[gi], c = tr.gates[(gi + 1) % N];
      b.resetTo(a[0], a[1], Math.atan2(c[0] - a[0], c[1] - a[1]));
      g.cameraRig?.snapTo?.(b);
      return 1;
    })()`);
    await sleepCd(1600);
    await shot(`boxes-${mapId}-mid`);
  }

  const report = await ev(`(function(){
    const g = window.__game;
    const tr = g.track;
    const gates = tr.gates;
    const N = gates.length;
    const W = tr.gateWidth;
    // 点到「赛道中线折线」的最近距离 + 最近段中心
    const nearest = (x, z) => {
      let best = Infinity, seg = -1, cx = 0, cz = 0;
      for (let i = 0; i < N; i++) {
        const a = gates[i], b = gates[(i + 1) % N];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const L2 = dx * dx + dz * dz || 1;
        let t = ((x - a[0]) * dx + (z - a[1]) * dz) / L2;
        t = Math.max(0, Math.min(1, t));
        const px = a[0] + dx * t, pz = a[1] + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < best) { best = d; seg = i; cx = px; cz = pz; }
      }
      return { d: best, seg, cx, cz };
    };
    const mapId = g.mapDef.id;

    // ---- 1) 道具箱分布 ----
    let boxes = null;
    if (g.items) {
      const list = g.items.boxes.map((b) => {
        const n = nearest(b.x, b.z);
        return { seg: n.seg, off: +n.d.toFixed(2) };
      });
      const segs = list.map((b) => b.seg);
      const uniq = new Set(segs).size;
      const nearStart = segs.filter((s) => s <= Math.max(2, Math.round(N / 12))).length;
      // 高差检查：道具箱的 y 用的是 waveHeight，如果这一排落在抬高段
      // （瀑布/云端/栈道），箱子会掉到赛道下面几十米 —— 玩家根本吃不到。
      const gy = tr.gateY || [];
      const highRows = [...new Set(segs)].filter((seg) => Math.abs(gy[seg] || 0) > 3).length;
      boxes = {
        count: list.length,
        rows: uniq,
        highRows,
        segMin: Math.min(...segs), segMax: Math.max(...segs),
        nearStartPct: Math.round((nearStart / list.length) * 100),
        maxOff: +Math.max(...list.map((b) => b.off)).toFixed(2),
        // 每行间隔（按 seg 去重后的中位数）
        segList: [...new Set(segs)].sort((a, b) => a - b),
      };
      // 渲染侧真相：直接读 InstancedMesh 的实例矩阵平移分量，
      // 数据里有箱子但画面上没有 = 渲染批次没跟上，是两回事。
      const f = g.items.boxField;
      if (f?.panels) {
        const arr = f.panels.instanceMatrix.array;
        const n = Math.min(6, f.count);
        const pos = [];
        for (let i = 0; i < n; i++) {
          pos.push([arr[i * 16 + 12], arr[i * 16 + 13], arr[i * 16 + 14]].map((v) => Math.round(v)));
        }
        boxes.fieldCount = f.count;
        boxes.visible = f.panels.visible;
        boxes.firstInstances = pos;
        boxes.activeCount = g.items.boxes.filter((b) => b.active).length;
        boxes.hiddenCount = (() => {
          let h = 0;
          for (let i = 0; i < f.count; i++) if (arr[i * 16 + 13] < -100) h++;
          return h;
        })();
        boxes.ys = [0, 10, 20, 40, 60, 80].filter((i) => i < f.count)
          .map((i) => Math.round(arr[i * 16 + 13]));
      }
    }

    // ---- 2) 碰撞体侵入航道 ----
    const cols = [...(g.colliders || []), ...(g.track.shoreColliders || []), ...(g.track.mechColliders || [])];
    const HULL = 1.3;
    const bad = [];
    for (const c of cols) {
      if (!Number.isFinite(c.r)) continue;
      const n = nearest(c.x, c.z);
      // 站在中线上最靠近它的那一点，两者之间还剩多少净空
      const clearance = n.d - c.r - HULL;
      if (clearance < W) {
        bad.push({
          x: +c.x.toFixed(1), z: +c.z.toFixed(1), r: +c.r.toFixed(2),
          type: c.type || 'circle',
          offTrack: +n.d.toFixed(1),
          clearance: +clearance.toFixed(1),
          intrude: +(W - clearance).toFixed(1),
        });
      }
    }
    bad.sort((a, b) => b.intrude - a.intrude);
    return {
      mapId, gates: N, gateWidth: W,
      colliderCount: cols.length,
      boxes,
      intruders: bad.length,
      worst: bad.slice(0, 8),
    };
  })()`);

  console.log(JSON.stringify(report, null, 2));
} finally {
  try { ws?.close(); } catch {}
  try { child.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(400);
  try { await fs.rm(profile, { recursive: true, force: true }); } catch {}
}
