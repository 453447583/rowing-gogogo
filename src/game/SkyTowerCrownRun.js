import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { cloneProp } from './propLoader.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';
import { audio } from '../audio/AudioEngine.js';

/**
 * 云端天梯第 10 层：加冕仪式（抢皇冠）。
 *
 * 用户口径（2026-11-26）
 * --------------------
 * - 皇冠从塔顶落到绕塔 8m 的随机点，落定 1.5 秒后可抢；
 * - 持冠者极速 ×0.78、不能冲刺，头顶金色光柱；
 * - 每队一个 ±x 加冕区，在自家区里连续站 3 秒加冕一次 +8 分；
 *   出圈 / 被撞 / 被泡泡命中都会清零进度；
 * - 被撞或泡泡命中会掉冠、弹开 8m、2 秒内不能再拾取；
 * - 掉平台本层边缘复活（2 秒无敌）、皇冠留在原地、不扣分；
 * - 90 秒打满比加冕次数，排名分 [6,3,1]。
 *
 * 权威：皇冠归属 / 加冕次数 / 泡泡判定都在房主；客机看到的是
 * towerCrownState 快照 + 本地把这个皇冠画在自己（或对手）船顶上。
 */

const D = SKY_TOWER.CROWN;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(D.LAYER) + 0.30;
const SIDE_COLOR = [0x5fd8ff, 0xffa64a];
const GOLD = 0xffd76a;

export class SkyTowerCrownRun {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = D.LAYER;
    this.deckY = DECK_Y;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.fx = opts.fx || null;
    this.net = opts.net || { send() {} };
    this.onScore = opts.onScore || (() => 0);
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.sideOf = typeof opts.sideOf === 'function' ? opts.sideOf : () => 0;
    this.isAi = typeof opts.isAi === 'function' ? opts.isAi : () => false;
    this.invulnOf = typeof opts.invulnOf === 'function' ? opts.invulnOf : () => 0;
    this.colliders = Array.isArray(opts.colliders) ? opts.colliders : null;

    this.boats = new Map();
    this.seen = new Set();
    this.holder = null;              // 当前持冠者 id
    this.crownLock = new Map();      // id -> 掉冠后不可拾取的时间点
    this.charge = 0;                 // 当前持冠者在自家区的连续停留秒数
    this.chargeId = null;
    this.counts = [0, 0];            // side -> 加冕次数
    this.playerCounts = new Map();   // id -> 个人加冕次数（+8 分的归属）
    this.ramCd = new Map();
    this.bubbleCd = new Map();
    this.bubbles = [];
    this.aiFireT = new Map();
    this.elapsed = 0;
    this.timeLeft = D.DURATION;
    this.started = false;
    this.clockOn = false;
    this.running = true;
    this.order = [];
    this.teams = [];
    this.winner = null;
    this.disposed = false;
    this._stateT = 0;

    this.crown = {
      state: 'drop', x: 0, z: D.SPAWN_R, y: DECK_Y + 10,
      dropT: 0, lock: D.SPAWN_LOCK, spin: 0,
    };

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-crown';
    this.group.position.y = this.deckY;
    scene.add(this.group);

    this.#buildCrown();
    this.#buildZones();
    this.#buildObstacles();
    this.#buildDecor();
    this.#pickSpawn();
  }

  // ---------------------------------------------------------------- 场地

  #buildCrown() {
    this.crownGroup = new THREE.Group();
    this.group.add(this.crownGroup);
    // 金色光柱：不用 AdditiveBlending（亮天空前等于没画），低不透明度实体
    this.beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.9, 9, 18, 1, true),
      new THREE.MeshBasicMaterial({
        color: GOLD, transparent: true, opacity: 0.16,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.beam.position.y = 4.5;
    this.crownGroup.add(this.beam);

    // 先用一个程序化「金冠」占位（保底可见），GLB 加载完成再替换
    this.fallback = new THREE.Group();
    const band = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.14, 8, 28),
      new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.24, emissive: 0x4a3206 }),
    );
    band.rotation.x = Math.PI / 2;
    this.fallback.add(band);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TWO_PI;
      const spike = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.5, 6),
        new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: 0.22, emissive: 0x4a3206 }),
      );
      spike.position.set(Math.cos(a) * 0.62, 0.33, Math.sin(a) * 0.62);
      this.fallback.add(spike);
    }
    this.crownGroup.add(this.fallback);

    cloneProp('/models/props/golden_crown.glb', 1.7, { by: 'max' })
      .then((m) => {
        if (this.disposed) return;
        m.userData.glb = 'golden_crown';
        m.name = 'crown-model';
        m.rotation.y = Math.PI / 2;
        this.crownGroup.remove(this.fallback);
        this.fallback.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          o.material?.dispose?.();
        });
        this.fallback = null;
        this.crownGroup.add(m);
      })
      .catch(() => {});
  }

  #zoneX(side) { return side === 0 ? -D.ZONE_X : D.ZONE_X; }

  /** 两个加冕区：地面光环 + 王座门脸（palace_gate_frame / leaf） */
  #buildZones() {
    this.zones = [];
    for (let side = 0; side < 2; side++) {
      const x = this.#zoneX(side);
      const col = SIDE_COLOR[side];
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(D.ZONE_R - 0.35, D.ZONE_R, 64),
        new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0.42,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.03, 0);
      ring.renderOrder = 3;
      this.group.add(ring);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(D.ZONE_R - 0.4, 48),
        new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0.08,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(x, 0.025, 0);
      this.group.add(disc);
      this.zones.push({ side, x, ring });

      const gx = x + (side === 0 ? -3.4 : 3.4);
      cloneProp('/models/props/palace_gate_frame.glb', 8.5, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(gx, 0.02, 0);
          m.rotation.y = side === 0 ? Math.PI / 2 : -Math.PI / 2;
          m.userData.glb = 'palace_gate_frame';
          m.name = 'crown-gate';
          this.group.add(m);
        })
        .catch(() => {});
      cloneProp('/models/props/palace_gate_leaf.glb', 6.4, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(gx + (side === 0 ? 0.2 : -0.2), 0.02, 2.1);
          m.rotation.y = side === 0 ? Math.PI / 2 : -Math.PI / 2;
          m.userData.glb = 'palace_gate_leaf';
          m.name = 'crown-leaf';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  #buildObstacles() {
    this.rotors = [];
    const rotors = [{ x: 0, z: 10.5 }, { x: 0, z: -10.5 }].slice(0, D.ROTORS);
    for (const p of rotors) {
      const holder = new THREE.Group();
      holder.position.set(p.x, 0.02, p.z);
      this.group.add(holder);
      cloneProp('/models/props/rotating_obstacle.glb', 4.2, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.userData.glb = 'rotating_obstacle';
          m.name = 'crown-rotor';
          holder.add(m);
        })
        .catch(() => {});
      this.colliders?.push({ x: p.x, z: p.z, r: 1.5, bottomY: this.deckY - 1, topY: this.deckY + 4 });
      this.rotors.push(holder);
    }
  }

  #buildDecor() {
    const R = layerRadius(this.layer);
    for (let i = 0; i < D.POLE_COUNT; i++) {
      const a = (i / D.POLE_COUNT) * TWO_PI + Math.PI / 8;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.95, 0.05, Math.sin(a) * R * 0.95);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          m.name = 'crown-pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  #pickSpawn() {
    const a = Math.random() * TWO_PI;
    this.crown.x = Math.cos(a) * D.SPAWN_R;
    this.crown.z = Math.sin(a) * D.SPAWN_R;
    this.crown.state = 'drop';
    this.crown.dropT = 0;
    this.crown.y = this.deckY + 9;
    this.crown.lock = 0;   // 下落 1.5 秒落定即可抢（落地时间本身就是等待）
    this.holder = null;
    this.charge = 0;
    this.chargeId = null;
  }

  // ---------------------------------------------------------------- 每帧

  update(dt, entries = []) {
    if (this.disposed) return;
    this.elapsed += dt;
    this.boats = new Map(entries.map((e) => [e.id, e.boat]));
    for (const e of entries) this.seen.add(e.id);

    if (!this.started && entries.length) {
      this.started = true;
      this.onEvent({ type: 'start' });
    }
    if ((this.isHost || this.solo) && !this.clockOn) {
      if (entries.some((e) => !this.isAi(e.id))) this.clockOn = true;
    }
    const clock = this.started && this.running && this.clockOn;

    if (clock) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.#finish();
    }

    this.#advanceCrown(dt);
    if (clock && this.isHost) {
      this.#updateGrab();
      this.#updateCharge(dt);
      this.#updateRam();
      this.#updateAiFire();
    }
    this.#updateBubbles(dt);
    for (const r of this.rotors) r.rotation.y += dt * 1.1;
    for (const z of this.zones) {
      z.ring.material.opacity = 0.34 + Math.sin(this.elapsed * 2.4 + z.side) * 0.08;
    }

    if (this.isHost && !this.solo && this.started) {
      this._stateT -= dt;
      if (this._stateT <= 0) { this.#sendState(); this._stateT = 0.2; }
    }
  }

  /** 皇冠表现：下落 → 落地待抢 → 跟随持冠者 */
  #advanceCrown(dt) {
    const c = this.crown;
    this.crownGroup.rotation.y += dt * 1.6;
    if (c.state === 'drop') {
      c.dropT += dt;
      const k = Math.min(1, c.dropT / 1.5);
      c.y = this.deckY + 9 - (9 - 1.35) * k * k;
      if (k >= 1) {
        c.state = 'idle';
        this.fx?.play?.('ring', c.x, this.deckY + 0.4, c.z, 1.6);
        this.fx?.play?.('fxBenediction', c.x, this.deckY + 1.4, c.z, 0.9);
      }
    } else if (c.state === 'idle') {
      if (c.lock > 0) c.lock = Math.max(0, c.lock - dt);
      c.y = this.deckY + 1.35 + Math.sin(this.elapsed * 2.6) * 0.16;
    }
    if (this.holder) {
      const boat = this.boats.get(this.holder);
      if (boat) {
        c.x = boat.pos.x;
        c.z = boat.pos.z;
        c.y = boat.pos.y + 2.6 + Math.sin(this.elapsed * 3) * 0.1;
        c.state = 'held';
      }
    }
    // c.y 是世界高度（下落起点 / 船顶都按世界 y 写），但 group 已经整体抬到本层甲板，
    // 这里必须换成相对甲板的局部 y —— 否则皇冠会再被抬高一整层（第 10 层约 162m），飞进天空里看不见
    this.crownGroup.position.set(c.x, c.y - this.deckY, c.z);
    this.beam.visible = c.state !== 'drop';
    this.beam.position.y = c.state === 'held' ? -0.4 : -0.2;
  }

  /** 房主：谁先碰到谁拿冠（客机发请求，AI 由房主代判） */
  #updateGrab() {
    const c = this.crown;
    if (this.holder || c.state === 'drop' || c.lock > 0) return;
    for (const [id, boat] of this.boats) {
      if (!boat) continue;
      if ((this.crownLock.get(id) || 0) > this.elapsed) continue;
      const d = Math.hypot(boat.pos.x - c.x, boat.pos.z - c.z);
      if (d > D.PICK_R) continue;
      this.#setHolder(id);
      return;
    }
  }

  #setHolder(id) {
    this.holder = id;
    this.crown.state = 'held';
    this.crown.lock = 0;
    this.charge = 0;
    this.chargeId = id;
    const boat = this.boats.get(id);
    if (boat) this.fx?.play?.('fxBenediction', boat.pos.x, boat.pos.y + 2, boat.pos.z, 1.0);
    this.onEvent({ type: 'grab', id });
    if (!this.solo && this.isHost) this.net.send?.({ t: 'towerCrownGrab', id });
    if (id === this.myId) this.onToast('👑 抢到皇冠！冲回自己那侧的加冕区（持冠会变慢）');
    else this.onToast(`👑 ${id === this.myId ? '你' : '对手'}抢到皇冠了 · 撞他 / 泡泡炸他`);
  }

  /** 房主：加冕读条（必须在自家加冕区里连续站住） */
  #updateCharge(dt) {
    const id = this.holder;
    if (!id) return;
    const boat = this.boats.get(id);
    if (!boat) { this.#dropCrown('lost'); return; }
    const side = this.sideOf(id) ? 1 : 0;
    const zx = this.#zoneX(side);
    const inZone = Math.hypot(boat.pos.x - zx, boat.pos.z) <= D.ZONE_R;
    if (!inZone) {
      this.charge = 0;
      return;
    }
    if (this.chargeId !== id) { this.charge = 0; this.chargeId = id; }
    this.charge += dt;
    if (this.charge >= D.HOLD_TIME) this.#coronate(id, side, boat);
  }

  #coronate(id, side, boat) {
    this.counts[side] += 1;
    this.playerCounts.set(id, (this.playerCounts.get(id) || 0) + 1);
    const s = this.onScore(id, D.SCORE_CROWN, 'crown');
    this.fx?.play?.('fxBenediction', boat.pos.x, boat.pos.y + 2.4, boat.pos.z, 1.8);
    this.fx?.play?.('fxMagicCircle', boat.pos.x, this.deckY + 0.25, boat.pos.z, 1.6);
    try { audio.play('tower_crown_coronation', { gap: 220 }); } catch {}
    this.onEvent({ type: 'crown', id, side, n: this.counts[side] });
    if (!this.solo && this.isHost) {
      this.net.send?.({ t: 'towerCrownScore', id, side, n: this.counts[side], s });
    }
    this.holder = null;
    this.charge = 0;
    this.chargeId = null;
    // 加冕后皇冠回到塔顶，重新落一个随机点
    this.#pickSpawn();
    if (this.isHost) this.#broadcastCrown();
  }

  #dropCrown(reason = 'hit') {
    const id = this.holder;
    if (!id) return;
    const boat = this.boats.get(id);
    const c = this.crown;
    if (boat) {
      // 掉在平台内，别把皇冠丢出玻璃盘
      const lim = layerRadius(this.layer) - 2.5;
      const d = Math.hypot(boat.pos.x, boat.pos.z) || 1;
      const k = Math.min(1, lim / d);
      c.x = boat.pos.x * k;
      c.z = boat.pos.z * k;
    }
    c.state = 'idle';
    c.y = this.deckY + 1.35;
    c.lock = D.DROP_LOCK;
    this.crownLock.set(id, this.elapsed + D.DROP_LOCK);
    this.holder = null;
    this.charge = 0;
    this.chargeId = null;
    this.onEvent({ type: 'drop', id, reason });
    if (!this.solo && this.isHost) this.net.send?.({ t: 'towerCrownDrop', id, reason, x: c.x, z: c.z });
  }

  /** 撞人：持冠者被撞就掉冠 + 沿撞击方向弹开 8m */
  #updateRam() {
    if (!this.holder) return;
    const hid = this.holder;
    const hb = this.boats.get(hid);
    if (!hb) return;
    for (const [id, boat] of this.boats) {
      if (!boat || id === hid) continue;
      if (this.sideOf(id) === this.sideOf(hid)) continue;
      if (this.elapsed < (this.ramCd.get(id) || 0)) continue;
      const d = Math.hypot(boat.pos.x - hb.pos.x, boat.pos.z - hb.pos.z);
      if (d > 5.6) continue;
      const rel = Math.hypot(boat.vel.x - hb.vel.x, boat.vel.y - hb.vel.y);
      if (rel < D.RAM_MIN) continue;
      // 复活后的 2 秒无敌：不被撞掉冠
      if (this.invulnOf(hid) > 0) continue;
      this.ramCd.set(id, this.elapsed + D.RAM_CD);
      const nx = d > 0.01 ? (hb.pos.x - boat.pos.x) / d : Math.sin(boat.heading);
      const nz = d > 0.01 ? (hb.pos.z - boat.pos.z) / d : Math.cos(boat.heading);
      this.#dropCrown('ram');
      this.#knock(hid, nx, nz, D.KNOCK);
      break;
    }
  }

  #knock(id, nx, nz, dist) {
    const boat = this.boats.get(id);
    if (!boat) return;
    if (id === this.myId || (this.isHost && this.isAi(id))) {
      boat.vel.x += nx * dist;
      boat.vel.y += nz * dist;
      boat.vy = Math.max(boat.vy || 0, 1.6);
      boat.stunTimer = Math.max(boat.stunTimer || 0, 0.35);
    } else {
      this.net.send?.({ t: 'towerCrownKnock', id, nx, nz, d: dist });
    }
    this.fx?.play?.('hit', boat.pos.x, boat.pos.y, boat.pos.z, 1.4);
  }

  /** 按 1：船头放一颗 2 秒引信泡泡（半径 5m），炸到谁谁掉冠 */
  fireBubble(id = this.myId) {
    if (this.disposed || !this.running) return false;
    const boat = this.boats.get(id);
    if (!boat) return false;
    if (this.elapsed < (this.bubbleCd.get(id) || 0)) return false;
    this.bubbleCd.set(id, this.elapsed + D.BUBBLE_CD);
    const x = boat.pos.x + Math.sin(boat.heading) * 4.5;
    const z = boat.pos.z + Math.cos(boat.heading) * 4.5;
    if (this.isHost || this.solo) this.#spawnBubble(x, z);
    else this.net.send?.({ t: 'towerCrownFire', by: id, x, z });
    return true;
  }

  #spawnBubble(x, z) {
    this.#spawnBubbleVisual(x, z, true);
    if (!this.solo && this.isHost) this.net.send?.({ t: 'towerCrownBubble', x, z });
  }

  #spawnBubbleVisual(x, z, authoritative = false) {
    const mat = makeBubbleMaterial({ tint: 0xd9f6ff, opacity: 1, rim: 1.1, phase: Math.random() * TWO_PI });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 20, 14), mat);
    mesh.position.set(x, 1.7, z);
    this.group.add(mesh);
    this.bubbles.push({ x, z, t: D.BUBBLE_FUSE, authoritative, mesh, mat });
  }

  #updateBubbles(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.t -= dt;
      if (b.mesh) {
        b.mesh.position.y = 1.7 + Math.sin((1 - b.t / D.BUBBLE_FUSE) * Math.PI) * 1.1;
        b.mesh.rotation.y += dt * 2.2;
        // 引信最后 0.6 秒膨大，提示要炸了
        const grow = b.t < 0.6 ? 1 + (0.6 - Math.max(0, b.t)) * 0.7 : 1;
        b.mesh.scale.setScalar(grow);
        if (b.mat?.uniforms?.uTime) b.mat.uniforms.uTime.value += dt;
      }
      if (b.t > 0) continue;
      if (b.authoritative) this.#popBubble(b);
      b.mesh?.parent?.remove(b.mesh);
      b.mesh?.geometry?.dispose();
      b.mat?.dispose();
      this.bubbles.splice(i, 1);
    }
  }

  #popBubble(b) {
    this.fx?.play?.('hit', b.x, this.deckY + 1.4, b.z, 1.6);
    this.fx?.play?.('ring', b.x, this.deckY + 0.3, b.z, 1.6);
    if (!this.solo && this.isHost) this.net.send?.({ t: 'towerCrownPop', x: b.x, z: b.z });
    for (const [id, boat] of this.boats) {
      if (!boat) continue;
      if (this.invulnOf(id) > 0) continue;
      const dx = boat.pos.x - b.x, dz = boat.pos.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d > D.BUBBLE_R) continue;
      const nx = d > 0.01 ? dx / d : 0;
      const nz = d > 0.01 ? dz / d : 1;
      if (id === this.holder) this.#dropCrown('bubble');
      this.#knock(id, nx, nz, 7);
    }
  }

  /** 房主：AI 看到别人持冠就追；皇冠空着就去抢；自己持冠就往自家区跑 */
  aiTarget(boat, id) {
    if (!boat) return null;
    if (this.holder === id) {
      const side = this.sideOf(id) ? 1 : 0;
      return { x: this.#zoneX(side), z: 0, carry: true };
    }
    if (this.holder) {
      const hb = this.boats.get(this.holder);
      if (hb) return { x: hb.pos.x, z: hb.pos.z };
    }
    return { x: this.crown.x, z: this.crown.z };
  }

  #updateAiFire() {
    if (!this.isHost && !this.solo) return;
    for (const id of this.boats.keys()) {
      if (!this.isAi(id)) continue;
      if (this.elapsed < (this.aiFireT.get(id) || 0)) continue;
      const boat = this.boats.get(id);
      if (!boat) continue;
      // AI 只在自己不是持冠者、且靠近持冠者时丢泡泡
      if (this.holder && this.holder !== id) {
        const hb = this.boats.get(this.holder);
        if (hb && Math.hypot(hb.pos.x - boat.pos.x, hb.pos.z - boat.pos.z) < 9) {
          this.aiFireT.set(id, this.elapsed + 3 + Math.random() * 2);
          this.bubbleCd.set(id, 0);
          this.fireBubble(id);
        }
      }
    }
  }

  /** 掉出平台：皇冠留在原地，读条清零（mode 负责把船拉回本层边缘） */
  noteFall(id) {
    if (this.disposed || !id) return;
    if (this.holder === id) {
      if (this.isHost || this.solo) this.#dropCrown('fall');
      else this.net.send?.({ t: 'towerCrownFall', id });
    } else if (this.chargeId === id) {
      this.charge = 0;
    }
  }

  isHolder(id) { return !!this.holder && this.holder === id; }
  chargeRatio() { return Math.max(0, Math.min(1, this.charge / D.HOLD_TIME)); }

  /** 本层 1 分钟结束：皇冠与泡泡消失（加冕区 / 障碍保留） */
  clearPickups() {
    this.holder = null;
    this.charge = 0;
    this.chargeId = null;
    if (this.crownGroup) this.crownGroup.visible = false;
    for (const b of this.bubbles) if (b.mesh) b.mesh.visible = false;
    this.bubbles.length = 0;
  }

  // ---------------------------------------------------------------- 结算

  #finish(remote = false, remoteOrder = null, remoteTeams = null) {
    if (!this.running) return;
    this.running = false;
    this.timeLeft = 0;
    const ids = this.seen.size ? [...this.seen] : [...this.boats.keys()];

    let order = remoteOrder;
    let teams = remoteTeams || [];
    if (!order) {
      const rows = ids.map((id, i) => ({
        id, s: this.sideOf(id) ? 1 : 0, i,
      }));
      const bySide = new Map();
      for (const r of rows) {
        const cur = bySide.get(r.s) || { s: r.s, rows: [], n: this.counts[r.s] };
        cur.rows.push(r);
        cur.n = this.counts[r.s];
        bySide.set(r.s, cur);
      }
      const sorted = [...bySide.values()].sort((a, b) => b.n - a.n || a.s - b.s);
      order = sorted.flatMap((t) => t.rows
        .sort((a, b) => (this.playerCounts.get(b.id) || 0) - (this.playerCounts.get(a.id) || 0) || a.i - b.i)
        .map((r) => ({ id: r.id, n: this.counts[t.s] })));
      teams = sorted.map((t) => ({ ids: t.rows.map((r) => r.id), n: t.n }));
    }
    if (!teams.length) teams = order.map((o) => ({ ids: [o.id], n: o.n }));
    this.order = order;
    this.teams = teams;
    this.winner = teams[0]?.ids?.[0] || order[0]?.id || null;

    if (!remote && (this.isHost || this.solo)) {
      const rankOf = new Map();
      teams.forEach((t, i) => { for (const id of t.ids) rankOf.set(id, i); });
      for (const r of order) {
        const i = rankOf.get(r.id) ?? 0;
        const pts = D.SCORE_RANK[Math.min(i, D.SCORE_RANK.length - 1)];
        const s = this.onScore(r.id, pts, 'rank');
        if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id: r.id, s });
      }
    }

    this.onEvent({
      type: 'finish',
      order,
      teams: teams.map((t) => ({ ids: t.ids, n: t.n })),
      counts: [...this.counts],
    });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({ t: 'towerCrownEnd', order, teams, counts: this.counts });
    }
  }

  // ---------------------------------------------------------------- 网络

  #broadcastCrown() {
    if (this.solo || !this.isHost) return;
    const c = this.crown;
    this.net.send?.({
      t: 'towerCrownState',
      st: c.state, x: +c.x.toFixed(2), z: +c.z.toFixed(2),
      h: this.holder || null, lk: +c.lock.toFixed(1),
      ch: +this.charge.toFixed(2),
      n: [...this.counts], pc: Object.fromEntries(this.playerCounts),
      left: +this.timeLeft.toFixed(1),
    });
  }

  #sendState() { this.#broadcastCrown(); }

  applyNet(e) {
    if (!e || this.disposed) return;
    switch (e.t) {
      case 'towerCrownState':
        if (!this.isHost) {
          const c = this.crown;
          if (typeof e.st === 'string') c.state = e.st;
          if (Number.isFinite(e.x)) c.x = e.x;
          if (Number.isFinite(e.z)) c.z = e.z;
          if (Number.isFinite(e.lk)) c.lock = e.lk;
          this.holder = e.h || null;
          if (Number.isFinite(e.ch)) this.charge = e.ch;
          if (Array.isArray(e.n)) this.counts = [e.n[0] | 0, e.n[1] | 0];
          if (e.pc) {
            for (const [id, n] of Object.entries(e.pc)) this.playerCounts.set(id, n | 0);
          }
          if (Number.isFinite(e.left)) this.timeLeft = e.left;
          this.clockOn = this.clockOn || this.started;
        }
        break;
      case 'towerCrownGrab':
        if (!this.isHost) {
          this.holder = e.id || null;
          this.crown.state = 'held';
          this.crown.lock = 0;
          this.charge = 0;
          this.onEvent({ type: 'grab', id: e.id, remote: true });
        }
        break;
      case 'towerCrownDrop':
        if (!this.isHost) {
          this.holder = null;
          this.crown.state = 'idle';
          this.crown.lock = D.DROP_LOCK;
          if (e.id) this.crownLock.set(e.id, this.elapsed + D.DROP_LOCK);
          if (Number.isFinite(e.x)) this.crown.x = e.x;
          if (Number.isFinite(e.z)) this.crown.z = e.z;
          this.charge = 0;
          this.onEvent({ type: 'drop', id: e.id, reason: e.reason, remote: true });
        }
        break;
      case 'towerCrownScore':
        if (!this.isHost) {
          this.counts[e.side | 0] = e.n | 0;
          this.playerCounts.set(e.id, (this.playerCounts.get(e.id) || 0) + 1);
          this.holder = null;
          this.onEvent({ type: 'crown', id: e.id, side: e.side | 0, n: e.n | 0, remote: true });
        }
        break;
      case 'towerCrownFire':
        if (this.isHost) {
          const boat = this.boats.get(e.by);
          if (boat) this.#spawnBubble(+e.x || 0, +e.z || 0);
        }
        break;
      case 'towerCrownFall':
        if (this.isHost) {
          if (this.holder === e.id) this.#dropCrown('fall');
          else if (this.chargeId === e.id) this.charge = 0;
        }
        break;
      case 'towerCrownBubble':
        if (!this.isHost) this.#spawnBubbleVisual(+e.x || 0, +e.z || 0);
        break;
      case 'towerCrownPop':
        if (!this.isHost) {
          this.fx?.play?.('hit', +e.x || 0, this.deckY + 1.4, +e.z || 0, 1.6);
          this.fx?.play?.('ring', +e.x || 0, this.deckY + 0.3, +e.z || 0, 1.6);
        }
        break;
      case 'towerCrownKnock': {
        if (e.id === this.myId || (this.isHost && this.isAi(e.id))) {
          const boat = this.boats.get(e.id);
          if (boat) {
            boat.vel.x += (e.nx || 0) * (e.d || 8);
            boat.vel.y += (e.nz || 0) * (e.d || 8);
            boat.vy = Math.max(boat.vy || 0, 1.6);
            boat.stunTimer = Math.max(boat.stunTimer || 0, 0.35);
          }
        }
        break;
      }
      case 'towerCrownEnd': {
        const order = Array.isArray(e.order)
          ? e.order.map((r) => ({ id: r.id, n: r.n | 0 })) : null;
        const teams = Array.isArray(e.teams)
          ? e.teams.map((t) => ({ ids: t.ids || [], n: t.n | 0 })) : null;
        if (this.running) this.#finish(true, order, teams);
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- HUD

  hudState() {
    const side = this.sideOf(this.myId) ? 1 : 0;
    return {
      left: Math.max(0, this.timeLeft),
      holder: this.holder,
      mine: this.counts[side],
      foe: this.counts[1 - side],
      charge: this.chargeRatio(),
      charging: !!this.holder && this.holder === this.myId && this.charge > 0,
      carry: this.isHolder(this.myId),
      lock: Math.max(0, (this.crownLock.get(this.myId) || 0) - this.elapsed),
      running: this.running,
      order: this.order,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.bubbles) {
      b.mesh?.parent?.remove(b.mesh);
      b.mesh?.geometry?.dispose();
      b.mat?.dispose();
    }
    this.bubbles.length = 0;
    // cloneProp 的道具材质与 GLB 缓存共享，不能在这里 dispose
    this.scene.remove(this.group);
  }
}
