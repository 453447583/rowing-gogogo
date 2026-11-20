# 激流勇进（Rapids Race）开发状态记录

> 本文档用于跨会话/跨窗口交接。新开窗口读这份即可接上。
> 最后更新：2026-11-04（第三十五轮：修复误判全员阵亡）

---

## 一、项目基本信息

- **项目名**：rapids-race（激流勇进）
- **技术栈**：Three.js 0.160 + Vite 5 + WebSocket（ws 8）+ Effekseer WASM 粒子特效
- **运行模式**：单机道具赛 / 单机 Boss 模式 / 局域网联机
- **构建产物**：`dist/` 目录，Vite build 后约 1 MB（`dist/assets/index-*.js`）

### 命令

```bash
npm run dev       # 开发模式（Vite 热更新）
npm run build     # 构建 dist/
npm test          # 跑 gameplay.test.mjs（纯逻辑测试，不启动浏览器）
npm run server    # 启动 WebSocket 联机服务（server/server.js，端口见文件内）
npm run host      # build + 启 server（一键联机）
```

---

## 二、项目目录结构

```
src/
├── main.js              ← 入口：初始化场景、路由（大厅/比赛/Boss）
├── game/                ← 游戏核心逻辑（19 个文件）
│   ├── Game.js          ← 主循环、渲染管线、黑屏守卫、联机宿主逻辑
│   ├── Boat.js          ← 船只物理、状态机（半速/章鱼/水柱/异世界/护盾）
│   ├── BoatWeapons.js   ← 道具武器发射（墨鱼喷墨、追踪章鱼怪等）
│   ├── Items.js         ← ItemBoxField 道具箱外观、ITEM_DEFS 道具定义
│   ├── Effects.js       ← Effekseer 特效加载 & 生命周期管理
│   ├── BossMode.js      ← Boss 模式主控
│   ├── Boss.js          ← Boss 实体
│   ├── BossArena.js     ← Boss 战场地形
│   ├── BossThemes.js    ← Boss 主题（颜色/光照）
│   ├── Track.js         ← 赛道生成（样条曲线、水面铺展）
│   ├── Water.js         ← 水面材质（中高档位调色）
│   ├── PostFx.js        ← 后处理合成（bloom / tonemap / distortion）
│   ├── CameraRig.js     ← 相机跟随
│   ├── Input.js         ← 输入映射（键盘/鼠标）
│   ├── RealSky.js       ← 天空盒
│   ├── Environment.js   ← 环境整体（山/雾/光照）
│   ├── SceneDressing.js ← 场景装饰（路标/浮标/沉船等）
│   ├── SkillFx.js       ← 技能特效（BOSS 模式专用）
│   └── Textures.js      ← 纹理预加载
├── data/                ← 纯数据定义
│   ├── maps.js          ← 赛道地图配置、潮汐系数
│   ├── boats.js         ← 船只属性（质量/稳定性/碰撞半径等）
│   ├── boatWeapons.js   ← 武器数据
│   ├── bosses.js        ← Boss 关卡
│   └── bossThemes.js    ← Boss 主题色
├── net/NetClient.js     ← 联机客户端
├── ui/
│   ├── ui.js            ← HUD 渲染、墨鱼喷墨遮罩、道具槽
│   ├── BoatShowcase.js  ← 大厅选船展示
│   └── PodiumShowcase.js← 领奖台展示
└── utils/
    ├── bubbleMaterial.js
    └── waves.js

server/server.js         ← WebSocket 联机服务
tests/                   ← 纯逻辑测试（Node 跑，不启浏览器）
public/                  ← 静态资源（effekseer、models、monsters、ui 图片）
dist/                    ← 构建产物
```

---

## 三、黑屏 Bug 修复（当前最高优先级）

### 现象
- 开始道具赛没多久就闪黑屏，间歇性，过段时间自己好，再闪
- 黑屏时约 81% 画面纯黑，仅最右侧约 19% 窄条有 3D 画面（水面+船+天空），边界是**笔直竖线**
- HUD（小地图、名次、速度表、道具槽）**正常铺满全屏**——说明 DOM 层正常，是 WebGL 画布只画了一部分

### 根因定位
**Effekseer WASM 运行时直接调用 `glViewport` / `glScissor`，Three.js 的 WebGLState 缓存感知不到。**

Effekseer 的 Emscripten 运行时导入了 `_glViewport` / `_glScissor`，会在自己的渲染流程里直接改 WebGL 状态。Three.js 的 `WebGLState` 缓存了 `currentViewport` / `currentScissor`，后续再调 `renderer.setViewport(0,0,w,h)` 时**命中缓存、不下发 GL**，脏状态残留。

为什么是"间歇性"：不一定每帧都触发 Effekseer 渲染，可能某个特效播放时改了 viewport 又没恢复。

为什么是"竖线、右侧窄条"：Effekseer 内部渲染目标可能是一个较小的 framebuffer（比如后处理特效的临时 RT），它的 viewport 只覆盖那个小矩形。

### 修复方案（三层防护，全部在 `src/game/Game.js`）

#### 第 1 层：每帧先强制拉回 viewport
```js
#resetViewport() {
  const gl = this.renderer.getContext();
  const c = this.renderer.domElement;
  // 1. 原生 GL 强制整屏（绕过 Three.js 缓存）
  gl.viewport(0, 0, c.width, c.height);
  gl.disable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, c.width, c.height);
  // 2. Three.js API 同步缓存
  this.renderer.getSize(VIEW_SIZE);
  this.renderer.setViewport(0, 0, VIEW_SIZE.x, VIEW_SIZE.y);
  this.renderer.setScissorTest(false);
}
```

关键：**只调 `renderer.setViewport()` 不够**，因为 Three.js 内部有缓存，值相同就跳过。必须先直接调 `gl.viewport`。

#### 第 2 层：每帧检查 canvas 尺寸是否漂移
```js
#guardCanvasSize() {
  const [rw, rh] = this.renderer.getSize(VIEW_SIZE);
  if (rw !== this.canvas.clientWidth || rh !== this.canvas.clientHeight
      || rw !== window.innerWidth || rh !== window.innerHeight) {
    this.#onResize();
  }
}
```

#### 第 3 层：黑屏守卫（自愈）
```js
#checkBlackFrame() {
  // 每 1.5 秒采样帧缓冲中线上 5 个点：4%, 25%, 45%, 65%, 90% 横向位置
  // 连续 2 次 ≥ 4/5 采样点纯黑（R+G+B < 12），触发自愈
  // 输出 console.warn('[黑屏守卫] 检测到黑帧，重建渲染缓冲', { dark, buffer, css, viewport, scissor, scissorTest, pixelRatio })
  // 然后自动 #onResize() + #resetViewport()
}
```

### 渲染循环改动（Game.js 的 `#loop` 方法）
```js
this.fx.update(dt);
this.#guardCanvasSize();   // 新增
this.#resetViewport();     // 新增
this.post.render(dt);
if (!this.post.isActive) this.fx.draw(this.camera);
this.#checkBlackFrame();   // 新增
```

### 文件顶部新增常量
```js
const VIEW_SIZE = new THREE.Vector2();
const BLACK_PROBE = new Uint8Array(4);
```

### 还原的临时改动
- `Effects.js` 的 `ink`（墨鱼喷墨）特效 URL 还原回 `Simple_Distortion`（之前 A/B 测试误以为 distortion 素材导致黑屏，实测否决）
- `tests/gameplay.test.mjs` 删掉了 "禁止使用 Distortion 特效" 的临时断言

### 验证状态
- ✅ `npm test` PASS
- ✅ `npm run build` PASS（`dist/assets/index-*.js` 约 1042 kB）
- ❌ 浏览器自动化环境因标签页节流无法截图，未能在当前环境复现黑屏

### 用户侧验证步骤
1. 用户在自己机器上跑一局道具赛，看是否还能黑屏
2. 如果仍黑屏 → 打开浏览器控制台（F12），看是否有 `[黑屏守卫]` 这一行，把完整日志（尤其是 `scissor` 和 `viewport` 参数）贴回来
3. 如果黑屏但守卫没触发 → 守卫阈值可能太严，采样点全落在亮区。需要把采样点纵向位置从单行（`0.5`）扩成多行（`0.2, 0.5, 0.8`），或把 `dark < 4` 放宽
4. 如果守卫触发并自愈 → 根因确认是脏状态残留，后续把守卫的 console.warn 改成调试开关控制

### 关键技术背景（供后续开发者参考）
- Three.js `renderer.resetState()` 会调 `WebGLState.reset()`（WebGLState.js L1180-1272），里面确实会 `gl.viewport(0,0,canvas.width,canvas.height)`，但**这个方法不会每帧自动调用**，只在手动 `resetState()` 时跑
- Effekseer 的 Emscripten 封装是直接导入 `_glViewport`/`_glScissor` 符号，绕过了 Three.js 的状态管理

---

## 四、道具系统（已改造，待测试）

### 改造清单（删 2 个，改 4 个）

| 道具 | 状态 | 说明 |
|------|------|------|
| 反磁护盾 (antimagn) | ❌ 已删 | 旧版逻辑过时 |
| 诱饵 (decoy) | ❌ 已删 | 同上 |
| 减速艇 (halfSpeed) | ✅ 新增 | 击中后目标 Boat 进入 `halfSpeedTimer`（Boat.js） |
| 追踪章鱼怪 (octopus) | ✅ 改造 | 发射章鱼怪模型，追踪最近敌人，命中后 `octoGrabTimer` 减速 |
| 深海瀑布 (geyserLift) | ✅ 改造 | 目标位置喷水柱，范围内敌人被 `geyserLiftTimer` 顶起腾空 |
| 泡泡蜻蜓 (bubbleDragonfly) | ✅ 改造 | 目标区域生成泡泡云，遮挡视野 + 轻微减速 |
| 护盾 (shield) | ✅ 保留 | 加了 `shieldTimer` 状态 |

### 文件改动
- `src/game/Items.js`：
  - `ItemBoxField` 类重做道具箱外观（InstancedMesh 合批，5 draw call；蓝色金属框/发光面板/独立问号/水面光环/环绕粒子）
  - ITEM_DEFS 的 switch 分支改了
  - 新增 `voidWorld` 异世界黑球（`#ensureVoidWorld` / `#updateVoidWorld`）——有 0.18s 淡入 / 0.32s 淡出，避免硬切黑屏
  - 新增 void/octopus/halfSpeed/geyserLift FX 定义
- `src/game/Boat.js`：新增状态计时器 `halfSpeedTimer` / `octoGrabTimer` / `geyserLiftTimer` / `voidTimer` / `shieldTimer`；新增 `#ensureShameMark()` 红色汗颜特效

### 联机相关
- `server/server.js` 的 `RELAY_TYPES` 白名单已包含：`itemPick / itemUse / itemHit / itemFx / lightning`

---

## 五、UI / HUD

### 墨鱼喷墨遮罩（之前因透明度过高导致整屏黑，已修复）
- `src/ui/ui.js` + `index.html` 改动：
  - 遮罩透明度封顶 0.6
  - 底色从 0.88 降到 0.52
  - 中央窗口扩大到 52% × 40%

### HUD 正常
- 黑屏 Bug 中 HUD 不受影响 → DOM 层没问题，问题纯在 WebGL canvas

---

## 六、水面画质

`src/game/Water.js` 调色恢复到**中高**档位（非夏威夷镜面风）：
- `uSat` 0.68
- `uExposure` 0.82
- fresnel 上限 0.55

---

## 七、待办事项（按优先级）

### P0 — 必须先验证
1. **用户实机测试黑屏修复**：让用户跑一局道具赛，看还闪不闪。如果闪，抓控制台 `[黑屏守卫]` 日志
2. **道具系统端到端测试**：6 个新/改道具，每个在单机 + 联机场景都跑一遍

### P1 — 道具相关
3. 联机同步 AI 权重调整（BoatWeapons 选道具的概率）
4. 清理旧版诱饵/水雷/泡泡/反磁的残留逻辑（可能 Boat.js 或 NetClient 里还有）

### P2 — 其他
5. 黑屏守卫的日志改成调试开关（`localStorage.setItem('rapids-debug', '1')` 控制），线上默认不输出
6. 如果黑屏守卫的采样阈值仍不准，调参数或扩展采样点

---

## 八、关键文件修改索引（便于 diff）

| 文件 | 本次主要改动 |
|------|-------------|
| `src/game/Game.js` | +2 常量 VIEW_SIZE/BLACK_PROBE；+3 方法 #resetViewport/#guardCanvasSize/#checkBlackFrame；#loop 渲染循环插 3 行 |
| `src/game/Items.js` | ItemBoxField 重做；ITEM_DEFS 改 6 个道具 switch 分支；+voidWorld |
| `src/game/Boat.js` | +5 状态计时器；+#ensureShameMark() |
| `src/game/Effects.js` | ink 特效 URL 还原（undo 之前的 distortion 替换） |
| `src/game/Water.js` | 水面调色回到中档 |
| `src/game/BoatWeapons.js` | 对应新道具的发射逻辑 |
| `src/ui/ui.js` | 墨鱼喷墨遮罩透明度/底色/窗口大小 |
| `tests/gameplay.test.mjs` | 删临时断言块 |
| `server/server.js` | RELAY_TYPES 白名单 |

---

## 九、构建与环境注意事项

- **Windows PowerShell 5**：不支持 `&&` 和 `||`，命令间用 `;` 分隔；脚本执行策略默认阻止 `.ps1`，用 `.cmd` 版本（`npm.cmd`）
- `node_modules/.tmp/` 下有很多之前诊断时用的临时 `.mjs` 脚本，不影响构建，可以删
- `_backup/20261027-222804/` 是快照，存的是之前版本的 package.json / vite.config.js / index.html
- `public/` 和 `dist/` 里的模型文件（.glb）是一样的，Vite build 从 public 复制过来
- Effekseer WASM 必须放在 `public/effekseer/` 下，因为运行时要 fetch `effekseer.wasm`

---

## 十、新开窗口建议的第一步

1. 读这份 `DEV_STATUS.md`（就是你现在读的）
2. 如果要改黑屏 → 看 `src/game/Game.js` 里那 3 个新方法
3. 如果要改道具 → 看 `src/game/Items.js`（ITEM_DEFS / ItemBoxField）+ `src/game/Boat.js`（状态计时器）
4. 如果要改水面 → `src/game/Water.js` 的 uniform 调整
5. 改完跑 `npm test`（纯逻辑）+ `npm run build`（构建），都过了再开 dev server 实机看

---

## 十一、本轮改动：峡谷岩岛重构 + HUD 改版（2026-10-29）

### 1. 峡谷激流岩岛（只影响 `mapId === 'canyon'`）

| 项 | 实现 |
|----|------|
| 岩体材质 | `MeshStandardMaterial`，青灰 `#a9b5b0` / 次层 `#94a19d`，roughness 0.86/0.9，metalness 0，`flatShading` |
| 草坡 | `#5e9b6a`，roughness 1.0，只盖顶面（面法线朝上 + 高度阈值，小石头不长草） |
| 浸水岩圈 | `#5b6b70`，roughness 0.45，metalness 0.04，`envMapIntensity` 0.7（湿面反光） |
| 贴图 | `getCanyonRockTexture()` 程序化 256² 青灰颗粒 + 层理缝，近白底（乘 color），九宫格平铺无接缝 |
| 环境反射 | 岩石 `envMapIntensity` 0.5 / 0.45 / 0.35 / 0.7（低强度，卡通风） |
| 几何 | `buildCanyonBoulder()` 二十面体 + 顶点抖动 ±0.11、顶面压平，按面朝向/高度分桶写进 rockA/rockB/grass/wet 四材质 → 天然分块着色 |
| 阴影 | 峡谷 `renderer.shadowMap.enabled` + `PCFSoftShadowMap`，方向光 1024 图、±300 正交框、bias -0.0005、normalBias 0.06、radius 2.5 |
| 水面接触阴影 | `buildShoreShadowCanvas()` 把每个岩体 footprint 烘成 512² 径向环遮罩；`Water` shader 里按世界 XZ 采样、`col *= 1 - shore * uShoreStrength(0.85)`。**不用透明贴片**：水面是不透明网格（depthWrite），低机位贴片必被深度吃掉 |
| 色调 | 峡谷雾 `#bfcbc4`、阳光 `#fff2dd`；岩体全部青灰绿系，无暖棕 `#A07040` |

非峡谷地图的礁石保持原样（`#7d7468` 十二面体），Boss 战场不启用阴影与遮罩。

### 2. HUD（全部竞速 / 道具地图生效，Boss 模式不显示这些板块）

- **顶部**：`#hud-lap`（🏁 圈数）与 `#hud-time`（⏱️ 时间）做成绿色胶囊 `.hud-chip`，Boss 模式回退成原深蓝小牌
- **左侧**：`#hud-rank` 名次板＝奖牌（🥇🥈🥉，其余数字牌）+ `第 N 名` + 玩家名，`d.rank` 每帧驱动，排名变化实时更新
- **右下**：`.speedo` 半圆仪表盘（SVG `viewBox 0 0 200 112`：外圈/深蓝半透明底/11 根刻度/红区）+ 橘色指针，角度 `-90°`→`+90°` 映射 `0~maxSpeed`（`maxSpeed = def.maxSpeed * 3.6 * 1.15`），惯性 `1 - exp(-dt*9)`
- **氮气条** `#nitro-wrap` 在仪表盘上方：`width` 由 `nitroCharge` 驱动（不再用 scaleX），满格 `.full` 整条高亮，`nitroAllowed=false`（道具模式）自动隐藏（本条已由第十八节改版取代：底部彩虹条移除，统一到右上角双槽面板）
- **操作提示** `.speedo-hint` 压在最下面一行小字

### 3. 验证脚本与测试基建（顺手修正）

- `tests/visual-smoke.mjs`：改为按 URL 挑 CDP 页面目标（Edge 自带扩展的 `background_page` 会占据 `tabs[0]`）；固定 sleep 换成 `waitUntil` 轮询（菜单/艇列表/模型加载）；显式模型加载最长 45s；falcon 的 `wrapperYaw` 断言由过期的 `π/2` 改回 `0`（`boats.js` 里 `yacht.glb` 已自带船首 +Z）
- `vite.config.js`：`server.watch.ignored = ['**/.tmp_browser/**']`，否则无头浏览器的 Cookies/Sessions 被锁会让 dev server EBUSY 崩掉，把 visual 测试打断

---

## 十二、本轮改动：旗门恢复 + 岸边去沙色 + 道具质感（2026-10-30）

### 1. 起点旗门恢复（`src/game/Track.js`）
- 旗门重新回到 0 号门本体（此前被放到两门中点，导致顺赛道"躺平"）：`#poseForProp` 里 `kind === 'flag' && gate === 0` 时直接用 `gates[0]` 坐标 + 门法线朝向
- `holder.rotation.y = prop.dir` 保持原样（试过 `+π/2` 会让门变成侧向柱+横幅，已回滚）
- 旗门宽度精确对齐起点线：`(gateWidth*2 + 1.5) / lateral`，两腿落在赛道两侧
- 多图复核：湖泊 / 碧海 / 潮汐 / 龙宫 / 峡谷起点均为"左右立柱 + 顶部门旗横跨赛道"

### 2. 去掉"沙滩式"米色岸带
- `makeShoreProfile()` 8 环剖面全部改为湿石→草坡→岸顶→外坡的青绿/岩灰，无浅米色
- 树木/石头落地高度统一走 `shoreHeightAt()`（与地形同一剖面，不悬空）
- `#buildIslands()` 改为岩壁 + 草顶 + 灌木/芦苇/苔藓礁石，不再有沙色岛环
- 碧海分支只保留红白浮标，不铺岸带

### 3. 道具质感（建议 1 / 2 / 4 / 6）
| 项 | 实现 |
|----|------|
| ① 烘焙 AO | `bakePropAO()`：每个子网格底部 35% 顶点色 0.5→1，扁平件跳过（防整片压黑） |
| ② 统一材质规范 | `PROP_MAT_RULES` + `normalizePropMaterial()`：金属 / 浮筒 / 石座 / 布料 / 框架 / 漆面六类，统一 roughness / metalness / envMapIntensity；发光件只压粗糙度 |
| ④ 树木变体 | `addPineTree()` 三层锥逐层随机偏移/缩放/换叶色；`addBroadTree()` 2–3 团抖动多面体树冠；`addShoreBush()` / `addReeds()` 岸边贴地小件 |
| ⑥ 接触细节 | `#buildPropContacts()`：立柱/底座脚下柔和暗部 + 循环扩散涟漪贴片，每帧贴 `waveHeight`；水下道具跳过 |

### 4. 验证
- `npm test` 通过；`npm run build` 通过（49 modules）
- 验收截图归档在 `shots/round4-*.png`（湖泊起点/湖岸/碧海起点/潮汐起点/龙宫潜行/峡谷）

---

## 十三、高/中画质黑屏闪屏修复（2026-10-30）

### 症状
高画质开局、冲线后各出现一次持续数秒的"黑屏 + 闪屏"，过一会儿自行恢复；低画质完全正常。

### 根因（代码问题，不是显卡坏）
1. **动态分辨率放大器**：`PostFx.#adapt()` 每 1.6s 按帧时调 `setPixelRatio` + `setSize` + `composer.setPixelRatio`，
   连带 `#disposeComposer()` 重建两张全屏 RT 和泛光 mip 链。Windows/ANGLE 下运行中反复重建交换链
   缓冲 = 整帧闪黑。帧时在 45~51fps 抖动时还会一升一降来回切，正好对应"闪一会儿又好了"。
2. **初始像素比过高**：`Game` 先 `setPixelRatio(1.5)`，`PostFx` 再按档位设一次，开局就多重建一次缓冲；
   高画质 1.5×DPR 的内部分辨率对核显/独显都很吃力，加上着色器首次编译的卡顿容易触发驱动重置（TDR）。
3. **没有上下文丢失兜底**：TDR 后不重建 RenderTarget，继续用旧实例就整屏黑。
4. **着色器首帧编译**：开局/冲线时新材质（岸边、道具、领奖台）在主线程同步编译，卡住整帧。

### 修复
| 位置 | 改动 |
|------|------|
| `PostFx.js` | 删除动态分辨率与 `#adapt()`；`high` 像素比 1.5→1.25，`medium` 1.25→1.0；只有像素比真的变了才 `setSize`；新增 `rebuild()` 供上下文恢复后重建合成器 |
| `Game.js` | 构造时不再自设像素比（交给 `PostFx`）；`window.__game` 之外新增 `webglcontextlost`/`webglcontextrestored` 监听（`preventDefault` + 自动降档 + 重建）；`compileAsync()` 倒计时阶段异步预热着色器；`#watchPerf()` 连续 12s 低于 30fps 才一次性降一档（最多两次，玩家手动选画质后停用） |
| `Game.js` | 画质切换抽出 `#applyQuality()`，`#bindQualityToggle()` 同步按钮文案 |

### 验证
- 无头 Edge 采样 40s：高画质缓冲恒为 1348×707@1.25、中画质 1079×566@1.0，`composer` 尺寸全程不变，无上下文丢失
- 画质按钮高→中→低→高循环正常；主动 `loseContext()` 2s 后恢复，画质自动降到中、合成器重建成功、画面恢复
- `npm test` 通过；`npm run build` 通过

## 十四、本轮改动：暴风雪天空 / 水面 / 雪系统重做（2026-10-30）

### 问题（用户给的对照表）
乌云黑灰发闷、色温偏暖灰、光线太平、雪量太少、水面灰青偏浊。

### 参数改动（按用户给的冬季规范）
| 文件 | 改动 |
|------|------|
| `RealSky.SKY_PRESETS.blizzard` | `turbidity 12`、`rayleigh 0.6`、`mie 0.018`、`exposure 0.54`、`overcast 0.86`、`cloudLight 0xf6fafd` / `cloudShadow 0x9db2c4`（云亮而弥散，暗部是冷灰蓝不是黑）、`sunDisc 3`（太阳糊进雪云）、`top 0xc9daea` |
| `maps.WEATHERS.blizzard` | 水面压成冷蓝灰（`waterColor 0x5c8095` / `waterDeep 0x224055` / `waterCrest 0xeef8ff`）；太阳压到近地平线 `sunIntensity 0.5`；天光给足 `hemiIntensity 1.18` + `hemiSky 0xdfeaf5` / `hemiGround 0x64798c`（受光面冷白、背光面冷蓝）；雾 `0xdfeaf2 @ 0.0066` |
| `PostFx` | 新增天气调色 `WEATHER_GRADES`：暴雪关掉青橙分离（`uSplit 0`）、饱和 0.78、叠一层冷白气候色 `uClimateAmt 0.3`；`Game` 构造与 `setWeather` 都调用 `post.setWeather` |
| `Environment` | `hemiLight.color/groundColor` 由天气指定；雪融贴片/雪粒的可见性随 `w.snow` |

### 雪系统
- 三层 `Points`（近 1.4 万 / 中 2.6 万 / 远 2.6 万），层间风速 9 / 12 / 15 m/s，叠加阵风让雪“横飞 + 打旋”；
  近层以相机为圆心做 5m 安全圈（防止点大小透视放大后变成糊脸白斑），三层都按相机 20m 网格吸附并循环回绕，永远铺满视野
- 专用雪片贴图（核心实、边缘柔，不是雨点那张柔光斑）
- 水面雪融：520 个 `InstancedMesh` 白色雪泥片（磨边噪声贴图、`y=0.6` 压住浪尖），4~92m 环带重生、前 12% 长出 / 62% 后缩没、随风缓流漂移

### 冬季上妆（不留夏天的绿）
- 岸边植被材质：去饱和 → 掺冷白（暴雪时生效，其它天气按存下的原色复原）
- 岸带顶点色：绿草坡换成“靠水湿冷灰 → 坡顶积雪白”
- 峡谷岩块按材质桶替换（`CANYON_WINTER`：草坡 → 积雪白，岩面 → 冷灰蓝）
- 远山：暴雪时重烘焙顶点色为“亮度灰 → 冷白”，其它天气还原烘焙原色
- 浮冰色 `0xb3d2e2 → 0xd8e9f3`（更白的碎浮冰）
- 水下（`setUnderwater`）同步隐藏雪与雪融

### 验证
- `tests/blizzard_visual.mjs`：无头 Edge 跑 canyon / lake / ocean / palace / tide 五张图，断言 `turbidity 10~14`、`rayleigh 0.5~0.7`、`mie 0.015~0.02`、三层雪可见、雪融 ≥100 且可见、`hemi ≥ 1`、`sun ≤ 0.7`，输出 `shots/blizzard/<map>-blizzard.png`
- 晴天回归：`MAP=lake WEATHER=day` 截图确认岸边仍是绿草、水面仍是夏日青蓝，冬季上妆完全复原
- `npm test` 通过；`npm run build` 通过

## 十五、本轮改动：暴雪雪山覆雪 / 冰石材质 / 名次序数（2026-10-30）

参考图（冰山海峡）：远山是白顶 + 冷灰蓝岩面的雪山，近景岩块是“白顶 + 冰蓝侧面 + 分面阴影”；名次板按 `1st / 2nd / 3rd` 排行。

### 1. 远山不再“灰绿岩石大片裸露”
| 位置 | 改动 |
|------|------|
| `Environment.getSnowRockTexture()` | 新增暴雪雪山贴图：近白底 `#fbfdfe` + 冷灰蓝雪堆/雪脊/细颗粒 + 极少量岩缝，`RepeatWrapping` |
| `Environment.#syncMountainLight()` | 暴雪时把远山 `material.map` 从 `getRockGrassTexture()`（带绿色植被斑）换成上面这张；原贴图存 `userData.baseMap`，切回其它天气复原 |
| `Environment.#bakeMountainSnow()` | 一次性重烘焙顶点色：`snow = (0.5+0.5·朝上) × (0.72+0.38·高度比)`，朝上坡面全盖雪、越高越白，陡壁/背阴留约 30% 冷灰蓝岩面；用原亮度做明暗，避免整座山摊成白板 |

根因：白色顶点色是“乘”在贴图上的，`rockGrass` 贴图里的绿斑乘上去就是灰绿霉斑，光提亮顶点色无效。

### 2. 暴风雪岩石对齐参考图
- `SHORE_WINTER`（岸边礁石）：`rockA 0xbfd6e4` / `rockB 0x9dbccd` / `wet 0x6a8494`
- `CANYON_WINTER`（峡谷岩块，可按 `userData.baseColor/baseRough/baseEnv` 复原）：
  - `grass`（顶面桶）→ `0xf4fbff` 积雪白、`roughness 0.95`、`env 0.26`
  - `rockA` → `0xb6d1e2`（浅冰蓝受光面）、`rockB` → `0x8cb0c7`（深冰蓝侧面）
  - `wet`（浸水圈）→ `0x5b7b91`、`roughness 0.42`
  - 两个岩面桶刻意差半个色阶：暴雪是弥散光，等亮度的浅色会把面片明暗差吃掉，靠色差补回分面阴影

### 3. 名次序数
- `ui.js`：删掉 emoji 奖牌，新增 `ordinal(n)`（`11th~13th` 是特例，不能按个位判断），徽章文本改成 `1st / 2nd / 3rd …`
- `index.html`：`.rank-medal` 由 32px 圆形改成 `min-width 34px / height 22px` 胶囊，`.rank-medal.plain`（第 4 名以后）走冷白描边样式

### 验证
- `tests/blizzard_visual.mjs` 五图（canyon / lake / ocean / palace / tide）重出并 PASS：远山整体覆白、峡谷岩块白顶冰蓝分面、名次板显示 `1st / 2nd / 3rd`
- `npm test` 通过；`npm run build` 通过（1,098.79 kB / gzip 326.83 kB）

## 十六、本轮改动：单人怪物模式直选关卡 + AI 陪练协同（2026-10-30）

### 1. 单人练习的怪物模式可以直选关卡
| 位置 | 改动 |
|------|------|
| `index.html` | 选图面板新增 `#boss-stage-wrap`（`#boss-stage` 下拉），默认 `hidden` |
| `main.js` | `soloBossStage`；进入选图时用 `BOSS_LEVELS` 填充下拉；`applyBossMapUI()` 只在「单人 + 怪物模式」显示关卡下拉，联机模式不显示（仍按原流程从第一关打起） |
| `Game.js` | `this.bossStage = clamp(startMsg.stage || 1)`，关卡天气取 `BOSS_LEVELS[bossStage-1].weather`；`BossThemes.setTheme(this.bossStage)`、`BossMode({ stage })` 都改用这个值 |
| `BossMode.js` | `startStage(opts.stage || 1)` 作为进场关；后续过关仍按 `nextStage` 顺序推进 |

### 2. 怪物模式加入 AI 陪练（走位 + 开炮）
- `main.js`：`startSoloRace` 不再在怪物模式强行把 AI 数量清零，AI 陪练下拉在单人模式下始终可用
- `BossMode.driveAi(dt, boat, id)`：绕 BOSS 走位——径向“远了贴上去 / 近了拉开”（目标半径 18~28m，按进场顺序错开）、切向绕圈并带节奏摆动；用 `worldX/worldZ/worldMag` 世界方向驱动（和玩家同一套手感）
- `BossMode.#makeWeapons(ownerId)`：玩家与 AI 共用一套主炮弹道，`onHit` 带上 `owner` 归属
- `BossMode.#updateAiWeapons(dt)`：**仅权威端执行**（`isHost`），AI 存活且距 BOSS < 56m 时自动开火
- `#dealBossDamage(..., { owner })`：AI 伤害计入各自的 `damageByPlayer` 与仇恨表，不再算到玩家头上（弱侧输出会正常拉到 BOSS 仇恨）

### 3. 验证
- 临时 CDP 探针（第 4 关 + 2 AI / 第 3 关 + 3 AI）：
  - 进场直接是所选关卡（stage 4「暗夜血魔·终焉」、stage 3「雷霆龙骑士」），主题/天气随关卡切换
  - HUD 队伍列表出现 `电脑1(AI)…`，`aiWeapons` 数量与 AI 数量一致
  - 战斗中 AI 绕到 20~28m 区间、速度 15~20、各家伤害独立记账（第 4 关 6s 内 2 只 AI 合计 1,367 伤害）
  - 修正过一次径向符号错误：原来 `d > 半径` 反而往外走，AI 会被边界夹在 89.5m 外
- `npm test` 通过；`npm run build` 通过（1,100.57 kB / gzip 327.43 kB）
- 截图：`shots/boss/stage4-ai2.png`、`shots/boss/stage3-ai3.png`

## 十七、本轮改动：新增「璀璨星空」天气（2026-10-30）

参考图：深蓝夜空 + 斜贯画面的银河 + 随机流星 + 水面碎星倒影，低配笔记本也要跑得动。

### 1. 天气入口
| 位置 | 改动 |
|------|------|
| `src/data/maps.js` | `WEATHERS` 新增 `starry`（名称「璀璨星空」、`stars: 1`）：夜天色 `skyTop 0x070d22 / skyBottom 0x2b3f68`、雾 `0x171c36 @0.0026`、冷白月光 `sunColor 0xbfd2ff @0.22`、暗蓝半球光 `0x35497a / 0x0a1224 @0.34`；水色 `#193056 / #060b1c / #7fa8d8`、浪高 0.85 |
| `src/game/RealSky.js` | `SKY_PRESETS.starry`：`exposure 0.22`、`rayleigh 2.6`、`nightMix 0.8`（新增 `nightColor` 预设，星空直接混入夜色，白天/昼夜循环仍从 0 开始）、`uHorizonColor 0x4c67a2`、无太阳盘/无日晕、云量 0.05 |
| `src/game/PostFx.js` | `WEATHER_GRADES.starry`：关青橙分离、`saturation 1.04`、冷蓝气候色 `0x35477f @0.1`、暗角 0.38 |
| `src/game/SceneDressing.js` | `nightish` 包含 `starry`（光柱关闭、海鸥压暗、PMREM 环境贴图强度 0.25） |
| `src/game/Environment.js` | `#syncMountainLight()`：远山 dim `0.12` + 冷蓝 tint（`0.55/0.7/1.15`），夜里是暗蓝剪影而不是灰亮山 |

### 2. `src/game/NightSky.js`（新模块，单帧约 10 次 draw call）
- **三层星星**：`bright 80 / mid 8000 / dim 5200` 个 `Points`，共享一套着色器；每颗星带 `aPhase` 独立正弦闪烁，中心亮核 + 外圈柔光（`smoothstep + pow`），颜色白为主、少量淡蓝/淡黄/淡紫；点尺寸 11 / 3.8 / 2.4 物理像素
- **银河**：`band` 3600 颗沿“以开局镜头前方为原点、向屏幕右上抬 0.35 拉长的窄带”撒点（高斯横向散开）；`nebula` 是沿同一条带弯曲的 48 段带状网格 + 程序化冷蓝紫渐变贴图（additive、`fog:false`），高画质 `opacity 0.16`。**朝向按开局相机方向反推**，所以每条赛道都能看到银河斜贯画面（早期版本用固定世界方向，多数地图银河落在镜头背后）
- **流星**：对象池 4 条，`4~9s` 随机触发，头部亮点 + 横向渐变尾迹（`PlaneGeometry` 每帧按运动方向与朝向相机重建基矩阵），`1.6~2.1s` 淡出；触发方位偏向前方天空
- **星尘**：150 个淡蓝微光 `Points` 在镜头周围 130m 盒子里缓慢漂浮（CPU 每帧只改 position 数组）
- **水面星点**：460 个屏幕空间点精灵（自定义着色器按距离缩放、横向略拉长），世界坐标挂在独立 `glintsRoot` 上；早先的“平铺长条面片”在 4m 低机位下只有 1~2 像素还会被浪挡住，等于没画
- **画质档位**：high / medium / low 分别 `80/8000/5200/3600/0.16/150/4`、`56/4200/2800/1900/0.12/100/3`、`28/700/500/700/0.06/60/2（间隔 8~15s，水面星点 0）`；`setQuality` 走 `#rebuild`
- 星星组跟随相机（半径 1800，`depthTest` 保留，山体照常遮挡）；`setVisible` 同时开关 `glintsRoot`（否则切回白天水面还留着星点）

### 3. 验证
- 临时 CDP 探针（`MAP=lake WEATHER=starry`）：五层 `Points` count 与尺寸正确、流星池 4 条、银河投影从左下(-1.15) 到右上(1.32) 斜贯画面、水面星点 `PointScale 715` 且在世界坐标
- 低画质实测：`bright 28 / mid 700 / dim 500 / band 700 / dust 60 / meteors 2 / nebula 0.06 / glints 0`；切回 `sunny` 后 `glintsRoot.visible = false`
- `tests/blizzard_visual.mjs`（`WEATHER=starry`）五图 canyon / lake / ocean / palace / tide 各出一张：`shots/blizzard/*-starry.png`
- `npm test` 通过；`npm run build` 通过

### 4. 试玩反馈修复（同日）
- **水面太暗、没有星点倒影**：`maps.js` 的 starry 水色/光照整体提亮（`waterColor 0x2a4a78 / waterDeep 0x0b1930 / waterCrest 0xa4c8ee`、`sunIntensity 0.3`、`hemiIntensity 0.5`）；`NightSky` 水面星点加量到 `glints 1400 / 900 / 0`（高/中/低），点精灵抬到 `y 1.5~3.1`（高于浪峰）、铺开半径 330m，并加 440m 方形循环回卷——开多远周围都有星点，不再只在原点附近
- **天空没有流星**：`#spawnMeteor` 方位从固定世界 -Z 改为按开局镜头前方 ±60° 播撒；`meteorTimer` 初值 1.2s（进场很快就来第一颗）、间隔缩到 `4~8s`（中 6~10 / 低 8~15），面片放大到 `320×15`
- **暴风雪雪量过重**：`Environment.#buildSnow` 三档 SPECS 从 `14000 / 26000 / 26000` 降到 `10500 / 19500 / 19500`（正好 3/4），尺寸/透明度/风速不变
- **冰汐海峡起点被逆流推走**：`current` 水域从 `(x:-159, z:23, r:122)` 移到赛道中段 `(x:-161, z:0, r:95)`——起点门 `(-153,119)` 距圆心 121m > 95，不再覆盖发车区；`Game.#applyCurrent` 增加 `phase !== 'racing'` 门，倒计时与冲线后都不再给船加水流的位移
- **验证**：tide 倒计时期间两次采样位移 `0m`、`distToCurrent 121m`；starry 15s 轮询流星 `dot 0.86~0.89`（全部在镜头视野内）、`glints 1400` 挂在 Scene 世界坐标；`tests/blizzard_visual.mjs` 暴雪图 `snowLayers 10500/19500/19500` 且 PASS；`npm test` 通过

## 十八、本轮改动：氮气面板改版 + 近道浮桶 + 碧海近道去交叉（2026-10-30）

### 1. 右上角氮气面板（`index.html` / `src/ui/ui.js`）
- 移除底部彩虹条 `#nitro-wrap`（连同 `.nitro-orb` / `.nitro-track` / `#nitro-fill` 样式与移动端规则），氮气信息统一到右上角 `#nitro-stock`
- 新面板：扁平深蓝渐变圆角框（`border-radius 14px`、`1px rgba(176,222,255,.6)` 浅蓝白描边、内高光）；两格 30×44 槽位，白描边常驻、半透明深色底、内阴影常驻
- 槽位逻辑：`packed` = 已存一瓶，槽内显示青蓝氮气罐（22×33）+ 白色小闪电 SVG；`charging` = 当前集气槽，`.nitro-slot-fill` 高度 = `nitroCharge`；空槽只留边框。`boostState === 'active'` 面板转金色高亮，BOSS 模式整块隐藏
- 面板实测 `x1268 / w87`（right:24、top:18），与右侧“画质 高”按钮（right:124）留 15px 间距；移动端 `scale(.9)`
- `tests/visual-smoke.mjs` 氮气断言同步到新 DOM：`stockVisible / slot0Packed / slot1Charging / fill 58.0%`

### 2. 近道两侧浮桶（`src/game/Track.js` `#buildEdgeBuoys`）
- 每条 `shortcuts` 两侧补浮桶：偏移 `sc.width + 1.0`、间距 11m、两端各留 6m；候选点自身到主道中线 < `gateWidth + 1.6` 的直接丢弃，浮桶不会压进主道航路
- 浮绳从“按 side 全图过滤”改为按“连续线”分组（主道 2 条 + 每条近道 2 条），避免近道浮桶与主道浮桶跨水连绳；`setBuoyPalette` 换天气重建时自动带上近道浮桶
- 各图近道浮桶数（两侧）：canyon `8/7`、lake `12/12`、ocean 5→9 `15/15` + 11→14 `12/8`、palace `16/16`、tide 11→14 `10/9` + 8→10 `5/4`

### 3. 碧海争锋近道去交叉（`src/data/maps.js`）
- 原 ② `#8→#14` 与 ① `#5→9` 在 `(-157.6, 24)` 相交；改为南岸内弧 `#11→#14`：points `[[-129.3,-70.5],[-105,-80],[-70,-92],[-30,-110],[10,-130],[40.1,-148]]`
- 新近道长 186.7m vs 主道 200.5m（省 6.9%），与 `#5→9` 线段相交计数 0；仍止于隧道口 `#15` 之前，弹射链（3→7）与隧道（15→17）断言均通过

### 4. 验证
- `npm test` PASS；`npm run build` PASS（50 modules，`dist/index.html 61.74 kB`）
- 无头 Edge 探针（ocean / 晴天）：该局 `edgeBuoys.stations` 230 颗，距 11→14 近道 8m 内 27 颗、5→9 近道 8m 内 32 颗；`sc0 × sc1` 相交 0
- 同一探针截取氮气面板近景：两槽白描边常驻、左槽氮气罐+闪电、右槽 58% 青色填充，`slot0Packed / slot1Charging` 均为 true

## 十九、本轮改动：氮气 UI 语义纠正 + BOSS 第 3-4 关追击/雪花/节奏（2026-10-30）

### 1. 氮气 UI 语义纠正（回改第十八节的理解偏差）
- 右下角彩虹集气条 `#nitro-wrap` 恢复（`.nitro-orb` / `.nitro-track` / `#nitro-fill` 与移动端规则一起回来）：只由 `nitroCharge` 驱动填充宽度，集满加 `.full` 高亮
- 右上 `#nitro-stock` 不再当“集气进度”用，改成纯氮气包计数：两格 `.nitro-slot` 白描边常驻，`index < nitroBottles` 才点亮 `.packed`（右下条每集满一次加一格，最多两格）；面板里没有 `.nitro-slot-fill`
- `tests/visual-smoke.mjs`：断言恢复为 `barVisible` + 集气条宽度 + `packedSlots 1`；宽度改按数值比较（CSSOM 会把 `58.0%` 序列化成 `58%`，原字符串断言必挂）

### 2. BOSS 第 3-4 关整体追击
| 位置 | 改动 |
|------|------|
| `src/data/bosses.js` | 新增 `BOSS_PACE` + `getBossPace(stage)`：第 3 关 `move / speedScale 0.85 / cooldownScale 1.28 / telegraphScale 1.15`；第 4 关 `move / 1.1 / 0.9 / 0.55`；第 1-2 关不配（保持站桩节奏） |
| `BossMode.#beginFight` | `boss.anchor = !pace.move` → 3-4 关开打即整体追击（不再是只有血量掉到 1/3 才解禁） |
| `Boss.update` 追击停距 | `keep = radius + (pace.move ? 10 : 9)`，3-4 关停在 `≈14.6m`（对齐本关通道近端 `BOSS_LANE.near 14`），正好贴到赛艇面前放技能，又不会一直顶人 |
| `BossMode.startStage` | 写入 `telegraphScale / cooldownScale / speedScale`；另外单独存 `bossBaseSpeed`——`#updateStatusTimers` 每帧按减速道具覆写 `speedScale`，直接用 0.85 当基准会被冲掉 |
| `Boss.#beginTelegraph` / `#beginPhaseBlast` / `BossMode.#showThunderWarn` | 预警时长统一乘 `telegraphScale`，联网 `bossCast.dur` 同步 → 第四关红圈约 1.0s 就结算（1.9s 技能 → 1.045s），第三关 2.5s 给足反应 |

### 3. 第 3-4 关雪花特效
- `bosses.js`：`knight_thunder` / `blood_nightmare` 加 `fxTheme: 'ice'`（两条龙仍是 `fire`）
- `Boss.#buildEmbers`：冰主题改白蓝雪花（`0xd2efff`、`size 1.05`、`opacity 0.85`），速度 `sp<0` 自上而下、飞出顶部回收——不再是围着 BOSS 往上飘的橙色火星
- `BossMode.#playSkillVisual`：冰主题技能统一改 `ice`（`thunder` 保留闪电）：蓄力 `cone('ice')`（cloud 贴图）、锥形/冲锋命中末端补 `frost()` 雪雾，蓄力时长也按 `telegraphScale`

### 4. 其它
- `vite.config.js`：`server.host = '127.0.0.1'`。Windows 上只写 `localhost` 可能只监听 `::1`，无头探针固定访问 `127.0.0.1` 会打不开页面（visual 测试前两次超时的根因）

### 5. 验证
- `npm test` PASS（新增 `BOSS_PACE` 节奏断言与 3-4 关 `fxTheme==='ice'` 断言）
- `npm run build` PASS（1,117.11 kB / gzip 332.71 kB）
- 第三关 CDP 探针：`anchor=false`、`speedScale 0.85`、`telegraphScale 1.15`、`fxTheme ice`、雪花 `sp<0`；BOSS 从 37.4m 追到 17.4m（`state=chase`）
- 第四关 CDP 探针：`telegraphScale 0.55`、`cooldownScale 0.9`、从 35.5m 追到 16.9m；放技能时预警 `1.9s → 1.045s`
- 两关放技能瞬间 `skillFx.streams` 均有 1 条 `ice` 雪流
- 氮气 HUD CDP 探针：`barVisible / stockVisible` 均 true、集气条 `58%`、1 格 `packed`；把 `nitroCharge` 拉满 + `nitroBottles=2` 后两格点亮且 `#nitro-wrap.full`
- 备注：`npm run test:visual` 在本机无头 Edge（swiftshader 软件光栅）下本次卡在龙宫场景的后续断言段（页面 CDP 不再响应），因此氮气与 BOSS 行为改用两个短探针直接覆盖，探针跑完已删

## 二十、本轮改动：暴风雪雪量再降 + 星空水面荧光收敛（2026-10-30）

### 1. 暴风雪雪量（`Environment.#buildSnow`）
- 三层粒子 `10500 / 19500 / 19500` → `300 / 480 / 480`（合计 1260，量感对齐暴雨的 900 条雨丝）
- 每层的尺寸、透明度、风速、回落规则都不动，只把数量砍下来：航道不再被白噪点糊住，仍能看出雪在横飞

### 2. 星空水面星点（`NightSky.js`）
- 数量：高/中/低 `1400 / 900 / 0` → `200 / 140 / 0`
- 播撒范围：半径 `330m` → `85m`（只撒赛艇周围的近水），高度 `1.5~3.1` → `1.2~2.1`（贴水面一点，不再像悬空的荧光）
- 点尺寸：世界 `0.45~1.4m` → `0.3~0.8m`，屏幕 clamp `2~26px` → `1.5~13px`
- 片元透明度乘 `0.55`，并新增**距离淡出**（`85m` 外完全消失）——远处水面不再连成一条白点荧光带，只在船附近泛几点星光
- 回卷方块 `440m` → `200m`（±100m）：船跑到哪，周围近水都有零星星光；回卷发生在淡出区外，看不出跳变

### 3. 验证
- 无头探针（canyon / 璀璨星空 / 船在跑）：`glints` 200 颗、距镜头最远 123m（方块角落）、高度 1.2~2.1；截图里水面只剩零星几点，无带状荧光
- 同一探针切暴风雪：`snowLayers = 300 / 480 / 480（1260）`，雪花明显变稀、航道清晰
- `npm test` PASS；`npm run build` PASS（1,117.30 kB / gzip 332.86 kB）

## 二十一、本轮改动：第三关龙骑士骨骼动画接入 + 雪片特效重做（2026-10-30）

### 1. 上传 GLB 读取结论
- 5 个文件都是同一副骨架：85 根 joint，`skins[0].joints` 的名称与顺序同 `dragonknight.glb` 完全一致，可共用一套 `AnimationMixer`
- clip 名对照：`dk_idle → Armature_Stand_full`、`dk_walk → Armature_Walk_full`、`dk_attack → Armature_Attack_full`、`dk_roar → Armature_Taunt_full`（本体 GLB 里 10 个 clip 已含前四个），只有 `dk_run`（255 通道）是本体没有的新循环
- 因此只新增 `public/monsters/dk_run.glb`，其余四个不重复入库

### 2. 动画语义（`src/data/bosses.js` → `knight_thunder`）
| 语义 | clip | 用途 |
|------|------|------|
| `idle` | `Armature_Stand_full` | 过场 / 倒计时 / 追到停距后站定（用户要的「刚进去静止」） |
| `move` | `Armature_Walk_full` | 贴身挪步 |
| `moveFast` | `dk_run` | 10m 外冲刺追击；`path`（冲锋）技能的出手动作 |
| `attack` / `death` | `Armature_Attack_full` | 近身平砍 |
| `cast` | `Armature_Spell A_full` | 落雷 |
| `breath` | `Armature_Taunt_full` | 仰头张口咆哮 = 口吐雪花 |
| `aoe` | `Armature_Taunt_full` | 阶段转换大招 |
- 新增 `clipModels: ['/monsters/dk_run.glb']`：`Boss` 构造函数把模型和额外动画包一起 `Promise.all` 加载，`#setupModel` 里把额外 clip 直接挂到同一个 mixer（`this.actions[clip.name]`），模型本体仍用 `dragonknight.glb`

### 3. 出手动作不再被瞬间打断（`src/game/Boss.js`）
- 新增 `this.animHold`：`#resolveSkill` 结算冰系扇形技能时置 `0.95`（正好一个伤害窗口），让「张嘴 → 雪花持续喷出」在同一段动画里完成；否则雪花刚出现就闭嘴回待机
- `update` 每帧递减；`anchor` 分支与追击分支的动画切换都加 `animHold <= 0` 守卫，保持当前出手姿势
- 新增 `#skillAnim(skill)`：`cone` 且定义了 `breath` → `breath`；`path` 且定义了 `moveFast` → `moveFast`；其余按 `skill.anim`，兜底 `cast`。客户端 `showWarning` 与主机 `#beginTelegraph` 共用

### 4. 雪花特效重做（`src/game/SkillFx.js`）
「一片雾」的三条根因逐条处理：
| 根因 | 处理 |
|------|------|
| 复用暴风雪的柔边圆点 `Cloud01`，近景放大成白团 | 本地画 64px 六角雪花（中心实心 + 6 主臂 + 两侧枝晶）→ `this.tex.snow` |
| 加法混合把白雪花叠成发光雾 | 雪片改 `NormalBlending`，火/雷/水仍 `AdditiveBlending` |
| 尺寸过大 + 越吹越大 | cone `0.62→0.34`、`grow 2.4→0.08`；`frost` 从 `2.4~5.0` 雾团改为 `0.5~0.9` 下落小雪片（60 颗、`vy` 向下）；ring `1.0~2.0→0.55~0.9`；charge `0.5~0.85→0.22~0.40` |
- 喷雪流 `rate 320`、`vy = -0.8 ~ -3.2`：雪片一出嘴就往下坠，不再是悬浮的云
- 近景收敛：`SkillFx.update(dt, camera)` 对 `tex === 'snow'` 的粒子按距离缩尺寸（`<4.5m` 等比压到最小 `0.22`），`BossMode` 两处调用改为 `skillFx.update(dt, this.camera)`——雪片糊镜头的问题按暴风雪地图的「近景安全圈」思路解决

### 5. 验证
- `npm test` PASS；`npm run build` PASS（1,123.08 kB）
- 第三关无头 CDP 探针（单人怪物模式 `#boss-stage` → 3）全链路通过：
  - `clips` 含 `dk_run`；intro 阶段位置 `(0,0)` 不变、anim `Armature_Stand_full`（进场静止）
  - `anchor=false`；36m 追击 anim `dk_run`；追到 `14.57m`（停距 14.6）后 anim `Armature_Stand_full`（站立等冷却）
  - slash 预警 `state=telegraph`、anim `Armature_Taunt_full`；结算瞬间 anim 仍为 `Armature_Taunt_full`（`animHold` 生效）
  - `skillFx.streams[0]` 为 `tex:'snow'`、`blending:1`（NormalBlending）；截图确认是粒状六角雪片而非雾团
- 未使用 Blender：MCP 插件 `up_to_date: false`（需 `uvx mcp-for-blender install-addon` 重装），且现有 5 个 clip 已覆盖 idle/run/walk/attack/roar/spell，本轮需求无需额外生成动画；后续想加新招再升级插件接入

## 二十二、本轮改动：第三关动画全量接入 + Blender 新做 4 段动作（2026-10-30）

### 1. 「只有跑步有动作」的两条根因
| 现象 | 根因 | 处理 |
|------|------|------|
| 挥砍 / 待机 / 咆哮都不动 | 本体 `dragonknight.glb` 的 10 个 clip 全是静帧（255 通道但 rotation 运动量为 0）；`#setupModel` 又用 `if (this.actions[clip.name]) continue;` 跳过上传包里的同名 clip，最后只有新名字 `dk_run` 进了 mixer | 改成 `Map` 先收本体、再用额外动画包覆盖，同名 clip 一律以带关键帧的上传版为准（[Boss.js](file:///d:/3Dgame%20-%20副本/src/game/Boss.js) `#setupModel`） |
| 挥砍被演成仰头咆哮、剑完全不动 | `#skillAnim` 只要「扇形 + 定义了 breath」就走 breath；冰霜 BOSS 的 slash 正好是扇形，于是永远播 Taunt | 只有 `skill.anim === 'flame'` 的真·喷吐技能才用 breath；`#resolveSkill` 的 `animHold` 同步改为按 `#skillAnim() === 'breath'` 判定 |

### 2. Blender 无头生成 4 段新动作
- 接入方式：MCP（9876）插件版本过旧且 GUI 连接已断，改用 `blender.exe --background --factory-startup --python scripts/build-dk-anims.py`，生成器保留在 [scripts/build-dk-anims.py](file:///d:/3Dgame%20-%20副本/scripts/build-dk-anims.py)
- 4 段动作（30fps）：

| clip | 帧数 / 时长 | 内容 |
|------|------------|------|
| `dk_smash` | 56 / 1.87s | 后仰蓄力 → 双臂举剑过头停顿 → 前压重劈（髋下沉 0.22）→ 收势回正 |
| `dk_tail` | 49 / 1.63s | 扭腰 → 反向回旋横扫（脊柱 ±52°，尾巴 4 节甩动）→ 余势 |
| `dk_cast` | 46 / 1.53s | 举剑引雷（右臂 150°）+ 仰头张口 → 落雷瞬间下压 |
| `dk_death` | 72 / 2.4s | 后仰 → 跪倒（髋 -0.75、大腿/小腿折叠）→ 扑倒（髋 -1.4）→ 保持姿势 |

- 剑的绑定：剑骨 `Bone_Sword_R_1` 挂在 `Bone_Root_72` 下、与手骨平级。整骨跟手会被甩飞，改成 `bake_sword()` 每帧把剑柄（骨骼尾端）贴到右手尾端、朝向仍由关键帧控制；导出后实测手尾-剑尾距离恒定 0.44
- 合并导出：先以 `dk_idle` 为主骨架，再导入其余 4 个包并删掉它们自带的骨架/网格，只留 action；`export_animation_mode='ACTIONS'` + `use_selection` 得到无网格动画包
- 关键坑：**导入 glTF 前必须先 `scene.render.fps = 30`**，否则 Blender 按当前帧率换算时间轴，导出时长会整体变形

### 3. 产物：`public/monsters/dk_anims.glb`（736 KB，9 段动画）
替代原先要加载 5 个 ~2MB 包的方案（省约 9 MB）。

### 4. 语义表（`knight_thunder`）
| 语义 | clip | 用在 |
|------|------|------|
| `idle` | `Armature_Stand_full` | 进场静止 / 停距站定 |
| `move` | `Armature_Stand Work_full` | 贴身挪步 |
| `moveFast` | `dk_run` | 远距离追击 / 冲锋技能 |
| `attack` | `dk_smash` | slash 横扫剑击（新重劈） |
| `tail` | `dk_tail` | sweep 尾扫冲击（新回旋） |
| `cast` | `dk_cast` | thunder 落雷（新引雷） |
| `aoe` | `Armature_Taunt_full` | phaseBlast 崩海咆哮（咆哮终于用上） |
| `breath` | `Armature_Taunt_full` | 口吐雪花 |
| `death` | `dk_death` | 倒地（新） |

- `clipModels` 收敛为 `['/monsters/dk_anims.glb']`
- 技能表新增 `sweep`（环形尾扫），让 `dk_tail` 有实际出场机会

### 5. 验证
- `npm test` PASS；`npm run build` PASS
- 无头 CDP 探针（单人怪物模式 → 第三关）逐段播放 9 个 clip，采样 `Bone_Sword_R_1` / `Bone_Arm_R_18` / 脊柱 / 头 / 髋 / 尾的最大四元数变化（度）：

| clip | 剑 | 右臂 | 脊柱 | 头 | 髋 | 尾 |
|------|----|------|------|----|----|----|
| `Armature_Stand_full` | 74.0 | 42.6 | 33.5 | 31.8 | 33.6 | 33.0 |
| `Armature_Stand Work_full` | 141.9 | 34.5 | 43.9 | 37.1 | 27.6 | 41.8 |
| `dk_run` | 141.9 | 34.5 | 43.9 | 37.1 | 27.6 | 41.8 |
| `Armature_Taunt_full` | 128.9 | 106.0 | 52.5 | 30.8 | 52.8 | 44.4 |
| `Armature_Attack_full` | 179.4 | 86.4 | 34.4 | 71.0 | 35.9 | 38.9 |
| `dk_smash` | 134.5 | 134.7 | 25.9 | 14.0 | 8.0 | 0 |
| `dk_tail` | 80.7 | 89.1 | 52.0 | 22.0 | 0 | 40.0 |
| `dk_cast` | 100.5 | 156.3 | 18.4 | 30.0 | 0 | 0 |
| `dk_death` | 75.4 | 46.0 | 48.0 | 28.0 | 44.0 | 0 |

- 探针同时确认 `def.anims` 的 10 个语义全部命中 `boss.actions`（`missing: []`）
- 实拍截图（战斗相机挪到 BOSS 正面）：`dk_smash` 蓄力帧双臂举剑过头、落点帧剑随手下压，剑始终握在手里
- 备注：`dk_run` 与 `Armature_Stand Work_full` 的采样值完全一致，说明上传的 run 包与走路包是同一段循环，跑步的“快”由 BOSS 自身移动速度体现

## 二十三、本轮改动：第四关 BOSS 技能重做（与第三关彻底差异化）（2026-10-31）

### 1. 目标
第三关（雷霆龙骑士）与第四关（暗夜血魔）技能不再雷同：第四关只保留「落雷」，
其余全部换成专属机制，且整体更难。

### 2. 技能表（`src/data/bosses.js` 的 `BOSS_SKILLS`）
| id | 名称 | 机制 | 判定 |
|----|------|------|------|
| `thunder` | 落雷 | 与第三关唯一共享 | 地面圈一次性 |
| `pull` | 深渊吸取 | 64m 内把船往 BOSS 嘴边拖 2.8s | 逐帧推 + 每 1.1s 结算 |
| `screen` | 血幕降临 | 全屏大招 | 任意两船物理接触 / 单人安全柱 |
| `blink` | 瞬影突袭 | 预警到玩家船头前方后瞬移贴脸 | 落点 130° 扇形 |
| `bloodFlame` | 血焰吐息 | 常驻喷火 | 60° / 26m 持续窗口 |
| `frostBreath` | 霜雪吐息 | 常驻喷雪花 + 减速 debuff | 70° / 24m，限速 9 m/s 3s |
| `geyser` | 裂海泉涌 | 脚下水柱 + BOSS 脚下扩散浪 | 柱一次性 + 浪逐帧 |

- `blood_nightmare.skills = ['thunder','pull','screen','blink','bloodFlame','frostBreath','geyser']`
- 删除 `slash / charge / rage` 的复用；`fxTheme` 仍是 `ice`（测试要求），但特效颜色按技能自身元素走，
  只有 `knight_thunder` 才强制冰霜（`#playSkillVisual` 的 `frostBoss` 判断）

### 3. 关键机制
- **吸取可反抗**：本机船由本机推、AI 船由主机推；开氮气完全免疫，踩油门/打方向只吸得动 30%，AI 半抵抗
- **全屏血幕**：≥2 艘活船时，任意两艘碰撞半径之和以内即全场安全；只剩一人时在场地中央（BOSS 压中心则挪到背面 30m）立「安全柱」
- **水柱浪与掩体**：浪的判定半径直接读 `SkillFx.shockwave` 返回对象的 `radius`（视觉/判定同源）；
  波前扫到船时用 `arena.blocksLine` 查礁石，挡住才安全
- **终盘**：最后 1/3 血 `rageMult = 2`、`damageScale = 基础 × 1.5`（前三关仍是 1.35 倍移速）
- **判定准确性**（解决“视觉打到却不掉血”）：所有技能计入船体支撑半径；扇形从嘴部 `radius*0.78` 出发生效；
  喷吐类统一 0.95s 持续判定窗口（0.15s 一扫、单人 0.45s 冷却）；客机不再自行结算

### 4. 特效（three.js 粒子，全部程序化）
- `SkillFx` 新增 `blood` 调色板 + `vortex`（吸取漩涡）/`pillar`（水柱）/`shockwave`（扩散浪）/`residue`（瞬移残影）
- 吸取：漩涡 + 嘴前汇聚；瞬移：起点残影 + 落点血雾 + 横扫刀风；水柱：水花柱 + 波浪前水花；血幕：全屏血浪 + 震屏/顿帧
- 未引入与赛艇重复的库存 effekseer 特效

### 5. 联机同步
- 主机权威结算并广播 `bossHit`；新增 `bossSkill`（吸取/血幕/瞬移/水柱的客机演出 + 客机本端吸取状态）
- 新增 `bossPillar`：单人幸存时安全柱在客机端也能看到

### 6. 验证
- `npm test` PASS（新增第四关差异化断言：与第三关只共享落雷、无 slash/charge/rage、血幕预警 ≥3s、霜雪带减速等）
- `npm run build` PASS
- 无头 Edge CDP 单人第四关实测：

| 项 | 结果 |
|----|------|
| 技能集合 | `thunder/pull/screen/blink/bloodFlame/frostBreath/geyser`，无第三关近战技能 |
| 吸取 | 无输入被拉近 2.25m/0.9s；开氮气位移 0.01m |
| 血幕（两船贴靠） | 100 HP（安全） |
| 血幕（两船分开） | 60 HP（−40） |
| 安全柱（站内 / 站外） | 100 / 60 HP |
| 瞬移 | BOSS 位移 28m 到玩家面前，玩家 −30 |
| 喷火（正面 / 背面） | 88 / 100 HP |
| 喷雪花 | 68.2 HP + 限速 9 m/s（2.85s） |
| 水柱 | 82 HP（−18） |
| 扩散浪（无掩体 / 礁石后） | 76 / 100 HP |
| 终盘 | `rageMult = 2`、`damageScale = 1.5` |

- 备注：Blender MCP 与本轮无关（第四关不新增模型/动画）；MCP 报错只是工具 schema 与当前模型不兼容，不影响本功能

## 二十四、本轮改动：第三关握斧修正 + 踱步动画 + 走跑节奏 + 冲锋位移（2026-10-31）

### 1. 握斧不再悬空
- 根因：`Bone_Sword_R_1` 与右手骨平级；上传的 5 段动画自带正确握持通道（斧头离掌心 0.075~0.29m），
  但 Blender 新做的几段没有，旧 `bake_sword` 把剑骨贴到手骨的静止偏移点，实测离手 0.74~1.03m
- 修复：`scripts/build-dk-anims.py` 新增 `GRIP = hand⁻¹ @ sword`（取自上传待机段第 20 帧），
  `attach_sword()` 每帧 `sword.matrix = hand.matrix @ GRIP` 重烘关键帧
- 结果：`dk_smash` 离掌心 0.80 → 0.28、`dk_tail` 1.02 → 0.28、`dk_cast` 0.28；预览渲染确认斧头握在右手
- 近战攻击语义改回上传的 `Armature_Attack_full`（用户点名的平滑挥砍），`dk_smash` 不再用于普攻

### 2. 踱步动画
- 旧问题：`move` 映射的 `Armature_Stand Work_full` 与 `dk_run` 是同一段循环数据，看起来“只有跑”
- Blender 新做 `dk_walk_loop`（49 帧 / 30fps ≈ 1.6s 无缝循环）：在待机站姿上叠加双腿交叉迈步、
  髋部起伏/侧倾、双臂反向摆动、四节尾椎摆动，并 `attach_sword(49)` 绑回右手
- `knight_thunder.anims`：`move = 'dk_walk_loop'`、`moveFast = 'dk_run'`

### 3. 走/跑随机节奏（`Boss.js` `#updateChase`）
- 同时具备 `move` 与 `moveFast` 两段的骨架：血量 > 1/3 时每 2.4~4.6 秒随机切一次走/跑（各 50%），
  踱步移速为奔跑的 0.55 倍
- 血量 ≤ 1/3（`BOSS_PHASE2_RATIO`）恒奔跑，不再出现踱步
- 只有**实际产生位移**时才播移动动画；被定身、已到停距、顶到场地边界（实际位移 < 30% 步长）一律播待机

### 4. 冲锋不再原地跑
- `charge` 预警期 `#skillAnim` 返回 `moveFast`，但以前只播 dk_run 不推进坐标，2.4 秒就是原地跑步机
- 预警进度 > 40% 起沿 `warn.heading` 以 `def.speed × 2.2` 真实前冲，`#clampArena()` 收尾（30m 距离实测前冲 17.8m）
- `#resolveSkill` 对 `kind === 'path'` 改用 BOSS 当前站位作为判定起点，与冲锋画面一致（射程/持续窗口不变）

### 5. 验证
- 重建 `public/monsters/dk_anims.glb`（798KB，10 段，含 `dk_walk_loop`）
- Blender 预览 `.tmp_anim_preview/v2_*`：斧头在手，踱步正/反面双腿交替、姿态对称
- Node 无头模拟（`node_modules/.tmp/boss_pace_check.mjs`）：

| 场景 | 结果 |
|------|------|
| 血量 > 1/3 | 走/跑均出现；走路位移 145.9m、奔跑位移 793.3m |
| 血量 < 1/3 | 只出现 `dk_run` |
| 冲锋预警 | 前冲 17.8m |
| 顶到场地边界 | 位移 0.00m，动作回到待机 |

- `npm test` PASS、`npm run build` PASS

## 二十五、本轮改动：第二关提速 + 焚风灼膛锁 J + 火力核心（2026-10-31）

### 1. 第二关位移提速（保留站桩）
- `BOSS_PACE[2] = { speedScale: 1.3, walkStride: 0.9 }`：**没有 `move` 字段**，所以
  `#beginFight` 里 `anchor = !pace.move` 仍为 true，第一阶段照旧原地放技能
- 只加 `speedScale` 不够：`#updateChase` 的走/跑节奏里「踱步」段只有 0.55 倍位移，
  平均速度会被走段吃掉。新增 `pace.walkStride`（缺省仍是 0.55，第三关不受影响），第二关给 0.9
- 终盘实测口径：`5.9 × 1.3 × 1.35 = 10.35 m/s`（奔跑）/ `9.3 m/s`（踱步），改前是 7.97 m/s 恒定

### 2. 焚风灼膛（锁 J 技能，第二关专属）
- `BOSS_SKILLS.overheat`：`kind: 'ground'`，radius 7.5、damage 10、cooldown 18、telegraph 1.9，
  并带 `lockWeapon: 6`（命中者 6 秒内按 J 打不出炮弹）
- 在 `dragon_inferno.skills` 里**排在最后**：喷火/尾扫/俯冲都在冷却时才轮到缴械，不会开场连续锁
- 判定链路：`#applySkillTick` → `#lockWeapon(p, 6)` → `players[].weaponLock` →
  `#updateWeapons` 把 `firing` 置 false，`#updateAiWeapons` 同步封锁 AI 陪练
- 免疫：`#damagePlayer` 返回 0（护盾 / 复活无敌）时会 `continue`，不挂锁；红圈本身走普通走位判定
- 联机：主机把 `lock` 塞进 `bossHit.hits`，客机在 `handleNet` 里自己挂状态，两端倒计时一致
- HUD：武器名追加 `🔒 灼膛 6s` + `.meter.locked` 烙铁红；命中时船身爆点 + toast
- 激光被锁时 `BoatWeapons.cancelCharge()`：避免松手那一帧走“提前松手自动发射”分支

### 3. 火力核心（四个关卡通用的 J 强化道具）
- 数据：`BOSS_FIRE_CORE = { interval: 26, first: 9, duration: 12, shotMul: 3, shotDamage: 0.6, beamDamage: 1.8, life: 20, pickupRadius: 4.6, minRadius: 40 }`
- **投放方式**：场地中环（`ARENA_ITEM_SPOTS` 半径 ≥ 40 的点位）定时刷新，谁先吃到谁拿 12 秒；
  不占 Q/E/1 道具槽，也不进 `ITEM_DEFS`（那边有随机权重表，硬塞会让 `sum` 变 NaN 并泄漏到竞速模式）
- 选择定时刷新而不是“打 BOSS 掉落”：不奖励本来就输出领先的人、双方都能提前绕位争抢
- 外观：金色八面体炉芯 + 白热内焰 + 水面熔金光环，与蓝框问号箱明显区分
- `BoatWeapons`：齐射弹丸数量 ×3、扇面撑到 0.16 rad、炮口左右各补一次闪光；
  单颗伤害 ×0.6 → 一轮齐射总伤 ×1.8；激光没有齐射，整束 ×1.8 并同样补三重炮口
- 弹丸伤害在发射瞬间定格（`p.dmg`），buff 结束后仍在飞的弹丸不会突然变弱
- 联机：主机选点并广播 `fireCoreSpawn`；拾取广播 `fireCore` 让其它客户端收掉（强化只给吃的人）
- HUD：武器名追加 `🔥 超载 ×3 12s` + `.meter.overload` 熔金；与灼膛同时存在时优先显示灼膛

### 4. 验证
- `npm test` PASS（新增断言：第二关 `!pace.move && speedScale > 1`、`overheat.lockWeapon >= 6` 且 `kind = ground`、
  `shotMul = 3` 且 `shotDamage × shotMul > 1`）
- `npm run build` PASS（`dist/assets/index-DXyw0bKZ.js` 1,151.73 kB / gzip 344.09 kB）

## 二十六、四关 BOSS 战全盘排查与修复（2026-10-31）

### 1. 联机链路：技能演出/掉落物整条丢失（最严重）
- `Game.js` 的 `bossNetTypes` 与 `server/server.js` 的 `RELAY_TYPES` 都缺 8 类 BOSS 消息，
  服务端直接丢弃 `bossSkill / bossThunder / bossPillar / bossLava / bossLure / healPack / fireCoreSpawn / fireCore`。
  现象：客机只剩一圈红预警，看不到喷火/冲锋/落雷的粒子；血包、火力核心在客机上根本不存在
- 两处白名单已补齐（服务端只中继、不解析，字段扩展无需再改）

### 2. 客机重复结算
- `#strikeThunder`：客机本地预警圈走完也会触发落雷判定 → 本机玩家吃两份伤害。
  改为非主机只播演出直接 return；护盾/无敌挡下的命中不再挂减速（`dealt <= 0` 才跳过）
- `#updateStatusTimers` 里 `dive`/`confuseCast` 被递减两次（上面统一循环一次 + 单独两行），
  debuff 时长只有设计值的一半；已删掉重复递减，只保留“下发到 Boss.status”

### 3. 技能判定与红圈错位（纯视觉 Bug）
- `cone`：判定原点在嘴部（`radius × 0.78`），预警扇形却以 BOSS 中心画 → 火焰整体前移一截；
  预警顶点同步到嘴部，扇形与火光重合
- `path`（冲锋）：判定通道是 `-4 ~ 42m`，红框却是以 BOSS 为中心的 46m 方框，且前冲时不跟随；
  改为 `translate(0,0, len/2 - 4)`，并在 `#updateWarning` 里跟随 BOSS 前冲
- `screen`（全屏血幕）：红盘跟着 BOSS 走，实际判定居中场地；改为固定在 `(0,0)`
- 第一关喷火：`anim` 映射到 `roar`，结算后立即切回 idle → 火还在喷、BOSS 已闭嘴；
  火焰系吐息统一保持 0.95s 出手姿势

### 4. 客机看不到蓄力与命中演出
- `#resolveSkill` 原来只广播 custom 类技能；改成**所有技能**都发 `bossSkill`（带 origin/heading）
- `handleNet('bossCast')`：客机也播放预警 + 蓄力姿势，不再只有红圈

### 5. BOSS 死亡/关卡推进
- `handleNet('bossState')`：主机 `dead` 时客机把 `state:'dying'` 传进 `setNetState`，
  客机才会走一遍 `onDeath`；否则客户端永远停在 fight，看不到分关结算
- `#onBossDeath` 进 clear 时清掉落雷预警与持续判定窗口（`#clearThunder` + `hazards.length = 0`），
  避免结算面板后还挂着红圈/熔岩柱

### 6. 控制类道具/陷阱/协同合击的 debuff 只作用于本端（联机 + 失效）
- 客机丢 missile/rvortex/octopus/ink/bomb/decoy/tide/bubble 时，`#hitBossWithItem` 只写本地
  `bossStatus`，但 BOSS AI 只在主机跑 → 主机完全不受控（例如只有客机看到 BOSS 被压进水里）
- 现在把状态打包进同一条 `bossHit`（`hits[{ id:'boss', dmg:0, status }]`），主机取 max 叠加；
  `#sendSync` 额外下发 `dive`，客机据此看到沉水/浮起（两端演出一致）
- 同类问题还有两处：水泡陷阱（`bubble`，root 2.6s）直接写 `boss.status.root`，而 `boss.status.*`
  每帧都被 `#updateStatusTimers` 用 `bossStatus` 覆盖 → **连主机上都只生效一帧**；
  协同合击的 3.2s 破防同样只写本地。两处统一改写 `bossStatus`，并把状态随 `#dealBossDamage`
  的 `bossHit` 上报主机（`#dealBossDamage` 新增可选 `status` 参数）

### 7. 其他
- `#applyPose(dt)`：原来帧率无关的固定 `1 - exp(-6 × 0.016)`，改为用真实 dt（9 处调用同步传参）
- 小怪：`instantiateMonsterModel` 的几何与缓存 GLTF **共享**，`#removeMinion` 之前直接
  `dispose` 会把所有同型小怪一起废掉；新增 `#disposeMinionMesh`（只回收逐实例材质/自有几何），
  兜底球体标记 `ownGeometry`
- `#beginTelegraph` / `#beginPhaseBlast`：`#clearWarning()` 原本在 `this.telegraph = {...}` 之后，
  旧预警存在时会把新 telegraph 置空，下一帧 `warn.timer` 崩；已移到赋值之前
- `handleNet('fireCore')`：主机收到别人拾取后没有重置刷新计时，会立刻再刷一枚；已重置

### 8. 验证
- `npm run build` PASS（`dist/assets/index-CuuFCVPO.js` 1,157.24 kB / gzip 346.74 kB）
- `npm test` FAIL：`tests/gameplay.test.mjs:45`「baked defines shared sea-race features」——
  `src/data/maps.js` 的 `baked`（秘境漂流）地图没有 `marineFeatures` / `podium`，
  属竞速地图与测试不同步的既有问题，与本次 BOSS 改动无关（本轮未动 maps.js）

## 二十七、本轮改动：湖边树材质 / 树影 + 清澈见底浅滩水面（2026-11-01）

参考图：图1 雪地赛车树林、图2/3《Misty River》秋色树林、图4 实拍清澈浅海。
目标：① 赛道边的树做出参考图的枝叶层次与落影；② 水面做到「清澈见底」；
③ 5 种天气（晴朗 / 黄昏 / 暴风雨 / 暴风雪 / 星空）对应不同层次的水面。

### 1. 树叶材质（`Environment.getShoreMats`）
- 新增 `getLeafTexture()`：128×128 程序化叶片细节图（近白底 + 亮暗叶团 + 深色叶缝），
  `RepeatWrapping` / `SRGBColorSpace`；树叶材质从纯色 flatShading 改为
  `color × map × vertexColors` 三重乘算，远看不再是一块纯色锥体。
- 新增 `bakeCrownAO(geo, yLow, yHigh, rng)`：按顶点 Y 烘「树冠底部暗、顶部亮」的灰度顶点色，
  叠加逐顶点斑驳；针叶每层锥、阔叶每个树冠 blob、灌木、芦苇叶全部接入
  （芦苇叶必须烘，否则共享了 `vertexColors` 的叶材质没有 color 属性会整片变黑）。
- 秋色六色相：`leafA/leafB/leafC` + 新增 `leafGold 0xd2a240` / `leafRust 0xb0512c` /
  `leafPink 0xc98ea4`；`pickLeafKey(rng)` 按 30/18/12/18/14/8% 分配，
  针叶整棵只取一个色相 + 一个相邻色相做层次（贴近参考图的金红混交林）。

### 2. 树影（`Environment`）
- `renderer.shadowMap.enabled` 从「仅峡谷」扩到 `canyon || style === 'lake'`；
  湖图 2048×2048 阴影图（低/中画质 1024），`span = boundary.r + 70`，`normalBias 0.06`。
- 河岸树 / 岸石 / 岛体 / 岛缘装饰分别 `castShadow = receiveShadow = true`；
  岸带 `bank.receiveShadow = true`，树影落到草坡和水面上。

### 3. 清澈见底（`Water.#buildShoreField` + 片元着色器）
- **不引入半透明水面 + 海底网格**（会带来排序、折射通道和几何锯齿）；改为在水面片元里
  程序化绘制沙床，用「离岸距离场」控制可见度：
  - `#buildShoreField(mapDef)`：仅 `style === 'lake'` 生效。用与护岸同一套 CatmullRom
    采样中心线 128 点，计算每个像素到「内缘水线 `gateWidth+4.7` / 外缘水线 `gateWidth+15.5`」
    与岛屿边界的最近距离，烘进 320×320 RGBA DataTexture——
    R 通道存 `sqrt(prox / range)`（8 位直接存距离近岸会有台阶），
    `uDepthArea = (-R, -R, 1/2R, 1)`，`range = 55m`（航道中线离岸也才 20 米，22/38 米
    会让沙底只出现在贴岸细缝或整条航道一样淡，55 米才能整条航道都读作浅水沙底）。
    其他地图 `w = 0` 整块跳过，水色不变。
  - 片元新增近岸沙床块（插在 SSS 与菲涅尔之间），见下面「7. 用户反馈后的二次加强」。

### 4. 天气分层（`WATER_MOODS` + `setWeather`）
- 新增天气水面层次表（id → clarity/caustic/foam/refl/spec）：
  day 1/1/1/1/1；dusk 0.88/0.45/1.10/1.20/1.30；storm 0.36/0.10/1.85/0.68/0.55；
  blizzard 0.50/0.06/0.90/0.86/0.35；starry 0.72/0.55/0.70/1.05/0.80。
- `setWeather` 写入 5 个 uniform；反射掺深水比例改 `clamp(0.40/uReflGain, 0.05, 0.90)`、
  菲涅尔上限 `min(0.85, 0.55·uReflGain)`、太阳高光与碎波反光乘 `uSpecGain`。
- 新增岸边浪花：`1 - smoothstep(0.6, 4.6, prox)` × `uShoreFoam` × 气泡噪声，并入泡沫场。

### 5. 水面接收方向光阴影（树影/岛影落水）
- 水面是自写 `ShaderMaterial`，原来不参与灯光。现在 `lights: true` +
  `UniformsUtils.clone(UniformsLib.lights)`，顶点加 `common` / `shadowmap_pars_vertex` /
  `<shadowmap_vertex>`（手写 `worldPosition`、`transformedNormal = normalMatrix * vNormal`），
  片元加 `common` / `packing` / `lights_pars_begin` / `shadowmap_pars_fragment` /
  `shadowmask_pars_fragment`，`mesh.receiveShadow = true`。
- `getShadowMask()` → `lit = mix(0.52, 1.0, mask)` 调制 SSS、焦散、太阳高光；
  水体本身 `× mix(0.82, 1.0, mask)`。无阴影图的地图 `getShadowMask()` 恒为 1，无副作用。

### 6. 验证
- `npm run build` PASS（`dist/assets/index-DoIXpkSE.js` 1,170.85 kB / gzip 351.43 kB）
- 浏览器实测（`localhost:5173` 湖泊环线）：无 shader compile/link 错误；
  近岸可见青绿→米黄浅底渐变、右侧水面有树影/岛影暗区。
- `npm test` 仍 FAIL 于同一条既有断言（`baked` 缺 `marineFeatures`/`podium`），本轮未动 maps.js。

### 7. 用户反馈后的二次加强（「我压根看不到水底」）
- 原因：`uDepthRange` 太小（22→38 仍不够），`shoreT` 从 1.5 米才起步，
  航道中线只剩 ~0.06；沙色又偏灰、被黄昏方向的低角度高光/晚霞倒影盖住。
- 现方案：
  - `shoreT = pow(1 - smoothstep(0, uDepthRange, prox), 0.62)`，整条航道都有 0.6~0.8 的沙底权重。
  - 沙纹波长从 ~3m（读作迷彩斑）改为 0.6m / 0.4m 两层，另加 6 米级缓起伏；
    碎石小而稀（`vnoise×2.6`，压暗 32%），细砂粒 `vnoise×9`。
  - 沙底加 **水下视差**（按 `viewDir.xz × 深度` 偏移采样点），沙纹才会“沉在水下”；
    高频细节按 `exp(-dist*0.012)` 衰减，远处不闪。
  - 亮度用 `lum = clamp(luminance(uColorShallow)·1.1, 0.20, 0.68)`：白天米色、黄昏偏暗、
    夜里只剩一点月光；薄水色 `veil = uColorShallow·0.9`，贴岸权重 0.08 → 中线 0.26。
  - 焦散加强（`pow(...,2.4)`、日光项 0.70），沙脊朝阳面另加一线日光。
  - 贴岸 7 米内 `bed *= vec3(0.55,1.25,1.20)` 的通透青绿带（“水很浅”的直观信号）。
  - **压制浅滩反光**：菲涅尔 `reflK *= mix(1, 0.05, sandMask)`，
    太阳高光 ×`(1-0.90·sandMask)`、碎波反光 ×`(1-0.85·sandMask)`，
    否则沙底会被晚霞/天光洗成一片发白的水。
- 实测（`localhost:5173` 湖泊环线，晴朗 + 黄昏）：近处水面可见米色沙床 + 青绿阴影 +
  细粒/碎石纹理；无 shader 错误；峡谷等其他地图 `uDepthArea.w = 0` 完全不受影响。

### 8. 水面回退（同日，用户否决「清澈见底」）
- 用户反馈该方案效果不可用，**第三节与第四节的清澈见底改动全部删除**：
  `WATER_MOODS` / 深度场 `#buildShoreField` / uniforms `uDepthMap/uDepthArea/uDepthRange/
  uClarity/uCaustic/uShoreFoam/uReflGain/uSpecGain` / 片元里的沙床块与岸边浪花块；
  反射上限回到 0.55、太阳高光回到 `pow(ndh,700)*2.6 + pow(ndh,70)*0.16`。
- 保留：Gerstner 波、三层细节法线、SSS、天空反射 + 云、泡沫场（crest/turb/wake/trail/bow）、
  指数雾、阴影接收（`lights:true` + `shadowmask`），以及第二十七节第 1、2 条的树叶材质与树影。
- `npm run build` PASS（`dist/assets/index-8_h658M5.js` 1,168.36 kB / gzip 350.13 kB）。

## 二十八、本轮改动：低配画质三件套（接触阴影 / 光照配比 / 小贴图）（2026-11-01）

依据用户给出的「低模但精致」中间档路线，只做性价比最高的三项；水面保持第二十七节第 8 条的回退版，不动。

### 1. 接触阴影（替代 SSAO，零额外通道）
- `Textures.makeContactShadowTexture(128)`：中心实、边缘羽化的黑色径向渐变圆斑（共享一张贴图）。
- `Boat`：`#buildContactShadow(scene)` 在 scene 级挂一张 `PlaneGeometry(1,1).rotateX(-90°)`
  + `MeshBasicMaterial{transparent, depthWrite:false, opacity:0.4}`，尺寸按 `def.hull.width×2.1 /
  length×1.3` 拉伸；每帧贴到 `pos.y + sinkY + 0.08`（贴当地波高，避免被浪峰切断），
  腾空 / 沉没（`sinkY < -0.8`）/ 异世界期间隐藏。
- `Items.ItemBoxField`：新增 `this.shadows` InstancedMesh，随箱子 `#layout` 贴 `waterY + 0.06`、
  不跟箱体自转、比箱体大 1.6 倍；`#hide` 同步推到 `y=-600`，`dispose()` 一并回收。

### 2. 光照配比（`Environment`）
- 新增模块常量 `SUN_GAIN = 1.14` / `HEMI_GAIN = 0.82`，天气表与昼夜关键帧数据不动，
  统一在四个写入点相乘：`#buildLights`（初始 0.85 / 1.6）、`setWeather`（`hemiIntensity` /
  `sunIntensity`）、`#updateDayCycle`（`a.hemi`/`b.hemi`、`a.sunI`/`b.sunI`）、`setUnderwater`。
- 效果：主光更亮、补光更收敛，明暗方向拉开一档，暗部不再发灰；色调映射仍是原有的 ACESFilmic。

### 3. 小贴图替换纯色
- `Textures.makeWoodTexture(256)`：近白底 + 170 条竖向贝塞尔木纤维 + 7 处同心椭圆节疤。
- `Environment.getShoreMats`：`trunk`（树干）接入木纹（repeat 1×2）；湖岸 `rockA/rockB`
  复用 `getCanyonRockTexture()`（近白底岩面颗粒/层理，颜色仍由 `color` 分两档）；
  `grass` 复用 `getRockGrassTexture()`。竞技场远景松树 `trunkMat` 同步接木纹。
- `SceneDressing.#buildLamps`：路灯木构接入木纹（repeat 1×3，`getLampWoodTexture()` 共享一张）。
- 材质数量不变（同材质仍合批/走 `StaticMerge`），只多 2 张 256² 贴图（约 0.5MB 显存）。

### 4. 验证
- `npm run build` PASS（`dist/assets/index-jvxxAMF1.js` 1,173.22 kB / gzip 351.46 kB）
- 浏览器实测（峡谷激流单人练习）：船底可见贴水羽化阴影、道具箱下方有落影；
  岩石/草坡/树干不再是纯色平涂；岩壁背光面仍保留细节，无纯黑死区。
- `npm test` 仍 FAIL 于既有断言（`baked` 地图缺 `marineFeatures`/`podium`），与本轮无关。

## 二十九、修复：深水炸弹只改 HUD、BOSS 没有真的沉水（2026-11-01）

### 1. 根因
- `Boss.#applyPose` 已经算出 `diveSink = min(1, status.dive/0.35) × height × 0.62`，
  但**只把结果存进 `this.diveSink`，从未写进 `group.position`** ——
  沉水只存在于 HUD 状态与伤害加成，模型一直立在水面上。

### 2. 修复
- `Boss.#applyPose`：`group.position.y = wave + bob - this.diveSink`。
  水面是不透明面片，压到水线以下的躯体被水面遮挡，只留背脊/头顶露出；
  `status.dive` 归零后 `diveSink` 按 `1-exp(-6dt)` 平滑回 0，即"时效结束自己浮上来"。
  构造函数补 `this.diveSink = 0`，首帧不再依赖 `|| 0` 兜底。
- `BossMode.#updateStatusTimers`：在 `boss.status.dive` 跳变处补水面演出
  （`#playDiveSplash`）：压下去时 `toonWater` 水柱 ×3.4 + 冲击环 ×2.8；
  浮出时水柱 ×4.4 + 冲击环 ×4.0，位置取 BOSS 脚下当地波高 +0.7m。
  主机与客机各自由 `bossStatus` 同步驱动，两端演出一致（客机走 `bossHit`/`bossState` 的 `dive`）。
- 设计保持不变：沉水 3 秒内 BOSS 不施放新技能、受到伤害 ×1.25。

### 3. 验证
- `npm run build` PASS（`dist/assets/index-CRb3CAtc.js` 1,175.91 kB / gzip 352.59 kB）
- 逻辑核对：`dive=3` → `diveSink` 目标 ≈ `height × 0.62`（四关 4.1~4.8m），
  0.5 秒内到位；时效结束 0.5 秒内回 0。

## 三十、本轮改动：低血红闪 / 受击反馈 / 小怪挥砍光弧 / 阵亡与结算承伤统计（2026-11-01）

> 目标：把"我到底怎么掉的这管血"讲清楚。血量只存在于怪物模式（`PLAYER_MAX_HP = 100`，单机与联机共用同一套 `BossMode`），
> 所以以下改动全部落在 `BossMode` / `Boat` / HUD 链路上，竞速与道具模式不受影响。

### 1. 窗口边缘红色屏闪（低血常驻 + 受击叠加）
- `index.html` 新增 `<div id="hurt-overlay"></div>`（`#flash-overlay` 之后，z-index 6）：
  椭圆径向渐变，四边红、中心透明，`pointer-events:none`，透明度由 JS 逐帧写入。
- `BossMode.hudData()` 新增 `hurtFlash`（本机受击值，`#damagePlayer` 里 `max(+0.55)`，
  `update()` 里按 `dt*1.9` 衰减到 0）。
- `ui.js updateHud()` 驱动：
  ```js
  const ratio = Math.max(0, Math.min(1, d.playerHp / d.playerMaxHp));
  const lowK  = isBoss && ratio < 0.3 ? Math.min(1, (0.3 - ratio) / 0.3) : 0;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 240);
  const alpha = Math.min(1, lowK * (0.2 + 0.16 * pulse) + hurt * 0.8);
  ```
  → 血越少底色越重、呼吸式脉冲（常驻）；每次挨打再叠一次强闪。

### 2. 船身受击反馈（抖动 + 击退 ×1.5）
- `Boat.js` 新增 `this.hitShake = 0;`（构造函数 L303），
  `updateLocal` / `updateRemote` 每帧衰减（`dt` 线性，时长 0.34s），
  `#applyPose` 末尾按 `amp = k²` 叠加位置/旋转噪声：
  `position.x/z ±0.42`、`position.y ±0.14`、`rotation.z ±0.09`、`rotation.x ±0.06`（46/39/52/41/47Hz 错频）。
- `BossMode.#damagePlayer`：本机受击 `this.boat.hitShake = HIT_SHAKE_TIME`；队友受击也播 `hit` 特效（原来只有自己）。
- 击退倍率由 1 提到 1.5（`knockback` 传入的冲量统一放大）。

### 3. 小怪攻击的专属挥砍光弧
- `Textures.js` 新增 `makeSlashArcTexture(128)`：纯白新月形（外弧 + 内弧挖空 + 亮描边），
  颜色交给材质 `color` 控制，`AdditiveBlending`。
- `data/bosses.js` 的 `BOSS_MINIONS` 各加 `slashColor`：`beast` 琥珀 `0xffb347`、`blood` 赤红 `0xff3b52`。
- `BossMode` 新增 `#spawnSlashArc(m, target)` / `#updateArcs(dt)` / `#clearArcs()`：
  竖直 `PlaneGeometry` 贴在目标方向 `(radius + 1.5)` 处，`rotation.y = 朝向`、`rotation.z = -0.32`，
  `life 0.3s` 内放大淡出，到期 `dispose()`；共享一张 `slashTex`。
  时间线：`#updateMinions` 命中分支 → 触发光弧 → `#damagePlayer`。
- 生命周期：`startStage` 与 `dispose()` 都调 `#clearArcs()`。

### 4. 伤害来源 / 承伤统计（核心）
- 统一入口 `#damagePlayer(id, amount, { awayFrom, knockback, source })` 新增 `source`；
  `#resetPlayers` 给每人加 `taken / takenBy(Map) / lastHit / deathHit`。
- 所有 hit 点补齐来源标签：
  | 来源 | 标签 |
  |------|------|
  | 技能持续伤害 | `skillSource(skill)` → 🔥 火焰 / ❄ 冰霜 / ⚡ 雷 / 🌊 水 / 🩸 血 |
  | 漩涡吸引 | `🌊 漩涡` |
  | 深海瀑布 | `skillSource(gw.skill)` |
  | 全屏技 | `skillSource(skill)` |
  | 落雷 | `⚡ 落雷` |
  | 熔岩柱 | `🌋 熔岩柱` |
  | 小怪 | `💢 <小怪名>` |
  | 联机客机 | `hit.src \|\| '👹 BOSS'` |
- `hudData()` 新增 `lastHit / deathHit / takenMine / takenBy / takenRank / takenRankTotal`，
  `party` 每人带 `taken`；`#takenRank(id)` 实时算出本关承伤名次（≤4 人排序，开销可忽略）。
  `#respawnPlayer` 复活时清空 `lastHit / deathHit`。

### 5. 联机一致性
- `bossHit` 的每条 hit 现在带 `src`：客机 `#damagePlayer` 用 `hit.src` 记账，
  死因/承伤来源与主机一致（原来客机只知道"BOSS"）。
- `bossEnd` 消息带 `damage / taken / takenBy`：客机结算榜以主机数据覆盖本地估算
  （`msg.damage` / `msg.taken` / `msg.takenBy`），避免两端名次不一致。

### 6. 阵亡面板（`#death-panel`）
- HTML 在 `#player-hud` 之后；`ui.js` 仅在 `isBoss && playerAlive === false && deathHit` 时显示。
- 内容：标题（"船沉了 · Ns 后自动复活 / 等待救援 / 出局"）→
  `最后一击来自 <b>来源</b>，造成 <b>N 伤害</b>` → `本关累计承伤 · 队伍承伤排名 x/y` → 来源 Top4 小表格。
- 所有来自网络的文本经 `escHtml()` 转义。

### 7. 结算双榜（`#boss-result` / `#boss-end`）
- `ui.js` 新增 `rankTableHtml(rows, valueKey, label)` 与 `bossStatsHtml(data)`：
  左栏「输出排名」、右栏「承伤排名」，下方「全队挨打来源」汇总（按伤害降序，含占比）。
- `showBossStageResult` → `#br-dmg.innerHTML = bossStatsHtml(data)`（阶段总承伤写进 `br-stats`）。
- `showBossEnd` → 结尾追加 `<div class="be-tables">…</div>`。
- `#boss-result` 宽度 `min(560px, 90vw)`，`#boss-end .be-tables` `min(600px, 92vw)`；
  表格样式用组合选择器 `#boss-result … , #boss-end …` 复用一套。

### 8. 验证
- `npm run build` PASS（51 modules，`dist/assets/index-Dt2dUiLF.js` 1,182.56 kB / gzip 355.06 kB）
- 联机路径逻辑核对：主机 `#damagePlayer` → `bossHit{src}` → 客机记账 → `bossEnd{taken/takenBy}` 覆盖本地。
- 性能：光弧 0.3s 后 `dispose()` + 共享贴图；`takenRank` 每帧最多排 4 人。

## 三十一、本轮改动：火力核心引导 / 红闪修正 / 小怪伤害与弯刀特效（2026-11-02）

### 1. 三连发道具（火力核心）找不到 → 加引导
- 位置规则没变：`ARENA_ITEM_SPOTS` 三圈 12 点，火力核心只在 `minRadius:40` 之外随机
  （r=50 的四个对角点 ≈ (±35.4, ±35.4)，r=74 的四个点 ≈ 22.5° 系列，每次随机 1 个）。
- 节奏没变：开战 `first:9s` 刷第一枚，`life:20s` 后消失，`interval:26s` 再刷。
- 新增：
  - `BossMode.hudData()` 输出 `fireCore: {x,z}`（场上没有时为 `null`）；
  - `ui.js drawMinimap(mm, fireCore)` 在 200×200 小地图画「金色菱形 + 呼吸描边」；
  - `#makeFireCore` 加 34m 高的金色光柱（外柱 + 亮芯，加色混合），`#updateFireCores` 里做呼吸。
- 目的：玩家不再需要"满场找一个小箱子"，抬头看光柱 / 看小地图就能定位。

### 2. 红闪不出现（用户报"血条变红但窗口没闪"）
- 根因不是浏览器，是阈值与亮度公式：
  - HUD 血条 `.low` 的阈值是 35%，而 `#hurt-overlay` 常驻低血的公式用的是 30%，
  - 且 `lowK=(0.3-ratio)/0.3` 是线性归零：刚进低血区（29%）时 `lowK≈0.03`，
    `alpha≈0.01` 正好被 `>0.01` 的隐藏判断吃掉 → 看起来"完全没闪"。
- 修正（`ui.js`）：阈值统一到 35%，进区即有明显亮度：
  `low = 0.26 + 0.14*pulse + 0.16*lowK`，`alpha = min(1, low + hurtFlash*0.8)`。
- `#hurt-overlay` 的 CSS 未改（径向渐变/过渡照旧），受击短闪仍叠加在上面。

### 3. 小怪伤害高于 BOSS → 下调（`data/bosses.js`）
| 小怪 | 旧 | 新 |
| --- | --- | --- |
| 岩窟兽 beast | 14 / 1.5s（≈9.3 DPS） | 6 / 1.8s（≈3.3 DPS） |
| 血魔 blood 近战 | 26 / 1.5s | 11 / 2.0s（≈5.5 DPS） |
| 血魔 重击 | 42 | 22（`heavyDamage/heavyCooldown` 目前无引用，仅保留配置） |
| 血魔 飞刀（新） | — | 9 / 3.4s（≈2.6 DPS） |
- 参照 BOSS 技能单发 22~34 / 冷却 8~14s（≈2.6~4 DPS）：小怪回到"骚扰"，不再是主要死因。

### 4. 小怪特效：圆月弯刀 + 闪电路径
- 贴图 `Textures.makeSlashArcTexture()` 重写：锯齿状内外刃口（30 段 ±抖动）、
  刀尖最亮的渐变、7 道径向折线电弧；`mulberry32(0x51a5)` 固定种子，每次生成一致。
- 岩窟兽（近战，用户确认保持原地）：`#spawnSlashArc` 尺寸提到
  `max(3.2, fitHeight*1.45)`、`reach=radius+1.4`、`life 0.34`，贴在身前放大斜劈。
- 血魔（新增远程，用户确认）：`rangedRange 20`，距玩家 `> reach` 且 `<=20` 时原地抬手
  （优先播 `cast/skill/spell` 动画），`#spawnFlyingBlade` 从手部高度
  `fitHeight*0.55` 朝赛艇掷出自旋弯刀，`life = clamp(dist/45, 0.24, 0.7)`。
- 伤害时序：远程伤害在弯刀 `k>=1` 到点时才结算，只对 `targetId === this.myId` 的玩家
  生效（与既有"各自只结算自己"的约定一致），避免联机重复扣血。
- 资源回收：`#disposeArc` 统一 remove + geometry/material dispose；`#clearArcs` 换关时清空。

### 5. 验证
- `npm run build` PASS（51 modules，`dist/assets/index-DVWakiH-.js` 1,187.31 kB / gzip 356.60 kB）。
- 待实测：火力核心光柱观感、35% 红闪、血魔 8~20m 掷刀命中判定。

### 6. 第二轮反馈修复（2026-11-02）
- **红闪还是看不见的根因**：`#hurt-overlay` 的渐变半径写成 `ellipse 82% 78%`，
  窗口边缘只落在渐变的 61%~64% 处（48% 透明 → 78% 0.42），
  算下来边缘红色仅约 0.18，再乘 overlay 的 0.3 不透明度 → **实际只有 0.05**，
  在手机/普通显示器上等于不可见。
  - CSS 改为 `ellipse 100% 100% at 50% 50%`（边缘 = 100% 色标 = 最浓红），
    色标 `46% 透明 → 78% 0.55 → 100% 1.0`。
  - `ui.js` 低血常驻亮度提到 `0.40 + 0.22*pulse + 0.18*lowK`，受击叠加 ×0.85，
    阈值改成 `<= 0.35` 与血条 `.low` 完全一致。
- **火力核心吃不到**：第一阶段 `constrainBoat` 把玩家锁在离 BOSS `14~52m` 的环内，
  而原刷新点在外环 r=74（距 BOSS 74m），玩家被硬挡住 →「看得到吃不到」。
  - `#coreSpot` 改为**以 BOSS 当前位置为圆心的 40m 中环**（8 方向随机），
    再夹到场地半径 −10 以内；40m 落在可活动环内，任何阶段都能走到。
- `npm run build` PASS（`dist/assets/index-DYpHkyNv.js` 1,188.11 kB / gzip 357.07 kB）。
- 若仍看不到红闪，请先 `Ctrl+F5` 强制刷新（`dist` 里 index.html 可能被浏览器缓存）。

### 7. 怪物模式进不去（2026-11-02）
- 现象：点「怪物模式 → 开始练习」后只剩背景图，3D 场景不出现。
- 控制台：`TypeError: this.track.shoreColliders is not iterable`。
- 根因：`Game` 的艇物理统一展开
  `[...colliders, ...track.shoreColliders, ...track.mechColliders]`，
  而 `BossArena` 只声明了 `mechColliders`，没有 `shoreColliders`（undefined 不能展开）。
  之前一直跑的是旧 `dist`，重新构建后新代码才把这个问题暴露出来。
- 修复：`BossArena` 构造函数补 `this.shoreColliders = []`（竞技场没有岸边护栏，空数组即可）。
- 验证：浏览器实跑「练习模式 → 选艇 → 怪物模式 → 开始练习」，深渊火龙场景、
  HUD、小地图、计时均正常显示，控制台无致命错误。
- 构建：`dist/assets/index-CLeOfVqn.js`（1,188.14 kB / gzip 357.08 kB）。

### 8. 火力核心外圈升降铁钉（2026-11-02）
- 需求：火力核心周围加一圈会周期性升降的铁钉；船碰到升起的钉圈掉血。
- 参数（`src/data/bosses.js` 的 `BOSS_FIRE_CORE_SPIKES`）：
  - 半径 6m（拾取半径 4.6m 在圈内，必须穿圈才能吃到），24 根铁钉；
  - 3 秒一轮：升 0.4s → 保持 2s → 降 0.6s，收起时整圈下沉 2.6m 没入水面；
  - 升起进度 ≥ 0.35 才判定伤害；触碰 12 点 + 从核心向外击退，同一玩家 1.5s 冷却。
- 实现：
  - `#makeFireCore` 额外建一个独立 `spikes` Group（底座 Torus + 24 个共享几何的
    Cone + 亮橙危险提示环），位置 `(x, -sink, z)`，与旋转/浮动的炉芯分开；
  - `#updateFireCores` 用 `c.age` 走 3 秒周期，smoothstep 抬升，同步调暗红自发光
    与提示环透明度；判定只看升到阈值以上时的 `|dist - 6| ≤ 1.3` 带；
  - `#clearFireCores` 同时移除铁圈并 dispose 几何/材质；
  - 冷却 `p.spikeCd` 在 `#updatePlayers` 里逐帧递减。
- 构建：`npm run build` PASS（51 modules，`dist/assets/index-C46T-5Kl.js`
  1,190.15 kB / gzip 357.85 kB）。
- 待实测：3 秒节奏是否顺手、12 点伤害 + 击退力度是否需要调。

## 三十二、本轮改动：全量迁移「霓虹海峡」长赛道 + Blender 石木原型（2026-11-02）

### 1. 背景
用户给了一张 AI 生成的水上赛道布局图（城墙隘口 → 连续隧道 → 强化 Z 弯）和一份
Blender 提示词 / Three.js 落地手册。结论：方案可行，按手册把它落成一张正式地图
（`strait`），并用 Blender（bpy 程序化建模，无外部 API）出货 8 个低模原型。

### 2. 地图数据（`src/data/maps.js` 的 `strait`）
- `laps: 1`（全长约 3km，单圈）；`gateWidth: 8`；55 个门；
- `boundary { x: 14, z: -494, r: 580 }`；
- `gateHeights`：24~28 号门 = `0.5 / 3.0 / 0.8 / 2.6 / 0.5`（波浪栈道抬升段），其余 0；
- 两条合法内切近道（4→6、11→16，`width: 3.0`），满足
  `width ≤ gateWidth*0.42`、端点距门 `< gateWidth*2.2`、总长短于主道段、不穿主道走廊；
- `straitProps`：`wallGates [17,18,20]`、`tunnels [[21,23],[34,36]]`、
  `boardwalk [24,28]`、`hairpin { from: 11, to: 15, side: -1 }`、`pines { gates: [17,18,20] }`；
- `podium { x: 62, z: -560 }`、10 块礁石、`marineFeatures`（加速门 44 / 浮标 45 / 弹射链 50 起 3 个）。

### 3. 高度系统（`src/game/Track.js`）
- `gateHeights` 按门坐标唯一确定高度：`#gateHeightAt` / `#visualHeightAt` 供赛道与浮桶使用；
  `Game.js` 每帧在 `dives || overpass || openTrack || gateHeights` 时写 `b.diveTargetY`，
  所以波浪栈道能真正把船抬起来（不是纯视觉）；
- 无 `gateHeights` 的地图行为完全不变。

### 4. 石木原型（`public/models/track/*.glb`，Blender 导出，米制/原点底部中心/+Z 沿切线）
| 原型 | 尺寸要点 |
| --- | --- |
| `stone_wall` | 14.6 底座 + 7 层错缝砌块 + 两道腰线 + 压顶 + 5 城垛 + 3 扶壁（高 7.8） |
| `tunnel_rib` | ±9.2 双柱（柱基/柱身/柱头/柱帽，高 4.3）+ 顶梁 19.4×1.05×0.55 |
| `gate_lintel` | 19.5×1.8×0.7 + 上下压条 + 3 托块 |
| `boardwalk_plank` | 3 条 17.8×0.76×0.26（Z 长 2.4，运行时按段长缩放） |
| `boardwalk_pile` | 锥形桩 r0.34→0.26 高 1.0 + 底部箍 |
| `rail_post` / `rail_beam` | 桩高 1.5 + 箍 + 柱帽；横杆 X0.13 / Y 高 0.16 / Z 长 1.0 |
| `pine_tree` | 树干 1.35 + 两层塔冠（总高约 4.45） |

### 5. 合批与配色（`Track.#buildStraitProps`）
- 原型加载后只保留 `position/normal`，按材质 `color` 逐件 `#paint` 写顶点色；
- 实例按 `{name, x, y, z, yaw, sx, sy, sz}` 落位（栈道板按段长 `/2.4` 沿 Z 拉伸、桩按高度缩放），
  与原来那套 BoxGeometry 的坐标完全一致；
- 所有实例 + 隧道纵向木梁合并成一个 `strait_solid`（`MeshStandardMaterial` 顶点色、
  `roughness 0.92`、`flatShading`），霓虹边条仍是独立的 `strait_neon`
  （`MeshBasicMaterial 0x38f0c4`、`toneMapped: false`）→ 整段布景 2 次绘制。
- Blender 注意：Principled Base Color 是线性值，十六进制 sRGB 必须先转线性再赋值，
  否则导出的 GLB 会整体偏白（本轮已用 `srgb_to_linear()` 重导全部原型修正）。

### 6. 圈数联动（`src/main.js`）
- 单人菜单的圈数下拉默认跟随地图作者配置（`strait.laps = 1`），进入选图与切图都 `syncLaps()`；
  之前默认 3 会把单圈赛道显示成 1/3 圈。

### 7. 验证
- `npm run build` PASS（`dist/assets/index-BbrKdqlI.js` 1,197.91 kB / gzip 360.80 kB）。
- 无头浏览器冒烟：
  `{ map: 'strait', laps: 1, gates: 55, hasHeights: true, gateY24_28: [0.5,3,0.8,2.6,0.5],
  dive25: 3, dive0: null, solid: 33312, neon: 3096, errors: [] }`，8 个 GLB 均 200。
- 四机位截图（城墙 @18 / 隧道 @22.85 / 栈道 @25 / 发卡弯 @12.5）确认砌石、柱廊、抬升平台、
  木护墙正常；隧道顶部的宽条带是相邻顶梁透视叠加，非几何错误。
- `npm test`：只剩两条既有失效断言（见下），其余全部 PASS。
  - `Boat.js` 在 Windows 下是 CRLF，源码断言按 `\n` 写 → 测试里统一行尾后再比对；
  - `#splashBurst() {}`（测试仍期望空实现，实际代码保留了水滴爆发）；
  - `baked`（秘境漂流）没有声明 `courseProps`，四道具槽断言不成立。

## 三十三、本轮改动：海峡赛道五项实机反馈修复（2026-11-02）

### 1. 赛程后半段一大片灰色（水面没盖住）
- 根因：`strait` 南段最远到 `z = -1028`，而水面主网格是以世界原点为中心的
  `PlaneGeometry(size, size)`，`size = max(700, 2.15R)` 只按半径算、位置钉死在原点，
  南段整个掉到网格外，只剩无波浪的 `farSea` 灰色平板。
- 修复（[Game.js](file:///d:/3Dgame%20-%20%E5%89%AF%E6%9C%AC/src/game/Game.js#L181-L195)）：水面改按 `mapDef.boundary`
  的圆心 `(14, -494)` 平移，`size = 1247` 覆盖 `z ∈ [-1117, 129]`；
  `Water` 的顶点着色器本来就用 `modelMatrix * pos` 取世界坐标，平移不会破坏波浪与浮力同步。
- 验证：`waterPos [14,-494] / waterSize 1247`，南段截图已经是带波浪的蓝色水面。

### 2. 船压过浮桶（碰撞边界不在浮桶线上）
- 两个根因：
  1. 浮桶按「当前门段的法线」逐点偏移，拐角处连成的是**切进走廊的弦**，
     碰撞却按门宽算，两者本来就不在一条线上；
  2. 等距偏移线初版把**内角**也用半径 `W` 的圆弧收口，内角圆弧的弦高只有
     `W·cos(θ/2)`（139° 时掉到 2.6m），浮桶被压进走廊内部 5m，
     船贴边自然"越线"。
- 修复（[Track.js](file:///d:/3Dgame%20-%20%E5%89%AF%E6%9C%AC/src/game/Track.js#L1173-L1226)）：
  - 重写浮桶铺设：直段平行偏移、**内角用两条偏移线的 miter 交点**、外角仍走圆弧（round join）；
  - `#buildEdgeBuoys` 记录 `edgeOffset = gateWidth - 0.6`（strait = 7.4），
    `#probeMain` 的碰撞 `limit` 直接读它；近道浮桶在 `sc.width + 1.0`，
    `#probeShortcut` 的 `limit` 同步改成 `lerp(main.limit, sc.width + 1.0, s)`。
  - 浮绳按「主道一条 + 每条近道各两条」分组，不再按 side 合并整图，避免跨水连绳。
- 验证：把船推到走廊外 20m 再跑一次 `constrain`，量船中心到整条门线折线的最近距离，
  5 个门位 × 两侧全部 `4.63 ~ 6.60 ≤ 7.4`，无一越界。

### 3. 浮桶交叉
- 根因同上（凹角偏移点互穿 + 内角圆弧），Node 侧复刻 `buildDense` 诊断：
  `side=1 dense=959 / side=-1 dense=1003`，最近距离 7.40，自交 0。
- 近道末端缺口方向写反（用了正向切线），发卡弯两侧浮桶会被一起剪断；
  改成 `倒数第二点 - 末点` 后缺口正确开在近道内侧。
- 验证：全部 23 条浮绳线段两两求交 `hits: 0`，非相邻浮桶最近间距 8.2m。

### 4. 城墙像二维码（无贴图 / 无阴影）
- 材质：`strait_solid` 是合并几何 + 顶点色 + `flatShading`，没有 uv、没有贴图，
  只剩色块。新增 `getStraitStoneTexture()`（可平铺 Canvas 砌缝 + 颗粒），
  在 `#buildStraitProps` 里按原型名把石材（`stone_wall / gate_lintel / tunnel_rib`）
  与木材分开合批；石材用 `onBeforeCompile` 做**三平面投影贴图**，按法线权重混合，
  不需要给合并几何补 uv；两组都打开 `castShadow / receiveShadow`。
- 阴影：查出**真正的元凶**——`#buildLights` 改了
  `sun.shadow.camera` 的 `left/right/top/bottom/near/far` 却没有
  `updateProjectionMatrix()`，正交相机还停在默认 ±5m，
  阴影贴图只覆盖灯脚下一小块，等于**全图都没有投影**（不只是海峡）。
  补上 `cam.updateProjectionMatrix()` 后视锥 `right=190 / near=20 / far=620`、
  投影矩阵 `p0=0.0053`（旧值是 0.2）；`strait` 与 `baked` 一样让阴影相机跟随摄像机
  （span 190 / 2048 / bias -0.0008 / normalBias 0.12）。

### 5. 门柱全删
- `#buildGates` 改为空实现（保留 `gateMeshes = []`），`updateVisual` 里每帧的门柱
  材质切换一并删掉；过门判定只用门中心线与门号。
- 验证：`gateMeshes: 0`，截图里赛道两侧只剩浮桶链。

### 7. 弹射柱（伸缩海洋机关）整体移除
- 赛场里那根橙色立柱就是 `#buildPistons` 的伸缩机关（浮台 + 柴油色底座 + 橙色升降柱 +
  虹彩环 + 红绿指示灯），每张图按最急的 5 个弯自动落位，升起时还会推 `mechColliders`
  挡掉半边赛道。
- 按反馈整体删除：方法本体、`updateVisual` 里的升降/碰撞/指示灯循环、
  `#buildCourseProps` 的避让判断、`this.pistons / this.pistonsList` 字段全部清掉。
- 弹射模式的两样东西保留：`#buildMechs` 的**平贴水面弹射板**（接触即弹）与
  `pistonIndices` 驱动的弹射链，都不是立起来的柱子。

### 8. 验证与构建
- `npm run build` PASS（`dist/assets/index-C09x5lhx.js` 1,204.38 kB / gzip 363.03 kB）。
- 无头 Edge 实跑 `strait`：
  `{ gateMeshes: 0, buoys: 469, edgeOffset: 7.4, stones: 1, solids: 1,
  stoneCast: true, solidCast: true, shadowEnabled: true, sunCastShadow: true,
  shadowFollow: true, shadowFrustum: { right: 190, near: 20, far: 620, p0: 0.0053 } }`，
  `CROSS { ropes: 23, hits: 0 }`，`COLLIDE_OVERFLOW 0`。
- `npm test` 仍有既有失败项（漂移雾爆发断言），与本轮无关。

---

## 三十四、本轮改动：怪物模式道具职能化 + BOSS 状态条（2026-11-04）

### 1. 修复怪物模式道具池接错（关键 Bug）
- [BossMode.js](file:///d:/3Dgame%20-%20%E5%89%AF%E6%9C%AC/src/game/BossMode.js#L2) 原来把
  `ITEM_DEFS` 别名成 `BOSS_ITEM_DEFS`，实际掉的是**道具赛 16 个道具**：
  深海瀑布 / 减速艇 / 泡泡蜻蜓 / 鱼雷齐射在 BOSS 模式没有结算（0 伤害 0 状态），
  而水雷 / 泡泡陷阱 / 诱饵艇 / 反磁护盾写了分支却永远不掉。
- 现在改为真正的 `BOSS_ITEM_DEFS` 独立池（13 个）：
  `nitro / bomb / octopus / shield / missile / vortex / magnet / ink / angel / fish / rvortex / tide / weakspot`。
- 按用户要求，水雷 / 泡泡陷阱 / 诱饵艇 / 反磁护盾**不加入** BOSS 池；
  4 个赛道专用道具也不再混入。`BOSS_ITEM_BEHAVIOR` 里对应的 4 条旧配置一并删除。

### 2. 道具效果差异化
- **墨鱼（ink）**：由“致盲”改为**沉默 4 秒**，BOSS 不能起新技能；
  `Boss.js #pickSkill` 在 `status.silence > 0` 时直接返回 null，已读条的技能照常结算。
- **方向转换器（tide）**：改为**失控 3 秒**：BOSS 仍朝向玩家，但前进位移反向（往后退），
  同时 `confuseCast` 让扇形/冲锋方向随机 ±120°。
- **飞鱼群（fish）**：命中 BOSS 仍 120 伤害；释放时先撕咬船周围 20m 内的小怪，每只 240（×2），
  再照常发射鱼群弹道。
- **新增破甲标枪（weakspot）**：命中 100 伤害 + 4 秒虚弱窗口；
  `#dealBossDamage` 在 `bossStatus.vulnerable > 0` 时伤害 ×1.6、韧性累积 ×2。
- 道具池掉落的 HUD tooltip 现在有 `desc`（此前 BOSS 池没有描述会显示 undefined）。

### 3. BOSS 状态条 + HUD 字体调小
- `hudData().boss.debuffs` 输出当前生效状态：虚弱 / 沉默 / 失控 / 致盲 / 混乱 / 减速 / 沉水，
  每项带 0.1s 精度倒计时；`ui.js` 在血条下方渲染小胶囊。
- 新增 `#boss-debuffs` 容器，字体 10.5px、胶囊高约 17px，只显示生效项，不占固定高度。
- 按用户反馈，血条下方 HUD 再调小：
  `boss-break-tip` 15 → 13px（数字 17 → 14.5px）、`boss-tips` 12.5 → 11px、
  `kcap` 18 → 16px（字号 11 → 10px）、`tip-dim` 11 → 10px。

### 4. 特效（全部复用项目现有 Effekseer 资源）
- 墨鱼沉默命中：`fxMonsterRoar`（黑色咆哮冲击，原注释即“墨鱼爆墨”）。
- 方向转换器失控命中：`fxDark2`（紫色暗影爆刺，原注释即“方向转换器”）。
- 破甲标枪命中：`fxSpear1`（橙红放射能量核心，破甲冲击感）；弹道仍是 `itemBeam`。
- 飞鱼群释放：`fxWaterImpact`（船周围落水水花，一次性）。
- 这四个 BOSS 级特效按场景尺度用 `1.0` 播放，旧的小特效仍维持 `3.0`，避免新特效过大。

### 5. 验证
- `node --check` 通过（BossMode / Boss / ui / bosses / Items）。
- 道具池自检：`pool 13`、`missing behavior []`、`extra behavior []`、`rejected []`。
- `npm test` 仍在既有断言 `pistonMarkerMat`（第 272 行，与本次无关）处失败；
  本次相关逻辑已用模块导入自检覆盖。

---

## 三十五、修复误判「全员阵亡」（2026-11-04）

### 根因
- `BossMode.#checkDefeat` 原来先 `filter((p) => !p.ai)`，只统计真人；
  单人练习里玩家死亡（尤其复活次数用完）时，AI 陪练明明还活着也会被判定为全灭。
- 联机时同样存在漏判：远端玩家的最终死亡只在 `bossDown` 里同步状态，
  该分支没有重新判负，最后一艘船死在客机上时主机可能收不到终局。

### 修复
- [BossMode.js](file:///d:/3Dgame%20-%20%E5%89%AF%E6%9C%AC/src/game/BossMode.js#L1058-L1076)
  `#checkDefeat` 改为遍历 `this.players` 的**全部成员（含 AI）**：
  只有 `!alive` 且 `revives <= 0` 且 `respawn <= 0` 的成员才会被算作彻底阵亡；
  只要场上还有任意一艘船活着，或还有复活次数 / 复活倒计时，就不判负。
- `handleNet` 的 `bossDown` 分支在同步完队友沉船状态后补调一次 `#checkDefeat()`，
  主机因此能在远端玩家最后死亡时正确下发 `bossEnd(victory:false)`。
- 复活窗口与救援逻辑不变：还有 `revives` 的沉船玩家会先进入可救援倒计时，不算全灭。

### 验证
- `node --check src/game/BossMode.js` 通过。


---

## 三十六、比赛内 HUD 皮肤 v4（按图1/图2 再校一遍，2026-11-13）

v3 的两套皮肤被用户指出：右上氮气槽太小、设置按钮过大、怪物/竞技场玻璃感不足且仍有蓝色底格、
协同合击缺图标、怪物/竞技场小地图风格不统一。v4 在原位置直接替换 CSS 块（index.html 末尾），
场景与布局锚点不动。

### A. 竞速 / 道具（`#hud` 无 boss-mode / arena-mode）
- 小地图：碳纤维 45° 织纹 + `#00c8ff` 3px 霓虹描边 + 10px 圆角 + 双层外发光；
  内圈留暗反射。路线 `#2AF0D0` 发光、起点黄绿箭头（ui.js drawMinimap）。
- 右上氮气槽：放大到 **78×60、圆角 12px**，深蓝玻璃底 + 顶部反光 + 斜向高光条
  （`.nitro-slot::after`）+ 2px 青蓝霓虹 + 外发光；槽内保持空白，满瓶走 `.packed` 提亮。
  `#nitro-stock` 定位 `top:8 right:20`，实测 1094,8 / 166×60。
- 设置按钮：缩到 **69×28**（`font-size:11`、`letter-spacing:2`），碳纤维底 + 青蓝描边，
  `right:198 top:24`，与氮气槽垂直居中对齐（实测 1013,24）。
- 左下「赛道进度」：碳纤维面板，`flex column-reverse` 让标题行在上、里程槽在下；
  标题行左「赛道进度」＋右大号白色斜体百分比（`.pt-label` / `.pt-num`，ui.js 生成）；
  8px 圆头青绿发光里程槽 + 白色端点光。
- 右下集气条：橙红霓虹胶囊 + 橙色闪电圆牌 + 6 格方能量格（逐格点亮逻辑不变）。
- 道具格（竞速/道具也可见）：黑碳纤维 + 青蓝细描边，空格显示细体「?」。

### B. 怪物 / 竞技场（`#hud.boss-mode` / `#hud.arena-mode`）
- **去掉网格纹理与蓝色按键底格**：`--hud-grid` 变量已移除；Q/E/1、J/CTRL、K/F 键位小框
  改为透明底 + 1px 青蓝细框 + 白字。
- 玻璃面板统一 `--hud-glass`：斜向高光 + 顶部径向反光 + 深蓝半透明底 + `backdrop-filter: blur(6px)`，
  2px 青蓝描边 + 外发光 + 内高光，四角角标（`::after` 8 条背景线）。
- 协同合击：改为 **grid 布局**（40px 图标列 + 右侧三行），左侧新增内联 SVG「双手合击」
  （两只拳头相击 + 指节线 + 星芒）；`.cb-*` 全部接回网格区域。
- J/CTRL：`#skill-track` 容器透明，两张 116px 独立玻璃卡（J 橙红描边、CTRL 青蓝描边），
  取消中间分隔线；`#sk-j` 能量条橙红、`#sk-nitro` 青蓝。
- 道具格 72×72 玻璃方槽；空槽 `?`（ui.js 由 `❔` 改为 `?`，避免 emoji 自带蓝底）。
- 竞技场技能卡 92px，`padding-top:23px` 让键位与技能名分行；`#arena-skills bottom:132px`。
- 设置按钮：细长胶囊（`height:28`、`border-radius:999px`）。
- 右下横向氮气条：玻璃长条 + 2px **青蓝霓虹**描边 + 圆角端 + 四角角标 + 青色圆形闪电 + 青蓝渐变能量带
  （按用户确认，不用图2 的橙金描边）。
- 小地图：**三种模式统一**为竞速的碳纤维 + 青蓝霓虹 + 圆角方框，怪物/竞技场内部仍保留圆形雷达。

### 其它
- `#nitro-stock` 在怪物/竞技场整体隐藏（`isBoss || isArena`）。
- 锁定区域未动：顶部芯片、速度表、名次板、BOSS 血条、玩家名牌、竞技场红色血条。
- 验收：`npm run build` 通过；`node tests/hud_skin_shot.mjs` 出四张图到 `shots/verify/hud-*.jpg`。

## 三十七、怪物模式取消第一阶段走位环（2026-11-13）

用户反馈：第一阶段被锁在离 BOSS 14~52m 的环里，而撞船接触距离只有 `BOSS 半径 + 3.2m`，
等于第一阶段物理上撞不到 BOSS，只能隔空射击，手感很难受。确认后改为「开打即全屏自由走位」。

### 改动（仅 `src/game/BossMode.js`）
| 位置 | 改动 |
|------|------|
| 构造函数 / `startStage` / `#beginFight` | `freeMove` 初值改为 `true`；新增 `phase2Done = false` |
| `#checkPhase` | 守卫从 `if (this.freeMove ...)` 改为 `if (this.phase2Done ...)`，`phase2Done = true` 后只触发一次；1/3 血仍走狂怒 + 崩海咆哮 |
| 阶段提示 toast | 「可以绕圈走位了」→「技能全面加压」（走位早已解禁） |

### 效果
- 第一阶段起玩家可在整个场地自由移动，贴脸、氮气撞击、绕背打弱点从开打就可用。
- `constrainBoat` 因 `freeMove === true` 每帧直接 return（保留方法，Game.js 调用不改）；`BOSS_LANE` 仅剩 `#coreSpot` 与复活分支引用。
- 血量 1/3 的分界仍在：BOSS `rageMult`（3 关 1.35 / 4 关 2）、第 4 关伤害 ×1.5、技能冷却压缩、`#beginPhaseBlast` 崩海咆哮 30m 红圈照旧。
- 验收：`npm test` PASS；`npm run build` PASS（1,511.98 kB / gzip 471.95 kB）。

## 三十八、四关个性化玩法 + 阶段演出 + 难度加压（2026-11-13）

### 1. 每关新技能（`src/data/bosses.js`）
| 关卡 | 技能 | 形态 | 关键参数 |
| --- | --- | --- | --- |
| 一 · 深渊火龙 | 裂隙喷发 `rift` | 随机 3 处水柱，教学定位不惩罚 | 半径 16 / 水柱 5.2 / 偏移 ±10；14 伤 + 12 速减速 1.2s；CD 20s |
| 二 · 炎狱火龙 | 深渊召唤门 `summonGate` | 两道暖色门各召唤 1 螃蟹 + 1 水母 | 半径 32、夹角 ±0.85、开门 1.1s；CD 25s |
| 三 · 雷霆龙骑士 | 雷霆棋盘 `gridThunder` | **终盘（HP ≤ 1/3）** 6×6 棋盘，对角两组 3×3 交替，4 波 | 每波预警 0.9s / 结算 0.45s；22 伤；CD 34s |
| 四 · 暗夜血魔 | 血月激光 `laserSweep` | 360° 旋转横扫光束，2.6s 转满一圈 | 束宽 5 / 射程 88；每 0.4s 一跳 12 伤；CD 26s |

- 门槛：`#pickSkill` 新增 `minHpRatio` 过滤，棋盘雷只在第三关终盘出现。
- 棋盘按用户原话落地：6×6 格（"高压"档），先亮左上+右下 3×3，再亮右上+左下 3×3，循环 2 轮共 4 波；
  亮格预警 → 结算期间站亮格即吃 22 伤。整段期间 BOSS 定身，专注"下棋"。
- 激光/棋盘/召门都不走 `#makeWarning` 落点圈，各自有专门演出。

### 2. 阶段切换演出（`#playPhaseShowcase`）
- 50% 血与 1/3 血各触发一次（`halfDone` / `phase2Done` 双守卫）。
- 演出 = 元素光柱（`SkillFx.pillar`）+ 冲击环（`ringBurst`）+ 元素爆发特效 + 震屏 + toast。

### 3. 难度加压（只两条，用户指定）
- **压力递增** `BOSS_PRESSURE`：每 60s 一层，BOSS 技能冷却与小怪刷新间隔 ×0.95，最多 5 层（-25%）。
- **近身反制** `BOSS_CLOSE_PUNISH`：距离 <12m 每 5s 周期推开 18m + 8 伤 + 0.9s 减速，逐船独立冷却。

### 4. 特效选型（重要结论）
- 本轮**弃用** `P2_GateOfCalve` / `P2_BloodLance` / `P1_Herald` 等未入包素材：
  实机（尤其无头软件渲染）偶发 `texImage2D: Overload resolution failed`，一次异常会打断整帧渲染。
- 召唤门改为**程序化门面**（Torus + 暖色旋涡 CanvasTexture）+ `fxUpdraft`；
  激光源头用 `fxEmberSlash`；棋盘天雷用 `fxLightningStrike` + 程序化雷柱；
  半血演出固定用 `fxEmberSlash` / `fxMagic1Water` / `fxMagicDark`。
- 实测 `fxFireBurst` 在无头环境仍会复现 texImage2D 异常（老技能在用，未改动），新代码不再引用它。

### 5. 联机
- `bossSkill` 广播后，客机用同一份确定性 info 复算：裂隙水柱位置、召唤门方位、
  棋盘分组（按 index 推导）、激光起始角；伤害仍由主机统计并 `bossHit` 广播。

### 6. 验收
- 无头 CDP 验收（临时脚本已删除）：裂隙承伤 14；召唤门 queue=1、刷出 4 只小怪；
  棋盘站 A 组亮格承伤 14→36 并自动收场；激光角度 -0.31→-1.41 并自动收场；页面异常 0。
- `npm test` PASS；`npm run build` PASS（`dist/assets/index-CjSXWVlH.js` 1,531.35 kB / gzip 478.20 kB）。
- 待实机手感确认：6×6 棋盘的躲避难度、激光转速、近身反制击退距离。


## 三十九、四关新技能的骨骼动作 + 通用 enrage（2026-11-13）

### 1. 新增三个动画包（只含骨架、无网格）
| 文件 | clip | 时长 | 说明 |
| --- | --- | --- | --- |
| `public/monsters/fd_skills.glb` | `fd_rift_slam` | 2.00s | 火龙骨抬身前压 → 双翼下砸 1.6s（对齐裂隙结算） |
| | `fd_gate_call` | 2.50s | 立身展翼咆哮 → 低头前推 1.93s（对齐召唤门开门） |
| | `fd_enrage` | 1.20s | 立身展翼 + 左右甩头咆哮 |
| `public/monsters/dk_skills.glb` | `dk_grid_thunder` | 7.50s | 举斧向天、躯干微颤到 6.6s，末段砸斧（对齐第四波格子） |
| | `dk_enrage` | 1.20s | 举斧咆哮 + 展翼 + 尾扫 |
| `public/monsters/bd_skills.glb` | `bd_laser_sweep` | 4.33s | 双臂平举、上身从 -46° 拧到 +44°（跟着光束转） |
| | `bd_enrage` | 1.20s | 展翼仰头、双臂张开咆哮 |

生成器：[build-skill-anims.py](file:///d:/3Dgame%20-%20副本/scripts/build-skill-anims.py)
`"D:\blender\blender.exe" --background --factory-startup --python scripts/build-skill-anims.py`

### 2. 接入方式
- `bosses.js`：三个 BOSS 的 `clipModels` 追加对应包；`anims` 追加
  `riftSlam / gateCall / gridCast / laserCast / enrage`；四个新技能定义改写 `anim` 字段。
- `Boss.js`：新增公开方法 `playOnce(semantic, hold)`；`#playSkillResolve` 为
  `kind === 'rift'`（留 0.6s）和 `kind === 'gate'`（留 0.8s）补了姿势保持，
  否则结算瞬间会立刻切回 idle、把下砸/推门后半段吃掉。
- `BossMode.js`：50% 血与 1/3 血两处阶段演出都调 `boss.playOnce('enrage', 1.3~1.4)`。

### 3. 踩坑记录
- **武器骨必须逐个 action 单独 bake**：`attach_sword` 是按当前激活 action 逐帧采样手骨的，
  放在 `new_action('dk_enrage')` 之后跑，会把 225 帧的武器通道全写进 enrage，
  而 grid 段压根没有武器通道 → 斧头悬空。现在每段 action 结尾各自 `attach_sword(N)` 再导出。
- **Blender 5.1 slotted action**：新建 action 后赋给 `animation_data.action` 即可 key，
  但同一进程里连续切 action 做预览时，第二次切换不刷新生效（导出数据是对的，只是预览图是旧的）。
  所以预览改成一进程只验一段，最终以 GLB 里的四元数采样为准。
- 火龙骨架（88 节点）没有手臂，只有翼根 `Bone072_020 / Bone027_043`、后腿
  `Bone098_080 / Bone103_075`、尾 8 节 `Bone001_067 → Bone008_074`；
  血魔用的是 `Bip001 *` 命名（手臂 `L/R UpperArm`，翼 `Bone004_049` / `Bone004(mirrored)_054`）。

### 4. 验收
- 无头 CDP（[tests/_anim_probe.mjs](file:///d:/3Dgame%20-%20副本/tests/_anim_probe.mjs)）：
  三个包 clip 名全中；第一关 boss 的 action 表含 `fd_rift_slam/fd_gate_call/fd_enrage`；
  `playOnce('enrage',1.4)` → `animName = fd_enrage`、`animHold = 1.4`。
  唯一页面异常仍是既有 Effekseer `texImage2D`（老技能 `fxFireBurst` 引起，本轮未新增特效引用）。
- `npm test` PASS；`npm run build` PASS。
- 待实机确认：火龙翼根 ±30° 展开幅度、龙骑士 7.5s 引雷的微颤是否够明显。

---

## 四十、第六轮试玩反馈修复（2026-11-13）

### 1. 第三关棋盘预警太淡
- 棋盘网格贴图：亮格 `rgba(150,225,255,0.55)` → `rgba(168,236,255,0.9)`，格线加粗到 4px、亮度 0.95。
- 预警不透明度 `0.16 + 0.5k`（上限 0.66）→ `0.35 + 0.6k`（上限 0.95），暗格从 0.12 提到 0.1 对比更清楚。
- 棋盘 y 从 `0.18` 抬到 `0.75`：原来大半张板沉在浪峰下面，这是“几乎看不见”的主因。

### 2. 第四关巨鲸鲨
- `speed 8.0 → 5.2`；泡泡射程 `26 → 34`、冷却 `9 → 7.5`。
- 小怪 AI 新增站位逻辑：进入泡泡射程后若距离小于 `34 × 0.62 ≈ 21m` 就往回游，
  冷却期间也不再贴脸，远程炮台的定位才立得住。
- `blood_nightmare.summon` 删除两条血魔条目，只保留 75% / 25% 各两只巨鲸鲨。

### 3. 第二关召唤门
- 门从 r4.2/2.3s 放大到 r5.4/3.5s，加白色内环 + 13m 竖直光幕（`CylinderGeometry`，openEnded）。
- **关键修复**：以前整扇门绕 Y 轴自转，转到侧面就变成一条线，玩家自然找不到门；
  现在每帧按相机位置只调 `group.rotation.y`（始终正面朝向镜头），门面纹理自己在平面内旋转。
- 仍是 three.js 自绘（`gateTexture()` 暖色旋涡）。Effekseer 的 `P2_GateOfCalve`
  在部分显卡上会抛 `texImage2D` 打断整帧（第三十九节有记录），所以没有启用。

### 4. 三渲光圈统一去掉
- `SkillFx.ringBurst` 不再创建贴水 `RingGeometry` 冲击环，只保留向外扩散的粒子；
  崩海咆哮（30m）、棋盘（24m）、裂隙（水环）、阶段演出等所有调用点一并生效。
- `SkillFx.vortex` 去掉地面收缩光环，只用绕圈/收束的粒子表达吸取范围。
- 保留：`shockwave`（浪墙本体，是判定可视）、`pillar`（水柱/火柱本体）、
  以及真正的预警圈（雷圈/激光/暗影区），这些不是装饰光圈。

### 5. 赛艇不许穿过 BOSS
- `BossMode.constrainBoat` 之前因为 `freeMove = true` 直接 return，等于完全没有约束。
- 现在无论如何都保留 `BOSS_BODY_KEEP = 6`（BOSS 圆心 6m）的排斥圈：
  只清掉撞圈那一侧的径向速度，切向速度保留，可沿边滑行；`freeMove` 下不再做远近墙。
- 注意：贴身撞 BOSS 的“撞击伤害”随之基本触发不到，这是“不穿模”的代价。

### 6. 圈数不更新
- 根因：`ui.js` 的 `updateHud` 只在 BOSS/竞技场分支写过 `#hud-lap`，
  竞速/道具模式从不写，顶栏一直是 HTML 初始的“第 1 圈”——和计圈逻辑无关。
- 修复：普通比赛分支按 `d.lap / d.laps` 每帧写 `圈数 N/M`，`d.lap` 来自
  `Game.js` 的 `pm.lap`（过起点线 +1），所有底图共用这一条路径。
- `npm test` PASS；`npm run build` PASS（`dist/assets/index-CXDcwuWL.js`）。

## 四十一、BOSS 单翅膀复发修复（2026-11-13）

### 现象
- 第一关 BOSS 放「裂隙喷发」等技能时只剩一只翅膀；此前也多次在补丁动画包里复发。

### 根因
- 火龙右翼等镜像部位靠骨骼**负缩放轨道**（`scale = -1,-1,-1`）做左右镜像，
  节点默认缩放是 `+1`。补丁包导出时整段丢失了 5 条 scale 轨道：
  `Bone072_020`（右翼根）、`Bone103_075`、`eye3_014`、`eye4_015`、`eye12_019`。
- 播到缺轨道的 clip 时，镜像骨回落到默认 `+1`，右翼半边翻转/消失。
- 全量审计结果：
  - `fd_skills.glb` 的 `fd_gate_call`、`fd_rift_slam` 缺全部 5 条
    （第一关裂隙、第二关召唤门）。
  - `bd_skills.glb` 的 `bd_laser_sweep` 缺 3 条镜像骨轨道（第四关激光）。
  - 其余 `fd_anims` / `fd_anims2` / 本体与其它怪物包均正常。

### 修复
- `Boss.js` 新增 `repairMirrorScaleTracks(clips)`：合并完本体 + 补丁包 clip 后，
  先从所有 clip 中收集「有负缩放关键帧」的骨骼作为参照，再给缺失（或导出成恒等 `+1`）
  的 clip 补一条恒定负缩放轨道；本来正常的 clip 不覆盖。
- 在 `#setupModel` 建 action 之前调用，所有 BOSS 共用，避免以后新增动作包再复发。
- 没有去改 GLB 二进制：运行时补轨对现有素材零侵入，换包也不会退回去。

### 验证
- 单元校验（three 真实 `AnimationClip`）：缺失 / 恒等 `+1` 两类 clip 共补 4 条轨道，
  正常 clip 未被改动。
- `npm test` PASS；`npm run build` PASS（`dist/assets/index-re43rWcY.js`）。

### 复发：切动作“一瞬间”单翅膀（同一轮内继续修）
- 现象：补轨之后仍会在出招瞬间闪一下单翅膀，只持续一小会儿。
- 根因（不在 GLB，在 three 的混合器）：
  - `PropertyMixer.apply()` 里当 `cumulativeWeight < 1` 时执行
    `accu += original * (1 - weight)`，即向 `saveOriginalState()` 抓到的**绑定原值**回退。
  - `saveOriginalState()` 在动作第一次激活时抓骨骼当时的缩放；镜像骨的节点默认值是 `+1`，
    所以绑定原值也是 `+1`。
  - 首次淡入、同一段 clip 被 `force` 重播（受击硬直 / 连招打断）等时刻，权重和会短暂 < 1，
    镜像骨就在这几帧从 `-1` 被插值向 `+1`，实测峰值 `+0.81`（穿过 0，右翼瞬间消失）。
- 修复：`repairMirrorScaleTracks` 改为返回 `{ fixed, mirror }`；`#setupModel` 在
  `clipAction` / 第一次 `#play` **之前**把 `mirror` 里每根镜像骨的节点缩放设成参照负值，
  让绑定原值本身就是 `-1`，权重不足时回退到负值也不会掉镜像。
- 验证（真实 GLB + 真实 `AnimationMixer`，18 段 clip 全量）：
  - 修复前：5 根镜像骨在 idle 淡入 / 喷火打断 / `fd_hit` 强制重播中共 84 帧掉出镜像，
    `Bone072_020` 的 x 在 `[-1.00, +0.81]` 之间抖。
  - 修复后：全程稳定在参照值（`-1.00` / `eye12 -0.56`），0 帧异常。
  - `npm test` PASS；`npm run build` PASS（`dist/assets/index-CDIO8sqZ.js`）。

---

## 四十二、全地图弯道导向牌 + 湖泊近道入口去遮挡（2026-11-13）

### 1. 背景 / 根因
- 全项目原先**只有湖泊**有 Chevron 立牌（`src/game/LakeStadium.js`），而且贴图方向写死：
  箭头永远是 «，不随弯道转向变化。湖泊是右弯环线，箭头却指左 —— 用户说的「方向反了」。
- 湖泊近道从 `gates[8]=(0,88)` 往岛内侧切，`Environment.buildShoreBankGeometry()`
  沿主道两侧**连续**铺绿草坡岸带，生成时无任何近道判断，把近道起点盖住；
  树簇 / 灌木有 `shortcutClearance`，但树簇旁石头、浅滩石头、岛缘礁石都没有。

### 2. 新增 `src/game/GuideSigns.js`（全 8 图通用层）
- 左右两张 CanvasTexture（黑底白双 chevron + 橙底条），牌面做成正反两片背靠背，
  从背面看箭头也不会左右镜像；牌面 / 立柱 / 底座共 4 个 InstancedMesh。
- **箭头方向 = 该处弯道转向**：`cross>0` 右转 → »，`cross<0` 左转 → «，永远指向弯内；
  牌子立在弯道外侧，牌面法线朝来车方向。连排跨过 S 弯拐点时，局部转向与整组不一致
  的那块牌直接不摆（宁缺毋错）——这是审计抓出来的真实 bug。
- 只在有曲率处布点（±9m 切线夹角 > 0.19rad），急弯三连排；起点后 20m 固定一组引导牌。
- 净空：近道走廊（整条跳过，近道口不摆牌）/ 岛屿 / 暗礁 / 领奖台 / 折返的其它赛段
  中心线 / `Environment.colliders`（树、石、岩壁）/ 湖泊看台占地。纯视觉、不写 colliders。
- 抬高段的 y 取 `track.surfaceYAt(中心线点)`，云端 / 瀑布段的牌不会掉到水面下。
- 确定性按弧长采样、不用 `Math.random()`；`planGuideSigns()` 是纯数学导出函数，
  供 Node 侧审计。URL：`?guideSigns=0` 关闭、`?guideSigns=flip` 一键整体翻转箭头。
- `Game.js` 在 env / track 建好之后创建（要读碰撞体与高度），`dispose` 里销毁；
  **不跟天气联动**（暴风雨 / 暴雪里更需要方向参照）。
- `LakeStadium.js` 删掉旧的自建 Chevron 立牌 / 贴图 / 柱子，只保留浮台与警示柱，
  避免两套牌叠在一起且方向互相矛盾。

### 3. 湖泊近道去遮挡（`Environment.js`）
- `buildShoreBankGeometry` 新增 `shortcuts` 参数：逐格检查四角，任一角落在近道走廊
  （`sc.width + 2.5`）就不生成该格草坡；只删三角形、不删顶点、不消耗额外 rng，
  岸边树不会跟着 rng 序列整体挪位。
- 树簇旁石头、浅滩石头补 `shortcutClearance`；`#buildIslands` 的**岛缘礁石**新增
  同款判断（实测残留的那块 `(-73.5,-3.6, r2)` 就来自这里）。所有改动都是
  「先摇完 rng 再判断」，布景位置不漂移。

### 4. 验收
- `node tests/guide_signs_audit.mjs`：8 张图全部有牌，逐块断言方向 = 局部转向、
  且不与近道 / 岛 / 暗礁 / 领奖台 / 折返赛段冲突。结果：
  canyon 52 / lake 9 / ocean 65 / palace 21 / tide 24 / strait 96 / baked 74 / magma 31 块；
  **lake 9 块全部 »**（旧版固定 «，方向已翻正）。
- `node tests/guide_signs_visual.mjs`（无头 Edge + CDP，实机 lake）：
  岸带 3758 个三角形中压在近道走廊上的 **0** 个、近道走廊内碰撞体 **0** 个、
  走廊内导向牌 **0** 块、运行时 9 块牌全部 `guide-signs-right`。
  截图 `shots/verify/guide-lake-shortcut-entry.jpg`（入口净空）、
  `guide-lake-sign-face.jpg` / `guide-lake-sign-zoom.png`（牌面 » 实拍）。
- `npm test` PASS；`npm run build` PASS（`dist/assets/index-D-5obxY-.js`）。
- 未逐图实机截图：其余 7 张图只做了数值审计（净空 + 方向），需要时可按同样脚本换图跑。

---

## 四十三、导向牌加密到覆盖赛道 2/3（2026-11-13，同日二次反馈）

> 本节覆盖第四十二节里的旧数量与旧参数；那一节的「根因 / 模块职责 / 近道去遮挡」结论仍有效。

### 1. 用户反馈与根因
「指引牌太少了…只有零散的一点点，又丑又没用，尽量覆盖赛道的三分之二」。
根因不是间距，而是 `CURVE_MIN = 0.19` 把缓弯全判成直道：湖泊椭圆环 691m
只落 7 组 / 9 块，各图合计才 372 块。

### 2. 参数与机制改动（全在 `src/game/GuideSigns.js`）
| 项 | 旧 | 新 |
| --- | --- | --- |
| 候选间距 `SIGN_STEP` | 18m | **16m** |
| 组间距 `GROUP_GAP` | 26m | **14m** |
| 曲率阈值 `CURVE_MIN` | 0.19 | **0.055**（缓弯也给方向参照） |
| 每组块数 | 1 / 2 / 3 | **2 / 3 / 4**（急弯四连排，不许单块孤零零） |
| 组内间距 `ROW_GAP` | 5.5m | **5.0m** |
| 近道缓冲 | `sc.width+10` | **`sc.width+4`**（走廊内仍一块不放，只把两侧主道放开） |
| 折返赛段净空 | `off-2.5` | **`gateWidth/2+3.5`**（仍在另一段走廊外留 3.5m） |
| 牌面 | 2.3×1.25 | **2.6×1.4**，中心 y 2.25→2.35 |

- 新增「补缺口」：按 2m 网格算覆盖掩码，对 ≥10m 的连续空白在中点补一组两连排，
  最多 3 轮。**不能靠无脑缩小全局间距**——急弯四连排跨度 15m，间距小于它就会叠牌。
- 覆盖率定义 `COVER_R=14m`：沿中心线每 2m 一格，14m 内有牌即算这段有方向指引，
  环形首尾相接；`stats.coverage / coveredMeters` 直接可读，审计脚本按 ≥0.66 断言。
- sign 增加 `cx/cz`（对应中心线点），验收脚本据此摆合法机位。

### 3. 验收（`node tests/guide_signs_audit.mjs`）
| 地图 | 组 / 块 | 覆盖 |
| --- | --- | --- |
| canyon | 45 / 153 | 838m / 98.4% |
| lake | 42 / **98**（原 9） | 691m / **100%** |
| ocean | 97 / 270 | 1775m / 80.9% |
| palace | 53 / 132 | 917m / 95.4% |
| tide | 43 / 120 | 919m / 84.2% |
| strait | 107 / 322 | 2294m / 75.3%（最低，仍 >2/3） |
| baked | 145 / 398 | 2757m / 78.3% |
| magma | 54 / 156 | 1095m / 80.4% |

8 图合计 **1649 块**（原 372 块，约 4.4 倍），方向与净空逐块断言仍全部通过。
实机 lake（`tests/guide_signs_visual.mjs`）：运行时 98 块、覆盖率 100%、98 块全 »；
岸带压近道三角形 0、近道走廊碰撞体 0、走廊内牌 0。
截图 `shots/verify/guide-lake-sign-face.jpg`（牌面 » 清晰、不贴脸）、
`guide-lake-shortcut-entry.jpg`（入口两侧成排牌、水面干净）。
`npm test` PASS；`npm run build` PASS（`dist/assets/index-B-rmCzCt.js`）。

### 4. 验收脚本踩坑
把船放到「牌坐标沿切线后退」会把船摆到中心线外 15.5m 的非法位置，
相机随之贴着牌子，拍出一大块黑底贴脸图（一度误判成穿模）。
必须用 sign 的 `cx/cz` 中心线点后退，船始终留在走廊里。

---

## 四十四、撤回高密度方案，回到稀疏版只微调（2026-11-13，最终生效版）

> 用户反馈「太多了感觉，有点密集恐惧症了，在之前的基础上加一点点就行」。
> **最终生效参数以本节为准**，第四十三节的加密参数全部作废。

### 1. 回退内容
| 项 | 加密版（作废） | 最终生效 | 最初版 |
| --- | --- | --- | --- |
| `CURVE_MIN` | 0.055 | **0.155** | 0.19 |
| `SIGN_STEP / GROUP_GAP` | 16 / 14 | **18 / 22** | 18 / 26 |
| 每组块数 | 2 / 3 / 4 | **1 / 2 / 3** | 1 / 2 / 3 |
| `ROW_GAP` | 5.0 | **5.5** | 5.5 |
| 近道缓冲 | `sc.width+4` | **`sc.width+10`** | `+10` |
| 折返赛段净空 | `gateW/2+3.5` | **`off-2.5`** | `off-2.5` |
| 牌面 | 2.6×1.4 / y2.35 | **2.3×1.25 / y2.25** | 2.3×1.25 |
| 补缺口循环 | 有 | **删除** | 无 |

- `stats.coverage / coveredMeters` 作为纯观测指标保留（不再设下限断言），
  `sign.cx/cz` 也保留给验收脚本摆合法机位；审计脚本的 2/3 覆盖断言已移除。
- 相对最初版只把 `CURVE_MIN 0.19 → 0.155`、`GROUP_GAP 26 → 22`，
  让缓弯多出零星几组，属于「加一点点」，不改整体稀疏观感。

### 2. 数量对照（8 图合计）
| 版本 | lake | 8 图合计 |
| --- | --- | --- |
| 最初版 | 9 块 | 372 块 |
| 加密版（作废） | 98 块 | 1649 块 |
| **最终版** | **13 块** | **397 块** |

各图：canyon 53 / lake 13 / ocean 70 / palace 24 / tide 28 / strait 93 / baked 81 / magma 35。
方向与净空逐块断言仍全部通过；实机 lake 运行时 13 块全 »，岸带压近道三角形 0、
近道走廊碰撞体 0、走廊内牌 0。`npm test` PASS；`npm run build` PASS
（`dist/assets/index-DsZqGpEl.js`）。

### 3. 以后想再调密度
只改 `src/game/GuideSigns.js` 顶部常量即可，不用动布点逻辑：
- 更少 → `CURVE_MIN` 调大（0.19≈最初版）、`GROUP_GAP` 调大
- 更多 → `CURVE_MIN` 调小（0.055 是加密版）、`SIGN_STEP` 调小
每改一次跑 `node tests/guide_signs_audit.mjs` 看各图数量与方向断言。

---

## 四十二、删除赛道“啾~啾~”音效（drift_boost，2026-11-13）

### 定位
- 用户反馈跑图时一直有“啾~、啾~”，很像已删掉的 `checkpoint.wav`。
- 对全部赛道音效做了频谱/音高走向比对（checkpoint 为 744Hz → 246Hz、0.5s）：
  - `drift_boost.wav`：4834Hz → 146Hz、0.3s，双喷时连响两声（间隔 0.15s）——命中。
  - 其它候选（`speed_portal` 662→234Hz、`pickup` 2.2kHz、`impact_old` 1682→117Hz）都不是。
- 用户试听 `audio-check.html` 后确认就是漂移小喷。

### 修复
- `Boat.js` 小喷触发处删除 `audio.play('drift_boost', { gap: 150 })`（物理脉冲保留）。
- `AudioEngine.js` 的 `SFX_SAMPLES` 删除 `drift_boost` 条目，避免预加载 404。
- 删除 `public/audio/sfx/drift_boost.wav`；原始素材 `music/drift_boost.wav` 保留（不参与构建/访问）。

### 验证
- 全仓 `drift_boost` 引用已清零；`npm test` PASS；`npm run build` PASS（`dist/assets/index-CGA2Tpp7.js`）。

---

## 四十三、恢复被删的光圈（回滚第四十节 4，2026-11-13）

### 反馈
- 第四十节 4「三渲光圈统一去掉」删过头：第一关追踪漩涡在持续阶段几乎看不见，
  玩家被卷进去/掉血时不知道是什么技能，其它靠光环标范围的技能也一起失去反馈。
- 结论：光环不是纯装饰，是**范围/落点的可视反馈**，恢复。

### 恢复内容
- `SkillFx.ringBurst`：恢复贴水 `RingGeometry` 冲击环（半径 = 传入 `radius`，
  加色混合、`0.6s` 内扩散 25% 并淡出，走 `flashes` 的 `mode: 'ring'` 生命周期）。
  所有调用点（崩海咆哮 30m、棋盘 24m、裂隙、阶段演出、命中反馈等）自动生效。
- `SkillFx.vortex`：恢复地面收缩光环（半径 = 传入 `radius`），逐帧向中心收拢 55% 并淡出；
  到期/`clear()` 时连同几何体一起销毁。
- `BossMode.#updateVortexChase`：第一关「追踪漩涡」的光环**持续阶段不再撤掉**，
  改为跟着龙卷移动 + 呼吸闪烁（不透明度 0.46~0.70），能一直看到吸力范围。
  主机与客机（`bossVortex` 消息）共用同一条更新路径。
- 光环统一抬到 `y = 0.55`（原来 0.12~0.18 会被 0.31m 的平静海浪挡住一部分），
  和 `shockwave` 同一高度，浪峰也盖不住。
- 例外：第一关「裂隙喷发」三根水柱外圈**不要**光环（用户指定）。
  `ringBurst` 新增 `ring = true` 开关，`#resolveRift` 传 `ring: false`，只保留水花粒子；
  其它所有技能的光环不受影响。
- 例外：第二关「深渊召唤门」门外那圈地面火环也去掉（`#beginSummonGate` 里
  `ringBurst('fire', radius:10)` 传 `ring: false`），门本体（门面 + 竖直火幕）保留。

### 保持不变
- `shockwave`（浪墙本体，判定可视）、`pillar`（水柱/火柱本体）、
  预警圈（雷圈/激光/暗影区/棋盘）都不动，避免再次误删。

### 验证
- `npm test` PASS；`npm run build` PASS（`dist/assets/index-Dd851fq9.js`）。

---

## 四十四、裂海泉涌预警改造 + 血月激光减速（2026-11-13）

### 裂海泉涌（第四关）
- 原来只有一圈蓝色亮环“啪”地向外扩，看不出浪的厚度，也没有提前预警。
- 浪速 `waveSpeed` 24 → **11**，整圈扫完约 8 秒，玩家有足够时间绕到礁石后面。
- `SkillFx.shockwave` 新增 `band` 参数：亮边（0.94~1.0）后面再叠一圈半透明水带（0.82~0.95），
  `#resolveGeyserSkill` 传 `band: true`，看起来是有厚度的浪而不是一根蓝线。
- 新增地面红色预警（`#spawnGeyserWarn`）：从 BOSS 脚下每 13m 一圈红色 `RingGeometry`，
  浪头到达前 1.7 秒开始由暗到亮呼吸，浪过去后 0.45 秒淡出销毁；
  实现“红色预警一层一层向外释放”。清场/切关/技能结束都会调用 `#clearGeyserWarn`。

### 血月激光（第四关）
- `BOSS_SKILLS.laserSweep.duration` 2.6 → **4.2 秒/整圈**，转速约 1.5 rad/s（原 2.4 rad/s）。
- BOSS 的 `animHold` 自动跟着 `skill.duration` 延长，扫射期间保持举臂姿势。

### 验证
- `npm test` PASS；`npm run build` PASS（`dist/assets/index-kKGPT89q.js`）。






## 四十、8 艘赛艇第二轮换装：6 艘 tripo 载具轻量化（2026-11-13 晚）

用户给了 6 个「未来载具」GLB（车/飞行器/快艇，26~50 万面、9.5~17.6MB），
要求：**只保留磐石号 + 牛来号**，剩下 7 个位置换成这 6 艘（编制仍是 8 艘），
每艘减面到 **≈5MB**（"减面不要减太多"），比赛参数与怪物模式攻击方式**继续继承旧的 6 套**，
名字按外形重起。

### 1. 编制与命名（id 不变 → 参数 / 手感 / 武器全继承）

| id | 旧船（参数来源） | 新船 | 模型文件 | 尺寸 / 面数 / 体积 |
| --- | --- | --- | --- | --- |
| `rower` | 破浪划艇 34 速 | 赤焰号 | `boat_speedboat.glb` | 45 万→13 万面，4.42MB |
| `skiff` | 竞速轻艇 29 速 | 绯鲨号 | `boat_redcar.glb` | 27 万→13 万面，4.33MB |
| `falcon` | 疾风号 36 速 | 青锋号 | `boat_car6.glb` | 42 万→13 万面，4.45MB |
| `titan` | 磐石号（不动） | 磐石号 | `frickies_yacht.glb` | 未改动 |
| `dolphin` | 游隼号 32 速 | 流光号 | `boat_flycar.glb` | 50 万→13 万面，5.21MB |
| `vintage` | 古帆木船 30 速 | 琥珀号 | `boat_jetboat.glb` | 26 万→13 万面，4.27MB |
| `longship` | 维京长船 34 速 | 长鲸号 | `boat_ship.glb` | 31 万→13 万面，4.25MB |
| `cow` | 牛来号（不动） | 牛来号 | `cow_rider.glb` | 未改动 |

**砍掉的一整套参数 = 远洋拖网船 `trawler`**（26.5 速 / 稳 1.0 / 宽 2.5）：
它和磐石号（28 速 / 稳 0.95 / 宽 2.3）抢同一个"重装宽体"生态位，且是全场最慢。
`boats.js` / `BOAT_HANDLING` / `BOAT_WEAPONS` / `ui.js` 的 `BOAT_ROLES` 四处同步删除。

### 2. 轻量化管线 `scripts/boats/slim_boats.py`

```
blender -b --factory-startup --python scripts/boats/slim_boats.py -- all 130000
```

每艘走 6 步：①顶点协方差求水平主惯性轴，把长轴转正到 glTF +Z
②两端 1/6 宽度比较定船头，翻转到 +Z ③XZ 居中 / 船底 y=0 / 船长归一到 1.0
④Decimate(COLLAPSE, 三角化) 到 13 万面 ⑤贴图 4096²→2048² 重编 JPEG
⑥导出 GLB（`export_yup`、无动画无蒙皮）。

产出写 `public/models/boat_<tag>.glb`，同时 `assets_src/boats/fixed/*_fixed.glb` 保留原始件。

### 3. 四个坑（下次直接抄结论）

1. **tripo 模型在自身 mesh 空间里是斜的**。car6 主轴相对 +X 偏 52°、speedboat 偏 48°，
   直接进游戏会"歪着跑"。必须用协方差求主方向再烘进顶点，不能靠 `modelRotationY` 手填。
2. **偏航要转 Blender Z 轴**。Blender 水平面是 XY、Z 向上，而 glTF 是 Y 向上
   （`(x,y,z)_gltf → (x,-z,y)_blender`），写成 `rotation_euler.y` 等于没转（而且
   glTF 导入的物体 `rotation_mode` 是 QUATERNION，euler 赋值根本不生效）。
3. **只 `image.scale()` 再导出，贴图还是 4096²**：导出器认"源字节未改"直接拷原始 JPEG。
   必须落盘一张新的 2048 JPEG + 让材质节点指向新 image datablock。
4. **双体船（红 car）不能用"窄端 = 船头"**：两片艏柱横向分开，末端 `max|x|` 反而更大，
   判据会判反。脚本里用 `EXTRA_FLIP` 显式补 180°（其余 5 艘判据均正确）。

### 4. 接进游戏

- 6 艘全部 `modelRotationY` / `modelScale` 不填（已烘到 +Z、长 1.0），只写 `modelLiftY` 压吃水。
  取值过程：初版 -0.055×船长（-0.26~-0.36）看着像贴图浮在水面 → 试过统一 +5cm，
  实机发现浪一大就把艇身盖住，**最终定在原吃水 +2cm（-0.28 ~ -0.38，赤焰号 7.0% → 8.0% 船长）**。
  船底在 y=0，不压会像贴图；再深就会被水面吞掉 —— 2cm 是这条船型的甜点。
- `tests/gameplay.test.mjs` 新增 `SLIM_HULLS` 断言：这 6 个 id 的 `model` 必须指向
  `boat_*.glb`，且**不允许**出现 `modelRotation*` / `modelScale`（一旦出现说明有人又把
  斜着的原始模型塞回来了）。船数 9→8、武器表 9→8、`trawler` 已退场。
- 大厅 `.lp-grid` 8 张是偶数，`odd` 铺满规则自动不生效。

### 5. 验收

- `npm test` PASS；`npm run build` PASS（1,531.87 kB / gzip 478.36 kB）。
- 绯鲨号（双体）碰撞宽按真实视觉宽从 2.0 调到 **3.2**（4.8 × 0.68）：整个船长方向都保持这个宽度，
  不调的话擦墙时外侧船体会压进岸线。`Track.constrain` 实际取「半宽×0.88 + 0.35 容差」≈ 1.76m 半宽，
  闸门半宽 ~7m，不会变成空气墙。
- 新脚本 `tests/boat_swap_probe.mjs`（无头 Edge + CDP）：大厅选艇 → 发车 → 截图全景 +
  按船的屏幕投影裁 3 倍特写。实测 6 艘 `hullLen` 4.42 / 4.81 / 5.21 / 5.02 / 4.52 / 6.62，
  均等于各自 `hull.length`；`tris` 13 万；船底在水面下 0.28~0.38m（波浪起伏时再 ±0.08）。
  图在 `shots/verify/boats/new/`（`race-*.jpg` 全景 / `zoom-*.jpg` 特写 / `lobby-8-cards.jpg`）。
- 验收脚本两个坑：**CDP 的 `returnByValue` 序列化不了 THREE.Group**，
  等待条件必须写成 `!!(...modelRoot)`；主菜单 `#btn-solo` 存在"onclick 已挂但点了没反应"的
  阶段，要循环点 + 检查 `#lobby` 真的显示出来。

---

## 四十一、怪物模式道具池改造（2026-11-13 深夜）

### 1. 为什么要改

怪物模式原来 13 件道具，`BOSS_ITEM_BEHAVIOR` 里 7 件有伤害、**6 件是 0 伤害的纯辅助**，
掉落又是 `ITEM_IDS[Math.floor(Math.random() * ITEM_IDS.length)]` 完全等概率 ——
均摊期望伤害只有 846/13 ≈ **65**。第 1 关 BOSS 3000 血，一场 12 个箱子、8s 刷新，
单人实际能撞 15~20 个箱子，道具总共只贡献 1000~1300 伤害（≈35%）。
再加上三件道具互有覆盖，池子"看起来有 13 件、实际能打的没几个"。

### 2. 删掉的（3 件，`shield` 按用户要求保留）

| 道具 | 判定依据 |
|---|---|
| `rvortex` 海洋之怒 | 26 伤害（全池最低）。desc 写"持续掉血"，`#hitBossWithItem` 里只有一次 `#dealBossDamage(26)` + `slow`，**没有任何 DoT 累积**；名字还和 `vortex` 撞。 |
| `octopus` 章鱼 | 控制面被 `ink` 完全覆盖：`confuseCast` 只在 `skill.kind === 'cone' || 'path'` 时才打偏，`silence` 拦的是"起新技能"。60 伤害撑不起保留理由。 |
| `magnet` 磁力吸盘 | 0 伤害；`#castMagnet` 找不到队友只弹 toast；`#hitBossWithItem` 里给它写的 `status.slow` 是**走不到的死分支**（在 `#castMagnet` 就 return 了）。 |

> ⚠️ 这三个 id 在**竞速模式**的 `ITEM_DEFS` 里仍然有效（Items.js 的竞速结算、`Homing.js`、
> `AudioEngine` 都还引用着），只从 `BOSS_ITEM_DEFS` 里摘，别顺手把竞速那份也删了。
> `tests/gameplay.test.mjs` 加了断言同时守两侧：BOSS 池里不许有、竞速池里必须有。

### 3. 新增的（4 件，全部走 `#launchItemShot` / `#hitBossWithItem`）

设计意图：原来伤害天花板只有导弹 200，最优解是绕圈溜 BOSS。补「贴脸高风险高回报」
和「主动撞船」两条路。

| 道具 | 伤害 | 机制 | 特效 |
|---|---|---|---|
| `harpoon` 深海鱼叉 | **340** | `range: 32`，飞满就散（`p.travelled > p.range` 时直接消失并 toast），命中挂 `vulnerable` 2.5s | 飞行体 `fxHarpoonFly`(P2_BloodLance) / 命中 `fxHarpoonHit`(M_AttackImpact) |
| `barrage` 三连深水弹 | 3 × 130 = **390** | `shots: 3` 同时出手，弹速 44/46/48 依次到达 | 命中 `fxWaterImpact` ×1 + 补一层 0.9 缩放的水花 |
| `thunderrod` 引雷针 | **260** | + `silence` 3s + `stagger: 90`（≈ 一条破韧条的 1/3） | 飞行体 `fxThunderFly`(A_BlueLaser) / 命中 `fxLightningStrike` |
| `ramcrest` 冲角护符 | — | 8s 内撞船 ×3、撞击冷却 ×0.55、**撞完不弹开**（可以贴着 BOSS 连撞） | 声爆环 `fxSonicBoom` + 跟随光罩 `ramCrest`(Barrior02) |

实现要点：

- **三连弹不做发射队列**：三发同时 `push` 进 `this.projectiles`，只把 `speed` 依次 +`gap`，
  靠到达时间差做"连着三下"的观感。省掉一套 `shotQueue` 状态，也不用在 reset 里补清理。
- **射程用已飞距离**：`#updateProjectiles` 里 `p.travelled += step`，超过 `p.range` 就
  `#removeShot` 且不结算伤害。不能让鱼叉在 100m 外也必中，否则"贴脸"这个设计前提就没了。
- **`#dealBossDamage` 现在会带上 `stagger`**：原来是 `this.#dealBossDamage(behavior.damage)`，
  改成 `{ stagger: behavior.stagger || 0 }`，引雷针才有破韧。破韧仍然只在主机结算。
- **`ramBuff` 计时无条件衰减**：写在 `#updateLocal` 的撞击段之前，不放进
  `if (me.alive && me.invuln <= 0)` 里面 —— 否则玩家吃无敌帧时倒计时会被冻住。
- `#boatBarrier('ramcrest:' + myId, 'ramCrest', life)` 复用护盾那套跟随光罩，
  但**刻意用 Barrior02 而不是 Barrior01**，免得和 shield 分不清。
- `fxScale` 单独给了 `harpoon 1.15 / barrage 1.3 / thunderrod 1.0`：
  这三段素材是按弹着点做的，沿用旧道具的 3.0 会糊满半个屏幕。
- `fonts`/音效没有新资源：`harpoon`/`barrage` 借 `boss_bomb`（`gap:150` 防三连弹三重播），
  `thunderrod` 进 `boss_control_hit` 那组。

### 4. 没动的

- **水面漂雷 / 黏性水泡 / 幻影诱饵**（`BOSS_TRAP_ITEMS` + `#placeTrap` / `#updateTraps` /
  `#triggerTrap` / `#removeTrap`，约 120 行）**按用户要求保持不投放**，代码留着。
  它们是完整的（`mine` 200 伤害 + 炸怪 320 + 30s 存活），只是不在 `BOSS_ITEM_DEFS` 里，
  `#useItem` 永远走不到。`Items.js` 和 `bosses.js` 都加了注释说明"暂不投放、不是 bug"。
- `#useItem` 的 `case 'antimagn'` 仍然是死分支，同样按"先留着"处理。
- **掉落权重和文案这次都没改**（用户要求）。`vortex` 的 desc 已从"落点范围 160 伤害"
  改成"水弹命中 BOSS，160 伤害"，与实际单体命中一致 —— 这一条是顺手改的文案同步，不动数值。
- `shield` 和 `angel` 仍然功能重叠（同一个 `boat.shieldTimer`），**下一轮需要二选一**。

### 5. 验收

- `npm test` PASS。新增一段守卫：池子 14 件、删掉的三件不在、四件新道具齐全、
  `harpoon.damage >= 300`、`barrage.damage * shots > missile.damage`、
  `ramcrest.ramMul === 3`、源码里必须出现 `crest ? crest.mul : 1`、
  且 `BossMode.js` 不能残留 `case 'rvortex'` / `case 'octopus'`。
- 新脚本 `tests/boss_items_fx.mjs`（无头 Edge + CDP）实测：
  - 7 段相关特效全部加载成功（`fxHarpoonFly/fxHarpoonHit/fxThunderFly/ramCrest/
    fxWaterImpact/fxLightningStrike/fxSonicBoom`）
  - 深海鱼叉 **340** / 三连深水弹 **390** / 引雷针 **260**，与数值表完全一致
  - 冲角护符 `ramBuff = { t: 8, mul: 3 }`
  - 截图 `shots/verify/boss-items/items-*.jpg`
- 验收脚本踩到的四个坑（都已修）：
  1. **Edge 必须等静态服务器能应答再开**：同时 spawn 时 Edge 会抢在前面拿到连接拒绝，
     之后停在错误页不再重试，`#btn-solo` 永远不出现。
  2. **单人入口已经是大厅了**：`#btn-solo` → `#lobby` → `#btn-lobby-boat` / `#btn-lobby-mode`
     → `#btn-start-race`，老的 `#boat-list .boat-card` + `#btn-map-ok` 那套只在联机链路上。
  3. **FX_PACK 类特效是异步加载的**（要先 fetch `fxres.json`），一次性读 `fx.effects[name]`
     会造成假失败，必须轮询。
  4. **测伤害前要清场**：先等 `projectiles.length === 0` 和 `bossStatus.vulnerable === 0`，
     否则上一件的余弹和鱼叉自己开的破甲窗口会把数字叠成 624 / 416 这种怪值。
- 撞船伤害在无头里**测不出来**（`speed` 由 Boat 每帧用水阻重算，合成的 `vel` 一帧就归零，
  玩家死亡重生还会换掉执行上下文），脚本里这段改成"能测就断言、测不到只记录"，
  倍率由源码守卫兜底。

---

## 四十五、熔岩夜航「硬核化」改造：碰撞 / 裂谷 / Blender 障碍 / 发卡近道（2026-11-14）

> 用户反馈：①「前后移动过的石头我都能飞过去，穿模，是不是没加物理碰撞」；
> ②「缝隙太小，几乎正常移动都能开过去，没有丝毫难度」；
> ③「整个地图都是圆形，没有难度，要不加障碍物、要不加近道或弯道，类似跑跑卡丁车森林发卡」。
> 先询问后开发，用户选定 **两者都做，分两步 / 裂谷硬核 / 障碍物用 Blender 出 GLB**。
> 本节是最终生效参数；第四十二~四十四节关于导向牌的稀疏版结论不受影响。

### Step 1-A 修「飞过去穿模」

- 根因不是"没注册碰撞"： magma 动态障碍每帧都进 `Track.mechColliders`，但登记的是
  纯 2D 圆 `{x,z,r}`，**没有 `bottomY/topY`**。`Boat.updateLocal()` 的 airborne 分支
  只结算带高度范围的 collider（`if (!Number.isFinite(c.bottomY) ...) continue`），
  而 `Track.applyMechs()` 又对 `boat.airborne` 整段早退 —— 于是大浪/裂谷一腾空，
  滚石就变成纯贴图，玩家直接飞穿。
- 修法（只影响 magma）：`Track.updateMechs` 给 4 类动态障碍补真实高度范围：
  `magmaDrifter -0.3~3.2`、`magmaGeyser 0~(0.9+13*up01)`（喷柱长多高就拦多高）、
  `magmaRoller -0.4~2r`、`magmaImpact -0.4~1.7r`。
  这样 Boat 的**空中 3D sweep** 会真的把船推到 `r+1.3` 外；飞得够高才合法越过。
- `applyMechs` 把 `if (boat.onCoaster || boat.airborne) return;` 拆成：
  过山车仍整段免疫；普通腾空走新增 `#airborneMagmaHit(boat)`，只认 `magma*` 类型，
  补一层减速/硬直（喷柱 0.5 / 滚石 0.55 / 其它 0.68）。加速带、漩涡、传送门、
  弹射器、撞碎岩保持原来的腾空免疫。
- 实机 A/B（`tests/magma_hardcore_probe.mjs`）：同一条 26m/s 低空穿滚石轨迹，
  **带高度范围最近距离 4.50m（= r 3.2 + 1.3，被推出）**，剥掉 `bottomY/topY` 后
  **0.13~0.20m（直接穿模）**。修复真实生效，不是只改了参数。

### Step 1-B 裂谷「硬核」档

| 项 | 旧 | 新 |
| --- | --- | --- |
| 裂谷数 | 2（after 2 / 24） | **4**（+ after 14 东发卡出口 / after 38 西发卡出口） |
| 宽度 | 10m | **15 / 14 / 15 / 14m** |
| 速度门槛 | 15m/s | **21 / 20 / 21 / 20m/s** |
| 跳板 | 每谷前一块，强送 `speed=20 + faultGrace=1.9` | **整项删除** |
| 浪尖抛飞 | waveScale 1.65，随时腾空白嫖 | **岩浆图关闭**（新 `noWaveLaunch`） |
| 坠落惩罚 | 退两门 + 初速 3 + 1.2s 宽限 | **退一门 + 0.7s 硬直 + 初速 4** |

- `noWaveLaunch` 只关**抛飞**（`Boat.waveLaunchEnabled` 新开关），水面起伏、
  波面涌流漂移、`waveScale=1.65` 全保留；其它地图完全不受影响。
- 起跳仍是 `vy=6.0 + waveJump 12m/s²` ≈ 1s 滞空，21m/s 刚好跨 15m；
  慢一点就掉谷。`tests/gameplay.test.mjs` 的裂谷上限按硬核档放宽到
  `width<=18 / minSpeed<=26`，但**下限同步抬到 width>=12 / minSpeed>=18**，
  防止以后又被悄悄调回"随便开过去"。
- `faultRects()` 仍是几何唯一真源，`Track.#buildFaults` / `Water` 的 discard 遮罩
  自动跟着 4 道裂谷走，不用改第二处。

### Step 1-C Blender 出的岩石障碍

- 新脚本 `scripts/blender/build_magma_obstacles.py`，Blender 5.2.3 命令行导出三个
  低模顶点色原型（`public/models/magma/*.glb`，合计 ~16KB）：
  `volcanic_pillar`（7 边锥形玄武岩柱）、`lava_spikes`（岩座 + 5 根尖刺）、
  `obsidian_shard`（3 片斜刃黑曜石）。
- 遵循硬规则：`COLOR_0` 顶点色（线性值，sRGB hex 先 `s2l()`）、Base Color 打平、
  原点在落地面中心、导出器 kwargs 先查 `get_rna_type().properties`。
  夜景下第一版纯黑剪影读不出体块，二次把 basalt 抬到 `#52363c/#7a4a48`、
  裂纹占比提到 26%、加一点极弱 emissive（导出 `emissiveFactor≈0.0825`）。
- **几何进 Blender，逻辑留 JS**：`Track.#buildMagmaObstacles()` 只加载 GLB 做视觉，
  碰撞写进 `shoreColliders` 的圆形代理 `{type:'magmaObstacle', r, bottomY, topY, heavy:true}`，
  GLB 加载完成后把代理 `topY` 回写成模型真实高度，视觉与碰撞不会各说各话。
  `heavy` 走 Boat 的硬物回弹/侧翻分支，AI 前方障碍规避自动认得这些代理。
- `maps.js` 新增 `magmaObstacles` 9 处（门 6/10/12/19/23/28/35/41/46，`side≈±0.72`），
  刻意避开裂谷段、浮桶、喷泉、滚石、撞碎岩、旋转锤、漩涡、起点；
  偏一侧约 5.4m，另一侧永远留得出一条线，不造死路。

### Step 2 两条「发卡内切」近道

- 主道 48 门形状**没有重画**（项目约定：动布局要单独确认）。难度靠新增的两条窄近道：
  `{from:10,to:14}` 切东 U 发卡、`{from:34,to:38}` 切西 U 发卡，宽 5m、
  中段带 34.1° / 43.2° 的 S 弯，各比主道**省 20.6m / 20.9m**。
  出口紧接发卡裂谷 —— 抄近道省距离，但必须带 20m/s 出来才跨得过，是风险/收益选择。
- `Water.makeLavaTrackMask` 追加把 `shortcuts.points` 也烘进 R 通道（只写 R，
  G/B 路缘和中央虚线仍归主道），否则近道下面会是活跃岩浆，看着像在陆地上开船。
- 新增 `tests/magma_shortcut_audit.mjs`（纯 Node 几何审计）：端点吸附、长度收益、
  非相邻赛段净空、与全部静态/机关实体的距离、与裂谷矩形的间距、折线转角。
  实测：离其它赛段 27.2 / 25.8m，离最近实体 11.9 / 12.0m，裂谷余量 6.7 / 6.0m。
- 实机 `shortcutWalk` 沿折线每 2m 放船跑 `Track.constrain`，两条**最大漂移都是 0**
  （没有空气墙）；`shortcutMaskR=255`（近道脚下确实已冷却成航道）。

### 验收

- `npm test` PASS、`tests/guide_signs_audit.mjs` PASS（8 图方向/净空不受影响，
  magma 仍是稀疏版 35 块）、`tests/magma_shortcut_audit.mjs` PASS、
  `npm run build` PASS（1,553.66 kB / gzip 486.16 kB）。
- 新脚本 `tests/magma_hardcore_probe.mjs`（无头 Edge + CDP）：
  一次验完 4 道裂谷 / 0 跳板 / 抛飞关闭 / 9 个 GLB 全部加载 / 9 个静态代理 +
  9 个动态碰撞体都带高度范围 / 空中 A/B / 近道可通行 / 冷却遮罩，并出 3 张图：
  `shots/verify/magma-hardcore-{obstacles,fault,shortcut}.jpg`。
- 踩坑：物理 A/B 一次跑 72 帧会在同步里刷出大量水花特效，偶发把 Effekseer 渲染进程
  带崩（`texImage2D Overload resolution failed`）→ **截图必须排在 A/B 之前**；
  另外历史遗留的无头 Edge 进程树会占满 CPU 导致冷启动超时，收尾统一走
  `spawnSync('taskkill',['/F','/T','/PID',pid])`，不要 `child.kill()`。

---

## 四十五、无贴图程序化几何体 → 带贴图写实道具（2026-11-13）

> 用户指出竞速/道具模式 8 张图里的伸缩杆、纯装饰、近道门都是一坨纯色几何，
> 要求换成有贴图、契合赛道风格的道具。素材获取拍板为
> **「已经下好的就直接用，后面的用 Blender 建模」**，伸缩门形态定为
> **「中式龙宫石闸门」**。鸟居（`torii_japanese_gate_low_poly.glb`，672 面、
> 无贴图、纯红黑材质）风格与贴图都不达标，**未采用**。

### 资产（`public/models/props`，自建 + 程序化烘焙贴图）

| 文件 | 用在 | 面数 | 大小 | 材质 |
| --- | --- | --- | --- | --- |
| `shortcut_arch.glb` | 近道石牌坊 | 5192 | 633 KB | `portal_stone / portal_tile / portal_plaque / portal_gold` |
| `palace_gate_leaf.glb` | 龙宫升降闸板 | 7804 | 715 KB | `gate_stone / gate_bronze` |
| `palace_gate_frame.glb` | 龙宫门框 | 3140 | 491 KB | `gate_stone / gate_tile / gate_plaque / gate_gold` |
| `flow_marker.glb` | 指示浮标 / 潮流标 | 2046 | 224 KB | `marker_wood / marker_lamp` |

- 贴图全部由 numpy 值噪声现场烘：石材走砖式错缝 + 湿苔 + 麻点，瓦是半圆筒剖面
  的青瓦，木材是竖纹 + 板缝，匾额是深漆木 + 金边。颜色图 sRGB、法线图 Non-Color，
  **生成图必须 `img.save()` 落盘再导出**，否则打包成黑图。
- 造型：石牌坊是 4 分段锥形方柱 + 柱础 + 斗拱 + 主梁 + 匾额 + **重檐瓦顶**；
  闸板是石门板 + 上下冒头 + 66 颗青铜门钉 + 铺首；浮标是木桶浮筒 + 立体木箭头 + 指示灯。

### 接入（`src/game/Track.js`）

- 新增 `loadPropGlb`（模块级 Promise 缓存）与 `fitPropModel`：按目标跨度 / 高度上限
  等比缩放、底边贴 y=0、水平居中，再套 yaw 父节点。**碰撞窗口、升降动画、
  摆放参数全部留在 JS**，模型只负责外观。
- 四处替换：`#buildShortcutArch`（保留程序化兜底，成功后连 `sc.gem` 一起摘掉）、
  `#buildPalaceGate`（闸板与门框各一次）、`#buildGuideMarkers`、
  `#buildTideCurrent`。全部 `catch` 回落旧几何，离线照常可玩。

### 验证

- `npm test` PASS；`npm run build` PASS（`dist/assets/index-xccFg1aV.js` 1,556 kB）。
- 无头 Edge 实测（palace）：四个 GLB 全部 200 落地，`leaf.userData.isModel === true`，
  闸板实测 5.4m 高、抬升后底边 5.16m（升降动画正常），门框实高 10.93m，
  材质表里 `portal_* / gate_* / marker_*` 齐全，带贴图网格 90 / 273。
- 踩坑：CDP `Page.captureScreenshot` 在 swiftshader 下**第二次调用会挂死**，
  一次脚本只能稳定截一张；改为以 Blender `look(angles, rendered)` 复核造型与贴图。

---

## 四十六、金龙车体 / 导向牌立柱 / 浮标兜底 → Blender 贴图模型（2026-11-14）

> 用户点名最后三处纯色几何（金龙过山车车身、导向牌的黑色细杆、浮标加载失败时
> 的红圆柱兜底）仍然太简陋，要求 Blender 建模 + 精美贴图 + 优化拓扑 + 完整 UV。
> 沿用上一节的资产管线（numpy 噪声烘焙 + `img.save()` 落盘 + JPEG 84 导出）。

### 资产（`public/models/props`）

| 文件 | 用在 | 面数 | 大小 | 材质 |
| --- | --- | --- | --- | --- |
| `coaster_dragon_kit.glb` | 轨枕 / 背鳍 / 支撑柱 / 入水龙门环 / 龙首 | 25192 | 1.22 MB | `cs_gold / cs_red / cs_bronze / head_eye` |
| `guide_sign_post.glb` | 弯道导向牌木柱 + 青铜牌框 | 3020 | 265 KB | `sign_wood / sign_bronze` |
| `buoy_fallback.glb` | 浮标链兜底浮筒 | 4108 | 336 KB | `buoy_paint / buoy_white / buoy_iron / buoy_lamp` |
| `coaster_scale_col/nrm.png` | 主脊与两侧行轨（可平铺龙鳞） | — | 301 / 350 KB | 颜色 sRGB + 法线 Non-Color |

- 造型：轨枕是两端收窄的青铜枕木，背鳍是带锯齿脊的金/红两色鳍片，支撑柱拆成
  **柱础 + 可拉伸柱身 + 柱帽**三段（避免高度变化把贴图拉花），龙门环外圈金鳞 +
  内圈红漆 + 顶部龙冠；龙首是椭球颅骨 + 锥形吻部 + 三段龙角 + 11 根红鬃 + 发光眼。
- 浮筒：红漆桶身 + 白反光带 + 锈迹掉漆 + 系泊环/爬梯/灯罩栅栏 + 发光顶灯。
- 导向牌立柱：木柱（竖纹 + 板缝）+ 青铜底座/牌框/四角菱形饰/顶部脊饰/挂耳。

### 接入

- `Track.js` 新增 `#applyCoasterKit(fallback, ctx)`：GLB 按对象名前缀分桶
  （`tie / fin / pillar_* / ring_* / head_*`），同材质合并成 InstancedMesh；
  轨枕 `makeBasis(side, tan×side, side×up)`、背鳍带缩放、支撑按柱础/柱身/柱帽
  三批矩阵、龙门环按门宽缩放并 `lookAt`、龙首落在曲线 12% 处。
  程序化几何先建好作为兜底，GLB 成功后整体替换并 dispose。
- 主脊 / 行轨仍是 TubeGeometry（曲线必须绝对顺滑），只把材质换成龙鳞
  `map + normalMap`，UV 按 `coasterLen/3` 横向重复；管截面 10→16、6→10。
- `coasterGlowMats` 收集金色材质，`update()` 里做 0.45±0.30 的呼吸发光。
- `#buildBuoyFallback`：保留原圆柱 → 成功替换为浮筒 GLB（`fitPropModel` 1.9m 跨度），
  失败则继续用圆柱，永不出现空洞。
- `GuideSigns.js` 新增 `loadSignPostKit()`：按每个牌的柱脚矩阵建 InstancedMesh，
  成功后摘掉 `guide-signs-posts/bases`，材质并入 `signMats` 统一释放。
- `settingsPanel.js` 的 `SELF_MADE_PROPS` 追加三条署名。

### 验证

- `npm test` PASS；`npm run build` PASS（`dist/assets/index-BLInuKWk.js`
  1,561.78 kB / gzip 488.97 kB）。
- Blender 渲染逐个复核：龙门环、轨枕/背鳍阵列、龙首、浮筒、导向牌立柱
  贴图与拓扑均符合预期；导出前面数 25192 / 3020 / 4108，浮筒与立柱远低于
  2 万面预算，过山车套件是多对象合计（单件轨枕/背鳍都只有几百面，靠实例化复用）。
- 踩坑：`hazard_rock` 留在原点会挡住渲染，调试时把它移到 y=-60 复核完后
  **必须把所有对象 location 复位为 0**，否则 `export_apply=True` 会把偏移烘进 GLB。



## 四十七、联机同步真因排查 + 血包改版 + 天使特效 + 联机验收体系（2026-11-14）

### 用户报的那个 bug 的根因（不是"偶发丢包"）

「主机打完 BOSS 进门了，客机那边倒计时都没结束，之后永远卡在结算页，门也不出来」——

1. **`server/server.js` 的 `RELAY_TYPES` 漏了 7 个 BOSS 消息类型**（`bossPortal`、`bossReady`、
   `bossStagger`、`bossCoreWave/Hit/Win/WaveEnd`）。这一层是**白名单**：不在集合里的消息在
   `room.phase === 'racing'` 期间被**静默丢弃**。于是：
   - 客机永远收不到 `bossPortal` → 门永远不出来；
   - 主机永远收不到客机的 `bossReady` → `#advanceStage()` 凑不齐人 → 卡在结算页。
2. **客机的阶段机是本地推的**（intro/countdown/clear 靠自己的计时器）。浏览器把后台标签页的
   `requestAnimationFrame` 节流到几乎不跑，切回来还停在 countdown，而主机早就打完开门了，
   中间没有任何"以主机为准"的纠正。
3. `clear` / `portal` 两个阶段**完全不发 `bossState`**，最长十几秒没有状态流；
   客机只要在这段时间里漏一次 `bossPortal`，就再也没机会拿到门坐标。
4. 客户端 `Game.js` 的 `handleNet` 注册表也漏了 `bossAltarSpawn` / `bossAltarDone`
   （第四关祭坛在联机里等于死的）。

修法：
- `RELAY_TYPES` 补齐（并加注释说明"漏一条 = 什么现象"）。
- `#sendSync` 带上 `px/pz`：门坐标随 10Hz 状态流一起下发，不依赖那一条一次性消息。
- `clear` / `portal` 阶段继续 `#sendSync`。
- 新增 `#adoptHostState(msg)`：**只往前拉、不往回拽**——
  关卡落后就直接 `startStage`；主机已 clear/portal 而客机还在打，就让 BOSS 走一次正常
  死亡流程（结算面板/特效/统计照常触发）；主机在 portal 而客机没有门，就用下发的 `px/pz`
  补开一道，**绝不允许客机自己抽签**，否则两端看到的是两道门。

### 血包改成 30 秒随机刷新

`BOSS_HEAL_PACK` 从「开局常驻 3 个、吃掉 30 秒换位」改为 `{ interval: 30, first: 20, max: 3 }`：
- 刷新**只由主机摇点**并广播 `healSpawn`。以前每台机器各自 `Math.random()` 选点，
  联机时两端看到的绿盒子根本不在一个地方（走过去吃不到）。
- 拾取本机判定 + 广播 `healPack`，另一边把同一个位置收掉。
- 场上数量直接由 `healPacks.length` 反映（倒序遍历删除，不再有 `active/timer` 那套空转字段）。

### 天使庇佑补特效

以前 `case 'angel'` 只改状态，屏幕上除了 toast 什么都不多。现在三层：
跟随船的圣光 `fxBenediction`（`#boatBarrier` 循环挂载）+ 脚下一次 `fxMagic2Holy` 符文阵
+ `ring` 冲击环。和护盾的蓝色 Barrior01 刻意区分。

### 聊天不再压住协同条

`#chat-root` 是 `#hud` 的兄弟节点，所以用兄弟选择器就能按模式改位置：
```
#hud.boss-mode ~ #chat-root #chat-game-bar,
#hud.boss-mode ~ #chat-root #chat-game-log,
#hud.arena-mode ~ #chat-root #chat-game-bar,
#hud.arena-mode ~ #chat-root #chat-game-log { bottom: 104px; }
```
同时去掉「（无线电）」前缀，只显示「昵称：内容」。

### 新建的联机验收（这两个是这一节的核心资产）

- `tests/net_stability.mjs`（纯 WS，秒级）：中继白名单全覆盖 41 条 × 双向实打、
  比赛进行中新来的人不拆局、断线重连 15s 座位保质、僵尸局自愈、4 人 20Hz 推快照的
  丢包/延迟/抖动。**中继清单是"玩法依赖"，不是从实现里抄的**——实现少一条这里就红。
- `tests/boss_client_sync.mjs`（房主 = 裸 WS 脚本，客机 = 真浏览器）：专门复现上面那个 bug。
  断言的是"客机自己能不能追上"：卡在 countdown 时收到 `bossState(stage:2)` 要能拽过去、
  BOSS 死亡通报要走完正常死亡流程、`portal` 必须和主机**同坐标**、只收到一条 `bossPortal`
  也要能开门、`bossState` 在客机侧按接近 10Hz 落地。

### 顺手修掉的历史脚本坑（会让结论变成假阳性）

- 无头探针**必须先等静态服务就绪再启 Edge**，否则首页拿到 ERR_CONNECTION_REFUSED，
  页面停在错误页，所有断言都成了"没加载完"的假失败。
- 固定 `--user-data-dir` 会被上一轮残留实例锁住 → 改成按时间戳建目录。
- 大厅改版后 `.boat-card / #btn-boat-ok / #mode-select / #btn-map-ok` 这一串是**半死**的：
  `#btn-boat-ok` 才会触发 `renderVesselMapPanel()` 去给 `#mode-select` 填选项；
  模块加载快慢不定时 `.boat-card` 还没渲染，点它就是静默 no-op，
  最后 `#btn-map-ok` 因为"还没选艇"直接 return，页面永远没有 `__game`。
  新脚本一律走 `#btn-solo → #lobby → #btn-lobby-boat/[data-boat] → #btn-lobby-mode/[data-mode] → #btn-start-race`。
  单人 AI 陪练现在是 `#sel-ai`（大厅设置抽屉），老的 `#solo-ai` 已经没有任何监听器。
- `arena_smoke.mjs` 在本机无头环境仍会**偶发渲染进程崩溃**（`Execution context was destroyed`），
  属于软件光栅 + Effekseer 的老问题，不是玩法回归；它跑到 ⑩ 之前的所有断言都是绿的。

### 验证

`npm test` PASS ｜ `net_lobby` PASS ｜ `arena_net` PASS ｜ `net_stability` 全绿
（RTT p50=1ms p95=1ms，4 端收到帧数极差 0）｜ `boss_client_sync` 全绿
（bossState 实测 8.6/s）｜ `arena_net_e2e` 全绿 ｜ `boss_gameplay` 全绿
（含血包计时刷新、天使 attached=true、聊天条 104px）｜ `boss_items_fx` PASS。

### 补充：竞速 / 道具模式联机排查（同日）

BOSS 模式那套"主机跑 AI、客机跟阶段机"在这两个模式里不存在——每个人各跑各的，
服务器只做「快照聚合 30Hz + 进度名次 + 结算」。所以另开了一份验收
`tests/race_item_net_e2e.mjs`（房主 = 裸 WS 脚本，客机 = 真浏览器），逐项打：

| 项 | 断言 | 结果 |
| --- | --- | --- |
| R1 | 竞速开局名单 = 2 真人 + 1 AI，客机场景里 3 条船 | ✓ |
| R2 | 主机代报 AI 的 `state{auth:true}` → 客机那端的 AI 艇真的跟过去 | ✓ |
| R3 | 别人过门进度同步（客机 `progressMap` 存的是"下一个门"，房主过完 3 号 → 客机看到 4） | ✓ |
| R4 | 别人冲线 → 客机亮出完结观察期倒计时 | ✓ |
| R6 | 单局制打满 → `raceEnd` → 客机走到最终结算、名次真实 | ✓ |
| R7 | 房主 `backLobby` → 客机跟着 `lobbyReset` 回大厅 | ✓ |
| R5 | 多局制第 1 局结束 → `roundEnd`（不是 raceEnd）→ 客机进领奖台 | ✓ |
| I1 | 客机本地道具箱 48 个，布点由赛道几何算（跨端一致） | ✓ |
| I2 | 别人吃 3 号箱 → 本地同一个箱子立刻消失 | ✓ |
| I3 | 别人的炸弹 → 本地出现 `ghost` 弹道（只飞不结算） | ✓ |
| I4 | 别人减速命中 → 本地 `slowTimer = 1.6` | ✓ |
| I5 | 方向转换器命中 → 本地操控反转 5s（必须在 `myId` 早退之前处理） | ✓ |
| I6 | 别人落雷 → 本地出现预警圈 | ✓ |
| I7 | `#buildBoxes` 里不许有 `Math.random`（一用 `boxIdx` 就跨端错位） | ✓ 静态守卫 |

**顺带修掉一个真实缺陷**：`Game` 构造里用 `renderer.compileAsync()` 做着色器预热，
它内部的 `KHR_parallel_shader_compile` 轮询会和 `dispose()` 抢——这一局很快结束、
玩家立刻退赛、或换模式重开时，材质已经被释放，轮询仍去读 `program.isReady()`，
抛 `TypeError: Cannot read properties of undefined (reading 'isReady')`。

危害在于它**每次快速重开都会在控制台留一条 uncaught 异常**，联机自测时极易被误判成
真实 bug，而且会打断 three 的预热轮询。改成同步 `renderer.compile()`（包 `try/catch`）：
只多花几十~几百毫秒，而且发生在开赛前（倒计时遮罩之下），换来零竞态。
改完 `tests/race_item_net_e2e.mjs` 的"客机全程无页面异常"才是真的干净。

### 补充二：`arena_death.mjs` 迁到大厅后的一场假失败（2026-11-14）

现象：`arena death: FAIL timeout waiting for game boot`，但诊断打出来 `game: "object"`、
HUD 也起来了 —— 只是 toast 写着「单人练习（R 复位）」，说明**进的是竞速而不是竞技场**。

根因不在产品，在脚本拼字符串：探针的 `ev()` 是把表达式**原样**塞进页面执行的，而

```js
await ev('document.querySelector("#lobby-pick-body [data-mode="arena"]").click()');
```

生成的页面代码是 `document.querySelector("#lobby-pick-body [data-mode="arena"]")` ——
内层 `"arena"` 把外层字符串提前截断，页面拿到的是 **SyntaxError**，`ev()` 把它吞成
`EXC:` 返回值，点击静默变成 no-op。船没选、模式还是默认 `race`，于是
`!!window.__game.bossMode` 永远不成立。

- 迁移时 `waitFor` 那几行用的是反引号 + 单引号，**是对的**；只有两处 `.click()` 用了
  双引号套双引号，所以表现成"抽屉等到了、点了没反应"这种极难对号的假象。
- 修法：脚本里所有带属性选择器的表达式一律写成 ``ev(`document.querySelector('#x [data-y="z"]').click()`)``；
  若坚持用单引号外壳，内层双引号必须 `\\"` 转义（`arena_smoke` / `boss_gameplay` 都是这么写的）。
- 顺带把 `--user-data-dir` 也改成时间戳目录，避免复用旧 profile 被残留实例抢走 URL。

改完 `arena death: PASS`（16 项全绿：被打沉 / 阵亡面板写明凶手与剩余生命 / 死亡镜头
y≈6~7.5 不潜水 / 自动复活 / 相机切回船后 / 命打光改说"出局" / 进回合结算 / 全程无异常），
`npm run test:arena` 三步（smoke / death / net）全绿。

---

## 四十八、熔岩障碍「贴图 + 烘焙」与逐天气火山调色（2026-11-14）

> 两条用户反馈：
> ① 「玄武岩柱 / 熔岩尖刺 / 黑曜石刃好丑，就像啥都没得的几何体，加点贴图和渲染，烘焙一下。」
> ② 「整个地图比较暗，各个天气下区别不开，有什么办法能让它适应各个天气？」
>
> ①的根因很明确：上一轮 3 个 GLB 里只有 `POSITION/NORMAL/COLOR_0`，**没有 UV、没有贴图**，
> 295 个顶点全是硬面平涂，凑近就是三根切过的石头棱柱。
> ②的根因在 `Game.#themeWeather`：熔岩图把 `weather.id` 写死成 `'starry'`，
> 而 RealSky 的 `SKY_PRESETS`、NightSky、昼夜循环、水面的泡沫分档、后处理调色档
> **全都只认 id** —— 于是无论玩家选晴朗/黄昏/暴风雨/暴雪，天幕都是同一片星空。

### 一、障碍重做：盒式投影 UV + 无缝平铺贴图 + 射线烘 AO

| 项 | 旧 | 新 |
| --- | --- | --- |
| 几何 | 36 面硬棱柱（无细分） | 细分 2 次 + 沿法线 fbm 起伏（586 / 372 / 378 三角面） |
| UV | 无 | 盒式投影（按面主轴选投影平面，UV = 世界米 × 1/3.4m） |
| 贴图 | 无 | `basalt_/obsidian_albedo.jpg`（1024² sRGB）+ `*_emissive.png`（256²） |
| 顶点色 | 面级硬编码色块 | BVH 射线半球采样烘 AO × 近地余热（`COLOR_0`） |
| GLB | 4.6~6.2 KB | 152~182 KB（含贴图，3 个原型只共用 4 张贴图） |

**为什么不做「逐物体 Cycles 烘焙」**：盒式投影的 UV 天然是重叠的（同一个面在
+Y/−Y 两个方向共用一段 UV），逐物体烘焙必然是脏图。改成**可平铺贴图 + 世界尺度 UV**
之后，一块 3.4m 的石头自然铺 1.4 个循环，四边无缝、零接缝，代价只是 1 张图给 3 个模型复用。

贴图在 numpy 里按**周期噪声**现场烘（`pnoise2` / `pvoronoi` 自带 %freq 环绕）：

- 岩石：三层 fbm 叠 `dark→mid→light`，再乘一层 Voronoi 胞元色偏（每个石块一点独立色调）；
- 火山灰斑、矿物亮粒、气孔：全部用高频噪声阈值（**不要用 Voronoi 做气孔** —— 会排成规整蜂窝，
  第一版就是这么翻车的）；
- 熔岩裂纹：`d2-d1` 取 Voronoi 胞界，再乘一层稀疏化噪声，只有约 1/3 的节理在发光；
  由外到内三层 = 烤黑圈 → 暖色余辉 → 亮芯，读起来才像"壳被顶开"。

顶点色的 AO 用 `BVHTree.FromObject` + 14 条固定半球方向射线（`maxd = 0.75×高`），
`ao = 0.46 + 0.54×ao^1.15`，再叠一层"越靠近熔岩面越暖"的偏移（底部 1.62×红、0.84×蓝）。
glTF 里 `COLOR_0` 与 `baseColorTexture` 相乘，等于 gratis 一圈接触暗部。

接入（`Track.#buildMagmaObstacles`）：

- `tuneMagmaMat` 收口材质：`wrapS/T = Repeat`、`anisotropy = 4`、
  `emissiveIntensity = 1.15`、`envMapIntensity = 0.8`、`metalness = 0`。
- **实例级 UV 偏移**：9 块石头若共用一段 UV 会露出同一块花纹。几何只有 ~300 顶点，
  克隆一份几何平移 UV 比克隆贴图便宜得多，材质仍然共享 → draw call 不变。

### 二、逐天气火山调色

`maps.js` 的 `lava.weatherBy` 五档，`Game.#themeWeather` 改成
`{ ...base, ...palette, id: base.id }` —— **id 保留玩家选的那个**，只覆盖颜色/光照/雾/云。

| 天气 | 名称 | 太阳 | 天光 | 雾密度 | 浪高 | 天幕（`sky` 覆写） |
| --- | --- | --- | --- | --- | --- | --- |
| `day` | 熔岩白昼 | 1.85 | 1.05 | 0.0013 | 1.15 | 暖白尘霾 `tint fff2e4` + 橙褐地平线 |
| `dusk` | 熔岩黄昏 | 1.30 | 1.05 | 0.0020 | 1.50 | 橙红天幕 + 低垂红日 |
| `storm` | 熔岩雷暴 | 0.90 | 1.00 | 0.0050 | 2.25 | 灰紫压暗 + `overcast 1.0` + 雨 |
| `blizzard` | 熔岩雪暴 | 0.72 | 1.30 | 0.0058 | 1.55 | 亮灰白雪幕 + 雪 |
| `starry` | 熔岩星夜 | 1.05 | 1.35 | 0.0017 | 1.65 | 深蓝紫夜空 + 星空 |

三个新增的通用能力（都不影响其它地图，键缺省即老行为）：

- `RealSky.setWeather` 支持 `w.sky` **逐键覆写**（turbidity/rayleigh/mie/cover/overcast/
  haze/tint/exposure/sat/halo/sunDisc/nightMix/nightColor/top/horizonColor/cloudLight…）。
  这样不用新增天气 id，也不用改全局 `SKY_PRESETS`。
- `Environment.setWeather` 支持 `w.fogDarken`（暴雨原来硬编码 ×0.34，熔岩雷暴压那么狠
  会把远景火山群彻底抹掉，改 ×0.62）。
- `Environment.setWeather` 支持 `w.noDayCycle`（熔岩白昼不能跑动态昼夜循环，
  循环会重写太阳/雾/天光，把这套火山调色冲掉）。

`#themeWeather` 还把 `sky.top / sky.horizonColor` 同步到 `skyTop / skyBottom`：
Water 的反射底色读的是这两个键，只有 RealSky 认得 `w.sky`。

旧版 `lava.weather` 保留（星夜那一档的老写法），给老版本联机房主下发的字段兜底。

### 三、验收

- `npm test` PASS（新增 2 组断言：五档 palette 完整性/亮度梯度，GLB 必须带
  `TEXCOORD_0 + baseColorTexture + emissiveTexture + COLOR_0`）。
- `tests/magma_shortcut_audit.mjs` / `tests/guide_signs_audit.mjs` PASS。
- `npm run build` PASS（`dist/assets/index-CVsHQYbc.js` 1,587 kB）。
- **新增 `tests/magma_weather_probe.mjs`**：走真实玩家路径（reload → 单人 → magma →
  选天气 → 开赛）跑五档，断言五档 id 互不相同、`tint/horizon/fog` 两两不同、
  白天比星夜更亮更通透、雷暴有雨、雪暴有雪、星夜有星空、岩石带 UV/贴图/RepeatWrap，
  并出 7 张图（5 张同机位 + 白昼/星夜各 1 张近机位）。
  实测：`day sun 2.109 / fog #b8a89b`、`dusk 1.482 / #40201f`、`storm 1.026 / #2d252b`、
  `blizzard 0.821 / #d9d3d9`、`starry 1.197 / #241224`。

### 四、踩坑

1. **第一版贴图是"碎玻璃球"**：Voronoi 胞界全开、裂纹无稀疏化，加上用 Voronoi 做气孔，
   整张图是一层规整蜂窝网。修法：气孔改高频噪声阈值；裂纹乘 `smoothstep(0.48,0.70,fbm)`
   只留约 1/3；胞元接缝强度压到 0.20。
2. **第一版岩石是纯黑剪影**：palette 的 `dark` 给到 `#382a2c`，再乘 AO 0.34 下限，
   夜里只剩轮廓。抬到 `#443434` 并把 AO 下限提到 0.46。
3. **星夜天幕第一版发紫红**：`horizonColor 0x7a3230`（暖红）叠 `tint 0x3d2c58` 混出洋红。
   改成 `horizonColor 0x5c3a4e` + `tint 0x363059` 才是"深蓝紫底 + 地平线火山余辉"。
4. **CDP `Page.captureScreenshot` 在 swiftshader 下第二次调用必挂死**（四十五节也记过）。
   这次干脆不用它：页面内 `g.post.render(1/60)` 之后**同一任务**里
   `renderer.domElement.toDataURL('image/jpeg')` —— 不受 `preserveDrawingBuffer=false`
   影响，一次脚本稳定出 7 张。以后所有需要多图的探针都走这条路。
5. `img.save()` 落盘再导出这条铁律继续有效（不落盘 GLB 里是黑图），并且落盘后要
   `img.pack()` 才会嵌进 GLB。

## 四十九、道具赛新道具六件套 + 反超/保底机制 + 联机马拉松验收（2026-11-14）

### 新增道具（全部走既有 `itemUse/itemHit/itemFx`，服务器零改动）

反超组（落后权重高）：
- **血枪狙击 bloodlance**：直线贯穿弹（110m/s，0.58s 寿命），`p.pierce/p.hitSet/p.onlyAhead`
  —— 命中一个继续飞，能连穿两人；被护盾挡也只是"挡住那个目标"，弹体继续。命中减速 2s。
- **圣光沙暴 holystorm**：罩住第一名方向落点的 14m 区域 4s，区内减速 + 糊眼。
- **逆流之门 gate**：瞬移到"前一名"身后 10m（`gx/gz` 随 itemUse 广播落点）。
- **剑刃风暴 bladestorm**：跟随施法者的 12m 旋刃圈 3s，圈内减速 + 单次弹开（0.28s 眩晕）。

防御组（领先权重高）：
- **圣域 sanctuary**：身后落 8m 圣域 6s，进入者减速 + 持续往外推（直接写 `boat.vel`，
  施力会被 Boat 的每帧重解吃掉）。
- **护盾墙 barrier**：身后展开 14m 墙 4s，用「帧位移线段 × 墙线段」判交，
  **只挡别人的弹**（同 owner 跳过，因为本机弹自己会结算）。

特效：`fxHolySandstorm=P1_HolySandstorm(0.5)`、`fxGateOfCalve=P2_GateOfCalve(0.4)`、
`fxSwordStorm=P2_SwordStorm(0.36)`（Effects.js）。`MagicArea`/`BloodLance` 目录没有
fxres.json，仍禁止 FX_PACK。

### 配套机制

- **领跑屏蔽**：`t < 0.25`（第 1 名附近）时 `LEAD_BLOCK_ITEMS` 权重清零 —— 领先者
  抽不到纯攻击道具，只能拿防御。
- **连败保底**：4s 窗口内连续 2 次攻击白给（`#noteAttackUse`/`#noteHit`）→
  `#rollFor` 强制从 `COMEBACK_POOL ∩ itemPool` 里给。`pity` Map 按船记录。

### 实现要点

- 区域类道具（zone）**只广播一次** `itemUse{item,x,z,hx,hz,r,dur}`，各端 `#spawnZone`
  本地建网格；效果结算 `#applyZoneEffects` 只落到「本机权威的船」（自己 / 主机代算 AI），
  跨端天然一致、零逐帧同步。
- `ItemManager` 新增 `zones/zoneSeq/pity/clock/wallBlocks`（wallBlocks 是给测试观测用的
  计数器）。`#updateZones/#disposeZone/#segCross/#blockedByWall/#zoneMat/#makeBloodLance`
  均在 Items.js。
- **区域视觉必须克制**：圣光沙暴的 14m×7.5m 半透明圆柱会把机位整个包住 —— 全屏
  additive overdraw 在软光栅上一帧几十秒（表现为 CDP 静默超时），已改成地面圈 +
  1.6m 薄雾筒；圣域筒高也压到 1.8m。真实 GPU 无碍，但这验证了「特效体积别裹住相机」。

### 验收：tests/item_marathon.mjs（`npm run test:items:net`，ROUNDS 控轮数）

裸 WS 房主 + 无头 Edge 客机，每把 N1~N10：箱子跨端布点、新特效加载（fxres.json 轮询）、
血枪双向 ghost、沙暴/圣域/剑刃生效、门瞬移落点（**同步单 evaluate 测距**，分开测会被
帧间隔污染）、护盾墙拦弹（wallBlocks）、区域到期自清理（**泵 items.update 推进游戏时间**
，无头墙钟 20s 只有 1~2s 游戏时间；泵完必须清 boat.vel，否则圣域推力累积到 100+m/s
真实帧恢复后弹射撞墙）、零页面异常、raceEnd 结算、回大厅。轮换深查 D1 四区域共存 /
D2 穿透标记 / D3 保底 / D4 领跑屏蔽 / D5 十二弹道压力。
测试卡死诊断：evaluate 超时自动 `Debugger.enable + Debugger.pause` 抓 V8 调用栈。

## 五十、竞技场环形看台：去掉山脉，围出「真正的竞技场」（2026-11-14）

### 改动

- **`src/data/bosses.js`**：`BOSS_ARENA` 加 `noMountains: true`（顺手删了重复的
  `mountStyle` 块）。竞技场模式不再建三层远景山脊；怪物模式不受影响 ——
  BossThemes 本来就 `setTerrainVisible(false)` 整组隐藏通用远景、主题自带火山/海岛，
  `setMountainTint`/`#syncMountainLight` 都有 `!this.mountains` 空守卫。
- **`src/game/LakeStadium.js`**：导出 `buildStandGeometry / buildScreenGeometry` 与
  `ROWS/RISE/TREAD/SEAT_TOP/ROOF_Y`，竞技场看台复用同一套模块几何。
- **`src/game/ArenaStadium.js`（新）**：环形看台层。
  - 看台沿圆周均布（`rc = boundary.r + 7 + STAND_DEPTH/2 ≈ 105.5`，数量按周长/(
    STAND_LENGTH+豁口) 取整 → 12 座），相邻之间留 ~12m 豁口当观众入口，豁口两侧立灯柱；
  - **程序化观众人偶**：两套姿势各合并成一个几何（坐观=躯干+头+垂臂；
    欢呼=V 字高举双臂），`InstancedMesh` 按 per-instance color 上色
    （主队蓝红 + 中性浅色，确定性 `hash3`，禁 Math.random）；
  - **人浪**：欢呼人偶（约 4 成，后排更多）相位 = `角度×3` → 三道浪绕环传播，
    `update(t)` 只重算欢呼批次的实例矩阵（DynamicDrawUsage，~700 实例/帧）；
  - 彩旗串挂顶棚前沿，每三座看台挂一座「激流竞技场 ARENA」VS 计分大屏；
  - 纯视觉零 colliders，不碰边界/物理；~6 个 draw call。
- **`src/game/Game.js`**：`isArena` 时 `createArenaStadium(scene, mapDef)`，
  update/dispose 与 lakeStadium 并列。

### 验收：tests/arena_stadium.mjs（并入 `npm run test:arena`）

无头探针 13 项断言全绿：山脊不存在、看台 ≥8 围环、观众数百、欢呼占比、
大屏/彩旗/灯柱、看台全在硬边界外、零新增碰撞体、人浪矩阵随 update 变化、
零页面异常；截图 shots/verify/arena_stadium{,_inner}.jpg（俯瞰 + 场内低机位，
人偶/彩旗/大屏肉眼可辨）。回归：`test:arena` 三项 PASS、`test:boss` 两项 PASS、
`npm test` PASS。

## 五十一、竞技场看台三项增强：无缝环 / 实时比分牌 / 开场动画（2026-11-14）

### 无缝环形看台（ArenaStadium.js 重写布点）

- 看台中心落在**正多边形内切圆（apothem）**上、X 轴取边方向：
  `ap = (STAND_LENGTH − JOINT_OVERLAP) / (2·tan(π/n))`，重叠量 2.4m →
  相邻端墙互相咬合，整圈**完全无缝**（用户要求去掉豁口）。
- n 取「apothem ≥ boundary.r + 4 + 半进深」的最小值（=16），前沿距硬边界 ≈6m；
  弦长 = (L−ov)·cos(π/n) ≈ 40.8 < 44，接缝重叠 ~3m。
- 照明杆改挂看台后沿（没有豁口了），灯臂朝场心。

### 每座看台一块实时比分牌

- `createArenaStadium(scene, arenaDef, { scoreProvider })`：Game 注入
  `() => this.bossMode?.getScoreboard?.()`；ArenaMode 新增 `getScoreboard()`
  （双方名字/局分/血量/局数/阶段）。
- 全部比分牌共享**一张 CanvasTexture**：update 每 0.5s 拉一次 provider，
  内容序列化有变才 `needsUpdate` 重绘（局分+血量条+阶段提示；血量量化进 key，
  不会逐帧重绘）。

### 开场动画（ArenaMode）

- `ARENA_RULES.CINEMA_TIME = 7`，**只整场第一局**生效：期间 `cinema` 递减、
  倒计时冻结（HUD 不显示 3-2-1），结束后照常 3 秒倒数。两端时长一致 → 相位机天然同步。
- 相机：`#buildCinemaPath()` 构造时用 CatmullRomCurve3 算好
  高空俯瞰(0,58,148) → 压向场内 → 沿看台内侧环扫(半径88,高8~11) → 自己船尾后上方(13m)；
  `updateCamera` 在 cinema 期间接管（返回 true，Game 已有 `!cinematic` 分支跳过 CameraRig）。
  smoothstep 缓动；注视点前 70% 看场心、后 30% 渐转自己的船。
- 标题浮层 `#arena-cinema`（竞技场 PVP · XX vs XX · 三局两胜）由 ArenaMode 自建 DOM，
  最后 1.2s 线性淡出，dispose 摘除。
- 结束瞬间 `onCinemaEnd` → Game `cameraRig.snapTo(localBoat)`：同步 CameraRig 内部
  heading/高度低通，无甩镜头交接。
- **`?arenaCinema=0` 一键跳过**：无头软光栅 1~3fps 下 dt≤0.05s 钳制会把 10s 游戏时间
  放大成两三分钟真实时间。`arena_net_e2e` 的浏览器 URL 已带上这个参数。

### 测试影响

- `tests/arena_stadium.mjs`：24 项断言（无缝弦长 ≤ 台长、每台一块比分牌、
  比分实时刷新、cinema 接管相机/快进到 fight/浮层淡出、两帧动画截图）。
- `arena_death` / `arena_smoke`：fight 等待 30s/25s → **150s**（动画 7s + 倒计时 3s
  在低帧率下被放大）；这两条保留完整动画路径做覆盖。
- 回归全绿：arena_stadium / arena_death / arena_smoke / arena_net / arena_net_e2e /
  test:boss ×2 / npm test。

## 五十二、大厅体验三项：展示台鼠标拖动 / 聊天贴列表 / 迎宾横幅（2026-11-14）

### ① 展示台鼠标拖动（BoatShowcase.js）

- pointerdown/move/up 拖动：水平 → `userYaw` 左右转身（可整圈，0.012rad/px）；
  垂直 → 机位高度 `userCamY` 1.5~4.6（俯仰）。松手 3 秒后平滑交还自动摆头。
- 混合系数 `manual`（0~1，dt*3.2 缓动）：自动/手动两套姿态按它插值，接管与交还都不跳变。
- canvas cursor grab/grabbing、`touch-action:none`；`setPointerCapture` 包 try/catch
  （合成事件 / 指针失效会抛 NotFoundError）。

### ② 聊天框不再遮玩家列表（Chat.js placeLobby + index.html）

- 根因：`#chat-lobby` 固定 `left:34px; bottom:168px`，正好压在玩家列表上半截
  （列表 z-index 3 < 聊天 24）。
- 新增 `Chat.placeLobby()`：打开/peek 时按 `.lobby-roster-wrap` 的实时 rect 定位 ——
  左对齐列表（+12px）、底沿贴列表上沿（+10px）；`renderLobbyNow` 与 window resize 时重算。
- 高度自适应：可用空间 = 列表上沿 → 标题下沿；消息区 `maxHeight` 钳 40~172px，
  **`minHeight` 必须一起压**（CSS 里 min 优先于 max，不压则矮窗照样顶进标题）。
- CSS 给 `#chat-lobby` 的 transition 加了 left/bottom，名单增减时位置平滑移动。

### ③ 迎宾 / 送客横幅（main.js + index.html）

- `#lobby-welcome` 挂 `.lobby-stage` 顶部居中：金色胶囊（欢迎） / 灰木色（离开），
  4s 淡出，一次一条新的顶旧的。
- 触发：`net.on('roster')` 里对比上一份名单找出新进真人（排除 AI 与自己；首份名单
  prev 为空 → 自己进房天然不弹；断线重连者一直在名单里不会误弹）。
- **坑：`welcome` 处理器自组名单、不走 roster 处理器** —— 必须在 welcome 里同步播种
  `prevRosterPlayers`，否则 diff 永远拿不到前值、横幅不弹（首版就栽在这）。
- `net.on('left')` 时名单还没更新，正好查到离开者名字，弹灰色提示。

### 顺手修的既有 bug

- **Esc 收聊天会同时弹出设置面板**：main.js 的 window Esc 处理器和 Chat 的 Esc
  处理器同挂 window（stopPropagation 挡不住同节点监听）。main.js 侧加
  `if (chat?.lobbyOpen || chat?.gameOpen) return;`。

### 验收

- `tests/lobby_ux.mjs`（`npm run test:lobby`）：14 项断言全绿 —— 拖动转身/抬机位/3s
  交还、聊天贴上沿/不顶标题/自适应钳制、欢迎横幅出现+4s 淡出、离开灰色提示、零页面异常。
  截图 shots/verify/lobby_welcome_chat.jpg。探针用 Emulation 1600×900
  （headless 默认视口 ~800×637 会把布局断言假挤压）。
- 探针内发现：Enter 开聊天前若有设置面板开着会互相抢焦点 —— 与本轮无关，未动。
- `npm test` PASS。

## 五十三、区域道具去几何化：Three.js 光圈/圆筒全部换成 Effekseer（2026-11-14）

### 用户反馈

「剑刃风暴 / 圣域 / 护盾墙外面罩着一个又大又丑的 Three.js 光圈，换成 effekseer 特效。」

### 排查结论（今天新增的 6 件里 4 件有几何）

| 道具 | 原 Three.js 几何 | 处置 |
|---|---|---|
| 圣域 | 8m×1.8m 半透明圆柱 + 地面圆环 | 删光，改「8 团圣光尘雾围成结界 + 中心金光」 |
| 剑刃风暴 | 旋转 torus 圆环 + 地面圆环 | 删光，改「20 道刀光绕圈 + 4 团剑刃旋风」 |
| 圣光沙暴 | 14m 地面圆环 + 薄雾圆筒 | 删光，改「外圈 8 + 内圈 4 团尘卷」 |
| 护盾墙 | 14×3.4m 平面墙 + 高光条 | 删光，改「3 个青色半球罩压叠成力场墙」 |
| 血枪狙击 | 鱼叉是细长武器网格（非光圈） | 保留 |
| 逆流之门 | 无几何，纯 fxGateOfCalve | 保留 |

`#zoneMat()` 随几何一起删除；`#spawnZone` 现在只往 `fx.playAttached()` 登记实例，
`zone.fxKeys` 记录所有实例键，`#disposeZone` 逐个 stop（多段拼接的墙/剑刃风暴也能清干净）。

### 素材实测（重要，别再凭名字猜）

建了 `tests/fx_sheet.mjs`（`shots/fxsheet/` 21 个候选 × 3 档缩放）与一次性旋转试验，实测：

- `fxMagic2Holy`：**正对相机的符文圆盘**，`handle.setRotation` 对它无效（放不平地）；
  且小尺寸几乎不可见、8 倍缩放才显形 → 不能拿来做地面法阵或墙段（试过，放弃）。
- `shield`(Barrior01)：青色**半球罩**，2 倍≈8m，260ms 就成形 → 拿来做护盾墙。
- `fxHolySandstorm`：白灰尘卷，4 倍≈8m，持续可见 → 沙暴 / 圣域结界都用它。
- `fxBenediction`：1 倍≈10m 的柔和大金光，拉大就糊成一片 → 只做小尺寸中心核心。
- `fxSword1`：贴图集**放大到 ≥1 会整块露成方片**，必须 ≤0.7 小尺寸多实例。
- `antimagn`(Barrior03) 是躺平的小金环（之前"黄圈圈"的真凶）；`tornado`/`fxSwordStorm`
  在 260ms~1.1s 采样点都几乎不可见，不适合做常驻区域视觉。

### 另一个真问题：特效"表项在但不可播放"

首轮验收出现 `fxN=12 / attached=0`：`fx.effects[name]` 已登记，但 `ctx.play()` 仍返回 null
（efk 二进制还没就绪），区域挂上了却什么都不显示。测试就绪门禁改成**逐个试播一次再 stop**，
不能只查表项存在；`tests/item_manathon` 里 `items.fx = null` 的逻辑测试不受影响。

### 验收

- `tests/item_zone_visual.mjs`（`npm run test:zones`）：四类区域 **group === null**（零几何）、
  特效实例全挂上（12/9/24/3）、**到期后实例全部停止（不留幽灵）**、四张截图落盘、零页面异常。
- 回归：`item_marathon` 单轮 PASS（20 断言）、`npm test` PASS（顺手把 `red_buoy_chain.glb`
  那条陈旧断言改成「旧 GLB 已退役」，Track.js 早已改程序化浮标）。
- 截图：`shots/verify/zone_{holystorm,sanctuary,bladestorm,barrier}.jpg`。

### 性能提醒

单个区域最多 24 个 Effekseer 实例（剑刃风暴）。真实 GPU 下没问题，但如果 4 人同时丢
剑刃风暴出现掉帧，优先把 20 道刀光降到 12、4 团旋风降到 2。

## 五十四、竞技场看台加高 + 比分牌抬高 + 道具赛氮气条 + 暗黑锻铁 HUD（2026-11-14）

### 用户四条诉求

1. 竞技场看台有点矮，拉高一点，尽量把后面的天空露出来；
2. 看台上面的比分牌有部分被遮挡，位置太靠下，请放到看台上方；
3. 道具赛模式下右上角氮气条也要显示（现在没有）；
4. 竞技场 HUD 按参考图改成「暗黑锻铁 + 黄铜镶边 + 深红宝石血槽 + 米白衬线字」。

### 一、看台加高（纯参数，湖泊看台零变化）

`buildStandGeometry(opts)` / `buildScreenGeometry(opts)` 全部参数化，**不传就是原值**，
所以 `LakeStadium.js` 的湖泊看台一个像素都没动。

| 项 | 湖泊（原值） | 竞技场（新） |
|---|---|---|
| 排数 `ROWS` | 6 | **10** |
| 座位顶 `SEAT_TOP + rows*RISE` | 9.8m | **15.4m** |
| 顶棚 `roofY` | 12.4m | **18.0m** |
| 看台几何最高点（雨棚面 / 柱顶） | 12.9m | **18.5m** |

只加排数，每排高差 1.4m / 排距 1.9m 保持美术定过的值 —— 拉高靠「多排」而不是「每排变陡」，
观众视线比例不变。抬头仍能看到一整圈天空（截图见 `arena-stand-mid.jpg`）。

### 二、比分牌被遮挡的两层真因（不是"位置太低"这么简单）

- **坑一（原地挡）**：屏幕在局部 `z=0`、后墙在 `z=+6.15`，而**雨棚前沿在 `z=-4.5`（朝场心一侧）**。
  板体只要低于「看台最高点」（18.5m），从场心看就被雨棚前沿切掉下沿。
- **坑二（掠射挡）**：就算抬到 `roofY+1.3 = 19.3m` 也不够 —— 水面机位（h≈2m）在 60m 外看过来，
  视线越过 18.5m 的雨棚前沿时只抬到 18.0m，照样切掉板底。

解：`ARENA_SCREEN_LIFT 4.6 → 6.2`（板底 `roofY+2.9 = 20.9m`）。
验收里写了**视线遮挡计算**（不是"看着还行"）：`yAtRoof = h + (boardBottom-h)*(d-4.5)/d` 必须 ≥ 18.5。

| 机位 | h=2m | h=5m |
|---|---|---|
| d=20m | ✗ 16.65 | ✗ 17.32 |
| d=30m | ✗ 18.06 | ✓ 18.52 |
| **d=40m** | **✓ 18.77** | ✓ 19.11 |
| d=60m | ✓ 19.48 | ✓ 19.71 |
| d=115.5m（看对面） | ✓ 20.16 | ✓ 20.28 |

只剩「正上方那一座」（d≈13m，抬头仰视自己头顶的牌子）必然被切 —— 真实球场同理，不纳入要求。

### 三、道具赛氮气条不显示的真因

`Game.#hudData()` 里原来是：

```js
nitroCharge: this.localBoat.nitroAllowed ? this.localBoat.nitroCharge : null
```

道具模式 `nitroAllowed=false` → 传 `null` → `ui.js` 的 `if (d.nitroCharge != null)` 走 else，
`#nitro-wrap` 整块 `hidden`。改成道具模式回落到「氮气道具的加速剩余」：

```js
nitroCharge: this.localBoat.nitroAllowed
  ? this.localBoat.nitroCharge
  : (this.mode === 'item'
    ? Math.min(1, Math.max(0, this.localBoat.boostTimer / 4.2))
    : null),
nitroBottles: this.localBoat.nitroAllowed ? this.localBoat.nitroBottles : 0,
nitroLocked: !this.localBoat.nitroAllowed && this.mode === 'item',
```

`nitroLocked` 同时驱动两件事：收起「可存两格氮气瓶」（道具赛拿不到瓶子）、
提示语从「氮气集气 · Shift 漂移 / Ctrl 释放」换成「氮气道具 · 拾取后自动加速」。
不换文案玩家会一直按 Shift 等集气。

### 四、暗黑锻铁 HUD（`index.html` 文件最末的 `<!-- arena-skin -->` 块）

作用域**严格限定 `#hud.arena-mode`**，竞速 / 道具 / 怪物模式一个像素不动。

- ⚠ **必须排在文件最后**：boss/arena 共用的「霓虹蓝玻璃」规则带 `!important`，
  同特异性下只有靠后出现才能压住；所有选择器再带 `#hud.arena-mode` 前缀提特异性。
- 配色变量：铁面 `#232019` / 高光 `#4A4438` / 黄铜 `#B98A45` / 黄铜高光 `#E3C07A` /
  皮革 `#3B2C22` / 深红 `#7A0F1E` / 亮红 `#C7303F` / 米白 `#EDE4D0` / 深槽 `#0D0C0A`。
- 四角铆钉用**一层 `::after` 背景图拼四颗**（`radial-gradient(circle 2.7px at 6px 6px, ...)` ×4），
  比四个伪元素省事，也不会被 `inset` 吃掉。
- 覆盖 A~J 十区：小地图 / 记分牌（三段合成 + 黄铜竖分隔）/ 占领条（下移 `top:108px`）/
  设置按钮 / **对手单位框** / 技能 K·F（统一 94×55.5）/ 道具三格（统一 74×74）/
  血条（深红渐变 + 分20%刻度 + 两端红宝石）/ 氮气槽（黄铜刻度）/ 速度表（双层黄铜镶边）。

**对手单位框是新增 DOM**（`#arena-foe`）：MMORPG 目标框，黄铜头像环 + 名字 + 分段血槽 + 数值铜牌。
CSS 里 `#hud.arena-mode #arena-foe { display:flex }` 特异性高于 `.hidden`，
所以必须补一条 `#hud.arena-mode #arena-foe.hidden { display:none !important }`，
`ui.js` 里 `if (!isArena) foeBox.classList.add('hidden')` 保证怪物模式也不会漏出来。

### 验收

`tests/arena_hud_probe.mjs`（**四段**，21 条断言，全 PASS）：

| 段 | 验什么 |
|---|---|
| ① 竞速 | `#hud` 无 arena-mode、小地图没被染黄铜、对手框 `display:none`（**防样式溢出**） |
| ② 竞技场 | 看台 18.5m / 板底 20.9m / 板底高于看台顶 / 视线遮挡表 / 10 条 HUD 计算样式 |
| ③ 道具 | `#nitro-wrap` 不 hidden、氮气瓶收起、提示语切换、槽随 `boostTimer` 涨满、能量格点亮 |
| ④ 截图 | 2 次 `Page.captureScreenshot`（竞技场 / 道具），其余 3D 图走页面内 `toDataURL` |

⚠ 画布 `toDataURL` **只含 3D**，DOM HUD 必须走 `Page.captureScreenshot`。
本次在 1280×720 窗口下**连调 2 次都成功**（旧坑是 720×420 下第二次挂死），
但仍然把第 2 次包在 try/catch 里降级，不让截图失败污染断言。

回归：`npm test` PASS、`tests/arena_stadium.mjs` 24 条全 PASS、`magma_shortcut_audit` PASS、
`guide_signs_audit` PASS（8 图全覆盖）、`npm run build` PASS。

截图：`shots/verify/arena-hud.jpg`（对战相 HUD 合成图）、`arena-stand-front.jpg`（水面机位正视
单座看台，比分牌下沿完整）、`arena-stand-mid.jpg`（中场斜看一圈看台 + 天际线）、`item-hud.jpg`。

### 踩坑

1. **世界空间名牌会骗人**：AI 船的「电脑1 / 300」是 3D billboard，拍看台时正好压在正中那块
   比分牌上，一度以为"比分牌被切了"。截图前把 `g.boats` 里非本地的船 `resetTo` 到相机背后。
2. **开场标题浮层会挡 HUD**：`#arena-cinema` 固定在 `top:16%`，和 `#arena-core`（92→108px）
   在 720p 下本来就重叠；这是老问题不是本次引入。合成图改成**快进过 cinema 再拍**，
   反映真实对战画面。
3. `#arena-core` 原 `top:92px`，新皮肤给它 `108px`，因为记分牌变厚（`padding 6px 2px` +
   2px 黄铜边）下端降到 ~58px 之外还要留呼吸。

## 五十五、怪物模式「暗黑锻铁 HUD」皮肤（2026-11-14）

### 用户诉求

「把怪物模式的 UI 按照图生成」，附一张锻铁 HUD 参考图 + 一份按区域（A~K）写的改造规格，
配色表与竞技场那版完全一致。执行前确认了四点：**换皮肤 + 按图微调布局 / 菱形刻度改 4 个 /
BOSS 专属提示全部转暖金深红 / 只换常驻 HUD（开场大字与结算面板不动）**。

### 好消息：布局本来就对得上

先跑 `tests/boss_hud_probe.mjs` 拍现状 + 量矩形，逐块比对后确认：
BOSS 血条 56% 宽居中、小地图左上、玩家名牌在小地图下、关卡/时间两块在右上、热量/集气在中下、
道具三格、协同合击左下、氮气右下 —— **位置几乎和参考图一模一样**，差别只在材质语言
（原来是霓虹蓝玻璃，要换成锻铁 + 黄铜）。所以这次是「换肤 + 3 处微调」，不是重排。

顺手核对过、确认不用改的：
- 道具名本来就是「深水炸弹 / 破甲标枪 / **墨鱼喷墨**」（不是噬鱼喷嚏）；
- `#player-list` 本来就有「复活 ×N」；
- 小地图那行本来显示的就是**地图名**（熔岩火山）。

### 三处布局微调（DOM 同步改）

| 项 | 改前 | 改后 |
|---|---|---|
| BOSS 铭牌 | 名字行 + 血条行**两行** | **单行**：`[盾形徽章] 名字 \| 超长血槽 \| 阶段铜牌` |
| 菱形刻度 | 5 个（16.6/33.3/50/66.6/83.3） | **4 个**（20/40/60/80） |
| 关卡 / 时间 | 裸文字堆在右上 | 两块独立黄铜小铭牌（带四角铆钉） |

盾形徽章用两层同 `clip-path` 叠出来（外层黄铜盾 + 内层 `inset:3px` 铁盾），
比画 SVG 省事，也天然带包边；emoji 图标 `#boss-icon` 放在最上层 `z-index:2`。

### 皮肤作用域

`index.html` 文件最末新增 `<!-- boss-skin -->` 块，**所有选择器以 `#hud.boss-mode` 起头**，
竞速 / 道具 / 竞技场一个像素不动。覆盖 A~K 十一个区域，材质与竞技场共用同一套 9 色变量。

小地图的赛道线是 canvas 画的，光靠 CSS 改不了颜色：
`drawMinimap(mm, fireCore, portal, warm)` 新增第 4 个参数，`updateHud` 里传 `isBoss`，
warm 档把 `#2AF0D0` 青绿换成 `#E3C07A` 暖金、门点/起点箭头/本方箭头一起转暖。
非怪物模式走原分支，颜色一字节没变。

### ⚠ 三个 CSS 陷阱（这次全踩了一遍，务必记牢）

1. **`:is()` 会取参数里最具体的那个**。通用面板写
   `#hud.boss-mode :is(#minimap-wrap, #player-list .pl-self, ...)`，
   因为混进了 `#player-list .pl-self`（id + class），整条规则的特异性被抬到 **2 id + 2 class**，
   后面 `#hud.boss-mode #minimap-wrap`（2 id + 1 class）的 3px 微调**永远压不住**。
   → 解法：小地图单独写一份完整规则、不进 `:is()` 列表。
2. **绝对定位元素绝不能沾 `position: relative`**。通用规则里顺手写的
   `position: relative` 把 `#quality-btn` 踢到 `x=-18,y=257`、把 `#combo-bar` 踢到 `y=247`；
   更隐蔽的是**小地图**：它本来是 `absolute`，改成 `relative` 后掉回正常流，
   div 直接撑满整行（实测 **1259×241**），整块锻铁面板把顶部 BOSS 铭牌盖得严严实实 ——
   表现为「铭牌内容全不见了」，但 `getBoundingClientRect` / `color` / `opacity` 全部正常，
   非常容易误判成文字颜色问题。
   → 排查靠 `document.elementsFromPoint(铭牌中心)` 打印命中栈，一眼看到 `minimap-wrap@1259x241`。
3. **`#a #a #b` 这种写法是不匹配的**：`#hud.boss-mode #hud #minimap-wrap` 要求
   `#hud` 是 `#hud.boss-mode` 的**后代**，同一个元素不可能是自己的后代 → 规则静默失效。
   （最初就是想用它提特异性，结果白写。）

### 验收

`tests/boss_hud_probe.mjs`（`npm run test:boss:hud`），**三段 44 条断言全 PASS**：

| 段 | 验什么 |
|---|---|
| ① 竞速 | `#hud` 无 boss-mode、小地图边框不是黄铜、**赛道线 canvas 像素仍是青色**、`#boss-hud` 隐藏（防溢出） |
| ② 怪物 | 铭牌黄铜 2px / 实底渐变 / 盾形 clip-path / 名字·血槽·铜牌同一行 / `clip-path:none` / **菱形=4 且分别 20·40·60·80%** / 小地图 3px 铜边 + `#minimap-wrap` 不再是碳纤维 / 玩家名牌深红血槽 / 关卡时间双铭牌 / 热量集气铜牌键位 / 道具三格皮革底 `#3B2C22` 且尺寸统一 / 协同百分比去青蓝 / 氮气暖金 / **全 HUD 撞色扫描零青蓝残留** |
| ③ 截图 | `Page.captureScreenshot` 全图 + `clip` 2 倍铭牌特写 |

小地图暖金不是「看着像」：直接 `getImageData` 数像素，金 3862 px / 青 0 px。

回归：`npm test` PASS、`tests/boss_gameplay.mjs` PASS（8 项战斗逻辑）、
`tests/arena_hud_probe.mjs` PASS（竞技场皮肤未被影响）、`npm run build` PASS。

截图：`shots/verify/boss-hud.jpg`（3D + DOM HUD 合成）、`boss-plate.jpg`（铭牌 2 倍特写）。

### 没做的（按用户选择）

开场「第 X 关 / 深渊火龙」大字条、通关结算面板保持原样。

## 五十六、秘境漂流六项修复：隧道口没水 / 白斑闪烁 / 悬空岩体 / 瀑布云 / 城墙装饰（2026-11-14）

用户在四张实拍上指了四个 bug + 两个观感诉求。全部先定位到**具体网格/具体参数**再动手，
根因都不在"哪块模型没接上"，而在几何与水面高度的关系上。

### 1. 起点隧道出口"河流全没了、悬空飘移"

- **根因**：`cave_shell.glb` 有 `cave_shell / cave_water`，`stairs_shell.glb` 只有
  `stairs_water / stairs_shell` 两个网格。为了隐藏旧的大台阶，`#buildBaked` 里那行
  是 `/^(cloud|stairs)_/i` —— **正则把 `stairs_water` 一起藏掉了**。而程序化螺旋塔
  的走廊从门 29 才开始，门 23~28（0m 爬到 13m）既没有水面也没有岸带。
- **修法**：塔新增 `approach: { from: 23, to: 29 }`，`#buildCloudTower` 的断面生成
  往前接到 23 门。**关键点**：接近段还没开始绕塔，径向和航道法线能差 45°，
  所以这些行的内外缘必须用**法线**偏移（`approach` 分支），用径向会把坡道斜插进水里。
  支撑柱也跟着补上（`a.onTower && !a.approach` 才跳过）。
- 两侧补浮云：`#buildApproachClouds()`。**不要用 `cloud_isles` 当云的原型** ——
  那是"浮空孤岛"，clone 出来是一堆倒挂的锥形漏斗（实拍确认）。改成 4~7 个压扁
  icosphere 合成的软云团，离航道边 ≥ HW+11，云底永远在水面之上，位置走确定性 LCG。

### 2. 赛道内白色反复闪烁

- **根因**：`tower_deck` 的顶面只在水面下 **0.14m**，而主水面着色器按 `uWaves`
  做顶点位移，晴天总振幅就有 **0.91m**（`src/utils/waves.js`，暴风雨 ×2.4 ≈ 2.18m）。
  浪谷一沉，白板就从水里翻出来 —— 表现为"白板上漂着几块蓝斑、不停闪烁"。
  把 `tower_deck` 隐藏后走廊立刻变成完整水面，A/B 一次确认。
- **修法**：断面拆成三段 —— 航道内板面压到 **−2.30m**（低于最大浪谷）、水线外
  另起 **+0.30m** 的走道/渠沿面、两者之间一道立面接起来。这样无论浪多大，
  能看见的只有水面加一圈干净的白色渠沿。顺带把 `tower_legs` 的悬挑板也读通了。

### 3. 巨大物体横跨赛道

- **根因**：山洞岩体是按门 0..22 那条隧道扫出来的实体，而回程最后几个门
  （196~206）从洞口外侧擦过去，最近中线离洞口轴线差 **8~18m** —— 岩体整块横跨
  悬浮在回程航道上方，蘑菇还挂在半空。
- **试错记录**（都实拍验过，都不行）：横向推到走廊外 → 大岩面上挖出一个方方正正的
  缺口，岩体照样横在眼前；抬成 6m 岩檐 → 航道从山体内部穿过，镜头整个埋进岩体、
  屏幕一片黑；沉到水下 → 走廊干净了，但山体上留一圈垂直断面 + 一个能看穿的天窗。
- **最终修法**：`#cutBakedFromCorridor(mesh, from, to)` 直接**剔除索引**里
  "三角面中心落在走廊内、且高于水面"的那批面（188~206 门），岩体保持原形，
  只在航道上开出一个洞，洞后就是隧道自己的洞壁 —— 读起来正是"开进山洞"。
  蘑菇这类小件走 `#clearBakedOverCorridor(..., 'push')` 横向推出去。

### 4. 瀑布下来的"云"穿模

- `fall_foam` 在 GLB 里是一坨 **20m×28m、y 6.8~11.3** 的多面体云团，而那一带水面
  正好在 y=8 —— 整块压在航道正中。整段 `visible = false` 删掉，落水感交给落差本身。

### 5. 城墙（回程石堤）装饰

- 新增**灯柱**：`public/models/low_poly_street_light_pole.glb` 是仓库里唯一一件自带
  albedo 贴图的街景件，沿走道靠女儿墙一侧每 40m 一根、左右交替，缩到 0.6 倍
  （原型 15.8m 高，原尺寸立在 4.6m 堤墙上像一排电线杆）。
- 壁画板原来是 4.8×2m 贴在 4.6m 高的内坡上，一块"广告牌"；缩到 0.66（3.2×1.3m）
  才读得出是浮雕壁画。
- **未做**：新做一套城墙专用件（垛口 / 浮雕壁板 / 旗杆旗帜）。用户选的是"两者混合"，
  现有件这半边已落地，新件需要开 Blender 资产任务，留到下一轮。

### 6. 城墙中间巡逻的机器人

- 代码里**早就在用** `public/models/hazards/hazard_bot.glb`（`#buildBakedHazards`），
  问题不在"没接模型"：那个 glb **一张贴图都没有**，只有 5 个纯色材质，合成
  InstancedMesh 时每个网格只烘一个扁平顶点色 —— 所以看起来就是程序化方块。
- 用户决定自己提供模型，本轮不动；接入点已经明确（`urls.bot`），
  换文件即生效，但要同步把"合并成顶点色"改成"按材质分组保留贴图"，否则新模型
  的贴图会被烘掉。

### 验收

- `npm test` PASS。
- 实拍复核（`tests/baked_look.mjs`，CANVAS=1 走 canvas 直读）：
  g23/g26 接近段有连续水面 + 两侧浮云；g40/g56 走廊全水面、渠沿干净、无白斑；
  g64 瀑布白块消失；g92/g110 灯柱与浮雕板比例正常；g204 航道通畅、洞口清晰。
- **探针坑**：单人模式下船停在原地跑久了会走完超时判定 → `onFinish` → main.js
  把 Game dispose 掉 → `window.__game` 变 undefined，后面每门都报
  `reading 'mapDef'`。`baked_look.mjs` 现在会在进图后把 `opts.onFinish` 置空。
- 另：**开发服务器上跑的可能是 dist 构建产物**（index.html 里是
  `./assets/index-*.js`）。改源码不生效时先看这一行，用
  `npx vite --port 5199 --strictPort` 起真 dev 再验。

### 补充（同日）：城墙巡逻机器人换成用户提供的模型

用户提供 `glb/robot_playground.glb`（Sketchfab 整场景，8.7MB）。处理链路：

1. **剥模型**：`scripts/robot/extract_robot.py`（Blender 5.2.3 批处理）
   - 场景里 68 个网格 = 34 个机器人（材质 `material`，7963 面）+ 34 个全息装饰
     （材质 `holo1`，3852 面）。**判定按材质名而不是物体名** —— glTF 导入 Blender 后
     物体名会变成 `Object_162` 这种通用名，`_bot_` 只留在网格数据名上（第一版就栽在这）。
   - 机器人带骨骼蒙皮 + 一段 265 通道动画，InstancedMesh 没法这么实例化：
     用 depsgraph `new_from_object` 把骨骼变形 + 形态键**冻成静态几何**再 join。
   - Decimate 7963 → 3200 面；归一化到高 2.2m、底面 y=0、水平居中。
   - 导出 2.29MB（贴图打包），替换 `public/models/hazards/hazard_bot.glb`。
2. **代码侧**：`#buildBakedHazards` 新增"带贴图"分支 —— 有 `map/emissiveMap/normalMap`
   的件**按材质分组、保留原材质建 InstancedMesh**；没有贴图的（垃圾桶/岩石/海草）
   继续走原来的"单色烘顶点色 + 合并"。`#spawnHazardSet` 现在接 `[{geo, mat}]` 或
   单个几何两种形态，`bakedHazards[i].meshes` 是数组，`#updateBakedHazards`
   逐 mesh 写矩阵。
   - ⚠️ 这条是硬要求：原来的逻辑把所有网格烘成"一个颜色 + 顶点色"，贴图会被整块
     烘掉 —— **上一只机器人看起来像"程序化方块"的真正原因**就是它本来就没贴图，
     再被烘成单色。
3. 验收：`npm test` PASS；`npm run build` PASS；实拍 g93~g97 机器人沿回程巡逻、
   站在水面、贴图/自发光正常；垃圾桶/海草/岩石渲染未受影响（走的是老分支）。

### 补充（同日）：机器人放大 + 源 GLB 出仓 + 城墙三件套（Blender 新资产）

**1. 机器人 2.2m → 2.6m**
`scripts/robot/extract_robot.py` 的 `TARGET_H` 改成 2.6 重跑，输出 1.61 × 2.60 × 0.97m、
3200 面、2.18MB。碰撞半径 `#buildBakedHazards` 里 `r: 1.05 → 1.15`（脚底宽 1.6m，
取半宽再收一点，避免"看着擦边其实撞上"）。
`glb/robot_playground.glb`（8.7MB）已移到 `D:/3Dgame_assets_src/glb/`，不再进仓库。

**2. `scripts/wall/gen_wall_props.py`（新）**
一次生成三件，全部顶点色 `COLOR_0` + Base Color 打平 + 关背面剔除：

| 文件 | 尺寸（glTF） | 面 | 用途 |
|---|---|---|---|
| `wall_crenel.glb` | 6.0 × 1.32 × 0.7m | 84 | 垛口模块，压在压顶上 |
| `wall_relief.glb` | 2.4 × 1.6 × 0.52m | 132 | 浮雕壁板，贴堤身内坡 |
| `wall_banner.glb` | 1.36 × 6.42 × 0.48m | 180 | 旗杆 + 悬挂红幡 |

尺寸严格对齐 `#buildReturnBank` 的断面：压顶 lat 10.1→10.8、顶面 +4.35→+4.60（外倾 0.25）；
堤身内坡 lat 7.1→7.9、−1.2→+3.4m。垛口底座 0.7m 宽 × 0.52m 高，底面包住整段斜坡。

**3. 摆放逻辑（`Track.js` 的 `#buildReturnBank`）**
- `decor` 新增 `crenels / reliefs / banners` 三个数组，仍走 `#buildReturnBankDecor`
  的 `spawn(url, items, init, tone)`（`tone` 是这次新加的第四参：覆盖默认暖石自发光）。
- **垛口**：沿**累积弧长**每 6m 一组、两侧都有。三个坑：
  ① 壁柱也立在 `L_OUT-0.35`、比压顶高 1.2m，6m 模块会横穿柱身 → 离任何壁柱 3.6m
  （半长 3.0 + 柱半宽 0.58，`pierHit`）以内整组跳过，柱身自己把垛口断开；
  ② 行距 0~2.5m 浮动，按"行"取整会出现 4m/8m 交替的疏密 → 必须按弧长插值定位；
  ③ 断带（`gapOf > 8`）与分叉口行要重新起算弧长，别把垛口摆进缺口。
- **浮雕壁板**：每 24m 一块、左右交替，锚点 `u=0.5`（坡面正中，相对水面 ≈ +1.1m）；
  与**壁画（40m）贴在同一段坡面**上，按空间距离 3.2m（1.6+1.2 半宽）过滤重叠。
  旋转用 `atan2(nx*s, nz*s)` 让局部 −Z 朝航道（浮雕的正面在 −Z）；
  锚点到墙面的垂直距离实测 2cm，正好不共面闪烁。
- **旗杆旗帜**：每 85m 一根、左右交替，`lat = HW+0.4+W_WALK-0.42`（走道靠女儿墙一侧）。
  灯柱（40m）/贝壳雕塑（68m）站在同一条走道上，撞上就把这个周期整根跳过。
  旗面法线朝航道，船从侧面看是整幅旗而不是一条线。
- 数量实测：垛口 285 组（23940 面）、浮雕 45 块（5940 面）、旗 12 根（2160 面），
  各自合批成**一个** mesh。

**4. 验收**
`npm test` PASS、`npm run build` PASS；实拍 g100/120/130/140/170/185/200 六机位：
垛口沿两侧墙顶连续对齐、壁柱处自然断开；浮雕板贴内坡不浮空；旗帜立在走道上红面朝航道。
俯视机位（`PRE` 里把 `cameraRig.follow` 置空 + 手动摆位）最适合一次核对三类落位。

**遗留观察（未改，等确认）**：`maps.js` 的 `shore.dock`（`dock_wood.glb`，18m 长、
`offset: 13.0`）在回程石堤段会**横插进堤身**、往航道里探——石堤是后建的，码头是旧布景。
它自带 `shoreColliders`，动它要连碰撞一起改，所以这轮只记录不修改。

### 补充（同日）：回程木码头搬到堤身内侧，改成"两艘船宽"的窄口

**需求**：旧的木质码头放到堤身内侧、碰撞一并改，把码头那一段的可通行空间收窄到「仅容纳 2 艘赛艇」。

**旧状态的问题**：`shore.dock` 的 `offset: 13.0` 落在堤身**外侧**（岸带外沿 10.8 之外），
但码头长边（局部 Z，18.26m）是**垂直航道**的，所以它从墙外一头穿进堤身、另一头伸进航道 3.9m；
碰撞是三个 `r:2.3` 的圆，内缘落在 9.4m，对 15m 宽的航道不构成任何阻挡 —— 纯装饰，还穿模。

**资产真相**：`dock_wood.glb`（748 面）里**只有桩和横杆、没有甲板**。直接摆进航道
就是从水面飘着两根栏杆（绿色探针确认过），读不出"码头"。所以在 `spawn` 里补了一块
程序化木甲板（`BoxGeometry`，4.68 × 8.31 × 0.24m），顶面在水面 +0.27m，
桩头从甲板上方露出来当系缆桩。甲板挂在 `grp` 上而不是模型实例 `o` 上 ——
`o` 的 `scale.z` 被压成 0.455，挂上去会被二次缩放，长度就对不上碰撞圆了。

**参数**（`src/data/maps.js`）：
```js
dock: { url: '/models/shore/dock_wood.glb', step: 150, y: 0.12, lenScale: 0.455, passWidth: 7.0 }
```
- `lenScale` **只压长边**（原型长边在局部 Z）；等比缩到 0.455 会把码头压成一根细竹签，
  宽度留 4.68m 才有"挤"的感觉。
- 码头**不写 offset**：`#buildShoreDressing` 的 `collect` 用
  `off = (edgeOffset ?? gateWidth-0.6) - passWidth + halfL` 反算，
  即「走廊半宽 − 内缘 == passWidth」。7.0m 净宽 ⇒ offset = 4.05、内缘 −0.10、外端 8.2（埋进堤身 1.1m）。

**碰撞**（`#buildShoreDressing` 的 `spawn`）：
- 3 个大圆 `r = 2.34`（原型半宽）沿长边排开，圆心从 −(halfL−r) 到 +(halfL−r)；
  再加 2 个 `r:1.3` 的角圆补甲板内缘那两角 —— 三个圆排成的其实是**胶囊**，
  甲板四角会漏出去，船能贴着角切进甲板里。
- ⚠️ 引擎的碰撞判定是 `minD = c.r + 1.3`（1.3 是固定的船半径，不是按 `hull.width` 算）。
  所以「碰撞圆的几何外沿」比圆本身大 1.3m —— 设计净宽时必须按碰撞面算，
  不能按甲板边缘算，否则通道会被悄悄吃掉一整条船宽。
- 圆上加了 `dock: true` 标记，AI 的避障和 `narrowLaneShift` 都靠它辨识。

**AI**：光靠"前方障碍规避"过不去 —— 那是看到才躲（10m 探测 = 0.4 秒），
而舵量按偏差 ×2.2 取，小偏差时舵也小，横移率上不去，实测三种起点全部卡在码头前沿
（`blocked` 300+ 帧）。所以新增 `Track.narrowLaneShift(x, z, fx, fz)`：
提前 **70m** 把循迹目标点整体推到空侧（位移 = `passWidth/2`，**不随距离衰减**），
AI 用一整段直道换线。同一时间避障的探测距离也按 `c.dock ? 26 : 10` 放大、力度收到 0.9
（三个圈叠加容易打过方向）。
- 70m 不会让 AI 来回摆：过一个码头后它就在船后方，`ahead > 0.45` 直接过滤掉；
  两个码头相距 150m，只有后 70m 受影响，中间 80m 回中线。

**验收**
- 逻辑探针（`boat.updateLocal` + `track.constrain` 手推，只喂码头碰撞）：
  通道中心 lat −3.5、偏紧的 −1.5 都能全速通过（26 m/s / 零阻挡）；正对码头（lat 0）被顶回。
- 复刻 AI 循迹（含 `narrowLaneShift`）：中线 / 靠码头侧 / 靠通道侧三种起点全部通过，
  穿过窄口时 19.7~20.2 m/s，`blocked = 0`、`hit = 0`。
- 9 处码头（门 91/101/111/141/161/171/181/191/201）通道内没有 hazard / 礁石 / 浮标占位。
- `npm test` PASS、`npm run build` PASS；实拍 g111 / g161 / g181 甲板贴壁、通道在另一侧。

## 五十六、竞技场开场标题卡 + 敌船船顶血条 + 道具赛氮气空槽（2026-11-15）

### 用户三条诉求

1. 竞技场对手血量不要单独在右上角，要贴到**敌方赛艇上方**（联机同样）；
2. 开场仿参考图：正中央大字、**背景模糊**、5 秒后走原来的镜头，开场期间**全部 UI 不显示**，进游戏再显示；
3. 道具赛右上角氮气条「没法集气，但**框要显示**」，不能一片空白。

### 一、对手血量改到敌船船顶

`#arena-foe`（MMORPG 目标框，上一轮刚加的）**整块删掉** —— DOM、`ui.js` 渲染分支、
`index.html` 里的样式与 `:is()` 列表里的引用全部清掉。

改由 `ArenaMode.#drawHpBar` 画世界空间铭牌（原来就有，是绿条白字的简易版）：

| 项 | 内容 |
|---|---|
| 贴图 | 512×184，`SCREEN_H = 0.10`（视野高度 10%，远近视距都恒定屏占） |
| 底板 | 黄铜包边（三段渐变）+ 铁面（`#2E2921→#232019→#141210`）+ 上沿拉丝高光 + 四角铆钉（径向渐变） |
| 名字 | 36px 衬线（Georgia / Songti SC），米白 `#EDE4D0` + 6.5px 深色描边 + 下方暗投影 |
| 血槽 | 深槽 `#0D0C0A` + 亮红三段渐变 `#E4566A→#C7303F→#7A0F1E` + 顶部高光 + 2.4px 黄铜框 + **4 个黄铜菱形刻度**（20/40/60/80%） |
| 数值 | 黄铜小铜牌 + 深色衬线数字 |

只给**非自己**的船挂：`if (!p.alive || id === this.myId) bar.spr.visible = false`。
联机时 `hpBars` 对每个 id 都有一块，所以多对手会各挂一块，不需要额外改动。

⚠ 两个坑：
- 名字原来 21px / 80px 画布 → 换成 184px 画布后**相对变小**，实测远看糊成一团，加到 36px；
- canvas 画 `roundRect` 旧浏览器不支持，自己写了 `#rr()`（`arcTo` 拼圆角）。

### 二、开场：5 秒标题卡 → 7 秒镜头 → 3-2-1

`ARENA_RULES` 新增 `INTRO_TIME: 5`，`CINEMA_TIME` 仍是 7。时间轴：

| 段 | 时长 | 内容 |
|---|---|---|
| ① 标题卡 | 5s | 正中央「激流勇进」+ 橙红渐变细线 + 「潮汐竞技场 · 水上竞速」+ 底部《激流勇进》；`backdrop-filter: blur(16px)` 模糊全屏背景；镜头停在镜头路径起点做极缓「推进再退回」（`sin(q·π)`，起止位移都是 0，切进第 ② 段不跳） |
| ② 镜头飞行 | 7s | 原来的路径（俯瞰 → 场心 → 环看台 → 贴船尾） |
| ③ 倒数 | 最后 3s | `countdown` 跟随 `cinema`，画面中央大号 3-2-1（此时 HUD 还收着，所以单独画一个） |

`body.intro-on` 挂在 `<body>` 上，把 `#hud` / `#chat-root` / `#chat-bubbles` / `#toast`
一起设成 `opacity:0 + pointer-events:none`；进战那一刻 `#endIntro()` 摘掉 → HUD 0.45s 淡入。
`dispose()` 里也一定要摘 `intro-on`，否则下一次开局整套 HUD 永远是透明的。

总时长 12 秒（不是 15 秒）：倒数**接在镜头最后 3 秒**，落地即开火，不用额外干等。
`?arenaCinema=0` 一次跳过两段（无头测试 / 联机 e2e 用）。

### 三、道具赛氮气条：只留「空槽」

上一轮只做到「不 hidden」，但六格的不透明度还是 `0.12`，整条看过去就是一块空黑框。
这次给 `#nitro-wrap` 加 `locked` 类（`ui.js` 里 `nitroWrap.classList.toggle('locked', !!d.nitroLocked)`），
CSS 换一套空槽外观：黄铜边框 + 铁面 + 黄铜闪电圆章 + **六格暗铁凹槽（`opacity:1 !important`）**。
拾到氮气道具开始加速时 `.on` 照常点亮，`locked` 的暗底只在 `:not(.on)` 上生效。

⚠ 验收坑：空格子被 `!important` 钉成 `opacity:1`，**不能再拿透明度当"点亮"判据**，
要数 `.on` 类（`NITRO.cellOn`）。

### 验收

`tests/arena_intro_probe.mjs`（`npm run test:arena:intro`），**五段 31 条断言全 PASS**：

| 段 | 验什么 |
|---|---|
| ① 开场 | `#arena-intro` 在、标题/副标题/底部小字文本、`backdrop-filter` 真带 blur、`body.intro-on`、`#hud` opacity=0 且 `pointer-events:none` |
| ② 镜头 | 标题卡结束 → `ai-film`（模糊与大字撤掉）但 HUD 仍收着；`cinema=2.4` 时大号倒数显示 3 |
| ③ 进战 | `intro-on` 摘掉、HUD opacity=1、浮层从 DOM 移除 |
| ④ 敌船血条 | `#arena-foe` 不存在；铭牌 Sprite `visible`、只画非自己、非透明像素 >2 万（不是空贴图）、比例 512×184、与敌船同 z、y>3m |
| ⑤ 道具氮气 | 不 hidden、有 `locked`、瓶子收起、黄铜边框、六格存在且不透明、有暗铁渐变、有实体尺寸；拉满 `boostTimer` 后 `.on` ≥3 且底色变橙红 |
| ⑥ 防溢出 | 竞速模式没有浮层 / 没有 `intro-on` / HUD 正常 / 氮气没有 `locked` / 提示语仍是「集气」 |

回归：`npm test` PASS、`arena_hud_probe` PASS（看台 18.5m、比分牌下沿 20.9m、
21 条 HUD 断言，其中防溢出段已改成断言 `#arena-foe` 节点不存在）、`boss_hud_probe` PASS、
`boss_gameplay` PASS、`npm run build` PASS（`dist/assets/index-Cfz6ipFo.js` 1,612,400 B）。

截图：`shots/verify/arena-intro.jpg`（标题卡 + 背景模糊，1080×540）、
`arena-foe-plate-tex.png`（铭牌贴图原图 512×184）、`arena-foe-plate.jpg`（敌船船顶实拍）、
`item-hud-frame.jpg`（道具赛 HUD，右上氮气空槽）。

### 踩坑

1. **CDP 截图会把整个软光栅渲染器拖死**：`Page.captureScreenshot` 成功之后，
   再过一两次 `Runtime.evaluate` 就会静默超时（不只是"第二次截图挂死"）。
   现在 3D 渲染截图一律排到脚本最后、包 try/catch，失败不影响断言。
2. **竞技场进 `fight` 会开始开火**，弹道 + 特效一多，下一次 evaluate 直接超时；
   截图前把 `phase` 摁在 `countdown` 且 `countdown = 999`。
3. 摆船 + 算名牌 + 摆机位 + `post.render` + `toDataURL` 必须在**同一个 JS 任务**里，
   中间让出一帧就会被 `updateCamera` / `CameraRig` 抢回机位。

## 五十七、敌船铭牌距离衰减 + 开场屏蔽 Esc（2026-11-15）

用户反馈两句：

1. 「敌人的血条栏太大了，最好加一下随距离缩小的系数」——指的是上一轮贴到敌船船顶的锻铁铭牌；
2. 「开场直接屏蔽 esc」——开场那 5+7 秒里按 Esc 会把设置面板弹在模糊遮罩下面。

### 一、铭牌按距离衰减

`ArenaMode.#updateHpBars` 原来是**恒定屏占**（`SCREEN_H = 0.10`）：

```js
h = viewH * SCREEN_H;   // viewH = 2·d·tan(fov/2)
```

好处是远近都能读血，坏处是「世界尺寸 ∝ 距离」—— 70m 外的对手会挂一块和眼前一样大的
牌子（按世界米算比船身还宽），看上去压过整条船。改成两段式：

```js
const SCREEN_H = 0.078;   // 近距满尺寸 = 视野高度的 7.8%
const NEAR_D = 16;        // 16m 以内不衰减
const FAR_D = 72;         // 72m 以外到下限
const FAR_K = 0.58;       // 最远只保留 58%

const q = clamp((d - NEAR_D) / (FAR_D - NEAR_D), 0, 1);
const shrink = 1 - (1 - FAR_K) * (q * q * (3 - 2 * q));   // smoothstep
h = viewH * SCREEN_H * shrink;
```

| 相机距离 | 屏占（≈ 视野高度） | 世界高度 |
|---|---|---|
| 20m | 7.8% | 1.87m |
| 34m | 7.2% | 3.1m |
| 80m | 4.5% | 4.35m（无衰减时是 7.5m） |

用 smoothstep 而不是线性插值：两端导数为 0，船在 16m / 72m 附近进出时不会看到尺寸跳变。
锚点高度跟着 `h` 走，所以牌子始终贴着船顶，不会因为缩小而浮在半空。

### 二、开场屏蔽 Esc

`src/main.js` 那条全局 Esc 监听最前面加一行：

```js
if (document.body.classList.contains('intro-on')) return;
```

`intro-on` 正好就是「竞技场开场中」这个语义（上一轮为隐藏 HUD 加的），标题卡与镜头飞行
两段都挂着，进战瞬间 `#endIntro()` 摘掉 —— 不用新增状态。

### 验收

`tests/arena_intro_probe.mjs` 新增 8 条断言（现在 **39 条全 PASS**）：

- `SHRINK` 探针把相机挪到 20m / 80m，量 `spr.scale.y / viewH`：
  `near 0.0775` / `far 0.0452`，且 `h_far / h_near = 2.33 < 3.2`（无衰减时应为 ≈4.0）；
- 开场段派发 `KeyboardEvent('keydown', {key:'Escape'})` → `#settings-panel` 仍带 `hidden`；
- 进战后再派发两次 → 开 → 关，确认 Esc 恢复正常。

回归：`npm test` PASS、`arena_hud_probe` PASS、`boss_hud_probe` PASS、`boss_gameplay` PASS、
`npm run build` PASS。截图 `shots/verify/arena-foe-plate.jpg` 重出（铭牌明显收小，敌船船身完整露出）。

---

## 水面真实感改造（A 档参数 + B 档环境反射）

### 起因

用户拿别人游戏的水面截图来比：对方是"低角度夕阳、金光从地平线拉到近处、天上有云倒映在水里"，
本作是"整片均匀青蓝、无光路、无层次"，读起来像塑料板。要求仿照提升真实感、并担心核显卡顿。

### 实测环境

Intel Iris Xe（96EU，核显）+ 2880×1800@60Hz 屏。用 `tests/water_perf.mjs`
（无头 Edge 走 ANGLE/D3D11 真 GPU，**不是** swiftshader）量到：

| 场景 | 整帧 | 水面这一层 |
|---|---|---|
| 1440×900 改前 | 12.9 ms | 3.8 ms（29%） |
| 1440×900 改后 | 11.1 ms | 2.6 ms（23%） |
| 2880×1800 改后 | 33.1 ms（~30fps，自动降到 medium） | 6.3 ms |

**结论：C 档（屏幕空间/平面反射）不做。** 1440×900 只剩 5.5ms 余量，C 要多渲一整个场景
（粗估 2.5～4.5ms），正好吃掉一半；满屏分辨率下那一帧本来就已经 33ms。

### 改动（`src/game/Water.js` + 两处 `Game.js` 调用）

参数档（A）：

- `absorb = 1 - exp(-(pathLen + 4.0) * uAbsorb)`（原 `+20.0`）、`uAbsorb` 0.014 → 0.019
  —— 那个 `+20` 是硬抬的虚拟水深，让近处一上来就吃 43% 深水色，近远糊成一个色；
- `reflK = clamp(fresnel, 0, 0.80)`（原 0.62）；
- GGX：`min(..., 70.0)`（原 12）、宽瓣 `pow(ndh,26)*0.105`（原 22/0.055）、
  `alpha` 0.11~0.29 / 夹 0.06~0.40（原 0.15~0.34 / 0.08~0.46）；
- `detailFade = exp(-dist*0.0125)`（原 0.024）、合成系数 `0.72 + 0.08*uGlint`（原 0.65/0.06）；
- `crestFoam` 门槛 `smoothstep(0.17, 0.75)` / `smoothstep(0.24, 0.66)`（原 0.30/0.86、0.34/0.72）；
- `uSat` 0.80 → 0.94、`uExposure` 0.84 → 0.86。

环境反射（B）：`bakeEnvironment(renderer, scene, pos, skyMesh)` + `#renderEnvCube(pos, skyOnly)`。

- 目标 `WebGLCubeRenderTarget(128, HalfFloatType)`。**three 渲染到 render target 时会把
  toneMapping 降为 NoToneMapping、输出色彩空间按 LinearSRGB**（`WebGLPrograms` L165/L202），
  所以 cube 里是**线性 HDR**，片元里不能再做 gamma — 这点是整个方案成立的前提；
- `min(env, uEnvMax=1.8)` 夹亮部，`uEnvAmt=0.85` 与解析天空混合；否则云的亮部（>10）
  原样乘进菲涅尔会把水糊成奶油白；
- `textureLod` 的 lod 由 `foot` 推：`clamp(log2(foot*6)+1.4, 0, 4.5)`。不加这级 mip，
  远处是"镜面贴纸"，云影硬成白斑；多加一档（+2.2/6.5）又会把中景糊平。折中在 +1.4/4.5；
- 天空穹顶半径 45 万米，烘图时临时缩到 4000（Sky 只看方向，缩放无副作用），
  否则要么被远平面裁掉、要么把 near/far 拉大毁掉地形深度精度；
- 重烘：换天气全场景烘一次；昼夜循环太阳动 >2° 时**只渲天空图层**（`layers` 2），4s 节流；
- 烘图期间关 `shadowMap.autoUpdate`（6 个面 = 6 次多余 shadow pass），`finally` 保证还回去；
- 不支持 `EXT_color_buffer_float` 时 `uEnvOn=0`，整段退回解析天空，行为与改动前一致；
- `dispose()` 释放 cube RT，`Game.dispose()` 已接。

调用点：`Game.js` 构造函数 `this.post?.setWeather?.()` 之后、`#applyWeather()` 里 `setWeather` 之后。

### 已验证无效/反向（别再试）

- **放开短波列**（去掉 `uGlint>0.5` 门 + 幅度 ×1.6）：整片水变成搓衣板织物；
- **uSat 拉到 0.96**：黄昏水色被推成紫罗兰。

### 验收

`tests/water_ab.mjs`（运行时改 uniform / 替换 shader 字面量，不动源码，同任务 render + toDataURL）、
`tests/water_perf.mjs`、`tests/gpu_probe.mjs`。对照页 `shots/water/water-ab.html`。
`npm test` PASS、`npm run build` PASS。baked 图（回程石堤段）实拍确认水面正常、非目标物无回归。

## 五十八、竞技场改三关制：潮汐运送 / 潮汐擂台 / 缩圈决斗 + 每关过场卡（2026-11-15）

### 起因

用户反馈：现竞技场只有"对射"这一条路，会退化成双方站桩互射，没有走位、没有技巧、没有回合，
组队模式里没法当核心玩法用。定板方案：**三关不同类型的玩法，三局两胜**，关与关之间播一张过场卡。

原话约束：「每个关卡之间有一个小动画，屏幕中间显示"第X关：名字"，背景渐糊，字体跳完后显示游戏场景，
背景变正常，界面ui在显示过场动画时不显示。」；「少使用你的丑大光圈特效……多用 effekseer 特效，
或者正常粒子特效」。

### 一、赛制

- `ARENA_ROUNDS`：`delivery` / `ringout` / `duel`，顺序固定（卡上要写「第 X 关」）；
- `ROUNDS_TO_WIN = 2`：先到 2 分结束，**2:0 不打第三关**；
- 单关 90 秒（`ROUND_TIME`）→ 超时按各关规则判胜；
- 第 3 关打平（1:1 → 1:1）：房主按「剩余血量 → 承伤更少」补判，保证比赛一定收口。

### 二、三关规则

| | 第 1 关 潮汐运送 | 第 2 关 潮汐擂台 | 第 3 关 缩圈决斗 |
|---|---|---|---|
| 目标 | 把中立核心推进对方球门 | 把对手撞出擂台 | 打沉对手（一条命） |
| 关键参数 | `PUSH_R 10`（贴到 10m 才推）`SPEED 5.2` `RETURN 2.2` `GOAL_Z 32` `GOAL_W 24` | `R 45` `SCORE_TO_WIN 3` `RAM_R 5.2` `RAM_MIN 7` `RAM_POWER 1.35` | `R 50→30` / 75s / 圈外 `22 dps` / 炮口 `35°` |
| 反制点 | 双方同时贴近 = 僵持（谁也推不动）；没人碰 → 核心缓慢回中；90s 后 30s 加时（速度 ×1.5，先领先 15m 胜） | 主炮禁用，只留冲刺/撞击；掉出后 2s 回场；超时比撞出数 | 圈外掉血 + 减速；按住 `H` 正面格挡；炮塔辅助角收到 35° |

设计意图：
- 运送关逼玩家**绕到核心背后**（方向按阵营固定，推错方向不会进自家门），正面拦人/侧翼包抄才有意义；
- 擂台关把"谁先打沉谁"换成"谁先把谁顶出去"，撞击角度、冲刺时机、贴身缠斗全部变成有效操作；
- 决斗关用缩圈 + 一条命 + 定向格挡，把"躲炮"和"抢圈心"变成同一件事。

### 三、每关过场卡（`#startRound` 重建，第 1 关在构造时建）

| 段 | 内容 |
|---|---|
| 底 | `.ai-veil`：径向压暗 + `backdrop-filter: blur(16px)`（背景渐糊，不是贴图也不是大光圈） |
| 字 | `.ai-title` 逐字 `<span style="animation-delay:…">`，`aiCharPop .54s` 一个字一个字跳进来 |
| 副 | `.ai-rule` 橙红细线 / `.ai-sub` 本关目标 / `.ai-foot` 第 1 关写「潮汐竞技场 · 三局两胜」，其余写关卡 tip |
| 收 UI | `body.intro-on` → `#hud` / `#chat-root` / `#chat-bubbles` / `#toast` 全部 `opacity:0; pointer-events:none` |
| 退场 | 计时到 → `.ai-out`（0.55s 内 blur 归 0、文字上移淡出）→ 600ms 后把 `#arena-intro` 从 DOM 摘掉，HUD 0.45s 淡入 |

- 第 1 关额外走 7s 镜头飞行（`cinemaCurve`），第 2/3 关只有卡 + `COUNTDOWN_FAST = 2` 秒倒数；
- `?arenaCinema=0` 一键跳卡（无头测试/联机 e2e 用，避免 1~3fps 下假超时）。

### 四、第 3 关定向格挡（`H`）

`ARENA_DUEL`：`BLOCK_ANGLE 1.15`（正面 ±66°）、`BLOCK_DRAIN .42/s`、`BLOCK_REGEN .26/s`
（停手 `BLOCK_REGEN_DELAY .6s` 后才回）、`BLOCK_OVERHEAT 2.2s`、命中一次 `BLOCK_HIT_COST .05`。
视觉是船头一块半透明面板 + 一道 `Torus` 细弧（`#buildBlockShield`），**不做球形光罩/加法混合大光圈**；
HUD 用 `#arena-block` 一条能量条，只在决斗关显示。

### 五、道具池按关卡收窄

- 决斗关：完整 `ARENA_ITEM_POOL`（10 件，已按"1v1 里能不能被反制"筛过）；
- 擂台关：`RINGOUT_ITEM_POOL = nitro / shield / angel / ink / slowboat / tide`
  —— 本关禁用主炮，再发鱼雷/瀑布/飞鱼等于把远程攻击加回来，与关卡定位冲突。

### 六、网络

- 房主权威：核心推进、撞出判定、回合判胜、超时判胜都只在房主算，客机吃广播；
- 消息：`arenaDmg / arenaHp / arenaRound / arenaEnd / arenaSkill / arenaCore / arenaRing / arenaRam`
  （`arenaPoint` 已删，`server/server.js` 白名单同步）；
- 撞击冲量由**被撞方本地**应用（`arenaRam` 只带方向/力度），避免双方各推一次。

### 七、踩到的坑

- **「第 2/3 关开局页面假死」不是游戏 bug**：无头 Edge 加 `--disable-gpu` 走 SwiftShader 时，
  切换关卡首帧要把之前没渲染过的材质编一遍着色器，主线程被锁几十秒，CDP 的 `Runtime.evaluate`
  直接超时，`Debugger.pause` 也**没有回调**（说明不是 JS 死循环）。无头测试改用
  `--headless=new`（硬件加速）后不复现，帧率也从 1~3fps 回到 60fps。
- `waitFor()` 返回的是**表达式本身**（`true`），日志里 `Math.round(true) = 1` 曾被误读成"血量只剩 1"，
  要看真实数值必须另读一次。

### 八、验收

| 脚本 | 结果 |
|---|---|
| `tests/arena_smoke.mjs` | PASS（三关全流程：核心送达 → 擂台撞出/超时 1:1 → 决斗缩圈/圈外掉血/举盾/冲刺/大招 → 2:1 结算） |
| `tests/arena_intro_probe.mjs` | PASS（第 1 关标题卡模糊/HUD 收起/Esc 屏蔽/倒数/浮层摘除 + 铭牌 + 氮气条） |
| `tests/arena_death.mjs` | PASS（运送关不计命、面板文案「重返战场」） |
| `tests/arena_hud_probe.mjs` | PASS |
| `tests/arena_stadium.mjs` | PASS |
| `tests/arena_net.test.mjs` / `tests/arena_net_e2e.mjs` / `tests/net_stability.mjs` | PASS |
| `npm test` / `npm run build` | PASS |

已知遗留：3v3 目前只取进场顺序前两人（`order.slice(0, 2)`），组队要另开一轮。

## 五十九、熔岩图障碍碰撞全盘审计 + 穿模修复（2026-11-15）

用户反馈「加速时还是能从移动物体里穿过去」。新增 `tests/magma_collision_audit.mjs`
（无头 Edge + CDP，纯逻辑不截图），先枚举全图 collider，再对每类障碍做
「隔离单障碍 / 全图集成」双轨 × 3 档速度(20/38/56) × 2 档 dt(1/60, 0.05) × 水面/腾空，
另测移动障碍扫过静止船、喷发泉可见窗口、擦边不反向弹回。

### 审计发现的四个真问题

| # | 现象 | 根因 |
|---|---|---|
| ① | 腾空时从浮标 / 旋转锤抡臂 / 锤座里直接穿过（bad 8/24） | `buoy` / `hammer` / 锤座 collider 没有 `bottomY/topY`，Boat 的 airborne 3D sweep 直接 `continue`；`applyMechs` 腾空分支又直接 return，只剩熔岩类型有反馈 |
| ② | 岩浆柱已经窜起来却能开过去 | `column.visible = up > 0.02`，但碰撞体要到 `up > 0.35` 才生成；`topY` 用 `up` 而不是柱体真实缩放 `grow` |
| ③ | 高速一帧跨过整个障碍（滚石 / 静态岩 / 撞碎岩都是 `heavy:true`） | 水面 sweep 对 `heavy` 无脑 `continue`；且法线取「终点相对圆心」，完全穿过时会把船放到**出口那一侧**，等于帮它穿模 |
| ④ | 移动障碍迎面扫来时没有相对运动概念 | 每帧只给当前位置，`prevPos → pos` 的扫掠线段不含障碍位移 |

### 修复

- `Track.js #updateMechs`：
  - 喷柱碰撞窗口改 `up > 0.02`（与 visible 严格同步），`topY = 0.9 + 13*grow`；
  - `magmaDrifter` / `magmaRoller` 记录上一帧位置写进 collider 的 `px/pz`，
    `hammer` 抡臂按 `ang - spinSpeed*dt` 解析反推上一帧位置；
  - 熔岩图末尾给所有缺高度范围的 mechCollider 补 `bottomY:-0.4 / topY:3.4`
    （其它地图的腾空免疫是刻意设计，不动）；
  - `#airborneMagmaHit` 并入 `shoreColliders`，腾空撞 Blender 静态岩石也有减速反馈。
- `Boat.js` 两处 sweep 统一改成：
  - 相对轨迹（有 `px/pz` 时用 `船位移 - 障碍位移`）；
  - 解析求线段与圆的**第一个交点**；只有「起点在圆外 + 终点在圆外 + 最近点深穿
    `< 0.72R`」才判定为真穿模，用进入点法线把船拉回进入侧；
  - 浅擦一律沿用终点方向法线（水面）/ 最近点法线（腾空），**否则船会被钉在障碍
    正后方、横向偏移被抹平，再也绕不过去**（第一版修复踩到过，擦边 7/7 卡死）；
  - `heavy` 只在真穿模时介入且只修位置（留 2cm 在区内），回弹 / 撞碎仍走原圆碰撞分支。

### 验收

| 脚本 | 结果 |
|---|---|
| `tests/magma_collision_audit.mjs` | 修复前 `TOTAL_BAD 14` → 修复后 `0`；7 类障碍 × 12 组隔离 + 12 组实图全 0；擦边 `GRAZE_REPELLED 0`；喷柱窗口 4/4 可见即碰撞 |
| `tests/magma_mech_probe.mjs` | 滚石 30.3→14.1 m/s 法向回弹（roll 0.62 / angVel 2.6 / shove 0.5）、撞碎岩碎裂 + 掉奖励 + boost 均保留 |
| `npm test` / `npm run build` | PASS（dist hash `index-Bg6Ak-mk.js`） |

设计内保留、不算 bug：撞碎岩高速撞开后穿过去（正反馈）；喷发泉 0.9m 高的
基座圆盘无常驻碰撞（否则三口泉会变成永久路障）；漩涡 / 航道熔岩柱是纯装饰。

---

## 远景山脉：从"环形锯齿壁纸"改成环形高度场

### 起因

用户反馈水面截图里"远处的山脉好丑"，要求改贴图/阴影/渲染、拓扑化、起伏更大、有真实山谷，
并且**每个有山脉的地图都要改**。

### 旧实现的病根

`Environment.#makeRidgeSheet()` 只沿**角度**算一条高度线 `heightAt(i)`，然后纵向用
`rows = [0, 0.16, ... 1]` 直线插值成一面朝场内倾斜的薄墙（`radius = R - h*inset*t`）。
于是：顶线近乎水平（噪声 `base*env` 平均只有 0.3，再 smoothstep 饱和）、没有前后坡、
没有山谷/支脉、山脚与水面一条硬直线。材质是 `MeshBasicMaterial + 顶点色 + 照片贴图`，
连 `normal` 属性都没有（暴雪 `#bakeMountainSnow` 里的 `nrmA` 一直走 0.6 兜底）。

### 新实现（同一函数整体重写）

- **拓扑**：`(segments+1) × bands` 环形高度场。新增 `MOUNTAIN_BANDS`（high [12,10,8] /
  medium [9,8,7] / low [7,6,5]），`radius = R + depth*(0.5 - t)`，t=0 外山脚 /
  t≈0.3 脊线 / t=1 内山脚。山体纵深 160/270/420m，不再是一张纸。
- **高度场**：`H = prof * ridge[i] * (1 - 0.72*valley) + 支脉 + 二维噪声微起伏`；
  `prof = pow(p, 1.15)`，峰位 `peakPos` 随角度摆动。
- **主脊**：改成**显式主峰叠加**（20~26 座/圈，`exp(-|d|^1.25)` 给尖顶、`skew` 给不对称坡），
  **加一条连绵基脊** `chain = 0.34 + 0.24*nValley`，峰从脊上长出来。
  关键教训：噪声+smoothstep 会饱和成平顶；纯主峰叠加会让峰之间沉到海平面变成孤岛；
  上幂次会把整段压矮。三者都不行，必须"基脊 + 尖峰 + 深谷通道"。
- **二维噪声**：新增 `makeMountainNoise2D(seed, nx, ny)`，角向 wrap、纵深钳制，
  三个尺度分别管谷地/支脉、山坡起伏、岩面褶皱。首尾 u=0/1 严格一致，环形无接缝。
- **法线**：相邻顶点叉乘求真实法线，写入 `normal` attribute；顶点色里的方向光、天光补光、
  谷地 AO（`neigh - H`）、坡度分层（陡壁露岩 / 缓坡长草）、沉积岩层条带全部基于它。
  顺带修好暴雪覆雪（之前没有 normal，一直用常量 0.6）。
- **起伏**：hMin/hMax `6~138 / 24~236 / 56~388`；按 `hScale = clamp(boundary.r/700, 0.6, 1.0)`
  自适应 —— lake/canyon 的 r≈325 若套用 ocean 的 138m，山峰会直接压到看台头顶。
- **贴图**：`contrast 0.55→0.68`、`hueKeep 0.12→0.18`；UV 的 v 从"只按高度铺"改成
  "高度 ×1.6 + 纵深 ×1.6"（原来 u 方向的重复次数远多于 v，纹理被拉成白色瀑布竖条）。
- **山脚**：新增 `footFade`，y<70m 融进 `hazeCol`，消除"背景板插进水里"的硬交线。
- **雪线**：0.52×hMax → 0.70/0.78×hMax 且只看朝上坡面，远层不积雪（半山腰不再白一片）。

### 范围

这套山脉由 `#makeRidgeSheet()` 统一生成，改一处覆盖 `canyon / lake / ocean / palace`。
**不生效且本来就不该改**：`tide / strait / magma`（`noMountains: true`）、`baked`
（Blender 段模型自带山）、BOSS / 竞技场（`BossThemes.setTheme` 调 `env.setTerrainVisible(false)`
换成专属背景）。BOSS 火山关实拍确认过：那条深褐色水平带是 BOSS 自己的背景，不是这套山。

### 验收

`tests/water_ab.mjs` 加 `FRAME=mountain` / `YAW` / `CAMH` / `PITCH` / `MODE` 开关、
TAG 带 mapId + yaw（避免多地图覆盖同名文件）。对照页 `shots/water/mountain-ab.html`。

- ocean 正反两个方向无接缝/破面；canyon / lake 色板与自适应山高正常；
- 暴雪天气按真实法线重烘焙雪山，无黑块/破面；低画质 `MOUNTAIN_BANDS` 轮廓完整；
- 真 GPU 帧成本 1440×900 约 **10.4ms**（改前 11.1ms，未变慢）；三角形 6.4k → 14.3k，
  全是顶点开销，材质与片元路径一字未动；
- `npm test` PASS、`npm run build` PASS（与 test 并发跑时 dist 资源复制偶发锁冲突，单独重跑即过）。

## 漂移系统彻底重做（跑跑卡丁车式，2026-11-15）

### 病根

旧模型是「贴地转向 + 假侧滑」：`driftCut` 入漂一帧砍速 7~11%、拉车头倍率在
`2.05 / 0.75 / -1.65` 三点跳变、松键即断漂、方向入弯锁死、碰撞直接 `nitroCharge = 0` 清空集气。

### 新模型（src/game/Boat.js）

- 核心：**车头 = 轨迹方向 + 滑移角**。`driftAngle` 是主状态，一阶限速连续变化；
  `vf = S*cos(A)` / `vl = -S*sin(A)`，速度永远沿轨迹走、不沿船头走。
- `driftPathYaw` 管轨迹自身偏航（`pathYaw = 1.15`），与滑移角解耦；断漂后按 0.12s 衰减。
- 方向键持续给目标滑移角（拖漂）；反打时目标符号连续翻、角度穿过 0（彩虹漂）；
  `steerActive` 必须用**未平滑**的 `steerTarget`，否则反打穿过 0 会被误判成回正发喷。
- 单/双喷按本轮峰值滑移角判定：16° / 30°；按住漂移键、方向回中当场发喷。
  发喷后给 `driftBreak = relock(0.28s)`，防残余滑移角在下一帧重新触发 `canEngage`。
- 减速渐进：上限 `0.94×` 极速、滑移角拉满再压 7%，`dragRamp = 0.55s` 渐入，
  作用于**总速度** `S = hypot(vf, vl)`；`slipMode` 跳过侧向抓地衰减（否则每帧白吃一大截速度）。
- 碰撞：`cancelDriftForCollision()` 只把 `nitroCharge` 回退到 `driftGaugeStart`，
  `nitroBottles` 一个不动；`driftChain = 0.85s` 窗口内重新按住不清计时/峰值/基准（断漂补气）。
- 逐船差异在 `src/data/boats.js` 的 `driftAngle / driftRate / driftYaw / driftDrag`（移除 `driftCut`）；
  `AudioEngine.js` 新增 `drift_boost / drift_boost2` 一次性音效。

### 验收（全部实测，不是估的）

- `tests/drift_probe.mjs` 纯物理 8 船：峰值角 35.4°~43.4°、0.13~0.22s 到 30°、
  入漂 1s 掉速 −4.66%~−7.12%（单帧最大 −0.15%~−0.20%）、拖漂 3s 保速 91.0%~93.0%、
  90° 弯漂移 1.13~2.33s vs 不漂 1.67~3.13s；点按不给喷、断漂补气接着计时。
- `tests/drift_race_smoke.mjs` 真 Game 循环（输入/统计挂 `updateLocal`，物理帧驱动，
  时间线按 dt 累加）：rower@ocean / cow@strait / titan@lake 全部
  **连续漂移段 4.2s + 1.6s、0 碎段、双喷 2 发、碰撞 0.43→0.25 且瓶 1→1、0 NaN / 0 逻辑异常**。
  隔离项：起点静态碰撞体、护栏 `wallContactTimer`、外海圆边界回弹、浪尖抛飞；
  碰撞由受控 collider 注入，仍走 `updateLocal` 的真实圆碰撞分支。
  Effekseer 无头 `texImage2D` 异常单列隔离，不算逻辑异常。
- `tests/drift_shot.mjs` 视觉：top 视角尾迹与船体长轴不重合、chase 视角可见侧倾。
- `npm test` PASS、`npm run build` PASS。报告 `shots/drift/index.html`（生成器 `tests/_gen_drift_report.mjs`）。

### 顺带修的两处工程问题

- `scripts/vite-run.mjs`：编程式 `vite.build()` 在本项目 5 段内联 `<style>` 下稳定报
  `[vite:html-inline-proxy] No matching HTML proxy module found ... index=0.css`（只转 1 个模块）。
  改走 `vite/bin/vite.js build --emptyOutDir false` CLI，保留 TEMP 重定向 + robocopy 清 dist。
- `tests/gameplay.test.mjs` 补 3 条漂移契约断言（回正冷却、原始 `steerTarget`、碰撞回退语义）。

### 已知遗留

- `npm run test:visual`（`tests/visual-smoke.mjs`）仍是旧 UI（`#menu-boat` / `.boat-card` /
  `#btn-map-ok`）与旧键位（`keys.add('shift')` / `'a'`，现在驾驶键走 `codes`），且固定访问 5173。
  属历史过期脚本，与本轮漂移无关，未改。

## 全图清除程序化「红白浮标」（2026-11-15）

用户反馈霓虹海峡又出现「暗红圆柱 + 灰白锥顶」的低模浮标，要求盘查全部地图并删除。

### 盘查结论（8 张地图，按 `Environment.#buildShores` 的真实分支）

| 地图 | style | 早退条件 | 原是否有红白浮标 |
| --- | --- | --- | --- |
| canyon 峡谷激流 | canyon | 峡谷岩壁分支 | 无 |
| lake 湖泊环线 | lake | 湖岸分支 | 无 |
| ocean 峡谷险道 | ocean | 无 | **有** |
| palace 深海龙宫 | palace | 函数开头 return | 无 |
| tide 冰汐海峡 | ocean | `navBeacons` 跳过 | 无 |
| strait 霓虹海峡 | ocean | 无 | **有** ← 用户截图 |
| baked 秘境漂流 | baked | 函数开头 return | 无 |
| magma 熔岩夜航 | ocean | `mapDef.lava` 函数开头 return | 无 |

唯一生成点：`src/game/Environment.js` `#buildShores()` 的 ocean 分支，每隔一个门在
弯道外侧 `gateWidth+4` 处摆一个 `CylinderGeometry(0.8,1.0,2.2,8)`（随机 `0xe84545` 红
或 `0xf5f5f5` 白）+ `ConeGeometry(0.8,1.0,8)` 白锥顶。不写 collider，纯装饰。

### 为什么「以为删过却又出现」

- 之前退役的是 `Track.js` 的 `red_buoy_chain.glb`（低模红桶链），已换成 Blender 红漆浮标
  `buoy_fallback.glb`（有贴图），`gameplay.test.mjs` 里那条陈旧断言也改成了「旧 GLB 已退役」。
- `Environment.js` 这套**独立的程序化红白浮标**是更老的历史遗留，从未清理。
- 霓虹海峡做长赛道迁移时设成 `style:'ocean'`，且不像冰汐海峡那样带 `navBeacons`，
  于是命中这段遗留分支 → 每 2 个门一个红柱，暴雨暗光下尤其扎眼。

### 改动

- `Environment.js` 的 ocean 分支只保留 `return`，删除整段浮标几何与两个材质。
  **必须保留 return**：后面是峡谷岩壁 / 河岸 / 树林逻辑，纯水面赛道落下去会凭空长岸和树。
- 边缘标记仍由 `Track.#buildEdgeBuoys`（蓝白浮桶，带碰撞）+ `navBeacons`（灯船）承担；
  蓝白/黄绿浮桶、黑黄导向牌、门旗等布景全部保留。

### 验收

- `node --check src/game/Environment.js` PASS；全库与 `dist` 都搜不到 `0xe84545` 生成代码；
  `npm run build` PASS（dist 已同步）。
- 实拍 `MAP=strait GATES=3,5,7 TAG=noredbuoy WB_URL=http://127.0.0.1:5199/ node tests/baked_look.mjs`：
  `shots/verify/strait-noredbuoy-g{3,5,7}.jpg`。g5 / g7 完全无红柱；g3 只剩远处一个小的
  橙色锥形装饰（细锥、非圆柱浮标，属另一套布景，未动）。

---

## 2026-11-15 山脊贴图「贫瘠」二次修复 + 漂移贴内弯收尾

### 用户反馈

1. 山脊「形状修好了，但贴图几乎没有，太贫瘠了」，要「有阴影有拓扑的贴图、正常大小、不要拉伸」。
2. 漂移「太靠外，一直按着偏移半径一直往外，要绕内弯」。

### 山脊根因（为什么上一版会「没贴图」）

- `getMountainRockTexture()` 是 `#eae9e5` 近纯白底 + 极淡圆斑（alpha 仅 4~14%），
  `MeshBasicMaterial` 里 map 与 vertexColors **相乘**，再被方向光 / 大气透视一压，肉眼不可见。
- `tileM` 是 110 / 230 / 380 米才铺一张 512px 贴图：整座山只有 1~2 个 tile，
  mipmap 一平均，连那点斑块也没了。
- 山脚 `lowHaze + footFade` 相加能到 0.96，把山水交界刷成硬白块，顺带冲掉贴图。

### 山脊改动（`src/game/Environment.js`）

- 贴图改为**离线烘焙的岩面浮雕**：周期值噪声 + 域扭曲 fBm → 高度场 → 梯度求方向光
  → 柔和坡面阴影 + 高度 AO + 中频颗粒。贴图均值 ≈ 245（只调明暗不染色，色相仍由顶点色决定）。
- 试过 Worley 岩块，实测会在每座山上画出均匀「龟裂 / 铺路石」黑缝网格，**已弃用**并加断言防回归。
- 项目自带的 `rock_face_diff_1k.jpg`（方向性弱）异步叠 0.56 权重的**归一化灰度细节**，
  只借相对明暗、不借棕色；加载失败自动退回纯烘焙版。没用旧航拍岩地图（自带竖向岩柱）。
- `tileM` 收到 **72 / 130 / 210**，一层山能看到 2~4 个 tile；UV 仍是环向弧长 + 坡面累计弧长，等比不拉伸。
- 山脚两种雾改 `Math.max(lowHaze, footFade)`、上限 0.88，`lowHazeK` 降到 0.52/0.34/0.16。

### 漂移贴内弯（`src/game/Boat.js`）

- `angleBase 0.22 / angleGain 0.34 / angleCap 0.66`，`pathYaw 1.48 / pathYawTau 0.06`，
  双喷门槛 30° → **24.6°**（磐石号满速峰值 27.3°，不降门槛碰撞掉速后只给单喷）。
- `tests/drift_arc_probe.mjs` 圆拟合实测（赤焰号 @ 外海）：起漂 0.5s R **41.3 → 29.0m**，
  稳态 R **28.1 → 21.7m**，稳态滑移角 **36.7° → 29.7°**。

### 验收

- `npm test` PASS / `npm run build` PASS（13.3s，dist 已同步）。
- 补判据：`tests/mountain_stripe_audit.mjs` 新增 **detail = 水平高频能量 ≥ 3.3**，
  专门抓「平滑灰板也能通过」；`vertEnergy < 3.0` 的暴雪/浓雾图按低对比度豁免。
  最终 4 图：ocean `stripe 0.650 / colRow 1.637 / detail 3.96`、canyon `0.638 / 1.502 / 4.02`、
  lake `0.667 / 1.994 / 4.098`、blizzard SKIP。旧拉丝图 1.009~1.108，旧平滑版 detail 2.17~2.49，均可检出。
- `tests/gameplay.test.mjs` 加 6 条源码断言（高度场 / 梯度烘阴影 / 照片层 / tileM / 雾合并 / 禁 Worley）。
- `shots/drift/index.html` 重生成（16.1 KB），参数全部改为 import `DRIFT_TUNING` + 探针 JSON 动态读取，
  清掉 30° / pathYaw 1.15 / 旧帧数等残留口径，新增「贴内弯」小节。
- 实拍：`shots/water/mtn-tex3-{ocean,canyon,lake,blizzard}*.jpg`。

### 已处理：删掉 ocean 远景白色圆顶

- **更正上一轮的错误判断**：那两块白色圆弧**不是** `maps.js icebergs` 的 GLB 冰山。
  `icebergs:{large:12,small:26}` 只挂在 `tide 冰汐海峡`；截图是 `MAP=ocean`。
  真正来源是 `Environment.#buildDistantIsles()`：`style==='ocean'` 时生成 7 个压扁半球
  （灰褐岩身 + 绿草帽），远景被大气雾洗成纯白圆顶，压在山脚与水面交界。
- 影响范围只有 `ocean` 一张图：`tide / strait / magma` 都是 `noMountains:true` 提前 return，
  `palace` 走另一个分支。远岛本来就不挂 collider，删视觉不会造空气墙。
- ⚠ **不能整行删调用**：原函数每次循环消耗 5 次 `this.rng()`、共 35 次，
  而 `#buildShores / #buildRocks / #buildWhales / #buildShips` 接着同一条确定性 LCG。
  少 35 次整张图的树/礁石/鲸鱼/帆船/浮冰都会挪位。改成
  `#consumeDistantIslesRng()`：照常走完随机序列，不再创建几何体/材质。
- 实拍 `shots/water/mtn-noisle-ocean-day-mountain-y0-base.jpg`：白圆顶消失，
  山脊岩纹保留，浮标链与近景礁石位置逐像素一致。
- `gameplay.test.mjs` 加 3 条断言锁住「不再建几何体 + 35 次 RNG 消耗保留」。

### 已知遗留（未动，与本轮无关）

- `tests/visual-smoke.mjs` 仍是旧 UI / 旧键位，`npm run test:visual` 历史失败。


## 璀璨星空水面「比天还亮」：倒影罐被星空粒子糊成白板（2026-11-15）

用户截图（峡谷险道 · 璀璨星空）：中景整片水是灰白板，浮标/引导线糊在背景里。

### 归因（实测，不是猜）

- 新增探针玩法：`tests/water_ab.mjs` 加了 `FRAME=chase`（追尾真实机位）、`KEEP_BOAT=1`、
  以及**分量拆解变体** `o_body / o_sky / o_spec / o_env / o_skyonly`（把 `gl_FragColor` 换成单项输出）。
  再用 `gl.readPixels` 读同一列像素，得到可比数字（1286×872 缓冲区，x=12%）。
- 结论：**水体色一直是正常的深蓝（bodyCol 0/14/41）；白的是 `sky` 项（240/240/241）**。
  关掉 `uEnvOn` 后中景从 `199/200/202` 掉到 `10/27/56` → 100% 是倒影 cubemap 的锅。
- 为什么罐里是白的：星空天气的 8150 个发光点（三层星 + 银河星带 + 星尘）在每个 128² 面里
  占不到一个像素，**平均成一片中性白**；实测罐内采样 ≈ 1.9 且 RGB 三通道相等。
  水面掠射反射率 0.8 × 夹到 1.8 的白 = 整片饱和。
- **压 `uEnvMax` / `uEnvAmt` 治不好**（0.48/0.48 试过）：白乘小系数仍是灰，色相早丢了。

### 改法

1. `Water.bakeEnvironment(renderer, scene, pos, skyMesh, exclude)` 新增第 5 参：
   烘图期间临时 `visible=false` 的物体列表，**存进 `#envExclude`**（昼夜 4s 重烘也照做），
   `finally` 里还原。
2. `Game.#envExclude()` 返回 `[env.nightSky.group]`（星星/银河/星云/星尘/流星都在这组里；
   水面星点 `glintsRoot` 在场景根上，**不摘**，反射里仍有零星星闪）。两个烘焙点都传。
3. `Water.#applyWaterGrade()` + 天气对象新字段 `waterGrade: {sat, exposure, absorb}`：
   没传就是原来的 `0.94 / 0.86 / 0.019`（其它 4 档天气一字不变），`setQuality` 也走它，
   避免降画质时把天气档冲掉。
   - `WEATHERS.starry`：`1.10 / 0.68 / 0.030`
   - `maps.js` 熔岩 `weatherBy.starry`：`1.02 / 0.82 / 0.024`（亮蓝水道要留，压狠了会和黑地壳糊成一片）

### 效果

- 中景水面 `199/200/202` → `10/30/70`；月光路中心仍 `229/234/243`（GGX 高光没动）。
- 追尾 / 掠射两个机位对照页 `shots/water/starry-water-compare.html`（可拖分割线）。
- 霓虹海峡星空抽查正常（浮标、荧光路缘、月亮路都清楚）。
- `npm test` PASS、`npm run build` PASS。

### 坑

- A/B 变体顺序会互相污染：`old`（故意把星星烘回去）跑在 `base` 前面时，`base` 复用了那张白罐 ——
  想比"改前/改后"必须 `VARIANT=base,old`（把"恢复原样"的放最后）。
- `Environment.js` 正在被另一个会话编辑：`npm test` 读到半个文件会报
  `Private field '#consumeDistantIslesRng' must be declared`，几秒后自愈，别急着改源码。

## 开场镜头拍到「水面外的灰色地带」+ R 键不再没收氮气（2026-11-16）

### 现象 / 归因

玩家反馈竞速、道具赛的**开场镜头**把「赛道水面外面灰色未建模的部分」也拍进去了。
用 `tests/race_intro_shot.mjs`（新探针，可按进度钉住开场镜头取帧）复现：
霓虹海峡 T=0.02 画面右下角有一块**边界笔直、毫无纹理的浅色楔形**。

- 先怀疑 `Water.farSea`（远景海面平板）：把 `farSea` 从父节点摘掉，楔形**仍在** → 不是它。
- 沿该像素方向做射线 + 世界 AABB 粗筛（探针 `DIAG=1`）：只打到水面板本身 + 远景海面。
- 结论：楔形就是**水面板的边界**。板外没有波浪水面、没有远景海面（`farSea` 远环也在板外更远处），
  直接露出天空穹顶 —— 于是读成"灰色未建模地面"。

数值钉死原因：霓虹海峡 `boundary {x:14,z:-494,r:580}` → 水面 1247m（半幅 623），
而发车格在边界圆**北沿**（z≈39），离板边只剩 **89m**；开场俯视段机位离地 115m，
画面四角能望到 ≈**150m** 外的地面 —— 光学上就盖不住。

### 改法（只动一个数）

`Game.js`：`waterSize = Math.max(700, Math.round(mapRadius * 2.15) + 300)`
（`+300` 是"开场镜头活动范围"的余量，boundary 只包住赛道本身）。霓虹海峡 1247 → 1547m，
发车格到板边 89 → 239m。水面网格分段数按画质档固定（192/128/96），顶点开销不变；
`farSea` 内外半径按 `size` 等比推导，接缝比例不变。

### 竞速 / 道具开场镜头路径

`#startRaceIntro()` 的 10 点路径本身**没改**（`compact` 版仍是 3 点窄航道推进）；
改完水面后 `strait / canyon / ocean / baked` 四个机位段（T=0.02/0.2/0.35/0.55）复拍都没有板边外露。

### R 键复位不再没收氮气

- `Boat.resetTo(x, z, heading, opts)` 新增 `opts.keepNitro`；不传仍清空（发车摆位走默认值）。
- `Game.respawnLocal()` 的 `reset()` 闭包、掉断层、掉出赛道三处都传 `{keepNitro:true}`。
- 回归：`tests/nitro_reset_probe.mjs`（预置 0.62 气 + 1 瓶 → 派发 KeyR → 断言仍为 0.62/1；
  同时给 `respawnLocal` 挂计数器当正样本，避免"按键没接住也算 PASS"；再断言无 opts 的
  `resetTo()` 仍然清零）→ 全 PASS。

### 其它天气的水面数值：一个都没动（实测）

| 天气 | uSat | uExposure | uAbsorb | uEnvAmt | uEnvMax |
|---|---|---|---|---|---|
| day | 0.94 | 0.86 | 0.019 | 0.85 | 1.8 |
| storm | 0.94 | 0.86 | 0.019 | 0.85 | 1.8 |
| starry | 1.10 | 0.68 | 0.030 | 0.85 | 1.8 |

即 `#applyWaterGrade()` 的默认分支就是改动前的字面量；`waterGrade` 只有 `WEATHERS.starry`
与熔岩图 `weatherBy.starry` 传值，倒影 cubemap 的夹取参数（`uEnvAmt/uEnvMax`）全天气一致。

### 资产

- `tests/race_intro_shot.mjs`（新）：`MAP/T/WEATHER/TAG/OUT`，`HIDE=far`（摘远景海面）、
  `YOFF`（压远景海面高度）、`DIAG=1`（沿画面某点射线 + AABB 粗筛找物体）。
- `tests/nitro_reset_probe.mjs`（新）。
- 对照页 `shots/intro/intro-water-edge-compare.html`（两组可拖分割线：T=0.02 / T=0.2）。
- `npm test` PASS、`npm run build` PASS（dist 已同步）。

### 怪物模式 HUD 面板：补「金属框带 + 四角铜角片」（index.html boss-skin 块）

问题：参考图（`clipboard-...-50c48ce0.jpg`，红框标在小地图四角）里那块面板是
**有厚度的锻铁框带 + 四角黄铜角片 + 铆钉**；我们的只有一圈 3px 黄铜细线，
内腔直接近黑，看着像"纸片贴了根金线"。

改动（只碰 `#hud.boss-mode` 前缀，竞速/道具/竞技场模式零影响）：

- `#minimap-wrap`：外框 `3px` 黄铜 → `2px`；框带改用三圈 inset 阴影叠出
  `1px 亮线 → 3px 中灰(#5d5749) → 10px 深灰(#3a352d) → 11px 暗缝`，
  再留 `-3px` 底部内阴影；`padding` 加到 `12px 12px 10px`；
  `border-radius: 3px`（圆角大了角片贴不平）。
- `#minimap-wrap::before`：四角铜角片，`20×20` 对角渐变 × 4，
  色阶 `#a98d55 → #b7934f → #7d5f26 → 亮脊 #e2cd9c → 深缝 #17130d → 透明`。
  **`inset: 0`**（不是负值 —— 负值会让角片顶出面板边线，四角看着像"支棱的尖刺"）。
- `#minimap-wrap::after`：四颗铆钉 `radial-gradient(circle 2.9px at 6.5px 6.5px)`，
  高光点 + 暗环。
- `#player-list .pl-self`：同一套材质薄一档（`1px 亮线 → 3px 中灰 → 6px 深灰 → 7px 暗缝`）。

验收：`tests/boss_hud_probe.mjs` PASS（断言从"3px 包边"改成"2px 黄铜细边 + 框带主体走 inset 灰带"）；
`npm test`、`npm run build` PASS，dist 已同步。
截图：`shots/verify/boss-hud-final.jpg`（整屏）、`shots/verify/boss-panel-final.png`（前后对比）。

探针备忘：`tests/_boss_panel_shot.mjs`（`OLD=1` 运行时注入旧样式，做同视口前后对比）；
`tests/_crop_zoom.mjs`（`RECTS` 像素框裁剪并排放大，`SAMPLE="x,y;x,y"` 采像素色）。

## 道具图标换成赛博 Q 版 PNG（2026-11-16）

用户提供 22 枚「明亮赛博 Q 版」透明 PNG（1024²，来自 `道具图标_明亮赛博Q版_22枚_1024透明PNG.zip`），要求先替换看效果。

### 做法（只动显示）
- 图标放 `public/icons/items/`（22 张，16 MB，未压缩）。
- `ui.js` 顶部加 `ITEM_ART`（按**道具名**映射到图片路径）+ `ITEM_ART_ON` 开关（设 false 一键回 emoji）。
- HUD 渲染 `renderHud` 里：有图就 `<img>`，没图继续用原 emoji；给 `.item-icon` 加 `has-art` 类。
- `index.html` 加 CSS：普通模式显示 50px，怪物/竞技场显示 44px，`object-fit:contain` + 轻投影；`has-art` 关掉原 emoji 的蓝色 drop-shadow。
- 只覆盖 pack 里有的 22 件；BOSS 专属的破甲标枪 / 深海鱼叉 / 三连深水弹 / 引雷针 / 冲角护符 5 件仍用 emoji。

### 验证
- `tests/item_icon_shot.mjs`（新探针）：进道具赛 → 塞 nitro/bomb/octopus → 强制显示被开场镜头隐藏的 HUD → 截图。
  实测 DOM 三个 `<img src="/icons/items/...">` 都在，截图 `shots/icons/hud-item-icons.jpg` 清晰、无裁切。
- 全览对照页 `shots/icons/道具图标替换效果.html`（22 枚网格 + 游戏内截图 + 5 件待生成）。
- `npm test` PASS；`npm run build` PASS，`dist/icons/items/` 22 张齐全。

### 怪物 HUD：框带改「生锈铁」+ 清掉玩家名牌外那圈蓝边（19:30）

上一版框带是 `inset 0 0 0 10px #3a352d` 这种**纯色**，在亮水面背景上直接读成一条黑边，
和参考图的"锈铁框"完全不是一个东西 —— 纯色 inset 撑不起材质。

- `#minimap-wrap`：`box-shadow` 里只留外圈黑边 + 投影，**不再塞实色带**（实色会盖住锈带）。
- `#minimap-wrap::before` 改成「锈带环」：
  `padding:12px` + `mask: linear-gradient(#000)#content-box ⊕ linear-gradient(#000)`
  （`-webkit-mask-composite: xor` / `mask-composite: exclude`）掏空中间，
  环里铺 7 层：4 个**大尺度椭圆锈斑**（90~110px，12px 窄带只切到它一段，
  所以是"这块锈了那截没锈"）+ 2 层竖纹（92°/88°，一浅一深）+ 1 层 7px 细颗粒 + 上亮下暗底。
  ⚠ 早先试过 26px 小圆点平铺，退远看是"一串珠子"；锈一定要**大斑 + 竖纹**才像铁。
- 角片 + 铆钉合并到 `::after`（`::before` 已被环占用）；角片 `inset:0`，用负值会顶出边线。
- `#minimap` 加 `0 0 0 2px #170e06`（画布外一圈凹槽），画布才像嵌进框里。
- **蓝框根因**：`#player-hud` 容器自带 `border:1px rgba(168,198,222,.55)` + `0 0 0 2px` 蓝灰环，
  boss 皮肤只改了内层 `.pl-self`，于是变成"铁板外套一个蓝框"。
  boss 模式下把容器 `background:none / border-color:transparent / box-shadow:none`。
- `.pl-self::before` 同款锈带环，`padding:6px`。

验收：`boss_hud_probe` PASS；截图 `shots/verify/boss-hud-rust.jpg`、`hud-rust-zoom2.png`。

### 磐石号换模型：base_basic_shaded.glb（19:25）

- 源文件：15.6MB / 353,466 tri / 247,646 vert / 2048² PNG，材质是**底色纯黑 + 全自发光**。
- 工具链：**Blender 5.2.3 无头**（`D:/blender/blender.exe`），脚本
  `scripts/blender/optimize_boat_glb.py <in> <out> [targetTris] [texSize]`：
  1. `remove_doubles(1e-5)` 焊接 247,646 → 176,680 vert；
  2. `DECIMATE / COLLAPSE + use_collapse_triangulate` 到目标面数（353,466 → 60,000）；
  3. `shade_auto_smooth(35°)`（减面后必须重算，否则硬表面出现脏软影）；
  4. 贴图 `img.scale(1024)`，材质把自发光贴图接到 Base Color、`Emission Strength=0`
     （否则夜里整船发光），Metallic 0.25 / Roughness 0.55；
  5. `export_image_format='JPEG'` + `export_draco_mesh_compression_enable=False`
     （游戏侧 GLTFLoader 没挂 DRACO，**不能开压缩**）。
- 产物 `public/models/boat_ironside.glb`：**1.71MB / 60,000 tri / 29,998 vert**（-89% 体积）。
- `src/data/boats.js` 只改 `titan.model`，`id` 不动 → `Game.NITRO_JETS.titan`（双喷 sides）
  与 `boatWeapons.titan`（三联重炮）零改动直接继承。
- 朝向：模型沿 +Z 建模（bbox z 1.77 / x 0.89），`modelRotationY: 0` 不变；
  `hull.length 4.6 / 1.77 ≈ 2.6` 倍缩放后宽 2.31m ≈ `hull.width 2.3`。
- 验收：`_titan_look.mjs` 前/后/侧/俯四角度无破面；`DRIVE=1` 加速态
  `g.fx.attached` 命中 `boost:me:0` 与 `boost:me:2`（双喷都挂上了）；
  `npm test` PASS、`npm run build` PASS（`dist/models/boat_ironside.glb` 已同步）。

## 图标全量接入 + 道具箱霓虹改版 + 拾取破碎（2026-11-16 晚）

### 一、无头测试的浏览器配置目录搬出项目（硬约束）

用户反馈：Edge 不退出时 `.tmp_browser` 会堆到几十 GB，还会让 Vite 的文件监听崩掉。

- **规则**：`--user-data-dir` 一律写 `D:/3dgame-tmp/browser/<名字-时间戳>`，**禁止**项目内路径。
- 已批量替换 `tests/*.mjs` 109 个文件、112 处；`scripts/boats/sheet.mjs` + 两处注释同步。
- `vite.config.js` 的 `server.watch.ignored` 保留 `**/.tmp_browser/**` 并追加 `**/3dgame-tmp/**` 兜底。
- 已写进 `.workbuddy/memory/MEMORY.md` 协作约定。

### 二、67 枚图标接入

新增 `src/ui/icons.js`：`ICONS` 全量表 + `ITEM_ART`（按道具名）+ id→key 映射
（`MODE_ICON / MAP_ICON / WEATHER_ICON / BOSS_ICON / DIFF_ICON / STATUS_ICON / MOB_ICON / WEAPON_ICON`）
+ `iconImg(key, cls)` / `setIcon(el, key)`。找不到 key 返回空串，调用方回退原 emoji。

接入点：

| 位置 | 数量 | 文件 |
|---|---|---|
| 道具栏三格 | 27（22 + BOSS 专属 5） | `ui.js` renderHud |
| 大厅模式按钮 / BOSS 两档 | 5 + 2 | `main.js` 抽屉 |
| 天气选项 | 5 + 随机 | `main.js` 抽屉 |
| 地图选择卡 | 8 | `main.js` 抽屉 |
| 选船详情·主炮 | 8 | `ui.js` lobbyBoatStatsHtml |
| BOSS 铭牌 | 4 | `ui.js` renderHud |
| BOSS 状态标签 | 7 | `ui.js` 两处（`#boss-debuff` / `#hud-debuffs`） |
| 结算奖牌 / 冠军 | 3 + 1 | `ui.js` MEDALS / `main.js` medal |
| 大厅信息条 / 小地图天气 | 2 | `ui.js` |

- 图标按**浅底**设计，压在深色按钮上会发灰 → 统一 `brightness(1.14) saturate(1.1)`。
- 尺寸集中在 `index.html` 一处：`.lp-map-icon 48 / .lp-ico 22 / .lp-boss-art 38 / .lc-ico 15 / .mm-wico 15 / .mcb-ico 20 / .medal-ico 22 / .bd-ico 15 / .wpn-ico 26`。
- 总开关 `ui.js` 的 `ART_ON`，改 false 全量回 emoji。
- **未接**：小怪 6、以及静态 HTML 里的设置 / 改名 / 帮助 / 警告 / 信号按钮（改静态节点容易挤坏布局，等确认）。

### 三、道具箱改成参考图样式（所有模式共用 `ItemBoxField`）

- 面板：`makeNeonPanelTexture()` 程序化 256² 贴图 —— 深黑底 + 斜向五段霓虹渐变
  （青 `#35e6e0` → 蓝 → 紫 → 洋红 → 橙 → 金 `#ffd24a`）+ 中心提亮 + 四角压暗 + 32px 细网格。
  `map` 与 `emissiveMap` 同图 → 只有色带发光，Bloom 不会把整块烧白。改不透明（原 0.8 半透明）。
- 金属框：颜色 `0x0f1218` 哑光深黑，metalness .95 / roughness .38。
- 黄铜铆钉：8 个箱体角各一颗（`SphereGeometry` + 铜色 `0xd9a441`），单独 InstancedMesh 跟箱体自转。
- 问号：`makeQuestionTexture()` 改空心描边灯管 —— 洋红晕 30px → 紫 20px → 青 11px → 白芯 4px，四层 stroke。
- 效果图：`shots/icons/itembox-neon.jpg`。

### 四、拾取破碎（碎片散落水面）

- `ItemBoxField` 新增 `debris` InstancedMesh（14 片/次 × 5 槽）+ `burst(x,y,z)` + `#updateDebris(dt,t)`。
- 触发**不写在拾取回调里**：`update()` 比对 `prevAlive[i]`，箱子从 true→false 就是被吃掉，
  自动在该位置炸开 —— 道具赛 / 怪物 / 竞技场三条删箱路径一处全覆盖。
- 碎片：14 片 `size*0.17` 小方片，`instanceColor` 按调色板轮流上色（青/紫/洋红/橙/金/深黑×2），
  初速水平 1.5~4.4、垂直 1.7~4.5，重力 15，落水后 `settled` 贴 `waveHeight` 漂 0.34s 再淡出。
- 效果图：`shots/icons/itembox-burst.jpg`。
- 探针 `tests/itembox_neon_shot.mjs`（`g.post.render` + `toDataURL`，同进程取两张）。

### 五、验证

`npm test` PASS、`npm run build` PASS（`dist/icons/` 22 + 67 张齐全）。
资产总览页 `shots/icons/道具箱与图标更新.html`。

## 碎片夸张化 + 地图卡压扁 + R 复位改成「按地点后退 35m」（2026-11-16 深夜）

### 一、道具箱破碎：为什么碎片是白的一团

- **病根是材质上的白色 `emissive`**：`instanceColor` 只乘漫反射（`diffuseColor`），
  **不乘自发光**。所以 `emissive: 0xffffff` + `emissiveIntensity 0.62` 等于给每片都加了
  一层白光，五色调色板全被洗成粉白 —— 看起来就是"粉白纸片"。
- 第二个帮凶是 `metalness: 0.8`：金属没有漫反射，颜色只能靠环境反射，在没 envMap 的地方直接发灰。
- 现在：`emissive 0x000000`、`metalness 0.25`、`roughness 0.42`、`envMapIntensity 1.15`。
  颜色全靠 `instanceColor` 走漫反射，青/紫/洋红/橙/金/深黑全部正常显色。
- 破碎幅度：**30 片/次 × 4 槽**、单片 `size*0.22 × size*0.22 × size*0.055`；
  水平初速 3.6~10.4、垂直 3.2~9.1、`spin ±26`、重力 15、寿命 1.4~2.5s；
  每片再加一个 `d.sc = 0.55~1.5` 的随机缩放（清一色大方片最像纸片）。
- **光圈已删**：`#playFx('ring', …)` 整行去掉，全仓库 `grep "playFx('ring'"` 已无调用。

### 二、地图抽屉一屏排完（8 张不再拖滚动条）

- 卡片从「图标在上、文字在下」改成**横排**：`<img>` + `<span class="lp-map-txt">`（包 b + small）。
  图标 28px、卡片高 54.4px、`.lp-grid-map` gap 7px。
- 上方预览块一起收：`.lp-route` 168 → **118px**、`.lp-desc` 限 2 行、`.lp-map-meta` 内边距压小。
- 验收口径（写进探针，别靠眼睛）：`PICK=map node tests/lobby_icons_shot.mjs` 会打印
  `scroll.need`（抽屉 `scrollHeight - clientHeight`，**必须 0**）、`cardH`、`lastFits`。
  当前：`{"need":0,"sh":698,"ch":698}`、`cardH 54.4`、`lastFits true`。

### 三、R 复位：从「回到上一个门」改成「按地点后退固定距离」

- 旧逻辑 = 回最后一个已穿过的门。门间距 50~90m，一次 R **白送半条直道**，
  玩家反馈"经常复位到之前很远的距离"就是它。
- 新 `Track.respawnPoint(pos, gateIndex, back = RESPAWN_BACK)`（`RESPAWN_BACK = 35`）：
  - 主道：沿门折线（首尾闭合）**按弧长后退 back 米**，朝向取该段前进方向；
    `s` 夹在 0 上，不跨越起点线（跨了会被判成"刚完赛"）。
  - 近道内：沿**近道自己的折线**后退，不会被拽回主道；
    近道本身比 back 还短时（霓虹海峡 A 道只有 **53m**）停在**近道起点**。
    ⚠ 旧写法在这里是"回主道、再从入口往后退 back"，实测会把只走了 20 多米的人
    丢到 53m 外，等于白罚一倍 —— 这是这轮 strait 唯一一处 FAIL 的真因。
  - 主道找最近点**限窗**：只在本船该在的 3 段门里找（`nearestOnPolyline` 新增第 4 参 `segs`）。
    叠层赛道（立交桥 / 瀑布上下段）2D 最近点可能在另一层，全局搜会把人穿桥丢下去。
- `Game.js` 三处统一走它：R 键 `back = 35`、掉断层 `30`、掉出赛道 `30`。
  高度优先 `track.surfaceYAt(x, z, 门号)`，问不到再退回 `gateY`。
- **复位不吞门**：`pm.gate` 前后不变，既不提前送门，也不改圈数/名次。
- `shortcutRespawnAnchor()` 标 `@deprecated`（"原地放回"会让人反复撞墙），没有调用方了。

### 四、自测（1293 个采样点 + 真实按键路径）

- `tests/respawn_probe.mjs`（重写）：只验几何。每段门取样 **15 / 50 / 85%** 三个点，
  每条近道按弧长取 **30 / 55 / 80%** 三个点，五条断言：
  ① 必须返回有效点 ② 到触发点 ≤ 55m ③ 必须落在**某条**合法走廊内（主道**或**任一条近道）
  ④ 近道内触发仍在近道走廊内 ⑤ 朝向与所在段前进方向夹角 < 60°。
- `tests/respawn_runtime_probe.mjs`（新）：把本地艇真的摆到赛道上、调**真正的**
  `respawnLocal()`，验位移 / 走廊 / 高度（`|y - surfaceYAt| < 6`）/ `pm.gate` 不变 / 近道内复位不出近道。
- 结果（8 张图全 PASS）：

| 图 | 门 | 采样 | 近道 | 平均后退 | min | max |
|---|---|---|---|---|---|---|
| ocean | 50 | 147 | 0 | 33.9 | 26.7 | 35 |
| canyon | 24 | 69 | 1 | 33.6 | 25.2 | 35.5 |
| lake | 16 | 45 | 1 | 34.6 | 33.6 | 35 |
| palace | 17 | 48 | 1 | 34.4 | 31.5 | 35 |
| tide | 20 | 57 | 2 | 33.8 | 23.6 | 35 |
| strait | 55 | 162 | 2 | 32.3 | 11.7 | 35 |
| baked | 209 | 624 | 0 | 32.9 | 6.4 | 35 |
| magma | 48 | 141 | 2 | 34.2 | 3.1 | 39.2 |

- `min` 很小的那几个点都在**起点线附近**（`s` 被夹到 0，没法退到发车前）或
  **近道入口**（停在近道起点），是有意为之，不是 bug。
- 真实路径自测：magma 10/10、strait 10/10、baked 8/8 全 PASS。
- ⚠ 探针偶发 `自测没返回结果`：端口是按时间戳尾数算的，前一进程没死透时会连到旧的
  CDP 页面。重跑即可，不是游戏 bug（现在会打印页面内异常，便于区分）。


## 熔岩石柱「顶住抽搐」：静态硬物碰撞按撞击速度分档（2026-11-16 晚）

### 现象 / 归因

- 按住油门顶住熔岩石柱 → 船在柱子前面**反复前后抽动**，速度表在 0 和十几之间跳。
- 病根在 `Boat.updateLocal` 的圆-圆碰撞 heavy 分支：**所有**硬物一律 `e≈0.45~0.70` 反弹
  + 最多 `6.5m/s` 的「顶飞」冲量 + 甩头 + `0.32s` 抖屏 + 硬直。
- 石柱自己不会动，于是变成闭环：油门加速 0.2s → 撞上 → 被弹回 2~4m → 再加速 → 再撞。
- 实测（`tests/obstacle_press_probe.mjs`，按住油门 5 秒）：弹回 **3.68m**、船头甩 **45.9°**、
  抖屏 12 帧；20m/s 正面撞上去弹回 **15.97m**（等于把人扔回半条直道）。
- 还有第二个坑：法向速度被墙吃掉后船速变 0，而船的转向率是跟车速走的
  → **0 速怎么打方向都不转**，人被钉死在柱子上出不来（截图里 0 km/h 就是这么来的）。

### 改法（只动 `Boat.js` 圆-圆碰撞的 heavy 分支）

- **区分静/动**：`!c.ref` = 静态岩（熔岩柱 / 岸边礁石），带 `ref` = 滚石 / 落石。
- **按 closing（法向接近速度）分档**，静态岩 `< 5m/s` 全部归零：
  - 回弹 `e`：0 → 0.26（随 closing 线性，25m/s 到顶）；动态硬物沿用 0.45 → 0.70。
  - 顶飞冲量：静态岩 0 → 2.6；动态 ≤ 6.5。
  - 侧翻 / 甩头 / 抖屏 / 硬直只在 `> 5.5m/s` 才给，且随速度放大（旧版恒定 `0.32`）。
- **蹭边通道**：静态岩顶死且总速度 `< 3m/s` 时，按住方向 + 油门沿障碍**切线**给
  ≤ `4.5m/s` 的滑动速度（并按转向轻抹船头 `0.55rad/s`），能顺着石柱蹭出去；
  不按方向 / 松油门则一点额外位移都没有，不会自己漂走。
- `heavyImpactSpeed` 照旧记录（撞碎岩判定读它），不受影响。

### 验证（`tests/obstacle_press_probe.mjs`，新增；必须补 `track.constrain` 才能复现）

| 场景 | 改前 | 改后 |
|---|---|---|
| 顶住柱子 5s：弹回距离 | 3.68m | **0.12m** |
| 顶住柱子 5s：船头甩动 | 45.9° | **5.5°** |
| 顶住柱子 5s：抖屏帧数 | 12 | **0** |
| 顶住柱子 5s：稳定速度 | 来回 0~14.6 | **0.19（真停住）** |
| 20m/s 撞上去：弹回 | 15.97m | **2.42m** |
| 顶住 1s 后打方向 | 卡死（0 速、0 位移） | 13.4m/s 蹭出去 |
| 20m/s 擦着边过 | — | 不顶回、不减速，顺柱面滑过去 |

- 四个场景全 PASS；`tests/magma_collision_audit.mjs` `TOTAL_BAD 0 / GRAZE_REPELLED 0`；
  `npm test` PASS、`npm run build` PASS。

## 船对船碰撞：按真实接触点做冲量（21:40）

原实现的两个「假」的来源都定位到了：
1. **法线取的是两船中心连线**。4.6×2.3m 的细长船体，中心连线和真实接触面法线能差 40°，
   于是侧撞带出前后分量 —— 玩家读作「被刻意往别的方向撞」。
2. 结算完还有一刀 `vel *= 0.84~0.99`（与撞击方向无关），所以撞哪都掉速。

改法（新增 `src/game/boatContact.js`，纯函数可单测）：
- 用**船体中轴线段最近点**求接触法线（细长体最稳的做法）；两船完全重合时退化为中心连线，
  连中心都重合再用本船横向轴兜底，保证法线是单位向量、绝不含 NaN。
- 沿法线施加冲量：`jn = -(1+e)·vn / (1/mA + 1/mB + 杠杆项)`，`e = 0.22`；
  **正撞两船一起减速、侧撞只横推**，不再有全局常速衰减。
- 接触点偏离重心产生**力矩** → 船头朝被撞的反方向偏（上限 `0.24rad ≈ 13.7°`）。
  接触点在重心正侧面时杠杆臂为 0，所以正撞不会莫名打转。
- 切向摩擦用库仑上限（`μ=0.30`）：擦边几乎不掉速，正面硬顶才磨掉速度。
- **并排退化**：两条中轴平行且推力纯横向时，最近点对是不唯一的（会稳定挑到端点 →
  凭空多一个力矩，并排擦碰变成"船头自己甩开"）。这种情况接触点改取重心，杠杆臂 0。
  轴向前后接触（追尾/迎头）不套这条，端点就是真实接触位置。
- 旧接口 `boatCollisionResponse` 保留为「杠杆臂 0」的退化版，`tests/gameplay.test.mjs` 照旧过。

Boat 侧新增 `applyBoatImpact(dvx, dvz, yaw, opts)`：
- 速度只有一次改变（动量守恒的正确做法），但引擎每帧会把 `vel` 拆成前向/侧向，
  侧向紧接着被抓地衰减 + 滑移角上限钳（`|vl| ≤ 0.30·|vf|`，船几乎停着时上限≈0）——
  一帧就把横向推力清零。所以额外开 `impactGripTimer`（0.12~0.20s）：
  这段时间抓地按 0.30 打折，且滑移角上限给一个 `6m/s` 的绝对下限。
- 船头偏转**直接写 heading**，不走 `angVel`：stun / 低速时转向块整段不执行，走 angVel 会丢。

### 验证

| 用例 | 结果 |
|---|---|
| `tests/boat_contact.test.mjs`（新增，11 条） | PASS |
| `tests/boat_impact_probe.mjs`（新增，真引擎跑物理帧） | PASS |
| ↳ 侧撞（20m/s 前向 + 6m/s 横切）：Δvl | **-3.4m/s（被推开）**，Δvf 仅 -1.1 |
| ↳ 正撞 28m/s | **28 → 14.6（掉 48%）**，船头仅偏 3.9° |
| ↳ 并排同速 22m/s | **22 → 21.7（0.8%，只有水阻）** |
| `npm test` / `npm run build` | PASS |

## 秘境漂流：7 条实拍 bug 集中修复（11-19）

### 1 / 4 隧道全黑 + 隧道只剩一半（同一根因）

- 11-18 那次 `#cutBakedFromCorridor(cave_shell, 7, 22)` 本意是修「大黑墙」，实际上
  把门 7~22 走廊上方的三角面连**洞顶一起删了** → 隧道只剩两侧洞壁（图 3）。
- 真正的黑是**洞里没有光源**：场景只有半球光 + 平行光且投影，洞顶一盖全在阴影里，
  cave_rock 是纯 PBR，直接黑成一团（图 1 的"大黑墙"就是这么来的，还能穿过去）。
- 改法：
  - 撤掉 7~22 的剔除（回程 188~206 那段保留）；洞顶恢复。
  - 新增 `#buildCaveLamps()`：沿门 2..21 每 3 门交替在航道两侧立 `flow_marker.glb`
    木柱灯（自带贴图 + 发光灯罩改暖白），每盏挂一个 `PointLight(0xffb066, 1800, 120, 2)`。
    灯柱在 `gateWidth + 0.7` 外侧，不参与碰撞。
- 实测：`shots/verify/baked-fix5-g6.jpg` 洞内岩壁/洞顶有层次，黑墙消失。

### 2 上坡处白色物体横拦赛道（图 4）

- 是 `#buildCloudTower` 的 `tower_deck`（白色走道）。门 23~29 的急弯处相邻两行法线
  转得快，扫出来的板面自交、斜穿航道。
- 改法：建 deck 索引时剔除「三个顶点分居中心线两侧」的三角形（只删真正的横穿面，
  柱子/渠沿/走道都在同侧，不受影响）。
- 实测：`baked-fix3-g27.jpg` 上坡航道内已无白色物体。

### 3 森林段水面漫出白色沙岸（图 2）

- 只对 `return_water` 做过收窄，`forest_water` 漏了。
- 改法：`forest_water` 同样走 `#narrowBakedWaterToBank(def.beach.from, to)`（门 64..86）。
- 实测：`baked-fix4-g68.jpg` 水边已贴合沙岸内沿。

### 5 蘑菇碰撞超模 + 没有反弹

- `minD = c.r + 1.35` 的余量比船体半宽大一截 → 没碰到模型就被挡。
- 反弹被 `vel *= 0.62` 吃掉，手感是「撞进泥里」。
- 改法：`bakedObstacles` 保留 `kind`；蘑菇 `c.r + 0.55`、树 `c.r + 0.95`；
  反射拆法向/切向，法向恢复系数 0.55、切向保留 0.92，不再整体乘 0.62。
  失控时间 0.35s → 0.25s。

### 6 发卡弯分叉口「看着能直行、其实必须绕圈」（图 5）

- 门 119~130 与 149~156 压在**同一条水面**上（入口/出口共用航道），
  入口和出口的岸带被 `#buildReturnBank` 的正常避让逻辑跳过了，看上去是个缺口。
- 任何实体墙都会把绕完回环的正常路线一起堵死，所以只做**不参与碰撞**的视觉导流：
  新增 `#buildForkMarkers()` —— 7 块 `rock_hazard_a.glb` 石墩 + 2 块
  `guide_sign_post.glb` 立柱（canvas 蓝底黄箭头，牌面朝来船、箭头指右转）。
- ⚠ 踩坑：第一版把石墩摆在中线外 9m、**贴水面高度**，正好落进回程堤身里
  （堤身横向占 gateWidth-0.4 ~ gateWidth+0.4+walk，即 7.1~10.7m），水上一颗看不见。
  现改为**全部落在弯道外侧的堤顶走道**：横向 = 走道中线 9.0m，高度 = `returnBank.height`
  （3.4m），沿门 131.2~134.8 每 9m 一颗，箭头牌用本地坐标挂在牌柱 2.5m 高、正面 +0.31m。
- 实测：`baked-forkfix3-g129.jpg` / `baked-forkfix3-g131.jpg`（玩家视角）+
  `baked-signclose2-g131.jpg`（近景），石墩成列沿弯、转向牌清晰可读且不挡航道。

### 7 终点水面斜穿隧道南壁（图 6）

- 回程末段门 203/204/205 到隧道轴线横向偏差 13.6 / 9.85 / 5.95m，隧道半宽只有 9.4m
  → 船从门 204~205 之间**穿过南壁**进洞。
- 改法：门 200~205 整体向北收（z 分别 -31.07→-27.5、-25.7→-19.5、-20.32→-9.0、
  -14.95→-3.0、-9.57→-0.4、-4.2→0.9），让最后一段沿隧道轴线、从西口正面进洞。
  新横向偏差 1.7 / 0.7 / 0.9m。
- 实测：`baked-fix3-g204.jpg` 船已在洞内、水面与洞口对齐，不再穿岩壁。
  注意：单圈弧长略变，历史幽灵/纪录会失效（已与玩家确认可接受）。

探针踩坑记录：AI 艇型号随机 → 椭圆半径每次不同，靠"死写 2.4m 间距"会差 0.015m 打不中；
改成页面里 `import('/src/game/boatContact.js')` 量出真实 `minD` 再摆位（现在自适应）。

## 霓虹海峡：城门重做（横梁不再切视野）+ 石材贴图（22:20）

### 问题定位

- 旧 `gate_lintel.glb` 是 **19.5 × 0.7 × 1.8 的一根细横梁**，吊在 `f.y0 + 7.4`，
  两侧墙只有 **2.75m 高** —— 梁底离水面才 7.4m，开过去整条视野被切一刀。
  顺带发现城顶松树是按 `f.y0 + 6.85` 摆的，等于**浮在墙上方 4m 的空中**。
- 「二维码」感的来源：石墙只有 4 种几乎同色的深绿灰色块、全靠平涂，没有纹理层次。

### 资产（`scripts/blender/build_strait_stone.py`，Blender 5.2 无头）

| 文件 | 尺寸 | 面数 | 说明 |
|---|---|---|---|
| `stone_wall.glb` | 14.9 × **6.85** × 5.5 | 11,340 | 5 层错缝砌块 + 勒脚 + 压顶 + 两道扶壁 |
| `gate_lintel.glb` | 26.5 × **16.2** × 5.0 | 16,092 | 双墩 + 通深楔石拱 + 檐口 + 垛口 |

- 砌块是**独立六面体**（灰缝 0.026m），整体倒角 0.019m 做崩边、平直着色；
  8 个材质基调按确定性哈希分配 → 8 个 primitive → 游戏侧读成逐块顶点色。
- 内芯是深色实体，但**只在两墩和拱背以上**：门洞必须空。第一版拿 26m 宽的大方块当内芯，
  整个门洞被堵死，远看像一扇关死的城门（截图实锤后改掉）。
- 拱券用**通深楔石**（一整圈铺满 4.6m 进深），拱腹就是连续弧面；
  旧做法（0.3m 面砖 + 轴对齐垫块）抬头看到的是"阶梯叠板"。
- 城墙顶面 **6.85m** 与既有松树落点对齐；门洞净空：拱脚 11.2m / 拱顶 **12.6m**。
- ⚠ 坐标坑：建模用「下游坐标（X 宽 / Y 高 / Z 深）」，写顶点时才转 Blender 的 Z-up。
  第一版直接按 Blender 轴写，导出后高度落到 Z 轴上 —— 摆进游戏就是**躺倒的墙**。

### 代码（`Track.#buildStraitProps`）

- 城门改为**站在水面上**：`addProto('gate_lintel', f.gx, f.y0, ...)`（去掉了 `+ 7.4`）。
- 霓虹条跟着抬到拱腹：`f.y0 + 12.42`（原 7.2）。
- 石材着色升级：`getStraitStoneTexture()`（只取红通道乘明暗）→
  `getStraitStoneMaps()` 出**两张 512² canvas**（颜色 + 高度），着色器里做
  **三平面投影**：颜色贴顶点色，高度场求梯度当额外法线扰动（`stoneRelief/stoneEps`）。
- 材质 `roughness 0.97`、`envMapIntensity 0.6`：全强度环境光会把这批石头照成"上釉瓷砖"。
- 补丁命中检测：`window.__stonePatch = { color, normal }`，探针直接读，避免字符串没匹配还静默通过。

### 验证

- `tests/strait_wall_shot.mjs`（新增，5 个固定机位）：`STONE mesh ready`、
  `PATCH {"color":true,"normal":true}`，五张图全部落盘。
- 验收口径：① approach —— 门洞能看见后面的第二、三道门；② clearance —— 驾驶位视角拱顶完全在视野之上；
  ③ arch —— 拱腹是连续弧面；④ wall —— 逐块色差 + 灰缝；⑤ walltop —— 松树落在墙顶面。
- `npm test` PASS、`npm run build` PASS（`dist/models/track/*.glb` 已同步）。

## 秘境漂流视觉/手感修复（第一轮，2026-11-16 深夜）

用户一次提了 6 条，先做「定位明确、改动独立」的 4 条，剩隧道重建 + 机器人骨骼见下。

### 一、云端螺旋塔塔柱缩小（68 → 44m）

- 第 4 条那个「矗立在地面、能穿过去的巨大物体」= `tower_pillar`（`tower.pillarR`，原 68m、
  高 72m、**没有碰撞体**）。下降螺旋半径 76m，净空只有 8m，整根柱子糊满屏幕。
- 改 `src/data/maps.js` 的 `tower.pillarR: 44` → 净空 32m，从坡道上能看见水面绕塔身。
- 塔柱是纯视觉体，**不影响任何物理/赛道判定**；`scripts/gen_cloud_spiral.mjs` 的 CFG
  里那份 68 只是历史数据源，不参与运行时。

### 二、隧道出口的白色卡通云 —— 全删

- 云来自 `#buildApproachClouds()`（程序化低模云团，门 23~29 两侧）。
- 数据侧加开关：`tower.approach.clouds = false`（maps.js），函数开头 `if (cfg.clouds === false) return;`。
- 其它地图没有这个字段 → 行为不变。

### 三、隧道出口「能穿过去的浅色横带」= 被压平的 stairs_shell

- 用户第 3 条红框里那道横跨水面的带子，是 `stairs_shell.glb` 被
  `#trimBakedCorridor()` 逐顶点压到甲板下 0.45m 之后塌成的一块平板。
- 现在阶梯段的水面/渠沿由塔的 `approach` 断面从门 23 起自己生成，
  `stairs_shell` 整块不画（`o.visible = false`），`stairs_water` 保留。
- 实拍：门 20 / 22 / 24 航道干净，水面连续，没有横带。

### 四、船体吃水太深（秘境图）

- 根因不是船模型，是 `diveHeightAt()`：`openTrack`（烘焙图）恒返回门高度插值，
  水线段就是 **0**，于是船被 `diveTargetY` **硬钉在 y=0**；
  而那段可见水面是借用主游戏 Water 材质的 GLB 水面（晴天浪峰就有 +0.5m）→ 浪一过就盖住船。
- 改 `Game.js`：`openTrack` 且 `|h| < 1.5`（水线段）时**不传** `diveTargetY`，
  让船正常吃浪；云端/瀑布/栈道这些抬高段照旧贴 `gateY`，不会穿板。
- 实测：`diveTargetY` 变 `null`，船高随浪在 −0.14~+0.37 之间起伏（改前恒 0）。

### 五、定位结论（还没改的）

- 第 5 条「白色东西横跨水面」**不是沙滩**，是 **回程石堤的起点**（门 86）：
  两条石堤从水里凭空冒出一个三角尖，没接岸。沙滩那一段（门 64~86）实测是正常的河边沙洲。
- 第 1/2 条「起点在开阔水面、隧道左半边缺失」：`cave_shell` 的洞口左半确实没几何，
  边缘是锯齿状断口；起点线对象本身存在且可见（贴浪 +0.2m），只是低视角贴水面看不见。
  计划：用程序化拱顶把洞口补完整 + 起点线/发车位搬进洞口内侧。
- 第 6 条 `hazard_bot.glb`：1 个 mesh、7395 顶点、3200 面、**0 骨骼 0 动画**，已导入 Blender 待绑骨。

---

## 终点判定重做：船头压线是唯一依据（2026-11-16）

### 用户口径

「必须严格按船头碰触终点线的瞬间结算；现在船头还没进终点就完成了。」同时保留：
开局倒车再进起点线不算一圈。

### 实测定位（`tests/finish_lap_cycle_probe.mjs`，逐帧录，不靠猜）

| 现象 | 实测 |
| --- | --- |
| 闭合图（海峡 / 熔岩） | 其实**已经是船头压线**：触发帧 `bowS≈+0.1`、`ctrS≈-2.2` |
| 圈数 | `pm.lap` 从 **0** 起，`laps=3` 要过 **4** 次线才结算 → 3 圈赛要跑 4 圈 |
| 秘境漂流（闭合烘焙图） | **完全不结算**：`openTrack` 让冲线判定直接 return，开环分支又要求 `!loopClosed`，条件互斥 |
| 开环赛道（若 `closed:false`） | 用「离最后一门 13m 的圆」当终点 → 船头还差十几米就结算 |

### 改动

1. `src/game/finishLine.js` 新增 `trackFinishLine(track)`：闭合环线终点 = `gates[0]`（半宽取起点线全宽），
   开环赛道 = 最后一门（半宽 `gateWidth*1.15`）。**开环方向必须取「倒数第二门 → 最后一门」**，
   `gateDir(N-1)` 会回卷到 0 号门、方向正好相反（旧版就是因为这个才改用圆形范围）。
2. `Game.#crossedFinish(boat, st)`：船头线段这一帧从线后穿到线前 + 交点横向在赛道内 + 已跑够
   一圈的 45%（开环 20%）。本地玩家与 AI 共用同一份几何。
3. `progressMap` 圈号统一从 **1** 起（原来 0），完赛条件 `lap > finishLaps`，
   `finishLaps = 开环 ? 1 : laps`。
4. `#checkLocalGates` 只推进门序号 + 上报进度，**删掉**用船重心判定的 `lineAsFinish`
   和开环「门圆即终点」的结算分支。`#checkAiGates` 的 AI 完赛也改走船头压线。
5. `#onRemoteGate` 与 `server.handleGate` 只认发送方显式标的 `finish: true`（外加圈数校验），
   不再"消息里带 totalTime 就完赛"。
6. 单测 `tests/finish_line.test.mjs` 扩到 28 项，含「开环终点方向不能回卷」「开环+已闭合按闭合处理」。

### 验收

- `node tests/finish_line.test.mjs` → PASS (28)
- `node tests/finish_lap_cycle_probe.mjs`（海峡）→ 3 圈 = 3 次过线，每次 `bowS≈+0.1` / `ctrS≈-2.2`
- `MAP=baked node tests/finish_lap_cycle_probe.mjs` → 秘境漂流恢复正常结算
- `NOARC=1 …` → 只跑 63m 就压线，圈数不变（倒车/蹭线不算）
- `node tests/ai_finish_probe.mjs` → AI lap 1→2、`finishWindowActive=true`、玩家未受影响
- `npm test` PASS、`npm run build` PASS

### 新增测试资产

`tests/finish_lap_cycle_probe.mjs`（连续压线，`NOARC=1` 验门槛）、`tests/ai_finish_probe.mjs`、
`tests/finish_bow_probe.mjs`（船头几何：代码 2.20m vs 渲染 2.21m，误差可忽略）。

### 六、第二轮：吃水再修 + 沙洲接到岸（2026-11-16 深夜）

**吃水（第二版）**：第一版让船"跟着浪浮"只解决了开阔水面；洞里可见水面是 `cave_water` 网格
（基本是平的），船跟海面浪谷往下沉时**整艘沉到洞内水面以下** —— 正是用户"隧道里还是太深"。
- `Game.js` 每帧给船一个 `floatFloorY = surfaceYAt() + 0.05`（仅 openTrack、非腾空、非过山车）。
- `Boat.js` 浮力分支末尾：`floatY = max(floatY, floatFloorY)` —— 船高永远不低于赛道水面。
- 实测（门 10/16）：船高恒 ≥ 0.05（改前会掉到 −0.14），追尾视角整艘船露在水上。

**沙洲（第 5 条真凶）**：`#buildForestBeach` 的断面原来只铺到 `HW+17.5` 就沉到水下（−1.3m），
沙洲在水面中间生生断掉 → 低机位看就是"两条白带横在河心"。
- 断面改成 7 档：`HW+0.5 / +2 / +6 / +13 / +22 / +32 / +40`，近岸高度维持 1.15~1.25m
  （还是那条看得出来的沙岸），一路铺到 40m 外的树林脚下，只有最外沿没入水里。
- 实测（门 79）：沙岸从水边连到树线，河道两侧读起来是正常河岸。

### 七、探针踩坑（写下来免得再犯）

- 单人模式下不操作会被判 DNF 然后 dispose `window.__game` → 摆相机前**必须先摘掉
  `opts.onFinish/onQuit`**，否则后面所有 shot 都是 `Cannot read properties of undefined (reading 'track')`。
- 秘境图的 GLB 要 10s+ 才齐；判断"隧道在不在"要等 `baked_cave`+`baked_forest` 都进 `track.group`。
- 另一路 AI 会并发改 `Game.js`/`Boat.js`：改完立刻 `npm test`，读到半个文件就等几秒重试。

### 八、碰撞反弹 + 浮桶穿模（2026-11-16 深夜）

**① 高速撞石头停住**（用户明确要求先搜业界算法）
- 依据：赛车/赛艇通用碰撞响应 `v' = v_t·μ − e·v_n·n̂`。
- 两处病根：扫掠碰撞在「起点已在圆内」时没有早退，每帧 `vel *= 0.55` + 硬直重置 0.38s
  （按住油门顶住石头 → 永远退不掉的硬直）；圆-圆碰撞把整条速度乘 `keep` 一刀砍掉。
- 改法：扫掠段 `cc <= 0` 直接 `continue`；圆碰撞法向按 `e` 弹回、切向 `μ≈0.99`，
  `e` 0.20→0.48（动态 0.32→0.58），`closing>4` 补最小分离速度，撞完 `impactGripTimer 0.22s`。
- 实测 28m/s 斜撞：撞完 3.4 → 15.85m/s，退回 3.1 → 7.66m，按住油门 5s 从 0.01 → 15~27m/s。
- 回归 `tests/rock_bounce_probe.mjs`、`tests/obstacle_press_probe.mjs`（四场景 PASS）。

**② 霓虹海峡 38~41 门浮桶交叉**
- 根因：回头弯（149~155°）内角 miter 交点被推到 34.5m 外，浮桶链变成一根细针，
  针两臂空间上只隔 2m。弧长等距撒点管不了空间距离。
- 改法：`Track.#buildEdgeBuoys` 内角加 `MITER_LIMIT = 2.5` 截断；`sampleSide` 加
  `MIN_GAP = 3.2` 最小间距兜底（跳过但不重置 run）。
- 实测：strait 最近桶距 1.95 → 3.34m、`overlapCount 0`；magma 6.02m / 0。
- 新增测试资产：`tests/buoy_overlap_probe.mjs`（MAP/LIMIT）、`tests/buoy_shot.mjs`（GATES）。

## 两个大工程：洞口石拱 + 机器人走路骨骼（2026-11-16 深夜）

### 一、洞口石拱（`#buildStartTunnel` + `maps.js` 的 `baked.startTunnel`）

**问题**：`cave_shell` 的洞口左半边**压根没有面**，断口是锯齿状三角边 —— 从发车格往前看
就是一个被啃掉半边的大黑洞；起点线又正好压在开阔水面上，低机位几乎与水面齐平看不见。

**做法**（不在 Blender 里修，因为重烘的模型一定会和现在的 gates 错位）：
- 沿门中心线现扫一段石拱：`back: 24`（从 0 号门往回 24m，把发车格罩进洞里）→ `to: 6`。
- 断面 13 个点：墙脚（水面下 2.2m）→ 直墙 → 肩 → 尖圆拱（高 7.6 + 拱起 2.4）。
  ⚠ 别用半椭圆：洞口宽 18m 只拱 2.4m，会平得像一个方形门框（试过，很出戏）。
- 半宽 9.4m > 走廊 7.5m：**只包不挡**，物理上完全不碰船。
- 材质：深褐岩石（顶点色带确定性色差 + 墙角压深），`DoubleSide` + 一点自发光
  （洞里没有直射光，纯 PBR 会黑成一团）。
- 结果：起点变成"在洞里发车"，起点线清清楚楚铺在水面上，洞口是一个完整的圆拱。

### 二、机器人走路骨骼（Blender）

- `hazard_bot.glb` 实测：1 个 mesh、7395 顶点、3200 面、**0 骨骼 0 动画**。
- 建 7 根骨骼：`hips / chest / head / arm.L / arm.R / leg.L / leg.R`。
- **自动权重（ARMATURE_AUTO）失败**（Bone Heat 无解，权重全空）→ 改用**最近骨段刚性绑定**：
  每个顶点整体归到"最近的骨线段"，只在同部位、且两骨距离差 <0.10m 时做 ≤0.35 的过渡，
  避免关节硬切、同时不允许跨部位过渡（手不能拉身体）。
- 走路循环 24 帧 / 24fps（1 秒无缝）：腿 ±18°、手臂反相 ±12°、躯干每步轻微起伏 + 侧摆、
  头部微仰。
- 导出 `public/models/hazards/hazard_bot_walk.glb`（2391KB，1 个动画 `Walk`，7 关节、21 通道）。
- 预览：`shots/baked/bot_walk.html`（24 帧播放器）+ `bot_walk_sheet.png`（8 关键帧拼图）。
- **还没有接进游戏**：用户要求"先做测试版给我看"，确认姿势后再替换。

### 三、踩坑

- 这台 Blender 是 **5.2**：`Action.fcurves` 没了（改用 `action.layers[].strips[].channelbags[].fcurves`），
  而且**没有 FFMPEG 输出**（`image_settings.file_format` 里没有 FFMPEG）→ 只能渲 PNG 序列，
  系统也没装 ffmpeg/PIL，所以预览用 HTML 播放器而不是 mp4。
- 同一个浏览器进程里**第二次 `post.render` 之后 `window.__game` 会消失**（swiftshader）：
  截图必须一个进程一张，用 `GI/BACK/H/TAG` 环境变量分别跑。

### 九、怪物模式 HUD 换锻铁贴图（2026-11-16 深夜）

用户给了一张 AI 生成的锻铁纹理 + 别的 AI 写的取色分析和 `.hud-panel` CSS，要求照改。
那段 CSS 的选择器和本项目对不上（本项目是 `#hud.boss-mode`，且 `::after` 已被四角铆钉占用），
所以按等价方式落地：

- 新增 `scripts/make_iron_tile.mjs`：裁掉水印 → 压平大范围明暗 → 半张滚卷 + 羽化做无缝平铺，
  自检接缝差（5.44 / 7.10）与图内邻列差（5.69 / 6.68）同量级。产出 `public/ui/boss-iron.jpg`。
- `#hud.boss-mode` 的 `--plate` 换成「压暗罩(.10/.24) + 贴图 380px 平铺 + 兜底 #3A2C22」，
  压暗罩写在 background 第一层（不用 `::after`）。
- 小地图 12px「锈带」从 8 层手绘渐变（含 7px 重复点阵，放大是机械格子）改成同一张贴图 + 锈斑；
  操作提示条从半透明深色改成 `--plate` —— 否则贴图提亮后处处断层。
- `boss_hud_probe` 的小地图断言改为查 `background-image` 含 `boss-iron`，并新增贴图资源加载检查。
- 合成后实际面板色 ≈ `#483828`（用户样本区间 #2F2119~#46392D 的亮端）；想更接近 #3A2C22
  把压暗罩改成 `.18/.34` 即可。`npm test` / `npm run build` / HUD 探针 全 PASS。

### 四、发车格搬到起点线后面（2026-11-16 深夜，用户第 1 条）

- 实测（探针 `startpos` 思路）：起点线在 0 号门（along=0），但 `spawnTransform` 因为
  "洞里没顶、镜头一退就到洞外"的历史原因，把开环赛道的发车格放在 **0 号门前方 16m**，
  等于玩家一开局就站在起点线**前面**，线在屁股后头。
- 洞口石拱补好之后（往回铺 24m），这个理由没了 → 改回**起点线正后方 4m**，
  `gate: 0 / lap: 0`。实测：船 along −3.9、镜头 along −13.7、线 along 0 → 线在船前方。
- 圈数安全性：`lapIsComplete(arcSince, total, 0.45)` 要求本次过线前后走过 ≥45% 圈程，
  所以开局那 4m 的第一次压线不会误判成完赛。

### 五、机器人骨骼返工（用户指出"弯曲得不成样子"）

**上一版的错**：我按「每个顶点就近分配给最近骨段」+ 关节处 0.35 过渡来做权重。
这个机器人是一整块曲面（2105 个碎壳拼起来、其实连成一体），
结果锥形躯干被 hips/chest/arm/leg **四根骨头同时拉** → 整个身体扭成麻花。

**根因数据**（这次先量再用）：
- 全网格 7395 顶点 / 3200 面 / 2105 个独立壳；按包围盒相邻合并后其实只有 4 条链：
  身体一整块 + 3 个漂浮小球（左手、右手、头顶天线球）。
- 实测手在 x≈±0.73、z 1.82/1.94；脚在 x≈−0.09 与 +0.23、z≈0。
  **上一版把手臂骨放在 ±0.45（正好在身体内部）**，所以球状的手被分给手臂、而连接段留在身体上 → 手飞出去。

**这一版**：
- 骨骼按实测位置重建：手臂骨从头 (±0.63,·,1.95) 斜向下到手的实际位置；
  腿骨落在两只脚的真实 x（−0.09 / +0.23）。
- 权重改成 **按"壳"整体刚性绑定**（每个小壳只属于一根骨骼，绝不拆分），
  四肢用**胶囊体范围**判定（手臂半径 0.17m、腿 0.21m），其余按高度归头/胸/髋。
- 效果：躯干、头部完全刚性，不再有任何拉扯；四肢作为整体转动。
- 走路循环重做：腿 ±22°、手臂 ±20°（手臂短，角度要够才看得出来）、
  躯干每步轻微起伏 + 侧摆、头部微仰。

**导出**：`public/models/hazards/hazard_bot_walk.glb`（7 关节、1 个动画 `Walk`、2391KB）。

### 十、怪物 HUD 调色（锈橙 → 菜刀钢）+ 两处宽度（2026-11-17 凌晨）

- 贴图不重做，只调 `scripts/make_iron_tile.mjs` 头部的 `SAT 0.18 / LIFT 1.26 / COOL 0.035`：
  按亮度去色 → 提亮中间调 → 轻微冷偏。中位色 `#554230` → **`#5A5A5A`**。
- CSS 配套：压暗罩改中性冷 `rgba(10,12,14)`，兜底 `#3E4245`，`--iron-hi` → `#6E7478`。
- 道具三格 + 氮气长条的框内底色统一成 `var(--plate)`；氮气球补上 `box-shadow`
  （原来只有通用霓虹规则的青色光晕没被覆盖，钢面上是一圈蓝边）。
- 关卡 / 时间铭牌定宽 `100px`（86px 会切掉「0:01.5」最后一位），左右等宽。
- `boss_hud_probe`：道具格断言改为查 `boss-iron` 贴图、bg 切片 40→200 字、
  新增等宽与溢出两条；`npm test` / `npm run build` / 探针 全 PASS。

### 十一、怪物 HUD 第三轮：色值锁定（2026-11-17 上午）

用户给出明确目标色：框内底色 **#4A4A4D → #333336**、黄铜描边 **#B08A45**，
要求"细腻哑光磨砂金属、颗粒细小平整、无大颗粒凹凸"，排除暖棕 / 红褐 / 岩石质感。

- `scripts/make_iron_tile.mjs` 增加四个可标定参数：`MED 77`（中位亮度钉死，贴图亮度变成
  输入量而不是结果）、`FLAT_LO 0.90`（压掉大块斑驳）、`FINE 0.55`（高频颗粒加回来，
  做磨砂手感）、`RANGE 26`（tanh 软限幅，压平锈铁麻点）。产出 p50 = `#4c4d4e`。
- `--plate` 压暗罩改成 178deg 垂直、alpha `0.00 → 0.36`，公式写在注释里
  （`76.7×(1-a)+8a=74` / `76.7×(1-a)+9a=53`）；贴图亮度变了必须同步改。
- 统一了四处前两轮漏掉的：
  ① 技能双槽 `.sk-slot` 一直还是通用霓虹玻璃（`--hud-glass`），与已换钢面的道具格一深一浅；
  ② 道具格空槽被 `opacity:.82` 整格降透明，青色光环透上来变绿雾 → `.96`；
  ③ 氮气槽 / 技能进度槽的暖褐黑 `#0b0906→#1c1710` → 冷灰 `#26282c→#191b1e`；
  ④ 小地图 12px 外圈带仍是 `#4a2d16` + 橙锈斑 → 冷灰底 + 补压暗罩。
- boss 段内 7 处旧黄铜 `rgba(185,138,69)` 统一成 `176`，探针断言同步。
- 实测（像素采样）：玩家名牌 `#4b4d4c`、协同条 `#494a4c`、时间铭牌 `#353533`、
  BOSS 条 `#434544→#2f2f31`、技能卡 `#3d3e40`、小地图带 `#3c3d3f`，R−B 全在 ±5 内。
- `boss_hud_probe` / `npm test` / `npm run build` 全 PASS。

### 十二、名次栏显示持有道具图标（2026-11-17 中午）

用户要求：道具赛吃到道具时，左侧名次栏该玩家右侧显示道具图标（最多 3 枚横排），
组队只显示同队；怪物模式按理全显示，但用户明确「这次先不碰」。

- **先补数据层**：原协议里根本没"某人持有什么道具"——`itemPick` 不带道具名、
  `itemUse` 只有 7 处发且是消耗时刻、state/snap 无 item 字段。
  新增 `itemHeld`（server RELAY_TYPES 加一项，仍只透传）：吃到 / 用掉 /
  AI 用掉时各广播一次完整列表，收到端整份替换。不采用加减推算（会留幽灵图标）。
- `Items.js`：`remoteItems` + `#heldIds()` + `getHeldItems()` + `syncHeld()`；
  `handleNet` 加 itemHeld 分支。`Game.js`：订阅消息、本机用掉补广播、
  standings 按「自己 + 同队」过滤 items（对手可见 = 透视）。
- `ui.js renderRankList`：名字后横排图标，`ITEM_ART[it.name]` 图片优先、emoji 兜底；
  **签名纳入 items**，否则吃到/用掉时名次没变就不重绘。
- `index.html`：图标 22px（普通行）/ 26px（自己行），对齐名次徽章和头像。
- 新增两个探针：`tests/rank_item_icon_probe.mjs`（7 项：自己 3→2、同队 2→1、
  对手 0、尺寸 22~28px、走图片）、`tests/rank_item_net_probe.mjs`（5 项：
  两个裸 WS 验证白名单转发 / 原样到达 / 覆盖式不累积），全 PASS；`npm run build` PASS。
- 旁注：本轮 `npm test` 在 `magma.lava.weatherBy.day.noDayCycle` 失败，
  是并发会话改了 `src/data/maps.js`（时间晚于本次改动），未去动它。

### 十三、璀璨星空浮桶加发光（2026-11-17 中午）

用户：星空天气太暗，全图的赛道边缘浮桶看不见，要像暴风雨那样加亮光。

- 根因：`BUOY_PALETTES` 没有 starry → 回退 day（无自发光），夜雾 fog 0x1d2745 里黑成一片。
  天气切换链本来就通（`setBuoyPalette(weather.id)`），只缺配色项。
- 新增 `starry` 配色，复用 storm 的 glow 机制：`body #eaf4ff / band #0a1626 /
  rope #9fd8f5 / glow #8fd0ff / glowK 0.75 / scale 1.14`。冷冰蓝适配星空氛围。
- 坑：band 必须近黑——emissive 整层叠加、不看顶点色；中蓝环带会被 glow 冲成白蘑菇，
  压到 #0a1626 才读得出"亮桶 + 暗环"的桶形。
- 覆盖 7 张水面图（共享调色板表）；烘焙赛道（秘境漂流）浮标是 GLB 自带、不走这套。
- `tests/buoy_shot.mjs` 加 `WEATHER=` 参数 + 出图前打印浮桶 emissive/intensity/count。
  实测 strait 565 只 / magma 244 只均 `#46a1ff @0.75`；出图确认边界清晰。
- `npm run build` PASS；`npm test` 仅剩与本改动无关的 magma `noDayCycle` 断言（并发改动）。

### 十四、道具赛全盘体检 + 听声辨位（2026-11-17 下午）

用户要求全盘验道具交互 / 音效 / 攻防状态 / 组队误伤，连跑 5 把无 bug；明确
"被攻击方靠听音效防守，不能没有受击前的音效"。先问后做：组队三处区域例外保持原设计，
音效要能听声辨位。

- **音效链路重做**：`AudioEngine` 加 StereoPanner + 单次音量倍率（合成/采样都支持）；
  补 6 件道具 + 4 件 BOSS 道具 + `incoming_alert` / `item_blocked` 音效；`itemSfxName` 真正兜底。
  `Items` 加 `THREAT_ITEMS/GLOBAL_THREATS/HIT_SFX` 三表、`#sfxAt`（左右 + 距离衰减）、
  `#maybeWarn`（只对真威胁响、500ms 去重）、`#reportBlocked`（护盾拦截补消息）。
- **踩坑**：预警音一次异常直接中断 `handleNet itemUse`，让剑刃风暴区域没生成。
  所有音效 helper 现在都 try/catch —— 音效永远不能影响玩法。
- **状态修复**：`Boat.resetTo` 清 `shieldTimer`；眩晕/沉没/打转时禁用道具键；
  `rollItem` 在保底池与领跑屏蔽冲突（`sum=0`）时解除屏蔽，不再恒出血枪。
- **验收**：`ROUNDS=5 node tests/item_marathon.mjs` **5 把全绿 / ≥50 断言 / 0 失败**；
  新增 `tests/item_audio_probe.mjs` 10/10 PASS（含左右声道与距离衰减）。
  `npm run test:items:audio` 可直接跑（需 dev server :5199）。
- 顺手修了 marathon 四处测试脚本遗留：结算补 `finish:true`、每局重挂 raceEnd 监听、
  N6 区域改为直接投递、无头 WebGL 噪声白名单。均非游戏逻辑变更。

## 水面修复：清澈深蓝海水（2026-11-17）

用户给参考图（中等偏深的蓝宝石色、清澈透亮、阳光碎光清楚），但游戏里白天水面实测是
**#BCC8CF 灰白**；用户先说"要浅蓝"又改口"要深蓝一点，不要浅蓝"——最终口径：
**清澈的中深蓝，不要灰白也不要发黑**。

### 归因（不是猜，逐项看 shader 混色链路）

`Water.js` 的水面颜色 = 水体本色 × 天空倒影(菲涅尔) + 阳光高光 + 泡沫，再吃雾。
白天发白是四件事叠加：
1. **倒影给太满**：`envAmt 0.75 / envMax 1.30 / reflMax 0.52`，天空本身是浅色（#afcae8→#e5edf4），
   倒影盖住水体本色 → 海面像刷了一层天。
2. **水色偏灰**：`waterColor #6E8FAC / waterDeep #637587` 本身灰蓝，不是蓝。
3. **SSS 近白**：`waterSSS #BFE6F5`，浪峰透光把整片海洗白。
4. **雾洗白**：`fogColor #7E96AD` 灰蓝、density 0.0022，水面 shader 还额外吃 55% 雾。

### 改法（全在 `src/data/maps.js` 的 WEATHERS.day + 熔岩 day 调色板）

- 水色：`#1B6FAB / #0F4E80`（浅水/深水），浪花 `#C5E6F7` 保持亮；
  SSS 改成 `#7CC9EF`（偏蓝，不再近白）。
- `waterGrade`：`sat 1.12 / exposure 0.84 / absorb 0.019` —— 保蓝、压白、远水沉下去。
- 倒影三件套：`envAmt 0.55 / envMax 1.05 / reflMax 0.38` —— 只留薄薄一层天光。
- 雾：`#6A8FAE / 0.0019`（更蓝、更透）。
- 熔岩图白天单独覆盖水色 `#2085BE / #0E4672`（背景是火山橙红，水要比其它图略亮一档）。
- 阳光高光增益 `uSpecGain` 保持 2.2（用户参考图要碎光），没动。

### 验证

8 张地图各拍一张晴朗白天追尾视角 → `shots/weather/<map>-day-blue.jpg`（熔岩是 `-day-blue2.jpg`）。
实测：近处通透见波纹、远处深蓝有层次，浪花与碎光仍清楚，天空倒影不再糊满水面。

**顺手修的并发副作用**：单测断言 `by.day.noDayCycle === true` 失败 —— 另一路 AI 把熔岩
白天的 `noDayCycle` 从 maps.js 和 Environment.js 里删了，但测试还在。已恢复：
maps.js 的 `lava.weatherBy.day.noDayCycle: true`，Environment.setWeather 的
`this.dayTint = (!w.noDayCycle && this.realSky) ? ... : null`。火山图不再被动态日 tint 冲淡。

`npm test` PASS、`npm run build` PASS。

## 晴天太阳 + 水面反光涟漪 / 氮气尾焰持续（2026-11-17 续）

上半段（深蓝海水调色）已在上节完成，本次接着做完"看得见的太阳 + 水面碎光"，
并复核了上一轮尾焰修复。

### 1. 晴天太阳（着色器太阳，不是几何体/贴图圆盘）

上一段留下的是"白天太阳盘开不出来"：`RealSky` 把 `sunDisc` 抬到 460、日晕给到 0.26，
但晴天米氏散射 `mie 0.0045 / g 0.8` 在太阳周围烘出一片 ±20° 纯白雾团（实测截图白区
占天空 1/3），太阳盘完全被吞掉；Bloom 再把这团白光糊成一大片过曝椭圆盘。

逐项归因（都用 `shots/weather/strait-it*.jpg` 出图验证，关 Bloom 拍对照）：
- `NOBLOOM` 对照：太阳本体只有 ~70px，白团主要是 Bloom 放大；
- 调 `halo`/`sunDisc` 几乎不动白团 → 白雾来自 Preetham 的 Mie 项，不是日晕强度；
- `mie 0.0045→0.0012 / g 0.8→0.72` 后天空恢复蓝色，太阳盘变成清晰白点；
- 再加 `haloPow 900`（原来硬编码 26 次幂，光晕铺 ±20°）把日晕收到 ±3°，
  `halo 0.32 / sunDisc 420` 让盘面比黄昏耀眼但不过曝。

太阳本身仍是大气散射着色器里的 `sundisk` 项，**没有新增任何太阳网格 / 精灵 / 程序化圆盘**。
`RealSky` 新增 `uSunHaloPow` uniform（默认 26 = 其它天气原行为，day  preset 覆盖为 900），
`setWeather` 支持天气表里的 `haloPow` 覆写。

`sunPos` 从 26° 仰角压到 14°（`[205,88,285]` / `sunDir [0.565,0.242,0.785]`）：
原来太高，追尾镜头里太阳永远在上沿之外，玩家只看到凭空出现的亮带；压低后太阳和它在
水里的光路能同框（黄昏是 10°）。水面 `glintGain 1.05` 不变——GGX 主高光负责从太阳
拉到眼前的光路，碎波噪声只叠一点随波纹闪的小光斑，给高了会撒满白点。

出图：`shots/weather/strait-it8-sun.jpg`（正对太阳）、`ocean-final-chase.jpg`、
`canyon-final-chase.jpg`、`lake-final2-chase.jpg`（各图追尾视角）。
湖泊那张全绿的废图是探针把船硬搬到 (0,0) 导致相机钻到水下，不是游戏问题，已修探针重拍。

### 2. 氮气 / 单喷双喷尾焰持续（复核 + 探针加强）

`Game.#updateNitroFx` 已在上半段改为 `boostTimer || miniBoostTimer` 合成信号 +
`nitroFxHold 0.12s` 余辉（见 nitro_flame_probe.mjs 头注释）；`Effects.update` 的
`loopEvery` 补发与"最新一发重新贴喷口"保证粒子不断流。本轮把探针从"只看键在不在"
加强为"同时数还活着的粒子实例"（`h.exists !== false`），否则键在但粒子死光，画面上
照样是没火。

**验收全 PASS**：氮气全程 8/8 采样有键且活跃粒子 8~18；小喷 5/5 有火；
打断后余辉 hold=0.104 仍有 16 个活跃粒子；0.5s 后干净收尾；小喷接氮气无空档。
追尾近景 `shots/weather/strait-boost-close4.jpg` 能清楚看到船尾橙白尾焰。
中途两次探针失败是无头环境的启动抖动（地图抽屉没开 / 游戏被判 DNF 后主循环停了），
清掉遗留 headless 进程并重跑即通过，不是功能回归。

`npm test` PASS（gameplay unit checks），`npm run build` PASS。


## 晴朗天空提亮提蓝（2026-11-17 再调，纯颜色）

用户反馈上一版天空"有点阴沉、像阴天"。只动颜色，不动太阳/水面结构：
- `RealSky.js` day 预设：turbidity 5.0→3.6（浑浊度低=不灰）、rayleigh 1.15→1.95
  （瑞利散射高=蓝）、exposure 0.40→0.45、sat 1.12→1.45、tint 0xf4f8fd→0xe8f2ff；
  top 0xafcae8→0x83b7e8、horizonColor 0xe5edf4→0xd8e9fb；云色改成纯白 / 冷白暗部。
- `maps.js` day 的 skyTop/skyBottom 同步，水面倒影与真实天空同色。
- mie 仍保持 0.0012：抬高会在太阳周围重新烘出白雾团吞掉太阳盘。

出图 `shots/weather/strait-sky1-sun.jpg`（亮蓝天 + 清晰太阳盘）、
`shots/weather/ocean-sky1-chase.jpg`（实际游戏视角）。`npm test` / `npm run build` PASS。


## 玩家名字 UI / 漂移半径 / 晴天天空（2026-11-17 第三轮）

### 名字牌（用户给参考图：白字更大、间距更松）
- `Boat.js makeLabelTexture`：画布 256×64→512×128，字号 22→44px 粗体，描边
  3px/45%→7px/92% 深色 + 软阴影；sprite scale 3.5×1.1→4.6×1.45、抬高到 y=3.7。
- `index.html`：名次栏行距 7→10px、徽章/头像/名字间距 9→13px；
  名字 14px→17px（自己行 17→20px）、字距拉开、改圆润黑体族。
- 出图 `shots/weather/hud-names.png`：船尾名字清楚有深描边，名次栏不再挤。

### 漂移转弯半径（霓虹海峡起步 Z 弯漂不过）
- 关键发现：`DRIFT_TUNING.pathYaw` 的增益一直被 `pathTarget` 的
  `±yawPeak*1.35` 截掉，光调 pathYaw 没用；新增 `pathYawCap` 同步抬高。
- 探针实测稳态半径：普通转向 43m / 原漂移 21.7m / pathYaw 2.05→15.6m /
  2.70→11.9m / **3.50→9.1m**。取 3.50（cap 3.60）：航道半宽 7.4m，
  9m 半径才容得下船体 + 30° 滑移角。
- 滑移角上限/喷气门槛没动，甩尾和集气手感保持原样。
- 新增 `tests/drift_strait_curve_probe.mjs`：断言稳态半径 ≤12m 且船身留在航道内；
  附带输出 Z 弯通过的诊断数据。该自动控制器的打方向时机不如人手，
  只跑到 0/563m，不能据此判断"真人过不过得了弯"，需要实机试玩确认。

### 晴天天空继续提亮提蓝（用户："还是有点暗，要夏天大晴天"）
- `RealSky.js` day：turbidity 3.6→2.6、rayleigh 1.95→2.50、sat 1.45→1.90，
  tint 0xf0f7ff / horizonColor 0xd4e8ff / top 0x6dabef；exposure 保持 0.46。
- 试过 exposure 0.56：太阳周围大片过曝白雾（Bloom 阈值被抬亮的天光触发），
  已回退；"更亮"改由降低浑浊度 + 提高蓝色散射/饱和度实现，太阳盘仍清晰。
- `maps.js` day 的 skyTop/skyBottom 同步。出图 `shots/weather/strait-sky3-sun.jpg`。

`npm test` / `npm run build` PASS。


## 天气体检 + 暴风雪增雪与压曝（2026-11-17 第四轮）

用户问"晴天改了，其它天气要不要跟着调"。先出四张现状图对比：
`shots/weather/strait-audit-{dusk,storm,blizzard,starry}.jpg`。结论：
黄昏的暖色光路、暴风雨的高对比深蓝、星空的深蓝夜海都与晴天新风格协调，
**只动暴风雪**（用户确认：只改暴风雪 / 雪明显增多但不糊赛道 / 温和压亮保留雪天感）。

### 暴风雪现状问题
雾密度 0.0066 + 近白雾色 + RealSky exposure 0.54 + 后处理冷白气候色 0.3 四层叠加，
整屏洗成灰白：起点线过曝、船体发白、浮桶与远路牌看不清；雪粒子三层合计仅 1260 粒，
近景尺寸 0.10 太小，几乎只剩零星白点。

### 改法
- `Environment.js #buildSnow` SPECS：三层 1260→2140 粒（约 1.7 倍），
  size 0.10/0.20/0.42 → 0.15/0.28/0.52；近层 keepClear 安全圈保留，
  远景层 opacity 0.38→0.32，雪多了但不糊赛道。
- `RealSky.js` blizzard：exposure 0.54→0.44、sat 0.78→0.88、
  top 0xc9daea→0xb6cce0、horizonColor 0xdfeaf4→0xcadcea、
  cloudShadow 0x9db2c4→0x839bb1。
- `maps.js` blizzard：fogDensity 0.0066→0.0046、雾/天/水色各压深一档、
  hemiIntensity 1.18→1.02。
- `PostFx.js` blizzard 调色：climateAmt 0.3→0.18、saturation 0.78→0.88、
  vignette 0.36→0.32。

出图 `shots/weather/strait-after-blizzard.jpg`：水面恢复冷蓝灰层次、
浮桶/起点线/船体对比清楚，雪片肉眼可见。`npm test` / `npm run build` PASS。


## 漂移半径回调到 16.4m（2026-11-17 收尾）

用户实机反馈 9.1m 太小不好开，要求 16~17m。按实测曲线反推 pathYaw：
2.05→15.6m、1.48→21.7m，取 **pathYaw 1.95 / pathYawCap 2.05**，
drift_arc_probe 实测稳态 **R=16.4m**（普通转向 43m），符合目标。
`Boat.js` 参数处已写清"想自己调只改 pathYaw 一个数"及实测对照表。
`tests/drift_strait_curve_probe.mjs` 的半径断言撤掉（低速时逐帧 R 会偏小，口径不准），
只保留"船身留在航道内"断言；稳态半径统一以 drift_arc_probe 为准。
`npm test` / `npm run build` PASS。


## 暴风雪雪量 / 比赛降速 / 贴墙脱困（2026-11-17 第五轮）

### 暴风雪雪花：从"时断时续的小点"变成持续大雪
- 根因一：雪区组以前每跨 20m 就 `snow.position` 整组跳格，画面上就是"雪一阵有一阵没"。
  改成组固定在世界原点、只有超出相机 range 的单颗雪片绕回另一侧，数量恒定。
- 根因二：雪片初始高度只铺 0~top，相机常年在 y≈3~8，开局下方是空的；
  改成 `-12 ~ top` 覆盖相机上下，并在拿到相机的那一帧按相机位置重铺。
- 根因三：`PointsMaterial.size` 默认随距离衰减，远处雪片缩成看不见的点。
  改 `sizeAttenuation:false`（固定像素），三层 size 6.2/4.8/3.6px。
- 数量 1260 → 6600（1800/2600/2200），近层 `keepClear` 安全圈保留，
  远景层 opacity 0.52，出图 `shots/weather/strait-blizzard-heavy.jpg`：
  雪片肉眼清楚、不断档，浮桶/起点线/船体仍可读。

### 比赛速度各降 20km/h
- `Boat.js` 新增 `SPEED_CUT_KMH = 20` + `cruiseTopOf/boostTopOf`；
  **绝对量**各减 5.556 m/s（不是降倍率 —— 降倍率氮气会连带掉 36km/h）。
- 实测（赤焰号，`.tmp_build/top_speed_probe.mjs` 读 `boat.topSpeed`）：
  巡航 122.4 → **102.4km/h**、氮气 220.3 → **200.3km/h**，各 -20.0。
- 以后想再调只改 `SPEED_CUT_KMH` 一个数（0 = 恢复原速）。
- 顺带在 Boat 里暴露 `this.topSpeed`（本帧极速上限），HUD/探针可直接读。

### 撞墙卡死：贴墙脱困三个机制
用户实机反馈"撞墙后按油门 + 反方向键只能慢慢蹭，必须复位"。写
`tests/wall_scrape_probe.mjs` 复现：
- A 斜擦 29°/10m/s：旧版 ship 被压到 1.35m/s 一路蹭；
- B 顶死 70°/2m/s：**3 秒内一次都没离开墙**（就是"只能复位"）。
改法（全部在 `Track.constrain` + `Boat` 转向块里）：
1. **贴墙转向权重下限** `WALL_YAW_MIN_SP=0.30`：顶死时 vf≈0 → 转向速度曲线≈0
   → 方向键失效，这是卡死的真正病根。
2. **刮墙回正力矩**：船头朝墙里（into>0.08）时按 0.9+2.4·into rad/s 把船头掰向墙面切线
   （真实船体被墙顶住时墙的反作用力就在船头外侧，跑跑卡丁车同理）。
3. **蹭墙助滑**：踩油门时切向速度补到 6m/s 上限，读作"贴墙滑走"而不是"贴死"。
4. **蹭墙阻尼** `WALL_SCRAPE_DRAG=0.35`：稳态只剩约 12m/s，贴墙不能刷速度。
关键实现坑：接触是**断续**的（推回去后要十几帧才再压上），助滑/回正必须按
`wallContactTimer` 时间窗每帧跑；切向量的"取最近侧"翻转必须在补速分支外算，
否则速度够了以后切向指向船尾，回正朝反方向算、每帧被自己跳过。
实测：A 船头回正 0.17s / 1.0s 脱离；B 船头 0.35s 回正 / 1.15s 脱困跑出 23.9m。
`npm test` / `npm run build` PASS。

---

## 第六轮（2026-11-17 晚）：起点线前移 / 最后直道加难度 / 木栈桥重做 / 雪花加大

### 1. 霓虹海峡起点线前移（用户试玩发现"从旁边穿过去不算圈"）
- 病灶量化：`tests/startline_probe.mjs` 逐 z 截面测"可行驶航道宽度" —— 旧起点在
  z=40 的入弯口，那里航道 42m 宽，而黑白格线只有 26m（`startLineHalfWidth`=18），
  右侧 7~17m 是"看着能过、过线不计圈"的漏判缝。
- 改法：`maps.js` 的 `gates[0]` 由 `[0,40]` 改成 `[0,16]`（z≤18 这段航道已收窄成 14.5m），
  并新增 `startWidth: 15`。格线 `PlaneGeometry(startWidth)` 与旗门两腿 `sw = startWidth/lateral`
  都用它，两腿正好落在浮桶线上。
- 实测（改后）：z=10~0 航道 -7.3~7.3 = **14.5m**，格线 15m，判定半宽 18m（冗余 3m/侧）。
- `finish_line.test.mjs` PASS(28)。

### 2. 最后直道：4 条加速带（左右左右）+ 4 块移动岩石
- **门索引坑（踩了两次）**：strait 是 55 门，东侧长直道精确是
  `48=[88,-1000] 49=[100,-860] 50=[100,-620] 51=[96,-380] 52=[88,-160]`；
  写 50~53 会把石头摆到 `52→53` 的回弯段上（实测出图时石头出现在起点附近）。
- `boostPads: [{gate:48..51, t:0.30, side:∓0.55}]` —— t=0.30 与岩石（门中点）错开 48m，
  玩家"先吃加速带再躲石头"。
- `hazards.drifters` 复用熔岩那套 `#buildMagmaHazards`（同一个 elapsed 时间轴，联机一致）：
  `axis:'side'` 横扫 / `axis:'along'` 沿赛道前后冲，周期相位写死。
- 配套改动：`#buildMagmaHazards` 的 `def = map.hazards || map.magmaHazards`；
  drifter 新增 `spin/sink` 字段（石头不能像浮桶那样自转，且要沉进水里 0.3m）；
  `padMat` 加 `toneMapped:false` + `opacity 0.92`（否则被水面曝光压成一片淡蓝）。

### 3. 波浪栈道换成有贴图的木栈桥
- Blender 出 `public/models/props/bridge_wood.png`（512 可平铺：横向木纤维 + 每 1/3 一道板缝）
  与 `boardwalk_post.glb`（八角木桩 + 两道铁箍）。
- **桥面不走"掰段摆刚体模型"**：栈道是 S 形，门点折角能到 40°，17.8m 宽的矩形段在弯道内侧
  必然张开几米宽的 V 形口子（底衬也盖不住，出图实测）。改成 `#buildStraitProps` 里沿门折线
  按 1.2m 密集采样、法线取前后方向平分线、相邻节点**共享左右边缘点**，拼一条连续条带
  （顶面 + 底面 + 左右侧壁，厚 0.34m），UV 用"横向/2.4、沿程/2.4"真 UV。
- 顺带把木构件从"纯顶点色"升级为三平面木纹 shader（`strait_plank`，采样 bridge_wood.png，
  带木纹高度扰动当法线扰动），覆盖木栏杆/隧道压顶。松树不进这组。
- 关键教训：贴图板缝与几何板缝**不能两个方向**（早期版本 u 轴对到 Z，结果贴图缝和几何缝
  十字交叉，看着像瓷砖）。

### 4. 暴风雪雪花加大
- `Environment.js` SPECS：size `6.2/4.8/3.6 → 10/8/6` 像素（`sizeAttenuation:false` 下是屏幕像素）。
- 同轮发现"单颗变大后，同样的颗数反而更稀"（大点之间留白更多，静态图只有四五十个白点），
  所以 ① 总数 3600 → 8000；② 近/中层作用半径收窄 `44→32 / 135→100`（粒子数固定，range 一缩
  密度直接翻倍）。三层都是 Points，共 1 个 draw call。
- **出图必须"活着拍"**：雪花位置每帧按相机算，`cancelAnimationFrame` 之后就冻结在上一次
  跟随相机的位置，静态截图里几乎没有雪。`tests/pass_b_shot.mjs` 的 `shotLive()`
  只停 `cameraRig.follow`、不停主循环，并用 `Page.captureScreenshot`。

### 新增/修改的验收脚本
- `tests/pass_b_shot.mjs`：一轮出齐起点线 / 4 块岩石 / 左右加速带 / 栈道三视图 /（可选）
  暴风雪实拍。机位由页面内实测坐标反推，不写死。
- `tests/blizzard_visual.mjs`：`BASE` 改成读 `WB_URL`。
- 产物：`shots/pass_b/*.jpg`

---

## 2026-11-18（晚）：幽灵车 / 每圈评价 / 失败归因

用户口径：幽灵车「记住自己最快的一圈」，每圈压线给一句即时评价（不弹窗），
撞墙或被炸后给半秒归因图标。选定档位：**幽灵车 A3 + 圈评 B2 + 归因 C1**，
UI 落点：圈评与归因**共用屏幕中央偏下一条轨道**，幽灵差值「车顶牌 + 右下 HUD 小条」，
开关与「清除幽灵记录」放设置页新增的**「辅助」**页。

### 共同底座：`src/game/LapTelemetry.js`
一圈一份遥测：20Hz 轨迹（`[dtMs, x, z, heading]` 扁平数组）、按**弧长四等分**的分段时刻、
行为统计（漂移次数 / 氮气时长 / 撞墙次数 / 最高速）。三个功能都吃这一份，不各写一套。
- 分段为什么按弧长不按门：海峡 55 个门、门间距差 5 倍，按门切会出现「第一段 8 秒、第二段 40 秒」。
- `buildReview()` 是纯函数（测试见 `tests/lap_telemetry.test.mjs`）：
  新纪录 / 变快 / 变慢 / 差 0.04s 内算「稳住」/ 首圈只说时长；
  副标题只挑**有数据支持**的那一条：最慢分段 > 撞墙次数 > 漂移链 > 最高速。
- **分段差超过 20 秒不报**：那不是「这一段慢」，是记录本身有问题（复位/瞬移/中途掉出），
  报「第 1 段慢了 50 秒」只会让玩家觉得系统坏了。

### 幽灵车
- 存档 `src/game/GhostStore.js`：每点 12 字节（dt Uint16 / x,z Int32 厘米 / heading Uint16），
  20Hz × 3km 单圈 ≈ 28KB，base64 后 ≈ 38KB；key = `rr-ghost-v1:<mapId>:<boatId>`。
  记录里带 `arcTotal`，与当前赛道差 2% 以上**直接作废** —— 地图改过后旧幽灵会跑到护栏外。
- 渲染 `src/game/GhostBoat.js`：**复用 Boat**（`new Boat(..., { ghost: true })`），
  Boat 里跳过尾迹/接触阴影/名牌，材质 clone 后染青白 + `opacity 0.45` + `depthWrite=false`。
  - 为什么不自己搓网格：缩放 / 朝向修正 / 水线 / 蒙皮角色骨骼全在 Boat 里，
    另写一套等于重踩一遍，而且换船就变形。
  - `dress()` 必须 clone 材质：GLB 的 `scene.clone(true)` 共享材质引用，
    直接改 opacity 会把旁边那艘真船一起改透明。
  - 位置由 `updateGhost(dt, t, x, z, heading, speed)` 直接写入再复用 `#applyPose`；
    **不走 `updateRemote`** —— 那套是延迟回放，固定慢 80ms，读起来像「永远差一点点」。
  - 隐藏靠外层 `root`（`#applyPose` 每帧会把 group.visible 设回 true，藏 group 没用）。
- A3 口径：落后才显示，领先 0.6 秒以上连船带差值条一起藏（设置里 `ghostAlways` 可改成常显）；
  车顶牌 ±0.00s（0.1 秒死区，并排时不闪橙），右下 HUD 小条常驻。
- 结算页新增「幽灵最佳」一格：对比**进本局之前**的记录（`ghostBest0`），
  本局破纪录后 `ghostRecord` 已被覆盖，拿它比会永远显示「打平」。

### 失败归因（C1：只图标，不写数值、不写谁打的）
- 事件源：撞墙（`Track.constrain` 里法向速度 > 3m/s 才写 `boat.wallHitSpeed`）、
  撞硬物（`Boat` 碰撞 `closing > 3` 写 `lastHardHit`）、被道具打中（`ItemManager` 新增
  `opts.onMyHit`，**护盾拦下不调用**）、被船撞（`impact > 4.5`）、掉出赛道、R 复位。
- 节流：同类 1.2 秒内只报一次；归因优先于圈评（圈评顺延 0.55s），同一时刻只出一条。

### 验收
- `node tests/lap_telemetry.test.mjs`：11 PASS（打包往返位置误差 ≤1cm、朝向 ≤0.01°、
  文案五种输入、fx→图标映射全覆盖）。
- `node tests/ghost_lap_probe.mjs`：19 PASS。含「无记录不建幽灵 / 有记录建出并随时间推进 /
  落后可见 / 领先隐藏 / 圈评渲染 / 归因压掉圈评 / 过线真出评价 / 存档落盘 /
  设置页 4 开关 + 清除按钮 / 结算页幽灵格」。
- 产物：`shots/ghost/strait-ghost.jpg`（半透明幽灵 + 车顶牌）、
  `shots/ghost/strait-hud-review.jpg`、`shots/ghost/strait-hud-impact.jpg`。
- `npm test` / `npm run build` PASS。新增脚本 `npm run test:assist`。

### 踩坑
- 探针里换船型会读不到幽灵：存档 key 含 boatId，大厅默认船**不是**固定的
  → 探针必须先点 `.lp-card[data-boat="rower"]` 固定船型。
- 进度换算的「负差值只在小于半圈时补一圈」意味着**不能靠瞬移**测「领先」：
  瞬移到 95% 会被当成还没出发；瞬移到 30% 才会被正确补回。测试改用「同位置、改本圈计时」。

---

## 2026-11-18（晚续）：选艇台特效 / 竞技场栅栏 / 龙宫路面珊瑚

### 1. 选艇台只演发射端
`BoatShowcase` 之前把 `fxHit || fxImpact` 也播了 —— 那是打中 BOSS 时的受击特效
（像烟花），选艇台没有 BOSS，看起来像船自己带烟花。现在 `#demoImpact` 只保留
落在水面的水花/涟漪；`DEMO_FX_NAMES` 预加载也只剩 `fxMuzzle`，少加载一批 efk。

### 2. 怪物模式外圈栅栏严格按模型尺寸碰撞
- 栅栏实际摆放半径 = `boundary.r − 5` = **87m**（之前碰撞用的边界是 92m，
  软夹中心还停在 89.5m，船头再伸 3.3m → 视觉穿栅栏 5m 以上才被拦）。
- `BossArena` 新增 `fenceRadius = 87`、`fenceInnerRadius = 87 − 0.44 = 86.56`
  （rail_post 本地 x 半宽 0.20 × 缩放 2.2 = 柱子内缘）。
- `constrain()` 改为和 `Track.constrain` 同口径：`boat.hullFootprint` 全部轮廓点
  变换到世界坐标，任一点越界就整船沿径向推回，并做法向速度反弹。
- 探针（临时脚本，测完删除）：船强行放在 88.5m、四种朝向，船体外缘最大
  86.55m ≤ 柱子内缘 86.56m，通过。

### 3. 龙宫路面珊瑚
删除 `palaceMovers`（3 块在水面直道上左右横移的 `coral_reef.glb`）及其碰撞体、
动画、`maps.js` 的 `moverGates`、`Track` 里的避让逻辑。
**海床珊瑚群 / 水下巨礁保留**（用户要求"水底下那个不要删除"）。

### 验收
`npm test` / `npm run build` PASS；栅栏探针 4/4 PASS。

---

## 2026-11-18（深夜）：BOSS 镜头减晕 / 主菜单问号居中

### 1. 击败 BOSS 后的镜头不再猛甩
两处来源都处理了：
- **开场运镜放慢**：`BossMode` 的 `introLen` 从 5.6s → 8.12s（×1.45），每段再做
  smoothstep；原先 1.8s 内 70m 的俯冲明显放缓，起停也不顿。
- **锁头→追尾的交接**：击败 BOSS 进传送门阶段时 `getLockTarget()` 返回 null，
  镜头会从尸体方向甩回船头。现在 `CameraRig.relaxAfterLock(1.35)` 在这 1.35s
  内把转向上限压到 1.6rad/s、位置/注视点低通降到 2.2/2.6，并以当前镜头朝向
  重置 `cameraHeading`，不会二次甩头。

### 2. 主菜单右下角问号
`.mm-help` 之前依赖 `<button>` 默认的基线排版，`?` 会偏。改成
`display:flex; align-items:center; justify-content:center; padding:0; line-height:1`，
几何居中。

### 3. 第二关珊瑚装饰（已替换为带贴图 GLB）
红色圈出的是 `BossThemes.#buildTropical` 里的纯装饰（无碰撞、无玩法作用），已全部换掉：
- **16 簇锥体珊瑚 → `props/rock_hazard_a|b.glb`**：两种带 `rock_gray` 贴图的小礁石，
  16 处礁盘、每处 1~2 块，`dist 58~82`、`scale 1.15~2.2`，半沉在水面。
- **34 片海草面片 → `hazards/hazard_kelp.glb`**：有体积的海草，挂进 `floaters` 随浪轻摆。
- **Box 拼的木船残骸 → 取消**：`shipwreck.glb` 露出水面只剩一根斜插的木板（像"木桩"），
  `rock_cluster.glb` 12m 宽又没有碰撞体会穿模，所以这块不再放大件，交给礁盘本身。
- **`coral_reef.glb` 按用户要求不使用**。
- 新增 `GLTFLoader` + 模块级 `decorCache` / `loadDecorScene()` / `#addDecorInstances()`，
  统一打 `castShadow/receiveShadow` 与 `userData.sharedAsset`（多实例共享，不重复释放）。
- 说明：BOSS 场地 `style: 'arena'` 关闭了实时阴影贴图，`castShadow` 目前不产生实际投影。

### 4. 第三关港口装饰（已替换，2026-11-18 续）
`BossThemes.#buildHarbor` 里的纯色几何体全部换成带贴图 GLB：
- **18 个锈色集装箱 Box → `shore/dock_wood.glb`**：10 段木码头，`dist 96~114`，围在栅栏外一圈。
- **半沉货轮 Box → `yacht.glb`**：40m 游艇放在 `(-96, 30)`（r≈100.6，船头船尾都在栅栏外）。
  该模型甲板在包围盒下半部，`y` 要抬到 6.8 才露得出舷侧；`rz 0.12` 做半沉倾斜。
- **12 根码头桩 Cylinder → `track/boardwalk_pile.glb`**：14 根，非等比缩放
  `[1.9~2.4, 4.5~7.5, 1.9~2.4]`（木桩不能等比放大，否则变粗墩子）。
- **26 个漂浮桶/箱/板 → `hazards/hazard_bin.glb` + `track/boardwalk_plank.glb`**：
  各 10 件，`dist 46~84`，挂 `floaters` 随浪起伏 + 自转。
- 另加 7 个 `props/nav_buoy.glb` 航道浮标（`y=-0.9`，半沉）。
- 岸边起重机保留 Box 剪影（没有现成模型），`hullMat` 移到循环前复用。

### 5. 第四关冰海装饰（已替换，2026-11-18 续）
- **12 座 Icosahedron 冰山 → `props/iceberg_large.glb`(8) / `iceberg_small.glb`(4)**：
  模型原点在冰体中部（minY 分别为 -25.9 / -9.9），按 `y = minY × scale × 0.34` 摆，出水约 2/3。
- **场内 8 块 + 船周 6 块 Icosahedron 碎冰 → `iceberg_small.glb`**：`scale 0.28~0.6`，
  前 8 块挂 `floaters` 随浪起伏。
- **Box 船体 + 圆柱桅杆 → `shipwreck.glb`**：极夜光照下是深色剪影，放在栅栏外 r≈165
  `(136, -93, y=-3.5, scale 1.25)`，只露出船背和桅杆当远景；近放会变成挡视线的黑块。
- 截图核验：冰山/碎冰入水高度正常（碎冰出水 2.4~4m、水下 5~8m），无悬空、无穿模。

- 说明（两关共用）：BOSS 场地 `style: 'arena'` 关闭了实时阴影贴图，
  `castShadow` 目前不产生实际投影；所有装饰都没有碰撞体，大件一律放栅栏外。

第一关远景火山仍是 Cone（未动，属于主题造型而非纯色占位）。

---

## 2026-11-18（收官）：幽灵车「开了却看不到」修复

### 用户反馈
「幽灵车到底怎么用？我设置里面打开了，但是开了一圈，第二圈还是没有幽灵车在我赛道内啊？」

### 三个真因（都不是"开关没打开"）
1. **开局无记录就永远不建幽灵**：`#initGhost()` 读不到存档直接 `return`，而唯一能建幽灵的路径就是它
   —— 所以第一次跑这张图的人，跑完第一圈之后第二圈还是空的，看起来就像功能没生效。
   现在 `#saveGhost()` 跑完一圈就当场 `#spawnGhost()`，本局剩下的圈立刻有追逐目标，不用退出去重开。
2. **领先 0.6 秒就把幽灵藏起来**：`ghostAlways` 默认 `false`，一开跑玩家就在幽灵前面 → 全程隐身。
   默认改 `true`（一直显示），想干净的可以到「辅助」页关掉。
3. **存档里已经把 `ghostAlways:false` 写死了**：只改 `SETTINGS_DEFAULTS` 对老玩家无效，
   读档 `if (v == null) continue` 挡不住 `false`。为此加了 `SETTINGS_DEFAULTS.version = 2` +
   `#migrate(saved)`，v1 → v2 强制纠正一次再落盘。

顺带修掉 `Boat.dispose()` 在幽灵船上抛 `wakePool is not iterable`（幽灵跳过 `#buildWake`）。

### 产品侧文案
- 「辅助」页开关改名 **「一直显示幽灵」**，幽灵车 hint 写明「这张图 + 这条船」才有记录、
  「跑完第一圈之后本局就能看到它」—— 这三句正是用户困惑的点。
- 幽灵外观不动：`opacity 0.45` + 青白 tint + 发光，已是实测平衡点。

### 验收
- `npm run test:assist` 全绿（圈遥测 11 + 设置迁移 7 + 幽灵 22 + 完美起步 7）。
- 新增 `tests/settings_migrate.test.mjs`（假 localStorage 跑读档逻辑，7 PASS）：
  v1 老存档被纠正 / 其它设置不受影响 / v2 里玩家主动关掉的保持不变 / 坏存档静默退回默认。
- 新增断言「第一圈跑完当场建出幽灵」—— 探针里必须**同时**清掉 `ghostRecord` 与 localStorage，
  否则 `#finishLap` 的「只存更快的圈」会把 65s 的测试圈跳过，断言假失败。
- `npm test` PASS、`npm run build` PASS（80 modules，1.72MB）。

---

## 2026-11-18（续）：幽灵车升级成「挑战模式」

### 需求
「把幽灵车模式从设置里删除，在大厅界面模式里加入一个挑战模式，把完整的幽灵车逻辑复原到挑战模式中，
挑战模式中玩家可以不断与影子对战，刷新记录。」

### 做法（关键决策：mode 归一化，而不是再加一个分支）
- 大厅「模式」抽屉新增 `单人玩法` 分区 + `.lp-boss-card[data-mode="challenge"]` 卡片，
  副标题直接显示当前影子成绩（`readGhost(mapId, boatId, 0)` → `UI.fmtTime`），
  没记录时写「还没有影子 · 跑完第一圈自动生成」。
- `startSoloRace` 传 `mode: 'challenge'`；`Game` 构造函数把它**归一化成 `this.mode='race'`
  + `this.challenge=true`**。这样大浪 / 开场镜头 / 浪跳 / 布景分组等几十处 `mode==='race'`
  判定都不用改，少改动就少漏洞；新代码只认 `this.challenge`（hudData 也吐这个字段）。
- `#initGhost` 的准入条件换成 `if (!this.challenge) return`（原来按 `settings.get('ghost')`），
  所以**普通竞速 / 道具 / 弹射里不会再出现半透明船**。
- 影子**恒在场上**：`#updateAssist` 里删掉 `ghostAlways` 的「领先 0.6 秒就藏」，
  只在 `st.finished` 后停住。
- 挑战模式只支持单人：联机房间点它直接 toast（服务器 `MODE_IDS` 里没有 challenge，
  硬发会被整包丢弃）；组队赛制下点它提示先切回个人；开赛时**强制 0 AI**
  （`aiCount = challenge ? 0 : ...`，`teamPlayable` 也排除它）。
- 结算页按钮在挑战模式变成「再挑战一次 · 刷新影子」，点了原地重开（不回大厅），
  对应「不断跟影子打、刷记录」的节奏；结算成绩格文案统一叫「影子最佳」。
- 设置页：`ghost` / `ghostAlways` 两个键从 `SETTINGS_DEFAULTS` 删除，「辅助」页只剩
  每圈评价 + 失败归因 + 清除记录（改名「清除挑战影子记录」）。`#migrate` 保留 v1→v2
  的分支（只推版本号），避免以后加迁移时重复执行。旧存档里的残留键读档不认、下次保存自动抹掉。
- 旧选艇屏 `renderModeList` 也加了 `👻 挑战模式 · 影子对战（单人）`；联机时会 toast 并回弹。

### 验收
- `tests/settings_migrate.test.mjs` 重写为「键被裁掉 + 版本推进 + 其它设置不动」11 PASS。
- `tests/ghost_lap_probe.mjs` 扩到 30 PASS：先跑一局普通竞速断言**不建影子**（`waitRacing:false`，
  等 `localBoat` 就够，#initGhost 在构造里已经跑完），再 reload 进挑战模式跑完整影子逻辑；
  新增「挑战模式 mode 归一化」「强制 0 AI」「设置页没有幽灵开关」断言。
  无头下加 `Page.bringToFront`：页面被当后台标签时 rAF 会被节流，倒计时（游戏内时间）永远走不完。
- 新增 `tests/challenge_lobby_shot.mjs`：大厅模式抽屉排版验收 + 实拍
  `shots/challenge/lobby-mode.png`（卡片 378×55，完整落在抽屉可视区内，无裁切）。
- `npm test` PASS、`npm run build` PASS（80 modules，1.72MB）。

---

## 2026-11-18（夜）：中央提示条改成「紫色霓虹斜切面板 + 极粗方头艺术字」

### 需求边界
用户给了两张参考（AI 生成的「撞墙 / 蹭到护栏」紫色霓虹条）和一整套提示词，
但明确限定：**不是全部改紫色，只把「边框样式」和「字体」改成参考那样**。
所以最终做法是「几何 + 字效固定一套，颜色仍按类别走」：
红=撞、绿=好、蓝=特技、金=纪录、紫=受击，5 个 `data-tone` 只覆盖 CSS 变量。

### 面板（三层 + 一圈外光）
- 形状：`clip-path: polygon(18px 0, 100% 0, calc(100% - 18px) 100%, 0 100%)`。
  **必须用 px 不能用 %** —— 提示词里给的 `(0 22%, 100% 0 …)` 是"占自身高度的百分比"，
  226×44 的条子上只剩 2° 斜角，跑出来仍然像个圆角矩形（实测出图后返工）。
- 光晕：挂在**外层** `.ac-glow` 的 `filter: drop-shadow ×3`。`box-shadow` 会被
  `clip-path` 一起裁掉，斜边外侧根本出不来光；`drop-shadow` 取的是子元素裁剪后的
  alpha 轮廓，光顺着斜边整圈包住。
- 三层裁切：`ac-rim`（2px 亮霓虹线）/ `ac-core`（近白 1px，发光管内壁）/ `ac-plate`
  （深色渐变底板 + `::before` 顶部柔光 + `::after` feTurbulence 磨砂噪点）。

### 字体（关键三个坑）
1. **`filter: drop-shadow` 与 `background-clip: text` 不能同元素**：实测字内渐变整块消失，
   只剩描边（空心字）。发光必须挂在外层 `.ac-wrap` 上。
2. **`text-shadow` 也不行**：它画在"背景裁到字形"的渐变**上面**，字看起来像被染成一片
   （第一次出图整条被染红就是因为这个）。所以只用外层 filter。
3. **系统里没有 Black 级中文黑体**（微软雅黑 900 也只到 Bold），所以加了一层
   `.ac-fat`：同一串字用白色 2.8px 描边再画一遍垫在下面，等于每笔加宽 ~1.4px，
   上面再盖渐变字 + 1.2px 亮色细描边 —— 才有参考图那种方头厚体。
   加粗层**必须是独立元素**（`#ac-fat`，由 `ui.js` 同步文案），不能写成 `::before`：
   负 z-index 伪元素会被父元素自己的 `background-clip:text` 背景盖住。

### 验收
- 新增 `npm run test:hud`（`tests/hud_chip_shot.mjs`）：真进一局，5 个色调各播一次，
  量面板宽高 / 主字字号 / 描边宽度 / 副字字号 / 左侧光条宽度 / 主副字是否越出面板，
  并逐色调出图到 `shots/hud/chip-<tone>.jpg`。
- `npm run test:assist` 全绿；`npm test` PASS；`npm run build` PASS（278.6KB html）。

---

## 2026-11-18（续）：绯鲨号 / 流光号的氮气尾焰补强

### 用户反馈
「绯鲨号和流光号加速时尾焰时断时续、比其他船淡，是特效一直存在但显示很淡，还是代码断续？」

### 先测，再改（`tests/nitro_fx_probe.mjs`）
三条船各跑一局，采三组硬数据：
- **粒子句柄数**：加速 2.6 秒内每条船都稳定在 14~42 个，**归零次数 0** → 代码没有断续；
- **尾焰区域像素增量**（关氮气拍一帧、开氮气拍一帧逐像素相减）：
  赤焰号亮像素 34.4%、绯鲨号 **17.9%**、流光号 24.1% —— 绯鲨只有一半；
- 实拍确认：`toonWater` 是两个半透明白水球（像挂了两颗泡泡），`fxIceMist` 是一团淡冰雾，
  在蓝天/水面背景里几乎融进去。**问题在素材强度，不在补发逻辑**。

### 改法
1. 绯鲨号 / 流光号的**尾焰主素材换成 `jet`（Basic/Laser01 定向光束）**，
   再加一层 `fxFireBall` 染色做「能量芯」（与赤焰号同一种双层结构）：
   - 绯鲨号：jet 0.8 染 `0xa8f4ff` + core 0.6 染 `0xc8f6ff`
   - 流光号：jet 0.74 染 `0xd9c8ff` + core 0.56 染 `0xe8dcff`
   - `loopEvery 0.05→0.03`、`pool 8~9→12`、颜色改纯白不再压暗素材。
     0.03s 是按「30m/s 下每发间隔 0.9m」标定的 —— 间隔大于火球直径就会被看成断续的点。
2. **中间试过的大尺寸方案已废弃**：`toonWater` / `fxIceMist` 放大到 1.15~1.6 后不是尾焰，
   而是「水罩 / 一整片白雾」，把船尾和半个屏幕糊掉（实测亮像素 49%，观感反而更差）。
3. 顺带把攻击弹道钉住：`nitroAttackFx` 新增 `atkFx / atkColor`，绯鲨号 / 流光号的
   怪物模式弹道仍是原来的水球 / 冰雾，不会跟着尾焰变成激光。

### 验收（SPEED=30，实战速度）
| 船 | 亮像素（改前 → 改后） | 平均增量 | 句柄归零 | fps |
|---|---|---|---|---|
| 赤焰号 rower | 34.4% → 35.1% | 59.8 | 0 | 35 |
| 绯鲨号 skiff | **17.9% → 35.8%** | 64.2 | 0 | 35 |
| 流光号 dolphin | **24.1% → 35.3%** | 61.3 | 0 | 31 |

- 新增 `npm run test:nitro`；出图 `shots/nitro/{rower,skiff,dolphin}.jpg`。
- 探针坑：中/高画质下 Effekseer 在 `PostFx` 的 FxPass 里绘制，**直接 `renderer.render`
  拍不到尾焰**（像素对比会全是水面噪声），必须走 `g.post.render()`。
- `npm test` PASS、`npm run build` PASS（80 modules，1.72MB）。

---

## 氮气尾焰修正二审：回滚换素材，改在原素材上加强（绯鲨 / 流光）

上一版把绯鲨 / 流光的尾焰主素材换成了 `jet` 光束 + 火芯。**玩家明确否决**：
「你换个毛素材，我说了加强就行，你换成一模一样的素材怎么分辨？？？
给我恢复回去原来的特效，在两个赛艇原来特效基础上加强粒子特效和喷射力度，
禁止随意更换我的特效素材！！！」

新规则写进 MEMORY.md：**禁止更换特效素材**，只允许在原 `fx` 上调
`scale / loopEvery / pool / points / color / trail`；要加层也只能叠同一个素材。
换素材的副作用就是「三条船变成同一条船」，虽然亮度达标，但辨识度归零。

### 真因（数据）

加速期连采 26 帧句柄数：绯鲨 24~30、流光 22~24，**归零 0 次** → 不是代码断续。
真因是 **尾迹颗粒间距 = 船速 × loopEvery**：原版 30m/s 下每 1.2m 一颗水球，
水球本身不大，肉眼就是一截一截。

### 改法（三喷口 + 加密补喷，素材不动）

1. 新增 `points: 'triple'` —— 左中右三股喷口全开（原来 `sides` 只有左右两股）。
   `Game.#updateNitroFx` 与 `BoatShowcase.#syncNitroJets` 两处同口径。
2. 绯鲨 `toonWater`：`scale 0.9→1.3`、`loopEvery 0.05→0.025`（间距 1.2m→0.75m）、
   `pool 9→10`、三喷口。**保持 `trail: true`**。
3. 流光 `fxIceMist`：`scale 0.9`、`loopEvery 0.05→0.02`（间距 0.6m）、`pool 8`、三喷口。
   拖尾压到 0.16s≈4.8m —— 冰雾是大张软边白团，拖尾一长就在镜头前堆成糊住半屏的云。

### 验收（SPEED=30）

| 船 | 亮像素（原版 → 现在） | 平均增量 | 句柄归零 | fps |
|---|---|---|---|---|
| 赤焰号 rower | 35.6%（未动） | 59.3 | 0 | 36 |
| 绯鲨号 skiff | **17.9% → 24.5%** | 61.0 | 0 | 29 |
| 流光号 dolphin | **24.1% → 30.5%** | 80.0 | 0 | 30 |

- 绯鲨的 `avgDelta` 已与赤焰号齐平，差的只是**面积**；这个素材再放大就变「水罩」
  （1.4 实测反而掉到 17%），24~25% 是它的上限。
- 试过 `trail: false`（粒子全叠喷口）：绯鲨只剩 16.2%，水花被船体挡住 → 软素材必须留 trail。
- 试过同素材叠第二层：实例 18→34、帧率腰斩、面积只 +1.4% → 不加层。
- A/B 对照图 `shots/nitro/ab/{skiff,dolphin}-trail.jpg`；定稿图 `shots/nitro/*.jpg`。
- `npm test` PASS、`npm run build` PASS（80 modules，1.72MB）。

---

## 2026-11-19 第三关受击斧头修复 + 怪物模式「水面乱码」真因

### 1. 雷霆龙骑士受击斧头脱手（已修）

- 真因：`dk_hit`（原在 `dk_anims2.glb`）里 `Bone_Sword_R_1` 的 22 帧**恒为**
  `translation (0.2458,-2.5318,-0.0318)` + 单位四元数，身体在动、斧头不动 → 脱手。
- 修法：用站立 clip `Armature_Stand_full` 量出握持偏移
  `G = (0.2309,-0.1631,0.022) / q(0.1758,0.2067,-0.2355,0.9332)`（glTF 轴序），
  对 `dk_hit` 逐帧烘焙 `axe_world = hand_world @ G`，另存 `public/monsters/dk_hit_fixed.glb`。
- 接线：`bosses.js` 的 `knight_thunder.clipModels` 换成 `dk_hit_fixed.glb`，`anims.hurt` 仍是 `dk_hit`。
- 验收（无头 Edge + CDP）：受击全程采样「斧头骨在手骨坐标系下的相对 TRS」6 次，
  全部等于 G（标准差 0），站立/受击一致；按骨骼权重把 634 个斧头顶点染红截图，
  受击时斧头仍在右手。

### 2. 怪物模式「水面若隐若现的白色乱码」（已修，不是水面 shader）

- 现象：大片半透明白色飘带 + 糊掉的符文，忽明忽暗。用户截图与复现完全一致。
- 真因：第二关「符文安全圈」`#createSafeRingMesh()` 把 `M_Magic2Holy/circle4.png`
  铺成一张**直径 = ring.r × 2.28（开局约 190m）** 的平面盖住整片水面，
  `opacity 0.72 + 0.12sin`、自转、`y=0.34`、`depthWrite:false`、`frustumCulled:false`。
  贴图本来是粒子/烟雾图，放大 190 倍后符文全糊，只剩白色飘带。
- 定位方法：黑底 + 移除水面 + 关天空球，对 `scene.children` 逐个隐藏并统计 ROI 白色像素，
  冠军对象 `drop≈170/190`，参数（scale 189.8 / 0xd9f2ff / opacity 0.736 / depthWrite false）唯一命中。
- 修法：删掉整块 plane，只留边界细环 `ring` + 带符文矮光墙 `wall`；
  `#updateSafeRing` 的自转改到 `wall.rotation.y`；`#removeSafeRingMesh` 同步精简。
- 其他关卡：`BOSS_SAFE_RING.stages=[2]`，逐关（1/3/4）扫描「>40m + 半透明 + 贴水」网格，
  只剩天空云片（y≈691/818/96~128）与 BossArena 引导弧（RingGeometry，op 0.16），
  没有第二块同类大平面 —— 水面代码本身没问题。
