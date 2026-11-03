// Pure Android helpers for simaphore: no `$`, so they can be unit-tested on fixtures.
// An emulator is a device keyed `@<AVD name>` (D5); its adb name is `emulator-<port>`.

/** An AVD name as the SDK allows it. Keeps keys safe in file names and shell text. */
export const AVD_NAME_RE = /^[A-Za-z0-9._-]+$/
/** A device key for an emulator: `@` and its AVD name. */
export const AVD_KEY_RE = /^@[A-Za-z0-9._-]+$/
/** Only these serials are emulators; phones over USB or Wi-Fi never match (R7). */
export const EMULATOR_SERIAL_RE = /^emulator-\d+$/

export const isAvdName = (name: string) => AVD_NAME_RE.test(name)
export const isAvdKey = (key: string) => AVD_KEY_RE.test(key)
export const isEmulatorSerial = (serial: string) => EMULATOR_SERIAL_RE.test(serial)
export const avdKey = (avd: string) => `@${avd}`
export const avdOfKey = (key: string) => (isAvdKey(key) ? key.slice(1) : undefined)

/** SDK folders to look in, in R1's order: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then the Mac default. */
export function sdkRoots(env: { ANDROID_HOME?: string; ANDROID_SDK_ROOT?: string }, home: string): string[] {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, `${home}/Library/Android/sdk`]
    .map(r => (r ?? '').trim().replace(/\/+$/, ''))
    .filter(r => r !== '')

  return [...new Set(roots)]
}

export const adbIn = (sdk: string) => `${sdk}/platform-tools/adb`

/** One running emulator, from the process list. */
export type EmulatorProc = { pid: number; avd: string }

/** The AVD a process runs, when it is the emulator itself (`qemu-system-*` with `-avd X` or `@X`). */
export function avdOfCommand(command: string): string | undefined {
  const words = command.trim().split(/\s+/)
  const prog = (words[0] ?? '').replace(/.*\//, '')
  if (!/^qemu-system-[A-Za-z0-9_-]+$/.test(prog)) return undefined
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!
    const name = w === '-avd' ? words[i + 1] : w.startsWith('@') ? w.slice(1) : undefined
    if (name !== undefined) return isAvdName(name) ? name : undefined
  }

  return undefined
}

/** Running emulators. The `emulator` launcher is not counted, so one emulator is never two. */
export function emulatorProcs(procs: { pid: number; command: string }[]): EmulatorProc[] {
  const out: EmulatorProc[] = []
  for (const p of procs) {
    const avd = avdOfCommand(p.command)
    if (avd !== undefined) out.push({ pid: p.pid, avd })
  }

  return out
}

/** One line of `adb devices`, emulators only. */
export type AdbDevice = { serial: string; state: string }

/**
 * `adb devices [-l]` output to its emulators; phones and the daemon's `*` lines are dropped.
 * Undefined when adb gave no list at all (failed or timed out), so one bad call forgets nothing.
 */
export function parseAdbDevices(text: string): AdbDevice[] | undefined {
  if (!text.includes('List of devices attached')) return undefined
  const out: AdbDevice[] = []
  for (const line of text.split('\n')) {
    const [serial, state] = line.trim().split(/\s+/)
    if (serial && state && isEmulatorSerial(serial)) out.push({ serial, state })
  }

  return out
}

/**
 * After `adb devices`, the rest of a round's adb calls: the AVD name of each serial not known yet
 * (asked once, D17; asked again when the remembered name no longer runs, since a port passes to the
 * next emulator), and the boot state of each one that answers but is not up yet.
 */
export function adbFollowUps(
  adb: string,
  devices: AdbDevice[],
  names: ReadonlyMap<string, string>,
  ready: ReadonlySet<string>,
  running: ReadonlySet<string>,
): string[][] {
  const out: string[][] = []
  for (const d of devices) {
    const name = names.get(d.serial)
    if (name === undefined || !running.has(name)) out.push([adb, '-s', d.serial, 'emu', 'avd', 'name'])
    if (d.state === 'device' && !ready.has(d.serial)) out.push([adb, '-s', d.serial, 'shell', 'getprop', 'sys.boot_completed'])
  }

  return out
}

/** `getprop sys.boot_completed` prints 1 once Android has finished booting. */
export const isBootCompleted = (text: string) => text.trim() === '1'

/** `adb -s S emu avd name` output ("Pixel_9", then "OK") to the AVD name, or undefined. */
export function parseAvdName(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  if (lines.length < 2 || lines[lines.length - 1] !== 'OK') return undefined
  const name = lines[0]!

  return isAvdName(name) ? name : undefined
}

/** Each running emulator with the serial whose remembered AVD name is its own, and whether it finished booting. */
export function pairEmulators(
  procs: EmulatorProc[],
  devices: AdbDevice[],
  names: ReadonlyMap<string, string>,
  ready: ReadonlySet<string>,
): { avd: string; pid: number; serial?: string; isReady: boolean }[] {
  return procs.map(p => {
    const serial = devices.find(d => names.get(d.serial) === p.avd)?.serial

    return serial === undefined ? { ...p, isReady: false } : { ...p, serial, isReady: ready.has(serial) }
  })
}

/**
 * The AVD folder the SDK uses, in its own order: `ANDROID_AVD_HOME`, else `avd` under
 * `ANDROID_EMULATOR_HOME` or `ANDROID_USER_HOME`, else `~/.android/avd`. Only ever listed (R16).
 */
export function avdFolder(
  env: { ANDROID_AVD_HOME?: string; ANDROID_EMULATOR_HOME?: string; ANDROID_USER_HOME?: string },
  home: string,
): string {
  const clean = (p?: string) => (p ?? '').trim().replace(/\/+$/, '')
  const avdHome = clean(env.ANDROID_AVD_HOME)
  if (avdHome !== '') return avdHome
  const parent = [env.ANDROID_EMULATOR_HOME, env.ANDROID_USER_HOME].map(clean).find(p => p !== '')

  return `${parent ?? `${home}/.android`}/avd`
}

/** The device keys of the AVDs a listing of the AVD folder names: each `<name>.ini` and `<name>.avd`. */
export function avdKeysIn(entries: string[]): Set<string> {
  const out = new Set<string>()
  for (const entry of entries) {
    const m = /^(.+)\.(ini|avd)$/.exec(entry)
    if (m && isAvdName(m[1]!)) out.add(avdKey(m[1]!))
  }

  return out
}

/**
 * The command that shuts a device down: `adb -s <serial> emu kill` for an emulator (D16),
 * `xcrun simctl shutdown <udid>` for a simulator. Undefined for an emulator without a serial or adb.
 */
export function shutdownArgv(device: { udid: string; serial?: string }, adb?: string): string[] | undefined {
  if (!isAvdKey(device.udid)) return ['xcrun', 'simctl', 'shutdown', device.udid]
  if (device.serial === undefined || !isEmulatorSerial(device.serial) || adb === undefined) return undefined

  return [adb, '-s', device.serial, 'emu', 'kill']
}

// ---------- reading commands (P11, P12) ----------
// These take the command already cut into segments (leases.ts `segmentsOf`, which drops heredoc
// bodies), because android.ts imports nothing. Each segment is read at command position only, so
// `echo adb shell` or `grep adb log.txt` is never an adb run.

/** One segment as the shell splits it into words: quotes and backslashes removed, `#` comments dropped. */
export function shellWords(segment: string): string[] {
  const out: string[] = []
  let word = ''
  let hasWord = false
  let quote = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    if (quote === "'") {
      if (ch === "'") quote = ''
      else word += ch
    } else if (quote === '"') {
      if (ch === '"') quote = ''
      else if (ch === '\\' && '"\\$`'.includes(segment[i + 1] ?? '')) word += segment[++i]
      else word += ch
    } else if (ch === '\\') {
      // A backslash before a newline joins the lines; before anything else it keeps that character.
      if (segment[i + 1] !== '\n' && i + 1 < segment.length) {
        word += segment[i + 1]
        hasWord = true
      }
      i++
    } else if (ch === "'" || ch === '"') {
      quote = ch
      hasWord = true
    } else if (/\s/.test(ch)) {
      if (hasWord) out.push(word)
      word = ''
      hasWord = false
    } else if (ch === '#' && !hasWord) {
      break
    } else {
      word += ch
      hasWord = true
    }
  }
  if (hasWord) out.push(word)

  return out
}

const ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/
/** Words that run the next word as the command: `env`, `command`, `exec`, `time`, `nohup`, `timeout N`. */
const RUNS_NEXT = new Set(['env', 'command', 'exec', 'time', 'nohup'])

/** The words from the command word on, and the `VAR=value` assignments made for this command alone. */
export function atCommand(words: string[]): { vars: Record<string, string>; rest: string[] } {
  const vars: Record<string, string> = {}
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    const m = ASSIGNMENT_RE.exec(w)
    if (m) vars[m[1]!] = m[2]!
    else if (w === 'timeout' || w === 'gtimeout') i++
    else if (!RUNS_NEXT.has(w) && w !== '(' && w !== '{' && w !== '!') break
    i++
  }
  const rest = words.slice(i)
  if (rest[0] !== undefined) rest[0] = rest[0].replace(/^[({]+/, '')

  return { vars, rest }
}

/** True when a word runs a program of this name, by any path (`adb`, `$ANDROID_HOME/platform-tools/adb`). */
export const isProgram = (word: string | undefined, name: string) => word !== undefined && word.replace(/.*\//, '') === name

/** adb verbs that act on no single emulator, so they always run (R8). */
const ADB_HOST_VERBS = new Set([
  'devices', 'version', 'help', 'start-server', 'connect', 'pair', 'disconnect', 'mdns', 'keygen',
  'track-devices', '--version', '--help',
])
/** adb verbs that hit every device (R12). */
const ADB_FLEET_VERBS = new Set(['kill-server', 'reconnect'])
/** adb options that take the next word as their value. */
const ADB_VALUE_OPTIONS = new Set(['-H', '-P', '-L', '--one-device'])

/**
 * One adb run. `host` verbs always run; `fleet` verbs hit every device; a `device` verb acts on
 * `serial`, the emulator it targets, or on no emulator at all (a phone, `-d`, `-t`, or no single
 * emulator to default to) when `serial` is missing, and then it runs as typed (R7).
 */
export type AdbCall = { verb: string; kind: 'host' | 'fleet' | 'device'; serial?: string }

/** What adb would read besides the command: `ANDROID_SERIAL` from the session, and the emulators on. */
export type AdbContext = { serial?: string; emulators: string[] }

/** The target the way adb picks it (R9): `-s`, then `ANDROID_SERIAL`, then `-e` or no flag with one emulator on. */
function adbCallOf(args: string[], envSerial: string | undefined, emulators: string[]): AdbCall {
  let serial: string | undefined
  let isOtherTransport = false
  let i = 0
  for (; i < args.length; i++) {
    const a = args[i]!
    if (a === '-s' || a === '-t' || ADB_VALUE_OPTIONS.has(a)) {
      if (a === '-s') serial = args[i + 1]
      if (a === '-t') isOtherTransport = true
      i++
    } else if (/^-[st]./.test(a)) {
      if (a[1] === 's') serial = a.slice(2)
      else isOtherTransport = true
    } else if (a === '-d') {
      isOtherTransport = true
    } else if (!(a === '-e' || a === '-a' || /^-[HPL]./.test(a) || a === '--exit-on-write-error')) {
      break
    }
  }
  const verb = args[i] ?? ''
  if (verb === '' || ADB_HOST_VERBS.has(verb) || verb.startsWith('-')) return { verb, kind: 'host' }
  if (ADB_FLEET_VERBS.has(verb)) return { verb, kind: 'fleet' }
  const target = serial ?? (isOtherTransport ? undefined : envSerial ?? (emulators.length === 1 ? emulators[0] : undefined))

  return target !== undefined && isEmulatorSerial(target) ? { verb, kind: 'device', serial: target } : { verb, kind: 'device' }
}

/**
 * Every adb run in a command, in order (P11). `ANDROID_SERIAL` is read from an inline `VAR=`, then
 * from an earlier `export` or `unset` in the same command, then from the session's environment.
 */
export function adbCalls(segments: string[], context: AdbContext): AdbCall[] {
  let envSerial = context.serial
  const calls: AdbCall[] = []
  for (const segment of segments) {
    const { vars, rest } = atCommand(shellWords(segment))
    const head = rest[0]
    if (head === undefined) {
      if ('ANDROID_SERIAL' in vars) envSerial = vars.ANDROID_SERIAL
    } else if (head === 'export') {
      for (const w of rest.slice(1)) {
        const m = ASSIGNMENT_RE.exec(w)
        if (m?.[1] === 'ANDROID_SERIAL') envSerial = m[2]
      }
    } else if (head === 'unset') {
      if (rest.includes('ANDROID_SERIAL')) envSerial = undefined
    } else if (isProgram(head, 'adb')) {
      calls.push(adbCallOf(rest.slice(1), vars.ANDROID_SERIAL ?? envSerial, context.emulators))
    }
  }

  return calls
}

/**
 * One `emulator` or `android` run aimed at an emulator (R10, R11). A `boot` starts `avd`. A `device`
 * call acts on `serial` or `avd`, or on no emulator at all (a phone, or no single emulator on) and
 * then runs as typed (R7). `builds` is set on `android install` and `run`: true unless given APKs.
 */
export type EmulatorCall = { verb: string; kind: 'boot' | 'device'; avd?: string; serial?: string; builds?: boolean }

/** The emulator a command aims at when it names none: the only one on. */
const defaultTarget = (emulators: string[]): { serial?: string } => (emulators.length === 1 ? { serial: emulators[0]! } : {})

/** The target of a `--device` value: an emulator serial, or none for a phone or no value and no single emulator. */
const deviceTarget = (device: string | undefined, emulators: string[]): { serial?: string } =>
  device === undefined ? defaultTarget(emulators) : isEmulatorSerial(device) ? { serial: device } : {}

/** The value of `--name=v` or `--name v`. */
function optionValue(words: string[], name: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    if (words[i] === name) return words[i + 1]
    if (words[i]!.startsWith(`${name}=`)) return words[i]!.slice(name.length + 1)
  }

  return undefined
}

/** `emulator` options that print and exit. */
const EMULATOR_INFO_RE = /^--?(list-avds|help(-.*)?|version|accel-check)$/

/** An `emulator` run: a boot of the AVD in `-avd X` or `@X`, unless it only prints. Everything after `-qemu` is qemu's. */
function emulatorBootOf(args: string[]): EmulatorCall | undefined {
  let avd: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-qemu') break
    if (EMULATOR_INFO_RE.test(a)) return undefined
    if (a === '-avd' || a === '--avd') avd = args[++i]
    else if (a.startsWith('@')) avd = a.slice(1)
  }

  return avd !== undefined && isAvdName(avd) ? { verb: 'emulator', kind: 'boot', avd } : undefined
}

/** `android` commands that act on a device and take `--device`, without the APK handling of install and run. */
const ANDROID_DEVICE_COMMANDS = new Set(['screen', 'layout', 'input', 'profiler'])
/** `android install` and `run` options that take the next word when written without `=`. */
const ANDROID_VALUE_OPTIONS = new Set(['--device', '--apks', '--activity', '--install-options', '--type'])

/** True when install or run is given APKs (`--apks`, or a word ending `.apk`/`.apks`), so it builds nothing. */
function hasApks(words: string[]): boolean {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--apks' || w.startsWith('--apks=')) return true
    if (w.startsWith('-')) {
      if (ANDROID_VALUE_OPTIONS.has(w)) i++
    } else if (/\.apks?$/i.test(w)) {
      return true
    }
  }

  return false
}

/** An `android` run split into its command and that command's own words; none for help, version or no command. */
function androidParts(args: string[]): { command: string; own: string[] } | undefined {
  let i = 0
  for (; args[i]?.startsWith('-'); i++) {
    if (['-h', '--help', '-V', '--version'].includes(args[i]!)) return undefined
    if (args[i] === '--sdk') i++
  }
  const command = args[i]?.toLowerCase()
  // Words after a bare `--` are build arguments.
  const after = args.slice(i + 1)
  const own = after.includes('--') ? after.slice(0, after.indexOf('--')) : after
  if (command === undefined || own.includes('-h') || own.includes('--help')) return undefined

  return { command, own }
}

/** An `android` run: its global options, then the command, read for the emulator it aims at. */
function androidCallOf(args: string[], emulators: string[]): EmulatorCall | undefined {
  const parts = androidParts(args)
  if (parts === undefined) return undefined
  const { command, own } = parts
  const device = deviceTarget(optionValue(own, '--device'), emulators)
  if (command === 'install' || command === 'run') return { verb: command, kind: 'device', ...device, builds: !hasApks(own) }
  if (ANDROID_DEVICE_COMMANDS.has(command)) return { verb: command, kind: 'device', ...device }
  const sub = own[0]?.toLowerCase()
  if (command === 'device') return sub === 'hub' ? { verb: 'device hub', kind: 'device', ...device } : undefined
  if (command !== 'emulator') return undefined
  const name = own.slice(1).find(w => !w.startsWith('-'))
  if (sub === 'start') return name !== undefined && isAvdName(name) ? { verb: 'emulator start', kind: 'boot', avd: name } : undefined
  if (sub !== 'stop') return undefined
  if (name === undefined) return { verb: 'emulator stop', kind: 'device', ...defaultTarget(emulators) }
  if (isEmulatorSerial(name)) return { verb: 'emulator stop', kind: 'device', serial: name }

  return isAvdName(name) ? { verb: 'emulator stop', kind: 'device', avd: name } : undefined
}

/**
 * An `android` run that waits in the build queue (R25): `build`, or `run` that builds. A `run` carries
 * the serial of the emulator it targets, if one. `args` are the words after `android`; `emulators` the serials on.
 */
export function androidQueued(args: string[], emulators: string[]): { verb: 'build' } | { verb: 'run'; serial?: string } | undefined {
  if (androidParts(args)?.command === 'build') return { verb: 'build' }
  const call = androidCallOf(args, emulators)
  if (call?.verb !== 'run' || !call.builds) return undefined

  return { verb: 'run', ...(call.serial && { serial: call.serial }) }
}

/** Every `emulator` or `android` run aimed at an emulator in a command, in order (P12). `emulators` are the serials on. */
export function emulatorCalls(segments: string[], emulators: string[]): EmulatorCall[] {
  const calls: EmulatorCall[] = []
  for (const segment of segments) {
    const rest = atCommand(shellWords(segment)).rest
    const call = isProgram(rest[0], 'emulator') ? emulatorBootOf(rest.slice(1)) : isProgram(rest[0], 'android') ? androidCallOf(rest.slice(1), emulators) : undefined
    if (call !== undefined) calls.push(call)
  }

  return calls
}

/** True when a Gradle task puts something on a device: `install*` or `connected*`, read after its last `:`. */
export const needsDevice = (task: string) => /^(?:install|connected)/.test(task.slice(task.lastIndexOf(':') + 1))

export type GradleTarget = { serial: string; key: string }
export type GradlePick = { pass: true } | GradleTarget | { refuse: string }

/** Which emulator a Gradle call installs onto: its own serial, the one this agent holds, or the only one on (D21). */
export function gradleTarget(
  tasks: string[],
  held: string[],
  on: { key: string; serial: string }[],
  serial?: string,
): GradlePick {
  if (!tasks.some(needsDevice)) return { pass: true }
  if (serial) {
    const named = on.find(d => d.serial === serial)

    return named ? { serial: named.serial, key: named.key } : { pass: true }
  }
  const mine = on.filter(d => held.includes(d.key))
  const list = (ds: typeof on) => ds.map(d => `${d.serial} (${d.key.slice(1)})`).join(', ')
  const refuse = (ds: typeof on) => ({
    refuse:
      `simaphore: more than one emulator could take this Gradle install: ${list(ds)}. ` +
      'Rerun with ANDROID_SERIAL=<serial> in front of the Gradle command.',
  })
  if (mine.length === 1) return { serial: mine[0]!.serial, key: mine[0]!.key }
  if (mine.length > 1) return refuse(mine)
  if (on.length === 0) return { pass: true }
  if (on.length === 1) return { serial: on[0]!.serial, key: on[0]!.key }

  return refuse(on)
}
