import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import { friendlyError } from '../errors'

interface Props {
  stepId: string
  steps: { id: string; title: string }[]
  messages: ChatMessage[]
  onAppend: (message: ChatMessage) => void
}

interface Failed {
  stepId: string
  question: string
  message: string
}

function Bubble({ message }: { message: ChatMessage }): React.JSX.Element {
  return (
    <div className={`chat-message chat-${message.role}`} data-role={message.role}>
      {message.text}
    </div>
  )
}

export default function ChatPanel({ stepId, steps, messages, onAppend }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [inFlight, setInFlight] = useState<{ stepId: string } | null>(null)
  const [streamed, setStreamed] = useState('')
  const [failed, setFailed] = useState<Failed | null>(null)
  const [showEarlier, setShowEarlier] = useState(false)
  const unsubRef = useRef<(() => void) | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const stopListening = (): void => {
    unsubRef.current?.()
    unsubRef.current = null
  }
  useEffect(() => stopListening, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streamed, failed, stepId])

  const current = messages.filter((m) => m.stepId === stepId)
  const earlier = messages.filter((m) => m.stepId !== stepId && m.role === 'user')
  const titleOf = (id: string): string => steps.find((s) => s.id === id)?.title ?? id
  const earlierGroups = steps
    .filter((s) => s.id !== stepId)
    .map((s) => ({ step: s, questions: earlier.filter((m) => m.stepId === s.id) }))
    .filter((g) => g.questions.length > 0)

  async function run(askStep: string, question: string): Promise<void> {
    setFailed(null)
    setStreamed('')
    setInFlight({ stepId: askStep })
    stopListening()
    unsubRef.current = window.api.onChatText((chunk) => setStreamed((s) => s + chunk))
    try {
      const res = await window.api.ask({ stepId: askStep, question })
      if ('error' in res)
        setFailed({ stepId: askStep, question, message: friendlyError(res.error) })
      else onAppend(res)
    } catch (e) {
      setFailed({
        stepId: askStep,
        question,
        message: friendlyError({ message: e instanceof Error ? e.message : String(e) })
      })
    } finally {
      stopListening()
      setStreamed('')
      setInFlight(null)
    }
  }

  function send(): void {
    const question = draft.trim()
    if (!question || inFlight) return
    setDraft('')
    onAppend({ id: `u-${Date.now()}-${messages.length}`, stepId, role: 'user', text: question })
    void run(stepId, question)
  }

  const streamingHere = inFlight?.stepId === stepId
  const failedHere = failed && failed.stepId === stepId ? failed : null

  return (
    <div className="chat-panel">
      {earlier.length > 0 && (
        <div className="chat-earlier">
          <button
            type="button"
            onClick={() => setShowEarlier((v) => !v)}
            aria-expanded={showEarlier}
          >
            Show earlier questions ({earlier.length})
          </button>
          {showEarlier &&
            earlierGroups.map((g) => (
              <div key={g.step.id} className="chat-earlier-group">
                <h4>{titleOf(g.step.id)}</h4>
                {g.questions.map((q) => (
                  <Bubble key={q.id} message={q} />
                ))}
              </div>
            ))}
        </div>
      )}
      <div className="chat-list" ref={listRef}>
        {current.map((m) => (
          <Bubble key={m.id} message={m} />
        ))}
        {streamingHere && (
          <div className="chat-message chat-assistant" data-role="assistant">
            {streamed || '…'}
          </div>
        )}
        {failedHere && (
          <div className="chat-error" role="alert">
            <span>{failedHere.message}</span>{' '}
            <button type="button" onClick={() => void run(failedHere.stepId, failedHere.question)}>
              Retry
            </button>
          </div>
        )}
      </div>
      <textarea
        className="chat-input"
        rows={2}
        placeholder="Ask about this step…"
        value={draft}
        disabled={inFlight !== null}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
    </div>
  )
}
