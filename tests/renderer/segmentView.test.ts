import { describe, expect, it } from 'vitest'
import {
  describeSegment,
  headToBase,
  segmentWindow,
  sliceLines
} from '../../src/renderer/src/components/segmentView'
import type { ChangedFile } from '../../src/shared/types'
import type { CodeSegment } from '../../src/shared/walkthrough'

const seg = (kind: CodeSegment['kind']): CodeSegment => ({
  kind,
  path: 'a.ts',
  startLine: 1,
  endLine: 5
})
const file = (extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path: 'a.ts',
  status: 'modified',
  binary: false,
  additions: 1,
  deletions: 1,
  hunks: [],
  ...extra
})

describe('describeSegment', () => {
  it('context is plain head with the unchanged label, in either mode', () => {
    for (const mode of ['diff', 'plain'] as const) {
      expect(describeSegment(seg('context'), file(), mode)).toEqual({
        editor: 'plain',
        sha: 'head',
        label: 'a.ts · unchanged · context'
      })
    }
  })
  it('change in plain mode shows head', () => {
    expect(describeSegment(seg('change'), file(), 'plain')).toMatchObject({
      editor: 'plain',
      sha: 'head'
    })
  })
  it('change in plain mode shows base for a deleted file', () => {
    expect(describeSegment(seg('change'), file({ status: 'deleted' }), 'plain')).toMatchObject({
      editor: 'plain',
      sha: 'base'
    })
  })
  it('change in diff mode shows both', () => {
    expect(describeSegment(seg('change'), file(), 'diff')).toMatchObject({
      editor: 'diff',
      sha: 'both'
    })
    expect(describeSegment(seg('change'), file({ status: 'added' }), 'diff')).toMatchObject({
      editor: 'diff',
      sha: 'both'
    })
    expect(describeSegment(seg('change'), file({ status: 'deleted' }), 'diff')).toMatchObject({
      editor: 'diff',
      sha: 'both'
    })
  })
  it('binary files get a placeholder', () => {
    expect(describeSegment(seg('change'), file({ binary: true }), 'diff')).toMatchObject({
      editor: 'binary',
      label: 'Binary file — not shown'
    })
  })
  it('unknown file (context on an untouched file) is plain head', () => {
    expect(describeSegment(seg('context'), undefined, 'diff')).toMatchObject({
      editor: 'plain',
      sha: 'head'
    })
  })
})

describe('headToBase', () => {
  // Head 1-10 unchanged, hunk replaces base 11-12 with head 11-14, then unchanged.
  const hunks = [{ id: 'a.ts#0', newStart: 11, newLines: 4, oldStart: 11, oldLines: 2 }]
  it('maps lines before, inside and after a hunk', () => {
    expect(headToBase(5, hunks, 'start')).toBe(5)
    expect(headToBase(12, hunks, 'start')).toBe(11)
    expect(headToBase(12, hunks, 'end')).toBe(12)
    expect(headToBase(20, hunks, 'end')).toBe(18)
  })
  it('accounts for pure deletions and insertions', () => {
    const del = [{ id: 'x', newStart: 4, newLines: 0, oldStart: 5, oldLines: 3 }]
    expect(headToBase(4, del, 'end')).toBe(4)
    expect(headToBase(5, del, 'start')).toBe(8)
    const ins = [{ id: 'y', newStart: 5, newLines: 2, oldStart: 4, oldLines: 0 }]
    expect(headToBase(5, ins, 'start')).toBe(5)
    expect(headToBase(6, ins, 'end')).toBe(4)
  })
})

describe('segmentWindow', () => {
  const totals = { head: 100, base: 98 }
  const hunk = { id: 'a.ts#0', newStart: 40, newLines: 5, oldStart: 40, oldLines: 3 }
  const changed = (s: number, e: number): CodeSegment => ({
    kind: 'change',
    path: 'a.ts',
    startLine: s,
    endLine: e
  })

  it('shows the hunk plus 3 lines of buffer on both sides in diff mode', () => {
    const f = file({ hunks: [hunk] })
    const w = segmentWindow(changed(41, 42), f, describeSegment(changed(41, 42), f, 'diff'), totals)
    expect(w.head).toEqual({ start: 37, end: 47 })
    expect(w.base).toEqual({ start: 37, end: 45 })
    expect(w).toMatchObject({ moreAbove: true, moreBelow: true })
  })

  it('shows only the head range in plain mode, and adds expanded lines', () => {
    const f = file({ hunks: [hunk] })
    const view = describeSegment(changed(40, 44), f, 'plain')
    const w = segmentWindow(changed(40, 44), f, view, totals, { above: 20, below: 0 })
    expect(w.head).toEqual({ start: 17, end: 47 })
    expect(w.base).toBeUndefined()
  })

  it('clamps at the file edges', () => {
    const f = file({
      hunks: [{ id: 'a.ts#0', newStart: 1, newLines: 2, oldStart: 1, oldLines: 1 }]
    })
    const w = segmentWindow(changed(1, 2), f, describeSegment(changed(1, 2), f, 'diff'), {
      head: 4,
      base: 3
    })
    expect(w.head).toEqual({ start: 1, end: 4 })
    expect(w).toMatchObject({ moreAbove: false, moreBelow: false })
  })

  it('does not widen an added file to the whole file', () => {
    const f = file({
      status: 'added',
      hunks: [{ id: 'a.ts#0', newStart: 1, newLines: 100, oldStart: 0, oldLines: 0 }]
    })
    const w = segmentWindow(changed(50, 52), f, describeSegment(changed(50, 52), f, 'diff'), totals)
    expect(w.head).toEqual({ start: 47, end: 55 })
    expect(w.base).toEqual({ start: 1, end: 0 })
  })

  it('uses base lines for a deleted file', () => {
    const f = file({ status: 'deleted' })
    const w = segmentWindow(changed(10, 12), f, describeSegment(changed(10, 12), f, 'diff'), {
      head: 0,
      base: 50
    })
    expect(w.base).toEqual({ start: 7, end: 15 })
    expect(w.head).toEqual({ start: 1, end: 0 })
  })

  it('context segments get buffer but no hunk widening', () => {
    const s: CodeSegment = { kind: 'context', path: 'b.ts', startLine: 10, endLine: 12 }
    const w = segmentWindow(s, undefined, describeSegment(s, undefined, 'diff'), totals)
    expect(w.head).toEqual({ start: 7, end: 15 })
  })
})

describe('sliceLines', () => {
  it('returns the inclusive range, or empty for an empty range', () => {
    expect(sliceLines('a\nb\nc\nd', { start: 2, end: 3 })).toBe('b\nc')
    expect(sliceLines('a\nb', { start: 1, end: 0 })).toBe('')
  })
})
