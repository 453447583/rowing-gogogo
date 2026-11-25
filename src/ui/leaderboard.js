// 联机排行榜面板（只读；数据全部来自服务器）。
//
// 交互取舍
// --------
// ① 三个页签对应三种玩法：竞速 / 怪物 / 海克斯。道具赛不做榜，所以没有页签。
// ② 竞速按「地图 × 圈数」分桶：1 圈和 5 圈的成绩没有可比性。
// ③ 怪物 / 海克斯按「开赛时的真人数量」分桶（1~6 人），AI 永远不进榜 ——
//    带 3 个 AI 打出来的成绩和 4 个真人打出来的难度差太多。
// ④ 榜单只放 Top10，但底部固定给一行「我的最好成绩」：
//    没上榜的人也能看到自己差多少，比纯 Top10 有用。
//
// 视觉：赛博金框（2026-11-21 按参考图重构）
// -----------------------------------------
// 深蓝黑底 + 暗金机械外框 + 极少量青色点缀。金色是「哑光金属」不是辉光：
// 靠多层渐变模拟拉丝与斜切受光，发光只用极细的 drop-shadow 包边。
// 所有切角用 clip-path 实现（矩形 border 在斜边上会断线，所以用 drop-shadow 描边）。
import { MAPS } from '../data/maps.js';
import { BOSS_LEVELS } from '../data/bosses.js';
import { getBoat } from '../data/boats.js';
import { avatarMarkup } from './avatars.js';
import { audio } from '../audio/AudioEngine.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function fmtTime(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const v = Number(sec);
  const m = Math.floor(v / 60);
  const s = v - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * 前三名的皇冠（金 / 银 / 铜）。用内联 SVG 而不是图片：
 * - 现有 90_ui_crown.png 是「深蓝底 + 金冠」的 tile，没有银铜版；CSS 染色会把底也染掉。
 * - 金色按面板口径走哑光金属渐变 + 极细描边，银/铜换三档色标即可，风格统一。
 * 每行 SVG 的 gradient id 按名次区分，避免多处引用撞 id。
 * @param {number} rank 1|2|3
 */
function rankCrown(rank) {
  const shades = {
    1: ['#fff4c2', '#ffcf4d', '#a96a10', '#3fe0e0'], // 金 + 青宝石
    2: ['#ffffff', '#cbd5df', '#6b7a88', '#bfe8ff'], // 银 + 冰蓝宝石
    3: ['#ffd6b0', '#cd7f45', '#7a4020', '#ffb36b'], // 铜 + 琥珀宝石
  }[rank];
  if (!shades) return '';
  const [light, mid, dark, gem] = shades;
  const gid = `lbCrown${rank}`;
  return `<svg class="lb-crown" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${light}"/><stop offset=".55" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/>
    </linearGradient></defs>
    <path d="M2.2 7.4 6.8 11 12 3.6 17.2 11 21.8 7.4 19.6 18.2H4.4Z"
      fill="url(#${gid})" stroke="${light}" stroke-opacity=".65" stroke-width=".7" stroke-linejoin="round"/>
    <path d="M4.4 18.2h15.2l-.5 2.3H4.9Z" fill="url(#${gid})" stroke="${dark}" stroke-width=".5"/>
    <circle cx="12" cy="13.4" r="1.9" fill="${gem}" stroke="${light}" stroke-width=".6"/>
  </svg>`;
}

const TABS = [
  ['race', '竞速'],
  ['boss', '怪物'],
  ['hex', '海克斯'],
  ['tower', '天梯'],
];

/** 大厅可选的圈数（和 #sel-laps 一致，别在这里凭空多出 2/4 圈） */
const LAP_OPTIONS = [1, 3, 5];
const HUMAN_OPTIONS = [1, 2, 3, 4, 5, 6];

export class LeaderboardPanel {
  constructor() {
    this.root = null;
    this.net = null;
    this.getName = () => '';
    this.getMapId = () => MAPS[0]?.id || 'canyon';
    this.tab = 'race';
    this.mapId = MAPS[0]?.id || 'canyon';
    this.laps = 3;
    this.humans = 1;
    this.stage = 1;
    this.data = null;
    this.loading = false;
    this.error = false;
    this.loadTimer = null;
  }

  /**
   * @param {{net:object, getName?:Function, getMapId?:Function}} opts
   */
  init(opts = {}) {
    this.net = opts.net || null;
    this.getName = opts.getName || (() => '');
    this.getMapId = opts.getMapId || this.getMapId;
    this.root = document.getElementById('leaderboard');
    if (!this.root) return this;

    // 外层 .lb-card 是金色金属框（clip-path 切角），.lb-inner 是深蓝黑内胆。
    // 两者之间留 7px，露出的那圈金色就是边框本身；四角再压金属角件盖住斜边接缝。
    this.root.innerHTML = `
      <div class="sp-card lb-card" role="dialog" aria-label="排行榜">
        <div class="lb-inner">
          <span class="lb-corner tl"></span>
          <span class="lb-corner tr"></span>
          <span class="lb-corner bl"></span>
          <span class="lb-corner br"></span>
          <span class="lb-vent l"></span>
          <span class="lb-vent r"></span>
          <div class="sp-head lb-head">
            <div class="lb-head-txt">
              <div class="lb-title">排行榜</div>
              <div class="lb-sub">联机战绩 · 只统计真人 · AI 不计入</div>
            </div>
            <button class="sp-x lb-x" type="button" data-lb="close" title="关闭（Esc）"></button>
          </div>
          <div class="sp-body lb-body">
            <div class="sp-tabs lb-tabs" data-lb="tabs"></div>
            <div class="sp-pane lb-pane" data-lb="pane"></div>
          </div>
          <!-- 固定页脚：不管榜单滑到哪，「我的最好成绩」始终看得见 -->
          <div class="sp-foot lb-foot" data-lb="foot"></div>
        </div>
      </div>`;

    this.root.querySelector('[data-lb="close"]').onclick = () => this.close();
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });

    // 服务器回包：{ boards: { key: [...] }, mine: { key: entry } }
    this.net?.on?.('lb', (e) => {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      this.data = e.detail || null;
      this.loading = false;
      this.error = false;
      this.#pickDefaults();
      if (this.isOpen) this.#render();
    });
    return this;
  }

  get isOpen() {
    return !!this.root && !this.root.classList.contains('hidden');
  }

  open() {
    if (!this.root) return;
    this.mapId = this.getMapId?.() || this.mapId;
    this.root.classList.remove('hidden');
    // 弹入动画只在「打开」这一下播。卡片 DOM 是 init 时建好的，
    // 不主动重置一次，第二次打开就不会动了。
    const card = this.root.querySelector('.lb-card');
    if (card) {
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    }
    this.loading = true;
    this.error = false;
    this.#pickDefaults();
    this.#render();
    audio.play('uiOpen', { gap: 0 });
    const sent = this.net?.send?.({ t: 'lbGet' });
    clearTimeout(this.loadTimer);
    // 6 秒没回包就当成失败：弱网时别让玩家对着「正在读取…」一直等
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      if (!this.loading) return;
      this.loading = false;
      this.error = true;
      if (this.isOpen) this.#render();
    }, 6000);
    if (sent === false) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
      this.loading = false;
      this.error = true;
      this.#render();
    }
  }

  close() {
    if (!this.isOpen) return;
    clearTimeout(this.loadTimer);
    this.loadTimer = null;
    this.loading = false;
    this.root.classList.add('hidden');
    audio.play('uiClose', { gap: 0 });
  }

  toggle() {
    if (this.isOpen) this.close(); else this.open();
  }

  // ---------- 数据选择 ----------

  #board(key) {
    const list = this.data?.boards?.[key];
    return Array.isArray(list) ? list : [];
  }

  #mine(key) {
    return this.data?.mine?.[key] || null;
  }

  /** 有数据的真人桶（怪物 / 海克斯分开算） */
  #hasHumans(n, kind) {
    const boards = this.data?.boards || {};
    if (kind === 'hex') return !!boards[`hx:${n}`];
    return !!boards[`bt:${n}`] || Object.keys(boards).some((k) => k.startsWith(`bs:${n}:`));
  }

  /**
   * 打开 / 收到数据时校正选中项：当前选择没记录就自动跳到第一个有记录的，
   * 免得玩家一进来看到的是一张空榜，还以为排行榜坏了。
   */
  #pickDefaults() {
    const boards = this.data?.boards || {};
    if (this.tab === 'race') {
      if (!boards[`r:${this.mapId}:${this.laps}`]) {
        for (const map of MAPS) {
          const hit = LAP_OPTIONS.find((l) => boards[`r:${map.id}:${l}`]);
          if (hit) { this.mapId = map.id; this.laps = hit; break; }
        }
      }
    } else if (this.tab === 'boss') {
      if (!this.#hasHumans(this.humans, 'boss')) {
        const n = HUMAN_OPTIONS.find((h) => this.#hasHumans(h, 'boss'));
        if (n) this.humans = n;
      }
    } else if (this.tab === 'hex') {
      if (!this.#hasHumans(this.humans, 'hex')) {
        const n = HUMAN_OPTIONS.find((h) => this.#hasHumans(h, 'hex'));
        if (n) this.humans = n;
      }
    }
  }

  // ---------- 渲染 ----------

  #render() {
    if (!this.root) return;
    const tabsEl = this.root.querySelector('[data-lb="tabs"]');
    const paneEl = this.root.querySelector('[data-lb="pane"]');
    const footEl = this.root.querySelector('[data-lb="foot"]');
    if (!tabsEl || !paneEl) return;

    tabsEl.innerHTML = TABS.map(([id, name]) => (
      `<button class="sp-tab lb-tab${id === this.tab ? ' on' : ''}" type="button" data-lb-tab="${id}">${name}</button>`
    )).join('');
    tabsEl.onclick = (e) => {
      const btn = e.target.closest?.('[data-lb-tab]');
      if (!btn) return;
      this.tab = btn.dataset.lbTab;
      this.#pickDefaults();
      audio.play('uiClick', { gap: 0 });
      this.#render();
    };

    // 没有数据时页脚保持一条空的占位，避免面板高度在「空榜 → 有榜」之间跳
    if (footEl) footEl.innerHTML = '<div class="lb-mine lb-mine-blank" aria-hidden="true"></div>';

    if (this.loading && !this.data) {
      paneEl.innerHTML = '<div class="lb-state"><i class="lb-state-orb"></i><span>正在读取排行榜…</span></div>';
      return;
    }
    if (this.error && !this.data) {
      paneEl.innerHTML = '<div class="lb-state"><i class="lb-state-orb err"></i><span>读取排行榜失败<br><em>检查一下网络，或者稍后再打开</em></span></div>';
      return;
    }
    const hasAny = !!this.data && Object.keys(this.data.boards || {}).length > 0;
    if (!hasAny) {
      paneEl.innerHTML = '<div class="lb-state"><i class="lb-state-orb empty"></i><span>服务器上还没有任何成绩<br><em>跑一局竞速或打完一场怪物模式就会出现在这里</em></span></div>';
      return;
    }

    // 队伍人数多时把整块面板加宽（不是只让名字挤成省略号），
    // 2 人沿用原尺寸；3~4 人中宽；5~6 人最宽。
    const card = this.root.querySelector('.lb-card');
    const teamSize = this.#teamSize();
    card?.classList.toggle('lb-wide', teamSize >= 3);
    card?.classList.toggle('lb-ultra', teamSize >= 5);

    if (this.tab === 'race') paneEl.innerHTML = this.#raceView();
    else if (this.tab === 'boss') paneEl.innerHTML = this.#bossView();
    else if (this.tab === 'tower') paneEl.innerHTML = this.#towerView();
    else paneEl.innerHTML = this.#hexView();
    paneEl.onclick = (e) => this.#onPick(e);
    paneEl.onscroll = () => this.#syncScrollFade();
    paneEl.scrollTop = 0;
    this.#syncScrollFade();
    if (footEl) {
      const key = this.tab === 'race' ? `r:${this.mapId}:${this.laps}`
        : this.tab === 'boss' ? `bt:${this.humans}`
          : this.tab === 'tower' ? 'tw:best' : `hx:${this.humans}`;
      const kind = this.tab === 'hex' || this.tab === 'tower' ? 'hex'
        : (this.tab === 'race' ? 'race' : 'time');
      footEl.innerHTML = this.#mineBlock(key, kind);
    }
  }

  /**
   * 内容超过可视高度时给列表底部加一道渐隐（CSS .has-more），
   * 免得最后半行成绩被页脚硬切；滚到底部就撤掉，不能把最后一行也淡化。
   */
  #syncScrollFade() {
    const pane = this.root?.querySelector('[data-lb="pane"]');
    if (!pane) return;
    const more = pane.scrollHeight - pane.scrollTop - pane.clientHeight > 4;
    pane.classList.toggle('has-more', more);
  }

  #onPick(e) {
    const mapBtn = e.target.closest?.('[data-lb-map]');
    if (mapBtn) {
      this.mapId = mapBtn.dataset.lbMap;
      audio.play('uiClick', { gap: 0 });
      this.#render();
      return;
    }
    const lapBtn = e.target.closest?.('[data-lb-laps]');
    if (lapBtn) {
      this.laps = Number(lapBtn.dataset.lbLaps) || 3;
      audio.play('uiClick', { gap: 0 });
      this.#render();
      return;
    }
    const humanBtn = e.target.closest?.('[data-lb-humans]');
    if (humanBtn) {
      this.humans = Number(humanBtn.dataset.lbHumans) || 1;
      audio.play('uiClick', { gap: 0 });
      this.#render();
      return;
    }
    const stageBtn = e.target.closest?.('[data-lb-stage]');
    if (stageBtn) {
      this.stage = Number(stageBtn.dataset.lbStage) || 1;
      audio.play('uiClick', { gap: 0 });
      this.#render();
    }
  }

  #raceView() {
    const key = `r:${this.mapId}:${this.laps}`;
    const rows = this.#board(key).slice(0, 10);
    const mapName = MAPS.find((m) => m.id === this.mapId)?.name || this.mapId;
    const maps = MAPS.map((m) => {
      const any = LAP_OPTIONS.some((l) => this.#board(`r:${m.id}:${l}`).length);
      return `<button class="lb-chip${m.id === this.mapId ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-map="${m.id}">${esc(m.name)}</button>`;
    }).join('');
    const laps = LAP_OPTIONS.map((l) => {
      const any = this.#board(`r:${this.mapId}:${l}`).length;
      return `<button class="lb-chip lb-chip-sm${l === this.laps ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-laps="${l}">${l} 圈</button>`;
    }).join('');

    return `
      <div class="lb-chips">${maps}</div>
      <div class="lb-chips lb-chips-sub">${laps}</div>
      ${this.#sec(`${mapName} · ${this.laps} 圈 · 个人赛`)}
      ${rows.length ? rows.map((e, i) => this.#row(e, i, 'race')).join('') : '<div class="lb-empty">这张图还没有成绩</div>'}`;
  }

  #bossView() {
    const totalKey = `bt:${this.humans}`;
    const stageKey = `bs:${this.humans}:${this.stage}`;
    const total = this.#board(totalKey).slice(0, 5);
    const stage = this.#board(stageKey).slice(0, 5);
    const humans = HUMAN_OPTIONS.map((n) => {
      const any = this.#hasHumans(n, 'boss');
      return `<button class="lb-chip lb-chip-sm${n === this.humans ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-humans="${n}">${n} 人</button>`;
    }).join('');
    const level = BOSS_LEVELS.find((l) => l.stage === this.stage) || BOSS_LEVELS[0];
    const stages = BOSS_LEVELS.map((l) => {
      const any = this.#board(`bs:${this.humans}:${l.stage}`).length;
      return `<button class="lb-chip lb-chip-sm${l.stage === this.stage ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-stage="${l.stage}">第 ${l.stage} 关</button>`;
    }).join('');

    return `
      <div class="lb-chips"><span class="lb-chips-tag">真人</span>${humans}</div>
      ${this.#sec('五关全通 · 总用时')}
      ${total.length ? total.map((e, i) => this.#row(e, i, 'time')).join('') : '<div class="lb-empty">还没有通关记录</div>'}
      ${this.#sec(`单关最快 · ${level?.name || ''}`)}
      <div class="lb-chips lb-chips-sub">${stages}</div>
      ${stage.length ? stage.map((e, i) => this.#row(e, i, 'time')).join('') : '<div class="lb-empty">这一关还没有成绩</div>'}`;
  }

  #hexView() {
    const key = `hx:${this.humans}`;
    const rows = this.#board(key).slice(0, 10);
    const humans = HUMAN_OPTIONS.map((n) => {
      const any = this.#hasHumans(n, 'hex');
      return `<button class="lb-chip lb-chip-sm${n === this.humans ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-humans="${n}">${n} 人</button>`;
    }).join('');

    return `
      <div class="lb-chips"><span class="lb-chips-tag">真人</span>${humans}</div>
      ${this.#sec('通过关卡数优先 · 同关卡比总用时')}
      ${rows.length ? rows.map((e, i) => this.#row(e, i, 'hex')).join('') : '<div class="lb-empty">还没有海克斯记录</div>'}`;
  }

  #towerView() {
    const rows = this.#board('tw:best').slice(0, 10);
    return `
      ${this.#sec('云端天梯 · 最高到达层优先')}
      ${rows.length ? rows.map((e, i) => this.#row(e, i, 'tower')).join('')
        : '<div class="lb-empty">还没有天梯记录，通关一层就会上榜</div>'}`;
  }

  /** 分区标题：两侧细线 + 菱形端点，和参考图一致 */
  #sec(text) {
    return `<div class="lb-sec"><i></i><span>${esc(text)}</span><i></i></div>`;
  }

  /** 当前榜单里一条成绩最多带几名队友（怪物/海克斯是整队成绩） */
  #teamSize() {
    const keys = this.tab === 'race'
      ? [`r:${this.mapId}:${this.laps}`]
      : this.tab === 'boss'
        ? [`bt:${this.humans}`, ...[1, 2, 3, 4, 5].map((s) => `bs:${this.humans}:${s}`)]
        : [`hx:${this.humans}`];
    let max = 1;
    for (const key of keys) {
      for (const e of this.#board(key)) {
        if (Array.isArray(e.p)) max = Math.max(max, e.p.length);
      }
    }
    return max;
  }

  #style(e) {
    return e.style || this.data?.styles?.[e.n] || {};
  }

  /** 一行成绩。kind: 'race' 带最快圈 / 'hex' 带通过关卡 / 'time' 纯用时 */
  #row(e, i, kind) {
    const mine = this.getName();
    // 竞速是个人成绩；怪物/海克斯把整队名单都列出来，房主（上报者 e.n）标红。
    const mates = kind === 'race' ? [] : (Array.isArray(e.p) ? e.p.filter((m) => m && m.n) : []);
    const team = mates.length > 1;
    const me = e.n === mine || mates.some((m) => m.n === mine);
    const boat = getBoat(e.b)?.name || '—';
    const val = kind === 'hex'
      ? `<span class="lb-val">${Number(e.c) || 0}<em class="lb-clear"> / ${BOSS_LEVELS.length} 关</em><em class="lb-sub">${fmtTime(e.t)}</em></span>`
      : kind === 'tower'
        ? `<span class="lb-val">第 ${Number(e.c) || 1} 层<em class="lb-sub">${fmtTime(e.t)}</em></span>`
        : `<span class="lb-val">${fmtTime(e.t)}${kind === 'race' && e.bl ? `<em class="lb-sub">最快圈 ${fmtTime(e.bl)}</em>` : ''}</span>`;
    const names = team
      ? mates.map((m) => {
        const host = m.n === e.n;
        const self = m.n === mine;
        return `<span class="lb-mate${host ? ' host' : ''}${self ? ' self' : ''}">${esc(m.n)}${host ? '<em class="lb-host-tag">房</em>' : ''}${self ? '<em class="lb-you">你</em>' : ''}</span>`;
      }).join('')
      : `${esc(e.n)}${me ? '<em class="lb-you">你</em>' : ''}`;
    return `
      <div class="lb-row${me ? ' me' : ''}${team ? ' team' : ''}${kind === 'hex' ? ' hex' : ''}" style="--i:${i}">
        <span class="lb-rank${i < 3 ? ` r${i + 1}` : ''}">${i < 3 ? rankCrown(i + 1) : ''}<b>${i + 1}</b></span>
        <span class="lb-ava"${this.#style(e).frameColor ? ` style="--lb-frame-color:${this.#style(e).frameColor}"` : ''}>${avatarMarkup(e.a, false)}</span>
        <span class="lb-name${team ? ' lb-team' : ''}${this.#style(e).fx ? ` nfx ${this.#style(e).fx}` : ''}"${this.#style(e).fx ? ` style="--fx:${this.#style(e).fxColor || '#ffcf8b'}"` : ''}>${this.#style(e).titleName ? `<em class="lb-title-tag">${esc(this.#style(e).titleName)}</em>` : ''}${names}${(Array.isArray(this.#style(e).badges) ? this.#style(e).badges : []).map((b) => `<i class="p-badge" style="--c:${esc(b.color || '#FFD166')}" title="${esc(b.name || '')}">${esc(b.glyph || '★')}</i>`).join('')}</span>
        <span class="lb-boat">${esc(boat)}</span>
        ${val}
      </div>`;
  }

  #mineBlock(key, kind) {
    const m = this.#mine(key);
    const label = kind === 'hex'
      ? (m ? `${Number(m.c) || 0} 关 · ${fmtTime(m.t)}` : '未上榜')
      : (m ? fmtTime(m.t) : '未上榜');
    const hint = m ? esc(getBoat(m.b)?.name || '') : '打完一局就会自动记录';
    return `<div class="lb-mine">
      <span class="lb-mine-l">我的最好成绩<b>${label}</b></span>
      <span class="lb-orn" aria-hidden="true"></span>
      <span class="lb-mine-r">${hint}</span>
    </div>`;
  }
}

export const leaderboardPanel = new LeaderboardPanel();
