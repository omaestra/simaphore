// A slow read that runs on its own, never inside a tick, so the timeline keeps an even beat.
// The sampler starts it when it is due and takes its answer in a later sample.

export type Answer = { at: number; text: string }

export type SideRead = {
  /** Starts a read stamped `at`, unless one is still going. True when one was started. */
  start(at: number): boolean
  /** The answer that came back since the last take, once; undefined when none did. */
  take(): Answer | undefined
}

/** `read` runs at most once at a time. Its text is the answer, even '' (the sampler counts a failed
 * `simctl` read); a read that throws leaves none. `onAnswer` gets each answer as it comes back, so the
 * sampler can use it at once. */
export function sideRead(read: () => Promise<string>, onAnswer: (answer: Answer) => void = () => {}): SideRead {
  let isRunning = false
  let answer: Answer | undefined

  return {
    start(at) {
      if (isRunning) return false
      isRunning = true
      void read()
        .then(text => {
          isRunning = false
          answer = { at, text }
          onAnswer(answer)
        })
        .catch(() => {
          isRunning = false
        })

      return true
    },
    take() {
      const found = answer
      answer = undefined

      return found
    },
  }
}
