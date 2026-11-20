/**
 * 实机验收（无头 Edge + CDP）：
 *   node tests/guide_signs_visual.mjs
 *
 * ① 湖泊近道起点上方的岸带草坡是否已被裁掉（逐三角形统计）；
 * ② 近道走廊里是否还残留带碰撞的树 / 石头；
 * ③ 运行时导向牌数量、左右方向分布；
 * ④ 出两张图：近道起点视角 + 一块导向牌的正面视角（看箭头方向）。
 *
 * 临时浏览器配置落在项目内 D:/3dgame-tmp/browser/，收进程一律 taskkill /F /T，
 * 免得 Edge 的 GPU/渲染子进程留成孤儿把 CPU 吃满。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const root = path.resolve('.');
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = 9500 + Math.floor(Math.random() * 300);
const profile = path.resolve('D:/3dgame-tmp/browser/guide-signs-' + Date.now());
const shots = path.resolve('shots/verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = 'http://127.0.0.1:5173/';

let ws;
let seq = 0;
const pending = new Map();
// 软件渲染下首帧 / GLB 解析会把主线程占住几十秒，evaluate 排队很久，
// 30s 会把正常的等待误判成超时（历史坑）。给到 90s。
const cdp = (method, params = {}, timeout = 90000) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`CDP timeout: ${method}`));
  }, timeout);
  pending.set(id, {
    resolve: (v) => { clearTimeout(timer); resolve(v); },
    reject: (e) => { clearTimeout(timer); reject(e); },
  });
  ws.send(JSON.stringify({ id, method, params }));
});

const kill = (child) => {
  if (!child?.pid) return;
  try { spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch {}
};

async function waitFor(url, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(200);
  }
  throw new Error(`timeout waiting ${url}`);
}

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text || 'evaluate failed'} | ${r.exceptionDetails.exception?.description || ''}`);
  return r.result?.value;
}

async function waitUntil(expression, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await evaluate(expression)) return true; } catch {}
    await sleep(250);
  }
  throw new Error(`timeout: ${expression}`);
}

async function main() {
  await fs.mkdir(shots, { recursive: true });
  await fs.mkdir(path.dirname(profile), { recursive: true });

  const vite = spawn(process.execPath, ['scripts/vite-run.mjs', 'dev'], {
    cwd: root, stdio: 'ignore', env: { ...process.env },
  });
  let browser;
  try {
    // 等 dev server 真正能返回页面
    const t0 = Date.now();
    let up = false;
    while (Date.now() - t0 < 40000) {
      try { const r = await fetch(base); if (r.ok) { up = true; break; } } catch {}
      await sleep(250);
    }
    if (!up) throw new Error('vite dev server did not start');

    browser = spawn(edge, [
      '--headless=new', '--no-sandbox', '--disable-gpu',
      '--enable-unsafe-swiftshader', `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, '--window-size=640,360', base,
    ], { stdio: 'ignore' });

    const tabs = await waitFor(`http://127.0.0.1:${port}/json`);
    const page = tabs.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:5173')) || tabs[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    });
    ws.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('ws closed'));
      pending.clear();
    });
    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Page.navigate', { url: base });
    // 冷启动时主菜单按钮的 onclick 是资源预热之后才挂上的，等函数本身而不是等元素
    await waitUntil(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 40000);
    // 大厅是新版：#btn-solo → #lobby → #btn-lobby-map 抽屉里的 .lp-card[data-map]
    // （旧脚本那套 .map-card / #btn-map-ok / #menu-boat 已经不渲染了）
    await waitUntil(`(() => { const l = document.querySelector('#lobby'); if (!l || l.classList.contains('hidden')) { document.querySelector('#btn-solo')?.click(); return false; } return true; })()`, 30000);
    let cardsReady = false;
    for (let i = 0; i < 12 && !cardsReady; i++) {
      await evaluate(`document.querySelector('#btn-lobby-map')?.click()`);
      await sleep(700);
      cardsReady = await evaluate(`!!document.querySelector('.lp-card[data-map="lake"]')`);
    }
    if (!cardsReady) throw new Error('地图抽屉没有渲染出 lake 卡片');
    await evaluate(`(() => { const c = [...document.querySelectorAll('.lp-card[data-map]')].find(x => x.dataset.map === 'lake'); c?.click(); return !!c; })()`);
    await sleep(500);
    await evaluate(`document.querySelector('#btn-start-race')?.click()`);
    await waitUntil(`!!window.__game?.guideSigns && !!window.__game?.track && !!window.__game?.localBoat`, 90000);
    await sleep(1200);

    const audit = await evaluate(`(() => {
      const g = window.__game;
      const sc = g.mapDef.shortcuts[0];
      const pts = sc.points;
      const distToPoly = (x,z) => { let best=Infinity; for(let i=0;i<pts.length-1;i++){
        const [ax,az]=pts[i], [bx,bz]=pts[i+1]; const vx=bx-ax, vz=bz-az;
        const L2=vx*vx+vz*vz||1; const t=Math.max(0,Math.min(1,((x-ax)*vx+(z-az)*vz)/L2));
        best=Math.min(best,Math.hypot(x-(ax+vx*t), z-(az+vz*t))); } return best; };
      const bank = g.env?.group?.getObjectByName('shore-bank');
      let triTotal=0, triBlocked=0;
      if (bank?.geometry?.index) {
        const pos=bank.geometry.attributes.position, idx=bank.geometry.index;
        triTotal=idx.count/3;
        for(let i=0;i<idx.count;i+=3){
          let cx=0,cz=0;
          for(let k=0;k<3;k++){const vi=idx.getX(i+k);cx+=pos.getX(vi);cz+=pos.getZ(vi);}
          cx/=3; cz/=3;
          if (distToPoly(cx,cz) < sc.width + 1.0) triBlocked++;
        }
      }
      const nearList = (g.env?.colliders||[]).filter(c => distToPoly(c.x,c.z) < sc.width + 2.5)
        .map(c => ({type:c.type||'?', x:Math.round(c.x*10)/10, z:Math.round(c.z*10)/10, r:Math.round((c.r||0)*10)/10}));
      const collidersNear = nearList.length;
      const meshes = (g.guideSigns?.group?.children||[]).map(o => ({name:o.name, count:o.count}));
      const signs = g.guideSigns?.signs || [];
      return {
        map: g.mapDef.id,
        shortcutFrom: sc.from, shortcutTo: sc.to, shortcutEntry: pts[0],
        bankFound: !!bank, triTotal, triBlocked, collidersNear, nearList,
        stats: g.guideSigns?.stats, meshes,
        firstSign: signs[0] ? {x:signs[0].x,z:signs[0].z,cx:signs[0].cx,cz:signs[0].cz,tx:signs[0].tx,tz:signs[0].tz,dir:signs[0].dir} : null,
        signsInShortcut: signs.filter(s => distToPoly(s.x,s.z) < sc.width + 10).length,
      };
    })()`);
    console.log('[audit]', JSON.stringify(audit, null, 2));

    if (!audit.bankFound) throw new Error('shore-bank not found');
    if (audit.triBlocked > 0) throw new Error(`岸带仍有 ${audit.triBlocked} 个三角形压在近道走廊上`);
    if (audit.collidersNear > 0) throw new Error(`近道走廊里仍有 ${audit.collidersNear} 个碰撞体：${JSON.stringify(audit.nearList)}`);
    if (audit.signsInShortcut > 0) throw new Error(`近道走廊里有 ${audit.signsInShortcut} 块导向牌`);
    if (!audit.stats?.signs) throw new Error('运行时没有生成导向牌');

    // 截图 1：近道起点（gates[8]=(0,88)），船在 (0,104) 朝 -z 看进去
    await evaluate(`(() => { const g=window.__game, b=g.localBoat;
      g.phase='racing'; g.countdownLeft=0;
      b.resetTo(0, 104, Math.PI); b.speed=0; b.vel.set(0,0);
      g.cameraRig?.snapTo?.(b);
      document.querySelector('#ui-root')?.style?.setProperty('display','none');
      return true; })()`);
    await sleep(2200);
    const s1 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
    await fs.writeFile(path.join(shots, 'guide-lake-shortcut-entry.jpg'), Buffer.from(s1.data, 'base64'));

    // 截图 2：第一块牌的正面（船沿赛道方向退 30m，牌在侧前方）
    if (audit.firstSign) {
      const f = audit.firstSign;
      await evaluate(`(() => { const g=window.__game, b=g.localBoat;
        // 船必须留在中心线上（牌在中心线外 15.5m），否则相机会贴着牌子拍出黑屏块
        const x=${f.cx} - ${f.tx}*26, z=${f.cz} - ${f.tz}*26;
        b.resetTo(x, z, Math.atan2(${f.tx}, ${f.tz})); b.speed=0; b.vel.set(0,0);
        g.cameraRig?.snapTo?.(b);
        return true; })()`);
      await sleep(2200);
      const s2 = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
      await fs.writeFile(path.join(shots, 'guide-lake-sign-face.jpg'), Buffer.from(s2.data, 'base64'));
    }
    console.log('[shots] shots/verify/guide-lake-shortcut-entry.jpg, shots/verify/guide-lake-sign-face.jpg');
    console.log('PASS：近道起点无草坡/无碰撞体/无牌，导向牌已生成');
  } finally {
    try { ws?.terminate(); } catch {}
    if (browser) kill(browser);
    kill(vite);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAIL', e); process.exit(1); });
