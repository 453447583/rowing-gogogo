import * as THREE from 'three';
import { getBoatWeapon } from '../data/boatWeapons.js';
import { BOSS_FIRE_CORE } from '../data/bosses.js';
import { loadEffectTexture } from './effectTextures.js';
import { nitroAttackFx } from './nitroFx.js';

// 舰炮特效贴图：全部来自 public/effects 现成素材，不额外下载资源
const TEX = {
  flame: '/effects/Basic/Texture/Flame01.png',
  spark: '/effects/Basic/Texture/Particle01.png',
  splash: '/effects/Basic/Texture/Splash01.png',
  laser: '/effects/Basic/Texture/LaserMain01.png',
  wind: '/effects/Basic/Texture/Wind01.png',
};

// 船头到炮口的距离（视觉上从船首发射，而不是从船中心）
const BOW_OFFSET = 2.9;
// 每套主炮一个独立前缀：玩家和 AI 陪练可能用同一种艇，
// 挂载特效的 key 必须在 Effects 里全局唯一，否则会互相 stop。
let weaponSeq = 0;
// 炮塔自动修正的最大偏角（约 100°）：横移躲技能时也能打中 BOSS，
// 但背对目标（按 S 后退/掉头）时打不到——开火前得先摆正船头。
// BOSS 模式会通过 opts.turretYaw 收窄到 ~35°，逼玩家自己把船头对准目标。
const MAX_TURRET_YAW = 1.75;

/**
 * 赛艇主炮系统：船头开火、按艇型走不同的弹道。
 * 只负责“发射 + 弹道 + 特效”，伤害结算交给 BossMode（由它算弱点倍率）。
 */
export class BoatWeapons {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.opts = opts;
    this.def = null;
    this.heat = 0;
    this.overheat = 0;
    this.cool = 0;
    this.chargeT = 0;
    this.charging = false;
    // 炮塔修正上限：模式可覆盖（BOSS 模式收窄，竞速/道具模式保持原来的宽角）
    this.turretYaw = Number.isFinite(opts.turretYaw) ? opts.turretYaw : MAX_TURRET_YAW;
    // 天气偏航（弧度）：海克斯暴风/暴雪下主炮每发随机偏一点，0 = 不偏
    this.aimJitter = 0;
    // 竞技场卡牌「连射装置」：射速倍率，默认 1
    this.fireRateMul = 1;
    // 火力核心强化：true 时齐射弹丸 ×3、单颗伤害降低、齐射总伤提升
    this.overload = false;
    this.projectiles = [];
    this.flashes = [];
    this.shotSeq = 0;
    this.shotPrefix = 'cannon' + (++weaponSeq);
    this.fx = opts.fx || null; // Effects（Effekseer 运行时）：飞行体与炮口闪光都用它
    // 怪物模式打 BOSS 的弹道要够远（几十米外），默认体积在追尾视角里几乎看不见：
    // 弹丸放大 + 后方留一串残留粒子当飞行轨迹。竞技场（人对人）保持原样。
    this.bigShotFx = opts.bigShotFx === true;
    this.shotFxScale = this.bigShotFx ? 2.8 : 1;
    this.hitFxScale = this.bigShotFx ? 1.6 : null;
    this.loader = new THREE.TextureLoader();
    this.tex = {};
    for (const [key, url] of Object.entries(TEX)) {
      this.tex[key] = loadEffectTexture(this.loader, url);
    }
  }

  setBoat(def) {
    const id = def?.id;
    if (this.def && this.def.id === id) return;
    this.def = getBoatWeapon(id);
    this.heat = 0;
    this.overheat = 0;
    this.cool = 0;
    this.chargeT = 0;
    this.charging = false;
  }

  get heatRatio() {
    return Math.max(0, Math.min(1, this.heat / 100));
  }

  /** 天气偏航（弧度）：由 BossMode 每关按天气写入，竞速/竞技场保持 0 */
  setAimJitter(rad) {
    this.aimJitter = Math.max(0, Number(rad) || 0);
  }

  /** 激光蓄力进度 0~1（其它武器恒为 0） */
  get chargeRatio() {
    if (!this.def || this.def.kind !== 'beam') return 0;
    return Math.max(0, Math.min(1, this.chargeT / this.def.chargeTime));
  }

  #sprite(kind, color, size, opacity = 1) {
    const mat = new THREE.SpriteMaterial({
      map: this.tex[kind] || this.tex.spark,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(size);
    return s;
  }

  /**
   * 炮口方向：船头 + 有限角度的“炮塔修正”。
   * 横移时船头会转到侧面，炮塔能把它拽回来；完全背对就会打偏。
   */
  #aim(boat) {
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const ox = boat.pos.x + fx * BOW_OFFSET;
    const oz = boat.pos.z + fz * BOW_OFFSET;
    const oy = (boat.pos.y || 0) + 1.15;
    let ang = 0;
    const boss = this.opts.getBoss?.();
    if (boss && !boss.dead) {
      const bx = boss.pos.x - ox;
      const bz = boss.pos.z - oz;
      const want = Math.atan2(bx, bz);
      let diff = want - boat.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      ang = Math.max(-this.turretYaw, Math.min(this.turretYaw, diff));
    }
    const yaw = boat.heading + ang;
    return { ox, oy, oz, fx, fz, ax: Math.sin(yaw), az: Math.cos(yaw) };
  }

  #muzzle(boat, kind) {
    const d = this.def;
    const s = this.#sprite(kind, d.glow, d.kind === 'beam' ? 2.4 : 2.0, 0.95);
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const mx = boat.pos.x + fx * BOW_OFFSET;
    const my = (boat.pos.y || 0) + 1.25;
    const mz = boat.pos.z + fz * BOW_OFFSET;
    s.position.set(mx, my, mz);
    this.scene.add(s);
    this.flashes.push({ sprite: s, t: 0.16, life: 0.16, grow: d.kind === 'beam' ? 2.2 : 1.4 });
    // Effekseer 炮口闪光：短促、带方向感，比单个 Sprite 更像“真的开炮了”
    this.fx?.play(d.fxMuzzle, mx, my, mz);
  }

  /** 超载炮口：船头左右再各补一次小闪光，视觉上“一次打出三股” */
  #muzzleFan(boat, kind) {
    const d = this.def;
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    // 船体右向（俯视时船头方向旋转 90°）
    const rx = -fz;
    const rz = fx;
    const my = (boat.pos.y || 0) + 1.05;
    for (const side of [-1, 1]) {
      const s = this.#sprite(kind, d.glow, 1.55, 0.9);
      s.position.set(
        boat.pos.x + fx * BOW_OFFSET + rx * side * 1.05,
        my,
        boat.pos.z + fz * BOW_OFFSET + rz * side * 1.05,
      );
      this.scene.add(s);
      this.flashes.push({ sprite: s, t: 0.16, life: 0.16, grow: 1.2 });
    }
  }

  /** 焚风灼膛锁 J 时调用：就地取消蓄力，不走“提前松手自动发射”的分支 */
  cancelCharge() {
    this.charging = false;
    this.chargeT = 0;
  }

  update(dt, boat, { firing = false, active = true, overload = false } = {}) {
    const d = this.def;
    if (!d) return;
    this.overload = !!overload;
    // 散热：移动时水冷更快，站桩炮台会过热 → 鼓励“边跑边打”
    const moving = (boat?.speed || 0) > 3;
    this.overheat = Math.max(0, this.overheat - dt);
    if (this.overheat > 0) {
      this.heat = Math.max(0, this.heat - 58 * dt);
    } else {
      this.heat = Math.max(0, this.heat - (moving ? d.cool : d.cool * 0.5) * dt);
    }
    this.cool = Math.max(0, this.cool - dt);

    if (!boat || !active) {
      this.charging = false;
      this.chargeT = 0;
    } else if (d.kind === 'beam') {
      if (firing && this.overheat <= 0 && this.cool <= 0) {
        this.charging = true;
        this.chargeT = Math.min(d.chargeTime, this.chargeT + dt);
        // 蓄满自动放出：按住 J 不放也能持续开火，不用刻意松手
        if (this.chargeT >= d.chargeTime) {
          this.#fireBeam(boat, 1);
          this.charging = false;
          this.chargeT = 0;
        }
      } else if (this.charging) {
        // 提前松手：按当前蓄力比例发射（伤害更低）
        this.#fireBeam(boat, Math.min(1, this.chargeT / d.chargeTime));
        this.charging = false;
        this.chargeT = 0;
      }
    } else if (firing && this.overheat <= 0 && this.cool <= 0) {
      this.#fireVolley(boat);
      this.cool = d.cadence / (this.fireRateMul || 1);
      this.#addHeat(d.heat);
    }

    this.#updateProjectiles(dt);
    this.#updateFlashes(dt);
  }

  #addHeat(amount) {
    this.heat = Math.min(100, this.heat + amount);
    if (this.heat >= 100 && this.overheat <= 0) {
      this.overheat = 2.4;
      this.opts.onOverheat?.();
    }
  }

  #fireVolley(boat) {
    const d = this.def;
    const aim = this.#aim(boat);
    // 火力核心：弹丸数量 ×3，并把扇面撑开一点，不然单发炮的三颗会完全叠在一起
    const base = Math.max(1, d.count || 1);
    const shots = this.overload ? base * BOSS_FIRE_CORE.shotMul : base;
    const spread = this.overload ? Math.max(d.spread || 0, 0.16) : (d.spread || 0);
    for (let i = 0; i < shots; i++) {
      const t = shots === 1 ? 0 : i / (shots - 1) - 0.5;
      // 天气偏航叠在齐射扇面上：每发独立随机，偏了就是真的飞歪
      const jit = this.aimJitter > 0 ? (Math.random() * 2 - 1) * this.aimJitter : 0;
      const ang = spread * t + jit;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // 绕竖直轴旋转瞄准方向
      const vx = aim.ax * ca - aim.az * sa;
      const vz = aim.az * ca + aim.ax * sa;
      this.#spawnProjectile(d, aim, vx, vz, i % 3);
    }
    // 三重炮口：主闪光 + 左右各补一次，读作“一次打出一片”
    this.#muzzle(boat, d.muzzle);
    if (this.overload) this.#muzzleFan(boat, d.muzzle);
    this.opts.onFire?.();
  }

  /**
   * 飞行体：不再用 three.js 的球芯 / 白光晕 / 线段拖尾，
   * 直接挂该赛艇竞速氮气尾焰的同款 effekseer 粒子素材（分散成粒子飞向 BOSS）。
   * 速度、数量、散布、伤害等玩法参数全部保持原样。
   */
  #spawnProjectile(d, aim, vx, vz, index, extra = {}) {
    const pos = new THREE.Vector3(aim.ox, aim.oy + (index === 1 ? 0.12 : 0), aim.oz);
    // 伤害在发射那一刻就固定：超载期间打出去的弹丸不会因为 buff 结束而变弱
    const dmg = extra.damage ?? d.damage * (this.overload ? BOSS_FIRE_CORE.shotDamage : 1);
    const shot = {
      pos,
      def: d,
      dmg,
      crit: !!extra.crit,
      vx: vx * d.speed,
      vz: vz * d.speed,
      life: d.life,
      homing: d.homing || 0,
      fxKey: `${this.shotPrefix}-${++this.shotSeq}`,
    };
    const cfg = nitroAttackFx(d.id) || { fx: 'itemBeam', scale: 0.22, color: null };
    const size = (d.kind === 'blade' || d.kind === 'torpedo' ? 1.15 : 1) * this.shotFxScale;
    this.fx?.playAttached(shot.fxKey, cfg.fx, () => shot.pos, this.bigShotFx
      // 打 BOSS：周期补发新的粒子团、旧的留在原地，连成一条能看清的飞行轨迹。
      // pool 只留 6 发，8 人齐射也不会把 Effekseer 实例堆爆。
      ? {
        life: d.life + 0.2, loop: true, scale: cfg.scale * size, color: cfg.color,
        loopEvery: 0.07, pool: 6, trail: true,
      }
      : { life: d.life + 0.2, loop: true, scale: cfg.scale * size, color: cfg.color });
    this.projectiles.push(shot);
  }

  /**
   * 青锋号的蓄力激光改成高速粒子弹道：
   * 伤害（含蓄力加成）与过载倍率、热量、射速全部保持原值，
   * 视觉和其余赛艇一样，用该艇氮气尾焰的粒子素材飞向 BOSS。
   */
  #fireBeam(boat, charge) {
    const d = this.def;
    const aim = this.#aim(boat);
    // 只在发射这一帧用一份派生参数，不改动 this.def 上的任何数值
    // 150 m/s × 1.0 s = 原激光 150m 射程
    const shotDef = { ...d, kind: 'shot', speed: 150, count: 1, spread: 0, life: 1.0, homing: 0, spin: 0 };
    const beamMul = this.overload ? BOSS_FIRE_CORE.beamDamage : 1;
    const dmg = (d.damage + d.charge * charge) * beamMul;
    // 天气偏航：蓄力激光也会被吹歪，暴雪里更该贴脸打
    const jit = this.aimJitter > 0 ? (Math.random() * 2 - 1) * this.aimJitter : 0;
    const cj = Math.cos(jit);
    const sj = Math.sin(jit);
    this.#spawnProjectile(shotDef, aim, aim.ax * cj - aim.az * sj, aim.az * cj + aim.ax * sj, 0, { damage: dmg, crit: charge >= 0.99 });
    this.#muzzle(boat, d.muzzle);
    // 激光没有齐射，超载时用三重炮口闪光补足“变强了”的视觉反馈
    if (this.overload) this.#muzzleFan(boat, d.muzzle);
    this.#addHeat(d.heat);
    this.cool = d.cadence;
  }

  #updateFlashes(dt) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t -= dt;
      const k = Math.max(0, f.t / f.life);
      f.sprite.material.opacity = k * 0.95;
      f.sprite.scale.setScalar((2 - k) * f.grow);
      if (f.t <= 0) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        this.flashes.splice(i, 1);
      }
    }
  }

  #updateProjectiles(dt) {
    const boss = this.opts.getBoss?.();
    const rocks = this.opts.getObstacles?.() || [];
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      // 追踪弹：朝 BOSS 缓慢修正（不是必中，转弯半径有限）
      if (p.homing && boss && !boss.dead) {
        const dx = boss.pos.x - p.pos.x;
        const dz = boss.pos.z - p.pos.z;
        const len = Math.hypot(dx, dz) || 1;
        const cur = Math.hypot(p.vx, p.vz) || 1;
        const turn = p.homing * dt;
        p.vx += (dx / len) * cur * turn;
        p.vz += (dz / len) * cur * turn;
        const nl = Math.hypot(p.vx, p.vz) || 1;
        p.vx = (p.vx / nl) * cur;
        p.vz = (p.vz / nl) * cur;
      }
      const pos = p.pos;
      pos.x += p.vx * dt;
      pos.z += p.vz * dt;

      let hit = false;
      for (const r of rocks) {
        if (Math.hypot(pos.x - r.x, pos.z - r.z) < r.r + 0.5) {
          this.opts.onImpact?.(pos.x, pos.y, pos.z, p.def);
          this.fx?.play(p.def.fxImpact, pos.x, 1.6, pos.z, this.hitFxScale);
          hit = true;
          break;
        }
      }
      if (!hit) {
        // 小怪优先判定：挡在弹道上的杂兵先吃伤害
        for (const m of this.opts.getMinions?.() || []) {
          if (!m.alive || m.dying) continue;
          if (Math.hypot(pos.x - m.pos.x, pos.z - m.pos.z) < (m.def.radius || 2) + 0.7) {
            this.opts.onMinionHit?.(m, p.dmg);
            this.fx?.play(p.def.fxHit, pos.x, pos.y, pos.z, this.hitFxScale);
            hit = true;
            break;
          }
        }
      }
      if (!hit && boss && !boss.dead) {
        const reach = (boss.def.radius || 5) + 0.8;
        if (Math.hypot(pos.x - boss.pos.x, pos.z - boss.pos.z) < reach) {
          this.opts.onHit?.(p.dmg, pos.x, pos.z, p.def, p.crit ? { crit: true } : {});
          this.fx?.play(p.def.fxHit, pos.x, pos.y, pos.z, this.hitFxScale);
          hit = true;
        }
      }

      if (hit || p.life <= 0) this.#removeProjectile(i);
    }
  }

  #removeProjectile(i) {
    const p = this.projectiles[i];
    if (!p) return;
    // 飞行体本身是 effekseer 挂载特效：移除弹道时同步收掉，避免残留粒子
    if (p.fxKey) this.fx?.stopAttached(p.fxKey);
    this.projectiles.splice(i, 1);
  }

  /** 蓄力时船头的光球（由 BossMode 每帧调用） */
  updateChargeOrb(boat) {
    if (!boat || !this.def || this.def.kind !== 'beam' || !this.charging) {
      if (this.chargeOrb) {
        this.scene.remove(this.chargeOrb);
        this.chargeOrb.material.dispose();
        this.chargeOrb = null;
      }
      return;
    }
    if (!this.chargeOrb) {
      this.chargeOrb = this.#sprite('laser', this.def.glow, 1.2, 1);
      this.scene.add(this.chargeOrb);
    }
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const k = this.chargeRatio;
    this.chargeOrb.position.set(
      boat.pos.x + fx * BOW_OFFSET,
      (boat.pos.y || 0) + 1.25,
      boat.pos.z + fz * BOW_OFFSET,
    );
    this.chargeOrb.scale.setScalar(0.8 + k * 3.4);
    this.chargeOrb.material.opacity = 0.5 + k * 0.5;
  }

  clear() {
    while (this.projectiles.length) this.#removeProjectile(this.projectiles.length - 1);
    for (const f of this.flashes) {
      this.scene.remove(f.sprite);
      f.sprite.material.dispose();
    }
    this.flashes.length = 0;
    if (this.chargeOrb) {
      this.scene.remove(this.chargeOrb);
      this.chargeOrb.material.dispose();
      this.chargeOrb = null;
    }
    this.heat = 0;
    this.overheat = 0;
    this.chargeT = 0;
    this.charging = false;
  }
}
