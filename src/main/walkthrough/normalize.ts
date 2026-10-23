import type { ChangedFile } from '../../shared/types'
import type { AgentWalkthrough, CodeSegment, Step } from '../../shared/walkthrough'

export interface LineCounts {
  head: Record<string, number>
  base: Record<string, number>
}

const EVERYTHING_ELSE_TITLE = 'Everything else'
const EVERYTHING_ELSE_ID = 'everything-else'

function sanitizeSegment(
  seg: CodeSegment,
  fileByPath: Map<string, ChangedFile>,
  counts: LineCounts
): CodeSegment | null {
  const file = fileByPath.get(seg.path)
  const useBase = file?.status === 'deleted' || (file?.oldPath === seg.path && file.path !== seg.path)
  const total = (useBase ? counts.base : counts.head)[seg.path]
  if (total === undefined || total < 1) return null
  const clamp = (n: number): number => Math.min(Math.max(n, 1), total)
  const a = clamp(seg.startLine)
  const b = clamp(seg.endLine)
  return { ...seg, startLine: Math.min(a, b), endLine: Math.max(a, b) }
}

export function normalizeWalkthrough(
  raw: AgentWalkthrough,
  files: ChangedFile[],
  lineCounts: LineCounts
): AgentWalkthrough {
  const fileByPath = new Map<string, ChangedFile>()
  for (const f of files) {
    fileByPath.set(f.path, f)
    if (f.oldPath) fileByPath.set(f.oldPath, f)
  }
  // path -> file, but prefer exact new-path entries over oldPath aliases
  for (const f of files) fileByPath.set(f.path, f)

  // 1. Sanitize segments, drop empty steps.
  let steps: Step[] = []
  for (const step of raw.steps) {
    const segments = step.segments
      .map((s) => sanitizeSegment(s, fileByPath, lineCounts))
      .filter((s): s is CodeSegment => s !== null)
    if (segments.length === 0 && step.explanation.trim() === '') continue
    steps.push({ ...step, segments })
  }

  // 2. Make step ids unique (the agent may repeat one): later repeats get -2, -3, ...
  const used = new Set<string>()
  steps = steps.map((step) => {
    let id = step.id
    for (let n = 2; used.has(id); n++) id = `${step.id}-${n}`
    used.add(id)
    return id === step.id ? step : { ...step, id }
  })

  // 3. Drop parentIds that don't reference an earlier step.
  const seen = new Set<string>()
  steps = steps.map((step) => {
    const { parentId, ...rest } = step
    const out: Step = parentId !== undefined && seen.has(parentId) ? { ...rest, parentId } : rest
    seen.add(step.id)
    return out
  })

  // 4. Coverage fill.
  const allSegments = steps.flatMap((s) => s.segments)
  const missing: CodeSegment[] = []
  for (const file of files) {
    const deleted = file.status === 'deleted'
    const named = allSegments.some((s) => s.path === file.path || (file.oldPath !== undefined && s.path === file.oldPath))
    if (file.binary || file.hunks.length === 0) {
      if (!named) {
        const total = (deleted ? lineCounts.base : lineCounts.head)[file.path] ?? 1
        missing.push({ kind: 'change', path: file.path, startLine: 1, endLine: Math.max(total, 1) })
      }
      continue
    }
    for (const h of file.hunks) {
      const start = deleted ? h.oldStart : h.newStart
      const end = start + Math.max(deleted ? h.oldLines : h.newLines, 1) - 1
      const covered = allSegments.some(
        (s) => s.kind === 'change' && s.path === file.path && s.startLine <= end && s.endLine >= start
      )
      if (!covered) missing.push({ kind: 'change', path: file.path, startLine: start, endLine: end })
    }
  }

  // 5. Merge into a single trailing Everything else step.
  const existing = steps.filter((s) => s.title === EVERYTHING_ELSE_TITLE)
  const others = steps.filter((s) => s.title !== EVERYTHING_ELSE_TITLE)
  if (existing.length === 0 && missing.length === 0) return { ...raw, steps: others }
  const base: Step = existing[0] ?? {
    id: EVERYTHING_ELSE_ID,
    title: EVERYTHING_ELSE_TITLE,
    whyNext: 'Smaller changes not covered above.',
    explanation: '',
    segments: []
  }
  const merged: Step = {
    ...base,
    segments: [...existing.flatMap((s) => s.segments), ...missing]
  }
  // A leftover step that is empty carries nothing worth showing.
  if (merged.segments.length === 0 && merged.explanation.trim() === '') return { ...raw, steps: others }
  return { ...raw, steps: [...others, merged] }
}
