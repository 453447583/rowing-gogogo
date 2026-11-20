// 6 艘新赛艇实机验收：大厅选艇 → 发车 → 追尾机位截图 + 量水线/朝向
// 前置：dev server 跑在 127.0.0.1:5173（npm run dev）
// 用法：node tests/boat_swap_probe.mjs [id ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import WebSocket from 'ws';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9233;
// dev server 端口可能被旧实例占着，用 BASE 覆盖
const URL = process.env.BASE || 'http://127.0.0.1:5173/';
// 每次跑用独立 profile：fs.rm 会被 safe-delete 拦截并超时，清理交给外层 rm -rf
const PROFILE = path.resolve(`D:/3dgame-tmp/browser/boat-swap-${Date.now()}`);
const SHOTS = path.resolve('shots/verify/boats/new');
const IDS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['rower', 'skiff', 'falcon', 'dolphin', 'vintage', 'longship'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  const child = spawn(EDGE, [
    '--headless', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=760,440', '--hide-scrollbars', URL,
  ], { stdio: 'ignore' });

  let ws;
  let seq = 0;
  const pending = new Map();
  const results = [];
  try {
    let tabs = null;
    for (let i = 0; i < 80 && !tabs; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json`);
        if (r.ok) tabs = await r.json();
      } catch { /* 还没起来 */ }
      if (!tabs) await sleep(250);
    }
    if (!tabs) throw new Error('CDP 没起来');
    const page = tabs.find((t) => t.type === 'page' && t.url.startsWith(URL.replace(/\/$/, '')));
    if (!page) throw new Error('找不到游戏页面：' + tabs.map((t) => `${t.type}:${t.url}`).join(' | '));

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        console.log('@@PAGEERR@@', (d.exception?.description || d.text || '').split('\n').slice(0, 3).join(' | '));
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) {
        const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160);
        if (txt) console.log('@@CONSOLE@@', m.params.type, txt);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        console.log('@@PAGELOG@@', m.params.entry.text.slice(0, 200));
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      }
    });
    ws.on('close', () => { for (const p of pending.values()) p.reject(new Error('CDP 断开')); pending.clear(); });

    const cdp = (method, params = {}) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时 ' + method)); }, 30000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
      });
    };

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Log.enable');
    // 把页面级的 error / unhandledrejection 记进 window.__errs：startSoloRace 抛错时
    // CDP 的 exceptionThrown 抓不到 await 链里的拒绝，只能靠页面自己记
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs = [];
        addEventListener('error', (e) => window.__errs.push('err: ' + (e.message || e.type)));
        addEventListener('unhandledrejection', (e) => window.__errs.push('rej: ' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));`,
    });
    const evaluate = async (expression) => {
      const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.text || ''));
      return r.result?.value;
    };
    const waitUntil = async (expression, timeout = 40000, label = expression) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        try {
          if (await evaluate(expression)) return;
        } catch { /* 上下文重建中 */ }
        await sleep(250);
      }
      throw new Error('等待超时：' + label);
    };
    const shot = async (file) => {
      const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
      await fs.writeFile(file, Buffer.from(data, 'base64'));
    };

    // 主菜单：等按钮的 onclick 真挂上（无头冷启动时资源预热后才挂）
    await waitUntil("typeof document.querySelector('#btn-solo')?.onclick === 'function'", 60000, '主菜单按钮');
    let gridShot = false;

    for (const id of IDS) {
      try {
      await cdp('Page.navigate', { url: URL });
      await waitUntil("typeof document.querySelector('#btn-solo')?.onclick === 'function'", 60000, '主菜单按钮 ' + id);
      // 主菜单按钮的 onclick 是资源预热后才挂上的，而且中间存在"挂上了但点了没反应"的阶段。
      // 反复点 + 检查 #lobby 是否真的显示出来，别等一个永远不会出现的状态。
      let inLobby = false;
      for (let i = 0; i < 12 && !inLobby; i++) {
        await evaluate("document.querySelector('#btn-solo')?.click()");
        try {
          await waitUntil("(() => { const l = document.querySelector('#lobby'); return !!l && !l.classList.contains('hidden'); })()", 4000, '大厅');
          inLobby = true;
        } catch { await sleep(800); }
      }
      if (!inLobby) throw new Error('进不去大厅 ' + id);
      // 选艇：抽屉是可滚动的，先展开再点卡片
      await evaluate("document.querySelector('#btn-lobby-boat').click()");
      await waitUntil(`!!document.querySelector('[data-boat="${id}"]')`, 30000, '选艇抽屉 ' + id);
      if (!gridShot) {
        // 8 张卡片放不进一屏，把抽屉内容整体缩到 0.62 并滚到顶，一张图看全布局
        await evaluate(`(() => {
          const body = document.querySelector('#lobby-pick-body');
          if (body) {
            body.style.transform = 'scale(0.62)';
            body.style.transformOrigin = 'top left';
            body.style.width = '161%';
            body.scrollTop = 0;
          }
        })()`);
        await sleep(500);
        await shot(path.join(SHOTS, 'lobby-8-cards.jpg'));
        await evaluate(`(() => {
          const body = document.querySelector('#lobby-pick-body');
          if (body) { body.style.transform = ''; body.style.width = ''; }
        })()`);
        gridShot = true;
      }
      await evaluate(`document.querySelector('[data-boat="${id}"]').click()`);
      await sleep(300);
      await evaluate("document.querySelector('#btn-lobby-pick-close')?.click()");
      await sleep(300);
      const picked = await evaluate(`(() => {
        const el = document.querySelector('#lobby-boat-name, .lobby-boat-name, #boat-title-name');
        return el ? el.textContent.trim() : null;
      })()`);

      await evaluate("document.querySelector('#btn-start-race')?.click()");
      // 等倒计时结束、比赛真的在跑（软件渲染很慢，别用墙钟时间判断）
      // 无头软件光栅下 Effekseer 会偶发 texImage2D 异常，帧耗时能到 5s/帧，
      // 按 raceTime 等"跑到 3 秒"可能要好几分钟。改成等模型真的挂上（modelRoot），
      // 再补几帧让相机稳一下 —— 判定朝向 / 吃水线这个机位已经够用。
      await waitUntil("!!(window.__game && window.__game.localBoat && window.__game.localBoat.modelRoot)", 180000, '模型挂载 ' + id);
      await sleep(3000);
      const info0 = await evaluate(`(() => ({
        hasGame: !!window.__game,
        raceTime: window.__game?.raceTime ?? null,
        countdownLeft: window.__game?.countdownLeft ?? null,
        boats: window.__game ? [...window.__game.boats.keys()] : [],
      }))()`);
      console.log('@@STATE@@', id, JSON.stringify(info0));
      const info = await evaluate(`(() => {
        const g = window.__game;
        const b = [...g.boats.values()][0];
        if (!b) return null;
        const root = b.modelRoot;
        let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
        root.updateMatrixWorld(true);
        const tmp = b.pos.clone();
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          const bb = o.geometry.boundingBox;
          for (const cx of [bb.min.x, bb.max.x]) for (const cy of [bb.min.y, bb.max.y]) for (const cz of [bb.min.z, bb.max.z]) {
            tmp.set(cx, cy, cz).applyMatrix4(o.matrixWorld);
            min = [Math.min(min[0], tmp.x), Math.min(min[1], tmp.y), Math.min(min[2], tmp.z)];
            max = [Math.max(max[0], tmp.x), Math.max(max[1], tmp.y), Math.max(max[2], tmp.z)];
          }
        });
        let tris = 0;
        root.traverse((o) => {
          if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
        });
        return {
          id: b.def.id,
          name: b.def.name,
          model: b.def.model,
          posY: +b.pos.y.toFixed(3),
          worldMinY: +min[1].toFixed(3),
          worldMaxY: +max[1].toFixed(3),
          hullLen: +Math.max(max[2] - min[2], max[0] - min[0]).toFixed(2),
          tris: Math.round(tris),
        };
      })()`);
      await shot(path.join(SHOTS, `race-${id}.jpg`));
      // 追尾全景里船太小，看不清吃水线：按船的屏幕投影裁一块放大 3 倍
      const crop = await evaluate(`(() => {
        const g = window.__game;
        const b = [...g.boats.values()][0];
        const v = b.pos.clone();
        v.y += 0.4;
        v.project(g.camera);
        const w = window.innerWidth, h = window.innerHeight;
        const cx = (v.x * 0.5 + 0.5) * w;
        const cy = (-v.y * 0.5 + 0.5) * h;
        const cw = Math.min(260, w), ch = Math.min(180, h);
        return {
          x: Math.max(0, Math.min(w - cw, cx - cw / 2)),
          y: Math.max(0, Math.min(h - ch, cy - ch / 2)),
          width: cw, height: ch, scale: 3,
        };
      })()`);
      if (crop) {
        const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82, clip: crop, captureBeyondViewport: false });
        await fs.writeFile(path.join(SHOTS, `zoom-${id}.jpg`), Buffer.from(data, 'base64'));
      }
      results.push({ id, picked, ...(info || {}) });
      console.log('@@BOAT@@', JSON.stringify(results[results.length - 1]));
      } catch (err) {
        console.log('@@BOATFAIL@@', id, err.message);
        try {
          const st = await evaluate(`(() => ({
            phase: window.__game?.phase, raceTime: window.__game?.raceTime,
            countdown: window.__game?.countdownLeft, boats: window.__game ? [...window.__game.boats.keys()] : [],
            lobby: !!document.querySelector('#btn-lobby-boat'),
            errs: (window.__errs || []).slice(-4),
            res: performance.getEntriesByType('resource')
              .filter((r) => /boat_|glb/.test(r.name))
              .map((r) => r.name.split('/').pop() + ':' + Math.round(r.duration) + 'ms:' + (r.transferSize || 0)),
            hasLocal: !!window.__game?.localBoat,
            root: !!window.__game?.localBoat?.modelRoot,
            btns: [...document.querySelectorAll('#lobby-screen button, #ui-root button')]
              .filter((b) => /start|ready|solo/i.test(b.id))
              .map((b) => b.id + '[' + b.className + '|onclick=' + (typeof b.onclick) + '|hidden=' + (b.offsetParent === null) + ']'),
            startBtn: (() => { const b = document.querySelector('#btn-start-race'); return b ? { hidden: b.classList.contains('hidden'), disabled: b.disabled } : null; })(),
          }))()`);
          console.log('@@FAILSTATE@@', id, JSON.stringify(st));
          await shot(path.join(SHOTS, `fail-${id}.jpg`));
        } catch { /* 截图失败就算了 */ }
      }
    }
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    // 必须按进程树杀：child.kill() 只杀掉启动进程，Edge 的渲染/GPU 子进程会变孤儿
    if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  }
  console.log('@@DONE@@', JSON.stringify(results, null, 1));
}

main().catch((e) => { console.error('@@FAIL@@', e.message); process.exitCode = 1; });
