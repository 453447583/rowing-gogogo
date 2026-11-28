import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { ItemManager } from './Items.js';
import { cloneProp } from './propLoader.js';

/**
 * 第 3 层：道具箱大乱斗。
 *
 * 用户口径（2026-11-24）
 * ---------------------
 * 这一层**全是道具箱**，联机双方都吃；箱子 / 道具 / 释放逻辑全部沿用道具赛
 * （`Items.js` 的 `ItemBoxField` + `ItemManager`），把"其他人"一律当敌方
 * （该起泡的起泡、该眩晕的眩晕）；限时 1 分钟；
 * **吃到的箱子多者胜**（A 为主分，`SCORE_BOX`），用道具打中对手再少量加分
 * （B 加分，`SCORE_HIT`）；联机按队伍汇总。
 *
 * 为什么直接复用 ItemManager 而不是重写一套
 * ----------------------------------------
 * "释放道具的逻辑按照道具赛来"= 只要行为一致，就不该有第二份实现。
 * `Items.js` 本来就支持无赛道的坐标布箱（`opts.boxLayout`，竞技场在用），
 * 补了 4 个口子之后这一层几乎零改动就能跑：
 *   ① `boxLayout` 支持每箱自带 y（浮空平台要 36.3，不是 0）；
 *   ② `opts.groundAt` —— 弹道/水柱/预警环的高度原来硬写 `waveHeight()`，
 *      在 36m 高的玻璃平台上会把特效画到海面上；
 *   ③ `opts.boxRespawn` —— 竞速 8 秒补箱太慢，这里 4 秒；
 *   ④ `opts.onTakeBox / opts.onHit` —— 计分钩子（A / B）。
 *
 * 视觉：不新造任何几何体
 * ---------------------
 * 道具箱 = 道具赛那个带贴图的霓虹箱（问号贴图 + 霓虹面板 + 黄铜铆钉 + 破碎碎片），
 * 场边装饰全部复用现成 GLB（路灯杆 / 传送门），一层程序化"方块柱子"都没有。
 */

const D = SKY_TOWER.ITEMRUSH;
const TWO_PI = Math.PI * 2;

/** 这一层允许抽到的道具：只留"在平地甲板上语义成立"的，去掉依赖赛道弧线的 gate */
const POOL = [
  'nitro', 'shield', 'angel',
  'bomb', 'missile', 'torpedo', 'octopus', 'bubblefly', 'bloodlance',
  'fish', 'ink', 'tide', 'slowboat', 'waterfall', 'vortex',
  'bladestorm', 'sanctuary', 'barrier',
];

export class SkyTowerItemRush {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = D.LAYER;
    this.deckY = layerY(this.layer) + 0.30;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.onScore = opts.onScore || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.net = opts.net || { send() {} };
    this.teamOf = typeof opts.teamOf === 'function' ? opts.teamOf : null;
    this.fx = opts.fx || null;

    this.boats = new Map();
    this.bx = new Map();          // id -> 吃到的箱子数（A）
    this.hit = new Map();         // id -> 命中次数（B）
    this.started = false;
    this.running = true;
    this.timeLeft = D.DURATION;
    this.elapsed = 0;
    this.disposed = false;
    this._rankCache = null;
    this._rankFrame = -1;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-itemrush';
    this.group.position.y = this.deckY;
    scene.add(this.group);

    this.#buildDecor();

    this.layout = this.#boxLayout();
    this.items = new ItemManager({
      scene,
      // 这一层没有赛道：arena 就是"Track 接口桩"，boxLayout 分支根本不会碰它
      track: opts.track || null,
      net: this.net,
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      storm: false,
      getBoats: () => this.boats,
      getRank: (id) => this.rank(id),
      getGate: () => null,
      isTeammate: (a, b) => this.sameTeam(a, b),
      onToast: (m) => this.onToast(m),
      itemPool: POOL,
      boxLayout: this.layout,
      boxRespawn: D.BOX_RESPAWN,
      // 10 层玻璃盘在 xz 上完全重叠：必须按高度过滤，否则第 1 层的船会隔空
      // 吃掉第 3 层头顶 36m 的箱子（栈顶那 4m 是给弹跳/翻船浮起留的余量）
      boxYPad: 4,
      // 甲板就是"地面"：弹道 / 水柱 / 预警环全部贴在这层
      groundAt: () => this.deckY + 0.05,
      slotKeys: ['1', '2', '3'],
      onTakeBox: (id) => this.#awardBox(id),
      onHit: (id) => this.#awardHit(id),
      fx: this.fx,
    });
  }

  // ---------------------------------------------------------------- 场地

  /** 同心圆布箱：4 圈，外圈更密；中心 8m 留空给开场冲刺 */
  #boxLayout() {
    const out = [];
    for (let r = 0; r < D.RING_R.length; r++) {
      const radius = D.RING_R[r];
      const n = D.RING_N[r];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TWO_PI + r * D.RING_TWIST;
        out.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius, y: this.deckY });
      }
    }
    return out;
  }

  /**
   * 场边装饰：只用现成 GLB。
   * - 场边灯柱（`low_poly_street_light_pole.glb`）沿最外圈站成一圈当泛光灯；
   * - 4 座石拱（`canyon/arch.glb`）当进场门。原来铺了 8 座 `shortcut_arch`，
   *   同一段赛道素材重复太密，视觉上像复制粘贴，减半并换成峡谷石拱。
   * 都不参与碰撞（这一层只有箱子和船，撞到灯杆反而会莫名其妙掉速）。
   *
   * 2026-11-24 换掉 `props/portal.glb`：它本质是一圈发光环，缩到 15m 之后就是
   * 一个粉色塑料呼啦圈，占掉半个屏幕还跟冷玻璃完全不搭（截图才看出来）。
   * 拱门是实体门框，既有"进场"的语义又不会抢视线。
   */
  #buildDecor() {
    const R = layerRadius(this.layer);
    for (let i = 0; i < D.POLE_COUNT; i++) {
      const a = (i / D.POLE_COUNT) * TWO_PI + Math.PI / 8;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.97, 0.05, Math.sin(a) * R * 0.97);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          m.name = 'rush-pole';
          m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
          this.group.add(m);
        })
        .catch(() => {});
    }
    for (let i = 0; i < D.ARCH_COUNT; i++) {
      const a = (i / D.ARCH_COUNT) * TWO_PI + Math.PI / 8;
      cloneProp('/models/canyon/arch.glb', 11, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          // 摆最外圈箱子（半径 53）外侧，别盖住箱子
          m.position.set(Math.cos(a) * R * 0.88, 0.05, Math.sin(a) * R * 0.88);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'canyon_arch';
          m.name = 'rush-arch';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 计分

  #awardBox(id) {
    this.bx.set(id, (this.bx.get(id) || 0) + 1);
    this._rankCache = null;
    this.onScore(id, D.SCORE_BOX, 'box');
    this.onEvent({ type: 'box', id });
  }

  #awardHit(id) {
    this.hit.set(id, (this.hit.get(id) || 0) + 1);
    this._rankCache = null;
    this.onScore(id, D.SCORE_HIT, 'hit');
    this.onEvent({ type: 'hit', id });
  }

  sameTeam(a, b) {
    if (!this.teamOf) return false;
    const ta = this.teamOf(a), tb = this.teamOf(b);
    return ta != null && tb != null && ta === tb;
  }

  /**
   * 名次：按本层战绩排（箱子权重高，因为 A 是主分）。
   * 道具赛的"打前一名 / 落后保底"全靠这个值，直接用 heuristics 就行。
   */
  rank(id) {
    // 同一帧内多次调用（抽奖 + 找目标 + 名次栏）只算一次；
    // 注意判空：_award* 会主动把缓存置空，只看 _rankFrame 会读到 null
    if (!this._rankCache || this._rankFrame !== this.elapsed) {
      const val = (i) => (this.bx.get(i) || 0) * 100 + (this.hit.get(i) || 0);
      this._rankCache = [...this.boats.keys()].sort((a, b) => val(b) - val(a));
      this._rankFrame = this.elapsed;
    }
    const i = this._rankCache.indexOf(id);
    return i < 0 ? this._rankCache.length : i + 1;
  }

  /** 本层战绩（HUD / 结算用） */
  stats() {
    const out = new Map();
    for (const id of this.boats.keys()) {
      out.set(id, { boxes: this.bx.get(id) || 0, hits: this.hit.get(id) || 0 });
    }
    return out;
  }

  /** 我手上有什么（HUD 三格） */
  held() {
    return this.items ? this.items.myItems.slice() : [null, null, null];
  }

  /** 本层 1 分钟结束：道具箱全部消失、手上的道具清空 */
  clearPickups() {
    if (!this.items) return;
    for (const b of this.items.boxes) { b.active = false; b.respawn = 0; }
    this.items.myItems = [null, null, null];
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * @param {number} dt
   * @param {Array<{id:string, boat:object}>} entries 本层的船
   */
  update(dt, entries = []) {
    if (this.disposed) return;
    this.elapsed += dt;
    this._rankCache = null;
    this.boats = new Map(entries.map((e) => [e.id, e.boat]));

    if (!this.started && entries.length) {
      this.started = true;
      this.onEvent({ type: 'start' });
    }
    if (this.running && this.started) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.#finish();
    }
    // 结束之后只更新视觉（箱子藏起来、碎片播完），不再判定拾取
    this.items.update(dt, this.elapsed, performance.now() / 1000);
  }

  /** 用第 slot 格道具（本地玩家按 1/2/3） */
  useSlot(slot) {
    if (this.disposed || !this.running) return false;
    const item = this.items.myItems[slot];
    if (!item) return false;
    const boat = this.boats.get(this.myId);
    if (!boat) return false;
    // 与竞速同口径：被炸沉/打转/关异世界时不能放道具
    if (boat.stunTimer > 0 || boat.sinkTimer > 0 || boat.spinTimer > 0
      || boat.voidTimer > 0 || boat.capsizeTimer > 0) return false;
    const consumed = this.items.useItem(this.myId, item, slot);
    if (consumed !== false) {
      this.items.myItems[slot] = null;
      this.items.syncHeld(this.myId);
    }
    return consumed !== false;
  }

  #finish() {
    this.running = false;
    this.timeLeft = 0;
    for (const b of this.items.boxes) { b.active = false; b.respawn = 0; }
    this.items.myItems = [null, null, null];
    this.onToast('⏱ 本层时间到 · 按吃到的箱子数结算');
    this.onEvent({ type: 'finish' });
    this.net.send?.({ t: 'itemRushEnd' });
  }

  // ---------------------------------------------------------------- 网络

  applyNet(e) {
    if (!e || this.disposed) return;
    if (e.t === 'itemRushEnd') {
      if (this.running) this.#finish();
      return;
    }
    // 真人开箱/命中是「船主本地判 → 上报房主」。两端都要把数量记上：
    //   - 客机收到别人的消息：只记数量，分数等房主的 towerScore 绝对值；
    //   - 房主收到客机的消息：必须自己补数量 + 调 onScore，否则房主榜单里
    //     客机的箱子/命中永远是 0（2026-11-27 全景探针实测到的 bug）。
    // 房主自己上报的消息服务器不会回传，所以这里按 by !== myId 过滤不会重复计。
    if (e.by && e.by !== this.myId) {
      if (e.t === 'itemPick') {
        this.bx.set(e.by, (this.bx.get(e.by) || 0) + 1);
        this._rankCache = null;
        if (this.isHost) this.onScore(e.by, D.SCORE_BOX, 'box');
      } else if (e.t === 'itemHit') {
        this.hit.set(e.by, (this.hit.get(e.by) || 0) + 1);
        this._rankCache = null;
        if (this.isHost) this.onScore(e.by, D.SCORE_HIT, 'hit');
      }
    }
    this.items.handleNet(e);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.items?.dispose();
    this.items = null;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => m.dispose());
      }
    });
    this.scene.remove(this.group);
  }
}
