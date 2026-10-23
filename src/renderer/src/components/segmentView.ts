import type { ChangedFile } from '../../../shared/types'
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
