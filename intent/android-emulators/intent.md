# Intent: android-emulators

Authored: 2026-11-02 · branch: feature/android-emulators · captured: /intent

## Problem
> "Add android simulator support on simaphore"
> Why: "Reach more users" · Who: "Android-only works too"

simaphore only knows iOS. Android emulators, `adb` and Gradle builds are invisible to it, so
people who build for Android on a Mac get none of its order: no view of who uses which
emulator, no one-agent-per-emulator rule, no limit on how many run, no build queue. There is
no Android pain on this Mac today; the point is to make the plugin useful to more people.

## Outcome
Someone building for Android on a Mac, alongside iOS or on its own, gets the same traffic
lights for Android emulators that iOS simulators get today:

- Running emulators show in the panel, with which agent is using each one.
- One agent per emulator: others wait or are told to pick another one.
- Emulators count toward the "on at once" limit, and an idle one an agent used can be shut
  down to make room.
- Android builds (Gradle) wait their turn in the same build queue as `xcodebuild`.
- Agents are caught whichever way they work: `adb` and `emulator` in Bash, Gradle, scripts
  that call them, and an Android MCP server.
- On a Mac without Xcode, simaphore works as an Android-only tool. The iOS parts stay quiet
  instead of showing as broken.
- The README and the plugin's description say it covers Android.

## Affected
- users: people who build for Android on a Mac, for both platforms or Android only. Existing
  iOS-only users must notice nothing.
- systems: the hook module (`hooks/register.tsx`: tool-call hook, sampler, panel); the rules
  (`hooks/logic.ts`, `leases.ts`, `builds.ts`, `model.ts`); the drawing (`screen.tsx`,
  `settings.tsx`); the helpers (`bin/xcq`, `bin/xcsim`, `bin/lib.sh`, `bin/shim/`); `xcwatch`;
  settings and description in `.claude-plugin/plugin.json`; README and `docs/`; `tests/`; the
  demo scenes and screenshots.

## Constraints
- iOS behavior is unchanged. On a Mac without the Android SDK, simaphore behaves exactly as
  today: no new rows, alerts or slower rounds.
- Off means off for Android too: while no panel is open, Android commands run exactly as typed.
- Emulators only. Real Android phones over USB are left alone, as real iPhones are today.
- No new dependency. Only tools the user already has (the SDK's `adb` and `emulator`, the
  project's Gradle wrapper). simaphore installs nothing.
- Still nothing written into projects: no edits to `gradle.properties` or build files.
- Still a Mac plugin.
- Proven on a real emulator on this Mac before merging. The owner installs the Android SDK
  for that.

## Open questions
- Q1 (blocking: yes): Which Android MCP server(s) must be covered? The owner hasn't picked
  one yet. — options: research the common ones and pick in the spec / mobile-mcp / Maestro /
  leave MCP for a later change
- Q2 (blocking: yes): One shared "on at once" limit for simulators and emulators, or one
  limit each? — options: shared / separate
- Q3 (blocking: yes): Does "your simulators stay yours" cover emulators too: names in the
  "Your simulators" setting, and an emulator you're debugging in Android Studio? — options:
  both / names only / neither
- Q4 (blocking: no): In the panel, do emulators share the Simulators section or get their
  own? — options: shared section / own section
