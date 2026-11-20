// 单圈遥测：一圈的轨迹、分段时间、行为统计，以及「这一圈跑得怎么样」的即时评价。
//
// 三个功能共用这一份数据（见 DEV_STATUS 里「共同底座」的约定）：
//   ① 幽灵车 —— 最快圈的轨迹由这里产出，打包交给 GhostStore；
//   ② 每圈评价 —— 分段计时 + 漂移/氮气/撞墙统计，压线瞬间出一句话；
//   ③ 失败归因 —— 撞墙/撞物/被炸都往这里 `noteImpact()`，由 Game 决定闪哪个图标。
//
// 为什么要分段：只说「快了 0.3 秒」玩家不知道好在哪、坏在哪；
// 把一圈按弧长切成 4 段，就能说「第三段慢了 0.4 秒」——这才是可执行的信息。
// 分界点用**弧长**而不是门序号：霓虹海峡 55 个门，门间距差 5 倍，
// 按门切会出现「第一段 8 秒、第二段 40 秒」这种没法比较的分段。

const TAU = Math.PI * 2;
const SEGMENTS = 4;
/** 采样频率：20Hz。30m/s 时每点间隔 1.5m，插值后完全看不出折线 */
export const GHOST_HZ = 20;

/** 撞墙/撞物/被炸 → 图标与两字标签（C1 口径：只要图标，不写数值、不写谁打的） */
export const IMPACT_ICONS = {
  wall: { icon: '🧱', label: '撞墙' },
  rock: { icon: '🪨', label: '撞石' },
  buoy: { icon: '🛟', label: '浮桶' },
  boat: { icon: '🚤', label: '被撞' },
  fall: { icon: '🌊', label: '掉出' },
  reset: { icon: '↩️', label: '复位' },
  bomb: { icon: '💣', label: '被炸' },
  missile: { icon: '🚀', label: '导弹' },
  torpedo: { icon: '🐠', label: '鱼雷' },
  ink: { icon: '🌑', label: '墨汁' },
  spin: { icon: '🌀', label: '漩涡' },
  slow: { icon: '💥', label: '减速' },
  halfSpeed: { icon: '🐢', label: '半速' },
  octoGrab: { icon: '🐙', label: '缠身' },
  capsize: { icon: '🐠', label: '翻船' },
  bubbleLift: { icon: '🫧', label: '水泡' },
  geyserLift: { icon: '🌊', label: '瀑布' },
  void: { icon: '🫧', label: '异世界' },
  reverse: { icon: '😈', label: '反向' },
  other: { icon: '💥', label: '受击' },
};

/** 道具 fx → 归因 key（没列到的落 other） */
export function impactKeyFromFx(fx) {
  switch (fx) {
    case 'sink': return 'bomb';
    case 'missileHit': return 'missile';
    case 'capsize': return 'torpedo';
    case 'ink': case 'inkStun': return 'ink';
    case 'spin': return 'spin';
    case 'slow': return 'slow';
    case 'halfSpeed': return 'halfSpeed';
    case 'octoGrab': return 'octoGrab';
    case 'bubbleLift': return 'bubbleLift';
    case 'geyserLift': return 'geyserLift';
    case 'void': return 'void';
    case 'reverse': return 'reverse';
    default: return 'other';
  }
}

/** 极简 LCG：文案轮换要「看起来随机」但测试要可复现 */
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const fmtDelta = (d) => (Math.abs(d) >= 1 ? Math.abs(d).toFixed(1) : Math.abs(d).toFixed(2));
const kmh = (v) => Math.round(v * 3.6);

/**
 * 把「玩家本圈某段用时」和参照（上一圈 / 幽灵）比。
 * @returns {{seg:number, d:number}|null} d > 0 = 玩家慢了
 */
function worstSegment(segT, refSegT) {
  if (!refSegT) return null;
  let worst = null;
  for (let i = 0; i < SEGMENTS; i++) {
    const a = segT[i];
    const b = refSegT[i];
    if (a == null || b == null) continue;
    const d = a - b;
    if (!worst || d > worst.d) worst = { seg: i + 1, d };
  }
  return worst;
}

/**
 * 生成一圈的即时评价（纯函数，便于单测）。
 *
 * @param {object} o
 * @param {number} o.lapTime     本圈用时
 * @param {number|null} o.prevTime 上一圈用时（第一圈为 null）
 * @param {number|null} o.bestTime 历史最佳（含幽灵记录）
 * @param {number[]|null} o.segT   本圈 4 段累计时刻
 * @param {number[]|null} o.prevSegT 上一圈 4 段累计时刻
 * @param {number[]|null} o.ghostSegT 幽灵 4 段累计时刻
 * @param {object} o.stats { drift, nitro, wall, maxSpeed }
 * @param {number} o.seed 本圈序号（同样的数据每次给同一句文案）
 * @returns {{tone:'best'|'good'|'bad'|'even'|'first', main:string, sub:string}|null}
 */
export function buildReview(o) {
  const {
    lapTime, prevTime = null, bestTime = null,
    segT = null, prevSegT = null, ghostSegT = null,
    stats = {}, seed = 1,
  } = o || {};
  if (!(lapTime > 0)) return null;
  const rnd = lcg(seed * 7919 + 13);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

  let tone = 'first';
  let main = '';
  const isBest = bestTime != null && lapTime < bestTime - 0.02;

  if (isBest) {
    tone = 'best';
    const gain = bestTime - lapTime;
    main = pick([
      `新纪录！快了 ${fmtDelta(gain)} 秒`,
      `破纪录 · 提升 ${fmtDelta(gain)} 秒`,
    ]);
  } else if (prevTime != null && Math.abs(lapTime - prevTime) >= 0.05) {
    const d = lapTime - prevTime;
    tone = d > 0 ? 'bad' : 'good';
    main = d > 0
      ? pick([`慢了 ${fmtDelta(d)} 秒`, `节奏松了，慢 ${fmtDelta(d)} 秒`])
      : pick([`快了 ${fmtDelta(d)} 秒`, `跑得顺，快 ${fmtDelta(d)} 秒`]);
  } else if (prevTime != null) {
    tone = 'even';
    main = pick(['稳住了 · 和上一圈几乎一样', '一模一样的一圈']);
  } else {
    tone = 'first';
    main = `第 1 圈 ${fmtDelta(lapTime)} 秒 · 标杆已立`;
  }

  // ---- 副标题：只挑「有数据支持」的那一条，不硬凑 ----
  const ref = ghostSegT || prevSegT;
  const worst = worstSegment(segT, ref);
  const wall = Math.max(0, stats.wall || 0);
  const drift = Math.max(0, stats.drift || 0);
  let sub = '';

  // 分段差超过 20 秒基本不是"这一段慢"，而是记录本身有问题（复位、瞬移、
  // 上一圈中途掉出赛道）。这种时候宁可不说，也不要报"第 1 段慢了 50 秒"。
  const sane = (d) => Math.abs(d) < 20;
  if (worst && worst.d > 0.15 && sane(worst.d)) {
    sub = `第 ${worst.seg} 段慢了 ${fmtDelta(worst.d)} 秒`;
  } else if (wall >= 2) {
    // 每次撞墙实测掉 0.3~0.5 秒（20~30m/s 撞停再加速），取 0.35 做保守估计
    sub = `撞墙 ${wall} 次 · 约丢 ${(wall * 0.35).toFixed(1)} 秒`;
  } else if (drift >= 3 && (tone === 'good' || tone === 'best')) {
    sub = `漂移 ${drift} 次 · 过弯漂亮`;
  } else if (worst && worst.d < -0.2 && sane(worst.d)) {
    sub = `第 ${worst.seg} 段快了 ${fmtDelta(worst.d)} 秒`;
  } else if (stats.maxSpeed > 0) {
    sub = `漂移 ${drift} 次 · 最高 ${kmh(stats.maxSpeed)} km/h`;
  }
  // 首圈没有参照，副标题只说行为，不评价快慢
  if (tone === 'first' && wall >= 2) sub = `撞墙 ${wall} 次 · 下一圈收着点`;

  return { tone, main, sub };
}

/**
 * 单圈遥测。一局一个实例，每圈 `begin()` 一次。
 */
export class LapTelemetry {
  constructor() {
    this.samples = [];
    this.lapT = 0;
    this.acc = 0;
    this.lapArc = 0;
    this.arcTotal = 1;
    this.segT = [null, null, null, null];
    this.segMark = 0;      // 下一个要打点的段号（0..3）
    this.stats = { drift: 0, nitro: 0, wall: 0, maxSpeed: 0 };
    this.prevDrifting = false;
    this.last = null;      // 上一圈 { lapTime, segT, stats }
  }

  /** 每圈开始（发车 / 压线那一刻） */
  begin(lapArc, arcTotal) {
    this.samples = [];
    this.lapT = 0;
    this.acc = 0;
    this.lapArc = Number(lapArc) || 0;
    this.arcTotal = Math.max(1, Number(arcTotal) || 1);
    this.segT = [null, null, null, null];
    this.segMark = 0;
    this.stats = { drift: 0, nitro: 0, wall: 0, maxSpeed: 0 };
    this.prevDrifting = false;
  }

  /** 撞墙 / 撞硬物 / 掉出：由 Game 调用，只做计数 */
  noteWall() { this.stats.wall += 1; }

  /**
   * 每帧采样。
   * @param {object} boat 本地船
   * @param {object} track 赛道（要 arcAt）
   * @param {number} lapT 本圈已用时间（秒）
   * @param {number} dt
   */
  sample(boat, track, lapT, dt) {
    if (!boat) return;
    this.lapT = lapT;
    this.acc += dt;

    // 行为统计
    if (boat.wasDrifting && !this.prevDrifting) this.stats.drift += 1;
    this.prevDrifting = !!boat.wasDrifting;
    if (boat.boostTimer > 0 || boat.miniBoostTimer > 0) this.stats.nitro += dt;
    if (boat.speed > this.stats.maxSpeed) this.stats.maxSpeed = boat.speed;

    // 分段打点：按弧长比例切 4 段
    if (track?.arcAt && this.segMark < SEGMENTS) {
      const arc = track.arcAt(boat.pos.x, boat.pos.z).s || 0;
      let p = (arc - this.lapArc) / this.arcTotal;
      // 跨过 0 号门时 arc 会回卷：跑出负值说明刚过线，补一圈
      if (p < -0.5) p += 1;
      if (p < 0) p = 0;
      while (this.segMark < SEGMENTS - 1 && p >= (this.segMark + 1) / SEGMENTS) {
        this.segT[this.segMark] = lapT;
        this.segMark += 1;
      }
    }

    // 轨迹采样（20Hz），时间用「距上一点的间隔」存，解码端累加成绝对时间
    if (this.acc >= 1 / GHOST_HZ && this.samples.length < 6000 * 4) {
      const dtMs = this.acc * 1000;
      this.acc = 0;
      this.samples.push(dtMs, boat.pos.x, boat.pos.z, boat.heading);
    }
  }

  /**
   * 落圈：收尾、返回评价与「这圈值不值得存成幽灵」。
   * @param {number} lapTime 本圈用时
   * @param {object} ctx { bestTime, ghostSegT, seed }
   */
  endLap(lapTime, ctx = {}) {
    // 最后一段没打到的（比如漏了最后的弧长判定）用总时长补上
    for (let i = 0; i < SEGMENTS; i++) if (this.segT[i] == null) this.segT[i] = lapTime;
    const review = buildReview({
      lapTime,
      prevTime: this.last?.lapTime ?? null,
      bestTime: ctx.bestTime ?? null,
      segT: this.segT,
      prevSegT: this.last?.segT ?? null,
      ghostSegT: ctx.ghostSegT ?? null,
      stats: this.stats,
      seed: ctx.seed ?? 1,
    });
    const out = {
      lapTime,
      segT: [...this.segT],
      stats: { ...this.stats },
      samples: this.samples,
      review,
    };
    this.last = { lapTime, segT: [...this.segT] };
    return out;
  }
}
