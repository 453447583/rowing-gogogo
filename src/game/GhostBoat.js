// 幽灵车：把「你自己最快的一圈」放回赛道上重跑。
//
// 为什么复用 Boat 而不是另搓一个半透明网格
// ----------------------------------------
// 赛艇的缩放、朝向修正、水线高度、蒙皮角色（牛来号）的骨骼、贴图材质，
// 全部在 Boat 里已经调好了。另写一套等于把这些坑重踩一遍，而且换船就变形。
// 这里只是 new 一艘 Boat 然后：
//   · 关掉尾迹 / 接触阴影 / 名牌 / 水花（`{ ghost: true }`，见 Boat.js）
//   · 材质换成半透明青白（`#applyGhostLook`）
//   · 不做物理：位姿由记录直接给（`updateGhost`），所以它撞不到任何东西。
//
// 位置插值用「按时间线性插值」而不是远程艇那套延迟回放：
// 幽灵的数据是本地的、时间轴就是我们自己的 raceTime，没有任何抖动要抹平，
// 延迟回放反而会让它固定慢 80ms，读起来像「幽灵总是差一点点」。

import * as THREE from 'three';
import { Boat } from './Boat.js';

const TAG_W = 256;
const TAG_H = 96;
/** 幽灵模型透明度：0.30 在晴天水面上清楚，又不至于遮住自己的船头 */
const GHOST_ALPHA = 0.30;

export class GhostBoat {
  /**
   * @param {THREE.Scene} scene
   * @param {object} def 赛艇定义（与本地玩家同一艘，才能保证船长/吃水一致）
   * @param {object} waterStyle { color, crest, waveScale, detail }
   */
  constructor(scene, def, waterStyle = {}) {
    this.scene = scene;
    // 单独一层 root：Boat.#applyPose 每帧会把 group.visible 设回 true（掉出赛道的闪烁逻辑），
    // 要「领先时把幽灵藏起来」就必须藏它的父级，不能藏 group 本身。
    this.root = new THREE.Group();
    scene.add(this.root);

    this.boat = new Boat(scene, def, '', false, waterStyle, { ghost: true });
    scene.remove(this.boat.group);
    this.root.add(this.boat.group);
    this.root.visible = false;

    this.data = null;
    this.prog = null;      // 每点的弧长进度 0..1（单调化后，供二分查找）
    this.segT = null;      // 幽灵的 4 段累计时刻
    this.lapTime = 0;
    this.lastIdx = 0;
    this.visible = false;
    this.accum = 0;

    this.#makeTag();
  }

  // ---------- 车顶差值牌 ----------
  #makeTag() {
    const canvas = document.createElement('canvas');
    canvas.width = TAG_W;
    canvas.height = TAG_H;
    this.tagCanvas = canvas;
    this.tagCtx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.tagTex = tex;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    this.tag = new THREE.Sprite(mat);
    this.tag.scale.set(3.4, 1.28, 1);
    this.tag.position.set(0, 3.2, 0);
    this.tag.visible = false;
    this.boat.group.add(this.tag);
    this.tagText = null;
    this.tagTone = null;
  }

  /** 差值牌内容：落后红、领先金。文字只在变化超过 0.01s 时重绘 */
  #updateTag(delta, show) {
    if (!show) {
      if (this.tag.visible) { this.tag.visible = false; this.tagText = null; }
      return;
    }
    // 0.1 秒死区：两个人并排时差值会在 0 附近抖，全亮橙/金只会闪成一片
    const tone = delta > 0.1 ? 'bad' : delta < -0.1 ? 'good' : 'even';
    const txt = `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`;
    if (txt === this.tagText && tone === this.tagTone) { this.tag.visible = true; return; }
    this.tagText = txt;
    this.tagTone = tone;
    const g = this.tagCtx;
    g.clearRect(0, 0, TAG_W, TAG_H);
    // 底板：跟项目其余 HUD 一样走「深色玻璃 + 细边」，不要纯色块
    g.fillStyle = 'rgba(6, 22, 34, 0.62)';
    g.beginPath();
    const r = 26;
    g.roundRect ? g.roundRect(6, 8, TAG_W - 12, TAG_H - 16, r) : g.rect(6, 8, TAG_W - 12, TAG_H - 16);
    g.fill();
    g.strokeStyle = tone === 'bad' ? 'rgba(255,138,90,0.85)'
      : tone === 'good' ? 'rgba(255,215,106,0.9)'
        : 'rgba(190,235,255,0.8)';
    g.lineWidth = 4;
    g.stroke();
    g.fillStyle = tone === 'bad' ? '#ff9a6a' : tone === 'good' ? '#ffd76a' : '#d8f2ff';
    g.font = 'bold 62px "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, TAG_W / 2, TAG_H / 2 - 2);
    this.tagTex.needsUpdate = true;
    this.tag.visible = true;
  }

  /**
   * 载入一条记录。
   * @param {object} rec GhostStore 解包后的 { t,x,z,h,lapTime,arcTotal }
   * @param {object} track 用来把轨迹点换算成「本圈进度」
   * @param {number} lapArc 记录那一圈起点的弧长
   * @returns {boolean} 是否可用
   */
  load(rec, track, lapArc) {
    if (!rec || !(rec.t?.length > 1)) return false;
    this.data = rec;
    this.lapTime = rec.lapTime;
    const n = rec.t.length;
    this.lastIdx = 0;

    // 弧长进度表：二分查找「玩家跑到这个位置时，幽灵花了多少时间」
    if (track?.arcAt) {
      const arcTotal = Math.max(1, rec.arcTotal || track.arcTotal || 1);
      const prog = new Float32Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        let p = (track.arcAt(rec.x[i], rec.z[i]).s - lapArc) / arcTotal;
        if (p < -0.5) p += 1;
        if (p < 0) p = 0;
        // 单调化：幽灵如果被记录时短暂倒过车，进度不能往回跳，否则二分会失效
        if (p < prev) p = prev;
        prog[i] = p;
        prev = p;
      }
      prog[n - 1] = 1;
      this.prog = prog;
      // 4 段分界时刻（给每圈评价当参照）
      const seg = [0, 0, 0, 0];
      let k = 1;
      for (let i = 0; i < n && k < 4; i++) {
        if (prog[i] >= k / 4) { seg[k - 1] = rec.t[i]; k += 1; }
      }
      for (let j = 0; j < 4; j++) if (!seg[j]) seg[j] = rec.lapTime;
      this.segT = seg;
    } else {
      this.prog = null;
      this.segT = null;
    }
    return true;
  }

  /** 玩家的本圈进度（0..1），与幽灵的 prog 同一把尺子 */
  static progressOf(track, boat, lapArc) {
    if (!track?.arcAt || !boat) return 0;
    const arcTotal = Math.max(1, track.arcTotal || 1);
    let p = (track.arcAt(boat.pos.x, boat.pos.z).s - lapArc) / arcTotal;
    if (p < -0.5) p += 1;
    return Math.min(1, Math.max(0, p));
  }

  /** 幽灵跑到某个进度时用了多少秒 */
  timeAtProgress(p) {
    const { prog } = this;
    if (!prog || !this.data) return null;
    const t = this.data.t;
    const n = prog.length;
    if (p <= prog[0]) return t[0];
    if (p >= prog[n - 1]) return t[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (prog[mid] <= p) lo = mid; else hi = mid;
    }
    const span = prog[hi] - prog[lo];
    const f = span > 1e-6 ? (p - prog[lo]) / span : 0;
    return t[lo] + (t[hi] - t[lo]) * f;
  }

  /**
   * 每帧推进。
   * @param {number} dt
   * @param {number} t 全局时间（给波浪姿态用）
   * @param {number} lapT 本圈已用时间
   * @param {number} curProgress 玩家本圈进度
   * @returns {{delta:number|null, showing:boolean, finished:boolean}}
   *   delta > 0 = 玩家比幽灵慢（幽灵在前）
   */
  update(dt, t, lapT, curProgress) {
    if (!this.data) return { delta: null, showing: false, finished: true };
    const { t: ts, x, z, h } = this.data;
    const n = ts.length;
    const total = this.lapTime || ts[n - 1];
    const finished = lapT >= total;

    // 播放位置：时间轴直接是 lapT（本圈时间），线性插值
    let i = Math.min(this.lastIdx, n - 1);
    while (i < n - 2 && ts[i + 1] < lapT) i += 1;
    while (i > 0 && ts[i] > lapT) i -= 1;
    this.lastIdx = i;
    const t0 = ts[i];
    const t1 = ts[i + 1] ?? t0;
    const f = t1 > t0 ? Math.min(1, Math.max(0, (lapT - t0) / (t1 - t0))) : 0;
    const x1 = x[i + 1] ?? x[i];
    const z1 = z[i + 1] ?? z[i];
    const px = x[i] + (x1 - x[i]) * f;
    const pz = z[i] + (z1 - z[i]) * f;
    // 朝向走最短弧（0.0055° 量化的记录会跨 2π/0 边界，直接 lerp 会整船原地转一圈）
    let dh = (h[i + 1] ?? h[i]) - h[i];
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const ph = h[i] + dh * f;
    const segLen = Math.hypot((x[i + 1] ?? x[i]) - x[i], (z[i + 1] ?? z[i]) - z[i]);
    const segDur = Math.max(0.001, (t1 - t0));
    this.boat.updateGhost(dt, t, px, pz, ph, segLen / segDur, finished);

    const ghostT = this.timeAtProgress(curProgress);
    const delta = ghostT == null ? null : lapT - ghostT;

    // 车顶牌：只在「落后 / 接近」时显示，领先太多会挡视线
    const showTag = !finished && delta != null && delta > -0.6;
    this.#updateTag(delta ?? 0, showTag);
    return { delta, showing: this.visible, finished };
  }

  /**
   * 显示/隐藏（领先时把幽灵藏起来）。
   * 注意隐藏时也要继续 update 位姿，否则再出现时会从旧位置瞬移。
   */
  setVisible(v) {
    const next = !!v;
    if (next === this.visible) return;
    this.visible = next;
    this.root.visible = next;
    if (!next) this.tag.visible = false;
  }

  dispose() {
    this.scene.remove(this.root);
    this.boat.dispose();
  }
}
