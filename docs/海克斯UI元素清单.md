# 海克斯无尽模式 · UI 元素与图标槽位清单

> 用途：以后统一替换 UI 皮肤 / 图标时，按本表逐项替换，不用再翻代码找位置。
> 原则：**所有海克斯元素的数据都来自 `src/data/hexRun.js`**，显示层只读 `icon` 字段或 CSS class；
> 换图只需要改「图标槽」，不改玩法数值。

---

## 1. 替换入口（先看这里）

| 想改什么 | 改哪里 | 说明 |
| --- | --- | --- |
| 海克斯核心 / 词缀 / 危险物 / 事件 / 卡牌 / 前缀 / 变体 / 场地 / 遗物的图标与名称 | `src/data/hexRun.js` 对应池的 `icon` / `name` / `desc` | `icon` 当前是 emoji，可直接换成图片路径或接入图标表 |
| 天气图标（HUD / 大厅 / 过场） | `src/ui/icons.js` → `WEATHER_ICON` + `ICONS` | 已有 PNG 图标体系，改 key 指向的图即可 |
| BOSS 头像 / 图标 | `src/ui/icons.js` → `BOSS_ICON` + `ICONS` | 按 `bossId` 映射，深渊变体沿用原 BOSS 图标；第五头 `abyss_herald` 暂用 emoji 回退，补图见 8.12 |
| 通用道具 / 技能 / 状态图标 | `src/ui/icons.js` → `ITEM_ART` / `SKILL_SRC` / `STATUS_ICON` / `TOAST_ICON` | 海克斯提示里的开头 emoji 也会走 `TOAST_ICON` |
| 布局 / 配色 / 尺寸 | `index.html` 内联 `<style>` 中 `hex-strip`、`hex-cards`、`hex-build-panel`、`hex-endless`、`boss-end .be-hex` 段落 | 每块都有独立 class 前缀，互不影响 |
| 三选一卡片稀有度外观 | `index.html` → `.hex-card.white` / `.hex-card.blue` / `.hex-card.gold` | 卡牌数据里的 `rarity` 直接当 class 用 |
| 深渊变体 / 场地 / 遗物 / 时间锚的状态显示 | 见第 2、4、6 节 | 数据字段已经下发到 UI，无需改协议 |

建议接入方式：在 `src/ui/icons.js` 里新增一张 `HEX_ICON`（key = 池内 id），渲染时优先取
`HEX_ICON[id]` 的图片，取不到再回退 `icon` 的 emoji。这样不用改 `hexRun.js` 的玩法数据。

---

## 2. 战斗 HUD · 海克斯状态条

DOM：`index.html` → `#hex-strip`（常驻左上）

| 元素 | id / class | 数据字段 | 图标槽 |
| --- | --- | --- | --- |
| 本局核心 | `#hex-strip-core` / `.hs-core` | `hexBuildInfo.core`（`HEX_CORES`） | `core.icon` |
| 词缀 / 变体 / 场地 / 遗物 / 时间锚 | `#hex-strip-rules` / `.hs-rules` | `hex.rules`、`hex.variant`、`hex.arena`、`hex.relics`、`hex.anchors` | 各对象 `icon`；时间锚为 `⚓` + 次数 |
| 打开构筑面板 | `#hex-strip-build` / `.hs-build` | —— | 文本按钮 |
| 已选卡数量 | `#hex-strip-count` | `hex.cards.length` | —— |

状态条 chip 的语义配色（可直接换底色/边框，不要删 class）：

| class | 含义 | 当前外观 |
| --- | --- | --- |
| `.hs-rule` | 普通关卡词缀 | 半透明深蓝 |
| `.hs-rule.neg` | 负面词缀 | 红色底 |
| `.hs-rule.hs-prefix` | 精英前缀（BOSS 头衔） | 暗红底 + 粗体 |
| `.hs-rule.hs-variant` | 深渊变体 | 暗紫底 + 粗体 |
| `.hs-rule.hs-arena` | 场地修饰（每 5 层） | 青色底 |
| `.hs-rule.hs-relic` | 已获得深渊遗物数量 | 暗金底 |
| `.hs-rule.hs-anchor` | 剩余时间锚次数 | 冷蓝底 |

> 天气 buff **不在** 状态条里，见下一节。

### 2.1 天气 buff 小图标（玩家要求常驻 + hover 说明）

DOM：`index.html` → `#minimap-weather` 内的 `.mm-buff`

- 图标：`WEATHER_ICON[weatherId]`（PNG，`icons.js`）；旁边的玩法 buff 用 `hexBuildInfo.weather.icon`（emoji 槽）
- 文案：`data-tip="..."`，内容 = `hexBuildInfo.weather.desc`
- 数据来源：`BossMode.hexWeatherFx`（含 `aimSpreadDeg`、`telegraphScale` 等倍率）
- 换图：只改 `icons.js` 的 `WEATHER_ICON`，或把 `HEX_WEATHER_EFFECTS[x].icon` 换成图片

---

## 3. 开局 / 进层过场卡

DOM：`#boss-cutscene` → `#cs-hex` → 多行 `.cs-hex-row`

| 行 | 数据 | 图标槽 |
| --- | --- | --- |
| 核心 | `hex.coreId` → `HEX_CORES` | `core.icon` |
| 主规则 / 副规则 | `hex.entry.rules` → `HEX_RULES` | `rule.icon` |
| 精英 | `hex.prefix` | `prefix.icon` |
| 变体 | `hex.variant`（P4） | `variant.icon` |
| 场地 | `hex.arena`（P4） | `arena.icon` |
| 遗物 | `hex.relics`（P4） | 每件 `relic.icon` |
| 时间锚 | `hex.anchors`（P4） | `⚓` |
| 危险物 | `hex.entry.hazards` → `HEX_HAZARDS` | `hazard.icon` |
| 连招 | `hex.entry.combos[].label` | 文本 |
| 赛艇 | `hex.boats` → `BOATS` | 文本 |
| 危险评级 | `hex.entry.danger` | `★` × N |
| seed | `hex.seed` | 十六进制文本 |

换皮重点：`.cs-hex-k` 是左侧标签列，宽度固定；右侧图标建议 20×20，保持单行不换行。

---

## 4. 三选一卡片 UI（核心 / 通关卡）

DOM：`#hex-cards`（全屏浮层）→ `.hex-cards-panel`

| 元素 | class | 数据 |
| --- | --- | --- |
| 标题 | `.hex-cards-head` | 核心三选一 / 第 N 层通关 |
| 卡片按钮 | `.hex-card` + `.white` / `.blue` / `.gold` | `HEX_CARDS.rarity` |
| 图标 | `.hex-card-icon` | `card.icon`（建议 64×64 透明底） |
| 名称 | `.hex-card-name` | `card.name` |
| 描述 | `.hex-card-desc` | `card.desc` |
| 倒计时/状态 | `.hex-cards-foot` | 自动选择 / 等待房主 |

同名卡最多叠 3 张，UI 会合并显示 `×N`；替换时保留 `.hex-card` 上的 `data-id` 与 `disabled` 逻辑。

---

## 5. 构筑面板（点 HUD「构筑」）

DOM：`#hex-build-panel` → `#hex-build-body`

行结构：`.hb-k`（左侧标签） + `.hb-hz`（数值/名称） + 说明文本。
P4 新增行：**深渊变体 / 场地 / 深渊遗物（带 hover `data-tip`）/ 时间锚**。
数据来自 `BossMode.hexBuildInfo`，字段：`variant`、`arena`、`relics[]`、`anchors`。

---

## 6. 无尽面板 + 深渊罗盘（每 4 层后 / 每层后弹出）

DOM：`#hex-endless`

| 元素 | id / class | 数据 |
| --- | --- | --- |
| 已通过层数 | `#he-stage` | `stage` |
| 续层说明 | `#he-sub` | 难度递增说明 / 等待房主 |
| 历史最佳 | `#he-best` | `localStorage['rr-hex-best']` |
| **下一层预览（罗盘）** | `#he-preview` / `.he-preview` | `preview`（见下） |
| 继续按钮 | `#he-go` | `nextStage` |
| 结束领奖 | `#he-stop` | —— |

罗盘预览子元素：

| 元素 | class | 内容 |
| --- | --- | --- |
| 标题 | `.he-pv-title` | 「🧭 深渊罗盘 · 下一层预览」 |
| BOSS 名 | `.he-pv-boss` | `preview.bossName` + 图标 |
| 变体标签 | `.he-pv-tag` | 有 `preview.variant` 时显示「深渊变体」 |
| chip 组 | `.he-pv-chips` / `.he-pv-chip` | 场地 / 天气 / 前缀 / 词缀 / 遗物 |
| chip 语义 | `.neg` 负面、`.arena` 场地、`.relic` 遗物 | 只换配色即可 |

`preview` 由 `BossMode.#nextStagePreview()` 生成，字段：
`stage / bossName / bossIcon / variant / rules[] / weather / prefix / arena / relic`。
新增图标时直接读对应对象的 `icon`，不要改协议。

---

## 7. 结算界面

DOM：`#boss-end` → `.be-body` → `.be-hex`

| 行 | 数据 | 图标槽 |
| --- | --- | --- |
| 本局核心 | `hex.core` | `core.icon` |
| 拿到卡牌 | `hex.cards`（同名合并 ×N） | `card.icon` |
| **深渊遗物** | `hex.relics[]`（P4） | `relic.icon` |
| 每层回顾 | `hex.stages[]` | 见下 |
| seed | `hex.seed` | —— |

每层回顾（`.be-hex` 行内）：
`第 N 层 <BOSS 名>` + `.hx-arena`（场地）+ `.hx-relic`（遗物）+ `.neg`（前缀/负面词缀）+ 规则 + 危险物。
P4 字段：`stages[i].variant / arena / relic`。

---

## 8. 图标槽全量清单

### 8.1 天气（5）— `HEX_WEATHER_EFFECTS`
`day ☀️` / `dusk 🌇` / `storm ⛈️` / `blizzard ❄` / `starry 🌌`
> HUD 小图标走 `WEATHER_ICON`，建议 24×24；玩法 buff 可单独做角标。

### 8.2 本局核心（6）— `HEX_CORES`
`pow 🔥` / `steel 🛡` / `rich 💰` / `glass 💎` / `bless 🌊` / `crit 🎯`

### 8.3 关卡词缀（13）— `HEX_RULES`
`rage ⚡` / `regen 💚` / `armor 🪖` / `venom ☠` / `greed 🪙` / `gale 🌬` /
`bloodrage 🩸` / `ironwall 🧱` / `fortune 🍀` / `trial 🔥` / `frenzy 💢` / `bounty 🪙` / `colossus 🗿`

### 8.4 危险物（10）— `HEX_HAZARDS`
`lava 🌋` / `thunder ⚡` / `vortex 🌀` / `heal 💚` / `boxes 📦` /
`rockfall 🪨` / `poison ☠` / `spike 🔺` / `meteor ☄` / `bloodmoon 🌕`

### 8.5 局内事件（6）— `HEX_EVENTS`
`airdrop 🪂` / `berserk 💢` / `storm 🌩` / `terrain 🌋` / `meteorshower ☄` / `armory 🧰`

### 8.6 卡牌（24）— `HEX_CARDS`
稀有度三档：白（10）/ 蓝（9）/ 金（5）。图标建议统一 1:1、透明底、外发光区分稀有度。
具体 id 与 icon 见 `hexRun.js` 的 `HEX_CARDS`。

### 8.7 精英前缀（4）— `HEX_PREFIXES`
`berserk 🩸` / `frost ❄` / `greedy 🪙` / `decay 💀`

### 8.8 深渊变体（4）— `HEX_VARIANTS`（P4）
| BOSS | 变体 | icon | 借来技能 |
| --- | --- | --- | --- |
| dragon_deep | 深渊·噬海龙 | 🐉 | gridThunder 雷霆棋盘 |
| dragon_inferno | 深渊·焚寂龙 | 🔥 | frostBreath 霜雪吐息 |
| knight_thunder | 深渊·断誓骑士 | ⚔ | shadowTendrils 暗影缠触 |
| blood_nightmare | 深渊·渊眠之母 | 🩸 | rift 裂隙 |

> 变体沿用原 BOSS 的 GLB / 骨骼 / 动作，只换名字、数值与 1 个借来的技能；
> 图标可按同一套 BOSS 图做「暗色 + 紫边」差分。

### 8.9 场地修饰（5）— `HEX_ARENAS`（P4）
`maelstrom 🌀` / `glacier 🧊` / `reef 🪨` / `thundercloud ⛈` / `bloodmoon 🌕`

### 8.10 深渊遗物（6）— `HEX_RELICS`（P4）
`obsidian ⚓` / `star 🧭` / `lantern 🏮` / `horn 📯` / `tear 💧` / `hourglass ⏳`

### 8.11 时间锚（P4）
`⚓`，来源 `BossMode.timeAnchors`；每 10 层 +1，消耗时播 `fxBenediction`。

### 8.12 BOSS 图标（5）— `icons.js` → `BOSS_ICON`
`dragon_deep bossAbyss` / `dragon_inferno bossInferno` / `knight_thunder bossThunder` / `blood_nightmare bossBlood`
/ `abyss_herald`（暂未接 PNG，UI 自动回退 `abyss_herald.icon` 的 😈；补图时在 `BOSS_ICON` 加一行 `abyss_herald: 'bossHerald'`，并在 `ICONS` 指向新图）

### 8.13 第五头 BOSS「深渊传令官」技能槽 — `BOSS_SKILLS`（`bosses.js`）
| 技能 | 类型 | 骨骼姿态 `pose` | Effekseer | 图标建议 |
| --- | --- | --- | --- | --- |
| 裂爪冲锋 | path 冲锋 | lunge | `fxPartsHit1` | 双爪前冲剪影 |
| 回身横扫 | cone 130° | sweep | `fxSwordMoonlight` | 月牙横扫 |
| 双拳砸海 | slam | slam | `fxHolySandstorm` + `fxMagicThunder` | 双拳砸地 |
| 深渊咆哮 | ring | roar | `fxHerald` + `fxHoly1` | 张口音波 |
| 影刺追猎 | zone | cast | `fxDark2` + `fxBolt1` | 地面紫刺 |
| 天罚圣剑 | rain（半血） | swordCast | `fxSwordSacred` + `fxMagicThunder` | 巨剑垂落 |
| 圣光降临 | gate（半血） | summon | `fxHerald` + `fxGateOfCalve` | 光环 + 传送门 |

> 这只 BOSS 的 GLB 没有动画 clip，`pose` 由 `Boss.#applyProceduralPose` 驱动骨骼完成；
> 换 BOSS 皮肤时只要保留同名骨骼（Chest / Shoulder / Elbow / Head / Jaw / Knee）即可复用整套动作。
> 技能图标目前统一走战斗提示的 `SKILL_SRC_ICON`（🩸），以后做技能图鉴时按上表逐项替换。

---

## 9. 尺寸 / 布局约定

- 顶部状态条 chip：高度 20~22px，字号 11~12px，最多 8 个，超出自动换行。
- 天气 buff：24×24，放在小地图右上角，`data-tip` 必填。
- 三选一卡：建议 200×260（含图 64、名 16、描述 12）。
- 罗盘 chip：高度 18~20px，字号 10.5px，最多 8 个一行内自动换行。
- 结算每层回顾：单行 12px，BOSS 名 + 变体红字 + 场地青字 + 遗物金字。

---

## 10. 验收自检

1. `npm run build` 通过。
2. `npm test` 通过。
3. 进海克斯模式：状态条能同时出现 `核心 / 词缀 / 变体 / 场地 / 遗物 / 时间锚`。
4. 第 5 层起无尽面板出现 `#he-preview`，内容与下一层实际 BOSS/词缀/天气一致。
5. 第 10 层进入时提示「获得时间锚」，阵亡时原地复活并扣 1 次。
6. 结算界面出现「深渊遗物」行与每层变体/场地/遗物标签。
