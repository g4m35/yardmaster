#!/bin/sh
# Exercises the standalone binary the way people use it: plugins (dynamic import) and the demo (hub, dashboard, agents).
set -eu
bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
home="$(mktemp -d)"
export YARDMASTER_HOME="$home"
export YARDMASTER_HUB="" YARDMASTER_TOKEN=""
demo=""
cleanup() {
  if [ -n "$demo" ]; then kill "$demo" 2>/dev/null || true; for i in $(seq 1 20); do kill -0 "$demo" 2>/dev/null || break; sleep 1; done; fi
  rm -rf "$home"
}
trap cleanup EXIT
"$bin" --version
"$bin" help > /dev/null
"$bin" providers list --json | grep -q '"browserbase"'
test "$("$bin" recover --json)" = '{"replayed":[],"pending":[],"skippedLive":[]}'
echo "local recovery ok"
mkdir -p "$home/plugins/smoke"
printf "export default { kind: 'notifier', name: 'smoke', onEvent() {} };\n" > "$home/plugins/smoke/index.mjs"
"$bin" plugin test smoke
# Push gate from the binary: a failing check stops the push, a passing one goes through.
repo="$home/gate-repo"
git init -q --bare "$home/gate-remote.git"
git init -q -b main "$repo"
(
  cd "$repo"
  git config user.email smoke@example.com
  git config user.name smoke
  printf '{"verify":["sh check.sh"],"services":{"local":{"browser.verify":{"service":"browser","command":["sh","check.sh"],"protocol":"command","locality":"local","cost":"free"}},"verify":[{"capability":"browser.verify"}]}}\n' > yardmaster.json
  printf 'if grep -q BAD flag.txt; then echo "flag is BAD"; exit 1; fi\n' > check.sh
  echo ok > flag.txt
  git add -A && git commit -qm init && git remote add origin "$home/gate-remote.git"
  "$bin" verify --json | grep -q '"ok": true'
  "$bin" ci init > /dev/null
  git push -q origin main
  echo BAD > flag.txt && git commit -qam bad
  if git push -q origin main 2> "$home/gate.err"; then echo "push gate let a failing push through"; exit 1; fi
  grep -q "checks failed" "$home/gate.err" || { cat "$home/gate.err"; exit 1; }
)
echo "push gate ok"
"$bin" demo --port 7793 > "$home/demo.log" 2>&1 &
demo=$!
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:7793/api/health > /dev/null 2>&1; then break; fi
  sleep 1
done
curl -fs http://127.0.0.1:7793/ | grep -q "Yardmaster" || { cat "$home/demo.log"; exit 1; }
token="$(grep -o 'token=[^ ]*' "$home/demo.log" | cut -d= -f2)"
for i in $(seq 1 30); do
  done_count="$(curl -fs -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{}' http://127.0.0.1:7793/api/rpc/board.status | grep -o '"done":[0-9]*' | cut -d: -f2 || true)"
  if [ -n "$done_count" ] && [ "$done_count" -ge 1 ]; then echo "demo merged $done_count task(s)"; exit 0; fi
  sleep 2
done
cat "$home/demo.log"
echo "--- board"
curl -fs -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{}' http://127.0.0.1:7793/api/rpc/board.text || true
echo
echo "--- events"
curl -fs -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"after":0,"limit":40}' http://127.0.0.1:7793/api/rpc/events.since | tr '}' '\n' | grep -o '"message":"[^"]*"' || true
echo "--- logs"
for f in "$home"/logs/*.log; do [ -f "$f" ] && { echo "$f"; tail -5 "$f"; }; done
echo "demo never finished a task" >&2
exit 1
