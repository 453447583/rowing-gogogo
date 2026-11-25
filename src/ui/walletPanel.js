// 右上角玩家面板：积分 / 商店 / 明细。UI 先做能用的版本，样式后面可以整块替换。
// 数据一律来自服务器 wallet 消息；单人没有服务器时只读上次联机留下来的本机缓存。

import { SHOP_ITEMS, SHOP_MAP } from '../data/shop.js';
import { audio } from '../audio/AudioEngine.js';
import * as UI from './ui.js';

const CACHE_KEY = 'rr-wallet-cache';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function readCache() {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

export class WalletPanel {
  constructor() {
    this.root = null;
    this.net = null;
    this.tab = 'home';
    this.shopCat = 'all';
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
      <div class="sp-card wp-card" role="dialog" aria-label="玩家面板">
        <div class="sp-head wp-head">
          <div>
            <div class="sp-title wp-title">玩家面板</div>
            <div class="sp-sub wp-sub" data-wp="sub">积分账户 · 跟随账号</div>
          </div>
          <button class="sp-x" type="button" data-wp="close" title="关闭（Esc）"></button>
        </div>
        <div class="sp-body wp-body">
          <div class="sp-tabs wp-tabs" data-wp="tabs"></div>
          <div class="sp-pane wp-pane" data-wp="pane"></div>
        </div>
      </div>`;
    this.root.querySelector('[data-wp="close"]').onclick = () => this.close();
    this.root.addEventListener('mousedown', (e) => { if (e.target === this.root) this.close(); });
    this.root.addEventListener('click', (e) => {
      const tab = e.target.closest?.('[data-wp-tab]');
      if (tab) {
        this.tab = tab.dataset.wpTab;
        audio.play('uiClick', { gap: 0 });
        this.#render();
        return;
      }
      const cat = e.target.closest?.('[data-wp-cat]');
      if (cat) {
        this.shopCat = cat.dataset.wpCat;
        audio.play('uiClick', { gap: 0 });
        this.#render();
        return;
      }
      const rename = e.target.closest?.('[data-wp="rename"]');
      if (rename) { this.close(); this.onRename(); return; }
      const buy = e.target.closest?.('[data-wp-buy]');
      if (buy) { this.#send('shopBuy', { item: buy.dataset.wpBuy }); return; }
      const equip = e.target.closest?.('[data-wp-equip]');
      if (equip) { this.#send('shopEquip', { item: equip.dataset.wpEquip, slot: equip.dataset.wpSlot }); }
    });

    this.net?.on?.('wallet', (e) => this.#accept(e.detail));
    this.net?.on?.('luckyItem', (e) => {
      if (!e.detail?.ok) return;
      this.onLuckyItem();
    });
    this.updateChip();
    return this;
  }

  get isOpen() {
    return !!this.root && !this.root.classList.contains('hidden');
  }

  open() {
    if (!this.root) return;
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
    if (el) el.textContent = `积分 ${this.points()}`;
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
      UI.toast('积分商店只在联机时可用');
      return;
    }
    this.net.send({ t, ...extra });
  }

  #canBuy() { return !this.getSolo() && !!this.net?.connected; }

  #render() {
    if (!this.root) return;
    const tabsEl = this.root.querySelector('[data-wp="tabs"]');
    const paneEl = this.root.querySelector('[data-wp="pane"]');
    const subEl = this.root.querySelector('[data-wp="sub"]');
    if (subEl) {
      subEl.textContent = this.getSolo()
        ? `上次联机缓存 · ${this.getName() || '未登录'}`
        : `账号 ${this.getName() || '未登录'} · 换电脑登录同一个账号不丢积分`;
    }
    const tabs = [['home', '我的'], ['shop', '商店'], ['log', '明细']];
    tabsEl.innerHTML = tabs.map(([id, name]) => (
      `<button class="sp-tab wp-tab${id === this.tab ? ' on' : ''}" type="button" data-wp-tab="${id}">${name}</button>`
    )).join('');
    if (this.tab === 'home') paneEl.innerHTML = this.#homeView();
    else if (this.tab === 'shop') paneEl.innerHTML = this.#shopView();
    else paneEl.innerHTML = this.#logView();
  }

  #homeView() {
    const d = this.data || {};
    const inv = d.inv || {};
    const equip = d.equip || {};
    const frame = SHOP_MAP[equip.frame];
    const title = SHOP_MAP[equip.title];
    const items = SHOP_ITEMS.filter((it) => (Number(inv[it.key]) || 0) > 0);
    return `
      <div class="wp-hero">
        <div class="wp-balance"><span>可用积分</span><b>${this.points()}</b></div>
        <div class="wp-equipped">
          <div><i>头像框</i><span style="--wp-color:${frame?.color || '#6d95a6'}">${esc(frame?.name || '未装备')}</span></div>
          <div><i>称号</i><span>${esc(title?.name || '未装备')}</span></div>
        </div>
        <button class="wood-btn small" type="button" data-wp="rename"><span>改名</span></button>
      </div>
      <div class="wp-sec">背包</div>
      ${items.length ? items.map((it) => `
        <div class="sp-row wp-row">
          <div class="sp-label"><b>${esc(it.name)} ×${inv[it.key]}</b><i>${esc(it.desc)}</i></div>
          <div class="sp-ctl">
            ${it.type === 'ticket'
              ? '<span class="wp-tag">仅联机道具赛</span>'
              : `<button class="wood-btn small" type="button" data-wp-equip="${it.key}" data-wp-slot="${it.type}"><span>装备</span></button>`}
          </div>
        </div>`).join('') : '<div class="wp-empty">还没有兑换物品。竞速上榜、海克斯过层、天梯到达新层都能赚积分。</div>'}
      <div class="wp-hint">改名不会丢积分：钱包跟着账号走，不跟昵称走；换电脑用同一个账号登录即可。</div>`;
  }

  #shopView() {
    const can = this.#canBuy();
    const cats = [
      ['all', '全部'], ['frame', '头像框'], ['title', '称号'], ['ticket', '道具券'],
    ];
    const inv = this.data?.inv || {};
    const equip = this.data?.equip || {};
    const list = SHOP_ITEMS.filter((it) => this.shopCat === 'all' || it.type === this.shopCat);
    return `
      <div class="wp-shop-top">
        <div class="wp-hint wp-hint-top">${can
          ? '服务器校验余额，兑换后立即到账。物品单独展示，下面是所需积分。'
          : '单人模式只读缓存；积分商店需要联机。'}</div>
        <div class="wp-cats">${cats.map(([id, name]) => (
          `<button class="wp-cat${id === this.shopCat ? ' on' : ''}" type="button" data-wp-cat="${id}">${name}</button>`
        )).join('')}</div>
      </div>
      <div class="wp-grid">
        ${list.map((it) => {
          const afford = this.points() >= it.cost;
          const owned = Number(inv[it.key]) || 0;
          const equipped = equip[it.type] === it.key;
          const preview = it.type === 'frame'
            ? `<span class="wp-frame-preview" style="border-color:${it.color || '#7fe0c8'}"><i></i></span>`
            : it.type === 'title'
              ? `<span class="wp-title-preview" style="color:${it.color || '#7fe0c8'}">${esc(it.name)}</span>`
              : '<span class="wp-ticket-preview">券</span>';
          const action = it.type === 'ticket'
            ? `<button class="wood-btn small" type="button" data-wp-buy="${it.key}" ${can && afford ? '' : 'disabled'}><span>兑换</span></button>`
            : equipped
              ? '<span class="wp-owned">已装备</span>'
              : owned > 0
                ? `<button class="wood-btn small" type="button" data-wp-equip="${it.key}" data-wp-slot="${it.type}"><span>装备</span></button>`
                : `<button class="wood-btn small" type="button" data-wp-buy="${it.key}" ${can && afford ? '' : 'disabled'}><span>兑换</span></button>`;
          return `
          <div class="wp-item-card${equipped ? ' equipped' : ''}">
            <div class="wp-preview">${preview}</div>
            <div class="wp-item-name">${esc(it.name)}</div>
            <div class="wp-item-desc">${esc(it.desc)}</div>
            <div class="wp-item-foot">
              <span class="wp-price${afford || owned ? '' : ' poor'}">${it.cost} 积分</span>
              ${action}
            </div>
          </div>`;
        }).join('')}
      </div>`;
  }

  #logView() {
    const log = this.data?.log || [];
    return `
      <div class="wp-sec">最近积分流水</div>
      ${log.length ? log.map((e) => `
        <div class="sp-row wp-row">
          <div class="sp-label"><b>${esc(e.d || e.mode || '积分变动')}</b></div>
          <div class="sp-ctl"><span class="wp-time">${e.at ? new Date(e.at).toLocaleString() : '—'}</span></div>
        </div>`).join('') : '<div class="wp-empty">还没有流水。打一局就能看到第一笔。</div>'}`;
  }
}

export const walletPanel = new WalletPanel();
