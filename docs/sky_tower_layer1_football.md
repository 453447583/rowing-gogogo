# 云端天梯 · 第 1 层：水球赛（2026-11-24）

> 用户拍板：天梯取消"运货上塔"，改成 10 层 10 个小游戏，累计分最高者胜。
> 本文件只记**第 1 层**（球 / 球门 / 障碍）。其余 9 层暂时仍是原来的运货玩法。

## 玩法

把球撞进对方球门得分。球门固定、球被能量网关在球场里，赛艇可以照常冲出玻璃边缘掉进海里。

- 每进一球 **+1 分**，记在"进攻方向 = 进球那一侧"的玩家头上（1v1 各占一边；3 人时 index 奇偶分边，2 打 1）。
- 进球后 1.4 秒球回中圈，中圈 3.2m 内的船短暂不参与碰撞（防"刚发球就被顶飞"）。
- 第 1 层**不刷货**，`LAYER_SPAWN[0]` 被跳过；HUD 的"背包价值"自动换成"本层进球"。

## 三套边界（别混）

| 边界 | 位置 | 挡谁 |
|---|---|---|
| 能量围板 | 球场线 100×62 | **只挡球**（恢复系数 0.72），船能直接开过去 |
| 玻璃盘边缘 | 半径 82（`layerRadius(0)`） | 挡船：开出去就落海（老逻辑，`SkyTowerArena.constrain`） |
| 球门缺口 | x = ±50，\|z\| < 8 | 球心越过门线即得分；门柱（r=0.45）会把球弹回来 |

球心最远只能到 ±(50-2.2) / ±(31-2.2)：**球永远出不了球场**，由单测的第 7 项守着（1800 帧乱踢零逃逸）。

## 数值（全部在 `src/data/skyTowerRun.js` → `SKY_TOWER.FOOTBALL`）

- 场地 100×62、门 16×6、球半径 2.2、球质量 = 船的 1.7 倍。
- 手感常数在 `src/game/skyTowerBall.js` 的 `BALL_PHYS`：滚动阻尼 1.9 m/s² + 二次项，一脚 20m/s 滚 40~75m（半场多一点）；船撞球恢复系数 0.42（偏推不偏弹）。
- 障碍 2~3 个，**固定一柱一石**再随机第三个；只在中圈带 |x|<26 / |z|<18 生成，中圈 7m 内留空，球门前 24m 绝不生成。
- 障碍布局用 mulberry32 + `SEED` 确定性生成：**两端各自算同一份，不需要联机同步位置**。

## 模块

- `src/game/skyTowerBall.js`：球的刚体，**纯函数**（不 import three / DOM），单测直接跑。
- `src/game/SkyTowerFootball.js`：球场涂装 / 围板 / 球门（门柱+手搓网格）/ 礁石 / 熔岩柱 / 球的视觉 + 联机插值。
- `src/game/SkyTowerMode.js`：只负责接线（`#updateFootball` / `#onFootballGoal` / AI 踢球点 / HUD / 15Hz 球位姿广播）。

### 联机

- 球是唯一动态刚体，**永远房主权威**：房主跑 `stepBall`，15Hz 广播 `footBall{x,z,vx,vz,h,dead}`，客机只插值。
- 进球 `footGoal{id,side,s}` 由房主发，客机据此改分。
- 服务器 `RELAY_TYPES` **补了 6 条**：`towerDash/towerScore/towerOpen/towerEnd` 以前完全不在白名单里（等于联机天梯的同步消息全被服务器丢掉了），加上新的 `footBall/footGoal`。

## 验收

```bash
node tests/sky_tower_football.test.mjs     # 纯物理单测（阻尼/反弹/进球/门柱/船撞球/不出界）
WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_football_probe.mjs   # 实机 + 截图
WB_URL=http://127.0.0.1:5199/ node tests/sky_tower_probe.mjs            # 天梯回归（捡货已挪到第 2 层）
```

截图在 `shots/verify/sky-tower-football-*.jpg`。

## 已知待办（本层之外）

1. **升降光柱还在第 1 层**：现在它是唯一的上楼方式，等"层结算 → 上楼"的流程做出来再撤。
2. **第 2~10 层还是运货**，逐层替换时把 `SkyTowerMode` 里 cargo 那套整体抽成 `LayerGame` 接口。
3. 球的地面提示（HUD 小地图/箭头）还没做；`hudData().towerFootBall` 已经带了球位姿。
4. 足球 AI 只会"绕到球后面往前顶"，不会射门角度、不会回防。
