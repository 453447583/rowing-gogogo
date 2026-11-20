// 启动探针：走一遍 单人 → 选艇 → 选图，把 console/异常全打出来，确认 window.__game 有没有起来。
// 只在"截图脚本突然报 no-game"时用，用来区分"页面没启动"和"我的改动抛异常"。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const MAP = process.argv[2] || 'canyon';
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/boot-probe');
const port = 9711;
const url = process.env.WB_URL || 'http://127.0.0.1:5273/';
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1024,640', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const logs = [];
function cdp(method, params = {}, timeout = 30000) {
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

async function waitForJson(u, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

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
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push('exception: ' + (d.exception?.description || d.text));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      logs.push('log: ' + m.params.entry.text);
    }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await sleep(1500);
  const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`);
  await click('#btn-solo'); await sleep(900);
  await click('#boat-list .boat-card'); await sleep(400);
  await click('#btn-boat-ok'); await sleep(600);
  const picked = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.map-card')].find(x => x.dataset.mapId === ${JSON.stringify(MAP)});
    if (!c) return 'no-card';
    c.click(); return 'ok';
  })()`);
  console.log('pick:', picked.result?.value);
  await click('#btn-map-ok');
  for (const t of [3000, 6000, 9000, 14000]) {
    await sleep(t === 3000 ? 3000 : 3000);
    const s = await evaluate(`(() => ({ game: !!window.__game, phase: window.__game?.phase ?? null,
      map: window.__game?.mapDef?.id ?? null, loading: !!document.querySelector('#loading:not(.hidden)') }))()`);
    console.log(`t≈${t / 1000}s`, JSON.stringify(s.result?.value));
  }
  if (logs.length) console.log('LOGS:\n' + logs.slice(0, 20).join('\n'));
  else console.log('LOGS: (none)');
  ws.close(); child.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}

main().catch(async (e) => { console.error('FAIL', e.message); child.kill(); await fs.rm(profile, { recursive: true, force: true }).catch(() => {}); process.exit(1); });
