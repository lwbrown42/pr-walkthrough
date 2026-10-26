import type { ReviewTarget } from '../../shared/types'
import { runGh, runGit } from './run'

export interface UpdateCheck {
  latestHeadSha: string
  /** null when the branch tip is known but the commits can't be counted. */
  newCommits: number | null
}

interface UpdateDeps {
  runGh?: typeof runGh
  runGit?: typeof runGit
}

async function countNew(
  git: typeof runGit,
  repoPath: string,
  headSha: string,
  latest: string
): Promise<number | null> {
  try {
    const n = Number((await git(repoPath, ['rev-list', '--count', `${headSha}..${latest}`])).trim())
    return Number.isNaN(n) ? null : n
  } catch {
    return null
  }
}

/**
 * Whether the review's branch has commits beyond the walkthrough's head. Returns null when the
 * branch can't be resolved. Never checks anything out; only the GitHub path fetches.
 */
export async function checkForUpdates(
  target: ReviewTarget,
  deps: UpdateDeps = {}
): Promise<UpdateCheck | null> {
  const git = deps.runGit ?? runGit
  const gh = deps.runGh ?? runGh
  const { repoPath, headSha } = target

  let latest: string
  if (target.kind === 'github') {
    if (target.prNumber === undefined) return null
    try {
      const out = await gh(repoPath, [
        'pr',
        'view',
        String(target.prNumber),
        '--json',
        'headRefOid'
      ])
      latest = JSON.parse(out).headRefOid
      if (typeof latest !== 'string' || !latest) return null
    } catch {
      return null
    }
    if (latest === headSha) return { latestHeadSha: latest, newCommits: 0 }
    try {
      await git(repoPath, ['fetch', 'origin', `pull/${target.prNumber}/head`])
    } catch {
      return { latestHeadSha: latest, newCommits: null }
    }
  } else {
    if (!target.headRef) return null
    try {
      latest = (await git(repoPath, ['rev-parse', '--verify', `${target.headRef}^{commit}`])).trim()
    } catch {
      return null
    }
  }
  return { latestHeadSha: latest, newCommits: await countNew(git, repoPath, headSha, latest) }
}
