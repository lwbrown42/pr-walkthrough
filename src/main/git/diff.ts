import parseDiff from 'parse-diff'
import type { ChangedFile, FileStatus } from '../../shared/types'
import { runGit } from './run'

/** Git flags that make diff output independent of the user's git config. */
export const PLAIN_DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/'
]

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
    runGit(cwd, [
      '-c',
      'core.quotepath=false',
      'diff',
      ...PLAIN_DIFF_FLAGS,
      '-M',
      baseSha,
      headSha
    ]),
    runGit(cwd, ['diff', ...PLAIN_DIFF_FLAGS, '-M', '-z', '--numstat', baseSha, headSha])
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

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'go.sum',
  'packages.lock.json',
  'gradle.lockfile'
])
/** Machine-written files: lockfiles, snapshots, minified bundles, source maps, protobuf output. */
const GENERATED = /(\.lock|\.snap|\.min\.(js|css)|\.map|\.pb\.go|_pb2\.pyi?)$|(^|\/)__snapshots__\//
/** Data files under a fixtures directory; code there stays in the diff. */
const FIXTURE_DATA =
  /(^|\/)(testdata|fixtures|__fixtures__)\/.*\.(json|ya?ml|toml|txt|csv|tsv|xml)$/
/** Smaller changes stay in the diff: a one-line lockfile bump can be the point of a PR. */
const OMIT_OVER_LINES = 50

/** Whether the walkthrough prompt leaves this file's diff out (the agent can still Read it). */
export function isDiffOmitted(f: ChangedFile): boolean {
  if (f.binary || f.additions + f.deletions <= OMIT_OVER_LINES) return false
  const name = f.path.slice(f.path.lastIndexOf('/') + 1)
  return LOCKFILES.has(name) || GENERATED.test(f.path) || FIXTURE_DATA.test(f.path)
}

/** `git diff` arguments for the walkthrough prompt, leaving out the paths in `omit`. */
export function promptDiffArgs(baseSha: string, headSha: string, omit: string[]): string[] {
  const args = ['diff', ...PLAIN_DIFF_FLAGS, '-M', baseSha, headSha]
  if (omit.length === 0) return args
  return [...args, '--', '.', ...omit.map((p) => `:(exclude,literal)${p}`)]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Prefixes each hunk line with its head line number (cat -n style), so the agent can take
 * segment lines from the diff instead of reading files to count them. Removed lines get no
 * number, except in a deleted file, where they carry their base line numbers.
 */
export function numberDiff(diff: string): string {
  const blank = ' '.repeat(6)
  let inHunk = false
  let deleted = false
  let head = 0
  let base = 0
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('diff --git ')) {
        inHunk = false
        deleted = false
        return line
      }
      const header = HUNK_HEADER.exec(line)
      if (header) {
        inHunk = true
        base = Number(header[1])
        head = Number(header[2])
        return line
      }
      if (!inHunk) {
        if (line === '+++ /dev/null') deleted = true
        return line
      }
      const mark = line[0]
      if (mark === ' ' || mark === '+') return `${String(head++).padStart(6)}\t${line}`
      if (mark === '-')
        return deleted ? `${String(base++).padStart(6)}\t${line}` : `${blank}\t${line}`
      return line
    })
    .join('\n')
}

export async function readFileAt(cwd: string, sha: string, path: string): Promise<string | null> {
  try {
    return await runGit(cwd, ['show', `${sha}:${path}`])
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/does not exist in|exists on disk, but not in/.test(message)) return null
    throw err
  }
}
