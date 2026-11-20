// 熔岩硬核档实机验收（无头 Edge + CDP）
//   用法：node tests/serve-dist.mjs  然后  node tests/magma_hardcore_probe.mjs
// 验收四件事：
//   ① 4 道裂谷 / 无跳板 / 关闭浪尖抛飞
//   ② Blender 岩石障碍 GLB 全部加载，且每个都有 JS 圆形碰撞代理
//   ③ 腾空船 A/B：带 bottomY/topY 不再穿模，去掉就穿模（证明修复真的生效）
//   ④ 出 2 张实机图（障碍机位 / 裂谷机位）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/magma-hard-${stamp}`);
const port = 9870 + (Number(stamp.slice(-3)) % 20);
const url = process.env.WB_URL || 'http://127.0.0.1:5173/';
const shots = path.resolve('shots/verify');

const child = spawn(edge, [
  '--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=560,320', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, timeout = 90000) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const t = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
const waitJson = async (u, timeout = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch {}
    await sleep(150);
  }
  throw new Error('timeout ' + u);
};
const val = (r) => r?.result?.value ?? r?.exceptionDetails?.exception?.description;

async function main() {
  await fs.mkdir(shots, { recursive: true });
  const tabs = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = tabs.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      console.log('EXC', (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
    }
  });
  // 渲染进程崩掉时不能静默干等：close 里 reject 所有挂起请求
  ws.on('close', () => { for (const p of pending.values()) p.reject(new Error('cdp closed')); pending.clear(); });
  await cdp('Runtime.enable'); await cdp('Page.enable');
  await cdp('Page.reload'); await sleep(1200);

  for (let i = 0; i < 40; i++) {
    if (val(await evaluate(`(() => { const b=document.querySelector('#btn-solo'); return !!b && typeof b.onclick==='function'; })()`)) === true) break;
    await sleep(300);
  }
  for (let i = 0; i < 10; i++) {
    await evaluate(`(() => { const b=document.querySelector('#btn-solo'); if(!b) return 0; b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); b.click(); return 1; })()`);
    await sleep(700);
    if (val(await evaluate(`!!document.querySelector('#menu-main')?.classList.contains('hidden')`)) === true) break;
  }
  let cards = false;
  for (let i = 0; i < 12 && !cards; i++) {
    await evaluate('document.querySelector("#btn-lobby-map")?.click(); 1');
    await sleep(800);
    cards = val(await evaluate('!!document.querySelector(".lp-card[data-map]")')) === true;
  }
  if (!cards) throw new Error('地图抽屉打不开');
  const picked = val(await evaluate(`(() => { const c=[...document.querySelectorAll('.lp-card[data-map]')].find(x=>x.dataset.map==='magma'); if(!c) return 'missing'; c.click(); return 'ok'; })()`));
  if (picked !== 'ok') throw new Error('magma 选不到');
  await sleep(400);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  let ready = false;
  for (let i = 0; i < 90; i++) {
    ready = val(await evaluate('!!window.__game?.localBoat && !!window.__game?.track')) === true;
    if (ready) break;
    await sleep(500);
  }
  if (!ready) {
    const dbg = val(await evaluate(`(() => ({
      href: location.href, title: document.title,
      game: !!window.__game, boat: !!window.__game?.localBoat,
      menuHidden: document.querySelector('#menu-main')?.classList.contains('hidden'),
      lobby: !!document.querySelector('#lobby'),
      lobbyHidden: document.querySelector('#lobby')?.classList.contains('hidden'),
      cards: document.querySelectorAll('.lp-card[data-map]').length,
      startBtn: !!document.querySelector('#btn-start-race'),
      phase: window.__game?.phase, map: window.__game?.mapDef?.id,
    }))()`));
    console.log('DEBUG_NOT_READY', JSON.stringify(dbg));
    throw new Error('__game 未就绪');
  }
  await evaluate(`(() => { const g=window.__game; g.phase='racing'; g.countdownLeft=0; })()`);

  // GLB 是异步加载的，轮询等所有 holder 挂上
  let loaded = 0;
  for (let i = 0; i < 40; i++) {
    loaded = Number(val(await evaluate(`(() => { const o=window.__game?.track?.magmaObstacles||[]; return o.filter(x=>!!x.holder).length; })()`)) || 0);
    if (loaded >= 9) break;
    await sleep(500);
  }

  const diag = val(await evaluate(`(() => {
    const g=window.__game, b=g.localBoat, t=g.track;
    t.updateMechs(1/60, g.elapsed);
    const magmaMech = t.mechColliders.filter(c => typeof c.type==='string' && c.type.startsWith('magma'));
    return {
      map: g.mapDef.id,
      faults: t.faults.map(f => ({ gate:f.gate, width:f.width, minSpeed:f.minSpeed })),
      jumpPads: (t.jumpPads||[]).length,
      waveLaunchEnabled: b.waveLaunchEnabled,
      obstacles: (t.magmaObstacles||[]).length,
      obstacleHolders: (t.magmaObstacles||[]).filter(o=>!!o.holder).length,
      obstacleProxies: t.shoreColliders.filter(c=>c.type==='magmaObstacle').length,
      proxiesWithHeight: t.shoreColliders.filter(c=>c.type==='magmaObstacle' && Number.isFinite(c.bottomY) && Number.isFinite(c.topY)).length,
      magmaMech: magmaMech.length,
      magmaMechWithHeight: magmaMech.filter(c=>Number.isFinite(c.bottomY) && Number.isFinite(c.topY)).length,
      shortcuts: (t.shortcuts||[]).map(s => ({ from:s.from, to:s.to, width:s.width,
        points:(s.points||[]).length, renderPoints:(s.renderPoints||[]).length })),
      // 沿近道折线逐 2m 放船并跑 constrain：漂移过大 = 近道被主道护栏拉回去（空气墙）
      shortcutWalk: (() => {
        const out = [];
        for (const sc of t.shortcuts || []) {
          let maxDrift = 0;
          for (let i = 0; i < sc.points.length - 1; i++) {
            const a = sc.points[i], c = sc.points[i + 1];
            const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz) || 1;
            const n = Math.max(1, Math.ceil(L / 2));
            for (let k = 0; k <= n; k++) {
              const u = k / n, x = a[0] + dx * u, z = a[1] + dz * u;
              b.pos.x = x; b.pos.z = z; b.heading = Math.atan2(dx, dz);
              b.speed = 18; b.vel.set(dx / L * 18, dz / L * 18);
              b.airborne = false; b.waveJump = false; b.onCoaster = null;
              t.constrain(b);
              maxDrift = Math.max(maxDrift, Math.hypot(b.pos.x - x, b.pos.z - z));
            }
          }
          out.push({ span: sc.from + '-' + sc.to, maxDrift: +maxDrift.toFixed(2) });
        }
        return out;
      })(),
      // 近道中点的「冷却航道」遮罩 R 通道：>0 才说明脚下不是活岩浆
      shortcutMaskR: (() => {
        const sc=(t.shortcuts||[])[0], img=g.water?.uniforms?.uLavaTrack?.value?.image;
        const area=g.water?.uniforms?.uLavaTrackArea?.value;
        if (!sc || !img || !area || !img.getContext) return -1;
        const mid=sc.points[Math.floor(sc.points.length/2)];
        const S=img.width;
        const px=Math.max(0,Math.min(S-1,Math.round((mid[0]-area.x)*area.z*S)));
        const py=Math.max(0,Math.min(S-1,Math.round((mid[1]-area.y)*area.z*S)));
        return img.getContext('2d').getImageData(px,py,1,1).data[0];
      })(),
    };
  })()`));
  console.log('DIAG', JSON.stringify(diag, null, 1));

  // 出 2 张实机图（必须在物理 A/B 之前：A/B 会一次性跑 72 帧，
  // 同步里刷出的水花特效偶尔会把 Effekseer 渲染进程带崩）。
  const shot = async (expr, file) => {
    const r = await evaluate(`(() => { ${expr}
      document.querySelector('#ui-root')?.style?.setProperty('display','none');
      return 'ok';
    })()`);
    if (val(r) !== 'ok') throw new Error('机位设置失败 ' + file);
    await sleep(1600);
    const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 78 });
    await fs.writeFile(path.join(shots, file), Buffer.from(s.data, 'base64'));
  };
  await shot(`(() => {
    const g=window.__game, b=g.localBoat, t=g.track;
    const o=(t.magmaObstacles||[]).find(x=>!!x.holder) || t.magmaObstacles[0];
    const N=t.gates.length, ga=t.gates[o.gate], gb=t.gates[(o.gate+1)%N];
    const dx=gb[0]-ga[0], dz=gb[1]-ga[1], L=Math.hypot(dx,dz)||1;
    const ux=dx/L, uz=dz/L;
    b.resetTo(ga[0]-ux*16, ga[1]-uz*16, Math.atan2(ux,uz));
    b.speed=0; b.vel.set(0,0); b.airborne=false;
    for (let i=0;i<120;i++) g.cameraRig.follow(b, 1/60);
  })()`, 'magma-hardcore-obstacles.jpg');

  await shot(`(() => {
    const g=window.__game, b=g.localBoat, t=g.track, f=t.faults[0];
    b.resetTo(f.cx - f.fx*30, f.cz - f.fz*30, Math.atan2(f.fx,f.fz));
    b.speed=0; b.vel.set(0,0); b.airborne=false;
    for (let i=0;i<120;i++) g.cameraRig.follow(b, 1/60);
  })()`, 'magma-hardcore-fault.jpg');

  await shot(`(() => {
    const g=window.__game, b=g.localBoat, t=g.track, sc=t.shortcuts[0];
    const p=sc.points[0], q=sc.points[1];
    const ux=q[0]-p[0], uz=q[1]-p[1];
    b.resetTo(p[0], p[1], Math.atan2(ux,uz));
    b.speed=0; b.vel.set(0,0); b.airborne=false;
    for (let i=0;i<120;i++) g.cameraRig.follow(b, 1/60);
  })()`, 'magma-hardcore-shortcut.jpg');
  console.log('SHOTS', 'magma-hardcore-obstacles.jpg', 'magma-hardcore-fault.jpg', 'magma-hardcore-shortcut.jpg');

  // 腾空 A/B：同一条穿过滚石的轨迹，带高度范围 vs 剥掉高度范围
  const ab = val(await evaluate(`(() => {
    const g=window.__game, b=g.localBoat, t=g.track;
    const T = g.elapsed + 3;
    t.updateMechs(1/60, T);
    const roller = t.magmaHazards.rollers[0];
    if (roller) roller.shoveT = 0;
    const c = t.mechColliders.find(x => x.type==='magmaRoller');
    if (!c) return { error: 'no roller collider' };
    const cx=c.x, cz=c.z, cr=c.r;
    const run = (strip) => {
      b.resetTo(cx - 14, cz, Math.PI/2);   // 沿 +X 直冲滚石
      b.speed = 26; b.vel.set(26, 0);
      b.airborne = true; b.waveJump = true; b.airTime = 0;
      b.pos.y = 3; b.vy = 0; b.stunTimer = 0;
      b.surfaceLandingY = null; b.underwaterLandingY = null;
      let minD = 1e9;
      for (let i=0;i<36;i++) {
        t.updateMechs(1/60, T);            // 固定 T：滚石不动，纯测碰撞
        let cols = [...g.colliders, ...t.shoreColliders, ...t.mechColliders];
        if (strip) cols = cols.map(x => (typeof x.type==='string' && x.type.startsWith('magma'))
          ? { ...x, bottomY: undefined, topY: undefined } : x);
        b.updateLocal(1/60, {throttle:1,steer:0,drift:false,nitro:false}, T + i/60, cols, g.mapDef.boundary);
        minD = Math.min(minD, Math.hypot(b.pos.x-cx, b.pos.z-cz));
      }
      return +minD.toFixed(2);
    };
    const fixed = run(false);
    const stripped = run(true);
    return { rollerRadius: cr, pushOutRadius: +(cr+1.3).toFixed(2), minDistFixed: fixed, minDistNoHeight: stripped };
  })()`));
  console.log('AIRBORNE_AB', JSON.stringify(ab));
}

main().catch((e) => { console.error('FAIL', e.message); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch {}
  // child.kill() 只杀启动进程，Edge 的 GPU/渲染子进程会留成孤儿
  if (child.pid) spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
});
