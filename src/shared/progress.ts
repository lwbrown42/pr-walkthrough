/** One thing the agent did, for the Generating screen: e.g. Reading `src/config.ts`. */
export interface Activity {
  verb: string
  /** Shown as code; empty when there is nothing to name. */
  target: string
  /** Back-to-back reads of different parts of the same file, folded into one line. */
  sections?: number
}

export type GenerateStage = 'reading' | 'writing' | 'finishing'

export interface GenerateProgress {
  stage: GenerateStage
  /** Agent turns so far (counted against the run's maxTurns). */
  turns: number
  /** The PR's changed files; the agent is given the diff of every one up front. */
  filesTotal: number
  /** Searches and file reads so far. */
  lookups: number
  /** Most recent first, at most ACTIVITY_LIMIT. */
  activity: Activity[]
  /** Titles of steps whose title has been written so far, in order. */
  stepTitles: string[]
}

export const ACTIVITY_LIMIT = 4
