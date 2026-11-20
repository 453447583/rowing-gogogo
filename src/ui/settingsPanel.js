// 设置面板：深海玻璃风格，游戏居中，720×560 上限。
//
// 设计取舍：
//   ① **面板由 schema 生成**，不是手写 HTML。加一个设置项只改 TABS 一行，
//      不用同时改 html / css / 绑定三处（以前做大厅设置栏就是这么漏的）。
//   ② 改了立刻生效（不等"应用"），符合玩家对网页游戏的预期；
//      「恢复默认」是一次性写回全部默认值并广播 `*`。
//   ③ 打开时**冻结驾驶输入**（input.setFrozen），但不暂停游戏 ——
//      玩家要求"不要太大遮挡比赛界面"，潜台词是"我改设置的时候比赛还在跑"。
//   ④ 改键用捕获阶段的 keydown 抢在 Input 前面，不然按 W 会一边改键一边开船。
import { settings, SETTINGS_RANGES } from '../settings.js';
import { keyLabel, normCode, RESERVED_CODES } from '../game/Input.js';
import { audio } from '../audio/AudioEngine.js';
import { toast } from './ui.js';
import { clearGhosts, listGhosts } from '../game/GhostStore.js';

/** 可改键的 7 个驾驶动作（顺序即面板顺序） */
export const KEY_ACTIONS = [
  ['throttle', '油门 / 加速', '按住前进'],
  ['brake', '刹车 / 倒车', '按住后退，行船中当刹车'],
  ['left', '左转', ''],
  ['right', '右转', ''],
  ['drift', '漂移（集气）', '按住集气，松开按集气量给 1~2 次喷射'],
  ['nitro', '释放氮气', '集气满格才可用'],
  ['reset', '复位到赛道', '掉出赛道或卡住时用'],
];

const ACTION_NAME = Object.fromEntries(KEY_ACTIONS.map(([k, n]) => [k, n]));

/** 标签页定义 */
const TABS = [
  {
    id: 'video', name: '画面',
    items: [
      {
        k: 'quality', type: 'seg', label: '画质',
        hint: '低档关掉泛光与调色，老机器或集显明显更流畅',
        opts: [['low', '低'], ['medium', '中'], ['high', '高']],
      },
      {
        k: 'renderScale', type: 'range', label: '渲染分辨率',
        hint: '按比例降低内部渲染分辨率再放大，比降画质更保细节，边缘会略软',
        fmt: (v) => `${Math.round(v * 100)}%`,
      },
      {
        k: 'fov', type: 'range', label: '视场角',
        hint: '越大视野越广、速度感越强，也更容易晕',
        fmt: (v) => `${Math.round(v)}°`,
      },
      {
        k: 'shake', type: 'range', label: '镜头震动',
        hint: '震屏与受击抖动的强度。晕 3D 就拉到 0，画面完全稳',
        fmt: (v) => (v <= 0 ? '关' : `${Math.round(v * 100)}%`),
      },
      {
        k: 'autoQuality', type: 'switch', label: '自动降画质',
        hint: '连续 12 秒低于 30fps 时自动降一档，最多降两次。手动设过画质后本局不再自动降',
      },
      {
        k: 'showFps', type: 'switch', label: '显示帧率',
        hint: '左上角实时显示 FPS，排查卡顿用',
      },
    ],
  },
  {
    id: 'audio', name: '音频',
    items: [
      { k: 'volMaster', type: 'range', label: '总音量', hint: '一条总线同时管下面三路', fmt: pct },
      { k: 'volMusic', type: 'range', label: '背景音乐', hint: '四个模式各一套程序化配乐', fmt: pct },
      {
        k: 'volSfx', type: 'range', label: '音效',
        hint: '道具、技能、撞击、结算提示音',
        fmt: pct,
        test: ['item_nitro', '试听'],
      },
      { k: 'volAmbience', type: 'range', label: '环境与引擎', hint: '水声、引擎转速、漂移啸叫', fmt: pct },
      { k: 'mute', type: 'switch', label: '静音', hint: '一键全静音，不影响上面保存的音量' },
    ],
  },
  {
    id: 'ui', name: '界面',
    items: [
      {
        k: 'hudScale', type: 'range', label: 'HUD 尺寸',
        hint: '名次板、速度表、圈数条等比赛信息的整体缩放',
        fmt: (v) => `${Math.round(v * 100)}%`,
      },
      {
        k: 'uiScale', type: 'range', label: '弹窗尺寸',
        hint: '改名、说明、结算等对话框的整体缩放',
        fmt: (v) => `${Math.round(v * 100)}%`,
      },
    ],
  },
  // 选关入口不在这个面板里：它挂在大厅「游戏设置」抽屉的底部（单人怪物模式）。
  // 两套界面的信息结构不同，混在一起玩家会迷路。
  //
  // 幽灵车（影子）2026-11-18 起不再是设置项：它变成大厅里的独立「挑战模式」，
  // 只在那个模式里出现 —— 所以这里没有「显示/隐藏幽灵」开关可留。
  {
    id: 'assist', name: '辅助',
    items: [
      {
        k: 'lapReview', type: 'switch', label: '每圈评价',
        hint: '压线瞬间在屏幕中央偏下闪一句话：快慢多少、哪一段慢了',
      },
      {
        k: 'impactIcon', type: 'switch', label: '失败归因',
        hint: '撞墙 / 撞石 / 被炸后闪一个图标，告诉你这次是怎么慢下来的',
      },
      {
        type: 'button', id: 'ghost-clear', label: '清除挑战影子记录',
        hint: '挑战模式里「这张图 × 这条船」的最快一圈存档。改过赛道或换过船，旧记录本来也会自动作废',
        buttonText: '清除全部',
        onClick: () => {
          const n = listGhosts().length;
          if (!n) return '本来就没有记录';
          clearGhosts();
          return `已清除 ${n} 条`;
        },
      },
    ],
  },
  { id: 'keys', name: '键位', keys: true },
  { id: 'credits', name: '素材来源', credits: true },
];

// 写实道具里非自制的那部分（Sketchfab，CC-BY 必须署名）。
// part 写清用在哪，方便以后换模型时对应删改。
// 目前近道石牌坊、龙宫石闸门、指示浮标都是本项目自建 + 程序化烘焙贴图，
// 不涉及第三方许可；以后往 public/models/props 里加 Sketchfab 模型时在这里补条目。
const CREDITS = [];

const SELF_MADE_PROPS = [
  '近道石牌坊（shortcut_arch.glb）',
  '龙宫石闸门·门框 + 闸板（palace_gate_frame.glb / palace_gate_leaf.glb）',
  '赛道指示浮标·潮流标（flow_marker.glb）',
  '金龙过山车套件·轨枕/背鳍/支撑/龙门环/龙首（coaster_dragon_kit.glb）',
  '弯道导向牌·木柱 + 青铜牌框（guide_sign_post.glb）',
  '浮标链兜底浮筒·红漆/反光带/顶灯（buoy_fallback.glb）',
];

function pct(v) {
  return `${Math.round(v * 100)}%`;
}

export class SettingsPanel {
  constructor() {
    this.root = null;
    this.tab = 'video';
    this.input = null;
    this.onExitRace = null;
    this.canExitRace = () => false;
    this.refreshers = new Map(); // 设置键 → 刷新函数（外部改动时同步控件显示）
    this.captureAction = null;
    this.captureOff = null;
  }

  /**
   * @param {{input:object, onExitRace?:Function, canExitRace?:Function}} opts
   */
  init(opts = {}) {
    this.input = opts.input || null;
    this.onExitRace = opts.onExitRace || null;
    this.canExitRace = opts.canExitRace || (() => false);
    this.root = document.getElementById('settings-panel');
    if (!this.root) return this;
    this.#build();
    // 外部改了设置（性能看门狗自动降档、按键被别的入口改了）→ 同步面板显示
    settings.addEventListener('change', (e) => {
      const k = e.detail?.key;
      if (k === '*') {
        for (const fn of this.refreshers.values()) fn();
        return;
      }
      const fn = this.refreshers.get(k);
      if (fn) fn();
    });
    // 点遮罩空白处关闭
    this.root.addEventListener('mousedown', (e) => {
      if (e.target === this.root) this.close();
    });
    return this;
  }

  get isOpen() {
    return !!this.root && !this.root.classList.contains('hidden');
  }

  open(tabId) {
    if (!this.root) return;
    const tabs = this.#tabs();
    if (tabId && tabs.some((t) => t.id === tabId)) this.tab = tabId;
    if (!tabs.some((t) => t.id === this.tab)) this.tab = tabs[0].id;
    this.root.classList.remove('hidden');
    // 打开就冻结驾驶：否则面板开着，手还压在油门上，船会一路撞到墙上
    this.input?.setFrozen?.(true);
    this.#render();
    audio.play('uiOpen', { gap: 0 });
  }

  close() {
    if (!this.isOpen) return;
    this.#cancelCapture();
    this.root.classList.add('hidden');
    this.input?.setFrozen?.(false);
    audio.play('uiClose', { gap: 0 });
  }

  toggle(tabId) {
    if (this.isOpen) this.close(); else this.open(tabId);
  }

  // ---------- 骨架 ----------

  #build() {
    this.root.innerHTML = `
      <div class="sp-card" role="dialog" aria-label="设置">
        <div class="sp-head">
          <div>
            <div class="sp-title">设 置</div>
            <div class="sp-sub">改完立刻生效 · 随时可以再打开</div>
          </div>
          <button class="sp-x" type="button" data-sp="close" title="关闭（Esc）">✕</button>
        </div>
        <div class="sp-body">
          <div class="sp-tabs" data-sp="tabs"></div>
          <div class="sp-pane" data-sp="pane"></div>
        </div>
        <div class="sp-foot">
          <button class="sp-btn" type="button" data-sp="reset">恢复默认</button>
          <button class="sp-btn danger hidden" type="button" data-sp="exit">退出比赛</button>
          <div class="grow"></div>
          <button class="sp-btn primary" type="button" data-sp="ok">完成</button>
        </div>
      </div>`;
    this.tabsEl = this.root.querySelector('[data-sp="tabs"]');
    this.paneEl = this.root.querySelector('[data-sp="pane"]');
    this.exitBtn = this.root.querySelector('[data-sp="exit"]');

    this.root.querySelector('[data-sp="close"]').onclick = () => this.close();
    this.root.querySelector('[data-sp="ok"]').onclick = () => this.close();
    this.root.querySelector('[data-sp="reset"]').onclick = () => {
      settings.reset();
      this.#render();
      toast('已恢复默认设置');
    };
    this.exitBtn.onclick = () => {
      this.close();
      this.onExitRace?.();
    };
  }

  /** 当前可见页签 */
  #tabs() {
    return TABS;
  }

  #render() {
    this.exitBtn.classList.toggle('hidden', !this.canExitRace());
    // 标签
    const tabs = this.#tabs();
    this.tabsEl.innerHTML = tabs
      .map((t) => `<button class="sp-tab${t.id === this.tab ? ' on' : ''}" type="button" data-tab="${t.id}">${t.name}</button>`)
      .join('');
    this.tabsEl.onclick = (e) => {
      const btn = e.target.closest?.('[data-tab]');
      if (!btn) return;
      this.tab = btn.dataset.tab;
      audio.play('uiClick', { gap: 0 });
      this.#render();
    };
    // 内容
    this.refreshers.clear();
    const tab = tabs.find((t) => t.id === this.tab) || tabs[0];
    this.paneEl.innerHTML = '';
    if (tab.keys) this.#renderKeys();
    else if (tab.credits) this.#renderCredits();
    else tab.items.forEach((item) => this.paneEl.appendChild(this.#row(item)));
  }

  /** 素材来源：CC-BY 要求署名，这里给出作品名、作者、许可与原始链接 */
  #renderCredits() {
    const box = document.createElement('div');
    box.className = 'sp-credits';
    const rows = CREDITS.map((c) => `
      <div class="sp-credit">
        <b>${c.part}</b>
        <a href="${c.url}" target="_blank" rel="noopener noreferrer">${c.name}</a>
        <span>by ${c.author} · ${c.license}</span>
      </div>`).join('');
    const own = SELF_MADE_PROPS.map((t) => `<span>${t}</span>`).join('');
    box.innerHTML = `
      <p class="sp-credits-lead">赛道上带贴图的写实道具：以下为项目内自建的模型与程序化烘焙贴图，可自由使用。</p>
      <div class="sp-credit">${own}</div>
      ${rows}`;
    this.paneEl.appendChild(box);
  }

  #row(item) {
    const row = document.createElement('div');
    row.className = 'sp-row';
    const lab = document.createElement('div');
    lab.className = 'sp-label';
    lab.innerHTML = `<b>${item.label}</b>${item.hint ? `<i>${item.hint}</i>` : ''}`;
    row.appendChild(lab);

    // range 自己带一层 .sp-ctl（滑条 + 数值 + 试听按钮挤在一起），
    // 其余控件只要一个占位容器
    if (item.type === 'range') {
      row.appendChild(this.#range(item));
      return row;
    }
    const ctl = document.createElement('div');
    ctl.className = 'sp-ctl';
    row.appendChild(ctl);
    if (item.type === 'seg') ctl.appendChild(this.#seg(item));
    else if (item.type === 'switch') ctl.appendChild(this.#sw(item));
    else if (item.type === 'button') ctl.appendChild(this.#actionBtn(item));
    return row;
  }

  /**
   * 一次性动作按钮（清除幽灵记录等）。
   * 反馈写在按钮文字上（"已清除 3 条"）再 1.8s 复原 —— 比弹 toast 更贴手，
   * 也不会因为设置了 `pointer-events` 的 HUD 层而吞掉点击。
   */
  #actionBtn(item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-key';
    b.style.minWidth = '132px';
    const idle = item.buttonText || '执行';
    b.textContent = idle;
    b.onclick = () => {
      audio.play('uiClick', { gap: 0 });
      let out = null;
      try {
        out = item.onClick ? item.onClick() : null;
      } catch {
        out = '执行失败';
      }
      b.textContent = out || idle;
      clearTimeout(b._resetT);
      b._resetT = setTimeout(() => { b.textContent = idle; }, 1800);
    };
    return b;
  }

  #seg(item) {
    const box = document.createElement('div');
    box.className = 'sp-seg';
    item.opts.forEach(([val, text]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.val = val;
      b.textContent = text;
      b.onclick = () => {
        settings.set(item.k, val);
        audio.play('uiClick', { gap: 0 });
      };
      box.appendChild(b);
    });
    const sync = () => {
      const cur = settings.get(item.k);
      for (const b of box.children) b.classList.toggle('on', b.dataset.val === cur);
    };
    sync();
    this.refreshers.set(item.k, sync);
    return box;
  }

  #range(item) {
    const r = SETTINGS_RANGES[item.k] || { min: 0, max: 1, step: 0.01 };
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'sp-range';
    input.min = r.min;
    input.max = r.max;
    input.step = r.step;
    const val = document.createElement('span');
    val.className = 'sp-val';
    const fmt = item.fmt || ((v) => String(v));

    const sync = () => {
      const v = Number(settings.get(item.k));
      input.value = String(v);
      val.textContent = fmt(v);
    };
    sync();
    // input：只更新数字，拖动时不去写存档（每像素存一次 localStorage 会卡）
    input.oninput = () => { val.textContent = fmt(Number(input.value)); };
    input.onchange = () => settings.set(item.k, Number(input.value));
    this.refreshers.set(item.k, sync);

    const wrap = document.createElement('div');
    wrap.className = 'sp-ctl';
    wrap.style.gap = '10px';
    wrap.appendChild(input);
    wrap.appendChild(val);

    if (item.test) {
      const [sfx, text] = item.test;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sp-key';
      b.style.minWidth = '56px';
      b.textContent = text;
      b.onclick = () => audio.play(sfx, { gap: 0 });
      wrap.appendChild(b);
    }
    return wrap;
  }

  #sw(item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-sw';
    b.innerHTML = '<i></i>';
    b.onclick = () => {
      settings.set(item.k, !settings.get(item.k));
      audio.play('uiClick', { gap: 0 });
    };
    const sync = () => b.classList.toggle('on', !!settings.get(item.k));
    sync();
    this.refreshers.set(item.k, sync);
    return b;
  }

  // ---------- 键位 ----------

  #renderKeys() {
    for (const [action, name, hint] of KEY_ACTIONS) {
      const row = document.createElement('div');
      row.className = 'sp-row';
      row.innerHTML = `<div class="sp-label"><b>${name}</b>${hint ? `<i>${hint}</i>` : ''}</div>`;
      const ctl = document.createElement('div');
      ctl.className = 'sp-ctl';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sp-key';
      const sync = () => {
        const code = settings.get('keys')[action];
        btn.textContent = this.captureAction === action ? '按下新键…' : keyLabel(code);
        btn.classList.toggle('capture', this.captureAction === action);
      };
      sync();
      btn.onclick = () => this.#startCapture(action, sync);
      ctl.appendChild(btn);
      row.appendChild(ctl);
      this.paneEl.appendChild(row);
    }
    const note = document.createElement('div');
    note.className = 'sp-note';
    note.innerHTML = '<b>改键说明</b>：点一下右边方框再按新键即可；按 Esc 取消。<br>'
      + '方向键（↑↓←→）永远可以当油门和转向，不受这里影响。<br>'
      + '不能绑 Esc / Tab / F1~F12 / Win / Alt —— 这些会打断游戏或弹系统菜单。<br>'
      + '道具槽（Q/W/E/1/2/3）、炮击 J、协同 F、冲刺 K 是分模式的功能键，固定不改。';
    this.paneEl.appendChild(note);
  }

  #startCapture(action, sync) {
    this.#cancelCapture();
    this.captureAction = action;
    sync();
    // 捕获阶段 + stopPropagation：不然按 W 会同时写进 Input，一边改键一边开船
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.code === 'Escape') { this.#cancelCapture(); sync(); return; }
      const code = normCode(e.code || '');
      if (!code) return;
      if (RESERVED_CODES.has(code)) {
        toast('这个键被系统或浏览器占用了，换一个');
        return;
      }
      const used = Object.entries(settings.get('keys'))
        .find(([a, c]) => a !== action && c === code);
      if (used) {
        toast(`「${ACTION_NAME[used[0]] || used[0]}」已经用了这个键，先把它改掉`);
        return;
      }
      settings.setKey(action, code);
      this.#cancelCapture();
      sync();
      toast(`「${ACTION_NAME[action]}」已改为 ${keyLabel(code)}`);
    };
    window.addEventListener('keydown', onKey, true);
    this.captureOff = () => window.removeEventListener('keydown', onKey, true);
  }

  #cancelCapture() {
    if (this.captureOff) this.captureOff();
    this.captureOff = null;
    this.captureAction = null;
  }
}

export const settingsPanel = new SettingsPanel();
