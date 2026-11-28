// 云端天梯（Sky Tower）— 玩法配置
// 设计稿见 docs/云顶竞技三关-PRD.md。
// 2026-11-24 按实机反馈重构：赛场中央高塔 / 10 层 / 无螺旋梯 / 可推人。
// 2026-11-27 用户口径：取消 1 分钟收集期（开球即开放升降光柱）；
// 所有楼层开出平台都不再坠落/淘汰，统一重置回本层内侧。
// 2026-11-24 二次改动：第一层改浮在竞技场海面上 + 每层天空复用现有天气。
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
  // ---- 单局（2026-11-27 逐层赛制）----
  // 一层一局：等全员到齐 → 2.5s 规则过场 → 60s 本层比赛 → 清场开升降门 → 上一层。
  // 10 层跑完约 12~14 分钟，900s 是整场硬上限（防止有人卡住导致永不结算）。
  ROUND_TIME: 900,             // 15 分钟整场硬上限
  OVERTIME: 30,
  LAYER_ROUND: 60,             // 每层比赛时长（用户口径：1 分钟）
  LAYER_CUTSCENE: 2.5,         // 每层开赛前的规则过场（镜头环绕本层）
  LAYER_WAIT: 20,              // 等全员到齐的上限，超时强拉
  // 每层的名字与规则（过场卡 / HUD 横幅 / 「?」随时查看都用这一份）
  LAYER_INFO: [
    { name: '水球赛', rule: '把球撞进对方球门 · K 冲刺' },
    { name: '泡泡送包子', rule: '抢包子送回自家终点 · K 放泡泡炸持货者' },
    { name: '道具箱大乱斗', rule: '撞碎道具箱，吃箱最多的一方胜 · 1/2/3 放道具' },
    { name: '雷霆龙骑士', rule: '按 1 发雷炮 · K 冲刺撞 BOSS 伤害翻倍' },
    { name: '棋盘落雷', rule: '随机一半地面亮红格，1.5 秒后落雷 · 躲开的 +1 分，被劈的 0 分' },
    { name: '塔防竞速', rule: 'J 键开炮清怪 · 打掉最多的一方胜' },
    { name: '缩圈里程', rule: '漂移 / 直线都算里程 · 跑得最多的一方胜' },
    { name: '水晶攻防', rule: '撞碎对方水晶 · 1 键丢泡泡炸弹' },
    { name: '涂地竞速', rule: '船尾自动留色 · 覆盖率高的一方胜' },
    { name: '加冕仪式', rule: '抢皇冠回自家加冕区站 3 秒' },
  ],
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
    ARCH_COUNT: 4,         // 外圈进场拱门（canyon/arch.glb 石拱；原来 8 座 shortcut_arch 太重复）
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
    // 赋分制：BOSS 层不再 1 伤害 = 1 分（60 秒能打出 1000~2000 分，
    // 其他层只有 20~40 分，后面几层根本追不回来）。
    // 每 60 点伤害折 1 分，层末再按伤害排名给 SCORE_RANK。
    DMG_PER_POINT: 60,
    SCORE_RANK: [6, 3, 1],
    ARCH_COUNT: 3,          // 场边拱门（palace_gate_frame.glb，和别的层错开模型）
    POLE_COUNT: 8,          // 场边灯柱（复用 low_poly_street_light_pole.glb）
  },
  // ---- 第 5 层：棋盘落雷 · 躲雷 + 推人 ----
  // 2026-11-28 用户口径：改成 BOSS 模式「雷霆棋盘」那一套 —— 整层铺网格，
  // 每波随机点亮**一半**格子（红色地面预警），1.5 秒后整片落雷；
  // 站在亮格里会被劈，亮格之外安全；每波没被劈的人 +1 分、被劈的 0 分。
  // 这层没有货、不刷货，纯走位 + 互推。
  THUNDER: {
    LAYER: 4,                // 第 5 层（layerY=72、layerRadius=47）
    DURATION: 60,
    WAVE_FIRST: 2.4,         // 开场到第一波的间隔（给玩家认出场地的时间）
    WAVE_INTERVAL: 3.4,      // 每波间隔（1.5 秒预警 + 1.9 秒空档）
    GRID_COLS: 8,            // 赛场网格：8×8，约 11.8m 一格
    GRID_ROWS: 8,
    TELEGRAPH: 1.5,          // 红色预警时长（用户指定 1.5 秒）
    // 命中反馈：天梯没有血条，把伤害换成了「失控 + 击退 + 计次」
    STUN: 0.85,
    PUSH: 11,                // 从格子中心向外的水平冲量
    PUSH_LIFT: 1.8,
    SLOW: 1.4,
    // 视觉：沿用 BOSS_SKILLS.thunder 那套（fxLightningStrike + fxArcBolt）
    SKY_H: 9,
    SKY_SCALE: 2.3,
    HIT_FX_SCALE: 1.5,
    // 计分：每躲过一波 +1；层结束按被劈次数升序再给排名分
    SCORE_DODGE: 1,
    SCORE_RANK: [6, 3, 1],
    // 本层「互推」是核心玩法，船对船推力放大到 1.35 倍（公式仍在 mode.constrainBoat）
    PUSH_SCALE: 1.35,
    POLE_COUNT: 8,
    ARCH_COUNT: 3,          // 场边旗门（flag_gate.glb）
  },
  // ---- 第 6 层：塔防 · 杀怪竞速 ----
  // 用户口径（2026-11-25）：怪物模式那套小怪冲过来，各船用主炮打，
  // 谁打掉的多谁赢；有队伍就按队伍总分算。
  // 复用：BOSS_MINIONS（岩窟兽 / 冰霜企鹅 / 血魔 / 巨鲸鲨）+ 小怪走路&攻击动作
  //      + 赛艇主炮 BoatWeapons（J 键，弹道/过热/炮口特效全现成）。
  DEFENSE: {
    LAYER: 5,                // 第 6 层（layerY=90、layerRadius=41）
    DURATION: 75,
    WAVE_FIRST: 2.0,
    WAVE_INTERVAL: 6.0,
    MAX_ALIVE: 10,           // 同屏最多几只（再多主炮就成割草，看不出层次）
    SPAWN_R: 0.9,            // 出生在层半径 90% 的边缘圈
    // 血量压到原版 16%：岩窟兽 42 / 企鹅 35 / 血魔 72 / 巨鲸鲨 144。
    // 实测依据（2026-11-25）：默认艇单发 5 伤、0.18s 节奏（受 100 热上限 + 2.4s 过热压制，
    // 实际 ~9dps），原 32% 时一只岩窟兽要打满 9 秒，75 秒内根本打不出层次；
    // 16% 后常规艇（21~30 伤）2~4 发一只，新手艇 8~12 发，配合 6 秒一波刚好够抢。
    HP_MUL: 0.16,
    SPEED_MUL: 0.9,
    // 击杀积分（精英更值钱，鼓励先打大的）
    POINTS: { beast: 1, penguin: 1, blood: 2, whale_shark: 3 },
    // 每波解锁新怪种：前两波只有岩窟兽，之后逐层加压
    UNLOCK: { penguin: 3, blood: 5, whale_shark: 7 },
    RAM_DMG: 0.9,            // 撞怪伤害 = 船速 × 0.9（沿用怪物模式口径）
    HURT_STUN: 0.35,         // 被怪挠到：短暂失控 + 击退（天梯没血条，不扣血）
    HURT_PUSH: 6,
    RANGED_CD: 3.2,          // 血魔/巨鲸鲨的远程弹
    RANGED_SPEED: 24,
    RANGED_DMG: 1,           // 只用于飘字，不给玩家扣血
    SCORE_RANK: [6, 3, 1],
    POLE_COUNT: 6,
    ARCH_COUNT: 2,          // 场边拱门（shortcut_arch.glb，只留 2 座）
  },
  // ---- 第 7 层：缩圈 · 累计里程竞速 ----
  // 用户口径（2026-11-25）：圈一直缩，船在里面漂移/直线跑都算里程，
  // 谁（或哪队总和）跑得远谁赢；掉下去扣里程；圈缩到一定半径就停，别太狠。
  SHRINK: {
    LAYER: 6,                // 第 7 层（layerY=108、layerRadius=35）
    DURATION: 75,
    R0: 0.98,                // 起始安全圈 = 层半径 × 0.98（约 34.3m）
    R1: 16,                  // 终点半径：缩到这里就停（用户口径 35→16）
    SHRINK_TIME: 60,         // 60 秒匀速收完，最后 15 秒稳定小圈
    WALL_H: 7,               // 圈墙高度（淡青光幕，禁 AdditiveBlending）
    MIN_STEP: 0.02,          // 单帧位移小于它不计（抖动噪声）
    MAX_STEP: 6,             // 单帧位移大于它当作传送（重生/回写），不计里程
    OUT_GRACE: 1.6,          // 圈外停留多久掉下去（给一次回头的机会）
    FALL_PENALTY: 80,        // 掉下去扣的里程（米）
    RESPAWN_R: 0.55,         // 抓回来落在安全圈半径的 55%
    RESPAWN_INVULN: 1.2,
    AI_R: 0.62,              // AI 绕圈半径 = 安全圈 × 0.62
    AI_W: 0.5,               // AI 绕圈角速度（rad/s）
    AI_EDGE: 7,              // AI 距安全圈/平台边小于这个值就往塔心跑（顶速 25m/s 的刹车距离）
    SCORE_RANK: [6, 3, 1],
    POLE_COUNT: 6,
    ARCH_COUNT: 2,          // 场边石拱（canyon/arch.glb）
  },
  // ---- 第 8 层：水晶攻防 ----
  // 用户口径（2026-11-26）：每队一座水晶，先打碎对方直接获胜；75 秒没碎比剩余段数。
  // 伤害只有两种：冲撞（速度越高越高）+ 泡泡/道具；本层不给主炮。
  // 场上刷道具箱（捡到给泡泡炸弹），水晶开场 5 秒护罩，不能修。
  CRYSTAL: {
    LAYER: 7,                // 第 8 层（layerY=126、layerRadius=30）
    DURATION: 75,
    CRYSTAL_X: 24,           // 水晶 |x|：平台半径 30 再往里 6m
    CRYSTAL_R: 2.8,          // 冲撞命中半径
    SEGMENTS: 3,             // 3 段耐久
    SEG_HP: 100,             // 每段 100 点
    SHIELD: 5,               // 开场护罩（秒）
    RAM_MIN: 7,              // 低于这个相对速度撞不动水晶
    RAM_BASE: 14,
    RAM_PER_SPEED: 1.5,      // 22m/s 撞击 ≈ 47 点
    RAM_CD: 0.85,
    BUBBLE_DMG: 45,          // 一发泡泡炸弹
    BUBBLE_CHARGE_MAX: 2,    // 最多攒 2 发
    BUBBLE_SPEED: 30,        // 泡泡飞行速度（m/s）
    BUBBLE_R: 6,             // 爆炸波及半径（顺便把守军推开）
    BOX_COUNT: 6,
    BOX_RESPAWN: 6,
    // 掩体：两块礁石 + 两根旋转障碍（都用现成 GLB），collider 是静态圆
    ROCKS: [
      { x: 0, z: 12.5, r: 3.0, glb: 'rock_hazard_a.glb', size: 6.0 },
      { x: 0, z: -12.5, r: 3.0, glb: 'rock_hazard_b.glb', size: 6.0 },
    ],
    ROTORS: [
      { x: 10.5, z: 0, r: 1.7, size: 4.2 },
      { x: -10.5, z: 0, r: 1.7, size: 4.2 },
    ],
    SCORE_RANK: [6, 3, 1],
    POLE_COUNT: 6,
    ARCH_COUNT: 2,          // 场边旗门（flag_gate.glb）
  },
  // ---- 第 9 层：涂地竞速 ----
  // 用户口径（2026-11-26）：船尾自动留色，最后 15 秒效率 ×2；地面按网格归属，
  // 对手可以覆盖，撞人让对手「断笔」1.5 秒，泡泡炸掉半径 4m 的颜色。
  // 只碰撞 + 涂色，不刷拾取物。
  PAINT: {
    LAYER: 8,                // 第 9 层（layerY=144、layerRadius=26）
    DURATION: 75,
    CELL: 1.2,               // 1.2m 网格（26m 半径 ≈ 43×43 格）
    BRUSH_R: 2.4,            // 常态涂抹半径
    BRUSH_BACK: 1.6,         // 落笔点在船尾后方多远
    BOOST_WIDTH: 1.8,        // 冲刺时涂宽倍率
    FINAL_RUSH: 15,          // 最后 15 秒
    FINAL_MULT: 2,           // 效率 ×2
    INK_BREAK: 1.5,          // 被撞后断笔时长
    RAM_MIN: 8,              // 撞人断笔的最小相对速度
    RAM_CD: 0.8,
    BUBBLE_R: 4,             // 泡泡清除半径
    BUBBLE_CD: 3,
    ICEBERGS: 4,             // 场边冰山（iceberg_small.glb）
    ROTORS: 2,
    SCORE_RANK: [6, 3, 1],
    POLE_COUNT: 6,
  },
  // ---- 第 10 层：加冕仪式（抢皇冠） ----
  // 用户口径（2026-11-26）：皇冠从塔顶落到绕塔 8m 的随机点，抢到后变慢、不能冲刺；
  // 每队一个 ±x 加冕区，在自家区里连续站 3 秒加冕一次 +8 分；
  // 被撞/泡泡命中会掉冠并弹开，掉平台本层边缘复活、皇冠留在原地。
  // 90 秒打满比加冕次数。排名分沿用 [6,3,1]。
  CROWN: {
    LAYER: 9,                // 第 10 层（layerY=162、layerRadius=22）
    DURATION: 90,
    SPAWN_R: 8,              // 皇冠落点绕塔半径
    PICK_R: 3.2,             // 拾取半径
    DROP_LOCK: 2,            // 掉冠后多久才能再次拾取
    SPAWN_LOCK: 1.5,         // 开场落地后多久可抢
    HOLD_SPEED: 0.78,        // 持冠极速倍率
    ZONE_X: 15,              // 加冕区中心 |x|
    ZONE_R: 4.5,             // 加冕区半径
    HOLD_TIME: 3,            // 连续站 3 秒
    SCORE_CROWN: 8,          // 每次加冕 +8
    RAM_MIN: 8,
    RAM_CD: 0.9,
    KNOCK: 8,                // 掉冠弹开距离
    BUBBLE_R: 5,
    BUBBLE_FUSE: 2.0,
    BUBBLE_CD: 2.5,
    ROTORS: 2,
    SCORE_RANK: [6, 3, 1],
    POLE_COUNT: 6,
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
  // ---- 海面（2026-11-24）：第一层浮在竞技场那片水上 ----
  // 水面整块下移 6m：第一层玻璃盘顶面在 +0.3，往下看 6m 才是海面，
  // 既不会让浪打到玻璃上，又让"塔浮在水上"读得出来。数值直接喂给
  // Game 的 water.mesh.position.y（见 Game 构造函数天梯分支）。
  WATER_Y: -6,
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

