import { execFile } from 'node:child_process'

const MAX_BUFFER = 64 * 1024 * 1024

function run(cmd: string, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${stderr.trim() || err.message}`))
        return
      }
      resolve(stdout)
    })
  })
}

export function runGit(cwd: string, args: string[]): Promise<string> {
  return run('git', cwd, args)
}

export function runGh(cwd: string, args: string[]): Promise<string> {
  return run('gh', cwd, args)
}
