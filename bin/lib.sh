# Shared helpers for xcq, xcsim, xcpause and shim/xcodebuild. Source it; do not run it.
# The caller sets DIR (the simaphore folder) before using hold_lock.

UUID_RE='^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$'
# Action words, most specific first (kind_of takes the first one found).
XB_ACTIONS="test-without-building build-for-testing test archive analyze build clean"
XB_QUERY_FLAGS="-list -showBuildSettings -showdestinations -showsdks -version -help -showTestPlans"
# Flags that take the next word as their value, so that word is never an action.
XB_VALUE_FLAGS="-project -workspace -scheme -target -configuration -destination -sdk -arch -toolchain
 -archivePath -exportPath -exportOptionsPlist -derivedDataPath -resultBundlePath -resultStreamPath
 -testPlan -only-testing -skip-testing -xcconfig -xctestrun -testProductsPath -jobs
 -clonedSourcePackagesDirPath -packageCachePath -destination-timeout"
XB_VALUE_FLAGS=$(printf %s "$XB_VALUE_FLAGS" | tr '\n' ' ')

val() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1; }   # val <file> <key>
is_uuid() { printf %s "$1" | grep -qE "$UUID_RE"; }
# An emulator's device key: @ and its AVD name (AVD_KEY_RE in hooks/android.ts). Safe in file names.
AVD_RE='^@[A-Za-z0-9._-]+$'
is_avd_key() { case $1 in *$'\n'*) return 1 ;; esac; printf %s "$1" | LC_ALL=C grep -qE "$AVD_RE"; }
clean() { printf %s "$1" | tr -d '\r\n'; }   # one-line value for a key=value file

# xb_scan <words...>: sets XB_FOUND (action words), XB_QUERY=1 (info flag seen), XB_JOBS=1 (-jobs seen).
xb_scan() {
  local w prev=
  XB_FOUND= XB_QUERY=0 XB_JOBS=0
  for w in "$@"; do
    case $w in ''|*" "*) prev=; continue ;; esac
    if [ -n "$prev" ]; then
      case " $XB_VALUE_FLAGS " in *" $prev "*) prev=; continue ;; esac
    fi
    prev=$w
    case " $XB_QUERY_FLAGS " in *" $w "*) XB_QUERY=1 ;; esac
    case " $XB_ACTIONS " in *" $w "*) XB_FOUND="$XB_FOUND $w" ;; esac
    [ "$w" = -jobs ] && XB_JOBS=1
  done
}

# True when pid $1 is a live xcq (guards against a hand-set XCQ_HELD and a reused pid).
is_xcq_pid() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  case "$(ps -o command= -p "$1" 2>/dev/null) " in */xcq\ *) return 0 ;; esac
  return 1
}

# Kills a process and everything under it (lockf may not forward signals). CONT wakes a paused
# one so the TERM is delivered.
killtree() {
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done
  kill "$1" 2>/dev/null
  kill -CONT "$1" 2>/dev/null
}

# exit_traps <cleanup-function>: run it on exit and on INT/TERM/HUP (with the usual exit codes).
exit_traps() {
  trap "$1" EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
}

# hold_lock <name> <owner-pid> [seconds]: take $DIR/locks/<name> (waits up to 30s by default).
# A helper holds a lockf lock until drop_lock or until the owner exits, so a crash frees it.
LOCK_PID=
hold_lock() {
  local ready="$DIR/locks/.ready.$2.$RANDOM" i=0 max=$(( ${3:-30} * 50 ))
  mkdir -p "$DIR/locks" 2>/dev/null || return 1
  lockf -k "$DIR/locks/$1" /bin/sh -c \
    'echo > "$1"; while kill -0 "$2" 2>/dev/null; do sleep 0.5; done' sh "$ready" "$2" \
    >/dev/null 2>&1 </dev/null &
  LOCK_PID=$!
  while [ ! -e "$ready" ]; do
    i=$((i+1))
    if [ $i -gt $max ] || ! kill -0 "$LOCK_PID" 2>/dev/null; then
      killtree "$LOCK_PID"; LOCK_PID=; return 1
    fi
    sleep 0.02
  done
  rm -f "$ready"
}
drop_lock() { [ -n "$LOCK_PID" ] && killtree "$LOCK_PID"; LOCK_PID=; return 0; }

# wake_wait <fallback-seconds> [xcwatch flags and paths...]: sleep until something changes.
# Wakes early when xcwatch sees a change; otherwise (no helper, error) it sleeps the fallback.
# Exit 1 = its 10 s timeout, which is the safety net for changes that touch no file.
XCWATCH=${XCQ_XCWATCH:-$BIN/xcwatch}
WATCH_OFF=0
wake_wait() {
  local secs=$1 rc
  shift
  if [ "$WATCH_OFF" != 1 ] && [ "$XCQ_NO_WATCH" != 1 ]; then
    "$XCWATCH" wait --timeout 10 "$@" >/dev/null 2>&1 & wait $!
    rc=$?
    case $rc in 0|1) return 0 ;; 69|126|127) WATCH_OFF=1 ;; esac   # not built: never ask again
  fi
  sleep "$secs" & wait $!
}

# simctl verbs that act on one device. Keep in sync with CLAIM_VERBS in hooks/leases.ts.
CLAIM_VERBS=" boot shutdown erase delete install uninstall launch terminate openurl io ui spawn push
 privacy location status_bar addmedia keychain get_app_container pbcopy pbpaste bootstatus listapps
 appinfo getenv setenv rename "
CLAIM_VERBS=$(printf %s "$CLAIM_VERBS" | tr '\n' ' ')

# sim_active: 0 while a simaphore pane is open in a live session ($DIR/panels/<session> holds its pid).
# Off, simaphore holds nothing back: builds run at once and simulator commands are never refused.
sim_active() {
  local f p
  for f in "${DIR:-${SIMAPHORE_DIR:-$HOME/.claude/simaphore}}"/panels/*; do
    [ -e "$f" ] || continue
    p=$(head -1 "$f" 2>/dev/null | tr -d ' ')
    case $p in ''|*[!0-9]*) continue ;; esac
    [ "$p" -gt 1 ] && kill -0 "$p" 2>/dev/null && return 0
  done
  return 1
}

# outside_builds: how many xcodebuild and Gradle client builds run outside the queue (no xcq above them),
# such as ones started while simaphore was off. XCQ_FAKE_PS (a file of `pid ppid args` lines) is for tests.
outside_builds() {
  { if [ -n "$XCQ_FAKE_PS" ]; then cat "$XCQ_FAKE_PS"; else ps -Ao pid=,ppid=,args= 2>/dev/null; fi; } |
    awk -v acts=" $XB_ACTIONS " '
      { a = $0; sub(/^ *[0-9]+ +[0-9]+ */, "", a); up[$1] = $2
        n = split(a, w, " "); prog = w[1]; sub(/.*\//, "", prog); arg1 = w[2]; sub(/.*\//, "", arg1)
        isq[$1] = prog == "xcq" || (prog ~ /^(ba|z)?sh$/ && arg1 == "xcq")
        if (prog == "xcodebuild") for (i = 2; i <= n; i++) if (index(acts, " " w[i] " ")) { found[$1] = 1; break }
        for (m = 2; m <= n; m++) if (w[m] == "org.gradle.wrapper.GradleWrapperMain" || w[m] == "org.gradle.launcher.GradleMain") {
          flag = 0; task = 0   # pass-through: an info/stop flag, or no task other than tasks/help
          for (i = m + 1; i <= n; i++) {
            if (w[i] ~ /^(-v|--version|-h|-\?|--help|--stop|--status)$/) flag = 1
            else if (substr(w[i], 1, 1) != "-" && w[i] != "tasks" && w[i] != "help") task = 1 }
          if (task && !flag) found[$1] = 1
          break } }
      END { c = 0
        for (p in found) { q = up[p]; inq = 0
          for (k = 0; k < 64 && q > 1; k++) { if (isq[q]) { inq = 1; break }; q = up[q] }
          if (!inq) c++ }
        print c }'
}

# emu_procs: one "pid AVD" line per running emulator: a qemu-system-* process with -avd X or @X.
# The `emulator` launcher is not counted, so one emulator is never two (emulatorProcs in hooks/android.ts).
emu_procs() {
  { if [ -n "$XCQ_FAKE_PS" ]; then cat "$XCQ_FAKE_PS"; else ps -Ao pid=,ppid=,args= 2>/dev/null; fi; } |
    LC_ALL=C awk '{ prog = $3; sub(/.*\//, "", prog)
      if (prog !~ /^qemu-system-[A-Za-z0-9_-]+$/) next
      for (i = 4; i <= NF; i++) {
        if ($i == "-avd") n = $(i + 1); else if (substr($i, 1, 1) == "@") n = substr($i, 2); else continue
        if (n ~ /^[A-Za-z0-9._-]+$/) print $1, n
        break } }'
}
emu_on() { emu_procs | awk -v a="$1" '$2 == a { f = 1 } END { exit !f }'; }   # emu_on <AVD name>
emu_count() { emu_procs | wc -l | tr -d ' '; }

# has_xcode: 0 when Xcode is found (D11): $DEVELOPER_DIR, else `xcode-select -p`, names a folder
# with usr/bin/simctl. A file check only: never xcrun, which may open an install dialog.
has_xcode() {
  local d=${DEVELOPER_DIR:-$(xcode-select -p 2>/dev/null)}
  d=${d%/}
  case $d in *.app) d=$d/Contents/Developer ;; esac
  [ -n "$d" ] && [ -e "$d/usr/bin/simctl" ]
}

# sim_guard <simctl args...>: for the xcrun/simctl stand-ins (needs BIN = the shim folder).
# Returns 0 to run the real tool, 75 when refused (message on stderr). Never waits.
# Checked: a claim verb's device is free (or ours), and `boot` has room. `booted`, `all` and
# `unavailable` are not one simulator, so they pass; so does anything xcsim cannot answer.
sim_guard() {
  local verb=$1 dev= a u out rc
  [ -z "$XCQ_SESSION" ] && return 0
  sim_active || return 0
  [ -n "$XCQ_HELD" ] && is_xcq_pid "$XCQ_HELD_BY" && return 0   # a queued build already holds it
  case "$CLAIM_VERBS" in *" $verb "*) ;; *) return 0 ;; esac
  shift
  for a in "$@"; do case $a in -*) ;; *) dev=$a; break ;; esac; done
  case $dev in ''|booted|all|unavailable) return 0 ;; esac
  export XCSIM_SIMCTL=${XCSIM_SIMCTL:-"${XCQ_REAL_XCRUN:-/usr/bin/xcrun} simctl"}   # no loop back here
  u=$("$BIN/../xcsim" resolve "$dev" 2>/dev/null) || return 0   # none, ambiguous, no list: simctl decides
  # Room before the claim: a claim drops the caller's other lease, so a refused boot must not claim.
  if [ "$verb" = boot ]; then
    out=$("$BIN/../xcsim" room "$u" 2>/dev/null); rc=$?
    [ $rc = 1 ] && [ "$out" != "?" ] && {
      echo "simaphore: $out simulators already on, the limit is ${XCQ_MAX_SIMS:-2}" >&2; return 75; }
  fi
  out=$("$BIN/../xcsim" claim "$u" 2>/dev/null); rc=$?
  case $rc in
    1) echo "simaphore: simulator $dev is held by $out; pick another simulator or wait" >&2; return 75 ;;
    4) echo "simaphore: simulator $dev is reserved for the owner; pick another simulator" >&2; return 75 ;;
  esac
  return 0
}

# real_tool <adb|emulator|android>: prints the real tool's path, or returns 1 when there is none.
# XCQ_REAL_<NAME> wins; else the next one on PATH outside the stand-ins' folder $BIN; else the SDK (R1).
real_tool() {
  local n=$1 up v d c s oifs=$IFS
  up=$(printf %s "$n" | tr 'a-z' 'A-Z'); eval "v=\${XCQ_REAL_$up}"
  [ -n "$v" ] && { printf %s "$v"; return 0; }
  IFS=:
  for d in $PATH; do
    IFS=$oifs
    [ -n "$d" ] && [ -f "$d/$n" ] && [ -x "$d/$n" ] || { IFS=:; continue; }
    c=$(cd "$d" 2>/dev/null && pwd -P)
    # Any simaphore stand-in folder is skipped, not just ours: two copies would call each other.
    [ "$c" = "$BIN" ] || [ -f "$d/../lib.sh" -a -f "$d/../xcsim" ] || { printf %s "$d/$n"; return 0; }
    IFS=:
  done
  IFS=$oifs
  for s in "$ANDROID_HOME" "$ANDROID_SDK_ROOT" "$HOME/Library/Android/sdk"; do
    [ -n "$s" ] && [ -x "$s/platform-tools/adb" ] || continue
    case $n in
      adb) printf %s "$s/platform-tools/adb"; return 0 ;;
      emulator) [ -x "$s/emulator/emulator" ] && { printf %s "$s/emulator/emulator"; return 0; } ;;
    esac
    return 1
  done
  return 1
}

# emu_avd_of <serial>: the AVD name of an emulator serial, asked of the real adb; fails after about 3s.
emu_avd_of() {
  local adb f p k out
  adb=$(real_tool adb) || return 1
  f=$(mktemp "${TMPDIR:-/tmp}/simaphore-avd.XXXXXX") || return 1
  "$adb" -s "$1" emu avd name > "$f" 2>/dev/null < /dev/null &
  p=$!
  { sleep 3; kill "$p" 2>/dev/null; } > /dev/null 2>&1 &
  k=$!
  wait "$p" 2>/dev/null || { kill "$k" 2>/dev/null; rm -f "$f"; return 1; }
  kill "$k" 2>/dev/null
  out=$(head -1 "$f" | tr -d '\r'); rm -f "$f"
  is_avd_key "@$out" || return 1
  printf %s "$out"
}

# emu_fleet_guard <what>: refuses (75) when another live holder has an emulator lease.
emu_fleet_guard() {
  local d=${DIR:-${SIMAPHORE_DIR:-$HOME/.claude/simaphore}} f s a n
  for f in "$d"/leases/@*.lease; do
    [ -e "$f" ] || continue
    s=$(val "$f" session); a=$(val "$f" agent)
    [ "$s" = "$XCQ_SESSION" ] && [ "${a:-main}" = "${XCQ_AGENT:-main}" ] && continue
    [ -n "$s" ] && [ -e "$d/agents/$s.json" ] || continue
    n=${f##*/@}
    echo "simaphore: $1 would stop emulator ${n%.lease} held by $(val "$f" label); wait or leave it" >&2
    return 75
  done
  return 0
}

# emu_guard <adb|emulator|android> <args...>: for the adb/emulator/android stand-ins (needs BIN).
# Returns 0 to run the real tool, 75 when refused (one line on stderr). Never waits. Reads the call
# the way hooks/android.ts does (adbCallOf, emulatorBootOf, androidCallOf).
emu_guard() {
  local tool=$1 kind= avd= serial= verb a other=0 dev= devset=0 cmd sub name own i out rc
  shift
  [ -z "$XCQ_SESSION" ] && return 0
  sim_active || return 0
  [ -n "$XCQ_HELD" ] && is_xcq_pid "$XCQ_HELD_BY" && return 0   # a queued build already holds it
  case $tool in
    adb)
      while [ $# -gt 0 ]; do
        case $1 in
          -s) serial=$2; shift; [ $# -gt 0 ] && shift ;;
          -t) other=1; shift; [ $# -gt 0 ] && shift ;;
          -H|-P|-L|--one-device) shift; [ $# -gt 0 ] && shift ;;
          -s?*) serial=${1#-s}; shift ;;
          -t?*|-d) other=1; shift ;;
          -e|-a|-H?*|-P?*|-L?*|--exit-on-write-error) shift ;;
          *) break ;;
        esac
      done
      verb=${1:-}
      case $verb in
        ''|-*|devices|version|help|start-server|connect|pair|disconnect|mdns|keygen|track-devices) return 0 ;;
        kill-server|reconnect) emu_fleet_guard "adb $verb"; return $? ;;
      esac
      kind=device
      if [ -z "$serial" ] && [ $other = 0 ]; then serial=$ANDROID_SERIAL; [ -z "$serial" ] && avd=$(emu_default); fi
      ;;
    emulator)
      while [ $# -gt 0 ]; do
        case $1 in
          -qemu) break ;;
          -list-avds|--list-avds|-help|--help|-help-*|--help-*|-version|--version|-accel-check|--accel-check) return 0 ;;
          -avd|--avd) avd=$2; shift ;;
          @*) avd=${1#@} ;;
        esac
        [ $# -gt 0 ] && shift
      done
      is_avd_key "@$avd" || return 0
      kind=boot
      ;;
    android)
      while [[ $1 == -* ]]; do
        case $1 in -h|--help|-V|--version) return 0 ;; --sdk) shift ;; esac
        [ $# -gt 0 ] && shift
      done
      cmd=$(printf %s "$1" | tr 'A-Z' 'a-z'); [ $# -gt 0 ] && shift
      own=("$@")
      for ((i = 0; i < ${#own[@]}; i++)); do [ "${own[i]}" = -- ] && { own=("${own[@]:0:i}"); break; }; done
      [ -z "$cmd" ] && return 0
      for a in "${own[@]}"; do case $a in -h|--help) return 0 ;; esac; done
      for ((i = 0; i < ${#own[@]}; i++)); do
        case ${own[i]} in
          --device) dev=${own[i+1]}; [ $((i + 1)) -lt ${#own[@]} ] && devset=1; break ;;
          --device=*) dev=${own[i]#--device=}; devset=1; break ;;
        esac
      done
      case $cmd in
        install|run|screen|layout|input|profiler) kind=device ;;
        device) [ "$(printf %s "${own[0]:-}" | tr 'A-Z' 'a-z')" = hub ] && kind=device ;;
        emulator)
          sub=$(printf %s "${own[0]:-}" | tr 'A-Z' 'a-z'); name=
          for ((i = 1; i < ${#own[@]}; i++)); do case ${own[i]} in -*) ;; *) name=${own[i]}; break ;; esac; done
          case $sub in
            start) is_avd_key "@$name" && { kind=boot; avd=$name; } ;;
            stop)
              kind=device
              if [ -z "$name" ]; then avd=$(emu_default)
              elif printf %s "$name" | grep -qE '^emulator-[0-9]+$'; then serial=$name
              elif is_avd_key "@$name"; then avd=$name
              else kind=; fi ;;
          esac
          ;;
      esac
      [ -z "$kind" ] && return 0
      if [ $kind = device ] && [ "$cmd" != emulator ]; then
        if [ $devset = 0 ]; then avd=$(emu_default)
        elif printf %s "$dev" | grep -qE '^emulator-[0-9]+$'; then serial=$dev
        else return 0; fi
      fi
      ;;
    *) return 0 ;;
  esac
  # A device op needs the AVD: from the serial (asked of adb), and it must be on.
  if [ $kind = device ]; then
    if [ -z "$avd" ]; then
      printf %s "$serial" | grep -qE '^emulator-[0-9]+$' || return 0
      avd=$(emu_avd_of "$serial") || return 0
    fi
    emu_on "$avd" || return 0
  elif ! emu_on "$avd"; then
    # Room before the claim: a claim drops the caller's other lease, so a refused boot must not claim.
    out=$("$BIN/../xcsim" room "@$avd" 2>/dev/null); rc=$?
    [ $rc = 1 ] && [ "$out" != "?" ] && {
      echo "simaphore: $out devices already on, the limit is ${XCQ_MAX_SIMS:-2}" >&2; return 75; }
  fi
  out=$("$BIN/../xcsim" claim "@$avd" 2>/dev/null); rc=$?
  case $rc in
    1) echo "simaphore: emulator $avd is held by $out; pick another emulator or wait" >&2; return 75 ;;
    4) echo "simaphore: emulator $avd is reserved for the owner; pick another emulator" >&2; return 75 ;;
  esac
  return 0
}

# emu_default: the AVD name of the only emulator on, or nothing.
emu_default() { [ "$(emu_count)" = 1 ] && emu_procs | awk '{ print $2 }'; return 0; }
