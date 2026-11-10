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

// ---- sample: whole-Mac counters plus a row per process ----
var timebase = mach_timebase_info()
mach_timebase_info(&timebase)
func nanos(_ ticks: UInt64) -> UInt64 {   // mach ticks to ns; 125/3 on Apple silicon
    let m = ticks.multipliedFullWidth(by: UInt64(timebase.numer))
    return UInt64(timebase.denom).dividingFullWidth(m).quotient
}

func sysctlValue<T>(_ name: String, _ v: inout T) {
    var n = MemoryLayout<T>.size
    withUnsafeMutablePointer(to: &v) { _ = sysctlbyname(name, $0, &n, nil, 0) }
}

func cString<T>(_ t: T) -> String { withUnsafeBytes(of: t) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) } }

var argMax: Int32 = 0
sysctlValue("kern.argmax", &argMax)
let argBuf = UnsafeMutablePointer<UInt8>.allocate(capacity: Int(max(argMax, 4096)))

// KERN_PROCARGS2: argc, exec path, NUL padding to 8 bytes, then argv (argv[0] may be empty).
func commandLine(_ pid: pid_t) -> String? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = Int(max(argMax, 4096))
    guard sysctl(&mib, 3, argBuf, &size, nil, 0) == 0, size > 4 else { return nil }
    let b = UnsafeBufferPointer(start: argBuf, count: size)
    let argc = Int(b.withMemoryRebound(to: Int32.self) { $0[0] })
    guard let pathEnd = b[4...].firstIndex(of: 0) else { return nil }
    var i = (pathEnd - 4 + 1 + 7) / 8 * 8 + 4
    guard i <= size, b[pathEnd..<i].allSatisfy({ $0 == 0 }) else { return nil }
    var out: [String] = []
    while out.count < argc && i < size {
        let s = i
        while i < size && b[i] != 0 { i += 1 }
        out.append(String(decoding: b[s..<i], as: UTF8.self))
        i += 1
    }
    return out.joined(separator: " ")
}

struct Known { let start: UInt64; let uuid: [UInt8]; let startSec: Int; let cmd: String }
var known: [pid_t: Known] = [:]
let myUid = getuid()

func sampleLine() -> String {
    let at = Int(Date().timeIntervalSince1970 * 1000)
    var cpu = host_cpu_load_info()
    var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
    _ = withUnsafeMutablePointer(to: &cpu) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) }
    }
    var swap = xsw_usage(), la = loadavg(), cores: Int32 = 0, mem: UInt64 = 0, pressure: Int32 = 0
    sysctlValue("vm.swapusage", &swap); sysctlValue("vm.loadavg", &la); sysctlValue("hw.ncpu", &cores)
    sysctlValue("hw.memsize", &mem); sysctlValue("kern.memorystatus_vm_pressure_level", &pressure)
    let fs = Double(max(la.fscale, 1))
    let loads = [la.ldavg.0, la.ldavg.1, la.ldavg.2].map { String(format: "%.2f", Double($0) / fs) }

    var pids = [pid_t](repeating: 0, count: Int(max(proc_listallpids(nil, 0), 0)) + 64)
    let got = Int(max(proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size)), 0))
    var mine: [String] = [], others: [String] = [], seen = Set<pid_t>()
    for pid in pids.prefix(got) {
        var sb = proc_bsdshortinfo()
        guard proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, &sb, Int32(MemoryLayout<proc_bsdshortinfo>.size)) > 0 else { continue }
        let comm = "(\(cString(sb.pbsi_comm)))"
        var ri = rusage_info_v4()
        let ok = sb.pbsi_uid == myUid && withUnsafeMutablePointer(to: &ri) { p in
            p.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
        } == 0
        guard ok else {
            var path = [CChar](repeating: 0, count: 4096)
            let name = proc_pidpath(pid, &path, UInt32(path.count)) > 0 ? String(cString: path) : comm
            others.append("[\(pid),\(sb.pbsi_ppid),\(sb.pbsi_uid),\(jsonString(name))]")
            continue
        }
        let uuid = withUnsafeBytes(of: ri.ri_uuid) { Array($0) }
        var k = known[pid]
        if k == nil || k!.start != ri.ri_proc_start_abstime || k!.uuid != uuid {   // new process, or a reused pid
            var bi = proc_bsdinfo()
            let sec = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bi, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0 ? Int(bi.pbi_start_tvsec) : 0
            let line = commandLine(pid)
            k = Known(start: ri.ri_proc_start_abstime, uuid: uuid, startSec: sec, cmd: line ?? comm)
            if line != nil { known[pid] = k }   // a failed read is tried again next time
        }
        seen.insert(pid)
        mine.append("[\(pid),\(sb.pbsi_ppid),\(nanos(ri.ri_user_time &+ ri.ri_system_time)),\(ri.ri_phys_footprint),\(k!.startSec),\(jsonString(k!.cmd))]")
    }
    known = known.filter { seen.contains($0.key) }
    return "{\"kind\":\"sample\",\"at\":\(at),\"cores\":\(cores),"
        + "\"ticks\":[\(cpu.cpu_ticks.0),\(cpu.cpu_ticks.1),\(cpu.cpu_ticks.2),\(cpu.cpu_ticks.3)],"
        + "\"swap\":[\(swap.xsu_total),\(swap.xsu_used)],\"load\":[\(loads.joined(separator: ","))],"
        + "\"mem\":\(mem),\"pressure\":\(pressure),\"thermal\":\(ProcessInfo.processInfo.thermalState.rawValue),"
        + "\"mine\":[\(mine.joined(separator: ","))],\"others\":[\(others.joined(separator: ","))]}"
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

// One line now, then one on each mark start + k*S. A repeating timer keeps its marks and skips missed ones.
case "sample":
    var every = 3.0
    while !args.isEmpty {
        let a = args.removeFirst()
        switch a {
        case "--every": guard let e = Double(value(a)), e > 0, e < 1e9 else { fail("xcwatch: bad --every") }; every = e
        default: fail("xcwatch: unknown option \(a)")
        }
    }
    let caller = getppid()
    onExit(of: caller) { exit(0) }
    if getppid() != caller { exit(0) }   // the caller died before the watch was set up
    let timer = DispatchSource.makeTimerSource(flags: .strict, queue: queue)
    timer.schedule(deadline: .now(), repeating: every, leeway: .milliseconds(1))
    timer.setEventHandler { emit(sampleLine()) }
    timer.resume()
    sources.append(timer)
    dispatchMain()

default:
    fail("usage: xcwatch wait [--timeout S] [--memory] [--devices] <path>... | events [--devices] [--memory] [--pid N]... [--dir D]... | tether -- <command>... | sample [--every S]")
}
