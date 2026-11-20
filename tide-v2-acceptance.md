# 冰汐海峡 v2 验收记录

执行时间：2026-10-29 18:00–19:45
环境：Windows / Node 22.12 / 无头 Edge 130（软件渲染）

---

## 1. 单元测试

```
node tests/gameplay.test.mjs   → gameplay unit checks: PASS
node tests/tide_layout_audit.mjs → tide layout audit: PASS
```

`tide_layout_audit.mjs`（新增）的量化结果：

```
lap = 1077.2 m   gateWidth = 14   shortcuts = 2
seg lengths: 37 55 55 45 53 54 64 58 50 58 49 66 63 51 46 57 60 56 50 48
seg min/max/avg = 37 / 66 / 54
主道最近的非相邻段间距 = 36.9m（段 1 ↔ 19）
shortcut #11→#14: 181 → 144 m  省 20.2%  口 0.0/0.0m  中段净空 23.0m
shortcut #8→#10: 108 →  78 m  省 27.9%  口 0.0/0.0m  中段净空 22.6m
rocks checked: 4
podium 最近门距 103.1m（需 > 42）  r=233.5
gate r: max 199.1  min 61.4  boundary 310 → 余量 110.9m
iceZone covers gates: 11,12,13,14,15,16
```

- 段长 37–66m，最长/最短 = 1.78（刻意不均，方案要求 ≥1.35）
- 近道中段净空都 ≥ `gateWidth + 近道宽`（17.4m），没有和主道走廊压在一起
- 领奖台在冰区、潮汐区之外

## 2. 构建

```
node scripts/vite-run.mjs build
dist/index.html                   60.38 kB │ gzip 14.90 kB
dist/assets/index-UA4Bs40q.js  1,055.91 kB │ gzip 311.58 kB
✓ built in 8.90s
```

## 3. 视觉验收（`node tests/tide_visual.mjs` → PASS）

场景自检：

```
map: tide   gates: 20   boundary: 310
cliffInstances: 9        cliffMaterialVertexColors: true
icebergLarge: 12         icebergSmall: 26      icebergColliders: 12
edgeWalls: 12            iceSheet: true
```

出图（`shots/verify/`）：

| 文件 | 看什么 |
|---|---|
| `tide-corner5-day.png` | ★ #5 直角前，两侧岩壁夹出的"门" |
| `tide-corner5-storm.png` | 暴风雨里的同一处 |
| `tide-channel-day.png` | 北岸峡谷壁夹道（只放外圈一侧，另一侧开阔水面） |
| `tide-ice-day.png` | ★ 冰面护栏是否一眼看清 |
| `tide-ice-dusk.png` | 黄昏冰原 |
| `tide-ice-blizzard.png` | ★ 暴风雪里冰山轮廓是否还立得住 |

AI 推进（关键：无头浏览器软件渲染只有 1–3 fps，墙钟时间没有意义，
脚本先把渲染尺寸压到 320×200 再按**游戏内 raceTime** 计时）：

```
ai: 游戏内 8s 走了 160m，经过 4 个门的邻域，最远到 #4（均速 20.0 m/s）
```

按 20 m/s 折算，方案要求的"14s 内推进 4–6 个门"落在区间内；
更重要的是"不卡死"这一条成立：AI 从静止起步后一路加速、连续过门，
没有撞上岩壁或冰山退出来。

## 4. 方案 5.3 三条验收要点的实际表现

1. **冰面上必须能一眼看出护栏**：成立。做法是护栏脚下 0.5m 深色压边
   （`#16242e`）+ 冰面 2.6m 暗影带（`#1b3648` @0.5），青蓝霓虹压在深色带上，
   远近都有明确的一条"路基"。
2. **站在 #5 直角前能看到两侧岩壁夹出的门**：成立。转角处按"进弯方向 + 两侧"
   成对布置，`tide-corner5-day.png` 里能看到左右两面岩壁和中间的开口。
3. **暴风雪里冰山不糊成一坨白**：基本成立。冰山按水线配色（水下深蓝 →
   水线青蓝 → 冰白），加上硬边着色和裂缝压暗，50–100m 内轮廓清楚；
   更远处的冰山会被雾吃掉——这是雾的物理结果，不打算为它破坏雾效。

## 5. 已知小瑕疵（不影响验收）

- 冰区两个镜头（`ice-day` / `ice-dusk`）画面右下角会闪出一片青绿色半透明面。
  定位结果：`track.group` 里的近道霓虹墙被追车镜头贴到极近处所致
  （近道 A 的走廊在 #11–#14 与主道并行）。只在镜头擦着近道墙时出现，
  不是几何错误；若要彻底消掉，需要给近道墙做"贴脸淡出"，本轮未做。
- 冰原日照下仍然偏亮（近乎过曝），这是 `day` 预设太阳强度 1.6 + 近白冰面
  的必然结果；颜色层次靠裂缝和阴影带撑，与方案"近纯白"一致。
