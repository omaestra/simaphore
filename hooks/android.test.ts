import { expect, test } from 'claude-code/testing'

import {
  adbCalls,
  adbFollowUps,
  adbIn,
  androidQueued,
  avdFolder,
  avdKey,
  avdKeysIn,
  avdOfCommand,
  avdOfKey,
  emulatorCalls,
  gradleTarget,
  emulatorProcs,
  isAvdKey,
  isBootCompleted,
  isEmulatorSerial,
  pairEmulators,
  parseAdbDevices,
  parseAvdName,
  sdkRoots,
  shellWords,
  shutdownArgv,
} from './android'
import type { AdbContext } from './android'

const home = '/Users/me'
const macSdk = '/Users/me/Library/Android/sdk'

test('sdkRoots checks ANDROID_HOME, then ANDROID_SDK_ROOT, then the Mac default (R1)', () => {
  expect(sdkRoots({ ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/b' }, home)).toEqual(['/a', '/b', macSdk])
  expect(sdkRoots({ ANDROID_SDK_ROOT: '/b' }, home)).toEqual(['/b', macSdk])
  expect(sdkRoots({}, home)).toEqual([macSdk])
})

test('sdkRoots drops empty values, trailing slashes and repeats', () => {
  expect(sdkRoots({ ANDROID_HOME: '', ANDROID_SDK_ROOT: '  ' }, home)).toEqual([macSdk])
  expect(sdkRoots({ ANDROID_HOME: '/a/', ANDROID_SDK_ROOT: '/a' }, home)).toEqual(['/a', macSdk])
  expect(sdkRoots({ ANDROID_HOME: `${macSdk}/` }, home)).toEqual([macSdk])
})

test('sdkRoots adds no Linux or Windows folders (R35)', () => {
  for (const r of sdkRoots({}, home)) expect(r.includes('Library/Android/sdk')).toBe(true)
})

test('adbIn is the platform-tools adb', () => {
  expect(adbIn('/a')).toBe('/a/platform-tools/adb')
})

test('avdOfCommand reads the emulator process, by -avd or @', () => {
  const q = `${macSdk}/emulator/qemu/darwin-aarch64/qemu-system-aarch64`
  expect(avdOfCommand(`${q} -netdelay none -netspeed full -avd Pixel_9 -qt-hide-window`)).toBe('Pixel_9')
  expect(avdOfCommand(`${q} @Pixel_9_API_35`)).toBe('Pixel_9_API_35')
  expect(avdOfCommand(`${q}-headless -avd Small.Phone-2 -no-window`)).toBe('Small.Phone-2')
  expect(avdOfCommand('qemu-system-x86_64 -avd Tab')).toBe('Tab')
})

test('avdOfCommand ignores the launcher, other programs and unsafe names', () => {
  expect(avdOfCommand(`${macSdk}/emulator/emulator -avd Pixel_9`)).toBe(undefined)
  expect(avdOfCommand('/usr/bin/adb -s emulator-5554 shell')).toBe(undefined)
  expect(avdOfCommand('vim qemu-system-aarch64 -avd Pixel_9')).toBe(undefined)
  expect(avdOfCommand('qemu-system-aarch64 -avd')).toBe(undefined)
  expect(avdOfCommand("qemu-system-aarch64 -avd Pix'el")).toBe(undefined)
  expect(avdOfCommand('qemu-system-aarch64 -netdelay none')).toBe(undefined)
})

test('emulatorProcs lists one entry per emulator, never the launcher too', () => {
  const procs = [
    { pid: 10, command: `${macSdk}/emulator/emulator -avd Pixel_9` },
    { pid: 11, command: `${macSdk}/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd Pixel_9` },
    { pid: 12, command: 'qemu-system-aarch64 -avd Tablet' },
    { pid: 13, command: '/usr/bin/login -fp me' },
  ]
  expect(emulatorProcs(procs)).toEqual([{ pid: 11, avd: 'Pixel_9' }, { pid: 12, avd: 'Tablet' }])
  expect(emulatorProcs([])).toEqual([])
})

test('parseAdbDevices keeps emulators only (R7)', () => {
  const text = [
    '* daemon not running; starting now at tcp:5037',
    '* daemon started successfully',
    'List of devices attached',
    'emulator-5554\tdevice',
    'emulator-5556\toffline',
    'R58M123ABC\tdevice',
    '192.168.1.20:5555\tdevice',
    'adb-R58M123ABC-x._adb-tls-connect._tcp\tdevice',
    '',
  ].join('\n')
  expect(parseAdbDevices(text)).toEqual([
    { serial: 'emulator-5554', state: 'device' },
    { serial: 'emulator-5556', state: 'offline' },
  ])
})

test('parseAdbDevices reads the long form and empty lists', () => {
  expect(parseAdbDevices('List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:x\n'))
    .toEqual([{ serial: 'emulator-5554', state: 'device' }])
  expect(parseAdbDevices('List of devices attached\n\n')).toEqual([])
})

test('parseAdbDevices gives no list when adb failed, so nothing is forgotten', () => {
  expect(parseAdbDevices('')).toBe(undefined)
  expect(parseAdbDevices('error: could not connect to daemon\n')).toBe(undefined)
})

test('parseAvdName reads the name before OK', () => {
  expect(parseAvdName('Pixel_9\r\nOK\r\n')).toBe('Pixel_9')
  expect(parseAvdName('Pixel_9\nOK')).toBe('Pixel_9')
})

test('parseAvdName refuses errors, missing OK and unsafe names', () => {
  expect(parseAvdName('KO: unknown command\r\n')).toBe(undefined)
  expect(parseAvdName('error: device offline\n')).toBe(undefined)
  expect(parseAvdName('Pixel_9\n')).toBe(undefined)
  expect(parseAvdName('OK\n')).toBe(undefined)
  expect(parseAvdName('../x\r\nOK\r\n')).toBe(undefined)
  expect(parseAvdName('')).toBe(undefined)
})

test('device keys: @ and a safe AVD name', () => {
  expect(avdKey('Pixel_9')).toBe('@Pixel_9')
  expect(isAvdKey('@Pixel_9')).toBe(true)
  expect(isAvdKey('@Small.Phone-2')).toBe(true)
  expect(isAvdKey('Pixel_9')).toBe(false)
  expect(isAvdKey('@')).toBe(false)
  expect(isAvdKey('@a/b')).toBe(false)
  expect(isAvdKey('@a b')).toBe(false)
  expect(isAvdKey('@a\nb')).toBe(false)
  expect(isAvdKey('A1B2C3D4-0000-0000-0000-000000000000')).toBe(false)
  expect(avdOfKey('@Pixel_9')).toBe('Pixel_9')
  expect(avdOfKey('@a/b')).toBe(undefined)
})

test('isEmulatorSerial matches emulator-<port> only', () => {
  expect(isEmulatorSerial('emulator-5554')).toBe(true)
  expect(isEmulatorSerial('emulator-')).toBe(false)
  expect(isEmulatorSerial('emulator-5554x')).toBe(false)
  expect(isEmulatorSerial('R58M123ABC')).toBe(false)
  expect(isEmulatorSerial('192.168.1.20:5555')).toBe(false)
})

const adb = '/sdk/platform-tools/adb'
const name = (serial: string) => [adb, '-s', serial, 'emu', 'avd', 'name']
const boot = (serial: string) => [adb, '-s', serial, 'shell', 'getprop', 'sys.boot_completed']

test('adbFollowUps asks a new serial its AVD name once, and its boot state until up (D17)', () => {
  const devices = [{ serial: 'emulator-5554', state: 'device' }]
  const running = new Set(['Pixel_9'])
  expect(adbFollowUps(adb, devices, new Map(), new Set(), running)).toEqual([name('emulator-5554'), boot('emulator-5554')])
  const known = new Map([['emulator-5554', 'Pixel_9']])
  expect(adbFollowUps(adb, devices, known, new Set(), running)).toEqual([boot('emulator-5554')])
  expect(adbFollowUps(adb, devices, known, new Set(['emulator-5554']), running)).toEqual([])
})

test('adbFollowUps: an offline emulator is asked its name but not its boot state', () => {
  expect(adbFollowUps(adb, [{ serial: 'emulator-5556', state: 'offline' }], new Map(), new Set(), new Set(['Tab'])))
    .toEqual([name('emulator-5556')])
})

test('adbFollowUps asks again when the remembered AVD no longer runs (the port moved on)', () => {
  const devices = [{ serial: 'emulator-5554', state: 'device' }]
  const known = new Map([['emulator-5554', 'Pixel_9']])
  expect(adbFollowUps(adb, devices, known, new Set(['emulator-5554']), new Set(['Tablet']))).toEqual([name('emulator-5554')])
})

test('adbFollowUps runs nothing with no emulators listed', () => {
  expect(adbFollowUps(adb, [], new Map(), new Set(), new Set())).toEqual([])
})

test('isBootCompleted reads getprop', () => {
  expect(isBootCompleted('1\r\n')).toBe(true)
  expect(isBootCompleted('0\n')).toBe(false)
  expect(isBootCompleted('')).toBe(false)
})

test('pairEmulators gives each emulator the serial adb named it by, and its boot state', () => {
  const procs = [{ pid: 41, avd: 'Pixel_9' }, { pid: 42, avd: 'Tablet' }, { pid: 43, avd: 'Early' }]
  const devices = [{ serial: 'emulator-5554', state: 'device' }, { serial: 'emulator-5556', state: 'offline' }]
  const names = new Map([['emulator-5554', 'Pixel_9'], ['emulator-5556', 'Tablet']])
  expect(pairEmulators(procs, devices, names, new Set(['emulator-5554']))).toEqual([
    { pid: 41, avd: 'Pixel_9', serial: 'emulator-5554', isReady: true },
    { pid: 42, avd: 'Tablet', serial: 'emulator-5556', isReady: false },
    { pid: 43, avd: 'Early', isReady: false },
  ])
})

test('pairEmulators ignores a remembered name whose serial adb no longer lists', () => {
  const names = new Map([['emulator-5554', 'Pixel_9']])
  expect(pairEmulators([{ pid: 41, avd: 'Pixel_9' }], [], names, new Set(['emulator-5554'])))
    .toEqual([{ pid: 41, avd: 'Pixel_9', isReady: false }])
})

test('avdFolder follows the SDK order and ends in avd', () => {
  expect(avdFolder({}, home)).toBe('/Users/me/.android/avd')
  expect(avdFolder({ ANDROID_AVD_HOME: '/x/avds/' }, home)).toBe('/x/avds')
  expect(avdFolder({ ANDROID_AVD_HOME: ' ', ANDROID_EMULATOR_HOME: '/e' }, home)).toBe('/e/avd')
  expect(avdFolder({ ANDROID_USER_HOME: '/u/' }, home)).toBe('/u/avd')
  expect(avdFolder({ ANDROID_EMULATOR_HOME: '/e', ANDROID_USER_HOME: '/u' }, home)).toBe('/e/avd')
})

test('avdKeysIn reads AVD names from .ini files and .avd folders, case kept', () => {
  const keys = avdKeysIn(['Pixel_9.ini', 'Pixel_9.avd', 'Tablet.avd', 'notes.txt', '.DS_Store', 'bad name.ini', '.ini'])
  expect([...keys].sort()).toEqual(['@Pixel_9', '@Tablet'])
  expect(avdKeysIn([]).size).toBe(0)
})

test('shutdownArgv: emu kill for an emulator with a serial and adb (D16), simctl for a simulator', () => {
  const adb = `${macSdk}/platform-tools/adb`
  expect(shutdownArgv({ udid: '@Pixel_9', serial: 'emulator-5554' }, adb)).toEqual([adb, '-s', 'emulator-5554', 'emu', 'kill'])
  expect(shutdownArgv({ udid: 'AAAAAAAA-0000-0000-0000-000000000001' }, adb)).toEqual(['xcrun', 'simctl', 'shutdown', 'AAAAAAAA-0000-0000-0000-000000000001'])
  expect(shutdownArgv({ udid: 'AAAAAAAA-0000-0000-0000-000000000001' })).toEqual(['xcrun', 'simctl', 'shutdown', 'AAAAAAAA-0000-0000-0000-000000000001'])
})

test('shutdownArgv gives nothing for an emulator it cannot reach', () => {
  const adb = `${macSdk}/platform-tools/adb`
  expect(shutdownArgv({ udid: '@Pixel_9' }, adb)).toBe(undefined)
  expect(shutdownArgv({ udid: '@Pixel_9', serial: 'emulator-5554' })).toBe(undefined)
  expect(shutdownArgv({ udid: '@Pixel_9', serial: '192.168.1.5:5555' }, adb)).toBe(undefined)
})

// --- reading adb commands (P11) ---

const ONE = { emulators: ['emulator-5554'] }
const TWO = { emulators: ['emulator-5554', 'emulator-5556'] }
const calls = (segments: string[], context: AdbContext = ONE) => adbCalls(segments, context)
const target = (segment: string, context: AdbContext = ONE) => calls([segment], context)[0]?.serial

test('shellWords removes quotes and backslashes and drops comments', () => {
  expect(shellWords(`adb -s "emulator-5554" shell 'echo hi there' # note`)).toEqual(['adb', '-s', 'emulator-5554', 'shell', 'echo hi there'])
  expect(shellWords('adb shell ls\\ -la a\\\nb')).toEqual(['adb', 'shell', 'ls -la', 'ab'])
  expect(shellWords('adb shell ""')).toEqual(['adb', 'shell', ''])
})

test('host verbs always run; kill-server and reconnect hit every device; the rest act on one device', () => {
  for (const c of ['adb devices -l', 'adb version', 'adb help', 'adb start-server', 'adb connect 10.0.0.2:5555', 'adb pair 10.0.0.2:37000',
    'adb disconnect', 'adb mdns services', 'adb keygen key', 'adb track-devices', 'adb --version', 'adb']) {
    expect(calls([c])[0]?.kind).toBe('host')
  }
  for (const c of ['adb kill-server', 'adb reconnect', 'adb -s emulator-5554 reconnect']) expect(calls([c])[0]?.kind).toBe('fleet')
  for (const verb of ['install app.apk', 'uninstall com.x', 'shell ls', 'push a /sdcard', 'pull /sdcard/a', 'logcat -d', 'emu kill',
    'reboot', 'forward tcp:1 tcp:2', 'reverse tcp:8081 tcp:8081', 'exec-out screencap -p', 'root', 'wait-for-device']) {
    expect(calls([`adb ${verb}`])[0]).toEqual({ verb: verb.split(' ')[0]!, kind: 'device', serial: 'emulator-5554' })
  }
})

test('the target: -s wins, then ANDROID_SERIAL inline, exported or from the session, then the one emulator on', () => {
  const session = { serial: 'emulator-5556', emulators: TWO.emulators }
  expect(target('ANDROID_SERIAL=emulator-5558 adb -s emulator-5554 shell ls', session)).toBe('emulator-5554')
  expect(target('adb -semulator-5554 shell ls', session)).toBe('emulator-5554')
  expect(target('ANDROID_SERIAL=emulator-5558 adb shell ls', session)).toBe('emulator-5558')
  expect(target('env ANDROID_SERIAL=emulator-5558 adb shell ls', session)).toBe('emulator-5558')
  expect(target('adb -e shell ls', session)).toBe('emulator-5556')
  expect(calls(['export ANDROID_SERIAL=emulator-5558', 'adb shell ls'], session)[0]?.serial).toBe('emulator-5558')
  expect(calls(['export ANDROID_SERIAL=emulator-5558', 'ANDROID_SERIAL=emulator-5560 adb shell ls'], session)[0]?.serial).toBe('emulator-5560')
  expect(calls(['unset ANDROID_SERIAL', 'adb shell ls'], { serial: 'emulator-5556', emulators: ONE.emulators })[0]?.serial).toBe('emulator-5554')
  expect(target('adb shell ls')).toBe('emulator-5554')
  expect(target('adb -e install app.apk')).toBe('emulator-5554')
})

test('-d, -t, phones and no single emulator to default to run as typed', () => {
  for (const c of ['adb -d shell ls', 'adb -t 3 shell ls', 'adb -t3 shell ls', 'adb -s 1A2B3C4D shell ls', 'adb -s 192.168.1.5:5555 shell ls',
    'adb -s localhost:5555 shell ls', 'ANDROID_SERIAL=1A2B3C4D adb shell ls']) {
    expect(calls([c])[0]).toMatchObject({ kind: 'device' })
    expect(target(c)).toBeUndefined()
  }
  expect(target('adb shell ls', TWO)).toBeUndefined()
  expect(target('adb -e shell ls', TWO)).toBeUndefined()
  expect(target('adb shell ls', { emulators: [] })).toBeUndefined()
  expect(target('adb -H 127.0.0.1 -P 5037 -s emulator-5556 shell ls')).toBe('emulator-5556')
})

test('adb counts only at command position, by any path, behind env, timeout and the like', () => {
  for (const c of ['echo adb shell ls', 'grep adb log.txt', 'command -v adb', 'which adb', 'cat adb.txt', 'git commit -m "adb shell"']) {
    expect(calls([c])).toEqual([])
  }
  for (const c of ['/Users/o/Library/Android/sdk/platform-tools/adb shell ls', '$ANDROID_HOME/platform-tools/adb shell ls',
    'timeout 30 adb shell ls', 'nohup adb logcat', 'exec adb shell ls', '(adb shell ls', 'time adb install a.apk']) {
    expect(calls([c])[0]?.serial).toBe('emulator-5554')
  }
  expect(calls(['adb -s emulator-5554 install a.apk', 'adb -s emulator-5556 shell am start', 'adb devices'], TWO).map(c => c.serial))
    .toEqual(['emulator-5554', 'emulator-5556', undefined])
})

const ecalls = (segments: string[], emulators: string[] = ONE.emulators) => emulatorCalls(segments, emulators)
const ecall = (segment: string, emulators?: string[]) => ecalls([segment], emulators)[0]
const NONE: string[] = []

test('emulator boots the AVD in -avd or @X, stops reading at -qemu, and print-only options boot nothing', () => {
  for (const c of ['emulator -avd Pixel_9', 'emulator --avd Pixel_9', 'emulator @Pixel_9 -no-snapshot', '/Users/o/Library/Android/sdk/emulator/emulator -avd Pixel_9 -no-window',
    '$ANDROID_HOME/emulator/emulator @Pixel_9', 'nohup emulator -avd Pixel_9 &', 'nohup emulator -avd Pixel_9 > /dev/null 2>&1', 'emulator -avd Pixel_9 -qemu @foo']) {
    expect(ecalls([c])).toEqual([{ verb: 'emulator', kind: 'boot', avd: 'Pixel_9' }])
  }
  for (const o of ['-list-avds', '--list-avds', '-help', '-help-all', '--help-all', '-version', '--version', '-accel-check']) expect(ecalls([`emulator ${o}`])).toEqual([])
  expect(ecalls(['emulator -avd Pixel_9 -list-avds'])).toEqual([])
  for (const c of ["emulator -avd 'bad name'", 'emulator -avd', 'emulator', 'emulator -no-window', 'emulator -qemu @foo']) expect(ecalls([c])).toEqual([])
})

test('android emulator start boots its AVD, past global options, in any case', () => {
  const boot = { verb: 'emulator start', kind: 'boot', avd: 'Pixel_9' }
  for (const c of ['android emulator start Pixel_9', 'android emulator start --cold --headless Pixel_9', 'android emulator start Pixel_9 --cold',
    'android --sdk=/x -v --no-metrics emulator start Pixel_9', 'android --sdk /x emulator START Pixel_9', 'android -vv Emulator Start Pixel_9',
    '/usr/local/bin/android emulator start Pixel_9']) {
    expect(ecalls([c])).toEqual([boot])
  }
  for (const c of ['android emulator start -h', 'android emulator start --help Pixel_9', 'android emulator start', "android emulator start 'bad name'",
    'android -V', 'android --version emulator start Pixel_9', 'android -h', 'android --help emulator start Pixel_9']) {
    expect(ecalls([c])).toEqual([])
  }
})

test('android emulator stop acts on the serial, the AVD, or the only emulator on', () => {
  expect(ecall('android emulator stop emulator-5556', TWO.emulators)).toEqual({ verb: 'emulator stop', kind: 'device', serial: 'emulator-5556' })
  expect(ecall('android emulator stop Pixel_9', TWO.emulators)).toEqual({ verb: 'emulator stop', kind: 'device', avd: 'Pixel_9' })
  expect(ecall('android emulator stop')).toEqual({ verb: 'emulator stop', kind: 'device', serial: 'emulator-5554' })
  expect(ecall('android emulator stop', TWO.emulators)).toEqual({ verb: 'emulator stop', kind: 'device' })
  expect(ecall('android emulator stop', NONE)).toEqual({ verb: 'emulator stop', kind: 'device' })
  for (const c of ['android emulator stop -h', 'android emulator stop --help Pixel_9', 'android emulator create Pixel_9', 'android emulator list', 'android emulator remove Pixel_9',
    'android emulator', "android emulator stop 'bad name'"]) {
    expect(ecalls([c])).toEqual([])
  }
})

test('install and run take --device, else the default, and say whether they build', () => {
  for (const verb of ['install', 'run']) {
    expect(ecall(`android ${verb} --device=emulator-5556 app.apk`, TWO.emulators)).toEqual({ verb, kind: 'device', serial: 'emulator-5556', builds: false })
    expect(ecall(`android ${verb} --device emulator-5556 app.apk`, TWO.emulators)).toEqual({ verb, kind: 'device', serial: 'emulator-5556', builds: false })
    expect(ecall(`android ${verb} app.apk`)).toEqual({ verb, kind: 'device', serial: 'emulator-5554', builds: false })
    expect(ecall(`android ${verb} app.apk`, TWO.emulators)).toEqual({ verb, kind: 'device', builds: false })
    expect(ecall(`android ${verb} app.apk`, NONE)).toEqual({ verb, kind: 'device', builds: false })
    for (const phone of ['R58M123ABC', '192.168.1.5:5555']) {
      expect(ecall(`android ${verb} --device=${phone} app.apk`)).toEqual({ verb, kind: 'device', builds: false })
      expect(ecall(`android ${verb} --device ${phone} app.apk`)).toEqual({ verb, kind: 'device', builds: false })
    }
    expect(ecall(`android ${verb} -h`)).toBeUndefined()
    expect(ecall(`android ${verb} --help app.apk`)).toBeUndefined()
  }
})

test('install and run build unless given APKs; words after -- are build arguments', () => {
  for (const [c, builds] of [
    ['android install :app', true], ['android install', true], ['android run', true], ['android install app.apk', false], ['android install a.APK', false],
    ['android install --apks=x.apks', false], ['android install --apks x.apks', false], ['android install --apks=a.apk,b.apk', false], ['android run :app -- --stacktrace', true],
    ['android run -- app.apk', true], ['android run --activity Main app.apk', false], ['android run --activity Main', true], ['android run --activity a.apk', true],
    ['android run --debug --use-delta-install :app', true], ['android install --device emulator-5554 --type x.apk', true], ['android install --install-options=-r app.apk', false],
  ] as const) {
    expect(ecall(c)?.builds).toBe(builds)
  }
})

test('screen, layout, input, profiler and device hub aim at --device or the default', () => {
  for (const [c, verb] of [['screen capture', 'screen'], ['layout', 'layout'], ['input tap 1 2', 'input'], ['profiler start', 'profiler'], ['device hub', 'device hub'], ['Device HUB', 'device hub']] as const) {
    expect(ecall(`android ${c}`)).toEqual({ verb, kind: 'device', serial: 'emulator-5554' })
    expect(ecall(`android ${c}`, TWO.emulators)).toEqual({ verb, kind: 'device' })
    expect(ecall(`android ${c} --device=emulator-5556`, TWO.emulators)).toEqual({ verb, kind: 'device', serial: 'emulator-5556' })
    expect(ecall(`android ${c} --device emulator-5556`, TWO.emulators)).toEqual({ verb, kind: 'device', serial: 'emulator-5556' })
    expect(ecall(`android ${c} --device R58M123ABC`)).toEqual({ verb, kind: 'device' })
    expect(ecall(`android ${c} -h`)).toBeUndefined()
  }
  expect(ecall('android screen capture -o a.png -- --device emulator-5556')).toEqual({ verb: 'screen', kind: 'device', serial: 'emulator-5554' })
  for (const c of ['android device list', 'android device', 'android build', 'android build :app', 'android screen capture -h', 'android sdk install x', 'android docs', 'android']) {
    expect(ecalls([c])).toEqual([])
  }
})

test('emulator and android count only at command position; segments are read in order', () => {
  for (const c of ['echo emulator -avd X', 'which android', 'grep android log.txt', 'git commit -m "android run"', 'cat emulator.txt', 'command -v emulator']) {
    expect(ecalls([c])).toEqual([])
  }
  expect(ecalls(['timeout 30 android run app.apk', 'exec android screen', '(emulator -avd A', 'time android emulator start B'], NONE)).toEqual([
    { verb: 'run', kind: 'device', builds: false }, { verb: 'screen', kind: 'device' }, { verb: 'emulator', kind: 'boot', avd: 'A' },
    { verb: 'emulator start', kind: 'boot', avd: 'B' },
  ])
  expect(ecalls(['emulator -avd A', 'echo hi', 'android emulator stop A'], NONE).map(c => c.verb)).toEqual(['emulator', 'emulator stop'])
})

test('gradleTarget: every branch', () => {
  const P9 = { key: '@Pixel_9', serial: 'emulator-5554' }
  const P8 = { key: '@Pixel_8', serial: 'emulator-5556' }
  const pass = { pass: true }
  // a. only install and connected tasks, read after the last colon
  expect(gradleTarget(['assembleDebug'], [], [P9])).toEqual(pass)
  expect(gradleTarget(['assembleDebug', ':app:installDebug'], [], [P9])).toEqual(P9)
  expect(gradleTarget([':app:connectedDebugAndroidTest'], [], [P9])).toEqual(P9)
  expect(gradleTarget([':installer:assemble'], [], [P9])).toEqual(pass)
  // b. the call's own serial
  expect(gradleTarget(['installDebug'], [], [P9, P8], 'emulator-5556')).toEqual(P8)
  expect(gradleTarget(['installDebug'], ['@Pixel_9'], [P9, P8], 'emulator-5556')).toEqual(P8)
  expect(gradleTarget(['installDebug'], [], [P9], 'R58M123')).toEqual(pass)
  expect(gradleTarget(['installDebug'], [], [P9], 'emulator-5999')).toEqual(pass)
  // c. one held emulator is on
  expect(gradleTarget(['installDebug'], ['@Pixel_8', '@Gone'], [P9, P8])).toEqual(P8)
  // d. two held emulators are on
  expect(gradleTarget(['installDebug'], ['@Pixel_9', '@Pixel_8'], [P9, P8])).toEqual({
    refuse:
      'simaphore: more than one emulator could take this Gradle install: emulator-5554 (Pixel_9), emulator-5556 (Pixel_8). ' +
      'Rerun with ANDROID_SERIAL=<serial> in front of the Gradle command.',
  })
  // e. none held
  expect(gradleTarget(['installDebug'], [], [])).toEqual(pass)
  expect(gradleTarget(['installDebug'], ['@Gone'], [P9])).toEqual(P9)
  const both = gradleTarget(['installDebug'], [], [P9, P8])
  expect(both).toEqual({ refuse: expect.stringContaining('emulator-5554 (Pixel_9), emulator-5556 (Pixel_8)') })
})

test('androidQueued: build is queued, with or without global options', () => {
  expect(androidQueued(['build'], [])).toEqual({ verb: 'build' })
  expect(androidQueued(['BUILD', '--', '-h'], [])).toEqual({ verb: 'build' })
  expect(androidQueued(['--sdk', '/x', 'build'], [])).toEqual({ verb: 'build' })
})

test('androidQueued: help, version and no command are not queued', () => {
  for (const args of [[], ['-h'], ['--help'], ['-V'], ['--version'], ['--sdk', '/x'], ['build', '--help'], ['build', '-h'], ['run', '--help']]) {
    expect(androidQueued(args, ['emulator-5554']), args.join(' ')).toBeUndefined()
  }
})

test('androidQueued: run carries the serial it targets', () => {
  expect(androidQueued(['run', '--device=emulator-5554'], [])).toEqual({ verb: 'run', serial: 'emulator-5554' })
  expect(androidQueued(['run', '--device', 'emulator-5556'], ['emulator-5554'])).toEqual({ verb: 'run', serial: 'emulator-5556' })
  expect(androidQueued(['run'], ['emulator-5554'])).toEqual({ verb: 'run', serial: 'emulator-5554' })
})

test('androidQueued: run with no single target or a phone has no serial', () => {
  expect(androidQueued(['run'], [])).toEqual({ verb: 'run' })
  expect(androidQueued(['run'], ['emulator-5554', 'emulator-5556'])).toEqual({ verb: 'run' })
  expect(androidQueued(['run', '--device=R5CT1234'], ['emulator-5554'])).toEqual({ verb: 'run' })
})

test('androidQueued: run with APKs, install and other commands are not queued', () => {
  for (const args of [['run', '--apks', 'app.apks'], ['run', '--apks=a.apk'], ['run', 'app.apk'], ['install', 'app.apk'], ['install'], ['screen', 'capture'], ['emulator', 'list']]) {
    expect(androidQueued(args, ['emulator-5554']), args.join(' ')).toBeUndefined()
  }
})
