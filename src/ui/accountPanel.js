// 账号面板：登录 / 注册 / 备用码重置。用户选择"进游戏强制登录"，所以入口按钮先过这一关。
// 密码只发给服务器存盐 + scrypt 哈希；前端保存的只有登录 token。

import * as UI from './ui.js';
import { audio } from '../audio/AudioEngine.js';

const TOKEN_KEY = 'rr-account-token';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function getAccountToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

export function saveAccountToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token || ''); } catch { /* 隐私模式忽略 */ }
}

export function clearAccountToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
}

export class AccountPanel {
  constructor() {
    this.root = null;
    this.mode = 'login';
    this.pending = null;
    this.onSuccess = () => {};
  }

  init(opts = {}) {
    this.onSuccess = opts.onSuccess || this.onSuccess;
    this.root = document.getElementById('account-panel');
    if (!this.root) return this;
    this.root.innerHTML = `
      <div class="sp-card ac-card" role="dialog" aria-label="账号登录">
        <div class="sp-head ac-head">
          <div>
            <div class="sp-title ac-title">激流勇进账号</div>
            <div class="sp-sub">积分与兑换物品跟随账号，换电脑不丢</div>
          </div>
        </div>
        <div class="sp-body ac-body">
          <div class="sp-tabs ac-tabs" data-ac="tabs"></div>
          <div class="sp-pane ac-pane" data-ac="pane"></div>
        </div>
      </div>`;
    this.root.addEventListener('click', (e) => {
      const tab = e.target.closest?.('[data-ac-tab]');
      if (tab) { this.mode = tab.dataset.acTab; audio.play('uiClick', { gap: 0 }); this.#render(); return; }
      const submit = e.target.closest?.('[data-ac="submit"]');
      if (submit) { this.#submit(); return; }
      const again = e.target.closest?.('[data-ac="again"]');
      if (again) { this.backupCode = ''; this.#render(); }
    });
    this.#render();
    return this;
  }

  get isOpen() { return !!this.root && !this.root.classList.contains('hidden'); }

  show(pending = null) {
    if (!this.root) return;
    this.pending = pending;
    this.root.classList.remove('hidden');
    audio.play('uiOpen', { gap: 0 });
    this.#render();
  }

  hide() {
    if (!this.root) return;
    this.root.classList.add('hidden');
    audio.play('uiClose', { gap: 0 });
  }

  async #submit() {
    const user = this.root.querySelector('[data-ac="user"]')?.value.trim() || '';
    const pass = this.root.querySelector('[data-ac="pass"]')?.value || '';
    const code = this.root.querySelector('[data-ac="code"]')?.value.trim() || '';
    const btn = this.root.querySelector('[data-ac="submit"]');
    if (btn) btn.disabled = true;
    try {
      const action = this.mode === 'register' ? 'register' : this.mode === 'reset' ? 'reset' : 'login';
      const body = action === 'reset' ? { user, code, pass } : { user, pass };
      const r = await fetch(`/auth/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!out?.ok) { UI.toast(out?.error || '操作失败'); return; }
      saveAccountToken(out.token);
      this.hide();
      this.onSuccess?.(out);
      const fn = this.pending;
      this.pending = null;
      if (fn) fn();
      if (out.backupCode) {
        this.backupCode = out.backupCode;
        this.backupUser = user;
        this.mode = 'register';
        this.#render();
      }
    } catch (err) {
      UI.toast('连接账号服务器失败：' + (err?.message || '未知错误'));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  #render() {
    if (!this.root) return;
    const tabsEl = this.root.querySelector('[data-ac="tabs"]');
    const paneEl = this.root.querySelector('[data-ac="pane"]');
    const tabs = [['login', '登录'], ['register', '注册'], ['reset', '备用码找回']];
    tabsEl.innerHTML = tabs.map(([id, name]) => (
      `<button class="sp-tab ac-tab${id === this.mode ? ' on' : ''}" type="button" data-ac-tab="${id}">${name}</button>`
    )).join('');
    if (this.backupCode) {
      paneEl.innerHTML = `
        <div class="ac-ok">
          <div class="ac-ok-t">注册成功</div>
          <p>请立刻保存这枚一次性备用码，它只能用来重置一次密码：</p>
          <div class="ac-code">${esc(this.backupCode)}</div>
          <p class="ac-hint">账号：${esc(this.backupUser || '')}。离开这个页面后不会再显示。</p>
          <button class="wood-btn small" type="button" data-ac="again"><span>我已保存</span></button>
        </div>`;
      return;
    }
    const isReset = this.mode === 'reset';
    paneEl.innerHTML = `
      <div class="ac-form">
        <label>用户名<input data-ac="user" type="text" maxlength="16" autocomplete="username" placeholder="3~16 位，中文/字母/数字"></label>
        ${isReset ? '<label>备用码<input data-ac="code" type="text" maxlength="16" autocomplete="off" placeholder="注册时保存的一次性备用码"></label>' : ''}
        <label>${isReset ? '新密码' : '密码'}<input data-ac="pass" type="password" maxlength="32" autocomplete="${isReset ? 'new-password' : 'current-password'}" placeholder="6~32 位"></label>
        <button class="wood-btn small ac-submit" type="button" data-ac="submit"><span>${isReset ? '重置并登录' : this.mode === 'register' ? '注册并登录' : '登录'}</span></button>
        <p class="ac-hint">${isReset
          ? '备用码用过后立即作废；忘记密码且没有备用码时无法自助找回。'
          : '强制登录：不登录无法进入游戏。积分和物品跟随账号，不再跟本机绑定。'}</p>
      </div>`;
  }
}

export const accountPanel = new AccountPanel();
