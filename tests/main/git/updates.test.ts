import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { rm } from 'node:fs/promises'
import { makeTempRepo } from '../../helpers/tempRepo'
import { runGit } from '../../../src/main/git/run'
import { checkForUpdates } from '../../../src/main/git/updates'
import type { ReviewTarget } from '../../../src/shared/types'

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

function target(over: Partial<ReviewTarget>): ReviewTarget {
  return {
    kind: 'local',
    repoPath: '/repo',
    worktreePath: '/wt',
    baseSha: 'base',
    headSha: 'head',
    title: 't',
    ...over
  }
}

async function localSetup(): Promise<{
  dir: string
  head: string
  add: (m: string) => Promise<string>
}> {
  const repo = await makeTempRepo()
  cleanup.push(repo.dir)
  await runGit(repo.dir, ['checkout', '-q', '-b', 'feature'])
  const head = await repo.commit({ 'f.txt': '1\n' }, 'first')
  return { dir: repo.dir, head, add: (m) => repo.commit({ [`${m}.txt`]: m }, m) }
}

describe('checkForUpdates (local)', () => {
  it('unchanged branch → 0 new commits', async () => {
    const { dir, head } = await localSetup()
    const r = await checkForUpdates(target({ repoPath: dir, headSha: head, headRef: 'feature' }))
    expect(r).toEqual({ latestHeadSha: head, newCommits: 0 })
  })

  it('two commits added → newCommits 2', async () => {
    const { dir, head, add } = await localSetup()
    await add('a')
    const latest = await add('b')
    const r = await checkForUpdates(target({ repoPath: dir, headSha: head, headRef: 'feature' }))
    expect(r).toEqual({ latestHeadSha: latest, newCommits: 2 })
  })

  it('branch deleted → null', async () => {
    const { dir, head } = await localSetup()
    const r = await checkForUpdates(target({ repoPath: dir, headSha: head, headRef: 'gone' }))
    expect(r).toBeNull()
  })

  it('no headRef → null', async () => {
    const { dir, head } = await localSetup()
    expect(await checkForUpdates(target({ repoPath: dir, headSha: head }))).toBeNull()
  })
})

describe('checkForUpdates (github)', () => {
  const gh = (oid: string): Mock<() => Promise<string>> =>
    vi.fn(async () => JSON.stringify({ headRefOid: oid }))

  it('same headRefOid → 0 and no git call', async () => {
    const git = vi.fn(async () => '')
    const r = await checkForUpdates(target({ kind: 'github', prNumber: 7, headSha: 'abc' }), {
      runGh: gh('abc'),
      runGit: git
    })
    expect(r).toEqual({ latestHeadSha: 'abc', newCommits: 0 })
    expect(git).not.toHaveBeenCalled()
  })

  it('fetches the PR head and counts new commits', async () => {
    const git = vi.fn(async (_cwd: string, args: string[]) => (args[0] === 'rev-list' ? '3\n' : ''))
    const r = await checkForUpdates(
      target({ kind: 'github', prNumber: 7, headSha: 'abc', repoPath: '/r' }),
      { runGh: gh('def'), runGit: git }
    )
    expect(r).toEqual({ latestHeadSha: 'def', newCommits: 3 })
    expect(git).toHaveBeenCalledWith('/r', ['fetch', 'origin', 'pull/7/head'])
    expect(git).toHaveBeenCalledWith('/r', ['rev-list', '--count', 'abc..def'])
  })

  it('rev-list fails → newCommits null with latestHeadSha set', async () => {
    const git = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-list') throw new Error('bad object')
      return ''
    })
    const r = await checkForUpdates(target({ kind: 'github', prNumber: 7, headSha: 'abc' }), {
      runGh: gh('def'),
      runGit: git
    })
    expect(r).toEqual({ latestHeadSha: 'def', newCommits: null })
  })

  it('gh throws → null', async () => {
    const r = await checkForUpdates(target({ kind: 'github', prNumber: 7 }), {
      runGh: vi.fn(async () => {
        throw new Error('no gh')
      }),
      runGit: vi.fn(async () => '')
    })
    expect(r).toBeNull()
  })

  it('no prNumber → null', async () => {
    expect(await checkForUpdates(target({ kind: 'github' }))).toBeNull()
  })
})
