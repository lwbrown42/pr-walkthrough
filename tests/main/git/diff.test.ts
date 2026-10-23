import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { countChangedLines, getChangedFiles, readFileAt } from '../../../src/main/git/diff'
import type { ChangedFile } from '../../../src/shared/types'
import { makeTempRepo } from '../../helpers/tempRepo'

const lines = (n: number, tag = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`).join('\n') + '\n'

describe('git diff reading', () => {
  let dir: string
  let baseSha: string
  let headSha: string
  let files: ChangedFile[]
  const byPath = (p: string): ChangedFile => files.find((f) => f.path === p)!

  beforeAll(async () => {
    const repo = await makeTempRepo()
    dir = repo.dir
    baseSha = await repo.commit(
      {
        'a.ts': lines(30),
        'old.ts': lines(4, 'old'),
        'r1.ts': lines(10, 'rename')
      },
      'base'
    )
    const modified = lines(30)
      .replace('line 3\n', 'changed 3\n')
      .replace('line 27\n', 'changed 27\n')
    headSha = await repo.commit(
      {
        'a.ts': modified,
        'new.ts': lines(3, 'new'),
        'old.ts': null,
        'r1.ts': null,
        'r2.ts': lines(10, 'rename'),
        'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff])
      },
      'head'
    )
    files = await getChangedFiles(dir, baseSha, headSha)
  })

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(dir, { recursive: true, force: true })
  })

  it('returns all changed files', () => {
    expect(files).toHaveLength(5)
  })

  it('splits a modified file into hunks with stable ids', () => {
    const a = byPath('a.ts')
    expect(a.status).toBe('modified')
    expect(a.hunks.map((h) => h.id)).toEqual(['a.ts#0', 'a.ts#1'])
  })

  it('reports added, deleted and renamed files', () => {
    expect(byPath('new.ts')).toMatchObject({ status: 'added', additions: 3 })
    expect(byPath('old.ts').status).toBe('deleted')
    expect(byPath('r2.ts')).toMatchObject({ status: 'renamed', oldPath: 'r1.ts' })
  })

  it('flags binary files without hunks', () => {
    const img = byPath('img.png')
    expect(img.binary).toBe(true)
    expect(img.hunks).toHaveLength(0)
  })

  it('counts changed lines', () => {
    const expected = files.reduce((s, f) => s + f.additions + f.deletions, 0)
    expect(countChangedLines(files)).toBe(expected)
    expect(expected).toBeGreaterThan(0)
  })

  it('reads file contents at a sha, or null when missing', async () => {
    expect(await readFileAt(dir, baseSha, 'new.ts')).toBeNull()
    expect(await readFileAt(dir, headSha, 'new.ts')).toBe(lines(3, 'new'))
  })

  it('rejects for an invalid sha instead of returning null', async () => {
    await expect(readFileAt(dir, 'deadbeef', 'new.ts')).rejects.toThrow()
  })
})
