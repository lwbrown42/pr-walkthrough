import type { ChangedFile, Hunk } from '../../../shared/types'
import type { CodeSegment, Step } from '../../../shared/walkthrough'

export interface SegmentView {
  editor: 'diff' | 'plain' | 'binary'
  sha: 'head' | 'base' | 'both'
  label: string
}

/** Decides which editor, and which revision(s) of the file, a segment is shown with. */
export function describeSegment(
  seg: CodeSegment,
  file: ChangedFile | undefined,
  mode: 'diff' | 'plain'
): SegmentView {
  if (file?.binary) return { editor: 'binary', sha: 'head', label: 'Binary file — not shown' }
  if (seg.kind === 'context') return { editor: 'plain', sha: 'head', label: seg.path }
  // A whole-file add or delete diffs against nothing: all green or red, plus a stray empty line.
  if (mode === 'plain' || file?.status === 'added' || file?.status === 'deleted')
    return { editor: 'plain', sha: file?.status === 'deleted' ? 'base' : 'head', label: seg.path }
  return { editor: 'diff', sha: 'both', label: seg.path }
}

/** 1-based inclusive line range; empty when end < start. */
export interface LineRange {
  start: number
  end: number
}

export interface SegmentWindow {
  /** Lines of the head file to show (absent when the head side isn't shown). */
  head?: LineRange
  /** Lines of the base file to show (absent when the base side isn't shown). */
  base?: LineRange
  /** More file exists above / below the window on the segment's own side. */
  moreAbove: boolean
  moreBelow: boolean
}

/** Unchanged lines shown around a step's lines, like GitHub's diff view. */
export const CONTEXT_LINES = 3

/**
 * Maps a head line to the matching base line. Inside a changed hunk there is no exact match, so
 * the start of a range maps to the hunk's first base line and the end to its last.
 */
export function headToBase(line: number, hunks: Hunk[], edge: 'start' | 'end'): number {
  let offset = 0
  for (const h of [...hunks].sort((a, b) => a.newStart - b.newStart)) {
    if (h.newLines === 0) {
      // Pure deletion: sits after head line newStart.
      if (line <= h.newStart) break
    } else {
      if (line < h.newStart) break
      if (line <= h.newStart + h.newLines - 1) {
        // An insertion (oldLines 0) sits after base line oldStart.
        if (h.oldLines === 0) return edge === 'start' ? h.oldStart + 1 : h.oldStart
        return edge === 'start' ? h.oldStart : h.oldStart + h.oldLines - 1
      }
    }
    offset += h.newLines - h.oldLines
  }
  return line - offset
}

/**
 * Which lines of the file(s) to show for a segment: its own lines, widened to whole hunks it
 * touches, plus CONTEXT_LINES (and any lines the reviewer expanded) on each side.
 */
export function segmentWindow(
  seg: CodeSegment,
  file: ChangedFile | undefined,
  view: SegmentView,
  totals: { head: number; base: number },
  extra: { above: number; below: number } = { above: 0, below: 0 }
): SegmentWindow {
  const deleted = file?.status === 'deleted'
  const total = deleted ? totals.base : totals.head
  let start = seg.startLine
  let end = seg.endLine
  // Widen to the hunks it touches (not for added/deleted files: there the whole file is one hunk).
  if (seg.kind === 'change' && file && file.status !== 'added' && !deleted) {
    for (const h of file.hunks) {
      const hEnd = h.newStart + Math.max(h.newLines, 1) - 1
      if (h.newLines > 0 && h.newStart <= end && hEnd >= start) {
        start = Math.min(start, h.newStart)
        end = Math.max(end, hEnd)
      }
    }
  }
  start = Math.max(1, start - CONTEXT_LINES - extra.above)
  end = Math.min(total, end + CONTEXT_LINES + extra.below)
  const own: LineRange = { start, end }
  const window: SegmentWindow = { moreAbove: start > 1, moreBelow: end < total }

  if (view.editor !== 'diff') {
    if (view.sha === 'base') window.base = own
    else window.head = own
    return window
  }
  window.head = own
  const hunks = file?.hunks ?? []
  window.base = {
    start: Math.max(1, headToBase(start, hunks, 'start')),
    end: Math.min(totals.base, headToBase(end, hunks, 'end'))
  }
  return window
}

/** The lines of `text` in `range` (1-based, inclusive). */
export function sliceLines(text: string, range: LineRange): string {
  if (range.end < range.start) return ''
  return text
    .split('\n')
    .slice(range.start - 1, range.end)
    .join('\n')
}

/** e.g. "3 files: 2 modified, 1 renamed", from the files the step's segments touch. */
export function summarizeFiles(step: Step, files: ChangedFile[]): string {
  const paths = [...new Set(step.segments.map((s) => s.path))]
  const counts = new Map<string, number>()
  for (const p of paths) {
    const status = files.find((f) => f.path === p)?.status ?? 'modified'
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const parts = [...counts].map(([status, n]) => `${n} ${status}`).join(', ')
  return `${paths.length} ${paths.length === 1 ? 'file' : 'files'}: ${parts}`
}

/**
 * Short names for the file bar: the file name, plus its folder when two files share a name, plus
 * the start line when one file has several segments. Context segments say so.
 */
export function segmentLabels(segments: CodeSegment[]): string[] {
  const base = (p: string): string => p.split('/').pop() ?? p
  const paths = [...new Set(segments.map((s) => s.path))]
  return segments.map((seg) => {
    const parts = seg.path.split('/')
    const clash = paths.some((p) => p !== seg.path && base(p) === base(seg.path))
    let label = clash ? parts.slice(-2).join('/') : base(seg.path)
    const sameFile = segments.filter((s) => s.path === seg.path && s.kind === seg.kind)
    if (sameFile.length > 1) label += `:${seg.startLine}`
    return seg.kind === 'context' ? `${label} (context)` : label
  })
}
