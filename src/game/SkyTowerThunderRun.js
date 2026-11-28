import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { BOSS_SKILLS } from '../data/bosses.js';
import { cloneProp } from './propLoader.js';
import { audio } from '../audio/AudioEngine.js';

/**
 * 云端天梯第 5 层：棋盘落雷 · 躲雷 + 互推。
 *
 * 用户口径（2026-11-28 改版）
 * -------------------------
 * - 不再"随机落两三道雷"，改成 BOSS 模式「雷霆棋盘」那一套：
 *   整层铺一张 8×8 的棋盘，每波随机点亮**一半**格子（红色地面预警），
 *   1.5 秒后整片落雷；
 * - 站在亮格里 = 被劈（失控 + 击退 + 计次），亮格之外安全；
 * - 每一波结束时，没被劈的人 +1 分，被劈的 0 分（不扣分）；
 * - 层末按被劈次数升序给 [6,3,1] 排名分；掉出平台的人垫底。
 *
 * 视觉与性能
 * ----------
 * 预警是**一张 CanvasTexture 铺满甲板**（红块 + 淡格线），一波只占 1 个 draw call；
 * 落雷瞬间只给"抽样格 + 玩家脚下"播 Effekseer 天雷，格子再多也不会把低端机打崩。
 * 注意 canvas 的纵向：three 的 CanvasTexture 默认 flipY，而 PlaneGeometry 绕 X 轴
 * -90° 后 v=1 落在 -Z 侧，所以画格子时 py = cy*ch，保证"看到的红格"和"判定的红格"
 * 是同一格。
 *
 * 联机：点亮的格子集合由房主生成并广播（towerBoltWave），命中计数与计分也只在
 * 房主（towerBoltHit / towerScore）；客机照广播重画棋盘、播落雷。
 */

const T = SKY_TOWER.THUNDER;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(T.LAYER) + 0.30;

export class SkyTowerThunderRun {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = T.LAYER;
    this.deckY = DECK_Y;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.fx = opts.fx || null;
    this.net = opts.net || { send() {} };
    this.onScore = opts.onScore || (() => 0);
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});

    this.boats = new Map();        // 当前在本层的船（每帧由 mode 传入）
    this.seen = new Set();         // 本层出现过的人：结算按这个集合算，中途上楼也不漏
    this.struck = new Map();       // id -> 本层被劈中次数（房主权威）
    this.dnf = new Set();          // 掉出第 5 层的人：本层排名直接垫底
    this.cells = new Set();        // 当前波点亮（会落雷）的格子索引
    this.wave = 0;
    this.nextIn = T.WAVE_FIRST;
    this.timeLeft = T.DURATION;
    this.started = false;
    // 走表开关：本层有"真人船"才开始计时/出雷。
    // 否则 AI 先爬上来会把 60 秒耗光，真人到达时只会看到一层的空场。
    // 联机里客机等房主的第一波（收到 towerBoltWave 时打开）。
    this.clockOn = false;
    this.isAi = typeof opts.isAi === 'function' ? opts.isAi : () => false;
    this.running = true;
    this.order = [];               // 结算排名：[{id, n}]，n 越小越好
    this.winner = null;
    this.disposed = false;

    // 棋盘状态（视觉 + 判定共用同一份网格参数，两端必须一致）
    this.warnT = 0;                // 预警剩余时间；>0 = 还在红色预警
    this.warnDur = T.TELEGRAPH;
    this.flashT = 0;               // 落雷后的闪白/淡出
    this.strikeDone = true;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-thunder';
    this.group.position.y = this.deckY;
    scene.add(this.group);

    const def = BOSS_SKILLS.thunder || {};
    this.skyFx = def.skyFx || 'fxLightningStrike';
    this.hitFx = def.hitFx || 'fxArcBolt';
    this.sfx = def.sfx || 'tower_thunder_impact';

    this.#buildBoard();
    this.#buildDecor();
  }

  // ---------------------------------------------------------------- 场地

  /** 网格：8×8 覆盖整个圆盘；只有中心落在平台内的格子参与采样 */
  #buildBoard() {
    const R = layerRadius(this.layer);
    this.cols = Math.max(4, T.GRID_COLS | 0 || 8);
    this.rows = Math.max(4, T.GRID_ROWS | 0 || 8);
    this.span = R * 2 + 2;                 // 比圆盘略大，边缘格不会被裁掉
    this.cellX = this.span / this.cols;
    this.cellZ = this.span / this.rows;
    this.validCells = [];
    this.cellCenters = new Array(this.cols * this.rows);
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const x = -this.span / 2 + (cx + 0.5) * this.cellX;
        const z = -this.span / 2 + (cy + 0.5) * this.cellZ;
        const i = cy * this.cols + cx;
        this.cellCenters[i] = { x, z };
        // 只留中心在圆内的格子；边缘半格也允许，否则最外圈会空出一整圈
        if (Math.hypot(x, z) > R + Math.min(this.cellX, this.cellZ) * 0.3) continue;
        this.validCells.push({ i, x, z });
      }
    }
    // Node 单测没有 document：只算网格，不建视觉
    if (typeof document === 'undefined') return;

    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    this.canvas = cv;
    this.boardCtx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.boardTex = tex;
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(this.span, this.span), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.16;
    mesh.renderOrder = 4;
    mesh.visible = false;
    mesh.name = 'thunder-checkerboard';
    this.group.add(mesh);
    this.board = mesh;
  }

  /** 场边只用现成 GLB（和第 3/4 层同一批素材），别再加新模型 */
  #buildDecor() {
    const R = layerRadius(this.layer);
    for (let i = 0; i < T.POLE_COUNT; i++) {
      const a = (i / T.POLE_COUNT) * TWO_PI + Math.PI / 10;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.96, 0.05, Math.sin(a) * R * 0.96);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          m.name = 'thunder-pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
    for (let i = 0; i < T.ARCH_COUNT; i++) {
      const a = (i / T.ARCH_COUNT) * TWO_PI + Math.PI / 6;
      cloneProp('/models/props/flag_gate.glb', 11, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.85, 0.05, Math.sin(a) * R * 0.85);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'flag_gate';
          m.name = 'thunder-arch';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * @param {number} dt
   * @param {Array<{id:string,boat:object}>} entries 第 5 层上的船
   */
  update(dt, entries = []) {
    if (this.disposed) return;
    this.boats = new Map(entries.map((e) => [e.id, e.boat]));
    for (const e of entries) this.seen.add(e.id);

    if (!this.started && entries.length) {
      this.started = true;
      this.onEvent({ type: 'start' });
    }

    // 房主/单人：本层出现真人船才真正开跑；客机：收到房主第一波后开跑
    if ((this.isHost || this.solo) && !this.clockOn) {
      if (entries.some((e) => !this.isAi(e.id))) this.clockOn = true;
    }
    const clock = this.started && this.running && this.clockOn;

    if (clock) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.#finish();
    }

    // 波次计时：客机也走一份（只为 HUD 的"下一波"读数，真正生成只认房主）。
    // 客机收到 towerBoltWave 时会把 nextIn 重置成 WAVE_INTERVAL。
    if (clock) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) {
        this.nextIn += T.WAVE_INTERVAL;
        if (this.isHost || this.solo) this.#spawnWave();
      }
    }

    this.#updateBoard(dt);
  }

  /** 房主生成一波：随机一半格子 → 广播（绝对索引，两端同一张棋盘） */
  #spawnWave() {
    const seq = this.wave + 1;
    const pool = this.validCells.map((c) => c.i);
    // Fisher-Yates 洗牌，取前一半（严格"一半面积"，不是每格 50% 抖成 40/60）
    for (let i = pool.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const half = Math.max(1, Math.floor(pool.length / 2));
    const cells = pool.slice(0, half);
    const msg = {
      t: 'towerBoltWave', seq, cells,
      cols: this.cols, rows: this.rows, span: +this.span.toFixed(2),
      warn: T.TELEGRAPH,
    };
    if (!this.solo) this.net.send?.(msg);
    this.#beginWave(msg);
  }

  #beginWave({ seq, cells, warn }) {
    this.wave = Math.max(this.wave, seq | 0);
    this.cells = new Set((cells || []).map((n) => n | 0));
    const w = Number(warn);
    this.warnT = Number.isFinite(w) && w > 0 ? w : T.TELEGRAPH;
    this.warnDur = this.warnT;
    this.strikeDone = false;
    this.flashT = 0;
    this.#redraw();
    if (this.board) {
      this.board.visible = true;
      this.board.material.opacity = 0.42;
    }
    this.onEvent({ type: 'wave', n: this.wave, cells: [...this.cells] });
  }

  /** 重画红色预警盘：红块 + 淡格线，1 个 canvas、1 个 draw call */
  #redraw() {
    if (!this.boardCtx) return;
    const g = this.boardCtx;
    const W = this.canvas.width, H = this.canvas.height;
    const cw = W / this.cols, ch = H / this.rows;
    g.clearRect(0, 0, W, H);
    // 先铺一层极淡的底色，让"棋盘"整体读得出来（不挡视野）
    g.fillStyle = 'rgba(255,90,70,0.07)';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,44,28,0.82)';
    for (const i of this.cells) {
      const cx = i % this.cols;
      const cy = (i / this.cols) | 0;
      // CanvasTexture 默认 flipY：画布顶部 = v=1；PlaneGeometry 绕 X 轴 -90° 后
      // v=1 落在 -Z 侧，所以 cy=0（z 最负）就画在画布顶部，正好和判定同格。
      const py = cy * ch;
      g.fillRect(cx * cw + 1, py + 1, cw - 2, ch - 2);
    }
    g.strokeStyle = 'rgba(255,214,200,0.32)';
    g.lineWidth = 1.5;
    for (let i = 0; i <= this.cols; i++) {
      g.beginPath(); g.moveTo(i * cw, 0); g.lineTo(i * cw, H); g.stroke();
    }
    for (let i = 0; i <= this.rows; i++) {
      g.beginPath(); g.moveTo(0, i * ch); g.lineTo(W, i * ch); g.stroke();
    }
    // 贴图是正方形，但平台是圆盘：把圆盘之外的内容擦掉，
    // 否则边缘会飘出一圈悬空的格线/红块（低层看就是"天上浮着一张网"）。
    g.globalCompositeOperation = 'destination-in';
    g.beginPath();
    g.arc(W / 2, H / 2, (layerRadius(this.layer) / this.span) * W, 0, TWO_PI);
    g.fillStyle = '#fff';
    g.fill();
    g.globalCompositeOperation = 'source-over';
    this.boardTex.needsUpdate = true;
  }

  #updateBoard(dt) {
    if (this.warnT > 0 && !this.strikeDone) {
      this.warnT -= dt;
      const k = 1 - Math.max(0, this.warnT) / Math.max(0.001, this.warnDur);
      if (this.board) this.board.material.opacity = 0.42 + Math.min(0.4, k * 0.5);
      if (this.warnT <= 0) this.#strikeWave();
    } else if (this.flashT > 0) {
      this.flashT -= dt;
      const f = Math.max(0, this.flashT / 0.55);
      if (this.board) {
        this.board.material.opacity = 0.96 * f;
        if (this.flashT <= 0) this.board.visible = false;
      }
    }
  }

  #cellIndexAt(x, z) {
    const cx = Math.floor((x + this.span / 2) / this.cellX);
    const cy = Math.floor((z + this.span / 2) / this.cellZ);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  #cellCenter(i) {
    return this.cellCenters[i] || null;
  }

  /** 落雷：所有端都播视觉；命中判定与计分只在房主 */
  #strikeWave() {
    if (this.strikeDone) return;
    this.strikeDone = true;
    this.flashT = 0.55;
    if (this.board) this.board.material.opacity = 0.96;

    const list = [...this.cells];
    // 抽样天雷：最多 8 道，均布在点亮的格子里（低端机也不怕）
    const step = Math.max(1, Math.floor(list.length / 8));
    const sampled = list.filter((_, i) => i % step === 0).slice(0, 8);
    for (const i of sampled) {
      const c = this.#cellCenter(i);
      if (!c) continue;
      this.fx?.play?.(this.skyFx, c.x, this.deckY + T.SKY_H, c.z, T.SKY_SCALE);
    }
    try { audio.play(this.sfx, { gap: 120 }); } catch {}

    const hits = new Set();
    if (this.isHost || this.solo) {
      for (const [id, boat] of this.boats) {
        if (!boat) continue;
        const i = this.#cellIndexAt(boat.pos.x, boat.pos.z);
        if (i < 0 || !this.cells.has(i)) continue;
        hits.add(id);
        const c = this.#cellCenter(i) || { x: boat.pos.x, z: boat.pos.z };
        this.#strike(id, boat, c);
      }
      this.#settleWave(hits);
    }

    // 命中者脚下的爆闪（每端都看得到；数量 = 玩家数，不会压垮特效池）
    for (const id of hits) {
      const b = this.boats.get(id);
      if (!b) continue;
      this.fx?.play?.(this.hitFx, b.pos.x, this.deckY + 1.4, b.pos.z, T.HIT_FX_SCALE);
    }
    this.onEvent({ type: 'strike', n: this.wave, hits: [...hits] });
  }

  /** 被劈中：计数 + 失控 + 从格子中心向外击退（不掉货、不掉血，这层只有次数） */
  #strike(id, boat, c) {
    const n = (this.struck.get(id) || 0) + 1;
    this.struck.set(id, n);
    const dx = boat.pos.x - c.x, dz = boat.pos.z - c.z;
    const d = Math.hypot(dx, dz) || 1;
    boat.vel.x += (dx / d) * T.PUSH;
    boat.vel.y += (dz / d) * T.PUSH;
    boat.vy = Math.max(boat.vy || 0, T.PUSH_LIFT);
    boat.stunTimer = Math.max(boat.stunTimer || 0, T.STUN);
    boat.slowTimer = Math.max(boat.slowTimer || 0, T.SLOW);
    this.onEvent({ type: 'hit', id, n, x: c.x, z: c.z });
    if (!this.solo && this.isHost) {
      this.net.send?.({ t: 'towerBoltHit', id, n, x: c.x, z: c.z });
    }
  }

  /** 一波结束：本层在场的、没被劈的人 +1 分（房主算分并同步绝对值） */
  #settleWave(hits) {
    if (!this.running) return;
    if (!this.isHost && !this.solo) return;
    for (const id of this.boats.keys()) {
      if (hits.has(id)) continue;
      const s = this.onScore(id, T.SCORE_DODGE, 'dodge');
      if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id, s });
    }
  }

  // ---------------------------------------------------------------- 结算

  #finish(remote = false, authoritative = null) {
    if (!this.running) return;
    this.running = false;
    this.timeLeft = 0;
    const ids = this.seen.size ? [...this.seen] : [...this.boats.keys()];
    // 被劈次数升序；掉出平台的人垫底（否则"跳下去躲雷"反而能赢）
    const ranked = authoritative || ids.map((id, i) => ({
      id, n: this.struck.get(id) || 0, i, dnf: this.dnf.has(id),
    }))
      .sort((a, b) => {
        if (a.dnf !== b.dnf) return a.dnf ? 1 : -1;
        return a.n - b.n || a.i - b.i;
      })
      .map(({ id, n, dnf }) => ({ id, n, dnf }));
    this.order = ranked;
    this.winner = ranked.find((r) => !r.dnf)?.id || null;

    if (!remote && (this.isHost || this.solo)) {
      // 排名分只发给留在场上的人；掉层的这层白跑
      ranked.forEach((r, i) => {
        if (r.dnf) return;
        const pts = T.SCORE_RANK[Math.min(i, T.SCORE_RANK.length - 1)];
        const s = this.onScore(r.id, pts, 'rank');
        if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id: r.id, s });
      });
    }

    this.warnT = 0;
    this.strikeDone = true;
    this.flashT = Math.min(this.flashT, 0.2);
    this.onEvent({ type: 'finish', order: ranked, winner: this.winner });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({ t: 'towerBoltEnd', order: ranked });
    }
  }

  /** 换层/清场：把棋盘收掉（mode 的 #clearLayer 会调） */
  clearPickups() {
    this.warnT = 0;
    this.strikeDone = true;
    this.flashT = 0;
    this.cells.clear();
    if (this.board) {
      this.board.visible = false;
      this.board.material.opacity = 0;
    }
  }

  // ---------------------------------------------------------------- 给 mode / AI 用

  /** AI：脚下是红格就往最近的绿格跑，否则去撞最近的对手（把对方推进红格） */
  aiTarget(boat, foeBoat = null) {
    if (!boat) return null;
    if (this.warnT > 0 && this.cells.size) {
      const i = this.#cellIndexAt(boat.pos.x, boat.pos.z);
      if (i >= 0 && this.cells.has(i)) {
        const safe = this.#nearestSafeCell(boat.pos);
        if (safe) return { x: safe.x, z: safe.z, dodge: true };
      }
    }
    if (foeBoat) return { x: foeBoat.pos.x, z: foeBoat.pos.z, dodge: false };
    return null;
  }

  #nearestSafeCell(pos) {
    let best = null, bd = Infinity;
    for (const c of this.validCells) {
      if (this.cells.has(c.i)) continue;
      const d = Math.hypot(c.x - pos.x, c.z - pos.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** 本层被劈次数（给 HUD / 榜单读） */
  struckOf(id) { return this.struck.get(id) || 0; }

  isDnf(id) { return this.dnf.has(id); }

  /**
   * 掉出第 5 层（不是被雷劈，是自己冲出边缘/被推下去）。
   * 记进 dnf：本层排名垫底、不发排名分，否则"主动跳下去躲雷"就成了最优解。
   */
  noteFall(id) {
    if (this.disposed || !this.running || !id) return;
    if (!this.seen.has(id) || this.dnf.has(id)) return;
    this.dnf.add(id);
    this.onEvent({ type: 'fall', id });
  }

  /** 当前领先者：被劈最少的人（层内实时口径，结算后就是 order[0]） */
  leaderId() {
    if (this.order.length) return this.order[0].id;
    let best = null, bn = Infinity;
    for (const id of this.seen) {
      const n = this.struckOf(id);
      if (n < bn) { bn = n; best = id; }
    }
    return best;
  }

  // ---------------------------------------------------------------- 网络

  applyNet(e) {
    if (!e || this.disposed) return;
    switch (e.t) {
      case 'towerBoltWave':
        // 客机：按房主的格子集合重画同一张棋盘；nextIn 对齐成"下一波还差一整段"
        this.nextIn = T.WAVE_INTERVAL;
        this.clockOn = true;
        this.#beginWave(e);
        break;
      case 'towerBoltHit': {
        // 计数以房主为准；击退/失控只有本地需要真施加（别人看位置同步）
        this.struck.set(e.id, e.n | 0);
        const boat = this.boats.get(e.id);
        if (boat) {
          const dx = boat.pos.x - e.x, dz = boat.pos.z - e.z;
          const d = Math.hypot(dx, dz) || 1;
          boat.vel.x += (dx / d) * T.PUSH;
          boat.vel.y += (dz / d) * T.PUSH;
          boat.vy = Math.max(boat.vy || 0, T.PUSH_LIFT);
          boat.stunTimer = Math.max(boat.stunTimer || 0, T.STUN);
          boat.slowTimer = Math.max(boat.slowTimer || 0, T.SLOW);
          this.fx?.play?.(this.hitFx, boat.pos.x, this.deckY + 1.4, boat.pos.z, T.HIT_FX_SCALE);
        }
        this.onEvent({ type: 'hit', id: e.id, n: e.n | 0, x: e.x, z: e.z });
        break;
      }
      case 'towerBoltEnd': {
        const order = Array.isArray(e.order)
          ? e.order.map((r) => ({ id: r.id, n: r.n | 0, dnf: !!r.dnf }))
          : null;
        if (this.running) {
          this.#finish(true, order);
        } else if (order) {
          // 客机本地表可能先到 0（少算最后一波）：以房主排名为准
          this.order = order;
          this.winner = order.find((r) => !r.dnf)?.id || null;
        }
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- HUD

  hudState() {
    return {
      left: Math.max(0, this.timeLeft),
      next: Math.max(0, this.nextIn),
      mine: this.struckOf(this.myId),
      wave: this.wave,
      running: this.running,
      order: this.order,
      cells: this.cells.size,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((m) => m.dispose());
      }
    });
    this.boardTex?.dispose();
    this.scene.remove(this.group);
  }
}
