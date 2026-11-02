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
- none
