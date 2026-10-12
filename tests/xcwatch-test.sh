#!/bin/bash
# Tests for bin/xcwatch. Compiles into a temp SIMAPHORE_DIR; uses fake Devices folders only.
XW="$(cd "$(dirname "$0")/.." && pwd)/bin/xcwatch"
BASE=${TMPDIR:-/tmp}
mkdir -p "$BASE"
export SIMAPHORE_DIR=$(mktemp -d "$BASE/xcwatch-test.XXXXXX")
T=$(mktemp -d "$BASE/xcwatch-work.XXXXXX")
trap 'kill $(jobs -p) $(cat "$T"/*.pid 2>/dev/null) 2>/dev/null; rm -rf "$SIMAPHORE_DIR" "$T"' EXIT
. "$(dirname "$0")/lib.sh"
export XCWATCH_DEVICES=$T/Devices
mkdir -p "$XCWATCH_DEVICES" "$T/dir"
U=AAAAAAAA-0000-0000-0000-000000000001
u=$(echo "$U" | tr A-Z a-z)

# soon <condition>: poll up to 20s (tests/lib.sh soon returns 1 after a successful retry)
soon() { local i=0; while [ $i -le 100 ]; do eval "$1" && return 0; sleep 0.2; i=$((i+1)); done; return 1; }
# later <seconds> <command...>: run it in the background after a pause
later() { local s=$1; shift; ( sleep "$s"; "$@" ) & }
# start_events <name> <args...>: events output goes to $T/<name>.out
start_events() { local n=$1; shift; "$XW" events "$@" >> "$T/$n.out" 2>&1 < /dev/null & echo $! > "$T/$n.pid"; }
has() { grep -qF -- "$2" "$T/$1.out"; }
stop() { local p; p=$(cat "$T/$1.pid"); kill "$p"; wait "$p" 2>/dev/null; }

echo "== not built"
check "path prints nothing" "$("$XW" path)" ""
"$XW" path >/dev/null; check "path exits 69" $? 69
"$XW" wait --timeout 1 "$T/dir" >/dev/null; check "wait exits 69" $? 69
"$XW" events >/dev/null; check "events exits 69" $? 69
"$XW" bogus 2>/dev/null; check "unknown subcommand exits 64" $? 64

echo "== build"
mkdir -p "$SIMAPHORE_DIR/bin"; touch "$SIMAPHORE_DIR/bin/xcwatch-old"
bin=$("$XW" build); check "build exits 0" $? 0
check "binary is executable" "$([ -x "$bin" ] && echo yes)" yes
check "name has 12 hex chars" "$(basename "$bin" | grep -cE '^xcwatch-[0-9a-f]{12}$')" 1
check "older binaries removed" "$(ls "$SIMAPHORE_DIR/bin" | tr '\n' ' ')" "$(basename "$bin") "
before=$(ls -i "$bin")
check "second build prints same path" "$("$XW" build)" "$bin"
check "second build does not recompile" "$(ls -i "$bin")" "$before"
check "path prints the binary" "$("$XW" path)" "$bin"

echo "== wait"
"$XW" wait --timeout 0.5 "$T/dir"; check "timeout exits 1" $? 1
later 0.5 touch "$T/dir/a"; "$XW" wait --timeout 5 "$T/dir"; check "file created in folder" $? 0
later 0.5 touch "$T/dir/a"; "$XW" wait --timeout 5 "$T/dir"; check "file changed in folder" $? 0
later 0.5 rm "$T/dir/a"; "$XW" wait --timeout 5 "$T/dir"; check "file deleted from folder" $? 0
later 0.5 touch "$T/dir/new"; "$XW" wait --timeout 5 "$T/dir/new"; check "path that does not exist yet" $? 0
later 0.5 touch "$T/dir/other"; "$XW" wait --timeout 1.5 "$T/dir/never"; check "other names in the parent are ignored" $? 1
echo x > "$T/file"; later 0.5 touch "$T/file"; "$XW" wait --timeout 5 "$T/file"; check "existing file changed" $? 0
later 0.5 touch "$T/dir/two"; "$XW" wait --timeout 5 "$T/nothing" "$T/dir"; check "several paths" $? 0
later 0.5 touch "$T/dir/z"; "$XW" wait --timeout 5 "$T/dir/../dir"; check "path with .." $? 0
mkdir -p "$XCWATCH_DEVICES/$U"
later 0.5 touch "$XCWATCH_DEVICES/$U/device.plist"; "$XW" wait --timeout 5 --devices; check "device.plist change" $? 0
later 0.5 touch "$XCWATCH_DEVICES/$U/other.txt"; "$XW" wait --timeout 1.5 --devices; check "other files in a device are ignored" $? 1
"$XW" wait --timeout 0.5 --memory; check "memory with no pressure change times out" $? 1

echo "== events"
mkdir -p "$T/dir/sub"
start_events e --dir "$T/dir" --devices --memory
soon "has e '\"kind\":\"ready\"'"; check "ready" $? 0
touch "$T/dir/f1"
soon "has e '\"path\":\"$T/dir/f1\"'"; check "file event under the folder name given" $? 0
touch "$XCWATCH_DEVICES/$U/device.plist"
soon "has e '{\"kind\":\"sim\",\"udid\":\"$U\"}'"; check "sim event, UDID upper case" $? 0
mkdir -p "$XCWATCH_DEVICES/$u"; touch "$XCWATCH_DEVICES/$u/device.plist"
soon "has e '{\"kind\":\"sim\",\"udid\":\"$U\"}'"; check "lower-case folder is upper-cased" $? 0
sleep 0.5; : > "$T/e.out"
touch "$XCWATCH_DEVICES/$U/other.txt" "$XCWATCH_DEVICES/device.plist"
mkdir -p "$XCWATCH_DEVICES/$U/data/Library"; touch "$XCWATCH_DEVICES/$U/data/Library/device.plist"
sleep 1
check "device noise is not printed" "$(grep -c sim "$T/e.out")" 0
sleep 0.5; : > "$T/e.out"
for i in 1 2 3 4 5 6 7 8 9 10; do echo $i >> "$T/dir/burst"; done
sleep 1
n=$(grep -c '/burst"' "$T/e.out")
check "burst is coalesced" "$([ "$n" -ge 1 ] && [ "$n" -le 3 ] && echo ok)" ok
check "every line is JSON" "$(grep -vcE '^\{"kind":"[a-z]+".*\}$' "$T/e.out")" 0
stop e

echo "== events: processes"
sleep 30 & victim=$!
start_events p --pid "$victim"
soon "has p ready"
check "live pid: no exit yet" "$(grep -c '"exit"' "$T/p.out")" 0
kill "$victim"; wait "$victim" 2>/dev/null
soon "has p '{\"kind\":\"exit\",\"pid\":$victim}'"; check "exit event" $? 0
stop p
start_events d --pid "$victim"
soon "has d '\"kind\":\"exit\"'"; check "already-dead pid reported" $? 0
check "ready comes first" "$(head -1 "$T/d.out")" '{"kind":"ready"}'
stop d

echo "== events: lifetime"
start_events s --dir "$T/dir"
soon "has s ready"; sleep 1
check "empty stdin does not end it" "$(kill -0 "$(cat "$T/s.pid")" 2>/dev/null && echo alive)" alive
stop s
bash -c '"$0" events --dir "$1" > "$2/o.out" 2>&1 < /dev/null & echo $! > "$2/o.pid"; sleep 1' "$XW" "$T/dir" "$T"
soon "! kill -0 $(cat "$T/o.pid") 2>/dev/null"; check "exits when its parent exits" $? 0
check "events leaves no files in the folder" "$(ls -A "$SIMAPHORE_DIR/bin" | wc -l | tr -d ' ')" 1

echo "== tether"
check "runs the command, keeps its output" "$("$XW" tether -- echo hi)" hi
"$XW" tether -- sh -c 'exit 3'; check "keeps its exit code" $? 3
"$XW" tether -- 2>/dev/null; check "no command is bad usage" $? 64
"$XW" tether -- "$T/no-such-command" 2>/dev/null; check "missing command" $? 70
"$XW" tether -- sleep 30 & tp=$!
soon "pgrep -P $tp sleep >/dev/null"; cp=$(pgrep -P "$tp" sleep)
kill "$tp"; wait "$tp"; check "SIGTERM ends it cleanly" $? 0
soon "! kill -0 $cp 2>/dev/null"; check "SIGTERM stops the command" $? 0
bash -c '"$0" tether -- sleep 30 & echo $! > "$1/t.pid"; sleep 30' "$XW" "$T" & caller=$!
soon "[ -s '$T/t.pid' ] && pgrep -P \$(cat '$T/t.pid') sleep >/dev/null"; cp=$(pgrep -P "$(cat "$T/t.pid")" sleep)
kill -9 "$caller"; wait "$caller" 2>/dev/null
soon "! kill -0 $cp 2>/dev/null"; check "killed caller (-9) stops the command" $? 0
soon "! kill -0 $(cat "$T/t.pid") 2>/dev/null"; check "and the tether itself" $? 0

finish
