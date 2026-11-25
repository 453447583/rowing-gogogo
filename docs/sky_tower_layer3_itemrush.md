# 云端天梯第 3 层 · 道具箱大乱斗

> 2026-11-24 实现。玩法口径由用户拍定：**A 为主分（吃到几个道具箱）+ B 少量加分（用道具打中对手）**，
> 限时 1 分钟，联机按队伍汇总。道具箱、道具、释放逻辑**全部沿用道具赛**，对手一律当敌方。

## 一、规则

| 项 | 值 | 出处 |
| --- | --- | --- |
| 所在层 | 第 3 层（`layer = 2`，y = 36） | `SKY_TOWER.ITEMRUSH.LAYER` |
| 甲板面 | `layerY(2) + 0.30 = 36.3` | `SkyTowerItemRush.deckY` |
| 限时 | 60 秒（第一个人踩上来开始计时） | `DURATION` |
| 箱子数 | 56（同心 4 圈：14m×8 / 27m×12 / 40m×16 / 53m×20） | `RING_R` / `RING_N` |
| 补箱 | 4 秒（竞速那套 8s 在 1 分钟的乱斗里跟不上） | `BOX_RESPAWN` |
| A 分 | 吃到一个箱子 **+1** | `SCORE_BOX` |
| B 分 | 用道具打中对手一次 **+1** | `SCORE_HIT` |
| 道具池 | 18 种（道具赛全池**去掉 `gate`**：它依赖赛道弧线，平地上没有语义） | `SkyTowerItemRush.POOL` |
| 键位 | **1 / 2 / 3**（不是道具赛的 Q/W/E） | 见下文"键位为什么改" |

箱子中心留 8m 空档：中央水晶塔柱半径 3.9m 穿层而过，最内圈 14m 刚好让开。

## 二、为什么直接复用 `ItemManager`

"释放道具的逻辑按照道具赛来"——只要行为一致就不该有第二份实现。
`Items.js` 本来就支持无赛道布箱（`opts.boxLayout`，竞技场在用），补 4 个口子之后这一层几乎零改动：

| 口子 | 作用 |
| --- | --- |
| `opts.groundAt(x,z,t)` | 弹道/水柱/预警环的高度原来硬写 `waveHeight()`，在 36m 高的玻璃盘上会把特效画到海面。默认仍是 `waveHeight`，老玩法一字不变 |
| `opts.boxRespawn` | 补箱秒数（默认 8） |
| `opts.onTakeBox(id, box)` | 开箱回调 → A 分 |
| `opts.onHit(id)` | **所有**弹道/区域命中都会走 `#noteHit`，一处挂全模式覆盖 → B 分 |
| `opts.boxYPad` | **拾取高度过滤**（默认 `Infinity` = 关闭）。10 层玻璃盘在 xz 上完全重叠，只按平面距离判的话第 1 层的船会隔空吃掉头顶 36m 的箱子。这一层写 4m |
| `boxLayout[].y` | 每箱自带高度（`b.y > 0.5` 时箱子与接触阴影都贴这个面，不跟海浪起伏） |

顺带修掉两处硬编码：`#takeBox` 和 `handleNet('itemPick')` 里的 `b.respawn = 8` 改成 `this.boxRespawn`。

## 三、键位为什么是 1/2/3

天梯里 **W 是油门**。道具赛用 `Input.itemMode` 接管 W/E 释放道具，一开就会把油门吞掉。
所以第 3 层不走 `Input`，自己在 `SkyTowerMode` 上挂了 `keydown` 队列：

```js
Digit1 / Digit2 / Digit3（含小键盘）→ itemQueued = 0|1|2
KeyK → dashQueued（冲刺，K 在天梯里一直是冲刺）
```

`#updateItemRush(dt)` 每帧消费队列，只有站在第 3 层才真的 `useSlot()`，其余层直接清掉（不让按键攒着）。

## 四、视觉：零新增程序化几何体

用户明确要求"不要丑丑的程序几何体，有现成 GLB 就用"：

| 元素 | 来源 |
| --- | --- |
| 道具箱 | 道具赛那个带贴图的霓虹箱（`ItemBoxField`：霓虹渐变面板 + emissiveMap + 黄铜铆钉 + 问号 + 环绕粒子 + 破碎碎片），56 个实例 1 个 draw call |
| 12 根路灯杆 | `/models/low_poly_street_light_pole.glb`，15m，站最外圈 `R*0.97` |
| 8 座拱门 | `/models/props/shortcut_arch.glb`（赛道近道那个带木纹/石纹的拱），11m，`R*0.88` |

**2026-11-24 换掉 `props/portal.glb`**：它本质是一圈发光环，缩到 15m 之后就是一个粉色塑料呼啦圈，
占掉半个屏幕还跟冷玻璃完全不搭——探针全绿，只有截图才看出来。
探针 `[2]` 里有一条硬断言 `own.length === 0`：`itemRush.group` 的每个子节点都必须带 `userData.glb`，
从而把"以后谁又手搓一个 BoxGeometry 塞进来"挡在门内。

装饰都不参与碰撞（这一层只有箱子和船；撞灯杆掉速会莫名其妙）。

## 五、HUD

- `#hud` 加 `tower-rush` 类（`tower-mode` 默认把 `#item-slots` 整块 `display:none`）。
  放行时**必须带 `!important`**：收起那条规则是 `!important` 的，不带的话无论特异性多高都赢不了
  （症状：父容器 flex 了、三个格子还是 0×0）。
- 道具栏落在 `bottom: 24px`，正好在 DASH 条（`#tower-hud .th-bottom` 的 `bottom: 112px`）下方；
  这一层把 `.th-hint` 收掉，否则被道具栏压住。
- 顶部三格面板第三格切成 `BOX · 本层箱子`（`th-cargo`），阶段条显示
  `🎁 道具箱大乱斗 · 剩 0:47 · 箱子 N / 命中 M`，右上榜单每人显示 `N箱·M中`。
- 顺手修了既有缺陷：`.debuff-chip` 里的状态图标是 1024px PNG，没有尺寸约束，
  一出现就在左下角糊出一个"比船还大的粉色头"——现在锁死 20px。

## 六、联机

- 广播白名单：`SKY_TOWER_NET_TYPES` 追加 `itemPick/itemUse/itemHeld/itemHit/itemFx/itemRushEnd`；
  服务端 `RELAY_TYPES` 只多一条 `itemRushEnd`（前五个本来就有）。
- 房主权威：开箱/命中由房主 `ItemManager` 结算并 `onScore`；客机把 `itemPick/itemHit` 增量记进
  `bx`/`hit` 只为展示，不加分（避免双倍）。
- 结束：房主 `#finish()` → `net.send({t:'itemRushEnd'})`；客机收到后本地 `#finish()`。
- 名次：`rank()` 用 `bx*100 + hit` 排序，喂给道具赛的"打前一名 / 反超保底"逻辑。

## 七、验收

```bash
WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_itemrush_probe.mjs
```

34 项，含：56 箱 / 4 圈半径 / 高度过滤（下一层同坐标吃不到）/ 吃箱 +1 / 补箱 4 秒 /
命中钩子 +1 / 1 放护盾 / 2 放方向转换器（对手被反转 = 默认敌方）/ 12+8 件 GLB /
`own.length === 0` / 60 秒结束清场 / HUD 键位 1-2-3 与实际可见高度。

回归：`tests/sky_tower_probe.mjs`（捡货用例已挪到第 4 层）、
`tests/sky_tower_deliver_probe.mjs`、`tests/sky_tower_football_probe.mjs`。

截图：`shots/verify/sky-tower-itemrush-{overview,boxes,decor,slot,hud}.jpg`

## 八、待办

- **层结算 → 上楼流程**：现在 60 秒打完本层锁死，玩家继续上楼；等各层都有玩法后再统一做"层结算卡"。
- 第 3 层不刷运货货物（`#spawnAllCargo` 已跳过 LAYER 0/1/2），第 4 层往上仍是旧运货玩法。
- AI 在乱斗层只做两件事：朝最近箱子开、没箱子就追人；不会主动找掩体或绕塔柱。
