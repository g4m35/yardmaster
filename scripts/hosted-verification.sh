#!/usr/bin/env bash
# Run inside an ephemeral Linux test VM, never on the owner's workstation.
# Usage: bash scripts/hosted-verification.sh <expected-HEAD> <baseline-SHA>
set -euo pipefail
expected_head=${1:?Pass the exact commit to verify}
baseline_sha=${2:?Pass the baseline commit for the performance comparison}
[[ "$expected_head" =~ ^[a-f0-9]{40}$ && "$baseline_sha" =~ ^[a-f0-9]{40}$ ]]
test "$(uname -s)" = Linux
test "$(git rev-parse HEAD)" = "$expected_head"
test -z "$(git status --porcelain --untracked-files=no)"
git cat-file -e "$baseline_sha^{commit}"
receipt_dir=${YM_VERIFICATION_OUTPUT:-/tmp/yardmaster-verification}
mkdir -p "$receipt_dir"
test_home=$(mktemp -d /tmp/ym-hosted-home-XXXXXX)
stage=bootstrap
finish() {
  result_code=$?
  if test "$result_code" -ne 0; then
    node -e 'console.log(JSON.stringify({status:"failed",stage:process.argv[1],exitCode:Number(process.argv[2]),head:process.argv[3]},null,2))' "$stage" "$result_code" "$expected_head" > "$receipt_dir/result.json"
    cat "$receipt_dir/result.json"
    if test -f "$receipt_dir/$stage.log"; then tail -n 60 "$receipt_dir/$stage.log"; fi
  fi
  rm -rf "$test_home"
}
trap finish EXIT
export YARDMASTER_HOME="$test_home"
export YARDMASTER_HUB=''
export YARDMASTER_TOKEN=''
export CI=1
export NO_COLOR=1
printf '%s\n' "$expected_head" > "$receipt_dir/head.txt"
node --version > "$receipt_dir/node24.txt"
node -e 'if(process.versions.node.split(".")[0]!=="24") process.exit(1)'
run_check() { stage=$1; shift; "$@" > "$receipt_dir/$stage.log" 2>&1; }
run_check install npm ci
run_check typecheck npm run typecheck
run_check build npm run build
run_check test-node24 npm test
run_check package-smoke node scripts/package-smoke.mjs
run_check binary-build node scripts/build-binary.mjs
run_check binary-smoke bash scripts/smoke-binary.sh "release/yardmaster-linux-$(node -p 'process.arch')"
stage=performance
node bench/compare.mjs "$baseline_sha" > "$receipt_dir/performance.json"
# Use a separate runtime for the same Node 22 lane as CI; record the resolved patch version.
npm exec --yes --package=node@22 -- node --version > "$receipt_dir/node22.txt"
run_check test-node22 npm exec --yes --package=node@22 -- node scripts/test.mjs
test "$(git rev-parse HEAD)" = "$expected_head"
test -z "$(git status --porcelain --untracked-files=no)"
node -e 'console.log(JSON.stringify({head:process.argv[1],platform:process.platform,arch:process.arch,completedAt:new Date().toISOString(),checks:["typecheck","build","test-node24","test-node22","package-smoke","binary-build","binary-smoke","performance"],status:"passed",coverageGap:"macOS lanes were not executed on this Linux runner"},null,2))' "$expected_head" > "$receipt_dir/result.json"
cat "$receipt_dir/result.json"
