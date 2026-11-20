# 图标全清单 + 去 AI 化的生成关键词

> 这份是给你拿去生成新图标用的。不用懂技术，照着"怎么用"三步走就行。
> 清单里的"现在"是游戏里现在显示的符号，"生成关键词"是你要发给 AI 的那句话。

---

## 怎么用（三步）

**第 1 步**：复制下面这段【通用前缀】

**第 2 步**：在清单里找到你要的那个图标，复制它那行的【生成关键词】

**第 3 步**：拼起来，再加上【通用负面词】，发给 AI

### 拼好的例子（直接照抄改）

```
flat vector game icon, 2D, limited 4-color palette, thick dark outline,
hard geometric edges, screen-print texture, subtle halftone grain,
dark navy background, readable at 32px, single light source,
abyssal cyberpunk, bioluminescent naval tech, hazard orange and cyan,
circuit etching, industrial stencil decal --
a depth charge canister with a sonar target lock, three hard-edged fins
--
no lens flare, no chrome, no glossy 3D render, no gradient mesh,
no soft airbrush, no sparkles, no hologram glow spam, no text, no watermark
```

---

## 【通用前缀】每次都要复制这一段

```
flat vector game icon, 2D, limited 4-color palette, thick dark outline,
hard geometric edges, screen-print texture, subtle halftone grain,
dark navy background (#08131f), readable at 32px, single light source,
abyssal cyberpunk, bioluminescent naval tech, hazard orange and cyan,
circuit etching, industrial stencil decal, retro-futuristic sonar UI --
```

## 【通用负面词】每次都要复制这一段（这段是"去 AI 味"的关键）

```
-- no lens flare, no chrome, no glossy 3D render, no gradient mesh,
no soft airbrush, no sparkles, no hologram glow spam, no photorealism,
no overly symmetric bevel, no random floating particles, no text, no watermark
```

---

## 为什么要这么写（一句话解释）

AI 画的图标一眼假，通常是因为：光晕糊满、金属反光、渐变过度、细节多得看不清。
所以这里反过来要求：**颜色少（4 色）、边硬、有印刷颗粒感、像工业模板喷漆**。
这样出来的图在小尺寸下也看得清，而且是一套统一的风格，不像拼凑的。

**配色统一用这五个**（在提示词里点名 color palette）：
深底 `#08131f` · 青 `#35e6e0` · 橙 `#ff6a3d` · 品红 `#ff3d78` · 黄 `#ffd24a`

> 小技巧：不要一次生成一个。先挑 4 个生成，确认风格对味了，再多生成几批。
> 也可以一次要求"4×4 图标表，同一风格"，比逐个生成更统一。

---

# 一、道具图标（道具赛 / 竞速赛共用）

这些是玩家在 HUD 右下角三个格子里看到的图标。

| 道具名 | 现在 | 生成关键词（接在通用前缀后面） |
|---|---|---|
| 氮气瓶 | ⚡ | `a pressurized nitro canister with a lightning bolt stamped on it, orange warning stripes` |
| 深水炸弹 | 💣 | `a rounded depth charge drum with a steel fuse and sonar rings, matte black body` |
| 章鱼 | 🐙 | `a mechanical octopus with cable tentacles and one glowing cyan eye, angular silhouette` |
| 护盾 | 🛡️ | `a heavy naval shield with a circuit-board grid and riveted steel rim` |
| 追踪导弹 | 🚀 | `a sleek torpedo missile with four hard fins and a lock-on crosshair, nose pointed up` |
| 漩涡 | 🫧 | `a spiral water vortex seen from above, concentric hard-edged rings, not soft bubbles` |
| 磁力吸盘 | 🧲 | `a U-shaped electromagnet with exposed copper coils and a red polarity marker` |
| 墨鱼喷墨 | 🌑 | `an ink-squid silhouette with a spreading black fan of ink, single cyan eye slit` |
| 深海瀑布 | 🌊 | `a vertical water column crashing down with a hard spray crown, cyan and white` |
| 天使庇佑 | 😇 | `a winged halo emblem made of angular metal plates, not a cute cartoon face` |
| 飞鱼群 | 🐟 | `three dart-shaped flying fish in formation, sharp fins, cyan trail lines` |
| 海洋之怒 | 🌊 | `a trapped spiral current with a red warning core, tighter than a plain wave` |
| 减速艇 | 🐢 | `a small armored turtle-boat with a heavy shell made of bolted plates` |
| 方向转换器 | 😈 | `a reversed steering wheel with crossed arrows, red hazard triangle behind it` |
| 泡泡蜻蜓 | 🫧 | `a drone dragonfly inside a hexagonal containment bubble, mechanical wings` |
| 鱼雷齐射 | 🐠 | `three parallel torpedoes in a firing salvo, hard triangular noses` |
| 血枪狙击 | 🔱 | `a trident-shaped railgun with a long barrel and blood-red sight line` |
| 圣光沙暴 | 🌪️ | `a sandstorm funnel with a hard spiral edge, amber grains, not fluffy clouds` |
| 逆流之门 | 🚪 | `a rectangular portal frame with a reverse-current arrow, purple circuit border` |
| 剑刃风暴 | ⚔️ | `two crossed industrial blades with a circular slash arc, steel gray` |
| 圣域 | ✨ | `a hexagonal sanctuary field with a pulse ring, geometric not sparkly` |
| 护盾墙 | 🧱 | `a segmented barrier wall made of energy blocks, cyan edges, bolted joints` |

---

# 二、怪物模式专属道具（打 BOSS 时掉的）

下面 9 个和上面共用同一张图：`nitro / bomb / shield / missile / vortex / ink / angel / fish / tide`。
另外 5 个是独有的：

| 道具名 | 现在 | 生成关键词 |
|---|---|---|
| 破甲标枪 | 🎯 | `a armor-piercing harpoon with a targeting reticle, orange impact marker` |
| 深海鱼叉 | ⚔️ | `a heavy harpoon with barbed tip and chain, industrial steel` |
| 三连深水弹 | 💥 | `three depth charges in a row with one detonating, hard shockwave ring` |
| 引雷针 | 🌩️ | `a lightning rod on a boat mast with a sharp zigzag bolt, cyan-white` |
| 冲角护符 | 🐗 | `a boar-tusk ram emblem mounted on a metal crest, red war paint stripe` |

---

# 三、每艘船的主炮（竞技场 / 怪物模式）

| 船 | 武器名 | 现在 | 生成关键词 |
|---|---|---|---|
| 赤焰号 | 双管速射炮 | 💥 | `twin parallel autocannon barrels with a muzzle burst, orange spent casings` |
| 绯鲨号 | 双联鱼雷 | 🚀 | `two torpedo tubes with homing fins, cyan guidance lights` |
| 青锋号 | 蓄力激光 | ⚡ | `a focus lens charging a straight energy beam, red core, hard edges` |
| 磐石号 | 三连重炮 | 💣 | `three heavy cannon barrels in a row, wide splash at muzzle, brass and steel` |
| 流光号 | 回旋水刃 | 🌀 | `two curved water blades spinning in a circle, sharp crescent shapes` |
| 琥珀号 | 单管速射炮 | 🎯 | `a single precision cannon barrel with a crosshair, tight bore` |
| 长鲸号 | 回旋磁刃 | ⚔️ | `a boomerang-shaped magnetic blade with circuit grooves, orange edge` |
| 牛来号 | 双角连射炮 | 🐮 | `two curved horns used as cannon barrels, rapid-fire sparks, no cute face` |

---

# 四、游戏模式图标（大厅模式卡 / 下拉框）

| 模式 | 现在 | 生成关键词 |
|---|---|---|
| 竞速 | 🏁 | `a checkered flag made of hard square tiles on a steel pole, no waving fabric` |
| 道具 | 🎁 | `a steel supply crate with a stencil question mark and hazard tape` |
| 弹射 | 🚀 | `a launch ramp with a boat silhouette at the tip, motion arrows` |
| 怪物 | 🐉 | `a mechanical sea dragon head with plate armor and a glowing eye, not a cartoon dragon` |
| 竞技场 | ⚔️ | `two crossed naval sabers over a circular arena ring, industrial steel` |

---

# 五、天气图标（选天气下拉框）

| 天气 | 现在 | 生成关键词 |
|---|---|---|
| 晴朗白天 | ☀️ | `a hard-edged sun disk with radial sonar lines, amber, no soft glow` |
| 黄昏海面 | 🌇 | `a low sun cut by a horizon grid, orange to magenta hard bands` |
| 暴风雨 | ⛈️ | `a storm cloud with three sharp lightning bolts and rain slashes, no fluff` |
| 暴风雪 | ❄ | `a six-armed crystalline snowflake with circuit branches, cyan-white` |
| 璀璨星空 | 🌌 | `a deep-space star map with a diagonal galaxy band and a thin lunar arc, mostly dark` |

---

# 六、地图图标（选图界面）

| 地图 | 现在 | 生成关键词 |
|---|---|---|
| 峡谷激流 | 🏔️ | `angular canyon walls with a river cutting through, hard faceted shapes` |
| 湖泊环线 | 🏝️ | `a small island with a circular racing ring and a docked boat, flat top-down` |
| 峡谷险道 | 🌊 | `a large breaking wave with a kayak silhouette, hard white foam edges` |
| 深海龙宫 | 🐲 | `an underwater palace gate with dragon-scalepattern and cyan light slots` |
| 冰汐海峡 | 🧊 | `a narrow strait of cracked ice floes with a channel between them` |
| 霓虹海峡 | 🌉 | `a bridge over dark water with cyan and magenta light strips, no blur` |
| 秘境漂流 | 🏔 | `a misty mountain river with a stone arch, layered hard silhouettes` |
| 熔岩夜航 | 🌋 | `a volcano cone with orange lava seams against a dark sky, hard cracks` |

---

# 七、BOSS 与难度

| 名称 | 现在 | 生成关键词 |
|---|---|---|
| 深渊火龙 | 🐲 | `a deep-sea fire dragon head, armored plates, ember-orange eye, jaws open` |
| 炎狱火龙 | 🐉 | `an inferno dragon with molten seams between armor plates, hotter palette` |
| 雷霆龙骑士 | ⚔️ | `a dragon knight helm with a lightning bolt visor and steel crest` |
| 暗夜血魔·终焉 | 👹 | `a horned nightmare demon mask with cracked crimson armor, single cyan eye` |
| 普通难度 | ⚔️ | `a clean steel sword icon with minimal decoration, white grade pip` |
| 精英难度 | 🔥 | `the same steel sword wrapped in orange heat lines, two grade pips` |
| 噩梦难度 | 💀 | `a stylized metal skull with a cyan cracked eye socket, three grade pips` |

---

# 八、小怪图标

| 小怪 | 现在 | 生成关键词 |
|---|---|---|
| 岩窟兽 | 🐾 | `a heavy clawed paw print carved into stone, three thick claws` |
| 血魔（杂兵） | 👹 | `a smaller horned mask with crimson markings, simpler than the boss` |
| 巨鲸鲨 | 🦈 | `a shark fin cutting water with a sonar ripple, hard triangular silhouette` |
| 冰霜企鹅 | 🐧 | `a penguin silhouette with angular ice armor plates, cyan eye` |
| 海底甲壳蟹 | 🦀 | `a crab with segmented armored shell and two pincers, industrial joints` |
| 深海电水母 | 🪼 | `a jellyfish bell made of a circuit pattern with four dangling electrodes` |

---

# 九、BOSS 身上的状态图标（血条上方那一排小标签）

| 状态 | 现在 | 生成关键词 |
|---|---|---|
| 虚弱 | 💫 | `a cracked armor plate with a downward arrow, amber` |
| 沉默 | 🔇 | `a speaker with a hard diagonal cut line, red` |
| 失控 | 😵 | `a reversed steering icon with swirl marks, magenta, no face` |
| 致盲 | 🌑 | `an eye shape blocked by a solid black bar` |
| 混乱 | 🌀 | `two crossing spiral arrows in a square, cyan` |
| 减速 | 🐢 | `a heavy weight hanging from a speed dial, orange` |
| 沉水 | 🌊 | `a downward arrow pushing through a water line, deep blue` |

---

# 十、其它界面小图标

| 用途 | 现在 | 生成关键词 |
|---|---|---|
| 冠军 | 🏆 | `a hard-edged trophy cup with a sonar-wave base, no shine` |
| 第一 / 二 / 三名 | 🥇🥈🥉 | `three matching hexagonal medals with 1 2 3 stenciled, gold silver bronze` |
| 阵亡 / 出局 | 💀 | `a metal skull with a crack across the brow, red eye slit` |
| 完成 / 确认 | ✅ | `a heavy check mark stamped like a stencil, cyan` |
| 联机信号 | 📶 | `three sonar signal arcs above a small antenna, cyan` |
| 随机 | 🎲 | `a six-sided die with circuit dots instead of pips` |
| 设置 | ⚙️ | `a industrial gear with a cut-out center, steel gray` |
| 改名 | ✎ | `a stylus drawing a hard angular line, orange` |
| 警告 | ⚠ | `a triangular hazard sign with an exclamation bar, amber` |
| 帮助 | ❔ | `a hexagon with a question mark made of circuit traces` |
| BOSS 主题 · 火山 | 🌋 | `volcano cone with orange lava cracks, flat icon` |
| BOSS 主题 · 海岛 | 🏝 | `a small island with a ruin arch, flat icon` |
| BOSS 主题 · 工厂 | 🏭 | `a rusted industrial plant with two chimneys, flat icon` |
| BOSS 主题 · 星海 | 🌌 | `a star field with a purple nebula band, flat icon` |

---

## 最后两个建议

1. **先做 4 个试试**：挑"氮气瓶 / 护盾 / 破甲标枪 / 霓虹海峡"这四个，风格对了再批量做。它们分别代表能量、防御、攻击、场景四种类型。
2. **生成完让 AI 出透明背景的 PNG**，尺寸给 256×256，然后统一压到游戏里显示的大小。不要让它直接出带背景的方图，不然贴到 HUD 上会有一块底色。
