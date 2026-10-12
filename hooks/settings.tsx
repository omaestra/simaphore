import { clipCells, fitCells } from './text'
import type { Ui } from './screen'
import { namesOf } from './model'

// The settings view: the plugin's userConfig fields as plain rows with - and + buttons. Pure: it gets
// Box/Text/Button and returns a tree; register.tsx writes the changes with $.config.set.

export type Field =
  | { key: string; label: string; help: string; kind: 'number'; def: number; min: number; max: number; step: number; unit?: string }
  | { key: string; label: string; help: string; kind: 'toggle'; def: boolean }

export const FIELDS: Field[] = [
  { key: 'maxSims', label: 'Simulator limit', help: 'Most simulators on at once. A command that needs one more waits for room.', kind: 'number', def: 2, min: 1, max: 12, step: 1 },
  { key: 'maxBuilds', label: 'Builds at once', help: 'How many agent builds may run together when memory is fine.', kind: 'number', def: 2, min: 1, max: 8, step: 1 },
  { key: 'buildJobs', label: 'Compiler jobs', help: 'Added as -jobs to a build that has none. Lower is gentler on the Mac.', kind: 'number', def: 6, min: 1, max: 16, step: 1 },
  { key: 'swapPercent', label: 'Memory is tight at', help: 'Swap used, as a percent of swap total. Past it, one build at a time.', kind: 'number', def: 85, min: 50, max: 100, step: 5, unit: '%' },
  { key: 'idleMinutes', label: 'Simulator is idle after', help: 'Minutes under 2% CPU before a simulator counts as idle.', kind: 'number', def: 10, min: 1, max: 120, step: 1, unit: ' min' },
  { key: 'lowDiskGb', label: 'Warn below free disk', help: 'The panel warns when free disk space is under this many GB.', kind: 'number', def: 20, min: 1, max: 500, step: 5, unit: ' GB' },
  { key: 'renameSims', label: 'Rename held simulators', help: 'Show who has a simulator in its name, such as "🔒 feature-x · Bench 2".', kind: 'toggle', def: true },
  { key: 'asciiSymbols', label: 'Plain symbols', help: 'Draw > + x * instead of the check, cross and dot symbols.', kind: 'toggle', def: false },
]

export type Values = Record<string, number | boolean>

/** Each field's value from the plugin options, the default where it is missing or not usable. */
export function valuesOf(options: Record<string, unknown>): Values {
  const out: Values = {}
  for (const f of FIELDS) {
    const raw = options[f.key]
    if (f.kind === 'toggle') out[f.key] = typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : f.def
    else {
      const n = Number(raw)
      out[f.key] = raw !== undefined && raw !== '' && Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def
    }
  }

  return out
}

/** A number field one step up or down, held between its bounds. */
export const stepped = (f: Extract<Field, { kind: 'number' }>, value: number, direction: 1 | -1) =>
  Math.min(f.max, Math.max(f.min, value + direction * f.step))

/** The comma-separated simulator names with `name` added, or taken out when it is already there. */
export function toggledName(list: string, name: string): string {
  const names = namesOf(list)

  return (names.includes(name) ? names.filter(n => n !== name) : [...names, name]).join(', ')
}

export type SettingsActions = {
  step: (key: string, direction: 1 | -1) => unknown
  flip: (key: string) => unknown
  toggleReserved: (name: string) => unknown
  close: () => unknown
}

export type SettingsInput = {
  values: Values
  reservedSims: string
  /** Names of the simulators this Mac has. */
  simNames: string[]
  columns: number
  isMono: boolean
  isDemo?: boolean
  /** A note under the list, such as why the last change was refused. */
  note?: string
  actions: SettingsActions
}

const valueText = (f: Field, v: number | boolean) => (f.kind === 'toggle' ? (v ? 'on' : 'off') : `${v}${f.unit ?? ''}`)

export function drawSettings(ui: Ui, p: SettingsInput) {
  const { Box, Text, Button } = ui
  const labelW = Math.min(26, Math.max(14, Math.floor(p.columns / 3)))
  const valueW = 9
  const reserved = namesOf(p.reservedSims)
  const sims = [...new Set([...p.simNames, ...reserved])].sort()

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold> Settings</Text>
        <Text dimColor>  {clipCells('Apply to every session on this Mac.', Math.max(0, p.columns - 11))}</Text>
      </Box>
      <Text> </Text>
      {FIELDS.map(f => {
        const v = p.values[f.key] ?? f.def
        const isDefault = v === f.def

        return (
          <Box key={f.key} flexDirection="column">
            <Box>
              <Text> {fitCells(f.label, labelW)}</Text>
              {f.kind === 'number' ? (
                <Box>
                  <Button key={`${f.key}-less`} label="-" onPress={() => p.actions.step(f.key, -1)} />
                  <Text bold> {fitCells(valueText(f, v), valueW)}</Text>
                  <Button key={`${f.key}-more`} label="+" onPress={() => p.actions.step(f.key, 1)} />
                </Box>
              ) : (
                <Button key={f.key} label={valueText(f, v)} onPress={() => p.actions.flip(f.key)} />
              )}
              {!isDefault && p.columns >= 70 && <Text dimColor>  (default {valueText(f, f.def)})</Text>}
            </Box>
            <Text dimColor>   {clipCells(f.help, p.columns - 4)}</Text>
          </Box>
        )
      })}
      <Text> </Text>
      <Text> Your simulators</Text>
      <Text dimColor>   {clipCells('Agents never get these. Press one to mark it.', p.columns - 4)}</Text>
      {sims.length === 0 && <Text dimColor>   No simulators found yet.</Text>}
      {sims.map(name => (
        <Box key={`sim-${name}`}>
          <Text>   </Text>
          <Button key={`sim-${name}`} plain label={`${reserved.includes(name) ? '[x]' : '[ ]'} ${clipCells(name, p.columns - 8)}`} onPress={() => p.actions.toggleReserved(name)} />
        </Box>
      ))}
      {p.note !== undefined && <Text color={p.isMono ? undefined : '#E5C34B'}> {p.note}</Text>}
      <Text> </Text>
      <Box>
        <Text> </Text>
        <Button key="settings-back" plain hotkey="o" label="back to the panel" onPress={() => p.actions.close()} />
        {p.isDemo === true && <Text dimColor> · demo: changes are not saved</Text>}
      </Box>
    </Box>
  )
}
