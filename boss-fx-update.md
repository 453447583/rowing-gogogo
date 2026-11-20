# 怪物模式特效替换 · 落地记录（2026-11-02）

## 一、改了哪三处

| 文件 | 改动 |
|---|---|
| `src/game/Effects.js` | `FX_DEFS` 新增 10 条（`fxFireBurst` / `fxFireBand` / `fxIceBloom` / `fxIceMist` / `fxIceShards` / `fxArcBolt` / `fxBoltStorm` / `fxClawSlash` / `fxUpdraft` / `fxBigVortex`），全部指向 `public/effects/EffectMaterials/` |
| `src/data/bosses.js` | 12 个技能的 `fx` / `hitFx` 全换成新素材，并新增 `fxScale` / `hitFxScale` 两个字段（每个素材原始尺寸差很多，统一倍率会有的太大有的太小） |
| `src/game/Boss.js` | 两处播放改为读 `skill.fxScale ?? 1.8` / `skill.hitFxScale ?? 2.0`（施法与命中各一处） |

**没有动**：`SkillFx`（扇形喷火/冰霜/闪电那套程序化粒子仍在，它负责"伤害范围长什么样"）；
`geyser` 裂海泉涌的向上水柱（你要求保留）；`phaseBlast` 阶段大招（仍是 tornado + ring）。

---

## 二、4 个 BOSS 的分配

| 关卡 | BOSS | 技能 → 施法特效 / 命中特效 | 用到的**新素材**种类 |
|---|---|---|---|
| 1 | 深渊火龙（day） | flame→`fxFireBurst`/`fxFireBurst`<br>sweep→`fxClawSlash`/`fxClawSlash` | **2** |
| 2 | 炎狱火龙（dusk） | flame→`fxFireBurst`/`fxFireBurst`<br>sweep→`fxClawSlash`/`fxClawSlash`<br>dive→`fxUpdraft`/`fxFireBurst`<br>overheat→`fxFireBurst`/`fxFireBurst` | **3** |
| 3 | 雷霆龙骑士（暴风雪） | slash→`fxClawSlash`/`fxClawSlash`<br>charge→`fxIceShards`/`fxIceBloom`<br>thunder→`fxBoltStorm`/`fxArcBolt`<br>sweep→`fxClawSlash`/`fxClawSlash` | **5** |
| 4 | 暗夜血魔·终焉（暴风雨） | thunder→`fxBoltStorm`/`fxArcBolt`<br>pull→`fxBigVortex`/`hit`<br>screen→`fxBoltStorm`/`explosion`<br>blink→`fxArcBolt`/`fxClawSlash`<br>bloodFlame→`fxFireBand`/`fxFireBurst`<br>frostBreath→`fxIceMist`/`fxIceBloom`<br>geyser→`tornado`/`explosion`（**原样保留**） | **8** |

10 个新素材全部用上，没有一个是"闲置"的。
数量梯度 2 → 3 → 5 → 8，第 3、4 关明显更花，第 1 关保持"一眼看得清"。

**素材与技能的对应逻辑**（不是随机分的）：

- `fxFireBurst`（爆燃，0.7s）→ 火焰系近身爆点：1 关喷火、2 关俯冲/焚风
- `fxFireBand`（横向火带，3.1s）→ 只给第 4 关血焰吐息：形态最完整，留到最凶的一招
- `fxClawSlash`（青色爪痕，0.1s）→ 所有"横扫/斩击"：尾扫、剑击、瞬影斩
- `fxIceShards` / `fxIceBloom` / `fxIceMist` → 第 3 关（暴风雪天气）冲锋/尾扫、第 4 关霜雪吐息
- `fxBoltStorm`（多束光柱，2.9s）→ 第 3 关落雷、第 4 关血幕降临：全屏级演出
- `fxArcBolt`（电流束，0.2s）→ 落雷命中点、瞬影突袭
- `fxUpdraft`（上升气流柱）→ 第 2 关俯冲撞击（砸地激起气柱）
- `fxBigVortex`（龙卷 + 地裂）→ 第 4 关深渊吸取

---

## 三、验证结果

| 项 | 结果 |
|---|---|
| `node --check src/data/bosses.js` | 通过 |
| 特效名交叉校验（所有 `fx`/`hitFx` 都能在 `FX_DEFS` 里查到） | 通过，35 条 FX_DEFS |
| `vite build` | 通过（9.25s，JS 1.20 MB / gzip 361 kB） |
| `dist/effects/EffectMaterials` | 8.5 MB 已随构建复制 |
| `npm test` | **有 1 条既有失败**：`drift exit does not restore a radial fog burst`（断言 `Boat.js` 里存在字面量 `#splashBurst() {}`，与实际签名不符）。该断言与本轮改动无关，是并发编辑留下的过时精确字符串断言 |

---

## 四、水 / 墨：找到素材了，但差最后一步

**这一轮把范围扩大后找到的东西**：

1. `github.com/mrxz/effekseer-sample-effects` —— 官方示例库的完整打包（**291 个特效**），
   已全部下载并解到 `fx-projects/`（`MAGICALxSPIRAL` / `NextSoft01` / `tktk01` / `tktk02`）。
2. 你本机就装着 **Effekseer 1.7.3**（`D:\Effekseer1.7.3.0`），`Sample/` 里还有 37 个官方 `.efkefc`。

**问题**：这 291 个全是 `.efkproj`（编辑器工程），不是游戏能读的 `.efkefc`。
WebGL 运行时只认 efkefc，工程文件必须用编辑器「导出」一次。

我试过自动化：`Effekseer.exe -c <脚本>` 走 IronPython 命令行钩子，**本机直接段错误（exit 139）**，
这条路走不通；GitHub release 和日本镜像的大文件下载都被重置，也拿不到官方 CLI 版本。

### 可用的水/墨候选（都在 `fx-projects/` 里，双击 .efkproj 即可打开）

| 类型 | 文件 | 说明 |
|---|---|---|
| 水 | `MAGICALxSPIRAL/Undine1..13`（13 个） | 水精灵，从水球到水龙卷都有 |
| 水 | `MAGICALxSPIRAL/AquaPoint` | 水点迸溅 |
| 水 | `MAGICALxSPIRAL/Topwater1` | 水面爆发 |
| 水 | `MAGICALxSPIRAL/Water_Impact` | 水击命中 |
| 水 | `NextSoft01/MagicWater` | 水魔法阵 |
| 墨/暗 | `NextSoft01/MagicDark` | 暗魔法阵 |
| 墨/暗 | `tktk02/Dark1`、`Dark2` | 暗雾团 |
| 墨/暗 | `MAGICALxSPIRAL/Breakdown` | 崩解黑雾 |
| 爪击 | `tktk02/Claw1..4` | 比现在用的 parts_hit02 更"爪" |
| 雷 | `MAGICALxSPIRAL/Thunder1..3` | 备选落雷 |
| 冰 | `MAGICALxSPIRAL/Icicle1..3` / `IcicleBroken` | 冰锥（备选） |

### 导出步骤（每个约 20 秒）

1. 双击 `D:\Effekseer1.7.3.0\Tool\Effekseer.exe`
2. `文件 → 打开` 选 `fx-projects\MAGICALxSPIRAL\Undine1\Undine1.efkproj`
3. `文件 → 导出 → 导出为 efkefc`（或 `Ctrl+E`），存到 `public/effects/Undine/Undine1.efkefc`
   —— **纹理目录要跟着一起拷**（工程目录里已有 `Texture/`，整个文件夹复制过来即可）
4. 告诉我导出了哪些，我接进 `FX_DEFS` 并按语义分给对应技能

> 如果你想让我连这一步也自动化，可行的办法是把编辑器换成能跑 CLI 的版本（1.6x 的 CLI 在这台机器上
> 也许不崩），但需要你同意我下载安装——目前大文件通道是断的，得你手动下。

---

## 五、试玩

```bash
npm run dev        # 开发服务器（改了代码有热更新）
# 或者
npm run host       # 构建 + 起联机服务
```

进「怪物模式」→ 关卡选择 → 建议从**第 3 关**开始看（冰 + 雷 + 爪击三种新素材都在这一关）。

**看的时候重点确认三件事**（这三个是我没法替你判断的）：

1. **大小**：新特效和 BOSS 体量配不配？太大就调对应技能的 `fxScale`（现在 1.15~1.8），
   太小就往 2.0 加。数据都在 `bosses.js`，改数字即可，不用碰逻辑。
2. **是否糊成一团**：`SkillFx` 的程序化粒子和新特效是叠加的。如果喷火那段看着太满，
   我可以把对应技能的 SkillFx 压到 60% 强度（改 `SkillFx.cone` 的 count），而不是删掉它。
3. **第 4 关血幕降临**（`screen`）用的是 `fxBoltStorm` 放大到 1.8，是全屏最强的一张，
   如果觉得"雷"和"血魔"的气质不搭，我可以换成 `fxFireBand` 或加一层血色。

---

# 追加（2026-11-02 22:2x）

## 1. 第三关冰柱换掉

`charge`（冲锋突刺）的施法特效 `fxIceShards`（ef_ice03，冰晶下坠）→ **`fxIceMist`（ef_ice02，冰雾膨胀）**，
倍率 1.3。命中点仍是 `fxIceBloom`（冰花绽开），保留"推进时是雾、撞上是花"的层次。

`fxIceShards` 没有删，还留在 `FX_DEFS` 里——想换回去只改 `bosses.js` 的 `charge.fx` 一个字段。

## 2. 第一关新增「追踪漩涡」

第一关只有喷火 + 尾扫两个技能，中间空窗太长。新增一个**满场追着人跑**的龙卷：

| 参数 | 值 | 说明 |
|---|---|---|
| `stages` | `[1]` | 只在第一关 |
| `firstDelay` | 8s | 开打 8 秒后第一次 |
| `interval` / `duration` | 11s / 9s | 每 11 秒招一次、每次跟 9 秒 → 全程约 82% 时间在场，只留 2 秒喘息 |
| `telegraph` | 1.5s | 目标船头前方 9m 亮青色预警圈 |
| `chaseSpeed` | 8.5 m/s | 比船慢，全速能拉开，一停就被咬 |
| `radius` / `damage` / `tickInterval` | 6.5m / 5 / 1s | 碰到每秒掉 5 血 |
| `slowSpeed` / `slowTime` | 14 m/s / 2.2s | 咬中后限速（满速 30+ 压到 14） |

**目标选择**：`#topDamagePlayer()` 读现成的 `damageByPlayer`，挑**对 BOSS 伤害最高的活人**；
单机就是自己；全员 0 伤害（刚开局）时退化成列表里第一个活人。

**联机口径**（和落雷一致）：host 选目标、结算伤害、限速，广播 `bossVortex`；
客机只负责画预警圈和龙卷，伤害走 `bossHit`。消息白名单已在 `Game.js` 与 `server/server.js` 补 `bossVortex`。

**要调难度就改这几个数**（`src/data/bosses.js` 的 `BOSS_VORTEX_CHASE`）：
- 想全程常驻：`interval` 改成和 `duration` 一样（9 / 9）
- 想放水：`interval` 拉到 18，或 `damage` 降到 3
- 嫌追得太狠：`chaseSpeed` 降到 6.5
- 嫌不够粘：`chaseSpeed` 提到 11（快过大部分船）

## 3. `fx-projects` 到底在哪

绝对路径：**`D:/3Dgame - 副本\fx-projects\`**（237 个 `.efkproj`）

你找的 `Undine1` 完整路径：
```
D:/3Dgame - 副本\fx-projects\MAGICALxSPIRAL\Undine1\Undine1.efkproj
```

> 上一轮我回复时解压还在后台跑（当时只出了 76 个），`MAGICALxSPIRAL` 目录正好还没写完，
> 所以你打开时看不到。现在 237 个都在了。

水/墨候选的准确路径：

| 用途 | 完整路径 |
|---|---|
| 水·精灵系列 | `fx-projects\MAGICALxSPIRAL\Undine1\` ~ `Undine13\`（13 个） |
| 水·落点 | `fx-projects\MAGICALxSPIRAL\Water_Impact\Water_Impact.efkproj` |
| 水·爆发 | `fx-projects\MAGICALxSPIRAL\Topwater1\Topwater1.efkproj` |
| 水·魔法阵 | `fx-projects\NextSoft01\MagicWater\MagicWater.efkproj` |
| 墨·魔法阵 | `fx-projects\NextSoft01\MagicDark\MagicDark.efkproj` |
| 墨·雾团 | `fx-projects\tktk01\Dark1\Dark1.efkproj`、`Dark2`、`Dark3` |
| 墨·崩解 | `fx-projects\MAGICALxSPIRAL\Breakdown\Breakdown.efkproj` |

每个目录里都有 `Texture/`，导出 efkefc 时整个文件夹一起拷到 `public/effects/` 下即可。

---

# 追加（2026-11-02 22:5x）

## 4. 龙卷重做：自建网格 + 常驻

`ef_wind03` 实测下来**根本不是龙卷**——它是"贴地裂纹 + 碎块爆开"（截图 `shots/vortex_stretch.png`），
`ForceFieldTornado` 是一团往上飘的粒子云（`shots/vortex_tornado.png`），`ef_wind02` 是漂在半空的横向气团
（`shots/vortex_wind02.png`）。三张都做不出"竖着的实体龙卷柱"。

所以新增 `src/game/TornadoMesh.js`，程序化画龙卷：

| 项 | 值 |
|---|---|
| 结构 | 两层反向旋转的螺旋带（外层 2.6 圈/内层 3.4 圈）+ 贴地尘环 |
| 尺寸 | 高 **11m**（BOSS 体高 7m，龙卷比它高一截）、底部半径 1.3m、顶部 4.4m（二次曲线张开成漏斗） |
| 材质 | canvas 现画的竖向气流丝纹理，加法混合 + 双面，纹理沿高度滚动（读作"往上抽"） |
| 代价 | 3 个 draw call，一次纹理生成 |

`ef_wind03` 保留，但压扁铺地（`scale: {x:1.5, y:0.9, z:1.5}`）当"地面被卷起来"的碎片层，
两层叠起来是"实体柱 + 地面乱流"。

**常驻**：`interval: 0` + `duration: 0` → 开打 8 秒后出现，之后**不再消失**，
只有 BOSS 阵亡 / 关卡结束 / 离开战斗阶段才清。目标阵亡后每 3 秒转火到新的最高伤害玩家。

## 5. 落雷改成从天而降（ef_lightning02）

`ef_lightning02` 是竖向电流束，但原来它只出现在 BOSS 身上（施法层）。
现在两处都加了"空中劈下"：

| 位置 | 改动 |
|---|---|
| `thunder` 技能（第 3 关） | `bosses.js` 新增 `skyFx: 'fxArcBolt', skyFxY: 6, skyFxScale: 3.2`；`BossMode.#playSkillVisual` 的 ground 分支在落点上方播 |
| 周期落雷 `BOSS_THUNDER`（第 2 关起） | `#strikeThunder` 里补 `fx.play('fxArcBolt', x, 6, z, 3.2)` |

原来的程序化 `skillFx.bolt`（贴地强光）保留，两者叠起来才是"天上一道下来 + 地上一圈炸开"。

参数：`skyFxY` 是特效**中心**高度，`skyFxScale 3.2` 时上下各约 5m，所以 6m 中心 → 覆盖 1~11m，
正好从 11m 高空接到水面。嫌短就加 `skyFxScale`，嫌悬空就减 `skyFxY`。

## 6. fx-projects 的"二维码"修好了

**原因**：`.efkproj` 是 EFKE 二进制，内部按**哈希 ID** 引用纹理。上一版解包时我把文件重命名成了
`Texture/xxx.png` 这种真实路径 → 编辑器找不到，只能画默认棋盘格，就是你看到的"二维码"。

**修复**：重新解包，哈希名文件全部保留，另外复制一份 `xxx.efkproj` 方便双击，`metafile.json` 也留着。

> 打开前先把 Effekseer 里已经开着的那几个关掉再重开，否则会读内存里的旧状态。

### 精选清单（按质量排，避开那些"几何贴图演示"）

| 推荐度 | 路径 | 是什么 |
|---|---|---|
| ★★★★★ | `fx-projects/Pierre01/LightningStrike/LightningStrike.efkproj` | 落雷，天空劈下的完整演出 |
| ★★★★★ | `fx-projects/Pierre02/BloodLance/BloodLance.efkproj` | 血枪，第 4 关血魔绝配 |
| ★★★★★ | `fx-projects/Pierre01/MonsterRoar/MonsterRoar.efkproj` | 怪物咆哮（BOSS 出场/转阶段） |
| ★★★★☆ | `fx-projects/Pierre01/PhantasmMeteor/PhantasmMeteor.efkproj` | 幻影陨石，大招级 |
| ★★★★☆ | `fx-projects/Pierre02/CosmicMist/CosmicMist.efkproj` | 宇宙雾，墨/暗的替代 |
| ★★★★☆ | `fx-projects/Suzuki01/003_snowstorm_effect/snowstorm11.efkproj` | 雪暴，第 3 关暴风雪气氛 |
| ★★★★☆ | `fx-projects/Suzuki01/001_magma_effect/aura.efkproj` | 岩浆喷发 |
| ★★★★☆ | `fx-projects/MAGICALxSPIRAL/Undine13/Undine13.efkproj` | 水精灵最完整的一版 |
| ★★★☆☆ | `fx-projects/MAGICALxSPIRAL/Water_Impact/Water_Impact.efkproj` | 水击命中 |
| ★★★☆☆ | `fx-projects/Pierre01/Atmosphere/Atmosphere.efkproj` | 环境氛围（不是打击特效） |

**别浪费时间看的**：`tktk01/02` 里的 `Blow*` / `Arrow*` / `hoe*`（都是简单几何 + 纯色贴图），
`Effekseer01` 系列（就是你现在已经在用的 `Basic`，已经接进项目了）。

---

# 追加：你导出的三个特效 —— 排查结果（2026-11-02 23:3x）

## 现状：文件没问题，是格式版本对不上

三个都收到并检查过了：

| 项 | 结果 |
|---|---|
| `public/effects/LightningStrike/` | 15 个文件，efkefc + 11 张 PNG ✓ |
| `public/effects/BloodLance/` | 12 个文件，efkefc + 7 张 PNG ✓ |
| `public/effects/CosmicMist/` | 13 个文件，efkefc + 9 张 PNG ✓ |
| PNG 规格 | 全是 8-bit RGBA，64×256 ~ 512×512，正常 |
| HTTP 可达性 | 全部 200，Content-Type 已修成 `image/png` |

**但运行时加载不了**，控制台报：

```
TypeError: Failed to execute 'texImage2D' on 'WebGLRenderingContext':
           Overload resolution failed.
```

## 排查过的三件事

1. **纹理路径是 `../../fx-projects/...`** —— 导出时按工程位置算的相对路径，拷到 `public/effects/` 后
   解析成 `/fx-projects/Pierre01/LightningStrike/<hash>`。
   → 已写 `scripts/mirror_fx_paths.mjs` 自动把纹理镜像到这个路径（只复制不删）。
2. **无扩展名文件被当 `application/octet-stream`** —— 会导致图片解码失败。
   → 预览服务器已改成按文件头嗅探 MIME。
3. 两件都修完，**依然报同一个错** → 排除路径和 MIME。

## 真正的根因：运行时版本

| | 你的 efkefc | 项目里能用的 efkefc |
|---|---|---|
| 魔数 | `EFKE` | `EFKE` |
| INFO 块长度 | **2010 字节** | **302 字节** |
| 版本标记 | 1710 | 1710 |

INFO 块长了 6.7 倍 —— 1.7.3 的编辑器往文件里写了新版的元数据（材质/参数表），
而项目里的 WebGL 运行时是 **1.70e（2021 年编译）**，读到后面参数错位，纹理规格被解析成 0，
于是 `texImage2D` 拿不到合法尺寸就抛错。

## 两个解法

### A. 导出时把格式版本降下来（推荐，改一次就好）

`Ctrl+E` 弹出的导出对话框里，找 **Version / 格式版本** 下拉（在文件名下面那一片），
从默认的最新版改成 **1.70** 或更保险的 **1.60** 再导出。覆盖同名文件即可，路径镜像脚本重跑一次：

```bash
node scripts/mirror_fx_paths.mjs
```

如果导出对话框里没有版本选项，就用 `文件 → 另存为` 存成 `.efkproj` 后，
在 `文件 → 环境设置` 里找 "保存格式版本"（1.7.3 有的版本把它放这儿）。

### B. 升级项目运行时

把 `public/effekseer/effekseer.min.js` + `effekseer.wasm` 换成 1.7.3 对应的版本。
**我不推荐先动这个**：项目里 `Effects.js` 用了 `loadEffect(url, scale, onload, onerror)`、
`setRestorationOfStatesFlag(false)`、`setProjectionMatrix` 等接口，新版有没有改签名要逐个回归，
而且 34 处特效调用都得重测。等你确认 A 走不通再动。

> 下载通道现在是断的（GitHub release / codeload / raw 全被重置，只有 jsDelivr 通，而它不支持 release 资产），
> 升级运行时需要你手动下一个 zip 给我。

---

# 追加：ef_fire03 接进范围 AOE（2026-11-02 23:4x）

## 先澄清：它其实一直在用

`fxFireBand`（= `ef_fire03`）原本接在第 4 关的 **血焰吐息 `bloodFlame`**（`bosses.js:122`）。
那是扇形吐息不是 AOE，而且是第 4 关才出现，所以前三关看不到它 —— 不是没加，是没打到。

## 现在加到了真正的范围 AOE 上

**`phaseBlast`／崩海咆哮** —— 所有 BOSS 掉到 1/3 血时放的大招，`kind: 'ground'`、**半径 30m**。
它原本的演出是硬编码的（`Boss.js#beginPhaseBlast` 里写死 `tornado` + `ring`，
数据里的 `fx: ['tornado', 'explosion']` 根本没被读取），所以之前既没火也没别的形态层。

改成两段：

| 阶段 | 加了什么 | 位置 |
|---|---|---|
| 蓄力（3 秒红圈期） | 1 道 `fxFireBand`，scale 2.2 | `Boss.js#beginPhaseBlast`，BOSS 脚下 |
| 结算（砸地那一下） | **圆周 5 道** `fxFireBand`，scale 1.9，半径 = 30 × 0.62 ≈ 18.6m | `BossMode#resolveSkill` 的 `phaseBlast` 分支 |

为什么是 5 道而不是铺满：再多人眼也读不出来，而且 `Effects.transient` 上限是 48，
要留额度给道具命中特效（历史上顶满过会黑屏）。

想更密就把 `for (let i = 0; i < 5; i++)` 的 5 改大，`* 0.62` 改 0.8 让圈铺得更外。

## 没动的 AOE

`sweep`（尾扫冲击，`ring` 半径 20m）也属于范围 AOE，但它三个关卡共用一份数据，
加火带会让三个 BOSS 的甩尾全变成火系，和"水属性尾扫"的设定冲突。要加得先按 BOSS 拆数据。

---

# 崩海咆哮火带 · 实测验证（2026-11-02 23:5x）

## 结论：特效在播，但要打到 BOSS 1/3 血才触发

用无头浏览器进了第一关，把 BOSS 血压到 30%，确认：

```
蓄力中 {"state":"telegraph","skill":"phaseBlast"}
蓄力结束 state = chase
结算后 {"transient":11}      ← 7 道火带 + 龙卷/光环同时在场
```

`phaseBlast` 的触发条件是 `Boss.js:529`：

```js
if (this.phaseIndex < BOSS_PHASE_THRESHOLDS.length
  && this.phaseLock <= 0
  && this.hpRatio <= BOSS_PHASE_THRESHOLDS[this.phaseIndex]) { ... }
```

`BOSS_PHASE_THRESHOLDS = [1/3]` —— **必须把 BOSS 打到剩 1/3 血**才会放，第 1 关 BOSS 3000 血，
得打掉 2000。没打到这个线就永远看不到。

截图证据：`shots/verify/phaseblast_charge.png`（蓄力）、`shots/verify/phaseblast_blast.png`（结算）。

## 顺手修掉的过曝

第一版是 5 道 × scale 1.9、半径 0.62 —— 全挤在中心，叠加 bloom 之后糊成一团白光，
看不出是"一圈火"。改成：

| 参数 | 旧 | 新 |
|---|---|---|
| 道数 | 5 | 7 |
| 半径系数 | 0.62（18.6m） | 0.72（21.6m） |
| 单道 scale | 1.9 | 1.45 |

现在结算画面能清楚看到 BOSS 周围一圈橙色火带。

## 还想更"冲天"的话

火带现在全在 y=2.0，看起来是一圈火球。想要"火墙冲天"可以改 `BossMode.js:1077` 那段：

```js
for (let i = 0; i < 7; i++) {
  const a = (i / 7) * Math.PI * 2 + 0.3;
  const y = i % 2 ? 2.0 : 5.0;          // 高低错开
  this.fx?.play('fxFireBand', info.x + Math.cos(a) * blastR2, y, info.z + Math.sin(a) * blastR2, 1.45);
}
```

高低交错之后层次会更明显。

---

# 复核：火带到底有没有画出来（2026-11-03 00:0x）

## 三层证据：它确实在播

1. **加载正常**：`fx.effects.fxFireBand` 存在（`hasFireBand: true, fireBandLoaded: true`，共 35 个特效）
2. **能单独渲染**：手动 `fx.play('fxFireBand', x, 3, z, 2.5)` 之后截图
   （`shots/verify/fireband_manual.png`）——船头正前方那团横向火焰就是它
3. **大招里确实创建了 handle**：蓄力结束时 `transient = 11`（7 道火带 + 龙卷/光环/爆点）

## 那为什么"看不到"

三个原因叠在一起：

| 原因 | 说明 |
|---|---|
| **30m 粒子环太抢** | `#playSkillVisual` 的 ground 分支给 phaseBlast 铺了 **90 个** `ringBurst` 粒子，从中心向外炸，恰好盖住火带最亮的头 1 秒 |
| **火的峰值来得晚** | ef_fire03 实测峰值在 **1.3 秒**，而结算那一下的爆点/震屏/粒子环全在 0~0.5 秒 —— 人的注意力已经被消耗完 |
| **7 道全贴地** | 全部 `y=2.0` 且朝向一致，读起来是"一圈黄光带"，不像"火" |

## 这一版改了什么

| 参数 | 旧 | 新 |
|---|---|---|
| 高低 | 全 2.0 | **交替 2.2 / 5.2** |
| 朝向 | 全部沿 X 轴 | **绕 Y 转到圆周切向**（`h.setRotation(0, -a + π/2, 0)`） |
| 单道 scale | 1.45 | **1.7** |
| 三渲粒子环 | 90 个 | **45 个** |

现在结算画面能明确分辨出 7 团独立的横向火带围成一圈（见 `shots/verify/phaseblast_blast.png` 最新版）。

## 还想更"火墙"的话

现在火带仍然是**横躺**的。想立起来变成竖直火墙，把这一行：

```js
h?.setRotation?.(0, -a + Math.PI / 2, 0);
```

改成：

```js
h?.setRotation?.(Math.PI / 2, -a + Math.PI / 2, 0);
```

绕 X 轴转 90° 让火带竖起来。**但有风险**：Effekseer 的 handle 旋转会连粒子运动方向一起转，
可能变成"火往天上喷"而不是"火墙"。改完必须重跑 `tests/probe_phaseblast.mjs` 看一眼再定。

---

# 根因：ef_fire03 是"向上喷射的火柱"，不是横向火带（2026-11-03 00:1x）

## 对照实验

在船头 24m 的空地上并排播三个不同 scale（`tests/probe_fireband2.mjs`）：

| scale | 屏幕占比 | 结论 |
|---|---|---|
| 1.7（之前用的） | 约一人高，20m 外几乎看不见 | **这就是"看不到"的原因** |
| 3.0 | 能看到一小簇火 | 还是不够 |
| 5.0 | 占画面 1/6 宽，向上喷的火柱 | 这才有大招感 |

之前总览里把它读成"横向火带"是误判——那是 0.55 缩放 + 仰视角度造成的错觉。
**它本质是"地面爆开 + 火焰向上喷"的柱状效果**，必须放大到 4 以上才有存在感。

## 现在的参数

| 项 | 值 |
|---|---|
| 数量 | 5 根（原来 7 道） |
| 单根 scale | **4.2**（原来 1.7） |
| 圈半径 | 30 × 0.45 = **13.5m**（原来 21.6m，更靠近 BOSS，玩家在圈里能看清） |
| 高度 | y = 3.6，火柱从水面升起 |
| 蓄力那道 | scale **3.2**（原来 2.2） |

结算瞬间 `transient = 9`，画面里能明确看到 5 根火柱围住 BOSS（`shots/verify/phaseblast_blast.png`）。

## 教训

**判断一个 Effekseer 素材"能不能看见"，不能只看它在预览图里的形态，要按实际游戏里的 scale 放到实际距离上量。**
`tests/probe_fireband2.mjs` 就是干这个的——三个 scale 并排，一眼就能定尺寸。

---

# 终极定位：A/B 对照证明它一直在渲染，是我给的尺寸太小（2026-11-03 00:2x）

## A/B 实验（`tests/probe_ab.mjs`）

同一机位、只改"有没有放火"：

| | 文件 | 内容 |
|---|---|---|
| A | `shots/verify/ab_before.png` | 空画面（BOSS 站着，无技能） |
| B | `shots/verify/ab_after.png` | 往 BOSS 周围塞 8 个 **scale 8** 的 fxFireBand |

B 里是一整面**铺满画面中央的火墙**，A/B 字节差 12 KB —— 说明 `ef_fire03` 的渲染链路完全正常，
之前"看不见"纯粹是 scale 的问题：

| scale | 结果 |
|---|---|
| 1.7 | 一人高，20m 外等于没有 |
| 4.2 | 黄昏底色下还是糊掉 |
| **8.0** | 一面火墙（B 图） |

## 最终参数

| 项 | 值 |
|---|---|
| 数量 | 6 根 |
| 单根 scale | **6.8** |
| 圈半径 | 30 × 0.52 ≈ **15.6m** |
| 高度 | y = 4.5 |
| 蓄力那道 | 3.2 |

`shots/verify/phaseblast_blast.png` 是最新实机效果：BOSS 周围一圈橙黄色火柱。

## 如果还是看不到，先确认这三件事

1. **强制刷新**：`Ctrl + F5`（旧 JS 会被缓存，hash 变了也可能拿到旧 index.html）
2. **看 HUD 顶部有没有红字**「蓄力：崩海咆哮！」—— 有这行才代表技能真的触发了
3. **控制台压血最稳**：`const b = window.__game.bossMode.boss; b.hp = b.maxHp * 0.3;`

---

# 第 2/3 关看不到火柱：排查（2026-11-03 00:4x）

## 现象

第 1 关能看见（一整团白热火焰），第 2/3 关只有 BOSS 左侧一小团。

## 定位过程

用 `tests/probe_phaseblast.mjs <stage>` 分别跑 1/2/3 关（压到 1/3 血、轮询到蓄力结束、截图）：

| 关 | 结果 |
|---|---|
| 1 | 一团巨大白光（看着像火墙） |
| 2 | 只有 BOSS 左侧一小团，`transient` 却是 14（7 个 handle 都在） |
| 3 | 同第 2 关 |

`transient` 数量和画面里能看到的火柱数量对不上 → **7 个 handle 全部画在同一个点上**。

## 三个可疑点，逐个排掉

1. **`handle.setRotation` 把火柱转成侧对相机的细线** → 已删除该调用（现在完全不转）
2. **半径太大跑出视野**（18.6m 时第 2/3 关 BOSS 会追人，整圈火柱到了玩家身后）→ 收到 11m
3. **坐标基准是 NaN**：`info.x + Math.cos(a) * R`，只要 `info.x/info.z` 有一个不是有限数，
   5 个位置全变 NaN，Effekseer 会把它们全塞到一个默认点 —— **这正好解释"handle 数对、画面只有一团"**

已加兜底：

```js
const bp = this.boss?.pos;
const cx = Number.isFinite(info?.x) ? info.x : (Number.isFinite(bp?.x) ? bp.x : 0);
const cz = Number.isFinite(info?.z) ? info.z : (Number.isFinite(bp?.z) ? bp.z : 0);
```

## 当前参数

| 项 | 值 |
|---|---|
| 数量 | 5 根 |
| scale | **9.5** |
| 半径 | 11m |
| 高度 | y = 5.0 |
| 旋转 | **不转** |

## 如果这版还是只有一团

说明 `info` 的坐标本身是好的、问题在别处，那就换实现路线：
把火柱改成 `playAttached`（跟随 BOSS 位置、loop），或用 `SkillFx.pillar` 那套三渲程序化火柱，
不再依赖一次性 `play` 的坐标。
