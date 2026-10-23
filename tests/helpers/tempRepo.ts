import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runGit } from '../../src/main/git/run'

export interface TempRepo {
  dir: string
  commit(files: Record<string, string | Buffer | null>, msg: string): Promise<string>
}

export async function makeTempRepo(): Promise<TempRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'crh-repo-'))
  await runGit(dir, ['init', '-q'])
  await runGit(dir, ['config', 'user.name', 'Test'])
  await runGit(dir, ['config', 'user.email', 'test@example.com'])
  await runGit(dir, ['config', 'commit.gpgsign', 'false'])

  return {
    dir,
    async commit(files, msg) {
      for (const [path, content] of Object.entries(files)) {
        const full = join(dir, path)
        if (content === null) {
          await rm(full, { force: true })
        } else {
          await mkdir(dirname(full), { recursive: true })
          await writeFile(full, content)
        }
      }
      await runGit(dir, ['add', '-A'])
      await runGit(dir, ['commit', '-q', '--allow-empty', '-m', msg])
      return (await runGit(dir, ['rev-parse', 'HEAD'])).trim()
    }
  }
}
