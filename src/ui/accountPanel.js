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
      <div class="ac-card" role="dialog" aria-label="账号登录">
        <div class="ac-phead">
          <div>
            <div class="ac-t1">激流勇进账号</div>
            <div class="ac-t2">积分与兑换物品跟着账号走，换电脑登录也不会丢</div>
          </div>
          <button class="ac-x" type="button" data-ac="close" title="返回主界面（不登录进不了游戏）">✕</button>
        </div>
        <div class="ac-body">
          <div class="ac-navs" data-ac="tabs"></div>
          <div class="ac-pane" data-ac="pane"></div>
        </div>
      </div>`;
    this.root.addEventListener('click', (e) => {
      const tab = e.target.closest?.('[data-ac-tab]');
      if (tab) { this.mode = tab.dataset.acTab; audio.play('uiClick', { gap: 0 }); this.#render(); return; }
      const close = e.target.closest?.('[data-ac="close"]');
      if (close) { this.pending = null; this.backupCode = ''; this.hide(); return; }
      // 小眼睛：切换密码明文，避免手机上输错又看不到
      const eye = e.target.closest?.('[data-ac="eye"]');
      if (eye) {
        const p = this.root.querySelector('[data-ac="pass"]');
        if (p) {
          p.type = p.type === 'password' ? 'text' : 'password';
          eye.classList.toggle('on', p.type === 'text');
        }
        return;
      }
      const submit = e.target.closest?.('[data-ac="submit"]');
      if (submit) { this.#submit(); return; }
      const again = e.target.closest?.('[data-ac="again"]');
      if (again) {
        // 备用码这一屏是「看完才继续」：玩家点掉它，才接着执行原先进游戏的动作
        this.backupCode = '';
        const fn = this.pending;
        this.pending = null;
        this.hide();
        if (fn) fn();
      }
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
    // 只改 span 里的字：wood-btn 的排版靠 span，整块 textContent 覆盖会把样式冲掉
    const btnText = btn?.querySelector('span') || btn;
    const label = btnText?.textContent || '';
    const action = this.mode === 'register' ? 'register' : this.mode === 'reset' ? 'reset' : 'login';

    // 先做本地校验：不合格直接说明原因，别等服务器回包（旧版这里是"点了没反应"）
    if (!user) { this.#error('请先填用户名'); return; }
    if (this.mode === 'register' && !/^[\u4e00-\u9fa5A-Za-z0-9_]{3,16}$/.test(user)) {
      this.#error('用户名要 3~16 位，只能用中文 / 字母 / 数字 / 下划线');
      return;
    }
    if (this.mode === 'reset' && !code) { this.#error('请填注册时保存的一次性备用码'); return; }
    if (pass.length < 6 || pass.length > 32) { this.#error('密码要 6~32 位'); return; }

    this.#error('');
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = '处理中…';
    try {
      const body = action === 'reset' ? { user, code, pass } : { user, pass };
      const r = await fetch(`/auth/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // 不是游戏服务器（比如开着 vite 开发服务器）时这里会拿到 404 / HTML，
      // 以前直接 .json() 抛异常，玩家只看到"点了没反应"。
      const text = await r.text();
      let out = null;
      try { out = JSON.parse(text); } catch { out = null; }
      if (!out) {
        this.#error(r.status === 404
          ? '这台服务器还没有账号接口（多半是旧进程）：请关掉服务器窗口，重新运行「启动服务器.bat」或 npm run server，再刷新页面。'
          : `服务器返回了非预期的内容（HTTP ${r.status}），请重启服务器后重试。`);
        return;
      }
      if (!out.ok) { this.#error(out.error || '操作失败'); return; }
      saveAccountToken(out.token);
      this.onSuccess?.(out);
      // 注册会给一枚一次性备用码：必须让玩家先看到它再进游戏。
      // 以前是"先 hide() 再渲染备用码"，码画在隐藏面板里，玩家永远拿不到。
      if (out.backupCode) {
        this.backupCode = out.backupCode;
        this.backupUser = user;
        this.mode = 'register';
        this.#render();
        return; // 等玩家点「我已保存」，由点击回调接着进游戏
      }
      this.hide();
      const fn = this.pending;
      this.pending = null;
      if (fn) fn();
    } catch (err) {
      this.#error(`连不上账号服务器（${err?.message || '网络错误'}）。确认服务器窗口还开着，再刷新页面重试。`);
    } finally {
      const b = this.root.querySelector('[data-ac="submit"]');
      if (b) b.disabled = false;
      const t = this.root.querySelector('[data-ac="submit"] span');
      if (t) t.textContent = label;
    }
  }

  /** 面板内的错误行：比角落 toast 更容易被看到，也不会被自动消失 */
  #error(msg) {
    const el = this.root?.querySelector('[data-ac="err"]');
    if (el) {
      el.textContent = msg || '';
      el.classList.toggle('on', !!msg);
    }
  }

  #render() {
    if (!this.root) return;
    const tabsEl = this.root.querySelector('[data-ac="tabs"]');
    const paneEl = this.root.querySelector('[data-ac="pane"]');
    const tabs = [['login', '登 录'], ['register', '注 册'], ['reset', '备用码找回']];
    tabsEl.innerHTML = tabs.map(([id, name]) => (
      `<button class="ac-nav${id === this.mode ? ' act' : ''}" type="button" data-ac-tab="${id}">${name}</button>`
    )).join('');
    if (this.backupCode) {
      paneEl.innerHTML = `
        <div class="ac-ok">
          <div class="ac-ok-t">注册成功</div>
          <p>请立刻保存这枚一次性备用码，它只能用来重置一次密码：</p>
          <div class="ac-code">${esc(this.backupCode)}</div>
          <p class="ac-note">账号：${esc(this.backupUser || '')}。离开这个页面后不会再显示。</p>
          <button class="wood-btn small" type="button" data-ac="again"><span>我已保存</span></button>
        </div>`;
      return;
    }
    const isReset = this.mode === 'reset';
    paneEl.innerHTML = `
      <div class="ac-form">
        <div class="ac-lab">用户名</div>
        <div class="ac-field"><input data-ac="user" type="text" maxlength="16" autocomplete="username" placeholder="3~16 位，中文/字母/数字"></div>
        ${isReset ? '<div class="ac-lab">备用码</div><div class="ac-field"><input data-ac="code" type="text" maxlength="16" autocomplete="off" placeholder="注册时保存的一次性备用码"></div>' : ''}
        <div class="ac-lab">${isReset ? '新密码' : '密码'}</div>
        <div class="ac-field">
          <input data-ac="pass" type="password" maxlength="32" autocomplete="${isReset ? 'new-password' : 'current-password'}" placeholder="6~32 位">
          <button class="ac-eye" type="button" data-ac="eye" title="显示 / 隐藏密码" aria-label="显示密码"></button>
        </div>
        <div class="ac-row">
          <button class="ac-btn" type="button" data-ac="submit"><span>${isReset ? '重置并登录' : this.mode === 'register' ? '注册并登录' : '登 录'}</span></button>
          <div class="ac-hint">${isReset ? '备用码用一次即作废' : this.mode === 'register' ? '注册即送备用码' : '首次登录自动建号'}</div>
        </div>
        <div class="ac-err" data-ac="err" role="alert"></div>
        <p class="ac-note">${isReset
          ? '· 备用码用过后立即作废；忘记密码且没有备用码时无法自助找回。'
          : this.mode === 'register'
            ? '· 注册后会给你一枚一次性备用码，请自己保存好 —— 忘记密码时只能靠它重置。'
            : '· 同一个账号在任何设备都能接着玩，积分不会被清空。'}</p>
      </div>`;
  }
}

export const accountPanel = new AccountPanel();
