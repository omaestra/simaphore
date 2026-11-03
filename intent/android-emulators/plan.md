# Plan: android-emulators

Approved: 2026-11-02 · spec: ./spec.md

## Approach
An emulator becomes one more device in simaphore's existing device machinery, keyed
`@<AVD name>` (`@Pixel_9`) and carrying an `android: {serial}` field. It uses the same lease
files, `xcsim`, shared limit, room rule, panel rows and `xcq` queue tickets, so most rules work
unchanged, and with no emulator on every iOS path is today's. All Android parsing lives in one
new pure module, `hooks/android.ts`, plus three PATH stand-ins; Gradle reaches the existing
queue through a small `bin/xcgradle` wrapper. Which commands a sampler round runs becomes a
pure `roundPlan`, so the "no SDK" and "no Xcode" rounds can be counted in a test. The obvious
alternative, a separate Android lease store, section and limit, was ruled out by D1, D3 and D5
and would copy every rule.

## Steps
- P1 → R1, R2, R7, R35 · pure Android basics: the R1 adb path order (`ANDROID_HOME`, then
  `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`), the emulator process parser (Mac
  `qemu-system-*` with `-avd X`), the `adb devices` parser (only `emulator-<port>` serials), the
  `emu avd name` parser, and the key check `^@[A-Za-z0-9._-]+$` · files: `hooks/android.ts`
  (new) · tests: `hooks/android.test.ts` (new)
- P2 → R2, R3, R4, R28 · pure D11 check `xcodeFound(developerDir, selectPath, hasSimctl)` and
  pure `roundPlan({hasSdk, hasXcode, emulatorProcs, newSerials, booting})`, returning one
  round's commands and host jobs: `du` and `plutil` only with Xcode, adb only while ps shows an
  emulator (D18), `emu avd name` once per new serial (D17) · files: `hooks/logic.ts` · tests:
  `hooks/collect.test.ts` (no SDK + Xcode = today's list exactly; no Xcode = no xcrun, simctl,
  plutil or DerivedData/CoreSim `du`; neither = the no-Xcode list, D20)
- P3 → R3, R5, R7, R17 · types and snapshot: `SimStat.android?`, `Snapshot.hasXcode?` (written
  only when false); `buildSnapshot` takes the emulators and merges them into `snap.sims`;
  `normalizeSnapshot` keeps both fields; with no emulators the snapshot is byte-identical to
  today's · files: `types/index.d.ts`, `hooks/logic.ts` · tests: `hooks/collect.test.ts`
- P4 → R1, R2, R5, R28, R31 · sampler wiring: the SDK file check through `$.env.get` and
  `$.fs.list`; today's `xcode-select -p` host job becomes the D11 check, awaited once before
  the first round and repeated every few minutes; each round runs exactly what `roundPlan`
  returns; booting state from `getprop sys.boot_completed`; emulators never enter the simctl
  `sims` map, so app lists, log streams and bootstatus skip them · files: `hooks/register.tsx` ·
  tests: none (register.tsx has no unit-test harness; its choices come from `roundPlan`, tested
  in P2, and S1 proves it live)
- P5 → R4, R13, R14, R16, R17, R31 · shell side of leases: `lib.sh` gains `AVD_RE`,
  `is_avd_key`, `emu_on` and `emu_count` (read ps, honor `XCQ_FAKE_PS`) and `has_xcode` (file
  check, never xcrun); `xcsim` accepts `@` keys without uppercasing them; `on` and `room` use
  ps; `room` = simulators (only when Xcode is found, otherwise 0 and never exit 76) plus
  emulators; `claim` on an `@` key skips the simulator list and renaming (D6) and checks
  reserved names; the free-other-lease loop frees only leases of the same kind; free and
  restore never rename `@` leases · files: `bin/lib.sh`, `bin/xcsim` · tests:
  `tests/xcsim-test.sh` (adds a no-Xcode case with `DEVELOPER_DIR` at an empty folder, a fake
  `HOME/.android` left byte-identical, one simulator plus one emulator held together; today's
  cases unchanged)
- P6 → R4, R13, R14, R15, R18 · `leases.ts`: `parseLease` accepts `@` keys; a Device with
  platform `Android` carries its serial; `suggestFree` works per platform; `freeReason` gains
  "AVD deleted"; the held, room, busy and reserved notes take a noun, with the iOS text
  unchanged · files: `hooks/leases.ts` · tests: `hooks/leases.test.ts`
- P7 → R13, R18, R19, R31 · lease upkeep and shutdowns: lease upkeep is split so emulator
  leases are freed without Xcode (session end, helper end, 10 minutes unused, switched off,
  and "AVD deleted" from a listing of `$ANDROID_AVD_HOME` or `~/.android/avd`); the room
  shutdown picks one victim across both kinds; the `s` key and room shutdown use the pure
  `shutdownArgv(device, adb)`, which gives `adb -s <serial> emu kill` for an emulator (D16) ·
  files: `hooks/register.tsx`, `hooks/android.ts` · tests: `hooks/android.test.ts`,
  `hooks/leases.test.ts`
- P8 → R3, R5, R6, R17, R29 · panel: title DEVICES while an emulator is on; the runtime column
  shows "Android" as the mark; the device count, pressure bar and over-limit warning count
  emulators, keeping today's text when none is on; with `hasXcode === false`, no CoreSim
  alert, no red or hung rows, no Xcode, CoreSim, DerivedData or sim-data host parts, and no `c`
  key · files: `hooks/model.ts`, `hooks/screen.tsx` · tests: `hooks/model.test.ts`,
  `hooks/screen.test.ts`
- P9 → R3, R4, R5, R6 · a new demo scene `android` (a simulator and an emulator, one held) with
  its snapshot; existing scenes and snapshots change only for the D1 name · files:
  `hooks/demo.fixture.ts`, `hooks/screen.snapshots.ts` · tests: `hooks/demo.test.ts`,
  `hooks/screen.snapshot.test.ts`
- P10 → R3, R15, R17 · settings text: "Simulator limit" and the /config title become
  "Simulator and emulator limit"; "Your simulators" help says it takes AVD names (D2); "Rename
  held simulators" help says iOS only (D6); "Compiler jobs" help mentions Gradle
  `--max-workers` (D10); the "Your simulators" picker lists running AVDs from `snap.sims` ·
  files: `hooks/settings.tsx`, `.claude-plugin/plugin.json` · tests: `hooks/settings.test.ts`,
  `hooks/screen.snapshot.test.ts`
- P11 → R7, R8, R9, R12 · adb parser, reading each command segment at command position: host
  verbs pass (devices, version, help, start-server, connect, pair, and disconnect, mdns,
  keygen, which act on no single emulator); kill-server and reconnect are fleet verbs; every
  other verb is a device verb; target = `-s`, then `ANDROID_SERIAL` (inline `VAR=`, `export`,
  then the session's env), then `-e` or no flag with exactly one emulator on; `-d`, `-t` and
  non-emulator serials pass · files: `hooks/android.ts` · tests: `hooks/android.test.ts`
- P12 → R10, R11 · `emulator` and `android` parsers: `emulator -avd X` or `@X` is a boot
  (`-list-avds`, `-help`, `-version` pass); `android [globals] emulator start [--cold]
  [--headless] X` is a boot, `emulator stop [X|serial]` a device op; `android install|run
  [--device=S] [ref|apks]` is a device op and marks whether it builds (a reference builds;
  `.apk` paths or `--apks` don't); `screen`, `layout`, `input`, `profiler` and `device hub` are
  device ops on their `--device` or the default emulator (D22) · files: `hooks/android.ts` ·
  tests: `hooks/android.test.ts`
- P13 → R4, R7, R8, R9, R10, R11, R12, R14, R15, R17, R27, R30, R31 · hook routing: pure
  `androidRoute(call, emulators, leases, me, settings)` decides pass, deny (reserved, with a
  free emulator suggested; or a fleet verb while another agent holds an emulator), wait in the
  background (held, or a boot with no room) or claim; `register.tsx` runs `xcsim claim @X`,
  wraps waits as `xcsim wait '@X' && <cmd>`, and acts only while a panel is on; the emulator
  list comes from the leader's last snapshot or `latest.json`, never from adb in the hook; with
  no Xcode, simulator commands pass instead of the "can't check" denial and the device list
  never runs xcrun · files: `hooks/android.ts`, `hooks/leases.ts`, `hooks/register.tsx` ·
  tests: `hooks/android.test.ts`, `hooks/leases.test.ts`
- P14 → R5, R18 · `activityOf` learns adb, emulator, android and Gradle (drive, install, boot,
  build, test), and the hook passes the resolved `@AVD` key as the activity's device, so "last
  used by" and agent-used times cover emulators · files: `hooks/logic.ts`,
  `hooks/register.tsx` · tests: `hooks/logic.test.ts`
- P15 → R20, R21, R22, R27, R34 · Gradle in Bash: the Gradle word (any path to `gradlew`, or
  `gradle`) is checked before the script rule; the pass-through words (`-v`, `--version`, `-h`,
  `--help`, `--stop`, `--status`, `tasks`, `help`) are not rewritten; otherwise the command
  becomes `<shim prefix> '<root>/bin/xcgradle' ./gradlew …`, run in the background with the
  queue note; `xcgradle` adds `--max-workers=$XCQ_JOBS` when missing, sets the kind
  (`connected*`/`test*` = test) and runs `exec xcq gradle-$$ <label> --`; `xcq` reads that kind
  · files: `hooks/logic.ts`, `bin/xcgradle` (new), `bin/xcq` · tests: `hooks/logic.test.ts`,
  `tests/gradle-test.sh` (new: a fake gradlew logs its args; the project folder stays
  unchanged; no `-I` or `--init-script`)
- P16 → R24, R34 · install and connected tasks: pure `gradleTarget(tasks, held, emulatorsOn)`
  picks the held emulator, else the only one on, else (two or more on, none held) refuses with
  a note listing the serials and asking for `ANDROID_SERIAL=<serial>` (D21); the hook adds
  `ANDROID_SERIAL=<serial> XCQ_SIM=@AVD`; `xcq` treats an `@` `XCQ_SIM` as the device to claim
  or wait for together with the slot, then touches its lease · files: `hooks/android.ts`,
  `hooks/register.tsx`, `bin/xcq` · tests: `hooks/android.test.ts`, `tests/xcq-test.sh`
- P17 → R11, R25 · `android build`, and `android run` with a reference, go through `xcgradle`
  into the queue (`run` also carries `XCQ_SIM` for its device); `android install`, and `run`
  with APKs, are device ops only · files: `hooks/logic.ts`, `hooks/android.ts`, `bin/xcgradle`
  · tests: `hooks/logic.test.ts`, `tests/gradle-test.sh`
- P18 → R23 · `outside_builds` also counts Gradle clients
  (`org.gradle.wrapper.GradleWrapperMain`, `org.gradle.launcher.GradleMain`) with no xcq above
  them, ignoring GradleDaemon, KotlinCompileDaemon and pass-through commands · files:
  `bin/lib.sh` · tests: `tests/xcq-test.sh` (`XCQ_FAKE_PS` lines)
- P19 → R7, R11, R12, R17, R26, R27, R33, R35 · stand-ins `adb`, `emulator` and `android`,
  sharing `emu_guard` and `real_tool` in `lib.sh`: `real_tool` finds the next one on PATH
  outside `bin/shim`, then the R1 SDK path, and exits 127 like a missing command when there is
  none; while on, a held or reserved target, a fleet verb, or a boot with no room exits 75 with
  one line naming the holder, otherwise the real tool runs; while off, the real tool runs at
  once · files: `bin/shim/adb` (new), `bin/shim/emulator` (new), `bin/shim/android` (new),
  `bin/lib.sh` · tests: `tests/shim-test.sh` (fakes through `XCQ_REAL_ADB`,
  `XCQ_REAL_EMULATOR`, `XCQ_REAL_ANDROID`)
- P20 → R32, R33, R34, R35 · docs: README opening, "What you need" (Xcode or the Android SDK),
  features, settings rows, keys and known limits (MCP servers, Android Studio builds, Gradle in
  scripts, permission rules that name `./gradlew`); `docs/how-it-works.md` with the `android`
  scene; the `plugin.json` and `marketplace.json` descriptions; `docs/under-the-hood.md` only
  once it is on `main` · files: `README.md`, `docs/how-it-works.md`,
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` · tests: none (docs; S18 is
  read by hand)
- P21 → R36, R16, R19 · live run of S1–S15 on this Mac (needs the SDK, two AVDs, the `android`
  command, an Android project and an APK; Xcode for S7, S10, S12) plus the S19 checks, and the
  facts still unconfirmed: qemu process name and `-avd` in its args for every way of starting
  an emulator, no double count from the `emulator` launcher, `emu avd name` output, boot state
  from `adb devices` and `sys.boot_completed`, AVD names fitting `[A-Za-z0-9._-]`, `emu kill`
  and the Quick Boot save, AGP honoring `ANDROID_SERIAL` (D14), `android build`/`run` showing a
  Gradle client in ps, how `android` picks a device without `--device`, the `--device` flag on
  `screen`, `layout` and `input`, idle CPU of an idle emulator against the 2% rule, the SDK
  found with `ANDROID_HOME` unset, `--max-workers` winning over `org.gradle.workers.max`,
  permission prompts from the `./gradlew` rewrite · files:
  `intent/android-emulators/live-run.md` (new, results) · tests: the live run itself

## Order
P1 → P2 → P3 → P4 → P5 → P6 → P7 → (P8 ‖ P10) → P9 → P11 → P12 → P13 → P14 → P15 → P16 → P17
→ (P18 ‖ P19) → P20 → P21

## Out of plan
- A separate Android section, lease store or limit: D1, D3 and D5; it would copy every rule.
- Keying leases by serial: D5 (a serial passes to the next emulator on that port).
- Running adb inside the hook on each tool call: too slow, and a hook failure denies the call;
  the leader's snapshot or `latest.json` is enough, and unknown serials pass.
- A gradle stand-in, a Gradle init script, or edits to `gradle.properties`: D15 and R34.
- Counting a busy Gradle daemon, or Android Studio builds holding agent builds: D8 and D9.
- Recognizing Gradle Managed Devices: D19 (they are ordinary emulators).
- Gradle builds as build-tree rows (pause and resume, the header's build count): no
  requirement asks for it, and the tree carries Xcode-only fields. Deferred.
- xcwatch change events for emulators: polling meets R5's 2 rounds. Deferred.
- API level in the row, and shut-down AVDs in the list or picker: not required, and each costs
  an extra adb call or file read. Deferred.
- Android MCP servers: Q1. Real phones: R7.

## Departures
- P2: the D11 check is split in two. The pure part is `developerFolder` plus `simctlIn` in
  `logic.ts`, and the file check itself runs in `register.tsx`. `roundPlan` takes
  `{hasSdk, hasXcode, emulatorCount, adb}` and returns the simctl and plutil gates, the host
  jobs and `adb devices`. The per-serial calls (`emu avd name`, `getprop`) come from
  `adbFollowUps` in `android.ts`, because they need that round's `adb devices` answer.
- P4: the SDK check uses `$.fs.exists` instead of `$.fs.list`; it is the same file check.
  With no SDK, emulators are not listed at all and the qemu process stays an ordinary one,
  which R3 needs. A session that is not the sampler runs its own check once, then follows
  the sampler's `hasXcode` in `latest.json`. A failed `adb devices` call keeps the last list
  rather than forgetting every serial.
- P5: `has_xcode` guards every simulator-list read in `xcsim`, not just `room`. Because of
  that, `restore` and `claim` never run `xcrun` on a Mac without Xcode either. `tests/lib.sh`
  is changed too: `make_fake_simctl` points `DEVELOPER_DIR` at a stand-in Xcode folder, so
  "Xcode is found" never depends on the Mac the tests run on. The reserved-file check now
  matches exact text (`grep -F`), so a `.` in an AVD name is not read as a pattern.
  `xcsim wait` says "emulator" for an `@` key, and its room message says "devices"
  (simulator text unchanged).
- P6: `emulatorDevice` turns a running emulator into a Device here, so the sampler and the
  hook build it the same way. `booted` (simctl's word) now means the holder's simulator
  lease only, never the emulator lease they may also hold (R14). Activities and tickets
  naming an `@` key count as using that emulator, so "busy" and "10 minutes unused" work for
  emulator leases (R13). `freeReason` checks "AVD deleted" only when the AVD list could be
  read, and never "simulator deleted" for an `@` key. `roomNote` takes the plural word, so
  the hook can say "devices" while an emulator is on. The emulator refusal names the free
  one by its adb serial, and with none free it says "held or the owner's", since emulators
  that are off are never offered.
- P7: The AVD folder follows the SDK's own order (`ANDROID_AVD_HOME`, then `avd` under
  `ANDROID_EMULATOR_HOME` or `ANDROID_USER_HOME`, then `~/.android/avd`), not just the first
  and last, so a moved AVD home does not free every emulator lease as "AVD deleted". A running
  emulator's AVD always counts as existing, whatever the folder says. A stopped emulator
  forgets when agents used it, so if the owner starts it again it is never a room victim until
  an agent uses it again. With Xcode, room is made on the rounds that read the simulator list,
  as today (R4); without Xcode, every round while an emulator is on. After `emu kill`,
  simaphore waits up to 30 s while that emulator is still running before choosing another
  victim, so one slot never costs two devices. "Shut down all idle" goes through
  `shutdownArgv` too, so it reaches idle emulators the same way as `s` (P21 checks an idle
  emulator's CPU).
- P8: The host line without Xcode keeps disk space and the SPM cache (neither needs Xcode),
  and its heading reads "disk space". The CoreSim state and `simctlOk` count only when Xcode is
  found, so an old failed reading can't turn rows red after Xcode is gone. The detail line
  still shows the key (`udid @Pixel_9`); it is the AVD key, so it stays as it is.
- P10: The settings label column grows from 26 to 29 cells (3/8 of the width, up from 1/3), so
  "Simulator and emulator limit" fits from 80 columns. The four changed help lines are written
  to fit in 76 cells, so an 80-column pane shows them in full. The picker needed no code: an
  emulator's row in `snap.sims` already carries its AVD name. The plan named
  `screen.snapshot.test.ts`, but there is no settings snapshot there, so the test is in
  `settings.test.ts`, and `docs/images/settings.svg` is redrawn by `scripts/shots.sh`.
- P9: The `android` scene sets the limit to 3, so the picture shows a calm Mac (67%) rather
  than one at its limit. No existing snapshot changed: the panel never prints the limit's
  name, so D1 shows only in settings. `/simaphore demo android` picks the scene up with no
  other change.
- P11: `adbCalls` takes the command already cut into segments, because `android.ts` imports
  nothing and the splitter (`segmentsOf`, which drops heredoc bodies) lives in `leases.ts`;
  P13 passes it in. The command word may sit behind `VAR=` assignments, `env`, `command`,
  `exec`, `time`, `nohup` or `timeout N`, and may be any path ending in `adb`. Host verbs
  also take `track-devices`, `--version` and `--help`, and a flag in the verb's place (adb only
  prints its usage). `-s` and `-t` also work glued (`-semulator-5554`). `unset
  ANDROID_SERIAL` and a bare `ANDROID_SERIAL=…` segment change the serial for later segments,
  like `export`. `reconnect` is a fleet verb even with `-s`, as R12 says.
- P12: `emulatorCalls(segments, emulators)` takes segments for the same reason as P11, plus the
  serials of the emulators on, so "the default emulator" (the only one on) is decided here.
  `android emulator stop` of a word that is neither a serial nor an AVD name gives no call, the
  same as `start`. A `-h` or `--help` anywhere before a bare `--` counts as asking for help.
- P13: `androidRoute` (the pure part of the routing) lives in `leases.ts`, next to `routeLease`'s
  helpers, because `android.ts` imports nothing. An adb call has no AVD name, only a serial; the
  route finds the running emulator by serial, and a call with neither matches nothing, so a
  booting emulator with no serial yet is never claimed by mistake (R7). Without Xcode the hook
  also skips the "all simulators" refusal, because simctl then runs as typed (R30). When one
  command must wait for several devices, the waits are nested, one per key. If a later step
  refuses the call, the leases this call just took are given back, including a simulator lease
  taken by the same command. If the Android routing itself fails, the command runs as typed.
  The hook says "devices" instead of "simulators" in room notes whenever an emulator is on.
- P14: `segmentsOf` moves from `leases.ts` to `logic.ts` (exported), so the activity reader can
  split commands without `logic.ts` importing `leases.ts`. `matchesSim`, `findSim` (in
  `hooks/rows.ts`, not in the step's file list) and `sharedSims` compare an `@` key exactly
  instead of upper-casing it like a UDID, so "last used by" works for emulators. Android
  activities never use the kind `drive`, because a drive activity inherits the last iOS device
  it drove; they use verify, launch, install, boot, run, build and test instead. Gradle tasks
  outside the listed ones (`clean`, `lint`) and adb verbs outside the listed ones (`forward`,
  `reverse`, `root`, …) give no activity of their own; a later task in the same command decides
  the kind. `installDebugAndroidTest` counts as install. `android emulator stop <name>` records
  `@name` as the device. When an Android activity names no `@` key itself (an adb call by
  serial or with no target), the hook gives it the first key the routing claimed or waited
  for — only when the activity names no device, so an iOS activity in the same command keeps
  its simulator. The `android@80` and `android@120` snapshots were regenerated, because the
  panel now shows the agent using the emulator. Tests also landed in `hooks/model.test.ts` and
  `hooks/rows.test.ts`; the key handoff in `register.tsx` has no unit harness and is checked by
  `tsc` and the scene snapshots only.
- P15: `queueGradle` walks the original text (`rawSegments`) and keeps each word's offset, so
  only `'<root>/bin/xcgradle' ` is inserted and the rest of the command stays as typed. It also
  splits at a single `&` and at `(`/`)`, so `a & ./gradlew build` and `$(./gradlew …)` are
  queued; after `env`, `command`, `exec`, `time`, `nohup` or `timeout N` the insertion goes
  right before the Gradle word. Gradle inside quotes (`sh -c './gradlew build'`), inside
  backticks, or run as `sh gradlew …` is not queued; `outside_builds` still counts it (R23).
  `waitForSim` queues Gradle too, so a Gradle call in a command that waits for a device still
  takes a slot. One helper, `gradleTasks`, holds the pass-through rule for both the activity
  and the rewrite, and the heredoc rule matches `stripHeredocs`. `xcgradle` tells `xcq` the
  kind through `XCQ_KIND` (`test` for `test*` and `connected*` tasks, read after the last `:`,
  else `build`); `xcq` accepts only a known kind word there. `--max-workers N` written as two
  words counts as given. Gradle commands now start with the shim prefix and `xcgradle`, so
  Claude Code may ask permission for them, as it already does for prefixed `xcodebuild`.
- P18: the pass-through rule in `outside_builds` (an info or stop flag, or no task besides
  `tasks`/`help`) is the hook's `GRADLE_PASS` and `gradleTasks` rule written again in awk,
  because `lib.sh` can't use the hook's code.
- P19: the stand-ins share `emu_guard`, `emu_fleet_guard` (for `kill-server` and
  `reconnect`), `emu_avd_of` (asks the real adb for an emulator's AVD name and gives up after
  about 3 seconds) and `emu_default` (the only emulator on). With `-e`, or no target and one
  emulator on, the AVD comes from the process list without an adb call. A device command on an
  AVD that is on and free claims it; booting an AVD that is already on skips the room check and
  goes straight to the claim. The no-room note uses the count `xcsim room` prints, which
  includes booted simulators, because the limit is shared (D1). An empty `ANDROID_SERIAL` counts
  as unset, as in the hook. `real_tool` skips empty PATH entries, wants a regular executable
  file, and skips any simaphore stand-in folder (one with `../lib.sh` and `../xcsim` next to
  it), not only its own, so two installed copies never call each other. The `kill-server`
  refusal reads "simaphore: <what> would stop emulator <AVD> held by <label>; wait or leave it".
- P16: the hook passes the target as words right after `xcgradle`, not as an assignment in
  front of the command: `'<root>/bin/xcgradle' ANDROID_SERIAL='<serial>' XCQ_SIM='@<AVD>'
  ./gradlew installDebug`. An assignment breaks after `nohup`, `exec` or `timeout`, and an
  `export` would leak into an `xcodebuild` in the same command. `xcgradle` takes the words off
  before anything else (also when simaphore is off or the call is already queued), exports
  `ANDROID_SERIAL`, and hands `XCQ_SIM` to `xcq` only, so Gradle never sees it. `xcq` reads
  `XCQ_KIND` and `XCQ_SIM` once and unsets both, so the build's children don't inherit them; an
  `@` key gates the ticket for every kind (a simulator still only for tests), and its messages
  say "emulator held by …", "emulator is reserved" and "N devices on". The serial the pick
  starts from is the call's own `ANDROID_SERIAL=`, else the session's, with empty counted as
  unset; a serial that names no emulator that is on passes. Two or more held emulators on is
  refused like two or more on and none held. In one command a refusal wins over a pick, and
  Gradle calls that would install onto different emulators are refused with "simaphore: these
  Gradle calls install onto different emulators. Run them one at a time." The target's key is
  the device's id (`@<AVD>`). The Gradle call finder is shared with P15's queue rewrite, and
  the activity's device falls back to the target's key when nothing else names one, so the
  panel shows the agent on that emulator. `register.tsx` also builds the list of emulators on
  for P17. The "N devices on, waiting for room" path has no test: an emulator that is on always
  has room, and the hook only targets one that is on.
- P17: `queueSites` replaces P15's Gradle-only finder and also finds `android build` and
  `android run` (when it builds, so no APKs), through `androidParts`, which `androidCallOf`
  now shares (global options such as `--sdk X`, help and version, own words cut at `--`).
  `android run` gets only `XCQ_SIM='@<AVD>'` for the emulator whose serial it names or defaults
  to, never `ANDROID_SERIAL`, and no `XCQ_SIM` when there is no single emulator. The list of
  emulators on is filled in `hooks/register.tsx`, outside P17's file list. For the `android`
  program `xcgradle` adds no `--max-workers` (the command has none) and the kind is always
  `build`.
- P20: `CONTRIBUTING.md` also changed, though it is not in P20's file list: it now runs
  `bash tests/gradle-test.sh` and names `android.ts`, `xcgradle` and the new stand-ins in its
  layout. The README's known limits also say an idle Gradle daemon is not counted (D8) and that
  Claude Code may ask before running Gradle (P15). `docs/how-it-works.md` gained "Android
  emulators" and "Gradle and the android command" sections. The README's switch-on answer stays
  simulators only: switching on holds the simulators agents were using, not emulators (no
  requirement asks for it). No screenshot of the `android` scene was added; `scripts/shots.ts`
  is outside P20's file list, so the docs point to `/simaphore demo android` instead.
