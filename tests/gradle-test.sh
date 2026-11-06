#!/bin/bash
# Tests for bin/xcgradle. Uses a stand-in gradlew only, never Gradle.
XG="$(cd "$(dirname "$0")/.." && pwd)/bin/xcgradle"
BASE=${TMPDIR:-/tmp}
mkdir -p "$BASE"
export SIMAPHORE_DIR=$(mktemp -d "$BASE/gradle-test.XXXXXX")
trap 'rm -rf "$SIMAPHORE_DIR"; kill $(jobs -p) 2>/dev/null' EXIT
Q=$SIMAPHORE_DIR/queue R=$SIMAPHORE_DIR/results
export XCQ_FAKE_PRESSURE=1 XCQ_FAKE_SWAP_PCT=0 XCQ_MAX_BUILDS=1 XCQ_FAKE_PS=/dev/null
. "$(dirname "$0")/lib.sh"
unset XCQ_HELD XCQ_HELD_BY XCQ_KIND XCQ_JOBS XCQ_SIM ANDROID_SERIAL
PROJ=$SIMAPHORE_DIR/proj GLOG=$SIMAPHORE_DIR/gradle.log   # the log lives outside the project
ELOG=$SIMAPHORE_DIR/env.log
mkdir -p "$PROJ/app"
printf '#!/bin/bash\necho "$*" >> "%s"\necho "serial=$ANDROID_SERIAL sim=${XCQ_SIM-unset} kind=${XCQ_KIND-unset}" >> "'"$ELOG"'"\n[ -n "$FAKE_GRADLE_SLEEP" ] && sleep "$FAKE_GRADLE_SLEEP"\nexit ${FAKE_GRADLE_EXIT:-0}\n' "$GLOG" > "$PROJ/gradlew"
chmod +x "$PROJ/gradlew"
mkdir -p "$SIMAPHORE_DIR/tools"; cp "$PROJ/gradlew" "$SIMAPHORE_DIR/tools/android"   # stand-in android CLI
listing() { (cd "$PROJ" && find . | sort); }
before=$(listing)
run() { (cd "$PROJ" && "$XG" ./gradlew "$@" >/dev/null); }
last_log() { tail -1 "$GLOG"; }
kind() { sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' "$R"/gradle-*.json | head -1; }
rm_results() { rm -rf "$R"; }

sim_on
echo "== max-workers"
export XCQ_JOBS=4
: > "$GLOG"; run assembleDebug
check "max-workers added once, after the program" "$(last_log)" "--max-workers=4 assembleDebug"
unset XCQ_JOBS
run assembleDebug; check "default is 6" "$(last_log)" "--max-workers=6 assembleDebug"
run --max-workers=2 assembleDebug; check "--max-workers=2 kept" "$(last_log)" "--max-workers=2 assembleDebug"
run --max-workers 2 assembleDebug; check "--max-workers 2 kept" "$(last_log)" "--max-workers 2 assembleDebug"

echo "== kind"
for t in connectedDebugAndroidTest :app:testDebugUnitTest testDebugUnitTest assembleDebug; do
  rm_results; run "$t"
  case $t in assemble*) want=build ;; *) want=test ;; esac
  check "kind of $t" "$(kind)" "$want"
done

echo "== queue"
rm_results; mkdir -p "$Q"
sleep 30 & bp=$!
printf 'pid=%s\nlabel=other\nqueued=1\nstate=running\nstarted=1\ncmd=x\n' "$bp" > "$Q/busy.ticket"
(cd "$PROJ" && XCQ_LABEL=mylabel "$XG" ./gradlew assembleDebug >/dev/null) & gp=$!
wait_for "grep -q label=mylabel '$Q'/gradle-*.ticket 2>/dev/null"
check "ticket carries the label" "$(sed -n 's/^label=//p' "$Q"/gradle-*.ticket)" mylabel
check "ticket is waiting" "$(sed -n 's/^state=//p' "$Q"/gradle-*.ticket)" waiting
rm -f "$Q/busy.ticket"; kill $bp 2>/dev/null
wait $gp; check "run ends after the slot frees" $? 0
check "no ticket left" "$(ls "$Q")" ""

echo "== off"
sim_off; rm -rf "$Q"; : > "$GLOG"
run assembleDebug
check "off: runs unchanged" "$(last_log)" "assembleDebug"
check "off: no ticket" "$(ls "$Q" 2>/dev/null)" ""
sim_on

echo "== target words"
: > "$GLOG"; : > "$ELOG"
(cd "$PROJ" && "$XG" ANDROID_SERIAL=emulator-5554 XCQ_SIM=@Pixel_9 ./gradlew installDebug >/dev/null)
check "words dropped from the arguments" "$(last_log)" "--max-workers=6 installDebug"
check "gradle sees ANDROID_SERIAL, not XCQ_SIM or XCQ_KIND" "$(tail -1 "$ELOG")" "serial=emulator-5554 sim=unset kind=unset"
(cd "$PROJ" && "$XG" XCQ_SIM=@Pixel_9 ANDROID_SERIAL=emulator-5556 ./gradlew installDebug >/dev/null)
check "either order" "$(tail -1 "$ELOG")" "serial=emulator-5556 sim=unset kind=unset"
(cd "$PROJ" && "$XG" FOO=1 ./gradlew installDebug >/dev/null 2>&1); check "unknown FOO=1 is the program" $? 127
sim_off; : > "$GLOG"
(cd "$PROJ" && "$XG" ANDROID_SERIAL=emulator-5554 XCQ_SIM=@Pixel_9 ./gradlew installDebug >/dev/null)
check "off: words dropped" "$(last_log)" "installDebug"
check "off: gradle sees ANDROID_SERIAL, not XCQ_SIM" "$(tail -1 "$ELOG")" "serial=emulator-5554 sim=unset kind=unset"
sim_on

echo "== android command"
rm_results; : > "$GLOG"
(cd "$PROJ" && "$XG" "$SIMAPHORE_DIR/tools/android" build --apk >/dev/null)
check "no --max-workers" "$(last_log)" "build --apk"
check "kind is build" "$(kind)" build
rm_results
(cd "$PROJ" && "$XG" "$SIMAPHORE_DIR/tools/android" run test >/dev/null)
check "kind is build even with test words" "$(kind)" build

echo "== emulator lease"
mkdir -p "$SIMAPHORE_DIR/agents"; touch "$SIMAPHORE_DIR/agents/s1.json"
echo "100 1 /sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_9" > "$SIMAPHORE_DIR/ps"
(cd "$PROJ" && XCQ_FAKE_PS="$SIMAPHORE_DIR/ps" XCQ_SESSION=s1 XCQ_LABEL=alpha "$XG" XCQ_SIM=@Pixel_9 ./gradlew installDebug >/dev/null)
check "run with an emulator ok" $? 0
grep -q '^session=s1$' "$SIMAPHORE_DIR/leases/@Pixel_9.lease" 2>/dev/null && ok "lease left for this holder" || bad "no lease: $(ls "$SIMAPHORE_DIR/leases" 2>&1)"

echo "== exit code"
(cd "$PROJ" && FAKE_GRADLE_EXIT=3 "$XG" ./gradlew assembleDebug >/dev/null); check "exit 3 passes through" $? 3

echo "== project untouched (R34)"
check "same files as before" "$(listing)" "$before"
check "no gradle.properties, local.properties or init.gradle" "$(find "$PROJ" \( -name gradle.properties -o -name local.properties -o -name 'init.gradle*' \))" ""
check "no init options logged" "$(grep -cE -- '(^| )(-I|--init-script|--init)( |$)' "$GLOG")" 0

finish
