import type { ReviewTarget } from '../../shared/types'
import { runGh, runGit } from './run'

export const MAX_DESCRIPTION_CHARS = 4000
export const MAX_COMMITS = 50
export const MAX_COMMITS_CHARS = 6000

interface AuthorContextDeps {
  runGh?: typeof runGh
  runGit?: typeof runGit
}

/** What the author wrote about the change, each part null when absent or not fetchable. */
export interface AuthorContext {
  description: string | null
  commits: string | null
}

const RECORD_SEP = '\x1e'

/** Cuts text to `max` characters on a line break where possible, with a note saying so. */
function truncate(text: string, max: number, note: string): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastBreak = cut.lastIndexOf('\n')
  return `${(lastBreak > max / 2 ? cut.slice(0, lastBreak) : cut).trimEnd()}\n${note}`
}

/**
 * The PR description without HTML comments (templates are full of them), capped. Null when
 * nothing but whitespace or template headings is left.
 */
export function cleanDescription(body: string): string | null {
  const stripped = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n')
  const hasContent = stripped
    .split('\n')
    .some((l) => l.trim() !== '' && !/^\s*#{1,6}(\s|$)/.test(l))
  if (!hasContent) return null
  const text = stripped.replace(/\n{3,}/g, '\n\n').trim()
  return truncate(text, MAX_DESCRIPTION_CHARS, '… (description truncated)')
}

/** Commit messages, oldest first, capped by entry count and size. Null when there are none. */
export function formatCommits(log: string): string | null {
  const all = log
    .split(RECORD_SEP)
    .map((m) => m.trim())
    .filter(Boolean)
  if (all.length === 0) return null
  const entries = all.slice(0, MAX_COMMITS)
  let text = entries.join('\n\n')
  let omitted = all.length > entries.length
  if (text.length > MAX_COMMITS_CHARS) {
    text = truncate(text, MAX_COMMITS_CHARS, '')
    omitted = true
  }
  return omitted ? `${text.trimEnd()}\n… (commits truncated)` : text
}

/**
 * The author's own account of the change: the PR description (GitHub PRs only) and the commit
 * messages. Best effort; a failure to fetch either leaves it null rather than failing.
 */
export async function fetchAuthorContext(
  target: ReviewTarget,
  deps: AuthorContextDeps = {}
): Promise<AuthorContext> {
  const git = deps.runGit ?? runGit
  const gh = deps.runGh ?? runGh
  const description = async (): Promise<string | null> => {
    if (target.prNumber === undefined) return null
    try {
      const out = await gh(target.repoPath, [
        'pr',
        'view',
        String(target.prNumber),
        '--json',
        'body'
      ])
      const body = JSON.parse(out).body
      return typeof body === 'string' ? cleanDescription(body) : null
    } catch {
      return null
    }
  }
  const commits = async (): Promise<string | null> => {
    try {
      const out = await git(target.repoPath, [
        'log',
        '--no-merges',
        '--reverse',
        `--format=%B%x1e`,
        `${target.baseSha}..${target.headSha}`
      ])
      return formatCommits(out)
    } catch {
      return null
    }
  }
  const [d, c] = await Promise.all([description(), commits()])
  return { description: d, commits: c }
}
