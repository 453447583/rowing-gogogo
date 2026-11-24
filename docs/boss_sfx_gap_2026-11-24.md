# 怪物 / 海克斯技能音效缺口清单（2026-11-24）

> 核对口径：直接读 `src/data/bosses.js` 的 `BOSS_SKILLS` / `BOSSES`，与 `src/audio/AudioEngine.js` 的
> `SFX_SAMPLES`、`SFX`、`bossSkillSfx()` 逐条对照；再核对 `src/game/BossMode.js` 的实际 `audio.play()` 调用点。
> **先说结论：技能不是静音，是“复用”。** 40 招里只有第 5 关的 8 招写了 `sfx` 字段，其余 32 招都按 `visual`
> 落到 6 个通用元素音上；另外有几类事件**一次播放调用都没有**（见 C 节）。
>
> **2026-11-24 V2 已交付并接入（21/21）：** 素材在 `public/audio/sfx/`，`SFX_SAMPLES` + `SFX` 合成兜底、
> `BOSS_SKILLS.sfx`、以及 C 节 4 个事件播放全部接好；第 5 关冲锋/横扫/瞬狱斩已拆成独立音，
> `boss_herald_roar` / `boss_herald_sword` 换成专用重做版。仅 `blink`（瞬影突袭）仍走通用 `boss_blood`。

---

## 0. 现状速览

| 当前音效 | 被多少招复用 | 招式（技能 id） |
|---|---:|---|
| `boss_fire` | 17 | flame / lavaTsunami / sweepDeep / dive / diveCombo / flameSweep / magmaChess / wingShockGround / wingShockAir / scaleRain / infernoBeam / twinTsunami / scaleRainX / overheat / hunterBeam / summonGate / phaseBlast |
| `boss_thunder` | 6 | slash / charge / thunder / blinkSlash / slam / gridThunder |
| `boss_blood` | 5 | pull / screen / blink / shadowTendrils / laserSweep |
| `boss_water` | 3 | sweep / geyser / rift |
| `boss_ice` | 1 | frostBreath |
| `boss_magic` | 1 | rage（无 visual，兜底） |
| `boss_herald_sword` | 3 | abyssSweep / abyssBlinkSlash / abyssSword ← **第 5 关内部也重复** |
| `boss_herald_roar` | 2 | abyssCharge / abyssRoar ← **第 5 关内部也重复** |
| 专属不重复 | 4 | boss_herald_slam / boss_herald_spike / boss_herald_gate / boss_herald_death（死亡事件） |

### 已够用、本次不建议重做
`boss_death`、`boss_herald_death`、`boss_stagger`、`weak_crit`、`cores_break`、`transition`、`boss_warn`、
`boss_roar`、`synergy`、`fish_minion`、`boss_bomb`、`boss_control_hit`、`weakspot_javelin`、
全部道具音（`item_*`）与 6 首 BOSS BGM。它们各有明确用途，再生成只会增加辨识混乱。

---

## A. 第 5 关「深渊传令官」——优先补 5 条

8 招都有专属采样，但 5 招挤在 2 个音上：冲锋/咆哮同音，横扫/瞬狱斩/天罚圣剑同音。
玩家听到的是“招式不同、声音一样”，第三关之后尤其明显。

| 建议 key / 文件名 | 现在用到的音 | 建议提示词（可直接给 AI） |
|---|---|---|
| `boss_herald_charge` → `boss_herald_charge.wav` | `boss_herald_roar` | 1.1 秒，深渊圣裁官的重甲冲锋：低频踏步由远及近，末尾一记撕裂空气的金属爪击。压迫、厚重，不要龙吼，不要合唱，不要旋律。尾部 20ms 淡出，首部不留静音。 |
| `boss_herald_roar` 保留并专用 | 与冲锋共用 | 1.6 秒，庄严而堕落的低沉咆哮：胸腔共鸣叠一层微弱的圣咏残响，像审判宣告。只保留这招用，冲锋另做。 |
| `boss_herald_sweep` → `boss_herald_sweep.wav` | `boss_herald_sword` | 1.2 秒，横向大回扫：宽幅刀风从左扫到右，带一点金属摩擦和水面破风，结尾有短促的沉重顿击。不要竖向下劈，与天罚圣剑区分。 |
| `boss_herald_blink` → `boss_herald_blink.wav` | `boss_herald_sword` | 0.9 秒，瞬狱斩：极短的高频空间撕裂“嘶啦”，紧接一记贴脸的窄刃斩击，收尾干净利落。要有瞬移感，不要长混响，不要合唱。 |
| `boss_herald_sword` 保留 | 与横扫/瞬狱斩共用 | 1.4 秒，天罚圣剑专属：由上而下的重型圣剑坠落，前半段是升高的圣光嗡鸣，后半段是巨剑砸落的低频冲击与金属余震。 |

> 已有且不用改：`boss_herald_slam`（双拳砸海）、`boss_herald_spike`（影刺追猎）、
> `boss_herald_gate`（圣光降临）、`boss_herald_death`（专属死亡）。

---

## B. 前四关 + 海克斯借招——按“招式家族”补 12 条

32 招全部复用 6 个通用元素音。逐个补 32 条不现实也不必要，按听感家族分组，每组给一条专属音即可
把辨识度拉开。海克斯的深渊变体借招也走这套。

| # | 建议 key | 覆盖技能 | 建议提示词 |
|---|---|---|---|
| B1 | `boss_fire_breath` | flame / flameSweep / infernoBeam / hunterBeam / overheat | 1.3 秒，龙形持续喷焰：低频喉音垫底，火焰气流占据中高频，起音干脆、尾段自然衰减。是“持续吐息”，不是爆炸。 |
| B2 | `boss_lava_wave` | lavaTsunami / twinTsunami / phaseBlast | 1.5 秒，熔岩巨浪推进：低沉的滚动轰鸣逐渐靠近，末尾一记厚重的水浪拍击，夹少量岩浆气泡声。不要喷火喉音。 |
| B3 | `boss_tail_sweep` | sweepDeep / sweep / wingShockGround / wingShockAir | 1.0 秒，大范围横扫破风：宽频风声从一侧扫到另一侧，带低频压迫，结尾轻顿。不要金属刀鸣。 |
| B4 | `boss_dive` | dive / diveCombo / scaleRain / scaleRainX | 1.1 秒，高空俯冲 + 鳞片暴雨：先一记尖锐下坠风声，后半段是密集小颗粒打击声，有由远及近的空间感。 |
| B5 | `boss_magma_chess` | magmaChess / gridThunder | 1.2 秒，棋盘格能量点亮：规律的三连短促“叮—叮—叮”电子金属点名，带低频压迫底噪，节奏清楚、不吵。 |
| B6 | `boss_sword_slash` | slash / blinkSlash（雷霆） | 1.0 秒，雷霆剑击：高频电弧噼啪 + 一记利落剑鸣，收尾极短。和第 5 关的圣剑要有材质区别（这是电，不是圣光）。 |
| B7 | `boss_thunder_strike` | thunder / slam / charge | 1.3 秒，重锤落地与落雷：先短促电荷积累，再一记极重的低频撞击，尾带碎石余响。 |
| B8 | `boss_pull` | pull / geyser / rift | 1.4 秒，深渊吸取/裂隙喷发：低频向心吸入的呼啸，逐渐升高，末尾一记闷响收束。有“被拖走”的方向感，不带眩晕感。 |
| B9 | `boss_blood_curse` | screen / shadowTendrils / laserSweep | 1.5 秒，血月诅咒：诡异低频脉动 + 湿冷的缠绕摩擦声，中段一记短促的心跳重击。不要尖叫，不要音乐旋律。 |
| B10 | `boss_frost_breath` | frostBreath | 1.2 秒，霜雪吐息：细碎冰晶爆裂与冷气喷射，清脆但压抑，尾段有冰面碎裂感。和火焰吐息形成冷暖对比。 |
| B11 | `boss_gate_open` | summonGate（经典模式） | 1.4 秒，深渊召唤门开启：低沉的石门摩擦 + 一圈旋转的能量涌动，门“完全打开”时一记沉闷的吞吐声。不要龙卷/漩涡呼啸（会和追踪漩涡混淆）。 |
| B12 | `boss_rage` | rage / phaseBlast 的狂怒段 | 1.2 秒， BOSS 狂怒咆哮：低频吼叫叠急促鼓点式冲击，从压抑推到爆发，短促不拖尾。 |

---

## C. 完全缺播放调用的事件音——补 4 条

这几处代码里只有特效，没有 `audio.play()`，属于真正的“没声音”。

| 事件 | 代码位置 | 现状 | 建议 key + 提示词 |
|---|---|---|---|
| 召唤门放出小怪 | `#updateGateQueue` → `#spawnMinions` | 只有 `fxMagicCircle` / `tornado` 视觉 | `boss_minion_spawn`：0.6 秒，湿冷的小怪钻出声，短促的“噗”加爪子刮擦，不要龙卷风声。 |
| 追踪漩涡出现预警 | `#startVortexWarn` | 只有红圈和 `fxBigVortex` | `boss_vortex_warn`：0.9 秒，危险的低频旋转嗡鸣由弱到强，末尾一记短促警示音。要和普通道具漩涡音明显不同。 |
| 漩涡咬到玩家 | `#updateVortexChase` 命中分支 | 只写减速与粒子 | `boss_vortex_hit`：0.7 秒，被水流猛地卷住的闷响 + 短促失真，收尾干净。 |
| 海克斯层结算 / 选卡弹出 | `onStageResult` / `#offerHexCards` | 只有面板动效 | `hex_card_offer`：0.8 秒，清脆的水晶翻转 + 轻微上扬的魔法提示音，明亮但克制，不抢 BGM。 |

---

## D. 交付规格（和现有素材保持一致）

- **音效**：WAV / 48kHz / **单声道** / 16bit PCM / 峰值 **-3.0 dBFS** / 首部无静音 / 尾部 **20ms 淡出**。
- **BGM**（本次不需要）：48kHz 立体声 / -6.0 dBFS，比音效低 3dB。
- 每条音频**只表达一个动作**，不要加背景音乐、不要加人声台词、不要加可辨识旋律。
- 文件放进 `public/audio/sfx/`，文件名 = 建议 key；接入时在 `AudioEngine.js` 的
  `SFX_SAMPLES` 加一行，并在 `SFX` 表补一条**合成兜底**（否则采样没加载完会静音）。
- 招式级音效在 `src/data/bosses.js` 给技能加 `sfx: '新key'`；事件级音效在 `BossMode.js` 对应位置加
  `audio.play('新key', { gap: 120 })`。第 5 关技能已有 `sfx` 字段，替换值即可。

### 建议生成顺序
1. **A 组 5 条**（第 5 关内部重复，玩家最容易听出来）
2. **C 组 4 条**（真正没声音的事件）
3. **B11 / B12**（召唤门、狂怒，海克斯高频出现）
4. B 组其余按 B1→B5→B6→B9→B8→B7→B3→B4→B10→B2 的顺序补
