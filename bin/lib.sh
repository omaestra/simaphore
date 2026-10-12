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

# outside_builds: how many xcodebuild builds are running outside the queue (no xcq above them),
# such as ones started while simaphore was off. XCQ_FAKE_PS (a file of `pid ppid args` lines) is for tests.
outside_builds() {
  { if [ -n "$XCQ_FAKE_PS" ]; then cat "$XCQ_FAKE_PS"; else ps -Ao pid=,ppid=,args= 2>/dev/null; fi; } |
    awk -v acts=" $XB_ACTIONS " '
      { a = $0; sub(/^ *[0-9]+ +[0-9]+ */, "", a); up[$1] = $2
        n = split(a, w, " "); prog = w[1]; sub(/.*\//, "", prog); arg1 = w[2]; sub(/.*\//, "", arg1)
        isq[$1] = prog == "xcq" || (prog ~ /^(ba|z)?sh$/ && arg1 == "xcq")
        if (prog == "xcodebuild") for (i = 2; i <= n; i++) if (index(acts, " " w[i] " ")) { found[$1] = 1; break } }
      END { c = 0
        for (p in found) { q = up[p]; inq = 0
          for (k = 0; k < 64 && q > 1; k++) { if (isq[q]) { inq = 1; break }; q = up[q] }
          if (!inq) c++ }
        print c }'
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
