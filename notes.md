# Notes: Drift Nitro Correction

## Findings
- `Boat.nitroCharge` currently represents both continuous charge and stored bottles, which caused the HUD regression.
- Static collider, track boundary, and mechanic collision paths are split between `Boat.js` and `Track.js`.
- Existing drift release code already supports sequential mini boosts, but it needs collision cancellation to be part of the state transition.

## Offshore Podium Findings
- The previous podium spawned 13 meters ahead of the local finisher, so its final placement inherited dense finish-line scenery.
- Each map now declares a fixed `podium` anchor well beyond three route widths from its nearest gate.
- The Dragon Palace anchor is at `(215, -205)`, in open southeast surface water and outside its dive corridors.

## Launch Mode Findings
- `launch` mode generates whole launch groups before expanding each group into two platforms at `[-pairGap, pairGap]`.
- The previous launch-mode offset varied only around the centerline and was too small to make alternating groups meaningfully distinct.
- `Environment` rocks and islands already contributed horizontal colliders, but those colliders had no vertical extents and the airborne Boat branch bypassed them.

## Launch Obstacles and Boat Impacts
- Canyon shoreline mountains are created in `Environment.#buildShores`; their stretched meshes now register `type: 'cliff'` colliders with broad `bottomY`/`topY` bounds, so `Boat.updateLocal` swept airborne checks can stop them.
- `Game.#boatVsBoats` now applies mass-weighted separation and normal velocity changes to both boats. `boatCollisionRoll` gives only the lower-stability hull a temporary 0.70-0.85 rad roll after a meaningful impact.
- Full launch mode first computes physical route landing projections, then moves each complete pair by an edge offset derived from `gateWidth`, `pairGap`, and `halfSide`. A map-id hash rotates a fixed irregular lane pattern so clients agree without using `Math.random()`.

## Multiplayer Collision Synchronization
- The host now resolves every boat pair once after remote snapshots are applied, while non-host clients retain only local prediction until the next authoritative correction.
- State snapshots append `vx`, `vz`, collision roll, and an `auth` flag. The server accepts cross-player state replacement only when the sender is the current host.
- A non-host's local boat applies host-authored corrections directly; remote boats interpolate the same velocity and roll targets. This keeps displacement and the 40-49 degree capsize visible consistently across clients.

## Canyon Shortcut Clearance
- The initial S-weave was rejected because its middle overlapped the main-course area. The replacement is a five-point west-side branch: only the endpoints connect to gates 10 and 14, while every interior point is more than 14m from the main-route section.
- The former rock at `(-46, 96)` conflicted with the independent route and was moved to `(-92, 86)`. Tests now enforce clearance for every static canyon rock.
- `Environment.#buildShores` computes distance from generated canyon cliff props to every shortcut segment and shifts overlapping props outward by 12m before registering their visual mesh and collider.

## Nitro Speed Separation
- Nitro now uses `boostPower: 1.8` on every boat. Normal `maxSpeed` values remain unchanged, so the active nitro cap and thrust are clearly faster than ordinary movement.

## Launcher Count, Shortcut Entry, and Finish Window
- Normal race/item modes now generate one paired launcher group (two platforms); launch mode remains the dedicated full-chain mode.
- `Track.constrain()` smoothsteps the projected centerline from the main route to each shortcut over the first/last 14m, eliminating endpoint projection teleports.
- Solo AI finishes invoke the same `onFinish` callback as the local player. The server finish timer now begins for the first racer with a recorded finish time, and its `finish` broadcast drives the countdown on every client.

## Remote Boat Jitter Fix
- Non-host local boats were being teleported to every host snapshot by `applyNetworkCollisionState()`, then moved again by local physics on the next frame. Short-distance authoritative corrections now use a damped reconciliation target; only respawns or large discontinuities snap immediately.
