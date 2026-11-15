#!/bin/sh
# Passes only when the launched app wrote its marker: app code ran on the simulator Yardmaster leased.
set -eu
: "${YARDMASTER_DEVICE_UDID:?run through Yardmaster (ym verify), which provides the leased simulator}"
data=$(xcrun simctl get_app_container "$YARDMASTER_DEVICE_UDID" "$YARDMASTER_BUNDLE_ID" data)
i=0
while [ "$i" -lt 30 ]; do
  if [ "$(cat "$data/Documents/smoke.txt" 2>/dev/null)" = "ready" ]; then
    cp "$data/Documents/smoke.txt" "$YARDMASTER_ARTIFACT_DIR/smoke.txt"
    echo "Smoke marker found for $YARDMASTER_BUNDLE_ID on $YARDMASTER_DEVICE_UDID"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "The app did not write its smoke marker within 30 seconds" >&2
exit 1
