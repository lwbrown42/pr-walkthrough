import type { Step } from './walkthrough'

export interface StepLabels {
  /** One per step, in order: '1', '1a', '1b', '2', … */
  labels: string[]
  /** Number of main (non-detour) steps. */
  mainCount: number
}

/** a, b, …, z, aa, ab, … for the n-th detour (1-based). */
function letters(n: number): string {
  let s = ''
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) {
    s = String.fromCharCode(97 + ((k - 1) % 26)) + s
  }
  return s
}

/**
 * Main steps are numbered; a detour (a step whose parentId is the main step it directly follows)
 * gets that step's number plus a letter. A parentId that doesn't name the current main step is
 * ignored, so labels never point away from where the step sits.
 */
export function labelSteps(steps: Step[]): StepLabels {
  const labels: string[] = []
  let main = 0
  let detour = 0
  let mainId: string | undefined
  for (const step of steps) {
    if (step.parentId !== undefined && step.parentId === mainId) {
      detour += 1
      labels.push(`${main}${letters(detour)}`)
    } else {
      main += 1
      detour = 0
      mainId = step.id
      labels.push(String(main))
    }
  }
  return { labels, mainCount: main }
}
