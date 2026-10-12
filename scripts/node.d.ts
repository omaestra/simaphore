// Just what shots.ts uses from node, so the build needs no @types/node.
declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void
}
declare module 'node:path' {
  export function join(...parts: string[]): string
}
declare const process: { argv: string[] }
declare const console: { log(...args: unknown[]): void }
