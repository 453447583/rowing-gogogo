// 道具赛「听觉防守」验收探针
//   node tests/item_audio_probe.mjs        （需先启动 dev server :5199）
//
// 验四件事：
//   ① 每件道具（含 BOSS 道具）都有音效，不会静音出手
//   ② 所有受击类型都有声音 —— 以前 14 种里只有 4 种有映射
//   ③ 来袭预警音会在"被锁定"时响，而且左右声道跟着来袭方向变（听声辨位）
//   ④ 护盾挡下攻击时也有独立的"铛"声，而不是什么都不响
//
// 不截图、不依赖联机服务器，单人道具模式即可。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const stamp = `${Date.now()}`;
const profile = path.resolve(`D:/3dgame-tmp/browser/itemaudio-${stamp}`);
const port = 9780 + (Number(stamp.slice(-3)) % 40);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/';

const child = spawn(edge, [
  '--headless=new', '--use-angle=d3d11', '--no-sandbox',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280x720', url,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
function cdp(method, params = {}, timeout = 90000) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`cdp timeout: ${method}`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = (expression) => cdp('Runtime.evaluate', {
  expression, awaitPromise: true, returnByValue: true,
});
async function waitForJson(u, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(u); if (r.ok) return r.json(); } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error(`timeout ${u}`);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  PASS', label); }
  else { fail++; console.log('  FAIL', label, JSON.stringify(detail)); }
}

async function main() {
  const info = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('  EXC', msg.params.exceptionDetails?.exception?.description?.slice(0, 200) || '');
    }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Page.reload');
  await sleep(1800);

  // 进单人道具模式
  let t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!window.__audio && !!document.querySelector("#btn-solo")')).result?.value) break;
    await sleep(250);
  }
  await evaluate('document.querySelector("#btn-solo")?.click(); 1');
  await sleep(900);
  await evaluate('document.querySelector("#btn-lobby-mode")?.click(); 1');
  await sleep(600);
  await evaluate(`(() => { const c = document.querySelector('[data-mode="item"]'); if (c) c.click(); return 1; })()`);
  await sleep(500);
  await evaluate('document.querySelector("#btn-start-race")?.click(); 1');
  t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 60000) {
    if ((await evaluate('!!(window.__game && window.__game.items && window.__game.localBoat)')).result?.value) {
      ready = true; break;
    }
    await sleep(200);
  }
  ok(ready, '道具赛已进入');
  if (!ready) throw new Error('进不了道具赛');

  // 解锁音频 + 挂播放记录（spy 的是同一个单例，Items.js 里 audio.play 会经过它）
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
  await sleep(400);
  const setup = await evaluate(`(() => {
    const a = window.__audio, g = window.__game;
    window.__sfxLog = [];
    const orig = a.play.bind(a);
    a.play = (name, opts) => { window.__sfxLog.push({ name, pan: opts?.pan ?? null, vol: opts?.vol ?? null }); return orig(name, opts); };
    return JSON.stringify({ audioReady: a.ready, itemReady: !!g.items, myId: g.myId });
  })()`);
  const st = JSON.parse(setup.result?.value || '{}');
  ok(st.audioReady === true, 'AudioContext 已解锁', st);

  // ① 每件道具都有音效
  const cover = await evaluate(`(async () => {
    const items = await import('/src/game/Items.js');
    const a = window.__audio;
    const ids = [...Object.keys(items.ITEM_DEFS), ...Object.keys(items.BOSS_ITEM_DEFS)];
    const missing = ids.filter((id) => !a.hasSfx('item_' + id));
    return JSON.stringify({ total: ids.length, missing });
  })()`);
  const cv = JSON.parse(cover.result?.value || '{}');
  ok(cv.missing?.length === 0, `${cv.total} 件道具全部有音效`, cv.missing);

  // 受击音效完整映射：给每一种 fx 发一条命中消息，检查有没有声音
  const hits = await evaluate(`(async () => {
    const g = window.__game, it = g.items, me = g.localBoat;
    const fxList = ['sink','halfSpeed','missileHit','capsize','octoGrab','slow',
      'ink','inkStun','bubbleLift','geyserLift','void','spin','reverse','someNewFx'];
    const out = [];
    const oldShield = me.shieldTimer; me.shieldTimer = 0;
    for (const fx of fxList) {
      window.__sfxLog.length = 0;
      it.handleNet({ t:'itemHit', id: g.myId, by:'rival', fx, dur:1, x: me.pos.x, z: me.pos.z });
      out.push([fx, window.__sfxLog.map((s) => s.name)]);
    }
    me.shieldTimer = oldShield;
    return JSON.stringify(out);
  })()`);
  const hitRows = JSON.parse(hits.result?.value || '[]');
  const silent = hitRows.filter(([, names]) => !names.length);
  ok(silent.length === 0, `全部 ${hitRows.length} 种受击都有声音（含未知 fx 兜底）`, silent);
  const soundKinds = new Set(hitRows.flatMap(([, names]) => names));
  ok(soundKinds.size >= 5, `受击音按道具类型区分（${soundKinds.size} 种）`, [...soundKinds]);

  // ③ 来袭预警 + 左右声道：船头朝 +z，右侧( dx>0 )来袭 pan 应为正，左侧为负
  const warn = await evaluate(`(() => {
    const g = window.__game, it = g.items, me = g.localBoat;
    me.heading = 0; me.shieldTimer = 0;
    const x = me.pos.x, z = me.pos.z;
    const out = {};
    // 两次用不同攻击者 id：同一个 id + 同一道具 500ms 内会被去重（防止出手和特效两处重复响）
    for (const [key, dx, who] of [['right', 40, 'rivalA'], ['left', -40, 'rivalB']]) {
      window.__sfxLog.length = 0;
      it.handleNet({ t:'itemUse', id:who, item:'missile', target:g.myId,
        x: x + dx, z, vx: 0, vz: 20 });
      out[key] = window.__sfxLog.filter((s) => s.name === 'incoming_alert')
        .map((s) => ({ pan: s.pan, vol: s.vol }));
    }
    return JSON.stringify(out);
  })()`);
  const wr = JSON.parse(warn.result?.value || '{}');
  ok((wr.right || []).length > 0, '被锁定时响起来袭预警音', wr);
  ok((wr.right || []).some((s) => s.pan > 0.3), '右侧来袭 → 声音偏右声道', wr.right);
  ok((wr.left || []).some((s) => s.pan < -0.3), '左侧来袭 → 声音偏左声道', wr.left);
  ok((wr.right || []).some((s) => s.vol < 1), '远处的来袭声比近处小（距离衰减）', wr.right);

  // ④ 护盾拦截音
  const blocked = await evaluate(`(() => {
    const g = window.__game, it = g.items, me = g.localBoat;
    window.__sfxLog.length = 0;
    it.handleNet({ t:'itemFx', id:g.myId, fx:'blocked', by:'rival', x: me.pos.x + 5, z: me.pos.z });
    return JSON.stringify(window.__sfxLog.map((s) => s.name));
  })()`);
  ok((JSON.parse(blocked.result?.value || '[]')).includes('item_blocked'),
    '护盾挡下攻击时响"铛"声', blocked.result?.value);

  console.log(`\n道具音效探针：${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('探针异常：', e);
  process.exitCode = 1;
}).finally(() => {
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  setTimeout(() => process.exit(), 300);
});
