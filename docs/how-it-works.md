# How simaphore works

The deep details. For the short version, see the [README](../README.md).

A live panel for iOS and Android work with Claude Code. Open it with `/simaphore`.
It shows how hard your Mac is working, who is using which simulator or emulator,
and what builds are waiting. It also holds a shared queue so Xcode and Gradle
builds take turns instead of piling up and freezing the machine.

## On and off

simaphore does nothing until you open the panel.

- Opening `/simaphore` in any session switches it on for every session on this
  Mac: the build queue, the `-jobs` and `--max-workers` caps, simulator and
  emulator leases and the Xcode slot.
- Switching on picks up what is already going on. Builds started while off
  count toward the build limit, so new builds wait for them. A booted
  simulator an agent was using in the last 5 minutes (or is running tests on)
  is held for that agent.
- It stays on while at least one session has the panel open. Closing the last
  panel (or ending that session) switches it off everywhere.
- Switching off lets go of everything: waiting builds start at once, simulator
  and emulator holds are dropped and held simulators get their names back. Builds already
  running keep running.
- While off, commands run exactly as typed. simaphore only keeps its list of
  which agent is doing what, so the panel has it when you open it.

## The panel

Every section has a short grey line saying what it is for.

- **Header.** A small box at the top with a pixel mascot, a clock, and three
  lines: the memory pressure bar with a word (OK, ELEVATED or HIGH), memory and
  swap and heat, and CPU with the number of builds and booted simulators. The
  mascot looks calm when all is well, tense when pressure is rising, and busy
  and red when it is high. "stale Ns" in red means the numbers are older than
  15 seconds.
- **Agents.** One row per Claude session: name, what it is doing (building,
  testing, driving a simulator, queued, idle), how long, which simulator it
  holds (`-> A`), and its folder and branch. At 100 columns or wider it also
  shows how the last job ended and how long it took.
- **Simulators** (titled **Devices** while an Android emulator is on). Booted
  simulators and emulators with a letter, name, runtime, state, who holds
  it (an agent in its colour, you in blue, someone else in grey, nobody as a
  dash), memory and idle time. The dot is green when the simulator is booted
  and in use, grey when booted but unused, yellow while booting, red when it is
  flagged or CoreSim is unhealthy, and a hollow dim circle when shut down.
  Under each booted simulator a dim line lists the apps running in it (read
  every 5 seconds, with each app marked front or suspended). A `!` in the margin means an alert is about that
  row. Shut down devices are hidden until you press `a`. Press Enter on a row
  for its details. An emulator shows its AVD name and `Android` as its runtime.
- **Queue.** Builds waiting for a slot, with position, who asked, why they wait
  and for how long. The title says PAUSED when the queue is paused.
- **Alerts.** Things that need a look, worst first. Hidden when there are none.
- **Timeline.** The last ten minutes: one lane per simulator showing boot,
  build, test, drive and idle, plus the budget line, the queue and a pressure
  sparkline. Each kind has its own colour (build orange, test blue, drive
  purple, boot grey, idle dim) and its own shape, and the legend shows both.
- **Host.** Free disk, DerivedData and simulator data sizes in MB, GB or TB ("-" when
  not measured), the Xcode in use, and whether the simulator service (CoreSim) is
  ok or hung. Without Xcode it shows free disk only.

## Alert rules

Critical (red):

- Two or more people on the same simulator or emulator.
- Two or more people building into the same DerivedData folder.
- The simulator service is not answering (only when Xcode is installed).
- Thermal state critical, or memory pressure at its worst level.

Warning (yellow):

- More simulators and emulators booted than the limit (`maxSims`).
- Free disk under `lowDiskGb`.
- Thermal state serious.
- Two sessions or helpers used the same Xcode window or workspace (the same
  `tabIdentifier`, or `workspaceIdentifier` in headless Xcode) in the last 5
  minutes. They may be building over each other.
- Memory overload (tight memory or swap). This alert has buttons: "Pause all
  but one" and "Resume all".

## Keys

- `o` open the settings view
- `s` shut down the selected simulator or emulator (`adb emu kill` for an emulator)
- `p` pause or resume the queue
- `t` show or hide the timeline
- `a` show or hide shut down simulators
- `c` clean unavailable simulators (`xcrun simctl delete unavailable`); hidden
  without Xcode
- `q` close the panel

`s`, `c` and "Shut down all idle" ask twice. The first press shows a yellow
line saying exactly what will happen and who is using it. Press again within 8
seconds to go ahead.

## Small and short windows

- Under 60 columns the panel is a single line, for example
  `HIGH 82% | sims 4/2 !1 | q2 | a1/# a2~ a3>` (`devices` instead of `sims`
  while an emulator is on). Agent marks: `#` build, `~`
  test, `>` driving, `z` queued, `.` idle, `x` error.
- Under 30 rows the timeline and the blank lines between agents are hidden. Under 22 rows the host is hidden too.
- If the `NO_COLOR` environment variable is set, nothing is coloured; every
  label and `!` is still there.

## Settings

- `maxBuilds` (2): builds that may run at once when memory is fine. Under
  pressure it drops to 1.
- `swapPercent` (85): memory counts as tight when swap used passes this percent.
- `maxSims` (2): simulators and emulators allowed at once, counted together.
  The panel warns above it. A command that needs a third device waits for room
  (see below).
- `renameSims` (true): rename a held simulator to show who has it. iOS only;
  emulators are never renamed.
- `reservedSims` (empty): comma-separated simulator names, or emulator AVD names,
  that are always yours.
- `lowDiskGb` (20): warn when free disk is under this many GB.
- `asciiSymbols` (false): draw `>` `+` `x` `*` instead of the special symbols.
- `buildJobs` (6): value added as `-jobs` to `xcodebuild`, or as
  `--max-workers` to Gradle, when the command has none.
- `idleMinutes` (10): a simulator is idle after this many minutes under 2% CPU.

## Simulator leases

Agents share simulators without fighting over them.

- One holder per simulator. A command that names a held simulator waits in the
  background and runs when it is free. You are told when it finishes.
- A lease is freed when the holder ends or dies, when a helper agent finishes,
  or after 10 minutes unused.
- A held simulator is renamed "🔒 label · name" and gets its name back when
  freed. Commands can still use the original name: simaphore swaps it for the
  simulator ID.
- Reserved simulators are yours: any simulator you are debugging on from Xcode,
  and any name in `reservedSims`. Agents are told to use another one. Press Stop
  in Xcode (or quit it) and the simulator is free again within a few seconds.
  Running without the debugger reserves nothing; use `reservedSims` for that.
- With `maxSims` simulators already on, a command that needs one more waits for
  room. simaphore shuts down an unused, unreserved simulator to make it.
- Agent commands on all simulators at once (`shutdown all`) are refused.

`bin/xcsim claim <ID>` exit codes: 0 claimed (or already yours), 1 held by
someone else (prints who), 4 reserved. An emulator's ID is `@` and its AVD name,
for example `@Pixel_9`. `bin/xcsim resolve`: 2 no simulator
matches, 3 more than one matches. For every command: 64 not a simulator ID or
bad usage (the command runs unchanged), 74 the lease folder is not writable,
76 the simulator list cannot be read (74 and 76 refuse the command).

## Android emulators

Emulators follow the same lease rules as simulators, keyed by their AVD name.
simaphore turns on its Android side only when it finds `adb` in
`$ANDROID_HOME/platform-tools`, `$ANDROID_SDK_ROOT/platform-tools` or
`~/Library/Android/sdk/platform-tools`. Without it, nothing Android runs.

- An agent's `adb -s <serial> …` on an emulator another agent holds waits, then
  runs. The target is found the way adb finds it: `-s` first, then
  `ANDROID_SERIAL`, then the only emulator that is on. `adb devices`, `version`,
  `help`, `start-server`, `connect` and `pair` never wait.
- `emulator -avd X` or `emulator @X` waits while X is held, and claims X when it
  is free. Booting one past the limit waits for room.
- The `android` command's device commands (`emulator start` and `stop`,
  `install`, `run`, `screen`, `layout`, `input` and the rest) follow the same
  rules for the emulator they name or default to.
- `adb kill-server` and `adb reconnect` hit every device, so they are refused
  while another agent holds an emulator.
- An agent may hold one simulator and one emulator at once. Claiming a second
  emulator lets go of its first one.
- Only `emulator-<port>` devices count. Phones over USB or Wi-Fi are never held,
  counted or shut down; commands on them run as typed.
- To make room, simaphore shuts down an emulator only if an agent used it,
  nobody holds it, it isn't yours, and no agent used it for 10 minutes. It
  never shuts down an emulator no agent used.
- Nothing under `~/.android` is renamed, moved or edited.

## Gradle and the android command

- An agent's `./gradlew …` (any path to `gradlew`) or `gradle …` waits for a
  slot in the same build queue as `xcodebuild`, and shows in the Queue with its
  label. `android build`, and `android run` when it builds, do the same.
- Commands that build nothing pass straight through: `--version`, `--help`,
  `--stop`, `--status`, `tasks` and `help`.
- A queued Gradle command with no `--max-workers` gets
  `--max-workers=<buildJobs>`.
- An `install…` or `connected…` task first claims its emulator and runs with
  `ANDROID_SERIAL` set to it, so it waits for the emulator and a slot together.
  The emulator is the agent's own, else the only one that is on. With several
  on and none held by the agent, the command is refused with a note listing
  them; rerun it with `ANDROID_SERIAL=<serial>` in front.
- Gradle builds outside the queue (a terminal, a script) count toward the build
  limit while they run. An idle Gradle daemon counts as nothing, and builds
  started inside Android Studio are not seen.
- Nothing in your project is written: no `gradle.properties`, no
  `local.properties`, no init script. Options go only on the command line.
- Gradle commands now start with the PATH prefix and `bin/xcgradle`, so Claude
  Code may ask permission for them, and a permission rule that names
  `./gradlew` may no longer match.
- Gradle run from inside a script (`sh -c "./gradlew …"`, a Makefile) is not
  queued and gets no emulator picked for it.
- Android MCP servers are not covered yet.

Limits: simaphore spots simulator commands by matching the command text. A
command built to hide it, for example with `eval` or variables, is not caught.
Your own `!` commands are never blocked.

## Scripts

When an agent runs a script (`./run.sh`, `bash x.sh`, `python3 x.py`, `make`,
`fastlane`), simaphore puts its own `xcodebuild`, `xcrun` and `simctl`, and
`adb`, `emulator` and `android`, first on PATH for that command. Inside the
script:

- A simulator or emulator held by another agent is refused at once (exit 75,
  with a message saying who holds it), and so is a boot with no room. Scripts
  never wait for a device. Otherwise the real tool runs.
- A script's own `xcodebuild` build still waits in the build queue. A long
  script run in the foreground can hit the Bash timeout, so run it in the
  background.
- Commands that run scripts may now ask for permission, because they start
  with the PATH prefix.

## Xcode's own tools

When an agent builds, runs or tests through Xcode's tools (`BuildProject`,
`RunProject`, `RunAllTests`, `RunSomeTests`):

- The call waits for a build slot in the same queue as `xcodebuild`, and gives
  the slot back when it ends, fails or is stopped.
- For a run or a test, simaphore watches for the app Xcode starts and holds that
  simulator for the agent. If another agent already holds it, you get a toast
  and the agent is told to pick another run destination. The call itself is not
  stopped: Xcode chose the simulator before simaphore could see it.
- Each call records which Xcode window it used, for the alert above. simaphore
  does not hold Xcode windows.
- Headless Xcode 27 (`xcrun mcp-server`, no Xcode window open) uses the same
  tools under the same `xcode` server name and is covered the same way. It
  names the workspace instead of a window, and starts simulator sessions with
  `DeviceInteractionStartWorkspaceSession`; simaphore accepts both.

## How it stays live

A small helper, `bin/xcwatch`, tells simaphore the moment something changes: a
queue, lease or `latest.json` file, a simulator booting or shutting down, a
session ending, or memory pressure. Waiters and the panel then react at once
instead of on the next timer. The first session builds it once with `swiftc`
into the simaphore folder, in the background.

Polling stays as the safety net. Without the helper (no `swiftc`, or the build
fails) everything polls as before, just a few seconds later. With it, the
timed simulator list read drops from every 10 s to every 30 s.

The session that samples also keeps one `log stream` per booted simulator to
see apps come to the front or go to the background live, instead of reading
the log every 5 s. Without a stream it reads the log as before.
Each stream runs under `xcwatch tether`, which stops it when the session ends,
even if the session crashed or was killed.

## Demo mode

Try the panel without touching anything real:

- `/simaphore demo` lists the scenarios: calm, overBudget, clash,
  sharedDerivedData, hungCoreSim, thermal, busy, xcodeTest, android.
- `/simaphore demo busy` opens the panel drawing that scenario. The top border says
  `demo: busy`. Buttons do nothing but show a note.
- `/simaphore demo off` goes back to live data.
