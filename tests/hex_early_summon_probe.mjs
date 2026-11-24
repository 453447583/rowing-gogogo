// 海克斯「前 4 层关掉 BOSS 被动召唤」验收（2026-11-22 用户指定）
//
//   node tests/hex_early_summon_probe.mjs
//
// 用户口径：前 4 层连 BOSS 的血量阈值召唤也一起关掉，第 5 层再恢复。
// 这条只能在浏览器里验：summonWaves 是 startStage 里按层数现算的实例字段，
// 纯数据探针看不到。做法是把计划里的 BOSS 强制改成「有 4 波召唤」的炎狱火龙
// （dragon_inferno），再看第 2 层与第 5 层的 summonWaves 长度。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/hex-summon-' + Date.now());
const portSeed = Date.now() % 400;
const port = 9700 + portSeed;
const httpPort = 5700 + portSeed;
const server = spawn(process.execPath, [path.resolve('tests/serve-dist.mjs')], {
  stdio: 'ignore', env: { ...process.env, PORT: String(httpPort) },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
{
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { const r = await fetch('http://127.0.0.1:' + httpPort + '/'); ready = r.ok; } catch { /* */ }
    if (!ready) await wait(200);
  }
  if (!ready) { server.kill('SIGKILL'); throw new Error('静态服务没起来'); }
}
const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  '--remote-debugging-port=' + port, '--user-data-dir=' + profile, '--window-size=1280,760',
  'http://127.0.0.1:' + httpPort + '/'], { stdio: 'ignore' });

let ws;
let failed = 0;
const report = (ok, msg) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

try {
  let tabs = null;
  for (let i = 0; i < 90 && !tabs; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json'); if (r.ok) tabs = await r.json(); } catch { /* */ }
    await wait(200);
  }
  if (!tabs) throw new Error('headless Edge did not come up');
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl, { perMessageDeflate: false });
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
  const sleep = (ms) => cdp('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, ' + ms + '))', awaitPromise: true });
  const ev = async (expr) => {
    const r = await cdp('Runtime.evaluate', {
      expression: '(function(){ try { return (' + expr + '); } catch (e) { return "ERR:" + e.message; } })()',
      returnByValue: true,
    });
    if (r.exceptionDetails) return 'EXC:' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };
  const waitFor = async (expr, timeout = 30000, label = expr) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      last = await ev(expr);
      if (last) return last;
      await sleep(250);
    }
    throw new Error('timeout waiting for ' + label + ' (last=' + JSON.stringify(last) + ')');
  };

  await sleep(1200);
  await waitFor('typeof document.querySelector("#btn-solo")?.onclick === "function"', 30000, 'btn-solo');
  await ev('document.querySelector("#btn-solo").click()');
  await waitFor('!document.querySelector("#lobby").classList.contains("hidden")', 30000, 'lobby');
  await ev('document.querySelector("#btn-lobby-mode").click()');
  await waitFor('!!document.querySelector(\'#lobby-pick-body [data-mode="boss"][data-variant="hex"]\')', 30000, 'hex 模式卡');
  await ev('document.querySelector(\'#lobby-pick-body [data-mode="boss"][data-variant="hex"]\').click()');
  await ev('(function(){const c=document.querySelector("#btn-lobby-pick-close");if(c)c.click();return 1})()');
  await ev('document.querySelector("#btn-start-race").click()');
  await waitFor('!!window.__game?.bossMode', 45000, 'bossMode');
  const mode = await ev('JSON.stringify({ variant: window.__game.bossMode.variant, stage: window.__game.bossMode.stage })');
  console.log('  进入模式：', mode);

  // 强制把计划里的第 2 / 第 5 层换成炎狱火龙（数据里 summon 4 波），再看 summonWaves
  const probe = async (stage) => ev(`(function(){
    const b = window.__game.bossMode;
    b.hexPlan.stages[${stage} - 1] = { ...b.hexPlan.stages[${stage} - 1], bossId: 'dragon_inferno' };
    b.startStage(${stage});
    const defWaves = (b.bossDef.summon || []).length;
    return JSON.stringify({
      stage: b.stage, boss: b.bossDef.id, defWaves, waves: b.summonWaves.length,
      skills: (b.hexEntry?.skills || []).filter((id) => /Gate/.test(id)).length,
    });
  })()`);

  const l2 = JSON.parse(await probe(2));
  console.log('  第 2 层：', l2);
  report(l2.defWaves > 0, `第 2 层确实是「自带召唤波」的 BOSS（defWaves=${l2.defWaves}）`);
  report(l2.waves === 0, `第 2 层被动召唤已关闭（waves=${l2.waves}）`);
  report(l2.skills === 0, '第 2 层技能里也没有召唤门');

  const l3 = JSON.parse(await probe(3));
  report(l3.waves === 0, `第 3 层被动召唤已关闭（waves=${l3.waves}）`);

  const l5 = JSON.parse(await probe(5));
  console.log('  第 5 层：', l5);
  report(l5.waves === l5.defWaves && l5.waves > 0, `第 5 层被动召唤已恢复（waves=${l5.waves}/${l5.defWaves}）`);

  // 经典怪物模式不能被误伤：同一只火龙的被动召唤要照常存在
  const classic = await ev(`(function(){
    const b = window.__game.bossMode;
    b.variant = 'classic';
    b.startStage(2);
    return JSON.stringify({ variant: b.variant, waves: b.summonWaves.length });
  })()`);
  const c = JSON.parse(classic);
  console.log('  经典模式第 2 层：', c);
  report(c.waves > 0, `经典怪物模式的被动召唤没被误关（waves=${c.waves}）`);
} catch (e) {
  failed += 1;
  console.error('探针异常：', e.message);
} finally {
  try { ws?.close(); } catch { /* */ }
  child.kill('SIGKILL');
  server.kill('SIGKILL');
}
console.log(failed ? `\n海克斯前 4 层召唤关闭：${failed} 项失败` : '\n海克斯前 4 层召唤关闭：全部通过');
process.exit(failed ? 1 : 0);
