// C 类第二批（23 枚）接入验收探针
//   npm run dev  (5199) 已起 → node tests/icon_c_probe.mjs
//
// 验四件事：
//   ① 23 枚 PNG 都能被浏览器解出来（naturalWidth > 0，不是 404 / 坏图）
//   ② 头像已经全是 <img>，不再有 <svg>（用户要求删掉 SVG 兜底）
//   ③ toast 开头的 🔥❄⚡… 真的换成了 <img class="toast-ico">，且文字里不再残留 emoji
//   ④ 三个原生下拉的选项文字已无 emoji，标签旁挂上了 mf-ico
//
// 全部通过打印 PASS；任何一条不过退出码 1（方便挂进 CI / 一键回归）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.resolve('D:/3dgame-tmp/browser/icon-c-' + Date.now());
const port = 9700 + Math.floor(Math.random() * 50);
const url = process.env.WB_URL || 'http://127.0.0.1:5199/?raceIntro=0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICONS_C = [
  '/icons/avatars/av_anchor.png', '/icons/avatars/av_bot.png', '/icons/avatars/av_diver.png',
  '/icons/avatars/av_sail.png', '/icons/avatars/av_shark.png', '/icons/avatars/av_squid.png',
  '/icons/avatars/av_turtle.png', '/icons/avatars/av_wave.png', '/icons/avatars/av_whale.png',
  '/icons/skills/91_sk_fire.png', '/icons/skills/92_sk_ice.png', '/icons/skills/93_sk_thunder.png',
  '/icons/skills/94_sk_water.png', '/icons/skills/95_sk_blood.png',
  '/icons/events/96_ev_boom.png', '/icons/events/97_ev_enrage.png', '/icons/events/98_ev_shield.png',
  '/icons/events/99_ev_danger.png', '/icons/events/100_ev_melee.png', '/icons/events/101_ev_heal.png',
  '/icons/events/102_ev_core.png', '/icons/events/103_ev_bind.png',
  '/icons/ui/90_ui_crown.png',
];

const child = spawn(edge, ['--headless=new', '--no-sandbox', '--use-angle=d3d11',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--window-size=1280,760', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map();
const cdp = (m, p = {}, t = 120000) => {
  const id = ++seq; ws.send(JSON.stringify({ id, method: m, params: p }));
  return new Promise((res, rej) => {
    const to = setTimeout(() => { pending.delete(id); rej(new Error('cdp timeout ' + m)); }, t);
    pending.set(id, { resolve: (v) => { clearTimeout(to); res(v); }, reject: (e) => { clearTimeout(to); rej(e); } });
  });
};
const ev = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r?.result?.value;
};
async function waitFor(expr, ms = 45000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(250); } return false; }
async function waitJson(u, ms = 25000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch {} await sleep(150); } throw new Error('timeout ' + u); }

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const fails = [];
const ok = (cond, label, extra = '') => {
  if (cond) console.log('  ok   ' + label);
  else { console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')); fails.push(label); }
};

try {
  const tabs = await waitJson(`http://127.0.0.1:${port}/json`);
  ws = new WebSocket((tabs.find((t) => t.type === 'page') || tabs[0]).webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.navigate', { url });
  await waitFor(`typeof document.querySelector('#btn-solo')?.onclick === 'function'`, 45000);
  await sleep(600);

  // ---------- ① 23 枚素材能否解码 ----------
  console.log('\n① C 类 23 枚素材');
  const load = await ev(`(async () => {
    const list = ${JSON.stringify(ICONS_C)};
    const out = [];
    for (const src of list) {
      const img = new Image();
      const r = await new Promise((res) => {
        img.onload = () => res({ ok: img.naturalWidth > 0, w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => res({ ok: false, w: 0, h: 0 });
        img.src = src;
      });
      out.push({ src, ...r });
    }
    return out;
  })()`);
  for (const it of load) ok(it.ok, it.src.split('/').pop() + ` ${it.w}×${it.h}`);

  // ---------- ② 头像已换 PNG ----------
  console.log('\n② 头像（8 内置 + AI）');
  const av = await ev(`(async () => {
    const m = await import('/src/ui/avatars.js');
    const ids = m.AVATAR_DEFS.map((d) => d.id);
    const rows = [];
    const wait = (el) => new Promise((res) => {
      const im = el.querySelector('img');
      if (!im) return res({ tag: el.firstElementChild?.tagName || 'none' });
      if (im.complete && im.naturalWidth) return res({ tag: 'IMG', src: im.getAttribute('src'), w: im.naturalWidth });
      im.onload = () => res({ tag: 'IMG', src: im.getAttribute('src'), w: im.naturalWidth });
      im.onerror = () => res({ tag: 'IMG', src: im.getAttribute('src'), w: 0 });
      setTimeout(() => res({ tag: 'IMG', src: im.getAttribute('src'), w: im.naturalWidth }), 4000);
    });
    for (const id of [...ids, '__ai__']) {
      const box = document.createElement('div');
      box.innerHTML = id === '__ai__' ? m.avatarMarkup('whatever', true) : m.avatarMarkup(id, false);
      document.body.appendChild(box);
      rows.push({ id, ...(await wait(box)) });
      box.remove();
    }
    // 自定义上传图仍然走 dataURL
    const custom = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const box2 = document.createElement('div');
    box2.innerHTML = m.avatarMarkup(custom, false);
    rows.push({ id: 'custom', tag: box2.querySelector('img')?.getAttribute('src')?.slice(0, 22) || '' });
    return rows;
  })()`);
  for (const r of av) {
    if (r.id === 'custom') {
      ok(r.tag.startsWith('data:image/png;base64,'), 'custom dataURL 原样保留', String(r.tag));
      continue;
    }
    ok(r.tag === 'IMG' && r.w > 0, `avatars.js → ${r.id} 用 <img> PNG`, JSON.stringify(r));
  }

  // ---------- ③ toast 前缀图标 ----------
  console.log('\n③ toast 开头 emoji → PNG');
  const t1 = await ev(`(async () => {
    const ui = await import('/src/ui/ui.js');
    ui.toast('🔥 熔岩海啸！侧向跑出火墙通道');
    await new Promise((r) => setTimeout(r, 120));
    const t = document.getElementById('toast');
    const im = t.querySelector('img.toast-ico');
    return { hasImg: !!im, src: im?.getAttribute('src') || null, w: im?.naturalWidth || 0,
      text: t.textContent, html: t.innerHTML.slice(0, 160) };
  })()`);
  ok(t1.hasImg && t1.w > 0, '🔥 → skills/91_sk_fire.png', JSON.stringify(t1));
  ok(!EMOJI_RE.test(t1.text), '提示文字里没有残留 emoji', t1.text);

  const t2 = await ev(`(async () => {
    const ui = await import('/src/ui/ui.js');
    ui.toast('❄️ 被霜雪冻住');            // 带变体选择符 U+FE0F
    await new Promise((r) => setTimeout(r, 120));
    const t = document.getElementById('toast');
    const im = t.querySelector('img.toast-ico');
    return { src: im?.getAttribute('src') || null, w: im?.naturalWidth || 0, text: t.textContent };
  })()`);
  ok(t2.src === '/icons/skills/92_sk_ice.png' && t2.w > 0, '❄️（含 U+FE0F）→ skills/92_sk_ice.png', JSON.stringify(t2));
  ok(!EMOJI_RE.test(t2.text), '❄️ 提示文字干净', t2.text);

  const t3 = await ev(`(async () => {
    const ui = await import('/src/ui/ui.js');
    ui.toast('普通提示，没有图标');        // 不应该被改动
    await new Promise((r) => setTimeout(r, 120));
    const t = document.getElementById('toast');
    return { hasImg: !!t.querySelector('img'), text: t.textContent };
  })()`);
  ok(!t3.hasImg && t3.text === '普通提示，没有图标', '无 emoji 的提示原样输出', JSON.stringify(t3));

  // ---------- ④ 原生下拉（旧合并屏 + 大厅设置抽屉） ----------
  // 注意：#menu-boat 那一屏在当前「大厅优先」流程里已经走不到（enterBoatSelect 没有调用点），
  // 里面的三个下拉属于历史界面。这里照样验证「有选项时才检查图标」，真人在用的
  // 难度下拉是大厅设置抽屉的 #sel-difficulty，放到 ⑤ 之后单独验。
  console.log('\n④ 历史合并屏的三个下拉');
  const dd = await ev(`(() => {
    const dump = (sel) => {
      const s = document.querySelector(sel);
      if (!s) return { missing: true };
      const filter = s.closest('.map-filter');
      const label = filter?.querySelector('label');
      const ico = label?.querySelector('img.mf-ico');
      return {
        count: s.options.length,
        options: [...s.options].map((o) => o.textContent),
        labelIco: ico?.getAttribute('src') || null,
        labelIcoLoaded: ico ? (ico.complete && ico.naturalWidth > 0) : null,
      };
    };
    return { mode: dump('#mode-select'), weather: dump('#weather-select'), diff: dump('#boss-difficulty') };
  })()`);
  for (const [name, d] of Object.entries(dd)) {
    if (d.missing) { ok(false, name + ' 下拉存在'); continue; }
    const dirty = d.options.filter((o) => EMOJI_RE.test(o));
    ok(dirty.length === 0, `${name} 选项无 emoji（${d.count} 项）`, JSON.stringify(dirty));
  }
  // 主动渲染一次，确认图标会挂上去（真人流程里面板刷新时就会跑这段）
  const legacy = await ev(`(async () => {
    const ui = await import('/src/ui/ui.js');
    ui.renderModeList('race', () => {});
    ui.renderWeatherList('day', () => {});
    window.__paintDiff = ui.paintFilterIcon;
    ui.paintFilterIcon(document.querySelector('#boss-difficulty'), 'diffNightmare');
    await new Promise((r) => setTimeout(r, 150));
    const grab = (sel) => {
      const s = document.querySelector(sel);
      const lab = s?.closest('.map-filter')?.querySelector('label');
      const im = lab?.querySelector('img.mf-ico');
      return { src: im?.getAttribute('src') || null, w: im?.naturalWidth || 0 };
    };
    const s = document.querySelector('#mode-select');
    const before = grab('#mode-select');
    s.value = 'launch';
    s.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 120));
    return { mode: before, modeAfter: grab('#mode-select'),
      weather: grab('#weather-select'), diff: grab('#boss-difficulty'),
      launchIsRight: /38_mode_launch/.test(grab('#mode-select').src || '') };
  })()`);
  ok(legacy.mode.w > 0 && /36_mode_race/.test(legacy.mode.src || ''), '竞速 → 36_mode_race.png', JSON.stringify(legacy.mode));
  ok(legacy.launchIsRight, '切到弹射 → 38_mode_launch.png（图标跟着变）', JSON.stringify(legacy.modeAfter));
  ok(legacy.weather.w > 0, '天气标签有图标', JSON.stringify(legacy.weather));
  ok(legacy.diff.w > 0 && /60_diff_nightmare/.test(legacy.diff.src || ''), '噩梦难度 → 60_diff_nightmare.png', JSON.stringify(legacy.diff));

  // ---------- ⑤ 大厅：头像 / 皇冠 / 难度下拉 ----------
  console.log('\n⑤ 大厅名单与设置');
  await ev(`document.querySelector('#btn-solo').click(); 1`);
  await waitFor(`!document.querySelector('#lobby')?.classList.contains('hidden')`, 25000);
  await sleep(900);
  const lobby = await ev(`(() => {
    const rows = [...document.querySelectorAll('#lobby-players .player-row')];
    return {
      rows: rows.length,
      avatars: rows.map((r) => {
        const a = r.querySelector('.pavatar');
        const im = a?.querySelector('img');
        return { svg: !!a?.querySelector('svg'), src: im?.getAttribute('src') || null,
          w: im ? im.naturalWidth : 0 };
      }),
      crown: (() => {
        const c = document.querySelector('.lc-crown');
        if (!c) return { present: false };
        const im = c.querySelector('img');
        return { present: true, text: c.textContent.trim(), src: im?.getAttribute('src') || null,
          w: im ? im.naturalWidth : 0 };
      })(),
    };
  })()`);
  ok(lobby.rows > 0, `大厅有 ${lobby.rows} 行玩家`);
  ok(lobby.avatars.every((a) => !a.svg), '名单头像不再有 <svg>', JSON.stringify(lobby.avatars));
  ok(lobby.avatars.every((a) => a.src && a.w > 0), '名单头像是能解码的 PNG', JSON.stringify(lobby.avatars));
  ok(lobby.crown.present && lobby.crown.w > 0 && lobby.crown.text === '房主',
    '房主徽章换成皇冠 PNG', JSON.stringify(lobby.crown));

  // 切到怪物模式，抽屉里会出现难度下拉（#sel-difficulty）
  await ev(`document.querySelector('#btn-lobby-mode')?.click(); 1`);
  await waitFor(`!!document.querySelector('#lobby-pick-body [data-mode="boss"]')`, 15000);
  await ev(`document.querySelector('#lobby-pick-body [data-mode="boss"]').click(); 1`);
  await ev(`document.querySelector('#btn-lobby-pick-close')?.click(); 1`);
  await sleep(700);
  const lobbyDiff = await ev(`(() => {
    const s = document.querySelector('#sel-difficulty');
    if (!s) return { missing: true };
    const im = s.parentElement.querySelector('img.mf-ico');
    return {
      options: [...s.options].map((o) => o.textContent),
      value: s.value,
      src: im?.getAttribute('src') || null,
      w: im ? im.naturalWidth : 0,
    };
  })()`);
  if (lobbyDiff.missing) {
    ok(false, '大厅难度下拉 #sel-difficulty 存在');
  } else {
    ok(lobbyDiff.options.every((o) => !EMOJI_RE.test(o)), '大厅难度选项无 emoji', JSON.stringify(lobbyDiff.options));
    ok(!!lobbyDiff.src && lobbyDiff.w > 0, '大厅难度旁有图标', JSON.stringify(lobbyDiff));
  }

  console.log('\n' + (fails.length ? `FAILED ${fails.length}: ${fails.join(' | ')}` : 'PASS'));
  process.exitCode = fails.length ? 1 : 0;
} finally {
  try { ws?.terminate(); } catch {}
  child.kill('SIGKILL');
  await sleep(300);
}
