import { describe, expect, it } from 'vitest'
import { AgentWalkthrough, agentWalkthroughJsonSchema, type Step } from '../../../src/shared/walkthrough'
import { normalizeWalkthrough } from '../../../src/main/walkthrough/normalize'
import type { ChangedFile } from '../../../src/shared/types'

const file = (over: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 0,
  hunks: [],
  ...over
})
const hunk = (path: string, i: number, newStart: number, newLines: number, oldStart = 1, oldLines = 1) => ({
  id: `${path}#${i}`,
  newStart,
  newLines,
  oldStart,
  oldLines
})
const step = (id: string, over: Partial<Step> = {}): Step => ({
  id,
  title: id,
  whyNext: '',
  explanation: 'x',
  segments: [],
  ...over
})
const seg = (path: string, startLine: number, endLine: number) => ({ kind: 'change' as const, path, startLine, endLine })
const run = (steps: Step[], files: ChangedFile[], head: Record<string, number> = {}, base: Record<string, number> = {}) =>
  normalizeWalkthrough({ summary: 's', steps }, files, { head, base })

describe('normalizeWalkthrough', () => {
  it('drops unknown paths, clamps and swaps', () => {
    const out = run(
      [step('s1', { segments: [seg('ghost.ts', 1, 2), seg('a.ts', 90, 200), seg('a.ts', 20, 10)] })],
      [file({ path: 'a.ts' })],
      { 'a.ts': 100 }
    )
    expect(out.steps[0].segments.map((s) => [s.path, s.startLine, s.endLine])).toEqual([
      ['a.ts', 90, 100],
      ['a.ts', 10, 20]
    ])
  })

  const aFile = file({ path: 'a.ts', hunks: [hunk('a.ts', 0, 5, 3), hunk('a.ts', 1, 40, 3)] })

  it('adds Everything else for uncovered hunks', () => {
    const out = run([step('s1', { segments: [seg('a.ts', 5, 7)] })], [aFile], { 'a.ts': 100 })
    const last = out.steps.at(-1)!
    expect(last.title).toBe('Everything else')
    expect(last.id).toBe('everything-else')
    expect(last.whyNext).toBe('Smaller changes not covered above.')
    expect(last.segments).toEqual([{ kind: 'change', path: 'a.ts', startLine: 40, endLine: 42 }])
  })

  it('does not add Everything else when covered across steps', () => {
    const out = run(
      [step('s1', { segments: [seg('a.ts', 5, 6)] }), step('s2', { segments: [seg('a.ts', 7, 7), seg('a.ts', 41, 41)] })],
      [aFile],
      { 'a.ts': 100 }
    )
    expect(out.steps.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('uses base range for deleted files', () => {
    const f = file({ path: 'old.ts', status: 'deleted', hunks: [hunk('old.ts', 0, 0, 0, 3, 4)] })
    const out = run([], [f], {}, { 'old.ts': 10 })
    expect(out.steps.at(-1)!.segments).toEqual([{ kind: 'change', path: 'old.ts', startLine: 3, endLine: 6 }])
  })

  it('moves and merges an agent Everything else step', () => {
    const out = run(
      [
        step('s1', { segments: [seg('a.ts', 5, 7)] }),
        step('misc', { title: 'Everything else', segments: [seg('a.ts', 1, 2)] }),
        step('s3', { segments: [seg('a.ts', 1, 1)] })
      ],
      [aFile],
      { 'a.ts': 100 }
    )
    expect(out.steps.map((s) => s.id)).toEqual(['s1', 's3', 'misc'])
    expect(out.steps.filter((s) => s.title === 'Everything else')).toHaveLength(1)
    expect(out.steps[2].segments).toHaveLength(2)
  })

  it('removes parentId referencing later or missing steps', () => {
    const out = run(
      [
        step('s1', { parentId: 'later-step' }),
        step('s2', { parentId: 's1' }),
        step('later-step', { parentId: 'nope' })
      ],
      []
    )
    expect(out.steps.map((s) => s.parentId)).toEqual([undefined, 's1', undefined])
  })

  it('keeps empty-segment steps with explanation, drops those without', () => {
    const out = run([step('s1', { segments: [seg('ghost.ts', 1, 1)] }), step('s2', { explanation: '' })], [])
    expect(out.steps.map((s) => s.id)).toEqual(['s1'])
  })

  it('covers pure renames and binaries by path or oldPath', () => {
    const files = [
      file({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' }),
      file({ path: 'img.png', binary: true }),
      file({ path: 'other.bin', binary: true })
    ]
    const out = run(
      [step('s1', { segments: [seg('old.ts', 1, 1), seg('img.png', 1, 1)] })],
      files,
      { 'img.png': 1 },
      { 'old.ts': 5 }
    )
    const last = out.steps.at(-1)!
    expect(last.title).toBe('Everything else')
    expect(last.segments.map((s) => s.path)).toEqual(['other.bin'])
  })
})

describe('schemas', () => {
  it('rejects a step missing explanation', () => {
    expect(() =>
      AgentWalkthrough.parse({ summary: 's', steps: [{ id: 'a', title: 't', whyNext: '', segments: [] }] })
    ).toThrow()
  })
  it('exports a draft-07 JSON schema', () => {
    const s = agentWalkthroughJsonSchema as Record<string, any>
    expect(s.type).toBe('object')
    expect(s.properties.steps).toBeDefined()
  })
})
