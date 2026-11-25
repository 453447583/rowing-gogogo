import { BOATS } from '../data/boats.js';
import { HEX_CORES, HEX_RULES, HEX_HAZARDS, HEX_CARDS } from '../data/hexRun.js';
import { MAPS, WEATHERS } from '../data/maps.js';
import { getBoatWeapon } from '../data/boatWeapons.js';
import { avatarMarkup } from './avatars.js';
import {
  ICONS, ITEM_ART, iconImg, setIcon, iconSrc,
  MODE_ICON, MAP_ICON, WEATHER_ICON, BOSS_ICON, DIFF_ICON, STATUS_ICON, MOB_ICON, WEAPON_ICON,
  TOAST_ICON, CROWN,
} from './icons.js';

// 图标总开关：改 false 一键回到原版 emoji（道具 27 件 + 其余 67 枚一起生效）
const ART_ON = true;

// UI 工具：菜单渲染 + HUD 更新

const $ = (id) => document.getElementById(id);

// 玩家名/伤害来源都来自网络数据，拼进 HTML 前统一转义
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * 海克斯图标：数据层存的是 `hex/xxx.png` 相对路径（1024 原图已压到 512/128）。
 * 返回 <img>；留成 emoji 的条目原样输出文本，避免旧数据变成坏图。
 */
function hexIco(v, cls = '') {
  const src = String(v || '');
  if (/^hex\/[\w.-]+$/.test(src)) {
    return `<img class="hex-ico${cls ? ` ${cls}` : ''}" src="/icons/${src}" alt="" draggable="false">`;
  }
  return escHtml(src);
}

/**
 * 通用 chip 图标：既认海克斯的 `hex/xxx.png`，也认图标表的 `/icons/xxx.png`，
 * 两者都不是（主题/天气还留着 emoji）就原样输出文本，不会把路径打成乱码。
 */
function chipIco(v, cls = '') {
  const src = String(v || '');
  if (/^\/icons\/[\w./-]+\.(png|webp|jpg)$/.test(src)) {
    return `<img class="${cls || 'hex-ico'}" src="${src}" alt="" draggable="false">`;
  }
  return hexIco(v, cls);
}

export function el(id) {
  return $(id);
}

export function show(id) {
  $(id).classList.remove('hidden');
}

export function hide(id) {
  $(id).classList.add('hidden');
}

let toastTimer = null;
let toastClassTimer = null;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
}

/**
 * 把字符串**开头**的 emoji 换成图标 <img>，返回 HTML（正文已转义）。
 *
 * 为什么不把几十处 `onToast('🔥 熔岩海啸！…')` 全改写：
 * 那些提示散在 BossMode 的二十多个技能里，逐条改字符串容易漏，而且会把玩法
 * 代码和美术资源绑死。这里只在渲染这一层替换掉开头一个字符，调用方零改动，
 * 以后加新图标只要往 icons.js 的 TOAST_ICON 里加一行。
 *
 * 注意 ❄️ / 🛡️ / ☠️ / 🗡️ 带变体选择符 U+FE0F，查表前先剥掉；
 * 正文里的其余字符照常转义，不受影响。
 */
function iconizePrefix(msg, cls = 'toast-ico') {
  const s = String(msg ?? '');
  if (!s) return { src: '', text: '', html: '' };
  const first = [...s][0];
  const key = first.replace(/[\uFE0E\uFE0F]/g, '');
  const src = TOAST_ICON[key];
  if (!src) return { src: '', text: s, html: escapeHtml(s) };
  let i = first.length;
  while (i < s.length && /[\uFE0E\uFE0F]/.test(s[i])) i++;
  while (i < s.length && s[i] === ' ') i++;
  const text = s.slice(i);
  return {
    src,
    text,
    html: `<img class="${cls}" src="${src}" alt="" draggable="false">${escapeHtml(text)}`,
  };
}

// 卷轴提示：文字里的数字单独包一层，交给 CSS 做鎏金效果
function scrollToastHtml(msg) {
  return escapeHtml(msg).replace(/(\d+(?:\.\d+)?)/g, '<span class="gilt-num">$1</span>');
}
export function toast(msg, opts = {}) {
  const t = $('toast');
  // 怪物模式的 HUD 提示（技能预警 / 拾取 / 减速…）统一走卷轴版式。
  // 以前只有漩涡那一条显式传了 variant:'scroll'，其余还是旧的发光大字，
  // 同一块 HUD 上两种样式并存，看起来像两套界面。
  const hud = document.getElementById('hud');
  const bossHud = !!hud
    && !hud.classList.contains('hidden')
    && hud.classList.contains('boss-mode');
  const scroll = opts?.variant === 'scroll' || (bossHud && opts?.variant !== 'plain');
  t.classList.toggle('scroll', scroll);
  // 开头的 emoji 换成 PNG（熔岩 / 冰霜 / 落雷…），正文照旧转义
  const pre = iconizePrefix(msg);
  if (scroll) {
    t.innerHTML = pre.src
      ? `<img class="toast-ico" src="${pre.src}" alt="" draggable="false">`
        + scrollToastHtml(pre.text)
      : scrollToastHtml(pre.text);
  } else if (pre.src) {
    t.innerHTML = pre.html;
  } else {
    t.textContent = pre.text;
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  clearTimeout(toastClassTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    // 等收起动画走完再摘掉卷轴样式，避免中途闪回普通提示
    toastClassTimer = setTimeout(() => {
      if (!t.classList.contains('show')) t.classList.remove('scroll');
    }, 420);
  }, scroll ? 3600 : 2500);
}

// RPG 职业选择风的艇型定位 + 上手难度（1~3 星，3 星最难）
const BOAT_ROLES = {
  rower: { title: '冲刺型', sub: '直道极速第一梯队', diff: 2 },
  skiff: { title: '灵巧型', sub: '弯道最灵活', diff: 1 },
  falcon: { title: '爆发型', sub: '氮气怪物，易失控', diff: 3 },
  titan: { title: '重装型', sub: '钢铁壁垒，撞击强势', diff: 1 },
  dolphin: { title: '均衡型', sub: '漂移拉车头最快', diff: 2 },
  vintage: { title: '走线型', sub: '窄河道吃弯最稳', diff: 1 },
  longship: { title: '长船型', sub: '直道强势，转弯半径最大', diff: 3 },
  cow: { title: '灵动型', sub: '起步最快、身子最小，皮薄怕撞', diff: 3 },
};

const STAT_ROWS = [
  ['speed', '极速'],
  ['accel', '加速'],
  ['turn', '转向'],
  ['drift', '漂移'],
  ['glide', '滑行'],
  ['stability', '稳定'],
];

export function renderBoatList(selectedId, takenBoats, onSelect) {
  const current = BOATS.find((b) => b.id === selectedId) || BOATS[0];
  renderBoatPanel(current, takenBoats.has(current.id));
  renderBoatThumbs(selectedId, takenBoats, onSelect);
  bindBoatNav(current, takenBoats, onSelect);
}

// 弹道特性：怪物模式下武器差异主要靠这四类区分
const WEAPON_TRAITS = {
  shot: { tag: '直射', note: '沿船头方向直线飞行，靠船头对准目标' },
  torpedo: { tag: '追踪', note: '会向 BOSS 自动修正，绕圈也能命中' },
  beam: { tag: '蓄力', note: '按住蓄力，满蓄力一击贯穿' },
  blade: { tag: '回旋', note: '旋转飞出，覆盖面广、容错高' },
};

// 选艇面板当前是否处于怪物模式（true 时显示火力面板而不是竞速属性）
let boatPanelBoss = false;

/** 切换选艇面板模式；返回是否发生变化，供外部决定要不要重绘 */
export function setBoatPanelBossMode(on) {
  const next = !!on;
  const changed = next !== boatPanelBoss;
  boatPanelBoss = next;
  return changed;
}

// 主炮数值：单发总伤 / 射速 / 理论 DPS（蓄力激光把蓄满伤害算进一发）
function weaponNumbers(boat) {
  const w = getBoatWeapon(boat.id);
  const count = Math.max(1, w.count || 1);
  const cycleTime = w.kind === 'beam' ? w.cadence + (w.chargeTime || 0) : w.cadence;
  const perShot = w.damage + (w.kind === 'beam' ? (w.charge || 0) : 0);
  return {
    w,
    count,
    single: perShot * count,
    rate: count / cycleTime,
    dps: (perShot * count) / cycleTime,
    singleText: w.kind === 'beam' ? `${w.damage}+${w.charge}` : (count > 1 ? `${w.damage}×${count}` : `${w.damage}`),
  };
}

let fireCeilingsCache = null;
function fireCeilings() {
  if (!fireCeilingsCache) {
    const m = { speed: 1, single: 1, rate: 1, dps: 1 };
    for (const b of BOATS) {
      const n = weaponNumbers(b);
      m.speed = Math.max(m.speed, b.maxSpeed);
      m.single = Math.max(m.single, n.single);
      m.rate = Math.max(m.rate, n.rate);
      m.dps = Math.max(m.dps, n.dps);
    }
    fireCeilingsCache = m;
  }
  return fireCeilingsCache;
}

// 火力面板数据：移速 / 单伤 / 射速 / DPS + 武器与弹道特性
function fireStatRows(boat) {
  const n = weaponNumbers(boat);
  const max = fireCeilings();
  return {
    n,
    trait: WEAPON_TRAITS[n.w.kind] || WEAPON_TRAITS.shot,
    rows: [
      ['移速', boat.maxSpeed / max.speed, `${Math.round(boat.maxSpeed)}`],
      ['单伤', n.single / max.single, n.singleText],
      ['射速', n.rate / max.rate, `${n.rate.toFixed(1)}/s`],
      ['DPS', n.dps / max.dps, `${Math.round(n.dps)}`],
    ],
  };
}

// 怪物模式的火力面板：移速 / 单伤 / 射速 / DPS + 武器与弹道
function renderFirePanel(stats, boat) {
  const { n, trait, rows } = fireStatRows(boat);
  for (const [label, ratio, text] of rows) {
    const segs = Math.max(1, Math.round(ratio * 10));
    const row = document.createElement('div');
    row.className = 'stat-row' + (segs >= 9 ? ' hot' : '');
    row.innerHTML = `
      <div class="stat-label">${label}</div>
      <div class="stat-segs">${'<i class="on"></i>'.repeat(segs)}${'<i></i>'.repeat(10 - segs)}</div>
      <div class="stat-val">${text}</div>`;
    stats.appendChild(row);
  }

  const weaponRow = document.createElement('div');
  weaponRow.className = 'fire-row';
  weaponRow.innerHTML = `
    <span class="fw-icon">${n.w.icon}</span>
    <span class="fw-name">${escHtml(n.w.name)}</span>
    <span class="trait-tag">${trait.tag}</span>`;
  stats.appendChild(weaponRow);

  const note = document.createElement('div');
  note.className = 'fire-note';
  note.textContent = trait.note;
  stats.appendChild(note);
}

// 右侧参数面板（RPG 职业面板：名称 / 定位 / 简介 / 分段属性条 / 难度星级）
function renderBoatPanel(boat, taken) {
  const role = BOAT_ROLES[boat.id] || { title: '竞速型', sub: '', diff: 2 };
  const weapon = boatPanelBoss ? getBoatWeapon(boat.id) : null;
  $('boat-title-name').textContent = boat.name;
  $('boat-title-role').textContent = weapon ? weapon.name : role.title;
  $('boat-title-role').classList.toggle('taken', taken);
  $('boat-desc').textContent = weapon
    ? `${weapon.desc}${taken ? '（已被别人选择）' : ''}`
    : `${boat.desc} —— ${role.sub}${taken ? '（已被别人选择）' : ''}`;

  const stats = $('boat-stats');
  stats.innerHTML = '';
  stats.classList.toggle('fire', !!weapon);
  if (weapon) {
    renderFirePanel(stats, boat);
  } else {
    for (const [key, label] of STAT_ROWS) {
      const segs = Math.round(boat.stats[key] * 10);
      const row = document.createElement('div');
      row.className = 'stat-row' + (segs >= 8 ? ' hot' : '');
      row.innerHTML = `
        <div class="stat-label">${label}</div>
        <div class="stat-segs">${'<i class="on"></i>'.repeat(segs)}${'<i></i>'.repeat(10 - segs)}</div>
        <div class="stat-val">${segs * 10}</div>`;
      stats.appendChild(row);
    }
  }

  const diff = $('boat-diff');
  diff.innerHTML = '';
  const diffRow = document.createElement('div');
  diffRow.className = 'diff-row';
  diffRow.innerHTML = `
    <span>上手难度</span>
    <span class="diff-stars d${role.diff}">${'★'.repeat(role.diff)}${'☆'.repeat(3 - role.diff)}</span>`;
  diff.appendChild(diffRow);
}

// 底部缩略条：点击即选中（舰 swatch + 艇名）
function renderBoatThumbs(selectedId, takenBoats, onSelect) {
  const wrap = $('boat-list');
  wrap.innerHTML = '';
  for (const boat of BOATS) {
    const taken = takenBoats.has(boat.id);
    const card = document.createElement('div');
    card.className = 'boat-card' + (boat.id === selectedId ? ' selected' : '') + (taken ? ' taken' : '');
    card.innerHTML = `
      <div class="thumb-swatch" style="background:#${boat.color.toString(16).padStart(6, '0')}"></div>
      <div class="thumb-name">${boat.name}</div>`;
    card.onclick = () => {
      if (taken) {
        toast('该赛艇已被别人选择');
        return;
      }
      onSelect(boat.id);
      renderBoatList(boat.id, takenBoats, onSelect);
    };
    wrap.appendChild(card);
  }
}

// 左右切换箭头（跳过已被选择的艇会提示）
function bindBoatNav(current, takenBoats, onSelect) {
  const idx = BOATS.indexOf(current);
  const pickAt = (i) => {
    const boat = BOATS[(i + BOATS.length) % BOATS.length];
    if (takenBoats.has(boat.id)) {
      toast('该赛艇已被别人选择');
      return;
    }
    onSelect(boat.id);
    renderBoatList(boat.id, takenBoats, onSelect);
  };
  $('boat-prev').onclick = () => pickAt(idx - 1);
  $('boat-next').onclick = () => pickAt(idx + 1);
}

// ---------- 选赛道 ----------
// 卡丁车式布局：左侧赛道俯视大图（霓虹绿线）+ 左下比赛设置，右侧筛选下拉 + 赛道卡片列表 + 确定

const MAP_ALBUMS = {
  canyon: '激流专辑',
  lake: '激流专辑',
  ocean: '深海专辑',
  palace: '深海专辑',
  tide: '深海专辑',
};

function mapStars(map) {
  const scCount = (map.shortcuts || []).length;
  return scCount >= 2 ? 3 : (map.gateWidth <= 12 ? 3 : 2);
}

function mapLapLength(map) {
  let total = 0;
  for (let i = 0; i < map.gates.length; i++) {
    const [ax, az] = map.gates[i];
    const [bx, bz] = map.gates[(i + 1) % map.gates.length];
    total += Math.hypot(bx - ax, bz - az);
  }
  return Math.round(total);
}

// ---------- 大厅抽屉里的「赛艇参数 / 地图路线」详情 ----------
// 旧版选艇屏和选图屏各有一套详情组件，大厅中心化后这两个屏幕不再经过。
// 这里把同一份数据（BOAT_ROLES / STAT_ROWS / mapLapLength / mapStars）直接
// 复用到抽屉里，避免两套参数表随时间漂移。
export function lobbyBoatStatsHtml(boat, mode = 'race') {
  if (!boat) return '';
  // 怪物 / 竞技场都是炮战：面板换成火力 + 弹道参数，和实际武器一致。
  // 竞速 / 道具 / 弹射仍然显示极速、加速、转向、稳定等驾驶属性。
  if (mode === 'boss' || mode === 'arena') {
    const { n, trait, rows } = fireStatRows(boat);
    const stats = rows.map(([label, ratio, text]) => {
      const segs = Math.max(1, Math.round(ratio * 10));
      return `<div class="lp-stat${segs >= 9 ? ' hot' : ''}">
        <span>${label}</span>
        <i>${'<b class="on"></b>'.repeat(segs)}${'<b></b>'.repeat(10 - segs)}</i>
        <em>${escHtml(text)}</em>
      </div>`;
    }).join('');
    return `<div class="lp-detail">
      <div class="lp-detail-head">
        <b>${iconImg(WEAPON_ICON[boat.id], 'wpn-ico') || ''}${escHtml(boat.name)}</b>
        <span>${escHtml(n.w.name)} · ${trait.tag}</span>
      </div>
      <p class="lp-desc">${escHtml(n.w.desc || '')}</p>
      <div class="lp-stats fire">${stats}</div>
      <p class="fire-note">${escHtml(trait.note)}</p>
    </div>`;
  }
  const role = BOAT_ROLES[boat.id] || { title: '赛艇', sub: '', diff: 2 };
  const rows = STAT_ROWS.map(([key, label]) => {
    const segs = Math.round((boat.stats?.[key] || 0) * 10);
    return `<div class="lp-stat">
      <span>${label}</span>
      <i>${'<b class="on"></b>'.repeat(segs)}${'<b></b>'.repeat(10 - segs)}</i>
      <em>${segs * 10}</em>
    </div>`;
  }).join('');
  return `<div class="lp-detail">
    <div class="lp-detail-head">
      <b>${escHtml(boat.name)}</b>
      <span>${role.title} · ${role.sub}</span>
    </div>
    <p class="lp-desc">${escHtml(boat.desc || '')}</p>
    <div class="lp-stats">${rows}</div>
  </div>`;
}

export function lobbyMapMeta(map) {
  if (!map) return { stars: 0, lapLength: 0, gates: 0, shortcuts: 0 };
  return {
    stars: mapStars(map),
    lapLength: mapLapLength(map),
    gates: map.gates?.length || 0,
    shortcuts: (map.shortcuts || []).length,
  };
}

export function drawMapRoute(canvas, mapId, opts = {}) {
  const map = MAPS.find((m) => m.id === mapId) || MAPS[0];
  if (!map) return;
  drawTrackView(canvas, map, { pad: 20, ...opts });
}

// 主赛道中线（含闭合段）到某点的距离，用于把近道裁到主道走廊之外
function distToMainLoop(gates, x, z) {
  let best = Infinity;
  for (let i = 0; i < gates.length; i++) {
    const a = gates[i], b = gates[(i + 1) % gates.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - a[0]) * dx + (z - a[1]) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
    if (d < best) best = d;
  }
  return best;
}

// 与 Track.#buildShortcuts 的 clipAt 同口径：近道只画主道走廊之外的部分，
// 否则俯视图会画出一条黄色虚线从主赛道正中间穿过（3D 里并不会这样）。
function clipShortcutForView(map, sc) {
  const keepDist = map.gateWidth + sc.width * 0.5 + 0.5;
  const dense = [];
  for (let i = 0; i < sc.points.length - 1; i++) {
    const [ax, az] = sc.points[i], [bx, bz] = sc.points[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 2));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      dense.push([ax + (bx - ax) * t, az + (bz - az) * t]);
    }
  }
  dense.push([...sc.points[sc.points.length - 1]]);
  const keep = [];
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i];
    const dp = distToMainLoop(map.gates, p[0], p[1]);
    if (dp >= keepDist) { keep.push(p); continue; }
    if (i > 0 && keep.length) {
      const q = dense[i - 1], dq = distToMainLoop(map.gates, q[0], q[1]);
      if (dq < keepDist) { keep.push([p[0], p[1]]); continue; }
      const t = (dq - keepDist) / (dq - dp);
      keep.push([q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t]);
    }
  }
  return keep;
}

// 赛道俯视图：深蓝底 + 霓虹蓝主赛道 + 金色近道 + 起终点格纹旗
function drawTrackView(canvas, map, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  if (!w || !h) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const gates = map.gates;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of gates) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const pad = opts.pad ?? 46;
  const s = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxZ - minZ || 1));
  const ox = (w - (maxX - minX) * s) / 2 - minX * s;
  const oy = (h - (maxZ - minZ) * s) / 2 - minZ * s;
  const X = (x) => x * s + ox;
  const Y = (z) => z * s + oy;

  // strip = 胶片条里的小剪影：透明底 + 白色线稿（和大预览是两套语言）
  const strip = !!opts.strip;
  if (!strip) {
    // 底：径向渐深蓝地貌
    const bg = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.75);
    bg.addColorStop(0, '#0d2036');
    bg.addColorStop(0.55, '#091524');
    bg.addColorStop(1, '#04090f');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // 网格纹理
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.05)';
    ctx.lineWidth = 1;
    const step = Math.max(28, Math.round(Math.min(w, h) / 12));
    ctx.beginPath();
    for (let x = (w % step) / 2; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = (h % step) / 2; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
  }

  const trackPath = () => {
    ctx.beginPath();
    gates.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Y(z)) : ctx.moveTo(X(x), Y(z))));
    ctx.closePath();
  };

  // 主赛道：外层深色路基 + 霓虹蓝线
  const road = Math.max(6, map.gateWidth * s * 0.62);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (strip) {
    trackPath();
    ctx.shadowColor = 'rgba(150, 230, 255, 0.9)';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 2.1;
    ctx.stroke();
    ctx.shadowBlur = 0;
  } else {
    trackPath();
    ctx.strokeStyle = 'rgba(6, 16, 28, 0.9)';
    ctx.lineWidth = road;
    ctx.stroke();
    trackPath();
    ctx.strokeStyle = 'rgba(94, 200, 255, 0.28)';
    ctx.lineWidth = road * 0.55;
    ctx.stroke();
    trackPath();
    ctx.shadowColor = 'rgba(94, 200, 255, 0.85)';
    ctx.shadowBlur = opts.thumb ? 4 : 14;
    ctx.strokeStyle = '#79d4ff';
    ctx.lineWidth = opts.thumb ? 2 : 3.5;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // 近道：金色虚线（视觉上区别于主赛道），已裁掉主道走廊内的部分。
  // 胶片条的小剪影不画 —— 100px 宽下会和主赛道糊成一团。
  for (const sc of strip ? [] : map.shortcuts || []) {
    const line = clipShortcutForView(map, sc);
    if (line.length < 2) continue;
    ctx.beginPath();
    line.forEach(([x, z], i) => (i ? ctx.lineTo(X(x), Y(z)) : ctx.moveTo(X(x), Y(z))));
    ctx.setLineDash(opts.thumb ? [3, 3] : [8, 6]);
    ctx.shadowColor = 'rgba(255, 214, 102, 0.7)';
    ctx.shadowBlur = opts.thumb ? 3 : 10;
    ctx.strokeStyle = '#ffd666';
    ctx.lineWidth = opts.thumb ? 1.4 : 2.6;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
  }

  if (opts.thumb) return;

  // 门点
  gates.forEach(([x, z], i) => {
    if (i === 0) return;
    ctx.beginPath();
    ctx.arc(X(x), Y(z), 3.4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(170, 220, 255, 0.75)';
    ctx.fill();
  });

  // 起终点：格纹旗方块
  const last = gates.length - 1;
  for (const i of [0, last]) {
    const [x, z] = gates[i];
    const size = 13;
    const px = X(x) - size / 2, py = Y(z) - size / 2;
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) {
        ctx.fillStyle = (a + b) % 2 ? '#101010' : '#f4faff';
        ctx.fillRect(px + a * (size / 2), py + b * (size / 2), size / 2, size / 2);
      }
    }
    ctx.strokeStyle = '#79d4ff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px - 1.5, py - 1.5, size + 3, size + 3);
    ctx.font = '600 11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#c9e6ff';
    ctx.textAlign = 'center';
    ctx.fillText(i === 0 ? '起' : '终', X(x), Y(z) - size / 2 - 6);
  }
}

// 状态：当前选中 + 筛选条件 + 悬停中的那张（详情卡只在悬停时浮出）
const mapState = { selectedId: null, onSelect: null, diff: 'all', album: 'all', hoverId: null, previewId: null };

function filteredMaps() {
  return MAPS.filter((m) => {
    if (mapState.album !== 'all' && MAP_ALBUMS[m.id] !== mapState.album) return false;
    if (mapState.diff !== 'all' && String(mapStars(m)) !== mapState.diff) return false;
    return true;
  });
}

export function renderMapList(selectedId, onSelect) {
  const wrap = $('map-list');
  if (!wrap) return;
  mapState.onSelect = onSelect;
  if (selectedId) mapState.selectedId = selectedId;
  // 重渲染会丢掉滚动位置：右侧赛道条要能"上下翻"，选完一张图不能弹回顶部
  const keepScroll = wrap.scrollTop;
  wrap.innerHTML = '';
  const list = filteredMaps();
  for (const map of list) {
    const stars = mapStars(map);
    const card = document.createElement('div');
    card.className = 'map-card' + (map.id === mapState.selectedId ? ' selected' : '');
    card.dataset.mapId = map.id;
    card.innerHTML = `
      <div class="mc-thumb"><canvas></canvas></div>
      <div class="mc-body">
        <div class="mc-name">${map.name}</div>
        <div class="mc-meta">
          <span class="mc-diff">${'★'.repeat(stars)}</span>
          <span class="mc-len">${mapLapLength(map)}m</span>
        </div>
        <div class="mc-desc">${map.desc}</div>
      </div>`;
    card.onclick = () => selectMap(map.id);
    // 详情卡默认不显示，鼠标移到哪张卡上就浮出哪张卡的信息
    card.addEventListener('mouseenter', () => showMapDetail(card));
    wrap.appendChild(card);
    drawTrackView(card.querySelector('canvas'), map, { thumb: true, strip: true, pad: 8 });
  }
  if (!list.length) {
    wrap.innerHTML = '<div class="mc-desc" style="padding:16px 4px">该筛选条件下没有赛道</div>';
  }
  // 保证选中项仍在筛选结果内，否则回退到第一条
  if (list.length && !list.some((m) => m.id === mapState.selectedId)) {
    selectMap(list[0].id);
    return;
  }
  wrap.scrollTop = keepScroll;
  // 键盘 ↑/↓ 换图时，把新选中项滚进可视区（而不是跳到顶部）
  const sel = wrap.querySelector('.map-card.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
  bindDetailLeave(wrap);
  // 重渲染把卡片 DOM 换掉了，鼠标还停在原来那张上：把悬停态接回来
  if (mapState.hoverId) {
    const hc = wrap.querySelector(`.map-card[data-map-id="${mapState.hoverId}"]`);
    if (hc) {
      requestAnimationFrame(() => { if (hc.isConnected) showMapDetail(hc); });
      return;
    }
    mapState.hoverId = null;
  }
  positionMapDetail();
}

function selectMap(mapId) {
  mapState.selectedId = mapId;
  mapState.onSelect?.(mapId);
  renderMapList();
  renderMapPreview(mapId);
}

// ── 赛道详情卡：平时隐藏，鼠标停留在某张赛道卡上才浮出到胶片条左侧 ──
function showMapDetail(cardEl) {
  const detail = document.querySelector('.vs-detail');
  if (!detail || !cardEl || !cardEl.dataset) return;
  const id = cardEl.dataset.mapId;
  if (!id) return;
  mapState.hoverId = id;
  detail.classList.add('show');
  if (mapState.previewId !== id) renderMapPreview(id, cardEl);
  else positionMapDetail(cardEl);
}

function hideMapDetail() {
  const detail = document.querySelector('.vs-detail');
  mapState.hoverId = null;
  detailAnchorEl = null;
  if (detail) detail.classList.remove('show');
  // 收起来后详情内容回到"当前选中"那张图，下次展开不会看到上一次的残留
  if (mapState.selectedId && mapState.previewId !== mapState.selectedId) {
    renderMapPreview(mapState.selectedId);
  }
}

// 鼠标离开胶条 / 详情卡才收起；卡片之间移动不算离开（否则会闪）
function bindDetailLeave(wrap) {
  if (wrap.dataset.leaveBound) return;
  wrap.dataset.leaveBound = '1';
  wrap.addEventListener('mouseleave', (e) => {
    const detail = document.querySelector('.vs-detail');
    if (detail && e.relatedTarget && detail.contains(e.relatedTarget)) return;
    hideMapDetail();
  });
  const detail = document.querySelector('.vs-detail');
  if (detail) detail.addEventListener('mouseleave', () => hideMapDetail());
}

// 右侧筛选下拉：难度 / 赛道专辑
export function renderMapFilters() {
  const diff = $('map-filter-diff');
  const album = $('map-filter-album');
  if (diff && !diff.options.length) {
    // 只列出实际存在的星级，避免选了没赛道的空档
    const levels = [...new Set(MAPS.map(mapStars))].sort();
    diff.innerHTML = '<option value="all">全部难度</option>'
      + levels.map((n) => `<option value="${n}">${'★'.repeat(n)}</option>`).join('');
    diff.value = mapState.diff;
    diff.onchange = () => {
      mapState.diff = diff.value;
      renderMapList();
    };
  }
  if (album && !album.options.length) {
    const albums = [...new Set(MAPS.map((m) => MAP_ALBUMS[m.id]))];
    album.innerHTML = '<option value="all">全部专辑</option>'
      + albums.map((a) => `<option value="${a}">${a}</option>`).join('');
    album.value = mapState.album;
    album.onchange = () => {
      mapState.album = album.value;
      renderMapList();
    };
  }
}

// 详情卡的画布与文案：hover 预览和"选中图"共用同一块 DOM
export function renderMapPreview(mapId, anchor) {
  const stage = $('map-stage-canvas');
  if (!stage) return;
  const map = MAPS.find((m) => m.id === mapId) || MAPS[0];
  if (!stage.querySelector('canvas')) stage.innerHTML = '<canvas></canvas>';
  drawTrackView(stage.querySelector('canvas'), map, { pad: 22 });
  mapState.previewId = map.id;

  const brief = $('map-brief');
  if (brief) {
    const stars = mapStars(map);
    // 版式按参考图：星级在最上，名字单独一行（不再和图标/星级挤一行被挤断字）
    brief.innerHTML = `
      <div class="mcb-diff">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</div>
      <div class="mcb-name">${iconImg(MAP_ICON[map.id], 'mcb-ico') || map.icon} ${map.name}</div>
      <div class="mcb-desc">${map.desc}</div>
      <div class="mcb-stats">
        <div class="mcb-stat">主圈<b>${mapLapLength(map)}m</b></div>
        <div class="mcb-stat">门数<b>${map.gates.length}</b></div>
        <div class="mcb-stat">近道<b>${(map.shortcuts || []).length} 条</b></div>
        <div class="mcb-stat">门宽<b>${map.gateWidth}m</b></div>
      </div>`;
  }
  positionMapDetail(anchor);
}

// 详情卡浮在胶片条左侧、纵向对齐"鼠标停留的那张赛道卡"：
// 滚动 / 换图 / 改窗口都要重新贴一次。横向一律夹在视口内——右缘绝不越过窗口宽度。
let detailScrollBound = false;
let detailAnchorEl = null;
function positionMapDetail(anchor) {
  if (anchor && anchor.nodeType === 1) detailAnchorEl = anchor;
  const rail = document.querySelector('.vs-rail');
  const list = $('map-list');
  const detail = document.querySelector('.vs-detail');
  if (!rail || !list || !detail) return;
  // 竖排兜底（≤920px）时详情卡是 static，不参与浮层定位
  if (getComputedStyle(detail).position !== 'absolute') return;
  const host = detail.offsetParent || rail.parentElement; // .vs-right
  if (!host) return;
  const hb = host.getBoundingClientRect();
  if (!hb.height) return;
  if (detailAnchorEl && !detailAnchorEl.isConnected) detailAnchorEl = null;
  const anchorEl = detailAnchorEl || list.querySelector('.map-card.selected') || list;
  const rb = rail.getBoundingClientRect();
  const cb = anchorEl.getBoundingClientRect();
  const w = detail.offsetWidth || 300;
  const h = detail.offsetHeight || 240;
  const vw = document.documentElement.clientWidth;

  // 横向：贴在胶片条左边（留 14px 呼吸缝），再把右缘压回视口内
  let left = rb.left - hb.left - w - 14;
  left = Math.min(left, vw - hb.left - w - 12);
  if (left < 8) left = 8;
  detail.style.left = left.toFixed(1) + 'px';
  detail.style.right = 'auto';

  // 纵向：对齐那张卡的中间，超出胶片条上下边界就夹住
  const top = cb.top - hb.top + cb.height / 2 - h / 2;
  const maxTop = Math.max(8, hb.height - h - 8);
  detail.style.top = Math.max(8, Math.min(maxTop, top)).toFixed(1) + 'px';

  if (!detailScrollBound) {
    detailScrollBound = true;
    list.addEventListener('scroll', () => requestAnimationFrame(() => positionMapDetail()), { passive: true });
  }
}

// 窗口尺寸变化时重绘大图
window.addEventListener('resize', () => {
  const screen = $('menu-boat');
  if (screen && !screen.classList.contains('hidden') && mapState.selectedId) {
    renderMapPreview(mapState.selectedId);
    positionMapDetail();
  }
});

// 天气下拉（含"随机"）
/**
 * 给 `.map-filter` 的 <label> 前面挂一张图标，跟随当前选值变化。
 *
 * 为什么不用 `<option>` 里塞 `<img>`：原生 select 的选项列表只吃纯文本，
 * 塞进去的标签会被当字符串显示（Chromium / Firefox 都一样）。所以改成
 * 「选项文字去掉 emoji + 标签旁挂一张图标」，闭合状态一眼就能看出选了什么。
 */
export function paintFilterIcon(sel, key) {
  if (!sel) return;
  const src = iconSrc(key);
  // 优先挂到 .map-filter 的 <label> 前；大厅设置抽屉里的下拉没有 label，
  // 就插到 select 自己前面（父容器用 flex 横排，见 .hs-field）。
  const label = sel.closest('.map-filter')?.querySelector('label') || null;
  const holder = label || sel.parentElement;
  if (!holder) return;
  let img = holder.querySelector('img.mf-ico');
  if (!src) {
    if (img) img.remove();
    return;
  }
  if (!img) {
    img = document.createElement('img');
    img.className = 'mf-ico';
    img.alt = '';
    img.draggable = false;
    if (label) label.insertBefore(img, label.firstChild);
    else holder.insertBefore(img, sel);
  }
  if (img.getAttribute('src') !== src) img.src = src;
}

export function renderWeatherList(selectedId, onSelect) {
  const sel = $('weather-select');
  if (!sel) return;
  // 2026-11-20：选项文字去掉 emoji，改由标签旁的图标表示（☀️ → weatherSunny PNG）
  const options = [...WEATHERS.map((w) => ({ id: w.id, name: w.name })),
    { id: 'random', name: '随机' }];
  sel.innerHTML = options.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
  sel.value = selectedId;
  paintFilterIcon(sel, WEATHER_ICON[sel.value] || WEATHER_ICON.random);
  sel.onchange = () => {
    paintFilterIcon(sel, WEATHER_ICON[sel.value] || WEATHER_ICON.random);
    onSelect(sel.value);
  };
}

// 下拉里「模式 → 图标」，比 MODE_ICON 多两个复合值（海克斯 / 挑战）
const MODE_OPT_ICON = {
  race: 'modeRace',
  item: 'modeItem',
  launch: 'modeLaunch',
  boss: 'modeMonster',
  // 海克斯 = 每关重洗技能顺序，用骰子图标
  'boss:hex': 'uiRandom',
  arena: 'modeArena',
  // 挑战模式（影子对战）暂时没有专属素材，宁可不放图标也不硬凑
  challenge: '',
};

// 比赛模式下拉：竞速 / 道具 / 弹射 / 怪物
export function renderModeList(selectedId, onSelect) {
  const sel = $('mode-select');
  if (!sel) return;
  const options = [
    { id: 'race', name: '竞速模式' },
    { id: 'item', name: '道具模式' },
    { id: 'launch', name: '弹射模式' },
    { id: 'boss', name: '怪物模式 · 闯关（打BOSS）' },
    // 复合值：mode 仍是 boss，main.js 按它切到 variant = 'hex'
    { id: 'boss:hex', name: '怪物模式 · 海克斯（随机招式）' },
    { id: 'arena', name: '潮汐竞技场（1v1对战）' },
    // 挑战模式（2026-11-18）：单人专属，赛道上放自己最快一圈的影子
    { id: 'challenge', name: '挑战模式 · 影子对战（单人）' },
  ];
  sel.innerHTML = options.map((o) => `<option value="${o.id}">${o.name}</option>`).join('');
  sel.value = selectedId;
  paintFilterIcon(sel, MODE_OPT_ICON[sel.value]);
  sel.onchange = () => {
    paintFilterIcon(sel, MODE_OPT_ICON[sel.value]);
    onSelect(sel.value);
  };
}

export function renderLobby(roster, myId, hostId, lanIps, teamEditable = true, showAiRows = false, voiceEnabled = false) {
  const wrap = $('lobby-players');
  wrap.innerHTML = '';
  // 海克斯：赛艇由开局随机分配，大厅里不要求先选艇
  const hexRandomBoat = roster.mode === 'boss' && roster.settings?.variant === 'hex';
  // 联机名单里带 ready 字段（单人练习的本地名单没有）：据此决定是否显示准备状态
  const showReady = roster.players.some((p) => p.ready !== undefined);
  // 组队赛制：左下角选手行里直接给每名玩家显示蓝 / 红选择
  const teamMode = roster.format === 'team' && roster.mode !== 'boss';
  for (const p of roster.players) {
    const boat = BOATS.find((b) => b.id === p.boatId);
    const row = document.createElement('div');
    row.className = 'player-row' + (p.offline ? ' offline' : '');
    const colorHex = boat ? '#' + boat.color.toString(16).padStart(6, '0') : '#556';
    const readyTag = showReady && !p.ai && p.id !== hostId
      ? (p.ready
        ? '<div class="pready">✅ 已准备</div>'
        : '<div class="pready wait">⏳ 未准备</div>')
      : '';
    // 「我」这一行的头像直接当换头像入口：点它弹出头像弹窗。
    // 不再在大厅展示台上单独摆一个头像按钮（那样又多一块独立 UI，很难看）。
    const mine = p.id === myId && !p.ai;
    // 组队赛制：可编辑时在选手行里给出一对「蓝 / 红」小按钮，
    // 点一下就能换队（不用再开独立的队伍抽屉）；不可编辑时只做只读展示。
    const canSwitchTeam = teamMode && teamEditable && !p.ai && !p.offline
      && (p.id === myId || myId === hostId);
    const teamPick = teamMode && p.team
      ? `<span class="p-team-pick" title="${canSwitchTeam ? '点击切换队伍' : '只能给自己换队；房主可以帮所有人换'}">
          <button type="button" class="blue${p.team === 'blue' ? ' selected' : ''}" data-team-switch="${p.id}" data-team="blue"${canSwitchTeam ? '' : ' disabled'}>蓝</button>
          <button type="button" class="red${p.team === 'red' ? ' selected' : ''}" data-team-switch="${p.id}" data-team="red"${canSwitchTeam ? '' : ' disabled'}>红</button>
        </span>`
      : '';
    // 网游式语音 UI：每个真人名字后面一个小喇叭。自己点击 = 开/关麦；
    // 别人点击 = 本地静音/取消静音。音量格由 VoiceManager 的音量探针实时更新。
    const voiceIcon = voiceEnabled && !p.ai
      ? `<button type="button" class="voice-icon" data-voice-id="${p.id}"`
        + ` title="${mine ? '点击开启 / 关闭语音' : '点击静音 / 取消静音此玩家'}"`
        + `${p.offline ? ' disabled' : ''}>`
        + `<svg viewBox="0 0 36 18" aria-hidden="true">`
        + `<path class="spk-body" d="M2 7h4l5-4v12L6 11H2z"/>`
        + `<path class="spk-wave" d="M13.5 6.2c2.1 1.5 2.1 3.9 0 5.6"/>`
        + `<rect class="vbar vbar-1" x="18" y="10.5" width="2.4" height="4" rx="1.2"/>`
        + `<rect class="vbar vbar-2" x="22" y="8" width="2.4" height="6.5" rx="1.2"/>`
        + `<rect class="vbar vbar-3" x="26" y="5.5" width="2.4" height="9" rx="1.2"/>`
        + `<rect class="vbar vbar-4" x="30" y="3" width="2.4" height="11.5" rx="1.2"/>`
        + `</svg></button>`
      : '';
    const acctStyle = p.style || {};
    const frameColor = acctStyle.frameColor || colorHex;
    const face = mine
      ? `<span class="pavatar-slot">`
        + `<button class="pavatar pavatar-me" type="button" data-avatar-me="1" title="点击更换头像"`
        + ` style="box-shadow:0 0 0 2px ${frameColor}">${avatarMarkup(p.avatar, p.ai, p.id)}</button>`
        + '</span>'
      : `<div class="pavatar" style="box-shadow:0 0 0 2px ${frameColor}">${avatarMarkup(p.avatar, p.ai, p.id)}</div>`;
    row.innerHTML = `
      ${face}
      <div class="pname-wrap">
        <div class="pname">${acctStyle.titleName ? `<em class="p-title-tag">${escHtml(acctStyle.titleName)}</em>` : ''}${escHtml(p.name)}${p.id === myId ? '（你）' : ''}</div>
        ${voiceIcon}
      </div>
      <div class="pboat">${boat ? boat.name : (hexRandomBoat ? '本局随机' : '选艇中…')}${p.offline ? ' · 重连中' : ''}</div>
      ${teamPick}
      ${p.id === hostId ? `<div class="lc-crown"><img class="lc-crown-ico" src="${CROWN}" alt="" draggable="false">房主</div>` : ''}
      ${p.ai ? '<div class="tag">AI</div>' : ''}
      ${readyTag}
    `;
    wrap.appendChild(row);
  }

  // 组队联机：AI 在开赛时才由服务器生成，大厅里按房主设置的 AI 数量补出对应行，
  // 队伍由房主点「蓝 / 红」逐个分配（settings.aiTeams），客人只读。
  if (showAiRows && teamMode) {
    const aiCount = Math.max(0, Math.min(3, Number(roster.settings?.aiCount) || 0));
    const aiTeams = Array.isArray(roster.settings?.aiTeams) ? roster.settings.aiTeams : [];
    const canAssign = myId === hostId;
    for (let i = 0; i < aiCount; i++) {
      const id = 'ai' + (i + 1);
      if (roster.players.some((p) => p.id === id)) continue;
      const team = aiTeams[i] === 'blue' || aiTeams[i] === 'red' ? aiTeams[i] : null;
      const row = document.createElement('div');
      row.className = 'player-row';
      row.innerHTML = `
        <div class="pavatar">${avatarMarkup(null, true, id)}</div>
        <div class="pname-wrap"><div class="pname">电脑${i + 1}</div></div>
        <div class="pboat">${team ? '已分队' : '待房主分队'}</div>
        <span class="p-team-pick" title="${canAssign ? '点击切换队伍' : '只有房主可以分配 AI 队伍'}">
          <button type="button" class="blue${team === 'blue' ? ' selected' : ''}" data-team-switch="${id}" data-team="blue"${canAssign ? '' : ' disabled'}>蓝</button>
          <button type="button" class="red${team === 'red' ? ' selected' : ''}" data-team-switch="${id}" data-team="red"${canAssign ? '' : ' disabled'}>红</button>
        </span>
        <div class="tag">AI</div>`;
      wrap.appendChild(row);
    }
  }

  const isHost = myId === hostId;
  // 按钮不再"点了没反应"：始终可点，缺什么由服务器回 toast 说明原因
  const missing = hexRandomBoat ? [] : roster.players.filter((p) => !p.ai && !p.boatId);
  const offline = roster.players.filter((p) => p.offline);
  const notReady = roster.players.filter((p) => !p.ai && p.id !== hostId && !p.ready);
  const startBtn = $('btn-start-race');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = !isHost;
  // 按钮文字固定，不把名单状态写进按钮（点击后由大厅顶部中央提示说明原因）
  startBtn.innerHTML = '开始比赛<small>START</small>';
  startBtn.title = [
    missing.length ? missing.map((p) => p.name).join('、') + ' 还没选赛艇' : '',
    notReady.length ? notReady.map((p) => p.name).join('、') + ' 还没准备' : '',
    offline.length ? offline.map((p) => p.name).join('、') + ' 正在重连' : '',
  ].filter(Boolean).join(' · ');

  // 非房主的「准备 / 取消准备」按钮
  const readyBtn = $('btn-lobby-ready');
  if (readyBtn) {
    const meRow = roster.players.find((p) => p.id === myId);
    const meReady = !!meRow?.ready;
    readyBtn.classList.toggle('hidden', isHost);
    readyBtn.classList.toggle('ready', meReady);
    readyBtn.innerHTML = meReady ? '取消准备<small>READY</small>' : '准备<small>READY</small>';
    readyBtn.title = meRow && !meRow.boatId && !hexRandomBoat ? '先选一艘赛艇再准备' : '';
  }

  // 主机设置区
  let settingsEl = $('host-settings');
  if (isHost) {
    if (!settingsEl) {
      settingsEl = document.createElement('div');
      settingsEl.id = 'host-settings';
      $('lobby-settings-slot').appendChild(settingsEl);
    }
    const s = roster.settings;
    if (roster.mode === 'boss') {
      // 怪物模式：只保留难度三档 + AI 陪练（天气由关卡自动推进、地图固定竞技场）
      // 难度档位没进 select 文字里，靠 select 前那张图标表示（⚔️🔥💀 → PNG）
      const diffKey = DIFF_ICON[s.difficulty] || DIFF_ICON.normal;
      settingsEl.innerHTML = `
        <div class="hs-field">
          ${iconImg(diffKey, 'mf-ico')}
          <select id="sel-difficulty">
            <option value="normal" ${s.difficulty === 'normal' || !s.difficulty ? 'selected' : ''}>普通</option>
            <option value="elite" ${s.difficulty === 'elite' ? 'selected' : ''}>精英</option>
            <option value="nightmare" ${s.difficulty === 'nightmare' ? 'selected' : ''}>噩梦</option>
          </select>
        </div>
        <select id="sel-ai">
          <option value="0" ${!s.aiCount ? 'selected' : ''}>无 AI</option>
          <option value="1" ${s.aiCount === 1 ? 'selected' : ''}>+1 AI</option>
          <option value="2" ${s.aiCount === 2 ? 'selected' : ''}>+2 AI</option>
          <option value="3" ${s.aiCount === 3 ? 'selected' : ''}>+3 AI</option>
        </select>
      `;
    } else {
      settingsEl.innerHTML = `
      <select id="sel-laps">
        <option value="1" ${s.laps === 1 ? 'selected' : ''}>1 圈</option>
        <option value="3" ${s.laps === 3 ? 'selected' : ''}>3 圈</option>
        <option value="5" ${s.laps === 5 ? 'selected' : ''}>5 圈</option>
      </select>
      <select id="sel-match-format">
        <option value="single" ${(s.matchFormat || 'single') === 'single' ? 'selected' : ''}>单场定胜负</option>
        <option value="bestOf3" ${s.matchFormat === 'bestOf3' ? 'selected' : ''}>三局两胜</option>
        <option value="points3" ${s.matchFormat === 'points3' ? 'selected' : ''}>三局积分制</option>
      </select>
      <select id="sel-ai">
        <option value="0" ${s.aiCount === 0 ? 'selected' : ''}>无 AI</option>
        <option value="1" ${s.aiCount === 1 ? 'selected' : ''}>+1 AI</option>
        <option value="2" ${s.aiCount === 2 ? 'selected' : ''}>+2 AI</option>
        <option value="3" ${s.aiCount === 3 ? 'selected' : ''}>+3 AI</option>
      </select>
      `;
    }
  } else if (settingsEl) {
    settingsEl.remove();
  }

  // 比赛信息条：模式胶囊 + 地图/关卡链
  const raceInfo = $('lobby-race-info');
  if (raceInfo) {
    if (roster.mode === 'boss') {
      const diffName = { normal: '普通', elite: '精英', nightmare: '噩梦' }[roster.settings?.difficulty] || '普通';
      const hex = roster.settings?.variant === 'hex';
      // 🎲 → 骰子图标、🐉 → 怪物模式图标；熔岩火山那行也换成怪物图标
      const modePillIco = iconImg(hex ? 'uiRandom' : 'modeMonster', 'lc-p-ico');
      const chainIco = iconImg('modeMonster', 'lc-p-ico');
      const diffIco = iconImg(DIFF_ICON[roster.settings?.difficulty] || DIFF_ICON.normal, 'lc-p-ico');
      raceInfo.innerHTML = `
        <span class="lc-pill boss">怪物模式</span>
        <span class="lc-pill">${modePillIco}${hex ? '海克斯' : '闯关'}</span>
        <span class="lc-chain">${chainIco}熔岩火山 → 珊瑚浅海 → 锈蚀港口 → 极夜冰海</span>
        <span class="lc-note">${diffIco}难度：${diffName} · ${hex ? '每关技能顺序随机 · 赛艇开局随机' : '关卡技能顺序固定'} · 场景随关卡切换${roster.settings?.aiCount ? ` · ${roster.settings.aiCount} 个 AI 陪练` : ''}</span>`;
    } else {
      const mapDef = MAPS.find((m) => m.id === roster.mapId);
      const weather = WEATHERS.find((w) => w.id === roster.weather);
      const s = roster.settings || {};
      const modeName = {
        race: '竞速', item: '道具', launch: '弹射', arena: '竞技场', challenge: '挑战',
      }[roster.mode] || '竞速';
      // 挑战模式：单人 + 影子，没有赛制/指令，也不必再报 AI 数量
      const isChallenge = roster.mode === 'challenge';
      const teamMode = roster.format === 'team';
      const matchName = { single: '单场定胜负', bestOf3: '三局两胜', points3: '三局积分制' }[
        s.matchFormat || (s.rounds === 3 ? 'points3' : 'single')
      ] || '单场定胜负';
      const teamPill = teamMode ? '<span class="lc-pill team">组队 3v3</span>' : '';
      const teamNote = teamMode
        ? ` · ${escHtml(roster.teamNames?.blue || '蓝队')} vs ${escHtml(roster.teamNames?.red || '红队')}`
        : '';
      // 组队时 AI 的队伍在左下角名单里由房主逐个分配，这里只报数量
      const aiNote = s.aiCount ? ` · ${s.aiCount} 个 AI` : '';
      raceInfo.innerHTML = `
        ${teamPill}<span class="lc-pill">${modeName}</span>
        <span class="lc-chain">${iconImg(MAP_ICON[mapDef?.id], 'lc-ico') || '🏁'} ${escHtml(mapDef?.name || '随机赛道')}${weather ? ` · ${iconImg(WEATHER_ICON[weather.id], 'lc-p-ico')}${weather.name}` : ''}</span>
        <span class="lc-note">${isChallenge
          ? `${s.laps || 3} 圈 · 与影子对战（无 AI）`
          : `${s.laps || 3} 圈 · ${matchName}${aiNote}${teamNote}`}</span>`;
    }
  }

  // 主机 IP 提示
  const ipInfo = $('host-ip-info');
  if (isHost && lanIps && lanIps.length) {
    ipInfo.classList.remove('hidden');
    ipInfo.innerHTML = `${iconImg('uiSignal', 'lc-p-ico')}朋友加入方式：浏览器打开 <b>http://${lanIps[0]}:3000</b>`;
  } else {
    ipInfo.classList.add('hidden');
  }

  $('lobby-wait-text').textContent = isHost
    ? (missing.length
      ? '⏳ 等待所有玩家选好赛艇…'
      : offline.length
        ? '⏳ 有玩家正在重连…'
        : notReady.length
          ? `⏳ 等待 ${notReady.map((p) => p.name).join('、')} 准备…`
          : '✅ 所有人已准备，可以发车！')
    : (roster.players.find((p) => p.id === myId)?.ready
      ? '✅ 已准备 · 等待主机开始比赛…'
      : hexRandomBoat
        ? '点「准备」，等待主机开始比赛（赛艇开局随机分配）…'
        : '选好赛艇后点「准备」，等待主机开始比赛…');

  // 客人只能换赛艇：地图 / 天气 / 模式按钮置灰且不可点（点击逻辑在 main.js）
  for (const [id, label] of [['btn-lobby-map', '地图'], ['btn-lobby-weather', '天气'], ['btn-lobby-mode', '模式']]) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle('locked', !isHost);
    btn.disabled = !isHost;
    btn.title = isHost ? '' : `只有房主可以更改${label}`;
  }

  const countEl = $('lobby-player-count');
  // 组队联机的 AI 不在服务器名单里，人数按实际渲染出的行来算
  if (countEl) countEl.textContent = `${wrap.children.length} 人`;

  // 底部赛艇阵容：全艇一览，已被选走的标玩家名，本机用高亮卡
  const strip = $('lobby-boat-strip');
  if (strip) {
    strip.innerHTML = BOATS.map((boat) => {
      const owner = roster.players.find((p) => p.boatId === boat.id);
      const color = '#' + boat.color.toString(16).padStart(6, '0');
      const me = owner && owner.id === myId;
      return `
        <div class="lobby-boat-card${me ? ' me' : ''}${owner ? '' : ' idle'}">
          <span class="lbc-dot" style="--c:${color}"></span>
          <b>${escHtml(boat.name)}</b>
          <small>${owner ? escHtml(owner.name) : (hexRandomBoat ? '随机池' : '空闲')}</small>
        </div>`;
    }).join('');
  }

  // 设置抽屉顶部的只读摘要（所有人都能看到，改动仍由房主在下方控件完成）
  const view = $('lobby-settings-view');
  if (view) {
    const s = roster.settings || {};
    const isBoss = roster.mode === 'boss';
    let rows;
    if (isBoss) {
      const diffName = { normal: '普通', elite: '精英', nightmare: '噩梦' }[s.difficulty] || '普通';
      rows = [
        ['模式', s.variant === 'hex' ? '怪物模式 · 海克斯' : '怪物模式 · 闯关'],
        ['难度', diffName],
        ['关卡', '火山 → 浅海 → 港口 → 冰海 → 圣辉雪原'],
      ];
    } else {
      const mapDef = MAPS.find((m) => m.id === roster.mapId);
      const weather = WEATHERS.find((w) => w.id === roster.weather);
      const modeName = {
        race: '竞速', item: '道具', launch: '弹射', arena: '竞技场', challenge: '挑战 · 影子',
      }[roster.mode] || '竞速';
      const isChallenge = roster.mode === 'challenge';
      rows = [
        ['模式', modeName],
        ['地图', mapDef?.name || '随机赛道'],
        ['天气', weather?.name || '—'],
        ['圈数', `${s.laps || 3} 圈`],
        ['赛制', isChallenge ? '影子对战' : (s.rounds === 3 ? '三局积分制' : '单场定胜负')],
        ['AI', isChallenge ? '无（只跟影子跑）' : (s.aiCount ? `${s.aiCount} 个` : '无')],
      ];
    }
    view.innerHTML = rows.map(([k, v]) => `
      <div class="lsv-row"><span>${escHtml(k)}</span><b>${escHtml(v)}</b></div>`).join('');
  }
}

export function fmtTime(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// ---------- 完赛观察界面：右侧成绩 + 顶部倒计时 ----------
export function showFinishPanel(show, challenge = false) {
  const panel = $('finish-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !show);
  panel.classList.toggle('challenge', !!challenge);
  $('hud')?.classList.toggle('finish-mode', !!show);
  if (!show) {
    const s = $('fp-standings');
    const l = $('fp-laps');
    if (s) s.innerHTML = '';
    if (l) l.innerHTML = '';
  }
}

export function updateFinishPanel(d) {
  if (!d) return;
  const rankEl = $('fp-rank');
  const nameEl = $('fp-name');
  const totalEl = $('fp-total');
  const bestEl = $('fp-best');
  const medalEl = $('fp-medal');
  if (rankEl) rankEl.textContent = d.rank ?? '—';
  if (nameEl) nameEl.textContent = d.name || '玩家';
  if (totalEl) totalEl.textContent = d.total != null ? fmtTime(d.total) : '—';
  if (bestEl) bestEl.textContent = d.bestLap != null ? fmtTime(d.bestLap) : '—';
  // 影子最佳：本局最快圈 vs 挑战模式里留下的影子
  // 差值写进标签（"影子最佳 · 慢 0.31s"），数值格只放时间 —— 三格并排时长文本会挤成两行
  const ghostEl = $('fp-ghost');
  if (ghostEl) {
    if (d.ghostBest != null) {
      ghostEl.textContent = fmtTime(d.ghostBest);
      const k = d.bestLap != null ? d.bestLap - d.ghostBest : null;
      const lab = $('fp-ghost-lab');
      if (lab) {
        lab.textContent = k == null ? '影子最佳'
          : Math.abs(k) < 0.02 ? '影子最佳 · 打平'
            : `影子最佳 · ${k < 0 ? '快' : '慢'} ${Math.abs(k).toFixed(2)}s`;
      }
      ghostEl.style.color = k != null && k < -0.02 ? '#8dffc0' : '';
    } else {
      ghostEl.textContent = '—';
      ghostEl.style.color = '';
      const lab = $('fp-ghost-lab');
      if (lab) lab.textContent = '影子最佳';
    }
  }
  // 观察期内还没冲线的玩家显示「比赛中」，避免名次被误读成最终成绩
  if (medalEl) medalEl.textContent = d.challenge
    ? (d.challengeImproved ? '刷新纪录' : '挑战完成')
    : (d.finished === false
      ? '比赛中'
      : (['冠军', '亚军', '季军'][Number(d.rank) - 1] || '完赛'));
  // 挑战模式：顶部改成 CHALLENGE，底部改成"按空格返回大厅"
  const challenge = !!d.challenge;
  const eyebrow = $('fp-eyebrow');
  if (eyebrow) eyebrow.textContent = challenge ? 'CHALLENGE' : 'FINISH';
  const rankNum = $('fp-rank-num');
  const rankUnit = document.querySelector('#finish-panel .fp-rank-unit');
  if (rankNum) rankNum.textContent = challenge ? '✓' : (d.rank ?? '—');
  if (rankUnit) rankUnit.textContent = challenge ? '完成' : '名';
  const hint = $('fp-hint');
  if (hint) hint.textContent = challenge ? '按 空格 返回大厅' : '颁奖台即将开始…';

  const standingsEl = $('fp-standings');
  if (standingsEl) {
    standingsEl.innerHTML = (d.standings || []).map((s) => {
      // 只有本机的单圈数据是已知的；其他船没有逐圈计时，用长横线占位
      const bestCell = s.isMe && d.bestLap != null
        ? `<span class="b best">${fmtTime(d.bestLap)}</span>`
        : '<span class="b">—</span>';
      return `
      <div class="fp-row${s.isMe ? ' me' : ''}">
        <span class="r">${String(s.rank).padStart(2, '0')}</span>
        <span class="n">${escHtml(s.name)}</span>
        <span class="t${s.finished ? ' done' : ''}">${s.finished && s.time != null ? fmtTime(s.time) : `LAP ${s.lap}`}</span>
        ${bestCell}
      </div>`;
    }).join('');
  }

  const lapsEl = $('fp-laps');
  if (lapsEl) {
    const best = d.bestLap;
    lapsEl.innerHTML = (d.laps || []).length
      ? d.laps.map((t, i) => `
        <div class="fp-lap${best != null && Math.abs(t - best) < 0.005 ? ' best' : ''}">
          <span>第 ${i + 1} 圈</span><b>${fmtTime(t)}</b>
        </div>`).join('')
      : '<div class="fp-lap"><span>暂无完整圈</span><b>—</b></div>';
  }
}

// ---------- 速度仪表盘：整圆刻度（270° 扫角）+ 带惯性的指针 ----------
const SPEEDO_MAX_KMH = 240;
const SPEEDO_CX = 110;
const SPEEDO_CY = 110;
const SPEEDO_SWEEP = 270; // -135° → +135°，底部留口放档位
const speedoState = { angle: -135, lastUpdate: 0, built: false };

function speedoPoint(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [SPEEDO_CX + Math.sin(a) * r, SPEEDO_CY - Math.cos(a) * r];
}

function buildSpeedoTicks() {
  if (speedoState.built) return;
  const ticks = $('speedo-ticks');
  const labels = $('speedo-labels');
  if (!ticks) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (let v = 0; v <= SPEEDO_MAX_KMH; v += 10) {
    const deg = -SPEEDO_SWEEP / 2 + (v / SPEEDO_MAX_KMH) * SPEEDO_SWEEP;
    const major = v % 40 === 0;
    const redline = v > 210;
    const [x1, y1] = speedoPoint(major ? 84 : 89, deg);
    const [x2, y2] = speedoPoint(98, deg);
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x1.toFixed(2));
    line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2));
    line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('class', `tick${major ? ' major' : ''}${redline ? ' redline' : ''}`);
    ticks.appendChild(line);
    if (major && labels) {
      const [lx, ly] = speedoPoint(71, deg);
      const text = document.createElementNS(NS, 'text');
      text.setAttribute('x', lx.toFixed(2));
      text.setAttribute('y', ly.toFixed(2));
      text.setAttribute('class', 'speedo-label');
      text.textContent = String(v);
      labels.appendChild(text);
    }
  }
  speedoState.built = true;
}

function updateSpeedo(speed, maxSpeed, hidden) {
  buildSpeedoTicks();
  const needle = $('speedo-needle');
  if (!needle) return;
  // 表盘刻度固定 0~240（氮气极速上限），各船按自己的氮气上限扫到不同位置
  const kmh = Math.max(0, Number(speed) || 0);
  const ratio = Math.max(0, Math.min(1, kmh / SPEEDO_MAX_KMH));
  const target = -SPEEDO_SWEEP / 2 + ratio * SPEEDO_SWEEP;
  const now = performance.now();
  const dt = speedoState.lastUpdate ? Math.min(0.12, (now - speedoState.lastUpdate) / 1000) : 0.016;
  speedoState.lastUpdate = now;
  if (hidden) {
    speedoState.angle = target;
  } else {
    // 指针比数字慢一拍：急加速/急刹时先冲后回，有重量感
    const k = 1 - Math.exp(-dt * 9);
    speedoState.angle += (target - speedoState.angle) * k;
  }
  needle.setAttribute('transform', `rotate(${speedoState.angle.toFixed(2)} ${SPEEDO_CX} ${SPEEDO_CY})`);
  const gear = $('speedo-gear');
  if (gear) gear.textContent = kmh < 1 ? 'N' : 'D';
}

// 左侧名次板：按名次顺序渲染全部玩家，签名变化（换位/完赛）时才重建 DOM
let rankListSig = '';
let debuffSig = '';

// 1st / 2nd / 3rd / 4th …（11th~13th 是特例，不能按个位数字判断）
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function renderRankList(panel, list) {
  // 头像可能是一长串 dataURL：签名只取长度 + 尾巴，不每帧拼整张图
  // 道具图标也要进签名：吃到/用掉后名字名次都没变，但图标必须跟着刷新
  const sig = list.map((s) => `${s.rank}:${s.name}:${s.isMe ? 1 : 0}:${s.isHost ? 1 : 0}:${s.team || ''}:${
    s.avatar ? `${s.avatar.length}${s.avatar.slice(-8)}` : ''}${s.ai ? 'a' : ''
    }:h${(s.items || []).map((it) => it?.name || '').join(',')}`).join('|');
  if (sig === rankListSig) return;
  rankListSig = sig;
  panel.textContent = '';
  for (const s of list) {
    const row = document.createElement('div');
    row.className = 'rank-row' + (s.isMe ? ' me' : '') + (s.isHost ? ' host' : '');
    const badge = document.createElement('span');
    // 前三名前缀 1st/2nd/3rd 用金色徽章，其余用蓝灰徽章兜底
    badge.className = 'rank-medal' + (s.rank > 3 ? ' plain' : '');
    badge.textContent = ordinal(s.rank);
    const face = document.createElement('span');
    face.className = 'rank-avatar';
    face.innerHTML = avatarMarkup(s.avatar, s.ai, s.id);
    const name = document.createElement('span');
    name.className = 'rank-name';
    // 组队赛制：名字前画队伍色圆点（蓝队 / 红队）
    if (s.team) {
      const dot = document.createElement('i');
      dot.className = 'rank-team-dot ' + (s.team === 'blue' ? 'blue' : 'red');
      name.appendChild(dot);
    }
    name.appendChild(document.createTextNode(s.name || '玩家'));
    row.append(badge, face, name);
    // 名次栏右侧的持有道具（最多 3 件，横排）。只显示自己与同队的：
    // Game.js 已经按队伍过滤过，没资格看的玩家 items 是空数组。
    const held = Array.isArray(s.items) ? s.items.slice(0, 3) : [];
    if (held.length) {
      const box = document.createElement('span');
      box.className = 'rank-items';
      for (const it of held) {
        const ico = document.createElement('span');
        ico.className = 'rank-item';
        const art = ART_ON && it ? ITEM_ART[it.name] : null;
        const title = it?.name || '道具';
        ico.title = title;
        ico.setAttribute('aria-label', title);
        if (art) {
          ico.classList.add('has-art');
          const img = document.createElement('img');
          img.src = art;
          img.alt = '';
          img.draggable = false;
          ico.appendChild(img);
        } else {
          ico.textContent = it?.icon || '?';
        }
        box.appendChild(ico);
      }
      row.appendChild(box);
    }
    panel.appendChild(row);
  }
}

function renderDebuffs(list) {
  const box = $('hud-debuffs');
  if (!box) return;
  const arr = Array.isArray(list) ? list : [];
  // 每帧都会调用：签名没变就完全不碰 DOM
  const sig = arr.map((x) => `${x.icon}${x.label}${x.t.toFixed(1)}`).join('|');
  if (sig === debuffSig) return;
  debuffSig = sig;
  box.textContent = '';
  for (const x of arr) {
    const el = document.createElement('div');
    el.className = 'debuff-chip' + (x.buff ? ' buff' : '');
    const icon = document.createElement('span');
    if (!setIcon(icon, STATUS_ICON[x.key]) && !icon.childElementCount) icon.textContent = x.icon;
    const label = document.createElement('span');
    label.textContent = x.label;
    const left = document.createElement('span');
    left.className = 'dt';
    left.textContent = `${Math.max(0, x.t).toFixed(1)}s`;
    el.append(icon, label, left);
    box.appendChild(el);
  }
}

/** 云端天梯专用：竞技场式层/分/货面板 + 阶段条 + 玩家榜 + 冲刺槽 */
function renderTowerExtras(d, on) {
  const root = $('tower-hud');
  if (!root) return;
  root.classList.toggle('hidden', !on);
  if (!on) return;
  const set = (id, v) => { const el = $(id); if (el) el.textContent = String(v); };
  const layer = Math.max(1, d.towerLayer ?? 1);
  // 第 1 层是水球赛、第 2 层是送包子：同一块面板换口径，
  // 别让玩家在第 1/2 层看到"背包价值"这种属于旧玩法的字
  const foot = !!d.towerFoot;
  const dlv = !!d.towerDeliver;
  const rush = !!d.towerRush;
  const boss = !!d.towerBoss;
  // 第 5 层落雷竞技：本层口径 = 被劈次数（越少越好）
  const thun = !!d.towerThunder;
  root.classList.toggle('thunder', thun);
  set('th-layer', String(layer).padStart(2, '0'));
  set('th-layer-total', `/${d.towerLayers ?? 10}`);
  set('th-score', d.towerScore ?? 0);
  set('th-cargo', foot ? (d.towerFootGoals ?? 0)
    : dlv ? (d.towerDeliverScore ?? 0)
      : rush ? (d.towerRushBoxes ?? 0)
        : boss ? (d.towerBossDmg ?? 0)
          : thun ? (d.towerThunderMine ?? 0)
            : (d.towerCargoValue ?? 0));
  const cap = root.querySelector('.th-cell-cargo .th-cap');
  if (cap) {
    cap.textContent = foot ? 'GOAL · 本层进球'
      : dlv ? 'SEND · 本层送达'
        : rush ? 'BOX · 本层箱子'
          : boss ? 'DMG · 本层伤害'
            : thun ? 'STRUCK · 被劈次数'
              : 'CARGO · 背包价值';
  }

  // 6 格菱形货位：挂满就是"该上楼入账了"；水球赛改成进球数，送包子改成送达数，
  // 第 3 层改成吃到的箱子数、第 4 层改成"BOSS 血量剩余"（满格 = 满血）
  const pips = $('th-cargo-pips');
  if (pips) {
    const raw = foot ? (d.towerFootGoals ?? 0)
      : dlv ? (d.towerDeliverScore ?? 0)
        : rush ? (d.towerRushBoxes ?? 0)
          : boss ? Math.ceil((d.towerBossHp ?? 0) * 6)
            : thun ? (d.towerThunderMine ?? 0)
              : (d.towerCargo ?? 0);
    const n = Math.max(0, Math.min(6, raw));
    pips.innerHTML = Array.from({ length: 6 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  }

  // 阶段条：前 60 秒收集期（橙），之后升降光柱开启（青）
  const phase = $('th-phase');
  if (phase) phase.classList.toggle('open', !!d.towerUpliftOpen);
  const left = Math.ceil(d.towerCollectLeft ?? 0);
  const rushLeft = Math.ceil(d.towerRushLeft ?? 0);
  const bossLeft = Math.ceil(d.towerBossLeft ?? 0);
  set('th-phase-txt', foot
    ? '水球赛 · 把球撞进对方球门'
    : dlv
      ? (d.towerICarry ? '🥟 你背着包子 · 冲向你那端的终点门'
        : d.towerCarrier ? `🥟 包子在 ${d.towerCarrierName || '对手'}手上 · K 放泡泡炸他`
          : '🥟 包子在中央取货台 · 先去抢')
      : rush
        ? `🎁 道具箱大乱斗 · 剩 ${Math.floor(rushLeft / 60)}:${String(rushLeft % 60).padStart(2, '0')} · 箱子 ${d.towerRushBoxes || 0} / 命中 ${d.towerRushHits || 0}`
        : boss
          ? `⚡ 雷霆龙骑士${d.towerBossEnraged ? ' · 狂暴' : ''} · 剩 ${Math.floor(bossLeft / 60)}:${String(bossLeft % 60).padStart(2, '0')} · 伤害 ${d.towerBossDmg || 0}`
          : thun
            ? `🌩 落雷竞技 · 剩 ${Math.floor(Math.ceil(d.towerThunderLeft ?? 0) / 60)}:${String(Math.ceil(d.towerThunderLeft ?? 0) % 60).padStart(2, '0')} · 下一波 ${(d.towerThunderNext ?? 0).toFixed(1)}s · 被劈 ${d.towerThunderMine || 0}`
            : d.towerUpliftOpen
          ? '升降通道已开启 · 运货上塔'
          : `收集期 · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} · 通道关闭`);

  const energy = $('th-energy-fill');
  if (energy) energy.style.width = `${Math.max(0, Math.min(1, d.towerEnergy ?? 0)) * 100}%`;
  const dash = $('th-dash');
  if (dash) dash.classList.toggle('over', !!d.towerOverheat);
  const txt = $('th-energy-txt');
  if (txt) txt.textContent = d.towerOverheat ? 'OVERHEAT' : 'DASH';

  const boards = $('th-boards');
  if (boards) {
    const players = Array.isArray(d.towerPlayers) ? d.towerPlayers : [];
    const tail = (p) => (foot ? `${p.goals || 0}球`
      : dlv ? `${p.deliver || 0}送达`
        : rush ? `${p.boxes || 0}箱·${p.hits || 0}中`
          : boss ? `${p.dmg || 0}伤害`
            : thun ? `${p.struck || 0}劈${p.dnf ? '·淘汰' : ''}`
              : `${p.cargo}货`);
    boards.innerHTML = players.map((p, i) =>
      `<div class="th-row${p.me ? ' me' : ''}"><span><i class="th-rank">${i + 1}</i>${p.name}${p.ai ? ' 🤖' : ''} · ${p.layer}层 · ${tail(p)}</span><b>${p.score}</b></div>`
    ).join('');
  }
  // 底部提示语跟着玩法换：第 1 层撞球、第 2 层送包子，其余层还是撞人掉货
  const thHint = root.querySelector('.th-hint');
  if (thHint) {
    thHint.textContent = foot
      ? '撞球进门 · K 冲刺能把球顶得更远 · 别冲出玻璃边缘'
      : dlv
        ? 'K 放泡泡（3 秒引爆）· 背货时极速 ×0.72 且不能放泡泡'
        : rush
          ? '撞碎道具箱拿道具 · 1/2/3 释放 · 箱子算主分，打中对手再 +1'
          : boss
            ? '1 发雷炮 · K 冲刺撞 BOSS 翻倍 · 红圈亮起就闪开'
            : thun
              ? '红圈亮起就闪开 · 把对手撞进红圈 · 被劈最少者胜'
              : '冲刺撞击掉货 · 把对手推下平台';
  }
}

/** 竞技场专用：三关各自的目标条 + 固定技能 CD + 决斗关举盾能量。非竞技场一律隐藏 */
function renderArenaExtras(d, on) {
  const core = $('arena-core');
  const skills = $('arena-skills');
  const block = $('arena-block');
  if (core) core.classList.toggle('hidden', !on);
  if (skills) skills.classList.toggle('hidden', !on);
  if (!on) {
    if (block) block.classList.add('hidden');
    return;
  }

  const kind = d.arenaKind || 'delivery';
  if (core) {
    core.classList.toggle('kind-delivery', kind === 'delivery');
    core.classList.toggle('kind-ringout', kind === 'ringout');
    core.classList.toggle('kind-duel', kind === 'duel');
  }
  const meEl = $('ac-me');
  const foeEl = $('ac-foe');
  const track = core?.querySelector('.ac-track');
  const fill = $('ac-fill');
  const hint = $('ac-hint');
  const setScores = (mine, foeS) => {
    if (meEl) {
      meEl.textContent = String(mine);
      meEl.classList.toggle('lead', mine > foeS);
    }
    if (foeEl) {
      foeEl.textContent = String(foeS);
      foeEl.classList.toggle('lead', foeS > mine);
    }
  };
  const setFill = (leftPct, widthPct, mine) => {
    if (fill) {
      fill.style.left = leftPct.toFixed(1) + '%';
      fill.style.width = Math.max(0, widthPct).toFixed(1) + '%';
    }
    if (track) {
      track.classList.toggle('hold-me', mine === true);
      track.classList.toggle('hold-foe', mine === false);
    }
  };

  if (kind === 'delivery') {
    // 核心位置：负数 = 我在往对方门里推（绿），正数 = 对手在推（红）
    const p = Math.max(-1, Math.min(1, Number(d.deliveryProg) || 0));
    setScores(Number(d.deliveryPushMe) || 0, Number(d.deliveryPushFoe) || 0);
    const dir = p < -0.005 ? true : p > 0.005 ? false : null;
    setFill(p < 0 ? 0 : 50, Math.abs(p) * 50, dir);
    if (hint) {
      hint.textContent = d.arenaOvertime
        ? '加时 · 推进速度 ×1.5 · 先领先 15m 获胜'
        : '潮汐核心 · 贴近才推得动 · 双方贴近会僵持';
    }
  } else if (kind === 'ringout') {
    const mine = Number(d.arenaRingMe) || 0;
    const foeS = Number(d.arenaRingFoe) || 0;
    setScores(mine, foeS);
    // 谁领先就画谁的进度（3 次撞出赢下本关）
    setFill(0, (Math.max(mine, foeS) / 3) * 100, mine >= foeS);
    if (hint) hint.textContent = `撞出擂台 ${mine} : ${foeS} · 先到 3 分`;
  } else {
    const shrink = Math.max(0, Math.min(1, Number(d.duelShrink) || 0));
    setFill(0, shrink * 100, false);
    if (hint) {
      hint.textContent = `缩圈 ${Math.round(Number(d.arenaRingR) || 0)}m · 圈外持续掉血`;
    }
  }

  // 决斗关举盾能量条
  if (block) {
    const show = kind === 'duel';
    block.classList.toggle('hidden', !show);
    if (show) {
      const e = Math.max(0, Math.min(1, Number(d.blockEnergy ?? 1)));
      const oh = Number(d.blockOverheat) || 0;
      block.classList.toggle('overheat', oh > 0);
      block.classList.toggle('active', !!d.blockActive);
      const bf = $('ab-fill');
      if (bf) bf.style.width = (e * 100).toFixed(1) + '%';
      const bt = $('ab-txt');
      if (bt) {
        bt.textContent = oh > 0
          ? `过热 ${Math.ceil(oh)}s`
          : d.blockActive ? '格挡中' : '按住 H 举盾';
      }
    }
  }

  // 技能冷却：条子按剩余比例缩，冷却中再压一层剩余秒数
  const setSkill = (wrapId, fillId, timerId, left, total) => {
    const wrap = $(wrapId);
    const bar = $(fillId);
    const timer = $(timerId);
    if (!wrap) return;
    const ratio = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
    const ready = left <= 0.06;
    wrap.classList.toggle('ready', ready);
    wrap.classList.toggle('cooling', !ready);
    if (bar) bar.style.width = (ratio * 100).toFixed(1) + '%';
    if (timer) timer.textContent = ready ? '' : Math.ceil(left).toString();
  };
  // 冷却总时长和 ArenaMode 的 ARENA_SKILLS 保持一致（改那边记得改这里）
  setSkill('as-dash', 'as-dash-cd', 'as-dash-t', Number(d.dashCd) || 0, 6);
  setSkill('as-ult', 'as-ult-cd', 'as-ult-t', Number(d.ultCd) || 0, 24);
  // 擂台关锁大招：压暗并显示不可用，避免玩家按 F 没反应以为卡了
  const ult = $('as-ult');
  if (ult) ult.classList.toggle('off', !!d.arenaUltOff);
}

/**
 * 底部技能轨道：J 主炮 / CTRL 氮气 / F 协同。
 * 三格共用一条 3px 能量条，状态只靠颜色区分（ready 青绿 / hot 烙铁红 / gold 超载金 / off 压暗），
 * 名称行直接写当前状态，玩家扫一眼就知道哪个键按得出来。
 */
function renderSkillTrack(d) {
  const track = $('skill-track');
  if (!track) return;
  const pct = (v) => Math.max(0, Math.min(1, Number(v) || 0)) * 100;
  const secs = (v) => Math.max(0, Number(v) || 0);

  // J：激光看蓄力（满蓄力才值得放），其它炮看热量（顶满会过热停火）
  if (d.weapon && d.weapon.kind === 'beam') {
    const charge = pct(d.weaponCharge);
    const full = charge >= 99.5;
    setSlot('sk-j', charge, full ? '满蓄力' : `蓄力 ${charge.toFixed(0)}%`, {
      ready: full,
      gold: secs(d.overload) > 0,
      hot: secs(d.weaponLock) > 0,
      off: secs(d.weaponLock) > 0,
    });
  } else {
    const heat = pct(d.weaponHeat);
    let text = `热量 ${heat.toFixed(0)}%`;
    const cls = { hot: d.weaponOverheat || heat >= 88 };
    if (secs(d.overload) > 0) {
      text = `超载 ${secs(d.overload).toFixed(1)}s`;
      cls.gold = true;
      cls.hot = false;
    } else if (secs(d.weaponLock) > 0) {
      text = `灼膛 ${secs(d.weaponLock).toFixed(1)}s`;
      cls.hot = true;
      cls.off = true;
    } else if (d.weaponOverheat) {
      text = '过热停火';
    }
    setSlot('sk-j', heat, text, cls);
  }

  // CTRL：氮气是消耗品，漂移攒满一格自动变成一瓶
  if (!d.nitroAllowed) {
    setSlot('sk-nitro', pct(d.nitroCharge), '已禁用', { off: true });
  } else if (secs(d.nitroBoost) > 0) {
    setSlot('sk-nitro', (secs(d.nitroBoost) / 4.2) * 100, `加速 ${secs(d.nitroBoost).toFixed(1)}s`, { ready: true });
  } else if (d.nitroBottles > 0) {
    setSlot('sk-nitro', pct(d.nitroCharge), `氮气 ×${d.nitroBottles}`, { ready: true });
  } else {
    const c = pct(d.nitroCharge);
    setSlot('sk-nitro', c, `集气 ${c.toFixed(0)}%`, {});
  }

  // F：双人协同单独放在左下角长条里（见 renderComboBar），这里不再占格
  const aggro = $('sk-aggro');
  if (aggro) aggro.classList.toggle('hidden', !d.aggroMine);
}

/** 左下角协同合击长条：彩虹渐变进度，攒满后整条亮起并提示“两人同时按 F” */
function renderComboBar(d) {
  const box = $('combo-bar');
  if (!box) return;
  const charge = Math.max(0, Math.min(1, Number(d.comboCharge) || 0));
  const ready = !!d.comboReady;
  const armed = !!d.comboArmed;
  const fill = $('combo-fill');
  if (fill) fill.style.width = `${((ready ? 1 : charge) * 100).toFixed(0)}%`;
  const pct = $('combo-pct');
  const pctText = armed ? '预备' : (ready ? '就绪' : `${(charge * 100).toFixed(0)}%`);
  if (pct && pct.textContent !== pctText) pct.textContent = pctText;
  const hint = $('combo-hint');
  let hintText;
  if (armed) {
    hintText = '已预备 · 等队友同时按 F';
  } else if (ready) {
    hintText = d.comboMateName ? `与 ${d.comboMateName} 同时按 F` : '需要队友靠近';
  } else if (d.comboMateName) {
    hintText = d.comboMateCharge == null
      ? `与 ${d.comboMateName} 一起攒满`
      : `与 ${d.comboMateName} 一起攒满（队友 ${Math.round(d.comboMateCharge)}%）`;
  } else {
    hintText = '需要队友靠近才能攒';
  }
  if (hint && hint.textContent !== hintText) hint.textContent = hintText;
  box.classList.toggle('ready', ready);
}

/** 写一格技能：fill 是 0~100 的条长，text 是名称行的状态文案，cls 是状态类 */
function setSlot(id, fill, text, cls) {
  const slot = $(id);
  if (!slot) return;
  const bar = slot.querySelector('.sk-bar i');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, fill)).toFixed(0)}%`;
  const name = slot.querySelector('.sk-name');
  if (name && name.textContent !== text) name.textContent = text;
  const c = cls || {};
  slot.classList.toggle('ready', !!c.ready);
  slot.classList.toggle('hot', !!c.hot);
  slot.classList.toggle('gold', !!c.gold);
  slot.classList.toggle('off', !!c.off);
}

// ---------- 道具槽悬停说明 ----------
// 原生 title 在 HUD 里又慢又容易被忽略，这里自己画一块跟随槽位的玻璃提示卡。
// 槽上的文案由 updateHud 每帧写进 dataset，鼠标进来时直接读，不再查道具表。
let itemTipBound = false;
function itemTipHide() {
  $('item-tip')?.classList.remove('show');
}
function placeItemTip(slot, tip) {
  const r = slot.getBoundingClientRect();
  const pad = 10;
  const left = Math.max(pad, Math.min(
    window.innerWidth - tip.offsetWidth - pad,
    r.left + r.width / 2 - tip.offsetWidth / 2,
  ));
  // 默认浮在槽上方；上方放不下（窗口很矮）就翻到下方
  let top = r.top - tip.offsetHeight - 10;
  if (top < pad) top = r.bottom + 10;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function ensureItemTip() {
  if (itemTipBound) return;
  const bar = $('item-slots');
  const tip = $('item-tip');
  if (!bar || !tip) return;
  itemTipBound = true;
  // 事件委托：updateHud 每帧重绘槽内容，绑定在槽上的监听会被冲掉
  bar.addEventListener('pointerover', (e) => {
    const slot = e.target.closest?.('.item-slot');
    if (!slot || !bar.contains(slot) || !slot.dataset.tipName) { itemTipHide(); return; }
    tip.innerHTML = `<div class="it-name">${escHtml(slot.dataset.tipName)}</div>`
      + `<div class="it-desc">${escHtml(slot.dataset.tipDesc || '')}</div>`
      + `<div class="it-key">按 ${escHtml(slot.dataset.tipKey || '')} 使用</div>`;
    tip.classList.add('show');
    placeItemTip(slot, tip);
  });
  bar.addEventListener('pointermove', (e) => {
    const slot = e.target.closest?.('.item-slot');
    if (slot) placeItemTip(slot, tip);
  });
  bar.addEventListener('pointerleave', itemTipHide);
  // 点一下画面（开赛/射击）或比赛结束都要把提示收掉
  document.addEventListener('pointerdown', itemTipHide, true);
}

export function updateHud(d) {
  const isBoss = d.mode === 'boss';
  // 竞技场：沿用同一套骨架，但「圈数/名次/赛道进度」全部无意义，
  // 底部进度条改成本局血量，右上角改显示对手血量
  const isArena = d.mode === 'arena';
  const isTower = d.mode === 'skytower';
  // boss-mode：底部重复的 BOSS 血量条、残留的 0 KM/H 都由这个类统一收掉
  const hudRoot = $('hud');
  if (hudRoot) {
    hudRoot.classList.toggle('boss-mode', isBoss);
    // 竞技场左下角改成宽血条（红色，数值嵌在条里），CSS 见 index.html
    hudRoot.classList.toggle('arena-mode', isArena);
    hudRoot.classList.toggle('tower-mode', isTower);
    // 第 3 层（道具箱大乱斗）才有道具栏：tower-mode 默认把 #item-slots 整块 display:none，
    // 这里单独放行一份，并且把它抬到 DASH 条上方（两者都在底部居中，会叠在一起）
    hudRoot.classList.toggle('tower-rush', isTower && !!d.towerRush);
  }
  $('hud-speed').textContent = d.speed;
  renderDebuffs(d.debuffs);
  // HUD 常驻符号：圈数 🏁 / 计时 ⏱️ / 逆行 ⚠ / 影子 👻 全部换成 PNG。
  // setIcon 是幂等的（src 没变就不动 DOM），放在每帧必经路径上也不会反复重建图片。
  if (ART_ON) {
    setIcon($('hud-lap-ico'), 'uiLap');
    setIcon($('hud-time-ico'), 'uiTimer');
    setIcon($('wrong-way-ico'), 'uiWrongWay');
    setIcon($('ghost-ico'), 'uiGhost');
  }
  const topRow = $('hud-top');
  if (topRow) topRow.classList.toggle('boss', isBoss);
  // BOSS 模式：隐藏竞速名次板，沿用原来的“输出”牌子
  const rankPanel = $('hud-rank');
  if (isBoss) {
    const boss = d.boss;
    $('hud-lap').querySelector('.label').textContent = '关卡';
    // 海克斯按「层」计数（无尽续层后总层数会增长，不再硬编码 /4）
    $('hud-lap').querySelector('.value').innerHTML = boss?.layer
      ? `${boss?.stage || 1}<small>层</small>`
      : `${boss?.stage || 1}<small>/${boss?.stages || 4}</small>`;
    $('hud-pos').querySelector('.label').textContent = '输出';
    $('hud-pos').querySelector('.value').innerHTML = `${Math.round(d.damageMine || 0)}<small>伤害</small>`;
    $('hud-pos').classList.remove('hidden');
    rankPanel.classList.add('hidden');
  } else if (isTower) {
    // 天梯：左牌显示当前层，右牌显示本局得分；名次板交给 #tower-hud 的榜单
    $('hud-lap').querySelector('.label').textContent = '层数';
    $('hud-lap').querySelector('.value').innerHTML = `${d.towerLayer || 1}<small>/${d.towerLayers || 10}</small>`;
    $('hud-pos').querySelector('.label').textContent = '得分';
    $('hud-pos').querySelector('.value').innerHTML = `${d.towerScore || 0}`;
    $('hud-pos').classList.remove('hidden');
    rankPanel.classList.add('hidden');
  } else if (isArena) {
    // 顶栏两块牌子：左边"对局 N"，右边"比分 我:对手"。
    // 原来写成"回合 N局"，中文读起来别扭（而且和下方的比分栏语义重复）
    $('hud-lap').querySelector('.label').textContent = '对局';
    $('hud-lap').querySelector('.value').innerHTML = `${d.arenaRound || 1}`;
    $('hud-pos').querySelector('.label').textContent = '比分';
    $('hud-pos').querySelector('.value').innerHTML =
      `${d.arenaScoreMe || 0}<small>:${d.arenaScoreFoe || 0}</small>`;
    $('hud-pos').classList.remove('hidden');
    rankPanel.classList.add('hidden');
    // 对手血量不画在 HUD 上：改由 ArenaMode 在敌方赛艇船顶贴世界空间铭牌，
    // 这样对手跑到画面哪个角落都能看到（联机多对手时每人一块）。
  } else {
    // 顶栏圈数：竞速/道具模式必须在过线时实时更新（以前这块牌子只在 BOSS/竞技场
    // 分支里写过，普通比赛永远停在 HTML 初始的“第 1 圈”）。
    const laps = Math.max(1, Number(d.laps) || 1);
    const lapNow = Math.min(laps, Math.max(1, Number(d.lap) || 1));
    $('hud-lap').querySelector('.label').textContent = '圈数';
    $('hud-lap').querySelector('.value').innerHTML = `${lapNow}<small>/${laps}</small>`;
    // 名次改由左侧名次板展示，顶栏的“名次”牌子让位
    $('hud-pos').classList.add('hidden');
    const rank = Math.max(1, Number(d.rank) || 1);
    const list = Array.isArray(d.standings) && d.standings.length
      ? d.standings
      : [{ rank, name: d.myName || '玩家', isMe: true }];
    renderRankList(rankPanel, list);
    rankPanel.classList.remove('hidden');
  }
  // 竞技场显示「本局剩余时间」，不是整场 raceTime
  $('hud-time').querySelector('.value').textContent =
    fmtTime(isArena ? (d.arenaTimeLeft ?? 0) : isTower ? (d.towerTimeLeft ?? 0) : d.raceTime);
  // 仪表盘只在竞速/道具模式出现，BOSS 模式维持原来的纯数字速度
  const dial = $('speedo-dial');
  if (dial) dial.classList.toggle('hidden', isBoss);
  const hint = $('nitro-hint');
  if (hint) {
    hint.classList.toggle('hidden', isBoss);
    // 道具模式的氮气槽是"道具加速剩余"，不能漂移集气，提示语要跟着换，
    // 否则玩家会一直按 Shift 等集气
    hint.textContent = d.nitroLocked
      ? '氮气道具 · 拾取后自动加速'
      : '氮气集气 · Shift 漂移 / Ctrl 释放';
  }
  updateSpeedo(d.speed, d.maxSpeed, isBoss);
  if (isBoss) {
    const hp = Math.max(0, Math.min(1, d.boss?.hp ?? 0));
    $('hud-progress-bar').style.width = (hp * 100).toFixed(1) + '%';
    $('hud-progress-text').textContent = `BOSS 生命 ${(hp * 100).toFixed(0)}%`;
  } else if (isArena) {
    const hp = Math.max(0, Math.min(1, d.arenaHpMe ?? 0));
    $('hud-progress-bar').style.width = (hp * 100).toFixed(1) + '%';
    // 数值直接嵌在血条里，跟参考图一样：3723/6763
    $('hud-progress-text').textContent =
      `${Math.max(0, Math.round(d.playerHp || 0))} / ${Math.round(d.playerMaxHp || 0)}`;
  } else if (isTower) {
    // 天梯：底部进度条显示本局时间进度，右侧文字跟着当前层的玩法换口径
    const total = 300;
    $('hud-progress-bar').style.width = (Math.max(0, Math.min(1, (d.towerTimeLeft ?? total) / total)) * 100).toFixed(1) + '%';
    const ptLabel = d.towerFoot ? '进球' : d.towerDeliver ? '送达' : '背包';
    const ptVal = d.towerFoot ? (d.towerFootGoals || 0)
      : d.towerDeliver ? (d.towerDeliverScore || 0) : (d.towerCargoValue || 0);
    $('hud-progress-text').innerHTML =
      `<span class="pt-label">剩余时间</span>`
      + `<b class="pt-num">${ptLabel} <small>${ptVal}</small></b>`;
  } else {
    $('hud-progress-bar').style.width = (d.progress * 100).toFixed(1) + '%';
    // 参照图：左边小标签「赛道进度」，右边一个大号斜体百分比，分两段才排得出来
    $('hud-progress-text').innerHTML =
      `<span class="pt-label">赛道进度</span>`
      + `<b class="pt-num">${(d.progress * 100).toFixed(0)}<small>%</small></b>`;
  }

  // 天气标签；海克斯天气额外挂一个小 buff 图标（悬停看效果说明）
  // 海克斯天气的 icon 是 `hex/xxx.png` 路径，必须走 hexIco 出 <img>：
  // 2026-11-22 之前这里直接拼字符串，路径被当文字打进 buff 小框里（用户截图里的乱码）。
  if (d.weather) {
    const wb = d.weatherFx;
    $('minimap-weather').innerHTML =
      `${iconImg(WEATHER_ICON[d.weather.id], 'mm-wico') || chipIco(d.weather.icon, 'mm-wico')} ${escHtml(d.weather.name)}`
      + (wb ? ` <span class="mm-buff" data-tip="${escHtml(wb.desc)}">${hexIco(wb.icon, 'mm-buff-ico')}</span>` : '');
  }

  // 左上角小地图（天梯是垂直场景，赛道俯视图无意义，直接不画）
  if (d.minimap && !isTower) drawMinimap(d.minimap, d.fireCore, d.portal, isBoss);

  // 右下彩虹条显示漂移集气进度；右上氮气框只显示已集满的氮气包（最多两格）。
  const speedEl = $('hud-speed');
  if (d.boostState === 'active') speedEl.style.color = '#ffb347';
  else if (d.boostState === 'ready') speedEl.style.color = '#ffe37a';
  else speedEl.style.color = isBoss ? '#8fb6d4' : '#fffdf0';
  const nitroWrap = $('nitro-wrap');
  const nitroStock = $('nitro-stock');
  if (d.nitroCharge != null) {
    nitroWrap.classList.remove('hidden');
    // 道具赛拿不到氮气瓶、也集不了气，但「框」必须留着（玩家要看到这个槽存在），
    // 换成灰铁空槽的样子；拾到氮气道具开始加速时才按真实进度点亮
    nitroWrap.classList.toggle('locked', !!d.nitroLocked);
    nitroStock.classList.remove('hidden');
    const charge = Math.max(0, Math.min(1, d.nitroCharge));
    $('nitro-fill').style.width = `${(charge * 100).toFixed(1)}%`;
    // 竞速/道具：右下集气条是六格方能量格，按 0~6 点亮（最后一格可半亮）
    const cells = document.querySelectorAll('#nitro-cells i');
    if (cells.length) {
      const lit = charge * cells.length;
      cells.forEach((cell, i) => {
        const f = Math.max(0, Math.min(1, lit - i));
        cell.style.opacity = f > 0.02 ? String(0.25 + f * 0.75) : '';
        cell.classList.toggle('on', f > 0.02);
      });
    }
    nitroWrap.classList.toggle('full', charge >= 0.995);
    nitroWrap.classList.toggle('active', d.boostState === 'active');
    const bottles = Math.max(0, Math.min(2, Math.floor(d.nitroBottles || 0)));
    nitroStock.querySelectorAll('.nitro-slot').forEach((slot, index) => {
      slot.classList.toggle('packed', index < bottles);
    });
    nitroStock.classList.toggle('active', d.boostState === 'active');
  } else {
    nitroWrap.classList.add('hidden');
    nitroStock.classList.add('hidden');
  }
  // 怪物 / 竞技场：右上角那格氮气瓶整块去掉（提示词 B 里右上只保留设置按钮，位置让给关卡/计时）
  // 道具赛（nitroLocked）保留：玩家要求右上角必须有氮气栏，锁定态显示两个空槽。
  if (isBoss || isArena) nitroStock.classList.add('hidden');

  // 倒计时
  const cd = $('countdown');
  let cdText = null;
  let cdGo = false;
  if (isBoss) {
    if (d.bossPhase === 'countdown') {
      cdText = d.bossCountdown > 0 ? String(d.bossCountdown) : 'GO!';
      cdGo = d.bossCountdown <= 0;
    }
  } else if (d.phase === 'countdown') {
    cdText = d.countdown > 0 ? String(d.countdown) : 'GO!';
    cdGo = d.countdown <= 0;
  }
  if (cdText) {
    cd.classList.remove('hidden');
    cd.textContent = cdText;
    cd.style.fontSize = cdGo ? '110px' : '130px';
    cd.style.color = cdGo ? '#7dff8a' : '#4fd0ff';
  } else {
    cd.classList.add('hidden');
  }

  $('wrong-way').classList.toggle('hidden', !d.wrongWay);

  // ---------- 道具模式 HUD（3 格：Q/W/E；天梯第 3 层是 1/2/3） ----------
  const slotsBar = $('item-slots');
  const isTowerRush = isTower && !!d.towerRush;
  if (d.mode === 'item' || d.mode === 'boss' || isArena || isTowerRush) {
    slotsBar.classList.remove('hidden');
    ensureItemTip();
    const slotEls = slotsBar.querySelectorAll('.item-slot');
    const items = d.items || [null, null, null];
    // 天梯里 W 是油门，进 itemMode 会把油门吞掉 —— 第 3 层改用主键盘 1/2/3
    const keys = isTowerRush ? ['1', '2', '3'] : (isBoss || isArena) ? ['Q', 'E', '1'] : ['Q', 'W', 'E'];
    slotEls.forEach((el, i) => {
      const it = items[i];
      const icon = el.querySelector('.item-icon');
      const name = el.querySelector('.item-name');
      const keyEl = el.querySelector('.item-key');
      if (keyEl) keyEl.textContent = keys[i];
      if (it) {
        el.classList.remove('empty');
        const art = ART_ON ? ITEM_ART[it.name] : null;
        if (art) {
          // 图片版：1024 源图在 CSS 里缩到 ~50px，浏览器降采样后边缘干净
          icon.classList.add('has-art');
          icon.innerHTML = `<img src="${art}" alt="" draggable="false">`;
        } else {
          icon.classList.remove('has-art');
          icon.textContent = it.icon;
        }
        name.textContent = it.name;
        // 悬停说明用 dataset 存，鼠标进来时由 ensureItemTip 的委托读取
        el.dataset.tipName = it.name;
        el.dataset.tipDesc = it.desc || '暂无说明';
        el.dataset.tipKey = keys[i];
      } else {
        el.classList.add('empty');
        icon.classList.remove('has-art');
        // 空槽图标：以前是细体「?」，现在换成低调的凹槽 PNG（112_ui_empty_slot）
        if (!(ART_ON && setIcon(icon, 'uiEmptySlot'))) icon.textContent = '?';
        name.textContent = '空';
        el.dataset.tipName = '空槽';
        el.dataset.tipDesc = isTowerRush ? '撞碎平台上的道具箱即可获得道具' : '撞碎赛道上的道具箱即可获得道具';
        el.dataset.tipKey = keys[i];
      }
      el.removeAttribute('title');
    });
    // 护盾倒计时条
    const sb = $('item-shield-bar');
    if (d.shield > 0) {
      sb.classList.remove('hidden');
      const max = d.mode === 'boss' ? 4 : 10;
      sb.querySelector('i').style.width = Math.min(100, d.shield / max * 100).toFixed(0) + '%';
    } else {
      sb.classList.add('hidden');
    }
    // 墨汁遮挡（透明度随剩余时间）：上限 0.6，封顶后仍是深色墨雾而不是全黑，
    // 且随剩余时间递减——用 5 秒时长做满屏黑会直接看不清赛道
    $('ink-overlay').style.opacity = d.mode === 'boss'
      ? 0
      : (d.ink > 0 ? Math.min(0.6, 0.12 + d.ink * 0.10).toFixed(2) : 0);
  } else {
    slotsBar.classList.add('hidden');
    $('ink-overlay').style.opacity = 0;
    // 槽整块收起时 pointerleave 不一定触发，这里主动收掉悬停说明
    itemTipHide();
  }

  // ---------- 竞技场：潮汐核心 + 固定技能 ----------
  renderArenaExtras(d, isArena);
  // ---------- 云端天梯：层/分/货 + 冲刺能量 ----------
  renderTowerExtras(d, isTower);

  // ---------- 怪物模式 HUD ----------
  const bossHud = $('boss-hud');
  const playerHud = $('player-hud');
  if (bossHud && playerHud) {
    if (isBoss && d.boss) {
      bossHud.classList.remove('hidden');
      playerHud.classList.remove('hidden');
      $('skill-track')?.classList.remove('hidden');
      $('combo-bar')?.classList.remove('hidden');
      if (!setIcon($('boss-icon'), BOSS_ICON[d.boss.id])) $('boss-icon').textContent = d.boss.icon;
      $('boss-name').textContent = d.boss.name;
      $('boss-hp-fill').style.width = (Math.max(0, Math.min(1, d.boss.hp)) * 100).toFixed(1) + '%';
      // P1 / P2 标记：1/3 血是解禁走位的阈值（血条上有对应刻度线）；
      // 破韧期间临时切成金色“破韧倒计时”，提示玩家这是输出窗口
      const phaseEl = $('boss-phase');
      const staggerBar = $('boss-stagger');
      const staggerFill = $('boss-stagger-fill');
      const breakTip = $('boss-break-tip');
      if (phaseEl) {
        if (d.boss.staggered) {
          // 💫 换成「虚弱」状态图标（67_st_weak.png），数字仍单独包一层由 CSS 上色
          const weakIco = iconImg(STATUS_ICON.vulnerable, 'bp-ico');
          phaseEl.innerHTML = `${weakIco}破韧 ${Math.max(0, d.boss.staggerLeft || 0).toFixed(1)}s`;
          phaseEl.classList.remove('rage');
          phaseEl.classList.add('break');
        } else {
          const p1 = (d.boss.hp ?? 0) > 1 / 3;
          phaseEl.textContent = p1 ? 'P1 固定战场' : 'P2 狂怒';
          phaseEl.classList.toggle('rage', !p1);
          phaseEl.classList.remove('break');
        }
      }
      // 破韧槽：只有前三关显示，第四关（无 staggerMax）自动隐藏
      if (staggerBar && staggerFill) {
        staggerBar.classList.toggle('hidden', !d.boss.staggerEnabled);
        if (d.boss.staggerEnabled) {
          // 破韧中把槽画满并高亮，避免“刚满槽却瞬间归零”看起来像没生效
          const v = d.boss.staggered ? 1 : Math.max(0, Math.min(1, d.boss.stagger || 0));
          staggerFill.style.width = (v * 100).toFixed(1) + '%';
          staggerBar.classList.toggle('full', !!d.boss.staggered);
        }
      }
      const weakTip = $('boss-tip-weak');
      if (weakTip) {
        weakTip.textContent = d.boss.staggerEnabled ? '· 打侧后弱点攒破韧' : '· 打侧后弱点更痛';
      }
      if (breakTip) {
        breakTip.classList.toggle('hidden', !d.boss.staggered);
        if (d.boss.staggered) {
          const left = $('boss-break-left');
          if (left) left.textContent = Math.max(0, d.boss.staggerLeft || 0).toFixed(1);
        }
      }
      // BOSS 状态条：只显示当前生效的 debuff，字体保持小号，避免遮挡画面
      const debuffEl = $('boss-debuffs');
      if (debuffEl) {
        const list = d.boss.debuffs || [];
        debuffEl.classList.toggle('hidden', list.length === 0);
        debuffEl.replaceChildren(...list.map((x) => {
          const chip = document.createElement('span');
          chip.className = 'boss-debuff';
          chip.innerHTML = `${iconImg(STATUS_ICON[x.key], 'bd-ico') || x.icon} ${x.label} <b>${x.left}s</b>`;
          return chip;
        }));
      }
      // 底部技能轨道：J 主炮 / Ctrl 氮气；左下角长条：F 协同合击
      renderSkillTrack(d);
      renderComboBar(d);
      // 玩家列表：本人头像大字条 + 队友缩略小条
      const list = $('player-list');
      if (list && Array.isArray(d.party) && d.party.length) {
        const ratio = (p) => Math.max(0, Math.min(1, p.hp / (p.maxHp || 100)));
        const tagText = (p) => (p.alive
          ? `复活 ×${p.revives}`
          : (p.revives > 0 ? '待救援' : '出局'));
        const avatar = (p) => `<span class="pl-avatar">${avatarMarkup(p.avatar, p.ai, p.id)}</span>`;
        const aiTag = (p) => (p.ai ? '<span class="pl-tag ai">AI</span>' : '');
        const readyTag = (p) => (p.ready ? '<span class="pl-tag ok">✓ 已准备</span>' : '');
        const self = d.party.find((p) => p.me) || d.party[0];
        const mates = d.party.filter((p) => p !== self);
        const selfR = ratio(self);
        const selfCls = ['pl-self'];
        if (!self.alive) selfCls.push('down');
        if (self.ready) selfCls.push('ready');
        let html = `<div class="${selfCls.join(' ')}">`
          + avatar(self)
          + '<div class="pl-self-body">'
          + `<div class="pl-self-top"><span class="pl-name">${self.name}</span>`
          + `${aiTag(self)}${readyTag(self)}</div>`
          + '<div class="pl-self-bottom">'
          + `<span class="pl-hp"><i class="${selfR <= 0.35 ? 'low' : ''}" `
          + `style="width:${(selfR * 100).toFixed(0)}%"></i></span>`
          + `<span class="pl-revive">${tagText(self)}</span>`
          + '</div></div></div>';
        if (mates.length) {
          html += '<div class="pl-mates">' + mates.map((p) => {
            const r = ratio(p);
            const cls = ['pl-row'];
            if (!p.alive) cls.push('down');
            if (p.ready) cls.push('ready');
            return `<div class="${cls.join(' ')}">`
              + avatar(p)
              + `<span class="pl-name">${p.name}</span>`
              + `<span class="pl-hp"><i class="${r <= 0.35 ? 'low' : ''}" `
              + `style="width:${(r * 100).toFixed(0)}%"></i></span>`
              + `<span class="pl-tag">${tagText(p)}</span>`
              + '</div>';
          }).join('') + '</div>';
        }
        // 头像里可能有玩家上传的 dataURL，整段重绘太贵：只在内容真的变了才写 DOM
        const sig = d.party.map((p) => [
          p.id, p.name, p.avatar ? `${p.avatar.length}:${p.avatar.slice(-12)}` : '',
          p.alive ? 1 : 0, p.revives, p.ready ? 1 : 0, Math.round(ratio(p) * 50),
        ].join(':')).join('|');
        if (list.dataset.sig !== sig) {
          list.dataset.sig = sig;
          list.innerHTML = html;
        }
      }
      $('respawn-tip').classList.toggle('hidden', !(d.respawnLeft > 0 && d.revives > 0));
    } else {
      bossHud.classList.add('hidden');
      playerHud.classList.add('hidden');
      $('skill-track')?.classList.add('hidden');
      $('combo-bar')?.classList.add('hidden');
      $('boss-stagger')?.classList.add('hidden');
      $('boss-break-tip')?.classList.add('hidden');
      $('death-panel')?.classList.add('hidden');
    }
    renderHexStrip(isBoss ? d : null);
  }

  // ---------- 低血红闪 / 受击反馈 ----------
  // 生命 <35%（与队伍血条变红的阈值一致）：窗口四边常驻红光，越接近死亡越深；
  // 每次受击再叠一层短促强闪。低血区一进入就给足基础亮度，
  // 不再随血量线性衰减到 0——否则刚掉到 34% 时算出来只有 0.01，等于没开。
  const hurtEl = $('hurt-overlay');
  if (hurtEl) {
    const maxHp = d.playerMaxHp || 0;
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, (d.playerHp || 0) / maxHp)) : 1;
    // 与队伍血条变红的阈值完全一致（<= 35%），且进区就给足 0.4 起步亮度，
    // 这样"血条红了但屏幕没反应"不会再出现。
    const lowK = isBoss && ratio <= 0.35 ? Math.min(1, (0.35 - ratio) / 0.35) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 240);
    const hurt = Math.max(0, Math.min(1, d.hurtFlash || 0));
    const low = lowK > 0 ? (0.40 + 0.22 * pulse + 0.18 * lowK) : 0;
    const alpha = Math.min(1, low + hurt * 0.85);
    hurtEl.style.opacity = alpha > 0.01 ? alpha.toFixed(2) : 0;
  }

  // ---------- 阵亡面板 ----------
  // 怪物模式：被谁打死 / 本关承伤 / 承伤排名
  // 竞技场：被谁击沉 / 剩几条命 / 几秒后重返战场（1v1 没有队友，文案另写一套）
  const deathEl = $('death-panel');
  if (deathEl) {
    const arenaDeath = isArena ? (d.arenaDeath || null) : null;
    const showDeath = isArena
      ? !!arenaDeath
      : (isBoss && d.playerAlive === false && !!d.deathHit);
    deathEl.classList.toggle('hidden', !showDeath);
    if (showDeath) renderDeathPanel(d, arenaDeath);
  }

  // 闪电屏幕闪光
  $('flash-overlay').style.opacity = d.flash > 0 ? Math.min(0.8, d.flash).toFixed(2) : 0;

  // 幽灵差值 / 每圈评价 / 失败归因（BOSS、竞技场没有圈速与赛道，整块收掉）
  renderAssist(d, isBoss || isArena);
}

/**
 * 幽灵车 + 中央提示条。
 *
 * 2026-11-18 重做：撞墙归因、完美起步等系统提示、每圈评价**全部并进同一条**
 * （#assist-chip）——以前归因是 56px 大 emoji + 两字，圈评是 30px 两行大字，
 * 现在统一成参考图那种斜切发光条，只换左边条与发光色区分类别。
 * 抢占与排队在 Game.#notice 里做（归因 > 系统提示 > 圈评），这里只负责画。
 * 淡出不用 CSS 动画：ttl 每帧递减，opacity = ttl / 淡出窗口 ——
 * 这样重播同一句话不会被 animation 的 restart 规则吞掉（连撞两次只会闪一次）。
 */
function renderAssist(d, hideAll) {
  const strip = $('ghost-strip');
  const assist = $('hud-assist');
  const chip = $('assist-chip');
  if (!strip || !assist || !chip) return;
  if (hideAll) {
    strip.classList.add('hidden');
    assist.classList.add('hidden');
    return;
  }
  assist.classList.remove('hidden');

  // ---- 幽灵差值（右下速度表上方）----
  const g = d.ghost;
  if (g && g.visible && g.delta != null) {
    strip.classList.remove('hidden');
    // 0.1 秒死区：并排时差值在 0 附近抖，不该整块闪成橙色
    strip.classList.toggle('bad', g.delta > 0.1);
    const abs = Math.abs(g.delta);
    $('ghost-delta').textContent = `${g.delta > 0 ? '+' : '−'}${abs.toFixed(2)}`;
    $('ghost-best').textContent = g.bestLap != null ? `最佳 ${fmtTime(g.bestLap)}` : '';
    strip.classList.toggle('fresh', !!g.fresh);
  } else {
    strip.classList.add('hidden');
  }

  // ---- 中央提示条：归因 / 系统提示 / 圈评共用同一个槽 ----
  const n = d.notice;
  if (n && n.ttl > 0 && n.main) {
    chip.dataset.tone = n.tone || 'blue';
    chip.style.opacity = String(Math.min(1, n.ttl / 0.22));
    const main = $('ac-main');
    if (main.textContent !== n.main) main.textContent = n.main;
    // 加粗层：同一串字再画一遍（系统字体没有 Black 级中文），详见 index.html 的 .ac-fat
    const fat = $('ac-fat');
    if (fat && fat.textContent !== n.main) fat.textContent = n.main;
    const sub = $('ac-sub');
    const subText = n.sub || '';
    if (sub.textContent !== subText) sub.textContent = subText;
    sub.style.display = subText ? '' : 'none';
  } else {
    chip.style.opacity = '0';
  }
}

/** 阵亡面板：回答“我怎么死的” */
function renderDeathPanel(d, arenaDeath = null) {
  // ---- 竞技场：1v1 没有救援/队友，只回答三件事：谁打的、还剩几条命、什么时候能回去 ----
  if (arenaDeath) {
    const left = Math.ceil(arenaDeath.respawnLeft || 0);
    const ringOut = !!arenaDeath.ringOut;
    // 标题图标：出局/沉船 = 骷髅，被撞出擂台 = 沉水（🌊 → 73_st_sink PNG）
    const deadIco = iconImg('uiDead', 'dt-ico');
    const sinkIco = iconImg('stSink', 'dt-ico');
    const title = arenaDeath.out
      ? `${deadIco}出局 · 对手拿下本关`
      : ringOut ? `${sinkIco}被撞出擂台 · ${left}s 后回场`
        : (left > 0
          ? `${deadIco}船沉了 · ${left}s 后重返战场`
          : `${deadIco}船沉了 · 马上重返战场`);
    $('death-title').innerHTML = title;
    $('death-hit').innerHTML = ringOut
      ? `被 <b>${escHtml(arenaDeath.source)}</b> 顶出了擂台边界`
      : `被 <b>${escHtml(arenaDeath.source)}</b> 击沉`
        + (arenaDeath.dmg ? `，这一下 <b>${Math.round(arenaDeath.dmg)}</b> 伤害` : '');
    const lifeText = arenaDeath.livesEnabled
      ? `剩余生命 <b>${arenaDeath.lives}/${arenaDeath.maxLives}</b>`
      : '本关不计命 · 只比目标';
    $('death-meta').innerHTML = `${lifeText}`
      + ` · 大比分 <b>${d.arenaScoreMe || 0} : ${d.arenaScoreFoe || 0}</b>`
      + (arenaDeath.out ? '' : ' · 复活后 1.2s 无敌');
    $('death-by').innerHTML = '';
    return;
  }
  const hit = d.deathHit || {};
  const revives = d.revives || 0;
  const left = d.respawnLeft > 0 ? Math.ceil(d.respawnLeft) : 0;
  const deadIco0 = iconImg('uiDead', 'dt-ico');
  $('death-title').innerHTML = revives > 0
    ? `${deadIco0}船沉了 · ${left > 0 ? `${left}s 后自动复活` : '等待救援'}`
    : `${deadIco0}出局 · 等待队友通关`;
  $('death-hit').innerHTML = `最后一击来自 <b>${escHtml(hit.source || '未知来源')}</b>`
    + `，造成 <b>${Math.round(hit.dmg || 0)}</b> 伤害`;
  $('death-meta').innerHTML = `本关累计承伤 <b>${Math.round(d.takenMine || 0)}</b>`
    + ` · 队伍承伤排名 <b>${d.takenRank || 1}/${d.takenRankTotal || 1}</b>`;
  const by = (d.takenBy || []).slice(0, 4);
  $('death-by').innerHTML = by.length
    // 伤害来源形如「🔥 喷火吐息」，开头的元素 emoji 换成技能图标
    ? '<table><thead><tr><th>伤害来源</th><th class="num">承伤</th></tr></thead><tbody>'
      + by.map((r) => `<tr><td>${iconizePrefix(r.source, 'dt-src-ico').html}</td>`
        + `<td class="num">${Math.round(r.dmg)}</td></tr>`).join('')
      + '</tbody></table>'
    : '';
}

// ---------- 怪物模式：过场 / 关卡结算 / 终局 ----------
// 文字里不再带 emoji，天气图标走 WEATHER_ICON（见 showBossCutscene）
const WEATHER_LABEL = {
  day: '晴朗', dusk: '黄昏', blizzard: '暴风雪', storm: '暴风雨',
};

export function showBossCutscene(data) {
  const el = $('boss-cutscene');
  if (!el) return;
  if (!data) {
    el.classList.add('hidden');
    return;
  }
  const layer = !!data.layer;
  $('cs-stage').textContent = layer ? `第 ${data.stage} 层` : `第 ${data.stage} 关 / ${data.total}`;
  // 大标题：BOSS 图标（1024 透明 PNG）+ 名字，图标缺失时才退回 emoji 文本
  const bossIco = iconImg(BOSS_ICON[data.boss.id], 'cs-boss-ico')
    || (/^hex\//.test(String(data.boss.icon || '')) ? hexIco(data.boss.icon, 'cs-boss-ico') : '');
  $('cs-name').innerHTML = bossIco
    ? `${bossIco}<span>${escHtml(data.boss.name)}</span>`
    : `${escHtml(data.boss.icon || '')} ${escHtml(data.boss.name)}`;
  // 场地 + 天气。
  // 两种模式都下发结构化 chips：海克斯是 `hex/xxx.png`，经典模式第 5 关是
  // `/icons/weather/106_*.png`，前 4 关仍是 emoji —— chipIco 三种都认。
  const wx = data.hexWeather || data.themeWeather;
  if (wx) {
    $('cs-weather').innerHTML = [wx.theme, wx.weather]
      .filter((x) => x && (x.name || x.icon))
      .map((x) => `${chipIco(x.icon, 'cs-w-ico')} ${escHtml(x.name || '')}`)
      .join(' · ').trim();
  } else if (data.weatherLabel) {
    // 兜底：没有 chips 就退回纯文本
    $('cs-weather').textContent = data.weatherLabel;
  } else {
    const wSrc = iconSrc(WEATHER_ICON[data.level?.weather]);
    $('cs-weather').innerHTML = (wSrc
      ? `<img class="cs-w-ico" src="${wSrc}" alt="" draggable="false">` : '')
      + escHtml(WEATHER_LABEL[data.level?.weather] || '');
  }
  $('cs-intro').textContent = data.boss.intro || '';

  // 海克斯：过场卡追加「核心 / 主副规则 / 精英 / 变体 / 场地 / 遗物 / 时间锚 / 危险物 / 连招 / 赛艇 / 评级 / seed」
  const hexEl = $('cs-hex');
  if (hexEl) {
    const h = data.hex;
    if (!h) {
      hexEl.style.display = 'none';
      hexEl.innerHTML = '';
    } else {
      const core = HEX_CORES.find((c) => c.id === h.coreId);
      const rules = (h.entry?.rules || []).map((id) => HEX_RULES.find((r) => r.id === id)).filter(Boolean);
      const hazards = (h.entry?.hazards || []).map((x) => HEX_HAZARDS.find((d) => d.id === x.id)).filter(Boolean);
      const combos = (h.entry?.combos || []).map((c) => c.label).filter(Boolean);
      // 本局随机赛艇：只列真人玩家，AI 陪练不占过场卡篇幅
      const boats = (h.boats || []).map((b) => {
        const def = BOATS.find((x) => x.id === b.boatId);
        return def ? `${b.me ? '我' : (b.name || '玩家')}：${def.name}` : '';
      }).filter(Boolean);
      hexEl.style.display = 'block';
      hexEl.innerHTML = `
        <div class="cs-hex-row"><span class="cs-hex-k">核心</span><span>${core ? `${hexIco(core.icon)}${escHtml(core.name)}` : '待房主选择'}</span></div>
        ${rules.map((r, i) => `<div class="cs-hex-row"><span class="cs-hex-k">${i === 0 ? '主规则' : '副规则'}</span><span class="${r.negative ? 'neg' : ''}">${hexIco(r.icon)}${escHtml(r.name)} · ${escHtml(r.desc)}</span></div>`).join('')}
        ${h.prefix ? `<div class="cs-hex-row"><span class="cs-hex-k">精英</span><span class="neg">${hexIco(h.prefix.icon)}${escHtml(h.prefix.name)} · ${escHtml(h.prefix.desc || '')}</span></div>` : ''}
        ${h.variant ? `<div class="cs-hex-row"><span class="cs-hex-k">变体</span><span class="neg">${hexIco(h.variant.icon)}${escHtml(h.variant.name)} · ${escHtml(h.variant.desc || '')}</span></div>` : ''}
        ${h.arena ? `<div class="cs-hex-row"><span class="cs-hex-k">场地</span><span class="hx-arena">${hexIco(h.arena.icon)}${escHtml(h.arena.name)} · ${escHtml(h.arena.desc || '')}</span></div>` : ''}
        ${h.formation ? `<div class="cs-hex-row"><span class="cs-hex-k">阵型</span><span class="hx-arena">${escHtml(h.formation.name)} · ${escHtml(h.formation.desc || '')}</span></div>` : ''}
        ${(h.relics || []).length ? `<div class="cs-hex-row"><span class="cs-hex-k">遗物</span><span class="hx-relic">${h.relics.map((r) => `${hexIco(r.icon)}${escHtml(r.name)}`).join(' · ')}</span></div>` : ''}
        <div class="cs-hex-row"><span class="cs-hex-k">时间锚</span><span>${h.anchors ? `${hexIco('hex/anchor.png')}${h.anchors} 次免死` : '无'}</span></div>
        <div class="cs-hex-row"><span class="cs-hex-k">危险物</span><span>${hazards.map((x) => `${hexIco(x.icon)}${escHtml(x.name)}`).join(' · ') || '无'}</span></div>
        ${combos.length ? `<div class="cs-hex-row"><span class="cs-hex-k">连招</span><span>${combos.map((s) => escHtml(s)).join(' · ')}</span></div>` : ''}
        ${boats.length ? `<div class="cs-hex-row"><span class="cs-hex-k">赛艇</span><span>${boats.map((s) => escHtml(s)).join(' · ')}</span></div>` : ''}
        <div class="cs-hex-row"><span class="cs-hex-k">危险评级</span><span class="cs-stars">${hexIco('hex/starRating.png').repeat(h.entry?.danger || 0)}</span></div>
        <div class="cs-hex-row"><span class="cs-hex-k">seed</span><span>${(h.seed >>> 0).toString(16).toUpperCase()}</span></div>`;
    }
  }

  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

/** 排名表：固定列宽（名次/玩家/数值/占比），名字省略而不是挤掉数字
 *  neon=true：阶段结算落日霓虹板的宽玩家列；false：终局战报保持原列宽 */
function rankTableHtml(rows, valueKey, label, neon = false) {
  const list = (rows || [])
    .filter((r) => r && r.name)
    .slice()
    .sort((a, b) => (b[valueKey] || 0) - (a[valueKey] || 0));
  if (!list.length) return '<div class="br-empty">暂无数据</div>';
  const total = list.reduce((sum, r) => sum + (r[valueKey] || 0), 0) || 1;
  const cols = neon
    ? '<colgroup><col style="width:8%"><col style="width:40%"><col style="width:27%"><col style="width:25%"></colgroup>'
    : '<colgroup><col style="width:9%"><col><col style="width:24%"><col style="width:18%"></colgroup>';
  return '<table>' + cols
    + '<thead><tr><th>#</th><th>玩家</th>'
    + `<th class="num">${label}</th><th class="num">占比</th></tr></thead><tbody>`
    + list.map((r, i) => {
      const v = Math.round(r[valueKey] || 0);
      const pct = Math.round((r[valueKey] || 0) / total * 100);
      return `<tr class="${r.me ? 'me' : ''}"><td class="rank">${i + 1}</td>`
        + `<td>${escHtml(r.name)}</td><td class="num">${v}</td>`
        + `<td class="num">${pct}%</td></tr>`;
    }).join('')
    + '</tbody></table>';
}

/** 双榜（左输出 / 右承伤）：终局与阶段结算共用 */
function bossTablesHtml(data, neon = false) {
  return `<div class="be-table"><h4>输出排名</h4>${rankTableHtml(data.damage, 'dmg', '伤害', neon)}</div>`
    + `<div class="be-table"><h4>承伤排名</h4>${rankTableHtml(data.taken, 'taken', '承伤', neon)}</div>`;
}

/** 伤害来源竖列（终局左栏）：每条一行，数值右对齐不压名字 */
function bossSourceHtml(data) {
  const src = (data.takenBy || []).slice(0, 5);
  if (!src.length) return '<h4>伤害来源</h4><div class="br-empty">暂无记录</div>';
  return '<h4>伤害来源</h4>'
    // 来源前缀（🔥/🩸/✦）统一换成 PNG，和阵亡页保持同一套图标
    + src.map((r) => `<div><span>${iconizePrefix(r.source, 'be-src-ico').html}</span><b>${Math.round(r.dmg)}</b></div>`).join('');
}

/** 阶段结算底部来源行：只展示真实记录，不补行不补数字 */
function bossSourceLine(data) {
  const src = (data.takenBy || []).slice(0, 4);
  if (!src.length) return '';
  return '<span class="sn-src-label">全队挨打来源：</span>'
    + src.map((r) => `<span>${iconizePrefix(r.source, 'sn-src-ico').html} ${Math.round(r.dmg)}</span>`).join(' · ');
}

export function showBossStageResult(data) {
  const el = $('boss-result');
  if (!el) return;
  if (!data) {
    el.classList.add('hidden');
    return;
  }
  const totalDmg = (data.damage || []).reduce((sum, d) => sum + (d.dmg || 0), 0);
  const totalTaken = (data.taken || []).reduce((sum, d) => sum + (d.taken || 0), 0);
  $('br-head').textContent = `第 ${data.stage} ${data.layer ? '层' : '关'} · ${data.layer ? '本层完成' : '关卡完成'}`;
  $('br-grade').textContent = data.grade || '';
  $('br-stats').textContent = `用时 ${fmtTime(data.elapsed)}`
    + ` · 阶段总伤害 ${Math.round(totalDmg)} · 阶段总承伤 ${Math.round(totalTaken)}`;
  $('br-tables').innerHTML = `<div class="be-tables">${bossTablesHtml(data, true)}</div>`;
  $('br-src').innerHTML = bossSourceLine(data);
  el.classList.remove('hidden');
}

/** 卡牌列表文本：同名卡合并显示 ×N（无尽模式同名最多叠 3 张） */
function hexCardText(cards) {
  const seen = new Map();
  for (const c of cards || []) {
    const e = seen.get(c.id) || { c, n: 0 };
    e.n += 1;
    seen.set(c.id, e);
  }
  return [...seen.values()]
    .map(({ c, n }) => `${hexIco(c.icon || 'hex/cardBack.png')}${escHtml(c.name)}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ');
}

/** 海克斯本局回顾：核心 / 卡牌 / 每关规则与危险物（只展示，不参与结算数值） */
function hexReviewHtml(hex) {
  if (!hex) return '';
  const boat = BOATS.find((b) => b.id === hex.boatId);
  const cards = hex.cards || [];
  const rows = [];
  rows.push(`<div><span class="hx-k">本局核心</span>${hex.core ? `${hexIco(hex.core.icon)} ${escHtml(hex.core.name)}` : '未选择'}${
    boat ? ` · <span class="hx-k">赛艇</span>${escHtml(boat.name)}` : ''}</div>`);
  rows.push(`<div><span class="hx-k">拿到卡牌</span>${cards.length
    ? hexCardText(cards)
    : '无'}</div>`);
  if (hex.relics?.length) {
    rows.push(`<div><span class="hx-k">深渊遗物</span>${
      hex.relics.map((r) => `${hexIco(r.icon)} ${escHtml(r.name)}`).join(' · ')
    }</div>`);
  }
  for (const s of hex.stages || []) {
    const rules = (s.rules || [])
      .map((r) => `<span class="${r.negative ? 'neg' : ''}">${hexIco(r.icon)} ${escHtml(r.name)}</span>`)
      .join(' · ') || '无';
    const hazards = (s.hazards || []).map((h) => `${hexIco(h.icon)} ${escHtml(h.name)}`).join(' · ') || '无';
    const prefix = s.prefix ? ` · <span class="neg">${hexIco(s.prefix.icon)} ${escHtml(s.prefix.name)}</span>` : '';
    const arena = s.arena ? ` · <span class="hx-arena">${hexIco(s.arena.icon)} ${escHtml(s.arena.name)}</span>` : '';
    const relic = s.relic ? ` · <span class="hx-relic">${hexIco(s.relic.icon)} ${escHtml(s.relic.name)}</span>` : '';
    rows.push(`<div><span class="hx-k">第 ${s.stage} 层 ${escHtml(s.bossName)}</span>${prefix}${arena}${relic}规则 ${rules} · 危险物 ${hazards}</div>`);
  }
  rows.push(`<div><span class="hx-k">seed</span>${(hex.seed >>> 0).toString(16).toUpperCase()}</div>`);
  return `<h4>海克斯本局回顾</h4>${rows.join('')}`;
}

// ---------- 海克斯：常驻词缀条 + 构筑面板 ----------
// HUD 每帧都会调 renderHexStrip，只有内容变化时才重写 DOM（用 sig 挡掉重复渲染）。
let hexStripSig = '';
let hexPanelSig = '';
let hexBuildOpen = false;
let hexBuildBound = false;
let hexEndlessSig = '';

function hexBuildBody(hex) {
  const rows = [];
  const core = hex.core ? `${hexIco(hex.core.icon)} ${escHtml(hex.core.name)} · ${escHtml(hex.core.desc || '')}` : '未选择';
  rows.push(`<div><span class="hb-k">本局核心</span>${core}</div>`);
  const rules = (hex.rules || []).map(
    (r) => `<span class="hb-rule${r.negative ? ' neg' : ''}">${hexIco(r.icon)} ${escHtml(r.name)}（${escHtml(r.desc || '')}）</span>`,
  ).join(' · ') || '无';
  rows.push(`<div><span class="hb-k">本层词缀</span>${rules}</div>`);
  const hazards = (hex.hazards || []).map(
    (h) => `<span class="hb-hz">${hexIco(h.icon)} ${escHtml(h.name)}</span>`,
  ).join(' · ') || '无';
  rows.push(`<div><span class="hb-k">危险物</span>${hazards}</div>`);
  if (hex.weather) {
    rows.push(`<div><span class="hb-k">天气</span><span class="hb-hz">${hexIco(hex.weather.icon)} ${escHtml(hex.weather.name)}</span> · ${escHtml(hex.weather.desc || '')}</div>`);
  }
  if (hex.prefix) {
    rows.push(`<div><span class="hb-k">精英</span><span class="hb-hz">${hexIco(hex.prefix.icon)} ${escHtml(hex.prefix.name)}</span> · ${escHtml(hex.prefix.desc || '')}</div>`);
  }
  if (hex.variant) {
    rows.push(`<div><span class="hb-k">深渊变体</span><span class="hb-rule neg">${hexIco(hex.variant.icon)} ${escHtml(hex.variant.name)}</span> · ${escHtml(hex.variant.desc || '')}</div>`);
  }
  if (hex.arena) {
    rows.push(`<div><span class="hb-k">场地</span><span class="hb-hz">${hexIco(hex.arena.icon)} ${escHtml(hex.arena.name)}</span> · ${escHtml(hex.arena.desc || '')}</div>`);
  }
  if (hex.relics?.length) {
    const relics = hex.relics.map(
      (r) => `<span class="hb-hz" data-tip="${escHtml(r.desc || '')}">${hexIco(r.icon)} ${escHtml(r.name)}</span>`,
    ).join(' · ');
    rows.push(`<div><span class="hb-k">深渊遗物（${hex.relics.length}）</span>${relics}</div>`);
  }
  if (hex.anchors) {
    rows.push(`<div><span class="hb-k">时间锚</span><span class="hb-hz">${hexIco('hex/anchor.png')}${hex.anchors} 次免死</span></div>`);
  }
  const cards = hexCardText(hex.cards) || '暂无';
  rows.push(`<div><span class="hb-k">已选卡牌（${(hex.cards || []).length}）</span>${cards}</div>`);
  rows.push(`<div><span class="hb-k">seed</span>${(hex.seed >>> 0).toString(16).toUpperCase()}</div>`);
  return rows.join('');
}

/** 战斗 HUD 常驻：核心 + 本层词缀 + 构筑按钮；classic / 非战斗时整条隐藏 */
function renderHexStrip(d) {
  const strip = $('hex-strip');
  if (!strip) return;
  const panel = $('hex-build-panel');
  const hex = d?.hex;
  if (!hex) {
    strip.classList.add('hidden');
    if (panel) panel.classList.add('hidden');
    hexBuildOpen = false;
    hexStripSig = '';
    hexPanelSig = '';
    return;
  }
  // 阶段切回 intro（上一局残留）时收起面板
  if (d.bossPhase === 'intro' && hexBuildOpen) hexBuildOpen = false;
  if (!hexBuildBound) {
    hexBuildBound = true;
    const buildBtn = $('hex-strip-build');
    const closeBtn = $('hex-build-close');
    if (buildBtn) {
      buildBtn.onclick = () => {
        hexBuildOpen = !hexBuildOpen;
        panel?.classList.toggle('hidden', !hexBuildOpen);
      };
    }
    if (closeBtn) {
      closeBtn.onclick = () => {
        hexBuildOpen = false;
        panel?.classList.add('hidden');
      };
    }
  }
  const rules = hex.rules || [];
  const sig = `${hex.stage}|${hex.core?.id}|${hex.cards?.length}|${hex.prefix?.name || ''}`
    + `|${rules.map((r) => r.id).join(',')}`
    + `|${hex.hazards?.map((h) => h.id).join(',')}`
    + `|${hex.variant?.name || ''}|${hex.arena?.name || ''}`
    + `|${(hex.relics || []).length}|${hex.anchors || 0}`;
  if (sig !== hexStripSig) {
    hexStripSig = sig;
    const coreEl = $('hex-strip-core');
    if (coreEl) coreEl.innerHTML = hex.core ? `${hexIco(hex.core.icon)}${escHtml(hex.core.name)}` : '';
    const rulesEl = $('hex-strip-rules');
    if (rulesEl) {
      const chips = [];
      // 精英前缀优先展示（红底），再跟本层词缀
      if (hex.prefix) {
        const pc = document.createElement('span');
        pc.className = 'hs-rule neg hs-prefix';
        pc.innerHTML = `${hexIco(hex.prefix.icon)}${escHtml(hex.prefix.name)}`;
        chips.push(pc);
      }
      // P4：深渊变体（红底）/ 场地（青底）/ 遗物与时间锚（暗金）
      if (hex.variant) {
        const vc = document.createElement('span');
        vc.className = 'hs-rule neg hs-variant';
        vc.innerHTML = `${hexIco(hex.variant.icon)}${escHtml(hex.variant.name)}`;
        chips.push(vc);
      }
      if (hex.arena) {
        const ac = document.createElement('span');
        ac.className = 'hs-rule hs-arena';
        ac.innerHTML = `${hexIco(hex.arena.icon)}${escHtml(hex.arena.name)}`;
        chips.push(ac);
      }
      if (hex.relics?.length) {
        const rc = document.createElement('span');
        rc.className = 'hs-rule hs-relic';
        rc.innerHTML = `${hexIco('hex/relicCount.png')}${hex.relics.length}`;
        chips.push(rc);
      }
      if (hex.anchors) {
        const ac = document.createElement('span');
        ac.className = 'hs-rule hs-anchor';
        ac.innerHTML = `${hexIco('hex/anchor.png')}${hex.anchors}`;
        chips.push(ac);
      }
      chips.push(...rules.map((r) => {
        const chip = document.createElement('span');
        chip.className = `hs-rule${r.negative ? ' neg' : ''}`;
        chip.innerHTML = `${hexIco(r.icon)}${escHtml(r.name)}`;
        return chip;
      }));
      rulesEl.replaceChildren(...chips);
    }
    const countEl = $('hex-strip-count');
    if (countEl) countEl.textContent = String((hex.cards || []).length);
  }
  // 构筑面板只在打开时渲染，且内容不变就不重写（避免每帧重建 DOM）
  const panelSig = hexBuildOpen ? sig : '';
  if (panelSig !== hexPanelSig) {
    hexPanelSig = panelSig;
    if (panel && hexBuildOpen) $('hex-build-body').innerHTML = hexBuildBody(hex);
  }
  strip.classList.remove('hidden');
  panel?.classList.toggle('hidden', !hexBuildOpen);
}

/** 深渊罗盘：下一层预览（BOSS / 变体 / 场地 / 天气 / 前缀 / 词缀 / 遗物） */
function hexPreviewHtml(p) {
  if (!p) return '';
  const chips = [];
  if (p.arena) chips.push(`<span class="he-pv-chip arena">${hexIco(p.arena.icon)} ${escHtml(p.arena.name)}</span>`);
  if (p.weather) chips.push(`<span class="he-pv-chip">${hexIco(p.weather.icon)} ${escHtml(p.weather.name)}</span>`);
  if (p.prefix) chips.push(`<span class="he-pv-chip neg">${hexIco(p.prefix.icon)} ${escHtml(p.prefix.name)}</span>`);
  for (const r of p.rules || []) {
    chips.push(`<span class="he-pv-chip${r.negative ? ' neg' : ''}">${hexIco(r.icon)} ${escHtml(r.name)}</span>`);
  }
  if (p.relic) chips.push(`<span class="he-pv-chip relic">${hexIco(p.relic.icon)} ${escHtml(p.relic.name)}</span>`);
  return `<div class="he-pv-title">${hexIco('hex/starCompass.png')}深渊罗盘 · 下一层预览</div>`
    + `<div class="he-pv-boss">${hexIco(p.bossIcon)}${escHtml(p.bossName)}`
    + `${p.variant ? '<span class="he-pv-tag">深渊变体</span>' : ''}</div>`
    + `<div class="he-pv-chips">${chips.join('')}</div>`;
}

/**
 * 无尽选择面板：data 为 null 时关闭。
 * allowPick=false（客机）时按钮置灰，只显示等待房主。
 */
export function showHexEndless(data) {
  const el = $('hex-endless');
  if (!el) return;
  if (!data) {
    el.classList.add('hidden');
    hexEndlessSig = '';
    return;
  }
  const canPick = data.allowPick !== false;
  const best = Number(localStorage.getItem('rr-hex-best') || 0);
  const pv = data.preview;
  const sig = `${data.stage}|${canPick}|${best}|${pv?.stage}|${pv?.bossName || ''}`
    + `|${pv?.variant?.name || ''}|${pv?.arena?.name || ''}|${pv?.relic?.name || ''}`
    + `|${(pv?.rules || []).map((r) => r.name).join(',')}`
    + `|${pv?.weather?.name || ''}|${pv?.prefix?.name || ''}`;
  if (sig !== hexEndlessSig) {
    hexEndlessSig = sig;
    $('he-stage').textContent = String(data.stage);
    $('he-next').textContent = String(data.nextStage);
    $('he-sub').textContent = canPick
      ? `选完不会锁舵：继续 → 先挑一张卡，选完自动升起去第 ${data.nextStage} 层的传送门`
        + `（BOSS 血量 +35% / 伤害 +18%，逐层叠加，词缀最多 3 条）；结束 → 直接升起回大厅的传送门`
      : '等待房主选择：继续挑战 / 结束领奖';
    $('he-best').textContent = best > 0 ? `历史最佳：第 ${best} 层` : '';
    const pvEl = $('he-preview');
    if (pvEl) pvEl.innerHTML = hexPreviewHtml(pv);
    $('he-go').disabled = !canPick;
    $('he-stop').disabled = !canPick;
  }
  el.classList.remove('hidden');
}

export function showBossEnd(data) {
  const el = $('boss-end');
  if (!el) return;
  if (!data) {
    el.classList.add('hidden');
    return;
  }
  const victory = !!data.victory;
  // 竞技场会自己给 title；怪物/海克斯走默认文案
  const rawTitle = data.title || (victory ? '🏆 通关！' : '💀 出局 · 全员阵亡');
  const title = iconizePrefix(rawTitle, 'be-ico');
  $('boss-end-title').innerHTML = title.src
    ? `<img class="be-ico" src="${title.src}" alt="" draggable="false">${escapeHtml(title.text)}`
    : escapeHtml(title.text);

  const grade = victory ? (data.grade || '') : (data.gradeWhenLost || '');
  const gradeEl = $('boss-end-grade');
  gradeEl.textContent = grade ? `评级 ${grade}` : '';
  gradeEl.style.display = grade ? '' : 'none';

  // 说明区两行：有 lines（竞技场）就直接用，否则按真实数据拼
  let lines;
  if (Array.isArray(data.lines)) {
    lines = data.lines.slice();
  } else {
    const unit = data.hex ? '层' : '关';
    const totalDmg = (data.damage || []).reduce((sum, d) => sum + (d.dmg || 0), 0);
    const totalTaken = (data.taken || []).reduce((sum, d) => sum + (d.taken || 0), 0);
    lines = [];
    if (victory) {
      lines.push(data.endlessStage
        ? `总用时 ${fmtTime(data.totalTime)} · 通过第 ${data.endlessStage} 层`
        : `总用时 ${fmtTime(data.totalTime)} · 全部 ${(data.stages || []).length || ''} ${unit}完成`);
    } else {
      lines.push(`倒在第 ${data.stage ?? '?'} ${unit} · 总用时 ${fmtTime(data.totalTime)}`);
    }
    lines.push(`总伤害 ${Math.round(totalDmg)} · 总承伤 ${Math.round(totalTaken)}`);
    // 海克斯：本局深渊积分（失败也按到达层数结算）
    if (data.hexPoints > 0) {
      lines.push(`💠 深渊积分 +${data.hexPoints} · 累计 ${data.hexPointsTotal}`);
    }
  }
  $('boss-end-sub').innerHTML = lines
    .map((text) => `<div><i></i><span>${escapeHtml(text)}</span></div>`).join('');
  // 说明区现在是雷达框 + 文字两列，雷达是纯装饰（CSS 画的）

  $('boss-end-src').innerHTML = bossSourceHtml(data);
  $('boss-end-tables').innerHTML = bossTablesHtml(data);
  $('boss-end-hex').innerHTML = data.hex ? hexReviewHtml(data.hex) : '';
  el.classList.remove('hidden');
}

/**
 * 潮汐竞技场（1v1）整场结算。复用 BOSS 的结算面板，只换文案：
 * 单人时按钮回主菜单，联机时由 main.js 那个 handler 负责"房主广播回大厅"。
 */
export function showArenaEnd(d) {
  if (!d) {
    showBossEnd(null);
    return;
  }
  const won = !!d.won;
  const score = `${d.myScore} : ${d.foeScore}`;
  showBossEnd({
    victory: won,
    title: won ? '🏆 你赢下了这场对决' : '💀 这场输了',
    grade: score,
    gradeWhenLost: score,
    lines: [
      `对手：${d.foeName || '对手'}`,
      `比分 ${score}（先到 ${d.rounds || 3} 分获胜）`,
      won ? '回大厅换艘艇，再来一场' : '回大厅换个打法试试',
    ],
  });
}

/** 云端天梯结算：复用领奖面板骨架，列出各玩家累计入账分 */
export function showSkyTowerEnd(d) {
  if (!d) { showBossEnd(null); return; }
  const me = (d.scores || []).find((s) => s.id === (d.myId || 'me'));
  const myScore = me?.score ?? d.score ?? 0;
  const lines = (d.scores || []).map((s, i) =>
    `${i + 1}. ${s.name}${s.ai ? '（AI）' : ''} — ${s.score} 分`);
  showBossEnd({
    victory: !!d.won,
    title: d.won ? '🏆 天梯登顶！' : '☁️ 本局结束',
    grade: `${myScore} 分`,
    gradeWhenLost: `${myScore} 分`,
    lines: lines.length ? lines : ['把货物带到顶层中央光环即可入账'],
  });
}

// 游戏内提示（道具/闪电等，蓝色信息条）
let gameToastTimer = null;
export function gameToast(msg) {
  const t = $('game-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(gameToastTimer);
  gameToastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

export function setRaceMsg(text, autoHideMs = 2500) {
  const elr = $('race-msg');
  if (!text) {
    elr.classList.add('hidden');
    return;
  }
  elr.textContent = text;
  elr.classList.remove('hidden');
  clearTimeout(setRaceMsg._t);
  if (autoHideMs) {
    setRaceMsg._t = setTimeout(() => elr.classList.add('hidden'), autoHideMs);
  }
}

const MEDALS = [
  iconImg('uiMedalGold', 'medal-ico') || '🥇',
  iconImg('uiMedalSilver', 'medal-ico') || '🥈',
  iconImg('uiMedalBronze', 'medal-ico') || '🥉',
];

// ---------- 左上角小地图 ----------
const minimapState = {
  canvas: null, ctx: null, scale: 1, ox: 0, oy: 0, ready: false, gates: null,
};

function initMinimap(gates) {
  minimapState.canvas = $('minimap');
  minimapState.ctx = minimapState.canvas.getContext('2d');
  // 计算赛道包围盒 → 映射到画布（留边距）
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of gates) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const SIZE = 200;
  const PAD = 14;
  const s = Math.min((SIZE - PAD * 2) / (maxX - minX || 1), (SIZE - PAD * 2) / (maxZ - minZ || 1));
  minimapState.scale = s;
  minimapState.ox = PAD + ((SIZE - PAD * 2) - (maxX - minX) * s) / 2;
  minimapState.oy = PAD + ((SIZE - PAD * 2) - (maxZ - minZ) * s) / 2;
  minimapState.baseMinX = minX;
  minimapState.baseMinZ = minZ;
  // 记住这份门点数组：换图后 track.gates 是新数组，必须重算包围盒。
  // 以前只判断 canvas.width，换图后继续用上一张图的缩放 → 路线被画出框外。
  minimapState.gates = gates;
  minimapState.ready = true;
}

function drawMinimap(mm, fireCore = null, portal = null, warm = false) {
  if (!mm.gates || mm.gates.length < 2) return;
  // 怪物模式的新皮肤是哑光黑面板 + 橙色符文 + 青蓝能量，
  // 小地图赛道环跟着走青绿发光（门点仍偏冷白，起点箭头保持暖金做对比）。
  const C = warm
    ? {
      track: '#3DF0C8',
      trackGlow: 'rgba(61, 240, 200, 0.9)',
      gate: 'rgba(150, 220, 220, 0.55)',
      arrow: '#F4DCB0',
      arrowGlow: 'rgba(244, 220, 176, 0.9)',
      meArrow: '#EDE4D0',
      meStroke: 'rgba(13, 12, 10, 0.85)',
    }
    : {
      track: '#2AF0D0',
      trackGlow: 'rgba(42, 240, 208, 0.9)',
      gate: 'rgba(160, 200, 230, 0.6)',
      arrow: '#C9FF5A',
      arrowGlow: 'rgba(200, 255, 90, 0.9)',
      meArrow: '#4fd0ff',
      meStroke: '#ffffff',
    };
  if (
    !minimapState.ready ||
    minimapState.canvas.width !== 200 ||
    minimapState.gates !== mm.gates
  ) {
    initMinimap(mm.gates);
  }
  const ctx = minimapState.ctx;
  const { scale: s, baseMinX, baseMinZ, ox, oy } = minimapState;
  const toX = (x) => (x - baseMinX) * s + ox;
  const toY = (z) => (z - baseMinZ) * s + oy;

  ctx.clearRect(0, 0, 200, 200);

  // 赛道路线（闭环折线）
  ctx.beginPath();
  mm.gates.forEach(([x, z], i) => {
    const px = toX(x), py = toY(z);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  // 路线：发光主色，带柔和光晕（怪物模式是暖金，其余是青绿）
  ctx.save();
  ctx.shadowColor = C.trackGlow;
  ctx.shadowBlur = 8;
  ctx.strokeStyle = C.track;
  ctx.lineWidth = 2.6;
  ctx.stroke();
  ctx.restore();

  // 各门点
  for (let i = 0; i < mm.gates.length; i++) {
    const [x, z] = mm.gates[i];
    ctx.beginPath();
    ctx.arc(toX(x), toY(z), 1.8, 0, Math.PI * 2);
    ctx.fillStyle = C.gate;
    ctx.fill();
  }

  // 起点：发光黄绿色小箭头，指向赛道前进方向
  const [sx, sz] = mm.gates[0];
  const [sx2, sz2] = mm.gates[1] || [sx + 1, sz];
  ctx.save();
  ctx.translate(toX(sx), toY(sz));
  ctx.rotate(Math.atan2(toY(sz2) - toY(sz), toX(sx2) - toX(sx)));
  ctx.shadowColor = C.arrowGlow;
  ctx.shadowBlur = 8;
  ctx.fillStyle = C.arrow;
  ctx.beginPath();
  ctx.moveTo(6.5, 0);
  ctx.lineTo(-4.5, 4.6);
  ctx.lineTo(-1.6, 0);
  ctx.lineTo(-4.5, -4.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 下一目标门（黄色高亮 + 呼吸）
  const [nx, nz] = mm.gates[mm.nextGate];
  const pulse = 0.6 + 0.4 * Math.sin(performance.now() * 0.006);
  ctx.beginPath();
  ctx.arc(toX(nx), toY(nz), 4.5 + pulse * 2, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 217, 122, ${0.55 + pulse * 0.35})`;
  ctx.fill();

  // 其他艇（圆点）
  for (const b of mm.boats) {
    if (b.isMe) continue;
    ctx.beginPath();
    ctx.arc(toX(b.x), toY(b.z), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.stroke();
  }

  // 火力核心：金色菱形 + 呼吸光圈（在外圈也能一眼看到它在哪个方向）
  if (fireCore) {
    const fx = toX(fireCore.x), fy = toY(fireCore.z);
    ctx.save();
    ctx.translate(fx, fy);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = 'rgba(255, 194, 74, 0.95)';
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(fx, fy, 7 + pulse * 4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 214, 120, ${0.75 - pulse * 0.35})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 过关传送门：紫色双环 + 呼吸（场上随机出现，不标出来很难找到）
  if (portal) {
    const px = toX(portal.x), py = toY(portal.z);
    ctx.beginPath();
    ctx.arc(px, py, 5 + pulse * 3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(186, 140, 255, ${0.9 - pulse * 0.3})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(226, 205, 255, 0.95)';
    ctx.fill();
  }

  // 本地玩家：到下一门的引导虚线 + 朝向箭头
  const me = mm.boats.find((b) => b.isMe);
  if (me) {
    // 传送门阶段改成指向门：此时“下一道门”没有意义
    const gx = portal ? portal.x : nx;
    const gz = portal ? portal.z : nz;
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.moveTo(toX(me.x), toY(me.z));
    ctx.lineTo(toX(gx), toY(gz));
    ctx.strokeStyle = portal ? 'rgba(198, 150, 255, 0.75)' : 'rgba(255, 217, 122, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.save();
    ctx.translate(toX(me.x), toY(me.z));
    ctx.rotate(-me.heading);
    // 朝 +Z（画布下方）的箭头
    ctx.beginPath();
    ctx.moveTo(0, 7);
    ctx.lineTo(5, -5);
    ctx.lineTo(0, -2);
    ctx.lineTo(-5, -5);
    ctx.closePath();
    ctx.fillStyle = C.meArrow;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = C.meStroke;
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 领奖台上的半透明结算板（参考图那种悬空计分榜）。
 * data = { title, sub, grid, columns: string[], rows: [{ me, cells: string[] }] }
 * 传 null 收起。
 */
export function renderPodiumBoard(data) {
  const board = $('podium-board');
  if (!board) return;
  if (!data) { board.classList.add('hidden'); return; }
  board.classList.remove('hidden');
  const t = $('podium-board-title');
  const s = $('podium-board-sub');
  if (t) t.textContent = data.title || '比赛结算';
  if (s) {
    // subHtml 允许组队结算把队名染成队伍色；普通模式仍走纯文本
    if (data.subHtml) s.innerHTML = data.subHtml;
    else s.textContent = data.sub || '';
  }
  const body = $('podium-board-body');
  if (!body) return;
  const grid = data.grid || '46px 1fr 108px 96px 84px 62px';
  // 列头单独一行；数据行按真实行数往下排（不再 space-evenly 摊满）。
  // 面板高度 = 表头 + 行数：2 人就是一小块，8 人才变长，不会拉满整屏。
  const cols = $('podium-board-cols');
  if (cols) {
    cols.style.gridTemplateColumns = grid;
    cols.innerHTML = (data.columns || []).map((c) => `<span>${c}</span>`).join('');
  }
  const rows = data.rows || [];
  body.classList.toggle('dense', rows.length > 6);
  body.innerHTML = rows.map((r) => `
      <div class="pb-row${r.me ? ' me' : ''}" style="grid-template-columns:${grid}">
        ${r.cells.map((c, i) => `<span class="${i === 0 ? 'pb-rank' : ''}">${c}</span>`).join('')}
      </div>`).join('');
}

export function renderResults(containerId, results, myId, opts = {}) {
  const body = $(containerId);
  if (!body) return;
  // 单局成绩：名次 / 选手 / 赛艇 / 成绩 / 最快圈 / 积分，六列网格（列宽由 --nr-grid 给）
  body.innerHTML = results.map((r) => {
    const rank = r.rank ?? 0;
    const medal = rank <= 3 && rank > 0 ? MEDALS[rank - 1] : `<b class="nr-num">${rank}</b>`;
    const boat = BOATS.find((b) => b.id === r.boatId);
    const dot = r.team
      ? `<i class="nr-dot" style="background:${r.team === 'blue' ? '#3aa0ff' : '#ff5a5a'}"></i>`
      : '';
    const time = r.dnf ? '<span class="nr-dnf">未完赛</span>' : fmtTime(r.time);
    const best = r.bestLap != null ? fmtTime(r.bestLap) : '—';
    const pts = opts.showPoints && r.points != null
      ? `<span class="nr-score">+${r.points}<i>总 ${r.totalScore ?? 0}</i></span>`
      : '';
    return `<div class="nr-row${r.id === myId ? ' me' : ''}">
      <span class="nr-medal">${medal}</span>
      <span class="nr-name">${dot}${r.style?.titleName ? `<i class="nr-title-tag">${escHtml(r.style.titleName)}</i>` : ''}${escHtml(r.name || '玩家')}${r.ai ? '<i class="nr-ai">AI</i>' : ''}</span>
      <span class="nr-boat">${escHtml(boat ? boat.name : '—')}</span>
      <span class="nr-val">${time}</span>
      <span class="nr-val">${best}</span>
      ${pts}
    </div>`;
  }).join('');
}

/**
 * 海克斯三选一浮层（本局核心 / 通关卡牌共用）。
 * @param {object|null} info 传 null 关闭；否则 { kind, cards, timeout, allowPick, stage }
 * @param {(id:string)=>void} onPick
 */
export function showHexCards(info, onPick, onAction) {
  const root = $('hex-cards');
  if (!root) return;
  if (!info) {
    root.classList.add('hidden');
    root.innerHTML = '';
    root.onclick = null;
    return;
  }
  const isCore = info.kind === 'core';
  const defs = isCore ? HEX_CORES : HEX_CARDS;
  const cards = (info.cards || []).map((id) => defs.find((d) => d.id === id)).filter(Boolean);
  const RARITY_NAME = { white: '白卡', blue: '蓝卡', gold: '金卡' };
  // 底部两枚铜章：左星章（危险/稀有度语汇）、右罗盘（海克斯语汇），都用新画的同风格图
  const SEAL_L = '/icons/hex/starRating.png';
  const SEAL_R = '/icons/hex/starCompass.png';
  root.classList.remove('hidden');
  root.innerHTML = `
    <div class="hex-cards-panel">
      <div class="hex-cards-head">${isCore ? '选择本局海克斯核心' : `第 ${info.stage} 关通关 · 三选一`}</div>
      <div class="hex-cards-row">
        ${cards.map((d) => {
          const rar = d.rarity || 'core';
          return `
          <button class="hex-card ${rar}" data-id="${d.id}"${info.allowPick === false ? ' disabled' : ''} type="button">
            <span class="hc-frame">
              <span class="hc-gem" aria-hidden="true"></span>
              <span class="hc-art"><img src="/icons/${d.icon}" alt="" draggable="false"></span>
              <span class="hc-scroll">
                <b class="hc-name">${escHtml(d.name)}</b>
                <span class="hc-desc">${escHtml(d.desc)}</span>
                <em class="hc-kind">海克斯 · ${isCore ? '本局核心' : (RARITY_NAME[rar] || '卡牌')}</em>
              </span>
              <span class="hc-seal hc-seal-l" aria-hidden="true"><img src="${SEAL_L}" alt=""></span>
              <span class="hc-seal hc-seal-r" aria-hidden="true"><img src="${SEAL_R}" alt=""></span>
            </span>
          </button>`;
        }).join('')}
      </div>
      <div class="hex-cards-foot">
        ${info.timeout ? `超时自动拿第一张 · 关卡倒计时会等你选完再走` : ''}${info.allowPick === false ? ' · 等待房主选择' : ''}
        ${info.extra?.reroll ? `<button class="hex-extra-btn" data-act="reroll" type="button">${hexIco('hex/reroll.png')}重掷（每局 1 次）</button>` : ''}
        ${info.extra?.discard ? `<button class="hex-extra-btn" data-act="discard" type="button">${hexIco('hex/discard.png')}弃牌换血（回 15%）</button>` : ''}
      </div>
    </div>`;
  root.onclick = (e) => {
    const act = e.target.closest('[data-act]');
    if (act && !act.disabled) { onAction?.(act.dataset.act); return; }
    const btn = e.target.closest('.hex-card');
    if (!btn || btn.disabled) return;
    onPick?.(btn.dataset.id);
  };
}
