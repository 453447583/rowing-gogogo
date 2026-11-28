import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { ItemBoxField } from './Items.js';
import { cloneProp } from './propLoader.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';
import { audio } from '../audio/AudioEngine.js';

/**
 * 云端天梯第 8 层：水晶攻防。
 *
 * 用户口径（2026-11-26）
 * --------------------
 * - 每队一座水晶，摆在 ±x 边缘往里 6m；3 段耐久；
 * - 先打碎对方水晶直接获胜，75 秒没碎就比剩余段数；
 * - 伤害只有两种：冲撞（速度越高越高）+ 泡泡/道具；本层不给主炮；
 * - 场上刷道具箱，捡到攒泡泡炸弹（最多 2 发），按 1 朝对方水晶丢；
 * - 不能修，开场 5 秒护罩。
 *
 * 权威与同步
 * ----------
 * 水晶血量 / 箱子 / 泡泡生成只在房主算；船位姿本来就是各端自管，
 * 所以「撞水晶」由船主自己判自己并上报（AI 由房主代判），房主统一扣血后
 * 用 towerCrystalState 广播绝对值；客机只做视觉与本地反弹。
 */

const D = SKY_TOWER.CRYSTAL;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(D.LAYER) + 0.30;
const MAX_HP = D.SEG_HP * D.SEGMENTS;
// 船体水平半径（和 BossRun / ThunderRun 同一口径）
const HULL = 1.3;

const SIDE_COLOR = [0x5fd8ff, 0xffa64a];

export class SkyTowerCrystalRun {
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
    this.colliders = Array.isArray(opts.colliders) ? opts.colliders : null;

    this.boats = new Map();
    this.seen = new Set();
    this.hp = [MAX_HP, MAX_HP];
    this.shieldLeft = D.SHIELD;
    this.charges = new Map();
    this.ramCd = new Map();
    this.aiFireT = new Map();
    this.bubbles = [];
    this.shards = [];
    this.boxes = [];
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
    this._shieldFxDone = false;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-crystal';
    this.group.position.y = this.deckY;
    scene.add(this.group);

    this.#buildCrystals();
    this.#buildObstacles();
    this.#buildDecor();
    this.#buildBoxes();
  }

  // ---------------------------------------------------------------- 场地

  #crystalX(side) { return side === 0 ? -D.CRYSTAL_X : D.CRYSTAL_X; }

  /**
   * 水晶：内外两层八面体 + 地面光环 + 护罩球。
   * 没有现成水晶 GLB，用 PBR + 自发光做出「有实体、有阴影」的水晶；
   * 底座光环不用程序化贴图，靠 torus + 开场播 fxMagicCircle。
   */
  #buildCrystals() {
    this.crystals = [];
    for (let side = 0; side < 2; side++) {
      const g = new THREE.Group();
      g.position.set(this.#crystalX(side), 0, 0);
      const col = SIDE_COLOR[side];

      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(1.7, 0),
        new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: 1.15,
          metalness: 0.35, roughness: 0.12,
          transparent: true, opacity: 0.93, flatShading: true,
        }),
      );
      core.scale.set(1, 1.55, 1);
      core.position.y = 3.4;
      core.castShadow = true;
      g.add(core);

      const inner = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.9, 0),
        new THREE.MeshStandardMaterial({
          color: 0xffffff, emissive: col, emissiveIntensity: 2.2,
          metalness: 0.1, roughness: 0.2, flatShading: true,
        }),
      );
      inner.scale.set(1, 1.5, 1);
      inner.position.y = 3.4;
      g.add(inner);

      const shield = new THREE.Mesh(
        new THREE.SphereGeometry(3.5, 24, 18),
        new THREE.MeshBasicMaterial({
          color: 0xbfefff, transparent: true, opacity: 0.14, depthWrite: false,
        }),
      );
      shield.position.y = 3.2;
      g.add(shield);

      this.group.add(g);
      this.crystals.push({ side, group: g, core, inner, shield });
    }
  }

  /** 掩体与旋转障碍：视觉用现成 GLB，碰撞用静态圆（和塔身同一套 verticalPad 过滤） */
  #buildObstacles() {
    for (const r of D.ROCKS) {
      cloneProp(`/models/props/${r.glb}`, r.size, { by: 'max' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(r.x, 0.02, r.z);
          m.rotation.y = r.x === 0 ? 0.4 : -0.6;
          m.userData.glb = r.glb;
          m.name = 'crystal-rock';
          this.group.add(m);
        })
        .catch(() => {});
      this.colliders?.push({
        x: r.x, z: r.z, r: r.r,
        bottomY: this.deckY - 1, topY: this.deckY + 4,
      });
    }
    this.rotors = [];
    for (const r of D.ROTORS) {
      const holder = new THREE.Group();
      holder.position.set(r.x, 0.02, r.z);
      this.group.add(holder);
      cloneProp('/models/props/rotating_obstacle.glb', r.size, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.userData.glb = 'rotating_obstacle';
          m.name = 'crystal-rotor';
          holder.add(m);
        })
        .catch(() => {});
      this.colliders?.push({
        x: r.x, z: r.z, r: r.r,
        bottomY: this.deckY - 1, topY: this.deckY + 4,
      });
      this.rotors.push(holder);
    }
  }

  #buildDecor() {
    const R = layerRadius(this.layer);
    for (let i = 0; i < D.POLE_COUNT; i++) {
      const a = (i / D.POLE_COUNT) * TWO_PI + Math.PI / 7;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.96, 0.05, Math.sin(a) * R * 0.96);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          m.name = 'crystal-pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
    for (let i = 0; i < D.ARCH_COUNT; i++) {
      const a = (i / D.ARCH_COUNT) * TWO_PI + Math.PI / 4;
      cloneProp('/models/props/flag_gate.glb', 11, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.86, 0.05, Math.sin(a) * R * 0.86);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'flag_gate';
          m.name = 'crystal-arch';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  /** 6 个道具箱：两条挡在礁石外侧的弧线，谁都能抢 */
  #buildBoxes() {
    const pts = [
      { x: 0, z: 6 }, { x: 0, z: -6 },
      { x: 9, z: 17.5 }, { x: -9, z: 17.5 },
      { x: 9, z: -17.5 }, { x: -9, z: -17.5 },
    ];
    for (let i = 0; i < Math.min(D.BOX_COUNT, pts.length); i++) {
      this.boxes.push({
        x: pts[i].x, z: pts[i].z, y: this.deckY,
        active: true, respawnAt: 0,
      });
    }
    this.boxField = new ItemBoxField(this.scene, this.boxes.length, {
      size: 1.35, floatHeight: 1.5, bob: 0.22, spin: 0.6,
    });
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
      if (this.shieldLeft > 0) {
        this.shieldLeft = Math.max(0, this.shieldLeft - dt);
        if (this.shieldLeft <= 0) this.#onShieldDown();
      }
      if (this.timeLeft <= 0) this.#finish();
    }

    this.#updateVisuals(dt);
    this.#updateBoxes(clock);
    this.#updateRam(clock);
    this.#updateBubbles(dt);
    this.#updateShards(dt);
    if (this.isHost) this.#updateAiFire(clock);
    this.boxField?.update(this.elapsed, this.boxes);

    if (this.isHost && !this.solo && this.started) {
      this._stateT -= dt;
      if (this._stateT <= 0) { this.#sendState(); this._stateT = 0.2; }
    }
  }

  #updateVisuals(dt) {
    for (const c of this.crystals) {
      if (!c.group.visible) continue;
      c.core.rotation.y += dt * 0.8;
      c.inner.rotation.y -= dt * 1.4;
      c.inner.position.y = 3.4 + Math.sin(this.elapsed * 2.2 + c.side) * 0.22;
      c.core.position.y = 3.4 + Math.sin(this.elapsed * 1.7 + c.side) * 0.16;
      c.shield.visible = this.shieldLeft > 0;
      if (c.shield.visible) {
        c.shield.material.opacity = 0.1 + Math.sin(this.elapsed * 4) * 0.04;
      }
    }
    for (const r of this.rotors) r.rotation.y += dt * 1.1;
  }

  #onShieldDown() {
    if (this._shieldFxDone) return;
    this._shieldFxDone = true;
    for (const c of this.crystals) {
      this.fx?.play?.('fxMagicCircle', c.group.position.x, this.deckY + 0.35, 0, 1.4);
    }
    try { audio.play('tower_crystal_shield_break', { gap: 200 }); } catch {}
    this.onEvent({ type: 'shieldDown' });
  }

  #updateBoxes(clock) {
    if (!this.isHost) return;
    if (clock) {
      // 补箱
      for (let i = 0; i < this.boxes.length; i++) {
        const b = this.boxes[i];
        if (b.active || !b.respawnAt || this.elapsed < b.respawnAt) continue;
        b.active = true;
        b.respawnAt = 0;
        if (!this.solo) this.net.send?.({ t: 'towerCrystalBox', i, by: null });
      }
      // 拾取（房主统一判：船的位置各端同步过来，AI 也只有房主在管）
      for (const [id, boat] of this.boats) {
        if (!boat) continue;
        if ((this.charges.get(id) || 0) >= D.BUBBLE_CHARGE_MAX) continue;
        for (let i = 0; i < this.boxes.length; i++) {
          const b = this.boxes[i];
          if (!b.active) continue;
          if (Math.hypot(boat.pos.x - b.x, boat.pos.z - b.z) > 3.2) continue;
          b.active = false;
          b.respawnAt = this.elapsed + D.BOX_RESPAWN;
          this.#setCharges(id, (this.charges.get(id) || 0) + 1);
          if (!this.solo) this.net.send?.({ t: 'towerCrystalBox', i, by: id, n: this.charges.get(id) });
          if (id === this.myId) this.onToast('🫧 拾取泡泡炸弹（按 1 朝对方水晶丢）');
          break;
        }
      }
    }
  }

  #setCharges(id, n) {
    const v = Math.max(0, Math.min(D.BUBBLE_CHARGE_MAX, n | 0));
    this.charges.set(id, v);
    return v;
  }

  #updateRam(clock) {
    if (!clock) return;
    for (const [id, boat] of this.boats) {
      if (!boat) continue;
      // 船主自己判自己；房主额外代判 AI（客机的船由客机上报，AI 只有房主在管）
      if (id !== this.myId && !(this.isHost && this.isAi(id))) continue;
      if (this.elapsed < (this.ramCd.get(id) || 0)) continue;
      const side = this.sideOf(id) ? 1 : 0;
      const foe = 1 - side;
      const cx = this.#crystalX(foe);
      const dx = boat.pos.x - cx, dz = boat.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > D.CRYSTAL_R + HULL) continue;
      const spd = Math.abs(boat.speed || Math.hypot(boat.vel.x, boat.vel.y));
      if (spd < D.RAM_MIN) continue;
      this.ramCd.set(id, this.elapsed + D.RAM_CD);
      const dmg = Math.round(D.RAM_BASE + spd * D.RAM_PER_SPEED);
      const nx = dist > 0.01 ? dx / dist : Math.sign(cx) || 1;
      const nz = dist > 0.01 ? dz / dist : 0;
      boat.vel.x = nx * 11;
      boat.vel.y = nz * 11;
      boat.vy = Math.max(boat.vy || 0, 1.4);
      boat.stunTimer = Math.max(boat.stunTimer || 0, 0.16);
      this.fx?.play?.('hit', cx, this.deckY + 3, 0, 1.4);
      if (this.isHost || this.solo) this.#damage(foe, dmg, id);
      else this.net.send?.({ t: 'towerCrystalHit', by: id, side: foe, dmg, x: cx, z: 0 });
    }
  }

  /** 泡泡：客机按 1 只发请求，房主扣弹药并生成飞行泡泡（所有端一起看） */
  fireBubble(id = this.myId) {
    if (this.disposed || !this.running) return false;
    const boat = this.boats.get(id);
    if (!boat) return false;
    if ((this.charges.get(id) || 0) <= 0) {
      if (id === this.myId) this.onToast('🫧 没有泡泡了 · 去撞道具箱补充');
      return false;
    }
    if (this.isHost || this.solo) {
      this.#launchBubble(id, boat);
    } else {
      this.net.send?.({ t: 'towerCrystalFire', by: id });
      this.#setCharges(id, (this.charges.get(id) || 0) - 1); // 本地乐观预扣，state 会纠正
    }
    return true;
  }

  #launchBubble(id, boat) {
    const left = this.#setCharges(id, (this.charges.get(id) || 0) - 1);
    const side = this.sideOf(id) ? 1 : 0;
    const foe = 1 - side;
    const tx = this.#crystalX(foe), tz = 0;
    const dist = Math.hypot(tx - boat.pos.x, tz - boat.pos.z);
    const dur = Math.max(0.38, dist / D.BUBBLE_SPEED);
    const spec = {
      by: id, from: boat.pos.x, fromZ: boat.pos.z,
      tx, tz, t: 0, dur, max: Math.max(0.6, dist / D.BUBBLE_SPEED),
      side: foe, popped: false,
    };
    this.#spawnBubbleVisual(spec, left);
    if (!this.solo) {
      this.net.send?.({
        t: 'towerCrystalBubble', by: id, n: left, sx: spec.from, sz: spec.fromZ,
        tx, tz, dur,
      });
    }
  }

  #spawnBubbleVisual(spec, left) {
    const mat = makeBubbleMaterial({ tint: 0xcdf4ff, opacity: 1, rim: 1.1, phase: Math.random() * TWO_PI });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.9, 20, 14), mat);
    mesh.position.set(spec.from, 2.2, spec.fromZ);
    this.group.add(mesh);
    this.bubbles.push({
      owner: spec.by, tc: spec.t, dur: spec.dur, total: spec.max,
      x: spec.from, y: 2.2, z: spec.fromZ,
      sx: spec.from, sz: spec.fromZ, tx: spec.tx, tz: spec.tz,
      side: spec.side ?? 1, mesh, mat, popped: false,
    });
    if (left != null && spec.by === this.myId) {
      // 弹药数字给本地 HUD 用；房主/客机一致
      this.charges.set(spec.by, left);
    }
  }

  #updateBubbles(dt) {
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.tc += dt;
      if (b.mesh) {
        const k = Math.min(1, b.tc / b.dur);
        b.x = b.sx + (b.tx - b.sx) * k;
        b.z = b.sz + (b.tz - b.sz) * k;
        // 抛物线：中途最高，落点是水晶核心高度
        b.y = 2.2 + Math.sin(k * Math.PI) * 3.2 + 1.2 * k;
        b.mesh.position.set(b.x, b.y, b.z);
        b.mesh.rotation.y += dt * 2;
        if (b.mat?.uniforms?.uTime) b.mat.uniforms.uTime.value += dt;
      }
      if (!b.popped && b.tc >= b.dur) this.#popBubble(b);
      if (b.popped && (!b.mesh || b.tc > b.dur + 0.4)) {
        b.mesh?.parent?.remove(b.mesh);
        b.mesh?.geometry?.dispose();
        b.mat?.dispose();
        this.bubbles.splice(i, 1);
      }
    }
  }

  #popBubble(b) {
    b.popped = true;
    this.fx?.play?.('hit', b.tx, this.deckY + 3, b.tz, 1.6);
    this.fx?.play?.('ring', b.tx, this.deckY + 0.35, b.tz, 1.6);
    if (b.mesh) {
      b.mesh.visible = false;
    }
    if (this.isHost || this.solo) {
      this.#damage(b.side, D.BUBBLE_DMG, b.owner);
      // 守军也会被泡泡推开：给"靠太近也会挨炸"的代价
      for (const [id, boat] of this.boats) {
        if (!boat) continue;
        const dx = boat.pos.x - b.tx, dz = boat.pos.z - b.tz;
        const d = Math.hypot(dx, dz);
        if (d > D.BUBBLE_R) continue;
        const nx = d > 0.01 ? dx / d : 0;
        const nz = d > 0.01 ? dz / d : 1;
        if (id === this.myId || this.isAi(id)) {
          boat.vel.x += nx * 8;
          boat.vel.y += nz * 8;
          boat.stunTimer = Math.max(boat.stunTimer || 0, 0.3);
        } else {
          this.net.send?.({ t: 'towerCrystalPopPush', id, nx, nz });
        }
      }
    }
  }

  #damage(side, amount, by) {
    if (!this.running || !this.clockOn) return;
    if (this.shieldLeft > 0) {
      if (by === this.myId) this.onToast('🛡 水晶护罩还没消失');
      return;
    }
    const before = this.hp[side];
    this.hp[side] = Math.max(0, before - amount);
    const c = this.crystals[side];
    this.fx?.play?.('hit', c.group.position.x, this.deckY + 3.2, 0, 1.5);
    this.fx?.play?.('fxHarpoonHit', c.group.position.x, this.deckY + 3.2, 0, 1.2);
    this.onEvent({ type: 'hit', side, by, dmg: amount, hp: this.hp[side], seg: this.segsOf(side) });
    if (!this.solo) {
      this.net.send?.({ t: 'towerCrystalHp', hp: this.hp, by });
    }
    if (this.hp[side] <= 0) this.#destroy(side, by);
  }

  #destroy(side, by) {
    if (!this.running) return;
    const c = this.crystals[side];
    c.group.visible = false;
    this.#burstShards(c.group.position.x, side);
    this.fx?.play?.('explosion', c.group.position.x, this.deckY + 3, 0, 2.2);
    this.fx?.play?.('fxHarpoonHit', c.group.position.x, this.deckY + 3, 0, 2.0);
    try { audio.play('tower_crystal_shatter', { gap: 260 }); } catch {}
    const winnerSide = 1 - side;
    this.onEvent({ type: 'destroy', side, by, winnerSide });
    if (!this.solo) this.net.send?.({ t: 'towerCrystalDown', side, by, winnerSide });
    if (this.isHost || this.solo) this.#finish(false, winnerSide);
  }

  /** 破碎：一小把八面体碎片飞散（水晶本体隐藏，碎片只活 1 秒） */
  #burstShards(x, side = 0) {
    const col = SIDE_COLOR[side] || SIDE_COLOR[0];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.28 + Math.random() * 0.3, 0),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95 }),
      );
      m.position.set(x, this.deckY + 3.2, 0);
      this.scene.add(m);
      const a = Math.random() * TWO_PI;
      this.shards.push({
        mesh: m, life: 1.0 + Math.random() * 0.4,
        vx: Math.cos(a) * (5 + Math.random() * 7),
        vy: 3 + Math.random() * 7,
        vz: Math.sin(a) * (5 + Math.random() * 7),
      });
    }
  }

  #updateShards(dt) {
    for (let i = this.shards.length - 1; i >= 0; i--) {
      const s = this.shards[i];
      s.life -= dt;
      s.vy -= 16 * dt;
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.mesh.rotation.x += dt * 8;
      s.mesh.rotation.z += dt * 6;
      if (s.mesh.material) s.mesh.material.opacity = Math.max(0, s.life);
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        this.shards.splice(i, 1);
      }
    }
  }

  /**
   * AI：没攒满弹药先去吃箱子；有弹药就沿 z=±6 的车道压到对方水晶前
   * （车道避开中央塔柱和 x=±10.5 的旋转障碍）。
   */
  aiTarget(boat, id) {
    if (!boat) return null;
    const side = this.sideOf(id) ? 1 : 0;
    const has = (this.charges.get(id) || 0) > 0;
    if (!has) {
      let best = null, bd = Infinity;
      for (const b of this.boxes) {
        if (!b.active) continue;
        const d = Math.hypot(boat.pos.x - b.x, boat.pos.z - b.z);
        if (d < bd) { bd = d; best = b; }
      }
      if (best) return { x: best.x, z: best.z };
    }
    const foe = 1 - side;
    const tx = this.#crystalX(foe);
    const lane = (this.boats.size % 2 ? 1 : -1) * 6;
    // 过了中段就对准水晶，没到就压车道
    const near = Math.abs(boat.pos.x - tx) < 9;
    return { x: tx, z: near ? 0 : lane };
  }

  /** 房主：AI 有弹药且看得见水晶就自己丢（玩家按 1 才丢） */
  #updateAiFire(clock) {
    if (!clock) return;
    for (const id of this.boats.keys()) {
      if (!this.isAi(id)) continue;
      if ((this.charges.get(id) || 0) <= 0) continue;
      const boat = this.boats.get(id);
      if (!boat) continue;
      const foe = 1 - (this.sideOf(id) ? 1 : 0);
      const d = Math.hypot(boat.pos.x - this.#crystalX(foe), boat.pos.z);
      if (d > 22) continue;
      const next = this.aiFireT.get(id) || 0;
      if (this.elapsed < next) continue;
      this.aiFireT.set(id, this.elapsed + 2.6 + Math.random() * 2);
      this.#launchBubble(id, boat);
    }
  }

  // ---------------------------------------------------------------- 结算

  segsOf(side) { return Math.max(0, Math.ceil(this.hp[side] / D.SEG_HP)); }

  hpRatio(side) { return Math.max(0, this.hp[side] / MAX_HP); }

  /** 本层 1 分钟结束：道具箱与泡泡消失（水晶 / 掩体保留） */
  clearPickups() {
    for (const b of this.boxes) { b.active = false; b.respawnAt = 1e9; }
    for (const b of this.bubbles) {
      if (b.mesh) b.mesh.visible = false;
      if (b.warn) b.warn.visible = false;
      b.dead = true;
    }
    this.bubbles.length = 0;
  }

  #finish(remote = false, winnerSide = null, remoteOrder = null, remoteTeams = null) {
    if (!this.running) return;
    this.running = false;
    this.timeLeft = 0;
    const ids = this.seen.size ? [...this.seen] : [...this.boats.keys()];

    let order = remoteOrder;
    let teams = remoteTeams || [];
    if (!order) {
      // 按「剩余段数」排；被击碎的那一方 -1 垫底
      const val = (id) => {
        const s = this.sideOf(id) ? 1 : 0;
        return winnerSide != null && s !== winnerSide ? -1 : this.hp[s];
      };
      const rows = ids.map((id, i) => ({ id, v: val(id), i }));
      const bySide = new Map();
      for (const r of rows) {
        const s = this.sideOf(r.id) ? 1 : 0;
        const cur = bySide.get(s) || { s, rows: [], v: -Infinity };
        cur.rows.push(r);
        cur.v = Math.max(cur.v, r.v);
        bySide.set(s, cur);
      }
      const sorted = [...bySide.values()].sort((a, b) => b.v - a.v || a.s - b.s);
      order = sorted.flatMap((t) => t.rows.sort((a, b) => b.v - a.v || a.i - b.i)
        .map((r) => ({ id: r.id, n: Math.max(0, Math.round(r.v)) })));
      teams = sorted.map((t) => ({ ids: t.rows.map((r) => r.id), n: Math.max(0, Math.round(t.v)) }));
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
      hp: [...this.hp],
    });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({ t: 'towerCrystalEnd', order, teams, hp: this.hp });
    }
  }

  // ---------------------------------------------------------------- 网络

  #sendState() {
    const ch = {};
    for (const [id, n] of this.charges) ch[id] = n;
    let mask = 0;
    this.boxes.forEach((b, i) => { if (b.active) mask |= (1 << i); });
    this.net.send?.({
      t: 'towerCrystalState',
      hp: [Math.round(this.hp[0]), Math.round(this.hp[1])],
      sh: +this.shieldLeft.toFixed(1),
      left: +this.timeLeft.toFixed(1),
      ch, bx: mask,
    });
  }

  applyNet(e) {
    if (!e || this.disposed) return;
    switch (e.t) {
      case 'towerCrystalState':
        if (!this.isHost) {
          if (Array.isArray(e.hp)) this.hp = e.hp.map((v) => Math.max(0, +v));
          if (Number.isFinite(e.sh)) this.shieldLeft = e.sh;
          if (Number.isFinite(e.left)) this.timeLeft = e.left;
          if (e.ch) {
            for (const [id, n] of Object.entries(e.ch)) this.charges.set(id, +n);
          }
          if (Number.isFinite(e.bx)) {
            this.boxes.forEach((b, i) => { b.active = !!(e.bx & (1 << i)); });
          }
          this.clockOn = this.clockOn || this.started;
        }
        break;
      case 'towerCrystalBox':
        if (!this.isHost) {
          const b = this.boxes[e.i];
          if (b) b.active = e.by == null;
          if (e.by && e.by === this.myId && Number.isFinite(e.n)) this.charges.set(this.myId, e.n);
        }
        break;
      case 'towerCrystalFire':
        if (this.isHost) {
          const boat = this.boats.get(e.by);
          if (boat && (this.charges.get(e.by) || 0) > 0) this.#launchBubble(e.by, boat);
        }
        break;
      case 'towerCrystalBubble':
        // 客机只做视觉：房主生成时已经在本地放过一份，不会收到自己的广播
        if (!this.isHost) {
          this.#spawnBubbleVisual({
            by: e.by, from: e.sx, fromZ: e.sz, tx: e.tx, tz: e.tz,
            t: 0, dur: e.dur, max: e.dur,
          }, e.n);
        }
        break;
      case 'towerCrystalHp':
        if (!this.isHost) {
          if (Array.isArray(e.hp)) this.hp = e.hp.map((v) => Math.max(0, +v));
        }
        break;
      case 'towerCrystalHit':
        if (this.isHost) this.#damage(e.side, e.dmg, e.by);
        break;
      case 'towerCrystalPopPush': {
        if (e.id === this.myId || this.isAi(e.id)) {
          const boat = this.boats.get(e.id);
          if (boat) {
            boat.vel.x += (e.nx || 0) * 8;
            boat.vel.y += (e.nz || 0) * 8;
            boat.stunTimer = Math.max(boat.stunTimer || 0, 0.3);
          }
        }
        break;
      }
      case 'towerCrystalDown':
        if (!this.isHost) {
          const c = this.crystals[e.side | 0];
          if (c) c.group.visible = false;
          this.#burstShards(c?.group.position.x || 0);
          this.fx?.play?.('explosion', c?.group.position.x || 0, this.deckY + 3, 0, 2.2);
        }
        break;
      case 'towerCrystalEnd': {
        const order = Array.isArray(e.order)
          ? e.order.map((r) => ({ id: r.id, n: r.n | 0 })) : null;
        const teams = Array.isArray(e.teams)
          ? e.teams.map((t) => ({ ids: t.ids || [], n: t.n | 0 })) : null;
        if (this.running) this.#finish(true, null, order, teams);
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
      shield: Math.max(0, this.shieldLeft),
      mine: this.segsOf(side),
      foe: this.segsOf(1 - side),
      mineHp: this.hpRatio(side),
      foeHp: this.hpRatio(1 - side),
      charges: this.charges.get(this.myId) || 0,
      running: this.running,
      order: this.order,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.boxField?.dispose();
    this.boxField = null;
    for (const b of this.bubbles) {
      b.mesh?.parent?.remove(b.mesh);
      b.mesh?.geometry?.dispose();
      b.mat?.dispose();
    }
    this.bubbles.length = 0;
    for (const s of this.shards) {
      this.scene.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
    }
    this.shards.length = 0;
    // 注意：cloneProp 出来的道具几何/材质是和 GLB 缓存共享的，
    // 这里只摘场景，不能 dispose，否则再进天梯这批道具会变黑/丢失。
    this.scene.remove(this.group);
  }
}
