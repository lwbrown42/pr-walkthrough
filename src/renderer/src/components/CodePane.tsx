import { DiffEditor, Editor } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, ReviewTarget } from '../../../shared/types'
import type { CodeSegment, Step } from '../../../shared/walkthrough'
import '../monacoSetup'
import { languageFor } from '../monacoSetup'
import { describeSegment } from './segmentView'

interface Props {
  step: Step
  files: ChangedFile[]
  target: ReviewTarget
  mode: 'diff' | 'plain'
}

const LINE_HEIGHT = 19
const MAX_LINES = 24

type Loader = (sha: string, path: string) => Promise<string | null>

function useDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    const on = (e: MediaQueryListEvent): void => setDark(e.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return dark
}

const countLines = (t: string): number => (t === '' ? 1 : t.split('\n').length)

const OPTIONS: Monaco.editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  lineHeight: LINE_HEIGHT,
  renderLineHighlight: 'none',
  domReadOnly: true
}

function SegmentView({
  seg,
  file,
  mode,
  target,
  load,
  dark
}: {
  seg: CodeSegment
  file: ChangedFile | undefined
  mode: 'diff' | 'plain'
  target: ReviewTarget
  load: Loader
  dark: boolean
}): React.JSX.Element {
  const view = describeSegment(seg, file, mode)
  const [text, setText] = useState<{ original: string; modified: string } | null | 'missing'>(null)
  const editorRef = useRef<Monaco.editor.ICodeEditor | null>(null)
  const [ready, setReady] = useState(0)

  const basePath = file?.status === 'renamed' ? (file.oldPath ?? file.path) : seg.path
  const status = file?.status

  useEffect(() => {
    if (view.editor === 'binary') return
    let cancelled = false
    const head = (): Promise<string | null> =>
      status === 'deleted' ? Promise.resolve('') : load(target.headSha, seg.path)
    const base = (): Promise<string | null> =>
      status === 'added' ? Promise.resolve('') : load(target.baseSha, basePath)
    const jobs =
      view.sha === 'both'
        ? Promise.all([base(), head()])
        : view.sha === 'base'
          ? base().then((b): [string | null, string | null] => [null, b])
          : head().then((h): [string | null, string | null] => [null, h])
    jobs
      .then(([original, modified]) => {
        if (cancelled) return
        setText(
          modified === null || (view.sha === 'both' && original === null)
            ? 'missing'
            : { original: original ?? '', modified }
        )
      })
      .catch(() => !cancelled && setText('missing'))
    return () => {
      cancelled = true
    }
  }, [view.editor, view.sha, status, seg.path, basePath, target.headSha, target.baseSha, load])

  // Scroll so startLine is near the top, and mark the segment's range.
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || typeof text !== 'object' || text === null) return
    const coll = ed.createDecorationsCollection([
      {
        range: {
          startLineNumber: seg.startLine,
          startColumn: 1,
          endLineNumber: seg.endLine,
          endColumn: 1
        },
        options: {
          isWholeLine: true,
          className: 'segment-range-line',
          linesDecorationsClassName: 'segment-range-gutter'
        }
      }
    ])
    ed.revealLineNearTop(seg.startLine)
    return () => coll.clear()
  }, [text, ready, seg.startLine, seg.endLine])

  const lines =
    typeof text === 'object' && text
      ? Math.max(countLines(text.original), countLines(text.modified))
      : 8
  const height = Math.min(lines, MAX_LINES) * LINE_HEIGHT + 4
  const theme = dark ? 'vs-dark' : 'vs'
  const language = languageFor(seg.path)

  let body: React.JSX.Element
  if (view.editor === 'binary') {
    body = <div className="segment-message">{view.label}</div>
  } else if (text === 'missing') {
    body = <div className="segment-message">Could not read {seg.path}</div>
  } else if (text === null) {
    body = <div className="segment-message">Loading…</div>
  } else if (view.editor === 'diff') {
    body = (
      <DiffEditor
        height={height}
        theme={theme}
        language={language}
        original={text.original}
        modified={text.modified}
        options={{ ...OPTIONS, renderSideBySide: false, originalEditable: false }}
        onMount={(ed) => {
          editorRef.current = ed.getModifiedEditor()
          setReady((n) => n + 1)
        }}
      />
    )
  } else {
    body = (
      <Editor
        height={height}
        theme={theme}
        language={language}
        value={text.modified}
        options={OPTIONS}
        onMount={(ed) => {
          editorRef.current = ed
          setReady((n) => n + 1)
        }}
      />
    )
  }

  return (
    <section className={`segment segment-${seg.kind}`} data-editor={view.editor}>
      <header className="segment-header">
        <span className="segment-label">{view.label}</span>
        <span className="segment-range">
          {' '}
          lines {seg.startLine}–{seg.endLine}
        </span>
        {seg.note && <p className="segment-note">{seg.note}</p>}
      </header>
      {body}
    </section>
  )
}

export default function CodePane({ step, files, target, mode }: Props): React.JSX.Element {
  const cache = useRef(new Map<string, Promise<string | null>>())
  const load = useMemo<Loader>(
    () => (sha, path) => {
      const key = `${sha}\0${path}`
      let p = cache.current.get(key)
      if (!p) {
        p = window.api.readFile({ sha, path })
        cache.current.set(key, p)
      }
      return p
    },
    []
  )
  const dark = useDark()
  return (
    <div className="code-pane" data-mode={mode}>
      {step.segments.map((seg, i) => (
        <SegmentView
          key={i}
          seg={seg}
          file={files.find((f) => f.path === seg.path)}
          mode={mode}
          target={target}
          load={load}
          dark={dark}
        />
      ))}
    </div>
  )
}
