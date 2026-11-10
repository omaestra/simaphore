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
      // A read that throws at once counts like one that rejects.
      let running: Promise<string>
      try {
        running = read()
      } catch (e) {
        running = Promise.reject(e)
      }
      void running
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

/** An `onAnswer` that calls `wake` only for news: text that is not empty and differs from the last answer's. */
export function wakeOnNews(wake: () => void): (answer: Answer) => void {
  let lastText: string | undefined

  return answer => {
    const isNews = answer.text !== '' && answer.text !== lastText
    lastText = answer.text
    if (isNews) wake()
  }
}
