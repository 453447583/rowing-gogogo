# Drift Nitro Delivery

## Implemented

- The bottom nitro bar is now an independent 0-100% drift-charge gauge.
- Filling that gauge converts it to one upper-right nitro bottle, up to two bottles.
- Ctrl consumes only a stored bottle; it never reduces the bottom gauge.
- Static obstacles, course walls, buoy chains, launch bars, and outer boundaries cancel the active drift reward, clear its current charge, and cancel pending mini boosts.
- Clean medium drifts queue one mini boost; clean long drifts queue two sequential mini boosts.

## Verification

- `node --check` passed for the changed gameplay and HUD modules.
- `npm.cmd test` passed, including charge conversion, inventory cap, collision cancellation, and double-boost regression coverage.
- `npm.cmd run build` passed.
- `npm.cmd run test:visual` passed with browser assertions for the independent bottom gauge and upper-right bottle inventory.

## Offshore Podium Follow-up

- Each map now owns an authored `podium` anchor in open water outside the race route.
- The results camera focuses this fixed stage rather than a position beside the finisher.
- Dragon Palace uses `(215, -205)`, outside the course and all palace/dive scenery.
