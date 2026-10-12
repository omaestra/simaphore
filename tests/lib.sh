# Shared helpers for the test scripts. Source it; do not run it.
fails=0
ok() { echo "PASS $1"; }
bad() { echo "FAIL $1"; fails=$((fails+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }
wait_for() { local i=0; while ! eval "$1"; do sleep 0.2; i=$((i+1)); [ $i -gt 100 ] && return 1; done; return 0; }
# sim_on / sim_off: simaphore on (a pane open in a live session, this test's shell) or off.
sim_on() { mkdir -p "$SIMAPHORE_DIR/panels"; echo $$ > "$SIMAPHORE_DIR/panels/test"; }
sim_off() { rm -rf "$SIMAPHORE_DIR/panels"; }
finish() { echo; [ $fails -eq 0 ] && echo "ALL PASSED" || echo "$fails FAILED"; exit $((fails>0)); }

# make_fake_simctl <dir>: a stand-in `simctl` that prints <dir>/list.json, logs renames to <dir>/log,
# and fails `list` while <dir>/list.json.fail exists. Never touches a real simulator.
make_fake_simctl() {
  cat > "$1/simctl" <<'EOT'
#!/bin/bash
case $1 in
  list) [ -e "$FAKE_SIMCTL_JSON.fail" ] && exit 1; cat "$FAKE_SIMCTL_JSON" ;;
  rename) echo "rename $2 $3" >> "$FAKE_SIMCTL_LOG" ;;
  *) echo "unexpected simctl $*" >> "$FAKE_SIMCTL_LOG"; exit 1 ;;
esac
EOT
  chmod +x "$1/simctl"
  export XCSIM_SIMCTL=$1/simctl FAKE_SIMCTL_JSON=$1/list.json FAKE_SIMCTL_LOG=$1/log
}

# make_fake_xcwatch <dir> <exit-code> [delay]: a stand-in xcwatch that logs its arguments to
# <dir>/watch.log, waits <delay> seconds (default 0), then exits with <exit-code>.
# With delay "trigger" it blocks until <dir>/wake exists (then removes it), like a real wait.
make_fake_xcwatch() {
  cat > "$1/xcwatch" <<EOT
#!/bin/bash
echo "\$*" >> "$1/watch.log"
if [ "${3:-0}" = trigger ]; then while [ ! -e "$1/wake" ]; do sleep 0.05; done; rm -f "$1/wake"; else sleep ${3:-0}; fi
exit $2
EOT
  chmod +x "$1/xcwatch"
  : > "$1/watch.log"
  export XCQ_XCWATCH=$1/xcwatch
}
