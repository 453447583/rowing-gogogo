#!/bin/bash
# 批量修复 6 艘赛艇的灰底 UV，输出到 assets_src/boats/fixed/
set -u
cd "D:/3Dgame - 副本" || exit 1
SRC="D:/xwechat_files/wxid_qw5fabo46vqf21_f680/msg/attach/15185118517a2baffeced2a242e074fe/2026-11/Rec/85cf5278652ec0e8/F"
BLENDER="D:/blender/blender.exe"
OUT="D:/3Dgame - 副本/assets_src/boats/fixed"
LOG="D:/3Dgame - 副本/shots/verify/boats/fix/run.log"
mkdir -p "$OUT" "$(dirname "$LOG")"
: > "$LOG"

run() {
  local tag="$1" sub="$2" file="$3"
  echo "[$(date +%H:%M:%S)] START $tag" | tee -a "$LOG"
  "$BLENDER" -b --factory-startup --python-exit-code 1 \
    --python scripts/boats/heal_uv2.py -- \
    "$SRC/$sub/$file" "$OUT/${tag}_fixed.glb" "$tag" albedo 2>&1 \
    | grep -E "@@JSON@@|Traceback|Error" | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] DONE $tag" | tee -a "$LOG"
}

run jetboat   1 "未来喷气艇3d模型.glb"
run redcar    2 "3d模型 红色飞行汽车.glb"
run flycar    3 "未来飞行汽车3d模型.glb"
run speedboat 4 "3d模型 快速艇.glb"
run ship      5 "未来船艇3d模型.glb"
run car6      6 "未来汽车3d模型.glb"
echo "ALL DONE" | tee -a "$LOG"
ls -la "$OUT" | tee -a "$LOG"
