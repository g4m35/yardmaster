#!/bin/sh
# A Yardmaster test command: runs the prebuilt runner on the leased device against the configured bundle ID.
#   sh run.sh [--remove-runner] [step ...]     steps: tap:<label> expect:<text> alert:<button> home banner:<text> screenshot:<name> wait:<s>
# Screenshots land in $YARDMASTER_ARTIFACT_DIR/attachments. The result bundle (which names the device) stays in a
# temporary folder and is deleted. --remove-runner uninstalls only the runner's own two apps afterwards.
set -eu
: "${YARDMASTER_DEVICE_UDID:?run through Yardmaster, which provides the leased device}"
: "${YARDMASTER_BUNDLE_ID:?run through Yardmaster}"
: "${YARDMASTER_ARTIFACT_DIR:?run through Yardmaster}"
here=$(cd "$(dirname "$0")/.." && pwd)
remove=0
if [ "${1:-}" = "--remove-runner" ]; then remove=1; shift; fi
xctestrun=$(ls "$here"/build/DerivedData/Build/Products/YardRunner_*.xctestrun 2>/dev/null | head -n 1 || true)
if [ -z "$xctestrun" ]; then echo "The runner is not built. Run: YM_RUNNER_TEAM=<team id> sh $here/scripts/build.sh" >&2; exit 2; fi
runner_app="$(dirname "$xctestrun")/Debug-iphoneos/YardRunner.app"
runner_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$runner_app/Info.plist")

steps="" sep=$(printf '\037')
for step in "$@"; do steps="${steps:+$steps$sep}$step"; done
work=$(mktemp -d "${TMPDIR:-/tmp}/ym-runner.XXXXXX")
cleanup() {
  rm -rf "$work"
  if [ "$remove" = 1 ]; then
    for id in "$runner_id" "$runner_id.uitests.xctrunner"; do
      xcrun devicectl device uninstall app --device "$YARDMASTER_DEVICE_UDID" "$id" >/dev/null 2>&1 && echo "removed $id" || echo "could not remove $id" >&2
    done
  fi
}
trap cleanup EXIT

status=0
TEST_RUNNER_YM_TARGET_BUNDLE_ID="$YARDMASTER_BUNDLE_ID" TEST_RUNNER_YM_STEPS="$steps" \
  xcodebuild test-without-building -xctestrun "$xctestrun" -destination "id=$YARDMASTER_DEVICE_UDID" \
  -resultBundlePath "$work/runner.xcresult" || status=$?
if [ -d "$work/runner.xcresult" ]; then
  mkdir -p "$work/attachments" "$YARDMASTER_ARTIFACT_DIR/attachments"
  if xcrun xcresulttool export attachments --path "$work/runner.xcresult" --output-path "$work/attachments" >/dev/null; then
    find "$work/attachments" -type f -name '*.png' -exec cp {} "$YARDMASTER_ARTIFACT_DIR/attachments/" \;
  else
    echo "Screenshots could not be exported from the result bundle" >&2
  fi
fi
exit "$status"
