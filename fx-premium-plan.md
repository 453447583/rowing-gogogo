# 精选 10 个特效 · 接入方案

> 这 10 个现在还是 `.efkproj`（编辑器工程），web 运行时只认 `.efkefc`，**必须先导出一次**。
> 导出流程在最后，先看每个接到哪里。

---

## 一、怎么用（按性价比排）

### 第一梯队：直接换掉现有最弱的一环

| 特效 | 接到哪 | 怎么接 | 为什么值 |
|---|---|---|---|
| **LightningStrike** | 第 3 关 `thunder` 的 `skyFx` | 现在 `skyFx` 用的是 `fxArcBolt`（ef_lightning02，一道 5m 的束）。换成它，就是完整的"云层蓄电 → 主闪 → 地面炸开" | 落雷是第 3 关辨识度最高的技能，现在偏单薄 |
| **MonsterRoar** | BOSS 出场演出 + 转阶段 | 出场：`BossMode` 的 `onCutscene` 之后播一次；转阶段：`#beginPhaseBlast` 里替换现在硬编码的 `tornado` | 目前 BOSS 出场只有镜头推近，没有"吼"的声势 |
| **BloodLance** | 第 4 关 `pull`（深渊吸取）的命中点 | `#beginPull` 里往玩家方向抛一束血枪，配合现有的拖拽力 | 现在"吸取"只有脚下漩涡，缺一道"往嘴里拽"的实体 |

### 第二梯队：补氛围和场面

| 特效 | 接到哪 | 怎么接 |
|---|---|---|
| **snowstorm** | 第 3 关全局天气 | 进关卡时 `playAttached('stormFx', ..., loop: true)` 播一次、跟着场地中心走，全程低强度循环 |
| **magma** | 第 1/2 关场地熔岩 | `BossThemes` 的火山岩块处，每块播一次（不用跟随） |
| **PhantasmMeteor** | 第 4 关 `screen`（血幕降临）落地 | `#resolveScreenSkill` 的结算点，比现在只有震屏 + 爆点有气势得多 |

### 第三梯队：锦上添花

| 特效 | 接到哪 | 怎么接 |
|---|---|---|
| **CosmicMist** | 第 4 关 `frostBreath` 的环境层 | 吐息时在 BOSS 前半圆铺一层雾，跟着技能时长 |
| **Undine13** | `geyser` 泉涌的**命中点** | 你说过原来的向上水柱要保留——那就只加在"浪打中船"的落点上，不动 BOSS 脚下那根柱 |
| **Water_Impact** | 玩家水炮命中 BOSS | 叠在 `hanmadoHit` 上，作为水面特效层（水属性的船才播） |
| **Atmosphere** | 关卡整体 | 低透明度常驻（0.25~0.35），只给第 2 关黄昏 / 第 4 关暴风雨 |

---

## 二、接入时的三个硬约束

1. **每关活跃特效别超 3 个**（不含道具）。Effekseer 直改 `glViewport`，同屏太多会顶到 `transient` 上限 48，历史上出过黑屏。
2. **常驻类必须 `playAttached` + `loop: true`**，别用 `play()` 每帧调，否则每帧新建 handle。
3. **新素材尺寸未知，scale 一律从 0.6 起试**，用 `tests/shot_one.mjs` 单独量一遍再定（它就是为这个写的）。

---

## 三、导出步骤（每个约 20 秒）

1. 打开 `D:\Effekseer1.7.3.0\Tool\Effekseer.exe`
2. `文件 → 打开`，选 `fx-projects\<组>\<名字>\<名字>.efkproj`
3. `文件 → 导出 → 导出为 efkefc`（Ctrl+E）
4. **输出目录选一个新的空文件夹**，比如 `D:\3Dgame - 副本\public\effects\Premium\LightningStrike\`
5. 导出后**把同目录下的哈希文件（那些没有扩展名的长串）一起拷进去** —— efkefc 是按哈希名找纹理的，
   漏了就会在白底上画一堆方块

> 拷完之后目录长这样，就能被游戏加载：
> ```
> public/effects/Premium/LightningStrike/
>   LightningStrike.efkefc
>   3A397EAB67678E3760A2A7B499C9BE57-00006B42     ← 纹理
>   ...
> ```

导完告诉我名字，我按上表接进 `FX_DEFS` 并跑一遍截图校准 scale。

---

## 四、如果嫌导出麻烦

我可以只挑**最值的 3 个**（LightningStrike / MonsterRoar / BloodLance），你导这 3 个就够覆盖 80% 的提升，
其余等这些用顺手了再说。
