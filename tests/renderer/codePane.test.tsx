import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../src/shared/api'
import type { ChangedFile, ReviewTarget } from '../../src/shared/types'
import type { Step } from '../../src/shared/walkthrough'
import CodePane from '../../src/renderer/src/components/CodePane'
import { summarizeFiles } from '../../src/renderer/src/components/segmentView'

vi.mock('../../src/renderer/src/monacoSetup', () => ({
  languageFor: () => 'plaintext',
  themeFor: () => 'vs'
}))
vi.mock('@monaco-editor/react', () => ({
  Editor: ({ value }: { value: string }) => <pre data-testid="editor">{value}</pre>,
  DiffEditor: () => <pre data-testid="editor" />
}))

afterEach(cleanup)

const FILE = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
beforeEach(() => {
  window.api = { readFile: vi.fn().mockResolvedValue(FILE) } as unknown as PreloadApi
})

const target: ReviewTarget = {
  kind: 'local',
  repoPath: '/r',
  worktreePath: '/w',
  baseSha: 'a',
  headSha: 'b',
  title: 'PR'
}
const step = (id: string): Step => ({
  id,
  title: id,
  whyNext: '',
  explanation: '',
  segments: [{ kind: 'context', path: 'a.ts', startLine: 10, endLine: 12, note: 'Why `x`' }]
})
const shownLines = async (): Promise<number> =>
  (await screen.findByTestId('editor')).textContent!.split('\n').length

describe('CodePane', () => {
  it('labels context segments and keeps the header when the code is collapsed', async () => {
    render(<CodePane step={step('s1')} files={[]} target={target} mode="diff" />)
    expect(screen.getByText('Context')).toBeTruthy()
    expect(screen.getByText(/not changed in this PR/)).toBeTruthy()
    await screen.findByTestId('editor')
    await userEvent.click(screen.getByRole('button', { name: 'Collapse code' }))
    expect(screen.queryByTestId('editor')).toBeNull()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('x').tagName).toBe('CODE')
    await userEvent.click(screen.getByRole('button', { name: 'Expand code' }))
    expect(await screen.findByTestId('editor')).toBeTruthy()
  })

  it('does not carry expanded lines over to the next step', async () => {
    const { rerender } = render(
      <CodePane step={step('s1')} files={[]} target={target} mode="diff" />
    )
    const before = await shownLines()
    await userEvent.click(screen.getByRole('button', { name: /↓ Show 20 more lines/ }))
    expect(await shownLines()).toBe(before + 20)
    rerender(<CodePane step={step('s2')} files={[]} target={target} mode="diff" />)
    expect(await shownLines()).toBe(before)
  })
})

describe('added files', () => {
  it('show as plain code with a New file badge, even in diff mode', async () => {
    const s: Step = {
      ...step('s1'),
      segments: [{ kind: 'change', path: 'a.ts', startLine: 1, endLine: 3 }]
    }
    const file: ChangedFile = {
      path: 'a.ts',
      status: 'added',
      binary: false,
      additions: 60,
      deletions: 0,
      hunks: []
    }
    render(<CodePane step={s} files={[file]} target={target} mode="diff" />)
    expect(screen.getByText('New file')).toBeTruthy()
    expect((await screen.findByTestId('editor')).textContent).toMatch(/^line 1\n/)
  })
})

describe('summarizeFiles', () => {
  it('counts each file once by status', () => {
    const s: Step = {
      ...step('everything-else'),
      segments: [
        { kind: 'change', path: 'a', startLine: 1, endLine: 1 },
        { kind: 'change', path: 'a', startLine: 5, endLine: 6 },
        { kind: 'change', path: 'b', startLine: 1, endLine: 1 }
      ]
    }
    const f = (path: string, status: 'modified' | 'renamed'): ChangedFile => ({
      path,
      status,
      binary: false,
      additions: 0,
      deletions: 0,
      hunks: []
    })
    expect(summarizeFiles(s, [f('a', 'renamed'), f('b', 'modified')])).toBe(
      '2 files: 1 renamed, 1 modified'
    )
  })
})
