import { useEffect, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import type { Walkthrough as WalkthroughData } from '../../../shared/walkthrough'
import ChatPanel from '../components/ChatPanel'
import CodePane from '../components/CodePane'
import ExplanationPanel from '../components/ExplanationPanel'
import StepsList from '../components/StepsList'

interface Props {
  walkthrough: WalkthroughData
  onExit: () => void
}

function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable
}

export default function Walkthrough({ walkthrough, onExit }: Props): React.JSX.Element {
  const { steps, target, files } = walkthrough
  const [index, setIndex] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [mode, setMode] = useState<'diff' | 'plain'>('diff')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTextTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(i + 1, steps.length - 1))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(i - 1, 0))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [steps.length])

  const step = steps[index]
  if (!step) return <div className="screen">No steps.</div>

  return (
    <div className="walkthrough">
      <header className="topbar">
        <h1>{target.title}</h1>
        <div className="topbar-actions">
          <div className="toggle" role="group" aria-label="Code view">
            {(['diff', 'plain'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                className={mode === m ? 'active' : undefined}
                onClick={() => setMode(m)}
              >
                {m === 'diff' ? 'Diff' : 'Plain'}
              </button>
            ))}
          </div>
          <button type="button" onClick={onExit}>
            New review
          </button>
        </div>
      </header>
      <div className="columns">
        <StepsList steps={steps} currentIndex={index} onSelect={setIndex} />
        <main className="code-column">
          <CodePane step={step} files={files} target={target} mode={mode} />
        </main>
        <aside className="right-column">
          <ExplanationPanel step={step} index={index} total={steps.length} />
          <ChatPanel
            stepId={step.id}
            steps={steps}
            messages={messages}
            onAppend={(m) => setMessages((prev) => [...prev, m])}
          />
        </aside>
      </div>
    </div>
  )
}
