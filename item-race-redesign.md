# 道具赛 · 道具全表 + 更新/新增方案（先过目，未动代码）

> ⚠️ 2026-11-04 更新：本文件是**方案稿**，至今未落地。
> 现状复核（含追踪弹道死循环修复 + 特效层数盘点 + 重新排序的建议）见 `item-race-review-2026-11-04.md`，
> 两者冲突时以新文件为准。

> 依据：`src/game/Items.js`（ITEM_DEFS / useItem / rollItem）、`src/game/Boat.js`（applyFx 状态机）、
> `src/game/Effects.js`（FX_DEFS）、`public/effects/` 现有 26 个 `.efkefc`。
> 道具栏 3 格（`myItems = [null,null,null]`，键位见 `SLOT_KEYS`），按名次权重抽取（`rollItem`）。
> 标 ★ 的是**机制改动**，需要你点头；标 ☆ 的是纯换皮/调参，风险低。

---

## 一、现状全表（15 个）

| # | id | 名称 | 目标选择 | 实际效果 | 时长 | 权重（领先→垫底） |
|---|----|------|---------|---------|------|------------------|
| 1 | `nitro` | ⚡ 氮气瓶 | 自己 | `boostTimer` 加速 | 2.2s | 2.6 → 1.6 |
| 2 | `bomb` | 💣 深水炸弹 | 前一名 | 追踪弹道，命中 `sink`（沉没+眩晕） | 2s | 0.5 → 2.3 |
| 3 | `octopus` | 🐙 章鱼 | 前一名 | 追踪弹道，命中 `octoGrab`（转向锁死+拖拽偏航+速度 -30%） | 2s | 1.2 |
| 4 | `shield` | 🛡️ 护盾 | 自己 | `shieldTimer` 免疫一切道具 | 3s | 2.0 → 1.4 |
| 5 | `missile` | 🚀 追踪导弹 | 前一名 | 追踪弹道，命中 `slow`（极速 ×0.4） | 1.6s | 0.3 → 2.5 |
| 6 | `vortex` | 🫧 漩涡 | 前方 100m 赛道点 | 巨型水泡，AoE 半径 9m，命中 `bubbleLift` 升空 | 5s | 1.2 → 1.6 |
| 7 | `magnet` | 🧲 磁力吸盘 | 前方视野锥内最近者 | `magnetTimer` 把自己吸向目标 | 2.5s | 0.7 → 2.2 |
| 8 | `ink` | 🌑 墨鱼喷墨 | **全部对手** | 糊屏遮罩（上限 0.6）+ `inkStun` 失控 | 5s | 0.9 → 1.4 |
| 9 | `waterfall` | 🌊 深海瀑布 | 自己 18m 内 | `geyserLift` 水柱冲上天空 | 3s | 0.9 → 1.5 |
| 10 | `angel` | 😇 天使庇佑 | 自己 | 无敌 + 清全部负面 + 小加速 | 3s | 1.0 → 0.7 |
| 11 | `fish` | 🐟 飞鱼群 | 所有领先者 | 瞬发多目标，命中 `slow` | 1.6s | 0.5 → 2.1 |
| 12 | `rvortex` | 🌊 海洋之怒 | **第一名** | `spin` 原地打转 | 2s | 0.4 → 1.8 |
| 13 | `slowboat` | 🐢 减速艇 | **全部对手** | `halfSpeed` 极速 ×0.5 | 4s | 0.8 → 1.4 |
| 14 | `tide` | 😈 方向转换器 | **全部对手** | `reverse` 左右操控反转 | 5s | 0.7 |
| 15 | `bubblefly` | 🫧 泡泡蜻蜓 | 前一名 | 追踪弹道，命中 `void` 异世界（船消失） | 3s | 0.7 → 1.5 |

**飞行体一览**（都在 `Items.js` 里程序化生成，非 GLB）：
`#makeBomb` 深灰球 / `#makeMissile` 锥+柱 / `#makeOctopus` 紫团+触手 / `#makeBubbleFly` 泡泡。
命中表现目前高度同质：`#spawnBurst`（火星）+ `fx.play('hit')`，只有 `sink` 走 `explosion`。

---

## 二、问题诊断（5 条，决定了下面为什么这么改）

1. **"追踪前一名"重复 4 次**（bomb / missile / octopus / bubblefly），玩家手上四个道具长得一样、飞的路线一样，只有命中后的 debuff 不同 → 抽到哪个都不兴奋。
2. **"打全体/打领先者"重复 4 次**（ink / fish / slowboat / tide），且全是减速或失控，缺少"看得见的物理反馈"。
3. **没有任何反制手段**：被导弹锁了就必中。护盾只能自保，且 CD 之外毫无办法 → 落后的人只能被动挨打。
4. **纯收益道具只有 3 个**（nitro / shield / angel），垫底玩家抽到道具的期望收益不够，"越落后越爽"的追赶曲线不够陡。
5. **命中视觉没有辨识度**：同一个 `hit` 环套在 9 个道具上，玩家分不清"我是被炸弹还是被导弹打中的"。

---

## 三、现有道具更新（10 项，按优先级）

### P0 — 立刻做，改观感不改数值

| 道具 | 改动 | 特效（素材见第五节） |
|------|------|---------------------|
| `bomb` ☆ | 飞行体从直线改**贴水面跳弹**（两次落点水花 + 抛物线），命中水柱复用 `#spawnGeyser` | 出手 `muzzleLight` / 落点 `toonWater` / 命中 `hanmadoHit(0.45)` + 水柱 |
| `missile` ☆ | 加尾焰持续粒子 + 命中**焦痕闪白**（船身材质 emissive 0.12s） | 飞行 `missile`(Laser03) / 命中 `hanmadoHit(0.32)` + `Simple_Turbulence_Fireworks(0.25)` |
| `vortex` ☆ | 水泡命中改**泡泡破裂**而不是火星爆 | 生成 `pudding(0.5)` / 破裂 `bubblePop`(Ring1, 1.6) |
| `ink` ★ | **全体糊屏 5s → 前方 60° 锥形喷墨**，只有被喷到的糊屏；护盾仍免疫 | 喷出 `Simple_Distortion(0.5)` + `Simple_Sprite_FixedYAxis` 做墨云 |

> `ink` 的理由：现在是"按一下全屏黑 5 秒"，4 人局里按一次等于全场无差别惩罚，且没有躲避动作。
> 改成锥形后玩家有"侧移躲墨"的操作空间，也让护盾/天使的价值上升。

### P1 — 需要新状态（改动量中等）

| 道具 | 改动 | 说明 |
|------|------|------|
| `magnet` ★ | 从"被吸过去"改**磁力抓钩冲刺**：朝目标射一条磁力线，自己 1.2s 内加速冲向目标 | 现在的手感是"被拖着走"，玩家会以为是受害而不是获益；改成主动冲刺，读作加速道具 |
| `rvortex` ★ | 更名为 **深海水龙卷**，视觉从"水漩涡"换 ForceFieldTornado 冷色 | 和 `vortex`（水泡）视觉太像，玩家分不清 |
| `fish` ★ | 5 条编队沿固定弧线掠过（可被躲），不再是瞬发必中 | 保持"打领先者"，但给出反应窗口 |
| `slowboat` ★ | 全体半速 4s → **投放减速浮标**（身后 12m 一片半径 9m 的黏水域，5s） | 全体减速太粗暴，改成地形型更有攻防 |
| `tide` ★ | 反转时长 5s → **2.6s**，权重 0.7 → 0.5 | 键盘上反转 5 秒会晕；缩短后是"惊吓"而不是"折磨" |
| `bubblefly` ★ | 异世界期间**保留半透明轮廓**（现在是完全消失） | 看不到自己船会被误判成卡死 |

### 建议下架 / 合并（要你定）

- `fish` 与 `rvortex` 都在"惩罚领先者"，二者留一个即可；建议留 `rvortex`（有明确视觉落点）。
- 净效果：15 → 14，再用新增补到 17~18。

---

## 四、新增道具建议（6 个，按推荐顺序）

> 设计约束：① 不与现有 15 个机制重复；② 每个都要能**被反制**；③ 只复用文件夹里已有的 effkefc；
> ④ 不改 `BOSS_ITEM_DEFS`（BOSS 模式独立池，新道具默认不进，避免影响已验收的怪物模式平衡）。

### 1. 🛢️ 油膜泄漏 `oil` — 放置型陷阱（★强烈建议）

- **机制**：船尾持续洒一道 **26m 长 / 4m 宽**的油膜带，8 秒后消散。踩上去：转向灵敏度 ×0.35 + 随机偏航，持续 1.2 秒。
- **为什么加**：现有放置类道具是 0 个（全是飞行/瞬时）。油膜创造"走后门"的博弈——领先者可以在窄道口埋一条。
- **反制**：看到水面色差可以走另一侧；天使庇佑清除。
- **特效**：`ProceduralPudding`（半透明流质，配色压成深蓝黑）+ `Simple_Track1` 做拖痕。
  `pudding` 目前在 `FX_DEFS` 里只被黏液用，语义正好吻合。
- **改动量**：`Items.js` 新增 `#spawnOilSlick` + 每帧判定（参考 `#spawnFish` 的生命周期），`Boat` 加 `oilSlipTimer`。

### 2. 🎭 诱饵浮标 `decoy` — 防御/欺骗（★强烈建议）

- **机制**：原地留下一个**假船 + 锁定标记**，持续 5 秒。期间敌方所有"自动锁定"类道具（bomb / missile / octopus / bubblefly / magnet）的目标**改指向假船**，命中后直接消失。
- **为什么加**：这是当前系统最缺的一环——**反制手段**。上面 4 个"追踪前一名"道具第一次有了天敌。
- **反制**：手动方向类道具（vortex / waterfall / 水雷）不受影响。
- **特效**：生成 `Simple_SpawnMethod1` + 假船半透明青色描边；被拦截时 `toonHit`。
- **改动量**：`#findChaseTarget` / `#findMagnetTarget` 加一层 decoy 判定；decoy 实体复用 BOSS 模式已有的 `decoy` 逻辑。

### 3. 🐟 鱼雷齐射 `torpedo` — 直线攻击（★）

- **机制**：正前方 3 条平行鱼雷（±6° 扇形），命中目标**翻船**：船体绕 Z 轴 180° + 速度清零 1.2s。
- **为什么加**：现有攻击全是"自动命中"，缺一个**需要瞄准**的高回报道具（贴脸放=必中，远放=可能空）。
- **反制**：侧移 + 护盾 + decoy 无效（非锁定类）。
- **特效**：飞行 `Laser03`(missile) ×3 或 `ribbonTail`；命中 `hanmadoHit(0.35)` + `toonWater`。翻船状态用 `Boat` 的 `rotation.z` 插值，不需要新素材。
- **改动量**：`#addProjectile` 多发射一次即可；翻船需在 `Boat` 加 `capsizeTimer`（注意和 `spinTimer` 互斥）。

### 4. 🧿 反射护盾 `reflect` — 防御反击（★）

- **机制**：3 秒内**第一次**被道具命中时，把该道具原样打回施放者（一次性，不免疫后续）。
- **为什么加**：护盾是"免伤"，天使是"免伤+清状态"，都不改变战局。反射能把"挨打"变成"反杀"，是最高光时刻。
- **反制**：先用小道具（ink / oil）骗掉反射，再上导弹。
- **特效**：`Barrior03`（原本就是反磁护盾素材，最贴"反射"语义）+ 命中瞬间 `ring` 向外一波。
- **改动量**：`#applyItemHit` 入口加一次 `reflectTimer` 判定；回弹方向 = 攻击者位置。

### 5. 🧨 深海水雷 `mine` — 放置反制（☆，可后置）

- **机制**：从 BOSS 模式移植：身后投放，9 米警戒圈，踩到 `sink` 1.5s。
- **为什么加**：给追赶者一个"守住弯心"的手段；且代码几乎现成（`BOSS_TRAP_ITEMS`）。
- **特效**：`hit`(Ring2) 警戒圈 + `toonWater` 爆开。

### 6. 🌀 潜流甬道 `gate` — 位移/近道（可选，偏强）

- **机制**：在前方最近的一条近道入口生成持续 4 秒的传送涡流，穿过即送到近道出口（每人限用一次）。
- **风险**：直接改变赛道几何利用方式，容易打破平衡。**建议只给第 3 名及以后抽取**（权重里加名次门）。
- **特效**：`ForceFieldTornado`（本身就是力场龙卷，做传送门最像）。

### 不建议加的（已评估并否决）

| 想法 | 否决理由 |
|------|---------|
| 雷电/落雷 | 与天气、BOSS 落雷视觉冲突，玩家会误读成环境危险 |
| 加速带铺设 | 与赛道既有 `launch bars` 功能重叠 |
| 磁力互吸（把两人拉一起） | 单机只有 AI 时无意义，且已被 `magnet` 占据语义 |
| 护盾共享（给队友） | 联机 2v2 才有意义，当前是单人竞速为主 |

---

## 五、特效映射总表（全部使用 `public/effects` 现有素材）

### 现有 26 个素材的占用情况

| 素材 | 已用在哪 | 还能给谁用 |
|------|---------|-----------|
| `Version16/Aura01` | nitro 光晕 / bubble | angel 金色、surge 水墙底光 |
| `Version16/Barrior01` | shield | — |
| `Version16/Barrior02` | magnet | magnet 改抓钩后继续用 |
| `Version16/Barrior03` | antimagn（BOSS 池） | **reflect**（首选） |
| `Version16/ForceFieldTornado` | tornado | **gate**、rvortex 更名后的龙卷 |
| `Version16/ProceduralPudding` | pudding（黏液） | **oil 油膜**、vortex 破裂 |
| `Basic/Laser01` | jet（氮气喷射） | torpedo 尾焰备选 |
| `Basic/Laser02` | itemBeam（飞鱼） | ink 喷射 |
| `Basic/Laser03` | missile | **torpedo 飞行体** |
| `Basic/Simple_Ribbon_Parent` | ribbonTail | surge 水墙 |
| `Basic/Simple_Ribbon_Sword` | slashRibbon | （小怪光弧） |
| `Basic/Simple_Ring_Shape1` | ring / bubblePop | reflect 反弹波 |
| `Basic/Simple_Ring_Shape2` | hit / mine | **水雷警戒圈** |
| `Basic/Simple_SpawnMethod1` | spawnRing | **decoy 生成** |
| `Basic/Simple_Track1` | tide | **oil 拖痕** |
| `Basic/Simple_Distortion` | ink | ink 锥形喷墨 |
| `Basic/Simple_Turbulence_Fireworks` | explosion | missile 命中叠层 |
| `Basic/Simple_Turbulence_Particles` | decoy（BOSS） | **道具赛 decoy 烟雾** |
| `Hanmado/hit_hanmado_0409` | hanmadoHit | bomb / torpedo 命中 |
| `Tktk/Light` | muzzleLight | 所有"出手"层 |
| `Tktk/ToonHit` | toonHit | 轻命中 |
| `Tktk/ToonWater` | toonWater | bomb 落水 / mine 爆开 |
| `Basic/Simple_Sprite_BillBoard` | **未使用** | 通用柔光点（可做油膜高光） |
| `Basic/Simple_Sprite_Fixed` | **未使用** | 固定朝向贴片（墨云） |
| `Basic/Simple_Sprite_FixedYAxis` | **未使用** | **ink 墨云**（Y 轴朝向，绕轴不翻转） |
| `Basic/Simple_Model_UV` | **未使用** | 暂时不用（模型 UV 演示，观感一般） |

### 建议的"三层"结构（每个道具最多 3 次 `fx.play`）

```
① 出手层  0.15~0.25s   船头/船尾一次     muzzleLight / spawnRing
② 飞行层  持续          跟随弹体          Laser03 / ribbonTail / pudding（低透明度）
③ 命中层  0.3~0.5s     落点一次          hanmadoHit（重）/ toonHit（轻）/ toonWater（水）
④ 状态层  与 debuff 同长 跟随受害者        只在"持续型"debuff 上挂：Aura01 / Barrior / pudding
```

**关键约束（来自本项目踩过的坑）**

1. **不要叠两层同义特效**：历史上"白球 + 白环"被删过两次（`boss-mode-plan.md`）。命中只保留一层。
2. **同屏活跃特效要控量**：Effekseer 直改 `glViewport/glScissor`，是黑屏 Bug 的根因（`DEV_STATUS.md` 三）。
   `Effects.transient` 上限 48，4 人局同时命中 + 出手容易顶满 → 建议"飞行层"用 3D mesh + `SkillFx` 粒子，
   **effekseer 只用在出手/命中两个瞬间**。
3. **scale 必须按世界尺寸调**：素材是按几十米做的，`FX_DEFS` 里的 0.2~0.5 是赛艇尺度；
   新道具照抄同量级，别直接用 1.0（会糊满屏）。
4. **道具辨识度靠颜色不靠形状**：水=青蓝 `0x4fd0ff`、火=橙红 `0xff6a4d`、暗=黑紫 `0x3a2a4a`、
   风/位移=青绿 `0x40e0d0`。命中粒子统一按这套色相 tint，玩家扫一眼就知道被什么打了。

---

## 六、道具池结构建议（避免越加越乱）

当前 15 个的分布：

```
加速/位移  nitro, magnet                      2
攻击(锁定) bomb, missile, octopus, bubblefly  4   ← 重复
攻击(范围) vortex, waterfall, fish, rvortex    4
干扰(全体) ink, slowboat, tide, slowboat       4   ← 重复
防御      shield, angel                       2
放置/陷阱  无                                 0   ← 缺口
```

目标结构（净 17 个）：

```
加速/位移  3   nitro, magnet(改抓钩), gate(可选)
攻击       4   torpedo(new), vortex, waterfall, rvortex
锁定       3   bomb, missile, octopus        ← bubblefly 合并进来或降权
干扰       3   ink(改锥形), slowboat(改浮标), tide(缩时长)
防御       4   shield, angel, reflect(new), decoy(new)
放置       2   oil(new), mine(new)
```

**权重表要一起改**：`rollItem` 的 `w` 对象新增键后 `sum` 会自动重算，但要注意新道具的
"领先/垫底"斜率——放置类（oil / mine）应该**领先权重高**（守成），反射类（reflect）**垫底权重高**（翻盘）。

---

## 七、施工顺序（每批都能单独跑起来）

| 批次 | 内容 | 文件 | 风险 |
|------|------|------|------|
| A | bomb/missile/vortex 换皮（☆，不改数值） | Items.js + Effects.js | 低 |
| B | ink 改锥形喷墨（★） | Items.js | 中（涉及 HUD 遮罩） |
| C | decoy 道具赛版（★） | Items.js + Boat.js | 中（改目标选择函数） |
| D | oil 油膜（★） | Items.js + Boat.js | 中（新状态） |
| E | reflect 反射护盾（★） | Items.js | 中（命中入口） |
| F | torpedo 鱼雷齐射 + 翻船（★） | Items.js + Boat.js | 中高（新状态，注意和 spin 互斥） |

**每批都要跑的验证**
1. `npm test`（`rollItem` 权重、`ITEM_DEFS` 完整性）
2. `npm run build`
3. 单机 4 人局：每个新道具各用 3 次，确认命中/未命中/被护盾挡三条分支
4. 联机：新道具的 `itemUse` / `itemHit` / `itemFx` 三类消息必须进
   `server/server.js` 的 `RELAY_TYPES` 与 `Game.js` 的 `itemNetTypes`（历史上 BOSS 有 8 类消息漏白名单）

---

## 八、需要你拍板的 5 件事

1. **ink 改锥形喷墨**（不再全体糊屏）—— 同意吗？
2. **下架 `fish`、保留 `rvortex`** —— 还是两个都留？
3. **新增先做哪三个**：我建议 `oil` + `decoy` + `reflect`（一个陷阱、一个反制、一个防御反击，正好补三个缺口）；
   `torpedo` 的翻船状态改动最大，可以放第二批。
4. **`gate` 潜流甬道**要不要？（会改变赛道利用方式，我倾向不做）
5. **BOSS 模式道具池要不要同步**？（默认不同步，新道具只进道具赛）
