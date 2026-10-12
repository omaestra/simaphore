// A text renderer for drawn trees, shared by the screen tests: no terminal, just lines of text.
import { cellWidth, padCells } from './text'
import type { Ui } from './screen'

export type Node = { tag: string; props: Record<string, unknown> }

const part = (tag: string) => (props: Record<string, unknown>) => ({ tag, props }) as never

/** Box, Text and Button as plain data. */
export const fakeUi = { Box: part('Box'), Text: part('Text'), Button: part('Button') } as unknown as Ui

const kidsOf = (n: Node) => (Array.isArray(n.props.children) ? n.props.children : n.props.children === undefined ? [] : [n.props.children]) as unknown[]

/** What a Button draws in the terminal: `[label]`, or `k: label` for a plain one with a hotkey. */
const buttonText = (props: Record<string, unknown>) =>
  props.plain === true
    ? props.hotkey !== undefined ? `${String(props.hotkey)}: ${String(props.label)}` : String(props.label)
    : `[${String(props.label)}]`

/** A drawn tree as lines of text: a column stacks its children, a row sets them side by side. */
export const linesOf = (n: unknown): string[] => {
  if (n === null || n === undefined || n === false) return []
  if (typeof n === 'string' || typeof n === 'number') return [String(n)]
  if (Array.isArray(n)) return [n.flatMap(linesOf).join('')]
  const node = n as Node
  const { tag, props } = node
  if (tag === 'Button') return [buttonText(props)]
  if (tag === 'Text') return [kidsOf(node).map(k => linesOf(k).join('')).join('')]
  const kids = kidsOf(node)
  if (props.flexDirection === 'column') return kids.flatMap(linesOf)
  const blocks = kids.map(k => ({ lines: linesOf(k) })).filter(b => b.lines.length > 0)
  const height = Math.max(0, ...blocks.map(b => b.lines.length))
  const cell = (b: (typeof blocks)[number], y: number, isLast: boolean) =>
    isLast ? (b.lines[y] ?? '') : padCells(b.lines[y] ?? '', Math.max(...b.lines.map(cellWidth)))

  return Array.from({ length: height }, (_, y) => blocks.map((b, i) => cell(b, y, i === blocks.length - 1)).join('').trimEnd())
}

/** Every element of a drawn tree, depth first. */
export const nodesOf = (n: unknown): Node[] => {
  if (n === null || n === undefined || typeof n !== 'object') return []
  if (Array.isArray(n)) return n.flatMap(nodesOf)
  const node = n as Node

  return [node, ...kidsOf(node).flatMap(nodesOf)]
}
