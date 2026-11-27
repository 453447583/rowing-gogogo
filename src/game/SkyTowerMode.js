import * as THREE from 'three';
import {
  SKY_TOWER, layerY, layerRadius, layerCount, pickupRadius, weatherForLayer,
} from '../data/skyTowerRun.js';
import { SkyTowerArena } from './SkyTowerArena.js';
import { SkyTowerScenery } from './SkyTowerScenery.js';
import { SkyTowerFootball } from './SkyTowerFootball.js';
import { SkyTowerBubbleRun } from './SkyTowerBubbleRun.js';
import { SkyTowerItemRush } from './SkyTowerItemRush.js';
import { SkyTowerBossRun } from './SkyTowerBossRun.js';
import { SkyTowerThunderRun } from './SkyTowerThunderRun.js';
import { SkyTowerDefense } from './SkyTowerDefense.js';
import { SkyTowerShrinkRun } from './SkyTowerShrinkRun.js';
import { SkyTowerCrystalRun } from './SkyTowerCrystalRun.js';
import { SkyTowerPaintRun } from './SkyTowerPaintRun.js';
import { SkyTowerCrownRun } from './SkyTowerCrownRun.js';
// 第 3 层道具栏图标/名称/说明直接取道具赛那张表（HUD 三条槽用的是同一份结构）
import { ITEM_DEFS } from './Items.js';

/**
 * 云端天梯关卡控制器（赛场中央高塔 · 10 层）。
 *
 * 接口对齐 BossMode/ArenaMode，Game 主循环里那串 `this.bossMode.*` 原样复用：
 *   canControl / driveBoat / driveAi / constrainBoat / update / updateCamera / hudData / handleNet
 *
 * 玩法：捡货 → 浮空上楼 → 撞人掉货+推下平台 → 顶层入账 → 回底层重新抢。
 * 每层拾取半径逐层缩小；过热只锁转向不判负。
 *
 * 2026-11-24 两次改动（用户要求）：
 *   ① 每层天空复用现有天气：第 n 层 = weatherForLayer(n, 大厅选的天气)，
 *      同一份 WEATHERS 也喂给 env（雨/雪/星空）和 water（水色），一层一张脸。
 *   ② 第一层浮在竞技场海面上（水面整体下沉到 WATER_Y）。
 *
 * 2026-11-27 用户要求：
 *   ① 取消 1 分钟收集期：开球即开启升降光柱，随时能上楼；
 *   ② 取消所有楼层的"出界坠落/淘汰"：开出平台只把船重置回本层内侧（不掉层、不落水、不扣货）。
 */

const R = SKY_TOWER;
const TWO_PI = Math.PI * 2;

function skipCinemaByUrl() {
  try {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('towerCinema') === '0';
  } catch { return false; }
}

export class SkyTowerMode {
  constructor(opts) {
    this.scene = opts.scene;
    this.fx = opts.fx;
    this.net = opts.net;
    this.myId = opts.myId;
    this.solo = !!opts.solo;
    this.isHost = opts.isHost !== false;
    this.opts = opts;
    this.boats = opts.boats;
    this.localBoat = opts.localBoat;
    this.camera = opts.camera;
    this.input = opts.input;
    this.order = opts.order || [];
    // 组队赛制下的队伍名：HUD 右上角队伍对抗条要用
    this.teamNames = opts.teamNames || { blue: '蓝队', red: '红队' };
    // 订单里带 team 就是组队局（天梯 2v2）；个人局保持原来的 3 人上限
    this.teamMode = this.order.some((e) => e.team === 'blue' || e.team === 'red');
    this.onToast = opts.onToast || (() => {});
    this.onEnd = opts.onEnd || (() => {});
    this.onCinemaEnd = opts.onCinemaEnd || null;
    // 落水/重生后把镜头硬切回船尾（Game 传 cameraRig.snapTo）
    this.onRespawn = opts.onRespawn || null;
    // 每层天气（WEATHERS 里的对象）：第一层用大厅选的天气，往上按天气表循环
    this.baseWeatherId = opts.weather?.id || 'day';

    // 场景归本类；场地物理用 Game 创建的那一份（Game 每帧调 track.constrain 驱动边界/上楼）
    this.scenery = new SkyTowerScenery(this.scene, {
      weather: weatherForLayer(0, this.baseWeatherId),
    });
    this.arena = opts.arena;
    if (!this.arena) throw new Error('SkyTowerMode: 缺少 arena（须由 Game 传入）');
    this.arena.opts.onFall = (boat, layer) => this.#onFall(boat, layer);
    this.arena.opts.onClimb = (boat, layer) => this.#onClimb(boat, layer);
    this.arena.opts.onLanded = (boat, layer) => this.#onLanded(boat, layer);

    // 第 1 层改成水球赛（2026-11-24 用户改玩法）：球 + 球门 + 障碍独立成模块，
    // 障碍同时塞进 arena.shoreColliders，船会和礁石/熔岩柱硬碰（Boat 的扫掠圆直接认）。
    // 其余 9 层暂时还是原来的运货玩法，等各层小游戏做好再逐层替换。
    this.football = new SkyTowerFootball(this.scene, {
      fx: this.fx,
      authority: this.isHost,
      colliders: this.arena.shoreColliders,
      // 组队局：蓝队固定攻 +X 门、红队攻 -X 门；个人局仍按序号奇偶分边
      teamOf: (id) => this.players.get(id)?.team || null,
      onGoal: (side, lastTouch) => this.#onFootballGoal(side, lastTouch),
      onEvent: (e) => this.#onFootballEvent(e),
    });

    // 第 2 层：泡泡送包子。货物归属与泡泡判定都归房主，客机只放视觉。
    this.deliver = new SkyTowerBubbleRun(this.scene, {
      fx: this.fx,
      authority: this.isHost,
      netSend: (msg) => this.#netEvent(msg),
      onScore: (id, pts) => this.#onDeliverScore(id, pts),
      onEvent: (e) => this.#onDeliverEvent(e),
    });

    // 中央水晶塔柱的碰撞圆（只给船用）。
    // 塔身从第 2 层地板起（SPIRE_BASE_Y），所以 bottomY 写塔基：
    // 第 1 层的球场在地板 y=0.4，会被 verticalPad 过滤掉，中圈照样干净；
    // 第 2 层往上则实打实挡船 —— 否则玩家会直接开进一根 7.6m 粗的水晶柱。
    // 注意要在 football/deliver 构造之后再 push：football 构造时会把
    // arena.shoreColliders 当成"球场平面碰撞"读一遍（它只认 2D 圆）。
    this.arena.shoreColliders.push({
      x: 0, z: 0, r: R.SPIRE_R,
      bottomY: R.SPIRE_BASE_Y,
      topY: R.SPIRE_BASE_Y + R.SPIRE_H,
    });

    // 玩家状态
    this.players = new Map();
    for (const e of this.order) {
      this.players.set(e.id, {
        id: e.id, name: e.name || e.id, ai: !!e.ai, avatar: e.avatar || '',
        team: e.team || '',
        score: 0, layerPts: new Map(), cargo: [], layer: 0, alive: true,
        energy: R.DASH_ENERGY_MAX, overheat: 0, dashTimes: [], ramCd: 0,
        respawn: 0, invuln: 0, pushCd: 0,
      });
    }
    // 组队赛制最多 3v3（6 人）同场；个人局仍沿用原来的前 3 人
    this.ids = this.order.map((e) => e.id).slice(0, this.teamMode ? 6 : 3);

    // 第 3 层：道具箱大乱斗（复用道具赛的 ItemManager，见 SkyTowerItemRush 顶部注释）
    this.itemRush = new SkyTowerItemRush(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      track: this.arena,
      fx: this.fx,
      // ItemManager 直接调 net.send()，所以这里包一层（solo 时 #netEvent 自己会吞掉）
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onItemRushScore(id, pts, kind),
      onEvent: (e) => this.#onItemRushEvent(e),
      teamOf: (id) => this.players.get(id)?.team ?? null,
    });

    // 第 4 层：雷霆龙骑士 · 双船伤害竞速（复用 Boss 实体，不接管 BossMode）
    this.bossRush = new SkyTowerBossRun(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      camera: this.camera,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, dmg, kind) => this.#onBossRushScore(id, dmg, kind),
      onEvent: (e) => this.#onBossRushEvent(e),
    });

    // 第 5 层：随机落雷 · 躲雷 + 互推（被劈次数最少者胜）
    this.thunder = new SkyTowerThunderRun(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onThunderScore(id, pts, kind),
      onEvent: (e) => this.#onThunderEvent(e),
      // AI 先爬上来时不该把本层的 75 秒耗光，所以这里要能区分真人与电脑
      isAi: (id) => !!this.players.get(id)?.ai,
    });

    // 第 6 层：塔防 · 杀怪竞速（复用怪物模式的小怪 + 赛艇主炮）
    this.defense = new SkyTowerDefense(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      camera: this.camera,
      input: this.input,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onDefenseScore(id, pts, kind),
      onEvent: (e) => this.#onDefenseEvent(e),
      teamOf: (id) => this.players.get(id)?.team ?? null,
    });

    // 第 7 层：缩圈 · 累计里程竞速（跑得多者胜，掉下去扣里程再抓回圈内）
    this.shrink = new SkyTowerShrinkRun(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onShrinkScore(id, pts, kind),
      onEvent: (e) => this.#onShrinkEvent(e),
      teamOf: (id) => this.players.get(id)?.team ?? null,
      isAi: (id) => !!this.players.get(id)?.ai,
    });

    // 第 8 层：水晶攻防（撞碎对方水晶 / 泡泡炸弹 / 道具箱）
    this.crystal = new SkyTowerCrystalRun(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onCrystalScore(id, pts, kind),
      onEvent: (e) => this.#onCrystalEvent(e),
      sideOf: (id) => this.#sideOf(id),
      isAi: (id) => !!this.players.get(id)?.ai,
      colliders: this.arena.shoreColliders,
    });

    // 第 9 层：涂地竞速（船尾自动留色 / 网格归属 / 撞人断笔）
    this.paint = new SkyTowerPaintRun(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onPaintScore(id, pts, kind),
      onEvent: (e) => this.#onPaintEvent(e),
      sideOf: (id) => this.#sideOf(id),
      isAi: (id) => !!this.players.get(id)?.ai,
      invulnOf: (id) => this.players.get(id)?.invuln || 0,
      colliders: this.arena.shoreColliders,
    });

    // 第 10 层：加冕仪式（抢皇冠 / 加冕区读条）
    this.crown = new SkyTowerCrownRun(this.scene, {
      myId: this.myId,
      isHost: this.isHost,
      solo: this.solo,
      fx: this.fx,
      net: { send: (msg) => this.#netEvent(msg) },
      onToast: (m) => this.onToast(m),
      onScore: (id, pts, kind) => this.#onCrownScore(id, pts, kind),
      onEvent: (e) => this.#onCrownEvent(e),
      sideOf: (id) => this.#sideOf(id),
      isAi: (id) => !!this.players.get(id)?.ai,
      invulnOf: (id) => this.players.get(id)?.invuln || 0,
      colliders: this.arena.shoreColliders,
    });

    // 阶段：intro → cinema → countdown → fight → end
    const skip = skipCinemaByUrl();
    this.phase = 'intro';
    this.intro = skip ? 0 : R.INTRO_TIME;
    this.cinema = skip ? 0 : R.CINEMA_TIME;
    this.countdown = skip ? 0 : R.COUNTDOWN;
    this.timeLeft = R.ROUND_TIME;
    this.fightTime = 0;          // fight 阶段累计时间（结算/榜单用）
    // 2026-11-27 逐层赛制：一层一局（等待全员 → 规则过场 → 60s 比赛 → 清场开门）。
    // 升降光柱按层独立，只有当前层比赛结束时才开。
    this.layerIndex = 0;
    this.layerPhase = 'wait';     // wait | cutscene | round | travel | done
    this.layerTimeLeft = R.LAYER_ROUND;
    this.layerWaitLeft = R.LAYER_WAIT;
    this.cutsceneLeft = 0;
    this.layerNetT = 0;           // 主机层状态广播节流
    this.upliftOpen = false;      // HUD 口径：当前层的升降门是否已开
    this.arena.setUpliftOpen(false);
    this.scenery.setUpliftOpen(false);
    this.endTimer = 0;
    this.hitStop = 0;
    this.shakeScale = 1;
    this.finished = false;
    this.winner = null;
    this.lastLayerShown = 0;
    this.footNet = 0;             // 球位姿广播的节流计时（15Hz）
    this._cardTimer = null;

    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.#buildCinemaPath();
    this.introEl = this.intro > 0 ? this.#makeIntroOverlay() : null;

    // 货物
    this.cargos = [];
    this.cargoSeq = 0;
    this.cargoGroup = new THREE.Group();
    this.cargoGroup.name = 'sky-tower-cargo';
    this.scene.add(this.cargoGroup);
    this.#spawnAllCargo();
    this.cargoOnBoat = new Map();
    this.depositGroup = this.#buildDeposit();

    // 冲刺键：K（Input 没有现成通道，直接挂 keydown，dispose 摘除）
    // 第 3 层还要用 1/2/3 放道具：天梯里 W 是油门，不能照搬道具赛的 Q/W/E
    // （Input.itemMode 一开，W 就被道具槽吞掉，油门直接没了）。
    this.dashQueued = false;
    this.itemQueued = -1;
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyK' || e.key === 'k' || e.key === 'K') {
        this.dashQueued = true;
        return;
      }
      const slot = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }[e.code];
      if (slot != null) this.itemQueued = slot;
    };
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onKeyDown);

    // AI
    this.aiState = new Map();
    for (const id of this.ids) {
      const p = this.players.get(id);
      if (p?.ai) this.aiState.set(id, { think: 0, dashAt: 2 + Math.random() * 2 });
    }

    // 出生：第 1 层按水球赛开球站位（各自半场、面向对方球门）
    this.ids.forEach((id, i) => {
      const boat = this.boats.get(id);
      if (!boat) return;
      const s = this.#spawnTransform(id, i);
      boat.pos.set(s.x, layerY(0) + 0.4, s.z);
      boat.heading = s.heading;
      boat.vel.set(0, 0, 0);
      boat.skyLayer = 0;
      boat.diveTargetY = layerY(0) + 0.4;
      boat.waveJumpEnabled = false;
      boat.waveLaunchEnabled = false;
    });

    this.hud = {};
    this.#syncHud();
    // 第一层的天气立刻生效（第 0 层 = 大厅选的天气，通常和 Game 已套过的同一套，
    // Game 那边会按 id 判重跳过重复的 env.setWeather）
    this.#applyLayerWeather(0);
  }

  /**
   * 切到第 layer 层的天气：天空/灯光由 scenery 自己换，雨雪与水色交给 Game
   * （通过 onLayerWeather 回调调用 env.setWeather / water.setWeather）。
   * @returns {object} 这一层用的 WEATHERS 预设
   */
  #applyLayerWeather(layer) {
    const w = weatherForLayer(layer, this.baseWeatherId);
    this.scenery.setWeather(w, layer);
    this.opts.onLayerWeather?.(w, layer);
    this.lastLayerShown = layer;
    return w;
  }

  // ---------------------------------------------------------------- 场景搭建

  #buildCinemaPath() {
    // 从云海下方仰视 → 绕塔螺旋上升 → 顶层俯瞰 → 落到本地船尾
    const pts = [];
    // 起点在赛场内部（看台外侧会把画面挡成一堵灰墙），从边界内侧仰视整座高塔。
    pts.push(new THREE.Vector3(0, 30, 88));
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      const a = t * Math.PI * 1.55 + Math.PI / 2;
      const y = 30 + t * (R.SPIRE_H * 0.76);
      // 始终在平台半径外绕塔，否则会从下往上看到一层层平台的底面
      const rad = 88 - t * 6;
      pts.push(new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad));
    }
    const me = this.localBoat;
    if (me) {
      const fx = Math.sin(me.heading), fz = Math.cos(me.heading);
      pts.push(new THREE.Vector3(me.pos.x - fx * 12, me.pos.y + 6.5, me.pos.z - fz * 12));
    } else {
      pts.push(new THREE.Vector3(0, 10, 52));
    }
    this.cinemaCurve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.4);
  }

  #buildDeposit() {
    const g = new THREE.Group();
    const y = layerY(layerCount() - 1);
    g.position.set(0, y + 0.5, 0);
    // 顶层中央入账口：金色发光圆盘（不再加旋转光环，光环太抢眼）
    const disk = new THREE.Mesh(
      new THREE.CylinderGeometry(3.2, 3.2, 0.16, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd76a, transparent: true, opacity: 0.55 }),
    );
    g.add(disk);
    this.scene.add(g);
    return g;
  }

  /** 按层配置刷货。货物 mesh 放在 cargoGroup，位置/层记录在 this.cargos */
  #spawnAllCargo() {
    for (let layer = 0; layer < R.LAYER_SPAWN.length; layer++) {
      // 第 1 层水球赛、第 2 层送包子、第 3 层道具箱、第 4 层打 BOSS、
      // 第 5 层躲雷、第 6 层塔防、第 7 层缩圈：这些层都有自己的主角，运货那套货物一律不刷
      if (layer === R.FOOTBALL.LAYER || layer === R.DELIVER.LAYER
        || layer === R.ITEMRUSH.LAYER || layer === R.BOSSRUSH.LAYER
        || layer === R.THUNDER.LAYER || layer === R.DEFENSE.LAYER
        || layer === R.SHRINK.LAYER || layer === R.CRYSTAL.LAYER
        || layer === R.PAINT.LAYER || layer === R.CROWN.LAYER) continue;
      const cfg = R.LAYER_SPAWN[layer];
      R.CARGO_TYPES.forEach((type, ti) => {
        for (let k = 0; k < (cfg.counts[ti] || 0); k++) this.#spawnOneCargo(type, layer);
      });
    }
  }

  #spawnOneCargo(type, layer) {
    const rad = layerRadius(layer) * (0.35 + Math.random() * 0.52);
    const a = Math.random() * TWO_PI;
    const mesh = SkyTowerArena.makeCargoMesh(type);
    const pos = new THREE.Vector3(Math.cos(a) * rad, layerY(layer) + 1.15, Math.sin(a) * rad);
    mesh.position.copy(pos);
    this.cargoGroup.add(mesh);
    this.cargos.push({
      id: ++this.cargoSeq, type, typeId: type.id, layer, mesh,
      respawnAt: 0, phase: Math.random() * TWO_PI,
    });
  }

  // ---------------------------------------------------------------- 开场动画

  #makeIntroOverlay() {
    try {
      const el = document.createElement('div');
      el.id = 'tower-intro';
      const title = '云端天梯';
      const chars = [...title].map((ch, i) =>
        `<span style="animation-delay:${Math.round(i * 45)}ms">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
      el.innerHTML = [
        '<div class="ti-veil"></div>',
        '<div class="ti-card">',
        `<div class="ti-title">${chars}</div>`,
        '<div class="ti-rule"></div>',
        '</div>',
        '<div class="ti-count"></div>',
      ].join('');
      document.body.appendChild(el);
      document.body.classList.add('intro-on');
      return el;
    } catch { return null; }
  }

  #tickIntroCount(sec) {
    const el = this.introEl;
    if (!el) return;
    el.classList.add('ti-counting');
    const c = el.querySelector('.ti-count');
    if (!c) return;
    const n = String(Math.max(1, Math.ceil(sec)));
    if (c.dataset.n === n) return;
    c.dataset.n = n;
    c.textContent = n;
    c.classList.remove('pop');
    void c.offsetWidth;
    c.classList.add('pop');
  }

  #endIntro() {
    const el = this.introEl;
    this.introEl = null;
    document.body.classList.remove('intro-on');
    if (!el) return;
    el.classList.add('ti-done');
    setTimeout(() => el.remove(), 600);
  }

  // ---------------------------------------------------------------- 逐层规则卡

  /** 全屏规则过场卡（review=true 时是玩家点「?」再看的，不自动关太早） */
  #showLayerCard(layer, review = false) {
    try {
      const info = R.LAYER_INFO[layer] || { name: `第 ${layer + 1} 层`, rule: '' };
      let el = document.getElementById('tower-layer-card');
      if (!el) {
        el = document.createElement('div');
        el.id = 'tower-layer-card';
        el.className = 'tower-layer-card';
        document.body.appendChild(el);
      }
      el.classList.toggle('review', !!review);
      el.dataset.layer = String(layer);
      el.innerHTML = [
        '<div class="tlc-veil"></div>',
        '<div class="tlc-body">',
        `<div class="tlc-step">第 ${layer + 1} / ${layerCount()} 层</div>`,
        `<div class="tlc-name">${info.name || ''}</div>`,
        `<div class="tlc-rule">${info.rule || ''}</div>`,
        `<div class="tlc-time">本层 ${R.LAYER_ROUND} 秒 · 时间到清场并开启升降门</div>`,
        '</div>',
      ].join('');
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
      if (this._cardTimer) clearTimeout(this._cardTimer);
      this._cardTimer = setTimeout(() => this.#hideLayerCard(),
        (review ? 4.5 : R.LAYER_CUTSCENE) * 1000);
      this.#showLayerBanner(layer);
    } catch { /* 无 DOM 环境（探针）忽略 */ }
  }

  #hideLayerCard() {
    try {
      const el = document.getElementById('tower-layer-card');
      if (el) el.classList.remove('show');
    } catch { /* ignore */ }
  }

  /** 常驻小横幅：随时点一下就能重看本层规则 */
  #showLayerBanner(layer) {
    try {
      let el = document.getElementById('tower-rule-btn');
      if (!el) {
        el = document.createElement('button');
        el.id = 'tower-rule-btn';
        el.type = 'button';
        el.className = 'tower-rule-btn';
        el.addEventListener('click', () => this.#showLayerCard(this.layerIndex, true));
        document.body.appendChild(el);
      }
      const info = R.LAYER_INFO[layer] || {};
      el.textContent = `第 ${layer + 1} 层 · ${info.name || ''} · 规则 ?`;
      el.classList.remove('hidden');
    } catch { /* ignore */ }
  }

  #hideLayerBanner() {
    try {
      const el = document.getElementById('tower-rule-btn');
      if (el) el.classList.add('hidden');
    } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- 接口：对齐 BossMode

  canControl() {
    // 规则过场期间镜头在环绕本层，暂时交给自动镜头；其余 fight 阶段正常操作
    return this.phase === 'fight' && this.layerPhase !== 'cutscene' && !this.finished;
  }

  /** 冲刺改写输入；同时每帧把船钉在当前平台高度（浮空物理的关键） */
  driveBoat(dt, rawInput) {
    if (!this.localBoat) return rawInput;
    this.#driveOne(this.localBoat, this.myId, dt, rawInput);
    return rawInput;
  }

  #driveOne(boat, id, dt, rawInput) {
    const p = this.players.get(id);
    if (!p || !boat) return;
    // 浮空高度：螺旋爬升由 arena 推进，其余时间贴当前层
    if (!boat.liftRide) boat.diveTargetY = layerY(p.layer) + 0.4;
    // 能量恢复 & 过热
    p.energy = Math.min(R.DASH_ENERGY_MAX, p.energy + R.DASH_REGEN * dt);
    p.overheat = Math.max(0, p.overheat - dt);
    p.ramCd = Math.max(0, p.ramCd - dt);
    p.invuln = Math.max(0, p.invuln - dt);
    const now = performance.now() / 1000;
    p.dashTimes = p.dashTimes.filter((t) => now - t <= R.DASH_WINDOW);

    // 过热期间：锁转向（只锁方向，速度保留 → 风险来自"你控制不了往哪开"）
    const input = rawInput;
    if (p.overheat > 0) {
      input.steer *= 0.06;
    }

    // 第 2 层：背着包子的人变慢、转向变钝，而且**不能放泡泡**（只能跑）
    const onDeliver = !!this.deliver && p.layer === R.DELIVER.LAYER;
    if (onDeliver) {
      const carry = this.deliver.isCarrier(id);
      boat.speedMul = carry ? R.DELIVER.CARRY_SPEED : 1;
      if (carry) input.steer *= R.DELIVER.CARRY_TURN;
      if (id === this.myId && this.dashQueued) {
        this.dashQueued = false;
        this.deliver.fire(id, boat, this.ids.indexOf(id));
      }
    } else if (boat.speedMul !== 1) {
      boat.speedMul = 1;
    }

    // 第 10 层：持冠者极速 ×0.78、且不能冲刺
    if (this.crown && p.layer === R.CROWN.LAYER) {
      boat.speedMul = this.crown.isHolder(id) ? R.CROWN.HOLD_SPEED : 1;
    }
    const holdCrown = !!this.crown && p.layer === R.CROWN.LAYER && this.crown.isHolder(id);

    // 冲刺触发：本地玩家用 K，AI 用定时
    let wantDash = false;
    if (id === this.myId) {
      wantDash = this.dashQueued;
      this.dashQueued = false;
    } else {
      const st = this.aiState.get(id);
      // 第 7 层不给 AI 冲刺：26 的爆发速度配上缩圈半径，它一冲就飞出玻璃盘
      // （探针 fallLog 里 AI 全是 arena@d≥36，里程白白清零）
      if (st && now >= st.dashAt && this.phase === 'fight' && p.layer !== R.SHRINK.LAYER) {
        // AI 只在靠近对手或顶层时冲
        const near = this.#nearestFoe(id);
        if (near && near.d < 16) { wantDash = true; st.dashAt = now + 3 + Math.random() * 3; }
      }
    }
    if (!onDeliver && !holdCrown && wantDash && p.energy >= R.DASH_COST && this.phase === 'fight' && p.alive) {
      p.energy -= R.DASH_COST;
      p.dashTimes.push(now);
      boat.boostTimer = Math.max(boat.boostTimer || 0, 0.65);
      // 速度直给：冲刺是短爆发，和氮气尾焰走同一套视觉
      const fx = Math.sin(boat.heading), fz = Math.cos(boat.heading);
      boat.vel.x += fx * R.DASH_BOOST;
      boat.vel.y += fz * R.DASH_BOOST;
      this.fx?.play?.('nitro', boat.pos.x, boat.pos.y, boat.pos.z, 1.6);
      if (p.dashTimes.length >= R.DASH_THRESHOLD) {
        p.overheat = R.OVERHEAT_TIME;
        p.dashTimes.length = 0;
        if (id === this.myId) this.onToast('⚠ 冲刺过热：转向失控 2 秒');
      }
      this.#netEvent({ t: 'towerDash', id, e: p.energy, oh: p.overheat });
    }
  }

  driveAi(dt, boat, id) {
    const p = this.players.get(id);
    const st = this.aiState.get(id);
    const idle = { throttle: 0, steer: 0, drift: false, nitro: false };
    if (!p || !boat || !st) return idle;
    if (this.phase !== 'fight') {
      if (!boat.liftRide) boat.diveTargetY = layerY(p.layer) + 0.4;
      return idle;
    }
    this.#driveOne(boat, id, dt, { throttle: 1, steer: 0, drift: false, nitro: false });
    // 简单 AI：逐层赛制下，只有本层正在比赛才去抢目标；比赛结束（travel）先开进升降门。
    let tx = 0, tz = 0;
    if (this.layerPhase === 'travel') {
      // 还没到下一层：朝本层升降门开；已经上楼：原地等比赛开始
      if (p.layer <= this.layerIndex) {
        const up = this.arena.uplinks[p.layer];
        if (!up) return idle;
        tx = up.x; tz = up.z;
      } else {
        return idle;
      }
    } else if (this.layerPhase !== 'round') {
      return idle;
    } else if (this.football && p.layer === 0) {
      // 站到球的"自家一侧"再往前顶：比直接朝球开会少很多"把球顶进自家门"的乌龙
      const t = this.football.aiTarget(id, this.ids.indexOf(id));
      tx = t.x; tz = t.z;
    } else if (this.deliver && p.layer === R.DELIVER.LAYER) {
      const plan = this.deliver.aiPlan(id, this.ids.indexOf(id), this.boats);
      tx = plan.x; tz = plan.z;
      if (plan.fire && this.phase === 'fight') this.deliver.fire(id, boat, this.ids.indexOf(id));
    } else if (this.itemRush && p.layer === R.ITEMRUSH.LAYER) {
      // 道具箱大乱斗：AI 朝最近的箱子开（道具由 ItemManager 的 #aiPickItem 自己放）
      const box = this.#nearestBox(boat);
      if (box) { tx = box.x; tz = box.z; }
      else {
        const foe = this.#nearestFoe(id);
        if (foe) { tx = foe.boat.pos.x; tz = foe.boat.pos.z; }
      }
    } else if (this.thunder && p.layer === R.THUNDER.LAYER) {
      // 落雷层：踩进红圈就往外跑，否则去撞对手（把对手推到雷点上）
      const foe = this.#nearestFoe(id);
      const t = this.thunder.aiTarget(boat, foe?.boat || null);
      if (t) { tx = t.x; tz = t.z; }
      else if (foe) { tx = foe.boat.pos.x; tz = foe.boat.pos.z; }
    } else if (this.defense && p.layer === R.DEFENSE.LAYER) {
      // 塔防层：追最近的小怪（船头对着它，主炮的炮塔修正才够得着）
      const t = this.defense.aiTarget(boat);
      if (t) { tx = t.x; tz = t.z; }
      else {
        const foe = this.#nearestFoe(id);
        if (foe) { tx = foe.boat.pos.x; tz = foe.boat.pos.z; }
      }
    } else if (this.shrink && p.layer === R.SHRINK.LAYER) {
      // 缩圈层：贴着安全圈绕圈攒里程，被挤到圈外先往塔心跑
      const t = this.shrink.aiTarget(boat);
      if (t) { tx = t.x; tz = t.z; }
      else { const foe = this.#nearestFoe(id); if (foe) { tx = foe.boat.pos.x; tz = foe.boat.pos.z; } }
    } else if (this.crystal && p.layer === R.CRYSTAL.LAYER) {
      // 水晶层：先吃箱子攒泡泡，再压到对方水晶
      const t = this.crystal.aiTarget(boat, id);
      if (t) { tx = t.x; tz = t.z; }
    } else if (this.paint && p.layer === R.PAINT.LAYER) {
      // 涂地层：找最近一块不是自己颜色的地盘
      const t = this.paint.aiTarget(boat, id);
      if (t) { tx = t.x; tz = t.z; }
    } else if (this.crown && p.layer === R.CROWN.LAYER) {
      // 加冕层：空冠去抢、别人持冠去追、自己持冠回自家加冕区
      const t = this.crown.aiTarget(boat, id);
      if (t) { tx = t.x; tz = t.z; }
    } else {
      const foe = this.#nearestFoe(id);
      if (foe) { tx = foe.boat.pos.x; tz = foe.boat.pos.z; }
    }
    const want = Math.atan2(tx - boat.pos.x, tz - boat.pos.z);
    let diff = want - boat.heading;
    while (diff > Math.PI) diff -= TWO_PI;
    while (diff < -Math.PI) diff += TWO_PI;
    return {
      throttle: 1,
      steer: THREE.MathUtils.clamp(diff * 1.6, -1, 1),
      drift: false,
      nitro: false,
    };
  }

  constrainBoat(boat) {
    // 实际边界在 arena.constrain（Game 的 track.constrain 调用），这里只做船-船撞击掉货
    if (this.phase !== 'fight') return;
    const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
    if (!id) return;
    const p = this.players.get(id);
    if (!p || p.ramCd > 0 || p.overheat > 0) return;
    for (const otherId of this.ids) {
      if (otherId === id) continue;
      const ob = this.boats.get(otherId);
      const op = this.players.get(otherId);
      if (!ob || !op) continue;
      // 不同层的船撞不到
      if (Math.abs((ob.pos.y || 0) - (boat.pos.y || 0)) > 5) continue;
      const d = Math.hypot(ob.pos.x - boat.pos.x, ob.pos.z - boat.pos.z);
      if (d > R.RAM_R) continue;
      const rel = Math.hypot(boat.vel.x - ob.vel.x, boat.vel.y - ob.vel.y);
      if (rel < R.RAM_MIN) continue;
      const idx = rel > 24 ? 2 : rel > 15 ? 1 : 0;
      const dropN = R.RAM_DROP[idx];
      this.#dropCargo(op, dropN, ob);
      p.ramCd = R.RAM_COOLDOWN;
      // 推人下平台：沿"攻击者 → 对手"方向给冲量 + 一点上抛，速度越快推得越远。
      // 这是玩家互坑的核心趣味点；冲刺撞边缘可以直接把人送下塔。
      // 第 5 层落雷竞技要把人推进红圈，推力额外放大 PUSH_SCALE（用户指定玩法）。
      if (op.pushCd <= 0) {
        const nx = d > 0.01 ? (ob.pos.x - boat.pos.x) / d : Math.sin(boat.heading);
        const nz = d > 0.01 ? (ob.pos.z - boat.pos.z) / d : Math.cos(boat.heading);
        const pushScale = p.layer === R.THUNDER.LAYER ? R.THUNDER.PUSH_SCALE : 1;
        const impulse = Math.min(R.PUSH_MAX, R.PUSH_BASE + rel * R.PUSH_PER_SPEED)
          * (1 + idx * 0.12) * pushScale;
        ob.vel.x += nx * impulse;
        ob.vel.y += nz * impulse;
        ob.vy = Math.max(ob.vy || 0, R.PUSH_LIFT);
        op.pushCd = R.PUSH_INVULN;
        //  attacker 轻反弹，撞完不会"粘"在对手身上
        boat.vel.x -= nx * impulse * 0.22;
        boat.vel.y -= nz * impulse * 0.22;
        p.pushCd = R.PUSH_INVULN * 0.5;
        if (otherId === this.myId) this.onToast('💥 被撞飞了！稳住方向');
      }
      this.fx?.play?.('hit', ob.pos.x, ob.pos.y, ob.pos.z, 1.2);
      if (id === this.myId) this.onToast(`💥 撞掉对手 ${dropN} 件货物`);
      if (otherId === this.myId) this.onToast(`💥 被撞掉 ${dropN} 件货物！`);
      break;
    }
  }

  update(dt, elapsed = 0) {
    if (this.disposed) return;
    this.scenery.update(dt);

    // 开场流程
    if (this.phase === 'intro') {
      this.intro -= dt;
      if (this.introEl) this.introEl.classList.toggle('ti-out', this.intro <= 0.9);
      if (this.intro <= 0) {
        this.#endIntro();
        this.phase = 'cinema';
      }
      return;
    }
    if (this.phase === 'cinema') {
      this.cinema -= dt;
      if (this.cinema <= 3 && this.cinema > 0) this.#tickIntroCount(this.cinema);
      if (this.cinema <= 0) {
        this.phase = 'countdown';
        this.countdown = R.COUNTDOWN;
        this.onCinemaEnd?.();
      }
      return;
    }
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'fight';
        // 倒计时结束不直接开球：先播第 1 层的规则过场（镜头环绕），再开始 60 秒比赛。
        // 客机不自己推进阶段，等房主的 towerLayer 广播。
        if (this.isHost || this.solo) this.#beginLayer(0);
      }
      // 倒计时期间货物/球的动画照常，但不做玩法结算
      this.#updateCargoVisual(dt, elapsed);
      this.football?.update(dt, []);
      this.deliver?.update(dt, []);
      this.thunder?.update(dt, []);
      this.defense?.update(dt, []);
      this.shrink?.update(dt, []);
      this.crystal?.update(dt, []);
      this.paint?.update(dt, []);
      this.crown?.update(dt, []);
      return;
    }
    if (this.phase === 'end') {
      this.endTimer -= dt;
      this.#updateCargoVisual(dt, elapsed);
      this.football?.update(dt, []);
      this.deliver?.update(dt, []);
      this.thunder?.update(dt, []);
      this.defense?.update(dt, []);
      this.shrink?.update(dt, []);
      this.crystal?.update(dt, []);
      this.paint?.update(dt, []);
      this.crown?.update(dt, []);
      if (this.endTimer <= 0 && !this.finished) {
        this.finished = true;
        this.#finish();
      }
      return;
    }

    // ---- fight ----
    this.timeLeft -= dt;
    this.fightTime += dt;
    for (const p of this.players.values()) p.pushCd = Math.max(0, p.pushCd - dt);
    // 只有「本层正在比赛」时才把船喂给该层小游戏；过场/等上楼/上楼途中一律空表，
    // 这样不会在规则过场里偷偷计分，也不会在上一层结算后继续刷分。
    const live = this.layerPhase === 'round' ? this.layerIndex : -1;
    this.#updateCargoVisual(dt, elapsed);
    this.#updateFootball(dt, live === 0);
    this.#updateDeliver(dt, live === 1);
    this.#updateItemRush(dt, live === 2);
    this.#updateBossRush(dt, live === 3);
    this.#updateThunder(dt, live === 4);
    this.#updateDefense(dt, live === 5);
    this.#updateShrink(dt, live === 6);
    this.#updateCrystal(dt, live === 7);
    this.#updatePaint(dt, live === 8);
    this.#updateCrown(dt, live === 9);
    this.#updateRespawns(dt);
    this.#checkPickups();
    this.#checkDeposit();
    // 逐层状态机：等全员 → 过场 → 比赛 → 清场开门 → 上一层
    this.#updateLayerFlow(dt);
    if (this.timeLeft <= 0) {
      this.phase = 'end';
      this.endTimer = R.END_TIME;
      this.#syncHud();
    }
  }

  // ---------------------------------------------------------------- 逐层赛制

  /** 当前层对应的层模块（清场 / 结束本层时要单独触发一次收尾） */
  #moduleForLayer(layer) {
    switch (layer) {
      case 0: return this.football;
      case 1: return this.deliver;
      case 2: return this.itemRush;
      case 3: return this.bossRush;
      case 4: return this.thunder;
      case 5: return this.defense;
      case 6: return this.shrink;
      case 7: return this.crystal;
      case 8: return this.paint;
      case 9: return this.crown;
      default: return null;
    }
  }

  /** 该层所有参战者（含 AI）是否都已在平台上、没有还在升降途中 */
  #allArrived(layer) {
    for (const id of this.ids) {
      const p = this.players.get(id);
      if (!p) continue;
      const boat = this.boats.get(id);
      if (boat?.liftRide) return false;
      if ((p.layer | 0) !== layer) return false;
    }
    return true;
  }

  /** 开始一层的规则过场（镜头环绕 + 规则卡），过场结束再开 60 秒比赛 */
  #beginLayer(layer) {
    this.layerIndex = layer;
    this.layerPhase = 'cutscene';
    this.cutsceneLeft = R.LAYER_CUTSCENE;
    this.layerWaitLeft = R.LAYER_WAIT;
    this.layerTimeLeft = R.LAYER_ROUND;
    this.upliftOpen = false;
    this.arena.setUpliftOpen(false, layer);
    this.scenery.setUpliftOpen(false, layer);
    this.#applyLayerWeather(layer);
    this.#showLayerCard(layer, false);
    if (this.phase === 'fight') this.onCinemaEnd?.();
    if (this.isHost && !this.solo) this.#netEvent({ t: 'towerLayer', ...this.#layerState() });
  }

  /** 过场结束：给本层小游戏设成统一的 60 秒并正式开赛 */
  #startRound(layer) {
    this.layerPhase = 'round';
    this.layerTimeLeft = R.LAYER_ROUND;
    const mod = this.#moduleForLayer(layer);
    // 各层原来 60/75/90 秒不等；逐层赛制统一成 1 分钟，让模块自己的结算与开层同步。
    if (mod && Number.isFinite(mod.timeLeft)) {
      mod.timeLeft = R.LAYER_ROUND;
      if ('running' in mod) mod.running = true;
    }
    this.#hideLayerCard();
    // 镜头从环绕位直接切回船尾，别让玩家在开赛瞬间看着镜头慢慢飞回来
    this.onCinemaEnd?.();
    const info = R.LAYER_INFO[layer] || {};
    this.onToast(`▶ 第 ${layer + 1} 层 · ${info.name || ''} · ${R.LAYER_ROUND} 秒`);
    if (this.isHost && !this.solo) this.#netEvent({ t: 'towerLayer', ...this.#layerState() });
  }

  /** 本层比赛结束：清掉拾取物 / 目标物，开升降门；第 10 层直接结算 */
  #endRound() {
    const layer = this.layerIndex;
    // 先让本层模块跑完自己的收尾（排名分 / 播报），再清场；已经在同一帧自然结束的会跳过
    const mod = this.#moduleForLayer(layer);
    if (mod && Number.isFinite(mod.timeLeft) && mod.running !== false) {
      mod.timeLeft = 0;
      try { mod.update(0, []); } catch { /* 结算失败不阻断开层 */ }
    }
    this.#clearLayer(layer);
    const last = layer >= layerCount() - 1;
    if (last) {
      // 第 10 层没有上一层：1 分钟到直接进结算
      this.layerPhase = 'done';
      this.phase = 'end';
      this.endTimer = R.END_TIME;
      this.onToast('👑 最后一层结束 · 正在结算');
      this.#syncHud();
      if (this.isHost && !this.solo) this.#netEvent({ t: 'towerLayer', ...this.#layerState() });
      return;
    }
    this.layerPhase = 'travel';
    this.layerWaitLeft = R.LAYER_WAIT;
    this.upliftOpen = true;
    this.arena.setUpliftOpen(true, layer);
    this.scenery.setUpliftOpen(true, layer);
    const info = R.LAYER_INFO[layer + 1] || {};
    this.onToast(`⏱ 第 ${layer + 1} 层结束 · 升降门开启，前往第 ${layer + 2} 层${info.name ? ` · ${info.name}` : ''}`);
    if (this.isHost && !this.solo) {
      this.#netEvent({ t: 'towerOpen', layer });
      this.#netEvent({ t: 'towerLayer', ...this.#layerState() });
    }
  }

  /** 清场：足球 / 货物 / 道具箱 / 泡泡 / 皇冠消失，地形与障碍保留 */
  #clearLayer(layer) {
    const mod = this.#moduleForLayer(layer);
    if (mod?.clearPickups) {
      try { mod.clearPickups(); } catch { /* 清场失败不影响流程 */ }
    }
  }

  /** 逐层状态机（主机推进；客机只跟时间显示，状态由 towerLayer 驱动） */
  #updateLayerFlow(dt) {
    const host = this.isHost || this.solo;
    if (host) {
      if (this.layerPhase === 'wait') {
        this.layerWaitLeft -= dt;
        const ok = this.#allArrived(this.layerIndex);
        if (ok || this.layerWaitLeft <= 0) {
          if (!ok) this.#forcePullAll(this.layerIndex);
          this.#beginLayer(this.layerIndex);
        }
      } else if (this.layerPhase === 'cutscene') {
        this.cutsceneLeft -= dt;
        if (this.cutsceneLeft <= 0) this.#startRound(this.layerIndex);
      } else if (this.layerPhase === 'round') {
        this.layerTimeLeft -= dt;
        if (this.layerTimeLeft <= 0) this.#endRound();
      } else if (this.layerPhase === 'travel') {
        this.layerWaitLeft -= dt;
        const target = this.layerIndex + 1;
        const ok = this.#allArrived(target);
        if (ok || this.layerWaitLeft <= 0) {
          if (!ok) this.#forcePullAll(target);
          this.#beginLayer(target);
        }
      }
    } else {
      // 客机：本地平滑推进计时（真正的阶段切换看 towerLayer）
      if (this.layerPhase === 'cutscene') this.cutsceneLeft = Math.max(0, this.cutsceneLeft - dt);
      if (this.layerPhase === 'round') this.layerTimeLeft = Math.max(0, this.layerTimeLeft - dt);
      if (this.layerPhase === 'wait' || this.layerPhase === 'travel') {
        this.layerWaitLeft = Math.max(0, this.layerWaitLeft - dt);
      }
    }
    // 主机 2Hz 广播层状态，客机漂移会被拉回来
    if (host && !this.solo && this.net) {
      this.layerNetT -= dt;
      if (this.layerNetT <= 0) {
        this.layerNetT = 0.5;
        this.#netEvent({ t: 'towerLayer', ...this.#layerState() });
      }
    }
  }

  #layerState() {
    return {
      layer: this.layerIndex,
      ph: this.layerPhase,
      left: +this.layerTimeLeft.toFixed(2),
      wait: +this.layerWaitLeft.toFixed(2),
    };
  }

  #applyRemoteUplift(layer) {
    const L = Math.max(0, Math.min(layerCount() - 1, (layer | 0)));
    this.upliftOpen = true;
    this.arena.setUpliftOpen(true, L);
    this.scenery.setUpliftOpen(true, L);
  }

  /** 客机跟随房主的逐层状态 */
  #applyLayerState(e) {
    const layer = Math.max(0, Math.min(layerCount() - 1, e.layer | 0));
    const prev = this.layerIndex;
    const prevPhase = this.layerPhase;
    this.layerIndex = layer;
    if (e.ph) this.layerPhase = e.ph;
    if (Number.isFinite(e.left)) this.layerTimeLeft = Math.max(0, e.left);
    if (Number.isFinite(e.wait)) this.layerWaitLeft = Math.max(0, e.wait);
    // 本层比赛结束：客机跟着清场（房主已清，这里保证画面一致）
    if (prevPhase === 'round' && this.layerPhase !== 'round') this.#clearLayer(prev);
    if (layer !== prev) this.#applyLayerWeather(layer);
    if (this.layerPhase === 'cutscene' && (prev !== layer || prevPhase !== 'cutscene')) {
      this.cutsceneLeft = Math.max(this.cutsceneLeft, R.LAYER_CUTSCENE);
      this.#showLayerCard(layer, false);
      this.onCinemaEnd?.();
    }
    if (this.layerPhase === 'round') {
      // 客机：进入/切换本层时把模块倒计时对齐房主；之后本地平滑跑，等下一次广播纠偏
      if (prevPhase !== 'round' || prev !== layer) {
        const mod = this.#moduleForLayer(layer);
        if (mod && Number.isFinite(mod.timeLeft)) {
          mod.timeLeft = Math.max(0, Math.min(R.LAYER_ROUND, this.layerTimeLeft));
          if ('running' in mod) mod.running = true;
        }
      }
      this.#hideLayerCard();
    }
    this.upliftOpen = this.layerPhase === 'travel';
  }

  /** 超时强拉：本地船 / AI 直接挪到目标层，客机收到 towerPull 自己挪 */
  #forcePullAll(layer) {
    const remote = [];
    for (const id of this.ids) {
      const p = this.players.get(id);
      const boat = this.boats.get(id);
      if (!p || !boat) continue;
      if ((p.layer | 0) === layer && !boat.liftRide) continue;
      if (id === this.myId || p.ai) this.#teleportToLayer(id, p, boat, layer);
      else remote.push(id);
    }
    if (remote.length && !this.solo) this.#netEvent({ t: 'towerPull', layer, ids: remote });
  }

  #teleportToLayer(id, p, boat, layer) {
    const a = Math.atan2(boat.pos.z, boat.pos.x) || 0;
    const rad = layerRadius(layer) * 0.45;
    boat.pos.set(Math.cos(a) * rad, layerY(layer) + 0.4, Math.sin(a) * rad);
    boat.vel.set(0, 0, 0);
    boat.vy = 0;
    boat.speed = 0;
    boat.liftRide = null;
    boat.skyLayer = layer;
    boat.diveTargetY = layerY(layer) + 0.4;
    p.layer = layer;
    p.invuln = Math.max(p.invuln || 0, 1.5);
    if (id === this.myId) this.onRespawn?.();
    if (!this.solo) this.#netEvent({ t: 'towerLand', id, layer });
  }

  /** 落地广播：让主机/客机都拿到每个人的当前层（等全员到齐要靠它） */
  #broadcastLand(id, layer) {
    if (this.solo) return;
    this.#netEvent({ t: 'towerLand', id, layer });
  }

  #updateCargoVisual(dt, t) {
    for (const c of this.cargos) {
      if (!c.mesh.visible) continue;
      c.mesh.rotation.y += dt * 0.9;
      c.mesh.position.y = layerY(c.layer) + 1.15 + Math.sin(t * 2 + c.phase) * 0.22;
      if (c.mesh.userData.halo) c.mesh.userData.halo.rotation.z += dt * 1.4;
    }
  }

  #updateRespawns(dt) {
    for (const p of this.players.values()) {
      if (p.alive || p.respawn <= 0) continue;
      p.respawn -= dt;
      if (p.respawn > 0) continue;
      p.alive = true;
      p.invuln = 1.5;
      const boat = this.boats.get(p.id);
      if (boat) {
        const s = this.#spawnTransform(p.id, this.ids.indexOf(p.id));
        boat.pos.set(s.x, layerY(s.layer) + 0.4, s.z);
        boat.heading = s.heading;
        boat.vel.set(0, 0, 0);
        boat.skyLayer = 0;
        boat.diveTargetY = layerY(0) + 0.4;
        boat.liftRide = null;
      }
      p.layer = 0;
      if (p.id === this.myId) this.onCinemaEnd?.();
    }
  }

  // ---------------------------------------------------------------- 玩法核心

  #nearestCargo(id) {
    const p = this.players.get(id);
    const boat = this.boats.get(id);
    if (!p || !boat) return null;
    let best = null, bd = Infinity;
    for (const c of this.cargos) {
      if (!c.mesh.visible || c.layer !== p.layer) continue;
      const dx = c.mesh.position.x - boat.pos.x;
      const dz = c.mesh.position.z - boat.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /**
   * 第 3 层：找最近的可吃箱子。
   * 箱子坐标由 `SkyTowerItemRush` 按同心圆布好，`active=false` 是刚被吃掉、
   * 正在等补（`respawn`）的，不能当成目标，否则 AI 会围着一个空格子转。
   */
  #nearestBox(boat) {
    const rush = this.itemRush;
    if (!rush || !boat) return null;
    let best = null, bd = Infinity;
    for (const b of rush.items.boxes) {
      if (!b.active) continue;
      const d = (b.x - boat.pos.x) ** 2 + (b.z - boat.pos.z) ** 2;
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  #nearestFoe(id) {
    const boat = this.boats.get(id);
    if (!boat) return null;
    let best = null, bd = Infinity;
    for (const fid of this.ids) {
      if (fid === id) continue;
      const ob = this.boats.get(fid);
      const op = this.players.get(fid);
      if (!ob || !op?.alive) continue;
      const d = Math.hypot(ob.pos.x - boat.pos.x, ob.pos.z - boat.pos.z);
      if (d < bd) { bd = d; best = { id: fid, boat: ob, d }; }
    }
    return best;
  }

  #checkPickups() {
    for (const [id, p] of this.players) {
      const boat = this.boats.get(id);
      if (!boat || !p.alive) continue;
      if (p.cargo.length >= R.CARGO_MAX) continue;
      for (const c of this.cargos) {
        if (!c.mesh.visible || c.layer !== p.layer) continue;
        const d = Math.hypot(c.mesh.position.x - boat.pos.x, c.mesh.position.z - boat.pos.z);
        if (d > pickupRadius(c.layer)) continue;
        // 捡起：从场景移除，挂到船尾
        c.mesh.visible = false;
        c.respawnAt = performance.now() / 1000 + R.RESPAWN_CARGO;
        p.cargo.push(c);
        this.#attachCargo(id, c);
        if (id === this.myId) {
          this.fx?.play?.('ring', boat.pos.x, boat.pos.y, boat.pos.z, 0.5);
          this.onToast(`📦 拾取 ${c.type.name}（+${c.type.value}）`);
        }
        break;
      }
    }
    // 补货：被捡走的货在原点附近重生
    const now = performance.now() / 1000;
    for (const c of this.cargos) {
      if (c.mesh.visible || !c.respawnAt || now < c.respawnAt) continue;
      c.mesh.visible = true;
      const rad = layerRadius(c.layer) * (0.35 + Math.random() * 0.52);
      const a = Math.random() * TWO_PI;
      c.mesh.position.set(Math.cos(a) * rad, layerY(c.layer) + 1.15, Math.sin(a) * rad);
      c.respawnAt = 0;
    }
  }

  #attachCargo(id, c) {
    const boat = this.boats.get(id);
    if (!boat) return;
    let list = this.cargoOnBoat.get(id);
    if (!list) { list = []; this.cargoOnBoat.set(id, list); }
    const i = list.length;
    c.mesh.position.set(boat.pos.x - Math.sin(boat.heading) * (2 + i * 0.13),
      boat.pos.y + 0.8 + (i % 2) * 0.35, boat.pos.z - Math.cos(boat.heading) * (2 + i * 0.13));
    c.attached = true;
    list.push(c);
  }

  /** 掉货：从船上摘下 N 件，散落到当前层地面（谁都能捡） */
  #dropCargo(p, n, boat) {
    if (!p || !boat) return;
    const list = this.cargoOnBoat.get(p.id) || [];
    const drop = Math.min(n, list.length);
    for (let k = 0; k < drop; k++) {
      const c = list.pop();
      const a = Math.random() * TWO_PI;
      const rr = Math.random() * R.DROP_SPREAD;
      c.layer = p.layer;
      c.mesh.position.set(
        THREE.MathUtils.clamp(boat.pos.x + Math.cos(a) * rr, -layerRadius(p.layer) + 2, layerRadius(p.layer) - 2),
        layerY(p.layer) + 1.15,
        THREE.MathUtils.clamp(boat.pos.z + Math.sin(a) * rr, -layerRadius(p.layer) + 2, layerRadius(p.layer) - 2),
      );
      c.mesh.visible = true;
      c.attached = false;
      c.respawnAt = 0;
      const ci = p.cargo.indexOf(c);
      if (ci >= 0) p.cargo.splice(ci, 1);
    }
    // 同步船尾剩余货位置
    list.forEach((c, i) => {
      c.mesh.position.set(boat.pos.x - Math.sin(boat.heading) * (2 + i * 0.13),
        boat.pos.y + 0.8 + (i % 2) * 0.35, boat.pos.z - Math.cos(boat.heading) * (2 + i * 0.13));
    });
  }

  /** 顶层中央入账：身上有货 + 靠近中心 → 全部兑换成分数，回底层重开一轮 */
  #checkDeposit() {
    for (const [id, p] of this.players) {
      const boat = this.boats.get(id);
      if (!boat || !p.alive || p.layer !== layerCount() - 1) continue;
      const d = Math.hypot(boat.pos.x, boat.pos.z);
      if (d > 4.2) continue;
      const list = this.cargoOnBoat.get(id) || [];
      if (!list.length) continue;
      const value = list.reduce((s, c) => s + c.type.value, 0);
      p.score += value;
      // 货物清空并送回"待重生"，下一轮场上还会刷
      while (list.length) {
        const c = list.pop();
        c.mesh.visible = false;
        c.respawnAt = performance.now() / 1000 + R.RESPAWN_CARGO;
      }
      p.cargo.length = 0;
      p.layer = 0;
      boat.skyLayer = 0;
      const home = this.#spawnTransform(id, this.ids.indexOf(id));
      boat.pos.set(home.x, layerY(0) + 0.4, home.z);
      boat.diveTargetY = layerY(0) + 0.4;
      boat.liftRide = null;
      if (id === this.myId) {
        this.fx?.play?.('ring', boat.pos.x, boat.pos.y, boat.pos.z, 2.2);
        this.onToast(`🏆 入账 +${value} 分！返回底层，再来一轮`);
      }
      this.#netEvent({ t: 'towerScore', id, s: p.score });
    }
    // 船尾货物每帧跟随（掉货后也要更新）
    for (const [id, list] of this.cargoOnBoat) {
      const boat = this.boats.get(id);
      if (!boat) continue;
      list.forEach((c, i) => {
        c.mesh.position.set(boat.pos.x - Math.sin(boat.heading) * (2 + i * 0.13),
          boat.pos.y + 0.8 + (i % 2) * 0.35, boat.pos.z - Math.cos(boat.heading) * (2 + i * 0.13));
      });
    }
  }

  #onClimb(boat, nextLayer) {
    const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
    const p = this.players.get(id);
    if (p && id === this.myId) this.onToast(`🌀 浮空上升，前往第 ${nextLayer + 1} 层…`);
  }

  #onLanded(boat, layer) {
    const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
    const p = this.players.get(id);
    if (!p) return;
    p.layer = layer;
    boat.skyLayer = layer;
    boat.diveTargetY = layerY(layer) + 0.4;
    // 落地广播：主机判断「全员到齐」要靠每个人的当前层
    this.#broadcastLand(id, layer);
    if (id === this.myId) {
      this.fx?.play?.('ring', boat.pos.x, boat.pos.y, boat.pos.z, 1.2);
      // 踩到第 3 层立刻把这一层怎么玩说清楚（1 分钟、1/2/3 放道具）
      if (layer === R.ITEMRUSH.LAYER) {
        this.onToast('🎁 第 3 层：道具箱大乱斗 · 撞碎箱子拿道具，按 1/2/3 放；吃箱子算主分');
      } else if (layer === R.BOSSRUSH.LAYER) {
        this.onToast('⚡ 第 4 层：雷霆龙骑士 · 按 1 发雷炮，K 冲刺撞 BOSS 伤害翻倍');
      } else if (layer === R.THUNDER.LAYER) {
        this.onToast('⚡ 第 5 层：落雷竞技 · 被劈次数最少者胜 · 撞对手把他推进红圈');
      } else if (layer === R.DEFENSE.LAYER) {
        this.onToast('🗡 第 6 层：塔防 · J 键开炮清怪，打掉最多的队伍获胜');
      } else if (layer === R.SHRINK.LAYER) {
        this.onToast('🌀 第 7 层：缩圈 · 漂移/直线都算里程，跑得多的队伍获胜');
      } else if (layer === R.CRYSTAL.LAYER) {
        this.onToast('💎 第 8 层：水晶攻防 · 撞碎对方水晶 · 1 键丢泡泡炸弹');
      } else if (layer === R.PAINT.LAYER) {
        this.onToast('🎨 第 9 层：涂地竞速 · 船尾自动留色 · 撞人断笔 · 1 键清色');
      } else if (layer === R.CROWN.LAYER) {
        this.onToast('👑 第 10 层：加冕仪式 · 抢皇冠回自家加冕区站 3 秒');
      }
    }
  }

  #onFall(boat, layer) {
    const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    const L = layer | 0;
    // 第 7 层缩圈有自己的"掉圈扣里程 + 抓回安全圈"口径，保持原样
    if (L === R.SHRINK.LAYER) {
      this.shrink?.noteFall(id, boat);
      return;
    }
    // 皇冠层：持冠者出界先把皇冠留在原地
    if (L === R.CROWN.LAYER) this.crown?.noteFall(id);
    // 其余所有楼层统一：不掉层、不落水、不淘汰，只把船重置回本层内侧
    this.#resetOnLayer(id, p, boat, L);
  }

  // ---------------------------------------------------------------- 第 1 层：水球赛

  /** 所有楼层出界：把船推回本层内侧（保留出界方向），不掉层、不扣货、短暂无敌 */
  #resetOnLayer(id, p, boat, layer) {
    const rad = layerRadius(layer) * 0.85;
    const d = Math.hypot(boat.pos.x, boat.pos.z) || 1;
    boat.pos.set((boat.pos.x / d) * rad, layerY(layer) + 0.4, (boat.pos.z / d) * rad);
    boat.vel.set(0, 0, 0);
    boat.vy = 0;
    boat.speed = 0;
    boat.liftRide = null;
    boat.skyLayer = layer;
    boat.diveTargetY = layerY(layer) + 0.4;
    p.layer = layer;
    p.invuln = 1.5;
    p.overheat = 0;
    p.dashTimes.length = 0;
    this.fx?.play?.('ring', boat.pos.x, boat.pos.y, boat.pos.z, 1.1);
    if (id === this.myId) {
      this.onRespawn?.();
      this.onToast('↩ 出界 · 已重置回本层');
    }
  }

  /** 阵营：有队伍按 blue/red，没有队伍按序号奇偶（和水球赛同口径） */
  #sideOf(id) {
    const p = this.players.get(id);
    if (p?.team === 'blue') return 0;
    if (p?.team === 'red') return 1;
    const i = this.ids.indexOf(id);
    return i > 0 && i % 2 === 1 ? 1 : 0;
  }

  /** 出生点：第 1 层走水球赛的开球站位，其余层按竞技场环形排布 */
  #spawnTransform(id, i) {
    const n = Math.max(1, this.ids.length);
    if (this.football) {
      // 组队局：同队两人分前后两个站位（lane），个人局保持原来的 index/2 算法
      const team = this.players.get(id)?.team;
      const lane = team
        ? Math.max(0, this.ids.filter((x) => this.players.get(x)?.team === team).indexOf(id))
        : null;
      return this.football.spawnTransform(id, i, n, lane);
    }
    return this.arena.spawnTransform(i, n);
  }

  /** 某一层上「活着」的船（各层小游戏只跟自己那一层的船打交道） */
  #layerEntries(layer) {
    const out = [];
    for (const [id, p] of this.players) {
      if (p.layer !== layer || !p.alive) continue;
      const boat = this.boats.get(id);
      if (!boat) continue;
      out.push({ id, boat, index: this.ids.indexOf(id) });
    }
    return out;
  }

  #footEntries() { return this.#layerEntries(0); }

  #updateFootball(dt, live = false) {
    if (!this.football) return;
    this.football.update(dt, live ? this.#footEntries() : []);
    // 房主 15Hz 广播球位姿：客机只插值，物理权威永远在房主（球不像船那样每帧上报）
    if (!live || !this.net || this.solo || !this.isHost) return;
    this.footNet -= dt;
    if (this.footNet > 0) return;
    this.footNet = 1 / 15;
    this.#netEvent({ t: 'footBall', ...this.football.snapshot() });
  }

  /**
   * 进球：球进 +X 门 = 进攻方向 +X 的那一队得分。
   * 组队 2v2：+1 算到最后触球的进攻方球员身上（折射/乌龙时给离球最近的进攻方），
   * 队伍总分由 UI 汇总队内两人得分；个人局保持原来的按边全给。
   */
  #onFootballGoal(side, lastTouch = null) {
    if (!this.teamMode) {
      let scorer = null;
      for (const [id] of this.players) {
        const idx = this.ids.indexOf(id);
        if (idx < 0) continue;
        if (this.football.attackDir(id, idx) !== side) continue;
        const p = this.players.get(id);
        p.score += 1;
        this.#trackLayerPts(id, this.football.layer, 1);
        this.football.addGoal(id);
        scorer = p;
      }
      if (scorer) {
        if (scorer.id === this.myId) this.onToast('⚽ 进球！+1 分');
        else this.onToast(`⚽ ${scorer.name} 进球（${scorer.score} 分）`);
        this.#netEvent({ t: 'footGoal', id: scorer.id, side, s: scorer.score });
      }
      this.#syncHud();
      return;
    }

    const team = side > 0 ? 'blue' : 'red';
    const mates = this.ids
      .map((id) => this.players.get(id))
      .filter((p) => p && p.team === team);
    if (!mates.length) return;
    let scorer = mates.find((p) => p.id === lastTouch) || null;
    if (!scorer) {
      const ball = this.football.ball;
      let best = Infinity;
      for (const p of mates) {
        const boat = this.boats.get(p.id);
        const d = boat ? Math.hypot(boat.pos.x - ball.x, boat.pos.z - ball.z) : Infinity;
        if (d < best) { best = d; scorer = p; }
      }
      scorer = scorer || mates[0];
    }
    scorer.score += 1;
    this.#trackLayerPts(scorer.id, this.football.layer, 1);
    this.football.addGoal(scorer.id);
    const teamName = this.teamNames[team] || (team === 'blue' ? '蓝队' : '红队');
    if (scorer.id === this.myId) this.onToast(`⚽ 进球！+1 分（${teamName}）`);
    else this.onToast(`⚽ ${scorer.name} 为${teamName}进球（${scorer.score} 分）`);
    this.#netEvent({ t: 'footGoal', id: scorer.id, side, s: scorer.score, team });
    this.#syncHud();
  }

  /** 球撞上自己的船：给一点点顿挫，让"顶到球"有手感 */
  #onFootballEvent(e) {
    if (e.type === 'boat' && e.id === this.myId && e.speed > 11) {
      this.hitStop = Math.max(this.hitStop || 0, 0.045);
    }
  }

  // ---------------------------------------------------------------- 第 2 层：泡泡送包子

  #updateDeliver(dt, live = false) {
    if (!this.deliver) return;
    this.deliver.update(dt, live ? this.#layerEntries(R.DELIVER.LAYER) : []);
  }

  #onDeliverScore(id, pts) {
    const p = this.players.get(id);
    if (!p) return;
    p.score += pts;
    this.#trackLayerPts(id, R.DELIVER.LAYER, pts);
    if (id === this.myId) this.onToast(`🥟 送达！+${pts} 分`);
    else this.onToast(`🥟 ${p.name} 送达（${p.score} 分）`);
    this.#syncHud();
  }

  #onDeliverEvent(e) {
    if (!e) return;
    const name = this.players.get(e.id)?.name || '对手';
    if (e.type === 'grab') {
      if (e.id === this.myId) this.onToast('🥟 抢到包子！冲向你那端的终点门（背着会变慢）');
      else this.onToast(`🥟 ${name} 抢到包子了，按 K 放泡泡炸他`);
    } else if (e.type === 'hit' && e.id === this.myId) {
      this.onToast('💥 被泡泡炸中，包子掉在原地了！');
    } else if (e.type === 'drop' && e.id === this.myId) {
      this.onToast('🥟 包子掉了，回去抢');
    }
  }

  // ---------------------------------------------------------------- 第 3 层：道具箱大乱斗

  #updateItemRush(dt, live = false) {
    if (!this.itemRush) return;
    // 1/2/3 放道具：只有站在第 3 层才有意义。别的层留给第 4 层的雷炮去消费，
    // 不能在这里一把清掉（否则第 4 层按 1 发不出炮弹）
    const me = this.players.get(this.myId);
    if (live && this.itemQueued >= 0 && (me?.layer ?? -1) === R.ITEMRUSH.LAYER) {
      this.itemRush.useSlot(this.itemQueued);
      this.itemQueued = -1;
    }
    this.itemRush.update(dt, live ? this.#layerEntries(R.ITEMRUSH.LAYER) : []);
  }

  // ---------------------------------------------------------------- 第 4 层：双船打 BOSS

  #updateBossRush(dt, live = false) {
    if (!this.bossRush) return;
    const me = this.players.get(this.myId);
    const layer = me?.layer ?? -1;
    if (this.itemQueued >= 0) {
      // 第 4 层只认 1 键（雷炮）；K 仍然是冲刺，冲刺撞 BOSS 伤害翻倍
      if (live && layer === R.BOSSRUSH.LAYER && this.itemQueued === 0) this.bossRush.fireCannon();
      // 第 8/9/10 层：1 键放泡泡（撞水晶 / 清色 / 炸皇冠）
      else if (live && this.itemQueued === 0) {
        if (layer === R.CRYSTAL.LAYER) this.crystal?.fireBubble();
        else if (layer === R.PAINT.LAYER) this.paint?.fireBubble();
        else if (layer === R.CROWN.LAYER) this.crown?.fireBubble();
      }
      if (layer !== R.ITEMRUSH.LAYER) this.itemQueued = -1;
    }
    this.bossRush.update(dt, live ? this.#layerEntries(R.BOSSRUSH.LAYER) : []);
  }

  #onBossRushScore(id, dmg, kind) {
    const p = this.players.get(id);
    if (!p) return;
    p.score += dmg;
    this.#trackLayerPts(id, R.BOSSRUSH.LAYER, dmg);
    // 伤害数字本身已经飘在 BOSS 头上了，这里不再弹 toast 刷屏
    this.#syncHud();
  }

  #onBossRushEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.BOSSRUSH.LAYER) {
      this.onToast('⚡ 雷霆龙骑士：按 1 发雷炮 · K 冲刺撞 BOSS 翻倍 · 红圈亮起就闪开');
    } else if (e.type === 'finish') {
      const mine = this.bossRush.damageBy.get(this.myId) || 0;
      this.onToast(`⏱ 本层结束：你打出 ${Math.round(mine)} 点伤害`);
    }
  }

  // ---------------------------------------------------------------- 第 5 层：随机落雷

  #updateThunder(dt, live = false) {
    if (!this.thunder) return;
    this.thunder.update(dt, live ? this.#layerEntries(R.THUNDER.LAYER) : []);
  }

  /** 本层加分（每躲一波 +1、层结束按被劈次数排名 6/3/1）；返回总分给房主广播 */
  #onThunderScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return null;
    p.score += pts;
    this.#trackLayerPts(id, R.THUNDER.LAYER, pts);
    if (kind === 'rank' && id === this.myId) {
      const order = this.thunder?.order || [];
      const rank = order.findIndex((r) => r.id === this.myId);
      if (rank >= 0) {
        this.onToast(`⚡ 落雷层结算：第 ${rank + 1} 名 · 被劈 ${order[rank].n} 次 · +${pts} 分`);
      }
    }
    this.#syncHud();
    return p.score;
  }

  #onThunderEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.THUNDER.LAYER) {
      this.onToast('⚡ 第 5 层：落雷竞技 · 红圈亮起就闪开，把对手撞进红圈');
    } else if (e.type === 'hit' && e.id === this.myId) {
      // 被劈：给一下顿挫 + 震屏（伤害数字那套不适用，这层不掉血）
      this.hitStop = Math.max(this.hitStop || 0, 0.06);
      this.onToast(`⚡ 被雷劈了（第 ${e.n} 次）· 快离开原位`);
    } else if (e.type === 'finish') {
      const rank = (e.order || []).findIndex((r) => r.id === this.myId);
      const mine = this.thunder?.struckOf(this.myId) || 0;
      const best = e.order?.find((r) => !r.dnf);
      if (this.thunder?.isDnf(this.myId)) {
        this.onToast('⚡ 你掉出了第 5 层 · 本层排名垫底，没有排名分');
      } else if (rank === 0) {
        this.onToast(`🏆 落雷层胜利：你只被劈 ${mine} 次`);
      } else if (best) {
        const name = this.players.get(best.id)?.name || '对手';
        this.onToast(`⚡ 落雷层结束：你被劈 ${mine} 次 · ${name} 最少（${best.n} 次）`);
      }
    }
  }

  // ---------------------------------------------------------------- 第 6 层：塔防

  #updateDefense(dt, live = false) {
    if (!this.defense) return;
    this.defense.update(dt, live ? this.#layerEntries(R.DEFENSE.LAYER) : []);
  }

  /** 击杀分直接进总分；层结束按队伍名次给排名分（队伍里每人都拿） */
  #onDefenseScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return null;
    p.score += pts;
    this.#trackLayerPts(id, R.DEFENSE.LAYER, pts);
    if (kind === 'rank' && id === this.myId) {
      const teams = this.defense?.teamTotals || [];
      const idx = teams.findIndex((t) => t.ids.includes(this.myId));
      const mine = this.defense?.killsOf(this.myId) || 0;
      this.onToast(idx >= 0
        ? `🗡 塔防层结算：${teams.length > 1 ? `队伍第 ${idx + 1} 名` : '本层'} · 击杀 ${mine} 分 · +${pts}`
        : `🗡 塔防层结束：击杀 ${mine} 分`);
    }
    this.#syncHud();
    return p.score;
  }

  #onDefenseEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.DEFENSE.LAYER) {
      this.onToast('🗡 第 6 层：塔防 · J 键开炮清怪，打掉最多的队伍获胜');
    } else if (e.type === 'hurt' && e.id === this.myId) {
      // 被小怪挠到：给一下顿挫就够，天梯不扣血
      this.hitStop = Math.max(this.hitStop || 0, 0.04);
    } else if (e.type === 'finish') {
      const mine = this.defense?.killsOf(this.myId) || 0;
      const teams = e.teams || [];
      if (teams.length > 1) {
        const idx = teams.findIndex((t) => t.ids.includes(this.myId));
        if (idx === 0) this.onToast(`🏆 塔防层：你的队伍第一（${teams[0].pts} 分）· 你打掉 ${mine} 分`);
        else if (idx > 0) this.onToast(`🗡 塔防层结束：你打掉 ${mine} 分 · 第一名队伍 ${teams[0].pts} 分`);
      } else if (mine > 0) {
        this.onToast(`🗡 塔防层结束：你打掉 ${mine} 分`);
      }
    }
  }

  // ---------------------------------------------------------------- 第 7 层：缩圈 · 里程

  #updateShrink(dt, live = false) {
    if (!this.shrink) return;
    this.shrink.update(dt, live ? this.#layerEntries(R.SHRINK.LAYER) : []);
  }

  /** 本层只有名次分（按队伍总里程排名 6/3/1），里程本身不给分 */
  #onShrinkScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return null;
    p.score += pts;
    this.#trackLayerPts(id, R.SHRINK.LAYER, pts);
    if (kind === 'rank' && id === this.myId) {
      const teams = this.shrink?.teams || [];
      const idx = teams.findIndex((t) => t.ids.includes(this.myId));
      const mine = this.shrink?.metersOf(this.myId) || 0;
      this.onToast(idx === 0
        ? `🏆 缩圈层：你（队伍）里程第一 · ${mine}m`
        : `🌀 缩圈层结束：你跑了 ${mine}m${idx > 0 && teams[0] ? ` · 第一名 ${teams[0].n}m` : ''}`);
    }
    this.#syncHud();
    return p.score;
  }

  #onShrinkEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.SHRINK.LAYER) {
      this.onToast('🌀 第 7 层：缩圈 · 漂移/直线都算里程，跑得多的队伍获胜');
    } else if (e.type === 'fall' && e.id === this.myId) {
      // 掉下去：一顿顿挫 + 复活无敌，位置与扣分在 shrink 里已经处理
      this.hitStop = Math.max(this.hitStop || 0, 0.07);
      const p = this.players.get(this.myId);
      if (p) p.invuln = Math.max(p.invuln || 0, R.SHRINK.RESPAWN_INVULN);
      this.onToast(`🌀 被挤出安全圈！扣 ${R.SHRINK.FALL_PENALTY}m · 抓回圈内继续跑`);
    } else if (e.type === 'finish') {
      const mine = this.shrink?.metersOf(this.myId) || 0;
      const teams = e.teams || [];
      const idx = teams.findIndex((t) => t.ids.includes(this.myId));
      if (teams.length > 1 && idx > 0) {
        this.onToast(`🌀 缩圈层结束：你跑了 ${mine}m · 第一名队伍 ${teams[0].n}m`);
      }
    }
  }

  // ---------------------------------------------------------------- 第 8 层：水晶攻防

  #updateCrystal(dt, live = false) {
    if (!this.crystal) return;
    this.crystal.update(dt, live ? this.#layerEntries(R.CRYSTAL.LAYER) : []);
  }

  #onCrystalScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return null;
    p.score += pts;
    this.#trackLayerPts(id, R.CRYSTAL.LAYER, pts);
    if (kind === 'rank' && id === this.myId) {
      const st = this.crystal?.hudState();
      if (st) this.onToast(`💎 水晶层结算：我方剩 ${st.mine}/3 段 · 对方剩 ${st.foe}/3 段 · +${pts} 分`);
    }
    this.#syncHud();
    return p.score;
  }

  #onCrystalEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.CRYSTAL.LAYER) {
      this.onToast('💎 第 8 层：水晶攻防 · 撞碎对方水晶 · 1 键丢泡泡炸弹');
    } else if (e.type === 'hit' && e.by === this.myId) {
      this.onToast(`💎 对方水晶受损 · 还剩 ${this.crystal?.segsOf(e.side)}/3 段`);
    } else if (e.type === 'destroy') {
      const mine = this.#sideOf(this.myId);
      if (mine === e.winnerSide) this.onToast('🏆 对方水晶碎了！本层直接获胜');
      else this.onToast('💥 我方水晶被击碎 · 本层落败');
    }
  }

  // ---------------------------------------------------------------- 第 9 层：涂地竞速

  #updatePaint(dt, live = false) {
    if (!this.paint) return;
    this.paint.update(dt, live ? this.#layerEntries(R.PAINT.LAYER) : []);
  }

  #onPaintScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return null;
    p.score += pts;
    this.#trackLayerPts(id, R.PAINT.LAYER, pts);
    if (kind === 'rank' && id === this.myId) {
      const st = this.paint?.hudState();
      if (st) this.onToast(`🎨 涂地层结算：我方 ${st.mine}% · 对方 ${st.foe}% · +${pts} 分`);
    }
    this.#syncHud();
    return p.score;
  }

  #onPaintEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.PAINT.LAYER) {
      this.onToast('🎨 第 9 层：涂地竞速 · 船尾自动留色 · 撞人让对手断笔 · 1 键清色');
    } else if (e.type === 'break' && e.id === this.myId) {
      this.hitStop = Math.max(this.hitStop || 0, 0.05);
      this.onToast('🎨 被撞断笔！1.5 秒内涂不了色');
    } else if (e.type === 'finish') {
      const st = this.paint?.hudState();
      if (st && st.mine >= st.foe) this.onToast(`🏆 涂地层：我方 ${st.mine}% 领先`);
    }
  }

  // ---------------------------------------------------------------- 第 10 层：加冕仪式

  #updateCrown(dt, live = false) {
    if (!this.crown) return;
    this.crown.update(dt, live ? this.#layerEntries(R.CROWN.LAYER) : []);
  }

  #onCrownScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return null;
    p.score += pts;
    this.#trackLayerPts(id, R.CROWN.LAYER, pts);
    this.#syncHud();
    return p.score;
  }

  #onCrownEvent(e) {
    if (!e) return;
    const me = this.players.get(this.myId);
    if (e.type === 'start' && me?.layer === R.CROWN.LAYER) {
      this.onToast('👑 第 10 层：加冕仪式 · 抢皇冠回自家加冕区站 3 秒');
    } else if (e.type === 'grab' && e.id === this.myId) {
      this.onToast('👑 抢到皇冠！冲回自家加冕区（持冠变慢、不能冲刺）');
    } else if (e.type === 'drop' && e.id === this.myId) {
      this.onToast('💥 皇冠被打掉了 · 2 秒后才能再抢');
    } else if (e.type === 'crown' && e.id === this.myId) {
      this.onToast(`👑 加冕成功！+${R.CROWN.SCORE_CROWN} 分（第 ${e.n} 次）`);
    } else if (e.type === 'finish') {
      const st = this.crown?.hudState();
      if (st) {
        this.onToast(st.mine >= st.foe
          ? `🏆 加冕仪式：我方加冕 ${st.mine} 次获胜`
          : `👑 加冕仪式结束：我方 ${st.mine} 次 · 对方 ${st.foe} 次`);
      }
    }
  }

  #onItemRushScore(id, pts, kind) {
    const p = this.players.get(id);
    if (!p) return;
    p.score += pts;
    this.#trackLayerPts(id, R.ITEMRUSH.LAYER, pts);
    // 只有本地玩家和"值得播报"的事件才弹 toast，否则一局下来满屏都是 +1
    if (kind === 'box' && id === this.myId) {
      const n = this.itemRush.bx.get(id) || 0;
      if (n === 10 || n === 20 || n === 30) this.onToast(`📦 已吃 ${n} 个道具箱`);
    } else if (kind === 'hit' && id === this.myId) {
      const boat = this.boats.get(id);
      if (boat) this.fx?.play?.('hit', boat.pos.x, boat.pos.y, boat.pos.z, 1.1);
    }
    this.#syncHud();
  }

  #onItemRushEvent(e) {
    if (!e) return;
    if (e.type === 'start' && this.players.get(this.myId)?.layer === R.ITEMRUSH.LAYER) {
      this.onToast('📦 道具箱大乱斗：吃箱子 +1 · 打中对手 +1 · 限时 60 秒');
    } else if (e.type === 'finish') {
      const mine = this.itemRush.bx.get(this.myId) || 0;
      this.onToast(`⏱ 本层结束：你吃到 ${mine} 个道具箱`);
    }
  }

  /** 记录每个玩家在各层拿到的分数（同层内可比），用于同分时的「单层第一」次数 */
  #trackLayerPts(id, layer, pts) {
    const p = this.players.get(id);
    if (!p || !Number.isFinite(pts) || pts <= 0) return;
    p.layerPts.set(layer, (p.layerPts.get(layer) || 0) + pts);
  }

  /** 每层得分第一的次数：同分时先比它，再比最高层，基本不会走到加赛 */
  #layerWinCounts() {
    const best = new Map();
    for (const p of this.players.values()) {
      for (const [layer, v] of p.layerPts) {
        if (v > (best.get(layer) || 0)) best.set(layer, v);
      }
    }
    const out = new Map();
    for (const p of this.players.values()) {
      let n = 0;
      for (const [layer, v] of p.layerPts) {
        if (v > 0 && v === best.get(layer)) n++;
      }
      out.set(p.id, n);
    }
    return out;
  }

  #finish() {
    this.#hideLayerCard();
    this.#hideLayerBanner();
    // 计分：累计总分优先；同分依次比「单层得分第一的次数」和「最高到达层」，
    // 仍然完全相同才算并列（此时按名单顺序取第一个，避免出现两个冠军结算）。
    const layerWins = this.#layerWinCounts();
    const sorted = [...this.players.values()].sort((a, b) =>
      (b.score - a.score)
      || ((layerWins.get(b.id) || 0) - (layerWins.get(a.id) || 0))
      || ((b.layer || 0) - (a.layer || 0)));
    this.winner = sorted[0]?.id ?? null;
    const me = this.players.get(this.myId);
    // 结算消息带上到达层：服务器按「最高层优先」记天梯榜 + 发积分
    const scores = sorted.map((p) => ({
      id: p.id, name: p.name, score: p.score, ai: p.ai,
      layer: (p.layer || 0) + 1, team: p.team || '',
    }));
    const layer = scores.reduce((m, s) => Math.max(m, s.layer || 1), 1);

    // 组队 2v2：按队伍总分排名（队友个人分相加），个人分只作队内贡献展示。
    let teams = null;
    let winnerTeam = null;
    let won = this.winner === this.myId;
    if (this.teamMode) {
      const rows = ['blue', 'red'].map((team) => {
        const list = sorted.filter((p) => p.team === team);
        return {
          team,
          name: this.teamNames[team] || (team === 'blue' ? '蓝队' : '红队'),
          score: list.reduce((s, p) => s + p.score, 0),
          wins: list.reduce((s, p) => s + (layerWins.get(p.id) || 0), 0),
          topLayer: list.reduce((m, p) => Math.max(m, p.layer || 0), 0),
          ids: list.map((p) => p.id),
        };
      }).filter((t) => t.ids.length);
      rows.sort((a, b) => (b.score - a.score) || (b.wins - a.wins) || (b.topLayer - a.topLayer));
      teams = rows;
      winnerTeam = rows[0]?.team || null;
      won = !!me?.team && me.team === winnerTeam;
      this.winner = rows[0]?.ids?.[0] || this.winner;
    }

    const data = {
      won,
      score: me?.score ?? 0,
      scores,
      layer,
      mode: 'skytower',
      teamMode: this.teamMode,
      teams,
      winnerTeam,
      teamNames: this.teamNames,
      myTeam: me?.team || '',
    };
    this.onEnd(data);
    this.#netEvent({ t: 'towerEnd', winner: this.winner, winnerTeam });
    // towerEnd 只是透明转发给客机；towerResult 由服务器专门处理（房主一份，每局一次）
    if (!this.solo && this.isHost && this.net) {
      this.net.send({
        t: 'towerResult', winner: this.winner, winnerTeam,
        scores, teams, elapsed: Math.max(1, this.fightTime || 0),
      });
    }
  }

  // ---------------------------------------------------------------- 相机

  updateCamera(camera, dt) {
    if (this.phase === 'intro' && this.cinemaCurve) {
      // 标题卡期间极缓推进，起止归零，切到飞行段不跳
      const q = 1 - Math.max(0, this.intro) / R.INTRO_TIME;
      const b = Math.sin(q * Math.PI);
      this.cinemaCurve.getPointAt(0, this.camPos);
      camera.position.set(this.camPos.x * (1 - 0.12 * b), this.camPos.y - 4 * b, this.camPos.z * (1 - 0.12 * b));
      camera.lookAt(0, 62 + 42 * b, 0);
      return true;
    }
    if (this.phase === 'cinema' && this.cinemaCurve) {
      const p = 1 - Math.max(0, this.cinema) / R.CINEMA_TIME;
      const u = p * p * (3 - 2 * p);
      this.cinemaCurve.getPointAt(Math.min(0.999, u), this.camPos);
      camera.position.copy(this.camPos);
      // 注视点：前段看塔顶，后段转向自己的船
      const me = this.localBoat;
      const k = Math.max(0, Math.min(1, (p - 0.68) / 0.32));
      this.camLook.set(
        (me ? me.pos.x : 0) * k,
        (70 + p * 70) * (1 - k) + (me ? me.pos.y + 1.2 : 1.2) * k,
        (me ? me.pos.z : 0) * k,
      );
      camera.lookAt(this.camLook);
      return true;
    }
    // 逐层规则过场：镜头缓慢环绕本层平台（让玩家先看清楚这一层长什么样）
    if (this.phase === 'fight' && this.layerPhase === 'cutscene') {
      const layer = this.layerIndex;
      const y = layerY(layer);
      const rad = layerRadius(layer) + 14;
      const t = 1 - Math.max(0, this.cutsceneLeft) / Math.max(0.01, R.LAYER_CUTSCENE);
      const a = 0.6 + t * Math.PI * 0.9;
      const camY = y + 13 + Math.sin(t * Math.PI) * 3;
      camera.position.set(Math.cos(a) * rad, camY, Math.sin(a) * rad);
      this.camLook.set(0, y + 1.5, 0);
      camera.lookAt(this.camLook);
      return true;
    }
    return false;
  }

  applyCameraShake() { /* 撞击顿挫由 Game.hitStop 统一处理 */ }

  /** 竞技场看台比分牌：天梯用「累计分 + 当前层 + 背包载重」代替 1v1 血量 */
  getScoreboard() {
    const me = this.players.get(this.myId);
    if (!me) return null;
    const foe = [...this.players.values()]
      .filter((p) => p.id !== this.myId)
      .sort((a, b) => b.score - a.score)[0];
    return {
      myName: me.name, foeName: foe?.name || '对手',
      myScore: me.score, foeScore: foe?.score ?? 0,
      myHp: me.cargo.length / R.CARGO_MAX,
      foeHp: (foe?.cargo.length ?? 0) / R.CARGO_MAX,
      round: (me.layer ?? 0) + 1,
      phase: this.phase === 'fight' ? 'fight' : 'countdown',
    };
  }

  // ---------------------------------------------------------------- HUD

  #syncHud() {
    const me = this.players.get(this.myId);
    const cargoValue = (me?.cargo || []).reduce((s, c) => s + c.type.value, 0);
    this.hud = {
      mode: 'skytower',
      // 逐层赛制：顶栏与进度条读「本层 60 秒」，不再读整场 15 分钟
      towerTimeLeft: Math.max(0, this.layerTimeLeft),
      towerTotalTime: R.LAYER_ROUND,
      towerUpliftOpen: this.layerPhase === 'travel',
      towerLayers: layerCount(),
      // 当前进行到第几层（全员共用的赛程层号，不是某个人的物理层）
      towerLayerNo: this.layerIndex + 1,
      towerLayerPhase: this.layerPhase,
      towerLayerName: R.LAYER_INFO[this.layerIndex]?.name || `第 ${this.layerIndex + 1} 层`,
      towerLayerRule: R.LAYER_INFO[this.layerIndex]?.rule || '',
      towerWaitLeft: Math.max(0, this.layerWaitLeft),
      towerCutsceneLeft: Math.max(0, this.cutsceneLeft),
      // 组队赛制（暂未开放）时 HUD 右上角的队伍对抗条读这两个字段
      towerTeamNames: this.teamNames,
      towerScore: me?.score ?? 0,
      towerCargo: me?.cargo.length ?? 0,
      towerCargoValue: cargoValue,
      towerLayer: this.layerIndex + 1,
      towerEnergy: (me?.energy ?? 0) / R.DASH_ENERGY_MAX,
      towerOverheat: (me?.overheat ?? 0) > 0,
      towerCount: (this.phase === 'countdown') ? Math.max(0, this.countdown) : 0,
      towerPlayers: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, ai: p.ai, me: p.id === this.myId,
        team: p.team || '',
        score: p.score, layer: p.layer + 1, cargo: p.cargo.length,
        goals: this.football?.goals.get(p.id) || 0,
        deliver: this.deliver?.scores.get(p.id) || 0,
        // 第 3 层：主分是箱子、B 分是命中（客机这两个 Map 由 itemPick/itemHit 增量维护）
        boxes: this.itemRush?.bx.get(p.id) || 0,
        hits: this.itemRush?.hit.get(p.id) || 0,
        dmg: Math.round(this.bossRush?.damageBy.get(p.id) || 0),
        // 第 5 层：被劈中次数（越少越好，榜单直接读它）；dnf = 掉出平台
        struck: this.thunder?.struckOf(p.id) || 0,
        dnf: this.thunder?.isDnf(p.id) || false,
        // 第 6 层：击杀积分
        kills: this.defense?.killsOf(p.id) || 0,
        // 第 7 层：累计里程（米）与掉圈次数
        meters: this.shrink?.metersOf(p.id) || 0,
        falls: this.shrink?.fallsOf(p.id) || 0,
        // 第 10 层：个人加冕次数
        crowns: this.crown?.playerCounts.get(p.id) || 0,
      })).sort((a, b) => b.score - a.score),
      // 第 1 层水球赛：球在场上的位置（HUD 之后要做小地图/球指示器时直接用）
      towerFootBall: this.football
        ? { x: +this.football.ball.x.toFixed(1), z: +this.football.ball.z.toFixed(1) }
        : null,
      // 站在第 1 层时 HUD 换成"进球"口径（上面的层暂时还是运货）
      towerFoot: (me?.layer ?? 0) === 0 && !!this.football,
      towerFootGoals: this.football?.goals.get(this.myId) || 0,
      // 第 2 层：谁背着包子 + 我自己是不是持货者
      towerDeliver: (me?.layer ?? 0) === R.DELIVER.LAYER && !!this.deliver,
      towerCarrier: this.deliver?.carrierId || null,
      towerCarrierName: this.deliver?.carrierId
        ? (this.players.get(this.deliver.carrierId)?.name || '对手') : '',
      towerICarry: this.deliver?.carrierId === this.myId,
      towerDeliverScore: this.deliver?.scores.get(this.myId) || 0,
      // 第 3 层道具箱大乱斗：道具栏沿用道具赛那三条槽（键位 1/2/3），
      // 本层战绩单独给「箱子 / 命中」两项，主分是箱子
      // 第 4 层：双船打 BOSS（HUD 换成伤害口径，顶部第三格 = 本层伤害）
      towerBoss: (me?.layer ?? 0) === R.BOSSRUSH.LAYER && !!this.bossRush,
      towerBossHp: this.bossRush?.boss
        ? Math.max(0, this.bossRush.boss.hp / this.bossRush.boss.maxHp) : 0,
      towerBossDmg: Math.round(this.bossRush?.damageBy.get(this.myId) || 0),
      towerBossLeft: Math.ceil(Math.max(0, this.bossRush?.timeLeft ?? 0)),
      towerBossEnraged: !!this.bossRush?.enraged,
      towerRush: (me?.layer ?? 0) === R.ITEMRUSH.LAYER && !!this.itemRush,
      towerRushLeft: Math.ceil(Math.max(0, this.itemRush?.timeLeft ?? 0)),
      towerRushBoxes: this.itemRush?.bx.get(this.myId) || 0,
      towerRushHits: this.itemRush?.hit.get(this.myId) || 0,
      // 第 5 层落雷竞技：本层口径 = 被劈次数（越少越好）+ 下一波倒计时
      towerThunder: (me?.layer ?? 0) === R.THUNDER.LAYER && !!this.thunder,
      towerThunderLeft: Math.ceil(Math.max(0, this.thunder?.timeLeft ?? 0)),
      towerThunderNext: Math.max(0, this.thunder?.nextIn ?? 0),
      towerThunderMine: this.thunder?.struckOf(this.myId) || 0,
      towerThunderWave: this.thunder?.wave || 0,
      towerThunderLeader: this.thunder?.leaderId?.() || null,
      // 第 6 层塔防：击杀积分 + 剩余时间
      towerDefense: (me?.layer ?? 0) === R.DEFENSE.LAYER && !!this.defense,
      towerDefenseLeft: Math.ceil(Math.max(0, this.defense?.timeLeft ?? 0)),
      towerDefenseKills: this.defense?.killsOf(this.myId) || 0,
      towerDefenseWave: this.defense?.wave || 0,
      // 开炮热量（复用赛艇主炮的过热口径）
      towerDefenseHeat: this.defense?.weapons.get(this.myId)?.heatRatio ?? 0,
      // 第 7 层缩圈 · 里程：本层口径 = 累计米数 + 当前安全圈半径
      towerShrink: (me?.layer ?? 0) === R.SHRINK.LAYER && !!this.shrink,
      towerShrinkLeft: Math.ceil(Math.max(0, this.shrink?.timeLeft ?? 0)),
      towerShrinkMeters: this.shrink?.metersOf(this.myId) || 0,
      towerShrinkRing: +(this.shrink?.ringR ?? 0).toFixed(1),
      towerShrinkFalls: this.shrink?.fallsOf(this.myId) || 0,
      towerShrinkLeader: this.shrink?.leaderId?.() || null,
      // 第 8 层水晶攻防：双方剩余段数 / 护罩 / 泡泡弹药
      towerCrystal: (me?.layer ?? 0) === R.CRYSTAL.LAYER && !!this.crystal,
      towerCrystalMine: this.crystal?.segsOf(this.#sideOf(this.myId)) ?? 0,
      towerCrystalFoe: this.crystal?.segsOf(1 - this.#sideOf(this.myId)) ?? 0,
      towerCrystalMineHp: this.crystal?.hpRatio(this.#sideOf(this.myId)) ?? 0,
      towerCrystalFoeHp: this.crystal?.hpRatio(1 - this.#sideOf(this.myId)) ?? 0,
      towerCrystalShield: Math.max(0, this.crystal?.shieldLeft ?? 0),
      towerCrystalCharges: this.crystal?.charges.get(this.myId) || 0,
      towerCrystalLeft: Math.ceil(Math.max(0, this.crystal?.timeLeft ?? 0)),
      // 第 9 层涂地竞速：双方覆盖率（%）
      towerPaint: (me?.layer ?? 0) === R.PAINT.LAYER && !!this.paint,
      towerPaintMine: this.paint ? Math.round(this.paint.ratioOf(this.#sideOf(this.myId)) * 100) : 0,
      towerPaintFoe: this.paint ? Math.round(this.paint.ratioOf(1 - this.#sideOf(this.myId)) * 100) : 0,
      towerPaintLeft: Math.ceil(Math.max(0, this.paint?.timeLeft ?? 0)),
      towerPaintBreak: Math.max(0, this.paint?.inkBreak.get(this.myId) || 0),
      towerPaintRush: !!this.paint && this.paint.timeLeft <= R.PAINT.FINAL_RUSH,
      // 第 10 层加冕仪式：双方次数 / 持冠者 / 加冕读条
      towerCrown: (me?.layer ?? 0) === R.CROWN.LAYER && !!this.crown,
      towerCrownMine: this.crown?.counts[this.#sideOf(this.myId)] || 0,
      towerCrownFoe: this.crown?.counts[1 - this.#sideOf(this.myId)] || 0,
      towerCrownHolder: this.crown?.holder || null,
      towerCrownHolderName: this.crown?.holder
        ? (this.players.get(this.crown.holder)?.name || '对手') : '',
      towerCrownCarry: !!this.crown && this.crown.isHolder(this.myId),
      towerCrownCharge: this.crown?.chargeRatio() ?? 0,
      towerCrownLeft: Math.ceil(Math.max(0, this.crown?.timeLeft ?? 0)),
      towerCrownLock: Math.max(0, (this.crown?.crownLock.get(this.myId) || 0) - (this.crown?.elapsed ?? 0)),
      // UI 只在天梯第 3 层才显示这三格（见 ui.js 的 d.towerRush 判断）
      items: this.itemRush
        ? this.itemRush.items.myItems.map((it) => (it ? ITEM_DEFS[it] : null))
        : null,
      shield: (this.boats.get(this.myId)?.shieldTimer ?? 0) > 0
        ? this.boats.get(this.myId).shieldTimer : 0,
      ink: this.itemRush?.items ? Math.max(0, this.itemRush.items.inkTimer) : 0,
    };
  }

  hudData() {
    this.#syncHud();
    return this.hud;
  }

  // ---------------------------------------------------------------- 网络（联机同步）

  #netEvent(detail) {
    if (!this.net || this.solo) return;
    this.net.send(detail);
  }

  handleNet(e) {
    if (!e) return;
    if (e.t === 'towerDash') {
      const p = this.players.get(e.id);
      if (p) { p.energy = e.e; p.overheat = e.oh; }
    } else if (e.t === 'towerScore') {
      const p = this.players.get(e.id);
      if (p) p.score = e.s;
    } else if (e.t === 'towerCrownScore') {
      // 客机：加冕 +8 分跟着房主的总分走（先同步分数，再交给 crown 处理次数/事件）
      const p = this.players.get(e.id);
      if (p && Number.isFinite(e.s)) p.score = e.s;
      this.crown?.applyNet(e);
    } else if (e.t === 'towerOpen') {
      this.#applyRemoteUplift(e.layer);
    } else if (e.t === 'towerLayer') {
      // 客机：房主权威的逐层状态（等待 / 过场 / 比赛 / 上楼 / 结算）
      this.#applyLayerState(e);
    } else if (e.t === 'towerPull') {
      // 超时没上楼：房主点名强拉，每个客户端只挪自己的船
      if (Array.isArray(e.ids) && e.ids.includes(this.myId)) {
        const p = this.players.get(this.myId);
        const boat = this.boats.get(this.myId);
        if (p && boat && (p.layer | 0) !== (e.layer | 0)) {
          this.#teleportToLayer(this.myId, p, boat, e.layer);
        }
      }
    } else if (e.t === 'towerLand') {
      // 别人落地：只同步逻辑层，位置由各端自己的物理/状态同步负责
      const p = this.players.get(e.id);
      const layer = Math.max(0, Math.min(layerCount() - 1, e.layer | 0));
      if (p) p.layer = layer;
      const b = this.boats.get(e.id);
      if (b && e.id !== this.myId) b.skyLayer = layer;
    } else if (e.t === 'towerEnd') {
      this.winner = e.winner;
    } else if (e.t === 'footBall') {
      // 客机：不跑物理，只跟房主快照（球是全场唯一的动态刚体）
      this.football?.applyRemote(e);
    } else if (e.t === 'deliverGrab' || e.t === 'deliverDrop' || e.t === 'bubbleSpawn' || e.t === 'bubblePop') {
      this.deliver?.applyNet(e);
    } else if (e.t === 'deliverScore') {
      this.deliver?.applyNet(e);
      const p = this.players.get(e.id);
      if (p) p.score += R.DELIVER.SCORE;
    } else if (e.t === 'footGoal') {
      const p = this.players.get(e.id);
      if (p) {
        p.score = e.s ?? (p.score + 1);
        this.football?.addGoal(e.id);
        if (e.id !== this.myId) this.onToast(`⚽ ${p.name} 进球（${p.score} 分）`);
      }
    } else if (this.itemRush
      && (e.t === 'itemPick' || e.t === 'itemUse' || e.t === 'itemHeld'
        || e.t === 'itemHit' || e.t === 'itemFx' || e.t === 'itemRushEnd')) {
      // 第 3 层：整套道具消息直接交给本层的 ItemManager（它就是道具赛那一份）
      this.itemRush.applyNet(e);
    } else if (this.bossRush && (e.t === 'towerBossState' || e.t === 'towerBossCast'
      || e.t === 'towerBossHit' || e.t === 'towerBossHurt' || e.t === 'towerBossEnd')) {
      // 第 4 层：BOSS 位姿/读条/输出/受击/结算
      this.bossRush.applyNet(e);
    } else if (this.thunder && (e.t === 'towerBoltWave' || e.t === 'towerBoltHit'
      || e.t === 'towerBoltEnd')) {
      // 第 5 层：落点广播 / 命中计数 / 本层结算
      this.thunder.applyNet(e);
    } else if (this.defense && (e.t === 'towerDefSpawn' || e.t === 'towerDefState'
      || e.t === 'towerDefHit' || e.t === 'towerDefHurt' || e.t === 'towerDefEnd')) {
      // 第 6 层：刷怪 / 小怪快照 / 客机命中上报 / 玩家受击 / 结算
      this.defense.applyNet(e);
    } else if (this.shrink && (e.t === 'towerShrinkState' || e.t === 'towerShrinkFall'
      || e.t === 'towerShrinkEnd')) {
      // 第 7 层：圈半径/里程快照 / 别人掉圈 / 本层结算
      this.shrink.applyNet(e);
    } else if (this.crystal && typeof e.t === 'string' && e.t.startsWith('towerCrystal')) {
      // 第 8 层：水晶血量 / 箱子 / 泡泡 / 破碎 / 结算
      this.crystal.applyNet(e);
    } else if (this.paint && typeof e.t === 'string' && e.t.startsWith('towerPaint')) {
      // 第 9 层：归属快照 / 断笔 / 泡泡清色 / 结算
      this.paint.applyNet(e);
    } else if (this.crown && typeof e.t === 'string' && e.t.startsWith('towerCrown')) {
      // 第 10 层：皇冠状态 / 抢冠 / 掉冠 / 加冕 / 结算
      this.crown.applyNet(e);
    }
  }

  respawnLocal() {}

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this._onKeyDown && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKeyDown);
    }
    if (this._cardTimer) clearTimeout(this._cardTimer);
    this.#hideLayerCard();
    this.#hideLayerBanner();
    this.#endIntro();
    this.football?.dispose();
    this.deliver?.dispose();
    this.itemRush?.dispose();
    this.bossRush?.dispose();
    this.thunder?.dispose();
    this.defense?.dispose();
    this.shrink?.dispose();
    this.crystal?.dispose();
    this.paint?.dispose();
    this.crown?.dispose();
    this.scenery?.dispose();
    this.arena?.dispose();
    if (this.cargoGroup) {
      this.cargoGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach((m) => m.dispose());
        }
      });
      this.scene.remove(this.cargoGroup);
    }
    if (this.depositGroup) {
      this.depositGroup.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.scene.remove(this.depositGroup);
    }
  }
}

export const SKY_TOWER_NET_TYPES = [
  'towerDash', 'towerScore', 'towerOpen', 'towerEnd',
  // 2026-11-27 逐层赛制：房主广播当前层/阶段/倒计时；超时强拉；每个人落地广播
  'towerLayer', 'towerPull', 'towerLand',
  // 第 1 层水球赛：球的位姿（房主 15Hz 广播）+ 进球
  'footBall', 'footGoal',
  // 第 2 层泡泡送包子：抢货 / 掉货 / 送达 / 泡泡生成与爆炸
  'deliverGrab', 'deliverDrop', 'deliverScore', 'bubbleSpawn', 'bubblePop',
  // 第 3 层道具箱大乱斗：开箱 / 放道具 / 持有列表 / 命中 / 特效 + 本层结束。
  // 前五个就是道具赛那套（服务器白名单里本来就有），天梯这边必须同样订阅，
  // 否则第 3 层在联机里"自己吃得到、看不见别人动"。
  'itemPick', 'itemUse', 'itemHeld', 'itemHit', 'itemFx', 'itemRushEnd',
  // 第 4 层雷霆龙骑士：位姿/血量/读条/输出上报/玩家受击/结算
  // 注意不要写成怪物模式的 bossState/bossHit —— 那两套消息语义完全不同
  'towerBossState', 'towerBossCast', 'towerBossHit', 'towerBossHurt', 'towerBossEnd',
  // 第 5 层随机落雷：落点广播 / 命中计数 / 本层结算。
  // 服务器 RELAY_TYPES 必须同步加上这三条，否则联机里只有房主看得见雷
  'towerBoltWave', 'towerBoltHit', 'towerBoltEnd',
  // 第 6 层塔防：房主刷怪 / 小怪快照 / 客机命中上报 / 受击 / 结算
  'towerDefSpawn', 'towerDefState', 'towerDefHit', 'towerDefHurt', 'towerDefEnd',
  // 第 7 层缩圈：圈半径+里程快照 / 掉圈上报 / 本层结算
  'towerShrinkState', 'towerShrinkFall', 'towerShrinkEnd',
  // 第 8 层水晶攻防：血量/箱子/弹药快照、泡泡请求与生成、撞击上报、爆炸推人、破碎、结算
  'towerCrystalState', 'towerCrystalBox', 'towerCrystalFire', 'towerCrystalBubble',
  'towerCrystalHit', 'towerCrystalHp', 'towerCrystalPopPush',
  'towerCrystalDown', 'towerCrystalEnd',
  // 第 9 层涂地竞速：归属快照、断笔、泡泡请求/爆点、结算
  'towerPaintState', 'towerPaintBreak', 'towerPaintFire', 'towerPaintPop', 'towerPaintEnd',
  // 第 10 层加冕仪式：皇冠状态、抢冠、掉冠、加冕、泡泡、击退、掉落、结算
  'towerCrownState', 'towerCrownGrab', 'towerCrownDrop', 'towerCrownScore',
  'towerCrownFire', 'towerCrownBubble', 'towerCrownPop', 'towerCrownKnock',
  'towerCrownFall', 'towerCrownEnd',
];
