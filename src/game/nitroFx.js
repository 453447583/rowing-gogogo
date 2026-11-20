// 氮气尾焰 / 粒子弹道共用的素材配置。
//
// 竞速 / 道具模式：逐船差异化尾焰（NITRO_JETS，Game.js 与怪物模式主炮共用同一张表）。
// 怪物模式：加速尾焰统一回到最早那版 Basic/Laser01（旧 `jet` 定向喷射），
// 这样加速的观感一致，赛艇之间的区别只体现在攻击粒子上。

//   fx     效果名（Effects.FX_DEFS 的键）
//   scale  实例缩放：素材自带的尺寸偏小，1.0 左右才看得出是一束喷射
//   color  染色（十六进制，乘法；用浅色保留亮度，只改色相）
//   points center = 船尾正中单喷口；sides = 船尾左右双喷口；triple = 左中右三喷口全开
//   loopEvery 每隔多少秒补喷一发（旧实例不打断，叠加成持续不断的尾焰）
//          ⚠ 它同时决定"尾迹的颗粒间距"：间距 = 船速 × loopEvery。
//            实战 30m/s 下 loopEvery 0.04 就是每 1.2m 一颗，素材本体不够大时
//            肉眼会看成"一截一截"的断续火苗 —— 这就是绯鲨 / 流光"时断时续"的真正原因。
//   pool   同一喷口最多同时存活几发（防止叠太多掉帧）
export const NITRO_JETS = {
  // core：可选的内层火芯，叠在同一个喷口上，做出"外焰包内焰"的双层燃烧
  rower:    { fx: 'fxFireBall',  scale: 1.05, color: 0xffa860, points: 'center', loopEvery: 0.05, pool: 10, trail: true,
              core: { fx: 'fxFireBurst', scale: 0.6, color: 0xffe6b0, loopEvery: 0.07, pool: 8 } }, // 赤焰号：火 · 大团橙焰 + 白热火芯
  skiff:    { fx: 'toonWater',   scale: 1.15, color: 0xd8feff, points: 'triple', loopEvery: 0.045, pool: 6, trail: true, atkScale: 0.5,
              // 绯鲨号：水 · 直线射流（主）+ 水花粒子（辅）
              // 2026-11-19 玩家反馈「特效太淡、地图里看不清」：原来只有 toonWater 一团
              // 水沫粒子，散、淡、没方向。现在主视觉换成纯 three.js 的「直线水流」射流
              // （NitroJetStream.js：三喷口各一根笔直向后的锥形水柱 + 流动条纹 + 末端渐隐），
              // toonWater 粒子降级为末端辅助：loopEvery 0.025→0.045、池 10→6，
              // 单口实例数从 10 降到 6（总 30→18），省下的填充率给水柱。
              // ⚠ 粒子那套「密而近」的历史结论仍然成立（见下方旧注），但主视觉已是水柱。
              stream: { length: 7.4, radius: 0.2, color: 0x9fefff, flow: 5.0, opacity: 3.0 },
              // 绯鲨号：水 · 青色水花尾（素材仍是 toonWater，**不换素材**）
              // 2026-11-18 三次修正（玩家反馈"尾焰时断时续，比其他船弱"）：
              //   ① 素材本身是一颗颗水球，30m/s 下每 1.2m 才一颗 → 看成断续。
              //      改 loopEvery 0.05→0.025（间距 1.2m→0.75m），把尾迹连成一条。
              //   ② 原来只有左右两个喷口，加开中间喷口（points: 'triple'），
              //      横向铺开成扇形水幕，比"把一颗水球吹大"强得多。
              //   ③ 尺寸 0.9→1.3 到"大水花"级别，不再往上加（1.4 实测糊成罩住船尾的水罩）。
              // 实测亮像素（SPEED=30，同机位像素差法）：原版 17.9% → 现在 24.5%
              // （赤焰号火球 35.6%；水花素材天生面积小，avgDelta 已经和赤焰号齐平 61 vs 59，
              //  差的只是"面积"，而这素材再放大就变水罩 —— 24~25% 是它的上限）。
              // 也试过 trail:false（粒子全叠喷口）→ 只剩 16.2%，水花被船体挡住，**必须留 trail**。
              // （历史）当时单口池 10×3 口 = 30 发已是帧率临界；现降到池 6（共 18 发），
              //   省出的填充率让给 three.js 水柱，纯粒子阶段到此收尾。
              },
  // 青锋号的高速粒子弹用更大的风团，否则 150m/s 下几乎看不见
  falcon:   { fx: 'fxWind1',     scale: 0.75, color: 0xc9fff0, points: 'sides',  loopEvery: 0.05, pool: 9, trail: true, atkScale: 0.95 }, // 青锋号：风 · 青色气团拖尾
  titan:    { fx: 'fxIceShards', scale: 0.55, color: 0xcfd8d0, points: 'sides',  loopEvery: 0.06, pool: 8, trail: true }, // 磐石号：土 · 碎石拖尾
  dolphin:  { fx: 'fxMagicThunder', scale: 0.45, color: 0xc8d4ff, points: 'triple', loopEvery: 0.03, pool: 3, trail: true, atkScale: 0.33,
              // 光束外面再裹一层纯 three.js 的紫色粒子（随风向后飘散），见 NitroSparkles.js。
              // 只对本地玩家生效、只在竞速/道具/挑战（非 BOSS）时喷；参数在此统一配置。
              // size 不过 0.62：加法混合的大柔边点在近景过度绘制（overdraw）很吃填充率，
              //   实测 0.8 时 fps 从 38 掉到 23，0.62 能拉回 30+ 且颗粒仍然清楚。
              sparkle: { color: 0x9b6bff, rate: 100, size: 0.7, max: 200, drag: 1.2,
                         minLife: 0.85, maxLife: 1.55, rise: 1.5 },
              // 流光号：雷 · 蓝紫三束笔直光束尾焰
              // 2026-11-19 选型定稿：原 fxIceMist（冰雾膨胀 = 一大张软边白团）被玩家判为
              // 「都是灰尘、看不清」。先后试过 BOSS 的 P2_SwordLightning（蓝紫雷斩）——
              // 它自带 2 个 3D 剑模型，船尾会飞出一把黑剑（视觉 bug），且本质是原地爆发，
              // 调不出「向后喷的光束」，弃用。最终改用 N_MagicThunder（纯贴图、零模型、
              // 素材包从未被任何特效登记使用）：原素材是竖直落雷柱，Game.#updateNitroFx 的
              // rot（x=π/2 转水平 + y=heading+π）把它转成笔直向后喷的蓝紫光束，最贴「流光」。
              // 布局定 triple：船尾左中右三个喷口各射一束 → 扇形三道光刃，是三种布局里
              // 最炸裂、最宽的一版（单束 center 太细，双束 sides 居中；实测对比见
              // shots/nitro/ab_T_*.jpg）。尾迹长度 ≈ 速度 × loopEvery × 池，但这段素材的
              // **单发光柱本身就长**，光靠减 loopEvery 收不动，真正决定长度的是 scale。
              // 2026-11-19 玩家两次反馈「太长太夸张」：先 loopEvery 0.06→0.03（收尾迹），
              // 再把 scale 0.8→0.45，光束长度从约半屏缩到约 1/4 屏（≈原来一半），
              // 三束 + 喷口 Burst 光爆仍在（实测对比见 shots/nitro/ab_S080/055/045.jpg）。
              // ⚠ scale 再小光束就散成点、不成束了；这个素材靠 0.45 才是「短而炸」的甜点。
              },
  vintage:  { fx: 'fxArcBolt',   scale: 0.6,  color: 0xd0f2ff, points: 'center', loopEvery: 0.05, pool: 9, trail: true }, // 琥珀号：雷 · 电光拖尾
  longship: { fx: 'fxFireBand',  scale: 0.3,  color: 0xffdcc0, points: 'sides',  loopEvery: 0.4,  pool: 2 }, // 长鲸号：火 · 笔直长焰（保留）
  // 牛来号的尾焰本身是一大团浓雾，当弹丸用时必须收得很小，否则会糊住整屏
  cow:      { fx: 'fxUpdraft',   scale: 0.5,  color: 0xe6d8c0, points: 'center', loopEvery: 0.35, pool: 4, atkScale: 0.12 }, // 牛来号：风 · 浓重气流团（最笨重）
};

// 怪物模式的统一加速尾焰：最早版本的 `jet`（Basic/Laser01 定向喷射），
// 单喷口、跟随喷口不拖尾，和当年的表现一致。
export const BOSS_BOOST_JET = {
  fx: 'jet', scale: 0.18, points: 'center', loopEvery: 0, pool: 1,
};

/**
 * 怪物模式主炮的飞行体外观：默认取该赛艇竞速氮气尾焰的同一段素材，
 * 缩小到弹丸体量（尾焰的 0.55 倍），让攻击读起来就是"氮气尾焰散成粒子飞出去"。
 *
 * 2026-11-18：只允许在原素材上加参数，**禁止换素材**（玩家明确要求）。
 * `atkFx` / `atkColor` 这两个口子保留着，万一以后某条船的尾焰和攻击弹道
 * 需要分开时可以直接钉，但默认必须走同一套素材，保证"攻击弹 = 尾焰散成的粒子"。
 */
export function nitroAttackFx(boatId) {
  const cfg = NITRO_JETS[boatId];
  if (!cfg) return null;
  return {
    fx: cfg.atkFx || cfg.fx,
    color: cfg.atkColor ?? cfg.color,
    scale: cfg.atkScale ?? cfg.scale * 0.55,
  };
}
