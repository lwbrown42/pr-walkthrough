import { useLayoutEffect, useRef, useState } from 'react'
import type { CodeSegment } from '../../../shared/walkthrough'
import { segmentLabels } from './segmentView'

interface Props {
  segments: CodeSegment[]
  onJump: (index: number) => void
}

/** Room kept for the "+N more" menu, and the gap between items (matches .jump in CSS). */
const MENU_WIDTH = 96
const GAP = 10

/**
 * "Jump to" links for a step's segments, on one line: as many whole names as fit, the rest in a
 * "+N more" menu. Names are measured in a hidden row so they are never cut short.
 */
export default function FileBar({ segments, onJump }: Props): React.JSX.Element | null {
  const labels = segmentLabels(segments)
  const barRef = useRef<HTMLElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(labels.length)
  const labelsKey = labels.join('\n')

  useLayoutEffect(() => {
    const bar = barRef.current
    const measure = measureRef.current
    if (!bar || !measure) return
    const fit = (): void => {
      const [title, ...names] = [...measure.children].map((c) => (c as HTMLElement).offsetWidth)
      const widths = names.map((w) => w + GAP)
      const room = bar.clientWidth - title - GAP
      const total = widths.reduce((a, b) => a + b, 0)
      if (total <= room) return setShown(widths.length)
      let used = MENU_WIDTH
      let n = 0
      while (n < widths.length && used + widths[n] <= room) used += widths[n++]
      setShown(n)
    }
    // Layout effect: the first fit must land before paint, so names never flash in and out.
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [labelsKey])

  if (segments.length < 2) return null
  const hidden = segments.length - shown
  return (
    <nav className="jump" aria-label="Jump to segment" ref={barRef}>
      <div className="jump-measure" ref={measureRef} aria-hidden="true">
        <span>Jump to</span>
        {labels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
      <span className="muted">Jump to</span>
      {labels.slice(0, shown).map((label, i) => (
        <button
          key={i}
          type="button"
          className="link"
          title={segments[i].path}
          onClick={() => onJump(i)}
        >
          {label}
        </button>
      ))}
      {hidden > 0 && (
        <select
          className="jump-more"
          aria-label="More segments"
          value=""
          onChange={(e) => onJump(Number(e.target.value))}
        >
          <option value="" disabled>
            +{hidden} more
          </option>
          {segments.slice(shown).map((seg, k) => (
            <option key={k} value={shown + k}>
              {seg.path}
              {seg.kind === 'context' ? ' (context)' : ''}
            </option>
          ))}
        </select>
      )}
    </nav>
  )
}
