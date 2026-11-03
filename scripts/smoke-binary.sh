#!/bin/sh
# Exercises the standalone binary the way people use it: plugins (dynamic import) and the demo (hub, dashboard, agents).
set -eu
bin="$1"
home="$(mktemp -d)"
export YARDMASTER_HOME="$home"
demo=""
cleanup() {
  if [ -n "$demo" ]; then kill "$demo" 2>/dev/null || true; for i in $(seq 1 20); do kill -0 "$demo" 2>/dev/null || break; sleep 1; done; fi
  rm -rf "$home"
}
trap cleanup EXIT
"$bin" --version
"$bin" help > /dev/null
mkdir -p "$home/plugins/smoke"
printf "export default { kind: 'notifier', name: 'smoke', onEvent() {} };\n" > "$home/plugins/smoke/index.mjs"
"$bin" plugin test smoke
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
