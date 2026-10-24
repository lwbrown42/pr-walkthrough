import { DiffEditor, Editor } from '@monaco-editor/react'
import type * as Monaco from 'monaco-editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, ReviewTarget } from '../../../shared/types'
import type { CodeSegment, Step } from '../../../shared/walkthrough'
import '../monacoSetup'
import { languageFor } from '../monacoSetup'
import { describeSegment, segmentWindow, sliceLines, type LineRange } from './segmentView'

interface Props {
  step: Step
  files: ChangedFile[]
  target: ReviewTarget
  mode: 'diff' | 'plain'
}

const LINE_HEIGHT = 19
/** Taller segments scroll inside their editor. */
const MAX_HEIGHT = 40 * LINE_HEIGHT
/** Lines added per "Show more" click. */
const EXPAND_STEP = 20

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

  const [extra, setExtra] = useState({ above: 0, below: 0 })
  const [height, setHeight] = useState(8 * LINE_HEIGHT)

  const loaded = typeof text === 'object' && text !== null ? text : null
  const win = loaded
    ? segmentWindow(
        seg,
        file,
        view,
        { head: countLines(loaded.modified), base: countLines(loaded.original) },
        extra
      )
    : null
  // In plain mode for a deleted file the base text is in `modified` (see the loader above).
  const plainRange: LineRange | undefined = win ? (win.head ?? win.base) : undefined
  const headRange = win?.head ?? { start: 1, end: 0 }
  const baseRange = win?.base ?? { start: 1, end: 0 }
  // The editor that holds the segment's own lines, and where its slice starts.
  const ownStart =
    view.editor === 'diff' && status === 'deleted' ? baseRange.start : (plainRange?.start ?? 1)

  // Mark the segment's own lines (shifted into the slice).
  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !loaded) return
    const coll = ed.createDecorationsCollection([
      {
        range: {
          startLineNumber: seg.startLine - ownStart + 1,
          startColumn: 1,
          endLineNumber: seg.endLine - ownStart + 1,
          endColumn: 1
        },
        options: {
          isWholeLine: true,
          className: 'segment-range-line',
          linesDecorationsClassName: 'segment-range-gutter'
        }
      }
    ])
    return () => coll.clear()
  }, [loaded, ready, seg.startLine, seg.endLine, ownStart])

  // Size the editor to its content (capped), so a short slice isn't padded with empty space.
  const fitHeight = (ed: Monaco.editor.ICodeEditor): void => {
    const update = (): void => setHeight(Math.min(ed.getContentHeight(), MAX_HEIGHT) + 2)
    update()
    ed.onDidContentSizeChange(update)
  }

  /** Line numbers that match the real file, not the slice. */
  const numbersFrom = (start: number) => (n: number) => String(n + start - 1)

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
        original={sliceLines(text.original, baseRange)}
        modified={sliceLines(text.modified, headRange)}
        options={{
          ...OPTIONS,
          renderSideBySide: false,
          originalEditable: false,
          // Long unchanged runs inside the window fold into "N hidden lines" bars.
          hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 6 }
        }}
        onMount={(ed) => {
          const original = ed.getOriginalEditor()
          const modified = ed.getModifiedEditor()
          original.updateOptions({ lineNumbers: numbersFrom(baseRange.start) })
          modified.updateOptions({ lineNumbers: numbersFrom(headRange.start) })
          editorRef.current = status === 'deleted' ? original : modified
          fitHeight(modified)
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
        value={plainRange ? sliceLines(text.modified, plainRange) : text.modified}
        options={{ ...OPTIONS, lineNumbers: numbersFrom(plainRange?.start ?? 1) }}
        onMount={(ed) => {
          editorRef.current = ed
          fitHeight(ed)
          setReady((n) => n + 1)
        }}
      />
    )
  }

  const expand = (side: 'above' | 'below'): void =>
    setExtra((e) => ({ ...e, [side]: e[side] + EXPAND_STEP }))

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
      {win?.moreAbove && (
        <button type="button" className="segment-expand" onClick={() => expand('above')}>
          ↑ Show {EXPAND_STEP} more lines
        </button>
      )}
      {body}
      {win?.moreBelow && (
        <button type="button" className="segment-expand" onClick={() => expand('below')}>
          ↓ Show {EXPAND_STEP} more lines
        </button>
      )}
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
