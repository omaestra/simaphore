# Intent: timeline-steady-scroll

Authored: 2026-11-04 · branch: feature/timeline-steady-scroll · tier: medium · captured: /intent
Revised: 2026-11-04 · R7, D5 and P4 added after the live check, at the owner's request

## Problem
> The simaphore timeline updates behaves strangely with no recognizable pattern, lets improve the
> refresh/update of the timeline to make every tick update the entire timeline live.

> So far, I don't see a consistent update moving the data to the left.

Recording is fine: one slot every 3 s (196 of 199 gaps in the live `latest.json` were 3.0 s). The
drawing is the problem. `timelineLanes` (`hooks/model.ts:693`) squeezes 10 minutes into the lane's
width, so on a typical panel one column is about 11 s (3.6 ticks): most ticks nothing moves, then
everything jumps one column, every 3 or 4 ticks. The column edges are counted back from the
redraw time, so slots regroup on every tick and a block grows or shrinks by a cell as it moves. And
the panel redraws for the mascot every 0.4 s while an agent is busy, each time with a new clock, so
the jumps land at random moments between ticks.

> maybe 1 second ticks is not the right way to go, but steadiness is. We can adjust the intervals
> later

The live check of R1–R6 found the moves still come 1.8 to 4.2 s apart. Every 4th tick waits for
`top` (about 0.8 s), so its column shows up a second late and the next one seems early. An update
started by an event can also add a column early, or be running when the timer fires and make it
skip a tick.

## Outcome
Every 3-second tick moves the whole timeline exactly one column to the left, with the new tick on the
right. Nothing moves between ticks. Anything drawn keeps its shape as it scrolls. The heading says
how much time fits in the panel's width.

## Constraints
- Nothing about what is recorded changes: still 200 slots, one per 3 s, with the same `latest.json`
  shape, so sessions running another version keep reading it.
- The drawing stays pure (CONTRIBUTING.md): `hooks/model.ts` and `hooks/screen.tsx` get everything as
  input and read no clock of their own.

## Requirements
- R1: When a new tick is recorded, every mark on the timeline (simulator lanes, budget, queue,
  pressure) moves exactly one column left and the new tick fills the rightmost column. This still
  holds when ticks come a little early or late (2.5 to 3.5 s apart). So something that lasted n ticks
  is drawn n columns wide at every tick, until it scrolls off the left edge.
- R2: Between two ticks the timeline doesn't change, however often the panel redraws (mascot frames,
  key presses).
- R3: A tick that wasn't recorded (the recorder was busy, the Mac slept) leaves an empty column
  instead of squeezing the rest together. A gap wider than the timeline leaves only the newer part on
  screen.
- R4: The timeline's heading says how much time it shows at the current width, and never more than
  the 10 minutes recorded.
- R5: A simulator gets a lane only if it shows up within the time on screen.
- R6: README.md, docs/how-it-works.md and the screenshots in docs/images/ describe and show the new
  timeline.
- R7: The timeline moves at an even pace: each tick is on screen within 0.5 s of when it was taken,
  so the moves come 2.5 to 3.5 s apart however busy the Mac is. Reads that run only now and then
  (memory per app, the simulator list, heat) never hold a tick back. A tick that is due while another
  update is running waits for it instead of being skipped. Only the 3-second timer adds a column; an
  early update started by an event refreshes the rest of the panel, not the timeline.

## Decisions
- D1: One column per recorded tick — beat: 10-minute buckets fixed to the clock; that plus a zoom key;
  two ticks per cell with half-blocks — why: the owner's pick, and the only one where every tick moves
  the whole timeline. Cost: a panel about 80 wide shows about 3 minutes, not 10.
- D2: The right edge is the newest recorded tick, not the redraw time — beat: the redraw time (as
  today) — why: the clock moves between ticks, which causes the random jumps; the header already
  shows a red "stale Ns" when the recorder stops (`hooks/screen.tsx:710`).
- D3: Going back from the newest tick, each older tick is placed by its spacing rounded to whole ticks,
  and never less than one column apart — beat: placing ticks side by side whatever their time —
  why: normal jitter still moves exactly one column, and a real gap stays visible.
- D4: The heading reads "the last N min, newest on the right" (whole minutes rounded down; seconds
  under a minute) — beat: keeping "the last 10 minutes" — why: that would be wrong at almost every
  width. The owner may change the wording.
- D5: Slow reads run on their own and each tick uses their last answer — beat: 1-second ticks; a
  steady sender in `bin/xcwatch` that reads the numbers itself on a fixed timer — why: the owner
  wants steadiness now and the intervals tuned later, and this is the smallest change that gives
  it. It is the pattern the sampler already uses for disk sizes and running apps (`refreshHost`,
  `refreshApps`). An answer that comes back starts an early update, so it shows as soon as today.

## Out of scope
- A zoom key or a 10-minute view (the "A plus zoom" option); a possible follow-up.
- How often ticks are recorded, and how many are kept.
- Idle and switched-off simulators both being drawn as `·`.
- Panels in other sessions reading the recorder's file on their own 3 s timer.
- 1-second ticks, other read intervals, and a steady sender in `bin/xcwatch`: the intervals can be
  tuned later.

## Steps
| Step | Serves | Files | Tests |
|---|---|---|---|
| P1 | R1, R3, R5 | `hooks/model.ts` (`timelineLanes`: one column per tick, placed back from the newest tick; no `now`) | `hooks/model.test.ts` (extended: shift by one with jitter, width kept, gap gives empty columns, lanes only for sims in view) |
| P2 | R2, R4, R5 | `hooks/screen.tsx` (`timelineSegs`, `Timeline`: label width from the lanes in view, heading with the time shown) | `hooks/screen.test.ts` (extended: heading per width; two redraws within one tick draw the same timeline) |
| P3 | R6 | `hooks/demo.fixture.ts` (busy spans short enough that quiet-then-busy shows in about 3 minutes), `hooks/screen.snapshots.ts` (regenerated), `README.md`, `docs/how-it-works.md`, `docs/images/*.svg` (via `scripts/shots.sh`) | `hooks/screen.snapshot.test.ts`, `hooks/demo.test.ts` |
| P4 | R7 | `hooks/register.tsx` (`top`, `simctl list` and `pmset` run on their own; only the timer's tick adds a column; a tick due during another update runs right after it), `hooks/sideread.ts` (new) | `hooks/sideread.test.ts` (new: one read at a time, each answer taken once, an empty answer passed on, a read that throws gives none) |

## Scenarios to prove
- S1 (R1, R2): Load this checkout with `claude --plugin-dir <path>` and a throwaway `SIMAPHORE_DIR`,
  open `/simaphore`, and have an agent build or drive a spare simulator so the mascot moves. For about
  30 s, every 3 s the whole timeline moves one column left, nothing moves in between, and a build
  block keeps its width. (R7) The moves come 2.5 to 3.5 s apart, each within 0.5 s of its tick,
  including the ticks when `top` and the simulator list are read.
- S2 (R4): In the same panel, make the pane narrower and wider. The heading's time follows the width.

## Departures
- Review fixes (R1, R7): `hooks/timeline.ts` skips a slot only under 1.5 s after the last one
  (was 2.5 s), so a beat that ran late no longer drops the next one. `top` is read once per 10 s
  again, and answers that come back while a session isn't sampling are thrown away.
- Low review fixes (D5, R1, R5): an answer starts an early update only when it is new (not empty and
  not the same as the last one), so a failed or unchanged read no longer wakes the sampler. A lease
  counts as "simulator deleted" only if it was claimed before the device list was read. The label
  column is sized on the widest view, so the newest column stays put on screen; on a wide pane the
  labels take the spare room once the lane hits 200 columns. The lanes are worked out once per draw.
