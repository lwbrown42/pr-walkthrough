import { isAbsolute, relative } from 'node:path'
import { ACTIVITY_LIMIT, type Activity, type GenerateProgress } from '../../shared/progress'

/** Matches a complete `"title": "..."` pair in (possibly partial) walkthrough JSON. */
const TITLE = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g

/**
 * Turns the agent's stream into what the Generating screen shows: which stage it is in, how many
 * of the PR's changed files it has opened, what it did last, and the step titles written so far.
 */
export class ProgressTracker {
  private readonly changed: Set<string>
  private readonly read = new Set<string>()
  private stage: GenerateProgress['stage'] = 'reading'
  private turns = 0
  private activity: Activity[] = []
  private output = ''
  private titles: string[] = []

  constructor(
    changedPaths: string[],
    private readonly worktreePath: string
  ) {
    this.changed = new Set(changedPaths)
  }

  private relPath(p: unknown): string {
    if (typeof p !== 'string') return ''
    return isAbsolute(p) ? relative(this.worktreePath, p) : p
  }

  turn(): void {
    this.turns += 1
  }

  toolUse(name: string, input: Record<string, unknown>): void {
    let item: Activity
    if (name === 'Read') {
      const path = this.relPath(input.file_path)
      if (this.changed.has(path)) this.read.add(path)
      item = { verb: 'Reading', target: path }
    } else if (name === 'Grep') {
      item = { verb: 'Searching for', target: String(input.pattern ?? '') }
    } else if (name === 'Glob') {
      item = { verb: 'Finding files matching', target: String(input.pattern ?? '') }
    } else {
      item = { verb: 'Working', target: '' }
    }
    this.activity = [item, ...this.activity].slice(0, ACTIVITY_LIMIT)
  }

  /** The agent began returning the walkthrough. Returns whether the stage changed. */
  startOutput(): boolean {
    if (this.stage !== 'reading') return false
    this.stage = 'writing'
    return true
  }

  /** A chunk of the walkthrough JSON. Returns whether a new step title became complete. */
  outputDelta(chunk: string): boolean {
    this.output += chunk
    const titles = [...this.output.matchAll(TITLE)].map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`) as string
      } catch {
        return m[1]
      }
    })
    if (titles.length === this.titles.length) return false
    this.titles = titles
    return true
  }

  finish(): void {
    this.stage = 'finishing'
  }

  snapshot(): GenerateProgress {
    return {
      stage: this.stage,
      turns: this.turns,
      filesRead: this.read.size,
      filesTotal: this.changed.size,
      activity: [...this.activity],
      stepTitles: [...this.titles]
    }
  }
}
