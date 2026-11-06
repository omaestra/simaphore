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

echo "== adb, emulator, android stand-ins"
# Fake real tools log their args. The fake adb names emulator-5554 as Pixel_9 (with \r and an OK line).
cat > "$T/adb" <<'EOT'
#!/bin/bash
[ "$*" = "-s emulator-5554 emu avd name" ] && { [ -e "$T/avd.junk" ] && echo "no such thing here!" || printf 'Pixel_9\r\nOK\r\n'; exit 0; }
echo "adb $*" >> "$T/real.log"
EOT
for n in emulator android; do printf '#!/bin/bash\necho "%s $*" >> "$T/real.log"\n' $n > "$T/$n"; done
chmod +x "$T/adb" "$T/emulator" "$T/android"
export XCQ_REAL_ADB=$T/adb XCQ_REAL_EMULATOR=$T/emulator XCQ_REAL_ANDROID=$T/android
P9="100 1 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_9 -no-snapshot"
P8="101 1 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 @Pixel_8"
printf '%s\n' "$P9" > "$T/ps1"; printf '%s\n%s\n' "$P9" "$P8" > "$T/ps2"
rl() { grep -c "^$1" "$T/real.log"; }
leased() { [ -e "$SIMAPHORE_DIR/leases/@$1.lease" ] && echo yes; }

reset; export XCQ_FAKE_PS=$T/ps1
sim_off
as1 "$SH/adb" -s emulator-5554 shell ls; check "adb off: exit 0" $? 0
check "adb off: ran" "$(rl 'adb -s emulator-5554 shell ls$')" 1
check "adb off: no lease" "$(leased Pixel_9)" ""
sim_on
XCQ_MAX_SIMS=3 "$SH/adb" -s emulator-5554 shell; check "adb no session: exit 0" $? 0
check "adb no session: no lease" "$(leased Pixel_9)" ""; : > "$T/real.log"
as1 "$SH/adb" devices; check "adb devices runs" "$(rl 'adb devices')" 1
as1 "$SH/adb"; check "adb bare runs" $? 0
as1 "$SH/adb" -s emulator-5554 shell; check "adb free emulator: exit 0" $? 0
check "adb free emulator: ran" "$(rl 'adb -s emulator-5554 shell$')" 1
check "adb free emulator: claimed" "$(sed -n 's/^session=//p' "$SIMAPHORE_DIR/leases/@Pixel_9.lease")" s1
as1 "$SH/adb" -semulator-5554 logcat; check "adb glued -sS runs" "$(rl 'adb -semulator-5554 logcat')" 1
msg=$(as2 "$SH/adb" -s emulator-5554 shell 2>&1 >/dev/null); rc=$?
check "adb held: exit 75" $rc 75
case $msg in "simaphore: "*held*alpha*) ok "adb held: names holder" ;; *) bad "adb held: names holder ($msg)" ;; esac
check "adb held: one line" "$(printf '%s\n' "$msg" | wc -l | tr -d ' ')" 1
check "adb held: not run" "$(rl 'adb -s emulator-5554 shell$')" 1
as2 "$SH/adb" -s emulator-5554 devices >/dev/null; check "adb host verb on held: runs" $? 0
as2 "$SH/adb" -s PHONE123 shell; check "adb phone serial: runs" $? 0
as2 "$SH/adb" -d shell; check "adb -d: runs" $? 0
ANDROID_SERIAL=emulator-5554 as2 "$SH/adb" shell 2>/dev/null; check "adb ANDROID_SERIAL guarded" $? 75
as2 "$SH/adb" shell 2>/dev/null; check "adb no flag, one emulator: guarded" $? 75
as2 "$SH/adb" -e shell 2>/dev/null; check "adb -e, one emulator: guarded" $? 75
XCQ_FAKE_PS=$T/ps2 as2 "$SH/adb" shell; check "adb no flag, two emulators: runs" $? 0
touch "$T/avd.junk"
as2 "$SH/adb" -s emulator-5554 shell; check "adb junk avd name: runs" $? 0
rm -f "$T/avd.junk"

reset
echo @Pixel_9 > "$SIMAPHORE_DIR/reserved"
msg=$(as1 "$SH/adb" -s emulator-5554 shell 2>&1); rc=$?
check "adb reserved: exit 75" $rc 75
case $msg in "simaphore: "*reserved*) ok "adb reserved: message" ;; *) bad "adb reserved: message ($msg)" ;; esac
reset; XCQ_RESERVED_NAMES=Pixel_9 as1 "$SH/adb" -s emulator-5554 shell 2>/dev/null; check "adb reserved by name" $? 75
reset; as1 "$SH/adb" -s emulator-5554 shell 2>/dev/null
as2 "$SH/adb" -s emulator-5554 shell 2>/dev/null; as1 "$SH/adb" -s PHONE123 shell
check "adb phone serial: no new lease" "$(ls "$SIMAPHORE_DIR/leases" | wc -l | tr -d ' ')" 1

echo "== adb fleet verbs"
reset
msg=$(as2 "$SH/adb" kill-server 2>&1); rc=$?
check "kill-server, nobody holds: runs" $rc 0
as1 "$SH/adb" -s emulator-5554 shell
msg=$(as2 "$SH/adb" kill-server 2>&1 >/dev/null); rc=$?
check "kill-server, other holds: exit 75" $rc 75
case $msg in "simaphore: "*alpha*) ok "kill-server: names holder" ;; *) bad "kill-server: names holder ($msg)" ;; esac
as2 "$SH/adb" -s PHONE reconnect 2>/dev/null; check "reconnect with -s: exit 75" $? 75
as1 "$SH/adb" kill-server; check "kill-server, own lease: runs" $? 0
rm "$SIMAPHORE_DIR/agents/s1.json"
as2 "$SH/adb" kill-server; check "kill-server, dead holder: runs" $? 0

echo "== emulator boot"
reset; export XCQ_FAKE_PS=/dev/null
as1 "$SH/emulator" -avd Pixel_9 -no-window; check "emulator boot: exit 0" $? 0
check "emulator boot: ran" "$(rl 'emulator -avd Pixel_9')" 1
check "emulator boot: claimed" "$(leased Pixel_9)" yes
as2 "$SH/emulator" @Pixel_9 2>/dev/null; check "emulator @X held: exit 75" $? 75
as2 "$SH/emulator" -list-avds; check "emulator -list-avds runs" "$(rl 'emulator -list-avds')" 1
as2 "$SH/emulator" -avd Pixel_9 -version; check "emulator -version runs" "$(rl 'emulator -avd Pixel_9 -version')" 1
reset
msg=$(XCQ_FAKE_PS=$T/ps2 XCQ_MAX_SIMS=2 as1 "$SH/emulator" -avd Pixel_7 2>&1 >/dev/null); rc=$?
check "emulator no room: exit 75" $rc 75
case $msg in "simaphore: "*" devices already on, the limit is 2") ok "emulator no room: message" ;; *) bad "emulator no room: message ($msg)" ;; esac
check "emulator no room: no lease" "$(leased Pixel_7)" ""

echo "== android"
reset; export XCQ_FAKE_PS=/dev/null
as1 "$SH/android" emulator start Pixel_9; check "android emulator start: exit 0" $? 0
check "android emulator start: claimed" "$(leased Pixel_9)" yes
as2 "$SH/android" emulator start Pixel_9 2>/dev/null; check "android emulator start held: 75" $? 75
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" screen --device=emulator-5554 2>/dev/null; check "android screen --device held: 75" $? 75
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" run --device emulator-5554 2>/dev/null; check "android run --device X held: 75" $? 75
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" emulator stop 2>/dev/null; check "android emulator stop (default) held: 75" $? 75
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" screen --device=PHONE; check "android screen phone: runs" $? 0
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" --help; check "android --help runs" $? 0
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" screen -h; check "android screen -h runs" $? 0
XCQ_FAKE_PS=$T/ps1 as2 "$SH/android" sdk list; check "android sdk list runs" $? 0
XCQ_FAKE_PS=/dev/null as2 "$SH/android" screen --device=emulator-5554; check "android device op, AVD not on: runs" $? 0

echo "== real_tool"
(
  unset XCQ_REAL_ADB XCQ_REAL_EMULATOR XCQ_REAL_ANDROID
  mkdir -p "$T/other" "$T/sdk/platform-tools" "$T/sdk/emulator" "$T/empty"
  printf '#!/bin/bash\n' > "$T/other/adb"; chmod +x "$T/other/adb"
  cp "$T/other/adb" "$T/sdk/platform-tools/adb"; cp "$T/other/adb" "$T/sdk/emulator/emulator"
  ln -sfn "$SH" "$T/shimlink"
  BIN=$(cd "$SH" && pwd -P)
  . "$ROOT/bin/lib.sh"
  export HOME=$T/nohome
  check "real_tool skips the stand-ins folder" "$(PATH=$SH:$T/shimlink:$T/other:/usr/bin:/bin real_tool adb)" "$T/other/adb"
  mkdir -p "$T/copy/shim"; : > "$T/copy/lib.sh"; : > "$T/copy/xcsim"; cp "$T/other/adb" "$T/copy/shim/adb"
  check "real_tool skips another simaphore copy" "$(PATH=$SH:$T/copy/shim:$T/other:/usr/bin:/bin real_tool adb)" "$T/other/adb"
  PATH=$SH:$T/empty:/usr/bin:/bin real_tool adb >/dev/null; check "real_tool none: returns 1" $? 1
  check "real_tool SDK adb" "$(PATH=$SH:/usr/bin:/bin ANDROID_HOME=$T/sdk real_tool adb)" "$T/sdk/platform-tools/adb"
  check "real_tool SDK emulator" "$(PATH=$SH:/usr/bin:/bin ANDROID_SDK_ROOT=$T/sdk real_tool emulator)" "$T/sdk/emulator/emulator"
  PATH=$SH:/usr/bin:/bin ANDROID_HOME=$T/sdk real_tool android >/dev/null; check "real_tool android: no SDK fallback" $? 1
  check "real_tool XCQ_REAL_ wins" "$(XCQ_REAL_ADB=/x/adb PATH=$T/other:/usr/bin:/bin real_tool adb)" /x/adb
  exit $fails
) ; fails=$((fails + $?))
msg=$(env -u XCQ_REAL_ADB PATH="$SH:/usr/bin:/bin" HOME=$T/nohome ANDROID_HOME= "$SH/adb" devices 2>&1); rc=$?
check "stand-in finds no tool: exit 127" $rc 127
case $msg in "adb: command not found") ok "stand-in finds no tool: message" ;; *) bad "stand-in finds no tool: message ($msg)" ;; esac

finish
