// 赛艇数据：8 艘 —— 磐石号 / 牛来号 + 6 艘轻量化「未来载具」
// 物理单位：米、米/秒
//
// 2026-11-13 第二次换装：用户在微信里给了 6 个 tripo 未来的载具 GLB（原来 26~50 万面、
// 10~18MB），统一走 scripts/boats/slim_boats.py 轻量化到 13 万面 + 2048² 图集（≈4.3~5.2MB）。
// 该脚本同时把模型**去旋转**（tripo 的模型在自身空间里是斜的）、船头对齐 +Z、
// 船底压到 y=0、船长归一到 1.0 —— 所以这 6 艘不需要 modelScale / modelRotationY，
// 只用 modelLiftY 压吃水线。
//
// 2026-11-15：用户反馈「有的时候压水还是太深」，全体赛艇在 2026-11-13 的水线基础上
// **再上浮 2cm**（modelLiftY 每个 +0.02，磐石号从"无值 = 0"改成 +0.02）。这是一个纯
// 视觉水线偏移，不动 BOAT_HANDLING / 浮力 / 碰撞。
//
// 参数不做任何改动：6 个 id 直接沿用被替换掉的旧船数值（含 BOAT_HANDLING / BOAT_WEAPONS），
// 只换 model / name / desc / color，保证手感与怪物模式 DPS 不变。旧 7 艘里
// 「远洋拖网船 trawler」是砍掉的那一套（最慢最肉，和磐石号 28 速 / 稳 0.95 / 宽 2.3 撞生态位）。

export const BOATS = [
  {
    id: 'rower',
    name: '赤焰号',
    desc: '正红敞篷快艇，船体最短、转向最紧，直道极速第一梯队',
    color: 0xdc3a32,       // 主色
    colorAccent: 0xffd9cf, // 副色
    // 模型来源：3d模型 快速艇.glb（原 45 万面 / 14.8MB → 13 万面 / 4.4MB）
    model: '/models/boat_speedboat.glb',
    // 轻量化时已把船头对齐到 +Z、船底压到 y=0，这里只把吃水线压下去（≈6% 船长）
    modelLiftY: -0.26,
    // 物理参数；HUD 属性条由这些实际数值生成。
    // 2026-09 氮气调速：普通极速保持不变；氮气极速单独提升到 1.8x。
    maxSpeed: 34,
    accel: 14,
    reverseSpeed: 3.5,   // 倒车速度
    turnRate: 1.35,      // 转向角速度 rad/s
    grip: 5.2,           // 侧向抓地（越大越不漂）
    drag: 0.32,          // 水阻系数
    stability: 0.35,     // 碰撞稳定系数（越高撞击损失越小）
    boostPower: 1.8,     // 氮气推力/极速倍率（与普通航行明确区分）
    boostDuration: 2.4,  // 氮气时长 s
    boostCooldown: 6.0,  // 氮气冷却 s
    // 外观比例
    hull: { length: 4.4, width: 1.6, bow: 1.3 },
  },
  {
    id: 'skiff',
    name: '绯鲨号',
    desc: '珊瑚红双体艇，双体压低重心，稳健耐撞、过弯灵活',
    color: 0xf4655c,
    colorAccent: 0x9af0f5,
    // 模型来源：3d模型 红色飞行汽车.glb（原 27 万面 / 9.7MB → 13 万面 / 4.3MB）
    // 双体船的艏柱是横向分开的两片，整个船长方向都保持 ~0.68×船长 的宽度，
    // 所以碰撞宽按真实视觉宽取 3.2（4.8 × 0.68），否则擦墙时外侧船体会压进岸线。
    model: '/models/boat_redcar.glb',
    modelLiftY: -0.29,
    maxSpeed: 29,
    accel: 12,
    reverseSpeed: 4,
    turnRate: 1.6,
    grip: 6.5,
    drag: 0.36,
    stability: 0.85,
    boostPower: 1.8,     // 氮气极速=1.8×正常极速
    boostDuration: 2.2,
    boostCooldown: 5.5,
    hull: { length: 4.8, width: 3.2, bow: 0.9 },
  },
  {
    id: 'falcon',
    name: '青锋号',
    desc: '薄荷青装甲艇，大尾翼加双喷口，极速恐怖、碰撞易失控',
    color: 0x3ecfb4,
    colorAccent: 0xffa24a,
    // 模型来源：未来汽车3d模型.glb（原 42 万面 / 14.3MB → 13 万面 / 4.5MB）
    model: '/models/boat_car6.glb',
    modelLiftY: -0.31,
    // 极速/加速最强；氮气阶段使用独立的 1.8x 极速倍率。
    maxSpeed: 36,
    accel: 15.5,
    reverseSpeed: 3.5,   // 倒车速度
    turnRate: 1.32,      // 转向角速度 rad/s（漂移拉车头偏慢）
    grip: 5.0,           // 侧向抓地（越大越不漂）
    drag: 0.30,          // 水阻系数
    stability: 0.30,     // 碰撞稳定系数（撞人占便宜，被撞吃亏）
    boostPower: 1.8,     // 氮气推力倍率（极速船氮气更猛）
    boostDuration: 2.4,  // 氮气时长 s
    boostCooldown: 6.0,  // 氮气冷却 s
    // 外观比例
    hull: { length: 5.2, width: 1.6, bow: 1.3 },
  },
  {
    id: 'titan',
    name: '磐石号',
    desc: '老式炮舰，稳如泰山，能把对手撞出赛道',
    color: 0x3f7fe8,
    colorAccent: 0xc8e0ff,
    // 2026-11-16 换模型：base_basic_shaded.glb（原 15.6MB / 35.3 万面 / 2048² PNG）
    //   → scripts/blender/optimize_boat_glb.py 焊接 + 减面 + 贴图 1024 JPEG
    //   → boat_ironside.glb（1.7MB / 6 万面 / 30k 顶点）
    //   材质从「底色纯黑 + 全靠自发光贴图」改成 baseColor 走同一张贴图，夜里不会整船发光。
    model: '/models/boat_ironside.glb',
    // 原模型沿 +Z 建模（包围盒 z 长 1.77 / x 宽 0.89），和 frickies_yacht 同一朝向。
    modelRotationY: 0,
    // 磐石号原来没写 modelLiftY（= 0，完全走通用的 35% 吃水规则）。
    // 2026-11-15 全体上浮 2cm 时给它补上 +0.02，和其它 7 艘保持一致。
    modelLiftY: 0.02,
    // 稳定最高且船体较宽，船间碰撞时等效质量最大。
    maxSpeed: 28,
    accel: 11.5,
    reverseSpeed: 4,
    turnRate: 1.5,
    grip: 6.8,
    drag: 0.38,
    stability: 0.95,
    boostPower: 1.8,     // 氮气极速=1.8×正常极速
    boostDuration: 2.2,
    boostCooldown: 5.5,
    hull: { length: 4.6, width: 2.3, bow: 0.9 },
  },
  {
    id: 'dolphin',
    name: '流光号',
    desc: '冷白宽体飞行艇，紫光环座舱，均衡全面、漂移拉车头最快',
    color: 0xe8ecf4,
    colorAccent: 0xb08cff,
    // 模型来源：未来飞行汽车3d模型.glb（原 50 万面 / 17.6MB → 13 万面 / 5.2MB）
    model: '/models/boat_flycar.glb',
    modelLiftY: -0.30,
    // 转向最高，普通转向与漂移拉车头都更快。
    maxSpeed: 32,
    accel: 13,
    reverseSpeed: 3.75,
    turnRate: 1.62,
    grip: 5.6,
    drag: 0.33,
    stability: 0.6,
    boostPower: 1.8,     // 氮气极速=1.8×正常极速
    boostDuration: 2.5,
    boostCooldown: 6.0,
    hull: { length: 5.0, width: 1.9, bow: 1.1 },
  },
  {
    id: 'vintage',
    name: '琥珀号',
    desc: '琥珀色单座喷气艇，船身最窄，转向刁钻，极速一般',
    color: 0xe8c78a,
    colorAccent: 0x8fe3ff,
    // 模型来源：未来喷气艇3d模型.glb（原 26 万面 / 9.5MB → 13 万面 / 4.3MB）
    model: '/models/boat_jetboat.glb',
    modelLiftY: -0.27,
    // 转向/抓地强、极速偏弱：适合在窄河道用走线吃弯
    maxSpeed: 30,
    accel: 12.8,
    reverseSpeed: 4,
    turnRate: 1.58,
    grip: 6.2,
    drag: 0.35,
    stability: 0.62,
    boostPower: 1.8,
    boostDuration: 2.3,
    boostCooldown: 5.6,
    hull: { length: 4.5, width: 1.7, bow: 1.1 },
  },
  {
    id: 'longship',
    name: '长鲸号',
    desc: '灰蓝金属长身艇，龙骨修长，直道压制力极强',
    color: 0x6b86b8,
    colorAccent: 0xff8a5c,
    // 模型来源：未来船艇3d模型.glb（原 31 万面 / 10.7MB → 13 万面 / 4.3MB）
    model: '/models/boat_ship.glb',
    modelLiftY: -0.36,
    // 船体最长（6.6m），碰撞等效质量大；极速高但转向半径明显更大
    maxSpeed: 34,
    accel: 13.8,
    reverseSpeed: 3.5,
    turnRate: 1.18,
    grip: 4.7,
    drag: 0.31,
    stability: 0.72,
    boostPower: 1.8,
    boostDuration: 2.4,
    boostCooldown: 6.0,
    hull: { length: 6.6, width: 1.9, bow: 1.4 },
  },
  {
    id: 'cow',
    name: '牛来号',
    desc: '一头把自己当船的牛，四条腿就是引擎；提速最快、转向最灵，但皮薄怕撞',
    color: 0xf0c24a,
    colorAccent: 0xfff4c8,
    model: '/models/cow_rider.glb',
    // cow_rider.glb 在 Blender 里朝 -Y，导 glTF 的 Y-up 转换后正好朝 +Z。
    modelRotationY: 0,
    // 竖着站的角色，不能用"最长边 = 船长"来缩，否则会被拉成 9m 高。
    // 按身高定标：模型原始高 2.61m，这里放到 3.0m —— 1:1 的真牛在追尾镜头里
    // 只有 12% 屏高，小得像个摆件；3.0 才有"载具"的存在感，又不至于糊住赛道。
    fitTo: 'height',
    fitHeight: 3.0,
    // 追尾镜头按艇型微调（CameraRig 只做加法，其他船不填就是原值）：
    // 站着的角色比平放的船高一截，机位稍微退后抬高一点，视野才不被牛背挡住。
    camera: { dist: 0.5, height: 0.35 },
    // 蹄子往下埋 0.25m：站在水面上会像贴图，入水一点才像"涉水的牛"
    modelLiftY: -0.23,
    // 四条腿的行走与冲刺动画；boost 在氮气期间循环播放
    anim: { walk: 'cow_walk', boost: 'cow_boost', dance: 'cow_dance', smile: 'cow_smile' },
    smileMorph: 'smile',
    // 起步/转向全场最快，极速中上；船体小 = 受弹面积小（怪物模式吃香），
    // 但稳定性低、碰撞等效质量也小，被顶一下就飞。
    maxSpeed: 32.5,
    accel: 15.2,
    reverseSpeed: 4.5,
    turnRate: 1.56,
    grip: 6.6,
    drag: 0.335,
    stability: 0.52,
    boostPower: 1.8,
    // 氮气"时长最长、冷却最短"是全船唯一的差异点（倍率仍是全场统一的 1.8x，
    // tests/gameplay.test.mjs 对此有断言），所以开局压制力靠频率堆出来
    boostDuration: 2.9,
    boostCooldown: 4.8,
    hull: { length: 2.9, width: 1.35, bow: 0.75 },
  },
];

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// ---------- 船体手感（"半重"档的逐船差异）----------
// 这组数直接喂给 Boat 的积分器，决定"肉"的程度：
//   spool     油门/桨响应时间常数（秒，越大起步越肉）
//   yawScale  转向峰值倍率（乘在 turnRate 上，越大越灵）
//   yawTau    转向角速度惯性（秒，越大船头越"甩半拍"）
//   coastDrag 松油门滑行阻尼倍率（越大滑得越短）
//   driftDrag 漂移减速的"拖曳力度"：把速度拖回漂移上限（直道 94%）的**速率**系数，
//             不再是入漂掉速。越大 = 拖得越快、漂移越"黏"；越小 = 越丝滑（托漂更明显）。
//   driftAngle 漂移滑移角上限倍率（1.0 = 满速 39°）。轻艇角度更大、长船更小。
//   driftRate  起漂/回正的建角角速度倍率（越大越"脆"，越小越"绵"）。
//   driftYaw   漂移中轨迹偏航倍率（越大 = 同样的方向键把弯压得越紧）。
export const DEFAULT_HANDLING = {
  spool: 0.55,
  yawScale: 0.82,
  yawTau: 0.34,
  coastDrag: 0.33,
  driftDrag: 0.55,
  driftAngle: 1.0,
  driftRate: 1.0,
  driftYaw: 1.0,
};

// 逐船调校：轻艇灵活、长身惯性大、双体最稳
// spool 和面板加速对齐：面板加速高的船响应也更快（实测 0→20m/s 的顺序一致）。
// 漂移三件套（driftAngle / driftRate / driftYaw）按"船的性格"分：
//   轻敏（绯鲨/流光/牛来）→ 角度大、建角快、压弯紧，但拖曳也更快
//   长重（长鲸/青锋/磐石）→ 角度小、建角绵、弯道半径大，拖漂更保速
//   复古（琥珀）→ 角度中等、建角慢、保速最好（老船的"飘"）
const BOAT_HANDLING = {
  rower:   { spool: 0.58, yawScale: 0.78, yawTau: 0.36, coastDrag: 0.30, driftDrag: 0.62, driftAngle: 0.98, driftRate: 0.94, driftYaw: 1.02 },
  skiff:   { spool: 0.42, yawScale: 0.92, yawTau: 0.24, coastDrag: 0.36, driftDrag: 0.45, driftAngle: 1.08, driftRate: 1.14, driftYaw: 1.10 },
  falcon:  { spool: 0.62, yawScale: 0.72, yawTau: 0.40, coastDrag: 0.28, driftDrag: 0.66, driftAngle: 0.94, driftRate: 0.90, driftYaw: 0.94 },
  titan:   { spool: 0.50, yawScale: 0.74, yawTau: 0.42, coastDrag: 0.44, driftDrag: 0.75, driftAngle: 0.90, driftRate: 0.86, driftYaw: 0.92 },
  dolphin: { spool: 0.48, yawScale: 0.94, yawTau: 0.28, coastDrag: 0.32, driftDrag: 0.52, driftAngle: 1.05, driftRate: 1.08, driftYaw: 1.06 },
  vintage: { spool: 0.55, yawScale: 0.70, yawTau: 0.52, coastDrag: 0.24, driftDrag: 0.42, driftAngle: 1.00, driftRate: 0.80, driftYaw: 1.04 },
  longship:{ spool: 0.60, yawScale: 0.68, yawTau: 0.46, coastDrag: 0.22, driftDrag: 0.68, driftAngle: 0.92, driftRate: 0.84, driftYaw: 0.90 },
  // 牛来号：四腿起步最灵敏、船头指向最跟手，但滑行惯性最短（没有船体吃水）
  cow:     { spool: 0.34, yawScale: 0.96, yawTau: 0.20, coastDrag: 0.34, driftDrag: 0.44, driftAngle: 1.10, driftRate: 1.18, driftYaw: 1.12 },
};

/** 取某条船最终生效的手感参数（缺项用默认值补齐） */
export function boatHandling(def) {
  return { ...DEFAULT_HANDLING, ...(def?.handling || {}) };
}

/** HUD values derived from the same parameters consumed by Boat physics. */
export function boatStatProfile(def) {
  const h = boatHandling(def);
  // 实际转向峰值 = turnRate × yawScale（Boat.js 的普通转向和漂移拉车头都用它），
  // HUD 必须按同一个值归一化，否则会出现"面板转向高、实际却更笨"的假数值。
  const turnPeak = def.turnRate * h.yawScale;
  return {
    speed: clamp01((def.maxSpeed - 20) / 16),
    accel: clamp01((def.accel - 10) / 6),
    turn: clamp01((turnPeak - 0.72) / 0.82),
    stability: clamp01(def.stability),
    // 漂移：漂移时越保速越好压漂（driftDrag 0.42 最好 → 1.0，0.80 最差 → 0.27）
    drift: clamp01((0.95 - h.driftDrag) / 0.55),
    // 滑行：松油门后滑得越远越好。实际减速 = def.drag × (coastDrag + 速度平方项)，
    // 只算 coastDrag 会漏掉水阻差异（青锋号会被误判成比琥珀号滑得近）。
    // 这里按半速（平方项 0.25）折算，和玩家实际松油门的区间一致。
    glide: clamp01((0.30 - def.drag * (h.coastDrag + 0.25)) / 0.16),
  };
}

/** Effective planar mass for bounded boat-to-boat collision response. */
export function boatCollisionMass(def) {
  const hullArea = Math.max(1, (def.hull?.length || 4) * (def.hull?.width || 1.6));
  // 稳定性是主项：面板上稳定更高的船，等效质量必须更大，才能真的把对手顶开。
  // 旧公式里船体面积占主导，会出现"稳定 72 的长船撞飞稳定 85 的轻艇"的反直觉结果，
  // 所以面积只保留一点尺寸修正，不再压过 stability 的排序。
  return 1.6 + clamp01(def.stability) * 3.4 + Math.sqrt(hullArea) * 0.12;
}

for (const boat of BOATS) {
  boat.handling = boatHandling({ handling: BOAT_HANDLING[boat.id] });
  boat.stats = boatStatProfile(boat);
}

export function getBoat(id) {
  return BOATS.find((b) => b.id === id) || BOATS[2];
}

// ---------- 海克斯：随机赛艇的数值压缩 ----------
// 海克斯每局随机发艇，慢船（磐石号 28 速）在躲技能时明显吃亏。
// 只压缩「极速 / 加速 / 转向」三项面板数值，把全船差异等比压到均值 ±8%；
// 漂移、抓地、惯性等手感参数保持原样，随机到不同船仍有各自的性格。
const HEX_STAT_KEYS = ['maxSpeed', 'accel', 'turnRate'];
const HEX_STAT_SPREAD = 0.08;
const hexStatRange = (() => {
  const out = {};
  for (const key of HEX_STAT_KEYS) {
    const vals = BOATS.map((b) => b[key]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    // 最大偏离比例：用它把最慢/最快的船压到正好 ±8%
    const maxDev = Math.max(...vals.map((v) => Math.abs(v / mean - 1))) || 1;
    out[key] = { mean, maxDev };
  }
  return out;
})();

/** 海克斯联机/单人通用：返回一艘数值压缩后的赛艇副本（不修改原定义） */
export function hexBoatDef(def) {
  const out = { ...def };
  for (const key of HEX_STAT_KEYS) {
    const { mean, maxDev } = hexStatRange[key];
    const ratio = def[key] / mean;
    out[key] = Math.round(mean * (1 + ((ratio - 1) / maxDev) * HEX_STAT_SPREAD) * 100) / 100;
  }
  return out;
}
