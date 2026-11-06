---
name: verify
description: Run this checkout of simaphore inside a real Claude Code session, in an isolated tmux server and a throwaway state folder, and watch the /simaphore panel live. Use to confirm a panel, hook or timeline change works in the running app.
---

# Verify simaphore live

The surface is the `/simaphore` panel in a real `claude` session. Run it in its own tmux
server, with its own state folder, and with the installed copy of the plugin switched off.

## Launch

Save as `launch.sh` (outside the repo) and run it inside tmux:

```bash
#!/bin/bash
# $1 = throwaway SIMAPHORE_DIR
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_CHILD_SESSION CLAUDE_PID \
  CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_SESSION_ATTENDED CLAUDE_JOB_DIR \
  CLAUDE_CODE_EXECPATH CLAUDE_EFFORT XCQ_SESSION XCQ_MAX_SIMS
export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v simaphore | paste -sd: -)   # drop the installed shims
export SIMAPHORE_DIR="$1"
cd <repo>
exec claude --plugin-dir <repo> \
  --settings '{"enabledPlugins":{"simaphore@simaphore":false}}' \
  --allowedTools 'Bash(date)'
```

```bash
t() { /opt/homebrew/bin/tmux -L simverify "$@"; }     # a function, not a variable
t new-session -d -s v -x 200 -y 60 "bash launch.sh $SD"
t send-keys -t v '/simaphore' Enter
t capture-pane -p -t v                                 # the evidence
t kill-server                                          # when done
```

- The panel only fills once a session samples, so wait ~5 s after opening it.
- To make the mascot move (it redraws every 0.4 s), have the test agent run one tool:
  type `run date` + Enter. The main row then counts as busy for 60 s.
- To see lanes in the timeline without booting simulators, copy a real
  `~/.claude/simaphore/latest.json` into `$SD` first and fill `timeline[k].sims` with
  made-up udids and marks (`█ ▓ ▒ ░ ·`). They show as `? E465E8F3`. They scroll off
  after the time on screen (the span in the TIMELINE heading, about 2 minutes at 80
  columns), so seed again for a new run.

## Drive the panel

- `ctrl+x` then `Tab` moves focus into the panel. Inside it: `ctrl+x left` grows it,
  `ctrl+x right` shrinks it. `tmux resize-window` does **not** change the panel's width.
- Send `C-x` and the arrow as two separate `send-keys` calls.
- Keys inside the panel: `t` timeline, `a` shut-down sims, `Tab`/`BTab` focus ring.
  Don't press Enter while an alert button (Pause all / Resume all) has focus: it acts
  on the real Mac.
- Under 60 columns the panel is one line with no timeline.

## Watching the timeline

Capture the pane every ~0.2 s for 30 s together with `timeline[-1].at` from
`$SD/latest.json`. Strip each line up to the panel's left `│`, pick the lines from
`TIMELINE` to the legend, and group frames whose timeline is the same. Lane cells start
after the label column (offset 12 with one `? E465E8F3` lane, 10 with none, since the
labels fit the lanes in view), and each simulator row ends in an owner column (` —`).
Compare only the lane cells: as many as the `budget` row has after its label.
Each new group should match a new slot, with every row moved one column left.
Also record `at` from `latest.json`: updates whose `at` is not a slot are early
updates (events, slow reads coming back) and must not move the timeline.

## Gotchas

- The installed simaphore hook rewrites Bash calls (PATH shim, `XCQ_*`), so auto mode may
  ask for the same call again. Re-issue it with the exact input it shows.
- macOS `/bin/bash` is 3.2: no `source <(...)`. Write helpers to a file and `. file`.
- The real Mac's state (swap alerts, other sessions) shows in the panel. It is not the change.
