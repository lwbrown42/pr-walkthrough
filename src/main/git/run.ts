import { execFile } from 'node:child_process'

const MAX_BUFFER = 64 * 1024 * 1024

export const GH_NOT_FOUND = 'GitHub CLI (gh) not found on PATH — install it with Homebrew'

/** Where Homebrew installs binaries (Apple silicon, then Intel). */
const HOMEBREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']

/**
 * A Finder/Dock launch gets launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), which lacks Homebrew's
 * gh. Prepends the Homebrew bin dirs that are missing; leaves the rest of PATH as is.
 */
export function withHomebrewPath(path: string | undefined): string {
  const parts = path ? path.split(':') : []
  const missing = HOMEBREW_BIN_DIRS.filter((d) => !parts.includes(d))
  return [...missing, ...parts].join(':')
}

function run(
  cmd: string,
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8', ...(env ? { env } : {}) },
      (err, stdout, stderr) => {
        if (err) {
          if (cmd === 'gh' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new Error(GH_NOT_FOUND))
            return
          }
          reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr.trim() || err.message}`))
          return
        }
        resolve(stdout)
      }
    )
  })
}

export function runGit(cwd: string, args: string[]): Promise<string> {
  // English messages regardless of the user's locale: readFileAt matches on git's wording.
  return run('git', cwd, args, { ...process.env, LC_ALL: 'C' })
}

export function runGh(cwd: string, args: string[]): Promise<string> {
  return run('gh', cwd, args)
}
