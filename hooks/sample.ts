// Pure maths for the Swift helper's sample lines: no I/O, no clock, so it can be tested on fixtures.
import type { ThermalState } from '../types'
import type { Proc, Sysctl } from './logic'

type Mine = { pid: number; ppid: number; cpuNs: number; footprint: number; startSec: number; command: string }
type Other = { pid: number; ppid: number; uid: number; path: string }

export type HelperLine = {
  at: number
  cores: number
  /** Raw 32-bit counters: user, system, idle, nice. */
  ticks: [number, number, number, number]
  swap: [number, number]
  load: number[]
  mem: number
  pressure: number
  thermal: number
  mine: Mine[]
  others: Other[]
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNums = (v: unknown, n?: number): v is number[] =>
  Array.isArray(v) && (n === undefined || v.length === n) && v.every(isNum)

/** One line from `xcwatch sample`; undefined when it is not a good sample line. Bad rows are skipped. */
export function parseHelperLine(line: string): HelperLine | undefined {
  let j: any
  try {
    j = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!j || j.kind !== 'sample') return undefined
  if (!isNum(j.at) || !isNum(j.cores) || !isNum(j.mem) || !isNum(j.pressure) || !isNum(j.thermal)) return undefined
  if (!isNums(j.ticks, 4) || !isNums(j.swap, 2) || !isNums(j.load)) return undefined
  if (!Array.isArray(j.mine) || !Array.isArray(j.others)) return undefined

  const mine: Mine[] = []
  for (const r of j.mine) {
    if (Array.isArray(r) && isNums(r.slice(0, 5)) && r.length >= 6 && typeof r[5] === 'string')
      mine.push({ pid: r[0], ppid: r[1], cpuNs: r[2], footprint: r[3], startSec: r[4], command: r[5] })
  }
  const others: Other[] = []
  for (const r of j.others) {
    if (Array.isArray(r) && isNums(r.slice(0, 3)) && r.length >= 4 && typeof r[3] === 'string')
      others.push({ pid: r[0], ppid: r[1], uid: r[2], path: r[3] })
  }

  return {
    at: j.at, cores: j.cores, ticks: j.ticks, swap: j.swap, load: j.load,
    mem: j.mem, pressure: j.pressure, thermal: j.thermal, mine, others,
  }
}

const WRAP = 2 ** 32
const delta = (a: number, b: number) => (((b - a) % WRAP) + WRAP) % WRAP
const round1 = (n: number) => Math.round(n * 10) / 10

/** Whole-Mac CPU % (0..100) between two lines; undefined with no earlier line or no ticks between. */
export function hostCpuPct(prev: HelperLine | undefined, cur: HelperLine): number | undefined {
  if (!prev) return undefined
  const [u, s, i, n] = cur.ticks.map((t, k) => delta(prev.ticks[k]!, t)) as [number, number, number, number]
  const busy = u + s + n
  const total = busy + i
  if (total === 0) return undefined

  return round1((busy / total) * 100)
}

/** Process rows for `buildSnapshot` and memory per pid in MB. `top` fills in other accounts' processes. */
export function helperProcs(
  prev: HelperLine | undefined,
  cur: HelperLine,
  top: { mem: Map<number, number>; cpu: Map<number, number> } | undefined,
): { procs: Proc[]; memMb: Map<number, number> } {
  const before = new Map(prev?.mine.map((p) => [p.pid, p]))
  const dtMs = prev ? cur.at - prev.at : 0
  const nowSec = Math.floor(cur.at / 1000)
  const procs: Proc[] = []
  const memMb = new Map(top?.mem)

  for (const p of cur.mine) {
    const old = before.get(p.pid)
    const isSame = old && old.startSec === p.startSec
    // No earlier row, but it started inside this window: all its time is this window's.
    const isNew = !isSame && prev !== undefined && p.startSec > 0 && p.startSec * 1000 >= prev.at - 1000
    const ns = isSame ? p.cpuNs - old.cpuNs : isNew ? p.cpuNs : 0
    const cpu = dtMs > 0 && ns > 0 ? round1((ns / (dtMs * 1e6)) * 100) : 0
    const proc: Proc = { pid: p.pid, ppid: p.ppid, cpu, rssKb: Math.round(p.footprint / 1024), command: p.command }
    if (p.startSec > 0) proc.ageS = Math.max(0, nowSec - p.startSec)
    procs.push(proc)
    memMb.set(p.pid, p.footprint / 1048576)
  }
  for (const o of cur.others)
    procs.push({ pid: o.pid, ppid: o.ppid, cpu: top?.cpu.get(o.pid) ?? 0, rssKb: 0, command: o.path })

  return { procs, memMb }
}

/** The sysctl numbers the sampler needs, from a helper line. */
export function helperSysctl(cur: HelperLine): Sysctl {
  return {
    swapUsedMb: cur.swap[1] / 1048576,
    swapTotalMb: cur.swap[0] / 1048576,
    load: cur.load,
    ramMb: cur.mem / 1048576,
    pressureLevel: cur.pressure,
  }
}

/** `ProcessInfo.thermalState` number to the heat state; anything unknown is nominal. */
export function thermalOf(n: number): ThermalState {
  return n === 1 ? 'fair' : n === 2 ? 'serious' : n === 3 ? 'critical' : 'nominal'
}
