// 键盘输入。
//
// 两套按键并存，刻意不合并：
//   ① **可改键的 7 个驾驶动作**（油门/刹车/左/右/漂移/氮气/复位）存的是
//      KeyboardEvent.code，跟着物理按键走 —— 玩家用 AZERTY 或换了输入法也不会按不出来；
//   ② **固定功能键**（道具槽 Q/W/E/1/2/3、炮击 J、协同 F、冲刺 K、方向键）仍是
//      e.key 小写。这些是"文本"语义，而且多套模式各有一套槽位，做进面板只会更难解释。
//
// 旧行为全部保留：方向键永远可以当油门/转向（习惯键不抢），Shift 左右都认。
//
// 冻结（frozen）：打开设置面板时置 true —— 所有 getter 立刻归零并清空按下的键，
// 否则面板开着时玩家的手还在键上，船会一直往前冲，改完设置回来已经撞墙了。
import { settings } from '../settings.js';

/**
 * 左右 Shift / Ctrl 归一化。
 * 默认漂移是 ShiftLeft、氮气是 ControlLeft，但玩家分不清左右手，
 * 不归一化就变成"我按了 Shift 怎么不漂"（右手那一下）。
 */
export function normCode(code) {
  if (code === 'ShiftRight') return 'ShiftLeft';
  if (code === 'ControlRight') return 'ControlLeft';
  return code;
}

/** 不允许绑成驾驶键的键（会打断页面或面板本身） */
export const RESERVED_CODES = new Set([
  'Escape', 'Tab', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight',
]);

/** KeyboardEvent.code → 面板上显示的短标签 */
export function keyLabel(code) {
  if (!code) return '—';
  const map = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: '空格', ShiftLeft: 'Shift', ControlLeft: 'Ctrl',
    Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  };
  if (map[code]) return map[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return '小' + code.slice(6);
  return code;
}

export class Input {
  constructor() {
    this.keys = new Set();   // e.key 小写：固定功能键与方向键
    this.codes = new Set();  // e.code：可改键的驾驶动作
    this.frozen = false;
    this.onReset = null;
    this.onItem = null;      // (slot: 0|1|2) => void
    this.itemMode = false;   // 道具模式：Q/W/E 变为道具槽键
    this.bossItemMode = false; // 怪物模式：Q/E/1 为道具槽键，W 仍是油门
    this.applyBindings();
    settings.addEventListener('change', (e) => {
      const k = e.detail?.key;
      if (k === '*' || k === 'keys') this.applyBindings();
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // 冻结时仍要收 keyup，但不再累积按下状态：面板里敲键不该开船
      if (this.frozen) return;
      const k = e.key.toLowerCase();
      this.codes.add(normCode(e.code || ''));
      if (this.bossItemMode) {
        const bossSlot = { q: 0, e: 1, '1': 2 }[k];
        if (bossSlot != null) {
          if (this.onItem) this.onItem(bossSlot);
          return;
        }
      }
      // 道具模式：Q/W/E（及 1/2/3）触发道具槽，不进入驾驶键集合（避免 W 误当油门）
      if (this.itemMode) {
        const slot = { q: 0, w: 1, e: 2, '1': 0, '2': 1, '3': 2 }[k];
        if (slot != null) {
          if (this.onItem) this.onItem(slot);
          return;
        }
      }
      this.keys.add(k);
      if (k === 'r' && this.onReset) this.onReset();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) {
        e.preventDefault();
      }
      // 阻止 Ctrl 组合键（保存/刷新等）干扰氮气操作
      if (k === 'control') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
      this.codes.delete(normCode(e.code || ''));
    });
    window.addEventListener('blur', () => this.clear());
  }

  /** 从设置里同步键位表（改键后面板会广播 change） */
  applyBindings() {
    this.bindings = { ...settings.get('keys') };
  }

  clear() {
    this.keys.clear();
    this.codes.clear();
  }

  /** 冻结/解冻驾驶输入（设置面板开合时调用） */
  setFrozen(v) {
    this.frozen = !!v;
    if (this.frozen) this.clear();
  }

  /** 某个驾驶动作当前是否按下 */
  isDown(action) {
    const code = this.bindings[action];
    return !!code && this.codes.has(code);
  }

  get throttle() {
    if (this.frozen) return 0;
    let v = 0;
    if (this.isDown('throttle') || this.keys.has('arrowup')) v += 1;
    if (this.isDown('brake') || this.keys.has('arrowdown')) v -= 1;
    return v;
  }

  get steer() {
    if (this.frozen) return 0;
    let v = 0;
    if (this.isDown('left') || this.keys.has('arrowleft')) v += 1;
    if (this.isDown('right') || this.keys.has('arrowright')) v -= 1;
    return v;
  }

  /** 漂移（集气）。左 Shift 与右 Shift 都算（normCode 归一化）。 */
  get drift() {
    if (this.frozen) return false;
    return this.isDown('drift');
  }

  /** J：怪物模式主炮（按住连射 / 蓄力） */
  get fire() {
    if (this.frozen) return false;
    return this.keys.has('j');
  }

  /** F：双人协同合击 */
  get combo() {
    if (this.frozen) return false;
    return this.keys.has('f');
  }

  /** K：竞技场冲刺（短位移 + 短暂无敌，用来躲弹） */
  get dash() {
    if (this.frozen) return false;
    return this.keys.has('k');
  }

  /** F：竞技场大招（有前摇，能被躲） */
  get ultimate() {
    if (this.frozen) return false;
    return this.keys.has('f');
  }

  /** H：竞技场决斗关定向举盾（按住） */
  get block() {
    if (this.frozen) return false;
    return this.keys.has('h');
  }

  /** 氮气（需集气满格）。默认 Ctrl，可改。 */
  get nitro() {
    if (this.frozen) return false;
    return this.isDown('nitro');
  }
}
