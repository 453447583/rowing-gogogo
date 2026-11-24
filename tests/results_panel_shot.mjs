// 结算面板（落日橙紫霓虹）视觉验收：不开一局比赛，直接把面板灌上假数据截图。
//   node tests/results_panel_shot.mjs
// 出图：shots/verify/results-neon-final.jpg / -eight.jpg / -round.jpg
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';

const PORT = 5277;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/results-' + Date.now());
const cdpPort = 9500 + Math.floor(Math.random() * 90);
const out = path.resolve('shots/verify');
await fs.mkdir(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const ok = (c, l, x) => {
  if (c) console.log('  ✓ ' + l);
  else { fail++; console.error('  ✗ ' + l, x === undefined ? '' : JSON.stringify(x)); }
};

const vite = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
await vite.listen();

const child = spawn(edge, [
  '--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
  '--window-size=1360,800', `http://127.0.0.1:${PORT}/`,
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const errors = [];
const cdp = (m, p = {}) => {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p }));
  return Promise.race([
    new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp timeout: ' + m)), 90000)),
  ]);
};
const ev = async (e) => {
  const r = await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const waitFor = async (expr, label, tries = 100) => {
  for (let i = 0; i < tries; i++) {
    if (await ev(expr).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
};
const shot = async (name) => {
  const res = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  await fs.writeFile(path.join(out, name + '.jpg'), Buffer.from(res.data, 'base64'));
  console.log('  shot -> shots/verify/' + name + '.jpg');
};

const RENDER = (spec) => `(async () => {
  const ui = await import('/src/ui/ui.js');
  for (const id of ['menu-main', 'menu-boat', 'menu-map', 'lobby', 'podium', 'hud']) ui.hide(id);
  document.querySelectorAll('#ui-root > .panel').forEach((p) => { if (p.id !== 'results') p.classList.add('hidden'); });
  const panel = document.getElementById('results');
  panel.classList.remove('hidden');
  panel.style.setProperty('--nr-grid', ${JSON.stringify(spec.grid)});
  document.getElementById('results-title').textContent = ${JSON.stringify(spec.title)};
  const cols = document.getElementById('results-cols');
  cols.classList.toggle('many', ${spec.columns.length} > 4);
  cols.innerHTML = ${JSON.stringify(spec.columns.map((c, i) => {
    const cls = [i === 0 ? 'c-first' : i === 1 ? 'c-name' : i === spec.columns.length - 1 ? 'c-last' : 'c-mid'];
    if (i > 0 && !spec.columns[i - 1]) cls.push('no-sep');
    return `<span class="${cls.join(' ')}">${c}</span>`;
  }).join(''))};
  document.getElementById('results-body').innerHTML = ${JSON.stringify(Array.isArray(spec.rows) ? spec.rows.join('') : spec.rows)};
  document.getElementById('btn-back-lobby').textContent = ${JSON.stringify(spec.btn)};
  document.getElementById('btn-exit-results').classList.remove('hidden');
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const p = panel.getBoundingClientRect();
  const shell = panel.querySelector('.nr-body').getBoundingClientRect();
  return {
    w: Math.round(p.width), h: Math.round(p.height),
    bodyH: Math.round(shell.height),
    vw: document.documentElement.clientWidth, vh: innerHeight,
    dx: Math.round((p.left + p.right) / 2 - document.documentElement.clientWidth / 2),
    dy: Math.round((p.top + p.bottom) / 2 - innerHeight / 2),
    scroll: (() => { const l = panel.querySelector('.nr-list'); return l.scrollHeight > l.clientHeight + 1; })(),
    btnVisible: (() => { const b = document.getElementById('btn-back-lobby').getBoundingClientRect(); return b.bottom <= innerHeight + 1 && b.height > 20; })(),
    cols: panel.querySelectorAll('#results-cols span').length,
    rows: panel.querySelectorAll('#results-body .nr-row').length,
  };
})()`;

const MEDALS = [
  '/icons/ui/75_ui_medal_gold.png',
  '/icons/ui/76_ui_medal_silver.png',
  '/icons/ui/77_ui_medal_bronze.png',
];
const medalHtml = (i) => (i < 3
  ? `<span class="nr-medal"><img class="medal-ico" src="${MEDALS[i]}" alt=""></span>`
  : `<span class="nr-medal"><b class="nr-num">${i + 1}</b></span>`);
const finalRow = (name, boat, score, me, i) => `<div class="nr-row${me ? ' me' : ''}">`
  + medalHtml(i)
  + `<span class="nr-name">${name}</span>`
  + `<span class="nr-boat">${boat}</span>`
  + `<span class="nr-score">${score} 分</span></div>`;

const finalSpec = {
  title: '比赛结束 · 总排名',
  grid: '48px minmax(110px, 1fr) 148px 104px',
  columns: ['', '选手', '赛艇', '总积分'],
  btn: '再来一局',
  expected: 1,
  rows: [finalRow('ok没问题', '青锋号', 1, true, 0)],
};
const eightSpec = {
  ...finalSpec,
  expected: 8,
  rows: [
    finalRow('ok没问题', '青锋号', 42, true, 0),
    finalRow('浪里白条', '赤焰号', 38, false, 1),
    finalRow('夜航船', '绯鲨号', 31, false, 2),
    finalRow('浪花骑士', '流光号', 27, false, 3),
    finalRow('KAI', '琥珀号', 19, false, 4),
    finalRow('海风不燥', '磐石号', 12, false, 5),
    finalRow('阿飞', '长鲸号', 6, false, 6),
    finalRow('新手船长', '牛来号', 0, false, 7),
  ],
};
const roundSpec = {
  title: '第 2 局结果',
  grid: '48px minmax(110px, 1fr) 116px 92px 84px 72px',
  columns: ['名次', '选手', '赛艇', '成绩', '最快圈', '积分'],
  btn: '开始下一局',
  expected: 6,
  rows: [
    ['ok没问题', '青锋号', '2:14.38', '0:42.11', '+10', true],
    ['浪里白条', '赤焰号', '2:16.02', '0:42.90', '+7', false],
    ['夜航船', '绯鲨号', '2:19.55', '0:44.02', '+5', false],
    ['浪花骑士', '流光号', '2:21.70', '0:45.31', '+3', false],
    ['KAI', '琥珀号', '<span class="nr-dnf">未完赛</span>', '0:46.02', '+1', false],
    ['海风不燥', '磐石号', '<span class="nr-dnf">未完赛</span>', '—', '+1', false],
  ].map((r, i) => `<div class="nr-row${r[5] ? ' me' : ''}">`
    + medalHtml(i)
    + `<span class="nr-name">${r[0]}${i === 4 ? '<i class="nr-ai">AI</i>' : ''}</span>`
    + `<span class="nr-boat">${r[1]}</span>`
    + `<span class="nr-val">${r[2]}</span>`
    + `<span class="nr-val">${r[3]}</span>`
    + `<span class="nr-score">${r[4]}<i>总 ${30 - i * 4}</i></span></div>`).join(''),
};

try {
  // 等 CDP 起来
  let list = null;
  for (let i = 0; i < 60 && !list; i++) {
    await sleep(400);
    list = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json()).catch(() => null);
  }
  const page = list?.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到可调试页面');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
    }
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await cdp('Runtime.evaluate', { expression: 'location.reload()' });
  await sleep(1200);
  await waitFor(`!!document.getElementById('results') && !!document.getElementById('ui-root')`, '页面就绪', 150);
  await sleep(1500);

  for (const [name, spec] of [['final', finalSpec], ['eight', eightSpec], ['round', roundSpec]]) {
    const geo = await ev(RENDER(spec));
    console.log(`  ${name}:`, JSON.stringify(geo));
    ok(Math.abs(geo.dx) <= 3, `${name} 水平居中`, geo.dx);
    ok(Math.abs(geo.dy) <= 3, `${name} 垂直居中`, geo.dy);
    ok(!geo.scroll, `${name} 没有内部滚动`, geo);
    ok(geo.btnVisible, `${name} 主按钮完整可见`, geo.btnVisible);
    ok(geo.rows === spec.expected, `${name} 行数正确`, geo.rows);
    ok(geo.cols === spec.columns.length, `${name} 列数正确`, geo.cols);
    await shot('results-neon-' + name);
  }
  ok(!errors.length, '无页面异常', errors.slice(0, 2));
} catch (e) {
  fail++;
  console.error('results panel probe FAIL', e.message);
  try { await shot('results-neon-fail'); } catch {}
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await vite.close().catch(() => {});
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log(fail ? `\n结算面板：${fail} 项失败` : '\n结算面板：全部通过');
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
}
