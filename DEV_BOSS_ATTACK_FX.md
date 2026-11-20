# 怪物模式：氮气粒子攻击 + 统一加速尾焰

> 本次开发独立记录，不再往体积很大的 `DEV_STATUS.md` 里追加。

## 目标

1. 怪物模式里每艘赛艇的主炮攻击，改成**竞速模式该艇氮气尾焰的同款 Effekseer 粒子素材**，分散成粒子飞向 BOSS。
2. 不出现 Three.js 的球芯 / 白光圈 / 线段拖尾包裹弹丸。
3. 玩法参数（伤害、弹速、弹数、散布、射速、热量、射程、蓄力）全部保持不变。
4. 怪物模式里所有赛艇的**加速尾焰统一**回最早的 `jet`（`public/effects/Basic/Laser01.efkefc`）。
5. 青锋号原本是蓄力贯穿激光，按确认改成**高速粒子弹道**（伤害/蓄力数值不变）。

## 改动文件

### 新增 `src/game/nitroFx.js`

- `NITRO_JETS`：从 `Game.js` 抽出的逐船氮气尾焰配置，竞速/道具模式继续逐船差异化。
- `BOSS_BOOST_JET`：怪物模式统一的 `jet` 尾焰（`scale 0.18`、船尾正中单喷口、跟随不拖尾），与旧版表现一致。
- `nitroAttackFx(boatId)`：取该艇氮气尾焰素材给主炮弹丸使用，默认缩到尾焰的 `0.55`；
  个别素材单独用 `atkScale` 调（牛来号气流团 `0.12`、青锋号风团 `0.95`）。

### `src/game/Game.js`

- 改为从 `./nitroFx.js` 导入 `NITRO_JETS` / `BOSS_BOOST_JET`。
- `#updateNitroFx`：`mode === 'boss'` 时使用 `BOSS_BOOST_JET`，其余模式保持原逐船尾焰。

### `src/game/BoatWeapons.js`

- `#spawnProjectile`：删除 Three.js 球芯、白色 glow Sprite、10 段线段拖尾；
  改为 `Effects.playAttached` 挂该艇氮气粒子素材，跟随弹道位置。
  每套主炮有独立 `shotPrefix`，玩家和同型 AI 的挂载 key 不会互相覆盖。
- `#fireBeam`（青锋号）：不再发射瞬间激光，改为 `150 m/s` 的高速粒子弹，
  `life 1.0s` 对应原 `150m` 射程；伤害 `基础 + 蓄力`、过载倍率、热量、射速原样保留。
- `#updateProjectiles` / `#removeProjectile`：弹道数据改用 `p.pos`，命中/超时同步收掉挂载特效，避免粒子残留。
- 删除只为激光服务的 `strike()`、`beams`、`#updateBeams()`。
- 命中特效、炮口闪光、小怪/岩石/弱点判定、伤害数字逻辑均未改动。

## 参数核对（实测值）

| 赛艇 | 弹型 | 伤害 | 弹速 | 弹数 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 赤焰号 rower | shot | 9 | 52 | 1 | 原参数 |
| 绯鲨号 skiff | torpedo | 16 | 46 | 1 | 原参数 |
| 青锋号 falcon | 原 beam → shot | 22 + 76×蓄力 | 150 | 1 | 蓄力/暴击/射程不变 |
| 磐石号 titan | shot | 8 | 44 | 3 | 原三连发 |
| 流光号 dolphin | blade | 19 | 60 | 1 | 原参数 |
| 琥珀号 vintage | shot | 15 | 50 | 1 | 原参数 |
| 长鲸号 longship | shot | 11 | 48 | 2 | 原双联 |
| 牛来号 cow | shot | 10 | 34 | 2 | 原参数 |

## 验证

- `npm run build` 通过。
- 用 CDP 探针逐个切换 8 艘赛艇同步开火，确认：
  - 弹道对象只有 `pos`，**没有** `group`（Three.js 弹体已移除）；
  - 每发都成功挂上对应氮气素材（`attached ≥ 1`）；
  - 伤害/弹速与上表一致；
  - 画面截图里弹丸是分散粒子，没有白光圈包裹。
- `node tests/boss_gameplay.mjs`：①～⑤ 全部通过（锥形判定、落雷、血包、天使庇佑、聊天条）。
- 已知环境噪声（与本次改动无关）：
  - 无头 Edge + SwiftShader 下 Effekseer WASM 偶发 `null function or function signature mismatch`；
    把本次弹体特效开关关掉后同样复现，属于无头环境问题。
  - `tests/boss_items_fx.mjs` 在 `vulnerable` 等待处超时、`tests/arena_smoke.mjs` 第⑦步道具使用失败，
    都是低帧率/时序或既有测试环境问题，未触及本次改动路径。

## 后续调参入口

- 粒子太大/太小：改 `src/game/nitroFx.js` 里对应赛艇的 `atkScale`（没有写则用 `scale × 0.55`）。
- 想换某艘艇的攻击素材：改该艇 `NITRO_JETS[id].fx`，竞速尾焰会同步变化。
- 怪物模式统一尾焰想换素材：改 `BOSS_BOOST_JET.fx` / `scale`。
