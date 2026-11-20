# Delivery: Defensive Duration and Drift Spray

- All defensive effects now last three seconds, including normal shield,
  angel protection, and anti-magnet readiness.
- Anti-magnet is smaller than the regular shield while still fitted to a boat's
  loaded hull envelope.
- Drift spray is directional cyan water-drop particle streaks rather than
  growing white smoke sprites.
- `npm.cmd test`, `npm.cmd run build`, and local HTTP resource checks passed.

## Drift Overlay Correction

- Removed legacy large wake and water-curtain sprites from the drift path.
- Retinted remaining non-drift wake sprites cyan.
- Verified the served source contains two drift wake guards and no legacy
  drift-water-curtain block; unit test and production build pass.
