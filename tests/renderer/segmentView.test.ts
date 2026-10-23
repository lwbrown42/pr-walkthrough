import { describe, expect, it } from 'vitest'
import { describeSegment } from '../../src/renderer/src/components/segmentView'
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
