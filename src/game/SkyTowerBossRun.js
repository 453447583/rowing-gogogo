import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { BOSSES, BOSS_SKILLS } from '../data/bosses.js';
import { Boss } from './Boss.js';
import { cloneProp } from './propLoader.js';
import { DamageNumbers } from '../ui/damageNumbers.js';

/**
 * 云端天梯第 4 层：雷霆龙骑士 · 双船伤害竞速。
 *
 * 用户口径（2026-11-25）
 * --------------------
 * 一个会攻击会放技能的小 BOSS，两艘船各自打它，60 秒内伤害高者胜。
 * 复用怪物模式的龙骑士本体（dragonknight.glb + dk_anims.glb 等骨骼动作），
 * 但**不实例化 BossMode** —— 那东西会接管整局的主循环、血条、复活和结算，
 * 塞进天梯等于两套模式抢方向盘。Boss 类自己只负责"表现 + 选招 + 预警"，
 * 命中判定 / 伤害归属 / 计分 / 联机全在这一层做。
 *
 * 三招不是直接改 BOSS_SKILLS 原表（怪物模式还在用），而是**追加三个新 id**
 * （towerSlash / towerThunder / towerSweep），数值压到原版 1/3 左右。
 *
 * 高度：Boss 全家按 y=0 海面写死（本体 group、预警圈、Effekseer 坐标、
 * 落雷 skyFxY）。这里用 fx 代理统一给 y 加 deckY=54.3，并在每次
 * boss.update() 之后把 group / warning 的 y 抬回来。
 */

const D = SKY_TOWER.BOSSRUSH;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(D.LAYER) + 0.30;

/** 追加三招天梯专用技能（只加不覆盖，怪物模式零改动） */
function registerTowerSkills() {
  const add = (s) => { if (!BOSS_SKILLS[s.id]) BOSS_SKILLS[s.id] = s; };
  add({
    ...BOSS_SKILLS.slash,
    id: 'towerSlash', name: '裂空斩',
    range: 18, damage: D.DMG_SLASH, cooldown: 6, telegraph: 1.2,
    fxScale: 1.5, swingFx: { fx: 'fxSword1', scale: 8, life: 0.9 },
  });
  add({
    ...BOSS_SKILLS.thunder,
    id: 'towerThunder', name: '裁决落雷',
    radius: 5, damage: D.DMG_THUNDER, cooldown: 9, telegraph: 1.6,
    // 天雷本体是 Effekseer 世界坐标，必须抬到这层甲板上方
    skyFxY: DECK_Y + 8, skyFxScale: 1.5,
  });
  add({
    ...BOSS_SKILLS.sweep,
    id: 'towerSweep', name: '雷环冲击',
    radius: 12, damage: D.DMG_SWEEP, cooldown: 11, telegraph: 1.5,
    fxScale: 1.2, hitFxScale: 1.0,
  });
}
registerTowerSkills();

export class SkyTowerBossRun {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = D.LAYER;
    this.deckY = DECK_Y;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.fx = opts.fx || null;
    this.camera = opts.camera || null;
    this.net = opts.net || { send() {} };
    this.onScore = opts.onScore || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.teamOf = typeof opts.teamOf === 'function' ? opts.teamOf : null;

    this.boats = new Map();
    this.damageBy = new Map();       // id -> 累计伤害（A 口径就是它）
    this.cannonCd = new Map();
    this.ramCd = new Map();
    this.started = false;
    this.running = true;
    this.timeLeft = D.DURATION;
    this.elapsed = 0;
    this.enraged = false;
    this._stateT = 0;
    this._lastFlash = null;   // 给客机播伤害数字用：只带"本次增量"，不是累计表
    this.disposed = false;
    this.dmgFx = null;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-bossrush';
    this.group.position.y = this.deckY;
    scene.add(this.group);
    this.#buildDecor();
    // BOSS 延迟到第一次有人真的爬上第 4 层时再创建：Boss 构造时就把本体 +
    // 光环/光柱直接挂到 scene（初始 y=0 = 海面），而开场动画/倒计时阶段
    // mode 不会调用本模块 update，补高度的机会都没有 —— 于是它整只站在
    // 第 1 层水球场上。懒创建后，第 1 层永远不会看到第 4 层的龙骑士。
    this.boss = null;
  }

  // ---------------------------------------------------------------- 场地 / BOSS

  /** 场边装饰只用现成 GLB（和第 3 层同一批素材，视觉连贯） */
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
          m.name = 'boss-pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
    for (let i = 0; i < D.ARCH_COUNT; i++) {
      const a = (i / D.ARCH_COUNT) * TWO_PI + Math.PI / 8;
      cloneProp('/models/props/palace_gate_frame.glb', 11, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.86, 0.05, Math.sin(a) * R * 0.86);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'palace_gate_frame';
          m.name = 'boss-arch';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  /** 给 Effekseer 的坐标统一抬一层：Boss 内部写的 y 都是相对海面的 */
  #fxOnDeck() {
    const fx = this.fx;
    if (!fx) return null;
    return new Proxy(fx, {
      get(target, key) {
        const v = Reflect.get(target, key, target);
        if (key === 'play' && typeof v === 'function') {
          return (name, x, y, z, ...rest) =>
            v.call(target, name, x, (Number.isFinite(y) ? y : 0) + DECK_Y, z, ...rest);
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }

  #createBoss() {
    // 新 id 的技能表 + 关掉原生 1/3 血 phaseShift（这层自己做 1/2 血狂暴）
    const def = {
      ...BOSSES.knight_thunder,
      hp: D.BOSS_HP,
      skills: ['towerSlash', 'towerThunder', 'towerSweep'],
      phaseShift: null,
    };
    const boss = new Boss(this.scene, def, {
      hp: D.BOSS_HP,
      fx: this.#fxOnDeck(),
      skillFx: null,                  // SkillFx 的世界坐标不跟层高走，变身特效自己放
      net: { send: (m) => this.#send(m) },
      isHost: this.isHost,
      variant: 'classic',
      arenaRadius: D.ARENA_R,
      getPlayers: () => [...this.boats].map(([id, boat]) => ({
        id, boat, alive: true, hp: 100,
      })),
      // BOSS 记仇打输出最高的人，给"领先有代价"的压迫感
      getAggroId: () => this.#topDamager(),
      onSkillResolve: (skill, info) => this.#resolveSkill(skill, info),
      onDeath: () => this.#finish(true),
      onToast: (m) => this.onToast(m),
    });
    boss.telegraphScale = D.TELEGRAPH_SCALE;
    boss.cooldownScale = D.COOLDOWN_SCALE;
    boss.phaseIndex = 1;              // 原生阶段阈值只有 1/3 一条，置 1 = 不再触发
    // 中央水晶塔贯穿第 2 层以上，原点被塔身占满。BOSS 出生点必须让开，
    // 否则模型会被 3.9m 粗的柱子从肚子劈开，玩家只看到两片边角。
    boss.pos.set(0, 0, 18);
    return boss;
  }

  #topDamager() {
    let best = null, bv = -1;
    for (const [id, v] of this.damageBy) {
      if (v > bv) { bv = v; best = id; }
    }
    return best || [...this.boats.keys()][0] || this.myId;
  }

  // ---------------------------------------------------------------- 每帧

  /**
   * @param {number} dt
   * @param {Array<{id:string,boat:object}>} entries 第 4 层的船
   */
  update(dt, entries = []) {
    if (this.disposed) return;
    this.elapsed += dt;
    this.boats = new Map(entries.map((e) => [e.id, e.boat]));

    // 第一艘船进入本层才把 BOSS 拉出来（见构造函数里的注释）
    if (!this.boss && entries.length) {
      this.boss = this.#createBoss();
      this.boss.group.position.y = this.deckY;
    }

    if (!this.started && entries.length) {
      this.started = true;
      this.onEvent({ type: 'start' });
    }
    if (this.running && this.started) {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) this.#finish();
    }

    if (this.boss) {
      if (entries.length) this.boss.update(dt, this.elapsed);
      else this.boss.updateIdle(dt);
      this.#avoidSpire();
      this.#liftBossToDeck();
    }

    this.#updateRamming(dt);
    this.#updateEnrage();

    if (this.isHost && !this.solo && entries.length && this.running) {
      this._stateT -= dt;
      if (this._stateT <= 0) { this.#sendState(); this._stateT = 0.1; }
    }
  }

  /**
   * 中央塔身（SPIRE_R=3.9）从第 2 层起贯穿所有高层平台。Boss 的原生 AI 只会
   * 按 arenaRadius 把自己在圆盘里钳制，完全不知道中心有柱子 —— 之前它会直接
   * 走进塔里，模型被劈成两半。这里在 update 之后把它推到安全环外，并给一点
   * 切向分量，让它绕着柱子滑走而不是顶着柱子原地卡死。
   */
  #avoidSpire() {
    const b = this.boss;
    if (!b) return;
    const keepOut = SKY_TOWER.SPIRE_R + (b.def.radius || 4.6) + 2;
    const d = Math.hypot(b.pos.x, b.pos.z);
    if (d >= keepOut) return;
    let nx = d > 0.001 ? b.pos.x / d : 0;
    let nz = d > 0.001 ? b.pos.z / d : 1;
    const boat = this.boats.get(this.#topDamager());
    if (boat) {
      // 朝目标所在的一侧绕：cross>0 顺时针，<0 逆时针
      const cross = nx * boat.pos.z - nz * boat.pos.x;
      const s = cross >= 0 ? 1 : -1;
      const cx = nx * 0.85 - nz * s * 0.53;
      const cz = nz * 0.85 + nx * s * 0.53;
      const cl = Math.hypot(cx, cz) || 1;
      nx = cx / cl; nz = cz / cl;
    }
    b.pos.x = nx * keepOut;
    b.pos.z = nz * keepOut;
  }

  /** Boss 的 group / 预警圈每帧被自己的 applyPose/updateWarning 写回海面高度，必须补回来 */
  #liftBossToDeck() {
    const b = this.boss;
    if (!b?.group) return;
    // applyPose 里是 waveHeight + bob - diveSink + hopY + liftY
    b.group.position.y += this.deckY;
    if (b.warning) b.warning.position.y = this.deckY + 0.35;
  }

  #updateEnrage() {
    if (this.enraged || !this.boss || this.boss.dead) return;
    if (this.boss.hp > this.boss.maxHp * 0.5) return;
    this.enraged = true;
    this.boss.speedScale *= 1.2;
    this.boss.cooldownScale *= 0.85;
    this.boss.playOnce?.('enrage', 1.4);
    this.fx?.play?.('fxBoltStorm', this.boss.pos.x, this.deckY + 2.5, this.boss.pos.z, 2.2);
    this.onToast('⚡ 雷霆龙骑士狂暴！移速与出招加快');
    this.onEvent({ type: 'enrage' });
  }

  // ---------------------------------------------------------------- 玩家攻击

  /** 按 1 发雷炮：场上只有一个目标，直接锁定，射程内即时结算 */
  fireCannon() {
    if (this.disposed || !this.running) return false;
    const boat = this.boats.get(this.myId);
    if (!boat || this.stunBlocked(boat)) return false;
    if (this.elapsed < (this.cannonCd.get(this.myId) || 0)) return false;
    const b = this.boss;
    if (!b || b.dead) return false;
    const dx = b.pos.x - boat.pos.x, dz = b.pos.z - boat.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > D.CANNON_RANGE) {
      this.onToast(`⚡ 目标超出射程（${Math.round(dist)}m / ${D.CANNON_RANGE}m）`);
      return false;
    }
    this.cannonCd.set(this.myId, this.elapsed + D.CANNON_CD);
    const sx = boat.pos.x, sz = boat.pos.z;
    this.fx?.play?.('fxArcBolt', sx, this.deckY + 1.6, sz, 1.3);
    this.fx?.play?.('fxLightningStrike', b.pos.x, this.deckY + 8, b.pos.z, 1.2);
    this.#spawnDamage(D.CANNON_DMG, b.pos.x, this.deckY + 4.5, b.pos.z, false);
    if (this.isHost) this.#applyDamage(D.CANNON_DMG, this.myId, 'cannon');
    else this.net.send({ t: 'towerBossHit', from: this.myId, dmg: D.CANNON_DMG, kind: 'cannon' });
    return true;
  }

  stunBlocked(boat) {
    return boat.stunTimer > 0 || boat.sinkTimer > 0 || boat.spinTimer > 0
      || boat.voidTimer > 0 || boat.capsizeTimer > 0;
  }

  /** 撞 BOSS：主机判全场；客机只判自己并上报，避免双倍扣血 */
  #updateRamming() {
    const b = this.boss;
    if (!b || b.dead || !this.running) return;
    const contact = (b.def.radius || 4.6) + 3.2;
    for (const [id, boat] of this.boats) {
      if (!this.isHost && id !== this.myId) continue;
      const dx = boat.pos.x - b.pos.x, dz = boat.pos.z - b.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= contact || dist < 0.01) continue;
      if (this.elapsed < (this.ramCd.get(id) || 0)) continue;
      if ((boat.speed ?? Math.hypot(boat.vel.x, boat.vel.y)) < 5) continue;
      const boosting = (boat.boostTimer || 0) > 0;
      const dmg = Math.round(D.RAM_BASE * (boosting ? D.RAM_NITRO : 1)
        * Math.max(0.6, Math.min(1.8, (boat.speed || 18) / 18)));
      this.ramCd.set(id, this.elapsed + D.RAM_CD);
      // 弹开 8m/s：只改水平速度，天梯的 y 是层高，不能动
      const nx = dx / dist, nz = dz / dist;
      boat.vel.x = nx * 8; boat.vel.y = nz * 8;
      boat.stunTimer = Math.max(boat.stunTimer || 0, 0.12);
      this.fx?.play?.('fxClawSlash', boat.pos.x, this.deckY + 1.2, boat.pos.z, 1.2);
      this.#spawnDamage(dmg, boat.pos.x, this.deckY + 3.2, boat.pos.z, boosting);
      if (this.isHost) this.#applyDamage(dmg, id, boosting ? 'ramNitro' : 'ram');
      else this.net.send({ t: 'towerBossHit', from: id, dmg, kind: 'ram' });
    }
  }

  // ---------------------------------------------------------------- BOSS 技能命中

  /** Boss.js 在预警结束时回调这里；命中几何抄自 BossMode.#skillHits，删掉海面专用项 */
  #resolveSkill(skill, info) {
    if (!this.running || this.disposed) return;
    const mouth = (this.boss?.def?.radius || 4.6) * 0.78;
    let ox = info.x, oz = info.z;
    if (skill.kind === 'cone') {
      ox = info.x + Math.sin(info.heading) * mouth;
      oz = info.z + Math.cos(info.heading) * mouth;
    }
    const hull = 1.3;
    for (const [id, boat] of this.boats) {
      const dx = boat.pos.x - ox, dz = boat.pos.z - oz;
      const dist = Math.hypot(dx, dz);
      let hit = false;
      if (skill.kind === 'cone') {
        const diff = Math.atan2(dx, dz) - info.heading;
        const a = Math.atan2(Math.sin(diff), Math.cos(diff));
        hit = dist <= (skill.range || 24) + hull
          && Math.abs(a) <= THREE.MathUtils.degToRad((skill.angle || 120) / 2) + 0.12;
      } else if (skill.kind === 'ring') {
        hit = Math.abs(dist - (skill.radius || 20)) <= 3.4 + hull;
      } else {
        hit = dist <= (skill.radius || 10) + hull;
      }
      if (!hit) continue;
      this.#hurtPlayer(id, boat, skill.damage || 12, skill);
    }
    if (this.isHost && !this.solo) {
      this.net.send({
        t: 'towerBossSkill', skill: skill.id, x: info.x, z: info.z, h: info.heading,
      });
    }
  }

  #hurtPlayer(id, boat, dmg, skill) {
    // 天梯没有 HP 条：BOSS 技能给的是"失控 + 减速 + 飘字"，不会把人打死
    if (this.isHost || id === this.myId) {
      boat.stunTimer = Math.max(boat.stunTimer || 0, 0.6);
      boat.slowTimer = Math.max(boat.slowTimer || 0, 1.6);
      const dx = boat.pos.x - this.boss.pos.x, dz = boat.pos.z - this.boss.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      boat.vel.x += (dx / d) * 5;
      boat.vel.y += (dz / d) * 5;
    }
    this.#spawnDamage(dmg, boat.pos.x, this.deckY + 3.0, boat.pos.z, false);
    if (this.isHost && !this.solo) {
      this.net.send({ t: 'towerBossHurt', id, dmg, skill: skill?.id || '' });
    }
  }

  // ---------------------------------------------------------------- 计分 / 飘字

  #applyDamage(amount, fromId, kind) {
    if (!this.running || !this.boss || this.boss.dead) return;
    const dealt = this.boss.applyDamage(amount);
    if (dealt <= 0) return;
    this.damageBy.set(fromId, (this.damageBy.get(fromId) || 0) + dealt);
    this._lastFlash = { id: fromId, dmg: dealt };
    this.boss.addStagger?.(dealt * 0.18);
    this.onScore(fromId, dealt, kind);
    if (!this.solo) this.net.send({ t: 'towerBossState', dmg: { [fromId]: dealt }, bump: 1 });
    if (this.boss.dead) this.#finish(true);
  }

  #spawnDamage(amount, x, y, z, crit) {
    if (!this.camera || typeof document === 'undefined') return;
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return;
    const px = (v.x * 0.5 + 0.5) * window.innerWidth;
    const py = (-v.y * 0.5 + 0.5) * window.innerHeight;
    if (!this.dmgFx) this.dmgFx = new DamageNumbers();
    this.dmgFx.spawn({ value: Math.round(amount), crit: !!crit, x: px, y: py, scale: 1 });
  }

  #finish(killed = false) {
    if (!this.running) return;
    this.running = false;
    this.timeLeft = 0;
    const ranked = [...this.damageBy.entries()].sort((a, b) => b[1] - a[1]);
    this.winner = ranked[0]?.[0] || null;
    this.onToast(killed
      ? '⚡ BOSS 被击倒！按累计伤害结算'
      : '⏱ 本层时间到 · 按累计伤害结算');
    this.onEvent({ type: 'finish', winner: this.winner, killed, ranked });
    if (!this.solo) this.net.send({ t: 'towerBossEnd', winner: this.winner });
  }

  // ---------------------------------------------------------------- 网络

  // Boss 内部自己会发怪物模式的 bossCast（读条），这一层不用它：
  // 客机靠 towerBossCast 复现预警，重复发只会多一份无效流量。
  #send(msg) {
    if (this.solo || msg?.t === 'bossCast') return;
    this.net.send?.(msg);
  }

  #sendState() {
    const b = this.boss;
    if (!b) return;
    this.net.send?.({
      t: 'towerBossState',
      x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2),
      h: +b.heading.toFixed(3), hp: Math.max(0, b.hp),
      dead: !!b.dead, dmg: Object.fromEntries(this.damageBy),
      flash: this._lastFlash,
    });
    this._lastFlash = null;
  }

  applyNet(e) {
    if (!e || this.disposed) return;
    const b = this.boss;
    switch (e.t) {
      case 'towerBossState':
        if (!this.isHost && b) {
          b.setNetState({ x: e.x, z: e.z, h: e.h, hp: e.hp, stagger: 0 });
          if (e.dmg) this.damageBy = new Map(Object.entries(e.dmg).map(([k, v]) => [k, +v]));
          if (e.flash?.dmg > 0) {
            this.#spawnDamage(e.flash.dmg, b.pos.x, this.deckY + 4.5, b.pos.z, false);
          }
          if (e.dead && !b.dead) b.die();
        }
        break;
      case 'towerBossCast':
        if (!this.isHost && b && BOSS_SKILLS[e.skill]) {
          b.showWarning(e.skill, e.x, e.z, e.h, e.dur);
        }
        break;
      case 'towerBossHit':
        // 客机上报自己的输出 → 主机权威扣血；其他客机仅本地展示（随后被 state 覆盖）
        if (this.isHost) this.#applyDamage(e.dmg, e.from, e.kind || 'hit');
        else if (e.from !== this.myId) {
          this.damageBy.set(e.from, (this.damageBy.get(e.from) || 0) + e.dmg);
          if (b) this.#spawnDamage(e.dmg, b.pos.x, this.deckY + 4.5, b.pos.z, false);
        }
        break;
      case 'towerBossHurt':
        if (!this.isHost) {
          const boat = this.boats.get(e.id);
          if (e.id === this.myId && boat) {
            boat.stunTimer = Math.max(boat.stunTimer || 0, 0.6);
            boat.slowTimer = Math.max(boat.slowTimer || 0, 1.6);
          }
          if (boat) this.#spawnDamage(e.dmg, boat.pos.x, this.deckY + 3, boat.pos.z, false);
        }
        break;
      case 'towerBossEnd':
        if (!this.isHost) this.#finish();
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- 展示用

  stats() {
    return new Map([...this.damageBy].sort((a, b) => b[1] - a[1]));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.boss?.dispose();
    this.boss = null;
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
