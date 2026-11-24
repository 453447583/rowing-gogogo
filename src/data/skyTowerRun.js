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

