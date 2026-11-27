import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { BOSS_SKILLS } from '../data/bosses.js';
import { cloneProp } from './propLoader.js';
import { audio } from '../audio/AudioEngine.js';

/**
 * 云端天梯第 5 层：随机落雷 · 躲雷 + 互推。
 *
 * 用户口径（2026-11-25）
 * --------------------
 * - 场地随机位置落雷，每波同时 2 个；
 * - 被劈中次数最少的人获胜；
 * - 赛艇之间可以互撞，把对手推进落雷圈。
 *
 * 「复用怪物模式现有的落雷」具体复用了什么：
 *   视觉 = BOSS_SKILLS.thunder 的 skyFx（fxLightningStrike，P1 天雷落地）
 *          + hitFx（fxArcBolt，落点爆闪），参数原样读表，这里只改高度/缩放；
 *   预警 = 同款红色圆盘（Boss.js 的 warningMaterial：0xff3b30 / opacity 0.26~0.9）。
 * 没有复用 Boss 实体本身 —— 这一层不需要 BOSS 本体、血条和选招 AI，
 * 只要"天上定时劈两下"，自己写一层轻量循环反而更稳。
 *
 * 联机：落点由房主生成并广播（towerBoltWave），命中计数也只在房主判定
 * （towerBoltHit）；客机照广播播预警和天雷，计数以房主数字为准。
 */

const T = SKY_TOWER.THUNDER;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(T.LAYER) + 0.30;
// 船体水平半径（和 SkyTowerBossRun 的 hull 取同一个值，读起来一致）
const HULL = 1.3;

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
    this.dnf = new Set();          // 掉出第 5 层的人：本层排名直接垫底（不能靠逃跑赢）
    this.bolts = [];               // 场上还活着的落雷（含预警阶段）
    this.wave = 0;
    this.nextIn = T.WAVE_FIRST;
    this.timeLeft = T.DURATION;
    this.started = false;
    // 走表开关：本层有"真人船"才开始计时/出雷。
    // 否则 AI 先爬上来会把 75 秒耗光，真人到达时只会看到一层的空场。
    // 联机里客机等房主的第一波（收到 towerBoltWave 时打开）。
    this.clockOn = false;
    this.isAi = typeof opts.isAi === 'function' ? opts.isAi : () => false;
    this.running = true;
    this.order = [];               // 结算排名：[{id, n}]，n 越小越好
    this.winner = null;
    this.disposed = false;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-thunder';
    this.group.position.y = this.deckY;
    scene.add(this.group);

    const def = BOSS_SKILLS.thunder || {};
    // 视觉参数不复制一份新表：这里只记两个可覆盖的数值，其余名词每次播放时读 def
    this.skyFx = def.skyFx || 'fxLightningStrike';
    this.hitFx = def.hitFx || 'fxArcBolt';
    this.sfx = def.sfx || 'boss_thunder_strike';

    this.#buildDecor();
  }

  // ---------------------------------------------------------------- 场地

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
    // 客机收到 towerBoltWave 时会把 nextIn 重置成 WAVE_INTERVAL，所以这里
    // 照常回卷即可，不必分两套逻辑。
    if (clock) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) {
        this.nextIn += T.WAVE_INTERVAL;
        if (this.isHost || this.solo) this.#spawnWave();
      }
    }

    this.#updateBolts(dt);
  }

  /** 房主生成一波落雷：2 个随机点 → 广播 */
  #spawnWave() {
    const seq = this.wave + 1;
    const pts = [];
    for (let i = 0; i < T.BOLTS_PER_WAVE; i++) pts.push(this.#pickPoint(pts));
    const msg = { t: 'towerBoltWave', seq, bolts: pts };
    if (!this.solo) this.net.send?.(msg);
    this.#addWave(msg);
  }

  /**
   * 随机落点：环带内按面积均匀采样（sqrt 而不是直接 rand 半径，
   * 否则点会挤在内圈），并避开中央塔身和平台边缘。
   */
  #pickPoint(existing) {
    const R = Math.max(6, layerRadius(this.layer) - T.EDGE_MARGIN);
    const rMin = Math.min(T.SPIRE_CLEAR, R - 2);
    let last = null;
    for (let k = 0; k < 28; k++) {
      const a = Math.random() * TWO_PI;
      const r = Math.sqrt(rMin * rMin + Math.random() * Math.max(0.01, R * R - rMin * rMin));
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      last = { x: +x.toFixed(2), z: +z.toFixed(2) };
      if (existing.every((b) => Math.hypot(b.x - x, b.z - z) >= T.BOLT_MIN_GAP)) return last;
    }
    return last || { x: 0, z: 0 };
  }

  /** 建立一波：每道雷一个红圈 + 倒计时 */
  #addWave({ seq, bolts }) {
    this.wave = Math.max(this.wave, seq | 0);
    const list = [];
    const waveObj = { seq, bolts: [], hits: new Set(), settled: false };
    for (const b of bolts) {
      const bolt = {
        x: b.x, z: b.z,
        t: T.TELEGRAPH, total: T.TELEGRAPH,
        done: false, wave: waveObj,
        disc: null, ring: null,
      };
      this.#makeWarning(bolt);
      list.push(bolt);
    }
    waveObj.bolts = list;
    this.bolts.push(...list);
    this.onEvent({ type: 'wave', n: seq, list });
  }

  /**
   * 红圈：贴甲板的一层红色填充 + 一圈更亮的边（同 Boss.js 的 ground 预警口径）
   * + 一根从地面往上 12m 的淡红光柱。
   *
   * 注意：这些 mesh 都挂在 this.group 下，而 group 的 y 已经是 deckY，
   * 所以子对象只能用**相对高度**（0.14 / 6 米），再写一次 deckY 会把圈
   * 抬到上一层头顶（2026-11-25 用户反馈"完全没有红圈"就是这个）。
   */
  #makeWarning(bolt) {
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(T.BOLT_R, 48),
      new THREE.MeshBasicMaterial({
        color: 0xff2a1e, transparent: true, opacity: 0.4,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(T.BOLT_R * 0.84, T.BOLT_R, 64),
      new THREE.MeshBasicMaterial({
        color: 0xff8a5a, transparent: true, opacity: 0.78,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    // 竖直光柱：远处/余光也能一眼看到落点（平铺的红圈在玻璃甲板上容易糊掉）。
    // 只画背面 + 细半径：DoubleSide 的圆柱前后两层叠起来会变成一块"红帐篷"，
    // 挡住落点反而看不清（2026-11-25 第一版截图就是这个观感）。
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(T.BOLT_R * 0.3, T.BOLT_R * 0.46, T.BEAM_H, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff6a4a, transparent: true, opacity: 0.13,
        side: THREE.BackSide, depthWrite: false,
      }),
    );
    beam.position.y = T.BEAM_H / 2;
    const g = new THREE.Group();
    g.add(disc, ring, beam);
    g.position.set(bolt.x, 0.14, bolt.z);
    g.renderOrder = 4;
    g.name = 'thunder-warning';
    this.group.add(g);
    bolt.disc = disc;
    bolt.ring = ring;
    bolt.beam = beam;
    bolt.group = g;
  }

  #updateBolts(dt) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      if (!b.done) {
        b.t -= dt;
        const k = 1 - Math.max(0, b.t) / b.total;
        // 越接近命中越亮，叠一点呼吸闪烁（和 Boss 预警同一套观感）
        if (b.disc) b.disc.material.opacity = 0.38 + Math.min(0.46, k * 0.5);
        if (b.ring) {
          b.ring.material.opacity = 0.7 + Math.min(0.28, k * 0.3);
          const s = 1 + Math.sin(k * Math.PI * 4) * 0.035;
          b.ring.scale.setScalar(s);
        }
        if (b.beam) b.beam.material.opacity = 0.12 + k * 0.16;
        if (b.t <= 0) this.#resolveBolt(b);
      } else {
        // 命中后红圈留 0.35 秒再淡出，别瞬间消失（那样读不出"刚刚劈这里"）
        b.t -= dt;
        const fade = Math.max(0, Math.min(1, (b.t + 0.75) / 1.1));
        if (b.disc) b.disc.material.opacity = 0.5 * fade;
        if (b.ring) b.ring.material.opacity = 0.78 * fade;
        if (b.beam) b.beam.material.opacity = 0.28 * fade;
      }
      // 落地冲击波：一圈快速扩散的环，比单点爆闪更能读出"砸在这里"
      if (b.shock) {
        b.shockT -= dt;
        const k = 1 - Math.max(0, b.shockT) / T.SHOCK_TIME;
        b.shock.scale.setScalar(0.6 + k * 1.9);
        b.shock.material.opacity = Math.max(0, 0.85 * (1 - k));
        if (b.shockT <= 0) {
          b.shock.parent?.remove(b.shock);
          b.shock.geometry?.dispose();
          b.shock.material?.dispose();
          b.shock = null;
        }
      }
      if (b.t <= -0.75) {
        this.#disposeBolt(b);
        this.bolts.splice(i, 1);
      }
    }
  }

  /** 落雷落地：所有端都播视觉；命中判定与计数只在房主 */
  #resolveBolt(bolt) {
    bolt.done = true;
    bolt.t = 0.35;
    // 世界坐标的 Effekseer；y 必须带上本层甲板高度
    this.fx?.play?.(this.skyFx, bolt.x, this.deckY + T.SKY_H, bolt.z, T.SKY_SCALE);
    this.fx?.play?.(this.hitFx, bolt.x, this.deckY + 1.4, bolt.z, T.HIT_FX_SCALE);
    // 怪物模式落雷读条时那团雷云也搬过来：一道柱子 + 一团雷雾，远处才看得出"劈了"
    this.fx?.play?.('fxBoltStorm', bolt.x, this.deckY + 2.2, bolt.z, 1.6);
    this.fx?.play?.('explosion', bolt.x, this.deckY + 0.9, bolt.z, 0.85);
    // 音效直接复用怪物模式落雷那一份（BOSS_SKILLS.thunder.sfx）；gap 防止两雷同帧叠成爆音
    try { audio.play(this.sfx, { gap: 120 }); } catch {}
    if (bolt.disc) bolt.disc.material.opacity = 0.5;

    // 地面冲击波：一圈从落点向外扩散的环
    const shock = new THREE.Mesh(
      new THREE.RingGeometry(T.BOLT_R * 0.45, T.BOLT_R * 0.58, 64),
      new THREE.MeshBasicMaterial({
        color: 0xffd0a0, transparent: true, opacity: 0.85,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    shock.rotation.x = -Math.PI / 2;
    shock.position.set(bolt.x, 0.2, bolt.z);
    shock.renderOrder = 5;
    this.group.add(shock);
    bolt.shock = shock;
    bolt.shockT = T.SHOCK_TIME;

    if (this.isHost || this.solo) {
      for (const [id, boat] of this.boats) {
        if (!boat) continue;
        const d = Math.hypot(boat.pos.x - bolt.x, boat.pos.z - bolt.z);
        if (d > T.BOLT_R + HULL) continue;
        bolt.wave.hits.add(id);
        this.#strike(id, boat, bolt);
      }
    }

    if (!bolt.wave.settled && bolt.wave.bolts.every((b) => b.done)) {
      bolt.wave.settled = true;
      this.#settleWave(bolt.wave);
    }
  }

  /** 被劈中：计数 + 失控 + 从雷心向外击退（不掉货、不掉血，这层只有次数） */
  #strike(id, boat, bolt) {
    const n = (this.struck.get(id) || 0) + 1;
    this.struck.set(id, n);
    const dx = boat.pos.x - bolt.x, dz = boat.pos.z - bolt.z;
    const d = Math.hypot(dx, dz) || 1;
    boat.vel.x += (dx / d) * T.PUSH;
    boat.vel.y += (dz / d) * T.PUSH;
    boat.vy = Math.max(boat.vy || 0, T.PUSH_LIFT);
    boat.stunTimer = Math.max(boat.stunTimer || 0, T.STUN);
    boat.slowTimer = Math.max(boat.slowTimer || 0, T.SLOW);
    this.onEvent({ type: 'hit', id, n, x: bolt.x, z: bolt.z });
    if (!this.solo && this.isHost) {
      this.net.send?.({ t: 'towerBoltHit', id, n, x: bolt.x, z: bolt.z });
    }
  }

  /** 一波结束：本层在场的、没被劈的人 +1 分（房主算分并同步绝对值） */
  #settleWave(w) {
    if (!this.running) return;
    if (!this.isHost && !this.solo) return;
    for (const id of this.boats.keys()) {
      if (w.hits.has(id)) continue;
      const s = this.onScore(id, T.SCORE_DODGE, 'dodge');
      if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id, s });
    }
  }

  #disposeBolt(b) {
    b.group?.parent?.remove(b.group);
    for (const m of [b.disc, b.ring, b.beam]) {
      m?.geometry?.dispose();
      m?.material?.dispose();
    }
    if (b.shock) {
      b.shock.parent?.remove(b.shock);
      b.shock.geometry?.dispose();
      b.shock.material?.dispose();
    }
    b.group = b.disc = b.ring = b.beam = b.shock = null;
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

    this.onEvent({ type: 'finish', order: ranked, winner: this.winner });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({ t: 'towerBoltEnd', order: ranked });
    }
  }

  // ---------------------------------------------------------------- 给 mode / AI 用

  /** AI：站进红圈就往外跑，否则去撞最近的对手（推到雷里） */
  aiTarget(boat, foeBoat = null) {
    if (!boat) return null;
    let best = null, bd = Infinity;
    for (const b of this.bolts) {
      if (b.done) continue;
      const d = Math.hypot(boat.pos.x - b.x, boat.pos.z - b.z);
      const edge = d - T.BOLT_R;
      if (edge < 2.5 && edge < bd) { bd = edge; best = b; }
    }
    if (best) {
      const dx = boat.pos.x - best.x, dz = boat.pos.z - best.z;
      const d = Math.hypot(dx, dz);
      const nx = d > 0.01 ? dx / d : Math.sin(boat.heading || 0);
      const nz = d > 0.01 ? dz / d : Math.cos(boat.heading || 0);
      const out = T.BOLT_R + 8;
      let tx = best.x + nx * out;
      let tz = best.z + nz * out;
      // 逃命点必须留在平台上：圈离边最多 EDGE_MARGIN，往外跑 8m 可能直接冲出去
      const lim = layerRadius(this.layer) - 6;
      const len = Math.hypot(tx, tz);
      if (len > lim) { tx = (tx / len) * lim; tz = (tz / len) * lim; }
      return { x: tx, z: tz, dodge: true };
    }
    if (foeBoat) return { x: foeBoat.pos.x, z: foeBoat.pos.z, dodge: false };
    return null;
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
        // 客机：按房主的落点建同样的预警；nextIn 对齐成"下一波还差一整段"
        this.nextIn = T.WAVE_INTERVAL;
        this.clockOn = true;
        this.#addWave(e);
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
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bolts) this.#disposeBolt(b);
    this.bolts.length = 0;
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
