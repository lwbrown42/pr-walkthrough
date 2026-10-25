/** One thing the agent did, for the Generating screen: e.g. Reading `src/config.ts`. */
export interface Activity {
  verb: string
  /** Shown as code; empty when there is nothing to name. */
  target: string
}

export type GenerateStage = 'reading' | 'writing' | 'finishing'

export interface GenerateProgress {
  stage: GenerateStage
  /** Agent turns so far (counted against the run's maxTurns). */
  turns: number
  /** Changed files of the PR the agent has opened. */
  filesRead: number
  filesTotal: number
  /** Most recent first, at most ACTIVITY_LIMIT. */
  activity: Activity[]
  /** Titles of steps whose title has been written so far, in order. */
  stepTitles: string[]
}

export const ACTIVITY_LIMIT = 4
