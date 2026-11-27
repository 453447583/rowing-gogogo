import * as THREE from 'three';
import { SKY_TOWER, layerY, layerRadius } from '../data/skyTowerRun.js';
import { cloneProp } from './propLoader.js';
import { audio } from '../audio/AudioEngine.js';

/**
 * 云端天梯第 7 层：缩圈 · 累计里程竞速。
 *
 * 用户口径（2026-11-25）
 * --------------------
 * - 圈一直缩，圈里随便跑（漂移、直线都算），谁跑的距离多谁赢；
 * - 有队伍就按队伍总里程算；
 * - 掉下去扣里程（-80m），然后被"抓回"圈内继续跑，不掉层（用户已确认）；
 * - 圈缩到 16m 就停，不要缩到没地方站；到第 8 层就恢复原样（缩圈只在本层生效）。
 *
 * 几个实现口径：
 * 1. 里程 = 每帧水平位移累加（hypot(dx,dz)）。单帧 < 0.02m 当噪声丢掉；
 *    单帧超过"这一帧最多能走多远"（按船速算，地板 6m）当传送丢掉
 *    —— 重生、联机回写、探针瞬移都会被排除，不会刷分，也不会误杀低帧率的正常帧。
 * 2. 「圈外」不是马上掉：先失控减速，1.6 秒后才掉下去 + 扣里程，
 *    玩家有一次回头机会，也避免网络抖动直接把人抬走。
 * 3. 掉圈的归属：船的位置各端自管，所以"掉下去"只能由船主自己传送 + 上报，
 *    房主收到自报后算扣减（`#penalize`）再把绝对值广播回来；房主另外负责 AI
 *    （AI 没有客户端替它上报）。里程最终以房主 6.7Hz 的 towerShrinkState 为准。
 *
 * `fallLog` 是最近 8 次掉圈的环形记录（谁/原因/距离/当时圈半径），只给探针和
 * 现场排查用 —— 本轮就是靠它发现"AI 全是被平台边判掉的 arena 掉圈"。
 */

const S = SKY_TOWER.SHRINK;
const TWO_PI = Math.PI * 2;
const DECK_Y = layerY(S.LAYER) + 0.30;

/**
 * 光幕用的竖向渐变贴图（底部亮、顶部淡）。
 * 纯色圆柱看起来像一块塑料板，加上渐变才有"能量幕"的垂直通透感。
 * node 里跑逻辑探针时没有 document，直接返回 null（材质退回纯色）。
 */
function curtainTexture() {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 64;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const g = ctx.createLinearGradient(0, 64, 0, 0);
    g.addColorStop(0, 'rgba(127,233,255,0.95)');
    g.addColorStop(0.35, 'rgba(127,233,255,0.42)');
    g.addColorStop(1, 'rgba(127,233,255,0.04)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  } catch { return null; }
}

export class SkyTowerShrinkRun {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.layer = S.LAYER;
    this.deckY = DECK_Y;
    this.myId = opts.myId;
    this.isHost = opts.isHost !== false;
    this.solo = !!opts.solo;
    this.fx = opts.fx || null;
    this.net = opts.net || { send() {} };
    this.onScore = opts.onScore || (() => 0);
    this.onEvent = opts.onEvent || (() => {});
    this.onToast = opts.onToast || (() => {});
    this.teamOf = typeof opts.teamOf === 'function' ? opts.teamOf : null;
    this.isAi = typeof opts.isAi === 'function' ? opts.isAi : () => false;

    this.boats = new Map();       // 本层上的船（每帧由 mode 传入）
    this.seen = new Set();        // 本层出现过的人：结算按它算，中途上楼也不会漏
    this.dist = new Map();        // id -> 累计里程（米，房主权威）
    this.falls = new Map();       // id -> 掉下去次数
    this.outT = new Map();        // id -> 连续在圈外的时间
    this.myOut = false;           // 自己是不是在圈外（圈墙变红报警用）
    this.prev = new Map();        // id -> 上一帧位置（算位移用）
    this.shrinkT = 0;
    this.ringR = layerRadius(S.LAYER) * S.R0;
    this.timeLeft = S.DURATION;
    this.started = false;
    this.clockOn = false;         // 有真人上这一层才开始走表（AI 先爬上来会把 75s 耗光）
    this.running = true;
    this.order = [];
    this.teams = [];
    this.winner = null;
    this.disposed = false;
    this._stateT = 0;

    this.group = new THREE.Group();
    this.group.name = 'sky-tower-shrink';
    this.group.position.y = this.deckY;
    scene.add(this.group);
    this.#buildRing();
    this.#buildDecor();
  }

  // ---------------------------------------------------------------- 场地

  /**
   * 圈墙 + 底圈 + 终点圈。
   * 材质一律普通混合（memory：能量光幕用 AdditiveBlending 在亮天空前等于没画），
   * 只靠低不透明度 + 亮底环读数。
   */
  #buildRing() {
    // 竖向渐变（底亮顶淡）比纯色更像一堵能量墙；贴图拿不到时仍有 0.18 的底色
    this.curtainTex = curtainTexture();
    this.wall = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, S.WALL_H, 72, 1, true),
      new THREE.MeshBasicMaterial({
        color: this.curtainTex ? 0xffffff : 0x7fe9ff,
        map: this.curtainTex || null,
        transparent: true, opacity: this.curtainTex ? 0.68 : 0.2,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.wall.position.y = S.WALL_H / 2;
    this.wall.renderOrder = 3;
    this.wall.name = 'shrink-wall';

    // 底圈：贴地的一圈亮环，缩圈时这个环最显眼
    this.rim = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.045, 8, 120),
      new THREE.MeshBasicMaterial({
        color: 0x9ff8ff, transparent: true, opacity: 0.95, depthWrite: false,
      }),
    );
    this.rim.rotation.x = -Math.PI / 2;
    this.rim.position.y = 0.24;
    this.rim.renderOrder = 4;
    this.rim.name = 'shrink-rim';

    // 顶圈：光幕本身只有 0.18 不透明度，单靠它读不出"这是一堵墙"，
    // 加一道同样半径的亮环把圆柱的轮廓框出来（远处一眼就能看到圈在哪）
    this.top = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.065, 8, 120),
      new THREE.MeshBasicMaterial({
        color: 0xbffaff, transparent: true, opacity: 0.78, depthWrite: false,
      }),
    );
    this.top.rotation.x = -Math.PI / 2;
    this.top.position.y = S.WALL_H;
    this.top.renderOrder = 4;
    this.top.name = 'shrink-top';

    // 圈外警示带：贴地一圈红橙带（在墙外侧），俯视时"外面是危险区"一目了然
    this.danger = new THREE.Mesh(
      new THREE.RingGeometry(1.0, 1.1, 96),
      new THREE.MeshBasicMaterial({
        color: 0xff7a4a, transparent: true, opacity: 0.38,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.danger.rotation.x = -Math.PI / 2;
    this.danger.position.y = 0.2;
    this.danger.renderOrder = 3;
    this.danger.name = 'shrink-danger';

    // 终点圈：一开始就画在地上，告诉玩家"缩到这里就停"，不用猜
    this.target = new THREE.Mesh(
      new THREE.RingGeometry(S.R1 - 0.14, S.R1, 96),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.3,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    this.target.rotation.x = -Math.PI / 2;
    this.target.position.y = 0.17;
    this.target.renderOrder = 3;
    this.target.name = 'shrink-target';

    this.group.add(this.wall, this.rim, this.top, this.danger, this.target);
    this.#applyRing();
  }

  #buildDecor() {
    const R = layerRadius(this.layer);
    for (let i = 0; i < S.POLE_COUNT; i++) {
      const a = (i / S.POLE_COUNT) * TWO_PI + Math.PI / 11;
      cloneProp('/models/low_poly_street_light_pole.glb', 15, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.97, 0.05, Math.sin(a) * R * 0.97);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'street_light_pole';
          m.name = 'shrink-pole';
          this.group.add(m);
        })
        .catch(() => {});
    }
    for (let i = 0; i < S.ARCH_COUNT; i++) {
      const a = (i / S.ARCH_COUNT) * TWO_PI + Math.PI / 4;
      cloneProp('/models/canyon/arch.glb', 11, { by: 'height' })
        .then((m) => {
          if (this.disposed) return;
          m.position.set(Math.cos(a) * R * 0.9, 0.05, Math.sin(a) * R * 0.9);
          m.rotation.y = -a + Math.PI / 2;
          m.userData.glb = 'canyon_arch';
          m.name = 'shrink-arch';
          this.group.add(m);
        })
        .catch(() => {});
    }
  }

  #applyRing() {
    const r = Math.max(1, this.ringR);
    this.wall.scale.set(r, 1, r);
    this.rim.scale.set(r, r, 1);
    this.top.scale.set(r, r, 1);
    this.danger.scale.set(r, r, 1);
  }

  /** 当前安全圈半径：一开始慢、末段更慢（缓出），60 秒刚好收在 R1 */
  #radiusAt(t) {
    const R0 = layerRadius(this.layer) * S.R0;
    const k = Math.max(0, Math.min(1, t / S.SHRINK_TIME));
    const e = 1 - (1 - k) * (1 - k);   // ease-out：前段收得快，后段温柔停住
    return R0 + (S.R1 - R0) * e;
  }

  // ---------------------------------------------------------------- 每帧

  update(dt, entries = []) {
    if (this.disposed) return;
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
      this.shrinkT = Math.min(S.SHRINK_TIME, this.shrinkT + dt);
      this.ringR = this.#radiusAt(this.shrinkT);
      if (this.timeLeft <= 0) this.#finish();
    }
    this.#applyRing();

    // 走表之前不计里程、也不判圈外：AI 先爬到第 7 层绕两分钟圈，
    // 真人上来时就已经输了（和落雷层"AI 不耗光 75 秒"同一个口径）。
    this.#trackDistance(dt, clock);
    if (clock) this.#checkOutside(dt);
    this.#applyAlert();

    if (this.isHost && !this.solo && this.started) {
      this._stateT -= dt;
      if (this._stateT <= 0) { this.#sendState(); this._stateT = 0.15; }
    }
  }

  /** 里程 = 逐帧水平位移累加（漂移/直线/倒退都算，只看真正挪了多少） */
  #trackDistance(dt, count = true) {
    for (const [id, boat] of this.boats) {
      if (!boat) continue;
      const px = boat.pos.x, pz = boat.pos.z;
      const prev = this.prev.get(id);
      this.prev.set(id, { x: px, z: pz });
      if (!prev || !count) continue;
      const step = Math.hypot(px - prev.x, pz - prev.z);
      // 传送过滤：按船自己报的速度算"这一帧最多能走多远"（4 倍余量 + 2.5m），
      // 比写死阈值稳 —— 低帧率机器上一帧可能真走 6~7m（20m/s × 0.35s），
      // 写死 6m 会把这些正常帧当传送丢掉，里程会莫名少算（2026-11-25 探针实测）。
      // 速度约 0 时的地板值仍按 MAX_STEP 卡，探针 20m 瞬移照样不计。
      const spd = Math.abs(boat.speed || 0);
      const limit = Math.max(S.MAX_STEP, spd * dt * 4 + 2.5);
      if (step < S.MIN_STEP || step > limit) continue;
      this.dist.set(id, (this.dist.get(id) || 0) + step);
    }
  }

  /**
   * 圈外判定：船主自己判自己的（传送只能船主做，房主去搬客机的船会被位移同步顶回来），
   * 房主额外负责 AI —— AI 没有客户端替它上报。
   */
  #checkOutside(dt) {
    if (!this.running) return;
    for (const [id, boat] of this.boats) {
      if (!boat) continue;
      if (id !== this.myId && !this.isAi(id)) continue;
      const d = Math.hypot(boat.pos.x, boat.pos.z);
      if (d <= this.ringR) {
        this.outT.set(id, 0);
        if (id === this.myId) this.myOut = false;
        continue;
      }
      const t = (this.outT.get(id) || 0) + dt;
      this.outT.set(id, t);
      if (id === this.myId) this.myOut = true;
      // 圈外先掉速 + 失控，给一次回头机会
      boat.slowTimer = Math.max(boat.slowTimer || 0, 0.4);
      if (t >= S.OUT_GRACE) this.#fall(id, boat, 'out');
    }
  }

  /** 自己在圈外时整圈变红：玻璃甲板上光幕本身太淡，靠颜色切换才是最直接的报警 */
  #applyAlert() {
    const red = this.myOut;
    if (this._alertOn === red) return;
    this._alertOn = red;
    this.rim.material.color.setHex(red ? 0xff8a5a : 0x9ff8ff);
    this.top.material.color.setHex(red ? 0xffb08a : 0xbffaff);
    this.wall.material.color.setHex(red ? 0xff9b78 : 0xffffff);
    this.danger.material.color.setHex(red ? 0xff3b20 : 0xff7a4a);
    this.danger.material.opacity = red ? 0.62 : 0.38;
  }

  /** 掉下去：扣里程 + 抓回圈内（不掉层，用户确认的口径） */
  #fall(id, boat, why = 'out') {
    if (this.disposed || !this.running || !boat) return;
    this.fallLog = this.fallLog || [];
    this.fallLog.push({ id, why, d: +Math.hypot(boat.pos.x, boat.pos.z).toFixed(1), ring: +this.ringR.toFixed(1) });
    if (this.fallLog.length > 8) this.fallLog.shift();
    this.outT.set(id, 0);
    // 本地传送（船的位置本来就是各端自管）
    const r = Math.max(4, this.ringR * S.RESPAWN_R);
    const a = Math.random() * TWO_PI;
    boat.pos.set(Math.cos(a) * r, this.deckY + 0.1, Math.sin(a) * r);
    boat.heading = Math.atan2(-Math.cos(a), -Math.sin(a));
    boat.vel.set(0, 0, 0);
    boat.vy = 0;
    boat.speed = 0;
    boat.stunTimer = 0;
    boat.slowTimer = 0;
    boat.diveTargetY = this.deckY + 0.1;
    this.prev.delete(id);                 // 传送不算里程
    if (id === this.myId) this.myOut = false;
    this.fx?.play?.('explosion', boat.pos.x, this.deckY + 0.9, boat.pos.z, 0.9);
    this.fx?.play?.('ring', boat.pos.x, this.deckY + 0.3, boat.pos.z, 1.2);
    try { audio.play('boss_thunder_strike', { gap: 240 }); } catch {}

    if (this.isHost || this.solo) this.#penalize(id);
    else this.net.send?.({ t: 'towerShrinkFall', id });
    this.onEvent({ type: 'fall', id, lost: S.FALL_PENALTY, total: this.dist.get(id) || 0 });
  }

  #penalize(id) {
    const before = this.dist.get(id) || 0;
    const after = Math.max(0, before - S.FALL_PENALTY);
    this.dist.set(id, after);
    const n = (this.falls.get(id) || 0) + 1;
    this.falls.set(id, n);
    if (!this.solo && this.isHost) {
      this.net.send?.({ t: 'towerShrinkFall', id, d: Math.round(after), n });
    }
    return { before, after, n };
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
      const rows = ids.map((id, i) => ({ id, m: Math.round(this.dist.get(id) || 0), i }));
      if (this.teamOf) {
        // 队伍：先按队伍总里程排，队员按个人里程排进 order（一条记录=一整队也读得懂）
        const byTeam = new Map();
        for (const r of rows) {
          const t = this.teamOf(r.id);
          const key = t == null ? `solo:${r.id}` : `t:${t}`;
          const cur = byTeam.get(key) || { key, rows: [], m: 0 };
          cur.rows.push(r);
          cur.m += r.m;
          byTeam.set(key, cur);
        }
        const sorted = [...byTeam.values()].sort((a, b) => b.m - a.m);
        order = sorted.flatMap((t) => t.rows.sort((a, b) => b.m - a.m)
          .map((r) => ({ id: r.id, n: r.m })));
        teams = sorted.map((t) => ({ ids: t.rows.map((r) => r.id), n: t.m }));
      } else {
        order = rows.sort((a, b) => b.m - a.m || a.i - b.i).map((r) => ({ id: r.id, n: r.m }));
        teams = order.map((o) => ({ ids: [o.id], n: o.n }));
      }
    }
    if (!teams.length) teams = order.map((o) => ({ ids: [o.id], n: o.n }));
    this.order = order;
    this.teams = teams;
    this.winner = teams[0]?.ids?.[0] || order[0]?.id || null;

    if (!remote && (this.isHost || this.solo)) {
      // 名次分按队伍发（队里每人一份），名次 = 队伍总里程排名
      const rankOf = new Map();
      teams.forEach((t, i) => { for (const id of t.ids) rankOf.set(id, i); });
      for (const r of order) {
        const i = rankOf.get(r.id) ?? 0;
        const pts = S.SCORE_RANK[Math.min(i, S.SCORE_RANK.length - 1)];
        const s = this.onScore(r.id, pts, 'rank');
        if (!this.solo && Number.isFinite(s)) this.net.send?.({ t: 'towerScore', id: r.id, s });
      }
    }

    this.onEvent({
      type: 'finish',
      order,
      teams: teams.map((t) => ({ ids: t.ids, n: t.n })),
      ring: this.ringR,
    });
    if (!remote && !this.solo && this.isHost) {
      this.net.send?.({
        t: 'towerShrinkEnd',
        order,
        teams: teams.map((t) => ({ ids: t.ids, n: t.n })),
      });
    }
  }

  // ---------------------------------------------------------------- 网络

  #sendState() {
    const d = {};
    for (const [id, m] of this.dist) d[id] = Math.round(m);
    const f = {};
    for (const [id, n] of this.falls) f[id] = n;
    this.net.send?.({
      t: 'towerShrinkState',
      r: +this.ringR.toFixed(2),
      d, f,
      left: +this.timeLeft.toFixed(1),
    });
  }

  applyNet(e) {
    if (!e || this.disposed) return;
    switch (e.t) {
      case 'towerShrinkState':
        // 圈半径/里程/剩余时间以房主为准（客机本地只是插值预览）
        if (Number.isFinite(e.r)) { this.ringR = e.r; this.#applyRing(); }
        if (e.d) for (const [k, v] of Object.entries(e.d)) this.dist.set(k, +v);
        if (e.f) for (const [k, v] of Object.entries(e.f)) this.falls.set(k, +v);
        if (Number.isFinite(e.left)) this.timeLeft = e.left;
        this.clockOn = this.clockOn || this.started;
        break;
      case 'towerShrinkFall': {
        // 玩家自报掉圈（不带 d/n）：房主算扣减再广播绝对值；收到房主的数字就直接对齐。
        // 位置不用管 —— 船主那边已经自己传送了，位姿会随常规同步过来。
        if (this.isHost && !this.solo && e.id !== this.myId && !Number.isFinite(e.d)) {
          this.#penalize(e.id);
        }
        if (Number.isFinite(e.d)) this.dist.set(e.id, +e.d);
        if (Number.isFinite(e.n)) this.falls.set(e.id, +e.n);
        this.onEvent({ type: 'fall', id: e.id, remote: true });
        break;
      }
      case 'towerShrinkEnd': {
        const order = Array.isArray(e.order)
          ? e.order.map((r) => ({ id: r.id, n: r.n | 0 })) : null;
        const teams = Array.isArray(e.teams)
          ? e.teams.map((t) => ({ ids: t.ids || [], n: t.n | 0 })) : null;
        if (this.running) this.#finish(true, order, teams);
        else if (order) this.order = order;
        break;
      }
      default: break;
    }
  }

  // ---------------------------------------------------------------- 给 mode / AI / HUD 用

  /** AI：贴着安全圈绕圈攒里程；被挤到圈外就先往塔心跑 */
  aiTarget(boat) {
    if (!boat) return null;
    // 平台半径 35、安全圈最大 34.3：AI 顶速 25m/s 一帧能走 5m，所以"回圈"阈值
    // 必须留出刹车距离，否则它会一路冲出玻璃盘（探针 fallLog 里 arena@d=35.9 就是这个）
    const safe = Math.min(this.ringR, layerRadius(this.layer)) - S.AI_EDGE;
    const d = Math.hypot(boat.pos.x, boat.pos.z);
    if (d > safe) {
      // 越往外拉得越狠（0.3 倍半径 ≈ 近乎对穿塔心），顶速下转不过来时先减速绕回来
      return { x: boat.pos.x * 0.3, z: boat.pos.z * 0.3 };
    }
    const r = Math.max(6, Math.min(safe, this.ringR * S.AI_R));
    const a = Math.atan2(boat.pos.z, boat.pos.x) + S.AI_W * 2.2;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  /** 掉出平台（不是圈外超时，是直接开出玻璃盘）：同样扣里程 + 抓回来 */
  noteFall(id, boat) {
    if (this.disposed || !this.running || !id) return;
    this.#fall(id, boat || this.boats.get(id), 'arena');
  }

  metersOf(id) { return Math.round(this.dist.get(id) || 0); }

  fallsOf(id) { return this.falls.get(id) || 0; }

  /** 实时领先者：里程最多的人 */
  leaderId() {
    if (this.order.length) return this.order[0].id;
    let best = null, bm = -1;
    for (const [id, m] of this.dist) if (m > bm) { bm = m; best = id; }
    return best;
  }

  hudState() {
    return {
      left: Math.max(0, this.timeLeft),
      ring: this.ringR,
      mine: this.metersOf(this.myId),
      falls: this.fallsOf(this.myId),
      running: this.running,
      order: this.order,
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.curtainTex?.dispose?.();
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
