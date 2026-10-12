#!/bin/bash
# Tests for bin/shim/xcrun and bin/shim/simctl. Fakes only: never touches a real simulator.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SH=$ROOT/bin/shim
BASE=${TMPDIR:-/tmp}
mkdir -p "$BASE"
export SIMAPHORE_DIR=$(mktemp -d "$BASE/shim-test.XXXXXX")
T=$(mktemp -d "$BASE/shim-fake.XXXXXX")
trap 'rm -rf "$SIMAPHORE_DIR" "$T"; kill $(jobs -p) 2>/dev/null' EXIT
. "$(dirname "$0")/lib.sh"
export XCQ_FAKE_PS=/dev/null   # real builds on this Mac must not take room in the tests

U1=AAAAAAAA-0000-0000-0000-000000000001   # iPhone 17 Pro, free
U2=AAAAAAAA-0000-0000-0000-000000000002   # Owner Phone
U3=AAAAAAAA-0000-0000-0000-000000000003   # iPhone 17, booted
U4=AAAAAAAA-0000-0000-0000-000000000004   # iPhone 16, booted
cat > "$T/list.json" <<EOT
{ "runtimes": [ {"identifier": "rt", "version": "26.3.1"} ],
  "devices": { "rt": [
      {"udid": "$U1", "name": "iPhone 17 Pro", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U2", "name": "Owner Phone", "state": "Shutdown", "isAvailable": true},
      {"udid": "$U3", "name": "iPhone 17", "state": "Booted", "isAvailable": true},
      {"udid": "$U4", "name": "iPhone 16", "state": "Booted", "isAvailable": true} ] } }
EOT
make_fake_simctl "$T"
unset XCSIM_SIMCTL   # the shims must pick the real tool themselves
# A fake real xcrun: logs every call; `simctl list` serves the fixture (the lease code reads it).
cat > "$T/xcrun" <<'EOT'
#!/bin/bash
echo "xcrun $*" >> "$T/real.log"
[ "$1 $2" = "simctl list" ] && { [ -e "$T/list.json.fail" ] && exit 1; cat "$T/list.json"; exit 0; }
exit 0
EOT
chmod +x "$T/xcrun"
cat > "$T/xcodebuild" <<'EOT'
#!/bin/bash
echo "xcodebuild $*" >> "$T/real.log"
EOT
chmod +x "$T/xcodebuild"
export T XCQ_REAL_XCRUN=$T/xcrun XCQ_REAL_XCODEBUILD=$T/xcodebuild
unset XCQ_RESERVED_NAMES XCQ_RENAME_SIMS XCQ_MAX_SIMS XCQ_LABEL XCQ_SESSION XCQ_AGENT XCQ_HELD XCQ_HELD_BY

reset() {
  rm -rf "${SIMAPHORE_DIR:?}"/*; mkdir -p "$SIMAPHORE_DIR/agents"; sim_on
  touch "$SIMAPHORE_DIR/agents/s1.json" "$SIMAPHORE_DIR/agents/s2.json"; : > "$T/real.log"
}
# as1 / as2: run a stand-in as session s1 / s2 (room for 3 simulators unless a test says otherwise).
as1() { XCQ_SESSION=s1 XCQ_LABEL=alpha XCQ_RENAME_SIMS=0 XCQ_MAX_SIMS=${XCQ_MAX_SIMS:-3} "$@"; }
as2() { XCQ_SESSION=s2 XCQ_LABEL=beta XCQ_RENAME_SIMS=0 XCQ_MAX_SIMS=${XCQ_MAX_SIMS:-3} "$@"; }
ran() { grep -c "^xcrun simctl $1" "$T/real.log"; }

echo "== pass-through"
reset
as1 "$SH/xcrun" --version; check "non-simctl runs real tool" "$(grep -c '^xcrun --version' "$T/real.log")" 1
as1 "$SH/xcrun" simctl list >/dev/null; check "list is not a claim verb" $? 0
check "list ran for real" "$(ran list)" 1
as1 "$SH/xcrun" simctl help; check "help passes" "$(ran help)" 1
as1 "$SH/xcrun" simctl boot booted; check "booted passes through" "$(ran 'boot booted')" 1
as1 "$SH/xcrun" simctl shutdown all; check "all passes through" "$(ran 'shutdown all')" 1
as1 "$SH/xcrun" simctl boot; check "no device passes through" "$(ran 'boot$')" 1
"$SH/xcrun" simctl boot "$U1"; check "no XCQ_SESSION: runs" "$(ran "boot $U1")" 1
check "no XCQ_SESSION: no lease" "$(ls "$SIMAPHORE_DIR/leases" 2>/dev/null | wc -l | tr -d ' ')" 0
as1 "$SH/xcrun" simctl boot nonsense; check "no match: simctl decides" "$(ran 'boot nonsense')" 1

echo "== xcodebuild"
reset
as1 "$SH/xcrun" xcodebuild -version; check "xcrun xcodebuild -version exit" $? 0
check "went to the xcodebuild stand-in, real xcodebuild ran" "$(grep -c '^xcodebuild -version' "$T/real.log")" 1
check "no queue entry" "$(ls "$SIMAPHORE_DIR/queue" 2>/dev/null | wc -l | tr -d ' ')" 0

echo "== free simulator"
reset
as1 "$SH/xcrun" simctl install --foo "$U1" /tmp/a.app; check "free: exit 0" $? 0
check "free: real tool ran with all args" "$(ran "install --foo $U1 /tmp/a.app")" 1
check "free: claimed" "$(grep -c '^session=s1' "$SIMAPHORE_DIR/leases/$U1.lease")" 1
as1 "$SH/xcrun" simctl launch "iPhone 17 Pro" com.x; check "by name, ours again" $? 0
check "no loop: real xcrun never asked to rename" "$(ran rename)" 0

echo "== held by another session"
reset
as2 "$ROOT/bin/xcsim" claim "$U1" >/dev/null
msg=$(as1 "$SH/xcrun" simctl boot "$U1" 2>&1 >/dev/null); rc=$?
check "held: exit 75" $rc 75
case $msg in *held*beta*) ok "held: message names holder" ;; *) bad "held: message names holder ($msg)" ;; esac
check "held: real tool not run" "$(ran boot)" 0
msg=$(as1 "$SH/xcrun" simctl boot "iPhone 17 Pro" 2>&1); check "held, by name: exit 75" $? 75

echo "== reserved"
reset
msg=$(XCQ_RESERVED_NAMES="Owner Phone" as1 "$SH/xcrun" simctl erase "Owner Phone" 2>&1 >/dev/null); rc=$?
check "reserved: exit 75" $rc 75
case $msg in *reserved*) ok "reserved: message" ;; *) bad "reserved: message ($msg)" ;; esac
check "reserved: real tool not run" "$(ran erase)" 0

echo "== boot room"
reset
msg=$(XCQ_MAX_SIMS=2 as1 "$SH/xcrun" simctl boot "$U1" 2>&1 >/dev/null); rc=$?
check "no room: exit 75" $rc 75
case $msg in *"2 simulators already on"*"limit is 2"*) ok "no room: message" ;; *) bad "no room: message ($msg)" ;; esac
check "no room: real boot not run" "$(ran boot)" 0
as1 "$ROOT/bin/xcsim" claim "$U3" >/dev/null
XCQ_MAX_SIMS=2 as1 "$SH/xcrun" simctl boot "$U1" 2>/dev/null
check "no room: refused boot keeps our other lease" "$([ -e "$SIMAPHORE_DIR/leases/$U3.lease" ] && echo yes)" yes
check "no room: refused boot takes no lease" "$([ -e "$SIMAPHORE_DIR/leases/$U1.lease" ] && echo yes)" ""
XCQ_MAX_SIMS=2 as1 "$SH/xcrun" simctl install "$U1" a.app; check "room only matters for boot" $? 0
XCQ_MAX_SIMS=3 as1 "$SH/xcrun" simctl boot "$U1"; check "room: boots" "$(ran boot)" 1

echo "== list failure"
reset
touch "$T/list.json.fail"
as1 "$SH/xcrun" simctl boot "$U1"; check "list unreadable: runs anyway" "$(ran boot)" 1
rm -f "$T/list.json.fail"

echo "== queued build"
reset
as2 "$ROOT/bin/xcsim" claim "$U1" >/dev/null
XCQ_HELD=1 XCQ_HELD_BY=$$ as1 "$SH/xcrun" simctl boot "$U1"; check "XCQ_HELD by a non-xcq pid: still guarded" "$(ran boot)" 0

echo "== bare simctl"
reset
as1 "$SH/simctl" install "$U2" a.app; check "bare simctl: free runs" "$(ran "install $U2")" 1
as2 "$ROOT/bin/xcsim" claim "$U1" >/dev/null
as1 "$SH/simctl" boot "$U1" 2>/dev/null; check "bare simctl: held exit 75" $? 75
check "bare simctl: held, not run" "$(ran "boot $U1")" 0
reset; as1 "$SH/simctl" list >/dev/null; check "bare simctl: list passes" "$(ran list)" 1

echo "== off: nothing is held back"
reset
as2 "$ROOT/bin/xcsim" claim "$U1" >/dev/null
sim_off
as1 "$SH/simctl" boot "$U1" 2>/dev/null; check "off: held sim boots" $? 0
check "off: real tool ran" "$(ran "boot $U1")" 1
check "off: lease untouched" "$(sed -n 's/^session=//p' "$SIMAPHORE_DIR/leases/$U1.lease")" s2
as1 "$SH/xcodebuild" -scheme X build; check "off: build ran" "$(grep -c '^xcodebuild -scheme X build' "$T/real.log")" 1
check "off: no -jobs added" "$(grep -c -- '-jobs' "$T/real.log")" 0
check "off: no queue entry" "$(ls "$SIMAPHORE_DIR/queue" 2>/dev/null | wc -l | tr -d ' ')" 0

finish
