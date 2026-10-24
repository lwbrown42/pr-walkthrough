import type { ChangedFile, Hunk } from '../../../shared/types'
import type { CodeSegment } from '../../../shared/walkthrough'

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
  if (seg.kind === 'context')
    return { editor: 'plain', sha: 'head', label: `${seg.path} · unchanged · context` }
  if (mode === 'plain')
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
  if (deleted) {
    window.head = { start: 1, end: 0 }
    window.base = own
  } else if (file?.status === 'added') {
    window.head = own
    window.base = { start: 1, end: 0 }
  } else {
    window.head = own
    const hunks = file?.hunks ?? []
    window.base = {
      start: Math.max(1, headToBase(start, hunks, 'start')),
      end: Math.min(totals.base, headToBase(end, hunks, 'end'))
    }
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
