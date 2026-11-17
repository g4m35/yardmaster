#!/bin/sh
# Builds the runner once per machine for physical iOS devices, with automatic development signing.
# Needs a team ID (Xcode > Settings > Accounts, or the OU of your "Apple Development" certificate).
set -eu
cd "$(dirname "$0")/.."
: "${YM_RUNNER_TEAM:?Set YM_RUNNER_TEAM to your Apple Developer team ID; see README.md}"
set -- xcodebuild build-for-testing -project YardRunner.xcodeproj -scheme YardRunner -configuration Debug \
  -destination generic/platform=iOS -derivedDataPath build/DerivedData -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$YM_RUNNER_TEAM"
if [ -n "${YM_RUNNER_BUNDLE_ID:-}" ]; then set -- "$@" YM_RUNNER_BUNDLE_ID="$YM_RUNNER_BUNDLE_ID"; fi
"$@"
ls build/DerivedData/Build/Products/*.xctestrun
