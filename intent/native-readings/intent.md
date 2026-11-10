# Intent: native-readings

Authored: 2026-11-09 · branch: feature/native-readings · tier: medium · captured: from the
2026-11-09 research handoff (plan approved by the owner)
Supersedes in `intent/timeline-steady-scroll/intent.md`: D5 (it rejected "a steady sender in
`bin/xcwatch`"; this adds one) and the last sentence of R7 (the helper's line now adds the column;
the 3-second timer only when the helper is missing or late).

## Problem
simaphore's own reads cost about 11 s of CPU per minute on the owner's M2 Pro. Most of it is
`top -l 1` every 10 s: each run is a fresh `top` that pays its expensive first reading (1.5 s of
CPU). Every beat also runs `ps -Ao ...` (60-70 ms), `sysctl` and, every 10 s, `pmset -g therm`. On a
Mac that is already overloaded, simaphore adds to the load.

## Outcome
simaphore shows the same whole-Mac picture for about 4 s of CPU per minute, with memory numbers
three times fresher. One `top` stays open for every process's CPU and memory. A small Swift helper
(`xcwatch sample`) reads the rest straight from the kernel on a steady 3 s beat and drives the
timeline. Without the helper, everything works as today.

## Constraints
- Whole-Mac visibility (owner rule): every process on the Mac is still counted, other accounts and
  root included. Speed-ups may change how often something is read, never what is covered.
- Swift only, in `bin/xcwatch.swift`, built from source with Xcode's `swiftc`. No new toolchain,
  no prebuilt binary, no new dependency.
- `latest.json` keeps its shape, so sessions running another version keep reading it.
- The drawing stays pure (CONTRIBUTING.md). New parsing and math go in pure files with tests.

## Requirements
- R1: The sampler no longer runs `top -l 1`, and while the helper runs it no longer runs
  `ps -Ao`, `sysctl` or `pmset` on a beat. Its own reads cost under 5 s of CPU per minute.
- R2: Every process is still counted with its CPU and memory: the owner's from the helper, everyone
  else's (other accounts, root, security agents) from `top`. The header CPU % is the whole Mac's.
- R3: Memory per app is at most about 3 s old (was up to 10 s).
- R4: The timeline still moves one column every 2.5-3.5 s. While the helper runs, its line is the
  beat. With no line for 4.5 s, the 3-second timer does the beat the old way and the helper is
  restarted.
- R5: Nothing outlives simaphore: `top` and the helper stop when this session stops sampling (it
  is no longer the leader, simaphore is switched off, the session ends), and within a few seconds
  when the session crashes or is killed.
- R6: Without the helper (no `swiftc`, the build fails) or while it keeps crashing, the sampler
  reads `ps`, `sysctl` and `pmset` as today, with the `top` that stays open for memory.
- R7: README.md and docs/how-it-works.md say how the readings are taken.

## Decisions
- D1: One `top -l 0 -s 3 -stats pid,cpu,mem` stays open while this session samples — beat: a
  fresh `top -l 1` every 10 s (today); every 30 s — why: an open `top` costs 0.2 s per reading
  against 1.5 s for a fresh one, and its numbers are fresher.
- D2: Under heavy load `top` keeps running — beat: skip it (today); pause it with SIGSTOP/SIGCONT
  — why: heavy load is when the owner most needs to see what loads the Mac; an open `top` costs
  little, and a restart pays 1.5 s again. Pausing through the tether would stop the tether, not
  `top`.
- D3: `top` runs under `xcwatch tether` when the helper is built, plain otherwise — why: a crashed
  session cannot stop its own children; the tether can. A plain `top` dies of SIGPIPE on its next
  write once its reader is gone.
- D4: A `top` reading is complete when it has as many rows as its `Processes: N total` line says,
  or when the next reading starts. Each beat takes the latest complete reading; a reading never
  starts an update by itself — why: no doubled updates, and no waiting 3 s for the next header.
- D5: `top`'s first reading gives memory only; its %CPU is not valid.
- D6: `xcwatch sample` is its own process, not part of `events` — why: `events` restarts whenever
  the agent pids change.
- D7: The helper prints raw counters and TypeScript does the math. Every line carries full rows,
  so a lost line breaks nothing. The first line is a baseline: per-process CPU starts from the
  second, and the first line is not a beat.
- D8: The owner's processes: CPU from the helper's counters, memory from the helper's footprint
  (the same number as `top`'s MEM, fresher). Everyone else's: parent and program path from the
  helper, CPU and memory from `top`.
- D9: An early update (an event between beats) reuses the latest helper line instead of running
  `ps` — beat: `ps` on every early update — why: early updates come often during busy builds; a
  process list under 3 s old is enough to refresh the panel.
- D10: Heat comes from `ProcessInfo.thermalState` (0-3 maps onto nominal / fair / serious /
  critical) while the helper runs; `pmset -g therm` only in the fallback.
- D11: A helper that dies is restarted with the same backoff as the event watcher (1 s, 2 s, ...
  60 s); the timer covers the beats meanwhile.

## Out of scope
- Showing heavy outside programs by name in the panel (a likely follow-up; the data will be there).
- The other small `ps` calls in `hooks/register.tsx` (finding the session's pid, test apps' env,
  live panels) and `xcrun simctl list`.
- `causeLine` (`hooks/logic.ts`) is computed but never shown. Noted, not fixed here.

## Steps
| Step | Serves | Files | Tests |
|---|---|---|---|
| P1 | R1, R2, R3, R5 | `hooks/logic.ts` (`parseTop` reads the cpu column; a splitter for the streamed readings), `hooks/register.tsx` (one `top` kept open through `follow()`, stopped with the app streams and on exit, restarted with backoff; the `topRead` side read goes) | `hooks/logic.test.ts` (extended: splitter across chunks, row count and next header, cpu column, first reading's CPU ignored) |
| P2 | R1, R4, R5 | `bin/xcwatch.swift` (`sample [--every S]`: one JSON line on fixed marks; exits with its parent), `bin/xcwatch` (usage) | `tests/xcwatch-test.sh` (extended: a line every beat, the line's fields, exits with its parent) |
| P3 | R2, R3 | `hooks/sample.ts` (new: parse a line, CPU % from two lines, rows for `buildSnapshot`, host CPU %, sysctl and heat) | `hooks/sample.test.ts` (new: parsing, first line, reused pid, counter going backwards, tick counter wrap, others from `top`) |
| P4 | R1, R2, R4, R6, R7 | `hooks/register.tsx` (helper lines drive the beat; timer as safety net; fallback), `hooks/logic.ts` (`buildSnapshot` takes a whole-Mac CPU %), `README.md`, `docs/how-it-works.md` | `hooks/logic.test.ts` (CPU % passed in wins) |

## Scenarios to prove
- S1 (R1, R4): Load this checkout with `claude --plugin-dir <path>` and a throwaway `SIMAPHORE_DIR`
  (`.claude/skills/verify`). Open `/simaphore`. For 60 s the timeline moves every 2.5-3.5 s. One
  `top` and one `xcwatch sample` run; together they use under 5 s of CPU per minute; no
  `top -l 1` or `ps -Ao` runs on a beat.
- S2 (R4, D11): Kill the helper. The timeline keeps moving, and a new helper starts.
- S3 (R5): Close the pane, then kill the `claude` process with SIGKILL. `top` and the helper are
  gone within a few seconds.
- S4 (R2): With another account's processes running, the "other" group and the header CPU % still
  include them.
