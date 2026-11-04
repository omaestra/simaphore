import { expect, test } from 'claude-code/testing'

import { sideRead } from './sideread'

// A read the test finishes by hand.
function pending() {
  const calls: { resolve: (text: string) => void; reject: (e: Error) => void }[] = []
  const read = () => new Promise<string>((resolve, reject) => calls.push({ resolve, reject }))

  return { read, calls }
}
// Lets the read's `.then` run (a few turns of the promise queue).
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('sideRead runs one read at a time', async () => {
  const { read, calls } = pending()
  const side = sideRead(read)
  expect(side.start(1)).toBe(true)
  expect(side.start(2)).toBe(false)
  expect(calls.length).toBe(1)
  calls[0]!.resolve('a')
  await settle()
  expect(side.start(3)).toBe(true)
  expect(calls.length).toBe(2)
})

test('sideRead gives nothing until the read is back, then the answer once, stamped with its start', async () => {
  const { read, calls } = pending()
  const heard: unknown[] = []
  const side = sideRead(read, answer => heard.push(answer))
  side.start(1000)
  expect(side.take()).toBeUndefined()
  calls[0]!.resolve('out')
  await settle()
  expect(heard).toEqual([{ at: 1000, text: 'out' }])
  expect(side.take()).toEqual({ at: 1000, text: 'out' })
  expect(side.take()).toBeUndefined()
})

test('sideRead keeps only the newest answer when two come back before a take', async () => {
  const { read, calls } = pending()
  const side = sideRead(read)
  side.start(1)
  calls[0]!.resolve('old')
  await settle()
  side.start(2)
  calls[1]!.resolve('new')
  await settle()
  expect(side.take()).toEqual({ at: 2, text: 'new' })
})

test('sideRead passes an empty answer on, so a failed read can be counted', async () => {
  const { read, calls } = pending()
  let woken = 0
  const side = sideRead(read, () => woken++)
  side.start(5)
  calls[0]!.resolve('')
  await settle()
  expect(woken).toBe(1)
  expect(side.take()).toEqual({ at: 5, text: '' })
})

test('sideRead gives no answer for a read that throws, and can start again', async () => {
  const { read, calls } = pending()
  let woken = 0
  const side = sideRead(read, () => woken++)
  side.start(1)
  calls[0]!.reject(new Error('timed out'))
  await settle()
  expect(side.take()).toBeUndefined()
  expect(woken).toBe(0)
  expect(side.start(2)).toBe(true)
})
