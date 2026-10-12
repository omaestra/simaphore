export type GroupStat = {
  id: string
  label: string
  memMb: number
  cpu: number
  procs: number
}

/** What an app in a simulator is doing: on screen, running behind, or frozen. */
export type AppLife = 'front' | 'background' | 'suspended'

export type SimState = 'Booted' | 'Booting' | 'Shutting Down'

export type SimStat = {
  udid: string
  name: string
  runtime: string
  state: SimState
  memMb: number
  cpu: number
  /** True when an installed app has a process inside this simulator. */
  isAppRunning: boolean
  /** CPU of the app processes inside it (Apple's or yours); absent in older files. */
  appCpu?: number
  /** Which build the running app came from, when known; absent in older files. */
  appFrom?: string
}

/** A simulator that had a letter and is shut down now; the letter is freed after 10 minutes. */
export type StoppedSim = { udid: string; name: string; runtime: string; since: number }

export type HostInfo = {
  /** Free disk on the home volume, in GB, and when it was read. */
  freeGb?: number
  freeAt?: number
  /** Size of DerivedData and of the simulator devices folder, in MB, and when each was measured. */
  derivedDataMb?: number
  derivedDataAt?: number
  simDevicesMb?: number
  simDevicesAt?: number
  /** The active Xcode: its version, its Developer folder, and when it was read. */
  xcodeVersion?: string
  xcodePath?: string
  xcodeAt?: number
  /** A Swift package fetch or resolve is running now. */
  isSpmBusy?: boolean
}

/** One 3-second slot of the timeline ring: [activity char, owner colour] per booted simulator. */
export type TimelineSlot = {
  at: number
  sims: Record<string, [string, string?]>
  /** Pressure score 0-100. */
  p: number
  /** Booted simulators. */
  b: number
  /** Places of tickets that joined the queue in this slot. */
  q?: number[]
}

export type BuildStat = { label: string; memMb: number; cpu: number; procs: number }

/** Who a build belongs to, and how we worked it out. */
export type Owner = {
  session?: string
  /** Subagent id when the build came from one. */
  agent?: string
  label: string
  how: 'pid' | 'ticket' | 'claude' | 'derived-data' | 'workspace' | 'xcode' | 'terminal' | 'none'
}

/** Who started a build, worked out from the processes above it. */
export type BuildSource = 'agent' | 'xcode-app' | 'terminal' | 'unknown'

/** One running build: an xcodebuild -jobs 6 (or an Xcode build service) and everything under it. */
export type BuildTree = {
  rootPid: number
  owner: Owner
  memMb: number
  cpu: number
  procs: number
  scheme?: string
  /** The -destination simulator as written: a UDID or a device name. */
  sim?: string
  /** Epoch ms. */
  startedAt: number
  isPaused: boolean
  isXcode: boolean
  /** The fields below are absent in snapshots written by older versions. */
  source?: BuildSource
  /** Who, in words: "feature-a", "You · Xcode app", "feature-a via Xcode", "You · Terminal". */
  who?: string
  /** build, test, run ... */
  kind?: string
  /** The Xcode version ("27.0"), when its Info.plist was readable. */
  xcodeVersion?: string
  /** The Xcode app's folder name without .app, e.g. "Xcode-beta". */
  xcodeName?: string
  /** True for the owner's own build (Xcode app or terminal, not driven by an agent). */
  isOwnerBuild?: boolean
  /** True while compiler, linker or asset tools under it use CPU. */
  isCompiling?: boolean
  /** The folder it was built from (the workspace's parent), when it could be found. */
  folder?: string
  /** Git branch of that folder; the sampler fills it in, cached for 30 s. */
  branch?: string
  /** The -derivedDataPath it uses, or the DerivedData folder in its processes; absent when default. */
  derivedData?: string
}

/** A build that finished lately; the pane uses it to say where an installed app came from. */
export type FinishedBuild = {
  who: string
  kind: string
  scheme?: string
  xcodeVersion?: string
  sim?: string
  folder?: string
  endedAt: number
  tookS: number
}

export type Overload = {
  isOverloaded: boolean
  reasons: string[]
  cause: string
  /** Epoch ms the current overload began. */
  since?: number
  peakLoad?: number
  peakSwapMb?: number
}

export type PerfEventKind =
  | 'build-start'
  | 'build-end'
  | 'sim-boot'
  | 'sim-stop'
  | 'sim-shared'
  | 'overload-start'
  | 'overload-end'

export type PerfEvent = { at: number; kind: PerfEventKind; text: string }

/** A simulator that two or more agents used in the last 5 minutes. */
export type SharedSim = { key: string; name: string; users: string[] }

/** One history point: memory (g) and CPU (c) in MB / percent per group id. */
export type Point = { at: number; g: Record<string, number>; c?: Record<string, number> }

export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical'

/** The result of one queued command, written by bin/xcq when it ends: results/<ticket-id>.json. */
export type RunResult = {
  session: string
  agent: string
  label: string
  kind: string
  exit: number
  /** Epoch ms. */
  endedAt: number
  tookS: number
}

export type Snapshot = {
  at: number
  /** Pids of running claude processes, to count sessions that are not tracked. */
  claudePids?: number[]
  /** How long the sample took, in ms. */
  sampleMs: number
  cores: number
  ramMb: number
  swapUsedMb: number
  swapTotalMb: number
  /** macOS memory pressure: 1 normal, 2 warning, 4 critical; absent in older files. */
  pressureLevel?: number
  load: number[]
  /** Share of all cores the processes use, 0-100 (sum of ps %cpu / cores); absent in older files. */
  cpuPct?: number
  /** From `pmset -g therm`, read every 10 s by the sampler; absent in older files. */
  thermal?: ThermalState
  /** True when memory came from top (counts compressed/swapped pages). */
  hasTop: boolean
  groups: GroupStat[]
  sims: SimStat[]
  builds: BuildStat[]
  trees: BuildTree[]
  /** Xcode runs whose app still runs in a simulator; rows, not builds (nothing compiles). */
  runs?: BuildTree[]
  overload: Overload
  /** Newest first, at most 30. */
  events: PerfEvent[]
  /** Simulators used by two or more agents; absent in older files. */
  shared?: SharedSim[]
  /** Sessions in `xcsim wait|run`, with when each was first seen waiting (epoch ms); absent in older files. */
  simWaits?: { session: string; agent: string; udid: string; since: number; name?: string; runtime?: string }[]
  /** Builds that ended in the last 30 minutes (the pane shows 10), newest first. */
  recent?: FinishedBuild[]
  /** Epoch ms since which each simulator has been under the idle CPU limit. */
  idleSince: Record<string, number>
  /** Epoch ms an agent last used each simulator, so a new sampler can still shut it down; absent in older files. */
  agentUsedAt?: Record<string, number>
  history: Point[]
  /** Queued commands that ended in the last hour, newest first; absent in older files. */
  results?: RunResult[]
  /** Simulator letter (A, B, C ...) by UDID; absent in older files. */
  letters?: Record<string, string>
  /** Simulators shut down in the last 10 minutes (they keep their letter); absent in older files. */
  stopped?: StoppedSim[]
  /** Bundle ids of the apps running in each booted simulator, by UDID, read every 15 s; absent in older files. */
  runningApps?: Record<string, string[]>
  /** Lifecycle state of those apps, by UDID then bundle id; an app missing here is unknown; absent in older files. */
  appStates?: Record<string, Record<string, AppLife>>
  /** True while the owner has paused the queue (the queue-paused file exists); absent in older files. */
  isQueuePaused?: boolean
  /** False once `xcrun simctl list` failed (timed out or gave garbage) twice in a row. */
  simctlOk?: boolean
  /** Epoch ms of the latest failed `simctl list`; absent while it answers. */
  simctlFailedAt?: number
  /** Facts about the machine that change slowly (the sampler collects them in the background). */
  host?: HostInfo
  /** At most 200 slots of 3 s, oldest first; absent in older files. */
  timeline?: TimelineSlot[]
}

export type Ticket = {
  id: string
  pid: number
  label: string
  queued: number
  state: 'waiting' | 'running'
  started: number
  cmd: string
  hasPrio: boolean
  session: string
  agent: string
  sim: string
  workspace: string
  cwd: string
  /** Why it waits: turn, sim, room, memory, critical, paused or hold. */
  waiting?: string
}

export type ActivityKind = 'build' | 'test' | 'boot' | 'install' | 'launch' | 'drive' | 'verify' | 'run'

export type Activity = {
  /** 'main' or a subagent id. */
  agent: string
  kind: ActivityKind
  /** A UDID or a device name, as the command spelled it. */
  sim?: string
  scheme?: string
  detail: string
  /** The action word (screenshot, tap, install ...); older records lack it. */
  verb?: string
  at: number
  endedAt?: number
  /** Left running on purpose (background command, open drive session): processes decide. */
  isBackground?: boolean
  /** Came from an mcp__xcode__ tool call: Xcode itself does the build. */
  viaXcode?: boolean
  /** The Xcode window (tabIdentifier) an mcp__xcode__ call used. */
  tab?: string
  toolUseId: string
}

/** One Claude session's registry file: ~/.claude/simaphore/agents/<session>.json */
export type AgentRecord = {
  session: string
  pid: number
  cwd: string
  label: string
  branch: string
  lastSeen: number
  /** Epoch ms of this session's latest tool call, of any kind; older records lack it. */
  lastToolAt?: number
  /** Newest first, at most 10. */
  activities: Activity[]
  /** What the session is about: the first words of its first prompt. */
  title?: string
  /** Helpers this session started: agent id to the description it was given. */
  subagents?: Record<string, string>
  /** Ids of helpers that finished, so the sampler can free their simulators. */
  endedSubagents?: string[]
}

/** What a destructive key will do on its second press: the action and what it touches. */
export type ConfirmAction = 'shutdown' | 'clean' | 'shutdownIdle'
export type Confirm = { action: ConfirmAction; targets: string[] }

declare module 'claude-code' {
  interface PluginState {
    'simaphore': {
      snapshot: Snapshot | null
      queue: Ticket[]
      agents: AgentRecord[]
      frame: number
      /** The destructive key waiting for its second press (8 s), or null. */
      confirm: Confirm | null
      /** Panel toggles: the timeline (t) and shut-down simulators (a). */
      isTimelineShown: boolean
      isAllSimsShown: boolean
      /** The settings view is shown instead of the panel. */
      isSettingsShown: boolean
      /** UDID of the simulator whose details block is open. */
      openDetails: string | null
      /** The `key` of the pane element holding the focus ring (sim rows are `sim-<udid>`). */
      focused: string | null
      /** Simulator leases read from $DIR/leases each sample. */
      leases: { udid: string; label: string; session: string; agent: string; lastUsed: number }[]
      /** UDIDs in $DIR/reserved (the owner's own simulators), read each sample. */
      reserved: string[]
      /** Demo scenario drawn instead of live data, or null. */
      demo: string | null
    }
  }
}
