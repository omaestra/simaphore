# Spec: android-emulators

Approved: 2026-11-02 · revised: 2026-11-02 · intent: ./intent.md

Terms: "SDK found" is R1. "On" means a panel is open, as today. "Xcode found" is D11. An
emulator's "serial" is its adb name (`emulator-5554`); its "AVD name" is the virtual device's
name (`Pixel_9`).

## Requirements

No Android SDK
- R1: The Android SDK counts as found only when an `adb` file exists at
  `$ANDROID_HOME/platform-tools/adb`, else `$ANDROID_SDK_ROOT/platform-tools/adb`, else
  `~/Library/Android/sdk/platform-tools/adb`. A file check, never a command.
- R2: With no SDK found, a sampler round runs exactly today's commands: no `adb`, `emulator`,
  `android` or `java`, and no Android file reads beyond R1.
- R3: With no SDK found and Xcode found, the panel, alerts, settings view, `latest.json` and
  every tool-call decision match today for the same inputs, except the limit's new name (D1).
  Today's tests, demo scenes and screenshot snapshots pass, changed only for that name. A Mac
  with neither gets the no-Xcode behavior of R28–R30 (D20).
- R4: With the SDK found and no emulator on, every simulator decision (claim, wait, room,
  shutdown, rename, queue) is the same as today.

Panel
- R5: An emulator that is booting or on appears in the simulator section within 2 sampler
  rounds, showing its AVD name, an Android mark, its state, and the agent holding or last
  using it. It disappears within 2 rounds after it stops.
- R6: While at least one emulator is on, the section title reads DEVICES instead of
  SIMULATORS. Otherwise the title is unchanged.
- R7: Only `emulator-<port>` serials count as emulators. Phones over USB or Wi-Fi never
  appear, never count toward the limit, and are never held, waited on or shut down. Commands
  naming them run as typed.

One agent per emulator
- R8: While agent A holds emulator X, agent B's Bash `adb -s <X's serial> <verb> …` is held
  back in the background until A lets go, then runs. B is told who holds it. This covers
  every adb verb that acts on one device (`install`, `uninstall`, `shell`, `push`, `pull`,
  `logcat`, `emu`, `reboot`, `forward`, `reverse`, `exec-out`, `root` and the rest). `adb
  devices`, `version`, `help`, `start-server`, `connect` and `pair` are never held.
- R9: An adb command's target is worked out the way adb does it: `-s` wins over
  `ANDROID_SERIAL`, and with `-e` or no flag and exactly one emulator on, the target is that
  emulator.
- R10: `emulator -avd X` or `emulator @X` from B while A holds X waits, then runs. If X is
  free, B claims it.
- R11: Every `android` command aimed at one emulator follows R8 and R10 for the emulator it
  names or defaults to: `android emulator start` and `stop`, `android install`, `android run
  --device=<serial>`, and the device commands such as `screen`, `layout`, `input`, `profiler`
  and `device hub` (D22). Command shapes as documented at
  developer.android.com/tools/agents/android-cli.
- R12: `adb kill-server` and `adb reconnect` (they hit every device) are refused while
  simaphore is on and another agent holds an emulator, like `simctl shutdown all` today.
- R13: An emulator lease is let go for the same reasons as a simulator's: the session ends or
  dies, the helper agent finishes, 10 minutes unused, the AVD is deleted, simaphore is
  switched off. This works on a Mac without Xcode too.
- R14: An agent may hold one simulator and one emulator at the same time. Claiming a second
  emulator lets go of its first emulator, never its simulator, and the other way round.
- R15: An emulator whose AVD name is in "Your simulators" is never claimed by an agent and
  never shut down by simaphore. An agent's command on it is refused as reserved, with a free
  emulator suggested when there is one.
- R16: Holding an emulator never renames, moves or edits anything under `~/.android`.

Limit
- R17: Simulators and emulators that are booting or on count toward one shared limit,
  renamed "Simulator and emulator limit". A command that would turn on one device past it
  waits in Bash and exits 75 inside scripts. The panel's device count, pressure bar and
  over-limit warning count emulators too.
- R18: To make room, simaphore shuts down one device, longest unused first, applying today's
  simulator rule to emulators: an agent used it, nobody holds it, it isn't reserved, nothing
  runs on it, and no agent used it for 10 minutes. It never shuts down an emulator no agent
  used.
- R19: The panel's `s` key shuts down the selected emulator, asking twice as today.

Builds
- R20: An agent's Bash `./gradlew …` (any path to `gradlew`) or `gradle …` takes a slot in
  the same build queue as `xcodebuild`. With "Builds at once" at 1 and an `xcodebuild`
  building, it waits and is listed in the Queue with its label. The reverse waits the same
  way.
- R21: Gradle commands that build nothing pass straight through: `-v`/`--version`,
  `-h`/`--help`, `--stop`, `--status`, `tasks`, `help`.
- R22: A queued Gradle command with no `--max-workers` gets `--max-workers=<Compiler jobs>`
  on its command line, as `xcodebuild` gets `-jobs`.
- R23: A Gradle build outside the queue (a script, a terminal) counts against the slot limit
  while its Gradle client process runs. A Gradle daemon with no build running counts as no
  build.
- R24: An agent's Gradle `install*` or `connected*` task first claims its target emulator
  (the agent's held one, else the only one on) and runs with `ANDROID_SERIAL` set to it, so
  it waits for the emulator and a slot together, as `xcodebuild test` does. With two or more
  emulators on and none held by the agent, it is refused with a note listing the running
  emulators and asking to rerun with `ANDROID_SERIAL=<serial>`, which then follows R8 (D21).
- R25: The `android` command's build commands (`android build`, and `android run` when it
  builds) take a slot like Gradle.

Scripts and off
- R26: A script an agent runs that calls `adb`, `emulator` or `android` by name gets PATH
  stand-ins. A held or reserved target, or a boot with no room, stops at once with exit 75
  and one line naming the holder. Otherwise the real tool runs. Scripts never wait.
- R27: With no panel open, Bash `adb`, `emulator`, `android` and Gradle commands get no
  prefix or rewrite, the stand-ins run the real tool at once, and nothing is queued, held or
  refused.

No Xcode
- R28: With no Xcode found, the sampler runs no `xcrun`, `simctl` or `plutil`, and no size
  check of DerivedData or simulator data, beyond the Xcode check itself (D11).
- R29: With no Xcode found, there is no "simulator service not answering" alert, no
  simulator row turns red, and the host line shows no Xcode, CoreSim, DerivedData or
  simulator-data parts, with nothing in their place. The `c` key is hidden.
- R30: With no Xcode found, an agent's Bash `xcrun simctl …` or `xcodebuild …` runs as typed,
  instead of being refused as "can't check" as today (`hooks/register.tsx:1352`).
- R31: With no Xcode found, R5–R27 still hold.

Docs and limits
- R32: The README (opening line, "What you need", features, settings, known limits),
  `docs/how-it-works.md`, and the descriptions in `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` say simaphore covers Android emulators, Gradle and the
  `android` command, and list the known limits (MCP servers, Android Studio builds, Gradle
  inside scripts). `docs/under-the-hood.md` too, once that guide is on `main` (today it is
  only on the unmerged `docs/under-the-hood` branch).
- R33: simaphore installs nothing. It runs only tools the user already has: the SDK's `adb`
  and `emulator`, the `android` command if present, the project's `gradlew` or `gradle`.
- R34: Nothing in the user's project is written (`gradle.properties`, `local.properties`,
  build files), and no Gradle init script is written anywhere. Gradle options go only on the
  command line.
- R35: Still Mac only: no Linux or Windows paths or process names are added.
- R36: Before merging, scenarios S1–S15 are run on a real emulator on this Mac, and the
  results are written down.

## Design decisions
- D1: One shared limit for simulators and emulators, renamed "Simulator and emulator
  limit". Beat: a separate emulator limit (two numbers, and together they can use more
  memory than either says). Cost accepted: on a Mac using both, an iOS boot can wait behind
  an emulator. (source: owner)
- D2: "Your simulators" accepts AVD names. Emulators Android Studio starts are not treated
  as yours automatically. Beat: protect every Studio emulator (it can't tell debugging from
  just running) and no protection at all. (source: owner)
- D3: Emulators share the simulator section, marked Android, and the title reads DEVICES
  while one is on. Beat: a separate EMULATORS section (more rows on small windows).
  (source: owner)
- D4: Google's `android` command is covered in this change. Beat: leaving it for later,
  like MCP. (source: owner)
- D5: A lease is keyed by AVD name. Beat: the serial, because `emulator-5554` passes to the
  next emulator that boots on that port, so a lease could silently move. Emulator leases sit
  in `leases/` with a distinct file-name shape and their own strict name check. The UUID
  checks that keep simulator IDs safe in shell text stay as they are. (source: spec agent)
- D6: Held emulators are not renamed. The holder shows only in the panel, and the "Rename
  held simulators" help text says it is iOS only. Beat: renaming the AVD (unsafe while it
  runs, writes to `~/.android`, breaks Android Studio's references). (source: spec agent)
- D7: One device per platform per agent (R14). Beat: one device in total, which would make
  an agent testing both platforms lose its simulator when it claims an emulator. (source:
  spec agent, shown to owner)
- D8: A Gradle build counts while its client process (`gradlew`, `GradleWrapperMain`,
  `gradle`) runs. The Gradle and Kotlin daemons are ignored. Beat: counting a busy daemon
  (noisy) and counting queue tickets only (misses builds outside the queue). (source: spec
  agent)
- D9: Builds started in Android Studio don't make agent builds wait. Listed as a known
  limit. Beat: a busy daemon with no client writes the `hold` file. (source: spec agent,
  shown to owner)
- D10: "Compiler jobs" also caps Gradle as `--max-workers` (R22), and its help text says
  so. Beat: leave Gradle at its default (one worker per core). (source: spec agent, shown
  to owner)
- D11: Xcode counts as found when `$DEVELOPER_DIR` or `xcode-select -p` points at a folder
  containing `usr/bin/simctl`. It is checked at session start and every few minutes, never
  by running `xcrun`, which may open an install dialog on a Mac without developer tools.
  Beat: `xcrun --find simctl`, and "simctl never answered", which would make a real CoreSim
  hang at startup look like "no Xcode". Side effect accepted: a Mac whose `xcode-select`
  points at the Command Line Tools now shows the iOS parts as quiet instead of broken.
  (source: spec agent)
- D12: On a Mac without Xcode the Xcode parts are hidden and nothing replaces them. Beat:
  showing the AVD folder size or the SDK path. (source: spec agent, shown to owner)
- D13: Untargeted adb commands resolve as adb does (R9). Beat: letting them through, which
  misses the common one-emulator case, or refusing them while anything is held, which is
  blunt. (source: spec agent)
- D14: Gradle install and connected tasks target the agent's held emulator, else the only
  one on, through `ANDROID_SERIAL` on the command line (R24). Whether the Android Gradle
  plugin honors it is checked live in S13. Beat: holding every running emulator for the
  whole build, which blocks the others. (source: spec agent)
- D15: Gradle inside scripts isn't queued. `gradlew` is a project file, not on PATH, so no
  stand-in catches it; it counts as an outside build (R23). Beat: queueing any script that
  mentions `gradlew`, which is guesswork. (source: spec agent)
- D16: An emulator is shut down with `adb -s <serial> emu kill`. Beat: a stop signal to the
  emulator process (its effect on the Quick Boot save is unknown). (source: spec agent)
- D17: A serial's AVD name comes from `adb -s <serial> emu avd name`, asked once per new
  serial and remembered. Beat: reading the emulator's running-instance files (location
  unconfirmed). (source: spec agent)
- D18: The sampler runs `adb` only while the process list shows an emulator. Beat: every
  round when the SDK is found, which adds a process per round and starts the adb server on
  Macs that never run an emulator. (source: spec agent)
- D19: Emulators that Gradle starts for its own tests (Gradle Managed Devices) get no special
  handling. They show and count like any emulator, and R18 already keeps simaphore from
  shutting them down, since no agent used them. Beat: recognizing and exempting them (no
  confirmed way to recognize them, and no requirement asked for it). (source: owner, revised)
- D20: On a Mac with neither Xcode nor the SDK, the quiet no-Xcode look wins over "exactly as
  today" (R3, R28–R30). Beat: keeping today's broken iOS look there. (source: owner)
- D21: Gradle install and connected tasks with several emulators on and none held are refused
  with a note (R24). Beat: holding every running emulator for the whole build (blocks other
  agents), and letting Gradle install onto all of them (breaks one agent per emulator).
  (source: owner)
- D22: Every `android` command aimed at one emulator follows the one-agent rule (R11). Beat:
  only the four start, stop, install and run commands, leaving screen, layout and input
  unchecked. (source: owner)

## Out of scope
- Android MCP servers (mobile-mcp, Maestro and others): the owner left them for a later
  change (Q1). Their calls run unchecked; the emulators they use still show and count.
- Real phones over USB or Wi-Fi: intent constraint.
- Renaming AVDs: unsafe (D6).
- Android Studio builds holding agent builds (D9), and treating Studio's emulators as yours
  (D2).
- Gradle inside scripts taking a queue slot (D15).
- Other build front ends (Bazel, the Flutter or React Native command-line tools): they only
  count as outside builds, when they start a Gradle client.
- Installing or updating the SDK, system images or AVDs: "simaphore installs nothing".
- Linux and Windows: intent constraint.

## Scenarios to prove
- S1 → R5, R6, R7 · map: none · entry point: open `/simaphore`, boot an AVD by hand, plug in
  a USB phone if one is at hand · needs: Android SDK + an AVD
- S2 → R8, R9 · map: none · entry point: session A runs `adb -s emulator-5554 shell true`;
  session B runs `adb -s emulator-5554 install x.apk`, which waits until A lets go; then B
  runs a plain `adb install x.apk` with one emulator on · needs: Android SDK + an AVD + an APK
- S3 → R10, R17, R18 · map: none · entry point: limit 1, an emulator an agent used and left
  idle 10 minutes; B runs `emulator -avd Y`, which waits, the first emulator is shut down and
  Y boots · needs: Android SDK + two AVDs
- S4 → R11, R25 · map: none · entry point: S2 and S3 again with the `android` command's
  device commands; `android build` waits in the queue like S10 · needs: Android SDK + the
  `android` command + an AVD + an Android project
- S5 → R12 · map: none · entry point: B runs `adb kill-server` while A holds an emulator; it
  is refused · needs: Android SDK + an AVD
- S6 → R13 · map: none · entry point: end A's session; its emulator lease is gone within a
  round · needs: Android SDK + an AVD
- S7 → R14 · map: none · entry point: A holds a simulator, then claims an emulator; the panel
  shows A holding both · needs: Xcode + Android SDK + an AVD
- S8 → R15 · map: none · entry point: add an AVD name to "Your simulators"; an agent's `adb
  -s` on it is refused as reserved · needs: Android SDK + an AVD
- S9 → R19 · map: none · entry point: select an emulator row, press `s` twice · needs:
  Android SDK + an AVD
- S10 → R20, R22 · map: none · entry point: "Builds at once" 1; A's `xcodebuild` builds; B's
  `./gradlew assembleDebug` is listed in the Queue, waits, then runs with `--max-workers` ·
  needs: Xcode + Android SDK + an Android project
- S11 → R21 · map: none · entry point: B runs `./gradlew --version` and `./gradlew tasks`
  while the queue is full; both run at once · needs: Android SDK + an Android project
- S12 → R23 · map: none · entry point: after S10, with the Gradle daemon still alive, A's
  next `xcodebuild` starts at once; a `./gradlew assembleDebug` from a terminal counts as a
  running build · needs: Xcode + Android SDK + an Android project
- S13 → R24 · map: none · entry point: B's `./gradlew installDebug` waits while A holds the
  only emulator; with two emulators on, it installs only onto B's held one · needs: Android
  SDK + two AVDs + an Android project
- S14 → R26 · map: none · entry point: B runs a `run.sh` that calls `adb -s emulator-5554
  install` while A holds it; it exits 75 naming A · needs: Android SDK + an AVD
- S15 → R27 · map: none · entry point: close every panel and repeat S2, S10 and S14; all run
  as typed · needs: Android SDK + an AVD + an Android project
- S16 → R28, R29, R30, R31 · no user-visible surface on this Mac, which has Xcode: proven by
  sampler and hook tests that fake a Mac without Xcode · needs: none
- S17 → R1, R2, R3, R4 · no user-visible surface: existing tests and screenshot snapshots
  pass (changed only for D1's name), plus a test counting the commands a round runs · needs:
  none
- S18 → R32 · map: none · entry point: read the README, `docs/how-it-works.md` and both JSON
  descriptions · needs: none
- S19 → R16, R33, R34, R35 · no user-visible surface: after S10 and S13, `git status` in the
  Android project is clean and nothing under `~/.android` changed; the rest by review ·
  needs: Android SDK + an AVD + an Android project

## Resolved questions
- Q1 → Leave Android MCP servers for a later change (owner, 2026-11-02). Research for that
  change: mobile-mcp is the most used, and its device tools take a `device` field holding
  the serial; it often calls `adb` by full path, so only the tool call itself can be caught.
- Q2 → One shared limit (owner). See D1.
- Q3 → Names only (owner). See D2.
- Q4 → Same section (owner). See D3.
