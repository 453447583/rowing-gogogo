import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { BOSS_MINIONS } from '../data/bosses.js';
import { loadMonsterModel, instantiateMonsterModel } from './Boss.js';
import { BoatWeapons } from './BoatWeapons.js';
import { cloneProp } from './propLoader.js';
import { DamageNumbers } from '../ui/damageNumbers.js';
import { audio } from '../audio/AudioEngine.js';

/**
 * 云端天梯第 6 层：塔防 · 杀怪竞速。
 *
 * 用户口径（2026-11-25）
 * --------------------
 * 怪物模式里那套小怪冲过来，各赛艇用自己的主炮打；谁打掉的怪物多谁赢，
 * 组队时按队伍总分算。怪物的移动与技能释放沿用怪物模式。
 *
 * 复用了什么（尽量不新造轮子）：
 *   怪物数据   BOSS_MINIONS（岩窟兽 / 冰霜企鹅 / 血魔 / 巨鲸鲨）
 *   模型与动作 loadMonsterModel + instantiateMonsterModel（Boss.js 导出）
 *   移动/攻击  照抄 BossMode.#updateMinions 的口径：追最近的船、进半径就爪击
 *   玩家火力   BoatWeapons（J 键，弹道/过热/炮口特效/齐射全是现成一套）
 *
 * 没有实例化 BossMode：那套会接管主循环、血条、复活与结算。
 * 这里只借用它的"小怪行为规格"，命中与计分在本层做。
 *
 * 天梯没有血条：小怪打中玩家只给「失控 + 击退 + 飘字」，不会把人打死；
 * 玩家撞小怪照样掉血（沿用船速 × 0.9 的口径）。
 */

const D = SKY_TOWER.DEFENSE;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(D.LAYER) + 0.30;
// 同屏小怪 id 自增（联机快照按它对齐）
let minionSeq = 0;

const MINION_ORDER = ['beast', 'penguin', 'blood', 'whale_shark'];

export class SkyTowerDefense {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = D.LAYER;
    this.deckY = DECK_Y;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.fx = opts.fx || null;
    this.camera = opts.camera || null;
    this.input = opts.input || null;
    this.net = opts.net || { send() {} };
    this.onScore = opts.onScore || (() => 0);
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.teamOf = typeof opts.teamOf === 'function' ? opts.teamOf : null;

    this.boats = new Map();
    this.weapons = new Map();
    this.minions = [];
    this.byId = new Map();
    this.kills = new Map();        // id -> 击杀积分
    this.wave = 0;
    this.nextIn = D.WAVE_FIRST;
    this.timeLeft = D.DURATION;
    this.started = false;
    this.running = true;
    this.order = [];
    this.teamTotals = [];
    this.disposed = false;
    this.dmgFx = null;
    this._stateT = 0;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-defense';
    this.group.position.y = this.deckY;
    scene.add(this.group);
    this.#buildDecor();
  }

  // ---------------------------------------------------------------- 场地

  #buildDecor() {
    const R = layerRadius(this.layer);
    for (let i = 0; i < D.POLE_COUNT; i++) {
      const a = (i / D.POLE_COUNT) * TWO_PI + Math.PI / 12;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.96, 0.05, Math.sin(a) * R * 0.96);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
    for (let i = 0; i < D.ARCH_COUNT; i++) {
      const a = (i / D.ARCH_COUNT) * TWO_PI + Math.PI / 5;
      cloneProp('/models/props/shortcut_arch.glb', 11, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.84, 0.05, Math.sin(a) * R * 0.84);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'shortcut_arch';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 每帧

  update(dt, entries = []) {
    if (this.disposed) return;
    this.boats = new Map(entries.map((e) => [e.id, e.boat]));

    if (!this.started && entries.length) {
      this.started = true;
      this.onEvent({ type: 'start' });
    }

    // 主炮：本地玩家跟 J 键，AI 一直开火（船头朝怪由 driveAi 负责）
    for (const [id, boat] of this.boats) {
      if (!boat?.def) continue;
      let w = this.weapons.get(id);
      if (!w) {
        w = this.#makeWeapons(id);
        this.weapons.set(id, w);
      }
      if (w.def?.id !== boat.def.id) w.setBoat(boat.def);
      const firing = id === this.myId ? !!this.input?.fire : true;
      w.update(dt, boat, { firing, active: true });
      w.updateChargeOrb?.(boat);
    }

    if (this.started && this.running) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.#finish();
    }

    // 波次：房主（或单人）生成，客机等快照
    if (this.started && this.running && (this.isHost || this.solo)) {
      this.nextIn -= dt;
      if (this.nextIn <= 0 && this.minions.filter((m) => m.alive).length < D.MAX_ALIVE) {
        this.nextIn += D.WAVE_INTERVAL;
        this.#spawnWave();
      }
    }

    this.#updateMinions(dt);
    this.#updateBolts(dt);

    if (this.isHost && !this.solo && this.started) {
      this._stateT -= dt;
      if (this._stateT <= 0) { this.#sendState(); this._stateT = 0.1; }
    }
  }

  #makeWeapons(ownerId) {
    return new BoatWeapons(this.scene, {
      fx: this.fx,
      // 这一层没有 BOSS，主炮靠船头朝向 + 宽炮塔修正打怪
      getBoss: () => null,
      getObstacles: () => [],
      getMinions: () => this.minions,
      onMinionHit: (m, dmg) => this.#hitMinion(m, dmg, ownerId),
      onHit: () => {},
      onImpact: () => {},
    });
  }

  // ---------------------------------------------------------------- 刷怪

  #spawnWave() {
    this.wave += 1;
    const n = this.wave;
    const count = Math.min(6, 2 + Math.floor(n * 0.55));
    const pool = ['beast'];
    if (n >= D.UNLOCK.penguin) pool.push('penguin');
    if (n >= D.UNLOCK.blood) pool.push('blood');
    if (n >= D.UNLOCK.whale_shark && n % 3 === 0) pool.push('whale_shark');
    const R = layerRadius(this.layer) * D.SPAWN_R;
    const base = Math.random() * TWO_PI;
    const spawned = [];
    for (let i = 0; i < count; i++) {
      if (this.minions.filter((m) => m.alive).length >= D.MAX_ALIVE) break;
      const type = pool[(Math.random() * pool.length) | 0];
      const a = base + (i / count) * TWO_PI + (Math.random() - 0.5) * 0.5;
      const m = this.#makeMinion(type, Math.cos(a) * R, Math.sin(a) * R);
      spawned.push({ i: m.id, t: m.type, x: +m.pos.x.toFixed(2), z: +m.pos.z.toFixed(2) });
    }
    try { audio.play('tower_minion_spawn', { gap: 120 }); } catch {}
    this.onEvent({ type: 'wave', n, count: spawned.length });
    if (!this.solo && this.isHost) {
      this.net.send?.({ t: 'towerDefSpawn', n, m: spawned });
    }
  }

  #makeMinion(type, x, z, fixedId = 0) {
    const def = BOSS_MINIONS[type] || BOSS_MINIONS.beast;
    const mesh = new THREE.Group();
    mesh.position.set(x, this.deckY + 0.18, z);
    this.scene.add(mesh);
    const hp = Math.max(20, Math.round(def.hp * D.HP_MUL));
    const m = {
      id: fixedId || (++minionSeq),
      type, def, mesh,
      pos: new THREE.Vector3(x, this.deckY, z),
      hp, maxHp: hp,
      t: Math.random() * 6,
      heading: 0, alive: true, dying: 0, hitCd: 0, castCd: 1.5,
      walkAction: null, attackAction: null, dieAction: null, mixer: null,
    };
    this.minions.push(m);
    this.byId.set(m.id, m);
    this.#loadRig(m);
    this.fx?.play?.('tornado', x, this.deckY + 0.8, z, 0.8);
    return m;
  }

  /** 把 walk/attack/die 三集骨骼动画拼到同一只怪上（同 BossMode.#loadMinionRig） */
  async #loadRig(m) {
    const def = m.def;
    let gltf;
    try { gltf = await loadMonsterModel(def.model); } catch { return; }
    const clips = [...(gltf.animations || [])];
    for (const url of def.clipModels || []) {
      try {
        const extra = await loadMonsterModel(url);
        clips.push(...(extra.animations || []));
      } catch {}
    }
    if (this.disposed || !m.mesh) return;
    const root = instantiateMonsterModel(gltf, { height: def.fitHeight || 3.2, sink: 0.25 });
    m.mesh.add(root);
    m.model = root;
    if (!clips.length) return;
    const byName = new Map(clips.map((c) => [c.name, c]));
    const named = (k) => (def.anims?.[k] ? byName.get(def.anims[k]) : null);
    const match = (re) => clips.find((c) => re.test(c.name || ''));
    const walk = named('walk') || named('move') || match(/walk|run|move|swim/i) || clips[0];
    const atk = named('attack') || match(/attack|atk|bite|claw/i);
    const die = named('die') || match(/death|die|dead/i);
    m.mixer = new THREE.AnimationMixer(root);
    if (walk) { m.walkAction = m.mixer.clipAction(walk); m.walkAction.play(); }
    if (atk) {
      m.attackAction = m.mixer.clipAction(atk);
      m.attackAction.setLoop(THREE.LoopOnce, 1);
      m.attackAction.clampWhenFinished = true;
    }
    if (die) {
      m.dieAction = m.mixer.clipAction(die);
      m.dieAction.setLoop(THREE.LoopOnce, 1);
      m.dieAction.clampWhenFinished = true;
    }
  }

  // ---------------------------------------------------------------- 小怪 AI

  #updateMinions(dt) {
    for (let i = this.minions.length - 1; i >= 0; i--) {
      const m = this.minions[i];
      if (!m.alive) {
        m.dying -= dt;
        m.mixer?.update(dt);
        if (m.dying <= 0) this.#removeMinion(i);
        continue;
      }
      // 客机不跑 AI，位置由房主快照覆盖
      if (!this.isHost && !this.solo) { m.mixer?.update(dt); continue; }

      m.t += dt;
      m.mixer?.update(dt);
      m.hitCd = Math.max(0, m.hitCd - dt);
      m.castCd = Math.max(0, m.castCd - dt);
      const target = this.#nearest(m.pos);
      if (!target) continue;
      const dx = target.boat.pos.x - m.pos.x;
      const dz = target.boat.pos.z - m.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      m.heading = Math.atan2(dx, dz);
      const reach = (m.def.radius || 2) + 2.6;

      if (d <= reach) {
        // 近战：爪击。天梯不扣血，只给失控 + 击退
        if (m.hitCd <= 0) {
          m.hitCd = m.def.attackCooldown || 1.6;
          this.#playAttack(m);
          this.fx?.play?.('hit', target.boat.pos.x, this.deckY + 1.2, target.boat.pos.z, 0.9);
          if (this.isHost || this.solo) this.#hurtPlayer(target, m);
        }
      } else {
        // 远程怪：停在 10~18m 施法（血魔飞刀 / 巨鲸鲨泡泡）
        const ranged = m.def.rangedRange || m.def.bubbleRange || 0;
        if (ranged > 0 && d < ranged && d > 8 && m.castCd <= 0) {
          m.castCd = D.RANGED_CD;
          this.#playAttack(m);
          this.#shootBolt(m, target);
        } else {
          const step = Math.min(m.def.speed * D.SPEED_MUL, 13) * dt;
          m.pos.x += (dx / d) * step;
          m.pos.z += (dz / d) * step;
          m.walkAction?.setEffectiveTimeScale(
            THREE.MathUtils.clamp((m.def.speed || 8) / 7, 0.6, 1.6),
          );
        }
      }

      m.mesh.position.set(m.pos.x, this.deckY + 0.18 + Math.sin(m.t * 6) * 0.06, m.pos.z);
      m.mesh.rotation.y = m.heading;

      // 玩家高速撞怪：照样能撞死（和怪物模式同一口径）
      for (const [, boat] of this.boats) {
        const md = Math.hypot(boat.pos.x - m.pos.x, boat.pos.z - m.pos.z);
        if (md < (m.def.radius || 2) + 2.6 && (boat.speed || 0) > 9) {
          this.#hitMinion(m, (boat.speed || 0) * D.RAM_DMG, this.#ownerOf(boat), true);
          boat.vel.multiplyScalar(0.86);
          break;
        }
      }
    }
  }

  #playAttack(m) {
    if (m.attackAction) {
      m.attackAction.reset();
      m.attackAction.play();
    }
  }

  #nearest(pos) {
    let best = null, bd = Infinity;
    for (const [id, boat] of this.boats) {
      const d = Math.hypot(boat.pos.x - pos.x, boat.pos.z - pos.z);
      if (d < bd) { bd = d; best = { id, boat }; }
    }
    return best;
  }

  #ownerOf(boat) {
    for (const [id, b] of this.boats) if (b === boat) return id;
    return null;
  }

  // ---------------------------------------------------------------- 远程弹

  #shootBolt(m, target) {
    const dx = target.boat.pos.x - m.pos.x;
    const dz = target.boat.pos.z - m.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    this.bolts ||= [];
    this.bolts.push({
      x: m.pos.x, z: m.pos.z,
      vx: (dx / d) * D.RANGED_SPEED, vz: (dz / d) * D.RANGED_SPEED,
      t: 1.2, from: m.id,
    });
    this.fx?.play?.('fxArcBolt', m.pos.x, this.deckY + 1.4, m.pos.z, 0.8);
  }

  #updateBolts(dt) {
    if (!this.bolts?.length) return;
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t -= dt;
      b.x += b.vx * dt;
      b.z += b.vz * dt;
      let hit = false;
      for (const [id, boat] of this.boats) {
        if (Math.hypot(boat.pos.x - b.x, boat.pos.z - b.z) < 2.6) {
          if (this.isHost || this.solo) {
            boat.stunTimer = Math.max(boat.stunTimer || 0, 0.3);
            boat.slowTimer = Math.max(boat.slowTimer || 0, 0.8);
            this.onEvent({ type: 'hurt', id, dmg: D.RANGED_DMG, ranged: true });
          }
          hit = true;
          break;
        }
      }
      if (hit || b.t <= 0) this.bolts.splice(i, 1);
    }
  }

  #hurtPlayer(target, m) {
    const boat = target.boat;
    boat.stunTimer = Math.max(boat.stunTimer || 0, D.HURT_STUN);
    const dx = boat.pos.x - m.pos.x, dz = boat.pos.z - m.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    boat.vel.x += (dx / d) * D.HURT_PUSH;
    boat.vel.y += (dz / d) * D.HURT_PUSH;
    this.onEvent({ type: 'hurt', id: target.id, dmg: m.def.contactDamage || 6 });
    if (!this.solo && this.isHost) {
      this.net.send?.({ t: 'towerDefHurt', id: target.id, dmg: m.def.contactDamage || 6 });
    }
  }

  // ---------------------------------------------------------------- 伤害 / 击杀

  #hitMinion(m, dmg, ownerId, ram = false) {
    if (!m?.alive || m.dying) return;
    if (!this.isHost && !this.solo) {
      // 客机：本地先掉血做反馈，权威扣血由房主快照覆盖
      m.hp -= dmg;
      this.#spawnDamage(Math.round(dmg), m.pos.x, this.deckY + 2.6, m.pos.z);
      if (ownerId === this.myId) {
        this.net.send?.({ t: 'towerDefHit', i: m.id, dmg, ram });
      }
      return;
    }
    m.hp -= dmg;
    this.#spawnDamage(Math.round(dmg), m.pos.x, this.deckY + 2.6, m.pos.z);
    if (m.hp <= 0) this.#kill(m, ownerId);
  }

  #kill(m, ownerId) {
    if (!m.alive) return;
    m.alive = false;
    m.dying = 0.8;
    if (m.dieAction) {
      m.dieAction.reset();
      m.dieAction.play();
    }
    this.fx?.play?.('explosion', m.pos.x, this.deckY + 1.2, m.pos.z, 0.7);
    const pts = D.POINTS[m.type] || 1;
    if (ownerId) {
      this.kills.set(ownerId, (this.kills.get(ownerId) || 0) + pts);
      this.onScore(ownerId, pts, 'kill');
    }
    this.onEvent({ type: 'kill', id: ownerId, pts, monster: m.type });
  }

  #removeMinion(i) {
    const m = this.minions[i];
    if (!m) return;
    this.byId.delete(m.id);
    this.scene.remove(m.mesh);
    m.mesh.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach((mm) => mm.dispose());
      }
    });
    this.minions.splice(i, 1);
  }

  #spawnDamage(amount, x, y, z) {
    if (!this.camera || typeof document === 'undefined' || !amount) return;
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return;
    const px = (v.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-v.y * 0.5 + 0.5) * window.innerHeight;
    if (!this.dmgFx) this.dmgFx = new DamageNumbers();
    this.dmgFx.spawn({ value: Math.round(amount), crit: false, x: px, y: py, scale: 0.85 });
  }

  // ---------------------------------------------------------------- 结算

  #finish(remote = false) {
    if (!this.running) return;
    this.running = false;
    this.timeLeft = 0;

    // 个人积分 → 队伍汇总（没队伍就每人一队）
    const ids = [...this.boats.keys()];
    for (const id of this.kills.keys()) if (!ids.includes(id)) ids.push(id);
    if (this.teamOf) {
      const byTeam = new Map();
      for (const id of ids) {
        const team = this.teamOf(id);
        const key = team == null ? `solo:${id}` : `t:${team}`;
        const cur = byTeam.get(key) || { key, ids: [], pts: 0 };
        cur.ids.push(id);
        cur.pts += this.kills.get(id) || 0;
        byTeam.set(key, cur);
      }
      this.teamTotals = [...byTeam.values()].sort((a, b) => b.pts - a.pts);
      this.order = this.teamTotals.flatMap((t) => t.ids.map((id) => ({ id, n: this.kills.get(id) || 0 })));
    } else {
      this.teamTotals = [];
      this.order = ids.map((id) => ({ id, n: this.kills.get(id) || 0 }))
        .sort((a, b) => b.n - a.n);
    }
    this.winner = this.teamTotals[0]?.ids?.[0] || this.order[0]?.id || null;

    if (!remote && (this.isHost || this.solo)) {
      // 排名分：队伍名次 → 每个队员都拿到（用户口径：按队伍总分算）
      if (this.teamTotals.length) {
        this.teamTotals.forEach((t, i) => {
          const pts = D.SCORE_RANK[Math.min(i, D.SCORE_RANK.length - 1)];
          for (const id of t.ids) {
            const s = this.onScore(id, pts, 'rank');
            if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id, s });
          }
        });
      } else {
        this.order.forEach((r, i) => {
          const pts = D.SCORE_RANK[Math.min(i, D.SCORE_RANK.length - 1)];
          const s = this.onScore(r.id, pts, 'rank');
          if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id: r.id, s });
        });
      }
    }

    this.onEvent({
      type: 'finish',
      order: this.order,
      teams: this.teamTotals.map((t) => ({ ids: t.ids, pts: t.pts })),
    });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({
        t: 'towerDefEnd',
        order: this.order,
        teams: this.teamTotals.map((t) => ({ ids: t.ids, pts: t.pts })),
      });
    }
  }

  // ---------------------------------------------------------------- 网络

  #sendState() {
    const m = this.minions.filter((x) => x.alive || x.dying > 0)
      .map((x) => ({
        i: x.id, t: x.type,
        x: +x.pos.x.toFixed(2), z: +x.pos.z.toFixed(2),
        h: Math.max(0, Math.round(x.hp)),
      }));
    this.net.send?.({
      t: 'towerDefState',
      m,
      k: Object.fromEntries(this.kills),
      wave: this.wave,
      left: +this.timeLeft.toFixed(1),
    });
  }

  applyNet(e) {
    if (!e || this.disposed) return;
    switch (e.t) {
      case 'towerDefSpawn':
        this.wave = Math.max(this.wave, e.n | 0);
        for (const s of e.m || []) {
          if (!this.byId.has(s.i)) this.#makeMinion(s.t, s.x, s.z, s.i);
        }
        break;
      case 'towerDefState': {
        const seen = new Set();
        for (const s of e.m || []) {
          seen.add(s.i);
          let m = this.byId.get(s.i);
          if (!m) m = this.#makeMinion(s.t, s.x, s.z, s.i);
          m.pos.set(s.x, this.deckY, s.z);
          m.hp = s.h;
          if (m.alive) m.mesh.position.set(s.x, this.deckY + 0.18, s.z);
        }
        for (const m of this.minions) {
          if (m.alive && !seen.has(m.id)) this.#kill(m, null);
        }
        if (e.k) this.kills = new Map(Object.entries(e.k).map(([k, v]) => [k, +v]));
        this.wave = Math.max(this.wave, e.wave | 0);
        if (Number.isFinite(e.left)) this.timeLeft = e.left;
        break;
      }
      case 'towerDefHit':
        if (this.isHost) this.#hitMinion(this.byId.get(e.i | 0), e.dmg, e.id || null, !!e.ram);
        break;
      case 'towerDefHurt':
        if (!this.isHost) {
          const boat = this.boats.get(e.id);
          if (boat) boat.stunTimer = Math.max(boat.stunTimer || 0, D.HURT_STUN);
          this.onEvent({ type: 'hurt', id: e.id, dmg: e.dmg });
        }
        break;
      case 'towerDefEnd':
        if (this.running) {
          if (Array.isArray(e.order)) {
            this.order = e.order.map((r) => ({ id: r.id, n: r.n | 0 }));
            this.teamTotals = (e.teams || []).map((t) => ({ ids: t.ids, pts: t.pts }));
            this.winner = this.teamTotals[0]?.ids?.[0] || this.order[0]?.id || null;
          }
          this.#finish(true);
        }
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- 展示

  killsOf(id) { return this.kills.get(id) || 0; }

  /** AI：朝最近的小怪开 */
  aiTarget(boat) {
    let best = null, bd = Infinity;
    for (const m of this.minions) {
      if (!m.alive) continue;
      const d = Math.hypot(boat.pos.x - m.pos.x, boat.pos.z - m.pos.z);
      if (d < bd) { bd = d; best = m; }
    }
    return best ? { x: best.pos.x, z: best.pos.z } : null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.weapons.values()) w.clear?.();
    this.weapons.clear();
    for (let i = this.minions.length - 1; i >= 0; i--) this.#removeMinion(i);
    this.bolts = [];
    this.dmgFx?.destroy();
    this.dmgFx = null;
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
