// 全局设置：**单一数据源 + 版本化存档**。
//
// 为什么单独抽一个文件：
//   ① 设置项被四处消费（PostFx 要画质/分辨率、Game 要 FOV/抖动/帧率上限、
//      audio 要四条音量、UI 要 HUD 尺寸、Input 要键位），如果每个模块各自读
//      localStorage，键名迟早会写错一个字母，表现为"某个设置改了没用"；
//   ② 联机模式里玩家随时可能改设置，改完必须**立刻**生效而不是下一局才生效，
//      所以需要一个订阅机制把变更推给各个消费方；
//   ③ 版本化 —— 存档结构以后一定会变（加设置项、改键位表），
//      读档时按 version 合并默认值，老存档不会把新字段写成 undefined。
//
// 存档键用 rr-settings-v1 而不是 rr-settings：以后结构大改可以直接换键重来，
// 不用写迁移代码，也不会读到一半的老结构。

const KEY = 'rr-settings-v1';

/** 默认值。新增设置项一律加在这里，读档时会用默认值补齐。 */
export const SETTINGS_DEFAULTS = {
  version: 3,

  // ---- 画面 ----
  quality: 'high',      // low | medium | high（引擎自带的三档）
  renderScale: 1.25,    // 渲染分辨率倍数 0.7~1.25；1.25 = 超采样，边缘更干净但更吃显卡
  autoQuality: true,    // 性能看门狗自动降档（连续 12s < 30fps 降一档）
  fov: 62,              // 基础视场角（CameraRig 在它之上叠速度/氮气的加成）
  shake: 1,             // 相机抖动/震屏强度 0~1（0 = 完全关掉，晕 3D 的玩家用）
  showFps: false,       // 左上角显示帧率

  // ---- 音频 ----
  volMaster: 0.8,
  volMusic: 0.45,
  volSfx: 0.9,
  volAmbience: 0.6,
  mute: false,

  // ---- 界面 ----
  hudScale: 1,          // HUD 文字/图标缩放 0.8~1.4
  uiScale: 1,           // 弹窗/对话框缩放 0.85~1.25

  // ---- 驾驶辅助（2026-11-18）----
  // 只留「每圈评价 / 失败归因」两项：它们是所有模式通用的即时反馈。
  // 幽灵车（影子）已经升级成大厅里的独立「挑战模式」玩法（2026-11-18），
  // 它的开关随玩法一起保留 —— 不进竞速 / 道具，也就没有「要不要显示」的问题，
  // 所以 ghost / ghostAlways 两个键已从默认表里删除（老存档里的残留值下次
  // 保存时会被自然抹掉，读档只认默认表里的键）。
  lapReview: true,      // 每圈压线后一句话评价
  impactIcon: true,     // 撞墙/撞石/被炸后的归因图标

  // ---- 键位（只做 7 个驾驶键）----
  // 存的是 KeyboardEvent.code，这样键盘布局切到 AZERTY 也不会按不出来。
  // 道具槽（Q/W/E/1/2/3）、炮击 J、协同 F、冲刺 K 属于分模式的功能键，
  // 每个模式一套槽位，做进面板只会更难解释，保持固定。
  keys: {
    throttle: 'KeyW',
    brake: 'KeyS',
    left: 'KeyA',
    right: 'KeyD',
    drift: 'ShiftLeft',
    nitro: 'ControlLeft',
    reset: 'KeyR',
  },
};

/** 设置项的取值范围与步长（面板控件用，越界值在 set 时被夹住） */
export const SETTINGS_RANGES = {
  renderScale: { min: 0.7, max: 1.25, step: 0.05 },
  fov: { min: 50, max: 85, step: 1 },
  shake: { min: 0, max: 1, step: 0.1 },
  hudScale: { min: 0.8, max: 1.4, step: 0.1 },
  uiScale: { min: 0.85, max: 1.25, step: 0.05 },
  volMaster: { min: 0, max: 1, step: 0.05 },
  volMusic: { min: 0, max: 1, step: 0.05 },
  volSfx: { min: 0, max: 1, step: 0.05 },
  volAmbience: { min: 0, max: 1, step: 0.05 },
};

const ENUMS = {
  quality: ['low', 'medium', 'high'],
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export class SettingsStore extends EventTarget {
  constructor() {
    super();
    this.data = clone(SETTINGS_DEFAULTS);
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      // 隐私模式下 localStorage 直接抛：用默认值跑完整局，不影响游戏
    }
    if (!raw) return;
    let saved = null;
    try {
      saved = JSON.parse(raw);
    } catch {
      return; // 存档被写坏：静默丢弃，下次保存会覆盖
    }
    if (!saved || typeof saved !== 'object') return;
    for (const [k, def] of Object.entries(SETTINGS_DEFAULTS)) {
      const v = saved[k];
      if (v == null) continue;
      if (k === 'keys') {
        // 键位逐项合并：老存档只存了 3 个键也不能把另外 4 个变成 undefined
        if (typeof v === 'object') {
          for (const [kk, kd] of Object.entries(def)) {
            if (typeof v[kk] === 'string' && v[kk]) this.data.keys[kk] = v[kk];
          }
        }
        continue;
      }
      if (typeof def === 'boolean') { this.data[k] = !!v; continue; }
      if (typeof def === 'number') { this.data[k] = this.clamp(k, Number(v)); continue; }
      if (typeof def === 'string') {
        this.data[k] = ENUMS[k] && !ENUMS[k].includes(v) ? def : String(v);
      }
    }
    this.#migrate(saved);
  }

  /**
   * 按 version 一次性纠正**已经落盘**的老默认值。
   *
   * 只改 SETTINGS_DEFAULTS 是不够的：老存档里这个键已经写成具体值了，
   * 读档时会被原样读回来（`if (v == null) continue` 挡不住 false），
   * 表现为「代码改了默认值，玩家机器上却纹丝不动」。
   */
  #migrate(saved) {
    const v = Number(saved.version) || 1;
    if (v < 2) {
      // v1 → v2 原本是纠正 ghostAlways 的落盘默认值（false → true）。
      // 2026-11-18 起幽灵车改成独立「挑战模式」玩法，ghost / ghostAlways
      // 两个键已删除，这里只剩「把版本号推上去」——但**不能删掉这个分支**：
      // 老存档停在 version=1 时，以后新增的迁移会重复执行。
      this.data.version = 2;
    }
    if (v < 3) {
      // v2 → v3：渲染分辨率上限开放到 125%，把还停在旧默认 100% 的存档抬上去。
      // 玩家自己调过的值保留，别把追求帧率的人硬拉回高负载。
      if (Number(saved.renderScale) === 1) this.data.renderScale = SETTINGS_DEFAULTS.renderScale;
      this.data.version = 3;
      this.save();
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // 隐私模式/配额满：只是这次不记住，不报错打断游戏
    }
  }

  clamp(key, v) {
    const r = SETTINGS_RANGES[key];
    const n = Number(v);
    if (!Number.isFinite(n)) return SETTINGS_DEFAULTS[key];
    if (!r) return n;
    return Math.min(r.max, Math.max(r.min, n));
  }

  get(key) {
    return this.data[key];
  }

  /**
   * 改一个设置：夹值 → 存盘 → 广播 change。
   * @param {string} key
   * @param {*} value
   * @param {{silent?:boolean, save?:boolean}} opts silent 不广播（批量应用时用）
   */
  set(key, value, opts = {}) {
    if (!(key in SETTINGS_DEFAULTS)) return;
    const def = SETTINGS_DEFAULTS[key];
    let v = value;
    if (typeof def === 'boolean') v = !!value;
    else if (typeof def === 'number') v = this.clamp(key, value);
    else if (ENUMS[key]) v = ENUMS[key].includes(value) ? value : def;
    else v = String(value);
    if (this.data[key] === v) return;
    this.data[key] = v;
    if (opts.save !== false) this.save();
    if (!opts.silent) {
      this.dispatchEvent(new CustomEvent('change', { detail: { key, value: v } }));
    }
  }

  /** 改键位。冲突检测在 Input 层做，这里只负责存。 */
  setKey(action, code, opts = {}) {
    if (!(action in SETTINGS_DEFAULTS.keys)) return;
    if (!code) return;
    if (this.data.keys[action] === code) return;
    this.data.keys[action] = code;
    if (opts.save !== false) this.save();
    if (!opts.silent) {
      this.dispatchEvent(new CustomEvent('change', { detail: { key: 'keys', action, value: code } }));
    }
  }

  reset() {
    this.data = clone(SETTINGS_DEFAULTS);
    this.save();
    this.dispatchEvent(new CustomEvent('change', { detail: { key: '*', value: null } }));
  }
}

export const settings = new SettingsStore();
