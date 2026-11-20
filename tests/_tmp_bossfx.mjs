// 验收探针：怪物模式主炮弹道特效放大后的截图
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/bossfx-${stamp}`);
const port = 9760 + (Number(stamp.slice(-3)) % 12);
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=640,360'], { stdio: 'ignore' });
let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, timeout = 60000) => { const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p })); return new Promise((res, rej) => { const t = setTimeout(() => { pending.delete(id); rej(new Error('timeout ' + m)); }, timeout); pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } }); }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const val = (r) => r?.result?.value;
async function waitJson(u, timeout = 20000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('no devtools'); }
const shotPath = (n) => path.resolve('shots/verify-new', n);
const pulse = () => cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 16, height: 16, scale: 1 } });
async function shot(name) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.mkdir(path.dirname(shotPath(name)), { recursive: true }); await fs.writeFile(shotPath(name), Buffer.from(r.data, 'base64')); }
try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((x) => x.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.method === 'Runtime.exceptionThrown') console.log('EXC', m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  // 等首页按钮真正挂上 onclick（Vite 冷启动/热更新时页面可能还没初始化）
  const waitEval = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (val(await evaluate(expr))) return true;
      await pulse();
      await sleep(120);
    }
    return false;
  };
  const need = async (expr, label) => {
    const ok = await waitEval(expr);
    console.log('STEP', label, ok ? 'ok' : 'TIMEOUT');
    return ok;
  };
  await need(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 'intro-ready');
  await evaluate(`document.querySelector('#btn-solo').click(); 1`);
  await need(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 'enter-lobby');
  // 选艇：赤焰号（火球弹道，最容易判断轨迹）
  await evaluate(`document.querySelector('#btn-lobby-boat').click(); 1`);
  await need(`!!document.querySelector('#lobby-pick-body [data-boat="rower"]')`, 'boat-picker');
  await evaluate(`document.querySelector('#lobby-pick-body [data-boat="rower"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  // 模式：怪物
  await evaluate(`document.querySelector('#btn-lobby-mode').click(); 1`);
  await need(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 'mode-picker');
  await evaluate(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await evaluate(`document.querySelector('#btn-start-race').click(); 1`);
  await need(`!!window.__game`, 'game-created');
  // 等进入战斗阶段（intro → countdown → fight），无头下必须靠截图驱动 rAF
  let phase = '';
  for (let i = 0; i < 240; i++) {
    await pulse();
    phase = val(await evaluate(`window.__game?.bossMode?.phase || ''`)) || '';
    if (phase === 'fight') break;
    await sleep(80);
  }
  console.log('PHASE', phase, JSON.stringify(val(await evaluate(`({ boat: window.__game?.bossMode?.myBoatId, players: window.__game?.bossMode?.players?.size })`))));
  // 按住 J 开火（怪物模式主炮键，F 是协同合击）
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', code: 'KeyJ', bubbles: true })); 1`);
  for (let i = 0; i < 6; i++) {
    await shot(`bossfx-${String(i).padStart(2, '0')}.png`);
    const st = val(await evaluate(`(() => { const g = window.__game; const b = g?.bossMode; const p = b?.players?.get(b.myId);
      const guns = b?.weapons;
      return { phase: b?.phase, alive: p?.alive,
        big: guns?.bigShotFx, scale: guns?.shotFxScale,
        shots: guns?.shots?.size,
        fx: [...(g?.fx?.attached?.entries() || [])].filter(([k]) => k.startsWith('cannon'))
          .map(([k, a]) => ({ n: a.handles.length, trail: a.trail, sc: +a.scale })) }; })()`));
    console.log('S' + i, JSON.stringify(st));
    await sleep(180);
  }
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', code: 'KeyJ', bubbles: true })); 1`);
} catch (e) { console.error('ERR', e.message); } finally { try { ws?.close(); } catch {} try { child.kill(); } catch {} process.exit(0); }
