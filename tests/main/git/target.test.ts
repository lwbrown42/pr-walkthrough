import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTempRepo } from '../../helpers/tempRepo'
import { runGit } from '../../../src/main/git/run'
import {
  parsePrRef,
  removeWorktree,
  resolveGithubPr,
  resolveLocalBranch
} from '../../../src/main/git/target'

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function setup() {
  const repo = await makeTempRepo()
  const wt = await mkdtemp(join(tmpdir(), 'crh-wt-'))
  cleanup.push(repo.dir, wt)
  await runGit(repo.dir, ['checkout', '-q', '-b', 'main'])
  const base = await repo.commit({ 'a.txt': 'base\n' }, 'base')
  await runGit(repo.dir, ['checkout', '-q', '-b', 'feature'])
  const head = await repo.commit({ 'f.txt': 'feature\n' }, 'feature work')
  await runGit(repo.dir, ['checkout', '-q', 'main'])
  await repo.commit({ 'a.txt': 'main moved\n' }, 'main advance')
  return { repo, wt, base, head }
}

describe('resolveLocalBranch', () => {
  it('uses the fork point as baseSha, not the base tip', async () => {
    const { repo, wt, base, head } = await setup()
    const t = await resolveLocalBranch({ repoPath: repo.dir, headRef: 'feature', worktreesDir: wt })
    expect(t.kind).toBe('local')
    expect(t.baseSha).toBe(base)
    expect(t.headSha).toBe(head)
    expect(t.title).toBe('feature')
  })

  it('honors an explicit baseRef', async () => {
    const { repo, wt, head } = await setup()
    const t = await resolveLocalBranch({
      repoPath: repo.dir,
      headRef: 'feature',
      baseRef: head,
      worktreesDir: wt
    })
    expect(t.baseSha).toBe(head)
  })

  it('leaves the user repo untouched and checks out head in the worktree', async () => {
    const { repo, wt } = await setup()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(repo.dir, 'a.txt'), 'dirty\n')
    const status = await runGit(repo.dir, ['status', '--porcelain'])
    const t = await resolveLocalBranch({ repoPath: repo.dir, headRef: 'feature', worktreesDir: wt })
    expect(await runGit(repo.dir, ['status', '--porcelain'])).toBe(status)
    expect((await runGit(repo.dir, ['branch', '--show-current'])).trim()).toBe('main')
    expect(await readFile(join(t.worktreePath, 'f.txt'), 'utf8')).toBe('feature\n')
    expect((await realpath(t.worktreePath)).startsWith(await realpath(wt))).toBe(true)
  })

  it('reuses the worktree on a second call and can remove it', async () => {
    const { repo, wt } = await setup()
    const opts = { repoPath: repo.dir, headRef: 'feature', worktreesDir: wt }
    const a = await resolveLocalBranch(opts)
    const b = await resolveLocalBranch(opts)
    expect(b.worktreePath).toBe(a.worktreePath)
    await removeWorktree(a)
    await expect(readFile(join(a.worktreePath, 'f.txt'))).rejects.toThrow()
  })
})

describe('parsePrRef', () => {
  it('parses numbers and URLs', () => {
    expect(parsePrRef('482')).toBe(482)
    expect(parsePrRef('https://github.com/o/r/pull/482')).toBe(482)
    expect(() => parsePrRef('abc')).toThrow('Not a PR number or GitHub PR URL')
  })
})

describe('resolveGithubPr', () => {
  it('maps gh failures to a GitHub CLI error', async () => {
    const { repo, wt } = await setup()
    await expect(
      resolveGithubPr({ repoPath: repo.dir, pr: '1', worktreesDir: wt }, {
        runGh: async () => {
          throw new Error('gh: command not found')
        }
      })
    ).rejects.toThrow(/GitHub CLI/)
  })
})
