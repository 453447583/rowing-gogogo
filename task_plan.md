# Task Plan: Drift Nitro Inventory Correction

## Goal
Keep the bottom drift charge gauge independent from a two-bottle nitro inventory and make drift collision and double mini-boost behavior reliable.

## Phases
- [x] Phase 1: Inspect current nitro, drift, collision, HUD, and tests.
- [x] Phase 2: Separate charge and inventory state; wire collision cancellation.
- [x] Phase 3: Restore bottom gauge and add upper-right bottle inventory.
- [x] Phase 4: Add regression coverage and run build/test verification.

## Decisions Made
- Bottom gauge is a 0..1 current-fill value; bottles are an independent 0..2 integer inventory.
- A collision during a drift clears the current gauge and prevents that drift from producing mini boosts.
- A clean medium drift grants one mini boost and a clean long drift grants two sequential mini boosts.

## Status
**Complete** - unit, production build, and browser HUD regressions all pass.

---

# Task Plan: Offshore Podium Placement

## Goal
Place every map's world-space results podium in unobstructed open water outside the playable race route.

## Phases
- [x] Phase 1: Locate podium placement and camera behavior.
- [x] Phase 2: Author safe offshore anchors for every map.
- [x] Phase 3: Verify placement constraints, build, browser rendering, and screenshot output.

## Decision
- The finish-line-relative podium placement is replaced with per-map fixed offshore anchors, so the results scene cannot inherit a dense finish area's obstructions.

## Status
**Complete** - every map has an offshore podium anchor; unit, build, and browser scene checks pass.

---

# Task Plan: Falcon Rotation and Shortcut Entries

## Goal
Keep the Falcon's visual hull at a persistent counterclockwise 90-degree orientation and move all shortcut branches to main-route edge openings.

## Phases
- [x] Phase 1: Trace the GLB transform and shortcut source points.
- [x] Phase 2: Protect Falcon visual yaw from animation and move shortcut endpoints to route edges.
- [x] Phase 3: Verify the model transform and all shortcut geometry in browser and tests.

## Status
**Complete** - Falcon GLB wrapper yaw and all shortcut edge entry/exit distances pass browser, unit, and build verification.

---

# Task Plan: Launch Pair Placement and Rock Collisions

## Goal
Keep each launcher's two-platform pair intact while alternating whole pairs between lanes, and prevent airborne boats from passing through rocks and islands.

## Phases
- [x] Phase 1: Inspect launch-chain generation and obstacle collision paths.
- [x] Phase 2: Move whole launcher pairs left/right without changing pair geometry.
- [x] Phase 3: Add airborne swept collision against vertically bounded rocks and islands.
- [x] Phase 4: Run regression and production-build verification.

## Decisions Made
- Whole pairs alternate deterministically left then right, so LAN clients share the same course layout.
- Existing `pairGap`, platform scale, and `halfSide` values remain unchanged.
- Airborne collision uses the same horizontal sweep principle as water navigation and only activates within a rock or island's vertical extent.

## Status
**Complete** - unit checks and production build pass. Browser smoke test could not start its CDP port in this environment and timed out before loading the app.

## Errors Encountered
- Browser smoke test timed out waiting for `http://127.0.0.1:9227/json`; unit and build verification still pass.

---

# Task Plan: Launch Obstacles and Boat Impacts

## Goal
Make canyon mountains block airborne boats, make stable boats shove unstable boats with a readable capsize reaction, and vary whole launcher-pair lane placement.

## Phases
- [x] Phase 1: Trace canyon mountain construction, boat collision, and launcher-pair placement.
- [x] Phase 2: Add canyon mountain collision and stability-weighted boat impacts.
- [x] Phase 3: Generate deterministic non-repeating left/right launcher-pair lanes.
- [x] Phase 4: Add regression coverage and verify build.

## Decisions Made
- Canyon mountain colliders use a broad vertical envelope matching their stretched visual meshes.
- Boat impacts resolve both positions and velocities; stability disadvantage controls a temporary 0.70-0.85 rad visual roll.
- Launch groups use a map-seeded lane pattern and an edge offset computed from the unchanged pair envelope.

## Status
**Complete** - syntax checks, gameplay regression tests, and the production build pass.

---

# Task Plan: Authoritative Multiplayer Boat Collisions

## Goal
Synchronize boat collision displacement, velocity, and capsize roll from the host to every connected client.

## Phases
- [x] Phase 1: Trace state snapshots and client/host simulation ownership.
- [x] Phase 2: Add host-authoritative all-boat collision resolution.
- [x] Phase 3: Serialize collision velocity and roll corrections through the server snapshot.
- [x] Phase 4: Apply local corrections and verify syntax, regression tests, and build.

## Decisions Made
- The host resolves each boat pair once after remote snapshots are applied.
- State arrays carry velocity components, roll, and a host-authorship flag; the server rejects non-host attempts to publish another racer's state.
- Non-host local boats consume host corrections directly while remote boats interpolate toward the same authoritative target.

## Status
**Complete** - authoritative collision sync is implemented and verified.

---

# Task Plan: Canyon Shortcut Clearance

## Goal
Move canyon shore obstacles away from the shortcut and make the shortcut a standalone branch outside the main route.

## Phases
- [x] Phase 1: Locate the canyon shortcut, static rocks, and procedural shore props.
- [x] Phase 2: Replace the rejected S weave with an independent west-side shortcut and retain geometry-aware shore clearance.
- [x] Phase 3: Verify route advantage, tests, syntax, and production build.

## Decisions Made
- The shortcut keeps gates 10-14 and width 3.0, with a west-side middle section that stays outside the main route corridor.
- Canyon cliffs are moved outward when their generated collision envelope overlaps any shortcut segment.
- The former in-corridor static rock is moved northwest; regression checks enforce static-rock and main-route separation.

## Status
**Complete** - standalone west-side branch, obstacle clearance, gameplay regressions, and production build all pass.

---

# Task Plan: Nitro Speed Separation

## Goal
Make nitro acceleration visibly faster than ordinary movement without changing each boat's normal handling speed.

## Phases
- [x] Phase 1: Trace nitro and normal speed limits.
- [x] Phase 2: Raise the shared nitro multiplier while preserving normal max speeds.
- [x] Phase 3: Update regression coverage and verify syntax/tests/build.

## Decision
- Nitro `boostPower` is now `1.8x` for every boat; normal `maxSpeed` values remain unchanged.

## Status
**Complete** - nitro speed separation is implemented and verified.

---

# Task Plan: Launcher Count, Shortcut Entry, and Finish Window

## Goal
Reduce launchers in race/item modes, remove shortcut-entry teleporting, and start the ten-second finish window for any first finisher.

## Phases
- [x] Phase 1: Trace launcher generation, shortcut constraints, and finish events.
- [x] Phase 2: Limit normal modes to one paired launcher and blend shortcut entry projections.
- [x] Phase 3: Make AI and all network finishers start the shared ten-second window.
- [x] Phase 4: Update regression coverage and verify syntax/tests/build.

## Decisions
- Race and item modes retain one paired launcher, while launch mode keeps its full chain.
- Shortcut centerlines now smoothstep from the main route at both mouths, not just the corridor width.
- The server starts its timer on the first finisher with a real finish time, regardless of AI or client identity.

## Status
**Complete** - launcher count, shortcut entry smoothing, and shared finish-window behavior are implemented and verified.

---

# Task Plan: Remote Boat Jitter Fix

## Goal
Stop non-host boats from oscillating when moving forward under host-authoritative snapshots.

## Phases
- [x] Phase 1: Trace local prediction, authoritative snapshots, and remote interpolation.
- [x] Phase 2: Replace direct local snapshot teleports with damped reconciliation and retain large-discontinuity snaps.
- [x] Phase 3: Add regression coverage and verify syntax/tests/build.

## Decision
- Host collision positions, velocities, and roll remain authoritative; short-distance corrections are blended over frames so local input and network state do not fight each other.

## Status
**Complete** - remote boat forward-motion jitter is fixed and verified.

---

# Task Plan: Four-Map Polish (PAUSED 2026-11-17, 待用户另一任务完成后继续)

## Goal
修复四张地图的可玩性/视觉问题（冰汐海峡冰块、氮气包 UI、峡谷险道立交、深海龙宫丑几何体 + 移动障碍）。

## 已完成
1. **氮气包 UI（完成）**：`index.html` 里 `.nitro-slot .nitro-pack { display: none }` 被删掉，改成 `width:38px; height:52px`。比赛内实测 display=block、stock 166×60。
2. **冰汐海峡白色冰块（完成）**：`Environment.js #buildIceField` 恢复 27 块带碰撞浮冰（IceFloes InstancedMesh 27 / colliders 27），顶点色"白顶 + 冰蓝侧壁 + 冷色自发光"，坐在冰壳顶面 (y=0.26)。
3. **峡谷险道立交（完成）**：`maps.js` ocean.overpass 改为 `from:20, to:31, profile:[0,0.8,2.2,3.6,5.2,6.6,8.4,7.6,6.4,4.6,2.4,0]`（整圈连续抬升，交叉点净空约 4.4m）；`Track.js` 新增 `#overpassDeckAt()`，桥面投影下不再铺浮桶；`Environment.js #buildRocks` 加 `overpassHit()` 跳过穿桥岩石。截图确认上层连续、浮桶不再交织、坡面无岩石穿出。
4. **深海龙宫丑几何体（部分完成）**：`diveArch` 石柱/宝石环、`colossus` 棋子巨像、出水柱廊均已删除，改成记录 `palaceArchSpots/palaceCoralSpots/palaceBoulderSpots` 并由 `#loadPalaceProps` 加载 `coral_reef.glb` / `rock_boulder.glb` 填充（实测 archProps=10）。**但用户否掉了 coral_reef（"这珊瑚好丑，不要加入这个珊瑚"）**。
5. **深海龙宫左右移动障碍（机制完成，素材待换）**：`maps.js palace.moverGates=[1,7,16]`（段中点、避开潜行/过山车/道具门），`Environment.js` 生成 3 块浮礁 + 每帧跟随的碰撞体（含 px/pz 扫掠），`#updatePalace` 做正弦横移。

## 恢复后待办（按顺序）
1. **删掉所有 coral_reef 用法**（mover / arch / 巨人礁三处），改用 `public/models/rock_boulder.glb` 或 `shore/rock_cluster.glb` 这类带贴图岩石；巨礁可叠 2~3 块石头 + `hazard_kelp.glb`。
2. 复测龙宫移动障碍在 gate 1→2 / 7→8 / 16→0 段中点的可见性与可避让空间（宽 5.8~6.4、amp=0.26×gateWidth）。
3. 复测冰汐海峡冰块在驾驶视角的辨识度（已有 tide_floe_chase*.png）。
4. 清理临时文件：`tests/_tmp_*.mjs`、`shots/verify4/`、`.tmp_browser/`、`.tmp_syntax/`。

## 关键实现位置
- `src/game/Environment.js`：`#buildIceField`、`#buildPalace`（diveArch/colonnade/giantReef）、`#loadPalaceProps`（movers/替换件）、`#updatePalace`、`#buildRocks`、`#addProp`（约 5485 行）。
- `src/game/Track.js`：`#computeGateY`（op.profile）、`#overpassDeckAt`、`#buildEdgeBuoys` 的 keepFn、`#reservedPropGates`。
- `src/data/maps.js`：ocean.overpass、palace.moverGates。

## Status
**PAUSED** - 用户插入新任务，完成后再继续。
