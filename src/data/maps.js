import { BAKED_TRACK } from './baked-track.js';
// 地图数据
// gates: 赛道门（按序通过即完成一圈），w = 判定半径(米)
// rocks: 圆形碰撞障碍 { x, z, r(碰撞半径), s(视觉缩放) }
// boundary: 圆形赛道外边界，越界会被推回
//
// courseProps: 赛道道具（GLB 布景 + 机关），见 Track.#buildCourseProps
//   kind: 'flag'   起跑/赛段旗门（跨越赛道的装饰拱门，无碰撞）
//         'portal' 加速传送门（穿过即获得 3.2s 氮气）
//         'hammer' 旋转锤障碍（抡臂横扫，擦到就掉速失控）
//         'whirl'  漩涡警示区（向心吸力 + 切向带动）
//   at:   期望出现的圈程比例（0~1），实现时取最近的"干净"门，自动避开近道/
//         过山车/潜行/管道/旋转门/弹射链/伸缩柱，所以填了也不会撞车
//   gate: 可选，强制指定门索引（填了就不再自动挑选）
//   side: 可选，横向偏移（-1 左舷 ~ 1 右舷，按 gateWidth/2 计），默认各 kind 自己的值
//
// 水面赛道专用字段（目前只有 tide 用）：
//   noMountains: true      关掉远景山脊与远岛，得到纯水平面
//   iceZone: {x,z,r}       冰原判定域，命中后 grip/slip/driftGain 生效（见 Game.#surfaceAt）
//   current: {x,z,r,dir}   潮汐水域：dir 为水流方向，period 秒翻面一次，weatherMul 按天气缩放
//   navBeacons: {...}      导航灯船光带，沿赛道外缘等距排布，雾天是主要参照物
//
// startWidth: 起点线的完整横向宽度(米)。起点旗门的两根柱子、水面方格线、
//   计圈判定全部按这个宽度横跨，保证从左右任一缝隙过线都能计圈；
//   不填时退回 gateWidth * 3。

export const MAPS = [
  {
    id: 'canyon',
    name: '峡谷激流',
    icon: '🏔️',
    desc: '狭窄S形河道，暗礁密布，考验操艇技术',
    laps: 3,
    style: 'canyon',
    waterColor: 0x2e6b62,
    waterDeep: 0x123632,
    // 峡谷整体走青灰绿冷调：雾色从暖沙色改为冷灰绿，近景岩石不许出现暖棕
    fogColor: 0xbfcbc4,
    fogDensity: 0.0038,
    skyTop: 0x8db8dd,
    skyBottom: 0xf2d8a9,
    sunColor: 0xfff2dd,
    gateWidth: 10,
    startWidth: 32,
    // The canyon's right-side rock hides the default solo chase-camera view.
    // Positive lateral is the driver's left for this opening straight.
    soloStartLateral: 4.5,
    boundary: { x: 0, z: 0, r: 265 },
    // 起点整体前移到原来 1 号门（上图红色标注处）：旧 0 号门正好压在
    // gate23→gate0→gate1 的近 90° 急弯上，起点线几乎与来船方向平行，
    // 从右侧绕过去可以整段跳过计圈判定（玩家反馈的“穿缝隙不计圈”）。
    // 现在 0 号门落在直道上，来船方向与门线接近垂直，左右都有浮桶收口。
    gates: [
      [14, -102], [24, -64], [52, -40], [86, -34],
      [112, -12], [118, 24], [100, 56], [68, 68], [36, 60],
      [12, 76], [0, 108], [-6, 142], [-34, 158], [-64, 148],
      [-78, 116], [-66, 84], [-40, 68], [-24, 40], [-30, 6],
      [-52, -20], [-60, -56], [-52, -96], [-40, -126], [0, -140],
    ],
    rocks: [
      { x: 62, z: -8, r: 4.5, s: 1.2 },
      { x: 96, z: 40, r: 4, s: 1.0 },
      { x: 44, z: 55, r: 3.5, s: 0.9 },
      { x: 40, z: 72, r: 3.5, s: 0.9 },
      // Kept clear of the dedicated west-side shortcut corridor.
      { x: -92, z: 86, r: 4.5, s: 1.1 },
      { x: -14, z: -108, r: 4, s: 1.0 },
      { x: -50, z: -40, r: 3.5, s: 0.9 },
      { x: 84, z: -30, r: 3, s: 0.8 },
      { x: -68, z: 100, r: 3, s: 0.8 },
    ],
    shortcuts: [
      // 西侧内圈切弯：主道 #9→#13（圈程 42%~58%）。
      // 构造方式（见 node_modules/.tmp/solve2.mjs 求解 + 逐米审计）：
      //   ① 两端从门点垂直脱离主道走廊，脱离点距主道中线 15.1m（= gateWidth + 半近道宽 + 余量）；
      //   ② 中段走弯内侧弦线，全程距主道中线 ≥ 15.1m，绝不插进主赛道；
      //   ③ 首尾端点就是 gates[9]/gates[13] 本体，Track 端点吸附后位置不变。
      // 主道 133m → 近道 118m（省 11%）。
      {
        from: 9,
        to: 13,
        width: 3.4,
        points: [[12, 76], [0, 67], [-13, 84], [-26, 101], [-39, 118], [-52, 136], [-64, 148]],
      },
    ],
    // Dedicated offshore result scene: clear of the river course and canyon props.
    podium: { x: -205, z: -205, heading: 0 },
    // 峡谷：窄河道具偏一侧，主轴始终留一条可过的干净线
    courseProps: [
      { kind: 'flag', at: 0.0 },
      { kind: 'portal', at: 0.30 },
      { kind: 'hammer', at: 0.56, side: 1.3 },
      { kind: 'whirl', at: 0.80, side: -1.15 },
    ],
    marineFeatures: {
      boostGate: 1, boostSide: -0.45, buoyGate: 11, buoySide: 0.15,
      // 弹射链（3 组紧凑）：15-16 段起，避开近道(9-13)与浮标(11)；窄河道收窄摆幅
      launchChain: { startGate: 15, count: 3, side: 0.25, weave: 1.0, pairGap: 1.6, halfSide: 2.2, speed: 28 },
    },
  },
  {
    id: 'lake',
    name: '湖泊环线',
    icon: '🏝️',
    desc: '宽阔水面绕岛竞速，浮标弯道比拼极速',
    laps: 3,
    style: 'lake',
    // 水色：原来的 0x30b4c8 是"度假海亮青"，压到深海青绿。
    // 深水色必须跟着压——只改浅色会让近处墨绿、远处电蓝，色相在画面中间断层。
    // 而且掠射角下 pathLen 极大、absorb≈1，屏幕上绝大部分其实取的是**深水色**，
    // 所以深水色的色相才是决定观感的那个：蓝多一分就整片偏钢蓝，青多一分才是海水。
    waterColor: 0x1a5f5e,
    waterDeep: 0x0e3a38,
    waterCrest: 0xa8f0ea,
    fogColor: 0xc4dff0,
    fogDensity: 0.0026,
    skyTop: 0x5fa8dd,
    skyBottom: 0xdff0fa,
    sunColor: 0xfff4dd,
    gateWidth: 16,
    startWidth: 51,
    boundary: { x: 0, z: 0, r: 245 },
    gates: (() => {
      const pts = [];
      const N = 16;
      const RX = 130;
      const RZ = 88;
      for (let i = 0; i < N; i++) {
        const a = -Math.PI / 2 + (i / N) * Math.PI * 2;
        pts.push([Math.round(Math.cos(a) * RX), Math.round(Math.sin(a) * RZ)]);
      }
      return pts;
    })(),
    rocks: [
      { x: 92, z: -62, r: 4, s: 1.0 },
      { x: -96, z: 58, r: 4, s: 1.0 },
      { x: 40, z: 92, r: 3.5, s: 0.9 },
      { x: -34, z: -92, r: 3.5, s: 0.9 },
    ],
    islands: [
      { x: 0, z: 0, r: 24, h: 3 },
      { x: 58, z: 26, r: 11, h: 2.2 },
      { x: -62, z: -18, r: 14, h: 2.4 },
    ],
    shortcuts: [
      // 内圈切弯：主道 #8→#13（圈程 50%~80%），贴着岛屿环内侧走西北弧。
      // 两端脱离点距主道中线 19.9m，中段弦线全程 ≥ 20.7m，与三座岛屿/暗礁均保持净空。
      // 主道 207m → 近道 178m（省 14%）。
      { from: 8, to: 13, width: 4.0, points: [[0, 88], [-0.2, 66.6], [-34, 37], [-68, 7], [-101.2, -22.8], [-120, -34]] },
    ],
    // 金龙过山车（自动轨道）：进入触发区后锁定操控，沿金色龙脊 spline 自动飞驰
    // 挪至西侧 10→14 段；前半圈纯竞速、后段腾空冲刺。近道 #8→#13 走的是内侧弦线。
    coaster: {
      mode: 'auto',
      from: 10,
      to: 14,
      launchDist: 22,
      apex: 14,
      entryDepth: 0,
    },
    // Southwest open water, outside both the island ring and shortcut corridors.
    podium: { x: -190, z: -160, heading: 0 },
    // 湖泊：宽水面路线多，漩涡放在偏侧不挡主环线
    courseProps: [
      { kind: 'flag', at: 0.0 },
      { kind: 'portal', at: 0.26 },
      { kind: 'hammer', at: 0.60, side: -1.3 },
      { kind: 'whirl', at: 0.82, side: 1.15 },
    ],
    marineFeatures: {
      boostGate: 1, boostSide: 0.52, buoyGate: 7, buoySide: -0.2,
      // 弹射链（4 组标准）：东弧 2→6 段（远离起点；旧 14 段起的链尾会扫到起点线）
      launchChain: { startGate: 2, count: 4, side: 0.2, weave: 2.6, speed: 28 },
    },
  },
  {
    id: 'ocean',
    name: '峡谷险道',
    icon: '🌊',
    desc: '29 个连弯 + 360° 立交环 + 礁石阵（已审计可通行），噩梦级技术图',
    laps: 2,
    style: 'ocean',
    // 同湖泊：0x2fc8c8 → 深海青绿，深水色一起压，避免色相断层
    waterColor: 0x1a5f5e,
    waterDeep: 0x0e3a3a,
    waterCrest: 0x9ff2ee,
    fogColor: 0xbfe6f7,
    fogDensity: 0.0019,
    skyTop: 0x3f9ff0,
    skyBottom: 0xcdeeff,
    sunColor: 0xfff8e8,
    // 航道全宽 15m（半宽 7.5）——比原来窄一半，弯多且急
    gateWidth: 7.5,
    startWidth: 24,
    boundary: { x: 0, z: 0, r: 840 },
    gates: [
      [0, 0],
      [1, -46],
      [32, -76],
      [76, -76],
      [121, -76],
      [166, -76],
      [212, -76],
      [257, -76],
      [301, -76],
      [343, -64],
      [385, -65],
      [427, -76],
      [468, -63],
      [509, -61],
      [550, -76],
      [592, -62],
      [632, -57],
      [671, -76],
      [711, -65],
      [750, -51],
      [788, -76],
      [818, -50],
      [818, -5],
      [800, 35],
      [760, 27],
      [759, -14],
      [798, -24],
      [818, 14],
      [818, 58],
      [790, 88],
      [745, 88],
      [699, 88],
      [655, 88],
      [610, 88],
      [564, 88],
      [519, 88],
      [475, 87],
      [436, 64],
      [397, 82],
      [353, 87],
      [315, 61],
      [278, 82],
      [234, 87],
      [199, 59],
      [161, 81],
      [118, 87],
      [85, 58],
      [49, 76],
      [9, 80],
      [0, 37]
    ],
    rocks: [
      { x: 5, z: -17, r: 3.5, s: 1.37 },
      { x: 8, z: -27, r: 2.3, s: 0.89 },
      { x: 45, z: -85, r: 1.9, s: 0.75 },
      { x: 55, z: -82, r: 2.6, s: 1.04 },
      { x: 104, z: -68, r: 3.1, s: 1.21 },
      { x: 133, z: -86, r: 2.5, s: 0.97 },
      { x: 142, z: -81, r: 3.0, s: 1.18 },
      { x: 152, z: -82, r: 2.5, s: 0.96 },
      { x: 181, z: -72, r: 2.8, s: 1.08 },
      { x: 191, z: -69, r: 2.2, s: 0.85 },
      { x: 230, z: -69, r: 2.1, s: 0.84 },
      { x: 278, z: -72, r: 3.6, s: 1.41 },
      { x: 315, z: -68, r: 3.7, s: 1.46 },
      { x: 323, z: -68, r: 1.5, s: 0.60 },
      { x: 361, z: -62, r: 3.0, s: 1.19 },
      { x: 368, z: -62, r: 2.3, s: 0.89 },
      { x: 401, z: -81, r: 2.4, s: 0.94 },
      { x: 413, z: -81, r: 1.8, s: 0.71 },
      { x: 441, z: -71, r: 1.7, s: 0.68 },
      { x: 483, z: -46, r: 3.0, s: 1.19 },
      { x: 493, z: -62, r: 1.6, s: 0.63 },
      { x: 577, z: -80, r: 1.9, s: 0.75 },
      { x: 603, z: -44, r: 2.2, s: 0.87 },
      { x: 659, z: -68, r: 3.5, s: 1.37 },
      { x: 693, z: -71, r: 3.4, s: 1.32 },
      { x: 729, z: -59, r: 1.7, s: 0.65 },
      { x: 731, z: -40, r: 1.9, s: 0.76 },
      { x: 771, z: -59, r: 3.2, s: 1.27 },
      { x: 768, z: -78, r: 3.3, s: 1.29 },
      { x: 805, z: -82, r: 3.0, s: 1.18 },
      { x: 804, z: -64, r: 2.6, s: 1.04 },
      { x: 748, z: 14, r: 1.7, s: 0.67 },
      { x: 760, z: 4, r: 1.7, s: 0.67 },
      { x: 773, z: -29, r: 1.8, s: 0.72 },
      { x: 784, z: -19, r: 3.0, s: 1.17 },
      { x: 813, z: -19, r: 1.6, s: 0.64 },
      { x: 819, z: 81, r: 2.6, s: 1.02 },
      { x: 801, z: 75, r: 2.6, s: 1.02 },
      { x: 759, z: 80, r: 2.2, s: 0.85 },
      { x: 730, z: 82, r: 3.5, s: 1.38 },
      { x: 720, z: 82, r: 2.0, s: 0.79 },
      { x: 672, z: 83, r: 2.9, s: 1.12 },
      { x: 633, z: 94, r: 2.4, s: 0.93 },
      { x: 624, z: 94, r: 2.8, s: 1.10 },
      { x: 595, z: 94, r: 2.3, s: 0.89 },
      { x: 585, z: 94, r: 3.7, s: 1.45 },
      { x: 546, z: 95, r: 2.6, s: 1.03 },
      { x: 537, z: 94, r: 2.2, s: 0.87 },
      { x: 498, z: 83, r: 3.3, s: 1.30 },
      { x: 488, z: 80, r: 1.8, s: 0.72 },
      { x: 466, z: 72, r: 1.6, s: 0.62 },
      { x: 415, z: 63, r: 3.1, s: 1.21 },
      { x: 375, z: 94, r: 2.6, s: 1.03 },
      { x: 343, z: 72, r: 2.6, s: 1.02 },
      { x: 255, z: 97, r: 3.5, s: 1.38 },
      { x: 209, z: 73, r: 2.8, s: 1.10 },
      { x: 174, z: 58, r: 1.8, s: 0.69 },
      { x: 167, z: 64, r: 3.3, s: 1.28 },
      { x: 109, z: 72, r: 3.0, s: 1.17 },
      { x: 103, z: 64, r: 3.6, s: 1.42 },
      { x: 72, z: 48, r: 3.5, s: 1.36 },
      { x: 60, z: 53, r: 3.0, s: 1.19 },
      { x: 35, z: 81, r: 1.8, s: 0.70 },
      { x: 8, z: 64, r: 1.9, s: 0.75 },
      { x: 7, z: 56, r: 2.6, s: 1.02 },
      { x: -7, z: 17, r: 1.6, s: 0.63 }
    ],
    // 立交回旋环（2026-11-17）：东端本来就是一条自交的回旋线（22-23 与 26-27 在
    // (813,5) 交叉）。旧配置只在 25→29 抬 5m，下半圈仍按水面浮桶铺 —— 桥上桥下
    // 糊成一片，玩家看到的就是"浮桶交织、管道和水面赛道混在一起"。
    // 现在整圈 20→31 连续抬升：20→26 爬到 8.4m，绕满一圈后 27→31 落回水面；
    // 交叉点上层约 7.8m / 下层约 2.6m，扣掉 0.85m 桥板还有 4.3m 净空。
    // 整圈抬起来后水面不再铺浮桶（Track.#buildEdgeBuoys 按 overpass 高度剔除）。
    overpass: {
      from: 20, to: 31,
      profile: [0, 0.8, 2.2, 3.6, 5.2, 6.6, 8.4, 7.6, 6.4, 4.6, 2.4, 0],
    },
    podium: { x: -700, z: -700, heading: 0 },
    courseProps: [
      { kind: 'portal', at: 0.18 },
      { kind: 'portal', at: 0.34 },
      { kind: 'hammer', at: 0.62, side: 1.2 },
      { kind: 'whirl', at: 0.80, side: -1.15 },
      // deco = 纯布景（无碰撞）。两个坑记在这里：
      // 1) 模型都是"长边沿建模 X 轴"，不转 yaw 就会把长边横在赛道上
      //    → 一律 yaw: Math.PI / 2，让长边顺赛道；拱门靠它也才是"横跨航道"。
      // 2) side 的单位是 gateWidth/2 = 3.75m，而航道半宽是 7.5m。
      //    需要的 side = (7.5 + 模型横向半宽 + 1.5 余量) / 3.75。
      //
      // 2026-10-31：删掉两个 canyon/cliff（程序化岩堆）—— 材质只有 0.01~0.1 的黑度，
      // 进游戏就是"一大坨黑影"，用户明确说难看。岩壁改用 props/cliff_segment（下面 0.66/0.70）。
      // 也删掉 canyon/ramp：那块木跳台 40m 长却只有 10.2m 宽，宽高比塞不进 15m 航道，
      // 而且没有可行驶面（纯布景）。要跳台应该用几何做，跟立交桥共用同一套高度体系。
      { kind: 'deco', glb: '/models/canyon/tunnel.glb', at: 0.34, side: 0, span: 44, yaw: Math.PI / 2, label: '隧道壳' },
      // 岛：不转 yaw，横向 = 32m；side 7.0 → 离中线 26.25m、内缘 10.25m（审计要求 ≥7.5）
      { kind: 'deco', glb: '/models/canyon/island.glb', at: 0.47, side: 7.0, span: 32, lift: -0.8, label: '环形岛' },
      { kind: 'deco', glb: '/models/canyon/arch.glb', at: 0.60, side: 0, span: 20, yaw: Math.PI / 2, label: '近道拱门' },
      // 远景山体：转 yaw 后横向 59m，side 12 → 内侧离中线 15.5m，高约 40m 当天际线
      { kind: 'deco', glb: '/models/canyon/mountain.glb', at: 0.88, side: 12, span: 110, yaw: Math.PI / 2, lift: -1.2, label: '远景山体' },
    ],
    marineFeatures: {
      boostGate: 6, boostSide: -0.45, buoyGate: 18, buoySide: 0.2,
      launchChain: { startGate: 10, count: 3, side: 0.2, weave: 2.4, speed: 28 },
    },
  },
  {
    id: 'palace',
    name: '深海龙宫',
    icon: '🐲',
    desc: '潜入海底神殿，穿越龙宫与亚特兰蒂斯遗迹',
    laps: 3,
    style: 'palace',
    waterColor: 0x1fb8b0,
    waterDeep: 0x0a4a66,
    waterCrest: 0xaef2e8,
    fogColor: 0xbfe8f0,
    fogDensity: 0.0024,
    skyTop: 0x3fa0e8,
    skyBottom: 0xcdeef5,
    sunColor: 0xfff2d8,
    gateWidth: 12,
    startWidth: 38,
    boundary: { x: 0, z: 0, r: 260 },
    gates: [
      [150, 0], [165, 50], [150, 100], [110, 135], [55, 145],
      [0, 130], [-45, 100], [-70, 55], [-100, 10], [-150, -15],
      [-155, -65], [-120, -110], [-65, -130], [-10, -125], [50, -130],
      [105, -115], [140, -70],
    ],
    rocks: [
      { x: 120, z: -35, r: 3.5, s: 0.9 },
      { x: 80, z: -105, r: 4, s: 1.0 },
      { x: -35, z: -90, r: 3.5, s: 0.9 },
      { x: -110, z: 55, r: 3.5, s: 0.9 },
    ],
    // 潜行区：from/to 为门索引，艇沿此段平滑下潜到 depth 再上浮
    dives: [
      { from: 2, to: 6, depth: -8 },   // 水下龙宫隧道
      { from: 9, to: 12, depth: -6 },  // 亚特兰蒂斯遗迹
    ],
    // 榫欏鍏ュ彛闂細鎵€鏈夌帺瀹朵娇鐢ㄥ悓涓€鏃堕棿杞存姖鍗囬檷锛屽叧闂椂鎾炲埄闂ㄥ弽寮?
    palaceGate: { gate: 2, period: 7, phase: 0.2, travel: 8, entryOffset: 0 },
    // 后段手动弹射：缩短飞行距离，让落点始终落在第 15 号门前的赛道内。
    coasterFixed: { from: 12, to: 15, launchDist: 14, apex: 12 },
    startBoost: { segment: 1 },
    pistonIndices: [9, 10, 11, 12],
    bonusItemGates: [14, 16],
    // 金龙过山车（手动弹射）：出水 → 龙柱大门 → 弹射坡腾空 → 金色龙脊轨道 → 俯冲砸入第二段水下区
    // mode=manual：空中可操控（转向/油门喷气），分段重力制造"悬浮→急坠"过山车手感
    coaster: {
      mode: 'manual',
      from: 6,          // 第一段潜行区出口门
      to: 9,            // 第二段潜行区入口门
      launchDist: 26,   // 出门多少米处设弹射坡
      apex: 17,         // 轨道最高点（米）
      entryDepth: -2.5, // 末端俯冲入水深度
    },
    shortcuts: [
      // 水面滑槽：主道 #2→#6 是下潜到 -8m 的龙宫大殿，本近道全程留在水面，
      // 从大殿正南侧切过去——两条路线物理分层，绝不共用一条走廊。
      // 两端脱离点距主道中线 16.3m，中段弦线全程 ≥ 16.3m。主道 220m → 202m，省 8%。
      { from: 2, to: 6, width: 3.6, points: [[150, 100], [135.4, 90.4], [94, 90], [51, 90], [9, 89], [-32.4, 88.1], [-45, 100]] },
    ],
    // Surface-water ceremony area: far southeast of the dragon palace and all dive routes.
    podium: { x: 215, z: -205, heading: 0 },
    // 龙宫：门宽最窄，锤/漩涡贴边放，绝不压在潜行与旋转门段上（自动避让）
    courseProps: [
      { kind: 'flag', at: 0.0 },
      { kind: 'portal', at: 0.35 },
      { kind: 'hammer', at: 0.58, side: -1.3 },
      { kind: 'whirl', at: 0.84, side: 1.15 },
    ],
    marineFeatures: {
      boostGate: 0, boostSide: -0.35, buoyGate: 13, buoySide: 0.2,
      // 水下弹射链：后半段潜水区(9-12 亚特兰蒂斯段)内，10-11 段起；弹出水面再砸回
      // 水下反复跳跃。旧 3 段起的链正好杵在龙宫大殿正门+旋转门后方，下潜途中就被
      // 弹飞穿殿，现挪离龙宫。深度由 diveHeightAt 自动探测（underwater 字段已不需要）
      launchChain: { startGate: 10, count: 3, side: 0, weave: 1.3, pairGap: 2.0, speed: 26 },
    },
  },
  {
    id: 'tide',
    name: '冰汐海峡',
    icon: '🧊',
    desc: '峡谷夹道 + 折线冰原，周期逆流顶着你走，抓地和耐心都要',
    laps: 3,
    // 复用 ocean 的水色/雾/光照链路，只把地平线上的山全部关掉（noMountains）
    // —— 远景改由 cliffs / icebergs 两套 GLB 地形接管
    style: 'ocean',
    noMountains: true,
    waterColor: 0x2a8fa8,
    waterDeep: 0x123a5c,
    waterCrest: 0xbff0f5,
    fogColor: 0xcfe6f2,
    fogDensity: 0.0026,
    skyTop: 0x4a9fd8,
    skyBottom: 0xdff1fb,
    sunColor: 0xfff6e0,
    // 冰汐海峡 v2：西/北峡谷壁 + 东侧冰山群，折线含 1 个 90° 直角、1 组 Z 字、1 个 ~57° 硬弯。
    // 走线整体以原点为中心（与其它图一致），最远点 r≈199，boundary.r=310 留 111m 余量。
    gateWidth: 14,
    startWidth: 45,
    boundary: { x: 0, z: 0, r: 310 },
    // 20 门：西侧潮汐带北上 → #5 直角转东 → 北岸直道 → #8–#10 Z 字折返
    // → #11 冰区入口 → 冰山群外凸（最东）→ #14 硬弯下切 → 南岸长直道回终点。
    // 段长刻意不均（37~67m 混排），三处弯道分散在西北 / 北 / 东南，不成规律。
    gates: [
      [-153, 119],  // 0  起终点，朝正北
      [-161, 83],   // 1  潮汐带入口
      [-163, 28],   // 2  潮汐带（水流最猛）
      [-160, -27],  // 3  潮汐带
      [-155, -72],  // 4  潮汐带出口，准备直角
      [-155, -125], // 5  ★直角弯①：正北 → 正东（约 90°）
      [-101, -129], // 6  直角出弯
      [-37, -135],  // 7  北岸直道（峡谷壁夹道）
      [21, -129],   // 8  Z 字入口
      [61, -99],    // 9  ★Z 上折
      [20, -58],    // 10 ★Z 回折
      [63, -35],    // 11 冰区入口
      [127, -17],   // 12 冰山群
      [163, 35],    // 13 冰山群外凸（最东点）
      [145, 83],    // 14 ★硬弯② 东 → 南（约 57°）
      [107, 109],   // 15 冰区出口
      [51, 119],    // 16 南岸直道（峡谷壁夹道）
      [-9, 126],    // 17
      [-65, 130],   // 18
      [-113, 145],  // 19 冲线前（唯一一个非直角的大回转，让起点线门框正对来车）
    ],
    // 开阔水面上的暗礁，全部落在内圈空水里，不压主道也不压近道
    rocks: [
      { x: -60, z: -60, r: 4.5, s: 1.0 },
      { x: 0, z: -90, r: 4.0, s: 0.9 },
      { x: -40, z: 10, r: 4.5, s: 1.0 },
      { x: -100, z: 40, r: 4.0, s: 0.9 },
    ],
    // 冰原：圆域内抓地骤降、滑移上限放大，漂移攒气反而更快（滑得有回报）
    // 判定域固定不变，暴风雪只会放大视觉冰壳，不会偷偷改判定
    iceZone: { x: 97, z: 41, r: 108, grip: 0.35, slip: 1.6, driftGain: 1.4 },
    // 潮汐：18s 一轮整体翻面，方向与 1→4 的北上方向相反（迎面顶流）
    // weatherMul 让恶劣天气的水流更猛，同一张图在风暴里自然更凶
    // 水域只覆盖 #2~#4 的潮汐带（中心 z≈0、半径 95）：
    // 早先的 r=122 圆把起点门也包了进去，倒计时还没结束船就被推着走
    current: {
      x: -161, z: 0, r: 95,
      dir: [0.78, -0.62],
      strength: 6.5,
      period: 18,
      weatherMul: { day: 1, dusk: 1, storm: 1.15, blizzard: 1.1 },
    },
    // 地形：西/北段峡谷岩壁（[3,8]），南岸再补一段（[15,19]），东侧交给冰山群。
    // offset 是 gateWidth 的倍数（岩壁中心到赛道中线），再加半厚度与 gap：
    // 14×1.0 + 9 + 3 = 26m，岩壁内立面正好落在护栏外 3m，不会捅进走廊。
    cliffs: { segments: [[3, 8], [15, 19]], spacing: 55, offset: 1.0, thickness: 18, gap: 3 },
    icebergs: { large: 12, small: 26 },
    // 冰面上的霓虹护栏几乎看不见（纯白底 + 加法混合），补一条深色压边
    edgeSkirt: true,
    // 导航光带：沿赛道外缘每 ~100m 一盏灯船浮标，暴雨/暴雪里是唯一可靠的路标
    // offset 是 gateWidth 的倍数：1.2 → 灯船在护栏外 2.8m，不会被船撞着穿过
    navBeacons: { spacing: 100, offset: 1.2 },
    shortcuts: [
      // 近道 A：冰区外凸切线 #11→#14。主道在冰山群里绕"东凸"弧，本近道走内圈弦线，
      // 181m → 145m，省 20%；但全程在冰上，速度高时极容易滑出赛道。
      {
        from: 11,
        to: 14,
        width: 3.4,
        points: [[63, -35], [81, -6], [103, 16], [123, 46], [145, 83]],
      },
      // 近道 B：切 Z 字第一折的"内线" #8→#10。主道在 #9 甩出去再折回来，
      // 本近道直接从折返内侧直线穿到 #10 的出弯点：108m → 78m，省 28%。
      //
      // 为什么不按"跳过整个 Z（#8→#11）"来画：Z 的中间腿 9→10 必然横穿 8→11 的弦，
      // 近道会在中途和主道十字相交——主道护栏只在近道两端开口（见
      // Track.#buildMainWallsWithShortcutGaps），中段相交会留下一道横在近道上的光墙。
      // 切到 #10 收口则全程只在两端与主道重合，几何上干净。
      {
        from: 8,
        to: 10,
        width: 3.2,
        points: [[21, -129], [13, -100], [6, -76], [20, -58]],
      },
    ],
    // 圈内南侧开阔水域，离主道、两条近道与冰山群都远
    podium: { x: -40, z: 230, heading: 0 },
    courseProps: [
      { kind: 'flag', gate: 0 },
      { kind: 'portal', gate: 6 },
      { kind: 'hammer', gate: 17, side: 1.3 },
      { kind: 'whirl', gate: 3, side: -1.15 },
    ],
    marineFeatures: {
      boostGate: 7, boostSide: -0.5, buoyGate: 16, buoySide: 0.2,
      // 潮汐带上的弹射链：起跳后横渡顶流，落点仍在冰区入口之前
      launchChain: { startGate: 2, count: 3, side: 0.25, weave: 2.4, pairGap: 2.2, speed: 28 },
    },
  },
  {
    // 长赛道迁移（2026-11-02）：由预览页「拉长宽松版水上赛道」的 55 节点中心线转写。
    // 单圈约 3.0km，南向长河 → 东侧长直道回程；风格保留青绿霓虹，结构与布景走石木打底。
    id: 'strait',
    name: '霓虹海峡',
    icon: '🌉',
    desc: '3km 单圈长赛道：城墙隘口、连续隧道、波浪栈道与强化 Z 弯',
    laps: 1,
    // 纯水面 + 自建石木布景：不走 canyon 的整圈岩壁生成，避免和城墙/隧道抢位置
    style: 'ocean',
    noMountains: true,
    waterColor: 0x1f7f79,
    waterDeep: 0x0e3b46,
    waterCrest: 0x9ff2e8,
    fogColor: 0xbcd6cf,
    fogDensity: 0.0024,
    skyTop: 0x6fb3dd,
    skyBottom: 0xe8f2ea,
    sunColor: 0xfff4dc,
    // 半宽 8m（航道全宽 16m）：3km 长赛道 + 连续急弯，留出和峡谷图接近的容错宽度
    gateWidth: 8,
    // 2026-11-17 起点线前移到 z=16：原来在 z=40 的入弯口，那里航道有 42m 宽，
    // 而黑白格线只有 26m —— 从右侧 7~17m 处绕过去不算圈（实测探针确认）。
    // z≤18 这一段航道收窄成 14.5m，起点线/旗门按 15m 做，两腿正好落在浮桶线上，
    // 左右再没有"看着能过、过线不计圈"的缝。
    startWidth: 15,
    // bbox x -72~100 / z -1028~40，圆心取中点，r=580 留出脱离赛道的余量
    boundary: { x: 14, z: -494, r: 580 },
    gates: [
      [0, 16], [0, 0], [0, -20], [34, -46], [-34, -72],
      [38, -98], [-38, -124], [34, -150], [-30, -176], [24, -200],
      [10, -222], [-28, -238], [-62, -252], [-72, -282], [-58, -312],
      [-24, -322], [6, -312], [12, -344], [8, -376], [10, -408],
      [6, -438], [8, -462], [8, -486], [8, -508], [14, -530],
      [18, -550], [10, -570], [18, -590], [6, -610], [-16, -636],
      [-22, -658], [-14, -684], [6, -700], [10, -716], [10, -734],
      [10, -758], [10, -780], [38, -800], [-38, -818], [42, -836],
      [-42, -854], [38, -872], [-22, -892], [6, -914], [4, -938],
      [18, -980], [34, -1004], [44, -1028], [88, -1000], [100, -860],
      [100, -620], [96, -380], [88, -160], [64, 20], [30, 34],
    ],
    // 逐门高度（米）。只有 24~28 的波浪栈道抬起来，其余段贴水面航行。
    // 与 overpass 不同：这里没有跨层交叉，按坐标就能唯一确定高度（见 Track.#gateHeightAt）。
    gateHeights: [
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0,
      0.5, 3.0, 0.8, 2.6, 0.5,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0,
    ],
    // 东侧暗礁群（x 71~79 / z -445~-361），离主道 60m 以上，只做视觉地标
    rocks: [
      { x: 79.1, z: -444.5, r: 1.32, s: 1.26 },
      { x: 75.9, z: -435.3, r: 1.12, s: 1.07 },
      { x: 72.8, z: -426.0, r: 1.70, s: 1.62 },
      { x: 76.6, z: -416.6, r: 1.03, s: 0.98 },
      { x: 73.5, z: -407.3, r: 1.56, s: 1.49 },
      { x: 77.3, z: -398.0, r: 1.37, s: 1.30 },
      { x: 74.1, z: -388.7, r: 1.01, s: 0.96 },
      { x: 78.0, z: -379.6, r: 1.53, s: 1.46 },
      { x: 74.6, z: -370.4, r: 0.99, s: 0.94 },
      { x: 71.3, z: -361.2, r: 1.45, s: 1.38 },
    ],
    // 两条合法内切近道：只在两端与主道重合，中段全程在主道走廊之外。
    // A 切 4→6 的 S 弯内侧：主道 157m → 53m；B 切 11→16 的发卡弯内侧：169m → 90m。
    shortcuts: [
      { from: 4, to: 6, width: 3.0, points: [[-34, -72], [-40, -96], [-38, -124]] },
      { from: 11, to: 16, width: 3.0, points: [[-24, -244], [-38, -286], [2, -308]] },
    ],
    // 赛后仪式区：西侧大海峡空水里，离主道/近道都远
    podium: { x: 62, z: -560, heading: 0 },
    courseProps: [
      { kind: 'flag', gate: 0 },
      { kind: 'portal', gate: 44 },
      { kind: 'hammer', gate: 30, side: 1.3 },
      { kind: 'whirl', gate: 51, side: -1.15 },
    ],
    marineFeatures: {
      boostGate: 44,
      boostSide: -0.5,
      buoyGate: 45,
      buoySide: 0.2,
      // 东侧长直道（50→52）：一组并排弹射器，起跳后正好落在回程直线上
      launchChain: {
        startGate: 50, count: 3, side: 0.2, weave: 1.6,
        pairGap: 1.6, halfSide: 1.8, speed: 28,
      },
    },
    // 最后那条长直道（东侧 gate 48→52，x 88~100 / z -1000~-160）加难度：
    // 4 个左右交替的蓝色加速带 + 4 块来回移动的岩石（两块横扫、两块前后冲）。
    // gates 是从 0 起数的 55 门，东侧长直道精确是：
    //   48=[88,-1000] 49=[100,-860] 50=[100,-620] 51=[96,-380] 52=[88,-160]
    // 52→53 已经拐回起点了，写 52/53 会把障碍摆到入弯段（踩过两次）。
    // 加速带 side 单位是 gateWidth/2（=4m），±0.55 → 左右各偏 4.4m。
    // t 取 0.30（段落前 1/3）：岩石在门中点 t=0.5，两者错开约 48m，
    // 玩家先吃加速带再躲石头，节奏分明，也不会出现"石头压着加速带"的糊画面。
    padColor: 0x1f9dff,
    boostPads: [
      { gate: 48, t: 0.30, side: -0.55 },
      { gate: 49, t: 0.30, side: 0.55 },
      { gate: 50, t: 0.30, side: -0.55 },
      { gate: 51, t: 0.30, side: 0.55 },
    ],
    // 移动障碍：visual:'rock' = 用 Blender 出的带贴图圆石（不是几何体）。
    // axis:'side' 横扫（左右）、'along' 沿赛道前后冲。周期/相位写死保证联机一致。
    // boulderA 宽扁（横扫）、boulderB 略高（前后冲），两块轮换着用避免一眼看出重复。
    hazards: {
      drifters: [
        { gate: 48, axis: 'side', span: 0.62, r: 2.1, period: 6.2, phase: 0.05, visual: 'rock', kind: 'boulderA' },
        { gate: 49, axis: 'along', span: 0.80, r: 2.3, period: 7.4, phase: 0.30, visual: 'rock', kind: 'boulderB' },
        { gate: 50, axis: 'side', span: 0.62, r: 2.1, period: 5.6, phase: 0.55, visual: 'rock', kind: 'boulderA' },
        { gate: 51, axis: 'along', span: 0.80, r: 2.3, period: 7.0, phase: 0.80, visual: 'rock', kind: 'boulderB' },
      ],
    },
    // 石木构件（Track.#buildStraitProps）：全部按门索引落位，和预览页的 t 值漂移无关
    straitProps: {
      // 城墙隘口：山谷段的三道石砌夹口
      wallGates: [17, 18, 20],
      // 连续隧道：两道柱廊，每段沿折线密排石柱 + 顶梁
      tunnels: [[21, 23], [34, 36]],
      // 波浪栈道：抬高的木栈道 + 支撑桩 + 青绿霓虹边条
      boardwalk: [24, 28],
      // 发卡弯木护墙：外缘一侧（-1 = 背离近道 B 的一侧）
      hairpin: { from: 11, to: 15, side: -1 },
      // 城墙顶的松树（点缀，不做碰撞）
      pines: { gates: [17, 18, 20] },
    },
  },
  {
    id: 'baked',
    name: '秘境漂流',
    icon: '🏔',
    desc: '山洞 → 阶梯 → 云端螺旋塔 → 瀑布 → 森林 → 海岸码头返程（单圈 3.5km）',
    laps: 1,
    style: 'baked',
    // 与峡谷险道同一套碧海配色，一起压在深海青绿
    waterColor: 0x1a5f5e,
    waterDeep: 0x0e3a3a,
    waterCrest: 0x9ff2ee,
    fogColor: 0xbfe6f7,
    fogDensity: 0.0016,
    skyTop: 0x3f9ff0,
    skyBottom: 0xcdeeff,
    sunColor: 0xfff8e8,
    gateWidth: 7.5,
    // 秘境漂流是洞穴水路：可视走廊半宽 7.5m，起点线再宽就会插进洞壁
    startWidth: 17,
    boundary: { x: 350, z: 200, r: 900 },
    gates: BAKED_TRACK.gates,
    bakedY: BAKED_TRACK.gateY,
    bakedSections: BAKED_TRACK.sections,
    bakedObstacles: BAKED_TRACK.obstacles,
    // 回程闭合（2026-11-01）：森林尽头硬接一条返程 —— 南下 → R32 发卡对 → 长西行 →
    // 急弯收尾，最后并回 0 号门。整圈因此闭合成环，圈数判定回到通用逻辑
    // （Game.#checkLocalGates 里那条"最后一门即终点"只对未闭合的开环生效）。
    baked: {
      closed: true,
      returnFrom: BAKED_TRACK.returnFrom,
      // ---------- 云端螺旋塔（2026-11-12 重做门 30..65） ----------
      // 原来云端是一段贴着白色平台的大弧，被玩家吐槽"看不出走廊、还有穿模"。
      // 现在按门中心线程序化生成一座塔：塔柱 + 上升螺旋坡道 + 塔顶平台 + 下降螺旋。
      // 中心/半径与 scripts/gen_cloud_spiral.mjs 的 CFG 必须一致（那份是数据来源）。
      tower: {
        cx: 389.39, cz: 151,     // 塔心（= 门 29 正北 rEntry 处）
        // 2026-11-16 用户第 4 条：「巨大物体矗立在地面、能穿过去」= 这根塔柱。
        // 原来 68m，下降螺旋道半径只有 76m → 净空 8m，整根柱子糊满屏幕像一堵墙。
        // 缩到 44m 之后净空 32m，从坡道上能看见水面包着塔身，不再遮挡视野。
        // ⚠️ 塔柱只是视觉体（没有碰撞代理），改这个数不影响任何物理逻辑。
        pillarR: 44,
        rUp: 88,                 // 上升螺旋半径（外圈）
        rDown: 76,               // 下降螺旋半径（内圈）
        from: 29, to: 66,        // 29 门进塔，66 门交给森林（含出口水槽）
        // 接近段：隧道口（23 门）到塔基（29 门）这 7 个门从 0m 爬到 13m，原来既没有
        // 水面也没有岸带（旧 stairs_shell 被整段隐藏时连 stairs_water 一起藏了），
        // 玩家从隧道出来就是"悬空漂移"。现在塔的断面生成往前接到 23 门，水面/渠沿/
        // 矮墙/支撑柱一路连到塔基，两侧再补一圈浮云。
        // `clouds: false` = 不再补浮云（2026-11-16 用户：出口那段头上全是白色卡通云，
        // 挡视线又出戏，全部删掉）。
        approach: { from: 23, to: 29, clouds: false },
        towerEnd: 56,            // 塔上坡道到 56 门结束，57 门之后是出口高架水槽
        bankH: 2.2,              // 坡道外缘矮墙高度（读得出"走廊"）
      },
      // ---------- 悬崖边缘（掉落） ----------
      // 只放塔顶平台（40→45 门，56~63m）这一段：外侧不立护栏，横向越过 edge 就冲出去掉落。
      // edge 取 8.2 而不是走廊半径 6.9 —— 实测量的可视水面半宽正好 7.5m，
      // 8.2 的时候船体大半已经悬空，读起来才是"冲出边缘"而不是"撞到空气墙"。
      // ⚠️ 区间不能盖到下降段（48 门之后）：那里是螺旋坡道，压矮矮墙会让整段
      //    看起来像一条没有边的水带。
      edgeDrop: [{ from: 40, to: 45, edge: 8.2 }],
      // ---------- 起飞点 ----------
      // 塔顶崖口（44 门，y=63.1；下一门就掉到 56.1，坡 27%）直接进入弹道，而不是贴着螺旋坡道往下滑：
      // vy 只给 4.2（不是"弹得很高"，而是给一个离坡的分量），真正的高度来自
      // 崖口本身的 63m。配合 waveJump 的 12m/s² 轻重力，滞空约 3.6s，
      // 正好飘过螺旋下降段的第一圈 —— 这就是"赛艇飞在空中"。
      jumps: [{ gate: 44, vy: 4.2, minSpeed: 11 }],
      // ---------- 回程岸带（2026-11-12 重做门 86..208） ----------
      // 原来回程就是贴着海面的两条 4m 草带（return_shell.glb 的 return_bank，
      // 包围盒 y 只有 -0.9~3.5），从船上看完全读不出"这是一条走廊"。
      // 现在按门中心线重新扫断面：石砌堤身（0.8m 收分）→ 走道 → 女儿墙压顶 →
      // 外沿一列每 16m 一根的壁柱，做成"跨海石堤 + 柱廊"的体量。
      //
      // ⚠️ height 不要上 5m 以上：追随相机 eye 只有 4.2m，堤顶高过视线就变成一条
      //    看不到海、看不到码头布景的深沟（实拍过 7m 版本，整条回程像运河船闸）。
      //    现在的剪影高度 = height + parapet + 0.25 ≈ 4.6m，正好在视线上下，
      //    既有"墙"的存在感，又能从墙头看见远处海面和布景。
      returnBank: {
        from: BAKED_TRACK.returnFrom,   // 86
        to: 209,                        // 开区间：铺到最后一门 208
        height: 3.4,                    // 堤顶（走道面）离水面
        parapet: 0.95,                  // 女儿墙高度
        walk: 2.2,                      // 走道净宽
        pierStep: 16,                   // 壁柱间距
        fade: 30,                       // 收尾渐隐长度：最后 30m 沉进水下，别穿进隧道
        color: 0xcfc3a2,                // 堤身（暖灰石）
        topColor: 0xe8e0c6,             // 走道 / 压顶（浅色，远看能读出边线）
        columnColor: 0xbfc7cd,          // 壁柱（冷灰，和水/石分得开）
      },
      // ---------- 洞口石拱（2026-11-16 用户第 1 条）----------
      // cave_shell 的洞口左半边没有几何，断口是锯齿状三角边；玩家从发车格往前看
      // 就是一个被啃掉半边的大黑洞，起点线还正好压在开阔水面上看不出来。
      // 这里沿门中心线现扫一段石拱：从 0 号门往回 24m（罩住发车格）一直到 6 号门，
      // 半宽 9.4m > 走廊 7.5m（只包不挡），拱顶 7.6m。补完之后起点就是"在洞里发车"。
      startTunnel: { back: 24, to: 6, halfWidth: 9.4, height: 7.6, rise: 2.4, base: -2.2 },
      // 森林海岸沙滩：forest_bank 的岸顶只有 -0.5~0.6m，海浪一涨就把树根下的沙岸
      // 整片盖掉（玩家看到"树长在水里、赛道边界没了"）。Track 在航道外侧再铺一条
      // 0.3→0.95m 的沙洲，保证沙滩常年露出水面。范围到回程岸带起点（86）为止。
      beach: { from: 64, to: 86 },
      // 回程堤岸上的动态障碍：垃圾桶左右横扫、机器人沿赛道巡逻、
      // 岩石卡在路中间、海草贴边。位置由 Track 沿门中心线算，
      // 这里只给范围（from..to 门号，开区间到 209）。
      hazards: { from: 92, to: 208 },
      // 回程两侧布景：全部是 Blender 出的低模原型件，位置由 Track 沿中心线算，
      // 这里只声明节奏（每多少米一件 / 离中线多远）。
      // ⚠️ rock / buoy 的 offset 必须 > 岸带外沿（gateWidth 7.5 + 0.4 + walk 2.2 + 0.7 ≈ 10.8），
      //    否则会整块埋进堤身里（2026-11-12 抬岸带时踩过）。
      // ⚠️ dock 是例外：它按玩家要求摆到**堤身内侧**（航道里），从堤壁垂直伸出，
      //    占掉半幅航道形成窄口。所以它不写 offset，只写 passWidth ——
      //    Track 用 passWidth 反算离中线多远，保证剩下的通道正好能并排两艘赛艇。
      //    lenScale 只压长边（原型长边在局部 Z），宽度不动，免得码头变细竹签。
      shore: {
        from: BAKED_TRACK.returnFrom,
        dock: { url: '/models/shore/dock_wood.glb', step: 150, y: 0.12, lenScale: 0.455, passWidth: 7.0 },
        rock: { url: '/models/shore/rock_cluster.glb', step: 95, offset: 16.0, y: -0.35 },
        buoy: { url: '/models/shore/buoy_marker.glb', step: 42, offset: 11.8, y: -0.35, scale: 1.15 },
      },
      models: [
        { kind: 'cave',   url: '/models/cave/cave_shell.glb?v=14' },
        { kind: 'stairs', url: '/models/cave/stairs_shell.glb?v=14' },
        { kind: 'cloud',  url: '/models/cave/cloud_shell.glb?v=14' },
        { kind: 'fall',   url: '/models/cave/fall_shell.glb?v=14' },
        { kind: 'forest', url: '/models/cave/forest_shell.glb?v=14' },
        { kind: 'props',  url: '/models/cave/cave_props.glb?v=14' },
        { kind: 'return', url: '/models/cave/return_shell.glb?v=1' },
      ],
    },
  },
  // ---------------------------------------------------------------------------
  // 熔岩夜航（Magma Peak 风格）：第 8 张图，纯视觉主题实验。
  //
  // 设计约束：**现有 7 张地图的代码路径一个字都不动**。所以这里全部走"可选字段"：
  //   · style 仍复用 'ocean' —— Environment 里十几个 style 分支全部照旧命中，
  //     不新增 style 就不会踩到那些没初始化的分支；
  //   · noMountains 关掉写实远山/远岛，改由 LavaScenery 摆火山；
  //   · lava / neonColor 是新字段，只有本图带，其余地图读到 undefined 走原默认值。
  // 赛道逻辑（gates / 碰撞 / 圈数 / 联机）完全复用普通水面地图那一套，
  // 载具仍是赛艇，熔岩只是"水的着色变体"，物理波形与浮力同源不改。
  // ---------------------------------------------------------------------------
  {
    id: 'magma',
    name: '熔岩夜航',
    icon: '🌋',
    desc: '星夜熔岩海，发光航道穿行火山群',
    laps: 3,
    style: 'ocean',
    noMountains: true,
    // 硬核裂谷：禁止大浪把船抛离水面。waveScale=1.65 下浪尖抛飞很频繁，
    // 玩家腾空就能白嫖过谷，速度门槛会形同虚设（见 Boat.waveLaunchEnabled）。
    // 只关"抛飞"，水面起伏 / 波面涌流漂移都不变。
    noWaveLaunch: true,
    // 航道水面走和其它水面图完全相同的着色路径（见 Water.js 的 uLava 分支：
    // 走廊内直接用 waterShade，不再自绘色块）。所以这里给一套"夜航蓝"，
    // 尾迹 / 泡沫 / 浪尖高光都会跟着这套色走。
    waterColor: 0x3f9dd0,
    waterDeep: 0x0d2f52,
    waterCrest: 0xdcf3ff,
    fogColor: 0x1a0b1e,
    fogDensity: 0.0022,
    skyTop: 0x0a0620,
    skyBottom: 0x3a1230,
    sunColor: 0xffa050,
    gateWidth: 15,
    startWidth: 48,
    boundary: { x: 0, z: 0, r: 300 },
    // 48 门闭环：主环（圆角矩形）+ 东/西各一个外凸 U 型发卡。
    // 手摆航点后按弧长重采样（tests/magma_layout_probe.mjs 生成 + 量过）：
    //   单圈 1357m（旧 1023m）｜覆盖半径 260（boundary 300）｜最小段长 25.7m
    //   相邻转角全部 ≤49°（没有会折墙的急角）｜非相邻赛段净空 48.5m（> 2×gateWidth）
    gates: [
      [0, -158], [28.6, -156], [57.2, -154], [85.8, -152], [113.4, -144],
      [140.9, -136.1], [164.2, -120.2], [186.1, -101.6], [199.2, -76.3], [212.9, -51.2],
      [230.4, -28.8], [250.7, -8.9], [259.5, 17.4], [245.7, 41], [219.7, 53.1],
      [200.9, 72.3], [202.7, 98.5], [201.7, 124.7], [183, 143.9], [156.8, 155.6],
      [128.3, 158.2], [99.7, 160.4], [71.1, 162.2], [42.4, 162.9], [13.8, 163.7],
      [-14.9, 163.6], [-43.6, 162.9], [-72.3, 162.2], [-100.6, 158.6], [-128.9, 153.8],
      [-156.4, 147.1], [-180.5, 131.4], [-201.8, 113.3], [-217.2, 89.4], [-238.8, 70.5],
      [-254.2, 46.8], [-256.6, 18.8], [-243.8, -6.1], [-217.6, -17.8], [-199.1, -35.6],
      [-189.5, -62.5], [-177.6, -88.5], [-159.7, -110.9], [-139.5, -130.2], [-112.4, -139.5],
      [-85.3, -148.8], [-57.2, -153.5], [-28.6, -155.7],
    ],
    // 黑色礁石：全部落在环内空水（模长 < 120），离最近赛道中线 > 25m，不压线
    rocks: [
      { x: 60, z: 40, r: 4.5, s: 1.0 },
      { x: -70, z: -30, r: 4.0, s: 0.9 },
      { x: 10, z: 95, r: 4.5, s: 1.0 },
      { x: -95, z: 60, r: 4.0, s: 0.9 },
    ],
    podium: { x: 0, z: -262, heading: 0 },
    // 四个道具槽与其它水面图保持一致。
    // 用显式门号而不是 at 比例：48 门里 U 型发卡（11~14 / 34~38）不能被道具占住。
    courseProps: [
      { kind: 'flag', at: 0.0 },
      // 熔岩图不用紫色传送门（portal.glb 的冷紫环在夜航场景里最出戏）：
      // 换成两台错位的旋转锤，节奏更密、也全是暖色金属件。
      { kind: 'hammer', gate: 18, side: -1.25 },
      { kind: 'hammer', gate: 27, side: 1.3 },
      { kind: 'whirl', gate: 44, side: -1.15 },
    ],
    // 熔岩专属障碍（见 Track.#buildMagmaHazards）：确定性摆位，联机两端一致。
    //   drifters   : 横向三角波来回扫的火山浮桶（扫幅略大于走廊半宽 → 永远留得出一侧空隙）
    //   geysers    : 定时喷发泉（预警圈 → 喷柱，升起段才有碰撞）
    //   rollers    : 顺赛道迎面滚来的火山巨岩（沿中心线推进，绕圈循环）
    //   impactRocks: 贴边可撞碎的火成岩（高速撞击会崩碎并给一小段加速）
    magmaHazards: {
      drifters: [
        { gate: 5, span: 1.15, period: 6.5, phase: 0.0, r: 2.3 },
        { gate: 15, span: 1.15, period: 7.2, phase: 0.35, r: 2.3 },
        { gate: 29, span: 1.2, period: 6.8, phase: 0.7, r: 2.4 },
        { gate: 43, span: 1.1, period: 7.6, phase: 0.15, r: 2.2 },
      ],
      geysers: [
        { gate: 8, side: 0.45, r: 4.4, period: 5.2, phase: 0.0 },
        { gate: 25, side: -0.5, r: 4.4, period: 5.6, phase: 0.4 },
        { gate: 40, side: 0.5, r: 4.6, period: 6.0, phase: 0.7 },
      ],
      rollers: [
        { gate: 7, period: 9.0, speed: 15, phase: 0.0, r: 3.2 },
        { gate: 20, period: 10.0, speed: 14, phase: 0.45, r: 3.4 },
        { gate: 33, period: 9.5, speed: 16, phase: 0.7, r: 3.0 },
      ],
      impactRocks: [
        { gate: 17, side: 0.82, r: 3.6 },
        { gate: 31, side: -0.82, r: 3.6 },
      ],
      // 硬核档已移除喷泉弹跳板（jumpPads）。
      // 旧版每道裂谷前都有一块板，强制给 speed=20 + faultGrace=1.9，
      // 等于"闭着眼也能飞过去"，正是用户说的"没有丝毫难度"。
      // Track 的弹跳板代码保留给别的图，magma 不声明该字段就不会生成。
    },
    // 硬核档新增：Blender 出的静态岩石障碍（public/models/magma/*.glb）。
    // 视觉是低模顶点色 GLB，碰撞是 Track.#buildMagmaObstacles 里的 JS 圆形代理。
    // side 单位 = gateWidth/2（和 courseProps 的 deco 一致），±0.7 表示偏向一侧
    // 约 5.4m，另一侧永远留得出一条可走的线 —— 增加读线压力但不造死路。
    // 门号刻意避开：裂谷段 2/14/24/38、浮桶 5/15/29/43、喷泉 8/25/40、
    // 滚石 7/20/33、撞碎岩 17/31、旋转锤 18/27、漩涡 44、起点 0。
    magmaObstacles: [
      { gate: 6, side: -0.72, kind: 'pillar', r: 2.3 },
      { gate: 10, side: 0.74, kind: 'spikes', r: 2.7 },
      { gate: 12, side: -0.70, kind: 'shard', r: 2.4 },
      { gate: 19, side: 0.72, kind: 'pillar', r: 2.3 },
      { gate: 23, side: -0.76, kind: 'spikes', r: 2.7 },
      { gate: 28, side: 0.70, kind: 'shard', r: 2.4 },
      { gate: 35, side: -0.74, kind: 'pillar', r: 2.3 },
      { gate: 41, side: 0.72, kind: 'spikes', r: 2.7 },
      { gate: 46, side: -0.70, kind: 'shard', r: 2.4 },
    ],
    // 断层火山带（Track.#buildFaults + Game 的坠落/起跳判定）：
    // after = 该门之后的赛段中间开一道裂谷。
    // 硬核档（用户 2026-11-14 选定）：2 道加宽到 15m + 东/西发卡出口各加 1 道，
    // 门槛速度 20~21m/s，且没有跳板保送、没有浪尖抛飞白嫖。
    // 起跳仍是 waveJump 的 6.0m/s + 12m/s² 轻重力 ≈ 1s 滞空，
    // 21m/s 刚好能跨 15m；慢一点就掉下去。
    faults: [
      { after: 2, width: 15, minSpeed: 21 },
      { after: 14, width: 14, minSpeed: 20 },   // 东 U 型发卡出口
      { after: 24, width: 15, minSpeed: 21 },
      { after: 38, width: 14, minSpeed: 20 },   // 西 U 型发卡出口
    ],
    // 硬核档 Step 2：两条「发卡内切」近道（跑跑卡丁车森林发卡那种读线选择）。
    // 主道在东/西各绕一个 U 型外凸，近道从内侧切过去、中间带一个 S 弯；
    // 省 20~25m，但出口紧接发卡裂谷 —— 抄近道必须带着 20m/s 以上出来才跨得过。
    // 门号避开起点/终点、弹射链起点 7、以及所有固定门号机关。
    shortcuts: [
      { from: 10, to: 14, width: 5.0, points: [[229, -28], [210, -8], [206, 16], [214, 40], [220, 53]] },
      { from: 34, to: 38, width: 5.0, points: [[-237, 68], [-224, 44], [-222, 18], [-226, -6], [-218, -18]] },
    ],
    // 共享海面竞赛特性（boost / buoy / 弹射链）：magma 不是 baked 图，
    // 走的是普通水面赛道那一套，缺了会拿不到加速带和弹射器，源码断言也会挂。
    // 熔岩图裁掉 boost / launch：青绿加速水道和黑色弹射器都是冷色通用资产，
    // 在星夜熔岩里既出戏、又和新增的喷发泉/浮桶抢节奏；两项字段保留，
    // 其它地图（以及本图的 launch 模式兜底）不受影响。
    marineFeatures: {
      boostGate: 2, boostSide: -0.45, buoyGate: 22, buoySide: 0.18,
      skip: ['boost', 'launch'],
      launchChain: { startGate: 7, count: 3, side: 0.22, weave: 1.4, pairGap: 1.7, halfSide: 2.0, speed: 28 },
    },
    // 发光赛道边缘：Track 的霓虹光墙本来写死青蓝，这里改成熔岩橙 / 火花金
    neonColor: 0xff5a1e,
    shortcutNeonColor: 0xffc23a,
    padColor: 0xff6a12,       // 加速带箭头：青蓝换成熔岩金，不然夜景里一片冷色很出戏
    lava: {
      crust: 0x160b12,        // 冷却的黑色地壳
      hot: 0xd8340c,          // 裂隙下的橙红岩浆
      core: 0xffc24a,         // 最亮的黄白芯（也是 bloom 的主要来源）
      glow: 1.5,              // 自发光强度（shader 内再乘 0.42 防爆白）
      flow: 0.11,             // 熔岩流动速度
      bloomScale: 1.15,       // 亮纹/路缘密集时别给太高，否则模糊层会把整屏抬成黄白
      bloomThreshold: 0.82,
      // 亮蓝水道：熔岩海太暗时纯橙黑完全读不出浪面起伏（用户反馈），
      // 并且第一版自绘的青蓝色块"很怪"。现在直接复用其它地图的水面着色，
      // 只把水色给成夜航蓝 —— 浪面 / 高光 / 泡沫 / 尾迹手感与 ocean 完全一致。
      // 兼容存档：`weather` 是"星夜"这一档的老写法，新代码读 weatherBy[starry]。
      // 保留它是为了让老版本的联机房主下发的 weather 字段仍能解析，别删。
      weather: {
        fogColor: 0x1a0b18,
        fogDensity: 0.0019,
        sunColor: 0xff9a48,
        sunIntensity: 0.78,
        hemiSky: 0x6a3760,
        hemiGround: 0x2a0e12,
        hemiIntensity: 1.0,
        waterColor: 0x43a2d6,
        waterDeep: 0x0d3155,
        waterCrest: 0xe4f7ff,
        waveScale: 1.65,
        cloudColor: 0x2a1430,
      },
      // ---------------------------------------------------------------------
      // 逐天气火山调色（2026-11-14，用户反馈"整张图太暗，各天气区别不开"）
      //
      // 旧版把 id 写死成 starry，于是无论玩家选晴朗/黄昏/暴风雨/暴雪，
      // RealSky 永远取 SKY_PRESETS.starry → 天永远是同一片星空，只有雾色微动。
      //
      // 现在 **id 保留玩家选的那个**（大气模型、星空、昼夜循环、水面泡沫分档
      // 都认 id），火山调色只覆盖颜色/光照/雾/云，外加一个 `sky` 子对象继续
      // 微调 RealSky 的大气参数（色调/曝光/浑浊/云量/地平线）。五套各自可辨：
      //   day      灰白火山尘天空 + 暖橙地平线 + 强日照 + 薄雾（最亮）
      //   dusk     橙红天幕、低垂红日、熔岩映在海面上一片紫橙
      //   storm    火山雷暴：压暗的灰紫云 + 大雨 + 2.25 倍大浪
      //   blizzard 火山雪暴：亮灰白雪幕、冷天光，熔岩与雪对撞
      //   starry   默认星夜，比旧版整体提亮一档（船体/水面不再黑剪影）
      // ---------------------------------------------------------------------
      weatherBy: {
        day: {
          name: '熔岩白昼',
          icon: '☀️',
          // 火山图保留自己的一套调色，不让动态昼夜把水色/雾色冲淡
          noDayCycle: true,
          fogColor: 0xb8a89b,
          fogDensity: 0.0013,
          sunColor: 0xffe6c4,
          sunIntensity: 1.85,
          sunPos: [180, 260, 120],
          sunDir: [0.45, 0.7, 0.3],
          hemiSky: 0xd2dae2,
          hemiGround: 0x4e2c20,
          hemiIntensity: 1.05,
          // 火山白天的水也跟着主天气一起收成深蓝（原来 #54B6E4 太浅，
          // 继承了全局 day 的低倒影后会显得发灰）。保留比其它图稍亮的调子，
          // 配合这里更强的日照和暖色地平线。
          waterColor: 0x2085be,
          waterDeep: 0x0e4672,
          waterCrest: 0xe4f7ff,
          waveScale: 1.15,
          cloudColor: 0xd8cfc6,
          sky: {
            tint: 0xfff2e4,
            horizonColor: 0xd9b49a,
            top: 0x9db4c6,
            exposure: 0.17,
            sat: 1.48,
            haze: 0.62,
            halo: 0.34,
            cover: 0.56,
            opacity: 0.9,
            cirrus: 0.4,
            overcast: 0.14,
          },
        },
        dusk: {
          name: '熔岩黄昏',
          icon: '🌇',
          fogColor: 0x40201f,
          fogDensity: 0.0020,
          sunColor: 0xff7a30,
          sunIntensity: 1.3,
          sunPos: [340, 70, 140],
          sunDir: [0.9, 0.18, 0.35],
          hemiSky: 0x9a5262,
          hemiGround: 0x2a1012,
          hemiIntensity: 1.05,
          waterColor: 0x3e86a4,
          waterDeep: 0x1c2f4e,
          waterCrest: 0xffc79a,
          waveScale: 1.5,
          cloudColor: 0x6d2c26,
          sky: {
            tint: 0xffb083,
            horizonColor: 0xff6a2a,
            top: 0x6b3a5a,
            exposure: 0.24,
            sat: 1.7,
            haze: 0.8,
            halo: 0.58,
            cover: 0.72,
            opacity: 0.94,
            cirrus: 0.46,
            overcast: 0.18,
          },
        },
        storm: {
          name: '熔岩雷暴',
          icon: '⛈️',
          fogColor: 0x3a3038,
          fogDensity: 0.0050,
          // 暴雨档在 Environment 里会把场景雾压暗 0.34，熔岩图不能压那么狠，
          // 否则远景火山群彻底消失（这只影响 scene.fog，水面用自己那套雾色）
          fogDarken: 0.62,
          sunColor: 0xb2a8b4,
          sunIntensity: 0.9,
          sunPos: [120, 200, -80],
          sunDir: [0.3, 0.6, -0.2],
          hemiSky: 0x6e6674,
          hemiGround: 0x1c1214,
          hemiIntensity: 1.0,
          waterColor: 0x2e5f78,
          waterDeep: 0x0d2033,
          waterCrest: 0xbccdd4,
          waveScale: 2.25,
          cloudColor: 0x33282e,
          rain: 1,
          sky: {
            tint: 0x3a3238,
            horizonColor: 0x5d4a4c,
            top: 0x46505e,
            exposure: 0.115,
            sat: 0.72,
            haze: 0.88,
            halo: 0,
            cover: 0.34,
            opacity: 0.5,
            cirrus: 0.16,
            overcast: 1.0,
            sunDisc: 20,
            cloudLight: 0x2f2a33,
            cloudShadow: 0x0b0a0e,
            cloudRim: 0x3d3440,
          },
        },
        blizzard: {
          name: '熔岩雪暴',
          icon: '❄',
          fogColor: 0xd9d3d9,
          fogDensity: 0.0058,
          sunColor: 0xe8eef6,
          sunIntensity: 0.72,
          sunPos: [150, 55, 95],
          sunDir: [0.72, 0.27, 0.46],
          hemiSky: 0xe2e8f0,
          hemiGround: 0x6a5a58,
          hemiIntensity: 1.3,
          waterColor: 0x6a8ea0,
          waterDeep: 0x2a4658,
          waterCrest: 0xeef8ff,
          waveScale: 1.55,
          cloudColor: 0xeef2f8,
          snow: 1,
          sky: {
            tint: 0xeef2f8,
            horizonColor: 0xf2f0f4,
            top: 0xc4cad2,
            exposure: 0.44,
            sat: 0.72,
            haze: 0.9,
            halo: 0,
            cover: 0.92,
            opacity: 1.0,
            cirrus: 0.42,
            overcast: 0.82,
            sunDisc: 3,
            cloudLight: 0xf6fafd,
            cloudShadow: 0x9db2c4,
            cloudRim: 0xffffff,
          },
        },
        starry: {
          name: '熔岩星夜',
          icon: '🌋',
          fogColor: 0x241224,
          fogDensity: 0.0017,
          sunColor: 0xffa257,
          sunIntensity: 1.05,
          sunPos: [-220, 150, -320],
          sunDir: [-0.5, 0.35, -0.73],
          hemiSky: 0x7a4670,
          hemiGround: 0x321216,
          hemiIntensity: 1.35,
          waterColor: 0x46a8dc,
          waterDeep: 0x123a5e,
          waterCrest: 0xe4f7ff,
          waveScale: 1.65,
          cloudColor: 0x3a1d3e,
          // 熔岩图的"亮蓝水道"要压得比其它图轻：它本来就是唯一的冷色参照，
          // 压到通用星空档（0.68）会把航道和黑地壳糊成一片（此前就是这么翻车的）。
          waterGrade: { sat: 1.02, exposure: 0.82, absorb: 0.024 },
          sky: {
            tint: 0x363059,
            horizonColor: 0x5c3a4e,
            top: 0x141833,
            exposure: 0.24,
            sat: 1.36,
            nightMix: 0.88,
            nightColor: 0x2a2a52,
          },
        },
      },
    },
  },
];

export function getMap(id) {
  return MAPS.find((m) => m.id === id) || MAPS[0];
}

/**
 * 潮汐相位因子：正弦波，周期 period 秒，返回 -1..1。
 * 0 ≈ 平潮（水流最弱），+1 / -1 是两次潮流峰值（方向相反）。
 * 纯函数且只吃 elapsed，联机各端算出来的相位完全一致。
 */
export function tidalFactor(elapsed, period = 18) {
  return Math.sin((elapsed / period) * Math.PI * 2);
}

// ---------- 昼夜 + 天气预设（应用到所有地图） ----------
// day: 晴朗白天（地图默认外观）
// dusk: 黄昏（金色海面、低角度夕阳、浪略大）
// storm: 暴风雨（乌云暴雨、能见度低、浪大幅增高）
export const WEATHERS = [
  {
    id: 'day',
    name: '晴朗白天',
    icon: '☀️',
    // 夏日大晴天：天顶 #6DABEF → 地平线 #D4E8FF（更亮、更蓝、更白）
    // 与 RealSky 的 day 预设同色，水面倒影和真实天空才对得上。
    skyTop: 0x6dabef,
    skyBottom: 0xd4e8ff,
    // 远处空气透视：改用偏蓝的雾（原来是灰蓝 #7E96AD，把水面洗成白蒙蒙）。
    // 浓度略降，远海保留深蓝层次而不是和天空糊成一片。
    fogColor: 0x6a8fae,
    fogDensity: 0.0019,
    sunColor: 0xfff8f0,
    // 2026-11-17 二次加深（用户："再蓝一点、偏深蓝"）：
    // 近水 #14649F → 深水果蓝，远水 #083C66 → 深海军蓝；
    // absorb 提到 0.021 让中远景更快沉入深蓝，近处仍透得出波纹。
    waterColor: 0x14649f,
    waterDeep: 0x083c66,
    waterCrest: 0xc5e6f7,
    // SSS 透光从近白 #BFE6F5 改成偏蓝，浪峰透出来的光不再把整片海洗白
    waterSSS: 0x6cc4ee,
    // sat 拉高保蓝，exposure 压一档去白，absorb 略提让远水沉下去
    waterGrade: { sat: 1.16, exposure: 0.82, absorb: 0.021 },
    // 倒影三件套一起收：天空是浅色，给满了就是"水面刷了一层天"。
    // envAmt 0.75→0.55、envMax 1.30→1.05、reflMax 0.52→0.38，
    // 水色透出来，但保留掠射角的天空光和碎波高光（不会变成不反光的死水）。
    // 2026-11-18 写实化：上面那档收得过头（A/B 图里开/关反射几乎一样，水面发哑）。
    // 只有环境反射能把天空和云带上来，回调一档但不到"水面刷一层天"：
    // envAmt 0.55→0.68、envMax 1.05→1.25、reflMax 0.38→0.50。
    // 水色 uniform 一个没动，反射只改变"水面映到多少天空"，不改水体本身的颜色。
    // A/B 三档实拍后取中间偏上（tests/water_spot_diag.mjs 的 reflHigh）：
    // 中景出现天空反射带、波纹有明暗，水仍然是蓝色的水；reflMax 0.95 那档太泛白。
    envAmt: 0.78,
    envMax: 1.5,
    reflMax: 0.62,
    waveScale: 1.0,
    sunIntensity: 1.6,
    // 2026-11-17：晴朗白天也要"看得见太阳、水面有光带"。
    // 太阳压到约 14° 仰角（黄昏是 10°），方位偏北（多数地图起步朝北，正对太阳）：
    // 太高（26°）时追尾镜头只看船，太阳永远在画面上沿之外，玩家看不到"太阳照水面"，
    // 只看到一条凭空出现的亮带。压低后太阳与它在水里的碎光路能同框。
    // ⚠ sunDir 必须和 sunPos 同向（水面高光/闪光全靠它对齐天空里的太阳盘），
    //   改一个就得改另一个，否则会出现"天上一个太阳、水里一个"。
    sunPos: [205, 88, 285],
    sunDir: [0.565, 0.242, 0.785],
    // 碎波反光倍率（Water 的 uGlint）：晴天略高于基准，让光路两侧有碎闪，
    // 而不是一整条平滑的亮带。GGX 主高光仍负责"从太阳拉到眼前的光路"，
    // 这里只是叠加一点会随波纹闪动的小光斑；给太高会把水面撒满白点。
    glintGain: 1.05,
    hemiIntensity: 0.9,
    hemiSky: 0xd9e8f6,
    hemiGround: 0x6c8296,
    cloudColor: 0xf6f7f7,
    rain: 0,
  },
  {
    id: 'dusk',
    name: '黄昏海面',
    icon: '🌇',
    skyTop: 0x35386e,
    skyBottom: 0xff9a5c,
    fogColor: 0xd8906c,
    fogDensity: 0.0034,
    sunColor: 0xff7a3c,
    waterColor: 0x3a8f96,
    waterDeep: 0x1c3a5c,
    waterCrest: 0xffd9a8,
    waveScale: 1.3,
    sunIntensity: 1.3,
    sunPos: [340, 70, 140],
    sunDir: [0.9, 0.18, 0.35],
    hemiIntensity: 0.6,
    cloudColor: 0xffc9a0,
    rain: 0,
  },
  {
    id: 'storm',
    name: '暴风雨',
    icon: '⛈️',
    skyTop: 0x222b36,
    skyBottom: 0x4a5662,
    fogColor: 0x69737e,
    fogDensity: 0.0058,
    sunColor: 0x9fb0c0,
    waterColor: 0x2d5158,
    waterDeep: 0x0e1f28,
    waterCrest: 0xb8c8cc,
    waveScale: 2.4,
    sunIntensity: 0.55,
    sunPos: [120, 200, -80],
    sunDir: [0.3, 0.6, -0.2],
    hemiIntensity: 0.45,
    cloudColor: 0x3a434e,
    rain: 1,
  },
  {
    id: 'blizzard',
    name: '暴风雪',
    icon: '❄',
    // 暴雪天是“亮而弥散的冷白”，不是压暗的黑灰：天顶冷蓝灰、地平线雪白，
    // 高浑浊度让云层厚实但不发黑（云色由 RealSky 的 blizzard 预设给出）。
    // 2026-11-17 温和压曝：雾从 0.0066 降到 0.0046，远景不再糊成白墙；
    // 天/雾色各压深一档，保留雪天的冷白感但让浮桶和赛道重新读得出来。
    skyTop: 0xb6cce0,
    skyBottom: 0xdfeaf4,
    // 2026-11-18：雾 0.0046 → 0.0055（+20%）—— FogExp2 透过率
    // 100m: 0.81→0.75、200m: 0.43→0.34，远山/远水面开始化进雪幕，
    // 80m 内浮桶仍有 0.85+ 对比，赛道读得出来。雾色略提亮，远景是"白雾"不是灰墙。
    // 水面自带 uFogDensity（setWeather 同步），所以水天会一起雾，不会出现
    // "天糊了水还清晰"的割裂。
    fogColor: 0xd4e0eb,
    fogDensity: 0.0055,
    sunColor: 0xe9f3ff,
    // 水面整体压成冷蓝灰：去掉偏暖的灰青，蓝灰里留一点亮度，衬白色碎浮冰
    waterColor: 0x597483,
    waterDeep: 0x22384a,
    waterCrest: 0xdcecf8,
    waveScale: 1.55,
    // 太阳压到近地平线：直射光很弱，冷白以天光（hemi）为主
    sunIntensity: 0.5,
    sunPos: [150, 55, 95],
    sunDir: [0.72, 0.27, 0.46],
    // 天光给足：受光面冷白、背光面冷蓝（hemiSky / hemiGround）
    hemiIntensity: 1.02,
    hemiSky: 0xd4e2ef,
    hemiGround: 0x5a7086,
    cloudColor: 0xf2f7fc,
    rain: 0,
    snow: 1,
  },
  {
    id: 'starry',
    name: '璀璨星空',
    icon: '🌌',
    // 夜空：天顶近黑蓝、地平线一圈更深一点的蓝紫；雾也是深蓝紫，
    // 让远山/小岛沉进夜色里，而不是被亮雾衬成剪影。
    skyTop: 0x070d22,
    skyBottom: 0x39527f,
    fogColor: 0x1d2745,
    fogDensity: 0.0021,
    sunColor: 0xcfe0ff,
    // 水面压暗成深蓝夜色，但整体再抬一档：玩家反馈"看不清赛艇和水面"，
    // 这里把浅水/深水都提亮，配合下面加强的月光与环境光保证航道可读。
    waterColor: 0x3b6398,
    waterDeep: 0x152a45,
    waterCrest: 0xd0e7ff,
    // 夜里风小，浪比白天柔和一点
    waveScale: 0.85,
    // 夜晚光照：冷白月光 + 抬亮的蓝色环境光。
    // 之前 0.3/0.5 太暗，赛艇只剩黑色剪影；现在月光 0.85、环境光 1.0，
    // 浮标/旗门/护栏和船体在水面上都清晰可辨。
    sunIntensity: 0.85,
    sunPos: [-220, 150, -320],
    sunDir: [-0.5, 0.35, -0.73],
    hemiIntensity: 1.0,
    hemiSky: 0x4c679e,
    hemiGround: 0x1b2b45,
    cloudColor: 0x39476b,
    rain: 0,
    stars: 1,
    // 夜海水体档：白天那套 0.94/0.86/0.019 是配"亮天空倒影"调的，
    // 夜里天空只剩深蓝+月亮，同一档会读成"灰亮的白板"，赛道浮标全糊掉。
    // 压曝光 + 提饱和 + 加深吸收 → 深蓝夜海 + 一条银色月光路，白蓝浮标/荧光路缘反而更跳。
    // 只覆盖这三项，其它天气不传 waterGrade，数值一字不变。
    waterGrade: { sat: 1.10, exposure: 0.68, absorb: 0.030 },
  },
];

export function getWeather(id) {
  return WEATHERS.find((w) => w.id === id) || WEATHERS[0];
}
