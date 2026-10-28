import { describe, it, expect, vi } from 'vitest'
import {
  cleanDescription,
  fetchAuthorContext,
  formatCommits,
  MAX_COMMITS,
  MAX_COMMITS_CHARS,
  MAX_DESCRIPTION_CHARS
} from '../../../src/main/git/authorContext'
import type { ReviewTarget } from '../../../src/shared/types'

const github: ReviewTarget = {
  kind: 'github',
  repoPath: '/repo',
  worktreePath: '/wt',
  baseSha: 'base',
  headSha: 'head',
  title: 't',
  prNumber: 7
}
const local: ReviewTarget = { ...github, kind: 'local', prNumber: undefined }

const log = (...msgs: string[]): string => msgs.map((m) => `${m}\n\x1e\n`).join('')

describe('cleanDescription', () => {
  it('strips HTML comments, including multi-line ones', () => {
    const body = 'Fixes retries.\n<!-- remember to\nfill this in -->\n\nMore text <!-- x --> here'
    expect(cleanDescription(body)).toBe('Fixes retries.\n\nMore text  here')
  })

  it('omits empty, whitespace-only and template-only descriptions', () => {
    expect(cleanDescription('')).toBeNull()
    expect(cleanDescription(' \n\t\n')).toBeNull()
    expect(cleanDescription('<!-- describe -->')).toBeNull()
    expect(cleanDescription('## Summary\n<!-- what -->\n\n## Test plan\n\n#\n')).toBeNull()
  })

  it('keeps a description with text under template headings', () => {
    expect(cleanDescription('## Summary\n<!-- what -->\nAdds retries\n## Test plan\n')).toBe(
      '## Summary\n\nAdds retries\n## Test plan'
    )
  })

  it('truncates a long description with a note', () => {
    const out = cleanDescription('word '.repeat(2000))!
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS + 40)
    expect(out.endsWith('… (description truncated)')).toBe(true)
  })

  it('does not add a note to a description at the cap', () => {
    const out = cleanDescription('a'.repeat(MAX_DESCRIPTION_CHARS))!
    expect(out).toBe('a'.repeat(MAX_DESCRIPTION_CHARS))
  })
})

describe('formatCommits', () => {
  it('returns null when there are no commits', () => {
    expect(formatCommits('')).toBeNull()
    expect(formatCommits('\x1e\n')).toBeNull()
  })

  it('joins subjects and bodies in order', () => {
    expect(formatCommits(log('First\n\nbody one', 'Second'))).toBe('First\n\nbody one\n\nSecond')
  })

  it('caps the entry count with a note, keeping the oldest', () => {
    const out = formatCommits(log(...Array.from({ length: MAX_COMMITS + 5 }, (_, i) => `c${i}`)))!
    expect(out).toContain('c0\n')
    expect(out).toContain(`c${MAX_COMMITS - 1}`)
    expect(out).not.toContain(`c${MAX_COMMITS}\n`)
    expect(out.endsWith('… (commits truncated)')).toBe(true)
  })

  it('caps the size with a note', () => {
    const out = formatCommits(log(...Array.from({ length: 10 }, () => 'x'.repeat(1500))))!
    expect(out.length).toBeLessThanOrEqual(MAX_COMMITS_CHARS + 40)
    expect(out.endsWith('… (commits truncated)')).toBe(true)
  })

  it('adds no note when under both caps', () => {
    expect(formatCommits(log('a', 'b'))).not.toContain('truncated')
  })
})

describe('fetchAuthorContext', () => {
  it('fetches the body and non-merge commits, oldest first, for a GitHub PR', async () => {
    const runGh = vi.fn(async () => JSON.stringify({ body: 'Adds retries.' }))
    const runGit = vi.fn(async () => log('First', 'Second'))
    const out = await fetchAuthorContext(github, { runGh, runGit })
    expect(out).toEqual({ description: 'Adds retries.', commits: 'First\n\nSecond' })
    expect(runGh).toHaveBeenCalledWith('/repo', ['pr', 'view', '7', '--json', 'body'])
    expect(runGit).toHaveBeenCalledWith('/repo', [
      'log',
      '--no-merges',
      '--reverse',
      '--format=%B%x1e',
      'base..head'
    ])
  })

  it('gives a local target commits but no description, without calling gh', async () => {
    const runGh = vi.fn(async () => '{}')
    const runGit = vi.fn(async () => log('Only'))
    expect(await fetchAuthorContext(local, { runGh, runGit })).toEqual({
      description: null,
      commits: 'Only'
    })
    expect(runGh).not.toHaveBeenCalled()
  })

  it('omits a template-only description', async () => {
    const runGh = vi.fn(async () => JSON.stringify({ body: '## Summary\n<!-- x -->' }))
    const runGit = vi.fn(async () => '')
    expect(await fetchAuthorContext(github, { runGh, runGit })).toEqual({
      description: null,
      commits: null
    })
  })

  it('tolerates gh and git failing, independently', async () => {
    const down = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await fetchAuthorContext(github, { runGh: down, runGit: down })).toEqual({
      description: null,
      commits: null
    })
    const runGit = vi.fn(async () => log('Only'))
    expect(await fetchAuthorContext(github, { runGh: down, runGit })).toEqual({
      description: null,
      commits: 'Only'
    })
  })

  it('tolerates unparseable gh output', async () => {
    const runGh = vi.fn(async () => 'not json')
    const runGit = vi.fn(async () => '')
    expect((await fetchAuthorContext(github, { runGh, runGit })).description).toBeNull()
  })
})
