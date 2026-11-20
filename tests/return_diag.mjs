// 快速诊断：只查轨道 group 结构和布景位置，不截图
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/diag');
const port = 9231;
const URL = process.env.SHOT_URL || 'http://127.0.0.1:8765/';
const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=900,560', URL,
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const cdp = (m, params = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params }));
  return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForJson(url, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + url);
}
try {
  const tabs = await waitForJson(`http://127.0.0.1:${port}/json`);
  const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  });
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  const ev = async (e) => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
  const waitUntil = async (expr, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await ev(expr)) return true; await sleep(300); }
    return false;
  };
  await cdp('Page.navigate', { url: URL });
  await waitUntil(`!!document.querySelector('#btn-solo')`);
  await ev(`document.querySelector('#btn-solo')?.click()`);
  await waitUntil(`(() => { const e = document.querySelector('#menu-boat'); if (!e || e.classList.contains('hidden')) { document.querySelector('#btn-solo')?.click(); return false; } return true; })()`);
  await waitUntil(`document.querySelectorAll('#boat-list .boat-card').length > 0`);
  await ev(`document.querySelectorAll('#boat-list .boat-card')[0]?.click()`);
  await sleep(300);
  await ev(`document.querySelector('#btn-boat-ok')?.click()`);
  await waitUntil(`(() => { const e = document.querySelector('#menu-map'); if (!e || e.classList.contains('hidden')) { document.querySelector('#btn-boat-ok')?.click(); return false; } return true; })()`);
  await waitUntil(`document.querySelectorAll('#map-list .map-card').length > 0`);
  await ev(`(() => { const c = [...document.querySelectorAll('#map-list .map-card')].find(x => x.textContent.includes('秘境')); c && c.click(); })()`);
  await sleep(600);
  await ev(`document.querySelector('#btn-map-ok')?.click()`);
  await waitUntil(`!!(window.__game && window.__game.track && window.__game.localBoat)`, 90000);
  await waitUntil(`window.__game.track.group.children.length >= 9`, 120000);
  await sleep(2000);

  const out = await ev(`(() => {
    const g = window.__game.track;
    const kids = g.group.children.map(o => {
      const c = o.children.length;
      return { name: o.name || o.type, kids: c, pos: o.position.toArray().map(Math.round) };
    });
    const shore = kids.filter(k => k.name.startsWith('shore_'));
    const first = shore.map(k => {
      const grp = g.group.children.find(o => o.name === k.name);
      return grp && grp.children[0] ? { name: k.name, p: grp.children[0].position.toArray().map(v => +v.toFixed(1)), rot: +grp.children[0].rotation.y.toFixed(2) } : null;
    });
    const gates = g.gates;
    return JSON.stringify({ kids, first, gate150: gates[150], gate92: gates[92] });
  })()`);
  console.log(out);
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
