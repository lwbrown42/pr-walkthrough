import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTempRepo, type TempRepo } from '../../helpers/tempRepo'
import { runGit } from '../../../src/main/git/run'
import {
  commitExists,
  parsePrRef,
  removeWorktree,
  resolveGithubPr,
  resolveLocalBranch
} from '../../../src/main/git/target'

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function setup(): Promise<{
  repo: TempRepo
  wt: string
  base: string
  head: string
}> {
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

  it('sets headRef and the resolved baseRef', async () => {
    const { repo, wt } = await setup()
    const t = await resolveLocalBranch({ repoPath: repo.dir, headRef: 'feature', worktreesDir: wt })
    expect(t).toMatchObject({ headRef: 'feature', baseRef: 'main' })
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
  it('sets baseRef and headRef from gh', async () => {
    const { repo, wt, base, head } = await setup()
    const t = await resolveGithubPr(
      { repoPath: repo.dir, pr: '7', worktreesDir: wt },
      {
        runGh: async () =>
          JSON.stringify({
            number: 7,
            title: 'T',
            baseRefName: 'main',
            headRefName: 'feat/x',
            headRefOid: head
          }),
        runGit: async (cwd, args) => {
          if (args[0] === 'fetch') return ''
          if (args[0] === 'merge-base') return `${base}\n`
          return runGit(cwd, args)
        }
      }
    )
    expect(t).toMatchObject({ baseRef: 'main', headRef: 'feat/x' })
  })

  it('maps gh failures to a GitHub CLI error', async () => {
    const { repo, wt } = await setup()
    await expect(
      resolveGithubPr(
        { repoPath: repo.dir, pr: '1', worktreesDir: wt },
        {
          runGh: async () => {
            throw new Error('gh: command not found')
          }
        }
      )
    ).rejects.toThrow(/GitHub CLI/)
  })
})

describe('runGh / PATH', () => {
  it('reports a missing gh binary distinctly', async () => {
    const { runGh } = await import('../../../src/main/git/run')
    const saved = process.env.PATH
    process.env.PATH = '/nonexistent-crh'
    try {
      await expect(runGh(tmpdir(), ['--version'])).rejects.toThrow(
        'GitHub CLI (gh) not found on PATH — install it with Homebrew'
      )
    } finally {
      process.env.PATH = saved
    }
  })

  it('resolveGithubPr passes the not-found message through unwrapped', async () => {
    const { GH_NOT_FOUND } = await import('../../../src/main/git/run')
    await expect(
      resolveGithubPr(
        { repoPath: '/x', pr: '1', worktreesDir: '/y' },
        {
          runGh: async () => {
            throw new Error(GH_NOT_FOUND)
          }
        }
      )
    ).rejects.toThrow(new Error(GH_NOT_FOUND))
  })

  it('prepends Homebrew bin dirs to a launchd PATH once', async () => {
    const { withHomebrewPath } = await import('../../../src/main/git/run')
    expect(withHomebrewPath('/usr/bin:/bin:/usr/sbin:/sbin')).toBe(
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    )
    expect(withHomebrewPath('/usr/local/bin:/opt/homebrew/bin:/usr/bin')).toBe(
      '/usr/local/bin:/opt/homebrew/bin:/usr/bin'
    )
    expect(withHomebrewPath(undefined)).toBe('/opt/homebrew/bin:/usr/local/bin')
  })
})

describe('worktree recovery', () => {
  it('recreates the worktree after its folder was deleted', async () => {
    const { repo, wt } = await setup()
    const opts = { repoPath: repo.dir, headRef: 'feature', worktreesDir: wt }
    const a = await resolveLocalBranch(opts)
    await rm(a.worktreePath, { recursive: true, force: true })
    const b = await resolveLocalBranch(opts)
    expect(b.worktreePath).toBe(a.worktreePath)
    expect(await readFile(join(b.worktreePath, 'f.txt'), 'utf8')).toBe('feature\n')
  })

  it('refuses to reuse a folder that is not a registered worktree, leaving it intact', async () => {
    const { repo, wt } = await setup()
    const opts = { repoPath: repo.dir, headRef: 'feature', worktreesDir: wt }
    const a = await resolveLocalBranch(opts)
    await runGit(repo.dir, ['worktree', 'remove', '--force', a.worktreePath])
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(a.worktreePath, { recursive: true })
    await writeFile(join(a.worktreePath, 'keep.txt'), 'mine\n')
    await expect(resolveLocalBranch(opts)).rejects.toThrow(/not a git worktree/)
    expect(await readFile(join(a.worktreePath, 'keep.txt'), 'utf8')).toBe('mine\n')
  })
})

describe('resolveGithubPr repo check', () => {
  const fakeGh = (nameWithOwner: string) => async (_cwd: string, args: string[]) => {
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner })
    throw new Error('stop after repo check')
  }

  it('rejects a PR URL from a different repo', async () => {
    await expect(
      resolveGithubPr(
        { repoPath: '/x', pr: 'https://github.com/other/thing/pull/5', worktreesDir: '/y' },
        { runGh: fakeGh('me/app') }
      )
    ).rejects.toThrow('This PR is from other/thing, but the selected folder is me/app.')
  })

  it('accepts a matching URL (case-insensitive) and moves on', async () => {
    await expect(
      resolveGithubPr(
        { repoPath: '/x', pr: 'https://github.com/Me/App/pull/5', worktreesDir: '/y' },
        { runGh: fakeGh('me/app') }
      )
    ).rejects.toThrow(/stop after repo check/)
  })
})

describe('commitExists', () => {
  it('is false for an unknown sha and true for HEAD', async () => {
    const { repo } = await setup()
    expect(await commitExists(repo.dir, 'deadbeef'.repeat(5))).toBe(false)
    expect(await commitExists(repo.dir, 'HEAD')).toBe(true)
  })
})
