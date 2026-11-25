// 云端天梯（Sky Tower）— 玩法配置
// 设计稿见 docs/云顶竞技三关-PRD.md。
// 2026-11-24 按实机反馈重构：赛场中央高塔 / 10 层 / 无螺旋梯 / 1 分钟收集期 / 可推人。
// 2026-11-24 二次改动：第一层改浮在竞技场海面上（掉出去直接落水）+ 每层天空复用现有天气。
// 所有数值都集中在这里，方便探针读取和调参。
import { WEATHERS } from './maps.js';

export const SKY_TOWER = {
  // ---- 场景尺度：10 层，初始范围大，越往上越小（留出容错空间）----
  LAYER_Y: [0, 18, 36, 54, 72, 90, 108, 126, 144, 162],
  LAYER_R: [82, 71, 62, 54, 47, 41, 35, 30, 26, 22],
  // 每层拾取半径一层比一层小（这是"越高越难捡"的硬约束）
  PICKUP_R: [5.2, 4.9, 4.6, 4.3, 4.0, 3.7, 3.4, 3.1, 2.8, 2.5],
  SPIRE_H: 190,                // 中央水晶塔高度
  // 塔柱碰撞半径（船用）。视觉塔身是 2.7~4.0m 的 Lathe（带正弦起伏），
  // 取中间值给一个圆：偏一点总比"直接开进柱子穿模"好读。
  SPIRE_R: 3.9,
  // 塔身从第 2 层地板起（18.3 = layerY(1)+0.30）。
  // 原来从 y=10 起：柱子悬在第 1 层球场上方 10m，还正好穿过第 2 层地板中心，
  // 把石台和包子整个埋进柱子（截图才看出来）。现在第 1 层头顶干净，
  // 第 2 层是"塔从自己地板长出来"，货再沿 z 偏出去。
  SPIRE_BASE_Y: 18.3,
  // CLOUD_Y（塔下云海）在 2026-11-24 撤掉：第一层改浮在竞技场海面上，
  // 塔底下是水不是云海（水的 y 见 WATER_Y）。云只在天空着色器里画。
  UPLINK_R: 4.2,               // 浮空升降光柱的触发半径
  LIFT_TIME: 2.6,              // 浮空上升时长（垂直升，不绕圈）
  // ---- 单局 ----
  ROUND_TIME: 300,             // 5 分钟：10 层 + 1 分钟收集期，要能跑好几轮
  OVERTIME: 30,
  COLLECT_LOCK: 60,            // 前 60 秒只许收集，上升通道关闭
  // ---- 货物 ----
  CARGO_MAX: 6,                // 单船最多挂几件
  DROP_SPREAD: 2.6,            // 掉货散开半径
  // 货物品级：越高的层越值钱，也越重
  CARGO_TYPES: [
    { id: 'potato',  name: '土豆',  value: 1,  weight: 1, color: 0xd9a441, scale: 0.9 },
    { id: 'crystal', name: '水晶',  value: 3,  weight: 2, color: 0x5fe0ff, scale: 1.0 },
    { id: 'starcore',name: '星核',  value: 10, weight: 4, color: 0xffd35e, scale: 1.35 },
  ],
  // 每层地面刷新的货物数与品级权重（索引对应 CARGO_TYPES），10 层逐层升级
  LAYER_SPAWN: [
    { counts: [7, 0, 0] },
    { counts: [6, 2, 0] },
    { counts: [5, 4, 0] },
    { counts: [4, 5, 0] },
    { counts: [3, 6, 1] },
    { counts: [2, 6, 2] },
    { counts: [2, 5, 3] },
    { counts: [1, 5, 4] },
    { counts: [1, 4, 5] },
    { counts: [0, 3, 6] },
  ],
  RESPAWN_CARGO: 6,            // 被捡走的货几秒后重刷（该层补货）
  // ---- 第 1 层：水球赛（球 + 球门 + 障碍）----
  // 2026-11-24 用户改玩法：第 1 层不再是运货，改成"把球撞进对方球门"。
  // 场地按真实足球场比例铺在玻璃盘上（100×62，对角 58.8m < 平台半径 82m），
  // 球被四周围板（能量网）关在球场里，船可以照常冲出玻璃边缘掉下去。
  FOOTBALL: {
    LAYER: 0,
    HALF_L: 50,            // 球场半长：全长 100m
    HALF_W: 31,            // 球场半宽：全宽 62m
    GOAL_W: 16,            // 门宽（立柱内侧）
    GOAL_H: 6,             // 门高（判定用，球跳过去也算进）
    POST_R: 0.45,          // 门柱半径（球撞柱会弹）
    BALL_R: 2.2,           // 球半径
    BALL_MASS_K: 1.7,      // 球质量 = 船质量 × 1.7（重，但推得动）
    BOARD_H: 1.6,          // 围板高度：只挡球，船能开过去
    RESET_DELAY: 1.4,      // 进球后多久把球放回中圈
    KICKOFF_R: 3.2,        // 球回中圈后，球心周围这一圈内船不参与碰撞（防"刚发球就被顶飞"）
    // 障碍：只在中圈带生成，球门前留禁区，避免变成零封局
    OBS_BAND_X: 26,        // |x| < 26 才放障碍（离两端球门至少 24m）
    OBS_BAND_Z: 18,        // |z| < 18（离边线留 13m，球能绕过去）
    OBS_CENTER_CLEAR: 7,   // 中圈 7m 内不放，保证开球干净
    OBS_COUNT: [2, 3],     // 2~3 个
    OBS_ROCK_R: [3.2, 4.8],
    OBS_PILLAR_R: [2.6, 3.2],
    PILLAR_H: [5.5, 7.0],  // 别做成 9m：那在球场里读起来是一堵黑墙，不是柱子
    SEED: 20261124,        // 确定性布局：两端各自生成同一份障碍，不需要同步
  },
  // ---- 第 2 层：泡泡送包子 ----
  // 用户玩法：中间一个货物（包子），谁先碰到谁背着；背的人变慢、不能放泡泡；
  // 追的人按 K 放泡泡（3 秒引信）炸他，炸中就掉货；谁先把货送到自己那一端的终点谁得分。
  DELIVER: {
    LAYER: 1,
    GATE_X: 46,            // 终点门中心（层半径 71，留 25m 缓冲）
    GATE_SPAN: 22,         // 门的横向开口（视觉；判定用 GATE_R）
    GATE_R: 9.5,           // 到达判定：持货者进入这个圆就算送到
    CARGO_PICK_R: 5.2,     // 拾取半径
    // 石台中心：原点被水晶塔柱占着（半径约 3.8m），货摆进去等于看不见。
    // 沿 z 偏出去仍然到两个门（x=±46, z=0）**等距**，公平性不变；沿 x 偏会偏袒一方。
    PEDESTAL_Z: 15,
    CARGO_RESPAWN: 1.6,    // 掉货/送成之后多久回到中央
    CARRY_SPEED: 0.72,     // 持货极速倍率
    CARRY_TURN: 0.8,       // 持货转向倍率（由 mode 写进 boat.speedMul 之外的转向）
    BUBBLE_FUSE: 3.0,      // 泡泡引信：放出去 3 秒后炸
    BUBBLE_R: 6.5,         // 爆炸半径
    BUBBLE_SPEED: 18,      // 发射初速
    BUBBLE_DRAG: 2.6,      // 飞行阻尼
    BUBBLE_AHEAD: 4.6,     // 在船头前方多远生成
    BUBBLE_CD: 2.2,        // 单人冷却
    BUBBLE_MAX: 3,         // 单人同时最多几个在场
    STUN: 1.2,             // 炸中后的僵直
    SCORE: 2,              // 送成一次得几分
  },
  // ---- 第 3 层：道具箱大乱斗 ----
  // 用户口径（2026-11-24）：这一层全是道具箱，双方都吃；箱子/道具/释放逻辑全部沿用道具赛，
  // 把「其他人」一律当敌方（该起泡的起泡、该眩晕的眩晕）；限时 1 分钟，
  // **吃到的箱子多者胜（A 为主分）**，用道具打中对手再少量加分（B 加分）；联机按队伍汇总。
  ITEMRUSH: {
    LAYER: 2,
    DURATION: 60,          // 本层限时 1 分钟
    // 箱子布局：4 圈同心圆，圈越外越密（外圈面积大），中间留 8m 空档给开场冲刺
    RING_R: [14, 27, 40, 53],
    RING_N: [8, 12, 16, 20],
    RING_TWIST: 0.39,      // 每圈错开的角度（弧度），避免箱子排成一条条放射线
    BOX_RESPAWN: 4,        // 吃掉后几秒补一个（1 分钟乱斗要跟得上，竞速那套 8s 太慢）
    SCORE_BOX: 1,          // A：吃到一个箱子
    SCORE_HIT: 1,          // B：用道具打中对手一次
    POLE_COUNT: 12,        // 场边灯柱（复用 low_poly_street_light_pole.glb）
    ARCH_COUNT: 8,         // 外圈进场拱门（复用 props/shortcut_arch.glb）
  },
  // ---- 第 4 层：雷霆龙骑士 · 双船伤害竞速 ----
  // 用户口径：小 BOSS 会攻击会放技能，两艘船各自打，60 秒内谁伤害高谁赢。
  // 复用怪物模式的龙骑士本体 + 三招，但伤害压到原版 1/3 左右 ——
  // 天梯比的是输出量，不该让"被打死"抢走主题。
  BOSSRUSH: {
    LAYER: 3,
    DURATION: 60,
    BOSS_HP: 9000,          // 两人满打 60 秒大约打掉 70~85%，不会中途提前结束
    ARENA_R: 52,            // layerRadius(3)=54，给 Boss 留 2m 边距
    // BOSS 三招伤害（原版 slash 14 / thunder 32 / sweep 26）
    DMG_SLASH: 12,
    DMG_THUNDER: 16,
    DMG_SWEEP: 14,
    TELEGRAPH_SCALE: 1.15,  // 浮空盘比海面小、退路少，预警稍微放长
    COOLDOWN_SCALE: 0.85,
    // 玩家手段①：雷炮（按 1，自动锁定 BOSS）
    CANNON_DMG: 30,
    CANNON_CD: 1.5,
    CANNON_RANGE: 38,
    // 玩家手段②：撞 BOSS（K 冲刺时翻倍，沿用怪物模式口径）
    RAM_BASE: 60,
    RAM_NITRO: 2,
    RAM_CD: 0.9,
    ARCH_COUNT: 6,          // 场边拱门（复用 shortcut_arch.glb）
    POLE_COUNT: 8,          // 场边灯柱（复用 low_poly_street_light_pole.glb）
  },
  // ---- 冲刺 / 过热 ----
  DASH_ENERGY_MAX: 100,

  DASH_COST: 25,
  DASH_REGEN: 15,
  DASH_BOOST: 26,
  DASH_THRESHOLD: 3,
  DASH_WINDOW: 3,
  OVERHEAT_TIME: 2,
  RAM_R: 5.2,
  RAM_MIN: 7,                  // 触发掉货的最小相对速度
  RAM_COOLDOWN: 0.8,
  RAM_DROP: [1, 2, 3],
  // ---- 推人下平台（新增：撞击除了掉货，还把对手往平台外推）----
  PUSH_BASE: 9,                // 基础水平冲量
  PUSH_PER_SPEED: 0.85,        // 每 1m/s 相对速度追加的冲量
  PUSH_MAX: 34,
  PUSH_LIFT: 3.2,              // 上抛分量：把人"顶飞"，更容易冲出边缘
  PUSH_INVULN: 1.0,            // 推飞后短暂免推，避免连撞卡在边界外
  // ---- 坠落 ----
  FALL_PENALTY: 0.34,
  FALL_OUT_TIME: 2,
  // ---- 海面（2026-11-24）：第一层浮在竞技场那片水上，掉出第一层直接落水 ----
  // 水面整块下移 6m：第一层玻璃盘顶面在 +0.3，往下看 6m 才是海面，
  // 既不会让浪打到玻璃上，又让"塔浮在水上"读得出来。数值直接喂给
  // Game 的 water.mesh.position.y（见 Game 构造函数天梯分支）。
  WATER_Y: -6,
  WATER_FALL_TIME: 1.15,       // 从第一层边缘坠到海面的时长（加速下坠）
  WATER_SINK_TIME: 0.55,       // 入水后沉没停留，之后传回第一层
  // ---- 每层天气：复用 WEATHERS（道具/竞速赛那套），10 层按顺序轮两轮 ----
  // 第一层用玩家在大厅选的天气，往上依次切换 —— 爬一层天就换一张脸。
  // 顺序 = WEATHERS 数组顺序（day → dusk → storm → blizzard → starry），
  // 不另写一份色板，天气那边调色改了天梯自动跟着变。
  // ---- 流程 ----
  COUNTDOWN: 3,
  INTRO_TIME: 4.5,
  CINEMA_TIME: 8,
  END_TIME: 3.5,
  // ---- 颜色主题：10 层从暖金到极光青，越爬天越"变脸"----
  LAYER_SKY: [
    0xffb26b, 0xff9f7d, 0xe88bb0, 0xc788d8, 0xa681ee,
    0x827df2, 0x5b7ff0, 0x3a92ea, 0x2fc5df, 0x2de2e6,
  ],
};

const clampLayer = (layer) => Math.max(0, Math.min(SKY_TOWER.LAYER_Y.length - 1, layer | 0));

/** 总层数 */
export const layerCount = () => SKY_TOWER.LAYER_Y.length;
/** 平台半径（带出厂校验，写错层数时能立刻发现） */
export function layerRadius(layer) { return SKY_TOWER.LAYER_R[clampLayer(layer)]; }
export function layerY(layer) { return SKY_TOWER.LAYER_Y[clampLayer(layer)]; }
/** 每层拾取半径：逐层递减 */
export function pickupRadius(layer) { return SKY_TOWER.PICKUP_R[clampLayer(layer)]; }

/**
 * 每层用哪套天气：从起始天气（大厅选的）开始，按 WEATHERS 顺序循环。
 * 10 层 × 5 种天气 = 每种天气刚好出现两轮，越往上"变脸"越频繁。
 * 不复制天气参数：返回的就是 WEATHERS 里的对象本身，天气调色改了天梯跟着变。
 */
export function weatherForLayer(layer, startId = 'day') {
  const idx = WEATHERS.findIndex((w) => w.id === startId);
  const base = idx < 0 ? 0 : idx;
  return WEATHERS[(base + Math.max(0, layer | 0)) % WEATHERS.length];
}

