// 诊断：峡谷险道的 deco（GLB 布景）到底有没有被请求 / 加载 / 挂进场景
// 用法: node tests/canyon_deco_probe.mjs [baseUrl]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:3000/';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/canyon-deco-probe');
const port = 9241;

const cleanup = async (child) => {
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((r) => setTimeout(r, 600));
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,720', base,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitJson(url, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('devtools timeout');
}

const reqs = [];      // {url, status, type, size}
const failures = [];  // net::ERR_*
const consoleMsgs = []; // console.error / warn
const pageErrors = [];

async function main() {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  const tab = tabs.find((t) => t.type === 'page') || tabs[0];
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Network.requestWillBeSent') {
      const u = m.params.request.url;
      if (/\.glb(\?|$)/i.test(u)) reqs.push({ url: u, id: m.params.requestId, status: null });
    }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      const hit = reqs.find((x) => x.id === m.params.requestId);
      if (hit) hit.status = r.status;
    }
    if (m.method === 'Network.loadingFinished') {
      const hit = reqs.find((x) => x.id === m.params.requestId);
      if (hit) hit.size = m.params.encodedDataLength;
    }
    if (m.method === 'Network.loadingFailed') {
      const hit = reqs.find((x) => x.id === m.params.requestId);
      failures.push({ url: hit?.url || m.params.requestId, err: m.params.errorText });
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(m.params.type)) {
      consoleMsgs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      pageErrors.push(m.params.exceptionDetails.exception?.description?.slice(0, 400)
        || m.params.exceptionDetails.text);
    }
  });
  await cdp('Network.enable');
  await cdp('Page.enable');
  await cdp('Runtime.enable');

  await sleep(1500);
  const jsHash = await cdp('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('script[src]')].map(s=>s.getAttribute('src')).join(',')`,
    returnByValue: true,
  });
  console.log('页面里的 JS:', jsHash.result.value);

  const click = (sel) => cdp('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(sel)})?.click()`, returnByValue: true,
  });

  const mapId = process.env.MAP_ID || 'ocean';
  await click('#btn-solo'); await sleep(600);
  await cdp('Runtime.evaluate', {
    expression: `(() => { const c=[...document.querySelectorAll('#boat-list .boat-card')][0]; c?.click(); document.querySelector('#btn-boat-ok')?.click(); })()`,
  });
  await sleep(600);
  await cdp('Runtime.evaluate', {
    expression: `(() => { const card=[...document.querySelectorAll('.map-card')].find(x=>x.dataset.mapId===${JSON.stringify(mapId)}); card?.click(); document.querySelector('#btn-map-ok')?.click(); })()`,
  });
  await sleep(9000); // 等 GLB 下载 + 解析

  const info = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game; const t = g?.track;
      const props = (t?.courseProps || []).map(p => ({
        kind: p.kind, label: p.label, gate: p.gate,
        x: Math.round(p.x), z: Math.round(p.z), y: +(+p.y).toFixed(2),
        span: Math.round(p.span),
        holder: !!p.holder,
        children: p.holder ? p.holder.children.length : 0,
      }));
      return {
        map: g?.mapDef?.name, mapId: g?.mapDef?.id,
        phase: g?.phase,
        propCount: props.length,
        props,
        sceneChildren: g?.scene?.children?.length ?? null,
        gltfCacheKeys: window.__gltfCache ? Object.keys(window.__gltfCache).length : 'n/a',
      };
    })()`,
    returnByValue: true,
  });
  console.log('=== 场景内的 courseProps ===');
  console.log(JSON.stringify(info.result.value, null, 2));

  // 相机放到崖壁位置看（at:0.10 那个门）
  await cdp('Runtime.evaluate', {
    expression: `(() => {
      const g = window.__game; const b = g?.localBoat; const t = g?.track;
      if (!b || !t) return 'no boat';
      g.phase='racing'; g.countdownLeft=0;
      const p = (t.courseProps||[]).find(x=>x.kind==='deco');
      if (!p) return 'no deco';
      const dx = p.x - t.gates[0][0], dz = p.z - t.gates[0][1];
      const L = Math.hypot(dx,dz)||1;
      b.resetTo(p.x - dx/L*40, p.z - dz/L*40, Math.atan2(dx,dz));
      return 'ok';
    })()`,
    returnByValue: true,
  });
  await sleep(2500);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir('shots/verify', { recursive: true }).catch(() => {});
  await fs.writeFile('shots/verify/canyon-deco-live.png', Buffer.from(shot.data, 'base64'));

  console.log('=== GLB 请求 ===');
  for (const r of reqs) console.log(`${r.status ?? '???'}  ${(r.size ?? 0)}B  ${r.url}`);
  if (!reqs.length) console.log('（一条 GLB 请求都没有）');
  console.log('=== 网络失败 ===', failures.length ? failures : '无');
  console.log('=== 页面异常 ===', pageErrors.length ? pageErrors : '无');
  console.log('=== console 警告/错误 ===');
  for (const c of consoleMsgs.slice(-20)) console.log(' -', c);
}

main().then(async () => { try { ws?.terminate(); } catch {} await cleanup(child); process.exit(0); })
  .catch(async (e) => { console.error('PROBE FAIL', e); try { ws?.terminate(); } catch {} await cleanup(child); process.exit(1); });
