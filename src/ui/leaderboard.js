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
// 视觉沿用设置面板那套「深海玻璃」：直接把 #leaderboard 复用 .sp / .sp-card
// 的骨架，只覆盖宽度。少写 40 行重复的毛玻璃 CSS，也保证两面板不会跑偏。
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

const TABS = [
  ['race', '竞速'],
  ['boss', '怪物'],
  ['hex', '海克斯'],
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

    this.root.innerHTML = `
      <div class="sp-card lb-card" role="dialog" aria-label="排行榜">
        <div class="sp-head">
          <div>
            <div class="sp-title">排 行 榜</div>
            <div class="sp-sub">联机战绩 · 只统计真人 · AI 不计入</div>
          </div>
          <button class="sp-x" type="button" data-lb="close" title="关闭（Esc）"></button>
        </div>
        <div class="sp-body">
          <div class="sp-tabs" data-lb="tabs"></div>
          <div class="sp-pane" data-lb="pane"></div>
        </div>
        <!-- 固定页脚：不管榜单滑到哪，「我的最好成绩」始终看得见 -->
        <div class="sp-foot lb-foot" data-lb="foot"></div>
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
    if (footEl) footEl.innerHTML = '';

    tabsEl.innerHTML = TABS.map(([id, name]) => (
      `<button class="sp-tab${id === this.tab ? ' on' : ''}" type="button" data-lb-tab="${id}">${name}</button>`
    )).join('');
    tabsEl.onclick = (e) => {
      const btn = e.target.closest?.('[data-lb-tab]');
      if (!btn) return;
      this.tab = btn.dataset.lbTab;
      this.#pickDefaults();
      audio.play('uiClick', { gap: 0 });
      this.#render();
    };

    if (this.loading && !this.data) {
      paneEl.innerHTML = '<div class="lb-empty">正在读取排行榜…</div>';
      return;
    }
    if (this.error && !this.data) {
      paneEl.innerHTML = '<div class="lb-empty">读取排行榜失败。<br>检查一下网络，或者稍后再打开。</div>';
      return;
    }
    const hasAny = !!this.data && Object.keys(this.data.boards || {}).length > 0;
    if (!hasAny) {
      paneEl.innerHTML = '<div class="lb-empty">服务器上还没有任何成绩。<br>跑一局竞速或打完一场怪物模式就会出现在这里。</div>';
      return;
    }

    if (this.tab === 'race') paneEl.innerHTML = this.#raceView();
    else if (this.tab === 'boss') paneEl.innerHTML = this.#bossView();
    else paneEl.innerHTML = this.#hexView();
    paneEl.onclick = (e) => this.#onPick(e);
    paneEl.scrollTop = 0;
    if (footEl) {
      const key = this.tab === 'race' ? `r:${this.mapId}:${this.laps}`
        : this.tab === 'boss' ? `bt:${this.humans}` : `hx:${this.humans}`;
      footEl.innerHTML = this.#mineBlock(key, this.tab === 'hex' ? 'hex' : (this.tab === 'race' ? 'race' : 'time'));
    }
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
      return `<button class="lb-chip${l === this.laps ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-laps="${l}">${l} 圈</button>`;
    }).join('');

    return `
      <div class="lb-chips">${maps}</div>
      <div class="lb-chips lb-chips-laps">${laps}</div>
      <div class="lb-sec">${esc(mapName)} · ${this.laps} 圈 · 个人赛</div>
      ${rows.length ? rows.map((e, i) => this.#row(e, i, 'race')).join('') : '<div class="lb-empty">这张图还没有成绩</div>'}`;
  }

  #bossView() {
    const totalKey = `bt:${this.humans}`;
    const stageKey = `bs:${this.humans}:${this.stage}`;
    const total = this.#board(totalKey).slice(0, 5);
    const stage = this.#board(stageKey).slice(0, 5);
    const humans = HUMAN_OPTIONS.map((n) => {
      const any = this.#hasHumans(n, 'boss');
      return `<button class="lb-chip${n === this.humans ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-humans="${n}">${n} 人</button>`;
    }).join('');
    const level = BOSS_LEVELS.find((l) => l.stage === this.stage) || BOSS_LEVELS[0];
    const stages = BOSS_LEVELS.map((l) => {
      const any = this.#board(`bs:${this.humans}:${l.stage}`).length;
      return `<button class="lb-chip${l.stage === this.stage ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-stage="${l.stage}">第 ${l.stage} 关</button>`;
    }).join('');

    return `
      <div class="lb-chips">${humans}</div>
      <div class="lb-sec">四关全通 · 总用时</div>
      ${total.length ? total.map((e, i) => this.#row(e, i, 'time')).join('') : '<div class="lb-empty">还没有通关记录</div>'}
      <div class="lb-sec">单关最快 · ${esc(level?.name || '')}</div>
      <div class="lb-chips lb-chips-laps">${stages}</div>
      ${stage.length ? stage.map((e, i) => this.#row(e, i, 'time')).join('') : '<div class="lb-empty">这一关还没有成绩</div>'}`;
  }

  #hexView() {
    const key = `hx:${this.humans}`;
    const rows = this.#board(key).slice(0, 10);
    const humans = HUMAN_OPTIONS.map((n) => {
      const any = this.#hasHumans(n, 'hex');
      return `<button class="lb-chip${n === this.humans ? ' on' : ''}${any ? '' : ' none'}"
        type="button" data-lb-humans="${n}">${n} 人</button>`;
    }).join('');

    return `
      <div class="lb-chips">${humans}</div>
      <div class="lb-sec">通过关卡数优先 · 同关卡比总用时</div>
      ${rows.length ? rows.map((e, i) => this.#row(e, i, 'hex')).join('') : '<div class="lb-empty">还没有海克斯记录</div>'}`;
  }

  /** 一行成绩。kind: 'race' 带最快圈 / 'hex' 带通过关卡 / 'time' 纯用时 */
  #row(e, i, kind) {
    const me = e.n === this.getName();
    const boat = getBoat(e.b)?.name || '—';
    const val = kind === 'hex'
      ? `<span class="lb-val">${Number(e.c) || 0} / ${BOSS_LEVELS.length}<em class="lb-sub">${fmtTime(e.t)}</em></span>`
      : `<span class="lb-val">${fmtTime(e.t)}${kind === 'race' && e.bl ? `<em class="lb-sub">最快圈 ${fmtTime(e.bl)}</em>` : ''}</span>`;
    return `
      <div class="lb-row${me ? ' me' : ''}${kind === 'hex' ? ' hex' : ''}">
        <span class="lb-rank${i < 3 ? ` r${i + 1}` : ''}">${i + 1}</span>
        <span class="lb-ava">${avatarMarkup(e.a, false)}</span>
        <span class="lb-name">${esc(e.n)}${me ? '<em class="lb-you">你</em>' : ''}</span>
        <span class="lb-boat">${esc(boat)}</span>
        ${val}
      </div>`;
  }

  #mineBlock(key, kind) {
    const m = this.#mine(key);
    const label = kind === 'hex'
      ? (m ? `通过 ${Number(m.c) || 0} 关 · ${fmtTime(m.t)}` : '未上榜')
      : (m ? fmtTime(m.t) : '未上榜');
    const hint = m ? esc(getBoat(m.b)?.name || '') : '打完一局就会自动记录';
    return `<div class="lb-mine"><span>我的最好成绩</span><b>${label}</b><em>${hint}</em></div>`;
  }
}

export const leaderboardPanel = new LeaderboardPanel();
