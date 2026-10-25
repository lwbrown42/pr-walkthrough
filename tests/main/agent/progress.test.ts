import { describe, expect, it } from 'vitest'
import { ProgressTracker } from '../../../src/main/agent/progress'

const changed = ['src/config.ts', 'src/analyze.ts', 'README.md']
const tracker = (): ProgressTracker => new ProgressTracker(changed, '/wt')

describe('ProgressTracker', () => {
  it('starts in the reading stage with nothing read', () => {
    expect(tracker().snapshot()).toEqual({
      stage: 'reading',
      turns: 0,
      filesRead: 0,
      filesTotal: 3,
      activity: [],
      stepTitles: []
    })
  })

  it('counts each changed file once, relative to the worktree, and ignores other files', () => {
    const t = tracker()
    t.toolUse('Read', { file_path: '/wt/src/config.ts' })
    t.toolUse('Read', { file_path: '/wt/src/config.ts', offset: 40 })
    t.toolUse('Read', { file_path: '/wt/src/other.ts' })
    t.toolUse('Read', { file_path: 'src/analyze.ts' })
    expect(t.snapshot().filesRead).toBe(2)
  })

  it('describes activity in plain words, newest first, keeping the last 4', () => {
    const t = tracker()
    t.toolUse('Read', { file_path: '/wt/src/config.ts' })
    t.toolUse('Grep', { pattern: 'SkipHeaders', path: '/wt/src' })
    t.toolUse('Glob', { pattern: '**/*.spec.ts' })
    t.toolUse('Read', { file_path: '/wt/src/analyze.ts' })
    t.toolUse('Mystery', {})
    expect(t.snapshot().activity).toEqual([
      { verb: 'Working', target: '' },
      { verb: 'Reading', target: 'src/analyze.ts' },
      { verb: 'Finding files matching', target: '**/*.spec.ts' },
      { verb: 'Searching for', target: 'SkipHeaders' }
    ])
  })

  it('switches to writing when the structured output starts and pulls out finished step titles', () => {
    const t = tracker()
    t.toolUse('Read', { file_path: '/wt/src/config.ts' })
    expect(t.startOutput()).toBe(true)
    t.outputDelta('{"summary":"S","steps":[{"id":"a","title":"Merging the ')
    expect(t.snapshot()).toMatchObject({ stage: 'writing', stepTitles: [] })
    t.outputDelta(
      'options","whyNext":"","explanation":"x"},{"id":"b","title":"The \\"merged\\" type"'
    )
    expect(t.snapshot().stepTitles).toEqual(['Merging the options', 'The "merged" type'])
  })

  it('reports whether a delta changed what the screen would show', () => {
    const t = tracker()
    t.startOutput()
    expect(t.outputDelta('{"steps":[{"id":"a","ti')).toBe(false)
    expect(t.outputDelta('tle":"One"')).toBe(true)
  })

  it('counts turns and moves to finishing at the end', () => {
    const t = tracker()
    t.turn()
    t.turn()
    t.finish()
    expect(t.snapshot()).toMatchObject({ stage: 'finishing', turns: 2 })
  })
})
