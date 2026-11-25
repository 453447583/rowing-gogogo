# 云端天梯 · 第 2 层「泡泡送包子」

> 用户口径（2026-11-24）：场地两端各一个终点，中间一个货物（包子）。谁先碰到谁背着，
> 背着的人**移动变慢**；没背的人可以放**泡泡**（3 秒爆炸）炸他，炸中就掉货；
> 谁先把货送到自己那一端的终点谁得分。类似小时候"泡泡糖送包子"。
> 附加要求：**别再用一堆程序化几何体凑数，能复用 GLB 就复用，做精美些。**

---

## 1. 玩法规则（当前实现）

| 环节 | 规则 | 数值 |
| --- | --- | --- |
| 取货 | 船开到中央取货台 5.2m 内自动背上 | `CARGO_PICK_R 5.2` |
| 背货代价 | 极速 ×0.72、转向 ×0.8、**不能放泡泡**、冲刺被禁用（K 变成放泡泡） | `CARRY_SPEED 0.72` / `CARRY_TURN 0.8` |
| 放泡泡 | 船头前方 4.6m 生成，初速 18、阻尼 2.6，**3.0 秒引信** | `BUBBLE_FUSE 3.0` |
| 爆炸 | 半径 6.5m，命中**持货者** → 掉货 + 僵直 1.2s + 速度减半 | `BUBBLE_R 6.5` / `STUN 1.2` |
| 掉货 | 落在**爆炸点**（不是回中央），0.7s 后谁都能捡 | — |
| 送达 | 持货者进入自己那端终点门 9.5m 内 → **+2 分**，1.6s 后货回取货台 | `SCORE 2` / `CARGO_RESPAWN 1.6` |
| 冷却 | 单人 2.2s，同时最多 3 颗 | `BUBBLE_CD` / `BUBBLE_MAX` |

**核心不对称**：背货的只能跑，追的才有火力。这条规则写在 `fire()` 的第一行
（`if (this.carrierId === id) return false;`），不是 UI 层拦的。

**门的归属**：`#gateX(index) = (index % 2 === 0 ? -1 : 1) * GATE_X`，按玩家序号分侧，
偶数号 → -x 的冷色（蓝）门，奇数号 → +x 的暖色（橙）门。

---

## 2. 坐标与"避开中央塔柱"（踩过的坑）

天梯的中央水晶塔柱是**贯穿所有层**的脊柱，原来从 `y=10` 起：

1. 第 1 层球场：柱子悬在场上空 10m，虽然不挡球但视觉很怪；
2. 第 2 层：柱子正好穿过地板中心，**石台和包子整个埋在柱子里**（只看截图才发现，
   探针当时全绿 —— 这是"必须出图"的又一例证）。

修法：
- `SKY_TOWER.SPIRE_BASE_Y = 18.3`（= `layerY(1)+0.30`）：塔身从第 2 层地板长出来，
  第 1 层头顶干净；
- `DELIVER.PEDESTAL_Z = 15`：取货台沿 **z 轴**偏移。
  - 只沿 z 偏：到两扇门（x=±46, z=0）的**距离相等**，公平性不变；
  - 沿 x 偏会偏袒一侧，**不能这么干**；
- `SKY_TOWER.SPIRE_R = 3.9` + `SkyTowerMode` 往 `arena.shoreColliders` push 一个
  `{x:0,z:0,r:3.9,bottomY:18.3,topY:190}`：船的碰撞会按 `bottomY/topY` 过滤，
  所以第 1 层（y≈0.4）中圈照样干净，第 2 层往上撞到柱子会真的被弹开。
  **必须等 football/deliver 构造完再 push** —— football 构造时会把
  `arena.shoreColliders` 当成"球场平面碰撞"读一遍（只认 2D 圆），
  先 push 会在球场中央凭空多出一堵空气墙。

---

## 3. 视觉：这次复用/做了什么

用户批评第一层"都是默认的程序结合体"，所以这一层全部换成：

| 元素 | 做法 | 为什么 |
| --- | --- | --- |
| 终点门 | `cloneProp('/models/props/flag_gate.glb', 22, {by:'max'})` | 赛道上现成的旗门，省事且精细 |
| 冷色门换色 | `recolorGate(model, 0x1b48cc, 0x8fc4ff)` | 两扇门长得一样，跑错门是常事；材质**实例间共享**，必须 `clone()` 再改色 |
| 泡泡 | `makeBubbleMaterial()`（`utils/bubbleMaterial.js`） | 和巨鲸鲨吐的是同一份肥皂泡着色器（菲涅尔 + 薄膜干涉 + 单点高光） |
| 包子 | 球面形变 + canvas 面皮贴图 + **顶点色烘褶影** | 没有现成 GLB；细节见下 |
| 光幕 | canvas 竖向渐变 + 扫描线，**普通混合** | 第一版用 `AdditiveBlending`，在这层明亮夕阳天空前等于没画（加色只能提亮） |
| 门顶信标 | 倒锥 `ConeGeometry(1.7,2.8,4)` 自转 + 上下浮 | 远处也知道货往哪送 |

### 包子的三次返工（全部靠截图发现）

1. **暖白贴图 → 橘子**：这层天空是暖粉的，贴图再暖就叠成橙色 → 底子压到冷白；
2. **褶子看不见**：`cos(a*8)*0.055` 在 3.5m 的包子上、夕阳平光下等于没有 →
   振幅提到 0.13，并用 `sign(c)*|c|^0.72` 把脊线削利；
3. **顶部小揪渲染成黑块**：小揪球体复用了带 `vertexColors` 的材质，
   而 `SphereGeometry` 没有 `color` 属性 → 顶点色缺省为 0 → 全黑。
   → 小揪单独 `bunMat.clone()` 关掉 `vertexColors`。

贴图上的褶线**故意不做**：UV 接缝和几何褶脊对不齐，只有顶点色能保证
"暗的地方就是凹的地方"。

### 取货台

直筒石墩 → 像鼓；两级台基 + 金环 → 像生日蛋糕（暖光把石头全染橙）。
最终：**0.36m 薄石台 + 冷白刻环 + 从台面往上打的光柱**，读作"取货点/停机坪"，
包子悬在光柱里也说得通。

---

## 4. 模块与接线

- `src/game/SkyTowerBubbleRun.js`（新，约 730 行）：取货台 / 门 / 包子 / 泡泡 / 判定
  - 构造函数第一件事就是 `this.group.position.y = this.deckY`，
    之后所有子物体用**局部坐标**（`y=0.012` 之类）——
    混着写 `this.deckY` 会把地面线抬两次（第一版就这么错的）
- `src/game/propLoader.js`（新）：`loadProp / cloneProp / normalizeProp / styleMaterials`
  - 不复用 `loadMonsterModel`：那个是给带骨骼的怪物准备的（会 cloneSkinned、
    强制 castShadow、按高度归一化到"贴水面"），摆静态道具会做一堆无用功
- `src/game/SkyTowerMode.js`：
  - `#layerEntries(layer)` 泛化自 `#footEntries`（带 `index`）
  - `#driveOne` 里第 2 层分支：写 `boat.speedMul` / 禁冲刺 / K 键 = 放泡泡
  - `#spawnAllCargo` 跳过第 1、2 层；HUD 增 `towerDeliver/towerCarrier/towerDeliverScore…`
- `src/ui/ui.js`：`renderTowerExtras` 与底部进度条按 `towerFoot / towerDeliver` 三态换口径
  （`GOAL · 本层进球` / `SEND · 本层送达` / `CARGO · 背包价值`）
- `server/server.js`：`RELAY_TYPES` 追加
  `'deliverGrab','deliverDrop','deliverScore','bubbleSpawn','bubblePop'`
  （天梯消息原先**一条都没被服务器转发**，已一并补上第 1 层的 4 条）

### 联机

房主权威：拾取 / 送达 / 炸中判定**只有房主做**（`this.authority`），
客机收到 `deliverGrab / deliverDrop / deliverScore / bubbleSpawn / bubblePop` 后只放视觉。
掉线/落海走 `#dropCargo('lost')` → 货回取货台（防"鬼握着货"）。

---

## 5. 验收

```bash
WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_deliver_probe.mjs   # 28 项
node tests/_tmp_deliver_shots.mjs                                      # 6 张调视觉用近景
```

探针覆盖：场景结构（两门/门GLB/取货台/包子材质/光柱）· 抢货后 `speedMul===0.72` ·
背货不能放泡泡 · K 键放出 ShaderMaterial 泡泡 · **引信 3.0s 爆炸** ·
炸中掉货 + 僵直 · 送达 +2 分 · 1.6s 回台 · 塔柱挡船（第 2 层）·
塔柱不挡第 1 层（对照组：摘掉碰撞圆结果一样）· 控制台无异常。

截图：`shots/verify/sky-tower-deliver-{overview,gate,bun,bubble,hud}.jpg`、
`shots/verify/d-{bun-close,bun-context,gate,gate-cool,bubble,carrier,layer-overview}.jpg`

---

## 6. 待办 / 已知取舍

- **AI 只会直线追**：`aiPlan()` 给了"背货冲门 / 追持货者 / 去抢货"三态，
  但没有绕塔柱的路径规划，会顶在柱子上蹭一下。
- 中央塔柱材质是 `metalness 0.72` 的水晶，在夕阳天里会镜面反射成粉色"管子"，
  在别的天气（暴雪/星空）里才像水晶。要改得先确认（属于场景共用件）。
- 第 1 层的升降光柱仍在（唯一上楼方式），等"层结算→上楼"流程做好再撤。
- 第 3 层（联机道具箱大乱斗）见 `docs/sky_tower_layer3_*`（待写）。
