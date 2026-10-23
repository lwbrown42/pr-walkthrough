import { createHash } from 'node:crypto'
import { access, mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReviewTarget } from '../../shared/types'
import { GH_NOT_FOUND, runGh, runGit } from './run'

interface GitDeps {
  runGh?: typeof runGh
  runGit?: typeof runGit
}

export function parsePrRef(pr: string): number {
  const s = pr.trim()
  const m = /^(\d+)$/.exec(s) ?? /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(s)
  if (!m) throw new Error('Not a PR number or GitHub PR URL')
  return Number(m[1])
}

/** "owner/repo" from a GitHub PR URL, or null for a bare PR number. */
export function prUrlRepo(pr: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(pr.trim())
  return m ? m[1] : null
}

function ghError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg === GH_NOT_FOUND) return new Error(GH_NOT_FOUND)
  return new Error(`GitHub CLI (gh) failed — is it installed and logged in? ${msg}`)
}

async function refExists(git: typeof runGit, repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return true
  } catch {
    return false
  }
}

async function defaultBaseRef(git: typeof runGit, repoPath: string): Promise<string> {
  try {
    const out = await git(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    const ref = out.trim().replace(/^refs\/remotes\//, '')
    if (ref && (await refExists(git, repoPath, ref))) return ref
  } catch {
    // no origin/HEAD; fall through
  }
  for (const candidate of ['main', 'master']) {
    if (await refExists(git, repoPath, candidate)) return candidate
  }
  throw new Error('Could not determine the default branch; pass a base ref explicitly')
}

async function ensureWorktree(
  git: typeof runGit,
  repoPath: string,
  worktreesDir: string,
  headSha: string
): Promise<string> {
  const realRepo = await realpath(repoPath)
  const repoHash = createHash('sha1').update(realRepo).digest('hex').slice(0, 8)
  await mkdir(worktreesDir, { recursive: true })
  const worktreePath = join(await realpath(worktreesDir), `${repoHash}-${headSha.slice(0, 12)}`)

  // Forget worktrees whose folders were deleted, so `worktree add` can recreate them.
  await git(repoPath, ['worktree', 'prune'])
  const exists = await access(worktreePath).then(() => true, () => false)
  if (exists) {
    const list = await git(repoPath, ['worktree', 'list', '--porcelain'])
    const registered = list
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length))
    if (registered.includes(worktreePath)) return worktreePath
    throw new Error(
      `${worktreePath} exists but is not a git worktree of this repository. Move or delete that folder and try again.`
    )
  }
  await git(repoPath, ['worktree', 'add', '--detach', worktreePath, headSha])
  return worktreePath
}

export async function resolveLocalBranch(
  opts: { repoPath: string; headRef: string; baseRef?: string; worktreesDir: string },
  deps: GitDeps = {}
): Promise<ReviewTarget> {
  const git = deps.runGit ?? runGit
  const { repoPath, headRef, worktreesDir } = opts
  const baseRef = opts.baseRef ?? (await defaultBaseRef(git, repoPath))
  const headSha = (await git(repoPath, ['rev-parse', '--verify', `${headRef}^{commit}`])).trim()
  const baseSha = (await git(repoPath, ['merge-base', baseRef, headSha])).trim()
  const worktreePath = await ensureWorktree(git, repoPath, worktreesDir, headSha)
  return { kind: 'local', repoPath, worktreePath, baseSha, headSha, title: headRef }
}

export async function resolveGithubPr(
  opts: { repoPath: string; pr: string; worktreesDir: string },
  deps: GitDeps = {}
): Promise<ReviewTarget> {
  const gh = deps.runGh ?? runGh
  const git = deps.runGit ?? runGit
  const { repoPath, worktreesDir } = opts
  const n = parsePrRef(opts.pr)

  const urlRepo = prUrlRepo(opts.pr)
  if (urlRepo) {
    let nameWithOwner: string
    try {
      nameWithOwner = JSON.parse(await gh(repoPath, ['repo', 'view', '--json', 'nameWithOwner']))
        .nameWithOwner
    } catch (e) {
      throw ghError(e)
    }
    if (urlRepo.toLowerCase() !== nameWithOwner.toLowerCase()) {
      throw new Error(`This PR is from ${urlRepo}, but the selected folder is ${nameWithOwner}.`)
    }
  }

  let info: { number: number; title: string; baseRefName: string; headRefOid: string }
  try {
    const out = await gh(repoPath, [
      'pr', 'view', String(n), '--json', 'number,title,baseRefName,headRefOid'
    ])
    info = JSON.parse(out)
  } catch (e) {
    throw ghError(e)
  }

  await git(repoPath, ['fetch', 'origin', `pull/${n}/head`])
  await git(repoPath, ['fetch', 'origin', info.baseRefName])
  const headSha = info.headRefOid
  const baseSha = (await git(repoPath, ['merge-base', `origin/${info.baseRefName}`, headSha])).trim()
  const worktreePath = await ensureWorktree(git, repoPath, worktreesDir, headSha)
  return {
    kind: 'github',
    repoPath,
    worktreePath,
    baseSha,
    headSha,
    title: info.title,
    prNumber: info.number
  }
}

export async function removeWorktree(target: ReviewTarget): Promise<void> {
  await runGit(target.repoPath, ['worktree', 'remove', '--force', target.worktreePath])
}
