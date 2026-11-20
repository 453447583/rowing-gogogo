// 聊天：大厅「世界频道」面板 + 比赛内「无线电」横条与气泡
//
// 交互约定：
//  - 平时完全不显示，按 Enter 呼出，Esc 可收起
//  - 比赛内打字时冻结驾驶输入；发送（或空回车）后自动收起
//  - 比赛内自己发的是半透明横条（仿无线电），别人的消息是气泡（8 秒淡出，最多 5 条）
//  - 大厅是长方形面板：消息从下往上排，底部是输入框
//  - 练习模式没有网络对端，只做本地回显（发送逻辑由 main.js 决定）
import { audio } from '../audio/AudioEngine.js';

const MAX_TEXT = 60;
const BUBBLE_MS = 8000;
const BUBBLE_FADE_MS = 600;
const MAX_BUBBLES = 5;
const BAR_MS = 5000;
const BAR_FADE_MS = 450;
const MAX_BARS = 2;
const MAX_LOBBY_ROWS = 80;

export class ChatUI {
  constructor({ input, getName, onSend } = {}) {
    this.input = input;
    this.getName = typeof getName === 'function' ? getName : () => '玩家';
    this.onSend = typeof onSend === 'function' ? onSend : () => {};

    this.lobbyOpen = false;
    this.gameOpen = false;
    this.idleTimer = null;
    this.bars = [];
    this.bubbles = [];
    // 组队赛制下才有队伍频道；其余情况只有全部频道
    this.channel = 'all';
    this.teamAvailable = false;
    this.teamName = '队伍';

    this.#build();
    this.#syncChannels();
    // 捕获阶段先拿到 Enter / Esc：比 main.js 的「Esc 打开设置」更优先
    window.addEventListener('keydown', this.#onKeyDown, true);
  }

  /**
   * 组队赛制开关与队名。大厅 / 比赛都由 main.js 在 roster、开赛、回大厅时调用。
   * available=false 时会自动切回「全部」频道。
   */
  setTeamInfo({ available = false, teamName = '队伍' } = {}) {
    const wasAvailable = this.teamAvailable;
    this.teamAvailable = !!available;
    this.teamName = teamName || '队伍';
    if (!this.teamAvailable) this.channel = 'all';
    // 刚进入组队赛制时默认落在队伍频道（PRD：组队默认队伍）
    else if (!wasAvailable) this.channel = 'team';
    this.#syncChannels();
  }

  /** 当前可用聊天的界面；结算/领奖台等界面返回 null（不响应 Enter） */
  get screen() {
    const hud = document.getElementById('hud');
    if (hud && !hud.classList.contains('hidden')) {
      // 冲线后（结算期）左下已经让位给成绩信息，不再响应聊天
      if (hud.classList.contains('finish-mode')) return null;
      const fp = document.getElementById('finish-panel');
      if (fp && !fp.classList.contains('hidden')) return null;
      return 'game';
    }
    const lobby = document.getElementById('lobby');
    if (lobby && !lobby.classList.contains('hidden')) return 'lobby';
    return null;
  }

  // ---------- DOM ----------
  #build() {
    const root = document.createElement('div');
    root.id = 'chat-root';
    root.innerHTML = `
      <section id="chat-lobby" aria-label="聊天频道">
        <header class="chat-head">
          <span class="chat-title" id="chat-lobby-title" data-ch="all">世界频道</span>
          <span class="chat-chans" id="chat-lobby-chans">
            <button class="chat-chan-tab selected" data-ch="all" type="button">世界</button>
            <button class="chat-chan-tab" data-ch="team" type="button">队伍</button>
          </span>
          <span class="chat-tip">Enter 发送 · Esc 收起</span>
        </header>
        <div id="chat-lobby-log" role="log" aria-live="polite"></div>
        <label class="chat-line">
          <span class="chat-chan" id="chat-lobby-chan" role="button" title="点击切换 世界 / 队伍">（世界）</span>
          <input id="chat-lobby-input" type="text" maxlength="${MAX_TEXT}"
            autocomplete="off" spellcheck="false" placeholder="说点什么…" />
        </label>
      </section>

      <div id="chat-bubbles" aria-live="polite"></div>
      <div id="chat-game-log"></div>
      <label id="chat-game-bar">
        <span class="chat-chan" id="chat-game-chan" role="button" title="点击切换 全部 / 队伍">（全部）</span>
        <span class="chat-name" id="chat-game-name">我</span>
        <span class="chat-colon">：</span>
        <input id="chat-game-input" type="text" maxlength="${MAX_TEXT}"
          autocomplete="off" spellcheck="false" />
      </label>
    `;
    document.getElementById('ui-root')?.appendChild(root);

    this.root = root;
    this.lobbyEl = root.querySelector('#chat-lobby');
    this.lobbyLog = root.querySelector('#chat-lobby-log');
    this.lobbyInput = root.querySelector('#chat-lobby-input');
    this.lobbyTitle = root.querySelector('#chat-lobby-title');
    this.lobbyChans = root.querySelector('#chat-lobby-chans');
    this.lobbyChan = root.querySelector('#chat-lobby-chan');
    this.bubbleBox = root.querySelector('#chat-bubbles');
    this.gameLog = root.querySelector('#chat-game-log');
    this.gameBar = root.querySelector('#chat-game-bar');
    this.gameName = root.querySelector('#chat-game-name');
    this.gameChan = root.querySelector('#chat-game-chan');
    this.gameInput = root.querySelector('#chat-game-input');

    this.lobbyChans?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ch]');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      this.#setChannel(btn.dataset.ch);
      requestAnimationFrame(() => this.lobbyInput?.focus());
    });
    this.lobbyChan?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#toggleChannel();
      requestAnimationFrame(() => this.lobbyInput?.focus());
    });
    this.gameChan?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.#toggleChannel();
      requestAnimationFrame(() => this.gameInput?.focus());
    });

    this.lobbyInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.#sendLobby(); }
      else this.#clearIdle();
    });
    // 窗口缩放时保持「贴玩家列表上沿」的相对位置
    this._onWinResize = () => this.placeLobby();
    window.addEventListener('resize', this._onWinResize);
    this.lobbyInput?.addEventListener('input', () => this.#clearIdle());
    this.lobbyInput?.addEventListener('focus', () => this.#clearIdle());
    this.lobbyInput?.addEventListener('blur', () => this.#armIdle(6000));
    this.lobbyEl?.addEventListener('mouseenter', () => this.#clearIdle());
    this.lobbyEl?.addEventListener('mouseleave', () => {
      if (document.activeElement !== this.lobbyInput) this.#armIdle(4000);
    });

    this.gameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.#sendGame(); }
    });
  }

  #onKeyDown = (e) => {
    if (e.repeat) return;
    const target = e.target;
    const tag = (target?.tagName || '').toUpperCase();
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!target?.isContentEditable;
    const inChatInput = target === this.lobbyInput || target === this.gameInput;

    if (e.key === 'Escape') {
      if (!this.lobbyOpen && !this.gameOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
      return;
    }
    if (e.key !== 'Enter' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (inChatInput) return;           // 输入框自己的 keydown 已处理发送
    if (typing) return;                // 昵称 / 主机地址等普通输入框
    // 设置面板、木牌弹窗、头像弹窗开着时不抢 Enter
    if (!document.getElementById('settings-panel')?.classList.contains('hidden')) return;
    if (document.querySelector('.wood-dialog:not(.hidden), .av-dialog:not(.hidden)')) return;

    const screen = this.screen;
    if (!screen) return;
    e.preventDefault();
    e.stopPropagation();
    if (screen === 'lobby') this.openLobby(); else this.openGame();
  };

  // ---------- 打开 / 关闭 ----------
  // 位置：贴在玩家列表（.lobby-roster-wrap）上沿、左对齐，不再遮住玩家信息列。
  // 玩家列表高度随人数变化，所以每次打开/名单变化/窗口缩放都要重新量一次。
  // 消息区高度按剩余空间收缩：空间不足（小窗）时最低压到 ~64px，
  // 保证聊天框顶端永远碰不到左上角的「激流勇进」标题。
  placeLobby() {
    if (this.screen !== 'lobby' || !this.lobbyEl) return;
    const lobby = document.getElementById('lobby');
    const roster = lobby?.querySelector('.lobby-roster-wrap');
    if (!lobby || lobby.classList.contains('hidden') || !roster) return;
    const ur = this.root.getBoundingClientRect();
    const rb = roster.getBoundingClientRect();
    const left = Math.max(10, rb.left - ur.left + 12);
    const bottom = Math.max(150, ur.bottom - rb.top + 10);
    this.lobbyEl.style.left = `${left}px`;
    this.lobbyEl.style.bottom = `${bottom}px`;
    // 可用高度 = 玩家列表上沿 到 标题块下沿 之间
    const brand = lobby.querySelector('.lobby-brand');
    let cap = 300;
    if (brand) {
      const bb = brand.getBoundingClientRect();
      cap = Math.max(150, rb.top - bb.bottom - 14);
    }
    const head = this.lobbyEl.querySelector('.chat-head')?.offsetHeight || 34;
    const line = this.lobbyEl.querySelector('.chat-line')?.offsetHeight || 40;
    const logMax = Math.max(40, Math.min(172, cap - head - line - 24));
    this.lobbyLog.style.maxHeight = `${logMax}px`;
    // CSS 里 min-height 优先于 max-height：矮窗收缩时必须把 min-height 一起压下去，
    // 否则面板照样被 92px 的消息区撑高、顶端顶进标题
    this.lobbyLog.style.minHeight = `${Math.min(92, logMax)}px`;
  }

  openLobby() {
    if (this.screen !== 'lobby') return;
    this.#closeGame();
    if (this.lobbyOpen) {
      // 从"自动弹出"切到真正输入：去掉弱化样式，把焦点交回输入框
      this.lobbyEl.classList.remove('peek');
      this.lobbyInput.focus();
      this.#armIdle(12000);
      return;
    }
    this.lobbyOpen = true;
    this.placeLobby();
    this.lobbyEl.classList.add('open');
    this.input?.setFrozen?.(true);
    audio.play('uiOpen', { gap: 0 });
    this.#scrollLog();
    this.#armIdle(12000);
    requestAnimationFrame(() => this.lobbyInput?.focus());
  }

  /**
   * 大厅收到别人的消息时自动弹出面板（peek）：不用按 Enter 也能看到，
   * 但不抢输入焦点、不冻结任何输入，静置一会儿自己收起。
   */
  peekLobby() {
    if (this.screen !== 'lobby') return;
    this.#closeGame();
    if (this.lobbyOpen) { this.#armIdle(8000); return; }
    this.lobbyOpen = true;
    this.placeLobby();
    this.lobbyEl.classList.add('open', 'peek');
    audio.play('uiOpen', { gap: 0 });
    this.#scrollLog();
    this.#armIdle(8000);
  }

  openGame() {
    if (this.screen !== 'game') return;
    this.#closeLobby();
    if (this.gameOpen) return;
    this.gameOpen = true;
    this.gameName.textContent = this.getName();
    this.gameInput.value = '';
    this.gameBar.classList.add('open');
    this.root.classList.add('typing');
    this.input?.setFrozen?.(true);
    requestAnimationFrame(() => this.gameInput?.focus());
  }

  close() {
    this.#closeLobby();
    this.#closeGame();
  }

  /** 切换场景时调用：收起输入框并清空聊天记录 / 气泡 */
  reset() {
    this.close();
    this.lobbyLog.textContent = '';
    this.gameLog.textContent = '';
    for (const b of this.bubbles) clearTimeout(b._timer);
    this.bubbles = [];
    for (const bar of this.bars) clearTimeout(bar._timer);
    this.bars = [];
    this.bubbleBox.textContent = '';
  }

  #closeLobby() {
    if (!this.lobbyOpen) return;
    this.lobbyOpen = false;
    this.#clearIdle();
    this.lobbyEl.classList.remove('open', 'peek');
    this.lobbyInput?.blur();
    this.#releaseFrozen();
  }

  #closeGame() {
    if (!this.gameOpen) return;
    this.gameOpen = false;
    this.gameBar.classList.remove('open');
    this.root.classList.remove('typing');
    this.gameInput?.blur();
    this.#releaseFrozen();
  }

  #releaseFrozen() {
    if (this.lobbyOpen || this.gameOpen) return;
    // 设置面板也要求冻结驾驶，别在这儿擅自解冻
    if (!document.getElementById('settings-panel')?.classList.contains('hidden')) return;
    this.input?.setFrozen?.(false);
  }

  // ---------- 频道切换 ----------
  #setChannel(ch) {
    const next = ch === 'team' && this.teamAvailable ? 'team' : 'all';
    if (next === this.channel) { this.#syncChannels(); return; }
    this.channel = next;
    this.#syncChannels();
  }

  #toggleChannel() {
    if (!this.teamAvailable) return;
    this.channel = this.channel === 'team' ? 'all' : 'team';
    this.#syncChannels();
  }

  #syncChannels() {
    const team = this.channel === 'team' && this.teamAvailable;
    if (!team) this.channel = 'all';
    const label = team ? this.teamName : (this.gameOpen ? '全部' : '世界');
    if (this.lobbyTitle) {
      this.lobbyTitle.textContent = team ? `${this.teamName}频道` : '世界频道';
      this.lobbyTitle.dataset.ch = team ? 'team' : 'all';
    }
    if (this.lobbyChan) this.lobbyChan.textContent = `（${label}）`;
    if (this.gameChan) this.gameChan.textContent = `（${team ? '队伍' : '全部'}）`;
    if (this.lobbyChans) {
      for (const btn of this.lobbyChans.querySelectorAll('[data-ch]')) {
        const ch = btn.dataset.ch;
        // 非组队赛制：直接隐藏队伍页签，避免点了没反应
        btn.classList.toggle('hidden', ch === 'team' && !this.teamAvailable);
        btn.classList.toggle('selected', ch === (team ? 'team' : 'all'));
      }
    }
  }

  // ---------- 发送 ----------
  #sendLobby() {
    const text = String(this.lobbyInput?.value || '').trim().slice(0, MAX_TEXT);
    if (this.lobbyInput) this.lobbyInput.value = '';
    if (!text) { this.close(); return; }
    const channel = this.channel === 'team' ? 'team' : 'all';
    this.#addLobbyRow({ name: this.getName(), text, mine: true, channel });
    this.onSend(text, channel);
    audio.play('uiOpen', { gap: 0 });
    this.#armIdle(6000);
    this.lobbyInput?.focus();
  }

  #sendGame() {
    const text = String(this.gameInput?.value || '').trim().slice(0, MAX_TEXT);
    if (this.gameInput) this.gameInput.value = '';
    this.close();
    if (!text) return;
    const channel = this.channel === 'team' ? 'team' : 'all';
    this.#addBar(this.getName(), text, false, channel);
    this.onSend(text, channel);
  }

  // ---------- 接收 ----------
  receive(msg) {
    const text = String(msg?.text || '').slice(0, MAX_TEXT);
    if (!text) return;
    const name = String(msg?.name || '玩家').slice(0, 10);
    const channel = msg?.channel === 'team' ? 'team' : 'all';
    const screen = this.screen;
    if (screen === 'lobby') {
      // 大厅里别人的消息自动露面，不再要求先按 Enter 打开面板
      if (!this.lobbyOpen) this.peekLobby();
      this.#addLobbyRow({ name, text, channel });
    } else if (screen === 'game') this.#addBubble(name, text, channel);
  }

  /** 系统提示（本地生成），不算玩家发言 */
  system(text) {
    const screen = this.screen;
    if (screen === 'lobby') this.#addLobbyRow({ name: '', text: String(text), system: true });
    else if (screen === 'game') this.#addBar('', String(text), true);
  }

  // ---------- 大厅列表 ----------
  #addLobbyRow({ name, text, mine = false, system = false, channel = 'all' }) {
    const row = document.createElement('div');
    row.className = 'chat-row' + (mine ? ' mine' : '') + (system ? ' sys' : '')
      + (channel === 'team' ? ' team' : '');
    if (system) {
      row.textContent = text;
    } else {
      const n = document.createElement('span');
      n.className = 'cname';
      n.textContent = name;
      const ch = document.createElement('span');
      ch.className = 'cchan';
      ch.textContent = channel === 'team' ? `（${this.teamName}）` : '（世界）';
      const colon = document.createElement('span');
      colon.textContent = '：';
      const body = document.createElement('span');
      body.className = 'ctext';
      body.textContent = text;
      row.append(n, ch, colon, body);
    }
    this.lobbyLog.appendChild(row);
    while (this.lobbyLog.children.length > MAX_LOBBY_ROWS) this.lobbyLog.firstChild.remove();
    this.#scrollLog();
  }

  #scrollLog() {
    if (!this.lobbyLog) return;
    this.lobbyLog.scrollTop = this.lobbyLog.scrollHeight;
  }

  #armIdle(ms) {
    this.#clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (document.activeElement === this.lobbyInput) return;
      if (this.lobbyEl.matches(':hover')) return;
      this.#closeLobby();
    }, ms);
  }

  #clearIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // ---------- 比赛内横条（自己发的） ----------
  #addBar(name, text, system = false, channel = 'all') {
    const bar = document.createElement('div');
    bar.className = 'chat-bar' + (system ? ' sys' : '') + (channel === 'team' ? ' team' : '');
    if (!system) {
      const n = document.createElement('span');
      n.className = 'cname';
      n.textContent = name;
      // 队伍频道才标前缀；全部频道仍只显示「昵称：内容」，保持原来的干净观感
      if (channel === 'team') {
        const ch = document.createElement('span');
        ch.className = 'cchan';
        ch.textContent = '（队伍）';
        bar.appendChild(ch);
      }
      const colon = document.createElement('span');
      colon.textContent = '：';
      const body = document.createElement('span');
      body.className = 'ctext';
      body.textContent = text;
      bar.append(n, colon, body);
    } else {
      bar.textContent = text;
    }
    this.gameLog.appendChild(bar);
    this.bars.push(bar);
    while (this.bars.length > MAX_BARS) this.#dropBar(this.bars[0]);
    const timer = setTimeout(() => this.#dropBar(bar), BAR_MS);
    bar._timer = timer;
  }

  #dropBar(bar) {
    const i = this.bars.indexOf(bar);
    if (i < 0) return;
    this.bars.splice(i, 1);
    clearTimeout(bar._timer);
    bar.classList.add('out');
    setTimeout(() => bar.remove(), BAR_FADE_MS);
  }

  // ---------- 气泡（别人发的） ----------
  #addBubble(name, text, channel = 'all') {
    const b = document.createElement('div');
    b.className = 'chat-bubble' + (channel === 'team' ? ' team' : '');
    const n = document.createElement('span');
    n.className = 'cb-name';
    n.textContent = channel === 'team' ? `${name}（队伍）` : name;
    const body = document.createElement('span');
    body.className = 'cb-text';
    body.textContent = text;
    b.append(n, body);
    this.bubbleBox.appendChild(b);
    this.bubbles.push(b);
    // 超过 5 条：最旧的立刻退场
    while (this.bubbles.length > MAX_BUBBLES) this.#dropBubble(this.bubbles[0], 0);
    b._timer = setTimeout(() => this.#dropBubble(b, BUBBLE_FADE_MS), BUBBLE_MS);
  }

  #dropBubble(b, fadeMs) {
    const i = this.bubbles.indexOf(b);
    if (i < 0) return;
    this.bubbles.splice(i, 1);
    clearTimeout(b._timer);
    b.classList.add('out');
    setTimeout(() => b.remove(), fadeMs);
  }
}
