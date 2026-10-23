import parseDiff from 'parse-diff'
import type { ChangedFile, FileStatus } from '../../shared/types'
import { runGit } from './run'

interface NumstatEntry {
  additions: number
  deletions: number
  binary: boolean
}

// Parses `git diff -z --numstat`: "add\tdel\tpath\0" or, for renames,
// "add\tdel\t\0old\0new\0". Keyed by the new path.
function parseNumstat(out: string): Map<string, NumstatEntry> {
  const entries = new Map<string, NumstatEntry>()
  const parts = out.split('\0')
  let i = 0
  while (i < parts.length && parts[i] !== '') {
    const [add, del, path] = parts[i].split('\t')
    let target = path
    if (path === '') {
      target = parts[i + 2]
      i += 3
    } else {
      i += 1
    }
    const binary = add === '-' && del === '-'
    entries.set(target, {
      additions: binary ? 0 : Number(add),
      deletions: binary ? 0 : Number(del),
      binary
    })
  }
  return entries
}

export async function getChangedFiles(
  cwd: string,
  baseSha: string,
  headSha: string
): Promise<ChangedFile[]> {
  const [patch, numstat] = await Promise.all([
    runGit(cwd, ['-c', 'core.quotepath=false', 'diff', '-M', '--no-color', baseSha, headSha]),
    runGit(cwd, ['diff', '-M', '-z', '--numstat', baseSha, headSha])
  ])
  const stats = parseNumstat(numstat)

  return parseDiff(patch).map((f) => {
    const isDeleted = f.deleted === true || f.to === '/dev/null'
    const isNew = f.new === true || f.from === '/dev/null'
    const path = (isDeleted ? f.from : f.to) ?? ''
    let status: FileStatus = 'modified'
    let oldPath: string | undefined
    if (isNew) status = 'added'
    else if (isDeleted) status = 'deleted'
    else if (f.from && f.to && f.from !== f.to) {
      status = 'renamed'
      oldPath = f.from
    }
    const stat = stats.get(path)
    const file: ChangedFile = {
      path,
      status,
      binary: stat?.binary ?? false,
      additions: stat?.additions ?? f.additions,
      deletions: stat?.deletions ?? f.deletions,
      hunks: f.chunks.map((c, index) => ({
        id: `${path}#${index}`,
        newStart: c.newStart,
        newLines: c.newLines,
        oldStart: c.oldStart,
        oldLines: c.oldLines
      }))
    }
    if (oldPath) file.oldPath = oldPath
    return file
  })
}

export function countChangedLines(files: ChangedFile[]): number {
  return files.reduce((sum, f) => sum + f.additions + f.deletions, 0)
}

export async function readFileAt(cwd: string, sha: string, path: string): Promise<string | null> {
  try {
    return await runGit(cwd, ['show', `${sha}:${path}`])
  } catch {
    return null
  }
}
