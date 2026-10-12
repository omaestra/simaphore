#!/bin/bash
# Tests for bin/xcsim. Uses a fake simctl only: never touches a real simulator.
XCSIM="$(cd "$(dirname "$0")/.." && pwd)/bin/xcsim"
BASE=${TMPDIR:-/tmp}
mkdir -p "$BASE"
export SIMAPHORE_DIR=$(mktemp -d "$BASE/xcsim-test.XXXXXX")
T=$(mktemp -d "$BASE/xcsim-fake.XXXXXX")
trap 'rm -rf "$SIMAPHORE_DIR" "$T"; kill $(jobs -p) 2>/dev/null' EXIT
LEASES=$SIMAPHORE_DIR/leases
. "$(dirname "$0")/lib.sh"

U1=AAAAAAAA-0000-0000-0000-000000000001   # iPhone 17 Pro, iOS 26.3.1
U2=AAAAAAAA-0000-0000-0000-000000000002   # iPhone 17 Pro, iOS 18.2
U3=AAAAAAAA-0000-0000-0000-000000000003   # iPhone 17, booted
U4=AAAAAAAA-0000-0000-0000-000000000004   # iPhone Twin
U5=AAAAAAAA-0000-0000-0000-000000000005   # iPhone Twin (same OS)
U6=AAAAAAAA-0000-0000-0000-000000000006   # Owner Phone
U7=AAAAAAAA-0000-0000-0000-000000000007   # iPhone 16, booted
U8=AAAAAAAA-0000-0000-0000-000000000008   # "🔒 old · iPhone 15" left by a crash
U9=AAAAAAAA-0000-0000-0000-000000000009   # unavailable

# fixture: simctl list -j shape (only the fields xcsim reads)
cat > "$T/list.json" <<EOT
{ "runtimes": [
    {"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-3", "version": "26.3.1"},
    {"identifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-2", "version": "18.2"} ],
  "devices": {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      {"udid": "$U1", "name": "iPhone 17 Pro", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U3", "name": "iPhone 17", "state": "Booted", "isAvailable": true},
      {"udid": "$U4", "name": "iPhone Twin", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U5", "name": "iPhone Twin", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U6", "name": "Owner Phone", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U7", "name": "iPhone 16", "state": "Booted", "isAvailable": true},
      {"udid": "$U8", "name": "🔒 old · iPhone 15", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U9", "name": "Gone", "state": "Shutdown", "isAvailable": false} ],
    "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
      {"udid": "$U2", "name": "iPhone 17 Pro", "state": "Shutdown", "isAvailable": true} ] } }
EOT
make_fake_simctl "$T"
export XCSIM_POLL=0.3
unset XCQ_RESERVED_NAMES XCQ_RENAME_SIMS XCQ_MAX_SIMS XCQ_LABEL XCQ_SESSION XCQ_AGENT

reset() {
  rm -rf "${SIMAPHORE_DIR:?}"/*; mkdir -p "$SIMAPHORE_DIR/agents"; sim_on
  touch "$SIMAPHORE_DIR/agents/s1.json" "$SIMAPHORE_DIR/agents/s2.json"; : > "$T/log"
}
as1() { XCQ_SESSION=s1 XCQ_AGENT=${AG:-} XCQ_LABEL=${LBL:-alpha} "$XCSIM" "$@"; }
as2() { XCQ_SESSION=s2 XCQ_LABEL=beta "$XCSIM" "$@"; }

echo "== usage"
"$XCSIM" 2>/dev/null; check "no args exits 64" $? 64
"$XCSIM" bogus 2>/dev/null; check "unknown subcommand exits 64" $? 64
"$XCSIM" claim 2>/dev/null; check "claim without UDID exits 64" $? 64

echo "== resolve"
reset
check "id=" "$("$XCSIM" resolve "id=$U1")" "$U1"
check "plain UDID is upper-cased" "$("$XCSIM" resolve "$(echo $U1 | tr A-Z a-z)")" "$U1"
check "name + OS exact" "$("$XCSIM" resolve 'name=iPhone 17 Pro,OS=26.3.1')" "$U1"
"$XCSIM" resolve 'name=iPhone 17 Pro,OS=26.3' >/dev/null; check "OS must match exactly (26.3 vs 26.3.1 exits 2)" $? 2
check "OS 18.2 picks the older one" "$("$XCSIM" resolve 'name=iPhone 17 Pro,OS=18.2')" "$U2"
check "no OS picks newest runtime" "$("$XCSIM" resolve 'name=iPhone 17 Pro')" "$U1"
check "OS=latest picks newest runtime" "$("$XCSIM" resolve 'name=iPhone 17 Pro,OS=latest')" "$U1"
check "plain name" "$("$XCSIM" resolve 'iPhone 16')" "$U7"
check "full destination with id" "$("$XCSIM" resolve "platform=iOS Simulator,id=$U3,name=x")" "$U3"
check "full destination with name" "$("$XCSIM" resolve 'platform=iOS Simulator,name=iPhone 17 Pro,OS=18.2')" "$U2"
"$XCSIM" resolve 'name=Nope' >/dev/null; check "unknown name exits 2" $? 2
"$XCSIM" resolve 'name=iPhone 17 Pro,OS=99' >/dev/null; check "unknown OS exits 2" $? 2
"$XCSIM" resolve 'name=iPhone Twin' >/dev/null; check "same name and OS exits 3" $? 3
"$XCSIM" resolve 'name=Gone' >/dev/null; check "unavailable simulator is ignored" $? 2
check "locked name matches its original" "$("$XCSIM" resolve 'iPhone 15')" "$U8"
mkdir -p "$LEASES"; printf 'udid=%s\noriginalName=Hidden\n' "$U6" > "$LEASES/$U6.lease"
check "lease originalName matches" "$("$XCSIM" resolve 'Hidden')" "$U6"

echo "== claim"
reset
out=$(as1 claim $U1); check "free simulator is claimed" "$out/$?" "claimed/0"
l=$LEASES/$U1.lease
for kv in "udid=$U1" session=s1 agent=main label=alpha "originalName=iPhone 17 Pro"; do
  grep -qxF "$kv" "$l" && ok "lease has $kv" || bad "lease lacks $kv: $(cat "$l")"
done
grep -q '^claimedAt=[0-9]\{13\}$' "$l" && grep -q '^lastUsed=[0-9]\{13\}$' "$l" && ok "times are epoch ms" || bad "times: $(cat "$l")"
check "renamed with the lock" "$(cat "$T/log")" "rename $U1 🔒 alpha · iPhone 17 Pro"
check "no temp files left" "$(ls -A "$LEASES" | grep -c '^\.')" 0
out=$(as1 claim $U1); check "same holder gets mine" "$out/$?" "mine/0"
check "no second rename" "$(wc -l < "$T/log" | tr -d ' ')" 1
out=$(as2 claim $U1); check "other live holder gets its label, exit 1" "$out/$?" "alpha/1"
check "lease still belongs to s1" "$(sed -n 's/^session=//p' "$l")" s1
AG=sub as1 claim $U1 >/dev/null; check "same session, other agent is another holder" $? 1

echo "== claim: one simulator per holder"
reset
as1 claim $U1 >/dev/null; : > "$T/log"
out=$(as1 claim $U2); check "second claim works" "$out/$?" "claimed/0"
[ ! -e "$LEASES/$U1.lease" ] && ok "old lease freed" || bad "old lease kept"
grep -qxF "rename $U1 iPhone 17 Pro" "$T/log" && ok "old name restored" || bad "no restore: $(cat "$T/log")"

echo "== claim: stale holder"
reset
as1 claim $U1 >/dev/null
rm "$SIMAPHORE_DIR/agents/s1.json"   # s1 ended without freeing
out=$(as2 claim $U1); check "session without agents file counts as free" "$out/$?" "claimed/0"
check "lease is now s2's" "$(sed -n 's/^session=//p' "$LEASES/$U1.lease")" s2
check "original name kept through takeover" "$(sed -n 's/^originalName=//p' "$LEASES/$U1.lease")" "iPhone 17 Pro"

echo "== claim: crash left a locked name"
reset
as1 claim $U8 >/dev/null
check "original is the text after the first ' · '" "$(sed -n 's/^originalName=//p' "$LEASES/$U8.lease")" "iPhone 15"
check "renamed from the original" "$(cat "$T/log")" "rename $U8 🔒 alpha · iPhone 15"

echo "== claim: label and settings"
reset
LBL='fix · login' as1 claim $U1 >/dev/null
check "' · ' in label becomes ' - '" "$(cat "$T/log")" "rename $U1 🔒 fix - login · iPhone 17 Pro"
reset
XCQ_RENAME_SIMS=0 as1 claim $U1 >/dev/null
check "XCQ_RENAME_SIMS=0 skips rename" "$(cat "$T/log")" ""
[ -e "$LEASES/$U1.lease" ] && ok "lease still written" || bad "no lease"
XCQ_RENAME_SIMS=0 as1 free $U1; check "free without renaming" "$(cat "$T/log")" ""

echo "== claim: reserved"
reset
echo "$U1" > "$SIMAPHORE_DIR/reserved"
as1 claim $U1 >/dev/null; check "UDID in reserved file exits 4" $? 4
[ ! -e "$LEASES/$U1.lease" ] && ok "no lease for reserved" || bad "lease made for reserved"
XCQ_RESERVED_NAMES="Something, Owner Phone" as1 claim $U6 >/dev/null; check "name in XCQ_RESERVED_NAMES exits 4" $? 4
check "reserved never renamed" "$(cat "$T/log")" ""
XCQ_RESERVED_NAMES="Something" as1 claim $U7 >/dev/null; check "other names are fine" $? 0

echo "== touch"
reset
as1 claim $U1 >/dev/null
sed -i '' 's/^lastUsed=.*/lastUsed=1/' "$LEASES/$U1.lease"
as1 touch $U1; check "holder touch exits 0" $? 0
[ "$(sed -n 's/^lastUsed=//p' "$LEASES/$U1.lease")" -gt 1000000000000 ] && ok "lastUsed updated" || bad "lastUsed not updated"
XCQ_LABEL= as1 touch $U1; check "touch without XCQ_LABEL keeps the label" "$(sed -n 's/^label=//p' "$LEASES/$U1.lease")" alpha
check "other fields kept" "$(grep -c -E '^(session=s1|label=alpha|agent=main)$' "$LEASES/$U1.lease")" 3
sed -i '' 's/^lastUsed=.*/lastUsed=1/' "$LEASES/$U1.lease"
as2 touch $U1; check "non-holder touch exits 1" $? 1
check "non-holder touch changes nothing" "$(sed -n 's/^lastUsed=//p' "$LEASES/$U1.lease")" 1
as1 touch $U2; check "touch with no lease exits 1" $? 1

echo "== free"
reset
as1 claim $U1 >/dev/null; : > "$T/log"
as2 free $U1; check "other holder cannot free" $? 1
[ -e "$LEASES/$U1.lease" ] && ok "lease kept" || bad "lease removed by non-holder"
as1 free $U1; check "holder free exits 0" $? 0
[ ! -e "$LEASES/$U1.lease" ] && ok "lease removed" || bad "lease kept"
check "name restored" "$(cat "$T/log")" "rename $U1 iPhone 17 Pro"
as1 claim $U1 >/dev/null; : > "$T/log"
as2 free $U1 --force; check "--force frees someone else's" $? 0
[ ! -e "$LEASES/$U1.lease" ] && ok "forced lease removed" || bad "forced lease kept"
as1 free $U1; check "free with no lease exits 0" $? 0
check "only rename calls ever made" "$(grep -vc '^rename ' "$T/log")" 0

echo "== room"
reset
out=$("$XCSIM" room $U3); check "booted target always has room" "$out/$?" "/0"
out=$("$XCSIM" room $U1); check "2 booted, target off: no room, prints count" "$out/$?" "2/1"
out=$(XCQ_MAX_SIMS=3 "$XCSIM" room $U1); check "limit 3: room" "$out/$?" "/0"
out=$(XCQ_MAX_SIMS=1 "$XCSIM" room $U3); check "limit 1 but target is on: room" "$out/$?" "/0"

echo "== restore"
reset
"$XCSIM" restore; check "restore exits 0" $? 0
check "locked name with no lease is restored" "$(cat "$T/log")" "rename $U8 iPhone 15"
: > "$T/log"; mkdir -p "$LEASES"; printf 'udid=%s\n' "$U8" > "$LEASES/$U8.lease"
"$XCSIM" restore
check "locked name with a lease is left alone" "$(cat "$T/log")" ""
reset
XCQ_RENAME_SIMS=0 "$XCSIM" restore; check "restore with renaming off exits 0" $? 0
check "restore with renaming off renames nothing" "$(cat "$T/log")" ""

echo "== race: two claims on one simulator"
good=0
for i in 1 2 3 4 5 6; do
  reset
  as1 claim $U1 > "$T/r1" & p1=$!
  as2 claim $U1 > "$T/r2" & p2=$!
  wait $p1 $p2
  res=$(cat "$T/r1" "$T/r2" | sort | tr '\n' ' ')
  holder=$(sed -n 's/^session=//p' "$LEASES/$U1.lease")
  if { [ "$res" = "alpha claimed " ] && [ "$holder" = s1 ]; } || { [ "$res" = "beta claimed " ] && [ "$holder" = s2 ]; }
  then good=$((good+1)); else echo "round $i: '$res' holder=$holder"; fi
done
check "exactly one wins, lease matches the winner (6 rounds)" "$good" 6

echo "== race: stale takeover"
good=0
for i in 1 2 3 4; do
  reset
  as1 claim $U1 >/dev/null; rm "$SIMAPHORE_DIR/agents/s1.json"
  touch "$SIMAPHORE_DIR/agents/s3.json"
  XCQ_SESSION=s3 XCQ_LABEL=gamma "$XCSIM" claim $U1 > "$T/r1" & p1=$!
  as2 claim $U1 > "$T/r2" & p2=$!
  wait $p1 $p2
  [ "$(cat "$T/r1" "$T/r2" | grep -c '^claimed$')" = 1 ] && good=$((good+1))
done
check "one takeover winner (4 rounds)" "$good" 4

echo "== OS matching is exact (xcodebuild wants the full version)"
"$XCSIM" resolve 'name=iPhone 17 Pro,OS=26' >/dev/null; check "OS=26 does not match 26.3.1" $? 2
check "OS=26.3.1 matches" "$("$XCSIM" resolve 'name=iPhone 17 Pro,OS=26.3.1')" "$U1"

echo "== room counts Booting too"
reset
sed 's/"iPhone 16", "state": "Booted"/"iPhone 16", "state": "Booting"/' "$T/list.json" > "$T/list2.json"
out=$(FAKE_SIMCTL_JSON=$T/list2.json "$XCSIM" room $U1); check "Booted + Booting fill the room" "$out/$?" "2/1"
FAKE_SIMCTL_JSON=$T/list2.json "$XCSIM" on $U7; check "on: Booting counts" $? 0
"$XCSIM" on $U1; check "on: Shutdown does not" $? 1

echo "== claim keeps a lease that a live build is using"
reset; mkdir -p "$SIMAPHORE_DIR/queue"
as1 claim $U1 >/dev/null
sleep 30 & sp=$!
printf 'pid=%s\nsession=s1\nagent=\nstate=running\nsim=%s\n' $sp $U1 > "$SIMAPHORE_DIR/queue/t1.ticket"
as1 claim $U2 >/dev/null
[ -e "$LEASES/$U1.lease" ] && ok "first lease kept while its ticket is alive" || bad "lease freed under a running build"
kill $sp; wait $sp 2>/dev/null
as1 claim $U3 >/dev/null
[ ! -e "$LEASES/$U1.lease" ] && ok "freed once the ticket is dead" || bad "lease kept after ticket died"

echo "== free --force compares what it saw"
reset
as1 claim $U1 >/dev/null; used=$(sed -n 's/^lastUsed=//p' "$LEASES/$U1.lease")
as2 free $U1 --force s9; check "force with another session does nothing" $? 1
as2 free $U1 --force s1 main 12345; check "force with another lastUsed does nothing" $? 1
[ -e "$LEASES/$U1.lease" ] && ok "lease kept on mismatch" || bad "lease deleted on mismatch"
as2 free $U1 --force s1 main "$used"; check "force with matching values deletes" $? 0
[ ! -e "$LEASES/$U1.lease" ] && ok "lease removed on match" || bad "lease kept on match"

echo "== touch waits for the lease lock"
reset
as1 claim $U1 >/dev/null
sed -i '' 's/^lastUsed=.*/lastUsed=1/' "$LEASES/$U1.lease"
lockf -k "$SIMAPHORE_DIR/locks/$U1" sleep 2 & lp=$!
sleep 0.3
as1 touch $U1 & tp=$!
sleep 0.7
check "touch has not written while the lock is held" "$(sed -n 's/^lastUsed=//p' "$LEASES/$U1.lease")" 1
wait $tp
[ "$(sed -n 's/^lastUsed=//p' "$LEASES/$U1.lease")" -gt 1000000000000 ] && ok "touch wrote after the lock freed" || bad "touch never wrote"
wait $lp 2>/dev/null

echo "== claim refuses when the simulator list cannot be read"
reset
touch "$FAKE_SIMCTL_JSON.fail"
out=$(as1 claim $U1); check "simctl fails: exit 76" "$out/$?" "cannot read the simulator list/76"
[ ! -e "$LEASES/$U1.lease" ] && ok "no lease without a list" || bad "lease made without a list"
out=$("$XCSIM" room $U1); check "room says unknown, no room" "$out/$?" "?/1"
rm -f "$FAKE_SIMCTL_JSON.fail"
cp "$T/list.json" "$T/list.bak"; echo "not json" > "$T/list.json"
as1 claim $U1 >/dev/null; check "garbage list: exit 76" $? 76
cp "$T/list.bak" "$T/list.json"
as1 claim $U1 >/dev/null; check "works again once readable" $? 0

echo "== race: three claims on one simulator"
good=0
for i in 1 2 3 4 5 6; do
  reset; touch "$SIMAPHORE_DIR/agents/s3.json"
  as1 claim $U1 > "$T/r1" & p1=$!
  as2 claim $U1 > "$T/r2" & p2=$!
  XCQ_SESSION=s3 XCQ_LABEL=gamma "$XCSIM" claim $U1 > "$T/r3" & p3=$!
  wait $p1 $p2 $p3
  [ "$(cat "$T/r1" "$T/r2" "$T/r3" | grep -c '^claimed$')" = 1 ] && good=$((good+1))
done
check "exactly one of three wins (6 rounds)" "$good" 6
good=0
for i in 1 2 3 4; do
  reset; touch "$SIMAPHORE_DIR/agents/s3.json" "$SIMAPHORE_DIR/agents/s4.json"
  as1 claim $U1 >/dev/null; rm "$SIMAPHORE_DIR/agents/s1.json"
  as2 claim $U1 > "$T/r1" & p1=$!
  XCQ_SESSION=s3 XCQ_LABEL=gamma "$XCSIM" claim $U1 > "$T/r2" & p2=$!
  XCQ_SESSION=s4 XCQ_LABEL=delta "$XCSIM" claim $U1 > "$T/r3" & p3=$!
  wait $p1 $p2 $p3
  [ "$(cat "$T/r1" "$T/r2" "$T/r3" | grep -c '^claimed$')" = 1 ] && good=$((good+1))
done
check "one of three takes over a stale lease (4 rounds)" "$good" 4

echo "== run"
reset
export XCQ_MAX_SIMS=3   # two sims are booted in the fixture
out=$(as1 run $U1 -- /bin/sh -c 'exit 7'); rc=$?
check "exit code passed through" "$rc" 7
[ -e "$LEASES/$U1.lease" ] && ok "run holds the lease (sticky)" || bad "no lease after run"
out=$(as1 run $U1 -- /bin/echo "two  words" 'x y'); check "argv kept exact" "$out" "two  words x y"
out=$(as1 run $U1 'echo $((1+2))'); check "command-string form" "$out" 3
sed -i '' 's/^lastUsed=.*/lastUsed=1/' "$LEASES/$U1.lease"
as1 run $U1 -- true >/dev/null
[ "$(sed -n 's/^lastUsed=//p' "$LEASES/$U1.lease")" -gt 1000000000000 ] && ok "touched at the end" || bad "not touched"
echo "$U6" >> "$SIMAPHORE_DIR/reserved"
as1 run $U6 -- true >/dev/null; check "reserved: run exits 4" $? 4

unset XCQ_MAX_SIMS
echo "== run: waits for the holder"
reset
as1 claim $U1 >/dev/null
XCQ_MAX_SIMS=3 as2 run $U1 -- /bin/sh -c 'echo ran' > "$T/out" & p2=$!
wait_for "grep -q 'simulator held by alpha' '$T/out'"
grep -qx 'xcsim: simulator held by alpha' "$T/out" && ok "held message printed" || bad "no held message: $(cat "$T/out")"
sleep 1
check "message printed once" "$(grep -c held "$T/out")" 1
grep -q '^ran$' "$T/out" && bad "ran while held" || ok "did not run while held"
as1 free $U1
wait $p2; check "runs after the holder frees" "$(grep -c '^ran$' "$T/out")" 1
check "free line printed once after the wait" "$(grep -cx 'xcsim: simulator free, running' "$T/out")" 1
check "waiter now holds it" "$(sed -n 's/^session=//p' "$LEASES/$U1.lease")" s2

echo "== run: waits for room"
reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" run $U1 -- /bin/sh -c 'echo ran' > "$T/out" & p1=$!
wait_for "grep -q 'waiting for room' '$T/out'"
grep -qx 'xcsim: 2 simulators on, waiting for room' "$T/out" && ok "room message printed" || bad "no room message: $(cat "$T/out")"
grep -q '^ran$' "$T/out" && bad "ran without room" || ok "did not run without room"
kill -TERM $p1; wait $p1 2>/dev/null
XCQ_MAX_SIMS=3 as1 run $U1 -- /bin/sh -c 'echo ran' > "$T/out"; check "runs once there is room" "$(grep -c '^ran$' "$T/out")" 1
grep -q 'simulator free' "$T/out" && bad "free line without a wait" || ok "no wait: no free line"

echo "== wait"
reset
export XCQ_MAX_SIMS=3
out=$(as1 wait $U1); check "free + room: wait exits 0 silently" "$out/$?" "/0"
[ -e "$LEASES/$U1.lease" ] && ok "wait claimed it" || bad "wait did not claim"
echo "$U6" > "$SIMAPHORE_DIR/reserved"
out=$(as1 wait $U6); check "reserved: wait exits 4" "$?" 4
as2 wait $U1 > "$T/out" & p2=$!
wait_for "grep -q 'simulator held by alpha' '$T/out'"
grep -qx 'xcsim: simulator held by alpha' "$T/out" && ok "wait prints the held message" || bad "no held message: $(cat "$T/out")"
as1 free $U1
wait $p2; check "wait returns 0 after the holder frees" $? 0
unset XCQ_MAX_SIMS
reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" wait $U1 > "$T/out" & p1=$!
wait_for "grep -q 'waiting for room' '$T/out'"
grep -qx 'xcsim: 2 simulators on, waiting for room' "$T/out" && ok "wait prints the room message" || bad "no room message: $(cat "$T/out")"
kill -TERM $p1; wait $p1 2>/dev/null
"$XCSIM" wait 2>/dev/null; check "wait without UDID exits 64" $? 64

echo "== off: wait gives up at once"
reset
XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" wait $U1 > "$T/out" & p1=$!
wait_for "grep -q 'waiting for room' '$T/out'"
sim_off
wait_for "! kill -0 $p1 2>/dev/null" && ok "switched off: the waiting call goes ahead" || { bad "still waiting after off"; kill -TERM $p1; }
wait $p1; check "and exits 0" $? 0
reset; echo 999999 > "$SIMAPHORE_DIR/panels/test"   # the pane's session is gone
as1 claim $U1 >/dev/null
out=$(as2 wait $U1); check "a dead session's pane is off: held sim does not block" "$?" 0

echo "== bad simulator IDs"
reset
for bad_id in garbage "" ../evil "${U1}x"; do
  for verb in claim touch free room wait run; do
    err=$("$XCSIM" $verb "$bad_id" 2>&1 >/dev/null); rc=$?
    check "$verb '$bad_id' exits 64" $rc 64
    check "$verb '$bad_id' says why" "$err" "xcsim: not a simulator ID: $bad_id"
  done
done
check "no lease file for a bad ID" "$(ls -A "$LEASES" 2>/dev/null)" ""
lower=$(echo "$U1" | tr 'A-Z' 'a-z')
as1 claim "$lower" >/dev/null; check "lower-case UDID is accepted" $? 0
reset; : > "$SIMAPHORE_DIR/leases"   # a file where the folder should be
err=$("$XCSIM" claim $U1 2>&1 >/dev/null); rc=$?
check "unwritable lease folder: one xcsim line" "$err" "xcsim: cannot write lease folder $LEASES"
check "unwritable lease folder: exit 74" $rc 74

echo "== run: SIGTERM kills the command"
reset
XCQ_MAX_SIMS=3 XCQ_SESSION=s1 XCQ_LABEL=alpha "$XCSIM" run $U1 -- /bin/sh -c "echo \$\$ > '$T/childpid'; exec sleep 30" >/dev/null & p1=$!
wait_for "[ -s '$T/childpid' ]"
cpid=$(cat "$T/childpid")
kill -TERM $p1; wait $p1 2>/dev/null
sleep 0.5
kill -0 "$cpid" 2>/dev/null && { bad "child still alive"; kill "$cpid"; } || ok "SIGTERM killed the command"

echo "== wait: wake on a change"
export XCQ_MAX_SIMS=3   # two sims are booted in the fixture
reset
make_fake_xcwatch "$T" 0
as1 claim $U1 >/dev/null
XCSIM_POLL=5 as2 wait $U1 > "$T/out" & p2=$!
wait_for "[ -s '$T/watch.log' ]"
check "wait passes the right flags and paths" "$(head -1 "$T/watch.log")" "wait --timeout 10 --devices $LEASES"
as1 free $U1
t0=$(date +%s)
wait $p2; check "woken wait claims the freed simulator" $? 0
[ $(( $(date +%s) - t0 )) -lt 3 ] && ok "woken wait re-checks well before the 5 s fallback" || bad "woken wait was slow"

echo "== wait: helper not built falls back to sleeping"
reset
make_fake_xcwatch "$T" 69
as1 claim $U1 >/dev/null
XCSIM_POLL=0.2 as2 wait $U1 > "$T/out" & p2=$!
wait_for "grep -q 'simulator held by alpha' '$T/out'"
sleep 1
as1 free $U1
wait $p2; check "exit 69 still waits and claims" $? 0
check "exit 69: helper asked only once" "$(wc -l < "$T/watch.log" | tr -d ' ')" 1
reset
: > "$T/watch.log"
as1 claim $U1 >/dev/null
XCQ_NO_WATCH=1 XCSIM_POLL=0.2 as2 wait $U1 >/dev/null & p2=$!
sleep 1; as1 free $U1
wait $p2; check "XCQ_NO_WATCH=1 never calls the helper" "$(wc -l < "$T/watch.log" | tr -d ' ')" 0
unset XCQ_XCWATCH XCQ_MAX_SIMS

finish
