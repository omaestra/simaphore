// xcwatch: tells scripts the moment a file changes, a simulator boots or stops, a process exits,
// or memory pressure changes. See bin/xcwatch for usage. Foundation + Dispatch + CoreServices only.
import Foundation
import CoreServices

setvbuf(stdout, nil, _IOLBF, 0)
let queue = DispatchQueue(label: "xcwatch")
var sources: [DispatchSourceProtocol] = []

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(64)
}

func isDir(_ p: String) -> Bool {
    var d: ObjCBool = false
    return FileManager.default.fileExists(atPath: p, isDirectory: &d) && d.boolValue
}

func parent(_ p: String) -> String { (p as NSString).deletingLastPathComponent }

// Absolute path with symlinks resolved, even when the path (or its tail) does not exist yet.
func resolve(_ p: String) -> String {
    let full = p.hasPrefix("/") ? p : FileManager.default.currentDirectoryPath + "/" + p
    var base = URL(fileURLWithPath: full).standardizedFileURL.path
    var tail: [String] = []
    while !FileManager.default.fileExists(atPath: base) && base != "/" {
        tail.insert((base as NSString).lastPathComponent, at: 0)
        base = parent(base)
    }
    let real = realpath(base, nil).map { String(cString: $0) } ?? base
    return ([real == "/" ? "" : real] + tail).joined(separator: "/").nonEmpty ?? "/"
}

extension String { var nonEmpty: String? { isEmpty ? nil : self } }

func inside(_ path: String, _ target: String) -> Bool { path == target || path.hasPrefix(target + "/") }

func jsonString(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case _ where u.value < 0x20: out += String(format: "\\u%04x", u.value)
        default: out.unicodeScalars.append(u)
        }
    }
    return out + "\""
}

func emit(_ json: String) { print(json); fflush(stdout) }

// Everything the event stream cares about. onFile/onSim run on `queue`.
struct Watches {
    var targets: [String] = []      // wait paths or --dir folders, resolved
    var devices: String?            // resolved Devices folder
    var onFile: (String) -> Void = { _ in }
    var onSim: (String) -> Void = { _ in }
}
var watches = Watches()

func handle(_ path: String) {
    if let dev = watches.devices, path.hasPrefix(dev + "/") {
        let parts = path.dropFirst(dev.count + 1).split(separator: "/", omittingEmptySubsequences: false)
        if parts.count == 2 && parts[1] == "device.plist" { watches.onSim(parts[0].uppercased()) }
    }
    if watches.targets.contains(where: { inside(path, $0) }) { watches.onFile(path) }
}

func startStream() {
    var roots = Set<String>()
    for t in watches.targets + (watches.devices.map { [$0] } ?? []) {
        var r = t
        while !isDir(r) && r != "/" { r = parent(r) }
        roots.insert(r)
    }
    if roots.isEmpty { return }
    let callback: FSEventStreamCallback = { _, _, count, paths, _, _ in
        let list = unsafeBitCast(paths, to: NSArray.self)
        for i in 0..<count { if let p = list[i] as? String { handle(p) } }
    }
    let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
        | kFSEventStreamCreateFlagUseCFTypes)
    guard let stream = FSEventStreamCreate(nil, callback, nil, Array(roots) as CFArray,
        FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.05, flags) else {
        FileHandle.standardError.write(Data("xcwatch: cannot watch\n".utf8)); exit(70)
    }
    FSEventStreamSetDispatchQueue(stream, queue)
    FSEventStreamStart(stream)
    FSEventStreamFlushSync(stream)
}

func onMemory(_ handler: @escaping (String) -> Void) {
    let src = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical],
                                                      queue: queue)
    src.setEventHandler {
        let e = src.data
        handler(e.contains(.critical) ? "critical" : e.contains(.warning) ? "warning" : "normal")
    }
    src.resume()
    sources.append(src)
}

func onExit(of pid: pid_t, _ handler: @escaping () -> Void) {
    let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
    src.setEventHandler(handler: handler)
    src.resume()
    sources.append(src)
}

let devicesPath = resolve(ProcessInfo.processInfo.environment["XCWATCH_DEVICES"]
    ?? NSHomeDirectory() + "/Library/Developer/CoreSimulator/Devices")

var args = Array(CommandLine.arguments.dropFirst())
let mode = args.isEmpty ? "" : args.removeFirst()

func value(_ flag: String) -> String {
    guard !args.isEmpty else { fail("xcwatch: \(flag) needs a value") }
    return args.removeFirst()
}

switch mode {
case "wait":
    var timeout = 10.0, memory = false, devices = false, paths: [String] = []
    while !args.isEmpty {
        let a = args.removeFirst()
        switch a {
        case "--timeout": guard let t = Double(value(a)), t >= 0 else { fail("xcwatch: bad --timeout") }; timeout = t
        case "--memory": memory = true
        case "--devices": devices = true
        default: paths.append(a)
        }
    }
    watches.targets = paths.map(resolve)
    watches.devices = devices ? devicesPath : nil
    watches.onFile = { _ in exit(0) }
    watches.onSim = { _ in exit(0) }
    startStream()
    if memory { onMemory { _ in exit(0) } }
    queue.asyncAfter(deadline: .now() + timeout) { exit(1) }
    dispatchMain()

case "events":
    var memory = false, devices = false, pids: [pid_t] = [], dirs: [String] = []
    while !args.isEmpty {
        let a = args.removeFirst()
        switch a {
        case "--devices": devices = true
        case "--memory": memory = true
        case "--pid": guard let p = pid_t(value(a)) else { fail("xcwatch: bad --pid") }; pids.append(p)
        case "--dir": dirs.append(value(a))
        default: fail("xcwatch: unknown option \(a)")
        }
    }
    watches.targets = dirs.map(resolve)
    // FSEvents reports real paths (/private/var/...); print them under the folder name the caller gave.
    let given = dirs.map { URL(fileURLWithPath: $0.hasPrefix("/") ? $0
        : FileManager.default.currentDirectoryPath + "/" + $0).standardizedFileURL.path }
    func asGiven(_ path: String) -> String {
        guard let i = watches.targets.firstIndex(where: { inside(path, $0) }) else { return path }
        return given[i] + path.dropFirst(watches.targets[i].count)
    }
    watches.devices = devices ? devicesPath : nil
    var last: [String: Date] = [:], pending = Set<String>()
    let gap = 0.1
    watches.onFile = { real in   // first change goes out at once; a burst gets one more line after the gap
        let path = asGiven(real)
        let line = "{\"kind\":\"file\",\"path\":\(jsonString(path))}"
        if let l = last[path], Date().timeIntervalSince(l) < gap {
            guard pending.insert(path).inserted else { return }
            queue.asyncAfter(deadline: .now() + gap) {
                pending.remove(path); last[path] = Date(); emit(line)
            }
            return
        }
        last[path] = Date(); emit(line)
    }
    watches.onSim = { emit("{\"kind\":\"sim\",\"udid\":\"\($0)\"}") }
    startStream()
    if memory { onMemory { emit("{\"kind\":\"memory\",\"level\":\"\($0)\"}") } }
    onExit(of: getppid()) { exit(0) }
    emit("{\"kind\":\"ready\"}")
    var reported = Set<pid_t>()
    for pid in pids {
        let report = { if reported.insert(pid).inserted { emit("{\"kind\":\"exit\",\"pid\":\(pid)}") } }
        onExit(of: pid, report)
        if kill(pid, 0) != 0 && errno == ESRCH { queue.async(execute: report) }
    }
    dispatchMain()

// Runs a command that must not outlive its caller: a hard-killed caller can't stop its children,
// so this stops the command when the caller exits, or when this is told to stop.
case "tether":
    if args.first == "--" { args.removeFirst() }
    guard !args.isEmpty else { fail("xcwatch: tether needs a command") }
    let caller = getppid()
    var child: pid_t = 0
    func stop() -> Never { if child > 0 { kill(child, SIGTERM) }; exit(0) }
    // Handled from before the spawn, so a stop can't land in between; the command gets them back.
    let stopSignals = [SIGTERM, SIGINT, SIGHUP]
    var defaults = sigset_t()
    sigemptyset(&defaults)
    for sig in stopSignals {
        signal(sig, SIG_IGN)
        sigaddset(&defaults, sig)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: queue)
        src.setEventHandler { stop() }
        src.resume()
        sources.append(src)
    }
    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    posix_spawnattr_setsigdefault(&attr, &defaults)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGDEF))
    let cArgs = args.map { strdup($0) } + [nil]
    guard posix_spawnp(&child, args[0], nil, &attr, cArgs, environ) == 0 else {
        FileHandle.standardError.write(Data("xcwatch: cannot run \(args[0])\n".utf8)); exit(70)
    }
    onExit(of: child) {
        var status: Int32 = 0
        waitpid(child, &status, 0)
        exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f))
    }
    onExit(of: caller) { stop() }
    if getppid() != caller { stop() }   // the caller died before the watch was set up
    dispatchMain()

default:
    fail("usage: xcwatch wait [--timeout S] [--memory] [--devices] <path>... | events [--devices] [--memory] [--pid N]... [--dir D]... | tether -- <command>...")
}
