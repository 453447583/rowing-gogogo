import * as THREE from 'three';
import { BoatWeapons } from './BoatWeapons.js';
import { ItemManager, ITEM_DEFS } from './Items.js';
import {
  ARENA_CARDS, ARENA_CARD_BY_ID, ARENA_CARD_CATS,
  ARENA_MODIFIERS, ARENA_MODIFIER_BY_ID,
  makeRng, shuffled, pickModifierIds, pickCardOffers,
} from '../data/arenaRun.js';

/**
 * 潮汐竞技场（1v1 技能对战）
 *
 * 设计原则：**复用**，不是重写。
 * - 场地：直接用 BossArena（Game 已经在 `mode==='arena'` 时建好了，这里只拿引用）
 * - 船：Game 建好的 `boats` / `localBoat`，本类不碰物理
 * - 武器：BoatWeapons 原样复用。它判命中只读目标的 `pos` / `dead` / `def.radius`
 *   三个字段，所以给它一个「指向敌方赛艇的假 BOSS 代理对象」，
 *   整套炮塔瞄准、弹道、命中特效就自动变成 PvP 的了，BoatWeapons 一行不用改。
 * - 血量/复活/回合：接口对齐 BossMode（`players` / `hudData` / `canControl` …），
 *   这样 Game 里 `this.bossMode` 那一串调用可以直接指向本类。
 *
 * 与 BossMode 的差异：没有 BOSS、没有小怪、没有关卡流程；只有 1v1 三条命、三局两胜。
 */

// 开场动画跳过开关（?arenaCinema=0）：回归测试的无头软光栅只有 1~3fps，
// 10s 游戏时间会被 dt=0.05s 的钳制放大成两三分钟真实时间；联机 e2e 用它避免假超时。
function skipCinemaByUrl() {
  try {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('arenaCinema') === '0';
  } catch { return false; }
}

// 整场比赛的公共参数。单关规则见下面的 ARENA_ROUNDS / ARENA_DELIVERY / ARENA_RINGOUT / ARENA_DUEL
export const ARENA_RULES = {
  MAX_HP: 300,
  ROUND_TIME: 90,    // 每关 90 秒，超时按各关规则判胜
  ROUNDS_TO_WIN: 2,  // 三关两胜：先拿 2 分直接结束（2:0 不打第三关）
  RESPAWN: 4,        // 击沉后 4 秒复活
  COUNTDOWN: 3,
  COUNTDOWN_FAST: 2, // 第 2/3 关：过场卡之后只等 2 秒
  SPAWN_R: 46,       // 出生点离场心 46m，两人对向站
  // 第 1 关开场标题卡时长（秒）：大字 + 背景模糊，期间常驻 HUD 全部收起、倒计时冻结。
  // 之后才走下面的 CINEMA_TIME 镜头飞行，最后 3 秒接 3-2-1。
  INTRO_TIME: 5,
  // 第 1 关开场镜头时长（秒）：相机走「俯瞰 → 场内 → 环看台 → 贴船」的固定路径。
  CINEMA_TIME: 7,
  // 第 2/3 关之间的过场卡时长（秒）：同样大字 + 背景模糊，但镜头不动，卡结束直接进倒计时。
  ROUND_CARD_TIME: 3.2,
  // 炮塔辅助角。这一条直接决定手感，别乱调：
  //   8°（0.14）  = 炮口几乎只能朝船头 → 想打中就必须"船头对准对手" → 只能迎面对冲，
  //                 玩家没有任何走位空间，玩起来就是两座炮台对轰（实测反馈）。
  //   100°(1.75)  = 竞速模式的默认值，几乎全向自动瞄准，玩家不用管朝向。
  //   48°(0.84)   = 可以侧身/半绕圈开火，但**没有提前量预测**：对手横向移动就会打空。
  //                 于是"绕着打"能躲、直线跑必被命中 → 走位第一次有了价值。
  TURRET_YAW: 0.84,
};

/**
 * 三关配置：每关一种玩法，赢一关得 1 分，先到 2 分赢下整场。
 * 顺序固定（第 1 关永远是运送），因为过场卡上要写「第 X 关」。
 */
export const ARENA_ROUNDS = [
  {
    key: 'delivery',
    name: '潮汐运送',
    hint: '把潮汐核心推进对方球门',
    tip: '贴近核心才能推动 · 双方同时贴近会僵持',
  },
  {
    key: 'ringout',
    name: '潮汐擂台',
    hint: '把对手撞出擂台 · 先得 3 分',
    tip: '主炮锁定 · 只能靠冲刺和撞击',
  },
  {
    key: 'duel',
    name: '缩圈决斗',
    hint: '缩圈决斗 · 一条命定胜负',
    tip: '按住 H 举盾挡正面炮火',
  },
];

/**
 * 第 1 关「潮汐运送」
 *
 * 为什么不是占点：占点仍然是"往圈里一站就涨进度"，双方都往中心挤 →
 * 又退化成站桩对射。核心会动、而且只有靠近才推得动，玩家必须"绕到核心后面"
 * 才能把球往对方门里送，正面拦人、侧翼包抄第一次有了意义。
 *
 * 推动方向按阵营固定（不是按物理朝向）：谁贴近就往谁的目标门走。
 * 这样菜鸟也不会把球推进自家门，代价是"从正面顶着球也能推"，可以接受。
 */
export const ARENA_DELIVERY = {
  CORE_R: 3.2,       // 核心碰撞半径（船会被顶开）
  PUSH_R: 10,        // 离核心多近才算"在推"
  SPEED: 5.2,        // 单人推进速度 m/s
  RETURN: 2.2,       // 没人碰时回中速度
  GOAL_Z: 32,        // 球门线到场心的距离
  GOAL_W: 24,        // 球门宽度
  OVERTIME: 30,      // 加时秒数
  OT_LEAD: 15,       // 加时赛：先领先 15m 直接获胜
};

/**
 * 第 2 关「潮汐擂台」
 *
 * 主炮禁用，只留冲刺和船体撞击。把"谁先打沉谁"换成"谁先把谁顶出圈"，
 * 撞击角度、冲刺时机、贴身缠斗全都变成有效操作；圈外没有墙，掉出去就是失分。
 */
export const ARENA_RINGOUT = {
  R: 45,             // 擂台半径
  RESPAWN: 2,        // 掉出擂台后几秒回场
  SCORE_TO_WIN: 3,   // 1v1：先撞出 3 次赢下本关
  RAM_R: 5.2,        // 船-船碰撞半径（两船中心距）
  RAM_MIN: 7,        // 沿法线的相对速度超过这个值才传冲量
  RAM_POWER: 1.35,   // 冲量系数
};

/**
 * 第 3 关「缩圈决斗」
 *
 * 一条命 + 缩圈 + 定向格挡：逼迫玩家在"躲炮"和"抢圈心"之间做选择，
 * 圈外掉血逼你动，格挡让正面硬刚有反制，35° 炮口又逼你保持船头朝向。
 */
export const ARENA_DUEL = {
  R_START: 50,
  R_END: 30,
  SHRINK_TIME: 75,   // 75 秒从 50m 收到 30m
  OUT_DPS: 22,       // 圈外每秒伤害
  OUT_TICK: 0.5,     // 圈外伤害结算间隔
  OUT_SLOW: 0.35,    // 圈外减速时长（交给 Boat.slowTimer）
  TURRET_YAW: 0.61,  // 35°：只能打船头前方，必须主动对准
  BLOCK_ANGLE: 1.15, // 正面 ±66° 内可挡
  BLOCK_DRAIN: 0.42, // 举盾每秒消耗 42% 能量
  BLOCK_REGEN: 0.26,
  BLOCK_REGEN_DELAY: 0.6,
  BLOCK_OVERHEAT: 2.2, // 能量打空后的过热时间
  BLOCK_HIT_COST: 0.05,
};

/**
 * 固定技能（每艘船相同，靠 CD 制造"读招-应对"）
 * - 冲刺：短位移 + 0.35s 无敌，用来穿弹幕、抢点、脱离大招前摇
 * - 大招：0.85s 前摇 + 地面预警圈，范围内爆发伤害 —— 前摇就是给对手的逃跑窗口
 */
export const ARENA_SKILLS = {
  DASH_CD: 6,
  DASH_BOOST: 24,     // 瞬时速度加成（m/s）
  DASH_INVULN: 0.35,
  ULT_CD: 24,
  ULT_TELEGRAPH: 0.85,
  ULT_RADIUS: 16,
  ULT_DAMAGE: 55,
};

/**
 * 竞技场道具池（10 件）。
 *
 * 挑选标准不是"哪个好玩"，而是**在 1v1 里能不能被反制**：
 * 1v1 只有一个对手，凡是「追踪前一名」的道具（深水炸弹 / 追踪导弹 / 章鱼 /
 * 泡泡蜻蜓）都会 100% 命中，等于两件装备互换血量，没有操作空间。
 * 所以这里只留三类：
 *   ① 自身生效（氮气 / 护盾 / 天使）——用来逃、用来吃伤害
 *   ② 纯干扰（墨鱼 / 减速艇 / 方向转换器）——伤害为零，但让对手操作变形
 *   ③ 需要瞄准或能躲的（鱼雷齐射 / 深海瀑布 / 漩涡 / 飞鱼群）
 * 每一件都至少有一个反制口子：护盾/天使清负面、氮气躲鱼雷与瀑布 18m 圈、
 * 漩涡有 0.45s 引信能跑出 9m AoE。
 */
export const ARENA_ITEM_POOL = [
  'nitro', 'shield', 'angel',
  'ink', 'slowboat', 'tide',
  'torpedo', 'waterfall', 'vortex', 'fish',
];

/**
 * 第 2 关「潮汐擂台」的收窄道具池：
 * 本关规则是"主炮锁定、只能冲刺/撞击"，再发鱼雷/瀑布/飞鱼这类伤害道具
 * 等于变相加回远程攻击，和关卡定位冲突。这里只留位移、护盾和纯干扰。
 */
export const RINGOUT_ITEM_POOL = ['nitro', 'shield', 'angel', 'ink', 'slowboat', 'tide'];

/** 竞技场道具箱：摆进交战带（AI 绕圈半径 24~34m），而不是扔在外圈让玩家跑腿 */
function makeArenaBoxLayout() {
  const out = [];
  const ring = (r, n, phase) => {
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      out.push({ x: Math.sin(a) * r, z: Math.cos(a) * r });
    }
  };
  // 外圈 46m（稍微脱离战斗圈，值得绕一下） + 内圈 24m（贴身缠斗时顺手吃）
  ring(46, 8, 0);
  ring(24, 6, Math.PI / 6);
  return out;
}

/** 空数组复用：BoatWeapons 每帧都读障碍/小怪列表，别每次新建 */
const EMPTY = Object.freeze([]);
/** 临时向量：血条每帧要算相机距离，复用避免 GC */
const _tmpV = new THREE.Vector3();

/** 敌方赛艇伪装成「BOSS」，供 BoatWeapons 的瞄准与命中判定复用 */
function makeTargetProxy(getBoat, getAlive, radius) {
  return {
    get pos() { return getBoat()?.pos ?? { x: 0, y: 0, z: 0 }; },
    get dead() { return !getAlive(); },
    def: { radius, name: '赛艇' },
  };
}

export class ArenaMode {
  constructor(opts) {
    this.scene = opts.scene;
    this.fx = opts.fx;
    this.net = opts.net;
    this.myId = opts.myId;
    this.solo = !!opts.solo;
    this.opts = opts;
    this.arena = opts.arena || null;
    this.order = opts.order || [];
    this.boats = opts.boats;
    this.localBoat = opts.localBoat;
    this.onToast = opts.onToast || (() => {});
    // 复活时把追尾相机硬切回船位：死亡视角现在是"抬起来的俯视"，不复位的话
    // 相机会从半空用几秒慢慢飞回艇后，中途还会穿水面（水下滤镜一开就是一片蓝）
    this.onRespawn = opts.onRespawn || null;
    // 开场动画播完的瞬间回调：Game 用它把追尾相机 snapTo 回船尾（无跳变交接）
    this.onCinemaEnd = opts.onCinemaEnd || null;
    // 最后一击的来源，给"被击沉"面板用（谁打的、这一下多少伤害）
    this.deathHit = null;
    this.camLook = new THREE.Vector3();
    this.camPos = new THREE.Vector3();
    // 整场打完（先到 ROUNDS_TO_WIN 分）回调一次，交给外层弹结算面板。
    // 不传就退回"只弹一条 toast"的老行为，单人调试不受影响。
    this.onMatchEnd = opts.onMatchEnd || null;
    this.matchEndNotified = false;

    // Game 每帧会扣这个值做顿帧
    this.hitStop = 0;

    // 房主权威：据点进度、回合切换、超时判胜只由房主算，客机吃广播。
    // （两个人各算一遍一定会分叉——一圈 13m、3 秒占领，几帧的延迟就够判给不同的人）
    this.isHost = opts.isHost !== false;
    this.pointNetAcc = 0;

    // 只支持 1v1：取进场顺序里的前两位
    const ids = this.order.map((e) => e.id).slice(0, 2);
    this.foeId = ids.find((id) => id !== this.myId) || null;

    // ---- 随机跑：关卡顺序 + 每关词缀 + 三选一 ----
    // 第 1 关固定「潮汐运送」保留教学意义，第 2/3 关由房主洗牌。
    // 客机构造时先用默认顺序，收到房主 arenaSkill(kind=sync) 后覆盖。
    this.rng = makeRng(`${Date.now()}|${Math.random()}|${this.myId}`);
    // 自动化测试/回放可以关掉随机跑，回到固定三关、无词缀、无卡牌
    this.runRandom = opts.runRandom !== false;
    this.runStats = new Map();      // id -> 逐步累加的卡牌数值
    this.mods = [];                 // 本关词缀 id
    this.usedMods = new Set();      // 整场不重复
    this.roundOrder = this.runRandom
      ? [ARENA_ROUNDS[0], ...shuffled(ARENA_ROUNDS.slice(1), this.rng)]
      : ARENA_ROUNDS.slice();
    this.nextPlan = null;           // 下一关 { round, def, mods }
    this.pendingOffer = [];         // 本地玩家的三选一候选
    this.cardChosen = null;
    this.offers = null;             // 房主下发给所有人类玩家的候选
    this.runEl = null;
    this.cardsEl = null;
    this.synced = false;
    this.syncT = 0;
    this.runT = 0;
    this.thunderT = 0;
    this.thunderPending = 0;
    this.thunders = [];
    if (this.isHost && this.runRandom) this.mods = this.#drawMods(1);

    const R = ARENA_RULES;
    this.players = new Map();
    for (const e of this.order) {
      if (!ids.includes(e.id)) continue;
      const isMe = e.id === this.myId;
      this.players.set(e.id, {
        id: e.id,
        name: e.name || e.id,
        avatar: e.avatar || '',
        ai: !!e.ai,
        hp: R.MAX_HP,
        // 命数按关卡给：只有第 3 关是一条命，前两关被打沉只是短暂回场
        lives: 99,
        alive: true,
        respawn: 0,
        taken: 0,
        invuln: 0,
        score: 0,       // 大比分（赢一关 +1，先到 2）
        ringScore: 0,   // 第 2 关：撞出对手的次数
      });
      if (!isMe) this.foeId = e.id;
    }

    // 回合状态
    this.phase = 'countdown';   // countdown | fight | roundEnd | matchEnd
    this.dmgTexts = [];         // 命中飘字
    this.countdown = R.COUNTDOWN;
    this.roundTime = this.#hasMod('short_clock') ? 60 : R.ROUND_TIME;
    this.round = 1;
    this.roundDef = this.roundOrder[0];
    this.roundKind = this.roundDef.key;   // delivery | ringout | duel
    this.timeoutHandled = false;
    this.endTimer = 0;
    this.lastRoundWinner = null;
    this.matchWinner = null;
    // 第 1 关：潮汐核心的位置（房主权威，客机吃 arenaCore 广播）
    // z2 只在「双核」词缀下启用，双核各自独立推进，任一进门得分
    this.delivery = { z: 0, z2: 0, me: 0, foe: 0, overtime: false, otStart: 0 };
    // 第 2/3 关：擂台/决斗圈半径。决斗关每帧按时间收缩
    this.ring = this.ringoutR;
    this.duelT = 0;
    this.duelTick = 0;
    // 第 3 关：定向格挡能量（0~1）
    this.blockState = { energy: 1, overheat: 0, delay: 0, active: false };

    // 出生朝向：两人面对面（都朝场心）
    this.spawns = new Map();
    // 阵营推进方向：出生在 +z 的一方把核心往 -z 推，反之亦然
    this.deliverySide = new Map();
    const dirs = [[0, 1], [0, -1]];
    ids.forEach((id, i) => {
      const [sx, sz] = dirs[i] || dirs[0];
      this.spawns.set(id, {
        x: sx * R.SPAWN_R,
        z: sz * R.SPAWN_R,
        heading: Math.atan2(-sx, -sz),
      });
      this.deliverySide.set(id, sz > 0 ? -1 : 1);
    });
    this.#placeAll();

    // ---- 开场（只整场第一局有）----
    // 两段：① INTRO_TIME 秒标题卡（大字 + 背景模糊 + HUD 全收）② CINEMA_TIME 秒镜头飞行。
    // 相机路径在构造时算好（出生点已知）：高空俯瞰 → 压向场内 → 沿看台环扫 → 贴到自己船尾。
    // 必须放在 players/spawns 建好之后：路径结尾要取自己的出生点。
    // ?arenaCinema=0 一键跳过：回归测试的无头软光栅只有 1~3fps，10s 游戏时间会被
    // dt=0.05s 的钳制放大成两三分钟真实时间；联机 e2e 也用这个开关避免假超时。
    const skipCinema = skipCinemaByUrl();
    this.intro = skipCinema ? 0 : R.INTRO_TIME;
    this.cinema = skipCinema ? 0 : R.CINEMA_TIME;
    this.introEl = this.intro > 0 ? this.#makeIntroOverlay(1, this.roundDef) : null;
    if (this.cinema > 0) this.#buildCinemaPath();

    // 火力：每艘船一套 BoatWeapons，各自把对方当目标
    this.weaponSeq = 0;
    this.weapons = new Map();
    for (const id of ids) {
      const targetId = id === this.myId ? this.foeId : this.myId;
      this.weapons.set(id, this.#makeWeapons(id, targetId));
    }

    // ---- 道具 ----
    // 整块复用道具赛的 ItemManager：10 件道具的位移/失控/墨汁/升空/翻船演出
    // 全是现成的，这里只负责喂一个「没有赛道」的桩 + 裁剪道具池。
    this.trackStub = this.#makeTrackStub();
    this.items = new ItemManager({
      scene: this.scene,
      track: this.trackStub,
      net: this.net,
      myId: this.myId,
      isHost: true,
      solo: this.solo,
      storm: false,
      fx: this.fx,
      boxLayout: makeArenaBoxLayout(),
      itemPool: ARENA_ITEM_POOL,
      slotKeys: ['Q', 'E', '1'],
      getCamera: () => this.opts.camera || null,
      getBoats: () => this.boats,
      // 名次用血量排（血多=领先）：既让 rollItem 的追赶权重自动生效，
      // 也让「飞鱼群」只追血更厚的那个，不需要改 Items.js 里的目标选择逻辑
      getRank: (id) => this.#rankByHp(id),
      getGate: () => 0,
      onToast: (msg) => this.onToast(msg),
    });

    // ---- 血条 ----
    // 船上本来有一个内置姓名贴图（Boat.label，y=3.3）。竞技场里改由下面这块
    // 「名字+血条+数值」的名牌统一负责，所以先把内置的关掉，否则会重影两套名字。
    this.hpBars = new Map();
    for (const id of ids) {
      const bt = this.#boat(id);
      if (bt?.label) bt.label.visible = false;
      this.hpBars.set(id, this.#makeHpBar());
    }

    // ---- 三关的场景标记（先全部建好，再按当前关切换可见性） ----
    this.#buildDeliveryCore();
    this.#buildRingVisual();
    this.#buildBlockShield();

    // ---- 技能 ----
    this.skills = new Map();
    for (const id of ids) this.skills.set(id, { dashCd: 0, ultCd: 0 });
    this.ults = [];
    this.warnRings = [];

    // 道具键：Q/E/1（W 仍是油门，J 是主炮）
    const input = this.opts.input;
    if (input) {
      input.bossItemMode = true;
      input.onItem = (slot) => this.useItemSlot(slot);
    }

    // 把第 1 关的规则套到武器/场景上（第 2/3 关开始时会再套一次）
    this.#applyRoundKind();
    this.#grantStarters();
    this.#renderRunUi();
    this.#syncHud();
  }

  /** 竞技场版的「假赛道」：ItemManager 只会用到这几个字段 */
  #makeTrackStub() {
    const stub = {
      gates: Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * Math.PI * 2;
        return [Math.sin(a) * 70, Math.cos(a) * 70];
      }),
      gateWidth: 7,
      map: {},
      surfaceYAt: () => 0,
      // 漩涡水弹要「沿赛道往前投」：竞技场没有中线，改成沿船头方向、射程压到 45m
      // （原版 100m 会直接扔出场外）
      routeAhead: (x, z) => {
        const h = stub._heading || 0;
        const d = 45;
        return { x: x + Math.sin(h) * d, z: z + Math.cos(h) * d };
      },
      _heading: 0,
    };
    return stub;
  }

  #rankByHp(id) {
    const sorted = [...this.players.values()].sort((a, b) => b.hp - a.hp);
    const i = sorted.findIndex((p) => p.id === id);
    return i < 0 ? 1 : i + 1;
  }

  /**
   * 船顶名牌（仿 MOBA 血条，材质沿用竞技场那套「暗黑锻铁」）：
   * 锻铁底板 + 黄铜包边 + 四角铆钉 + 米白衬线名字 + 深红分段血槽 + 黄铜数字铜牌。
   *
   * 尺寸用「恒定屏幕占比」而不是固定世界尺寸：船离镜头 15m 和 60m 时，
   * 固定世界尺寸的牌子一个糊满屏、一个看不见。这里每帧按相机距离反算世界高度，
   * 让它始终占屏幕高度约 9%，跟参考图的手感一致。
   */
  #makeHpBar() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 184;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    }));
    spr.scale.set(2.8, 1.006, 1);
    spr.renderOrder = 60;
    spr.visible = false;
    this.scene.add(spr);
    return { canvas, ctx: canvas.getContext('2d'), tex, spr, ratio: -1, flash: 0, hp: -1 };
  }

  /** 圆角矩形（不依赖 ctx.roundRect，老版本浏览器也能跑） */
  #rr(ctx, x, y, w, h, r) {
    const m = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + m, y);
    ctx.lineTo(x + w - m, y);
    ctx.arcTo(x + w, y, x + w, y + m, m);
    ctx.lineTo(x + w, y + h - m);
    ctx.arcTo(x + w, y + h, x + w - m, y + h, m);
    ctx.lineTo(x + m, y + h);
    ctx.arcTo(x, y + h, x, y + h - m, m);
    ctx.lineTo(x, y + m);
    ctx.arcTo(x, y, x + m, y, m);
    ctx.closePath();
  }

  #drawHpBar(bar, ratio, hp, name, mine) {
    const { ctx, canvas } = bar;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const PL = 8, PT = 8, PW = W - 16, PH = H - 16;

    // ---- 底板：黄铜包边（带投影）→ 铁面 → 上沿拉丝高光 ----
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 5;
    this.#rr(ctx, PL, PT, PW, PH, 9);
    const brass = ctx.createLinearGradient(0, PT, 0, PT + PH);
    brass.addColorStop(0, '#E3C07A');
    brass.addColorStop(0.42, '#B98A45');
    brass.addColorStop(1, '#6B5227');
    ctx.fillStyle = brass;
    ctx.fill();
    ctx.restore();

    this.#rr(ctx, PL + 3, PT + 3, PW - 6, PH - 6, 7);
    const iron = ctx.createLinearGradient(0, PT, 0, PT + PH);
    iron.addColorStop(0, '#2E2921');
    iron.addColorStop(0.55, '#232019');
    iron.addColorStop(1, '#141210');
    ctx.fillStyle = iron;
    ctx.fill();

    ctx.strokeStyle = 'rgba(227,192,122,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PL + 10, PT + 5.5);
    ctx.lineTo(PL + PW - 10, PT + 5.5);
    ctx.stroke();

    // 四角铆钉
    for (const [cx, cy] of [[PL + 11, PT + 11], [PL + PW - 11, PT + 11],
      [PL + 11, PT + PH - 11], [PL + PW - 11, PT + PH - 11]]) {
      const g = ctx.createRadialGradient(cx - 1.2, cy - 1.2, 0.6, cx, cy, 4.4);
      g.addColorStop(0, '#F6E2B4');
      g.addColorStop(0.62, '#B98A45');
      g.addColorStop(1, '#5C4522');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- 名字：米白衬线 + 深色描边 + 下方暗投影（金属雕刻感）----
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 36px Georgia, "Songti SC", "SimSun", "Times New Roman", serif';
    const label = String(name || '').slice(0, 10);
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    ctx.fillText(label, W / 2, 44.5);
    ctx.lineWidth = 6.5;
    ctx.strokeStyle = 'rgba(9,7,6,0.94)';
    ctx.strokeText(label, W / 2, 43);
    ctx.fillStyle = mine ? '#BEE8FF' : '#EDE4D0';
    ctx.fillText(label, W / 2, 43);

    // ---- 血槽：深红底槽 + 亮红填充 + 顶部高光 ----
    const bx = 42, by = 66, bw = W - 84, bh = 44;
    this.#rr(ctx, bx, by, bw, bh, 5);
    ctx.fillStyle = '#0D0C0A';
    ctx.fill();

    const r = Math.max(0, Math.min(1, ratio));
    const fw = Math.max(0, (bw - 6) * r);
    if (fw > 0.6) {
      ctx.save();
      this.#rr(ctx, bx + 3, by + 3, fw, bh - 6, 4);
      ctx.clip();
      const grad = ctx.createLinearGradient(0, by, 0, by + bh);
      grad.addColorStop(0, '#E4566A');
      grad.addColorStop(0.42, '#C7303F');
      grad.addColorStop(1, '#7A0F1E');
      ctx.fillStyle = grad;
      ctx.fillRect(bx + 3, by + 3, fw, bh - 6);
      const hl = ctx.createLinearGradient(0, by + 3, 0, by + 18);
      hl.addColorStop(0, 'rgba(255,236,236,0.5)');
      hl.addColorStop(1, 'rgba(255,236,236,0)');
      ctx.fillStyle = hl;
      ctx.fillRect(bx + 3, by + 3, fw, 15);
      ctx.restore();
    }

    this.#rr(ctx, bx, by, bw, bh, 5);
    ctx.strokeStyle = '#B98A45';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // 4 个黄铜菱形刻度（20/40/60/80%），与 HUD 血条同一套语言
    ctx.save();
    for (const t of [0.2, 0.4, 0.6, 0.8]) {
      ctx.save();
      ctx.translate(bx + bw * t, by + bh / 2);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#E3C07A';
      ctx.strokeStyle = '#4A3A18';
      ctx.lineWidth = 1.2;
      ctx.fillRect(-5, -5, 10, 10);
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.restore();
    }
    ctx.restore();

    // 受击白闪
    if (bar.flash > 0) {
      ctx.save();
      this.#rr(ctx, bx + 3, by + 3, bw - 6, bh - 6, 4);
      ctx.clip();
      ctx.fillStyle = `rgba(255,255,255,${Math.min(1, bar.flash / 0.22) * 0.6})`;
      ctx.fillRect(bx + 3, by + 3, bw - 6, bh - 6);
      ctx.restore();
    }

    // ---- 血量数字：黄铜小铜牌 ----
    const nw = 136, nh = 34, nx = (W - nw) / 2, ny = 119;
    this.#rr(ctx, nx, ny, nw, nh, 5);
    const plate = ctx.createLinearGradient(0, ny, 0, ny + nh);
    plate.addColorStop(0, '#DDBB7E');
    plate.addColorStop(0.46, '#B98A45');
    plate.addColorStop(1, '#7E6029');
    ctx.fillStyle = plate;
    ctx.fill();
    ctx.strokeStyle = '#4A3A18';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.font = '700 22px Georgia, "Times New Roman", serif';
    ctx.fillStyle = '#171208';
    ctx.fillText(String(Math.max(0, Math.round(hp))), W / 2, ny + nh / 2 + 1);

    bar.tex.needsUpdate = true;
  }

  /** 命中飘字：小号数字从命中点往上飘并淡出（0.85s） */
  #spawnDmgText(x, z, dmg) {
    // 连射武器每秒 5~6 发，不加上限会瞬间堆出几十个 canvas
    if (this.dmgTexts.length > 6) {
      const old = this.dmgTexts.shift();
      this.scene.remove(old.spr);
      old.spr.material.dispose();
      old.tex.dispose();
    }
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 46px "Arial Black", "Microsoft YaHei", sans-serif';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    const txt = String(Math.round(dmg));
    ctx.strokeText(txt, 64, 34);
    ctx.fillStyle = dmg >= 14 ? '#ffd34d' : '#ffffff';
    ctx.fillText(txt, 64, 34);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
    }));
    spr.scale.set(1.8, 0.9, 1);
    spr.renderOrder = 70;
    // 起点压到船身高度（y≈1.1）并横向随机散开：
    // 原来从 2.4m 起飘，连射几发就正好盖住船顶那块名牌，把名字糊掉了
    spr.position.set(x + (Math.random() - 0.5) * 5.2, 1.0 + Math.random() * 0.8, z);
    this.scene.add(spr);
    this.dmgTexts.push({
      spr, tex, t: 0, life: 0.8,
      vx: (Math.random() - 0.5) * 1.6,   // 顺便横向漂一点，避免竖着叠成一条
    });
  }

  #updateDmgTexts(dt) {
    for (let i = this.dmgTexts.length - 1; i >= 0; i--) {
      const d = this.dmgTexts[i];
      d.t += dt;
      const k = d.t / d.life;
      d.spr.position.y += dt * 1.9;
      d.spr.position.x += d.vx * dt;
      d.spr.material.opacity = Math.max(0, 1 - k * k);
      if (k >= 1) {
        this.scene.remove(d.spr);
        d.spr.material.dispose();
        d.tex.dispose();
        this.dmgTexts.splice(i, 1);
      }
    }
  }

  /** 每帧把名牌贴到船顶，并按相机距离换算成恒定屏幕占比 */
  #updateHpBars(dt) {
    const R = ARENA_RULES;
    const cam = this.opts?.camera;
    // 牌子高 ≈ 视野高度的 7.8%（16:9 下宽度约 13% 屏宽）。
    // 纯恒定屏占会让 70m 外的对手挂一块和眼前一样大的牌子（实测压过整条船身），
    // 所以在 NEAR→FAR 之间做 smoothstep 收拢，最远只保留 FAR_K 倍（≈4.5% 屏高）。
    const SCREEN_H = 0.078;
    const NEAR_D = 16;
    const FAR_D = 72;
    const FAR_K = 0.58;
    const ASPECT = 512 / 184;
    for (const [id, bar] of this.hpBars) {
      const p = this.#player(id);
      const boat = this.#boat(id);
      if (!p || !boat) { bar.spr.visible = false; continue; }
      bar.flash = Math.max(0, bar.flash - dt);
      // 只给对手飘名牌：自己的血量底部 HUD 已经常驻，追尾视角下自己船顶那块牌子
      // 会正好压在画面中央挡视线（实测正好盖住准星区域）。
      if (!p.alive || id === this.myId) { bar.spr.visible = false; continue; }
      bar.spr.visible = true;
      // 先按相机距离定世界尺寸（恒定屏幕占比），再用这个高度去摆锚点，
      // 顺序反了会让名牌第一帧跳一下
      let h = bar.spr.scale.y;
      if (cam?.isPerspectiveCamera) {
        _tmpV.set(boat.pos.x, (boat.pos.y || 0) + 3.3, boat.pos.z);
        const d = Math.max(2.5, cam.position.distanceTo(_tmpV));
        const viewH = 2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
        // smoothstep 收拢：q=0（近）满尺寸，q=1（远）收到 FAR_K
        const q = THREE.MathUtils.clamp((d - NEAR_D) / (FAR_D - NEAR_D), 0, 1);
        const shrink = 1 - (1 - FAR_K) * (q * q * (3 - 2 * q));
        h = viewH * SCREEN_H * shrink;
        bar.spr.scale.set(h * ASPECT, h, 1);
      }
      // 贴紧船顶：锚点沿用内置姓名牌高度（Boat.label 在 y=3.3），
      // 让名牌正好长在原来那个名字的位置上，不会飘成"半空中的广告牌"
      bar.spr.position.set(
        boat.pos.x,
        (boat.pos.y || 0) + 3.3 + h * 0.5 - 0.3,
        boat.pos.z,
      );
      const ratio = p.hp / R.MAX_HP;
      if (Math.abs(ratio - bar.ratio) > 0.001 || bar.hp !== Math.round(p.hp)) {
        bar.ratio = ratio;
        bar.hp = Math.round(p.hp);
        this.#drawHpBar(bar, ratio, p.hp, p.name, id === this.myId);
      }
    }
  }

  /** 使用本地玩家的某个道具槽 */
  useItemSlot(slot) {
    if (this.phase !== 'fight' || !this.items) return false;
    const item = this.items.myItems[slot];
    if (!item) return false;
    const boat = this.#boat(this.myId);
    // 漩涡水弹靠 routeAhead 定落点，得先把当前船头方向喂给桩
    if (boat) this.trackStub._heading = boat.heading;
    const consumed = this.items.useItem(this.myId, item, slot);
    if (consumed !== false) this.items.myItems[slot] = null;
    return consumed !== false;
  }

  #boat(id) { return this.boats.get(id); }
  #player(id) { return this.players.get(id); }
  #foe() { return this.#boat(this.foeId); }

  // ======================================================================
  // 随机跑：词缀 / 卡牌 / 三选一 UI
  // ======================================================================

  #hasMod(id) { return this.mods.includes(id); }

  /** 自动化测试用：关掉随机跑，回归固定三关 / 无词缀 / 无卡牌 */
  disableRandomRun() {
    this.runRandom = false;
    this.mods = [];
    this.usedMods.clear();
    this.roundOrder = ARENA_ROUNDS.slice();
    this.nextPlan = null;
    this.pendingOffer = [];
    this.cardChosen = null;
    this.offers = null;
    this.#closeCards();
    this.#applyRoundKind();
    this.#renderIntroMods();
    this.#renderRunUi();
  }

  /** 薄冰：擂台实际半径 */
  get ringoutR() { return ARENA_RINGOUT.R * (this.#hasMod('thin_ice') ? 0.85 : 1); }

  /** 缩圈加速：决斗圈收缩总时长 */
  get duelShrinkTime() { return this.#hasMod('fast_shrink') ? 45 : ARENA_DUEL.SHRINK_TIME; }

  #drawMods(round) {
    if (!this.runRandom) return [];
    const ids = pickModifierIds(round, this.usedMods, this.rng);
    for (const id of ids) this.usedMods.add(id);
    return ids;
  }

  #stats(id) {
    let rs = this.runStats.get(id);
    if (!rs) {
      rs = {
        dmg: 0, taken: 0, crit: 0, fireRate: 0, side: 0,
        speed: 0, turn: 0, dashCd: 0, ultCd: 0, ram: 0,
        dashInvuln: 0, respawnCut: 0,
        revive: 0, rewind: 0,
        starter: 0, shieldStarter: 0, damageStarter: 0, bonusChance: 0,
        gambler: false,
        cards: [],
      };
      this.runStats.set(id, rs);
    }
    return rs;
  }

  /** 把加算字段合成乘算系数（PRD：不叠乘，统一加算后再乘） */
  #derived(rs) {
    return {
      dmgMul: Math.max(0.2, 1 + rs.dmg),
      takenMul: Math.max(0.3, 1 + rs.taken),
      critChance: Math.min(0.6, rs.crit),
      fireRateMul: Math.max(0.4, 1 + rs.fireRate),
      sideMul: 1 + rs.side,
      speedMul: Math.max(0.6, 1 + rs.speed),
      turnMul: 1 + rs.turn,
      dashCdMul: Math.max(0.3, 1 - rs.dashCd),
      ultCdMul: Math.max(0.3, 1 - rs.ultCd),
      ramMul: 1 + rs.ram,
    };
  }

  /** 只刷新「本地玩家」和「房主模拟的 AI」，远端真人的属性由他自己算 */
  #refreshBoatStats(id) {
    const p = this.#player(id);
    if (!p || (!p.ai && id !== this.myId)) return;
    const rs = this.#stats(id);
    const d = this.#derived(rs);
    const boat = this.#boat(id);
    if (boat) {
      if (boat.handling) {
        if (boat.__baseYawScale === undefined) boat.__baseYawScale = boat.handling.yawScale;
        boat.handling.yawScale = boat.__baseYawScale * d.turnMul;
      }
      boat.speedMul = d.speedMul;
    }
    const w = this.weapons?.get(id);
    if (w) w.fireRateMul = d.fireRateMul;
    if (this.items && id === this.myId) this.items.bonusChance = rs.bonusChance;
  }

  #refreshAllBoatStats() {
    for (const [id, p] of this.players) {
      if (p.ai || id === this.myId) this.#refreshBoatStats(id);
    }
  }

  /** 赌徒：每关开始随机 +15% 炮伤或 +8% 极速 */
  #applyGambler(id) {
    const rs = this.#stats(id);
    if (!rs.gambler) return;
    if (Math.random() < 0.5) rs.dmg += 0.15;
    else rs.speed += 0.08;
  }

  #applyCard(id, cardId) {
    const def = ARENA_CARD_BY_ID.get(cardId);
    const p = this.#player(id);
    if (!def || !p) return false;
    const rs = this.#stats(id);
    if (rs.cards.filter((c) => c === cardId).length >= def.max) return false;
    rs.cards.push(cardId);
    for (const [k, v] of Object.entries(def.stats || {})) {
      if (k === 'gambler') rs.gambler = true;
      else rs[k] = (rs[k] || 0) + v;
    }
    this.#refreshBoatStats(id);
    if (id === this.myId) {
      this.onToast?.(`获得卡牌 ${def.name}：${def.desc}`);
      this.#renderRunUi();
    }
    return true;
  }

  /** 候选兜底：去掉已满层 / 1v1 不生效的卡，数量不足时本地补齐 */
  #sanitizeOffer(offer) {
    const rs = this.#stats(this.myId);
    const counts = new Map();
    for (const c of rs.cards) counts.set(c, (counts.get(c) || 0) + 1);
    const seen = new Set();
    const out = [];
    for (const id of offer || []) {
      const d = ARENA_CARD_BY_ID.get(id);
      if (!d || d.weight === 0 || seen.has(id)) continue;
      if ((counts.get(id) || 0) >= d.max) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length < 3) {
      const pool = ARENA_CARDS.filter((c) => {
        if (c.weight === 0 || seen.has(c.id)) return false;
        return (counts.get(c.id) || 0) < c.max;
      });
      while (out.length < 3 && pool.length) {
        const one = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
        out.push(one.id);
        seen.add(one.id);
      }
    }
    return out;
  }

  /** 每关开始发放「开局补给 / 应急护盾 / 秘术补给」 */
  #grantStarters() {
    if (!this.items?.myItems) return;
    const dmgPool = ['torpedo', 'waterfall', 'vortex', 'fish'];
    for (const [id, p] of this.players) {
      if (!p.ai && id !== this.myId) continue;
      const rs = this.#stats(id);
      const pool = this.items.itemPool || dmgPool;
      const list = [];
      for (let i = 0; i < rs.starter; i++) list.push(pool[Math.floor(Math.random() * pool.length)]);
      for (let i = 0; i < rs.shieldStarter; i++) list.push('shield');
      for (let i = 0; i < rs.damageStarter; i++) list.push(dmgPool[Math.floor(Math.random() * dmgPool.length)]);
      if (!list.length) continue;
      for (const item of list) {
        if (id === this.myId) {
          const slot = this.items.myItems.indexOf(null);
          if (slot === -1) break;
          this.items.myItems[slot] = item;
        } else {
          let ai = this.items.aiItems.get(id);
          if (!ai) { ai = { items: [], useAt: 0 }; this.items.aiItems.set(id, ai); }
          if (ai.items.length >= 3) break;
          ai.items.push(item);
          if (!ai.useAt) ai.useAt = this.runT + 2;
        }
      }
      try { this.items.syncHeld(id); } catch { /* 单机没有同步 */ }
    }
  }

  #renderRunUi() {
    if (typeof document === 'undefined') return;
    try {
      if (!this.runEl) {
        const el = document.createElement('div');
        el.id = 'arena-run';
        el.innerHTML = '<div class="ar-mods"></div><div class="ar-build"></div>';
        document.body.appendChild(el);
        this.runEl = el;
      }
      const mods = this.mods.map((id) => ARENA_MODIFIER_BY_ID.get(id)).filter(Boolean);
      const mEl = this.runEl.querySelector('.ar-mods');
      mEl.innerHTML = mods.length
        ? `<span class="ar-label">本关词缀</span>${mods.map((m) => `<b class="ar-mod s${m.stars}" title="${m.desc}">${m.name}</b>`).join('')}`
        : '<span class="ar-label">本关词缀</span><span class="ar-none">无</span>';
      const rs = this.#stats(this.myId);
      const counts = new Map();
      for (const c of rs.cards) counts.set(c, (counts.get(c) || 0) + 1);
      const names = [...counts].map(([id, n]) => {
        const d = ARENA_CARD_BY_ID.get(id);
        return d ? `${d.name}${n > 1 ? `×${n}` : ''}` : '';
      }).filter(Boolean);
      this.runEl.querySelector('.ar-build').innerHTML = names.length
        ? `<span class="ar-label">构筑</span>${names.map((n) => `<b class="ar-card-name">${n}</b>`).join('')}`
        : '<span class="ar-label">构筑</span><span class="ar-none">尚未选卡</span>';
    } catch { /* 无 DOM 环境静默 */ }
  }

  #renderIntroMods() {
    const el = this.introEl?.querySelector?.('.ai-mods');
    if (!el) return;
    const mods = this.mods.map((id) => ARENA_MODIFIER_BY_ID.get(id)).filter(Boolean);
    if (!mods.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = mods.map((m) => (
      `<span class="ai-mod s${m.stars}"><i>${'★'.repeat(m.stars)}</i>${m.name}<em>${m.desc}</em></span>`
    )).join('');
  }

  /** 房主在关卡结束时决定下一关：顺序 + 词缀 + 三选一候选 */
  #planNextRound() {
    if (!this.isHost) return;
    const nextRound = this.round + 1;
    const def = this.roundOrder[Math.min(nextRound, this.roundOrder.length) - 1]
      || ARENA_ROUNDS[ARENA_ROUNDS.length - 1];
    this.nextPlan = { round: nextRound, def, mods: this.#drawMods(nextRound) };
    this.offers = {};
    if (!this.runRandom) {
      this.endTimer = 3;
      this.offers = null;
      this.pendingOffer = [];
      return;
    }
    for (const [id, p] of this.players) {
      const owned = id === this.myId || p.ai ? this.#ownedCounts(this.#stats(id).cards) : {};
      const offer = pickCardOffers(owned, this.rng, 3);
      if (p.ai) {
        // AI 当场吃完，不需要过场 UI
        const pick = offer[Math.floor(Math.random() * offer.length)];
        if (pick) this.#applyCard(id, pick);
      } else {
        this.offers[id] = offer;
      }
    }
    this.pendingOffer = this.#sanitizeOffer(this.offers[this.myId] || []);
    this.endTimer = 8;
  }

  #ownedCounts(cards) {
    const out = {};
    for (const c of cards) out[c] = (out[c] || 0) + 1;
    return out;
  }

  #openCards(offer) {
    if (typeof document === 'undefined') return;
    const list = this.#sanitizeOffer(offer);
    if (!list.length) return;
    this.#closeCards();
    this.pendingOffer = list;
    this.cardChosen = null;
    const cards = list.map((id) => {
      const d = ARENA_CARD_BY_ID.get(id);
      const owned = this.#stats(this.myId).cards.filter((c) => c === id).length;
      return `<button class="arc-card ${d.rarity}" data-id="${id}">
        <span class="arc-cat">${ARENA_CARD_CATS[d.cat] || ''}</span>
        <span class="arc-name">${d.name}</span>
        <span class="arc-desc">${d.desc}</span>
        <span class="arc-max">已选 ${owned} / ${d.max}</span>
      </button>`;
    }).join('');
    const el = document.createElement('div');
    el.id = 'arena-cards';
    el.innerHTML = `<div class="arc-panel">
      <div class="arc-head">第 ${this.round} 关结束 · 三选一</div>
      <div class="arc-row">${cards}</div>
      <div class="arc-foot">选择一张强化 · 时间结束自动选择</div>
    </div>`;
    document.body.appendChild(el);
    this.cardsEl = el;
    for (const b of el.querySelectorAll('.arc-card')) {
      b.addEventListener('click', () => this.#chooseCard(b.dataset.id));
    }
  }

  #chooseCard(id) {
    if (this.cardChosen || !this.pendingOffer.includes(id)) return;
    if (!this.#applyCard(this.myId, id)) return;
    this.cardChosen = id;
    const el = this.cardsEl;
    if (el) {
      for (const b of el.querySelectorAll('.arc-card')) {
        b.classList.toggle('picked', b.dataset.id === id);
        b.disabled = true;
      }
      const foot = el.querySelector('.arc-foot');
      if (foot) foot.textContent = '已选择 · 等待下一关';
    }
    setTimeout(() => this.#closeCards(), 650);
  }

  #autoPickCard() {
    if (!this.pendingOffer.length) return;
    const id = this.pendingOffer[Math.floor(Math.random() * this.pendingOffer.length)];
    if (this.#applyCard(this.myId, id)) this.cardChosen = id;
  }

  /** 双核词缀下，两个核心并排放在 ±5.5m 两条独立轨道 */
  #deliveryCores() {
    if (!this.delivery) return [];
    if (this.#hasMod('twin_core')) {
      return [
        { x: -5.5, z: this.delivery.z || 0, key: 'z' },
        { x: 5.5, z: this.delivery.z2 || 0, key: 'z2' },
      ];
    }
    return [{ x: 0, z: this.delivery.z || 0, key: 'z' }];
  }

  /** 超时/加时判定时，取推进得更远的那个核心 */
  #leadCoreKey() {
    const st = this.delivery;
    if (!st) return 'z';
    if (this.#hasMod('twin_core') && Math.abs(st.z2 || 0) > Math.abs(st.z || 0)) return 'z2';
    return 'z';
  }

  #closeCards() {
    const el = this.cardsEl;
    this.cardsEl = null;
    if (!el) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }

  /** 闪击：预警圈（房主与客机都显示） */
  #showThunder(dur = 1.2) {
    try {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffd35a, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(11.4, 12, 64), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.14;
      this.scene.add(ring);
      this.thunders.push({ ring, t: 0, dur });
    } catch { /* 场景已销毁 */ }
    this.fx?.play('minionWaterSplash', 0, 3, 0, 1.8);
  }

  #tickThunder(dt) {
    for (let i = this.thunders.length - 1; i >= 0; i--) {
      const th = this.thunders[i];
      th.t += dt;
      const k = Math.min(1, th.t / th.dur);
      th.ring.material.opacity = 0.2 + 0.55 * (1 - k);
      th.ring.scale.setScalar(0.92 + 0.12 * k);
      if (th.t >= th.dur) {
        this.scene.remove(th.ring);
        th.ring.geometry.dispose();
        th.ring.material.dispose();
        this.thunders.splice(i, 1);
      }
    }
    if (!this.isHost || this.phase !== 'fight') return;
    this.thunderT -= dt;
    if (this.thunderT <= 0) {
      this.thunderT = 30;
      this.net?.send({ t: 'arenaSkill', kind: 'thunder', from: this.myId, x: 0, z: 0, r: 12 });
      this.#showThunder(1.2);
      this.thunderPending = 1.2;
    }
    if (this.thunderPending > 0) {
      this.thunderPending -= dt;
      if (this.thunderPending <= 0) {
        for (const [id, p] of this.players) {
          if (!p.alive) continue;
          const b = this.#boat(id);
          if (!b) continue;
          if (Math.hypot(b.pos.x, b.pos.z) <= 12) continue;
          this.#damage(id, 30, null, b.pos.x, b.pos.z);
        }
        this.hitStop = Math.max(this.hitStop, 0.05);
      }
    }
  }

  /** 房主在前 9 秒反复广播第 1 关的关卡顺序与词缀，客机收到后锁定 */
  #syncMods(dt) {
    if (this.solo || !this.net || !this.isHost) return;
    if (this.runT > 9) return;
    this.syncT -= dt;
    if (this.syncT > 0) return;
    this.syncT = 0.6;
    this.net.send({
      t: 'arenaSkill', kind: 'sync', from: this.myId, round: 1,
      order: this.roundOrder.map((d) => d.key),
      mods: this.mods,
    });
  }

  #applySync(e) {
    if (this.synced) return;
    this.synced = true;
    if (Array.isArray(e.order)) {
      const byKey = new Map(ARENA_ROUNDS.map((d) => [d.key, d]));
      const next = e.order.map((k) => byKey.get(k)).filter(Boolean);
      if (next.length === ARENA_ROUNDS.length) this.roundOrder = next;
    }
    if (Array.isArray(e.mods)) {
      this.mods = e.mods.filter((id) => ARENA_MODIFIER_BY_ID.has(id));
    }
    this.roundTime = this.#hasMod('short_clock') ? 60 : ARENA_RULES.ROUND_TIME;
    this.#applyRoundKind();
    this.#renderIntroMods();
    this.#renderRunUi();
  }

  #makeWeapons(ownerId, targetId) {
    const foe = () => this.#boat(targetId);
    const foeAlive = () => {
      const p = this.#player(targetId);
      return !!p?.alive && this.phase === 'fight';
    };
    // 代理只建一次：BoatWeapons 每帧会问好几遍，不能每次都 new
    const proxy = makeTargetProxy(foe, foeAlive, 2.4);
    return new BoatWeapons(this.scene, {
      fx: this.fx,
      turretYaw: ARENA_RULES.TURRET_YAW,
      getBoss: () => proxy,
      // 浮岩挡弹道：这是把「对轰」变成「空间博弈」的关键。
      // 之前给的是空数组，结果双方视线永远通畅，只能隔着固定距离比谁 DPS 高。
      getObstacles: () => this.arena?.rocks || EMPTY,
      getMinions: () => EMPTY,
      onHit: (dmg, x, z) => this.#weaponHit(ownerId, targetId, dmg, x, z),
      onImpact: () => {},
    });
  }

  // ---------------------------------------------------------------- 回合流程

  #placeAll() {
    for (const id of this.spawns.keys()) this.#placeOne(id);
  }

  /**
   * 摆回出生点。必须走 `boat.resetTo()`：它会把 prevPos / vel / thrustState 一起清零。
   * 只改 pos 的话 prevPos 还留在上一个位置，船的插值与物理会把这段位移当成速度，
   * 开局就朝外漂（实测漂了 7.8m 才被水阻吃掉）。
   */
  #placeOne(id) {
    const boat = this.#boat(id);
    const sp = this.spawns.get(id);
    if (!boat || !sp) return;
    // 擂台关的圈只有 45m，出生点却是 SPAWN_R=46m：按原坐标放人等于把人放在圈外，
    // 进入 fight 的第一帧就会被判"撞出擂台"（实测第 2 关开局直接失分，复活也立刻再判一次）。
    // 这里把擂台关的出生点收进圈内，其余关卡不受影响。
    let { x, z } = sp;
    if (this.roundKind === 'ringout') {
      // 出生点收到圈内 60% 处：既不会开局判出圈，也留出足够的纵深，
      // 不至于一上来就背贴圈边被对手顶着撞出去。
      const limit = this.ringoutR * 0.6;
      const d = Math.hypot(x, z);
      if (d > limit) {
        x = (x / d) * limit;
        z = (z / d) * limit;
      }
    }
    if (typeof boat.resetTo === 'function') {
      boat.resetTo(x, z, sp.heading);
      return;
    }
    // 兜底：没有 resetTo 的实现也要把速度相关状态清干净
    boat.pos.set?.(x, 0, z) ?? ((boat.pos.x = x), (boat.pos.z = z));
    boat.prevPos?.set?.(x, 0, z);
    boat.vel?.set?.(0, 0);
    boat.pos.y = 0;
    boat.heading = sp.heading;
    boat.speed = 0;
    boat.thrustState = 0;
    boat.angVel = 0;
    boat.stunTimer = 0;
    boat.sinkTimer = 0;
    boat.spinTimer = 0;
    boat.bubbleLiftTimer = 0;
  }

  /**
   * 新一关：按关卡类型重置血量/命数/计分/场景，并播「第 X 关：名字」过场卡。
   * 第 1 关的标题卡 + 镜头在构造时已经建好，这里只负责第 2/3 关。
   */
  #startRound() {
    const R = ARENA_RULES;
    // 下一关由房主在 #endRound 里抽好（顺序 + 词缀），客机吃 arenaRound 里的 next
    const plan = this.nextPlan;
    this.roundDef = plan?.def
      || this.roundOrder[Math.min(this.round, this.roundOrder.length) - 1]
      || ARENA_ROUNDS[0];
    if (plan?.mods) this.mods = plan.mods;
    this.roundKind = this.roundDef.key;
    this.matchEndNotified = false;
    this.deathHit = null;
    this.timeoutHandled = false;
    // 命数：只有决斗关是一条命；运送/擂台关被打沉只是短暂回场，不淘汰
    const lives = this.roundKind === 'duel' ? 1 : 99;
    for (const p of this.players.values()) {
      p.hp = R.MAX_HP;
      p.lives = lives;
      p.alive = true;
      p.respawn = 0;
      p.invuln = 0.6;
      p.ringScore = 0;
      p.outTick = 0;
    }
    this.phase = 'countdown';
    this.countdown = R.COUNTDOWN_FAST;
    this.roundTime = this.#hasMod('short_clock') ? 60 : R.ROUND_TIME;
    this.#placeAll();
    for (const w of this.weapons.values()) w.clear();
    // 关卡状态归零：核心回中、决斗圈从 50m 重新收
    this.delivery = { z: 0, z2: 0, me: 0, foe: 0, overtime: false, otStart: 0 };
    this.duelT = 0;
    this.duelTick = 0;
    this.blockState = { energy: 1, overheat: 0, delay: 0, active: false };
    // 闪击计时与残留预警圈
    this.thunderT = 30;
    this.thunderPending = 0;
    for (const th of this.thunders) {
      this.scene.remove(th.ring);
      th.ring.geometry.dispose();
      th.ring.material.dispose();
    }
    this.thunders.length = 0;
    this.nextPlan = null;
    // 技能冷却与未落地的大招一起清掉，否则开局就有人顶着上一局的预警圈
    for (const st of this.skills?.values() || []) { st.dashCd = 0; st.ultCd = 0; }
    for (const u of this.ults) {
      this.scene.remove(u.ring);
      u.ring.geometry.dispose();
      u.ring.material.dispose();
    }
    this.ults.length = 0;
    // 道具栏与箱子也回满：上一局的墨汁/减速状态不该带进新一局
    if (this.items) {
      this.items.myItems = [null, null, null];
      this.items.aiItems.clear();
      for (const b of this.items.boxes) { b.active = true; b.respawn = 0; }
    }
    this.#applyRoundKind();
    // 卡牌的持续效果（航速/转向/射速）跨关保留；赌徒每关重新摇一次
    for (const [id, p] of this.players) {
      if (p.ai || id === this.myId) this.#applyGambler(id);
    }
    this.#refreshAllBoatStats();
    this.#grantStarters();
    this.#closeCards();
    this.pendingOffer = [];
    this.cardChosen = null;
    this.#renderRunUi();

    // 过场卡：要求「每关之间」都播，且期间 HUD 全部收起。
    // 第 1 关已经在构造时建过一张，这里只处理第 2 关起。
    if (this.introEl) {
      this.introEl.remove();
      this.introEl = null;
      document.body?.classList?.remove('intro-on');
    }
    this.cinema = 0;
    this.intro = skipCinemaByUrl() ? 0 : R.ROUND_CARD_TIME;
    this.introEl = this.intro > 0 ? this.#makeIntroOverlay(this.round, this.roundDef) : null;
    this.#syncHud();
    const modNames = this.mods.map((id) => ARENA_MODIFIER_BY_ID.get(id)?.name).filter(Boolean).join(' / ');
    this.onToast?.(`第 ${this.round} 关 · ${this.roundDef.name}${modNames ? ` · ${modNames}` : ''}`);
  }

  #endRound(winnerId, reason = '') {
    if (this.phase !== 'fight') return;   // 防重入：本地与广播可能在同一帧各判一次
    if (winnerId) {
      const p = this.#player(winnerId);
      if (p) p.score += 1;
    }
    this.lastRoundWinner = winnerId;
    this.lastRoundReason = reason;
    this.phase = 'roundEnd';
    this.endTimer = 3;
    this.offers = null;
    this.pendingOffer = [];

    const me = this.#player(this.myId);
    const need = ARENA_RULES.ROUNDS_TO_WIN;
    if (me && me.score >= need) this.matchWinner = this.myId;
    for (const p of this.players.values()) {
      if (p.score >= need) this.matchWinner = p.id;
    }
    // 最后一关打平（1:1 进第 3 关、第 3 关又平）：按剩余血量 → 承伤少者判胜。
    // 必须收口，否则三关打完没人到 2 分，比赛永远不结束。
    if (!this.matchWinner && this.round >= ARENA_ROUNDS.length && this.isHost) {
      const list = [...this.players.values()].sort(
        (a, b) => (b.hp - a.hp) || (a.taken - b.taken),
      );
      this.matchWinner = list[0]?.id || this.myId;
      if (this.#player(this.matchWinner)) this.#player(this.matchWinner).score += 1;
      reason = reason || '血量判定';
    }
    if (this.matchWinner) {
      this.phase = 'matchEnd';
      this.#closeCards();
      const won = this.matchWinner === this.myId;
      this.onToast?.(won ? '🏆 你赢下了这场对决' : '💀 这局输了，再来一次');
      this.#notifyMatchEnd();
    } else {
      const name = this.#player(winnerId)?.name || '平局';
      this.onToast?.(winnerId ? `${name} 拿下本关` : '本关平手');
      // 关卡之间：房主抽下一关的顺序/词缀 + 所有人的三选一候选
      this.#planNextRound();
      if (this.pendingOffer.length) this.#openCards(this.pendingOffer);
    }
    // 房主统一切回合，客机不能自己判（否则两边可能同时宣布自己赢）
    if (this.isHost) this.#netRound();
  }

  /** 整场结束只通知一次（房主本地判胜、客机吃 arenaRound 都会走到这里） */
  #notifyMatchEnd() {
    if (!this.matchWinner || this.matchEndNotified) return;
    this.matchEndNotified = true;
    const me = this.#player(this.myId);
    const foe = [...this.players.values()].find((p) => p.id !== this.myId) || null;
    this.onMatchEnd?.({
      won: this.matchWinner === this.myId,
      myScore: me?.score || 0,
      foeScore: foe?.score || 0,
      foeName: foe?.name || '对手',
      rounds: ARENA_RULES.ROUNDS_TO_WIN,
    });
  }

  #netRound() {
    if (this.solo || !this.net) return;
    const s = {};
    for (const [id, p] of this.players) s[id] = p.score;
    this.net.send({
      t: 'arenaRound',
      round: this.round,
      winner: this.lastRoundWinner,
      phase: this.phase,
      matchWinner: this.matchWinner,
      s,
      endTimer: this.endTimer,
      next: this.nextPlan
        ? { round: this.nextPlan.round, key: this.nextPlan.def.key, mods: this.nextPlan.mods }
        : null,
      offers: this.offers,
    });
  }

  #applyRound(e) {
    if (e.s) {
      for (const [id, n] of Object.entries(e.s)) {
        const p = this.#player(id);
        if (p) p.score = n;
      }
    }
    this.lastRoundWinner = e.winner || null;
    this.matchWinner = e.matchWinner || null;
    this.phase = e.phase === 'matchEnd' ? 'matchEnd' : 'roundEnd';
    this.endTimer = Number(e.endTimer) || 3;
    this.nextPlan = e.next
      ? {
        round: e.next.round,
        def: ARENA_ROUNDS.find((d) => d.key === e.next.key) || this.roundDef,
        mods: Array.isArray(e.next.mods) ? e.next.mods.filter((id) => ARENA_MODIFIER_BY_ID.has(id)) : [],
      }
      : null;
    this.offers = e.offers || null;
    this.pendingOffer = this.#sanitizeOffer(e.offers?.[this.myId] || []);
    if (e.phase === 'matchEnd') {
      this.#closeCards();
      const won = this.matchWinner === this.myId;
      this.onToast?.(won ? '🏆 你赢下了这场对决' : '💀 这局输了，再来一次');
      this.#notifyMatchEnd();
    } else {
      const name = this.#player(this.lastRoundWinner)?.name || '平局';
      this.onToast?.(this.lastRoundWinner ? `${name} 拿下本关` : '本关平手');
      if (this.pendingOffer.length) this.#openCards(this.pendingOffer);
    }
  }

  // ---------------------------------------------------------------- 伤害

  #weaponHit(fromId, toId, dmg, x, z) {
    const dr = this.#derived(this.#stats(fromId));
    let d = dmg * dr.dmgMul;
    if (dr.critChance > 0 && Math.random() < dr.critChance) d *= 2;
    if (dr.sideMul > 1 && this.#isSideHit(fromId, toId)) d *= dr.sideMul;
    this.#damage(toId, d, fromId, x, z);
    this.hitStop = Math.max(this.hitStop, 0.055);
  }

  /** 侧舷猎手：从目标侧后方 120° 内命中 */
  #isSideHit(fromId, toId) {
    const a = this.#boat(fromId);
    const b = this.#boat(toId);
    if (!a || !b) return false;
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const dot = (dx * Math.sin(b.heading || 0) + dz * Math.cos(b.heading || 0)) / d;
    return dot < 0.5;
  }

  /**
   * 受击方权威：只有「挨打的那个人」真正扣自己的血，扣完广播 `arenaHp`。
   * 这样射击方不需要猜对方剩多少血，也避免了双方同时扣血导致的数值打架。
   */
  #damage(id, dmg, fromId, x, z) {
    const p = this.#player(id);
    if (!p || !p.alive || this.phase !== 'fight') return;
    if (p.invuln > 0) return;
    const mine = p.ai || id === this.myId;
    if (!mine) {
      // 目标是远端玩家：把伤害发给他，由他自己结算
      this.net?.send({ t: 'arenaDmg', to: id, dmg: Math.round(dmg), from: fromId, x, z });
      return;
    }
    this.#applyDamage(id, dmg, fromId, x, z);
  }

  #applyDamage(id, dmg, fromId, x, z) {
    const p = this.#player(id);
    if (!p || !p.alive || p.invuln > 0) return;
    // 第 3 关定向格挡：只有「自己这端」模拟的盾能挡（远端开盾由远端自己判）
    if (this.roundKind === 'duel' && id === this.myId && fromId) {
      const bs = this.blockState;
      const b = this.#boat(id);
      const src = this.#boat(fromId);
      if (bs?.active && bs.energy > 0 && b && src) {
        const dx = src.pos.x - b.pos.x;
        const dz = src.pos.z - b.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const dot = (dx * Math.sin(b.heading || 0) + dz * Math.cos(b.heading || 0)) / d;
        if (dot >= Math.cos(ARENA_DUEL.BLOCK_ANGLE)) {
          bs.energy = Math.max(0, bs.energy - ARENA_DUEL.BLOCK_HIT_COST);
          this.fx?.play('toonHit', x ?? b.pos.x, 1.5, z ?? b.pos.z, 0.9);
          this.hitStop = Math.max(this.hitStop, 0.03);
          return;   // 完全挡下：不掉血、不飘字
        }
      }
    }
    // 受击方结算减伤：装甲板、血怒、玻璃大炮都在这里生效
    const rs = this.#stats(id);
    const dr = this.#derived(rs);
    const finalDmg = Math.max(1, dmg * dr.takenMul);
    // 复活类卡牌：先于「击沉」判定触发
    if (p.hp - finalDmg <= 0 && (rs.revive > 0 || rs.rewind > 0)) {
      const rewind = rs.rewind > 0;
      if (rewind) rs.rewind -= 1;
      else rs.revive -= 1;
      p.hp = ARENA_RULES.MAX_HP;
      p.alive = true;
      p.invuln = rewind ? 2.5 : 2;
      if (rewind) this.#placeOne(id);
      this.fx?.play('minionWaterSplash', x ?? this.#boat(id)?.pos.x ?? 0, 1.5, z ?? this.#boat(id)?.pos.z ?? 0, 1.1);
      if (id === this.myId) {
        this.onToast?.(rewind ? '时间回溯 · 满血回到出生点' : '海神庇佑 · 满血复活');
      }
      if (this.net && !p.ai) {
        this.net.send({ t: 'arenaHp', id, hp: Math.round(p.hp), lives: p.lives, alive: p.alive });
      }
      return;
    }
    p.hp = Math.max(0, p.hp - finalDmg);
    const bar = this.hpBars.get(id);
    if (bar) bar.flash = 0.22;
    // 伤害飘字：这是"打中了"唯一的正反馈，没有它就是干巴巴的互射
    if (x != null && z != null) this.#spawnDmgText(x, z, finalDmg);
    const shooter = this.#player(fromId);
    if (shooter) shooter.taken += finalDmg;

    if (p.hp <= 0) {
      p.alive = false;
      // 只有决斗关扣命；运送/擂台关被打沉只是短暂回场
      const duel = this.roundKind === 'duel';
      if (duel) p.lives -= 1;
      p.respawn = duel
        ? Math.max(1.2, ARENA_RULES.RESPAWN - rs.respawnCut)
        : Math.max(1.6, 3.2 - rs.respawnCut);
      // 记最后一击：{@link hudData} 里只有在"我死了"的时候才吐出去
      this.deathHit = {
        source: this.#player(fromId)?.name || '对手',
        dmg: Math.round(finalDmg),
        from: fromId || null,
        ringOut: false,
      };
      const boat = this.#boat(id);
      if (boat) boat.sinkTimer = Math.max(boat.sinkTimer || 0, 1.4);
      this.onToast?.(id === this.myId ? '💀 你被击沉了' : `🎯 击沉了 ${p.name}`);
      // 血量/命数必须先发出去：房主要靠这条消息才能知道"客机命打光了"
      if (this.net && !p.ai) {
        this.net.send({ t: 'arenaHp', id, hp: Math.round(p.hp), lives: p.lives, alive: p.alive });
      }
      if (duel && p.lives <= 0 && this.isHost) {
        const winner = [...this.players.values()].find((q) => q.id !== id);
        this.#endRound(winner?.id || null, '击沉对手');
      }
      return;
    }
    // 远端玩家/自己都广播血量，让两边血条一致
    if (this.net && !p.ai) {
      this.net.send({ t: 'arenaHp', id, hp: Math.round(p.hp), lives: p.lives, alive: p.alive });
    }
  }

  // ---------------------------------------------------------------- 接口：对齐 BossMode

  canControl() {
    const me = this.#player(this.myId);
    return this.phase === 'fight' && !!me?.alive;
  }

  /** 竞技场不需要改写输入：方向就是船头方向，走位即瞄准 */
  driveBoat(dt, rawInput) {
    return rawInput;
  }

  /**
   * 圆形边界由 Boat.updateLocal 的 mapDef.boundary 处理。
   * 这里补一件事：**浮岩要挡船**。炮能打不穿、船又能撞上去，"绕柱躲弹"才成立；
   * 只挡弹不挡船的话，玩家会直接开到石头里当掩体。
   */
  constrainBoat(boat) {
    if (!boat) return;
    // 运送关：潮汐核心是实体，船会被顶开 —— 否则玩家会直接从核心中间穿过去，
    // 看起来不像在推东西，而像在推一团空气。
    if (this.roundKind === 'delivery' && this.delivery) {
      const min = ARENA_DELIVERY.CORE_R + 2.2;
      for (const core of this.#deliveryCores()) {
        const dx = boat.pos.x - core.x;
        const dz = boat.pos.z - core.z;
        const d = Math.hypot(dx, dz);
        if (d < min && d > 1e-3) {
          boat.pos.x = core.x + (dx / d) * min;
          boat.pos.z = core.z + (dz / d) * min;
          if (boat.speed > 0) boat.speed *= 0.92;   // 顶着核心走会被"磨"掉一点速度
        }
      }
    }
    const rocks = this.arena?.rocks;
    if (!rocks?.length) return;
    for (const r of rocks) {
      const dx = boat.pos.x - r.x;
      const dz = boat.pos.z - r.z;
      const d = Math.hypot(dx, dz);
      const min = r.r + 2.6;   // 岩石半径 + 船半宽
      if (d < min && d > 1e-3) {
        boat.pos.x = r.x + (dx / d) * min;
        boat.pos.z = r.z + (dz / d) * min;
        // 撞上去要掉速，否则贴着石头蹭过去没有任何代价
        if (boat.speed > 0) boat.speed *= 0.55;
      }
    }
  }

  getLockTarget() { return null; }

  /**
   * 开场动画相机路径：高空俯瞰 → 压向场内 → 沿看台内侧环扫 → 贴到自己船尾。
   * 只在构造时算一次（出生点已知），两端各自 deterministic，联机不需要额外同步。
   */
  #buildCinemaPath() {
    const R = ARENA_RULES;
    const sp = this.spawns.get(this.myId) || { x: 0, z: R.SPAWN_R };
    // 结尾机位：自己船尾后上方（距离 13m），追尾相机从这里平滑接管
    const d = Math.hypot(sp.x, sp.z) || 1;
    const end = new THREE.Vector3(sp.x * (1 + 13 / d), 6.5, sp.z * (1 + 13 / d));
    // 看台环扫段：贴着看台内侧（看台内切圆 ≈105m，取 88m 高 8~11m）从对手侧扫回自己侧
    const a0 = Math.atan2(sp.z, sp.x);       // 自己出生点的方位角
    const sweep = (ang, h) => new THREE.Vector3(Math.cos(ang) * 88, h, Math.sin(ang) * 88);
    this.cinemaCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 58, 148),         // 高空俯瞰
      new THREE.Vector3(0, 30, 98),          // 压向场内
      sweep(a0 + 2.4, 11),                   // 绕到对手后侧看台
      sweep(a0 + 1.2, 9),                    // 沿看台环扫
      sweep(a0 + 0.35, 8),                   // 掠过自己这侧看台
      end,
    ], false, 'catmullrom', 0.35);
  }

  /**
   * 关卡过场卡（纯 DOM，dispose 时摘除）。
   *
   * 视觉：整屏背景模糊压暗 → 正中「第 X 关：名字」逐字跳入 → 橙红细线 → 关卡目标。
   * 第 1 关之后镜头不动（追尾相机照常跟船），所以卡结束时把模糊一撤，
   * 玩家看到的就是自己船已经在场上 —— 这就是"字体跳完后显示游戏场景，背景变正常"。
   * 同时给 body 挂 `intro-on`：整段过场期间常驻 HUD、聊天、按钮全部收起来。
   * 样式写在 index.html 的 `/* arena-intro *\/` 块里（作用域 #arena-intro）。
   */
  #makeIntroOverlay(roundNo = 1, def = this.roundDef) {
    try {
      const el = document.createElement('div');
      el.id = 'arena-intro';
      // 逐字拆 span：每个字一个 animation-delay，读起来就是"字体一个一个跳出来"
      const title = `第 ${roundNo} 关：${def?.name || ''}`;
      const chars = [...title].map((ch, i) => {
        const safe = ch === ' ' ? '&nbsp;' : ch;
        return `<span style="animation-delay:${Math.round(i * 42)}ms">${safe}</span>`;
      }).join('');
      const mods = this.mods.map((id) => ARENA_MODIFIER_BY_ID.get(id)).filter(Boolean);
      const modsHtml = mods.length
        ? `<div class="ai-mods">${mods.map((m) => (
          `<span class="ai-mod s${m.stars}"><i>${'★'.repeat(m.stars)}</i>${m.name}<em>${m.desc}</em></span>`
        )).join('')}</div>`
        : '<div class="ai-mods" style="display:none"></div>';
      el.innerHTML = [
        '<div class="ai-veil"></div>',
        '<div class="ai-card">',
        `<div class="ai-title">${chars}</div>`,
        '<div class="ai-rule"></div>',
        `<div class="ai-sub">${def?.hint || ''}</div>`,
        modsHtml,
        '</div>',
        `<div class="ai-foot">${roundNo === 1 ? '潮汐竞技场 · 三局两胜' : (def?.tip || '')}</div>`,
        '<div class="ai-count"></div>',
      ].join('');
      document.body.appendChild(el);
      document.body.classList.add('intro-on');
      return el;
    } catch { return null; }
  }

  /** 过场卡计时：最后 0.9s 淡出模糊与大字，归零后进倒计时（第 1 关进镜头飞行段） */
  #tickIntro() {
    const el = this.introEl;
    if (!el) return;
    el.classList.toggle('ai-out', this.intro <= 0.9);
  }

  /** 镜头飞行最后 3 秒的大号 3-2-1（HUD 此时还收着，所以单独画一个） */
  #tickIntroCount(sec) {
    const el = this.introEl;
    if (!el) return;
    const c = el.querySelector('.ai-count');
    if (!c) return;
    el.classList.add('ai-counting');
    const n = String(Math.max(1, Math.ceil(sec)));
    if (c.dataset.n === n) return;
    c.dataset.n = n;
    c.textContent = n;
    c.classList.remove('pop');
    void c.offsetWidth;          // 强制重排，同一个 class 才能反复触发动画
    c.classList.add('pop');
  }

  /** 进战：摘掉开场浮层，把常驻 HUD 淡回来 */
  #endIntro() {
    const el = this.introEl;
    this.introEl = null;
    document.body.classList.remove('intro-on');
    if (!el) return;
    el.classList.add('ai-done');
    setTimeout(() => el.remove(), 600);
  }

  /** 实时比分快照：竞技场看台的比分牌（ArenaStadium）每 0.5s 拉一次 */
  getScoreboard() {
    const me = this.#player(this.myId);
    const foe = this.#player(this.foeId);
    return {
      myName: me?.name || '你',
      foeName: foe?.name || '对手',
      myScore: me?.score || 0,
      foeScore: foe?.score || 0,
      myHp: me ? me.hp / ARENA_RULES.MAX_HP : 1,
      foeHp: foe ? foe.hp / ARENA_RULES.MAX_HP : 1,
      round: this.round,
      phase: this.phase,
    };
  }

  /**
   * 阵亡观战镜头（返回 true 表示本帧由我接管相机）。
   *
   * 为什么必须接管：默认追尾相机是跟着**自己的船**的，而船沉没时会下沉到 y=-2.6，
   * 相机会跟着钻进水面以下 —— 水下滤镜一开，屏幕立刻是一片蓝雾，
   * 玩家看到的就是"卡死了"。改成从沉船点抬起来俯看双方，既不会入水，
   * 也能看清对手接下来往哪走（毕竟 4 秒后就要复活的）。
   */
  updateCamera(camera, dt) {
    // 标题卡：镜头停在镜头路径起点附近做极缓的「呼吸」（起止位移都是 0，
    // 所以标题卡结束时切进飞行段不会有一下跳动），背景由 #arena-intro 的
    // backdrop-filter 负责模糊。
    // 第 2/3 关没有镜头飞行（cinemaCurve 为空）：这里返回 false，交给追尾相机，
    // 过场卡期间照样能透过模糊看到自己的船。
    if (this.intro > 0 && this.cinemaCurve && this.phase === 'countdown') {
      const q = Math.min(1, Math.max(0, 1 - this.intro / ARENA_RULES.INTRO_TIME));
      // 呼吸感的「推进再退回」：q=0 和 q=1 时系数都回到 1，所以切进镜头飞行段不跳
      const b = Math.sin(q * Math.PI);
      this.cinemaCurve.getPointAt(0, this.camPos);
      camera.position.set(
        this.camPos.x * (1 - 0.18 * b),
        this.camPos.y * (1 - 0.16 * b),
        this.camPos.z * (1 - 0.18 * b),
      );
      camera.lookAt(0, 2 + 5 * b, 0);
      return true;
    }
    // 开场镜头：相机走固定路径（俯瞰→场内→环看台→贴船），期间完全接管
    if (this.cinema > 0 && this.phase === 'countdown') {
      const p = 1 - this.cinema / ARENA_RULES.CINEMA_TIME;   // 0 → 1
      const u = p * p * (3 - 2 * p);                          // smoothstep：起止两端不突兀
      this.cinemaCurve.getPointAt(Math.min(0.999, u), this.camPos);
      camera.position.copy(this.camPos);
      // 注视点：前 70% 看场心，后 30% 渐渐转向自己的船，结尾正好接上追尾机位的注视点
      const boat = this.#boat(this.myId);
      const k = Math.max(0, Math.min(1, (p - 0.7) / 0.3));
      const bx = boat?.pos.x ?? 0;
      const bz = boat?.pos.z ?? 0;
      this.camLook.set(bx * k, 2 * (1 - k) + 1.2 * k, bz * k);
      camera.lookAt(this.camLook);
      return true;
    }
    const me = this.#player(this.myId);
    if (me?.alive) { this.camLookInit = false; return false; }
    const boat = this.#boat(this.myId);
    const ax = boat?.pos.x ?? 0;
    const az = boat?.pos.z ?? 0;
    const foe = this.#foe();
    // 看向"自己沉船点 ↔ 对手"的 55% 处：既不丢掉自己翻船的位置，也把对手框进来
    const lx = foe ? ax * 0.45 + foe.pos.x * 0.55 : ax;
    const lz = foe ? az * 0.45 + foe.pos.z * 0.55 : az;
    // 注视点首帧直接落到目标上再平滑：从 (0,0,0) 插值过去会让镜头先甩一下
    if (!this.camLookInit) { this.camLook.set(lx, 0.8, lz); this.camLookInit = true; }
    const k = 1 - Math.exp(-3.2 * dt);
    this.camPos.set(ax, 9.5, az + 13);
    camera.position.lerp(this.camPos, k);
    this.camPos.set(lx, 0.8, lz);   // 同一个临时向量复用，省一次分配
    this.camLook.lerp(this.camPos, k);
    camera.lookAt(this.camLook);
    return true;
  }

  applyCameraShake() {}

  respawnLocal() {
    const me = this.#player(this.myId);
    if (!me || me.alive || me.lives <= 0 || this.phase !== 'fight') return false;
    me.respawn = 0;
    me.hp = ARENA_RULES.MAX_HP;
    me.alive = true;
    me.invuln = 1.2;
    this.#placeOne(this.myId);
    this.deathHit = null;
    this.onRespawn?.();
    return true;
  }

  /** 某个玩家的对手（1v1 里就是另一个人） */
  #rivalOf(id) {
    return this.#boat(id === this.myId ? this.foeId : this.myId);
  }

  #rivalIdOf(id) {
    for (const pid of this.players.keys()) if (pid !== id) return pid;
    return null;
  }

  /** 朝世界坐标点 (tx,tz) 转舵的通用输出，三关 AI 共用 */
  #steerTo(boat, tx, tz, throttle = 1) {
    const want = Math.atan2(tx - boat.pos.x, tz - boat.pos.z);
    let diff = want - boat.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return {
      throttle,
      steer: THREE.MathUtils.clamp(diff * 2.4, -1, 1),
      drift: false,
      nitro: false,
    };
  }

  /** 第 1 关 AI：绕到核心后面，再顶着核心往对手球门推 */
  #driveAiDelivery(boat, p, idle) {
    const st = this.delivery;
    if (!st) return idle;
    const dir = this.deliverySide.get(p.id) || 1;
    // 正确的推球位置在核心「反方向」：dir=+1 的 AI 要站在核心 -z 侧
    const behind = st.z - dir * 8;
    const notBehind = (boat.pos.z - st.z) * dir > 0;   // 站在了球门那一侧
    if (notBehind) {
      // 先绕外侧回到核心后面，别从正面硬顶（正面顶就是给对手送机会）
      const side = boat.pos.x >= 0 ? 1 : -1;
      return this.#steerTo(boat, side * 14, behind, 1);
    }
    const distCore = Math.hypot(boat.pos.x, boat.pos.z - st.z);
    // 已经贴住核心就一路推；还远就直接压过去
    const tz = distCore < ARENA_DELIVERY.PUSH_R + 4 ? st.z + dir * 12 : behind;
    return this.#steerTo(boat, 0, tz, 1);
  }

  /** 第 2 关 AI：直冲玩家；自己快出圈时先回中心 */
  #driveAiRingout(boat, p, foe, idle) {
    const out = Math.hypot(boat.pos.x, boat.pos.z);
    if (out > this.ringoutR - 6) {
      return this.#steerTo(boat, 0, 0, 1);
    }
    return this.#steerTo(boat, foe.pos.x, foe.pos.z, 1);
  }

  /**
   * AI 走位：**绕圈缠斗**，不是迎面对冲。
   *
   * 之前的写法是"船头指向对手 + 保持 30m"，配合小炮塔角就变成两座固定炮台对射。
   * 现在改成瞄准「对手周围的切向点」：船会绕着对手跑，天然产生横向速度，
   * 配合没有提前量预测的炮口，双方都会打空一部分 —— 这才有躲闪的空间。
   */
  driveAi(dt, boat, id) {
    const idle = { throttle: 0, steer: 0, drift: false, nitro: false };
    const p = this.#player(id);
    if (!boat || !p?.alive || this.phase !== 'fight') return idle;
    // 注意：目标必须是「这个 AI 的对手」，不能直接取 this.foeId——
    // foeId 是「本机玩家的对手」，对 AI 来说那就是它自己，距离恒为 0，
    // 结果它会一直倒车往边界外开（实测开局倒退 7.8m）。
    const foe = this.#rivalOf(id);
    if (!foe || foe === boat) return idle;

    // 前两关各有自己的目标，第 3 关继续用绕圈缠斗
    if (this.roundKind === 'delivery') return this.#driveAiDelivery(boat, p, idle);
    if (this.roundKind === 'ringout') return this.#driveAiRingout(boat, p, foe, idle);

    const dx = foe.pos.x - boat.pos.x;
    const dz = foe.pos.z - boat.pos.z;
    const d = Math.hypot(dx, dz) || 1;

    // 每隔几秒换一次绕行方向，免得玩家背下来"它总是逆时针"
    p.orbitT = (p.orbitT || 0) - dt;
    if (p.orbitT <= 0) { p.orbitT = 4 + Math.random() * 3; p.orbit = Math.random() < 0.5 ? -1 : 1; }
    const orbit = p.orbit || 1;

    // 切向单位向量（垂直于"我→对手"这条线）
    const tx = -dz / d;
    const tz = dx / d;
    const R = 28;                       // 目标环绕半径
    let aimX = foe.pos.x + tx * R * orbit;
    let aimZ = foe.pos.z + tz * R * orbit;

    // 绕圈时别一头撞进浮岩：把附近石头当成斥力源叠加到目标点上
    const rocks = this.arena?.rocks;
    if (rocks?.length) {
      for (const r of rocks) {
        const rx = boat.pos.x - r.x;
        const rz = boat.pos.z - r.z;
        const rd = Math.hypot(rx, rz);
        const safe = r.r + 10;
        if (rd < safe && rd > 0.01) {
          const w = ((safe - rd) / safe) * 28;
          aimX += (rx / rd) * w;
          aimZ += (rz / rd) * w;
        }
      }
    }
    // 缩圈关：绕行点不能落在圈外，否则 AI 会自己跑进毒圈送血
    if (this.roundKind === 'duel') {
      const ar = Math.hypot(aimX, aimZ);
      const lim = Math.max(6, this.ring - 8);
      if (ar > lim) {
        aimX = (aimX / ar) * lim;
        aimZ = (aimZ / ar) * lim;
      }
    }
    const want = Math.atan2(aimX - boat.pos.x, aimZ - boat.pos.z);

    let diff = want - boat.heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;

    // 保持半径：太远踩满、太近收油（不要倒车——倒车在缠斗里等于白送背身）
    let throttle = 1;
    if (d < R - 8) throttle = 0.45;
    else if (d < R) throttle = 0.75;

    return {
      throttle,
      steer: THREE.MathUtils.clamp(diff * 2.4, -1, 1),
      drift: false,
      nitro: false,
    };
  }

  // ---------------------------------------------------------------- 每帧

  update(dt, elapsed = 0) {
    const R = ARENA_RULES;
    this.runT += dt;
    this.#syncMods(dt);

    if (this.phase === 'countdown') {
      // 开场期间倒计时冻结：先播 INTRO_TIME 秒标题卡，再走 CINEMA_TIME 秒镜头；
      // 镜头最后 3 秒接上 3-2-1，落地即开火，不用额外再干等 3 秒。
      if (this.intro > 0) {
        this.intro = Math.max(0, this.intro - dt);
        this.#tickIntro();
        // 第 2/3 关只有过场卡、没有镜头飞行：卡归零就直接撤掉并把 HUD 放回来
        if (this.intro <= 0 && this.cinema <= 0) this.#endIntro();
      } else if (this.cinema > 0) {
        this.cinema = Math.max(0, this.cinema - dt);
        if (this.cinema <= R.COUNTDOWN) {
          this.countdown = Math.min(this.countdown, this.cinema);
          this.#tickIntroCount(this.cinema);
        }
        if (this.cinema <= 0) {
          // 动画结束瞬间把追尾相机硬切回船尾：开场结尾机位（13m 后上方）和追尾机位
          // 接近但不完全重合，不硬切的话 CameraRig 内部的 heading/高度低通会从旧值
          // 缓慢收敛，第一秒镜头会斜着甩一下
          this.countdown = 0;
          this.onCinemaEnd?.();
          this.#endIntro();
        }
      } else {
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.phase = 'fight';
          this.countdown = 0;
          this.onToast?.('开火！');
        }
      }
    } else if (this.phase === 'fight') {
      this.roundTime = Math.max(0, this.roundTime - dt);
    } else if (this.phase === 'roundEnd') {
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        // 没选卡就自动从候选里拿一张，避免有人挂机卡住整局
        if (this.pendingOffer.length && !this.cardChosen) this.#autoPickCard();
        this.#closeCards();
        this.pendingOffer = [];
        this.round += 1;
        this.#startRound();
      }
    }

    // 闪击词缀：预警圈动画 + 房主 30 秒计时
    if (this.#hasMod('thunder')) this.#tickThunder(dt);

    // 复活倒计时
    for (const p of this.players.values()) {
      if (p.respawn > 0 && !p.alive) {
        p.respawn -= dt;
        if (p.respawn <= 0) {
          p.respawn = 0;
          p.hp = R.MAX_HP;
          p.alive = true;
          p.invuln = 1.2;
          this.#placeOne(p.id);
          if (p.id === this.myId) {
            this.deathHit = null;
            this.onRespawn?.();
            this.onToast?.('⚓ 重返战场 · 1.2s 无敌');
          }
        }
      } else if (p.invuln > 0) {
        p.invuln = Math.max(0, p.invuln - dt);
      }
    }

    // 超时判胜：每关规则不同（运送进加时 / 擂台比撞出数 / 决斗比血量）
    if (this.isHost && this.phase === 'fight' && this.roundTime <= 0 && !this.timeoutHandled) {
      this.timeoutHandled = true;
      if (this.roundKind === 'delivery') this.#deliveryTimeout();
      else if (this.roundKind === 'ringout') this.#ringoutTimeout();
      else this.#duelTimeout();
    }

    // 火炮：本地玩家按 J 开火，AI 自动开火
    for (const [id, weapons] of this.weapons) {
      const boat = this.#boat(id);
      const p = this.#player(id);
      if (!boat || !p) continue;
      if (weapons.def?.id !== boat.def?.id) weapons.setBoat(boat.def);
      // 擂台关锁主炮：这一关的伤害来源只有撞击和道具
      const active = this.phase === 'fight' && p.alive && this.roundKind !== 'ringout';
      let firing = false;
      if (active) {
        if (id === this.myId) firing = !!this.opts.input?.fire;
        else if (p.ai) {
          const foe = this.#rivalOf(id);
          const d = foe ? Math.hypot(foe.pos.x - boat.pos.x, foe.pos.z - boat.pos.z) : 999;
          // AI 在 55m 内就开火，但留一点点节奏，不要变成永不停机的机枪
          firing = d < 55 && Math.sin(elapsed * 1.7 + 1.3) > -0.55;
        }
      }
      weapons.update(dt, boat, { firing, active });
      weapons.updateChargeOrb(boat);
    }

    // 浮岩挡船：Game 只会对本地艇调 constrainBoat，AI 艇得在这里补上，
    // 否则 AI 会直接开进石头里（玩家看得见穿模，而且它会变成"石头里的狙击台"）
    for (const id of this.players.keys()) {
      const bt = this.#boat(id);
      if (bt) this.constrainBoat(bt);
    }

    // 道具：箱子刷新、弹道、墨汁/升空等状态全在 ItemManager 里（AI 用道具也归它）
    this.items?.update(dt, elapsed, elapsed);
    // 按关卡跑各自的规则，再统一跑技能/血条/飘字
    this.#updateRound(dt);
    this.#updateSkills(dt);
    this.#updateUlts(dt);
    this.#updateHpBars(dt);
    this.#updateDmgTexts(dt);

    this.#syncHud();
  }

  // ============================================================ 三关规则 + 场景

  /** 把当前关卡的规则套到武器/场景上（构造函数和每关开始各调一次） */
  #applyRoundKind() {
    const def = this.roundDef || ARENA_ROUNDS[Math.min(this.round, ARENA_ROUNDS.length) - 1];
    this.roundDef = def;
    this.roundKind = def.key;
    const duel = def.key === 'duel';
    for (const w of this.weapons?.values() || []) {
      w.turretYaw = duel ? ARENA_DUEL.TURRET_YAW : ARENA_RULES.TURRET_YAW;
    }
    if (this.deliveryGroup) this.deliveryGroup.visible = def.key === 'delivery';
    if (this.ringVisual) {
      this.ringVisual.visible = def.key !== 'delivery';
      this.ring = def.key === 'ringout' ? this.ringoutR : ARENA_DUEL.R_START;
      this.#setRingRadius(this.ring);
    }
    if (this.blockShield) this.blockShield.visible = false;
    // 擂台关收窄道具池（只留位移/护盾/干扰）；弹药管制进一步砍掉所有远程道具
    if (this.items) {
      this.items.itemPool = (this.#hasMod('ammo_control') || def.key === 'ringout')
        ? RINGOUT_ITEM_POOL
        : ARENA_ITEM_POOL;
    }
    // 无盾：决斗关直接把举盾通道关掉
    if (this.#hasMod('no_shield') && this.blockState) this.blockState.active = false;
  }

  /**
   * 第 1 关：潮汐核心 + 两侧球门。
   * 全部用低模 + 半透明面片，不加任何大光圈/体积光 —— 核心本身就是"一个会转的晶体"，
   * 靠颜色和轮廓被认出来，不靠发光糊一屏。
   */
  #buildDeliveryCore() {
    const D = ARENA_DELIVERY;
    const g = new THREE.Group();
    g.name = 'arena-delivery';
    g.visible = false;

    // 核心：外八面体 + 内芯，两圈地面环分别标"实体半径"和"推动半径"
    const makeHolder = () => {
      const holder = new THREE.Group();
      const outer = new THREE.Mesh(
        new THREE.OctahedronGeometry(D.CORE_R * 0.78, 0),
        new THREE.MeshBasicMaterial({ color: 0x8fe8ff }),
      );
      const inner = new THREE.Mesh(
        new THREE.OctahedronGeometry(D.CORE_R * 0.4, 0),
        new THREE.MeshBasicMaterial({ color: 0xeaffff }),
      );
      outer.position.y = D.CORE_R * 0.8;
      inner.position.y = D.CORE_R * 0.8;
      holder.add(outer, inner);

      const flatRing = (r0, r1, color, opacity) => {
        const m = new THREE.Mesh(
          new THREE.RingGeometry(r0, r1, 48),
          new THREE.MeshBasicMaterial({
            color, transparent: true, opacity,
            side: THREE.DoubleSide, depthWrite: false,
          }),
        );
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.07;
        return m;
      };
      holder.add(flatRing(D.CORE_R * 0.96, D.CORE_R * 1.14, 0x9ff0ff, 0.5));
      holder.add(flatRing(D.PUSH_R - 0.28, D.PUSH_R, 0x6fd8ff, 0.14));

      // 晶体放进 spin 组：地面环保持不动，只让晶体自转
      const spin = new THREE.Group();
      holder.remove(outer, inner);
      spin.add(outer, inner);
      holder.add(spin);
      holder.userData.spin = spin;
      return holder;
    };
    const holder = makeHolder();
    const holder2 = makeHolder();
    holder2.visible = false;
    g.add(holder, holder2);

    // 球门：我防守的一侧涂红（危险），进攻的一侧涂绿（目标）。
    // 颜色跟着自己的出生侧走，换边也不会有"我该往哪推"的歧义。
    const myZ = this.spawns.get(this.myId)?.z ?? 1;
    const defZ = myZ > 0 ? D.GOAL_Z : -D.GOAL_Z;
    const atkZ = -defZ;
    const makeGoal = (z, color) => {
      const gg = new THREE.Group();
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(D.GOAL_W, 1.1),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.6,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.07, z);
      gg.add(line);
      for (const sx of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.CylinderGeometry(0.24, 0.3, 3.4, 6),
          new THREE.MeshBasicMaterial({ color }),
        );
        post.position.set((sx * D.GOAL_W) / 2, 1.7, z);
        gg.add(post);
      }
      return gg;
    };
    g.add(makeGoal(defZ, 0xff6a5a));
    g.add(makeGoal(atkZ, 0x6df0a0));

    this.scene.add(g);
    this.deliveryGroup = g;
    this.coreHolder = holder;
    this.coreHolder2 = holder2;
    this.coreSpin = holder.userData.spin;
    this.coreSpin2 = holder2.userData.spin;
    this.#deliveryVisual(0);
  }

  /** 第 2/3 关：擂台圈。单位几何 + scale 改半径，缩圈时不用重建 buffer */
  #buildRingVisual() {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.985, 1, 128),
      new THREE.MeshBasicMaterial({
        color: 0x7fe8ff, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.09;
    ring.visible = false;
    ring.userData.t = 0;
    this.scene.add(ring);
    this.ringVisual = ring;
  }

  #setRingRadius(r) {
    this.ring = r;
    if (!this.ringVisual) return;
    this.ringVisual.scale.set(r, r, 1);
  }

  /** 第 3 关的定向盾：船头前方一块半透明面板 + 一道细弧，不做球形光罩 */
  #buildBlockShield() {
    const g = new THREE.Group();
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 2.1),
      new THREE.MeshBasicMaterial({
        color: 0x8fe8ff, transparent: true, opacity: 0.22,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    panel.position.y = 0.2;
    const arc = new THREE.Mesh(
      new THREE.TorusGeometry(3.0, 0.09, 4, 20, Math.PI * 0.92),
      new THREE.MeshBasicMaterial({ color: 0x9ff0ff, transparent: true, opacity: 0.75 }),
    );
    arc.rotation.x = Math.PI / 2;
    arc.rotation.z = -Math.PI * 0.46;
    arc.position.y = 0.2;
    g.add(panel, arc);
    g.visible = false;
    this.scene.add(g);
    this.blockShield = g;
  }

  #deliveryVisual(dt = 0) {
    if (!this.deliveryGroup || !this.coreHolder) return;
    const st = this.delivery || { z: 0, z2: 0 };
    const twin = this.#hasMod('twin_core');
    this.coreHolder.position.set(twin ? -5.5 : 0, 0, st.z || 0);
    if (this.coreSpin) {
      this.coreSpin.rotation.y += dt * 1.1;
      this.coreSpin.rotation.x += dt * 0.4;
    }
    if (this.coreHolder2) {
      this.coreHolder2.visible = twin;
      this.coreHolder2.position.set(5.5, 0, st.z2 || 0);
      if (twin && this.coreSpin2) {
        this.coreSpin2.rotation.y += dt * 1.1;
        this.coreSpin2.rotation.x += dt * 0.4;
      }
    }
  }

  #ringVisualTick(dt) {
    const ring = this.ringVisual;
    if (!ring) return;
    ring.userData.t = (ring.userData.t || 0) + dt;
    ring.material.opacity = 0.48 + Math.sin(ring.userData.t * 2.1) * 0.1;
  }

  /** 每帧按关卡分发规则（结算/倒计时期间只保持视觉，不推进） */
  #updateRound(dt) {
    if (this.phase !== 'fight') {
      if (this.roundKind === 'delivery') this.#deliveryVisual(dt);
      else this.#ringVisualTick(dt);
      if (this.roundKind === 'duel') this.#updateBlockVisual();
      return;
    }
    if (this.roundKind === 'delivery') this.#updateDelivery(dt);
    else if (this.roundKind === 'ringout') this.#updateRingout(dt);
    else this.#updateDuel(dt);
  }

  // ---------------------------------------------------------------- 第 1 关：潮汐运送

  #updateDelivery(dt) {
    const D = ARENA_DELIVERY;
    const st = this.delivery;
    if (!st) return;

    if (!this.isHost) {
      // 客机：核心位置吃房主 5Hz 广播，插值一下避免一顿一顿
      if (st.netZ != null) st.z += (st.netZ - st.z) * Math.min(1, dt * 12);
      if (st.netZ2 != null) st.z2 += (st.netZ2 - st.z2) * Math.min(1, dt * 12);
      this.#deliveryVisual(dt);
      return;
    }

    if (this.phase === 'fight') {
      const golden = this.#hasMod('golden_core') ? 1.5 : 1;
      const tideBack = this.#hasMod('tide_back') ? 2 : 1;
      for (const core of this.#deliveryCores()) {
        const cz = st[core.key] || 0;
        let neg = 0, pos = 0, near = 0;
        for (const [id, p] of this.players) {
          if (!p.alive) continue;
          const b = this.#boat(id);
          if (!b) continue;
          if (Math.hypot(b.pos.x - core.x, b.pos.z - cz) > D.PUSH_R) continue;
          near++;
          if ((this.deliverySide.get(id) || 1) < 0) neg++; else pos++;
        }
        // HUD 只显示主核的争夺人数
        if (core.key === 'z') {
          const mySide = this.deliverySide.get(this.myId) || 1;
          st.me = mySide < 0 ? neg : pos;
          st.foe = mySide < 0 ? pos : neg;
        }

        let dir = 0;
        let n = 0;
        if (neg > pos) { dir = -1; n = neg; }
        else if (pos > neg) { dir = 1; n = pos; }
        else if (near === 0) {
          // 没人靠近 → 慢慢回中（不会自己往任何一家的门跑）
          if (Math.abs(cz) > 0.02) {
            st[core.key] = cz - Math.sign(cz) * Math.min(Math.abs(cz), D.RETURN * tideBack * dt);
          }
        }
        if (dir !== 0) {
          const sp = D.SPEED * golden * Math.min(1.6, 1 + 0.3 * Math.max(0, n - 1))
            * (st.overtime ? 1.5 : 1);
          st[core.key] = THREE.MathUtils.clamp(
            cz + dir * sp * dt, -D.GOAL_Z - 2, D.GOAL_Z + 2,
          );
        }

        const line = D.GOAL_Z - D.CORE_R;
        if (st[core.key] <= -line) { this.#endRound(this.#deliverySideId(-1), '核心送达'); return; }
        if (st[core.key] >= line) { this.#endRound(this.#deliverySideId(1), '核心送达'); return; }
      }
      if (st.overtime) {
        const key = st.otKey || 'z';
        const lead = (st[key] || 0) - st.otStart;
        if (lead <= -D.OT_LEAD) { this.#endRound(this.#deliverySideId(-1), '加时领先 15m'); return; }
        if (lead >= D.OT_LEAD) { this.#endRound(this.#deliverySideId(1), '加时领先 15m'); return; }
      }
      this.#netCore(dt);
    }
    this.#deliveryVisual(dt);
  }

  /** 推进方向 → 玩家 id（+z 出生的人往 -z 推） */
  #deliverySideId(dir) {
    for (const [id, d] of this.deliverySide) if (d === dir) return id;
    return null;
  }

  #netCore(dt) {
    if (!this.isHost || this.solo || !this.net) return;
    this.pointNetAcc += dt;
    if (this.pointNetAcc < 0.2) return;
    this.pointNetAcc = 0;
    this.net.send({
      t: 'arenaCore',
      z: Math.round(this.delivery.z * 100) / 100,
      z2: Math.round((this.delivery.z2 || 0) * 100) / 100,
      ot: this.delivery.overtime,
    });
  }

  #applyCore(e) {
    if (!e) return;
    this.delivery.netZ = e.z ?? 0;
    this.delivery.netZ2 = e.z2 ?? 0;
    this.delivery.overtime = !!e.ot;
  }

  #deliveryTimeout() {
    const D = ARENA_DELIVERY;
    const st = this.delivery;
    if (!st.overtime) {
      st.overtime = true;
      st.otKey = this.#leadCoreKey();
      st.otStart = st[st.otKey] || 0;
      this.roundTime = D.OVERTIME;
      this.timeoutHandled = false;
      this.onToast?.('⏱ 加时 30 秒 · 核心推进速度 ×1.5');
      this.#netCore(1);
      return;
    }
    const key = st.otKey || 'z';
    const value = st[key] || 0;
    const winner = value < -0.5 ? this.#deliverySideId(-1)
      : value > 0.5 ? this.#deliverySideId(1) : null;
    this.#endRound(winner, '加时结束 · 核心位置判定');
  }

  // ---------------------------------------------------------------- 第 2 关：潮汐擂台

  #updateRingout(dt) {
    if (this.phase !== 'fight') return;
    this.#ringVisualTick(dt);
    this.#updateRam(dt);
    if (!this.isHost) return;
    for (const [id, p] of this.players) {
      if (!p.alive) continue;
      const b = this.#boat(id);
      if (!b) continue;
      if (Math.hypot(b.pos.x, b.pos.z) > this.ringoutR) {
        this.#ringOut(id, this.#rivalIdOf(id));
      }
    }
  }

  /**
   * 船-船撞击（只处理「自己这端」那艘船）。
   *
   * 网络做法：撞击方算出冲量后发给被撞方，由被撞方的客户端把它加到自己船上。
   * 这样两边都只改"自己的船"，不会出现你把我推出去、我这边却没动的位置分叉。
   */
  #updateRam(dt) {
    const R = ARENA_RINGOUT;
    const a = this.localBoat;
    const foeId = this.#rivalIdOf(this.myId);
    const b = foeId ? this.#boat(foeId) : null;
    if (!a || !b) return;
    const p = this.#player(this.myId);
    if (!p?.alive) return;
    const dx = a.pos.x - b.pos.x;
    const dz = a.pos.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > R.RAM_R || d < 1e-3) return;
    const nx = dx / d;
    const nz = dz / d;
    // 先把本地船推出去，避免两船穿模叠在一起
    const min = R.RAM_R;
    a.pos.x = b.pos.x + nx * min;
    a.pos.z = b.pos.z + nz * min;

    const avx = a.vel?.x || 0;
    const avz = a.vel?.y || 0;
    const bvx = b.vel?.x || 0;
    const bvz = b.vel?.y || 0;
    // n 由 B 指向 A：A 朝 B 冲，沿 n 的相对速度是负的
    const closing = -((avx - bvx) * nx + (avz - bvz) * nz);
    if (closing < R.RAM_MIN) return;
    const rs = this.#stats(this.myId);
    const ramMul = (1 + rs.ram) * (this.#hasMod('low_gravity') ? 1.6 : 1);
    const power = Math.min(24, (closing - R.RAM_MIN) * R.RAM_POWER * ramMul);
    if (power < 0.5) return;

    // 被撞方是谁：如果 AI 归本机模拟就直接推；远端玩家发消息
    const foe = this.#player(foeId);
    if (foe?.ai) {
      this.#applyRam(foeId, -nx, -nz, power);
    } else if (this.net) {
      this.net.send({ t: 'arenaRam', to: foeId, nx: -nx, nz: -nz, p: Math.round(power * 10) / 10 });
    }
    // 撞击方自己也掉速（反作用），不然可以一路推着人走
    a.speed *= 0.82;
    a.vel.x = avx * 0.82;
    a.vel.y = avz * 0.82;
    this.fx?.play('minionWaterSplash', (a.pos.x + b.pos.x) / 2, 1.0, (a.pos.z + b.pos.z) / 2, 0.8);
    this.hitStop = Math.max(this.hitStop, 0.04);
  }

  #applyRam(id, nx, nz, power) {
    const p = this.#player(id);
    const b = this.#boat(id);
    if (!p?.alive || !b) return;
    const vx = b.vel?.x || 0;
    const vz = b.vel?.y || 0;
    b.vel.x = vx + nx * power;
    b.vel.y = vz + nz * power;
    b.speed = Math.hypot(b.vel.x, b.vel.y);
    // 被撞歪一下船头，给一点"失控"的反馈，但马上能救回来
    b.heading += (nx * Math.cos(b.heading) - nz * Math.sin(b.heading)) > 0 ? -0.16 : 0.16;
    b.collisionRoll = Math.max(b.collisionRoll || 0, 0.3);
    this.fx?.play('minionWaterSplash', b.pos.x, 1.2, b.pos.z, 1.1);
    if (id === this.myId) this.onToast?.('💥 被撞飞了！');
  }

  /** 掉出擂台：房主判，广播 arenaRing；被撞出的人 2 秒后回场 */
  #ringOut(id, byId) {
    const scorer = this.#player(byId);
    if (!scorer) return;
    scorer.ringScore = (scorer.ringScore || 0) + 1;
    this.#applyRingOut(id, byId);
    if (scorer.ringScore >= ARENA_RINGOUT.SCORE_TO_WIN) {
      this.#netRing(id, byId);
      this.#endRound(byId, '撞出擂台');
      return;
    }
    this.#netRing(id, byId);
  }

  #applyRingOut(id, byId) {
    const p = this.#player(id);
    const b = this.#boat(id);
    if (!p || !b) return;
    p.alive = false;
    p.respawn = ARENA_RINGOUT.RESPAWN;
    p.hp = ARENA_RULES.MAX_HP;
    p.outTick = 0;
    b.sinkTimer = Math.max(b.sinkTimer || 0, 0.9);
    this.deathHit = {
      source: this.#player(byId)?.name || '对手',
      dmg: 0,
      from: byId || null,
      ringOut: true,
    };
    this.fx?.play('minionWaterSplash', b.pos.x, 1.0, b.pos.z, 1.3);
    this.onToast?.(id === this.myId
      ? '🌊 你被撞出了擂台 · 2 秒后回场'
      : `${p.name} 被撞出擂台 +1`);
  }

  #netRing(id, byId) {
    if (!this.isHost || this.solo || !this.net) return;
    const s = {};
    for (const [pid, p] of this.players) s[pid] = p.ringScore || 0;
    this.net.send({ t: 'arenaRing', id, by: byId, s });
  }

  #applyRing(e) {
    if (e.s) {
      for (const [id, n] of Object.entries(e.s)) {
        const p = this.#player(id);
        if (p) p.ringScore = n;
      }
    }
    if (e.id) this.#applyRingOut(e.id, e.by);
  }

  #ringoutTimeout() {
    const list = [...this.players.values()].sort(
      (a, b) => (b.ringScore || 0) - (a.ringScore || 0),
    );
    const top = list[0];
    const second = list[1];
    const tied = !top || !second || top.ringScore === second.ringScore;
    this.#endRound(tied ? null : top.id, '时间到 · 撞出数判定');
  }

  // ---------------------------------------------------------------- 第 3 关：缩圈决斗

  #updateDuel(dt) {
    const D = ARENA_DUEL;
    // 缩圈两端各自按相同时间推进，不需要网络同步
    const shrink = this.duelShrinkTime;
    this.duelT = Math.min(shrink, this.duelT + dt);
    this.#setRingRadius(D.R_START + (D.R_END - D.R_START) * (this.duelT / shrink));
    this.#ringVisualTick(dt);
    this.#updateBlock(dt);
    if (this.phase !== 'fight') return;

    for (const [id, p] of this.players) {
      if (!p.alive) continue;
      // 远端玩家在自己的机器上算圈外伤害；AI 由房主算
      if (id !== this.myId && !p.ai) continue;
      const b = this.#boat(id);
      if (!b) continue;
      if (Math.hypot(b.pos.x, b.pos.z) <= this.ring) { p.outTick = 0; continue; }
      b.slowTimer = Math.max(b.slowTimer || 0, D.OUT_SLOW);
      p.outTick = (p.outTick || 0) + dt;
      if (p.outTick >= D.OUT_TICK) {
        p.outTick -= D.OUT_TICK;
        this.#applyDamage(id, D.OUT_DPS * D.OUT_TICK, null, b.pos.x, b.pos.z);
      }
    }
  }

  #duelTimeout() {
    const list = [...this.players.values()].sort((a, b) => b.hp - a.hp);
    const tied = list.length > 1 && Math.abs(list[0].hp - list[1].hp) < 1;
    this.#endRound(tied ? null : list[0]?.id || null, '时间到 · 血量判定');
  }

  /** 第 3 关格挡：按住 H 举盾，正面 ±66° 全挡，能量打空过热 */
  #updateBlock(dt) {
    const B = ARENA_DUEL;
    const bs = this.blockState;
    if (!bs) return;
    const on = this.phase === 'fight'
      && !this.#hasMod('no_shield')
      && !!this.opts.input?.block
      && bs.overheat <= 0 && bs.energy > 0;
    bs.active = on;
    if (on) {
      bs.energy = Math.max(0, bs.energy - B.BLOCK_DRAIN * dt);
      bs.delay = B.BLOCK_REGEN_DELAY;
      if (bs.energy <= 0) {
        bs.active = false;
        bs.overheat = B.BLOCK_OVERHEAT;
      }
    } else {
      if (bs.overheat > 0) bs.overheat = Math.max(0, bs.overheat - dt);
      bs.delay = Math.max(0, bs.delay - dt);
      if (bs.delay <= 0) bs.energy = Math.min(1, bs.energy + B.BLOCK_REGEN * dt);
    }
    this.#updateBlockVisual();
  }

  #updateBlockVisual() {
    const sh = this.blockShield;
    const bs = this.blockState;
    const b = this.localBoat;
    if (!sh) return;
    const on = !!bs?.active && !!b && this.roundKind === 'duel';
    sh.visible = on;
    if (!on) return;
    const h = b.heading || 0;
    sh.position.set(b.pos.x + Math.sin(h) * 3.7, 1.05, b.pos.z + Math.cos(h) * 3.7);
    sh.rotation.y = h;
    sh.children[0].material.opacity = 0.16 + bs.energy * 0.14;
  }

  #doDash(id) {
    const S = ARENA_SKILLS;
    const st = this.skills.get(id);
    const p = this.#player(id);
    const boat = this.#boat(id);
    if (!st || !p || !boat || st.dashCd > 0 || !p.alive) return false;
    const rs = this.#stats(id);
    const dr = this.#derived(rs);
    st.dashCd = S.DASH_CD * dr.dashCdMul;
    p.invuln = Math.max(p.invuln, S.DASH_INVULN + rs.dashInvuln);
    // 必须写 vel，不能只写 speed：Boat.updateLocal 的 vf 是从 this.vel 点乘船头算出来的，
    // speed 只是每帧末尾的回读值 —— 只改 speed 会出现"CD 走了、船没动"的假冲刺。
    const max = (boat.def?.maxSpeed || 32) * (boat.speedMul || 1);
    const cur = Math.hypot(boat.vel.x, boat.vel.y) || 0;
    const target = Math.min(max * 1.7, Math.max(cur + S.DASH_BOOST, max * 0.9));
    const h = boat.heading || 0;
    boat.vel.set(Math.sin(h) * target, Math.cos(h) * target);
    boat.speed = target;
    boat.applyFx?.('nitro');
    this.fx?.play('minionWaterSplash', boat.pos.x, 0.9, boat.pos.z, 0.28);
    this.net?.send({ t: 'arenaSkill', kind: 'dash', from: id });
    return true;
  }

  #doUlt(id) {
    const S = ARENA_SKILLS;
    const st = this.skills.get(id);
    const p = this.#player(id);
    const boat = this.#boat(id);
    if (!st || !p || !boat || st.ultCd > 0 || !p.alive) return false;
    st.ultCd = S.ULT_CD * this.#derived(this.#stats(id)).ultCdMul;
    const x = boat.pos.x;
    const z = boat.pos.z;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(S.ULT_RADIUS - 1.2, S.ULT_RADIUS, 64),
      new THREE.MeshBasicMaterial({
        color: id === this.myId ? 0x6df0a0 : 0xff5a3c,
        transparent: true, opacity: 0.3,
        side: THREE.DoubleSide, depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.12, z);
    this.scene.add(ring);
    this.ults.push({ id, t: 0, x, z, ring });
    this.net?.send({ t: 'arenaSkill', kind: 'ult', from: id, x, z });
    return true;
  }

  #updateUlts(dt) {
    const S = ARENA_SKILLS;
    for (let i = this.ults.length - 1; i >= 0; i--) {
      const u = this.ults[i];
      u.t += dt;
      const k = Math.min(1, u.t / S.ULT_TELEGRAPH);
      u.ring.scale.setScalar(0.35 + 0.65 * k);
      u.ring.material.opacity = 0.25 + 0.55 * k;
      if (u.t < S.ULT_TELEGRAPH) continue;

      // remote = 远端玩家放的，伤害归他那一端算，这里只放视觉
      if (!u.remote) {
        for (const [id, p] of this.players) {
          if (id === u.id || !p.alive) continue;
          const b = this.#boat(id);
          if (!b) continue;
          const dx = b.pos.x - u.x;
          const dz = b.pos.z - u.z;
          const d = Math.hypot(dx, dz);
          if (d > S.ULT_RADIUS) continue;
          this.#damage(id, S.ULT_DAMAGE, u.id, b.pos.x, b.pos.z);
          if (d > 0.2) { b.pos.x += (dx / d) * 2.5; b.pos.z += (dz / d) * 2.5; }
        }
      }
      this.fx?.play('minionWaterSplash', u.x, 1.1, u.z, 0.95);
      this.scene.remove(u.ring);
      u.ring.geometry.dispose();
      u.ring.material.dispose();
      this.ults.splice(i, 1);
      this.hitStop = Math.max(this.hitStop, 0.07);
    }
  }

  #updateSkills(dt) {
    const S = ARENA_SKILLS;
    for (const st of this.skills.values()) {
      st.dashCd = Math.max(0, st.dashCd - dt);
      st.ultCd = Math.max(0, st.ultCd - dt);
    }
    if (this.phase !== 'fight') return;

    const input = this.opts.input;
    const mine = this.#player(this.myId);
    const st = this.skills.get(this.myId);
    if (mine?.alive && st) {
      if (input?.dash && st.dashCd <= 0) this.#doDash(this.myId);
      // 擂台关锁大招：这一关只靠撞，不然又变成站桩互轰
      if (input?.ultimate && st.ultCd <= 0 && this.roundKind !== 'ringout') this.#doUlt(this.myId);
    }

    // AI：血少或离太远就冲刺；贴到 70% 大招半径就放大招（有前摇，玩家有机会跑）
    for (const [id, st2] of this.skills) {
      const p = this.#player(id);
      if (!p?.ai || !p.alive) continue;
      const boat = this.#boat(id);
      const foe = this.#rivalOf(id);
      if (!boat || !foe) continue;
      const d = Math.hypot(foe.pos.x - boat.pos.x, foe.pos.z - boat.pos.z);
      if (this.roundKind === 'ringout') {
        // 擂台关：贴近了才冲刺，用冲刺撞人
        if (st2.dashCd <= 0 && d < 22) this.#doDash(id);
        continue;
      }
      if (st2.ultCd <= 0 && d < S.ULT_RADIUS * 0.7) this.#doUlt(id);
      else if (st2.dashCd <= 0 && (p.hp < ARENA_RULES.MAX_HP * 0.4 || d > 36)) this.#doDash(id);
    }
  }

  #syncHud() {
    const me = this.#player(this.myId);
    this.hud = {
      mode: 'arena',
      arenaPhase: this.phase,
      arenaCountdown: this.phase === 'countdown' ? Math.ceil(this.countdown) : 0,
      arenaTimeLeft: Math.ceil(this.roundTime),
      arenaRound: this.round,
      arenaScoreMe: me?.score ?? 0,
      arenaScoreFoe: this.#player(this.foeId)?.score ?? 0,
      arenaWinner: this.matchWinner,
      // 当前关卡（UI 用它切换底部目标条）
      arenaKind: this.roundKind,
      arenaRoundName: this.roundDef?.name || '',
      arenaRoundHint: this.roundDef?.hint || '',
      arenaUltOff: this.roundKind === 'ringout',
      arenaOvertime: !!this.delivery?.overtime,
      arenaRingMe: me?.ringScore ?? 0,
      arenaRingFoe: this.#player(this.foeId)?.ringScore ?? 0,
      // 第 1 关：核心位置 -1（我快进球）～ +1（对手快进球）
      deliveryProg: (this.delivery?.[this.#leadCoreKey()] || 0)
        / (ARENA_DELIVERY.GOAL_Z - ARENA_DELIVERY.CORE_R),
      deliveryPushMe: this.delivery?.me ?? 0,
      deliveryPushFoe: this.delivery?.foe ?? 0,
      // 随机跑：本关词缀名（HUD 可选用）
      arenaMods: this.mods.map((id) => ARENA_MODIFIER_BY_ID.get(id)?.name).filter(Boolean),
      arenaCards: this.#stats(this.myId).cards.length,
      arenaThunder: this.#hasMod('thunder') ? Math.max(0, this.thunderT) : 0,
      // 第 2/3 关：圈子半径与收缩进度
      arenaRingR: this.ring,
      duelShrink: THREE.MathUtils.clamp(this.duelT / this.duelShrinkTime, 0, 1),
      // 第 3 关：举盾能量
      blockEnergy: this.blockState?.energy ?? 1,
      blockOverheat: this.blockState?.overheat ?? 0,
      blockActive: !!this.blockState?.active,
      // 倒计时显示（复用竞速模式的中央大字）
      phase: this.phase === 'countdown' ? 'countdown' : 'racing',
      countdown: Math.ceil(this.countdown),
      // 技能 CD
      dashCd: this.skills.get(this.myId)?.dashCd ?? 0,
      ultCd: this.skills.get(this.myId)?.ultCd ?? 0,
      // 双方血量（顶部决斗条用）
      arenaHpMe: me ? me.hp / ARENA_RULES.MAX_HP : 0,
      arenaHpFoe: (this.#player(this.foeId)?.hp ?? 0) / ARENA_RULES.MAX_HP,
      arenaNameMe: me?.name || '你',
      arenaNameFoe: this.#player(this.foeId)?.name || '对手',
      // 道具栏
      arenaItems: this.items ? this.items.myItems.slice() : [null, null, null],
      arenaItemFlyers: this.items
        ? {
          ink: this.items.inkTimer > 0,
          bubble: !!this.items.magnetAim,
        }
        : null,
    };
  }

  hudData() {
    const R = ARENA_RULES;
    const me = this.#player(this.myId);
    return {
      ...this.hud,
      playerHp: me ? Math.max(0, me.hp) : 0,
      playerMaxHp: R.MAX_HP,
      playerAlive: me?.alive ?? false,
      revives: me && this.roundKind === 'duel' ? Math.max(0, me.lives - 1) : 0,
      respawnLeft: me && !me.alive && me.respawn > 0 ? me.respawn : 0,
      // 「被击沉」面板：整场打完（matchEnd）就不再挡结算了。
      // 决斗关 lives 是"还能被打沉几次"，运送/擂台关不淘汰（lives=99 只是占位）。
      arenaDeath: me && !me.alive && this.phase !== 'matchEnd'
        ? {
          respawnLeft: Math.max(0, me.respawn),
          lives: this.roundKind === 'duel' ? Math.max(0, me.lives) : 0,
          maxLives: 1,
          livesEnabled: this.roundKind === 'duel',
          ringOut: !!this.deathHit?.ringOut,
          out: this.roundKind === 'duel' && me.lives <= 0,
          matchOver: false,
          source: this.deathHit?.source || '对手',
          dmg: this.deathHit?.dmg || 0,
        }
        : null,
      // 道具栏（UI 沿用道具赛那三条槽，键位 Q/E/1）
      items: this.items ? this.items.myItems.map((it) => (it ? ITEM_DEFS[it] : null)) : null,
      ink: this.items ? Math.max(0, this.items.inkTimer) : 0,
      shield: this.opts?.boats?.get?.(this.myId)?.shieldTimer > 0
        ? this.opts.boats.get(this.myId).shieldTimer
        : 0,
      // 复用怪物模式的左上队伍列表结构，UI 不用单独写一套
      party: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        hp: Math.max(0, p.hp),
        maxHp: R.MAX_HP,
        alive: p.alive,
        revives: this.roundKind === 'duel' ? Math.max(0, p.lives - 1) : 0,
        ai: p.ai,
        me: p.id === this.myId,
        taken: Math.round(p.taken),
        ready: false,
      })),
    };
  }

  // ---------------------------------------------------------------- 网络

  /**
   * 远端技能回放。伤害由「施放者那一端」结算（它自己调 `#damage` → 发 arenaDmg 给受害者），
   * 所以这里只补视觉，绝不能再判一次伤害，否则站圈里的人会被一个大招扣两次血。
   */
  #netSkill(e) {
    // 第 1 关开场同步：房主反复广播关卡顺序/词缀，客机收到一次就锁
    if (e.kind === 'sync') {
      if (!this.isHost) this.#applySync(e);
      return;
    }
    if (e.kind === 'thunder') {
      if (e.from !== this.myId) this.#showThunder(1.2);
      return;
    }
    if (e.from === this.myId) return;      // 本机施放已经放过了
    const boat = this.#boat(e.from);
    if (e.kind === 'dash') {
      if (boat) {
        boat.applyFx?.('nitro');
        this.fx?.play('minionWaterSplash', boat.pos.x, 0.9, boat.pos.z, 0.28);
      }
      return;
    }
    if (e.kind === 'ult') {
      const S = ARENA_SKILLS;
      const x = e.x ?? boat?.pos.x ?? 0;
      const z = e.z ?? boat?.pos.z ?? 0;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(S.ULT_RADIUS - 1.2, S.ULT_RADIUS, 64),
        new THREE.MeshBasicMaterial({
          color: 0xff5a3c, transparent: true, opacity: 0.3,
          side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, 0.12, z);
      this.scene.add(ring);
      this.ults.push({ id: e.from, t: 0, x, z, ring, remote: true });
    }
  }

  handleNet(e) {
    if (!e?.t) return;
    if (e.t === 'arenaDmg') {
      // 对方打我：我扣自己的血，然后广播结果
      if (e.to !== this.myId) return;
      this.#applyDamage(this.myId, e.dmg, e.from, e.x, e.z);
      return;
    }
    if (e.t === 'arenaHp') {
      const p = this.#player(e.id);
      if (!p) return;
      p.hp = e.hp;
      p.lives = e.lives;
      p.alive = e.alive;
      // 客机命打光了：房主在这儿收口（客机自己不敢判，怕两边同时宣布自己赢）。
      // 只有决斗关才有"命打光"这回事，运送/擂台关 lives 只是占位。
      if (this.isHost && this.roundKind === 'duel' && p.lives <= 0 && this.phase === 'fight') {
        const winner = [...this.players.values()].find((q) => q.id !== p.id);
        this.#endRound(winner?.id || null, '击沉对手');
      }
      return;
    }
    if (e.t === 'arenaCore') {
      this.#applyCore(e);
      return;
    }
    if (e.t === 'arenaRing') {
      this.#applyRing(e);
      return;
    }
    if (e.t === 'arenaRam') {
      if (e.to === this.myId) this.#applyRam(this.myId, e.nx || 0, e.nz || 0, e.p || 0);
      return;
    }
    if (e.t === 'arenaRound') {
      this.round = e.round ?? this.round;
      this.#applyRound(e);
      return;
    }
    if (e.t === 'arenaSkill') {
      this.#netSkill(e);
      return;
    }
    // 其余（itemPick / itemUse / itemHit / itemFx）全部交给道具系统自己处理，
    // 它本来就是按「每个人只处理跟自己相关的部分」写的，竞技场不需要额外适配
    this.items?.handleNet(e);
  }

  dispose() {
    // 开场标题浮层是自建的 DOM，模式结束必须摘掉；intro-on 也一定要摘，
    // 否则下一次开局整套 HUD 会一直是透明的
    if (this.introEl) {
      this.introEl.remove();
      this.introEl = null;
    }
    this.#closeCards();
    if (this.runEl) {
      this.runEl.remove();
      this.runEl = null;
    }
    document.body?.classList?.remove('intro-on');
    for (const th of this.thunders) {
      this.scene.remove(th.ring);
      th.ring.geometry.dispose();
      th.ring.material.dispose();
    }
    this.thunders.length = 0;
    this.runStats.clear();
    // 三关各自的场景物件（核心/球门/擂台圈/盾）都是本类自己加进场景的，必须自己摘
    for (const obj of [this.deliveryGroup, this.ringVisual, this.blockShield]) {
      if (!obj) continue;
      this.scene.remove(obj);
      obj.traverse?.((o) => {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
      });
    }
    this.deliveryGroup = null;
    this.coreHolder = null;
    this.coreHolder2 = null;
    this.coreSpin = null;
    this.coreSpin2 = null;
    this.ringVisual = null;
    this.blockShield = null;
    for (const w of this.weapons.values()) w.clear();
    this.weapons.clear();
    this.players.clear();
    // 把内置姓名牌还回去：万一后续复用同一批船（比如换模式重开），不能让它一直隐身
    for (const boat of this.boats.values()) {
      if (boat?.label) boat.label.visible = true;
    }
    for (const bar of this.hpBars?.values?.() || []) {
      this.scene.remove(bar.spr);
      bar.spr.material.dispose();
      bar.tex.dispose();
    }
    this.hpBars?.clear();
    for (const d of this.dmgTexts) {
      this.scene.remove(d.spr);
      d.spr.material.dispose();
      d.tex.dispose();
    }
    this.dmgTexts.length = 0;
    this.items?.dispose();
    this.items = null;
    // 道具键还给输入层，否则回主菜单开竞速模式时 Q/E/1 还被占着
    const input = this.opts.input;
    if (input) {
      input.bossItemMode = false;
      input.onItem = null;
    }
  }
}
