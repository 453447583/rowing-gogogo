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
        hint: '100% 以下降分辨率提帧；125% 是超采样，边缘更干净，但显卡负担明显变重',
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

/**
 * 素材来源分组（2026-11-23 全量盘点）。
 * 证据口径：GLB 内嵌 generator/节点名 + 文档记录（DEV_STATUS / .workbuddy 日志 / docs）。
 * 标签只如实记录状态，不赋予授权：
 *   ok   = 可自由商用（自制或 CC0）
 *   ai   = AI 工具生成（平台条款一般授权可用，留档备查）
 *   warn = 第三方下载、授权未确认 —— 商用前要逐个回原站核对许可
 *   risk = 高风险 —— 疑似他人作品拆包，商用前必须替换
 * 处置规则：NC / Editorial → 替换；CC-BY → 把作者与链接补进对应条目；换掉一个就删一行。
 */
const ASSET_GROUPS = [
  {
    tone: 'ok', label: '可商用', title: '项目自制（脚本 / 代码生成）',
    items: [
      '赛道与场景壳：峡谷、秘境洞穴、云海、回程段（models/canyon/、models/cave/ 全部 GLB）— Blender 脚本生成',
      '带贴图写实道具：近道石牌坊、龙宫石闸门、弯道导向牌、指示浮标、浮标链、金龙过山车套件、弹射台、传送门、旗门、冰山、火山柱、黑曜石、石墙栈桥件、浮雕海鸥像、码头（models/props|track|decor|magma|hazards|shore）',
      '赛艇「牛来号」（cow_rider.glb）— Blender 建模',
      'BOSS 骨骼动画片段（monsters/ 的 dk_*、fd_*、bd_*、whale_shark_spit、dk_hit_fixed 等）— Blender 制作',
      '水面、天空、山脊、雪花、漩涡、倒影等着色器与程序化贴图 — 代码生成，无外部素材',
    ],
  },
  {
    tone: 'ai', label: 'AI 生成', title: 'AI 工具生成（留档备查）',
    note: '生成平台的用户条款一般授权项目方使用；保留这份清单以备平台条款核查。',
    items: [
      '6 艘赛艇（赤焰 / 绯鲨 / 青锋 / 流光 / 琥珀 / 长鲸）与磐石号 — Tripo AI 图生 3D，节点名 tripo_* 可证；经 Blender 轻量化',
      '全部 2D 图标与头像（icons/ 约 218 张：道具、怪物、地图、模式、技能、天气、BOSS、海克斯）— AI 生成交付包，对照表见 public/icons/图标对照表.md',
      '界面背景 menu-bg.jpg / login-bg.jpg 与落日主界面背景 menu-sunset.jpg — 豆包 AI，已去水印',
      'BGM（lobby-theme / race-theme / boss_battle_long）与音效（audio/sfx/ 约 71 条）— 用户交付的 AI 生成素材，规格见 music/SFX使用说明.md；AudioEngine 另有程序化合成兜底',
      'HUD 锻铁贴图 — AI 底图 + scripts/make_iron_tile.mjs 去水印加工',
    ],
  },
  {
    tone: 'ok', label: '可商用', title: 'CC0 / 开源素材',
    items: [
      '实拍贴图（textures/forest、textures/rock：草地、树皮、岩面等）— Poly Haven / ambientCG，CC0',
      'Effekseer 官方特效包 effects/EffectMaterials — CC0（评估记录见 effect-materials-audit.md）；effects/ 其余目录为 Effekseer 官方示例素材 + 项目自制拼装',
      '开源依赖 three.js、Vite、ws、sharp 等 — MIT 许可',
    ],
  },
  {
    tone: 'warn', label: '待确认', title: '第三方下载 · 授权未确认',
    note: 'Sketchfab 下载时未记录许可。商用前逐个回 Sketchfab 下载历史核对：CC0 / CC-BY 可用（CC-BY 需署名，把作者和链接补进这里）；CC-BY-NC 和 Editorial 不可商用，必须替换。',
    items: [
      '场景模型：灯塔两座（lighthouse / old_lighthouse）、维京船、拖网船（mary_chalmers）、木划艇（rowboat）、竞速轻艇（skiff）、游艇、旧船（old_boat）、沉船、珊瑚礁、珊瑚宫、龙门（dragon_gate）、路牌与灯柱、广告牌、卡通鲸（glb/ 另有原始文件）',
      '竞技场巡逻机器人（hazards/hazard_bot*）— 基于 Sketchfab 整场景拆出并重新绑定',
      '巨蟹怪（crab.glb）— 基于 Sketchfab armored_crab 分件绑定，许可继承原模型',
      '火龙（fire_dragon_*）— 用户上传，出处未记录',
    ],
  },
  {
    tone: 'risk', label: '高风险', title: '疑似他人作品 · 商用前必须替换',
    items: [
      '第 5 关 BOSS「深渊传令官」（abyss_herald.glb）— 来自 Sketchfab「Aion boss rigged character」，是网游《Aion》的角色资产拆包，疑似非官方转载，不可商用',
      '血魔小怪（blood_demon_prince.glb）— 材质名 m_boss011，疑似游戏资产，出处未记录',
    ],
  },
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
        <div class="sp-topbar"></div>
        <div class="sp-head">
          <div>
            <div class="sp-title">设置</div>
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
    // 音频页按参考稿用更窄的说明列，让滑杆起点左移；其它页沿用弹性布局，
    // 免得「渲染分辨率」那种长说明被挤成五六行。
    this.paneEl.classList.toggle('sp-pane-audio', tab.id === 'audio');
    if (tab.keys) this.#renderKeys();
    else if (tab.credits) this.#renderCredits();
    else tab.items.forEach((item) => this.paneEl.appendChild(this.#row(item)));
  }

  /** 素材来源：按授权状态分组如实展示，来源不明的标红，方便逐个替换 */
  #renderCredits() {
    const box = document.createElement('div');
    box.className = 'sp-credits';
    const groups = ASSET_GROUPS.map((g) => `
      <div class="sp-credit-group ${g.tone}">
        <div class="sp-credit-head"><i>${g.label}</i><b>${g.title}</b></div>
        ${g.note ? `<p>${g.note}</p>` : ''}
        <ul>${g.items.map((it) => `<li>${it}</li>`).join('')}</ul>
      </div>`).join('');
    box.innerHTML = `
      <p class="sp-credits-lead">素材授权状态盘点（2026-11-23）：标签只记录现状，不代替授权。
      「待确认」的要回原站核对许可，「高风险」的商用前必须替换；换掉一个就删掉对应一行。</p>
      ${groups}`;
    this.paneEl.appendChild(box);
  }

  #row(item) {
    const row = document.createElement('div');
    row.className = 'sp-row';
    if (item.type === 'range') row.classList.add('sp-row-range');
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
    b.className = 'sp-key sp-action';
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

    const paint = (v) => {
      // 青蓝填充比例给 CSS 画轨道用（原生 range 在浅色轨道上几乎看不出进度）
      const p = ((Number(v) - r.min) / (r.max - r.min)) * 100;
      input.style.setProperty('--p', String(Math.max(0, Math.min(100, p))));
    };
    const sync = () => {
      const v = Number(settings.get(item.k));
      input.value = String(v);
      val.textContent = fmt(v);
      paint(v);
    };
    sync();
    // input：只更新数字，拖动时不去写存档（每像素存一次 localStorage 会卡）
    input.oninput = () => {
      val.textContent = fmt(Number(input.value));
      paint(Number(input.value));
    };
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
      b.className = 'sp-key sp-test';
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
