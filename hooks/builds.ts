// Build identity for simaphore: who started a build, with which Xcode, what kind, which
// simulator. Pure, like logic.ts (which it imports from at call time only).
import type { AgentRecord, BuildSource, BuildTree, FinishedBuild, Owner } from '../types'
import { ancestorsOf, derivedDataPath, fmtElapsed, isOpen } from './logic'
import type { Proc } from './logic'

const headOf = (command: string) => command.split(/ -/)[0] ?? command
const exeOf = (command: string) => (command.split(/\s/)[0] ?? '').split('/').pop() ?? ''

// ---------- recognising processes ----------

const XCODE_APP = /^(\/(?:[^/]+\/)*?Xcode[^/]*\.app)\//
const XCODE_MAIN = /\/Xcode[^/]*\.app\/Contents\/MacOS\/Xcode$/
const BUILD_SERVICE = /(?:^|\/)(?:SWBBuildService|XCBBuildService)$/
const XCODEBUILD = /(?:^|\/)xcodebuild$/
const TERMINAL =
  /\/(?:Terminal|iTerm|Ghostty|Warp|WezTerm|Alacritty|kitty|Visual Studio Code(?: - Insiders)?|Cursor)\.app\//
const COMPILE_TOOL =
  /^(?:swift-frontend|swift-driver|swift-build|swiftc|swift-autolink-extract|clang(?:\+\+)?(?:-\d+)?|clang-scan-deps|ld|ld-prime|libtool|lipo|actool|ibtool|momc|mapc|copypng|appintentsmetadataprocessor|xcstringstool|intentbuilderc)$/
const APP_PATH = /\/Containers\/Bundle\/Application\//
/** Compile tools together using this much CPU (percent) count as actively compiling. */
export const COMPILE_CPU = 5

/** The Xcode app folder a path lives in: "/Applications/Xcode-beta.app". */
export const xcodeAppOf = (command: string) => XCODE_APP.exec(command)?.[1]

const isXcodeMain = (command: string) => XCODE_MAIN.test(headOf(command).trim())
const isBuildService = (command: string) => BUILD_SERVICE.test(exeOf(command))
const isTestRunner = (command: string) => exeOf(command) === 'xctest' || exeOf(command).endsWith('-Runner')

/** XCTest marks a test host's environment; a plain app run has none of these. */
const TEST_ENV = /(?:^|\s)(?:XCTestConfigurationFilePath|XCTestSessionIdentifier|XCTestBundlePath)=|libXCTestBundleInject/

/** True when `ps -E` output (command plus environment) shows the process runs under XCTest. */
export const isTestEnv = (envText: string) => TEST_ENV.test(envText)

/** `ps -wwE -o pid=,command=` output split into one text per requested pid. */
export function envByPid(out: string, pids: number[]): Map<number, string> {
  const wanted = new Set(pids)
  const found = new Map<number, string>()
  let current: number | undefined
  for (const line of out.split('\n')) {
    const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1])
    if (wanted.has(pid)) {
      current = pid
      found.set(pid, line)
    } else if (current !== undefined) found.set(current, `${found.get(current) ?? ''}\n${line}`)
  }

  return found
}

/** Pids of apps running under an Xcode app's debugger: the only ones whose environment is read. */
export function xcodeAppPids(procs: Proc[], byPid: Map<number, Proc>): number[] {
  return procs
    .filter(p => APP_PATH.test(p.command))
    .filter(p => ancestorsOf(p.pid, byPid).some(pid => isXcodeMain(byPid.get(pid)?.command ?? '')))
    .map(p => p.pid)
}

const KINDS = ['test-without-building', 'build-for-testing', 'test', 'archive', 'analyze', 'build', 'clean']

/** The action in xcodebuild's arguments; no action word means build. */
export function kindOfArgs(command: string): string {
  const words = new Set(command.split(/\s+/))

  return KINDS.find(k => words.has(k)) ?? 'build'
}

export type SimProc = { proc: Proc; udid: string }

/** Processes that live in a simulator, with its UDID (from the groups buildSnapshot already made). */
export function simProcsOf(procs: Proc[], groupById: Map<number, string>): SimProc[] {
  return procs.flatMap(proc => {
    const group = groupById.get(proc.pid) ?? ''

    return group.startsWith('sim:') ? [{ proc, udid: group.slice(4) }] : []
  })
}

// ---------- who started a build ----------

export type IdentityInput = {
  procs: Proc[]
  byPid: Map<number, Proc>
  simProcs: SimProc[]
  agents: AgentRecord[]
  /** Xcode app folder -> CFBundleShortVersionString. */
  versions: Map<string, string>
  now: number
  /** Pids of apps whose environment shows XCTest (unit tests run inside the host app). */
  testPids?: Set<number>
}

export type Identity = Pick<BuildTree, 'source' | 'who' | 'kind' | 'isOwnerBuild' | 'isCompiling'> & {
  /** The owner to record; replaces ownerOf's guess when ancestry says it is the owner's build. */
  owner: Owner
  xcodeVersion?: string
  xcodeName?: string
  /** The simulator an Xcode-app build is linked to (its app runs there). */
  targetSim?: string
}

/** An agent's open mcp__xcode__ tool call, newest first: Xcode is building on its behalf. */
const openXcodeCall = (agents: AgentRecord[], now: number) =>
  agents
    .flatMap(rec =>
      rec.activities.filter(a => a.viaXcode && a.endedAt === undefined && isOpen(a, now)).map(a => ({ rec, a })),
    )
    .sort((x, y) => y.a.at - x.a.at)[0]

/** Who an Xcode-app run or build belongs to: the agent driving Xcode, else the owner. */
const xcodeOwner = (via: ReturnType<typeof openXcodeCall>) => {
  const who = via ? `${via.rec.label} via Xcode` : 'You · Xcode app'
  const owner: Owner = via ? { session: via.rec.session, label: who, how: 'xcode' } : { label: who, how: 'xcode' }

  return { who, owner }
}

/** The Xcode version and folder name for a path inside an Xcode app. */
const xcodeNamesOf = (path: string | undefined, versions: Map<string, string>) => ({
  xcodeVersion: path ? versions.get(path) : undefined,
  xcodeName: path?.split('/').pop()?.replace(/\.app$/, ''),
})

/** One identify function per sample: it indexes the process list once. */
export function createIdentifier(input: IdentityInput) {
  const { byPid, simProcs, agents, versions, now } = input
  const testPids = input.testPids ?? new Set<number>()
  const children = new Map<number, Proc[]>()
  for (const p of input.procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])

  const below = (pid: number): Proc[] => {
    const out: Proc[] = []
    const seen = new Set<number>([pid])
    const stack = [pid]
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      for (const c of children.get(id) ?? []) {
        if (seen.has(c.pid)) continue
        seen.add(c.pid)
        out.push(c)
        stack.push(c.pid)
      }
    }

    return out
  }

  return (root: Proc, members: Proc[], owner: Owner): Identity => {
    const all = [root, ...below(root.pid)]
    const compileCpu = all.reduce((sum, p) => (COMPILE_TOOL.test(exeOf(p.command)) ? sum + p.cpu : sum), 0)
    const isCompiling = compileCpu >= COMPILE_CPU
    const parent = byPid.get(root.ppid)
    const above = ancestorsOf(root.pid, byPid).flatMap(pid => byPid.get(pid) ?? [])
    const xcodeMain = parent && isBuildService(root.command) && isXcodeMain(parent.command) ? parent : undefined

    const isAgent = owner.how === 'pid' || owner.how === 'ticket' || owner.how === 'claude'
    const source: BuildSource = isAgent
      ? 'agent'
      : xcodeMain
        ? 'xcode-app'
        : above.some(a => TERMINAL.test(headOf(a.command)))
          ? 'terminal'
          : 'unknown'

    const app = [root, ...members, parent].flatMap(p => (p ? [xcodeAppOf(p.command)] : [])).find(Boolean)
    const via = source === 'xcode-app' ? openXcodeCall(agents, now) : undefined
    const base = xcodeNamesOf(app, versions)

    if (source === 'terminal') {
      const who = 'You · Terminal'

      return { ...base, source, who, owner: { label: who, how: 'terminal' }, isOwnerBuild: true, isCompiling, kind: kindOf(members) }
    }
    if (source !== 'xcode-app' || !xcodeMain) {
      return { ...base, source, who: owner.label, owner, isOwnerBuild: false, isCompiling, kind: kindOf(members) }
    }

    // An Xcode-app build: its app runs under the debugger, a child of the Xcode process.
    const dd = members.map(m => derivedDataPath(m.command)).find(Boolean)
    const fromThisXcode = (p: Proc) =>
      ancestorsOf(p.pid, byPid).includes(xcodeMain.pid) || (dd !== undefined && p.command.includes(dd))
    const target = simProcs
      .filter(s => APP_PATH.test(s.proc.command) && fromThisXcode(s.proc))
      .sort((a, b) => b.proc.pid - a.proc.pid)[0]
    const runner =
      (target !== undefined && testPids.has(target.proc.pid)) ||
      simProcs.some(s => isTestRunner(s.proc.command) && (fromThisXcode(s.proc) || s.udid === target?.udid))
    const { who, owner: xcodeOwnerOf } = xcodeOwner(via)
    const kind = via ? (via.a.kind === 'test' ? 'test' : via.a.kind === 'build' ? 'build' : 'run') : runner ? 'test' : target ? 'run' : 'build'

    return {
      ...base,
      source,
      who,
      kind,
      owner: xcodeOwnerOf,
      isOwnerBuild: via === undefined,
      isCompiling,
      targetSim: target?.udid,
    }
  }

  /** From the xcodebuild arguments. */
  function kindOf(members: Proc[]): string {
    const xcodebuild = members.find(m => XCODEBUILD.test(exeOf(m.command)))

    return xcodebuild ? kindOfArgs(xcodebuild.command) : 'build'
  }
}

// ---------- words ----------

type Whoish = { who?: string; owner?: Owner; xcodeVersion?: string; xcodeName?: string }

/** "Xcode 27.0", else the app's folder name ("Xcode-beta"), else nothing. */
export const versionText = (t: Pick<Whoish, 'xcodeVersion' | 'xcodeName'>) =>
  t.xcodeVersion ? `Xcode ${t.xcodeVersion}` : t.xcodeName

/** The label with the version folded in: "You · Xcode 27.0", "feature-a via Xcode 27.0". */
export function whoWithVersion(t: Whoish): string {
  const who = t.who ?? t.owner?.label ?? ''
  const v = versionText(t)
  if (!v) return who
  if (who.endsWith('Xcode app')) return `${who.slice(0, -'Xcode app'.length)}${v}`
  if (who.endsWith('via Xcode')) return `${who.slice(0, -'Xcode'.length)}${v}`

  return `${who} · ${v}`
}

/** "You · Xcode 27.0 finished run (52s)"; snapshots from before kinds existed keep the old words. */
export function buildEventText(t: BuildTree, verb: 'started' | 'finished', took?: string): string {
  const time = took ? ` (${took})` : ''
  if (t.kind === undefined) return `${t.owner.label}${t.scheme ? ` (${t.scheme})` : ''} ${verb} building${time}`

  return `${whoWithVersion(t)} ${verb} ${t.kind}${t.scheme ? ` ${t.scheme}` : ''}${time}`
}

// ---------- queue hold ----------

/** The owner's build that is compiling right now; the queue holds while there is one. */
export const holdingTree = (trees: BuildTree[]) => trees.find(t => t.isOwnerBuild && t.isCompiling)

/** Contents of the `hold` file: who, and since when (epoch seconds). */
export const holdText = (t: BuildTree, sinceSec: number) =>
  `label=${whoWithVersion(t)}\nsince=${sinceSec}\n`

// ---------- finished builds ----------

export const RECENT_BUILD_MS = 30 * 60_000
const RECENT_LIMIT = 8

/** Trees in `before` that are gone from `after`, as finished builds. */
export function finishedBuilds(before: BuildTree[], after: BuildTree[], at: number): FinishedBuild[] {
  const still = new Set(after.map(t => t.rootPid))

  return before
    .filter(t => !still.has(t.rootPid))
    .map(t => ({
      who: t.who ?? t.owner.label,
      kind: t.kind ?? 'build',
      ...(t.scheme && { scheme: t.scheme }),
      ...(t.xcodeVersion && { xcodeVersion: t.xcodeVersion }),
      ...(t.sim && { sim: t.sim }),
      ...(t.folder && { folder: t.folder }),
      endedAt: at,
      tookS: Math.round((at - t.startedAt) / 1000),
    }))
}

/** New finished builds first, anything older than 30 minutes dropped. */
export const mergeRecent = (prev: FinishedBuild[] | undefined, fresh: FinishedBuild[], now: number) =>
  [...fresh, ...(prev ?? [])].filter(r => now - r.endedAt < RECENT_BUILD_MS).slice(0, RECENT_LIMIT)

// ---------- where an installed app came from ----------

const sameSim = (ref: string | undefined, sim: { udid: string; name: string }) =>
  ref !== undefined && (ref.toUpperCase() === sim.udid || ref === sim.name)

type XcodeRun = { app: SimProc; xcode: Proc }

/** Apps in a simulator that run under an Xcode app's debugger, newest first. */
export function xcodeRunsOf(input: Pick<IdentityInput, 'byPid' | 'simProcs'>): XcodeRun[] {
  return input.simProcs
    .filter(s => APP_PATH.test(s.proc.command))
    .flatMap(app => {
      const xcode = ancestorsOf(app.proc.pid, input.byPid)
        .flatMap(pid => input.byPid.get(pid) ?? [])
        .find(p => isXcodeMain(p.command))

      return xcode ? [{ app, xcode }] : []
    })
    .sort((a, b) => b.app.proc.pid - a.app.proc.pid)
}

/** Who started an Xcode-app run: the agent driving Xcode, or the owner; with the Xcode version. */
function xcodeRunWho(run: XcodeRun, input: IdentityInput) {
  const via = openXcodeCall(input.agents, input.now)

  return { via, ...xcodeOwner(via), ...xcodeNamesOf(xcodeAppOf(run.xcode.command), input.versions) }
}

/**
 * Xcode runs whose app is still going, as rows. Not builds: nothing compiles, so they stay out of
 * `trees` (queue hold, pause and overload count those). Skipped while that Xcode is compiling.
 */
export function xcodeRunTrees(
  input: IdentityInput & { trees: BuildTree[]; prev: BuildTree[]; recent: FinishedBuild[]; memOf: (p: Proc) => number },
): BuildTree[] {
  const compiling = new Set(input.trees.map(t => input.byPid.get(t.rootPid)?.ppid))

  return xcodeRunsOf(input)
    .filter(r => !compiling.has(r.xcode.pid))
    .map(r => {
      const { via, who, owner, xcodeVersion, xcodeName } = xcodeRunWho(r, input)
      const pid = r.app.proc.pid
      const before = input.prev.find(t => t.rootPid === pid)
      // The folder is not in the app's process: reuse the last run's, else the build that made it.
      const folder =
        before?.folder ??
        input.recent.find(f => f.who === who && f.xcodeVersion === xcodeVersion && f.folder)?.folder

      return {
        rootPid: pid,
        owner,
        memMb: Math.round(input.memOf(r.app.proc)),
        cpu: Math.round(r.app.proc.cpu * 10) / 10,
        procs: 1,
        sim: r.app.udid,
        startedAt: before?.startedAt ?? input.now,
        isPaused: false,
        isXcode: false,
        source: 'xcode-app',
        who,
        kind: input.testPids?.has(pid) ? 'test' : 'run',
        isOwnerBuild: via === undefined,
        isCompiling: false,
        ...(folder && { folder }),
        ...(xcodeVersion && { xcodeVersion }),
        ...(xcodeName && { xcodeName }),
      }
    })
}

/** "You · Xcode 27.0 run" for an app started by an Xcode app, else the latest finished build for it. */
export function appFromText(
  sim: { udid: string; name: string },
  input: IdentityInput & { recent: FinishedBuild[] },
): string | undefined {
  const run = xcodeRunsOf(input).find(r => r.app.udid === sim.udid)
  if (run) return `${whoWithVersion(xcodeRunWho(run, input))} run`
  const r = input.recent.find(x => sameSim(x.sim, sim))

  return r ? `${whoWithVersion(r)} ${r.kind} ${fmtElapsed((input.now - r.endedAt) / 1000)} ago` : undefined
}
