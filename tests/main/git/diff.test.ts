import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  countChangedLines,
  getChangedFiles,
  isDiffOmitted,
  numberDiff,
  promptDiffArgs,
  readFileAt
} from '../../../src/main/git/diff'
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

describe('git diff ignores user diff config', () => {
  it('parses paths even with noprefix and an external diff configured', async () => {
    const { runGit } = await import('../../../src/main/git/run')
    const repo = await makeTempRepo()
    try {
      await runGit(repo.dir, ['config', 'diff.noprefix', 'true'])
      await runGit(repo.dir, ['config', 'diff.external', 'false'])
      await runGit(repo.dir, ['config', 'color.diff', 'always'])
      const base = await repo.commit({ 'x.ts': 'a\n' }, 'base')
      const head = await repo.commit({ 'x.ts': 'b\n' }, 'head')
      const out = await getChangedFiles(repo.dir, base, head)
      expect(out.map((f) => [f.path, f.status, f.hunks.length])).toEqual([['x.ts', 'modified', 1]])
    } finally {
      const { rm } = await import('node:fs/promises')
      await rm(repo.dir, { recursive: true, force: true })
    }
  })
})

describe('isDiffOmitted', () => {
  const f = (path: string, additions = 200, over: Partial<ChangedFile> = {}): ChangedFile => ({
    path,
    status: 'added',
    binary: false,
    additions,
    deletions: 0,
    hunks: [],
    ...over
  })

  it('leaves out large lockfiles, snapshots, minified bundles and data fixtures', () => {
    for (const p of [
      'package-lock.json',
      'web/yarn.lock',
      'go.sum',
      'Cargo.lock',
      'test/Pixi/testdata/pixi-v6.lock',
      'src/__snapshots__/view.test.ts.snap',
      'public/app.min.js',
      'tests/fixtures/walkthrough.json'
    ])
      expect(isDiffOmitted(f(p)), p).toBe(true)
  })

  it('keeps source, tests and code fixtures, and any small change', () => {
    for (const p of ['src/main/ipc.ts', 'test/Pixi/PixiLockSpec.hs', 'tests/fixtures/make.ts'])
      expect(isDiffOmitted(f(p)), p).toBe(false)
    expect(isDiffOmitted(f('package-lock.json', 12))).toBe(false)
  })
})

describe('promptDiffArgs', () => {
  it('leaves the omitted files out of the diff and keeps the rest', async () => {
    const { runGit } = await import('../../../src/main/git/run')
    const repo = await makeTempRepo()
    try {
      const base = await repo.commit({ 'x.ts': 'a\n' }, 'base')
      const head = await repo.commit(
        { 'x.ts': 'b\n', 'package-lock.json': lines(80), 'odd [name].lock': lines(80) },
        'head'
      )
      const out = await runGit(
        repo.dir,
        promptDiffArgs(base, head, ['package-lock.json', 'odd [name].lock'])
      )
      expect(out).toContain('b/x.ts')
      expect(out).not.toContain('package-lock.json')
      expect(out).not.toContain('odd [name].lock')
      expect(promptDiffArgs(base, head, [])).not.toContain('--')
    } finally {
      const { rm } = await import('node:fs/promises')
      await rm(repo.dir, { recursive: true, force: true })
    }
  })
})

describe('numberDiff', () => {
  const num = (n: number | null, line: string): string =>
    `${n === null ? '' : String(n)}`.padStart(6) + '\t' + line

  it('numbers context and added lines with their head line, and leaves removed lines blank', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,3 +10,3 @@ function f() {',
      ' keep',
      '-old',
      '+new',
      ' keep2',
      '@@ -40,1 +40,2 @@',
      ' x',
      '+y',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    expect(numberDiff(diff).split('\n')).toEqual([
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,3 +10,3 @@ function f() {',
      num(10, ' keep'),
      num(null, '-old'),
      num(11, '+new'),
      num(12, ' keep2'),
      '@@ -40,1 +40,2 @@',
      num(40, ' x'),
      num(41, '+y'),
      '\\ No newline at end of file',
      ''
    ])
  })

  it('numbers an added file from 1 and a deleted file by its base lines', () => {
    const diff = [
      'diff --git a/n.ts b/n.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      'diff --git a/g.ts b/g.ts',
      'deleted file mode 100644',
      '--- a/g.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-gone',
      '-also'
    ].join('\n')
    expect(numberDiff(diff).split('\n')).toEqual([
      'diff --git a/n.ts b/n.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/n.ts',
      '@@ -0,0 +1,2 @@',
      num(1, '+one'),
      num(2, '+two'),
      'diff --git a/g.ts b/g.ts',
      'deleted file mode 100644',
      '--- a/g.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      num(1, '-gone'),
      num(2, '-also')
    ])
  })
})
