# Dragon Palace Fixed-Route Pass

## Delivered

- Removed the random three-route feature from map data, client logic, track constraints, and WebSocket protocol.
- Restored the fixed underwater dive path with one deterministic surface shortcut.
- Added a shared-timeline lift gate at palace entry gate 2. When the gate is low, nine overlapping circular colliders push boats back, reduce speed, and apply a short stun.
- Moved the procedural palace and `coral_palace.glb` into the gate 2-4 course area.
- Added deterministic seabed sand patches, shell meshes, and 18 looping fish. Fish are visual-only and do not affect collisions.

## Verification

- `npm.cmd run build` passed.
- `node --check` passed for `Track.js`, `Game.js`, `Environment.js`, `server.js`, and `maps.js`.
- `rg` confirmed no remaining route-choice or route-request references.
- Vite responds at `http://127.0.0.1:5173/`.

## Playtest Focus

Check that the gate's closed window is readable before the dive, that a collision produces a mild rebound rather than a spin, and that the fixed dive path remains visible in all three laps. The gate cycle is deterministic per elapsed scene time, so all clients use the same phase without route voting or pause UI.

## Follow-up Readability Pass

- The moving gate now sits at the Dragon Palace entry offset from gate 2; checkpoint validation is blocked while that gate is closed.
- Palace and GLB scenery are moved off the racing centerline, with palace perimeter colliders to prevent passing through the structure.
- Coaster airborne containment samples the full curve instead of a short straight trigger segment.
- The underwater floor uses a sand-colored base across the full 600m seabed and a regular shell grid; coral props are authored across separate lap sectors.
- Palace-only side guide markers make the next direction legible without adding dense centerline clutter.

## Latest Adjustment

- The animated palace door is now positioned at the model entrance offset from gate 2; gate 2 remains a normal checkpoint and only blocks while the entrance is physically closed.
- The coaster configuration is overridden to start after the second dive (`from: 12`, `to: 15`) so the jump is separated from the palace and shipwreck landmarks.
- The seabed is sand-colored across the complete floor. Shells use one `InstancedMesh` on a regular grid for full coverage at low draw-call cost.
- Full coaster-curve sampling prevents airborne boats from tunneling through the launch route or leaving the landing corridor.

## Yacht and Collision QA Pass

- `yacht.glb` now replaces the Falcon boat with an explicit +X to +Z model rotation.
- Browser inspection found the imported dragon gate's solid dark door slab was the reported black block. It is hidden from the playable scene; the Track gate is the single animated visual/collision source.
- Gate closure uses 17 overlapping colliders, so the entrance cannot be threaded between posts. The imported gate and Track gate share gate 2 coordinates and the same seven-second cycle.
- Boat movement stores the previous position and sweeps against static and dynamic colliders. The manual ejector was shortened to a 14m launch offset and 12m ramp.
- Item mode now exposes a red magnet aim phase, confirms on the second press, and synchronizes the selected target ID across LAN clients. Reverse camera tracking stays aligned with the boat's forward heading.
