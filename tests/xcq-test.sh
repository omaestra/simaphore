#!/bin/bash
# Tests for bin/xcq. Uses stand-in commands only, never xcodebuild.
XCQ="$(cd "$(dirname "$0")/.." && pwd)/bin/xcq"
BASE=${TMPDIR:-/tmp}
mkdir -p "$BASE"
export SIMAPHORE_DIR=$(mktemp -d "$BASE/xcq-test.XXXXXX")
trap 'rm -rf "$SIMAPHORE_DIR"; kill $(jobs -p) 2>/dev/null' EXIT
Q=$SIMAPHORE_DIR/queue
# Fixed memory state and one build at a time, so results never depend on this Mac.
export XCQ_FAKE_PRESSURE=1 XCQ_FAKE_SWAP_PCT=0 XCQ_MAX_BUILDS=1
export XCQ_FAKE_PS=/dev/null   # real builds on this Mac must not take room in the tests
. "$(dirname "$0")/lib.sh"
export XCQ_TEST=1   # lets the tests use XCQ_FAKE_FILE
unset XCQ_HELD XCQ_HELD_BY   # in case these tests run inside a queued build
reset() { rm -rf "$SIMAPHORE_DIR"/*; sim_on; LOG=$SIMAPHORE_DIR/log; export LOG; : > "$LOG"; }
# stand-in build: log start/end with epoch, sleep $2 seconds
job() { echo "echo \"$1 start \$(date +%s)\" >> \"\$LOG\"; sleep $2; echo \"$1 end \$(date +%s)\" >> \"\$LOG\""; }
order() { awk '$2=="start"{printf "%s ", $1}' "$LOG"; }

echo "== bad usage"
"$XCQ" onlyone two 2>/dev/null; check "usage exits 64" $? 64

echo "== no overlap"
reset
"$XCQ" t1 A "$(job A 2)" >/dev/null & p1=$!
sleep 0.5
"$XCQ" t2 B "$(job B 2)" >/dev/null & p2=$!
wait $p1 $p2
check "runs are sequential (A start,A end,B start,B end)" "$(awk '{printf "%s%s ",$1,$2}' "$LOG")" "Astart Aend Bstart Bend "
a_end=$(awk '$1=="A"&&$2=="end"{print $3}' "$LOG"); b_start=$(awk '$1=="B"&&$2=="start"{print $3}' "$LOG")
[ "$b_start" -ge "$a_end" ] && ok "B started at/after A ended" || bad "B started before A ended"

echo "== FIFO of three"
reset
"$XCQ" z1 A "$(job A 3)" >/dev/null & p1=$!
sleep 1.1
"$XCQ" y2 B "$(job B 1)" >/dev/null & p2=$!
sleep 1.1
"$XCQ" x3 C "$(job C 1)" >/dev/null & p3=$!
wait $p1 $p2 $p3
check "start order" "$(order)" "A B C "

echo "== .prio jumps the line"
reset
"$XCQ" t1 A "$(job A 4)" >/dev/null & p1=$!
sleep 1.1
"$XCQ" t2 B "$(job B 1)" >/dev/null & p2=$!
sleep 1.1
"$XCQ" t3 C "$(job C 1)" >/dev/null & p3=$!
sleep 0.5; touch "$Q/t3.prio"
wait $p1 $p2 $p3
check "start order" "$(order)" "A C B "

echo "== dead ticket"
reset; mkdir -p "$Q"
printf 'pid=999999\nlabel=ghost\nqueued=1\nstate=running\ncmd=x\n' > "$Q/ghost.ticket"; touch "$Q/ghost.prio"
out=$("$XCQ" t1 A "$(job A 1)"); rc=$?
check "runs despite dead running ticket" "$rc" 0
check "dead ticket and prio removed" "$(ls "$Q" | tr '\n' ' ')" ""

echo "== exit codes and ticket cleanup"
reset
"$XCQ" t1 A "exit 3" >/dev/null; check "exit code passed through" $? 3
check "ticket removed after failure" "$(ls "$Q")" ""
"$XCQ" t2 A "true" >/dev/null; check "success exits 0" $? 0
check "ticket removed after success" "$(ls "$Q")" ""

echo "== ticket format"
reset
"$XCQ" t1 lbl "sleep 2" >/dev/null & p1=$!
wait_for "[ -s '$Q/t1.ticket' ] && grep -q state=running '$Q/t1.ticket'"
t=$(cat "$Q/t1.ticket"); echo "$t" | grep -q "^pid=$p1$" && echo "$t" | grep -q "^label=lbl$" && echo "$t" | grep -q "^queued=[0-9]*$" \
  && echo "$t" | grep -q "^started=[0-9]*$" && echo "$t" | grep -q "^cmd=sleep 2$" && ok "ticket has pid,label,queued,state,started,cmd" || bad "ticket format: $t"
wait $p1

echo "== SIGTERM during run"
reset
"$XCQ" t1 A "echo \$\$ > '$SIMAPHORE_DIR/childpid'; exec sleep 30" >/dev/null & p1=$!
wait_for "[ -s '$SIMAPHORE_DIR/childpid' ]"
cpid=$(cat "$SIMAPHORE_DIR/childpid")
kill -TERM $p1; wait $p1 2>/dev/null
check "ticket removed after SIGTERM" "$(ls "$Q")" ""
sleep 0.5
kill -0 "$cpid" 2>/dev/null && { bad "child still alive"; kill "$cpid"; } || ok "SIGTERM killed the running command"

echo "== SIGTERM while waiting"
reset
"$XCQ" t1 A "sleep 5" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/t1.ticket' 2>/dev/null"
"$XCQ" t2 B "true" >/dev/null & p2=$!
wait_for "[ -e '$Q/t2.ticket' ]"; touch "$Q/t2.prio"
kill -TERM $p2; wait $p2 2>/dev/null
check "waiting ticket and prio removed" "$(ls "$Q" | tr '\n' ' ')" "t1.ticket "
kill -TERM $p1; wait $p1 2>/dev/null

echo "== position messages"
reset
"$XCQ" t1 builderA "sleep 3" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/t1.ticket' 2>/dev/null"
out=$("$XCQ" t2 B "true")
wait $p1
echo "$out" | grep -qF "xcq: queued at position 2 (building: builderA)" && ok "position message printed" || bad "no position message: $out"
check "position message printed once" "$(echo "$out" | grep -c 'queued at position')" 1
echo "$out" | grep -qF "xcq: starting" && ok "starting message printed" || bad "no starting message"

echo "== hold: owner's own build"
reset; mkdir -p "$Q"
printf 'label=You · Xcode 27.0\nsince=1\n' > "$SIMAPHORE_DIR/hold"
"$XCQ" h1 A "$(job A 1)" >"$SIMAPHORE_DIR/out" & p1=$!
wait_for "grep -q waiting=hold '$Q/h1.ticket' 2>/dev/null"   # wait_for's exit code is unreliable
grep -q waiting=hold "$Q/h1.ticket" && ok "ticket says waiting=hold" || bad "no waiting=hold"
touch "$SIMAPHORE_DIR/hold"; sleep 2.5; touch "$SIMAPHORE_DIR/hold"
check "fresh hold keeps first-in-line ticket from starting" "$(order)" ""
rm -f "$SIMAPHORE_DIR/hold"
wait $p1
check "starts once the hold is gone" "$(order)" "A "
grep -qF "xcq: held for You · Xcode 27.0's build" "$SIMAPHORE_DIR/out" && ok "hold message printed" || bad "no hold message"
grep -q waiting= "$Q/h1.ticket" 2>/dev/null && bad "waiting key left behind" || ok "waiting key cleared"

echo "== hold: stale file is ignored"
reset
printf 'label=old\nsince=1\n' > "$SIMAPHORE_DIR/hold"; touch -t 202001010000 "$SIMAPHORE_DIR/hold"
"$XCQ" h2 B "$(job B 1)" >/dev/null
check "stale hold does not block" "$(order)" "B "

echo "== two builds at once"
reset
export XCQ_MAX_BUILDS=2
"$XCQ" m1 A "$(job A 3)" >"$SIMAPHORE_DIR/out1" & p1=$!
"$XCQ" m2 B "$(job B 3)" >"$SIMAPHORE_DIR/out2" & p2=$!
wait_for "grep -q state=running '$Q/m1.ticket' 2>/dev/null && grep -q state=running '$Q/m2.ticket' 2>/dev/null"
"$XCQ" m3 C "$(job C 1)" >"$SIMAPHORE_DIR/out3" & p3=$!
wait_for "grep -q waiting=turn '$Q/m3.ticket' 2>/dev/null"
check "two run together, third waits" "$(order)" "A B "
grep -q waiting=turn "$Q/m3.ticket" && ok "third says waiting=turn" || bad "no waiting=turn"
wait $p1 $p2 $p3
check "third starts after one ends" "$(order)" "A B C "
c_start=$(awk '$1=="C"&&$2=="start"{print $3}' "$LOG"); first_end=$(awk '$2=="end"{print $3; exit}' "$LOG")
[ "$c_start" -ge "$first_end" ] && ok "C started after a slot freed" || bad "C started too early"

echo "== race: both claim at once"
reset
for i in 1 2 3 4 5; do
  : > "$LOG"
  "$XCQ" r1 A "$(job A 2)" >/dev/null & p1=$!
  "$XCQ" r2 B "$(job B 2)" >/dev/null & p2=$!
  "$XCQ" r3 C "$(job C 2)" >/dev/null & p3=$!
  wait $p1 $p2 $p3
  peak=$(awk '$2=="start"{n++; if(n>m)m=n} $2=="end"{n--} END{print m}' "$LOG")
  [ "$peak" -le 2 ] || break
done
check "never more than 2 running" "$([ "$peak" -le 2 ] && echo ok)" ok

echo "== memory tight: one at a time"
reset
export XCQ_FAKE_PRESSURE=2
"$XCQ" w1 A "$(job A 3)" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/w1.ticket' 2>/dev/null"
"$XCQ" w2 B "$(job B 1)" >"$SIMAPHORE_DIR/out" & p2=$!
wait_for "grep -q waiting=memory '$Q/w2.ticket' 2>/dev/null"
grep -q waiting=memory "$Q/w2.ticket" && ok "ticket says waiting=memory" || bad "no waiting=memory"
sleep 1
check "second does not start while one runs" "$(order)" "A "
wait $p1 $p2
check "second runs after the first" "$(order)" "A B "
grep -qF "xcq: waiting — memory tight (swap 0%, pressure warning), 1 build at a time" "$SIMAPHORE_DIR/out" && ok "memory message printed" || bad "no memory message: $(cat "$SIMAPHORE_DIR/out")"
check "memory message printed once" "$(grep -c 'memory tight' "$SIMAPHORE_DIR/out")" 1

echo "== memory tight by swap, running build is not stopped"
reset
export XCQ_FAKE_PRESSURE=1 XCQ_FAKE_SWAP_PCT=95
"$XCQ" s1 A "$(job A 3)" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/s1.ticket' 2>/dev/null"
"$XCQ" s2 B "$(job B 1)" >"$SIMAPHORE_DIR/out" & p2=$!
wait_for "grep -q waiting=memory '$Q/s2.ticket' 2>/dev/null"
grep -q waiting=memory "$Q/s2.ticket" && ok "high swap makes it wait" || bad "swap did not limit"
grep -qF "(swap 95%, pressure normal)" "$SIMAPHORE_DIR/out" && ok "message shows swap" || bad "swap text missing"
wait $p1 $p2
check "both finished, one at a time" "$(awk '{printf "%s%s ",$1,$2}' "$LOG")" "Astart Aend Bstart Bend "

echo "== swap alone never stops a build"
reset
"$XCQ" s3 A "$(job A 1)" >/dev/null; check "starts with swap 95% and nothing running" "$(order)" "A "

echo "== critical: nothing new starts, running carries on"
reset
export XCQ_FAKE_SWAP_PCT=0 XCQ_FAKE_PRESSURE=1
"$XCQ" c1 A "$(job A 4)" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/c1.ticket' 2>/dev/null"
echo "XCQ_FAKE_PRESSURE=4" > "$SIMAPHORE_DIR/fake"
XCQ_FAKE_FILE=$SIMAPHORE_DIR/fake "$XCQ" c2 B "$(job B 1)" >"$SIMAPHORE_DIR/out" & p2=$!
wait_for "grep -q waiting=critical '$Q/c2.ticket' 2>/dev/null"
grep -q waiting=critical "$Q/c2.ticket" && ok "ticket says waiting=critical" || bad "no waiting=critical"
sleep 1
check "running build still going, new one held" "$(order)" "A "
grep -qF "memory critical" "$SIMAPHORE_DIR/out" && ok "critical message printed" || bad "no critical message"
wait $p1
sleep 2.5
check "still held with nothing running" "$(order)" "A "
echo "XCQ_FAKE_PRESSURE=1" > "$SIMAPHORE_DIR/fake"
wait $p2
check "starts once memory eases" "$(order)" "A B "
export XCQ_MAX_BUILDS=1 XCQ_FAKE_PRESSURE=1 XCQ_FAKE_SWAP_PCT=0

echo "== swap threshold from XCQ_SWAP_PCT"
reset
export XCQ_MAX_BUILDS=2 XCQ_FAKE_SWAP_PCT=60
XCQ_SWAP_PCT=70 "$XCQ" t1 A "$(job A 2)" >/dev/null & p1=$!
XCQ_SWAP_PCT=70 "$XCQ" t2 B "$(job B 2)" >/dev/null & p2=$!
wait_for "grep -q state=running '$Q/t1.ticket' 2>/dev/null && grep -q state=running '$Q/t2.ticket' 2>/dev/null"
check "60% under a 70 limit: both run" "$(order)" "A B "
wait $p1 $p2
export XCQ_MAX_BUILDS=1 XCQ_FAKE_SWAP_PCT=0

SHIM="$(cd "$(dirname "$0")/.." && pwd)/bin/shim/xcodebuild"
PAUSE="$(cd "$(dirname "$0")/.." && pwd)/bin/xcpause"
# fake "real" xcodebuild: logs args (one per line) + XCQ_HELD, sleeps $FAKE_SLEEP (default 1)
make_fake() {
  FAKE=$SIMAPHORE_DIR/fake-xcodebuild
  cat > "$FAKE" <<'EOT'
#!/bin/bash
echo "start $(date +%s)" >> "$LOG"
{ echo "HELD=$XCQ_HELD"; for a in "$@"; do echo "ARG=$a"; done; } > "$LOG.args.$$"
cp "$LOG.args.$$" "$LOG.args"; rm -f "$LOG.args.$$"
sleep "${FAKE_SLEEP:-1}"
echo "end $(date +%s)" >> "$LOG"
EOT
  chmod +x "$FAKE"; export XCQ_REAL_XCODEBUILD=$FAKE
}

echo "== argv form"
reset
"$XCQ" a1 L -- /bin/echo "two  words" 'x y' >"$SIMAPHORE_DIR/out"; check "argv form exits 0" $? 0
check "spaced args intact" "$(grep -v '^xcq:' "$SIMAPHORE_DIR/out")" "two  words x y"
"$XCQ" a2 L -- /bin/sh -c 'echo held=$XCQ_HELD' >"$SIMAPHORE_DIR/out"
grep -q '^held=1$' "$SIMAPHORE_DIR/out" && ok "XCQ_HELD visible to argv child" || bad "XCQ_HELD missing"
"$XCQ" a3 L 'echo held=$XCQ_HELD' >"$SIMAPHORE_DIR/out"
grep -q '^held=1$' "$SIMAPHORE_DIR/out" && ok "XCQ_HELD visible to string child" || bad "XCQ_HELD missing (string)"

echo "== new ticket keys"
reset; make_fake
XCQ_SESSION=sess1 XCQ_AGENT=agent1 FAKE_SLEEP=2 "$XCQ" k1 L -- "$FAKE" -workspace W.xcworkspace -project P.xcodeproj \
  -destination 'platform=iOS Simulator,id=ABC-123,name=iPhone 17' build >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/k1.ticket' 2>/dev/null"
t=$(cat "$Q/k1.ticket")
for kv in session=sess1 agent=agent1 "cwd=$PWD" sim=ABC-123 workspace=W.xcworkspace; do
  echo "$t" | grep -qxF "$kv" && ok "ticket has $kv" || bad "ticket lacks $kv: $t"
done
wait $p1
XCQ_SESSION= "$XCQ" k2 L -- /bin/sleep 2 >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/k2.ticket' 2>/dev/null"
t=$(cat "$Q/k2.ticket")
echo "$t" | grep -qx 'agent=' && echo "$t" | grep -qx 'sim=' && echo "$t" | grep -qx 'workspace=' && ok "empty keys when unset" || bad "empty keys: $t"
wait $p1
"$XCQ" k3 L -- /bin/sh -c 'sleep 2' x -destination 'platform=iOS Simulator,OS=26,name=iPhone 17 Pro' -project Q.xcodeproj >/dev/null 2>&1 & p1=$!
wait_for "grep -q state=running '$Q/k3.ticket' 2>/dev/null"
t=$(cat "$Q/k3.ticket")
echo "$t" | grep -qx 'sim=iPhone 17 Pro' && echo "$t" | grep -qx 'workspace=Q.xcodeproj' && ok "name fallback and -project fallback" || bad "fallbacks: $t"
kill -TERM $p1; wait $p1 2>/dev/null
"$XCQ" k4 L "sleep 2 # -destination 'id=XYZ' -workspace W2.xcworkspace" >/dev/null 2>&1 & p1=$!
wait_for "grep -q state=running '$Q/k4.ticket' 2>/dev/null"
t=$(cat "$Q/k4.ticket")
echo "$t" | grep -qx 'sim=XYZ' && echo "$t" | grep -qx 'workspace=W2.xcworkspace' && ok "string form best-effort parse" || bad "string parse: $t"
kill -TERM $p1; wait $p1 2>/dev/null

echo "== shim passthrough"
reset; make_fake
for flag in -list -showBuildSettings -showdestinations -showsdks -version -help -showTestPlans; do
  FAKE_SLEEP=0 "$SHIM" $flag build >/dev/null
  [ -z "$(ls "$Q" 2>/dev/null)" ] && grep -qx 'HELD=' "$LOG.args" && grep -qx "ARG=$flag" "$LOG.args" || bad "passthrough $flag"
done
ok "query flags pass through without ticket"
FAKE_SLEEP=0 "$SHIM" -scheme S >/dev/null
grep -qx 'ARG=-scheme' "$LOG.args" && ! grep -q 'jobs' "$LOG.args" && ok "no action word passes through" || bad "no-action passthrough"
# a build started by xcq calls the shim: XCQ_HELD passes it straight through (one ticket, no -jobs)
FAKE_SLEEP=2 "$XCQ" n1 L -- "$SHIM" build -scheme S >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/n1.ticket' 2>/dev/null"; sleep 0.5
grep -qx 'HELD=1' "$LOG.args" && ! grep -q 'jobs' "$LOG.args" && check "nested shim call adds no ticket" "$(ls "$Q")" "n1.ticket" || bad "held passthrough"
wait $p1

echo "== shim -jobs and queueing"
reset; make_fake
FAKE_SLEEP=0 "$SHIM" -scheme "My App" build >/dev/null
check "adds -jobs 6 once" "$(grep -c '^ARG=-jobs$' "$LOG.args") $(grep -x 'ARG=6' "$LOG.args" | wc -l | tr -d ' ')" "1 1"
grep -qx 'ARG=My App' "$LOG.args" && ok "spaced arg preserved through shim" || bad "spaced arg lost"
grep -qx 'HELD=1' "$LOG.args" && ok "real xcodebuild sees XCQ_HELD" || bad "HELD not set in real"
XCQ_JOBS=3 FAKE_SLEEP=0 "$SHIM" build >/dev/null
grep -qx 'ARG=3' "$LOG.args" && ok "XCQ_JOBS honored" || bad "XCQ_JOBS ignored"
FAKE_SLEEP=0 "$SHIM" -jobs 2 build >/dev/null
check "no extra -jobs when present" "$(grep -c '^ARG=-jobs$' "$LOG.args") $(grep -x 'ARG=2' "$LOG.args" | wc -l | tr -d ' ')" "1 1"
check "shim tickets cleaned" "$(ls "$Q")" ""
reset; make_fake
FAKE_SLEEP=2 "$SHIM" build >/dev/null & p1=$!
sleep 0.5
FAKE_SLEEP=2 "$SHIM" build >/dev/null & p2=$!
wait $p1 $p2
check "shim builds run one after the other" "$(awk '{printf "%s ",$1}' "$LOG")" "start end start end "

echo "== xcpause"
reset
"$XCQ" p1 plabel "echo \$\$ > '$SIMAPHORE_DIR/childpid'; exec sleep 30" >/dev/null & p1=$!
wait_for "[ -s '$SIMAPHORE_DIR/childpid' ]"
cpid=$(cat "$SIMAPHORE_DIR/childpid")
"$PAUSE" pause "$cpid" >/dev/null; check "pause exits 0" $? 0
sleep 0.3
check "process is stopped" "$(ps -o state= -p "$cpid" | cut -c1)" T
grep -q '^at=[0-9]*$' "$SIMAPHORE_DIR/paused/$cpid" && grep -qx 'label=plabel' "$SIMAPHORE_DIR/paused/$cpid" \
  && ok "paused file has at and label" || bad "paused file: $(cat "$SIMAPHORE_DIR/paused/$cpid" 2>&1)"
"$PAUSE" resume "$cpid" >/dev/null; check "resume exits 0" $? 0
sleep 0.3
[ "$(ps -o state= -p "$cpid" | cut -c1)" != T ] && ok "process running again" || bad "still stopped"
[ ! -e "$SIMAPHORE_DIR/paused/$cpid" ] && ok "paused file removed" || bad "paused file remains"
"$PAUSE" pause "$cpid" >/dev/null; sleep 0.2
touch "$SIMAPHORE_DIR/paused/999999"   # stale entry for a dead pid
"$PAUSE" resume-all >/dev/null; check "resume-all exits 0" $? 0
sleep 0.3
[ "$(ps -o state= -p "$cpid" | cut -c1)" != T ] && ok "resume-all resumed the process" || bad "resume-all left it stopped"
check "resume-all cleared files" "$(ls "$SIMAPHORE_DIR/paused" | tr '\n' ' ')" ""
kill -TERM $p1; wait $p1 2>/dev/null
"$PAUSE" pause 999999 2>/dev/null; [ $? -ne 0 ] && ok "dead pid exits non-zero" || bad "dead pid accepted"

echo "== queue paused"
reset
unset XCQ_FAKE_PRESSURE; export XCQ_FAKE_PRESSURE=1
"$XCQ" p1 A "$(job A 3)" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/p1.ticket' 2>/dev/null"
touch "$SIMAPHORE_DIR/queue-paused"
"$XCQ" p2 B "$(job B 1)" >"$SIMAPHORE_DIR/out" & p2=$!
wait_for "grep -q waiting=paused '$Q/p2.ticket' 2>/dev/null"
grep -q waiting=paused "$Q/p2.ticket" && ok "ticket says waiting=paused" || bad "no waiting=paused"
wait $p1
sleep 1
check "running build finished, paused one did not start" "$(order)" "A "
grep -qF "queue paused" "$SIMAPHORE_DIR/out" && ok "paused message printed" || bad "no paused message"
rm -f "$SIMAPHORE_DIR/queue-paused"
wait $p2
check "starts once resumed" "$(order)" "A B "

echo "== results file"
reset
R=$SIMAPHORE_DIR/results
XCQ_SESSION=s1 XCQ_AGENT=a1 "$XCQ" r1 lbl "exit 3" >/dev/null
check "failed run exits 3" $? 3
r=$(cat "$R/r1.json" 2>/dev/null)
check "result is valid JSON with the exit code" "$(echo "$r" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["exit"], d["session"], d["agent"], d["label"], d["kind"])' 2>/dev/null)" "3 s1 a1 lbl build"
check "result has endedAt in ms and tookS" "$(echo "$r" | python3 -c 'import json,sys,time; d=json.load(sys.stdin); print(abs(d["endedAt"]/1000-time.time())<30, d["tookS"]>=0)' 2>/dev/null)" "True True"
"$XCQ" r2 lbl "true" >/dev/null
check "success is exit 0" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["exit"])' "$R/r2.json" 2>/dev/null)" 0
"$XCQ" r3 lbl -- true test -scheme S >/dev/null
check "kind comes from the command words" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["kind"])' "$R/r3.json" 2>/dev/null)" test
"$XCQ" r4 'a "quoted" \ label' "true" >/dev/null
check "quotes in the label keep the JSON valid" "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["label"])' "$R/r4.json" 2>/dev/null)" 'a "quoted" \ label'
check "no temp files left behind" "$(ls -A "$R" | grep -c '^\.tmp')" 0
reset
"$XCQ" r5 A "sleep 5" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/r5.ticket' 2>/dev/null"
kill -TERM $p1; wait $p1 2>/dev/null
[ ! -e "$R/r5.json" ] && ok "a killed run leaves no result" || bad "result written for a killed run"


echo "== simulator leases"
XCSIM="$(cd "$(dirname "$0")/.." && pwd)/bin/xcsim"
ST=$(mktemp -d "$BASE/xcq-sim.XXXXXX"); trap 'rm -rf "$SIMAPHORE_DIR" "$ST"; kill $(jobs -p) 2>/dev/null' EXIT
SU=BBBBBBBB-0000-0000-0000-000000000001   # the simulator under test
SB1=BBBBBBBB-0000-0000-0000-000000000002; SB2=BBBBBBBB-0000-0000-0000-000000000003   # two others
sim_json() {  # sim_json <state of SB1 and SB2>
  cat > "$ST/list.json" <<EOT
{"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-26-3","version":"26.3.1"}],
 "devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-3":[
  {"udid":"$SU","name":"Test Phone","state":"Shutdown","isAvailable":true},
  {"udid":"$SB1","name":"Other 1","state":"$1","isAvailable":true},
  {"udid":"$SB2","name":"Other 2","state":"$1","isAvailable":true}]}}
EOT
}
make_fake_simctl "$ST"
sim_reset() { reset; mkdir -p "$SIMAPHORE_DIR/agents"; touch "$SIMAPHORE_DIR/agents/s1.json" "$SIMAPHORE_DIR/agents/s2.json"; sim_json Shutdown; : > "$ST/log"; }
DEST="platform=iOS Simulator,id=$SU,OS=26.3.1"
# simjob <ticket> <label> <session> <action> <name> <sleep>: a stand-in "xcodebuild <action> -destination id=..."
simjob() { XCQ_SESSION=$3 "$XCQ" "$1" "$2" -- /bin/sh -c "$(job "$5" "$6")" sh "$4" -destination "$DEST"; }
LS=$SIMAPHORE_DIR/leases/$SU.lease

sim_reset
XCQ_LABEL=alpha simjob q1 alpha s1 test A 1 >"$SIMAPHORE_DIR/out"; check "test on a free simulator runs" "$(order)" "A "
grep -q '^session=s1$' "$LS" && grep -q '^label=alpha$' "$LS" && ok "lease claimed for the session" || bad "no lease: $(cat "$LS" 2>&1)"
check "simulator renamed for the holder" "$(cat "$ST/log")" "rename $SU 🔒 alpha · Test Phone"
grep -q 'xcq: simulator held' "$SIMAPHORE_DIR/out" && bad "waited on a free simulator" || ok "no sim wait message when free"

sim_reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
sed -i '' 's/^lastUsed=.*/lastUsed=1/' "$LS"
XCQ_LABEL=alpha simjob q2 alpha s1 test A 1 >/dev/null
[ "$(sed -n 's/^lastUsed=//p' "$LS")" -gt 1000000000000 ] && ok "lease touched when the test ends" || bad "lease not touched"

sim_reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
XCQ_LABEL=beta simjob q3 beta s2 test B 1 >"$SIMAPHORE_DIR/out" & p2=$!
wait_for "grep -q waiting=sim '$Q/q3.ticket' 2>/dev/null"
grep -q waiting=sim "$Q/q3.ticket" && ok "ticket says waiting=sim" || bad "no waiting=sim"
sleep 2.5
check "does not start while another holds the simulator" "$(order)" ""
grep -qF "xcq: simulator held by alpha" "$SIMAPHORE_DIR/out" && ok "held message printed" || bad "no held message: $(cat "$SIMAPHORE_DIR/out")"
check "held message printed once" "$(grep -c 'simulator held' "$SIMAPHORE_DIR/out")" 1
XCQ_SESSION=s1 "$XCSIM" free $SU
wait $p2
check "starts once the lease is free" "$(order)" "B "
grep -q '^session=s2$' "$LS" && ok "waiter holds the lease now" || bad "lease not taken over"
grep -q waiting= "$Q/q3.ticket" 2>/dev/null && bad "waiting key left behind" || ok "waiting key cleared"

sim_reset
sim_json Booted
XCQ_LABEL=alpha simjob q4 alpha s1 test A 1 >"$SIMAPHORE_DIR/out" & p1=$!
wait_for "grep -q waiting=room '$Q/q4.ticket' 2>/dev/null"
grep -q waiting=room "$Q/q4.ticket" && ok "ticket says waiting=room" || bad "no waiting=room"
sleep 1
check "does not start without room" "$(order)" ""
grep -qF "xcq: 2 simulators on, waiting for room" "$SIMAPHORE_DIR/out" && ok "room message printed" || bad "no room message: $(cat "$SIMAPHORE_DIR/out")"
sim_json Shutdown
wait $p1
check "starts once there is room" "$(order)" "A "

sim_reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
XCQ_LABEL=beta simjob q5 beta s2 build B 1 >/dev/null
check "a build (not a test) ignores the lease" "$(order)" "B "
grep -q '^session=s1$' "$LS" && ok "build did not take the lease" || bad "build changed the lease"
XCQ_SESSION=s2 "$XCQ" q6 beta -- /bin/sh -c "$(job C 1)" sh test -destination 'platform=iOS Simulator,name=Test Phone' >/dev/null
check "a test with only a name has no sim check" "$(order)" "B C "

sim_reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
XCQ_LABEL=beta simjob q7 beta s2 test B 1 >/dev/null & p2=$!
wait_for "grep -q waiting=sim '$Q/q7.ticket' 2>/dev/null"
"$XCQ" q8 plain -- /bin/sh -c "$(job P 1)" sh build >/dev/null
check "a build runs while a test waits for its simulator" "$(order)" "P "
XCQ_SESSION=s1 "$XCSIM" free $SU
wait $p2
check "the waiting test runs after" "$(order)" "P B "

sim_reset
echo "$SU" > "$SIMAPHORE_DIR/reserved"
XCQ_LABEL=alpha simjob q9 alpha s1 test A 1 >"$SIMAPHORE_DIR/out"; check "reserved simulator: exits 4" $? 4
check "reserved simulator: nothing ran" "$(order)" ""
check "reserved simulator: ticket removed" "$(ls "$Q")" ""

sim_reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
XCQ_SESSION=s2 "$XCQ" q10 beta -- /bin/sh -c "$(job B 30)" sh test -destination "$DEST" >/dev/null 2>&1 & p2=$!
wait_for "grep -q waiting=sim '$Q/q10.ticket' 2>/dev/null"
kill -TERM $p2; wait $p2 2>/dev/null
check "SIGTERM while waiting for a simulator removes the ticket" "$(ls "$Q")" ""
echo "== device ids are not gated"
sim_reset
XCQ_SESSION=s1 "$XCQ" d1 alpha -- /bin/sh -c "$(job A 1)" sh test -destination "platform=iOS,id=00008110-001234567890401E" >/dev/null
check "a device id runs with no lease" "$(order)/$(ls "$SIMAPHORE_DIR/leases" 2>/dev/null | wc -l | tr -d ' ')" "A /0"
XCQ_SESSION=s1 "$XCQ" d2 alpha -- /bin/sh -c "$(job A 1)" sh test -destination "platform=iOS Simulator,name=Test Phone" >/dev/null
check "a bare name runs with no lease" "$(ls "$SIMAPHORE_DIR/leases" 2>/dev/null | wc -l | tr -d ' ')" 0

echo "== lease folder not writable fails fast"
sim_reset
rm -rf "$SIMAPHORE_DIR/leases"; : > "$SIMAPHORE_DIR/leases"   # a file where the folder should be
out=$(XCQ_LABEL=alpha simjob e1 alpha s1 test A 1); rc=$?
check "exit 74 and nothing ran" "$rc/$(order)" "74/"
echo "$out" | grep -q "cannot write the lease folder" && ok "clear message" || bad "message: $out"
check "ticket removed" "$(ls "$Q")" ""

echo "== unreadable simulator list refuses"
sim_reset
touch "$FAKE_SIMCTL_JSON.fail"
out=$(XCQ_LABEL=alpha simjob e2 alpha s1 test A 1); rc=$?
check "exit 76 and nothing ran" "$rc/$(order)" "76/"
echo "$out" | grep -q "cannot read the simulator list" && ok "clear message" || bad "message: $out"
rm -f "$FAKE_SIMCTL_JSON.fail"

echo "== lost lease while queued: back to the sim gate"
sim_reset
"$XCQ" r0 blocker -- /bin/sh -c "$(job X 3)" >/dev/null & pb=$!
wait_for "grep -q state=running '$Q/r0.ticket' 2>/dev/null"
XCQ_LABEL=beta simjob r1 beta s2 test B 1 >"$SIMAPHORE_DIR/out" & p2=$!
wait_for "grep -q session=s2 '$SIMAPHORE_DIR/leases/$SU.lease' 2>/dev/null"
rm -f "$SIMAPHORE_DIR/leases/$SU.lease"   # the lease is taken from under the queued ticket
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
wait $pb
wait_for "grep -q waiting=sim '$Q/r1.ticket' 2>/dev/null"
grep -q waiting=sim "$Q/r1.ticket" && ok "ticket goes back to waiting=sim" || bad "ticket: $(cat "$Q/r1.ticket" 2>&1)"
sleep 1
check "did not start without the lease" "$(order | tr -d ' ')" "X"
XCQ_SESSION=s1 "$XCSIM" free $SU
wait $p2
check "starts after the lease is free" "$(order)" "X B "

echo "== room is checked again after the slot is won"
sim_reset
"$XCQ" r0 blocker -- /bin/sh -c "$(job X 3)" >/dev/null & pb=$!
wait_for "grep -q state=running '$Q/r0.ticket' 2>/dev/null"
XCQ_LABEL=alpha simjob r2 alpha s1 test A 1 >"$SIMAPHORE_DIR/out" & p1=$!
wait_for "grep -q session=s1 '$SIMAPHORE_DIR/leases/$SU.lease' 2>/dev/null"
sim_json Booted   # two other simulators come on while we wait
wait $pb
wait_for "grep -q waiting=room '$Q/r2.ticket' 2>/dev/null"
grep -q waiting=room "$Q/r2.ticket" && ok "ticket goes to waiting=room" || bad "ticket: $(cat "$Q/r2.ticket" 2>&1)"
sleep 1
check "did not start without room" "$(order | tr -d ' ')" "X"
sim_json Shutdown
wait $p1
check "starts once there is room" "$(order)" "X A "

echo "== room lock: only one ticket boots at a time"
sim_reset
mkdir -p "$SIMAPHORE_DIR/locks"
lockf -k "$SIMAPHORE_DIR/locks/room" sleep 3 & lp=$!
sleep 0.3
XCQ_LABEL=alpha simjob l1 alpha s1 test A 1 >"$SIMAPHORE_DIR/out" & p1=$!
sleep 1.5
check "waits while another ticket holds the room lock" "$(order)" ""
wait $p1
check "runs once the lock frees" "$(order)" "A "
wait $lp 2>/dev/null

echo "== ticket values lose newlines"
reset
XCQ_SESSION=$'s1\nstate=evil' XCQ_AGENT=$'a\rb' "$XCQ" n1 $'la\nbel=x' "sleep 2" >/dev/null & p1=$!
wait_for "grep -q state=running '$Q/n1.ticket' 2>/dev/null"
check "one state line" "$(grep -c '^state=' "$Q/n1.ticket")" 1
check "no extra label line" "$(grep -c '^bel=' "$Q/n1.ticket")" 0
check "no carriage return" "$(tr -cd '\r' < "$Q/n1.ticket" | wc -c | tr -d ' ')" 0
kill -TERM $p1; wait $p1 2>/dev/null

echo "== XCQ_FAKE_FILE is ignored without XCQ_TEST"
reset
echo 'XCQ_FAKE_PRESSURE=4' > "$SIMAPHORE_DIR/fake-mem"
env -u XCQ_TEST XCQ_FAKE_FILE="$SIMAPHORE_DIR/fake-mem" "$XCQ" f1 A "$(job A 1)" >/dev/null & p1=$!
wait_for "[ -n \"\$(order)\" ]"
check "ran (file not sourced)" "$(order)" "A "
wait $p1
XCQ_FAKE_FILE="$SIMAPHORE_DIR/fake-mem" "$XCQ" f2 B "$(job B 1)" >"$SIMAPHORE_DIR/out" 2>&1 & p2=$!
sleep 2
check "with XCQ_TEST the file is read (critical: B waits)" "$(order)" "A "
kill -TERM $p2; wait $p2 2>/dev/null

echo "== shim trusts XCQ_HELD only from a live xcq"
reset; make_fake
FAKE_SLEEP=0 XCQ_HELD=1 XCQ_HELD_BY=999999 "$SHIM" build >/dev/null
grep -q '^ARG=-jobs$' "$LOG.args" && ok "dead xcq pid: not trusted (queued, -jobs added)" || bad "trusted a dead pid"
FAKE_SLEEP=0 XCQ_HELD=1 "$SHIM" build >/dev/null
grep -q '^ARG=-jobs$' "$LOG.args" && ok "no XCQ_HELD_BY: not trusted" || bad "trusted a bare XCQ_HELD"

echo "== action words after value flags are not actions"
reset; make_fake
FAKE_SLEEP=0 "$SHIM" -exportArchive -archivePath archive -exportPath out >/dev/null
grep -q '^ARG=-jobs$' "$LOG.args" && bad "-exportArchive was queued" || ok "-exportArchive passes through"
check "no ticket left" "$(ls "$Q" 2>/dev/null)" ""
FAKE_SLEEP=0 "$SHIM" -scheme build >/dev/null
grep -q '^ARG=-jobs$' "$LOG.args" && bad "scheme named build was queued" || ok "a value that looks like an action is skipped"
FAKE_SLEEP=0 "$SHIM" -scheme test build >/dev/null
grep -q '^ARG=-jobs$' "$LOG.args" && ok "the real action after it still queues" || bad "real action missed"
reset
"$XCQ" k1 L 'echo xcodebuild -scheme test build' >/dev/null
check "xcq kind ignores the scheme name" "$(sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' "$SIMAPHORE_DIR/results/k1.json")" build
"$XCQ" k2 L 'echo xcodebuild -scheme x test' >/dev/null
check "xcq kind finds the action" "$(sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' "$SIMAPHORE_DIR/results/k2.json")" test

echo "== SIGTERM reaches a paused build"
reset
"$XCQ" s1 L "echo \$\$ > '$SIMAPHORE_DIR/childpid'; exec sleep 30" >/dev/null & p1=$!
wait_for "[ -s '$SIMAPHORE_DIR/childpid' ]"
cpid=$(cat "$SIMAPHORE_DIR/childpid")
"$PAUSE" pause "$cpid" >/dev/null; sleep 0.3
kill -TERM $p1; wait $p1 2>/dev/null
wait_for "! kill -0 $cpid 2>/dev/null"
kill -0 "$cpid" 2>/dev/null && { bad "paused child survived TERM"; kill -KILL "$cpid"; } || ok "paused child died on TERM"

echo "== resume-all checks file names"
reset; mkdir -p "$SIMAPHORE_DIR/paused"
touch "$SIMAPHORE_DIR/paused/1" "$SIMAPHORE_DIR/paused/abc" "$SIMAPHORE_DIR/paused/-1" "$SIMAPHORE_DIR/paused/0"
"$PAUSE" resume-all >/dev/null 2>"$SIMAPHORE_DIR/err"; check "exit 0" $? 0
check "no error output" "$(cat "$SIMAPHORE_DIR/err")" ""
check "all entries cleared" "$(ls "$SIMAPHORE_DIR/paused" | tr '\n' ' ')" ""

echo "== waiting wakes on changes (fake xcwatch)"
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
sim_reset
make_fake_xcwatch "$ST" 0 trigger
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
XCQ_LABEL=beta simjob w1 beta s2 test B 0 >/dev/null & p2=$!
wait_for "grep -q waiting=sim '$Q/w1.ticket' 2>/dev/null"
wait_for "[ -s '$ST/watch.log' ]"
check "sim wait passes the right flags and paths" "$(head -1 "$ST/watch.log")" \
  "wait --timeout 10 --memory --devices $Q $SIMAPHORE_DIR/queue-paused $SIMAPHORE_DIR/hold $SIMAPHORE_DIR/leases $SIMAPHORE_DIR/panels"
XCQ_SESSION=s1 "$XCSIM" free $SU
sleep 1.5
check "waiter sits in the helper, it does not poll" "$(order)" ""
t0=$(now_ms)
touch "$ST/wake"
wait_for "[ -s '$LOG' ]"
t1=$(now_ms)
wait $p2
[ $((t1 - t0)) -lt 1800 ] && ok "woken waiter takes the freed lease at once" || bad "pickup took $((t1 - t0)) ms"

sim_reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" claim $SU >/dev/null
make_fake_xcwatch "$ST" 69
XCQ_LABEL=beta simjob w2 beta s2 test B 0 >/dev/null & p2=$!
wait_for "grep -q waiting=sim '$Q/w2.ticket' 2>/dev/null"
sleep 2.5
check "exit 69: helper asked once, not every loop" "$(wc -l < "$ST/watch.log" | tr -d ' ')" 1
XCQ_SESSION=s1 "$XCSIM" free $SU
wait $p2; check "exit 69: waiter still starts by polling" "$(order)" "B "

reset
make_fake_xcwatch "$ST" 0 0.1
"$XCQ" w3 A "$(job A 2)" >/dev/null & p1=$!
wait_for "grep -q 'A start' '$LOG'"
"$XCQ" w4 B "$(job B 0)" >/dev/null & p2=$!
wait_for "grep -q state=waiting '$Q/w4.ticket' 2>/dev/null"
wait_for "[ -s '$ST/watch.log' ]"
check "queue wait passes the right flags and paths" "$(head -1 "$ST/watch.log")" \
  "wait --timeout 10 --memory --devices $Q $SIMAPHORE_DIR/queue-paused $SIMAPHORE_DIR/hold $SIMAPHORE_DIR/leases $SIMAPHORE_DIR/panels"
wait $p1 $p2
check "queue order unchanged with the helper" "$(order)" "A B "
unset XCQ_XCWATCH

unset XCSIM_SIMCTL FAKE_SIMCTL_JSON FAKE_SIMCTL_LOG

echo "== off: builds run side by side"
reset; sim_off
"$XCQ" t1 A "$(job A 2)" >/dev/null & p1=$!
sleep 0.5
"$XCQ" t2 B "$(job B 2)" >/dev/null & p2=$!
wait $p1 $p2
check "B starts before A ends" "$(awk '{printf "%s%s ",$1,$2}' "$LOG")" "Astart Bstart Aend Bend "

echo "== switched off while queued: the waiter starts"
reset
"$XCQ" t1 A "$(job A 6)" >/dev/null & p1=$!
sleep 0.5
"$XCQ" t2 B "$(job B 1)" > "$SIMAPHORE_DIR/out2" & p2=$!
wait_for "grep -q 'queued at position' '$SIMAPHORE_DIR/out2'"
sim_off
wait_for "grep -q '^B start' '$LOG'"
grep -q '^A end' "$LOG" && bad "B waited for A after off" || ok "B started while A still runs"
wait $p1 $p2


echo "== a build outside the queue takes room"
reset
PS_FILE=$SIMAPHORE_DIR/ps
printf ' 900 1 /usr/bin/xcodebuild -scheme X build\n 901 1 /usr/bin/xcodebuild -list\n' > "$PS_FILE"
XCQ_FAKE_PS=$PS_FILE "$XCQ" t1 A "$(job A 1)" > "$SIMAPHORE_DIR/out1" & p1=$!
wait_for "grep -q '1 outside the queue' '$SIMAPHORE_DIR/out1'" && ok "waits for the outside build" || bad "did not wait: $(cat "$SIMAPHORE_DIR/out1")"
check "nothing started yet" "$(order)" ""
: > "$PS_FILE"
wait_for "grep -q '^A start' '$LOG'" && ok "starts once the outside build ends" || bad "A never started"
wait $p1

echo "== a build under xcq is not outside"
reset
printf ' 800 1 /bin/bash /x/bin/xcq q1 Z -- /usr/bin/xcodebuild build\n 801 800 /usr/bin/xcodebuild -jobs 6 build\n' > "$PS_FILE"
XCQ_FAKE_PS=$PS_FILE "$XCQ" t1 A "$(job A 0)" >/dev/null
check "runs at once" "$(order)" "A "

finish
