// 领奖台验收：牛来号要**自己站上领奖台并跳舞**（原来克隆体共享原船骨架 → 那一格空白）。
// 用法：node tests/cow_podium_probe.mjs [baseUrl]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const base = process.argv[2] || 'http://127.0.0.1:5173/';
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/cow-podium-' + Date.now());
const port = 9820 + Math.floor(Math.random() * 40);
const outDir = 'shots/verify/cow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fs.mkdir(outDir, { recursive: true });
const child = spawn(edge, ['--headless', '--no-sandbox', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1024,640', base], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + m)); } }, 60000);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); res(v); }, reject: (e) => { clearTimeout(timer); rej(e); } });
  });
};
const evaluate = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const shot = async (name) => {
  const s = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  await fs.writeFile(path.join(outDir, name), Buffer.from(s.data, 'base64'));
  console.log('  shot →', path.join(outDir, name));
};
const poll = async (expr, ms = 30000, label = '') => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evaluate(expr)) return true;
    await sleep(250);
  }
  console.log('  ! 超时未满足:', label || expr);
  return false;
};
const cleanup = async () => {
  try { ws?.terminate(); } catch {}
  spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
};

const errors = [];
try {
  let tabs = null;
  for (let i = 0; i < 80 && !tabs; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) tabs = await r.json(); } catch {}
    await sleep(200);
  }
  if (!tabs) throw new Error('Edge DevTools 没起来');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const t = m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text;
      if (!/texImage2D|effekseer/i.test(t)) errors.push(t);
    }
  });
  await cdp('Runtime.enable'); await cdp('Page.enable');

  await poll(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 60000, '主菜单');
  await evaluate(`document.querySelector('#btn-solo').click()`);
  await poll(`!!document.querySelector('#btn-lobby-boat')?.offsetParent`, 30000, '大厅');
  await evaluate(`document.querySelector('#btn-lobby-boat').click()`);
  await sleep(600);
  await evaluate(`document.querySelector('[data-boat="cow"]').click()`);
  await sleep(1500);
  await evaluate(`document.querySelector('#btn-lobby-pick-close')?.click()`);
  await sleep(400);
  await evaluate(`document.querySelector('#btn-start-race')?.click()`);
  await poll(`!!window.__game?.boats?.size > 0`, 60000, '比赛起局');
  await poll(`[...(window.__game?.boats?.values?.() || [])].some((x) => x.def?.id === 'cow' && x.modelRoot)`, 40000, '牛模型加载');
  // 等倒计时结束：倒计时期间截图上会压一个巨大的 "3"
  await poll(`window.__game?.phase === 'racing'`, 60000, '倒计时结束');
  await sleep(1200);
  // 真实流程里 showPodium 前会 showScreen('podium') 把 HUD 收掉，这里手动收
  await evaluate(`document.querySelector('#hud')?.classList.add('hidden')`);

  // 直接搭领奖台：entries 按玩家 id 找船
  const built = await evaluate(`(() => {
    const g = window.__game;
    const me = [...g.boats.entries()].find(([, b]) => b.def?.id === 'cow');
    if (!me) return { noCow: true };
    g.showPodium([{ id: me[0], boatId: 'cow', name: '牛来号' }]);
    return { ok: true, myId: me[0] };
  })()`);
  console.log('BUILD', JSON.stringify(built));
  await sleep(4000); // 软件渲染 1~2fps，等镜头切过去 + 舞跳几帧

  const diag = await evaluate(`(() => {
    const g = window.__game;
    const pod = g.podiumGroup;
    if (!pod) return { noPodium: true };
    const clones = pod.children.filter((o) => o.userData?.podiumBoat);
    const c = clones[0];
    if (!c) return { noClone: true, children: pod.children.length };
    let cloneSkin = null;
    c.traverse((o) => { if (o.isSkinnedMesh && !cloneSkin) cloneSkin = o; });
    const src = g.localBoat?.modelRoot;
    let srcSkin = null;
    src?.traverse((o) => { if (o.isSkinnedMesh && !srcSkin) srcSkin = o; });
    const boneWorld = (skin) => {
      if (!skin) return null;
      const b = skin.skeleton.bones[0];
      const p = b.getWorldPosition(new b.position.constructor());
      return [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)];
    };
    const mixer = c.userData.mixer;
    let maxY = -Infinity;
    c.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
      if (bb.max.y > maxY) maxY = bb.max.y;
    });
    let smile = null;
    c.traverse((o) => {
      const d = o.morphTargetDictionary;
      if (d && 'smile' in d && o.morphTargetInfluences) smile = +o.morphTargetInfluences[d.smile].toFixed(2);
    });
    return {
      clones: clones.length,
      hasSkinnedClone: !!cloneSkin,
      ownSkeleton: !!(cloneSkin && srcSkin && cloneSkin.skeleton !== srcSkin.skeleton),
      cloneBoneWorld: boneWorld(cloneSkin),
      sourceBoneWorld: boneWorld(srcSkin),
      mixer: !!mixer,
      mixerTime: mixer ? +mixer.time.toFixed(2) : null,
      clip: mixer ? mixer._actions?.[0]?._clip?.name : null,
      cloneTopY: +maxY.toFixed(2),
      podiumPos: [+pod.position.x.toFixed(1), +pod.position.z.toFixed(1)],
      smile,
    };
  })()`);
  console.log('PODIUM', JSON.stringify(diag));
  await shot('40-podium.jpg');

  // 量"脚底到底在哪"：蒙皮包围盒的 min.y 就是它真正踩着的平面
  const feet = await evaluate(`(() => {
    const g = window.__game;
    const b = [...g.boats.values()].find((x) => x.def?.id === 'cow');
    const pick = (root) => { let s = null; root?.traverse((o) => { if (o.isSkinnedMesh && !s) s = o; }); return s; };
    const boxOf = (skin) => {
      if (!skin) return null;
      skin.skeleton.update(); skin.computeBoundingBox();
      const bb = skin.boundingBox.clone().applyMatrix4(skin.matrixWorld);
      return [+bb.min.y.toFixed(2), +bb.max.y.toFixed(2)];
    };
    const pod = g.podiumGroup;
    const c = pod?.children.find((o) => o.userData?.podiumBoat);
    return {
      boatSkinnedBox: boxOf(pick(b?.modelRoot)),
      boatGroupY: +b.group.position.y.toFixed(2),
      innerModelY: +b.modelRoot.children[0].position.y.toFixed(2),
      innerScale: +b.modelRoot.children[0].scale.x.toFixed(3),
      clonePosY: c ? +c.position.y.toFixed(2) : null,
      cloneSkinnedBox: boxOf(pick(c)),
    };
  })()`);
  console.log('FEET', JSON.stringify(feet));

  // 再等两拍，确认舞在推进（mixer.time 在涨）
  await sleep(2500);
  const t2 = await evaluate(`(() => {
    const pod = window.__game.podiumGroup;
    const c = pod?.children.find((o) => o.userData?.podiumBoat);
    return c?.userData.mixer ? +c.userData.mixer.time.toFixed(2) : null;
  })()`);
  console.log('MIXER_TIME_LATER', t2);
  await shot('41-podium-later.jpg');

  console.log('ERRORS', errors.length ? errors.slice(0, 4) : '无');
} finally {
  await cleanup();
}
