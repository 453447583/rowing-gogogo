// 右上角玩家面板 = 激流小店（2026-11-25 按 shop_q 稿重做：奶油暖色）。
// 布局：顶栏（品牌/搜索/余额）+ 左侧分类 + 中间页签与商品网格 + 右侧穿搭预览 + 底部信息条。
// 数据一律来自服务器 wallet 消息；单人没有服务器时只读上次联机留下来的本机缓存。

import { SHOP_ITEMS, SHOP_MAP } from '../data/shop.js';
import { audio } from '../audio/AudioEngine.js';
import { accountPanel, clearAccountToken, getAccountToken } from './accountPanel.js';
import * as UI from './ui.js';

const CACHE_KEY = 'rr-wallet-cache';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const AVATAR_FALLBACK = '/icons/avatars/av_wave.png';

function readCache() {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/** 流水时间只留 月-日 时:分，右栏窄，整套 toLocaleString 会撑成两行 */
function shortTime(at) {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export class WalletPanel {
  constructor() {
    this.root = null;
    this.net = null;
    this.view = 'shop';   // shop | bag | log
    this.cat = 'all';     // all | frame | title | ticket
    this.filter = 'all';  // all | afford | owned | equipped
    this.q = '';
    this.picked = '';     // 选中/试穿的商品 key
    this.data = readCache();
    this.getSolo = () => false;
    this.onRename = () => {};
    this.onLuckyItem = () => {};
    this.getName = () => '';
  }

  init(opts = {}) {
    this.net = opts.net || null;
    this.getSolo = opts.getSolo || this.getSolo;
    this.getName = opts.getName || this.getName;
    this.onRename = opts.onRename || this.onRename;
    this.onLuckyItem = opts.onLuckyItem || this.onLuckyItem;
    this.root = document.getElementById('wallet-panel');
    if (!this.root) return this;
    this.root.innerHTML = `
      <div class="ws" role="dialog" aria-label="激流小店">
        <header class="ws-head">
          <div class="ws-brand">
            <span class="ws-logo" aria-hidden="true"></span>
            <div><b>激流小店</b><i data-ws="sub">积分跟着账号走，换电脑也不丢</i></div>
          </div>
          <label class="ws-search">
            <input type="text" data-ws="q" autocomplete="off" spellcheck="false"
              placeholder="输入想找的道具名，比如 浪花框">
            <span>搜 索</span>
          </label>
          <div class="ws-bal"><span class="ws-gem" aria-hidden="true"></span><b data-ws="pts">0</b><i>积分</i></div>
          <button class="ws-x" type="button" data-ws="close" title="关闭（Esc）"></button>
        </header>
        <nav class="ws-nav" data-ws="nav"></nav>
        <div class="ws-tabs" data-ws="tabs"></div>
        <div class="ws-main" data-ws="main"></div>
        <aside class="ws-side" data-ws="side"></aside>
        <footer class="ws-foot" data-ws="foot"></footer>
      </div>`;
    this.root.querySelector('[data-ws="close"]').onclick = () => this.close();
    this.root.addEventListener('mousedown', (e) => { if (e.target === this.root) this.close(); });

    // 搜索只重绘中间那一块，不重建输入框（否则每敲一个字都失焦）
    this.root.addEventListener('input', (e) => {
      if (e.target?.dataset?.ws !== 'q') return;
      this.q = e.target.value || '';
      if (this.view !== 'shop') { this.view = 'shop'; this.#render(); return; }
      this.#renderMain();
    });

    this.root.addEventListener('click', (e) => {
      const t = e.target.closest?.('[data-ws-cat]');
      if (t) {
        this.cat = t.dataset.wsCat;
        this.filter = 'all';
        this.view = 'shop';
        audio.play('uiClick', { gap: 0 });
        this.#render();
        return;
      }
      const v = e.target.closest?.('[data-ws-view]');
      if (v) {
        this.view = v.dataset.wsView;
        this.picked = '';   // 换页就别留着上一页的试穿态
        audio.play('uiClick', { gap: 0 });
        this.#render();
        return;
      }
      const tab = e.target.closest?.('[data-ws-filter]');
      if (tab) {
        this.filter = tab.dataset.wsFilter;
        audio.play('uiClick', { gap: 0 });
        this.#render();
        return;
      }
      const buy = e.target.closest?.('[data-ws-buy]');
      if (buy) { this.#send('shopBuy', { item: buy.dataset.wsBuy }); return; }
      const equip = e.target.closest?.('[data-ws-equip]');
      if (equip) { this.#send('shopEquip', { item: equip.dataset.wsEquip, slot: equip.dataset.wsSlot }); return; }
      const pick = e.target.closest?.('[data-ws-pick]');
      if (pick) {
        this.picked = this.picked === pick.dataset.wsPick ? '' : pick.dataset.wsPick;
        audio.play('uiClick', { gap: 0 });
        this.#render();
        return;
      }
      if (e.target.closest?.('[data-ws="rename"]')) { this.close(); this.onRename(); return; }
      if (e.target.closest?.('[data-ws="log"]')) { this.view = 'log'; this.picked = ''; this.#render(); return; }
      // 退出登录：token / 钱包缓存 / 昵称一起清掉，刷新后右上角如实显示「请登录」，
      // 不能再留着上一个账号的名字和积分。
      if (e.target.closest?.('[data-ws="logout"]')) {
        clearAccountToken();
        this.data = null;
        try {
          localStorage.removeItem('rr-wallet-cache');
          localStorage.removeItem('rr-name');
        } catch { /* 隐私模式忽略 */ }
        location.reload();
      }
    });

    this.net?.on?.('wallet', (e) => this.#accept(e.detail));
    this.net?.on?.('luckyItem', (e) => {
      if (!e.detail?.ok) return;
      this.onLuckyItem(e.detail?.item || 'hex_ticket');
    });
    this.updateChip();
    return this;
  }

  get isOpen() {
    return !!this.root && !this.root.classList.contains('hidden');
  }

  open(view) {
    if (!this.root) return;
    // 没登录不开商城：积分 / 商店 / 背包都跟着账号走，先过登录这一关，
    // 登录成功后自动接着打开玩家面板（避免"退出登录还能看到上个号的商店"）。
    if (!getAccountToken()) {
      accountPanel.show(() => this.open(view));
      return;
    }
    if (view) this.view = view;
    this.root.classList.remove('hidden');
    this.#render();
    audio.play('uiOpen', { gap: 0 });
    if (!this.getSolo() && this.net?.connected) this.net.send({ t: 'walletGet' });
  }

  close() {
    if (!this.isOpen) return;
    this.root.classList.add('hidden');
    audio.play('uiClose', { gap: 0 });
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  /** 供右上角小 chip 使用，solo 时也能显示上次联机的缓存余额 */
  points() {
    return Math.max(0, Number(this.data?.pts) || 0);
  }

  updateChip() {
    const el = document.getElementById('name-plate-points');
    if (!el) return;
    // 没登录就不显示积分：退出登录后右上角只能看到「请登录」，
    // 不能把上一个账号的余额继续挂在名牌上。
    if (!getAccountToken()) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.textContent = `积分 ${this.points()}`;
  }

  #accept(data) {
    if (!data || typeof data !== 'object') return;
    this.data = data;
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch { /* 隐私模式忽略 */ }
    this.updateChip();
    if (this.isOpen) this.#render();
  }

  #send(t, extra = {}) {
    if (this.getSolo() || !this.net?.connected) {
      UI.toast('积分小店只在联机时可用');
      return;
    }
    this.net.send({ t, ...extra });
  }

  #canBuy() { return !this.getSolo() && !!this.net?.connected; }

  #inv() { return this.data?.inv || {}; }

  #equip() { return this.data?.equip || {}; }

  #owned(key) { return Number(this.#inv()[key]) || 0; }

  #avatar() {
    const img = document.querySelector('#name-plate img, #lobby .lp-av img');
    return img?.getAttribute('src') || AVATAR_FALLBACK;
  }

  /** 当前分类 + 页签 + 搜索词过滤后的商品 */
  #list() {
    const inv = this.#inv();
    const equip = this.#equip();
    const pts = this.points();
    let arr = SHOP_ITEMS.filter((it) => this.cat === 'all' || it.type === this.cat);
    const q = this.q.trim();
    if (q) arr = arr.filter((it) => `${it.name}${it.desc}`.includes(q));
    if (this.filter === 'afford') arr = arr.filter((it) => !(Number(inv[it.key]) > 0) && pts >= it.cost);
    else if (this.filter === 'owned') arr = arr.filter((it) => (Number(inv[it.key]) || 0) > 0);
    else if (this.filter === 'equipped') arr = arr.filter((it) => equip[it.type] === it.key);
    return arr;
  }

  #render() {
    if (!this.root) return;
    const sub = this.root.querySelector('[data-ws="sub"]');
    const pts = this.root.querySelector('[data-ws="pts"]');
    if (pts) pts.textContent = this.points();
    if (sub) {
      const name = this.getName() || '未登录';
      sub.textContent = this.getSolo()
        ? `账号 ${name} · 单人模式只读上次联机的缓存`
        : `账号 ${name} · 积分跟着账号走，换电脑也不丢`;
    }
    this.root.querySelector('[data-ws="nav"]').innerHTML = this.#navView();
    this.root.querySelector('[data-ws="tabs"]').innerHTML = this.#tabsView();
    this.#renderMain();
    this.root.querySelector('[data-ws="side"]').innerHTML = this.#sideView();
    this.root.querySelector('[data-ws="foot"]').innerHTML = this.#footView();
    const q = this.root.querySelector('[data-ws="q"]');
    if (q && q.value !== this.q) q.value = this.q;
  }

  #renderMain() {
    const main = this.root?.querySelector('[data-ws="main"]');
    if (!main) return;
    if (this.view === 'bag') main.innerHTML = `<div class="ws-list">${this.#bagView()}</div>`;
    else if (this.view === 'log') main.innerHTML = `<div class="ws-list">${this.#logView()}</div>`;
    else main.innerHTML = `<div class="ws-grid">${this.#gridView()}</div>`;
  }

  #navView() {
    const counts = SHOP_ITEMS.reduce((m, it) => { m[it.type] = (m[it.type] || 0) + 1; return m; }, {});
    const cats = [
      ['all', '全部道具', '#FF8C61', SHOP_ITEMS.length],
      ['frame', '头像框', '#6FD6C2', counts.frame || 0],
      ['title', '称号', '#FFB36B', counts.title || 0],
      ['ticket', '道具券', '#B9A6F2', counts.ticket || 0],
    ];
    const ownedCount = SHOP_ITEMS.filter((it) => this.#owned(it.key) > 0).length;
    const on = (cond) => (cond ? ' act' : '');
    return `
      <div class="ws-nh">商 品 分 类</div>
      ${cats.map(([id, name, color, n]) => `
        <button class="ws-ni${on(this.view === 'shop' && this.cat === id)}" type="button" data-ws-cat="${id}">
          <span class="dot" style="background:${color}"></span>${name}<em>${n}</em>
        </button>`).join('')}
      <div class="ws-nsep"></div>
      <div class="ws-nh">我 的</div>
      <button class="ws-ni${on(this.view === 'bag')}" type="button" data-ws-view="bag">
        <span class="dot" style="background:#8FD9C0"></span>我的背包<em>${ownedCount}</em>
      </button>
      <button class="ws-ni${on(this.view === 'log')}" type="button" data-ws-view="log">
        <span class="dot" style="background:#FFD166"></span>积分明细
      </button>`;
  }

  #tabsView() {
    if (this.view === 'log') {
      return `<span class="ws-tab act" aria-hidden="true">积分流水</span>
        <span class="ws-tab" aria-hidden="true">最近 12 笔</span>`;
    }
    if (this.view === 'bag') {
      const n = SHOP_ITEMS.filter((it) => this.#owned(it.key) > 0).length;
      return `<span class="ws-tab act" aria-hidden="true">我的背包</span>
        <span class="ws-tab" aria-hidden="true">共 ${n} 件</span>`;
    }
    const filters = [['all', '全 部'], ['afford', '可兑换'], ['owned', '已拥有'], ['equipped', '使用中']];
    return filters.map(([id, name]) => (
      `<button class="ws-tab${this.filter === id ? ' act' : ''}" type="button" data-ws-filter="${id}">${name}</button>`
    )).join('');
  }

  #gridView() {
    const list = this.#list();
    if (!list.length) {
      return `<div class="ws-empty">这个条件下没有商品。<br>换个分类，或者点左侧「全部道具」再看看。</div>`;
    }
    return list.map((it) => this.#cardView(it)).join('');
  }

  #cardView(it) {
    const inv = this.#inv();
    const equip = this.#equip();
    const can = this.#canBuy();
    const pts = this.points();
    const owned = Number(inv[it.key]) || 0;
    const equipped = equip[it.type] === it.key;
    const afford = pts >= it.cost;
    const ticket = it.type === 'ticket';
    const sel = this.picked === it.key;

    let badge = '';
    if (equipped) badge = '<b class="ws-badge own">使用中</b>';
    else if (owned > 0) badge = `<b class="ws-badge own">已拥有 ×${owned}</b>`;
    else if (ticket) badge = '<b class="ws-badge rank">仅道具赛</b>';

    let b1;
    if (equipped) b1 = '<button class="ws-b1" type="button" disabled>使用中</button>';
    else if (owned > 0) b1 = `<button class="ws-b1" type="button" data-ws-equip="${it.key}" data-ws-slot="${it.type}">装 备</button>`;
    else b1 = `<button class="ws-b1" type="button" data-ws-buy="${it.key}" ${can && afford ? '' : 'disabled'}>${afford ? '购 买' : '积分不足'}</button>`;

    const b2 = ticket
      ? '<button class="ws-b2" type="button" disabled>无外观</button>'
      : '<button class="ws-b2" type="button">试 穿</button>';

    const cls = `ws-card${sel ? ' sel' : ''}${equipped ? ' owned' : ''}${owned > 0 || afford ? '' : ' locked'}`;
    return `
      <article class="${cls}" data-ws-pick="${it.key}">
        <div class="ws-top t-${it.type}" style="--c:${it.color || '#D9A06B'}">
          ${badge}
          <div class="ws-art">${this.#art(it)}</div>
        </div>
        <div class="ws-cardbody">
          <div class="ws-name">${esc(it.name)}</div>
          <div class="ws-desc">${esc(it.desc)}</div>
          <div class="ws-price${afford || owned ? '' : ' poor'}"><span class="ws-gem"></span>${it.cost.toLocaleString('en-US')}<i>积分</i></div>
          <div class="ws-btns">${b1}${b2}</div>
        </div>
      </article>`;
  }

  /** 商品插画：框 = 双环 + 四角点，称号 = 铭牌胶囊，券 = 虚线票根 */
  #art(it, size = 108) {
    const c = it.color || '#D9A06B';
    if (it.type === 'title') {
      return `<div class="ws-tpill" style="color:${c}">${esc(it.name)}</div>`;
    }
    if (it.type === 'ticket') {
      const w = Math.round(size * 1.16);
      const h = Math.round(size * 0.7);
      return `<svg viewBox="0 0 200 112" width="${w}" height="${h}" aria-hidden="true">
        <rect x="8" y="18" width="184" height="76" rx="16" fill="#F7F0FF" stroke="#B9A6F2" stroke-width="4"/>
        <path d="M132 22 V90" stroke="#B9A6F2" stroke-width="3" stroke-dasharray="7 7"/>
        <circle cx="132" cy="18" r="9" fill="#F1EAFB" stroke="#B9A6F2" stroke-width="3"/>
        <circle cx="132" cy="94" r="9" fill="#F1EAFB" stroke="#B9A6F2" stroke-width="3"/>
        <text x="46" y="70" font-size="40" font-weight="900" fill="#8E78D9" font-family="Microsoft YaHei, sans-serif">券</text>
        <rect x="146" y="46" width="34" height="6" rx="3" fill="#CDBFF2"/>
        <rect x="146" y="60" width="22" height="6" rx="3" fill="#CDBFF2"/>
      </svg>`;
    }
    return `<svg viewBox="-14 -14 128 128" width="${size}" height="${size}" aria-hidden="true" style="overflow:visible">
      <circle cx="50" cy="50" r="36" fill="#FFEEE0"/>
      <circle cx="12" cy="12" r="4" fill="${c}"/><circle cx="88" cy="12" r="4" fill="${c}"/>
      <circle cx="12" cy="88" r="4" fill="${c}"/><circle cx="88" cy="88" r="4" fill="${c}"/>
      <circle cx="50" cy="50" r="36" fill="none" stroke="${c}" stroke-width="7"/>
      <circle cx="50" cy="50" r="27" fill="none" stroke="${c}" stroke-width="2.5" opacity=".55"/>
    </svg>`;
  }

  #bagView() {
    const q = this.q.trim();
    let items = SHOP_ITEMS.filter((it) => this.#owned(it.key) > 0);
    if (q) items = items.filter((it) => `${it.name}${it.desc}`.includes(q));
    if (!items.length) {
      return `<div class="ws-empty">背包还是空的。<br>去商城换点头像框和称号，或者先打一局赚积分。</div>`;
    }
    const equip = this.#equip();
    return items.map((it) => {
      const equipped = equip[it.type] === it.key;
      return `
      <div class="ws-row" data-ws-pick="${it.key}">
        <div class="ws-art">${this.#art(it, 46)}</div>
        <div class="ws-row-t">
          <b>${esc(it.name)}<em>×${this.#owned(it.key)}</em></b>
          <span>${esc(it.desc)}</span>
        </div>
        ${it.type === 'ticket'
          ? '<span class="ws-tagp">仅联机道具赛</span>'
          : equipped
            ? '<span class="ws-tagp">使用中</span>'
            : `<button class="ws-b1" type="button" data-ws-equip="${it.key}" data-ws-slot="${it.type}">装 备</button>`}
      </div>`;
    }).join('') + '<div class="ws-tail">装备会立刻保存到账号，换电脑登录同一账号仍在</div>';
  }

  #logView() {
    const log = this.data?.log || [];
    if (!log.length) {
      return `<div class="ws-empty">还没有流水。<br>打一局上榜，或者过一层海克斯就能看到第一笔。</div>`;
    }
    return log.map((e) => `
      <div class="ws-logrow">
        <i aria-hidden="true"></i>
        <b>${esc(e.d || e.mode || '积分变动')}</b>
        <span>${shortTime(e.at)}</span>
      </div>`).join('') + '<div class="ws-tail">只保留最近 12 笔积分变动</div>';
  }

  #sideView() {
    const equip = this.#equip();
    const picked = SHOP_MAP[this.picked];
    const frameKey = picked?.type === 'frame' ? picked.key : equip.frame;
    const titleKey = picked?.type === 'title' ? picked.key : equip.title;
    const frame = SHOP_MAP[frameKey];
    const title = SHOP_MAP[titleKey];
    const tickets = this.#owned('hex_ticket');
    const support = this.#owned('hex_support');
    const ticketText = [
      tickets ? `幸运券×${tickets}` : '',
      support ? `支援券×${support}` : '',
    ].filter(Boolean).join(' · ');
    const can = this.#canBuy();

    let act1;
    if (this.view !== 'shop') {
      // 背包 / 明细页没在挑商品，主按钮改成"回商城"，别留一个灰死的按钮
      act1 = `<button class="ws-a1" type="button" data-ws-cat="all">去商城逛逛</button>`;
    } else if (!picked) act1 = '<button class="ws-a1" type="button" disabled>先选一件商品</button>';
    else if (picked.type === 'ticket') {
      const need = picked.cost - this.points();
      act1 = can && need <= 0
        ? `<button class="ws-a1" type="button" data-ws-buy="${picked.key}">兑换 ${esc(picked.name)}</button>`
        : `<button class="ws-a1" type="button" disabled>${can ? `还差 ${need.toLocaleString('en-US')} 积分` : '联机后才能兑换'}</button>`;
    }
    else if (equip[picked.type] === picked.key) act1 = '<button class="ws-a1" type="button" disabled>这件正穿着</button>';
    else if (this.#owned(picked.key) > 0) act1 = `<button class="ws-a1" type="button" data-ws-equip="${picked.key}" data-ws-slot="${picked.type}">穿上 ${esc(picked.name)}</button>`;
    else {
      const need = picked.cost - this.points();
      act1 = can && need <= 0
        ? `<button class="ws-a1" type="button" data-ws-buy="${picked.key}">购买 ${esc(picked.name)}</button>`
        : `<button class="ws-a1" type="button" disabled>${can ? `还差 ${need.toLocaleString('en-US')} 积分` : '联机后才能兑换'}</button>`;
    }

    return `
      <div class="ws-panel">
        <div class="ws-ph"><b>穿搭预览</b><span>${picked ? '试穿中' : '当前装备'}</span></div>
        <div class="ws-stage">
          <div class="ws-plate">
            <span class="ws-av" style="--c:${frame?.color || '#EFC49B'}">
              <img src="${esc(this.#avatar())}" alt="">
            </span>
            <div class="ws-plate-n">${esc(this.getName() || '未命名船长')}</div>
            <i class="ws-plate-t${title ? '' : ' off'}" style="--c:${title?.color || '#B7A393'}">${esc(title?.name || '未装备称号')}</i>
          </div>
        </div>
        <div class="ws-tags">
          <div class="ws-tagline"><span>头像框</span><b>${esc(frame?.name || '未装备')}</b></div>
          <div class="ws-tagline"><span>称 号</span><b>${esc(title?.name || '未装备')}</b></div>
          <div class="ws-tagline"><span>道 具</span><b class="${ticketText ? '' : 'off'}">${ticketText || '无'}</b></div>
        </div>
        <div class="ws-acts">
          ${act1}
          <button class="ws-a2" type="button" data-ws-view="bag">我的背包</button>
          <button class="ws-a3" type="button" data-ws="rename">改 名</button>
        </div>
      </div>`;
  }

  #footView() {
    const ownedCount = SHOP_ITEMS.filter((it) => this.#owned(it.key) > 0).length;
    const equipCount = SHOP_ITEMS.filter((it) => this.#equip()[it.type] === it.key).length;
    return `
      <span class="ws-count">共 <b>${SHOP_ITEMS.length}</b> 件 · 已拥有 <b>${ownedCount}</b> · 使用中 <b>${equipCount}</b></span>
      <span class="ws-spacer"></span>
      <span class="ws-pwd">每日可得上限 300</span>
      <button class="ws-go2" type="button" data-ws="log">积分明细</button>
      <button class="ws-linkbtn" type="button" data-ws="logout">退出登录</button>`;
  }
}

export const walletPanel = new WalletPanel();
